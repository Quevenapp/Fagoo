import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {credentials} from '../../fiscal-xml/test/fixtures.mjs';
import {pinnedCandidateCertificate} from '../src/pinned-certificate.mjs';
import {prepareAuthorization} from '../src/index.mjs';
import {AuthorizationServiceError} from '../src/service-common.mjs';
import {signedFixture,hash,HOLDER,NOW} from './service-fixtures.mjs';
let f;before(async()=>{f=await signedFixture();});after(()=>f.close());
const error=code=>e=>e instanceof AuthorizationServiceError&&e.code===code&&e.message===code;
test('pinned050 public certificate verifies55/65/250items without loading a private key',()=>{
 for(const model of ['55','65'])for(const count of [1,250]){
  const x=f.create(model,count),proof=pinnedCandidateCertificate(x.input);
  assert.equal(proof.issuerCnpj,HOLDER);assert.equal(proof.referenceDigest,x.signed.referenceDigest);assert.equal(proof.signatureVerified,true);
  assert.equal(proof.certificate,f.credential.certificate);assert.ok(Object.isFrozen(proof));
  const request=prepareAuthorization({signedBytes:x.signedBytes,expectedSignedHash:x.input.signedHash,expectedModel:model,expectedIssuerCnpj:proof.issuerCnpj,expectedHolderCnpj:proof.issuerCnpj,expectedCertificate:proof.certificate,expectedCertificateFingerprint:proof.certificateFingerprint,now:NOW,batchId:'7'});
  assert.equal(request.accessKey,proof.accessKey);assert.equal(request.batchId,'7');assert.equal(request.canTransmit,false);
  assert.equal(Object.hasOwn(proof,'subject'),false);assert.equal(Object.hasOwn(proof,'privateKey'),false);
 }
});
test('signed artifact hash and size are checked before any certificate is accepted',()=>{
 const x=f.create();for(const patch of [{signedHash:'0'.repeat(64)},{signedSize:x.input.signedSize+1},{signedBytes:Buffer.from('<invalid/>')}])assert.throws(()=>pinnedCandidateCertificate({...x.input,...patch}),error('AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH'));
 assert.throws(()=>pinnedCandidateCertificate({...x.input,certificateFingerprint:'0'.repeat(64)}),error('AUTHORIZATION_PINNED_CERTIFICATE_INVALID'));
});
test('a replaced certificate is refused even when attacker changes XML hash and fingerprint together',async()=>{
 const x=f.create(),other=await credentials(),xml=x.signed.signedXml.replace(/<X509Certificate>[^<]+<\/X509Certificate>/,`<X509Certificate>${other.certificateDer.toString('base64')}</X509Certificate>`),b=Buffer.from(xml);
 assert.throws(()=>pinnedCandidateCertificate({...x.input,signedBytes:b,signedHash:hash(b),signedSize:b.length,certificateFingerprint:hash(other.certificateDer)}),error('AUTHORIZATION_PINNED_CERTIFICATE_INVALID'));
});
test('duplicate and alternate public-key sources are rejected despite a fresh byte hash',()=>{
 const x=f.create(),cert=x.signed.signedXml.match(/<X509Certificate>[^<]+<\/X509Certificate>/)[0];
 for(const xml of [x.signed.signedXml.replace('</X509Data>',cert+'</X509Data>'),x.signed.signedXml.replace('</KeyInfo>','<KeyValue/></KeyInfo>'),x.signed.signedXml.replace('</NFe>',`<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data>${cert}</X509Data></KeyInfo></NFe>`),x.signed.signedXml.replace('<NFe ','<!DOCTYPE NFe [<!ENTITY x SYSTEM "file:///private">]><NFe ')]){
  const b=Buffer.from(xml);assert.throws(()=>pinnedCandidateCertificate({...x.input,signedBytes:b,signedHash:hash(b),signedSize:b.length}),error('AUTHORIZATION_PINNED_CERTIFICATE_INVALID'));
 }
});
test('own data options, finite historical clock and unshared owned bytes are required',()=>{
 const x=f.create();let called=0;const accessor={...x.input};Object.defineProperty(accessor,'signedBytes',{get(){called++;return x.signedBytes;},enumerable:true});
 assert.throws(()=>pinnedCandidateCertificate(accessor));assert.equal(called,0);
 assert.throws(()=>pinnedCandidateCertificate(Object.create(x.input)));assert.throws(()=>pinnedCandidateCertificate({...x.input,now:new Date(NaN)}));
 assert.throws(()=>pinnedCandidateCertificate({...x.input,signedBytes:new Uint8Array(new SharedArrayBuffer(x.signedBytes.length))}),error('AUTHORIZATION_SERVICE_BYTES_INVALID'));
 const padded=Buffer.concat([Buffer.from('PREFIX'),x.signedBytes,Buffer.from('SUFFIX')]);const sub=padded.subarray(6,-6),before=Buffer.from(padded);
 assert.equal(pinnedCandidateCertificate({...x.input,signedBytes:sub}).certificateFingerprint,x.input.certificateFingerprint);assert.deepEqual(padded,before);
 assert.throws(()=>pinnedCandidateCertificate({...x.input,model:'65'}),error('AUTHORIZATION_PINNED_CERTIFICATE_INVALID'));
});
