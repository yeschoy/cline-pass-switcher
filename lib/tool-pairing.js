/**
 * Magpie-aligned Chat message tool-exchange heal (Slice B).
 * Byte-stable for already-clean exchanges; idempotent.
 */

import { mintMissingChatCallIds } from './protocol-ids.js';

export const INTERRUPTED_TOOL_RESULT =
  '[The result of this tool call is unavailable: the turn was interrupted.]';

const TOOL_PLACEHOLDER = 'Tool result received.';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function emptyAssistant(message) {
  if (message?.role !== 'assistant' || hasToolCalls(message)) return false;
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.trim()
    : typeof message.reasoning === 'string' ? message.reasoning.trim() : '';
  const content = typeof message.content === 'string' ? message.content.trim()
    : message.content == null ? '' : String(message.content).trim();
  return !reasoning && !content;
}

function silentAssistant(message) {
  if (message?.role !== 'assistant') return false;
  if (hasToolCalls(message)) return false;
  if (message.function_call || message.refusal || message.audio || message.prefix || message.partial) return false;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) return false;
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) return false;
  const content = message.content;
  if (typeof content === 'string') return !content.trim();
  if (Array.isArray(content)) return content.length === 0;
  return content == null || content === '';
}

function contentAsString(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (isPlainObject(part) && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return String(content);
}

/**
 * Merge consecutive assistant messages when the prior already has tool_calls
 * (avoids closing an exchange at the next assistant boundary).
 */
export function joinSplitAssistantCalls(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (
      out.length
      && message?.role === 'assistant'
      && out[out.length - 1]?.role === 'assistant'
      && hasToolCalls(out[out.length - 1])
    ) {
      const prev = out[out.length - 1];
      const merged = { ...prev };
      if (hasToolCalls(message)) {
        merged.tool_calls = [...(prev.tool_calls || []), ...message.tool_calls];
      }
      const prevText = contentAsString(prev.content);
      const nextText = contentAsString(message.content);
      if (prevText || nextText) {
        merged.content = prevText && nextText ? `${prevText}${nextText}` : (prevText || nextText || null);
      } else if (merged.tool_calls?.length) {
        merged.content = null;
      }
      for (const field of ['reasoning_content', 'reasoning']) {
        if (typeof message[field] === 'string' && message[field]) {
          merged[field] = (typeof prev[field] === 'string' ? prev[field] : '') + message[field];
        }
      }
      out[out.length - 1] = merged;
    } else {
      out.push(isPlainObject(message) ? { ...message } : message);
    }
  }
  return out;
}

/**
 * Drop silent/empty assistants outside an open tool exchange; merge adjacent users.
 */
export function withoutSilentAssistants(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const message of messages) {
    if (silentAssistant(message)) continue;
    if (
      message?.role === 'user'
      && out.length
      && out[out.length - 1]?.role === 'user'
      && typeof out[out.length - 1].content === 'string'
      && typeof message.content === 'string'
    ) {
      out[out.length - 1] = {
        ...out[out.length - 1],
        content: `${out[out.length - 1].content}\n\n${message.content}`,
      };
      continue;
    }
    out.push(isPlainObject(message) ? { ...message } : message);
  }
  return out;
}

/**
 * Pair assistant.tool_calls with role=tool messages; synthesize interrupted results;
 * orphan / empty tool_call_id → user text; reorder parallel results by call declaration order.
 */
export function pairToolMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let pending = [];
  let order = new Map();
  const answered = new Set();
  let tools = [];

  const flushTools = () => {
    tools.sort((a, b) => (order.get(a.tool_call_id) ?? 0) - (order.get(b.tool_call_id) ?? 0));
    out.push(...tools);
    tools = [];
  };

  const flushPending = () => {
    // Fold synthetics into the tool list so declaration-order sort covers both
    // real results and interrupted placeholders (RB2/RB4).
    for (const id of pending) {
      if (!answered.has(id)) {
        tools.push({ role: 'tool', tool_call_id: id, content: INTERRUPTED_TOOL_RESULT });
      }
    }
    flushTools();
    pending = [];
    order = new Map();
    answered.clear();
  };

  const toolAsUser = (message) => {
    let text = contentAsString(message.content);
    if (!text.trim()) text = TOOL_PLACEHOLDER;
    if (
      out.length
      && out[out.length - 1]?.role === 'user'
      && typeof out[out.length - 1].content === 'string'
    ) {
      out[out.length - 1] = {
        ...out[out.length - 1],
        content: `${out[out.length - 1].content}\n\n${text}`,
      };
    } else {
      out.push({ role: 'user', content: text });
    }
  };

  for (const message of messages) {
    const role = message?.role;
    if (role === 'assistant') {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        if (pending.length && emptyAssistant(message)) continue;
        flushPending();
        out.push(isPlainObject(message) ? { ...message } : message);
      } else {
        flushPending();
        out.push(isPlainObject(message) ? { ...message } : message);
        calls.forEach((call, i) => {
          const id = typeof call?.id === 'string' ? call.id : '';
          if (!id) return;
          pending.push(id);
          order.set(id, i);
        });
      }
      continue;
    }
    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!id || !order.has(id)) {
        flushPending();
        toolAsUser(message);
      } else if (answered.has(id)) {
        continue;
      } else {
        answered.add(id);
        tools.push(isPlainObject(message) ? { ...message } : message);
      }
      continue;
    }
    flushPending();
    out.push(isPlainObject(message) ? { ...message } : message);
  }
  flushPending();
  return out;
}

/**
 * Full Chat-layer heal pipeline (after protocol-specific convert).
 * Mint missing call ids before pairing so unanswered empty-id calls still
 * receive interrupted results (RC1 + RB2).
 */
export function healChatMessages(messages) {
  return pairToolMessages(
    mintMissingChatCallIds(withoutSilentAssistants(joinSplitAssistantCalls(messages))),
  );
}
