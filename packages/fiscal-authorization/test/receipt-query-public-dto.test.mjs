import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureReceiptQueryContextInput,captureReceiptQueryHistoryInput,captureReceiptQueryRunInput,captureReceiptQueryRecoverInput,projectReceiptQueryPublic,ReceiptQueryPublicError,MAX_RECEIPT_QUERY_PUBLIC_BYTES} from '../src/receipt-query-public-dto.mjs';
import {uuid,digest,publicSource,publicSelection,publicResult,publicContext,publicHistory,contextBinding,commandBinding} from './receipt-query-public-fixture.mjs';
const fails=(fn,code='RECEIPT_QUERY_RESPONSE_INVALID')=>assert.throws(fn,e=>e instanceof ReceiptQueryPublicError&&e.code===code&&e.message===code);
const mutate=(raw,fn)=>{const x=structuredClone(raw);fn(x);return x;};

test('069/079 ×55/65 preserve literal original103 or SOAP_INVALID and selected079 separately',()=>{
 for(const kind of ['authorization','revalidation'])for(const model of ['55','65']){
  const raw=publicContext({source:publicSource({kind,model})}),out=projectReceiptQueryPublic(raw,contextBinding(raw));
  assert.equal(out.source.model,model);assert.equal(out.source.original.cstat,kind==='authorization'?'103':null);assert.equal(out.source.revalidation?.cstat??null,kind==='revalidation'?'103':null);assert.ok(Object.isFrozen(out.source.original));
  raw.source.original.response_hash=digest(77);assert.notEqual(raw.source.original.response_hash,out.source.original.response_hash);
  fails(()=>projectReceiptQueryPublic(mutate(raw,x=>x.source.original.state='authorized_homologation'),contextBinding(raw)));
 }
});
test('inputs capture exact CAS, UUIDs, versions and integer cursors without proof or transport fields',()=>{
 const input={...publicSelection(),command_id:uuid(11),confirmed:true},out=captureReceiptQueryRunInput(input);input.expected_a1_version=4;assert.equal(out.expected_a1_version,2);assert.ok(Object.isFrozen(out));
 assert.equal(captureReceiptQueryContextInput({source_kind:'revalidation',source_command_id:uuid(2),expected_attempt_id:uuid(3)}).source_kind,'revalidation');
 assert.deepEqual(captureReceiptQueryRecoverInput({confirmed:true}),{confirmed:true});
 assert.equal(captureReceiptQueryHistoryInput({authorization_command_id:uuid(1),expected_attempt_id:uuid(3),limit:25,before:2147483647}).before,2147483647);
 for(const edit of [x=>x.receipt_number='123456789012345',x=>x.actor=uuid(9),x=>x.confirmed=false,x=>x.command_id=x.source_command_id,x=>x.expected_candidate_version=1000000000,x=>x.expected_chain_hash='BAD'])fails(()=>captureReceiptQueryRunInput(mutate(input,edit)),'RECEIPT_QUERY_INPUT_INVALID');
 for(const before of [0,-1,2147483648,1.1,'1'])fails(()=>captureReceiptQueryHistoryInput({authorization_command_id:uuid(1),expected_attempt_id:uuid(3),limit:25,before}),'RECEIPT_QUERY_INPUT_INVALID');
});
test('unvalidated SQL context cannot become query eligibility by removing its blocker alone',()=>{
 const raw=publicContext({canQuery:false});raw.source_validation.verified=false;raw.blockers.push('SOURCE_VALIDATION_REQUIRED');assert.equal(projectReceiptQueryPublic(raw,contextBinding(raw)).can_query,false);
 fails(()=>projectReceiptQueryPublic(mutate(raw,x=>{x.blockers=[];x.can_query=true;x.selection=publicSelection();}),contextBinding(raw)));
 for(const edit of [x=>x.selection.expected_chain_hash=digest(99),x=>x.selection.expected_a1_version=0,x=>x.selection.expected_candidate_id=uuid(99),x=>x.selection.expected_source_binding_hash=digest(99),x=>x.selection.expected_query_policy_version=99,x=>x.source_validation.manifest_hash=digest(99),x=>x.source_validation.verified=false,x=>x.eligibility.ledger_eligible=false,x=>x.eligibility.runtime_enabled=false,x=>x.eligibility.ledger_eligible=1]){
  const ready=publicContext();fails(()=>projectReceiptQueryPublic(mutate(ready,edit),contextBinding(ready)));
 }
});
test('disabled runtime/policy, expired policy, cadence and closed resolution stay blocked',()=>{
 const raw=publicContext({canQuery:false});assert.equal(projectReceiptQueryPublic(raw,contextBinding(raw)).selection,null);
 for(const edit of [x=>x.policy.enabled=false,x=>x.policy.valid_until='2026-10-17T11:00:00.000Z',x=>x.next_query_at='2026-10-17T12:03:00.000Z'])fails(()=>projectReceiptQueryPublic(mutate(raw,edit),contextBinding(raw)));
 const disabled=mutate(raw,x=>{x.policy.enabled=false;x.blockers.push('POLICY_DISABLED');});assert.equal(projectReceiptQueryPublic(disabled,contextBinding(disabled)).can_query,false);
 const closed=publicContext({canQuery:false,history:[publicResult({state:'authorized_homologation'})]});assert.equal(projectReceiptQueryPublic(closed,contextBinding(closed)).resolution.state,'authorized_homologation');
 fails(()=>projectReceiptQueryPublic(mutate(closed,x=>x.blockers=['RUNTIME_DISABLED']),contextBinding(closed)));
});
test('every query state has coherent immutable receipt, consumed/finished state and recovery capacity',()=>{
 for(const state of ['prepared','request_ready','dispatched','uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorized_homologation']){
  const raw=publicResult({state}),out=projectReceiptQueryPublic(raw,commandBinding(raw));assert.equal(out.current.state,state);
  fails(()=>projectReceiptQueryPublic(mutate(raw,x=>x.current.grant_consumed=!x.current.grant_consumed),commandBinding(raw)));
  fails(()=>projectReceiptQueryPublic(mutate(raw,x=>x.current.expires_at='2026-10-17T12:01:01.000Z'),commandBinding(raw)));
 }
 const prepared=publicResult();fails(()=>projectReceiptQueryPublic(mutate(prepared,x=>x.current.can_recover=true),commandBinding(prepared)));
 const uncertain=publicResult({state:'uncertain'});uncertain.current.lease_expired=false;assert.equal(projectReceiptQueryPublic(uncertain,commandBinding(uncertain)).current.can_recover,true);
 // Historical consumption remains readable without a current policy/A1/review or emission-time check.
 const old=publicResult({state:'authorized_homologation'});old.receipt.identity_version=9;old.receipt.a1_version=12;old.receipt.query_policy_version=7;assert.equal(projectReceiptQueryPublic(old,commandBinding(old)).receipt.a1_version,12);
});
test('binding rejects another UUID/source/attempt/CAS but permits later current state for same run',()=>{
 const raw=publicResult({state:'receipt_pending',readOnly:false}),input={...publicSelection(),command_id:raw.command_id,confirmed:true},b={action:'receiptQueryRun',commandId:raw.command_id,input};
 assert.equal(projectReceiptQueryPublic(raw,b).current.state,'receipt_pending');
 for(const edit of [x=>x.receipt.a1_version=9,x=>x.source.authorization_attempt_id=uuid(99),x=>x.source.candidate_version=2,x=>x.receipt.source_command_id=uuid(99)])fails(()=>projectReceiptQueryPublic(mutate(raw,edit),b));
 fails(()=>projectReceiptQueryPublic(raw,{...b,commandId:uuid(99)}));fails(()=>projectReceiptQueryPublic(raw,commandBinding(raw)));
 assert.equal(projectReceiptQueryPublic(raw,{action:'receiptQueryRecover',commandId:raw.command_id,input:{confirmed:true}}).read_only,false);
});
test('105,104/100,104/150, protocol rejection and local validation failure remain distinct',()=>{
 for(const protocolCstat of ['100','150']){const x=publicResult({state:'authorized_homologation',protocolCstat});assert.equal(projectReceiptQueryPublic(x,commandBinding(x)).observation.protocol_cstat,protocolCstat);}
 const invalid=publicResult({state:'review_required'});Object.assign(invalid.observation,{outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false});assert.equal(projectReceiptQueryPublic(invalid,commandBinding(invalid)).observation.rejection_code,'SOAP_INVALID');
 fails(()=>projectReceiptQueryPublic(mutate(invalid,x=>x.observation.cstat='100'),commandBinding(invalid)));
 fails(()=>projectReceiptQueryPublic(mutate(invalid,x=>x.observation.rejection_code='PRIVATE_STACK'),commandBinding(invalid)));
 const pending=publicResult({state:'receipt_pending'});fails(()=>projectReceiptQueryPublic(mutate(pending,x=>x.observation.cstat='103'),commandBinding(pending)));
 const rejected=publicResult({state:'rejected'});for(const c of ['100','150','204','217','539'])fails(()=>projectReceiptQueryPublic(mutate(rejected,x=>x.observation.protocol_cstat=c),commandBinding(rejected)));
 const authorized=publicResult({state:'authorized_homologation'});for(const edit of [x=>x.observation.signature_verified=false,x=>x.observation.processed_xsd_validated=false,x=>x.observation.processed_hash=null,x=>x.observation.protocol_number='00000000000000000',x=>x.observation.received_at='2026-02-30T12:00:00.000Z'])fails(()=>projectReceiptQueryPublic(mutate(authorized,edit),commandBinding(authorized)));
});
test('chain authorization survives later105; selected query may be outside the history page',()=>{
 const authorized=publicResult({state:'authorized_homologation',ordinal:1}),pending=publicResult({state:'receipt_pending',ordinal:2});pending.resolution=structuredClone(authorized.resolution);
 const page=publicHistory([pending,authorized]);assert.equal(projectReceiptQueryPublic(page.raw,page.binding).resolution.selected_query_id,authorized.command_id);
 const oldPage=publicHistory([pending],{limit:1});oldPage.raw.next_before=2;assert.equal(projectReceiptQueryPublic(oldPage.raw,oldPage.binding).items.length,1);
 fails(()=>projectReceiptQueryPublic(mutate(page.raw,x=>x.items[1].observation.protocol_number='13526000000000002'),page.binding));
 fails(()=>projectReceiptQueryPublic(mutate(page.raw,x=>x.resolution.protocol.protocol_cstat='150'),page.binding));
});
test('conflicting chain never publishes one protocol as the resolution',()=>{
 const raw=publicResult({state:'authorized_homologation'});raw.resolution={state:'conflict',resolution_hash:digest(90),query_ids:[raw.command_id,uuid(12)],selected_query_id:null,protocol:null};assert.equal(projectReceiptQueryPublic(raw,commandBinding(raw)).resolution.protocol,null);
 fails(()=>projectReceiptQueryPublic(mutate(raw,x=>x.resolution.selected_query_id=x.command_id),commandBinding(raw)));
 fails(()=>projectReceiptQueryPublic(mutate(raw,x=>x.resolution.protocol={state:'authorized_homologation',cstat:'104',protocol_cstat:'100',protocol_number:'13526000000000001',received_at:'2026-10-17T12:00:02.000Z'}),commandBinding(raw)));
});
test('history cursor, descending ordinal and shared attempt/resolution are strictly bound',()=>{
 const page=publicHistory([publicResult({ordinal:3}),publicResult({ordinal:2})],{before:4,limit:2});page.raw.next_before=2;assert.equal(projectReceiptQueryPublic(page.raw,page.binding).next_before,2);
 for(const edit of [x=>x.next_before=1,x=>x.items.reverse(),x=>x.items[0].receipt.ordinal=4,x=>x.items[1].receipt.ordinal=3,x=>x.items[1].resolution.resolution_hash=digest(99),x=>x.items[1].source.authorization_attempt_id=uuid(99)])fails(()=>projectReceiptQueryPublic(mutate(page.raw,edit),page.binding));
});
test('no rawXML,privatefields,unknowntext or getters escape the public boundary',()=>{
 const raw=publicResult({state:'authorized_homologation'});
 for(const edit of [x=>x.execution={},x=>x.receipt.actor=uuid(9),x=>x.source.recovery={},x=>x.observation.xml='<secret/>',x=>x.observation.xMotivo='private',x=>x.resolution.protocol.access_key='1'.repeat(44),x=>x.resolution.protocol.receipt_number='1'.repeat(15),x=>x.current.nonce=uuid(9)])fails(()=>projectReceiptQueryPublic(mutate(raw,edit),commandBinding(raw)));
 let invoked=false;const getter=structuredClone(raw);Object.defineProperty(getter.source,'original',{get(){invoked=true;throw new Error('secret');},enumerable:true});fails(()=>projectReceiptQueryPublic(getter,commandBinding(raw)));assert.equal(invoked,false);
 const throwing=new Proxy({}, {ownKeys(){throw new Error('secret');}});fails(()=>projectReceiptQueryPublic(throwing,commandBinding(raw)));
 const cyclic=structuredClone(raw);cyclic.source.original=cyclic;fails(()=>projectReceiptQueryPublic(cyclic,commandBinding(raw)));
 const sparse=publicHistory([]);sparse.raw.items=new Array(1);fails(()=>projectReceiptQueryPublic(sparse.raw,sparse.binding));
});
test('dedicated256KiB envelope accepts a real-shaped >128KiB history and rejects final excess',()=>{
 const items=Array.from({length:25},(_,i)=>publicResult({ordinal:25-i,state:'authorized_homologation'}));
 const resolution={state:'conflict',resolution_hash:digest(9),query_ids:Array.from({length:100},(_,i)=>uuid(100+i)),selected_query_id:null,protocol:null};items.forEach(x=>x.resolution=structuredClone(resolution));
 const page=publicHistory(items,{resolution});const size=Buffer.byteLength(JSON.stringify(page.raw));assert.ok(size>131072&&size<MAX_RECEIPT_QUERY_PUBLIC_BYTES,`fixture size ${size}`);assert.equal(projectReceiptQueryPublic(page.raw,page.binding).items.length,25);
 const huge=structuredClone(page.raw);huge.resolution.query_ids=Array.from({length:5000},(_,i)=>uuid(100+i));huge.items.forEach(x=>x.resolution=structuredClone(huge.resolution));assert.ok(Buffer.byteLength(JSON.stringify(huge))>MAX_RECEIPT_QUERY_PUBLIC_BYTES);fails(()=>projectReceiptQueryPublic(huge,page.binding));
});
test('module stays browser-safe and imports no private reader/crypto/transport',async()=>{
 const source=await readFile(new URL('../src/receipt-query-public-dto.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(?:import|require)\s*(?:\(|.*from)|\bBuffer\b|node:|process\.env/);
});
