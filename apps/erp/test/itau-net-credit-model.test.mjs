import test from 'node:test';
import assert from 'node:assert/strict';
import {NET_CREDIT_ISSUES,feeCategoryPage,netCreditPreview,netCreditBody,netCreditAck,netCreditReadback,netCreditReceipt} from '../src/lib/itau-net-credit-model.ts';
import {ITAU_NET_CREDIT_ISSUES} from '../../../packages/cnab-core/src/itau-net-credit.mjs';
import {uid,selection,category,categoryPage,netDetail,netPreview,netAck,netReadback} from './helpers/itau-net-credit-fixtures.mjs';
const choice={file_id:selection.file_id,line:2,fee_category_id:category.id,expected_fee_category_version:category.version};
const valid=()=>netCreditPreview(netPreview(),selection,choice);
test('058 preview checks exact arithmetic, category/version and finite blockers without trusting the posting',()=>{
 assert.deepEqual(Object.keys(NET_CREDIT_ISSUES).sort(),[...ITAU_NET_CREDIT_ISSUES].sort());
 assert.equal(valid().context.plan.posting.net_cash_cents,'12000');
 for(const mutate of [x=>x.context.plan.posting.fee_cents='344',x=>x.context.plan.posting.net_cash_cents='12001',x=>x.context.plan.posting.legs[1].delta_cents='345',x=>x.context.category_selection.expected_version++,x=>x.context.category.kind=['payable'],x=>x.bytes_verified=false,x=>x.financialMutationPerformed=true,x=>x.context.settlement.issues=['UNKNOWN']]){const p=netPreview();mutate(p);assert.throws(()=>netCreditPreview(p,selection,choice));}
 const d=netDetail();d.context.event.adjustments.interest='1';const blocked=netCreditPreview(netPreview(d),selection,choice);assert.deepEqual(blocked.context.plan.issues,['MORA_PENALTY_UNSUPPORTED']);assert.equal(blocked.context.plan.posting,null);assert.equal(blocked.context.settlement.allowed,false);assert.throws(()=>netCreditBody(blocked,true));
 const large=netDetail();large.context.event.amount_cents=large.context.title.amount_cents=large.context.title.balance_cents='999999999999999';large.context.event.paid_cents='999999999999654';assert.equal(netCreditPreview(netPreview(large),selection,choice).context.plan.posting.principal_cents,'999999999999999');
});
test('058 acknowledgement is bound to the frozen preview; readback preserves history after reversal',()=>{
 const p=valid(),body=netCreditBody(p,true,uid(90)),ack=netAck(body),receipt=netCreditAck(ack,body,p);assert.equal(Object.isFrozen(body),true);assert.throws(()=>netCreditBody(p,false));
 for(const patch of [{command_id:uid(99)},{event_id:uid(99)},{file_hash:'1'.repeat(64)},{context_hash:'1'.repeat(64)},{posted_on:'2026-10-17'}])assert.throws(()=>netCreditAck({...ack,receipt:{...receipt,...patch}},body,p));
 const current=netCreditReadback(netReadback(receipt,{reversed:true}),body.command_id,{body,preview:p,ack:receipt});assert.equal(current.current_title.due_on,'2100-12-31');assert.equal(current.current_settlement.reversed,true);assert.equal(current.receipt.posting.fee_category.version,3);assert.equal(current.current_account.active,false);
 for(const mutate of [x=>x.current_title.amount_cents='1',x=>x.current_account.id=uid(99),x=>x.current_settlement.fee_cents='344',x=>x.receipt.posting.fee_category.name='CHANGED',x=>x.current_title.due_on='2101-01-01']){const v=netReadback(receipt);mutate(v);assert.throws(()=>netCreditReadback(v,body.command_id,{body,preview:p,ack:receipt}));}
 for(const created_at of ['2026-02-30T12:00:00Z','2026-10-16T24:00:00Z','2026-10-16T12:00:00+14:01'])assert.throws(()=>netCreditReceipt({...receipt,created_at}));
 const privateFields=netReadback(receipt);privateFields.current_account.private='secret';privateFields.receipt.posting.private='secret';assert.doesNotMatch(JSON.stringify(netCreditReadback(privateFields,body.command_id)),/secret/);
});
test('058 categories preserve page ordering/cursor and reject fake or malformed choices',()=>{
 assert.equal(feeCategoryPage(categoryPage()).items[0].version,3);
 for(const v of [categoryPage([{...category,kind:['payable']}]),{...categoryPage(),has_more:true,next_cursor:category.id},categoryPage([category,category]),{...categoryPage(),limit:50}])assert.throws(()=>feeCategoryPage(v));
 const rows=Array.from({length:25},(_,i)=>({...category,id:uid(i+100)}));assert.equal(feeCategoryPage(categoryPage(rows,true)).next_cursor,uid(124));assert.throws(()=>feeCategoryPage(categoryPage(),category.id));
});
