"""Attach only new Worker Custom Domains without replacing DNS or other owners.

Uses the changeset/records contract from Cloudflare's own Wrangler:
https://github.com/cloudflare/workers-sdk/blob/main/packages/deploy-helpers/src/triggers/publish-routes.ts
Wrangler's noninteractive path enables both collision overrides. Upload with
upload_configuration(), then use bind_domains() instead. No DNS Edit is needed
for Worker Custom Domains; a Tunnel's DNS record is a separate operation.
"""
import json
import re
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def cloudflare(method, path, token, body=None):
    if method not in ('GET', 'POST', 'PUT') or not re.fullmatch(r'/(?:accounts|zones)/[a-f0-9]{32}(?:/[A-Za-z0-9_./?=&-]+)?', path) or '..' in path:
        raise ValueError('CUSTOM_DOMAIN_REQUEST_INVALID')
    request = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        raw = response.read(3 * 1024 * 1024 + 1)
        if not 200 <= response.status < 300 or len(raw) > 3 * 1024 * 1024:
            raise ValueError('CUSTOM_DOMAIN_RESPONSE_INVALID')
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('success') is not True or 'result' not in data:
        raise ValueError('CUSTOM_DOMAIN_RESPONSE_INVALID')
    return data


def upload_configuration(config):
    """Keep domains out of Wrangler's automatic replace-conflicts path."""
    if not isinstance(config.get('routes'), list) or not config['routes'] or any(not isinstance(route, dict) or route.get('custom_domain') is not True for route in config['routes']):
        raise ValueError('CUSTOM_DOMAIN_CONFIGURATION_INVALID')
    return {**config, 'routes': []}


def _requests(configs, account_id, zone_id):
    if not re.fullmatch('[a-f0-9]{32}', account_id) or not re.fullmatch('[a-f0-9]{32}', zone_id):
        raise ValueError('CLOUDFLARE_IDENTIFIERS_INVALID')
    requests, names, hosts = [], set(), set()
    for config in configs:
        upload_configuration(config)
        name = config.get('name')
        if not isinstance(name, str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', name) or name in names or config.get('account_id') != account_id:
            raise ValueError('CUSTOM_DOMAIN_CONFIGURATION_INVALID')
        names.add(name)
        origins = []
        for route in config['routes']:
            hostname = route.get('pattern')
            if not isinstance(hostname, str) or len(hostname) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', hostname) or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in hostname.split('.')) or hostname in hosts or route.get('zone_id') != zone_id:
                raise ValueError('CUSTOM_DOMAIN_CONFIGURATION_INVALID')
            if route.get('enabled', True) is not True or route.get('previews_enabled', False) is not False:
                raise ValueError('CUSTOM_DOMAIN_CONFIGURATION_INVALID')
            hosts.add(hostname)
            origins.append({'hostname': hostname, 'zone_id': zone_id, 'enabled': True, 'previews_enabled': False})
        requests.append({'worker': name, 'origins': origins})
    if not requests or len(hosts) > 20:
        raise ValueError('CUSTOM_DOMAIN_CONFIGURATION_INVALID')
    return requests


def _domains(account_id, zone_id, token, call):
    response = call('GET', f'/accounts/{account_id}/workers/domains?zone_id={zone_id}', token)
    domains = response.get('result')
    info = response.get('result_info') or {}
    if not isinstance(domains, list) or any(not isinstance(domain, dict) for domain in domains) or info.get('total_count', len(domains)) > len(domains) or info.get('total_pages', 1) > 1:
        raise ValueError('CLOUDFLARE_DOMAIN_LIST_INCOMPLETE')
    return domains


def _owned(domain, worker, zone_id):
    return domain.get('service') == worker and domain.get('zone_id') == zone_id and domain.get('enabled', True) is True and domain.get('previews_enabled', False) is False


def _preview(account_id, worker, origins, zone_id, token, call):
    result = call('POST', f'/accounts/{account_id}/workers/scripts/{worker}/domains/changeset?replace_state=false', token, origins).get('result')
    if not isinstance(result, dict) or any(not isinstance(result.get(key), list) for key in ('added', 'updated', 'removed', 'conflicting')):
        raise ValueError('CUSTOM_DOMAIN_CHANGESET_INVALID')
    if result['removed'] or result['updated'] or result['conflicting']:
        raise ValueError('CUSTOM_DOMAIN_CONFLICT')
    expected = {origin['hostname'] for origin in origins}
    added = result['added']
    if len(added) != len(expected) or any(not isinstance(row, dict) or row.get('hostname') not in expected or not _owned(row, worker, zone_id) for row in added) or {row['hostname'] for row in added} != expected:
        raise ValueError('CUSTOM_DOMAIN_CHANGESET_INVALID')
    if 'affected_zones' in result and result['affected_zones'] != [zone_id]:
        raise ValueError('CUSTOM_DOMAIN_CHANGESET_INVALID')


def preflight_domains(configs, account_id, zone_id, token, call=cloudflare, preview=False):
    """Read zone/ownership without DNS permission, before the first upload.

    Cloudflare requires an existing Worker for changeset previews. Pass preview
    only after upload; bind_domains always requires that preview before writing.
    No preview failure is ignored. Neither form writes domains or DNS records.
    """
    requests = _requests(configs, account_id, zone_id)
    zone = call('GET', '/zones/' + zone_id, token).get('result')
    if not isinstance(zone, dict) or zone.get('account', {}).get('id') != account_id or not isinstance(zone.get('name'), str) or not zone['name'] or zone.get('status', 'active') != 'active':
        raise ValueError('CLOUDFLARE_ZONE_ACCOUNT_MISMATCH')
    domains = _domains(account_id, zone_id, token, call)
    plans = []
    for request in requests:
        additions = []
        for origin in request['origins']:
            hostname = origin['hostname']
            if hostname != zone['name'] and not hostname.endswith('.' + zone['name']):
                raise ValueError('APPLICATION_HOST_OUTSIDE_ZONE')
            linked = [domain for domain in domains if domain.get('hostname') == hostname]
            if len(linked) > 1 or any(not _owned(domain, request['worker'], zone_id) for domain in linked):
                raise ValueError('CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER')
            if not linked:
                additions.append(origin)
        if additions and preview:
            _preview(account_id, request['worker'], additions, zone_id, token, call)
        plans.append({**request, 'additions': additions})
    return plans


def bind_domains(configs, account_id, zone_id, token, call=cloudflare):
    """Recheck after upload; refuse collisions atomically at the records endpoint.

    An unchanged domain already owned by the same Worker needs no domain write.
    Never retry with an override on errors, including races after the preview.
    """
    plans = preflight_domains(configs, account_id, zone_id, token, call, preview=True)
    for plan in plans:
        if plan['additions']:
            call('PUT', f"/accounts/{account_id}/workers/scripts/{plan['worker']}/domains/records", token,
                 {'override_scope': False, 'override_existing_origin': False,
                  'override_existing_dns_record': False, 'origins': plan['additions']})
    domains = _domains(account_id, zone_id, token, call)
    for plan in plans:
        for origin in plan['origins']:
            linked = [domain for domain in domains if domain.get('hostname') == origin['hostname']]
            if len(linked) != 1 or not _owned(linked[0], plan['worker'], zone_id):
                raise ValueError('CUSTOM_DOMAIN_BINDING_NOT_CONFIRMED')
    return plans
