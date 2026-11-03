import {randomUUID} from 'node:crypto';
import {signRuntimeRequest,digest} from '../src/auth.mjs';
export * from '../../fiscal-authorization-http/test/fixtures.mjs';
import {actor} from '../../fiscal-authorization-http/test/fixtures.mjs';
export const secret=new Uint8Array(32).fill(19),keyId='synthetic-key',audience='synthetic-authorization';
export const env=()=>({ALLOWED_ORIGINS:'https://app.synthetic.invalid',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:Buffer.from(secret).toString('base64'),A1_TRANSPORT_KEY_ID:keyId,A1_AUDIENCE:'synthetic'});
export async function internal(path,body,{origin='http://runtime.internal',header,signal,now=Date.now(),actorId=actor}={}){
 const method=body===undefined?'GET':'POST',bytes=body===undefined?new Uint8Array():new TextEncoder().encode(JSON.stringify(body)),full='/internal/v1/fiscal-authorization'+path;
 const authorization=header??await signRuntimeRequest({secretBytes:secret,keyId,audience,actor:actorId,nonce:randomUUID(),method,path:full,bodyHash:await digest(bytes),now});
 return new Request(origin+full,{method,headers:{Authorization:authorization,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:bytes}),signal});
}
export function external(path,body,options={}){return new Request('https://gateway.synthetic.invalid/v1/fiscal-authorization'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://app.synthetic.invalid',Authorization:'Bearer synthetic-session-12345678901234567890',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),...options});}
export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
export function bounded(promise){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST_DEADLINE')),2000);})]).finally(()=>clearTimeout(timer));}
