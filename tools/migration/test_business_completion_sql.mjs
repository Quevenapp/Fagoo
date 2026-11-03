import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {resolveBusinessCompletion,COMPLETION_FLAGS} from '../../packages/fiscal-core/src/business-completion.mjs';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {parseFiscalCompletionRoute,executeFiscalCompletionRoute} from '../../workers/erp-api/src/fiscal-completion.mjs';
import {completionEnvelope,completionHistory} from '../../apps/erp/src/lib/fiscal-completion-model.ts';

// Entirely synthetic. 046 deliberately absent: persistence cannot reserve or consume a number.
let db,contact,product;const users={};
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
const code=c=>e=>e.code===c;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const companyData={legal_name:'EMPRESA FICTICIA COMPLEMENTO',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'};
async function company(patch={}){const old=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'});return rpc('erp_company_save_identity',{p_user_id:users.admin,p_expected_version:old.record?.version??0,p_command_id:randomUUID(),p_data:{...companyData,...patch}});}
async function regime(){const identity=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'identity'}),fiscal=await rpc('erp_company_get',{p_user_id:users.admin,p_section:'fiscal'});await rpc('erp_company_confirm_fiscal',{p_user_id:users.admin,p_expected_version:fiscal.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Confirmacao ficticia de teste'});}
const completionArgs=(f,version=0,completion=f.completion)=>({p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:f.draft.record.version,p_snapshot_hash:f.draft.record.snapshot_hash,
 p_item_preparation_version:f.item.record.version,p_tax_preparation_version:f.tax.record.version,p_expected_identity_version:f.draft.record.snapshot.company.identity_version,
 p_expected_fiscal_version:f.draft.record.snapshot.company.fiscal_version,p_expected_completion_version:version,p_completion:completion});
const preview=(f,version=0,completion=f.completion)=>rpc('erp_fiscal_completion_preview',completionArgs(f,version,completion));
const save=(f,version=0,completion=f.completion,command=randomUUID())=>rpc('erp_fiscal_completion_save',{...completionArgs(f,version,completion),p_command_id:command});
const get=(f,version=null,uid=users.fiscal)=>rpc('erp_fiscal_completion_get',{p_user_id:uid,p_draft_id:f.draft.record.id,p_version:version});
const httpBody=(f,version=0,completion=f.completion,command)=>Object.fromEntries(Object.entries({...completionArgs(f,version,completion),...(command?{p_command_id:command}:{})}).filter(([key])=>!['p_user_id','p_draft_id'].includes(key)).map(([key,value])=>[key.slice(2),value]));
async function http(f,path='',body,uid=users.fiscal){
 const request=new Request('https://example.invalid/v1/complemento-fiscal/'+f.draft.record.id+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 const route=await parseFiscalCompletionRoute(request),result=(await executeFiscalCompletionRoute(route,{userId:uid,rpc})).body;
 if(route.operation==='history'){if(route.args.p_limit===25)assert.deepEqual(completionHistory(result,f.draft.record.id,route.args.p_before).items,result.items);}
 else{const options=body?{request:body,preview:route.operation==='preview'}:route.args.p_version===null?{}:{version:route.args.p_version};const ui=completionEnvelope(result,f.draft.record.id,options);assert.deepEqual(ui.record,result.record);assert.deepEqual(ui.current,result.current);}
 return result;
}
const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_completion.head),(select count(*)from erp_fiscal_completion.revision),(select count(*)from erp_fiscal_completion.command),(select count(*)from erp_fiscal_tax.revision),(select count(*)from erp_fiscal_items.revision),(select count(*)from erp_fiscal_drafts.revision),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title),(select sum(last_number)from erp_documents.numbering))value");
function partial(value){const recurse=v=>Array.isArray(v)?v.map(recurse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='item_id'?x:recurse(x)])):null;const result=recurse(value);result.payments.items=[];return result;}
async function fixture({model='55',csosn='102',count=2}={}){
 const example=businessFixture({model,csosn,count});
 const document=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},()=>({product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'})),internal_notes:'PRIVATE-COMMERCIAL-DO-NOT-COPY'}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:users.fiscal,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 const item=await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const decisions=example.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}));
 const tax=await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:decisions});
 const{identity,...completion}=example.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);
 const basis={model,items:tax.record.items.map(i=>({item_id:i.item_id,position:i.position,cest:i.identifiers.cest,csosn:i.decisions.icms?.csosn??null}))};
 return{document,draft,item,tax,completion,basis,identity};
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0047_business_completion'])await db.exec(await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 for(const role of['admin','fiscal','consulta','vendas','estoque','financeiro']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[users[role],role]);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 await company();await regime();
});
after(()=>db?.close());
test('047 preview is read-only, partial nulls remain null, SQL/JS pending agree without identity or numbering',async()=>{
 const f=await fixture(),empty=partial(f.completion),before=await counts();assert.equal((await get(f)).record,null);
 await db.exec('begin read only');let r;try{r=await preview(f,0,empty);}finally{await db.exec('rollback');}
 assert.equal(r.persisted,false);assert.equal(r.record.created_at,null);assert.deepEqual(r.record.completion,empty);assert.deepEqual(r.record.pending,resolveBusinessCompletion(empty,f.basis).pending);
 for(const[k,v]of Object.entries(COMPLETION_FLAGS))assert.equal(r[k],v);assert.equal(r.record.completion.totals.vNF,null);assert.ok(r.record.pending.general.includes('EXCLUDED_GROUPS_UNREVIEWED'));
 assert.deepEqual(await counts(),before);assert.equal(await scalar("select to_regclass('erp_fiscal_numbering.reservation')value"),null);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE-COMMERCIAL|cnpj|series|cNF|issuedAt|access_key|unsignedXml|actor|command_id/);
});
test('047 persists only a revision/receipt/head and full explicit completion remains valid for independent builder checks',async()=>{
 for(const model of['55','65']){
  const f=await fixture({model}),before=await counts(),r=await save(f);assert.equal(r.record.version,1);assert.equal(r.current.completion_version,1);assert.equal(r.replayed,false);
  assert.deepEqual(r.record.completion,f.completion);assert.deepEqual(r.record.pending,resolveBusinessCompletion(f.completion,f.basis).pending);assert.deepEqual((await counts()).slice(3),before.slice(3));
  assert.equal(r.arithmetic_verified,false);assert.equal(r.numbering_bound,false);assert.equal(r.can_emit,false);
  const built=buildBusinessXml({draft:f.draft,itemPreparation:f.item,taxPreparation:f.tax,completion:{identity:f.identity,...r.record.completion}});
  assert.match(built.unsignedXml,new RegExp(`<mod>${model}</mod>`));assert.equal(built.numbering_reserved,false);
  // Shape persistence intentionally does not certify the arithmetic supplied by the operator.
  const inconsistent=structuredClone(f.completion);inconsistent.totals.vNF='1.00';const saved=await save(f,1,inconsistent);assert.equal(saved.arithmetic_verified,false);
  assert.throws(()=>buildBusinessXml({draft:f.draft,itemPreparation:f.item,taxPreparation:f.tax,completion:{identity:f.identity,...saved.record.completion}}),e=>e.code==='BUSINESS_ARITHMETIC_MISMATCH');
 }
});
test('047 exact shapes, strings, decimal precision, explicit profile choices and item order match the JS validator',async()=>{
 const f=await fixture(),cases=[];const alter=fn=>{const v=structuredClone(f.completion);fn(v);cases.push(v);};
 for(const value of[null,'0.00','9999999999999.99','10000000000000.00','01.00','1.0',1,true,{},[]])alter(v=>v.totals.vNF=value);
 for(const value of[null,'1.234500','1.234567','0','0.000000','1.0000000','99999999999.123456',1])alter(v=>v.items[0].tributary.quantity=value);
 for(const value of[null,'1','0','99999999999.1234567890','1.12345678901','01.0'])alter(v=>v.items[0].tributary.unit_price=value);
 for(const value of[null,'ACAO FICTICIA','ação fictícia','é'.repeat(2000),'é'.repeat(2001),'x\ny','\x7f','\x85','😀',' ',42])alter(v=>v.additional_information=value);
 for(const value of[null,'01','15','90','03',1])alter(v=>v.payments.items[0].type=value);
 alter(v=>v.identity={number:'1'});alter(v=>v.cnpj=TEST_HOLDER);alter(v=>v.can_emit=true);alter(v=>v.items.reverse());alter(v=>v.items[1].item_id=v.items[0].item_id);alter(v=>v.items.pop());alter(v=>v.items[0].item_id=randomUUID());
 alter(v=>v.items[0].tributary.quantity=undefined);alter(v=>v.operation.tpNF='0');alter(v=>v.recipient.municipality_code='3304557');alter(v=>v.excluded_groups.ibs_cbs='exempt');
 for(const value of cases){let resolved;try{resolved=resolveBusinessCompletion(value,f.basis);}catch{await assert.rejects(()=>preview(f,0,value),code('22023'));continue;}assert.deepEqual((await preview(f,0,value)).record.pending,resolved.pending);}
 const exact=structuredClone(f.completion);exact.items[0].tributary.quantity='1.234567';const pending=(await preview(f,0,exact)).record;assert.equal(pending.completion.items[0].tributary.quantity,'1.234567');assert.ok(pending.pending.items[0].codes.includes('QUANTITY_PRECISION_REVIEW'));
});
test('047 ICMS extras are bound to captured 040 branches, partial choices never fill defaults',async()=>{
 for(const csosn of['101','102','500']){
  const f=await fixture({csosn});for(const v of[f.completion,partial(f.completion)])assert.deepEqual((await preview(f,0,v)).record.pending,resolveBusinessCompletion(v,f.basis).pending);
  const wrong=structuredClone(f.completion);wrong.items[0].icms=csosn==='101'?{credit:null,groups500:{retention:'omit',fcp:null,effective:null}}:{credit:{base:null,amount:null},groups500:null};await assert.rejects(()=>preview(f,0,wrong),code('22023'));assert.throws(()=>resolveBusinessCompletion(wrong,f.basis));
 }
 const nfc=await fixture({model:'65'});for(const change of[v=>v.operation.indFinal='0',v=>v.recipient.indIEDest='1']){const c=structuredClone(nfc.completion);change(c);await assert.rejects(()=>preview(nfc,0,c),code('22023'));assert.throws(()=>resolveBusinessCompletion(c,nfc.basis));}
});
test('047 all basis CAS fields and completion CAS reject stale writes atomically',async()=>{
 const f=await fixture(),before=await counts();
 for(const patch of[{p_expected_draft_version:2},{p_snapshot_hash:'0'.repeat(64)},{p_item_preparation_version:2},{p_tax_preparation_version:2},{p_expected_identity_version:999},{p_expected_fiscal_version:999},{p_expected_completion_version:1}])await assert.rejects(()=>rpc('erp_fiscal_completion_save',{...completionArgs(f),...patch,p_command_id:randomUUID()}),code('40001'));
 assert.deepEqual(await counts(),before);const command=randomUUID(),first=await save(f,0,f.completion,command);await assert.rejects(()=>save(f),code('40001'));
 const old=structuredClone(f.completion);const newer=structuredClone(old);newer.additional_information='REVISAO FICTICIA POSTERIOR';await save(f,1,newer);
 const replay=await save(f,0,old,command);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.current.completion_version,2);assert.deepEqual((await get(f)).record.completion,newer);
 await assert.rejects(()=>save(f,0,newer,command),code('40001'));await assert.rejects(()=>rpc('erp_fiscal_completion_save',{...completionArgs(f),p_user_id:users.admin,p_command_id:command}),code('40001'));
});
test('047 old receipts stay historical after new 040/022, company change and archive',async()=>{
 const f=await fixture(),cmd=randomUUID(),first=await save(f,0,f.completion,cmd),savedArgs=completionArgs(f);
 await rpc('erp_fiscal_tax_save',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_expected_version:1,p_operation:'internal_normal_sale',p_decisions:f.tax.record.items.map(i=>i.decisions),p_command_id:randomUUID()});
 await assert.rejects(()=>save(f,1),code('40001'));let replay=await save(f,0,f.completion,cmd);assert.deepEqual(replay.record,first.record);assert.equal(replay.current.matches_current_tax_preparation,false);
 await company({trade_name:'EMPRESA FICTICIA ALTERADA'});replay=await save(f,0,f.completion,cmd);assert.equal(replay.current.company_changed,true);assert.equal(replay.current.matches_current_company,false);await assert.rejects(()=>save(f,1),code('40001'));
 await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:f.draft.record.id,expected_version:1,reason:'Arquivo ficticio'}});
 replay=await rpc('erp_fiscal_completion_save',{...savedArgs,p_command_id:cmd});assert.deepEqual(replay.record,first.record);assert.equal(replay.current.draft_status,'archived');assert.equal(replay.current.matches_current_draft,false);
 await company();await regime();
});
test('047 role checks precede replay, helpers/tables are private and history is immutable',async()=>{
 const f=await fixture(),cmd=randomUUID();await save(f,0,f.completion,cmd);
 for(const role of['consulta','vendas','estoque','financeiro']){await assert.rejects(()=>get(f,null,users[role]),code('42501'));await assert.rejects(()=>rpc('erp_fiscal_completion_save',{...completionArgs(f),p_user_id:users[role],p_command_id:cmd}),code('42501'));}
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.fiscal]);await assert.rejects(()=>save(f,0,f.completion,cmd),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.fiscal]);
 for(const table of['revision','command'])await assert.rejects(()=>db.exec(`update erp_fiscal_completion.${table} set ${table==='revision'?'record=record':'result=result'}`),code('42501'));
 await assert.rejects(()=>db.query('update erp_fiscal_completion.head set version=version+2 where draft_id=$1',[f.draft.record.id]),code('40001'));
 for(const role of['anon','authenticated','service_role']){await db.exec('set role '+role);try{await assert.rejects(()=>scalar('select count(*)value from erp_fiscal_completion.revision'),code('42501'));await assert.rejects(()=>scalar('select erp_fiscal_completion.flags()value'),code('42501'));if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_fiscal_completion_get($1,$2)value',[users.admin,f.draft.record.id]),code('42501'));}finally{await db.exec('reset role');}}
 assert.equal(await scalar("select bool_and(relrowsecurity)value from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='erp_fiscal_completion'and c.relkind='r'"),true);
});
test('047 failure on command insertion rolls back the entire revision and retry uses one command',async()=>{
 const f=await fixture(),cmd=randomUUID(),before=await counts();await db.exec("create function public.synthetic_completion_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic rollback'using errcode='P0001';end$$;create trigger synthetic_completion_failure before insert on erp_fiscal_completion.command for each row execute function public.synthetic_completion_failure();");
 await assert.rejects(()=>save(f,0,f.completion,cmd),code('P0001'));assert.deepEqual(await counts(),before);await db.exec('drop trigger synthetic_completion_failure on erp_fiscal_completion.command;drop function public.synthetic_completion_failure();');
 const saved=await save(f,0,f.completion,cmd);assert.equal(saved.record.version,1);assert.equal((await save(f,0,f.completion,cmd)).replayed,true);
});
test('047 history paginates metadata only and scopes versions to the draft',async()=>{
 const f=await fixture();for(let version=0;version<4;version++)await save(f,version);
 const query={p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_limit:2,p_before:null},first=await rpc('erp_fiscal_completion_history',query),second=await rpc('erp_fiscal_completion_history',{...query,p_before:first.next_cursor});
 assert.deepEqual(first.items.map(i=>i.version),[4,3]);assert.equal(first.has_more,true);assert.deepEqual(second.items.map(i=>i.version),[2,1]);assert.equal(second.next_cursor,null);
 assert.ok(first.items.every(i=>!('completion'in i)&&!('item_basis'in i)&&!('pending'in i)&&!('actor'in i)));assert.equal((await get(f,1)).record.version,1);
 await assert.rejects(()=>get(f,5),code('P0002'));await assert.rejects(()=>rpc('erp_fiscal_completion_history',{...query,p_limit:26}),code('22023'));
});
test('047 exhausted int4 heads and new 035/pedido versions cannot be silently rebased',async()=>{
 const f=await fixture(),r=(await preview(f)).record,cmd=randomUUID();r.version=2147483647;r.created_at=new Date().toISOString();
 await db.exec('begin');try{
  await db.query('insert into erp_fiscal_completion.command(command_id,actor,request_hash,result)values($1,$2,$3,$4)',[cmd,users.fiscal,'0'.repeat(64),JSON.stringify(r)]);
  await db.query('insert into erp_fiscal_completion.revision(draft_id,version,draft_version,item_preparation_version,tax_preparation_version,snapshot_hash,record,actor,command_id)values($1,2147483647,1,1,1,$2,$3,$4,$5)',[f.draft.record.id,f.draft.record.snapshot_hash,JSON.stringify(r),users.fiscal,cmd]);
  await db.query('insert into erp_fiscal_completion.head values($1,2147483647)',[f.draft.record.id]);await db.exec('commit');
 }catch(e){await db.exec('rollback');throw e;}
 const before=await counts();await assert.rejects(()=>save(f,2147483647),code('40001'));assert.deepEqual(await counts(),before);
 const newer=await fixture();await rpc('erp_fiscal_item_save',{p_user_id:users.fiscal,p_draft_id:newer.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:newer.draft.record.snapshot_hash,p_expected_version:1,p_decisions:[],p_command_id:randomUUID()});
 await assert.rejects(()=>save(newer),code('40001'));
 const changed=await fixture();await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:'sales_orders',p_id:changed.document.id,p_expected_version:1,p_command_id:randomUUID(),p_status:'open',p_reason:'Atualizacao ficticia'});await assert.rejects(()=>save(changed),code('40001'));
 for(const field of['p_expected_identity_version','p_expected_fiscal_version','p_expected_draft_version','p_item_preparation_version','p_tax_preparation_version'])await assert.rejects(()=>rpc('erp_fiscal_completion_preview',{...completionArgs(changed),[field]:null}),code('22023'));
});
test('047 250 items preserve exact monetary strings and partial six-place quantities within explicit bounds',async()=>{
 const f=await fixture({csosn:'500',count:250}),v=structuredClone(f.completion);v.additional_information='é'.repeat(2000);v.totals.vNF='9999999999999.99';v.payments.items=Array.from({length:100},()=>({type:null,timing:null,amount:'9999999999999.99'}));
 for(const item of v.items)item.tributary.quantity='99999999999.123456';const r=await http(f,'/save',httpBody(f,0,v,randomUUID()));assert.equal(r.record.completion.items.length,250);assert.equal(r.record.completion.totals.vNF,'9999999999999.99');assert.equal(r.arithmetic_verified,false);assert.deepEqual(r.record.pending,resolveBusinessCompletion(v,f.basis).pending);
 assert.ok(Buffer.byteLength(JSON.stringify(r.record))<1048576);assert.ok(r.record.pending.items.every(i=>i.codes.includes('QUANTITY_PRECISION_REVIEW')));
 const tooMany=structuredClone(v);tooMany.payments.items.push({type:null,timing:null,amount:null});await assert.rejects(()=>preview(f,1,tooMany),code('22023'));
});
test('047 SQL→HTTP keeps partial input, current state and historical receipts distinct across every route',async()=>{
 for(const model of['55','65']){
  const f=await fixture({model}),empty=partial(f.completion),command=randomUUID(),firstBody=httpBody(f,0,empty,command);
  assert.equal((await http(f)).record,null);
  const proposed=await http(f,'/preview',httpBody(f,0,empty));assert.equal(proposed.persisted,false);assert.equal(proposed.record.created_at,null);assert.deepEqual(proposed.record.completion,empty);
  const first=await http(f,'/save',firstBody);assert.equal(first.replayed,false);assert.equal(first.record.version,1);assert.equal(first.current.completion_version,1);
  await http(f,'/save',httpBody(f,1,f.completion,randomUUID()));
  const replay=await http(f,'/save',firstBody);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,first.record);assert.equal(replay.current.completion_version,2);
  assert.deepEqual((await http(f)).record.completion,f.completion);assert.deepEqual((await http(f,'?version=1')).record,first.record);
  const page=await http(f,'/history?limit=1');assert.deepEqual(page.items.map(i=>i.version),[2]);assert.equal(page.next_cursor,2);assert.equal(page.has_more,true);
  const next=await http(f,'/history?limit=1&before=2');assert.deepEqual(next.items.map(i=>i.version),[1]);assert.equal(next.next_cursor,null);assert.ok(!Object.hasOwn(next.items[0],'completion'));
  assert.deepEqual((await http(f,'/history')).items.map(i=>i.version),[2,1]);
  await rpc('erp_fiscal_tax_save',{p_user_id:users.fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_expected_version:1,p_operation:'internal_normal_sale',p_decisions:f.tax.record.items.map(i=>i.decisions),p_command_id:randomUUID()});
  const stale=await http(f,'/save',firstBody);assert.deepEqual(stale.record,first.record);assert.equal(stale.current.matches_current_tax_preparation,false);
  await rpc('erp_fiscal_draft_execute',{p_user_id:users.fiscal,p_command_id:randomUUID(),p_action:'archive',p_data:{id:f.draft.record.id,expected_version:1,reason:'Arquivo ficticio de interop'}});
  const archived=await http(f,'/save',firstBody);assert.deepEqual(archived.record,first.record);assert.equal(archived.current.draft_status,'archived');assert.equal(archived.current.matches_current_draft,false);
  await assert.rejects(()=>http(f,'/save',firstBody,users.consulta),e=>e.status===403);
  assert.doesNotMatch(JSON.stringify(archived),/PRIVATE-COMMERCIAL|cnpj|series|cNF|issuedAt|access_key|unsignedXml|actor|command_id/);
 }
});
