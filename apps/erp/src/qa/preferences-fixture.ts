// QA_SYNTHETIC_PREFERENCES — synthetic local ports for the Preferências pages, no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {capturePreferencesRequest} from '../lib/preferences-request.ts';
import {storedPreferencePage} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import {storedFields,preferenceValueEqual} from '../../../../packages/erp-domain/src/preferences/core.mjs';
import {pageSituationKinds} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import type {PreferencesSaveInput,PreferencesResult,PreferencesPageView,PreferenceItem,PreferenceSituation} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
export const PREFERENCES_QA_ACTOR='10000000-0000-4000-8000-000000000115';
export const PREFERENCES_QA_OTHER='10000000-0000-4000-8000-000000000116';
const STAMP='2026-10-20T12:00:00.000000+00:00';
export type PreferencesQaCall={path:string;method?:string;body?:unknown;signal?:AbortSignal};
type Stored={value:unknown;version:number;updated_at:string};
// 299: `situations` are the custom situações the pages with such a field offer (Suprimentos › Estoque).
export function createPreferencesFixture({role='admin',before,after,lostAck=false,policy=false,situations=[]}:{role?:AccessRole;before?:(call:PreferencesQaCall)=>unknown|Promise<unknown>;after?:(call:PreferencesQaCall,value:unknown)=>unknown;lostAck?:boolean;policy?:boolean;situations?:PreferenceSituation[]}={}){
 let state:AccessState={phase:'ready',membership:{user_id:PREFERENCES_QA_ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:PreferencesQaCall[]=[],values=new Map<string,Stored>(),commands=new Map<string,PreferencesResult>();let lose=lostAck;
 const view=(pageId:string):PreferencesPageView=>{const page=storedPreferencePage(pageId)!,r=state.membership!.role,manage=page.scope==='user'||r==='admin';
  if(!page.readRoles.includes(r))throw new AccessError(403);
  return{scope:'preferences_page',data_mode:'erp_native',page:page.id,owner:page.scope,role:r,can_manage:manage,
   items:storedFields(page).map(f=>{const s=values.get(f.key);return{key:f.key,value:structuredClone(s?s.value:f.default),version:s?.version??0,updated_at:s?.updated_at??null} as PreferenceItem;}),
   directory:storedFields(page).some(f=>f.kind==='users')&&manage?[{user_id:PREFERENCES_QA_ACTOR,role:'admin',label:'Administrador sintético'},{user_id:PREFERENCES_QA_OTHER,role:'vendas',label:'Vendas sintético'}]:null,
   ...(pageSituationKinds(page).length?{situations:structuredClone(situations)}:{})};};
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async preferences(path:string,options:NativeRequestOptions={}){
   const captured=capturePreferencesRequest(path,options),call:PreferencesQaCall={path,...captured.options};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   let value:unknown;
   if(path.includes('/comandos/')){const found=commands.get(path.split('/').at(-1)!);if(!found)throw new AccessError(404);value={...found,page:view(found.receipt.page),replayed:true};}
   else{const pageId=path.split('/').at(-1)!;
    if(call.method==='POST'){const body=captured.options.body as PreferencesSaveInput,known=commands.get(body.command_id);
     if(known)value={...known,page:view(pageId),replayed:true};
     else{const page=storedPreferencePage(pageId)!;if(page.scope==='company'&&state.membership!.role!=='admin')throw new AccessError(403);
      const changes=body.changes.map(c=>{const field=storedFields(page).find(f=>f.key===c.key)!,s=values.get(c.key),version=s?.version??0,before=s?s.value:field.default;
       if(version!==c.expected_version)throw new AccessError(409);if(preferenceValueEqual(before,c.value))throw new AccessError(400);
       return{key:c.key,from_version:version,to_version:version+1,before:structuredClone(before),after:structuredClone(c.value)};});
      for(const c of changes)values.set(c.key,{value:structuredClone(c.after),version:c.to_version,updated_at:STAMP});
      const result={scope:'preferences_command',data_mode:'erp_native',replayed:false,receipt:{command_id:body.command_id,page:pageId,changed_at:STAMP,changes},page:view(pageId)} as PreferencesResult;
      commands.set(body.command_id,result);value=result;if(lose){lose=false;throw new AccessError(503);}}
    }else value=view(pageId);}
   return after?after(call,structuredClone(value)):structuredClone(value);
  },
  async stockOpening(path:string,options:NativeRequestOptions={}){calls.push({path,method:options.method??'GET'});if(path!=='/v1/politica-estoque')throw new AccessError(400);
   return{scope:'stock_policy',policy:policy?{allow_negative:true,version:1,updated_at:STAMP}:{allow_negative:false,version:0,updated_at:null},can_manage:state.membership!.role==='admin',data_mode:'erp_native'};}};
 return{controller,calls,values,commands,
  set(key:string,value:unknown,version=1){values.set(key,{value,version,updated_at:STAMP});},
  setAccess(patch:{actor?:string|null;role?:AccessRole;phase?:AccessState['phase']}){const actor=Object.hasOwn(patch,'actor')?patch.actor:state.membership?.user_id;
   state={...state,phase:patch.phase??state.phase,membership:actor?{user_id:actor,role:patch.role??state.membership?.role??'admin',resources:[],data_mode:'staging_readonly'}:null};for(const fn of listeners)fn();}};
}
