import copy
import unittest

from cloudflare_domains import bind_domains, preflight_domains, upload_configuration


ACCOUNT, ZONE = 'a' * 32, 'b' * 32


def config(worker='fagoo-web-synthetic', hostname='fagoo-homolog.example.test'):
    return {'account_id': ACCOUNT, 'name': worker, 'workers_dev': False,
            'routes': [{'pattern': hostname, 'custom_domain': True, 'zone_id': ZONE}]}


class FakeCloudflare:
    def __init__(self):
        self.domains, self.calls = [], []
        self.changeset = None
        self.reject_write = False
        self.confirm_write = True
        self.total_count = None

    def __call__(self, method, path, token, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        assert token == 'synthetic-private-token'
        assert '/dns_records' not in path, 'Custom Domains must not require DNS permissions'
        if method == 'GET' and path == '/zones/' + ZONE:
            return {'success': True, 'result': {'name': 'example.test', 'status': 'active', 'account': {'id': ACCOUNT}}}
        if method == 'GET' and path == f'/accounts/{ACCOUNT}/workers/domains?zone_id={ZONE}':
            return {'success': True, 'result': copy.deepcopy(self.domains), 'result_info': {'total_count': self.total_count if self.total_count is not None else len(self.domains)}}
        worker = path.split('/scripts/')[1].split('/')[0]
        if method == 'POST' and path.endswith('/domains/changeset?replace_state=false'):
            result = self.changeset if self.changeset is not None else {
                'added': [{**origin, 'service': worker} for origin in body], 'updated': [], 'removed': [], 'conflicting': [], 'affected_zones': [ZONE]}
            return {'success': True, 'result': copy.deepcopy(result)}
        if method == 'PUT' and path.endswith('/domains/records'):
            if body.get('override_scope') is not False or body.get('override_existing_origin') is not False or body.get('override_existing_dns_record') is not False:
                raise AssertionError('An override was enabled')
            if self.reject_write:
                raise ValueError('SYNTHETIC_DNS_COLLISION_DURING_WRITE')
            if self.confirm_write:
                self.domains += [{**origin, 'service': worker} for origin in body['origins']]
            return {'success': True, 'result': None}
        raise AssertionError('Unexpected request')


class CustomDomainTests(unittest.TestCase):
    def run_preflight(self, fake, configs=None):
        return preflight_domains(configs or [config()], ACCOUNT, ZONE, 'synthetic-private-token', call=fake, preview=True)

    def run_bind(self, fake, configs=None):
        return bind_domains(configs or [config()], ACCOUNT, ZONE, 'synthetic-private-token', call=fake)

    def test_upload_never_exposes_custom_domains_to_noninteractive_wrangler(self):
        source = config()
        upload = upload_configuration(source)
        self.assertEqual(upload['routes'], [])
        self.assertFalse(upload['workers_dev'])
        self.assertEqual(len(source['routes']), 1)

    def test_preflight_is_read_only_and_needs_no_dns_read_permission(self):
        fake = FakeCloudflare()
        plans = self.run_preflight(fake)
        self.assertEqual(len(plans[0]['additions']), 1)
        self.assertEqual(fake.domains, [])
        self.assertNotIn('PUT', [call[0] for call in fake.calls])

    def test_preupload_ownership_check_does_not_require_worker_to_exist_yet(self):
        fake = FakeCloudflare()
        plans = preflight_domains([config()], ACCOUNT, ZONE, 'synthetic-private-token', call=fake)
        self.assertEqual(len(plans[0]['additions']), 1)
        self.assertEqual({call[0] for call in fake.calls}, {'GET'})

    def test_new_web_and_api_bindings_keep_every_override_false(self):
        fake = FakeCloudflare()
        configs = [config(), config('fagoo-api-synthetic', 'api-fagoo-homolog.example.test')]
        self.run_bind(fake, configs)
        writes = [call for call in fake.calls if call[0] == 'PUT']
        self.assertEqual(len(writes), 2)
        self.assertEqual({domain['hostname'] for domain in fake.domains}, {item['routes'][0]['pattern'] for item in configs})
        for _, _, body in writes:
            self.assertEqual({key: body[key] for key in ('override_scope', 'override_existing_origin', 'override_existing_dns_record')},
                             {'override_scope': False, 'override_existing_origin': False, 'override_existing_dns_record': False})

    def test_update_same_worker_does_not_rebind_or_remove_other_domains(self):
        fake = FakeCloudflare()
        fake.domains = [
            {'hostname': config()['routes'][0]['pattern'], 'service': config()['name'], 'zone_id': ZONE},
            {'hostname': 'other.example.test', 'service': config()['name'], 'zone_id': ZONE}]
        original = copy.deepcopy(fake.domains)
        self.run_bind(fake)
        self.assertEqual(fake.domains, original)
        self.assertEqual({call[0] for call in fake.calls}, {'GET'})

    def test_addition_does_not_replace_existing_same_worker_hostname(self):
        fake = FakeCloudflare()
        existing = {'hostname': 'keep.example.test', 'service': config()['name'], 'zone_id': ZONE}
        fake.domains = [existing.copy()]
        self.run_bind(fake)
        self.assertIn(existing, fake.domains)
        writes = [call for call in fake.calls if call[0] == 'PUT']
        self.assertEqual([origin['hostname'] for origin in writes[0][2]['origins']], [config()['routes'][0]['pattern']])

    def test_other_worker_owner_is_never_taken(self):
        fake = FakeCloudflare()
        fake.domains = [{'hostname': config()['routes'][0]['pattern'], 'service': 'another-worker', 'zone_id': ZONE}]
        with self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER'):
            self.run_bind(fake)
        self.assertEqual({call[0] for call in fake.calls}, {'GET'})

    def test_dns_collision_changes_or_removals_abort_without_writes(self):
        for key in ('conflicting', 'updated', 'removed'):
            with self.subTest(key=key):
                fake = FakeCloudflare()
                fake.changeset = {'added': [], 'updated': [], 'removed': [], 'conflicting': []}
                fake.changeset[key] = [{'hostname': config()['routes'][0]['pattern']}]
                with self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_CONFLICT'):
                    self.run_bind(fake)
                self.assertNotIn('PUT', [call[0] for call in fake.calls])

    def test_race_collision_at_write_is_not_retried_with_overrides(self):
        fake = FakeCloudflare()
        fake.reject_write = True
        with self.assertRaisesRegex(ValueError, 'SYNTHETIC_DNS_COLLISION_DURING_WRITE'):
            self.run_bind(fake)
        self.assertEqual(len([call for call in fake.calls if call[0] == 'PUT']), 1)
        self.assertEqual(fake.domains, [])

    def test_missing_post_write_binding_is_not_reported_as_success(self):
        fake = FakeCloudflare()
        fake.confirm_write = False
        with self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_BINDING_NOT_CONFIRMED'):
            self.run_bind(fake)

    def test_incomplete_domain_list_and_malformed_changeset_fail_closed(self):
        fake = FakeCloudflare()
        fake.total_count = 1
        with self.assertRaisesRegex(ValueError, 'CLOUDFLARE_DOMAIN_LIST_INCOMPLETE'):
            self.run_preflight(fake)
        for changeset in [None, {}, {'added': [], 'updated': [], 'removed': [], 'conflicting': []},
                          {'added': [{'hostname': 'unexpected.example.test'}], 'updated': [], 'removed': [], 'conflicting': []}]:
            fake = FakeCloudflare()
            fake.changeset = changeset if changeset is not None else {'added': None}
            with self.subTest(changeset=changeset), self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_CHANGESET_INVALID'):
                self.run_preflight(fake)

    def test_invalid_account_route_zone_and_hostname_fail_before_writes(self):
        variants = []
        for key, value in [('name', '../worker'), ('account_id', 'c' * 32)]:
            item = config(); item[key] = value; variants.append(item)
        for key, value in [('pattern', '*.example.test'), ('pattern', 'fagoo.example.test/'), ('zone_id', 'c' * 32), ('custom_domain', False), ('previews_enabled', True)]:
            item = config(); item['routes'][0][key] = value; variants.append(item)
        for item in variants:
            fake = FakeCloudflare()
            with self.subTest(config=item), self.assertRaisesRegex(ValueError, 'CUSTOM_DOMAIN_CONFIGURATION_INVALID'):
                self.run_bind(fake, [item])
            self.assertEqual(fake.calls, [])
        fake = FakeCloudflare()
        with self.assertRaisesRegex(ValueError, 'APPLICATION_HOST_OUTSIDE_ZONE'):
            self.run_bind(fake, [config(hostname='wrong.test')])
        self.assertNotIn('PUT', [call[0] for call in fake.calls])


if __name__ == '__main__':
    unittest.main()
