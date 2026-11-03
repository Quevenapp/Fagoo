/** Authorizes opening only an existing operational preparation; this never consumes its grant. */
import {need,fields,id,context,preparation,same,projectResponse,ReconciliationError} from './dto.mjs';
export function createProtocolPreparationAuthorizer(config){
 need(fields(config,['rpc'])&&typeof config.rpc==='function','RECONCILIATION_PORTS_REQUIRED');const rpc=config.rpc;
 return async function authorizePreparation(input,options){
  need(fields(input,['actor','execution','context'])&&id(input.actor),'RECONCILIATION_INPUT_INVALID');const actor=input.actor,e=preparation(input.execution),c=context(input.context);
  need(e.context.actor===actor&&same({...c,request_hash:null,request_size:null},e.context)&&c.request_hash!==null,'RECONCILIATION_PREPARATION_CHANGED');
  need(fields(options,['signal','deadline'])&&options.signal instanceof AbortSignal&&Number.isSafeInteger(options.deadline)&&options.deadline>Date.now()&&options.deadline<=Date.now()+20000,'RECONCILIATION_OPTIONS_INVALID');
  const signal=options.signal,deadline=options.deadline,controller=new AbortController();let timer,onAbort,rejectStop;
  const stopped=new Promise((_,r)=>{rejectStop=r;});stopped.catch(()=>{});
  const stop=code=>{controller.abort();rejectStop(new ReconciliationError(code));};onAbort=()=>stop('RECONCILIATION_ABORTED');signal.addEventListener('abort',onAbort,{once:true});
  const check=()=>{need(!signal.aborted&&!controller.signal.aborted,'RECONCILIATION_ABORTED');need(Date.now()<deadline,'RECONCILIATION_TIMEOUT');};
  const args={p_user_id:actor,p_command_id:c.command_id,p_candidate_id:c.candidate_id,p_signed_hash:c.signed_hash,p_expected_identity_version:c.identity_version,p_expected_a1_version:c.a1_version,p_confirmed:true};
  try{check();timer=setTimeout(()=>stop('RECONCILIATION_TIMEOUT'),Math.max(1,deadline-Date.now()));const task=Promise.resolve().then(()=>{check();return rpc('erp_fiscal_protocol_begin',args,{signal:controller.signal,deadline});});const raw=await Promise.race([task,stopped]);check();const v=projectResponse('erp_fiscal_protocol_begin',raw,args);need(v.replayed===true&&v.current.state==='prepared'&&v.execution!==null&&same(v.execution,e),'RECONCILIATION_PREPARATION_CHANGED');return v.execution;}
  finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);controller.abort();}
 };
}
