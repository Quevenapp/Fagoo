import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createWsdlRpc} from '../src/service-rpc.mjs';
import {serviceFixture} from './service-fixture.mjs';
let f,begin,command,use,args;const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-service-key-not-a-secret';
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const options=()=>({deadline:Date.now()+1000});const code=x=>e=>e.code===x;
const factory=fetchImpl=>createWsdlRpc({projectUrl,serviceKey,fetchImpl});
before(async()=>{f=await serviceFixture();args={p_user_id:f.actor,p_command_id:f.input.commandId,p_model:'55',p_operation:'protocol',p_expected_a1_version:1,p_expected_identity_version:1,p_confirmed:true};begin=await f.callSql('erp_fiscal_wsdl_begin',args);command=await f.command();use=await f.callSql('erp_fiscal_wsdl_use',{p_user_id:f.actor,p_attempt_id:begin.receipt.attempt_id,p_lease_id:begin.execution.lease_id});});after(async()=>f?.close());
test('private RPC captures exact arguments and actor before awaiting the mandatory driver',async()=>{
 let captured;const input={...args},rpc=factory(async(url,o)=>{captured={url,o,body:JSON.parse(Buffer.from(o.body).toString())};return json(begin);});const pending=rpc('erp_fiscal_wsdl_begin',input,options());input.p_model='65';input.p_command_id=randomUUID();const result=await pending;
 assert.deepEqual(captured.body,args);assert.equal(captured.url,projectUrl+'/rest/v1/rpc/erp_fiscal_wsdl_begin');assert.equal(captured.o.redirect,'manual');assert.equal(captured.o.headers.apikey,serviceKey);assert.equal(result.execution.credential.object.key,begin.execution.credential.object.key);assert.ok(Object.isFrozen(result.execution.credential));assert.ok(captured.o.body.every(x=>x===0));
});
test('allowlist, confirmation, unknown fields, getters and expired deadlines fail before fetch',async()=>{
 let calls=0,touched=false;const rpc=factory(async()=>{calls++;return json(begin);});
 for(const[name,input]of [['erp_a1_metadata',args],['erp_fiscal_wsdl_begin',{...args,p_url:'https://evil.invalid'}],['erp_fiscal_wsdl_begin',{...args,p_confirmed:false}],['erp_fiscal_wsdl_begin',{...args,p_expected_a1_version:1.5}],['erp_fiscal_wsdl_begin',{...args,get p_model(){touched=true;return'55';}}]])await assert.rejects(()=>rpc(name,input,options()));
 await assert.rejects(()=>rpc('erp_fiscal_wsdl_begin',args,{deadline:Date.now()-1}),code('WSDL_RPC_DEADLINE_INVALID'));assert.equal(calls,0);assert.equal(touched,false);
});
test('SQLSTATE is allowlisted without reflecting raw message/detail/secrets',async()=>{
 for(const state of ['42501','40001','22023','55000','P0002','XXSECRET']){const rpc=factory(async()=>new Response(JSON.stringify({code:state,message:'PASSWORD_SENTINEL',details:serviceKey}),{status:400,headers:{'content-type':'application/json'}}));await assert.rejects(()=>rpc('erp_fiscal_wsdl_begin',args,options()),e=>{assert.equal(e.code,state==='XXSECRET'?'WSDL_RPC_HTTP_REJECTED':state);assert.doesNotMatch(String(e),/PASSWORD|synthetic-service/);return true;});}
});
test('response binding rejects wrong command/actor/scope and promoted flags',async()=>{
 for(const value of [{...begin,command_id:randomUUID()},{...begin,can_transmit:true},{...begin,receipt:{...begin.receipt,a1_version:2}},{...begin,execution:{...begin.execution,scope:{...begin.execution.scope,actor:randomUUID()}}},{...begin,execution:{...begin.execution,credential:{...begin.execution.credential,password:'SECRET'}}}])await assert.rejects(()=>factory(async()=>json(value))('erp_fiscal_wsdl_begin',args,options()),code('WSDL_SERVICE_RESPONSE_INVALID'));
 const useArgs={p_user_id:f.actor,p_attempt_id:begin.receipt.attempt_id,p_lease_id:begin.execution.lease_id};assert.equal((await factory(async()=>json(use))('erp_fiscal_wsdl_use',useArgs,options())).grant.actor,f.actor);
 await assert.rejects(()=>factory(async()=>json({...use,grant:{...use.grant,endpoint:'https://evil.invalid'}}))('erp_fiscal_wsdl_use',useArgs,options()),code('WSDL_SERVICE_RESPONSE_INVALID'));
});
test('response headers, redirects, UTF8 and metadata limit are strict',async()=>{
 const responses=[new Response(null,{status:302,headers:{location:'https://evil.invalid'}}),new Response('{}',{headers:{'content-type':'text/plain'}}),new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'131073'}}),new Response(' '.repeat(131073),{headers:{'content-type':'application/json'}})];
 for(const r of responses)await assert.rejects(()=>factory(async()=>r)('erp_fiscal_wsdl_command',{p_user_id:f.actor,p_command_id:f.input.commandId},options()));
 const wrong=json(command);Object.defineProperty(wrong,'url',{value:'https://evil.invalid'});await assert.rejects(()=>factory(async()=>wrong)('erp_fiscal_wsdl_command',{p_user_id:f.actor,p_command_id:f.input.commandId},options()),code('WSDL_RPC_RESPONSE_INVALID'));
});
test('abort includes body consumption and retains only the original signal',async()=>{
 const c=new AbortController();let cancelled=false,entered;const opened=new Promise(r=>entered=r),o={deadline:Date.now()+1000,signal:c.signal};
 const rpc=factory(async()=>new Response(new ReadableStream({start(){entered();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));const pending=rpc('erp_fiscal_wsdl_begin',args,o);o.signal=undefined;await opened;c.abort();await assert.rejects(()=>pending,code('WSDL_RPC_ABORTED'));assert.equal(cancelled,true);
});
test('driver ignoring signal is bounded and late response is cancelled',async()=>{
 let release,cancelled=false;const rpc=factory(()=>new Promise(r=>release=r));const pending=rpc('erp_fiscal_wsdl_begin',args,{deadline:Date.now()+20});await assert.rejects(()=>pending,code('WSDL_RPC_TIMEOUT'));release(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await new Promise(r=>setTimeout(r,10));assert.equal(cancelled,true);
});
