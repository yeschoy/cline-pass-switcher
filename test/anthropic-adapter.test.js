import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, encodeReasoning } from '../lib/protocol-common.js';
import { anthropicErrorBody, anthropicToChat, chatToAnthropic, createAnthropicStreamEncoder } from '../lib/anthropic-adapter.js';
import { anthropicOutId } from '../lib/protocol-ids.js';

function parseSse(text) {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    const type = (chunk.match(/^event: (.+)$/m) || [])[1];
    const dataLine = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!type) continue;
    events.push({ type, data: JSON.parse(dataLine) });
  }
  return events;
}

test('anthropicToChat maps system blocks, images, tool_result order and identity hints', () => {
  const { chatBody, identityHints } = anthropicToChat({
    model: 'cline-pass/kimi-k2.5',
    system: [
      { type: 'text', text: 'sys-a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'sys-b' },
    ],
    metadata: { user_id: 'user-session-1' },
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text', is_error: true },
        { type: 'text', text: 'what next' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      ],
    }],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    max_tokens: 128,
    stop_sequences: ['END'],
    thinking: { type: 'enabled', budget_tokens: 8000 },
    stream: true,
  });
  assert.deepEqual(chatBody.messages[0], { role: 'system', content: 'sys-a\nsys-b' });
  // Orphan tool_result (no prior tool_use) heals to a user message.
  assert.equal(chatBody.messages[1].role, 'user');
  assert.equal(chatBody.messages[1].content, '[tool error] file text');
  assert.equal(chatBody.messages[2].role, 'user');
  assert.equal(chatBody.messages[2].content[0].type, 'text');
  assert.match(chatBody.messages[2].content[1].image_url.url, /^data:image\/png;base64,abc$/);
  assert.equal(chatBody.tools[0].function.name, 'read');
  assert.equal(chatBody.parallel_tool_calls, false);
  assert.equal(chatBody.reasoning_effort, 'medium');
  assert.equal(chatBody.stop[0], 'END');
  assert.equal(identityHints.metadata.user_id, 'user-session-1');
  assert.equal(chatBody.metadata, undefined);
});

test('anthropicToChat restores current-loop thinking and drops earlier or foreign signatures', () => {
  const live = encodeReasoning({ text: 'current plan', field: 'reasoning_content' });
  const stale = encodeReasoning({ text: 'old plan', field: 'reasoning' });
  const { chatBody } = anthropicToChat({
    model: 'm',
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'old', signature: stale }, { type: 'text', text: 'first' }, { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'now', signature: live }, { type: 'redacted_thinking', data: 'xx' }, { type: 'text', text: 'next' }] },
      { role: 'user', content: 'go on' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'final', signature: live }, { type: 'tool_use', id: 't2', name: 'lookup', input: {} }] },
    ],
  });
  const firstAssistant = chatBody.messages.find((m) => m.role === 'assistant' && m.content === 'first');
  assert.equal(firstAssistant.reasoning_content, undefined);
  assert.equal(firstAssistant.tool_calls[0].id, 't1');
  const mid = chatBody.messages.find((m) => m.content === 'next');
  assert.equal(mid.reasoning_content, undefined);
  const loop = chatBody.messages.filter((m) => m.role === 'assistant').at(-1);
  assert.equal(loop.reasoning_content, 'current plan');
  assert.equal(loop.tool_calls[0].id, 't2');
});

test('anthropicToChat rejects server tools, documents and mcp_servers', () => {
  const cases = [
    { model: 'm', messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'x' } }] }] },
    { model: 'm', messages: [], mcp_servers: [{ url: 'https://example' }] },
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'search_result', title: 'x' }] }] },
  ];
  for (const body of cases) {
    assert.throws(() => anthropicToChat(body), (err) => err instanceof AdapterError && err.status === 400);
  }
});

test('chatToAnthropic maps stop reasons, thinking, tools and missing usage to zero', () => {
  const ctx = anthropicToChat({ model: 'shown', messages: [{ role: 'user', content: 'hi' }] }).ctx;
  const msg = chatToAnthropic({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'see tool',
        reasoning_content: 'think',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":2}' } }],
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
  }, ctx);
  assert.equal(msg.type, 'message');
  assert.equal(msg.model, 'shown');
  assert.equal(msg.content[0].type, 'thinking');
  assert.equal(msg.content[1].type, 'text');
  assert.equal(msg.content[2].type, 'tool_use');
  assert.equal(msg.content[2].input.q, 2);
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.usage.input_tokens, 8);
  assert.equal(msg.usage.cache_read_input_tokens, 4);
  assert.equal(chatToAnthropic({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }, ctx).stop_reason, 'max_tokens');
  assert.equal(chatToAnthropic({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }, ctx).usage.input_tokens, 0);
});

test('Anthropic stream encoder emits block indexes, signature and usage', () => {
  const ctx = anthropicToChat({ model: 'shown', messages: [{ role: 'user', content: 'hi' }] }).ctx;
  const encoder = createAnthropicStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { reasoning_content: 'why' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { content: 'Hi' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'lookup', arguments: '{"a":' } }] } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 2 } } });
  out += encoder.finish();
  const events = parseSse(out);
  assert.equal(events[0].type, 'message_start');
  assert.equal(events[0].data.message.usage.input_tokens, 0);
  const starts = events.filter((event) => event.type === 'content_block_start');
  assert.equal(starts[0].data.content_block.type, 'thinking');
  assert.equal(starts[0].data.index, 0);
  assert.equal(starts[1].data.content_block.type, 'text');
  assert.equal(starts[1].data.index, 1);
  assert.equal(starts[2].data.content_block.type, 'tool_use');
  assert.equal(starts[2].data.index, 2);
  assert.ok(events.some((event) => event.data.delta?.type === 'signature_delta'));
  const delta = events.find((event) => event.type === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'tool_use');
  assert.equal(delta.data.usage.output_tokens, 2);
  assert.equal(events.at(-1).type, 'message_stop');
});

test('Anthropic stream never has two open blocks with interleaved tools and late reasoning', () => {
  const ctx = anthropicToChat({ model: 'shown', messages: [{ role: 'user', content: 'hi' }] }).ctx;
  const encoder = createAnthropicStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { content: 'Hi' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { reasoning_content: 'late' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { arguments: '{"a":' } }, { index: 1, id: 't2', function: { name: 'two', arguments: '{"b":' } }] } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'one', arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] } });
  out += encoder.finish();
  const events = parseSse(out);
  let open = null;
  for (const event of events) {
    if (event.type === 'content_block_start') { assert.equal(open, null, 'block opened while another is open'); open = event.data.index; }
    if (event.type === 'content_block_delta') assert.equal(event.data.index, open);
    if (event.type === 'content_block_stop') { assert.equal(event.data.index, open); open = null; }
  }
  const tools = events.filter((event) => event.type === 'content_block_start' && event.data.content_block.type === 'tool_use').map((event) => event.data.content_block);
  assert.deepEqual(tools.map((tool) => tool.name), ['one', 'two']);
  const args = events.filter((event) => event.data.delta?.type === 'input_json_delta').map((event) => event.data.delta.partial_json);
  assert.deepEqual(args, ['{"a":1}', '{"b":2}']);
});

test('Anthropic error types follow HTTP status', () => {
  assert.equal(anthropicErrorBody(401, { message: 'no' }).error.type, 'authentication_error');
  assert.equal(anthropicErrorBody(429).error.type, 'rate_limit_error');
  assert.equal(anthropicErrorBody(503).error.type, 'overloaded_error');
  assert.equal(anthropicErrorBody(500).error.type, 'api_error');
  const encoder = createAnthropicStreamEncoder({ model: 'm', messageId: 'msg_x' });
  const failed = parseSse(encoder.start() + encoder.fail('nope'));
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).data.error.message, 'nope');
});

test('Anthropic fail closes open blocks and does not emit message_stop', () => {
  const ctx = anthropicToChat({ model: 'shown', messages: [{ role: 'user', content: 'hi' }] }).ctx;
  const encoder = createAnthropicStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { content: 'partial' } }] } });
  out += encoder.fail('boom');
  const events = parseSse(out);
  assert.ok(events.some((event) => event.type === 'content_block_stop'));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.some((event) => event.type === 'message_stop'), false);
});

test('signed empty thinking includes thinking:"" key', () => {
  const ctx = anthropicToChat({ model: 'shown', messages: [{ role: 'user', content: 'hi' }] }).ctx;
  const msg = chatToAnthropic({
    choices: [{ finish_reason: 'stop', message: { content: 'hi', reasoning_content: '' } }],
  }, ctx);
  assert.equal(msg.content[0].type, 'thinking');
  assert.equal(msg.content[0].thinking, '');
  assert.equal(typeof msg.content[0].signature, 'string');
  assert.equal(msg.content[1].type, 'text');
});

test('anthropicToChat defaults max_tokens to 4096', () => {
  const { chatBody } = anthropicToChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(chatBody.max_tokens, 4096);
  const explicit = anthropicToChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }).chatBody;
  assert.equal(explicit.max_tokens, 16);
});

test('Anthropic tool_use id charset encodes outbound and decodes inbound', () => {
  const dirty = 'call/with:weird!';
  const encoded = anthropicOutId(dirty);
  const { chatBody, ctx } = anthropicToChat({
    model: 'm',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: encoded, name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: encoded, content: 'ok' }] },
    ],
  });
  const callId = chatBody.messages.find((m) => m.role === 'assistant').tool_calls[0].id;
  assert.equal(callId, dirty);
  assert.equal(chatBody.messages.find((m) => m.role === 'tool').tool_call_id, dirty);
  const msg = chatToAnthropic({
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: dirty, type: 'function', function: { name: 'f', arguments: '{}' } }] },
    }],
  }, ctx);
  assert.match(msg.content[0].id, /^[A-Za-z0-9_-]+$/);
  assert.equal(msg.content[0].id, encoded);
});

test('Claude Code-shaped request fixture converts a two-turn tool loop', () => {
  const live = encodeReasoning({ text: 'use the tool', field: 'reasoning_content' });
  const { chatBody, identityHints } = anthropicToChat({
    model: 'cline-pass/glm-5.2',
    system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
    metadata: { user_id: '{"session_id":"sess-1"}' },
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'use the tool', signature: live },
          { type: 'text', text: 'I will list them.' },
          { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.ts\nb.ts' }, { type: 'text', text: 'now read a.ts' }] },
    ],
    tools: [{ name: 'Bash', description: 'run shell', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
    thinking: { type: 'enabled', budget_tokens: 2000 },
  });
  assert.equal(identityHints.metadata.user_id.includes('sess-1'), true);
  assert.equal(chatBody.reasoning_effort, 'low');
  assert.equal(chatBody.messages.some((m) => m.tool_call_id === 'toolu_ls'), true);
  assert.equal(chatBody.messages.at(-1).content, 'now read a.ts');
});
