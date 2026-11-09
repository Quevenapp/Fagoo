#!/usr/bin/env bash
# The operator selects the public FAGOO code version before invoking this command.
set -euo pipefail
umask 077
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$task_root"
task_env=private/install/.env
task_requested_project=''
while (($#)); do
  (($# >= 2)) || { printf '%s\n' 'Each option requires a value.' >&2; exit 1; }
  [[ -n "$2" ]] || { printf '%s\n' 'Each option requires a nonempty value.' >&2; exit 1; }
  case "$1" in
    --env-file) task_env=$2; shift 2 ;;
    --project-name) task_requested_project=$2; shift 2 ;;
    *) printf '%s\n' 'Unsupported argument.' >&2; exit 1 ;;
  esac
done
[[ -f "$task_env" ]] || { printf '%s\n' 'Existing runtime configuration is required.' >&2; exit 1; }
task_project=$(python3 infra/installation_scope.py --env-file "$task_env" --field project)
[[ -z "$task_requested_project" || "$task_requested_project" == "$task_project" ]] || { printf '%s\n' 'The requested project differs from the persisted installation.' >&2; exit 1; }
task_compose=(docker compose --project-name "$task_project" --env-file "$task_env" -f infra/compose.yaml)
mkdir -p -- "$task_root/private"
# The dashboard updater and manual updates share this lock within the same root.
task_lock="$task_root/private/update-fagoo.lock"
mkdir -- "$task_lock" 2>/dev/null || { printf '%s\n' 'An update lock exists. Inspect the running update before recovering a stale lock.' >&2; exit 1; }
task_maintenance=false
task_backup='not-created'
task_finish() {
  task_status=$?
  if [[ "$task_maintenance" == true ]]; then
    "${task_compose[@]}" stop gateway >/dev/null 2>&1 || true
    printf '%s\n' "Update interrupted. Keep the gateway stopped; preserve the backup at $task_backup and inspect privately before recovery." >&2
  fi
  rmdir -- "$task_lock"
  exit "$task_status"
}
trap task_finish EXIT
"${task_compose[@]}" config --quiet
python3 infra/migrate.py --env-file "$task_env" --project-name "$task_project" --check-only
task_expected_major=$(python3 -c 'import json; print(json.load(open("infra/runtime-manifest.json"))["database_major"])')
task_actual_major=$("${task_compose[@]}" exec -T db psql -X -At -U postgres -d postgres -c "select current_setting('server_version_num')::integer/10000")
[[ "$task_actual_major" == "$task_expected_major" ]] || { printf '%s\n' 'A database major-version upgrade requires a separate validated procedure.' >&2; exit 1; }
task_backup="$task_root/private/backups/$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
mkdir -p -- "$task_backup"
cp -- "$task_env" "$task_backup/runtime.env"
cp -- infra/runtime-manifest.json "$task_backup/target-runtime-manifest.json"
# The checked-out compose file describes the target release, so capture the
# actual previous containers before stopping/replacing them for recovery.
python3 infra/record-runtime.py --env-file "$task_env" --project-name "$task_project" --output "$task_backup/previous-runtime-images.json"
task_maintenance=true
"${task_compose[@]}" stop gateway auth storage rest
"${task_compose[@]}" exec -T db pg_dump -U postgres -d postgres --format=custom > "$task_backup/database.dump"
"${task_compose[@]}" run -T --rm --no-deps --entrypoint tar storage -cf - -C /var/lib/storage . > "$task_backup/storage.tar"
test -s "$task_backup/database.dump"
test -s "$task_backup/storage.tar"
"${task_compose[@]}" pull --quiet
"${task_compose[@]}" up -d --wait --wait-timeout 300 db auth rest storage
python3 infra/bootstrap-owner.py --env-file "$task_env" --project-name "$task_project"
python3 infra/migrate.py --env-file "$task_env" --project-name "$task_project"
"${task_compose[@]}" up -d --wait --wait-timeout 120 gateway
task_maintenance=false
printf '%s\n' "Common runtime updated. Configuration, data and schema ledger were preserved. Backup: $task_backup"
printf '%s\n' 'The application Workers/frontend must use the matching selected public version. This command does not publish them.'
