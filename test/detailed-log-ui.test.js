import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const page = (requestId) => ({ items: [{ requestId, ts: 1, model: '<model>', accounts: ['<account>'], status: 200, state: 'complete', attemptCount: 1 }], nextCursor: null, health: { failures: 0, dropped: 0, corrupt: 0 } });
function harness() {
  const elements = new Map(), calls = [], copies = [], confirmations = [];
  const el = (id) => { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, disabled: false, textContent: '', innerHTML: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { this.focused = true; }, select() { this.selected = true; }, remove() {} }); return elements.get(id); };
  const windowHandlers = {};
  const context = vm.createContext({ AbortController, window: { addEventListener(type, fn) { windowHandlers[type] = fn; }, dispatch(type) { windowHandlers[type]?.(); } }, document: { querySelector: el, addEventListener() {} }, localStorage: { getItem: () => '' }, fetch: () => new Promise(() => {}), setTimeout() {}, clearTimeout() {}, confirm: (message) => { confirmations.push(message); return context.confirmResult !== false; }, URL, URLSearchParams, navigator: { clipboard: { async writeText(text) { copies.push(text); } } } });
  const run = (code) => vm.runInContext(code, context); run(script);
  context.realApi = run('api');
  context.handler = async () => page('row');
  context.call = (...args) => { calls.push(args); return context.handler(...args); };
  run('api=(...args)=>call(...args)');
  run("ACCS={accounts:[{id:'draft',name:'Draft',key:'not submitted',maxConcurrent:9}],active:0};BULK_SELECTION.add(ACCS.accounts[0]);RAW_SCHEDULING={text:'unapplied raw draft'};$('#accMode').value='sticky';ERROR_RULE_DRAFT={statusRules:{'418':{action:'ban'}},contentRules:[{contains:'pending',action:'ignore'}]};ERROR_RULE_GENERATION=1;ADVANCED_ERROR_RULES={generation:1,text:'{}',dirty:true};$('#advancedErrorRulesJson').value='invalid pending JSON';");
  const drafts = () => run("JSON.stringify([ACCS,[...BULK_SELECTION],RAW_SCHEDULING,$('#accMode').value,ERROR_RULE_DRAFT,$('#advancedErrorRulesJson').value])");
  return { context, run, el, calls, copies, confirmations, drafts };
}

test('detailed health renders fixed nonzero reasons with safe old-server fallback and stale-read guards', async () => {
  const h = harness(), before = h.drafts(); h.el('#detailsPanel').hidden = false;
  const reasons = { ...h.run('Object.fromEntries(Object.keys(DETAIL_DROP_LABELS).map(key=>[key,0]))'), captureBudget: 2, storeQueue: 1, '<script>': 10 };
  h.context.handler = async () => ({ ...page('row'), health: { dropped: 3, failures: 0, corrupt: 0, dropReasons: reasons } });
  await h.run('loadDetails()');
  assert.match(h.el('#detailsDropReasons').textContent, /本进程启动以来.*3 次.*捕获内存预算 2.*发布队列／关闭 1/);
  assert.equal(h.el('#detailsDropReasons').innerHTML, '');
  assert.doesNotMatch(h.el('#detailsDropReasons').textContent, /<script>|其他限制/);
  h.context.handler = async () => page('legacy'); await h.run('loadDetails()');
  assert.match(h.el('#detailsDropReasons').textContent, /原因暂不可用/);
  h.context.handler = async () => ({ ...page('bad'), health: { dropped: 2, failures: 0, corrupt: 0, dropReasons: { ...reasons, captureBudget: '<img>', storeQueue: Number.MAX_SAFE_INTEGER + 1 } } });
  await h.run('loadDetails()'); assert.match(h.el('#detailsDropReasons').textContent, /原因暂不可用/);
  assert.doesNotMatch(h.el('#detailsDropReasons').textContent, /img|9007199254740992/);
  const old = deferred(); h.context.handler = () => old.promise;
  const pending = h.run('loadDetails()'); await h.run("switchSection('console')"); old.resolve({ ...page('stale'), health: { dropped: 999, dropReasons: reasons } }); await pending;
  assert.doesNotMatch(h.el('#detailsDropReasons').textContent, /999/);
  assert.equal(h.drafts(), before);
});

test('five sections, toggle and detail reads preserve all account/bulk/raw draft owners', async () => {
  const h = harness(), before = h.drafts(); let settings = { detailedLogging: false, errorDetailLogging: false, rawBodyLogging: false, authRequired: true };
  h.context.handler = async (path, body) => { if (!path.includes('settings')) return page('row'); if (body) settings = { ...settings, ...body }; return settings; };
  await h.run("switchSection('details')");
  assert.equal(h.el('#detailsPanel').hidden, false);
  for (const id of ['#consolePanel', '#statisticsPanel', '#logPanel']) assert.equal(h.el(id).hidden, true);
  assert.equal(h.el('#navDetails').attrs['aria-pressed'], 'true'); assert.match(h.el('#detailsAuth').textContent, /独立管理员会话认证/);
  h.el('#detailedLogging').checked = true; await h.run('toggleDetailedLogging()');
  assert.equal(h.el('#detailedLogging').checked, true); h.el('#errorDetailLogging').checked = true; await h.run('toggleErrorDetailLogging()'); assert.equal(h.el('#errorDetailLogging').checked, true);
  h.el('#rawBodyLogging').checked = true; await h.run('toggleRawBodyLogging()'); assert.equal(h.el('#rawBodyLogging').checked, true); assert.equal(h.confirmations.length, 1); assert.equal(h.drafts(), before);
  assert.ok(h.calls.every(([path]) => path.startsWith('/api/logs/')));
  await h.run("switchSection('console')"); assert.equal(h.el('#detailsPanel').hidden, true); assert.equal(h.el('#consolePanel').hidden, false);
});

test('raw enable confirmation precedes every off-to-on write; cancellation and failure never opt in', async () => {
  const h = harness(), before = h.drafts(); h.el('#detailsPanel').hidden = false;
  let settings = { detailedLogging: true, errorDetailLogging: true, rawBodyLogging: false, rawBodyAvailable: true };
  h.context.handler = async (path, body) => { if (body) settings = { ...settings, ...body }; return settings; };
  await h.run('loadDetailSettings()'); h.context.confirmResult = false;
  const initial = h.calls.length; h.el('#rawBodyLogging').focus(); h.el('#rawBodyLogging').checked = true; await h.run('toggleRawBodyLogging()');
  assert.equal(h.calls.length, initial); assert.equal(h.el('#rawBodyLogging').checked, false); assert.equal(h.el('#rawBodyLogging').focused, true);
  assert.match(h.el('#detailsStatus').textContent, /已取消启用/);
  h.context.confirmResult = true; h.el('#rawBodyLogging').checked = true; await h.run('toggleRawBodyLogging()');
  assert.equal(h.calls.length, initial + 1); assert.equal(h.calls.at(-1)[1].rawBodyLogging, true);
  assert.equal(h.confirmations.length, 2);
  h.el('#rawBodyLogging').checked = false; await h.run('toggleRawBodyLogging()');
  assert.equal(h.confirmations.length, 2);
  h.context.handler = async (path, body) => body ? { error: { message: 'fixture persist failure' } } : settings;
  h.el('#rawBodyLogging').checked = true; await h.run('toggleRawBodyLogging()');
  assert.equal(h.confirmations.length, 3); assert.equal(h.el('#rawBodyLogging').checked, false);
  assert.equal(h.drafts(), before);
});

test('a confirmed raw setting write that finishes after navigation updates state without a stale status', async () => {
  const h = harness(), saved = deferred(); h.el('#detailsPanel').hidden = false;
  h.context.handler = (path, body) => body ? saved.promise : Promise.resolve({ detailedLogging: true, errorDetailLogging: true, rawBodyLogging: false, rawBodyAvailable: true });
  await h.run('loadDetailSettings()'); h.el('#rawBodyLogging').checked = true;
  const pending = h.run('toggleRawBodyLogging()');
  assert.equal(h.calls.at(-1)[1].rawBodyLogging, true);
  assert.equal(h.el('#rawBodyLogging').disabled, true);
  await h.run("switchSection('console')");
  saved.resolve({ detailedLogging: true, errorDetailLogging: true, rawBodyLogging: true }); await pending;
  assert.equal(h.run('RAW_BODY_CONFIRMED'), true);
  assert.equal(h.el('#rawBodyLogging').checked, true);
  assert.doesNotMatch(h.el('#detailsStatus').textContent, /设置已保存/);
  assert.equal(h.confirmations.length, 1);
});

test('unavailable raw runtime disables opt-in without mutating drafts or sending a write', async () => {
  const h = harness(), before = h.drafts(); h.el('#detailsPanel').hidden = false;
  h.context.handler = async () => ({ detailedLogging: true, errorDetailLogging: false, rawBodyLogging: false, rawBodyAvailable: false });
  await h.run('loadDetailSettings()');
  assert.equal(h.el('#rawBodyLogging').disabled, true);
  assert.equal(h.el('#detailedLogging').disabled, false);
  assert.match(h.el('#detailsRawAvailability').textContent, /当前运行条件不允许启用原文/);
  const count = h.calls.length; h.el('#rawBodyLogging').checked = true; await h.run('toggleRawBodyLogging()');
  assert.equal(h.calls.length, count); assert.equal(h.el('#rawBodyLogging').checked, false);
  assert.equal(h.drafts(), before);
});

test('stale settings/list/selection/body reads cannot overwrite newer state; copied content comes only from body API', async () => {
  const h = harness(), first = deferred(), second = deferred();
  let count = 0; h.context.handler = () => (++count === 1 ? first.promise : second.promise);
  const old = h.run('loadDetails()'), current = h.run('loadDetails()'); second.resolve(page('new<&')); await current; first.resolve(page('old')); await old;
  assert.match(h.el('#detailsList').innerHTML, /new&lt;&amp;/); assert.doesNotMatch(h.el('#detailsList').innerHTML, /old|<model>|<account>/);
  const group = (id) => ({ request: { requestId: id, requestBody: 'input', responseBody: 'output', headers: { ordinary: '<script>text</script>' } }, attempts: [], bodies: [{ bodyId: 'output', state: 'complete', observedBytes: 8, capturedBytes: 8 }] });
  const oldGroup = deferred(), newGroup = deferred(); count = 0; h.context.handler = () => (++count === 1 ? oldGroup.promise : newGroup.promise);
  const a = h.run("selectDetail('a')"), b = h.run("selectDetail('b')"); newGroup.resolve(group('b')); await b; oldGroup.resolve(group('a')); await a;
  assert.equal(JSON.parse(h.el('#detailsMetadata').textContent).request.requestId, 'b'); assert.equal(h.el('#detailsMetadata').innerHTML, '');
  const bodyA = deferred(), bodyB = deferred(); count = 0; h.context.handler = () => (++count === 1 ? bodyA.promise : bodyB.promise);
  const pendingA = h.run("loadDetailBody('b','output','complete')"), pendingB = h.run("loadDetailBody('b','output','complete')");
  await h.run('copyDetailBody()'); assert.deepEqual(h.copies, []);
  bodyB.resolve('<script>sanitized text</script>'); await pendingB; bodyA.resolve('stale'); await pendingA;
  assert.equal(h.el('#detailsText').value, '<script>sanitized text</script>'); assert.equal(h.el('#detailsText').innerHTML, '');
  await h.run('copyDetailBody()'); assert.deepEqual(h.copies, ['<script>sanitized text</script>']);
  h.context.navigator.clipboard.writeText = async () => { throw Error('denied'); }; await h.run('copyDetailBody()');
  assert.equal(h.el('#detailsText').focused, true); assert.equal(h.el('#detailsText').selected, true);
  assert.match(h.el('#detailsStatus').textContent, /复制失败/);
  h.el('#detailsPanel').hidden = false; await h.run("switchSection('console')");
  assert.equal(h.el('#detailsText').value, ''); assert.equal(h.run('DETAIL_BODY_TEXT'), null);
});

test('raw body warning and session loss clear loaded text without touching account drafts', async () => {
  const h = harness(), before = h.drafts(); h.el('#detailsPanel').hidden = false;
  h.context.handler = async (route) => route.includes('/bodies/') ? 'fixture raw body key' : { request: { requestId: 'root', profile: 'raw-full', requestBody: 'body' }, attempts: [], bodies: [{ bodyId: 'body', state: 'complete', capturedBytes: 20, observedBytes: 20, redacted: false }] };
  await h.run("selectDetail('root')"); assert.match(h.el('#detailsBodyWarning').textContent, /Header.*未脱敏.*密钥/);
  await h.run("loadDetailBody('root','body','complete')"); assert.equal(h.el('#detailsText').value, 'fixture raw body key');
  assert.equal(h.run('DETAIL_BODY_RAW'), true);
  h.run('showLogin()'); assert.equal(h.el('#detailsText').value, ''); assert.equal(h.run('DETAIL_BODY_TEXT'), null); assert.equal(h.el('#detailsCopy').disabled, true);
  assert.equal(h.drafts(), before);
});

test('toggle failures restore confirmed state, pending reads cannot undo a save, and stale clear does not reload', async () => {
  const h = harness(), before = h.drafts();
  h.context.handler = async () => ({ error: { message: 'mock failure' } }); h.el('#detailedLogging').checked = true; h.el('#rawBodyLogging').checked = true;
  await h.run('toggleDetailedLogging()'); assert.equal(h.el('#detailedLogging').checked, false); assert.equal(h.el('#rawBodyLogging').checked, false); assert.equal(h.el('#detailedLogging').disabled, false);
  const get = deferred(), post = deferred(); h.context.handler = (path, body) => body ? post.promise : get.promise;
  const pendingRead = h.run('loadDetailSettings()'); h.el('#detailedLogging').checked = true; const pendingSave = h.run('toggleDetailedLogging()');
  assert.equal(h.el('#detailedLogging').disabled, true); post.resolve({ detailedLogging: true }); await pendingSave;
  get.resolve({ detailedLogging: false, authRequired: true }); await pendingRead; assert.equal(h.el('#detailedLogging').checked, true);
  const clear = deferred(); h.context.handler = () => clear.promise; h.calls.length = 0;
  const pendingClear = h.run('clearDetails()'); await h.run("switchSection('console')"); clear.resolve({ ok: true }); await pendingClear;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/api/logs/details'); assert.equal(h.calls[0][2], 'DELETE');
  assert.equal(h.drafts(), before);
});

test('error rows require exact attempt index and call id before exposing one response body', async () => {
  const h = harness(); h.el('#detailsPanel').hidden = false;
  const callId = '11111111-1111-4111-8111-111111111111';
  const group = { request: { requestId: 'root', profile: 'error' }, attempts: [
    { attemptIndex: 0, callId: '22222222-2222-4222-8222-222222222222', captureState: 'response-error', responseBody: 'other' },
    { attemptIndex: 1, callId, captureState: 'stream-transport-failed' },
  ], bodies: [{ bodyId: 'other', state: 'complete', capturedBytes: 3, observedBytes: 3 }] };
  h.context.handler = async () => group;
  await h.run(`selectDetail('root',{attemptIndex:1,callId:${JSON.stringify(callId)}})`);
  const projected = JSON.parse(h.el('#detailsMetadata').textContent); assert.equal(projected.attempts.length, 1); assert.equal(projected.attempts[0].callId, callId); assert.equal(projected.bodies.length, 0);
  assert.match(h.el('#detailsStatus').textContent, /起流后传输失败/); assert.equal(h.el('#detailsMetadata').focused, true);
  await h.run(`selectDetail('root',{attemptIndex:0,callId:${JSON.stringify(callId)}})`);
  assert.match(h.el('#detailsMetadata').textContent, /关联校验失败/); assert.equal(h.el('#detailsBodies').innerHTML, '');
  h.context.handler = async () => ({ request: { ...group.request, profile: 'raw-error' }, attempts: [group.attempts[0], { attemptIndex: 1, callId, captureState: 'response-error', requestBody: 'failed-input', responseBody: 'failed-output' }], bodies: [group.bodies[0], { bodyId: 'failed-input', state: 'complete', capturedBytes: 2, observedBytes: 2 }, { bodyId: 'failed-output', state: 'complete', capturedBytes: 3, observedBytes: 3 }] });
  await h.run(`selectDetail('root',{attemptIndex:1,callId:${JSON.stringify(callId)}})`);
  const raw = JSON.parse(h.el('#detailsMetadata').textContent);
  assert.deepEqual(Array.from(raw.bodies, (body) => body.bodyId), ['failed-input', 'failed-output']);
  assert.equal(h.el('#detailsBodies').innerHTML.includes('other'), false);
  h.context.handler = async () => ({ ...group, attempts: [{ attemptIndex: 1, callId }, { attemptIndex: 1, callId }] });
  await h.run(`selectDetail('root',{attemptIndex:1,callId:${JSON.stringify(callId)}})`); assert.match(h.el('#detailsMetadata').textContent, /不唯一/);
  h.context.handler = async () => ({ error: { message: 'detailed record unavailable' } });
  await h.run(`selectDetail('missing',{attemptIndex:1,callId:${JSON.stringify(callId)}})`);
  assert.equal(h.el('#detailsMetadata').textContent, '详情不可用（已过期、已清空、被容量边界丢弃或发布失败）');
  assert.match(h.run("errorDetailAction({requestId:'33333333-3333-4333-8333-333333333333',attemptIndex:1,detailProfile:'error',detailCallId:'11111111-1111-4111-8111-111111111111'})"), /查看错误详情/);
  assert.match(h.run("errorDetailAction({requestId:'33333333-3333-4333-8333-333333333333',attemptIndex:1})"), /当时未关联详情/);
  for(const invalid of [
    "{requestId:'bad',attemptIndex:1,detailProfile:'error',detailCallId:'11111111-1111-4111-8111-111111111111'}",
    "{requestId:'33333333-3333-4333-8333-333333333333',attemptIndex:-1,detailProfile:'error',detailCallId:'11111111-1111-4111-8111-111111111111'}",
    "{requestId:'33333333-3333-4333-8333-333333333333',attemptIndex:1,detailProfile:'other',detailCallId:'11111111-1111-4111-8111-111111111111'}",
  ]) { const action=h.run(`errorDetailAction(${invalid})`); assert.doesNotMatch(action,/button|查看错误详情/); assert.match(action,/关联不可用/); }
});

const requestId = '33333333-3333-4333-8333-333333333333';
const failedCall = '11111111-1111-4111-8111-111111111111';
const otherCall = '22222222-2222-4222-8222-222222222222';
const bodyIds = Array.from({ length: 6 }, (_, i) => `${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`);
const descriptor = (bodyId, state = 'complete', capturedBytes = 12) => ({ bodyId, state, observedBytes: 20, capturedBytes, redacted: false });
const errorRow = (profile = 'raw-full') => ({ requestId, attemptIndex: 0, detailProfile: profile, detailCallId: failedCall });
function rawGroup(profile = 'raw-full') {
  const full = profile === 'raw-full';
  return {
    request: { requestId, profile, status: 200, result: 'success', ...(full ? { headers: { 'content-type': 'application/json', authorization: '[REDACTED]' }, responseHeaders: { 'content-type': 'application/json' }, requestBody: bodyIds[0], responseBody: bodyIds[3] } : {}) },
    attempts: [
      { attemptIndex: 0, callId: failedCall, status: 502, outcomeStatus: 502, captureState: 'response-error', headers: { 'content-type': 'application/json', 'x-custom': '<secret>' }, responseHeaders: { 'content-type': 'application/json', 'set-cookie': '[REDACTED]' }, requestBody: bodyIds[1], responseBody: bodyIds[2] },
      ...(full ? [{ attemptIndex: 1, callId: otherCall, status: 200, outcomeStatus: 200, captureState: 'success', requestBody: bodyIds[4], responseBody: bodyIds[5] }] : []),
    ],
    bodies: [0, 1, 2, 3, 4, 5].filter(i => full || [1, 2].includes(i)).map(i => descriptor(bodyIds[i])),
  };
}
function inlineHarness() {
  const h = harness(), inserted = [], trigger = { attrs: {}, isConnected: true, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; }, closest() { return { insertAdjacentHTML(_, markup) { inserted.push(markup); h.el('#logChainTitle').textContent = '关联详情加载中…'; h.el('#logChainCopy').disabled = true; } }; } };
  h.el('#logChainRow').remove = () => { h.el('#logChainLegs').innerHTML = ''; h.el('#logChainText').value = ''; };
  h.el('#logPanel').hidden = false; h.el('#logType').value = 'errors';
  return { ...h, inserted, trigger, open: (profile = 'raw-full') => h.run(`openLogChain(${JSON.stringify(requestId)},0,${JSON.stringify(failedCall)},${JSON.stringify(profile)},trigger)`),
    setTrigger: () => { h.context.trigger = trigger; } };
}

test('inline error viewer matches the failed native call and labels four raw-full legs separately from final success', async () => {
  const h = inlineHarness(); h.setTrigger(); const before = h.drafts();
  h.context.handler = async route => route.includes('/bodies/') ? 'raw credential in selected body' : rawGroup();
  assert.match(h.run(`inlineErrorAction(${JSON.stringify(errorRow())})`), /在此查看链路/);
  assert.doesNotMatch(h.run(`inlineErrorAction(${JSON.stringify({ requestId, attemptIndex: 0 })})`), /button/);
  await h.open(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], `/api/logs/details/${requestId}`);
  assert.equal(h.el('#logChainClose').focused, true); assert.equal(h.trigger.attrs['aria-expanded'], 'true');
  assert.match(h.inserted[0], /role="region".*logChainStatus.*aria-live/);
  assert.match(h.el('#logChainTitle').textContent, /失败上游调用 1.*502.*最终客户端响应.*200.*success/);
  assert.match(h.el('#logChainAttempts').textContent, /本组 2 次原生上游调用.*尝试 1 HTTP 502 \/ 结果 502 · response-error（当前选中的失败调用）.*尝试 2 HTTP 200 \/ 结果 200 · success（仅显示状态，不读取正文）/);
  const legs = h.el('#logChainLegs').innerHTML;
  for (const label of ['客户端入站请求', '上游调用 1 请求', '上游调用 1 响应', '最终客户端响应']) assert.match(legs, new RegExp(label));
  assert.equal((legs.match(/加载.*?正文/g) || []).length, 4);
  assert.doesNotMatch(legs, new RegExp(bodyIds[4] + '|' + bodyIds[5] + '|<secret>'));
  assert.match(h.el('#logChainHeaders0').textContent, /authorization: \[REDACTED\]/);
  assert.match(h.el('#logChainHeaders2').textContent, /set-cookie: \[REDACTED\]/);
  assert.doesNotMatch(h.el('#logChainHeaders1').textContent, /x-custom|secret/);
  assert.equal(h.el('#logChainText').value, ''); assert.equal(h.el('#logChainCopy').disabled, true);
  assert.match(h.inserted[0], /id="logChainCopy"[^>]*disabled/);
  await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[3])})`);
  assert.equal(h.calls.length, 2); assert.equal(h.el('#logChainText').value, 'raw credential in selected body');
  assert.match(h.calls[1][0], new RegExp(`/bodies/${bodyIds[3]}$`)); assert.match(h.el('#logChainStatus').textContent, /未脱敏原文/);
  await h.run('copyLogChainBody()'); assert.deepEqual(h.copies, ['raw credential in selected body']);
  h.run('closeLogChain()'); assert.equal(h.el('#logChainText').value, ''); assert.equal(h.trigger.focused, true); assert.equal(h.trigger.attrs['aria-expanded'], 'false'); assert.equal(h.drafts(), before);
});

test('inline profiles are honest: raw-error has two upstream legs, sanitized modes never claim original text', async () => {
  const h = inlineHarness(); h.setTrigger();
  h.context.handler = async () => rawGroup('raw-error'); await h.open('raw-error');
  const legs = h.el('#logChainLegs').innerHTML;
  assert.equal((legs.match(/加载.*?正文/g) || []).length, 2);
  assert.match(legs, /该 profile 未采集此段/);
  assert.match(h.el('#logChainTitle').textContent, /最终客户端响应 Header\/Body 未采集 · 终结状态 200 \/ success/);
  assert.doesNotMatch(h.el('#logChainTitle').textContent, /未提交|最终客户端响应 · HTTP 200/);
  assert.match(h.el('#logChainAttempts').textContent, /本组 1 次原生上游调用/);
  h.run('closeLogChain()');
  const sanitized = rawGroup('raw-full'); sanitized.request.profile = 'full'; sanitized.bodies.forEach(body => { body.redacted = true; });
  h.context.handler = async () => sanitized; await h.open('full');
  assert.match(h.el('#logChainWarning').textContent, /不是未脱敏原文/);
  assert.match(h.el('#logChainHeaders0').textContent, /"authorization": "\[REDACTED\]"/);
  assert.match(h.el('#logChainStatus').textContent, /已脱敏/);
  h.run('closeLogChain()');
  sanitized.request.profile = 'error'; delete sanitized.request.requestBody; delete sanitized.request.responseBody;
  sanitized.attempts[0].responseHeaders = { authorization: '[REDACTED]' };
  delete sanitized.attempts[0].requestBody;
  h.context.handler = async () => sanitized; await h.open('error');
  assert.equal((h.el('#logChainLegs').innerHTML.match(/加载.*?正文/g) || []).length, 1);
  assert.doesNotMatch(h.el('#logChainHeaders2').textContent, /do not expose/);
  h.run('closeLogChain()');
  sanitized.request.requestBody = bodyIds[0]; sanitized.attempts[0].requestBody = bodyIds[2];
  h.context.handler = async () => sanitized; await h.open('error');
  assert.equal((h.el('#logChainLegs').innerHTML.match(/加载.*?正文/g) || []).length, 3);
  assert.match(h.el('#logChainHeaders1').textContent, /content-type/);
});

test('inline raw-full streaming failure distinguishes submitted final response from the failed upstream attempt', async () => {
  const h=inlineHarness(); h.setTrigger();
  const group=rawGroup(); group.request.status=200; group.request.result='failed';
  group.attempts[0].status=200; group.attempts[0].httpStatus=200; group.attempts[0].outcomeStatus=502;
  group.attempts[0].captureState='stream-transport-failed';
  group.bodies[2]=descriptor(bodyIds[2], 'interrupted', 4);
  group.bodies[3]=descriptor(bodyIds[3], 'interrupted', 8);
  h.context.handler=async route=>route.includes('/bodies/')?'data: partial event':group;
  await h.open();
  assert.match(h.el('#logChainTitle').textContent, /失败上游调用 1 · HTTP 200.*最终客户端响应 · HTTP 200 \/ failed/);
  assert.match(h.el('#logChainAttempts').textContent, /尝试 1 HTTP 200 \/ 结果 502 · stream-transport-failed/);
  assert.match(h.el('#logChainLegs').innerHTML, /传输中断，仅已采集前缀可读/);
  assert.match(h.el('#logChainStatus').textContent, /起流后传输失败/);
  await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[3])})`);
  assert.match(h.el('#logChainStatus').textContent, /未脱敏原文 · interrupted/);
  assert.equal(h.el('#logChainText').value, 'data: partial event');
});

test('inline mismatches, missing groups, omitted and truncated bodies do not invent available content', async () => {
  const h = inlineHarness(); h.setTrigger();
  for (const mutate of [g => { g.request.requestId = otherCall; }, g => { g.request.profile = 'raw-error'; }, g => { g.attempts[0].callId = otherCall; }, g => { g.attempts.push({ ...g.attempts[0] }); }, g => { g.attempts[0].captureState = 'success'; }]) {
    h.context.handler = async () => { const g = rawGroup(); mutate(g); return g; };
    await h.open(); assert.match(h.el('#logChainStatus').textContent, /关联校验失败|不一致或不唯一/);
    assert.equal(h.el('#logChainLegs').innerHTML, ''); const count = h.calls.length;
    await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[2])})`); assert.equal(h.calls.length, count);
    h.run('closeLogChain()');
  }
  h.context.handler = async () => ({ error: { message: '<private>' } }); await h.open();
  assert.match(h.el('#logChainStatus').textContent, /已过期\/清空/); h.run('closeLogChain()');
  h.context.handler = async () => { throw Error('<private>'); }; await h.open();
  assert.match(h.el('#logChainStatus').textContent, /已过期\/清空/); assert.doesNotMatch(h.el('#logChainStatus').textContent, /private/); h.run('closeLogChain()');
  h.context.handler = async () => { const g = rawGroup(); g.attempts[0].captureState = 'no-response'; delete g.attempts[0].responseBody; g.bodies[0] = descriptor(bodyIds[0], 'truncated', 12); g.bodies[1] = descriptor(bodyIds[1], 'resource-limited', 0); return g; };
  await h.open(); assert.match(h.el('#logChainLegs').innerHTML, /超过单体大小上限|捕获容量省略|未收到上游响应/);
  const count=h.calls.length; await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[1])})`); assert.equal(h.calls.length, count);
  await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[0])})`); assert.equal(h.calls.length, count+1);
});

test('inline viewer clears on row switch, reload, filter, pagehide, session loss and stale metadata/body responses', async () => {
  const h=inlineHarness(); h.setTrigger(); const metadata=deferred(); h.context.handler=()=>metadata.promise;
  const pending=h.open(); await h.run("switchSection('console')"); metadata.resolve(rawGroup()); await pending;
  assert.equal(h.el('#logChainTitle').textContent, '关联详情加载中…'); assert.equal(h.run('LOG_CHAIN'), null);
  h.el('#logPanel').hidden=false; h.el('#logType').value='errors'; h.context.handler=async route=>route.includes('/bodies/')?'raw secret':rawGroup();
  await h.open(); const late=deferred(); h.context.handler=route=>route.includes('/bodies/')?late.promise:Promise.resolve({items:[],nextCursor:null});
  const body=h.run(`loadLogChainBody(${JSON.stringify(bodyIds[2])})`);
  await h.run('loadLogs()'); late.resolve('stale secret'); await body;
  assert.equal(h.el('#logChainText').value,''); assert.equal(h.run('LOG_CHAIN'),null);
  h.context.handler=async()=>rawGroup(); await h.open(); h.el('#logModel').listeners.input();
  assert.equal(h.run('LOG_CHAIN'),null); assert.equal(h.el('#logNext').disabled,true);
  await h.open(); h.run('showLogin()'); assert.equal(h.run('LOG_CHAIN'),null);
  await h.open(); h.run("window.dispatch('pagehide')"); assert.equal(h.run('LOG_CHAIN'),null);
});

test('an actual api() 401 clears inline raw text, selection and copy before showing login', async () => {
  const h=inlineHarness(); h.setTrigger();
  h.context.handler=async route=>route.includes('/bodies/')?'synthetic raw body':rawGroup();
  await h.open(); await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[3])})`);
  assert.equal(h.el('#logChainText').value,'synthetic raw body');
  h.context.fetch=async()=>({status:401}); h.run('api=realApi');
  await assert.rejects(h.run(`api('/api/logs/details/${requestId}')`), /unauthorized/);
  assert.equal(h.run('LOG_CHAIN'),null); assert.equal(h.el('#logChainText').value,'');
  assert.equal(h.trigger.attrs['aria-expanded'],'false'); assert.equal(h.el('#loginOverlay').style.display,'flex');
});

test('switching inline rows drops the first body and late metadata; copy denial leaves manual selection', async () => {
  const h=inlineHarness(); h.setTrigger(); const first=h.trigger;
  h.context.handler=async route=>route.includes('/bodies/')?'private selected body':rawGroup();
  await h.open(); await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[3])})`);
  assert.equal(h.el('#logChainText').value, 'private selected body');
  const second={ ...first, attrs:{}, focused:false, setAttribute:first.setAttribute, focus:first.focus, closest:first.closest };
  h.context.otherTrigger=second; const pending=deferred(); h.context.handler=()=>pending.promise;
  const newer=h.run(`openLogChain(${JSON.stringify(requestId)},0,${JSON.stringify(failedCall)},'raw-full',otherTrigger)`);
  assert.equal(h.el('#logChainText').value,''); assert.equal(first.attrs['aria-expanded'],'false');
  pending.resolve(rawGroup()); await newer;
  assert.equal(second.attrs['aria-expanded'],'true'); assert.equal(h.el('#logChainText').value,'');
  h.context.handler=async route=>route.includes('/bodies/')?'private selected body':rawGroup();
  await h.run(`loadLogChainBody(${JSON.stringify(bodyIds[2])})`);
  h.context.navigator.clipboard.writeText=async()=>{throw Error('denied');}; await h.run('copyLogChainBody()');
  assert.equal(h.el('#logChainText').focused,true); assert.equal(h.el('#logChainText').selected,true);
  h.run('closeLogChain()'); assert.equal(second.focused,true); assert.equal(h.el('#logChainText').value,'');
});

test('inline metadata and malicious descriptors are escaped, Headers stay a safe projection, and old rows never fetch', async () => {
  const h=inlineHarness(); h.setTrigger();
  assert.doesNotMatch(h.run(`inlineErrorAction({requestId:${JSON.stringify(requestId)},attemptIndex:0,detailProfile:'raw-full',detailCallId:'bad'})`), /button/);
  h.context.handler=async()=>{const g=rawGroup();g.request.result='<img src=x>';g.attempts[0].captureState='<script>bad</script>';g.bodies[0].state='<img src=x>';g.request.headers['x-custom']='<img src=x>';return g;};
  await h.open(); assert.equal(h.el('#logChainTitle').innerHTML,'');
  assert.doesNotMatch(h.el('#logChainLegs').innerHTML, /<img|<script>/);
  assert.match(h.el('#logChainLegs').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.el('#logChainHeaders0').textContent, /x-custom|<img/);
  assert.match(h.el('#logChainTitle').textContent, /<img/);
});

test('editing a detail filter invalidates pending reads and cannot reuse the old page cursor', async () => {
  const h = harness(), before = h.drafts();
  h.context.handler = async () => ({ ...page('old-page'), nextCursor: 'old-cursor' });
  await h.run('loadDetails()'); assert.equal(h.el('#detailsNext').disabled, false);
  const pending = deferred(); h.context.handler = () => pending.promise;
  const read = h.run('loadDetails(true)'); assert.equal(h.el('#detailsNext').disabled, true);
  h.el('#detailsModel').value = 'new-filter'; h.el('#detailsModel').listeners.input();
  pending.resolve(page('stale-page')); await read;
  assert.equal(h.el('#detailsList').innerHTML, ''); assert.equal(h.el('#detailsNext').disabled, true);
  assert.match(h.el('#detailsStatus').textContent, /筛选已改变/);
  h.context.handler = async () => page('filtered-page'); await h.run('loadDetails(true)');
  const url = new URL(h.calls.at(-1)[0], 'http://local');
  assert.equal(url.searchParams.has('cursor'), false); assert.equal(url.searchParams.get('model'), 'new-filter');
  assert.equal(h.drafts(), before);
});
