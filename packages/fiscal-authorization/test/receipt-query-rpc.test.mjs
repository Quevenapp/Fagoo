// Pure port probes: synthetic inert metadata, fake HTTP driver, no SQL, certificate or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptQueryRpc,isReceiptQuerySqlFailure} from '../src/receipt-query-rpc.mjs';
import {AuthorizationServiceError} from '../src/service-common.mjs';
import {RECEIPT_QUERY_LEDGER_FLAGS as FLAGS,RECEIPT_QUERY_RPC_LIMITS} from '../src/receipt-query-ledger-dto.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../src/receipt-query-manifest.mjs';
const uid=n=>`f0000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=n=>n.toString(16).padStart(64,'0');
const actor=uid(1),queryId=uid(2),authCommand=uid(3),attempt=uid(4),candidate=uid(5),lease=uid(6),nonce=uid(7);
const profile={profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH};
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-private-key-not-a-secret';
const make=fetchImpl=>createReceiptQueryRpc({projectUrl,serviceKey,fetchImpl});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const bounded=async p=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),1000);})]);}finally{clearTimeout(timer);}};
const ids={p_user_id:actor,p_query_id:queryId,p_lease_id:lease};
const preparation={...profile,query_id:queryId,nonce,source_binding_hash:hash(1),request_hash:hash(2),payload_hash:hash(3),signed_hash:hash(4),model:'55',environment:'2',receipt_number:'035000000000001',signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false};
const evidence={...profile,query_id:queryId,nonce,source_binding_hash:hash(1),request_hash:hash(2),response_hash:hash(5),payload_hash:hash(6),signed_hash:hash(4),model:'55',environment:'2',receipt_number:'035000000000001',outcome:'receipt_pending',rejection_code:null,cstat:'105',protocol_cstat:null,protocol_number:null,received_at:'2026-10-17T12:00:01.000Z',reference_digest:null,signature_verified:false,xsd_validated:true,context_matched:true,processed_xsd_validated:false,tls_origin_verified:true,observation_hash:hash(7),observation_size:128,tax_rules_validated:false,can_emit:false,can_transmit:false};
function args(action){
 const all={context:{p_user_id:actor,p_source_kind:'authorization',p_source_command_id:authCommand,p_expected_attempt_id:attempt},begin:{p_user_id:actor,p_command_id:queryId,p_selection:{source_kind:'authorization',source_command_id:authCommand,expected_authorization_command_id:authCommand,expected_attempt_id:attempt,expected_candidate_id:candidate,expected_candidate_version:1,expected_signed_hash:hash(4),expected_source_binding_hash:hash(1),expected_chain_hash:hash(8),expected_identity_version:1,expected_a1_version:1,expected_query_policy_version:1},p_source_validation:{...profile,source_binding_hash:hash(1),payload_hash:hash(3),receipt_number:'035000000000001',tmed_seconds:1,received_at:'2026-10-17T11:58:00.000Z',observed_at:'2026-10-17T11:58:01.000Z',signature_verified:true,xsd_validated:true,context_matched:true,tls_origin_verified:true,tax_rules_validated:false,can_query:false,can_emit:false,can_transmit:false},p_confirmed:true},prepare:{...ids,p_request_hash:hash(2),p_request_size:32,p_evidence:preparation},use:ids,finish:{...ids,p_response_hash:hash(5),p_response_size:32,p_observation_hash:hash(7),p_observation_size:128,p_evidence:evidence,p_processed_hash:null,p_processed_size:null},fail:{...ids,p_error_code:'RECEIPT_QUERY_TRANSPORT_FAILED'},command:{p_user_id:actor,p_command_id:queryId},history:{p_user_id:actor,p_authorization_command_id:authCommand,p_expected_attempt_id:attempt,p_limit:25,p_before:null}};
 return structuredClone(all[action]);
}
function grant(){return{...FLAGS,private_executor_only:true,grant:{private_executor_only:true,purpose:'sp-receipt-query-homologation-v1',query_id:queryId,actor,authorization_command_id:authCommand,authorization_attempt_id:attempt,source_kind:'authorization',source_command_id:authCommand,source_binding_hash:hash(1),candidate_id:candidate,candidate_version:1,signed_hash:hash(4),signed_size:1024,model:'55',environment:'2',origin:'operational',lease_id:lease,nonce,created_at:'2026-10-17T12:00:00.000Z',expires_at:'2026-10-17T12:01:00.000Z',policy:{model:'55',version:1,enabled:true,...profile,origin:'operational',binding_profile:'sp55-receipt-soap12-reviewed-20261016-v1',lease_seconds:60,cadence_seconds:60,max_queries_per_hour:10,valid_from:'2026-10-17T00:00:00Z',valid_until:'2026-10-18T00:00:00Z',created_at:'2026-10-17T00:00:00Z'},identity_version:1,a1_version:1,credential_id:uid(8),envelope_hash:hash(9),certificate_fingerprint:hash(10),receipt_number:'035000000000001',access_key:'35261012345678000195550010000000011000000010',reference_digest:Buffer.alloc(20,17).toString('base64'),issuer_cnpj:'12345678000195',request_hash:hash(2),request_size:32,issued_at:'2026-10-17T12:00:01.000Z'}};}
const sanitized=error=>!String(error).includes('PRIVATE_SENTINEL')&&!JSON.stringify(error).includes('PRIVATE_SENTINEL');
test('089 port permits exactly eight fixed endpoints, captured body and private transport options',async()=>{
 const calls=[],rpc=make(async(url,o)=>{calls.push({url,o});return Response.json({code:'40001',message:'PRIVATE_SENTINEL'},{status:400});});
 for(const action of['context','begin','prepare','use','finish','fail','command','history']){
  const input=args(action),original=structuredClone(input),pending=rpc(action,input);input.p_user_id=uid(99);if(action==='begin')input.p_selection.expected_signed_hash=hash(99);
  await assert.rejects(pending,e=>e.code==='40001'&&sanitized(e)&&isReceiptQuerySqlFailure(e));const call=calls.at(-1);
  assert.equal(call.url,projectUrl+'/rest/v1/rpc/erp_fiscal_receipt_query_'+action);assert.deepEqual(JSON.parse(call.o.body),original);
  assert.deepEqual([call.o.method,call.o.redirect,call.o.cache,call.o.credentials,call.o.referrerPolicy],['POST','manual','no-store','omit','no-referrer']);assert.equal(call.o.headers.Authorization,'Bearer '+serviceKey);assert.equal(call.o.headers['Accept-Encoding'],'identity');assert.ok(call.o.signal.aborted);
 }
 assert.equal(calls.length,8);await assert.rejects(()=>rpc('authorization_use',args('use')));assert.equal(calls.length,8);
});
test('089 private response grants and empty histories are projected and deeply frozen',async()=>{
 const raw=grant(),rpc=make(async()=>Response.json(raw)),result=await rpc('use',args('use'));assert.deepEqual(result,raw);assert.ok(Object.isFrozen(result.grant.policy));
 const a=args('history'),history={...FLAGS,read_only:true,authorization_command_id:authCommand,authorization_attempt_id:attempt,observed_at:'2026-10-17T12:01:00Z',chain_hash:hash(11),resolution:{state:'pending',query_ids:[],selected_query_id:null,protocol:null,resolution_hash:hash(12)},items:[],next_before:null,limit:25};assert.deepEqual(await make(async()=>Response.json(history))('history',a),history);
});
test('089 rejects input/config getters and foreign URLs before a driver call',async()=>{
 let calls=0,getters=0;const fetchImpl=async()=>{calls++;return Response.json(grant());},rpc=make(fetchImpl),input=args('use');Object.defineProperty(input,'p_query_id',{enumerable:true,get(){getters++;return queryId;}});
 await assert.rejects(()=>rpc('use',input));await assert.rejects(()=>rpc('use',{...args('use'),extra:true}));
 const config={projectUrl,serviceKey,fetchImpl};Object.defineProperty(config,'serviceKey',{enumerable:true,get(){getters++;return serviceKey;}});assert.throws(()=>createReceiptQueryRpc(config));
 for(const url of['http://abcdefghijklmnopqrst.supabase.co',projectUrl+'/',projectUrl+'/rest/v1',projectUrl+'@other.invalid','https://other.invalid'])assert.throws(()=>createReceiptQueryRpc({projectUrl:url,serviceKey,fetchImpl}));
 assert.equal(calls,0);assert.equal(getters,0);
});
test('089 structured SQL failure provenance cannot be forged or copied from thrown driver errors',async()=>{
 for(const code of['22023','40001','42501','55000','P0002']){
  let error;try{await make(async()=>Response.json({code,message:'PRIVATE_SENTINEL'},{status:400}))('command',args('command'));}catch(e){error=e;}
  assert.equal(error.code,code);assert.ok(isReceiptQuerySqlFailure(error));assert.ok(sanitized(error));assert.equal(isReceiptQuerySqlFailure({...error}),false);assert.equal(isReceiptQuerySqlFailure(new AuthorizationServiceError(code)),false);
 }
 for(const fail of[()=>{throw Object.assign(Error('PRIVATE_SENTINEL'),{code:'42501'});},()=>{throw new AuthorizationServiceError('42501');},()=>Response.json({code:'XX000',message:'PRIVATE_SENTINEL'},{status:500}),()=>new Response('<PRIVATE_SENTINEL>',{status:500,headers:{'content-type':'application/json'}})])await assert.rejects(()=>make(fail)('command',args('command')),e=>!isReceiptQuerySqlFailure(e)&&sanitized(e));
 assert.equal(isReceiptQuerySqlFailure(null),false);assert.equal(isReceiptQuerySqlFailure('42501'),false);
});
test('089 rejects redirect, mismatched origin, MIME, compression and malformed body without retry',async()=>{
 const moved=Response.json(grant());Object.defineProperty(moved,'url',{value:'https://other.invalid/private'});
 for(const response of[new Response('{}',{status:302,headers:{'content-type':'application/json',location:'https://other.invalid'}}),moved,Response.json(grant(),{headers:{'content-encoding':'gzip'}}),new Response('{}',{headers:{'content-type':'text/html'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),Response.json({...grant(),secret:'PRIVATE_SENTINEL'}),Response.json({...grant(),can_transmit:true})]){let calls=0;await assert.rejects(()=>make(async()=>{calls++;return response;})('use',args('use')),e=>!isReceiptQuerySqlFailure(e)&&sanitized(e));assert.equal(calls,1);}
});
test('089 enforces success512KiB and error8KiB before and during streaming',async()=>{
 assert.equal(RECEIPT_QUERY_RPC_LIMITS.response,524288);
 for(const [status,limit]of[[200,524288],[400,8192]])for(const advertised of[true,false]){
  let cancelled=0,calls=0;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(limit+1));},cancel(){cancelled++;return new Promise(()=>{});}}),headers={'content-type':'application/json',...(advertised?{'content-length':String(limit+1)}:{})};
  await assert.rejects(()=>bounded(make(async()=>{calls++;return new Response(body,{status,headers});})('command',args('command'))),e=>!isReceiptQuerySqlFailure(e)&&sanitized(e));assert.equal(calls,1);assert.equal(cancelled,1);
 }
});
test('089 cancellation and expired budget prevent retries; late response body is discarded',async()=>{
 const entered=deferred(),driver=deferred();let calls=0,cancelled=0,signal;const rpc=make(async(_u,o)=>{calls++;signal=o.signal;entered.resolve();return driver.promise;}),abort=new AbortController();
 const p=rpc('command',args('command'),{signal:abort.signal,deadline:Date.now()+1000});await entered.promise;abort.abort();await assert.rejects(()=>bounded(p),e=>e.code==='AUTHORIZATION_SERVICE_ABORTED'&&!isReceiptQuerySqlFailure(e));assert.ok(signal.aborted);assert.equal(calls,1);
 driver.resolve(new Response(new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}));await new Promise(r=>setImmediate(r));assert.equal(cancelled,1);
 const before=calls;await assert.rejects(()=>rpc('command',args('command'),{signal:abort.signal}));await assert.rejects(()=>rpc('command',args('command'),{deadline:Date.now()-1}));assert.equal(calls,before);
});
test('089 body stalls, empty chunks and error cleanup cannot hold the deadline',async()=>{
 for(const mode of['stalled','empty','invalid_mime']){let cancelled=0,reads=0;const rpc=make(async()=>new Response(new ReadableStream({pull(c){reads++;if(mode==='empty')c.enqueue(new Uint8Array());},cancel(){cancelled++;return new Promise(()=>{});}}),{status:403,headers:{'content-type':mode==='invalid_mime'?'text/plain':'application/json'}}));
  await assert.rejects(()=>bounded(rpc('command',args('command'),{deadline:Date.now()+20})),e=>!isReceiptQuerySqlFailure(e)&&sanitized(e));assert.equal(cancelled,1);assert.ok(reads<=2);
 }
});
test('089 timeout of driver remains uncertain and bounded, without a structured SQL brand',async()=>{
 let calls=0;await assert.rejects(()=>bounded(make(async()=>{calls++;return new Promise(()=>{});})('command',args('command'),{deadline:Date.now()+15})),e=>e.code==='AUTHORIZATION_SERVICE_TIMEOUT'&&!isReceiptQuerySqlFailure(e));assert.equal(calls,1);
});
test('089 checks the same deadline again after projection',async()=>{
 const originalNow=Date.now,originalFreeze=Object.freeze;let clock=100000,late=false;
 try{Date.now=()=>clock;Object.freeze=v=>{if(v?.data_mode==='fiscal_receipt_query'&&v.private_executor_only===true&&v.grant){clock+=200;late=true;}return originalFreeze(v);};
  await assert.rejects(()=>make(async()=>Response.json(grant()))('use',args('use'),{deadline:100100}),e=>e.code==='AUTHORIZATION_SERVICE_TIMEOUT'&&!isReceiptQuerySqlFailure(e));assert.ok(late);
 }finally{Object.freeze=originalFreeze;Date.now=originalNow;}
});
