import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERRUPTED_TOOL_RESULT,
  healChatMessages,
  joinSplitAssistantCalls,
  pairToolMessages,
  withoutSilentAssistants,
} from '../lib/tool-pairing.js';
import { healResponsesInput, joinToolRuns, orphanedToolOutputs, pairToolItems } from '../lib/responses-pairing.js';

test('pairToolMessages synthesizes interrupted results for unanswered calls', () => {
  const healed = pairToolMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'user', content: 'next' },
  ]);
  assert.equal(healed[2].role, 'tool');
  assert.equal(healed[2].tool_call_id, 'c1');
  assert.equal(healed[2].content, INTERRUPTED_TOOL_RESULT);
  assert.equal(healed[3].content, 'next');
});

test('pairToolMessages converts orphan tool results to user text', () => {
  const healed = pairToolMessages([
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'orphan', content: 'late result' },
  ]);
  // Magpie merges orphan tool text into the preceding user with \n\n.
  assert.equal(healed.length, 1);
  assert.equal(healed[0].role, 'user');
  assert.equal(healed[0].content, 'hi\n\nlate result');
});

test('pairToolMessages reorders parallel tool results and drops duplicates', () => {
  const healed = pairToolMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: 'second' },
    { role: 'tool', tool_call_id: 'a', content: 'first' },
    { role: 'tool', tool_call_id: 'a', content: 'dup' },
    { role: 'user', content: 'done' },
  ]);
  assert.deepEqual(healed.slice(1, 3).map((m) => [m.tool_call_id, m.content]), [
    ['a', 'first'],
    ['b', 'second'],
  ]);
  assert.equal(healed.at(-1).content, 'done');
});

test('pairToolMessages is idempotent on a clean exchange', () => {
  const clean = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'user', content: 'thanks' },
  ];
  const once = pairToolMessages(clean);
  const twice = pairToolMessages(once);
  assert.deepEqual(once, clean);
  assert.deepEqual(twice, once);
});

test('joinSplitAssistantCalls merges consecutive assistant tool turns', () => {
  const merged = joinSplitAssistantCalls([
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tool_calls.length, 2);
});

test('withoutSilentAssistants drops empty assistants and merges adjacent users', () => {
  const out = withoutSilentAssistants([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'b' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'a\n\nb' }]);
});

test('healChatMessages pipeline answers interrupted calls after join', () => {
  const healed = healChatMessages([
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } }] },
  ]);
  assert.equal(healed[0].tool_calls.length, 2);
  assert.equal(healed[1].content, INTERRUPTED_TOOL_RESULT);
  assert.equal(healed[2].content, INTERRUPTED_TOOL_RESULT);
});

test('healChatMessages mints missing ids before synthesizing interrupted results', () => {
  const healed = healChatMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'user', content: 'continue' },
  ]);
  assert.match(healed[0].tool_calls[0].id, /^call_/);
  assert.equal(healed[1].role, 'tool');
  assert.equal(healed[1].tool_call_id, healed[0].tool_calls[0].id);
  assert.equal(healed[1].content, INTERRUPTED_TOOL_RESULT);
  assert.equal(healed[2].content, 'continue');
});

test('pairToolItems synthesizes interrupted outputs for lone calls', () => {
  const input = [
    { type: 'message', role: 'user', content: 'go' },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
  ];
  const healed = pairToolItems(input);
  assert.equal(healed.length, 3);
  assert.equal(healed[2].type, 'function_call_output');
  assert.equal(healed[2].output, INTERRUPTED_TOOL_RESULT);
  assert.deepEqual(pairToolItems(healed), healed);
});

test('orphanedToolOutputs turns empty-call_id outputs into user messages', () => {
  const input = [
    { type: 'function_call_output', call_id: '', output: 'notice' },
  ];
  const healed = orphanedToolOutputs(input);
  assert.equal(healed[0].type, 'message');
  assert.equal(healed[0].role, 'user');
  assert.equal(healed[0].content[0].text, 'notice');
});

test('joinToolRuns moves intervening notes after result batch', () => {
  const input = [
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'note' }] },
  ];
  // note after completed run stays; intervening between results moves
  const withNote = [
    { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'g', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: '1' },
    { type: 'message', role: 'system', content: 'hold me' },
    { type: 'function_call_output', call_id: 'b', output: '2' },
  ];
  const joined = joinToolRuns(withNote);
  assert.equal(joined[3].type, 'function_call_output');
  assert.equal(joined[3].call_id, 'b');
  assert.equal(joined[4].content, 'hold me');
  assert.deepEqual(joinToolRuns(input), input);
});

test('healResponsesInput is idempotent for a clean Codex-shaped exchange', () => {
  const clean = [
    { type: 'message', role: 'user', content: 'fix' },
    { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  ];
  const once = healResponsesInput(clean);
  assert.deepEqual(once, clean);
  assert.deepEqual(healResponsesInput(once), once);
});
