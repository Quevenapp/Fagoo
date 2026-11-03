// QA_SYNTHETIC_FRAMEWORKS — synthetic local port for /v1/sistema situações and transições (migration 148), with the
// default situações and rules of the document module; no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureSystemPortRequest} from '../lib/system-request.ts';
import {STATES,TRANSITIONS} from '../../../../packages/erp-domain/src/index.mjs';
import type {SituationKind,Situation,Transition,SituationSaveInput,TransitionSaveInput,TransitionsDeleteInput} from '../../../../packages/erp-domain/src/system-frameworks.mjs';
export const FRAMEWORKS_QA_ACTOR='10000000-0000-4000-8000-000000000148';
const STAMP='2026-10-20T12:00:00.000000+00:00';
const COLORS:Record<string,string>={draft:'#9e9e9e',open:'#e6a700',verified:'#7e57c2',in_progress:'#1e88e5',partially_fulfilled:'#26a69a',fulfilled:'#2e7d32',cancelled:'#d32f2f',quoted:'#8d6e63',approved:'#43a047',
 rejected:'#e53935',waiting_parts:'#fb8c00',service_done:'#00897b',finalized:'#2e7d32',no_repair:'#6d4c41'};
export type FrameworksQaCall={path:string;method:string;body?:unknown};
type Stored={active:boolean;actions:string[];version:number};
export function createFrameworksFixture({role='admin',lostAck=false,adopted=false,before}:{role?:AccessRole;lostAck?:boolean;adopted?:boolean;before?:(call:FrameworksQaCall)=>unknown|Promise<unknown>}={}){
 let state:AccessState={phase:'ready',membership:{user_id:FRAMEWORKS_QA_ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:FrameworksQaCall[]=[],commands=new Map<string,unknown>();let lose=lostAck,seq=10,ids=0;
 const custom:Record<SituationKind,Situation[]>={sales_orders:[],purchase_orders:[],service_orders:[]};
 const stored:Record<SituationKind,Map<string,Stored>>={sales_orders:new Map(),purchase_orders:new Map(),service_orders:new Map()};
 const uuid=()=>`40000000-0000-4000-8000-${String(++ids).padStart(12,'0')}`;
 const bases=(kind:SituationKind)=>Object.keys(STATES[kind]);
 const rules=(kind:SituationKind)=>TRANSITIONS[kind] as Readonly<Record<string,readonly string[]>>;
 const situations=(kind:SituationKind):Situation[]=>bases(kind).flatMap(b=>[{key:b,base_status:b,name:STATES[kind][b]!,color:COLORS[b]??'#607d8b',default:true,active:true,version:0},
  ...custom[kind].filter(s=>s.base_status===b)]);
 const allowed=(kind:SituationKind,a:Situation,b:Situation)=>a.key!==b.key&&(a.base_status===b.base_status||rules(kind)[a.base_status]!.includes(b.base_status));
 const page=(kind:SituationKind)=>{const list=situations(kind),transitions:Transition[]=[];
  for(const a of list)for(const b of list){if(!allowed(kind,a,b))continue;const s=stored[kind].get(`${a.key}>${b.key}`),def=a.default&&b.default;if(!def&&!s)continue;
   transitions.push({from:a.key,to:b.key,default:def,active:s?.active??true,actions:[...(s?.actions??[])] as Transition['actions'],version:s?.version??0});}
  return{scope:'situations_page',data_mode:'erp_native',kind,adopted,situations:structuredClone(list),rules:Object.fromEntries(bases(kind).map(b=>[b,bases(kind).filter(t=>rules(kind)[b]!.includes(t))])),transitions};};
 const receipt=(scope:string,command_id:string,action:string,target:string|null,count:number,kind?:SituationKind)=>({scope,data_mode:'erp_native',receipt:{command_id,action,...(kind?{kind}:{}),target,count,changed_at:STAMP}});
 const finish=(id:string,result:object)=>{commands.set(id,result);if(lose){lose=false;throw new AccessError(503);}return{...result,replayed:false};};
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async system(path:string,options:NativeRequestOptions={}){
   const captured=captureSystemPortRequest(path,options),call={path,method:captured.options.method,body:captured.options.body};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   if(state.membership!.role!=='admin')throw new AccessError(403);
   const [pathname,search='']=path.split('?'),rest=pathname.slice('/v1/sistema/'.length),params=new URLSearchParams(search);
   const body=call.body as {command_id:string}|undefined,known=body?commands.get(body.command_id):undefined;if(known)return{...(known as object),replayed:true};
   if(rest==='situacoes'&&call.method==='GET')return page((params.get('tipo')??'sales_orders') as SituationKind);
   if(rest==='situacoes'){const b=call.body as SituationSaveInput,list=situations(b.kind);
    if(list.some(s=>s.key!==b.id&&s.name.toLowerCase()===b.data.name.toLowerCase()))throw new AccessError(409);
    let key=b.id;if(!b.id){key=uuid();custom[b.kind].push({key,base_status:b.data.base_status,name:b.data.name,color:b.data.color,default:false,active:true,version:1});}
    else{const s=custom[b.kind].find(x=>x.key===b.id);if(!s)throw new AccessError(404);if(s.version!==b.expected_version)throw new AccessError(409);Object.assign(s,{name:b.data.name,color:b.data.color,active:b.data.active,version:s.version+1});}
    return finish(b.command_id,receipt('situations_command',b.command_id,b.id?'situation_update':'situation_create',key,1,b.kind));}
   if(rest==='transicoes'){const b=call.body as TransitionSaveInput,list=situations(b.kind),from=list.find(s=>s.key===b.from),to=list.find(s=>s.key===b.to);
    if(!from||!to)throw new AccessError(404);if(!allowed(b.kind,from,to)||b.data.actions.length&&!adopted)throw new AccessError(400);
    const current=stored[b.kind].get(`${b.from}>${b.to}`);if((current?.version??0)!==b.expected_version)throw new AccessError(409);
    stored[b.kind].set(`${b.from}>${b.to}`,{active:b.data.active,actions:[...b.data.actions],version:++seq});
    return finish(b.command_id,receipt('situations_command',b.command_id,'transition_save',`${b.from}>${b.to}`,1,b.kind));}
   if(rest==='transicoes/exclusao'){const b=call.body as TransitionsDeleteInput;for(const i of b.items){const s=stored[b.kind].get(`${i.from}>${i.to}`);if(!s)throw new AccessError(404);if(s.version!==i.expected_version)throw new AccessError(409);}
    for(const i of b.items)stored[b.kind].delete(`${i.from}>${i.to}`);return finish(b.command_id,receipt('situations_command',b.command_id,'transitions_delete',null,b.items.length,b.kind));}
   throw new AccessError(404);
  }};
 return{controller,calls,custom,stored,setAccess(patch:{role?:AccessRole;actor?:string}){state={...state,membership:{...state.membership!,role:patch.role??state.membership!.role,user_id:patch.actor??state.membership!.user_id}};for(const fn of listeners)fn();}};
}
