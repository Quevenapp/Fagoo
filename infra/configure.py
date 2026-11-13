"""Generate one installation's private runtime configuration, without emitting secrets."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit


def origin(value):
    p = urlsplit(value)
    labels = (p.hostname or '').split('.')
    if p.scheme != 'https' or p.username or p.password or p.port or p.path or p.query or p.fragment or len(labels) < 2 or not re.search('[a-z]', labels[-1]) or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels) or value != 'https://' + p.hostname:
        raise ValueError('HTTPS_DNS_ORIGIN_REQUIRED')
    return value


def derived_origins(domain):
    """Default web, services and API origins for one Cloudflare zone, in that order."""
    domain = domain.strip().lower() if isinstance(domain, str) else ''
    for prefix in ('https://', 'http://', 'www.'):
        if domain.startswith(prefix):
            domain = domain[len(prefix):]
    domain = domain.rstrip('/').rstrip('.')
    origin('https://' + domain)
    return tuple(origin('https://' + prefix + '.' + domain) for prefix in ('fagoo', 'fagoo-services', 'fagoo-api'))


def token(secret, role):
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b'=')
    issued = int(time.time())
    payload = {'iss': 'fagoo', 'role': role, 'iat': issued, 'exp': issued + 10 * 365 * 86400}
    body = b'.'.join([encode(b'{"alg":"HS256","typ":"JWT"}'), encode(json.dumps(payload, separators=(',', ':')).encode())])
    return (body + b'.' + encode(hmac.new(secret.encode(), body, hashlib.sha256).digest())).decode()


def configure(destination, web_origin, backend_origin, api_origin, local_port=8081):
    if not 1024 <= local_port <= 65535:
        raise ValueError('LOCAL_PORT_INVALID')
    values = {'FAGOO_WEB_ORIGIN': origin(web_origin), 'FAGOO_BACKEND_ORIGIN': origin(backend_origin), 'FAGOO_API_ORIGIN': origin(api_origin), 'FAGOO_LOCAL_PORT': str(local_port)}
    values['POSTGRES_PASSWORD'] = secrets.token_hex(32)
    values['JWT_SECRET'] = secrets.token_hex(48)
    values['FAGOO_UPDATE_AGENT_TOKEN'] = secrets.token_hex(32)
    values['FAGOO_UPDATE_SOCKET_DIR'] = str(Path(destination).resolve().parents[1] / 'update-service/run')
    values['ANON_KEY'] = token(values['JWT_SECRET'], 'anon')
    values['SERVICE_ROLE_KEY'] = token(values['JWT_SECRET'], 'service_role')
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    Path(values['FAGOO_UPDATE_SOCKET_DIR']).mkdir(parents=True, exist_ok=True, mode=0o700)
    frontend = destination.with_name('frontend.env')
    if frontend == destination:
        raise ValueError('RUNTIME_FILENAME_RESERVED')
    public = {'VITE_SUPABASE_DEPLOYMENT': 'self-hosted', 'VITE_SUPABASE_URL': values['FAGOO_BACKEND_ORIGIN'], 'VITE_SUPABASE_ANON_KEY': values['ANON_KEY'], 'VITE_ERP_API_URL': values['FAGOO_API_ORIGIN']}
    outputs = [(destination, '# Private FAGOO runtime configuration. Preserve this file and the persistent volumes.\n' + ''.join(f'{key}={value}\n' for key, value in values.items())), (frontend, '# Public frontend build configuration; contains no administrator credentials.\n' + ''.join(f'{key}={value}\n' for key, value in public.items()))]
    created = []
    try:
        for path, contents in outputs:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(path)
            with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
                output.write(contents)
    except OSError:
        # Only files created exclusively by this invocation can be removed.
        for path in created:
            path.unlink(missing_ok=True)
        raise
    return values


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='private/install/.env')
    parser.add_argument('--domain', help='Cloudflare zone; derives fagoo, fagoo-services and fagoo-api under it.')
    parser.add_argument('--web-origin')
    parser.add_argument('--backend-origin')
    parser.add_argument('--api-origin')
    parser.add_argument('--local-port', type=int, default=8081)
    parser.add_argument('--check', action='store_true', help='Validate the addresses and print them; create nothing.')
    args = parser.parse_args()
    explicit = [args.web_origin, args.backend_origin, args.api_origin]
    try:
        if args.domain and not any(explicit):
            explicit = derived_origins(args.domain)
        elif args.domain or not all(explicit):
            raise ValueError('ORIGINS_REQUIRE_DOMAIN_OR_THREE_ORIGINS')
        if len({origin(value) for value in explicit}) != 3:
            raise ValueError('THREE_DISTINCT_ORIGINS_REQUIRED')
        if not args.check:
            configure(args.output, *explicit, args.local_port)
    except (ValueError, OSError):
        raise SystemExit('CONFIGURATION_NOT_CREATED: verify the domain or origins, permissions and whether the destination already exists.')
    if not args.check:
        print('Private runtime configuration and public frontend.env created. No credentials were printed.')
    for label, value in zip(('Web', 'Services', 'API'), explicit):
        print(label + ': ' + value)
