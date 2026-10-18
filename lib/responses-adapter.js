import {
  AdapterError, createChatAggregator, decodeReasoning, encodeReasoning, extractReasoning,
  isPlainObject, joinTextParts, mapChatUsage, newId, normalizeToolArguments, requireObject, sseEvent,
  unwrapChatPayload,
} from './protocol-common.js';
import { healResponsesInput } from './responses-pairing.js';
import { healChatMessages } from './tool-pairing.js';
import {
  bindChatCallIds, boundCallId, boundCallIdsOnInput, callItemIds, plainItemIds,
} from './protocol-ids.js';
import { applyReasoningReplay } from './reasoning-replay.js';

const REJECT_FIELDS = Object.freeze(['previous_response_id', 'conversation', 'context_management', 'prompt']);
const HOSTED_TOOLS = new Set([
  'web_search', 'web_search_preview', 'file_search', 'code_interpreter', 'mcp',
  'computer', 'computer_use', 'computer_use_preview', 'image_generation',
]);
const PASSTHROUGH = ['temperature', 'top_p', 'user', 'prompt_cache_key', 'parallel_tool_calls'];

function fail(message, param, code = null) {
  throw new AdapterError(message, { param, code });
}

function lastUserMessageIndex(input) {
  let last = -1;
  for (let i = 0; i < input.length; i++) {
    if (input[i]?.type === 'message' && input[i].role === 'user') last = i;
  }
  return last;
}

function imagePart(part, param) {
  if (part.file_id || part.image_file || part.file) fail('image file_id is not supported', param);
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || !url) fail('input_image requires image_url', param);
  const detail = isPlainObject(part.image_url) && typeof part.image_url.detail === 'string' ? part.image_url.detail : part.detail;
  return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

function convertMessageContent(content, role, param) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : fail('message content must be a string or array', param);
  const parts = [];
  let text = '';
  let hasImage = false;
  for (const [index, part] of content.entries()) {
    if (typeof part === 'string') { text += part; continue; }
    if (!isPlainObject(part) || typeof part.type !== 'string') fail('invalid message content part', `${param}[${index}]`);
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') text += typeof part.text === 'string' ? part.text : '';
    else if (part.type === 'refusal') text += typeof part.refusal === 'string' ? part.refusal : '';
    else if (part.type === 'input_image') { hasImage = true; parts.push(imagePart(part, `${param}[${index}]`)); }
    else if (part.type === 'input_file' || part.type === 'file') fail(`${part.type} is not supported`, `${param}[${index}].type`);
    else fail(`unsupported content type ${part.type}`, `${param}[${index}].type`);
  }
  if (!hasImage) return text;
  if (text) parts.unshift({ type: 'text', text });
  return parts;
}

function callArguments(item) {
  if (item.type === 'custom_tool_call') {
    const input = item.input == null ? '' : typeof item.input === 'string' ? item.input : JSON.stringify(item.input);
    return JSON.stringify({ input });
  }
  if (item.type === 'local_shell_call') {
    const action = isPlainObject(item.action) ? { ...item.action } : {};
    delete action.type;
    return JSON.stringify(action);
  }
  if (typeof item.arguments === 'string') return normalizeToolArguments(item.arguments);
  return JSON.stringify(item.arguments ?? {});
}

function callName(item) {
  if (item.type === 'local_shell_call') return 'local_shell';
  return typeof item.name === 'string' ? item.name : '';
}

function outputText(item) {
  if (typeof item.output === 'string') return item.output;
  if (Array.isArray(item.output)) return joinTextParts(item.output, { textKeys: ['text', 'output'] });
  if (item.output == null) return '';
  return typeof item.output === 'object' ? JSON.stringify(item.output) : String(item.output);
}

/**
 * OpenAI EasyInputMessage / Codex often send `{ role, content }` without `type`.
 * Magpie treats `type=="" && role!=""` as message; normalize before heal/convert.
 */
function normalizeResponsesInputItems(input) {
  return input.map((item, i) => {
    if (typeof item === 'string') {
      return { type: 'message', role: 'user', content: item };
    }
    if (!isPlainObject(item)) fail('input items must be objects with a type', `input[${i}]`);
    if (typeof item.type === 'string' && item.type) return item;
    if (typeof item.role === 'string' && item.role) {
      return { ...item, type: 'message' };
    }
    fail('input items must be objects with a type', `input[${i}]`);
  });
}

function convertInputItems(input) {
  const messages = [];
  const lastUser = lastUserMessageIndex(input);
  const calls = new Map();
  let pending = null;
  let pendingReasoning = null;

  const applyReasoning = (message) => {
    if (!pendingReasoning) return;
    message[pendingReasoning.field] = (message[pendingReasoning.field] || '') + pendingReasoning.text;
    pendingReasoning = null;
  };

  const ensureAssistant = () => {
    if (!pending) pending = { role: 'assistant', content: '' };
    applyReasoning(pending);
    return pending;
  };

  const flush = () => {
    if (pendingReasoning) {
      const message = pending || { role: 'assistant', content: '' };
      applyReasoning(message);
      pending = message;
    }
    if (!pending) return;
    if (!pending.content && pending.tool_calls) pending.content = null;
    messages.push(pending);
    pending = null;
  };

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!isPlainObject(item) || typeof item.type !== 'string') fail('input items must be objects with a type', `input[${i}]`);
    const param = `input[${i}]`;
    switch (item.type) {
      case 'message': {
        const role = item.role;
        if (role === 'user' || role === 'system' || role === 'developer') {
          flush();
          messages.push({
            role: role === 'developer' ? 'system' : role,
            content: convertMessageContent(item.content, role, `${param}.content`),
          });
        } else if (role === 'assistant') {
          const assistant = ensureAssistant();
          const text = typeof item.content === 'string' || Array.isArray(item.content)
            ? convertMessageContent(item.content, role, `${param}.content`)
            : '';
          if (typeof text === 'string' && text) assistant.content = (assistant.content || '') + text;
          else if (Array.isArray(text) && text.length) {
            const existing = typeof assistant.content === 'string' && assistant.content
              ? [{ type: 'text', text: assistant.content }]
              : Array.isArray(assistant.content) ? assistant.content : [];
            assistant.content = [...existing, ...text];
          }
        } else fail(`unsupported message role ${role}`, `${param}.role`);
        break;
      }
      case 'reasoning': {
        if (i > lastUser) {
          const decoded = decodeReasoning(item.encrypted_content);
          if (decoded) {
            if (pending) {
              pendingReasoning = decoded;
              applyReasoning(pending);
            } else {
              pendingReasoning = pendingReasoning ? { ...pendingReasoning, text: pendingReasoning.text + decoded.text } : decoded;
            }
          }
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'tool_search_call': {
        let callId = typeof item.call_id === 'string' ? item.call_id : '';
        // Missing call_id is minted later by mintMissingChatCallIds; track a provisional slot.
        if (!callId) callId = '';
        if (callId && calls.has(callId)) fail(`duplicate call_id ${callId}`, `${param}.call_id`);
        if (callId) calls.set(callId, 'open');
        const assistant = ensureAssistant();
        assistant.tool_calls ||= [];
        const name = item.type === 'tool_search_call'
          ? (typeof item.name === 'string' && item.name ? item.name : 'tool_search')
          : (callName(item) || fail('tool call requires name', `${param}.name`));
        if (item.type === 'tool_search_call') {
          // Mark for round-trip via a side channel on the name map after convertTools.
        }
        assistant.tool_calls.push({
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: item.type === 'tool_search_call'
              ? (typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}))
              : callArguments(item),
          },
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        flush();
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        // Heal should have turned orphans into user messages; keep a soft fallback.
        if (!callId || calls.get(callId) !== 'open') {
          const text = outputText(item) || 'Tool result received.';
          messages.push({ role: 'user', content: text });
          break;
        }
        calls.set(callId, 'closed');
        messages.push({ role: 'tool', tool_call_id: callId, content: outputText(item) });
        break;
      }
      case 'item_reference':
        fail('item_reference is not supported', param);
        break;
      default:
        fail(`unsupported input type ${item.type}`, `${param}.type`);
    }
  }
  flush();
  return messages;
}

function convertTools(tools, toolMap) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) fail('tools must be an array', 'tools');
  return tools.map((tool, index) => {
    if (!isPlainObject(tool) || typeof tool.type !== 'string') fail('invalid tool', `tools[${index}]`);
    const param = `tools[${index}].type`;
    if (HOSTED_TOOLS.has(tool.type) || tool.type.startsWith('web_search') || tool.type.startsWith('computer')) {
      fail(`hosted tool type ${tool.type} is not supported`, param);
    }
    if (tool.type === 'function') {
      const fn = tool.name && !tool.function ? tool : tool.function;
      if (!isPlainObject(fn) || typeof fn.name !== 'string') fail('function tool requires name', `tools[${index}].name`);
      toolMap.set(fn.name, 'function');
      return {
        type: 'function',
        function: {
          name: fn.name,
          ...(typeof (fn.description ?? tool.description) === 'string' ? { description: fn.description ?? tool.description } : {}),
          ...(fn.parameters != null ? { parameters: fn.parameters } : tool.parameters != null ? { parameters: tool.parameters } : {}),
          ...(fn.strict === true || tool.strict === true ? { strict: true } : {}),
        },
      };
    }
    if (tool.type === 'custom') {
      const name = typeof tool.name === 'string' ? tool.name : fail('custom tool requires name', `tools[${index}].name`);
      toolMap.set(name, 'custom');
      const format = tool.format ? `\nformat: ${typeof tool.format === 'string' ? tool.format : JSON.stringify(tool.format)}` : '';
      return {
        type: 'function',
        function: {
          name,
          description: `${tool.description || name}${format}`,
          parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        },
      };
    }
    if (tool.type === 'local_shell') {
      toolMap.set('local_shell', 'local_shell');
      return {
        type: 'function',
        function: {
          name: 'local_shell',
          description: tool.description || 'Run a local shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
              workdir: { type: 'string' },
              working_directory: { type: 'string' },
              timeout_ms: { type: 'number' },
              env: { type: 'object' },
            },
            required: ['command'],
          },
        },
      };
    }
    if (tool.type === 'tool_search') {
      const name = typeof tool.name === 'string' && tool.name ? tool.name : 'tool_search';
      toolMap.set(name, 'tool_search');
      return {
        type: 'function',
        function: {
          name,
          description: tool.description || 'Search available tools',
          parameters: tool.parameters || {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      };
    }
    fail(`unsupported tool type ${tool.type}`, param);
  });
}

function convertToolChoice(value) {
  if (value == null || value === 'auto' || value === 'none' || value === 'required') return value;
  if (isPlainObject(value) && (value.type === 'function' || value.type === 'custom')) {
    const name = value.name || value.function?.name;
    if (typeof name !== 'string') fail('tool_choice requires name', 'tool_choice');
    return { type: 'function', function: { name } };
  }
  fail('unsupported tool_choice', 'tool_choice');
}

function convertTextFormat(text) {
  if (!isPlainObject(text?.format) || typeof text.format.type !== 'string') return undefined;
  if (text.format.type === 'json_object') return { type: 'json_object' };
  if (text.format.type === 'json_schema') {
    return { type: 'json_schema', json_schema: text.format.json_schema || text.format.schema || text.format };
  }
  if (text.format.type === 'text') return undefined;
  fail(`unsupported text.format ${text.format.type}`, 'text.format.type');
}

function convertEffort(effort) {
  if (effort == null || effort === 'none') return undefined;
  if (effort === 'minimal') return 'low';
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  return undefined;
}

export function responsesToChat(body) {
  requireObject(body, 'request body must be an object');
  for (const field of REJECT_FIELDS) {
    if (body[field] != null && body[field] !== false) fail(`${field} is not supported`, field);
  }
  if (body.background === true) fail('background responses are not supported', 'background');
  if (body.store === true) fail('store is not supported', 'store');

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 300) fail('valid model is required', 'model');

  const toolMap = new Map();
  const tools = convertTools(body.tools, toolMap);
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions) messages.push({ role: 'system', content: body.instructions });
  if (typeof body.input === 'string') messages.push({ role: 'user', content: body.input });
  else if (Array.isArray(body.input)) {
    const prepared = boundCallIdsOnInput(plainItemIds(callItemIds(
      healResponsesInput(normalizeResponsesInputItems(body.input)),
    )));
    const converted = convertInputItems(prepared);
    // Record tool_search names seen in history for round-trip.
    for (const item of prepared) {
      if (item?.type === 'tool_search_call') {
        const name = typeof item.name === 'string' && item.name ? item.name : 'tool_search';
        toolMap.set(name, 'tool_search');
      }
    }
    // healChatMessages mints missing ids before pairing, then bind ≤64 outbound ids.
    messages.push(...bindChatCallIds(healChatMessages(converted)));
  } else if (body.input != null) fail('input must be a string or array', 'input');

  const chatBody = { model, messages: applyReasoningReplay(messages, model) };
  if (tools) chatBody.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice != null) chatBody.tool_choice = toolChoice;
  for (const key of PASSTHROUGH) if (body[key] !== undefined) chatBody[key] = body[key];
  if (Number.isFinite(body.max_output_tokens)) chatBody.max_tokens = body.max_output_tokens;
  const responseFormat = convertTextFormat(body.text);
  if (responseFormat) chatBody.response_format = responseFormat;
  const effort = convertEffort(body.reasoning?.effort);
  if (effort) chatBody.reasoning_effort = effort;
  if (body.stream === true) {
    chatBody.stream = true;
    chatBody.stream_options = { ...(isPlainObject(body.stream_options) ? body.stream_options : {}), include_usage: true };
  }

  const include = Array.isArray(body.include) ? body.include : [];
  return {
    chatBody,
    identityHints: {},
    ctx: {
      model,
      toolMap,
      callIdMap: new Map(),
      includeEncrypted: include.includes('reasoning.encrypted_content'),
      responseId: newId('resp_'),
      createdAt: Math.floor(Date.now() / 1000),
      parallelToolCalls: body.parallel_tool_calls !== false,
      toolChoice: body.tool_choice ?? 'auto',
      tools: Array.isArray(body.tools) ? body.tools : [],
    },
  };
}

function parseCustomInput(args) {
  try {
    const parsed = JSON.parse(args || '{}');
    if (typeof parsed?.input === 'string') return parsed.input;
    if (parsed?.input != null) return typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input);
  } catch { /* raw string */ }
  return args || '';
}

function parseShellAction(args) {
  let parsed = {};
  try { parsed = JSON.parse(args || '{}') || {}; } catch { parsed = {}; }
  if (!isPlainObject(parsed)) parsed = {};
  if (!parsed.type) parsed = { type: 'exec', ...parsed };
  return parsed;
}

function originalToolType(name, toolMap) {
  return toolMap?.get?.(name) || (name === 'local_shell' ? 'local_shell' : name === 'tool_search' ? 'tool_search' : 'function');
}

function usageFromChat(usage) {
  const mapped = mapChatUsage(usage);
  if (!mapped) return null;
  const out = { input_tokens: mapped.input, output_tokens: mapped.output, total_tokens: mapped.total };
  if (mapped.cached != null) out.input_tokens_details = { cached_tokens: mapped.cached };
  if (mapped.reasoning != null) out.output_tokens_details = { reasoning_tokens: mapped.reasoning };
  return out;
}

function statusFromFinish(reason) {
  if (reason === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  if (reason === 'content_filter') return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
  return { status: 'completed', incomplete_details: null };
}

function buildOutput(snapshot, ctx) {
  const output = [];
  if (snapshot.reasoning) {
    const item = {
      type: 'reasoning',
      id: newId('rs_'),
      summary: [{ type: 'summary_text', text: snapshot.reasoning }],
    };
    if (ctx.includeEncrypted) item.encrypted_content = encodeReasoning({ text: snapshot.reasoning, field: snapshot.reasoningField || 'reasoning_content' });
    output.push(item);
  }
  if (snapshot.text) {
    output.push({
      type: 'message',
      id: newId('msg_'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: snapshot.text, annotations: [] }],
    });
  }
  const callIdMap = ctx.callIdMap || new Map();
  for (const call of snapshot.tool_calls || []) {
    const name = call.function?.name || '';
    const args = normalizeToolArguments(call.function?.arguments);
    const kind = originalToolType(name, ctx.toolMap);
    const callId = boundCallId(call.id || newId('call_'), callIdMap);
    if (kind === 'custom') {
      output.push({ type: 'custom_tool_call', id: newId('ctc_'), call_id: callId, name, input: parseCustomInput(args) });
    } else if (kind === 'local_shell') {
      output.push({ type: 'local_shell_call', id: newId('lsc_'), call_id: callId, status: 'completed', action: parseShellAction(args) });
    } else if (kind === 'tool_search') {
      output.push({ type: 'tool_search_call', id: newId('tsc_'), call_id: callId, name, arguments: args });
    } else {
      output.push({ type: 'function_call', id: newId('fc_'), call_id: callId, name, arguments: args });
    }
  }
  return output;
}

function responseObject(ctx, { status, output, usage, incomplete_details = null, error = null }) {
  return {
    id: ctx.responseId,
    object: 'response',
    created_at: ctx.createdAt,
    status,
    model: ctx.model,
    output,
    usage: usageFromChat(usage),
    incomplete_details,
    error,
    parallel_tool_calls: ctx.parallelToolCalls !== false,
    tool_choice: ctx.toolChoice ?? 'auto',
    tools: ctx.tools ?? [],
  };
}

export function chatToResponses(chatJson, ctx) {
  const body = unwrapChatPayload(chatJson) || {};
  const choice = body.choices?.[0] || {};
  const message = choice.message || {};
  const reasoning = extractReasoning(message);
  const snapshot = {
    text: typeof message.content === 'string' ? message.content : joinTextParts(message.content),
    reasoning: reasoning.text,
    reasoningField: reasoning.field,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    finish_reason: choice.finish_reason || 'stop',
    usage: body.usage,
  };
  const finish = statusFromFinish(snapshot.finish_reason);
  return responseObject(ctx, {
    status: finish.status,
    output: buildOutput(snapshot, ctx),
    usage: snapshot.usage,
    incomplete_details: finish.incomplete_details,
  });
}

export function responsesErrorBody(status, err = {}) {
  const error = typeof err === 'string' ? { message: err } : (err || {});
  const type = error.type || (status === 401 ? 'auth_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'upstream_error' : 'invalid_request_error');
  return {
    error: {
      message: String(error.message || 'error'),
      type,
      param: error.param ?? null,
      code: error.code ?? null,
    },
  };
}

export function createResponsesStreamEncoder(ctx) {
  const agg = createChatAggregator();
  let seq = 0;
  let started = false;
  let closed = false;
  let nextIndex = 0;
  let reasoningOpen = null;
  let messageOpen = null;
  const tools = new Map();
  const output = [];
  const emit = (type, extra = {}) => sseEvent(type, { type, sequence_number: seq++, ...extra });

  const closeReasoning = () => {
    if (!reasoningOpen) return '';
    const item = reasoningOpen;
    reasoningOpen = null;
    const outputItem = {
      type: 'reasoning',
      id: item.id,
      summary: [{ type: 'summary_text', text: item.text }],
    };
    if (ctx.includeEncrypted) outputItem.encrypted_content = encodeReasoning({ text: item.text, field: item.field || 'reasoning_content' });
    output.push(outputItem);
    return emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: item.outputIndex, summary_index: 0, text: item.text })
      + emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: item.outputIndex, summary_index: 0, part: { type: 'summary_text', text: item.text } })
      + emit('response.output_item.done', { output_index: item.outputIndex, item: outputItem });
  };

  const closeMessage = () => {
    if (!messageOpen) return '';
    const item = messageOpen;
    messageOpen = null;
    const outputItem = {
      type: 'message',
      id: item.id,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: item.text, annotations: [] }],
    };
    output.push(outputItem);
    return emit('response.output_text.done', { item_id: item.id, output_index: item.outputIndex, content_index: 0, text: item.text })
      + emit('response.content_part.done', { item_id: item.id, output_index: item.outputIndex, content_index: 0, part: { type: 'output_text', text: item.text, annotations: [] } })
      + emit('response.output_item.done', { output_index: item.outputIndex, item: outputItem });
  };

  const closeTool = (call, index) => {
    const kind = originalToolType(call.name, ctx.toolMap);
    const callIdMap = ctx.callIdMap || new Map();
    let outputItem;
    let extra = '';
    if (kind === 'custom') {
      const input = parseCustomInput(call.arguments);
      outputItem = { type: 'custom_tool_call', id: call.itemId, call_id: boundCallId(call.id || newId('call_'), callIdMap), name: call.name, input };
      extra = emit('response.output_item.added', { output_index: call.outputIndex, item: { ...outputItem, input: '' } })
        + emit('response.custom_tool_call_input.delta', { item_id: call.itemId, output_index: call.outputIndex, delta: input })
        + emit('response.custom_tool_call_input.done', { item_id: call.itemId, output_index: call.outputIndex, input });
    } else if (kind === 'local_shell') {
      outputItem = { type: 'local_shell_call', id: call.itemId, call_id: boundCallId(call.id || newId('call_'), callIdMap), status: 'completed', action: parseShellAction(call.arguments) };
      extra = emit('response.output_item.added', { output_index: call.outputIndex, item: outputItem });
    } else if (kind === 'tool_search') {
      outputItem = {
        type: 'tool_search_call',
        id: call.itemId,
        call_id: boundCallId(call.callId || call.id || newId('call_'), callIdMap),
        name: call.name,
        arguments: call.arguments,
      };
      extra = emit('response.output_item.added', { output_index: call.outputIndex, item: outputItem });
    } else {
      outputItem = {
        type: 'function_call',
        id: call.itemId,
        call_id: boundCallId(call.callId || call.id || newId('call_'), callIdMap),
        name: call.name,
        arguments: call.arguments,
      };
      extra = emit('response.function_call_arguments.done', { item_id: call.itemId, output_index: call.outputIndex, arguments: call.arguments });
    }
    output.push(outputItem);
    tools.delete(index);
    return extra + emit('response.output_item.done', { output_index: call.outputIndex, item: outputItem });
  };

  const openReasoning = (text, field) => {
    reasoningOpen = { id: newId('rs_'), outputIndex: nextIndex++, text: text || '', field };
    return emit('response.output_item.added', {
      output_index: reasoningOpen.outputIndex,
      item: { type: 'reasoning', id: reasoningOpen.id, summary: [] },
    }) + emit('response.reasoning_summary_part.added', {
      item_id: reasoningOpen.id, output_index: reasoningOpen.outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' },
    }) + (text ? emit('response.reasoning_summary_text.delta', { item_id: reasoningOpen.id, output_index: reasoningOpen.outputIndex, summary_index: 0, delta: text }) : '');
  };

  const openMessage = (text) => {
    messageOpen = { id: newId('msg_'), outputIndex: nextIndex++, text: text || '' };
    return emit('response.output_item.added', {
      output_index: messageOpen.outputIndex,
      item: { type: 'message', id: messageOpen.id, status: 'in_progress', role: 'assistant', content: [] },
    }) + emit('response.content_part.added', {
      item_id: messageOpen.id, output_index: messageOpen.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
    }) + (text ? emit('response.output_text.delta', { item_id: messageOpen.id, output_index: messageOpen.outputIndex, content_index: 0, delta: text }) : '');
  };

  const start = () => {
    if (started) return '';
    started = true;
    const response = responseObject(ctx, { status: 'in_progress', output: [], usage: null });
    return emit('response.created', { response }) + emit('response.in_progress', { response });
  };

  const push = (event) => {
    if (closed || event?.kind === 'done') return '';
    if (event?.kind !== 'delta') return '';
    const before = agg.snapshot();
    agg.applyDelta(event.payload);
    const after = agg.snapshot();
    let out = '';
    if (after.reasoning.length > before.reasoning.length) {
      const delta = after.reasoning.slice(before.reasoning.length);
      if (!reasoningOpen) out += closeMessage() + openReasoning(delta, after.reasoningField);
      else {
        reasoningOpen.text += delta;
        reasoningOpen.field ||= after.reasoningField;
        out += emit('response.reasoning_summary_text.delta', {
          item_id: reasoningOpen.id, output_index: reasoningOpen.outputIndex, summary_index: 0, delta,
        });
      }
    }
    if (after.text.length > before.text.length) {
      const delta = after.text.slice(before.text.length);
      out += closeReasoning();
      if (!messageOpen) out += openMessage(delta);
      else {
        messageOpen.text += delta;
        out += emit('response.output_text.delta', {
          item_id: messageOpen.id, output_index: messageOpen.outputIndex, content_index: 0, delta,
        });
      }
    }
    if (after.tool_calls.length) {
      if (after.tool_calls.length > before.tool_calls.length || after.tool_calls.some((call, i) => call.function?.arguments?.length > (before.tool_calls[i]?.function?.arguments?.length || 0) || call.id !== before.tool_calls[i]?.id)) {
        out += closeReasoning();
        out += closeMessage();
      }
      after.tool_calls.forEach((call, index) => {
        const prev = before.tool_calls[index];
        let current = tools.get(index);
        if (!current) {
          current = { itemId: null, outputIndex: nextIndex++, id: call.id, name: call.function?.name || '', arguments: call.function?.arguments || '', opened: false };
          tools.set(index, current);
        } else {
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          current.arguments = call.function?.arguments || '';
        }
        const kind = originalToolType(current.name, ctx.toolMap);
        if (!current.itemId) {
          current.itemId = newId(kind === 'custom' ? 'ctc_' : kind === 'local_shell' ? 'lsc_' : kind === 'tool_search' ? 'tsc_' : 'fc_');
        }
        if ((kind !== 'function' && kind !== 'tool_search') || !current.name) return;
        const argDelta = current.arguments.slice((prev?.function?.arguments || '').length);
        if (!current.opened) {
          current.opened = true;
          const callIdMap = ctx.callIdMap || new Map();
          current.callId ||= boundCallId(current.id || newId('call_'), callIdMap);
          const itemType = kind === 'tool_search' ? 'tool_search_call' : 'function_call';
          out += emit('response.output_item.added', {
            output_index: current.outputIndex,
            item: { type: itemType, id: current.itemId, call_id: current.callId, name: current.name, arguments: '' },
          });
          if (current.arguments) {
            out += emit('response.function_call_arguments.delta', { item_id: current.itemId, output_index: current.outputIndex, delta: current.arguments });
          }
        } else if (argDelta) {
          out += emit('response.function_call_arguments.delta', { item_id: current.itemId, output_index: current.outputIndex, delta: argDelta });
        }
      });
    }
    return out;
  };

  const closeOpen = () => {
    let out = closeReasoning() + closeMessage();
    for (const [index, call] of [...tools.entries()].sort((a, b) => a[1].outputIndex - b[1].outputIndex)) {
      out += closeTool(call, index);
    }
    return out;
  };

  const hasVisibleOutput = (snap) => !!(
    snap.text || snap.reasoning || (snap.tool_calls && snap.tool_calls.length)
    || output.length || reasoningOpen || messageOpen || tools.size
  );

  const finish = () => {
    if (closed) return '';
    const snap = agg.snapshot();
    // Codex forbids empty response.completed ([DONE] alone is not success).
    if (!hasVisibleOutput(snap)) return fail('empty response');
    closed = true;
    let out = closeOpen();
    const finish = statusFromFinish(snap.finish_reason || 'stop');
    const response = responseObject(ctx, {
      status: finish.status,
      output,
      usage: snap.usage,
      incomplete_details: finish.incomplete_details,
    });
    out += emit(finish.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
    return out;
  };

  const fail = (error) => {
    if (closed) return '';
    closed = true;
    const message = typeof error === 'string' ? error : error?.message || error?.error?.message || 'upstream error';
    const code = error?.code || error?.type || 'upstream_error';
    const response = responseObject(ctx, {
      status: 'failed',
      output,
      usage: agg.snapshot().usage,
      error: { code: String(code), message: String(message) },
    });
    return closeOpen() + emit('response.failed', { response });
  };

  return {
    start,
    push,
    finish,
    fail,
    heartbeat: () => ': PING\n\n',
    get hasTerminal() { return !!agg.finishReason; },
    get hasOutput() { return hasVisibleOutput(agg.snapshot()); },
  };
}

export const responsesAdapter = {
  protocol: 'responses',
  toChat: responsesToChat,
  fromChat: chatToResponses,
  errorBody: responsesErrorBody,
  createStreamEncoder: createResponsesStreamEncoder,
};
