import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fiscalWaveEFixture, migrationText } from './helpers/fiscal-wave-e-fixture.mjs';
import { fiscalDraftEnvelope } from '../../../apps/erp/src/lib/fiscal-drafts-model.ts';
import { fiscalReviewView } from '../../../apps/erp/src/lib/fiscal-review-model.ts';

// 202610200251 on PGlite, synthetic data only: the rascunho fiscal (emissor de homologação) of a pedido de venda whose total adds
// Total do IPI / Total ICMS ST (documentos 196, "Exibe campos IPI e ST"). Before 251 the Worker answered 502 to create and read it.
async function seed(f) {
  await f.company();
  await f.setPreference('vendas-propostas', 'propostas.exibir_ipi_st', true);
  const contact = await f.catalog('contacts', { name: 'Cliente sintético 251', person_type: 'J', document: '12345678000190', state: 'SP', city: 'São Paulo', postal_code: '01001000', street: 'Rua Sintética', number: '10', district: 'Centro' });
  const product = await f.catalog('products', { name: 'Peça sintética 251', code: 'P-251', unit: 'UN', kind: 'P', format: 'S', price: '10', ncm: '84714900' });
  const order = async extra => {
    const r = await f.call('/v1/documentos/sales_orders', 'POST', { command_id: randomUUID(), data: { date: '2026-10-20', contact_id: contact.id, discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', commercial: null,
      items: [{ product_id: product.id, description: 'Peça sintética 251', detailed_description: null, code: 'P-251', unit: 'UN', quantity: '2', unit_price: '10', discount_percent: '0' }], installments: [], ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.value)); return r.value.document;
  };
  return { contact, product, order };
}
const create = (f, document, model = '55') => f.call('/v1/rascunhos-fiscais', 'POST', { command_id: randomUUID(), source_document_id: document.id, expected_source_version: document.version, model, preparation: { operation_nature: 'Venda de mercadoria', notes: null } }, f.users.fiscal);

test('251: the draft of a pedido with Total do IPI and Total ICMS ST is created, read and reviewed (no more 502)', async () => {
  const f = await fiscalWaveEFixture();
  try {
    const { order } = await seed(f);
    const taxed = await order({ tax_ipi: '1.00', tax_icms_st: '0.50', installments: [{ due_date: '2026-11-20', amount: '21.50', method: 'Boleto' }] });
    assert.deepEqual([taxed.totals.total, taxed.totals.ipi, taxed.totals.icms_st], ['21.50', '1.00', '0.50']);
    const created = await create(f, taxed);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const s = created.value.record.snapshot;
    assert.deepEqual([s.tax_ipi, s.tax_icms_st, s.totals.ipi, s.totals.icms_st, s.totals.total, s.installments[0].amount], ['1.00', '0.50', '1.00', '0.50', '21.50', '21.50']);
    assert.equal(Object.hasOwn(s, 'legacy_taxes'), false);
    const id = created.value.record.id;
    const read = await f.call(`/v1/rascunhos-fiscais/${id}`, 'GET', undefined, f.users.fiscal);
    assert.equal(read.status, 200, JSON.stringify(read.value));
    const envelope = fiscalDraftEnvelope(read.value, id);
    assert.equal(envelope.record.snapshot.totals.ipi, '1.00');
    // The conferência flags what this homologation emitter does not build, with the same report in the browser.
    const review = await f.call(`/v1/rascunhos-fiscais/${id}/conferencia?revision=1`, 'GET', undefined, f.users.fiscal);
    assert.equal(review.status, 200, JSON.stringify(review.value));
    const view = fiscalReviewView(review.value, id, 1, envelope.record.snapshot_hash);
    assert.ok(view.report.findings.some(x => x.code === 'ORDER_TAXES_OUTSIDE_PROFILE' && x.severity === 'blocking'));
    // Nothing else changes for a pedido without taxes: no tax keys and no new finding.
    const plain = await create(f, await order({}));
    assert.equal(plain.status, 200, JSON.stringify(plain.value));
    for (const key of ['tax_ipi', 'tax_icms_st', 'legacy_taxes']) assert.equal(Object.hasOwn(plain.value.record.snapshot, key), false, key);
    assert.deepEqual(Object.keys(plain.value.record.snapshot.totals).sort(), ['discount', 'freight', 'gross', 'line_discount', 'other_expenses', 'subtotal', 'total']);
    const plainReview = await f.call(`/v1/rascunhos-fiscais/${plain.value.record.id}/conferencia?revision=1`, 'GET', undefined, f.users.fiscal);
    assert.ok(!plainReview.value.report.findings.some(x => x.code === 'ORDER_TAXES_OUTSIDE_PROFILE'));
    // Zero taxes keep the keys and add nothing.
    const zero = await create(f, await order({ tax_ipi: '0.00', tax_icms_st: '0.00' }));
    assert.equal(zero.status, 200, JSON.stringify(zero.value));
    assert.equal(zero.value.record.snapshot.totals.ipi, '0.00');
  } finally { await f.close(); }
});

test('251: a copy made before 251 (taxes only inside the total) is read as legacy_taxes, and Atualizar splits them', async () => {
  const f = await fiscalWaveEFixture({ upto: '0' });
  try {
    const { order } = await seed(f);
    const taxed = await order({ tax_ipi: '2.00', tax_icms_st: '0.25', installments: [{ due_date: '2026-11-20', amount: '22.25', method: null }] });
    // Production state (no 251) with the new Worker: the old copy drops the taxes, the Worker no longer answers 502.
    const created = await create(f, taxed);
    assert.equal(created.status, 200, JSON.stringify(created.value));
    const s = created.value.record.snapshot;
    assert.equal(s.legacy_taxes, '2.25');
    assert.equal(s.totals.total, '22.25');
    for (const key of ['tax_ipi', 'tax_icms_st']) assert.equal(Object.hasOwn(s, key), false);
    assert.doesNotThrow(() => fiscalDraftEnvelope(created.value, created.value.record.id));
    const id = created.value.record.id;
    const review = await f.call(`/v1/rascunhos-fiscais/${id}/conferencia?revision=1`, 'GET', undefined, f.users.fiscal);
    assert.equal(review.status, 200, JSON.stringify(review.value));
    assert.ok(review.value.report.findings.some(x => x.code === 'ORDER_TAXES_OUTSIDE_PROFILE'));
    // Apply 251: the stored copy and its hash never change; Atualizar takes a new copy with the split taxes.
    const before = await f.scalar('select snapshot_hash v from erp_fiscal_drafts.draft where id=$1', [id]);
    await f.db.exec(await migrationText('202610200251_fiscal_drafts_order_taxes.sql'));
    assert.equal(await f.scalar('select snapshot_hash v from erp_fiscal_drafts.draft where id=$1', [id]), before);
    assert.equal((await f.call(`/v1/rascunhos-fiscais/${id}`, 'GET', undefined, f.users.fiscal)).value.record.snapshot.legacy_taxes, '2.25');
    const refreshed = await f.call(`/v1/rascunhos-fiscais/${id}/refresh`, 'POST', { command_id: randomUUID(), expected_version: 1, expected_source_version: taxed.version }, f.users.fiscal);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value));
    const r = refreshed.value.record.snapshot;
    assert.deepEqual([r.tax_ipi, r.tax_icms_st, r.totals.ipi, r.totals.icms_st, Object.hasOwn(r, 'legacy_taxes')], ['2.00', '0.25', '2.00', '0.25', false]);
    // The revision 1 keeps the copy it had.
    assert.equal((await f.call(`/v1/rascunhos-fiscais/${id}/revisions/1`, 'GET', undefined, f.users.fiscal)).value.record.snapshot.legacy_taxes, '2.25');
  } finally { await f.close(); }
});

test('251: capture stays private, the forged split is refused and the replaced body was hash-checked', async () => {
  const f = await fiscalWaveEFixture();
  try {
    for (const role of ['anon', 'authenticated', 'public', 'service_role']) assert.equal(await f.scalar("select has_function_privilege($1,'erp_fiscal_drafts.capture(uuid)','EXECUTE') v", [role]), false, role);
    const { order } = await seed(f);
    const created = await create(f, await order({ tax_ipi: '1.00', tax_icms_st: '0.00' }));
    const id = created.value.record.id;
    // A stored copy whose split does not add up to its total is a forged answer (502), never shown.
    await f.db.exec('alter table erp_fiscal_drafts.draft disable trigger user');
    await f.db.query("update erp_fiscal_drafts.draft set snapshot=jsonb_set(snapshot,'{tax_ipi}','\"3.00\"') where id=$1", [id]);
    await f.db.exec('alter table erp_fiscal_drafts.draft enable trigger user');
    assert.equal((await f.call(`/v1/rascunhos-fiscais/${id}`, 'GET', undefined, f.users.fiscal)).status, 502);
    const block = (await migrationText('202610200251_fiscal_drafts_order_taxes.sql')).match(/do \$\$declare r record;begin[\s\S]*?end\$\$;/)[0];
    await assert.rejects(() => f.db.exec(block), error => error.message === 'fiscal_drafts_251_previous_definition_changed');
  } finally { await f.close(); }
});
