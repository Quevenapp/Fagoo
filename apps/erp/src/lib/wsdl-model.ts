import {publicResult,FLAGS,type WsdlResult} from '../../../../packages/fiscal-wsdl-runtime/src/dto.mjs';
import type {A1Current,A1Company} from './a1-model.ts';
export {FLAGS as WSDL_FLAGS};export type {WsdlResult};
export const WSDL_BASE='/v1/fiscal-wsdl';
export const WSDL_OPERATIONS=Object.freeze({protocol:'Consulta de protocolo',authorization:'Autorização de notas',receipt:'Consulta de recibo'});
export type WsdlOperation=keyof typeof WSDL_OPERATIONS;
export const isWsdlOperation=(value:unknown):value is WsdlOperation=>typeof value==='string'&&Object.hasOwn(WSDL_OPERATIONS,value);
export interface WsdlRun {readonly command_id:string;readonly model:'55'|'65';readonly operation:WsdlOperation;readonly expected_a1_version:number;readonly expected_identity_version:number;readonly confirmed:true;}
export const wsdlId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=2147483647;
export function wsdlShape(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>{
 return v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))
  &&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...required,...optional].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value')&&Object.getOwnPropertyDescriptor(v,k)!.enumerable)
  &&required.every(k=>Object.hasOwn(v,k));
}
function fail():never{throw new Error('Não foi possível conferir o resultado desta verificação. Consulte novamente.');}
function frozen<T>(v:T):T{if(v!==null&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
export function validWsdlRun(v:unknown):v is WsdlRun{return wsdlShape(v,['command_id','model','operation','expected_a1_version','expected_identity_version','confirmed'])&&wsdlId(v.command_id)&&typeof v.model==='string'&&['55','65'].includes(v.model)&&isWsdlOperation(v.operation)&&integer(v.expected_a1_version)&&integer(v.expected_identity_version)&&v.confirmed===true;}
export function wsdlReady(a1:A1Current|null,company:A1Company|null):boolean{return Boolean(a1&&company&&a1.state==='configured_offline'&&a1.time_valid_now&&!a1.company_changed&&integer(a1.version)&&a1.company_identity_version===company.version&&a1.metadata?.holder_cnpj===company.cnpj);}
export function wsdlRun(model:string,operation:string,a1:A1Current|null,company:A1Company|null,confirmed:boolean,commandId:string):WsdlRun {
 if(!['55','65'].includes(model)||!isWsdlOperation(operation)||!wsdlId(commandId)||!confirmed||!wsdlReady(a1,company))throw new Error('Confira a empresa, o certificado, o tipo de nota e o serviço antes de confirmar.');
 return Object.freeze({command_id:commandId,model:model as '55'|'65',operation,expected_a1_version:a1!.version,expected_identity_version:company!.version,confirmed:true});
}
export function wsdlResult(raw:unknown,options:{body?:WsdlRun;commandId?:string}):WsdlResult {
 if(!wsdlShape(raw,[...Object.keys(FLAGS),'status','command_id','recovery_required','read_only','recovered','failure_code','receipt','current','error_code','artifact']))fail();
 if(raw.receipt!==null&&!wsdlShape(raw.receipt,['attempt_id','command_id','profile','model','operation','environment','a1_version','identity_version','confirmed','created_at']))fail();
 if(raw.current!==null&&!wsdlShape(raw.current,['state','a1_version','identity_version','a1_changed','company_changed','certificate_time_valid_now','grant_consumed','lease_expired','expires_at','used_at','finished_at','recovery_required','retry_get_allowed']))fail();
 if(raw.artifact!==null&&!wsdlShape(raw.artifact,['sha256','size_bytes','inspection_status','inspection_code','created_at']))fail();
 try{return frozen(publicResult(raw,options.body?{action:'run',payload:options.body,commandId:options.commandId}:{action:'command',commandId:options.commandId}));}catch{return fail();}
}
/** Lookup is a read of the same confirmed intention, not a new authorization to use A1. */
export function bindWsdlResult(value:WsdlResult,body:WsdlRun,previous:WsdlResult|null=null):WsdlResult {
 const r=value.receipt;if(value.command_id!==body.command_id||r&&(r.model!==body.model||r.operation!==body.operation||r.a1_version!==body.expected_a1_version||r.identity_version!==body.expected_identity_version))fail();
 if(previous?.receipt){if(!r||Object.entries(previous.receipt).some(([k,v])=>r[k as keyof typeof r]!==v))fail();}
 if(previous?.artifact){if(!value.artifact||Object.entries(previous.artifact).some(([k,v])=>value.artifact![k as keyof NonNullable<WsdlResult['artifact']>]!==v))fail();}
 return value;
}
export const WSDL_STATE_LABELS:Record<WsdlResult['status'],string>={prepared:'Verificação preparada',dispatched:'Resultado ainda não confirmado',stored:'Consulta obtida',failed:'Verificação não concluída',uncertain:'Resultado ainda não confirmado',unconfirmed:'Resultado ainda não confirmado'};
