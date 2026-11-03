/** Rebase service lexical parsing onto the pinned live collector without changing campaign configuration.
 * node tools/deployment/prepare-origin-service-rebase.mjs <source> <sha256> <ignored-output-dir>
 * This creates files only; deployment requires the separate reviewed publication step.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const [sourcePath, expectedHash, outputDirectory] = process.argv.slice(2);
assert.ok(sourcePath && /^[a-f0-9]{64}$/.test(expectedHash ?? '') && outputDirectory);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const original = fs.readFileSync(sourcePath, 'utf8');
assert.equal(hash(original), expectedHash, 'Live collector changed; inspect it before rebasing');
let target = original;
const changes = [];
function replaceExactly(before, after, count = 1) {
  assert.equal(target.split(before).length - 1, count, 'Expected reviewed patch context');
  target = target.replaceAll(before, after); changes.push({ before, after, count });
}
const module = fs.readFileSync(new URL('../../workers/origin-sync/src/service-json.mjs', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '').replaceAll('export ', '');
for (const name of ['SERVICE_CAPTURE_PROFILE', 'serviceTotals', 'serviceAmounts', 'serviceEndpoint', 'parseServiceJson']) assert.equal(original.includes(name), false);
replaceExactly('var STOCK_PATH = "/estoques/saldos";', module + '\nvar STOCK_PATH = "/estoques/saldos";');
replaceExactly('endpoint === "stock_balances" ? parseStockJson', 'endpoint === "service_detail" ? parseServiceJson : endpoint === "stock_balances" ? parseStockJson', 2);
replaceExactly('(path === "/estoques/saldos" ? "stock_balances" : null) ??', 'serviceEndpoint(path) ?? (path === "/estoques/saldos" ? "stock_balances" : null) ??', 2);
let restored = target;
for (const change of [...changes].reverse()) {
  assert.equal(restored.split(change.after).length - 1, change.count);
  restored = restored.replaceAll(change.after, change.before);
}
assert.equal(restored, original, 'Unreviewed source bytes changed');
const preserved = {};
for (const name of ['input', 'capacityConfig']) {
  const expression = new RegExp(`^var ${name} = .*;$`, 'm');
  const before = original.match(expression)?.[0], after = target.match(expression)?.[0];
  assert.ok(before); assert.equal(before, after); preserved[name] = hash(before);
}
const base = path.resolve(outputDirectory); fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'worker-service-rebase.mjs'), target);
const instrument = source => source + '\nexport { OriginClient, createDiagnosticClientClass, syncPage, RESOURCES, input, capacityConfig };\n';
fs.writeFileSync(path.join(base, 'worker-before-test.mjs'), instrument(original));
fs.writeFileSync(path.join(base, 'worker-service-rebase-test.mjs'), instrument(target));
const manifest = { source_sha256: hash(original), target_sha256: hash(target), bytes: Buffer.byteLength(target), changed_contexts: changes.map(({ count }, i) => ({ patch: i + 1, count })), preserved_literal_hashes: preserved, byte_exact_reverse_patch: true };
fs.writeFileSync(path.join(base, 'service-rebase-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
