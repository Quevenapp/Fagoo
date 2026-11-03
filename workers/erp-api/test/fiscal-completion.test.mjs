import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseFiscalCompletionRoute as parseRoute,executeFiscalCompletionRoute as execute,fiscalCompletionRoute,fiscalCompletionMethods,FISCAL_COMPLETION_RESPONSE_BYTES} from '../src/fiscal-completion.mjs';
import {COMPLETION_FLAGS,resolveBusinessCompletion} from '../../../packages/fiscal-core/src/business-completion.mjs';
import {businessFixture,businessIds} from '../../../packages/fiscal-core/test/business-fixtures.mjs';

const base='https://api.example.test/v1/complemento-fiscal',did=businessIds.draft,actor='f0000000-0000-4000-8000-000000000001',cmd='f0000000-0000-4000-8000-000000000002';
const parse=(tail='',value,options={})=>parseRoute(new Request(base+'/'+did+tail,{...(value===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),...options}));
const rejection=(promise,status,code)=>assert.rejects(promise,e=>e.status===status&&(!code||e.code===code)&&!String(e.message).includes('PRIVATE'));
const copy=v=>structuredClone(v);
function fixture(options={}){
 const f=businessFixture(options),{identity,...completion}=f.completion;
 const item_basis=f.taxPreparation.record.items.map(i=>({item_id:i.item_id,position:i.position,cest:i.identifiers.cest,csosn:i.decisions.icms.csosn}));
 const result=resolveBusinessCompletion(completion,{model:f.draft.record.model,items:item_basis});
 const record={draft_id:did,version:1,draft_version:1,snapshot_hash:'a'.repeat(64),item_preparation_version:1,tax_preparation_version:1,item_preparation_hash:'b'.repeat(64),tax_preparation_hash:'c'.repeat(64),model:f.draft.record.model,environment:'2',company_identity_version:1,company_fiscal_version:1,source_document_id:businessIds.order,source_document_version:1,created_at:'2026-10-16T12:00:00.123456Z',item_basis,...result};
 const current={completion_version:1,draft_version:1,draft_status:'draft',source_document_version:1,source_status:'open',source_changed:false,company_changed:false,identity_version:1,fiscal_version:1,item_preparation_version:1,tax_preparation_version:1,matches_current_draft:true,matches_current_item_preparation:true,matches_current_tax_preparation:true,matches_current_company:true};
 return{completion,record,current,body:{expected_draft_version:1,snapshot_hash:'a'.repeat(64),item_preparation_version:1,tax_preparation_version:1,expected_identity_version:1,expected_fiscal_version:1,expected_completion_version:0,completion},envelope:{...COMPLETION_FLAGS,record,current}};
}
const saved=f=>({...copy(f.envelope),replayed:false});
const previewed=f=>({...copy(f.envelope),record:{...copy(f.record),created_at:null},current:{...f.current,completion_version:0},persisted:false,expected_completion_version:0});
const run=async(tail,value,raw,options={})=>execute(await parse(tail,value),{userId:actor,rpc:async()=>raw,...options});
const meta=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!['item_basis','completion','pending'].includes(k)));

test('047 route and query allowlists expose only get/history/preview/save with canonical draft binding',async()=>{
 assert.equal(await parseRoute(new Request('https://api.example.test/other')),null);assert.equal(fiscalCompletionRoute('/v1/complemento-fiscal/'+did.toUpperCase()).id,did);
 assert.deepEqual(fiscalCompletionMethods('/v1/complemento-fiscal/'+did+'/preview'),['POST']);assert.equal(fiscalCompletionMethods('/v1/complemento-fiscal/'+did+'/emit'),null);
 assert.deepEqual((await parse('?version=2147483647')).args,{p_draft_id:did,p_version:2147483647});assert.deepEqual((await parse('/history?limit=2&before=5')).args,{p_draft_id:did,p_limit:2,p_before:5});
 for(const tail of ['?version=0','?version=01','?version=1.0','?version=2147483648','?version=1&version=2','?model=55','/history?limit=26','/history?limit=0','/history?before=0','/history?version=1'])await rejection(()=>parse(tail),400);
 for(const tail of ['/emit','/number','/xml','/save/','/PREVIEW'])await rejection(()=>parse(tail),404);
 for(const method of ['PUT','PATCH','DELETE','POST'])await rejection(()=>parse('',undefined,{method}),405);
 await rejection(()=>parse('/save'),405);await rejection(()=>parse('/save?actor='+actor,{...fixture().body,command_id:cmd}),400);
});

test('047 mutation bodies require exact versions and explicit shape without actor, numbering or identity injection',async()=>{
 const f=fixture(),value={...f.body,command_id:cmd},route=await parse('/save',value);
 assert.equal(route.rpc,'erp_fiscal_completion_save');assert.deepEqual(route.args,{p_draft_id:did,...Object.fromEntries(Object.entries(value).map(([k,v])=>['p_'+k,v]))});
 assert.ok(Object.isFrozen(route.args.p_completion.items));assert.ok(Object.isFrozen(route.args.p_completion.items[0].tributary));
 for(const patch of[{expected_draft_version:0},{expected_identity_version:null},{expected_fiscal_version:'1'},{item_preparation_version:0},{tax_preparation_version:-1},{expected_completion_version:2147483647},{snapshot_hash:'A'.repeat(64)},{command_id:cmd.toUpperCase()},{p_user_id:actor},{identity:{number:'1'}}])await rejection(()=>parse('/save',{...value,...patch}),400);
 const malicious=copy(value);malicious.completion.identity={number:'1',cnpj:'PRIVATE'};await rejection(()=>parse('/save',malicious),400);
 await rejection(()=>parse('/preview',value),400);await rejection(()=>parse('/save',f.body),400);
});

test('047 input boundary preserves null and exact decimals while rejecting unsupported shapes, duplicates and precision',async()=>{
 const f=fixture({count:2}),bad=[];const change=fn=>{const v=copy(f.body);fn(v.completion);bad.push(v);};
 for(const v of[1,'01.00','1.0','10000000000000.00'])change(c=>c.totals.vNF=v);
 for(const v of[0,'0','0.000000','1.0000000','100000000000.0'])change(c=>c.items[0].tributary.quantity=v);
 change(c=>c.items[0].tributary.unit_price='1.12345678901');change(c=>c.items[0].tributary.unit='UNIDADE');change(c=>c.operation.tpNF='0');change(c=>c.recipient.municipality_code='3304557');change(c=>c.payments.items[0].type='03');
 change(c=>c.items[1].item_id=c.items[0].item_id);change(c=>c.items[0].icms={credit:{base:null,amount:null},groups500:{retention:null,fcp:null,effective:null}});
 change(c=>c.excluded_groups.ibs_cbs='exempt');change(c=>c.additional_information='a\nb');change(c=>c.additional_information='😀');change(c=>c.items=[]);change(c=>c.items[0].tributary.extra='secret');
 for(const value of bad)await rejection(()=>parse('/preview',value),400);
 const allowed=copy(f.body);allowed.completion.items[0].tributary.quantity='99999999999.123456';allowed.completion.items[0].tributary.unit_price='99999999999.1234567890';allowed.completion.totals.vNF='9999999999999.99';allowed.completion.totals.vBC=null;
 const r=await parse('/preview',allowed);assert.equal(r.args.p_completion.items[0].tributary.quantity,'99999999999.123456');assert.equal(r.args.p_completion.totals.vBC,null);
 // A valid input union is not proof of model/branch membership; SQL resolves those under locks.
 const shape=copy(f.body);shape.completion.items[0].icms.credit={base:null,amount:null};assert.equal((await parse('/preview',shape)).args.p_completion.items[0].icms.credit.amount,null);
});

test('047 body streaming bounds UTF-8, length, encoding, media type and cancellation',async()=>{
 for(const [headers,text,status]of [[{'Content-Encoding':'gzip'},'{}',400],[{'Content-Type':'text/plain'},'{}',400],[{'Content-Type':'application/json; charset=latin1'},'{}',400],[{'Content-Length':'524289'},'{}',413],[{'Content-Length':'1'},'{}',400],[{},' '.repeat(524289),413],[{},'{invalid',400]]){
  await rejection(()=>parseRoute(new Request(base+'/'+did+'/save',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:text})),status);
 }
 await rejection(()=>parseRoute(new Request(base+'/'+did+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:Uint8Array.of(0xff)})),400);
 let cancelled=false;const control=new AbortController(),request=new Request(base+'/'+did+'/save',{method:'POST',headers:{'Content-Type':'application/json'},signal:control.signal,body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'}),promise=parseRoute(request);control.abort();await rejection(()=>promise,400,'ERP_REQUEST_ABORTED');assert.equal(cancelled,true);
});

test('047 actor injection, frozen routes and allowlisted projection prevent arbitrary RPC or internal field exposure',async()=>{
 const f=fixture(),route=await parse('/save',{...f.body,command_id:cmd}),raw=saved(f);raw.private_token='PRIVATE';raw.record.private_payload='PRIVATE';raw.current.actor='PRIVATE';let count=0;
 const result=await execute(route,{userId:actor.toUpperCase(),rpc:async(name,args,{signal})=>{count++;assert.equal(name,'erp_fiscal_completion_save');assert.equal(args.p_user_id,actor);assert.ok(signal instanceof AbortSignal);return raw;}});
 assert.equal(count,1);assert.equal(result.type,'json');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private_|actor/);assert.equal(result.body.record.completion.totals.vNF,'12.50');
 await rejection(()=>execute({...route},{userId:actor,rpc:async()=>{throw Error('MUST_NOT_CALL');}}),404);await rejection(()=>execute(route,{userId:'invalid',rpc:async()=>{throw Error('MUST_NOT_CALL');}}),401);
});

test('047 SQL/current DTOs retain historical receipts, recompute pending and bind the requested revisions',async()=>{
 for(const model of['55','65'])for(const csosn of(model==='65'?['102','500']:['101','102','500'])){
  const f=fixture({model,csosn});assert.equal((await run('/preview',f.body,previewed(f))).body.record.model,model);
  const old=saved(f);old.replayed=true;Object.assign(old.current,{completion_version:3,draft_version:2,draft_status:'archived',source_document_version:2,source_status:'fulfilled',source_changed:false,company_changed:true,identity_version:2,tax_preparation_version:2,matches_current_draft:false,matches_current_tax_preparation:false,matches_current_company:false});
  const r=(await run('/save',{...f.body,command_id:cmd},old)).body;assert.deepEqual(r.record,f.record);assert.equal(r.current.completion_version,3);assert.equal(r.replayed,true);
  assert.equal((await run('?version=1',undefined,old)).body.record.version,1);await rejection(()=>run('',undefined,old),502);
 }
 const f=fixture(),empty={...COMPLETION_FLAGS,record:null,current:{...f.current,completion_version:0,item_preparation_version:0,tax_preparation_version:0,identity_version:null,matches_current_draft:false,matches_current_item_preparation:false,matches_current_tax_preparation:false,matches_current_company:false}};
 assert.equal((await run('',undefined,empty)).body.record,null);await rejection(()=>run('?version=1',undefined,empty),502);await rejection(()=>run('/save',{...f.body,command_id:cmd},empty),502);
});

test('047 rejects altered amounts, pending codes, item basis, optimistic current flags and cross-draft receipts',async()=>{
 const f=fixture({count:2});
 for(const mutate of[v=>v.can_emit=true,v=>v.arithmetic_verified=true,v=>v.record.draft_id=randomUUID(),v=>v.record.version=2,v=>v.record.snapshot_hash='d'.repeat(64),v=>v.record.company_fiscal_version=2,v=>v.record.completion.totals.vNF='99.99',v=>v.record.item_basis.reverse(),v=>v.record.item_basis[0].actor='PRIVATE',v=>v.record.item_basis[0].csosn='900',v=>v.record.pending.general=[],v=>v.record.pending.items[0].codes.push('SOMETHING'),v=>v.record.environment='1',v=>v.record.created_at='2026-02-30T12:00:00Z',v=>v.current.matches_current_company=false,v=>v.current.source_changed=true,v=>v.current.source_document_version=0,v=>v.current.tax_preparation_version=0]){
  const raw=saved(f);mutate(raw);await rejection(()=>run('/save',{...f.body,command_id:cmd},raw),502);
 }
 for(const mutate of[v=>v.persisted=true,v=>v.expected_completion_version=1,v=>v.current.completion_version=1,v=>v.current.source_status='cancelled',v=>v.record.created_at=f.record.created_at]){const raw=previewed(f);mutate(raw);await rejection(()=>run('/preview',f.body,raw),502);}
 const wrong=fixture({model:'65'});wrong.record.completion.operation.indFinal='0';await rejection(()=>run('',undefined,wrong.envelope),502);
});

test('047 metadata-only history validates descending cursor and strips all large or unrelated records',async()=>{
 const f=fixture(),items=[3,2].map(version=>({...meta(f.record),version,completion:{secret:'PRIVATE'},actor:'PRIVATE'})),value={...COMPLETION_FLAGS,draft_id:did,items,limit:2,has_more:true,next_cursor:2};
 const r=(await run('/history?limit=2&before=4',undefined,value)).body;assert.deepEqual(r.items.map(i=>i.version),[3,2]);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|completion":|actor/);
 for(const mutate of[v=>v.items.reverse(),v=>v.items[1].version=3,v=>v.items[1].model='65',v=>v.items[1].source_document_id=randomUUID(),v=>v.items[0].draft_id=randomUUID(),v=>v.next_cursor=3,v=>v.items.pop(),v=>v.has_more='true',v=>v.items[0].created_at='2026-09-31T01:00:00Z']){const raw=copy(value);mutate(raw);await rejection(()=>run('/history?limit=2&before=4',undefined,raw),502);}
 assert.deepEqual((await run('/history',undefined,{...COMPLETION_FLAGS,draft_id:did,items:[],limit:25,has_more:false,next_cursor:null})).body.items,[]);
});

test('047 errors are sanitized and a timed-out or cancelled mutation is never automatically repeated',async()=>{
 const f=fixture(),route=await parse('/save',{...f.body,command_id:cmd});
 for(const [error,status]of [[{code:'22023'},400],[{code:'42501'},403],[{code:'P0002'},404],[{code:'40001'},409],[{code:'23505'},409],[{code:'55000'},503],[{status:400},400],[{status:401},401],[{status:503},503],[{status:504},504],[{status:500},502]])await rejection(()=>execute(route,{userId:actor,rpc:async()=>{throw{...error,message:'PRIVATE_SQL_DETAIL'};}}),status);
 let count=0,upstream;await rejection(()=>execute(route,{userId:actor,timeoutMs:10,rpc:async(_n,_a,{signal})=>{count++;upstream=signal;await new Promise(()=>{});}}),504);assert.equal(count,1);assert.equal(upstream.aborted,true);
 const control=new AbortController();let started;const ready=new Promise(resolve=>{started=resolve;});const pending=execute(route,{userId:actor,signal:control.signal,rpc:async()=>{count++;started();await new Promise(()=>{});}});await ready;control.abort();await rejection(()=>pending,503,'ERP_RESULT_UNCONFIRMED');assert.equal(count,2);
 const preaborted=new AbortController();preaborted.abort();await rejection(()=>execute(route,{userId:actor,signal:preaborted.signal,rpc:async()=>{throw Error('MUST_NOT_CALL');}}),400);
});

test('047 maximum 250-item payload preserves six-place quantities and 15-digit money strings below bounds',async()=>{
 const f=fixture({count:250,csosn:'500'});f.completion.additional_information='é'.repeat(2000);f.completion.totals.vNF='9999999999999.99';f.completion.payments.items=Array.from({length:100},()=>({type:null,timing:null,amount:'9999999999999.99'}));
 for(const i of f.completion.items){i.tributary.quantity='99999999999.123456';i.tributary.unit_price='99999999999.1234567890';}
 Object.assign(f.record,resolveBusinessCompletion(f.completion,{model:f.record.model,items:f.record.item_basis}));
 const r=(await run('/save',{...f.body,command_id:cmd},saved(f))).body;assert.equal(r.record.completion.items.length,250);assert.equal(r.record.completion.totals.vNF,'9999999999999.99');assert.ok(r.record.pending.items.every(i=>i.codes.includes('QUANTITY_PRECISION_REVIEW')));
 assert.ok(Buffer.byteLength(JSON.stringify({...f.body,command_id:cmd}))<=524288);assert.ok(Buffer.byteLength(JSON.stringify(r))<FISCAL_COMPLETION_RESPONSE_BYTES);
 const tooMany=copy(f.body);tooMany.completion.items.push({...copy(tooMany.completion.items[0]),item_id:randomUUID()});await rejection(()=>parse('/preview',tooMany),400);
});
