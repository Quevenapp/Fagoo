"""Configure only the trusted schema owner's service-table privileges after initialization."""
import argparse
from pathlib import Path
import subprocess

from installation_scope import project_for
from update_config import read_values

ROOT = Path(__file__).resolve().parents[1]

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--project-name')
    args = parser.parse_args()
    args.project_name = project_for(read_values(args.env_file), args.project_name)
    command = ['docker', 'compose', '--project-name', args.project_name, '--env-file', str(Path(args.env_file).resolve()), '-f', str(ROOT / 'infra/compose.yaml'), 'exec', '-T', 'db', 'psql', '-X', '-q', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-']
    result = subprocess.run(command, input=(ROOT / 'infra/database/schema-owner.sql').read_bytes(), capture_output=True, check=False)
    if result.returncode:
        raise SystemExit('SCHEMA_OWNER_BOOTSTRAP_FAILED')
    print('Trusted schema-owner privileges configured; application roles were not granted owner privileges.')
