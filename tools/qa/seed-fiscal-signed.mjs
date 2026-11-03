/** DEV/PGlite only. Ephemeral synthetic certificate; XSD is an explicitly simulated report, never real validation. */
import {PGlite} from '@electric-sql/pglite';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {credentials,HOLDER} from '../../packages/fiscal-xml/test/fixtures.mjs';
import {createSigner,disposeSigner} from '../../packages/fiscal-xml/src/index.mjs';
import {createUnsignedXmlOrchestrator} from '../../packages/fiscal-unsigned-orchestrator/src/unsigned.mjs';
import {SCHEMA_RUNNER_PROFILE} from '../../packages/fiscal-schema-runner/src/index.mjs';
import {createSignedRuntimeHandler} from '../../packages/fiscal-signed-runtime/src/handler.mjs';
import {createSignedGateway} from '../../packages/fiscal-signed-runtime/src/gateway.mjs';
import {createRuntimeHandler} from '../../packages/fiscal-runtime/src/handler.mjs';
import {createGateway} from '../../workers/fiscal-gateway/src/index.mjs';
import {createQaDatabaseQueue} from './serial-database.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const bucket='brufap-fiscal-artifacts',objectPath=key=>`/storage/v1/object/authenticated/${bucket}/${key}`;
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const unavailable=recovery=>Response.json({error:'SIGNED_UPSTREAM_UNAVAILABLE',recovery_required:recovery},{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function seedFiscalSigned({db,uid,objects,drafts,databaseOperation=createQaDatabaseQueue()}){
 need(db instanceof PGlite&&safeId(uid)&&objects instanceof Map,'QA_SIGNED_MEMORY_DATABASE_REQUIRED');
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;let transaction=false;
 const call=(name,args)=>databaseOperation(async()=>{
  need(/^erp_[a-z0-9_]+$/.test(name)&&Object.keys(args).every(k=>/^p_[a-z0-9_]+$/.test(k)),'QA_SIGNED_RPC_INVALID');
  const pairs=Object.entries(args);await db.exec('set role service_role');if(transaction)await db.exec('savepoint qa_signed_rpc');
  try{const value=await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')})value`,pairs.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));if(transaction)await db.exec('release savepoint qa_signed_rpc');return value;}
  catch(error){if(transaction){await db.exec('rollback to savepoint qa_signed_rpc');await db.exec('release savepoint qa_signed_rpc');}throw error;}
  finally{await db.exec('reset role');}
 });
 const identity=(await call('erp_company_get',{p_user_id:uid,p_section:'identity'})).record;
 need(identity&&['11222333000181',HOLDER].includes(identity.data.cnpj),'QA_SIGNED_SYNTHETIC_COMPANY_REQUIRED');
 need((await call('erp_a1_metadata',{p_user_id:uid})).current.version===0,'QA_SIGNED_ALREADY_SEEDED');
 if(drafts===undefined)drafts=(await db.query("select f.id from erp_fiscal_drafts.draft f join erp_documents.document d on d.id=f.source_document_id where d.body->>'notes'='QA048 · SOMENTE TESTE LOCAL' order by f.model")).rows.map(r=>r.id);
 need(Array.isArray(drafts)&&drafts.length===2&&drafts.every(safeId)&&new Set(drafts).size===2,'QA_SIGNED_TWO_DRAFTS_REQUIRED');
 const effects=()=>scalar('select jsonb_build_array((select count(*)from erp_finance.title),(select count(*)from erp_stock.movement),(select count(*)from erp_fiscal_signed.candidate))value');
 const before=await effects(),credential=await credentials({cnpj:identity.data.cnpj,notBefore:new Date(Date.now()-86400000).toISOString(),notAfter:new Date(Date.now()+86400000*30).toISOString()});
 const certificate=new X509Certificate(credential.certificateDer),fingerprint=hash(credential.certificateDer),createdKeys=[],handles=new Set(),metrics={signatures:0,schema_reports:0,storage_writes:0};
 let disposed=false;
 const check=options=>need(!disposed&&options?.signal instanceof AbortSignal&&!options.signal.aborted&&Number.isFinite(options.deadline)&&options.deadline>Date.now(),'QA_SIGNED_STOPPED');
 const ports={rpc:async(name,args,options)=>{check(options);need(/^erp_fiscal_(?:unsigned|signed)_[a-z_]+$/.test(name),'QA_SIGNED_RPC_INVALID');return call(name,args);},storage:{
  async read(options){check(options);need(options.bucket===bucket&&/^(jobs|candidates)\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/.test(options.key),'QA_SIGNED_OBJECT_INVALID');const object=objects.get(objectPath(options.key));return object?new Response(Buffer.from(object.bytes),{headers:{'Content-Type':object.mime,'Content-Length':String(object.bytes.length)}}):null;},
  async putImmutable(options){check(options);need(options.bucket===bucket&&/^(jobs|candidates)\/[a-f0-9-]{36}\/[a-f0-9]{64}\.xml$/.test(options.key)&&options.contentType==='application/octet-stream'&&options.upsert===false&&options.ifNoneMatch==='*'&&options.bytes instanceof Uint8Array&&options.bytes.length<=512000&&hash(options.bytes)===options.key.split('/').at(-1).slice(0,-4),'QA_SIGNED_OBJECT_INVALID');
   return databaseOperation(async()=>{check(options);const path=objectPath(options.key);if(objects.has(path))return{status:409};const bytes=Buffer.from(options.bytes);await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)',[bucket,options.key,JSON.stringify({size:bytes.length,mimetype:options.contentType})]);objects.set(path,{bytes,mime:options.contentType});createdKeys.push(path);metrics.storage_writes++;return{status:201};});
  }
 }};
 try{
  await db.exec('begin');transaction=true;
  const command=randomUUID(),reserve=await call('erp_a1_reserve',{p_user_id:uid,p_command_id:command,p_request_hash:hash(command),p_action:'configure',p_expected_version:0,p_expected_identity_version:identity.version,p_reason:'QA050: seleção fictícia em memória; nenhum PFX real ou senha'});
  const metadata={profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:fingerprint,holder_cnpj:identity.data.cnpj,
   not_before:certificate.validFromDate.toISOString(),not_after:certificate.validToDate.toISOString(),rsa_bits:2048,presented_chain:[fingerprint],validated_at:new Date().toISOString(),
   key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false};
  await db.query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json'])on conflict(id)do nothing");
  // Marker metadata satisfies the in-memory SQL contract only. It is NOT an encrypted envelope and is never passed to a vault loader.
  const marker=Buffer.from('SYNTHETIC QA050: NO PFX OR ENVELOPE; SIGNER IS AN EPHEMERAL TEST FIXTURE'),objectHash=hash(marker),objectSize=marker.length;
  await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3::jsonb)',['brufap-a1-vault',`credentials/${reserve.credential_id}/${objectHash}.json`,JSON.stringify({size:marker.length,mimetype:'application/json'})]);marker.fill(0);
  const configured=await call('erp_a1_finalize',{p_user_id:uid,p_command_id:command,p_lease_id:reserve.lease_id,p_metadata:metadata,p_object_hash:objectHash,p_size_bytes:objectSize,p_key_id:'qa_synthetic_only'});
  const unsigned=createUnsignedXmlOrchestrator(ports),fixtures=[];
  for(const [index,id]of drafts.entries()){
   const basis=await call('erp_fiscal_unsigned_basis',{p_user_id:uid,p_draft_id:id,p_completion_version:1}),draft=basis.inputs.draft.record;
   need(draft.status==='draft'&&['55','65'].includes(draft.model),'QA_SIGNED_DRAFT_INVALID');
   await unsigned.preview({actor:uid,draftId:id,completionVersion:1});
   const series=await call('erp_fiscal_numbering_configure',{p_user_id:uid,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:identity.version,p_model:draft.model,p_environment:'2',p_series:String(880+index),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'QA050: série e número fictícios somente na memória local'});
   const reservation=await call('erp_fiscal_numbering_reserve',{p_user_id:uid,p_command_id:randomUUID(),p_series_id:series.current_series.id,p_expected_series_version:series.current_series.version,p_expected_identity_version:identity.version,p_draft_id:id,p_expected_draft_version:draft.version,p_snapshot_hash:draft.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});
   const stored=await unsigned.run({actor:uid,commandId:randomUUID(),reservationId:reservation.receipt.id,draftId:id,completionVersion:1,completionHash:basis.proofs.completion_hash,basisHash:basis.basis_hash});
   need(stored.status==='stored'&&stored.current.artifact_current===true,'QA_SIGNED_UNSIGNED_NOT_STORED');
   fixtures.push({model:draft.model,draft_id:id,source_document_id:draft.source_document_id,reservation_id:reservation.receipt.id,job_id:stored.job_id,unsigned_hash:stored.artifact.sha256,basis_hash:stored.basis_hash,a1_version:configured.current.version});
  }
  need(new Set(fixtures.map(v=>v.model)).size===2&&JSON.stringify(before)===JSON.stringify(await effects()),'QA_SIGNED_BOOTSTRAP_EFFECTS');
  await db.exec('commit');transaction=false;
  ports.withAuthorizedSigner=async(grant,callback,options)=>{
   check(options);need(grant.credential_context.credential_id===reserve.credential_id&&grant.credential_metadata.fingerprint_sha256===fingerprint&&grant.credential_object.hash===objectHash&&grant.identity.cnpj===identity.data.cnpj,'QA_SIGNED_CREDENTIAL_BINDING_INVALID');
   const signer=createSigner({...credential,expectedHolderCnpj:identity.data.cnpj,purpose:'offline-homologation',now:new Date()});handles.add(signer);metrics.signatures++;
   try{return callback(signer);}finally{disposeSigner(signer);handles.delete(signer);}
  };
  // Honest fixture boundary: this report exercises UI/persistence only. It does not run Python or assert a real XSD check.
  ports.validateXsd=async(bytes,options)=>{
   check(options);need(options.expectedHash===hash(bytes)&&['55','65'].includes(options.expectedModel),'QA_SIGNED_SCHEMA_INPUT_INVALID');metrics.schema_reports++;
   return{ok:true,xmlDigest:hash(bytes),model:options.expectedModel,environment:'2',sizeBytes:bytes.length,schemaProfile:SCHEMA_RUNNER_PROFILE.schemaProfile,validatorVersion:SCHEMA_RUNNER_PROFILE.version,validatorHash:SCHEMA_RUNNER_PROFILE.validatorHash,schemaManifestHash:SCHEMA_RUNNER_PROFILE.manifestHash,xsdValidated:true,canEmit:false,signatureVerified:false,taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,sefazAuthorized:false,canTransmit:false};
  };
  return{fixtures,metrics,ports,callSql:call,xsd_mode:'simulated_report_not_validation',dispose(){if(disposed)return;disposed=true;for(const signer of handles)disposeSigner(signer);handles.clear();credential.privateDer.fill(0);for(const path of createdKeys){objects.get(path)?.bytes.fill(0);objects.delete(path);}}};
 }catch(error){if(transaction)await db.exec('rollback');credential.privateDer.fill(0);for(const path of createdKeys){objects.get(path)?.bytes.fill(0);objects.delete(path);}throw error;}
}

/** Memory-only gateway composition; authenticated metadata is real SQL, PFX configuration is unavailable. */
export function createFiscalSignedQaGateway({seed,fetchImpl,env,retry=false,detailDelayMs=0}){
 need(seed?.xsd_mode==='simulated_report_not_validation'&&typeof fetchImpl==='function'&&typeof retry==='boolean'&&Number.isInteger(detailDelayMs)&&detailDelayMs>=0&&detailDelayMs<=5000,'QA_SIGNED_GATEWAY_INVALID');
 const secret=Buffer.from(env.A1_TRANSPORT_SECRET,'base64'),signed=createSignedRuntimeHandler({...seed.ports,transportSecret:secret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-signed`});
 const a1=createRuntimeHandler({repository:{rpc:(name,args)=>seed.callSql(`erp_a1_${name}`,args)},loader:{load(){throw Error('QA_PFX_LOADING_DISABLED');}},transportSecret:secret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:env.A1_AUDIENCE,fingerprintSecret:Buffer.alloc(32,43),keyring:new Map([['qa_synthetic_only',Buffer.alloc(32,44)]]),currentKeyId:'qa_synthetic_only'});
 const signedGateway=createSignedGateway({fetchImpl,now:Date.now,nonce:randomUUID}),a1Gateway=createGateway({fetchImpl,now:Date.now,nonce:randomUUID});
 const scoped={...env,A1_RUNTIME:{fetch:request=>{const path=new URL(request.url).pathname;return path.startsWith('/internal/v1/fiscal-signed/')?signed(new Request(`http://runtime.internal${path}`,request)):a1(request);}}},lost=new Set(),readback=new Set(),delayed=new Set();
 const fetch=async request=>{
  const path=new URL(request.url).pathname,isA1=path==='/v1/a1';
  if(isA1&&!['GET','OPTIONS'].includes(request.method))return Response.json({error:'QA_A1_CONFIGURATION_DISABLED'},{status:405});
  let input;if(retry&&path==='/v1/fiscal-signed/run'&&request.method==='POST'){try{input=await request.clone().json();}catch{/* Real parser handles invalid JSON. */}}
  const result=await(isA1?a1Gateway:signedGateway)(request,scoped);
  if(retry&&result.ok&&input?.command_id&&!lost.has(input.command_id)&&(await result.clone().json()).status==='stored'){lost.add(input.command_id);readback.add(input.command_id);const response=unavailable(true);response.headers.set('Access-Control-Allow-Origin',env.ALLOWED_ORIGINS);return response;}
  const match=/^\/v1\/fiscal-signed\/commands\/([a-f0-9-]{36})$/.exec(path);
  if(retry&&result.ok&&match&&readback.delete(match[1])){const response=unavailable(false);response.headers.set('Access-Control-Allow-Origin',env.ALLOWED_ORIGINS);return response;}
  // Deliberately delays an already-completed read, including past caller cancellation, to test the UI epoch guard.
  if(detailDelayMs&&request.method==='GET'&&path.startsWith('/v1/fiscal-signed/')){delayed.add(path);try{await new Promise(resolve=>setTimeout(resolve,detailDelayMs));}finally{delayed.delete(path);}}
  return result;
 };
 return{fetch,dispose(){signed.dispose();secret.fill(0);seed.dispose();},faults:{lost,readback,delayed}};
}
