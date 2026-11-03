import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {route,parsePayload,readBounded} from '../src/protocol.mjs';
import {digest,signRuntimeRequest,verifyRuntimeRequest} from '../src/auth.mjs';
import {signRuntimeRequest as signA1} from '../../fiscal-runtime/src/auth.mjs';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)),code=c=>error=>error.code===c;
const base='/internal/v1/fiscal-unsigned';
test('strict unsigned route/body allowlists never accept actor, identity, arbitrary path or number inputs',()=>{
 const id=randomUUID(),preview=route(base+'/preview','POST'),generate=route(base+'/generate','POST'),history=route(base+'/history','POST');
 assert.deepEqual(parsePayload(bytes({draft_id:id,completion_version:1}),preview),{draft_id:id,completion_version:1});
 const payload={command_id:randomUUID(),reservation_id:randomUUID(),draft_id:id,completion_version:1,completion_hash:'a'.repeat(64),basis_hash:'b'.repeat(64)};
 assert.deepEqual(parsePayload(bytes(payload),generate),payload);assert.deepEqual(parsePayload(bytes({reservation_id:id,limit:25,before:null}),history),{reservation_id:id,limit:25,before:null});
 for(const extra of[{actor:id},{number:'1'},{identity:{}},{storage_path:'x'}])assert.throws(()=>parsePayload(bytes({...payload,...extra}),generate),code('UNSIGNED_INVALID_REQUEST'));
 for(const value of[{reservation_id:id,limit:26,before:null},{reservation_id:id,limit:25,before:0},{reservation_id:id,limit:25},{reservation_id:id,limit:25,before:'1'}])assert.throws(()=>parsePayload(bytes(value),history));
 for(const path of[base,base+'/jobs/'+id.toUpperCase(),base+'/jobs/'+id+'/',base+'/jobs/%2e%2e',base+'/preview?x=1','/internal/v1/a1'])assert.throws(()=>route(path,'GET'));
 assert.throws(()=>route(base+'/preview','GET'),code('UNSIGNED_METHOD_NOT_ALLOWED'));assert.throws(()=>route(base+'/jobs/'+id,'POST'),code('UNSIGNED_METHOD_NOT_ALLOWED'));
 assert.deepEqual(parsePayload(new Uint8Array(),route(base+'/jobs/'+id,'GET')),{});assert.throws(()=>parsePayload(bytes({}),route(base+'/jobs/'+id,'GET')));
 assert.throws(()=>parsePayload(new Uint8Array([0xc3,0x28]),preview),code('UNSIGNED_BODY_INVALID'));
});
test('body limits, declared lengths, coding, deadline and abort include the entire stream',async()=>{
 const opts={limit:4,deadline:Date.now()+1000};
 assert.equal(new TextDecoder().decode(await readBounded(new Response('abcd'),opts)),'abcd');
 await assert.rejects(()=>readBounded(new Response('abcde'),opts),code('UNSIGNED_BODY_TOO_LARGE'));
 await assert.rejects(()=>readBounded(new Response('x',{headers:{'content-length':'2'}}),opts),code('UNSIGNED_BODY_INVALID'));
 await assert.rejects(()=>readBounded(new Response('x',{headers:{'content-encoding':'gzip'}}),opts),code('UNSIGNED_ENCODING_UNSUPPORTED'));
 let cancelled=false;const stalled=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}}));
 await assert.rejects(()=>readBounded(stalled(),{limit:4,deadline:Date.now()+20}),code('UNSIGNED_BODY_TIMEOUT'));assert.equal(cancelled,true);
 cancelled=false;const abort=new AbortController(),pending=readBounded(stalled(),{limit:4,signal:abort.signal,deadline:Date.now()+1000});abort.abort();
 await assert.rejects(()=>pending,code('UNSIGNED_UPSTREAM_UNAVAILABLE'));assert.equal(cancelled,true);
});
test('HMAC binds actor, path, method, body, time and audience with a separate domain from A1',async()=>{
 const secretBytes=randomBytes(32),actor=randomUUID(),nonce=randomUUID(),now=Date.now(),bodyHash=await digest(bytes({x:1}));
 const claims={secretBytes,keyId:'synthetic',audience:'test-runtime-unsigned',actor,nonce,method:'POST',path:base+'/preview',bodyHash,now};
 const header=await signRuntimeRequest(claims),check={...claims,header};
 const verified=await verifyRuntimeRequest(check);assert.equal(verified.actor,actor);assert.equal(verified.body_hash,bodyHash);assert.ok(Object.isFrozen(verified));
 assert.equal((await verifyRuntimeRequest(check)).nonce,nonce); // Not advertised as a single-use token.
 for(const patch of[{audience:'other-unsigned'},{method:'GET'},{path:base+'/generate'},{keyId:'other'},{now:now+60001},{now:now-5001},{header:header.slice(0,-1)+(header.at(-1)==='0'?'1':'0')}])await assert.rejects(()=>verifyRuntimeRequest({...check,...patch}),code('UNSIGNED_RUNTIME_UNAUTHORIZED'));
 const a1=await signA1({...claims,audience:'test-runtime',path:'/internal/v1/a1',method:'GET'});
 await assert.rejects(()=>verifyRuntimeRequest({...check,header:a1}),code('UNSIGNED_RUNTIME_UNAUTHORIZED'));
 await assert.rejects(()=>verifyRuntimeRequest({...check,header:a1.replace('Brufap-A1 ','Brufap-Unsigned ')}),code('UNSIGNED_RUNTIME_UNAUTHORIZED'));
 await assert.rejects(()=>signRuntimeRequest({...claims,audience:'test-runtime'}));secretBytes.fill(0);
});
