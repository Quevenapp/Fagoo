/**
 * Rebase only stock lexical parsing onto a downloaded, pinned live collector.
 * Usage: node tools/deployment/prepare-origin-stock-rebase.mjs <source.mjs> <expected-sha256> <output-dir>
 * Input/output may contain private campaign data: keep them outside version control.
 * This tool never deploys or modifies remote configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const [sourcePath, expectedHash, outputDirectory] = process.argv.slice(2);
assert.ok(sourcePath && /^[a-f0-9]{64}$/.test(expectedHash ?? '') && outputDirectory, 'Source, pinned SHA256 and output directory are required');
const original = fs.readFileSync(sourcePath, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(hash(original), expectedHash, 'Live collector source changed: review the new version before rebasing');
const base = path.resolve(outputDirectory);
let target = original;
const changes = [];
function replaceExactly(before, after, expected = 1) {
  assert.equal(target.split(before).length - 1, expected, 'Expected reviewed patch context');
  target = target.replaceAll(before, after);
  changes.push({ before, after, count: expected });
}
let module = fs.readFileSync(new URL('../../workers/origin-sync/src/stock-json.mjs', import.meta.url), 'utf8');
module = module.replace(/^import .*\r?\n/gm, '').replaceAll('export ', '')
  .replace(/\bcaptured\b/g, 'stockCaptured').replace(/\btotals\b/g, 'stockTotals').replace(/\bquantities\b/g, 'stockQuantities');
for (const name of ['stockCaptured', 'stockTotals', 'stockQuantities', 'parseStockJson', 'stockCapture']) assert.equal(original.includes(name), false);
replaceExactly('var STOCK_PATH = "/estoques/saldos";', module + '\nvar STOCK_PATH = "/estoques/saldos";');
replaceExactly('endpoint === "sales_detail" ? parseSalesPriceJson', 'endpoint === "stock_balances" ? parseStockJson : endpoint === "sales_detail" ? parseSalesPriceJson', 2);
replaceExactly('(this.#salesPriceCapture ? salesPriceEndpoint(path) : null) ??', '(path === "/estoques/saldos" ? "stock_balances" : null) ?? (this.#salesPriceCapture ? salesPriceEndpoint(path) : null) ??', 2);
replaceExactly('((value2) => Array.isArray(value2) ? `[${value2.map(canonicalStock).join(",")}]`', '((value2) => isCapturedPriceNumber(value2) ? JSON.stringify(value2) : Array.isArray(value2) ? `[${value2.map(canonicalStock).join(",")}]`');
replaceExactly('        found.set(id, { source_id: id, payload });',
  '        if (Object.hasOwn(payload, "_brufap_stock_capture")) fail4("ORIGIN_STOCK_RESPONSE_CONFLICT");\n        const evidence = stockCapture(payload);\n        found.set(id, { source_id: id, payload: evidence ? { ...payload, _brufap_stock_capture: evidence } : payload });');
replaceExactly('//# sourceMappingURL=worker-entry.js.map', '// Stock lexical rebase: original source map does not describe this patch.');

let restored = target;
for (const change of [...changes].reverse()) {
  assert.equal(restored.split(change.after).length - 1, change.count);
  restored = restored.replaceAll(change.after, change.before);
}
assert.equal(restored, original, 'Every byte outside reviewed patches remains unchanged');
const preserved = {};
for (const name of ['input', 'capacityConfig']) {
  const expression = new RegExp(`^var ${name} = .*;$`, 'm');
  const before = original.match(expression)?.[0], after = target.match(expression)?.[0];
  assert.ok(before); assert.equal(after, before); preserved[name] = hash(before);
}
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'worker-stock-rebase.mjs'), target);
// Local test copies expose the two real client implementations. Never deploy these.
const instrument = source => source + '\nexport { OriginClient, createDiagnosticClientClass, stockBatch, runSync, input, capacityConfig };\n';
fs.writeFileSync(path.join(base, 'worker-original-test.mjs'), instrument(original));
fs.writeFileSync(path.join(base, 'worker-stock-rebase-test.mjs'), instrument(target));
const manifest = { source_sha256: hash(original), target_sha256: hash(target), bytes: Buffer.byteLength(target), changed_contexts: changes.map(({ count }, i) => ({ patch: i + 1, count })), preserved_literal_hashes: preserved, byte_exact_reverse_patch: true };
fs.writeFileSync(path.join(base, 'stock-rebase-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
