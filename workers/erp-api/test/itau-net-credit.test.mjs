import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{createNetCreditFixture}from'./helpers/itau-net-credit-fixture.mjs';
import{parseItauNetCreditRoute,executeItauNetCreditRoute,itauNetCreditMethods}from'../src/itau-net-credit.mjs';
import{planItau109NetCredit}from'../../../packages/cnab-core/src/itau-net-credit.mjs';
import{parseFinanceRoute,executeFinanceRoute}from'../src/finance.mjs';
let f;
before(async()=>{f=await createNetCreditFixture();});after(()=>f?.close());
const state=code=>e=>e.code===code;
const request=(path,body,signal)=>new Request('https://test.invalid/v1/retornos-itau109'+path,body===undefined?{signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
const api=async(path,body,extra={},signal)=>executeItauNetCreditRoute(await parseItauNetCreditRoute(request(path,body,signal)),f.ports(extra));
async function setup(patch={}){const x=await f.prepare(),c=await f.category(),i=await f.importFile(x,f.source(x,{fee:'345',paid:'12000',...patch}));const body={file_id:i.ack.id,line:i.event.line,fee_category_id:c.id,expected_fee_category_version:c.version};const p=(await api(`/events/${i.event.event_id}/preview`,body)).body;return{x,c,i,p,selection:body,command:{...body,command_id:randomUUID(),expected_approval_version:1,context_hash:p.context_hash,confirm:true}};}
test('058 SQL→parser→HTTP preview, atomic two legs, current readback and explicit immutable category',async()=>{
 const t=await setup(),{x,c,i,p,command}=t;assert.equal(p.bytes_verified,true);assert.equal(p.context.settlement.allowed,true);assert.equal((await f.preview(i)).context.settlement.allowed,false);
 const expected=planItau109NetCredit({bank:'341',wallet:'109',nominal_cents:'12345',credited_cents:'12000',adjustments:p.context.base.event.adjustments,fee_category:p.context.category,expected_fee_category_version:1});assert.deepEqual(p.context.plan,expected);
 assert.equal((await f.current(x.title.id)).record.settled_cents,'0');
 const ack=(await api(`/events/${i.event.event_id}/settle`,command)).body;assert.equal(ack.replayed,false);assert.equal(ack.receipt.posting.fee_category.id,c.id);assert.deepEqual(ack.receipt.movements.map(m=>m.delta_cents),['12345','-345']);
 const read=(await api(`/commands/${command.command_id}`)).body;assert.equal(read.current_title.balance_cents,'0');assert.equal(read.current_settlement.net_cash_cents,'12000');assert.equal(read.current_account.balance_cents,'12000');assert.deepEqual(read.receipt,ack.receipt);
 assert.equal((await api(`/events/${i.event.event_id}/settle`,command)).body.replayed,true);
 assert.equal(await f.scalar('select count(*)::int v from erp_finance.movement where settlement_id=$1',[ack.receipt.settlement_id]),2);
 // Existing native HTTP projection still accepts the two kinds.
 const route=await parseFinanceRoute(new Request(`https://test.invalid/v1/financeiro/movements?parent_id=${x.account.id}`));const native=await executeFinanceRoute(route,{userId:f.users.financeiro,rpc:f.rpc});assert.deepEqual(native.items.map(m=>m.kind).sort(),['bank_fee','payment']);
});
test('058 money decisions are closed; every unsupported adjustment, charge and category change blocks without writing',async()=>{
 for(const patch of[{interest:'10',paid:'12010'},{iof:'1'},{abatement:'1'},{discount:'1'},{otherCredits:'1'},{paid:'12001'},{occurrence:'07'},{occurrence:'09'}]){
  const t=await setup(patch);assert.equal(t.p.context.settlement.allowed,false,JSON.stringify(patch));await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command),state('ERP_CONFLICT'));assert.equal((await f.current(t.x.title.id)).record.settled_cents,'0');
 }
 const t=await setup();await f.native('category_save',{id:t.c.id,expected_version:1,name:'CATEGORIA ALTERADA',kind:'payable'});
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command),state('ERP_CONFLICT'));const changed=(await api(`/events/${t.i.event.event_id}/preview`,t.selection)).body;assert.ok(changed.context.settlement.issues.includes('FEE_CATEGORY_VERSION_CHANGED'));assert.equal(changed.context.plan.posting,null);
});
test('058 original plan drives generic reversal; later changes never rewrite receipt or release event dedupe',async()=>{
 const t=await setup(),ack=(await api(`/events/${t.i.event.event_id}/settle`,t.command)).body;
 await f.native('category_save',{id:t.c.id,expected_version:1,name:'NOVA CATEGORIA',kind:'payable',active:false});
 const reversed=await f.native('reverse',{id:t.x.title.id,expected_version:2,settlement_id:ack.receipt.settlement_id,posted_on:f.today,note:'CORRECAO SINTETICA'});
 assert.equal(reversed.account.balance_cents,'0');assert.equal(reversed.record.balance_cents,'12345');
 assert.deepEqual((await f.db.query('select kind,delta_cents::text amount from erp_finance.movement where settlement_id=$1 order by kind',[reversed.settlement.id])).rows,[{kind:'bank_fee_reversal',amount:'345'},{kind:'reversal',amount:'-12345'}]);
 const read=(await api(`/commands/${t.command.command_id}`)).body;assert.deepEqual(read.receipt,ack.receipt);assert.equal(read.current_settlement.reversed,true);
 assert.equal((await api(`/events/${t.i.event.event_id}/settle`,t.command)).body.replayed,true);
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,{...t.command,command_id:randomUUID()}),state('ERP_CONFLICT'));
});
test('058 HTTP rejects actor/amount/date/profile injection, unknown routes, encoding and forged routes before RPC',async()=>{
 const t=await setup();let calls=0;const extra={rpc:async()=>{calls++;throw Error('PRIVATE_SENTINEL');}};
 for(const change of [{amount_cents:'1'},{paid_cents:'1'},{account_id:randomUUID()},{posted_on:f.today},{p_user_id:randomUUID()},{confirm:false},{expected_fee_category_version:0}])await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,{...t.command,...change},extra),e=>e.status===400);
 await assert.rejects(()=>executeItauNetCreditRoute({kind:'command',args:{}},f.ports(extra)),e=>e.status===400);assert.equal(calls,0);
 const r=request(`/events/${t.i.event.event_id}/preview`,t.selection);r.headers.set('content-encoding','gzip');await assert.rejects(()=>parseItauNetCreditRoute(r),e=>e.status===400);
 assert.deepEqual(itauNetCreditMethods('/v1/retornos-itau109/events/x/settle'),['POST']);await assert.rejects(()=>parseItauNetCreditRoute(request(`/events/${t.i.event.event_id}/settle`)),e=>e.status===405);
 await assert.rejects(()=>api(`/commands/${randomUUID()}`),state('ERP_NOT_FOUND'));
});
test('058 ACL and account/category context are rechecked; file tampering and wrong actor cannot dispatch',async()=>{
 const t=await setup();let writes=0;const rpc=async(name,args)=>{if(name==='erp_cnab_itau_net_credit_settle')writes++;return f.rpc(name,args);};
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command,{rpc,userId:f.users.consulta}),e=>e.status===403);
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command,{rpc,getFile:async()=>new Uint8Array([1])}),e=>e.status===409);assert.equal(writes,0);
 await f.native('account_save',{id:t.x.account.id,expected_version:1,name:'CONTA RENOMEADA',kind:'bank'});await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command),e=>e.status===409);
});
test('058 lost acknowledgement and invalid acknowledgement preserve committed result for GET without another posting',async()=>{
 for(const mode of ['lost','invalid']){const t=await setup();let posts=0;const rpc=async(name,args)=>{const v=await f.rpc(name,args);if(name==='erp_cnab_itau_net_credit_settle'){posts++;if(mode==='lost')throw new Error('PRIVATE_RESPONSE_SENTINEL');return{...v,receipt:{...v.receipt,posting:{...v.receipt.posting,net_cash_cents:'1'}}};}return v;};
  await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command,{rpc}),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED'&&!e.message.includes('PRIVATE'));
  const read=(await api(`/commands/${t.command.command_id}`)).body;assert.equal(read.current_account.balance_cents,'12000');assert.equal(posts,1);assert.equal(read.receipt.movements.length,2);
 }
});
test('058 abort after SQL commit is uncertain; command GET recovers and response never exposes private payloads',async()=>{
 const t=await setup(),controller=new AbortController();const rpc=async(name,args)=>{const v=await f.rpc(name,args);if(name==='erp_cnab_itau_net_credit_settle')controller.abort();return v;};
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,t.command,{rpc},controller.signal),e=>e.status===503&&e.code==='ERP_RESULT_UNCONFIRMED');
 const read=(await api(`/commands/${t.command.command_id}`)).body;assert.equal(read.current_account.balance_cents,'12000');assert.doesNotMatch(JSON.stringify(read),/object_path|reviewedBy|account_scope|payload|cnpj/i);
});
test('058 RLS, service-only boundary and immutable plan/movements remain closed',async()=>{
 const t=await setup(),ack=(await api(`/events/${t.i.event.event_id}/settle`,t.command)).body;
 assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid='erp_finance.cnab_cash_plan'::regclass"),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_table_privilege($1,'erp_finance.cnab_cash_plan','SELECT')v",[role]),false);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_function_privilege($1,'erp_finance.post_settlement_movements(uuid,bigint)','EXECUTE')v",[role]),false);
 for(const role of ['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_cnab_itau_net_credit_command(uuid,uuid)','EXECUTE')v",[role]),false);
 await assert.rejects(()=>f.db.query('update erp_finance.cnab_cash_plan set fee_cents=1 where command_id=$1',[t.command.command_id]),state('42501'));
 await assert.rejects(()=>f.db.query('delete from erp_finance.movement where settlement_id=$1',[ack.receipt.settlement_id]),state('42501'));
});
test('058 keeps historical dates separate from edited financial dates and validates timestamp calendars',async()=>{
 const t=await setup(),ack=(await api(`/events/${t.i.event.event_id}/settle`,t.command)).body;
 await f.native('title_update',{id:t.x.title.id,expected_version:2,due_on:'2100-12-31'});
 const read=(await api(`/commands/${t.command.command_id}`)).body;assert.equal(read.current_title.due_on,'2100-12-31');assert.deepEqual(read.receipt,ack.receipt);
 for(const created_at of ['2026-02-30T12:00:00Z','2026-10-16T25:00:00Z','2026-10-16T12:00:00+14:01']){
  const rpc=async(name,args)=>{const v=await f.rpc(name,args);return {...v,receipt:{...v.receipt,created_at}};};
  await assert.rejects(()=>api(`/commands/${t.command.command_id}`,undefined,{rpc}),e=>e.status===502);
 }
 const rpc=async(name,args)=>{const v=await f.rpc(name,args);return {...v,receipt:{...v.receipt,created_at:'2026-10-16T12:34:56.123456-03:00'}};};
 assert.equal((await api(`/commands/${t.command.command_id}`,undefined,{rpc})).body.receipt.created_at,'2026-10-16T12:34:56.123456-03:00');
});
test('058 posting constraints preserve053 atomic transfers and shared command namespace',async()=>{
 const t=await setup(),other=(await f.native('account_save',{expected_version:0,name:'OUTRA CONTA SINTETICA',kind:'bank'})).record;
 const command=randomUUID(),data={from_account_id:t.x.account.id,to_account_id:other.id,expected_from_version:1,expected_to_version:1,amount_cents:'123',posted_on:f.today,note:'TRANSFERENCIA SINTETICA',confirmed:true};
 const transfer=await f.rpc('erp_finance_transfer_post',{p_user_id:f.users.financeiro,p_command_id:command,p_data:data});
 assert.equal((await f.rpc('erp_finance_transfer_post',{p_user_id:f.users.financeiro,p_command_id:command,p_data:data})).replayed,true);
 const rows=(await f.db.query('select kind,delta_cents::text amount,settlement_id from erp_finance.movement where command_id=$1 order by kind',[command])).rows;
 assert.deepEqual(rows,[{kind:'transfer_in',amount:'123',settlement_id:null},{kind:'transfer_out',amount:'-123',settlement_id:null}]);
 assert.ok(transfer.receipt);
 await assert.rejects(()=>api(`/events/${t.i.event.event_id}/settle`,{...t.command,command_id:command}),e=>e.status===409);
 assert.equal((await f.current(t.x.title.id)).record.settled_cents,'0');
});
