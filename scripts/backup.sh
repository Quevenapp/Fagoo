#!/usr/bin/env bash
set -euo pipefail
umask 077
fagoo_home="${FAGOO_HOME:-/opt/fagoo}"
[[ "$fagoo_home" = /* && -f "$fagoo_home/config.env" && -f "$fagoo_home/current/infra/compose.yaml" ]] || { echo 'FAGOO installation not found.' >&2; exit 1; }
mkdir -p "$fagoo_home/backups"
export FAGOO_HOME="$fagoo_home"
python3 "$fagoo_home/current/infra/backup-state.py" running
name="fagoo-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
target="$fagoo_home/backups/$name"
temporary="$target.partial"
cleanup() { result=$?; rm -f -- "$temporary"; if [[ "$result" -ne 0 ]]; then python3 "$fagoo_home/current/infra/backup-state.py" failed; fi; }
trap cleanup EXIT
docker compose --project-name fagoo --env-file "$fagoo_home/config.env" -f "$fagoo_home/current/infra/compose.yaml" exec -T postgres pg_dump -U fagoo -d fagoo --format=custom --no-owner --no-acl > "$temporary"
[[ -s "$temporary" ]] || { echo 'Empty backup rejected.' >&2; exit 1; }
docker compose --project-name fagoo --env-file "$fagoo_home/config.env" -f "$fagoo_home/current/infra/compose.yaml" exec -T postgres pg_restore --list < "$temporary" > /dev/null
mv -- "$temporary" "$target"
(cd "$fagoo_home/backups" && sha256sum "$name" > "$name.sha256")
if [[ -f "$fagoo_home/backup.json" ]]; then
  bucket="$(python3 -c 'import json,sys,re; v=json.load(open(sys.argv[1]))["bucket"]; assert re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]",v); print(v)' "$fagoo_home/backup.json")"
  [[ -f "$fagoo_home/secrets/rclone.conf" ]] || { echo 'Offsite backup configured without credentials.' >&2; exit 1; }
  command -v rclone >/dev/null || { echo 'Install rclone for configured offsite backups.' >&2; exit 1; }
  rclone copyto "$target" "fagoo:$bucket/database/$name" --config "$fagoo_home/secrets/rclone.conf"
  rclone copyto "$target.sha256" "fagoo:$bucket/database/$name.sha256" --config "$fagoo_home/secrets/rclone.conf"
  python3 "$fagoo_home/current/infra/backup-state.py" complete "$name"
  echo "Database backup verified and uploaded: $name"
else
  python3 "$fagoo_home/current/infra/backup-state.py" local_only "$name"
  echo "Database backup verified locally: $name"
  echo 'Offsite backup is not configured. This copy alone does not protect against loss of the VPS.' >&2
fi
