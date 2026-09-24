import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('console login uses an in-memory CSRF session, clears legacy storage and preserves drafts on re-login', async () => {
  const calls = [], elements = new Map(), removed = [];
  let reloads = 0;
  const el = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', hidden: false, disabled: false, style: {}, textContent: '',
      addEventListener() {}, focus() {}, querySelectorAll() { return []; } });
    return elements.get(selector);
  };
  const responses = [];
  const ctx = vm.createContext({ document: { querySelector: el, addEventListener() {} }, window: { addEventListener() {} }, localStorage: { removeItem: k => removed.push(k) },
    fetch: async (...args) => { calls.push(args); return responses.shift() || new Promise(() => {}); },
    setTimeout: () => 0, clearTimeout() {}, console, URL, URLSearchParams, AbortController, location: { reload() { reloads++; } } });
  const run = source => vm.runInContext(source, ctx);
  run(script);
  assert.deepEqual(removed, ['cps_key']);
  calls.length = 0;
  run("ADMIN_BOOTSTRAP = true; $('#loginKey').value = 'temporary-client-key'; $('#loginCode').value = 'separate-private-code';");
  responses.push({ ok: true, json: async () => ({ pending: true, csrf: 'initial-csrf' }) });
  await run('tryLogin()');
  assert.equal(calls[0][0], '/api/auth/bootstrap');
  assert.deepEqual(JSON.parse(calls[0][1].body), { password: 'temporary-client-key', code: 'separate-private-code' });
  assert.equal(el('#changeFields').hidden, false);
  assert.equal(run('ADMIN_CSRF'), 'initial-csrf');
  el('#newAdminPassword').value = 'new-admin-password-123';
  responses.push({ ok: false, status: 401 }, { ok: true, json: async () => ({ initialized: false, available: true }) });
  await run('tryLogin()');
  assert.equal(run('ADMIN_PENDING'), false);
  assert.equal(run('ADMIN_CSRF'), null);
  assert.equal(el('#loginKey').disabled, false);
  assert.equal(el('#bootstrapFields').hidden, false);
  assert.equal(el('#changeFields').hidden, true);
  assert.match(el('#loginErr').textContent, /会话已失效/);
  el('#loginKey').value = 'temporary-client-key'; el('#loginCode').value = 'separate-private-code';
  responses.push({ ok: true, json: async () => ({ pending: true, csrf: 'initial-csrf' }) });
  await run('tryLogin()');
  el('#newAdminPassword').value = 'new-admin-password-123';
  responses.push({ ok: true, json: async () => ({ ok: true }) });
  await run('tryLogin()');
  const change = calls.findLast(([path]) => path === '/api/auth/password');
  assert.equal(change[1].headers['X-CSRF-Token'], 'initial-csrf');
  assert.deepEqual(JSON.parse(change[1].body), { newPassword: 'new-admin-password-123' });
  responses.push({ ok: true, json: async () => ({ pending: false, csrf: 'next-csrf' }) });
  el('#loginKey').value = 'new-admin-password-123';
  run("DATA = { draft: true }");
  await run('tryLogin()');
  assert.equal(calls.at(-1)[0], '/api/auth/login');
  assert.equal(run('DATA.draft'), true);
  responses.push({ status: 401 });
  await assert.rejects(run("api('/api/accounts')"), /unauthorized/);
  assert.equal(el('#loginOverlay').style.display, 'flex');
  assert.equal(run('DATA.draft'), true);
  assert.equal(run('ADMIN_CSRF'), null);
  assert.equal(calls.at(-1)[1].headers['X-Admin-Key'], undefined);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="loginTitle"/);
  assert.match(html, /id="loginOverlay"[^>]+background:var\(--bg\); z-index:100/, 'expired login covers higher-priority drawers and sensitive prior content');
  assert.match(html, /width:min\(100%,420px\)/);
  run("ADMIN_CSRF = 'valid-csrf'; DATA = { draft: true }");
  responses.push({ status: 500, json: async () => ({ error: { message: 'unavailable' } }) });
  await run('logoutAdmin()');
  assert.equal(reloads, 0);
  assert.equal(run('DATA.draft'), true);
  assert.match(el('#adminStatus').textContent, /退出未确认/);
  responses.push({ status: 200, json: async () => ({ ok: true }) });
  await run('logoutAdmin()');
  assert.equal(reloads, 1);
});
