import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Executes the real migration in PostgreSQL/WASM. Storage HTTP, object contents,
// and Supabase's own Storage policies are outside this local database test.
let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE storage.objects (
      bucket_id text NOT NULL REFERENCES storage.buckets(id), name text NOT NULL,
      PRIMARY KEY (bucket_id, name)
    );
  `);
  const migration = await readFile(new URL('../../supabase/migrations/202610160003_origin_backup_staging.sql', import.meta.url), 'utf8');
  await db.exec(migration);
});
after(async () => db?.close());

const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const errorIs = (message, code) => error => error.message === message && (!code || error.code === code);
const permissionDenied = error => error.code === '42501';
async function scalar(sql, args = []) {
  return (await db.query(sql, args)).rows[0].value;
}
async function asRole(role, action) {
  await db.exec(`SET ROLE ${role}`);
  try { return await action(); } finally { await db.exec('RESET ROLE'); }
}
const begin = f => asRole('service_role', () => scalar('SELECT public.origin_backup_begin($1,$2::jsonb) AS value', [f.backup, JSON.stringify(f.manifest)]));
const apply = (f, kind, records, id = sha(`${f.backup}/${kind}`)) => asRole('service_role', () => scalar(
  'SELECT public.origin_backup_apply_chunk($1,$2,$3,$4::jsonb) AS value', [f.backup, kind, id, JSON.stringify(records)]));
const finish = f => asRole('service_role', () => scalar('SELECT public.origin_backup_finish($1) AS value', [f.backup]));
const count = (f, table, kind) => scalar(`SELECT count(*)::int AS value FROM origin_backup.${table} WHERE backup_sha=$1${kind ? ' AND kind=$2' : ''}`, kind ? [f.backup, kind] : [f.backup]);
async function storeObjects(f) {
  for (const key of new Set(f.file.map(row => row.data.object_key))) {
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('origin-backups',$1) ON CONFLICT DO NOTHING", [key]);
  }
}
function fixture(label, issues = false) {
  const backup = sha(`${label}/original`);
  const xmlHash = sha(`${label}/xml`);
  const ids = ['original', 'csv', 'xml'].map(kind => sha(`${label}/file/${kind}`));
  const object = (hash, size, extension) => ({ sha256: hash, size, object_sha256: hash, object_size: size,
    object_key: `objects/${hash}.${extension}`, storage_representation: 'object' });
  const file = [
    { file_id: ids[0], record_no: 0, data: { kind: 'original', ...object(backup, 300, 'zip') } },
    { file_id: ids[1], record_no: 0, data: { kind: 'csv', ...object(backup, 300, 'zip'),
      sha256: sha(`${label}/csv`), size: 100, storage_representation: 'container_original' } },
    { file_id: ids[2], record_no: 0, data: { kind: 'xml', ...object(xmlHash, 200, 'xml') } },
  ];
  const csv = [1, 2].map(record_no => ({ file_id: ids[1], record_no,
    data: { entity: 'products', source_id: '0001', payload: { ID: '0001', Valor: '001,20', Vazio: '' } } }));
  const xml = [{ file_id: ids[2], record_no: 0, data: { kind: 'invoice', model: '65',
    validation: 'structural_only', signature_verified: false, xsd_validated: false } }];
  const issue = issues ? [{ file_id: ids[2], record_no: 1, data: { code: 'INVOICE_PROTOCOL_ABSENT', severity: 'quarantine' } }] : [];
  return { backup, file, csv, xml, issue, manifest: { format_version: 1, source_sha256: backup,
    source_size: 300, object_count: 2, operational_effects: false,
    counts: { file: file.length, csv: csv.length, xml: xml.length, issue: issue.length } } };
}
async function stage(f) {
  await begin(f);
  for (const kind of ['file', 'csv', 'xml', 'issue']) if (f[kind].length) await apply(f, kind, f[kind]);
}

test('migration creates private bucket and RLS tables with no direct API-role grants', async () => {
  assert.deepEqual((await db.query("SELECT public,file_size_limit FROM storage.buckets WHERE id='origin-backups'")).rows,
    [{ public: false, file_size_limit: 41943040 }]);
  const tables = (await db.query("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='origin_backup' AND relkind='r' ORDER BY relname")).rows;
  assert.deepEqual(tables.map(row => row.relname), ['batch', 'chunk', 'record']);
  assert.ok(tables.every(row => row.relrowsecurity));
  assert.equal(await scalar("SELECT count(*)::int AS value FROM pg_policies WHERE schemaname='origin_backup'"), 0);
  const signatures = ['origin_backup_begin(text,jsonb)', 'origin_backup_apply_chunk(text,text,text,jsonb)', 'origin_backup_finish(text)'];
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const table of tables) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(await scalar('SELECT has_table_privilege($1,$2,$3) AS value', [role, `origin_backup.${table.relname}`, privilege]), false);
    }
    for (const signature of signatures) {
      assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, `public.${signature}`]), role === 'service_role');
    }
    await asRole(role, async () => {
      for (const table of tables) await assert.rejects(() => db.query(`SELECT * FROM origin_backup.${table.relname}`), permissionDenied);
      if (role !== 'service_role') {
        const f = fixture(`denied-${role}`);
        await assert.rejects(() => scalar('SELECT public.origin_backup_begin($1,$2::jsonb) AS value', [f.backup, JSON.stringify(f.manifest)]), permissionDenied);
        await assert.rejects(() => scalar("SELECT public.origin_backup_apply_chunk($1,'file',$2,'[]'::jsonb) AS value", [f.backup, sha('denied')]), permissionDenied);
        await assert.rejects(() => scalar('SELECT public.origin_backup_finish($1) AS value', [f.backup]), permissionDenied);
      }
    });
  }
});

test('service RPC lifecycle preserves text and duplicate CSV positions; all replay is idempotent', async () => {
  const f = fixture('lifecycle');
  assert.deepEqual(await begin(f), { status: 'uploading', replayed: false });
  assert.deepEqual(await begin(f), { status: 'uploading', replayed: true });
  for (const kind of ['file', 'csv', 'xml']) {
    assert.deepEqual(await apply(f, kind, f[kind]), { replayed: false, records: f[kind].length, inserted: f[kind].length });
    assert.deepEqual(await apply(f, kind, f[kind]), { replayed: true, records: f[kind].length });
  }
  assert.equal(await count(f, 'record', 'csv'), 2);
  assert.deepEqual(await scalar("SELECT data->'payload' AS value FROM origin_backup.record WHERE backup_sha=$1 AND kind='csv' AND record_no=1", [f.backup]), f.csv[0].data.payload);
  await storeObjects(f);
  assert.deepEqual(await finish(f), { status: 'stored', operational_effects: false });
  const timestamp = await scalar('SELECT finished_at::text AS value FROM origin_backup.batch WHERE backup_sha=$1', [f.backup]);
  assert.deepEqual(await finish(f), { status: 'stored', operational_effects: false });
  assert.equal(await scalar('SELECT finished_at::text AS value FROM origin_backup.batch WHERE backup_sha=$1', [f.backup]), timestamp);
  assert.deepEqual(await begin(f), { status: 'stored', replayed: true });
  assert.equal((await apply(f, 'csv', f.csv)).replayed, true);
  await assert.rejects(() => apply(f, 'csv', f.csv, sha('new-after-finish')), errorIs('backup_already_finished'));
  assert.equal(await count(f, 'chunk'), 3);
  assert.equal(await count(f, 'record'), 6);
});

test('manifest, chunk and source-position conflicts never overwrite existing evidence', async () => {
  const f = fixture('conflicts');
  await stage(f);
  const changedManifest = clone(f);
  changedManifest.manifest.source_size += 1;
  await assert.rejects(() => begin(changedManifest), errorIs('immutable_backup_manifest_conflict', '22023'));
  const changedRows = clone(f.csv);
  changedRows[0].data.payload.Valor = '999,99';
  await assert.rejects(() => apply(f, 'csv', changedRows), errorIs('immutable_backup_chunk_conflict', '22023'));
  await assert.rejects(() => apply(f, 'csv', changedRows, sha('different-chunk')), errorIs('immutable_backup_record_conflict', '22023'));
  assert.equal(await scalar("SELECT data->'payload'->>'Valor' AS value FROM origin_backup.record WHERE backup_sha=$1 AND kind='csv' AND record_no=1", [f.backup]), '001,20');
  assert.equal(await count(f, 'chunk'), 3);
});

test('non-string CSV values roll back every record in the rejected chunk', async () => {
  const f = fixture('csv-text');
  await begin(f);
  await apply(f, 'file', f.file);
  for (const value of [12.5, null, true, [], { nested: 'text' }]) {
    const rows = clone(f.csv);
    rows[1].data.payload.Valor = value;
    await assert.rejects(() => apply(f, 'csv', rows), errorIs('backup_csv_values_must_remain_text', '22023'));
    assert.equal(await count(f, 'record', 'csv'), 0);
    assert.equal(await count(f, 'chunk'), 1);
  }
  assert.equal((await apply(f, 'csv', f.csv)).inserted, 2);
});

test('missing source file, incomplete record counts and absent Storage objects block completion', async () => {
  const f = fixture('missing');
  await begin(f);
  await assert.rejects(() => apply(f, 'csv', f.csv), errorIs('backup_source_file_missing'));
  await assert.rejects(() => finish(f), errorIs('backup_expected_count_mismatch'));
  await stage(f);
  await assert.rejects(() => finish(f), errorIs('backup_storage_object_missing'));
  assert.equal(await scalar('SELECT status AS value FROM origin_backup.batch WHERE backup_sha=$1', [f.backup]), 'uploading');
  await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES ('origin-backups',$1)", [f.file[0].data.object_key]);
  await assert.rejects(() => finish(f), errorIs('backup_storage_object_missing'));
  await storeObjects(f);
  assert.equal((await finish(f)).status, 'stored');
});

test('invalid object references, excess counts and false XML verification claims fail atomically', async () => {
  const f = fixture('invalid-data');
  await begin(f);
  for (const mutate of [
    row => { row.data.object_key = `objects/${sha('wrong')}.zip`; },
    row => { row.data.object_size = 301; },
    row => { row.data.storage_representation = 'container_original'; row.data.object_sha256 = sha('another-original'); row.data.object_key = `objects/${row.data.object_sha256}.zip`; },
  ]) {
    const rows = clone(f.file);
    mutate(rows[0]);
    await assert.rejects(() => apply(f, 'file', rows), errorIs('backup_object_reference_mismatch', '22023'));
    assert.equal(await count(f, 'record'), 0);
  }
  await apply(f, 'file', f.file);
  const excess = [...f.csv, { ...clone(f.csv[0]), record_no: 3 }];
  await assert.rejects(() => apply(f, 'csv', excess), errorIs('backup_expected_count_exceeded'));
  assert.equal(await count(f, 'record', 'csv'), 0);
  for (const field of ['signature_verified', 'xsd_validated']) {
    const rows = clone(f.xml);
    rows[0].data[field] = true;
    await assert.rejects(() => apply(f, 'xml', rows), errorIs('invalid_backup_xml_validation_claim', '22023'));
  }
  assert.equal(await count(f, 'record', 'xml'), 0);
});

test('quarantine is retained and reported without activating operational effects', async () => {
  const f = fixture('quarantine', true);
  await stage(f);
  await storeObjects(f);
  assert.deepEqual(await finish(f), { status: 'stored_with_issues', operational_effects: false });
  assert.equal(await count(f, 'record', 'issue'), 1);
  assert.deepEqual(await begin(f), { status: 'stored_with_issues', replayed: true });
});

test('a public bucket or inconsistent unique object count blocks finalization', async () => {
  const f = fixture('bucket');
  await stage(f);
  await storeObjects(f);
  await db.query("UPDATE storage.buckets SET public=true WHERE id='origin-backups'");
  try {
    await assert.rejects(() => begin(fixture('public-bucket')), errorIs('private_backup_bucket_required'));
    await assert.rejects(() => finish(f), errorIs('private_backup_bucket_required'));
  } finally {
    await db.query("UPDATE storage.buckets SET public=false WHERE id='origin-backups'");
  }
  const mismatch = fixture('object-count');
  mismatch.manifest.object_count = 3;
  await stage(mismatch);
  await storeObjects(mismatch);
  await assert.rejects(() => finish(mismatch), errorIs('backup_object_count_mismatch'));
  assert.equal((await finish(f)).status, 'stored');
});
