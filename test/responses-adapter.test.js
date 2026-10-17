import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, createChatSseReader, decodeReasoning, encodeReasoning } from '../lib/protocol-common.js';
import { chatToResponses, createResponsesStreamEncoder, responsesErrorBody, responsesToChat } from '../lib/responses-adapter.js';

function parseSse(text) {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim() || chunk.startsWith(':')) continue;
    const type = (chunk.match(/^event: (.+)$/m) || [])[1];
    const dataLine = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    events.push({ type, data: JSON.parse(dataLine) });
  }
  return events;
}

test('responsesToChat maps instructions, string input, tools and passthrough fields', () => {
  const { chatBody, ctx } = responsesToChat({
    model: 'cline-pass/glm-5.2',
    instructions: 'be brief',
    input: 'hello',
    max_output_tokens: 64,
    temperature: 0.2,
    prompt_cache_key: 'cache-1',
    parallel_tool_calls: true,
    stream: true,
    reasoning: { effort: 'minimal' },
    text: { format: { type: 'json_object' }, verbosity: 'high' },
    tools: [{ type: 'function', name: 'lookup', description: 'find', parameters: { type: 'object' }, strict: true }],
    tool_choice: 'auto',
    include: ['reasoning.encrypted_content'],
    metadata: { ignored: true },
  });
  assert.equal(chatBody.model, 'cline-pass/glm-5.2');
  assert.deepEqual(chatBody.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }]);
  assert.equal(chatBody.max_tokens, 64);
  assert.equal(chatBody.reasoning_effort, 'low');
  assert.deepEqual(chatBody.response_format, { type: 'json_object' });
  assert.equal(chatBody.stream, true);
  assert.equal(chatBody.stream_options.include_usage, true);
  assert.equal(chatBody.prompt_cache_key, 'cache-1');
  assert.equal(chatBody.tools[0].function.name, 'lookup');
  assert.equal(ctx.includeEncrypted, true);
});

test('responsesToChat maps function/custom/local_shell history and current-loop reasoning', () => {
  const token = encodeReasoning({ text: 'plan patch', field: 'reasoning_content' });
  const stale = encodeReasoning({ text: 'old thought', field: 'reasoning' });
  const { chatBody, ctx } = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'first' },
      { type: 'reasoning', encrypted_content: stale },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now' }, { type: 'input_image', image_url: 'https://ex.test/a.png' }] },
      { type: 'reasoning', encrypted_content: token },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: 'applied' },
      { type: 'local_shell_call', call_id: 'call_3', action: { type: 'exec', command: ['ls'], workdir: '/tmp' } },
      { type: 'local_shell_call_output', call_id: 'call_3', output: 'a.txt' },
    ],
    tools: [
      { type: 'custom', name: 'apply_patch', description: 'patch files', format: { type: 'grammar', definition: 'start: "x"' } },
      { type: 'local_shell' },
    ],
  });
  assert.equal(chatBody.messages[0].role, 'user');
  assert.equal(chatBody.messages[1].role, 'assistant');
  assert.equal(chatBody.messages[1].reasoning_content, undefined);
  assert.equal(chatBody.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(chatBody.messages[2].role, 'tool');
  const lastUser = chatBody.messages.find((m) => Array.isArray(m.content));
  assert.equal(lastUser.content[0].type, 'text');
  assert.equal(lastUser.content[1].type, 'image_url');
  const loopAssistant = chatBody.messages.find((m) => m.reasoning_content === 'plan patch');
  assert.ok(loopAssistant);
  assert.equal(loopAssistant.content, 'ok');
  assert.equal(loopAssistant.tool_calls[0].function.name, 'apply_patch');
  assert.equal(JSON.parse(loopAssistant.tool_calls[0].function.arguments).input, '*** Begin Patch');
  const shell = chatBody.messages.find((m) => m.tool_calls?.[0]?.function?.name === 'local_shell');
  assert.deepEqual(JSON.parse(shell.tool_calls[0].function.arguments).command, ['ls']);
  assert.equal(ctx.toolMap.get('apply_patch'), 'custom');
  assert.equal(chatBody.tools[0].function.parameters.properties.input.type, 'string');
  assert.match(chatBody.tools[0].function.description, /grammar/);
});

test('responsesToChat rejects unsupported fields, hosted tools, files and unpaired outputs', () => {
  const rejects = [
    [{ model: 'm', previous_response_id: 'resp_x' }, 'previous_response_id'],
    [{ model: 'm', conversation: 'c' }, 'conversation'],
    [{ model: 'm', background: true }, 'background'],
    [{ model: 'm', store: true }, 'store'],
    [{ model: 'm', context_management: {} }, 'context_management'],
    [{ model: 'm', prompt: { id: 'p' } }, 'prompt'],
    [{ model: 'm', input: [{ type: 'item_reference', id: 'x' }] }, 'item_reference'],
    [{ model: 'm', input: [{ type: 'mcp_call', name: 'x' }] }, 'mcp_call'],
    [{ model: 'm', tools: [{ type: 'web_search' }] }, 'tools[0].type'],
    [{ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }, 'input_file'],
    [{ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] }, 'file_id'],
    [{ model: 'm', input: [{ type: 'function_call', call_id: 'dup', name: 'a', arguments: '{}' }, { type: 'function_call', call_id: 'dup', name: 'b', arguments: '{}' }] }, 'call_id'],
    [{ model: 'm', tool_choice: { type: 'allowed_tools', tools: [] } }, 'tool_choice'],
  ];
  for (const [body, needle] of rejects) {
    assert.throws(() => responsesToChat(body), (err) => err instanceof AdapterError && err.status === 400 && `${err.message} ${err.param || ''}`.includes(needle));
  }
});

test('responsesToChat heals unanswered calls and orphan outputs', () => {
  const unanswered = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'message', role: 'user', content: 'next' },
    ],
  }).chatBody;
  const tool = unanswered.messages.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'c1');
  assert.match(tool.content, /interrupted/);

  const orphan = responsesToChat({
    model: 'm',
    input: [{ type: 'function_call_output', call_id: '', output: 'notice' }],
  }).chatBody;
  assert.ok(orphan.messages.some((m) => m.role === 'user' && String(m.content).includes('notice')));
});

test('chatToResponses builds text, tools, custom/local_shell, incomplete and null usage', () => {
  const ctx = responsesToChat({
    model: 'shown',
    input: 'hi',
    tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'local_shell' }, { type: 'function', name: 'lookup' }],
    include: ['reasoning.encrypted_content'],
  }).ctx;
  const mixed = chatToResponses({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'note',
        reasoning_content: 'think',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } },
          { id: 'c2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"patch"}' } },
          { id: 'c3', type: 'function', function: { name: 'local_shell', arguments: '{"command":["pwd"]}' } },
        ],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 } },
  }, ctx);
  assert.equal(mixed.object, 'response');
  assert.equal(mixed.model, 'shown');
  assert.equal(mixed.status, 'completed');
  assert.equal(mixed.output[0].type, 'reasoning');
  assert.equal(decodeReasoning(mixed.output[0].encrypted_content).text, 'think');
  assert.equal(mixed.output[1].content[0].type, 'output_text');
  assert.equal(mixed.output[2].type, 'function_call');
  assert.equal(mixed.output[3].type, 'custom_tool_call');
  assert.equal(mixed.output[3].input, 'patch');
  assert.equal(mixed.output[4].type, 'local_shell_call');
  assert.deepEqual(mixed.output[4].action.command, ['pwd']);
  assert.equal(mixed.usage.input_tokens, 10);
  assert.equal(mixed.usage.input_tokens_details.cached_tokens, 2);

  const length = chatToResponses({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }, ctx);
  assert.equal(length.status, 'incomplete');
  assert.equal(length.incomplete_details.reason, 'max_output_tokens');
  const none = chatToResponses({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }, ctx);
  assert.equal(none.usage, null);
});

test('Responses stream encoder emits monotonic sequence_numbers and complete output', () => {
  const ctx = responsesToChat({ model: 'shown', input: 'hi', include: ['reasoning.encrypted_content'] }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  const reader = createChatSseReader();
  let out = encoder.start();
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"why "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"now"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup","arguments":"{\\"a\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"other","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const chunk of chunks) for (const event of reader.push(chunk)) out += encoder.push(event);
  out += encoder.finish();
  const events = parseSse(out);
  const numbers = events.map((event) => event.data.sequence_number);
  assert.deepEqual(numbers, numbers.slice().sort((a, b) => a - b));
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(events[0].type, 'response.created');
  assert.equal(events[1].type, 'response.in_progress');
  const completed = events.at(-1);
  assert.equal(completed.type, 'response.completed');
  const output = completed.data.response.output;
  assert.equal(output[0].type, 'reasoning');
  assert.equal(output[1].type, 'message');
  assert.equal(output[1].content[0].text, 'Hello');
  assert.equal(output[2].arguments, '{"a":1}');
  assert.equal(output[3].name, 'other');
  assert.ok(output[0].encrypted_content);
  assert.equal(completed.data.response.usage.input_tokens, 3);
});

test('Responses stream encoder restores custom/local_shell at done and reports failures', () => {
  const ctx = responsesToChat({
    model: 'shown',
    input: 'hi',
    tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'local_shell' }],
  }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'apply_patch', arguments: '{"input":"x"}' } }] } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'local_shell', arguments: '{"command":["echo"]}' } }] }, finish_reason: 'tool_calls' }] } });
  out += encoder.finish();
  const events = parseSse(out);
  const completed = events.at(-1).data.response.output;
  assert.equal(completed[0].type, 'custom_tool_call');
  assert.equal(completed[0].input, 'x');
  assert.equal(completed[1].type, 'local_shell_call');
  assert.deepEqual(completed[1].action.command, ['echo']);
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.delta'));

  const failing = createResponsesStreamEncoder(ctx);
  const failed = parseSse(failing.start() + failing.fail({ message: 'boom', code: 'upstream_error' }));
  assert.equal(failed.at(-1).type, 'response.failed');
  assert.equal(failed.at(-1).data.response.error.message, 'boom');
  const incomplete = createResponsesStreamEncoder(ctx);
  let cut = incomplete.start();
  cut += incomplete.push({ kind: 'delta', payload: { choices: [{ delta: { content: 'part' }, finish_reason: 'length' }] } });
  cut += incomplete.finish();
  assert.equal(parseSse(cut).at(-1).type, 'response.incomplete');
});

test('Codex-shaped request fixture converts a two-turn tool loop', () => {
  const token = encodeReasoning({ text: 'need patch', field: 'reasoning_content' });
  const { chatBody } = responsesToChat({
    model: 'cline-pass/glm-5.2',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'user', content: 'fix the typo' },
      { type: 'reasoning', encrypted_content: token },
      { type: 'function_call', call_id: 'call_read', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_read', output: 'const x = 1' },
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1\n+const x = 2\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'ok' },
      { type: 'local_shell_call', call_id: 'call_sh', action: { type: 'exec', command: ['git', 'diff'], workdir: '/repo' } },
      { type: 'local_shell_call_output', call_id: 'call_sh', output: 'diff' },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'reasoning', encrypted_content: token },
    ],
    tools: [
      { type: 'function', name: 'read_file', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply_patch' },
      { type: 'local_shell' },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'medium' },
    store: false,
    stream: true,
  });
  assert.equal(chatBody.messages[0].content, 'You are Codex.');
  assert.equal(chatBody.messages.some((m) => m.role === 'user' && m.content === 'continue'), true);
  assert.equal(chatBody.messages.at(-1).reasoning_content, 'need patch');
  assert.equal(chatBody.tools.length, 3);
});

test('Responses stream does not emit function_call items for delayed custom tool names', () => {
  const ctx = responsesToChat({
    model: 'shown',
    input: 'hi',
    tools: [{ type: 'custom', name: 'apply_patch' }],
  }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{"in' } }] } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'apply_patch', arguments: 'put":"x"}' } }] }, finish_reason: 'tool_calls' }] } });
  out += encoder.finish();
  const events = parseSse(out);
  assert.equal(events.filter((event) => event.data.item?.type === 'function_call').length, 0);
  assert.equal(events.at(-1).data.response.output[0].type, 'custom_tool_call');
  assert.equal(events.at(-1).data.response.output[0].input, 'x');
});

test('consecutive reasoning items in the current loop are all returned upstream', () => {
  const a = encodeReasoning({ text: 'first ', field: 'reasoning_content' });
  const b = encodeReasoning({ text: 'second', field: 'reasoning_content' });
  const { chatBody } = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'go' },
      { type: 'reasoning', summary: [], encrypted_content: a },
      { type: 'reasoning', summary: [], encrypted_content: b },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  });
  assert.equal(chatBody.messages.find((m) => m.role === 'assistant').reasoning_content, 'first second');
});

test('Responses stream keeps one call_id when the upstream id arrives late', () => {
  const ctx = responsesToChat({ model: 'm', input: 'hi', tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }] }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{' } }] } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'real', function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] } });
  out += encoder.finish();
  const events = parseSse(out);
  const added = events.find((event) => event.type === 'response.output_item.added' && event.data.item.type === 'function_call');
  const done = events.find((event) => event.type === 'response.output_item.done' && event.data.item.type === 'function_call');
  assert.equal(done.data.item.call_id, added.data.item.call_id);
  assert.equal(events.at(-1).data.response.output[0].call_id, added.data.item.call_id);
});

test('Responses stream closes the message before late reasoning', () => {
  const ctx = responsesToChat({ model: 'm', input: 'hi' }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  let out = encoder.start();
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { content: 'A' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: { reasoning_content: 'late' } }] } });
  out += encoder.push({ kind: 'delta', payload: { choices: [{ delta: {}, finish_reason: 'stop' }] } });
  out += encoder.finish();
  const events = parseSse(out);
  const messageDone = events.findIndex((event) => event.type === 'response.output_item.done' && event.data.item.type === 'message');
  const reasoningAdded = events.findIndex((event) => event.type === 'response.output_item.added' && event.data.item.type === 'reasoning');
  assert.ok(messageDone >= 0 && messageDone < reasoningAdded);
});

test('responsesErrorBody keeps OpenAI envelope fields', () => {
  assert.deepEqual(responsesErrorBody(401, { message: 'unauthorized', type: 'auth_error' }).error.type, 'auth_error');
  assert.equal(responsesErrorBody(400, { message: 'bad', param: 'store' }).error.param, 'store');
});

test('Responses stream finish rejects empty completed ([DONE] alone)', () => {
  const ctx = responsesToChat({ model: 'm', input: 'hi' }).ctx;
  const encoder = createResponsesStreamEncoder(ctx);
  const events = parseSse(encoder.start() + encoder.finish());
  assert.equal(events.at(-1).type, 'response.failed');
  assert.match(events.at(-1).data.response.error.message, /empty response/i);
  assert.equal(encoder.hasOutput, false);
});

test('tool_search degrades to Chat function and round-trips', () => {
  const { chatBody, ctx } = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: 'find' },
      { type: 'tool_search_call', call_id: 'c1', name: 'tool_search', arguments: '{"query":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: '[]' },
    ],
    tools: [{ type: 'tool_search' }],
  });
  assert.equal(chatBody.tools[0].function.name, 'tool_search');
  assert.equal(chatBody.messages.find((m) => m.role === 'assistant').tool_calls[0].function.name, 'tool_search');
  const out = chatToResponses({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'tool_search', arguments: '{"query":"x"}' } }],
      },
    }],
  }, ctx);
  assert.equal(out.output[0].type, 'tool_search_call');
  assert.match(out.output[0].id, /^tsc_/);
});

test('responsesToChat mints missing call_id and bounds long ids', () => {
  const long = `call_${'z'.repeat(80)}`;
  const { chatBody } = responsesToChat({
    model: 'm',
    input: [
      { type: 'function_call', name: 'f', arguments: '{}' },
      { type: 'function_call', call_id: long, name: 'g', arguments: '{}' },
      { type: 'function_call_output', call_id: long, output: 'ok' },
    ],
  });
  const assistant = chatBody.messages.find((m) => m.role === 'assistant');
  assert.match(assistant.tool_calls[0].id, /^call_/);
  assert.ok(assistant.tool_calls[1].id.length <= 64);
  const tools = chatBody.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2);
  assert.match(tools[0].content, /interrupted/);
  assert.equal(tools[0].tool_call_id, assistant.tool_calls[0].id);
  assert.equal(tools[1].tool_call_id, assistant.tool_calls[1].id);
  assert.equal(tools[1].content, 'ok');
});
