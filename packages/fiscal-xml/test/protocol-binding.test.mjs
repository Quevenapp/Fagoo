import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reviewedProtocolBinding, verifyReviewedProtocolWsdl, prepareReviewedProtocolSoap,
  encodeReviewedProtocolSoap, extractReviewedProtocolSoap } from '../src/protocol-binding.mjs';
import { prepareProtocolSoapDraft } from '../src/protocol-soap.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { identity } from '../../fiscal-core/test/fixtures.mjs';
import { FiscalXmlError } from '../src/common.mjs';

const SOAP = 'http://www.w3.org/2003/05/soap-envelope', NS = 'http://www.portalfiscal.inf.br/nfe';
const SERVICE = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4';
const ACTION = SERVICE + '/nfeConsultaNF';
const expectedHashes = { '55': '57c25222d3b8b8d8bbf3ae50b646c3ce961f7a8b334199aac976973da391e882',
  '65': '9bd481ee87d12fe983a70cb851d241da6beea457cd3f00eb7572b55e83cf2562' };
const input = (model = '55', patch = {}) => ({ accessKey: buildAccessKey({ ...identity, model }), expectedModel: model,
  environment: '2', requestId: 'synthetic-reviewed-protocol', ...patch });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = key => `<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><cUF>35</cUF><chNFe>${key}</chNFe></retConsSitNFe>`;
const response = key => `<s:Envelope xmlns:s="${SOAP}"><s:Body><nfeResultMsg xmlns="${SERVICE}">${payload(key)}</nfeResultMsg></s:Body></s:Envelope>`;
const flagsFalse = value => {
  assert.equal(value.bindingReviewed, true);
  for (const flag of ['bindingVerified', 'operationAuthorized', 'canQuery', 'canTransmit', 'canEmit', 'sefazAuthorized',
    'xsdValidated', 'verified', 'tlsOriginVerified', 'signatureVerified']) assert.equal(value[flag], false, flag);
};

test('two reviewed profiles pin exact byte hashes, operation, endpoint case and document/literal SOAP1.2', () => {
  for (const model of ['55', '65']) {
    const binding = reviewedProtocolBinding(model);
    assert.equal(binding.wsdlHash, expectedHashes[model]); assert.equal(binding.wsdlSizeBytes, model === '55' ? 3189 : 3192);
    assert.equal(binding.endpoint, model === '55' ? 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx'
      : 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx');
    assert.equal(binding.soapVersion, '1.2'); assert.equal(binding.style, 'document'); assert.equal(binding.use, 'literal');
    assert.equal(binding.operationName, 'nfeConsultaNF'); assert.equal(binding.inputElement, 'nfeDadosMsg'); assert.equal(binding.outputElement, 'nfeResultMsg');
    assert.equal(binding.soapAction, ACTION); assert.ok(Object.isFrozen(binding)); flagsFalse(binding);
  }
  for (const model of ['1', 55, ['55'], { toString() { throw new Error('must not run'); } }]) assert.throws(() => reviewedProtocolBinding(model), /SOAP_BINDING_MODEL_UNSUPPORTED/);
});

test('request bytes use the reviewed action in Content-Type, no SOAPAction header or operation wrapper', () => {
  for (const model of ['55', '65']) {
    const data = input(model), prepared = prepareReviewedProtocolSoap(data), bytes = encodeReviewedProtocolSoap(prepared);
    const expectedPayload = `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>${data.accessKey}</chNFe></consSitNFe>`;
    const expected = `<soap12:Envelope xmlns:soap12="${SOAP}"><soap12:Body><nfeDadosMsg xmlns="${SERVICE}">${expectedPayload}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
    assert.deepEqual(bytes, new TextEncoder().encode(expected)); assert.equal(prepared.envelopeDigest, hash(bytes)); assert.equal(prepared.envelopeSizeBytes, bytes.length);
    assert.equal(prepared.contentType, `application/soap+xml; charset=utf-8; action="${ACTION}"`);
    assert.deepEqual(Object.keys(prepared.headers), ['Content-Type']); assert.equal(prepared.headers['Content-Type'], prepared.contentType);
    assert.equal(prepared.method, 'POST'); assert.ok(!prepared.envelopeXml.includes('nfeCabecMsg')); assert.ok(!prepared.envelopeXml.includes('<nfeConsultaNF'));
    assert.ok(Object.isFrozen(prepared.headers)); flagsFalse(prepared);
    bytes.fill(0); assert.deepEqual(encodeReviewedProtocolSoap(prepared), new TextEncoder().encode(expected));
  }
});

test('old draft remains byte-compatible and unreviewed; no old consumer is implicitly enabled', () => {
  const old = prepareProtocolSoapDraft(input()), current = prepareReviewedProtocolSoap(input());
  assert.equal(old.envelopeXml, current.envelopeXml); assert.equal(old.envelopeDigest, current.envelopeDigest);
  assert.equal(old.soapAction, null); assert.equal(old.bindingStatus, 'pending-sp-wsdl'); assert.equal(old.canTransmit, false);
  assert.throws(() => encodeReviewedProtocolSoap(old), /SOAP_BINDING_REQUEST_UNATTESTED/);
  assert.throws(() => encodeReviewedProtocolSoap({ ...current }), /SOAP_BINDING_REQUEST_UNATTESTED/);
});

test('exact own-data inputs reject action/URL/XML/grant/capability overrides and do not run accessors', () => {
  for (const extra of [{ url: 'https://evil.invalid' }, { action: 'other' }, { envelopeXml: '<evil/>' }, { grant: '051' }, { canQuery: true }, { [Symbol('extra')]: true }])
    assert.throws(() => prepareReviewedProtocolSoap({ ...input(), ...extra }), /SOAP_BINDING_INPUT_INVALID/);
  let calls = 0; const value = input(); Object.defineProperty(value, 'accessKey', { enumerable: true, get() { calls++; return 'bad'; } });
  assert.throws(() => prepareReviewedProtocolSoap(value), /SOAP_BINDING_INPUT_INVALID/); assert.equal(calls, 0);
  for (const patch of [{ expectedModel: '65' }, { environment: '1' }, { requestId: '<private>' }]) assert.throws(() => prepareReviewedProtocolSoap(input('55', patch)));
  const source = input(), prepared = prepareReviewedProtocolSoap(source); source.accessKey = 'other'; source.requestId = 'changed';
  assert.notEqual(prepared.accessKey, source.accessKey); assert.notEqual(prepared.requestId, source.requestId);
});

test('direct nfeResultMsg response binds key/model and keeps XSD, origin and fiscal capabilities false', () => {
  for (const model of ['55', '65']) {
    const prepared = prepareReviewedProtocolSoap(input(model)), bytes = Buffer.from(response(prepared.accessKey));
    const candidate = extractReviewedProtocolSoap({ request: prepared, envelopeBytes: bytes });
    assert.equal(candidate.payloadXml, payload(prepared.accessKey)); assert.equal(candidate.envelopeDigest, hash(bytes));
    assert.equal(candidate.payloadDigest, hash(candidate.payloadXml)); assert.equal(candidate.binding.wsdlHash, expectedHashes[model]);
    assert.equal(candidate.envelopeSizeBytes, bytes.length); assert.equal(candidate.queryContextMatched, true);
    assert.equal(candidate.requiresProtocolValidation, true); flagsFalse(candidate); assert.ok(Object.isFrozen(candidate));
    // This intentionally incomplete fiscal payload passes extraction, not XSD.
    const original = Buffer.from(bytes); extractReviewedProtocolSoap({ request: prepared, envelopeBytes: bytes }); assert.deepEqual(bytes, original);
  }
});

test('response message-part name does not become an extra wrapper; mismatches and SOAP1.1/Fault are refused', () => {
  const request = prepareReviewedProtocolSoap(input()), xml = response(request.accessKey);
  const mutations = [
    xml.replaceAll('nfeResultMsg', 'nfeConsultaNFResult'),
    xml.replace('<nfeResultMsg ', '<nfeConsultaNFResponse><nfeResultMsg ').replace('</nfeResultMsg>', '</nfeResultMsg></nfeConsultaNFResponse>'),
    xml.replace(SOAP, 'http://schemas.xmlsoap.org/soap/envelope/'), xml.replace(SERVICE, 'urn:other'),
    xml.replace(request.accessKey, input('65').accessKey), xml.replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>'),
    xml.replace('<s:Body>', '<s:Body><s:Fault/>'), xml.replace('</s:Body>', '</s:Body><s:Body/>'),
  ];
  for (const changed of mutations) assert.throws(() => extractReviewedProtocolSoap({ request, envelopeBytes: Buffer.from(changed) }));
  assert.throws(() => extractReviewedProtocolSoap({ request: { ...request }, envelopeBytes: Buffer.from(xml) }), /SOAP_BINDING_REQUEST_UNATTESTED/);
});

test('bounded original bytes reject invalid UTF8, DTD, BOM, extra fields and shared memory without input disclosure', () => {
  const request = prepareReviewedProtocolSoap(input()), marker = 'PRIVATE_FAULT_MARKER';
  for (const envelopeBytes of [Buffer.alloc(0), Buffer.alloc(512001), Buffer.from([0xc0, 0xaf]),
    Buffer.from('\ufeff' + response(request.accessKey)), Buffer.from(`<!DOCTYPE x SYSTEM "file:///${marker}">` + response(request.accessKey)),
    new Uint8Array(new SharedArrayBuffer(10)), response(request.accessKey)]) {
    assert.throws(() => extractReviewedProtocolSoap({ request, envelopeBytes }), error => {
      assert.equal(error.name, 'FiscalXmlError'); assert.ok(!String(error).includes(marker)); return true;
    });
  }
  assert.throws(() => extractReviewedProtocolSoap({ request, envelopeBytes: Buffer.from(response(request.accessKey)), verified: true }), /SOAP_BINDING_INPUT_INVALID/);
});

test('Proxy exceptions and typed-array property overrides cannot execute or leak through the boundary', () => {
  const marker = 'PRIVATE_PROXY_MARKER', proxy = new Proxy({}, { getPrototypeOf() { throw new FiscalXmlError(marker); } });
  assert.throws(() => prepareReviewedProtocolSoap(proxy), { message: 'SOAP_BINDING_INPUT_INVALID' });
  const request = prepareReviewedProtocolSoap(input()), bytes = Buffer.from(response(request.accessKey));
  let calls = 0;
  for (const key of ['buffer', 'byteLength', 'byteOffset', Symbol.iterator]) Object.defineProperty(bytes, key, { get() { calls++; throw new Error(marker); } });
  assert.equal(extractReviewedProtocolSoap({ request, envelopeBytes: bytes }).queryContextMatched, true); assert.equal(calls, 0);
  assert.throws(() => extractReviewedProtocolSoap({ request, envelopeBytes: new Proxy(bytes, {}) }), { message: 'SOAP_BINDING_BYTES_INVALID' });
});

test('snapshot verification rejects unknown bytes or model substitution; hashes alone grant nothing', () => {
  for (const model of ['55', '65']) {
    const bytes = Buffer.alloc(reviewedProtocolBinding(model).wsdlSizeBytes, 32), original = Buffer.from(bytes);
    assert.throws(() => verifyReviewedProtocolWsdl({ model, wsdlBytes: bytes }), /SOAP_BINDING_WSDL_MISMATCH/); assert.deepEqual(bytes, original);
  }
  assert.throws(() => verifyReviewedProtocolWsdl({ model: '55', wsdlBytes: Buffer.alloc(512001) }), /SOAP_BINDING_BYTES_INVALID/);
});

test('opt-in local snapshots match both pinned contracts without network, credentials or repository copies', { skip: process.env.FAGOO_TEST_LOCAL_PROTOCOL_WSDL !== '1' }, async () => {
  for (const model of ['55', '65']) {
    const bytes = await readFile(new URL(`../../../private/fiscal/wsdl/model-${model}-protocol.xml`, import.meta.url));
    try {
      assert.equal(verifyReviewedProtocolWsdl({ model, wsdlBytes: bytes }).wsdlHash, expectedHashes[model]);
      assert.throws(() => verifyReviewedProtocolWsdl({ model: model === '55' ? '65' : '55', wsdlBytes: bytes }), /SOAP_BINDING_WSDL_MISMATCH/);
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      assert.throws(() => verifyReviewedProtocolWsdl({ model, wsdlBytes: changed }), /SOAP_BINDING_WSDL_MISMATCH/);
    } finally { bytes.fill(0); }
  }
});
