"""Local price UI acceptance using installed Playwright Chromium.
Run: python3 .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/price-browser-check.py http://127.0.0.1:<printed-port>/
Only accepts the exact loopback URL emitted by price-browser-fixture.mjs.
"""
import json
import re
import sys
from playwright.sync_api import expect, sync_playwright

match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/', sys.argv[1]) if len(sys.argv) == 2 else None
if not match or int(match.group(1)) > 65535:
    raise SystemExit('expected exact loopback fixture URL')
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    page.goto(sys.argv[1], wait_until='domcontentloaded')
    page.locator('#loginKey').fill('fixture-independent-admin-password')
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#loginOverlay').wait_for(state='hidden', timeout=15000)
    nav = page.locator('#navModelProviders')
    nav.focus()
    nav.press('Enter')
    expect(nav).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#modelProvidersStatus')).to_contain_text('生成于', timeout=15000)
    expect(page.locator('#modelProvidersTitle')).to_be_focused()
    summary=page.get_by_text('当前模型参考单价（USD / 百万 Token）与来源')
    summary.click()
    expect(page.locator('#modelProvidersTariffs tr')).to_have_count(12)
    flash=page.locator('#modelProvidersTariffs tr').filter(has_text='cline-pass/deepseek-v4.1-flash')
    text=flash.inner_text()
    assert '低峰：0.15 / 0.6 / 0.003 / —' in text and '高峰：0.3 / 1.2 / 0.006 / —' in text
    assert 'api-docs.deepseek.com/quick_start/pricing/' in text
    qwen=page.locator('#modelProvidersTariffs tr').filter(has_text='cline-pass/qwen3.7-plus').inner_text()
    assert '上下文档位与缓存写计数未知' in qwen and '3.125' not in qwen
    model=page.locator('#modelProvidersBody tr').filter(has_text='cline-pass/deepseek-v4.1-flash').first.inner_text()
    assert '$0.000002259000' in model and '$0.000004518000' in model and '峰谷参考区间' in model
    assert '已计 1 / 1 最终成功请求' in model
    wrap=page.locator('#modelProvidersTariffs').locator('xpath=ancestor::div[contains(@class,"table-wrap")]')
    before=wrap.evaluate('(element) => ({client: element.clientWidth, scroll: element.scrollWidth, left: element.scrollLeft})')
    wrap.focus(); wrap.press('ArrowRight')
    page.wait_for_timeout(250)  # allow native smooth scrolling to settle
    after=wrap.evaluate('(element) => element.scrollLeft')
    assert before['scroll'] > before['client'] and after > before['left'], (before,after)
    page.locator('#navStatistics').click()
    expect(page.locator('#statisticsQuotaCurrent')).to_contain_text('当月剩余：约 $40.00', timeout=15000)
    print(json.dumps({'kind':'local-price-browser','chromium':browser.version,'viewport':390,'tariffRows':12,
        'deepseekRange':True,'keyboardNav':True,'narrowTariffScroll':True,'monthlyQuotaReference':'$40.00'},ensure_ascii=False))
    browser.close()
