import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { render, GRAMMAR_FILE } from '../../../tools/fiscal/compile-nfe-schema.mjs';
import { checkNfeSchema, schemaErrorText, schemaXml, SchemaError } from '../../../packages/fiscal-xml/src/schema-check.mjs';
import { HOMOLOGATION_PRODUCT, HOMOLOGATION_RECIPIENT, NativeInvoiceError, layoutText, nativeInvoiceXml, validateNativeInvoice } from '../../../packages/fiscal-xml/src/native-invoice.mjs';
import { buildBusinessXml } from '../../../packages/fiscal-xml/src/business-builder.mjs';
import { businessFixture } from '../../../packages/fiscal-core/test/business-fixtures.mjs';
import { record, source, item, recipient } from '../../../packages/fiscal-xml/test/native-invoice-fixtures.mjs';

// Wave F of the notas fiscais lane (synthetic data only): the grammar compiled from the pinned XSDs of PL 010f v1.04, the schema check
// in JavaScript and the native XML of a note of the Brufap ("Validar" and "Gerar XML (suporte)").
const pick = (xml, tag) => (xml.match(new RegExp(`<${tag}>.*?</${tag}>`)) ?? [null])[0];
const codes = result => result.errors.map(e => `${e.code}:${e.path}${e.name ? `:${e.name}` : ''}`);

test('the checked-in grammar is exactly what the generator compiles from the pinned XSDs', async () => {
  const current = (await readFile(GRAMMAR_FILE, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(current, await render(), 'run node tools/fiscal/compile-nfe-schema.mjs');
  const grammar = (await import('../../../packages/fiscal-xml/src/nfe-schema-pl010f.mjs')).default;
  assert.equal(grammar.profile, 'pl010f-v1.04'); assert.deepEqual(grammar.elements, { NFe: 'TNFe' });
});

test('the schema check accepts what the official XSD accepts (the business builder XMLs) and refuses order, presence and values', () => {
  for (const options of [{ model: '55', csosn: '101' }, { model: '55', csosn: '102' }, { model: '55', csosn: '500' }, { model: '65', csosn: '102' }, { model: '65', csosn: '500' }, { count: 2, discount: '0.03', freight: '1.01', other: '0.01' }]) {
    const xml = buildBusinessXml(businessFixture(options)).unsignedXml;
    assert.deepEqual(checkNfeSchema(xml).errors, [], JSON.stringify(options));
    assert.deepEqual(codes(checkNfeSchema(xml, { signature: 'required' })), ['missing:/NFe:Signature'], 'a signed document must carry the signature');
  }
  const xml = buildBusinessXml(businessFixture({ model: '55', csosn: '101' })).unsignedXml;
  const check = changed => { assert.notEqual(changed, xml); return codes(checkNfeSchema(changed)); };
  assert.deepEqual(check(xml.replace(/(<cNF>\d+<\/cNF>)(<natOp>[^<]*<\/natOp>)/, '$2$1')), ['missing:/NFe/infNFe/ide:cNF']);
  assert.deepEqual(check(xml.replace(/<cMunFG>\d+<\/cMunFG>/, '')), ['missing:/NFe/infNFe/ide:cMunFG']);
  assert.deepEqual(check(xml.replace(/<NCM>\d+<\/NCM>/, '<NCM>123</NCM>')), ['value:/NFe/infNFe/det/prod/NCM']);
  assert.deepEqual(check(xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>3</tpAmb>')), ['value:/NFe/infNFe/ide/tpAmb']);
  assert.deepEqual(check(xml.replace('</ide>', '<extra>1</extra></ide>')), ['unexpected:/NFe/infNFe/ide:extra']);
  assert.deepEqual(check(xml.replace('versao="4.00"', 'versao="3.10"')), ['attribute_value:/NFe/infNFe/@versao:versao']);
  assert.deepEqual(check(xml.replace('<ide>', '<ide xmlns="urn:outro">')), ['namespace:/NFe/infNFe:ide']);
  assert.deepEqual(check(xml.replace(/(<det nItem="1">.*?<\/det>)/, '$1$1')), ['unique:/NFe/infNFe/det[@nItem=1]:nItem']);
  assert.deepEqual(check(xml.replace(/<det nItem="1">.*?<\/det>/, '')), ['missing:/NFe/infNFe:det']);
  assert.equal(schemaErrorText(checkNfeSchema(xml.replace(/<cMunFG>\d+<\/cMunFG>/, '')).errors[0]), 'Falta o campo cMunFG em /NFe/infNFe/ide (antes de tpImp).');
  for (const forbidden of [`<!DOCTYPE NFe [<!ENTITY a "b">]>${xml}`, `<?xml-stylesheet href="x"?>${xml}`, '<NFe', ''])
    assert.throws(() => checkNfeSchema(forbidden), SchemaError);
  assert.deepEqual(codes(checkNfeSchema('<cteProc xmlns="http://www.portalfiscal.inf.br/cte"/>')), ['unexpected:/cteProc:cteProc']);
});

test('the native XML of a note of the Brufap follows the layout in every tax group the note keeps', () => {
  const crt3 = { emitter: { crt: '3' } };
  const scenarios = {
    simples: [record(), {}],
    normal: [record({ crt: '3', items: [item({ icms: { origin: '0', situation: '00', bc_mode: '3', base: '25', rate: '18', value: '4.5' }, pis: { situation: '01', base: '25', rate: '1.65', value: '0.41' },
      cofins: { situation: '01', base: '25', rate: '7.6', value: '1.9' }, ipi: { situation: '50', base: '25', rate: '10', value: '2.5', framing_code: '999' } })] }), crt3],
    many: [record({ crt: '3', items: [
      item({ code: 'A', icms: { origin: '0', situation: '20', bc_mode: '3', base_rate: '61.1100', base: '15.28', rate: '18', value: '2.75', deson_value: '1.75', deson_reason: '9' } }),
      item({ code: 'B', icms: { origin: '1', situation: '51', bc_mode: '3', base: '25', rate: '18', deferral_rate: '33.33', value: '3.00' } }),
      item({ code: 'C', icms: { origin: '0', situation: '60', ret_base: '25', ret_rate: '18', ret_value: '4.5' } }),
      item({ code: 'D', icms: { origin: '0', situation: '70', bc_mode: '3', base_rate: '80', base: '20', rate: '18', value: '3.6', st_bc_mode: '4', st_mva: '30', st_base_rate: '80', st_base: '26', st_rate: '18', st_value: '1.08' } }),
      item({ code: 'E', icms: { origin: '0', situation: '90' }, pis: { situation: '99', base: '25', rate: '0.65', value: '0.16' }, cofins: { situation: '04' } }),
      item({ code: 'F', icms: { origin: '0', situation: '41' }, pis: { situation: '03', unit_value: '0.1', value: '1.00' }, cofins: { situation: '06' }, ipi: { situation: '53', framing_code: '301' } }),
      item({ code: 'G', icms: { origin: '0', situation: '02', mono_qty: '10', mono_rate: '1.4', mono_value: '14.00' } })],
      payment: { installments: [] }, transport: { mode: 'manual', freight_by: '0', carrier: { name: 'Transportadora', document: '98765432000198', ie: '110042490114', state: 'SP', city: 'Campinas', address: 'Rua 1' },
        vehicle: { plate: 'ABC1D23', state: 'SP' }, volumes: { quantity: '2', species: 'caixas', net_weight: '1.5', gross_weight: '2' } },
      authorized_xml: [{ document: '98765432000198' }], additional_info: 'Linha 1\nLinha 2 – com travessão', references: [{ type: 'nf01', year_month: '2609', number: '12', series: '1' }], freight: '3', discount: '1' }), crt3],
    simples_st: [record({ items: [item({ icms: { origin: '0', situation: '101', credit_rate: '2.5', credit_value: '0.63' } }), item({ code: 'X', icms: { origin: '0', situation: '500', ret_base: '25', ret_rate: '18', ret_value: '4.5' } }),
      item({ code: 'Y', icms: { origin: '0', situation: '900', base: '25', rate: '18', value: '4.5' } }), item({ code: 'Z', icms: { origin: '0', situation: '201', st_bc_mode: '4', st_mva: '40', st_base: '35', st_rate: '18', st_value: '1.8', credit_rate: '2', credit_value: '0.5' } })],
      payment: { installments: [{ date: '2026-11-20', amount: '50.90', method: '03', card: { integration: '2', brand: '01', authorization: 'A1' } }, { date: '2026-12-20', amount: '50.90', method: '99', note: 'Crédito loja' }] } }), {}],
    difal: [record({ final_consumer: true, recipient: recipient({ person_type: 'F', document: '52998224725', ie: null, ie_indicator: '9', state: 'MG', municipality_code: '3106200', city: 'Belo Horizonte' }),
      items: [item({ cfop: '6108', icms: { origin: '0', situation: '102', difal_type: 'N', difal_base: '25', difal_internal_rate: '18', difal_interstate_rate: '12.0000', difal_share_rate: '100', difal_dest_value: '1.50', difal_origin_value: '0.00', difal_fcp_rate: '2', difal_fcp_value: '0.50' } })] }), {}],
    devolucao: [record({ purpose: '4', references: [{ type: 'nfe', key: '35261012345678000195550010000003211123456780' }], items: [item({ cfop: '5202', ipi: { situation: '99', base: '0', rate: '0', value: '0', devol_rate: '100', devol_value: '2.50' } })], payment: { installments: [] } }), {}],
    importacao: [record({ direction: '0', issue_type: 'I', cfop: '3102', recipient: { name: 'Supplier', person_type: 'E', foreign_id: 'XY99999', street: 'Rue', number: '2', district: 'Centre', city: 'Paris', state: 'EX', country: 'França' },
      import_declaration: { number: '2612345678', registration_date: '2026-10-10', clearance_place: 'Santos', clearance_state: 'SP', clearance_date: '2026-10-12', transport_route: '1', intermediation: '1', exporter_code: 'EXP1', additions: [{ number: '1', sequence: '1', manufacturer: 'FAB' }] },
      items: [item({ cfop: '3102', ii: { situation: 'T', base: '25', rate: '10', value: '2.50', customs_expense: '1.00' } })], payment: { installments: [] } }), {}],
    nfce: [record({ model: '65', issue_type: 'C', presence: '1', final_consumer: true, recipient: {}, items: [item(), item({ code: 'P-2' })], payment: { installments: [{ date: '2026-10-20', amount: '50.00', method: '01' }] } }), {}],
  };
  for (const [name, [invoice, over]] of Object.entries(scenarios)) {
    const result = validateNativeInvoice(source(invoice, over));
    assert.deepEqual(result.schema.errors, [], name);
    assert.equal(pick(result.xml, 'tpAmb'), '<tpAmb>2</tpAmb>', `${name} is always homologation`);
    assert.equal(result.xml.includes('<Signature'), false, `${name} is not signed`);
    assert.equal(result.number, 41, 'the predicted next number of the series');
  }
  const many = validateNativeInvoice(source(scenarios.many[0], crt3));
  assert.equal(pick(many.xml, 'infCpl'), '<infCpl>Linha 1 Linha 2 - com travessão</infCpl>', 'line breaks and typography follow the Latin-1 text of the layout');
  assert.match(many.xml, /<vFrete>3\.00<\/vFrete>.*<vDesc>1\.00<\/vDesc>/);
  assert.match(pick(many.xml, 'ICMSTot'), /<qBCMono>10\.00<\/qBCMono><vICMSMono>14\.00<\/vICMSMono>/);
  assert.match(many.xml, /<ICMS20><orig>0<\/orig><CST>20<\/CST><modBC>3<\/modBC><pRedBC>38\.8900<\/pRedBC>/, 'pRedBC is 100 - % Base');
  const nfce = validateNativeInvoice(source(scenarios.nfce[0]));
  assert.equal(pick(nfce.xml, 'dest'), null, 'consumidor não identificado');
  assert.match(nfce.xml, new RegExp(`<xProd>${HOMOLOGATION_PRODUCT}</xProd>`)); assert.match(nfce.xml, /<infNFeSupl><qrCode>https:\/\/www\.homologacao\.nfce\.fazenda\.sp\.gov\.br\/qrcode\?p=\d{44}\|3\|2<\/qrCode>/);
  assert.match(nfce.xml, /<tpImp>4<\/tpImp>/);
  const simples = validateNativeInvoice(source(scenarios.simples[0]));
  assert.match(pick(simples.xml, 'dest'), new RegExp(`<xNome>${HOMOLOGATION_RECIPIENT}</xNome>`));
  assert.equal(simples.access_key.slice(20, 22), '55'); assert.equal(simples.access_key.slice(22, 25), '002'); assert.equal(simples.access_key.slice(25, 34), '000000041');
  assert.equal(simples.cnf.length, 8); assert.notEqual(simples.cnf, '00000041');
  assert.match(simples.xml, new RegExp(`<cDV>${simples.access_key.at(-1)}</cDV>`));
});

test('Empresa: Tipo da Pessoa, Isento, IM, CNAE, Suframa and the IE of the substituto tributário go to the emitter group', () => {
  const st = record({ crt: '3', recipient: recipient({ state: 'RJ', municipality_code: '3304557', city: 'Rio de Janeiro' }),
    items: [item({ cfop: '6403', icms: { origin: '0', situation: '10', bc_mode: '3', base: '25', rate: '12', value: '3', st_bc_mode: '4', st_mva: '40', st_base: '35', st_rate: '20', st_value: '4' } })] });
  const company = { crt: '3', substitute_ies: [{ uf: 'RJ', ie: '12345678' }, { uf: 'MG', ie: '0012345678' }], ie_exempt: true, municipal_registration: '12.345-6', cnae: '4744-0/01', suframa: '123456789' };
  const r = validateNativeInvoice(source(st, { emitter: company }));
  assert.deepEqual(r.schema.errors, []);
  assert.match(pick(r.xml, 'emit'), /<IE>ISENTO<\/IE><IEST>12345678<\/IEST><IM>12.345-6<\/IM><CNAE>4744001<\/CNAE><CRT>3<\/CRT><ISUFEmit>123456789<\/ISUFEmit><\/emit>$/);
  // No ST to that UF: no IEST. An IE ST of another UF never goes.
  const internal = validateNativeInvoice(source(record({ crt: '3', items: [item({ icms: { origin: '0', situation: '00', bc_mode: '3', base: '25', rate: '18', value: '4.5' } })] }), { emitter: company }));
  assert.equal(pick(internal.xml, 'IEST'), null);
  // CNAE without IM stays out (the layout ties it to the IM) and says so.
  const cnaeOnly = validateNativeInvoice(source(record(), { emitter: { cnae: '4744-0/01' } }));
  assert.equal(pick(cnaeOnly.xml, 'CNAE'), null); assert.ok(cnaeOnly.rules.some(x => x.code === 'emitter_cnae' && x.severity === 'warning'));
  // ST for an UF without the IE of the substituto: a warning, no IEST.
  const noIest = validateNativeInvoice(source(st, { emitter: { crt: '3' } }));
  assert.ok(noIest.rules.some(x => x.code === 'emitter_iest'));
  // Pessoa Física writes the CPF of the emitter, and the access key carries it with three zeros.
  const pf = validateNativeInvoice(source(record(), { emitter: { person_type: 'fisica', document: '52998224725' } }));
  assert.deepEqual(pf.schema.errors, []); assert.match(pick(pf.xml, 'emit'), /^<emit><CPF>52998224725<\/CPF>/); assert.equal(pf.access_key.slice(6, 20), '00052998224725');
  // Pessoa Física with the CNPJ of the identity is refused by the rule, never written as a CNPJ.
  const wrong = validateNativeInvoice(source(record(), { emitter: { person_type: 'fisica' } }));
  assert.ok(wrong.rules.some(x => x.code === 'emitter_cpf' && x.severity === 'error')); assert.equal(wrong.valid, false);
  // Suframa of 10+ digits does not fit ISUFEmit.
  assert.ok(validateNativeInvoice(source(record(), { emitter: { suframa: '1234567890' } })).rules.some(x => x.code === 'emitter_suframa'));
});

test('the offline rules name what SEFAZ would refuse, and the result is never valid with an error', () => {
  const bad = record({ items: [item({ gtin: '7891234567890', ncm: null, cfop: '6102' })], recipient: recipient({ document: '12345678000100', municipality_code: '3304557' }) });
  const r = validateNativeInvoice(source(bad, { emitter: { ie: null }, numbering: { next_number: null, enabled: null } }));
  assert.equal(r.valid, false);
  for (const code of ['item_gtin', 'item_cfop', 'item_ncm', 'emitter_ie', 'recipient_document', 'recipient_municipality', 'numbering_missing']) assert.ok(r.rules.some(x => x.code === code), code);
  assert.equal(r.number, 1);
  assert.deepEqual(r.schema.errors.map(e => e.message), ['Falta o campo NCM em /NFe/infNFe/det/prod (antes de CFOP).']);
  const exp = validateNativeInvoice(source(record({ issue_type: 'E', export: { exit_state: 'SP', exit_place: 'Porto de Santos' }, recipient: { name: 'Buyer', person_type: 'E', foreign_id: 'AB12345', street: 'Main St', number: '1', district: 'Downtown', city: 'Miami', state: 'EX', country: 'Estados Unidos' },
    items: [item({ cfop: '7102', export: { drawback: '123' } })], payment: { installments: [] } })));
  assert.deepEqual(exp.schema.errors, []); assert.ok(exp.rules.some(x => x.code === 'recipient_country' && x.severity === 'error'));
  assert.match(exp.xml, /<exporta><UFSaidaPais>SP<\/UFSaidaPais><xLocExporta>Porto de Santos<\/xLocExporta><\/exporta>/);
  const future = validateNativeInvoice(source(record({ issue_date: '2026-10-25' })));
  assert.ok(future.rules.some(x => x.code === 'issue_date_future'));
  const nfceCarrier = validateNativeInvoice(source(record({ model: '65', issue_type: 'C', presence: '1', final_consumer: true, recipient: {}, transport: { mode: 'manual', freight_by: '0', carrier: { name: 'T' } }, payment: { installments: [] } })));
  assert.ok(nfceCarrier.rules.some(x => x.code === 'nfce_transport')); assert.ok(nfceCarrier.rules.some(x => x.code === 'payment_missing'));
  assert.throws(() => nativeInvoiceXml(source(record({ issue_type: 'T', number: '15' }))), NativeInvoiceError);
  assert.throws(() => nativeInvoiceXml({ ...source(), now: { date: 'x' } }), NativeInvoiceError);
  assert.equal(layoutText(' a\r\n b  c '), 'a b c'); assert.equal(layoutText(''), null);
});

test('the layout writer orders by the schema and refuses names the layout does not have', () => {
  const xml = schemaXml({ infNFe: { '@Id': 'NFe1', ide: { tpAmb: '2', cUF: '35' } } });
  assert.match(xml, /<ide><cUF>35<\/cUF><tpAmb>2<\/tpAmb><\/ide>/, 'cUF comes before tpAmb as in the layout');
  assert.throws(() => schemaXml({ infNFe: { ide: { inventado: '1' } } }), error => error instanceof SchemaError && /SCHEMA_WRITE_UNKNOWN/.test(error.code));
  assert.throws(() => schemaXml({ infNFe: { '@foo': '1' } }), error => /SCHEMA_WRITE_ATTRIBUTE/.test(error.code));
  assert.equal(schemaXml({ infNFe: { infAdic: { infCpl: 'A & B <c>' } } }).includes('A &amp; B &lt;c&gt;'), true);
});
