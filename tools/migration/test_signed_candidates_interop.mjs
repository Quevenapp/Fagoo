// Opt-in: real synthetic signing + official pinned XSD in a networkless local container.
// This is not connected to the installed A1, production Storage or SEFAZ.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {signedFixture,hash} from './fixtures/signed-candidate.mjs';
import {credentials,HOLDER} from '../../packages/fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../packages/fiscal-xml/src/index.mjs';
import {createFiscalSchemaRunner} from '../../packages/fiscal-schema-runner/src/index.mjs';

const enabled=process.env.BRUFAP_SIGNED_SCHEMA_DOCKER_TEST==='1';
test('050 real048 → synthetic signed55/65+QR → integral pinned XSD → immutable candidate',{skip:!enabled,timeout:60000},async()=>{
 const f=await signedFixture(),credential=await credentials(),certificate=new X509Certificate(credential.certificateDer),fp=hash(credential.certificateDer);
 const now=new Date(),signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now});
 let processes=0;
 const validatorPath=fileURLToPath(new URL('../../packages/fiscal-schema/validator.py',import.meta.url));
 const validate=createFiscalSchemaRunner({pythonPath:'/opt/fiscal-validator/bin/python3',validatorPath,spawnImpl:(program,args,options)=>{
  assert.equal(program,'/opt/fiscal-validator/bin/python3');assert.deepEqual(args.slice(0,3),['-I','-B',validatorPath]);assert.deepEqual(args.slice(3,4),['--model']);assert.ok(['55','65'].includes(args[4]));
  processes++;
  return spawn(process.env.BRUFAP_DOCKER_BIN??'/usr/local/bin/docker',['run','--rm','-i','--platform','linux/amd64','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--entrypoint',program,'brufap-fiscal-schema-test:local','-I','-B','/app/packages/fiscal-schema/validator.py','--model',args[4]],options);
 }});
 try{
  await f.configure({fingerprint_sha256:fp,presented_chain:[fp],not_before:certificate.validFromDate.toISOString(),not_after:certificate.validToDate.toISOString()});
  for(const model of ['55','65']){
   const s=await f.stored({model}),r=await f.begin(s),use=await f.use(r);
   const source=Buffer.from(f.files.get(use.unsigned_object.path));assert.equal(hash(source),use.unsigned_object.hash);assert.equal(source.length,use.unsigned_object.size);
   const signed=createSignedHomologationCandidate({xml:source.toString('utf8'),signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:use.unsigned_object.hash,expectedCertificateFingerprint:r.value.receipt.certificate_fingerprint,now});
   const bytes=Buffer.from(signed.signedXml,'utf8'),report=await validate(bytes,{expectedModel:model,expectedHash:signed.xmlDigest,signal:new AbortController().signal,deadline:Date.now()+10000});
   assert.equal(report.ok,true);assert.equal(report.xsdValidated,true);assert.equal(report.signatureVerified,false);assert.equal(signed.xsdValidated,false);
   const evidence={signature:{xml_hash:signed.xmlDigest,certificate_fingerprint:signed.certificateFingerprint,signed_content_hash:signed.signedContentDigest,reference_digest:signed.referenceDigest,profile:'nfe400-rsa-sha1-c14n-v1'},
    xsd:{xml_hash:report.xmlDigest,schema_profile:report.schemaProfile,manifest_hash:report.schemaManifestHash,validator_version:report.validatorVersion,validator_hash:report.validatorHash},qr:{profile:signed.qrProfile,verified:model==='65'}};
   const key=`candidates/${r.value.receipt.candidate_id}/${signed.xmlDigest}.xml`;f.files.set(key,Buffer.from(bytes));
   await f.object(r,signed.xmlDigest,bytes.length);const verified=Buffer.from(f.files.get(key));assert.equal(hash(verified),signed.xmlDigest);assert.equal(verified.length,bytes.length);verified.fill(0);
   const result=await f.finish(r,{hash:signed.xmlDigest,size:bytes.length,evidence});
   assert.equal(result.signed,true);assert.equal(result.signature_verified,true);assert.equal(result.xsd_validated,true);assert.equal(result.current.artifact_current,true);
   assert.equal(result.artifact.signed_hash,hash(bytes));assert.equal(result.artifact.evidence.signature.reference_digest,signed.referenceDigest);
   for(const key of ['can_emit','can_transmit','authorized','tax_rules_validated','icp_brasil_chain_validated','revocation_checked'])assert.equal(result[key],false);
   assert.doesNotMatch(JSON.stringify(result),/BEGIN CERTIFICATE|BEGIN PRIVATE KEY|<NFe|credentials\/|candidates\//);
   source.fill(0);bytes.fill(0);
  }
  assert.equal(processes,2);
 }finally{disposeSigner(signer);credential.privateDer.fill(0);await f.close();}
});
