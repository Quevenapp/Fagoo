// Mounted read-only into a cached production image. Input is generated synthetic data only.
import assert from 'node:assert/strict';
import {createHash,createPrivateKey} from 'node:crypto';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '/app/packages/fiscal-xml/src/index.mjs';
import {createFiscalSchemaRunner} from '/app/packages/fiscal-schema-runner/src/index.mjs';
assert.notEqual(process.getuid(),0);
const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;assert.ok(size<=2097152);chunks.push(chunk);}
const bytes=Buffer.concat(chunks);let input;try{input=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);chunks.forEach(c=>c.fill(0));}
assert.equal(input.synthetic_fixture,true);assert.equal(input.cases.length,2);
const privateDer=Buffer.from(input.private_der,'base64'),certificateDer=Buffer.from(input.certificate_der,'base64'),hash=b=>createHash('sha256').update(b).digest('hex');
const signer=createSigner({privateKey:createPrivateKey({key:privateDer,type:'pkcs8',format:'der'}),certificate:certificateDer,expectedHolderCnpj:input.holder,now:new Date(input.now),purpose:'offline-homologation'});
const validate=createFiscalSchemaRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath:'/app/packages/fiscal-schema/validator.py'}),results=[];
try{
 for(const item of input.cases){
  const result=createSignedHomologationCandidate({xml:item.xml,signer,expectedIssuerCnpj:input.holder,expectedModel:item.model,expectedUnsignedHash:hash(item.xml),expectedCertificateFingerprint:hash(certificateDer),now:new Date(input.now)});
  assert.equal(result.xmlDigest,item.expected_signed_hash);assert.equal(result.signatureVerified,true);assert.equal(result.qrProfile,item.model==='65'?'sp-homologation-online-qr-v3':null);
  assert.match(result.signedXml,/<vUnCom>10\.1234567891<\/vUnCom>/);
  const report=await validate(Buffer.from(result.signedXml),{expectedModel:item.model,expectedHash:result.xmlDigest});assert.equal(report.ok,true);assert.equal(report.xsdValidated,true);
  assert.equal(result.canTransmit,false);assert.equal(result.sefazAuthorized,false);
  results.push({model:item.model,same_signed_bytes:true,signature_verified:true,xsd_validated:true,qr_profile:result.qrProfile,can_transmit:false});
 }
 console.log(JSON.stringify({synthetic_fixture:true,real_certificate_used:false,network_used:false,results}));
}finally{disposeSigner(signer);privateDer.fill(0);certificateDer.fill(0);input=null;}
