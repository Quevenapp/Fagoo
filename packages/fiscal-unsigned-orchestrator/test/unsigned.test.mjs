import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,hash} from './fixture.mjs';

let f;before(async()=>{f=await fixture();});after(()=>f?.close());
const rpcCount=name=>f.calls.rpc.filter(v=>v.name==='erp_fiscal_unsigned_'+name).length;
const code=value=>error=>error.code===value;
const noUse=value=>{for(const name of['can_emit','can_transmit','tax_rules_validated','xsd_validated','signature_verified','authorized','financial_mutation_performed','stock_mutation_performed'])assert.equal(value[name],false);};
const noPrivate=value=>assert.doesNotMatch(JSON.stringify(value),/INTERNAL-COMMERCIAL|cnpj|access_key|lease_id|"identity"|"execution"|"inputs"|<NFe|PRIVATE-ERROR/);
const deferred=()=>Promise.withResolvers();

test('preview resolves real048 content before046 without persistence, identity or number consumption',async()=>{
 const p=await f.prepare({reserve:false}),before=await f.counts(),writes=f.calls.put.length;
 const result=await f.orchestrator().preview(f.previewInput(p));
 assert.equal(result.status,'checked');assert.equal(result.arithmetic_verified,true);assert.equal(result.identity_assigned,false);assert.equal(result.xml_generated,false);assert.equal(result.items,1);assert.match(result.basis_hash,/^[a-f0-9]{64}$/);noUse(result);noPrivate(result);
 assert.deepEqual(await f.counts(),before);assert.equal(f.calls.put.length,writes);
});
test('incomplete or arithmetically inconsistent completion is blocked before a job is claimed',async()=>{
 for(const payments of[{items:[],change:null},{items:[{type:'01',timing:'0',amount:'12.51'}],change:'0.00'}]){
  const p=await f.prepare({completionPatch:{payments}}),j=await f.input(p),before=await f.counts();
  const result=await f.orchestrator().run(j);assert.equal(result.status,'blocked');assert.equal(result.outcome,'not_started');assert.equal(result.phase,'preflight');assert.equal(result.xml_generated,false);assert.deepEqual(await f.counts(),before);
 }
});
test('models55/65 store exact unsigned bytes; replay reads current state without another upload or number',async()=>{
 for(const model of['55','65']){
  const p=await f.prepare({model}),j=await f.input(p),before=await f.counts(),orchestrator=f.orchestrator(),result=await orchestrator.run(j);
  assert.equal(result.status,'stored');assert.equal(result.current.artifact_current,true);assert.equal(result.current.attempt_count,1);assert.equal(result.storage_operations,3);assert.equal(result.xml_generated,true);noUse(result);noPrivate(result);
  const key='jobs/'+result.job_id+'/'+result.artifact.sha256+'.xml',bytes=f.files.get(key);assert.ok(bytes);assert.equal(hash(bytes),result.artifact.sha256);assert.equal(bytes.length,result.artifact.size_bytes);assert.match(bytes.toString(),new RegExp('<mod>'+model+'</mod>'));assert.doesNotMatch(bytes.toString(),/<Signature|<infNFeSupl|<protNFe/);
  const after=await f.counts();assert.equal(after.identities,before.identities+1);assert.equal(after.jobs,before.jobs+1);assert.equal(after.artifacts,before.artifacts+1);assert.equal(after.reservations,before.reservations);assert.equal(after.numbers,before.numbers);assert.equal(after.stock,0);assert.equal(after.finance,0);
  const puts=f.calls.put.length,reads=f.calls.read.length,replay=await orchestrator.run(j);assert.equal(replay.status,'stored');assert.equal(replay.recovered,true);assert.deepEqual(replay.artifact,result.artifact);assert.deepEqual(await f.counts(),after);assert.equal(f.calls.put.length,puts);assert.equal(f.calls.read.length,reads);
 }
});
test('strict inputs and unauthorized actors never gain an execution lease',async()=>{
 const p=await f.prepare(),j=await f.input(p),before=await f.counts(),orchestrator=f.orchestrator(),calls=f.calls.rpc.length;
 for(const patch of[{identity:{}},{cNF:'12345678'},{actor:[j.actor]},{completionVersion:0},{basisHash:'bad'}])await assert.rejects(()=>orchestrator.run({...j,...patch}),code('UNSIGNED_INPUT_INVALID'));
 assert.equal(f.calls.rpc.length,calls);
 const denied=await orchestrator.run({...j,actor:f.users.consulta});assert.equal(denied.status,'blocked');assert.equal(denied.code,'UNSIGNED_RPC_42501');assert.deepEqual(await f.counts(),before);
});
test('lost begin ACK preserves the command and waits for its lease; retry after expiry uses the same identity',async()=>{
 const j=await f.input(await f.prepare()),before=await f.counts();let lost=true;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{const v=await f.rpc(name,args,options);if(name.endsWith('_begin')&&lost){lost=false;throw new Error('PRIVATE-ERROR begin ACK lost');}return v;}});
 const first=await orchestrator.run(j);assert.equal(first.status,'recoverable');assert.equal(first.phase,'begin');noPrivate(first);
 const claimed=await f.command(j),key=claimed.receipt.access_key,puts=f.calls.put.length;
 const waiting=await orchestrator.run(j);assert.equal(waiting.status,'pending');assert.equal(waiting.current.attempt_count,1);assert.equal(f.calls.put.length,puts);
 await f.expire(j);const completed=await orchestrator.run(j);assert.equal(completed.status,'stored');assert.equal(completed.current.attempt_count,2);assert.equal((await f.command(j)).receipt.access_key,key);
 const after=await f.counts();assert.equal(after.identities,before.identities+1);assert.equal(after.reservations,before.reservations);assert.equal(after.numbers,before.numbers);
});
test('lost upload ACK is recovered by immutable readback with original identity, without another PUT',async()=>{
 const j=await f.input(await f.prepare());let lost=true,borrowed;
 const orchestrator=f.orchestrator({storage:{...f.ports.storage,putImmutable:async input=>{borrowed=input.bytes;const value=await f.ports.storage.putImmutable(input);if(lost){lost=false;throw new Error('PRIVATE-ERROR put ACK lost');}return value;}}});
 const first=await orchestrator.run(j);assert.equal(first.status,'stored');assert.equal(first.storage_operations,3);assert.ok(borrowed.every(b=>b===0));
 const old=await f.command(j),puts=f.calls.put.length;assert.equal(old.current.state,'stored');
 const second=await orchestrator.run(j);assert.equal(second.status,'stored');assert.equal(f.calls.put.length,puts);assert.equal((await f.command(j)).receipt.access_key,old.receipt.access_key);
});
test('lost upload ACK plus failed readback leaves the attempt pending for later read-only recovery',async()=>{
 const j=await f.input(await f.prepare());let putLost=true,readLost=true;
 const orchestrator=f.orchestrator({storage:{
  putImmutable:async input=>{const value=await f.ports.storage.putImmutable(input);if(putLost){putLost=false;throw new Error('PRIVATE-ERROR put lost');}return value;},
  read:async input=>{if(!putLost&&readLost){readLost=false;throw new Error('PRIVATE-ERROR read lost');}return f.ports.storage.read(input);}
 }});
 const first=await orchestrator.run(j);assert.equal(first.status,'recoverable');assert.equal(first.xml_generated,null);assert.equal((await f.command(j)).current.state,'pending');
 const puts=f.calls.put.length;await f.expire(j);const second=await orchestrator.run(j);assert.equal(second.status,'stored');assert.equal(second.storage_operations,1);assert.equal(f.calls.put.length,puts);
});
test('lost finish ACK recovers committed state with current command lookup and never publishes twice',async()=>{
 const j=await f.input(await f.prepare());let lost=true;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{const value=await f.rpc(name,args,options);if(name.endsWith('_finish')&&lost){lost=false;throw new Error('PRIVATE-ERROR finish ACK lost');}return value;}});
 const first=await orchestrator.run(j);assert.equal(first.status,'stored');assert.equal(first.recovered,true);assert.equal((await f.command(j)).current.state,'stored');const counts=await f.counts(),puts=f.calls.put.length;
 const second=await orchestrator.run(j);assert.equal(second.status,'stored');assert.equal(second.job_id,first.job_id);assert.deepEqual(await f.counts(),counts);assert.equal(f.calls.put.length,puts);
});
test('finish ACK plus recovery read failure remains unconfirmed until the next command lookup',async()=>{
 const j=await f.input(await f.prepare());let finishLost=true,recoveryLost=true;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{
  if(name.endsWith('_command')&&!finishLost&&recoveryLost){recoveryLost=false;throw new Error('PRIVATE-ERROR lookup lost');}
  const value=await f.rpc(name,args,options);if(name.endsWith('_finish')&&finishLost){finishLost=false;throw new Error('PRIVATE-ERROR finish lost');}return value;
 }});
 const first=await orchestrator.run(j);assert.equal(first.status,'recoverable');assert.equal(first.outcome,'unconfirmed');assert.equal(first.xml_generated,null);noPrivate(first);
 assert.equal((await f.command(j)).current.state,'stored');const counts=await f.counts(),second=await orchestrator.run(j);assert.equal(second.status,'stored');assert.equal(second.recovered,true);assert.deepEqual(await f.counts(),counts);
});
test('ordinary readback loss after successful finish is recovered from current command state',async()=>{
 const j=await f.input(await f.prepare());let lost=true;
 const result=await f.orchestrator({rpc:async(name,args,options)=>{if(name.endsWith('_get')&&lost){lost=false;throw new Error('PRIVATE-ERROR get unavailable');}return f.rpc(name,args,options);}}).run(j);
 assert.equal(result.status,'stored');assert.equal(result.recovered,true);assert.equal((await f.command(j)).current.state,'stored');noPrivate(result);
});
test('corrupt Storage readback cannot finalize, then recovery verifies the preserved correct object',async()=>{
 const j=await f.input(await f.prepare());let corrupt=true;
 const orchestrator=f.orchestrator({storage:{...f.ports.storage,read:async input=>{const result=await f.ports.storage.read(input);if(result&&corrupt){corrupt=false;const bytes=new Uint8Array(await result.arrayBuffer());bytes[0]^=1;return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length)}});}return result;}}});
 const finishes=rpcCount('finish'),first=await orchestrator.run(j);assert.equal(first.status,'recoverable');assert.equal(first.code,'UNSIGNED_STORAGE_HASH_CONFLICT');assert.equal(rpcCount('finish'),finishes);assert.equal((await f.command(j)).artifact,null);
 const puts=f.calls.put.length;await f.expire(j);const second=await orchestrator.run(j);assert.equal(second.status,'stored');assert.equal(f.calls.put.length,puts);
});
test('redirect or ambiguous Storage failures are never absence and never authorize a PUT',async()=>{
 for(const read of[async()=>new Response(null,{status:302,headers:{Location:'https://example.invalid/private'}}),async()=>{throw new Error('PRIVATE-ERROR storage denied');}]){
  const j=await f.input(await f.prepare()),puts=f.calls.put.length,finishes=rpcCount('finish'),result=await f.orchestrator({storage:{...f.ports.storage,read}}).run(j);
  assert.equal(result.status,'recoverable');assert.equal(result.phase,'storage');assert.equal(f.calls.put.length,puts);assert.equal(rpcCount('finish'),finishes);assert.equal((await f.command(j)).current.state,'pending');noPrivate(result);
 }
});
test('completion changed during byte upload prevents stale finalize and leaves historical identity recoverable',async()=>{
 const p=await f.prepare(),j=await f.input(p);let changed=false;
 const result=await f.orchestrator({storage:{...f.ports.storage,read:async input=>{const value=await f.ports.storage.read(input);if(value&&!changed){changed=true;await f.updateCompletion(p,{additional_information:'CORRECAO FICTICIA DURANTE UPLOAD'});}return value;}}}).run(j);
 assert.equal(result.status,'recoverable');assert.equal(result.phase,'finish');assert.equal(result.code,'UNSIGNED_RPC_40001');const current=await f.command(j);assert.equal(current.current.state,'pending');assert.equal(current.current.basis_changed,true);assert.equal(current.artifact,null);
 const waiting=await f.orchestrator().run(j);assert.equal(waiting.status,'pending');assert.equal(waiting.current.basis_changed,true);
 await f.expire(j);const blocked=await f.orchestrator().run(j);assert.equal(blocked.status,'recoverable');assert.equal(blocked.outcome,'unconfirmed');assert.equal(blocked.xml_generated,null);assert.equal((await f.command(j)).current.attempt_count,1);
});
test('old terminal receipt is returned with current stale flags after a new completion, not as current XML',async()=>{
 const p=await f.prepare(),j=await f.input(p),orchestrator=f.orchestrator(),first=await orchestrator.run(j);await f.updateCompletion(p,{additional_information:'CORRECAO FICTICIA POSTERIOR'});
 const puts=f.calls.put.length,replay=await orchestrator.run(j);assert.equal(replay.status,'stored');assert.equal(replay.current.artifact_current,false);assert.equal(replay.current.basis_changed,true);assert.deepEqual(replay.artifact,first.artifact);assert.equal(f.calls.put.length,puts);
 const next=await orchestrator.run(await f.input(p));assert.equal(next.status,'stored');assert.equal(next.job_version,2);assert.notEqual(next.job_id,first.job_id);assert.equal((await f.command(j)).receipt.access_key,(await f.get(next.job_id)).receipt.access_key);
});
test('revocation before a replay prevents metadata recovery and Storage work',async()=>{
 const j=await f.input(await f.prepare()),orchestrator=f.orchestrator();await orchestrator.run(j);const puts=f.calls.put.length,reads=f.calls.read.length;
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[j.actor]);
 try{const denied=await orchestrator.run(j);assert.equal(denied.status,'blocked');assert.equal(denied.code,'UNSIGNED_RPC_42501');assert.equal(f.calls.put.length,puts);assert.equal(f.calls.read.length,reads);assert.equal(denied.job_id,undefined);}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[j.actor]);}
});
test('abort after begin commit discards late execution and never uploads; later call recovers pending command',async()=>{
 const j=await f.input(await f.prepare()),committed=deferred(),release=deferred(),controller=new AbortController(),puts=f.calls.put.length;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{const value=await f.rpc(name,args,options);if(name.endsWith('_begin')){committed.resolve();await release.promise;}return value;}});
 const pending=orchestrator.run(j,{signal:controller.signal});await committed.promise;controller.abort();const result=await pending;assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_ABORTED');assert.equal(result.phase,'begin');release.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.put.length,puts);
 assert.equal((await f.orchestrator().run(j)).status,'pending');assert.equal((await f.command(j)).current.attempt_count,1);
});
test('timeout before mutation is blocked; another call may retry without a leaked running lock',async()=>{
 const j=await f.input(await f.prepare()),before=await f.counts();let hang=true;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{if(name.endsWith('_basis')&&hang){hang=false;return new Promise(()=>{});}return f.rpc(name,args,options);}});
 const timed=await orchestrator.run(j,{deadline:Date.now()+100});assert.equal(timed.status,'blocked');assert.equal(timed.code,'UNSIGNED_TIMEOUT');assert.equal(timed.outcome,'not_started');assert.deepEqual(await f.counts(),before);
 assert.equal((await orchestrator.run(j)).status,'stored');
});
test('the same in-process command cannot start concurrently and the guard is released after completion',async()=>{
 const j=await f.input(await f.prepare()),entered=deferred(),release=deferred();let wait=true;
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{if(name.endsWith('_command')&&wait){wait=false;entered.resolve();await release.promise;}return f.rpc(name,args,options);}});
 const first=orchestrator.run(j);await entered.promise;await assert.rejects(()=>orchestrator.run(j),code('UNSIGNED_ALREADY_RUNNING'));release.resolve();const result=await first;assert.equal(result.status,'stored');assert.equal((await orchestrator.run(j)).job_id,result.job_id);
});
test('swapped begin execution identity or stored-job response is rejected before delivering an artifact',async()=>{
 const p=await f.prepare(),j=await f.input(p),puts=f.calls.put.length;
 const response=await f.orchestrator({rpc:async(name,args,options)=>{const v=await f.rpc(name,args,options);if(name.endsWith('_begin'))v.execution.identity.cNF='00000000';return v;}}).run(j);
 assert.equal(response.status,'recoverable');assert.equal(response.code,'UNSIGNED_EXECUTION_INVALID');assert.equal(f.calls.put.length,puts);assert.equal((await f.command(j)).current.state,'pending');
 const storedInput=await f.input(await f.prepare()),orchestrator=f.orchestrator();await orchestrator.run(storedInput);
 const swapped=await f.orchestrator({rpc:async(name,args,options)=>{const v=await f.rpc(name,args,options);if(name.endsWith('_command'))v.receipt.reservation_id=randomUUID();return v;}}).run(storedInput);
 assert.equal(swapped.status,'blocked');assert.equal(swapped.code,'UNSIGNED_RESPONSE_INVALID');assert.equal(swapped.artifact,undefined);
});
test('250 captured items remain within the real builder limit and no sensitive execution input escapes',async()=>{
 const j=await f.input(await f.prepare({model:'65',count:250})),result=await f.orchestrator().run(j);assert.equal(result.status,'stored');assert.ok(result.artifact.size_bytes>100000);assert.ok(result.artifact.size_bytes<=480000);noUse(result);noPrivate(result);assert.equal((await f.counts()).stock,0);assert.equal((await f.counts()).finance,0);
});
