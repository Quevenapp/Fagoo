import { createHash } from 'node:crypto';
import { inspectStorageInventory, LIMITS } from './private-storage-snapshot.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fields = ['baseInventoryBytes', 'baseInventorySha256', 'latestInventoryBytes', 'latestInventorySha256', 'baseManifestBytes', 'baseManifestSha256'];
const manifestFields = ['profile', 'project', 'inventory_sha256', 'snapshot_id', 'inventory_observed_at', 'object_count', 'total_bytes', 'with_expected_hash', 'without_expected_hash', 'unknown_private_bucket_count', 'copy_complete', 'local_readback_verified', 'database_restore_verified', 'vault_recovery_verified', 'storage_bytes_snapshot_verified', 'objects'];
const objectFields = ['bucket', 'key', 'size_bytes', 'sha256', 'expected_sha256', 'hash_basis', 'blob', 'receipt'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const need = (value, code) => { if (!value) throw new Error(code); };
const identity = entry => JSON.stringify([entry.bucket, entry.key]);
const tag = entry => sha(JSON.stringify(entry));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/**
 * Derive an explicit added/changed selection. No filesystem, credentials or network.
 * This checks manifest structure and pinned hashes, not the current local blobs.
 * The base copy must be revalidated separately before relying on the chain.
 */
export function prepareStorageIncrementalSelection(options) {
  need(closed(options, fields), 'STORAGE_INCREMENTAL_INPUT_INVALID');
  const base = inspectStorageInventory(options.baseInventoryBytes, options.baseInventorySha256);
  const latest = inspectStorageInventory(options.latestInventoryBytes, options.latestInventorySha256);
  need(base.inventory.project === latest.inventory.project, 'STORAGE_INCREMENTAL_PROJECT_MISMATCH');
  need(base.withoutExpectedHash === 0 && latest.withoutExpectedHash === 0, 'STORAGE_INCREMENTAL_EXPECTED_HASH_REQUIRED');
  need(Date.parse(latest.inventory.observed_at) >= Date.parse(base.inventory.observed_at), 'STORAGE_INCREMENTAL_TIME_REVERSED');
  // New or changed bucket configuration requires its own review, not implicit expansion.
  const bucketView = inventory => [...inventory.buckets].sort((a, b) => a.id.localeCompare(b.id));
  need(JSON.stringify(bucketView(base.inventory)) === JSON.stringify(bucketView(latest.inventory)) && base.inventory.unknown_private_bucket_count === latest.inventory.unknown_private_bucket_count, 'STORAGE_INCREMENTAL_BUCKET_CHANGE');
  need(options.baseManifestBytes instanceof Uint8Array && !(options.baseManifestBytes.buffer instanceof SharedArrayBuffer) && options.baseManifestBytes.byteLength <= LIMITS.inventoryBytes, 'STORAGE_INCREMENTAL_MANIFEST_INVALID');
  const bytes = Buffer.from(options.baseManifestBytes);
  need(typeof options.baseManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(options.baseManifestSha256) && sha(bytes) === options.baseManifestSha256, 'STORAGE_INCREMENTAL_MANIFEST_HASH');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('STORAGE_INCREMENTAL_MANIFEST_INVALID'); }
  need(closed(manifest, manifestFields), 'STORAGE_INCREMENTAL_MANIFEST_INVALID');
  need(manifest.profile === 'brufap-private-storage-copy-v1' && manifest.project === base.inventory.project && manifest.inventory_sha256 === base.inventorySha256 && manifest.snapshot_id === base.inventory.snapshot_id && manifest.inventory_observed_at === base.inventory.observed_at, 'STORAGE_INCREMENTAL_BASE_MISMATCH');
  need(manifest.object_count === base.inventory.objects.length && manifest.total_bytes === base.totalBytes && manifest.with_expected_hash === base.withExpectedHash && manifest.without_expected_hash === 0 && manifest.unknown_private_bucket_count === base.inventory.unknown_private_bucket_count, 'STORAGE_INCREMENTAL_BASE_MISMATCH');
  need(manifest.copy_complete === true && manifest.local_readback_verified === true && manifest.database_restore_verified === false && manifest.vault_recovery_verified === false && manifest.storage_bytes_snapshot_verified === false && Array.isArray(manifest.objects) && manifest.objects.length === base.inventory.objects.length, 'STORAGE_INCREMENTAL_BASE_MISMATCH');
  const old = new Map(base.inventory.objects.map(entry => [identity(entry), entry]));
  const seen = new Set();
  for (const object of manifest.objects) {
    need(closed(object, objectFields), 'STORAGE_INCREMENTAL_MANIFEST_INVALID');
    const key = identity(object), entry = old.get(key);
    need(entry && !seen.has(key), 'STORAGE_INCREMENTAL_BASE_MISMATCH');
    seen.add(key);
    const digest = tag(entry);
    need(object.size_bytes === entry.size_bytes && object.sha256 === entry.expected_sha256 && object.expected_sha256 === entry.expected_sha256 && object.hash_basis === entry.hash_basis && object.blob === `${digest}.blob` && object.receipt === `${digest}.receipt.json`, 'STORAGE_INCREMENTAL_BASE_MISMATCH');
  }
  const selected = [], current = new Set();
  let added = 0, changed = 0, unchanged = 0;
  for (const entry of latest.inventory.objects) {
    const key = identity(entry), prior = old.get(key);
    current.add(key);
    if (!prior) { added++; selected.push(entry); }
    else if (tag(prior) !== tag(entry)) { changed++; selected.push(entry); }
    else unchanged++;
  }
  const removed = [...old.keys()].filter(key => !current.has(key)).length;
  // The identifier is retained from the latest export; the exact derived hash
  // and explicit profile below distinguish a selection from the full inventory.
  const selection = { ...latest.inventory, total_objects: selected.length, objects: selected };
  const selectionBytes = Buffer.from(JSON.stringify(selection) + '\n');
  const selectionSha256 = sha(selectionBytes);
  const inspected = inspectStorageInventory(selectionBytes, selectionSha256);
  const plan = freeze({
    profile: 'brufap-private-storage-incremental-plan-v1', project: base.inventory.project,
    base_inventory_sha256: base.inventorySha256, base_manifest_sha256: options.baseManifestSha256,
    latest_inventory_sha256: latest.inventorySha256, selection_sha256: selectionSha256,
    selection_kind: 'added_or_metadata_changed', base_objects: base.inventory.objects.length,
    latest_objects: latest.inventory.objects.length, added, changed, unchanged, removed,
    selected_objects: selected.length, selected_bytes: inspected.totalBytes,
    requires_base_local_revalidation: true, full_inventory_export: false,
    copy_complete: false, local_readback_verified: false, database_restore_verified: false,
    vault_recovery_verified: false, storage_bytes_snapshot_verified: false,
    remote_writes: false, deletes: false,
  });
  return { plan, selectionBytes };
}
