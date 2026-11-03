"""HTTP transport for recovery; credentials must never follow a redirect."""
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def no_redirect_opener():
    return urllib.request.build_opener(NoRedirect())
