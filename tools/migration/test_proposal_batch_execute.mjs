import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditProposalBatch,prepareProposalBatch,proposalBatchDigest} from './plan_proposal_batch.mjs';
import {executeProposalBatch} from './execute_proposal_batch.mjs';
import {ProposalBatchError} from './proposal_batch_port.mjs';
import {proposalBatchFixture,f} from './proposal_batch_test_fixture.mjs';

async function setup(t,count=2){
 const x=proposalBatchFixture(count),audit=await auditProposalBatch({port:x.port}),plan=await prepareProposalBatch({audit,selectedSourceIds:x.ids,duplicateReviewed:true});
 const directory=await fs.mkdtemp(join(tmpdir(),'brufap-proposal-batch-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const file=join(directory,`proposal-batch-${plan.plan_id}.json`),options={plan,approvedPlanHash:proposalBatchDigest(plan),directory,port:x.port,mode:'apply',confirmCreateDrafts:true};
 return{...x,plan,directory,file,options,read:async()=>JSON.parse(await fs.readFile(file,'utf8')),posts:()=>x.calls.filter(c=>c.name.endsWith('apply_v2'))};
}
test('two reviewed sources create only distinct draft v1 documents; pending/body/UUID are durable before each POST',async t=>{
 const x=await setup(t),existing=structuredClone(x.baseline);let observed=0;
 const port={...x.port,call:async(type,input,options)=>{if(type==='apply'){const state=await x.read(),e=state.items.find(e=>e.command_id===input.command_id);assert.equal(e.state,'pending');assert.deepEqual(e.body,input);assert.equal((await fs.stat(x.file)).mode&0o777,0o600);observed++;}return x.port.call(type,input,options);}};
 const result=await executeProposalBatch({...x.options,port});assert.equal(result.outcome,'complete');assert.equal(result.verified,2);assert.equal(observed,2);assert.equal(result.draft_version_1_verified,true);assert.deepEqual(result.inventory,{missing:0,changed:0,unexpected:0});assert.deepEqual(x.native.get(existing.id),existing);
 const state=await x.read();assert.ok(state.items.every(e=>e.receipt.document.version===1&&e.current.document.version===1));assert.ok(x.calls.every(c=>!/(save|transition|convert)/.test(c.name)));
 assert.equal((await executeProposalBatch(x.options)).outcome,'complete');assert.equal(x.posts().length,2);
});
test('commit response lost and readback unavailable stops next item; recovery only GETs same UUID',async t=>{
 const x=await setup(t);let committed=false,readFails=true;
 const port={...x.port,call:async(type,input,options)=>{if(type==='command'&&committed&&readFails)throw new ProposalBatchError('RPC_UNCONFIRMED',503);const r=await x.port.call(type,input,options);if(type==='apply'){committed=true;throw new Error('synthetic lost ACK');}return r;}};
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'unresolved');assert.equal(x.posts().length,1);assert.equal((await x.read()).items[0].state,'pending');
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'unresolved');assert.equal(x.posts().length,1);
 readFails=false;const recovered=await executeProposalBatch({...x.options,port,mode:'recover'});assert.equal(recovered.outcome,'prepared');assert.equal(recovered.verified,1);assert.equal(x.posts().length,1);assert.equal((await x.read()).items[0].command_id,x.plan.items[0].command_id);
});
test('ACK is durable even if GET later returns 404; neither apply mode nor recovery resends',async t=>{
 const x=await setup(t,1);let committed=false;
 const port={...x.port,call:async(type,input,options)=>{if(type==='command'&&committed)throw new ProposalBatchError('COMMAND_NOT_FOUND',404);const r=await x.port.call(type,input,options);if(type==='apply')committed=true;return r;}};
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'acknowledged');const first=await x.read();assert.equal(first.items[0].state,'acknowledged');assert.ok(first.items[0].receipt);
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'acknowledged');assert.equal(x.posts().length,1);assert.deepEqual((await x.read()).items[0].receipt,first.items[0].receipt);
});
test('pending before a failed dispatch is never retried, even with authoritative command 404',async t=>{
 const x=await setup(t,1);let attempts=0;const port={...x.port,call:async(type,input,options)=>{if(type==='apply'){attempts++;throw new ProposalBatchError('RPC_UNCONFIRMED',503);}return x.port.call(type,input,options);}};
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'unresolved');assert.equal((await executeProposalBatch({...x.options,port})).outcome,'unresolved');assert.equal(attempts,1);assert.equal(x.posts().length,0);
});
test('full preview compare rejects local binding or text changes even with the same SQL preview hash',async t=>{
 for(const mutate of [p=>p.bindings[0].record_version++,p=>p.proposed.notes='New synthetic note',p=>p.source_version='2',p=>p.source_evidence.items[0].discount_observed='6.000000']){
  const x=await setup(t,1);mutate(x.previews.get(x.ids[0]));const r=await executeProposalBatch(x.options);assert.equal(r.outcome,'source_changed');assert.equal(x.posts().length,0);assert.equal((await x.read()).items[0].state,'prepared');
 }
});
test('polling-only observed time change does not rewrite the approved plan or reject identical source proofs',async t=>{
 const x=await setup(t,1),hash=proposalBatchDigest(x.plan);x.previews.get(x.ids[0]).source_seen_at='2026-10-16T13:00:00.000000+00:00';assert.equal((await executeProposalBatch(x.options)).outcome,'complete');assert.equal(proposalBatchDigest(x.plan),hash);
});
test('later native edit is current_changed, receipt stays draft v1, and next source is not imported',async t=>{
 const x=await setup(t);const port={...x.port,call:async(type,input,options)=>{const r=await x.port.call(type,input,options);if(type==='apply'){const current=x.commands.get(input.command_id);current.current_document.version=2;current.current_document.notes='Later human edit';}return r;}};
 const r=await executeProposalBatch({...x.options,port});assert.equal(r.outcome,'current_changed');assert.equal(x.posts().length,1);const e=(await x.read()).items[0];assert.equal(e.receipt.document.version,1);assert.equal(e.current.document.version,2);
});
test('baseline change and unreviewed existing document stop before dispatch; no existing document is edited',async t=>{
 const x=await setup(t,1);x.native.get(x.baseline.id).version++;const r=await executeProposalBatch(x.options);assert.equal(r.outcome,'baseline_changed');assert.equal(r.inventory.changed,1);assert.equal(x.posts().length,0);
});
test('a historical receipt mismatch never becomes a valid readback or another POST',async t=>{
 const x=await setup(t,1),entry=x.plan.items[0],body={source_id:entry.source_id,command_id:entry.command_id,preview_hash:entry.preview.preview_hash,confirm_import:true,duplicate_reviewed:true};
 const ack=f.ack(body,entry.preview),current=f.current(ack,entry.preview);current.receipt.source_hash='c'.repeat(64);x.commands.set(entry.command_id,current);
 assert.equal((await executeProposalBatch(x.options)).outcome,'unresolved');assert.equal(x.posts().length,0);
});
test('default recovery is GET-only and explicit approval hash, actor and create confirmation are required',async t=>{
 const x=await setup(t,1);assert.equal((await executeProposalBatch({...x.options,mode:'recover'})).outcome,'prepared');assert.equal(x.posts().length,0);
 await assert.rejects(executeProposalBatch({...x.options,approvedPlanHash:'0'.repeat(64)}),/PLAN_NOT_APPROVED/);
 await assert.rejects(executeProposalBatch({...x.options,confirmCreateDrafts:false}),/EXECUTION_NOT_CONFIRMED/);
 await assert.rejects(executeProposalBatch({...x.options,port:{...x.port,actor:'b0000000-0000-4000-8000-000000000001'}}),/ACTOR_PROJECT_MISMATCH/);
});
test('global exclusive lock rejects concurrent execution and symlink state files are not followed',async t=>{
 const x=await setup(t,1);let entered,release;const inCall=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 const port={...x.port,call:async(type,input,options)=>{if(type==='command'){entered();await gate;}return x.port.call(type,input,options);}};
 const pending=executeProposalBatch({...x.options,port,mode:'recover'});await inCall;
 await assert.rejects(executeProposalBatch({...x.options,mode:'recover'}),e=>e.code==='EEXIST');release();await pending;
 await fs.unlink(x.file);await fs.writeFile(join(x.directory,'target.json'),'{}',{mode:0o600});await fs.symlink(join(x.directory,'target.json'),x.file);
 await assert.rejects(executeProposalBatch({...x.options,mode:'recover'}),e=>e.code==='ELOOP');assert.equal(x.posts().length,0);
});
test('caller mutation after invocation cannot alter command/body or the reviewed source',async t=>{
 const x=await setup(t,1),original=structuredClone(x.plan);let modified=false;
 const port={...x.port,call:async(type,input,options)=>{if(!modified){modified=true;x.plan.items[0].command_id='f0000000-0000-4000-8000-000000000099';x.plan.items[0].preview.proposed.notes='Changed outside';}return x.port.call(type,input,options);}};
 assert.equal((await executeProposalBatch({...x.options,port})).outcome,'complete');assert.equal(x.posts()[0].args.p_command_id,original.items[0].command_id);assert.equal((await x.read()).items[0].body.command_id,original.items[0].command_id);
});
