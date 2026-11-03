import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; import { build } from 'esbuild';
import { createMovementPeriodFixture, movementPeriodIds as ids } from '../src/qa/finance-movement-period-fixture.ts';
import { captureFinanceMovementQuery, financeMovementPath, financeMovementPage } from '../src/lib/finance-movement-period.ts';
import { inspectBuildFile } from '../../../tools/qa/check-erp-build.mjs';
test('QA uses real query/page bind, inclusive dates and pagination; no mutation port is accepted', async () => {
  const f = createMovementPeriodFixture(), other = createMovementPeriodFixture(); f.items[0].note = 'Changed'; assert.notEqual(other.items[0].note, 'Changed');
  const q = captureFinanceMovementQuery({ accountId: ids.account, from: '2026-10-17', to: '2026-10-17', after: null });
  const page = financeMovementPage(await f.controller.finance(financeMovementPath(q), { method: 'GET' }), q);
  assert.equal(page.items.length, 15); assert.ok(page.items.every(x => x.posted_on === '2026-10-17')); assert.equal(page.has_more, false);
  for (const options of [{ method: 'POST' }, { method: 'PATCH' }, { body: {} }]) await assert.rejects(f.controller.finance(financeMovementPath(q), options)); assert.equal(f.calls.length, 1);
});
test('local QA bundles but QA sources are excluded from production artifacts', async () => {
  const result = await build({ entryPoints: ['apps/erp/src/qa/finance-movement-period-main.tsx'], bundle: true, write: false, outdir: '/unused', format: 'esm', platform: 'browser', loader: { '.css': 'css' }, define: { 'import.meta.env.DEV': 'true' }, logLevel: 'silent' });
  assert.ok(result.outputFiles.length >= 2); assert.match(result.outputFiles.find(f => f.path.endsWith('.js')).text, /QA_SYNTHETIC_FINANCE_MOVEMENT_PERIOD/);
  for (const path of ['../finance-movement-period-qa.html', '../src/qa/finance-movement-period-main.tsx', '../src/qa/finance-movement-period-fixture.ts']) assert.ok(inspectBuildFile(path, await readFile(new URL(path, import.meta.url))).failures.includes('qa_marker'));
});
