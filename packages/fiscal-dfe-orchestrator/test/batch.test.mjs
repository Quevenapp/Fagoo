import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,responseBytes,hash,BUCKET} from './fixture.mjs';
import {createDfeBatchOrchestrator} from '../src/batch.mjs';

let f;
before(async()=>{f=await fixture();});
beforeEach(()=>f.reset());
after(()=>f?.close());
const syntheticError=()=>new Error('SYNTHETIC_PRIVATE_DETAIL_MUST_NOT_ESCAPE');
const responseTransport=(options={},beforeReturn)=>({exchange:async(plan,context)=>{f.calls.transport.push({plan,context});await beforeReturn?.();const bytes=responseBytes(plan.request,options);return{bytes,request_hash:plan.request_hash,wire_hash:plan.wire_hash,response_hash:hash(bytes)};}});
const pending=async()=>new Promise(()=>{});
const reserveArgs=j=>({p_user_id:j.actor,p_command_id:j.commandId,p_channel_id:j.channelId,p_expected_version:j.expectedVersion});
const leased=(j,r)=>({p_user_id:j.actor,p_attempt_id:j.commandId,p_lease_id:r.lease_id});
const journal=(j,r)=>`responses/${j.commandId}/${r.request_hash}.xml`;
const inject=async(key,bytes)=>{f.files.set(key,Buffer.from(bytes));await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',[BUCKET,key,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);};

test('mandatory ports and exact jobs reject before any I/O; no default driver or credential permission',async()=>{
 assert.throws(()=>createDfeBatchOrchestrator(),{code:'DFE_PORTS_REQUIRED'});
 for(const key of ['rpc','transport','storage','withAuthorizedCredential'])assert.throws(()=>createDfeBatchOrchestrator({...f.ports,[key]:undefined}),{code:'DFE_PORTS_REQUIRED'});
 const j=await f.job(),app=f.orchestrator(),before=f.calls.rpc.length;
 for(const input of [{...j,url:'https://untrusted.invalid'},{...j,expectedVersion:0},{...j,actor:'wrong'},{...j,commandId:3}])await assert.rejects(()=>app.run(input),{code:'DFE_JOB_INVALID'});
 await assert.rejects(()=>app.run(j,{deadline:Date.now()-1}),{code:'DFE_JOB_DEADLINE_INVALID'});assert.equal(f.calls.rpc.length,before);assert.equal(f.calls.transport.length,0);
});

test('actual045 commits an entire parsed batch only after immutable journal, all object readbacks and hashes',async()=>{
 const j=await f.job(),app=f.orchestrator({transport:responseTransport({kinds:['invoice_summary','invoice','event_summary','event','unsupported']})});
 const result=await app.run(j);assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(result.receipt.documents,5);assert.equal(result.current.checkpoint,'000000000000005');
 for(const key of ['can_query','can_manifest','can_emit','operation_authorized','financial_mutation_performed','stock_mutation_performed'])assert.equal(result[key],false);
 assert.equal(f.calls.transport.length,1);assert.equal(f.calls.authorization.length,1);assert.equal(f.calls.put.length,7);assert.match(f.calls.put[0].key,/^responses\//);assert.ok(f.calls.put.every(x=>x.upsert===false&&x.ifNoneMatch==='*'));
 assert.equal(f.calls.read.length,8);assert.equal(f.calls.rpc.at(-1).name,'erp_dfe_finalize');
 const list=await f.documents(j);assert.equal(list.items.length,5);assert.equal(list.items.filter(x=>x.is_complete_invoice).length,1);assert.equal(list.items.find(x=>x.kind==='unsupported').quarantined,true);
 const counts={transport:f.calls.transport.length,put:f.calls.put.length,read:f.calls.read.length};const replay=await app.run(j);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,result.receipt);assert.deepEqual({transport:f.calls.transport.length,put:f.calls.put.length,read:f.calls.read.length},counts);
});

test('137 waits at least an hour;656 stores review evidence without adopting its cursor',async()=>{
 for(const status of ['137','656']){
  await f.reset();const j=await f.job(),started=Date.now(),result=await f.orchestrator({transport:responseTransport({status,last:status==='656'?'000000000000999':undefined,max:status==='656'?'000000000000999':undefined})}).run(j);
  assert.equal(result.status,status==='137'?'stored':'review',JSON.stringify(result));assert.equal(result.current.checkpoint,'000000000000000');assert.ok(Date.parse(result.current.not_before)>=started+3600000);assert.equal(result.receipt.documents,0);assert.equal(result.current.paused,status==='656');assert.equal(f.calls.transport.length,1);
 }
});

test('losing the dispatch ACK makes delivery uncertain and never sends, including retry of the same command',async()=>{
 const j=await f.job();let lost=false;
 const app=f.orchestrator({rpc:async(name,args,opts)=>{const result=await f.rpc(name,args,opts);if(name==='erp_dfe_dispatch'&&!lost){lost=true;throw syntheticError();}return result;}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal(first.failure_recorded,true);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_DETAIL/);assert.equal(f.calls.transport.length,0);assert.equal((await f.command(j)).state,'uncertain');
 const retry=await app.run(j);assert.equal(retry.code,'DFE_RESPONSE_JOURNAL_MISSING');assert.equal(f.calls.transport.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_dispatch').length,1);assert.equal((await f.settings()).current.checkpoint,'000000000000000');
});

test('transport failure after a consumed ticket keeps one active attempt and never repeats transport',async()=>{
 const j=await f.job(),app=f.orchestrator({transport:{exchange:async()=>{f.calls.transport.push({});throw syntheticError();}}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal(first.phase,'transport');assert.equal(first.failure_recorded,true);assert.equal(f.calls.transport.length,1);
 assert.equal((await app.run(j)).code,'DFE_RESPONSE_JOURNAL_MISSING');assert.equal(f.calls.transport.length,1);assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.active_attempt_id,j.commandId);
});

test('a lost immutable PUT ACK is recovered only by exact readback, without reissuing the query',async()=>{
 const j=await f.job();let failed=false;
 const app=f.orchestrator({storage:{...f.ports.storage,putImmutable:async(args)=>{const result=await f.ports.storage.putImmutable(args);if(!failed){failed=true;throw syntheticError();}return result;}}});
 const result=await app.run(j);assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(f.calls.transport.length,1);assert.equal(f.calls.put.length,3);assert.equal((await f.documents(j)).items.length,1);
});

test('an incomplete object set cannot finalize; a later run recovers solely from the same valid journal',async()=>{
 const j=await f.job();let missing=true;
 const app=f.orchestrator({transport:responseTransport({kinds:['invoice_summary','invoice']}),storage:{...f.ports.storage,putImmutable:async(args)=>{if(missing&&args.key.startsWith('objects/'))throw syntheticError();return f.ports.storage.putImmutable(args);}}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal(first.code,'DFE_STORAGE_OBJECT_MISSING');assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');
 const journalBefore=[...f.files.entries()].find(([key])=>key.startsWith('responses/'));assert.ok(journalBefore);const bytesHash=hash(journalBefore[1]);missing=false;await f.expire(j);
 const saved=await app.run(j);assert.equal(saved.status,'stored',JSON.stringify(saved));assert.equal(saved.recovered,true);assert.equal(f.calls.transport.length,1);assert.equal(f.calls.authorization.length,1);assert.equal(saved.current.checkpoint,'000000000000002');assert.equal(hash(f.files.get(journalBefore[0])),bytesHash);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_recover').length,1);
});

test('lost finalize ACK consults the command; even loss of that read never recreates the batch',async()=>{
 const j=await f.job();let lostFinalize=false,lostRead=false;
 const app=f.orchestrator({rpc:async(name,args,opts)=>{const result=await f.rpc(name,args,opts);if(name==='erp_dfe_finalize'&&!lostFinalize){lostFinalize=true;throw syntheticError();}if(name==='erp_dfe_command'&&!lostRead){lostRead=true;throw syntheticError();}return result;}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal((await f.command(j)).state,'stored');const writes=f.calls.put.length;
 const second=await app.run(j);assert.equal(second.status,'stored');assert.equal(second.replayed,true);assert.equal(f.calls.transport.length,1);assert.equal(f.calls.put.length,writes);assert.equal((await f.documents(j)).items.length,1);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,1);
 await f.reset();const k=await f.job();const recovered=await f.orchestrator({rpc:async(name,args)=>{const result=await f.rpc(name,args);if(name==='erp_dfe_finalize')throw syntheticError();return result;}}).run(k);assert.equal(recovered.status,'stored');assert.equal(recovered.recovered,true);assert.equal(f.calls.transport.length,1);
});

test('preexisting journals require the exact attempt/request namespace and validated response context',async()=>{
 const scenarios=['before_dispatch','other_request_path','other_attempt_path','wrong_environment','malformed_xml','oversize'];
 for(const scenario of scenarios){
  await f.reset();const j=await f.job(),r=await f.reserve(j);if(scenario!=='before_dispatch')await f.dispatch(j,r);
  const path=scenario==='other_request_path'?`responses/${j.commandId}/${'a'.repeat(64)}.xml`:scenario==='other_attempt_path'?`responses/00000000-0000-0000-0000-000000000001/${r.request_hash}.xml`:journal(j,r);
  const bytes=scenario==='wrong_environment'?responseBytes(r.request,{environment:'1'}):scenario==='malformed_xml'?Buffer.from('<not-an-xml-response>'):scenario==='oversize'?Buffer.alloc(8388609,65):responseBytes(r.request);
  await inject(path,bytes);const result=await f.orchestrator().run(j);
  assert.equal(result.status,scenario==='before_dispatch'?'blocked':'review_required',scenario);assert.equal(f.calls.transport.length,0,scenario);assert.equal(f.calls.put.length,0,scenario);assert.equal((await f.documents(j)).items.length,0,scenario);assert.equal((await f.settings()).current.checkpoint,'000000000000000',scenario);
 }
});

test('immutable object conflicts are detected, never overwritten or finalized',async()=>{
 const j=await f.job(),r=await f.reserve(j);const bytes=responseBytes(r.request),key=`objects/${hash(bytes)}.xml`;
 await inject(key,Buffer.from('CONFLICTING SYNTHETIC OBJECT'));const before=Buffer.from(f.files.get(key));const result=await f.orchestrator().run(j);
 assert.equal(result.status,'review_required');assert.equal(result.code,'DFE_STORAGE_HASH_CONFLICT');assert.deepEqual(f.files.get(key),before);assert.equal((await f.documents(j)).items.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);assert.equal(f.calls.transport.length,1);
});

test('existing trusted journal is reparsed with its actual request; cursor gaps cause review without advancement',async()=>{
 const j=await f.job(),r=await f.reserve(j);await f.dispatch(j,r);await inject(journal(j,r),responseBytes(r.request,{last:'000000000000009',max:'000000000000009',nsus:['000000000000009']}));
 const result=await f.orchestrator().run(j);assert.equal(result.status,'review',JSON.stringify(result));assert.deepEqual(result.receipt.issues,['NSU_GAP_OBSERVED']);assert.equal(result.current.checkpoint,'000000000000000');assert.equal(f.calls.transport.length,0);assert.equal(f.calls.authorization.length,0);
});

test('role and company identity changes before finalization reject the whole lot and preserve the cursor',async()=>{
 for(const change of ['role','identity']){
  await f.reset();const j=await f.job();let changed=false;
  const result=await f.orchestrator({storage:{...f.ports.storage,putImmutable:async args=>{const value=await f.ports.storage.putImmutable(args);if(!changed&&args.key.startsWith('objects/')){changed=true;if(change==='role')await f.db.query('update erp_access.membership set active=false where user_id=$1',[j.actor]);else await f.identity({trade_name:'OUTRA REVISAO FICTICIA'});}return value;}}}).run(j);
  assert.equal(result.status,'review_required');assert.equal(result.phase,'finalize');assert.equal(result.code,change==='role'?'DFE_RPC_42501':'DFE_RPC_40001');assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');assert.equal(f.calls.transport.length,1);
 }
});

test('a consumed dispatch ticket from another worker causes no transport or uncertain-state write',async()=>{
 const j=await f.job();const app=f.orchestrator({rpc:async(name,args)=>{if(name==='erp_dfe_dispatch')await f.rpc(name,args);return f.rpc(name,args);}});
 const result=await app.run(j);assert.equal(result.code,'DFE_DISPATCH_ALREADY_CONSUMED');assert.equal(result.failure_recorded,false);assert.equal(f.calls.transport.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_uncertain').length,0);assert.equal((await f.command(j)).state,'dispatched');
});

test('timeouts bound hanging ports; a delayed authorization callback cannot dispatch after run returns',async()=>{
 const j=await f.job();let retained;
 const app=f.orchestrator({withAuthorizedCredential:async(_context,callback)=>{retained=callback;return pending();}});
 const started=Date.now(),result=await app.run(j,{deadline:Date.now()+100});assert.equal(result.status,'blocked');assert.equal(result.code,'DFE_JOB_TIMEOUT');assert.ok(Date.now()-started<1000);
 await assert.rejects(()=>retained({secureContext:{synthetic:true}}),{code:'DFE_AUTHORIZATION_CALLBACK_INVALID'});assert.equal(f.calls.transport.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_dispatch').length,0);
});

test('same-instance concurrent jobs cannot obtain a second ticket while the first authority gate is pending',async()=>{
 const j=await f.job();let ready;const gate=new Promise(resolve=>{ready=resolve;});let release;
 const app=f.orchestrator({withAuthorizedCredential:async(_context,callback)=>{ready();return new Promise(resolve=>{release=()=>resolve(callback({secureContext:{synthetic:true}}));});}});
 const first=app.run(j);await gate;await assert.rejects(()=>app.run(j),{code:'DFE_JOB_ALREADY_RUNNING'});release();assert.equal((await first).status,'stored');assert.equal(f.calls.transport.length,1);
});

test('invalid XML is journaled before parsing and subsequent recovery never queries again or rewrites the evidence',async()=>{
 const j=await f.job(),bad=Buffer.from('<invalid original="synthetic">');
 const app=f.orchestrator({transport:{exchange:async(plan)=>{f.calls.transport.push({plan});return{bytes:bad,request_hash:plan.request_hash,wire_hash:plan.wire_hash,response_hash:hash(bad)};}}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal(first.phase,'parse');assert.equal(f.calls.put.length,1);assert.deepEqual([...f.files.values()][0],bad);assert.equal(f.calls.put[0].key.startsWith(`responses/${j.commandId}/`),true);
 const retry=await app.run(j);assert.equal(retry.status,'review_required');assert.equal(retry.phase,'parse');assert.equal(f.calls.put.length,1);assert.equal(f.calls.transport.length,1);assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');
});

test('loss of journal readback after a committed write recovers from those bytes without another transport call',async()=>{
 const j=await f.job();let fail=true;
 const app=f.orchestrator({storage:{...f.ports.storage,read:async args=>{if(fail&&args.key.startsWith('responses/')&&f.files.has(args.key)){fail=false;throw syntheticError();}return f.ports.storage.read(args);}}});
 const first=await app.run(j);assert.equal(first.status,'review_required');assert.equal(first.phase,'journal');assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);
 const retry=await app.run(j);assert.equal(retry.status,'stored');assert.equal(f.calls.transport.length,1);assert.equal(f.calls.put.filter(x=>x.key.startsWith('responses/')).length,1);
});

test('a conflicting journal installed after dispatch is neither replaced nor treated as the received response',async()=>{
 const j=await f.job();let installed=false;
 const app=f.orchestrator({storage:{...f.ports.storage,putImmutable:async args=>{if(!installed&&args.key.startsWith('responses/')){installed=true;await inject(args.key,Buffer.from('IMMUTABLE CONFLICT'));}return f.ports.storage.putImmutable(args);}}});
 const result=await app.run(j);assert.equal(result.code,'DFE_STORAGE_HASH_CONFLICT');assert.equal(result.phase,'journal');assert.equal([...f.files.values()][0].toString(),'IMMUTABLE CONFLICT');assert.equal(f.calls.transport.length,1);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);assert.equal((await f.documents(j)).items.length,0);
});

test('RPC request context tampering is rejected before journal access or authorization',async()=>{
 const j=await f.job();
 for(const mutate of [r=>({...r,request_hash:'a'.repeat(64)}),r=>({...r,request:{...r.request,lastNsu:'000000000000099'}}),r=>({...r,current:{...r.current,environment:'1'}}),r=>({...r,attempt_id:'00000000-0000-0000-0000-000000000001'})]){
  const result=await f.orchestrator({rpc:async(name,args)=>{const r=await f.rpc(name,args);return name==='erp_dfe_reserve'?mutate(r):r;}}).run(j);
  assert.equal(result.status,'blocked');assert.equal(f.calls.read.length,0);assert.equal(f.calls.authorization.length,0);assert.equal(f.calls.transport.length,0);
 }
});

test('an expired lease fences finalization; recovery uses a new lease and the durable original response',async()=>{
 const j=await f.job();let expired=false;
 const app=f.orchestrator({rpc:async(name,args)=>{if(name==='erp_dfe_finalize'&&!expired){expired=true;await f.expire(j);}return f.rpc(name,args);}});
 const first=await app.run(j);assert.equal(first.code,'DFE_RPC_40001');assert.equal(first.phase,'finalize');assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');
 const next=await app.run(j);assert.equal(next.status,'stored');assert.equal(f.calls.transport.length,1);const attempts=f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize');assert.equal(attempts.length,2);assert.notEqual(attempts[0].args.p_lease_id,attempts[1].args.p_lease_id);
});

test('fifty distinct documents and fifteen-digit NSUs fit the bounded operation budget without precision loss',async()=>{
 const j=await f.job({p_checkpoint:'999999999999900'}),result=await f.orchestrator({transport:responseTransport({kinds:Array(50).fill('invoice_summary'),distinct:true,max:'999999999999999'})}).run(j);
 assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(result.current.checkpoint,'999999999999950');assert.equal(result.receipt.documents,50);assert.equal(f.calls.put.length,52);assert.equal(result.storage_operations,105);assert.equal(f.calls.transport.length,1);
 const list=await f.rpc('erp_dfe_documents',{p_user_id:f.users.consulta,p_channel_id:j.channelId,p_limit:50});assert.equal(list.items.length,50);assert.equal(new Set(list.items.map(x=>x.xml_hash)).size,50);
});

test('aborting a hanging authorization or transport returns promptly and closes delayed callbacks',async()=>{
 for(const phase of ['authorization','transport']){
  await f.reset();const j=await f.job(),controller=new AbortController();let ready,resolvePending,retained;
  const waiting=new Promise(resolve=>{ready=resolve;});const overrides=phase==='authorization'?{withAuthorizedCredential:async(_c,callback)=>{retained=callback;ready();return new Promise(resolve=>{resolvePending=resolve;});}}:{transport:{exchange:async(plan,options)=>{f.calls.transport.push({plan,options});ready();return new Promise(resolve=>{resolvePending=()=>{const bytes=responseBytes(plan.request);resolve({bytes,request_hash:plan.request_hash,wire_hash:plan.wire_hash,response_hash:hash(bytes)});};});}}};
  const execution=f.orchestrator(overrides).run(j,{signal:controller.signal});await waiting;const started=Date.now();controller.abort();const result=await execution;assert.ok(Date.now()-started<500);assert.equal(result.code,'DFE_JOB_ABORTED');assert.equal(result.phase,phase);
  if(retained)await assert.rejects(()=>retained({secureContext:{synthetic:true}}),{code:'DFE_AUTHORIZATION_CALLBACK_INVALID'});
  resolvePending();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.put.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);
  if(phase==='transport'){assert.equal(f.calls.transport[0].options.signal.aborted,true);assert.equal((await f.command(j)).state,'dispatched');const retry=await f.orchestrator().run(j);assert.equal(retry.code,'DFE_RESPONSE_JOURNAL_MISSING');assert.equal(f.calls.transport.length,1);}
 }
});

test('hanging transport receives an aborted deadline and recovery cannot issue another request',async()=>{
 const j=await f.job(),app=f.orchestrator({transport:{exchange:async(plan,options)=>{f.calls.transport.push({plan,options});return pending();}}});
 const result=await app.run(j,{deadline:Date.now()+120});assert.equal(result.status,'review_required');assert.equal(result.code,'DFE_JOB_TIMEOUT');assert.equal(result.failure_recorded,true);assert.equal(f.calls.transport[0].options.signal.aborted,true);assert.equal((await f.command(j)).state,'uncertain');
 assert.equal((await app.run(j)).code,'DFE_RESPONSE_JOURNAL_MISSING');assert.equal(f.calls.transport.length,1);
});

test('same-CNPJ identity revision preserves an old terminal receipt and returns distinct current configuration',async()=>{
 const j=await f.job(),app=f.orchestrator(),saved=await app.run(j);await f.identity({trade_name:'VERSAO FICTICIA POSTERIOR'});const replay=await app.run(j);
 assert.equal(replay.status,'stored');assert.deepEqual(replay.receipt,saved.receipt);assert.equal(replay.current.company_changed,true);assert.equal(f.calls.transport.length,1);
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[j.actor]);const denied=await app.run(j);assert.equal(denied.status,'blocked');assert.equal(denied.code,'DFE_RPC_42501');assert.equal('receipt' in denied,false);
});

test('an authority port returning before its callback finishes cannot detach a background batch',async()=>{
 const j=await f.job();let callbackTask,resolveDispatch;
 const app=f.orchestrator({rpc:async(name,args)=>{if(name==='erp_dfe_dispatch')return new Promise(resolve=>{resolveDispatch=()=>f.rpc(name,args).then(resolve);});return f.rpc(name,args);},withAuthorizedCredential:async(_context,callback)=>{callbackTask=callback({secureContext:{synthetic:true}});await new Promise(resolve=>setImmediate(resolve));}});
 const result=await app.run(j);assert.equal(result.status,'review_required');assert.equal(result.code,'DFE_AUTHORIZATION_NOT_COMPLETED');resolveDispatch?.();await assert.rejects(()=>callbackTask,{code:'DFE_JOB_ABORTED'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.transport.length,0);assert.equal(f.calls.put.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);
 const retry=await f.orchestrator().run(j);assert.equal(retry.code,'DFE_RESPONSE_JOURNAL_MISSING');assert.equal(f.calls.transport.length,0);
});

test('two orchestrator instances racing the same persistent ticket perform exactly one transport call',async()=>{
 const j=await f.job();let count=0,release;
 const bothDispatched=new Promise(resolve=>{release=resolve;});
 const rpc=async(name,args)=>{const result=await f.rpc(name,args);if(name==='erp_dfe_dispatch'){if(++count===2)release();await bothDispatched;}return result;};
 // The barrier also avoids overlapping SET ROLE and direct Storage metadata
 // writes on PGlite's single fixture session; it is not a production lock.
 const [one,two]=await Promise.all([f.orchestrator({rpc}).run(j),f.orchestrator({rpc}).run(j)]);
 assert.equal([one,two].filter(x=>x.status==='stored').length,1);assert.equal([one,two].filter(x=>x.code==='DFE_DISPATCH_ALREADY_CONSUMED').length,1);assert.equal(f.calls.transport.length,1);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_uncertain').length,0);assert.equal((await f.documents(j)).items.length,1);
});

test('timeout covers the journal readback stream and cancels it; a later run reuses its stored bytes',async()=>{
 const j=await f.job();let stall=true,cancelled=false;
 const app=f.orchestrator({storage:{...f.ports.storage,read:async args=>{if(stall&&args.key.startsWith('responses/')&&f.files.has(args.key)){stall=false;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/octet-stream'}});}return f.ports.storage.read(args);}}});
 const first=await app.run(j,{deadline:Date.now()+120});assert.equal(first.status,'review_required');assert.equal(first.code,'DFE_JOB_TIMEOUT');assert.equal(first.phase,'journal');assert.equal(cancelled,true);assert.equal((await f.documents(j)).items.length,0);
 const recovered=await app.run(j);assert.equal(recovered.status,'stored');assert.equal(f.calls.transport.length,1);assert.equal(f.calls.put.filter(x=>x.key.startsWith('responses/')).length,1);
});
