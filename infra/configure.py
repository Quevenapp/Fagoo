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


def token(secret, role):
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b'=')
    issued = int(time.time())
    payload = {'iss': 'fagoo', 'role': role, 'iat': issued, 'exp': issued + 10 * 365 * 86400}
    body = b'.'.join([encode(b'{"alg":"HS256","typ":"JWT"}'), encode(json.dumps(payload, separators=(',', ':')).encode())])
    return (body + b'.' + encode(hmac.new(secret.encode(), body, hashlib.sha256).digest())).decode()


def configure(destination, web_origin, backend_origin, api_origin, local_port=8081, instance_id='fagoo', metrics_port=20241):
    from installation_scope import installation_scope
    scope = installation_scope({'FAGOO_INSTANCE_ID': instance_id, 'FAGOO_LOCAL_PORT': str(local_port), 'FAGOO_TUNNEL_METRICS_PORT': str(metrics_port)})
    if not 1024 <= local_port <= 65535:
        raise ValueError('LOCAL_PORT_INVALID')
    values = {'FAGOO_WEB_ORIGIN': origin(web_origin), 'FAGOO_BACKEND_ORIGIN': origin(backend_origin), 'FAGOO_API_ORIGIN': origin(api_origin),
              'FAGOO_LOCAL_PORT': str(local_port), 'FAGOO_INSTANCE_ID': scope['instance_id'], 'FAGOO_TUNNEL_METRICS_PORT': str(scope['metrics_port'])}
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
    parser.add_argument('--web-origin', required=True)
    parser.add_argument('--backend-origin', required=True)
    parser.add_argument('--api-origin', required=True)
    parser.add_argument('--local-port', type=int, default=8081)
    parser.add_argument('--instance-id', default='fagoo')
    parser.add_argument('--tunnel-metrics-port', type=int, default=20241)
    args = parser.parse_args()
    try:
        configure(args.output, args.web_origin, args.backend_origin, args.api_origin, args.local_port, args.instance_id, args.tunnel_metrics_port)
    except (ValueError, OSError):
        raise SystemExit('CONFIGURATION_NOT_CREATED: verify origins, permissions and whether the destination already exists.')
    print('Private runtime configuration and public frontend.env created. No credentials were printed.')
