// QA_SYNTHETIC_SYSTEM — synthetic local port for /v1/sistema (Meu perfil, Armazenamento, Notificações, Dados da empresa,
// segurança dos usuários) and the Interface preference, no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureSystemPortRequest} from '../lib/system-request.ts';
import {capturePreferencesRequest} from '../lib/preferences-request.ts';
import {normalizeCompanyExtra,type CompanyExtraData,type CompanyExtraSaveInput,type NotificationItem,type NotificationsReadInput} from '../../../../packages/erp-domain/src/system-profile.mjs';
export const SYSTEM_QA_ACTOR='10000000-0000-4000-8000-000000000151';
const STAMP='2026-10-20T12:00:00.000000+00:00';
export type SystemQaCall={path:string;method:string;body?:unknown};
export function createSystemFixture({role='admin',before,lostAck=false,theme=null,extra=null}:{role?:AccessRole;before?:(call:SystemQaCall)=>unknown|Promise<unknown>;lostAck?:boolean;theme?:boolean|null;extra?:CompanyExtraData|null}={}){
 let state:AccessState={phase:'ready',membership:{user_id:SYSTEM_QA_ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:SystemQaCall[]=[],commands=new Map<string,unknown>();let lose=lostAck;
 let record=extra?{version:1,data:structuredClone(extra),updated_at:STAMP}:null;
 const items:NotificationItem[]=[{id:'2',type:'contas_receber_atrasadas',day:'2026-10-20',quantity:3,amount:'1500.50',created_at:STAMP,read:false},
  {id:'1',type:'estoque_abaixo_minimo',day:'2026-10-19',quantity:2,amount:null,created_at:'2026-10-19T12:00:00.000000+00:00',read:true}];
 const view=(tab:string)=>({scope:'notifications',data_mode:'erp_native',tab,role:state.membership!.role,business_date:'2026-10-20',unread:items.filter(n=>!n.read).length,items:structuredClone(items.filter(n=>tab==='todas'||!n.read))});
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async system(path:string,options:NativeRequestOptions={}){
   const captured=captureSystemPortRequest(path,options),call={path,method:captured.options.method,body:captured.options.body};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   const [pathname,search='']=path.split('?'),rest=pathname.slice('/v1/sistema/'.length),r=state.membership!.role;
   if(rest==='perfil')return{scope:'access_profile',data_mode:'erp_native',user_id:state.membership!.user_id,role:r,name:'Ana Sintética',email:'ana@sintetico.test',company:{legal_name:'Empresa Sintética Ltda',trade_name:'Sintética'}};
   if(rest==='armazenamento')return{scope:'storage_usage',data_mode:'erp_native',total_bytes:'3145728',objects:3,limit_bytes:null,as_of:STAMP,
    groups:r==='admin'?['anexos','fiscal','cobranca','backup','certificado','outros'].map((group,i)=>({group,bytes:i===0?'1048576':i===1?'2097152':'0',objects:i===0?1:i===1?2:0})):null};
   if(rest==='notificacoes')return view(new URLSearchParams(search).get('aba')??'nao_lidas');
   if(rest==='notificacoes/lidas'){const body=call.body as NotificationsReadInput,known=commands.get(body.command_id);if(known)return{...(known as object),view:view('nao_lidas'),replayed:true};
    let marked=0;for(const n of items)if(!n.read&&(body.ids===null||body.ids.includes(n.id))){n.read=true;marked++;}
    const result={scope:'notifications_command',data_mode:'erp_native',receipt:{command_id:body.command_id,all:body.ids===null,marked,changed_at:STAMP}};commands.set(body.command_id,result);
    if(lose){lose=false;throw new AccessError(503);}return{...result,view:view('nao_lidas'),replayed:false};}
   if(rest==='empresa-dados'&&call.method==='GET')return{scope:'company_extra',data_mode:'erp_native',can_manage:r==='admin',record:structuredClone(record)};
   if(rest==='empresa-dados'){if(r!=='admin')throw new AccessError(403);const body=call.body as CompanyExtraSaveInput,known=commands.get(body.command_id);if(known)return{...(known as object),record:structuredClone(record),replayed:true};
    if((record?.version??0)!==body.expected_version)throw new AccessError(409);record={version:(record?.version??0)+1,data:normalizeCompanyExtra(body.data),updated_at:STAMP};
    const result={scope:'company_extra_command',data_mode:'erp_native',receipt:{command_id:body.command_id,from_version:body.expected_version,to_version:body.expected_version+1,changed_at:STAMP}};commands.set(body.command_id,result);
    if(lose){lose=false;throw new AccessError(503);}return{...result,record:structuredClone(record),replayed:false};}
   const security=/^usuarios\/([a-f0-9-]{36})\/seguranca$/.exec(rest);
   if(security){if(r!=='admin')throw new AccessError(403);return{scope:'access_user_security',data_mode:'erp_native',user_id:security[1],mfa:false,
    sessions:[{last_access:STAMP,created_at:STAMP,ip:'203.0.113.7',device:'Mozilla/5.0 Sintético',aal:'aal1'}],factors:[],challenges:[]};}
   throw new AccessError(404);
  },
  async preferences(path:string,options:NativeRequestOptions={}){const captured=capturePreferencesRequest(path,options);calls.push({path,method:captured.options.method});
   return{scope:'preferences_page',data_mode:'erp_native',page:'sistema-interface',owner:'user',role:state.membership!.role,can_manage:true,
    items:[{key:'sistema.tema_escuro',value:theme??false,version:theme===null?0:1,updated_at:theme===null?null:STAMP}],directory:null};}};
 return{controller,calls,items,get record(){return record;},setAccess(patch:{role?:AccessRole;actor?:string}){state={...state,membership:{...state.membership!,role:patch.role??state.membership!.role,user_id:patch.actor??state.membership!.user_id}};for(const fn of listeners)fn();}};
}
