// Explicit opt-in: real local Python/lxml XSD, real ephemeral RSA, real SQL048/050.
// Storage is in-memory. No certificate files, remote service, custody claims or transmission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,X509Certificate} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {signedFixture,hash} from '../../../tools/migration/fixtures/signed-candidate.mjs';
import {commercialFoundation,applyPricePrecision} from '../../../tools/migration/fixtures/fiscal-price-precision.mjs';
import {credentials,HOLDER} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,verifyNfeXml,NFCE_SP_HOMOLOGATION_QR_V3} from '../../fiscal-xml/src/index.mjs';
import {createFiscalSchemaRunner} from '../../fiscal-schema-runner/src/index.mjs';
import {createSignedFiscalOrchestrator} from '../src/signed.mjs';
import {publicResult} from '../../fiscal-signed-runtime/src/dto.mjs';
import {signedOutcome} from '../../../apps/erp/src/lib/fiscal-signed-model.ts';

const pythonPath=process.env.BRUFAP_FISCAL_PRECISION_PYTHON;
test('057 preserves stored050 and signs exact price10 NF-e/NFC-e through real local XSD and SQL evidence', {skip:!pythonPath,timeout:60000},async t=>{
 const f=await signedFixture();let credential;
 try{
  await commercialFoundation(f);
  credential=await credentials();const certificate=new X509Certificate(credential.certificateDer),fingerprint=hash(credential.certificateDer);
  await f.configure({fingerprint_sha256:fingerprint,presented_chain:[fingerprint],not_before:certificate.validFromDate.toISOString(),not_after:certificate.validToDate.toISOString()});
  const validate=createFiscalSchemaRunner({pythonPath,validatorPath:fileURLToPath(new URL('../../fiscal-schema/validator.py',import.meta.url))});
  const calls={schema:0,sign:0,put:0};
  const runtime=createSignedFiscalOrchestrator({
   rpc:async(name,args,opts)=>{assert.ok(opts.deadline>Date.now());assert.equal(opts.signal.aborted,false);return f.callSql(name,args);},
   storage:{
    read:async o=>{assert.equal(o.bucket,'brufap-fiscal-artifacts');const bytes=f.files.get(o.key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):null;},
    putImmutable:async o=>{
     assert.equal(o.upsert,false);assert.equal(o.ifNoneMatch,'*');assert.equal(o.bucket,'brufap-fiscal-artifacts');assert.equal(o.contentType,'application/octet-stream');
     assert.match(o.key,/^candidates\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);assert.equal(hash(o.bytes),o.key.split('/').at(-1).slice(0,-4));
     if(f.files.has(o.key))return{status:409};calls.put++;f.files.set(o.key,Buffer.from(o.bytes));
     await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',[o.bucket,o.key,JSON.stringify({size:o.bytes.length,mimetype:o.contentType})]);return{status:201};
    },
   },
   withAuthorizedSigner:async(grant,callback)=>{
    assert.equal(grant.actor,f.users.fiscal);assert.equal(grant.credential_metadata.fingerprint_sha256,fingerprint);calls.sign++;
    const signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:new Date()});try{return await callback(signer);}finally{disposeSigner(signer);}
   },
   validateXsd:async(bytes,opts)=>{calls.schema++;const report=await validate(bytes,opts);assert.equal(report.ok,true,JSON.stringify(report));assert.equal(report.xsdValidated,true);return report;},
  });
  async function sign(options){
   const source=await f.stored(options),input={actor:f.users.fiscal,commandId:randomUUID(),unsignedJobId:source.result.job_id,unsignedHash:source.result.artifact.sha256,basisHash:source.result.basis_hash,expectedA1Version:2};
   const body={command_id:input.commandId,unsigned_job_id:input.unsignedJobId,unsigned_hash:input.unsignedHash,basis_hash:input.basisHash,expected_a1_version:2};
   const result=await runtime.run(input);assert.equal(result.status,'stored',JSON.stringify(result));
   const projected=publicResult(result,{action:'run',payload:body});assert.equal(signedOutcome(projected,body).status,'stored');
   const read=await f.callSql('erp_fiscal_signed_command',{p_user_id:input.actor,p_command_id:input.commandId});
   assert.equal(read.artifact.evidence.xsd.xml_hash,result.artifact.sha256);assert.equal(read.artifact.evidence.signature.xml_hash,result.artifact.sha256);
   const xml=f.files.get(`candidates/${result.candidate_id}/${result.artifact.sha256}.xml`).toString('utf8');
   const verified=verifyNfeXml({xml,expectedCertificate:credential.certificate,expectedHolderCnpj:HOLDER,expectedIssuerCnpj:HOLDER,now:new Date(),...(options.model==='65'?{nfceQrProfile:NFCE_SP_HOMOLOGATION_QR_V3}:{})});
   assert.equal(verified.signatureVerified,true);assert.equal(verified.sefazAuthorized,false);
   assert.equal(projected.can_emit,false);assert.equal(projected.can_transmit,false);assert.equal(projected.tax_rules_validated,false);assert.equal(projected.icp_brasil_chain_validated,false);
   assert.doesNotMatch(JSON.stringify(projected),/10\.1234567891|<NFe|credential_id|certificate_fingerprint|holder_cnpj|execution|lease/);
   return{source,input,result,read,xml};
  }
  const candidateCounts=()=>f.scalar("select jsonb_build_array((select count(*)from erp_fiscal_signed.candidate),(select count(*)from erp_fiscal_signed.attempt),(select count(*)from erp_fiscal_signed.artifact),(select count(*)from erp_fiscal_signed.command))value");
  const old=await sign({model:'55'}),oldCounts=await f.counts(),oldSignedCounts=await candidateCounts(),oldCalls={...calls};
  await applyPricePrecision(f);
  await t.test('pre-057 signed artifact, historical receipt and existing command survive migration byte-for-byte',async()=>{
   assert.deepEqual(await f.callSql('erp_fiscal_signed_command',{p_user_id:old.input.actor,p_command_id:old.input.commandId}),old.read);
   assert.equal(f.files.get(`candidates/${old.result.candidate_id}/${old.result.artifact.sha256}.xml`).toString('utf8'),old.xml);
   const replay=await runtime.run(old.input);assert.equal(replay.artifact.sha256,old.result.artifact.sha256);assert.deepEqual(await f.counts(),oldCounts);assert.deepEqual(await candidateCounts(),oldSignedCounts);assert.deepEqual(calls,oldCalls);
  });
  for(const model of ['55','65'])await t.test(`model ${model}: exact ten-place signed XML is locally XSD-valid`,async()=>{
   const run=await sign({model,count:2,quantity:'2.000000',unit_price:'10.1234567891',discount:'0.03',freight:'1.01',other:'0.02',installments:true});
   assert.match(run.xml,/<vUnCom>10\.1234567891<\/vUnCom>/);assert.match(run.xml,/<vUnTrib>10\.1234567891<\/vUnTrib>/);assert.match(run.xml,/<vNF>41\.50<\/vNF>/);
   assert.equal(run.read.artifact.evidence.qr.verified,model==='65');assert.equal(run.result.current.artifact_current,true);
   const before={...calls};await runtime.run(run.input);assert.deepEqual(calls,before);
   await f.updateCompletion(run.source.source,{additional_information:'ALTERACAO FICTICIA APOS ASSINATURA'});
   const oldAgain=await runtime.run(run.input);assert.equal(oldAgain.artifact.sha256,run.result.artifact.sha256);assert.equal(oldAgain.current.basis_changed,true);assert.equal(oldAgain.current.artifact_current,false);assert.deepEqual(calls,before);
  });
  for(const model of ['55','65'])for(const vector of [
   {quantity:'100000000.000000',unit_price:'0.0000000001',gross:'0.01'},
   {quantity:'0.000100',unit_price:'9999999999.9999999999',gross:'1000000.00'},
  ])await t.test(`model ${model}: schema accepts exact price boundary ${vector.unit_price}`,async()=>{
   const {gross,...values}=vector,run=await sign({model,...values});
   assert.ok(run.xml.includes(`<vUnCom>${vector.unit_price}</vUnCom>`));assert.ok(run.xml.includes(`<vNF>${gross}</vNF>`));
  });
  assert.deepEqual(calls,{schema:7,sign:7,put:7});assert.deepEqual(await candidateCounts(),[7,7,7,7]);const final=await f.counts();assert.equal(final.stock,0);assert.equal(final.finance,0);
 }finally{credential?.privateDer.fill(0);await f.close();}
});
