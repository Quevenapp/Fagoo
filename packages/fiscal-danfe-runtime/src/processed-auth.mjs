import {need,exact,uuid,sha256,route} from './processed-protocol.mjs';
const ALG={name:'HMAC',hash:'SHA-256'},TEXT=new TextEncoder(),DOMAIN='brufap-danfe-request-v1';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex=value=>Uint8Array.from(value.match(/../g),byte=>parseInt(byte,16));
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const audienceValid=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}-danfe$/.test(v);
export async function digest(bytes){need(bytes instanceof Uint8Array,400,'DANFE_INVALID_REQUEST');return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));}
function checked(value,{audience,method,path,now}){
 need(exact(value,['version','audience','actor','nonce','issued_at_ms','method','path','body_hash'])&&value.version===1&&audienceValid(audience)
  &&value.audience===audience&&uuid(value.actor)&&uuid(value.nonce)&&sha256(value.body_hash)&&value.method===method&&value.path===path
  &&Number.isSafeInteger(now)&&Number.isSafeInteger(value.issued_at_ms)&&value.issued_at_ms>=now-60000&&value.issued_at_ms<=now+5000,401,'DANFE_RUNTIME_UNAUTHORIZED');
 try{route(path,method);}catch{need(false,401,'DANFE_RUNTIME_UNAUTHORIZED');}return Object.freeze(value);
}
export async function signRuntimeRequest({secretBytes,keyId,audience,actor,nonce,method,path,bodyHash,now=Date.now()}){
 need(secretBytes instanceof Uint8Array&&secretBytes.length===32&&typeof keyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(keyId)&&audienceValid(audience),503,'DANFE_GATEWAY_UNAVAILABLE');
 const claims=checked({version:1,audience,actor,nonce,issued_at_ms:now,method,path,body_hash:bodyHash},{audience,method,path,now});
 const encoded=b64(TEXT.encode(JSON.stringify(claims))),key=await crypto.subtle.importKey('raw',secretBytes,ALG,false,['sign']);
 return `Brufap-Danfe ${keyId}.${encoded}.${hex(new Uint8Array(await crypto.subtle.sign(ALG,key,TEXT.encode(`${DOMAIN}.${keyId}.${encoded}`))))}`;
}
/** Transport replay is allowed within its time window. Every invocation reauthorizes a read; there are no mutation/dispatch grants. */
export async function verifyRuntimeRequest({header,secretBytes,keyId,audience,method,path,now=Date.now()}){
 need(typeof header==='string'&&header.length<=4200&&secretBytes instanceof Uint8Array&&secretBytes.length===32,401,'DANFE_RUNTIME_UNAUTHORIZED');
 const match=/^Brufap-Danfe ([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,4000})\.([a-f0-9]{64})$/.exec(header);
 need(match&&match[1]===keyId,401,'DANFE_RUNTIME_UNAUTHORIZED');
 const key=await crypto.subtle.importKey('raw',secretBytes,ALG,false,['verify']);
 need(await crypto.subtle.verify(ALG,key,unhex(match[3]),TEXT.encode(`${DOMAIN}.${match[1]}.${match[2]}`)),401,'DANFE_RUNTIME_UNAUTHORIZED');
 let value;try{
  const raw=Uint8Array.from(atob(match[2].replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-match[2].length%4)%4)),c=>c.charCodeAt(0));
  need(b64(raw)===match[2],401,'DANFE_RUNTIME_UNAUTHORIZED');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 }catch{need(false,401,'DANFE_RUNTIME_UNAUTHORIZED');}
 return checked(value,{audience,method,path,now});
}
