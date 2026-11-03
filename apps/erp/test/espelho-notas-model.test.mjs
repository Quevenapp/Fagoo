import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { CATEGORY_ORIGIN_HELP, NOT_APPLICABLE_FILTERS, SCREENS, emptyFilters, filterChips, filtersFromPreference, filtersToPreference, fiscalListQuery, fiscalStateText, orderIndicators, sourceLabel } from '../src/lib/fiscal-invoice-list-model.ts';
import { dfeHasSummary, dfeSummaries, dfeSummaryParams, dfeSummaryResult } from '../src/lib/received-dfe-model.ts';
import { buildAccessKey } from '../../../packages/fiscal-core/src/identity.mjs';

// Leva H, lane espelho: the screens of the notes (NFE-027, NFE-069, NFE-063/185, NFE-024/172) and of the Notas recebidas (NFE-212).
// Synthetic data only.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (over = {}) => ({ origin: 'origin', id: '9001', version: null, number: 123, series: 1, issue_date: '2026-10-15', entry_date: null, name: 'Cliente', document: null, state: 'SP', nature: null,
  status: 7, status_raw: '6', total: '10.00', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0,
  orders: [{ id: '501', kind: 'sales_orders', number: '77', date: '2026-10-01', contact_name: 'Cliente do Pedido' }], fiscal_status: 6, danfe_emitted: true, source_origin: 'origin', source_environment: '1', ...over });

test('NFE-027: the V badge of a Origin note lists the Origin pedidos that declare it', () => {
  assert.deepEqual(orderIndicators(row()), [{ text: 'V', color: 'orange', title: 'Número pedido: 77 - Data: 01/10/2026 - Cliente: Cliente do Pedido' }]);
  assert.deepEqual(orderIndicators(row({ orders: [] })), []);
});

test('NFE-069/063/185: fiscal state apart from the DANFE, and the source origin and environment of each note', () => {
  assert.equal(fiscalStateText(row()), 'Situação fiscal: Autorizada · DANFE emitida · código 6 do Origin');
  assert.equal(fiscalStateText(row({ status: 6, status_raw: '5', danfe_emitted: false })), 'Situação fiscal: Autorizada · DANFE não emitida · código 5 do Origin');
  assert.equal(fiscalStateText(row({ status: null, fiscal_status: null, status_raw: '12', danfe_emitted: false })), 'Situação fiscal: Situação não mapeada · código 12 do Origin');
  assert.equal(sourceLabel(row()), 'Nota do Origin · produção');
  assert.equal(sourceLabel(row({ origin: 'brufap', source_origin: 'xml_import', source_environment: '1' })), 'XML importado · produção');
  assert.equal(sourceLabel(row({ origin: 'brufap', source_origin: 'brufap_native', source_environment: '2' })), 'Nota do FAGOO · homologação');
  assert.equal(sourceLabel(row({ origin: 'brufap', source_origin: 'third_party', source_environment: null })), 'Nota de terceiros registrada no FAGOO · ambiente não informado');
});

test('NFE-024/172: Categoria is sent only with the notes of the FAGOO; Loja and Filial are explained as not applicable', () => {
  for (const screen of ['nfe', 'nfce']) {
    const config = SCREENS[screen], filters = { ...emptyFilters(config), category: { id: id(7), name: 'Vendas de mercadorias' } };
    assert.equal(config.categoryFilter, true);
    assert.equal(fiscalListQuery(config, 'brufap', filters).get('category_id'), id(7));
    assert.equal(fiscalListQuery(config, 'origin', filters).has('category_id'), false);
    assert.ok(filterChips(config, filters).some(c => c.key === 'category' && c.label === 'Categoria: Vendas de mercadorias'));
    const saved = filtersToPreference(config, filters);
    assert.deepEqual([saved.category_id, saved.category_name], [id(7), 'Vendas de mercadorias']);
    assert.equal(filtersFromPreference(config, saved).category.id, id(7));
    assert.throws(() => fiscalListQuery(config, 'brufap', { ...filters, category: { id: 'bad', name: 'x' } }), /categoria/);
    // Nº pedido de venda is a filter of both screens (it now works for the Origin notes too).
    assert.ok(config.customFilters.includes('order_number'));
  }
  assert.equal(SCREENS.entrada.categoryFilter, undefined);
  assert.match(NOT_APPLICABLE_FILTERS, /Loja e Filial não se aplicam/); assert.match(CATEGORY_ORIGIN_HELP, /notas do FAGOO/);
});

test('NFE-024/172: the screen shows Categoria in Adicionar filtros and Loja/Filial as not applicable', async () => {
  const source = await readFile(new URL('../src/components/RealFiscalInvoices.tsx', import.meta.url), 'utf8');
  assert.match(source, /htmlFor="fiscal-custom-category">Categoria</); assert.match(source, /NOT_APPLICABLE_FILTERS/); assert.match(source, /\/v1\/documentos\/sales_orders\/categorias/);
  assert.match(source, /title=\{fiscalStateText\(row\)\}/); assert.match(source, /title=\{sourceLabel\(row\)\}/);
});

const FLAGS = { data_mode: 'received_dfe', model: '55', transport_enabled: false, can_query: false, can_manifest: false, can_emit: false, origin_authenticated: false, signature_verified: false, xsd_validated: false, sefaz_authorized: false, financial_mutation_performed: false, stock_mutation_performed: false };
const channelId = id(1);
const key = buildAccessKey({ cUF: '35', cnpj: '12345678000195', model: '55', environment: '1', series: '2', number: '345', issuedAt: '2026-10-15T09:00:00-03:00', cNF: '12345678', tpEmis: '1' });
const bytes = new TextEncoder().encode('<resNFe>FICTICIO</resNFe>'), hash = createHash('sha256').update(bytes).digest('hex');
const doc = (n, kind = 'invoice_summary') => ({ id: id(n), channel_id: channelId, nsu: `00000000000000${n}`.slice(-15), kind, schema: kind === 'invoice_summary' ? 'resNFe_v1.01.xsd' : 'resEvento_v1.01.xsd', model: '55', access_key: key, recipient_match: null, quarantined: false, xml_hash: hash, size_bytes: bytes.length, collected_at: '2026-10-16T12:00:00Z', is_complete_invoice: false });
const reading = n => ({ document_id: id(n), issue_date: '2026-10-15', total: '1234.50', supplier_name: 'Fornecedor fictício', supplier_document: '12345678000195', situation: '3' });

test('NFE-212: the readings of the Notas recebidas are checked strictly', () => {
  assert.equal(dfeHasSummary({ kind: 'invoice_summary' }), true); assert.equal(dfeHasSummary({ kind: 'event' }), false);
  assert.equal(dfeSummaryParams(channelId, [id(5), id(5), id(6)]).get('ids'), `${id(5)},${id(6)}`);
  assert.throws(() => dfeSummaryParams(channelId, []));
  assert.deepEqual([...dfeSummaries({ ...FLAGS, channel_id: channelId, items: [reading(5)] }, channelId, [id(5)]).keys()], [id(5)]);
  for (const bad of [{ ...FLAGS, channel_id: id(2), items: [] }, { ...FLAGS, can_query: true, channel_id: channelId, items: [] }, { ...FLAGS, channel_id: channelId, items: [reading(9)] },
    { ...FLAGS, channel_id: channelId, items: [{ ...reading(5), total: '1,00' }] }, { ...FLAGS, channel_id: channelId, items: [{ ...reading(5), extra: 1 }] }])
    assert.throws(() => dfeSummaries(bad, channelId, [id(5)]));
  assert.equal(dfeSummaryResult({ ...FLAGS, summary: reading(5), recorded: false }, id(5)).total, '1234.50');
  assert.throws(() => dfeSummaryResult({ ...FLAGS, summary: reading(6), recorded: true }, id(5)));
});

test('NFE-212: Notas recebidas shows Número · Série · Data emissão · Valor · Fornecedor · CNPJ/CPF · Status and reads the missing ones once', async () => {
  const current = { id: channelId, environment: '1', identity_version: 1, version: 1, coordinator: 'external', other_consumers_reviewed: false, checkpoint: null, checkpoint_confirmed: false, collection_requested: false, paused: false, has_active_attempt: false, not_before: null, updated_at: '2026-10-16T12:00:00Z', company_changed: false };
  const calls = [];
  const controller = {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 1, data: { legal_name: 'EMPRESA FICTICIA', cnpj: '11222333000181' } } }; },
    async dfeDistributionDownload() { return new Blob([bytes]); },
    async dfeDistribution(path, options = {}) {
      const url = new URL(path, 'https://synthetic.invalid'); calls.push([options.method ?? 'GET', url.pathname, options.body]);
      if (url.pathname.endsWith('/settings')) return { ...FLAGS, current };
      if (url.pathname.endsWith('/documents')) return { ...FLAGS, channel_id: channelId, items: [doc(5), doc(6), doc(7, 'event_summary')], limit: 25, has_more: false, next_cursor: null };
      if (url.pathname.endsWith('/summaries')) { assert.equal(url.searchParams.get('ids'), `${id(5)},${id(6)}`); return { ...FLAGS, channel_id: channelId, items: [reading(5)] }; }
      if (url.pathname.endsWith('/summary')) return { ...FLAGS, summary: { ...reading(6), supplier_name: 'Outro fornecedor', situation: null }, recorded: true };
      throw new Error(`unexpected ${path}`);
    },
  };
  const view = await mountComponent('RealReceivedDfe.tsx', { controller, initialEnvironment: '1' });
  try {
    await view.flush(); await new Promise(r => setTimeout(r, 50)); await view.flush();
    const text = view.text();
    for (const header of ['Número', 'Série', 'Data emissão', 'Valor', 'Fornecedor', 'CNPJ/CPF', 'Status']) assert.match(text, new RegExp(header));
    assert.match(text, /15\/10\/2026/); assert.match(text, /R\$ 1\.234,50/); assert.match(text, /Fornecedor fictício/); assert.match(text, /Outro fornecedor/); assert.match(text, /NF-e cancelada no resumo/);
    assert.match(text, /000345/); assert.match(text, /12\.345\.678\/0001-95/);
    // Only the document without a stored reading is read, with an empty body; the event has no reading.
    assert.deepEqual(calls.filter(c => c[1].endsWith('/summary')), [['POST', `/v1/notas-recebidas/documents/${id(6)}/summary`, {}]]);
  } finally { view.unmount(); }
});
