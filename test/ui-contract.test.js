import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('console exposes six bounded presets and accessible account drawer/log/alias views', () => {
  for (const id of ['stable','throughput','even','quota','failover','safe']) assert.match(html, new RegExp(`${id}:\\{`));
  const presets = html.slice(html.indexOf('const PRESETS='), html.indexOf('function previewPreset'));
  for (const forbidden of ['proxyUrl','perModel','modelAliases','key:']) assert.equal(presets.includes(forbidden), false, `presets must not modify ${forbidden}`);
  assert.match(html, /role="dialog"/); assert.match(html, /aria-labelledby="drawerTitle"/); assert.match(html, /accountDrawerBackdrop/);
  assert.match(html, /api\/logs/); assert.match(html, /api\/model-aliases/); assert.match(html, /width:min\(100%,1800px\)/);
});

test('account drawer key visibility is explicit, masked on every open, and excluded from dirty state', () => {
  assert.match(html, /<label for="drawerKey">API Key<\/label><input id="drawerKey" type="password">/);
  assert.match(html, /<input id="drawerShowKey" type="checkbox"[^>]+> 显示 API Key<\/label>/);
  assert.match(html, /onchange="\$\('#drawerKey'\)\.type=this\.checked\?'text':'password'"/);
  const drawerValue = html.slice(html.indexOf('function drawerValue'), html.indexOf('function openAccountDrawer'));
  assert.doesNotMatch(drawerValue, /drawerShowKey/);
  const openDrawer = html.slice(html.indexOf('function openAccountDrawer'), html.indexOf('function closeAccountDrawer'));
  assert.match(openDrawer, /\$\('#drawerShowKey'\)\.checked=false/);
  assert.match(openDrawer, /\$\('#drawerKey'\)\.type='password'/);
});

test('top navigation switches three mutually exclusive panels without anchor or scroll shortcuts', () => {
  assert.match(html, /<nav class="section-nav" aria-label="顶层板块">/);
  for (const [id, section, pressed, label] of [['navConsole','console','true','控制台'],['navRequests','requests','false','请求日志'],['navErrors','errors','false','错误日志']]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]+type="button"[^>]+aria-pressed="${pressed}"[^>]+onclick="switchSection\\('${section}'\\)"[^>]*>${label}<\\/button>`));
  }
  assert.equal((html.match(/id="consolePanel"/g) || []).length, 1);
  assert.equal((html.match(/id="logPanel"/g) || []).length, 1);
  assert.match(html, /<section id="logPanel" aria-labelledby="logTitle" hidden>/);
  assert.match(html, /<\/section>\s*<section id="consolePanel">[\s\S]+<\/section>\s*<div id="accountDrawerBackdrop"/);
  assert.ok(html.indexOf('<nav class="section-nav"') < html.indexOf('<section id="logPanel"'));
  assert.ok(html.indexOf('<section id="logPanel"') < html.indexOf('<section id="consolePanel"'));
  assert.doesNotMatch(html, /scrollIntoView/);
  assert.doesNotMatch(html, /href="#(?:log|console)/);
});

test('request and error sections share one log view and reset the selected type cursor', () => {
  assert.equal((html.match(/id="logPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="logBody"/g) || []).length, 1);
  assert.equal((html.match(/id="logNext"/g) || []).length, 1);
  assert.match(html, /id="logTitle"[^>]*>请求日志<\/h2>/);
  assert.match(html, /id="logSectionStatus"[^>]+aria-live="polite">当前板块：请求日志<\/span>/);
  const switchSection = html.slice(html.indexOf('async function switchSection'), html.indexOf('async function loadLogs'));
  assert.match(switchSection, /LOG_QUERY_ID\+\+;\s*\$\('#consolePanel'\)\.hidden=!isConsole;\$\('#logPanel'\)\.hidden=isConsole/);
  assert.match(switchSection, /setAttribute\('aria-pressed',String\(section===name\)\)/);
  assert.match(switchSection, /\$\('#logType'\)\.value=type/);
  assert.match(switchSection, /await loadLogs\(false\)/);
  const loadLogs = html.slice(html.indexOf('async function loadLogs'), html.indexOf('async function clearLogs'));
  assert.match(loadLogs, /const type=\$\('#logType'\)\.value; if\(!next\)LOG_CURSOR=null/);
  assert.match(loadLogs, /const queryId=\+\+LOG_QUERY_ID/);
  assert.match(loadLogs, /if\(LOG_CURSOR\)params\.set\('cursor',LOG_CURSOR\)/);
  assert.match(loadLogs, /api\(`\/api\/logs\/\$\{type\}\?\$\{params\}`\)/);
  assert.match(loadLogs, /if\(queryId!==LOG_QUERY_ID\|\|type!==\$\('#logType'\)\.value\)return/);
  const clearLogs = html.slice(html.indexOf('async function clearLogs'), html.indexOf('function accMsg'));
  assert.match(clearLogs, /const type=\$\('#logType'\)\.value/);
  assert.match(clearLogs, /api\('\/api\/logs\/'\+type,null,'DELETE'\)/);
  assert.match(clearLogs, /if\(\$\('#logPanel'\)\.hidden\|\|type!==\$\('#logType'\)\.value\)return;await loadLogs\(\)/);
});
