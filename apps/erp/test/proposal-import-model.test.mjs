import test from 'node:test';import assert from 'node:assert/strict';
import {checkedProposalPage,checkedProposalPreview,checkedProposalAck,checkedProposalCurrent,proposalApply,proposalListPath,proposalDocumentPath} from '../src/lib/origin-proposal-import-model.ts';
import {page,row,preview,ack,current,document} from './helpers/proposal-import-fixtures.mjs';
const command='e0000000-0000-4000-8000-000000000001';
test('052 client preserves exact decimals, microseconds, bigint strings and explicit-only request',()=>{
 const p=checkedProposalPreview(preview(),'9520000001'),body=proposalApply(p,command,true,true),a=checkedProposalAck(ack(body),body,p),c=checkedProposalCurrent(current(ack(body)),{request:body,preview:p,ack:a});
 assert.equal(p.source_version,'9223372036854775807');assert.equal(p.proposed.items[0].unit_price,'12.8500');assert.equal(p.proposed.items[0].quantity,'2.000000');assert.equal(c.receipt.source_seen_at,'2026-10-16T12:00:00.123456+00:00');assert.deepEqual(Object.keys(body),['source_id','preview_hash','command_id','confirm_import','duplicate_reviewed']);assert.ok(Object.isFrozen(body));assert.throws(()=>proposalApply(p,command,true,false));assert.throws(()=>proposalApply(p,command,false,true));
});
test('052 client rejects swapped scope, flags, arithmetic, links and silently changed receipt',()=>{
 for(const mutate of [v=>v.source_id='99',v=>v.financial_effects=true,v=>v.proposed.totals.total='26.72',v=>v.proposed.items[0].total='25.71',v=>v.proposed.items[0].quantity='2',v=>v.bindings[1].record_id=document,v=>v.bindings[0].human_edited=true,v=>v.proposed.installments[0].amount='26.70',v=>v.can_apply=false,v=>v.source_version=1]){const v=preview();mutate(v);assert.throws(()=>checkedProposalPreview(v,'9520000001'));}
 const p=checkedProposalPreview(preview(),'9520000001'),body=proposalApply(p,command,true,true),a=ack(body);for(const mutate of [v=>v.receipt.command_id=document,v=>v.receipt.document.total='27.71',v=>v.receipt.document.version=2,v=>v.receipt.source_hash='c'.repeat(64)]){const value=structuredClone(a);mutate(value);assert.throws(()=>checkedProposalAck(value,body,p));}
 const altered=current(a);altered.receipt.imported_at='2026-10-17T12:00:00Z';assert.throws(()=>checkedProposalCurrent(altered,{request:body,ack:checkedProposalAck(a,body,p)}));
});
test('052 current document may change without rewriting its receipt or copying private extras',()=>{
 const p=checkedProposalPreview(preview(),'9520000001'),body=proposalApply(p,command,true,true),a=ack(body),v=current(a);Object.assign(v.current_document,{version:2,status:'approved',date:'2026-10-17',notes:'Texto posterior'});v.current_document.totals.total='32.00';v.secret='not projected';const c=checkedProposalCurrent(v,{request:body,ack:checkedProposalAck(a,body,p)});assert.equal(c.receipt.document.total,'26.71');assert.equal(c.current_document.total,'32.00');assert.equal(c.current_document.version,2);assert.equal(c.secret,undefined);assert.equal(c.current_document.notes,undefined);assert.match(proposalDocumentPath(document),/tipo=sales_proposals&documento=/);
 const reorder=Object.fromEntries(Object.entries(a.receipt).reverse());assert.doesNotThrow(()=>checkedProposalCurrent({...v,receipt:reorder},{request:body,ack:checkedProposalAck(a,body,p)}));
});
test('052 pending preview never presents partial proposed content and pagination keeps exact ID order',()=>{
 const blocked=preview();Object.assign(blocked,{can_apply:false,proposed:null,issues:[{code:'TRANSPORT_FIELD_UNSUPPORTED',field:'transporte',position:null},{code:'SOURCE_DATE_INVALID',field:'dataProximoContato',position:null}]});assert.equal(checkedProposalPreview(blocked,'9520000001').proposed,null);blocked.proposed=preview().proposed;assert.throws(()=>checkedProposalPreview(blocked,'9520000001'));
 const rows=Array.from({length:26},(_,i)=>row(String(9520000001+i))),first=checkedProposalPage(page(rows));assert.equal(first.has_more,true);assert.equal(checkedProposalPage(page(rows,first.next_cursor),first.next_cursor).items.length,1);assert.throws(()=>checkedProposalPage({...page(rows),next_cursor:'99'}));assert.throws(()=>checkedProposalPage(page([row(),row()])));assert.equal(proposalListPath('QA/001'),'\/v1/importacao-orcamentos-origin?limit=25&q=QA%2F001');assert.throws(()=>proposalListPath('x\n'));assert.throws(()=>proposalDocumentPath('../bad'));
});
test('052 timestamps reject impossible calendar dates, times and offsets without losing microseconds',()=>{
 for(const bad of ['2026-02-30T12:00:00Z','2026-10-16T24:00:00Z','2026-10-16T12:00:00+14:01','2026-10-16T12:00:00+01:99']){const p=preview();p.source_seen_at=bad;assert.throws(()=>checkedProposalPreview(p,p.source_id));}
 const p=preview();p.source_seen_at='2026-10-16T09:00:00.123456-03:00';assert.equal(checkedProposalPreview(p,p.source_id).source_seen_at,p.source_seen_at);
});
