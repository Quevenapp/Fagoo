import test from 'node:test';
import assert from 'node:assert/strict';
import { planBatch, runBatch, summarizeBatch, batchSummaryText } from '../src/lib/origin-batch.ts';
import { mountComponent } from './helpers/component-recovery-harness.mjs';

const items = [{ id: 'a', label: 'PV-1', open: true }, { id: 'b', label: 'PV-2', open: false }, { id: 'c', label: 'PV-3', open: true }, { id: 'd', label: 'PV-4', open: true }];

test('plan separates eligible items from skipped ones with the reason', () => {
  const plan = planBatch(items, item => item.open ? null : 'Já atendido.');
  assert.deepEqual(plan.eligible.map(item => item.id), ['a', 'c', 'd']);
  assert.deepEqual(plan.skipped, [{ id: 'b', label: 'PV-2', outcome: 'skipped', message: 'Já atendido.' }]);
});

test('run keeps going after a failure, reports uncertain outcomes and summarizes per item', async () => {
  const plan = planBatch(items, item => item.open ? null : 'Já atendido.');
  const seen = [], progress = [];
  const results = await runBatch(plan, async item => {
    seen.push(item.id);
    if (item.id === 'c') throw new Error('Versão desatualizada.');
    if (item.id === 'd') return { uncertain: true };
  }, { onProgress: partial => progress.push(partial.length) });
  assert.deepEqual(seen, ['a', 'c', 'd'], 'runs sequentially, in order, never skipping after a failure');
  assert.deepEqual(results.map(result => [result.id, result.outcome]), [['b', 'skipped'], ['a', 'ok'], ['c', 'failed'], ['d', 'uncertain']]);
  assert.equal(results[2].message, 'Versão desatualizada.');
  assert.match(results[3].message, /Confira o registro/);
  assert.deepEqual(progress, [2, 3, 4]);
  const summary = summarizeBatch(results);
  assert.deepEqual(summary, { total: 4, ok: 1, failed: 1, skipped: 1, uncertain: 1 });
  assert.equal(batchSummaryText(summary), '1 concluído · 1 com falha · 1 a conferir · 1 ignorado');
});

test('abort stops before the next item and marks the rest as skipped', async () => {
  const controller = new AbortController();
  const results = await runBatch(planBatch(items, () => null), async item => { if (item.id === 'b') controller.abort(); }, { signal: controller.signal });
  assert.deepEqual(results.map(result => result.outcome), ['ok', 'ok', 'skipped', 'skipped']);
});

test('batch dialog previews, runs only after confirmation and shows each result', async () => {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const plan = planBatch(items, item => item.open ? null : 'Já atendido.');
  const ran = []; let closed;
  const view = await mountComponent('BatchDialog.tsx', { title: 'Alterar situação', plan, confirmLabel: 'Alterar 3 pedidos', run: async item => { ran.push(item.id); if (item.id === 'c') throw new Error('Sem permissão.'); }, onClose: results => { closed = results; } }, { componentName: 'BatchDialog', expandChildren: ['Modal'] });
  try {
    assert.match(view.text(), /3 registros serão processados, 1 será ignorado/);
    assert.match(view.text(), /PV-2.*Ignorado.*Já atendido/s);
    assert.deepEqual(ran, [], 'nothing runs before confirmation');
    await view.click('Alterar 3 pedidos'); await view.flush();
    assert.deepEqual(ran, ['a', 'c', 'd']);
    assert.match(view.text(), /2 concluídos · 1 com falha · 1 ignorado/);
    assert.match(view.text(), /PV-3.*Falhou.*Sem permissão/s);
    await view.click('Fechar');
    assert.deepEqual(closed.map(result => result.outcome), ['skipped', 'ok', 'failed', 'ok']);
  } finally { view.unmount(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
