import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {route,parsePayload,readBounded} from '../src/protocol.mjs';
import {signRuntimeRequest,verifyRuntimeRequest,digest} from '../src/auth.mjs';
const prefix='/internal/v1/fiscal-reconciliation',actor=randomUUID(),command=randomUUID(),candidate=randomUUID();
const bytes=v=>new TextEncoder().encode(JSON.stringify(v));
const payload=()=>({command_id:command,candidate_id:candidate,signed_hash:'a'.repeat(64),expected_a1_version:1,expected_identity_version:1,confirmed:true});
const secret=new Uint8Array(32).fill(17),keyId='synthetic',audience='synthetic-reconciliation';

test('run, read-only history, command and recovery have distinct closed request shapes',()=>{
 const run=route(prefix+'/run','POST');assert.deepEqual(parsePayload(bytes(payload()),run),payload());
 const recover=route(prefix+'/recover','POST');assert.deepEqual(parsePayload(bytes({command_id:command}),recover),{command_id:command});
 const history=route(prefix+'/candidates/'+candidate+'/history','POST');assert.equal(history.candidateId,candidate);
 for(const before of [null,'1','9223372036854775807'])assert.deepEqual(parsePayload(bytes({limit:25,before}),history),{limit:25,before});
 for(const before of [1,'0','01','9223372036854775808','1e2'])assert.throws(()=>parsePayload(bytes({limit:25,before}),history));
 for(const limit of [0,26,'25'])assert.throws(()=>parsePayload(bytes({limit,before:null}),history));
 const get=route(prefix+'/commands/'+command,'GET');assert.equal(get.commandId,command);assert.deepEqual(parsePayload(new Uint8Array(),get),{});
 for(const path of ['/v1/a1',prefix+'/download',prefix+'/sign',prefix+'/history',prefix+'/run?x=1',prefix+'/run/',prefix+'/commands/'+command.toUpperCase(),prefix+'/commands/'+command+'#x'])assert.throws(()=>route(path,'POST'));
 assert.throws(()=>route(prefix+'/run','GET'));assert.throws(()=>route(prefix+'/commands/'+command,'POST'));
 assert.throws(()=>parsePayload(bytes({}),get));assert.throws(()=>parsePayload(bytes({...payload()}),recover));
});

test('caller cannot supply actor, key, destination, credentials, trust or unconfirmed versions',()=>{
 const run=route(prefix+'/run','POST');
 for(const change of [{actor},{url:'https://synthetic.invalid'},{access_key:'1'.repeat(44)},{credential_id:randomUUID()},{nonce:randomUUID()},{xml:'PRIVATE'},{confirmed:false},{expected_a1_version:'1'},{expected_identity_version:0},{expected_identity_version:2147483648},{signed_hash:'A'.repeat(64)},{origin:'sefaz'}])assert.throws(()=>parsePayload(bytes({...payload(),...change}),run));
 for(const value of [null,[],{},'string'])assert.throws(()=>parsePayload(bytes(value),run));
 const p=payload();delete p.confirmed;assert.throws(()=>parsePayload(bytes(p),run));
 assert.throws(()=>parsePayload(new Uint8Array([0xff]),run));assert.throws(()=>parsePayload(new Uint8Array(4097),run));
});

test('HMAC binds the reconciliation domain, actor, path, body and 60-second window',async()=>{
 const now=1792152000000,bodyHash=await digest(bytes(payload())),opts={secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method:'POST',path:prefix+'/run',bodyHash,now};
 const header=await signRuntimeRequest(opts),check={header,secretBytes:secret,keyId,audience,method:opts.method,path:opts.path,now};
 const claims=await verifyRuntimeRequest(check);assert.equal(claims.actor,actor);assert.equal(claims.body_hash,bodyHash);
 assert.deepEqual(await verifyRuntimeRequest(check),claims); // SQL owns one-use dispatch, not HMAC replay.
 for(const change of [{audience:'other-reconciliation'},{keyId:'other'},{path:prefix+'/recover'},{method:'GET'},{now:now+60001},{now:now-5001}])await assert.rejects(()=>verifyRuntimeRequest({...check,...change}));
 const [id,encoded]=header.slice('Brufap-Reconciliation '.length).split('.');
 for(const domain of ['brufap-a1-request-v1','brufap-unsigned-request-v1','brufap-signed-request-v1','brufap-wsdl-request-v1']){
  const mac=createHmac('sha256',secret).update(`${domain}.${id}.${encoded}`).digest('hex');
  await assert.rejects(()=>verifyRuntimeRequest({...check,header:`Brufap-Reconciliation ${id}.${encoded}.${mac}`}));
 }
 for(const change of [{actor:'x'},{nonce:'x'},{audience:'synthetic-wsdl'},{path:'/internal/v1/fiscal-wsdl/run'},{bodyHash:'bad'}])await assert.rejects(()=>signRuntimeRequest({...opts,...change}));
});

test('stream limits include slow headers/body, cancellation, size and unsupported encoding',async()=>{
 for(const headers of [{'content-encoding':'gzip'},{'content-length':'4097'},{'content-length':'2'}])await assert.rejects(()=>readBounded(new Response('x',{headers}),{limit:4096,deadline:Date.now()+1000}));
 let cancelled=false;await assert.rejects(()=>readBounded(new Response(new ReadableStream({cancel(){cancelled=true;}})),{limit:4096,deadline:Date.now()+20}));assert.equal(cancelled,true);
 const signal=new AbortController();signal.abort();await assert.rejects(()=>readBounded(new Response('x'),{limit:4096,deadline:Date.now()+1000,signal:signal.signal}));
 const chunk=new Uint8Array([1,2]);const output=await readBounded(new Response(new ReadableStream({start(c){c.enqueue(chunk);c.close();}})),{limit:4096,deadline:Date.now()+1000});
 assert.deepEqual(output,chunk);assert.deepEqual(chunk,new Uint8Array([1,2]));
});
