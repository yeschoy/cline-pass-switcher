"""Synthetic Provider-row projection on real production HTML; local loopback fixture only.
Usage: python3 .trellis/tasks/09-25-whole-service-performance/research/browser-provider-density.py http://127.0.0.1:<port>/ <providers-per-model>
The fixture should be launched with CPS_LOCAL_MODEL_COUNT=200 for a larger DOM.
"""
import json
import re
import sys
import time
from playwright.sync_api import expect, sync_playwright

match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/', sys.argv[1]) if len(sys.argv) == 3 else None
if not match or int(match.group(1)) > 65535 or not sys.argv[2].isdigit() or not 0 <= int(sys.argv[2]) <= 10:
    raise SystemExit('expected exact loopback fixture URL and provider count 0..10')
url, count = sys.argv[1], int(sys.argv[2])
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 850})
    page = context.new_page()
    cdp = context.new_cdp_session(page)
    cdp.send('Performance.enable')
    measure = lambda: {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#loginKey').fill('fixture-independent-admin-password')
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#loginOverlay').wait_for(state='hidden', timeout=15000)
    page.locator('#subBody tr').nth(49).wait_for(state='attached', timeout=15000)
    def add_providers(route):
        response = route.fetch()
        data = response.json()
        for model in data.get('models', []):
            projection = model.get('providerStatistics') or {}
            projection['providers'] = [
                {'id': f'synthetic-provider-{i}', 'health': {'successRate': .9, 'successes': 9, 'samples': 10, 'coverageComplete': True},
                 'usage': {'requests': 10, 'inputTokens': 0, 'inputKnownRequests': 1, 'outputTokens': 0, 'outputKnownRequests': 1,
                           'totalTokens': 0, 'totalKnownRequests': 1, 'cachedTokens': 0, 'cacheKnownRequests': 1,
                           'cacheInputKnownRequests': 1, 'cacheHitRequestRate': 0, 'cacheTokenRatio': 0},
                 'coverage': {'complete': True}, 'valuation': {'versions': {}, 'complete': False}} for i in range(count)
            ]
            model['providerStatistics'] = projection
        route.fulfill(response=response, json=data)
    page.route('**/api/statistics', add_providers)
    before = measure(); start = time.perf_counter()
    page.locator('#navModelProviders').click()
    expect(page.locator('#modelProvidersStatus')).to_contain_text('生成于', timeout=15000)
    elapsed_ms = round((time.perf_counter()-start)*1000, 1)
    after = measure()
    rows = page.locator('#modelProvidersBody tr').count()
    if rows != page.locator('#subBody tr').count() * (count + 1):
        raise RuntimeError(f'unexpected row count {rows}')
    first = {'tabWallMs': elapsed_ms, 'browserTaskMs': round((after['TaskDuration']-before['TaskDuration'])*1000,1),
             'layoutMs': round((after['LayoutDuration']-before['LayoutDuration'])*1000,1), 'rows': rows,
             'domElements': page.evaluate('document.querySelectorAll("*").length')}
    before = measure(); start = time.perf_counter()
    page.locator('#modelProvidersFilter').fill('synthetic-model-199')
    expect(page.locator('#modelProvidersBody tr')).to_have_count(count+1, timeout=15000)
    after = measure()
    second = {'filterWallMs': round((time.perf_counter()-start)*1000,1),
              'browserTaskMs': round((after['TaskDuration']-before['TaskDuration'])*1000,1),
              'rows': page.locator('#modelProvidersBody tr').count()}
    print(json.dumps({'kind':'local-synthetic-provider-browser','chromium':browser.version,'models':page.locator('#subBody tr').count(),
                      'providersPerModel':count,'tab':first,'filter':second},ensure_ascii=False,indent=2))
    browser.close()
