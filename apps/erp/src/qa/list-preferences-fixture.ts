// QA_SYNTHETIC_LIST_PREFERENCES — synthetic local port for per-user list preferences, no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureListPreferencesRequest} from '../lib/list-preferences-request.ts';
import type {ListPreferences,ListPreferencesResult,ListPreferencesSaveInput} from '../../../../packages/erp-domain/src/list-preferences.mjs';
export const LIST_QA_ACTOR='10000000-0000-4000-8000-000000000116';
const STAMP='2026-10-20T12:00:00.000000+00:00';
export type ListQaCall={path:string;method?:string;body?:unknown;signal?:AbortSignal};
export function createListPreferencesFixture({role='vendas',before,lostAck=false}:{role?:AccessRole;before?:(call:ListQaCall)=>unknown|Promise<unknown>;lostAck?:boolean}={}){
 let state:AccessState={phase:'ready',membership:{user_id:LIST_QA_ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:ListQaCall[]=[],rows=new Map<string,ListPreferences>(),commands=new Map<string,ListPreferencesResult>();let lose=lostAck;
 const key=(list:string)=>`${state.membership?.user_id}:${list}`;
 const view=(list:string):ListPreferences=>structuredClone(rows.get(key(list))??{scope:'list_preferences',data_mode:'erp_native',list_id:list,version:0,columns:null,filters:null,updated_at:null});
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async listPreferences(path:string,options:NativeRequestOptions={}){
   const captured=captureListPreferencesRequest(path,options),call:ListQaCall={path,...captured.options};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   const rest=path.split('/v1/preferencias-listas/')[1];
   if(rest.startsWith('comandos/')){const found=commands.get(rest.slice(9));if(!found)throw new AccessError(404);return structuredClone({...found,preference:view(found.receipt.list_id),replayed:true});}
   if(call.method!=='POST')return view(rest);
   const body=captured.options.body as ListPreferencesSaveInput,known=commands.get(body.command_id);if(known)return structuredClone({...known,preference:view(rest),replayed:true});
   const current=view(rest);if(current.version!==body.expected_version)throw new AccessError(409);
   const next:ListPreferences={scope:'list_preferences',data_mode:'erp_native',list_id:rest,version:current.version+1,columns:body.columns?[...body.columns]:null,filters:body.filters?structuredClone(body.filters):null,updated_at:STAMP};
   rows.set(key(rest),next);
   const result:ListPreferencesResult={scope:'list_preferences_command',data_mode:'erp_native',replayed:false,receipt:{command_id:body.command_id,list_id:rest,from_version:current.version,to_version:next.version,changed_at:STAMP},preference:structuredClone(next)};
   commands.set(body.command_id,result);if(lose){lose=false;throw new AccessError(503);}return structuredClone(result);
  }};
 return{controller,calls,rows,
  setAccess(patch:{actor?:string|null;role?:AccessRole;phase?:AccessState['phase']}){const actor=Object.hasOwn(patch,'actor')?patch.actor:state.membership?.user_id;
   state={...state,phase:patch.phase??state.phase,membership:actor?{user_id:actor,role:patch.role??state.membership?.role??'vendas',resources:[],data_mode:'staging_readonly'}:null};for(const fn of listeners)fn();}};
}
