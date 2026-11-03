/** Sistema > Usuários (migration 117) under /v1/usuarios. Administrador only (checked again by every RPC).
 * The invite runs in two recorded steps around the Supabase Auth admin invite, so a lost answer is resolved by resending the
 * same command: the database returns the pending intent and the account Auth may already have created, never a second invite. */
import{USERS_BASE,USERS_BODY_BYTES,USER_FILTERS,USER_TYPE_FILTERS,captureUsersQuery,captureUserSave,captureUserInvite,parseUsersList,parseUser,parseUserResult,parseInvitePending,parseAuthInvite,accessUuid,AccessUsersContractError}from'../../../packages/erp-domain/src/access-users.mjs';
import{captureControlsSave,parseControls,parseControlsResult,CONTROLS_BODY_BYTES,PermissionsContractError}from'../../../packages/erp-domain/src/user-permissions.mjs';
import{PreferencesError,need,readJsonBody,getWithoutBody}from'./preferences-kit.mjs';
const QUERY=['q','situacao','tipo','limit','offset'];
function query(url){
 for(const k of url.searchParams.keys())need(QUERY.includes(k)&&url.searchParams.getAll(k).length===1,400,'ERP_INVALID_QUERY');
 const num=(k,d)=>{const v=url.searchParams.get(k);if(v===null)return d;need(/^(0|[1-9][0-9]{0,5})$/.test(v),400,'ERP_INVALID_QUERY');return Number(v);};
 const status=url.searchParams.get('situacao')??'todos',type=url.searchParams.get('tipo')??'todos';need(USER_FILTERS.includes(status)&&USER_TYPE_FILTERS.includes(type),400,'ERP_INVALID_QUERY');
 try{return captureUsersQuery({q:url.searchParams.get('q'),status,type,limit:num('limit',100),offset:num('offset',0)});}catch(e){if(e instanceof AccessUsersContractError)throw new PreferencesError(e.status,e.code);throw e;}
}
const contract=fn=>{try{return fn();}catch(e){if(e instanceof AccessUsersContractError||e instanceof PermissionsContractError)throw new PreferencesError(e.status,e.code);throw e;}};
// 229: GET and POST <id>/controles (Tipo de usuário, Restringir horários de acesso and Permissões).
const CONTROLS=/^([a-f0-9-]{36})\/controles$/;
export const usersRouter={base:USERS_BASE,root:['GET'],
 methods:rest=>rest==='convites'?['POST']:accessUuid(rest)||CONTROLS.test(rest)&&accessUuid(rest.slice(0,36))?['GET','POST']:['GET'],
 async parse(request,rest,url){
  if(rest===''){getWithoutBody(request);const q=query(url);return{action:'users',rpc:'erp_access_users_list_v2',mutation:false,query:q,args:{p_query:q.q,p_status:q.status,p_type:q.type,p_limit:q.limit,p_offset:q.offset}};}
  need(!url.search,400,'ERP_INVALID_QUERY');
  const controls=CONTROLS.exec(rest);
  if(controls){const target=controls[1];need(accessUuid(target),404,'ERP_NOT_FOUND');
   if(request.method==='GET'){getWithoutBody(request);return{action:'controls',rpc:'erp_access_user_controls_get',mutation:false,target,args:{p_target:target}};}
   const body=await readJsonBody(request,CONTROLS_BODY_BYTES),input=contract(()=>captureControlsSave(body));
   return{action:'controls-save',rpc:'erp_access_user_controls_save',mutation:true,target,input,args:{p_target:target,p_command_id:input.command_id,p_expected_version:input.expected_version,p_data:input.data}};}
  if(rest.startsWith('comandos/')){const id=rest.slice(9);need(accessUuid(id),404,'ERP_NOT_FOUND');getWithoutBody(request);return{action:'user-command',rpc:'erp_access_user_command',mutation:false,args:{p_command_id:id}};}
  need(rest==='convites'||accessUuid(rest),404,'ERP_NOT_FOUND');
  if(rest==='convites'){const body=await readJsonBody(request,USERS_BODY_BYTES),input=contract(()=>captureUserInvite(body));
   return{action:'invite',rpc:'erp_access_user_invite_begin',mutation:true,input,args:{p_command_id:input.command_id,p_email:input.email,p_name:input.name,p_role:input.role}};}
  if(request.method==='GET'){getWithoutBody(request);return{action:'user',rpc:'erp_access_user_get',mutation:false,target:rest,args:{p_target:rest}};}
  const body=await readJsonBody(request,USERS_BODY_BYTES),input=contract(()=>captureUserSave(body));
  return{action:'user-save',rpc:'erp_access_user_save',mutation:true,target:rest,input,args:{p_target:rest,p_command_id:input.command_id,p_expected:input.expected,p_data:input.data}};
 },
 result(route,args,result){
  if(route.action==='users')return parseUsersList(result,route.query);
  if(route.action==='controls')return parseControls(result,route.target);
  if(route.action==='controls-save')return parseControlsResult(result,{target:route.target,input:route.input});
  if(route.action==='user')return parseUser(result,route.target);
  if(route.action==='user-save')return parseUserResult(result,{commandId:args.p_command_id,target:route.target,input:route.input});
  if(result&&typeof result==='object'&&result.scope==='access_invite')return parseInvitePending(result,{commandId:args.p_command_id});
  return parseUserResult(result,{commandId:args.p_command_id,lookup:true});
 },
 contractError:e=>e instanceof AccessUsersContractError||e instanceof PermissionsContractError,
 /** Controls: the database command, then the Auth flag that makes the Worker check the access windows at every request of the
  * user (app_metadata.brufap_access_gate). Once the database answered, a lost flag update is "unconfirmed": the same command,
  * sent again, replays the receipt and sets the flag again. */
 async saveControls(route,args,{rpc,authAdmin,options}){
  if(typeof authAdmin!=='function')throw new PreferencesError(503,'ERP_USERS_INVITE_UNAVAILABLE');
  const value=parseControlsResult(await rpc(route.rpc,args,options),{target:route.target,input:route.input});
  try{await authAdmin(route.target,{brufap_access_gate:value.controls.gate_required},options);}catch{throw new PreferencesError(503,'ERP_RESULT_UNCONFIRMED');}
  return value;
 },
 /** Invite: begin (recorded) → Supabase Auth invite (only when no account exists yet) → complete (membership by UUID). */
 async invite(route,args,{rpc,authInvite,options}){
  if(typeof authInvite!=='function')throw new PreferencesError(503,'ERP_USERS_INVITE_UNAVAILABLE');
  const begun=await rpc('erp_access_user_invite_begin',args,options);
  if(begun&&typeof begun==='object'&&begun.scope==='access_user_command')return{dispatched:false,value:parseUserResult(begun,{commandId:args.p_command_id,invite:route.input})};
  const pending=parseInvitePending(begun,{commandId:args.p_command_id,email:route.input.email});
  let target=pending.existing_user_id,dispatched=false;
  if(!target){dispatched=true;let answer;
   // A definitive Auth refusal (no SMTP yet, e-mail rate limit) left no account: say so instead of "unconfirmed".
   try{answer=await authInvite(route.input.email,options);}catch(e){if(e&&e.status===422&&e.code==='ERP_USERS_INVITE_REFUSED')throw new PreferencesError(422,'ERP_USERS_INVITE_REFUSED');throw e;}
   target=parseAuthInvite(answer,route.input.email).id;}
  // Once this request has asked Auth to invite, a refusal of "complete" is no longer a refusal of the whole command: the
  // e-mail may already be on its way. Only the same command, read back, can tell what happened.
  try{
   const done=await rpc('erp_access_user_invite_complete',{p_user_id:args.p_user_id,p_command_id:args.p_command_id,p_target:target},options);
   return{dispatched:true,value:parseUserResult(done,{commandId:args.p_command_id,target,invite:route.input})};
  }catch(e){if(dispatched)throw new PreferencesError(503,'ERP_RESULT_UNCONFIRMED');throw e;}
 }};
