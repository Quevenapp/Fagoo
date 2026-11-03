import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../../fiscal-unsigned-orchestrator/test/fixture.mjs';
import {createFiscalUnsignedRpc} from '../src/rpc.mjs';

const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-rpc-interoperability-key';
let f;before(async()=>{f=await fixture();});after(()=>f?.close());
function transport({afterRpc}={}){
 const calls=[];const rpc=createFiscalUnsignedRpc({projectUrl,serviceKey,fetchImpl:async(url,init)=>{
  assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer '+serviceKey);assert.equal(init.headers.apikey,serviceKey);assert.equal(init.signal.aborted,false);
  assert.ok(url.startsWith(projectUrl+'/rest/v1/rpc/'));const name=url.slice((projectUrl+'/rest/v1/rpc/').length),args=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(init.body));assert.match(name,/^erp_fiscal_unsigned_[a-z_]+$/);
  const call={name,args};calls.push(call);let value;
  try{value=await f.callSql(name,args);}catch(error){return Response.json({code:error.code,message:'PRIVATE-SQL-DIAGNOSTIC',details:'NOT FOR CALLER'},{status:({'42501':403,'40001':409,'22023':400,'55000':400,P0002:404})[error.code]??500});}
  call.responseBytes=Buffer.byteLength(JSON.stringify(value));await afterRpc?.(name,args,value);
  const response=Response.json(value);Object.defineProperty(response,'url',{value:url});return response;
 }});return{rpc,calls};
}
test('PGlite048 through bounded RPC transport previews before046 and publishes unsigned55/65 only',async()=>{
 const unreserved=await f.prepare({reserve:false}),t=transport(),executor=f.orchestrator({rpc:t.rpc}),before=await f.counts();
 assert.equal((await executor.preview(f.previewInput(unreserved))).status,'checked');assert.deepEqual(await f.counts(),before);
 for(const model of['55','65']){
  const p=await f.prepare({model}),input=await f.input(p),start=await f.counts(),result=await executor.run(input);
  assert.equal(result.status,'stored');assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);assert.equal(result.signature_verified,false);assert.equal(result.xsd_validated,false);
  const final=await f.counts();assert.equal(final.reservations,start.reservations);assert.equal(final.numbers,start.numbers);assert.equal(final.finance,0);assert.equal(final.stock,0);
  assert.ok(t.calls.some(c=>c.name==='erp_fiscal_unsigned_begin'&&c.args.p_command_id===input.commandId));
 }
 assert.ok(t.calls.every(call=>call.args.p_user_id===f.users.fiscal));
});
test('a committed finish with lost HTTP response is recovered without another finish or upload',async()=>{
 let lose=true;const t=transport({afterRpc:async name=>{if(name.endsWith('_finish')&&lose){lose=false;throw new Error('PRIVATE-ERROR '+serviceKey);}}});
 const input=await f.input(await f.prepare()),executor=f.orchestrator({rpc:t.rpc}),first=await executor.run(input);assert.equal(first.status,'stored');assert.equal(first.recovered,true);assert.doesNotMatch(JSON.stringify(first),/PRIVATE|synthetic-rpc/);
 const writes=t.calls.filter(v=>v.name==='erp_fiscal_unsigned_finish').length,puts=f.calls.put.length,next=await executor.run(input);assert.equal(next.status,'stored');assert.equal(next.job_id,first.job_id);assert.equal(t.calls.filter(v=>v.name==='erp_fiscal_unsigned_finish').length,writes);assert.equal(f.calls.put.length,puts);
});
test('actual SQLSTATE absence permits begin, but ACL or current-basis conflicts cannot impersonate absence',async()=>{
 const t=transport(),executor=f.orchestrator({rpc:t.rpc}),p=await f.prepare(),input=await f.input(p),before=await f.counts();
 const denied=await executor.run({...input,actor:f.users.consulta});assert.equal(denied.status,'blocked');assert.equal(denied.code,'UNSIGNED_RPC_42501');assert.deepEqual(await f.counts(),before);assert.equal(t.calls.filter(c=>c.name.endsWith('_begin')).length,0);
 await f.updateCompletion(p,{additional_information:'VERSAO ATUAL ALTERADA'});const changed=await executor.run(input);assert.equal(changed.status,'blocked');assert.equal(changed.code,'UNSIGNED_RPC_40001');assert.deepEqual(await f.counts(),before);assert.equal(t.calls.filter(c=>c.name.endsWith('_begin')).length,0);
});
test('history and old commands retain current stale flags across the strict metadata response boundary',async()=>{
 const t=transport(),executor=f.orchestrator({rpc:t.rpc}),p=await f.prepare(),firstInput=await f.input(p),first=await executor.run(firstInput);
 await f.updateCompletion(p,{additional_information:'NOVA REVISAO SINTETICA'});const second=await executor.run(await f.input(p));assert.equal(second.status,'stored');
 const old=await executor.run(firstInput);assert.equal(old.status,'stored');assert.equal(old.current.artifact_current,false);assert.equal(old.current.latest_job_id,second.job_id);
 const history=await t.rpc('erp_fiscal_unsigned_history',{p_user_id:f.users.fiscal,p_reservation_id:firstInput.reservationId},{deadline:Date.now()+10000});
 assert.equal(history.items.length,2);assert.equal(history.items[0].receipt.job_id,second.job_id);assert.equal(history.items[1].receipt.job_id,first.job_id);assert.equal(history.items[1].current.artifact_current,false);assert.equal(history.can_emit,false);
});
test('250-item basis and execution traverse the 8MiB boundary while all metadata stays within128KiB',async()=>{
 const t=transport(),input=await f.input(await f.prepare({model:'65',count:250})),result=await f.orchestrator({rpc:t.rpc}).run(input);assert.equal(result.status,'stored');
 for(const call of t.calls.filter(c=>c.responseBytes!==undefined)){
  if(call.name.endsWith('_basis')||call.name.endsWith('_begin')){assert.ok(call.responseBytes>131072);assert.ok(call.responseBytes<=8388608);}else assert.ok(call.responseBytes<=131072);
 }
 assert.equal((await f.counts()).finance,0);assert.equal((await f.counts()).stock,0);
});
