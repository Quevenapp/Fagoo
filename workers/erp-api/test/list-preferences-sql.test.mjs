import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{preferencesFixture,fails}from'./helpers/preferences-fixture.mjs';
import{listPreferenceValid}from'../../../packages/erp-domain/src/list-preferences.mjs';
const LIST='documentos.sales_orders';

test('116 each active user keeps their own columns and default filters, versioned and audited',async()=>{
 const f=await preferencesFixture();try{
  assert.deepEqual(await f.list(LIST),{scope:'list_preferences',data_mode:'erp_native',list_id:LIST,version:0,columns:null,filters:null,updated_at:null});
  const saved=await f.saveList(LIST,{user:f.users.vendas,columns:['numero','cliente','total'],filters:{situacao:['open','verified'],periodo:'30d'}});
  assert.equal(saved.replayed,false);assert.deepEqual(saved.preference.columns,['numero','cliente','total']);assert.deepEqual(saved.receipt.from_version,0);
  assert.equal((await f.list(LIST)).version,0);assert.equal((await f.list(LIST,f.users.vendas)).version,1);
  const second=await f.saveList(LIST,{user:f.users.vendas,expected:1,columns:['numero','total'],filters:{situacao:['open','verified'],periodo:'30d'}});assert.equal(second.preference.version,2);
  const reset=await f.saveList(LIST,{user:f.users.vendas,expected:2,columns:null,filters:null});assert.deepEqual([reset.preference.columns,reset.preference.filters,reset.preference.version],[null,null,3]);
  const audit=(await f.db.query('select from_version,to_version,before_data,after_data from erp_list_preferences.audit order by id')).rows;
  assert.deepEqual(audit.map(a=>[a.from_version,a.to_version]),[[0,1],[1,2],[2,3]]);assert.deepEqual(audit[2].after_data,{columns:null,filters:null});
  await fails(assert,()=>f.saveList(LIST,{user:f.users.vendas,expected:2,columns:['numero']}),'40001','erp_list_preferences_version_conflict');
  await fails(assert,()=>f.saveList(LIST,{user:f.users.vendas,expected:3}),'22023','erp_list_preferences_unchanged');
  await fails(assert,()=>f.list(LIST,f.users.inactive),'42501');await fails(assert,()=>f.saveList(LIST,{user:randomUUID(),columns:['a']}),'42501');
 }finally{await f.close();}
});

test('116 the same command replays once; a different body, actor or list under the same id conflicts; lookup is author-only',async()=>{
 const f=await preferencesFixture();try{
  const command=randomUUID(),first=await f.saveList(LIST,{command,columns:['numero']}),again=await f.saveList(LIST,{command,columns:['numero']});
  assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);assert.equal(await f.scalar('select count(*)::int v from erp_list_preferences.audit'),1);
  await fails(assert,()=>f.saveList(LIST,{command,columns:['cliente']}),'40001','erp_list_preferences_command_conflict');
  await fails(assert,()=>f.saveList('cadastros.contacts',{command,columns:['numero']}),'40001','erp_list_preferences_command_conflict');
  await fails(assert,()=>f.saveList(LIST,{command,user:f.users.other,columns:['numero']}),'40001','erp_list_preferences_command_conflict');
  assert.equal((await f.listCommand(command)).replayed,true);await fails(assert,()=>f.listCommand(command,f.users.other),'42501');await fails(assert,()=>f.listCommand(randomUUID()),'P0002');
 }finally{await f.close();}
});

test('116 shapes and limits are identical in SQL and in the shared contract',async()=>{
 const f=await preferencesFixture();try{
  const big=Object.fromEntries(Array.from({length:20},(_,i)=>[`k${i}`,'x'.repeat(200)]));
  const cases=[[null,null],[['a'],null],[[],null],[['A'],null],[['a','a'],null],[Array.from({length:61},(_,i)=>`c${i}`),null],[Array.from({length:60},(_,i)=>`c${i}`),null],[['a'.repeat(41)],null],
   [null,{}],[null,{a:'x'}],[null,{a:true}],[null,{a:3}],[null,{a:1.5}],[null,{a:1e9}],[null,{a:['x','y']}],[null,{a:[1]}],[null,{a:{b:1}}],[null,{a:null}],[null,{A:'x'}],[null,{a:'x\u0001'}],
   [null,{a:'x'.repeat(201)}],[null,{a:Array.from({length:51},()=>'x')}],[null,Object.fromEntries(Array.from({length:21},(_,i)=>[`k${i}`,true]))],[null,big],
   [null,{...Object.fromEntries(Array.from({length:19},(_,i)=>[`k${i}`,'é'.repeat(200)])),z:Array.from({length:50},()=>'x'.repeat(100))}],[null,{a:'ok','b':['x','é']}]];
  for(const[columns,filters]of cases){
   const sql=await f.scalar('select erp_list_preferences.valid($1::jsonb,$2::jsonb) v',[JSON.stringify(columns),JSON.stringify(filters)]);
   assert.equal(sql,listPreferenceValid(columns,filters),JSON.stringify([columns,filters]).slice(0,120));
  }
  for(const list of['Documentos','documentos..x','x'.repeat(61),'a-b','.a',''])await fails(assert,()=>f.saveList(list,{columns:['a']}),'22023');
  for(let i=0;i<200;i++)await f.saveList(`lista.n${i}`,{columns:['a']});
  await fails(assert,()=>f.saveList('lista.n200',{columns:['a']}),'22023','erp_list_preferences_limit');
  assert.equal((await f.saveList('lista.n0',{expected:1,columns:['b']})).preference.version,2);
 }finally{await f.close();}
});

test('116 tables are private, only service_role executes the RPCs and rows never change outside a command',async()=>{
 const f=await preferencesFixture();try{
  for(const role of['anon','authenticated','service_role'])for(const table of['command','preference','audit'])assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_list_preferences.${table}','select') v`),false);
  for(const fn of['erp_list_preferences_get(uuid,text)','erp_list_preferences_save(uuid,uuid,text,integer,jsonb,jsonb)','erp_list_preferences_command(uuid,uuid)']){
   assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${fn}','execute') v`),true);
   for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${fn}','execute') v`),false);}
  await f.saveList(LIST,{columns:['numero']});
  await fails(assert,()=>f.db.query("update erp_list_preferences.preference set columns='{x}',version=2"),'42501','erp_list_preferences_immutable');
  await fails(assert,()=>f.db.query('delete from erp_list_preferences.preference'),'42501');
  await fails(assert,()=>f.db.query('delete from erp_list_preferences.audit'),'42501','erp_list_preferences_history_immutable');
 }finally{await f.close();}
});
