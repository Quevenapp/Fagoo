import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {prepareAuthorization,authorizationRequestBytes,parseAuthorizationResponse,composeProcessedNfe,authorizationBindingStatus,FiscalAuthorizationError} from '../src/index.mjs';
import {credentials,HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {businessFixture} from '../../fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../fiscal-xml/src/business-builder.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {TEST_PYTHON} from './test-runtime.mjs';
const require=createRequire(new URL('../../fiscal-xml/package.json',import.meta.url));
const {SignedXml}=require('xml-crypto');
const hash=v=>createHash('sha256').update(v).digest('hex'), bytes=v=>new TextEncoder().encode(v), decode=v=>new TextDecoder().decode(v);
const NS='http://www.portalfiscal.inf.br/nfe';
let credential,signer;
before(async()=>{credential=await credentials();signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:NOW});});
after(()=>disposeSigner(signer));
function fixture(model='55',count=1){
 const unsigned=buildBusinessXml(businessFixture({model,count})).unsignedXml;
 const signed=createSignedHomologationCandidate({xml:unsigned,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(unsigned),expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW});
 const input={signedBytes:bytes(signed.signedXml),expectedSignedHash:signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedCertificateFingerprint:hash(credential.certificateDer),now:NOW,batchId:'1'};
 return {signed,input,request:prepareAuthorization(input)};
}
function response(request,{batch='104',status='100',key=request.accessKey,digest=request.referenceDigest,number='13526000000000001',protocol=true,receipt=false}={}){
 return `<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><cStat>${batch}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo><cUF>35</cUF><dhRecbto>2026-10-16T09:01:00-03:00</dhRecbto>${receipt?'<infRec><nRec>350000000000001</nRec><tMed>1</tMed></infRec>':''}${protocol?`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-10-16T09:01:00-03:00</dhRecbto>${number===null?'':`<nProt>${number}</nProt>`}${digest===null?'':`<digVal>${digest}</digVal>`}<cStat>${status}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo></infProt></protNFe>`:''}</retEnviNFe>`;
}
const parse=(request,options)=>parseAuthorizationResponse({request,responseBytes:bytes(response(request,options))});
const error=code=>e=>e instanceof FiscalAuthorizationError&&e.code===code&&e.message===code;
function assertDisabled(v){for(const k of ['sefazAuthorized','authorizedInHomologation','productionAuthorized','legalFiscalValue','canEmit','canTransmit','retrySubmissionAllowed','tlsOriginVerified'])assert.equal(v[k],false,k);}

test('55/65 single synchronous batch preserves the exact signed bytes and returns owned copies',()=>{
 for(const model of ['55','65']){
  const f=fixture(model), first=authorizationRequestBytes(f.request), expected=decode(first);
  assert.ok(expected.includes(f.signed.signedXml));assert.match(expected,/<idLote>1<\/idLote><indSinc>1<\/indSinc>/);
  assert.equal(hash(first),f.request.requestHash);assert.equal(f.request.referenceDigest,f.signed.referenceDigest);assertDisabled(f.request);
  first.fill(0);f.input.signedBytes.fill(0);f.input.now.setTime(NOW.getTime());assert.equal(decode(authorizationRequestBytes(f.request)),expected);
  assert.ok(Object.isFrozen(f.request));assert.throws(()=>authorizationRequestBytes({...f.request}),error('AUTHORIZATION_REQUEST_UNATTESTED'));
 }
});
test('103/104 and individual status are distinct; 217, duplicates and unknown processing never permit resend',()=>{
 const {request}=fixture();
 const receipt=parse(request,{batch:'103',protocol:false,receipt:true});assert.equal(receipt.classification,'receipt_pending');assert.equal(receipt.receiptNumber,'350000000000001');assertDisabled(receipt);
 for(const status of ['100','150']){const r=parse(request,{status});assert.equal(r.classification,'authorization_declared');assert.equal(r.protocol.cStat,status);assertDisabled(r);}
 assert.equal(parse(request,{status:'302',digest:null,number:null}).classification,'rejected');
 for(const status of ['204','539','106','217']){const r=parse(request,{status,digest:null,number:null});assert.equal(r.classification,'review_required');assertDisabled(r);}
 for(const batch of ['105','106','217','204','539'])assert.equal(parse(request,{batch,protocol:false}).classification,'review_required');
 assert.equal(parse(request,{batch:'225',protocol:false}).classification,'rejected');
 assert.throws(()=>parse(request,{batch:'104',protocol:false}),error('AUTHORIZATION_BATCH_STRUCTURE_MISMATCH'));
 assert.throws(()=>parse(request,{batch:'103',receipt:true}),error('AUTHORIZATION_BATCH_STRUCTURE_MISMATCH'));
});
test('processed55/65 preserves original NFe and signature verified independently over the full nfeProc',()=>{
 for(const model of ['55','65'])for(const status of ['100','150']){
  const f=fixture(model),r=parse(f.request,{status}),p=composeProcessedNfe({request:f.request,response:r});
  assert.ok(p.processedXml.includes(f.signed.signedXml));assert.equal(p.referenceDigest,f.signed.referenceDigest);assert.equal(p.signatureVerified,true);assertDisabled(p);
  const sig=new SignedXml({publicCert:credential.certificate,getCertFromKeyInfo:()=>null});sig.loadSignature(p.processedXml.match(/<Signature\b[\s\S]*?<\/Signature>/)[0]);
  assert.equal(sig.checkSignature(p.processedXml),true);assert.equal(sig.getSignedReferences().length,1);
  assert.equal(createHash('sha1').update(sig.getSignedReferences()[0]).digest('base64'),f.request.referenceDigest);
  assert.equal(hash(p.processedXml),p.processedHash);
 }
});
test('response bytes are captured, clones and responses belonging to another request cannot compose',()=>{
 const f=fixture(),raw=bytes(response(f.request)),r=parseAuthorizationResponse({request:f.request,responseBytes:raw});raw.fill(0);
 assert.equal(composeProcessedNfe({request:f.request,response:r}).responseHash,r.responseHash);
 const other=prepareAuthorization({...f.input,batchId:'2'});
 assert.throws(()=>composeProcessedNfe({request:other,response:r}),error('AUTHORIZATION_RESPONSE_UNATTESTED'));
 assert.throws(()=>composeProcessedNfe({request:f.request,response:{...r}}),error('AUTHORIZATION_RESPONSE_UNATTESTED'));
 assert.throws(()=>composeProcessedNfe({request:f.request,response:parse(f.request,{batch:'103',protocol:false,receipt:true})}),error('AUTHORIZATION_PROTOCOL_NOT_AUTHORIZED_DECLARATION'));
});
test('model/hash/certificate/issuer bindings and exact input descriptors are mandatory before construction',()=>{
 const f=fixture();
 for(const patch of [{expectedModel:'65'},{expectedIssuerCnpj:'00000000000000'}])assert.throws(()=>prepareAuthorization({...f.input,...patch}),e=>e instanceof FiscalAuthorizationError);
 assert.throws(()=>prepareAuthorization({...f.input,expectedSignedHash:'0'.repeat(64)}),error('AUTHORIZATION_SIGNED_HASH_MISMATCH'));
 assert.throws(()=>prepareAuthorization({...f.input,expectedCertificateFingerprint:'0'.repeat(64)}),error('AUTHORIZATION_CERTIFICATE_MISMATCH'));
 for(const batchId of ['0','01','-1','1.0','1'.repeat(16),1])assert.throws(()=>prepareAuthorization({...f.input,batchId}),error('AUTHORIZATION_INPUT_INVALID'));
 let called=0;const g={...f.input};Object.defineProperty(g,'signedBytes',{get(){called++;return f.input.signedBytes;},enumerable:true});assert.throws(()=>prepareAuthorization(g),error('AUTHORIZATION_INPUT_INVALID'));assert.equal(called,0);
 assert.throws(()=>prepareAuthorization({...f.input,canTransmit:true}),error('AUTHORIZATION_INPUT_INVALID'));
 assert.throws(()=>prepareAuthorization({...f.input,now:new Date(NaN)}),error('AUTHORIZATION_CLOCK_INVALID'));
 assert.throws(()=>prepareAuthorization({...f.input,signedBytes:new Uint8Array(new SharedArrayBuffer(4))}),error('AUTHORIZATION_BYTES_INVALID'));
 const storage=new Uint8Array(f.input.signedBytes.length+20);storage.set(f.input.signedBytes,10);assert.equal(prepareAuthorization({...f.input,signedBytes:storage.subarray(10,-10)}).requestHash,f.request.requestHash);
});
test('wrong digest/key/ambient, missing authorization fields and malformed dates cannot become a processed candidate',()=>{
 const {request}=fixture();
 assert.throws(()=>parse(request,{digest:Buffer.alloc(20).toString('base64')}),error('AUTHORIZATION_PROTOCOL_DIGEST_MISMATCH'));
 assert.throws(()=>parse(request,{key:request.accessKey.slice(0,-1)+'0'}),error('AUTHORIZATION_PROTOCOL_CONTEXT_MISMATCH'));
 for(const options of [{digest:null},{number:null},{number:'0'.repeat(17)}])assert.throws(()=>parse(request,options),e=>e instanceof FiscalAuthorizationError);
 for(const [a,b] of [['<tpAmb>2','<tpAmb>1'],['2026-10-16T09:01:00-03:00','2026-02-30T12:01:00Z'],['<cUF>35','<cUF>33']])assert.throws(()=>parseAuthorizationResponse({request,responseBytes:bytes(response(request).replace(a,b))}),e=>e instanceof FiscalAuthorizationError);
 for(const xml of [response(request).replace('<retEnviNFe','<!DOCTYPE x SYSTEM "https://never-open.invalid"><retEnviNFe'),response(request).replace('</retEnviNFe>','<cStat>104</cStat></retEnviNFe>')])assert.throws(()=>parseAuthorizationResponse({request,responseBytes:bytes(xml)}),e=>e instanceof FiscalAuthorizationError);
});
test('without authorization WSDL evidence binding stays closed; this module has no SOAP endpoint or grant',()=>{
 for(const model of ['55','65']){const b=authorizationBindingStatus(model);assert.equal(b.status,'reviewed_wsdl_required');assert.equal(b.canTransmit,false);assert.equal(b.bindingReviewed,false);assert.equal('endpoint'in b,false);assert.equal('soapAction'in b,false);}
});

const PYTHON=TEST_PYTHON;
const validator=fileURLToPath(new URL('../validator.py',import.meta.url));
function xsd(f,xml,kind){
 const r=spawnSync(PYTHON,['-I','-B',validator],{input:JSON.stringify({xml,kind,expectedModel:f.request.model,expectedAccessKey:f.request.accessKey,expectedReferenceDigest:f.request.referenceDigest,expectedBatchId:f.request.batchId}),encoding:'utf8',timeout:15000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 assert.ifError(r.error);assert.equal(r.stderr,'');return {exit:r.status,...JSON.parse(r.stdout)};
}
test('real pinned XSD validates 55/65 request,103,104,100/150,rejection and nfeProc, including250 items',()=>{
 for(const model of ['55','65']){
  const f=fixture(model,250),wire=decode(authorizationRequestBytes(f.request));
  for(const [xml,kind] of [[wire,'request'],[response(f.request,{batch:'103',protocol:false,receipt:true}),'response'],[response(f.request,{batch:'225',protocol:false}),'response']]){
   const r=xsd(f,xml,kind);assert.equal(r.ok,true,model+' '+kind+' '+JSON.stringify(r));assert.equal(r.xmlDigest,hash(xml));assert.equal(r.xsdValidated,true);assert.equal(r.sefazAuthorized,false);assert.equal(r.canTransmit,false);
  }
  for(const status of ['100','150']){
   const raw=response(f.request,{status}),parsed=parseAuthorizationResponse({request:f.request,responseBytes:bytes(raw)}),processed=composeProcessedNfe({request:f.request,response:parsed});
   assert.equal(xsd(f,raw,'response').ok,true);const p=xsd(f,processed.processedXml,'processed');assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.protocolCStat,status);assert.equal(p.referenceDigestMatched,true);assert.equal(p.signatureVerified,false);
  }
 }
});
test('real XSD and contextual validation reject wrong digest, production, malformed business data and multi-document batches',()=>{
 const f=fixture(),wire=decode(authorizationRequestBytes(f.request));
 for(const [xml,kind] of [[wire.replace('<indSinc>1','<indSinc>0'),'request'],[wire.replace('</enviNFe>',f.signed.signedXml+'</enviNFe>'),'request'],[wire.replace('<vProd>','<vProd>bad'),'request'],[response(f.request,{digest:Buffer.alloc(20).toString('base64')}),'response'],[response(f.request).replaceAll('<tpAmb>2','<tpAmb>1'),'response']]){
  const r=xsd(f,xml,kind);assert.equal(r.ok,false);assert.equal(r.exit,2);assert.equal(r.canTransmit,false);assert.ok(!JSON.stringify(r).includes(f.request.accessKey));
 }
});

test('Node validation port binds owned bytes before await and projects a bounded real Python report',async()=>{
 const f=fixture('65'),xmlBytes=authorizationRequestBytes(f.request),validate=createAuthorizationValidator({pythonPath:PYTHON,validatorPath:validator});
 const pending=validate({request:f.request,xmlBytes,kind:'request'});xmlBytes.fill(0);
 const r=await pending;assert.equal(r.ok,true);assert.equal(r.xmlDigest,f.request.requestHash);assert.equal(r.xsdValidated,true);assert.equal(r.signatureVerified,false);assert.equal(r.sefazAuthorized,false);
 await assert.rejects(validate({request:f.request,xmlBytes:bytes('<wrong/>'),kind:'request'}),error('AUTHORIZATION_REQUEST_HASH_MISMATCH'));
 const invalid=await validate({request:f.request,xmlBytes:bytes(response(f.request).replace('<cStat>104','<cStat>xx')) ,kind:'response'});assert.equal(invalid.ok,false);assert.equal(invalid.code,'AUTHORIZATION_XSD_INVALID');
});
function child(){const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kills=[];c.kill=s=>{c.kills.push(s);return true;};return c;}
test('Node port cancellation and timeout kill the process and ignore late output without leaking errors',async()=>{
 const f=fixture(),c=child(),scope=new AbortController();let spawnOptions,calls=0;
 const validate=createAuthorizationValidator({pythonPath:'/synthetic/python',validatorPath:'/synthetic/validator.py',spawnImpl:(_p,_a,o)=>{calls++;spawnOptions=o;return c;}});
 const args={request:f.request,xmlBytes:authorizationRequestBytes(f.request),kind:'request'},opts={signal:scope.signal,deadline:Date.now()+2000};
 const pending=validate(args,opts);opts.signal=new AbortController().signal;scope.abort();await assert.rejects(pending,error('AUTHORIZATION_VALIDATOR_ABORTED'));assert.deepEqual(c.kills,['SIGKILL']);assert.equal(calls,1);
 c.stdout.emit('data',Buffer.from('PRIVATE_CERTIFICATE'));c.emit('close',0,null);assert.deepEqual(Object.keys(spawnOptions.env).sort(),['LANG','PATH']);assert.equal(spawnOptions.shell,false);
 const expired=new AbortController();expired.abort();await assert.rejects(validate(args,{signal:expired.signal}),error('AUTHORIZATION_VALIDATOR_ABORTED'));assert.equal(calls,1);
 const t=child(),timeout=createAuthorizationValidator({pythonPath:'/synthetic/python',validatorPath:'/synthetic/validator.py',spawnImpl:()=>t});await assert.rejects(timeout(args,{deadline:Date.now()+10}),error('AUTHORIZATION_VALIDATOR_TIMEOUT'));assert.deepEqual(t.kills,['SIGKILL']);
});
test('Node port rejects oversized stdout and forged flags with closed errors',async()=>{
 const f=fixture(),args={request:f.request,xmlBytes:authorizationRequestBytes(f.request),kind:'request'};
 for(const kind of ['oversized','forged']){
  const c=child(),validate=createAuthorizationValidator({pythonPath:'/synthetic/python',validatorPath:'/synthetic/validator.py',spawnImpl:()=>c}),pending=validate(args);
  if(kind==='oversized')c.stdout.emit('data',Buffer.alloc(16385));else{c.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,canTransmit:true,secret:'PRIVATE_SENTINEL'})));c.emit('close',0,null);}
  await assert.rejects(pending,error(kind==='oversized'?'AUTHORIZATION_VALIDATOR_OUTPUT_LIMIT':'AUTHORIZATION_VALIDATOR_RESPONSE_INVALID'));assert.deepEqual(c.kills,['SIGKILL']);
 }
});
