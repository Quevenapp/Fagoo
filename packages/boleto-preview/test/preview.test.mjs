import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createItau109PrintPreview } from '../src/index.mjs';
import { createItau109BarcodePreview } from '../../boleto-core/src/index.mjs';
import { fixture } from './fixtures.mjs';

const reject = (input, code) => assert.rejects(createItau109PrintPreview(input), error => error.code === code);
test('one validated input binds both slips, nominal value, numeric line and ITF image', async () => {
  const input = fixture(), core = createItau109BarcodePreview(input.boleto), result = await createItau109PrintPreview(input);
  for (const key of ['barcode', 'digitableLine', 'amountCents', 'dueOn', 'referenceOn', 'ourNumberWithDigit']) assert.equal(result.binding[key], core[key]);
  assert.equal(result.html.split(core.formattedLine).length - 1, 2);
  assert.equal(result.html.split(core.svg).length - 1, 1);
  for (const text of ['123,45', 'TESTE/001', '1234 / 12345-1', '109/00000001-0', 'EMPRESA FICTICIA']) assert.equal(result.html.split(text).length - 1, 2);
  assert.equal(result.htmlHash, createHash('sha256').update(result.html).digest('hex'));
  assert.equal(result.sizeBytes, Buffer.byteLength(result.html));
});
test('maximum nominal cents and the due factor rollover stay exact', async () => {
  const x = fixture(); x.boleto.title.amountCents = '9999999999';
  const p = await createItau109PrintPreview(x);
  assert.equal(p.binding.barcode.slice(9, 19), '9999999999');
  assert.equal(p.binding.barcode.slice(5, 9), '1000');
  assert.match(p.html, /99\.999\.999,99/);
  x.boleto.title.amountCents = '10000000000'; await reject(x, 'BOLETO_AMOUNT_INVALID');
});
test('plain caller text is escaped, never executable markup or an external resource', async () => {
  const x = fixture(); x.payer.name = '<svg onload="x()"> & O\'TESTE';
  const p = await createItau109PrintPreview(x);
  assert.match(p.html, /&lt;svg onload=&quot;x\(\)&quot;&gt; &amp; O&#39;TESTE/);
  assert.doesNotMatch(p.html, /<(?:script|iframe|form|img|link|object|foreignObject)\b|<[^>]+\s(?:onload|href|src)=/);
  assert.match(p.html, /default-src 'none'; script-src 'none'/);
  assert.match(p.html, /connect-src 'none'/);
  assert.match(p.html, /form-action 'none'/);
});
test('controls, bidi, unsupported glyphs and overlong text are rejected without truncation', async () => {
  for (const name of ['A\nB', 'A\u202eB', 'TESTE😀', 'X'.repeat(61), ' TESTE']) {
    const x = fixture(); x.payer.name = name; await reject(x, 'BOLETO_PREVIEW_TEXT_INVALID');
  }
  const dense = fixture({ dense: true }), p = await createItau109PrintPreview(dense);
  assert.ok(p.html.includes('W'.repeat(60))); assert.ok(p.html.includes('W'.repeat(40)));
  assert.doesNotMatch(p.html, /text-overflow|overflow:hidden|line-clamp/);
});
test('closed shapes reject extra properties, accessors and custom prototypes without calling getters', async () => {
  let touched = 0;
  const x = fixture(); Object.defineProperty(x.payer, 'name', { enumerable: true, get() { touched++; return 'TESTE'; } });
  await reject(x, 'BOLETO_PREVIEW_INPUT_INVALID'); assert.equal(touched, 0);
  const cases = [x => x[Symbol('extra')] = 1, x => x.html = '<b>caller</b>', x => x.boleto.profile.reservedRange = {},
    x => Object.setPrototypeOf(x.document, { inherited: true }), x => x.beneficiaryAddress = [],
    x => Object.defineProperty(x.document, 'number', { value: 'TESTE', enumerable: false }),
    x => x.payer.name = { toString() { touched++; return 'TESTE'; } }];
  for (const change of cases) { const x = fixture(); change(x); await assert.rejects(createItau109PrintPreview(x)); }
  assert.equal(touched, 0);
});
test('all dates are explicit and processing date shares the factor reference context', async () => {
  for (const change of [x => x.document.issuedOn = '2025-02-30', x => x.document.processedOn = '2025-02-21',
    x => x.document.issuedOn = '2025-02-23', x => x.document.processedOn = null]) {
    const x = fixture(); change(x); await assert.rejects(createItau109PrintPreview(x), /BOLETO_PREVIEW_DATE/);
  }
});
test('profile declarations do not become capabilities and Inter remains unsupported', async () => {
  const p = await createItau109PrintPreview(fixture());
  for (const name of ['bankRegistered', 'bankAcceptanceVerified', 'homologationVerified', 'numberAllocationVerified', 'financialMutationPerformed',
    'bankTransmissionPerformed', 'canIssue', 'canTransmit', 'canPay', 'printedLayoutValidatedByBank']) assert.equal(p[name], false);
  assert.equal(p.fullBoletoRendered, true); assert.ok(p.pending.includes('PRINTED_LAYOUT_NOT_VALIDATED'));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.binding) && Object.isFrozen(p.pending));
  const x = fixture(); x.boleto.profile.bank = '077'; x.boleto.profile.wallet = '110'; await reject(x, 'BOLETO_PREVIEW_PROFILE_UNSUPPORTED');
});
test('capture before the asynchronous digest prevents input mutation changing its binding or content', async () => {
  const x = fixture(), original = structuredClone(x), pending = createItau109PrintPreview(x);
  x.boleto.title.amountCents = '99999'; x.boleto.allocation.ourNumber = '00000002'; x.payer.name = 'MUTATED'; x.document.number = 'OTHER';
  x.boleto.profile.account = '00001';
  const [actual, expected] = await Promise.all([pending, createItau109PrintPreview(original)]);
  assert.deepEqual(actual, expected); assert.doesNotMatch(actual.html, /MUTATED|OTHER/);
});
test('bank geometry and the nonpayment warning are explicit in both parts', async () => {
  const p = await createItau109PrintPreview(fixture());
  assert.deepEqual(p.dimensions, { paper: 'A4', slipWidthMm: 190, slipHeightMm: 104, barcodeWidthMm: 103, barcodeHeightMm: 13, quietZoneMm: 5, barcodeCenterFromBottomMm: 13.5 });
  assert.match(p.html, /@page\{size:A4 portrait;margin:10mm\}/);
  assert.match(p.html, /\.slip\{height:104mm;width:190mm/);
  assert.match(p.html, /\.footer\{height:28mm/);
  assert.match(p.html, /height="13"/);
  assert.ok(p.html.split('NÃO PAGAR').length >= 7);
  assert.match(p.html, /Encargos não calculados/);
  assert.doesNotMatch(p.html, /protesto|1%|2%|PAGUE EM|itau\.com/);
  for (const field of ['Desconto / abatimento', 'Juros / multa', 'Valor pago']) assert.ok(p.html.includes(field));
});
test('payer document, address and document identifiers are checked independently', async () => {
  for (const change of [x => x.payer.document = '11111111111', x => x.payer.type = '03', x => x.payer.state = 'XX',
    x => x.payer.postalCode = '00000000', x => x.document.number = '01234567890', x => x.purpose = 'issue']) {
    const x = fixture(); change(x); await assert.rejects(createItau109PrintPreview(x));
  }
});
