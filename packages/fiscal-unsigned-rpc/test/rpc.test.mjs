import test from 'node:test';
import assert from 'node:assert/strict';
import {createFiscalUnsignedRpc,FiscalUnsignedRpcError} from '../src/rpc.mjs';

const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-unsigned-service-key';
const actor='10000000-0000-4000-8000-000000000001',draft='20000000-0000-4000-8000-000000000002',command='30000000-0000-4000-8000-000000000003',reservation='40000000-0000-4000-8000-000000000004',job='50000000-0000-4000-8000-000000000005',lease='60000000-0000-4000-8000-000000000006';
const examples={
 basis:{p_user_id:actor,p_draft_id:draft,p_completion_version:1},
 begin:{p_user_id:actor,p_command_id:command,p_reservation_id:reservation,p_completion_version:1,p_completion_hash:'a'.repeat(64),p_basis_hash:'b'.repeat(64),p_builder_version:'brufap-business-builder-v1',p_seed:{cNF:'12345678',issuedAt:'2026-10-16T10:00:00-03:00'}},
 finish:{p_user_id:actor,p_job_id:job,p_lease_id:lease,p_xml_hash:'c'.repeat(64),p_size_bytes:100,p_access_key:'1'.repeat(44)},
 fail:{p_user_id:actor,p_job_id:job,p_lease_id:lease,p_error_code:'CONTENT_INVALID'},
 get:{p_user_id:actor,p_job_id:job},command:{p_user_id:actor,p_command_id:command},history:{p_user_id:actor,p_reservation_id:reservation},
};
const name=s=>'erp_fiscal_unsigned_'+s,options=patch=>({deadline:Date.now()+10000,...patch});
const port=fetchImpl=>createFiscalUnsignedRpc({projectUrl,serviceKey,fetchImpl});
const invoke=(rpc,type='get',args=examples[type],opts=options())=>rpc(name(type),args,opts);
const rejects=(fn,code)=>assert.rejects(fn,error=>error instanceof FiscalUnsignedRpcError&&error.code===code&&error.message===code&&!error.cause);
const padded=size=>JSON.stringify({value:'x'.repeat(size-12)});

test('requires all explicit dependencies and a canonical HTTPS project before any request',()=>{
 for(const project of['http://abcdefghijklmnopqrst.supabase.co',projectUrl+'/',projectUrl+'?secret=x',projectUrl+'#x',projectUrl+':443',projectUrl+'/rest',projectUrl+'\n','https://user@abcdefghijklmnopqrst.supabase.co','https://x.supabase.co','https://evil.invalid']){
  assert.throws(()=>createFiscalUnsignedRpc({projectUrl:project,serviceKey,fetchImpl:async()=>{}}),/FISCAL_UNSIGNED_RPC_PROJECT_INVALID/);
 }
 for(const credential of['short',serviceKey+'\n',serviceKey+'\r',serviceKey+' ',['synthetic-secret-key12345'],'x'.repeat(8193)])assert.throws(()=>createFiscalUnsignedRpc({projectUrl,serviceKey:credential,fetchImpl:async()=>{}}),/FISCAL_UNSIGNED_RPC_CREDENTIAL_INVALID/);
 assert.throws(()=>createFiscalUnsignedRpc({projectUrl,serviceKey}),/FISCAL_UNSIGNED_RPC_CONFIG_INVALID/);
 assert.throws(()=>createFiscalUnsignedRpc({projectUrl,serviceKey,fetchImpl:undefined}),/FISCAL_UNSIGNED_RPC_DRIVER_REQUIRED/);
 assert.throws(()=>createFiscalUnsignedRpc({projectUrl,serviceKey,fetchImpl:async()=>{},actor}),/FISCAL_UNSIGNED_RPC_CONFIG_INVALID/);
});
test('only seven fixed POST RPCs are exposed, preserve JSON and actor, and erase their body buffer',async()=>{
 for(const[type,args]of Object.entries(examples)){
  const original=structuredClone(args);let calls=0,borrowed,seenSignal;
  const rpc=port(async(url,init)=>{calls++;borrowed=init.body;seenSignal=init.signal;
   assert.equal(url,projectUrl+'/rest/v1/rpc/'+name(type));assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer');
   assert.ok(init.signal instanceof AbortSignal);assert.equal(init.headers.Authorization,'Bearer '+serviceKey);assert.equal(init.headers.apikey,serviceKey);assert.equal(init.headers.Accept,'application/json');assert.equal(init.headers['Accept-Encoding'],'identity');assert.equal(init.headers['Content-Type'],'application/json');assert.equal(init.headers['Content-Length'],String(init.body.length));assert.ok(init.body.length<=16384);
   const body=JSON.parse(init.body.toString());assert.deepEqual(body,type==='history'?{...args,p_limit:25,p_before:null}:args);
   return Response.json({marker:type},{headers:{'Set-Cookie':'not-exposed','X-Internal':'not-exposed'}});
  });
  assert.deepEqual(await invoke(rpc,type),{marker:type});assert.equal(calls,1);assert.ok(borrowed.every(b=>b===0));assert.equal(seenSignal.aborted,true);assert.deepEqual(args,original);
 }
});
test('rejects foreign RPCs, unknown keys, malformed values and coercible UUIDs before fetch',async()=>{
 let calls=0;const rpc=port(async()=>{calls++;return Response.json({});});
 for(const procedure of['erp_fiscal_numbering_reserve','erp_a1_metadata',name('get')+'?x=1','../'+name('get'),name('get')+'\n','toString',null])await rejects(()=>rpc(procedure,examples.get,options()),'FISCAL_UNSIGNED_RPC_UNSUPPORTED');
 for(const[type,patch]of[
  ['get',{p_user_id:[actor]}],['get',{p_user_id:actor.toUpperCase().replace('10000000','A0000000')}],['get',{p_job_id:job+'\n'}],['get',{url:'https://evil.invalid'}],['get',{p_xml:'x'.repeat(20000)}],
  ['basis',{p_completion_version:'1'}],['basis',{p_completion_version:0}],['basis',{p_completion_version:2147483648}],
  ['begin',{p_basis_hash:['b'.repeat(64)]}],['begin',{p_completion_hash:'A'.repeat(64)}],['begin',{p_builder_version:'other'}],['begin',{p_seed:{...examples.begin.p_seed,number:'1'}}],
  ['finish',{p_size_bytes:480001}],['finish',{p_size_bytes:0}],['finish',{p_access_key:'1'.repeat(45)}],['finish',{p_access_key:['1'.repeat(44)]}],['fail',{p_error_code:'PRIVATE-ERROR'}],
  ['history',{p_limit:26}],['history',{p_limit:null}],['history',{p_before:0}],['history',{p_before:undefined}],
 ])await rejects(()=>invoke(rpc,type,{...examples[type],...patch}),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');
 for(const type of Object.keys(examples)){const missing={...examples[type]};delete missing.p_user_id;await rejects(()=>invoke(rpc,type,missing),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');}
 const accessor={...examples.get};Object.defineProperty(accessor,'p_user_id',{enumerable:true,get(){throw new Error('must never invoke');}});await rejects(()=>invoke(rpc,'get',accessor),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');
 const symbol={...examples.get,[Symbol('unknown')]:true};await rejects(()=>invoke(rpc,'get',symbol),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');assert.equal(calls,0);
});
test('seed calendar and profile are strict without inventing freshness or replacing a retry seed',async()=>{
 const bodies=[],rpc=port(async(_,init)=>{bodies.push(JSON.parse(init.body.toString()));return Response.json({});});
 for(const issuedAt of['2026-02-30T10:00:00-03:00','2026-02-29T10:00:00-03:00','2026-10-16T24:00:00-03:00','2026-10-16T10:00:60-03:00','2026-10-16T10:00:00Z','2026-10-16T10:00:00.000-03:00','2100-01-01T10:00:00-03:00'])await rejects(()=>invoke(rpc,'begin',{...examples.begin,p_seed:{cNF:'12345678',issuedAt}}),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');
 for(const seed of[{cNF:12345678,issuedAt:examples.begin.p_seed.issuedAt},{cNF:'1234567',issuedAt:examples.begin.p_seed.issuedAt},null])await rejects(()=>invoke(rpc,'begin',{...examples.begin,p_seed:seed}),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');
 const historical={cNF:'00000000',issuedAt:'2000-02-29T10:00:00-03:00'};await invoke(rpc,'begin',{...examples.begin,p_seed:historical});assert.deepEqual(bodies[0].p_seed,historical);
 const nonEnumerable=Object.create(null);for(const[key,value]of Object.entries(historical))Object.defineProperty(nonEnumerable,key,{value});
 await invoke(rpc,'begin',{...examples.begin,p_seed:nonEnumerable});assert.deepEqual(bodies[1].p_seed,historical);
});
test('supports explicit history pagination and alphanumeric access key shape without fiscal claims',async()=>{
 const seen=[],rpc=port(async(_,init)=>{seen.push(JSON.parse(init.body.toString()));return Response.json({});});
 await invoke(rpc,'history',{...examples.history,p_limit:1,p_before:2147483647});assert.equal(seen[0].p_limit,1);assert.equal(seen[0].p_before,2147483647);
 const key='1'.repeat(6)+'A'.repeat(12)+'1'.repeat(26);await invoke(rpc,'finish',{...examples.finish,p_access_key:key});assert.equal(seen[1].p_access_key,key);
});
test('preserves only allowed SQLSTATE codes and strips provider diagnostics and headers',async()=>{
 for(const state of['42501','40001','22023','55000','P0002']){
  let calls=0;await rejects(()=>invoke(port(async()=>{calls++;return Response.json({code:state,message:'PRIVATE-ERROR '+serviceKey,details:'PRIVATE-ERROR',hint:'PRIVATE-ERROR'},{status:400});})) ,state);assert.equal(calls,1);
 }
 for(const code of['23505','XX000',null,['P0002'],'PRIVATE-ERROR']){
  await assert.rejects(()=>invoke(port(async()=>Response.json({code,message:serviceKey,details:'PRIVATE-ERROR'},{status:500}))),error=>{assert.equal(error.code,'FISCAL_UNSIGNED_RPC_HTTP_REJECTED');assert.doesNotMatch(String(error)+JSON.stringify(error),/PRIVATE-ERROR|synthetic-unsigned-service-key/);return true;});
 }
});
test('does not retry mutations on HTTP failures, malformed responses or lost responses',async()=>{
 for(const fetch of[async()=>Response.json({message:'PRIVATE-ERROR'},{status:429}),async()=>Response.json({message:'PRIVATE-ERROR'},{status:503}),async()=>{throw new Error('PRIVATE-ERROR '+serviceKey);},async()=>new Response('{PRIVATE-ERROR',{headers:{'Content-Type':'application/json'}})]){
  let calls=0,borrowed;const rpc=port((url,init)=>{calls++;borrowed=init.body;return fetch(url,init);});
  await assert.rejects(()=>invoke(rpc,'begin'),error=>{assert.ok(error instanceof FiscalUnsignedRpcError);assert.doesNotMatch(String(error)+JSON.stringify(error),/PRIVATE-ERROR|synthetic-unsigned-service-key/);return true;});assert.equal(calls,1);assert.ok(borrowed.every(b=>b===0));
 }
});
test('rejects redirects and foreign effective URLs, cancelling their bodies without forwarding credentials',async()=>{
 for(const status of[301,302,307,308]){
  let calls=0,cancelled=false;await rejects(()=>invoke(port(async(_,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status,headers:{Location:'https://evil.invalid'}});})), 'FISCAL_UNSIGNED_RPC_REDIRECT_REJECTED');assert.equal(calls,1);assert.equal(cancelled,true);
 }
 for(const patch of[{url:'https://evil.invalid/private'},{redirected:true},{url:projectUrl+'/rest/v1/rpc/'+name('begin')}]){
  const response=Response.json({});for(const[key,value]of Object.entries(patch))Object.defineProperty(response,key,{value});await rejects(()=>invoke(port(async()=>response)),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
 }
 const response=Response.json({});Object.defineProperty(response,'url',{value:projectUrl+'/rest/v1/rpc/'+name('get')});assert.deepEqual(await invoke(port(async()=>response)),{});
});
test('bounds success bodies by function and error bodies separately, including streamed bodies without length',async()=>{
 for(const[type,limit]of[['basis',8388608],['begin',8388608],['get',131072],['command',131072],['history',131072]]){
  const body=padded(limit);assert.equal(Buffer.byteLength(body),limit);const result=await invoke(port(async()=>new Response(body,{headers:{'Content-Type':'application/json','Content-Length':String(limit)}})),type);assert.equal(result.value.length,limit-12);
  await rejects(()=>invoke(port(async()=>new Response(padded(limit+1),{headers:{'Content-Type':'application/json'}})),type),'FISCAL_UNSIGNED_RPC_BODY_LIMIT');
  await rejects(()=>invoke(port(async()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(limit+1)}})),type),'FISCAL_UNSIGNED_RPC_BODY_INVALID');
 }
 await rejects(()=>invoke(port(async()=>new Response(padded(8193),{status:400,headers:{'Content-Type':'application/json'}}))),'FISCAL_UNSIGNED_RPC_BODY_LIMIT');
});
test('enforces complete length, JSON MIME, identity encoding, fatal UTF8 and object envelopes',async()=>{
 for(const headers of[{'Content-Length':'3'},{'Content-Length':'-1'},{'Content-Length':'NaN'},{'Content-Encoding':'gzip'}])await rejects(()=>invoke(port(async()=>new Response('{}',{headers:{'Content-Type':'application/json',...headers}}))),'FISCAL_UNSIGNED_RPC_BODY_INVALID');
 for(const contentType of['text/plain','application/octet-stream','application/json;charset=latin1'])await rejects(()=>invoke(port(async()=>new Response('{}',{headers:{'Content-Type':contentType}}))),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
 for(const body of['[]','null','"text"','1'])await rejects(()=>invoke(port(async()=>new Response(body,{headers:{'Content-Type':'application/json'}}))),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
 for(const bytes of[Buffer.from('{'),Buffer.from([123,34,118,34,58,34,0xc3,0x28,34,125])])await rejects(()=>invoke(port(async()=>new Response(bytes,{headers:{'Content-Type':'application/json'}}))),'FISCAL_UNSIGNED_RPC_JSON_INVALID');
 await rejects(()=>invoke(port(async()=>new Response(null,{headers:{'Content-Type':'application/json'}}))),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
 assert.deepEqual(await invoke(port(async()=>new Response('{}',{headers:{'Content-Type':'application/json; charset=utf-8','Content-Encoding':'identity'}}))),{});
});
test('deadline covers stalled bodies and late headers, cancels both and never retries',async()=>{
 let cancelled=false,calls=0,seenSignal,borrowed;
 const stalled=port(async(_,init)=>{calls++;seenSignal=init.signal;borrowed=init.body;return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});});
 await rejects(()=>invoke(stalled,'begin',examples.begin,options({deadline:Date.now()+25})),'FISCAL_UNSIGNED_RPC_TIMEOUT');assert.equal(cancelled,true);assert.equal(seenSignal.aborted,true);assert.equal(calls,1);assert.ok(borrowed.every(b=>b===0));
 const late=Promise.withResolvers();let lateCancelled=false;
 await rejects(()=>invoke(port(()=>late.promise),'get',examples.get,options({deadline:Date.now()+25})),'FISCAL_UNSIGNED_RPC_TIMEOUT');
 late.resolve(new Response(new ReadableStream({cancel(){lateCancelled=true;}}),{headers:{'Content-Type':'application/json'}}));await new Promise(resolve=>setImmediate(resolve));assert.equal(lateCancelled,true);
});
test('caller cancellation aborts the driver and body; already aborted or invalid deadlines never dispatch',async()=>{
 const controller=new AbortController();let signal,cancelled=false;
 const rpc=port(async(_,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});});
 const pending=invoke(rpc,'get',examples.get,options({signal:controller.signal}));setTimeout(()=>controller.abort(),10);await rejects(()=>pending,'FISCAL_UNSIGNED_RPC_ABORTED');assert.equal(signal.aborted,true);assert.equal(cancelled,true);
 let calls=0;const noFetch=port(async()=>{calls++;return Response.json({});});
 await rejects(()=>invoke(noFetch,'get',examples.get,options({signal:controller.signal})),'FISCAL_UNSIGNED_RPC_ABORTED');
 for(const deadline of[Date.now()-1,Date.now()+46000,NaN,undefined,'tomorrow'])await rejects(()=>invoke(noFetch,'get',examples.get,options({deadline})),'FISCAL_UNSIGNED_RPC_DEADLINE_INVALID');
 for(const opts of[undefined,{deadline:Date.now()+1000,extra:true},{deadline:Date.now()+1000,signal:{aborted:false}}])await rejects(()=>noFetch(name('get'),examples.get,opts),'FISCAL_UNSIGNED_RPC_OPTIONS_INVALID');assert.equal(calls,0);
 const first=new AbortController(),later=new AbortController(),started=Promise.withResolvers(),mutable=options({signal:first.signal});
 const captured=port(async()=>{started.resolve();return new Response(new ReadableStream(),{headers:{'Content-Type':'application/json'}});});
 const waiting=invoke(captured,'get',examples.get,mutable);await started.promise;mutable.signal=later.signal;first.abort();await rejects(()=>waiting,'FISCAL_UNSIGNED_RPC_ABORTED');assert.equal(later.signal.aborted,false);
});
