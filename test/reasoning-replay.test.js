import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoningReplay } from '../lib/reasoning-replay.js';
import { responsesToChat } from '../lib/responses-adapter.js';
import { anthropicToChat } from '../lib/anthropic-adapter.js';

test('DeepSeek tool assistants get space reasoning_content placeholder', () => {
  const messages = applyReasoningReplay([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
  ], 'cline-pass/deepseek-v3');
  assert.equal(messages[0].reasoning_content, ' ');
});

test('DeepSeek does not overwrite existing reasoning or seals', () => {
  const messages = applyReasoningReplay([
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'already',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
  ], 'deepseek-chat');
  assert.equal(messages[0].reasoning_content, 'already');
});

test('GLM folds reasoning_details but never inserts space placeholder', () => {
  const messages = applyReasoningReplay([
    {
      role: 'assistant',
      content: null,
      reasoning_details: [{ type: 'reasoning.text', text: 'plain' }],
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
  ], 'cline-pass/glm-5.2');
  assert.equal(messages[0].reasoning_content, 'plain');
  assert.equal(messages[0].reasoning_details, undefined);
  assert.notEqual(messages[0].reasoning_content, ' ');
});

test('Kimi folds reasoning_details into reasoning_content', () => {
  const messages = applyReasoningReplay([
    {
      role: 'assistant',
      content: 'hi',
      reasoning_details: [{ type: 'reasoning.text', text: 'k' }, { type: 'reasoning.text', text: 'imi' }],
    },
  ], 'kimi-k2.5');
  assert.equal(messages[0].reasoning_content, 'kimi');
  assert.equal(messages[0].reasoning_details, undefined);
});

test('MiMo folds reasoning_details like Kimi and never space-pads', () => {
  const messages = applyReasoningReplay([
    {
      role: 'assistant',
      content: null,
      reasoning_details: [{ type: 'reasoning.text', text: 'mimo-plan' }],
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
  ], 'cline-pass/mimo-v2');
  assert.equal(messages[0].reasoning_content, 'mimo-plan');
  assert.equal(messages[0].reasoning_details, undefined);
  assert.notEqual(messages[0].reasoning_content, ' ');
});

test('MiniMax splits think tags into reasoning_content', () => {
  const messages = applyReasoningReplay([
    { role: 'assistant', content: '<think>plan</think>answer' },
  ], 'minimax-m1');
  assert.equal(messages[0].reasoning_content, 'plan');
  assert.equal(messages[0].content, 'answer');
});

test('responsesToChat applies DeepSeek placeholder on healed tool history', () => {
  const { chatBody } = responsesToChat({
    model: 'deepseek-reasoner',
    input: [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  const assistant = chatBody.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, ' ');
});

test('anthropicToChat does not space-pad GLM tool assistants', () => {
  const { chatBody } = anthropicToChat({
    model: 'cline-pass/glm-5.2',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ],
  });
  const assistant = chatBody.messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.reasoning_content, undefined);
});
