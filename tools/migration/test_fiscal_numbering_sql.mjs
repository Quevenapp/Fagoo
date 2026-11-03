import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

// Synthetic, memory-only PostgreSQL. PGlite does not prove multi-session scheduling.
let db,contact,product;const users={};let seriesSequence=10;
const code=c=>e=>e.code===c;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const companyData={legal_name:'Empresa sintética 046',cnpj:'11222333000181',postal_code:'13400000',street:'Rua fictícia',number:'S/N',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'};
const identity=()=>rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'});
async function company(patch={}){const old=await identity();return rpc('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:old.record?.version??0,p_command_id:randomUUID(),p_data:{...companyData,...patch}});}
async function regime(){const id=await identity(),fiscal=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'fiscal'});return rpc('erp_company_confirm_fiscal',{p_user_id:users.admin,p_expected_version:fiscal.record.version,p_expected_identity_version:id.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Confirmação sintética, sem emissão'});}
const draftCommand=(action,data)=>rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:action,p_data:data});
async function fixture(model='55',document=null){
 document??=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'Produto sintético',unit:'UN',quantity:'1.230000',unit_price:'10.0000',discount_percent:'0'}],internal_notes:'PRIVATE-COMMERCIAL-DO-NOT-EXPOSE'}})).document;
 const draft=await draftCommand('create',{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'Venda sintética',notes:null}});
 const prepared=await rpc('erp_fiscal_item_save',{p_user_id:users.fiscal,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0,p_decisions:[],p_command_id:randomUUID()});
 const tax=await rpc('erp_fiscal_tax_save',{p_user_id:users.fiscal,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:prepared.record.version,p_expected_version:0,p_operation:'internal_normal_sale',p_decisions:[],p_command_id:randomUUID()});
 return{document,draft,prepared,tax};
}
async function configArgs(patch={}){return{p_user_id:users.admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:(await identity()).record.version,p_model:'55',p_environment:'2',p_series:String(seriesSequence++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'Série sintética exclusiva para homologação local',...patch};}
const configure=args=>rpc('erp_fiscal_numbering_configure',args);
async function series(patch={}){return configure(await configArgs(patch));}
const reserveArgs=(f,s,patch={})=>({p_user_id:users.fiscal,p_command_id:randomUUID(),p_series_id:s.current_series.id,p_expected_series_version:s.current_series.version,p_expected_identity_version:s.current_series.identity_version,p_draft_id:f.draft.record.id,p_expected_draft_version:f.draft.record.version,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:f.prepared.record.version,p_tax_preparation_version:f.tax.record.version,p_confirm_reserve:true,...patch});
const reserve=args=>rpc('erp_fiscal_numbering_reserve',args);
const readReservation=(id,user=users.fiscal)=>rpc('erp_fiscal_numbering_reservation',{p_user_id:user,p_id:id});
const readDraft=(id,user=users.fiscal)=>rpc('erp_fiscal_numbering_draft',{p_user_id:user,p_draft_id:id});
const command=(id,user=users.fiscal)=>rpc('erp_fiscal_numbering_command',{p_user_id:user,p_command_id:id});
const list=(patch={})=>rpc('erp_fiscal_numbering_series',{p_user_id:users.fiscal,...patch});
const count=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_numbering.series),(select count(*)from erp_fiscal_numbering.series_revision),(select count(*)from erp_fiscal_numbering.reservation),(select count(*)from erp_fiscal_numbering.command),(select count(*)from erp_fiscal_numbering.audit),(select sum(next_number)from erp_fiscal_numbering.series),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title),(select sum(last_number)from erp_documents.numbering)) value");
const updateArgs=(s,patch={})=>({p_id:s.id,p_expected_version:s.version,p_model:s.model,p_series:s.series,p_initial_number:s.first_number,p_enabled:s.enabled,p_exclusive_use_confirmed:s.exclusive_use_confirmed,...patch});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0016_company','0022_fiscal_drafts','0023_product_details','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering'])await db.exec(await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','estoque','vendas','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato fictício',person_type:'J',document:'11222333000181',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto fictício 046',unit:'UN',kind:'P',format:'S',ncm:'82055900',origin:'0',gtin:'SEM GTIN'}})).record;
 await company();await regime();
});
after(()=>db?.close());

test('046 configuration is explicit, canonical, homologation-only and bound to the current issuer',async()=>{
 const args=await configArgs({p_series:'0',p_initial_number:'999999999'}),before=await count(),r=await configure(args);
 assert.equal(r.current_series.series,'0');assert.equal(r.current_series.first_number,'999999999');assert.equal(r.current_series.next_number,'999999999');assert.equal(r.current_series.issuer_cnpj,companyData.cnpj);
 assert.equal(r.current_series.identity_version,(await identity()).record.version);assert.equal(r.can_emit,false);assert.equal(r.can_transmit,false);assert.equal(r.authorized,false);
 assert.deepEqual((await configure(args)).receipt,r.receipt);assert.equal((await configure(args)).replayed,true);assert.deepEqual((await count()).slice(6),before.slice(6));
 const invalid=[{p_series:'00'},{p_series:'01'},{p_series:'890'},{p_series:'-1'},{p_series:'1.0'},{p_series:'abc'},{p_series:' 1'},{p_series:null},{p_initial_number:'0'},{p_initial_number:'01'},{p_initial_number:'1000000000'},{p_initial_number:'1.0'},{p_environment:'1'},{p_model:'57'},{p_exclusive_use_confirmed:false},{p_reference:'\u00a0'.repeat(3)},{p_reference:'x\ny'},{p_reference:'x'.repeat(241)},{p_expected_identity_version:0}];
 for(const patch of invalid)await assert.rejects(()=>configArgs(patch).then(configure),code('22023'));
 await assert.rejects(()=>configure({...args,p_command_id:randomUUID()}),code('40001'));
 await assert.rejects(()=>configure({...args,p_reference:'Alteração do mesmo comando'}),code('40001'));
});

test('046 reservation captures exact versions, advances once and has no other operational effect',async()=>{
 const f=await fixture(),s=await series(),args=reserveArgs(f,s),before=await count(),r=await reserve(args);
 assert.equal(r.receipt.number,'1');assert.equal(r.receipt.series,s.receipt.series);assert.equal(r.receipt.series_version,1);assert.equal(r.current_series.next_number,'2');assert.equal(r.current_series.version,2);assert.equal(r.current_basis.basis_changed,false);
 assert.equal(r.receipt.draft_id,f.draft.record.id);assert.equal(r.receipt.draft_version,1);assert.equal(r.receipt.snapshot_hash,f.draft.record.snapshot_hash);assert.equal(r.receipt.source_document_version,f.document.version);assert.equal(r.receipt.item_preparation_version,1);assert.equal(r.receipt.tax_preparation_version,1);
 assert.match(r.receipt.item_preparation_hash,/^[0-9a-f]{64}$/);assert.match(r.receipt.tax_preparation_hash,/^[0-9a-f]{64}$/);assert.equal(r.financial_mutation_performed,false);assert.equal(r.stock_mutation_performed,false);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE-COMMERCIAL|unit_price|contact_name|access_key|protocol|certificate/);
 assert.deepEqual((await count()).slice(6),before.slice(6));const after=await count();assert.deepEqual((await reserve(args)).receipt,r.receipt);assert.deepEqual(await count(),after);
 assert.deepEqual((await command(args.p_command_id)).receipt,r.receipt);assert.deepEqual((await readReservation(r.receipt.id)).receipt,r.receipt);
 await assert.rejects(()=>reserve({...args,p_command_id:randomUUID(),p_expected_series_version:2}),code('40001'));
 await assert.rejects(()=>reserve({...args,p_confirm_reserve:false}),code('22023'));
 await assert.rejects(()=>reserve({...args,p_snapshot_hash:'0'.repeat(64)}),code('40001'));
});

test('046 sequence CAS prevents competing commands consuming the same reviewed number',async()=>{
 const s=await series(),a=await fixture(),b=await fixture(),argsA=reserveArgs(a,s),argsB=reserveArgs(b,s);
 const first=await reserve(argsA),before=await count();await assert.rejects(()=>reserve(argsB),code('40001'));assert.deepEqual(await count(),before);
 const second=await reserve({...argsB,p_expected_series_version:first.current_series.version});assert.equal(second.receipt.number,'2');assert.equal(second.current_series.next_number,'3');
 assert.equal((await reserve(argsA)).current_series.next_number,'3');assert.equal((await reserve(argsA)).receipt.number,'1');
});

test('046 disaorigin and reconfirming never reset or jump a counter; historical replay stays historical',async()=>{
 const f=await fixture(),s=await series({p_initial_number:'73'}),args=reserveArgs(f,s),first=await reserve(args);
 const disabled=await configure(await configArgs(updateArgs(first.current_series,{p_enabled:false,p_exclusive_use_confirmed:false})));
 assert.equal(disabled.current_series.next_number,'74');const replay=await reserve(args);assert.equal(replay.receipt.number,'73');assert.equal(replay.current_series.enabled,false);
 const g=await fixture();await assert.rejects(()=>reserve(reserveArgs(g,disabled)),code('40001'));
 for(const number of['1','74','99'])await assert.rejects(()=>configArgs(updateArgs(disabled.current_series,{p_initial_number:number})).then(configure),code('40001'));
 const enabled=await configure(await configArgs(updateArgs(disabled.current_series,{p_enabled:true,p_exclusive_use_confirmed:true})));
 assert.equal((await reserve(reserveArgs(g,enabled))).receipt.number,'74');
 await assert.rejects(()=>db.query('update erp_fiscal_numbering.series set next_number=next_number+2,version=version+1 where id=$1',[s.receipt.id]),code('40001'));
 await assert.rejects(()=>db.query('update erp_fiscal_numbering.series set next_number=first_number,version=version+1 where id=$1',[s.receipt.id]),code('40001'));
});

test('046 binds current source, draft, preparations and issuer without claiming readiness',async()=>{
 const f=await fixture(),s=await series(),args=reserveArgs(f,s),before=await count();
 for(const patch of[{p_expected_draft_version:2},{p_snapshot_hash:'f'.repeat(64)},{p_item_preparation_version:2},{p_tax_preparation_version:2},{p_expected_identity_version:999},{p_expected_series_version:99}])await assert.rejects(()=>reserve({...args,p_command_id:randomUUID(),...patch}),code('40001'));
 assert.deepEqual(await count(),before);
 await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:f.document.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'open',p_reason:'Alteração sintética'});await assert.rejects(()=>reserve(args),code('40001'));
 const g=await fixture();await rpc('erp_fiscal_item_save',{p_user_id:users.fiscal,p_draft_id:g.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:g.draft.record.snapshot_hash,p_expected_version:1,p_decisions:[],p_command_id:randomUUID()});
 await assert.rejects(()=>reserve(reserveArgs(g,s,{p_item_preparation_version:2})),code('40001'));
 const h=await fixture();await draftCommand('archive',{id:h.draft.record.id,expected_version:1,reason:'Arquivo sintético'});await assert.rejects(()=>reserve(reserveArgs(h,s)),code('40001'));
 const j=await fixture();await company({legal_name:'Identidade sintética alterada'});await assert.rejects(()=>reserve(reserveArgs(j,s)),code('40001'));
 const fresh=await fixture(),currentIdentityVersion=(await identity()).record.version;await assert.rejects(()=>reserve(reserveArgs(fresh,s,{p_expected_identity_version:currentIdentityVersion})),code('40001'));
 const reconfirmed=await configure(await configArgs(updateArgs(s.current_series)));assert.equal((await reserve(reserveArgs(fresh,reconfirmed))).receipt.number,'1');
});

test('046 historical reservation survives draft refresh/archive and blocks another draft of the same order/model',async()=>{
 const f=await fixture(),s=await series(),args=reserveArgs(f,s),first=await reserve(args);
 const refreshed=await draftCommand('refresh',{id:f.draft.record.id,expected_version:1,expected_source_version:f.document.version});assert.equal(refreshed.record.version,2);
 const current=await readReservation(first.receipt.id);assert.equal(current.current_basis.basis_changed,true);assert.equal(current.receipt.draft_version,1);assert.deepEqual((await reserve(args)).receipt,first.receipt);
 await draftCommand('archive',{id:f.draft.record.id,expected_version:2,reason:'Arquivo sintético depois da reserva'});assert.equal((await readReservation(first.receipt.id)).current_basis.draft_archived,true);
 const replacement=await fixture('55',f.document);await assert.rejects(()=>reserve(reserveArgs(replacement,first)),code('40001'));
 await draftCommand('archive',{id:replacement.draft.record.id,expected_version:1,reason:'Arquivar reposição sintética'});
 const nfc=await fixture('65',f.document),nfcSeries=await series({p_model:'65'});assert.equal((await reserve(reserveArgs(nfc,nfcSeries))).receipt.model,'65');
});

test('046 last legal number is exact, exhausted series never wraps or reuses it',async()=>{
 const f=await fixture(),s=await series({p_initial_number:'999999999'}),args=reserveArgs(f,s),last=await reserve(args);
 assert.equal(last.receipt.number,'999999999');assert.equal(last.current_series.exhausted,true);assert.equal(last.current_series.next_number,null);
 const g=await fixture(),before=await count();await assert.rejects(()=>reserve(reserveArgs(g,last)),code('40001'));assert.deepEqual(await count(),before);
 assert.equal((await reserve(args)).receipt.number,'999999999');assert.equal((await reserve(args)).current_series.next_number,null);
});

test('046 rollback includes sequence, revision, reservation, command and audit; retry consumes once',async()=>{
 const f=await fixture(),s=await series(),args=reserveArgs(f,s),before=await count();
 await db.exec("create function public.numbering_failure()returns trigger language plpgsql as $$begin if new.action='reserve'then raise exception 'synthetic rollback'using errcode='P0001';end if;return new;end$$;create trigger numbering_failure before insert on erp_fiscal_numbering.audit for each row execute function public.numbering_failure();");
 await assert.rejects(()=>reserve(args),code('P0001'));assert.deepEqual(await count(),before);await db.exec('drop trigger numbering_failure on erp_fiscal_numbering.audit;drop function public.numbering_failure();');
 assert.equal((await reserve(args)).receipt.number,'1');assert.equal((await reserve(args)).replayed,true);assert.equal(await scalar('select count(*) value from erp_fiscal_numbering.reservation where draft_id=$1',[f.draft.record.id]),1);
});

test('046 permission is checked before replay and issuer changes do not expose past numbering',async()=>{
 const f=await fixture(),s=await series(),args=reserveArgs(f,s),saved=await reserve(args);
 for(const role of['consulta','vendas','estoque','financeiro']){await assert.rejects(()=>readReservation(saved.receipt.id,users[role]),code('42501'));await assert.rejects(()=>reserve({...args,p_user_id:users[role]}),code('42501'));}
 await assert.rejects(()=>configArgs({p_user_id:users.fiscal}).then(configure),code('42501'));await assert.rejects(()=>command(args.p_command_id,users.admin),code('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>reserve(args),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 await company({cnpj:'11444777000161'});await assert.rejects(()=>reserve(args),code('42501'));await assert.rejects(()=>readReservation(saved.receipt.id),code('42501'));assert.deepEqual((await list()).items,[]);
 await company();await regime();assert.equal((await reserve(args)).current_basis.basis_changed,true);
});

test('046 reopening a draft is read-only, returns absence explicitly and scopes the issuer',async()=>{
 const f=await fixture(),s=await series(),before=await count(),empty=await readDraft(f.draft.record.id);
 assert.equal(empty.read_only,true);assert.equal(empty.receipt,null);assert.equal(empty.current_series,null);assert.equal(empty.current_basis,null);assert.deepEqual(await count(),before);
 const args=reserveArgs(f,s),saved=await reserve(args),after=await count();assert.deepEqual((await readDraft(f.draft.record.id)).receipt,saved.receipt);assert.deepEqual(await count(),after);
 await assert.rejects(()=>readDraft(f.draft.record.id,users.consulta),code('42501'));await assert.rejects(()=>readDraft(randomUUID()),code('P0002'));
 await company({cnpj:'11444777000161'});await assert.rejects(()=>readDraft(f.draft.record.id),code('42501'));await company();await regime();
});

test('046 action namespace, role downgrade, model and cancellation are rechecked',async()=>{
 const cfg=await configArgs(),s=await configure(cfg),f=await fixture(),args=reserveArgs(f,s);
 await assert.rejects(()=>reserve({...args,p_command_id:cfg.p_command_id}),code('40001'));
 await db.query("update erp_access.membership set role='fiscal' where user_id=$1",[users.admin]);await assert.rejects(()=>configure(cfg),code('42501'));await assert.rejects(()=>command(cfg.p_command_id,users.admin),code('42501'));await db.query("update erp_access.membership set role='admin' where user_id=$1",[users.admin]);
 const nfc=await fixture('65');await assert.rejects(()=>reserve(reserveArgs(nfc,s)),code('40001'));
 await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:f.document.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'cancelled',p_reason:'Cancelamento comercial sintético'});await assert.rejects(()=>reserve(args),code('40001'));
});

test('046 private immutable history and scoped bounded pagination',async()=>{
 const s=await series();await series({p_model:'65'});const first=await list({p_model:'55',p_limit:2});assert.equal(first.items.length,2);assert.ok(first.items.every(r=>r.model==='55'));assert.equal(first.has_more,true);
 const next=await list({p_model:'55',p_limit:2,p_after:first.next_cursor});assert.ok(next.items.every(r=>!first.items.some(a=>a.id===r.id)));await assert.rejects(()=>list({p_limit:26}),code('22023'));
 for(const [table,field]of[['command','result'],['series_revision','record'],['reservation','snapshot_hash'],['audit','reference']])await assert.rejects(()=>db.exec(`update erp_fiscal_numbering.${table} set ${field}=${field}`),code('42501'));
 await assert.rejects(()=>db.query('delete from erp_fiscal_numbering.series where id=$1',[s.receipt.id]),code('42501'));
 for(const role of['anon','authenticated','service_role']){await db.exec('set role '+role);try{
  await assert.rejects(()=>scalar('select count(*)value from erp_fiscal_numbering.series'),code('42501'));await assert.rejects(()=>scalar('select erp_fiscal_numbering.flags()value'),code('42501'));
  if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_fiscal_numbering_series($1)value',[users.admin]),code('42501'));
 }finally{await db.exec('reset role');}}
 assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_numbering' and c.relkind='r'"),true);
});

test('046 lock order is command → order → draft → company → preparations → series, not a live concurrency proof',async()=>{
 const sql=await readFile(new URL('../../supabase/migrations/202610160046_fiscal_numbering.sql',import.meta.url),'utf8');
 const reserveBody=sql.split('create function public.erp_fiscal_numbering_reserve(')[1].split('create function public.erp_fiscal_numbering_series(')[0];
 const points=['pg_advisory_xact_lock(174852946','where id=parent for share','source_document_id=parent for update','select version into iv','select version into tv','where id=p_series_id for update'].map(x=>reserveBody.indexOf(x));
 assert.ok(points.every(x=>x>=0));assert.deepEqual(points,[...points].sort((a,b)=>a-b));
 assert.ok(reserveBody.indexOf('pg_advisory_xact_lock(174852920,1);issuer',points[2])>points[2]);
 assert.match(sql,/unique\(source_document_id,model,environment\)/);assert.match(sql,/unique\(issuer_cnpj,cuf,model,environment,series,number\)/);
});
