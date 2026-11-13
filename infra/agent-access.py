"""Manage external agents: technical members that call the API with a token of their own.

The token is shown once, when it is issued; the database keeps only its SHA-256.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
# Profiles that administer the company or move money are never offered to an agent.
ROLES = ('consulta', 'vendas', 'estoque', 'fiscal')
TOKEN_PREFIX = 'fagoo_agt_'
TOKEN = re.compile(r'fagoo_agt_[A-Za-z0-9_-]{43}')


def configuration(path):
    result = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            key, value = line.split('=', 1)
            result[key] = value
    return result


def psql(env_file, project, sql, variables=None):
    # Values travel as psql variables and are quoted by psql itself (:'name'), never pasted into the SQL text.
    cmd = ['docker', 'compose', '--project-name', project, '--env-file', str(env_file), '-f', str(ROOT / 'infra/compose.yaml'),
           'exec', '-T', 'db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    for key, value in (variables or {}).items():
        cmd.extend(['-v', f'{key}={value}'])
    result = subprocess.run(cmd + ['-f', '-'], input=sql.encode('utf-8'), capture_output=True, check=False)
    if result.returncode:
        raise ValueError('AGENT_DATABASE_OPERATION_FAILED')
    return result.stdout.decode('utf-8').strip()


def new_token():
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    if not TOKEN.fullmatch(token):
        raise ValueError('AGENT_TOKEN_GENERATION_FAILED')
    return token, hashlib.sha256(token.encode('ascii')).hexdigest(), token[-4:]


def expiry(days, now=None):
    if days is None:
        return ''
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 3650:
        raise ValueError('AGENT_INPUT_INVALID')
    return ((now or datetime.now(timezone.utc)) + timedelta(days=days)).isoformat()


def identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise ValueError('AGENT_INPUT_INVALID') from None


def ready(env_file, project, run=psql):
    if run(env_file, project, "select to_regprocedure('erp_access.agent_register(uuid,text,text)') is not null;") != 't':
        raise ValueError('AGENT_SCHEMA_NOT_READY')


ISSUE = "select erp_access.agent_token_issue(:'agent'::uuid,:'hash',:'hint',nullif(:'expires','')::timestamptz);\n"


def create(env_file, project, name, role, days, request_impl=urllib.request.urlopen, run=psql):
    env_file = Path(env_file).resolve()
    cfg = configuration(env_file)
    if not isinstance(name, str) or not 1 <= len(name) <= 120 or name != name.strip() or any(ord(x) < 32 or ord(x) == 127 for x in name) or role not in ROLES:
        raise ValueError('AGENT_INPUT_INVALID')
    expires = expiry(days)
    ready(env_file, project, run)
    # The account has no password, is banned from signing in and uses a reserved domain that never receives mail,
    # so the token is the only way to act as this member.
    payload = json.dumps({'email': f'agente-{uuid.uuid4()}@agentes.fagoo.invalid', 'email_confirm': True, 'ban_duration': '876000h',
                          'user_metadata': {'name': name}, 'app_metadata': {'fagoo_agent': True}}).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{int(cfg['FAGOO_LOCAL_PORT'])}/auth/v1/admin/users", data=payload, method='POST',
                                     headers={'Authorization': 'Bearer ' + cfg['SERVICE_ROLE_KEY'], 'apikey': cfg['SERVICE_ROLE_KEY'], 'Content-Type': 'application/json'})
    with request_impl(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise ValueError('AGENT_AUTH_CREATION_FAILED')
        agent = identifier(json.loads(response.read(65537))['id'])
    token, digest, hint = new_token()
    try:
        output = run(env_file, project, "begin;\nselect erp_access.agent_register(:'agent'::uuid,:'name',:'role');\n" + ISSUE + 'commit;\n',
                     {'agent': agent, 'name': name, 'role': role, 'hash': digest, 'hint': hint, 'expires': expires})
    except ValueError:
        # The Auth account exists without membership: it can do nothing, and must be inspected before another attempt.
        raise ValueError('AGENT_NOT_REGISTERED:' + agent) from None
    return {'agent': agent, 'token_id': identifier(output.splitlines()[-1]), 'token': token, 'expires': expires}


def issue(env_file, project, agent, days, run=psql):
    env_file, agent, expires = Path(env_file).resolve(), identifier(agent), expiry(days)
    ready(env_file, project, run)
    token, digest, hint = new_token()
    output = run(env_file, project, ISSUE, {'agent': agent, 'hash': digest, 'hint': hint, 'expires': expires})
    return {'agent': agent, 'token_id': identifier(output.splitlines()[-1]), 'token': token, 'expires': expires}


def revoke(env_file, project, token_id, run=psql):
    env_file, token_id = Path(env_file).resolve(), identifier(token_id)
    ready(env_file, project, run)
    return run(env_file, project, "select erp_access.agent_token_revoke(:'token'::uuid);\n", {'token': token_id}) == 't'


LISTING = """select coalesce(jsonb_agg(jsonb_build_object('agent',a.user_id,'name',p.name,'role',m.role,'active',m.active,'allowed',erp_access.agent_allowed(a.user_id),
 'tokens',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'hint',t.hint,'created_at',t.created_at,'expires_at',t.expires_at,'revoked_at',t.revoked_at,
  'last_used_at',t.last_used_at) order by t.created_at),'[]'::jsonb) from erp_access.agent_token t where t.agent_id=a.user_id)) order by a.created_at),'[]'::jsonb)
 from erp_access.agent a join erp_access.membership m on m.user_id=a.user_id left join erp_access.profile p on p.user_id=a.user_id;
"""


def listing(env_file, project, run=psql):
    env_file = Path(env_file).resolve()
    ready(env_file, project, run)
    return json.loads(run(env_file, project, LISTING))


def show(result):
    print('Agente: ' + result['agent'])
    print('Token (id ' + result['token_id'] + ', ' + ('vence em ' + result['expires'] if result['expires'] else 'sem validade') + '):')
    print(result['token'])
    print('Guarde o token agora: ele não é gravado e não será exibido de novo.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--project-name', default='fagoo')
    commands = parser.add_subparsers(dest='command', required=True)
    validity = argparse.ArgumentParser(add_help=False)
    group = validity.add_mutually_exclusive_group()
    group.add_argument('--expires-days', type=int, default=90, help='Validade do token em dias (padrão: 90).')
    group.add_argument('--no-expiry', action='store_true', help='Token sem validade; revogue-o quando não for mais usado.')
    creating = commands.add_parser('create', parents=[validity], help='Cria o agente e emite o primeiro token.')
    creating.add_argument('--name', required=True)
    creating.add_argument('--role', required=True, choices=ROLES)
    issuing = commands.add_parser('issue', parents=[validity], help='Emite outro token para um agente existente.')
    issuing.add_argument('--agent', required=True)
    revoking = commands.add_parser('revoke', help='Revoga um token.')
    revoking.add_argument('--token-id', required=True)
    commands.add_parser('list', help='Lista agentes e tokens (sem os tokens em si).')
    args = parser.parse_args(argv)
    days = None if getattr(args, 'no_expiry', False) else getattr(args, 'expires_days', None)
    if args.command == 'create':
        show(create(args.env_file, args.project_name, args.name.strip(), args.role, days))
        print('O acesso só vale com FAGOO_AGENT_ACCESS_ENABLED=true na configuração privada e a API publicada de novo.')
    elif args.command == 'issue':
        show(issue(args.env_file, args.project_name, args.agent, days))
    elif args.command == 'revoke':
        print('Token revogado.' if revoke(args.env_file, args.project_name, args.token_id) else 'Nenhum token ativo com esse id.')
    else:
        for agent in listing(args.env_file, args.project_name):
            state = 'inativo' if not agent['active'] else 'ativo' if agent['allowed'] else 'fora do limite de agentes'
            print(f"{agent['agent']}  {agent['name']}  {agent['role']}  {state}")
            for token in agent['tokens']:
                status = 'revogado em ' + token['revoked_at'] if token['revoked_at'] else 'vence em ' + token['expires_at'] if token['expires_at'] else 'sem validade'
                print(f"  {token['id']}  …{token['hint']}  {status}  último uso: {token['last_used_at'] or 'nunca'}")


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, urllib.error.URLError) as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[A-Z_]+(:[0-9a-f-]{36})?', str(error)) else 'AGENT_OPERATION_FAILED'
        if code.startswith('AGENT_NOT_REGISTERED'):
            code += ' (conta do Auth criada sem associação; confira-a em privado antes de repetir)'
        sys.exit(code)
