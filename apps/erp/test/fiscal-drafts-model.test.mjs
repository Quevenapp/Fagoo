import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fiscalPreparation, fiscalCreateInput, fiscalUpdateInput, fiscalRefreshInput, fiscalArchiveInput,
  fiscalDraftEnvelope, fiscalDraftPage, fiscalRevisionPage, fiscalListParams, fiscalModelSearch, fiscalDecimal, fiscalUnitPrice } from '../src/lib/fiscal-drafts-model.ts';

const uuid = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const time = '2026-10-16T03:00:00Z';
const flags = { data_mode: 'fiscal_draft', emission_enabled: false, operational_effects: false };
const source = { id: uuid(2), kind: 'sales_orders', number: '1001', version: 3, status: 'verified', date: '2026-10-16', total: '12.34', contact_id: uuid(3), contact_name: 'Cliente sintético', created_at: time, updated_at: time };
const required = ['TAX_REVIEW_REQUIRED', 'CATALOG_SNAPSHOTS_REQUIRE_REVIEW', 'RECIPIENT_FISCAL_MAPPING_REQUIRED', 'ITEM_FISCAL_MAPPING_REQUIRED', 'PAYMENT_FISCAL_MAPPING_REQUIRED', 'FISCAL_XML_NOT_BUILT', 'XSD_NOT_VALIDATED', 'SIGNATURE_NOT_CREATED', 'TRANSPORT_UNAVAILABLE', 'HOMOLOGATION_NOT_PERFORMED'];
const fixture = () => ({ ...flags, record: {
  id: uuid(1), model: '55', environment: '2', status: 'draft', version: 1, source_document_id: source.id, source_document_version: source.version,
  snapshot_hash: 'a'.repeat(64), preparation: { operation_nature: null, notes: null }, created_at: time, updated_at: time, archived_at: null, archive_reason: null,
  snapshot: { catalog_basis: 'document_snapshot', document_id: source.id, document_version: source.version, kind: 'sales_orders', number: source.number, status: source.status, date: source.date,
    contact_id: source.contact_id, contact: { id: source.contact_id, version: 1, name: source.contact_name, person_type: null, document: null, ie: null, postal_code: null, street: null, number: null, complement: null, district: null, city: null, state: null },
    items: [{ id: uuid(4), position: 1, product_id: null, description: 'Produto sintético', code: null, unit: 'UN', quantity: '1.000000', unit_price: '12.3400', discount_percent: '0.0000', gross: '12.34', discount: '0.00', total: '12.34', product: null }],
    totals: { gross: '12.34', line_discount: '0.00', subtotal: '12.34', discount: '0.00', freight: '0.00', other_expenses: '0.00', total: '12.34' },
    discount_mode: 'amount', discount_value: '0.00', installments: [], notes: null, payment_terms: null, delivery_terms: null, company: null },
}, current: { version: 1, status: 'draft', source_document_version: source.version, source_status: source.status, identity_version: null, fiscal_version: null, source_changed: false, company_changed: false }, pending: [...required] });
const summary = () => { const record = fixture().record; const { snapshot, snapshot_hash, preparation, archived_at, archive_reason, ...rest } = record; return { ...rest, order_number: source.number, contact_name: source.contact_name, total: source.total }; };

test('preparation preserves explicit fields, length limits and multiline notes without choosing tax settings', () => {
  assert.deepEqual(fiscalPreparation(' Venda de mercadoria ', ' Conferir\ncom a contabilidade. '), { operation_nature: 'Venda de mercadoria', notes: 'Conferir\ncom a contabilidade.' });
  assert.deepEqual(fiscalPreparation(' ', ''), { operation_nature: null, notes: null });
  for (const [nature, notes] of [['x'.repeat(61), ''], ['a\nb', ''], ['', 'x'.repeat(4001)], ['', '\x00']]) assert.throws(() => fiscalPreparation(nature, notes));
});
test('creation requires saved non-cancelled order, deliberate model choice and confirmation', () => {
  const prep = fiscalPreparation('', '');
  assert.deepEqual(fiscalCreateInput(source, '65', prep, true), { source_document_id: source.id, expected_source_version: 3, model: '65', preparation: prep });
  for (const args of [[null, '55', prep, true], [source, '', prep, true], [source, '55', prep, false], [{ ...source, status: 'cancelled' }, '55', prep, true], [{ ...source, kind: 'purchase_orders' }, '55', prep, true]]) assert.throws(() => fiscalCreateInput(...args));
  assert.equal(Object.hasOwn(fiscalCreateInput(source, '55', prep, true), 'items'), false);
});
test('current and historical envelopes bind record identity without replacing the historical snapshot', () => {
  const current = fixture(); assert.equal(fiscalDraftEnvelope(current, uuid(1)).record.source_document_version, 3);
  const historic = fixture(); historic.current.version = 4; historic.current.source_document_version = 5; historic.current.source_changed = true; historic.pending.push('SOURCE_DOCUMENT_CHANGED');
  const read = fiscalDraftEnvelope(historic, uuid(1), 1);
  assert.equal(read.record.snapshot.document_version, 3); assert.equal(read.current.source_document_version, 5);
  assert.throws(() => fiscalDraftEnvelope(historic, uuid(99)));
  assert.throws(() => fiscalDraftEnvelope(historic, uuid(1), 4));
  assert.throws(() => fiscalUpdateInput(read, fiscalPreparation('Venda', '')));
  assert.throws(() => fiscalRefreshInput(read, true));
  assert.throws(() => fiscalArchiveInput(read, 'Conferência', true));
});
test('envelope rejects issuance enablement, mismatched copied source, duplicate lines and unsafe value types', () => {
  const mutations = [v => v.emission_enabled = true, v => v.operational_effects = true, v => v.record.environment = '1',
    v => v.record.snapshot.document_id = uuid(88), v => v.record.snapshot.document_version = 9,
    v => v.record.snapshot.items.push({ ...v.record.snapshot.items[0], position: 2 }), v => v.record.snapshot.totals.total = 12.34,
    v => v.record.snapshot.contact.name = { unsafe: 'object' }, v => v.pending.push('OTHER_CODE'), v => v.pending.push(v.pending[0]),
    v => v.current.source_changed = true];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => fiscalDraftEnvelope(value)); }
});
test('snapshot accepts the shared commercial limit of 250 items and rejects 251', () => {
  const value = fixture(), line = value.record.snapshot.items[0];
  value.record.snapshot.items = Array.from({ length: 250 }, (_, i) => ({ ...line, id: uuid(i + 100), position: i + 1 }));
  assert.equal(fiscalDraftEnvelope(value).record.snapshot.items.length, 250);
  value.record.snapshot.items.push({ ...line, id: uuid(999), position: 251 });
  assert.throws(() => fiscalDraftEnvelope(value));
});
test('refresh and archive preserve version checks, prohibit historical editing and require contextual confirmation', () => {
  const value = fiscalDraftEnvelope(fixture());
  assert.deepEqual(fiscalUpdateInput(value, fiscalPreparation('Venda', '')), { expected_version: 1, preparation: { operation_nature: 'Venda', notes: null } });
  assert.deepEqual(fiscalRefreshInput(value, true), { expected_version: 1, expected_source_version: 3 });
  assert.throws(() => fiscalRefreshInput(value, false));
  const cancelled = structuredClone(value); cancelled.current.source_status = 'cancelled'; assert.throws(() => fiscalRefreshInput(cancelled, true));
  assert.deepEqual(fiscalArchiveInput(value, ' Revisão do pedido ', true), { expected_version: 1, reason: 'Revisão do pedido' });
  for (const [reason, confirmed] of [['ok', true], ['Motivo', false], ['Texto\nquebrado', true]]) assert.throws(() => fiscalArchiveInput(value, reason, confirmed));
  const archived = structuredClone(value); archived.record.status = archived.current.status = 'archived';
  assert.throws(() => fiscalUpdateInput(archived, fiscalPreparation('', '')));
});
test('list and revision pagination preserve separate UUID/version cursors and filter binding', () => {
  assert.equal(fiscalListParams({ model: '65', status: 'draft' }, uuid(8)).toString(), `limit=25&model=65&status=draft&after=${uuid(8)}`);
  const page = { ...flags, items: [summary()], limit: 25, has_more: false, next_cursor: null };
  assert.equal(fiscalDraftPage(page, { model: '55', status: '' }).items.length, 1);
  assert.throws(() => fiscalDraftPage(page, { model: '65', status: '' }));
  assert.throws(() => fiscalDraftPage({ ...page, items: [summary(), summary()] }, { model: '', status: '' }));
  assert.throws(() => fiscalDraftPage({ ...page, has_more: true, next_cursor: uuid(1) }, { model: '', status: '' }));
  const revisions = { ...page, draft_id: uuid(1), items: [summary(), { ...summary(), version: 2 }] };
  assert.equal(fiscalRevisionPage(revisions, uuid(1)).items[1].version, 2);
  assert.throws(() => fiscalRevisionPage(revisions, uuid(2)));
  assert.throws(() => fiscalRevisionPage({ ...revisions, items: [summary(), summary()] }, uuid(1)));
});
test('commercial money and quantities remain exact digit strings and no unavailable value becomes zero', () => {
  assert.equal(fiscalDecimal('999999999999.99', true), 'R$ 999.999.999.999,99');
  assert.equal(fiscalDecimal('999999999.123456'), '999.999.999,123456');
  assert.equal(fiscalDecimal('12.3400', true), 'R$ 12,3400');
  assert.equal(fiscalDecimal('1e3', true), 'Indisponível');
});
test('model navigation preserves unrelated query fields and can restore the combined list', () => {
  assert.equal(fiscalModelSearch('?origem=menu&modelo=55&pagina=2', '65'), '?origem=menu&modelo=65&pagina=2');
  assert.equal(fiscalModelSearch('?origem=menu&modelo=55', ''), '?origem=menu');
  assert.equal(fiscalModelSearch('?modelo=65', ''), '');
});

test('057 fiscal price accepts exact canonical4/10 only without widening other snapshot decimals', () => {
  for (const price of ['12.3400', '0.0000000001', '9999999999.1234567890']) {
    const value = fixture(); value.record.snapshot.items[0].unit_price = price;
    const before = JSON.stringify(value); assert.equal(fiscalDraftEnvelope(value).record.snapshot.items[0].unit_price, price);
    assert.equal(JSON.stringify(value), before);
  }
  for (const price of ['12.3400000000', '1.12345', '0.00000000001', '10000000000.0000', '1e2', 1, null]) {
    const value = fixture(); value.record.snapshot.items[0].unit_price = price;
    assert.throws(() => fiscalDraftEnvelope(value)); assert.equal(fiscalUnitPrice(price), 'Indisponível');
  }
  for (const key of ['quantity', 'discount_percent', 'total']) {
    const value = fixture(); value.record.snapshot.items[0][key] = '1.0000000001';
    assert.throws(() => fiscalDraftEnvelope(value));
  }
  assert.equal(fiscalDecimal('1.0000000001', true), 'Indisponível');
  assert.equal(fiscalUnitPrice('9999999999.1234567890'), 'R$ 9.999.999.999,1234567890');
  assert.equal(fiscalUnitPrice('12.3400'), 'R$ 12,3400');
});
