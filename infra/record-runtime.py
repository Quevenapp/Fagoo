"""Record running image identities for private recovery, without container environment secrets."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def read(command):
    result = subprocess.run(command, capture_output=True, check=True)
    return result.stdout.decode('utf-8').strip()


def record(env_file, project, destination):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project):
        raise ValueError('RUNTIME_PROJECT_INVALID')
    compose = ['docker', 'compose', '--project-name', project, '--env-file', str(Path(env_file).resolve()), '-f', str(ROOT / 'infra/compose.yaml')]
    ids = read(compose + ['ps', '-aq']).splitlines()
    if not ids:
        raise ValueError('RUNTIME_CONTAINERS_REQUIRED')
    template = '{"container_id":"{{.Id}}","image_id":"{{.Image}}","image_reference":"{{.Config.Image}}","service":"{{index .Config.Labels "com.docker.compose.service"}}"}'
    containers = [json.loads(line) for line in read(['docker', 'inspect', '--format', template, *ids]).splitlines()]
    value = {'recorded_at': datetime.now(timezone.utc).isoformat(), 'project': project, 'containers': containers}
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8', newline='\n') as output:
        json.dump(value, output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--project-name', default='fagoo')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        record(args.env_file, args.project_name, args.output)
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit('RUNTIME_IDENTITIES_NOT_RECORDED')
    print('Running runtime identities recorded privately.')
