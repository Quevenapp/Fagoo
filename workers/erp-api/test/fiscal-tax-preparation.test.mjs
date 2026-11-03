import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {resolveTaxItems,validateTaxDecisions} from '../../../packages/fiscal-core/src/tax-preparation.mjs';
import {parseFiscalTaxRoute,executeFiscalTaxRoute,FISCAL_TAX_RESPONSE_BYTES} from '../src/fiscal-tax-preparation.mjs';
// Synthetic, memory-only PostgreSQL. These tests do not prove multi-session lock scheduling.
let db,contact,product;const users={};const code=c=>e=>e.code===c;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const draftCommand=(action,data)=>rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:action,p_data:data});
const get=(id,version=null,user=users.fiscal)=>rpc('erp_fiscal_tax_get',{p_user_id:user,p_draft_id:id,p_version:version});
const companyData={legal_name:'Empresa sintética 040',cnpj:'11222333000181',postal_code:'13400000',street:'Rua fictícia',number:'S/N',district:'Bairro fictício',city:'Piracicaba',municipality_code:'3538709',state:'SP'};
async function company(patch={}){const old=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'});return rpc('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:old.record?.version??0,p_command_id:randomUUID(),p_data:{...companyData,...patch}});}
async function regime(crt='1'){const identity=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'}),fiscal=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'fiscal'});return rpc('erp_company_confirm_fiscal',{p_user_id:users.admin,p_expected_version:fiscal.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:crt,p_confirmed:crt!==null,p_reason:'Confirmação fictícia, sem emissão'});}
const itemArgs=(d,v=0)=>({p_user_id:users.fiscal,p_draft_id:d.record.id,p_expected_draft_version:d.record.version,p_snapshot_hash:d.record.snapshot_hash,p_expected_version:v,p_decisions:[],p_command_id:randomUUID()});
async function fixture(model='55',count=2){
 const document=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},(_,i)=>({...(i%2===0?{product_id:product.id}:{}),description:'Produto ou item livre sintético',unit:'UN',quantity:'1.230000',unit_price:'10.0000',discount_percent:'0'})),internal_notes:'PRIVATE-COMMERCIAL-DO-NOT-EXPOSE'}})).document;
 const draft=await draftCommand('create',{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'Venda fictícia',notes:null}});
 const prepared=await rpc('erp_fiscal_item_save',{...itemArgs(draft),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:{ncm:{source:'manual',value:'82055900'},origin:{source:'manual',value:'0'},gtin:{source:'manual',value:'SEM GTIN'},gtin_tax:{source:'manual',value:'SEM GTIN'}}}))});
 return{document,draft,prepared};
}
const choice=(f,patch={})=>({item_id:f.draft.record.snapshot.items[0].id,cfop:'5102',icms:{csosn:'102'},pis:{cst:'49',base:null,rate:null,amount:null},cofins:{cst:'49',base:null,rate:null,amount:null},review_note:null,...patch});
const args=(f,decisions=[],version=0)=>({p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:f.draft.record.version,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:f.prepared.record.version,p_expected_version:version,p_operation:'internal_normal_sale',p_decisions:decisions});
const preview=(f,d=[],v=0)=>rpc('erp_fiscal_tax_preview',args(f,d,v));
const save=(f,d=[],v=0,command=randomUUID())=>rpc('erp_fiscal_tax_save',{...args(f,d,v),p_command_id:command});
const input=(f,d=[],v=0,command=randomUUID())=>({expected_draft_version:f.draft.record.version,snapshot_hash:f.draft.record.snapshot_hash,item_preparation_version:f.prepared.record.version,expected_version:v,operation:'internal_normal_sale',decisions:d,command_id:command});
async function api(id,path='',method='GET',body,port=rpc){const request=new Request(`https://synthetic.invalid/v1/preparacao-tributaria/${id}${path}`,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return executeFiscalTaxRoute(await parseFiscalTaxRoute(request),{userId:users.fiscal,rpc:port});}
const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_tax.head),(select count(*)from erp_fiscal_tax.revision),(select count(*)from erp_fiscal_tax.command),(select count(*)from erp_fiscal_items.revision),(select count(*)from erp_fiscal_drafts.revision),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title),(select sum(last_number)from erp_documents.numbering)) value");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','estoque','vendas','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato fictício',person_type:'J',document:'11222333000181',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto fictício 040',unit:'UN',kind:'P',format:'S',ncm:'82055900',origin:'0',gtin:'SEM GTIN'}})).record;
 await company();await regime();
});
after(()=>db?.close());
test('040 preview is read-only; SQL, pure resolver and HTTP preserve exact explicit choices',async()=>{
 const f=await fixture(),d=[choice(f,{icms:{csosn:'101',credit_rate:'4.7900',credit_period:'2026-10',credit_evidence:'Dado declarado sintético; revisão pendente'}})],before=await counts();
 const empty=await api(f.draft.record.id);assert.equal(empty.record,null);assert.equal(empty.current.tax_version,0);
 const raw=await preview(f,d),{command_id,...body}=input(f,d),http=await api(f.draft.record.id,'/preview','POST',body);
 const base=raw.record.items.map(({item_id,position,product_id,identifiers})=>({item_id,position,product_id,identifiers}));assert.deepEqual(raw.record.items,resolveTaxItems({model:'55',items:base,decisions:d}));assert.deepEqual(http,raw);assert.equal(http.record.items[0].decisions.icms.credit_rate,'4.7900');assert.equal(http.record.items[1].decisions.icms,null);assert.deepEqual(await counts(),before);
 assert.equal(http.record.created_at,null);assert.equal(http.persisted,false);assert.doesNotMatch(JSON.stringify(http),/PRIVATE-COMMERCIAL|unit_price|quantity|cnpj|actor|command_id/);
});
test('040 save creates only private immutable preparation, preserves commercial values and revalidates authorization before replay',async()=>{
 const f=await fixture(),before=await counts(),cmd=randomUUID(),body=input(f,[choice(f)],0,cmd),saved=await api(f.draft.record.id,'/save','POST',body);
 assert.equal(saved.record.version,1);assert.equal(saved.current.tax_version,1);assert.equal(saved.replayed,false);assert.deepEqual((await counts()).slice(3),before.slice(3));assert.equal(await scalar('select version value from erp_documents.document where id=$1',[f.document.id]),1);
 for(const k of['operational_effects','calculation_performed','xml_generated','transmitted','can_emit','tax_rules_validated','xsd_validated'])assert.equal(saved[k],false);
 for(const role of['consulta','estoque','vendas','financeiro'])await assert.rejects(()=>get(f.draft.record.id,null,users[role]),code('42501'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>save(f,[choice(f)],0,cmd),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 assert.deepEqual((await save(f,[choice(f)],0,cmd)).record,saved.record);
 for(const table of['revision','command'])await assert.rejects(()=>db.exec(`update erp_fiscal_tax.${table} set ${table==='revision'?'record=record':'result=result'}`),code('42501'));
 for(const role of['anon','authenticated','service_role']){await db.exec('set role '+role);try{await assert.rejects(()=>scalar('select count(*) value from erp_fiscal_tax.revision'),code('42501'));await assert.rejects(()=>scalar('select erp_fiscal_tax.flags() value'),code('42501'));if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_fiscal_tax_get($1,$2) value',[users.admin,f.draft.record.id]),code('42501'));}finally{await db.exec('reset role');}}
 assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_tax' and c.relkind='r'"),true);
});
test('040 CAS is global and replay returns original receipt separately from current after new 035/022 revisions and archive',async()=>{
 const f=await fixture(),d=[choice(f)],cmd=randomUUID(),first=await save(f,d,0,cmd);
 await assert.rejects(()=>save(f,[],0),code('40001'));f.prepared=await rpc('erp_fiscal_item_save',itemArgs(f.draft,1));await assert.rejects(()=>rpc('erp_fiscal_tax_save',{...args(f,[],1),p_item_preparation_version:1,p_command_id:randomUUID()}),code('40001'));
 const second=await save(f,[],1);assert.equal(second.record.item_preparation_version,2);assert.equal(second.record.items[0].decisions.cfop,null);
 f.draft=await draftCommand('refresh',{id:f.draft.record.id,expected_version:1,expected_source_version:f.document.version});await assert.rejects(()=>save(f,[],2),code('40001'));
 f.prepared=await rpc('erp_fiscal_item_save',itemArgs(f.draft,2));const third=await save(f,[],2);assert.equal(third.record.draft_version,2);assert.equal(third.record.version,3);
 await draftCommand('archive',{id:f.draft.record.id,expected_version:2,reason:'Arquivo sintético'});
 const replay=await rpc('erp_fiscal_tax_save',{...args(f,d,0),p_expected_draft_version:1,p_snapshot_hash:first.record.snapshot_hash,p_item_preparation_version:1,p_command_id:cmd});assert.deepEqual(replay.record,first.record);assert.equal(replay.replayed,true);assert.equal(replay.current.tax_version,3);assert.equal(replay.current.draft_status,'archived');assert.equal(replay.current.matches_current_draft,false);assert.equal(replay.current.matches_current_item_preparation,false);
 assert.deepEqual((await api(f.draft.record.id,'?version=1')).record,first.record);await assert.rejects(()=>save(f,[],3),code('40001'));
 await assert.rejects(()=>rpc('erp_fiscal_tax_save',{...args(f,d,0),p_expected_draft_version:1,p_snapshot_hash:first.record.snapshot_hash,p_item_preparation_version:1,p_command_id:cmd,p_user_id:users.admin}),code('40001'));
});
test('040 source and company changes require fresh 022 and 035; CRT must be explicitly current and confirmed as 1',async()=>{
 const f=await fixture();await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:f.document.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'open',p_reason:'Mudança sintética'});await assert.rejects(()=>save(f),code('40001'));
 const g=await fixture();await company({legal_name:'Empresa sintética alterada'});await assert.rejects(()=>save(g),code('40001'));assert.equal((await get(g.draft.record.id)).current.company_changed,true);
 await company();await regime('3');const wrongRegime=await fixture();await assert.rejects(()=>save(wrongRegime),code('22023'));
 await regime(null);const unconfirmed=await fixture();await assert.rejects(()=>save(unconfirmed),code('22023'));await regime('1');
 const nfc=await fixture('65');await assert.rejects(()=>save(nfc,[choice(nfc,{icms:{csosn:'101',credit_rate:null,credit_period:null,credit_evidence:null}})]),code('22023'));assert.equal((await save(nfc,[choice(nfc)])).record.model,'65');
});
test('040 SQL/pure agree on string-only decimal structure, typed branches, unsupported choices and Unicode boundaries',async()=>{
 const f=await fixture(),base=choice(f);const cases=[base,{...base,icms:null},{...base,icms:{csosn:'500',retention:{base:'9999999999999.99',rate:'999.9999',substitute_icms:null,retained_icms:'0.00'},fcp:{base:null,rate:null,amount:null},effective:{reduction_rate:null,base:null,rate:null,amount:null}}}];
 for(const value of[null,'0.00','9999999999999.99','10000000000000.00','01.00','1.0',0,4.79])cases.push({...base,pis:{cst:'49',base:value,rate:null,amount:null}});
 for(const value of[null,'0.00','4.7900','999.9999','1000.00','4.7',4.79])cases.push({...base,icms:{csosn:'101',credit_rate:value,credit_period:null,credit_evidence:null}});
 for(const value of['ação sintética','😀'.repeat(1000),'😀'.repeat(1001),'\u00a0'.repeat(3),'\u2003'.repeat(3),'x\ny','ab'])cases.push({...base,review_note:value});
 cases.push({...base,cfop:'6102'},{...base,item_id:[base.item_id]},{...base,cfop:5102},{...base,cofins:{cst:49,base:null,rate:null,amount:null}},{...base,icms:{csosn:102}},{...base,icms:{csosn:'900'}},{...base,amount:'1.00'});
 for(const d of cases){let valid=true;try{validateTaxDecisions([d],'55');}catch{valid=false;}if(valid){const r=await preview(f,[d]);assert.deepEqual(r.record.items[0].decisions,d);}else await assert.rejects(()=>preview(f,[d]),code('22023'));}
 const before=await counts();for(const d of[[base,base],[{...base,item_id:randomUUID()}],null,{},[null]])await assert.rejects(()=>save(f,d),code('22023'));assert.deepEqual(await counts(),before);
});
test('040 transaction failure rolls back receipt/head/command and retry of identical command creates one revision',async()=>{
 const f=await fixture(),cmd=randomUUID(),before=await counts();await db.exec("create function public.synthetic_tax_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic rollback' using errcode='P0001';end$$;create trigger synthetic_tax_failure before insert on erp_fiscal_tax.command for each row execute function public.synthetic_tax_failure();");
 await assert.rejects(()=>save(f,[],0,cmd),code('P0001'));assert.deepEqual(await counts(),before);await db.exec('drop trigger synthetic_tax_failure on erp_fiscal_tax.command;drop function public.synthetic_tax_failure();');
 const r=await save(f,[],0,cmd);assert.equal(r.record.version,1);assert.equal((await save(f,[],0,cmd)).replayed,true);assert.equal(await scalar('select count(*) value from erp_fiscal_tax.revision where draft_id=$1',[f.draft.record.id]),1);
});
test('040 history is metadata only, scoped, descending/exclusive and current GET never rebases receipts',async()=>{
 const f=await fixture();for(let v=0;v<4;v++)await save(f,[],v);
 const first=await api(f.draft.record.id,'/history?limit=2');assert.deepEqual(first.items.map(x=>x.version),[4,3]);assert.equal(first.next_cursor,3);const second=await api(f.draft.record.id,'/history?limit=2&before=3');assert.deepEqual(second.items.map(x=>x.version),[2,1]);assert.equal(second.next_cursor,null);
 assert.doesNotMatch(JSON.stringify(first),/decisions|identifiers|actor|command_id|credit_rate/);await assert.rejects(()=>get(f.draft.record.id,5),code('P0002'));await assert.rejects(()=>get(randomUUID()),code('P0002'));
});
test('040 prepared identifiers remain captured even when the current catalog changes; bindings and exhausted head reject atomically',async()=>{
 const f=await fixture(),first=await save(f),before=await counts();
 await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:product.id,p_expected_version:product.version,p_command_id:randomUUID(),p_data:{ncm:'12345678'}});product={...product,version:product.version+1};
 assert.equal((await get(f.draft.record.id)).record.items[0].identifiers.ncm,'82055900');assert.deepEqual((await get(f.draft.record.id)).record,first.record);
 for(const change of[{p_snapshot_hash:'a'.repeat(64)},{p_expected_draft_version:2},{p_item_preparation_version:2},{p_expected_version:0}])await assert.rejects(()=>rpc('erp_fiscal_tax_save',{...args(f,[],1),...change,p_command_id:randomUUID()}),code('40001'));
 assert.deepEqual(await counts(),before);
 const g=await fixture(),candidate=(await preview(g)).record,cmd=randomUUID();candidate.version=2147483647;candidate.created_at=new Date().toISOString();
 await db.exec('begin');try{
  await db.query('insert into erp_fiscal_tax.command(command_id,actor,request_hash,result)values($1,$2,$3,$4)',[cmd,users.fiscal,'0'.repeat(64),JSON.stringify(candidate)]);
  await db.query('insert into erp_fiscal_tax.revision(draft_id,version,draft_version,item_preparation_version,snapshot_hash,record,actor,command_id)values($1,2147483647,1,1,$2,$3,$4,$5)',[g.draft.record.id,g.draft.record.snapshot_hash,JSON.stringify(candidate),users.fiscal,cmd]);
  await db.query('insert into erp_fiscal_tax.head values($1,2147483647)',[g.draft.record.id]);await db.exec('commit');
 }catch(e){await db.exec('rollback');throw e;}
 const exhausted=await counts();await assert.rejects(()=>save(g,[],2147483647),code('40001'));assert.deepEqual(await counts(),exhausted);
});
test('040 HTTP rejects forged scope/trust/unknown fields, encoding, body limits, invalid actors and leaked upstream flags',async()=>{
 const f=await fixture(),id=f.draft.record.id,body=input(f,[choice(f)]);for(const [path,method]of[['/save','GET'],['','POST'],['?version=01','GET'],['/history?limit=26','GET'],['/history?before=0','GET'],['?version=1&version=2','GET'],['?actor=another','GET']])await assert.rejects(()=>api(id,path,method),e=>[400,405].includes(e.status));
 for(const change of[{can_emit:true},{expected_version:'0'},{operation:'automatic'},{item_preparation_version:0},{snapshot_hash:['a'.repeat(64)]},{command_id:null}])await assert.rejects(()=>api(id,'/save','POST',{...body,...change}),e=>e.status===400);
 for(const [headers,text]of[[{'content-encoding':'gzip'},JSON.stringify(body)],[{},' '.repeat(524289)]])await assert.rejects(()=>parseFiscalTaxRoute(new Request(`https://synthetic.invalid/v1/preparacao-tributaria/${id}/save`,{method:'POST',headers:{'content-type':'application/json',...headers},body:text})),e=>e.status===400);
 const route=await parseFiscalTaxRoute(new Request(`https://synthetic.invalid/v1/preparacao-tributaria/${id}`));for(const userId of[null,undefined,{},123,'invalid'])await assert.rejects(()=>executeFiscalTaxRoute(route,{userId,rpc:()=>assert.fail('actor reached RPC')}),e=>e.status===401);
 assert.equal((await api(id.toUpperCase())).current.tax_version,0);const saved=await api(id,'/save','POST',body);
 for(const mutate of[v=>v.can_emit=true,v=>v.record.items[0].decisions.cfop='5405',v=>v.record.items[0].pending=[],v=>v.record.item_preparation_version=2,v=>v.record.draft_id=randomUUID(),v=>v.record.items[0].identifiers.origin='9',v=>v.current.matches_current_draft=false]){const wrong=structuredClone(saved);mutate(wrong);await assert.rejects(()=>api(id,'/save','POST',body,async()=>wrong),e=>e.status===502);}
 const extra=structuredClone(saved);extra.private='HIDDEN';extra.record.actor='HIDDEN';extra.record.items[0].raw='HIDDEN';assert.doesNotMatch(JSON.stringify(await api(id,'/save','POST',body,async()=>extra)),/HIDDEN/);
});
test('040 request deadline includes stalled body and cancels the stream',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;const request=new Request(`https://synthetic.invalid/v1/preparacao-tributaria/${randomUUID()}/save`,{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'});const reading=parseFiscalTaxRoute(request);t.mock.timers.tick(10001);await assert.rejects(()=>reading,e=>e.status===408);assert.equal(cancelled,true);
});
test('040 250-item receipts stay below the 1MiB persistence and 2MiB HTTP limits without duplicating commercial snapshots',async()=>{
 const f=await fixture('55',250),d=f.draft.record.snapshot.items.map(i=>choice(f,{item_id:i.id,review_note:'é'.repeat(500),icms:{csosn:'101',credit_rate:'4.7900',credit_period:'2026-10',credit_evidence:'ç'.repeat(250)}}));
 const r=await api(f.draft.record.id,'/save','POST',input(f,d));assert.equal(r.record.items.length,250);const bytes=Buffer.byteLength(JSON.stringify(r));assert.ok(bytes<FISCAL_TAX_RESPONSE_BYTES);assert.ok(Buffer.byteLength(JSON.stringify(r.record))<1048576);assert.doesNotMatch(JSON.stringify(r),/unit_price|quantity|contact_id/);console.log(`040 synthetic 250-item DTO: ${bytes} bytes / ${FISCAL_TAX_RESPONSE_BYTES}`);
});
