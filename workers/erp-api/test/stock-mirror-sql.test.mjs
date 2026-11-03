import test from 'node:test';
import assert from 'node:assert/strict';
import { stockMirrorFixture,STOCK_MIRROR_MIGRATION } from './helpers/stock-mirror-fixture.mjs';
import { stockMirrorOperation,stockMirrorResponse } from '../src/stock-mirror.mjs';
let f;
test.before(async()=>{f=await stockMirrorFixture({migrate:false});await f.observe('100',[{id:'900',saldoFisico:9,saldoVirtual:7}]);await f.migrate(STOCK_MIRROR_MIGRATION);});
test.after(async()=>f?.close());
test('stock mirror bootstraps into a bounded queue and never changes native ledgers',async()=>{
 assert.equal(await f.scalar('select count(*)::int v from erp_stock_mirror.position'),0);
 assert.deepEqual(await f.project(1),{processed:1,applied:1,failed:0,pending:0});
 const page=await f.list();assert.equal(page.items[0].physical,'9');assert.equal(page.items[0].virtual,'7');assert.equal(page.items[0].reserved,'2');
 assert.equal(page.items[0].origin,'origin');assert.equal(page.items[0].read_only,true);assert.deepEqual(page.native,{positions:0,movements:0});
 assert.equal(await f.scalar('select count(*)::int v from erp_finance.title'),0);
 assert.equal(page.coverage.partial,true);assert.ok(page.items[0].issues.includes('PRODUCT_UNLINKED'));
});
test('stock mirror captures A B A revisions, applies them once and ignores old versions',async()=>{
 const a=[{id:'900',saldoFisico:10,saldoVirtual:8}];
 await f.observe('101',a);await f.observe('101',[{id:'900',saldoFisico:7,saldoVirtual:5}]);await f.observe('101',a);
 assert.deepEqual(await f.project(),{processed:3,applied:3,failed:0,pending:0});
 const rows=(await f.db.query("select source_version::int,physical::text,physical_delta::text from erp_stock_mirror.observation where product_source_id='101'order by source_version")).rows;
 assert.deepEqual(rows,[{source_version:1,physical:'10',physical_delta:null},{source_version:2,physical:'7',physical_delta:'-3'},{source_version:3,physical:'10',physical_delta:'3'}]);
 assert.equal((await f.project()).processed,0);
 await f.observe('101',a,{version:1});assert.equal((await f.project()).applied,0);
 assert.equal((await f.list({p_query:'101'})).items[0].source_version,3);
 await f.observe('101',[{id:'900',saldoFisico:99,saldoVirtual:99}],{version:3});
 assert.equal(await f.scalar("select count(*)::int v from erp_stock_mirror.issue where product_source_id='101'and code='VERSION_HASH_CONFLICT'"),1);
 assert.equal((await f.list({p_query:'101'})).items[0].physical,'10');
});
test('stock mirror preserves exact decimals, representation-only delta is zero, missing is never zero',async()=>{
 await f.observe('102',[{id:'900',saldoFisico:'900719925474099.123456',saldoVirtual:'900719925474099.123455'}]);await f.project();
 await f.observe('102',[{id:'900',saldoFisico:'900719925474099.1234560',saldoVirtual:'900719925474099.1234550'}]);await f.project();
 assert.equal(await f.scalar("select physical_delta::text v from erp_stock_mirror.observation where product_source_id='102'and source_version=2"),'0.000000');
 assert.equal((await f.list({p_query:'102'})).items[0].reserved,'0.000001');
 await f.observe('102',[{id:'900',saldoFisico:null,saldoVirtual:'bad'}]);await f.project();
 let row=(await f.list({p_query:'102'})).items[0];assert.equal(row.physical,null);assert.equal(row.physical_state,'null');assert.equal(row.virtual_state,'invalid');
 await f.observe('102',[]);await f.project();row=(await f.list({p_query:'102',p_warehouse_source_id:'900'})).items[0];
 assert.equal(row.physical,null);assert.equal(row.physical_state,'absent');
 assert.equal(await f.scalar("select count(*)::int v from erp_stock_mirror.observation where product_source_id='102'and warehouse_source_id='900'"),4);
});
test('stock mirror resolves identity only by Origin ID and paginates negative and pending stock',async()=>{
 const record=await f.linked('103');await f.observe('103',[{id:'900',saldoFisico:-4,saldoVirtual:-5},{id:'901',saldoFisico:3,saldoVirtual:3}]);await f.project();
 const linked=await f.list({p_product_id:record.id});assert.equal(linked.items.length,2);assert.ok(linked.items.every(r=>r.product_id===record.id&&r.unit==='UN'));
 const negatives=await f.list({p_state:'negative'});assert.deepEqual(negatives.items.map(r=>r.product_source_id),['103']);
 const first=await f.list({p_limit:2}),second=await f.list({p_limit:2,p_after:first.next_after});assert.equal(first.items.length,2);assert.equal(first.has_more,true);
 assert.ok(second.items.every(r=>r.id>first.next_after));assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,4);
 assert.equal((await f.list({p_warehouse_source_id:'901'})).items.length,1);
});
test('stock mirror handles deleted and malformed sources without erasing history or stopping the batch',async()=>{
 await f.observe('104',[{id:'900',saldoFisico:3,saldoVirtual:2}]);await f.project();
 await f.observe('104',[],{}, {_brufap_source:{deleted:true}});
 await f.observe('105',[{id:'900',saldoFisico:8},{id:'900',saldoFisico:9}]);await f.project();
 const removed=(await f.list({p_state:'deleted',p_warehouse_source_id:'900'})).items[0];assert.equal(removed.product_source_id,'104');assert.equal(removed.physical,null);
 assert.equal(await f.scalar("select count(*)::int v from erp_stock_mirror.observation where product_source_id='104'and warehouse_source_id='900'"),2);
 const bad=(await f.list({p_query:'105'})).items[0];assert.equal(bad.physical,null);assert.equal(bad.physical_state,'invalid');assert.ok(bad.issues.includes('WAREHOUSE_LIST_INVALID'));
});
test('stock mirror enforces current stock permissions and keeps all storage private',async()=>{
 for(const role of['admin','consulta','estoque','vendas','fiscal'])assert.equal((await f.list({p_user_id:f.users[role]})).scope,'stock_mirror');
 for(const role of['financeiro','inactive'])await assert.rejects(f.list({p_user_id:f.users[role]}),e=>e.code==='42501');
 await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by)values($1,'normal',false,'[]','{}',1,clock_timestamp(),$2)",[f.users.vendas,f.users.admin]);
 await assert.rejects(f.list({p_user_id:f.users.vendas}),e=>e.code==='42501');
 for(const role of['anon','authenticated','service_role']){
  for(const name of['source_version','pending','issue','applied','observation','position','current_position'])assert.equal(await f.scalar("select has_table_privilege($1,$2,'select')v",[role,'erp_stock_mirror.'+name]),false);
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_stock_mirror_list(uuid,text,text,uuid,text,integer,bigint)','execute')v",[role]),role==='service_role');
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_stock_mirror_project(integer)','execute')v",[role]),role==='service_role');
 }
 await assert.rejects(f.db.exec('delete from erp_stock_mirror.observation'),e=>/immutable/.test(e.message));
 await assert.rejects(f.db.exec('update erp_stock_mirror.source_version set source_hash=source_hash'),e=>/immutable/.test(e.message));
 assert.deepEqual((await f.list()).native,{positions:0,movements:0});
});
test('stock mirror real RPC response passes the API projection including nullable warehouse and cursor',async()=>{
 for(const query of['limit=2','limit=50&state=deleted','limit=50&state=pending']){
  const operation=stockMirrorOperation(new URLSearchParams(query));
  const value=await f.list(operation.args),projected=stockMirrorResponse(value,operation);
  assert.equal(projected.scope,'stock_mirror');assert.equal(projected.items.length,value.items.length);
 }
});
test('stock mirror item failure rolls back that projection, advances others, and retries without native effects',async()=>{
 await f.db.exec("create function erp_stock_mirror.test_fail()returns trigger language plpgsql as $$begin if new.product_source_id='106'then raise exception 'synthetic';end if;return new;end$$;create trigger mirror_test_failure before insert on erp_stock_mirror.observation for each row execute function erp_stock_mirror.test_fail()");
 await f.observe('106',[{id:'900',saldoFisico:3,saldoVirtual:2}]);await f.observe('107',[{id:'900',saldoFisico:4,saldoVirtual:4}]);
 assert.deepEqual(await f.project(),{processed:2,applied:1,failed:1,pending:1});
 assert.equal(await f.scalar("select count(*)::int v from erp_stock_mirror.observation where product_source_id='106'"),0);
 assert.equal((await f.list({p_query:'107'})).items.length,1);
 await f.db.exec("drop trigger mirror_test_failure on erp_stock_mirror.observation;drop function erp_stock_mirror.test_fail();update erp_stock_mirror.pending set retry_at=clock_timestamp()where product_source_id='106'");
 assert.deepEqual(await f.project(),{processed:1,applied:1,failed:0,pending:0});
 assert.deepEqual((await f.list()).native,{positions:0,movements:0});
});
test('stock mirror quarantines unsafe identities and classifies numeric overflow without poisoning a page',async()=>{
 await f.observe('bad-id',[{id:'900',saldoFisico:1}]);
 await f.observe('108',[{id:'900',saldoFisico:1}],{version:'9007199254740992'});
 await f.stage('products','109',{id:'109',nome:'x'.repeat(1000)+'\n',codigo:'A\nB',unidade:'U'.repeat(100)});
 await f.observe('109',[{id:'900',saldoFisico:'1e9999999',saldoVirtual:'1.0000000000000000000000000000000'}]);
 const result=await f.project();assert.equal(result.failed,0);assert.equal(result.applied,1);
 assert.equal(await f.scalar("select count(*)::int v from erp_stock_mirror.issue where code='SOURCE_IDENTITY_INVALID'"),2);
 const operation=stockMirrorOperation(new URLSearchParams('q=109')),page=stockMirrorResponse(await f.list(operation.args),operation);
 assert.equal(page.items[0].physical_state,'invalid');assert.equal(page.items[0].virtual,'1');assert.equal(page.items[0].product_name.length,200);assert.equal(page.items[0].unit.length,16);
 assert.equal(page.coverage.partial,true);
});
