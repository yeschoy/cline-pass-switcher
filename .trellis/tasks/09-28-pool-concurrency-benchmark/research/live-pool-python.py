#!/usr/bin/env python3
"""Bounded live-pool experiment. Standard library only; no remote files written.

Production entry is intentionally fixed. --local-test-only is loopback-only and
uses an injected synthetic credential and monitor, never operator configuration.
"""
import collections
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import select
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

ORIGIN = 'https://clinepass.yeschoy.io'
MODEL = 'cline-pass/deepseek-v4.1-flash'  # approved resolved target
DIAGNOSTIC_ALIAS = 'pc/deepseek-v4.1-flash'  # fixed client-facing alias for both modes
DIAGNOSTIC_TARGET = MODEL
DIAGNOSTIC_REQUESTS, DIAGNOSTIC_SECONDS = 2, 120
SSE_EVENT_MAX, SSE_TOTAL_MAX = 65536, 262144
CONTAINER = 'cline-pass-console'
CONFIG = '/opt/cline-pass-switcher/data/config.json'
META = '/opt/cline-pass-switcher/data/metadata.json'
LIMIT_RPM, LIMIT_REQUESTS, LIMIT_SECONDS, LIMIT_INFLIGHT = 350, 900, 300, 64
RPM_WINDOW_SECONDS = 60  # tests may shorten the window, never a production setting
# maxRetries <= 1 per resolved route, at most two account chains per chat.
ATTEMPT_RESERVATION = 4
RESPONSE_MAX = 65536


class Guard(Exception):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def private_command(*args):
    # Never include secrets in arguments, diagnostics or exceptions. No shell, no inherited stdin.
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.DEVNULL, timeout=4, check=False)
    if p.returncode or len(p.stdout) > 262144:
        raise Guard('monitor_unavailable')
    return p.stdout


def private_json(path):
    # No raw JSON leaves the process. Fail closed rather than accepting a truncated state.
    if os.stat(path).st_size > 8 * 1024 * 1024:
        raise Guard('projection_unavailable')
    with open(path, 'rb') as f:
        return json.load(f)


def supplied_key():
    # Read through the newline without buffering past it: subsequent stdin bytes
    # must remain visible to the monitor. EOF/overlong lines fail closed.
    raw = bytearray()
    for _ in range(257):
        byte = os.read(sys.stdin.fileno(), 1)
        if byte == b'\n':
            if 16 <= len(raw) <= 256 and all(33 <= c <= 126 for c in raw):
                return raw.decode('ascii')
            break
        if not byte:
            break
        raw.extend(byte)
    raise Guard('credential_unconfirmed')


def stdin_guard(fd):
    # SSH stdin stays open for the session lifetime. A closed pipe or a second
    # credential/command is a veto, not another protocol message.
    ready, _, _ = select.select([fd], [], [], 0)
    if ready:
        os.read(fd, 1)  # consume at most one byte; never log it
        raise Guard('control_channel_lost')


def confirm_legacy_key(config, env, key):
    # PROXY_KEY overrides at startup; a later security save can change the
    # effective key without changing Env. Such an ambiguous state fails closed.
    overrides = [v[10:] for v in env if isinstance(v, str) and v.startswith('PROXY_KEY=')]
    if len(overrides) > 1 or not isinstance(config.get('proxyKey'), str):
        raise Guard('credential_unconfirmed')
    stored = config['proxyKey']
    if overrides and overrides[0].strip() and not hmac.compare_digest(overrides[0].strip(), stored):
        raise Guard('credential_unconfirmed')
    effective = overrides[0] if overrides and overrides[0].strip() else stored
    if not isinstance(key, str) or not hmac.compare_digest(key, effective):
        raise Guard('owner_unconfirmed')
    # An additional key never falls through to Legacy even if the stored
    # inventory is malformed or changed after initial preflight.
    extras = config.get('clientKeys', [])
    if not isinstance(extras, list) or any(not isinstance(x, dict) for x in extras):
        raise Guard('owner_unconfirmed')
    if any(isinstance(x.get('key'), str) and hmac.compare_digest(key, x['key']) for x in extras):
        raise Guard('owner_unconfirmed')
    return True


def docker_state():
    # Restrict Docker's formatted output to state, resources and Env. Never print Env.
    fmt = '{{json .State}}|{{json .HostConfig.Memory}}|{{json .Config.Env}}|{{json .Image}}|{{json .Mounts}}'
    fields = private_command('docker', 'inspect', '--format', fmt, CONTAINER).split(b'|')
    if len(fields) != 5:
        raise Guard('monitor_unavailable')
    state, memory, env, image, mounts = (json.loads(x) for x in fields)
    if not isinstance(mounts, list) or not any(m.get('Source') == os.path.dirname(CONFIG) and m.get('Destination') == '/data' and m.get('RW') is True for m in mounts):
        raise Guard('projection_unavailable')
    if 'DATA_DIR=/data' not in env:
        raise Guard('projection_unavailable')
    if not isinstance(env, list) or not isinstance(memory, int) or memory < 256 * 1024 * 1024:
        raise Guard('monitor_unavailable')
    health = state.get('Health') or {}
    if state.get('Status') != 'running' or not isinstance(health, dict) or health.get('Status') != 'healthy' or state.get('Restarting'):
        raise Guard('service_unhealthy')
    if not isinstance(image, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise Guard('monitor_unavailable')
    return state.get('StartedAt'), memory, env, image


def public_readiness():
    # Public, non-management endpoint. No key, no body printed or retained.
    conn = http.client.HTTPSConnection('clinepass.yeschoy.io', timeout=4, context=ssl.create_default_context())
    try:
        conn.request('GET', '/api/meta', headers={'User-Agent': 'curl/8.0'})
        resp = conn.getresponse()
        if resp.status != 200 or int(resp.getheader('Content-Length') or '0') > 4096:
            raise Guard('ingress_unavailable')
        body = json.loads(resp.read(4097))
        if not isinstance(body, dict) or body.get('configured') is not True or body.get('authRequired') is not True or body.get('proxyBase') != ORIGIN + '/v1':
            raise Guard('ingress_unconfirmed')
    finally:
        conn.close()


def resource_sample():
    # Docker CLI JSON contains no environment/credential fields. Refuse unknown formats.
    data = json.loads(private_command('docker', 'stats', '--no-stream', '--format', '{{json .}}', CONTAINER))
    cpu = data.get('CPUPerc')
    used = data.get('MemUsage', '').split('/')[0].strip()
    m = re.fullmatch(r'([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)', used)
    if not isinstance(cpu, str) or not re.fullmatch(r'\d+(?:\.\d+)?%', cpu) or not m:
        raise Guard('monitor_unavailable')
    unit = {'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3,
            'kB': 1000, 'MB': 1000**2, 'GB': 1000**3}[m.group(2)]
    return float(cpu[:-1]), float(m.group(1)) * unit


def projection(config, meta, model, approved_target=None):
    # Never return account identifiers, keys or operator JSON. This is a private comparison gate.
    if not isinstance(config, dict) or not isinstance(meta, dict):
        raise Guard('projection_unavailable')
    # Existing error-only capture is part of the running production workload; do not
    # silently change operator settings. Full/raw capture is too costly for this run.
    if config.get('detailedLogging') or config.get('rawBodyLogging'):
        raise Guard('diagnostics_enabled')
    aliases = config.get('modelAliases', {})
    if not isinstance(aliases, dict):
        raise Guard('route_unconfirmed')
    if approved_target is not None:
        if model != DIAGNOSTIC_ALIAS or approved_target != DIAGNOSTIC_TARGET or aliases.get(model) != approved_target:
            raise Guard('route_unconfirmed')
        resolved = approved_target
    else:
        if model in aliases:
            raise Guard('route_unconfirmed')
        resolved = model
    if not isinstance(config.get('knownModels'), list) or resolved not in config['knownModels'] or resolved in aliases:
        raise Guard('model_unconfirmed')
    owners = config.get('clientKeys', [])
    if not isinstance(owners, list) or not isinstance(config.get('accounts'), list):
        raise Guard('owner_unconfirmed')
    accounts = [a for a in config['accounts'] if a.get('clientKeyId', 'legacy') == 'legacy']
    eligible = [a for a in accounts if a.get('enabled') is not False and a.get('key')]
    if not eligible:
        raise Guard('owner_unconfirmed')
    # Account perModel is a complete override, including {}. A missing or null
    # maxRetries allows an unbounded discovered Provider plan: never budget it as 4.
    routes = config.get('perModel', {})
    if not isinstance(routes, dict):
        raise Guard('route_unconfirmed')
    for a in eligible:
        overrides = a.get('perModel', {})
        if not isinstance(overrides, dict):
            raise Guard('route_unconfirmed')
        route = overrides[resolved] if resolved in overrides else routes.get(resolved)
        if not isinstance(route, dict) or type(route.get('maxRetries')) is not int or not 0 <= route['maxRetries'] <= 1:
            raise Guard('route_unconfirmed')
    states = meta.get('accountStates')
    if not isinstance(states, dict):
        raise Guard('projection_unavailable')
    for a in eligible:
        st = states.get(a.get('id'), {})
        if not isinstance(st, dict) or st.get('protectionMonthlyAt') or st.get('protectionShortAt') or st.get('banned') or st.get('hardQuarantined') or st.get('cooldownUntil', 0) > time.time() * 1000 or st.get('quotaDisposition') in ('waiting-refresh', 'quota-exhausted'):
            raise Guard('account_protection')
    stats = meta.get('statistics', {}).get('lifetime', {}).get('global', {})
    requests = stats.get('requests')
    if type(requests) is not int or requests < 0:
        raise Guard('background_unobservable')
    # Hash only in memory for change detection. Do not publish digests of private files.
    stamp = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).digest()
    roles = meta.get('cachePoolTargetSize')
    if not isinstance(roles, int):
        raise Guard('projection_unavailable')
    return stamp, roles, requests, len(accounts), len(eligible), sum(a.get('maxConcurrent', 0) == 0 for a in eligible)


class HostMonitor:
    def __init__(self, model, key, control_fd=None, approved_target=None):
        self.control_fd = sys.stdin.fileno() if control_fd is None else control_fd
        stdin_guard(self.control_fd)
        self.model = model
        self.approved_target = approved_target
        started, self.mem_limit, env, self.image = docker_state()
        self.started = started
        # A runtime-injected Legacy account is absent from config.json; its route
        # cannot be proven by the persisted-account projection below.
        if any(v.startswith('CLINE_PASS_KEY=') and v.split('=', 1)[1] for v in env if isinstance(v, str)):
            raise Guard('route_unconfirmed')
        config = private_json(CONFIG)
        confirm_legacy_key(config, env, key)
        self.key = key
        public_readiness()
        self.base = projection(config, private_json(META), model, approved_target)
        self.error_only = config.get('errorDetailLogging') is True
        self.cpu0, self.rss0 = resource_sample()
        if self.rss0 >= self.mem_limit * .70 or self.cpu0 > 80:
            raise Guard('resource_headroom')
        self.samples = []
        self.background_certain_minimum = 0
        self.sent = 0
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.reason = None
        self.last = time.monotonic()

    def check(self):
        stdin_guard(self.control_fd)
        started, limit, env, image = docker_state()
        if any(v.startswith('CLINE_PASS_KEY=') and v.split('=', 1)[1] for v in env if isinstance(v, str)):
            raise Guard('route_unconfirmed')
        if started != self.started or image != self.image or limit != self.mem_limit:
            raise Guard('runtime_drift')
        cpu, rss = resource_sample()
        if cpu > max(90, self.cpu0 + 65) or rss > min(limit * .85, self.rss0 + 128 * 1024**2):
            raise Guard('resource_guard')
        config = private_json(CONFIG)
        confirm_legacy_key(config, env, self.key)
        current = projection(config, private_json(META), self.model, self.approved_target)
        if current[:2] != self.base[:2] or current[3:] != self.base[3:]:
            raise Guard('configuration_or_protection_drift')
        with self.lock:
            # Persisted global completions lag clients; only increases exceeding ALL
            # generator sends are certain external traffic. This is a conservative lower bound.
            extra = max(0, current[2] - self.base[2] - self.sent)
            self.background_certain_minimum = max(self.background_certain_minimum, extra)
            # Existing customer traffic is expected. Record a conservative minimum;
            # stop only if it exceeds the approved experiment's small-load baseline.
            if extra >= 30:
                raise Guard('background_guard')
            self.samples.append((round(cpu, 2), round(rss / 1024**2, 1)))
            self.last = time.monotonic()

    def run(self):
        next_check = 0
        while not self.stop.is_set():
            try:
                stdin_guard(self.control_fd)
                if time.monotonic() >= next_check:
                    self.check()
                    next_check = time.monotonic() + 2
            except Exception:
                self.reason = 'monitor_guard'
                self.stop.set()
                break
            self.stop.wait(.2)

    def sent_one(self):
        with self.lock:
            self.sent += 1


class LocalMonitor:
    """Only for loopback tests; never selected in production."""
    def __init__(self, key):
        self.key = key
        self.started = 'local'
        self.image = 'local'
        self.base = (None, 0, 0, 1, 1, 1)
        self.mem_limit = 0
        self.cpu0 = self.rss0 = 0
        self.samples = []
        self.background_certain_minimum = 0
        self.stop = threading.Event()
        self.reason = None
        self.last = time.monotonic()

    def run(self):
        while not self.stop.wait(.2):
            self.last = time.monotonic()

    def check(self):
        self.last = time.monotonic()

    def sent_one(self):
        pass


def response_socket(response):
    return getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)


def read_sse(response, connection, deadline):
    """Incremental bounded SSE validity check; never return content or error reasons."""
    total = 0
    line = bytearray()
    event = bytearray()
    has_delta = done = False
    data_lines = []
    error_event = False

    def finish_event():
        nonlocal has_delta, done, data_lines, error_event
        if error_event:
            raise Guard('invalid_stream')
        if not data_lines:
            event.clear()
            return
        payload = b'\n'.join(data_lines)
        if payload == b'[DONE]':
            if done:
                raise Guard('invalid_stream')
            done = True
        else:
            if done:
                raise Guard('invalid_stream')
            try:
                obj = json.loads(payload)
                if (not isinstance(obj, dict) or 'error' in obj or obj.get('success') is False
                        or obj.get('type') == 'error' or obj.get('object') == 'error'):
                    raise Guard('invalid_stream')
                choices = obj.get('choices', [])
                if not isinstance(choices, list):
                    raise Guard('invalid_stream')
                if any(isinstance(c, dict) and isinstance(c.get('delta'), dict) and
                       isinstance(c['delta'].get('content'), str) and c['delta']['content'].strip()
                       for c in choices):
                    has_delta = True
            except (ValueError, TypeError):
                raise Guard('invalid_stream') from None
        data_lines = []
        error_event = False
        event.clear()

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout()
        # http.client clears connection.sock when the response will close (e.g.
        # HTTP/1.0), but HTTPResponse.fp still owns the receiving socket. Keep
        # the absolute SSE deadline on that socket too; never accept a late DONE.
        sock = response_socket(response) or connection.sock
        if sock is None:
            raise Guard('invalid_stream')
        sock.settimeout(min(5, remaining))
        # read1 consumes at most one currently available chunk, unlike read(n),
        # which can wait for n bytes on a long-running SSE response.
        chunk = response.read1(4096)
        if not chunk:
            if line or event:
                raise Guard('invalid_stream')
            return has_delta and done
        total += len(chunk)
        if total > SSE_TOTAL_MAX:
            raise Guard('invalid_stream')
        for byte in chunk:
            if byte != 10:
                line.append(byte)
                if len(line) + len(event) > SSE_EVENT_MAX:
                    raise Guard('invalid_stream')
                continue
            current = bytes(line).rstrip(b'\r')
            line.clear()
            if not current:
                finish_event()
            else:
                event.extend(current)
                if len(event) > SSE_EVENT_MAX:
                    raise Guard('invalid_stream')
                if current.startswith(b'event:') and current[6:].strip().lower() == b'error':
                    error_event = True
                if current.startswith(b'data:'):
                    data_lines.append(current[5:].lstrip(b' '))


def percentile(values, p):
    return round(sorted(values)[math.ceil(len(values) * p) - 1], 1) if values else None


class Runner:
    def __init__(self, origin, model, monitor, diagnostic=False):
        self.origin, self.model, self.monitor = origin, model, monitor
        self.diagnostic = diagnostic
        self.max_requests = DIAGNOSTIC_REQUESTS if diagnostic else LIMIT_REQUESTS
        self.max_paid = self.max_requests * ATTEMPT_RESERVATION if diagnostic else LIMIT_REQUESTS
        self.max_inflight = 1 if diagnostic else LIMIT_INFLIGHT
        self.start = time.monotonic()
        self.deadline = self.start + (DIAGNOSTIC_SECONDS if diagnostic else LIMIT_SECONDS) - 5
        self.sent = collections.deque()
        self.count = self.inflight = self.peak = self.client_inflight = self.paid_used = 0
        # SIGINT/SIGTERM handlers run on the main thread, possibly inside launch's lock.
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.reason = None
        self.active = {}  # connection -> (response, response-owned socket); guarded by lock
        self.results = []
        self.baseline = None
        self.recent = collections.deque(maxlen=20)

    def abort(self, why):
        # Publish veto immediately, even if another thread is inside the bounded
        # send call holding the lock. Already-started sends cannot be revoked.
        self.stop.set()
        with self.lock:
            if self.reason:
                return
            self.reason = why
            active = list(self.active.items())
        for c, (response, sock) in active:
            # HTTP/1.0 and Connection: close detach conn.sock at getresponse().
            # Interrupt the response-owned read, not just the connection object.
            for owned in (sock, c.sock):
                if owned is not None:
                    try:
                        owned.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    try:
                        owned.close()
                    except OSError:
                        pass
            try:
                c.close()
            except OSError:
                pass

    def healthy(self):
        if self.monitor.stop.is_set() or time.monotonic() - self.monitor.last > 6:
            self.abort('monitor_guard')
        if time.monotonic() >= self.deadline:
            self.abort('deadline')
        return not self.stop.is_set()

    def launch(self, stage):
        with self.lock:
            now = time.monotonic()
            if (self.stop.is_set() or self.monitor.stop.is_set() or now >= self.deadline
                    or self.count + self.inflight >= self.max_requests or self.inflight >= self.max_inflight
                    or self.paid_used + (self.inflight + 1) * ATTEMPT_RESERVATION > self.max_paid):
                return False
            # Reserve worst-case paid attempts even for a worker still connecting.
            self.inflight += 1
        t = threading.Thread(target=self.request, args=(stage,), daemon=True)
        t.start()
        return True

    def request(self, stage):
        conn = res = None
        sent = None
        kind, attempts = 'network', None
        try:
            parts = urlsplit(self.origin)
            conn = (http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection)(parts.hostname, parts.port, timeout=30)
            with self.lock:
                if self.stop.is_set():
                    return
                self.active[conn] = (None, None)
            streaming = not self.diagnostic or stage['name'] == 'diagnostic_stream'
            data = json.dumps({'model': self.model, 'stream': streaming, 'max_tokens': 256,
                               'session_id': secrets.token_hex(16), 'messages': [{'role': 'user', 'content': 'Reply OK.'}]})
            # Establish TLS/connect before the send seam; delayed workers must recheck
            # abort, deadline, rolling 60s, and the reserved paid-attempt budget.
            conn.connect()
            # A blocked small HTTP write must not hold abort's lock for 30s.
            if conn.sock is not None:
                conn.sock.settimeout(1)
            while True:
                with self.lock:
                    now = time.monotonic()
                    while self.sent and self.sent[0] <= now - RPM_WINDOW_SECONDS:
                        self.sent.popleft()
                    if (self.stop.is_set() or self.monitor.stop.is_set()
                            or now - self.monitor.last > 6 or now >= self.deadline):
                        return
                    if self.count >= self.max_requests or self.paid_used + self.inflight * ATTEMPT_RESERVATION > self.max_paid:
                        return
                    if len(self.sent) < LIMIT_RPM:
                        # Reserve a slot before transport handoff. Keep it for 60s
                        # AFTER request() returns (even on a partial/failed write):
                        # the actual write may occur anywhere inside that interval.
                        # Serialized writes make this conservative for every 60s
                        # window, including slow writes crossing a minute boundary.
                        sent = now
                        self.sent.append(now)
                        self.count += 1
                        self.client_inflight += 1
                        self.peak = max(self.peak, self.client_inflight)
                        stage['offered'] += 1
                        stage['peakClientInFlight'] = max(stage['peakClientInFlight'], self.client_inflight)
                        self.monitor.sent_one()
                        # The lock covers the bounded write, not the response.
                        # Do not refund the slot on exceptions: bytes may have left.
                        try:
                            conn.request('POST', '/v1/chat/completions', body=data, headers={
                                'Authorization': 'Bearer ' + self.monitor.key, 'Content-Type': 'application/json',
                                'User-Agent': 'curl/8.0'})
                        finally:
                            self.sent[-1] = time.monotonic()
                        if conn.sock is not None:
                            conn.sock.settimeout(30)
                        break
                    wait = min(.1, max(.001, self.sent[0] + RPM_WINDOW_SECONDS - now))
                self.stop.wait(wait)
            res = conn.getresponse()
            with self.lock:
                self.active[conn] = (res, response_socket(res))
                if self.stop.is_set():
                    return
            raw_attempts = res.getheader('X-Cline-Attempts')
            attempts = int(raw_attempts) if raw_attempts and re.fullmatch(r'(0|[1-9]\d{0,8})', raw_attempts) else None
            if attempts is not None and attempts > 1:
                # Stop at headers, without waiting for a potentially stalled body.
                kind = 'fanout'
                self.abort('fanout')
            elif res.status == 429:
                kind = 'local429' if attempts == 0 else 'attempted429' if attempts else 'unknown429'
                self.abort('first_429')
            elif res.status in (401, 403):
                kind = 'auth'
                self.abort('auth_drift')
            elif res.status == 503:
                kind = 'unavailable'
                self.abort('account_protection')
            elif res.status >= 500:
                kind = 'server5xx'
            elif res.status != 200:
                kind = 'invalid'
                self.abort('invalid_reply')
            else:
                if streaming:
                    if not str(res.getheader('Content-Type') or '').lower().startswith('text/event-stream'):
                        kind = 'invalid'
                    else:
                        kind = 'success' if read_sse(res, conn, min(self.deadline, sent + 30)) and attempts == 1 else 'invalid'
                else:
                    raw = res.read(RESPONSE_MAX + 1)
                    if len(raw) > RESPONSE_MAX:
                        kind = 'invalid'
                        self.abort('oversized_reply')
                    else:
                        try:
                            body = json.loads(raw)
                            choice = body['choices'][0]['message']
                            useful = isinstance(choice.get('content'), str) and bool(choice['content'].strip()) or bool(choice.get('tool_calls'))
                            kind = 'success' if isinstance(body, dict) and 'error' not in body and useful and attempts == 1 else 'invalid'
                        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                            kind = 'invalid'
                if kind != 'success':
                    self.abort(kind)
        except socket.timeout:
            kind = 'timeout'
            if sent is None:
                self.abort('connect_timeout')
            else:
                # A stalled streamed body is not a successful completion and
                # must not allow another capacity step to begin.
                self.abort('timeout')
        except Guard:
            kind = 'invalid'
            self.abort('invalid')
        except (OSError, http.client.HTTPException, ssl.SSLError):
            kind = 'network'
            self.abort('network')
        finally:
            # HTTP/1.0/Connection: close can detach the response-owned socket
            # from conn.sock; closing conn alone leaves a failed SSE read open.
            for source in (res, conn):
                if source is not None:
                    try:
                        source.close()
                    except OSError:
                        pass
            ms = (time.monotonic() - sent) * 1000 if sent is not None else None
            why = None
            with self.lock:
                self.active.pop(conn, None)
                self.inflight -= 1
                if sent is not None:
                    self.client_inflight -= 1
                    # Missing/invalid attempt count consumes the entire reservation.
                    self.paid_used += attempts if attempts is not None and attempts <= ATTEMPT_RESERVATION else ATTEMPT_RESERVATION
                    # A cancelled request is never a completed useful success.
                    if (self.stop.is_set() and kind in ('network', 'success', 'invalid', 'timeout')
                            and self.reason not in ('invalid', 'timeout', 'network', 'oversized_reply', 'invalid_reply')):
                        # A response interrupted by an external veto cannot
                        # retroactively be credited as useful SSE completion.
                        kind = 'cancelled'
                    stage['kinds'][kind] += 1
                    stage['completed'] += 1
                    if attempts is not None:
                        stage['attemptsKnown'] += 1
                        stage['attempts'] += attempts
                    if kind == 'success':
                        stage['latencies'].append(ms)
                        if self.baseline is None:
                            self.baseline = ms
                    self.recent.append((kind, ms))
                    if sum(k in ('server5xx', 'timeout') for k, _ in self.recent) >= 2:
                        why = 'error_guard'
                    elif len(self.recent) == 20 and sum(k == 'success' for k, _ in self.recent) < 19:
                        why = 'success_guard'
                    elif self.baseline is not None and len(self.recent) == 20 and percentile([v for k, v in self.recent if k == 'success'], .95) > max(10000, 2 * self.baseline):
                        why = 'latency_guard'
                    if why:
                        # Publish the veto before another worker can pass the send seam.
                        self.stop.set()
            if why:
                self.abort(why)

    def wait_drain(self):
        # A veto may be published by a worker just before it settles its own
        # counters. Give that worker a bounded chance to finish before freezing
        # the stage snapshot; never wait indefinitely on a broken transport.
        stopping_until = None
        while self.inflight:
            if self.healthy():
                time.sleep(.02)
                continue
            if stopping_until is None:
                stopping_until = time.monotonic() + 1
            if time.monotonic() >= stopping_until:
                break
            time.sleep(.02)

    def stage(self, name, rate=0, duration=0, size=0):
        s = {'name': name, 'startedUtc': utc(), 'offered': 0, 'completed': 0,
             'peakClientInFlight': 0, 'attemptsKnown': 0, 'attempts': 0,
             'latencies': [], 'kinds': collections.Counter()}
        began = time.monotonic()
        if rate:
            interval = 60 / rate
            tick = began
            while self.healthy() and time.monotonic() < began + duration:
                if time.monotonic() >= tick:
                    if not self.launch(s) and not self.inflight and (self.count >= self.max_requests or self.paid_used + ATTEMPT_RESERVATION > self.max_paid):
                        self.abort('request_budget')
                    tick = time.monotonic() + interval
                time.sleep(min(.01, max(.001, tick - time.monotonic())))
        elif size:
            for _ in range(size):
                while self.healthy():
                    if self.launch(s):
                        break
                    if not self.inflight and (self.count >= self.max_requests or self.paid_used + ATTEMPT_RESERVATION > self.max_paid):
                        self.abort('request_budget')
                        break
                    time.sleep(.02)  # sliding minute limiter spans ALL stages
        else:
            if self.healthy():
                self.launch(s)
        self.wait_drain()
        # Abort can end a stage while workers are still settling. Freeze one
        # internally consistent snapshot; never read mutable counters piecemeal.
        with self.lock:
            elapsed = max(.001, time.monotonic() - began)
            ended = utc()
            offered, completed = s['offered'], s['completed']
            counts = dict(s['kinds'])
            latencies = list(s['latencies'])
            success = counts.get('success', 0)
            planned = size if size else (1 if not rate else None)
            result = {'stage': name, 'startedUtc': s['startedUtc'], 'endedUtc': ended,
                      'plannedOffered': planned,
                      'budgetCensored': self.reason == 'request_budget' and (planned is None or offered < planned),
                      'durationSeconds': round(elapsed, 2), 'offered': offered,
                      'completed': completed, 'unresolvedAtStageEnd': offered - completed,
                      'success': success,
                      'successRate': round(success / completed, 4) if completed else None,
                      'goodputRps': round(success / elapsed, 3), 'completedRps': round(completed / elapsed, 3),
                      'peakClientInFlight': s['peakClientInFlight'], 'attempts': s['attempts'],
                      'attemptsKnown': s['attemptsKnown'], 'latencySamples': len(latencies),
                      'p50Ms': percentile(latencies, .5), 'p95Ms': percentile(latencies, .95),
                      'p99Ms': percentile(latencies, .99),
                      'errors': {k: counts.get(k, 0) for k in ('local429', 'attempted429', 'unknown429', 'server5xx', 'auth', 'unavailable', 'invalid', 'fanout', 'network', 'timeout', 'cancelled')}}
        self.results.append(result)
        return result

    def run(self):
        watcher = threading.Thread(target=self.monitor.run, daemon=True)
        watcher.start()
        try:
            # Require an actual fresh monitor sample, not merely an optimistic initial state.
            prior = self.monitor.last
            until = time.monotonic() + 6
            while self.monitor.last == prior and not self.monitor.stop.is_set() and time.monotonic() < until:
                time.sleep(.02)
            if self.monitor.last == prior:
                self.abort('monitor_guard')
            if self.diagnostic:
                for name in ('diagnostic_nonstream', 'diagnostic_stream'):
                    if not self.healthy():
                        break
                    # Re-read health, alias and every route immediately before each paid send.
                    try:
                        self.monitor.check()
                    except Exception:
                        self.abort('monitor_guard')
                        break
                    result = self.stage(name)
                    if result['success'] != 1 or result['attempts'] != 1 or result['attemptsKnown'] != 1:
                        self.abort('diagnostic_failed')
                        break
            else:
                dry = self.stage('dry_run') if self.healthy() else None
                if dry and (dry['success'] != 1 or dry['attempts'] != 1 or dry['attemptsKnown'] != 1):
                    self.abort('dry_run_failed')
                for rate, seconds in ((60, 6), (120, 6), (240, 6), (350, 120)):
                    if self.healthy():
                        self.stage('paced_' + str(rate), rate=rate, duration=seconds)
                for n in (1, 2, 4, 8, 16, 32, 64):
                    if self.healthy():
                        self.stage('burst_' + str(n), size=n)
            if self.healthy():
                self.abort('steps_complete')
        finally:
            self.monitor.stop.set()
            if not self.reason:
                self.abort('monitor_guard')
            until = time.monotonic() + 1
            while self.inflight and time.monotonic() < until:
                time.sleep(.02)
            watcher.join(timeout=.2)
        samples = self.monitor.samples
        with self.lock:
            # Unsettled workers keep their worst-case reservation in the report.
            sent, reserved, peak, unresolved = (self.count,
                self.paid_used + self.inflight * ATTEMPT_RESERVATION,
                self.peak, self.inflight)
        return {'schema': 2 if self.diagnostic else 3, 'stop': self.reason,
                'runtimeImageSha256': self.monitor.image if self.monitor.image.startswith('sha256:') else None,
                'runtimeStartedUtc': self.monitor.started if self.monitor.image.startswith('sha256:') else None,
                'limits': {'rpm': LIMIT_RPM, 'requests': self.max_requests,
                'seconds': DIAGNOSTIC_SECONDS if self.diagnostic else LIMIT_SECONDS, 'inflightEmergency': self.max_inflight,
                'maxAttemptsPerChat': ATTEMPT_RESERVATION}, 'sent': sent,
                'paidAttemptsObservedOrReserved': reserved,
                'peakClientInFlight': peak, 'owner': 'legacy', 'stream': 'comparison' if self.diagnostic else True,
                'ownerAccounts': {'total': self.monitor.base[3], 'eligible': self.monitor.base[4],
                                  'unlimited': self.monitor.base[5]},
                'resource': {'cpuPctMinMax': [min((x[0] for x in samples), default=None), max((x[0] for x in samples), default=None)],
                             'rssMiBMinMax': [min((x[1] for x in samples), default=None), max((x[1] for x in samples), default=None)],
                             'samples': len(samples), 'eventLoopDelay': None},
                'backgroundCertainMinimum': self.monitor.background_certain_minimum,
                'diagnostics': 'error-only' if getattr(self.monitor, 'error_only', False) else 'off',
                'stages': self.results, 'unresolvedClientRequests': unresolved}


def main(argv):
    if argv == ['--preflight-stdin-key']:
        monitor = HostMonitor(DIAGNOSTIC_ALIAS, supplied_key(), approved_target=DIAGNOSTIC_TARGET)
        monitor.check()
        print(json.dumps({'preflight': 'ok', 'runtimeImageSha256': monitor.image,
                          'runtimeStartedUtc': monitor.started, 'owner': 'legacy',
                          'ownerAccounts': {'total': monitor.base[3], 'eligible': monitor.base[4],
                                            'unlimited': monitor.base[5]},
                          'diagnostics': 'error-only' if monitor.error_only else 'off',
                          'resourceBaseline': {'cpuPct': round(monitor.cpu0, 2),
                                               'rssMiB': round(monitor.rss0 / 1024**2, 1),
                                               'memoryLimitMiB': round(monitor.mem_limit / 1024**2, 1)}}))
        return
    if argv == ['--diagnostic-preflight-stdin-key']:
        monitor = HostMonitor(DIAGNOSTIC_ALIAS, supplied_key(), approved_target=DIAGNOSTIC_TARGET)
        monitor.check()
        print(json.dumps({'preflight': 'ok', 'runtimeImageSha256': monitor.image,
                          'runtimeStartedUtc': monitor.started, 'owner': 'legacy',
                          'ownerAccounts': {'total': monitor.base[3], 'eligible': monitor.base[4],
                                            'unlimited': monitor.base[5]},
                          'diagnostics': 'error-only' if monitor.error_only else 'off',
                          'resourceBaseline': {'cpuPct': round(monitor.cpu0, 2),
                                               'rssMiB': round(monitor.rss0 / 1024**2, 1),
                                               'memoryLimitMiB': round(monitor.mem_limit / 1024**2, 1)}}))
        return
    diagnostic = False
    if argv == ['--execute-stdin-key']:
        origin, model = ORIGIN, DIAGNOSTIC_ALIAS
        monitor = HostMonitor(model, supplied_key(), approved_target=DIAGNOSTIC_TARGET)
    elif argv == ['--diagnostic-stdin-key']:
        diagnostic = True
        origin, model = ORIGIN, DIAGNOSTIC_ALIAS
        monitor = HostMonitor(model, supplied_key(), approved_target=DIAGNOSTIC_TARGET)
    elif len(argv) == 3 and argv[0] in ('--local-test-only', '--local-diagnostic-test-only'):
        diagnostic = argv[0] == '--local-diagnostic-test-only'
        origin, model = argv[1:]
        parsed = urlsplit(origin)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise Guard('invalid_local_target')
        key = os.environ.get('CPS_SYNTHETIC_KEY', '')
        if not key.startswith('synthetic-') or len(key) < 16:
            raise Guard('invalid_test_key')
        monitor = LocalMonitor(key)
    else:
        raise Guard('invocation_required')
    runner = Runner(origin, model, monitor, diagnostic=diagnostic)
    previous = (signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda _sig, _frame: runner.abort('operator_stop'))
    try:
        print(json.dumps(runner.run(), separators=(',', ':')))
    finally:
        signal.signal(signal.SIGINT, previous[0])
        signal.signal(signal.SIGTERM, previous[1])


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception:
        print('benchmark preflight failed; no diagnostic details disclosed', file=sys.stderr)
        sys.exit(2)
