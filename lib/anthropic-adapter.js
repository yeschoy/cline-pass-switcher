import {
  AdapterError, createChatAggregator, decodeReasoning, encodeReasoning, extractReasoning,
  isPlainObject, joinTextParts, mapChatUsage, newId, requireObject, sseEvent, unwrapChatPayload,
} from './protocol-common.js';

function fail(message, param) {
  throw new AdapterError(message, { param });
}

function anthropicErrorType(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 503 || status === 529) return 'overloaded_error';
  return 'api_error';
}

function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => {
    if (typeof block === 'string') return block;
    if (isPlainObject(block) && (block.type === 'text' || !block.type) && typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

function imagePart(block, param) {
  const source = block.source;
  if (!isPlainObject(source) || typeof source.type !== 'string') fail('image source is required', param);
  if (source.type === 'base64') {
    const media = source.media_type || 'image/png';
    const data = source.data;
    if (typeof data !== 'string' || !data) fail('image base64 data is required', param);
    return { type: 'image_url', image_url: { url: `data:${media};base64,${data}` } };
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || !source.url) fail('image url is required', param);
    return { type: 'image_url', image_url: { url: source.url } };
  }
  fail(`unsupported image source ${source.type}`, param);
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content;
}

function toolResultText(block) {
  const prefix = block.is_error === true ? '[tool error] ' : '';
  const body = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
    ? block.content.map((part) => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('')
    : block.content == null ? '' : String(block.content);
  return prefix + body;
}

function toolResultImages(block) {
  if (!Array.isArray(block.content)) return [];
  return block.content.filter((part) => part?.type === 'image').map((part, index) => imagePart(part, `tool_result.image[${index}]`));
}

function convertUserContent(content, param) {
  const blocks = contentBlocks(content);
  const tools = [];
  const rest = [];
  for (const [index, block] of blocks.entries()) {
    if (typeof block === 'string') { rest.push({ type: 'text', text: block }); continue; }
    if (!isPlainObject(block) || typeof block.type !== 'string') fail('invalid content block', `${param}[${index}]`);
    if (block.type === 'tool_result') {
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : fail('tool_result requires tool_use_id', `${param}[${index}].tool_use_id`);
      tools.push({ role: 'tool', tool_call_id: id, content: toolResultText(block) });
      rest.push(...toolResultImages(block).map((part) => ({ kind: 'image', part })));
    } else if (block.type === 'text') rest.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' });
    else if (block.type === 'image') rest.push({ kind: 'image', part: imagePart(block, `${param}[${index}]`) });
    else if (block.type === 'document' || block.type === 'search_result' || block.type === 'container_upload') {
      fail(`${block.type} blocks are not supported`, `${param}[${index}].type`);
    } else fail(`unsupported content block ${block.type}`, `${param}[${index}].type`);
  }
  const userParts = [];
  for (const item of rest) {
    if (item.kind === 'image') userParts.push(item.part);
    else if (item.type === 'text' && item.text) userParts.push(item);
  }
  const messages = [...tools];
  if (userParts.length) {
    const onlyText = userParts.every((part) => part.type === 'text');
    messages.push({ role: 'user', content: onlyText ? userParts.map((part) => part.text).join('') : userParts });
  }
  return messages;
}

function convertAssistant(content, { allowThinking }) {
  const blocks = contentBlocks(content);
  let text = '';
  let reasoning = null;
  const toolCalls = [];
  for (const [index, block] of blocks.entries()) {
    if (typeof block === 'string') { text += block; continue; }
    if (!isPlainObject(block) || typeof block.type !== 'string') fail('invalid assistant block', `content[${index}]`);
    if (block.type === 'text') text += typeof block.text === 'string' ? block.text : '';
    else if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : fail('tool_use requires id', `content[${index}].id`);
      const name = typeof block.name === 'string' ? block.name : fail('tool_use requires name', `content[${index}].name`);
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === 'thinking') {
      if (allowThinking) {
        const decoded = decodeReasoning(block.signature);
        if (decoded) reasoning = decoded;
      }
    } else if (block.type === 'redacted_thinking') continue;
    else fail(`unsupported assistant block ${block.type}`, `content[${index}].type`);
  }
  const message = { role: 'assistant', content: text };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    if (!text) message.content = null;
  }
  if (reasoning) message[reasoning.field] = reasoning.text;
  return message;
}

function userHasNonToolContent(message) {
  if (message?.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  return contentBlocks(message.content).some((block) => block?.type !== 'tool_result');
}

function convertTools(tools) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) fail('tools must be an array', 'tools');
  return tools.map((tool, index) => {
    if (!isPlainObject(tool)) fail('invalid tool', `tools[${index}]`);
    const type = tool.type == null ? 'custom' : tool.type;
    if (type !== 'custom') fail(`server tool type ${type} is not supported`, `tools[${index}].type`);
    if (typeof tool.name !== 'string' || !tool.name) fail('tool requires name', `tools[${index}].name`);
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    };
  });
}

function convertToolChoice(value, disableParallel) {
  const out = {};
  if (value == null || value === 'auto' || value?.type === 'auto') out.tool_choice = 'auto';
  else if (value === 'any' || value?.type === 'any') out.tool_choice = 'required';
  else if (value === 'none' || value?.type === 'none') out.tool_choice = 'none';
  else if (value?.type === 'tool' && typeof value.name === 'string') out.tool_choice = { type: 'function', function: { name: value.name } };
  else if (value != null) fail('unsupported tool_choice', 'tool_choice');
  if (disableParallel === true) out.parallel_tool_calls = false;
  return out;
}

function convertThinking(thinking) {
  if (!isPlainObject(thinking) || thinking.type !== 'enabled') return undefined;
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget)) return 'medium';
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'medium';
  return 'high';
}

export function anthropicToChat(body) {
  requireObject(body, 'request body must be an object');
  if (Array.isArray(body.mcp_servers) && body.mcp_servers.length) fail('mcp_servers is not supported', 'mcp_servers');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 300) fail('valid model is required', 'model');
  if (!Array.isArray(body.messages)) fail('messages must be an array', 'messages');

  let lastLoopUser = -1;
  for (let i = 0; i < body.messages.length; i++) if (userHasNonToolContent(body.messages[i])) lastLoopUser = i;

  const messages = [];
  const sys = systemText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const [index, message] of body.messages.entries()) {
    if (!isPlainObject(message) || typeof message.role !== 'string') fail('invalid message', `messages[${index}]`);
    if (message.role === 'user') messages.push(...convertUserContent(message.content, `messages[${index}].content`));
    else if (message.role === 'assistant') messages.push(convertAssistant(message.content, { allowThinking: index > lastLoopUser }));
    else fail(`unsupported role ${message.role}`, `messages[${index}].role`);
  }

  const chatBody = { model, messages };
  const tools = convertTools(body.tools);
  if (tools) chatBody.tools = tools;
  Object.assign(chatBody, convertToolChoice(body.tool_choice, body.tool_choice?.disable_parallel_tool_use ?? body.disable_parallel_tool_use));
  for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k']) if (body[key] !== undefined) chatBody[key] = body[key];
  if (Array.isArray(body.stop_sequences)) chatBody.stop = body.stop_sequences;
  const effort = convertThinking(body.thinking);
  if (effort) chatBody.reasoning_effort = effort;
  if (body.stream === true) {
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };
  }

  const identityHints = {};
  if (typeof body.metadata?.user_id === 'string' && body.metadata.user_id) {
    identityHints.metadata = { user_id: body.metadata.user_id };
  }
  return {
    chatBody,
    identityHints,
    ctx: {
      model,
      messageId: newId('msg_'),
      stopSequences: Array.isArray(body.stop_sequences) ? body.stop_sequences : [],
    },
  };
}

function parseToolInput(args) {
  try { return JSON.parse(args || '{}'); } catch { return args || {}; }
}

function stopReasonFrom(finish, text = '') {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop') return 'end_turn';
  return finish ? 'end_turn' : 'end_turn';
}

function usageFromChat(usage) {
  const mapped = mapChatUsage(usage);
  if (!mapped) return { input_tokens: 0, output_tokens: 0 };
  const cached = Number.isFinite(mapped.cached) ? mapped.cached : 0;
  const out = {
    input_tokens: Math.max(0, mapped.input - (Number.isFinite(mapped.cached) ? mapped.cached : 0)),
    output_tokens: mapped.output,
  };
  if (mapped.cached != null) out.cache_read_input_tokens = cached;
  return out;
}

function contentFromSnapshot(snapshot, { withSignature = false } = {}) {
  const content = [];
  if (snapshot.reasoning) {
    const block = { type: 'thinking', thinking: snapshot.reasoning };
    if (withSignature) block.signature = encodeReasoning({ text: snapshot.reasoning, field: snapshot.reasoningField || 'reasoning_content' });
    content.push(block);
  }
  if (snapshot.text) content.push({ type: 'text', text: snapshot.text });
  for (const call of snapshot.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: call.id || newId('toolu_'),
      name: call.function?.name || '',
      input: parseToolInput(call.function?.arguments || '{}'),
    });
  }
  return content;
}

export function chatToAnthropic(chatJson, ctx) {
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
  return {
    id: ctx.messageId,
    type: 'message',
    role: 'assistant',
    model: ctx.model,
    content: contentFromSnapshot(snapshot, { withSignature: true }),
    stop_reason: stopReasonFrom(snapshot.finish_reason, snapshot.text),
    stop_sequence: null,
    usage: usageFromChat(snapshot.usage),
  };
}

export function anthropicErrorBody(status, err = {}) {
  const error = typeof err === 'string' ? { message: err } : (err || {});
  return { type: 'error', error: { type: anthropicErrorType(status), message: String(error.message || 'error') } };
}

export function createAnthropicStreamEncoder(ctx) {
  const agg = createChatAggregator();
  let started = false;
  let closed = false;
  let thinkingOpen = null;
  let textOpen = null;
  let nextIndex = 0;
  const emit = (type, data) => sseEvent(type, { type, ...data });

  const closeThinking = () => {
    if (!thinkingOpen) return '';
    const index = thinkingOpen.index;
    const signature = encodeReasoning({ text: thinkingOpen.text, field: thinkingOpen.field || 'reasoning_content' });
    thinkingOpen = null;
    return emit('content_block_delta', { index, delta: { type: 'signature_delta', signature } })
      + emit('content_block_stop', { index });
  };

  const closeText = () => {
    if (!textOpen) return '';
    const index = textOpen.index;
    textOpen = null;
    return emit('content_block_stop', { index });
  };

  // Anthropic allows one open block at a time, and Chat may interleave tool deltas
  // or send the name late, so tool_use blocks are emitted whole at the end.
  const emitTools = (toolCalls) => {
    let out = '';
    for (const call of toolCalls || []) {
      const index = nextIndex++;
      const args = call.function?.arguments || '';
      out += emit('content_block_start', { index, content_block: { type: 'tool_use', id: call.id || newId('toolu_'), name: call.function?.name || '', input: {} } });
      if (args) out += emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: args } });
      out += emit('content_block_stop', { index });
    }
    return out;
  };

  const start = () => {
    if (started) return '';
    started = true;
    return emit('message_start', {
      message: {
        id: ctx.messageId,
        type: 'message',
        role: 'assistant',
        model: ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
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
      if (!thinkingOpen) {
        out += closeText();
        thinkingOpen = { index: nextIndex++, text: delta, field: after.reasoningField };
        out += emit('content_block_start', { index: thinkingOpen.index, content_block: { type: 'thinking', thinking: '' } });
      } else thinkingOpen.text += delta;
      out += emit('content_block_delta', { index: thinkingOpen.index, delta: { type: 'thinking_delta', thinking: delta } });
    }
    if (after.text.length > before.text.length) {
      const delta = after.text.slice(before.text.length);
      out += closeThinking();
      if (!textOpen) {
        textOpen = { index: nextIndex++, text: delta };
        out += emit('content_block_start', { index: textOpen.index, content_block: { type: 'text', text: '' } });
      } else textOpen.text += delta;
      out += emit('content_block_delta', { index: textOpen.index, delta: { type: 'text_delta', text: delta } });
    }
    return out;
  };

  const finish = () => {
    if (closed) return '';
    closed = true;
    const snap = agg.snapshot();
    const usage = usageFromChat(snap.usage);
    return closeThinking() + closeText() + emitTools(snap.tool_calls)
      + emit('message_delta', {
        delta: { stop_reason: stopReasonFrom(snap.finish_reason || 'stop'), stop_sequence: null },
        usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens, ...(usage.cache_read_input_tokens != null ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}) },
      })
      + emit('message_stop', {});
  };

  const fail = (error) => {
    if (closed) return '';
    closed = true;
    const message = typeof error === 'string' ? error : error?.message || error?.error?.message || 'upstream error';
    return emit('error', anthropicErrorBody(502, { message }));
  };

  return {
    start,
    push,
    finish,
    fail,
    heartbeat: () => sseEvent('ping', { type: 'ping' }),
    get hasTerminal() { return !!agg.finishReason; },
  };
}

export const anthropicAdapter = {
  protocol: 'anthropic',
  toChat: anthropicToChat,
  fromChat: chatToAnthropic,
  errorBody: anthropicErrorBody,
  createStreamEncoder: createAnthropicStreamEncoder,
};
