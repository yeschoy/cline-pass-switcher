"""Local-only Chromium acceptance for client-key management.
Run from repo root with archived pricing task's synthetic loopback fixture:
python3 .trellis/tasks/09-25-multi-client-key-routing/research/key-browser-check.py http://127.0.0.1:<port>/
Prints no credentials, never connects to production or paid upstreams.
"""
import json
import re
import sys
from playwright.sync_api import expect, sync_playwright

match = re.fullmatch(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/', sys.argv[1]) if len(sys.argv) == 2 else None
if not match or int(match.group(1)) > 65535:
    raise SystemExit('expected exact loopback fixture URL')
url = sys.argv[1]
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 390, 'height': 850})
    # Exercise the clipboard rejection/fallback path in a real browser.
    page.add_init_script("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied')}}});")
    page.goto(url, wait_until='domcontentloaded')
    page.locator('#loginKey').fill('fixture-independent-admin-password')
    page.locator('#loginForm button[type=submit]').click()
    page.locator('#loginOverlay').wait_for(state='hidden', timeout=15000)
    expect(page.locator('#clientKeyBody tr')).to_have_count(1)
    assert 'Legacy' in page.locator('#clientKeyBody').inner_text()
    name = page.locator('#newClientKeyName')
    name.fill('Synthetic Team')
    name.press('Tab')
    create = page.get_by_role('button', name='创建并显示一次密钥')
    expect(create).to_be_focused()
    create.press('Enter')
    dialog = page.locator('#clientKeySecretDialog')
    expect(dialog).to_be_visible(timeout=15000)
    expect(page.locator('#clientKeySecret')).to_be_focused()
    first = page.locator('#clientKeySecret').input_value()
    assert first.startswith('cps_') and len(first) == 68
    assert first not in page.locator('#clientKeyBody').inner_text()
    page.get_by_role('button', name='复制密钥').click()
    expect(page.locator('#clientKeyCopyStatus')).to_contain_text('手动复制')
    selected = page.locator('#clientKeySecret').evaluate('(el) => el.selectionEnd - el.selectionStart')
    assert selected == len(first)
    page.locator('#clientKeySecret').press('Escape')
    expect(dialog).to_be_hidden()
    assert page.locator('#clientKeySecret').input_value() == ''
    expect(name).to_be_focused()
    expect(page.locator('#clientKeyBody tr')).to_have_count(2)
    team_id = page.locator('#clientKeyBody tr').nth(1).locator('td').nth(1).inner_text()
    assert team_id.startswith('ck_') and first not in page.locator('#clientKeyBody').inner_text()
    wrapper = page.locator('#clientKeyBody').locator('xpath=ancestor::div[contains(@class,"table-wrap")]')
    wrapper.focus(); wrapper.evaluate('(el)=>{el.scrollLeft=0}')
    page.wait_for_timeout(250)
    before = wrapper.evaluate('(el)=>({left:el.scrollLeft,width:el.clientWidth,scroll:el.scrollWidth})')
    wrapper.press('ArrowRight'); page.wait_for_timeout(250)
    assert before['scroll'] > before['width'] and wrapper.evaluate('(el)=>el.scrollLeft') > before['left']
    rotate = page.locator(f'#clientKeyRotate-{team_id}')
    page.once('dialog', lambda native: native.accept())
    rotate.click()
    expect(dialog).to_be_visible(timeout=15000)
    second = page.locator('#clientKeySecret').input_value()
    assert second.startswith('cps_') and second != first
    page.get_by_role('button', name='关闭并清除').click()
    focus_after_close = page.evaluate('({id:document.activeElement?.id||"",tag:document.activeElement?.tagName||""})')
    assert focus_after_close['id'] == f'clientKeyRotate-{team_id}', focus_after_close
    assert page.locator('#clientKeySecret').input_value() == ''
    assert page.request.get(url+'models', headers={'Authorization':'Bearer '+first}).status == 401
    assert page.request.get(url+'models', headers={'Authorization':'Bearer '+second}).status == 200
    # Draft owner and hidden fields survive redraw/search; only explicit save persists.
    settings = page.locator('#accBody tr').first.get_by_role('button',name='设置')
    settings.focus(); settings.press('Enter')
    expect(page.locator('#drawerName')).to_be_focused()
    drawer = page.locator('#drawerClientKeyId')
    expect(drawer).to_have_value('legacy')
    drawer.select_option(team_id)
    page.locator('#drawerNote').fill('local synthetic owner note')
    page.get_by_role('button', name='保存草案').click()
    page.locator('#accSearch').fill('missing-account')
    assert '无匹配账号' in page.locator('#accBody').inner_text()
    page.locator('#accSearch').fill('')
    assert 'Synthetic Team' in page.locator('#accBody').inner_text()
    draft = page.evaluate("(() => { const a=collectAccounts().accounts[0]; return {owner:a.clientKeyId,note:a.note,hasHeaders:typeof a.headers==='object',hasPerModel:typeof a.perModel==='object'}; })()")
    assert draft == {'owner':team_id,'note':'local synthetic owner note','hasHeaders':True,'hasPerModel':True}
    page.get_by_role('button',name='保存账号配置').click()
    expect(page.locator('#accBody')).to_contain_text('Synthetic Team', timeout=15000)
    assert page.request.post(url+'v1/chat/completions', headers={'Authorization':'Bearer '+second}, data={'model':'cline-pass/glm-5.3','messages':[{'role':'user','content':'synthetic'}]}).status == 200
    page.once('dialog', lambda native: native.accept())
    page.locator('#clientKeyBody tr').nth(1).get_by_role('button',name='撤销').click()
    expect(page.locator('#clientKeysStatus')).to_contain_text('reassign', timeout=15000)
    expect(page.locator('#clientKeyBody tr')).to_have_count(2)
    page.locator('#accBody tr').first.get_by_role('button',name='设置').click()
    page.locator('#drawerClientKeyId').select_option('legacy')
    page.get_by_role('button', name='保存草案').click()
    page.get_by_role('button',name='保存账号配置').click()
    expect(page.locator('#accBody')).to_contain_text('Legacy', timeout=15000)
    page.once('dialog', lambda native: native.accept())
    page.locator('#clientKeyBody tr').nth(1).get_by_role('button',name='撤销').click()
    expect(page.locator('#clientKeyBody tr')).to_have_count(1)
    assert page.request.get(url+'models', headers={'Authorization':'Bearer '+second}).status == 401
    print(json.dumps({'kind':'local-multi-key-browser','chromium':browser.version,'viewport':390,
        'createCopyFallbackClose':True,'rotateConfirmFocus':True,'oldKeyDenied':True,'ownerDraftRoundtrip':True,
        'attachedDeleteRejected':True,'reassignThenRevoke':True,'narrowKeyTableScroll':True},ensure_ascii=False))
    browser.close()
