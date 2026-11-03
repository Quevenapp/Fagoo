/** Closed116 contract: per-user list preferences (custom columns and default filters, Origin "Tornar padrão"). */
export const LIST_PREFERENCES_BASE='/v1/preferencias-listas';
export const LIST_PREFERENCES_MAX_BYTES=65536;
export const LIST_PREFERENCES_BODY_BYTES=16384;
export class ListPreferencesContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new ListPreferencesContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,NAME=/^[a-z][a-z0-9_]{0,39}$/,CONTROL=/[\u0001-\u001f\u007f]/;
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
export const listPreferenceUuid=v=>typeof v==='string'&&UUID.test(v);
export const listPreferenceId=v=>typeof v==='string'&&v.length<=60&&/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(v);
export const listColumnId=v=>typeof v==='string'&&NAME.test(v);
// Size as octet_length(jsonb::text): compact JSON plus the blank PostgreSQL writes after every ":" and ",".
const utf8=v=>{const keys=Object.keys(v).length,arrays=Object.values(v).reduce((n,x)=>n+(Array.isArray(x)?Math.max(0,x.length-1):0),0);
 return new TextEncoder().encode(JSON.stringify(v)).length+keys+Math.max(0,keys-1)+arrays;};
/** Mirror of erp_list_preferences.valid: null clears a value; otherwise the shapes and limits below. */
export function listPreferenceValid(columns,filters){
 if(columns!==null&&(!Array.isArray(columns)||columns.length<1||columns.length>60||!columns.every(listColumnId)||new Set(columns).size!==columns.length))return false;
 if(filters===null)return true;
 if(!plain(filters)||Object.keys(filters).length>20||utf8(filters)>8192)return false;
 for(const[k,v]of Object.entries(filters)){
  if(!NAME.test(k))return false;
  if(typeof v==='string'){if(v.length>200||CONTROL.test(v))return false;}
  else if(typeof v==='boolean')continue;
  else if(typeof v==='number'){if(!Number.isSafeInteger(v)||Math.abs(v)>=1e9)return false;}
  else if(Array.isArray(v)){if(v.length>50||v.some(e=>typeof e!=='string'||e.length>100||CONTROL.test(e)))return false;}
  else return false;
 }
 return true;
}
export function captureListPreferencesSave(raw,listId){
 need(listPreferenceId(listId),404,'ERP_NOT_FOUND');const v=snapshot(raw);
 exact(v,['command_id','expected_version','columns','filters'],400,'ERP_INVALID_INPUT');
 need(listPreferenceUuid(v.command_id)&&int(v.expected_version,0,2147483646)&&listPreferenceValid(v.columns,v.filters),400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,expected_version:v.expected_version,columns:v.columns===null?null:Object.freeze([...v.columns]),filters:v.filters===null?null:Object.freeze(structuredClone(v.filters))});
}
export function parseListPreferences(raw,listId){
 const v=snapshot(raw);exact(v,['scope','data_mode','list_id','version','columns','filters','updated_at']);
 need(v.scope==='list_preferences'&&v.data_mode==='erp_native'&&v.list_id===listId&&int(v.version));
 if(v.version===0)need(v.columns===null&&v.filters===null&&v.updated_at===null);else need(stamp(v.updated_at)&&listPreferenceValid(v.columns,v.filters));
 return v;
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)||a&&b&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===Object.keys(b??{}).length&&Object.keys(a).every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
export function parseListPreferencesResult(raw,{commandId,listId=null,input=null,lookup=false}={}){
 need(listPreferenceUuid(commandId));const v=snapshot(raw);
 exact(v,['scope','data_mode','receipt','preference','replayed']);need(v.scope==='list_preferences_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean'&&(!lookup||v.replayed));
 const r=v.receipt;exact(r,['command_id','list_id','from_version','to_version','changed_at']);
 need(r.command_id===commandId&&listPreferenceId(r.list_id)&&(listId===null||r.list_id===listId)&&int(r.from_version,0,2147483646)&&r.to_version===r.from_version+1&&stamp(r.changed_at));
 const p=parseListPreferences(v.preference,r.list_id);need(p.version>=r.to_version);
 if(input){const sent=captureListPreferencesSave(input,r.list_id);need(sent.command_id===commandId&&sent.expected_version===r.from_version);
  if(p.version===r.to_version)need(same(p.columns,sent.columns)&&same(p.filters,sent.filters));}
 return v;
}
