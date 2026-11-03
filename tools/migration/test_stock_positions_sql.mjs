import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseStockPositionsRoute,executeStockPositionsRoute,stockPositionsMethods} from '../../workers/erp-api/src/stock-positions.mjs';
let db,legacy,legacyInput,legacyWarehouse,baseline;
const users={},errorIs=code=>error=>error.code===code;
const value=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await value(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')})v`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const create=(entity,data)=>rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data}).then(v=>v.record);
const product=(data={})=>create('products',{name:'Produto sintético '+randomUUID(),unit:'UN',kind:'P',format:'S',...data});
const warehouse=()=>create('warehouses',{name:'Depósito sintético '+randomUUID()});
const positions=(args={},user=users.admin)=>rpc('erp_stock_positions',{p_user_id:user,...args});
const post=(p,w,quantity,version=0,extra={})=>rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2024-10-15',p_reason:'Estoque sintético',p_items:[{product_id:p.id,warehouse_id:w.id,quantity,expected_version:version}],...extra});
const route=path=>parseStockPositionsRoute(new Request(`https://api.example.test/v1/posicoes-estoque${path}`));
const http=(path='',rawRpc=rpc,userId=users.admin)=>executeStockPositionsRoute(route(path),{userId,rpc:rawRpc});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0017_document_finance','0018_document_stock','0023_product_details'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','consulta','estoque','vendas','fiscal','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 legacy=await product({format:'E'});legacyWarehouse=await warehouse();legacyInput={p_command_id:randomUUID()};await post(legacy,legacyWarehouse,'3',0,legacyInput);
 baseline=await value("select prosrc v from pg_proc where oid='erp_stock.post(uuid,uuid,text,date,text,text,jsonb,uuid)'::regprocedure");
 await db.exec(await readFile(new URL('../../supabase/migrations/202610160025_stock_positions.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('025 distinguishes absent opening from recorded zero and leaves all operational tables untouched by reads',async()=>{
 const p=await product({code:'UNKNOWN025'}),w=await warehouse();
 let row=(await http('?q=UNKNOWN025')).items[0];assert.equal(row.global.state,'no_movements');assert.equal(row.global.quantity,null);assert.equal(row.global.recorded_warehouse_count,'0');assert.equal(row.limit_state,'no_movements');
 row=(await http(`?q=UNKNOWN025&warehouse_id=${w.id}`)).items[0];assert.equal(row.selected_position.quantity,null);assert.equal(row.selected_position.version,0);
 const movement=await post(p,w,'0.000001');await rpc('erp_stock_reverse',{p_user_id:users.admin,p_movement_id:movement.movement.id,p_command_id:randomUUID(),p_occurred_on:'2024-10-16',p_reason:'Estorno sintético',p_versions:[{product_id:p.id,warehouse_id:w.id,expected_version:1}]});
 const counts=()=>value('select jsonb_build_array((select count(*) from erp_stock.entry),(select count(*) from erp_stock.command),(select count(*) from erp_catalog.audit))v');const before=await counts();
 row=(await http(`?q=UNKNOWN025&warehouse_id=${w.id}`)).items[0];assert.equal(row.global.state,'recorded');assert.equal(row.global.quantity,'0.000000');assert.equal(row.selected_position.quantity,'0.000000');assert.equal(row.selected_position.version,2);assert.equal(row.limit_state,'not_configured');assert.deepEqual(await counts(),before);
});
test('025 minimum/maximum compare the global product sum including archived warehouses, never selected position',async()=>{
 const p=await product({code:'GLOBAL025',stock_min:'6',stock_max:'7'}),a=await warehouse(),b=await warehouse(),c=await warehouse();await post(p,a,'2');await post(p,b,'5');
 await db.query('update erp_catalog.record set active=false where id=$1',[b.id]);
 let row=(await http(`?q=GLOBAL025&warehouse_id=${a.id}&limit_state=within`)).items[0];assert.equal(row.global.quantity,'7.000000');assert.equal(row.selected_position.quantity,'2.000000');assert.equal(row.global.recorded_warehouse_count,'2');
 assert.equal((await http(`?q=GLOBAL025&warehouse_id=${a.id}&limit_state=below_min`)).items.length,0);
 row=(await http(`?q=GLOBAL025&warehouse_id=${c.id}&stock_state=no_movements&limit_state=within`)).items[0];assert.equal(row.selected_position.quantity,null);assert.equal(row.global.quantity,'7.000000');
 await post(p,a,'0.000001',1);assert.equal((await http('?q=GLOBAL025')).items[0].limit_state,'above_max');
 await post(p,a,'-2.000001',2,{p_kind:'issue'});assert.equal((await http('?q=GLOBAL025')).items[0].limit_state,'below_min');
});
test('025 exact sums may exceed one balance numeric18,6 and do not combine distinct products or units',async()=>{
 const p=await product({code:'EXACT025',unit:'KG'}),a=await warehouse(),b=await warehouse();await post(p,a,'999999999999.999999');await post(p,b,'999999999999.999999');
 const other=await product({code:'EXACT025-UN',unit:'UN'});await post(other,a,'0.000001');
 const page=await http('?q=EXACT025');assert.equal(page.items.find(v=>v.product.id===p.id).global.quantity,'1999999999999.999998');assert.equal(page.items.find(v=>v.product.id===other.id).global.quantity,'0.000001');assert.equal(Object.hasOwn(page,'total_quantity'),false);
});
test('025 unit/ledger inconsistencies produce review_required without a usable quantity or limit classification',async()=>{
 const p=await product({code:'REVIEW025',stock_min:'1'}),w=await warehouse();await post(p,w,'2');
 await db.query("update erp_stock.balance set unit='KG' where product_id=$1",[p.id]);
 let row=(await http(`?q=REVIEW025&stock_state=review_required&warehouse_id=${w.id}`)).items[0];assert.equal(row.global.quantity,null);assert.equal(row.selected_position.quantity,null);assert.equal(row.limit_state,'review_required');
 await db.query("update erp_stock.balance set unit='UN',quantity=3 where product_id=$1",[p.id]);row=(await http('?q=REVIEW025')).items[0];assert.equal(row.global.state,'review_required');
 const blank=await product({code:'REVIEW025-ORPHAN'});await db.query("insert into erp_stock.balance(product_id,warehouse_id,quantity,unit)values($1,$2,0,'UN')",[blank.id,w.id]);
 row=(await http('?q=REVIEW025-ORPHAN')).items[0];assert.equal(row.global.state,'review_required');assert.equal(row.global.recorded_warehouse_count,'0');
});
test('025 filters are literal AND predicates with UUID cursor, including GTIN and archived products',async()=>{
 const rows=[];for(let i=0;i<3;i++)rows.push(await product({name:`Filtros025 ${i}`,code:`FILTER025-${i}`,brand:i===0?'Marca % A':'Marca B',location:'Prat_1',gtin:'12345678'}));
 await db.query('update erp_catalog.record set active=false where id=$1',[rows[2].id]);
 assert.deepEqual((await http('?q=Filtros025&brand=%25&location=_&active=true')).items.map(r=>r.product.id),[rows[0].id]);
 assert.equal((await http('?q=12345678&brand=Marca')).items.length,3);
 const first=await http('?q=Filtros025&limit=2'),second=await http(`?q=Filtros025&limit=2&after=${first.next_cursor}`);assert.equal(first.has_more,true);assert.equal(second.has_more,false);assert.deepEqual([...first.items,...second.items].map(r=>r.product.id).sort(),rows.map(r=>r.id).sort());
 assert.deepEqual((await http('?q=Filtros025&active=false')).items.map(r=>r.product.id),[rows[2].id]);
 const service=await product({name:'SERVICO025',kind:'S'});assert.equal((await http('?q=SERVICO025')).items.length,0);assert.ok(service.id);
});
test('025 stock access does not widen catalog warehouse access and revocation/service-only ACL are enforced',async()=>{
 for(const role of ['admin','consulta','estoque','vendas','fiscal']){assert.equal((await positions({},users[role])).scope,'stock_positions');assert.equal((await http('/depositos',rpc,users[role])).scope,'stock_warehouse_options');}
 await assert.rejects(()=>positions({},users.financeiro),errorIs('42501'));await assert.rejects(()=>http('/depositos',rpc,users.financeiro),errorIs('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);await assert.rejects(()=>positions({},users.vendas),errorIs('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(()=>value('select public.erp_stock_positions($1)v',[users.admin]),errorIs('42501'));}finally{await db.exec('reset role');}}
 const first=await http('/depositos?limit=2'),next=await http(`/depositos?limit=2&after=${first.next_cursor}`);assert.equal(first.items.length,2);assert.ok(next.items.every(v=>v.id>first.next_cursor));assert.deepEqual(Object.keys(first.items[0]).sort(),['active','id','name']);
});
test('025 blocks fresh E/V manual entries after locked product read, but preserves prior replay, reversal and history',async()=>{
 assert.equal((await post(legacy,legacyWarehouse,'3',0,legacyInput)).replayed,true);
 const counts=await value('select count(*)::int v from erp_stock.command');
 for(const format of ['E','V']){const p=await product({format}),w=await warehouse();await assert.rejects(()=>post(p,w,'1'),errorIs('22023'));assert.equal(await value('select count(*)::int v from erp_stock.balance where product_id=$1',[p.id]),0);}
 assert.equal(await value('select count(*)::int v from erp_stock.command'),counts);
 const original=(await post(legacy,legacyWarehouse,'3',0,legacyInput)).movement;
 const reversed=await rpc('erp_stock_reverse',{p_user_id:users.admin,p_movement_id:original.id,p_command_id:randomUUID(),p_occurred_on:'2024-10-16',p_reason:'Reverter legado sintético',p_versions:[{product_id:legacy.id,warehouse_id:legacyWarehouse.id,expected_version:1}]});assert.equal(reversed.movement.items[0].balance_after,'0.000000');
 assert.equal((await post(legacy,legacyWarehouse,'3',0,legacyInput)).movement.id,original.id);
 assert.equal((await positions()).items.find(r=>r.product.id===legacy.id)?.product.format,'E');
 const body=await value("select prosrc v from pg_proc where oid='erp_stock.post(uuid,uuid,text,date,text,text,jsonb,uuid)'::regprocedure");
 const previous=body.replace('v_kind text;v_format text;v_active boolean;','v_kind text;v_active boolean;').replace('select p.unit,p.kind,p.format,r.active into v_unit,v_kind,v_format,v_active','select p.unit,p.kind,r.active into v_unit,v_kind,v_active').replace("    if p_kind<>'reversal' and v_format in('E','V') then raise exception 'erp_stock_composition_unsupported' using errcode='22023'; end if;\n",'');assert.equal(previous,baseline);
});
test('025 HTTP rejects invalid filters/methods and mismatched or imprecise upstream fields',async()=>{
 for(const path of ['?limit=101','?limit=01','?q=x&q=y','?active=1','?warehouse_id=x','?stock_state=zero','?limit_state=available','?brand=%00','?unknown=1'])assert.throws(()=>route(path),e=>e.status===400);
 assert.throws(()=>parseStockPositionsRoute(new Request('https://api.example.test/v1/posicoes-estoque',{method:'POST'})),e=>e.status===405);assert.equal(stockPositionsMethods('/v1/estoque/posicoes'),null);
 await assert.rejects(()=>positions({p_stock_state:'zero'}),errorIs('22023'));await assert.rejects(()=>positions({p_warehouse_id:randomUUID()}),errorIs('P0002'));
 const p=await product({code:'DTO025',stock_min:'1'}),w=await warehouse();await post(p,w,'2');const path=`?q=DTO025&warehouse_id=${w.id}`,raw=await positions({p_query:'DTO025',p_warehouse_id:w.id});
 for(const mutate of [v=>v.items[0].global.quantity=2,v=>v.items[0].global.quantity='2.0000001',v=>v.items[0].limit_state='below_min',v=>v.items[0].selected_position.warehouse_id=randomUUID(),v=>v.warehouse.id=randomUUID(),v=>v.items[0].global.recorded_warehouse_count='0',v=>v.items.push(v.items[0]),v=>v.items[0].product.stock_min='2e0']){const bad=structuredClone(raw);mutate(bad);await assert.rejects(()=>http(path,async()=>bad),e=>e.status===502);}
 const extra=structuredClone(raw);extra.items[0].product.price='999.0000';extra.items[0].actor=randomUUID();const projected=await http(path,async()=>extra);assert.equal(Object.hasOwn(projected.items[0].product,'price'),false);assert.equal(Object.hasOwn(projected.items[0],'actor'),false);
});
test('025 retains the018 document engine and prevents manual reversal of a document-linked movement',async()=>{
 const p=await product({code:'DOC025'}),w=await warehouse(),contact=await create('contacts',{name:'Fornecedor sintético'});
 let doc=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'purchase_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2024-10-15',contact_id:contact.id,warehouse_id:w.id,items:[{product_id:p.id,description:'Item sintético',unit:'UN',quantity:'2.000001',unit_price:'1'}]}})).document;
 doc=(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'purchase_orders',p_id:doc.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_status:'in_progress',p_reason:'Aprovação sintética'})).document;
 const scope={p_user_id:users.admin,p_kind:'purchase_orders',p_document_id:doc.id,p_expected_version:doc.version},meta={p_occurred_on:'2024-10-15',p_reason:'Recebimento sintético'};
 const preview=(await rpc('erp_document_stock_preview',{...scope,...meta})).preview;
 const posted=await rpc('erp_document_stock_post',{...scope,...meta,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_ignored_item_ids:[]});
 assert.equal((await http('?q=DOC025')).items[0].global.quantity,'2.000001');
 await assert.rejects(()=>rpc('erp_stock_reverse',{p_user_id:users.admin,p_movement_id:posted.movement.id,p_command_id:randomUUID(),p_occurred_on:'2024-10-16',p_reason:'Não pode contornar vínculo',p_versions:[{product_id:p.id,warehouse_id:w.id,expected_version:1}]}),errorIs('40001'));
 const reverseScope={...scope,p_expected_version:posted.document_version,p_posting_id:posted.posting.id,p_posting_version:posted.posting.version,...meta};
 const reversePreview=(await rpc('erp_document_stock_reverse_preview',reverseScope)).preview;
 await rpc('erp_document_stock_reverse',{...reverseScope,p_command_id:randomUUID(),p_preview_hash:reversePreview.preview_hash});
 assert.equal((await http('?q=DOC025')).items[0].global.quantity,'0.000000');
});
