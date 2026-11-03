import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {receiptQueryFixture,hash} from './receipt-query-sql-fixture.mjs';
import {captureReceiptQueryRpc,projectReceiptQueryLedger,receiptQueryRecovery,receiptQueryGrant,RECEIPT_QUERY_RPC_LIMITS} from '../src/receipt-query-ledger-dto.mjs';
const clone=structuredClone;
const responseError=e=>e.code==='RECEIPT_QUERY_LEDGER_RESPONSE_INVALID';
const inputError=e=>e.code==='RECEIPT_QUERY_LEDGER_INPUT_INVALID';
test('089 private projector binds real SQL replies without promoting recovery or changing original evidence',async t=>{
 const f=await receiptQueryFixture(),cases=[];try{
  await f.enableQuery();
  for(const model of['55','65'])for(const kind of['authorization','revalidation'])await t.test(`${model}/${kind}: eight operation contracts and immutable capture`,async()=>{
   const x=await f.querySource(model,kind),contextArgs=captureReceiptQueryRpc('context',x.contextArgs),ctx=projectReceiptQueryLedger('context',x.context,contextArgs);
   assert.equal(ctx.private_eligible_for_attested_source,true);assert.equal(ctx.can_query,false);assert.ok(Object.isFrozen(ctx.source.original_source));
   const b=await f.queryBegin(x),bc=captureReceiptQueryRpc('begin',b.args),begin=projectReceiptQueryLedger('begin',b.value,bc);
   assert.deepEqual(begin.execution,begin.recovery);assert.deepEqual(projectReceiptQueryLedger('begin',await f.queryCall('begin',bc),bc).execution,null);
   const p=await f.queryPrepare(b);projectReceiptQueryLedger('prepare',p.value,captureReceiptQueryRpc('prepare',p.args));
   const useArgs=captureReceiptQueryRpc('use',f.queryIds(b)),used=await f.queryUse(b),use=projectReceiptQueryLedger('use',used,useArgs);assert.equal(use.grant.query_id,begin.query_id);assert.deepEqual(receiptQueryGrant(used,useArgs),use);
   const finishArgs=await f.queryFinishArgs(b,p,model==='55'?'100':'150'),finished=await f.queryCall('finish',finishArgs),finish=projectReceiptQueryLedger('finish',finished,captureReceiptQueryRpc('finish',finishArgs));assert.equal(finish.current.state,'authorized_homologation');
   projectReceiptQueryLedger('prepare',await f.queryCall('prepare',p.args),p.args);projectReceiptQueryLedger('finish',await f.queryCall('finish',finishArgs),finishArgs);
   const commandArgs={p_user_id:f.users.fiscal,p_command_id:b.value.query_id},commandRaw=await f.queryCall('command',commandArgs),command=projectReceiptQueryLedger('command',commandRaw,captureReceiptQueryRpc('command',commandArgs));assert.equal(command.execution,null);
   const historyArgs={p_user_id:f.users.fiscal,p_authorization_command_id:x.context.source.authorization_command_id,p_expected_attempt_id:x.context.source.authorization_attempt_id,p_limit:25,p_before:null},historyRaw=await f.queryCall('history',historyArgs),history=projectReceiptQueryLedger('history',historyRaw,captureReceiptQueryRpc('history',historyArgs));assert.equal(history.items[0].query_id,command.query_id);
   const after=projectReceiptQueryLedger('context',await f.queryCall('context',contextArgs),contextArgs);assert.ok(after.blockers.includes('RESOLUTION_CLOSED'));assert.equal(after.private_eligible_for_attested_source,false);
   const recovery=receiptQueryRecovery(command.recovery,{actor:f.users.fiscal,query_id:command.query_id});assert.deepEqual(recovery,command.recovery);
   const input=clone(contextArgs),copy=captureReceiptQueryRpc('context',input);input.p_source_command_id=randomUUID();assert.deepEqual(copy,contextArgs);
   cases.push({x,b,p,used,useArgs,finishArgs,finished,commandArgs,commandRaw,historyArgs,historyRaw});
  });
  const a=cases[0],b=cases[1],c=cases[2];
  await t.test('binding rejects actor, command, selected source, attempt, model and lease substitution',()=>{
   for(const [action,raw,args]of[['command',a.commandRaw,b.commandArgs],['context',a.x.context,{...a.x.contextArgs,p_user_id:f.users.admin}],['context',a.x.context,{...a.x.contextArgs,p_expected_attempt_id:randomUUID()}],['use',a.used,b.useArgs],['finish',a.finished,b.finishArgs],['history',a.historyRaw,b.historyArgs]])assert.throws(()=>projectReceiptQueryLedger(action,raw,args),responseError);
   for(const mutate of[x=>x.source.original_source.recovery.actor=f.users.admin,x=>x.source.signed_hash=hash('other'),x=>x.receipt.model='65',x=>x.recovery.lease_id=randomUUID(),x=>x.recovery.issuer_cnpj='00000000000000',x=>x.source_validation.source_binding_hash=hash('wrong')]){const raw=clone(a.finished);mutate(raw);assert.throws(()=>projectReceiptQueryLedger('finish',raw,a.finishArgs),responseError);}
   assert.throws(()=>receiptQueryRecovery(a.commandRaw.recovery,{query_id:b.b.value.query_id}),responseError);
   assert.throws(()=>receiptQueryRecovery(c.commandRaw.recovery,{model:'55'}),responseError);
  });
  await t.test('only literal use grants allow issued_at, and replay cannot restore execution',()=>{
   const replay=clone(a.b.value);replay.replayed=true;assert.throws(()=>projectReceiptQueryLedger('begin',replay,a.b.args),responseError);
   assert.throws(()=>receiptQueryGrant(a.commandRaw,a.useArgs),responseError);
   assert.throws(()=>receiptQueryRecovery(a.used.grant),responseError);
   for(const mutate of[x=>x.grant.issued_at=x.grant.expires_at,x=>x.grant.issued_at='2020-01-01T00:00:00Z',x=>x.grant.purpose='sp-authorization-homologation-v1',x=>x.can_transmit=true,x=>x.grant.request_hash=null,x=>x.grant.policy.enabled=false,x=>x.grant.nonce=null]){const raw=clone(a.used);mutate(raw);assert.throws(()=>receiptQueryGrant(raw,a.useArgs),responseError);}
   const command=clone(a.commandRaw);command.execution=clone(command.recovery);assert.throws(()=>projectReceiptQueryLedger('command',command,a.commandArgs),responseError);
  });
  await t.test('request, result, observation and processed hashes/nonces remain cross-bound',()=>{
   for(const mutate of[x=>x.request.evidence.nonce=randomUUID(),x=>x.request.evidence.payload_hash='a'.repeat(63),x=>x.artifact.evidence.observation_hash=hash('wrong'),x=>x.artifact.evidence.reference_digest=Buffer.alloc(20,1).toString('base64'),x=>x.artifact.response_hash=hash('wrong'),x=>x.artifact.processed_hash=null,x=>x.current.grant_consumed=false,x=>x.current.used_at=x.current.expires_at,x=>x.source_validation.payload_hash=hash('wrong'),x=>x.artifact.evidence.receipt_number='035000000000999']){const raw=clone(a.commandRaw);mutate(raw);assert.throws(()=>projectReceiptQueryLedger('command',raw,a.commandArgs),responseError);}
   assert.throws(()=>captureReceiptQueryRpc('finish',{...a.finishArgs,p_evidence:b.finishArgs.p_evidence}),inputError);
  });
  await t.test('context is not an executable grant and requires explicit blockers/nullable heads',()=>{
   for(const mutate of[x=>x.can_query=true,x=>x.source_validation_required=false,x=>x.private_eligible_for_attested_source=false,x=>x.selection.expected_chain_hash=hash('different'),x=>x.policy.enabled=false,x=>x.next_query_at='2099-01-01T00:00:00Z',x=>x.blockers.push('ANY_OTHER'),x=>x.heads.a1_version=null]){const raw=clone(a.x.context);mutate(raw);assert.throws(()=>projectReceiptQueryLedger('context',raw,a.x.contextArgs),responseError);}
   const raw=clone(a.x.context);raw.heads.a1_version=null;raw.selection.expected_a1_version=null;raw.blockers.push('A1_UNAVAILABLE');raw.private_eligible_for_attested_source=false;assert.equal(projectReceiptQueryLedger('context',raw,a.x.contextArgs).heads.a1_version,null);
  });
  await t.test('history verifies pagination, unique ordinals and the resolution binding',()=>{
   for(const mutate of[x=>x.items.push(clone(x.items[0])),x=>x.next_before=99,x=>x.resolution.selected_query_id=randomUUID(),x=>x.items[0].resolution.resolution_hash=hash('wrong'),x=>x.items[0].receipt.authorization_attempt_id=randomUUID()]){const raw=clone(a.historyRaw);mutate(raw);assert.throws(()=>projectReceiptQueryLedger('history',raw,a.historyArgs),responseError);}
   assert.throws(()=>projectReceiptQueryLedger('history',a.historyRaw,{...a.historyArgs,p_before:1}),responseError);
   const raw=clone(a.commandRaw);raw.resolution.state='conflict';raw.resolution.selected_query_id=null;raw.resolution.query_ids.push(randomUUID());assert.equal(projectReceiptQueryLedger('command',raw,a.commandArgs).resolution.state,'conflict');
   const hidden=clone(a.commandRaw);hidden.resolution={state:'pending',query_ids:[],selected_query_id:null,protocol:null,resolution_hash:hash('opaque')};assert.throws(()=>projectReceiptQueryLedger('command',hidden,a.commandArgs),responseError);
  });
  await t.test('25 distinct full private rows fit512KiB; larger accumulated resolution fails closed',()=>{
   for(const example of cases){
    const h=clone(example.historyRaw),ids=Array.from({length:25},()=>randomUUID());h.resolution.query_ids=ids;h.resolution.selected_query_id=ids[0];
    h.items=ids.map((id,i)=>{const row=clone(h.items[0]);row.query_id=id;row.receipt.query_id=id;row.receipt.ordinal=i+1;row.recovery.query_id=id;row.recovery.nonce=randomUUID();row.recovery.lease_id=randomUUID();row.request.query_id=id;row.request.evidence.query_id=id;row.request.evidence.nonce=row.recovery.nonce;row.artifact.query_id=id;row.artifact.evidence.query_id=id;row.artifact.evidence.nonce=row.recovery.nonce;row.resolution=clone(h.resolution);return row;}).reverse();
    assert.ok(Buffer.byteLength(JSON.stringify(h))<RECEIPT_QUERY_RPC_LIMITS.response);assert.equal(projectReceiptQueryLedger('history',h,example.historyArgs).items.length,25);
    const context={...clone(example.x.context),resolution:clone(h.resolution),history:clone(h.items),observed_at:new Date(Date.parse(h.items[0].receipt.expires_at)+1000).toISOString(),blockers:['SOURCE_VALIDATION_REQUIRED','RESOLUTION_CLOSED'],private_eligible_for_attested_source:false};
    assert.ok(Buffer.byteLength(JSON.stringify(context))<RECEIPT_QUERY_RPC_LIMITS.response);assert.equal(projectReceiptQueryLedger('context',context,example.x.contextArgs).history.length,25);
    const upper=clone(context),maximize=v=>{if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){if(typeof x==='number'&&(k==='version'||k.endsWith('_version')))v[k]=999999999;else if(typeof x==='string'&&(k==='batch_id'||k==='ordinal'))v[k]='999999999999999';else if(x&&typeof x==='object')maximize(x);}};maximize(upper);
    assert.ok(Buffer.byteLength(JSON.stringify(upper))<RECEIPT_QUERY_RPC_LIMITS.response);projectReceiptQueryLedger('context',upper,example.x.contextArgs);
    const forbidden=clone(context);forbidden.source.original_source.rule_review.declaration={items:Array(250).fill({position:1})};assert.throws(()=>projectReceiptQueryLedger('context',forbidden,example.x.contextArgs),responseError);
    const huge=clone(h);huge.resolution.query_ids.push(...Array.from({length:1000},()=>randomUUID()));for(const row of huge.items)row.resolution=clone(huge.resolution);
    assert.ok(Buffer.byteLength(JSON.stringify(huge))>RECEIPT_QUERY_RPC_LIMITS.response);assert.throws(()=>projectReceiptQueryLedger('history',huge,example.historyArgs),responseError);
   }
  });
  await t.test('closed inputs reject unknown operations, versions, nulls, partial evidence and confirmations',()=>{
   for(const [action,args]of[['wrong',a.b.args],['context',{...a.x.contextArgs,extra:true}],['begin',{...a.b.args,p_confirmed:false}],['begin',{...a.b.args,p_command_id:a.b.value.source.authorization_command_id}],['begin',{...a.b.args,p_selection:{...a.b.args.p_selection,expected_a1_version:1000000000}}],['history',{...a.historyArgs,p_limit:26}],['prepare',{...a.p.args,p_request_size:0}],['fail',{...a.useArgs,p_error_code:'UNRECOGNIZED'}]])assert.throws(()=>captureReceiptQueryRpc(action,args),inputError);
  });
  await t.test('descriptors, deep/large data, cycles and alias mutation are bounded without invoking code',()=>{
   let calls=0;const raw=clone(a.commandRaw);Object.defineProperty(raw,'receipt',{enumerable:true,get(){calls++;throw Error('no');}});assert.throws(()=>projectReceiptQueryLedger('command',raw,a.commandArgs),responseError);assert.equal(calls,0);
   const tojson=clone(a.commandArgs);tojson.toJSON=()=>{calls++;return a.commandArgs;};assert.throws(()=>captureReceiptQueryRpc('command',tojson),inputError);assert.equal(calls,0);
   const cycle=clone(a.commandRaw);cycle.source.original_source.receipt=cycle;assert.throws(()=>projectReceiptQueryLedger('command',cycle,a.commandArgs),responseError);
   const large=clone(a.commandRaw);large.extra='x'.repeat(RECEIPT_QUERY_RPC_LIMITS.response+1);assert.throws(()=>projectReceiptQueryLedger('command',large,a.commandArgs),responseError);
   const captured=projectReceiptQueryLedger('command',a.commandRaw,a.commandArgs),before=captured.receipt.actor;const mutable=clone(a.commandRaw),copy=projectReceiptQueryLedger('command',mutable,a.commandArgs);mutable.receipt.actor=randomUUID();assert.equal(copy.receipt.actor,before);assert.ok(Object.isFrozen(copy.recovery.policy));
  });
  for(const variant of['105','245','106','invalid_response'])await t.test(`real SQL outcome ${variant} stays separate from authorization`,async()=>{
   const x=await f.querySource(),q=await f.queryBegin(x),p=await f.queryPrepare(q);await f.queryUse(q);let args=await f.queryFinishArgs(q,p,variant==='invalid_response'?'106':variant);
   if(variant==='invalid_response')args={...args,p_evidence:{...args.p_evidence,outcome:'invalid_response',rejection_code:'SOAP_INVALID',payload_hash:null,cstat:null,protocol_cstat:null,received_at:null,xsd_validated:false,context_matched:false}};
   const raw=await f.queryCall('finish',captureReceiptQueryRpc('finish',args)),out=projectReceiptQueryLedger('finish',raw,args);assert.notEqual(out.current.state,'authorized_homologation');assert.equal(out.artifact.processed_hash,null);
  });
  for(const consumed of[false,true])await t.test(`fail/replay ${consumed?'after':'before'} consume has no execution`,async()=>{
   const x=await f.querySource(),q=await f.queryBegin(x);if(consumed){await f.queryPrepare(q);await f.queryUse(q);}const args={...f.queryIds(q),p_error_code:'RECEIPT_QUERY_TRANSPORT_FAILED'};
   const out=projectReceiptQueryLedger('fail',await f.queryCall('fail',args),captureReceiptQueryRpc('fail',args));assert.equal(out.current.state,consumed?'uncertain':'failed_before_dispatch');assert.equal(projectReceiptQueryLedger('fail',await f.queryCall('fail',args),args).replayed,true);
  });
 }finally{await f.close();}
});
