"""Create the first administrator through real Auth, then grant the original ERP role."""
import argparse
import getpass
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def configuration(path):
    result = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            result[key] = value
    return result


def psql(env_file, project, sql):
    cmd = ['docker', 'compose', '--project-name', project, '--env-file', str(env_file), '-f', str(ROOT / 'infra/compose.yaml'), 'exec', '-T', 'db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-']
    result = subprocess.run(cmd, input=sql.encode('utf-8'), capture_output=True, check=False)
    if result.returncode:
        raise ValueError('ADMIN_DATABASE_OPERATION_FAILED')
    return result.stdout.decode('utf-8').strip()


def create(env_file, project, email, display_name, password, request_impl=urllib.request.urlopen):
    env_file = Path(env_file).resolve()
    cfg = configuration(env_file)
    if not re.fullmatch(r'[^\s@]{1,200}@[^\s@.]+(?:\.[^\s@.]+)+', email) or not 1 <= len(display_name) <= 200 or any(ord(x) < 32 for x in display_name) or len(password) < 12 or len(password) > 200:
        raise ValueError('ADMIN_INPUT_INVALID')
    # This permanent marker lives outside business data and survives later
    # removal of memberships. It cannot be used as an account-recovery shortcut.
    psql(env_file, project, """create table if not exists fagoo_system.install_state(
singleton boolean primary key default true check(singleton),
initialized_at timestamptz not null default clock_timestamp(),
initial_admin_id uuid not null);
revoke all on fagoo_system.install_state from public,anon,authenticated,service_role;
""")
    count = psql(env_file, project, 'select (select count(*) from erp_access.membership)+(select count(*) from fagoo_system.install_state);')
    if count != '0':
        raise ValueError('ADMIN_ALREADY_INITIALIZED')
    port = int(cfg['FAGOO_LOCAL_PORT'])
    payload = json.dumps({'email': email, 'password': password, 'email_confirm': True, 'user_metadata': {'name': display_name}}).encode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}/auth/v1/admin/users', data=payload, method='POST', headers={'Authorization': 'Bearer ' + cfg['SERVICE_ROLE_KEY'], 'apikey': cfg['SERVICE_ROLE_KEY'], 'Content-Type': 'application/json'})
    with request_impl(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise ValueError('ADMIN_AUTH_CREATION_FAILED')
        created = json.loads(response.read(65537))
    actor = str(uuid.UUID(created['id']))
    sql = """begin;
select pg_advisory_xact_lock(1964102101,2);
do $fagoo$ begin if exists(select 1 from erp_access.membership) or exists(select 1 from fagoo_system.install_state) then raise exception 'FAGOO_ADMIN_ALREADY_INITIALIZED'; end if; end $fagoo$;
insert into erp_access.membership(user_id,role,active) values('%s','admin',true);
insert into fagoo_system.install_state(singleton,initial_admin_id) values(true,'%s');
commit;
""" % (actor, actor)
    psql(env_file, project, sql)
    return actor


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--project-name', default='fagoo')
    parser.add_argument('--email', required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    password = getpass.getpass('New administrator password (at least 12 characters): ')
    if password != getpass.getpass('Repeat administrator password: '):
        raise SystemExit('PASSWORD_CONFIRMATION_MISMATCH')
    try:
        create(args.env_file, args.project_name, args.email.strip(), args.name.strip(), password)
    except (ValueError, OSError, KeyError, urllib.error.URLError):
        raise SystemExit('ADMIN_NOT_INITIALIZED: inspect Auth and ERP membership privately before retrying; never delete an existing account to retry.')
    print('Initial administrator created. Complete company settings through the application; no commercial data were seeded.')
