import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {documentsResponse,documentsRoute} from '../../workers/erp-api/src/documents.mjs';
let db,admin,reader,seller,stock,inactive,contact,special;const docs=[];
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const code=expected=>error=>error.code===expected;
async function role(name,action){await db.exec(`set role ${name}`);try{return await action();}finally{await db.exec('reset role');}}
const rpc=(name,types,args)=>role('service_role',()=>scalar(`select public.${name}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')})value`,args));
const list=({actor=admin,kind='sales_proposals',limit=25,after=null,status=null,q=null,from=null,to=null}={})=>rpc('erp_document_list',['uuid','text','int','uuid','text','text','text','text'],[actor,kind,limit,after,status,q,from,to]);
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0015_document_filters'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 const users=[];
 for(const value of ['admin','consulta','vendas','estoque','admin']){const id=randomUUID();users.push(id);await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[id,value,users.length!==5]);}
 [admin,reader,seller,stock,inactive]=users;
 const saveContact=async data=>(await rpc('erp_catalog_save',['uuid','text','uuid','int','uuid','jsonb'],[admin,'contacts',null,0,randomUUID(),JSON.stringify(data)])).record;
 contact=await saveContact({name:'Cliente Histórico Alpha',code:'ALPHA'});special=await saveContact({name:'Cliente Literal_%',code:'LIT_%'});
 for(let index=0;index<8;index++){
  const body={date:['2024-02-29','2026-10-01','2026-10-15','2026-10-16'][index%4],contact_id:index<4?contact.id:special.id,items:[{description:'Item fictício',unit:'UN',quantity:'1',unit_price:'1'}],notes:'PRIVATE_SEARCH_SENTINEL',internal_notes:'PRIVATE_INTERNAL_SENTINEL'};
  let doc=(await rpc('erp_document_save',['uuid','text','uuid','int','uuid','jsonb'],[admin,'sales_proposals',null,0,randomUUID(),JSON.stringify(body)])).document;
  if(index%2)doc=(await rpc('erp_document_transition',['uuid','text','uuid','int','uuid','text','text'],[admin,'sales_proposals',doc.id,doc.version,randomUUID(),'open',null])).document;
  docs.push(doc);
 }
});
after(async()=>db?.close());
test('015 replaces the old overload, retains private grants and validates membership and kind',async()=>{
 assert.equal(await scalar("select count(*)::int value from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_document_list'"),1);
 assert.equal(await scalar("select to_regprocedure('public.erp_document_list(uuid,text,integer,uuid,text)') is null value"),true);
 for(const apiRole of ['anon','authenticated']){
  assert.equal(await scalar("select has_function_privilege($1,'public.erp_document_list(uuid,text,integer,uuid,text,text,text,text)','EXECUTE')value",[apiRole]),false);
  await assert.rejects(()=>role(apiRole,()=>scalar('select public.erp_document_list($1,$2)value',[admin,'sales_proposals'])),code('42501'));
 }
 for(const actor of [inactive,randomUUID(),stock])await assert.rejects(()=>list({actor}),code('42501'));
 await assert.rejects(()=>list({actor:seller,kind:'purchase_orders'}),code('42501'));
 await assert.rejects(()=>list({kind:'unknown'}),code('42501'));
 assert.equal((await list({actor:reader})).items.length,8);
 const defaultCall=await rpc('erp_document_list',['uuid','text'],[admin,'sales_proposals']);assert.equal(defaultCall.items.length,8);
});
test('literal search covers number, document UUID and frozen contact name/code without searching private text',async()=>{
 assert.deepEqual((await list({q:docs[7].number})).items.map(row=>row.id),[docs[7].id]);
 assert.deepEqual((await list({q:docs[2].id.toUpperCase()})).items.map(row=>row.id),[docs[2].id]);
 assert.equal((await list({q:'  histórico ALPHA  '})).items.length,4);
 for(const q of ['LIT_%','%','_'])assert.equal((await list({q})).items.length,4,q);
 for(const q of ['PRIVATE_SEARCH_SENTINEL','PRIVATE_INTERNAL_SENTINEL',"' OR true --"])assert.equal((await list({q})).items.length,0);
 await rpc('erp_catalog_save',['uuid','text','uuid','int','uuid','jsonb'],[admin,'contacts',contact.id,1,randomUUID(),JSON.stringify({name:'Nome atual diferente',code:'CURRENT'})]);
 assert.equal((await list({q:'Histórico Alpha'})).items.length,4);assert.equal((await list({q:'CURRENT'})).items.length,0);
});
test('inclusive document-date period and canonical status combine with exclusive stable UUID pages',async()=>{
 assert.equal((await list({from:'2026-10-15',to:'2026-10-15'})).items.length,2);
 assert.equal((await list({from:'2026-10-15'})).items.length,4);assert.equal((await list({to:'2024-02-29'})).items.length,2);
 assert.equal((await list({from:'1900-01-01',to:'2099-12-31'})).items.length,8);
 const expected=docs.filter(row=>row.status==='open'&&row.date>='2026-10-01').map(row=>row.id).sort();
 const seen=[];let cursor=null;
 do{const page=await list({limit:1,after:cursor,status:'open',from:'2026-10-01',to:'2026-10-16',q:'Cliente'});
  seen.push(...page.items.map(row=>row.id));assert.equal(page.next_cursor,page.has_more?page.items.at(-1).id:null);cursor=page.next_cursor;
 }while(cursor);
 assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,seen.length);
 // 015 rows no longer feed the worker list DTO (095 does: workers/erp-api/test/document-list-sql.test.mjs); the SQL privacy check stays.
 const result=await list({limit:2,status:'draft',from:'2026-10-01'});
 assert.equal(result.items.length,2);assert.doesNotMatch(JSON.stringify(result.items),/PRIVATE_|notes|snapshot|items.*description/);
});
test('invalid dates, ranges, queries and limits fail; read-only filtering has no side effects',async()=>{
 for(const from of ['','2026-02-29','2026-04-31','2026-13-01','2026-00-01','1899-12-31','2100-01-01',' 2026-10-16','2026-10-16T00:00:00Z'])await assert.rejects(()=>list({from}),code('22023'));
 for(const options of [{from:'2026-10-17',to:'2026-10-16'},{status:'finalized'},{q:'x'.repeat(121)},{q:'private\ncontrol'},{limit:0},{limit:101},{limit:null}])await assert.rejects(()=>list(options),code('22023'));
 const counts=()=>scalar("select jsonb_build_array((select count(*) from erp_documents.document),(select count(*) from erp_documents.command),(select count(*) from erp_documents.audit))value");
 const before=await counts();await db.exec('begin read only');
 try{const result=await list({q:'Cliente',from:'2024-02-29'});assert.equal(result.items.length,8);}finally{await db.exec('rollback');}
 assert.deepEqual(await counts(),before);
});
