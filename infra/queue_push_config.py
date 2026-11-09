"""Preserve optional consumer push providers without exposing credentials to the web build."""
import json
import re


def queue_push_settings(values):
    variables, secrets = {}, {}
    account = values.get('FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON', values.get('FCM_CONTA_SERVICO', ''))
    if account:
        try:
            parsed = json.loads(account)
            if (parsed.get('type') != 'service_account' or not re.fullmatch('[A-Za-z0-9-]{3,100}', parsed.get('project_id', ''))
                    or not re.fullmatch(r'[^\s@]+@[^\s@]+', parsed.get('client_email', ''))
                    or not parsed.get('private_key', '').startswith('-----BEGIN PRIVATE KEY-----')):
                raise ValueError()
        except (TypeError, ValueError, AttributeError):
            raise ValueError('QUEUE_FCM_CONFIGURATION_INVALID') from None
        secrets['FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON'] = account
    mapping = {
        'FAGOO_QUEUE_APNS_PRIVATE_KEY': 'APNS_CHAVE_P8', 'FAGOO_QUEUE_APNS_KEY_ID': 'APNS_KEY_ID',
        'FAGOO_QUEUE_APNS_TEAM_ID': 'APNS_TEAM_ID', 'FAGOO_QUEUE_APNS_TOPIC': 'APNS_TOPICO',
    }
    apns = {name: values.get(name, values.get(legacy, '')) for name, legacy in mapping.items()}
    if any(apns.values()):
        key = apns.pop('FAGOO_QUEUE_APNS_PRIVATE_KEY').replace('\\n', '\n')
        environment = values.get('FAGOO_QUEUE_APNS_ENVIRONMENT', 'production')
        if (not key.startswith('-----BEGIN PRIVATE KEY-----') or not key.rstrip().endswith('-----END PRIVATE KEY-----')
                or environment not in ('sandbox', 'production')
                or not re.fullmatch('[A-Za-z0-9]{10}', apns['FAGOO_QUEUE_APNS_KEY_ID'])
                or not re.fullmatch('[A-Za-z0-9]{10}', apns['FAGOO_QUEUE_APNS_TEAM_ID'])
                or not re.fullmatch('[A-Za-z0-9.-]{3,200}', apns['FAGOO_QUEUE_APNS_TOPIC'])):
            raise ValueError('QUEUE_APNS_CONFIGURATION_INVALID')
        secrets['FAGOO_QUEUE_APNS_PRIVATE_KEY'] = key
        variables.update(apns); variables['FAGOO_QUEUE_APNS_ENVIRONMENT'] = environment
    return {'vars': variables, 'secrets': secrets}
