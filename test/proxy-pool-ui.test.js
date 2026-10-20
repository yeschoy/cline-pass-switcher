// 代理池控制台：静态契约 + 生产脚本 VM 行为（掩码、行解析、草稿收集、状态渲染不含凭据）。
// VM/静态断言不等于真实浏览器的焦点/键盘/窄屏证据。凭据均为占位值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const PASS = 'pass-test', USER = 'user-test-session-1', API_KEY = 'test-api-key';
const URL_A = `socks5://${USER}:${PASS}@127.0.0.1:1080`, URL_B = 'http://user-test-session-2:pass-test@127.0.0.1:3128', URL_C = 'socks5h://127.0.0.1:1081';
const FLOPPY_DEFAULT = { apiKey: '', apiBase: 'https://api.floppydata.net', type: 'residential', country: 'US', state: '', city: '', protocol: 'socks5', rotation: 0, count: 100, refreshIntervalMs: 180000 };
const poolFixture = (extra = {}) => ({ enabled: true, strategy: 'round-robin', source: 'manual', egressRetries: 2, throttleCooldownMs: 60000, failureCooldownMs: 30000, connectTimeoutMs: 10000, maxRpmPerProxy: 0, entries: [URL_A, URL_B], floppydata: { ...FLOPPY_DEFAULT }, ...extra });
const accountsFixture = (proxyPool) => ({ mode: 'single', active: 0, concurrencyWaitMs: 2000, poolFullWaitMs: null, errorRules: [], retryRules: [],
  accountPipeline: { quotaPool: false, healthSort: false, sticky: false, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: 0, cachePoolMaxSize: 0, cachePoolLowQuotaSize: 0, sessionBindingExplicitTtlMs: 7200000, sessionBindingFallbackTtlMs: 900000, sessionBindingMaxEntries: 50000 },
  cachePool: { minSize: 0, maxSize: 0, targetSize: 0, binding: { enabled: false, size: 0, maxEntries: 50000 } },
  accounts: [{ id: 'a0', clientKeyId: 'legacy', name: 'a0', note: '', key: 'fake0', enabled: true, maxConcurrent: 0, maxRpm: 0, weight: 1, priority: 100, proxyUrl: 'socks5://127.0.0.1:9050', headers: {}, perModel: {}, activeCount: 0 }],
  ...(proxyPool === undefined ? {} : { proxyPool }) });

function harness(proxyPool) {
  const elements = new Map(), calls = [];
  const el = (id) => { if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, disabled: false, type: '', style: {}, attrs: {}, textContent: '', innerHTML: '', options: [], setAttribute(name, value) { this.attrs[name] = value; }, addEventListener() {}, focus() { this.focused = true; }, select() {}, showModal() {}, close() {} }); return elements.get(id); };
  const context = vm.createContext({ document: { querySelector: el, addEventListener() {}, activeElement: null }, window: { addEventListener() {} }, localStorage: { getItem() { return ''; } }, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {}, confirm: () => true, AbortController, URL, URLSearchParams, console });
  const run = (code) => vm.runInContext(code, context);
  run(script);
  el('#accMode').options = ['single'].map((value) => ({ value }));
  el('#pipelineSteps').children = ['quotaPool', 'healthSort', 'sticky'].map((step) => ({ dataset: { pipelineStep: step }, attrs: {}, setAttribute() {}, querySelector: () => ({ setAttribute() {}, focus() {} }) }));
  el('#pipelineSteps').appendChild = (node) => { const list = el('#pipelineSteps').children, index = list.indexOf(node); if (index >= 0) list.splice(index, 1); list.push(node); return node; };
  context.snapshot = accountsFixture(proxyPool);
  context.sent = calls;
  run("ACCS = snapshot; $('#monthlyQuotaThreshold').value='0.20'; $('#accMode').value='single'; $('#concurrencyWaitMs').value='2000'; for (const [id,v] of [['cachePoolSize','0'],['cachePoolMaxSize','0'],['cachePoolLowQuotaSize','0'],['sessionBindingExplicitTtlMs','7200000'],['sessionBindingFallbackTtlMs','900000'],['sessionBindingMaxEntries','50000'],['warmThreshold','80'],['drainThreshold','95'],['drainMaxConcurrent','2'],['proxyPoolTestSample','10']]) $('#'+id).value=v; hydrateErrorRuleDraft([]); hydrateRetryRuleDraft([]); if (ACCS.proxyPool) hydrateProxyPool(ACCS.proxyPool); renderAccounts();");
  return { run, el, calls, context, json: (code) => JSON.parse(run(`JSON.stringify(${code})`)) };
}
const plainCall = (call) => JSON.parse(JSON.stringify({ path: call.path, body: call.body ?? null, method: call.method ?? null }));
const noSecrets = (text, label) => { for (const secret of [PASS, USER, 'user-test-session-2', API_KEY]) assert.equal(String(text).includes(secret), false, `${label} must not contain ${secret}`); };

test('proxy pool card exposes labelled native controls, FloppyData fields, status table and drawer/log hints', () => {
  const card = html.slice(html.indexOf('<section class="card proxy-pool" id="proxyPoolCard"'), html.indexOf('<h2>访问与安全'));
  assert.ok(card.length > 100, 'card exists before the security card');
  assert.match(card, /aria-labelledby="proxyPoolTitle"/);
  for (const id of ['proxyPoolEnabled', 'proxyPoolStrategy', 'proxyPoolSource', 'proxyPoolEgressRetries', 'proxyPoolThrottleCooldown', 'proxyPoolFailureCooldown', 'proxyPoolConnectTimeout', 'proxyPoolMaxRpm', 'proxyPoolEntries', 'proxyPoolApiKey', 'proxyPoolType', 'proxyPoolCountry', 'proxyPoolState', 'proxyPoolCity', 'proxyPoolProtocol', 'proxyPoolRotation', 'proxyPoolCount', 'proxyPoolRefreshInterval', 'proxyPoolTestSample']) {
    assert.match(card, new RegExp(`for="${id}"`), `${id} is labelled`);
    assert.match(card, new RegExp(`id="${id}"`));
  }
  assert.match(card, /所有上游调用使用代理池/);
  assert.match(card, /<option value="round-robin">轮询<\/option><option value="random">随机<\/option>/);
  assert.match(card, /<option value="manual">手动导入<\/option><option value="floppydata">FloppyData<\/option>/);
  assert.match(card, /id="proxyPoolApiKey" type="password"/);
  const rotations = [...card.matchAll(/<select id="proxyPoolRotation">([\s\S]*?)<\/select>/g)][0][1];
  assert.deepEqual([...rotations.matchAll(/value="(-?\d+)"/g)].map((match) => Number(match[1])), [-1, 0, 5, 10, 15, 20, 60]);
  assert.match(rotations, /每次请求换 IP/); assert.match(rotations, /固定会话/);
  assert.match(card, /id="proxyPoolThrottleCooldown" type="number" min="1" max="600"/);
  assert.match(card, /id="proxyPoolConnectTimeout" type="number" min="1" max="60"/);
  assert.match(card, /id="proxyPoolEgressRetries" type="number" min="0" max="5"/);
  assert.match(card, /id="proxyPoolMaxRpm" type="number" min="0" max="10000"/);
  assert.match(card, /id="proxyPoolCount" type="number" min="1" max="500"/);
  assert.match(card, /id="proxyPoolRefreshInterval" type="number" min="60" max="3600"/);
  for (const label of ['显示并编辑', '立即刷新', '查询余额', '刷新状态', '测试条目', '按流量（GB）计费']) assert.ok(card.includes(label), label);
  assert.match(card, /<div id="proxyPoolEditor" hidden>/, 'editor is hidden by default');
  assert.match(card, /<th>条目<\/th><th>协议<\/th><th>端点<\/th><th>状态<\/th><th>冷却到<\/th><th>原因<\/th><th>RPM<\/th><th>近 15 分钟 请求 \/ 429 \/ 连接失败<\/th>/);
  assert.match(card, /aria-live="polite"/);
  assert.equal(/placeholder="[^"]*@/.test(card), false, 'no credential-looking placeholder');
  assert.match(html, /id="drawerProxyPoolHint" class="dim"[^>]*hidden>代理池有可用代理时不使用此固定代理/);
  assert.match(html, /\$\{actualCell\}\$\{egressLogLabel\(x,type\)\}/);
});

test('manual entries are masked by default and plaintext only lives in the opened editor', () => {
  const h = harness(poolFixture());
  const masked = h.el('#proxyPoolMaskedList').innerHTML;
  assert.match(masked, /SOCKS5 · 127\.0\.0\.1:1080 · u\*\*\*/);
  assert.match(masked, /HTTP · 127\.0\.0\.1:3128 · u\*\*\*/);
  noSecrets(masked, 'masked list');
  assert.equal(h.el('#proxyPoolEntries').value, '');
  assert.equal(h.el('#proxyPoolEditor').hidden, true);
  assert.match(h.el('#proxyPoolManualSummary').textContent, /2 条（已掩码）/);
  noSecrets(JSON.stringify([h.el('#proxyPoolMaskedList').attrs, h.el('#proxyPoolEntries').attrs]), 'attributes');

  h.run('toggleProxyPoolEditor()');
  assert.equal(h.el('#proxyPoolEditor').hidden, false);
  assert.equal(h.el('#proxyPoolEntries').value, `${URL_A}\n${URL_B}`);
  assert.equal(h.el('#proxyPoolMaskedList').innerHTML, '');
  assert.equal(h.el('#proxyPoolEditToggle').disabled, true);
  h.el('#proxyPoolEntries').value = `${URL_A}\n${URL_C}\n`;
  h.run('applyProxyPoolEditor()');
  assert.equal(h.el('#proxyPoolEditor').hidden, true);
  assert.equal(h.el('#proxyPoolEntries').value, '', 'apply clears the plaintext textarea');
  assert.deepEqual(h.json('PROXY_POOL_ENTRIES'), [URL_A, URL_C]);
  assert.match(h.el('#proxyPoolMaskedList').innerHTML, /SOCKS5H · 127\.0\.0\.1:1081 · 无认证/);

  h.run('toggleProxyPoolEditor()');
  h.el('#proxyPoolEntries').value = 'not a url';
  h.run('closeProxyPoolEditor()');
  assert.equal(h.el('#proxyPoolEntries').value, '', 'discard clears plaintext');
  assert.deepEqual(h.json('PROXY_POOL_ENTRIES'), [URL_A, URL_C], 'discard keeps the previous draft');
});

test('the line parser reports line numbers for blank, invalid, duplicate and oversized input without echoing URLs', () => {
  const h = harness(poolFixture());
  const parse = (text) => { h.context.input = text; try { return { ok: h.json('parseProxyPoolEntries(input)') }; } catch (error) { return { error: error.message }; } };
  assert.deepEqual(parse(''), { ok: [] });
  assert.deepEqual(parse(`  ${URL_A}  \r\n${URL_C}\n\n`), { ok: [URL_A, URL_C] });
  const cases = [
    [`${URL_A}\n\n${URL_C}`, /第 2 行为空/],
    [`${URL_A}\nftp://${USER}:${PASS}@host:21`, /第 2 行不是有效的/],
    [`${URL_A}\nsocks5://${USER}:${PASS}@127.0.0.1:1080/path`, /第 2 行不是有效的/],
    [`http://${USER}:${PASS}@127.0.0.1:99999`, /第 1 行不是有效的/],
    [`${URL_C}\n${URL_A}\nSOCKS5H://127.0.0.1:1081`, /第 3 行与第 1 行重复/],
  ];
  for (const [text, pattern] of cases) {
    const result = parse(text);
    assert.match(result.error || '', pattern, text);
    noSecrets(result.error, 'parser error');
  }
  const many = Array.from({ length: 2001 }, (_, i) => `socks5://127.0.0.1:${10000 + i}`).join('\n');
  assert.match(parse(many).error, /最多 2000 条/);
  h.run('toggleProxyPoolEditor()');
  h.el('#proxyPoolEntries').value = `${URL_A}\n${URL_A}`;
  h.run('applyProxyPoolEditor()');
  assert.match(h.el('#proxyPoolEntriesError').textContent, /第 2 行与第 1 行重复/);
  assert.equal(h.el('#proxyPoolEditor').hidden, false, 'invalid input keeps the editor open');
  assert.deepEqual(h.json('PROXY_POOL_ENTRIES'), [URL_A, URL_B]);
});

test('collectAccounts sends the complete proxyPool draft, converts seconds to ms and validates before any request', () => {
  const h = harness(poolFixture({ floppydata: { ...FLOPPY_DEFAULT, apiBase: 'http://127.0.0.1:9' } }));
  assert.deepEqual(h.json('collectAccounts().proxyPool'), poolFixture({ floppydata: { ...FLOPPY_DEFAULT, apiBase: 'http://127.0.0.1:9' } }), 'untouched draft round-trips exactly');
  h.el('#proxyPoolStrategy').value = 'random';
  h.el('#proxyPoolEgressRetries').value = '5';
  h.el('#proxyPoolThrottleCooldown').value = '1';
  h.el('#proxyPoolFailureCooldown').value = '600';
  h.el('#proxyPoolConnectTimeout').value = '2.5';
  h.el('#proxyPoolMaxRpm').value = '60';
  const pool = h.json('collectAccounts().proxyPool');
  assert.deepEqual(Object.keys(pool), ['enabled', 'strategy', 'source', 'egressRetries', 'throttleCooldownMs', 'failureCooldownMs', 'connectTimeoutMs', 'maxRpmPerProxy', 'entries', 'floppydata']);
  assert.deepEqual({ ...pool, entries: undefined, floppydata: undefined }, { enabled: true, strategy: 'random', source: 'manual', egressRetries: 5, throttleCooldownMs: 1000, failureCooldownMs: 600000, connectTimeoutMs: 2500, maxRpmPerProxy: 60, entries: undefined, floppydata: undefined });

  // An open editor is parsed strictly at save time.
  h.run('toggleProxyPoolEditor()');
  h.el('#proxyPoolEntries').value = `${URL_C}`;
  assert.deepEqual(h.json('collectAccounts().proxyPool.entries'), [URL_C]);
  h.el('#proxyPoolEntries').value = `${URL_C}\nbad`;
  assert.throws(() => h.run('collectAccounts()'), /第 2 行/);
  h.run('closeProxyPoolEditor()');

  const invalid = [['proxyPoolEgressRetries', '6', /换代理重试次数/], ['proxyPoolThrottleCooldown', '0', /429 冷却/], ['proxyPoolConnectTimeout', '61', /连接超时/], ['proxyPoolMaxRpm', '1.5', /每代理每分钟上限/], ['proxyPoolCount', '501', /每批数量/], ['proxyPoolRefreshInterval', '59', /刷新间隔/], ['proxyPoolCountry', 'USA', /两位字母/]];
  for (const [id, value, pattern] of invalid) {
    const previous = h.el('#' + id).value;
    h.el('#' + id).value = value;
    assert.throws(() => h.run('collectAccounts()'), pattern, id);
    h.el('#' + id).value = previous;
  }
  h.run('PROXY_POOL_ENTRIES=[]');
  assert.throws(() => h.run('collectAccounts()'), /至少需要 1 条代理/);
  h.el('#proxyPoolEnabled').checked = false;
  assert.deepEqual(h.json('collectAccounts().proxyPool.entries'), [], 'a disabled empty manual pool is valid');

  // Saving with an invalid draft never reaches the network.
  h.el('#proxyPoolEnabled').checked = true;
  h.run("api=async(...args)=>{sent.push(args);return {ok:true}}");
  h.run('saveAccounts()');
  assert.equal(h.calls.length, 0);
  assert.match(h.el('#accMsg').textContent, /至少需要 1 条代理/);
});

test('servers without proxyPool keep the old payload shape', () => {
  const h = harness(undefined);
  assert.equal(h.run("Object.hasOwn(collectAccounts(),'proxyPool')"), false);
  assert.match(h.el('#accBody').innerHTML, /<span class="badge">SOCKS5<\/span>/);
});

test('FloppyData draft fields, refresh, balance and test calls use fixed endpoints and render only enums', async () => {
  const h = harness(poolFixture({ enabled: false }));
  h.el('#proxyPoolSource').value = 'floppydata';
  h.run('renderProxyPoolSource()');
  assert.equal(h.el('#proxyPoolManual').hidden, true);
  assert.equal(h.el('#proxyPoolFloppy').hidden, false);
  h.el('#proxyPoolEnabled').checked = true;
  assert.throws(() => h.run('collectAccounts()'), /必须填写 API Key/);
  h.el('#proxyPoolApiKey').value = API_KEY;
  assert.equal(h.el('#proxyPoolApiKey').type, 'password', 'API key is masked by default');
  Object.assign(h.el('#proxyPoolType'), { value: 'mobile' }); Object.assign(h.el('#proxyPoolCountry'), { value: 'de' });
  Object.assign(h.el('#proxyPoolState'), { value: ' Bavaria ' }); Object.assign(h.el('#proxyPoolCity'), { value: 'Munich' });
  Object.assign(h.el('#proxyPoolProtocol'), { value: 'http' }); Object.assign(h.el('#proxyPoolRotation'), { value: '-1' });
  Object.assign(h.el('#proxyPoolCount'), { value: '50' }); Object.assign(h.el('#proxyPoolRefreshInterval'), { value: '300' });
  const pool = h.json('collectAccounts().proxyPool');
  assert.equal(pool.source, 'floppydata'); assert.equal(pool.enabled, true);
  assert.deepEqual(pool.entries, [URL_A, URL_B], 'manual entries are retained while another source is selected');
  assert.deepEqual(pool.floppydata, { apiKey: API_KEY, apiBase: 'https://api.floppydata.net', type: 'mobile', country: 'DE', state: 'Bavaria', city: 'Munich', protocol: 'http', rotation: -1, count: 50, refreshIntervalMs: 300000 });

  const status = { enabled: true, source: 'floppydata', strategy: 'round-robin', total: 2, available: 1, retiring: 1, fallbacks: { total: 3, recent: 1 },
    floppydata: { state: 'error', lastAttemptAt: 1700000000000, lastSuccessAt: 1700000000000, nextRefreshAt: 1700000180000, lastBatch: { requested: 4, succeeded: 1 }, lastError: 'insufficient_balance' },
    entries: [{ entryId: '0123abcd', scheme: 'socks5', endpointKey: 'socks5://127.0.0.1:1080', state: 'cooldown', cooldownUntil: 1700000060000, reason: 'throttle', rpmUsed: 2, inFlight: 1, recent: { requests: 5, throttled: 2, connectFailures: 0 } },
      { entryId: '89abcdef', scheme: 'socks5', endpointKey: 'socks5://127.0.0.1:1081', state: 'retiring', cooldownUntil: null, reason: null, rpmUsed: 0, inFlight: 1, recent: { requests: 1, throttled: 0, connectFailures: 1 } }] };
  h.context.responses = { '/api/proxy-pool/refresh': status, '/api/proxy-pool/balance': { ok: true, availableBytes: 12500000000, availableGb: 12.5, expiringAt: '2030-01-02T03:04:05.000Z' }, '/api/proxy-pool/test': { results: [{ entryId: '0123abcd', ok: true, ms: 120, status: 200 }, { entryId: '89abcdef', ok: false, ms: 15, errorCategory: 'proxy' }] } };
  h.run('api=async(path,body,method)=>{sent.push({path,body,method});return responses[path]}');
  await h.run('refreshProxyPoolSource()');
  assert.deepEqual(plainCall(h.calls.at(-1)), { path: '/api/proxy-pool/refresh', body: {}, method: null });
  assert.match(h.el('#proxyPoolFloppyStatus').textContent, /失败 · 上次成功 .+ · 成功数\/请求数 1\/4 · 下次刷新 .+ · 错误 余额不足/);
  assert.match(h.el('#proxyPoolStatusSummary').textContent, /总数 2 · 可用 1 · 冷却 1 · 限速 0 · 退役中 1 · 回退 3（近 15 分钟 1）/);
  const rows = h.el('#proxyPoolStatusBody').innerHTML;
  assert.match(rows, /pool:0123abcd/); assert.match(rows, /SOCKS5/); assert.match(rows, /冷却中/); assert.match(rows, /HTML 429/); assert.match(rows, /退役中/); assert.match(rows, /5 \/ 2 \/ 0/);
  noSecrets(rows + h.el('#proxyPoolStatusSummary').textContent + h.el('#proxyPoolFloppyStatus').textContent, 'status rendering');

  await h.run('loadProxyPoolBalance()');
  assert.equal(h.calls.at(-1).path, '/api/proxy-pool/balance'); assert.equal(h.calls.at(-1).body, undefined);
  assert.match(h.el('#proxyPoolBalance').textContent, /剩余 12\.5 GB · 最早到期/);
  h.context.responses['/api/proxy-pool/balance'] = { error: { message: 'floppydata balance query failed', code: 'unauthorized' } };
  await h.run('loadProxyPoolBalance()');
  assert.match(h.el('#proxyPoolBalance').textContent, /余额查询失败：API Key 无效或未配置/);

  h.el('#proxyPoolTestSample').value = '2';
  await h.run('testProxyPoolEntries()');
  assert.deepEqual(plainCall(h.calls.at(-1)), { path: '/api/proxy-pool/test', body: { sample: 2 }, method: null });
  assert.match(h.el('#proxyPoolTestResult').textContent, /成功 1，失败 1/);
  assert.match(h.el('#proxyPoolTestResult').textContent, /pool:89abcdef ✘ 15 ms · 代理连接失败/);
  h.el('#proxyPoolTestSample').value = '51';
  const before = h.calls.length;
  await h.run('testProxyPoolEntries()');
  assert.equal(h.calls.length, before, 'out-of-range sample sends nothing');

  h.context.responses['/api/proxy-pool/refresh'] = { error: { message: 'proxy pool refresh requires the enabled floppydata source' } };
  await h.run('refreshProxyPoolSource()');
  assert.match(h.el('#proxyPoolFloppyStatus').textContent, /立即刷新失败：需先保存并启用 FloppyData 来源/);
});

test('manual masked rows show entry id and state only when the draft matches the running batch; badges and drawer hint follow the saved switch', () => {
  const h = harness(poolFixture());
  h.context.status = { enabled: true, source: 'manual', strategy: 'round-robin', total: 2, available: 1, retiring: 0, fallbacks: { total: 0, recent: 0 }, floppydata: null,
    entries: [{ entryId: 'aaaaaaaa', scheme: 'socks5', endpointKey: 'socks5://127.0.0.1:1080', state: 'ok', cooldownUntil: null, reason: null, rpmUsed: 0, inFlight: 0, recent: { requests: 0, throttled: 0, connectFailures: 0 } },
      { entryId: 'bbbbbbbb', scheme: 'http', endpointKey: 'http://127.0.0.1:3128', state: 'cooldown', cooldownUntil: Date.now() + 1000, reason: 'connect', rpmUsed: 0, inFlight: 0, recent: { requests: 1, throttled: 0, connectFailures: 1 } }] };
  h.run('renderProxyPoolStatus(status)');
  const masked = h.el('#proxyPoolMaskedList').innerHTML;
  assert.match(masked, /aaaaaaaa · SOCKS5 · 127\.0\.0\.1:1080 · u\*\*\* · 可用/);
  assert.match(masked, /bbbbbbbb · HTTP · 127\.0\.0\.1:3128 · u\*\*\* · 冷却中/);
  assert.match(h.el('#proxyPoolStatusBody').innerHTML, /连接失败/);
  noSecrets(masked + h.el('#proxyPoolStatusBody').innerHTML, 'masked rows');
  h.run(`PROXY_POOL_ENTRIES=[${JSON.stringify(URL_B)},${JSON.stringify(URL_A)}];renderProxyPoolEntries()`);
  assert.doesNotMatch(h.el('#proxyPoolMaskedList').innerHTML, /aaaaaaaa|bbbbbbbb/, 'a reordered draft cannot borrow runtime ids');
  h.run('renderProxyPoolStatus(null)');
  assert.match(h.el('#proxyPoolStatusSummary').textContent, /状态不可用/);

  assert.match(h.el('#accBody').innerHTML, /<span class="badge"[^>]*>代理池<\/span>/);
  assert.match(h.el('#accBody').innerHTML, /池无可用时回退：SOCKS5/);
  h.run('openAccountDrawer(0)');
  assert.equal(h.el('#drawerProxyPoolHint').hidden, false);
  h.run('closeAccountDrawer(true); ACCS.proxyPool.enabled=false; renderAccounts(); openAccountDrawer(0)');
  assert.equal(h.el('#drawerProxyPoolHint').hidden, true);
  assert.doesNotMatch(h.el('#accBody').innerHTML, />代理池</);
});

test('request/error log rows show bounded egress labels and the fallback marker', () => {
  const h = harness(poolFixture());
  const label = (row, type = 'requests') => { h.context.row = row; return h.run(`egressLogLabel(row,${JSON.stringify(type)})`); };
  assert.equal(label({ attempts: [{ egress: 'pool:0123abcd', poolFallback: false }, { egress: 'pool:89abcdef', poolFallback: false }] }), '<br><span class="dim">出口 pool:0123abcd → pool:89abcdef</span>');
  assert.equal(label({ attempts: [], egress: 'account-proxy', poolFallback: true }), '<br><span class="dim">出口 账号代理（回退）</span>');
  assert.equal(label({ egress: 'direct', poolFallback: true }, 'errors'), '<br><span class="dim">出口 直连（回退）</span>');
  assert.equal(label({ egress: `socks5://${USER}:${PASS}@h:1` }, 'errors'), '', 'non-enum values are never rendered');
  assert.equal(label({}), '', 'historical rows without egress render nothing');
});

test('loadAll hydrates the pool draft from GET /api/accounts and loads the credential-free status', async () => {
  const h = harness(undefined);
  h.context.responses = { '/api/models': {}, '/api/accounts': accountsFixture(poolFixture({ strategy: 'random', throttleCooldownMs: 1500, floppydata: { ...FLOPPY_DEFAULT, apiKey: API_KEY, rotation: 15, refreshIntervalMs: 600000 } })), '/api/security': {}, '/api/security/client-keys': { keys: [{ id: 'legacy', name: 'Legacy' }] }, '/api/meta': {}, '/api/model-aliases': { aliases: {} },
    '/api/proxy-pool/status': { enabled: true, source: 'manual', strategy: 'random', total: 2, available: 2, retiring: 0, fallbacks: { total: 0, recent: 0 }, floppydata: null, entries: [] } };
  h.run('render=()=>{}; api=async(path)=>{sent.push(path);return responses[path]}');
  await h.run('loadAll()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.calls.includes('/api/proxy-pool/status'));
  assert.equal(h.el('#proxyPoolEnabled').checked, true);
  assert.equal(h.el('#proxyPoolStrategy').value, 'random');
  assert.equal(h.el('#proxyPoolThrottleCooldown').value, 1.5);
  assert.equal(h.el('#proxyPoolRotation').value, '15');
  assert.equal(h.el('#proxyPoolRefreshInterval').value, 600);
  assert.equal(h.el('#proxyPoolApiKey').value, API_KEY, 'the key lives only in the password input value');
  assert.equal(h.el('#proxyPoolApiKey').type, 'password');
  assert.match(h.el('#proxyPoolStatusSummary').textContent, /随机 · 总数 2 · 可用 2/);
  assert.deepEqual(h.json('collectAccounts().proxyPool.throttleCooldownMs'), 1500);
});
