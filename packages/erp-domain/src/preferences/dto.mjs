/** Closed115 contract shared by the API boundary and the browser: one Preferências page read, one audited save. */
import{PREFERENCE_ROLES,PREFERENCE_SITUATION_IDS,preferenceUuid,preferenceValueValid,preferenceValueEqual,preferenceClone,storedFields}from'./core.mjs';
import{storedPreferencePage}from'./catalog.mjs';
export const PREFERENCES_BASE='/v1/preferencias';
export const PREFERENCES_MAX_BYTES=262144;
export const PREFERENCES_BODY_BYTES=65536;
export const PREFERENCES_DIRECTORY_LIMIT=500;
export class PreferencesContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new PreferencesContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
/** A JSON snapshot detaches the value from any getter or prototype before validation. */
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
const fieldOf=(page,key)=>storedFields(page).find(f=>f.key===key);
export const pageHasDirectory=page=>storedFields(page).some(f=>f.kind==='users');
/** 299: the document kinds whose custom situações the page offers (a multi field with `situations`). */
export const pageSituationKinds=page=>[...new Set(storedFields(page).filter(f=>f.situations).map(f=>f.situations.kind))];

/** Body of POST /v1/preferencias/:page. Invalid input is a 400 before any dispatch. */
export function capturePreferencesSave(raw,pageId){
 const page=storedPreferencePage(pageId);need(page,404,'ERP_NOT_FOUND');
 const v=snapshot(raw);exact(v,['command_id','changes'],400,'ERP_INVALID_INPUT');
 need(preferenceUuid(v.command_id),400,'ERP_INVALID_INPUT');
 const fields=storedFields(page);need(Array.isArray(v.changes)&&v.changes.length>=1&&v.changes.length<=fields.length,400,'ERP_INVALID_INPUT');
 const seen=new Set(),changes=v.changes.map(c=>{
  exact(c,['key','expected_version','value'],400,'ERP_INVALID_INPUT');
  const field=fieldOf(page,c.key);need(field&&!seen.has(c.key),400,'ERP_INVALID_INPUT');seen.add(c.key);
  need(int(c.expected_version,0,2147483646)&&preferenceValueValid(field,c.value),400,'ERP_INVALID_INPUT');
  return Object.freeze({key:c.key,expected_version:c.expected_version,value:preferenceClone(c.value)});
 });
 return Object.freeze({command_id:v.command_id,changes:Object.freeze(changes)});
}

function directory(v){
 need(Array.isArray(v)&&v.length<=PREFERENCES_DIRECTORY_LIMIT);const ids=new Set();
 for(const u of v){exact(u,['user_id','role','label']);need(preferenceUuid(u.user_id)&&!ids.has(u.user_id)&&PREFERENCE_ROLES.includes(u.role)&&(u.label===null||typeof u.label==='string'&&u.label.length>=1&&u.label.length<=200));ids.add(u.user_id);}
}
const CONTROL=/[\u0000-\u001f\u007f]/;
// Lengths in characters (code points), as char_length() counts the name of a situação in PostgreSQL (148).
const chars=(v,max)=>typeof v==='string'&&[...v].length>=1&&[...v].length<=max;
// 299: id, kind, name, base status and label, color and active of each custom situação (up to 30 per kind).
function situations(v,kinds){
 need(Array.isArray(v)&&v.length<=PREFERENCE_SITUATION_IDS*kinds.length);const ids=new Set();
 for(const s of v){exact(s,['id','kind','name','base_status','base_label','color','active']);
  need(preferenceUuid(s.id)&&!ids.has(s.id)&&kinds.includes(s.kind)&&chars(s.name,40)&&s.name===s.name.trim()&&!CONTROL.test(s.name)
   &&typeof s.base_status==='string'&&/^[a-z_]{2,40}$/.test(s.base_status)&&chars(s.base_label,80)&&!CONTROL.test(s.base_label)
   &&typeof s.color==='string'&&/^#[0-9a-f]{6}$/.test(s.color)&&typeof s.active==='boolean');ids.add(s.id);}
}
/** GET /v1/preferencias/:page and the "page" block of a command result. */
export function parsePreferencesPage(raw,pageId){
 const page=storedPreferencePage(pageId);need(page);const v=snapshot(raw),kinds=pageSituationKinds(page);
 exact(v,['scope','data_mode','page','owner','role','can_manage','items','directory',...(kinds.length?['situations']:[])]);
 if(kinds.length)situations(v.situations,kinds);
 need(v.scope==='preferences_page'&&v.data_mode==='erp_native'&&v.page===page.id&&v.owner===page.scope&&page.readRoles.includes(v.role)&&typeof v.can_manage==='boolean');
 need(v.can_manage===(page.scope==='user'||v.role==='admin'));
 const fields=storedFields(page);need(Array.isArray(v.items)&&v.items.length===fields.length);
 v.items.forEach((item,i)=>{const f=fields[i];exact(item,['key','value','version','updated_at']);need(item.key===f.key&&int(item.version)&&preferenceValueValid(f,item.value));
  // A published migration may change an implicit default without creating a company override.
  // Accept only the defaults explicitly declared by that field, preserving the closed value contract.
  need(item.version===0?item.updated_at===null&&[f.default,...(f.migratedDefaults??[])].some(value=>preferenceValueEqual(item.value,value)):stamp(item.updated_at));});
 if(pageHasDirectory(page)&&v.can_manage)directory(v.directory);else need(v.directory===null);
 return v;
}
/** POST result and GET /v1/preferencias/comandos/:id. With the captured input, the receipt must be exactly what was sent. */
export function parsePreferencesResult(raw,{commandId,pageId=null,input=null,lookup=false}={}){
 need(preferenceUuid(commandId));const v=snapshot(raw);
 exact(v,['scope','data_mode','receipt','page','replayed']);need(v.scope==='preferences_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean'&&(!lookup||v.replayed===true));
 const r=v.receipt;exact(r,['command_id','page','changed_at','changes']);need(r.command_id===commandId&&(pageId===null||r.page===pageId)&&stamp(r.changed_at));
 const page=storedPreferencePage(r.page);need(page);const current=parsePreferencesPage(v.page,page.id);
 need(Array.isArray(r.changes)&&r.changes.length>=1&&r.changes.length<=storedFields(page).length);const keys=new Set();
 for(const c of r.changes){exact(c,['key','from_version','to_version','before','after']);const f=fieldOf(page,c.key);
  need(f&&!keys.has(c.key)&&int(c.from_version,0,2147483646)&&c.to_version===c.from_version+1&&preferenceValueValid(f,c.before)&&preferenceValueValid(f,c.after)&&!preferenceValueEqual(c.before,c.after));keys.add(c.key);
  need(current.items.find(i=>i.key===c.key).version>=c.to_version);}
 if(input){const sent=capturePreferencesSave(input,page.id);need(sent.command_id===commandId&&sent.changes.length===r.changes.length);
  for(const s of sent.changes){const c=r.changes.find(x=>x.key===s.key);need(c&&c.from_version===s.expected_version&&preferenceValueEqual(c.after,s.value));}}
 return v;
}
