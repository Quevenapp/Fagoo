import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {route,parsePayload,readBounded} from '../src/protocol.mjs';
import {signRuntimeRequest,verifyRuntimeRequest,digest} from '../src/auth.mjs';
import {publicResult} from '../src/dto.mjs';
import {projectSqlView,projectSqlHistory} from '../src/sql-dto.mjs';
import {response,view,flags,actor,job,command,candidate,hash} from '../../fiscal-signed-rpc/test/fixtures.mjs';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v));
const payload={command_id:command,unsigned_job_id:job,unsigned_hash:hash,basis_hash:hash,expected_a1_version:1};
const prefix='/internal/v1/fiscal-signed',secret=new Uint8Array(32).fill(17),keyId='test',audience='synthetic-signed';
const signed=async(extra={})=>signRuntimeRequest({secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method:'POST',path:prefix+'/run',bodyHash:await digest(bytes(payload)),...extra});
test('routes and payloads are closed; history is an explicitly bounded read POST',()=>{
 const run=route(prefix+'/run','POST');assert.deepEqual(parsePayload(bytes(payload),run),payload);
 const history=route(prefix+`/jobs/${job}/history`,'POST');assert.equal(history.jobId,job);assert.deepEqual(parsePayload(bytes({limit:25,before:null}),history),{limit:25,before:null});
 for(const path of ['/v1/a1',prefix+'/sign',prefix+'/download',prefix+'/run?x=1',prefix+'/run/',prefix+'/candidates/../run',prefix+`/candidates/${candidate.toUpperCase()}`])assert.throws(()=>route(path,'POST'));
 for(const extra of [{actor},{xml:'synthetic'}, {lease_id:randomUUID()}, {identity:{}},{expected_a1_version:'1'}])assert.throws(()=>parsePayload(bytes({...payload,...extra}),run));
 for(const value of [{limit:26,before:null},{limit:1,before:0},{limit:1},{limit:1,before:null,job_id:job}])assert.throws(()=>parsePayload(bytes(value),history));
 assert.throws(()=>parsePayload(bytes({}),route(prefix+`/commands/${command}`,'GET')));
});
test('HMAC binds signed-only domain, audience, actor, body, path and bounded clock; delivery replay is not claimed single-use',async()=>{
 const header=await signed(),options={header,secretBytes:secret,keyId,audience,method:'POST',path:prefix+'/run'};
 assert.equal((await verifyRuntimeRequest(options)).actor,actor);assert.equal((await verifyRuntimeRequest(options)).actor,actor);
 for(const change of [{audience:'other-signed'},{path:prefix+`/jobs/${job}/history`},{method:'GET'},{now:Date.now()+61000}])await assert.rejects(()=>verifyRuntimeRequest({...options,...change}));
 const [id,claims]=header.slice('Brufap-Signed '.length).split('.');
 for(const domain of ['brufap-a1-request-v1','brufap-unsigned-request-v1'])await assert.rejects(()=>verifyRuntimeRequest({...options,header:`Brufap-Signed ${id}.${claims}.${createHmac('sha256',secret).update(`${domain}.${id}.${claims}`).digest('hex')}`}));
 await assert.rejects(()=>signRuntimeRequest({secretBytes:secret,keyId,audience,actor:'not-an-actor',nonce:randomUUID(),method:'POST',path:prefix+'/run',bodyHash:hash}));
});
test('body bounds include slow streams, invalid lengths and explicit cancellation',async()=>{
 for(const headers of [{'content-encoding':'gzip'},{'content-length':'4097'}])await assert.rejects(()=>readBounded(new Response('x',{headers}),{limit:4096,deadline:Date.now()+1000}));
 let cancelled=false;const stream=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 await assert.rejects(()=>readBounded(stream,{limit:4096,deadline:Date.now()+20}));assert.equal(cancelled,true);
});
test('public candidates preserve receipt/current distinction without A1 references, fiscal key or leases',()=>{
 const raw=response('get'),value=projectSqlView(raw,{candidateId:candidate});assert.equal(value.a1_version,1);assert.equal(value.read_only,true);assert.equal(value.signed,true);
 assert.doesNotMatch(JSON.stringify(value),/credential|fingerprint|reference_digest|lease|access_key|bucket|path|<NFe/);
 const moved=structuredClone(raw);moved.current.a1_version=2;moved.current.a1_changed=true;moved.current.artifact_current=false;
 const historical=projectSqlView(moved,{candidateId:candidate});assert.equal(historical.a1_version,1);assert.equal(historical.current.a1_version,2);assert.equal(historical.signature_verified,true);assert.equal(historical.current.artifact_current,false);
 for(const change of [{can_emit:true},{authorized:true},{signature_verified:false}])assert.throws(()=>projectSqlView({...raw,...change},{candidateId:candidate}));
 assert.throws(()=>projectSqlView(raw,{candidateId:randomUUID()}));
 const run={...value,command_id:command};assert.equal(publicResult(run,{action:'run',payload}).candidate_id,candidate);
 assert.throws(()=>publicResult(run,{action:'run',payload:{...payload,expected_a1_version:2}}));
 assert.throws(()=>publicResult({...value,artifact:{...value.artifact,created_at:'2026-02-30T12:00:00Z'}},{action:'candidate',candidateId:candidate}));
});
test('history binds job, ordered cursor and total page size, and never claims aggregate signature validation',()=>{
 const raw=response('history'),query={jobId:job,payload:{limit:25,before:null}},value=projectSqlHistory(raw,query);
 assert.equal(value.items.length,1);assert.equal(value.items[0].signed,true);assert.equal(value.read_only,true);assert.equal(Object.hasOwn(value,'signed'),false);
 assert.throws(()=>projectSqlHistory(raw,{...query,jobId:randomUUID()}));
 assert.throws(()=>projectSqlHistory({...raw,items:[view('stored'),view('stored')]},query));
 assert.throws(()=>projectSqlHistory({...raw,has_more:true,next_cursor:1},query));
 const empty={...flags(),read_only:true,unsigned_job_id:job,items:[],limit:25,has_more:false,next_cursor:null};assert.deepEqual(projectSqlHistory(empty,query).items,[]);
});
