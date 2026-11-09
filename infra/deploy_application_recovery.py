"""HTTP transport for recovery; credentials must never follow a redirect."""
import urllib.request
from cloudflare_transport import opener


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def no_redirect_opener(ip_family=None):
    return opener(ip_family, NoRedirect())
