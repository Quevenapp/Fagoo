// Isolated SQL, generated certificate and in-memory HTTP/Storage drivers; no sockets or real data.
import assert from 'node:assert/strict';
import {randomUUID,X509Certificate} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {authorizationFixture} from '../../../tools/migration/fixtures/authorization-ledger.mjs';
import {credentials,HOLDER} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner,createSignedHomologationCandidate} from '../../fiscal-xml/src/index.mjs';
import {createAuthorizationService} from '../src/service.mjs';
import {createAuthorizationRpc} from '../src/rpc.mjs';
import {createAuthorizationStorage} from '../src/storage.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {hash,fiscalResponse} from './service-fixtures.mjs';
export {hash};
export async function serviceFixture({credential:providedCredential,configureCredential,sourceOptions}={}){
 const f=await authorizationFixture();let signer,credential;try{
  credential=providedCredential?{...providedCredential,privateDer:Buffer.from(providedCredential.privateDer)}:await credentials();const cert=new X509Certificate(credential.certificateDer),fp=hash(credential.certificateDer);
  if(configureCredential)await configureCredential(f,credential);else await f.configure({fingerprint_sha256:fp,presented_chain:[fp],not_before:cert.validFromDate.toISOString(),not_after:cert.validToDate.toISOString()});
  signer=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:new Date()});
  const calls={rpc:[],read:[],put:[],custody:[],transport:[],validate:[]},buffers=[];
  const source=async(model='55',count=1)=>{
   const unsigned=await f.stored({...sourceOptions,model,count}),begin=await f.callSql('erp_fiscal_signed_begin',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_unsigned_job_id:unsigned.result.job_id,p_unsigned_hash:unsigned.result.artifact.sha256,p_basis_hash:unsigned.result.basis_hash,p_expected_a1_version:2});
   await f.callSql('erp_fiscal_signed_use',{p_user_id:f.users.fiscal,p_candidate_id:begin.receipt.candidate_id,p_lease_id:begin.execution.lease_id});
   const xml=f.files.get(`jobs/${unsigned.result.job_id}/${unsigned.result.artifact.sha256}.xml`).toString();
   const signed=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:HOLDER,expectedModel:model,expectedUnsignedHash:hash(xml),expectedCertificateFingerprint:fp,now:new Date()});
   const bytes=Buffer.from(signed.signedXml),key=`candidates/${begin.receipt.candidate_id}/${signed.xmlDigest}.xml`;
   await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);f.files.set(key,bytes);
   const evidence=f.proof({value:begin},signed.xmlDigest);evidence.signature.signed_content_hash=signed.signedContentDigest;evidence.signature.reference_digest=signed.referenceDigest;
   const stored=await f.callSql('erp_fiscal_signed_finish',{p_user_id:f.users.fiscal,p_candidate_id:begin.receipt.candidate_id,p_lease_id:begin.execution.lease_id,p_signed_hash:signed.xmlDigest,p_size_bytes:bytes.length,p_evidence:evidence});
   return{stored,input:{actor:f.users.fiscal,commandId:randomUUID(),candidateId:stored.receipt.candidate_id,signedHash:signed.xmlDigest,expectedIdentityVersion:1,expectedA1Version:2,expectedPolicyVersion:2,confirmed:true}};
  };
  const response=(request,options={})=>Buffer.from(fiscalResponse(request,options).toString().replaceAll('2026-10-16T09:01:00-03:00',new Date(Date.now()-10800000+1000).toISOString().slice(0,19)+'-03:00'));
  const rpc=createAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-a-secret',fetchImpl:async(url,o)=>{
   const name=url.split('/').at(-1),args=JSON.parse(Buffer.from(o.body).toString());calls.rpc.push({name,args});assert.equal(o.redirect,'manual');
   try{return Response.json(await f.callSql(name,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE_DATABASE_SENTINEL'},{status:400});}
  }});
  const storage=createAuthorizationStorage({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-a-secret',fetchImpl:async(url,o)=>{
   assert.equal(o.redirect,'manual');const key=url.split('brufap-fiscal-artifacts/')[1];assert.ok(key);
   if(o.method==='GET'){calls.read.push(key);const b=f.files.get(key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}}):Response.json({code:'NoSuchKey'},{status:404});}
   assert.equal(o.method,'POST');assert.equal(o.headers['x-upsert'],'false');assert.equal(o.headers['If-None-Match'],'*');calls.put.push(key);buffers.push(o.body);if(f.files.has(key))return Response.json({code:'ResourceAlreadyExists'},{status:409});const b=Buffer.from(o.body);f.files.set(key,b);await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:b.length,mimetype:'application/octet-stream'})]);return Response.json({}, {status:201});
  }});
  const validateReal=createAuthorizationValidator({pythonPath:process.env.BRUFAP_TEST_PYTHON??'/Users/bruno/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
  const validate=async(v,o)=>{calls.validate.push(v.kind);return validateReal(v,o);};
  const binding={origin:'synthetic',profile:'synthetic-authorization-binding',ruleProfile:'synthetic-rules-only',encode:(_c,bytes)=>Buffer.concat([Buffer.from('SYNTHETIC-WIRE\n'),bytes]),extract:(_c,bytes)=>Buffer.from(bytes)};
  const custody=async(v,action,o)=>{calls.custody.push(v);assert.ok(o.signal instanceof AbortSignal);await action(Object.freeze({synthetic:true}));};
  const transport=async(v,bytes,_session,o)=>{assert.equal(o.signal.aborted,false);calls.transport.push({grant:v.grant,bytes:Buffer.from(bytes)});const command=await f.callSql('erp_fiscal_authorization_command',{p_user_id:v.grant.actor,p_command_id:v.grant.command_id});assert.equal(command.current.grant_consumed,true);return new Response(response(v.request),{headers:{'content-type':'application/octet-stream'}});};
  const ports={mode:'synthetic',enabled:true,rpc,storage,validate,binding,withPreparedSession:custody,transport};
  const age=async commandId=>{
   // Test-only clock travel: shift the entire attempt interval and its immutable receipt,
   // retaining created <= used < expires instead of fabricating an impossible lease.
   await f.db.exec('alter table erp_fiscal_authorization.attempt disable trigger guard_attempt;alter table erp_fiscal_authorization.command disable trigger immutable;');
   try{await f.db.query("update erp_fiscal_authorization.attempt set created_at=created_at-interval'120seconds',used_at=used_at-interval'120seconds',expires_at=expires_at-interval'120seconds',finished_at=finished_at-interval'120seconds'where command_id=$1",[commandId]);
    await f.db.query("update erp_fiscal_authorization.command set created_at=created_at-interval'120seconds',receipt=jsonb_set(receipt,'{created_at}',to_jsonb((receipt->>'created_at')::timestamptz-interval'120seconds'))where id=$1",[commandId]);
   }finally{await f.db.exec('alter table erp_fiscal_authorization.attempt enable trigger guard_attempt;alter table erp_fiscal_authorization.command enable trigger immutable;');}
  };
  return{...f,source,response,calls,buffers,ports,age,service:(patch={})=>createAuthorizationService({...ports,...patch}),close:async()=>{disposeSigner(signer);credential.privateDer.fill(0);await f.close();}};
 }catch(e){if(signer)disposeSigner(signer);credential?.privateDer.fill(0);await f.close();throw e;}
}
