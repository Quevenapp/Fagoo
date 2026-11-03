import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRpc} from '../src/rpc.mjs';
import {createAuthorizationStorage} from '../src/storage.mjs';
import {hash} from './service-fixtures.mjs';
const actor=randomUUID(),command=randomUUID(),projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='SYNTHETIC_PRIVATE_SERVICE_KEY_ONLY';
const args=()=>({p_user_id:actor,p_command_id:command}),opts=()=>({deadline:Date.now()+45000});
const rpc=fetchImpl=>createAuthorizationRpc({projectUrl,serviceKey,fetchImpl});
const error=code=>e=>e.code===code&&e.message===code&&!JSON.stringify(e).includes('PRIVATE_SENTINEL');
test('RPC allowlist requires exact own arguments; no write050 or caller getters',async()=>{
 let count=0;const call=rpc(async()=>{count++;return Response.json({});});
 for(const name of ['erp_fiscal_signed_use','erp_a1_metadata','arbitrary'])await assert.rejects(call(name,args(),opts()),error('AUTHORIZATION_RPC_UNSUPPORTED'));
 await assert.rejects(call('erp_fiscal_authorization_command',{...args(),extra:1},opts()));
 let accessed=0;const bad=args();Object.defineProperty(bad,'p_user_id',{get(){accessed++;return actor;}});await assert.rejects(call('erp_fiscal_authorization_command',bad,opts()));assert.equal(accessed,0);assert.equal(count,0);
});
test('RPC captures actor/body/signal before await and strips private SQL messages',async()=>{
 let release,seen;const ready=new Promise(r=>release=r);const call=rpc(async(url,o)=>{await ready;seen={url,body:JSON.parse(Buffer.from(o.body).toString()),signal:o.signal,headers:o.headers};return Response.json({code:'42501',message:'PRIVATE_SENTINEL',details:serviceKey},{status:403});});
 const a=args(),controller=new AbortController(),o={...opts(),signal:controller.signal};const p=call('erp_fiscal_authorization_command',a,o);a.p_user_id=randomUUID();o.signal=new AbortController().signal;release();await assert.rejects(p,error('42501'));assert.equal(seen.body.p_user_id,actor);assert.equal(seen.body.p_command_id,command);assert.equal(seen.url,projectUrl+'/rest/v1/rpc/erp_fiscal_authorization_command');assert.equal(seen.headers['Accept-Encoding'],'identity');
});
test('RPC rejects redirect, compressed, oversized, partial and nonUTF8 metadata',async()=>{
 const cases=[new Response('',{status:302}),new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'131073'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'8'}}),new Response(Uint8Array.from([255]),{headers:{'content-type':'application/json'}})];
 for(const response of cases)await assert.rejects(rpc(async()=>response)('erp_fiscal_authorization_command',args(),opts()));
});
test('RPC timeout and caller abort bound an ignoring driver and cancel its late body',async()=>{
 let resolve;const controller=new AbortController(),call=rpc(()=>new Promise(r=>resolve=r)),pending=call('erp_fiscal_authorization_command',args(),{deadline:Date.now()+1000,signal:controller.signal});await Promise.resolve();controller.abort();await assert.rejects(pending,error('AUTHORIZATION_RPC_ABORTED'));let cancelled=0;resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}}));await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,1);
 await assert.rejects(rpc(()=>new Promise(()=>{}))('erp_fiscal_authorization_command',args(),{deadline:Date.now()+10}),error('AUTHORIZATION_RPC_TIMEOUT'));
});
test('Storage paths, immutable byte snapshot and filename hash are captured before await',async()=>{
 let resolve,seen;const ready=new Promise(r=>resolve=r),storage=createAuthorizationStorage({projectUrl,serviceKey,fetchImpl:async(url,o)=>{await ready;seen={url,bytes:Buffer.from(o.body),headers:o.headers};return Response.json({},{status:201});}}),bytes=Buffer.from('synthetic XML'),tag=hash(bytes),attempt=randomUUID(),key=`authorization/${attempt}/requests/${tag}.xml`;
 const input={bucket:'brufap-fiscal-artifacts',key,bytes,sha256:tag,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',deadline:Date.now()+45000};const pending=storage.putImmutable(input);bytes.fill(0);input.key=`authorization/${randomUUID()}/responses/${tag}.xml`;resolve();assert.deepEqual(await pending,{status:201,requires_readback:true});assert.ok(seen.url.endsWith(key));assert.equal(hash(seen.bytes),tag);assert.equal(seen.headers['x-upsert'],'false');
 await assert.rejects(storage.putImmutable({...input,key,bytes:Buffer.from('other bytes')}));await assert.rejects(storage.read({bucket:'brufap-a1-vault',key,deadline:Date.now()+1000}));await assert.rejects(storage.read({bucket:'brufap-fiscal-artifacts',key:'../credentials/private',deadline:Date.now()+1000}));
});
test('Storage absence is exact provider code and responses are hash-bounded with immutable conflict readback',async()=>{
 const tag=hash('body'),key=`authorization/${randomUUID()}/processed/${tag}.xml`,input={bucket:'brufap-fiscal-artifacts',key,deadline:Date.now()+1000};
 for(const [status,body,absent]of [[404,{code:'NoSuchKey'},true],[400,{code:'NoSuchKey',statusCode:'404'},true],[404,{code:'NoSuchBucket'},false],[400,{code:'NoSuchKey'},false]]){const s=createAuthorizationStorage({projectUrl,serviceKey,fetchImpl:async()=>Response.json(body,{status})});if(absent)assert.equal(await s.read(input),null);else await assert.rejects(s.read(input));}
 const s=createAuthorizationStorage({projectUrl,serviceKey,fetchImpl:async()=>new Response('wrong',{headers:{'content-type':'application/octet-stream'}})});await assert.rejects(s.read(input),error('AUTHORIZATION_STORAGE_HASH_CONFLICT'));
});
