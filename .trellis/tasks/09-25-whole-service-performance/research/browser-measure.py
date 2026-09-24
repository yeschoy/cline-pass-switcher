"""Local synthetic browser trace; run with URL printed by browser-fixture.mjs.

Usage: python3 .trellis/tasks/09-25-whole-service-performance/research/browser-measure.py http://127.0.0.1:<port>/
Requires already installed Playwright Chromium. Does not contact production or save credentials.
"""
import json
import re
import sys
import time
from playwright.sync_api import expect, sync_playwright

match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/', sys.argv[1]) if len(sys.argv) == 2 else None
if not match or int(match.group(1)) > 65535:
    raise SystemExit('expected the exact loopback fixture URL: http://127.0.0.1:<port>/')
url = sys.argv[1]

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 390, 'height': 850})
    page = context.new_page()
    cdp = context.new_cdp_session(page)
    cdp.send('Performance.enable')
    finished = []
    page.on('requestfinished', lambda request: finished.append({'path': request.url.split(':', 2)[-1].split('/', 1)[-1].split('?', 1)[0], 'type': request.resource_type}))

    def metrics():
        return {row['name']: row['value'] for row in cdp.send('Performance.getMetrics')['metrics']}

    def delta(before, after):
        return {key: round(after.get(key, 0) - before.get(key, 0), 4) for key in ('TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration')}

    page.goto(url, wait_until='domcontentloaded')
    page.locator('#loginKey').fill('fixture-independent-admin-password')
    before = metrics(); start = time.perf_counter()
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#loginOverlay').wait_for(state='hidden', timeout=15000)
    page.locator('#subBody tr').nth(49).wait_for(state='attached', timeout=15000)
    login_ms = round((time.perf_counter() - start) * 1000, 1)
    after = metrics()
    login_count = len(finished)
    login_paths = {}
    for item in finished:
        name = item['path']
        login_paths[name] = login_paths.get(name, 0) + 1
    initial = {
        'uiLoginAndSixReadsMs': login_ms,
        'browserCpuSeconds': delta(before, after),
        'finishedRequests': login_count,
        'requestCounts': login_paths,
        'modelRows': page.locator('#subBody tr').count(),
        'catalogRows': page.locator('#catBody tr').count(),
        'domElements': page.evaluate('document.querySelectorAll("*").length'),
        'viewport': 390,
    }

    page.locator('#catSummary').click()
    filter_box = page.locator('#catFilter')
    before = metrics(); start = time.perf_counter(); requests_before = len(finished)
    filter_box.fill('synthetic-catalog-4999')
    expect(page.locator('#catBody tr')).to_have_count(1, timeout=10000)
    expect(page.locator('#catBody')).to_contain_text('synthetic-catalog-4999', timeout=10000)
    filter_ms = round((time.perf_counter() - start) * 1000, 1)
    filter_result = {'filterToOneRowMs': filter_ms, 'browserCpuSeconds': delta(before, metrics()), 'networkRequests': len(finished)-requests_before, 'catalogRows': page.locator('#catBody tr').count()}

    before = metrics(); start = time.perf_counter(); requests_before = len(finished)
    page.locator('#navStatistics').click()
    expect(page.locator('#statisticsStatus')).to_contain_text(re.compile('生成于|刷新完成'), timeout=15000)
    stats_ms = round((time.perf_counter() - start) * 1000, 1)
    stats_result = {'statisticsTabMs': stats_ms, 'browserCpuSeconds': delta(before, metrics()), 'networkRequests': len(finished)-requests_before, 'status': page.locator('#statisticsStatus').inner_text()[:80]}

    before = metrics(); start = time.perf_counter(); requests_before = len(finished)
    page.locator('#navModelProviders').click()
    expect(page.locator('#modelProvidersStatus')).to_contain_text('生成于', timeout=15000)
    model_ms = round((time.perf_counter() - start) * 1000, 1)
    model_result = {'modelProviderTabMs': model_ms, 'browserCpuSeconds': delta(before, metrics()), 'networkRequests': len(finished)-requests_before, 'rows': page.locator('#modelProvidersBody tr').count()}
    print(json.dumps({'kind': 'local-synthetic-browser', 'chromium': browser.version, 'initial': initial, 'filter': filter_result, 'statistics': stats_result, 'modelProviders': model_result}, ensure_ascii=False, indent=2))
    browser.close()
