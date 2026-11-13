from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

from configure import derived_origins

SPEC = importlib.util.spec_from_file_location('install_assistant', Path(__file__).with_name('install-assistant.py'))
ASSISTANT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSISTANT)
Stop = ASSISTANT.Stop

ACCOUNT, ZONE = 'a' * 32, 'b' * 32
TUNNEL = 'a701e943-17bd-441b-a768-380b82eb1a82'
OTHER_TUNNEL = 'a701e943-17bd-441b-a768-380b82eb1a83'
ORIGINS = derived_origins('example.test')
SUFFIX = ASSISTANT.installation_suffix(ORIGINS[0])


class FakeCloudflare:
    """Answers the documented endpoints from in-memory state and records every call."""

    def __init__(self, *, zones=None, records=None, domains=(), tunnels=(), refuse=()):
        self.zones = [{'id': ZONE, 'name': 'example.test', 'status': 'active', 'account': {'id': ACCOUNT}}] if zones is None else zones
        self.records = dict(records or {})
        self.domains, self.tunnels, self.refuse, self.calls = list(domains), list(tunnels), refuse, []

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if any(part in path for part in self.refuse):
            raise Stop('CLOUDFLARE_PERMISSION_MISSING')
        if path == '/user/tokens/verify':
            return {'status': 'active', 'expires_on': '2027-06-01T00:00:00Z'}
        if path.startswith('/zones?'):
            name = path.split('name=')[1].split('&')[0]
            return [zone for zone in self.zones if zone['name'] == name]
        if path == '/accounts/' + ACCOUNT + '/workers/domains':
            return self.domains
        if '/dns_records' in path:
            if method == 'POST':
                self.records.setdefault(body['name'], []).append(body)
                return body
            return self.records.get(path.split('name=')[1].split('&')[0], [])
        if '/cfd_tunnel' in path:
            if method == 'POST':
                self.tunnels.append({'id': TUNNEL, 'name': body['name'], 'config_src': body['config_src']})
                return {'id': TUNNEL, 'token': 'never-read'}
            if method == 'PUT':
                return {}
            if path.endswith('/token'):
                return 'tunnel-token'
            return self.tunnels
        raise AssertionError('Unexpected Cloudflare call: ' + method + ' ' + path)

    def writes(self):
        return [(method, path) for method, path, _ in self.calls if method != 'GET']


def tunnel_record(tunnel=TUNNEL):
    return {'type': 'CNAME', 'name': 'fagoo-services.example.test', 'content': tunnel + '.cfargotunnel.com', 'proxied': True}


class AddressTests(unittest.TestCase):
    def test_one_domain_gives_the_three_addresses_in_the_installer_order(self):
        expected = ('https://fagoo.example.test', 'https://fagoo-services.example.test', 'https://fagoo-api.example.test')
        for typed in ('example.test', ' Example.Test ', 'https://example.test/', 'www.example.test', 'example.test.'):
            self.assertEqual(derived_origins(typed), expected)
        for invalid in ('', 'localhost', 'example.test/path', 'exa mple.test', '127.0.0.1', None):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                derived_origins(invalid)

    def test_command_line_accepts_a_domain_or_three_origins_but_not_a_mixture(self):
        arguments = lambda **values: types.SimpleNamespace(**{'domain': None, 'web_origin': None, 'backend_origin': None, 'api_origin': None, **values})
        self.assertIsNone(ASSISTANT.requested_origins(arguments()))
        self.assertEqual(ASSISTANT.requested_origins(arguments(domain='example.test')), ORIGINS)
        explicit = dict(web_origin='https://erp.example.test', backend_origin='https://data.example.test', api_origin='https://api.example.test')
        self.assertEqual(ASSISTANT.requested_origins(arguments(**explicit)), tuple(explicit.values()))
        for invalid in (dict(domain='example.test', web_origin='https://erp.example.test'), dict(web_origin='https://erp.example.test'),
                        {**explicit, 'api_origin': explicit['web_origin']}, {**explicit, 'api_origin': 'http://api.example.test'}):
            with self.subTest(value=invalid), self.assertRaises(Stop):
                ASSISTANT.requested_origins(arguments(**invalid))


class CloudflareTests(unittest.TestCase):
    def test_zone_and_account_are_discovered_from_the_address(self):
        api = FakeCloudflare()
        zone, expires = ASSISTANT.validate_token(api, ORIGINS[0])
        self.assertEqual(zone, {'name': 'example.test', 'zone_id': ZONE, 'account_id': ACCOUNT})
        self.assertEqual(expires, datetime(2027, 6, 1, tzinfo=timezone.utc))
        self.assertEqual(api.writes(), [])

    def test_missing_or_pending_zone_is_explained(self):
        with self.assertRaises(Stop) as missing:
            ASSISTANT.find_zone(FakeCloudflare(zones=[]), 'fagoo.example.test')
        self.assertEqual(missing.exception.code, 'CLOUDFLARE_ZONE_NOT_FOUND')
        pending = [{'id': ZONE, 'name': 'example.test', 'status': 'pending', 'account': {'id': ACCOUNT}}]
        with self.assertRaises(Stop) as inactive:
            ASSISTANT.find_zone(FakeCloudflare(zones=pending), 'fagoo.example.test')
        self.assertEqual((inactive.exception.code, inactive.exception.detail), ('CLOUDFLARE_ZONE_NOT_ACTIVE', 'example.test'))

    def test_refused_token_is_not_reported_as_a_missing_permission(self):
        def api(method, path, body=None):
            raise Stop('CLOUDFLARE_TOKEN_REJECTED' if path == '/user/tokens/verify' else 'CLOUDFLARE_PERMISSION_MISSING')
        with self.assertRaises(Stop) as refused:
            ASSISTANT.validate_token(api, ORIGINS[0])
        self.assertEqual(refused.exception.code, 'CLOUDFLARE_TOKEN_REJECTED')

    def test_disabled_token_stops_before_any_lookup(self):
        calls = []
        def api(method, path, body=None):
            calls.append(path)
            return {'status': 'disabled'}
        with self.assertRaises(Stop) as disabled:
            ASSISTANT.validate_token(api, ORIGINS[0])
        self.assertEqual((disabled.exception.code, calls), ('CLOUDFLARE_TOKEN_INACTIVE', ['/user/tokens/verify']))

    def test_missing_permission_is_named(self):
        for part, permission in (('/workers/domains', 'workers'), ('/cfd_tunnel', 'tunnel'), ('/dns_records', 'dns')):
            api = FakeCloudflare(refuse=(part,))
            zone = ASSISTANT.find_zone(api, 'fagoo.example.test')
            with self.subTest(permission=permission), self.assertRaises(Stop) as refused:
                ASSISTANT.check_addresses(api, zone, ORIGINS)
            self.assertEqual((refused.exception.code, refused.exception.detail), ('CLOUDFLARE_PERMISSION_MISSING', ASSISTANT.PERMISSIONS[permission]))

    def test_addresses_must_be_free_first_level_names_of_the_zone(self):
        zone = {'name': 'example.test', 'zone_id': ZONE, 'account_id': ACCOUNT}
        ASSISTANT.check_addresses(FakeCloudflare(), zone, ORIGINS)
        cases = [
            (('https://fagoo.other.test', ORIGINS[1], ORIGINS[2]), {}, 'HOST_OUTSIDE_ZONE'),
            (('https://erp.fagoo.example.test', ORIGINS[1], ORIGINS[2]), {}, 'HOST_NOT_FIRST_LEVEL'),
            (ORIGINS, {'records': {'fagoo.example.test': [{'type': 'A'}]}}, 'HOST_IN_USE'),
            (ORIGINS, {'domains': [{'hostname': 'fagoo-api.example.test', 'service': 'another-worker'}]}, 'HOST_IN_USE'),
            (ORIGINS, {'records': {'fagoo-services.example.test': [{'type': 'A'}]}}, 'HOST_IN_USE'),
            (ORIGINS, {'records': {'fagoo-services.example.test': [tunnel_record(OTHER_TUNNEL)]}}, 'HOST_IN_USE'),
        ]
        for origins, state, code in cases:
            with self.subTest(code=code, state=state), self.assertRaises(Stop) as refused:
                ASSISTANT.check_addresses(FakeCloudflare(**state), zone, origins)
            self.assertEqual(refused.exception.code, code)

    def test_addresses_already_owned_by_this_installation_are_accepted(self):
        zone = {'name': 'example.test', 'zone_id': ZONE, 'account_id': ACCOUNT}
        own = FakeCloudflare(domains=[{'hostname': 'fagoo.example.test', 'service': 'fagoo-web-' + SUFFIX},
                                      {'hostname': 'fagoo-api.example.test', 'service': 'fagoo-api-' + SUFFIX}],
                             tunnels=[{'id': TUNNEL, 'name': 'fagoo-' + SUFFIX, 'config_src': 'cloudflare'}],
                             records={'fagoo-services.example.test': [tunnel_record()]})
        ASSISTANT.check_addresses(own, zone, ORIGINS)
        # A publication-only token from the manual procedure has no tunnel permission and needs none here.
        manual = FakeCloudflare(records={'fagoo-services.example.test': [tunnel_record(OTHER_TUNNEL)]}, refuse=('/cfd_tunnel',))
        ASSISTANT.check_addresses(manual, zone, ORIGINS, connector_tunnel=OTHER_TUNNEL)
        self.assertEqual(own.writes() + manual.writes(), [])

    def test_tunnel_is_created_once_and_reused_afterwards(self):
        api = FakeCloudflare()
        self.assertEqual(ASSISTANT.ensure_tunnel(api, ACCOUNT, 'fagoo-' + SUFFIX), TUNNEL)
        self.assertEqual(api.calls[-1], ('POST', '/accounts/' + ACCOUNT + '/cfd_tunnel', {'name': 'fagoo-' + SUFFIX, 'config_src': 'cloudflare'}))
        self.assertEqual(ASSISTANT.ensure_tunnel(api, ACCOUNT, 'fagoo-' + SUFFIX), TUNNEL)
        self.assertEqual(len(api.writes()), 1)

    def test_ambiguous_or_locally_configured_tunnels_are_refused(self):
        named = lambda **values: {'id': TUNNEL, 'name': 'fagoo-' + SUFFIX, 'config_src': 'cloudflare', **values}
        for tunnels, code in (([named(), named(id=OTHER_TUNNEL)], 'TUNNEL_NAME_AMBIGUOUS'), ([named(config_src='local')], 'TUNNEL_NOT_REMOTELY_MANAGED')):
            api = FakeCloudflare(tunnels=tunnels)
            with self.subTest(code=code), self.assertRaises(Stop) as refused:
                ASSISTANT.ensure_tunnel(api, ACCOUNT, 'fagoo-' + SUFFIX)
            self.assertEqual((refused.exception.code, api.writes()), (code, []))
        deleted = FakeCloudflare(tunnels=[named(deleted_at='2026-11-01T00:00:00Z')])
        self.assertIsNone(ASSISTANT.find_tunnel(deleted, ACCOUNT, 'fagoo-' + SUFFIX))

    def test_route_sends_the_services_address_to_the_loopback_gateway_only(self):
        api = FakeCloudflare()
        ASSISTANT.publish_route(api, ACCOUNT, TUNNEL, 'fagoo-services.example.test', 8081)
        self.assertEqual(api.calls, [('PUT', '/accounts/' + ACCOUNT + '/cfd_tunnel/' + TUNNEL + '/configurations', {'config': {'ingress': [
            {'hostname': 'fagoo-services.example.test', 'service': 'http://localhost:8081'}, {'service': 'http_status:404'}]}})])

    def test_dns_record_is_created_or_kept_and_never_replaced(self):
        api = FakeCloudflare()
        self.assertEqual(ASSISTANT.ensure_dns(api, ZONE, 'fagoo-services.example.test', TUNNEL), 'created')
        self.assertEqual(api.calls[-1][2], tunnel_record())
        self.assertEqual(ASSISTANT.ensure_dns(api, ZONE, 'fagoo-services.example.test', TUNNEL), 'kept')
        self.assertEqual(len(api.writes()), 1)
        for existing in ([{'type': 'A', 'content': '192.0.2.1', 'proxied': True}], [tunnel_record(OTHER_TUNNEL)],
                         [{**tunnel_record(), 'proxied': False}], [tunnel_record(), tunnel_record()]):
            conflict = FakeCloudflare(records={'fagoo-services.example.test': existing})
            with self.subTest(existing=existing), self.assertRaises(Stop) as refused:
                ASSISTANT.ensure_dns(conflict, ZONE, 'fagoo-services.example.test', TUNNEL)
            self.assertEqual((refused.exception.code, conflict.writes()), ('HOST_IN_USE', []))

    def test_http_failures_never_carry_the_token_or_the_response(self):
        token = 'synthetic-installer-token-0123456789'
        def failing(status):
            def opened(request, timeout):
                self.assertEqual(request.get_header('Authorization'), 'Bearer ' + token)
                raise urllib.error.HTTPError(request.full_url, status, 'refused ' + token, {}, io.BytesIO(token.encode()))
            return types.SimpleNamespace(open=opened)
        for status, path, code in ((401, '/user/tokens/verify', 'CLOUDFLARE_TOKEN_REJECTED'), (403, '/zones?name=example.test', 'CLOUDFLARE_PERMISSION_MISSING'),
                                   (500, '/zones?name=example.test', 'CLOUDFLARE_REQUEST_FAILED')):
            with self.subTest(status=status), patch.object(ASSISTANT.urllib.request, 'build_opener', return_value=failing(status)):
                with self.assertRaises(Stop) as refused:
                    ASSISTANT.cloudflare('GET', path, token)
            self.assertEqual(refused.exception.code, code)
            self.assertNotIn(token, ' '.join(ASSISTANT.explain(refused.exception.code, refused.exception.detail)) + repr(refused.exception.args))
        unreachable = types.SimpleNamespace(open=lambda request, timeout: (_ for _ in ()).throw(urllib.error.URLError('offline')))
        with patch.object(ASSISTANT.urllib.request, 'build_opener', return_value=unreachable), self.assertRaises(Stop) as offline:
            ASSISTANT.cloudflare('GET', '/zones?name=example.test', token)
        self.assertEqual(offline.exception.code, 'CLOUDFLARE_UNREACHABLE')


class ExplanationTests(unittest.TestCase):
    def test_every_code_has_a_portuguese_explanation_and_an_action(self):
        for code in ASSISTANT.MESSAGES:
            what, action = ASSISTANT.explain(code, 'fagoo.example.test')
            self.assertTrue(what and action, code)
            self.assertNotIn('{', what + action, code)
        self.assertEqual(ASSISTANT.explain('UNKNOWN_HELPER_CODE'), ASSISTANT.explain('STEP_FAILED'))

    def test_the_last_helper_diagnostic_selects_the_explanation(self):
        output = 'API_DEPLOY...\nAPI_DEPLOY: OK\nWEB_DEPLOY...\nCUSTOM_DOMAIN_DNS_CONFLICT: remove only the intended web/API DNS records in the dashboard, then retry\n'
        self.assertEqual(ASSISTANT.known_code(output), 'CUSTOM_DOMAIN_DNS_CONFLICT')
        self.assertEqual(ASSISTANT.known_code('FAGOO_RUNTIME_EXISTS: já existe uma instalação'), 'FAGOO_RUNTIME_EXISTS')
        self.assertIsNone(ASSISTANT.known_code('npm ERR! network timeout\nERP_BUILD...'))

    def test_helper_codes_the_assistant_depends_on_still_exist(self):
        sources = {name: Path(__file__).with_name(name).read_text(encoding='utf-8') for name in ('connect-tunnel.py', 'deploy-application.py', 'create-admin.py')}
        sources['install-runtime.sh'] = (ASSISTANT.ROOT / 'scripts/install-runtime.sh').read_text(encoding='utf-8')
        expected = {'connect-tunnel.py': ('TUNNEL_CONFIGURATION_EXISTS', 'TUNNEL_SERVICE_EXISTS', 'TUNNEL_METRICS_PORT_BUSY', 'TUNNEL_NOT_READY',
                                          'TUNNEL_ID_MISMATCH', 'CLOUDFLARED_TOKEN_FILE_REQUIRED', 'FAGOO_LOCAL_GATEWAY_NOT_READY'),
                    'deploy-application.py': ('DEPENDENCIES_REQUIRED', 'APPLICATION_DEPLOY_LOCK_EXISTS', 'CUSTOM_DOMAIN_DNS_CONFLICT',
                                              'CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER', 'CLOUDFLARE_PREFLIGHT_FAILED'),
                    'create-admin.py': ('ADMIN_AUTH_CREATION_FAILED', 'ADMIN_DATABASE_OPERATION_FAILED', 'ADMIN_INPUT_INVALID'),
                    'install-runtime.sh': ('FAGOO_RUNTIME_EXISTS',)}
        for name, codes in expected.items():
            for code in codes:
                self.assertIn(code, sources[name], name)
                self.assertIn(code, ASSISTANT.MESSAGES)

    def test_report_names_the_stage_and_only_offers_to_continue_what_started(self):
        def reported(failure):
            output = io.StringIO()
            with patch('sys.stdout', output):
                ASSISTANT.report(failure, Path(__file__).with_name('missing-assistant.log'))
            return output.getvalue()
        failure = Stop('STEP_FAILED', output='\n'.join('line ' + str(number) for number in range(40)))
        failure.stage = ASSISTANT.TITLES['publish']
        text = reported(failure)
        self.assertIn('parou na etapa "' + ASSISTANT.TITLES['publish'] + '"', text)
        self.assertIn('line 39', text)
        self.assertNotIn('line 20\n', text)
        self.assertIn(ASSISTANT.RESUME, text)
        self.assertNotIn('Registro técnico', text)
        before = reported(Stop('ROOT_UBUNTU_REQUIRED'))
        self.assertIn('não começou', before)
        self.assertNotIn(ASSISTANT.RESUME, before)
        self.assertIn('fagoo-services.example.test', reported(Stop('HOST_IN_USE', 'fagoo-services.example.test')))

    def test_short_token_validity_is_warned_about(self):
        now = datetime(2026, 11, 13, tzinfo=timezone.utc)
        self.assertIsNone(ASSISTANT.expiry_notice(None, now))
        short = ASSISTANT.expiry_notice(now + timedelta(days=30), now)
        self.assertIn('13/12/2026', short)
        self.assertIn('Atualizar agora', short)
        self.assertNotIn('Atualizar agora', ASSISTANT.expiry_notice(now + timedelta(days=365), now))


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_progress_survives_a_new_run_and_holds_no_secret_field(self):
        path = self.directory / 'assistant.json'
        state = ASSISTANT.State(path)
        self.assertFalse(state.done('runtime'))
        state.update(origins=list(ORIGINS), zone={'name': 'example.test', 'zone_id': ZONE, 'account_id': ACCOUNT})
        state.finish('runtime')
        state.finish('runtime')
        again = ASSISTANT.State(path)
        self.assertTrue(again.done('runtime'))
        self.assertEqual(again.data['done'], ['runtime'])
        self.assertEqual(set(again.data), {'format', 'done', 'origins', 'zone'})
        path.write_text('[]')
        with self.assertRaises(Stop):
            ASSISTANT.State(path)

    def test_helper_output_stays_in_the_log_and_its_diagnostic_is_explained(self):
        log = self.directory / 'assistant.log'
        visible = io.StringIO()
        with patch('sys.stdout', visible):
            ASSISTANT.run_logged([sys.executable, '-c', 'print("helper output")'], log, 'example')
            with self.assertRaises(Stop) as refused:
                ASSISTANT.run_logged([sys.executable, '-c', 'raise SystemExit("CUSTOM_DOMAIN_DNS_CONFLICT: remove the records")'], log, 'publish')
            with self.assertRaises(Stop) as unknown:
                ASSISTANT.run_logged([sys.executable, '-c', 'import sys; print("apt failed"); sys.exit(3)'], log, 'runtime')
        self.assertEqual(refused.exception.code, 'CUSTOM_DOMAIN_DNS_CONFLICT')
        self.assertEqual(unknown.exception.code, 'STEP_FAILED')
        self.assertIn('apt failed', unknown.exception.output)
        self.assertNotIn('helper output', unknown.exception.output)
        self.assertIn('helper output', log.read_text(encoding='utf-8'))
        self.assertNotIn('helper output', visible.getvalue())

    def test_waiting_retries_until_the_address_answers(self):
        answers, pauses = iter([OSError('dns'), False, True]), []
        def check():
            value = next(answers)
            if isinstance(value, Exception):
                raise value
            return value
        self.assertTrue(ASSISTANT.wait_for(check, attempts=5, delay=7, sleep=pauses.append))
        self.assertEqual(pauses, [7, 7])
        self.assertFalse(ASSISTANT.wait_for(lambda: False, attempts=3, delay=1, sleep=pauses.append))

    def test_invalid_answers_are_asked_again_and_then_stop(self):
        answers = iter(['not a domain', ' Example.Test '])
        with patch('sys.stdout', io.StringIO()):
            self.assertEqual(ASSISTANT.ask('Domínio: ', ASSISTANT.valid_domain, read=lambda prompt: next(answers)), ORIGINS)
            with self.assertRaises(Stop) as stopped:
                ASSISTANT.ask('E-mail: ', ASSISTANT.valid_email, attempts=2, read=lambda prompt: 'sem-arroba')
        self.assertEqual(stopped.exception.code, 'TOO_MANY_INVALID_ANSWERS')
        for value, check in (('admin@example.test', ASSISTANT.valid_email), ('Maria Silva', ASSISTANT.valid_name), ('uma senha longa', ASSISTANT.valid_password)):
            self.assertEqual(check(value), value)
        for value, check in (('short', ASSISTANT.valid_password), ('', ASSISTANT.valid_name), ('token with space ' * 3, ASSISTANT.valid_token)):
            with self.assertRaises(ValueError):
                check(value)


class TunnelStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.assistant = ASSISTANT.Assistant(self.temp.name)
        self.assistant.private.mkdir(parents=True)
        self.assistant.env_file.write_text('FAGOO_LOCAL_PORT=8081\n')
        self.assistant.state = ASSISTANT.State(self.assistant.private / 'assistant.json')
        self.assistant.state.update(origins=list(ORIGINS), zone={'name': 'example.test', 'zone_id': ZONE, 'account_id': ACCOUNT})
        self.started = []
        self.connector = types.SimpleNamespace(
            SERVICE='fagoo-cloudflared.service', preflight=lambda require_terminal, gateway_port: '/usr/bin/cloudflared',
            extract_token=lambda value, expected=None: (value, expected), start_connector=lambda token, binary: self.started.append((token, binary)),
            command=lambda *args, **kwargs: self.started.append('systemctl'))

    def run_stage(self, api, installed, active=True):
        with patch.object(ASSISTANT, 'sibling', return_value=self.connector), patch.object(ASSISTANT, 'fetch', return_value=(200, {}, b'')), \
                patch.object(self.assistant, 'saved_api', return_value=api), patch.object(self.assistant, 'local_gateway_ready', return_value=True), \
                patch.object(self.assistant, 'connector_tunnel', return_value=installed), patch.object(self.assistant, 'service_active', return_value=active):
            self.assistant.tunnel()

    def test_new_installation_creates_tunnel_connector_route_and_dns(self):
        api = FakeCloudflare()
        self.run_stage(api, installed=None)
        self.assertEqual(self.started, [('tunnel-token', '/usr/bin/cloudflared')])
        self.assertEqual([method for method, _ in api.writes()], ['POST', 'PUT', 'POST'])
        self.assertEqual(api.records['fagoo-services.example.test'], [tunnel_record()])
        self.assertEqual(ASSISTANT.State(self.assistant.state.path).data['tunnel_id'], TUNNEL)
        self.assertNotIn('tunnel-token', self.assistant.state.path.read_text())

    def test_repeating_after_a_failure_reuses_the_tunnel_and_the_connector(self):
        self.assistant.state.update(tunnel_id=TUNNEL)
        api = FakeCloudflare(tunnels=[{'id': TUNNEL, 'name': 'fagoo-' + SUFFIX, 'config_src': 'cloudflare'}], records={'fagoo-services.example.test': [tunnel_record()]})
        self.run_stage(api, installed=TUNNEL, active=False)
        self.assertEqual(self.started, ['systemctl'])
        self.assertEqual([method for method, _ in api.writes()], ['PUT'])

    def test_connector_from_the_manual_procedure_is_left_as_it_is(self):
        api = FakeCloudflare()
        self.run_stage(api, installed=OTHER_TUNNEL)
        self.assertEqual((self.started, api.calls), ([], []))
        self.assertNotIn('tunnel_id', self.assistant.state.data)

    def test_connector_of_another_tunnel_is_never_replaced(self):
        self.assistant.state.update(tunnel_id=OTHER_TUNNEL)
        api = FakeCloudflare()
        with self.assertRaises(Stop) as refused:
            self.run_stage(api, installed=OTHER_TUNNEL)
        self.assertEqual((refused.exception.code, self.started, api.writes()), ('TUNNEL_BELONGS_TO_ANOTHER', [], []))


class FlowTests(unittest.TestCase):
    TOKEN = 'synthetic-installer-token-0123456789'
    PASSWORD = 'uma senha bem longa'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.assistant = ASSISTANT.Assistant(self.temp.name)
        self.cloudflare = FakeCloudflare()
        self.ran, self.fail_at = [], None

    def arguments(self, **values):
        return types.SimpleNamespace(**{'domain': None, 'web_origin': None, 'backend_origin': None, 'api_origin': None,
                                        'admin_email': None, 'admin_name': None, 'yes': False, **values})

    def stage(self, name):
        def run():
            self.ran.append(name)
            if self.fail_at == name:
                raise Stop('PUBLIC_ADDRESS_NOT_READY', ORIGINS[1])
        return run

    def execute(self, typed=(), secrets=(), arguments=None, administrator=False, healthy=True):
        typed, secrets, output = iter(typed), iter(secrets), io.StringIO()
        patches = [patch('builtins.input', lambda prompt='': next(typed)), patch.object(ASSISTANT, 'hidden', lambda prompt: next(secrets)),
                   patch.object(ASSISTANT, 'cloudflare', lambda method, path, token, body=None: self.cloudflare(method, path, body)),
                   patch.object(self.assistant, 'connector_tunnel', return_value=None),
                   patch.object(self.assistant, 'administrator_exists', return_value=administrator),
                   patch.object(self.assistant, 'local_gateway_ready', return_value=healthy),
                   patch.object(self.assistant, 'schema_checked', return_value=healthy),
                   patch.object(self.assistant, 'service_active', return_value=healthy), patch('sys.stdout', output)]
        patches += [patch.object(self.assistant, name, self.stage(name)) for name in ASSISTANT.STAGES if name != 'runtime' or not self.assistant.env_file.exists()]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        try:
            self.assistant.run(arguments or self.arguments())
        finally:
            for item in patches:
                item.stop()
            self.remaining = (list(typed), list(secrets))
        return output.getvalue()

    def test_one_run_asks_domain_token_and_administrator_then_installs_in_order(self):
        output = self.execute(['example.test', 'admin@example.test', 'Maria Silva', ''], [self.TOKEN, self.PASSWORD, self.PASSWORD])
        self.assertEqual(self.ran, list(ASSISTANT.STAGES))
        self.assertEqual(self.remaining, ([], []))
        self.assertEqual(json.loads(self.assistant.credentials_path.read_text()), {'account_id': ACCOUNT, 'zone_id': ZONE, 'token': self.TOKEN})
        saved = (self.assistant.private / 'assistant.json').read_text()
        self.assertEqual(json.loads(saved)['done'], list(ASSISTANT.STAGES))
        for secret in (self.TOKEN, self.PASSWORD):
            self.assertNotIn(secret, saved + output)
        self.assertIn('FAGOO instalado.', output)
        self.assertIn(ORIGINS[0], output)
        self.assertIn('admin@example.test', output)
        self.assertEqual(self.cloudflare.writes(), [])

    def test_refusing_the_confirmation_installs_nothing(self):
        self.execute(['example.test', 'admin@example.test', 'Maria Silva', 'n'], [self.TOKEN, self.PASSWORD, self.PASSWORD])
        self.assertEqual(self.ran, [])

    def test_a_failed_stage_is_named_and_the_next_run_continues_from_it(self):
        self.fail_at = 'tunnel'
        with self.assertRaises(Stop) as stopped:
            self.execute(['example.test', 'admin@example.test', 'Maria Silva', 's'], [self.TOKEN, self.PASSWORD, self.PASSWORD])
        self.assertEqual((stopped.exception.code, stopped.exception.stage), ('PUBLIC_ADDRESS_NOT_READY', ASSISTANT.TITLES['tunnel']))
        self.assertEqual(self.ran, ['runtime', 'admin', 'tools', 'tunnel'])
        self.ran, self.fail_at = [], None
        self.assistant = ASSISTANT.Assistant(self.temp.name)
        output = self.execute()
        self.assertEqual(self.ran, ['tunnel', 'publish', 'verify'])
        self.assertIn('já concluída', output)

    def test_wrong_token_is_asked_again_without_being_saved(self):
        accepted = self.cloudflare
        def refusing_first(method, path, body=None):
            if not refusing_first.used and path == '/user/tokens/verify':
                refusing_first.used = True
                raise Stop('CLOUDFLARE_TOKEN_REJECTED')
            if refusing_first.used == 1 and path.startswith('/zones?'):
                refusing_first.used = 2
                raise Stop('CLOUDFLARE_PERMISSION_MISSING')
            return accepted(method, path, body)
        refusing_first.used = False
        self.cloudflare = refusing_first
        self.execute(['example.test', 'admin@example.test', 'Maria Silva', 's'], ['wrong-token-000000000000', self.TOKEN, self.PASSWORD, self.PASSWORD])
        self.assertEqual(json.loads(self.assistant.credentials_path.read_text())['token'], self.TOKEN)

    def test_runtime_installed_by_the_manual_procedure_is_continued_without_new_questions_about_it(self):
        from configure import configure
        self.assistant.private.mkdir(parents=True)
        configure(self.assistant.env_file, *ORIGINS)
        output = self.execute([], [self.TOKEN], administrator=True)
        self.assertEqual(self.ran, ['tools', 'tunnel', 'publish', 'verify'])
        self.assertIn('já estavam instalados', output)

    def test_half_installed_runtime_stops_before_any_question(self):
        from configure import configure
        self.assistant.private.mkdir(parents=True)
        configure(self.assistant.env_file, *ORIGINS)
        with self.assertRaises(Stop) as stopped:
            self.execute([], [], healthy=False)
        self.assertEqual((stopped.exception.code, self.ran), ('RUNTIME_PARTIAL', []))
        self.assertFalse(self.assistant.credentials_path.exists())

    def test_installed_addresses_are_never_changed_by_a_new_answer(self):
        from configure import configure
        self.assistant.private.mkdir(parents=True)
        configure(self.assistant.env_file, *ORIGINS)
        with self.assertRaises(Stop) as stopped:
            self.execute([], [], arguments=self.arguments(domain='another.test'))
        self.assertEqual(stopped.exception.code, 'ORIGINS_CHANGED')


class ScriptTests(unittest.TestCase):
    def test_bootstrap_installs_the_latest_stable_release_and_deletes_nothing(self):
        script = (ASSISTANT.ROOT / 'scripts/install.sh').read_text(encoding='utf-8')
        self.assertIn('https://github.com/Quevenapp/Fagoo/releases/latest', script)
        self.assertIn('git clone --branch "$task_tag" --single-branch https://github.com/Quevenapp/Fagoo.git', script)
        self.assertIn('infra/install-assistant.py "$@"', script)
        self.assertNotRegex(script, r'\brm\b|--force|reset --hard|docker volume')
        self.assertNotIn('\r', script)

    def test_runtime_installer_checks_the_addresses_before_creating_anything(self):
        script = (ASSISTANT.ROOT / 'scripts/install-runtime.sh').read_text(encoding='utf-8')
        self.assertLess(script.index('infra/configure.py --check'), script.index('docker ps -aq'))
        self.assertLess(script.index('FAGOO_RUNTIME_EXISTS'), script.index('python3 infra/configure.py "${task_origins[@]}"'))
        self.assertNotIn('\r', script)


if __name__ == '__main__':
    unittest.main()
