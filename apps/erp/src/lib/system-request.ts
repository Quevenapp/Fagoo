import type {NativeRequestOptions} from './real-access';
import {BUSINESS_BASE,BUSINESS_MAX_BYTES,BUSINESS_PANELS,captureBusinessQuery,captureGoalsQuery,captureGoalSave,businessUuid} from '../../../../packages/erp-domain/src/business-dashboards.mjs';
import {SYSTEM_BASE,captureNotificationsQuery,captureNotificationsRead,captureCompanyExtraSave,captureHomeChartsSave,captureTopProductsQuery,captureCompanyPartnersSave,systemUuid} from '../../../../packages/erp-domain/src/system-profile.mjs';
import {captureReportRun,captureReportSave,captureFrameworkDelete,captureLabelSave,captureLabelRecordsQuery,captureLabelInvoiceQuery} from '../../../../packages/erp-domain/src/reports-labels.mjs';
import {captureSituationsQuery,captureSituationSave,captureTransitionSave,captureTransitionsDelete} from '../../../../packages/erp-domain/src/system-frameworks.mjs';
import {IMPORT_BASE,IMPORT_SLUGS,importKindOf,importUuid,captureImportBatch,captureJobsQuery,captureJobQuery} from '../../../../packages/erp-domain/src/spreadsheet-import.mjs';

/**
 * Capture of the wave B Preferências and Sistema routes (one controller port, `system`): path, body and signal are fixed
 * synchronously before any credential refresh, with the same rules as the Worker. Roles are checked again by the server.
 * Each base registers one capture below.
 */
export const SYSTEM_RESPONSE_BYTES=BUSINESS_MAX_BYTES;
type Method='GET'|'POST';
type Captured={base:string;path:string;options:Readonly<{method:Method;body?:unknown;signal?:AbortSignal}>};
const invalid=():never=>{throw Error('SYSTEM_REQUEST_INVALID');};
const single=(search:string)=>{const p=new URLSearchParams(search),out:Record<string,string>={};for(const k of p.keys()){if(p.getAll(k).length!==1)invalid();out[k]=p.get(k)!;}return out;};
type Handler={base:string;capture:(rest:string,search:string,method:Method,body:unknown)=>unknown};
// POST sub-routes of /v1/sistema and the contract that fixes each body (148 and 151).
const POSTS:Record<string,(body:unknown)=>unknown>={'notificacoes/lidas':captureNotificationsRead,'empresa-dados':captureCompanyExtraSave,'graficos-inicio':captureHomeChartsSave,'empresa-socios':captureCompanyPartnersSave,situacoes:captureSituationSave,transicoes:captureTransitionSave,
 'transicoes/exclusao':captureTransitionsDelete,
 'relatorios/execucao':captureReportRun,relatorios:captureReportSave,'relatorios/exclusao':captureFrameworkDelete,etiquetas:captureLabelSave,'etiquetas/exclusao':captureFrameworkDelete};
const HANDLERS:Handler[]=[
 // 228: Importações de Dados (POST <tipo>/lote) and Consultar gestão de ações (GET root and GET <job>). Contatos rows are checked by the
 // contatos lane validator in the Worker; here only their shape.
 {base:IMPORT_BASE,capture(rest,search,method,body){
  const batch=new RegExp(`^(${Object.values(IMPORT_SLUGS).join('|')})/lote$`).exec(rest);
  if(batch){if(method!=='POST'||search)invalid();const{kind:_kind,...sent}=captureImportBatch(importKindOf(batch[1]!)!,body,{validateContact:data=>data});return Object.freeze(sent);}
  if(method!=='GET'||body!==undefined||!importUuid(rest))invalid();
  const q=single(search);captureJobQuery(rest,{erros:q.erros??null,limit:q.limit?Number(q.limit):100,offset:q.offset?Number(q.offset):0});
  if(Object.keys(q).some(k=>!['erros','limit','offset'].includes(k)))invalid();return undefined;}},
 {base:BUSINESS_BASE,capture(rest,search,method,body){
  if(rest.startsWith('metas/comandos/')){if(method!=='GET'||body!==undefined||search||!businessUuid(rest.slice(15)))invalid();return undefined;}
  if(rest==='metas'){if(method==='GET'){if(body!==undefined)invalid();captureGoalsQuery(single(search));return undefined;}if(search)invalid();return captureGoalSave(body);}
  if(method!=='GET'||body!==undefined||!(BUSINESS_PANELS as readonly string[]).includes(rest))invalid();captureBusinessQuery(rest,single(search));return undefined;}},
 {base:SYSTEM_BASE,capture(rest,search,method,body){
  if(method==='POST'){if(search)invalid();return Object.hasOwn(POSTS,rest)?POSTS[rest]!(body):invalid();}
  if(body!==undefined)invalid();
  if(rest==='notificacoes'){captureNotificationsQuery(single(search));return undefined;}
  if(rest==='situacoes'){captureSituationsQuery(single(search));return undefined;}
  if(rest==='etiquetas/registros'){captureLabelRecordsQuery(single(search));return undefined;}
  if(rest==='etiquetas/nota'){captureLabelInvoiceQuery(single(search));return undefined;}
  if(rest==='top-produtos'){captureTopProductsQuery(single(search));return undefined;}
  if(search)invalid();
  const security=/^usuarios\/([a-f0-9-]{36})\/seguranca$/.exec(rest);
  if(['perfil','armazenamento','empresa-dados','relatorios','etiquetas','validade','graficos-inicio','empresa-socios','permissoes'].includes(rest)||security&&systemUuid(security[1]))return undefined;
  return invalid();}},
];
export function captureSystemPortRequest(path:string,input:NativeRequestOptions={}):Captured{
 if(typeof path!=='string'||path.length>2048||path.includes('#')||!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return invalid();
 const d=Object.getOwnPropertyDescriptors(input);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['method','body','signal'].includes(k)||!d[k].enumerable||!Object.hasOwn(d[k],'value')))return invalid();
 const method=(d.method?.value??'GET') as Method,signal=d.signal?.value,body=d.body?.value;
 if(!['GET','POST'].includes(method)||signal!==undefined&&!(signal instanceof AbortSignal)||method==='POST'&&body===undefined)return invalid();
 const [pathname,search='',...extra]=path.split('?');if(extra.length)return invalid();
 if(pathname===IMPORT_BASE){if(method!=='GET'||body!==undefined)return invalid();const q=single(search);if(Object.keys(q).some(k=>!['situacao','limit','offset'].includes(k)))return invalid();
  try{captureJobsQuery({situacao:q.situacao??null,limit:q.limit?Number(q.limit):25,offset:q.offset?Number(q.offset):0});}catch{return invalid();}
  return Object.freeze({base:IMPORT_BASE,path,options:Object.freeze({method,...(signal?{signal:signal as AbortSignal}:{})})});}
 const handler=HANDLERS.find(h=>pathname.startsWith(`${h.base}/`));if(!handler)return invalid();
 let captured:unknown;try{captured=handler.capture(pathname.slice(handler.base.length+1),search,method,body);}catch{return invalid();}
 return Object.freeze({base:handler.base,path,options:Object.freeze({method,...(captured!==undefined?{body:captured}:{}),...(signal?{signal:signal as AbortSignal}:{})})});
}
