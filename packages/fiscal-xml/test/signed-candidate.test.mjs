import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSignedHomologationCandidate,createSigner,disposeSigner,verifyNfeXml,NFCE_SP_HOMOLOGATION_QR_V3,FiscalXmlError} from '../src/index.mjs';
import {buildBusinessXml} from '../src/business-builder.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {credentials,unsignedXml,HOLDER,OTHER,NOW} from './fixtures.mjs';
import {MAX_XML_BYTES} from '../src/common.mjs';
const digest=xml=>createHash('sha256').update(xml,'utf8').digest('hex');
let credential,signer,other;
before(async()=>{credential=await credentials();other=await credentials();signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});});
after(()=>disposeSigner(signer));
const input=(xml=unsignedXml(),model='55')=>({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:digest(xml),expectedCertificateFingerprint:digest(credential.certificateDer),now:NOW});
const code=value=>error=>error instanceof FiscalXmlError&&error.code===value&&error.message===value;
const verify=(result)=>verifyNfeXml({xml:result.signedXml,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:NOW,...(result.model==='65'?{nfceQrProfile:NFCE_SP_HOMOLOGATION_QR_V3}:{})});

test('closed candidate signs55 and65, checks the final reference and returns only pinned minimal metadata',()=>{
 for(const model of ['55','65']){
  const xml=unsignedXml({model}),result=createSignedHomologationCandidate(input(xml,model)),verified=verify(result);
  assert.equal(result.signatureVerified,true);assert.equal(result.model,model);assert.equal(result.xmlDigest,digest(result.signedXml));assert.equal(result.sizeBytes,Buffer.byteLength(result.signedXml,'utf8'));
  assert.equal(result.certificateFingerprint,digest(credential.certificateDer));assert.equal(result.signedContentDigest,digest(verified.authenticatedInfNfe));
  assert.equal(result.referenceDigest,createHash('sha1').update(verified.authenticatedInfNfe,'utf8').digest('base64'));assert.equal(result.referenceDigest,result.signedXml.match(/<DigestValue>([^<]+)<\/DigestValue>/)[1]);
  assert.equal(result.qrProfile,model==='65'?NFCE_SP_HOMOLOGATION_QR_V3:null);assert.equal(result.signedXml.includes('<infNFeSupl>'),model==='65');
  assert.deepEqual(Object.keys(result).sort(),['signedXml','xmlDigest','signedContentDigest','referenceDigest','certificateFingerprint','model','sizeBytes','signatureVerified','qrProfile','xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canEmit','canTransmit'].sort());
  for(const flag of ['xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canEmit','canTransmit'])assert.equal(result[flag],false);
  assert.ok(Object.isFrozen(result));assert.equal('authenticatedInfNfe'in result,false);assert.equal('certificate'in result,false);assert.equal('privateKey'in result,false);assert.equal('subject'in result,false);assert.equal('identity'in result,false);
  assert.doesNotMatch(JSON.stringify(result),/BEGIN PRIVATE KEY|BEGIN CERTIFICATE|-----BEGIN/);
 }
});
test('same XML, certificate and fixed profile produce identical final bytes without new identity or clock-derived fields',()=>{
 for(const model of ['55','65']){
  const xml=buildBusinessXml(businessFixture({model})).unsignedXml,args=input(xml,model),first=createSignedHomologationCandidate(args),again=createSignedHomologationCandidate({...args,now:new Date('2026-11-01T00:00:00Z')});
  assert.deepEqual(first,again);assert.equal(args.xml,xml);assert.equal(args.now,NOW);assert.equal(first.signedXml.match(/<nNF>([^<]+)<\/nNF>/)[1],'1');assert.equal(first.signedXml.match(/<cNF>([^<]+)<\/cNF>/)[1],'12345678');
  assert.equal(first.signedXml.match(/<dhEmi>([^<]+)<\/dhEmi>/)[1],'2026-10-16T09:00:00-03:00');
 }
});
test('250-line candidates stay within the byte limit for both models and preserve the authenticated business content',()=>{
 for(const model of ['55','65']){
  const xml=buildBusinessXml(businessFixture({model,count:250})).unsignedXml,result=createSignedHomologationCandidate(input(xml,model));
  assert.equal((result.signedXml.match(/<det /g)||[]).length,250);assert.ok(result.sizeBytes<=MAX_XML_BYTES);assert.equal(verify(result).signatureVerified,true);
  assert.equal(result.referenceDigest,result.signedXml.match(/<DigestValue>([^<]+)<\/DigestValue>/)[1]);
 }
});
test('the expected unsigned bytes, model, issuer and certificate fingerprint are mandatory bindings',()=>{
 const args=input();
 assert.throws(()=>createSignedHomologationCandidate({...args,xml:args.xml.replace('EMPRESA FICTICIA','OUTRA EMPRESA')}),code('XML_UNSIGNED_HASH_MISMATCH'));
 assert.throws(()=>createSignedHomologationCandidate({...args,expectedUnsignedHash:'0'.repeat(64)}),code('XML_UNSIGNED_HASH_MISMATCH'));
 assert.throws(()=>createSignedHomologationCandidate({...args,expectedModel:'65'}),code('XML_MODEL_MISMATCH'));
 assert.throws(()=>createSignedHomologationCandidate({...args,expectedIssuerCnpj:OTHER}),code('XML_EXPECTED_ISSUER_MISMATCH'));
 assert.throws(()=>createSignedHomologationCandidate({...args,expectedCertificateFingerprint:digest(other.certificateDer)}),code('XML_CERTIFICATE_PIN_MISMATCH'));
 const otherSigner=createSigner({...other,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});
 try{assert.throws(()=>createSignedHomologationCandidate({...args,signer:otherSigner}),code('XML_CERTIFICATE_PIN_MISMATCH'));}finally{disposeSigner(otherSigner);}
});
test('disposed or copied signer handles cannot be used or repaired with caller-provided certificate material',()=>{
 const disposable=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW}),args=input();disposeSigner(disposable);
 assert.throws(()=>createSignedHomologationCandidate({...args,signer:disposable}),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));
 assert.throws(()=>createSignedHomologationCandidate({...args,signer:{...signer}}),code('SIGNER_HANDLE_INVALID_OR_DISPOSED'));
 assert.throws(()=>createSignedHomologationCandidate({...args,expectedCertificate:credential.certificate}),code('SIGNED_CANDIDATE_INPUT_INVALID'));
});
test('explicit clock and exact closed options exclude unsupported QR profiles, time coercion and getter inputs',()=>{
 const args=input();
 for(const patch of [{expectedModel:55},{expectedUnsignedHash:args.expectedUnsignedHash.toUpperCase()},{expectedCertificateFingerprint:''},{qrProfile:'production'},{environment:'1'},{canEmit:true}])assert.throws(()=>createSignedHomologationCandidate({...args,...patch}),code('SIGNED_CANDIDATE_INPUT_INVALID'));
 for(const now of [null,'2026-10-16T12:00:00Z',NaN,new Date(NaN)])assert.throws(()=>createSignedHomologationCandidate({...args,now}),code('CERTIFICATE_CLOCK_INVALID'));
 assert.throws(()=>createSignedHomologationCandidate({...args,now:new Date('2028-01-01T00:00:00Z')}),code('CERTIFICATE_NOT_CURRENTLY_VALID'));
 const missing={...args};delete missing.now;assert.throws(()=>createSignedHomologationCandidate(missing),code('SIGNED_CANDIDATE_INPUT_INVALID'));
 let called=false;const getter={...args};Object.defineProperty(getter,'xml',{enumerable:true,get(){called=true;return args.xml;}});assert.throws(()=>createSignedHomologationCandidate(getter),code('SIGNED_CANDIDATE_INPUT_INVALID'));assert.equal(called,false);
 const hidden={...args};Object.defineProperty(hidden,'certificate',{value:credential.certificate});assert.throws(()=>createSignedHomologationCandidate(hidden),code('SIGNED_CANDIDATE_INPUT_INVALID'));
 assert.throws(()=>createSignedHomologationCandidate({...args,[Symbol('unsupported')]:true}),code('SIGNED_CANDIDATE_INPUT_INVALID'));
 const clock=new Date(NOW);clock.getTime=()=>{throw Error('UNTRUSTED_OVERRIDDEN_CLOCK');};assert.equal(createSignedHomologationCandidate({...args,now:clock}).signatureVerified,true);
});
test('production, incompatible NFC-e online identity, supplied supplements and existing signatures are rejected',()=>{
 const production=unsignedXml({environment:'1'});assert.throws(()=>createSignedHomologationCandidate(input(production)),code('XML_PRODUCTION_NOT_SUPPORTED'));
 for(const options of [{model:'65',cUF:'33'},{model:'65',tpEmis:'9'}]){const xml=unsignedXml(options);assert.throws(()=>createSignedHomologationCandidate(input(xml,'65')),code('NFCE_QR_IDENTITY_UNSUPPORTED'));}
 const result=createSignedHomologationCandidate(input());assert.throws(()=>createSignedHomologationCandidate(input(result.signedXml)),code('XML_NFE_STRUCTURE_INVALID'));
 const injected=unsignedXml({model:'65'}).replace('</NFe>','<infNFeSupl><qrCode>https://never-open.invalid</qrCode><urlChave>x</urlChave></infNFeSupl></NFe>');assert.throws(()=>createSignedHomologationCandidate(input(injected,'65')),code('XML_NFE_STRUCTURE_INVALID'));
});
test('strict XML and input/final byte limits apply independently of the caller-provided hash',()=>{
 for(const xml of ['', 'x'.repeat(MAX_XML_BYTES+1)])assert.throws(()=>createSignedHomologationCandidate(input(xml)),code('XML_SIZE_INVALID'));
 for(const xml of [unsignedXml().replace('<NFe','<!DOCTYPE NFe SYSTEM "https://never-open.invalid"><NFe'),unsignedXml().replace('EMPRESA FICTICIA','BAD\u0000TEXT'),unsignedXml().replace('EMPRESA FICTICIA','BAD\ud800TEXT')])assert.throws(()=>createSignedHomologationCandidate(input(xml)),error=>error instanceof FiscalXmlError);
 const source=unsignedXml(),full=source.replace('</infCpl>','x'.repeat(MAX_XML_BYTES-Buffer.byteLength(source))+'</infCpl>');assert.equal(Buffer.byteLength(full),MAX_XML_BYTES);
 assert.throws(()=>createSignedHomologationCandidate(input(full)),code('XML_SIZE_INVALID'));
});
test('post-signature content, key information and NFC-e supplement tampering fail explicit final verification',()=>{
 const result=createSignedHomologationCandidate(input(unsignedXml({model:'65'}),'65'));
 for(const changed of [result.signedXml.replace('EMPRESA FICTICIA','ALTERADA'),result.signedXml.replace('|3|2','|3|1'),result.signedXml.replace('homologacao.nfce.fazenda.sp.gov.br','never-open.invalid')])assert.throws(()=>verify({...result,signedXml:changed}),error=>error instanceof FiscalXmlError);
 const changed=result.signedXml.replace(/<X509Certificate>[^<]+/,`<X509Certificate>${other.certificateDer.toString('base64')}`);assert.throws(()=>verify({...result,signedXml:changed}),code('XML_CERTIFICATE_PIN_MISMATCH'));
 const replaced=result.signedXml.replace(/(<DigestValue>)([^<])/,(_,prefix,value)=>prefix+(value==='A'?'B':'A'));assert.throws(()=>verify({...result,signedXml:replaced}),error=>error instanceof FiscalXmlError);
});
