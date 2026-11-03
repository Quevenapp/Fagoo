import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixture } from '../../../tools/migration/helpers/stock-reservation-fixture.mjs';
import { fiscalInvoicesRoute, parseFiscalInvoicesRoute, executeFiscalInvoicesRoute, FiscalInvoicesError } from '../src/fiscal-invoices.mjs';
import { invoiceTotals, normalizeInvoiceInput } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

// The Worker projection accepts the real SQL results of 111-114 (synthetic data, PGlite) and computes the same totals.
const migration = async name => readFile(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
let f;
const call = async (path, { method = 'GET', body, user = f.users.admin } = {}) => {
  const url = new URL(`https://api.example.test/v1/notas-fiscais${path}`);
  const request = new Request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const parsed = await parseFiscalInvoicesRoute(request, fiscalInvoicesRoute(url.pathname));
  return executeFiscalInvoicesRoute(parsed, { userId: user, rpc: (name, args) => f.rpc(name, args) });
};
const status = async promise => { try { await promise; return 200; } catch (error) { if (error instanceof FiscalInvoicesError) return error.status; return error.code; } };

before(async () => {
  f = await fixture({ apply: false });
  for (const name of ['202610160016_company', '202610160022_fiscal_drafts', '202610160035_fiscal_item_preparation', '202610160040_fiscal_tax_preparation', '202610160046_fiscal_numbering',
    '202610160027_origin_fiscal_archive', '202610200111_fiscal_operation_natures', '202610200112_fiscal_invoice_core', '202610200113_fiscal_invoice_list', '202610200114_fiscal_invoice_events',
    '202610200115_erp_preferences', '202610200140_fiscal_invoice_preferences', '202610200141_fiscal_item_groups_nature_review', '202610200142_fiscal_invoice_order_links']) await f.db.exec(await migration(name));
  await f.db.exec("insert into origin_sync.resource_state(resource) values('projection_test')");
  await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','projection_test','7001',$1::jsonb,$2)",
    [JSON.stringify({ tipo: 1, numero: '000010', serie: 1, dataEmissao: '2026-10-10 10:00:00', situacao: 6, valorNota: 12.3, contato: { nome: 'Cliente Origin sintético', numeroDocumento: '11.222.333/0001-81', endereco: { uf: 'SP' } }, itens: [{ codigo: 'X', descricao: 'Item', quantidade: 1, valor: 12.3, valorTotal: 12.3 }] }), 'b'.repeat(64)]);
});
after(() => f?.close());

test('natures, tax settings and invoices round-trip through the Worker contract unchanged', async () => {
  const created = await call('/naturezas', { method: 'POST', body: { command_id: randomUUID(), action: 'create', nature: { description: 'Venda projeção sintética', direction: '1', crt: '1', presence: '1',
    others: { discount_type: 'I', approx_tax_rate: '13.45' }, rules: [{ tax: 'icms', destinations: ['SP'], product_scope: 'products', product_ids: [f.product.id], data: { situation: '101', cfop: '5102', credit_rate: '2.5' } }, { tax: 'pis', data: { situation: '49' } }] } } });
  assert.equal(created.nature.rules[0].products[0].id, f.product.id); assert.equal(created.nature.others.approx_tax_rate, '13.4500');
  const read = await call(`/naturezas/${created.nature.id}`, { user: f.users.consulta });
  assert.deepEqual(read.nature, created.nature); assert.equal(read.writable, false);
  const listed = await call('/naturezas?active=true&direction=1');
  assert.deepEqual(listed.items.map(n => n.id), [created.nature.id]);
  const withDefault = await call('/naturezas', { method: 'POST', body: { command_id: randomUUID(), action: 'set_default', id: created.nature.id, expected_version: 1, code: 'S' } });
  assert.deepEqual(withDefault.nature.defaults, ['S']);
  const taxes = await call('/impostos');
  assert.equal(taxes.version, 0);
  const savedTaxes = await call('/impostos', { method: 'POST', body: { command_id: randomUUID(), expected_version: 0, settings: { exclude_icms_pis_cofins: true }, difal_by_state: { PA: 'double_base' } } });
  assert.deepEqual([savedTaxes.version, savedTaxes.settings.exclude_icms_pis_cofins, savedTaxes.difal_by_state], [1, true, { PA: 'double_base' }]);
  const context = await call('/contexto?model=55', { user: f.users.fiscal });
  assert.equal(context.defaults.S.id, created.nature.id); assert.equal(context.production_enabled, false);
  const input = { model: '55', direction: '1', issue_type: 'N', series: '1', nature_id: created.nature.id, issue_date: '2026-10-20', crt: '1', purpose: '1', presence: '1', final_consumer: false,
    recipient: { name: 'Cliente projeção', person_type: 'J', document: '11222333000181', state: 'SP' }, freight: '7.77', discount: '0.10', insurance: '1',
    items: [{ product_id: f.product.id, description: 'Item A', quantity: '3', unit_price: '0.3333333333', icms: { situation: '101', credit_rate: '2.5', credit_value: '0.03' }, ipi: { situation: '99', value: '0.10' } },
      { description: 'Item B', quantity: '0.0005', unit_price: '1999.99', invoiced: true, icms: { situation: '102' }, others: { approx_taxes: '0.13' } },
      { description: 'Item C', quantity: '1', unit_price: '10', invoiced: false }],
    transport: { mode: 'manual', freight_by: '0', volumes: { quantity: '1' } }, payment: { installments: [{ date: '2026-11-20', amount: '8.99', method: '15' }] } };
  const saved = await call('', { method: 'POST', body: { command_id: randomUUID(), invoice: input } });
  const expected = invoiceTotals(normalizeInvoiceInput(input));
  assert.deepEqual(saved.invoice.totals, expected.totals, 'JavaScript totals equal SQL totals');
  assert.deepEqual(saved.invoice.items.map(i => i.total), expected.lines);
  assert.deepEqual(saved.invoice.items.map(i => i.allocated.freight), expected.allocation.freight);
  assert.equal(saved.invoice.totals.products, '2.00', '1.00 + 1.00, the not invoiced line stays out');
  const reread = await call(`/${saved.invoice.id}`);
  assert.deepEqual(reread.invoice, saved.invoice);
  const updated = await call(`/${saved.invoice.id}`, { method: 'PATCH', body: { command_id: randomUUID(), expected_version: 1, invoice: { ...input, additional_info: 'Atualizada' } } });
  assert.equal(updated.invoice.version, 2); assert.equal(updated.action, 'update');
  const page = await call('?origin=brufap&model=55', { user: f.users.fiscal });
  assert.deepEqual(page.items.map(r => [r.id, r.total]), [[saved.invoice.id, saved.invoice.totals.total]]);
  const origin = await call('?model=55&q=11.222.333/0001', { user: f.users.consulta });
  assert.deepEqual(origin.items.map(r => [r.id, r.number, r.status, r.total]), [['7001', 10, 7, '12.30']]);
  const detail = await call('/origin/nfe/7001', { user: f.users.consulta });
  assert.equal(detail.items[0].code, 'X');
  const removed = await call(`/${saved.invoice.id}/excluir`, { method: 'POST', body: { command_id: randomUUID(), expected_version: 2, reason: 'Teste de projeção' } });
  assert.ok(removed.invoice.deleted_at); assert.equal(removed.writable, false);
  const inutilization = await call('/eventos', { method: 'POST', user: f.users.fiscal, body: { command_id: randomUUID(), action: 'inutilization', model: '55', series: '9', number_from: '5', number_to: '6', justification: 'Faixa sintética para teste de projeção' } });
  assert.deepEqual([inutilization.event.number_from, inutilization.transmission_enabled], [5, false]);
  const events = await call('/eventos?kind=inutilization', { user: f.users.fiscal });
  assert.deepEqual(events.items.map(e => e.id), [inutilization.event.id]);
});

test('the Worker refuses invalid input before the database and maps SQL refusals', async () => {
  const before = (await f.db.query('select count(*)::int n from erp_fiscal_invoices.command')).rows[0].n;
  for (const [path, options] of [['?model=57', {}], ['?model=55&origin=x', {}], ['?model=65&direction=0', {}], ['?model=55&limit=101', {}], ['?model=55&q=a&q=b', {}], ['?model=55&unknown=1', {}],
    ['?model=55&date_from=2026-02-30', {}], ['/naturezas?active=sim', {}], ['/eventos?kind=x', {}], ['/contexto?model=55&x=1', {}],
    ['', { method: 'POST', body: { command_id: randomUUID(), invoice: { model: '55' } } }], ['', { method: 'POST', body: { command_id: 'x', invoice: {} } }],
    ['/naturezas', { method: 'POST', body: { command_id: randomUUID(), action: 'delete', id: randomUUID() } }],
    ['/eventos', { method: 'POST', body: { command_id: randomUUID(), action: 'cancel', invoice_id: randomUUID(), expected_version: 1, justification: 'curta' } }]])
    assert.equal(await status(call(path, options)), 400, path);
  assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_invoices.command')).rows[0].n, before);
  assert.equal(await status(call('?origin=brufap&model=55', { user: f.users.consulta })), '42501');
  assert.equal(await status(call(`/${randomUUID()}`)), 'P0002');
  assert.equal(await status(call('/desconhecida')), 404);
});
