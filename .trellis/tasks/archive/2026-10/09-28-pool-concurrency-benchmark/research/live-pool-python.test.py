#!/usr/bin/env python3
"""Loopback-only synthetic tests for live-pool-python.py. Run with python3 -B."""
import collections
import contextlib
import http.server
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('live-pool-python.py')
WRAPPER = Path(__file__).with_name('live-pool-invoke.py')
wrapper_spec = importlib.util.spec_from_file_location('invoker', WRAPPER)
invoker = importlib.util.module_from_spec(wrapper_spec)
wrapper_spec.loader.exec_module(invoker)
spec = importlib.util.spec_from_file_location('benchmark', SCRIPT)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)
KEY = 'synthetic-local-key-for-test'


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.hits += 1
        assert self.path == '/v1/chat/completions'
        assert self.headers['Authorization'] == 'Bearer ' + KEY
        assert self.headers['User-Agent'] == 'curl/8.0'
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        diagnostic = body['model'] == 'local/diagnostic'
        assert body['stream'] is (not diagnostic or self.server.hits == 2)
        assert body['max_tokens'] == 256
        assert body['model'] in ('local/mock', 'local/diagnostic')
        self.server.sessions.add(body['session_id'])
        self.server.bodies.append(body)
        status, attempts, payload = self.server.reply(self.server.hits)
        self.send_response(status)
        if attempts is not None:
            self.send_header('X-Cline-Attempts', str(attempts))
        if body['stream'] and status == 200:
            self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            if isinstance(payload, list):
                for part in payload:
                    self.wfile.write(part)
                    self.wfile.flush()
                    if self.server.peer_probe:
                        entered, closed = self.server.peer_probe
                        entered.set()
                        self.connection.settimeout(2)
                        if self.connection.recv(1) == b'':
                            closed.set()
                    if self.server.stream_hold:
                        self.server.stream_hold[0].set()
                        self.server.stream_hold[1].wait(3)
            else:
                self.wfile.write(json.dumps(payload).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class BenchTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.hits = 0
        self.server.sessions = set()
        self.server.bodies = []
        self.server.stream_hold = None
        self.server.peer_probe = None
        self.server.reply = lambda n: (200, 1, [
            b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n'])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def run_child(self, args=None, key=KEY):
        env = {'PATH': os.environ.get('PATH', ''), 'CPS_SYNTHETIC_KEY': key,
               'PYTHONDONTWRITEBYTECODE': '1'}
        p = subprocess.run([sys.executable, '-B', str(SCRIPT), *(args or ['--local-test-only', self.origin, 'local/mock'])],
                           env=env, capture_output=True, text=True, timeout=10)
        self.assertNotIn(KEY, p.stdout + p.stderr)
        self.assertNotIn(self.origin, p.stdout + p.stderr)
        self.assertNotIn('local/mock', p.stdout + p.stderr)
        return p

    def diagnostic_child(self):
        return self.run_child(['--local-diagnostic-test-only', self.origin, 'local/diagnostic'])

    def short_capacity_run(self, runner=None):
        # Exercise the real admission/send/response/stage path without a 120s
        # paid-rate window. These short windows cannot establish sustained RPM.
        runner = runner or benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        stage = runner.stage
        with patch.object(runner, 'stage', side_effect=lambda name, rate=0, duration=0, size=0:
                          stage(name, rate=rate, duration=min(duration, .25), size=size)):
            return runner.run()

    def test_diagnostic_fragmented_sse_requires_delta_done_and_clean_end(self):
        self.server.reply = lambda n: (200, 1, {'choices': [{'message': {'content': 'OK'}}]} if n == 1 else
            [b': comment\r\n\r\n', b'data: {"choices":[{"delta":{"content":"O',
             b'K"}}]}\r\n\r\n', b'data: [DO', b'NE]\r\n\r\n'])
        p = self.diagnostic_child()
        self.assertEqual(p.returncode, 0)
        out = json.loads(p.stdout)
        self.assertEqual((out['schema'], out['stream'], out['sent'], out['stop']), (2, 'comparison', 2, 'steps_complete'))
        self.assertEqual([s['success'] for s in out['stages']], [1, 1])
        self.assertEqual(out['paidAttemptsObservedOrReserved'], 2)
        self.assertEqual(self.server.hits, 2)
        self.assertNotIn('OK', p.stdout)

    def test_sse_deadline_applies_after_http_connection_detaches_close_response(self):
        entered, release = threading.Event(), threading.Event()
        self.server.stream_hold = (entered, release)
        self.server.reply = lambda n: (200, 1, [
            b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
            b'data: [DONE]\n\n'])
        conn = benchmark.http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=2)
        timer = threading.Timer(.25, release.set)
        try:
            conn.request('POST', '/v1/chat/completions', body=json.dumps({
                'model': 'local/diagnostic', 'stream': False, 'max_tokens': 256,
                'session_id': 'synthetic-test', 'messages': []}), headers={
                    'Authorization': 'Bearer ' + KEY, 'User-Agent': 'curl/8.0'})
            response = conn.getresponse()
            self.assertIsNone(conn.sock, 'HTTP/1.0 response owns the socket after detachment')
            timer.start()
            with self.assertRaises(benchmark.socket.timeout):
                benchmark.read_sse(response, conn, time.monotonic() + .08)
            self.assertTrue(entered.is_set())
        finally:
            release.set()
            if timer.is_alive():
                timer.join(1)
            conn.close()

    def test_abort_closes_detached_response_socket_and_drains_stalled_sse(self):
        entered, peer_closed = threading.Event(), threading.Event()
        self.server.peer_probe = (entered, peer_closed)
        self.server.reply = lambda n: (200, 1, [
            b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n'])
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        result = []
        t = threading.Thread(target=lambda: result.append(r.stage('dry_run')), daemon=True)
        t.start()
        self.assertTrue(entered.wait(2))
        until = time.monotonic() + 2
        while not any(res is not None and conn.sock is None for conn, (res, _) in list(r.active.items())) and time.monotonic() < until:
            time.sleep(.005)
        self.assertTrue(any(res is not None and conn.sock is None for conn, (res, _) in list(r.active.items())))
        r.abort('operator_stop')
        self.assertTrue(peer_closed.wait(2), 'remote peer must observe the cancelled socket EOF')
        t.join(2)
        self.assertFalse(t.is_alive(), 'client SSE reader must drain without waiting for DONE')
        self.assertEqual(r.inflight, 0)
        self.assertEqual(result[0]['success'], 0)
        self.assertEqual(result[0]['errors']['cancelled'], 1)
        self.assertEqual(result[0]['unresolvedAtStageEnd'], 0)
        self.assertEqual(self.server.hits, 1)

    def test_diagnostic_stream_errors_done_missing_empty_and_event_limit_stop(self):
        cases = [
            [b'data: {"error":"PRIVATE"}\n\n', b'data: [DONE]\n\n'],
            [b'event: error\ndata: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n'],
            [b'event:  ERROR\ndata: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n'],
            [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'],
            [b'data: [DONE]\n\n'],
            [b'data: ' + b'x' * (benchmark.SSE_EVENT_MAX + 1) + b'\n\n'],
            [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n', b'data: {"error":"PRIVATE"}\n\n'],
            [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: {"type":"error","message":"PRIVATE"}\n\n', b'data: [DONE]\n\n'],
            [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: {"object":"error","message":"PRIVATE"}\n\n', b'data: [DONE]\n\n'],
        ]
        for chunks in cases:
            with self.subTest(case=len(chunks)):
                self.server.hits = 0
                self.server.reply = lambda n: (200, 1, {'choices': [{'message': {'content': 'OK'}}]} if n == 1 else chunks)
                out = json.loads(self.diagnostic_child().stdout)
                self.assertEqual(out['sent'], 2)
                self.assertEqual(out['stop'], 'invalid')
                self.assertEqual(out['stages'][1]['success'], 0)

    def test_diagnostic_nonstream_failure_or_fanout_stops_before_stream(self):
        for reply, stop in (((500, 1, {'error': 'PRIVATE'}), 'diagnostic_failed'),
                            ((200, 2, {'choices': [{'message': {'content': 'OK'}}]}), 'fanout'),
                            ((429, 0, {'error': 'PRIVATE'}), 'first_429')):
            with self.subTest(stop=stop):
                self.server.hits = 0
                self.server.reply = lambda n: reply
                out = json.loads(self.diagnostic_child().stdout)
                self.assertEqual(out['sent'], 1)
                self.assertEqual(out['stop'], stop)

    def test_diagnostic_stream_429_stops_at_headers(self):
        self.server.reply = lambda n: (200, 1, {'choices': [{'message': {'content': 'OK'}}]}) if n == 1 else (429, 0, {'error': 'PRIVATE'})
        out = json.loads(self.diagnostic_child().stdout)
        self.assertEqual(out['stop'], 'first_429')
        self.assertEqual(out['sent'], 2)
        self.assertEqual(out['stages'][1]['errors']['local429'], 1)

    def test_diagnostic_stream_fanout_and_timeout_cancel(self):
        self.server.reply = lambda n: (200, 1 if n == 1 else 2,
            {'choices': [{'message': {'content': 'OK'}}]} if n == 1 else [b'data: [DONE]\n\n'])
        out = json.loads(self.diagnostic_child().stdout)
        self.assertEqual(out['stop'], 'fanout')
        self.assertEqual(out['sent'], 2)
        # A stalled SSE read must obey the absolute diagnostic deadline; no third request.
        self.server.hits = 0
        self.server.reply = lambda n: (200, 1, {'choices': [{'message': {'content': 'OK'}}]} if n == 1 else [b': ping\n\n'])
        with patch.object(benchmark, 'read_sse', side_effect=benchmark.socket.timeout()) as reader:
            r = benchmark.Runner(self.origin, 'local/diagnostic', benchmark.LocalMonitor(KEY), diagnostic=True)
            out = r.run()
        self.assertTrue(reader.called)
        self.assertEqual(out['stop'], 'timeout')
        self.assertEqual(out['sent'], 2)
        self.assertEqual(out['stages'][1]['errors']['timeout'], 1)

    def test_diagnostic_stream_operator_cancel_never_sends_third_request(self):
        observed, release = threading.Event(), threading.Event()
        self.server.stream_hold = (observed, release)
        self.server.reply = lambda n: (200, 1, {'choices': [{'message': {'content': 'OK'}}]} if n == 1 else
                                      [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'])
        r = benchmark.Runner(self.origin, 'local/diagnostic', benchmark.LocalMonitor(KEY), diagnostic=True)
        results = []
        t = threading.Thread(target=lambda: results.append(r.run()), daemon=True)
        try:
            t.start()
            self.assertTrue(observed.wait(3))
            r.abort('operator_stop')
            release.set()
            t.join(5)
            self.assertFalse(t.is_alive())
            self.assertEqual(results[0]['stop'], 'operator_stop')
            self.assertEqual(results[0]['sent'], 2)
            self.assertEqual(self.server.hits, 2)
        finally:
            release.set()

    def test_diagnostic_alias_preflight_is_exact_and_checks_resolved_override(self):
        target, alias = benchmark.MODEL, benchmark.DIAGNOSTIC_ALIAS
        config = {'knownModels': [target], 'modelAliases': {alias: target},
                  'perModel': {target: {'maxRetries': 1}},
                  'accounts': [{'id': 'hidden', 'key': KEY, 'enabled': True,
                                'perModel': {target: {'maxRetries': 0}}}]}
        meta = {'accountStates': {}, 'cachePoolTargetSize': 0,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        self.assertEqual(benchmark.projection(config, meta, alias, target)[4], 1)
        for aliases in ({}, {alias: 'other/model'}, {'pc': target}, {alias: target, target: 'other/model'}):
            with self.subTest(aliases=aliases), self.assertRaises(benchmark.Guard):
                benchmark.projection({**config, 'modelAliases': aliases}, meta, alias, target)
        config['accounts'][0]['perModel'][target] = {'maxRetries': None}
        with self.assertRaises(benchmark.Guard):
            benchmark.projection(config, meta, alias, target)
        self.assertEqual(self.server.hits, 0)

    def test_capacity_sse_ramp_and_adaptive_bursts_count_only_complete_streams(self):
        out = self.short_capacity_run()
        self.assertEqual((out['schema'], out['stream'], out['stop']), (3, True, 'steps_complete'))
        self.assertEqual([s['stage'] for s in out['stages']],
                         ['dry_run', 'paced_60', 'paced_120', 'paced_240', 'paced_350'] +
                         [f'burst_{n}' for n in (1, 2, 4, 8, 16, 32, 64)])
        self.assertEqual(out['sent'], self.server.hits)
        self.assertEqual(len(self.server.sessions), out['sent'])
        self.assertTrue(all(b['stream'] is True and b['max_tokens'] == 256 for b in self.server.bodies))
        self.assertLessEqual(out['sent'], 900)
        self.assertLessEqual(out['paidAttemptsObservedOrReserved'], 900)
        self.assertLessEqual(out['peakClientInFlight'], 64)
        self.assertGreaterEqual(out['peakClientInFlight'], 1)
        self.assertEqual(sum(s['offered'] for s in out['stages']), out['sent'])
        for s in out['stages']:
            self.assertEqual(s['completed'] + s['unresolvedAtStageEnd'], s['offered'])
            self.assertEqual(s['success'], s['completed'])
            self.assertEqual(s['latencySamples'], s['success'])
            self.assertEqual(s['attemptsKnown'], s['completed'])
            self.assertEqual(s['attempts'], s['completed'])
            self.assertLessEqual(s['peakClientInFlight'], 64)
            if s['completed']:
                self.assertGreater(s['p95Ms'], 0)
                self.assertGreater(s['goodputRps'], 0)
        invoker.validate_output({**out, 'runtimeImageSha256': 'sha256:' + 'a' * 64,
                                 'runtimeStartedUtc': '2026-09-28T00:00:00Z'}, '--execute-stdin-key')

    def test_capacity_stream_failure_at_first_paced_step_stops_without_more_sends(self):
        good = [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n']
        for reply, reason, category in (
            ([b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'], 'invalid', 'invalid'),
            ([b'data: [DONE]\n\n'], 'invalid', 'invalid'),
            ([b'event:  ERROR\ndata: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
              b'data: [DONE]\n\n'], 'invalid', 'invalid'),
            ([b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
              b'data: {"object":"error","message":"PRIVATE"}\n\n', b'data: [DONE]\n\n'], 'invalid', 'invalid'),
            ((429, 0, {'error': 'PRIVATE'}), 'first_429', 'local429'),
            ((429, 1, {'error': 'PRIVATE'}), 'first_429', 'attempted429'),
            ((200, 2, good), 'fanout', 'fanout'),
        ):
            with self.subTest(reason=reason, category=category):
                self.server.hits = 0
                self.server.reply = lambda n: (200, 1, good) if n == 1 else (
                    reply if isinstance(reply, tuple) else (200, 1, reply))
                out = self.short_capacity_run()
                self.assertEqual(out['stop'], reason)
                self.assertEqual(out['sent'], self.server.hits)
                self.assertEqual(out['sent'], 2)
                self.assertEqual(out['stages'][0]['success'], 1)
                step = out['stages'][1]
                self.assertEqual(step['stage'], 'paced_60')
                self.assertEqual(step['success'], 0)
                self.assertEqual(step['errors'][category], 1)
                self.assertEqual(step['latencySamples'], 0)
                self.assertEqual(out['paidAttemptsObservedOrReserved'],
                                 1 if category == 'local429' else 3 if category == 'fanout' else 2)

    def test_capacity_stream_timeout_and_operator_cancel_are_not_success(self):
        good = [b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', b'data: [DONE]\n\n']
        self.server.reply = lambda n: (200, 1, good)
        real_reader = benchmark.read_sse
        reads = 0
        def timeout_after_dry(*args):
            nonlocal reads
            reads += 1
            if reads > 1:
                raise benchmark.socket.timeout()
            return real_reader(*args)
        with patch.object(benchmark, 'read_sse', side_effect=timeout_after_dry):
            out = self.short_capacity_run()
        self.assertEqual((out['stop'], out['sent']), ('timeout', 2))
        self.assertEqual(out['stages'][1]['errors']['timeout'], 1)
        self.assertEqual(out['stages'][1]['success'], 0)

        entered, release = threading.Event(), threading.Event()
        reads = 0
        def suspended_reader(*args):
            nonlocal reads
            reads += 1
            if reads == 2:
                entered.set()
                release.wait(2)
            return real_reader(*args)
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        result = []
        try:
            with patch.object(benchmark, 'read_sse', side_effect=suspended_reader):
                t = threading.Thread(target=lambda: result.append(self.short_capacity_run(runner)), daemon=True)
                t.start()
                self.assertTrue(entered.wait(3))
                runner.abort('operator_stop')
                release.set()
                t.join(5)
            self.assertFalse(t.is_alive())
            self.assertEqual((result[0]['stop'], result[0]['sent']), ('operator_stop', 2))
            self.assertEqual(result[0]['stages'][1]['success'], 0)
            self.assertEqual(result[0]['stages'][1]['errors']['cancelled'], 1)
        finally:
            release.set()

    def test_capacity_budgets_apply_across_paced_and_burst_stages(self):
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        runner.max_requests = 5
        runner.max_paid = 5
        out = self.short_capacity_run(runner)
        self.assertEqual(out['stop'], 'request_budget')
        self.assertGreaterEqual(out['sent'], 1)
        self.assertLessEqual(out['sent'], 5)
        self.assertLessEqual(out['paidAttemptsObservedOrReserved'], 5)
        self.assertLessEqual(out['peakClientInFlight'], 64)
        self.assertEqual(self.server.hits, out['sent'])

    def test_rolling_send_seam_is_shared_across_capacity_stages(self):
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        with patch.object(benchmark, 'LIMIT_RPM', 3):
            first = runner.stage('paced_350', rate=60000, duration=.06)
            second = runner.stage('burst_4', rate=60000, duration=.04)
            self.assertEqual((first['offered'], second['offered']), (3, 0))
            self.assertEqual(len(runner.sent), 3)
            self.assertEqual(self.server.hits, 3)
            self.assertEqual(runner.paid_used, 3)
            runner.abort('operator_stop')
            self.assertFalse(runner.launch({'offered': 0, 'peakClientInFlight': 0}))
        self.assertEqual(self.server.hits, 3)

    def test_budget_truncated_burst_reports_actual_peak_not_named_target(self):
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        runner.paid_used = 896  # one four-attempt reservation remains
        first = runner.stage('burst_64', size=64)
        self.assertEqual(runner.reason, 'request_budget')
        self.assertEqual(first['plannedOffered'], 64)
        self.assertTrue(first['budgetCensored'])
        self.assertEqual(first['offered'], 1)
        self.assertEqual(first['peakClientInFlight'], 1)
        self.assertEqual(self.server.hits, 1)

    def test_slow_write_reservation_holds_rolling_slot_for_concurrent_sends_and_abort(self):
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        stage = {'name': 'burst_4', 'offered': 0, 'peakClientInFlight': 0,
                 'completed': 0, 'kinds': collections.Counter(), 'attemptsKnown': 0,
                 'attempts': 0, 'latencies': []}
        original = benchmark.http.client.HTTPConnection.request
        first_started, second_sent = threading.Event(), threading.Event()
        actual = []
        def slow_request(conn, *args, **kwargs):
            if not first_started.is_set():
                first_started.set()
                time.sleep(.16)  # crosses the shortened rolling window before real send
            actual.append(time.monotonic())
            if len(actual) == 2:
                second_sent.set()
            return original(conn, *args, **kwargs)
        with patch.object(benchmark, 'RPM_WINDOW_SECONDS', .12), \
             patch.object(benchmark, 'LIMIT_RPM', 1), \
             patch.object(benchmark.http.client.HTTPConnection, 'request', slow_request):
            self.assertTrue(runner.launch(stage))
            self.assertTrue(first_started.wait(2))
            self.assertTrue(runner.launch(stage))
            self.assertTrue(runner.launch(stage))
            self.assertTrue(second_sent.wait(2))
            runner.abort('operator_stop')
            until = time.monotonic() + 2
            while runner.inflight and time.monotonic() < until:
                time.sleep(.005)
        self.assertEqual(runner.inflight, 0)
        self.assertEqual(len(actual), 2)
        self.assertGreaterEqual(actual[1] - actual[0], .12)
        self.assertEqual(stage['offered'], 2)
        self.assertEqual(self.server.hits, 2)

    def test_capacity_host_modes_require_exact_alias_before_work(self):
        common = {'knownModels': [benchmark.MODEL],
                  'modelAliases': {benchmark.DIAGNOSTIC_ALIAS: benchmark.MODEL},
                  'perModel': {benchmark.MODEL: {'maxRetries': 1}},
                  'accounts': [{'id': 'synthetic-id', 'key': KEY, 'enabled': True}]}
        meta = {'accountStates': {}, 'cachePoolTargetSize': 0,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        self.assertEqual(benchmark.projection(common, meta, benchmark.DIAGNOSTIC_ALIAS, benchmark.MODEL)[4], 1)
        with self.assertRaises(benchmark.Guard):
            benchmark.projection({**common, 'modelAliases': {}}, meta, benchmark.DIAGNOSTIC_ALIAS, benchmark.MODEL)
        monitor = unittest.mock.Mock()
        monitor.image = 'sha256:' + 'a' * 64
        monitor.started = '2026-09-28T00:00:00Z'
        monitor.base = (None, 0, 0, 1, 1, 0)
        monitor.error_only = False
        monitor.cpu0 = monitor.rss0 = 0
        monitor.mem_limit = 512 * 1024**2
        with patch.object(benchmark, 'supplied_key', return_value=KEY), \
             patch.object(benchmark, 'HostMonitor', return_value=monitor) as factory, \
             patch.object(benchmark, 'Runner') as runner, contextlib.redirect_stdout(io.StringIO()):
            benchmark.main(['--preflight-stdin-key'])
            factory.assert_called_once_with(benchmark.DIAGNOSTIC_ALIAS, KEY, approved_target=benchmark.MODEL)
            factory.reset_mock()
            runner.return_value.run.return_value = {}
            benchmark.main(['--execute-stdin-key'])
            factory.assert_called_once_with(benchmark.DIAGNOSTIC_ALIAS, KEY, approved_target=benchmark.MODEL)
            runner.assert_called_once_with(benchmark.ORIGIN, benchmark.DIAGNOSTIC_ALIAS, monitor, diagnostic=False)
        self.assertEqual(self.server.hits, 0)

    def test_429_without_attempt_stops_before_ramp(self):
        self.server.reply = lambda n: (429, 0, {'error': {'message': 'PRIVATE'}})
        p = self.run_child()
        self.assertEqual(p.returncode, 0)
        out = json.loads(p.stdout)
        self.assertEqual(out['stop'], 'first_429')
        self.assertEqual(out['sent'], 1)
        self.assertEqual(out['stages'][0]['errors']['local429'], 1)
        self.assertEqual(self.server.hits, 1)

    def test_attempted_429_remains_unattributed(self):
        self.server.reply = lambda n: (429, 1, {'error': 'PRIVATE'})
        out = json.loads(self.run_child().stdout)
        self.assertEqual(out['stop'], 'first_429')
        self.assertEqual(out['stages'][0]['errors']['attempted429'], 1)

    def test_multiple_attempts_stop_dry_run(self):
        self.server.reply = lambda n: (200, 2, {'choices': [{'message': {'content': 'OK'}}]})
        out = json.loads(self.run_child().stdout)
        self.assertEqual(out['stop'], 'fanout')
        self.assertEqual(out['sent'], 1)
        self.assertEqual(out['stages'][0]['errors']['fanout'], 1)
        self.assertEqual(out['stages'][0]['unresolvedAtStageEnd'], 0)

    def test_stop_waits_briefly_for_worker_settlement_before_stage_snapshot(self):
        runner = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        runner.inflight = 1
        runner.abort('operator_stop')
        worker = threading.Thread(target=lambda: (time.sleep(.06), setattr(runner, 'inflight', 0)))
        worker.start()
        began = time.monotonic()
        runner.wait_drain()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(runner.inflight, 0)
        self.assertGreaterEqual(time.monotonic() - began, .04)
        self.assertEqual(self.server.hits, 0)

    def test_200_error_envelope_is_not_success(self):
        for error in ('PRIVATE', {}, None):
            with self.subTest(error=error):
                self.server.reply = lambda n: (200, 1, [
                    b'data: ' + json.dumps({'error': error, 'choices': [{'delta': {'content': 'OK'}}]}).encode() + b'\n\n',
                    b'data: [DONE]\n\n'])
                out = json.loads(self.run_child().stdout)
                self.assertEqual(out['sent'], 1)
                self.assertEqual(out['stages'][0]['success'], 0)
                self.assertEqual(out['stop'], 'invalid')

    def test_no_env_key_or_non_loopback_invocation_fails_before_network(self):
        self.assertEqual(self.run_child(key='').returncode, 2)
        self.assertEqual(self.run_child(['--local-test-only', 'https://example.org', 'local/mock']).returncode, 2)
        self.assertEqual(self.server.hits, 0)

    def test_hard_limits_and_monitor_veto(self):
        monitor = benchmark.LocalMonitor(KEY)
        r = benchmark.Runner(self.origin, 'local/mock', monitor)
        monitor.stop.set()
        stage = {'offered': 0, 'peakClientInFlight': 0}
        r.abort('monitor_guard')
        self.assertFalse(r.launch(stage))
        self.assertEqual(self.server.hits, 0)
        self.assertEqual(benchmark.LIMIT_RPM, 350)
        self.assertEqual(benchmark.LIMIT_REQUESTS, 900)
        self.assertEqual(benchmark.LIMIT_INFLIGHT, 64)
        self.assertEqual(benchmark.LIMIT_SECONDS, 300)
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        r.paid_used = 897
        self.assertFalse(r.launch(stage))  # must reserve four attempts per pending chat
        self.assertEqual(self.server.hits, 0)

    def test_signal_style_abort_is_reentrant_while_main_thread_holds_admission_lock(self):
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        with r.lock:
            r.abort('operator_stop')
        self.assertTrue(r.stop.is_set())
        self.assertEqual(r.reason, 'operator_stop')
        self.assertEqual(r.count, 0)

    def test_delayed_connection_cannot_send_after_abort_or_deadline_or_rate_block(self):
        class DelayedConnection:
            def __init__(self, *args, **kwargs):
                self.sock = None

            def connect(self):
                connected.set()
                release.wait(2)

            def request(self, *args, **kwargs):
                sends.append(time.monotonic())

            def close(self):
                pass

        for mode in ('abort', 'deadline', 'rate'):
            with self.subTest(mode=mode):
                connected, release = threading.Event(), threading.Event()
                sends = []
                r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
                stage = {'offered': 0, 'peakClientInFlight': 0}
                if mode == 'rate':
                    r.sent.extend([time.monotonic()] * benchmark.LIMIT_RPM)
                with patch.object(benchmark.http.client, 'HTTPConnection', DelayedConnection):
                    self.assertTrue(r.launch(stage))
                    self.assertTrue(connected.wait(2))
                    if mode == 'abort':
                        r.abort('operator_stop')
                    elif mode == 'deadline':
                        r.deadline = time.monotonic() - .001
                    release.set()
                    until = time.monotonic() + 2
                    if mode == 'rate':
                        time.sleep(.05)  # no send until an actual 60s slot frees
                        self.assertEqual(sends, [])
                        r.abort('operator_stop')
                    while r.inflight and time.monotonic() < until:
                        time.sleep(.005)
                self.assertEqual(r.inflight, 0)
                self.assertEqual(r.count, 0)
                self.assertEqual(stage['offered'], 0)
                self.assertEqual(sends, [])

    def test_expired_rolling_entries_are_pruned_only_at_send(self):
        connected, release = threading.Event(), threading.Event()
        sends = []

        class FakeResponse:
            status = 200

            def close(self):
                pass

            def getheader(self, name):
                return '1'

            def read(self, size):
                return b'{"choices":[{"message":{"content":"OK"}}]}'

        class DelayedConnection:
            sock = None

            def __init__(self, *args, **kwargs):
                pass

            def connect(self):
                connected.set()
                release.wait(2)

            def request(self, *args, **kwargs):
                sends.append(time.monotonic())

            def getresponse(self):
                return FakeResponse()

            def close(self):
                pass

        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        stage = {'offered': 0, 'peakClientInFlight': 0, 'completed': 0,
                 'kinds': collections.Counter(), 'attemptsKnown': 0,
                 'attempts': 0, 'latencies': []}
        with patch.object(benchmark.http.client, 'HTTPConnection', DelayedConnection), \
             patch.object(benchmark, 'read_sse', return_value=True):
            self.assertTrue(r.launch(stage))
            self.assertTrue(connected.wait(2))
            r.sent.extend([time.monotonic() - 61] * benchmark.LIMIT_RPM)
            release.set()
            until = time.monotonic() + 2
            while r.inflight and time.monotonic() < until:
                time.sleep(.005)
        self.assertEqual(len(sends), 1)
        self.assertEqual(len(r.sent), 1)
        self.assertEqual(stage['completed'], 1)
        self.assertEqual(r.paid_used, 1)

    def test_attempt_reservation_counts_observed_attempts_and_refuses_later_sends(self):
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        r.paid_used = 896
        stage = {'offered': 0, 'peakClientInFlight': 0, 'completed': 0,
                 'kinds': collections.Counter(), 'attemptsKnown': 0,
                 'attempts': 0, 'latencies': []}
        self.assertTrue(r.launch(stage))
        until = time.monotonic() + 2
        while r.inflight and time.monotonic() < until:
            time.sleep(.005)
        self.assertEqual(r.paid_used, 897)  # one observed attempt, unused reservation released
        r.paid_used = 897
        self.assertFalse(r.launch(stage))
        self.assertEqual(r.count, 1)

    def test_error_guard_veto_is_visible_before_abort_closes_sockets(self):
        self.server.reply = lambda n: (500, 1, {'error': 'PRIVATE'})
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        stage = {'offered': 0, 'peakClientInFlight': 0, 'completed': 0,
                 'kinds': collections.Counter(), 'attemptsKnown': 0,
                 'attempts': 0, 'latencies': []}
        self.assertTrue(r.launch(stage))
        until = time.monotonic() + 2
        while r.inflight and time.monotonic() < until:
            time.sleep(.005)
        self.assertEqual(stage['completed'], 1)
        entered, release = threading.Event(), threading.Event()
        original_abort = r.abort
        def paused_abort(why):
            if why == 'error_guard':
                entered.set()
                release.wait(2)
            original_abort(why)
        try:
            with patch.object(r, 'abort', side_effect=paused_abort):
                self.assertTrue(r.launch(stage))
                self.assertTrue(entered.wait(2))
                self.assertTrue(r.stop.is_set())
                self.assertFalse(r.launch(stage), 'no request may pass admission while abort is pending')
        finally:
            release.set()
        self.assertEqual(stage['offered'], 2)
        self.assertEqual(self.server.hits, 2)

    def test_aborted_stage_snapshot_stays_consistent_after_late_worker_settles(self):
        sent, release = threading.Event(), threading.Event()
        class Response:
            status = 200
            def close(self):
                pass
            def getheader(self, name):
                return '1'
            def read(self, size):
                return b'{"choices":[{"message":{"content":"OK"}}]}'
        class DelayedConnection:
            sock = None
            def __init__(self, *args, **kwargs):
                pass
            def connect(self):
                pass
            def request(self, *args, **kwargs):
                sent.set()
            def getresponse(self):
                release.wait(2)
                return Response()
            def close(self):
                pass
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        out = []
        try:
            with patch.object(benchmark.http.client, 'HTTPConnection', DelayedConnection), \
                 patch.object(benchmark, 'read_sse', return_value=True):
                t = threading.Thread(target=lambda: out.append(r.stage('dry_run')))
                t.start()
                self.assertTrue(sent.wait(2))
                r.abort('operator_stop')
                t.join(2)
                self.assertFalse(t.is_alive())
                self.assertEqual(out[0]['offered'], 1)
                self.assertEqual(out[0]['completed'], 0)
                self.assertEqual(out[0]['unresolvedAtStageEnd'], 1)
                release.set()
                until = time.monotonic() + 2
                while r.inflight and time.monotonic() < until:
                    time.sleep(.005)
                self.assertEqual(r.inflight, 0)
                self.assertEqual(out[0]['completed'], 0, 'frozen report must not mutate after return')
                self.assertEqual(out[0]['latencySamples'], 0)
        finally:
            release.set()

    def test_unresolved_worker_keeps_paid_attempt_reservation_in_summary(self):
        r = benchmark.Runner(self.origin, 'local/mock', benchmark.LocalMonitor(KEY))
        def incomplete_dry_stage(*args, **kwargs):
            with r.lock:
                r.count, r.inflight, r.paid_used, r.peak = 1, 1, 2, 1
            r.abort('operator_stop')
            return {'success': 1, 'attempts': 1, 'attemptsKnown': 1}
        with patch.object(r, 'stage', side_effect=incomplete_dry_stage):
            result = r.run()
        self.assertEqual(result['unresolvedClientRequests'], 1)
        self.assertEqual(result['paidAttemptsObservedOrReserved'], 6)
        self.assertEqual(result['sent'], 1)

    def test_non_200_multiple_attempts_stop_immediately(self):
        self.server.reply = lambda n: (503, 2, {'error': 'PRIVATE'})
        out = json.loads(self.run_child().stdout)
        self.assertEqual(out['stop'], 'fanout')
        self.assertEqual(out['sent'], 1)
        self.assertEqual(out['stages'][0]['errors']['fanout'], 1)

    def test_private_host_preflight_fails_closed_on_runtime_drift(self):
        config = {'knownModels': [benchmark.MODEL], 'perModel': {benchmark.MODEL: {'maxRetries': 1}}, 'clientKeys': [], 'proxyKey': KEY,
                  'accounts': [{'id': 'hidden', 'key': KEY, 'clientKeyId': 'legacy', 'enabled': True}]}
        meta = {'accountStates': {'hidden': {}}, 'cachePoolTargetSize': 1,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        env = ['DATA_DIR=/data', 'PROXY_KEY=' + KEY]
        state = {'Status': 'running', 'Health': {'Status': 'healthy'}, 'StartedAt': 'first'}
        mounts = [{'Source': '/opt/cline-pass-switcher/data', 'Destination': '/data', 'RW': True}]
        def inspect(*args):
            return '|'.join(json.dumps(x) for x in (state, 512 * 1024**2, env, 'sha256:' + 'a' * 64, mounts)).encode()
        def read(path):
            return config if path == benchmark.CONFIG else meta
        with patch.object(benchmark, 'private_command', inspect), patch.object(benchmark, 'private_json', read), \
             patch.object(benchmark, 'public_readiness'), patch.object(benchmark, 'resource_sample', return_value=(2, 128 * 1024**2)), \
             patch.object(benchmark, 'stdin_guard'):
            mon = benchmark.HostMonitor(benchmark.MODEL, KEY, control_fd=0)
            mon.check()
            self.assertEqual(mon.base[4], 1)
            state['Health']['Status'] = 'unhealthy'
            with self.assertRaises(benchmark.Guard):
                mon.check()
            state['Health']['Status'] = 'healthy'
            config['proxyKey'] = 'synthetic-rotated-elsewhere'
            with self.assertRaises(benchmark.Guard):
                benchmark.HostMonitor(benchmark.MODEL, KEY)
            config['proxyKey'] = KEY
            env.append('CLINE_PASS_KEY=synthetic-injected-key')
            with self.assertRaises(benchmark.Guard):
                benchmark.HostMonitor(benchmark.MODEL, KEY)
            env.pop()

    def test_stdin_credential_matches_legacy_only_and_never_falls_back(self):
        config = {'proxyKey': KEY, 'clientKeys': [{'key': 'synthetic-other-owner'}]}
        env = ['PROXY_KEY=' + KEY]
        self.assertTrue(benchmark.confirm_legacy_key(config, env, KEY))
        for supplied in ('synthetic-other-owner', 'synthetic-wrong-key', ''):
            with self.subTest(supplied=supplied), self.assertRaises(benchmark.Guard):
                benchmark.confirm_legacy_key(config, env, supplied)
        config['clientKeys'].append({'key': KEY})
        with self.assertRaises(benchmark.Guard):
            benchmark.confirm_legacy_key(config, env, KEY)
        config['clientKeys'].pop()
        config['proxyKey'] = 'synthetic-new-legacy-key'
        with self.assertRaises(benchmark.Guard):
            benchmark.confirm_legacy_key(config, env, KEY)

    def test_private_stdin_input_and_preflight_output_do_not_reveal_key(self):
        def input_pipe(data):
            read_fd, write_fd = os.pipe()
            os.write(write_fd, data)
            os.close(write_fd)
            return read_fd
        fd = input_pipe((KEY + '\nextra').encode())
        try:
            with patch.object(benchmark.sys, 'stdin', type('Input', (), {'fileno': lambda _: fd})()):
                self.assertEqual(benchmark.supplied_key(), KEY)
                with self.assertRaises(benchmark.Guard):
                    benchmark.stdin_guard(fd)
        finally:
            os.close(fd)
        for data in (b'', b'bad\n', b'x' * 259):
            with self.subTest(length=len(data)):
                fd = input_pipe(data)
                try:
                    with patch.object(benchmark.sys, 'stdin', type('Input', (), {'fileno': lambda _: fd})()):
                        with self.assertRaises(benchmark.Guard):
                            benchmark.supplied_key()
                finally:
                    os.close(fd)
        class Monitor:
            key = KEY
            image = 'sha256:' + 'a' * 64
            started = 'local'
            base = (None, 0, 0, 1, 1, 0)
            error_only = False
            cpu0 = 0
            rss0 = 0
            mem_limit = 512 * 1024**2
            def check(self):
                pass
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(benchmark, 'HostMonitor', return_value=Monitor()), \
             patch.object(benchmark, 'supplied_key', return_value=KEY), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            benchmark.main(['--preflight-stdin-key'])
        self.assertEqual(json.loads(stdout.getvalue())['owner'], 'legacy')
        self.assertNotIn(KEY, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(self.server.hits, 0)

    def test_host_monitor_stops_on_eof_and_extra_input(self):
        for suffix in (b'', b'extra'):
            with self.subTest(suffix=suffix):
                read_fd, write_fd = os.pipe()
                try:
                    mon = benchmark.HostMonitor.__new__(benchmark.HostMonitor)
                    mon.control_fd = read_fd
                    mon.stop = threading.Event()
                    mon.reason = None
                    with patch.object(mon, 'check', side_effect=lambda: None):
                        t = threading.Thread(target=mon.run)
                        t.start()
                        if suffix:
                            os.write(write_fd, suffix)
                        else:
                            os.close(write_fd)
                            write_fd = None
                        self.assertTrue(mon.stop.wait(1))
                        t.join(1)
                        self.assertFalse(t.is_alive())
                        self.assertEqual(mon.reason, 'monitor_guard')
                finally:
                    if write_fd is not None:
                        os.close(write_fd)
                    os.close(read_fd)

    def test_host_monitor_rejects_supplied_extra_owner_before_ingress_or_paid_call(self):
        config = {'proxyKey': KEY, 'clientKeys': [{'key': 'synthetic-other-owner'}]}
        env = ['DATA_DIR=/data', 'PROXY_KEY=' + KEY]
        state = {'Status': 'running', 'Health': {'Status': 'healthy'}, 'StartedAt': 'first'}
        mounts = [{'Source': '/opt/cline-pass-switcher/data', 'Destination': '/data', 'RW': True}]
        def inspect(*args):
            return '|'.join(json.dumps(x) for x in (state, 512 * 1024**2, env, 'sha256:' + 'a' * 64, mounts)).encode()
        with patch.object(benchmark, 'private_command', inspect), patch.object(benchmark, 'private_json', return_value=config), \
             patch.object(benchmark, 'stdin_guard'), patch.object(benchmark, 'public_readiness') as readiness:
            with self.assertRaises(benchmark.Guard):
                benchmark.HostMonitor(benchmark.MODEL, 'synthetic-other-owner')
            readiness.assert_not_called()
        self.assertEqual(self.server.hits, 0)

    def test_hidden_gui_fallback_never_passes_key_as_argument(self):
        from unittest.mock import Mock
        fake = Mock(returncode=0, stdout=(KEY + '\n').encode())
        with patch.object(invoker.sys, 'platform', 'darwin'), \
             patch.object(invoker.subprocess, 'run', return_value=fake) as run, \
             patch('builtins.open', side_effect=OSError('no controlling tty')):
            self.assertEqual(invoker.private_prompt(), KEY)
        args = run.call_args.args[0]
        self.assertEqual(args[0], 'osascript')
        self.assertNotIn(KEY, ' '.join(args))
        self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)
        fake.stdout = b'short\n'
        with patch.object(invoker.sys, 'platform', 'darwin'), patch.object(invoker.subprocess, 'run', return_value=fake):
            with self.assertRaises(ValueError):
                invoker.gui_prompt()

    def test_wrapper_has_no_implicit_live_mode(self):
        self.assertEqual(WRAPPER.resolve().parents[4], Path(__file__).resolve().parents[4])
        self.assertEqual(invoker.SCRIPT.resolve(), SCRIPT.resolve())
        for old_mode in ('--execute', '--preflight-only'):
            with self.assertRaises(benchmark.Guard):
                benchmark.main([old_mode])
        env = {'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1'}
        for args in ([], ['--live'], ['--diagnostic'], ['--preflight', '--accept-observable-only-guards'],
                     ['--diagnostic-preflight', '--accept-observable-only-guards']):
            result = subprocess.run([sys.executable, '-B', str(WRAPPER), *args], env=env,
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(KEY, result.stdout + result.stderr)
        self.assertEqual(self.server.hits, 0)

    def test_local_wrapper_transports_key_only_in_open_stdin(self):
        import base64
        import re
        import shlex
        script = SCRIPT.read_bytes()
        common = {'runtimeImageSha256': 'sha256:' + 'a' * 64,
                  'runtimeStartedUtc': '2026-09-28T00:00:00.123456789Z', 'owner': 'legacy',
                  'ownerAccounts': {'total': 1, 'eligible': 1, 'unlimited': 0}, 'diagnostics': 'off'}
        preflight = {**common, 'preflight': 'ok',
                     'resourceBaseline': {'cpuPct': 1.0, 'rssMiB': 128.0, 'memoryLimitMiB': 512.0}}
        live = {**common, 'schema': 3, 'stop': 'monitor_guard', 'stream': True,
                'limits': {'rpm': 350, 'requests': 900, 'seconds': 300, 'inflightEmergency': 64,
                           'maxAttemptsPerChat': 4}, 'sent': 0, 'paidAttemptsObservedOrReserved': 0,
                'peakClientInFlight': 0, 'backgroundCertainMinimum': 0, 'unresolvedClientRequests': 0,
                'resource': {'cpuPctMinMax': [None, None], 'rssMiBMinMax': [None, None],
                             'samples': 0, 'eventLoopDelay': None}, 'stages': []}
        diagnostic = {**live, 'schema': 2, 'stream': 'comparison',
                      'limits': {'rpm': 350, 'requests': 2, 'seconds': 120,
                                 'inflightEmergency': 1, 'maxAttemptsPerChat': 4}}
        captured = []
        def fake_popen(argv, **kwargs):
            captured.append((argv, kwargs))
            mode = shlex.split(argv[-1])[-1]
            payload = preflight if mode.endswith('preflight-stdin-key') else diagnostic if mode == '--diagnostic-stdin-key' else live
            # Local synthetic process checks the control pipe is STILL OPEN after
            # receiving the line; no SSH or paid endpoint is contacted.
            code = ('import json,sys,select; line=sys.stdin.buffer.readline(); '
                    'assert line.endswith(b"\\n"); '
                    'assert not select.select([sys.stdin],[],[],0)[0]; '
                    'print(json.dumps(' + repr(payload) + '))')
            return subprocess.Popen([sys.executable, '-B', '-c', code], **kwargs)
        for mode in ('--preflight-stdin-key', '--execute-stdin-key',
                     '--diagnostic-preflight-stdin-key', '--diagnostic-stdin-key'):
            out = invoker.invoke(mode, KEY, Path('/synthetic/identity'), script, popen=fake_popen)
            self.assertEqual(json.loads(out)['owner'], 'legacy')
            argv, kwargs = captured[-1]
            self.assertNotIn(KEY, ' '.join(argv) + out)
            self.assertEqual(kwargs['stdin'], subprocess.PIPE)
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            self.assertIn('BatchMode=yes', argv)
            remote = shlex.split(argv[-1])
            self.assertEqual(remote[:4], ['sudo', '-n', 'python3', '-c'])
            self.assertEqual(remote[-1], mode)
            encoded = re.search(r'base64\.b64decode\("([A-Za-z0-9+/=]+)"\)', remote[4]).group(1)
            self.assertEqual(base64.b64decode(encoded), script)
        self.assertEqual(self.server.hits, 0)
        sample = {'stage': 'dry_run', 'plannedOffered': 1, 'budgetCensored': False,
                  'startedUtc': common['runtimeStartedUtc'],
                  'endedUtc': common['runtimeStartedUtc'], 'durationSeconds': 1,
                  'offered': 1, 'completed': 1, 'unresolvedAtStageEnd': 0, 'success': 1, 'successRate': 1.0,
                  'goodputRps': 1.0, 'completedRps': 1.0, 'peakClientInFlight': 1,
                  'attempts': 1, 'attemptsKnown': 1, 'latencySamples': 1,
                  'p50Ms': 1.0, 'p95Ms': 1.0, 'p99Ms': 1.0,
                  'errors': dict.fromkeys(('local429', 'attempted429', 'unknown429', 'server5xx',
                                           'auth', 'unavailable', 'invalid', 'fanout', 'network',
                                           'timeout', 'cancelled'), 0)}
        invoker.validate_output(diagnostic, '--diagnostic-stdin-key')
        for path, value in ((('stream',), False), (('schema',), 1), (('limits', 'requests'), 900),
                            (('stages',), [{'stage': KEY}])):
            changed = json.loads(json.dumps(diagnostic))
            target = changed
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = value
            with self.assertRaises(ValueError):
                invoker.validate_output(changed, '--diagnostic-stdin-key')
        measured = {**live, 'sent': 1, 'paidAttemptsObservedOrReserved': 1,
                    'peakClientInFlight': 1, 'stages': [sample]}
        invoker.validate_output(measured, '--execute-stdin-key')
        for bad in ({'plannedOffered': 64}, {'budgetCensored': True}):
            changed = json.loads(json.dumps(measured))
            changed['stages'][0].update(bad)
            with self.assertRaises(ValueError):
                invoker.validate_output(changed, '--execute-stdin-key')
        for field in ('errors', 'p95Ms', 'stage', 'unresolvedAtStageEnd'):
            changed = json.loads(json.dumps(measured))
            if field == 'errors':
                changed['stages'][0]['errors']['network'] = KEY
            else:
                changed['stages'][0][field] = KEY if field != 'unresolvedAtStageEnd' else 1
            with self.assertRaises(ValueError):
                invoker.validate_output(changed, '--execute-stdin-key')
        for path, value in ((('ownerAccounts', 'total'), KEY), (('resourceBaseline', 'cpuPct'), KEY),
                            (('resourceBaseline', 'nested'), {'payload': KEY}),
                            (('diagnostics',), KEY)):
            with self.subTest(path=path):
                changed = json.loads(json.dumps(preflight))
                target = changed
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                with self.assertRaises(ValueError):
                    invoker.validate_output(changed, '--preflight-stdin-key')
        for path, value in ((('stages',), [{'stage': KEY}]),
                            (('resource', 'cpuPctMinMax'), [KEY, 1]),
                            (('limits', 'extra'), KEY), (('stop',), KEY)):
            with self.subTest(path=path):
                changed = json.loads(json.dumps(live))
                target = changed
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                with self.assertRaises(ValueError):
                    invoker.validate_output(changed, '--execute-stdin-key')

    def test_wrapper_rejects_nonzero_child_even_with_valid_looking_output(self):
        def failed_child(argv, **kwargs):
            code = ('import json,sys; sys.stdin.buffer.readline(); '
                    'print(json.dumps({"preflight":"ok"})); sys.exit(1)')
            return subprocess.Popen([sys.executable, '-B', '-c', code], **kwargs)
        with self.assertRaises(ValueError):
            invoker.invoke('--preflight-stdin-key', KEY, Path('/synthetic/identity'), b'pass', popen=failed_child)
        self.assertEqual(self.server.hits, 0)

    def test_wrapper_interrupt_closes_local_ssh_pipe(self):
        class Interrupted:
            def __init__(self, *args, **kwargs):
                self.stdin, self.stdout = io.BytesIO(), io.BytesIO()
                self.returncode = None
                self.terminated = False

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                if not self.terminated:
                    raise KeyboardInterrupt()
                self.returncode = -15
                return self.returncode

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.terminated = True
        processes = []
        def spawn(*args, **kwargs):
            proc = Interrupted()
            processes.append(proc)
            return proc
        with self.assertRaises(KeyboardInterrupt):
            invoker.invoke('--preflight-stdin-key', KEY, Path('/synthetic/identity'), b'pass', popen=spawn)
        self.assertTrue(processes[0].terminated)
        self.assertTrue(processes[0].stdin.closed)
        self.assertTrue(processes[0].stdout.closed)

    def test_wrapper_timeout_terminates_then_kills_local_ssh(self):
        class Stuck:
            def __init__(self, *args, **kwargs):
                self.stdin, self.stdout = io.BytesIO(), io.BytesIO()
                self.returncode = None
                self.terminated = self.killed = False

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                if self.killed:
                    self.returncode = -9
                    return self.returncode
                raise subprocess.TimeoutExpired('synthetic', timeout)

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.killed = True
        proc = Stuck()
        # Force the local deadline without contacting SSH or sleeping 35 seconds.
        with patch.object(invoker.time, 'monotonic', side_effect=[0, 36]), self.assertRaises(ValueError):
            invoker.invoke('--preflight-stdin-key', KEY, Path('/synthetic/identity'), b'pass', popen=lambda *a, **k: proc)
        self.assertTrue(proc.terminated and proc.killed)
        self.assertTrue(proc.stdin.closed and proc.stdout.closed)

    def test_existing_error_only_diagnostics_is_allowed_but_full_is_not(self):
        config = {'knownModels': [benchmark.MODEL], 'perModel': {benchmark.MODEL: {'maxRetries': 1}}, 'clientKeys': [],
                  'accounts': [{'id': 'hidden', 'key': KEY, 'clientKeyId': 'legacy', 'enabled': True}],
                  'errorDetailLogging': True}
        meta = {'accountStates': {}, 'cachePoolTargetSize': 1,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        self.assertEqual(benchmark.projection(config, meta, benchmark.MODEL)[4], 1)
        config['detailedLogging'] = True
        with self.assertRaises(benchmark.Guard):
            benchmark.projection(config, meta, benchmark.MODEL)

    def test_projection_rejects_protection_and_unknown_model_without_leak(self):
        config = {'knownModels': ['local/mock'], 'perModel': {'local/mock': {'maxRetries': 0}}, 'clientKeys': [],
                  'accounts': [{'id': 'hidden', 'key': KEY, 'clientKeyId': 'legacy', 'enabled': True}]}
        meta = {'accountStates': {'hidden': {}}, 'cachePoolTargetSize': 1,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        self.assertEqual(benchmark.projection(config, meta, 'local/mock')[4], 1)
        meta['accountStates']['hidden']['protectionShortAt'] = 1
        with self.assertRaises(benchmark.Guard):
            benchmark.projection(config, meta, 'local/mock')
        with self.assertRaises(benchmark.Guard):
            benchmark.projection(config, meta, 'wrong-model')

    def test_route_preflight_rejects_unbounded_and_account_override(self):
        model = 'local/mock'
        config = {'knownModels': [model], 'perModel': {model: {'maxRetries': 1}},
                  'accounts': [{'id': 'hidden', 'key': KEY, 'enabled': True}]}
        meta = {'accountStates': {}, 'cachePoolTargetSize': 0,
                'statistics': {'lifetime': {'global': {'requests': 0}}}}
        self.assertEqual(benchmark.projection(config, meta, model)[4], 1)
        account = config['accounts'][0]
        for route in ({}, {'maxRetries': None}, {'maxRetries': 2}, {'maxRetries': True}, {'maxRetries': '1'}):
            with self.subTest(route=route):
                account['perModel'] = {model: route}
                with self.assertRaises(benchmark.Guard):
                    benchmark.projection(config, meta, model)
        account['perModel'] = {model: {'maxRetries': 0}}
        self.assertEqual(benchmark.projection(config, meta, model)[4], 1)
        config['modelAliases'] = {model: 'other/model'}
        with self.assertRaises(benchmark.Guard):
            benchmark.projection(config, meta, model)


if __name__ == '__main__':
    unittest.main()
