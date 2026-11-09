"""One persisted installation identity for host-local resources. Legacy defaults stay unchanged."""
import argparse
import re
from update_config import read_values


def instance_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,39}', value):
        raise ValueError('INSTALLATION_ID_INVALID')
    return value


def port(value):
    if not re.fullmatch('[0-9]{4,5}', str(value)) or not 1024 <= int(value) <= 65535:
        raise ValueError('INSTALLATION_PORT_INVALID')
    return int(value)


def installation_scope(values):
    identity = instance_id(values.get('FAGOO_INSTANCE_ID', 'fagoo'))
    local_port = port(values.get('FAGOO_LOCAL_PORT', '8081'))
    metrics_port = port(values.get('FAGOO_TUNNEL_METRICS_PORT', '20241'))
    if local_port == metrics_port:
        raise ValueError('INSTALLATION_PORT_CONFLICT')
    return {'instance_id': identity, 'project': identity, 'updater_service': identity + '-updater.service',
            'tunnel_service': identity + '-cloudflared.service', 'tunnel_token_dir': '/etc/' + identity + '/cloudflared',
            'metrics_port': metrics_port, 'local_port': local_port}


def project_for(values, requested=None):
    selected = installation_scope(values)['project']
    if requested is None:
        return selected
    requested = instance_id(requested)
    if 'FAGOO_INSTANCE_ID' in values and requested != selected:
        raise ValueError('INSTALLATION_PROJECT_MISMATCH')
    # Older installations could explicitly select a project before the persisted
    # identity existed. New configurations bind every helper to their own scope.
    return requested


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file')
    parser.add_argument('--instance-id')
    parser.add_argument('--project-name')
    parser.add_argument('--field', required=True, choices=tuple(installation_scope({})))
    args = parser.parse_args()
    try:
        values = read_values(args.env_file) if args.env_file else {}
        if args.instance_id is not None:
            if args.env_file and installation_scope(values)['instance_id'] != args.instance_id:
                raise ValueError('INSTALLATION_ID_MISMATCH')
            values['FAGOO_INSTANCE_ID'] = instance_id(args.instance_id)
        selected = installation_scope(values)
        selected['project'] = project_for(values, args.project_name)
        print(selected[args.field])
    except (ValueError, OSError):
        raise SystemExit('INSTALLATION_SCOPE_INVALID') from None
