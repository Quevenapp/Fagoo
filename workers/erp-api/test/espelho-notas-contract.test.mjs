import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { listPage } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { parseDfeDistributionRoute, executeDfeDistributionRoute, dfeDistributionMethods } from '../src/dfe-distribution.mjs';
import { readReceivedSummary, DfeSummaryError } from '../../../packages/fiscal-xml/src/dfe-summary.mjs';
import { accessKey } from './helpers/fiscal-import-xml.mjs';

// Leva H, lane espelho: Worker contracts of the notes list (NFE-027, NFE-069, NFE-063/185, NFE-024/172) and of the readings of the received
// documents (NFE-212), with synthetic upstreams only (no network, no database).
const user = 'a0000000-0000-4000-8000-000000000001', category = 'e0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = path => new Request(`https://api.example.test/v1/notas-fiscais${path}`, { headers: { Authorization: 'Bearer synthetic-token', Origin: 'https://erp.example.test' } });
const harness = value => { const calls = []; return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/v1/user') ? Response.json({ id: user }) : Response.json(value); } }) }; };
const page = (items, over = {}) => ({ items, origin: 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc', has_more: false, total_count: items.length, total_amount: '0.00', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: 'origin_mirror_readonly', ...over });
const row = (over = {}) => ({ origin: 'origin', id: '9001', version: null, number: 123, series: 1, issue_date: '2026-10-15', entry_date: null, name: 'Cliente sintético', document: '12345678000190', state: 'SP', nature: null,
  status: 7, status_raw: '6', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: false, event_count: 0,
  orders: [{ id: '501', kind: 'sales_orders', number: '77', date: '2026-10-01', contact_name: 'Cliente do Pedido' }], fiscal_status: 6, danfe_emitted: true, source_origin: 'origin', source_environment: '1', ...over });
const args = { origin: 'origin', model: '55', direction: '1', page: 1, limit: 100, order: 'date_desc' };
const check = (items, over = {}) => listPage(page(items, over), { ...args, origin: over.origin ?? 'origin' });
const invalid = fn => assert.throws(fn, /FISCAL_RESPONSE_INVALID/);

test('espelho fiscal: carimbo por nota e cobertura da carteira sobrevivem ao contrato HTTP', async () => {
  const coverage = { scope: 'model_direction', source_count: 8, visible_count: 6, xml_count: 4, missing_xml_count: 2,
    homologation_count: 1, duplicate_count: 1, incomplete_count: 1, oldest_observed_at: '2026-10-21T12:00:00Z', latest_observed_at: '2026-10-22T12:00:00Z', partial: true, private: 'hidden' };
  const h = harness(page([row({ observed_at: '2026-10-22T12:00:00Z' })], { coverage }));
  const response = await h.handler(request('?model=55'), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.items[0].observed_at, '2026-10-22T12:00:00Z');
  assert.equal(result.coverage.xml_count, 4); assert.equal(result.coverage.partial, true);
  assert.equal(result.coverage.private, undefined);
  assert.equal(JSON.parse(h.calls.at(-1).options.body).p_user_id, user);
  for (const patch of [{ missing_xml_count: 1 }, { visible_count: 9 }, { xml_count: -1 }, { source_count: 1.5 }, { oldest_observed_at: 'ontem' }, { partial: 'sim' }])
    invalid(() => check([row()], { coverage: { ...coverage, ...patch } }));
  invalid(() => check([row({ observed_at: 'ontem' })], { coverage }));
});

test('espelho fiscal: endpoint Origin não aceita editar nem apagar a nota de origem', async () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const h = harness(page([]));
    const response = await h.handler(new Request('https://api.example.test/v1/notas-fiscais/origin/nfe/9001', { method, headers: { Authorization: 'Bearer synthetic-token' } }), env);
    assert.equal(response.status, 405); assert.equal(h.calls.length, 0);
  }
});

test('NFE-027/069/063: a Origin row carries its Origin pedidos, the fiscal state apart from the DANFE and the source attributes', () => {
  const out = check([row()]).items[0];
  assert.deepEqual([out.orders[0].id, out.fiscal_status, out.danfe_emitted, out.source_origin, out.source_environment], ['501', 6, true, 'origin', '1']);
  // A Origin pedido is identified by its Origin id, never a Brufap UUID or another kind; ids are unique.
  invalid(() => check([row({ orders: [{ id: 'd0000000-0000-4000-8000-000000000001', kind: 'sales_orders', number: '77', date: null, contact_name: null }] })]));
  invalid(() => check([row({ orders: [{ id: '501', kind: 'purchase_orders', number: '77', date: null, contact_name: null }] })]));
  invalid(() => check([row({ orders: [row().orders[0], row().orders[0]] })]));
  // The derived attributes must agree with the row.
  invalid(() => check([row({ danfe_emitted: false })]));
  invalid(() => check([row({ fiscal_status: 7 })]));
  invalid(() => check([row({ source_origin: 'xml_import' })]));
  invalid(() => check([row({ source_environment: '2' })]));
  invalid(() => { const r = row(); delete r.source_environment; check([r]); });
  // A database before 358 does not send them: they are derived (Origin orders still empty there).
  const old = row({ orders: [], status: 6, status_raw: '5' }); for (const k of ['fiscal_status', 'danfe_emitted', 'source_origin', 'source_environment']) delete old[k];
  assert.deepEqual((({ fiscal_status, danfe_emitted, source_origin, source_environment }) => [fiscal_status, danfe_emitted, source_origin, source_environment])(check([old]).items[0]), [6, false, 'origin', '1']);
  // Notes of the Brufap: imported XML keeps the tpAmb of the XML; the native notes keep the emission environment '2'.
  const native = { origin: 'brufap', id: 'd0000000-0000-4000-8000-000000000001', version: 1, environment: null, issue_type: 'S', status: 8, status_raw: null, orders: [], fiscal_status: 8, danfe_emitted: false, source_origin: 'xml_import', source_environment: '1' };
  const brufap = over => check([row({ ...native, ...over })], { origin: 'brufap', data_mode: 'erp_native_homologation' }).items[0];
  assert.equal(brufap({}).source_environment, '1');
  assert.equal(brufap({ environment: '2', issue_type: 'N', status: 1, fiscal_status: 1, source_origin: 'brufap_native', source_environment: '2' }).source_origin, 'brufap_native');
  invalid(() => brufap({ environment: '2', issue_type: 'N', status: 1, fiscal_status: 1, source_origin: 'brufap_native', source_environment: '1' }));
  invalid(() => brufap({ issue_type: 'T', source_origin: 'third_party', source_environment: '1' }));
});

test('NFE-024/172: Categoria goes to the database only with the notes of the Brufap and only when used', async () => {
  let h = harness(page([], { origin: 'brufap', model: '65', data_mode: 'erp_native_homologation' }));
  let response = await h.handler(request(`?model=65&origin=brufap&category_id=${category.toUpperCase()}`), env);
  assert.equal(response.status, 200);
  const sent = JSON.parse(h.calls[1].options.body);
  assert.equal(sent.p_category_id, category); assert.ok(h.calls[1].url.endsWith('/rpc/erp_fiscal_invoice_list'));
  // With Tags the tagged variant receives the same Categoria.
  h = harness(page([], { origin: 'brufap', data_mode: 'erp_native_homologation' }));
  await h.handler(request(`?model=55&origin=brufap&tag=none&category_id=${category}`), env);
  assert.ok(h.calls[1].url.endsWith('/rpc/erp_catalog_invoice_list_tagged')); assert.equal(JSON.parse(h.calls[1].options.body).p_category_id, category);
  // Absent: not sent (a database before 358 keeps answering).
  h = harness(page([row()]));
  response = await h.handler(request('?model=55&order_number=77'), env);
  assert.equal(response.status, 200); assert.equal(Object.hasOwn(JSON.parse(h.calls[1].options.body), 'p_category_id'), false);
  assert.equal(JSON.parse(h.calls[1].options.body).p_order_number, '77');
  // Origin notes, an invalid id or a repeated key are refused before any call.
  for (const query of [`?model=55&category_id=${category}`, '?model=55&origin=brufap&category_id=bad', `?model=55&origin=brufap&category_id=${category}&category_id=${category}`]) {
    h = harness(page([])); response = await h.handler(request(query), env);
    assert.equal(response.status, 400, query); assert.equal(h.calls.filter(c => c.url.includes('/rpc/')).length, 0);
  }
});

const NS = 'http://www.portalfiscal.inf.br/nfe', SUPPLIER = '12345678000195';
const key = accessKey({ cnpj: SUPPLIER, number: 901 });
const resumo = (over = '') => new TextEncoder().encode(`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${key}</chNFe><CNPJ>${SUPPLIER}</CNPJ><xNome>  Fornecedor   Sintético </xNome><dhEmi>2026-10-15T09:00:00-03:00</dhEmi><vNF>10</vNF><cSitNFe>3</cSitNFe>${over}</resNFe>`);

test('NFE-212: the reading of a resumo or NF-e is bounded and must match the kept document and its access key', () => {
  assert.deepEqual(readReceivedSummary(resumo(), { kind: 'invoice_summary', access_key: key }),
    { access_key: key, issue_date: '2026-10-15', total: '10.00', supplier_name: 'Fornecedor Sintético', supplier_document: SUPPLIER, situation: '3' });
  const cpfKey = accessKey({ cnpj: '00012345678909', number: 5 });
  assert.equal(readReceivedSummary(new TextEncoder().encode(`<resNFe xmlns="${NS}" versao="1.01"><chNFe>${cpfKey}</chNFe><CPF>12345678909</CPF></resNFe>`), { kind: 'invoice_summary', access_key: cpfKey }).supplier_document, '12345678909');
  const refused = (bytes, expected = { kind: 'invoice_summary', access_key: key }) => assert.throws(() => readReceivedSummary(bytes, expected), DfeSummaryError);
  refused(resumo(), { kind: 'invoice_summary', access_key: accessKey({ cnpj: SUPPLIER, number: 902 }) });
  refused(resumo(), { kind: 'invoice', access_key: key });
  refused(resumo(), { kind: 'event_summary', access_key: key });
  refused(new TextEncoder().encode(`<!DOCTYPE x><resNFe xmlns="${NS}"><chNFe>${key}</chNFe></resNFe>`));
  refused(new TextEncoder().encode(`<resNFe xmlns="${NS}"><chNFe>${key}</chNFe><CNPJ>11222333000181</CNPJ></resNFe>`));
  refused(new TextEncoder().encode(`<resNFe xmlns="${NS}"><chNFe>${key}</chNFe><vNF>1,00</vNF></resNFe>`));
  refused(new TextEncoder().encode(`<resNFe xmlns="${NS}"><chNFe>${key}</chNFe><cSitNFe>9</cSitNFe></resNFe>`));
  refused(new TextEncoder().encode(`<resNFe><chNFe>${key}</chNFe></resNFe>`));
  refused(new Uint8Array(0));
});

const docId = '40000000-0000-4000-8000-000000000001', channelId = '30000000-0000-4000-8000-000000000001';
const flags = { data_mode: 'received_dfe', model: '55', transport_enabled: false, can_query: false, can_manifest: false, can_emit: false, origin_authenticated: false, signature_verified: false, xsd_validated: false, sefaz_authorized: false, financial_mutation_performed: false, stock_mutation_performed: false };
const bytes = resumo(), sha = createHash('sha256').update(bytes).digest('hex');
const document = { id: docId, channel_id: channelId, nsu: '000000000000001', kind: 'invoice_summary', schema: 'resNFe_v1.01.xsd', model: '55', access_key: key, recipient_match: null, quarantined: false, xml_hash: sha, size_bytes: bytes.length, collected_at: '2026-10-16T12:00:00Z', is_complete_invoice: false };
const meta = { ...flags, document, bucket: 'brufap-received-dfe', object_key: `objects/${sha}.xml`, filename: `RESUMO_NFE_${docId}.xml` };
const stored = { document_id: docId, issue_date: '2026-10-15', total: '10.00', supplier_name: 'Fornecedor Sintético', supplier_document: SUPPLIER, situation: '3' };
const parse = (suffix, options) => parseDfeDistributionRoute(new Request(`https://synthetic.invalid/v1/notas-recebidas${suffix}`, options));
const postSummary = (body = {}) => parse(`/documents/${docId}/summary`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fetchObject = async () => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });

test('NFE-212: the routes read the stored readings of a page and record one reading from the checked bytes', async () => {
  assert.deepEqual(dfeDistributionMethods('/v1/notas-recebidas/summaries'), ['GET']);
  assert.deepEqual(dfeDistributionMethods(`/v1/notas-recebidas/documents/${docId}/summary`), ['POST']);
  const list = await parse(`/summaries?channel_id=${channelId}&ids=${docId},${docId.toUpperCase()}`);
  assert.deepEqual(list.args, { p_channel_id: channelId, p_document_ids: [docId] });
  for (const suffix of ['/summaries', `/summaries?channel_id=${channelId}`, `/summaries?channel_id=${channelId}&ids=bad`, `/summaries?channel_id=${channelId}&ids=${Array(51).fill(docId).join(',')}`, `/summaries?channel_id=${channelId}&ids=${docId}&kind=invoice`])
    await assert.rejects(() => parse(suffix), e => e.status === 400, suffix);
  await assert.rejects(() => postSummary({ total: '1.00' }), e => e.status === 400);
  await assert.rejects(() => parse(`/documents/${docId}/summary`), e => e.status === 405);
  const listed = await executeDfeDistributionRoute(list, { userId: user, rpc: async () => ({ ...flags, channel_id: channelId, items: [stored] }) });
  assert.deepEqual(listed.body.items, [stored]);
  await assert.rejects(() => executeDfeDistributionRoute(list, { userId: user, rpc: async () => ({ ...flags, channel_id: channelId, items: [{ ...stored, document_id: '40000000-0000-4000-8000-000000000009' }] }) }), e => e.status === 502);
  await assert.rejects(() => executeDfeDistributionRoute(list, { userId: user, rpc: async () => ({ ...flags, can_query: true, channel_id: channelId, items: [] }) }), e => e.status === 502);
  // POST: object metadata, checked bytes, reauthorization, then the record of exactly the reading.
  const calls = [];
  const rpc = async (name, a) => { calls.push([name, a]); return name === 'erp_dfe_object' ? meta : { ...flags, summary: stored, recorded: true }; };
  const out = await executeDfeDistributionRoute(await postSummary(), { userId: user, rpc, fetchObject });
  assert.deepEqual(out, { type: 'json', body: { ...flags, summary: stored, recorded: true } });
  assert.deepEqual(calls.map(c => c[0]), ['erp_dfe_object', 'erp_dfe_object', 'erp_dfe_summary_record']);
  assert.deepEqual(calls[2][1], { p_document_id: docId, p_object_hash: sha, p_summary: { access_key: key, issue_date: '2026-10-15', total: '10.00', supplier_name: 'Fornecedor Sintético', supplier_document: SUPPLIER, situation: '3' }, p_user_id: user });
  // A recorded value that differs from the reading is an invalid answer; an earlier reading (recorded false) is kept.
  await assert.rejects(async () => executeDfeDistributionRoute(await postSummary(), { userId: user, fetchObject, rpc: async name => name === 'erp_dfe_object' ? meta : { ...flags, summary: { ...stored, total: '11.00' }, recorded: true } }), e => e.status === 502);
  const kept = await executeDfeDistributionRoute(await postSummary(), { userId: user, fetchObject, rpc: async name => name === 'erp_dfe_object' ? meta : { ...flags, summary: { ...stored, total: '11.00' }, recorded: false } });
  assert.equal(kept.body.summary.total, '11.00');
  // Altered bytes never reach the reader nor the database; events have no reading.
  const tampered = async () => new Response(new TextEncoder().encode('x'.repeat(bytes.length)), { headers: { 'Content-Type': 'application/octet-stream' } });
  const writes = [];
  await assert.rejects(async () => executeDfeDistributionRoute(await postSummary(), { userId: user, fetchObject: tampered, rpc: async (name, a) => { writes.push(name); return meta; } }), e => e.status === 502);
  assert.equal(writes.includes('erp_dfe_summary_record'), false);
  const eventMeta = { ...meta, document: { ...document, kind: 'event_summary', schema: 'resEvento_v1.01.xsd' }, filename: `EVENTO_NFE_${docId}.xml` };
  await assert.rejects(async () => executeDfeDistributionRoute(await postSummary(), { userId: user, fetchObject, rpc: async () => eventMeta }), e => e.status === 422);
});
