// Synthetic DTOs for the Preferências API tests (migration 115 shapes). No real data.
import{storedPreferencePage}from'../../../../packages/erp-domain/src/preferences/catalog.mjs';
import{storedFields}from'../../../../packages/erp-domain/src/preferences/core.mjs';
export const ACTOR='10000000-0000-4000-8000-000000000115';
export const COMMAND='20000000-0000-4000-8000-000000000115';
export const OTHER='10000000-0000-4000-8000-000000000116';
export const STAMP='2026-10-20T12:00:00.000000+00:00';
export function pageView(pageId,{role='admin',values={},versions={},directory}={}){
 const page=storedPreferencePage(pageId),manage=page.scope==='user'||role==='admin';
 return{scope:'preferences_page',data_mode:'erp_native',page:page.id,owner:page.scope,role,can_manage:manage,
  items:storedFields(page).map(f=>{const version=versions[f.key]??(Object.hasOwn(values,f.key)?1:0);return{key:f.key,value:structuredClone(Object.hasOwn(values,f.key)?values[f.key]:f.default),version,updated_at:version?STAMP:null};}),
  directory:directory!==undefined?directory:storedFields(page).some(f=>f.kind==='users')&&manage?[{user_id:ACTOR,role:'admin',label:'Administrador sintético'},{user_id:OTHER,role:'vendas',label:null}]:null};
}
export function saveInput(changes,command=COMMAND){return{command_id:command,changes};}
export function commandResult(pageId,input,{replayed=false,role='admin'}={}){
 const page=storedPreferencePage(pageId),values={},versions={};
 const changes=input.changes.map(c=>{const f=storedFields(page).find(x=>x.key===c.key);values[c.key]=c.value;versions[c.key]=c.expected_version+1;
  return{key:c.key,from_version:c.expected_version,to_version:c.expected_version+1,before:structuredClone(f.default),after:structuredClone(c.value)};});
 return{scope:'preferences_command',data_mode:'erp_native',replayed,receipt:{command_id:input.command_id,page:page.id,changed_at:STAMP,changes},page:pageView(page.id,{role,values,versions})};
}
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
