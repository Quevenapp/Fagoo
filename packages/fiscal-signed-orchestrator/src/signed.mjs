/** Private offline orchestration. No environment, default network, credential loader or SEFAZ port. */
import {createHash} from 'node:crypto';
import {buildAccessKey} from '../../fiscal-core/src/identity.mjs';
import {createSignedHomologationCandidate,disposeSigner,FiscalXmlError} from '../../fiscal-xml/src/index.mjs';
import {inspectNfe} from '../../fiscal-xml/src/xml.mjs';

const BUCKET='fagoo-fiscal-artifacts',MAX_UNSIGNED=480000,MAX_SIGNED=512000;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const id=v=>typeof v==='string'&&UUID.test(v),digest=v=>typeof v==='string'&&SHA.test(v),version=v=>Number.isInteger(v)&&v>0&&v<=2147483647;
const time=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':plain(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const equal=(a,b)=>canonical(a)===canonical(b);
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
const copy=v=>frozen(structuredClone(v));
const PROFILE=Object.freeze({candidate_profile:'signed-homologation-sp-v1',signature_profile:'nfe400-rsa-sha1-c14n-v1',schema_profile:'pl010f-v1.04',schema_manifest_hash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validator_version:'fiscal-schema-runner-v1',validator_hash:'7c546683d6ca94d124b60a32ca9f6bf8f731533455af634326a10ae078ea5cec',nfce_qr_profile:'sp-homologation-online-qr-v3'});
const FALSE_FLAGS=['tax_rules_validated','icp_brasil_chain_validated','revocation_checked','authorized','can_emit','can_transmit','financial_mutation_performed','stock_mutation_performed'];
const FLAGS=Object.freeze({offline_prototype:true,environment:'2',candidate_profile:PROFILE.candidate_profile,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))});
const FAIL_CODES=new Set(['XML_INPUT_INVALID','SIGNATURE_INVALID','XSD_INVALID','QR_INVALID','XML_SIZE_LIMIT','CERTIFICATE_INVALID']);
const RECEIPT=['candidate_id','version','unsigned_job_id','reservation_id','draft_id','model','unsigned_hash','unsigned_size','basis_hash','completion_version','completion_hash','a1_version','credential_id','certificate_fingerprint','profile','created_at'];
const CURRENT=['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
const META=['profile','legacy_provider_enabled','pfx_mac','pfx_mac_iterations','fingerprint_sha256','holder_cnpj','not_before','not_after','rsa_bits','presented_chain','validated_at','key_matches_certificate','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'];
export class SignedFiscalError extends Error{constructor(code){super(code);this.name='SignedFiscalError';this.code=code;}}
const need=(ok,code='SIGNED_RESPONSE_INVALID')=>{if(!ok)throw new SignedFiscalError(code);};
const safe=e=>e instanceof SignedFiscalError?e.code:['42501','40001','22023','55000','P0002'].includes(e?.code)?`SIGNED_RPC_${e.code}`:'SIGNED_PORT_FAILED';
function noTrust(v,stored){need(plain(v)&&v.data_mode==='fiscal_signed_candidate'&&v.environment==='2'&&v.purpose==='offline-homologation'&&v.candidate_profile===PROFILE.candidate_profile&&FALSE_FLAGS.every(k=>v[k]===false)&&['signed','signature_verified','xsd_validated'].every(k=>v[k]===stored));}
function checkedReceipt(r,input){
 need(exact(r,RECEIPT)&&['candidate_id','unsigned_job_id','reservation_id','draft_id','credential_id'].every(k=>id(r[k]))&&['version','completion_version','a1_version'].every(k=>version(r[k]))
  &&['unsigned_hash','basis_hash','completion_hash','certificate_fingerprint'].every(k=>digest(r[k]))&&['55','65'].includes(r.model)&&Number.isInteger(r.unsigned_size)&&r.unsigned_size>0&&r.unsigned_size<=MAX_UNSIGNED&&time(r.created_at)&&equal(r.profile,PROFILE));
 need(r.unsigned_job_id===input.unsignedJobId&&r.unsigned_hash===input.unsignedHash&&r.basis_hash===input.basisHash&&r.a1_version===input.expectedA1Version,'SIGNED_RECEIPT_BINDING_INVALID');
 return r;
}
function checkedEvidence(e,r,h){
 need(exact(e,['signature','xsd','qr'])&&exact(e.signature,['xml_hash','certificate_fingerprint','signed_content_hash','reference_digest','profile'])&&exact(e.xsd,['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash'])&&exact(e.qr,['profile','verified']));
 const s=e.signature,x=e.xsd;
 need(s.xml_hash===h&&s.certificate_fingerprint===r.certificate_fingerprint&&digest(s.signed_content_hash)&&typeof s.reference_digest==='string'&&/^[A-Za-z0-9+/]{27}=$/.test(s.reference_digest)&&Buffer.from(s.reference_digest,'base64').toString('base64')===s.reference_digest&&s.profile===PROFILE.signature_profile
  &&x.xml_hash===h&&x.schema_profile===PROFILE.schema_profile&&x.manifest_hash===PROFILE.schema_manifest_hash&&x.validator_version===PROFILE.validator_version&&x.validator_hash===PROFILE.validator_hash
  &&e.qr.profile===(r.model==='65'?PROFILE.nfce_qr_profile:null)&&e.qr.verified===(r.model==='65'));
}
function view(raw,input,expectedReceipt){
 need(plain(raw));const r=checkedReceipt(raw.receipt,input),c=raw.current,a=raw.artifact;
 if(expectedReceipt)need(equal(r,expectedReceipt),'SIGNED_RECEIPT_BINDING_INVALID');
 need(exact(c,CURRENT)&&['pending','stored','failed'].includes(c.state)&&Number.isInteger(c.attempt_count)&&c.attempt_count>=1&&c.attempt_count<=100
  &&Number.isInteger(c.a1_version)&&c.a1_version>=0&&c.a1_version<=2147483647&&id(c.latest_candidate_id)&&version(c.latest_candidate_version)
  &&['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'].every(k=>typeof c[k]==='boolean')
  &&(c.state==='pending'?time(c.lease_until):c.lease_until===null)&&c.is_latest_candidate===(c.latest_candidate_id===r.candidate_id));
 need(!c.artifact_current||c.state==='stored'&&c.is_latest_candidate&&c.unsigned_artifact_current&&!c.basis_changed&&!c.draft_archived&&!c.source_cancelled&&c.series_enabled&&!c.a1_changed&&c.certificate_time_valid_now);
 noTrust(raw,c.state==='stored');need(c.state==='failed'?FAIL_CODES.has(raw.error_code):raw.error_code===null);
 if(c.state==='stored'){need(exact(a,['signed_hash','size_bytes','evidence','created_at'])&&digest(a.signed_hash)&&Number.isInteger(a.size_bytes)&&a.size_bytes>0&&a.size_bytes<=MAX_SIGNED&&time(a.created_at));checkedEvidence(a.evidence,r,a.signed_hash);}else need(a===null);
 if(Object.hasOwn(raw,'command_id'))need(raw.command_id===input.commandId,'SIGNED_COMMAND_BINDING_INVALID');
 return copy({receipt:r,current:c,artifact:a,error_code:raw.error_code});
}
function project(v,input,extra={}){
 const r=v.receipt,c=v.current,a=v.artifact;
 return {...FLAGS,status:c.state,command_id:input.commandId,candidate_id:r.candidate_id,candidate_version:r.version,unsigned_job_id:r.unsigned_job_id,
  unsigned_hash:r.unsigned_hash,basis_hash:r.basis_hash,model:r.model,completion_version:r.completion_version,completion_hash:r.completion_hash,a1_version:r.a1_version,
  signed:c.state==='stored',signature_verified:c.state==='stored',xsd_validated:c.state==='stored',error_code:v.error_code,
  current:Object.fromEntries(CURRENT.filter(k=>k!=='lease_until').map(k=>[k,c[k]])),
  artifact:a?{sha256:a.signed_hash,size_bytes:a.size_bytes,created_at:a.created_at}:null,...extra};
}
function usage(raw,started,input){
 noTrust(raw,false);need(raw.private_executor_only===true&&equal(checkedReceipt(raw.receipt,input),started.receipt)&&raw.lease_id===started.execution.lease_id&&raw.lease_until===started.execution.lease_until&&time(raw.used_at),'SIGNED_USE_BINDING_INVALID');
 const i=raw.identity,r=started.receipt,o=raw.unsigned_object,ctx=raw.credential_context,meta=raw.credential_metadata,key=raw.credential_object;
 need(exact(i,['cUF','cnpj','model','environment','series','number','tpEmis','cNF','issuedAt'])&&Object.values(i).every(v=>typeof v==='string')&&i.cUF==='35'&&i.environment==='2'&&i.model===r.model&&i.tpEmis==='1','SIGNED_IDENTITY_INVALID');
 let accessKey;try{accessKey=buildAccessKey(i);}catch{need(false,'SIGNED_IDENTITY_INVALID');}need(raw.access_key===accessKey,'SIGNED_IDENTITY_INVALID');
 need(exact(o,['bucket','path','hash','size'])&&o.bucket===BUCKET&&o.path===`jobs/${r.unsigned_job_id}/${r.unsigned_hash}.xml`&&o.hash===r.unsigned_hash&&o.size===r.unsigned_size,'SIGNED_UNSIGNED_OBJECT_INVALID');
 need(exact(ctx,['vault_id','credential_id','credential_version','company_identity_version','holder_cnpj','environment','purpose'])&&id(ctx.vault_id)&&ctx.credential_id===r.credential_id&&version(ctx.credential_version)&&ctx.credential_version<=r.a1_version&&version(ctx.company_identity_version)&&ctx.holder_cnpj===i.cnpj&&ctx.environment==='2'&&ctx.purpose==='offline-homologation','SIGNED_CUSTODY_BINDING_INVALID');
 need(exact(meta,META)&&meta.profile==='openssl3-pkcs12'&&typeof meta.legacy_provider_enabled==='boolean'&&['sha1','sha224','sha256','sha384','sha512'].includes(meta.pfx_mac)&&Number.isInteger(meta.pfx_mac_iterations)&&meta.pfx_mac_iterations>=1&&meta.pfx_mac_iterations<=1000000
  &&meta.fingerprint_sha256===r.certificate_fingerprint&&meta.holder_cnpj===i.cnpj&&['not_before','not_after','validated_at'].every(k=>time(meta[k]))&&[2048,3072,4096].includes(meta.rsa_bits)
  &&Array.isArray(meta.presented_chain)&&meta.presented_chain.length>=1&&meta.presented_chain.length<=10&&meta.presented_chain.every(digest)&&meta.presented_chain[0]===r.certificate_fingerprint&&new Set(meta.presented_chain).size===meta.presented_chain.length
  &&meta.key_matches_certificate===true&&meta.presented_chain_links_checked===true&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'].every(k=>meta[k]===false),'SIGNED_CUSTODY_BINDING_INVALID');
 need(exact(key,['bucket','path','hash','size','key_id'])&&key.bucket==='fagoo-a1-vault'&&digest(key.hash)&&key.path===`credentials/${r.credential_id}/${key.hash}.json`&&Number.isInteger(key.size)&&key.size>0&&key.size<=1500000&&typeof key.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(key.key_id),'SIGNED_CUSTODY_BINDING_INVALID');
 return copy({actor:input.actor,command_id:input.commandId,candidate_id:r.candidate_id,a1_version:r.a1_version,lease_id:raw.lease_id,lease_until:raw.lease_until,used_at:raw.used_at,
  identity:i,access_key:accessKey,unsigned_object:o,credential_context:ctx,credential_metadata:meta,credential_object:key});
}
function scope(options={}){
 need(plain(options)&&Reflect.ownKeys(options).every(k=>['signal','deadline'].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(options,k),'value')),'SIGNED_OPTIONS_INVALID');
 const signal=options.signal,requestedDeadline=options.deadline;need(signal===undefined||signal instanceof AbortSignal,'SIGNED_OPTIONS_INVALID');
 const start=Date.now(),deadline=requestedDeadline??start+45000;need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+45000,'SIGNED_DEADLINE_INVALID');need(!signal?.aborted,'SIGNED_ABORTED');
 const controller=new AbortController();let rejectStop,reason='SIGNED_ABORTED';const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const stop=()=>{controller.abort();rejectStop(new SignedFiscalError(reason));};const timer=setTimeout(()=>{reason='SIGNED_TIMEOUT';stop();},deadline-start);signal?.addEventListener('abort',stop,{once:true});
 const check=()=>{need(!controller.signal.aborted,reason);need(Date.now()<deadline,'SIGNED_TIMEOUT');};
 return{signal:controller.signal,deadline,check,bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);},close(){clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}};
}
function schemaReport(r,expected){
 const common=['xmlDigest','model','environment','sizeBytes','schemaProfile','validatorVersion','validatorHash','schemaManifestHash','xsdValidated','canEmit','signatureVerified','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit'];
 need(exact(r,r?.ok===true?['ok',...common]:['ok','code','diagnostics',...common])&&r.xmlDigest===expected.hash&&r.model===expected.model&&r.sizeBytes===expected.size&&r.environment==='2'
  &&r.schemaProfile===PROFILE.schema_profile&&r.validatorVersion===PROFILE.validator_version&&r.validatorHash===PROFILE.validator_hash&&r.schemaManifestHash===PROFILE.schema_manifest_hash
  &&['canEmit','signatureVerified','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit'].every(k=>r[k]===false),'SIGNED_XSD_RESPONSE_INVALID');
 if(r.ok===true){need(r.xsdValidated===true,'SIGNED_XSD_RESPONSE_INVALID');return;}
 need(r.ok===false&&r.xsdValidated===false&&['XML_SIZE_OR_TYPE_INVALID','XML_ENCODING_INVALID','XML_DECLARATION_UNSUPPORTED','XML_MALFORMED','XML_NFE_ROOT_INVALID','XML_TREE_LIMIT','XML_EXPECTED_MODEL_MISMATCH','XML_HOMOLOGATION_REQUIRED','XML_XSD_INVALID'].includes(r.code)&&Array.isArray(r.diagnostics)&&r.diagnostics.length<=20,'SIGNED_XSD_RESPONSE_INVALID');
 need(r.diagnostics.every(d=>exact(d,['line','column','domain','type'])&&['line','column'].every(k=>Number.isInteger(d[k])&&d[k]>=0&&d[k]<=MAX_SIGNED)&&['domain','type'].every(k=>typeof d[k]==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(d[k]))),'SIGNED_XSD_RESPONSE_INVALID');
 need(r.code==='XML_XSD_INVALID'||r.diagnostics.length===0,'SIGNED_XSD_RESPONSE_INVALID');throw new SignedFiscalError('SIGNED_XSD_REJECTED');
}

export function createSignedFiscalOrchestrator({rpc,storage,withAuthorizedSigner,validateXsd}={}){
 need(typeof rpc==='function'&&typeof storage?.read==='function'&&typeof storage?.putImmutable==='function'&&typeof withAuthorizedSigner==='function'&&typeof validateXsd==='function','SIGNED_PORTS_REQUIRED');
 const running=new Set();
 return Object.freeze({async run(input,options){
  need(exact(input,['actor','commandId','unsignedJobId','unsignedHash','basisHash','expectedA1Version'])&&['actor','commandId','unsignedJobId'].every(k=>id(input[k]))&&digest(input.unsignedHash)&&digest(input.basisHash)&&version(input.expectedA1Version),'SIGNED_INPUT_INVALID');
  need(!running.has(input.commandId),'SIGNED_ALREADY_RUNNING');const s=scope(options),job=copy(input);running.add(job.commandId);
  let phase='recover',priorKnown=false,beginSent=false,finishSent=false,claimed=null,builtProof=null,sourceBytes=null,signedBytes=null,xml=null,storageOperations=0,callbackClosed=false,callbackInvoked=false,callbackDone=false,callbackInvalid=false;
  const invoke=(name,args)=>s.bounded(()=>rpc('erp_fiscal_signed_'+name,{...args,p_user_id:job.actor},{signal:s.signal,deadline:s.deadline}));
  const leaseCheck=()=>{s.check();if(claimed)need(Date.parse(claimed.execution.lease_until)>Date.now()+1000,'SIGNED_LEASE_EXPIRED');};
  const read=async(key,expected,max)=>{
   leaseCheck();need(++storageOperations<=5,'SIGNED_STORAGE_LIMIT');let response,reader,bytes,returned=false;
   const pending=Promise.resolve().then(()=>{leaseCheck();return storage.read({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
   try{
    try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>r?.body?.cancel()).catch(()=>{});throw e;}
    if(response===null)return null;
    need(response instanceof Response&&response.status===200&&!response.redirected&&response.body,'SIGNED_STORAGE_RESPONSE_INVALID');const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
    need(response.headers.get('content-type')==='application/octet-stream'&&(encoding===null||encoding==='identity')&&(length===null||/^\d+$/.test(length)&&Number(length)===expected.size),'SIGNED_STORAGE_RESPONSE_INVALID');
    need(expected.size>0&&expected.size<=max,'SIGNED_STORAGE_SIZE_INVALID');bytes=Buffer.alloc(expected.size);reader=response.body.getReader();let used=0;
    while(true){const item=await s.bounded(()=>reader.read());if(item.done)break;need(item.value instanceof Uint8Array&&used+item.value.length<=expected.size,'SIGNED_STORAGE_SIZE_INVALID');bytes.set(item.value,used);used+=item.value.length;}
    need(used===expected.size&&hash(bytes)===expected.hash,'SIGNED_STORAGE_HASH_CONFLICT');leaseCheck();returned=true;return bytes;
   }finally{if(!returned)bytes?.fill(0);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}else void response?.body?.cancel().catch(()=>{});}
  };
  try{
   let prior;try{prior=view(await invoke('command',{p_command_id:job.commandId}),job);priorKnown=true;}catch(e){if(e?.code!=='P0002')throw e;}
   if(prior&&(prior.current.state!=='pending'||Date.parse(prior.current.lease_until)>Date.now()))return project(prior,job,{recovered:true});
   phase='begin';beginSent=true;const raw=await invoke('begin',{p_command_id:job.commandId,p_unsigned_job_id:job.unsignedJobId,p_unsigned_hash:job.unsignedHash,p_basis_hash:job.basisHash,p_expected_a1_version:job.expectedA1Version});
   const started=view(raw,job);need(raw.command_id===job.commandId&&typeof raw.replayed==='boolean');
   if(raw.execution===null)return project(started,job,{recovered:Boolean(prior)});
   need(started.current.state==='pending'&&exact(raw.execution,['private_executor_only','lease_id','lease_until'])&&raw.execution.private_executor_only===true&&id(raw.execution.lease_id)&&raw.execution.lease_until===started.current.lease_until,'SIGNED_EXECUTION_INVALID');
   claimed=copy({...started,execution:raw.execution});leaseCheck();phase='use';const grant=usage(await invoke('use',{p_candidate_id:started.receipt.candidate_id,p_lease_id:claimed.execution.lease_id}),claimed,job);
   phase='read_unsigned';sourceBytes=await read(grant.unsigned_object.path,{hash:grant.unsigned_object.hash,size:grant.unsigned_object.size},MAX_UNSIGNED);need(sourceBytes,'SIGNED_UNSIGNED_MISSING');
   try{xml=new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes);}catch{need(false,'SIGNED_UNSIGNED_ENCODING_INVALID');}
   phase='inspect';const parsed=inspectNfe(xml);need(equal(parsed.identity,grant.identity)&&parsed.accessKey===grant.access_key,'SIGNED_UNSIGNED_IDENTITY_CONFLICT');
   phase='custody';let candidate=null;
   const callback=signer=>{
    // Even an invalid/late invocation relinquishes a genuine signer handle immediately.
    try{
     if(callbackClosed||callbackInvoked){callbackInvalid=true;need(false,'SIGNED_CUSTODY_CALLBACK_INVALID');}callbackInvoked=true;leaseCheck();
     const clock=new Date();need(clock.getTime()>=Date.parse(grant.credential_metadata.not_before)&&clock.getTime()<=Date.parse(grant.credential_metadata.not_after),'SIGNED_CERTIFICATE_TIME_INVALID');
     candidate=createSignedHomologationCandidate({xml,signer,expectedIssuerCnpj:grant.identity.cnpj,expectedModel:started.receipt.model,expectedUnsignedHash:job.unsignedHash,expectedCertificateFingerprint:started.receipt.certificate_fingerprint,now:clock});
     leaseCheck();callbackDone=true;return undefined;
    }finally{disposeSigner(signer);}
   };
   try{const returned=await s.bounded(()=>withAuthorizedSigner(grant,callback,{signal:s.signal,deadline:s.deadline}));need(!callbackInvalid,'SIGNED_CUSTODY_CALLBACK_INVALID');need(returned===undefined&&callbackInvoked&&callbackDone&&candidate,'SIGNED_CUSTODY_NOT_COMPLETED');}finally{callbackClosed=true;}
   const cs=['signedXml','xmlDigest','signedContentDigest','referenceDigest','certificateFingerprint','model','sizeBytes','signatureVerified','qrProfile','xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canEmit','canTransmit'];
   need(exact(candidate,cs)&&typeof candidate.signedXml==='string'&&candidate.xmlDigest===hash(candidate.signedXml)&&digest(candidate.signedContentDigest)&&candidate.certificateFingerprint===started.receipt.certificate_fingerprint&&candidate.model===started.receipt.model&&candidate.signatureVerified===true
    &&candidate.sizeBytes===Buffer.byteLength(candidate.signedXml)&&candidate.sizeBytes>0&&candidate.sizeBytes<=MAX_SIGNED&&candidate.qrProfile===(candidate.model==='65'?PROFILE.nfce_qr_profile:null)
    &&['xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canEmit','canTransmit'].every(k=>candidate[k]===false),'SIGNED_SIGNATURE_RESPONSE_INVALID');
   signedBytes=Buffer.from(candidate.signedXml,'utf8');const expected={hash:candidate.xmlDigest,size:signedBytes.length,model:candidate.model};
   phase='xsd';const xsd=await s.bounded(()=>validateXsd(signedBytes,{expectedModel:expected.model,expectedHash:expected.hash,signal:s.signal,deadline:s.deadline}));leaseCheck();need(hash(signedBytes)===expected.hash,'SIGNED_BYTES_CHANGED');schemaReport(xsd,expected);
   const evidence=copy({signature:{xml_hash:expected.hash,certificate_fingerprint:candidate.certificateFingerprint,signed_content_hash:candidate.signedContentDigest,reference_digest:candidate.referenceDigest,profile:PROFILE.signature_profile},xsd:{xml_hash:xsd.xmlDigest,schema_profile:xsd.schemaProfile,manifest_hash:xsd.schemaManifestHash,validator_version:xsd.validatorVersion,validator_hash:xsd.validatorHash},qr:{profile:candidate.qrProfile,verified:candidate.model==='65'}});
   checkedEvidence(evidence,started.receipt,expected.hash);builtProof={receipt:started.receipt,hash:expected.hash,size:expected.size,evidence};const key=`candidates/${started.receipt.candidate_id}/${expected.hash}.xml`;
   phase='storage';const existing=await read(key,expected,MAX_SIGNED);
   if(existing)existing.fill(0);else{
    leaseCheck();need(++storageOperations<=5,'SIGNED_STORAGE_LIMIT');
    try{const ack=await s.bounded(()=>storage.putImmutable({bucket:BUCKET,key,bytes:signedBytes,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));need(plain(ack)&&[200,201,409].includes(ack.status),'SIGNED_STORAGE_ACK_INVALID');}catch{leaseCheck();}
    const verified=await read(key,expected,MAX_SIGNED);need(verified,'SIGNED_STORAGE_MISSING');verified.fill(0);
   }
   leaseCheck();phase='finish';finishSent=true;const done=view(await invoke('finish',{p_candidate_id:started.receipt.candidate_id,p_lease_id:claimed.execution.lease_id,p_signed_hash:expected.hash,p_size_bytes:expected.size,p_evidence:evidence}),job,started.receipt);
   need(done.current.state==='stored'&&done.artifact.signed_hash===expected.hash&&done.artifact.size_bytes===expected.size&&equal(done.artifact.evidence,evidence),'SIGNED_FINISH_INVALID');
   phase='readback';const latest=view(await invoke('get',{p_candidate_id:started.receipt.candidate_id}),job,started.receipt);
   need(latest.current.state==='stored'&&latest.artifact.signed_hash===expected.hash&&latest.artifact.size_bytes===expected.size&&equal(latest.artifact.evidence,evidence),'SIGNED_FINISH_INVALID');
   return project(latest,job,{recovered:Boolean(prior),storage_operations:storageOperations});
  }catch(error){
   callbackClosed=true;const code=safe(error);
   // Only a successful bounded validator rejection or locally parsed invalid XML is deterministic.
   const deterministic=phase==='xsd'&&error instanceof SignedFiscalError&&error.code==='SIGNED_XSD_REJECTED'?'XSD_INVALID':phase==='inspect'&&error instanceof FiscalXmlError?'XML_INPUT_INVALID':null;
   if(claimed&&deterministic&&!s.signal.aborted){try{leaseCheck();const failed=view(await invoke('fail',{p_candidate_id:claimed.receipt.candidate_id,p_lease_id:claimed.execution.lease_id,p_error_code:deterministic}),job,claimed.receipt);need(failed.current.state==='failed'&&failed.error_code===deterministic,'SIGNED_FAILURE_INVALID');return project(failed,job,{code,storage_operations:storageOperations});}catch{/* A missing failure ACK never permits a new command. */}}
   if(finishSent&&!s.signal.aborted){try{const known=view(await invoke('command',{p_command_id:job.commandId}),job,builtProof?.receipt);need(builtProof&&known.current.state==='stored'&&known.artifact.signed_hash===builtProof.hash&&known.artifact.size_bytes===builtProof.size&&equal(known.artifact.evidence,builtProof.evidence),'SIGNED_FINISH_INVALID');return project(known,job,{recovered:true,storage_operations:storageOperations});}catch{/* Next invocation reads the same command. */}}
   // Failure to read a pre-existing command is not proof that an earlier invocation did not commit.
   const unconfirmed=priorKnown||beginSent||phase==='recover';return {...FLAGS,status:unconfirmed?'recoverable':'blocked',command_id:job.commandId,code,phase,signed:unconfirmed?null:false,signature_verified:false,xsd_validated:false,outcome:unconfirmed?'unconfirmed':'not_started',storage_operations:storageOperations};
  }finally{callbackClosed=true;xml=null;sourceBytes?.fill(0);signedBytes?.fill(0);s.close();running.delete(job.commandId);}
 }});
}
