import { constants } from 'node:fs';
import { open, mkdir, lstat, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { need, safe, exact, hash, UUID, HASH, context, clock } from './common.mjs';
import { envelopeBytes, envelopeHash, parseEnvelope, withCredential } from './envelope.mjs';

const FORMAT = 'brufap-a1-local-store-v1';
const MAX_HEAD = 4 * 1024 * 1024;
const MAX_COMMANDS = 1000;
async function file(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    need(stat.isFile() && stat.size <= limit && (stat.mode & 0o077) === 0, 'VAULT_STORE_FILE_INVALID');
    return await handle.readFile();
  } finally { await handle?.close(); }
}
async function writeNew(path, bytes) {
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle?.close(); }
}
async function dirSync(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
function readHead(bytes, vaultId) {
  const head = JSON.parse(bytes.toString('utf8'));
  exact(head, ['format', 'vault_id', 'revision', 'selected', 'commands']);
  need(head.format === FORMAT && head.vault_id === vaultId && Number.isInteger(head.revision) && head.revision >= 0 && head.revision <= 2147483647, 'VAULT_STORE_HEAD_INVALID');
  need(Array.isArray(head.commands) && head.commands.length <= MAX_COMMANDS, 'VAULT_STORE_HEAD_INVALID');
  if (head.selected !== null) {
    exact(head.selected, ['context', 'envelope_hash']);
    need(context(head.selected.context).vault_id === vaultId && HASH.test(head.selected.envelope_hash), 'VAULT_STORE_HEAD_INVALID');
  }
  const ids = new Set();
  for (const command of head.commands) {
    exact(command, ['id', 'hash', 'receipt']);
    need(UUID.test(command.id) && !ids.has(command.id) && HASH.test(command.hash), 'VAULT_STORE_HEAD_INVALID'); ids.add(command.id);
    exact(command.receipt, ['command_id', 'action', 'revision', 'recorded_at', 'selected', 'reason', 'can_transmit']);
    need(command.receipt.command_id === command.id && ['select_offline', 'rewrap', 'disable'].includes(command.receipt.action) && command.receipt.can_transmit === false, 'VAULT_STORE_HEAD_INVALID');
  }
  return head;
}
const projectedHead = head => ({ revision: head.revision, selected: head.selected, can_transmit: false });

/** Operator-only local custody. Unix filesystem permissions are the authorization boundary.
 * The future authenticated API must not expose this store or its paths to browsers. */
export async function openLocalVault({ directory, vaultId, create = false } = {}) {
  need(typeof directory === 'string' && directory.length > 0 && UUID.test(vaultId), 'VAULT_STORE_OPTIONS_INVALID');
  const dir = resolve(directory), headPath = join(dir, 'head.json'), lockPath = join(dir, '.lock');
  if (create) {
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw safe(error, 'VAULT_STORE_UNAVAILABLE'); }
  }
  const stat = await lstat(dir);
  need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'VAULT_STORE_DIRECTORY_UNSAFE');
  async function locked(action) {
    let lock;
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { throw safe(error, error.code === 'EEXIST' ? 'VAULT_STORE_BUSY' : 'VAULT_STORE_UNAVAILABLE'); }
    try { return await action(); }
    catch (error) { throw safe(error, 'VAULT_STORE_OPERATION_FAILED'); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  async function head() { return readHead(await file(headPath, MAX_HEAD), vaultId); }
  async function persist(value) {
    const path = join(dir, `.head-${randomUUID()}.tmp`);
    try {
      const bytes = Buffer.from(JSON.stringify(value)); need(bytes.length <= MAX_HEAD, 'VAULT_STORE_HISTORY_LIMIT');
      await writeNew(path, bytes); await rename(path, headPath); await dirSync(dir);
    } finally { await unlink(path).catch(() => {}); }
  }
  if (create) await locked(async () => {
    try { await head(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeNew(headPath, Buffer.from(JSON.stringify({ format: FORMAT, vault_id: vaultId, revision: 0, selected: null, commands: [] })));
      await dirSync(dir);
    }
  });
  else await head();
  return Object.freeze({
    async status() { return locked(async () => projectedHead(await head())); },
    async command({ commandId, expectedRevision, action, envelope = null, expectedEnvelopeHash = null, reason,
      kekBytes, expectedKeyId, loader, now = new Date() } = {}) {
      need(UUID.test(commandId) && Number.isInteger(expectedRevision) && expectedRevision >= 0 && expectedRevision < 2147483647, 'VAULT_STORE_COMMAND_INVALID');
      need(['select_offline', 'rewrap', 'disable'].includes(action) && typeof reason === 'string' && reason.trim().length >= 3 && reason.length <= 240 && !/[\u0000-\u001f\u007f]/.test(reason), 'VAULT_STORE_COMMAND_INVALID');
      const recordedAt = clock(now);
      const candidate = envelope === null ? null : parseEnvelope(envelopeBytes(envelope));
      const candidateHash = candidate ? envelopeHash(candidate) : null;
      need(action === 'disable' ? candidate === null : candidate !== null, 'VAULT_STORE_COMMAND_INVALID');
      need(action === 'select_offline' ? expectedEnvelopeHash === null : typeof expectedEnvelopeHash === 'string' && HASH.test(expectedEnvelopeHash), 'VAULT_STORE_COMMAND_INVALID');
      if (candidate) need(candidate.context.vault_id === vaultId, 'VAULT_CONTEXT_MISMATCH');
      const requestHash = hash(JSON.stringify({ action, expectedRevision, candidateHash, expectedEnvelopeHash, reason }));
      return locked(async () => {
        const current = await head(), previous = current.commands.find(command => command.id === commandId);
        if (previous) {
          need(previous.hash === requestHash, 'VAULT_STORE_COMMAND_CONFLICT');
          return { receipt: previous.receipt, replayed: true, current: projectedHead(current) };
        }
        need(current.revision === expectedRevision, 'VAULT_STORE_REVISION_CONFLICT');
        need(current.commands.length < MAX_COMMANDS && current.revision < 2147483647, 'VAULT_STORE_HISTORY_LIMIT');
        if (action !== 'select_offline') need(current.selected?.envelope_hash === expectedEnvelopeHash, 'VAULT_ENVELOPE_CONFLICT');
        if (action === 'rewrap') {
          need(JSON.stringify(candidate.context) === JSON.stringify(current.selected.context), 'VAULT_CONTEXT_MISMATCH');
          const old = parseEnvelope(await file(join(dir, `${current.selected.envelope_hash}.json`), 1500000));
          need(envelopeHash(old) === current.selected.envelope_hash && old.key_id !== candidate.key_id &&
            JSON.stringify(old.metadata) === JSON.stringify(candidate.metadata) && JSON.stringify(old.payload) === JSON.stringify(candidate.payload), 'VAULT_REWRAP_CONTEXT_INVALID');
        }
        if (action === 'select_offline') {
          need(!current.commands.some(command => command.receipt.selected?.context.credential_id === candidate.context.credential_id), 'VAULT_CREDENTIAL_ALREADY_REGISTERED');
        }
        if (candidate) {
          // No selectable credential can bypass live password/key/CNPJ/time validation.
          await withCredential({ envelope: candidate, expectedContext: candidate.context, kekBytes, expectedKeyId, loader, now }, () => undefined);
          const objectPath = join(dir, `${candidateHash}.json`), bytes = envelopeBytes(candidate);
          try { await writeNew(objectPath, bytes); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            need((await file(objectPath, 1500000)).equals(bytes), 'VAULT_OBJECT_CONFLICT');
          }
        }
        const selected = candidate ? { context: candidate.context, envelope_hash: candidateHash } : null;
        const receipt = { command_id: commandId, action, revision: current.revision + 1, recorded_at: recordedAt, selected, reason, can_transmit: false };
        const next = { ...current, revision: receipt.revision, selected, commands: [...current.commands, { id: commandId, hash: requestHash, receipt }] };
        await persist(next);
        return { receipt, replayed: false, current: projectedHead(next) };
      });
    },
    async use({ expectedRevision, expectedContext, kekBytes, expectedKeyId, loader, now = new Date() } = {}, action) {
      const ctx = context(expectedContext);
      return locked(async () => {
        const current = await head();
        need(current.revision === expectedRevision && current.selected, 'VAULT_STORE_REVISION_CONFLICT');
        need(JSON.stringify(ctx) === JSON.stringify(current.selected.context), 'VAULT_CONTEXT_MISMATCH');
        const envelope = parseEnvelope(await file(join(dir, `${current.selected.envelope_hash}.json`), 1500000));
        need(envelopeHash(envelope) === current.selected.envelope_hash, 'VAULT_OBJECT_CONFLICT');
        // Hold the local exclusive lock until the trusted offline operation finishes:
        // disable/rotation cannot acknowledge while that operation is still executing.
        return withCredential({ envelope, expectedContext: ctx, kekBytes, expectedKeyId, loader, now }, action);
      });
    },
  });
}
