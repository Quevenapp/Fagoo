#!/usr/bin/env python3
"""Guided FAGOO installation: one command, questions in Portuguese, resumable stages.

It chains the existing helpers (runtime, administrator, deployment tools, tunnel,
publication, checks) and asks only for the domain, one Cloudflare API token and the
administrator. Account, zone and tunnel are discovered or created through the API.

Cloudflare API contracts used here (checked against the public documentation, 2026-11):
- Token: GET /user/tokens/verify
- Zone and account: GET /zones?name=
- Remotely-managed tunnel: POST /accounts/{id}/cfd_tunnel, GET .../{tunnel}/token and
  PUT .../{tunnel}/configurations
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
- DNS: GET and POST /zones/{id}/dns_records
No secret is printed, passed in process arguments or written to the assistant log.
"""
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings

from configure import derived_origins, origin
from release_protocol import atomic_json
from update_config import cloudflare_credentials, read_values, source_identity

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
API = 'https://api.cloudflare.com/client/v4'
STAGES = ('runtime', 'admin', 'tools', 'tunnel', 'publish', 'verify')
TITLES = {
    'runtime': 'Instalando o banco de dados e os serviços (etapa demorada)',
    'admin': 'Criando o administrador',
    'tools': 'Instalando as ferramentas de publicação',
    'tunnel': 'Ligando o servidor ao seu domínio',
    'publish': 'Compilando e publicando a interface e a API (etapa demorada)',
    'verify': 'Conferindo a instalação pelos endereços públicos',
}
RESUME = 'Para continuar de onde parou, repita o mesmo comando de instalação.'
# Names as the Cloudflare token form shows them, in the order scope → permission → access.
PERMISSIONS = {
    'zone': 'Zona → Zona → Lido (Zone → Zone → Read)',
    'dns': 'Zona → DNS → Editar (Zone → DNS → Edit)',
    'workers': 'Conta → Scripts do Workers → Editar (Account → Workers Scripts → Edit)',
    'tunnel': 'Conta → Cloudflare Tunnel → Editar (Account → Cloudflare Tunnel → Edit)',
}

# Code -> (what happened, what to do). {detail} is filled when the failure carries one.
MESSAGES = {
    'ROOT_UBUNTU_REQUIRED': ('O assistente precisa do Ubuntu 24.04 e de permissão de administrador.',
                             'Entre no servidor Ubuntu 24.04 e execute o comando com sudo.'),
    'TERMINAL_REQUIRED': ('O assistente precisa de um terminal para fazer as perguntas sem mostrar senhas.',
                          'Conecte-se ao servidor por SSH e execute o comando diretamente no terminal.'),
    'ASSISTANT_ALREADY_RUNNING': ('Já existe um assistente de instalação em execução neste servidor.',
                                  'Aguarde o outro terminar ou feche a outra janela antes de repetir.'),
    'TOO_MANY_INVALID_ANSWERS': ('A resposta não foi aceita depois de várias tentativas.',
                                 'Confira o dado pedido e execute o comando novamente.'),
    'ORIGINS_CHANGED': ('Este servidor já foi configurado para outros endereços: {detail}.',
                        'Os endereços de uma instalação não são trocados pelo assistente. Repita o comando sem informar outro domínio.'),
    'CLOUDFLARE_TOKEN_REJECTED': ('A Cloudflare não aceitou o token informado.',
                                  'Confira se você copiou o token inteiro. Se ele foi perdido ou expirou, crie outro pelo guia de instalação.'),
    'CLOUDFLARE_TOKEN_INACTIVE': ('O token da Cloudflare está desativado ou expirado.',
                                  'Crie um novo token pelo guia de instalação e repita o comando.'),
    'CLOUDFLARE_PERMISSION_MISSING': ('Falta uma permissão no token da Cloudflare: {detail}.',
                                      'No painel da Cloudflare, edite o token, acrescente essa permissão para a conta e o domínio desta instalação e repita o comando.'),
    'CLOUDFLARE_UNREACHABLE': ('O servidor não conseguiu falar com a Cloudflare.',
                               'Confira a conexão do servidor com a internet e repita o comando.'),
    'CLOUDFLARE_REQUEST_FAILED': ('A Cloudflare recusou uma operação: {detail}.',
                                  'Aguarde alguns minutos e repita o comando. Se persistir, confira o domínio e o token no painel da Cloudflare.'),
    'CLOUDFLARE_ZONE_NOT_FOUND': ('O domínio {detail} não foi encontrado na conta da Cloudflare deste token.',
                                  'Confira se o domínio foi adicionado à Cloudflare e se o token inclui esse domínio, com a permissão ' + PERMISSIONS['zone'] + '.'),
    'CLOUDFLARE_ZONE_NOT_ACTIVE': ('O domínio {detail} ainda não está ativo na Cloudflare.',
                                   'Confira os dois servidores de nomes no registrador do domínio, aguarde a Cloudflare mostrar o domínio como ativo e repita o comando.'),
    'HOST_OUTSIDE_ZONE': ('O endereço {detail} não pertence ao domínio encontrado na Cloudflare.',
                          'Use três endereços dentro do mesmo domínio.'),
    'HOST_NOT_FIRST_LEVEL': ('O endereço {detail} tem mais de um nível abaixo do domínio.',
                             'Use endereços diretamente abaixo do domínio, como fagoo.empresa.com.br.'),
    'HOST_IN_USE': ('O endereço {detail} já é usado por outro serviço no DNS da Cloudflare.',
                    'O assistente não apaga registros existentes. Remova esse registro no painel (DNS → Registros) se ele não for mais usado, ou escolha outro domínio, e repita o comando.'),
    'TUNNEL_NAME_AMBIGUOUS': ('Há mais de um túnel desta instalação na conta da Cloudflare.',
                              'No painel, em Rede → Túneis, remova os túneis duplicados que não estão conectados e repita o comando.'),
    'TUNNEL_NOT_REMOTELY_MANAGED': ('O túnel desta instalação na Cloudflare foi criado com configuração local.',
                                    'Remova esse túnel no painel (Rede → Túneis) e repita o comando para o assistente criar outro.'),
    'TUNNEL_BELONGS_TO_ANOTHER': ('Este servidor já tem um conector de túnel configurado para outro túnel.',
                                  'Confira /etc/fagoo/cloudflared com quem administra o servidor antes de continuar. O assistente não substitui essa credencial.'),
    'TUNNEL_CONFIGURATION_EXISTS': ('Este servidor já tem uma configuração de túnel incompleta ou ilegível.',
                                    'Confira /etc/fagoo/cloudflared e o serviço fagoo-cloudflared com quem administra o servidor. O assistente não substitui essa credencial.'),
    'TUNNEL_SERVICE_EXISTS': ('Já existe um serviço fagoo-cloudflared neste servidor.',
                              'Confira esse serviço com quem administra o servidor antes de continuar.'),
    'TUNNEL_METRICS_PORT_BUSY': ('A porta local 20241, usada para conferir o túnel, está ocupada.',
                                 'Outro programa usa essa porta. Libere-a e repita o comando.'),
    'TUNNEL_SERVICE_OPERATION_FAILED': ('O conector do túnel não iniciou.',
                                        'Confira com: sudo systemctl status fagoo-cloudflared.service. Depois repita o comando.'),
    'TUNNEL_NOT_READY': ('O conector do túnel iniciou, mas ainda não se conectou à Cloudflare.',
                         'Aguarde um minuto e repita o comando.'),
    'TUNNEL_TOKEN_INVALID': ('A Cloudflare devolveu uma credencial de túnel em formato inesperado.',
                             'Repita o comando. Se persistir, siga a etapa do túnel pelo manual de instalação.'),
    'TUNNEL_ID_MISMATCH': ('A credencial do túnel não corresponde ao túnel desta instalação.',
                           'Repita o comando. Se persistir, siga a etapa do túnel pelo manual de instalação.'),
    'CLOUDFLARED_TOKEN_FILE_REQUIRED': ('O programa cloudflared não está instalado ou é antigo demais.',
                                        'Repita o comando; a etapa de ferramentas será refeita.'),
    'FAGOO_LOCAL_GATEWAY_NOT_READY': ('Os serviços locais do FAGOO não responderam.',
                                      'Confira com: sudo docker ps. Reinicie o servidor se os serviços estiverem parados e repita o comando.'),
    'FAGOO_RUNTIME_EXISTS': ('Já existe uma instalação do FAGOO, completa ou parcial, neste servidor.',
                             'O assistente não substitui serviços nem dados. Uma instalação concluída é atualizada pelo painel; uma parcial precisa ser conferida antes. Não remova volumes para forçar outra instalação.'),
    'RUNTIME_PARTIAL': ('Uma tentativa anterior deixou os serviços locais incompletos.',
                        'O assistente não refaz essa etapa sozinho para não arriscar dados. Consulte "Instalação parcial" no manual (docs/operations/installation.md) e peça apoio técnico.'),
    'CONFIGURATION_NOT_CREATED': ('A configuração privada não foi criada.',
                                  'Confira o domínio informado e repita o comando.'),
    'ADMIN_AUTH_CREATION_FAILED': ('O serviço de autenticação não criou o administrador.',
                                   'Se este e-mail já foi usado em uma tentativa anterior, peça apoio técnico antes de repetir; não apague contas para tentar de novo.'),
    'ADMIN_DATABASE_OPERATION_FAILED': ('O banco de dados recusou o registro do administrador.',
                                        'Confira se os serviços estão ativos com: sudo docker ps. Depois repita o comando.'),
    'ADMIN_INPUT_INVALID': ('Os dados do administrador não foram aceitos.',
                            'Use um e-mail válido, um nome sem caracteres especiais de controle e uma senha de 12 a 200 caracteres.'),
    'DEPENDENCIES_REQUIRED': ('As dependências da aplicação não estão completas.',
                              'Repita o comando; a etapa de ferramentas será refeita.'),
    'APPLICATION_DEPLOY_LOCK_EXISTS': ('Outra publicação parece estar em andamento ou foi interrompida.',
                                       'Se nenhuma publicação estiver rodando, remova a pasta vazia private/install/cloudflare/deploy.lock e repita o comando.'),
    'CUSTOM_DOMAIN_DNS_CONFLICT': ('O endereço da interface ou da API já tem um registro no DNS da Cloudflare.',
                                   'Remova no painel somente os registros desses dois endereços e repita o comando.'),
    'CUSTOM_DOMAIN_BELONGS_TO_ANOTHER_WORKER': ('O endereço da interface ou da API já pertence a outro aplicativo na Cloudflare.',
                                                'Libere esse endereço no painel (Workers e Pages → aplicativo → Domínios) ou use outro domínio.'),
    'ERP_BUILD_FAILED': ('A compilação da interface falhou.',
                         'Confira a memória e o espaço em disco do servidor e repita o comando.'),
    'ERP_BUILD_CHECK_FAILED': ('A conferência da interface compilada falhou.', 'Repita o comando. Se persistir, peça apoio técnico com o arquivo de registro.'),
    'API_PACKAGE_FAILED': ('O empacotamento da API falhou.', 'Repita o comando. Se persistir, peça apoio técnico com o arquivo de registro.'),
    'WEB_PACKAGE_FAILED': ('O empacotamento da interface falhou.', 'Repita o comando. Se persistir, peça apoio técnico com o arquivo de registro.'),
    'API_DEPLOY_FAILED': ('A Cloudflare não aceitou a publicação da API.',
                          'Confira no token a permissão ' + PERMISSIONS['workers'] + ' e repita o comando.'),
    'WEB_DEPLOY_FAILED': ('A Cloudflare não aceitou a publicação da interface.',
                          'Confira no token a permissão ' + PERMISSIONS['workers'] + ' e repita o comando. A API já foi publicada e não é desfeita.'),
    'CLOUDFLARE_PREFLIGHT_FAILED': ('A Cloudflare não respondeu à conferência antes da publicação.',
                                    'Confira as permissões e a validade do token e repita o comando.'),
    'PUBLIC_ADDRESS_NOT_READY': ('O endereço {detail} ainda não respondeu como esperado.',
                                 'Endereços novos podem levar alguns minutos para funcionar. Aguarde cerca de dez minutos e repita o comando.'),
    'UPDATER_NOT_ACTIVE': ('O serviço de atualização do FAGOO não está ativo.',
                           'Confira com: sudo systemctl status fagoo-updater.service. Depois repita o comando.'),
    'SCHEMA_CHECK_FAILED': ('A conferência do banco de dados não foi aprovada.',
                            'Não altere o banco manualmente. Peça apoio técnico com o arquivo de registro.'),
    'STEP_FAILED': ('Um comando desta etapa terminou com erro.',
                    'Leia as últimas linhas do registro acima. Falhas de rede costumam se resolver repetindo o comando.'),
}


class Stop(Exception):
    """A failure the assistant can explain in Portuguese."""

    def __init__(self, code, detail='', output=''):
        super().__init__(code)
        self.code, self.detail, self.output, self.stage = code, detail, output, None


def explain(code, detail=''):
    what, action = MESSAGES.get(code, MESSAGES['STEP_FAILED'])
    return what.format(detail=detail or 'sem detalhe'), action


def known_code(text):
    """Last diagnostic code of the helpers found in their output, if the assistant can explain it."""
    found = [value for value in re.findall(r'\b[A-Z][A-Z0-9_]{5,}\b', text) if value in MESSAGES and value != 'STEP_FAILED']
    return found[-1] if found else None


def sibling(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- Cloudflare -----------------------------------------------------------------------------

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise ValueError('CLOUDFLARE_REDIRECT_REFUSED')


def cloudflare(method, path, token, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'FAGOO-installer/1'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read(3 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        # Never echo the response: only the status selects the explanation.
        if error.code in (400, 401) and path == '/user/tokens/verify':
            raise Stop('CLOUDFLARE_TOKEN_REJECTED') from None
        if error.code in (401, 403):
            raise Stop('CLOUDFLARE_PERMISSION_MISSING') from None
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'resposta HTTP ' + str(error.code)) from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Stop('CLOUDFLARE_UNREACHABLE') from None
    try:
        result = json.loads(raw)
    except ValueError:
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'resposta ilegível') from None
    if not isinstance(result, dict) or result.get('success') is not True or 'result' not in result:
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'operação não confirmada')
    return result['result']


def needing(permission, call):
    """Run one API call and name the token permission when Cloudflare refuses it."""
    try:
        return call()
    except Stop as failure:
        if failure.code == 'CLOUDFLARE_PERMISSION_MISSING':
            raise Stop(failure.code, PERMISSIONS[permission]) from None
        raise


def token_expiry(api):
    """Expiry of a user API token as an aware datetime, or None when it has none or is unknown."""
    result = api('GET', '/user/tokens/verify')
    if not isinstance(result, dict) or result.get('status') != 'active':
        raise Stop('CLOUDFLARE_TOKEN_INACTIVE')
    try:
        return datetime.fromisoformat(result['expires_on'].replace('Z', '+00:00')) if result.get('expires_on') else None
    except (ValueError, AttributeError):
        return None


def find_zone(api, hostname):
    """Cloudflare zone that contains hostname: tries the name itself, then each parent."""
    labels = hostname.split('.')
    for start in range(len(labels) - 1):
        name = '.'.join(labels[start:])
        zones = needing('zone', lambda: api('GET', '/zones?' + urllib.parse.urlencode({'name': name, 'per_page': 5})))
        match = [zone for zone in zones if isinstance(zone, dict) and zone.get('name') == name] if isinstance(zones, list) else []
        if not match:
            continue
        zone = match[0]
        account = zone.get('account', {}).get('id', '')
        if not re.fullmatch('[a-f0-9]{32}', str(zone.get('id', ''))) or not re.fullmatch('[a-f0-9]{32}', str(account)):
            raise Stop('CLOUDFLARE_REQUEST_FAILED', 'identificadores do domínio em formato inesperado')
        if zone.get('status') != 'active':
            raise Stop('CLOUDFLARE_ZONE_NOT_ACTIVE', name)
        return {'name': name, 'zone_id': zone['id'], 'account_id': account}
    raise Stop('CLOUDFLARE_ZONE_NOT_FOUND', hostname)


def installation_suffix(web_origin):
    # Same derivation as the Worker names in deploy-application.py.
    return hashlib.sha256(web_origin.encode()).hexdigest()[:12]


def hostname(value):
    return urllib.parse.urlsplit(value).hostname


def dns_records(api, zone_id, name):
    query = urllib.parse.urlencode({'name': name, 'per_page': 100, 'page': 1})
    records = needing('dns', lambda: api('GET', '/zones/' + zone_id + '/dns_records?' + query))
    if not isinstance(records, list):
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'lista de DNS em formato inesperado')
    return records


def find_tunnel(api, account_id, name):
    query = urllib.parse.urlencode({'name': name, 'is_deleted': 'false'})
    tunnels = needing('tunnel', lambda: api('GET', '/accounts/' + account_id + '/cfd_tunnel?' + query))
    found = [item for item in tunnels if isinstance(item, dict) and item.get('name') == name and not item.get('deleted_at')] if isinstance(tunnels, list) else []
    if len(found) > 1:
        raise Stop('TUNNEL_NAME_AMBIGUOUS')
    if not found:
        return None
    if found[0].get('config_src') != 'cloudflare':
        raise Stop('TUNNEL_NOT_REMOTELY_MANAGED')
    return str(uuid.UUID(found[0]['id']))


def validate_token(api, web_origin):
    """Zone of the installation and token expiry; a refused token is reported as such, not as a permission."""
    verified = True
    try:
        expires = token_expiry(api)
    except Stop as failure:
        # Account-owned tokens are not verifiable on the user endpoint; the zone lookup decides.
        if failure.code != 'CLOUDFLARE_TOKEN_REJECTED':
            raise
        verified, expires = False, None
    try:
        return find_zone(api, hostname(web_origin)), expires
    except Stop as failure:
        if not verified and failure.code in ('CLOUDFLARE_PERMISSION_MISSING', 'CLOUDFLARE_ZONE_NOT_FOUND'):
            raise Stop('CLOUDFLARE_TOKEN_REJECTED') from None
        raise


def check_addresses(api, zone, origins, connector_tunnel=None):
    """Refuse, before anything is installed, addresses the installation could not own."""
    web, backend, application = (hostname(value) for value in origins)
    for name in (web, backend, application):
        if not name.endswith('.' + zone['name']):
            raise Stop('HOST_OUTSIDE_ZONE', name)
        if name.count('.') != zone['name'].count('.') + 1:
            raise Stop('HOST_NOT_FIRST_LEVEL', name)
    suffix = installation_suffix(origins[0])
    domains = needing('workers', lambda: api('GET', '/accounts/' + zone['account_id'] + '/workers/domains'))
    if not isinstance(domains, list):
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'lista de domínios dos Workers em formato inesperado')
    for name, worker in ((web, 'fagoo-web-' + suffix), (application, 'fagoo-api-' + suffix)):
        linked = [item for item in domains if isinstance(item, dict) and item.get('hostname') == name]
        if any(item.get('service') != worker for item in linked) or (not linked and dns_records(api, zone['zone_id'], name)):
            raise Stop('HOST_IN_USE', name)
    # The services address may already point to this installation's tunnel. With a connector on
    # this server that is its tunnel, and a publication-only token from the manual procedure is
    # enough; otherwise it is the tunnel the assistant names, which needs the tunnel permission.
    tunnel_id = connector_tunnel or find_tunnel(api, zone['account_id'], 'fagoo-' + suffix)
    records = dns_records(api, zone['zone_id'], backend)
    if records and not (tunnel_id and tunnel_record_matches(records, tunnel_id)):
        raise Stop('HOST_IN_USE', backend)


def tunnel_record_matches(records, tunnel_id):
    return (len(records) == 1 and records[0].get('type') == 'CNAME' and records[0].get('proxied') is True
            and str(records[0].get('content', '')).rstrip('.').lower() == tunnel_id + '.cfargotunnel.com')


def ensure_tunnel(api, account_id, name):
    tunnel_id = find_tunnel(api, account_id, name)
    if tunnel_id:
        return tunnel_id
    created = needing('tunnel', lambda: api('POST', '/accounts/' + account_id + '/cfd_tunnel', {'name': name, 'config_src': 'cloudflare'}))
    try:
        return str(uuid.UUID(created['id']))
    except (TypeError, KeyError, ValueError):
        raise Stop('CLOUDFLARE_REQUEST_FAILED', 'túnel criado sem identificador') from None


def publish_route(api, account_id, tunnel_id, name, port):
    # The whole ingress of this installation's own tunnel: one hostname, then the required catch-all.
    body = {'config': {'ingress': [{'hostname': name, 'service': 'http://localhost:' + str(int(port))}, {'service': 'http_status:404'}]}}
    needing('tunnel', lambda: api('PUT', '/accounts/' + account_id + '/cfd_tunnel/' + tunnel_id + '/configurations', body))


def ensure_dns(api, zone_id, name, tunnel_id):
    records = dns_records(api, zone_id, name)
    if not records:
        body = {'type': 'CNAME', 'name': name, 'content': tunnel_id + '.cfargotunnel.com', 'proxied': True}
        needing('dns', lambda: api('POST', '/zones/' + zone_id + '/dns_records', body))
        return 'created'
    if tunnel_record_matches(records, tunnel_id):
        return 'kept'
    # Never replace or delete somebody else's record.
    raise Stop('HOST_IN_USE', name)


# --- Local helpers --------------------------------------------------------------------------

def fetch(url, headers=None, timeout=10):
    request = urllib.request.Request(url, headers={'User-Agent': 'FAGOO-updater/1', 'Accept': 'application/json',
                                                   'Cache-Control': 'no-cache', **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers, response.read(65537)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, b''


def wait_for(check, attempts=60, delay=5, sleep=time.sleep, tick=None):
    for attempt in range(attempts):
        try:
            if check():
                return True
        except (OSError, ValueError):
            pass
        if attempt + 1 < attempts:
            if tick:
                tick()
            sleep(delay)
    return False


def dot():
    print('.', end='', flush=True)


class State:
    """Progress and non-secret identifiers of one installation, kept beside its private files."""

    def __init__(self, path):
        self.path = Path(path)
        self.data = {'format': 1, 'done': []}
        if self.path.exists():
            value = json.loads(self.path.read_text(encoding='utf-8'))
            if not isinstance(value, dict) or value.get('format') != 1 or not isinstance(value.get('done'), list):
                raise Stop('STEP_FAILED', 'estado do assistente ilegível')
            self.data = value

    def done(self, stage):
        return stage in self.data['done']

    def finish(self, stage):
        if stage not in self.data['done']:
            self.data['done'].append(stage)
        self.save()

    def update(self, **values):
        self.data.update(values)
        self.save()

    def save(self):
        atomic_json(self.path, self.data)


def run_logged(argv, log_path, label, env=None, timeout=7200):
    """Run one helper with its output in the private log; the terminal only shows progress."""
    with open(log_path, 'ab') as log:
        log.write(('\n=== ' + label + ' — ' + datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') + ' ===\n').encode())
        log.flush()
        start = log.tell()
        process = subprocess.Popen([str(value) for value in argv], cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        started, shown = time.monotonic(), 0
        while process.poll() is None:
            time.sleep(1)
            elapsed = time.monotonic() - started
            if elapsed > timeout:
                process.kill()
                process.wait()
                raise Stop('STEP_FAILED', label)
            if elapsed // 15 > shown:
                shown = elapsed // 15
                dot()
    if process.returncode:
        with open(log_path, 'rb') as log:
            log.seek(start)
            output = log.read()[-8192:].decode('utf-8', errors='replace')
        raise Stop(known_code(output) or 'STEP_FAILED', output=output)


def hidden(prompt):
    # getpass falls back to an echoed stream without a terminal. Refuse that fallback.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass(prompt)
    except (getpass.GetPassWarning, EOFError):
        raise Stop('TERMINAL_REQUIRED') from None


def ask(prompt, validate, secret=False, attempts=5, read=None):
    read = read or (hidden if secret else input)
    for _ in range(attempts):
        try:
            answer = read(prompt)
        except EOFError:
            raise Stop('TERMINAL_REQUIRED') from None
        try:
            return validate(answer if secret else answer.strip())
        except ValueError as error:
            print('  ' + str(error))
    raise Stop('TOO_MANY_INVALID_ANSWERS')


def valid_domain(value):
    try:
        return derived_origins(value)
    except ValueError:
        raise ValueError('Informe somente o domínio, como empresa.com.br, sem https:// e sem caminho.') from None


def valid_token(value):
    value = value.strip()
    if not 20 <= len(value) <= 512 or re.search(r'\s', value):
        raise ValueError('Isso não parece um token da Cloudflare. Copie o valor inteiro mostrado na criação do token.')
    return value


def valid_email(value):
    if not re.fullmatch(r'[^\s@]{1,200}@[^\s@.]+(?:\.[^\s@.]+)+', value):
        raise ValueError('Informe um e-mail válido, como nome@empresa.com.br.')
    return value


def valid_name(value):
    if not 1 <= len(value) <= 200 or any(ord(character) < 32 for character in value):
        raise ValueError('Informe o nome de quem vai administrar o sistema.')
    return value


def valid_password(value):
    if not 12 <= len(value) <= 200:
        raise ValueError('A senha precisa ter pelo menos 12 caracteres.')
    return value


def ask_password():
    for _ in range(5):
        password = ask('Senha do administrador (mínimo de 12 caracteres; não aparece ao digitar): ', valid_password, secret=True)
        if hidden('Repita a senha: ') == password:
            return password
        print('  As duas senhas não são iguais. Tente novamente.')
    raise Stop('TOO_MANY_INVALID_ANSWERS')


def expiry_notice(expires, now=None):
    """Sentence about the token validity for the final summary; warns when it is short."""
    if expires is None:
        return None
    days = (expires - (now or datetime.now(timezone.utc))).days
    text = 'O token da Cloudflare vale até ' + expires.strftime('%d/%m/%Y') + '.'
    if days < 90:
        text += ' É pouco tempo: depois dessa data o botão Atualizar agora deixa de funcionar até você salvar um token novo.'
    return text


# --- Stages ---------------------------------------------------------------------------------

class Assistant:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.private = self.root / 'private/install'
        self.env_file = self.private / '.env'
        self.credentials_path = self.private / 'cloudflare/credentials.json'
        self.log_path = self.private / 'assistant.log'
        self.state = None
        self.password = None

    def api(self, token):
        return lambda method, path, body=None: cloudflare(method, path, token, body)

    def saved_api(self):
        return self.api(cloudflare_credentials(self.credentials_path)['token'])

    def origins(self):
        return tuple(self.state.data['origins'])

    def local_port(self):
        return int(read_values(self.env_file).get('FAGOO_LOCAL_PORT', '8081'))

    def service_active(self, name):
        return subprocess.run(['systemctl', 'is-active', '--quiet', name], check=False).returncode == 0

    def local_gateway_ready(self):
        try:
            return fetch('http://127.0.0.1:' + str(self.local_port()) + '/healthz', timeout=5)[0] == 200
        except (OSError, ValueError):
            return False

    def schema_checked(self):
        return subprocess.run([sys.executable, str(self.root / 'infra/migrate.py'), '--env-file', str(self.env_file), '--check-only'],
                              cwd=self.root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0

    def administrator_exists(self):
        admin = sibling('create-admin')
        return admin.psql(self.env_file.resolve(), 'fagoo', 'select count(*) from erp_access.membership;') != '0'

    def connector_tunnel(self, connector=None):
        """Tunnel of the connector already installed on this server, or None when there is none."""
        connector = connector or sibling('connect-tunnel')
        token_path = connector.TOKEN_DIR / 'token'
        if not (token_path.exists() or connector.TOKEN_DIR.exists() or connector.UNIT_PATH.exists()):
            return None
        try:
            return connector.extract_token(token_path.read_text(encoding='ascii').strip())[1]
        except (OSError, ValueError):
            raise Stop('TUNNEL_CONFIGURATION_EXISTS') from None

    def accept_token(self, token):
        api = self.api(token)
        zone, expires = validate_token(api, self.origins()[0])
        check_addresses(api, zone, self.origins(), self.connector_tunnel())
        return zone, expires

    # Questions -----------------------------------------------------------------------------

    def collect(self, args):
        state = self.state
        if self.env_file.exists():
            values = read_values(self.env_file)
            existing = [origin(values[key]) for key in ('FAGOO_WEB_ORIGIN', 'FAGOO_BACKEND_ORIGIN', 'FAGOO_API_ORIGIN')]
            requested = requested_origins(args)
            if requested and list(requested) != existing:
                raise Stop('ORIGINS_CHANGED', ', '.join(existing))
            if state.data.get('origins') != existing:
                state.update(origins=existing)
        else:
            requested = requested_origins(args)
            if requested and state.data.get('origins') not in (None, list(requested)):
                # Nothing was installed for the earlier answer; the token is checked again for the new one.
                state.update(origins=list(requested), zone=None)
            elif not state.data.get('origins'):
                if not requested:
                    print('O FAGOO usa três endereços dentro do seu domínio: fagoo, fagoo-services e fagoo-api.')
                    requested = ask('Domínio da instalação (exemplo: empresa.com.br): ', valid_domain)
                state.update(origins=list(requested))
        web, backend, application = self.origins()
        print('\nEndereços desta instalação:')
        print('  Sistema (o que as pessoas abrem): ' + web)
        print('  API:                              ' + application)
        print('  Serviços internos:                ' + backend)

        if not state.data.get('zone') and self.credentials_path.exists():
            # A publication made by the manual procedure already saved a token: keep it when it still works.
            try:
                saved = cloudflare_credentials(self.credentials_path)
                zone, expires = self.accept_token(saved['token'])
                if (zone['account_id'], zone['zone_id']) == (saved['account_id'], saved['zone_id']):
                    state.update(zone=zone, token_expires=expires.isoformat() if expires else None)
            except (Stop, ValueError, OSError):
                pass
        if not state.data.get('zone'):
            print('\nAgora o token da Cloudflare, criado conforme o guia de instalação.')
            for _ in range(3):
                token = ask('Token da Cloudflare (não aparece ao colar): ', valid_token, secret=True)
                try:
                    zone, expires = self.accept_token(token)
                    break
                except Stop as failure:
                    if failure.code not in ('CLOUDFLARE_TOKEN_REJECTED', 'CLOUDFLARE_TOKEN_INACTIVE'):
                        raise
                    print('  ' + explain(failure.code)[0] + ' Tente novamente.')
            else:
                raise Stop('CLOUDFLARE_TOKEN_REJECTED')
            atomic_json(self.credentials_path, {'account_id': zone['account_id'], 'zone_id': zone['zone_id'], 'token': token})
            del token
            state.update(zone=zone, token_expires=expires.isoformat() if expires else None)
            print('  Token aceito para o domínio ' + zone['name'] + '.')

        if not state.done('admin'):
            if state.done('runtime') and self.administrator_exists():
                state.finish('admin')
            else:
                print('\nAgora os dados de quem vai administrar o sistema.')
                try:
                    email = valid_email(args.admin_email.strip()) if args.admin_email else ask('E-mail do administrador: ', valid_email)
                    name = valid_name(args.admin_name.strip()) if args.admin_name else ask('Nome do administrador: ', valid_name)
                except ValueError:
                    raise Stop('ADMIN_INPUT_INVALID') from None
                self.password = ask_password()
                state.update(admin_email=email, admin_name=name)

    # Stages --------------------------------------------------------------------------------

    def runtime(self):
        if self.env_file.exists():
            # Either the manual runtime step was completed or an earlier attempt stopped half-way.
            # The updater unit is the last thing the runtime installer starts.
            if self.local_gateway_ready() and self.schema_checked() and self.service_active('fagoo-updater.service'):
                return
            raise Stop('RUNTIME_PARTIAL')
        web, backend, application = self.origins()
        run_logged(['bash', self.root / 'scripts/install-runtime.sh', '--web-origin', web, '--backend-origin', backend,
                    '--api-origin', application], self.log_path, 'runtime')

    def admin(self):
        if self.administrator_exists():
            return
        if self.password is None:
            raise Stop('ADMIN_INPUT_INVALID')
        admin = sibling('create-admin')
        try:
            admin.create(self.env_file, 'fagoo', self.state.data['admin_email'], self.state.data['admin_name'], self.password)
        except ValueError as error:
            raise Stop(known_code(str(error)) or 'ADMIN_AUTH_CREATION_FAILED') from None
        except (OSError, KeyError):
            raise Stop('ADMIN_AUTH_CREATION_FAILED') from None
        finally:
            self.password = None

    def tools(self):
        run_logged(['bash', self.root / 'scripts/install-deployment-tools.sh'], self.log_path, 'tools')
        env = {**os.environ, 'PATH': '/usr/local/bin:' + os.environ.get('PATH', '/usr/bin:/bin'), 'CI': 'true', 'NO_COLOR': '1'}
        argv = ['npm', 'run', 'install:deployment']
        owner = self.root.stat().st_uid
        if owner != 0:
            # Dependencies belong to whoever owns the code folder, as in the manual procedure.
            import pwd
            account = pwd.getpwuid(owner)
            env.update(HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name)
            argv = ['runuser', '-u', account.pw_name, '--', *argv]
        run_logged(argv, self.log_path, 'dependencies', env=env)

    def tunnel(self):
        api, zone = self.saved_api(), self.state.data['zone']
        web, backend, _ = self.origins()
        connector = sibling('connect-tunnel')
        if not self.local_gateway_ready():
            raise Stop('FAGOO_LOCAL_GATEWAY_NOT_READY')
        installed = self.connector_tunnel(connector)
        if installed and installed != self.state.data.get('tunnel_id'):
            # Connector from the manual procedure: its tunnel, route and DNS stay as that procedure left them.
            self.start_existing_connector(connector)
        else:
            name = 'fagoo-' + installation_suffix(web)
            # With a connector already on this server, never create a second tunnel to replace its own.
            tunnel_id = find_tunnel(api, zone['account_id'], name) if installed else ensure_tunnel(api, zone['account_id'], name)
            if installed and installed != tunnel_id:
                raise Stop('TUNNEL_BELONGS_TO_ANOTHER')
            self.state.update(tunnel_id=tunnel_id)
            if installed:
                self.start_existing_connector(connector)
            else:
                try:
                    binary = connector.preflight(require_terminal=False, gateway_port=self.local_port())
                    secret = needing('tunnel', lambda: api('GET', '/accounts/' + zone['account_id'] + '/cfd_tunnel/' + tunnel_id + '/token'))
                    token, _ = connector.extract_token(secret, tunnel_id)
                    connector.start_connector(token, binary)
                    del secret, token
                except ValueError as error:
                    raise Stop(known_code(str(error)) or 'TUNNEL_SERVICE_OPERATION_FAILED') from None
                except (OSError, subprocess.TimeoutExpired):
                    raise Stop('TUNNEL_SERVICE_OPERATION_FAILED') from None
            publish_route(api, zone['account_id'], tunnel_id, hostname(backend), self.local_port())
            ensure_dns(api, zone['zone_id'], hostname(backend), tunnel_id)
        if not wait_for(lambda: fetch(backend + '/healthz')[0] == 200, tick=dot):
            raise Stop('PUBLIC_ADDRESS_NOT_READY', backend)

    def start_existing_connector(self, connector):
        if not self.service_active(connector.SERVICE):
            try:
                connector.command(['systemctl', 'enable', '--now', connector.SERVICE], timeout=100)
            except (ValueError, OSError, subprocess.TimeoutExpired):
                raise Stop('TUNNEL_SERVICE_OPERATION_FAILED') from None

    def publish(self):
        zone = self.state.data['zone']
        run_logged([sys.executable, self.root / 'infra/deploy-application.py', '--env-file', self.env_file,
                    '--account-id', zone['account_id'], '--zone-id', zone['zone_id'], '--deploy',
                    '--credentials-file', self.credentials_path], self.log_path, 'publish')

    def verify(self):
        web, backend, application = self.origins()
        if not self.schema_checked():
            raise Stop('SCHEMA_CHECK_FAILED')
        if not self.service_active('fagoo-updater.service'):
            raise Stop('UPDATER_NOT_ACTIVE')
        identity = source_identity(self.root)

        def published(url):
            status, _, body = fetch(url + '?verification=' + str(int(time.time())))
            value = json.loads(body) if status == 200 else {}
            return value.get('version') == identity['version'] and identity['revision'] in (None, value.get('revision'))

        def authentication():
            status, headers, _ = fetch(backend + '/auth/v1/health', headers={'Origin': web})
            return status == 200 and headers.get('Access-Control-Allow-Origin') == web

        checks = ((web, lambda: published(web + '/fagoo-version.json')),
                  (application, lambda: published(application + '/v1/system/version')),
                  (backend, authentication),
                  (application, lambda: fetch(application + '/v1/me')[0] == 401))
        for address, check in checks:
            if not wait_for(check, tick=dot):
                raise Stop('PUBLIC_ADDRESS_NOT_READY', address)

    # Flow ----------------------------------------------------------------------------------

    def summary(self):
        web = self.origins()[0]
        expires = self.state.data.get('token_expires')
        notice = expiry_notice(datetime.fromisoformat(expires)) if expires else None
        lines = ['', 'FAGOO instalado.', '',
                 '  Abra:      ' + web,
                 '  Entre com: ' + str(self.state.data.get('admin_email') or 'o e-mail do administrador') + ' e a senha definida na instalação.', '',
                 'Próximos passos:',
                 '  1. Cadastre a empresa pelo próprio sistema.',
                 '  2. Guarde o token da Cloudflare no seu gerenciador de senhas. ' + (notice or 'Anote a validade dele.'),
                 '     Para salvar um token novo: sudo python3 infra/configure-updates.py --root ' + str(self.root),
                 '  3. Atualizações: Preferências → Sistema → Atualizações do sistema.',
                 '  4. Mantenha uma cópia de segurança fora deste servidor.',
                 '  E-mail (convites e recuperação de senha), fiscal e bancos têm configuração própria: docs/operations/installation.md']
        return '\n'.join(lines)

    def run(self, args):
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state = State(self.private / 'assistant.json')
        if all(self.state.done(stage) for stage in STAGES):
            print('Esta instalação já foi concluída pelo assistente.')
            print(self.summary())
            return
        if self.state.data['done']:
            print('Continuando a instalação a partir da etapa que faltava.')
        if self.env_file.exists() and not self.state.done('runtime'):
            # Decide this before asking anything: a half-installed runtime stops here.
            self.runtime()
            self.state.finish('runtime')
            print('Os serviços locais já estavam instalados neste servidor; a instalação continua a partir deles.')
        fresh = not self.state.data['done']
        self.collect(args)
        if fresh and not args.yes:
            try:
                answer = input('\nPosso começar a instalação? Ela segue sozinha a partir daqui; o tempo depende do servidor e da conexão. [S/n] ').strip().lower()
            except EOFError:
                raise Stop('TERMINAL_REQUIRED') from None
            if answer not in ('', 's', 'sim', 'y', 'yes'):
                print('Nada foi instalado. Repita o comando quando quiser continuar.')
                return
        for number, stage in enumerate(STAGES, 1):
            title = '[' + str(number) + '/' + str(len(STAGES)) + '] ' + TITLES[stage]
            if self.state.done(stage):
                print(title + ': já concluída')
                continue
            print(title + ' ', end='', flush=True)
            try:
                getattr(self, stage)()
            except Stop as failure:
                failure.stage = TITLES[stage]
                raise
            self.state.finish(stage)
            print(' OK')
        print(self.summary())


def requested_origins(args):
    explicit = [args.web_origin, args.backend_origin, args.api_origin]
    if args.domain and not any(explicit):
        return valid_domain(args.domain)
    if not args.domain and all(explicit):
        try:
            values = tuple(origin(value) for value in explicit)
        except ValueError:
            raise Stop('CONFIGURATION_NOT_CREATED') from None
        if len(set(values)) != 3:
            raise Stop('CONFIGURATION_NOT_CREATED')
        return values
    if args.domain or any(explicit):
        raise Stop('CONFIGURATION_NOT_CREATED')
    return None


def report(failure, log_path):
    what, action = explain(failure.code, failure.detail)
    print('\n')
    if failure.code == 'STEP_FAILED' and failure.output:
        print('Últimas linhas do registro:')
        print('\n'.join('  ' + line for line in failure.output.splitlines()[-15:]))
        print()
    stage = failure.stage
    started = failure.code not in ('ROOT_UBUNTU_REQUIRED', 'TERMINAL_REQUIRED', 'ASSISTANT_ALREADY_RUNNING')
    print('A instalação parou' + (' na etapa "' + stage + '".' if stage else '.') if started else 'A instalação não começou.')
    print('O que aconteceu: ' + what)
    print('O que fazer:     ' + action)
    if started:
        print(RESUME)
    if Path(log_path).exists():
        print('Registro técnico (privado, sem senhas): ' + str(log_path))
    print('Código: ' + failure.code)


def main():
    parser = argparse.ArgumentParser(description='Assistente de instalação do FAGOO.')
    parser.add_argument('--domain', help='Domínio na Cloudflare; os três endereços são criados abaixo dele.')
    parser.add_argument('--web-origin', help='Avançado: endereço da interface. Exige os outros dois.')
    parser.add_argument('--backend-origin', help='Avançado: endereço dos serviços.')
    parser.add_argument('--api-origin', help='Avançado: endereço da API.')
    parser.add_argument('--admin-email')
    parser.add_argument('--admin-name')
    parser.add_argument('--yes', action='store_true', help='Não pede a confirmação antes de começar.')
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors='replace')
    assistant = Assistant()
    lock = None
    try:
        release = Path('/etc/os-release').read_text(encoding='utf-8') if os.name == 'posix' and Path('/etc/os-release').exists() else ''
        if os.name != 'posix' or os.geteuid() != 0 or not re.search(r'(?m)^ID=ubuntu$', release) or not re.search(r'(?m)^VERSION_ID="24\.04"$', release):
            raise Stop('ROOT_UBUNTU_REQUIRED')
        if not sys.stdin.isatty():
            raise Stop('TERMINAL_REQUIRED')
        os.umask(0o077)
        assistant.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        import fcntl
        lock = open(assistant.private / 'assistant.lock', 'w')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Stop('ASSISTANT_ALREADY_RUNNING') from None
        print('Assistente de instalação do FAGOO\n')
        assistant.run(args)
    except Stop as failure:
        report(failure, assistant.log_path)
        return 1
    except KeyboardInterrupt:
        print('\n\nInstalação interrompida. ' + RESUME)
        return 1
    except (ValueError, KeyError, OSError, EOFError, subprocess.SubprocessError) as error:
        # Standard-library errors may carry input fragments; show only a known diagnostic code.
        report(Stop(known_code(str(error)) or 'STEP_FAILED'), assistant.log_path)
        return 1
    finally:
        if lock is not None:
            lock.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
