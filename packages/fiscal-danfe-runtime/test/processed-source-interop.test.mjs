// Real local SQL069/079 + HTTP RPC adapters + synthetic signed XML and Python XSD.
// Fixture setup alone writes; the consumer has only command RPCs and Storage GET.
// No sockets, external network, real certificate, custody or transmission.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {revalidationFixture,hash} from '../../fiscal-authorization/test/stored-response-revalidation-fixture.mjs';
import {prepareAuthorization,parseAuthorizationResponse,composeProcessedNfe} from '../../fiscal-authorization/src/index.mjs';
import {pinnedCandidateCertificate} from '../../fiscal-authorization/src/pinned-certificate.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,reviewedAuthorizationBinding} from '../../fiscal-authorization/src/authorization-soap-binding.mjs';
import {createStoredResponseReader} from '../../fiscal-authorization/src/stored-response-reader.mjs';
import {createAuthorizationRevalidationRpc} from '../../fiscal-authorization/src/revalidation-rpc.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {createProcessedSource,processedSource,disposeProcessedSource,reauthorizeProcessedSource} from '../src/processed-source.mjs';
import {createProcessedRuntimeHandler} from '../src/processed-handler.mjs';
import {signRuntimeRequest,digest} from '../src/processed-auth.mjs';
import {publicProcessedResult,decodeProcessedXml,FLAGS} from '../src/processed-dto.mjs';
import {renderProcessedHtml} from '../../fiscal-danfe/src/processed-render.mjs';

let f,rpc;const cases=[];
const SECRET=new Uint8Array(32).fill(31),keyId='processed-interop',audience='synthetic-danfe';
const commandArgs=id=>({p_user_id:f.users.fiscal,p_command_id:id});
const clone=structuredClone;
async function store(key,bytes){
 f.files.set(key,Buffer.from(bytes));
 await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);
}
async function authorized(model){
 const c=await f.candidate(model),proof=await f.review(c);
 const version=Number((await f.db.query('select max(version)v from erp_fiscal_authorization.policy where model=$1',[model])).rows[0].v);
 const b=await f.begin(c,version),ctx=b.value.recovery,at=new Date(b.value.receipt.created_at);
 const signed=f.files.get(`candidates/${ctx.candidate_id}/${ctx.signed_hash}.xml`);
 const cert=pinnedCandidateCertificate({signedBytes:signed,signedHash:ctx.signed_hash,signedSize:ctx.signed_size,certificateFingerprint:ctx.certificate_fingerprint,model,now:at});
 const request=prepareAuthorization({signedBytes:signed,expectedSignedHash:ctx.signed_hash,expectedModel:model,expectedIssuerCnpj:ctx.issuer_cnpj,expectedHolderCnpj:ctx.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:ctx.certificate_fingerprint,now:at,batchId:ctx.batch_id});
 const wire=Buffer.from(encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request}))),requestHash=hash(wire);
 const path=type=>`authorization/${ctx.attempt_id}/${type}/${requestHash}.${type==='observations'?'json':'xml'}`;
 await store(path('requests'),wire);
 const prep={...f.ids(b),p_request_hash:requestHash,p_request_size:wire.length,p_evidence:{...f.preparation(b,requestHash),payload_hash:request.requestHash},p_rule_review:proof};
 await f.wire('prepare',prep);await f.use(b,proof);
 const payload=f.response(request,{status:model==='65'?'150':'100'}),parsed=parseAuthorizationResponse({request,responseBytes:payload}),processed=composeProcessedNfe({request,response:parsed}),processedBytes=Buffer.from(processed.processedXml);
 for(const [kind,xmlBytes]of [['response',payload],['processed',processedBytes]]){
  const valid=await f.ports.validate({request,xmlBytes,kind},f.opts());assert.equal(valid.ok,true);assert.equal(valid.xsdValidated,true);assert.equal(valid.referenceDigestMatched,true);
 }
 const response=Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${reviewedAuthorizationBinding(model).serviceNamespace}">${payload}</nfeResultMsg></Body></Envelope>`);
 const meta=Buffer.from(JSON.stringify({profile:'authorization-reviewed-journal-v1',origin:'operational',attempt_id:ctx.attempt_id,command_id:ctx.command_id,candidate_id:ctx.candidate_id,batch_id:ctx.batch_id,signed_hash:ctx.signed_hash,request_hash:requestHash,response_hash:hash(response),response_size:response.length,http_status:200,received_at:new Date().toISOString(),tls_peer_verified:true,tls_origin_verified:true,tls_protocol:'TLSv1.2',server_trust_profile:SP_AUTHORIZATION_SERVER_TRUST,server_trust_anchor_sha256:SP_AUTHORIZATION_ROOT_HASH,subset_review_hash:proof.review_hash}));
 const processedKey=`authorization/${ctx.attempt_id}/processed/${processed.processedHash}.xml`;
 await store(path('responses'),response);await store(path('observations'),meta);await store(processedKey,processedBytes);
 const evidence=f.responseEvidence(b,requestHash,hash(response),{payload_hash:hash(payload),protocol_cstat:parsed.protocol.cStat,protocol_number:parsed.protocol.number,received_at:new Date(parsed.protocol.receivedAt).toISOString(),tls_origin_verified:true,transport_hash:hash(meta),transport_size:meta.length});
 await f.wire('finish',{...f.ids(b),p_response_hash:hash(response),p_response_size:response.length,p_processed_hash:processed.processedHash,p_processed_size:processed.sizeBytes,p_evidence:evidence,p_observation_hash:hash(meta),p_observation_size:meta.length});
 return{model,kind:'authorization',commandId:ctx.command_id,originalCommandId:ctx.command_id,c,processedKey,processedBytes,signed:Buffer.from(signed)};
}
async function revalidated(model){
 const x=await f.startReal(model),read=createStoredResponseReader({readCommand:({actor,authorizationCommandId})=>f.wire('command',{p_user_id:actor,p_command_id:authorizationCommandId}),readObject:f.ports.storage.read,validate:f.ports.validate});
 const v=await read({actor:f.users.fiscal,authorizationCommandId:x.input.authorization_command_id},f.opts());
 try{
  const p=v.validation,processedKey=`revalidations/${x.input.expected_attempt_id}/${p.parser_manifest_hash}/processed/${p.processed_hash}.xml`;
  await store(processedKey,v.processedBytes);
  const result=await rpc('finish',{p_user_id:f.users.fiscal,p_command_id:x.input.command_id,p_authorization_command_id:x.input.authorization_command_id,p_expected_attempt_id:x.input.expected_attempt_id,p_expected_source_hash:x.input.expected_source_hash,p_parser_profile:p.parser_profile,p_parser_manifest_hash:p.parser_manifest_hash,p_evidence:p.evidence,p_processed_hash:p.processed_hash,p_processed_size:p.processed_size,p_confirmed:true},f.opts());
  assert.equal(result.receipt.state,'authorized_homologation');
  const ctx=x.b.value.recovery;
  return{model,kind:'revalidation',commandId:x.input.command_id,originalCommandId:ctx.command_id,c:x.c,processedKey,processedBytes:Buffer.from(v.processedBytes),signed:Buffer.from(f.files.get(`candidates/${ctx.candidate_id}/${ctx.signed_hash}.xml`))};
 }finally{v.processedBytes?.fill(0);}
}
test.before(async()=>{
 f=await revalidationFixture();
 rpc=createAuthorizationRevalidationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-secret',fetchImpl:async(url,o)=>{
  assert.equal(o.method,'POST');assert.equal(o.redirect,'manual');const name=url.split('/').at(-1);
  try{return Response.json(await f.callSql(name,JSON.parse(o.body)));}catch(e){return Response.json({code:e.code,message:'PRIVATE_DATABASE_SENTINEL'},{status:400});}
 }});
 for(const model of ['55','65'])cases.push(await authorized(model),await revalidated(model));
});
test.after(async()=>{for(const x of cases){x.processedBytes.fill(0);x.signed.fill(0);}await f?.close();});
function reader(patch={}){
 const calls={rpc:[],read:[]};
 const readCommand=async(kind,action,args,opts)=>{
  assert.equal(action,'command');calls.rpc.push({kind,args:clone(args)});
  if(patch.beforeCommand)await patch.beforeCommand(calls.rpc.length,kind,args);
  return kind==='authorization'?f.wire('command',args):rpc('command',args,opts);
 };
 const read=createProcessedSource({authorizationRpc:(...a)=>readCommand('authorization',...a),revalidationRpc:(...a)=>readCommand('revalidation',...a),storage:{read:async input=>{
  assert.equal(input.bucket,'brufap-fiscal-artifacts');calls.read.push(input.key);
  const bytes=f.files.get(input.key);return bytes?new Response(Buffer.from(bytes),{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}}):null;
 }}});
 return{read,calls};
}
const input=x=>({actor:f.users.fiscal,sourceKind:x.kind,commandId:x.commandId});
async function allData(){
 const rows=(await f.db.query("select n.nspname schema,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and(n.nspname like'erp_%'or n.nspname in('storage','auth'))order by 1,2")).rows,out={};
 for(const r of rows)out[`${r.schema}.${r.name}`]=(await f.db.query(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)v from "${r.schema}"."${r.name}" t`)).rows[0].v;
 return out;
}
test('SQL069/079 → HTTP command adapters → source → exact XML/printed protocol, all55/65',async()=>{
 const before=await allData(),files=[...f.files].map(([k,b])=>[k,hash(b)]),baseline={custody:f.calls.custody.length,transport:f.calls.transport.length,put:f.calls.put.length,validate:f.calls.validate.length};
 for(const x of cases){
  const p=reader(),h=await p.read(input(x),f.opts());
  try{
   const v=processedSource(h);assert.deepEqual(Buffer.from(v.signedBytes),x.signed);assert.deepEqual(Buffer.from(v.processedBytes),x.processedBytes);
   assert.equal(v.metadata.model,x.model);assert.equal(v.metadata.authorization_command_id,x.originalCommandId);assert.equal(v.metadata.source_command_id,x.commandId);
   assert.equal(p.calls.read.length,5);assert.equal(p.calls.rpc.length,2);assert.ok(p.calls.rpc.every(r=>r.kind===x.kind&&r.args.p_user_id===f.users.fiscal));
   const html=renderProcessedHtml(h);assert.match(html.html,/HOMOLOGAÇÃO - SEM VALOR FISCAL/);assert.ok(html.html.includes(v.metadata.protocol.number));assert.doesNotMatch(html.html,/NÃO AUTORIZADA/);
   const binding={sourceKind:x.kind,commandId:x.commandId,action:'print'},output={...FLAGS,action:'print',source:v.metadata,html:html.html,html_sha256:html.sha256,html_size_bytes:Buffer.byteLength(html.html),profile:html.profile,page_count:html.page_count};
   assert.equal((await publicProcessedResult(output,binding)).source.processed_hash,hash(x.processedBytes));
   await assert.rejects(publicProcessedResult({...output,html_size_bytes:output.html_size_bytes+1},binding),{code:'DANFE_RESPONSE_INVALID'});
   await reauthorizeProcessedSource(h,f.opts());assert.equal(p.calls.rpc.length,3);v.signedBytes.fill(0);v.processedBytes.fill(0);
  }finally{disposeProcessedSource(h);}
 }
 assert.deepEqual(await allData(),before);assert.deepEqual([...f.files].map(([k,b])=>[k,hash(b)]),files);
 assert.deepEqual({custody:f.calls.custody.length,transport:f.calls.transport.length,put:f.calls.put.length,validate:f.calls.validate.length},baseline);
});
test('another admin cannot read the original actor command; revoked original role blocks before Storage',async()=>{
 for(const x of cases){const p=reader();await assert.rejects(p.read({...input(x),actor:f.users.admin}),{code:'DANFE_FORBIDDEN'});assert.equal(p.calls.read.length,0);}
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);
 try{for(const x of cases){const p=reader();await assert.rejects(p.read(input(x)),{code:'DANFE_FORBIDDEN'});assert.equal(p.calls.read.length,0);}}
 finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
});
test('real SQL revocation on second ACL or final HTTP ACL returns no artifact',async()=>{
 for(const kind of ['authorization','revalidation'])for(const at of [2,3]){
  const x=cases.find(x=>x.kind===kind),p=reader({beforeCommand:async n=>{if(n===at)await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);}});
  const handler=createProcessedRuntimeHandler({readSource:p.read,render:renderProcessedHtml,transportSecret:SECRET,transportKeyId:keyId,audience});
  try{
   const path=`/internal/v1/fiscal-danfe/${kind==='authorization'?'authorizations':'revalidations'}/${x.commandId}/${at===3?'print':'xml'}`;
   const header=await signRuntimeRequest({secretBytes:SECRET,keyId,audience,actor:f.users.fiscal,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array()),now:Date.now()});
   const response=await handler(new Request('http://runtime.internal'+path,{headers:{authorization:header}}));
   assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'DANFE_FORBIDDEN',recovery_required:false});assert.equal(p.calls.rpc.length,at);assert.equal(p.calls.read.length,5);
  }finally{handler.dispose();await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
 }
});
test('both source kinds bind current issuer before Storage, while identity version alone is not an access grant',async()=>{
 await f.db.exec('begin');
 try{
  await f.db.exec("update erp_company.identity set data=jsonb_set(data,'{cnpj}','\"11444777000161\"'::jsonb),version=version+1");
  for(const x of cases){const p=reader();await assert.rejects(p.read(input(x)));assert.equal(p.calls.read.length,0);}
 }finally{await f.db.exec('rollback');}
});
test('SQL receipt cannot conceal changed processed bytes or a missing original SOAP object',async()=>{
 for(const x of cases){
  for(const key of [x.processedKey,(await f.wire('command',commandArgs(x.originalCommandId))).recovery].map(v=>typeof v==='string'?v:`authorization/${v.attempt_id}/responses/${v.request_hash}.xml`)){
   const saved=f.files.get(key);f.files.set(key,Buffer.from('PRIVATE_CORRUPTION'));
   try{await assert.rejects(reader().read(input(x)),{code:'DANFE_STORAGE_INVALID'});}finally{f.files.set(key,saved);}
  }
 }
});
test('historical readers survive new reviews/profile/policy and disabled current A1; XML DTO stays exact',async()=>{
 for(const x of cases)await f.review(x.c,{p_command_id:randomUUID(),p_expected_review_version:1});
 await f.disable();
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160072_fiscal_reviewed_preflight.sql',import.meta.url),'utf8'));
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160077_fiscal_gtin_rule_profile_v2.sql',import.meta.url),'utf8'));
 const before=await allData();
 for(const x of cases){
  const p=reader(),handler=createProcessedRuntimeHandler({readSource:p.read,render:renderProcessedHtml,transportSecret:SECRET,transportKeyId:keyId,audience});
  try{
   const path=`/internal/v1/fiscal-danfe/${x.kind==='authorization'?'authorizations':'revalidations'}/${x.commandId}/xml`,header=await signRuntimeRequest({secretBytes:SECRET,keyId,audience,actor:f.users.fiscal,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array()),now:Date.now()});
   const response=await handler(new Request('http://runtime.internal'+path,{headers:{authorization:header}}));assert.equal(response.status,200);
   const value=await publicProcessedResult(await response.json(),{sourceKind:x.kind,commandId:x.commandId,action:'xml'}),decoded=decodeProcessedXml(value.xml_base64);
   assert.deepEqual(Buffer.from(decoded),x.processedBytes);decoded.fill(0);assert.equal(value.tax_rules_validated,false);assert.equal(value.can_transmit,false);assert.equal(p.calls.rpc.length,3);
  }finally{handler.dispose();}
 }
 assert.deepEqual(await allData(),before);
});
