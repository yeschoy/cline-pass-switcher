#!/usr/bin/env python3
"""Retired stop/start prototype. Never use for a backup or recovery window.

The only reviewed local candidate is backup_pause_window.py, using an exact-ID
independent persistent unpause watchdog. This file intentionally performs no operations.
"""
import sys

if __name__ == '__main__':
    print('stop/start backup prototype retired; use reviewed pause-only flow', file=sys.stderr)
    sys.exit(1)
