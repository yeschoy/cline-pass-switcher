import { randomBytes } from 'node:crypto';

const REASONING_PREFIX = 'clps1.';
const REASONING_FIELDS = new Set(['reasoning_content', 'reasoning']);

export class AdapterError extends Error {
  constructor(message, { status = 400, type = 'invalid_request_error', param = null, code = null } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

export const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function newId(prefix) {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeReasoning({ text, field } = {}) {
  const payload = JSON.stringify({
    t: String(text ?? ''),
    f: field === 'reasoning' ? 'reasoning' : 'reasoning_content',
  });
  return REASONING_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeReasoning(token) {
  if (typeof token !== 'string' || !token.startsWith(REASONING_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(REASONING_PREFIX.length), 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'string' || !REASONING_FIELDS.has(parsed.f)) return null;
    return { text: parsed.t, field: parsed.f };
  } catch {
    return null;
  }
}

export function extractReasoning(source) {
  if (!isPlainObject(source)) return { text: '', field: null };
  if (typeof source.reasoning_content === 'string' && source.reasoning_content) {
    return { text: source.reasoning_content, field: 'reasoning_content' };
  }
  if (typeof source.reasoning === 'string' && source.reasoning) {
    return { text: source.reasoning, field: 'reasoning' };
  }
  if (Array.isArray(source.reasoning_details)) {
    const parts = [];
    for (const detail of source.reasoning_details) {
      if (detail?.type === 'reasoning.text' && typeof detail.text === 'string') parts.push(detail.text);
    }
    if (parts.length) return { text: parts.join(''), field: 'reasoning_content' };
  }
  return { text: '', field: null };
}

export function unwrapChatPayload(event) {
  if (!isPlainObject(event)) return event;
  if (event.data && isPlainObject(event.data) && (event.data.choices || event.data.error || event.data.usage)) return event.data;
  return event;
}

function parseSseEvent(buffer) {
  const text = buffer.toString('utf8');
  const payload = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
  if (!payload) return [];
  if (payload === '[DONE]') return [{ kind: 'done' }];
  let event;
  try { event = JSON.parse(payload); } catch { return []; }
  return [{ kind: 'delta', payload: unwrapChatPayload(event) }];
}

export function createChatSseReader() {
  let pending = Buffer.alloc(0);
  let sawDone = false;
  return {
    get sawDone() { return sawDone; },
    push(chunk) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      const events = [];
      while (true) {
        const match = /\r?\n\r?\n/.exec(pending.toString('latin1'));
        if (!match) break;
        const end = match.index + match[0].length;
        for (const event of parseSseEvent(pending.subarray(0, end))) {
          if (event.kind === 'done') sawDone = true;
          events.push(event);
        }
        pending = pending.subarray(end);
      }
      return events;
    },
    flush() {
      if (!pending.length) return [];
      const rest = pending;
      pending = Buffer.alloc(0);
      const events = parseSseEvent(rest);
      for (const event of events) if (event.kind === 'done') sawDone = true;
      return events;
    },
  };
}

function applyToolDelta(tools, toolCalls) {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    const index = Number.isInteger(call?.index) ? call.index : tools.size ? Math.max(...tools.keys()) + (call?.id ? 1 : 0) : 0;
    const current = tools.get(index) || { id: '', name: '', arguments: '' };
    if (typeof call.id === 'string' && call.id) current.id = call.id;
    const fn = call.function || {};
    if (typeof fn.name === 'string') current.name += fn.name;
    if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
    tools.set(index, current);
  }
}

export function createChatAggregator() {
  let text = '';
  let reasoning = '';
  let reasoningField = null;
  const tools = new Map();
  let finishReason = null;
  let usage = null;
  let error = null;

  const addReasoning = (source) => {
    const found = extractReasoning(source);
    if (!found.text) return;
    reasoning += found.text;
    reasoningField ||= found.field;
  };

  const applyMessage = (message) => {
    if (!isPlainObject(message)) return;
    if (typeof message.content === 'string') text += message.content;
    addReasoning(message);
    applyToolDelta(tools, message.tool_calls);
  };

  const applyDelta = (payload) => {
    const body = unwrapChatPayload(payload);
    if (!isPlainObject(body)) return;
    if (body.error) error = body.error;
    if (body.usage) usage = body.usage;
    const choice = body.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.message) applyMessage(choice.message);
    const delta = choice.delta;
    if (!isPlainObject(delta)) return;
    if (typeof delta.content === 'string') text += delta.content;
    addReasoning(delta);
    applyToolDelta(tools, delta.tool_calls);
  };

  const snapshot = () => ({
    text,
    reasoning,
    reasoningField,
    tool_calls: [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
    finish_reason: finishReason,
    usage,
    error,
  });

  return {
    applyDelta,
    snapshot,
    get finishReason() { return finishReason; },
    get usage() { return usage; },
    get error() { return error; },
  };
}

function addTokenText(state, value) {
  const text = String(value ?? '');
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii += 1;
    else other += 1;
  }
  state.tokens += Math.ceil(ascii / 4) + other;
}

export function estimateTokens(chatBody) {
  const state = { tokens: 0 };
  for (const message of Array.isArray(chatBody?.messages) ? chatBody.messages : []) {
    state.tokens += 4;
    if (typeof message?.content === 'string') addTokenText(state, message.content);
    else if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === 'image_url') state.tokens += 1000;
        else if (typeof part?.text === 'string') addTokenText(state, part.text);
        else if (typeof part === 'string') addTokenText(state, part);
      }
    }
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.function?.name) addTokenText(state, call.function.name);
        if (call?.function?.arguments) addTokenText(state, call.function.arguments);
      }
    }
  }
  if (Array.isArray(chatBody?.tools)) addTokenText(state, JSON.stringify(chatBody.tools));
  return Math.max(1, state.tokens);
}

export function mapChatUsage(usage) {
  if (!isPlainObject(usage)) return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const total = usage.total_tokens;
  if (input == null && output == null && total == null) return null;
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    total: Number.isFinite(total) ? total : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0),
    cached: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? null,
  };
}

export function joinTextParts(content, { textKeys = ['text'] } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isPlainObject(part)) return '';
    for (const key of textKeys) if (typeof part[key] === 'string') return part[key];
    return '';
  }).join('');
}

export function requireObject(value, message, param) {
  if (!isPlainObject(value)) throw new AdapterError(message, { param });
  return value;
}

export function requireString(value, message, param) {
  if (typeof value !== 'string' || !value.trim()) throw new AdapterError(message, { param });
  return value;
}
