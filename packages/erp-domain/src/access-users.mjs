/** Closed117 contract: Sistema > Usuários (list, account, save, two-step invite and command lookup). */
export const USERS_BASE='/v1/usuarios';
export const USERS_MAX_BYTES=262144;
export const USERS_BODY_BYTES=8192;
export const ACCESS_ROLES=Object.freeze(['admin','consulta','vendas','financeiro','estoque','fiscal','operacao']);
export const USER_STATUSES=Object.freeze(['ativo','inativo','sem_acesso']);
export const USER_FILTERS=Object.freeze(['todos',...USER_STATUSES]);
// 229: Origin filter "Tipo de usuário" (Todos | Normal | Contador).
export const USER_TYPE_FILTERS=Object.freeze(['todos','normal','contador']);
export class AccessUsersContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new AccessUsersContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,CONTROL=/[\u0001-\u001f\u007f]/,EMAIL=/^[^@ ]+@[^@ ]+\.[^@ ]+$/;
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
export const accessUuid=v=>typeof v==='string'&&UUID.test(v);
export const userName=v=>typeof v==='string'&&v.length>=1&&v.length<=120&&!/^ | $/.test(v)&&!CONTROL.test(v);
export const userPhone=v=>v===null||typeof v==='string'&&/^[0-9+() -]{8,20}$/.test(v)&&!/^ | $/.test(v);
export const userEmail=v=>typeof v==='string'&&v.length<=254&&v===v.toLowerCase()&&!/^ | $/.test(v)&&EMAIL.test(v)&&!CONTROL.test(v);

export function captureUsersQuery({q=null,status='todos',type='todos',limit=100,offset=0}={}){
 need(q===null||typeof q==='string'&&q.length<=120&&!CONTROL.test(q),400,'ERP_INVALID_QUERY');need(USER_FILTERS.includes(status)&&USER_TYPE_FILTERS.includes(type)&&int(limit,1,100)&&int(offset,0,100000),400,'ERP_INVALID_QUERY');
 // Sent already trimmed (blanks) and in lower case, so the echo of erp_access_users_list compares exactly.
 const text=q===null?'':q.replace(/^ +| +$/g,'').toLowerCase();
 return Object.freeze({q:text===''?null:text,status,type,limit,offset});
}
export function captureUserSave(raw){
 const v=snapshot(raw);exact(v,['command_id','expected','data'],400,'ERP_INVALID_INPUT');need(accessUuid(v.command_id),400,'ERP_INVALID_INPUT');
 exact(v.expected,['role','active','profile_version'],400,'ERP_INVALID_INPUT');exact(v.data,['name','phone','role','active'],400,'ERP_INVALID_INPUT');
 need((v.expected.role===null||ACCESS_ROLES.includes(v.expected.role))&&typeof v.expected.active==='boolean'&&int(v.expected.profile_version),400,'ERP_INVALID_INPUT');
 need(userName(v.data.name)&&userPhone(v.data.phone)&&ACCESS_ROLES.includes(v.data.role)&&typeof v.data.active==='boolean',400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,expected:Object.freeze({...v.expected}),data:Object.freeze({...v.data})});
}
export function captureUserInvite(raw){
 const v=snapshot(raw);exact(v,['command_id','email','name','role'],400,'ERP_INVALID_INPUT');
 need(accessUuid(v.command_id)&&userEmail(v.email)&&userName(v.name)&&ACCESS_ROLES.includes(v.role),400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,email:v.email,name:v.name,role:v.role});
}
function user(v){
 exact(v,['user_id','email','name','phone','profile_version','role','active','status','invited','confirmed','last_sign_in_at','created_at']);
 need(accessUuid(v.user_id)&&(v.email===null||userEmail(v.email))&&(v.name===null||userName(v.name))&&userPhone(v.phone)&&int(v.profile_version)&&(v.profile_version===0)===(v.name===null));
 need(USER_STATUSES.includes(v.status)&&typeof v.active==='boolean'&&typeof v.invited==='boolean'&&typeof v.confirmed==='boolean'&&(v.last_sign_in_at===null||stamp(v.last_sign_in_at))&&stamp(v.created_at));
 need(v.status==='sem_acesso'?v.role===null&&!v.active:ACCESS_ROLES.includes(v.role)&&v.active===(v.status==='ativo'));
 return v;
}
export function parseUsersList(raw,query){
 const v=snapshot(raw);exact(v,['scope','data_mode','status','type','query','limit','offset','total','has_more','items','counts','actor']);
 need(v.scope==='access_users'&&v.data_mode==='erp_native'&&v.status===query.status&&v.type===query.type&&v.limit===query.limit&&v.offset===query.offset&&accessUuid(v.actor));
 need(v.query===query.q&&int(v.total)&&Array.isArray(v.items)&&v.items.length<=v.limit&&v.has_more===(v.offset+v.items.length<v.total));
 exact(v.counts,USER_STATUSES);need(USER_STATUSES.every(s=>int(v.counts[s])));
 const ids=new Set();for(const u of v.items){const{user_type,mfa,...rest}=plain(u)?u:{};need(['normal','contador'].includes(user_type)&&(v.type==='todos'||user_type===v.type)&&(mfa===undefined||typeof mfa==='boolean'));user(rest);
  need(!ids.has(u.user_id)&&(v.status==='todos'||u.status===v.status));ids.add(u.user_id);}
 return v;
}
export function parseUser(raw,target){const v=snapshot(raw);exact(v,['scope','data_mode','user','actor']);need(v.scope==='access_user'&&v.data_mode==='erp_native'&&accessUuid(v.actor));user(v.user);need(v.user.user_id===target);return v;}
function state(v){exact(v,['name','phone','role','active']);need((v.name===null||userName(v.name))&&userPhone(v.phone)&&(v.role===null||ACCESS_ROLES.includes(v.role))&&typeof v.active==='boolean');}
export function parseUserResult(raw,{commandId,target=null,input=null,invite=null,lookup=false}={}){
 need(accessUuid(commandId));const v=snapshot(raw);exact(v,['scope','data_mode','receipt','user','replayed']);
 need(v.scope==='access_user_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean'&&(!lookup||v.replayed));
 const r=v.receipt;exact(r,['command_id','kind','target','changed_at','before','after']);need(r.command_id===commandId&&['save','invite'].includes(r.kind)&&accessUuid(r.target)&&(target===null||r.target===target)&&stamp(r.changed_at));
 state(r.before);state(r.after);user(v.user);need(v.user.user_id===r.target);
 if(input){const sent=captureUserSave(input);need(r.kind==='save'&&sent.command_id===commandId&&r.after.name===sent.data.name&&r.after.phone===sent.data.phone&&r.after.active===sent.data.active&&(r.after.role===sent.data.role||r.after.role===null&&!sent.data.active));}
 if(invite){const sent=captureUserInvite(invite);need(r.kind==='invite'&&sent.command_id===commandId&&r.after.name===sent.name&&r.after.role===sent.role&&r.after.active===true&&v.user.email===sent.email);}
 return v;
}
/** Pending invite (begin, or lookup before completion): the account Auth may already have created for the e-mail. */
export function parseInvitePending(raw,{commandId,email=null}){
 const v=snapshot(raw);exact(v,['scope','data_mode','state','command_id','email','existing_user_id']);
 need(v.scope==='access_invite'&&v.data_mode==='erp_native'&&v.state==='pending'&&v.command_id===commandId&&userEmail(v.email)&&(email===null||v.email===email)&&(v.existing_user_id===null||accessUuid(v.existing_user_id)));
 return v;
}
/** Supabase Auth admin invite answer: only the new account's id and e-mail are kept. */
export function parseAuthInvite(raw,email){
 const v=snapshot(raw);need(plain(v)&&accessUuid(v.id)&&typeof v.email==='string'&&v.email.toLowerCase()===email);
 return Object.freeze({id:v.id});
}
