/**
 * Cline model-family reasoning history replay (Slice D).
 * Applied after heal + id hygiene, before returning chatBody.
 */

import { extractReasoning, isPlainObject } from './protocol-common.js';

const THINK_RE = /<think>([\s\S]*?)<\/think>/gi;

function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  return {
    deepseek: /deepseek/.test(m),
    kimi: /kimi/.test(m),
    mimo: /mimo/.test(m),
    glm: /\bglm\b|\/glm|glm-/.test(m),
    minimax: /minimax/.test(m),
  };
}

function hasReasoningField(message) {
  if (!isPlainObject(message)) return false;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) return true;
  if (typeof message.reasoning === 'string' && message.reasoning) return true;
  if (Array.isArray(message.reasoning_details) && message.reasoning_details.length) return true;
  return false;
}

function foldReasoningDetails(message) {
  if (!isPlainObject(message)) return message;
  const found = extractReasoning(message);
  const next = { ...message };
  if (found.text) {
    next.reasoning_content = found.text;
  }
  if ('reasoning_details' in next) delete next.reasoning_details;
  // Drop indexed reasoning_details envelopes that strict upstreams reject.
  return next;
}

function splitThinkTags(message) {
  if (!isPlainObject(message) || typeof message.content !== 'string') return message;
  if (!/<think>/i.test(message.content)) return message;
  const parts = [];
  let content = message.content.replace(THINK_RE, (_, think) => {
    parts.push(think);
    return '';
  });
  content = content.trim();
  const next = { ...message, content: content || (message.tool_calls?.length ? null : '') };
  const thinkText = parts.join('').trim();
  if (thinkText && !hasReasoningField(next)) {
    next.reasoning_content = thinkText;
  }
  return next;
}

function ensureDeepseekPlaceholder(message) {
  if (!isPlainObject(message) || message.role !== 'assistant') return message;
  if (!Array.isArray(message.tool_calls) || !message.tool_calls.length) return message;
  if (hasReasoningField(message)) return message;
  // Magpie uses a single space placeholder — do not overwrite clps1./non-empty text.
  return { ...message, reasoning_content: ' ' };
}

/**
 * Apply RD1–RD4 to Chat messages based on request model string.
 * clps1. seal restoration happens earlier in adapters; non-empty reasoning wins over placeholders.
 */
export function applyReasoningReplay(messages, model) {
  if (!Array.isArray(messages)) return messages;
  const family = modelFamily(model);
  return messages.map((message) => {
    if (!isPlainObject(message) || message.role !== 'assistant') return message;
    let next = message;

    // MiniMax heuristic (and any model that embeds <think> tags).
    if (family.minimax || /<think>/i.test(typeof next.content === 'string' ? next.content : '')) {
      next = splitThinkTags(next);
    }

    // Fold reasoning_details → reasoning_content for Kimi / MiMo / GLM / DeepSeek.
    if (family.kimi || family.mimo || family.glm || family.deepseek || Array.isArray(next.reasoning_details)) {
      next = foldReasoningDetails(next);
    }

    // DeepSeek: tool-bearing assistants need a reasoning_content field (space placeholder).
    // GLM must NOT get the space placeholder.
    if (family.deepseek && !family.glm) {
      next = ensureDeepseekPlaceholder(next);
    }

    // Kimi / MiMo: ensure tool-round assistants expose reasoning_content when extractable;
    // if still missing after fold, leave as-is (no space placeholder).
    if ((family.kimi || family.mimo) && Array.isArray(next.tool_calls) && next.tool_calls.length) {
      next = foldReasoningDetails(next);
    }

    return next;
  });
}
