/** Reviewed SOAP/rules composition for local synthetic execution. No deployed068 adapter or live dispatch. */
import {prepareAuthorization,authorizationRequestBytes,parseAuthorizationResponse,composeProcessedNfe,FiscalAuthorizationError} from './index.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as PROFILE} from './validator.mjs';
import {pinnedCandidateCertificate} from './pinned-certificate.mjs';
import {createAuthorizationReadPorts} from './read-operations.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,extractReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {createAuthorizationRuleGate} from './operational-rule-gate.mjs';
import {projectSubsetLedger,subsetResult as result,checkLocalContext,LOCAL_OPERATIONAL_FLAGS} from './operational-dto.mjs';
import {AuthorizationServiceError,need,data,id,sha,integer,hash,freeze,scope,readBody,cancel} from './service-common.mjs';
import {TERMINAL,SQLSTATES,preparationEvidence,resultEvidence,same,stamp} from './service-dto.mjs';
export {AuthorizationServiceError} from './service-common.mjs';
const BUCKET='brufap-fiscal-artifacts';
export const SERVICE_FAILURE_CODES=Object.freeze(['AUTHORIZATION_SERVICE_DISABLED','AUTHORIZATION_SUBSET_REVIEW_INVALID','AUTHORIZATION_SUBSET_REVIEW_PENDING','AUTHORIZATION_SUBSET_REVIEW_CHANGED','AUTHORIZATION_TRANSPORT_INVALID','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE','AUTHORIZATION_ALREADY_RUNNING','AUTHORIZATION_SOURCE_INVALID','AUTHORIZATION_SERVICE_BYTES_INVALID','AUTHORIZATION_SERVICE_HASH_MISMATCH','AUTHORIZATION_SERVICE_BODY_INVALID','AUTHORIZATION_SERVICE_BODY_LIMIT','AUTHORIZATION_SERVICE_ABORTED','AUTHORIZATION_SERVICE_TIMEOUT','AUTHORIZATION_SERVICE_RESPONSE_INVALID','AUTHORIZATION_COMMAND_MISMATCH','AUTHORIZATION_PREPARATION_CHANGED','AUTHORIZATION_CALLBACK_INVALID','AUTHORIZATION_GRANT_MISMATCH','AUTHORIZATION_REQUEST_INVALID','AUTHORIZATION_BINDING_INVALID','AUTHORIZATION_JOURNAL_MISSING','AUTHORIZATION_JOURNAL_CONFLICT','AUTHORIZATION_VALIDATOR_INVALID','AUTHORIZATION_PORT_FAILED','AUTHORIZATION_STORED_MISMATCH','AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH','AUTHORIZATION_PINNED_CERTIFICATE_INVALID',...SQLSTATES]);
const schema={schema_profile:PROFILE.profile,schema_manifest_hash:PROFILE.manifestHash,validator_hash:PROFILE.validatorHash};
const captureRun=v=>{const x=data(v,['actor','commandId','candidateId','signedHash','expectedIdentityVersion','expectedA1Version','expectedPolicyVersion','confirmed']);need(['actor','commandId','candidateId'].every(k=>id(x[k]))&&sha(x.signedHash)&&['expectedIdentityVersion','expectedA1Version','expectedPolicyVersion'].every(k=>integer(x[k]))&&x.confirmed===true);return freeze(x);};
const beginArgs=x=>({p_user_id:x.actor,p_command_id:x.commandId,p_candidate_id:x.candidateId,p_signed_hash:x.signedHash,p_expected_identity_version:x.expectedIdentityVersion,p_expected_a1_version:x.expectedA1Version,p_expected_policy_version:x.expectedPolicyVersion,p_confirmed:true});
const path=(c,type,tag=c.request_hash)=>`authorization/${c.attempt_id}/${type}/${tag}.${type==='observations'?'json':'xml'}`;
const callArgs=(actor,c)=>({p_user_id:actor,p_attempt_id:c.attempt_id,p_lease_id:c.lease_id});
const profile=c=>({origin:c.origin,binding_profile:c.binding_profile,rule_profile:c.rule_profile,...schema,can_emit:false,can_transmit:false});
function checkReport(v,request,bytes,kind){
 const base=['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared','signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit','validatorHash','schemaManifestHash'];
 if(v?.ok===false){const x=data(v,['ok','code','xmlDigest','kind','signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit','xsdValidated','contextMatched'],[],'AUTHORIZATION_VALIDATOR_INVALID');need(x.xmlDigest===hash(bytes)&&x.kind===kind&&['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit','xsdValidated','contextMatched'].every(k=>x[k]===false)&&typeof x.code==='string'&&/^AUTHORIZATION_[A-Z_]{1,70}$/.test(x.code),'AUTHORIZATION_VALIDATOR_INVALID');return x;}
 const x=data(v,base,[],'AUTHORIZATION_VALIDATOR_INVALID');need(x.ok===true&&x.schemaProfile===PROFILE.profile&&x.validatorHash===PROFILE.validatorHash&&x.schemaManifestHash===PROFILE.manifestHash&&x.kind===kind&&x.xmlDigest===hash(bytes)&&x.model===request.model&&x.environment==='2'&&x.xsdValidated===true&&x.contextMatched===true&&['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit'].every(k=>x[k]===false)&&['cStat','protocolCStat'].every(k=>x[k]===null||typeof x[k]==='string'&&/^\d{3,4}$/.test(x[k]))&&typeof x.referenceDigestMatched==='boolean'&&x.authorizationDeclared===['100','150'].includes(x.protocolCStat),'AUTHORIZATION_VALIDATOR_INVALID');return x;
}
function rejection(error){
 if(!(error instanceof FiscalAuthorizationError))return null;
 if(/DIGEST|REFERENCE/.test(error.code))return'DIGEST_MISMATCH';
 if(/CONTEXT|BATCH|TIMESTAMP|INCOMPLETE/.test(error.code))return'CONTEXT_MISMATCH';return'XML_INVALID';
}
/** All ports are backend-only and mandatory. The default is closed before any RPC. */
export function createReviewedAuthorizationService(configuration){
 const p=data(configuration,['ledger','storage','validate','readReview','withPreparedSession','transport'],['syntheticDispatchEnabled']);
 need((p.syntheticDispatchEnabled===undefined||typeof p.syntheticDispatchEnabled==='boolean')&&['ledger','validate','readReview','withPreparedSession','transport'].every(k=>typeof p[k]==='function'));
 const storage=data(p.storage,['read','putImmutable']);need(['read','putImmutable'].every(k=>typeof storage[k]==='function'));
 const ledger=p.ledger,validate=p.validate,custody=p.withPreparedSession,transport=p.transport,enabled=p.syntheticDispatchEnabled===true,running=new Set();
 const ruleGate=createAuthorizationRuleGate({readReview:p.readReview});
 const {read}=createAuthorizationReadPorts(()=>{},storage.read);
 const sql=async(action,args,s)=>{const captured=freeze({...args}),raw=await s.bounded(()=>ledger(action,captured,{signal:s.signal,deadline:s.deadline}));s.check();return projectSubsetLedger(action,raw,captured);};
 async function persist(key,bytes,s){const tag=hash(bytes),owned=Buffer.from(bytes);try{const ack=await s.bounded(()=>storage.putImmutable({bucket:BUCKET,key,bytes:owned,sha256:tag,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));const a=data(ack,['status','requires_readback']);need([200,201,409].includes(a.status)&&a.requires_readback===true);}catch{/* Readback, never overwrite, resolves an uncertain PUT. */}finally{owned.fill(0);}s.check();const checked=await read(key,s,{expectedHash:tag,expectedSize:bytes.length});need(checked!==null,'AUTHORIZATION_JOURNAL_MISSING');checked.fill(0);return tag;}
 async function source(c,at,s){const bytes=await read(`candidates/${c.candidate_id}/${c.signed_hash}.xml`,s,{expectedHash:c.signed_hash,expectedSize:c.signed_size});need(bytes!==null,'AUTHORIZATION_SOURCE_INVALID');
  try{const cert=pinnedCandidateCertificate({signedBytes:bytes,signedHash:c.signed_hash,signedSize:c.signed_size,certificateFingerprint:c.certificate_fingerprint,model:c.model,now:new Date(at)});need(cert.issuerCnpj===c.issuer_cnpj&&cert.accessKey===c.access_key&&cert.referenceDigest===c.reference_digest,'AUTHORIZATION_SOURCE_INVALID');
   const request=prepareAuthorization({signedBytes:bytes,expectedSignedHash:c.signed_hash,expectedModel:c.model,expectedIssuerCnpj:c.issuer_cnpj,expectedHolderCnpj:c.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:c.certificate_fingerprint,now:new Date(at),batchId:c.batch_id});return request;
  }finally{bytes.fill(0);}
 }
 const checkBinding=checkLocalContext;
 const encode=request=>Buffer.from(encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request})));
 async function validated(request,bytes,kind,s){const copied=Buffer.from(bytes),tag=hash(bytes);try{const raw=await s.bounded(()=>validate({request,xmlBytes:copied,kind},{signal:s.signal,deadline:s.deadline}));need(hash(copied)===tag,'AUTHORIZATION_VALIDATOR_INVALID');return checkReport(raw,request,bytes,kind);}finally{copied.fill(0);}}
 function sidecar(v,c,responseHash,responseSize){
  const x=data(v,['profile','origin','attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash','response_hash','response_size','http_status','received_at','tls_peer_verified','tls_origin_verified','tls_protocol','server_trust_profile','server_trust_anchor_sha256','subset_review_hash'],[],'AUTHORIZATION_JOURNAL_CONFLICT');
  need(x.profile==='authorization-subset-local-journal-v1'&&x.origin==='synthetic'&&x.tls_peer_verified===true&&x.tls_origin_verified===false&&['TLSv1.2','TLSv1.3'].includes(x.tls_protocol)&&x.server_trust_profile==='synthetic-mtls-v1'&&sha(x.server_trust_anchor_sha256)&&sha(x.subset_review_hash)&&[200,500].includes(x.http_status)&&stamp(x.received_at)&&['attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash'].every(k=>x[k]===c[k])&&x.response_hash===responseHash&&x.response_size===responseSize,'AUTHORIZATION_JOURNAL_CONFLICT');return x;
 }
 async function readJournal(c,proof,s,expected=null){
  const raw=await read(path(c,'responses'),s,expected?{expectedHash:expected.response_hash,expectedSize:expected.response_size}:{});need(raw!==null,'AUTHORIZATION_JOURNAL_MISSING');let meta;
  try{meta=await read(path(c,'observations'),s,{max:8192,...(expected?.observation?{expectedHash:expected.observation.sha256,expectedSize:expected.observation.size_bytes}:{})});need(meta!==null,'AUTHORIZATION_JOURNAL_MISSING');let decoded;try{decoded=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(meta));}catch{throw new AuthorizationServiceError('AUTHORIZATION_JOURNAL_CONFLICT');}
   const observation=sidecar(decoded,c,hash(raw),raw.length);need(observation.subset_review_hash===proof.review_hash,'AUTHORIZATION_JOURNAL_CONFLICT');
   return{bytes:raw,httpStatus:observation.http_status,observationHash:hash(meta),observationSize:meta.length};
  }catch(e){raw.fill(0);throw e;}finally{meta?.fill(0);}
 }
 async function verifyStored(v,s,expected=null){const c=v.recovery,a=v.artifact;need(TERMINAL.includes(v.current.state)&&a,'AUTHORIZATION_STORED_MISMATCH');if(expected){need(a.response_hash===expected.hash&&a.response_size===expected.size,'AUTHORIZATION_STORED_MISMATCH');if(expected.observationHash)need(v.observation.sha256===expected.observationHash&&v.observation.size_bytes===expected.observationSize,'AUTHORIZATION_STORED_MISMATCH');}
  const request=await read(path(c,'requests'),s,{expectedHash:c.request_hash,expectedSize:c.request_size});need(request!==null,'AUTHORIZATION_JOURNAL_MISSING');request.fill(0);const response=await readJournal(c,v.rule_review,s,{...a,observation:v.observation});response.bytes.fill(0);if(a.processed_hash){const b=await read(path(c,'processed',a.processed_hash),s,{expectedHash:a.processed_hash,expectedSize:a.processed_size});need(b!==null,'AUTHORIZATION_JOURNAL_MISSING');b.fill(0);}}
 async function processResponse(c,request,raw,s,httpStatus){let payload=null,processed=null,report=null,parsed=null,code=null,payloadHash=null;
  try{
   try{const extracted=extractReviewedAuthorizationSoap({request:prepareReviewedAuthorizationSoap({request}),envelopeBytes:raw});payload=Buffer.from(extracted.payloadXml);payloadHash=hash(payload);}
   catch(e){code=e?.code==='SOAP_AUTHORIZATION_FAULT'?'SOAP_FAULT':'SOAP_INVALID';}
   if(!code&&httpStatus!==200)code='SOAP_INVALID';
   if(!code){report=await validated(request,payload,'response',s);if(!report.ok)code=report.code==='AUTHORIZATION_XSD_INVALID'?'XSD_INVALID':/CONTEXT|REFERENCE|BATCH/.test(report.code)?'CONTEXT_MISMATCH':'XML_INVALID';}
   if(!code){try{parsed=parseAuthorizationResponse({request,responseBytes:payload});}catch(e){code=rejection(e);if(!code)throw e;}}
   if(!code){need(report.cStat===parsed.cStat&&report.protocolCStat===(parsed.protocol?.cStat??null)&&report.authorizationDeclared===(parsed.classification==='authorization_declared'),'AUTHORIZATION_VALIDATOR_INVALID');
    if(parsed.classification==='authorization_declared'){try{const composed=composeProcessedNfe({request,response:parsed});processed=Buffer.from(composed.processedXml);const checked=await validated(request,processed,'processed',s);if(!checked.ok)code='PROCESSED_INVALID';else need(checked.referenceDigestMatched&&checked.authorizationDeclared,'AUTHORIZATION_VALIDATOR_INVALID');}catch(e){if(e instanceof FiscalAuthorizationError)code='PROCESSED_INVALID';else throw e;}}
   }
   if(code){processed?.fill(0);processed=null;}
   const e=resultEvidence({...profile(c),request_hash:c.request_hash,response_hash:hash(raw),payload_hash:payloadHash,outcome:code?'invalid_response':parsed.classification,rejection_code:code,
    cstat:code?null:parsed.cStat,protocol_cstat:code?null:parsed.protocol?.cStat??null,protocol_number:code?null:parsed.protocol?.number??null,received_at:code?null:new Date(parsed.protocol?.receivedAt??parsed.receivedAt).toISOString(),receipt_number:code?null:parsed.receiptNumber,reference_digest:processed?request.referenceDigest:null,
    signature_verified:processed!==null,xsd_validated:!code,context_matched:!code,processed_xsd_validated:processed!==null,tls_origin_verified:false,transport_hash:null,transport_size:null});
   return{evidence:e,processed};
  }catch(e){processed?.fill(0);throw e;}finally{payload?.fill(0);}
 }
 async function perform(x,options,recoveryOnly=false,initial=null){
  const key=x.actor+':'+x.commandId;need(!running.has(key),'AUTHORIZATION_ALREADY_RUNNING');const s=scope(options);running.add(key);let known=initial,wire=null,raw=null,processed=null,expected=null,stage='prepare',callbackError=null,httpStatus=null,observationHash=null,observationSize=null;
  const command=async()=>{const v=await sql('command',{p_user_id:x.actor,p_command_id:x.commandId},s);const r=v.receipt;need(['candidateId','signedHash','expectedIdentityVersion','expectedA1Version','expectedPolicyVersion'].every((k,i)=>x[k]===r[['candidate_id','signed_hash','identity_version','a1_version','policy_version'][i]]),'AUTHORIZATION_COMMAND_MISMATCH');return v;};
  try{
   if(!known)try{known=await command();}catch(e){if(e?.code!=='P0002'||recoveryOnly)throw e;}
   if(known&&TERMINAL.includes(known.current.state)){await verifyStored(known,s);return result(known,{recovered:true});}
   if(known?.current.state==='failed_before_dispatch'||recoveryOnly&&known&&!known.current.grant_consumed)return result(known,{recovered:true});
   if(!known||!known.current.grant_consumed)known=await sql('begin',beginArgs(x),s);
   const c=known.recovery;checkBinding(c);const request=await source(c,known.receipt.created_at,s);wire=encode(request);const requestHash=hash(wire),requestSize=wire.length,ctx=freeze({...c,request_hash:requestHash,request_size:requestSize});
   if(known.current.grant_consumed){
    stage='journal';need(c.request_hash===requestHash&&c.request_size===requestSize,'AUTHORIZATION_JOURNAL_CONFLICT');const saved=await read(path(c,'requests'),s,{expectedHash:requestHash,expectedSize:requestSize});need(saved!==null,'AUTHORIZATION_JOURNAL_MISSING');saved.fill(0);const journal=await readJournal(c,known.rule_review,s);raw=journal.bytes;httpStatus=journal.httpStatus;observationHash=journal.observationHash;observationSize=journal.observationSize;
   }else{
    need(!recoveryOnly&&known.execution!==null,'AUTHORIZATION_PREPARATION_CHANGED');const payload=authorizationRequestBytes(request);try{need((await validated(request,payload,'request',s)).ok,'AUTHORIZATION_REQUEST_INVALID');}finally{payload.fill(0);}
    const reviewed=await ruleGate({actor:x.actor,candidateId:c.candidate_id,candidateVersion:known.receipt.candidate_version,request},{signal:s.signal,deadline:s.deadline});
    await persist(path(ctx,'requests'),wire,s);
    const evidence=preparationEvidence({...profile(ctx),request_hash:requestHash,payload_hash:request.requestHash,signed_hash:c.signed_hash,model:c.model,environment:'2',batch_id:c.batch_id,access_key:c.access_key,reference_digest:c.reference_digest,certificate_fingerprint:c.certificate_fingerprint,signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false});
    known=await sql('prepare',{...callArgs(x.actor,c),p_request_hash:requestHash,p_request_size:requestSize,p_evidence:evidence,p_rule_review:reviewed.proof},s);
    const fresh=await sql('begin',beginArgs(x),s);need(fresh.execution!==null&&same(fresh.execution,ctx)&&same(fresh.rule_review,reviewed.proof),'AUTHORIZATION_PREPARATION_CHANGED');known=fresh;
    const rechecked=await ruleGate({actor:x.actor,candidateId:c.candidate_id,candidateVersion:known.receipt.candidate_version,request},{signal:s.signal,deadline:s.deadline});need(same(rechecked.proof,reviewed.proof),'AUTHORIZATION_SUBSET_REVIEW_CHANGED');
    const end=Math.min(s.deadline-15000,Date.now()+20000,Date.parse(c.expires_at));need(end>Date.now(),'AUTHORIZATION_SERVICE_TIMEOUT');const tls=scope({signal:s.signal,deadline:end},20000);let calls=0,complete=false,invalid=false,callbackClosed=false;
    try{await tls.bounded(()=>custody(freeze({actor:x.actor,execution:fresh.execution,context:ctx,rule_review:reviewed.proof}),async session=>{
     if(callbackClosed){invalid=true;throw new AuthorizationServiceError('AUTHORIZATION_CALLBACK_INVALID');}
     calls++;if(calls!==1||complete){invalid=true;throw new AuthorizationServiceError('AUTHORIZATION_CALLBACK_INVALID');}
     try{tls.check();s.check();stage='use';const used=await sql('use',{...callArgs(x.actor,c),p_rule_review:reviewed.proof},tls);need(!callbackClosed,'AUTHORIZATION_CALLBACK_INVALID');tls.check();s.check();const {issued_at,...grant}=used.grant;need(same(grant,ctx),'AUTHORIZATION_GRANT_MISMATCH');
      stage='transport';let response,transportProof;
      try{const soap=prepareReviewedAuthorizationSoap({request}),pending=Promise.resolve().then(()=>{tls.check();s.check();return transport(freeze({request:soap,grant:used.grant,rule_review:used.rule_review}),session,{signal:tls.signal,deadline:tls.deadline});});
       let received;try{received=await tls.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.response?.body)).catch(()=>{});throw e;}
       const output=data(received,['response','tls']),t=data(output.tls,['origin','protocol','server_identity_verified','server_trust_profile','server_trust_anchor_sha256']);
       need(t.origin==='synthetic'&&['TLSv1.2','TLSv1.3'].includes(t.protocol)&&t.server_identity_verified===true&&t.server_trust_profile==='synthetic-mtls-v1'&&sha(t.server_trust_anchor_sha256),'AUTHORIZATION_TRANSPORT_INVALID');transportProof=t;
       response=output.response;need(response?.url==='','AUTHORIZATION_BINDING_INVALID');httpStatus=response.status;
       raw=await readBody(response,tls,{statuses:[200,500],types:['application/soap+xml; charset=utf-8']});
      }finally{cancel(response?.body);}
      tls.check();s.check();expected={hash:hash(raw),size:raw.length};stage='journal';await persist(path(ctx,'responses'),raw,s);
      const observation=Buffer.from(JSON.stringify(sidecar({profile:'authorization-subset-local-journal-v1',origin:'synthetic',attempt_id:ctx.attempt_id,command_id:ctx.command_id,candidate_id:ctx.candidate_id,batch_id:ctx.batch_id,signed_hash:ctx.signed_hash,request_hash:requestHash,response_hash:expected.hash,response_size:expected.size,http_status:httpStatus,received_at:new Date().toISOString(),tls_peer_verified:true,tls_origin_verified:false,tls_protocol:transportProof.protocol,server_trust_profile:transportProof.server_trust_profile,server_trust_anchor_sha256:transportProof.server_trust_anchor_sha256,subset_review_hash:reviewed.proof.review_hash},ctx,expected.hash,expected.size)));
      try{observationHash=await persist(path(ctx,'observations'),observation,s);observationSize=observation.length;}finally{observation.fill(0);}complete=true;
     }catch(e){callbackError=e;throw e;}
    },{signal:tls.signal,deadline:tls.deadline}));tls.check();s.check();if(callbackError)throw callbackError;need(calls===1&&complete&&!invalid&&raw!==null,'AUTHORIZATION_CALLBACK_INVALID');}finally{callbackClosed=true;tls.stop('AUTHORIZATION_SERVICE_ABORTED');tls.close();}
   }
   s.check();expected={hash:hash(raw),size:raw.length,observationHash,observationSize};stage='validate';const checked=await processResponse(ctx,request,raw,s,httpStatus);processed=checked.processed;let processedHash=null;if(processed)processedHash=await persist(path(ctx,'processed',hash(processed)),processed,s);
   stage='finish';s.check();known=await sql('finish',{...callArgs(x.actor,c),p_response_hash:expected.hash,p_response_size:expected.size,p_evidence:checked.evidence,p_processed_hash:processedHash,p_processed_size:processed?.length??null,p_observation_hash:observationHash,p_observation_size:observationSize},s);
   try{known=await command();await verifyStored(known,s,expected);return result(known);}catch(e){s.check();if(e?.code==='42501')throw e;if(TERMINAL.includes(known.current.state)){await verifyStored(known,s,expected);return result(known,{recovered:true});}throw e;}
  }catch(error){
   const original=callbackError??error,code=original instanceof AuthorizationServiceError&&SERVICE_FAILURE_CODES.includes(original.code)?original.code:SQLSTATES.includes(original?.code)?original.code:'AUTHORIZATION_PORT_FAILED';
   if(code==='42501')return result(null,{commandId:x.commandId,failureCode:code});
   try{s.check();known=await command();if(TERMINAL.includes(known.current.state)){await verifyStored(known,s,expected);return result(known,{recovered:true});}
    if(!recoveryOnly&&error?.code!=='40001'&&!['failed_before_dispatch','submission_uncertain'].includes(known.current.state)){const c=known.recovery;known=await sql('fail',{...callArgs(x.actor,c),p_error_code:known.current.grant_consumed?(stage==='journal'?'JOURNAL_UNAVAILABLE':stage==='validate'?'VALIDATOR_UNAVAILABLE':'TRANSPORT_UNCONFIRMED'):'PREPARATION_FAILED'},s);}
   }catch(caught){if(caught?.code==='42501')return result(null,{commandId:x.commandId,failureCode:'42501'});/* A lost response never grants another transport. */}
   if(known?.current.state==='failed_before_dispatch')return result(known,{recovered:true});
   // No stored claim without its readback proof. Do not manufacture a new current state.
   return result(known&&TERMINAL.includes(known.current.state)?null:known,{commandId:x.commandId,failureCode:code});
  }finally{wire?.fill(0);raw?.fill(0);processed?.fill(0);s.close();running.delete(key);}
 }
 async function query(action,input,options={}){
  const x=data(input,action==='history'?['actor','candidateId','limit','before']:['actor','commandId']);need(id(x.actor)&&id(action==='history'?x.candidateId:x.commandId));
  if(action==='history')need(integer(x.limit,25)&&(x.before===null||typeof x.before==='string'&&/^[1-9]\d{0,14}$/.test(x.before)));const s=scope(options);
  try{return await sql(action,action==='history'?{p_user_id:x.actor,p_candidate_id:x.candidateId,p_limit:x.limit,p_before:x.before}:{p_user_id:x.actor,p_command_id:x.commandId},s);}finally{s.close();}
 }
 return Object.freeze({
  run(input,options={}){need(enabled,'AUTHORIZATION_SERVICE_DISABLED');return perform(captureRun(input),options);},
  async command(input,options={}){return result(await query('command',input,options),{readOnly:true});},
  async history(input,options={}){const v=await query('history',input,options);return freeze({...v,...LOCAL_OPERATIONAL_FLAGS,items:v.items.map(x=>result(x,{readOnly:true}))});},
  async recover(input,options={}){const x=data(input,['actor','commandId']);need(id(x.actor)&&id(x.commandId));const s=scope(options);try{const opts={signal:s.signal,deadline:s.deadline},v=await query('command',x,opts),r=v.receipt;return await perform({actor:x.actor,commandId:x.commandId,candidateId:r.candidate_id,signedHash:r.signed_hash,expectedIdentityVersion:r.identity_version,expectedA1Version:r.a1_version,expectedPolicyVersion:r.policy_version,confirmed:true},opts,true,v);}finally{s.close();}},
 });
}
