/** Private shared reads for064. No mutation, credential loader, binding or transport. */
import {pinnedCandidateCertificate} from './pinned-certificate.mjs';
import {need,data,id,sha,integer,freeze,scope,readBody,cancel} from './service-common.mjs';
import {FLAGS,projectResponse,result,same} from './service-dto.mjs';
const PREFIX='erp_fiscal_authorization_',BUCKET='fagoo-fiscal-artifacts';
export function createAuthorizationReadPorts(rpcPort,readPort){
 const rpc=async(name,args,s)=>{const value=await s.bounded(()=>rpcPort(name,args,{signal:s.signal,deadline:s.deadline}));s.check();return projectResponse(name,value,args);};
 async function read(key,s,expected={}){let response;try{const pending=Promise.resolve().then(()=>{s.check();return readPort({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}if(response===null)return null;return await readBody(response,s,expected);}finally{cancel(response?.body);}}
 return Object.freeze({rpc,read});
}
export function createAuthorizationReadOperations({rpc,read,serviceEnabled}){
 async function query(action,input,options={}){
  need(['command','history'].includes(action));const keys=action==='history'?['actor','candidateId','limit','before']:['actor','commandId'],x=data(input,keys);need(id(x.actor)&&id(action==='history'?x.candidateId:x.commandId));if(action==='history')need(integer(x.limit,25)&&(x.before===null||typeof x.before==='string'&&/^[1-9]\d{0,14}$/.test(x.before)));const s=scope(options);
  try{return await rpc(PREFIX+action,action==='history'?{p_user_id:x.actor,p_candidate_id:x.candidateId,p_limit:x.limit,p_before:x.before}:{p_user_id:x.actor,p_command_id:x.commandId},s);}finally{s.close();}
 }
 return Object.freeze({query,
  async command(input,options={}){return result(await query('command',input,options),{readOnly:true});},
  async history(input,options={}){const v=await query('history',input,options);return freeze({...FLAGS,read_only:true,candidate_id:v.candidate_id,items:v.items.map(x=>result(x,{readOnly:true})),limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor});},
  async preview(input,options={}){
   const x=data(input,['actor','candidateId','signedHash']);need(id(x.actor)&&id(x.candidateId)&&sha(x.signedHash));const s=scope(options);let bytes;
   try{
    const args={p_user_id:x.actor,p_candidate_id:x.candidateId},before=await rpc('erp_fiscal_signed_get',args,s);need(before.current.state==='stored'&&before.artifact.signed_hash===x.signedHash,'AUTHORIZATION_SOURCE_INVALID');
    bytes=await read(`candidates/${x.candidateId}/${x.signedHash}.xml`,s,{expectedHash:x.signedHash,expectedSize:before.artifact.size_bytes});need(bytes!==null,'AUTHORIZATION_SOURCE_INVALID');
    const proof=pinnedCandidateCertificate({signedBytes:bytes,signedHash:x.signedHash,signedSize:before.artifact.size_bytes,certificateFingerprint:before.receipt.certificate_fingerprint,model:before.receipt.model,now:new Date(before.artifact.created_at)});need(proof.referenceDigest===before.artifact.evidence.signature.reference_digest,'AUTHORIZATION_SOURCE_INVALID');
    const after=await rpc('erp_fiscal_signed_get',args,s);need(same(after.receipt,before.receipt)&&same(after.artifact,before.artifact),'AUTHORIZATION_SOURCE_INVALID');const v=await rpc(PREFIX+'preview',{...args,p_signed_hash:x.signedHash},s);
    return freeze({...v,can_prepare:false,signature_checked:true,certificate_pin_checked:true,operational_binding_available:false,service_enabled:serviceEnabled});
   }finally{bytes?.fill(0);s.close();}
  },
 });
}
