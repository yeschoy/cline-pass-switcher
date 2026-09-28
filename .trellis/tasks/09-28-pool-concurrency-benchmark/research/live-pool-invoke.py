#!/usr/bin/env python3
"""Operator-invoked, reviewed transport for live-pool-python.py. No default live action."""
import argparse
import base64
import json
import math
import os
import re
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import threading
import time

SCRIPT = Path(__file__).with_name('live-pool-python.py')
IDENTITY_NAME = '167.114.158.4_ubuntu_49555_ed25519'
REMOTE = 'ubuntu@167.114.158.4'


class InvocationFailure(Exception):
    """One of a fixed set of non-secret phases, never an exception detail."""


def identity_for(root):
    root = root.resolve()
    top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                         capture_output=True, timeout=5, check=True).stdout.decode().strip()
    if Path(top).resolve() != root:
        raise ValueError('repository mismatch')
    identity = root / IDENTITY_NAME
    info = identity.lstat()  # no symlinks; never open or inspect its contents
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('identity permissions')
    ignored = subprocess.run(['git', '-C', str(root), 'check-ignore', '-q', '--', IDENTITY_NAME],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             timeout=5, check=False)
    if ignored.returncode != 0:
        raise ValueError('identity not ignored')
    return identity


def valid_private_key(key):
    if not isinstance(key, str) or not 16 <= len(key) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise ValueError('invalid credential format')
    return key


def gui_prompt():
    # macOS GUI fallback when an embedded terminal has no controlling TTY.
    # The AppleScript argument is constant; the answer is captured only in memory.
    if sys.platform != 'darwin':
        raise ValueError('private input unavailable')
    script = ('text returned of (display dialog "Cline Pass Switcher client key" '
              'default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK")')
    result = subprocess.run(['osascript', '-e', script], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=90, check=False)
    if result.returncode or len(result.stdout) > 258 or not result.stdout.endswith(b'\n'):
        raise ValueError('private input cancelled')
    return valid_private_key(result.stdout[:-1].decode('ascii'))


def private_prompt():
    # Never fall back to an echoed terminal prompt. A missing/unusable TTY uses
    # a hidden macOS dialog instead; an invalid entered key does not retry.
    import termios
    try:
        tty = open('/dev/tty', 'r+')
        if not tty.isatty():
            tty.close()
            return gui_prompt()
        settings = termios.tcgetattr(tty.fileno())
    except (OSError, termios.error):
        return gui_prompt()
    with tty:
        hidden = settings[:]
        hidden[3] &= ~termios.ECHO
        try:
            termios.tcsetattr(tty.fileno(), termios.TCSADRAIN, hidden)
        except termios.error:
            return gui_prompt()
        try:
            tty.write('Client key (not displayed): ')
            tty.flush()
            key = tty.readline(258)
            if not key.endswith('\n'):
                # Drain any overlong line *before* restoring echo. Never retain it.
                while not key.endswith('\n'):
                    tail = tty.readline(258)
                    if not tail or tail.endswith('\n'):
                        break
                raise ValueError('invalid credential format')
        finally:
            termios.tcsetattr(tty.fileno(), termios.TCSADRAIN, settings)
            tty.write('\n')
            tty.flush()
        return valid_private_key(key[:-1])


def remote_command(script, mode):
    # Only source code and the non-secret mode appear in argv. ssh stdin is
    # exclusively the supplied credential; no remote script/temp file is made.
    encoded = base64.b64encode(script).decode('ascii')
    code = 'import base64; exec(compile(base64.b64decode("' + encoded + '"), "<benchmark>", "exec"))'
    return 'sudo -n python3 -c ' + shlex.quote(code) + ' ' + shlex.quote(mode)


def fields(value, names):
    if type(value) is not dict or set(value) != set(names.split()):
        raise ValueError('unexpected remote output')


def integer(value, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('unexpected remote output')


def number(value, maximum, nullable=False):
    if nullable and value is None:
        return
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError('unexpected remote output')


def timestamp(value):
    # Docker StartedAt may contain up to nine fractional digits; no free-form text.
    if type(value) is not str or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', value):
        raise ValueError('unexpected remote output')
    from datetime import datetime
    try:
        normalized = re.sub(r'(\.\d{6})\d{1,3}(?=Z|[+-])', r'\1', value)
        datetime.fromisoformat(normalized.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('unexpected remote output') from exc


def validate_output(record, mode):
    preflight = mode in ('--preflight-stdin-key', '--diagnostic-preflight-stdin-key')
    diagnostic = mode == '--diagnostic-stdin-key'
    fields(record, ('preflight runtimeImageSha256 runtimeStartedUtc owner ownerAccounts diagnostics resourceBaseline'
                    if preflight else 'schema stop runtimeImageSha256 runtimeStartedUtc limits sent paidAttemptsObservedOrReserved peakClientInFlight owner stream ownerAccounts resource backgroundCertainMinimum diagnostics stages unresolvedClientRequests'))
    if record['owner'] != 'legacy' or record['diagnostics'] not in ('off', 'error-only'):
        raise ValueError('unexpected remote output')
    if type(record['runtimeImageSha256']) is not str or not re.fullmatch(r'sha256:[a-f0-9]{64}', record['runtimeImageSha256']):
        raise ValueError('unexpected remote output')
    timestamp(record['runtimeStartedUtc'])
    accounts = record['ownerAccounts']
    fields(accounts, 'total eligible unlimited')
    for value in accounts.values():
        integer(value, 100000)
    if not accounts['unlimited'] <= accounts['eligible'] <= accounts['total']:
        raise ValueError('unexpected remote output')
    if preflight:
        if record['preflight'] != 'ok':
            raise ValueError('unexpected remote output')
        baseline = record['resourceBaseline']
        fields(baseline, 'cpuPct rssMiB memoryLimitMiB')
        for name in baseline:
            number(baseline[name], 1000000)
        return
    if type(record['schema']) is not int or record['schema'] != (2 if diagnostic else 1) or (
            record['stream'] != 'comparison' if diagnostic else record['stream'] is not False):
        raise ValueError('unexpected remote output')
    if record['stop'] not in ('monitor_guard', 'deadline', 'fanout', 'first_429', 'auth_drift',
                              'account_protection', 'invalid_reply', 'invalid', 'oversized_reply',
                              'connect_timeout', 'network', 'error_guard', 'success_guard',
                              'latency_guard', 'request_budget', 'dry_run_failed', 'steps_complete',
                              'operator_stop', 'diagnostic_failed', 'timeout'):
        raise ValueError('unexpected remote output')
    fields(record['limits'], 'rpm requests seconds inflightEmergency maxAttemptsPerChat')
    if record['limits'] != {'rpm': 350, 'requests': 2 if diagnostic else 900,
                            'seconds': 120 if diagnostic else 300,
                            'inflightEmergency': 1 if diagnostic else 64, 'maxAttemptsPerChat': 4}:
        raise ValueError('unexpected remote output')
    for name, maximum in [('sent', 2 if diagnostic else 900),
                          ('paidAttemptsObservedOrReserved', 8 if diagnostic else 900),
                          ('peakClientInFlight', 1 if diagnostic else 64),
                          ('backgroundCertainMinimum', 100000000),
                          ('unresolvedClientRequests', 1 if diagnostic else 64)]:
        integer(record[name], maximum)
    resource = record['resource']
    fields(resource, 'cpuPctMinMax rssMiBMinMax samples eventLoopDelay')
    if resource['eventLoopDelay'] is not None:
        raise ValueError('unexpected remote output')
    integer(resource['samples'], 1000)
    for name in ('cpuPctMinMax', 'rssMiBMinMax'):
        pair = resource[name]
        if type(pair) is not list or len(pair) != 2:
            raise ValueError('unexpected remote output')
        for value in pair:
            number(value, 1000000, nullable=True)
    stages = record['stages']
    names = (['diagnostic_nonstream', 'diagnostic_stream'] if diagnostic else
             ['dry_run', 'paced_60', 'paced_120', 'paced_240', 'paced_350'] +
             [f'burst_{n}' for n in (1, 2, 4, 8, 16, 32, 64)])
    if type(stages) is not list or len(stages) > len(names):
        raise ValueError('unexpected remote output')
    for index, stage in enumerate(stages):
        fields(stage, 'stage startedUtc endedUtc durationSeconds offered completed unresolvedAtStageEnd success successRate goodputRps completedRps peakClientInFlight attempts attemptsKnown latencySamples p50Ms p95Ms p99Ms errors')
        if stage['stage'] != names[index]:
            raise ValueError('unexpected remote output')
        timestamp(stage['startedUtc'])
        timestamp(stage['endedUtc'])
        for name, maximum in [('offered', 1 if diagnostic else 900), ('completed', 1 if diagnostic else 900),
                              ('unresolvedAtStageEnd', 1 if diagnostic else 64), ('success', 1 if diagnostic else 900),
                              ('peakClientInFlight', 1 if diagnostic else 64), ('attempts', 4 if diagnostic else 3600),
                              ('attemptsKnown', 1 if diagnostic else 900), ('latencySamples', 1 if diagnostic else 900)]:
            integer(stage[name], maximum)
        for name, maximum in [('durationSeconds', 330), ('goodputRps', 900), ('completedRps', 900)]:
            number(stage[name], maximum)
        number(stage['successRate'], 1, nullable=True)
        for name in ('p50Ms', 'p95Ms', 'p99Ms'):
            number(stage[name], 300000, nullable=True)
        errors = stage['errors']
        fields(errors, 'local429 attempted429 unknown429 server5xx auth unavailable invalid fanout network timeout cancelled')
        for value in errors.values():
            integer(value, 1 if diagnostic else 900)
        if (stage['success'] > stage['completed'] or stage['completed'] + stage['unresolvedAtStageEnd'] != stage['offered']
                or stage['latencySamples'] != stage['success']
                or stage['attemptsKnown'] > stage['completed']
                or sum(errors.values()) + stage['success'] != stage['completed']):
            raise ValueError('unexpected remote output')
    if sum(stage['offered'] for stage in stages) != record['sent']:
        raise ValueError('unexpected remote output')
    if diagnostic and (record['sent'] > 2 or len(stages) != record['sent'] or
                       any(stage['offered'] != 1 for stage in stages)):
        raise ValueError('unexpected remote output')


def invoke(mode, key, identity, script, popen=subprocess.Popen):
    if mode not in ('--preflight-stdin-key', '--execute-stdin-key',
                    '--diagnostic-preflight-stdin-key', '--diagnostic-stdin-key'):
        raise ValueError('invalid mode')
    cmd = ['ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
           '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
           '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
           '-i', str(identity), '-p', '49555', REMOTE, remote_command(script, mode)]
    if not isinstance(key, str) or not 16 <= len(key) <= 256 or any(not 33 <= ord(c) <= 126 for c in key):
        raise ValueError('invalid credential format')
    proc = popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    output = bytearray()
    overflow = threading.Event()

    def drain():
        while True:
            chunk = proc.stdout.read(4096)
            if not chunk:
                break
            if len(output) + len(chunk) > 65536:
                overflow.set()
                # Continue draining to avoid blocking the child on a full pipe.
            else:
                output.extend(chunk)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        proc.stdin.write(key.encode('ascii') + b'\n')
        proc.stdin.flush()  # Keep it open: remote stdin EOF is an abort signal.
        deadline = time.monotonic() + (35 if mode.endswith('preflight-stdin-key') else 145 if mode == '--diagnostic-stdin-key' else 330)
        while proc.poll() is None:
            if overflow.is_set():
                raise ValueError('remote preflight/experiment failed')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('remote preflight/experiment failed')
            try:
                proc.wait(timeout=min(.2, remaining))
            except subprocess.TimeoutExpired:
                pass
        reader.join(timeout=2)
        if reader.is_alive() or overflow.is_set() or proc.returncode or not output:
            raise ValueError('remote preflight/experiment failed')
        record = json.loads(output)
        validate_output(record, mode)
        if key.encode('ascii') in output:
            raise ValueError('unexpected remote output')
        return json.dumps(record, separators=(',', ':'))
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        proc.stdin.close()
        proc.stdout.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Explicit, private Legacy-pool benchmark invocation')
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--preflight', action='store_true', help='read-only, no paid chat')
    modes.add_argument('--live', action='store_true', help='paid experiment; requires separate risk acceptance')
    modes.add_argument('--diagnostic-preflight', action='store_true', help='alias/route read-only check')
    modes.add_argument('--diagnostic', action='store_true', help='at most two paid sequential diagnostic requests, no ramp')
    parser.add_argument('--accept-observable-only-guards', action='store_true',
                        help='acknowledge hidden upstream 429 and process-local protection cannot stop instantly')
    args = parser.parse_args(argv)
    if (args.live or args.diagnostic) and not args.accept_observable_only_guards:
        parser.error('paid modes require --accept-observable-only-guards after independent review')
    if (args.preflight or args.diagnostic_preflight) and args.accept_observable_only_guards:
        parser.error('risk acceptance applies only to paid modes')
    root = Path(__file__).resolve().parents[4]
    try:
        identity = identity_for(root)
    except Exception as exc:
        raise InvocationFailure('identity-check') from exc
    try:
        script = SCRIPT.read_bytes()
    except Exception as exc:
        raise InvocationFailure('source-read') from exc
    try:
        key = private_prompt()
    except Exception as exc:
        raise InvocationFailure('private-key-input') from exc
    mode = ('--execute-stdin-key' if args.live else
            '--diagnostic-stdin-key' if args.diagnostic else
            '--diagnostic-preflight-stdin-key' if args.diagnostic_preflight else
            '--preflight-stdin-key')
    try:
        print(invoke(mode, key, identity, script))
    except Exception as exc:
        raise InvocationFailure('remote-run') from exc


if __name__ == '__main__':
    try:
        main()
    except InvocationFailure as exc:
        print('benchmark invocation failed at ' + str(exc) + '; no diagnostic details disclosed', file=sys.stderr)
        sys.exit(2)
    except Exception:
        print('benchmark invocation failed; no diagnostic details disclosed', file=sys.stderr)
        sys.exit(2)
