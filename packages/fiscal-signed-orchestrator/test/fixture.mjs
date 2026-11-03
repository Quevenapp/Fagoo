// All databases, Storage bytes and certificates are synthetic and local.
import assert from 'node:assert/strict';
import {randomUUID,X509Certificate} from 'node:crypto';
import {signedFixture,hash} from '../../../tools/migration/fixtures/signed-candidate.mjs';
import {credentials,HOLDER} from '../../fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner} from '../../fiscal-xml/src/index.mjs';
import {createSignedFiscalOrchestrator} from '../src/signed.mjs';
export {hash};
export async function fixture({model='55'}={}){
 const f=await signedFixture();let credential;
 try{
  credential=await credentials();const certificate=new X509Certificate(credential.certificateDer),fp=hash(credential.certificateDer);
  await f.configure({fingerprint_sha256:fp,presented_chain:[fp],not_before:certificate.validFromDate.toISOString(),not_after:certificate.validToDate.toISOString()});
  const source=await f.stored({model}),input={actor:f.users.fiscal,commandId:randomUUID(),unsignedJobId:source.result.job_id,unsignedHash:source.result.artifact.sha256,basisHash:source.result.basis_hash,expectedA1Version:2};
  const calls={rpc:[],read:[],put:[],custody:[],schema:[]},handles=[],buffers=[];
  const opts=o=>{assert.ok(o.signal instanceof AbortSignal);assert.equal(o.signal.aborted,false);assert.ok(o.deadline>Date.now());};
  const rpc=async(name,args,o)=>{opts(o);assert.match(name,/^erp_fiscal_signed_(command|begin|use|finish|fail|get|history)$/);calls.rpc.push({name,args:structuredClone(args)});return f.callSql(name,args);};
  const storage={
   read:async o=>{opts(o);assert.equal(o.bucket,'brufap-fiscal-artifacts');assert.match(o.key,/^(jobs|candidates)\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);calls.read.push(o.key);const bytes=f.files.get(o.key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):null;},
   putImmutable:async o=>{opts(o);assert.equal(o.bucket,'brufap-fiscal-artifacts');assert.match(o.key,/^candidates\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/);assert.equal(o.contentType,'application/octet-stream');assert.equal(o.upsert,false);assert.equal(o.ifNoneMatch,'*');assert.equal(hash(o.bytes),o.key.split('/').at(-1).slice(0,-4));calls.put.push(o.key);buffers.push(o.bytes);if(f.files.has(o.key))return{status:409};f.files.set(o.key,Buffer.from(o.bytes));await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',o.key,JSON.stringify({size:o.bytes.length,mimetype:'application/octet-stream'})]);return{status:201};}
  };
  const signer=()=>{const value=createSigner({...credential,expectedHolderCnpj:HOLDER,purpose:'offline-homologation',now:new Date()});handles.push(value);return value;};
  const withAuthorizedSigner=async(grant,callback,o)=>{opts(o);assert.ok(Object.isFrozen(grant)&&Object.isFrozen(grant.credential_context));assert.equal(grant.actor,input.actor);assert.equal(grant.command_id,input.commandId);assert.equal(grant.credential_metadata.fingerprint_sha256,fp);calls.custody.push(grant);const handle=signer();try{return await callback(handle);}finally{disposeSigner(handle);}};
  const schemaReport=(bytes,o)=>({ok:true,xmlDigest:hash(bytes),model:o.expectedModel,environment:'2',sizeBytes:bytes.length,schemaProfile:'pl010f-v1.04',validatorVersion:'fiscal-schema-runner-v1',validatorHash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6',schemaManifestHash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',xsdValidated:true,canEmit:false,signatureVerified:false,taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,sefazAuthorized:false,canTransmit:false});
  // A report stub only: real XSD interoperability is tested separately by test_signed_candidates_interop.mjs.
  const validateXsd=async(bytes,o)=>{opts(o);assert.equal(o.expectedHash,hash(bytes));assert.equal(o.expectedModel,model);calls.schema.push({hash:hash(bytes),size:bytes.length});buffers.push(bytes);return schemaReport(bytes,o);};
  const ports={rpc,storage,withAuthorizedSigner,validateXsd};const orchestrator=(patch={})=>createSignedFiscalOrchestrator({...ports,...patch,storage:patch.storage??storage});
  const signedCommand=()=>f.callSql('erp_fiscal_signed_command',{p_user_id:input.actor,p_command_id:input.commandId});
  return{...f,source,input,calls,ports,signer,handles,buffers,schemaReport,orchestrator,signedCommand,close:async()=>{handles.forEach(disposeSigner);credential.privateDer.fill(0);await f.close();}};
 }catch(error){credential?.privateDer.fill(0);await f.close();throw error;}
}
