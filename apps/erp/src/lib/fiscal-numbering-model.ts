import type {NativeRequestOptions} from './real-access';
import {normalizeCnpj} from '../../../../packages/erp-domain/src/company.mjs';

export const NUMBERING_BASE='/v1/numeracao-fiscal';
export const NUMBERING_MODELS={'55':'NF-e · modelo 55','65':'NFC-e · modelo 65'} as const;
export type NumberingModel=keyof typeof NUMBERING_MODELS;
export interface FiscalNumberingController {fiscalNumbering:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;company:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
export interface NumberingCompany {version:number;legal_name:string;cnpj:string;state:string;}
export interface NumberingSeries {id:string;issuer_cnpj:string;cuf:'35';model:NumberingModel;environment:'2';series:string;first_number:string;next_number:string|null;exhausted:boolean;version:number;identity_version:number;enabled:boolean;exclusive_use_confirmed:boolean;reference:string;created_at:string;updated_at:string;company_changed:boolean;}
export interface NumberingPage {items:NumberingSeries[];limit:number;has_more:boolean;next_cursor:string|null;}
export interface NumberingForm {model:''|NumberingModel;series:string;initial_number:string;enabled:''|'enabled'|'disabled';exclusive_use_confirmed:boolean;reference:string;}
export interface NumberingConfigBody {command_id:string;id:string|null;expected_version:number;expected_identity_version:number;model:NumberingModel;environment:'2';series:string;initial_number:string;enabled:boolean;exclusive_use_confirmed:boolean;reference:string;}
const FLAGS={data_mode:'fiscal_numbering',policy:'brufap-homologation-exclusive-v1',environment:'2',can_emit:false,can_transmit:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const version=(v:unknown):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=2147483647;
const series=(v:unknown):v is string=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,2})$/.test(v)&&BigInt(v)<=889n;
const number=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,8}$/.test(v);
const reference=(v:unknown):v is string=>typeof v==='string'&&Array.from(v).length>=3&&Array.from(v).length<=240&&Boolean(v.trim())&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
const isValidCnpj=(v:string)=>{try{return normalizeCnpj(v)===v;}catch{return false;}};
function fail():never {throw new Error('Não foi possível conferir os dados da numeração fiscal.');}
function stamp(v:unknown):v is string {if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;const[y,m,d,h,n,s]=v.slice(0,19).split(/[-T:]/).map(Number),offset=v.endsWith('Z')?[0,0]:v.slice(-5).split(':').map(Number);return y>=2000&&m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<=23&&n<=59&&s<=59&&offset[0]<=14&&offset[1]<=59&&(offset[0]!==14||offset[1]===0)&&Number.isFinite(Date.parse(v));}
function flags(v:unknown):Record<string,unknown>{if(!object(v)||Object.entries(FLAGS).some(([k,value])=>v[k]!==value))fail();return v;}
export function numberingCompany(v:unknown):NumberingCompany|null {if(!object(v)||v.section!=='identity'||v.data_mode!=='erp_native'||v.emission_enabled!==false)fail();if(v.record===null)return null;const r=v.record;if(!object(r)||!version(r.version)||!object(r.data)||typeof r.data.legal_name!=='string'||!r.data.legal_name.trim()||Array.from(r.data.legal_name).length>200||typeof r.data.cnpj!=='string'||!isValidCnpj(r.data.cnpj)||typeof r.data.state!=='string'||!/^[A-Z]{2}$/.test(r.data.state))fail();return{version:r.version,legal_name:r.data.legal_name,cnpj:r.data.cnpj,state:r.data.state};}
export function numberingSeries(v:unknown):NumberingSeries {
 if(!object(v)||!uuid(v.id)||typeof v.issuer_cnpj!=='string'||!isValidCnpj(v.issuer_cnpj)||v.cuf!=='35'||typeof v.model!=='string'||!Object.hasOwn(NUMBERING_MODELS,v.model)||v.environment!=='2'||!series(v.series)||!number(v.first_number)||!(v.next_number===null||number(v.next_number))||typeof v.exhausted!=='boolean'||v.exhausted!==(v.next_number===null)||v.next_number!==null&&BigInt(v.next_number)<BigInt(v.first_number)||!version(v.version)||!version(v.identity_version)||typeof v.enabled!=='boolean'||typeof v.exclusive_use_confirmed!=='boolean'||v.enabled&&!v.exclusive_use_confirmed||!reference(v.reference)||!stamp(v.created_at)||!stamp(v.updated_at)||Date.parse(v.updated_at)<Date.parse(v.created_at)||typeof v.company_changed!=='boolean')fail();
 const progress=(v.next_number===null?1000000000n:BigInt(v.next_number))-BigInt(v.first_number);if(progress>BigInt(v.version-1))fail();
 return{id:v.id,issuer_cnpj:v.issuer_cnpj,cuf:'35',model:v.model as NumberingModel,environment:'2',series:v.series,first_number:v.first_number,next_number:v.next_number,exhausted:v.exhausted,version:v.version,identity_version:v.identity_version,enabled:v.enabled,exclusive_use_confirmed:v.exclusive_use_confirmed,reference:v.reference,created_at:v.created_at,updated_at:v.updated_at,company_changed:v.company_changed};
}
export function numberingMatchesCompany(row:NumberingSeries,company:NumberingCompany|null){if(!company||row.issuer_cnpj!==company.cnpj||company.state!=='SP'||row.company_changed!==(row.identity_version!==company.version))fail();}
export function numberingPage(v:unknown,model:''|NumberingModel='',after:string|null=null,limit=25):NumberingPage {
 const value=flags(v);if(value.read_only!==true||value.limit!==limit||!Array.isArray(value.items)||value.items.length>limit||typeof value.has_more!=='boolean'||value.has_more&&value.items.length!==limit)fail();
 const items=value.items.map(numberingSeries);let previous=after,issuer:string|null=null;for(const row of items){if(previous!==null&&row.id<=previous||model&&row.model!==model||issuer!==null&&row.issuer_cnpj!==issuer)fail();previous=row.id;issuer=row.issuer_cnpj;}
 const next=value.has_more?previous:null;if(value.next_cursor!==next)fail();return{items,limit,has_more:value.has_more,next_cursor:next};
}
export function numberingListPath(model:''|NumberingModel='',after:string|null=null,limit=25){if(model&&!Object.hasOwn(NUMBERING_MODELS,model)||after!==null&&!uuid(after)||!Number.isInteger(limit)||limit<1||limit>25)fail();const q=new URLSearchParams({limit:String(limit)});if(model)q.set('model',model);if(after)q.set('after',after);return`${NUMBERING_BASE}/series?${q}`;}
export function numberingLookup(id:string,model:NumberingModel){if(!uuid(id)||!Object.hasOwn(NUMBERING_MODELS,model))fail();const previous=BigInt('0x'+id.replaceAll('-',''))-1n,hex=previous.toString(16).padStart(32,'0');const after=previous<0n?null:`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;return{path:numberingListPath(model,after,1),after};}
export function numberingInitialForm(current:NumberingSeries|null):NumberingForm {return{model:current?.model??'',series:current?.series??'',initial_number:current?.first_number??'',enabled:current?(current.enabled?'enabled':'disabled'):'',exclusive_use_confirmed:false,reference:''};}
export function numberingConfigBody(form:NumberingForm,current:NumberingSeries|null,company:NumberingCompany|null,commandId:string):NumberingConfigBody {
 if(!company)throw new Error('Cadastre os dados da empresa antes de configurar uma série.');if(company.state!=='SP')throw new Error('Esta preparação está disponível apenas para empresa de São Paulo.');
 if(current){numberingMatchesCompany(current,company);if(current.version===2147483647)throw new Error('Esta série precisa de revisão administrativa.');}
 if(!uuid(commandId)||!Object.hasOwn(NUMBERING_MODELS,form.model))throw new Error('Escolha NF-e ou NFC-e.');
 if(!series(form.series))throw new Error('Informe a série de 0 a 889, sem espaços ou zeros à esquerda.');
 if(!number(form.initial_number))throw new Error('Informe o primeiro número de 1 a 999999999, sem espaços ou zeros à esquerda.');
 if(current&&(current.model!==form.model||current.series!==form.series||current.first_number!==form.initial_number))throw new Error('O modelo, a série e o primeiro número não podem ser alterados.');
 if(!['enabled','disabled'].includes(form.enabled))throw new Error('Escolha se esta série ficará habilitada ou desativada.');
 if(typeof form.exclusive_use_confirmed!=='boolean'||form.enabled==='enabled'&&!form.exclusive_use_confirmed)throw new Error('Confirme o uso exclusivo desta série em homologação antes de habilitá-la.');
 if(!reference(form.reference))throw new Error('Registre uma referência legível de 3 a 240 caracteres, sem quebras de linha.');
 return{command_id:commandId,id:current?.id??null,expected_version:current?.version??0,expected_identity_version:company.version,model:form.model as NumberingModel,environment:'2',series:form.series,initial_number:form.initial_number,enabled:form.enabled==='enabled',exclusive_use_confirmed:form.exclusive_use_confirmed,reference:form.reference};
}
export function numberingConfigCommand(v:unknown,commandId:string,body:NumberingConfigBody){
 const value=flags(v);if(value.command_id!==commandId||value.action!=='configure'||typeof value.replayed!=='boolean'||value.current_basis!==null)fail();const receipt=numberingSeries(value.receipt),current=numberingSeries(value.current_series);
 for(const k of ['id','issuer_cnpj','cuf','model','environment','series','first_number','created_at']as const)if(receipt[k]!==current[k])fail();
 const a=receipt.next_number===null?1000000000n:BigInt(receipt.next_number),b=current.next_number===null?1000000000n:BigInt(current.next_number);
 if(current.version<receipt.version||current.identity_version<receipt.identity_version||b<a||b-a>BigInt(current.version-receipt.version))fail();
 if(current.version===receipt.version)for(const k of ['next_number','exhausted','identity_version','enabled','exclusive_use_confirmed','reference','updated_at']as const)if(receipt[k]!==current[k])fail();
 if(body.command_id!==commandId||body.id!==null&&receipt.id!==body.id||receipt.version!==body.expected_version+1||receipt.identity_version!==body.expected_identity_version||receipt.model!==body.model||receipt.environment!==body.environment||receipt.series!==body.series||receipt.first_number!==body.initial_number||receipt.enabled!==body.enabled||receipt.exclusive_use_confirmed!==body.exclusive_use_confirmed||receipt.reference!==body.reference||receipt.company_changed||body.id===null&&(receipt.next_number!==body.initial_number||receipt.exhausted))fail();
 return{receipt,current,replayed:value.replayed};
}
