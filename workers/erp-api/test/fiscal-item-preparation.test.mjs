import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {prepareFiscalItems,gtinCheckDigitMatches} from '../../../packages/fiscal-core/src/item-preparation.mjs';
import {parseFiscalItemRoute,executeFiscalItemRoute,FISCAL_ITEM_RESPONSE_BYTES} from '../src/fiscal-item-preparation.mjs';

// Local synthetic state only. PGlite verifies transactions, not true multi-session lock interleavings.
let db,contact,product;const users={};
const code=c=>e=>e.code===c;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){
 const pairs=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}
 finally{await db.exec('reset role');}
}
const catalog=async(data,id=null,version=0)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data})).record;
const draftCommand=(action,data)=>rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:action,p_data:data});
const get=(id,version=null,user=users.fiscal)=>rpc('erp_fiscal_item_get',{p_user_id:user,p_draft_id:id,p_version:version});
const basis=d=>rpc('erp_fiscal_draft_review',{p_user_id:users.fiscal,p_id:d.record.id,p_revision:d.record.version});
function args(d,decisions=[],version=0){return{p_user_id:users.fiscal,p_draft_id:d.record.id,p_expected_draft_version:d.record.version,p_snapshot_hash:d.record.snapshot_hash,p_expected_version:version,p_decisions:decisions};}
const preview=(d,decisions=[],version=0)=>rpc('erp_fiscal_item_preview',args(d,decisions,version));
const save=(d,decisions=[],version=0,command=randomUUID())=>rpc('erp_fiscal_item_save',{...args(d,decisions,version),p_command_id:command});
const input=(d,decisions=[],version=0,command=randomUUID())=>({expected_draft_version:d.record.version,snapshot_hash:d.record.snapshot_hash,expected_version:version,decisions,command_id:command});
async function api(id,path='',method='GET',body,port=rpc){
 const request=new Request(`https://synthetic.invalid/v1/preparacao-itens-fiscais/${id}${path}`,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 return executeFiscalItemRoute(await parseFiscalItemRoute(request),{userId:users.fiscal,rpc:port});
}
function body(count=2){return{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},(_,i)=>({...(i%2===0?{product_id:product.id}:{}),description:'Linha sintética',unit:'UN',quantity:'1.230000',unit_price:'10.0000',discount_percent:'0'})),internal_notes:'NEVER-EXPOSE-THIS'};}
async function fixture(data=body()){
 const document=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:data})).document;
 return{document,draft:await draftCommand('create',{source_document_id:document.id,expected_source_version:document.version,model:'55',preparation:{operation_nature:'Venda fictícia',notes:null}})};
}
const choices=d=>[{item_id:d.record.snapshot.items[0].id,fields:{ncm:{source:'catalog',expected_product_id:product.id,expected_version:product.version},origin:{source:'manual',value:'0'},cest:{source:'manual',value:null},gtin:{source:'manual',value:'6291041500213'},gtin_tax:{source:'manual',value:'SEM GTIN'}}}];
const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_items.head),(select count(*)from erp_fiscal_items.revision),(select count(*)from erp_fiscal_items.command),(select count(*)from erp_fiscal_drafts.revision),(select count(*)from erp_fiscal_drafts.command),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title),(select sum(last_number)from erp_documents.numbering)) value");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','estoque','vendas','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato fictício',person_type:'J',document:'11222333000181',street:'Rua fictícia',number:'1',district:'Centro',city:'Piracicaba',state:'SP',postal_code:'13400000'}})).record;
 product=await catalog({name:'Produto fictício',code:'FICT-035',unit:'UN',kind:'P',format:'S',ncm:'00000000',gtin:'SEM GTIN',origin:'0',cest:'1234567',gtin_tax:'SEM GTIN'});
});
after(()=>db?.close());

test('035 preview is read-only, distinguishes manual null/unreviewed and matches the pure resolver exactly',async()=>{
 const {draft}=await fixture(),decisions=choices(draft),before=await counts();
 const empty=await get(draft.record.id);assert.equal(empty.record,null);assert.equal(empty.current.preparation_version,0);
 const raw=await preview(draft,decisions),b=await basis(draft);
 const pure=prepareFiscalItems({basis:b,expected:{draft_id:draft.record.id,draft_version:1,snapshot_hash:draft.record.snapshot_hash},decisions});
 assert.deepEqual(raw.record.items,pure.items);assert.equal(raw.persisted,false);assert.equal(raw.record.created_at,null);assert.deepEqual(await counts(),before);
 const item=raw.record.items[0];assert.equal(item.fields.cest.value,null);assert.equal(item.fields.cest.provenance.source,'manual');assert.equal(raw.record.items[1].fields.cest.provenance.source,'unreviewed');
 const {command_id,...httpInput}=input(draft,decisions);assert.deepEqual((await api(draft.record.id,'/preview','POST',httpInput)).record.items,pure.items);
 assert.equal((await api(draft.record.id)).record,null);
});
test('035 save preserves commercial values and creates immutable audit receipts with all effects false',async()=>{
 const {draft,document}=await fixture(),before=await counts(),saved=await api(draft.record.id,'','POST',input(draft,choices(draft)));
 assert.equal(saved.record.version,1);assert.equal(saved.current.preparation_version,1);assert.equal(saved.current.matches_current_draft,true);assert.equal(saved.replayed,false);
 for(const k of['operational_effects','emission_enabled','can_emit','tax_rules_validated','xsd_validated','catalog_registry_verified'])assert.equal(saved[k],false);
 assert.deepEqual(saved.draft.record.snapshot,draft.record.snapshot);assert.equal(saved.draft.record.snapshot.items[0].quantity,'1.230000');assert.equal(saved.draft.record.snapshot.items[0].unit_price,'10.0000');
 assert.deepEqual((await counts()).slice(3),before.slice(3));assert.equal(await scalar('select version value from erp_documents.document where id=$1',[document.id]),document.version);
 for(const table of['revision','command'])await assert.rejects(()=>db.exec(`update erp_fiscal_items.${table} set ${table==='revision'?'record=record':'result=result'}`),code('42501'));
 assert.doesNotMatch(JSON.stringify(saved),/NEVER-EXPOSE-THIS|command_id|actor|request_hash/);
});
test('035 active admin/fiscal only, ACL before replay, private tables and helpers denied even to service role',async()=>{
 const {draft}=await fixture(),command=randomUUID(),a={...args(draft),p_command_id:command};await rpc('erp_fiscal_item_save',a);
 for(const role of['consulta','estoque','vendas','financeiro']){
  await assert.rejects(()=>get(draft.record.id,null,users[role]),code('42501'));
  await assert.rejects(()=>rpc('erp_fiscal_item_save',{...a,p_user_id:users[role]}),code('42501'));
 }
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>rpc('erp_fiscal_item_save',a),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 for(const role of['anon','authenticated','service_role']){
  await db.exec('set role '+role);try{
   await assert.rejects(()=>scalar('select count(*) value from erp_fiscal_items.revision'),code('42501'));
   await assert.rejects(()=>scalar('select erp_fiscal_items.flags() value'),code('42501'));
   if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_fiscal_item_get($1,$2) value',[users.admin,draft.record.id]),code('42501'));
  }finally{await db.exec('reset role');}
 }
 assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_items' and c.relkind='r'"),true);
});
test('035 head CAS is global across draft versions; refresh never transfers previous decisions',async()=>{
 const {draft,document}=await fixture(),first=await save(draft,choices(draft));
 await assert.rejects(()=>save(draft,[],0),code('40001'));
 const refreshed=await draftCommand('refresh',{id:draft.record.id,expected_version:1,expected_source_version:document.version});
 const stale=await get(draft.record.id);assert.deepEqual(stale.record,first.record);assert.equal(stale.current.matches_current_draft,false);assert.equal(stale.draft.current.version,2);
 await assert.rejects(()=>save(draft,[],1),code('40001'));await assert.rejects(()=>save(refreshed,[],0),code('40001'));
 const next=await save(refreshed,[],1);assert.equal(next.record.version,2);assert.equal(next.record.draft_version,2);
 for(const f of Object.values(next.record.items[0].fields))assert.equal(f.provenance.source,'unreviewed');
 assert.deepEqual((await get(draft.record.id,1)).record,first.record);
});
test('035 command replay returns original receipt plus live context after a newer preparation/archive',async()=>{
 const {draft}=await fixture(),command=randomUUID(),d=choices(draft),a={...args(draft,d),p_command_id:command};
 const first=await rpc('erp_fiscal_item_save',a);await save(draft,[],1);
 await draftCommand('archive',{id:draft.record.id,expected_version:1,reason:'Arquivo sintético'});
 const replay=await api(draft.record.id,'','POST',input(draft,d,0,command));assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.current.preparation_version,2);assert.equal(replay.draft.current.status,'archived');assert.equal(replay.current.matches_current_draft,false);
 await assert.rejects(()=>save(draft,[],2),code('40001'));
 await assert.rejects(()=>rpc('erp_fiscal_item_save',{...a,p_decisions:[]}),code('40001'));
 await assert.rejects(()=>rpc('erp_fiscal_item_save',{...a,p_user_id:users.admin}),code('40001'));
});
test('035 catalog version is checked transactionally and captured values never rebase on historical reads',async()=>{
 const p=await catalog({name:'Produto histórico sintético',unit:'UN',kind:'P',ncm:'12345678',origin:'8',gtin:'SEM GTIN'});
 const data=body(1);data.items[0].product_id=p.id;const {draft}=await fixture(data),item=draft.record.snapshot.items[0].id;
 const decisions=[{item_id:item,fields:{ncm:{source:'catalog',expected_product_id:p.id,expected_version:1},origin:{source:'catalog',expected_product_id:p.id,expected_version:1}}}];
 const saved=await save(draft,decisions);await catalog({ncm:'87654321',origin:'1'},p.id,1);
 assert.deepEqual((await api(draft.record.id)).record,saved.record);await assert.rejects(()=>save(draft,decisions,1),code('40001'));
 decisions[0].fields.ncm.expected_version=2;decisions[0].fields.origin.expected_version=2;
 const newer=await save(draft,decisions,1);assert.equal(newer.record.items[0].fields.ncm.value,'87654321');assert.equal((await get(draft.record.id,1)).record.items[0].fields.ncm.value,'12345678');
 const pure=prepareFiscalItems({basis:await basis(draft),expected:{draft_id:draft.record.id,draft_version:1,snapshot_hash:draft.record.snapshot_hash},decisions});assert.deepEqual(newer.record.items,pure.items);
});
test('035 exact binding, item identity and fields reject stale/foreign/duplicate/coerced or commercial edits atomically',async()=>{
 const {draft}=await fixture(),i=draft.record.snapshot.items[0],base=choices(draft),before=await counts();
 for(const [change,error]of[[{p_expected_draft_version:2},'40001'],[{p_snapshot_hash:'b'.repeat(64)},'40001'],[{p_expected_version:-1},'22023'],[{p_expected_version:2147483647},'40001']])await assert.rejects(()=>rpc('erp_fiscal_item_save',{...args(draft,base),...change,p_command_id:randomUUID()}),code(error));
 const badDecisions=[null,{},[null],[...base,...base],[{item_id:randomUUID(),fields:{ncm:{source:'manual',value:null}}}],
  [{item_id:i.id,fields:{unit_price:{source:'manual',value:'0.00'}}}],
  [{item_id:i.id,fields:{ncm:{source:'manual',value:12345678}}}],
  [{item_id:i.id,fields:{ncm:{source:'manual',value:' 12345678'}}}],
  [{item_id:i.id,fields:{origin:{source:'manual',value:'9'}}}],
  [{item_id:i.id,fields:{gtin:{source:'manual',value:'6291041500214'}}}],
  [{item_id:i.id,fields:{cest:{source:'manual',value:'１２３４５６７'}}}],
  [{item_id:i.id,fields:{ncm:{source:'manual'}}}],
  [{item_id:i.id,fields:{ncm:{source:'catalog',expected_product_id:randomUUID(),expected_version:1}}}],
  [{item_id:draft.record.snapshot.items[1].id,fields:{ncm:{source:'catalog',expected_product_id:product.id,expected_version:1}}}]];
 for(const d of badDecisions)await assert.rejects(()=>save(draft,d),code('22023'));
 assert.deepEqual(await counts(),before);
});
test('035 SQL and JS agree on structural identifiers, GS1 digit, explicit null and SEM GTIN edge cases',async()=>{
 const {draft}=await fixture(),item_id=draft.record.snapshot.items[0].id,b=await basis(draft),expected={draft_id:draft.record.id,draft_version:1,snapshot_hash:draft.record.snapshot_hash};
 const cases={ncm:['00','00000000',null,'1','000','123456789','１２',' 00'],origin:['0','8',null,'9',0,'00'],cest:['0000000',null,'123456','12345678',''],gtin:['SEM GTIN',null,'96385074','012345678905','6291041500213','10012345000017','00000000','6291041500214',' SEM GTIN',''],gtin_tax:['SEM GTIN',null,'6291041500213','6291041500214']};
 for(const [field,values]of Object.entries(cases))for(const value of values){
  const d=[{item_id,fields:{[field]:{source:'manual',value}}}];let pure;try{pure=prepareFiscalItems({basis:b,expected,decisions:d});}catch{/* Both must reject. */}
  if(pure)assert.deepEqual((await preview(draft,d)).record.items,pure.items,`${field}:${value}`);
  else await assert.rejects(()=>preview(draft,d),code('22023'),`${field}:${value}`);
 }
 for(const value of['96385074','012345678905','6291041500213','10012345000017','6291041500214'])assert.equal(await scalar('select erp_fiscal_items.gtin_valid($1) value',[value]),gtinCheckDigitMatches(value));
});
test('035 source transitions and both operational bridges remain independent; no extra commercial effects',async()=>{
 const warehouse=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'warehouses',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Depósito sintético 035'}})).record;
 await rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-16',p_reason:'Estoque sintético',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity:'2',expected_version:0}]});
 const data=body(1);data.warehouse_id=warehouse.id;data.items[0].quantity='1';data.items[0].unit_price='10';data.installments=[{due_date:'2026-11-01',amount:'10.00'}];
 const {draft,document}=await fixture(data);
 let current=document;for(const status of['open','verified'])current=(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:current.id,p_expected_version:current.version,p_command_id:randomUUID(),p_status:status,p_reason:'Teste sintético'})).document;
 const scope={p_user_id:users.admin,p_kind:'sales_orders',p_document_id:current.id,p_expected_version:current.version};
 const financePreview=await rpc('erp_document_finance_preview',scope);
 const posted=await rpc('erp_document_finance_post',{...scope,p_command_id:randomUUID(),p_preview_hash:financePreview.preview.preview_hash});
 const stockScope={p_user_id:users.admin,p_kind:'sales_orders',p_document_id:document.id,p_expected_version:posted.document_version,p_occurred_on:'2026-10-16',p_reason:'Saída sintética'};
 const stockPreview=await rpc('erp_document_stock_preview',stockScope);
 const stock=await rpc('erp_document_stock_post',{...stockScope,p_command_id:randomUUID(),p_preview_hash:stockPreview.preview.preview_hash,p_ignored_item_ids:[]});
 const before=await counts(),saved=await save(draft,choices(draft));assert.equal(saved.draft.current.source_changed,true);assert.equal(saved.draft.current.source_document_version,stock.document_version);
 assert.deepEqual((await counts()).slice(3),before.slice(3));
 const refreshed=await draftCommand('refresh',{id:draft.record.id,expected_version:1,expected_source_version:stock.document_version});
 assert.equal(refreshed.current.source_changed,false);assert.equal((await get(draft.record.id)).current.matches_current_draft,false);
 const cancelled=await fixture();await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:cancelled.document.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'cancelled',p_reason:'Cancelamento sintético'});
 await assert.rejects(()=>save(cancelled.draft),code('40001'));
});
test('035 history keyset is descending/exclusive and scoped to the requested draft',async()=>{
 const {draft}=await fixture();for(let v=0;v<4;v++)await save(draft,[],v);
 const first=await api(draft.record.id,'/history?limit=2');assert.deepEqual(first.items.map(x=>x.version),[4,3]);assert.equal(first.next_cursor,3);
 const next=await api(draft.record.id,'/history?limit=2&before=3');assert.deepEqual(next.items.map(x=>x.version),[2,1]);assert.equal(next.has_more,false);assert.equal(next.next_cursor,null);
 assert.equal((await api(draft.record.id,'?version=2')).record.version,2);assert.doesNotMatch(JSON.stringify(first),/items_resolved|actor|command_id|fields|snapshot\":/);
 await assert.rejects(()=>get(draft.record.id,5),code('P0002'));await assert.rejects(()=>get(randomUUID()),code('P0002'));
});
test('035 HTTP rejects asserted provenance/results, invalid methods/query/body/byte limits',async()=>{
 const {draft}=await fixture(),id=draft.record.id;
 for(const [path,method]of[['/preview','GET'],['','DELETE'],['?version=01','GET'],['?version=1&version=2','GET'],['/history?limit=26','GET'],['/history?before=0','GET'],['?actor=another','GET']])await assert.rejects(()=>api(id,path,method),e=>[400,405].includes(e.status));
 for(const change of[{can_emit:true},{expected_version:'0'},{snapshot_hash:[]},{snapshot_hash:['a'.repeat(64)]},{command_id:null},{decisions:[{item_id:draft.record.snapshot.items[0].id,fields:{gtin:{source:'manual',value:'SEM GTIN',verified:true}}}]}])await assert.rejects(()=>api(id,'','POST',{...input(draft),...change}),e=>e.status===400);
 assert.equal(await parseFiscalItemRoute(new Request('https://synthetic.invalid/other')),null);
 assert.equal((await api(id.toUpperCase())).draft.record.id,id);
 const huge=new Request(`https://synthetic.invalid/v1/preparacao-itens-fiscais/${id}`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(262145)});await assert.rejects(()=>parseFiscalItemRoute(huge),e=>e.status===400);
 const encoded=new Request(`https://synthetic.invalid/v1/preparacao-itens-fiscais/${id}`,{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:JSON.stringify(input(draft))});await assert.rejects(()=>parseFiscalItemRoute(encoded),e=>e.status===400);
 const route=await parseFiscalItemRoute(new Request(`https://synthetic.invalid/v1/preparacao-itens-fiscais/${id}`));
 for(const userId of[null,undefined,'not-a-uuid',{},123])await assert.rejects(()=>executeFiscalItemRoute(route,{userId,rpc:()=>assert.fail('invalid actor reached RPC')}),e=>e.status===401);
 assert.equal((await executeFiscalItemRoute(route,{userId:users.fiscal.toUpperCase(),rpc:async(name,args)=>{assert.equal(args.p_user_id,users.fiscal);return rpc(name,args);}})).draft.record.id,id);
});
test('035 request body deadline includes the reader and cancels a stalled request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 const stream=new ReadableStream({cancel(){cancelled=true;}}),id=randomUUID();
 const request=new Request(`https://synthetic.invalid/v1/preparacao-itens-fiscais/${id}`,{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'});
 const reading=parseFiscalItemRoute(request);t.mock.timers.tick(10001);
 await assert.rejects(()=>reading,e=>e.status===408);assert.equal(cancelled,true);
});
test('035 exhausted global preparation counter rejects without overflow or effects',async()=>{
 const {draft}=await fixture(),id=draft.record.id,command=randomUUID();
 const candidate=(await preview(draft)).record;candidate.version=2147483647;candidate.created_at=new Date().toISOString();
 // Owner-only synthetic setup makes the otherwise unreachable int4 boundary practical to test.
 await db.exec('begin');try{
  await db.query('insert into erp_fiscal_items.command(command_id,actor,request_hash,result)values($1,$2,$3,$4)',[command,users.fiscal,'0'.repeat(64),JSON.stringify(candidate)]);
  await db.query('insert into erp_fiscal_items.revision(draft_id,version,draft_version,snapshot_hash,decisions,record,actor,command_id)values($1,2147483647,1,$2,\'[]\',$3,$4,$5)',[id,draft.record.snapshot_hash,JSON.stringify(candidate),users.fiscal,command]);
  await db.query('insert into erp_fiscal_items.head values($1,2147483647)',[id]);await db.exec('commit');
 }catch(error){await db.exec('rollback');throw error;}
 const before=await counts();await assert.rejects(()=>save(draft,[],2147483647),code('40001'));assert.deepEqual(await counts(),before);
 assert.equal((await get(id)).current.preparation_version,2147483647);
});
test('035 DTO rejects contradictory binding, provenance, trust and history while stripping unknown payload',async()=>{
 const {draft}=await fixture(),body=input(draft,choices(draft)),result=await api(draft.record.id,'','POST',body);
 for(const mutate of[v=>v.can_emit=true,v=>v.record.draft_id=randomUUID(),v=>v.record.draft_version=2,v=>v.record.version=2,v=>v.record.snapshot_hash='b'.repeat(64),
  v=>v.current.matches_current_draft=false,v=>v.record.items[0].fields.origin.provenance={source:'unreviewed'},v=>v.record.items[0].fields.ncm.provenance.product_id=randomUUID(),
  v=>v.record.items[0].fields.gtin.check_digit_verified=false,v=>v.record.items[0].pending=[],v=>v.record.items[0].fields.origin.value='1',v=>v.record.items[1].fields.ncm.provenance={source:'manual'}]){
  const wrong=structuredClone(result);mutate(wrong);await assert.rejects(()=>api(draft.record.id,'','POST',body,async()=>wrong),e=>e.status===502);
 }
 const extra=structuredClone(result);extra.actor='PRIVATE';extra.record.secret='PRIVATE';extra.record.items[0].fields.origin.tax_rate='PRIVATE';
 assert.doesNotMatch(JSON.stringify(await api(draft.record.id,'','POST',body,async()=>extra)),/PRIVATE/);
 const hist=await api(draft.record.id,'/history');hist.items[0].draft_id=randomUUID();await assert.rejects(()=>api(draft.record.id,'/history','GET',undefined,async()=>hist),e=>e.status===502);
});
test('035 250-item payload stays within explicit 8MiB ceiling and exact trailing decimals survive',async()=>{
 const data=body(250);data.items=data.items.map((i,index)=>({...i,description:'á'.repeat(200),code:'C'.repeat(100)}));data.notes='á'.repeat(4000);data.payment_terms='á'.repeat(2000);data.delivery_terms='á'.repeat(2000);
 const {draft}=await fixture(data),decisions=draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(['ncm','origin','cest','gtin','gtin_tax'].map(f=>[f,{source:'manual',value:{ncm:'12345678',origin:'8',cest:'1234567',gtin:'6291041500213',gtin_tax:'SEM GTIN'}[f]}]))}));
 const saved=await api(draft.record.id,'','POST',input(draft,decisions));const bytes=Buffer.byteLength(JSON.stringify(saved));assert.ok(bytes<FISCAL_ITEM_RESPONSE_BYTES);assert.equal(saved.record.items.length,250);assert.equal(saved.draft.record.snapshot.items[249].quantity,'1.230000');assert.equal(saved.draft.record.snapshot.items[249].unit_price,'10.0000');
 console.log(`035 synthetic maximum-item DTO: ${bytes} bytes / ${FISCAL_ITEM_RESPONSE_BYTES}`);
 const tooMany=[...decisions,{...decisions[0],item_id:randomUUID()}];await assert.rejects(()=>save(draft,tooMany,1),code('22023'));
});
