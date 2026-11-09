#!/usr/bin/env bash
# Installs the common local runtime only. Public HTTPS/Worker setup is a separate step.
set -euo pipefail
umask 077
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$task_root"
task_env=private/install/.env
task_instance=''
task_port=''
task_metrics=''
task_skip_packages=false
task_usage() {
  printf '%s\n' 'Usage: scripts/install-runtime.sh [--instance-id ID] [--local-port PORT] [--tunnel-metrics-port PORT] [--skip-system-packages]. Each installation requires its own root directory.' >&2
  exit 1
}
while (($#)); do
  if [[ "$1" == --skip-system-packages ]]; then task_skip_packages=true; shift; continue; fi
  (($# >= 2)) || task_usage
  [[ -n "$2" ]] || task_usage
  case "$1" in
    --instance-id) task_instance=$2 ;;
    --local-port) task_port=$2 ;;
    --tunnel-metrics-port) task_metrics=$2 ;;
    *) task_usage ;;
  esac
  shift 2
done
[[ -z "$task_instance" || "$task_instance" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || task_usage
for task_requested_port in "$task_port" "$task_metrics"; do
  [[ -z "$task_requested_port" ]] && continue
  [[ "$task_requested_port" =~ ^[0-9]{4,5}$ ]] || task_usage
  ((10#$task_requested_port >= 1024 && 10#$task_requested_port <= 65535)) || task_usage
done
if [[ $(id -u) -ne 0 ]]; then
  printf '%s\n' 'Run this script as root on Ubuntu. It installs operating-system dependencies.' >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  printf '%s\n' 'This runtime installer currently supports Ubuntu 24.04 only.' >&2
  exit 1
fi
command -v python3 >/dev/null || { printf '%s\n' 'Python 3 is required to validate this installation before changing Ubuntu packages.' >&2; exit 1; }
if [[ "$task_skip_packages" == true ]]; then
  for task_dependency in curl openssl docker; do
    command -v "$task_dependency" >/dev/null || { printf 'Required existing dependency is unavailable: %s\n' "$task_dependency" >&2; exit 1; }
  done
  docker compose version >/dev/null 2>&1 || { printf '%s\n' 'Existing Docker Compose is required with --skip-system-packages.' >&2; exit 1; }
fi
task_scope=(python3 infra/installation_scope.py)
if [[ -f "$task_env" ]]; then
  task_scope+=(--env-file "$task_env")
elif [[ -z "$task_instance" ]]; then
  task_instance=fagoo
fi
[[ -z "$task_instance" ]] || task_scope+=(--instance-id "$task_instance")
task_project=$("${task_scope[@]}" --field project)
task_updater_service=$("${task_scope[@]}" --field updater_service)
task_tunnel_service=$("${task_scope[@]}" --field tunnel_service)
task_tunnel_dir=$("${task_scope[@]}" --field tunnel_token_dir)
if [[ -f "$task_env" ]]; then
  task_saved_port=$("${task_scope[@]}" --field local_port)
  task_saved_metrics=$("${task_scope[@]}" --field metrics_port)
  [[ -z "$task_port" || "$task_port" == "$task_saved_port" ]] || { printf '%s\n' 'The requested port differs from the persisted installation.' >&2; exit 1; }
  [[ -z "$task_metrics" || "$task_metrics" == "$task_saved_metrics" ]] || { printf '%s\n' 'The requested metrics port differs from the persisted installation.' >&2; exit 1; }
  task_port=$task_saved_port
  task_metrics=$task_saved_metrics
else
  task_port=${task_port:-8081}
  task_metrics=${task_metrics:-20241}
fi
task_validate_config() {
  python3 - "$task_env" <<'PY'
import runpy, sys
from pathlib import Path
sys.path.insert(0, str(Path('infra').resolve()))
try:
    runpy.run_path('infra/deploy-application.py')['configuration'](sys.argv[1])
except Exception:
    raise SystemExit('Runtime configuration is invalid; no operating-system packages were changed.') from None
PY
}
[[ ! -f "$task_env" ]] || task_validate_config
task_refuse_existing() {
  printf '%s\n' "An existing or partial runtime was found for $task_project. This fresh installer will not replace it. Use scripts/update-runtime.sh for an initialized installation; inspect partial resources privately before recovery." >&2
  exit 1
}
task_check_target() {
  [[ ! -e "/etc/systemd/system/$task_updater_service" && ! -e "/etc/systemd/system/$task_tunnel_service" && ! -e "$task_tunnel_dir" ]] || task_refuse_existing
  if command -v docker >/dev/null; then
    task_existing_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$task_project")
    task_existing_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$task_project")
    [[ -z "$task_existing_containers" && -z "$task_existing_volumes" ]] || task_refuse_existing
    task_all_volumes=$(docker volume ls -q)
    while IFS= read -r task_volume; do
      case "$task_volume" in
        "${task_project}_database"|"${task_project}_database-config"|"${task_project}_objects") task_refuse_existing ;;
      esac
    done <<< "$task_all_volumes"
  elif [[ -e /var/lib/docker ]]; then
    printf '%s\n' 'Docker storage exists but its CLI is unavailable. Inspect it before running the fresh installer.' >&2
    exit 1
  fi
}
# Inspect only this instance's resources before apt or configuration generation.
task_check_target
python3 - "$task_port" "$task_metrics" <<'PY'
import socket, sys
ports = list(map(int, sys.argv[1:]))
if len(set(ports)) != len(ports):
    raise SystemExit('The runtime and tunnel metrics require distinct loopback ports.')
for port in ports:
    try:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    except OSError:
        raise SystemExit('An installation port is already in use. Choose separate ports before installing.') from None
PY
if [[ ! -f "$task_env" ]]; then
  read -r -p 'Public web origin (https://...): ' task_web
  read -r -p 'Public backend origin (https://...): ' task_backend
  read -r -p 'Public ERP API origin (https://...): ' task_api
  python3 infra/configure.py --instance-id "$task_project" --local-port "$task_port" --tunnel-metrics-port "$task_metrics" --web-origin "$task_web" --backend-origin "$task_backend" --api-origin "$task_api"
fi
task_validate_config
task_compose=(docker compose --project-name "$task_project" --env-file "$task_env" -f infra/compose.yaml)
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  "${task_compose[@]}" config --quiet
fi
if [[ "$task_skip_packages" == false ]]; then
  apt-get update
  apt-get install -y ca-certificates curl python3 openssl
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
fi
# Recheck after installing dependencies, before creating any containers.
task_check_target
"${task_compose[@]}" config --quiet
"${task_compose[@]}" up -d --wait --wait-timeout 300
python3 infra/bootstrap-owner.py --env-file "$task_env" --project-name "$task_project"
python3 infra/migrate.py --initialize-standalone --env-file "$task_env" --project-name "$task_project"
python3 infra/install-updater.py --root "$task_root"
printf '%s\n' 'Local runtime and schema are ready on loopback. Configure public HTTPS, the ERP Workers, frontend and SMTP before using it as a client installation.'
printf 'Create the initial administrator with: python3 infra/create-admin.py --env-file %q --project-name %q --email YOUR_EMAIL --name YOUR_NAME\n' "$task_env" "$task_project"
