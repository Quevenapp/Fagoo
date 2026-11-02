#!/usr/bin/env bash
set -euo pipefail
umask 077
fagoo_home="${FAGOO_HOME:-/opt/fagoo}"
backup="${1:-}"
[[ "${2:-}" = '--confirm-database-replace' ]] || { echo 'Usage: sudo scripts/restore.sh /absolute/path/fagoo.dump --confirm-database-replace' >&2; exit 2; }
[[ "$backup" = /* && -f "$backup" && -f "$backup.sha256" && -f "$fagoo_home/config.env" ]] || { echo 'Backup, checksum, or installation not found.' >&2; exit 1; }
(cd "$(dirname "$backup")" && sha256sum --check "$(basename "$backup").sha256")
compose=(docker compose --project-name fagoo --env-file "$fagoo_home/config.env" -f "$fagoo_home/current/infra/compose.yaml")
"${compose[@]}" exec -T postgres pg_restore --list < "$backup" > /dev/null
"${compose[@]}" stop api jobs
"${compose[@]}" exec -T postgres dropdb --force --if-exists -U fagoo fagoo
"${compose[@]}" exec -T postgres createdb -U fagoo -O fagoo fagoo
"${compose[@]}" exec -T postgres pg_restore --single-transaction --exit-on-error --no-owner --no-acl -U fagoo -d fagoo < "$backup"
echo 'Database restored. Services remain stopped; verify release/database compatibility, then start api and jobs.'
