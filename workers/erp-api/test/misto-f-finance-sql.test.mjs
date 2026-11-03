import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoFixture,fails}from'./helpers/misto-f-fixture.mjs';
import{parseFinanceRoute,executeFinanceRoute}from'../src/finance.mjs';

// Synthetic data only. 281: situação Devolvido das contas (FIN-011): the mark a devolução writes, the DTO and the Situação filter.
let f,contact,cash;
const titleCreate=async(cents='10000',kind='receivable',user=null)=>(await f.rpc('erp_finance_title_execute',{p_user_id:user??f.users.financeiro,p_command_id:randomUUID(),p_action:'title_create',
 p_data:{kind,contact_id:contact.id,description:'Venda sintética devolvida',issued_on:'2026-03-01',competence_on:'2026-03-01',total_cents:cents,installments:[{amount_cents:cents,due_on:'2026-03-31'}]}})).items[0];
const mark=async(titles,command=randomUUID(),source={kind:'pos_return',id:'9001',label:'Devolução sintética da venda 9001'},actor=f.users.vendas)=>
 f.scalar('select erp_finance.titles_mark_returned($1,$2,$3::uuid[],$4::jsonb) v',[actor,command,titles,JSON.stringify(source)]);
const page=async(statuses,user=f.users.consulta)=>f.rpc('erp_finance_title_page_v2',{p_user_id:user,p_kind:'receivable',p_page:1,p_limit:100,p_order:'due_asc',p_query:null,p_option:'issued',
 p_statuses:`{${statuses.join(',')}}`,p_date_field:'due',p_from:null,p_to:null,p_account:null,p_categories:null,p_remittance:null,p_amount_cents:null,p_document:null});
const call=async(path,user=f.users.consulta)=>executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`)),{userId:user,rpc:(name,args)=>f.rpc(name,Object.fromEntries(Object.entries(args).map(([k,v])=>[k,Array.isArray(v)?`{${v.join(',')}}`:v])))});

before(async()=>{f=await mistoFixture();
 contact=await f.catalog('contacts',{name:'Cliente Sintético Devolução',roles:['customer','supplier']});
 cash=(await f.rpc('erp_finance_account_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'account_create',p_data:{account_type:'cash',name:'Caixa sintético',start_on:'2020-01-01',opening_cents:'0'}})).record;
});
after(async()=>f?.close());

test('281 the devolução mark is private: no execution, no table access, immutable rows',async()=>{
 for(const role of['anon','authenticated','service_role']){
  assert.equal(await f.scalar("select has_function_privilege($1,'erp_finance.titles_mark_returned(uuid,uuid,uuid[],jsonb)','execute') v",[role]),false,role);
  assert.equal(await f.scalar("select has_table_privilege($1,'erp_finance.title_return','select,insert,update,delete') v",[role]),false,role);
 }
 assert.equal(await f.scalar("select relrowsecurity v from pg_class where oid='erp_finance.title_return'::regclass"),true);
 assert.deepEqual((await f.db.query("select prosecdef,proconfig from pg_proc where oid=to_regprocedure('erp_finance.titles_mark_returned(uuid,uuid,uuid[],jsonb)')")).rows[0],{prosecdef:false,proconfig:['search_path=pg_catalog']});
 assert.deepEqual((await f.db.query("select prosecdef,proconfig from pg_proc where oid=to_regprocedure('public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)')")).rows[0],
  {prosecdef:true,proconfig:['search_path=pg_catalog']});
 for(const role of['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)','execute') v",[role]),false);
});

test('281 an open conta becomes Devolvido (cancelled and marked), once, with the command, the audit and the closed DTO',async()=>{
 const open=await titleCreate('12345.67'.replace('.',''));
 const command=randomUUID(),done=await mark([open.id],command);
 assert.deepEqual([done.returned,done.cancelled,done.replayed],[[open.id],[open.id],[]]);
 assert.equal(done.items[0].status,'cancelled');assert.equal(done.items[0].returned,true);assert.equal(done.items[0].version,open.version+1);
 assert.equal(await f.scalar("select count(*)::int v from erp_finance.audit where command_id=$1 and action='title_returned'",[command]),1);
 // The same command again changes nothing; another devolução of the conta is refused.
 const again=await mark([open.id],command);assert.deepEqual([again.returned,again.replayed],[[],[open.id]]);
 assert.equal(await f.scalar("select count(*)::int v from erp_finance.audit where command_id=$1",[command]),1);
 await fails(assert,()=>mark([open.id]),'40001');
 await fails(assert,()=>f.db.query('update erp_finance.title_return set actor=actor where title_id=$1',[open.id]),'42501');
 await fails(assert,()=>f.db.query('delete from erp_finance.title_return where title_id=$1',[open.id]),'42501');
 // An already cancelled conta (Estornar contas, Cancelar) is only marked.
 const other=await titleCreate('5000');
 await f.rpc('erp_finance_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_cancel',p_data:{id:other.id,expected_version:other.version,note:'Cancelada antes da devolução'}});
 const marked=await mark([other.id]);assert.deepEqual([marked.returned,marked.cancelled],[[other.id],[]]);
 assert.equal(await f.scalar('select version v from erp_finance.title where id=$1',[other.id]),other.version+1,'cancelling bumped the version once; the mark did not');
});

test('281 a conta with a baixa, unknown, or a bad source is refused and nothing changes',async()=>{
 const paid=await titleCreate('3000');
 await f.rpc('erp_finance_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'settle',p_data:{id:paid.id,expected_version:paid.version,account_id:cash.id,posted_on:'2026-03-10',principal_cents:'1000',interest_cents:'0',penalty_cents:'0',discount_cents:'0',fee_cents:'0'}});
 const open=await titleCreate('2000');
 await fails(assert,()=>mark([open.id,paid.id]),'40001');
 assert.equal(await f.scalar('select cancelled v from erp_finance.title where id=$1',[open.id]),false,'all or nothing');
 await fails(assert,()=>mark([open.id,randomUUID()]),'P0002');
 assert.equal(await f.scalar('select count(*)::int v from erp_finance.title_return where title_id=$1',[open.id]),0);
 for(const source of[{kind:'manual',id:'1'},{kind:'pos_return'},{kind:'pos_return',id:'1',extra:true},{kind:'pos_return',id:'x'.repeat(61)},{kind:'pos_return',id:'1',label:''}])
  await fails(assert,()=>mark([open.id],randomUUID(),source),'22023');
 await fails(assert,()=>mark([]),'22023');await fails(assert,()=>mark([open.id,open.id]),'22023');
 await fails(assert,()=>mark([open.id],randomUUID(),undefined,f.users.inactive),'42501');
});

test('281 Situação: Devolvido lists only the returned contas and Cancelada leaves them out; the Worker keeps the flag',async()=>{
 const returned=await titleCreate('7000'),cancelled=await titleCreate('8000');
 await mark([returned.id]);
 await f.rpc('erp_finance_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_cancel',p_data:{id:cancelled.id,expected_version:cancelled.version,note:'Cancelada sintética'}});
 const onlyReturned=(await page(['returned'])).items.map(i=>i.id),onlyCancelled=(await page(['cancelled'])).items.map(i=>i.id);
 assert.ok(onlyReturned.includes(returned.id)&&!onlyReturned.includes(cancelled.id));
 assert.ok(onlyCancelled.includes(cancelled.id)&&!onlyCancelled.includes(returned.id));
 assert.ok((await page(['open','partial','paid','cancelled','returned'])).items.length>=2);
 await fails(assert,()=>page(['devolvido']),'22023');
 const api=await call('/v1/financeiro/titles?page=1&kind=receivable&option=issued&status=returned');
 const row=api.items.find(i=>i.id===returned.id);assert.equal(row.returned,true);assert.equal(row.status,'cancelled');
 assert.ok(api.items.every(i=>i.returned===true));
 const cancelledApi=await call('/v1/financeiro/titles?page=1&kind=receivable&option=issued&status=cancelled,returned');
 assert.equal(cancelledApi.items.find(i=>i.id===cancelled.id).returned,false);
 assert.equal((await call(`/v1/financeiro/titles/${returned.id}`)).record.returned,true);
});
