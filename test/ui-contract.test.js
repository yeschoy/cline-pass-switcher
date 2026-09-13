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
