import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
export function contentHash(bytes) {
  let canonical = bytes;
  try { canonical = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replaceAll('\r\n', '\n'); } catch { /* Preserve binary bytes, including UTF-8 BOMs. */ }
  return createHash('sha256').update(canonical).digest('hex');
}
const baseline = JSON.parse(await readFile(new URL('baseline.json', import.meta.url), 'utf8'));
const changes = JSON.parse(await readFile(new URL('changes.json', import.meta.url), 'utf8'));
const failures = [], seen = new Set(); let unchanged = 0, reviewed = 0;
for (const entry of baseline.files) {
  if (seen.has(entry.path) || entry.path.startsWith('/') || entry.path.split('/').includes('..')) throw Error('REFERENCE_PATH_INVALID');
  seen.add(entry.path);
  let hash;
  try { hash = contentHash(await readFile(new URL(entry.path, root))); }
  catch { failures.push({ file: entry.path, reason: 'missing' }); continue; }
  if (hash === entry.normalized_sha256) unchanged++;
  else if (changes.files[entry.path]?.sha256 === hash && changes.files[entry.path]?.reason) reviewed++;
  else failures.push({ file: entry.path, reason: 'unrecorded_change' });
}
console.log(JSON.stringify({ source_commit: baseline.source_commit, reference_files: seen.size, unchanged, reviewed, failures,
  scope: 'File presence and recorded source changes only; this is not proof of behavioral parity or a completed data migration.' }, null, 2));
if (failures.length) process.exitCode = 1;
