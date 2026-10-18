import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterError, createChatAggregator, createChatSseReader, decodeReasoning, encodeReasoning,
  estimateTokens, extractReasoning, newId, normalizeChatImageParts, unwrapChatPayload,
} from '../lib/protocol-common.js';

function feed(reader, chunks) {
  const events = [];
  for (const chunk of chunks) events.push(...reader.push(chunk));
  events.push(...reader.flush());
  return events;
}

test('Chat SSE reader assembles events across chunks and UTF-8 boundaries', () => {
  const reader = createChatSseReader();
  const json = JSON.stringify({ choices: [{ delta: { content: '你好世界' } }] });
  const event = `data: ${json}\n\n`;
  const bytes = Buffer.from(event, 'utf8');
  const split = bytes.indexOf(Buffer.from('你好', 'utf8')) + 1;
  const events = feed(reader, [bytes.subarray(0, split), bytes.subarray(split)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'delta');
  assert.equal(events[0].payload.choices[0].delta.content, '你好世界');
});

test('Chat SSE reader unwraps {data:...} envelopes and recognizes [DONE]', () => {
  const reader = createChatSseReader();
  const events = feed(reader, [
    'data: {"data":{"choices":[{"delta":{"content":"Hi"}}]}}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.equal(events[0].kind, 'delta');
  assert.equal(events[0].payload.choices[0].delta.content, 'Hi');
  assert.equal(events[1].kind, 'done');
  assert.equal(reader.sawDone, true);
});

test('Chat SSE reader yields corrupt events for malformed JSON', () => {
  const reader = createChatSseReader();
  const events = feed(reader, [
    'data: {not-json\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  ]);
  assert.equal(events[0].kind, 'corrupt');
  assert.equal(reader.corruptCount, 1);
  assert.equal(events[1].kind, 'delta');
  assert.equal(events[1].payload.choices[0].delta.content, 'ok');
});

test('Chat aggregator continues tool fragments that share the same id across indexes', () => {
  const agg = createChatAggregator();
  agg.applyDelta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'fn', arguments: '{"a":' } }] } }] });
  agg.applyDelta({ choices: [{ delta: { tool_calls: [{ index: 3, id: 'call_x', function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] });
  const snap = agg.snapshot();
  assert.equal(snap.tool_calls.length, 1);
  assert.equal(snap.tool_calls[0].id, 'call_x');
  assert.equal(snap.tool_calls[0].function.arguments, '{"a":1}');
});

test('normalizeToolArguments maps empty string to {}', async () => {
  const { normalizeToolArguments } = await import('../lib/protocol-common.js');
  assert.equal(normalizeToolArguments(''), '{}');
  assert.equal(normalizeToolArguments(null), '{}');
  assert.equal(normalizeToolArguments('{"a":1}'), '{"a":1}');
});

test('Chat aggregator interleaves tool-call indexes and usage', () => {
  const agg = createChatAggregator();
  agg.applyDelta({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'beta', arguments: '{"x":' } }] } }] });
  agg.applyDelta({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'alpha', arguments: '{' } }] } }] });
  agg.applyDelta({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '1}' } }, { index: 0, function: { arguments: '}' } }] } }] });
  agg.applyDelta({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
  const snap = agg.snapshot();
  assert.equal(snap.finish_reason, 'tool_calls');
  assert.deepEqual(snap.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]), [
    ['call_a', 'alpha', '{}'],
    ['call_b', 'beta', '{"x":1}'],
  ]);
  assert.equal(snap.usage.prompt_tokens, 9);
});

test('reasoning tokens round-trip and invalid tokens are dropped', () => {
  const token = encodeReasoning({ text: 'think about it', field: 'reasoning_content' });
  assert.match(token, /^clps1\./);
  assert.deepEqual(decodeReasoning(token), { text: 'think about it', field: 'reasoning_content' });
  assert.equal(decodeReasoning('not-a-token'), null);
  assert.equal(decodeReasoning('clps1.@@@'), null);
  assert.equal(decodeReasoning('clps1.' + Buffer.from('{"t":1,"f":"reasoning_content"}').toString('base64url')), null);
  const other = encodeReasoning({ text: 'alt', field: 'reasoning' });
  assert.equal(decodeReasoning(other).field, 'reasoning');
});

test('extractReasoning prefers reasoning_content then details', () => {
  assert.deepEqual(extractReasoning({ reasoning_content: 'a', reasoning: 'b' }), { text: 'a', field: 'reasoning_content' });
  assert.deepEqual(extractReasoning({ reasoning_details: [{ type: 'reasoning.text', text: 'x' }, { type: 'reasoning.text', text: 'y' }] }), { text: 'xy', field: 'reasoning_content' });
  assert.deepEqual(extractReasoning({}), { text: '', field: null });
});

test('estimateTokens counts ASCII, CJK, images and tools with a minimum of 1', () => {
  assert.equal(estimateTokens({ messages: [] }), 1);
  const ascii = estimateTokens({ messages: [{ role: 'user', content: 'abcd' }] });
  assert.equal(ascii, 4 + 1);
  const cjk = estimateTokens({ messages: [{ role: 'user', content: '中' }] });
  assert.ok(cjk >= 5);
  const image = estimateTokens({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x' } }] }] });
  assert.ok(image >= 1004);
});

test('normalizeChatImageParts wraps bare string image_url and is idempotent', () => {
  const input = {
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image_url', image_url: 'data:image/png;base64,abc', detail: 'low' },
          { type: 'image_url', image_url: { url: 'https://ex.test/a.png', detail: 'high' } },
        ],
      },
    ],
  };
  const out = normalizeChatImageParts(input);
  assert.notEqual(out, input);
  assert.deepEqual(out.messages[1].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,abc', detail: 'low' },
  });
  assert.deepEqual(out.messages[1].content[2], input.messages[1].content[2]);
  assert.equal(normalizeChatImageParts(out), out);
  assert.equal(normalizeChatImageParts({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).messages[0].content, 'x');
});

test('unwrapChatPayload and AdapterError helpers', () => {
  assert.deepEqual(unwrapChatPayload({ data: { choices: [1], usage: {} } }), { choices: [1], usage: {} });
  assert.equal(unwrapChatPayload({ choices: [] }).choices.length, 0);
  const err = new AdapterError('nope', { param: 'tools[0].type', code: 'unsupported' });
  assert.equal(err.status, 400);
  assert.equal(err.param, 'tools[0].type');
  assert.match(newId('resp_'), /^resp_[a-f0-9]{24}$/);
});
