import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const page = (requestId) => ({ items: [{ requestId, ts: 1, model: '<model>', accounts: ['<account>'], status: 200, state: 'complete', attemptCount: 1 }], nextCursor: null, health: { failures: 0, dropped: 0, corrupt: 0 } });
function harness() {
  const elements = new Map(), calls = [], copies = [];
  const el = (id) => { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, disabled: false, textContent: '', innerHTML: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { this.focused = true; }, select() { this.selected = true; } }); return elements.get(id); };
  const context = vm.createContext({ document: { querySelector: el, addEventListener() {} }, localStorage: { getItem: () => '' }, fetch: () => new Promise(() => {}), setTimeout() {}, clearTimeout() {}, confirm: () => true, URL, URLSearchParams, navigator: { clipboard: { async writeText(text) { copies.push(text); } } } });
  const run = (code) => vm.runInContext(code, context); run(script);
  context.handler = async () => page('row');
  context.call = (...args) => { calls.push(args); return context.handler(...args); };
  run('api=(...args)=>call(...args)');
  run("ACCS={accounts:[{id:'draft',name:'Draft',key:'not submitted',maxConcurrent:9}],active:0};BULK_SELECTION.add(ACCS.accounts[0]);RAW_SCHEDULING={text:'unapplied raw draft'};$('#accMode').value='sticky';$('#accountErrorRules').value='invalid pending JSON';");
  const drafts = () => run("JSON.stringify([ACCS,[...BULK_SELECTION],RAW_SCHEDULING,$('#accMode').value,$('#accountErrorRules').value])");
  return { context, run, el, calls, copies, drafts };
}

test('five sections, toggle and detail reads preserve all account/bulk/raw draft owners', async () => {
  const h = harness(), before = h.drafts();
  h.context.handler = async (path, body) => path.includes('settings') ? { detailedLogging: body?.detailedLogging ?? false, authRequired: false } : page('row');
  await h.run("switchSection('details')");
  assert.equal(h.el('#detailsPanel').hidden, false);
  for (const id of ['#consolePanel', '#statisticsPanel', '#logPanel']) assert.equal(h.el(id).hidden, true);
  assert.equal(h.el('#navDetails').attrs['aria-pressed'], 'true'); assert.match(h.el('#detailsAuth').textContent, /没有密钥保护/);
  h.el('#detailedLogging').checked = true; await h.run('toggleDetailedLogging()');
  assert.equal(h.el('#detailedLogging').checked, true); assert.equal(h.drafts(), before);
  assert.ok(h.calls.every(([path]) => path.startsWith('/api/logs/')));
  await h.run("switchSection('console')"); assert.equal(h.el('#detailsPanel').hidden, true); assert.equal(h.el('#consolePanel').hidden, false);
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
});

test('toggle failures restore confirmed state, pending reads cannot undo a save, and stale clear does not reload', async () => {
  const h = harness(), before = h.drafts();
  h.context.handler = async () => ({ error: { message: 'mock failure' } }); h.el('#detailedLogging').checked = true;
  await h.run('toggleDetailedLogging()'); assert.equal(h.el('#detailedLogging').checked, false); assert.equal(h.el('#detailedLogging').disabled, false);
  const get = deferred(), post = deferred(); h.context.handler = (path, body) => body ? post.promise : get.promise;
  const pendingRead = h.run('loadDetailSettings()'); h.el('#detailedLogging').checked = true; const pendingSave = h.run('toggleDetailedLogging()');
  assert.equal(h.el('#detailedLogging').disabled, true); post.resolve({ detailedLogging: true }); await pendingSave;
  get.resolve({ detailedLogging: false, authRequired: true }); await pendingRead; assert.equal(h.el('#detailedLogging').checked, true);
  const clear = deferred(); h.context.handler = () => clear.promise; h.calls.length = 0;
  const pendingClear = h.run('clearDetails()'); await h.run("switchSection('console')"); clear.resolve({ ok: true }); await pendingClear;
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/api/logs/details'); assert.equal(h.calls[0][2], 'DELETE');
  assert.equal(h.drafts(), before);
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
