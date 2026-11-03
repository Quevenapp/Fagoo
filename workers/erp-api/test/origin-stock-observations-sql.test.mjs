import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{open}from'node:fs/promises';
import{stockObservationsFixture}from'./helpers/stock-observations-fixture.mjs';
import{parseStockObservationsPage,parseStockObservationsDetail}from'../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
import{parseStockObservationsRoute,executeStockObservationsRoute}from'../src/origin-stock-observations.mjs';
let f,exportFixture;test.before(async()=>{f=await stockObservationsFixture();});test.after(async()=>{await f?.close();if(process.env.BRUFAP_STOCK_OBSERVATIONS_FIXTURE_OUTPUT&&exportFixture){const file=await open(process.env.BRUFAP_STOCK_OBSERVATIONS_FIXTURE_OUTPUT,'wx',0o600);try{await file.writeFile(JSON.stringify(exportFixture,null,2)+'\n');await file.sync();}finally{await file.close();}}});
const pageParse=(raw,limit=25,after=null)=>parseStockObservationsPage(raw,{warehouseSourceId:'007',limit,after});
const detail=async id=>parseStockObservationsDetail(await f.detail(id),{warehouseSourceId:'007',productSourceId:id});
const fails=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('087 additive read-only SQL preserves every existing row including086/native stock and enforces service/admin ACL',async()=>{
 assert.deepEqual(await f.allRows(),f.before);
 for(const role of['anon','authenticated','service_role']){assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_origin_stock_observations(uuid,text,integer,text,text)','execute')v",[role]),role==='service_role');assert.equal(await f.scalar("select has_function_privilege($1,'erp_cutover.stock_observation_row(text,text)','execute')v",[role]),false);}
 for(const role of['estoque','financeiro','vendas','consulta','fiscal'])await fails(()=>f.page({p_user_id:f.users[role]}),'42501');
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);try{await fails(()=>f.detail('001'),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
});
test('087 union/cursor/counts preserve exact IDs and distinguish known-without-stock from stock-without-product',async()=>{
 const p=pageParse(await f.page());exportFixture={page:p,detail:await detail('001'),missing:await detail('4'),unlinked:await detail('9')};assert.deepEqual(p.items.map(x=>x.product_source_id),['001','1','2','3','4','9']);assert.deepEqual(p.counts,{scope:'exact_staging_product_ids',product_ids:'6',known_product_ids:'5',stock_observation_ids:'5',known_without_observation:'1',observation_without_product:'1',invalid_product_ids:'1',invalid_stock_ids:'1'});
 assert.equal(p.items.find(x=>x.product_source_id==='4').observation.state,'missing');assert.equal(p.items.find(x=>x.product_source_id==='9').product.binding_state,'missing_staging');
 const first=pageParse(await f.page({p_limit:2}),2);assert.equal(first.next_cursor,'1');const next=pageParse(await f.page({p_limit:2,p_after:'1'}),2,'1');assert.deepEqual(next.items.map(x=>x.product_source_id),['2','3']);
 assert.equal(pageParse(await f.page({p_query:'%'})).items.length,0);assert.deepEqual(pageParse(await f.page({p_query:'C001'})).items.map(x=>x.product_source_id),['001']);
});
test('087 explicit zero/negative/null/absent/numeric-string-invalid remain separate; no unit or native balance comparison',async()=>{
 const zero=await detail('001');assert.deepEqual(zero.item.observation.warehouse.physical,{state:'value',value:'0'});assert.equal(zero.item.observation.warehouse.virtual.value,'-0.125');assert.equal(zero.lexical_precision_certified,false);assert.equal(zero.units_compared,false);assert.equal(zero.reconciled,false);assert.equal(zero.warehouse.record.active,false);
 const absent=(await detail('1')).item.observation;assert.equal(absent.physical_total.state,'null');assert.equal(absent.virtual_total.state,'absent');assert.equal(absent.warehouse.state,'absent');assert.equal(absent.warehouse.physical.state,'absent');
 const invalid=(await detail('2')).item.observation;assert.equal(invalid.physical_total.state,'invalid');assert.equal(invalid.warehouse.physical.state,'null');assert.deepEqual(invalid.issues,['OBSERVED_NUMBER_INVALID']);
 const duplicate=(await detail('3')).item.observation;assert.equal(duplicate.warehouse.state,'invalid');assert.deepEqual(duplicate.issues,['WAREHOUSE_DUPLICATE']);assert.equal(duplicate.warehouse.physical.state,'absent');
});
test('087 sources over bounds, duplicate/invalid warehouse IDs and damaged hashes never manufacture a quantity',async()=>{
 for(const[id,payload,issue]of[['20',{produto:{id:'20'},depositos:Array.from({length:1001},(_,i)=>({id:String(i+1)}))},'WAREHOUSE_LIST_INVALID'],['21',{produto:{id:'21'},depositos:[{id:9007199254740992,saldoFisico:10}]},'WAREHOUSE_ID_INVALID'],['22',{produto:{id:'22'},extra:'x'.repeat(131072)},'STOCK_SOURCE_TOO_LARGE'],['23',{produto:{id:'wrong'},saldoFisicoTotal:10},'STOCK_SOURCE_INVALID']]){await f.stageRaw('stock_balances',id,payload);const v=(await detail(id)).item.observation;assert.ok(v.issues.includes(issue));assert.equal(v.warehouse.physical.state,'absent');}
 await f.db.query("update origin_sync.raw_record set version_hash=repeat('a',64)where entity='stock_balances'and source_id='001'");try{assert.equal((await detail('001')).item.observation.state,'invalid');}finally{await f.stageRaw('stock_balances','001',{produto:{id:'001'},saldoFisicoTotal:0,depositos:[]});}
});
test('087 existing086 binding stays readable after source changed/missing and native inactive; absent binding is not inferred',async()=>{
 const before=await detail('001');await f.stage('007',{descricao:'Novo nome observado',situacao:1});let changed=await detail('001');assert.equal(changed.warehouse.source_state,'changed');assert.equal(changed.warehouse.record.active,false);assert.equal(changed.warehouse.binding_source_hash,before.warehouse.binding_source_hash);
 await f.db.query("delete from origin_sync.raw_record where entity='warehouses'and source_id='007'");changed=await detail('001');assert.equal(changed.warehouse.source_state,'missing');assert.equal(changed.warehouse.source,null);await fails(()=>f.page({p_warehouse_source_id:'7'}),'P0002');
});
test('087 SQL→HTTP→DTO uses exact actors/IDs, works in read-only transaction and changes no rows',async()=>{
 const before=await f.allRows();await f.db.exec('begin read only');try{const route=parseStockObservationsRoute(new Request('https://erp.invalid/v1/estoque-origin-observado/9?warehouse_source_id=007'));const v=await executeStockObservationsRoute(route,{userId:f.users.admin,rpc:f.rpc});assert.equal(v.item.product_source_id,'9');assert.equal(v.item.observation.physical_total.value,'1.123456789012345');assert.equal(v.can_import_balance,false);}finally{await f.db.exec('rollback');}assert.deepEqual(await f.allRows(),before);
});

test('087 current product binding can change independently while stored stock observation remains byte-identical',async()=>{
 await f.db.exec("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products'and source_id='001'");
 await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$1,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='products'and source_id='001'",[f.product.id]);
 await f.db.query('update erp_catalog.record set human_edited=false where id=$1',[f.product.id]);
 const original=await detail('001');assert.equal(original.item.product.binding_state,'current');assert.equal(original.item.product.record_id,f.product.id);
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:f.product.id,p_expected_version:1,p_command_id:randomUUID(),p_data:{name:'Nome humano atual',unit:'CX',kind:'P',format:'S',price:'3.1234567891'}});
 const changed=await detail('001');assert.equal(changed.item.product.binding_state,'needs_review');assert.equal(changed.item.product.record_unit,'CX');assert.equal(changed.units_compared,false);assert.deepEqual(changed.item.observation,original.item.observation);
 const before=await f.allRows();await f.page();await detail('001');assert.deepEqual(await f.allRows(),before);
});
