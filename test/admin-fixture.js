// Test-only administrator sessions for legacy routing/diagnostic fixtures.
// The dedicated admin-auth suite exercises the real bootstrap and denial paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const password = 'fixture-independent-admin-password';
const sessions = new Map();
const nativeFetch = globalThis.fetch;
export function prepareAdminFixture(dir) {
  const filename = path.join(dir, 'admin-auth.json');
  if (fs.existsSync(filename)) return;
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
  fs.writeFileSync(filename, JSON.stringify({ version: 1, initialized: true, salt, hash }), { mode: 0o600 });
}
export async function connectAdminFixture(port) {
  const res = await nativeFetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (!res.ok) throw Error(`admin fixture login: ${res.status}`);
  const { csrf } = await res.json();
  sessions.set(Number(port), { cookie: res.headers.get('set-cookie').split(';')[0], csrf });
}
export function fixtureHeaders(port, route, method = 'GET', headers = {}) {
  if (!/^\/api\//.test(route) || route === '/api/meta' || /^\/api\/(auth\/|v1\/)/.test(route)) return headers;
  const session = sessions.get(Number(port));
  if (!session) return headers;
  return { ...headers, Cookie: [headers.Cookie || headers.cookie, session.cookie].filter(Boolean).join('; '),
    ...(!['GET','HEAD'].includes(method) ? { 'X-CSRF-Token': session.csrf } : {}) };
}
export function installFixtureFetch() {
  globalThis.fetch = (url, options = {}) => {
    const target = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname)) return nativeFetch(url, options);
    const method = options.method || 'GET';
    const headers = fixtureHeaders(target.port, target.pathname, method, options.headers || {});
    return nativeFetch(url, { ...options, headers });
  };
}
export const bareFetch = nativeFetch;
