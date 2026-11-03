import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../../fiscal-unsigned-orchestrator/test/fixture.mjs';
import {FLAGS,projectSqlView,projectSqlHistory,publicResult,timestamp} from '../src/dto.mjs';
const bad=e=>e.code==='UNSIGNED_RESPONSE_INVALID';
test('real048 SQL and orchestrator outputs project compact history/read/run bindings without private execution data',async()=>{
 const f=await fixture();try{
  const prepared=await f.prepare(),input=await f.input(prepared),payload={command_id:input.commandId,reservation_id:input.reservationId,draft_id:input.draftId,completion_version:input.completionVersion,completion_hash:input.completionHash,basis_hash:input.basisHash};
  const preview=await f.orchestrator().preview(f.previewInput(prepared));assert.equal(publicResult(preview,{action:'preview',payload:{draft_id:input.draftId,completion_version:input.completionVersion}}).status,'checked');
  const run=await f.orchestrator().run(input),result=publicResult(run,{action:'generate',payload});assert.equal(result.status,'stored');assert.equal(result.completion_hash,input.completionHash);
  const command=projectSqlView(await f.command(input),{commandId:input.commandId});assert.equal(publicResult(command,{action:'command',commandId:input.commandId}).command_id,input.commandId);
  const sql=await f.get(run.job_id);sql.private_noise={xml:'<NFe>',identity:'SECRET',lease_id:randomUUID()};
  const job=projectSqlView(sql,{jobId:run.job_id});assert.equal(job.read_only,true);assert.equal(Object.hasOwn(job,'command_id'),false);assert.equal(publicResult(job,{action:'job',jobId:run.job_id}).job_id,run.job_id);
  const alpha=structuredClone(sql);alpha.receipt.access_key=alpha.receipt.access_key.slice(0,6)+'A'+alpha.receipt.access_key.slice(7);alpha.artifact.access_key=alpha.receipt.access_key;
  assert.equal(projectSqlView(alpha,{jobId:run.job_id}).job_id,run.job_id); // Structural projection; issuer/key validation belongs to the internal binder.
  assert.doesNotMatch(JSON.stringify(job),/access_key|cnpj|identity|lease_id|<NFe|SECRET|proofs|bucket|execution|inputs/);
  const raw=await f.callSql('erp_fiscal_unsigned_history',{p_user_id:input.actor,p_reservation_id:input.reservationId,p_limit:25,p_before:null});
  const history=projectSqlHistory(raw,{reservationId:input.reservationId,limit:25,before:null});assert.equal(history.items.length,1);
  assert.deepEqual(publicResult(history,{action:'history',payload:{reservation_id:input.reservationId,limit:25,before:null}}),history);
  for(const mutate of[v=>v.can_emit=true,v=>v.receipt.basis_hash='bad',v=>v.artifact.size_bytes=480001,v=>v.artifact.created_at='2026-02-30T00:00:00Z',v=>v.current.is_latest_job=false,v=>v.current.completion_version=0]){
   const changed=structuredClone(sql);mutate(changed);assert.throws(()=>projectSqlView(changed,{jobId:run.job_id}),bad);
  }
  assert.throws(()=>publicResult(result,{action:'generate',payload:{...payload,basis_hash:'f'.repeat(64)}}),bad);
  assert.throws(()=>projectSqlView(sql,{jobId:randomUUID()}),bad);
  const duplicate=structuredClone(history);duplicate.items.push(duplicate.items[0]);assert.throws(()=>publicResult(duplicate,{action:'history',payload:{reservation_id:input.reservationId,limit:25,before:null}}),bad);
 }finally{await f.close();}
});
test('blocked and recoverable are separate, sanitized and cannot claim an XML or change command binding',()=>{
 const payload={command_id:randomUUID()},value={...FLAGS,status:'recoverable',command_id:payload.command_id,code:'UNSIGNED_TIMEOUT',phase:'finish',xml_generated:null,outcome:'unconfirmed',storage_operations:3,xml:'SECRET'};
 const clean=publicResult(value,{action:'generate',payload});assert.equal(clean.xml_generated,null);assert.equal(clean.xml,undefined);
 for(const patch of[{xml_generated:false},{outcome:'not_started'},{code:'SECRET_RAW_ERROR'},{command_id:randomUUID()},{storage_operations:5}])assert.throws(()=>publicResult({...value,...patch},{action:'generate',payload}),bad);
 assert.equal(publicResult({...value,status:'blocked',xml_generated:false,outcome:'not_started',phase:'preflight'},{action:'generate',payload}).status,'blocked');
 assert.equal(timestamp('2026-02-30T12:00:00Z'),false);assert.equal(timestamp('2024-02-29T12:00:00.123456-03:00'),true);
});
