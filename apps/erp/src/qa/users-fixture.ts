// QA_SYNTHETIC_USERS — synthetic local port for Sistema > Usuários, no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureAccessUsersRequest} from '../lib/access-users-request.ts';
import {createListPreferencesFixture} from './list-preferences-fixture.ts';
import type {AccessUser,UserSaveInput,UserInviteInput,UserResult} from '../../../../packages/erp-domain/src/access-users.mjs';
import type {ControlsSaveInput,UserControls} from '../../../../packages/erp-domain/src/user-permissions.mjs';
export const USERS_QA_ADMIN='10000000-0000-4000-8000-000000000117';
const STAMP='2026-10-20T12:00:00.000000+00:00';
const uuid=(n:number)=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export type UsersQaCall={path:string;method?:string;body?:unknown;signal?:AbortSignal};
const seed=():AccessUser[]=>[
 {user_id:USERS_QA_ADMIN,email:'admin@sintetico.test',name:'Administrador Sintético',phone:null,profile_version:1,role:'admin',active:true,status:'ativo',invited:false,confirmed:true,last_sign_in_at:STAMP,created_at:STAMP},
 {user_id:uuid(1),email:'vendas@sintetico.test',name:'Vendas Sintético',phone:'(11) 90000-0001',profile_version:1,role:'vendas',active:true,status:'ativo',invited:true,confirmed:true,last_sign_in_at:null,created_at:STAMP},
 {user_id:uuid(2),email:'antigo@sintetico.test',name:null,phone:null,profile_version:0,role:'consulta',active:false,status:'inativo',invited:true,confirmed:true,last_sign_in_at:null,created_at:STAMP},
 {user_id:uuid(3),email:'convidado@sintetico.test',name:null,phone:null,profile_version:0,role:null,active:false,status:'sem_acesso',invited:true,confirmed:false,last_sign_in_at:null,created_at:STAMP},
];
export function createUsersFixture({role='admin',before,lostAck=false,inviteCreates=true}:{role?:AccessRole;before?:(call:UsersQaCall)=>unknown|Promise<unknown>;lostAck?:boolean;inviteCreates?:boolean}={}){
 let state:AccessState={phase:'ready',membership:{user_id:USERS_QA_ADMIN,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:UsersQaCall[]=[],users=seed(),commands=new Map<string,{kind:'save'|'invite';result?:UserResult;email?:string}>();let lose=lostAck,serial=10;
 const lists=createListPreferencesFixture({role});
 // 229: Tipo de usuário, horários and permissões of each synthetic user.
 const controls=new Map<string,{version:number;user_type:'normal'|'contador';schedule:{enabled:boolean;windows:{start:string;end:string;days:number[]}[]};permissions:string[]|null;updated_at:string|null}>();
 const controlCommands=new Map<string,unknown>();
 const controlsOf=(u:AccessUser):UserControls=>{const c=controls.get(u.user_id)??{version:0,user_type:'normal' as const,schedule:{enabled:false,windows:[]},permissions:null,updated_at:null};
  return structuredClone({scope:'access_user_controls',data_mode:'erp_native',target:u.user_id,role:u.role,version:c.version,user_type:c.user_type,schedule:c.schedule,permissions:c.permissions,
   seller:u.role==='vendas'?{name:'Vendedor Sintético',enabled:true,windows:[{start:'09:00',end:'17:00',days:[1,2,3,4,5]}]}:null,updated_at:c.updated_at,gate_required:c.schedule.enabled||u.role==='vendas'});};
 const status=(u:AccessUser):AccessUser['status']=>u.role===null?'sem_acesso':u.active?'ativo':'inativo';
 const receipt=(command:string,kind:'save'|'invite',u:AccessUser,before:{name:string|null;phone:string|null;role:AccessRole|null;active:boolean}):UserResult=>({scope:'access_user_command',data_mode:'erp_native',replayed:false,user:structuredClone(u),
  receipt:{command_id:command,kind,target:u.user_id,changed_at:STAMP,before,after:{name:u.name,phone:u.phone,role:u.role,active:u.active}}});
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},listPreferences:lists.controller.listPreferences,
  async accessUsers(path:string,options:NativeRequestOptions={}){
   const captured=captureAccessUsersRequest(path,options),call:UsersQaCall={path,...captured.options};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   if(state.membership?.role!=='admin')throw new AccessError(403);
   const [pathname,search='']=path.split('?'),rest=pathname.slice('/v1/usuarios'.length+1);
   if(!rest){const p=new URLSearchParams(search),q=p.get('q'),filter=p.get('situacao')??'todos',type=p.get('tipo')??'todos',limit=Number(p.get('limit')??100),offset=Number(p.get('offset')??0);
    const typeOf=(u:AccessUser)=>controls.get(u.user_id)?.user_type??'normal';
    const all=users.filter(u=>(filter==='todos'||u.status===filter)&&(type==='todos'||typeOf(u)===type)&&(!q||(u.name??'').toLowerCase().includes(q)||(u.email??'').includes(q)));
    const items=all.slice(offset,offset+limit).map(u=>({...u,user_type:typeOf(u)}));
    return structuredClone({scope:'access_users',data_mode:'erp_native',status:filter,type,query:q,limit,offset,total:all.length,has_more:offset+items.length<all.length,items,
     counts:{ativo:users.filter(u=>u.status==='ativo').length,inativo:users.filter(u=>u.status==='inativo').length,sem_acesso:users.filter(u=>u.status==='sem_acesso').length},actor:USERS_QA_ADMIN});}
   if(rest.startsWith('comandos/')){const c=commands.get(rest.slice(9));if(!c)throw new AccessError(404);
    if(c.result)return structuredClone({...c.result,replayed:true});const existing=users.find(u=>u.email===c.email);
    return{scope:'access_invite',data_mode:'erp_native',state:'pending',command_id:rest.slice(9),email:c.email,existing_user_id:existing?.user_id??null};}
   if(rest==='convites'){const body=captured.options.body as UserInviteInput,known=commands.get(body.command_id);
    if(known?.result)return structuredClone({...known.result,replayed:true});
    if(!known&&users.some(u=>u.email===body.email))throw new AccessError(409);
    commands.set(body.command_id,{kind:'invite',email:body.email});
    if(!inviteCreates)throw new AccessError(503);
    let u=users.find(x=>x.email===body.email);if(!u){u={user_id:uuid(++serial),email:body.email,name:null,phone:null,profile_version:0,role:null,active:false,status:'sem_acesso',invited:true,confirmed:false,last_sign_in_at:null,created_at:STAMP};users.push(u);}
    if(lose){lose=false;throw new AccessError(503);}
    Object.assign(u,{name:body.name,profile_version:1,role:body.role,active:true});u.status=status(u);
    const result=receipt(body.command_id,'invite',u,{name:null,phone:null,role:null,active:false});commands.set(body.command_id,{kind:'invite',email:body.email,result});return structuredClone(result);}
   if(rest.endsWith('/controles')){const u=users.find(x=>x.user_id===rest.slice(0,36));if(!u)throw new AccessError(404);if(call.method!=='POST')return controlsOf(u);
    const body=captured.options.body as ControlsSaveInput,known=controlCommands.get(body.command_id);if(known)return structuredClone({...(known as object),replayed:true});
    const c=controls.get(u.user_id);if((c?.version??0)!==body.expected_version)throw new AccessError(409);
    if(u.role==='admin'&&(body.data.schedule.enabled||body.data.permissions!==null))throw new AccessError(400);
    controls.set(u.user_id,{version:(c?.version??0)+1,user_type:body.data.user_type,schedule:structuredClone(body.data.schedule),permissions:body.data.permissions?[...body.data.permissions]:null,updated_at:STAMP});
    const result={scope:'access_controls_command',data_mode:'erp_native',replayed:false,receipt:{command_id:body.command_id,target:u.user_id,changed_at:STAMP},controls:controlsOf(u)};
    controlCommands.set(body.command_id,result);if(lose){lose=false;throw new AccessError(503);}return structuredClone(result);}
   const u=users.find(x=>x.user_id===rest);if(!u)throw new AccessError(404);
   if(call.method!=='POST')return structuredClone({scope:'access_user',data_mode:'erp_native',user:u,actor:USERS_QA_ADMIN});
   const body=captured.options.body as UserSaveInput,known=commands.get(body.command_id);if(known?.result)return structuredClone({...known.result,replayed:true});
   if(u.role!==body.expected.role||u.active!==body.expected.active||u.profile_version!==body.expected.profile_version)throw new AccessError(409);
   if(u.user_id===USERS_QA_ADMIN&&(body.data.role!=='admin'||!body.data.active))throw new AccessError(403);
   const previous={name:u.name,phone:u.phone,role:u.role,active:u.active};
   if(u.name!==body.data.name||u.phone!==body.data.phone)u.profile_version++;
   Object.assign(u,{name:body.data.name,phone:body.data.phone,role:u.role===null&&!body.data.active?null:body.data.role,active:body.data.active});u.status=status(u);
   const result=receipt(body.command_id,'save',u,previous);commands.set(body.command_id,{kind:'save',result});if(lose){lose=false;throw new AccessError(503);}return structuredClone(result);
  }};
 return{controller,calls,users,commands,lists,controls,
  setAccess(patch:{actor?:string|null;role?:AccessRole;phase?:AccessState['phase']}){const actor=Object.hasOwn(patch,'actor')?patch.actor:state.membership?.user_id;
   state={...state,phase:patch.phase??state.phase,membership:actor?{user_id:actor,role:patch.role??state.membership?.role??'admin',resources:[],data_mode:'staging_readonly'}:null};for(const fn of listeners)fn();lists.setAccess(patch);}};
}
