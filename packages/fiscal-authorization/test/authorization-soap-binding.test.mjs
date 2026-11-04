import {TEST_PYTHON} from './test-runtime.mjs';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {signedFixture,fiscalResponse,HOLDER,NOW,hash} from './service-fixtures.mjs';
import {prepareAuthorization,authorizationRequestBytes,composeProcessedNfe,authorizationBindingStatus} from '../src/index.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {parseStrict,elements} from '../../fiscal-xml/src/xml.mjs';
import {
 AUTHORIZATION_SOAP_MANIFEST,AUTHORIZATION_SOAP_MANIFESTS,AUTHORIZATION_SOAP_MANIFEST_HASH,AUTHORIZATION_SOAP_MANIFEST_HASHES,AUTHORIZATION_SOAP_FLAGS,MAX_AUTHORIZATION_SOAP_BYTES,
 AuthorizationSoapBindingError,reviewedAuthorizationBinding,verifyReviewedAuthorizationWsdl,
 prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,extractReviewedAuthorizationSoap,
} from '../src/authorization-soap-binding.mjs';

const {SignedXml}=createRequire(new URL('../../fiscal-xml/package.json',import.meta.url))('xml-crypto');
const SOAP='http://www.w3.org/2003/05/soap-envelope',NFE='http://www.portalfiscal.inf.br/nfe',SERVICE='http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4';
const bytes=s=>Buffer.from(s),decode=b=>Buffer.from(b).toString('utf8');
const error=code=>e=>e instanceof AuthorizationSoapBindingError&&e.code===code&&e.message===code;
const rejected=e=>e instanceof AuthorizationSoapBindingError&&e.message===e.code;
let fixture;
before(async()=>{fixture=await signedFixture();});after(()=>fixture.close());
function core(signed,model='55',batchId='1'){
 return prepareAuthorization({signedBytes:signed.signedBytes,expectedSignedHash:signed.signed.xmlDigest,expectedModel:model,
  expectedIssuerCnpj:HOLDER,expectedHolderCnpj:HOLDER,expectedCertificate:fixture.credential.certificate,
  expectedCertificateFingerprint:hash(fixture.credential.certificateDer),now:NOW,batchId});
}
function prepared(model='55',count=1){const s=fixture.create(model,count),source=core(s,model);return{signed:s.signed,source,request:prepareReviewedAuthorizationSoap({request:source})};}
const envelope=payload=>`<Envelope xmlns="${SOAP}"><Body><nfeResultMsg xmlns="${SERVICE}">${decode(payload)}</nfeResultMsg></Body></Envelope>`;
function disabled(value){for(const[key,v]of Object.entries(AUTHORIZATION_SOAP_FLAGS))assert.equal(value[key],v,key);}
function signatureValid(xml){const v=new SignedXml({publicCert:fixture.credential.certificate,getCertFromKeyInfo:()=>null});v.loadSignature(xml.match(/<Signature\b[\s\S]*?<\/Signature>/)[0]);return v.checkSignature(xml);}

test('original55 manifest remains immutable and separates the output part from its element',()=>{
 const b=reviewedAuthorizationBinding('55');assert.equal(b.source.sha256,'feb888587ca4aaff7ed0063f33107ba90109ea3b2e38bd4442f14981f13090bd');
 assert.equal(b.source.sizeBytes,4049);assert.equal(b.profile,'sp55-authorization-soap12-reviewed-20261016-v1');
 assert.equal(b.endpoint,'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx');
 assert.equal(b.operationName,'nfeAutorizacaoLote');assert.equal(b.outputPart,'nfeAutorizacaoLoteResult');assert.equal(b.outputElement,'nfeResultMsg');
 assert.equal(b.declaredSoapHeaders,false);assert.deepEqual(b.excludedOperations,['nfeAutorizacaoLoteZip']);
 assert.equal(hash(JSON.stringify(AUTHORIZATION_SOAP_MANIFEST)),AUTHORIZATION_SOAP_MANIFEST_HASH);
 assert.equal(AUTHORIZATION_SOAP_MANIFEST_HASH,'1d99cb7508f56bd1a0b113ca5e6a05067a6928447c1d00cc4c668b10e1d1d596');
 for(const value of [b,b.source,b.excludedOperations,b.limitations])assert.equal(Object.isFrozen(value),true);disabled(b);
});

test('65 selects its independently observed WSDL and case-sensitive endpoint without borrowing the55 pin',()=>{
 const b=reviewedAuthorizationBinding('65');assert.equal(b.source.sha256,'b1c67b11afb4bdbb54903eee908ad14694b4b9a1cd78518af89c612f79fb3771');
 assert.equal(b.source.sizeBytes,4058);assert.equal(b.profile,'sp65-authorization-soap12-reviewed-20261016-v1');
 assert.equal(b.source.url,'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx?WSDL');assert.equal(b.endpoint,b.source.url.slice(0,-5));
 assert.equal(b.model,'65');assert.equal(b.operationName,'nfeAutorizacaoLote');assert.equal(b.outputElement,'nfeResultMsg');assert.equal(b.declaredSoapHeaders,false);
 assert.equal(b.manifestHash,hash(JSON.stringify(AUTHORIZATION_SOAP_MANIFESTS['65'])));assert.equal(AUTHORIZATION_SOAP_MANIFEST_HASHES['55'],AUTHORIZATION_SOAP_MANIFEST_HASH);
 assert.equal(b.manifestHash,'ed320ae9e43aef291d89e6779077dffb30b6941548d8065cd466cf3fe3038114');
 assert.equal(AUTHORIZATION_SOAP_MANIFESTS['55'],AUTHORIZATION_SOAP_MANIFEST);assert.notEqual(b.manifestHash,AUTHORIZATION_SOAP_MANIFEST_HASH);
 for(const v of[AUTHORIZATION_SOAP_MANIFESTS,AUTHORIZATION_SOAP_MANIFEST_HASHES,b,b.source,b.limitations])assert.equal(Object.isFrozen(v),true);disabled(b);
});

test('55 request preserves signed bytes, idLote and payload, with separate complete-envelope digest',()=>{
 const f=prepared(),body=encodeReviewedAuthorizationSoap(f.request),xml=decode(body),payload=authorizationRequestBytes(f.source);
 assert.ok(xml.includes(f.signed.signedXml));assert.ok(xml.includes(decode(payload)));
 assert.equal(f.request.payloadHash,f.source.requestHash);assert.equal(f.request.payloadHash,hash(payload));
 assert.equal(f.request.envelopeHash,hash(body));assert.notEqual(f.request.envelopeHash,f.request.payloadHash);
 assert.equal(f.request.envelopeSizeBytes,body.length);assert.equal(f.request.payloadSizeBytes,payload.length);
 assert.equal(f.request.batchId,'1');assert.equal(f.request.method,'POST');assert.deepEqual(Object.keys(f.request.headers),['Content-Type']);
 assert.equal(f.request.headers['Content-Type'],`application/soap+xml; charset=utf-8; action="${SERVICE}/nfeAutorizacaoLote"`);
 assert.equal(xml.startsWith(`<Envelope xmlns="${SOAP}"><Body>`),true);assert.equal(xml.includes('xmlns:soap'),false);
 assert.equal(xml.includes('nfeAutorizacaoLoteResponse'),false);assert.equal(xml.includes('<Header'),false);
 assert.equal(xml.includes('nfeDadosMsgZip'),false);disabled(f.request);
 body.fill(0);payload.fill(0);assert.equal(hash(encodeReviewedAuthorizationSoap(f.request)),f.request.envelopeHash);
});

test('inclusive C14N signature verifies inside the full SOAP envelope; a new ancestor prefix demonstrably breaks it',()=>{
 for(const model of ['55','65'])for(const count of [1,250]){
  const f=prepared(model,count),xml=decode(encodeReviewedAuthorizationSoap(f.request));
  assert.equal(signatureValid(f.signed.signedXml),true);assert.equal(signatureValid(xml),true);
  const polluted=xml.replace(`<Envelope xmlns="${SOAP}">`,`<Envelope xmlns="${SOAP}" xmlns:soap12="${SOAP}">`);
  assert.equal(signatureValid(polluted),false);assert.equal(f.request.signatureVerified,false);
 }
});

test('unknown models and caller-provided XML/URL/action are unavailable; legacy binding status remains unchanged',()=>{
 for(const model of ['65 ','55 ','authorization',55,65,['55'],null,'__proto__'])assert.throws(()=>reviewedAuthorizationBinding(model),error('SOAP_AUTHORIZATION_MODEL_UNSUPPORTED'));
 const f=prepared();for(const field of ['endpoint','soapAction','xml','operation'])assert.throws(()=>prepareReviewedAuthorizationSoap({request:f.source,[field]:'untrusted'}),error('SOAP_AUTHORIZATION_INPUT_INVALID'));
 for(const model of ['55','65'])assert.equal(authorizationBindingStatus(model).status,'reviewed_wsdl_required');
});

test('65 request and response retain the exact QR/signed bytes and cannot bind a55 protocol',()=>{
 const f=prepared('65'),other=prepared('55'),body=encodeReviewedAuthorizationSoap(f.request),xml=decode(body),payload=authorizationRequestBytes(f.source);
 assert.equal(f.request.model,'65');assert.equal(f.request.endpoint,reviewedAuthorizationBinding('65').endpoint);
 assert.equal(f.request.payloadHash,hash(payload));assert.equal(f.request.envelopeHash,hash(body));assert.equal(f.request.envelopeSizeBytes,body.length);
 assert.ok(xml.includes(f.signed.signedXml));assert.ok(xml.includes('<infNFeSupl>'));assert.equal(signatureValid(xml),true);disabled(f.request);
 const response=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(envelope(fiscalResponse(f.source)))});
 assert.equal(response.model,'65');assert.equal(response.profile,f.request.profile);assert.equal(response.binding,f.request.binding);
 assert.equal(response.response.protocol.referenceDigestMatched,true);assert.ok(response.payloadXml.includes(f.source.accessKey));disabled(response);
 const processed=composeProcessedNfe({request:f.source,response:response.response});assert.ok(processed.processedXml.includes(f.signed.signedXml));assert.equal(signatureValid(processed.processedXml),true);
 for(const [target,source]of[[f,other],[other,f]])assert.throws(()=>extractReviewedAuthorizationSoap({request:target.request,envelopeBytes:bytes(envelope(fiscalResponse(source.source)))}),error('SOAP_AUTHORIZATION_PAYLOAD_INVALID'));
 body.fill(0);payload.fill(0);assert.equal(hash(encodeReviewedAuthorizationSoap(f.request)),f.request.envelopeHash);
});

test('attested handles are checked before property access, and descriptors/accessors cannot override input',()=>{
 let touched=0;const fake={get model(){touched++;throw Error('PRIVATE');}},f=prepared();
 for(const source of [fake,{...f.source},new Proxy(f.source,{get(){touched++;throw Error('PRIVATE');}})])assert.throws(()=>prepareReviewedAuthorizationSoap({request:source}),error('SOAP_AUTHORIZATION_SOURCE_UNATTESTED'));
 for(const request of [{...f.request},new Proxy(f.request,{get(){touched++;throw Error('PRIVATE');}})])assert.throws(()=>encodeReviewedAuthorizationSoap(request),error('SOAP_AUTHORIZATION_REQUEST_UNATTESTED'));
 const x={};Object.defineProperty(x,'request',{enumerable:true,get(){touched++;return f.source;}});assert.throws(()=>prepareReviewedAuthorizationSoap(x),error('SOAP_AUTHORIZATION_INPUT_INVALID'));
 assert.throws(()=>extractReviewedAuthorizationSoap({request:fake,envelopeBytes:bytes('PRIVATE')}),error('SOAP_AUTHORIZATION_REQUEST_UNATTESTED'));
 assert.equal(touched,0);
});

test('response extraction is bound to the exact source handle and returns only a declaration, not authority',()=>{
 const f=prepared(),raw=bytes(envelope(fiscalResponse(f.source))),saved=hash(raw),c=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:raw});raw.fill(0);
 assert.equal(c.envelopeHash,saved);assert.equal(c.payloadHash,hash(c.payloadXml));assert.equal(c.response.responseHash,c.payloadHash);
 assert.equal(c.response.classification,'authorization_declared');assert.equal(c.response.protocol.cStat,'100');disabled(c);assert.equal(c.xsdValidated,false);
 assert.equal(Object.isFrozen(c),true);assert.equal(Object.isFrozen(c.response),true);
 const p=composeProcessedNfe({request:f.source,response:c.response});assert.ok(p.processedXml.includes(f.signed.signedXml));assert.equal(signatureValid(p.processedXml),true);
 const other=core({signed:f.signed,signedBytes:bytes(f.signed.signedXml)},'55','2');
 assert.throws(()=>composeProcessedNfe({request:other,response:c.response}),e=>e.code==='AUTHORIZATION_RESPONSE_UNATTESTED');
});

test('SOAP55/65 accepts UTF-8 name casing without changing the original envelope hash or payload',()=>{
 for(const model of ['55','65']){
  const f=prepared(model),plain=envelope(fiscalResponse(f.source)),baseline=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(plain)});
  for(const encoding of ['UTF-8','UTf-8','UtF-8','Utf-8','uTF-8','uTf-8','utF-8','utf-8']){
   const raw=bytes(`<?xml version="1.0" encoding="${encoding}"?>`+plain),before=Buffer.from(raw);
   const extracted=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:raw});
   assert.deepEqual(raw,before);assert.equal(extracted.envelopeHash,hash(before));assert.equal(extracted.envelopeSizeBytes,before.length);
   assert.notEqual(extracted.envelopeHash,baseline.envelopeHash);assert.equal(extracted.payloadHash,baseline.payloadHash);assert.equal(extracted.payloadXml,baseline.payloadXml);
   assert.equal(extracted.response.cStat,'104');assert.equal(extracted.response.protocol.cStat,'100');disabled(extracted);
   const processed=composeProcessedNfe({request:f.source,response:extracted.response});assert.equal(signatureValid(processed.processedXml),true);assert.ok(processed.processedXml.includes(f.signed.signedXml));
  }
  for(const prefix of ['<?XML version="1.0" encoding="utf-8"?>','<?xml version="1.0" Encoding="utf-8"?>','<?xml version="1.0" encoding="UTF-16"?>','<?xml version="1.0" encoding="utf-8"?><?other x?>','<?xml version="1.0" encoding="utf-8"?><!DOCTYPE x SYSTEM "file:///never-read">'])
   assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(prefix+plain)}),error('SOAP_AUTHORIZATION_XML_INVALID'));
 }
});

test('lowercase-declared signed NFe55 and QR-bearing65 prepare a batch without nested declarations; real XSD remains pinned',async()=>{
 const signer=createSigner({...fixture.credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});
 const validate=createAuthorizationValidator({pythonPath:TEST_PYTHON,validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
 try{for(const model of ['55','65']){
  const declaration='<?xml version="1.0" encoding="utf-8"?>',unsigned=declaration+buildBusinessXml(businessFixture({model})).unsignedXml;
  //55 signs the declaration-bearing input.65's already-signed QR subtree is
  // unchanged: declarations are outside it, including outside inclusive C14N.
  const native=model==='65'?fixture.create(model).signed:null;
  const signed=model==='55'?createSignedHomologationCandidate({xml:unsigned,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(unsigned),expectedCertificateFingerprint:hash(fixture.credential.certificateDer),now:NOW}):{...native,signedXml:declaration+native.signedXml,xmlDigest:hash(declaration+native.signedXml)};
  assert.ok(signed.signedXml.startsWith(declaration));assert.equal(signatureValid(signed.signedXml),true);
  const signedBytes=bytes(signed.signedXml),before=Buffer.from(signedBytes),source=core({signed,signedBytes},model),request=prepareReviewedAuthorizationSoap({request:source}),wire=encodeReviewedAuthorizationSoap(request),payload=authorizationRequestBytes(source);
  assert.deepEqual(signedBytes,before);assert.equal(source.signedHash,hash(before));assert.equal(decode(wire).includes('<?xml'),false);assert.equal(decode(payload).includes('<?xml'),false);
  assert.ok(decode(payload).includes(signed.signedXml.slice(declaration.length)));assert.equal(signatureValid(decode(wire)),true);
  assert.equal((await validate({request:source,xmlBytes:payload,kind:'request'})).ok,true);
  const raw=bytes(declaration+envelope(fiscalResponse(source))),extracted=extractReviewedAuthorizationSoap({request,envelopeBytes:raw});
  assert.equal(extracted.envelopeHash,hash(raw));assert.equal((await validate({request:source,xmlBytes:bytes(extracted.payloadXml),kind:'response'})).ok,true);
  const processed=composeProcessedNfe({request:source,response:extracted.response});assert.equal(processed.processedXml.includes('<?xml'),false);assert.ok(processed.processedXml.includes(signed.signedXml.slice(declaration.length)));assert.equal(signatureValid(processed.processedXml),true);
  const report=await validate({request:source,xmlBytes:bytes(processed.processedXml),kind:'processed'});assert.equal(report.ok,true);assert.equal(report.signatureVerified,false);assert.equal(report.authorizedInHomologation,false);assert.equal(report.canTransmit,false);
 }}finally{disposeSigner(signer);}
});

test('103,104,individual150 and rejection remain separate; 217 never becomes retry permission',()=>{
 for(const model of ['55','65']){const f=prepared(model);for(const [options,status] of [[{batch:'103',protocol:false,receipt:true},'receipt_pending'],[{status:'150'},'authorization_declared'],[{batch:'225',protocol:false},'rejected'],[{batch:'217',protocol:false},'review_required']]){
  const c=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(envelope(fiscalResponse(f.source,options)))});
  assert.equal(c.response.classification,status);disabled(c);assert.equal(c.response.retrySubmissionAllowed,false);
 }}
});

test('SOAP prefixes and an empty header are accepted by QName, while active headers and alternate wrappers fail',()=>{
 const f=prepared(),payload=decode(fiscalResponse(f.source));
 const valid=`<s:Envelope xmlns:s="${SOAP}"><s:Header/><s:Body><r:nfeResultMsg xmlns:r="${SERVICE}">${payload}</r:nfeResultMsg></s:Body></s:Envelope>`;
 assert.equal(extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(valid)}).response.classification,'authorization_declared');
 const bad=[valid.replace('<s:Header/>','<s:Header><x xmlns="urn:untrusted"/></s:Header>'),valid.replaceAll('nfeResultMsg','nfeAutorizacaoLoteResult'),valid.replaceAll('nfeResultMsg','nfeAutorizacaoLoteResponse'),valid.replaceAll(SOAP,'http://schemas.xmlsoap.org/soap/envelope/'),valid.replaceAll(SERVICE,'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4'),valid.replace('s:Body>','s:Body arbitrary="1">'),valid.replace(payload,payload+payload),valid.replace(payload,payload.replace('<tpAmb>2','<tpAmb>1')),valid.replace(payload,payload.replace(f.source.accessKey,'0'.repeat(44))),valid.replace(payload,payload.replace(f.source.referenceDigest,'AAAAAAAAAAAAAAAAAAAAAAAAAAA='))];
 for(const xml of bad)assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(xml)}),rejected);
});

test('Fault, escaped payload, multiple bodies, mixed text and nested result cannot be interpreted as a response',()=>{
 const f=prepared(),base=envelope(fiscalResponse(f.source));
 const fault=`<Envelope xmlns="${SOAP}"><Body><Fault><Reason><Text>PRIVATE_ERROR</Text></Reason></Fault></Body></Envelope>`;
 assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(fault)}),error('SOAP_AUTHORIZATION_FAULT'));
 const bad=[base.replace('<Body>','<Body/> <Body>'),base.replace('<Body>','<Body>PRIVATE_TEXT'),base.replace('<retEnviNFe','&lt;retEnviNFe'),base.replace('</nfeResultMsg>','<nfeResultMsg/></nfeResultMsg>'),base.replace('</Body>','<Envelope/></Body>'),base.replace('<Envelope','<!DOCTYPE a SYSTEM "https://never-fetch.invalid"><Envelope'),base.replace('</Body>','<?private forbidden?></Body>')];
 for(const xml of bad)assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(xml)}),rejected);
});

test('bytes are bounded, native-sliced and strict UTF8; shared memory and forged byte accessors cannot enter',()=>{
 const f=prepared(),raw=bytes(envelope(fiscalResponse(f.source))),store=Buffer.alloc(raw.length+20);store.set(raw,10);
 assert.equal(extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:store.subarray(10,-10)}).envelopeHash,hash(raw));
 for(const b of [new Uint8Array(),Buffer.alloc(MAX_AUTHORIZATION_SOAP_BYTES+1),new Uint8Array(new SharedArrayBuffer(20)),new DataView(new ArrayBuffer(10)),[],{},'xml'])assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:b}),error('SOAP_AUTHORIZATION_BYTES_INVALID'));
 assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:Buffer.from([0xc0,0x80])}),error('SOAP_AUTHORIZATION_ENCODING_INVALID'));
 assert.throws(()=>extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),raw])}),error('SOAP_AUTHORIZATION_XML_INVALID'));
 let reads=0;Object.defineProperty(raw,'byteLength',{get(){reads++;throw Error('PRIVATE');}});Object.defineProperty(raw,Symbol.iterator,{value(){reads++;throw Error('PRIVATE');}});
 assert.equal(extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:raw}).envelopeHash,hash(raw));assert.equal(reads,0);
});

test('the512000 limit includes the envelope; a maximum core payload cannot silently exceed the wire budget',()=>{
 const signer=createSigner({...fixture.credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});
 try{
  const base=buildBusinessXml(businessFixture({model:'55'})).unsignedXml;
  const sign=length=>{const xml=base.replace(/<infCpl>[\s\S]*?<\/infCpl>/,`<infCpl>${'X'.repeat(length)}</infCpl>`),signed=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:'55',expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:hash(fixture.credential.certificateDer),now:NOW});return core({signed,signedBytes:bytes(signed.signedXml)});};
  const initial=sign(1),largest=sign(MAX_AUTHORIZATION_SOAP_BYTES-initial.sizeBytes+1);
  assert.equal(largest.sizeBytes,MAX_AUTHORIZATION_SOAP_BYTES);
  assert.throws(()=>prepareReviewedAuthorizationSoap({request:largest}),error('SOAP_AUTHORIZATION_SIZE_LIMIT'));
 }finally{disposeSigner(signer);}
});

test('extracted fiscal payload still requires the real pinned XSD validator',async()=>{
 const validate=createAuthorizationValidator({pythonPath:TEST_PYTHON,validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
 for(const model of ['55','65']){const f=prepared(model);
 const requestReport=await validate({request:f.source,xmlBytes:authorizationRequestBytes(f.source),kind:'request'});assert.equal(requestReport.ok,true);assert.equal(requestReport.canTransmit,false);
 for(const invalid of [false,true]){
  const raw=decode(fiscalResponse(f.source)).replace('SINTETICO</verAplic>',`${invalid?'X'.repeat(100):'SINTETICO'}</verAplic>`);
  const c=extractReviewedAuthorizationSoap({request:f.request,envelopeBytes:bytes(envelope(bytes(raw)))});
  assert.equal(c.xsdValidated,false);const report=await validate({request:f.source,xmlBytes:bytes(c.payloadXml),kind:'response'});
  assert.equal(report.ok,!invalid);if(!invalid){
   assert.equal(report.xsdValidated,true);assert.equal(report.canTransmit,false);
   const processed=composeProcessedNfe({request:f.source,response:c.response}),proof=await validate({request:f.source,xmlBytes:bytes(processed.processedXml),kind:'processed'});
   assert.equal(proof.ok,true);assert.equal(proof.referenceDigestMatched,true);assert.equal(proof.canTransmit,false);assert.equal(proof.authorizedInHomologation,false);
  }else assert.equal(report.code,'AUTHORIZATION_XSD_INVALID');
 }}
});

test('the observed local WSDL matches every pinned wrapper/action/address and rejects any byte change',{skip:process.env.BRUFAP_TEST_LOCAL_AUTHORIZATION_WSDL!=='1'},()=>{
 for(const model of ['55','65']){
 const raw=readFileSync(new URL(`../../../private/fiscal/wsdl/model-${model}-authorization-20261016.xml`,import.meta.url));
 // Both the pin and parser inspect the original bytes, including the declaration.
 const b=verifyReviewedAuthorizationWsdl({model,wsdlBytes:raw}),doc=parseStrict(decode(raw)),W='http://schemas.xmlsoap.org/wsdl/',S='http://schemas.xmlsoap.org/wsdl/soap12/';
 assert.equal(doc.documentElement.getAttribute('targetNamespace'),b.serviceNamespace);
 const nodes=Array.from(doc.getElementsByTagName('*')),binding=nodes.find(n=>n.namespaceURI===W&&n.localName==='binding');assert.equal(binding.getAttribute('name'),b.bindingName);
 const op=elements(binding).find(n=>n.localName==='operation'&&n.namespaceURI===W&&n.getAttribute('name')===b.operationName);
 assert.equal(elements(op).find(n=>n.namespaceURI===S&&n.localName==='operation').getAttribute('soapAction'),b.soapAction);
 for(const [messageName,partName,element]of [[b.inputMessage,b.inputPart,b.inputElement],[b.outputMessage,b.outputPart,b.outputElement]]){
  const m=nodes.find(n=>n.namespaceURI===W&&n.localName==='message'&&n.getAttribute('name')===messageName),part=elements(m)[0];
  assert.equal(part.getAttribute('name'),partName);assert.equal(part.getAttribute('element'),'tns:'+element);assert.equal(part.lookupNamespaceURI('tns'),SERVICE);
 }
 assert.equal(nodes.find(n=>n.namespaceURI===S&&n.localName==='address').getAttribute('location'),b.endpoint);
 assert.equal(nodes.filter(n=>n.localName==='header'||n.localName==='import'||n.localName==='include').length,0);
 const changed=Buffer.from(raw);changed[changed.length-1]^=1;assert.throws(()=>verifyReviewedAuthorizationWsdl({model,wsdlBytes:changed}),error('SOAP_AUTHORIZATION_WSDL_MISMATCH'));
 assert.throws(()=>verifyReviewedAuthorizationWsdl({model:model==='55'?'65':'55',wsdlBytes:raw}),error('SOAP_AUTHORIZATION_WSDL_MISMATCH'));
 }
});
