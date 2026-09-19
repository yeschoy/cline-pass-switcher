import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('console exposes seven bounded presets and accessible account drawer/log/alias views', () => {
  for (const id of ['stable','throughput','even','quota','failover','safe','cache']) assert.match(html, new RegExp(`${id}:\\{`));
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

test('top navigation switches five mutually exclusive sections without anchor or scroll shortcuts', () => {
  assert.match(html, /<nav class="section-nav" aria-label="顶层板块">/);
  for (const [id, section, pressed, label] of [['navConsole','console','true','控制台'],['navStatistics','statistics','false','统计'],['navRequests','requests','false','请求日志'],['navErrors','errors','false','错误日志'],['navDetails','details','false','详细日志']]) {
    assert.match(html, new RegExp(`<button id="${id}"[^>]+type="button"[^>]+aria-pressed="${pressed}"[^>]+onclick="switchSection\\('${section}'\\)"[^>]*>${label}<\\/button>`));
  }
  assert.equal((html.match(/id="consolePanel"/g) || []).length, 1);
  assert.equal((html.match(/id="statisticsPanel"/g) || []).length, 1);
  assert.equal((html.match(/id="detailsPanel"/g) || []).length, 1);
  assert.match(html, /<section id="detailsPanel" aria-labelledby="detailsTitle" hidden>/);
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
  assert.match(html, /id="logTitle"[^>]*>最终请求结果（每个请求一条）<\/h2>/);
  assert.match(html, /id="logSectionStatus"[^>]+aria-live="polite">当前板块：请求日志<\/span>/);
  assert.match(html, /id="logDescription"[^>]*>展示最终请求结果，每个请求一条；旧记录可能缺少 result/);
  assert.match(html, /上游失败尝试（同一请求可能多条）/);
  assert.match(html, /数量不等于失败请求数/);
  assert.match(html, /id="logResult"/);
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
  assert.match(loadLogs, /params\.set\('result',\$\('#logResult'\)\.value\)/);
  assert.match(loadLogs, /x\.result\|\|legacyResult/);
  assert.match(loadLogs, /legacy_failed/);
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
  assert.match(html, /id="errorRuleBody"/);assert.match(html,/id="errorRuleFeedback" aria-live="polite"/);assert.match(html,/onclick="addStatusErrorRule\(\)"/);assert.match(html,/onclick="addContentErrorRule\(\)"/);
  assert.match(html, /function previewErrorPreset\(\).*cloneRuleDraft\(\)/);
  assert.match(html, /const next=replace\?\{\.\.\.preset\}:\{\.\.\.current,\.\.\.preset\}/);
  assert.match(html, /const groups=\{保留:\[\],新增:\[\],修改:\[\],删除:\[\]\}/);
  for (const branch of ['groups.新增.push','groups.删除.push','groups.保留.push','groups.修改.push']) assert.match(html, new RegExp(branch.replace('.', '\\.')));
  assert.match(html, /name==='clear'\|\|\$\('#errorPresetReplace'\)\.checked/);
  assert.match(html, /function closeErrorPreset\(\).*PENDING_ERROR_PRESET=null/);
  assert.match(html, /applyErrorPreset\(\).*commitErrorRuleDraft\(next/);
  assert.match(html,/onclick="moveContentErrorRule\(\$\{index\},-1,this\)"/);assert.match(html,/data-content-rule-index/);assert.match(html,/focusTarget\.focus\(\)/);
  assert.match(html,/<details id="advancedErrorRules"[^>]+ontoggle="if\(this.open\)openAdvancedErrorRules\(\)"/);assert.match(html,/id="advancedErrorRulesJson"[^>]+oninput="markAdvancedErrorRulesDirty\(\)"/);assert.match(html,/function openAdvancedErrorRules\(\).*advancedErrorRulesJson'\)\.focus\(\)/);assert.match(html,/function applyAdvancedErrorRules\(\)/);assert.match(html,/snapshot.generation!==ERROR_RULE_GENERATION/);
  for (const id of ['pipelineExcludeUnhealthy','pipelineQuotaPool','pipelineHealthSort','pipelineSticky']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html,/可排序账号调度流水线/); assert.equal((html.match(/class="pipeline-step" draggable="true"/g)||[]).length,4);
  assert.equal((html.match(/class="ghost pipeline-move-up"/g)||[]).length,4); assert.equal((html.match(/class="ghost pipeline-move-down"/g)||[]).length,4);
  assert.match(html,/id="pipelineOrderStatus" aria-live="polite"/); assert.match(html,/越靠前优先级越高/);
  for(const handler of ['startPipelineDrag','dropPipelineDrag','movePipelineStep','syncPipelineOrder'])assert.match(html,new RegExp(`function ${handler}\\(`));
  assert.match(html,/onclick="movePipelineStep\('quotaPool',-1,this\)"/,'native move buttons pass their focus target to production reorder logic');
  assert.match(html,/const opposite=row\?\.querySelector\(direction<0\?'\.pipeline-move-down':'\.pipeline-move-up'\)/);
  assert.match(html,/const target=button\.disabled\?opposite:button/,'boundary moves transfer focus to the enabled opposite-direction button');
  const collect = html.slice(html.indexOf('function collectAccounts'), html.indexOf('async function saveAccounts'));
  for (const field of ['id:a.id','name:a.name',"note:a.note||''","key:a.key||''",'enabled:a.enabled!==false','maxConcurrent:','weight:','priority:',"proxyUrl:a.proxyUrl||''","headers:a.headers||{}","perModel:a.perModel||{}"] ) assert.ok(collect.includes(field), `full account snapshot must preserve ${field}`);
  assert.match(collect,/accountErrorRules:rules.statusRules/);assert.match(collect,/accountContentErrorRules:rules.contentRules/);
  assert.match(collect, /accountPipeline:\{quotaPool:[^}]+excludeUnhealthy:[^}]+healthSort:[^}]+sticky:[^}]+order:pipelineOrder\(\),cachePoolSize:/);
  assert.match(html,/id="cachePoolSize" type="number" min="0" max="100000" step="1"/);assert.match(html,/0 = 关闭/);assert.match(html,/仅在 sticky 模式或启用会话粘性步骤时生效/);
  assert.match(html,/cachePoolRole==='active'/);assert.match(html,/缓存活跃/);assert.match(html,/缓存备用/);
  assert.match(html, /api\('\/api\/statistics'\)/);
  assert.match(html, /id="statisticsStatus"[^>]+aria-live="polite"/);
  assert.match(html, /24h 缓存 Token 占比/);
  assert.match(html, /modelCacheMetric/);
  const modelRenderer=html.slice(html.indexOf('function modelCacheMetric'),html.indexOf('function renderCatalog'));
  assert.match(modelRenderer,/cacheTokenRatio/);assert.match(modelRenderer,/cacheInputKnownRequests/);assert.doesNotMatch(modelRenderer,/cacheHitRequestRate/);
  assert.match(html, /cacheTokenRatio/); assert.match(html, /cacheHitRequestRate/);
  assert.match(html, /coverage!==undefined&&Number\(coverage\)===0\)\?'无数据'/);
  assert.match(html, /value===null\|\|value===undefined/);
  const statistics = html.slice(html.indexOf('function statisticValue'), html.indexOf('async function switchSection'));
  assert.match(statistics, /escapeHtml\(a\.name\)/);assert.match(statistics, /escapeHtml\(a\.id\)/);assert.match(statistics, /escapeHtml\(a\.health\.status\)/);assert.match(statistics, /escapeHtml\(a\.quota\.pool\)/);
  assert.doesNotMatch(statistics, /\.key\b|proxyUrl|\.headers\b|\.note\b|rawResponse|rawTrace|session|message/);
});

test('statistics quota controls expose labelled lifecycle, truthful units and cancellation guards', () => {
  assert.match(html, /id="statisticsRefresh"[^>]+type="button"[^>]+aria-describedby="statisticsQuotaHelp"[^>]+onclick="refreshStatisticsQuota\(true\)"/);
  assert.match(html, /进入本页及停留期间每 5 分钟刷新启用且已配置的账号额度/);assert.match(html,/查看额度不会启用额度池路由/);
  assert.match(html, /额度 5 小时\/周\/月/);assert.match(html, /table style="min-width:1500px"/);
  const statistics=html.slice(html.indexOf('function statisticValue'),html.indexOf('async function switchSection'));
  for(const label of ['剩余','重置时间','未提供','未知','部分可用','刷新失败','过期 · 上次快照','已禁用 · 上次额度','未配置','上次成功','等待刷新','刷新中'])assert.ok(statistics.includes(label),label);
  const quotaLimit=html.slice(html.indexOf('function quotaLimit'),html.indexOf('const QUOTA_FORECAST_TYPES'));
  assert.doesNotMatch(quotaLimit,/已用/);
  assert.match(statistics,/typeof used!==['"]number['"]\|\|!Number\.isFinite\(used\)\|\|used<0\|\|used>100/);
  assert.match(statistics,/\(100-used\)\.toFixed\(1\)/);assert.match(statistics,/api\('\/api\/statistics\/quota-refresh',\{force\}/);
  assert.match(statistics,/new AbortController\(\)/);assert.match(statistics,/signal:controller\.signal/);assert.match(html,/async function api\(path, body, method, asText=false, options=\{\}\)/);
  assert.match(html,/STATISTICS_REFRESH_MS = 5 \* 60 \* 1000/);assert.match(statistics,/window\.addEventListener\('pagehide',stopStatisticsVisit\)/);assert.match(statistics,/window\.addEventListener\('pageshow',restoreStatisticsVisit\)/);
  assert.match(statistics,/STATISTICS_TIMER===null\)return startStatisticsVisit\(\)/);assert.match(statistics,/STATISTICS_REFRESH_CONTROLLER\?\.abort\(\)/);assert.match(statistics,/visitId!==STATISTICS_VISIT_ID/);
  assert.match(statistics,/controller!==STATISTICS_REFRESH_CONTROLLER/);assert.match(statistics,/STATISTICS_REFRESH_PROMISE&&STATISTICS_REFRESH_VISIT===visitId/);
});

test('statistics quota forecast is a labelled responsive four-card projection with truthful units', () => {
  assert.match(html,/class="quota-forecast" role="region" aria-labelledby="statisticsQuotaForecastTitle"/);
  assert.match(html,/id="statisticsQuotaForecastTitle">总可用额度预测<\/h3>/);
  assert.match(html,/id="statisticsQuotaForecast" class="quota-forecast-grid" aria-live="polite"/);
  for(const [id,label] of [['statisticsQuotaCurrent','当前'],['statisticsQuota2h','未来 2h'],['statisticsQuota8h','未来 8h'],['statisticsQuota24h','未来 24h']])assert.match(html,new RegExp(`<h4>${label}<\\/h4><p id="${id}">无可用数据<\\/p>`));
  assert.match(html,/\.quota-forecast-grid \{[^}]*grid-template-columns: repeat\(auto-fit,minmax\(/);
  assert.ok(html.indexOf('id="statisticsSummary"')<html.indexOf('id="statisticsQuotaForecast"'));
  assert.ok(html.indexOf('id="statisticsQuotaForecast"')<html.indexOf('<div class="table-wrap"><table style="min-width:1500px"'));
  for(const wording of ['账号等效百分比容量','最多 100 账号额度点','不代表 Token、请求数、金额','无新增消耗','预测下限','重置时间不完整'])assert.ok(html.includes(wording),wording);
  const renderer=html.slice(html.indexOf('function renderStatisticsQuotaForecast'),html.indexOf('function quotaState'));
  assert.match(renderer,/\.textContent=/);assert.doesNotMatch(renderer,/innerHTML/);
  const loadStatistics=html.slice(html.indexOf('async function loadStatistics'),html.indexOf('function quotaRefreshSummary'));
  assert.match(loadStatistics,/renderStatisticsQuotaForecast\(data\)/);
});

test('bulk concurrency uses labelled native controls, bounded input and persistent draft guidance', () => {
  assert.match(html, /id="bulkSelectAll" type="checkbox" onchange="selectAllAccounts\(this.checked\)"> 选择当前搜索结果全部账号/);
  assert.match(html, /<label for="bulkConcurrency">/);
  assert.match(html, /id="bulkConcurrency" type="number" min="0" max="100000" step="1"/);
  assert.match(html, /id="bulkApply" type="button"[^>]+ disabled/);
  assert.match(html, /aria-label="批量选择 \$\{escapeHtml\(a.name\)\}"/);
  for (const id of ['bulkSummary','bulkFeedback']) assert.match(html, new RegExp(`id="${id}" aria-live="polite"`));
  assert.match(html, /批量应用仅更新草稿，尚未生效/);
  assert.match(html, /id="accSearch"[^>]+oninput="clearBulkSelection\(\)"/);
  assert.match(html, /id="accMode" onchange="renderAccounts\(\)"/);
});


test('raw scheduling editor uses a labelled native modal, draft guidance and announced feedback', () => {
  assert.match(html, /id="rawSchedulingOpen" type="button"[^>]+onclick="openRawScheduling\(this\)"/);
  assert.match(html, /<dialog id="rawSchedulingDialog" aria-labelledby="rawSchedulingTitle" aria-describedby="rawSchedulingHelp"/);
  assert.match(html, /<label for="rawSchedulingJson">/);
  assert.match(html, /id="rawSchedulingJson"[^>]+overflow-wrap:anywhere/);
  for (const id of ['rawSchedulingError','rawSchedulingFeedback']) assert.match(html,new RegExp(`id="${id}" aria-live="polite"`));
  assert.match(html,/accountNames 为全部账号的只读参考名称（可重复），不可修改/);
  assert.match(html,/策略全局适用于账号池/);assert.match(html,/priority 越小越优先/);assert.match(html,/reserve/);assert.match(html,/备用溢出/);
  const raw=html.slice(html.indexOf('const RAW_PIPELINE_CONTROLS'),html.indexOf('function collectAccounts'));
  assert.match(raw,/accountPipeline\.order=pipelineOrder\(\)/);assert.match(raw,/accountPipeline\.cachePoolSize=/);assert.match(raw,/value\.accountPipeline\.cachePoolSize/); assert.match(raw,/validPipelineOrder\(value\.accountPipeline\.order\)/); assert.match(raw,/setPipelineOrder\(value\.accountPipeline\.order\)/);
});

test('detailed logs have independent labelled controls, privacy/retention guidance and safe on-demand text', () => {
  assert.match(html, /<label for="detailedLogging"><input id="detailedLogging" type="checkbox" disabled/);
  assert.match(html, /5 MiB/); assert.match(html, /7 天 \/ 1 GiB/); assert.match(html, /不提交账号草稿/);
  assert.match(html, /id="detailsStatus" aria-live="polite"/);
  assert.match(html, /<label for="detailsText">/); assert.match(html, /<textarea id="detailsText" readonly/);
  assert.match(html, /id="detailsCopy"[^>]+disabled/);
  const detailCode = html.slice(html.indexOf('let DETAIL_SETTINGS_ID'), html.indexOf('async function loadLogs'));
  assert.doesNotMatch(detailCode, /loadAll\(|saveAccounts\(/);
  assert.match(detailCode, /DETAIL_LIST_ID/); assert.match(detailCode, /DETAIL_SELECTION_ID/); assert.match(detailCode, /DETAIL_SETTINGS_ID/);
  assert.match(detailCode, /detailsMetadata'\)\.textContent=JSON\.stringify/);
  assert.match(detailCode, /detailsText'\)\.value=text/);
  assert.match(detailCode, /navigator\.clipboard\.writeText\(text\)/);
});
