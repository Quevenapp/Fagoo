import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fiscalMirrorFixture, FISCAL_MIRROR_MIGRATIONS } from './helpers/fiscal-mirror-fixture.mjs';
import { listPage, originDetail } from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { inspectArchivedXml } from '../../../packages/fiscal-xml/src/archive.mjs';
import { buildAccessKey } from '../../../packages/fiscal-core/src/identity.mjs';
import { invoice, event, identity, keyFor } from '../../origin-sync/test/xml-fixtures.mjs';

// Only synthetic data. Full production migration chain, including stock mirror 001.
let f;
const sha=x=>createHash('sha256').update(x).digest('hex');
const key=(n,model='55')=>buildAccessKey({...identity(model),number:String(n)});
const payload=(id,extra={})=>({id,numero:String(id),serie:1,tipo:1,situacao:5,dataEmissao:'2026-10-22 08:00:00',valorNota:10,
 contato:{id:'101',nome:'Cliente sintético',numeroDocumento:'12345678000195',endereco:{uf:'SP'}},...extra});
const put=(id,extra={},options={})=>f.stage('nfe',id,payload(id,extra),options);
const detail=(id,user=f.users.admin)=>f.rpc('erp_fiscal_invoice_origin_get',{p_user_id:user,p_entity:'nfe',p_source_id:id});
const report=(user=f.users.admin)=>f.rpc('erp_fiscal_report_invoices',{p_user_id:user,p_report:'billing',p_from:'2026-10-01',p_to:'2026-10-31',p_model:null});
const dto=(p)=>listPage(p,{origin:p.origin,model:p.model,direction:p.direction,page:p.page,limit:p.limit,order:p.order});
async function isolated(body){await f.db.exec('begin');try{await body();}finally{await f.db.exec('rollback');}}
async function missing(id,user=f.users.admin){await f.db.exec('savepoint missing');try{
 await assert.rejects(f.scalar("select public.erp_fiscal_invoice_origin_get($1,'nfe',$2)v",[user,id]),e=>e.code==='P0002');
 }finally{await f.db.exec('rollback to missing');}}
async function archive(id,n,{model='55',environment='1',events=false,seen='2026-10-22T12:00:00Z'}={}){
 const source=randomUUID(),revision=randomUUID(),entity=model==='55'?'nfe':'nfce',accessKey=key(n,model);
 await f.db.query('insert into origin_fiscal.source(id,entity,source_id,access_key)values($1,$2,$3,$4)',[source,entity,id,accessKey]);
 const originals=[invoice(model),...(events?[event(model)]:[])];let xmlId;
 const records=originals.map(original=>{
  const bytes=new TextEncoder().encode(original.replaceAll(keyFor(model),accessKey).replace('<nNF>1</nNF>',`<nNF>${n}</nNF>`)
   .replace(`<cDV>${keyFor(model)[43]}</cDV>`,`<cDV>${accessKey[43]}</cDV>`).replaceAll('<tpAmb>1</tpAmb>',`<tpAmb>${environment}</tpAmb>`));
  return {bytes,hash:sha(bytes),metadata:inspectArchivedXml(bytes,{key:accessKey,entity})};
 });
 await f.db.query("insert into origin_fiscal.revision(id,source,revision,manifest_hash,source_status)values($1,$2,1,$3,'5')",[revision,source,sha(records.map(r=>r.hash).join(''))]);
 for(const r of records){
  await f.db.query('insert into origin_fiscal.object(hash,size,metadata)values($1,$2,$3::jsonb)on conflict do nothing',[r.hash,r.bytes.length,JSON.stringify(r.metadata)]);
  const i=await f.scalar('insert into origin_fiscal.item(revision,object_hash)values($1,$2)returning id::text v',[revision,r.hash]);if(r.metadata.kind==='invoice')xmlId=i;
 }
 await f.db.query('update origin_fiscal.source set current_revision=$1,last_success_at=$3 where id=$2',[revision,source,seen]);
 return {source,revision,xmlId};
}
async function native(n,environment=null,contactId=null){
 return f.scalar(`insert into erp_fiscal_invoices.invoice(model,direction,issue_type,environment,status,series,number,access_key,protocol,nature_description,issue_date,crt,purpose,presence,final_consumer,
 recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,created_by,updated_by)
 values('55','1',$1,$2,8,1,$3,$4,'135260000000001','Venda sintética','2026-10-22','3','1','9',false,$5,'[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":"10.00"}',$6,$6)returning id::text v`,
 [environment?'N':'S',environment,n,key(n),JSON.stringify({name:'Cliente nativo',contact_id:contactId}),f.users.admin]);
}
async function contact(id,user){
 const sellerContact=await f.catalog('contacts',{name:'Vendedor '+id});
 const seller=await f.scalar('insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by)values($1,$2,$3,$3)returning id::text v',[sellerContact.id,user,f.users.admin]);
 const record=await f.catalog('contacts',{name:'Contato '+id});await f.stage('contacts',id,{id,nome:'Contato '+id});
 await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts'and source_id=$1",[id]);
 await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='contacts'and source_id=$1",[id,record.id]);
 await f.db.query('insert into erp_catalog.contact_profile(record_id,seller_id)values($1,$2)on conflict(record_id)do update set seller_id=excluded.seller_id',[record.id,seller]);return record.id;
}
test.before(async()=>{
 f=await fiscalMirrorFixture({migrate:false});
 await put('1',{chaveAcesso:key(1)});await put('2',{tipo:0});await f.stage('nfce','3',payload('3'));
 await f.migrate(FISCAL_MIRROR_MIGRATIONS[0]);
});
test.after(async()=>f?.close());

test('002 bounded snapshot bootstrap marks partial, isolates a failed item and retries without native writes',async()=>{
 assert.equal(await f.scalar('select count(*)::int v from erp_fiscal_mirror.current'),0);
 assert.equal(await f.scalar("select(erp_fiscal_mirror.coverage($1,'55','1')->>'partial')::boolean v",[f.users.admin]),true);
 await f.db.exec("create function erp_fiscal_mirror.test_fail()returns trigger language plpgsql as $$begin if new.source_id='1'then raise exception 'synthetic';end if;return new;end$$;create trigger mirror_test_failure before insert on erp_fiscal_mirror.observation for each row execute function erp_fiscal_mirror.test_fail()");
 assert.deepEqual(await f.fiscalProject(2),{processed:2,applied:1,xml_processed:0,failed:1,pending:2});
 assert.equal(await f.scalar("select count(*)::int v from erp_fiscal_mirror.observation where source_id='1'"),0);
 await f.db.exec("drop trigger mirror_test_failure on erp_fiscal_mirror.observation;drop function erp_fiscal_mirror.test_fail();update erp_fiscal_mirror.seed set retry_at='-infinity'");
 assert.deepEqual(await f.fiscalProject(),{processed:2,applied:2,xml_processed:0,failed:0,pending:0});
 assert.equal(await f.scalar("select resolved_at is not null v from erp_fiscal_mirror.issue where source_id='1'and code='PROJECTION_FAILED'"),true);
 await f.migrate(FISCAL_MIRROR_MIGRATIONS[1]);
 for(const [model,direction,id]of[['55','1','1'],['55','0','2'],['65','1','3']]){
  const p=dto(await f.fiscalList({p_model:model,p_direction:direction}));assert.equal(p.total_count,1);assert.equal(p.items[0].id,id);assert.equal(p.coverage.scope,'model_direction');
 }
 assert.equal(originDetail(await detail('1')).writable,false);
 for(const table of['erp_fiscal_invoices.invoice','erp_stock.movement','erp_stock.balance','erp_finance.title'])assert.equal(Number(await f.scalar(`select count(*)v from ${table}`)),0);
});

test('002 captures A B A, stale versions, hash conflicts, freshness and tombstones as immutable observations',()=>isolated(async()=>{
 await put('10');await put('10',{situacao:2});await put('10');
 assert.deepEqual((await f.db.query("select source_version::int,status_raw from erp_fiscal_mirror.observation where source_id='10'order by source_version")).rows,[{source_version:1,status_raw:'5'},{source_version:2,status_raw:'2'},{source_version:3,status_raw:'5'}]);
 await put('10',{situacao:9},{version:2});assert.equal((await detail('10')).status_raw,'5');
 await put('10',{situacao:9},{version:3});assert.equal((await detail('10')).status_raw,'5');
 assert.equal(await f.scalar("select count(*)::int v from erp_fiscal_mirror.issue where source_id='10'and code='VERSION_HASH_CONFLICT'"),2);
 await put('10',{}, {version:3,seen:'2026-10-23T15:00:00Z'});assert.equal(Date.parse((await detail('10')).observed_at),Date.parse('2026-10-23T15:00:00Z'));
 await put('10',{_brufap_source:{deleted:true}});await missing('10');
 assert.equal((await f.fiscalList({p_query:'10'})).total_count,0);await put('10');assert.equal((await detail('10')).status_raw,'5');
 assert.equal(await f.scalar("select count(*)::int v from erp_fiscal_mirror.status_change where source_id='10'"),5);
 await f.db.exec('savepoint immutable');await assert.rejects(f.db.exec("delete from erp_fiscal_mirror.observation where source_id='10'"),e=>e.code==='55000');await f.db.exec('rollback to immutable');
 await f.db.exec('savepoint immutable_status');await assert.rejects(f.db.exec("update erp_fiscal_mirror.status_change set status=status"),e=>e.code==='55000');await f.db.exec('rollback to immutable_status');
}));

test('003 key dedup prefers recent state, native production, and never lets homologation hide production',()=>isolated(async()=>{
 await put('20',{chaveAcesso:key(20)},{seen:'2026-10-21T12:00:00Z'});await put('21',{chaveAcesso:key(20),situacao:2});
 let p=dto(await f.fiscalList());assert.ok(!p.items.some(r=>r.id==='20'));assert.equal(p.items.find(r=>r.id==='21').status,3);
 assert.equal(p.coverage.duplicate_count,1);assert.equal((await report()).totals.notes,2,'cancelled duplicate is absent from billing');
 await put('22',{chaveAcesso:key(22)});await put('23',{chaveAcesso:key(22)},{seen:'2026-10-23T12:00:00Z'});
 await archive('22',22);await archive('23',22,{environment:'2'});
 p=dto(await f.fiscalList());assert.ok(p.items.some(r=>r.id==='22'));assert.ok(!p.items.some(r=>r.id==='23'));assert.equal(p.coverage.homologation_count,1);
 await put('24',{chaveAcesso:key(24)});await native(24);assert.ok(!(await f.fiscalList()).items.some(r=>r.id==='24'));
 await put('25',{chaveAcesso:key(25)});await native(25,'2');assert.ok((await f.fiscalList()).items.some(r=>r.id==='25'));
 await put('26',{chaveAcesso:key(26)});const importedHomolog=await native(26);
 await f.db.query("insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment)values($1,$2,'2')",[importedHomolog,sha('homolog-synthetic')]);
 assert.ok((await f.fiscalList()).items.some(r=>r.id==='26'));assert.equal(originDetail(await detail('26')).source_id,'26');
 const nativePage=dto(await f.fiscalList({p_origin:'brufap'}));assert.equal(nativePage.coverage,null);assert.ok(nativePage.items.every(i=>i.observed_at===null));
}));

test('002 XML cache follows source pointer, fallback by key, timestamp order and complete coverage',()=>isolated(async()=>{
 await put('30',{chaveAcesso:key(30)});const old=await archive('29',30,{events:true,seen:'2026-10-21T12:00:00Z'});
 let d=originDetail(await detail('30'));assert.equal(d.xml.id,old.xmlId);assert.equal(d.events.length,1);
 const newest=await archive('28',30,{seen:'2026-10-22T12:00:00Z'});d=originDetail(await detail('30'));assert.equal(d.xml.id,newest.xmlId);
 assert.equal(await f.scalar("select id::text v from erp_fiscal_mirror.xml_source('nfe','30',$1)",[key(30)]),newest.source);
 assert.equal(await f.scalar("select archive_source_id::text v from erp_fiscal_mirror.xml_info('nfe','30',$1)",[key(30)]),newest.source);
 await f.db.query('update origin_fiscal.source set last_success_at=$2 where id=$1',[old.source,'2026-10-23T12:00:00Z']);assert.equal((await detail('30')).xml.id,old.xmlId);
 const page=dto(await f.fiscalList({p_query:'30'}));assert.equal(page.items[0].protocol_present,true);assert.equal(page.items[0].event_count,1);
 assert.equal(page.coverage.visible_count,2,'coverage ignores user search');assert.equal(page.coverage.xml_count,1);assert.equal(page.coverage.missing_xml_count,1);
 await archive('1',1);assert.equal((await f.fiscalList()).coverage.partial,false);
 await f.db.exec('update erp_fiscal_mirror.xml_cache set environment=null');
 const unknownEnvironment=dto(await f.fiscalList());assert.equal(unknownEnvironment.coverage.xml_count,2);assert.equal(unknownEnvironment.coverage.missing_xml_count,0);assert.equal(unknownEnvironment.coverage.partial,false);
 await f.db.exec("insert into erp_fiscal_mirror.seed(entity,source_id)values('nfe','1')");assert.equal((await f.fiscalList()).coverage.partial,true);await f.fiscalProject();assert.equal((await f.fiscalList()).coverage.partial,false);
 await f.db.exec("insert into erp_fiscal_mirror.seed(entity,source_id)values('nfe','2'),('nfe','404')");assert.equal((await f.fiscalList()).coverage.partial,false,'entry and missing raw queues are outside outgoing coverage');await f.fiscalProject();
}));

test('003 current seller contact scope protects lists, direct detail, report totals and native lists',()=>isolated(async()=>{
 const own=await contact('101',f.users.consulta),foreign=await contact('102',f.users.fiscal);await f.preference('cadastros-contatos','contatos.acesso_vendedor',true);
 await put('40',{contato:{id:'101',nome:'Own'}});await put('41',{contato:{id:'102',nome:'Foreign'}});await put('42',{contato:{id:'999',nome:'Own'}});await f.stage('nfce','43',payload('43',{contato:null}));
 const page=dto(await f.fiscalList({p_user_id:f.users.consulta}));assert.ok(page.items.some(r=>r.id==='40'));assert.ok(!page.items.some(r=>['41','42'].includes(r.id)));
 for(const id of['41','42'])await missing(id,f.users.consulta);
 assert.equal((await f.fiscalList({p_user_id:f.users.consulta,p_model:'65'})).total_count,1,'only known contact consumer note remains');
 assert.equal((await report(f.users.consulta)).totals.notes,3);assert.equal((await report(f.users.fiscal)).totals.notes,1);
 await native(40,null,own);await native(41,null,foreign);
 const p=dto(await f.fiscalList({p_user_id:f.users.fiscal,p_origin:'brufap'}));assert.equal(p.total_count,1);assert.equal(p.items[0].number,41);
 const q=await f.rpc('erp_fiscal_report_difal',{p_user_id:f.users.consulta,p_from:'2026-10-01',p_to:'2026-10-31'});assert.ok(q.rows.every(r=>r.ref!=='nfe:41'&&r.ref!=='nfe:42'));
}));

test('003 preserves permission gates, missing values and closed mirror storage',async()=>{
 for(const role of['admin','consulta','fiscal'])dto(await f.fiscalList({p_user_id:f.users[role]}));
 for(const role of['vendas','estoque','financeiro','inactive'])await assert.rejects(f.fiscalList({p_user_id:f.users[role]}),e=>e.code==='42501');
 for(const role of['anon','authenticated','service_role']){
  for(const table of['current','observation','status_change','issue','xml_cache','seed','xml_seed','listing_rows'])assert.equal(await f.scalar("select has_table_privilege($1,$2,'select')v",[role,'erp_fiscal_mirror.'+table]),false);
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_fiscal_mirror_project(integer)','execute')v",[role]),role==='service_role');
 }
 await isolated(async()=>{await put('50',{valorNota:null,situacao:null});const p=dto(await f.fiscalList({p_query:'50'}));assert.equal(p.items[0].total_known,false);assert.equal(p.amount_unknown,1);assert.equal(p.coverage.partial,true);assert.equal(originDetail(await detail('50')).total_known,false);});
 await isolated(async()=>{await put('bad-id');assert.equal(await f.scalar("select count(*)::int v from erp_fiscal_mirror.issue where code='SOURCE_IDENTITY_INVALID'"),1);dto(await f.fiscalList());});
});

test('003 refuses changed predecessor before replacing functions',async()=>{
 const g=await fiscalMirrorFixture({migrate:false});try{
  await g.migrate(FISCAL_MIRROR_MIGRATIONS[0]);const original=await g.scalar("select pg_get_functiondef('public.erp_fiscal_invoice_origin_get(uuid,text,text)'::regprocedure)v");
  await g.db.exec(original.replace('declare r ','declare r /* synthetic drift */ '));
  await assert.rejects(g.migrate(FISCAL_MIRROR_MIGRATIONS[1]),e=>e.code==='55000'&&/previous_definition_changed/.test(e.message));await g.db.exec('rollback');
  assert.equal(await g.scalar("select to_regprocedure('erp_fiscal_mirror.report_visible(uuid,text,text,uuid)')::text v"),null);
 }finally{await g.close();}
});

test('003 indexed summary lists 7379 notes with bounded page and exact count',async t=>isolated(async()=>{
 await f.db.exec(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,version,last_seen_at)
 select 'nfe','nfe',(900000+n)::text,jsonb_build_object('id',900000+n,'numero',n,'serie',1,'tipo',1,'situacao',5,'valorNota',10,'dataEmissao','2026-10-22','contato',jsonb_build_object('id','101','nome','Sintético'),
 'chaveAcesso',lpad(n::text,44,'0'),'itens',jsonb_build_array(jsonb_build_object('codigo','P1','quantidade',1,'valor',10))),
 encode(sha256(convert_to(n::text,'UTF8')),'hex'),1,'2026-10-22T12:00:00Z'from generate_series(1,7379)n;
 analyze erp_fiscal_mirror.current;analyze erp_fiscal_mirror.xml_cache;`);
 const start=performance.now(),page=dto(await f.fiscalList());const elapsed=performance.now()-start;
 assert.equal(page.total_count,7380);assert.equal(page.items.length,100);assert.equal(page.coverage.visible_count,7380);
 t.diagnostic(`7379 mirrored synthetic notes, first page100 + coverage: ${elapsed.toFixed(1)} ms in PGlite.`);
 assert.ok(elapsed<15000,'bounded summary query regression budget');
}));
