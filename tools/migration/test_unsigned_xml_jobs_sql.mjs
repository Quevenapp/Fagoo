import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {buildAccessKey} from '../../packages/fiscal-core/src/identity.mjs';
import {resolveBusinessContent} from '../../packages/fiscal-core/src/business-document.mjs';

// Memory-only synthetic data; no remote Storage, certificate or fiscal transport.
let db,contact,product,seriesCount=100;const users={};
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
const code=c=>e=>e.code===c;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const hash=v=>createHash('sha256').update(v).digest('hex');
const companyData={legal_name:'EMPRESA FICTICIA XML',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'};
async function company(patch={}){const old=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'});return rpc('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:old.record?.version??0,p_command_id:randomUUID(),p_data:{...companyData,...patch}});}
async function regime(){const identity=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'}),fiscal=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'fiscal'});await rpc('erp_company_confirm_fiscal',{p_user_id:users.admin,p_expected_version:fiscal.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Confirmacao ficticia de teste'});}
const seed=async(cNF='12345678')=>({cNF,issuedAt:await scalar(`select to_char(clock_timestamp() at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00' value`)});
const completionArgs=(f,v=0,completion=f.completion)=>({p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:f.draft.record.version,p_snapshot_hash:f.draft.record.snapshot_hash,
 p_item_preparation_version:f.item.record.version,p_tax_preparation_version:f.tax.record.version,p_expected_identity_version:f.draft.record.snapshot.company.identity_version,
 p_expected_fiscal_version:f.draft.record.snapshot.company.fiscal_version,p_expected_completion_version:v,p_completion:completion,p_command_id:randomUUID()});
const basis=(f,v=f.saved.record.version)=>rpc('erp_fiscal_unsigned_basis',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_completion_version:v});
async function startArgs(f,patch={}){const b=await basis(f);return{p_user_id:users.fiscal,p_command_id:randomUUID(),p_reservation_id:f.reservation.receipt.id,
 p_completion_version:f.saved.record.version,p_completion_hash:b.proofs.completion_hash,p_basis_hash:b.basis_hash,p_builder_version:'brufap-business-builder-v1',p_seed:await seed(),...patch};}
const begin=args=>rpc('erp_fiscal_unsigned_begin',args);
const get=(j,uid=users.fiscal)=>rpc('erp_fiscal_unsigned_get',{p_user_id:uid,p_job_id:j.receipt.job_id});
const command=args=>rpc('erp_fiscal_unsigned_command',{p_user_id:args.p_user_id,p_command_id:args.p_command_id});
const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_unsigned.identity),(select count(*)from erp_fiscal_unsigned.job),(select count(*)from erp_fiscal_unsigned.command),(select count(*)from erp_fiscal_unsigned.attempt),(select count(*)from erp_fiscal_unsigned.artifact),(select count(*)from erp_fiscal_numbering.reservation),(select sum(next_number)from erp_fiscal_numbering.series),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title))value");
async function fixture({model='55',count=2,reserve=true,sharedSeries=null}={}){
 const example=businessFixture({model,count});
 const document=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},()=>({product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'})),internal_notes:'PRIVATE-COMMERCIAL-DO-NOT-COPY'}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:users.fiscal,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 const item=await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const tax=await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:example.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
 const{identity,...completion}=example.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);
 const f={document,draft,item,tax,completion};f.saved=await rpc('erp_fiscal_completion_save',completionArgs(f));
 if(!reserve)return f;
 const configured=sharedSeries?{current_series:sharedSeries}:await rpc('erp_fiscal_numbering_configure',{p_user_id:users.admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:model,p_environment:'2',p_series:String(seriesCount++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'Serie ficticia para teste local'});
 f.series=configured.current_series;f.reservation=await rpc('erp_fiscal_numbering_reserve',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_series_id:f.series.id,p_expected_series_version:f.series.version,p_expected_identity_version:f.series.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});return f;
}
async function syntheticUpload(j,body){
 const h=hash(body),size=Buffer.byteLength(body),path='jobs/'+j.receipt.job_id+'/'+h+'.xml';
 await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3)on conflict do nothing',['brufap-fiscal-artifacts',path,JSON.stringify({size,mimetype:'application/octet-stream'})]);
 return{p_user_id:users.fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_xml_hash:h,p_size_bytes:size,p_access_key:j.receipt.access_key};
}
const finish=args=>rpc('erp_fiscal_unsigned_finish',args);
function build(j){const v=j.execution.inputs;return buildBusinessXml({draft:v.draft,itemPreparation:v.itemPreparation,taxPreparation:v.taxPreparation,completion:{...v.completionPreparation.record.completion,identity:Object.fromEntries(['series','number','cNF','issuedAt'].map(k=>[k,j.execution.identity[k]]))}});}
async function expire(j){
 // Test-only superuser clock fixture; production guards forbid direct mutation.
 await db.exec('alter table erp_fiscal_unsigned.job disable trigger guard_job');try{await db.query("update erp_fiscal_unsigned.job set lease_until=clock_timestamp()-interval'1 second'where id=$1",[j.receipt.job_id]);}finally{await db.exec('alter table erp_fiscal_unsigned.job enable trigger guard_job');}
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs'])await db.exec(await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 await db.exec("insert into storage.buckets values('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);");
 for(const role of['admin','fiscal','consulta','vendas','estoque','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 await company();await regime();
});
after(()=>db?.close());

test('048 basis is read-only before046 and SQL tuple hashes match exact JavaScript serialization without identity',async()=>{
 const f=await fixture({reserve:false}),before=await counts();await db.exec('begin read only');let b;try{b=await basis(f);}finally{await db.exec('rollback');}
 const tuple=JSON.parse(b.basis_fingerprint_text);assert.equal(tuple.length,20);assert.ok(tuple.every(v=>typeof v==='string'));assert.equal(b.basis_fingerprint_text,JSON.stringify(tuple));assert.equal(b.basis_hash,hash(b.basis_fingerprint_text));
 const content=resolveBusinessContent(b.inputs);assert.equal(content.basis_fingerprint_text,b.basis_fingerprint_text);assert.equal(hash(content.basis_fingerprint_text),b.basis_hash);assert.equal(content.xml_generated,false);assert.equal(content.identity_assigned,false);assert.equal(content.arithmetic_verified,true);assert.ok(!Object.hasOwn(content,'identity'));assert.ok(!Object.hasOwn(content,'access_key'));
 assert.equal(b.inputs.basisHashes.completion_record_hash,b.proofs.completion_hash);assert.equal(tuple[7],b.inputs.basisHashes.draft_record_hash);assert.equal(b.persisted,false);assert.equal(b.arithmetic_verified,false);assert.equal(b.can_emit,false);assert.deepEqual(await counts(),before);
 assert.ok(!Object.hasOwn(b,'identity'));assert.ok(!Object.hasOwn(b,'access_key'));assert.doesNotMatch(JSON.stringify(b),/PRIVATE-COMMERCIAL/);
});
test('048 first seed wins, retries and other commands cannot allocate another identity or active lease',async()=>{
 const f=await fixture(),args=await startArgs(f),before=await counts(),j=await begin(args);assert.equal(j.current.state,'pending');assert.ok(j.execution.lease_id);assert.equal(j.receipt.identity.cNF,args.p_seed.cNF);assert.equal(j.receipt.access_key,buildAccessKey(j.receipt.identity));
 assert.deepEqual((await counts()).slice(5),before.slice(5));
 const replay=await begin({...args,p_seed:await seed('87654321')});assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,j.receipt);assert.equal(replay.execution,null);assert.equal(replay.current.attempt_count,1);
 const alias=await begin({...args,p_command_id:randomUUID(),p_seed:await seed('11111111')});assert.deepEqual(alias.receipt,j.receipt);assert.equal(alias.execution,null);assert.equal(alias.current.attempt_count,1);
 assert.deepEqual((await command(args)).receipt,j.receipt);assert.equal((await get(j)).receipt.access_key,j.receipt.access_key);
 await assert.rejects(()=>begin({...args,p_basis_hash:'0'.repeat(64)}),code('40001'));
});
test('048 refuses invalid/stale first dates and malformed seeds without creating jobs',async()=>{
 const f=await fixture(),args=await startArgs(f),before=await counts();
 for(const v of[null,{}, {...args.p_seed,number:'99'},{cNF:12345678,issuedAt:args.p_seed.issuedAt},{cNF:'1234567',issuedAt:args.p_seed.issuedAt},...['2026-02-30T10:00:00-03:00','2026-10-16T24:00:00-03:00','2026-10-16T10:00:60-03:00','2026-10-16T10:00:00Z','2100-01-01T10:00:00-03:00','2026-10-16T10:00:00.000-03:00'].map(issuedAt=>({cNF:'12345678',issuedAt}))])await assert.rejects(()=>begin({...args,p_seed:v}),code('22023'));
 await assert.rejects(()=>begin({...args,p_seed:{cNF:'12345678',issuedAt:'2000-01-01T00:00:00-03:00'}}),code('40001'));assert.deepEqual(await counts(),before);
});
test('048 models55/65 create deterministic unsigned bytes; finish preserves gates and replays without Storage writes',async()=>{
 for(const model of['55','65']){
  const f=await fixture({model}),args=await startArgs(f),j=await begin(args),xml=build(j);assert.equal(xml.access_key,j.receipt.access_key);assert.equal(build(j).unsignedXml,xml.unsignedXml);assert.equal(hash(resolveBusinessContent(j.execution.inputs).basis_fingerprint_text),j.receipt.basis_hash);
  const doneArgs=await syntheticUpload(j,xml.unsignedXml),done=await finish(doneArgs);assert.equal(done.current.state,'stored');assert.equal(done.xml_generated,true);assert.equal(done.signature_verified,false);assert.equal(done.xsd_validated,false);assert.equal(done.arithmetic_verified,false);assert.equal(done.authorized,false);
  assert.equal(done.artifact.xml_hash,xml.unsigned_xml_sha256);const before=await counts();assert.equal((await finish(doneArgs)).replayed,true);assert.deepEqual(await counts(),before);
  const replay=await begin({...args,p_seed:await seed('99999999')});assert.equal(replay.current.state,'stored');assert.equal(replay.execution,null);assert.deepEqual(replay.receipt,j.receipt);
  await assert.rejects(()=>finish({...doneArgs,p_xml_hash:'0'.repeat(64)}),code('40001'));
 }
});
test('048 Storage metadata/key/bucket mismatch cannot publish an artifact or claim byte/XSD validation',async()=>{
 const f=await fixture(),j=await begin(await startArgs(f)),xml=build(j),args={p_user_id:users.fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_xml_hash:xml.unsigned_xml_sha256,p_size_bytes:Buffer.byteLength(xml.unsignedXml),p_access_key:j.receipt.access_key};
 await assert.rejects(()=>finish(args),code('40001'));await syntheticUpload(j,xml.unsignedXml);
 await db.exec("update storage.buckets set public=true where id='brufap-fiscal-artifacts'");await assert.rejects(()=>finish(args),code('55000'));await db.exec("update storage.buckets set public=false where id='brufap-fiscal-artifacts'");
 for(const patch of[{p_size_bytes:args.p_size_bytes+1},{p_access_key:'1'.repeat(44)}])await assert.rejects(()=>finish({...args,...patch}),code('40001'));
 await assert.rejects(()=>finish({...args,p_size_bytes:480001}),code('22023'));assert.equal((await get(j)).current.state,'pending');assert.equal((await get(j)).artifact,null);
});
test('048 lease takeover fences old executor and regenerates with original identity after uncertain upload',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args),xml=build(j),oldFinish=await syntheticUpload(j,xml.unsignedXml);await expire(j);
 const resumed=await begin({...args,p_seed:{cNF:'11111111',issuedAt:'2000-01-01T00:00:00-03:00'}});assert.equal(resumed.current.attempt_count,2);assert.notEqual(resumed.execution.lease_id,j.execution.lease_id);assert.deepEqual(resumed.receipt.identity,j.receipt.identity);assert.equal(build(resumed).unsignedXml,xml.unsignedXml);
 await assert.rejects(()=>finish(oldFinish),code('40001'));const done=await finish({...oldFinish,p_lease_id:resumed.execution.lease_id});assert.equal(done.current.state,'stored');
 assert.deepEqual((await db.query('select state from erp_fiscal_unsigned.attempt where job_id=$1 order by ordinal',[j.receipt.job_id])).rows.map(r=>r.state),['expired','stored']);
});
test('048 completion correction keeps reserved identity/key and historical artifacts, without consuming numbers',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args);await finish(await syntheticUpload(j,build(j).unsignedXml));const before=await counts();
 const completion=structuredClone(f.completion);completion.additional_information='CORRECAO FICTICIA';f.saved=await rpc('erp_fiscal_completion_save',completionArgs(f,1,completion));
 const second=await begin(await startArgs(f,{p_seed:await seed('87654321')}));assert.equal(second.receipt.version,2);assert.equal(second.receipt.access_key,j.receipt.access_key);assert.deepEqual(second.receipt.identity,j.receipt.identity);assert.equal((await get(j)).current.artifact_current,false);
 const done=await finish(await syntheticUpload(second,build(second).unsignedXml));assert.equal(done.current.artifact_current,true);assert.notEqual(done.artifact.xml_hash,(await get(j)).artifact.xml_hash);assert.deepEqual((await counts()).slice(5),before.slice(5));
 const first=await rpc('erp_fiscal_unsigned_history',{p_user_id:users.fiscal,p_reservation_id:f.reservation.receipt.id,p_limit:1,p_before:null});assert.equal(first.items[0].receipt.version,2);assert.equal(first.next_cursor,2);
 const next=await rpc('erp_fiscal_unsigned_history',{p_user_id:users.fiscal,p_reservation_id:f.reservation.receipt.id,p_limit:1,p_before:2});assert.equal(next.items[0].receipt.version,1);assert.equal(next.next_cursor,null);
});
test('048 base changes during generation reject finalize; stored receipts remain historical and new bases cannot reuse046',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args),doneArgs=await syntheticUpload(j,build(j).unsignedXml);
 await rpc('erp_fiscal_tax_save',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_expected_version:1,p_operation:'internal_normal_sale',p_decisions:f.tax.record.items.map(i=>i.decisions),p_command_id:randomUUID()});
 await assert.rejects(()=>finish(doneArgs),code('40001'));assert.equal((await get(j)).current.basis_changed,true);assert.equal((await command(args)).receipt.access_key,j.receipt.access_key);
 const fresh=await fixture(),first=await begin(await startArgs(fresh));await finish(await syntheticUpload(first,build(first).unsignedXml));await company({trade_name:'IDENTIDADE FICTICIA ALTERADA'});
 assert.equal((await get(first)).current.basis_changed,true);assert.equal((await get(first)).current.artifact_current,false);await company();await regime();
});
test('048 deterministic failure is terminal and retry cannot silently replace identity or failed result',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args),failure={p_user_id:users.fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_error_code:'CONTENT_INCOMPLETE'};
 const failed=await rpc('erp_fiscal_unsigned_fail',failure);assert.equal(failed.current.state,'failed');assert.equal(failed.xml_generated,false);assert.equal((await rpc('erp_fiscal_unsigned_fail',failure)).replayed,true);
 const again=await begin({...args,p_command_id:randomUUID(),p_seed:await seed('87654321')});assert.equal(again.current.state,'failed');assert.equal(again.execution,null);assert.equal(again.receipt.access_key,j.receipt.access_key);
 await assert.rejects(()=>rpc('erp_fiscal_unsigned_fail',{...failure,p_error_code:'NETWORK_ERROR_RAW'}),code('22023'));
 await assert.rejects(()=>rpc('erp_fiscal_unsigned_fail',{...failure,p_error_code:'ARITHMETIC_MISMATCH'}),code('40001'));
});
test('048 ACL precedes replay; private records and finalized history cannot be changed directly',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args);
 for(const role of['consulta','vendas','estoque','financeiro']){await assert.rejects(()=>begin({...args,p_user_id:users[role]}),code('42501'));await assert.rejects(()=>get(j,users[role]),code('42501'));}
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>begin(args),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 await assert.rejects(()=>begin({...args,p_user_id:users.admin}),code('40001'));await assert.rejects(()=>rpc('erp_fiscal_unsigned_command',{p_user_id:users.admin,p_command_id:args.p_command_id}),code('42501'));
 for(const table of['identity','command'])await assert.rejects(()=>db.exec(`delete from erp_fiscal_unsigned.${table}`),code('42501'));
 await assert.rejects(()=>db.query("update erp_fiscal_unsigned.job set proofs='{}'where id=$1",[j.receipt.job_id]),code('42501'));
 for(const role of['anon','authenticated','service_role']){await db.exec('set role '+role);try{await assert.rejects(()=>scalar('select count(*)value from erp_fiscal_unsigned.job'),code('42501'));await assert.rejects(()=>scalar('select erp_fiscal_unsigned.flags()value'),code('42501'));}finally{await db.exec('reset role');}}
 assert.equal(await scalar("select bool_and(relrowsecurity)value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_unsigned'and c.relkind='r'"),true);
});
test('048 a late transaction failure rolls back identity/job/attempt/command together without allocating another046',async()=>{
 const f=await fixture(),args=await startArgs(f),before=await counts();await db.exec("create function public.synthetic_unsigned_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic rollback'using errcode='P0001';end$$;create trigger synthetic_unsigned_failure before insert on erp_fiscal_unsigned.attempt for each row execute function public.synthetic_unsigned_failure();");
 await assert.rejects(()=>begin(args),code('P0001'));assert.deepEqual(await counts(),before);await db.exec('drop trigger synthetic_unsigned_failure on erp_fiscal_unsigned.attempt;drop function public.synthetic_unsigned_failure();');assert.equal((await begin(args)).current.state,'pending');
});
test('048 all request bindings are CAS and series counter progress never invalidates a reserved identity',async()=>{
 const f=await fixture(),args=await startArgs(f),before=await counts();
 for(const patch of[{p_completion_version:2},{p_completion_hash:'0'.repeat(64)},{p_basis_hash:'0'.repeat(64)}])await assert.rejects(()=>begin({...args,...patch}),e=>['40001','P0002'].includes(e.code));
 await assert.rejects(()=>begin({...args,p_builder_version:'browser-selected-profile'}),code('22023'));assert.deepEqual(await counts(),before);
 const next=await fixture({sharedSeries:f.reservation.current_series});assert.equal(next.reservation.receipt.number,'2');
 const j=await begin(args);assert.equal(j.receipt.identity.number,'1');assert.equal(j.receipt.identity.series,f.series.series);assert.equal((await finish(await syntheticUpload(j,build(j).unsignedXml))).current.state,'stored');
});
test('048 changing047 during upload blocks old finalize and leaves no published stale artifact',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args),uploaded=await syntheticUpload(j,build(j).unsignedXml),before=await counts();
 f.saved=await rpc('erp_fiscal_completion_save',completionArgs(f,1,{...f.completion,additional_information:'NOVA REVISAO PENDENTE'}));await assert.rejects(()=>finish(uploaded),code('40001'));
 const current=await get(j);assert.equal(current.artifact,null);assert.equal(current.current.basis_changed,true);assert.equal(current.current.artifact_current,false);assert.deepEqual((await counts()).slice(5),before.slice(5));
 const next=await begin(await startArgs(f));assert.equal(next.receipt.access_key,j.receipt.access_key);assert.equal(next.receipt.version,2);assert.ok(next.execution);
});
test('048 failure after artifact insert rolls back publication and the same lease can retry safely',async()=>{
 const f=await fixture(),j=await begin(await startArgs(f)),args=await syntheticUpload(j,build(j).unsignedXml),before=await counts();
 await db.exec("create function public.synthetic_unsigned_finish_failure()returns trigger language plpgsql as $$begin if new.state='stored'then raise exception 'synthetic rollback'using errcode='P0001';end if;return new;end$$;create trigger synthetic_unsigned_finish_failure before update on erp_fiscal_unsigned.job for each row execute function public.synthetic_unsigned_finish_failure();");
 await assert.rejects(()=>finish(args),code('P0001'));assert.deepEqual(await counts(),before);assert.equal((await get(j)).current.state,'pending');
 await db.exec('drop trigger synthetic_unsigned_finish_failure on erp_fiscal_unsigned.job;drop function public.synthetic_unsigned_finish_failure();');assert.equal((await finish(args)).current.state,'stored');
});
test('048 another authorized executor can take over after expiry, but cannot finalize the old actor lease',async()=>{
 const f=await fixture(),args=await startArgs(f),j=await begin(args),bytes=build(j).unsignedXml,old=await syntheticUpload(j,bytes);await expire(j);
 const takeover=await begin({...args,p_user_id:users.admin,p_command_id:randomUUID(),p_seed:await seed('87654321')});assert.ok(takeover.execution);assert.equal(takeover.receipt.access_key,j.receipt.access_key);
 await assert.rejects(()=>finish({...old,p_user_id:users.admin}),code('42501'));await assert.rejects(()=>finish({...old,p_lease_id:takeover.execution.lease_id}),code('42501'));
 assert.equal((await finish({...old,p_user_id:users.admin,p_lease_id:takeover.execution.lease_id})).current.state,'stored');
});
test('048 restrictive Storage policy survives broad grants while service executor can use the private path',async()=>{
 await db.exec("grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;create policy synthetic_unsigned_permissive on storage.objects for all to anon,authenticated using(true)with check(true);");
 const f=await fixture(),j=await begin(await startArgs(f)),args=await syntheticUpload(j,build(j).unsignedXml);
 for(const role of['anon','authenticated']){await db.exec('set role '+role);try{
  assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='brufap-fiscal-artifacts'"),0);
  await assert.rejects(()=>db.exec("insert into storage.objects values('brufap-fiscal-artifacts','untrusted','{}')"),code('42501'));
 }finally{await db.exec('reset role');}}
 assert.equal((await finish(args)).current.state,'stored');await db.exec('drop policy synthetic_unsigned_permissive on storage.objects');
});
test('048 250-item captured input remains bounded and the builder uses the persisted server identity',async()=>{
 const f=await fixture({model:'65',count:250}),b=await basis(f),j=await begin(await startArgs(f)),xml=build(j);assert.equal(b.inputs.completionPreparation.record.completion.items.length,250);
 assert.ok(Buffer.byteLength(JSON.stringify(b))<8*1024*1024);assert.ok(Buffer.byteLength(xml.unsignedXml)<=480000);assert.equal(xml.access_key,j.receipt.access_key);
 assert.equal((await finish(await syntheticUpload(j,xml.unsignedXml))).current.state,'stored');
});
test('048 finish and fail recheck issuer after acquiring the company mutex, including terminal replay',async()=>{
 const stored=await begin(await startArgs(await fixture())),storedArgs=await syntheticUpload(stored,build(stored).unsignedXml);await finish(storedArgs);
 const pending=await begin(await startArgs(await fixture())),failed=await begin(await startArgs(await fixture()));
 const failure=j=>({p_user_id:users.fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_error_code:'CONTENT_INCOMPLETE'});
 await rpc('erp_fiscal_unsigned_fail',failure(failed));
 const definition=await scalar("select pg_get_functiondef('erp_fiscal_unsigned.lock_basis(erp_fiscal_numbering.reservation)'::regprocedure)value");
 // Single-session fault injection models an issuer committed while the caller waited.
 // The PostgreSQL companion test exercises the actual wait using two connections.
 await db.exec(`create or replace function erp_fiscal_unsigned.lock_basis(r erp_fiscal_numbering.reservation)returns void language plpgsql set search_path=pg_catalog as $$begin
  perform pg_advisory_xact_lock(174852920,1);
  update erp_company.identity set data=jsonb_set(data,'{cnpj}',to_jsonb('${TEST_RECIPIENT}'::text)) where singleton;
 end$$;`);
 try{
  await assert.rejects(()=>finish(storedArgs),code('42501'));
  await assert.rejects(()=>rpc('erp_fiscal_unsigned_fail',failure(pending)),code('42501'));
  await assert.rejects(()=>rpc('erp_fiscal_unsigned_fail',failure(failed)),code('42501'));
  assert.equal((await get(pending)).current.state,'pending');
 }finally{await db.exec(definition);}
});
