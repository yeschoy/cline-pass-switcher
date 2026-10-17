/**
 * Magpie-aligned call_id / tool_use id hygiene (Slice C).
 */

import { createHash, randomBytes } from 'node:crypto';

const ANTHROPIC_MARK = 'mp_';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_CALL_ID = 64;

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Stable ≤64 call_id mapping shared by call and output. */
export function boundCallId(id, map = new Map()) {
  if (typeof id !== 'string' || !id) return id;
  if (map.has(id)) return map.get(id);
  if (id.length <= MAX_CALL_ID && SAFE_ID.test(id)) {
    map.set(id, id);
    return id;
  }
  const digest = createHash('sha256').update(id).digest();
  const short = `call_${base64url(digest).slice(0, 27)}`;
  const bound = short.length <= MAX_CALL_ID ? short : short.slice(0, MAX_CALL_ID);
  map.set(id, bound);
  map.set(bound, bound);
  return bound;
}

export function anthropicOutId(id) {
  if (typeof id !== 'string' || !id) return id;
  if (SAFE_ID.test(id) && !id.startsWith(ANTHROPIC_MARK)) return id;
  return ANTHROPIC_MARK + base64url(Buffer.from(id, 'utf8'));
}

export function anthropicInId(id) {
  if (typeof id !== 'string' || !id) return id;
  if (!id.startsWith(ANTHROPIC_MARK) || !SAFE_ID.test(id)) return id;
  try {
    const raw = Buffer.from(id.slice(ANTHROPIC_MARK.length), 'base64url').toString('utf8');
    if (!raw || anthropicOutId(raw) !== id) return id;
    return raw;
  } catch {
    return id;
  }
}

/** Deterministic placed call id for inbound history missing ids. */
export function placedCallId(msgIndex, callIndex, name, args) {
  const sum = createHash('sha256')
    .update(`${msgIndex}.${callIndex}\0${name || ''}\0${args || ''}`)
    .digest();
  return `call_${sum.subarray(0, 12).toString('hex')}`;
}

/**
 * Fill missing tool_calls[].id and assign open tool messages without tool_call_id
 * in declaration order. Already-present ids are left unchanged.
 */
export function mintMissingChatCallIds(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  let open = [];
  const out = messages.map((message, at) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      open = [];
      let localChange = false;
      const calls = message.tool_calls.map((call, i) => {
        const id = typeof call?.id === 'string' ? call.id : '';
        if (id) return call;
        const name = call?.function?.name || '';
        const args = call?.function?.arguments || '';
        const minted = placedCallId(at, i, name, args);
        open.push(minted);
        localChange = true;
        changed = true;
        return { ...call, id: minted };
      });
      if (!localChange) return message;
      return { ...message, tool_calls: calls };
    }
    if (message.role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (id || !open.length) return message;
      const next = open.shift();
      changed = true;
      return { ...message, tool_call_id: next };
    }
    return message;
  });
  return changed ? out : messages;
}

/** Apply boundCallId to every tool_call_id / tool_calls[].id in Chat messages. */
export function bindChatCallIds(messages, map = new Map()) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map((call) => {
        if (typeof call?.id !== 'string' || !call.id) return call;
        const bound = boundCallId(call.id, map);
        if (bound === call.id) return call;
        changed = true;
        return { ...call, id: bound };
      });
      return changed ? { ...message, tool_calls: calls } : message;
    }
    if (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id) {
      const bound = boundCallId(message.tool_call_id, map);
      if (bound === message.tool_call_id) return message;
      changed = true;
      return { ...message, tool_call_id: bound };
    }
    return message;
  });
  return changed ? out : messages;
}

/**
 * Responses item id prefix correction for tool_search_call / custom_tool_call.
 * call_id field is left untouched.
 */
export function callItemIds(input) {
  if (!Array.isArray(input)) return input;
  const prefixes = {
    tool_search_call: 'tsc_',
    custom_tool_call: 'ctc_',
  };
  let changed = false;
  const out = input.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const wanted = prefixes[item.type];
    if (!wanted || typeof item.id !== 'string' || !item.id || item.id.startsWith(wanted)) return item;
    changed = true;
    const id = item.id.includes('_')
      ? wanted + item.id.slice(item.id.indexOf('_') + 1)
      : wanted + item.id;
    return { ...item, id };
  });
  return changed ? out : input;
}

/** Replace unsafe characters in Responses item `id` (not call_id). */
export function plainItemIds(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      out.push(item);
      continue;
    }
    if (typeof item.id !== 'string' || !item.id || SAFE_ID.test(item.id)) {
      out.push(item);
      continue;
    }
    if (item.type === 'reasoning') {
      changed = true;
      continue; // drop unsafe reasoning ids
    }
    changed = true;
    out.push({ ...item, id: item.id.replace(/[^A-Za-z0-9_-]/g, '_') });
  }
  return changed ? out : input;
}

/** Bound every call_id on Responses input items. */
export function boundCallIdsOnInput(input, map = new Map()) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.call_id !== 'string' || !item.call_id) return item;
    const bound = boundCallId(item.call_id, map);
    if (bound === item.call_id) return item;
    changed = true;
    return { ...item, call_id: bound };
  });
  return changed ? out : input;
}

/** Random call_ id for outbound stream fragments missing an id. */
export function randomCallId(prefix = 'call_') {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

/**
 * Stream mend: first sight of (choice,index) without id → mint;
 * later empty id fields are stripped so clients cannot overwrite.
 */
export function mendStreamToolCalls(seen, choice, rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return { toolCalls: rawToolCalls, changed: false };
  let changed = false;
  const calls = rawToolCalls.map((call, k) => {
    const idx = Number.isInteger(call?.index) ? call.index : k;
    const key = `${choice}:${idx}`;
    const id = typeof call?.id === 'string' ? call.id : '';
    if (!seen.has(key)) {
      seen.add(key);
      if (!id) {
        changed = true;
        return { ...call, id: randomCallId() };
      }
      return call;
    }
    if ('id' in (call || {}) && !id) {
      changed = true;
      const next = { ...call };
      delete next.id;
      return next;
    }
    return call;
  });
  return { toolCalls: changed ? calls : rawToolCalls, changed };
}
