"""Apply the public schema with an atomic, immutable ledger shared by every installation."""
import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import sys

from installation_scope import project_for
from update_config import read_values

ROOT = Path(__file__).resolve().parents[1]


def migration(path):
    # Preserve intentional standalone CR characters inside SQL string literals.
    # Text-mode universal newlines would change those literals and pinned hashes.
    source = path.read_bytes().decode('utf-8').replace('\r\n', '\n')
    name = path.name
    if not re.fullmatch(r'[0-9]{12,}_[a-z0-9_]+\.sql', name):
        raise ValueError('MIGRATION_FILENAME_INVALID')
    # These versioned files use one external BEGIN/COMMIT pair. Strip only that
    # pair so the unchanged schema body and its ledger entry commit atomically.
    first = re.match(r'\A(?:\s|--[^\n]*(?:\n|$))*begin\s*;', source, re.I)
    last = re.search(r'\bcommit\s*;\s*\Z', source, re.I)
    if not first or not last or first.end() >= last.start():
        raise ValueError('MIGRATION_TRANSACTION_WRAPPER_INVALID')
    body = source[first.end():last.start()]
    # psql meta-commands are never allowed inside distribution SQL.
    if re.search(r'(?m)^\s*\\', body):
        raise ValueError('MIGRATION_META_COMMAND_REJECTED')
    return name, hashlib.sha256(source.encode()).hexdigest(), body


def program(directory, check_only=False, initialize_standalone=False):
    if check_only and initialize_standalone:
        raise ValueError('STANDALONE_INITIALIZATION_IS_NOT_A_PREFLIGHT')
    files = [migration(path) for path in sorted(Path(directory).glob('*.sql'))]
    if not files:
        raise ValueError('MIGRATIONS_MISSING')
    values = ','.join(f"('{name}','{sha}')" for name, sha, _ in files)
    lines = [r'\set ON_ERROR_STOP on', "select pg_advisory_lock(1964102101, 1);", "create schema if not exists fagoo_system;", "revoke all on schema fagoo_system from public,anon,authenticated,service_role;", "create table if not exists fagoo_system.schema_migration(version text primary key,sha256 text not null check(sha256~'^[0-9a-f]{64}$'),applied_at timestamptz not null default clock_timestamp());", "revoke all on all tables in schema fagoo_system from public,anon,authenticated,service_role;", "do $fagoo$ begin if to_regclass('auth.users') is null or to_regclass('auth.sessions') is null or to_regclass('auth.mfa_factors') is null or to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then raise exception 'FAGOO_RUNTIME_SCHEMAS_NOT_READY'; end if; end $fagoo$;", f"do $fagoo$ begin if exists(select 1 from fagoo_system.schema_migration a left join (values {values}) expected(version,sha256) using(version) where expected.version is null or expected.sha256<>a.sha256) then raise exception 'FAGOO_SCHEMA_VERSION_OR_HASH_CONFLICT'; end if; if exists(select 1 from (values {values}) expected(version,sha256) where expected.version<(select max(version) from fagoo_system.schema_migration) and not exists(select 1 from fagoo_system.schema_migration a where a.version=expected.version)) then raise exception 'FAGOO_SCHEMA_LEDGER_GAP'; end if; end $fagoo$;"]
    if check_only:
        # A preflight must not initialize a ledger in an unrecognized database.
        lines[2:6] = ["do $fagoo$ begin if to_regclass('fagoo_system.schema_migration') is null then raise exception 'FAGOO_SCHEMA_LEDGER_REQUIRED'; end if; end $fagoo$;"]
    for name, sha, body in ([] if check_only else files):
        lines.extend(['begin;', f"select not exists(select 1 from fagoo_system.schema_migration where version='{name}') as fagoo_apply \\gset", r'\if :fagoo_apply', body, f"insert into fagoo_system.schema_migration(version,sha256) values('{name}','{sha}');", r'\endif', 'commit;'])
    if initialize_standalone:
        lines.append((ROOT / 'infra/database/standalone-defaults.sql').read_text(encoding='utf-8'))
    lines.extend(["notify pgrst, 'reload schema';", "select pg_advisory_unlock(1964102101, 1);", "select count(*) as fagoo_applied_schema_versions from fagoo_system.schema_migration;"])
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', default='private/install/.env')
    parser.add_argument('--project-name')
    parser.add_argument('--sql-only', action='store_true')
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--initialize-standalone', action='store_true', help='Apply one-time defaults only to a fresh installation before creating its administrator.')
    args = parser.parse_args()
    try:
        sql = program(ROOT / 'supabase/migrations', check_only=args.check_only, initialize_standalone=args.initialize_standalone)
        if args.sql_only:
            sys.stdout.reconfigure(encoding='utf-8', newline='\n')
            sys.stdout.write(sql)
        else:
            args.project_name = project_for(read_values(args.env_file), args.project_name)
            command = ['docker', 'compose', '--project-name', args.project_name, '--env-file', str(Path(args.env_file).resolve()), '-f', str(ROOT / 'infra/compose.yaml'), 'exec', '-T', 'db', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-']
            # Preserve LF inside dollar-quoted function bodies on every host.
            # Text-mode stdin on Windows would silently change the pinned prosrc.
            result = subprocess.run(command, input=sql.encode('utf-8'), check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode:
                raise ValueError('SCHEMA_APPLICATION_FAILED')
            print('Existing schema ledger matches this distribution.' if args.check_only else 'Public schema is current; every applied version has an unchanged ledger hash.')
    except (ValueError, OSError):
        raise SystemExit('SCHEMA_APPLICATION_FAILED: no success was declared; preserve volumes and inspect the database privately.')
