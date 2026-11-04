#!/usr/bin/env python3
"""Verify installation and optional-connection continuity before signing a release."""
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def main():
    suites = [
        ('private connection configuration', [sys.executable, '-m', 'unittest', 'discover', '-s', 'infra', '-p', 'test_integration_config.py']),
        ('application publication', [sys.executable, '-m', 'unittest', 'discover', '-s', 'infra', '-p', 'test_deploy_application.py']),
        ('update and recovery', [sys.executable, '-m', 'unittest', 'discover', '-s', 'infra', '-p', 'test_system_updates.py']),
        ('database defaults and API connection', ['node', '--test', 'infra/test-standalone-defaults.mjs',
            'workers/erp-api/test/integration-continuity.test.mjs', 'workers/erp-api/test/sync-delivery-safety.test.mjs']),
    ]
    for label, command in suites:
        print('Checking ' + label + '...', flush=True)
        try:
            result = subprocess.run(command, cwd=ROOT, stdin=subprocess.DEVNULL, timeout=600)
        except (OSError, subprocess.TimeoutExpired):
            raise SystemExit('UPDATE_CONTINUITY_CHECKS_INCOMPLETE') from None
        if result.returncode:
            raise SystemExit('UPDATE_CONTINUITY_CHECKS_FAILED')
    print('UPDATE_CONTINUITY_CHECKS_PASSED', flush=True)


if __name__ == '__main__':
    main()
