import test from 'node:test';
import assert from 'node:assert/strict';
import {transferAccount,transferAccountEnvelope,transferAccountPage,transferBody,transferResult,transferPage} from '../src/lib/finance-transfers-model.ts';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const flags={scope:'finance_internal_transfer',data_mode:'erp_native',bank_operation_performed:false,title_mutation_performed:false,opening_mutation_performed:false};
const account=(n,balance='100000',version=3)=>({id:id(n),name:`Conta sintética ${n}`,kind:'bank',version,balance_cents:balance,active:true,opening_recorded:true,opening_on:'2026-01-01'});
function fixture(n=10){
 const a=account(1),b=account(2),body=transferBody(a,b,{amount:'12,34',posted_on:'2026-01-15',note:'Registro sintético'},id(n+100));
 const snap=(v,delta)=>({id:v.id,name:v.name,kind:v.kind,version_before:v.version,version_after:v.version+1,balance_before_cents:v.balance_cents,balance_after_cents:(BigInt(v.balance_cents)+delta).toString(),opening_on:v.opening_on});
 const from=snap(a,-1234n),to=snap(b,1234n);
 const receipt={id:id(n),command_id:body.command_id,from_account:from,to_account:to,amount_cents:body.amount_cents,posted_on:body.posted_on,note:body.note,created_at:'2026-10-16T15:30:40.123456-03:00',movements:[{id:id(n+200),account_id:a.id,kind:'transfer_out',delta_cents:'-1234'},{id:id(n+300),account_id:b.id,kind:'transfer_in',delta_cents:'1234'}]};
 const current={from_account:{...a,version:4,balance_cents:from.balance_after_cents},to_account:{...b,version:4,balance_cents:to.balance_after_cents}};
 return{body,raw:{...flags,receipt,current,replayed:false},read:{...flags,receipt,current,read_only:true}};
}

test('053 model preserves exact large amounts, Unicode names and historical versus current balances',()=>{
 const a=account(1,'123456789012345678901234567890');a.name='😀'.repeat(200);assert.equal(transferAccount(a).name,a.name);
 const body=transferBody(a,account(2),{amount:'9999999999999,99',posted_on:'2026-01-15',note:'😀'.repeat(500)},id(3));assert.equal(body.amount_cents,'999999999999999');assert.equal([...body.note].length,500);
 const f=fixture(),ack=transferResult(f.raw,{body:f.body}).receipt;
 f.read.current.from_account.balance_cents='999999999999999999999';f.read.current.from_account.version++;
 const value=transferResult(f.read,{body:f.body,ack,readOnly:true});assert.equal(value.current.from_account.balance_cents,'999999999999999999999');assert.equal(value.receipt.from_account.balance_after_cents,'98766');
 assert.throws(()=>transferAccount({...a,name:'😀'.repeat(201)}));assert.throws(()=>transferAccount({...a,kind:['bank']}));
});

test('053 model rejects malformed arithmetic, identity, versions, dates and false effect flags',()=>{
 const mutations=[r=>r.receipt.from_account.balance_after_cents='98765',r=>r.receipt.to_account.id=r.receipt.from_account.id,r=>r.receipt.movements.reverse(),r=>r.receipt.movements[1].id=r.receipt.movements[0].id,r=>r.receipt.movements[0].delta_cents='1234',r=>r.receipt.from_account.version_after=3,r=>r.current.from_account.version=3,r=>r.current.from_account.balance_cents='99',r=>r.current.from_account.opening_on='2026-01-02',r=>r.current.from_account.opening_recorded=false,r=>r.receipt.posted_on='2026-02-30',r=>r.receipt.created_at='2026-02-30T12:00:00Z',r=>r.receipt.created_at='2026-10-16T12:00:00+14:01',r=>r.receipt.created_at='2026-10-16',r=>r.receipt.note='\u00a0\u200b\u00a0',r=>r.receipt.note='ab\u0085c',r=>r.receipt.amount_cents='01',r=>r.bank_operation_performed=true];
 for(const change of mutations){const f=fixture();change(f.raw);assert.throws(()=>transferResult(f.raw,{body:f.body}));}
});

test('053 model binds receipt to frozen request, acknowledgement and explicit read identifier',()=>{
 for(const property of ['command_id','from_account_id','to_account_id','expected_from_version','expected_to_version','amount_cents','posted_on','note']){
  const f=fixture(),body={...f.body,[property]:typeof f.body[property]==='number'?99:property.includes('id')?id(999):property==='amount_cents'?'5':property==='posted_on'?'2026-01-16':'Outro registro'};
  assert.throws(()=>transferResult(f.raw,{body}),property);
 }
 const f=fixture(),ack=transferResult(f.raw,{body:f.body}).receipt;
 assert.throws(()=>transferResult(f.read,{readOnly:true,transferId:id(999)}));
 f.read.receipt.note='Nota posterior impossível';assert.throws(()=>transferResult(f.read,{ack,readOnly:true}));
 assert.throws(()=>transferResult(f.raw,{readOnly:true}));assert.throws(()=>transferResult(f.read));
});

test('053 model checks25-row pagination, sorted identities and correct account envelopes',()=>{
 const values=Array.from({length:25},(_,i)=>fixture(1000+i).read),raw={...flags,read_only:true,items:values,limit:25,has_more:true,next_cursor:values.at(-1).receipt.id};
 assert.equal(transferPage(raw,null).items.length,25);
 for(const patch of [{limit:26},{items:values.slice(0,24)},{items:[values[1],values[0],...values.slice(2)]},{next_cursor:id(999)},{has_more:false}])assert.throws(()=>transferPage({...raw,...patch},null));
 assert.throws(()=>transferPage(raw,values[0].receipt.id));
 const accounts=Array.from({length:25},(_,i)=>account(i+1)),page={entity:'accounts',data_mode:'erp_native',limit:25,items:accounts,has_more:true,next_cursor:accounts.at(-1).id};
 assert.equal(transferAccountPage(page,null).items.length,25);assert.throws(()=>transferAccountPage({...page,next_cursor:null},null));
 assert.equal(transferAccountEnvelope({entity:'accounts',data_mode:'erp_native',record:account(1)},id(1)).id,id(1));assert.throws(()=>transferAccountEnvelope({entity:'accounts',data_mode:'erp_native',record:account(2)},id(1)));
});

test('053 local confirmation rejects zero, precision loss, future dates and empty descriptions',()=>{
 const values={amount:'1,00',posted_on:'2026-01-15',note:'Registro sintético'};
 for(const amount of ['0','-1','1,005','10000000000000,00'])assert.throws(()=>transferBody(account(1),account(2),{...values,amount},id(3)));
 for(const posted_on of ['', '2026-02-30','2100-12-31'])assert.throws(()=>transferBody(account(1),account(2),{...values,posted_on},id(3)));
 for(const note of ['', 'ab','\u200b\u200b\u200b','a\nb','😀'.repeat(501)])assert.throws(()=>transferBody(account(1),account(2),{...values,note},id(3)));
 assert.throws(()=>transferBody(account(1),account(1),values,id(3)));assert.throws(()=>transferBody({...account(1),active:false},account(2),values,id(3)));
});
