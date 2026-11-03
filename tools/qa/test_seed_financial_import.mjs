import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { seedFinancialImport } from './seed-financial-import.mjs';

let db; const uid = randomUUID(), viewer = randomUUID();
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
  for (const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0020_cutover_readiness','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import']) await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${suffix}.sql`, import.meta.url), 'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)', [uid, viewer]);
  await db.query("insert into erp_access.membership(user_id,role) values($1,'admin'),($2,'consulta')", [uid, viewer]);
});
after(async () => db?.close());

test('039 QA seed rejects nonembedded/nonadmin inputs without partial fixtures', async () => {
  await assert.rejects(() => seedFinancialImport({}, { uid }), /embedded PGlite/);
  await assert.rejects(() => seedFinancialImport(db, { uid: viewer }), /active local admin/);
  assert.equal(await scalar('select count(*)::int value from origin_sync.raw_record'), 0);
});

test('039 QA seed supplies three eligible and three blocked sources without titles, then refuses replay', async () => {
  const seeded = await seedFinancialImport(db, { uid });
  assert.equal(seeded.eligible_sources.length, 3);
  assert.equal(seeded.eligible_sources.filter(item => item.entity === 'receivables').length, 2);
  for (const fixture of seeded.fixtures) {
    const item = await scalar("select jsonb_build_object('source_id',source_id,'source_hash',version_hash,'source_version',version::text,'source_seen_at',last_seen_at,'category_id',null,'category_version',null) value from origin_sync.raw_record where entity=$1 and source_id=$2", [fixture.entity, fixture.id]);
    const review = await scalar('select public.erp_origin_financial_import_preview($1,$2,$3::jsonb,true) value', [uid, fixture.entity, JSON.stringify([item])]);
    assert.equal(review.can_apply, fixture.expected === 'eligible', JSON.stringify(review));
    const expected = { partial: 'STATUS_NOT_OPEN', expired: 'REFRESH_EXPIRED', unmatched_contact: 'CONTACT_NOT_READY' }[fixture.expected];
    if (expected) assert.ok(review.items[0].blockers.includes(expected));
  }
  const snapshot = await scalar("select jsonb_build_object('raw',(select count(*) from origin_sync.raw_record),'contacts',(select count(*) from erp_catalog.record),'attempts',(select count(*) from origin_finance_refresh.attempt),'commands',(select count(*) from erp_catalog.command)) value");
  await assert.rejects(() => seedFinancialImport(db, { uid }), /already exists/);
  assert.deepEqual(await scalar("select jsonb_build_object('raw',(select count(*) from origin_sync.raw_record),'contacts',(select count(*) from erp_catalog.record),'attempts',(select count(*) from origin_finance_refresh.attempt),'commands',(select count(*) from erp_catalog.command)) value"), snapshot);
  for (const table of ['title', 'settlement', 'movement', 'command', 'origin_import_origin']) assert.equal(await scalar(`select count(*)::int value from erp_finance.${table}`), 0);
});
