import test from 'node:test';
import assert from 'node:assert/strict';
import {handleCommunication,runCommunicationNoticeTasks,forwardCommunicationPublic} from '../../erp-api/src/communication.mjs';
const user='11111111-1111-1111-1111-111111111111',unit='22222222-2222-2222-2222-222222222222';
const capabilities=['communication.read','communication.claim','communication.reply','communication.configure','team.chat'];
const context={units:[{id:unit,capabilities}]};
const grant={user_id:user,unit_id:unit,profile_id:'legacy-profile',capabilities};
test('delegates only the canonical actor and strips client credentials',async()=>{
 let captured;const rpcCalls=[];
 const response=await handleCommunication({request:new Request(`https://api.test/v1/communication/units/${unit}/conversations`,{headers:{Authorization:'Bearer private','X-Fagoo-Delegation':'forged',Cookie:'private'}}),userId:user,deviceId:null,context,rpc:async(name,args)=>{rpcCalls.push({name,args});return grant;},env:{COMMUNICATION:{fetch:async request=>{captured=request;return Response.json({data:[]},{headers:{'Set-Cookie':'unsafe=1'}});}}}});
 assert.equal(response.status,200);assert.equal(captured.headers.get('authorization'),null);assert.equal(captured.headers.get('cookie'),null);assert.equal(JSON.parse(captured.headers.get('X-Fagoo-Delegation')).user_id,user);assert.equal(new URL(captured.url).pathname,'/api/v1/profiles/legacy-profile/conversations');assert.equal(response.headers.get('set-cookie'),null);assert.equal(rpcCalls[0].args.p_user_id,user);
});
test('refuses panel identities and respects canonical authorization denial',async()=>{
 const request=new Request(`https://api.test/v1/communication/units/${unit}/team`);
 assert.equal((await handleCommunication({request,userId:user,deviceId:unit,env:{},rpc:()=>assert.fail()})).status,403);
 assert.equal((await handleCommunication({request,userId:user,context,env:{},rpc:()=>{throw Object.assign(Error(),{status:403,code:'ERP_ACCESS_DENIED'});}})).status,403);
});
test('never grants claim using a read permission or an actor from JSON',async()=>{
 let args;await handleCommunication({request:new Request(`https://api.test/v1/communication/units/${unit}/conversations/c/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'claim',user_id:'forged'})}),userId:user,context,env:{},rpc:async(name,a)=>{args=a;return {...grant,capabilities:['communication.read']};}});
 assert.equal(args.p_capability,'communication.claim');assert.equal(args.p_user_id,user);
});
test('preserves webhook signatures and bytes through the public forwarding binding',async()=>{
 const bytes='{"message":"á\\n"}';let body,signature;
 const request=new Request('https://api.test/webhooks/meta/line',{method:'POST',headers:{'X-Hub-Signature-256':'sha256=test'},body:bytes});
 await forwardCommunicationPublic({request,env:{COMMUNICATION_PUBLIC:{fetch:async request=>{body=await request.text();signature=request.headers.get('X-Hub-Signature-256');return new Response('ok');}}}});
 assert.equal(body,bytes);assert.equal(signature,'sha256=test');
});
test('records asynchronous acceptance as unknown and reconciles without issuing a second send',async()=>{
 const calls=[],expires='2030-01-01T00:00:00Z';let sent=0;
 await runCommunicationNoticeTasks({publicOrigin:'https://fagoo.test',env:{COMMUNICATION:{queueNoticeStatus:async()=>({status:'sent'}),sendQueueNotice:async input=>{sent++;assert.equal(input.expires_at,Date.parse(expires));assert.equal(input.free_only,true);assert.match(input.text,/https:\/\/fagoo.test\/senha\/public/);return {status:'pending',delivery_id:'new-delivery'};}}},rpc:async(name,args)=>{calls.push({name,args});if(name==='fagoo_queue_notice_pending_deliveries')return {notices:[{notice_id:'old',claim_id:'lease',unit_id:unit,delivery_id:'old-delivery'}]};if(name==='fagoo_queue_notice_claim')return {notices:[{notice_id:'new',claim_id:'lease'}]};if(name==='fagoo_queue_notice_revalidate')return {notice_id:'new',claim_id:'lease',unit_id:unit,phone:'5511999999999',text:'Sua senha',public_token:'public',expires_at:expires};return {};}});
 assert.equal(sent,1);assert.ok(calls.some(c=>c.name==='fagoo_queue_notice_ack' && c.args.p_notice_id==='old' && c.args.p_status==='sent'));assert.ok(calls.some(c=>c.name==='fagoo_queue_notice_ack' && c.args.p_notice_id==='new' && c.args.p_status==='unknown' && c.args.p_delivery_id==='new-delivery'));
});
test('does not enqueue a stale notice after its queue state changes',async()=>{
 let sent=false;await runCommunicationNoticeTasks({publicOrigin:'https://fagoo.test',env:{COMMUNICATION:{sendQueueNotice:async()=>{sent=true;}}},rpc:async name=>name==='fagoo_queue_notice_pending_deliveries'?{notices:[]}:name==='fagoo_queue_notice_claim'?{notices:[{notice_id:'stale',claim_id:'lease'}]}:null});assert.equal(sent,false);
});
