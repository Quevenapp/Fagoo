"""Optional API-v3 connector configuration persisted with one installation."""
import base64
from datetime import date
import re
from urllib.parse import urlsplit


MODES = ('paused', 'receive', 'bidirectional')
SECRET_NAMES = ('ORIGIN_CLIENT_ID', 'ORIGIN_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', 'INTEGRATION_ADMIN_TOKEN')


def endpoint(value, *, origin_only=False):
    try:
        if not isinstance(value, str):
            raise ValueError()
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if (not isinstance(value, str) or value != value.strip() or re.search(r'[\s\\]', value)
                or parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port
                or parsed.query or parsed.fragment or '?' in value or '#' in value
                or len(host.split('.')) < 2 or not re.search('[a-z]', host.split('.')[-1])
                or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.'))
                or (origin_only and parsed.path not in ('', '/'))):
            raise ValueError()
        return 'https://' + host if origin_only else value
    except (TypeError, ValueError):
        raise ValueError('INTEGRATION_ENDPOINT_INVALID') from None


def integration_settings(values):
    enabled = values.get('FAGOO_INTEGRATION_ENABLED', 'false')
    if enabled not in ('true', 'false'):
        raise ValueError('INTEGRATION_ENABLED_INVALID')
    # Legacy worker flags alone never activate a customer connector.
    if enabled != 'true':
        return {'vars': {}, 'secrets': {}, 'scheduled': False}
    mode = values.get('FAGOO_INTEGRATION_MODE', 'paused')
    if mode not in MODES:
        raise ValueError('INTEGRATION_MODE_INVALID')
    name = values.get('FAGOO_INTEGRATION_NAME', 'Integração externa')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or re.search(r'[\x00-\x1f\x7f<>]', name):
        raise ValueError('INTEGRATION_NAME_INVALID')
    secrets = {key: values.get(key, '') for key in SECRET_NAMES}
    if any(not isinstance(v, str) or not v or len(v) > 8192 or re.search(r'\s', v) for v in secrets.values()):
        raise ValueError('INTEGRATION_SECRET_MISSING')
    try:
        if len(base64.b64decode(secrets['TOKEN_ENCRYPTION_KEY'], validate=True)) != 32:
            raise ValueError()
    except (ValueError, base64.binascii.Error):
        raise ValueError('INTEGRATION_ENCRYPTION_KEY_INVALID') from None
    if len(secrets['INTEGRATION_ADMIN_TOKEN']) < 32:
        raise ValueError('INTEGRATION_ADMIN_TOKEN_INVALID')
    start = values.get('FAGOO_INTEGRATION_START_DATE', '')
    try:
        if date.fromisoformat(start).isoformat() != start:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('INTEGRATION_START_DATE_INVALID') from None
    variables = {
        'ORIGIN_ENABLED': 'true', 'ORIGIN_CONNECTOR_ENABLED': 'true',
        'ORIGIN_TWO_WAY_ENABLED': 'true' if mode != 'paused' else 'false',
        'ORIGIN_WRITE_ENABLED': 'true' if mode == 'bidirectional' else 'false',
        'ORIGIN_HISTORY_ENABLED': 'true', 'ORIGIN_CONNECTION_NAME': name.strip(),
        'ORIGIN_CONNECTION_MODE': mode,
        'PUBLIC_BASE_URL': endpoint(values['FAGOO_API_ORIGIN'], origin_only=True),
        'ORIGIN_API_ORIGIN': endpoint(values.get('ORIGIN_API_ORIGIN'), origin_only=True),
        'ORIGIN_AUTHORIZATION_ENDPOINT': endpoint(values.get('ORIGIN_AUTHORIZATION_ENDPOINT')),
        'ORIGIN_TOKEN_ENDPOINT': endpoint(values.get('ORIGIN_TOKEN_ENDPOINT')),
        'SYNC_ENABLED': 'true' if mode != 'paused' else 'false',
        'ERP_SCHEDULED_TASKS_ENABLED': 'true' if mode != 'paused' else 'false',
        'SYNC_START_DATE': start, 'SYNC_TIME_ZONE': 'America/Sao_Paulo',
        'MAX_API_REQUESTS': '60', 'ORIGIN_SYNC_MAX_REQUESTS': '40', 'ORIGIN_SYNC_INTERVAL_MS': '1000',
        'EXTRA_RESOURCES_ENABLED': 'true', 'STOCK_PRIORITY_ENABLED': 'true',
        'FINANCE_REFRESH_ENABLED': 'true', 'REFERENCE_FETCH_ENABLED': 'true',
        'PRICE_CAPTURE_ENABLED': 'true', 'PURCHASE_PRICE_CAPTURE_ENABLED': 'true',
        'SALES_PRICE_CAPTURE_ENABLED': 'true', 'SALES_PRICE_REFRESH_ENABLED': 'true',
        'PRICE_REFRESH_ENABLED': 'true', 'XML_SYNC_ENABLED': 'true', 'XML_RESIDUAL_ENABLED': 'true',
    }
    return {'vars': variables, 'secrets': secrets, 'scheduled': mode != 'paused'}
