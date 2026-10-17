/**
 * Magpie-aligned Responses input[] heal: joinToolRuns → orphanedToolOutputs → pairToolItems.
 */

import { INTERRUPTED_TOOL_RESULT } from './tool-pairing.js';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isResultItem(item) {
  const type = item?.type;
  return typeof item?.call_id === 'string' && item.call_id
    && typeof type === 'string'
    && type.endsWith('_output');
}

function isToolCallItem(type) {
  return type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call'
    || type === 'local_shell_call';
}

function isToolResultItem(type) {
  return type === 'function_call_output' || type === 'custom_tool_call_output'
    || type === 'tool_search_output' || type === 'local_shell_call_output';
}

function isExchangeItem(type) {
  return isToolCallItem(type) || isToolResultItem(type);
}

function modelsOwn(item) {
  const type = item?.type;
  if (type === 'reasoning') return true;
  if (type === 'message' && item.role === 'assistant') return true;
  if (typeof type === 'string' && type.endsWith('_call')) return true;
  return false;
}

function toolOutputParts(output) {
  if (typeof output === 'string') {
    return { text: output, images: [] };
  }
  if (!Array.isArray(output)) {
    if (output == null) return { text: '', images: [] };
    return { text: typeof output === 'object' ? JSON.stringify(output) : String(output), images: [] };
  }
  const textParts = [];
  const images = [];
  for (const part of output) {
    if (typeof part === 'string') textParts.push(part);
    else if (isPlainObject(part)) {
      if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
        if (typeof part.text === 'string') textParts.push(part.text);
      } else if (part.type === 'input_image' || part.type === 'image_url') {
        images.push(part);
      } else if (typeof part.text === 'string') textParts.push(part.text);
    }
  }
  return { text: textParts.join(''), images };
}

/**
 * Reorder items so intervening notes after results move past the run,
 * and assistant messages (± preceding reasoning) move before the first call.
 */
export function joinToolRuns(input) {
  if (!Array.isArray(input)) return input;
  const items = input.map((raw) => (isPlainObject(raw) ? raw : null));
  const n = items.length;
  const ahead = new Map();
  const answeredLater = new Array(n).fill(false);
  for (let i = n - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (isResultItem(it)) ahead.set(it.call_id, true);
    else if (typeof it.call_id === 'string' && it.call_id) answeredLater[i] = ahead.has(it.call_id);
  }

  const out = [];
  const kinds = [];
  const held = [];
  let moved = false;
  const open = new Map();
  let answering = false;
  let first = 0;

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const it = items[i];
    if (!it) {
      out.push(raw);
      kinds.push(null);
      continue;
    }

    if (isResultItem(it)) {
      if (open.has(it.call_id)) {
        open.delete(it.call_id);
        answering = true;
      }
    } else if (typeof it.call_id === 'string' && it.call_id) {
      if (answeredLater[i]) {
        if (open.size === 0) first = out.length;
        open.set(it.call_id, true);
      }
    } else if (open.size > 0 && (answering || !modelsOwn(it))) {
      held.push(raw);
      moved = true;
      continue;
    } else if (open.size > 0 && it.type === 'message') {
      let from = out.length;
      while (from > first && kinds[from - 1]?.type === 'reasoning') from -= 1;
      const seg = out.splice(from);
      const segKinds = kinds.splice(from);
      out.splice(first, 0, ...seg, raw);
      kinds.splice(first, 0, ...segKinds, it);
      first += seg.length + 1;
      moved = true;
      continue;
    }

    out.push(raw);
    kinds.push(it);
    if (open.size === 0) {
      if (held.length) {
        out.push(...held);
        for (let h = 0; h < held.length; h++) kinds.push(null);
        held.length = 0;
      }
      answering = false;
    }
  }
  if (held.length) out.push(...held);
  return moved ? out : input;
}

/**
 * Orphan outputs (no call_id) become user messages.
 */
export function orphanedToolOutputs(input) {
  if (!Array.isArray(input)) return input;
  const out = [];
  const pending = [];
  let inCalls = false;
  let hadResults = false;
  let changed = false;

  const flush = () => {
    if (pending.length) {
      out.push(...pending);
      pending.length = 0;
    }
  };

  for (const raw of input) {
    const item = isPlainObject(raw) ? raw : null;
    if (!item) {
      flush();
      inCalls = false;
      out.push(raw);
      continue;
    }

    const type = item.type;
    const isOutput = type === 'function_call_output' || type === 'custom_tool_call_output';
    const callId = typeof item.call_id === 'string' ? item.call_id : '';

    if (!isOutput || callId) {
      if (isToolCallItem(type) || type === 'tool_search_call') {
        if (hadResults) flush();
        inCalls = true;
        hadResults = false;
      } else if (isToolResultItem(type)) {
        hadResults = true;
      } else {
        flush();
        inCalls = false;
      }
      out.push(raw);
      continue;
    }

    const { text, images } = toolOutputParts(item.output);
    const content = [];
    const body = text.trim() ? text : 'Tool result received.';
    content.push({ type: 'input_text', text: body });
    for (const image of images) content.push(image);
    const message = { type: 'message', role: 'user', content };
    if (inCalls) pending.push(message);
    else out.push(message);
    changed = true;
  }
  flush();
  return changed ? out : input;
}

/**
 * Unanswered function/custom calls get a synthetic interrupted output at exchange end.
 */
export function pairToolItems(input) {
  if (!Array.isArray(input)) return input;
  const items = input.map((raw) => (isPlainObject(raw) ? raw : null));
  const answered = new Set();
  for (const it of items) {
    if (!it) continue;
    if ((it.type === 'function_call_output' || it.type === 'custom_tool_call_output')
      && typeof it.call_id === 'string' && it.call_id) {
      answered.add(it.call_id);
    }
  }

  const out = [];
  const synthetic = [];
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const it = items[i];
    out.push(raw);
    if (!it) continue;

    if ((it.type === 'function_call' || it.type === 'custom_tool_call')
      && typeof it.call_id === 'string' && it.call_id
      && !answered.has(it.call_id)) {
      const kind = it.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output';
      synthetic.push({ type: kind, call_id: it.call_id, output: INTERRUPTED_TOOL_RESULT });
      answered.add(it.call_id);
      changed = true;
    }

    if (synthetic.length && isExchangeItem(it.type)) {
      const next = items[i + 1];
      const nextExchange = next && isExchangeItem(next.type);
      if (!nextExchange) {
        out.push(...synthetic);
        synthetic.length = 0;
      }
    }
  }
  if (synthetic.length) {
    out.push(...synthetic);
    changed = true;
  }
  return changed ? out : input;
}

/** Responses input heal pipeline before convertInputItems. */
export function healResponsesInput(input) {
  if (!Array.isArray(input)) return input;
  return pairToolItems(orphanedToolOutputs(joinToolRuns(input)));
}
