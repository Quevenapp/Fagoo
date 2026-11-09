import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {handleQueues,queuesRoute,queuesPublicRoute} from '../src/queues.mjs';
const unit=randomUUID(),user=randomUUID(),device=randomUUID();
const call=(path,method='GET',body,actor={userId:user})=>{const calls=[];return {calls,run:()=>handleQueues({request:new Request('https://synthetic.test'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}),...actor,rpc:async(name,args)=>{calls.push({name,args});return {ok:true};}})};};
test('queue route dispatch pins verified actors and accepts only explicit commands',async()=>{
 assert.equal(queuesRoute('/v1/queues/units/'+unit+'/snapshot'),true);assert.equal(queuesRoute('/v1/queues-evil'),false);
 const body={command_id:randomUUID(),type:'ticket.issue',payload:{queue_id:randomUUID(),priority:false,print:false}};
 const f=call(`/v1/queues/units/${unit}/commands`,'POST',body);assert.equal((await f.run()).status,200);assert.deepEqual(f.calls[0].args,{p_user_id:user,p_device_id:null,p_unit_id:unit,p_command_id:body.command_id,p_type:body.type,p_payload:body.payload,p_expected_version:null});
 for(const bad of[{...body,user_id:randomUUID()},{...body,payload:{...body.payload,user_id:randomUUID()}},{...body,type:'x'},{...body,expected_version:-1},{...body,payload:{...body.payload,priority:'true'}}]){const r=call(`/v1/queues/units/${unit}/commands`,'POST',bad);await assert.rejects(r.run,{status:400});assert.equal(r.calls.length,0);}
});
test('device can issue and acknowledge effects but cannot operate/configure/read history',async()=>{
 const actor={userId:null,deviceId:device},path=`/v1/queues/units/${unit}`;
 for(const type of ['queue.save','ticket.call_next','ticket.start','rating.request','config.save','order.create'])await assert.rejects(call(path+'/commands','POST',{command_id:randomUUID(),type,payload:{}},actor).run,{status:403});
 await assert.rejects(call(path+'/history','GET',undefined,actor).run,{status:403});
 const f=call(path+'/effects/claim','POST',{kind:'audio',claim_id:randomUUID(),after_revision:200},actor);await f.run();assert.equal(f.calls[0].name,'fagoo_queue_effect_claim');assert.equal(f.calls[0].args.p_user_id,null);assert.equal(f.calls[0].args.p_device_id,device);
 await assert.rejects(call(path+'/effects/claim','POST',{kind:'print',claim_id:randomUUID()}).run,{status:403});
 await assert.rejects(call(path+'/events?after=3&after=4').run,{status:400});
 await assert.rejects(call(path+'/events?after=-1').run,{status:400});
});
test('public token read and ratings require no staff authority and reject excess data',async()=>{
 const token='a'.repeat(32),path='/v1/queues/public/'+token;assert.equal(queuesPublicRoute(path),true);assert.equal(queuesPublicRoute(path+'/rating'),true);assert.equal(queuesPublicRoute(path+'/commands'),false);
 const f=call(path,'GET',undefined,{});await f.run();assert.deepEqual(f.calls[0],{name:'fagoo_queue_public',args:{p_token:token}});
 for(const stars of[0,6,'5',null])await assert.rejects(call(path+'/rating','POST',{invite_id:randomUUID(),stars},{}).run,{status:400});
 await assert.rejects(call(path+'/rating','POST',{invite_id:randomUUID(),stars:5,user_id:user},{}).run,{status:400});
 await assert.rejects(call(`/v1/queues/units/${unit}/snapshot`,'GET',undefined,{}).run,{status:401});
});
test('issued/recovered tickets receive only the configured public URL; redacted tickets stay redacted',async()=>{
 const token='a'.repeat(32),id=randomUUID(),base=`https://synthetic.test/v1/queues/units/${unit}`;
 for(const mode of ['command','receipt','cancel']){
  const request=new Request(base+(mode==='command'?'/commands':'/receipts/'+id),{method:mode==='receipt'?'GET':'POST',...(mode==='receipt'?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(mode==='command'?{command_id:id,type:'ticket.issue',payload:{queue_id:randomUUID()}}:{cancel:true})})});
  const result={ok:true,result:{ticket:{public_token:token}}};
  const response=await handleQueues({request,deviceId:device,env:{FAGOO_WEB_ORIGIN:'https://company.example'},rpc:async()=>mode==='receipt'?{status:'confirmed',response:result}:result});
  const body=await response.json();assert.equal((body.response??body).result.ticket.tracking_url,'https://company.example/senha/'+token);
 }
 const request=new Request(base+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command_id:id,type:'print.reprint',payload:{ticket_id:randomUUID(),confirmed:true}})});
 const body=await(await handleQueues({request,deviceId:device,env:{FAGOO_WEB_ORIGIN:'https://company.example'},rpc:async()=>({ok:true,result:{ticket:{display_number:'A001'}}})})).json();
 assert.deepEqual(body.result.ticket,{display_number:'A001'});
});
