"""Configure an optional API-v3 connector without storing credentials in the repository."""
import argparse
import base64
import getpass
import os
from pathlib import Path
import secrets
import tempfile
import warnings

from integration_config import integration_settings, MODES
from update_config import read_values


def hidden(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        return getpass.getpass(prompt).strip()


def save_configuration(path, patch):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('RUNTIME_CONFIGURATION_INVALID')
    original = path.read_bytes()
    values = read_values(path)
    # Rotating this key would make existing OAuth credentials unreadable.
    if values.get('TOKEN_ENCRYPTION_KEY') and patch.get('TOKEN_ENCRYPTION_KEY', values['TOKEN_ENCRYPTION_KEY']) != values['TOKEN_ENCRYPTION_KEY']:
        raise ValueError('EXISTING_ENCRYPTION_KEY_MUST_BE_PRESERVED')
    values.update(patch)
    integration_settings(values)
    if any('\n' in value or '\r' in value for value in values.values()):
        raise ValueError('RUNTIME_CONFIGURATION_INVALID')
    content = original.decode('utf-8').splitlines()
    written = set()
    for i, line in enumerate(content):
        key = line.partition('=')[0]
        if key in patch:
            content[i] = key + '=' + values[key]
            written.add(key)
    content.extend(key + '=' + values[key] for key in patch if key not in written)
    descriptor, name = tempfile.mkstemp(prefix='.integration-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            output.write('\n'.join(content) + '\n')
            output.flush()
            os.fsync(output.fileno())
        if path.read_bytes() != original:
            raise ValueError('RUNTIME_CHANGED_RETRY')
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--mode', choices=MODES, default='paused')
    parser.add_argument('--configure', action='store_true', help='Ask for endpoints and application credentials; otherwise only change mode.')
    args = parser.parse_args()
    values = read_values(args.env_file)
    patch = {'FAGOO_INTEGRATION_ENABLED': 'true', 'FAGOO_INTEGRATION_MODE': args.mode}
    if args.configure:
        for key, prompt in [('FAGOO_INTEGRATION_NAME', 'Nome da conexão'),
                            ('FAGOO_INTEGRATION_START_DATE', 'Início da coleta (AAAA-MM-DD)'),
                            ('ORIGIN_API_ORIGIN', 'Origem HTTPS da API'),
                            ('ORIGIN_AUTHORIZATION_ENDPOINT', 'URL HTTPS de autorização OAuth'),
                            ('ORIGIN_TOKEN_ENDPOINT', 'URL HTTPS de troca de token OAuth')]:
            patch[key] = input(prompt + ': ').strip()
        patch['ORIGIN_CLIENT_ID'] = hidden('Client ID (oculto): ')
        patch['ORIGIN_CLIENT_SECRET'] = hidden('Client secret (oculto): ')
        patch['TOKEN_ENCRYPTION_KEY'] = values.get('TOKEN_ENCRYPTION_KEY') or base64.b64encode(secrets.token_bytes(32)).decode()
        patch['INTEGRATION_ADMIN_TOKEN'] = values.get('INTEGRATION_ADMIN_TOKEN') or secrets.token_urlsafe(48)
    elif values.get('FAGOO_INTEGRATION_ENABLED') != 'true':
        raise ValueError('CONFIGURE_CONNECTOR_FIRST')
    save_configuration(args.env_file, patch)
    print('Configuração privada salva. Publique a API pelo procedimento de atualização para aplicar o modo escolhido.')
    print('Nenhum envio foi iniciado por este comando. Antes da mão dupla, confira vínculos, filas e efeitos automáticos externos.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError, getpass.GetPassWarning) as error:
        code = str(error) if isinstance(error, ValueError) and str(error).isupper() else 'INTEGRATION_CONFIGURATION_NOT_SAVED'
        raise SystemExit(code) from None
