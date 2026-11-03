import test from 'node:test';
import assert from 'node:assert/strict';
import {createFiscalSignedRpc,FiscalSignedRpcError} from '../src/rpc.mjs';
import {projectUrl,serviceKey,actor,job,candidate,lease,hash,examples,response} from './fixtures.mjs';
const name=s=>'erp_fiscal_signed_'+s,options=patch=>({deadline:Date.now()+10000,...patch}),port=fetchImpl=>createFiscalSignedRpc({projectUrl,serviceKey,fetchImpl});
const call=(rpc,type='get',args=examples[type],opts=options())=>rpc(name(type),args,opts);
const rejects=(fn,code)=>assert.rejects(fn,e=>e instanceof FiscalSignedRpcError&&e.code===code&&e.message===code&&!e.cause);
const wire=(type='get',patch)=>{const v=response(type);patch?.(v);return Response.json(v);};
test('requires explicit dependencies, canonical fixed HTTPS project and a non-reflected credential',()=>{
 for(const project of['http://abcdefghijklmnopqrst.supabase.co',projectUrl+'/',projectUrl+'?secret=x',projectUrl+'#x',projectUrl+':443','https://user@abcdefghijklmnopqrst.supabase.co','https://evil.invalid'])assert.throws(()=>createFiscalSignedRpc({projectUrl:project,serviceKey,fetchImpl:async()=>{}}),/FISCAL_SIGNED_RPC_PROJECT_INVALID/);
 for(const key of['short',serviceKey+'\n',serviceKey+' ','x'.repeat(8193)])assert.throws(()=>createFiscalSignedRpc({projectUrl,serviceKey:key,fetchImpl:async()=>{}}),/FISCAL_SIGNED_RPC_CREDENTIAL_INVALID/);
 assert.throws(()=>createFiscalSignedRpc({projectUrl,serviceKey}),/FISCAL_SIGNED_RPC_CONFIG_INVALID/);assert.throws(()=>createFiscalSignedRpc({projectUrl,serviceKey,fetchImpl:undefined}),/FISCAL_SIGNED_RPC_DRIVER_REQUIRED/);
});
test('seven exact POST routes capture actor/body, project DTOs and erase the borrowed request buffer',async()=>{
 for(const[type,args]of Object.entries(examples)){let calls=0,borrowed,signal;const original=structuredClone(args),rpc=port(async(url,init)=>{
  calls++;borrowed=init.body;signal=init.signal;assert.equal(url,projectUrl+'/rest/v1/rpc/'+name(type));assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.headers.Authorization,'Bearer '+serviceKey);assert.equal(init.headers.apikey,serviceKey);assert.equal(init.headers['Accept-Encoding'],'identity');assert.equal(init.headers['Content-Length'],String(init.body.length));
  assert.deepEqual(JSON.parse(init.body.toString()),type==='history'?{...args,p_limit:25,p_before:null}:args);return wire(type);
 });assert.deepEqual(await call(rpc,type),response(type));assert.equal(calls,1);assert.ok(borrowed.every(b=>b===0));assert.equal(signal.aborted,true);assert.deepEqual(args,original);}
});
test('foreign procedures, getter arguments, extra fields and invalid evidence are rejected before fetch',async()=>{
 let calls=0;const rpc=port(async()=>{calls++;return wire();});
 for(const procedure of['erp_fiscal_unsigned_begin','erp_a1_authorize',name('get')+'?x=1','../'+name('get'),'toString',null])await rejects(()=>rpc(procedure,examples.get,options()),'FISCAL_SIGNED_RPC_UNSUPPORTED');
 for(const[type,patch]of[['get',{p_user_id:[actor]}],['get',{p_candidate_id:candidate+'\n'}],['get',{xml:'PRIVATE XML'}],['begin',{p_expected_a1_version:0}],['begin',{p_basis_hash:hash.toUpperCase()}],['finish',{p_size_bytes:512001}],['finish',{p_evidence:{...examples.finish.p_evidence,secret:'PRIVATE'}}],['fail',{p_error_code:'TIMEOUT'}],['history',{p_limit:null}],['history',{p_before:0}]])await rejects(()=>call(rpc,type,{...examples[type],...patch}),'FISCAL_SIGNED_RPC_ARGUMENTS_INVALID');
 for(const type of Object.keys(examples)){const missing={...examples[type]};delete missing.p_user_id;await rejects(()=>call(rpc,type,missing),'FISCAL_SIGNED_RPC_ARGUMENTS_INVALID');}
 const getter={...examples.get};Object.defineProperty(getter,'p_user_id',{get(){throw Error('PRIVATE GETTER');},enumerable:true});await rejects(()=>call(rpc,'get',getter),'FISCAL_SIGNED_RPC_ARGUMENTS_INVALID');
 const nested=structuredClone(examples.finish);Object.defineProperty(nested.p_evidence.signature,'xml_hash',{get(){throw Error('PRIVATE GETTER');},enumerable:true});await rejects(()=>call(rpc,'finish',nested),'FISCAL_SIGNED_RPC_ARGUMENTS_INVALID');assert.equal(calls,0);
 const container=structuredClone(examples.finish);Object.defineProperty(container.p_evidence,'signature',{get(){throw Error('PRIVATE GETTER');},enumerable:true});await rejects(()=>call(rpc,'finish',container),'FISCAL_SIGNED_RPC_ARGUMENTS_INVALID');assert.equal(calls,0);
});
test('DTO forbids arbitrary body/XML/secrets, foreign bindings and claims outside050',async()=>{
 for(const change of[v=>v.execution={},v=>v.artifact.evidence.xml='PRIVATE XML',v=>v.receipt.candidate_id=job,v=>v.receipt.unsigned_size=0,v=>v.receipt.created_at='2026-02-30T12:00:00Z',v=>v.current.artifact_current=false,v=>v.current.a1_changed=true,v=>v.authorized=true,v=>v.artifact.evidence.signature.certificate_fingerprint=hash,v=>v.artifact.evidence.signature.reference_digest='//////////////////////////9=',v=>v.artifact.evidence.qr.verified=true])await rejects(()=>call(port(async()=>wire('get',change))),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');
 for(const change of[v=>v.credential_object.path='../private',v=>v.credential_object.bucket='public',v=>v.credential_object.password='PRIVATE',v=>v.unsigned_object.hash='b'.repeat(64),v=>v.access_key='1'.repeat(44),v=>v.identity.environment='1',v=>v.credential_context.credential_id=job,v=>v.credential_metadata.icp_brasil_chain_validated=true,v=>v.credential_metadata.presented_chain=[hash],v=>v.lease_id=candidate])await rejects(()=>call(port(async()=>wire('use',change)),'use'),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');
 for(const change of[v=>v.command_id=job,v=>v.receipt.a1_version=2,v=>v.execution.lease_until='2026-10-17T12:01:00.000Z'])await rejects(()=>call(port(async()=>wire('begin',change)),'begin'),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');
 await rejects(()=>call(port(async()=>wire('finish',v=>v.artifact.size_bytes++)),'finish'),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');
});
test('history projection binds order/cursor/source while historical receipt and current A1 remain distinct',async()=>{
 const v=response('history'),older=structuredClone(v.items[0]);v.items[0].receipt.version=2;v.items[0].current.latest_candidate_version=2;v.items[0].receipt.candidate_id=job;v.items[0].current.latest_candidate_id=job;
 older.current.latest_candidate_id=job;older.current.latest_candidate_version=2;older.current.is_latest_candidate=false;older.current.artifact_current=false;v.items.push(older);assert.equal((await call(port(async()=>Response.json(v)),'history')).items.length,2);
 for(const change of[x=>x.items.reverse(),x=>x.items[0].receipt.unsigned_job_id=candidate,x=>x.has_more=true,x=>x.next_cursor=1]){const invalid=structuredClone(v);change(invalid);await rejects(()=>call(port(async()=>Response.json(invalid)),'history'),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');}
 const old=response('get');old.current.a1_version=2;old.current.a1_changed=true;old.current.artifact_current=false;const out=await call(port(async()=>Response.json(old)));assert.equal(out.receipt.a1_version,1);assert.equal(out.current.a1_version,2);assert.equal(out.signed,true);
});
test('only explicit allowlisted SQLSTATEs survive; provider diagnostics and credentials never do',async()=>{
 for(const code of['42501','40001','22023','55000','P0002'])await rejects(()=>call(port(async()=>Response.json({code,message:serviceKey,details:'PRIVATE',hint:'PRIVATE'},{status:400}))),code);
 for(const code of['23505','XX000',null,['P0002']])await assert.rejects(()=>call(port(async()=>Response.json({code,message:serviceKey,details:'PRIVATE'},{status:500}))),e=>{assert.equal(e.code,'FISCAL_SIGNED_RPC_HTTP_REJECTED');assert.doesNotMatch(String(e)+JSON.stringify(e),/PRIVATE|synthetic-signed-service-key/);return true;});
});
test('does not retry mutations after lost response, malformed body or infrastructure failure',async()=>{
 for(const action of[async()=>{throw Error('PRIVATE '+serviceKey);},async()=>Response.json({message:'PRIVATE'},{status:503}),async()=>new Response('{PRIVATE',{headers:{'Content-Type':'application/json'}})]){let count=0;await assert.rejects(()=>call(port((...args)=>{count++;return action(...args); }),'begin'),e=>{assert.ok(e instanceof FiscalSignedRpcError);assert.doesNotMatch(String(e),/PRIVATE|synthetic-signed-service-key/);return true;});assert.equal(count,1);}
});
test('captures exact arguments and nested evidence before awaiting the driver; generic404 is not a missing command',async()=>{
 const entered=Promise.withResolvers(),reply=Promise.withResolvers(),args=structuredClone(examples.finish);let sent;
 const pending=call(port(async(_,init)=>{sent=JSON.parse(init.body.toString());entered.resolve();return reply.promise;}),'finish',args);await entered.promise;
 args.p_candidate_id=job;args.p_signed_hash=hash;args.p_evidence.signature.xml_hash=hash;args.p_evidence.signature.reference_digest='PRIVATE';reply.resolve(wire('finish'));
 const result=await pending;assert.equal(result.receipt.candidate_id,candidate);assert.deepEqual(sent,examples.finish);assert.equal(result.artifact.evidence.signature.xml_hash,examples.finish.p_signed_hash);
 await rejects(()=>call(port(async()=>Response.json({message:'not found'},{status:404})),'command'),'FISCAL_SIGNED_RPC_HTTP_REJECTED');
});
test('redirects, effective URLs, compressed bodies and invalid UTF8 are rejected',async()=>{
 for(const status of[301,302,307,308]){let calls=0,cancelled=false;await rejects(()=>call(port(async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status,headers:{Location:'https://evil.invalid'}});})), 'FISCAL_SIGNED_RPC_REDIRECT_REJECTED');assert.equal(calls,1);assert.equal(cancelled,true);}
 for(const patch of[{url:'https://evil.invalid'},{redirected:true},{url:projectUrl+'/rest/v1/rpc/'+name('begin')}]){const r=wire();for(const[k,value]of Object.entries(patch))Object.defineProperty(r,k,{value});await rejects(()=>call(port(async()=>r)),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');}
 for(const headers of[{'Content-Encoding':'gzip'},{'Content-Length':'NaN'},{'Content-Length':'3'}])await rejects(()=>call(port(async()=>new Response('{}',{headers:{'Content-Type':'application/json',...headers}}))),'FISCAL_SIGNED_RPC_BODY_INVALID');
 for(const contentType of['text/plain','application/json;charset=latin1'])await rejects(()=>call(port(async()=>new Response('{}',{headers:{'Content-Type':contentType}}))),'FISCAL_SIGNED_RPC_RESPONSE_INVALID');
 await rejects(()=>call(port(async()=>new Response(Buffer.from([0xc3,0x28]),{headers:{'Content-Type':'application/json'}}))),'FISCAL_SIGNED_RPC_JSON_INVALID');
});
test('metadata and error limits include streaming bodies and exact declared byte length',async()=>{
 const raw=JSON.stringify(response('get')),body=raw+' '.repeat(131072-Buffer.byteLength(raw));assert.deepEqual(await call(port(async()=>new Response(body,{headers:{'Content-Type':'application/json','Content-Length':'131072'}}))),response('get'));
 for(const[type,status,size]of[['get',200,131073],['use',200,131073],['get',400,8193]])await rejects(()=>call(port(async()=>new Response(' '.repeat(size),{status,headers:{'Content-Type':'application/json'}})),type),'FISCAL_SIGNED_RPC_BODY_LIMIT');
 await rejects(()=>call(port(async()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'131073'}}))),'FISCAL_SIGNED_RPC_BODY_INVALID');
});
test('one absolute deadline bounds headers and body, cancels late data and never retries',async()=>{
 let count=0,cancelled=false,signal;const rpc=port(async(_,init)=>{count++;signal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});});
 await rejects(()=>call(rpc,'begin',examples.begin,options({deadline:Date.now()+25})),'FISCAL_SIGNED_RPC_TIMEOUT');assert.equal(count,1);assert.equal(cancelled,true);assert.equal(signal.aborted,true);
 const late=Promise.withResolvers();let cancelledLate=false;await rejects(()=>call(port(()=>late.promise),'get',examples.get,options({deadline:Date.now()+25})),'FISCAL_SIGNED_RPC_TIMEOUT');late.resolve(new Response(new ReadableStream({cancel(){cancelledLate=true;}}),{headers:{'Content-Type':'application/json'}}));await new Promise(r=>setImmediate(r));assert.equal(cancelledLate,true);
});
test('captured cancellation and deadlines reject before dispatch or while a driver ignores abort',async()=>{
 const stop=new AbortController();let calls=0;const rpc=port(async()=>{calls++;return wire();});stop.abort();await rejects(()=>call(rpc,'get',examples.get,options({signal:stop.signal})),'FISCAL_SIGNED_RPC_ABORTED');
 for(const deadline of[Date.now()-1,Date.now()+46000,NaN,'tomorrow'])await rejects(()=>call(rpc,'get',examples.get,options({deadline})),'FISCAL_SIGNED_RPC_DEADLINE_INVALID');assert.equal(calls,0);
 const controller=new AbortController(),entered=Promise.withResolvers(),opts=options({signal:controller.signal});let cancelled=false;const pending=call(port(async()=>{entered.resolve();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});}),'get',examples.get,opts);await entered.promise;opts.signal=new AbortController().signal;controller.abort();await rejects(()=>pending,'FISCAL_SIGNED_RPC_ABORTED');assert.equal(cancelled,true);
});
