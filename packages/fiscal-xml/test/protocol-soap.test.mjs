import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareProtocolSoapDraft, extractProtocolSoapCandidate, FiscalXmlError } from '../src/index.mjs';
import { parseStrict, elements } from '../src/xml.mjs';
import { MAX_XML_BYTES } from '../src/common.mjs';
import { buildAccessKey } from '../../fiscal-core/src/identity.mjs';
import { identity } from '../../fiscal-core/test/fixtures.mjs';

const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const SERVICE = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4';
const NS = 'http://www.portalfiscal.inf.br/nfe';
const digest = value => createHash('sha256').update(value).digest('hex');
const key = (model = '55', patch = {}) => buildAccessKey({ ...identity, model, ...patch });
const input = (patch = {}) => ({ accessKey: key(), expectedModel: '55', environment: '2', requestId: 'synthetic_soap', ...patch });
const payload = (accessKey = key()) => `<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>TESTE</verAplic><cStat>217</cStat><xMotivo>TESTE FICTICIO</xMotivo><cUF>35</cUF><dhRecbto>2026-10-16T01:00:00-03:00</dhRecbto><chNFe>${accessKey}</chNFe></retConsSitNFe>`;
const result = value => `<nfeResultMsg xmlns="${SERVICE}">${value}</nfeResultMsg>`;
const wrap = (value = payload(), header = '') => `<s:Envelope xmlns:s="${SOAP}">${header}<s:Body>${result(value)}</s:Body></s:Envelope>`;
const extract = (envelopeXml = wrap(), patch = {}) => extractProtocolSoapCandidate({ envelopeXml, expectedAccessKey: key(), expectedModel: '55', environment: '2', ...patch });
const reject = (xml, code) => assert.throws(() => extract(xml), error => error instanceof FiscalXmlError && (!code || error.code === code));
const protocol = accessKey => `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe></infProt></protNFe>`;

test('draft builds both model envelopes from validated context with no header, guessed action, transport or trust', () => {
  for (const model of ['55', '65']) {
    const accessKey = key(model), draft = prepareProtocolSoapDraft(input({ expectedModel: model, accessKey }));
    const root = parseStrict(draft.envelopeXml).documentElement, body = elements(root)[0], message = elements(body)[0];
    assert.equal(root.namespaceURI, SOAP); assert.equal(body.localName, 'Body');
    assert.equal(message.namespaceURI, SERVICE); assert.equal(message.localName, 'nfeDadosMsg');
    assert.equal(elements(message)[0].namespaceURI, NS);
    assert.equal(draft.envelopeDigest, digest(draft.envelopeXml));
    assert.equal(draft.xmlDigest, digest(draft.xml));
    assert.equal(draft.contentType, 'application/soap+xml; charset=utf-8'); assert.equal(draft.soapAction, null);
    assert.equal(draft.bindingStatus, 'pending-sp-wsdl'); assert.ok(Object.isFrozen(draft));
    for (const field of ['bindingVerified', 'xsdValidated', 'verified', 'tlsOriginVerified', 'signatureVerified', 'sefazAuthorized', 'canTransmit']) assert.equal(draft[field], false);
  }
});
test('draft rejects arbitrary XML, endpoints, unsafe IDs, production and mismatched model', () => {
  for (const patch of [{ xml: '<malicious/>' }, { endpoint: 'https://evil.invalid' }, { requestId: '<tag>' }, { environment: '1' }, { expectedModel: '65' }, { accessKey: key('55', { cUF: '33' }) }]) assert.throws(() => prepareProtocolSoapDraft(input(patch)), FiscalXmlError);
  for (const value of [undefined, null, [], 'xml']) assert.throws(() => prepareProtocolSoapDraft(value), /SOAP_INPUT_INVALID/);
});
test('candidate extraction binds both models/alphanumeric keys and keeps all trust assertions false', () => {
  for (const [model, cnpj] of [['55', identity.cnpj], ['65', identity.cnpj], ['55', '12ABC34501DE35']]) {
    const accessKey = key(model, { cnpj }), envelopeXml = wrap(payload(accessKey));
    const value = extract(envelopeXml, { expectedAccessKey: accessKey, expectedModel: model });
    assert.equal(value.model, model); assert.equal(value.envelopeDigest, digest(envelopeXml));
    assert.equal(value.payloadDigest, digest(value.payloadXml)); assert.equal(value.queryContextMatched, true);
    assert.equal(value.requiresProtocolValidation, true); assert.ok(Object.isFrozen(value));
    assert.equal(value.payloadXml, payload(accessKey));
    for (const field of ['bindingVerified', 'xsdValidated', 'verified', 'tlsOriginVerified', 'signatureVerified', 'sefazAuthorized', 'canTransmit']) assert.equal(value[field], false);
  }
});
test('prefix choice and an empty SOAP header do not change namespace identity', () => {
  const candidate = wrap(payload(), '<s:Header/>');
  assert.equal(extract(candidate).payloadXml, payload());
  const prefixed = `<env:Envelope xmlns:env="${SOAP}" xmlns:w="${SERVICE}" xmlns:p="${NS}"><env:Body><w:nfeResultMsg><p:retConsSitNFe versao="4.00"><p:tpAmb>2</p:tpAmb><p:cUF>35</p:cUF><p:chNFe>${key()}</p:chNFe></p:retConsSitNFe></w:nfeResultMsg></env:Body></env:Envelope>`;
  const value = extract(prefixed), root = parseStrict(value.payloadXml).documentElement;
  assert.equal(root.namespaceURI, NS); assert.ok(elements(root).every(node => node.namespaceURI === NS));
  assert.equal(value.xsdValidated, false); // This minimal candidate intentionally is NOT a complete fiscal response.
});
test('faults, duplicate bodies/results/payloads and wrapped responses are never selected opportunistically', () => {
  reject(wrap().replace(result(payload()), '<s:Fault><s:Reason>PRIVATE_FAULT</s:Reason></s:Fault>'), 'SOAP_FAULT_REJECTED');
  for (const candidate of [
    wrap().replace('</s:Envelope>', '<s:Body/></s:Envelope>'),
    wrap().replace(result(payload()), result(payload()) + result(payload())),
    wrap(payload() + payload()), wrap(`<wrapper>${payload()}</wrapper>`),
    wrap().replace(result(payload()), `<nfeConsultaNFResponse xmlns="${SERVICE}">${result(payload())}</nfeConsultaNFResponse>`),
    wrap().replace('</s:Body>', '<s:Fault/></s:Body>'),
    wrap().replace('</s:Body>', '<s:Body/></s:Body>'),
    wrap(payload().replace('</retConsSitNFe>', '<s:Envelope/></retConsSitNFe>')),
    wrap(payload().replace('</retConsSitNFe>', `<x:retConsSitNFe xmlns:x="urn:fake"/></retConsSitNFe>`)),
  ]) reject(candidate);
});
test('wrong namespace, SOAP1.1, active headers, encoded XML and encoding attributes fail closed', () => {
  for (const candidate of [
    wrap().replace(SOAP, 'http://schemas.xmlsoap.org/soap/envelope/'), wrap().replace(SERVICE, 'urn:fake'),
    wrap().replace(NS, 'urn:fake'), wrap(payload(), '<s:Header><nfeCabecMsg/></s:Header>'),
    wrap().replace('<s:Body>', '<s:Body s:encodingStyle="urn:encoded">'),
    wrap().replace('<nfeResultMsg ', '<nfeResultMsg href="https://evil.invalid" '),
    wrap().replace(payload(), '&lt;retConsSitNFe/&gt;'),
    wrap().replace('<s:Body>', '<s:Body>PRIVATE_MIXED_TEXT'),
    wrap(payload(), '<s:Header s:mustUnderstand="true"/>'),
  ]) reject(candidate);
});
test('outer and nested protocol context must match the validated request exactly', () => {
  const valid = payload().replace('</retConsSitNFe>', protocol(key()) + '</retConsSitNFe>');
  assert.equal(extract(wrap(valid)).queryContextMatched, true);
  for (const candidate of [
    valid.replace('<tpAmb>2</tpAmb>', '<tpAmb>1</tpAmb>'),
    valid.replace('<cUF>35</cUF>', '<cUF>33</cUF>'),
    valid.replace('<cUF>35</cUF>', '<cUF>35</cUF><cUF>35</cUF>'),
    valid.replace(protocol(key()), protocol(key('65'))),
    valid.replace(protocol(key()), protocol(key()) + protocol(key())),
    valid.replace('<infProt>', '<infProt><tpAmb>2</tpAmb>'),
    valid.replace('<infProt>', '<infProt xmlns="urn:fake">'),
    valid.replace('</retConsSitNFe>', '<unknown><tpAmb>1</tpAmb></unknown></retConsSitNFe>'),
    valid.replace('</retConsSitNFe>', '<unknown><tpAmb>2</tpAmb><tpAmb>2</tpAmb></unknown></retConsSitNFe>'),
  ]) reject(wrap(candidate));
  assert.throws(() => extract(wrap(valid), { expectedAccessKey: key('65'), expectedModel: '55' }), FiscalXmlError);
  assert.throws(() => extract(wrap(valid), { environment: '1' }), FiscalXmlError);
});
test('DTD/XXE, comments, CDATA, processing instructions, duplicate attributes and malformed XML are rejected', () => {
  for (const candidate of [
    '<!DOCTYPE x SYSTEM "file:///etc/passwd">' + wrap(),
    '<!DOCTYPE x [<!ENTITY a SYSTEM "https://evil.invalid">]>' + wrap().replace('TESTE FICTICIO', '&a;'),
    wrap().replace('TESTE FICTICIO', '<![CDATA[PRIVATE]]>'), '<!--private-->' + wrap(),
    '<?probe secret?>' + wrap(), wrap().replace('versao="4.00"', 'versao="4.00" versao="4.00"'),
    wrap().replace('</s:Body>', '</s:body>'),
  ]) reject(candidate);
});
test('byte/tree limits, invalid string encoding and unsupported types do not expose input in errors', () => {
  const marker = 'PRIVATE_MARKER_MUST_NOT_APPEAR';
  for (const candidate of [null, {}, Buffer.from(wrap()), ' '.repeat(MAX_XML_BYTES + 1), '\uFEFF' + wrap(), '\uD800' + wrap(),
    wrap(payload().replace('TESTE FICTICIO', '<x>'.repeat(81) + marker + '</x>'.repeat(81))),
    wrap(payload().replace('TESTE FICTICIO', marker + '\u0000')),
  ]) {
    assert.throws(() => extract(candidate), error => { assert.ok(error instanceof FiscalXmlError); assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_MARKER/); return true; });
  }
  assert.throws(() => extractProtocolSoapCandidate({ envelopeXml: wrap(), expectedAccessKey: key(), expectedModel: '55', environment: '2', verified: true }), /SOAP_INPUT_INVALID/);
});
