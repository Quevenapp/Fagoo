#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$EUID" -eq 0 ]] || { echo 'Root is required for provisioning.' >&2; exit 1; }
. /etc/os-release
[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 && "$(uname -m)" = x86_64 ]] || { echo 'Supported platform: Ubuntu 24.04 amd64.' >&2; exit 1; }
fagoo_home="${FAGOO_HOME:-/opt/fagoo}"
[[ "$fagoo_home" = /opt/fagoo ]] || { echo 'Installer manages /opt/fagoo only.' >&2; exit 1; }
release="$(realpath "${1:?Release directory required}")"
[[ "$release" = "$fagoo_home/releases/"* && -f "$release/infra/compose.yaml" ]] || { echo 'Invalid release directory.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'A full Ubuntu system with systemd is required.' >&2; exit 1; }
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl openssl python3
if ! command -v docker >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io; fi
if ! docker compose version >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2; fi
systemctl enable --now docker
docker info >/dev/null
available_mb="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
[[ "$available_mb" -ge 3500 ]] || { echo 'At least 4 GB of RAM is required.' >&2; exit 1; }
free_kb="$(df --output=avail "$fagoo_home" | tail -1 | tr -d ' ')"
[[ "$free_kb" -ge 5242880 ]] || { echo 'At least 5 GB of available disk is required.' >&2; exit 1; }
getent group fagoo-update >/dev/null || groupadd --system fagoo-update
update_gid="$(getent group fagoo-update | cut -d: -f3)"
install -d -m 0700 "$fagoo_home/secrets" "$fagoo_home/updater" "$fagoo_home/state" "$fagoo_home/backups"
install -d -m 0750 -g fagoo-update /run/fagoo
if [[ ! -f "$fagoo_home/secrets/updater-token" ]]; then openssl rand -hex 32 > "$fagoo_home/secrets/updater-token"; fi
chown root:fagoo-update "$fagoo_home/secrets/updater-token"
chmod 0640 "$fagoo_home/secrets/updater-token"
if [[ ! -f "$fagoo_home/config.env" ]]; then
  local_port="$(python3 - <<'PY'
import socket
for port in range(8080,8100):
 try:
  with socket.socket() as probe: probe.bind(('127.0.0.1',port))
  print(port); break
 except OSError: continue
else: raise SystemExit('No free loopback port from 8080 to 8099')
PY
)"
  if [[ "${FAGOO_LOCAL_INSTALL:-0}" = 1 ]]; then
    public_url="http://localhost:$local_port"
  else
    read -r -p 'Endereço público HTTPS do servidor (ex.: https://erp.suaempresa.com): ' public_url
    python3 - "$public_url" <<'PY'
import sys,urllib.parse
u=urllib.parse.urlsplit(sys.argv[1]); assert u.scheme=='https' and u.hostname and not(u.username or u.password or u.query or u.fragment) and u.path in ('','/') and u.port in (None,443),'A public HTTPS origin is required'
PY
  fi
  database_password="$(openssl rand -hex 32)"
  auth_secret="$(openssl rand -hex 32)"
  cat > "$fagoo_home/config.env" <<ENV
FAGOO_HOME=$fagoo_home
FAGOO_IMAGE=${FAGOO_RELEASE_IMAGE:?Verified image required}
FAGOO_VERSION=${FAGOO_RELEASE_VERSION:?Version required}
FAGOO_PUBLIC_URL=${public_url%/}
FAGOO_LOCAL_PORT=$local_port
FAGOO_UPDATER_GID=$update_gid
POSTGRES_PASSWORD=$database_password
BETTER_AUTH_SECRET=$auth_secret
ENV
  unset database_password auth_secret
  chmod 0600 "$fagoo_home/config.env"
fi
python3 - "$fagoo_home/config.env" "$FAGOO_RELEASE_IMAGE" "$FAGOO_RELEASE_VERSION" "$update_gid" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); keys={'FAGOO_IMAGE':sys.argv[2],'FAGOO_VERSION':sys.argv[3],'FAGOO_UPDATER_GID':sys.argv[4]}
lines=[x for x in p.read_text().splitlines() if x.split('=',1)[0] not in keys]
p.write_text('\n'.join(lines+[f'{k}={v}' for k,v in keys.items()])+'\n'); p.chmod(0o600)
PY
[[ ! -e "$fagoo_home/current" || -L "$fagoo_home/current" ]] || { echo 'Unexpected current directory; refusing replacement.' >&2; exit 1; }
ln -sfn "$release" "$fagoo_home/current"
chmod 0755 "$release/scripts/backup.sh" "$release/scripts/restore.sh"
install -m 0644 "$release/infra/updater.py" "$fagoo_home/updater/updater.py"
if [[ ! -f "$fagoo_home/updater/release-root.pem" ]]; then install -m 0644 "$release/infra/release-root.pem" "$fagoo_home/updater/release-root.pem"; fi
compose=(docker compose --project-name fagoo --env-file "$fagoo_home/config.env" -f "$release/infra/compose.yaml")
if [[ "${FAGOO_SOURCE_IMAGE:-0}" != 1 ]]; then
  python3 "$release/infra/updater.py" load-image --manifest "$fagoo_home/state/install-manifest.json" --signature "$fagoo_home/state/install-manifest.sig"
  "${compose[@]}" pull postgres
fi
"${compose[@]}" up -d --wait postgres
"${compose[@]}" run --rm -T --interactive=false --no-deps api node apps/api/src/migrate.mjs
status="$("${compose[@]}" run --rm -T --interactive=false --no-deps api node apps/api/src/bootstrap.mjs --status)"
initialized="$(printf '%s' "$status" | python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["initialized"] else "no")')"
if [[ "$initialized" != yes ]]; then
  read -r -p 'Nome da empresa: ' company
  read -r -p 'Nome do administrador: ' admin_name
  read -r -p 'E-mail do administrador: ' admin_email
  read -r -s -p 'Senha do administrador (12 a 128 caracteres): ' admin_password; echo
  read -r -s -p 'Confirme a senha: ' confirmation; echo
  [[ "$admin_password" = "$confirmation" && "${#admin_password}" -ge 12 && "${#admin_password}" -le 128 ]] || { echo 'Senhas diferentes ou tamanho inválido.' >&2; exit 1; }
  printf '%s\n' "$admin_password" | "${compose[@]}" run --rm -T --no-deps api node apps/api/src/bootstrap.mjs --email "$admin_email" --name "$admin_name" --company "$company" --password-stdin
  unset admin_password confirmation
fi
install -m 0644 "$release/infra/fagoo-updater.service" /etc/systemd/system/fagoo-updater.service
install -m 0644 "$release/infra/fagoo-backup.service" /etc/systemd/system/fagoo-backup.service
install -m 0644 "$release/infra/fagoo-backup.timer" /etc/systemd/system/fagoo-backup.timer
systemctl daemon-reload
systemctl enable --now fagoo-updater.service fagoo-backup.timer
"${compose[@]}" up -d --wait api jobs
bash "$release/scripts/backup.sh"
configured_port="$(python3 - "$fagoo_home/config.env" <<'PY'
import sys
values=dict(line.rstrip('\n').split('=',1) for line in open(sys.argv[1]) if '=' in line and not line.startswith('#'))
print(values['FAGOO_LOCAL_PORT'])
PY
)"
echo "FAGOO services are healthy. Local access is bound to 127.0.0.1:$configured_port."
echo 'Next: configure Cloudflare Tunnel and offsite backups using docs/operations/installation.md.'
