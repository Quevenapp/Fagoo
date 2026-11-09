"""Offline guard regressions for the deliberately rejected legacy RPC probe."""
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

import homologation_postgrest as qa


class PostgrestAcceptanceTests(unittest.TestCase):
    def test_probe_never_requests_a_real_state_change_or_the_current_version(self):
        command = str(uuid.uuid4())
        for version in (1, 100, 2147483647):
            for active in (True, False):
                result = qa.probe_payload({'version': version, 'active': active}, command)
                self.assertEqual(result['active'], active)
                self.assertNotEqual(result['expected_version'], version)
                self.assertGreaterEqual(result['expected_version'], 1)
                self.assertLessEqual(result['expected_version'], 2147483647)
                self.assertEqual(result['command_id'], command)

    def test_old_runtime_is_refused_before_login_or_http(self):
        with patch.object(qa.sys, 'argv', ['qa', '--execute']), \
                patch.object(qa.qa, 'read_config', return_value={}), \
                patch.object(qa, 'read_command', side_effect=['a' * 64, 'postgrest/postgrest:v14.18|fagoo-homolog|healthy']), \
                patch.object(qa, 'RestRun') as run, patch.object(qa.qa, 'http') as http:
            with self.assertRaisesRegex(qa.qa.QaError, 'QA_REST_16_PIN_REQUIRED'):
                qa.main()
            run.assert_not_called()
            http.assert_not_called()

    def test_binary_and_project_must_match_the_reviewed_image(self):
        for observed, version in [(qa.IMAGE + '|fagoo|healthy', 'PostgREST 16.5'),
                                  (qa.IMAGE + '|fagoo-homolog|healthy', 'PostgREST 14.18')]:
            with self.subTest(observed=observed, version=version), \
                    patch.object(qa, 'read_command', side_effect=['a' * 64, observed, version]), \
                    self.assertRaises(qa.qa.QaError):
                qa.runtime_preflight(Path('/opt/fagoo-homolog'))

    def test_default_only_checks_the_runtime_without_constructing_a_session(self):
        with patch.object(qa.sys, 'argv', ['qa']), patch.object(qa.qa, 'read_config', return_value={}), \
                patch.object(qa, 'runtime_preflight', return_value={'version': '16.5'}), \
                patch.object(qa, 'RestRun') as run, contextlib.redirect_stdout(io.StringIO()):
            qa.main()
        run.assert_not_called()

    def test_unfinished_crm_phase_prevents_any_auth_or_probe(self):
        run = object.__new__(qa.RestRun)
        run.run_id = '9e786a54cb21'
        run.report = {}
        run.auth = SimpleNamespace(state={}, report={'checks': []}, login=Mock())
        with patch.object(qa, 'validate_actors'), self.assertRaisesRegex(qa.qa.QaError, 'AUTH_CRM_PHASE_REQUIRED'):
            run.execute({'version': '16.5'})
        run.auth.login.assert_not_called()


if __name__ == '__main__':
    unittest.main()
