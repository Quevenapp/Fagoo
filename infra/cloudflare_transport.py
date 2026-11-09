"""Per-installation Cloudflare transport; never change process-global DNS or TLS."""
import http.client
import socket
import ssl
import urllib.request


def options(ip_family=None):
    if ip_family not in (None, 'ipv4'):
        raise ValueError('CLOUDFLARE_IP_FAMILY_INVALID')
    return {'ip_family': ip_family} if ip_family is not None else {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def _ipv4_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    if host != 'api.cloudflare.com' or port != 443:
        raise ValueError('CLOUDFLARE_TRANSPORT_ORIGIN_INVALID')
    last_error = None
    for family, kind, protocol, _, target in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM):
        connection = socket.socket(family, kind, protocol)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                connection.settimeout(timeout)
            if source_address:
                connection.bind(source_address)
            connection.connect(target)
            return connection
        except OSError as error:
            last_error = error
            connection.close()
    if last_error:
        raise last_error
    raise OSError('CLOUDFLARE_IPV4_RESOLUTION_FAILED')


class IPv4HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _ipv4_connection


class IPv4HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self):
        # Explicit system trust and hostname checks, including the original SNI.
        super().__init__(context=ssl.create_default_context())

    def https_open(self, request):
        return self.do_open(IPv4HTTPSConnection, request, context=self._context)


def opener(ip_family=None, redirect_handler=None):
    options(ip_family)
    redirect_handler = redirect_handler or NoRedirect()
    if ip_family == 'ipv4':
        # Proxy routing could change the source IP. Opt-in means direct IPv4 only.
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), redirect_handler, IPv4HTTPSHandler())
    return urllib.request.build_opener(redirect_handler)


def node_environment(source, ip_family=None):
    options(ip_family)
    result = dict(source)
    if ip_family == 'ipv4':
        # Keep memory and other caller options; Node uses the last singleton flag.
        # No flag is injected for other installations and no global env is edited.
        previous = result.get('NODE_OPTIONS', '').strip()
        result['NODE_OPTIONS'] = previous if previous.split()[-1:] == ['--dns-result-order=ipv4first'] else (previous + ' --dns-result-order=ipv4first').strip()
    return result
