import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { COMPANY_CNPJ, fiscalWaveFFixture, migrationText } from './helpers/fiscal-wave-f-fixture.mjs';
import { nativeXmlResponse, saoPauloNow } from '../src/fiscal-invoices.mjs';
import { checkNfeSchema } from '../../../packages/fiscal-xml/src/schema-check.mjs';

// 202610200273 on PGlite over every migration applied in production (synthetic data only): the source of the native XML of a note of
// the Brufap, through the real Worker handler, with the company extra data, the predicted number and the refusals.
let f, sale, buy;
let numbers = 720000;
const today = saoPauloNow().date;
before(async () => {
  f = await fiscalWaveFFixture({ upto: '202610200273' });
  await f.company({ extra: { person_type: 'juridica', ie_exempt: true, municipal_registration: '99887', cnae: '4744-0/01', substitute_ies: [{ uf: 'RJ', ie: '12345678' }] } });
  sale = await f.nature({ description: 'Venda nativa', direction: '1', crt: '1' });
  buy = await f.nature({ description: 'Compra nativa', direction: '0', crt: '1', presence: '9' });
  await f.db.query("insert into erp_fiscal_numbering.series(issuer_cnpj,cuf,model,environment,series,first_number,next_number,version,identity_version,enabled,exclusive_use_confirmed,reference) values($1,'35','55','2',2,1,57,1,1,true,true,'sintética')", [COMPANY_CNPJ]);
});
after(() => f?.close());
const recipient = { name: 'Comprador Sintético', person_type: 'J', document: '12345678000195', ie: '535123456789', ie_indicator: '1', postal_code: '13400000', street: 'Rua Sintética', number: '100', district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP' };
const item = { description: 'Parafuso sintético', code: 'P-1', unit: 'UN', quantity: '10', unit_price: '2.5', ncm: '73181500', gtin: '7891234567895', cfop: '5102', icms: { origin: '0', situation: '102' },
  pis: { situation: '49', base: '0', rate: '0', value: '0' }, cofins: { situation: '49', base: '0', rate: '0', value: '0' } };
const note = (over = {}) => f.invoice({ model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: sale.id, issue_date: today, crt: '1', purpose: '1', presence: '1', final_consumer: false, recipient, items: [item],
  payment: { installments: [{ date: today, amount: '25.00', method: '01' }] }, ...over });
const get = (invoice, user = f.users.fiscal) => f.call(`/v1/notas-fiscais/${invoice.id}/xml-nativo`, 'GET', undefined, user);

test('273: the entry point is service-only SECURITY DEFINER with search_path, the helper is closed, and only admin and fiscal read it', async () => {
  const sig = 'public.erp_fiscal_invoice_xml_source(uuid,uuid)';
  assert.deepEqual((await f.db.query('select prosecdef,proconfig from pg_proc where oid=to_regprocedure($1)', [sig])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  for (const role of ['public', 'anon', 'authenticated']) assert.equal(await f.scalar("select has_function_privilege($1,$2,'EXECUTE') v", [role === 'public' ? 'anon' : role, sig]), false, role);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [sig]), true);
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_fiscal_invoices.company_text(jsonb,text,integer)','EXECUTE') v"), false);
  assert.match(await migrationText('202610200273_fiscal_native_xml_source.sql'), /^-- 273[\s\S]*\nbegin;[\s\S]*\ncommit;\n$/);
  const own = await note();
  for (const user of ['consulta', 'vendas', 'financeiro', 'estoque']) assert.equal((await get(own, f.users[user])).status, 403, user);
  for (const user of ['admin', 'fiscal']) assert.equal((await get(own, f.users[user])).status, 200, user);
});

test('273: Validar builds the XML with the predicted number, never reserves it, and carries the company data the identity keeps', async () => {
  const own = await note();
  const before = await f.scalar("select next_number::integer v from erp_fiscal_numbering.series where model='55' and series=2");
  const { status, value } = await get(own);
  assert.equal(status, 200);
  assert.deepEqual([value.number, value.number_provisional, value.numbering_reserved, value.signed, value.transmitted, value.environment, value.series], [57, true, false, false, false, '2', 2]);
  assert.equal(await f.scalar("select next_number::integer v from erp_fiscal_numbering.series where model='55' and series=2"), before, 'the series keeps its next number');
  assert.deepEqual(value.schema.errors, []); assert.equal(value.schema.profile, 'pl010f-v1.04');
  assert.equal(value.valid, true, JSON.stringify(value.rules));
  assert.deepEqual(checkNfeSchema(value.xml).errors, [], 'the XML handed over follows the layout');
  assert.match(value.xml, /<emit><CNPJ>11222333000181<\/CNPJ>.*<IE>ISENTO<\/IE><IM>99887<\/IM><CNAE>4744001<\/CNAE><CRT>1<\/CRT><\/emit>/);
  assert.match(value.xml, /<nNF>57<\/nNF>/); assert.equal(value.access_key.slice(25, 34), '000000057');
  assert.equal(value.xml_bytes, Buffer.byteLength(value.xml)); assert.match(value.xml_sha256, /^[0-9a-f]{64}$/);
  // Nothing about the note changes: same version, no number, no key.
  assert.deepEqual(Object.values((await f.db.query('select version,number,access_key from erp_fiscal_invoices.invoice where id=$1', [own.id])).rows[0]), [own.version, null, null]);
});

test('273: registered and deleted notes are refused, and a forged source answers 502', async () => {
  const registered = await f.invoice({ model: '55', direction: '0', issue_type: 'T', number: String(++numbers), series: '1', nature_id: buy.id, issue_date: today, crt: '1', purpose: '1', presence: '9', final_consumer: false,
    recipient, items: [{ ...item, cfop: '1102' }], payment: { installments: [] } });
  assert.equal((await get(registered)).status, 400);
  const own = await note();
  await f.rpc('erp_fiscal_invoice_execute', { p_user_id: f.users.fiscal, p_command_id: randomUUID(), p_action: 'delete', p_data: { id: own.id, expected_version: own.version, reason: 'Exclusão sintética' } });
  assert.equal((await get(own)).status, 400);
  assert.equal((await f.call(`/v1/notas-fiscais/${randomUUID()}/xml-nativo`)).status, 404);
  assert.equal((await f.call(`/v1/notas-fiscais/${own.id}/xml-nativo?x=1`)).status, 400);
  assert.equal((await f.call(`/v1/notas-fiscais/${own.id}/xml-nativo`, 'POST', {})).status, 405);
  const fresh = await note(), raw = await f.rpc('erp_fiscal_invoice_xml_source', { p_user_id: f.users.fiscal, p_id: fresh.id });
  await nativeXmlResponse(raw, fresh.id);
  const forged = async change => { const copy = structuredClone(raw); change(copy); await assert.rejects(nativeXmlResponse(copy, fresh.id), error => error.status === 502); };
  await forged(v => { v.emitter.person_type = 'outra'; });
  await forged(v => { v.emitter.substitute_ies = [{ uf: 'RJ', ie: '1' }, { uf: 'RJ', ie: '22' }]; });
  await forged(v => { v.numbering.series = 9; });
  await forged(v => { v.envelope.invoice.id = randomUUID(); });
  await forged(v => { v.data_mode = 'erp_native'; });
  await forged(v => { v.emitter.address.extra = 'x'; });
  await assert.rejects(nativeXmlResponse(raw, randomUUID()), error => error.status === 502);
});

test('273: before the migration the route answers an error and nothing else changes (database first)', async () => {
  const old = await fiscalWaveFFixture({ upto: '0' });
  try {
    await old.company();
    const nature = await old.nature({ description: 'Venda antiga', direction: '1', crt: '1' });
    const own = await old.invoice({ model: '55', direction: '1', issue_type: 'N', series: '2', nature_id: nature.id, issue_date: today, crt: '1', purpose: '1', presence: '1', final_consumer: false, recipient, items: [item], payment: { installments: [] } });
    const answer = await old.call(`/v1/notas-fiscais/${own.id}/xml-nativo`);
    assert.ok(answer.status >= 400 && answer.status < 600 && answer.status !== 200);
    assert.equal((await old.call(`/v1/notas-fiscais/${own.id}`)).status, 200, 'the note itself keeps opening');
  } finally { await old.close(); }
});
