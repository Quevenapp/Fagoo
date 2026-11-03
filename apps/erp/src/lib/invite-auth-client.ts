import type {AccessConfig} from './access-config';
import {ACTIVATION_AUTH_OPTIONS,type InviteAuthPort} from './invite-activation.ts';

const stopped=()=>new DOMException('Activation stopped','AbortError');
/** Lazy, dedicated SDK client. No persistent storage or shared ERP session. */
export function createTransientInviteAuth(config:AccessConfig,fetcher:typeof fetch=fetch){
 type ClientAuth=InviteAuthPort&{signOut(options:{scope:'local'}):Promise<unknown>;dispose():Promise<void>};
 let closed=false,ending=false,loaded:Promise<ClientAuth>|null=null,cleanup:(()=>Promise<void>)|null=null;
 const requests=new Set<AbortController>();
 const abortRequests=()=>{closed=true;for(const request of requests)request.abort();requests.clear();};
 const clearSession=()=>{abortRequests();const remove=cleanup;cleanup=null;loaded=null;if(remove)void remove().catch(()=>{});};
 const authFetch:typeof fetch=async(input,init={})=>{
  if(closed)throw stopped();let url:URL;try{url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);}catch{throw stopped();}
  const method=(init.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  const allowed=url.origin===config.supabaseUrl&&!url.username&&!url.password&&!url.hash&&(
   (url.pathname==='/auth/v1/verify'&&method==='POST'&&!url.search)||
   (url.pathname==='/auth/v1/user'&&['GET','PUT'].includes(method)&&!url.search)||
   (url.pathname==='/auth/v1/token'&&method==='POST'&&url.search==='?grant_type=refresh_token')||
   (ending&&url.pathname==='/auth/v1/logout'&&method==='POST'&&url.search==='?scope=local'));
  if(!allowed)throw stopped();
  const controller=new AbortController();requests.add(controller);const incoming=init.signal??(input instanceof Request?input.signal:null),signal=incoming?AbortSignal.any([incoming,controller.signal]):controller.signal;
  try{
   const response=await fetcher(input,{...init,method,credentials:'omit',cache:'no-store',redirect:'error',signal});
   if(closed||signal.aborted||response.status>=300&&response.status<400){await response.body?.cancel();throw stopped();}
   if(response.status===204&&ending&&url.pathname==='/auth/v1/logout')return new Response(null,{status:204,headers:response.headers});
   if(!response.body||Number(response.headers.get('content-length'))>524288){await response.body?.cancel();throw new Error('ACTIVATION_RESPONSE_LIMIT');}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const next=await reader.read();if(closed||signal.aborted)throw stopped();if(next.done)break;length+=next.value.byteLength;if(length>524288)throw new Error('ACTIVATION_RESPONSE_LIMIT');chunks.push(next.value);}}finally{try{await reader.cancel();}catch{/* No response payload. */}reader.releaseLock();}
   const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
   return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }finally{requests.delete(controller);}
 };
 const get=():Promise<ClientAuth>=>{
  if(closed)return Promise.reject(stopped());
  return loaded??=(async()=>{
   const{createClient}=await import('@supabase/supabase-js');if(closed)throw stopped();
   const client=createClient(config.supabaseUrl,config.publicKey,{auth:{...ACTIVATION_AUTH_OPTIONS,debug:false},global:{fetch:authFetch}});
   // Initialization can install a visibility callback even when automatic refresh is off.
   // Finish it and remove that callback before retaining the isolated instance.
   try{
    await client.auth.initialize();await client.auth.stopAutoRefresh();
    if(closed)throw stopped();
    cleanup=()=>client.auth.dispose();
    return client.auth;
   }catch(error){await client.auth.dispose().catch(()=>{});throw error;}
  })();
 };
 const call=async(method:keyof InviteAuthPort,args:unknown[])=>{if(ending)throw stopped();const client=await get();if(closed||ending)throw stopped();try{const value=await(client[method] as(...args:unknown[])=>Promise<unknown>).apply(client,args);if(closed)throw stopped();return value;}finally{if(closed)await client.dispose();}};
 const auth:InviteAuthPort={verifyOtp:args=>call('verifyOtp',[args]),setSession:args=>call('setSession',[args]),getUser:()=>call('getUser',[]),updateUser:args=>call('updateUser',[args])};
 const endSession=async()=>{if(closed||ending||!loaded)return;const client=await get();if(closed)return;ending=true;try{await client.signOut({scope:'local'});}finally{await client.dispose();clearSession();}};
 return{auth,abortRequests,clearSession,endSession};
}
