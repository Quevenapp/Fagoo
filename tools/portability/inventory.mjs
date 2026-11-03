import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_OUTPUT = 64 * 1024 * 1024;
export const inventorySql = () => readFile(new URL('./inventory.sql', import.meta.url), 'utf8');

export function parseInventory(output) {
  const records = output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (records.length < 2 || records[0].kind !== 'manifest' || records[0].formatVersion !== 1 || records.at(-1).kind !== 'complete' || records.at(-1).readOnly !== true) throw new Error('INVENTORY_INCOMPLETE');
  const [header] = records;
  if (header.consistency?.readOnly !== true || header.consistency?.isolation !== 'repeatable read' || header.consistency?.exactCounts !== true) throw new Error('INVENTORY_NOT_CONSISTENT');
  const manifest = { ...header, relations: [], routines: [], sequences: [], types: [], counts: [], storage: null, migrationVersions: null, limitations: ['No business rows or object bytes exported.', 'No identity, balance, fiscal or cryptographic reconciliation performed.', 'Catalog fingerprints are change detectors, not integrity proofs.'] };
  delete manifest.kind;
  const groups = { relation: 'relations', routine: 'routines', sequence: 'sequences', type: 'types', count: 'counts' };
  for (const record of records.slice(1, -1)) {
    const { kind, ...value } = record;
    if (groups[kind]) manifest[groups[kind]].push(value);
    else if (kind === 'storageSummary' && manifest.storage === null) manifest.storage = value;
    else if (kind === 'migrationVersions' && manifest.migrationVersions === null) manifest.migrationVersions = value;
    else throw new Error('INVENTORY_RECORD_INVALID');
  }
  const counts = new Map();
  for (const entry of manifest.counts) {
    const key = JSON.stringify([entry.schema, entry.name]);
    if (typeof entry.rows !== 'string' || !/^(0|[1-9][0-9]*)$/.test(entry.rows) || counts.has(key)) throw new Error('INVENTORY_COUNT_INVALID');
    counts.set(key, entry.rows);
  }
  for (const relation of manifest.relations) if (['r', 'p'].includes(relation.relationKind) && !counts.has(JSON.stringify([relation.schema, relation.name]))) throw new Error('INVENTORY_COUNT_MISSING');
  if (manifest.storage === null) throw new Error('INVENTORY_STORAGE_MISSING');
  if (manifest.migrationVersions === null) throw new Error('INVENTORY_MIGRATIONS_MISSING');
  return manifest;
}

export async function collectInventory({ env = process.env, spawnImpl = spawn } = {}) {
  // Connection information stays in libpq environment/service files, never argv or output.
  if (!env.PGSERVICE && !(env.PGHOST && env.PGDATABASE && env.PGUSER)) throw new Error('CONNECTION_ENV_REQUIRED');
  const sql = await inventorySql();
  return new Promise((resolve, reject) => {
    const child = spawnImpl('psql', ['-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      env: { ...env, PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'fagoo-portability-readonly', PGOPTIONS: `${env.PGOPTIONS || ''} -c default_transaction_read_only=on` },
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', bytes = 0, done = false;
    const fail = error => { if (!done) { done = true; clearTimeout(timeout); child.kill(); reject(error); } };
    const timeout = setTimeout(() => fail(new Error('INVENTORY_TIMEOUT')), 15 * 60 * 1000);
    child.on('error', () => fail(new Error('PSQL_START_FAILED')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_OUTPUT) fail(new Error('INVENTORY_OUTPUT_LIMIT')); else output += chunk; });
    // Do not echo libpq diagnostics: they can contain connection details or object values.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => fail(new Error('PSQL_INPUT_FAILED')));
    child.on('close', code => {
      clearTimeout(timeout);
      if (done) return;
      done = true;
      if (code !== 0) return reject(new Error('PSQL_INVENTORY_FAILED'));
      try { resolve(parseInventory(output)); } catch { reject(new Error('INVENTORY_INVALID_OR_INCOMPLETE')); }
    });
    child.stdin.end(sql);
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new Error('USAGE: node tools/portability/inventory.mjs --output PRIVATE_FILE.json');
  const inventory = await collectInventory();
  // Never overwrite a previous snapshot accidentally. POSIX mode; use private ACLs on Windows.
  await writeFile(args[1], `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return inventory;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(() => console.log('Inventário somente leitura salvo. Não é backup nem comprovação de migração.')).catch(error => { console.error(error.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : /^[A-Z_]+$/.test(error.message) ? error.message : 'INVENTORY_FAILED'); process.exitCode = 1; });
