import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { espelhoHFixture, fails } from './helpers/espelho-h-fixture.mjs';
import { documentReportRoute, documentReportOperation, documentReportResponse } from '../src/document-reports.mjs';

// Leva H, lane espelho (362: VND-265, VND-266): Relatórios de Notas Fiscais over the real notes (imported XMLs and the Origin
// mirror) on PGlite, through the real Worker contract. Synthetic data only: fictitious parties, keys, protocols and values.
let f, seq = 0;
const NS = 'http://www.portalfiscal.inf.br/nfe';
const key = number => `35261011222333000181550010${String(number).padStart(8, '0')}1123456780`.slice(0, 44);
const xmlOf = ({ number, uf, difal = null, nature = 'Venda de mercadoria' }) => `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="4.00"><NFe xmlns="${NS}"><infNFe versao="4.00" Id="NFe${key(number)}">`
  + `<ide><natOp>${nature}</natOp><mod>55</mod><nNF>${number}</nNF></ide><dest><CNPJ>12345678000195</CNPJ><xNome>Cliente sintético</xNome><enderDest><UF>${uf}</UF></enderDest></dest>`
  + `<det nItem="1"><imposto>${difal ? `<ICMSUFDest><vICMSUFDest>${difal.dest}</vICMSUFDest></ICMSUFDest>` : ''}</imposto></det>`
  + `<total><ICMSTot><vProd>100.00</vProd>${difal ? `<vFCPUFDest>${difal.fcp}</vFCPUFDest><vICMSUFDest>${difal.dest}</vICMSUFDest><vICMSUFRemet>${difal.remet}</vICMSUFRemet>` : ''}<vNF>100.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
/** An imported exit XML (Importação de XML de saída, S, Registrada), stored as the import of 143 stores it. */
async function imported({ number = 1000 + ++seq, date = '2026-10-05', uf = 'RJ', name = 'Cliente XML', document = '12345678000195', nature = 'Venda de mercadoria', total = '100.00', difal = null, items = [], deleted = false, xml } = {}) {
  const id = randomUUID(), content = xml ?? xmlOf({ number, uf, difal, nature });
  await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,access_key,protocol,nature_description,issue_date,crt,purpose,presence,final_consumer,
    recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by,deleted_at,deleted_by,delete_reason)
    values($1,'55','1','S',null,8,1,$2,$3,'135260000000001',$4,$5,'3','1','9',false,$6,'[]','{}','{}','[]','{}',false,0,0,0,0,$7,$8,$8,$9,$10,$11)`,
  [id, number, key(number), nature, date, JSON.stringify({ name, person_type: 'J', document, state: uf }), JSON.stringify({ total }), f.users.admin,
    deleted ? new Date().toISOString() : null, deleted ? f.users.admin : null, deleted ? 'Teste sintético' : null]);
  await f.db.query("insert into erp_fiscal_invoices.invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by) values($1,$2,$3,$4,true,'100',$5)",
    [id, createHash('sha256').update(content, 'utf8').digest('hex'), Buffer.byteLength(content, 'utf8'), content, f.users.admin]);
  for (const [index, item] of items.entries()) await f.db.query("insert into erp_fiscal_invoices.invoice_item(invoice_id,position,quantity,unit_price,total,freight,insurance,other_expenses,discount,data) values($1,$2,$3,$4,$5,0,0,0,0,$6)",
    [id, index + 1, item.quantity, item.price, item.total, JSON.stringify({ code: item.code, description: item.description })]);
  return { id, number, key: key(number) };
}
/** A Origin note of the mirror (detail of /nfe or /nfce as the collector keeps it). */
const origin = (sourceId, { entity = 'nfe', number = 500 + ++seq, date = '2026-10-06 09:00:00', situacao = 5, tipo = 1, total = 50.25, uf = 'BA', name = 'Cliente Origin', document = '98.765.432/0001-98', nature = 77, items, chave } = {}) =>
  f.mirror(entity, sourceId, { id: Number(sourceId), numero: String(number).padStart(6, '0'), serie: '1', dataEmissao: date, tipo, situacao: { id: situacao }, valorNota: total,
    ...(chave ? { chaveAcesso: chave } : {}), contato: { id: 9, nome: name, numeroDocumento: document, endereco: { uf } }, ...(nature ? { naturezaOperacao: { id: nature } } : {}),
    itens: items ?? [{ codigo: 'P-1', descricao: 'Parafuso sintético', quantidade: 2, valor: 10, valorTotal: 20 }] });
const difal = (args, user = f.users.fiscal) => f.rpc('erp_fiscal_report_difal', { p_user_id: user, p_from: '2026-10-01', p_to: '2026-10-31', p_state: null, ...args });
const grouped = (report, args = {}, user = f.users.fiscal) => f.rpc('erp_fiscal_report_invoices', { p_user_id: user, p_report: report, p_from: '2026-10-01', p_to: '2026-10-31', p_model: null, ...args });
/** The answer through the Worker parser and contract, as GET /v1/documentos/sales_orders/notas-fiscais/<relatório>. */
async function worker(path, user = f.users.fiscal) {
  const url = new URL(`https://api.example.test/v1/documentos/sales_orders/notas-fiscais/${path}`), route = { ...documentReportRoute(url.pathname), id: null, action: 'report' };
  const operation = documentReportOperation(new Request(url), route, url.searchParams);
  return { operation, route, raw: await f.rpc(operation.rpc, { p_user_id: user, ...operation.args }), project(value) { return documentReportResponse(value, route, operation); } };
}

before(async () => {
  f = await espelhoHFixture();
  // Real notes of October 2026.
  await imported({ uf: 'RJ', name: 'Alfa XML', document: '11111111000191', total: '100.00', difal: { dest: '12.34', remet: '0.00', fcp: '2.00' }, items: [{ code: 'p-1', description: 'Parafuso sintético', quantity: '3', price: '10', total: '30.00' }, { code: 'X-9', description: 'Arruela', quantity: '1', price: '70', total: '70.00' }] });
  await imported({ uf: 'MG', name: 'Beta XML', document: '22222222000191', total: '200.00', nature: 'Venda para consumidor' });
  await origin('7001', { uf: 'RJ', total: 50.25 });
  await origin('7002', { uf: 'BA', total: 80, nature: null, document: '', name: 'Gama Origin' });
  await origin('7101', { entity: 'nfce', uf: 'SP', total: 15, nature: null, items: [{ codigo: 'P-1', descricao: 'Parafuso sintético', quantidade: 1, valorTotal: 10 }] });
  // Outside the faturamento: cancelled and denied Origin notes, an entry note, another month, a Origin copy of an XML note, a deleted XML, a native homologation note.
  await origin('7003', { situacao: 2 }); await origin('7004', { situacao: 9 }); await origin('7005', { tipo: 0 }); await origin('7006', { date: '2026-09-30 23:00:00' });
  const twin = await imported({ uf: 'SP', name: 'Delta XML', total: '40.00', difal: { dest: '1.00', remet: '0.50', fcp: '0.00' } });
  await origin('7007', { chave: twin.key, uf: 'SP', total: 40 });
  await imported({ deleted: true, total: '999.00' });
  await f.db.query(`insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
    values('55','1','N','2',6,1,77,'Venda homologação','2026-10-07','1','1','1',false,'{"state":"RJ"}','[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":"5000.00"}',$1,$1)`, [f.users.admin]);
});
after(() => f?.close());

test('362 entry points are SECURITY DEFINER for service_role only; helpers are closed; who reads the notes with Notas Fiscais reads the reports', async () => {
  for (const signature of ['public.erp_fiscal_report_difal(uuid,text,text,text)', 'public.erp_fiscal_report_invoices(uuid,text,text,text,text)']) {
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`, [signature]), false, signature);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [signature]), true, signature);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [signature]), true, signature);
    assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure', [signature]), ['search_path=pg_catalog'], signature);
  }
  for (const helper of ['erp_fiscal_invoices.report_notes(date,date)', 'erp_fiscal_invoices.report_difal_xml(text)', 'erp_fiscal_invoices.report_sources(integer,integer)'])
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [helper]), false, helper);
  for (const user of ['admin', 'consulta', 'fiscal']) assert.equal((await difal({}, f.users[user])).report, 'difal', user);
  for (const user of ['vendas', 'estoque', 'financeiro', 'inactive']) { await fails(assert, () => difal({}, f.users[user]), '42501'); await assert.rejects(grouped('billing', {}, f.users[user]), e => e.code === '42501', user); }
  // A saved permission set without Notas Fiscais (only Notas de Entrada) keeps the sales notes out.
  await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',$2,1,clock_timestamp(),$3)",
    [f.users.consulta, ['suprimentos', 'suprimentos.notas_entrada'], f.users.admin]);
  await assert.rejects(difal({}, f.users.consulta), e => e.code === '42501');
  await f.db.query('delete from erp_access.user_control where user_id=$1', [f.users.consulta]);
  for (const bad of [{ p_from: '2026-10-31', p_to: '2026-10-01' }, { p_from: '2025-01-01', p_to: '2026-10-31' }, { p_from: '2026-02-30' }, { p_state: 'XX' }]) await assert.rejects(difal(bad), e => e.code === '22023', JSON.stringify(bad));
  await assert.rejects(grouped('outro'), e => e.code === '22023'); await assert.rejects(grouped('contact', { p_model: '57' }), e => e.code === '22023');
  await assert.rejects(grouped('contact', { p_from: '2025-01-01' }), e => e.code === '22023', 'one year for the groups');
  assert.equal((await grouped('billing', { p_from: '2025-01-01' })).groups.length, 22, 'two years for the Evolução');
});

test('362 ICMS DIFAL: values only from the XMLs, Origin notes counted without detail, indisponível instead of zero, coverage and sync date', async () => {
  const out = await difal({});
  assert.deepEqual([out.totals.notes, out.totals.detailed, out.coverage], [5, 3, { notes: 5, covered: 3 }], 'XML RJ, XML MG, XML SP (Origin twin dropped), Origin RJ and BA; NFC-e, cancelled, denied, entry, September, deleted and homologation out');
  assert.deepEqual([out.totals.dest, out.totals.remet, out.totals.fcp, out.totals.amount], ['13.34', '0.50', '2.00', '470.25']);
  const by = Object.fromEntries(out.groups.map(g => [g.state, g]));
  assert.deepEqual(Object.keys(by), ['BA', 'MG', 'RJ', 'SP']);
  assert.deepEqual(by.RJ, { state: 'RJ', notes: 2, detailed: 1, without_detail: 1, amount: '150.25', dest: '12.34', remet: '0.00', fcp: '2.00' });
  assert.deepEqual([by.MG.detailed, by.MG.dest], [1, '0.00'], 'an XML without the partilha group declares no DIFAL');
  assert.deepEqual([by.BA.detailed, by.BA.dest, by.BA.remet, by.BA.fcp, by.BA.amount], [0, null, null, null, '80.00'], 'only Origin notes: indisponível, never zero');
  const rows = out.rows.map(r => [r.origin, r.state, r.detail, r.dest]);
  assert.deepEqual(rows.filter(r => r[0] === 'origin').map(r => r.slice(1)), [['RJ', false, null], ['BA', false, null]]);
  assert.equal(out.sources.origin_notes + out.sources.xml_notes, 5); assert.ok(Date.parse(out.sources.origin_synced_at) > 0); assert.ok(Date.parse(out.sources.xml_imported_at) > 0);
  const rj = await difal({ p_state: 'RJ' });
  assert.deepEqual([rj.state, rj.totals.notes, rj.groups.length], ['RJ', 2, 1]);
  const empty = await difal({ p_from: '2026-08-01', p_to: '2026-08-31' });
  assert.deepEqual([empty.totals, empty.coverage, empty.groups, empty.rows], [{ notes: 0, detailed: 0, amount: null, dest: null, remet: null, fcp: null }, { notes: 0, covered: 0 }, [], []]);
  // Worker contract.
  const w = await worker('difal?from=2026-10-01&to=2026-10-31');
  assert.deepEqual([w.operation.rpc, w.operation.args], ['erp_fiscal_report_difal', { p_from: '2026-10-01', p_to: '2026-10-31', p_state: null }]);
  const projected = w.project(w.raw);
  assert.deepEqual([projected.report, projected.kind, projected.totals.dest, projected.groups.length], ['difal', 'sales_orders', '13.34', 4]);
  const tamper = (mutate) => { const copy = structuredClone(w.raw); mutate(copy); return () => w.project(copy); };
  for (const [label, mutate] of [['zero for missing', v => { v.groups.find(g => g.state === 'BA').dest = '0.00'; }], ['detail on a Origin row', v => { v.rows.find(r => r.origin === 'origin').detail = true; }],
    ['coverage', v => { v.coverage.covered = 9; }], ['extra field', v => { v.extra = 1; }], ['effects', v => { v.operational_effects = true; }], ['sources', v => { v.sources.origin_notes = 99; }],
    ['row outside the period', v => { v.rows[0].issue_date = '2026-11-01'; }], ['totals', v => { v.totals.detailed = 1; }]]) assert.throws(tamper(mutate), e => e.status === 502, label);
  for (const query of ['from=2026-10-01', 'from=2026-10-01&to=2026-10-31&state=XX', 'from=2026-10-01&to=2026-10-31&model=55', 'from=2026-10-01&to=2026-10-31&from=2026-10-02', 'from=2025-01-01&to=2026-10-31'])
    assert.throws(() => documentReportOperation(new Request(`https://api.example.test/x?${query}`), { kind: 'sales_orders', report: 'notas-fiscais/difal' }, new URLSearchParams(query)), e => e.status === 400, query);
  assert.throws(() => documentReportOperation(new Request('https://api.example.test/x', { method: 'POST' }), { kind: 'sales_orders', report: 'notas-fiscais/difal' }, new URLSearchParams()), e => e.status === 405);
  assert.equal(documentReportRoute('/v1/documentos/service_orders/notas-fiscais/difal'), null);
});

test('362 por Operação, por Cliente, por Produto and Evolução do Faturamento: real notes once, origin and coverage of each report', async () => {
  const op = await grouped('operation');
  assert.deepEqual(op.groups.map(g => [g.label, g.notes, g.amount, g.xml_notes, g.origin_notes]),
    [['Venda para consumidor', 1, '200.00', 1, 0], ['Venda de mercadoria', 2, '140.00', 2, 0], [null, 2, '95.00', 0, 2], ['Natureza Origin #77', 1, '50.25', 0, 1]]);
  assert.deepEqual([op.totals, op.coverage], [{ notes: 6, amount: '485.25' }, { notes: 6, covered: 4 }], 'the NFC-e and the Origin note without natureza are outside the coverage');
  assert.deepEqual((await grouped('operation', { p_model: '65' })).groups.map(g => [g.notes, g.amount]), [[1, '15.00']]);
  const contact = await grouped('contact');
  // The Origin NF-e and NFC-e of the same CNPJ are one client; a client without CPF/CNPJ is grouped by name.
  assert.deepEqual(contact.groups.map(g => [g.label, g.document, g.notes, g.amount]),
    [['Beta XML', '22222222000191', 1, '200.00'], ['Alfa XML', '11111111000191', 1, '100.00'], ['Gama Origin', null, 1, '80.00'], ['Cliente Origin', '98765432000198', 2, '65.25'], ['Delta XML', '12345678000195', 1, '40.00']]);
  assert.equal(contact.coverage.covered, 6);
  const product = await grouped('product');
  assert.deepEqual(product.groups.map(g => [g.key, g.label, g.document, g.notes, g.quantity, g.amount, g.xml_notes, g.origin_notes]),
    [['code:P-1', 'Parafuso sintético', 'P-1', 4, '8', '80.00', 1, 3], ['code:X-9', 'Arruela', 'X-9', 1, '1', '70.00', 1, 0]]);
  assert.deepEqual(product.coverage, { notes: 6, covered: 4 }, 'the XMLs of Beta and Delta have no items stored');
  const billing = await grouped('billing', { p_from: '2026-08-01', p_to: '2026-10-31' });
  assert.deepEqual(billing.groups.map(g => [g.key, g.label, g.notes, g.amount, g.xml_notes, g.origin_notes]),
    [['2026-08', '08/2026', 0, '0.00', 0, 0], ['2026-09', '09/2026', 1, '50.25', 0, 1], ['2026-10', '10/2026', 6, '485.25', 3, 3]]);
  // A Origin note without valorNota counts as a note, never as zero: the month without any value is indisponível.
  await origin('7201', { date: '2026-07-10 08:00:00', total: null });
  const july = await grouped('billing', { p_from: '2026-07-01', p_to: '2026-07-31' });
  assert.deepEqual([july.groups[0].notes, july.groups[0].amount, july.totals.amount, july.coverage], [1, null, null, { notes: 1, covered: 0 }]);
  // Worker contract for each report.
  for (const [path, report] of [['operacao', 'operation'], ['cliente', 'contact'], ['produto', 'product'], ['evolucao', 'billing']]) {
    const w = await worker(`${path}?from=2026-08-01&to=2026-10-31&model=55`);
    assert.deepEqual(w.operation.args, { p_report: report, p_from: '2026-08-01', p_to: '2026-10-31', p_model: '55' });
    const projected = w.project(w.raw);
    assert.deepEqual([projected.report, projected.model, projected.data_mode], [report, '55', 'erp_native']);
    assert.throws(() => w.project({ ...w.raw, model: null }), e => e.status === 502, path);
    assert.throws(() => w.project({ ...w.raw, totals: { ...w.raw.totals, notes: w.raw.totals.notes + 1 } }), e => e.status === 502, path);
  }
  const w = await worker('evolucao?from=2026-08-01&to=2026-10-31');
  assert.throws(() => w.project({ ...w.raw, groups: w.raw.groups.slice(1), group_count: 2 }), e => e.status === 502, 'every month of the period');
  assert.throws(() => w.project({ ...w.raw, groups: w.raw.groups.map(g => g.notes === 0 ? { ...g, amount: null } : g) }), e => e.status === 502, 'a month without notes is a real zero');
});
