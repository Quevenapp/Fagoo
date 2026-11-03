"""HTTP integration checks for the running, disposable local runtime.

Set FAGOO_TEST_GATEWAY_URL (loopback HTTP only) and FAGOO_TEST_WEB_ORIGIN to
exercise the real gateway and services. These checks need no credentials and
change no data. They deliberately inspect normal responses as well as OPTIONS:
a successful preflight does not detect duplicate upstream CORS headers.
"""
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request


@unittest.skipUnless(os.environ.get('FAGOO_TEST_GATEWAY_URL'), 'local runtime URL not configured')
class GatewayCorsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = os.environ['FAGOO_TEST_GATEWAY_URL']
        cls.origin = os.environ['FAGOO_TEST_WEB_ORIGIN']
        target = urllib.parse.urlsplit(cls.base)
        origin = urllib.parse.urlsplit(cls.origin)
        if (target.scheme != 'http' or target.hostname not in ('127.0.0.1', 'localhost')
                or target.username or target.password or target.path or target.query or target.fragment):
            raise ValueError('TEST_REQUIRES_LOOPBACK_RUNTIME')
        if origin.scheme != 'https' or not origin.hostname or origin.path or origin.query or origin.fragment:
            raise ValueError('TEST_WEB_ORIGIN_INVALID')

    def response(self, path, origin, method='GET', headers=None):
        request = urllib.request.Request(self.base + path, method=method,
                                         headers={'Origin': origin, **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as response:
            # REST and Storage may reject an anonymous request; CORS must remain
            # correct on that response too. No authenticated endpoint is used.
            with response:
                return response.status, response.headers
        with response:
            return response.status, response.headers

    def test_allowed_origin_has_one_header_on_real_upstream_responses(self):
        for path in ('/auth/v1/health', '/rest/v1/', '/storage/v1/status'):
            with self.subTest(path=path):
                status, headers = self.response(path, self.origin)
                self.assertLess(status, 500, 'upstream is unavailable')
                self.assertEqual(headers.get_all('Access-Control-Allow-Origin'), [self.origin])

    def test_other_origins_never_inherit_upstream_wildcard(self):
        for path in ('/auth/v1/health', '/rest/v1/', '/storage/v1/status'):
            with self.subTest(path=path):
                status, headers = self.response(path, 'https://unrelated.invalid')
                self.assertLess(status, 500, 'upstream is unavailable')
                self.assertIsNone(headers.get_all('Access-Control-Allow-Origin'))

    def test_preflight_allows_auth_sdk_headers_only_for_configured_origin(self):
        requested = {'Access-Control-Request-Method': 'POST',
                     'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-client-info,x-supabase-api-version'}
        for origin in (self.origin, 'https://unrelated.invalid'):
            with self.subTest(origin=origin):
                status, headers = self.response('/auth/v1/token', origin, 'OPTIONS', requested)
                self.assertEqual(status, 204)
                expected = [self.origin] if origin == self.origin else None
                self.assertEqual(headers.get_all('Access-Control-Allow-Origin'), expected)
                if expected:
                    allowed = {item.strip().lower() for item in headers['Access-Control-Allow-Headers'].split(',')}
                    self.assertTrue(set(requested['Access-Control-Request-Headers'].split(',')) <= allowed)


if __name__ == '__main__':
    unittest.main()
