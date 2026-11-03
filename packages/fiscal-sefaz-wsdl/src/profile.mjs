import {createHash} from 'node:crypto';

export const WSDL_LIMITS=Object.freeze({body_bytes:512000,header_bytes:16384,nodes:12000,depth:64,attributes:40,timeout_ms:20000,max_timeout_ms:30000});
export const WSDL_FLAGS=Object.freeze({binding_verified:false,operation_authorized:false,can_query:false,can_emit:false,can_transmit:false,sefaz_authorized:false});
export class WsdlEvidenceError extends Error {constructor(code){super(code);this.name='WsdlEvidenceError';this.code=code;this.retry_automatically=false;}}
export const need=(value,code)=>{if(!value)throw new WsdlEvidenceError(code);};
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function fields(value,keys,required=keys){
 try{
 need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'WSDL_INPUT_INVALID');
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 need(own.every(k=>typeof k==='string'&&keys.includes(k)&&Object.hasOwn(descriptors[k],'value'))&&required.every(k=>Object.hasOwn(descriptors,k)),'WSDL_INPUT_INVALID');
 return Object.fromEntries(own.map(k=>[k,descriptors[k].value]));
 }catch(e){throw e instanceof WsdlEvidenceError?e:new WsdlEvidenceError('WSDL_INPUT_INVALID');}
}
const services=Object.freeze({protocol:['nfeconsultaprotocolo4','NFeConsultaProtocolo4'],status:['nfestatusservico4','NFeStatusServico4'],authorization:['nfeautorizacao4','NFeAutorizacao4'],receipt:['nferetautorizacao4','NFeRetAutorizacao4']});
const plans=new WeakSet();
/** Service URLs are official. ?WSDL is a retrieval target, not evidence of a verified binding. */
export function prepareWsdlRequest(input){
 const v=fields(input,['model','operation','requestId']);
 need(['55','65'].includes(v.model)&&typeof v.operation==='string'&&Object.hasOwn(services,v.operation)&&typeof v.requestId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v.requestId),'WSDL_INPUT_INVALID');
 const hostname=v.model==='55'?'homologacao.nfe.fazenda.sp.gov.br':'homologacao.nfce.fazenda.sp.gov.br';
 const path=`/ws/${services[v.operation][v.model==='55'?0:1]}.asmx`,endpoint=`https://${hostname}${path}`;
 const plan=Object.freeze({profile:'sp-homologation-wsdl-evidence-v1',purpose:'sefaz-sp-wsdl-readonly-v1',environment:'2',model:v.model,operation:v.operation,request_id:v.requestId,method:'GET',hostname,endpoint,url:`${endpoint}?WSDL`,path:`${path}?WSDL`,...WSDL_FLAGS});
 plans.add(plan);return plan;
}
export const requirePlan=plan=>need(plans.has(plan),'WSDL_PLAN_UNATTESTED');
export function scope(options={}){
 const v=fields(options,['signal','deadline'],[]),signal=v.signal,deadline=v.deadline??Date.now()+WSDL_LIMITS.timeout_ms;
 need(signal===undefined||signal instanceof AbortSignal,'WSDL_SIGNAL_INVALID');
 need(Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+WSDL_LIMITS.max_timeout_ms,'WSDL_DEADLINE_INVALID');
 const controller=new AbortController();let reason='WSDL_TIMEOUT';
 const abort=()=>{reason='WSDL_ABORTED';controller.abort();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
 return{signal:controller.signal,deadline,check(){need(!controller.signal.aborted,reason);need(Date.now()<deadline,'WSDL_TIMEOUT');},close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}};
}
