// Real SQL, roles and trigger chain through commercial guards; all records are synthetic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentMirrorFixture, DOCUMENT_MIRROR_MIGRATION } from './helpers/document-mirror-fixture.mjs';
import { documentMirrorRecord, documentMirrorSummary } from '../../../packages/erp-domain/src/document-mirror.mjs';

let f;
before(async()=>{f=await documentMirrorFixture({guards:true});});
after(async()=>{if(f)await f.close();});
const payload=(id,total='12.34')=>({id,numero:50,data:'2026-10-22',total,situacao:{id:999,nome:'Situação observada'},contato:{id:900,nome:'Nome da fonte'},itens:[{produto:{id:800},descricaoDetalhada:'Descrição detalhada da fonte',quantidade:'1',valor:total,valorTotal:total}]});
async function detail(id,kind='sales_orders'){
 const uuid=await f.scalar('select document_id v from erp_documents.origin_mirror where entity=$1 and source_id=$2',[kind,id]);
 const raw=(await f.rpc('erp_document_get',{p_user_id:f.users.admin,p_kind:kind,p_id:uuid})).document;
 return {raw,parsed:documentMirrorRecord(raw,kind)};
}
async function sourceCount(table,id){return f.scalar(`select count(*)::integer v from erp_document_mirror.${table} where source_id=$1`,[id]);}
async function bindContact(id){
 const record=await f.catalog('contacts',{name:'Cadastro vinculado '+id});await f.stage('contacts',id,{id,nome:'Fonte '+id});
 await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts'and source_id=$1",[id]);
 await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='contacts'and source_id=$1",[id,record.id]);return record;
}

test('bootstrap uses bounded persistent cursor and refuses to run without a configured technical actor',async()=>{
 const b=await documentMirrorFixture({migrate:false});try{
  for(let i=1;i<=4;i++)await b.stage(['sales_orders','sales_proposals','purchase_orders','service_orders'][i-1],String(i),payload(i));
  await b.migrate(DOCUMENT_MIRROR_MIGRATION);await b.migrate('202610220007_document_mirror_guards.sql');
  assert.deepEqual(await b.documentProject(2),{state:'actor_not_configured',processed:0,applied:0,failed:0,seeded:0,pending:4});
  await b.db.query("insert into auth.users(id,banned_until)values($1,'infinity')",[b.actorId]);await b.db.query('insert into erp_document_mirror.settings(actor_id)values($1)',[b.actorId]);
  for(const remaining of[2,0]){const result=await b.documentProject(2);assert.equal(result.seeded,2);assert.equal(result.processed,2);assert.equal(result.applied,2);assert.equal(result.failed,0);assert.equal(result.pending,remaining);}
  assert.equal((await b.documentProject()).processed,0);assert.equal(await b.scalar('select count(*)::integer v from erp_documents.origin_mirror'),4);
  assert.equal(await b.scalar('select sum(last_number)::integer v from erp_documents.numbering'),0);
  await assert.rejects(()=>b.documentProject(101),e=>e.code==='22023');
 }finally{await b.close();}
});

test('all four kinds keep observed values, IDs, unknown status and purchase supplier identity',async()=>{
 const contact=await bindContact('900');const beforeNumber=await f.scalar('select sum(last_number)::integer v from erp_documents.numbering');
 for(const[k,kind]of ['sales_orders','sales_proposals','purchase_orders','service_orders'].entries()){
  const p=payload(100+k);if(kind==='purchase_orders'){p.fornecedor={...p.contato,nome:'Fornecedor observado',endereco:{municipio:'Cidade',uf:'SP'}};delete p.contato;}
  if(kind==='service_orders'){p.pecas=p.itens;p.servicos=[];delete p.itens;}
  await f.stage(kind,String(100+k),p);
 }
 const result=await f.documentProject();assert.equal(result.applied,4);assert.equal(result.failed,0);
 for(const[k,kind]of ['sales_orders','sales_proposals','purchase_orders','service_orders'].entries()){
  const{parsed}=await detail(String(100+k),kind);assert.equal(parsed.status,'source_unknown');assert.equal(parsed.mirror.source_status,'999');
  assert.equal(parsed.contact_id,contact.id);assert.equal(parsed.number,'50');assert.equal(parsed.total,'12.34');assert.equal(parsed.mirror.effects.stock,'unobservable');
  assert.equal(parsed.items[0].description,'Descrição detalhada da fonte');assert.equal(parsed.created_at,parsed.updated_at);
  const list=await f.rpc('erp_document_list',{p_user_id:f.users.admin,p_kind:kind,p_origin:'origin'});documentMirrorSummary(list.items[0],kind);
 }
 assert.equal((await detail('102','purchase_orders')).parsed.contact_snapshot.name,'Fornecedor observado');
 assert.equal(await f.scalar('select sum(last_number)::integer v from erp_documents.numbering'),beforeNumber);
 for(const table of['erp_stock.movement','erp_stock.document_posting','erp_finance.title','erp_finance.document_posting','erp_documents.item_cost_applied','erp_fiscal_invoices.invoice_order'])assert.equal(await f.scalar(`select count(*)::integer v from ${table}`),0,table);
});

test('exact decimals outside native column scale remain exact in detail and are never rounded or zero-filled',async()=>{
 await f.stage('sales_orders','201',payload(201,'123.4567'));
 await f.db.query(`update origin_sync.raw_record set payload=jsonb_set(payload,'{itens,0,quantidade}','"1.1234567"')||'{"itens":[{"quantidade":"1.1234567","valor":"0.12345678901234567890123456789","valorTotal":"123.4567"}]}'::jsonb,
  version=version+1,version_hash=repeat('b',64) where entity='sales_orders'and source_id='201'`);
 assert.equal((await f.documentProject()).failed,0);
 const{parsed}=await detail('201');assert.equal(parsed.total,'123.4567');assert.equal(parsed.items[0].quantity,'1.1234567');assert.equal(parsed.items[0].unit_price,'0.12345678901234567890123456789');assert.equal(parsed.items[0].total,'123.4567');
 assert.deepEqual((await f.db.query('select i.quantity::text,i.unit_price::text,i.total::text,d.total::text document_total from erp_documents.item i join erp_documents.document d on d.id=i.document_id where d.id=$1',[parsed.id])).rows[0],{quantity:null,unit_price:null,total:null,document_total:null});
 await f.stage('sales_orders','202',{id:202,itens:[{quantidade:0,valor:0}]});assert.equal((await f.documentProject()).failed,0);
 const missing=(await detail('202')).parsed;assert.equal(missing.number,null);assert.equal(missing.total,null);assert.equal(missing.date,null);assert.equal(missing.items[0].quantity,'0');assert.equal(missing.items[0].unit_price,'0');assert.equal(missing.items[0].total,null);
 for(const value of['1e999999999999','-1','NaN','1e-1000'])assert.equal(await f.scalar('select erp_document_mirror.decimal(to_jsonb($1::text),30,30)v',[value]),null);
});

test('service parts and services preserve separate source paths and observed hours without inventing quantity',async()=>{
 const p={id:301,numero:50,total:'20.0001',dataSaida:'2026-10-23',equipamento:'Motor',numeroSerieEquipamento:'SERIE',tecnico:{nome:'Técnico'},descricaoProblema:'Relato',observacoesInternas:'Interna',
  pecas:[{produto:{id:800,descricao:'Peça'},quantidade:'2.123456789',valorUnitario:'5.123456789'}],servicos:[{produto:{id:801,descricao:'Serviço'},horas:'1.23456789',valorUnitario:'10.123456789',valorTotal:'15.123456789'}],_brufap_service_capture:{profile:'origin-service-json-v1',tokens:[]}};
 await f.stage('service_orders','301',p);assert.equal((await f.documentProject()).failed,0);
 const{parsed}=await detail('301','service_orders');assert.equal(parsed.items.length,2);assert.equal(parsed.items[0].source_path,'/pecas/0');assert.equal(parsed.items[1].source_path,'/servicos/0');
 assert.equal(parsed.items[1].quantity,null);assert.equal(parsed.items[1].hours,'1.23456789');assert.equal(parsed.items[1].total,'15.123456789');assert.equal(parsed.ship_date,'2026-10-23');assert.equal(parsed.equipment,'Motor');assert.equal(parsed.serial_number,'SERIE');assert.equal(parsed.technician,'Técnico');assert.equal(parsed.defect,'Relato');assert.equal(parsed.internal_notes,'Interna');
 assert.equal(parsed.mirror.issues.includes('PRICE_CAPTURE_UNAVAILABLE'),false);
});

test('A-B-A versions append immutable revisions; replay and stale versions cannot overwrite the latest state',async()=>{
 for(const[version,total]of[[1,'10'],[2,'20'],[3,'10']]){await f.stage('sales_orders','401',payload(401,total),{version});assert.equal((await f.documentProject()).applied,1);}
 const first=(await detail('401')).parsed,items=first.items.map(x=>x.id);assert.equal(first.version,3);assert.equal(await sourceCount('revision','401'),3);
 await f.stage('sales_orders','401',payload(401,'10'),{version:3,seen:'2026-10-23T12:00:00Z'});assert.equal((await f.documentProject()).applied,0);
 assert.equal((await detail('401')).parsed.version,3);assert.equal(new Date((await detail('401')).parsed.mirror.observed_at).toISOString(),'2026-10-23T12:00:00.000Z');
 await f.stage('sales_orders','401',payload(401,'20'),{version:2});assert.equal((await f.documentProject()).applied,0);assert.equal((await detail('401')).parsed.total,'10');assert.deepEqual((await detail('401')).parsed.items.map(x=>x.id),items);
 await f.stage('sales_orders','401',payload(401,'999'),{version:3});assert.equal((await f.documentProject()).processed,0);assert.equal((await detail('401')).parsed.total,'10');
 assert.equal(await f.scalar("select count(*)::integer v from erp_document_mirror.issue where source_id='401'and code='VERSION_HASH_CONFLICT'and resolved_at is null"),1);
 for(const table of['source_version','revision'])await assert.rejects(()=>f.db.query(`delete from erp_document_mirror.${table} where source_id='401'`),e=>e.code==='55000');
});

test('lexical evidence appended after payload in the same source version is available to first projection',async()=>{
 await f.stage('sales_orders','501','{"id":501,"numero":50,"total":1.23456789012345,"itens":[{"quantidade":1,"valor":1.23456789012345,"valorTotal":1.23456789012345}]}');
 await f.db.query(`update origin_sync.raw_record set price_capture=jsonb_build_object('profile','origin-sales-price-json-v1','source_hash',version_hash,'source_version',version::text,'tokens','[{"path":"/itens/0/valor","lexeme":"1.23456789012345"}]'::jsonb)where entity='sales_orders'and source_id='501'`);
 assert.equal(await sourceCount('source_version','501'),1);assert.equal(await sourceCount('price_observation','501'),1);assert.equal((await f.documentProject()).failed,0);
 const{parsed}=await detail('501');assert.equal(parsed.items[0].unit_price,'1.23456789012345');assert.equal(parsed.mirror.issues.includes('PRICE_CAPTURE_UNAVAILABLE'),false);
 assert.equal(await f.scalar("select price_capture is null v from erp_document_mirror.source_version where source_id='501'"),true);
 await assert.rejects(()=>f.db.query("delete from erp_document_mirror.price_observation where source_id='501'"),e=>e.code==='55000');
});

test('late lexical evidence reprojects the same source version once and appends its own immutable revision',async()=>{
 await f.stage('sales_orders','502','{"id":502,"numero":50,"total":2.34567890123456,"itens":[{"quantidade":1,"valor":2.34567890123456,"valorTotal":2.34567890123456}]}');
 assert.equal((await f.documentProject()).applied,1);const before=(await detail('502')).parsed;
 assert.equal(before.mirror.issues.includes('PRICE_CAPTURE_UNAVAILABLE'),true);
 await f.db.query(`update origin_sync.raw_record set price_capture=jsonb_build_object('profile','origin-sales-price-json-v1','source_hash',version_hash,'source_version',version::text,'capture_id',$1::text,'observed_at',clock_timestamp(),'tokens','[{"path":"/itens/0/valor","lexeme":"2.34567890123456"}]'::jsonb)where entity='sales_orders'and source_id='502'`,[randomUUID()]);
 assert.equal((await f.documentProject()).applied,1);const after=(await detail('502')).parsed;
 assert.equal(after.mirror.source_version,'1');assert.equal(after.mirror.source_hash,before.mirror.source_hash);assert.equal(after.version,2);assert.equal(after.mirror.issues.includes('PRICE_CAPTURE_UNAVAILABLE'),false);assert.equal(after.items[0].id,before.items[0].id);assert.equal(after.items[0].unit_price,'2.34567890123456');
 assert.equal(await sourceCount('source_version','502'),1);assert.equal(await sourceCount('revision','502'),2);
 assert.equal(await f.scalar("select count(*)::integer v from erp_document_mirror.issue where source_id='502'and code='PRICE_CAPTURE_UNAVAILABLE'and resolved_at is null"),0);
 await f.db.query("update origin_sync.raw_record set price_capture=price_capture||jsonb_build_object('capture_id',$1::text,'observed_at',clock_timestamp())where entity='sales_orders'and source_id='502'",[randomUUID()]);
 assert.equal((await f.documentProject()).applied,0);assert.equal(await sourceCount('price_observation','502'),1);assert.equal(await sourceCount('revision','502'),2);
});

test('a later exact catalog binding automatically requeues its dependent source without losing observation freshness',async()=>{
 const p={...payload(503),contato:{id:950,nome:'Contato ainda não vinculado'}};
 await f.stage('sales_orders','503',p);assert.equal((await f.documentProject()).applied,1);const before=(await detail('503')).parsed;assert.equal(before.contact_id,null);
 await f.stage('sales_orders','503',p,{version:1,seen:'2026-10-24T12:00:00Z'});assert.equal((await f.documentProject()).applied,0);
 const linked=await bindContact('950');assert.equal(await sourceCount('pending','503'),1);assert.equal((await f.documentProject()).applied,1);
 const after=(await detail('503')).parsed;assert.equal(after.contact_id,linked.id);assert.equal(after.mirror.source_version,'1');assert.equal(after.version,2);assert.equal(after.contact_snapshot.name,'Contato ainda não vinculado');assert.equal(after.mirror.issues.includes('CONTACT_UNLINKED'),false);
 assert.equal(new Date(after.mirror.observed_at).toISOString(),'2026-10-24T12:00:00.000Z');assert.equal(await sourceCount('revision','503'),2);
});

test('legacy adoption requires original import audit and no later edit or dependent, keeping original evidence',async()=>{
 const contact=await f.catalog('contacts',{name:'Legado sintético'});
 async function legacy(source,{version=1,audit=true,dependent=false}={}){
  const id=randomUUID(),command=randomUUID();
  await f.db.query("insert into erp_documents.document(id,kind,number,status,contact_id,contact_snapshot,body,total,version,created_by,updated_by)values($1,'sales_proposals',$2,'draft',$3,'{}','{}',1,$4,$5,$5)",[id,Number(source),contact.id,version,f.users.admin]);
  await f.db.query("insert into erp_documents.command(command_id,actor,request_hash,result)values($1,$2,repeat('a',64),'{\"policy\":\"origin-open-proposal-v2\"}')",[command,f.users.admin]);
  await f.db.query("insert into erp_documents.origin_import_origin(entity,source_id,document_id,command_id,evidence)values('sales_proposals',$1,$2,$3,'{\"policy\":\"origin-open-proposal-v2\"}')",[source,id,command]);
  if(audit)await f.db.query("insert into erp_documents.audit(actor,command_id,document_id,action,after_data)values($1,$2,$3,'origin_import_proposal_v2','{}')",[f.users.admin,command,id]);
  if(dependent)await f.db.query("insert into erp_documents.document(kind,number,status,contact_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)values('sales_orders',$1,'draft',$2,'{}','{}',1,$3,$4,$4)",[Number(source),contact.id,id,f.users.admin]);
  await f.stage('sales_proposals',source,payload(source));return{id,command};
 }
 const good=await legacy('601'),edited=await legacy('602',{version:2}),unproven=await legacy('603',{audit:false}),converted=await legacy('604',{dependent:true});
 const evidence=await f.scalar('select evidence v from erp_documents.origin_import_origin where document_id=$1',[good.id]);
 const result=await f.documentProject();assert.equal(result.applied,1);assert.equal(result.failed,3);
 const{parsed}=await detail('601','sales_proposals');assert.equal(parsed.id,good.id);assert.equal(parsed.version,2);assert.equal(parsed.origin,'origin');
 assert.deepEqual(await f.scalar('select evidence v from erp_documents.origin_import_origin where document_id=$1',[good.id]),evidence);
 const revision=await f.scalar("select before_document v from erp_document_mirror.revision where source_id='601'");assert.equal(revision.origin,'brufap');assert.equal(revision.version,1);
 for(const{id}of[edited,unproven,converted])assert.equal(await f.scalar('select origin v from erp_documents.document where id=$1',[id]),'brufap');
 assert.equal(await f.scalar("select count(*)::integer v from erp_document_mirror.issue where code='LEGACY_REVIEW_REQUIRED'and source_id in('602','603','604')"),3);
});

test('one failed source rolls back its writes while other sources project; corrected retry resolves failure',async()=>{
 await f.stage('sales_orders','701',payload(701));await f.stage('sales_orders','702',payload(702));
 await f.db.exec("create function erp_document_mirror.test_failure()returns trigger language plpgsql as $$begin if new.source_id='701'then raise exception 'synthetic failure';end if;return new;end$$; create trigger test_failure before insert on erp_documents.origin_mirror for each row execute function erp_document_mirror.test_failure()");
 const count=await f.scalar('select count(*)::integer v from erp_documents.document'),result=await f.documentProject();assert.equal(result.failed,1);assert.equal(result.applied,1);assert.equal(await f.scalar('select count(*)::integer v from erp_documents.document'),count+1);assert.equal(await sourceCount('revision','701'),0);
 await f.db.exec('drop trigger test_failure on erp_documents.origin_mirror;drop function erp_document_mirror.test_failure()');
 await f.db.query("update erp_document_mirror.pending set retry_at='-infinity'where source_id='701'");assert.equal((await f.documentProject()).applied,1);
 assert.equal(await f.scalar("select count(*)::integer v from erp_document_mirror.issue where source_id='701'and code='PROJECTION_FAILED'and resolved_at is null"),0);
});

test('projector is service-only; private observations and native effects are not writer capabilities',async()=>{
 for(const role of['anon','authenticated']){
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_document_mirror_project(integer)','EXECUTE')v",[role]),false);
  assert.equal(await f.scalar("select has_table_privilege($1,'erp_document_mirror.source_version','SELECT')v",[role]),false);
 }
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_document_mirror_project(integer)','EXECUTE')v"),true);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_document_mirror.apply(erp_document_mirror.source_version,uuid,timestamptz)','EXECUTE')v"),false);
 assert.equal(await f.scalar("select has_table_privilege('erp_document_mirror_writer','erp_stock.movement','INSERT')v"),false);
 assert.equal(await f.scalar("select has_table_privilege('erp_document_mirror_writer','erp_finance.title','INSERT')v"),false);
});

test('migrations and projector work with a non-superuser migration owner; writer CREATE is only temporary',async()=>{
 const b=await documentMirrorFixture({migrate:false});try{
  // Membership supplies ownership of the existing fixture objects, but SUPERUSER is not inherited.
  // This models the managed PostgreSQL migration role instead of silently relying on fixture superpowers.
  await b.db.exec('create role migration_owner nologin createrole bypassrls;grant postgres,service_role to migration_owner;set role migration_owner');
  assert.equal(await b.scalar('select rolsuper v from pg_roles where rolname=current_user'),false);
  await b.migrate(DOCUMENT_MIRROR_MIGRATION);await b.migrate('202610220007_document_mirror_guards.sql');
  assert.equal(await b.scalar("select has_schema_privilege('erp_document_mirror_writer','erp_document_mirror','CREATE')v"),false);
  assert.equal(await b.scalar("select has_schema_privilege('erp_document_mirror_writer','erp_document_mirror','USAGE')v"),true);
  await b.db.query("insert into auth.users(id,banned_until)values($1,'infinity')",[b.actorId]);await b.db.query('insert into erp_document_mirror.settings(actor_id)values($1)',[b.actorId]);
  await b.stage('sales_orders','801',payload(801));const result=await b.documentProject();assert.equal(result.failed,0);assert.equal(result.applied,1);
  assert.equal(await b.scalar("select pg_get_userbyid(proowner) v from pg_proc where oid='public.erp_document_mirror_project(integer)'::regprocedure"),'migration_owner');
  assert.equal(await b.scalar("select has_table_privilege('erp_document_mirror_writer','erp_finance.title','INSERT')v"),false);
 }finally{await b.db.exec('rollback;reset role');await b.close();}
});
