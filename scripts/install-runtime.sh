#!/usr/bin/env bash
# Installs the common local runtime only. Public HTTPS/Worker setup is a separate step.
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$task_root"
if [[ $(id -u) -ne 0 ]]; then
  printf '%s\n' 'Run this script as root on Ubuntu. It installs operating-system dependencies.' >&2
  exit 1
fi
. /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 24.04 ]]; then
  printf '%s\n' 'This runtime installer currently supports Ubuntu 24.04 only.' >&2
  exit 1
fi
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
task_existing_containers=$(docker ps -aq --filter label=com.docker.compose.project=fagoo)
task_existing_volumes=$(docker volume ls -q --filter label=com.docker.compose.project=fagoo)
task_all_volumes=$(docker volume ls -q)
task_named_volume_exists=false
while IFS= read -r task_volume; do
  case "$task_volume" in
    fagoo_database|fagoo_database-config|fagoo_objects) task_named_volume_exists=true ;;
  esac
done <<< "$task_all_volumes"
if [[ -n "$task_existing_containers" || -n "$task_existing_volumes" || "$task_named_volume_exists" == true ]]; then
  printf '%s\n' 'An existing or partial FAGOO runtime was found. This fresh installer will not replace its services. Use scripts/update-runtime.sh for an initialized installation; inspect a partial installation privately before recovery.' >&2
  exit 1
fi
if [[ ! -f private/install/.env ]]; then
  read -r -p 'Public web origin (https://...): ' task_web
  read -r -p 'Public backend origin (https://...): ' task_backend
  read -r -p 'Public ERP API origin (https://...): ' task_api
  python3 infra/configure.py --web-origin "$task_web" --backend-origin "$task_backend" --api-origin "$task_api"
fi
docker compose --project-name fagoo --env-file private/install/.env -f infra/compose.yaml config --quiet
docker compose --project-name fagoo --env-file private/install/.env -f infra/compose.yaml up -d --wait --wait-timeout 300
python3 infra/bootstrap-owner.py
python3 infra/migrate.py
printf '%s\n' 'Local runtime and schema are ready on loopback. Configure public HTTPS, the ERP Workers, frontend and SMTP before using it as a client installation.'
printf '%s\n' 'Create the initial administrator with: python3 infra/create-admin.py --email YOUR_EMAIL --name YOUR_NAME'
