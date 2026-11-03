import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUCKETS, inspectStorageInventory, copyPrivateStorageSnapshot } from './private-storage-snapshot.mjs';
import { prepareStorageIncrementalSelection } from './private-storage-incremental.mjs';
const PROJECT='synthetic-project';

const sha = value => createHash('sha256').update(value).digest('hex');
const raw = value => Buffer.from(JSON.stringify(value));
const stamp = '2026-10-17T06:00:00.000Z';
function inventory(payloads = ['old', 'keep']) {
  return { profile: 'brufap-private-storage-inventory-v1', project: PROJECT,
    snapshot_id: '11111111-1111-4111-8111-111111111111', observed_at: stamp,
    read_only: true, total_objects: payloads.length, truncated: false, unknown_private_bucket_count: 0,
    buckets: Object.entries(BUCKETS).map(([id, max_bytes]) => ({ id, present: true, public: false, max_bytes })),
    objects: payloads.map(payload => ({ bucket: 'origin-fiscal-xml', key: `objects/${sha(payload)}.xml`, size_bytes: Buffer.byteLength(payload), updated_at: stamp,
      metadata: { mime_type: 'application/xml', etag: null, cache_control: '3600' }, expected_sha256: sha(payload), hash_basis: 'content_addressed_path', issues: [] })),
    database_restore_verified: false, vault_recovery_verified: false, storage_bytes_snapshot_verified: false };
}
function options(base = inventory(), latest = inventory()) {
  const baseBytes = raw(base), latestBytes = raw(latest);
  const manifest = { profile: 'brufap-private-storage-copy-v1', project: PROJECT, inventory_sha256: sha(baseBytes), snapshot_id: base.snapshot_id,
    inventory_observed_at: base.observed_at, object_count: base.objects.length, total_bytes: base.objects.reduce((sum, o) => sum + o.size_bytes, 0), with_expected_hash: base.objects.length,
    without_expected_hash: 0, unknown_private_bucket_count: 0, copy_complete: true, local_readback_verified: true, database_restore_verified: false,
    vault_recovery_verified: false, storage_bytes_snapshot_verified: false,
    objects: base.objects.map(o => ({ bucket: o.bucket, key: o.key, size_bytes: o.size_bytes, sha256: o.expected_sha256, expected_sha256: o.expected_sha256, hash_basis: o.hash_basis, blob: `${sha(JSON.stringify(o))}.blob`, receipt: `${sha(JSON.stringify(o))}.receipt.json` })) };
  const bytes = raw(manifest);
  return { baseInventoryBytes: baseBytes, baseInventorySha256: sha(baseBytes), latestInventoryBytes: latestBytes, latestInventorySha256: sha(latestBytes), baseManifestBytes: bytes, baseManifestSha256: sha(bytes) };
}
const mutateManifest = (o, fn) => { const m = JSON.parse(o.baseManifestBytes); fn(m); o.baseManifestBytes = raw(m); o.baseManifestSha256 = sha(o.baseManifestBytes); return o; };
test('incremental snapshots cannot join different projects',()=>{
 const base=inventory(),latest=inventory();latest.project='different-synthetic-project';
 assert.throws(()=>prepareStorageIncrementalSelection(options(base,latest)),/STORAGE_INCREMENTAL_PROJECT_MISMATCH/);
});

test('selects added and changed metadata, keeps deletions as observations and never changes the original inventories', () => {
  const base = inventory(['old', 'keep', 'removed']), latest = inventory(['old', 'keep', 'new']);
  latest.objects[0].metadata.cache_control = '7200'; latest.observed_at = '2026-10-17T07:00:00.000Z';
  const o = options(base, latest), prior = Buffer.from(o.latestInventoryBytes), result = prepareStorageIncrementalSelection(o);
  assert.equal(result.plan.added, 1); assert.equal(result.plan.changed, 1); assert.equal(result.plan.unchanged, 1); assert.equal(result.plan.removed, 1);
  assert.equal(result.plan.selected_objects, 2); assert.equal(result.plan.selected_bytes, 6); assert.deepEqual(o.latestInventoryBytes, prior);
  const selected = inspectStorageInventory(result.selectionBytes, result.plan.selection_sha256);
  assert.deepEqual(selected.inventory.objects.map(x => x.key), [latest.objects[0].key, latest.objects[2].key]);
  for (const name of ['copy_complete', 'local_readback_verified', 'database_restore_verified', 'vault_recovery_verified', 'storage_bytes_snapshot_verified', 'full_inventory_export', 'remote_writes', 'deletes']) assert.equal(result.plan[name], false);
  assert.equal(result.plan.requires_base_local_revalidation, true); assert.ok(Object.isFrozen(result.plan));
});

test('no-change plan is an empty explicit selection, not a false copy receipt', () => {
  const result = prepareStorageIncrementalSelection(options()); assert.equal(result.plan.selected_objects, 0); assert.equal(result.plan.unchanged, 2);
  assert.equal(inspectStorageInventory(result.selectionBytes, result.plan.selection_sha256).totalBytes, 0);
  assert.equal(result.plan.copy_complete, false);
});

test('pins all three byte inputs and rejects getters without invocation', () => {
  for (const field of ['baseInventorySha256', 'latestInventorySha256', 'baseManifestSha256']) {
    const o = options(); o[field] = '0'.repeat(64); assert.throws(() => prepareStorageIncrementalSelection(o));
  }
  let touched = false; const o = options(); Object.defineProperty(o, 'baseManifestBytes', { enumerable: true, get() { touched = true; return raw({}); } });
  assert.throws(() => prepareStorageIncrementalSelection(o), /STORAGE_INCREMENTAL_INPUT_INVALID/); assert.equal(touched, false);
});

test('refuses untrusted base manifest, omissions, duplicate references and invented blob paths', () => {
  const variants = [m => m.objects.pop(), m => m.objects[1] = m.objects[0], m => m.objects[0].blob = '../other', m => m.objects[0].receipt = 'other.json', m => m.objects[0].sha256 = '0'.repeat(64), m => m.objects[0].size_bytes++, m => m.copy_complete = false, m => m.local_readback_verified = false, m => m.database_restore_verified = true, m => m.inventory_sha256 = '0'.repeat(64), m => m.snapshot_id = '22222222-2222-4222-8222-222222222222', m => m.extra = true, m => m.objects[0].extra = true];
  for (const change of variants) assert.throws(() => prepareStorageIncrementalSelection(mutateManifest(options(), change)));
});

test('refuses reversed time, new bucket configuration and objects lacking expected digest', () => {
  const old = inventory(), latest = inventory(); latest.observed_at = '2026-10-16T06:00:00.000Z';
  assert.throws(() => prepareStorageIncrementalSelection(options(old, latest)), /STORAGE_INCREMENTAL_TIME_REVERSED/);
  latest.observed_at = stamp; latest.buckets.find(x => x.id === 'erp-attachments').present = false; latest.buckets.find(x => x.id === 'erp-attachments').public = null;
  assert.throws(() => prepareStorageIncrementalSelection(options(old, latest)), /STORAGE_INCREMENTAL_BUCKET_CHANGE/);
  const unhashed = inventory(); Object.assign(unhashed.objects[0], { expected_sha256: null, hash_basis: null, key: 'unattested/file.xml' });
  assert.throws(() => prepareStorageIncrementalSelection(options(old, unhashed)), /STORAGE_INCREMENTAL_EXPECTED_HASH_REQUIRED/);
});

test('real copy contract interoperates: revalidate base locally and copy only the explicitly selected new object', async t => {
  const root = await mkdtemp(join(tmpdir(),'fagoo-incremental-test-')); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const base = inventory(['old']), latest = inventory(['old', 'new']);
  const baseBytes = raw(base), baseDir = join(root, 'base');
  const common = { inventoryBytes: baseBytes, expectedInventorySha256: sha(baseBytes), outputDir: baseDir, downloadEnabled: true };
  const created = await copyPrivateStorageSnapshot({ ...common, readObject: async () => new Response('old') });
  const verified = await copyPrivateStorageSnapshot({ ...common, readObject: async () => { throw Error('network must not run'); } });
  assert.equal(verified.resumed, 1); assert.equal(verified.downloaded, 0);
  const o = options(base, latest); o.baseManifestBytes = await readFile(join(baseDir, 'manifest.json')); o.baseManifestSha256 = created.manifest_sha256;
  const result = prepareStorageIncrementalSelection(o); let gets = 0;
  const copied = await copyPrivateStorageSnapshot({ inventoryBytes: result.selectionBytes, expectedInventorySha256: result.plan.selection_sha256, outputDir: join(root, 'delta'), downloadEnabled: true,
    readObject: async entry => { gets++; assert.equal(entry.expected_sha256, sha('new')); return new Response('new'); } });
  assert.equal(gets, 1); assert.equal(copied.objects, 1); assert.equal(copied.complete, true); assert.equal(result.plan.copy_complete, false);
  assert.equal((await readFile(join(baseDir, 'manifest.json'))).equals(o.baseManifestBytes), true);
});
