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

test('top navigation switches four mutually exclusive panels without anchor or scroll shortcuts', () => {
  assert.match(html, /<nav class="section-nav" aria-label="顶层板块">/);
  for (const [id, section, pressed, label] of [['navConsole','console','true','控制台'],['navStatistics','statistics','false','统计'],['navRequests','requests','false','请求日志'],['navErrors','errors','false','错误日志']]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]+type="button"[^>]+aria-pressed="${pressed}"[^>]+onclick="switchSection\\('${section}'\\)"[^>]*>${label}<\\/button>`));
  }
  assert.equal((html.match(/id="consolePanel"/g) || []).length, 1);
  assert.equal((html.match(/id="statisticsPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="logPanel"/g) || []).length, 1);
  assert.match(html, /<section id="statisticsPanel" aria-labelledby="statisticsTitle" hidden>/);
  assert.match(html, /<section id="logPanel" aria-labelledby="logTitle" hidden>/);
  assert.match(html, /<\/section>\s*<section id="consolePanel">[\s\S]+<\/section>\s*<div id="accountDrawerBackdrop"/);
  assert.ok(html.indexOf('<nav class="section-nav"') < html.indexOf('<section id="statisticsPanel"'));
  assert.doesNotMatch(html, /scrollIntoView/);
  assert.doesNotMatch(html, /href="#(?:log|console|statistics)/);
});

test('request and error sections share one log view and reset the selected type cursor', () => {
  assert.equal((html.match(/id="logPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="logBody"/g) || []).length, 1);
  assert.equal((html.match(/id="logNext"/g) || []).length, 1);
  assert.match(html, /id="logTitle"[^>]*>请求日志<\/h2>/);
  assert.match(html, /id="logSectionStatus"[^>]+aria-live="polite">当前板块：请求日志<\/span>/);
  const switchSection = html.slice(html.indexOf('async function switchSection'), html.indexOf('async function loadLogs'));
  assert.match(switchSection, /LOG_QUERY_ID\+\+;STATISTICS_QUERY_ID\+\+;/);
  assert.match(switchSection, /\$\('#consolePanel'\)\.hidden=!isConsole;\$\('#statisticsPanel'\)\.hidden=!isStatistics;\$\('#logPanel'\)\.hidden=isConsole\|\|isStatistics/);
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

test('error rule presets, pipeline controls and statistics rendering retain strict boundaries', () => {
  for (const id of ['standard','fast','conservative','observe','clear']) assert.match(html, new RegExp(`${id}:\\{`));
  const errorPresets = html.slice(html.indexOf('const ERROR_RULE_PRESETS='), html.indexOf('function previewErrorPreset'));
  assert.doesNotMatch(errorPresets, /401|403/);
  assert.match(errorPresets, /standard:\{429:\{action:'cooldown',cooldownMs:1800000\}\}/);
  assert.match(errorPresets, /fast:\{429:\{action:'cooldown',cooldownMs:300000\},500:\{action:'cooldown',cooldownMs:60000\}/);
  assert.match(errorPresets, /conservative:\{429:\{action:'cooldown',cooldownMs:3600000\},500:\{action:'cooldown',cooldownMs:300000\}/);
  assert.match(errorPresets, /observe:\{429:\{action:'ignore'\},500:\{action:'ignore'\}/);
  const schedulingPresets = html.slice(html.indexOf('const PRESETS='), html.indexOf('function previewPreset'));
  assert.doesNotMatch(schedulingPresets, /401|403/);
  assert.match(html, /function previewErrorPreset\(\).*JSON\.parse\(\$\('#accountErrorRules'\)\.value/);
  assert.match(html, /const next=replace\?\{\.\.\.preset\}:\{\.\.\.current,\.\.\.preset\}/);
  assert.match(html, /const groups=\{保留:\[\],新增:\[\],修改:\[\],删除:\[\]\}/);
  for (const branch of ['groups.新增.push','groups.删除.push','groups.保留.push','groups.修改.push']) assert.match(html, new RegExp(branch.replace('.', '\\.')));
  assert.match(html, /name==='clear'\|\|\$\('#errorPresetReplace'\)\.checked/);
  assert.match(html, /function closeErrorPreset\(\).*PENDING_ERROR_PRESET=null/);
  assert.match(html, /applyErrorPreset\(\).*JSON\.stringify\(next,null,2\);await saveAccounts\(\)/);
  for (const id of ['pipelineExcludeUnhealthy','pipelineQuotaPool','pipelineHealthSort','pipelineSticky']) assert.match(html, new RegExp(`id="${id}"`));
  const collect = html.slice(html.indexOf('function collectAccounts'), html.indexOf('async function saveAccounts'));
  for (const field of ['id:a.id','name:a.name',"note:a.note||''","key:a.key||''",'enabled:a.enabled!==false','maxConcurrent:','weight:','priority:',"proxyUrl:a.proxyUrl||''","headers:a.headers||{}","perModel:a.perModel||{}"] ) assert.ok(collect.includes(field), `full account snapshot must preserve ${field}`);
  assert.match(collect, /accountPipeline:\{quotaPool:[^}]+excludeUnhealthy:[^}]+healthSort:[^}]+sticky:/);
  assert.match(html, /api\('\/api\/statistics'\)/);
  assert.match(html, /id="statisticsStatus"[^>]+aria-live="polite"/);
  assert.match(html, /cacheTokenRatio/); assert.match(html, /cacheHitRequestRate/);
  assert.match(html, /每次 HTTP attempt 仅发送一个 provider\.only/);
  assert.match(html, /function providerHealthView\(state\)/);assert.match(html, /degraded: '⚠退化'/);assert.match(html, /⏸冷却/);assert.match(html, /◐待半开/);
  const providerOrder = html.slice(html.indexOf('function sortedUpstreams'), html.indexOf('function upstreamOptions'));
  assert.doesNotMatch(providerOrder, /\.sort\(/);assert.match(providerOrder, /meta && meta\.upstreams/);
  assert.match(html, /coverage!==undefined&&Number\(coverage\)===0\)\?'无数据'/);
  assert.match(html, /value===null\|\|value===undefined/);
  const statistics = html.slice(html.indexOf('function statisticValue'), html.indexOf('async function switchSection'));
  assert.match(statistics, /escapeHtml\(a\.name\)/);assert.match(statistics, /escapeHtml\(a\.id\)/);assert.match(statistics, /escapeHtml\(a\.health\.status\)/);assert.match(statistics, /escapeHtml\(a\.quota\.pool\)/);
  assert.doesNotMatch(statistics, /\.key\b|proxyUrl|\.headers\b|\.note\b|rawResponse|rawTrace|session|message/);
});
