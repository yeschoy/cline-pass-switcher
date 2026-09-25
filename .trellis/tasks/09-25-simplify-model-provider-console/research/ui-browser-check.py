"""Local-only production-console Chromium smoke/DOM probe.
Run from repo root with the archived pricing browser fixture's exact loopback URL:
python3 .trellis/tasks/09-25-simplify-model-provider-console/research/ui-browser-check.py http://127.0.0.1:<port>/ [dense]
After this task is archived, add archive/2026-09/ before its task directory in this command.
The optional dense run injects 200 synthetic model projections, each with 10 synthetic channels, into this browser's authenticated statistics read. It is display workload only, not a usage ledger.
"""
import copy
import json
import re
import sys
import time
from playwright.sync_api import expect, sync_playwright

match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/', sys.argv[1]) if len(sys.argv) in (2, 3) else None
if not match or int(match.group(1)) > 65535 or (len(sys.argv) == 3 and sys.argv[2] != 'dense'):
    raise SystemExit('expected exact loopback fixture URL and optional dense')
dense = len(sys.argv) == 3
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    cdp = page.context.new_cdp_session(page)
    cdp.send('Performance.enable')
    metrics = lambda: {m['name']: m['value'] for m in cdp.send('Performance.getMetrics')['metrics']}
    reads = [0]
    def statistics(route):
        reads[0] += 1
        response = route.fetch()
        if not dense:
            route.fulfill(response=response)
            return
        data = response.json()
        template = next(m for m in data['models'] if m['id'] == 'cline-pass/deepseek-v4.1-flash')
        models = []
        for i in range(200):
            model = copy.deepcopy(template)
            model['id'] = f'cline-pass/synthetic-model-{i:03}'
            provider = model['providerStatistics']['providers'][0]
            model['providerStatistics']['providers'] = [dict(copy.deepcopy(provider), id=f'synthetic-channel-{j}') for j in range(10)]
            models.append(model)
        data['models'] = models
        route.fulfill(response=response, json=data)
    page.route('**/api/statistics', statistics)
    page.goto(sys.argv[1], wait_until='domcontentloaded')
    page.locator('#loginKey').fill('fixture-independent-admin-password')
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#loginOverlay').wait_for(state='hidden', timeout=15000)
    baseline_reads = reads[0]  # initial console load may already request statistics
    nav = page.locator('#navModelProviders')
    nav.focus(); before_model = metrics(); model_start = time.perf_counter(); nav.press('Enter')
    expect(nav).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#modelProvidersTitle')).to_be_focused()
    expect(page.locator('#modelProvidersStatus')).to_contain_text('模型视图 · 生成于', timeout=15000)
    model_view, channel_view = page.locator('#modelProvidersModelView'), page.locator('#modelProvidersChannelView')
    expect(model_view).to_be_visible(); expect(channel_view).to_be_hidden()
    model_count = 200 if dense else 12
    expect(page.locator('#modelProvidersBody tr')).to_have_count(model_count)
    after_model = metrics()
    model_wall = round((time.perf_counter() - model_start) * 1000, 1)
    model_task = round((after_model['TaskDuration'] - before_model['TaskDuration']) * 1000, 1)
    model_layout = round((after_model['LayoutDuration'] - before_model['LayoutDuration']) * 1000, 1)
    model_dom = page.evaluate('document.querySelectorAll("*").length')
    assert reads[0] == baseline_reads + 1
    if not dense:
        model_row = page.locator('#modelProvidersBody tr').filter(has_text='cline-pass/deepseek-v4.1-flash').first
        assert '100.0% · 1 样本' in model_row.locator('td').first.inner_text()
        assert '$0.000002259000' in model_row.inner_text() and '$0.000004518000' in model_row.inner_text()
        detail = model_row.locator('summary')
        detail.focus(); detail.press('Enter')
        expect(model_row.locator('details')).to_have_attribute('open', '')
        assert 'clinepass-2026-09-25-v2' in model_row.inner_text()
        assert '参考消费等值（USD），非订阅实际扣费' in model_row.inner_text()
    def scroll(wrapper):
        wrapper.focus()
        wrapper.evaluate('(el) => { el.scrollLeft = 0; }')
        page.wait_for_timeout(250)  # settle scroll started by focusing expanded row content
        original = wrapper.evaluate('(el) => ({left:el.scrollLeft,client:el.clientWidth,wide:el.scrollWidth})')
        wrapper.press('ArrowRight'); page.wait_for_timeout(250)
        moved = wrapper.evaluate('(el) => el.scrollLeft')
        assert original['wide'] > original['client'] and moved > original['left'], (original, moved)
        return {'client': original['client'], 'wide': original['wide']}
    width = scroll(model_view)
    tab = page.locator('#modelProvidersChannelTab')
    tab.focus(); before = metrics(); start = time.perf_counter(); tab.press('Enter')
    expect(tab).to_be_focused(); expect(tab).to_have_attribute('aria-pressed','true')
    expect(channel_view).to_be_visible(); expect(model_view).to_be_hidden()
    expect(page.locator('#modelProvidersStatus')).to_contain_text('渠道视图 · 生成于')
    expect(page.locator('#modelProvidersChannelBody tr')).to_have_count(2000 if dense else 1, timeout=30000)
    channel_dom = page.evaluate('document.querySelectorAll("*").length')
    after = metrics()
    channel_ms = round((time.perf_counter() - start) * 1000, 1)
    channel_task = round((after['TaskDuration'] - before['TaskDuration']) * 1000, 1)
    channel_layout = round((after['LayoutDuration'] - before['LayoutDuration']) * 1000, 1)
    page.locator('#modelProvidersModelTab').focus()
    page.locator('#modelProvidersModelTab').press('Enter')
    expect(page.locator('#modelProvidersModelTab')).to_be_focused()
    expect(model_view).to_be_visible()
    expect(page.locator('#modelProvidersBody tr')).to_have_count(model_count)
    expect(page.locator('#modelProvidersChannelBody tr')).to_have_count(0)
    model_return_dom = page.evaluate('document.querySelectorAll("*").length')
    assert reads[0] == baseline_reads + 1
    tab.focus(); tab.press('Enter')
    expect(page.locator('#modelProvidersChannelBody tr')).to_have_count(2000 if dense else 1)
    assert reads[0] == baseline_reads + 1
    if not dense:
        assert 'one' in page.locator('#modelProvidersChannelBody').inner_text()
        assert '100.0% · 1 样本' in page.locator('#modelProvidersChannelBody').inner_text()
        width['channel'] = scroll(channel_view)
        search = page.locator('#modelProvidersFilter')
        search.fill('not-a-model')
        expect(page.locator('#modelProvidersChannelBody tr')).to_have_count(1)
        assert '没有匹配' in page.locator('#modelProvidersChannelBody').inner_text()
        search.fill('one'); assert 'one' in page.locator('#modelProvidersChannelBody').inner_text()
        assert reads[0] == baseline_reads + 1
        page.locator('#modelProvidersModelTab').focus()
        page.locator('#modelProvidersModelTab').press('Enter')
        expect(page.locator('#modelProvidersModelTab')).to_be_focused()
        expect(model_view).to_be_visible()
        assert '没有匹配' in page.locator('#modelProvidersBody').inner_text()
        assert reads[0] == baseline_reads + 1
        search.fill(''); assert 'cline-pass/deepseek-v4.1-flash' in page.locator('#modelProvidersBody').inner_text()
        page.locator('#navConsole').click()
        expect(page.locator('#modelProvidersPanel')).to_be_hidden()
    else:
        before = metrics(); start = time.perf_counter()
        page.locator('#modelProvidersFilter').fill('synthetic-model-199')
        expect(page.locator('#modelProvidersChannelBody tr')).to_have_count(10, timeout=30000)
        after_filter = metrics()
        width['filterWallMs'] = round((time.perf_counter() - start) * 1000, 1)
        width['filterTaskMs'] = round((after_filter['TaskDuration'] - before['TaskDuration']) * 1000, 1)
        width['filterRows'] = 10
    print(json.dumps({'kind': 'ui-split-browser-dense' if dense else 'ui-split-browser-smoke',
       'chromium': browser.version, 'viewport': 390, 'modelRows':model_count,
       'modelEntryWallMs':model_wall,'modelEntryTaskMs':model_task,'modelEntryLayoutMs':model_layout,'domElementsAtModel':model_dom,
       'channelRows':2000 if dense else 1,'reads':reads[0],'width':width,
       'channelSwitchWallMs':channel_ms,'channelSwitchTaskMs':channel_task,
       'channelSwitchLayoutMs':channel_layout,
       'domElementsAtChannel':channel_dom,'domElementsAfterModelReturn':model_return_dom},ensure_ascii=False))
    browser.close()
