import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {catalogImportRoute,catalogImportMethods,catalogImportOperation,catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';
let db;const users={};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code=expected=>error=>error.code===expected;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function rpc(name,args){await db.exec('SET ROLE service_role');try{const keys=Object.keys(args);return await scalar(`SELECT public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(',')}) value`,keys.map(key=>args[key]!==null&&typeof args[key]==='object'?JSON.stringify(args[key]):args[key]));}finally{await db.exec('RESET ROLE');}}
const preview=(entity,items,user=users.admin)=>rpc('erp_catalog_import_preview',{p_user_id:user,p_entity:entity,p_items:items});
const apply=(entity,items,plan,command=randomUUID(),user=users.admin)=>rpc('erp_catalog_import_apply',{p_user_id:user,p_entity:entity,p_items:items,p_command_id:command,p_preview_hash:plan.preview_hash});
const list=(entity,options={})=>rpc('erp_catalog_import_sources',{p_user_id:users.admin,p_entity:entity,...options});
async function source(entity,id,payload){const versionHash=hash(payload);await db.query(`INSERT INTO origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)VALUES($1,$1,$2,$3::jsonb,$4)
 ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1`,[entity,id,JSON.stringify(payload),versionHash]);return {source_id:id,source_hash:versionHash};}
const contact=name=>({nome:name,codigo:'0001',tipo:'J',situacao:'A',numeroDocumento:'SYNTHETIC_SECRET_DOCUMENT',ie:'PRIVATE_IE',email:'private@example.invalid',telefone:'PRIVATE_PHONE',endereco:{geral:{endereco:'PRIVATE_STREET',municipio:'Piracicaba',uf:'SP'}},apiToken:'NEVER_EXPOSE_RAW'});
const product=name=>({nome:name,codigo:'0002',situacao:'A',unidade:'UN',tipo:'P',formato:'S',preco:'12.3400',tributacao:{ncm:'12345678'},private:'NEVER_EXPOSE_RAW'});
before(async()=>{db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);');
 for(const file of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0009_erp_stock','0011_catalog_stock_lock_order','0013_catalog_import_review'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${file}.sql`,import.meta.url),'utf8'));
 await db.exec("INSERT INTO origin_sync.resource_state(resource)VALUES('contacts'),('products');");
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal']){users[role]=randomUUID();await db.query('INSERT INTO auth.users VALUES($1)',[users[role]]);await db.query('INSERT INTO erp_access.membership(user_id,role)VALUES($1,$2)',[users[role],role]);}
});
after(async()=>db?.close());
test('import administration and its command ledger are private and membership is required on all RPCs',async()=>{
 for(const role of ['anon','authenticated','service_role']){assert.equal(await scalar("SELECT has_table_privilege($1,'erp_catalog.import_review_command','SELECT,INSERT,UPDATE,DELETE') value",[role]),false);}
 assert.equal(await scalar("SELECT relrowsecurity value FROM pg_class WHERE oid='erp_catalog.import_review_command'::regclass"),true);
 for(const role of ['anon','authenticated']){await db.exec(`SET ROLE ${role}`);try{await assert.rejects(()=>scalar("SELECT public.erp_catalog_import_sources($1,'contacts') value",[users.admin]),code('42501'));}finally{await db.exec('RESET ROLE');}}
 for(const role of ['consulta','vendas','financeiro','estoque','fiscal'])await assert.rejects(()=>rpc('erp_catalog_import_sources',{p_user_id:users[role],p_entity:'contacts'}),code('42501'));
});
test('source list pagination uses exact IDs, search is literal and no raw/fiscal values escape',async()=>{
 for(const id of ['a-001','a-002','a-003'])await source('contacts',id,contact(`Sintético ${id}`));
 const first=await list('contacts',{p_limit:2});assert.equal(first.items.length,2);assert.equal(first.has_more,true);assert.equal(first.next_cursor,'a-002');
 const next=await list('contacts',{p_limit:2,p_after:first.next_cursor});assert.equal(next.items[0].source_id,'a-003');assert.equal(next.has_more,false);
 assert.equal(first.items[0].action,'create');assert.equal(first.items[0].changes,undefined);
 assert.doesNotMatch(JSON.stringify(first),/SECRET_DOCUMENT|PRIVATE_|NEVER_EXPOSE|apiToken/);
 assert.equal((await list('contacts',{p_query:'a-002'})).items.length,1);assert.equal((await list('contacts',{p_query:'%'})).items.length,0);
 await assert.rejects(()=>list('contacts',{p_limit:101}),code('22023'));
});
test('preview is read-only and explicit apply persists a native record with immutable source; replay has no duplicates',async()=>{
 const item=await source('contacts','create-review',contact('Contato novo sintético'));
 const before=await scalar('SELECT count(*)::int value FROM erp_catalog.record');const plan=await preview('contacts',[item]);
 assert.equal(plan.items[0].action,'create');assert.equal(plan.dry_run,true);assert.equal(await scalar('SELECT count(*)::int value FROM erp_catalog.record'),before);
 assert.ok(plan.items[0].changes.some(change=>change.field==='document'&&change.redacted&&change.before===null&&change.after===null));
 assert.doesNotMatch(JSON.stringify(plan),/SECRET_DOCUMENT|PRIVATE_|NEVER_EXPOSE|apiToken|private@example/);
 const command=randomUUID();const result=await apply('contacts',[item],plan,command);assert.equal(result.items[0].action,'create');assert.equal(result.dry_run,false);
 assert.deepEqual(await apply('contacts',[item],plan,command),{...result,replayed:true});assert.equal(await scalar('SELECT count(*)::int value FROM erp_catalog.record'),before+1);
 const local=await scalar('SELECT erp_catalog.dto($1) value',[result.items[0].record_id]);assert.equal(local.document,'SYNTHETIC_SECRET_DOCUMENT');assert.equal(local.source.source_id,item.source_id);
 const altered={...plan,preview_hash:'0'.repeat(64)};await assert.rejects(()=>apply('contacts',[item],altered,command),code('40001'));
 await db.query('UPDATE erp_access.membership SET active=false WHERE user_id=$1',[users.admin]);await assert.rejects(()=>apply('contacts',[item],plan,command),code('42501'));await db.query('UPDATE erp_access.membership SET active=true WHERE user_id=$1',[users.admin]);
});
test('source changes after preview and local changes after preview invalidate apply atomically',async()=>{
 let item=await source('products','changed-review',product('Produto sintético'));
 let plan=await preview('products',[item]);await source('products',item.source_id,{...product('Origem atualizada'),preco:'14'});
 await assert.rejects(()=>apply('products',[item],plan),code('40001'));assert.equal(await scalar('SELECT count(*)::int value FROM erp_catalog.origin WHERE source_id=$1',[item.source_id]),0);
 item=await source('products',item.source_id,product('Produto sintético'));plan=await preview('products',[item]);const created=await apply('products',[item],plan);const id=created.items[0].record_id;
 item=await source('products',item.source_id,product('Nova origem'));plan=await preview('products',[item]);assert.equal(plan.items[0].action,'update');
 await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:id,p_expected_version:1,p_command_id:randomUUID(),p_data:{name:'Edição humana'}});
 await assert.rejects(()=>apply('products',[item],plan),code('40001'));assert.equal(await scalar('SELECT name value FROM erp_catalog.record WHERE id=$1',[id]),'Edição humana');
 const fresh=await preview('products',[item]);assert.equal(fresh.items[0].action,'pending_human_review');await apply('products',[item],fresh);
 assert.equal(await scalar('SELECT name value FROM erp_catalog.record WHERE id=$1',[id]),'Edição humana');
 const retained=await preview('products',[item]);assert.equal(retained.items[0].candidate_retained,true);assert.equal(retained.items[0].action,'pending_human_review');assert.equal(retained.items[0].operation_action,'unchanged');
});
test('unit/kind changes for products with stock are retained as candidates under migration 011',async()=>{
 let item=await source('products','locked-review',product('Produto com estoque sintético'));const created=await apply('products',[item],await preview('products',[item]));const id=created.items[0].record_id;
 const depot=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'warehouses',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Depósito sintético'}})).record.id;
 await rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2024-10-15',p_reason:'Estoque sintético',p_items:[{product_id:id,warehouse_id:depot,quantity:'1',expected_version:0}]});
 item=await source('products',item.source_id,{...product('Produto com nova unidade'),unidade:'KG'});const plan=await preview('products',[item]);assert.equal(plan.items[0].stock_locked,true);assert.equal(plan.items[0].action,'pending_human_review');await apply('products',[item],plan);
 assert.equal(await scalar('SELECT unit value FROM erp_catalog.product WHERE record_id=$1',[id]),'UN');assert.equal(await scalar('SELECT count(*)::int value FROM erp_stock.entry WHERE product_id=$1',[id]),1);
});
test('invalid/deleted sources are explicit and selected batches cannot silently match names or codes',async()=>{
 const invalid=await source('contacts','invalid-review',{nome:'Bad',situacao:'?'});const deleted=await source('contacts','deleted-review',{...contact('Nome repetido'),situacao:'E'});
 const twin=await source('contacts','twin-review',contact('Nome repetido'));const items=[invalid,deleted,twin];const plan=await preview('contacts',items);
 assert.deepEqual(plan.items.map(row=>row.action),['invalid_source','create','create']);const result=await apply('contacts',items,plan);
 assert.equal(result.items[0].action,'invalid_source');assert.notEqual(result.items[1].record_id,result.items[2].record_id);
 assert.equal(await scalar('SELECT active value FROM erp_catalog.record WHERE id=$1',[result.items[1].record_id]),false);
 assert.equal((await preview('contacts',[{source_id:'missing'}])).items[0].action,'missing_source');
 for(const bad of [[{source_id:twin.source_id}],[twin,twin],[{...twin,raw:true}]])await assert.rejects(()=>apply('contacts',bad,plan),code('22023'));
});
test('HTTP import contract executes list, preview and apply against real SQL with protected field projection',async()=>{
 const api=async(path,method='GET',data)=>{
  const url=new URL(`https://api.example.test${path}`),route=catalogImportRoute(url.pathname);
  const operation=await catalogImportOperation(new Request(url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined}),route,url.searchParams);
  const result=await rpc(operation.rpc,{p_user_id:users.admin,...operation.args});
  return catalogImportResponse({...result,raw:'PRIVATE',items:result.items.map(row=>({...row,raw:'PRIVATE'}))},route,operation);
 };
 const item=await source('contacts','http-review',contact('Contato para API'));
 const listed=await api('/v1/importacao-cadastros/contacts?limit=25&q=http-review');assert.equal(listed.items[0].source_id,item.source_id);assert.equal(listed.raw,undefined);assert.equal(listed.items[0].raw,undefined);
 const plan=await api('/v1/importacao-cadastros/contacts/preview','POST',{items:[item]});assert.equal(plan.items[0].action,'create');assert.doesNotMatch(JSON.stringify(plan),/SECRET_DOCUMENT|PRIVATE|NEVER_EXPOSE/);
 const result=await api('/v1/importacao-cadastros/contacts/apply','POST',{items:[item],preview_hash:plan.preview_hash,command_id:randomUUID()});assert.equal(result.items[0].action,'create');assert.equal(typeof result.items[0].source_version,'string');
});
test('HTTP rejects malformed selections, forged metadata, duplicate filters and unmasked protected responses',async()=>{
 const path='/v1/importacao-cadastros/products/preview',route=catalogImportRoute(path);
 const item=await source('products','http-rejected',product('Produto API'));
 for(const data of [{items:[]},{items:[item,item]},{items:[{...item,source_id:1}]},{items:[{...item,source_hash:'bad'}]},{items:[item],actor:users.admin},{items:[{...item,raw:{}}]}]){
  const req=new Request(`https://api.example.test${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  await assert.rejects(()=>catalogImportOperation(req,route,new URLSearchParams()),error=>error.status===400);
 }
 for(const query of ['limit=101','limit=25&limit=25','raw=true','after=','q=%00']){
  const url=new URL(`https://api.example.test/v1/importacao-cadastros/products?${query}`);
  await assert.rejects(()=>catalogImportOperation(new Request(url),catalogImportRoute(url.pathname),url.searchParams),error=>error.status===400);
 }
 assert.equal(catalogImportRoute('/v1/importacao-cadastros/warehouses'),null);assert.deepEqual(catalogImportMethods(route),['POST']);
 const contactItem=await source('contacts','redact-check',contact('Contato protegido'));const plan=await preview('contacts',[contactItem]);const unsafe=structuredClone(plan);unsafe.items[0].changes.find(row=>row.field==='document').after='LEAK';
 assert.throws(()=>catalogImportResponse(unsafe,{entity:'contacts',action:'preview'},{type:'preview',args:{p_items:[contactItem]}}),error=>error.status===502);
});
