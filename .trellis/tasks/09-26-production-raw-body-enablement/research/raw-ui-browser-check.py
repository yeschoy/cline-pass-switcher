"""Local-only real Chromium smoke for raw-detail UI. No production endpoint or secret.
Run: python3 .trellis/tasks/09-26-production-raw-body-enablement/research/raw-ui-browser-check.py
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[4]
HTML = (ROOT / 'public/index.html').read_bytes()
REQUEST_ID = '8c745849-b879-4762-a1f2-ce0144f61d57'
BODY_ID = 'dc26e066-4f17-4d51-a694-a62382b683b9'
CALL_ID = '4841fdda-d648-4592-88e1-bb4f39c5dbb0'
BODY = 'synthetic fixture body, no credentials'
HEALTH = {'failures': 0, 'dropped': 0, 'corrupt': 0, 'rawWarnings': 0, 'dropReasons': {}}
state = {'posts': 0, 'bodyReads': 0, 'raw': False, 'expired': False}


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, payload, status=200, content_type='application/json'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/':
            return self.respond(HTML, content_type='text/html; charset=utf-8')
        if path == '/api/auth/state':
            return self.respond({'initialized': True, 'available': True})
        if path == '/api/auth/session':
            return self.respond({'csrf': 'fixture-csrf', 'pending': False})
        if path == '/api/logs/settings':
            return self.respond({'detailedLogging': True, 'errorDetailLogging': True,
                                 'rawBodyLogging': state['raw'], 'rawBodyAvailable': True,
                                 'authRequired': True, 'health': HEALTH})
        if path == '/api/logs/details':
            return self.respond({'items': [{'requestId': REQUEST_ID, 'ts': 1700000000000,
                                            'profile': 'raw-error', 'status': 500, 'outcomeStatus': 500,
                                            'result': 'failed', 'state': 'complete', 'captureState': 'response-error',
                                            'attemptCount': 1, 'model': '', 'accounts': []}],
                                 'nextCursor': None, 'health': HEALTH})
        if path == f'/api/logs/details/{REQUEST_ID}':
            return self.respond({'request': {'requestId': REQUEST_ID, 'profile': 'raw-error',
                                             'status': 500, 'headers': None},
                                 'attempts': [{'callId': CALL_ID, 'attemptIndex': 0, 'requestBody': BODY_ID,
                                               'headers': {'authorization': '[REDACTED]', 'content-type': 'application/json'},
                                               'responseHeaders': {'set-cookie': '[REDACTED]'}}],
                                 'bodies': [{'bodyId': BODY_ID, 'state': 'complete', 'capturedBytes': len(BODY),
                                             'observedBytes': len(BODY)}]})
        if path == f'/api/logs/details/{REQUEST_ID}/bodies/{BODY_ID}':
            state['bodyReads'] += 1
            if state['expired']:
                return self.respond({'error': {'message': 'unauthorized'}}, 401)
            return self.respond(BODY.encode(), content_type='text/plain; charset=utf-8')
        return self.respond({'error': {'message': 'fixture route unavailable'}}, 404)

    def do_POST(self):
        if urlsplit(self.path).path != '/api/logs/settings':
            return self.respond({'error': {'message': 'fixture route unavailable'}}, 404)
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.headers.get('X-CSRF-Token') == 'fixture-csrf'
        assert list(data) == ['rawBodyLogging'] and isinstance(data['rawBodyLogging'], bool)
        state['posts'] += 1
        state['raw'] = data['rawBodyLogging']
        self.respond({'ok': True, 'detailedLogging': True, 'errorDetailLogging': True,
                      'rawBodyLogging': state['raw']})


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='domcontentloaded')
        page.locator('#navDetails').click()
        expect(page.locator('#rawBodyLogging')).to_be_enabled()
        raw = page.locator('#rawBodyLogging')
        page.once('dialog', lambda dialog: dialog.dismiss())
        raw.click()
        assert state['posts'] == 0 and not raw.is_checked()
        expect(page.locator('#detailsStatus')).to_contain_text('已取消启用原文')
        page.once('dialog', lambda dialog: dialog.accept())
        raw.check()
        expect(raw).to_be_checked()
        assert state['posts'] == 1
        page.locator('#detailsList').get_by_role('button', name='查看请求').click()
        metadata = page.locator('#detailsMetadata')
        expect(metadata).to_contain_text('"authorization": "[REDACTED]"')
        expect(metadata).to_contain_text('"set-cookie": "[REDACTED]"')
        assert state['bodyReads'] == 0
        expect(metadata).to_be_focused()
        region = page.locator('#detailsMetadata')
        assert region.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
        body_button = page.locator('#detailsBodies button')
        body_button.focus()
        body_button.press('Enter')
        expect(page.locator('#detailsText')).to_have_value(BODY)
        assert state['bodyReads'] == 1
        page.locator('#navConsole').click()
        expect(page.locator('#detailsText')).to_have_value('')
        expect(page.locator('#detailsCopy')).to_be_disabled()
        page.locator('#navDetails').click()
        page.locator('#detailsList').get_by_role('button', name='查看请求').click()
        state['expired'] = True
        page.locator('#detailsBodies button').click()
        expect(page.locator('#loginOverlay')).to_be_visible()
        expect(page.locator('#detailsText')).to_have_value('')
        browser.close()
        print(json.dumps({'kind': 'local-raw-detail-browser', 'viewport': 390,
                          'confirmCancelNoWrite': True, 'confirmOneWrite': True,
                          'safeSelectedHeaders': True, 'onDemandBody': True,
                          'keyboardFocus': True, 'navigationAndSessionClear': True}, ensure_ascii=False))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
