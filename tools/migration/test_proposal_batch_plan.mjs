import test from 'node:test';
import assert from 'node:assert/strict';
import {auditProposalBatch,prepareProposalBatch,proposalBatchDigest} from './plan_proposal_batch.mjs';
import {createProposalBatchPort,RESPONSE_BYTES} from './proposal_batch_port.mjs';
import {proposalBatchFixture,jsonResponse,projectUrl,f} from './proposal_batch_test_fixture.mjs';

test('audit reads all 27 sources in pages of 25 and keeps an existing edited document; selection is explicit',async()=>{
 const x=proposalBatchFixture(27),audit=await auditProposalBatch({port:x.port});assert.deepEqual(audit.summary,{sources:27,already_linked:0,reviewed:27,eligible:27,blocked:0,native_documents:1});
 assert.equal(audit.coherent_snapshot,false);assert.equal(audit.coverage_certified,false);assert.ok(x.calls.every(c=>!c.name.includes('apply')));assert.ok(x.calls.filter(c=>'p_limit'in c.args).every(c=>c.args.p_limit===25));
 const plan=await prepareProposalBatch({audit,selectedSourceIds:[x.ids[1]],duplicateReviewed:true});assert.equal(plan.items.length,1);assert.equal(plan.items[0].source_id,x.ids[1]);assert.equal(plan.native_baseline[0].version,3);assert.equal(plan.native_baseline[0].status,'approved');assert.match(proposalBatchDigest(plan),/^[a-f0-9]{64}$/);
 await assert.rejects(prepareProposalBatch({audit,selectedSourceIds:[x.ids[0]],duplicateReviewed:false}),/SELECTION_NOT_REVIEWED/);
});
test('page cap, repeated cursor, source mutation during audit, blocked and duplicate selections fail closed',async()=>{
 const x=proposalBatchFixture(26);await assert.rejects(auditProposalBatch({port:x.port,maxPages:1}),/SOURCE_PAGE_LIMIT/);
 x.setHook(({url,name,args})=>name.includes('sources')&&args.p_after?jsonResponse(url,f.page(x.ids.map(f.row))):null);await assert.rejects(auditProposalBatch({port:x.port}));
 const y=proposalBatchFixture(1);y.previews.get(y.ids[0]).source_version='2';await assert.rejects(auditProposalBatch({port:y.port}),/AUDIT_SOURCE_CHANGED/);
 const z=proposalBatchFixture(1);z.previews.set(z.ids[0],f.blocked(f.preview(z.ids[0]),[{code:'PRODUCT_MAPPING_UNAVAILABLE',field:'produto.id',position:1}]));const audit=await auditProposalBatch({port:z.port});assert.equal(audit.summary.blocked,1);
 await assert.rejects(prepareProposalBatch({audit,selectedSourceIds:z.ids,duplicateReviewed:true}),/SOURCE_NOT_ELIGIBLE/);
 await assert.rejects(prepareProposalBatch({audit,selectedSourceIds:[...z.ids,...z.ids],duplicateReviewed:true}),/SELECTION_NOT_REVIEWED/);
});
test('native inventory rejects cursor/order truncation and selected audit cannot forge projected arithmetic',async()=>{
 const x=proposalBatchFixture(1);x.setHook(({url,name})=>name==='erp_document_list'?jsonResponse(url,{data_mode:'erp_native',operational_effects:false,kind:'sales_proposals',items:[],limit:25,page:null,order:'id',has_more:true,next_cursor:x.baseline.id,total_count:0,total_amount:'0.00'}):null);
 await assert.rejects(auditProposalBatch({port:x.port}),/NATIVE_CURSOR_INVALID/);x.setHook(null);const audit=await auditProposalBatch({port:x.port});audit.previews[0].proposed.totals.total='0.00';
 await assert.rejects(prepareProposalBatch({audit,selectedSourceIds:x.ids,duplicateReviewed:true}));
});
const transport=(fetchImpl,extra={})=>createProposalBatchPort({projectUrl,actor:f.actor,serviceKey:'synthetic-key-do-not-use',fetchImpl,...extra});
test('port has fixed actor, closed operations and default readonly; it refuses redirect, URL, content type and provider text',async()=>{
 const seen=[];const port=transport(async(url,init)=>{seen.push(JSON.parse(init.body));assert.equal(init.headers['accept-encoding'],'identity');assert.equal(init.headers.accept,'application/json');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');return jsonResponse(url,f.preview());});await port.call('preview',{source_id:'9520000001'});assert.equal(seen[0].p_user_id,f.actor);
 await assert.rejects(port.call('apply',{}),/APPLY_NOT_ENABLED/);await assert.rejects(port.call('preview',{source_id:'9520000001',p_user_id:f.actor}));assert.equal(seen.length,1);
 for(const response of [()=>new Response('',{status:302,headers:{location:'https://evil.invalid'}}),url=>jsonResponse(url+'?bad',{}),url=>{const r=jsonResponse(url,{});r.headers.set('content-type','text/plain');return r;},url=>jsonResponse(url,{code:'unexpected',message:'private-provider-text'},500)]){
  await assert.rejects(transport(async url=>response(url)).call('preview',{source_id:'9520000001'}),e=>!e.message.includes('private-provider-text'));
 }
 await assert.rejects(transport(async url=>jsonResponse(url,{code:'P0002'},404)).call('command',{command_id:f.actor}),e=>e.status===404&&e.code==='COMMAND_NOT_FOUND');
});
test('stream bound, fatal UTF8, length mismatch and body timeout cancel without returning partial JSON',async()=>{
 for(const [bytes,headers]of [[new Uint8Array(RESPONSE_BYTES+1),{}],[new Uint8Array([0xc0,0xaf]),{}],[new TextEncoder().encode('{}'),{'content-length':'3'}]]){
  let cancelled=false;const p=transport(async url=>{const r=new Response(new ReadableStream({start(c){c.enqueue(bytes);},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json',...headers}});Object.defineProperty(r,'url',{value:url});return r;},{timeoutMs:40});
  await assert.rejects(p.call('preview',{source_id:'9520000001'}));assert.equal(cancelled,true);
 }
 let cancelled=false;const p=transport(async url=>{const r=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;},{timeoutMs:20});
 await assert.rejects(p.call('preview',{source_id:'9520000001'}),/RPC_UNCONFIRMED/);assert.equal(cancelled,true);
});
test('abort cancels a late response and stops the audit before another operation',async()=>{
 const abort=new AbortController();let release,cancelled=false,calls=0;const port=transport(url=>{calls++;return new Promise(r=>{release=()=>{const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});r(response);};});});
 const pending=auditProposalBatch({port,signal:abort.signal});await new Promise(r=>setImmediate(r));abort.abort();await assert.rejects(pending);release();await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(cancelled,true);
});
