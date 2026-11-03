// Execute the actual bootstrap transaction against PostgreSQL in memory. The
// fixture supplies only the table contracts it inspects; it seeds no ERP data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const sql = await readFile(new URL('./database/standalone-defaults.sql', import.meta.url), 'utf8');
const guarded = ['erp_access.membership', 'erp_catalog.record', 'erp_documents.document',
  'erp_finance.account', 'erp_finance.title', 'erp_finance.movement', 'erp_stock.balance',
  'erp_stock.movement', 'erp_sync.link', 'erp_sync.inbox', 'erp_sync.outbox', 'erp_sync.run'];

async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    ${[...new Set(['fagoo_system', ...guarded.map(name => name.split('.')[0])])].map(name => `create schema ${name};`).join('\n')}
    create table fagoo_system.schema_migration(version text primary key);
    insert into fagoo_system.schema_migration values('synthetic-verified-ledger');
    ${guarded.map(name => `create table ${name}(id integer);`).join('\n')}
    create table erp_sync.settings(singleton boolean primary key default true check(singleton),
      enabled boolean not null default true, actor_id uuid, default_account_id uuid,
      updated_at timestamptz not null default clock_timestamp());
    insert into erp_sync.settings(singleton) values(true);`);
  return db;
}
const state = async db => (await db.query('select * from erp_sync.settings')).rows[0];

test('fresh defaults disable capture once; replay preserves later explicit configuration and data', async () => {
  const db = await fixture();
  try {
    await db.exec(sql);
    assert.equal((await state(db)).enabled, false);
    assert.equal((await db.query('select count(*)::integer n from fagoo_system.install_defaults')).rows[0].n, 1);
    const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.exec(`update erp_sync.settings set enabled=true, actor_id='${actor}', updated_at='2026-01-01T00:00:00Z';
      insert into erp_access.membership values(1); insert into erp_catalog.record values(1);`);
    const before = await state(db);
    await db.exec(sql);
    assert.deepEqual(await state(db), before);
    assert.equal((await db.query('select count(*)::integer n from erp_catalog.record')).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::integer n from fagoo_system.schema_migration where version='synthetic-verified-ledger'")).rows[0].n, 1);
  } finally { await db.close(); }
});

test('an existing initialized installation without the new marker is rejected without resetting settings', async () => {
  const db = await fixture();
  try {
    await db.exec('create table fagoo_system.install_state(id integer); insert into fagoo_system.install_state values(1);');
    const before = await state(db);
    await assert.rejects(db.exec(sql), /FAGOO_STANDALONE_ALREADY_INITIALIZED/);
    await db.exec('rollback;');
    assert.deepEqual(await state(db), before);
    assert.equal((await db.query("select to_regclass('fagoo_system.install_defaults') name")).rows[0].name, null);
  } finally { await db.close(); }
});

test('members, commercial data, queues or configured actors prevent fresh defaults atomically', async () => {
  const db = await fixture();
  try {
    for (const name of guarded) {
      await db.exec(`insert into ${name} values(1);`);
      await assert.rejects(db.exec(sql), /FAGOO_STANDALONE_REQUIRES_EMPTY_INSTALLATION/, name);
      await db.exec('rollback;');
      assert.equal((await state(db)).enabled, true, name);
      assert.equal((await db.query(`select count(*)::integer n from ${name}`)).rows[0].n, 1, name);
      await db.exec(`delete from ${name};`);
    }
    for (const field of ['actor_id', 'default_account_id']) {
      await db.exec(`update erp_sync.settings set ${field}='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';`);
      await assert.rejects(db.exec(sql), /FAGOO_STANDALONE_REQUIRES_EMPTY_INSTALLATION/, field);
      await db.exec('rollback;');
      assert.equal((await state(db)).enabled, true);
      await db.exec(`update erp_sync.settings set ${field}=null;`);
    }
  } finally { await db.close(); }
});

test('missing settings or schema ledger cannot be accepted as a successful fresh installation', async () => {
  const db = await fixture();
  try {
    await db.exec('delete from fagoo_system.schema_migration;');
    await assert.rejects(db.exec(sql), /FAGOO_STANDALONE_SCHEMA_REQUIRED/);
    await db.exec('rollback; insert into fagoo_system.schema_migration values(\'synthetic-verified-ledger\'); delete from erp_sync.settings;');
    await assert.rejects(db.exec(sql), /FAGOO_STANDALONE_SYNC_SETTINGS_REQUIRED/);
    await db.exec('rollback;');
    assert.equal((await db.query("select to_regclass('fagoo_system.install_defaults') name")).rows[0].name, null);
  } finally { await db.close(); }
});
