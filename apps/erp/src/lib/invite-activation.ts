/** Invitation activation and, since leva H (PRF-291), the password recovery link of an existing account (same page, same
 * transient client). No ERP membership, signup, email delivery or admin API. */
export const ACTIVATION_PATH='/ativar-acesso';
export const ACTIVATION_AUTH_OPTIONS=Object.freeze({persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:'brufap.erp.invite.transient'});
export type ActivationState=Readonly<{phase:'awaiting_confirmation'|'invalid_link'|'verifying'|'ready'|'saving'|'complete'|'password_unconfirmed'|'unavailable'|'disposed';email:string|null;message:string|null;passwordIssue:'too_short'|'too_long'|'mismatch'|'invalid_characters'|'rejected'|null}>;
export interface InviteAuthPort{
 verifyOtp(parameters:{token_hash:string;type:ActivationFlow}):Promise<unknown>;
 setSession(parameters:{access_token:string;refresh_token:string}):Promise<unknown>;
 getUser():Promise<unknown>;
 updateUser(attributes:{password:string}):Promise<unknown>;
}
type Options={href:string;expectedOrigin:string;replaceUrl:(path:string)=>void;createAuth:()=>InviteAuthPort;abortRequests:()=>void;clearSession:()=>void;endSession?:()=>Promise<void>;timeoutMs?:number};
export type ActivationFlow='invite'|'recovery';
const FLOWS:readonly string[]=['invite','recovery'];
type Handoff=({kind:'hash';token:string}|{kind:'session';access:string;refresh:string})&{flow:ActivationFlow};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const validTime=(value:unknown)=>typeof value==='string'&&value.length<50&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value));
function trustedOrigin(origin:string):boolean{try{const u=new URL(origin);return u.origin===origin&&!u.username&&!u.password&&(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname));}catch{return false;}}
function parameters(raw:string,allowed:string[]):URLSearchParams|null{
 if(raw.length>16000||/%(?![0-9a-f]{2})/i.test(raw))return null;const p=new URLSearchParams(raw),seen=new Set();for(const[key]of p){if(!allowed.includes(key)||seen.has(key))return null;seen.add(key);}return p;
}
/** Capture occurs before client construction in the integration layer; replaceUrl must be synchronous. */
function capture(href:string,expectedOrigin:string,replaceUrl:(path:string)=>void):Handoff|null{
 let url:URL;try{if(!trustedOrigin(expectedOrigin))return null;url=new URL(href);}catch{return null;}
 if(url.origin!==expectedOrigin||url.username||url.password||url.pathname!==ACTIVATION_PATH)return null;
 // Even malformed, expired or rejected invitations must not remain in browser history.
 try{replaceUrl(ACTIVATION_PATH);}catch{return null;}
 if(href.length>20000||url.search&&url.hash)return null;
 if(url.search){const q=parameters(url.search.slice(1),['token_hash','type']);if(!q||q.size!==2||!FLOWS.includes(q.get('type')??'')||! /^[A-Za-z0-9_-]{32,256}$/.test(q.get('token_hash')??''))return null;return{kind:'hash',token:q.get('token_hash')!,flow:q.get('type') as ActivationFlow};}
 if(url.hash){const p=parameters(url.hash.slice(1),['access_token','refresh_token','token_type','type','expires_in','expires_at']);if(!p||!FLOWS.includes(p.get('type')??'')||p.get('token_type')!=='bearer')return null;const access=p.get('access_token')??'',refresh=p.get('refresh_token')??'';
  if(access.length>12000||! /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(access)||! /^[A-Za-z0-9_-]{8,1024}$/.test(refresh))return null;
  for(const key of['expires_in','expires_at'])if(p.has(key)&&! /^[1-9]\d{0,12}$/.test(p.get(key)!))return null;
  return{kind:'session',access,refresh,flow:p.get('type') as ActivationFlow};
 }
 return null;
}
function verifiedUser(value:unknown):{id:string;email:string}|null{
 if(!object(value)||value.error!==null||!object(value.data)||!object(value.data.user))return null;const u=value.data.user;
 if(!uuid(u.id)||typeof u.email!=='string'||u.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)||u.is_anonymous===true||!validTime(u.email_confirmed_at)||!validTime(u.invited_at))return null;
 return{id:(u.id as string).toLowerCase(),email:u.email};
}
function sessionUserId(value:unknown):string|null{if(!object(value)||value.error!==null||!object(value.data)||!object(value.data.session)||!object(value.data.session.user)||!uuid(value.data.session.user.id)||typeof value.data.session.access_token!=='string'||!value.data.session.access_token)return null;return(value.data.session.user.id as string).toLowerCase();}
export function activationPasswordIssue(password:string,confirmation:string):ActivationState['passwordIssue']{
 if(typeof password!=='string'||typeof confirmation!=='string'||/[\x00-\x1f\x7f]/.test(password))return'invalid_characters';
 if(Array.from(password).length<12)return'too_short';if(new TextEncoder().encode(password).byteLength>72)return'too_long';if(password!==confirmation)return'mismatch';return null;
}
const invalidMessage='O convite está ausente, expirado ou não pode ser usado nesta página. Solicite um novo convite ao administrador.';
/** Own the supplied Auth client exclusively. It must use transient storage and the options above. */
export function createInviteActivation(options:Options){
 const {abortRequests,clearSession,endSession}=options;
 let handoff=capture(options.href,options.expectedOrigin,options.replaceUrl);const flow:ActivationFlow=handoff?.flow??'invite';let identity:{id:string;email:string}|null=null,disposed=false,busy=false,generation=0;
 let state:ActivationState=Object.freeze({phase:handoff?'awaiting_confirmation':'invalid_link',email:null,message:handoff?null:invalidMessage,passwordIssue:null});
 const listeners=new Set<()=>void>(),timeoutMs=options.timeoutMs??15000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw new Error('ACTIVATION_CONFIGURATION_INVALID');
 // Construct the isolated client only after URL scrubbing, and never for invalid input.
 let auth:InviteAuthPort|null=null;
 if(handoff){try{auth=options.createAuth();}catch{handoff=null;state=Object.freeze({phase:'unavailable',email:null,message:'Não foi possível preparar a ativação. Solicite orientação ao administrador.',passwordIssue:null});try{clearSession();}catch{/* Never expose client initialization details. */}}}
 const emit=(next:ActivationState)=>{if(disposed)return;state=Object.freeze(next);for(const listener of listeners){try{listener();}catch{/* UI subscribers must not alter the authentication outcome. */}}};
 const clear=()=>{handoff=null;identity=null;try{clearSession();}catch{/* Never expose session/SDK errors. */}};
 const request=async<T>(run:()=>Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([run().finally(()=>{if(disposed||['unavailable','password_unconfirmed','complete'].includes(state.phase)){try{clearSession();}catch{/* Late results must not restore transient credentials. */}}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{try{abortRequests();}catch{/* No error payload. */}reject(new Error('ACTIVATION_TIMEOUT'));},timeoutMs);})]);}finally{if(timer)clearTimeout(timer);}};
 return{
  getSnapshot:()=>state,
  /** 'recovery' for a password recovery link, 'invite' otherwise (also for an invalid link). */
  flow,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  async verify(){
   if(disposed||busy||state.phase!=='awaiting_confirmation'||!handoff)return;busy=true;const current=++generation,input=handoff;handoff=null;emit({phase:'verifying',email:null,message:null,passwordIssue:null});
   try{const response=await request(()=>input.kind==='hash'?auth!.verifyOtp({token_hash:input.token,type:input.flow}):auth!.setSession({access_token:input.access,refresh_token:input.refresh}));if(disposed||current!==generation)return;const sessionId=sessionUserId(response);if(!sessionId)throw new Error('ACTIVATION_REJECTED');const user=verifiedUser(await request(()=>auth!.getUser()));if(disposed||current!==generation)return;if(!user||user.id!==sessionId)throw new Error('ACTIVATION_IDENTITY_MISMATCH');identity=user;emit({phase:'ready',email:user.email,message:null,passwordIssue:null});}
   catch{if(!disposed&&current===generation){clear();emit({phase:'unavailable',email:null,message:invalidMessage,passwordIssue:null});}}
   finally{busy=false;if(disposed){try{clearSession();}catch{/* Disposed clients never retain a late session. */}}input.kind==='hash'?input.token='':(input.access='',input.refresh='');}
  },
  async setPassword(password:string,confirmation:string){
   if(disposed||busy||state.phase!=='ready'||!identity)return;const issue=activationPasswordIssue(password,confirmation);if(issue){emit({...state,passwordIssue:issue,message:'Confira a senha e a confirmação.'});return;}
   busy=true;const current=++generation,expected={...identity};let attempted=false;emit({phase:'saving',email:expected.email,message:null,passwordIssue:null});
   try{
    const user=verifiedUser(await request(()=>auth!.getUser()));if(disposed||current!==generation)return;if(!user||user.id!==expected.id||user.email!==expected.email)throw new Error('ACTIVATION_IDENTITY_MISMATCH');
    attempted=true;const response=await request(()=>auth!.updateUser({password}));if(disposed||current!==generation)return;
    if(object(response)&&object(response.error)&&response.error.code==='weak_password'){emit({phase:'ready',email:expected.email,message:'Escolha uma senha que atenda às regras de segurança da conta.',passwordIssue:'rejected'});return;}
    const updated=verifiedUser(response);if(!updated||updated.id!==expected.id||updated.email!==expected.email)throw new Error('ACTIVATION_RESPONSE_INVALID');
    // Password success is already confirmed. A failed local-scope logout must not
    // turn that acknowledgement into a false failure or imply global revocation.
    if(endSession){try{await request(endSession);}catch{/* Transient client is discarded below even if server logout cannot be confirmed. */}}
    clear();emit({phase:'complete',email:null,message:'Senha definida. Entre com seu e-mail e senha; o acesso à empresa depende da liberação do administrador.',passwordIssue:null});
   }catch{if(!disposed&&current===generation){clear();emit({phase:attempted?'password_unconfirmed':'unavailable',email:null,message:attempted?'Não foi possível confirmar a alteração. Ela pode ter sido concluída. Tente entrar com a senha escolhida antes de solicitar um novo convite.':'Não foi possível verificar a sessão do convite. Solicite um novo convite ao administrador.',passwordIssue:null});}}
   finally{busy=false;password='';confirmation='';}
  },
  dispose(){if(disposed)return;disposed=true;generation++;handoff=null;identity=null;try{abortRequests();}catch{/* No error payload. */}try{clearSession();}catch{/* No error payload. */}listeners.clear();state=Object.freeze({phase:'disposed',email:null,message:null,passwordIssue:null});}
 };
}
