import { mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createItau109PrintPreview } from '../src/index.mjs';
import { fixture } from '../test/fixtures.mjs';

// Explicit local fixture export only. No browser launch, server or real input.
if (process.argv.length !== 3) throw new Error('USAGE: node render-fixtures.mjs OUTPUT_DIRECTORY');
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const dense of [false, true]) {
  const preview = await createItau109PrintPreview(fixture({ dense }));
  const name = dense ? 'dense' : 'standard';
  const file = await open(join(directory, name + '.html'), 'wx', 0o600);
  try { await file.writeFile(preview.html); await file.sync(); } finally { await file.close(); }
  process.stdout.write(JSON.stringify({ fixture: name, htmlHash: preview.htmlHash, sizeBytes: preview.sizeBytes }) + '\n');
}
