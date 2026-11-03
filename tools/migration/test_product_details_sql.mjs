import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {catalogRoute,catalogOperation,catalogResponse} from '../../workers/erp-api/src/catalog.mjs';

let db,legacy,legacyInput,baselineBodies,baselineMutate;
const users={};const sqlCode=code=>error=>error.code===code;
const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0].v;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{
 return await value(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) v`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));
}finally{await db.exec('reset role');}}
const save=(data,record=null,command=randomUUID(),user=users.admin)=>rpc('erp_catalog_save',{p_user_id:user,p_entity:'products',p_id:record?.id??null,p_expected_version:record?.version??0,p_command_id:command,p_data:data});
const get=record=>rpc('erp_catalog_get',{p_user_id:users.admin,p_entity:'products',p_id:record.id});
const list=(args={},user=users.admin)=>rpc('erp_catalog_product_list',{p_user_id:user,...args});
async function source(id,extra={}){
 const payload={nome:`Produto origem ${id}`,codigo:id,situacao:'A',unidade:'UN',tipo:'P',formato:'S',preco:10,tributacao:{ncm:'LEGACY8'},gtin:'LEGACYGTIN',...extra};
 const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('products','product_test',$1,$2,$3)on conflict(entity,source_id)do update set payload=excluded.payload,version_hash=excluded.version_hash,version=origin_sync.raw_record.version+1",[id,JSON.stringify(payload),hash]);
 return{source_id:id,source_hash:hash};
}
const importRows=(items,dry=false,command=randomUUID())=>rpc('erp_catalog_import_origin',{p_user_id:users.admin,p_entity:'products',p_items:items,p_command_id:command,p_dry_run:dry});
async function http(path='',method='GET',body,rawRpc=rpc){
 const url=new URL(`https://api.example.test/v1/cadastros/products${path}`),route=catalogRoute(url.pathname);
 const op=await catalogOperation(new Request(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),route,url.searchParams);
 return catalogResponse(await rawRpc(op.rpc,{p_user_id:users.admin,...op.args}),route,op);
}
const extras={brand:'Marca sintética',condition:'refurbished',production:'third_party',net_weight:'0.000001',gross_weight:'999999999999.999999',
 width:'0',height:'1.123456',depth:'2',dimension_unit:'mm',volumes:'0',items_per_box:'999999',gtin_tax:'SEM GTIN',stock_min:'1.000001',stock_max:'2.000001',
 location:'Rua A / prateleira 2',cest:'0123456',origin:'0',additional_info:'Informação complementar\nSem efeitos operacionais'};
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0009_erp_stock','0011_catalog_stock_lock_order','0013_catalog_import_review'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','estoque','vendas','fiscal','financeiro','consulta']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('product_test')");
 legacyInput={data:{name:'Produto legado sintético',ncm:'LEGACY8',gtin:'LEGACYGTIN',price:'1.2345'},command:randomUUID()};legacy=await save(legacyInput.data,null,legacyInput.command);
 baselineBodies=await value("select jsonb_object_agg(oid::regprocedure::text,prosrc)v from pg_proc where proname in('erp_catalog_import_origin','map_origin','import_changes','import_review_plan','erp_catalog_import_apply')");
 baselineMutate=await value("select prosrc v from pg_proc where oid='erp_catalog.mutate(uuid,text,uuid,integer,uuid,jsonb,boolean,boolean)'::regprocedure");
 await db.exec(await readFile(new URL('../../supabase/migrations/202610160023_product_details.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());

test('023 stores nullable metadata with exact decimal and integer strings, without inferred origin/defaults',async()=>{
 const created=await save({name:'Produto completo',ncm:'00000000',gtin:'12345678',...extras});const row=created.record;
 for(const key of ['net_weight','gross_weight','height','stock_min','stock_max'])assert.equal(row[key],extras[key]);
 assert.equal(row.width,'0.000000');assert.equal(row.depth,'2.000000');assert.equal(row.volumes,'0');assert.equal(row.items_per_box,'999999');assert.equal(row.origin,'0');
 assert.deepEqual((await http(`/${row.id}`)).record,row);
 const blank=(await save({name:'Sem presunção'})).record;for(const key of Object.keys(extras))assert.equal(blank[key],null);
 const before=await value('select jsonb_build_array((select count(*) from erp_stock.movement),(select count(*) from erp_stock.entry),(select count(*) from erp_stock.balance))v');
 await save({stock_min:'999999999998.000001',stock_max:'999999999999.999999'},blank);
 assert.deepEqual(await value('select jsonb_build_array((select count(*) from erp_stock.movement),(select count(*) from erp_stock.entry),(select count(*) from erp_stock.balance))v'),before);
});
test('023 validates numeric bounds and exact precision without silent rounding or numeric JSON',async()=>{
 for(const key of ['net_weight','gross_weight','width','height','depth','stock_min','stock_max'])for(const bad of ['-1','1e2','NaN','01','0.0000001','1000000000000','1,25','',1])
  await assert.rejects(()=>save({name:'Inválido',[key]:bad}),sqlCode('22023'));
 for(const key of ['volumes','items_per_box'])for(const bad of ['-1','1000000','0.1','01','1e2','',2])await assert.rejects(()=>save({name:'Inválido',[key]:bad}),sqlCode('22023'));
 for(const [key,bad]of [['origin','9'],['condition','broken'],['production','imported'],['dimension_unit','km'],['cest','123456'],['gtin_tax','123456789'],['gtin_tax','abc'],['additional_info','a'.repeat(2001)],['brand','a'.repeat(101)]])await assert.rejects(()=>save({name:'Inválido',[key]:bad}),sqlCode('22023'));
 for(const gtin_tax of ['12345678','123456789012','1234567890123','12345678901234','SEM GTIN'])assert.equal((await save({name:'GTIN sintético',gtin_tax})).record.gtin_tax,gtin_tax);
 const valid=(await save({name:'Zero exato',stock_min:'0',stock_max:'0',additional_info:'\nTexto\n'})).record;assert.equal((await http(`/${valid.id}`)).record.additional_info,'\nTexto\n');
});
test('023 stock min/max validates merged partial patches and preserves CAS, rollback and no-op audit',async()=>{
 let row=(await save({name:'Faixa',stock_min:'1',stock_max:'2'})).record;
 const before=await value('select count(*)::integer v from erp_catalog.audit where record_id=$1',[row.id]);
 await assert.rejects(()=>save({stock_min:'2.000001'},row),sqlCode('22023'));assert.equal((await get(row)).record.version,row.version);
 const same=await save({stock_min:'1.000000'},row);assert.equal(same.record.version,row.version);assert.equal(await value('select count(*)::integer v from erp_catalog.audit where record_id=$1',[row.id]),before);
 row=(await save({stock_max:null},row)).record;row=(await save({stock_min:'999999999999.999999'},row)).record;
 await assert.rejects(()=>save({location:'Posição'}, {...row,version:row.version-1}),sqlCode('40001'));
 assert.equal(row.stock_max,null);assert.equal(row.stock_min,'999999999999.999999');
});
test('023 legacy fields and pre-migration command replay stay historical; new manual identifiers are strict only when changed',async()=>{
 const replay=await save(legacyInput.data,null,legacyInput.command);assert.deepEqual(replay,{...legacy,replayed:true});
 const projected=await http('','POST',{command_id:legacyInput.command,data:legacyInput.data});assert.equal(projected.record.ncm,'LEGACY8');assert.equal(projected.record.gtin,'LEGACYGTIN');assert.equal(projected.record.brand,null);
 let row=(await get(legacy.record)).record;row=(await save({brand:'Local',ncm:'LEGACY8',gtin:'LEGACYGTIN'},row)).record;assert.equal(row.brand,'Local');
 await assert.rejects(()=>save({ncm:'OTHER'},row),sqlCode('22023'));await assert.rejects(()=>save({gtin:'OTHER'},row),sqlCode('22023'));
 row=(await save({ncm:'12345678',gtin:'SEM GTIN'},row)).record;assert.equal(row.ncm,'12345678');
 await assert.rejects(()=>save({name:'Novo inválido',ncm:'LEGACY8'}),sqlCode('22023'));await assert.rejects(()=>save({name:'Novo inválido',gtin:'LEGACYGTIN'}),sqlCode('22023'));
 assert.deepEqual((await save(legacyInput.data,null,legacyInput.command)).record,legacy.record);
 assert.equal(await value('select result v from erp_catalog.command where command_id=$1',[legacyInput.command]).then(x=>x.record.brand),undefined);
});
test('023 import mapping is unchanged and cannot erase local metadata or overwrite human edits',async()=>{
 const item=await source('local-preservation');const initial=await importRows([item]);let row=(await get({id:initial.items[0].record_id})).record;
 assert.equal(row.ncm,'LEGACY8');assert.equal(row.brand,null);row=(await save({...extras},row)).record;
 const changed=await source('local-preservation',{nome:'Nome novo da origem',marca:'Não mapear',pesoLiquido:500,tributacao:{ncm:'12345678'}});
 const preview=await rpc('erp_catalog_import_preview',{p_user_id:users.admin,p_entity:'products',p_items:[changed]});
 assert.equal(preview.items[0].action,'pending_human_review');assert.equal(preview.items[0].changes.some(x=>Object.hasOwn(extras,x.field)),false);
 const applied=await rpc('erp_catalog_import_apply',{p_user_id:users.admin,p_entity:'products',p_items:[changed],p_command_id:randomUUID(),p_preview_hash:preview.preview_hash});
 assert.equal(applied.items[0].action,'pending_human_review');const kept=(await get(row)).record;for(const key of Object.keys(extras))assert.equal(kept[key],row[key]);assert.equal(kept.name,row.name);
 const candidate=await value('select candidate v from erp_catalog.origin where record_id=$1',[row.id]);assert.equal(candidate.data.brand,undefined);assert.equal(candidate.data.net_weight,undefined);
 // Defensive helper contract: omitted new fields remain preserved even when the canonical mapper applies old fields.
 const current=await value('select erp_catalog.data($1)v',[row.id]);const oldFields=Object.fromEntries(Object.entries(current).filter(([key])=>!Object.hasOwn(extras,key)));
 await db.query("select erp_catalog.write_fields($1,'products',$2::jsonb)",[row.id,JSON.stringify({...oldFields,name:'Irrelevant metadata'})]);
 const preserved=(await get(row)).record;for(const key of Object.keys(extras))assert.equal(preserved[key],row[key]);
 assert.deepEqual(await value("select jsonb_object_agg(oid::regprocedure::text,prosrc)v from pg_proc where proname in('erp_catalog_import_origin','map_origin','import_changes','import_review_plan','erp_catalog_import_apply')"),baselineBodies);
});
test('023 untouched source still updates, review hash invalidates after local edit, and old source imports remain readable',async()=>{
 const item=await source('untouched'),first=await importRows([item]),id=first.items[0].record_id;
 const changed=await source('untouched',{nome:'Atualizado pela fonte'});assert.equal((await importRows([changed])).items[0].action,'update');assert.equal((await get({id})).record.name,'Atualizado pela fonte');
 const newer=await source('untouched',{nome:'Revisão da fonte'});const preview=await rpc('erp_catalog_import_preview',{p_user_id:users.admin,p_entity:'products',p_items:[newer]});
 await save({location:'Endereço local'},(await get({id})).record);
 await assert.rejects(()=>rpc('erp_catalog_import_apply',{p_user_id:users.admin,p_entity:'products',p_items:[newer],p_command_id:randomUUID(),p_preview_hash:preview.preview_hash}),sqlCode('40001'));
 assert.equal((await get({id})).record.location,'Endereço local');
});
test('023 product filters are intersected, literal/case-insensitive and paginated by UUID; q includes GTIN',async()=>{
 const rows=[];for(const data of [{name:'Filtro A',brand:'Marca % alfa',kind:'P',format:'S',ncm:'12345678',gtin:'1234567890123'},{name:'Filtro B',brand:'marca beta',kind:'S',format:'S'},{name:'Filtro C',brand:'Outra',kind:'P',format:'V'}])rows.push((await save(data)).record);
 assert.deepEqual((await list({p_brand:'%'})).items.map(r=>r.id),[rows[0].id]);
 assert.deepEqual((await list({p_query:'Filtro',p_brand:'MARCA',p_kind:'P',p_format:'S',p_ncm_presence:'present'})).items.map(r=>r.id),[rows[0].id]);
 assert.deepEqual((await list({p_query:'1234567890123'})).items.map(r=>r.id),[rows[0].id]);
 assert.deepEqual((await http('?brand=MARCA&kind=S&ncm_presence=missing')).items.map(r=>r.id),[rows[1].id]);
 const first=await list({p_query:'Filtro',p_limit:2}),second=await list({p_query:'Filtro',p_limit:2,p_after:first.next_cursor});
 assert.equal(first.has_more,true);assert.equal(second.has_more,false);assert.deepEqual([...first.items,...second.items].map(r=>r.id).sort(),rows.map(r=>r.id).sort());
 for(const args of [{p_kind:'bad'},{p_format:'bad'},{p_ncm_presence:'bad'},{p_brand:'\n'},{p_query:'\n'},{p_limit:101}])await assert.rejects(()=>list(args),sqlCode('22023'));
});
test('023 permissions/grants remain aligned and metadata cannot bypass inventory unit lock',async()=>{
 const row=(await save({name:'Permissões',kind:'P',format:'S',unit:'UN'})).record;
 for(const role of ['vendas','fiscal','financeiro','consulta'])await assert.rejects(()=>save({brand:'Negado'},row,randomUUID(),users[role]),sqlCode('42501'));
 const updated=(await save({brand:'Estoque autorizado'},row,randomUUID(),users.estoque)).record;assert.equal(updated.brand,'Estoque autorizado');
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.estoque]);await assert.rejects(()=>list({},users.estoque),sqlCode('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.estoque]);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);try{await assert.rejects(()=>value('select public.erp_catalog_product_list($1)v',[users.admin]),sqlCode('42501'));}finally{await db.exec('reset role');}}
 const warehouse=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'warehouses',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Depósito sintético'}})).record;
 await rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_reason:'Entrada sintética',p_reference:null,p_occurred_on:'2026-10-16',p_items:[{product_id:row.id,warehouse_id:warehouse.id,quantity:'1',expected_version:0}]});
 await assert.rejects(()=>save({unit:'KG'},updated),sqlCode('40001'));
 assert.equal((await save({stock_min:'100',stock_max:'200'},updated)).record.stock_min,'100.000000');
 assert.equal(await value('select quantity::text v from erp_stock.balance where product_id=$1',[row.id]),'1.000000');
});
test('023 HTTP validates new fields and filters, rejects malformed upstream decimals and preserves legacy projections',async()=>{
 for(const [key,bad]of [['net_weight','0.0000001'],['volumes',3],['origin','9'],['gtin_tax','123'],['cest','1234']])await assert.rejects(()=>http('','POST',{command_id:randomUUID(),data:{name:'Invalido',[key]:bad}}),e=>e.status===400);
 for(const query of ['?kind=P&kind=S','?format=X','?ncm_presence=unknown','?brand=%00'])await assert.rejects(()=>http(query),e=>e.status===400);
 const created=await http('','POST',{command_id:randomUUID(),data:{name:'Produto HTTP',...extras}});
 const path=`/${created.record.id}`;
 for(const mutate of [v=>v.record.net_weight=0.1,v=>v.record.stock_min='3.000000',v=>v.record.volumes='01',v=>v.record.origin='9',v=>v.record.gtin_tax='ABC',v=>v.record.id=randomUUID()]){
  const raw=structuredClone(created);mutate(raw);await assert.rejects(()=>http(path,'GET',undefined,async()=>raw),e=>e.status===502);
 }
 assert.equal((await http(`/${created.record.id.toUpperCase()}`)).record.id,created.record.id);
});
test('023 mutation keeps the original lock/replay/CAS behavior apart from identifier checks after replay',async()=>{
 const current=await value("select prosrc v from pg_proc where oid='erp_catalog.mutate(uuid,text,uuid,integer,uuid,jsonb,boolean,boolean)'::regprocedure");
 const withoutChecks=current.replace(/^    if p_entity='products' then perform erp_catalog.validate_product_identifiers\(v_data,null\); end if;\n/m,'')
  .replace(/^      if p_entity='products' then perform erp_catalog.validate_product_identifiers\(v_data,erp_catalog.data\(v_id\)\); end if;\n/m,'');
 assert.equal(withoutChecks,baselineMutate);
});
