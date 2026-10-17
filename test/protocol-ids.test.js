import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicInId, anthropicOutId, bindChatCallIds, boundCallId, callItemIds,
  mintMissingChatCallIds, placedCallId, plainItemIds,
} from '../lib/protocol-ids.js';

test('boundCallId keeps short safe ids and maps long ids stably', () => {
  const map = new Map();
  const short = 'call_abc123';
  assert.equal(boundCallId(short, map), short);
  const long = `call_${'x'.repeat(80)}`;
  const a = boundCallId(long, map);
  const b = boundCallId(long, map);
  assert.equal(a, b);
  assert.ok(a.length <= 64);
  assert.match(a, /^call_/);
});

test('anthropicOutId / anthropicInId round-trip unsafe charset', () => {
  const raw = 'call/with:weird chars!';
  const out = anthropicOutId(raw);
  assert.match(out, /^mp_/);
  assert.match(out, /^[A-Za-z0-9_-]+$/);
  assert.equal(anthropicInId(out), raw);
  assert.equal(anthropicOutId('toolu_safe'), 'toolu_safe');
  assert.equal(anthropicInId('toolu_safe'), 'toolu_safe');
});

test('placedCallId is deterministic across requests', () => {
  assert.equal(placedCallId(0, 1, 'f', '{}'), placedCallId(0, 1, 'f', '{}'));
  assert.notEqual(placedCallId(0, 1, 'f', '{}'), placedCallId(0, 2, 'f', '{}'));
});

test('mintMissingChatCallIds fills call and matching tool ids', () => {
  const messages = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', content: 'ok' },
  ];
  const minted = mintMissingChatCallIds(messages);
  assert.match(minted[0].tool_calls[0].id, /^call_/);
  assert.equal(minted[1].tool_call_id, minted[0].tool_calls[0].id);
  assert.deepEqual(mintMissingChatCallIds(minted), minted);
});

test('bindChatCallIds applies boundCallId to call and tool rows', () => {
  const long = `call_${'y'.repeat(80)}`;
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{ id: long, type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: long, content: 'ok' },
  ];
  const bound = bindChatCallIds(messages);
  assert.ok(bound[0].tool_calls[0].id.length <= 64);
  assert.equal(bound[1].tool_call_id, bound[0].tool_calls[0].id);
});

test('callItemIds and plainItemIds fix prefixes and unsafe ids', () => {
  const items = [
    { type: 'custom_tool_call', id: 'fc_abc', call_id: 'c1', name: 'x' },
    { type: 'tool_search_call', id: 'fc_def', call_id: 'c2', name: 'tool_search' },
    { type: 'message', id: 'msg/bad', role: 'assistant', content: 'x' },
    { type: 'reasoning', id: 'rs/bad', summary: [] },
  ];
  const prefixed = callItemIds(items);
  assert.equal(prefixed[0].id, 'ctc_abc');
  assert.equal(prefixed[1].id, 'tsc_def');
  const plain = plainItemIds(prefixed);
  assert.equal(plain[2].id, 'msg_bad');
  assert.equal(plain.some((item) => item.type === 'reasoning'), false);
});
