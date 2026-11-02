#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

action = sys.argv[1]
if action not in ('running', 'failed', 'local_only', 'complete'):
    raise ValueError('INVALID_BACKUP_STATE')
path = Path(os.environ.get('FAGOO_HOME', '/opt/fagoo')) / 'state/backup.json'
path.parent.mkdir(parents=True, exist_ok=True)
value = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'last_success_at': None, 'offsite': False}
now = datetime.now(timezone.utc).isoformat()
messages = {'running': 'Backup em andamento.', 'failed': 'O último backup solicitado falhou; verifique os registros da tarefa.',
            'local_only': 'Cópia local verificada. Configure armazenamento fora da VPS para proteger contra perda do servidor.',
            'complete': 'Backup verificado e enviado ao armazenamento privado fora da VPS.'}
value.update(status=action, updated_at=now, message=messages[action])
if action == 'running':
    value['last_attempt_at'] = now
if action in ('local_only', 'complete'):
    value.update(last_success_at=now, offsite=action == 'complete', filename=Path(sys.argv[2]).name)
temporary = path.with_suffix('.tmp')
temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
temporary.chmod(0o600)
os.replace(temporary, path)
