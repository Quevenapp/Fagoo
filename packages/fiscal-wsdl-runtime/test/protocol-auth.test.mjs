import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {route,parsePayload,readBounded} from '../src/protocol.mjs';
import {signRuntimeRequest,verifyRuntimeRequest,digest} from '../src/auth.mjs';
import {actor,command,payload} from './fixtures.mjs';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)),prefix='/internal/v1/fiscal-wsdl',secret=new Uint8Array(32).fill(17),keyId='synthetic',audience='synthetic-wsdl';
test('only confirmed run and command lookup are admitted; every model/operation is explicit',()=>{
 const run=route(prefix+'/run','POST');
 for(const model of ['55','65'])for(const operation of ['protocol','status','authorization','receipt']){
  const p={...payload(),model,operation};assert.deepEqual(parsePayload(bytes(p),run),p);
 }
 const get=route(prefix+'/commands/'+command,'GET');assert.equal(get.commandId,command);assert.deepEqual(parsePayload(new Uint8Array(),get),{});
 for(const path of ['/v1/a1',prefix+'/download',prefix+'/sign',prefix+'/history',prefix+'/run?x=1',prefix+'/run/',prefix+'/commands/'+command.toUpperCase(),prefix+'/commands/'+command+'#x'])assert.throws(()=>route(path,'POST'));
 assert.throws(()=>route(prefix+'/run','GET'));assert.throws(()=>route(prefix+'/commands/'+command,'POST'));assert.throws(()=>parsePayload(bytes({}),get));
});
test('body rejects actor, URL, arbitrary scope, missing confirmation and noncanonical CAS',()=>{
 const run=route(prefix+'/run','POST');
 for(const change of [{actor},{url:'https://synthetic.invalid'},{credential_id:randomUUID()},{nonce:randomUUID()},{xml:'PRIVATE'},{confirmed:false},{expected_a1_version:'1'},{expected_identity_version:0},{expected_identity_version:2147483648},{model:'055'},{operation:'__proto__'}])assert.throws(()=>parsePayload(bytes({...payload(),...change}),run));
 for(const value of [null,[],{},'string'])assert.throws(()=>parsePayload(bytes(value),run));
 const p=payload();delete p.confirmed;assert.throws(()=>parsePayload(bytes(p),run));
 assert.throws(()=>parsePayload(new Uint8Array([0xff]),run));assert.throws(()=>parsePayload(new Uint8Array(4097),run));
});
test('HMAC binds WSDL-only domain, actor, nonce, audience, request path and body hash within60s',async()=>{
 const now=1792152000000,bodyHash=await digest(bytes(payload())),opts={secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method:'POST',path:prefix+'/run',bodyHash,now};
 const header=await signRuntimeRequest(opts),check={header,secretBytes:secret,keyId,audience,method:opts.method,path:opts.path,now};
 const claims=await verifyRuntimeRequest(check);assert.equal(claims.actor,actor);assert.equal(claims.body_hash,bodyHash);
 // HTTP transport replay is not itself a one-use grant; SQL051 enforces that invariant.
 assert.deepEqual(await verifyRuntimeRequest(check),claims);
 for(const change of [{audience:'other-wsdl'},{keyId:'other'},{path:prefix+'/commands/'+command},{method:'GET'},{now:now+60001},{now:now-5001}])await assert.rejects(()=>verifyRuntimeRequest({...check,...change}));
 const [id,encoded]=header.slice('Brufap-Wsdl '.length).split('.');
 for(const domain of ['brufap-a1-request-v1','brufap-unsigned-request-v1','brufap-signed-request-v1']){
  const mac=createHmac('sha256',secret).update(`${domain}.${id}.${encoded}`).digest('hex');
  await assert.rejects(()=>verifyRuntimeRequest({...check,header:`Brufap-Wsdl ${id}.${encoded}.${mac}`}));
 }
 for(const change of [{actor:'x'},{nonce:'x'},{audience:'synthetic-signed'},{path:'/internal/v1/fiscal-signed/run'},{bodyHash:'bad'}])await assert.rejects(()=>signRuntimeRequest({...opts,...change}));
});
test('body reader bounds slow or compressed bodies, length mismatch, cancellation and caller-owned chunks',async()=>{
 for(const headers of [{'content-encoding':'gzip'},{'content-length':'4097'},{'content-length':'2'}])await assert.rejects(()=>readBounded(new Response('x',{headers}),{limit:4096,deadline:Date.now()+1000}));
 let cancelled=false;await assert.rejects(()=>readBounded(new Response(new ReadableStream({cancel(){cancelled=true;}})),{limit:4096,deadline:Date.now()+20}));assert.equal(cancelled,true);
 const signal=new AbortController();signal.abort();await assert.rejects(()=>readBounded(new Response('x'),{limit:4096,deadline:Date.now()+1000,signal:signal.signal}));
 const chunk=new Uint8Array([1,2]);const output=await readBounded(new Response(new ReadableStream({start(c){c.enqueue(chunk);c.close();}})),{limit:4096,deadline:Date.now()+1000});
 assert.deepEqual(output,chunk);assert.deepEqual(chunk,new Uint8Array([1,2]));
});
