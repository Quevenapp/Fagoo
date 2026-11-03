import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {signedFixture} from '../../../tools/migration/fixtures/signed-candidate.mjs';
import {createFiscalSignedRpc} from '../src/rpc.mjs';
import {projectUrl,serviceKey} from './fixtures.mjs';
let f;before(async()=>{f=await signedFixture();});after(()=>f?.close());
function transport({afterRpc}={}){
 const calls=[],rpc=createFiscalSignedRpc({projectUrl,serviceKey,fetchImpl:async(url,init)=>{
  const prefix=projectUrl+'/rest/v1/rpc/';assert.ok(url.startsWith(prefix));assert.equal(init.headers.Authorization,'Bearer '+serviceKey);assert.equal(init.headers.apikey,serviceKey);
  const name=url.slice(prefix.length),args=JSON.parse(init.body.toString());calls.push({name,args});let value;
  try{value=await f.callSql(name,args);}catch(error){return Response.json({code:error.code,message:'PRIVATE-DIAGNOSTIC',details:serviceKey},{status:({'42501':403,'40001':409,'22023':400,'55000':503,P0002:404})[error.code]??500});}
  await afterRpc?.(name,args,value);calls.at(-1).size=Buffer.byteLength(JSON.stringify(value));return Response.json(value);
 }});return{calls,call:(name,args)=>rpc('erp_fiscal_signed_'+name,{p_user_id:f.users.fiscal,...args},{deadline:Date.now()+10000})};
}
test('all seven050 RPC shapes traverse the private projection for55/65 with no numerical or business effects',async()=>{
 const t=transport();for(const model of['55','65']){
  const s=await f.stored({model}),args=await f.beginArgs(s),before=await f.counts(),value=await t.call('begin',args),r={args,value};
  const use=await t.call('use',{p_candidate_id:value.receipt.candidate_id,p_lease_id:value.execution.lease_id});assert.equal(use.identity.model,model);assert.equal(use.credential_object.hash,f.selected.objectHash);assert.equal(use.private_executor_only,true);
  await f.object(r);const finish={p_candidate_id:value.receipt.candidate_id,p_lease_id:value.execution.lease_id,p_signed_hash:f.proof(r).signature.xml_hash,p_size_bytes:1024,p_evidence:f.proof(r)},saved=await t.call('finish',finish);
  assert.equal(saved.current.state,'stored');assert.equal(saved.can_emit,false);assert.deepEqual(await f.counts(),before);assert.deepEqual(await t.call('finish',finish),{...saved,replayed:true});
  const read=await t.call('get',{p_candidate_id:value.receipt.candidate_id});assert.equal(read.read_only,true);assert.equal((await t.call('command',{p_command_id:args.p_command_id})).receipt.candidate_id,value.receipt.candidate_id);
  const history=await t.call('history',{p_unsigned_job_id:s.result.job_id,p_limit:1,p_before:null});assert.equal(history.items[0].receipt.candidate_id,value.receipt.candidate_id);assert.equal(history.items[0].current.artifact_current,true);
  const failureSource=await f.stored({model}),failure=await t.call('begin',await f.beginArgs(failureSource));const failed=await t.call('fail',{p_candidate_id:failure.receipt.candidate_id,p_lease_id:failure.execution.lease_id,p_error_code:'XSD_INVALID'});assert.equal(failed.current.state,'failed');assert.equal(failed.signed,false);
 }assert.ok(t.calls.every(c=>c.size===undefined||c.size<=131072));
});
test('lost finish response is not retried by the port and an explicit command read preserves receipt versus disabled current',async()=>{
 const s=await f.stored(),args=await f.beginArgs(s),t=transport({afterRpc:name=>{if(name.endsWith('_finish'))throw Error('PRIVATE lost response '+serviceKey);}}),value=await t.call('begin',args),r={args,value};
 await t.call('use',{p_candidate_id:value.receipt.candidate_id,p_lease_id:value.execution.lease_id});await f.object(r);
 await assert.rejects(()=>t.call('finish',{p_candidate_id:value.receipt.candidate_id,p_lease_id:value.execution.lease_id,p_signed_hash:f.proof(r).signature.xml_hash,p_size_bytes:1024,p_evidence:f.proof(r)}),e=>e.code==='FISCAL_SIGNED_RPC_IO_FAILED'&&!String(e).includes('PRIVATE'));
 assert.equal(t.calls.filter(c=>c.name.endsWith('_finish')).length,1);const recovered=await t.call('command',{p_command_id:args.p_command_id});assert.equal(recovered.current.state,'stored');await f.disable();
 const old=await t.call('begin',args);assert.equal(old.execution,null);assert.deepEqual(old.receipt,recovered.receipt);assert.equal(old.current.artifact_current,false);assert.equal(old.current.a1_changed,true);
 await f.configure();
});
test('real SQL denies wrong actors, absent commands and stale bases without exposing diagnostics',async()=>{
 const t=transport(),s=await f.stored(),args=await f.beginArgs(s),value=await t.call('begin',args);
 await assert.rejects(()=>t.call('get',{p_user_id:f.users.consulta,p_candidate_id:value.receipt.candidate_id}),{code:'42501'});
 await assert.rejects(()=>t.call('command',{p_user_id:f.users.admin,p_command_id:args.p_command_id}),{code:'42501'});
 await assert.rejects(()=>t.call('command',{p_command_id:crypto.randomUUID()}),{code:'P0002'});
 await f.updateCompletion(s.source);await assert.rejects(()=>t.call('use',{p_candidate_id:value.receipt.candidate_id,p_lease_id:value.execution.lease_id}),{code:'40001'});
});
