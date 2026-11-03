import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { executeHistoryRoute, parseHistoryRoute, verifiedXmlDownload } from '../src/history.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const backup = hash('synthetic archive');
const otherBackup = hash('uncompleted archive');
const bytes = new TextEncoder().encode('<NFe xmlns="http://www.portalfiscal.inf.br/nfe">SYNTHETIC</NFe>');
const xml = hash(bytes);
const event = hash('synthetic event');
const fileIds = ['invoice','duplicate','event'].map(hash);
const roles = ['admin','consulta','fiscal','vendas','estoque','financeiro'];
const user = Object.fromEntries(roles.map((role,index)=>[role,`c0000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`]));
const key = '35261000000000000190550010000000011000000010';
const object = { bucket:'origin-backups', object_key:`objects/${xml}.xml`, sha256:xml, size:bytes.length, model:'55' };
let db;
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0].value;
const sqlError = code => error => error.code === code;
const list = (id=user.admin,sha=backup,limit=25,offset=0,q=null,model=null,kind=null) => scalar('select public.erp_history_xml($1::uuid,$2,$3::int,$4::int,$5,$6,$7) value',[id,sha,limit,offset,q,model,kind]);
const getObject = (id=user.fiscal,sha=xml) => scalar('select public.erp_history_xml_object($1::uuid,$2,$3) value',[id,backup,sha]);

before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));`);
  for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history'])
    await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
  for(const role of roles){
    await db.query('insert into auth.users values($1)',[user[role]]);
    await db.query('insert into erp_access.membership(user_id,role) values($1,$2)',[user[role],role]);
  }
  for(const [id,status] of [[backup,'stored_with_issues'],[otherBackup,'uploading']])
    await db.query('insert into origin_backup.batch(backup_sha,manifest,status) values($1,$2::jsonb,$3)',[id,JSON.stringify({counts:{xml:3,issue:1}}),status]);
  for(const [index,sha] of [xml,xml,event].entries()){
    const meta={sha256:sha,key,model:index===2?'65':'55',environment:'1',kind:index===2?'event':'invoice',
      protocol:'135260000000001',protocol_present:true,signature_present:true,validation:'structural_only',signature_verified:false,xsd_validated:false,
      ...(index===2?{event_type:'110111',sequence:'1'}:{})};
    const file={kind:'xml',source_path:'NEVER_RETURN_PRIVATE_FILENAME',storage_representation:'object',object_key:`objects/${sha}.xml`,object_sha256:sha,object_size:bytes.length};
    for(const [kind,data]of [['file',file],['xml',meta]])
      await db.query('insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,$2,$3,0,$4::jsonb)',[backup,kind,fileIds[index],JSON.stringify(data)]);
    await db.query("insert into storage.objects values('origin-backups',$1) on conflict do nothing",[`objects/${sha}.xml`]);
  }
  await db.query("insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,'issue',$2,1,'{\"code\":\"INVOICE_PROTOCOL_ABSENT\"}')",[backup,fileIds[1]]);
});
after(async()=>db?.close());

test('history RPCs are service-only and membership is rechecked for all fiscal access',async()=>{
  for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    try{await assert.rejects(()=>list(),sqlError('42501'));await assert.rejects(()=>getObject(),sqlError('42501'));}
    finally{await db.exec('reset role');}
  }
  await db.exec('set role service_role');
  try{
    await assert.rejects(()=>db.query('select * from origin_backup.record'),sqlError('42501'));
    for(const role of roles){
      if(['admin','consulta','fiscal'].includes(role))assert.equal((await list(user[role])).total,2);
      else{await assert.rejects(()=>list(user[role]),sqlError('42501'));await assert.rejects(()=>getObject(user[role]),sqlError('42501'));}
    }
  }finally{await db.exec('reset role');}
  await db.query('update erp_access.membership set active=false where user_id=$1',[user.consulta]);
  await assert.rejects(()=>list(user.consulta),sqlError('42501'));
});

test('historical projection deduplicates bytes, preserves occurrences/issues and makes no fiscal validation claim',async()=>{
  const result=await list();assert.equal(result.total,2);
  const invoice=result.items.find(row=>row.kind==='invoice');
  assert.equal(invoice.occurrences,2);assert.deepEqual(invoice.issues,['INVOICE_PROTOCOL_ABSENT']);
  assert.equal(invoice.signature_verified,false);assert.equal(invoice.xsd_validated,false);
  assert.doesNotMatch(JSON.stringify(result),/source_path|object_key|NEVER_RETURN|payload/);
  assert.equal((await list(user.admin,backup,1,0)).has_more,true);
  assert.equal((await list(user.admin,backup,1,1)).has_more,false);
  assert.equal((await list(user.admin,backup,25,0,null,'65','event')).total,1);
  assert.equal((await list(user.admin,backup,25,0,'%')).total,0);
  assert.equal((await list(user.admin,backup,25,0,'135260000000001')).total,2);
});

test('incomplete backup, invalid filters, missing object and public bucket cannot yield a download',async()=>{
  await assert.rejects(()=>list(user.admin,otherBackup),sqlError('P0002'));
  for(const args of [[0,0,null,null,null],[101,0,null,null,null],[25,100001,null,null,null],[25,0,null,'57',null],[25,0,'\n',null,null]])
    await assert.rejects(()=>list(user.admin,backup,...args),sqlError('22023'));
  assert.deepEqual(await getObject(),object);
  await assert.rejects(()=>getObject(user.admin,hash('missing')),sqlError('P0002'));
  await db.exec("update storage.buckets set public=true where id='origin-backups'");
  await assert.rejects(()=>getObject(),sqlError('P0002'));
  await db.exec("update storage.buckets set public=false where id='origin-backups'");
  const batches=await scalar('select public.erp_history_backups($1::uuid) value',[user.admin]);
  assert.equal(batches.items.find(item=>item.id===otherBackup).available,false);
  assert.doesNotMatch(JSON.stringify(batches),/source_path|manifest/);
});

test('route parser uses bounded exact parameters, never accepts arbitrary storage paths',()=>{
  const route=path=>parseHistoryRoute(new URL(`https://erp.example.test${path}`));
  assert.equal(route('/v1/records/nfe'),null);
  assert.equal(route(`/v1/history/xml?backup=${backup}&limit=100`).args.p_limit,100);
  assert.equal(route(`/v1/history/xml/${xml}/download?backup=${backup}`).kind,'download');
  for(const path of ['/v1/history/backups?secret=x',`/v1/history/xml?backup=${backup}&backup=${backup}`,
    `/v1/history/xml?backup=${backup}&limit=101`,`/v1/history/xml?backup=${backup}&model=57`,
    `/v1/history/xml?backup=${backup}&q=%0A`,`/v1/history/xml/${xml}/download?backup=${backup}&object_key=anything`])
    assert.throws(()=>route(path),error=>error.status===400);
});

test('download verifies fixed object location, byte count and SHA before any bytes are returned',async()=>{
  let fetched;
  const result=await verifiedXmlDownload(object,xml,async path=>{fetched=path;return new Response(bytes);});
  assert.equal(fetched,`/storage/v1/object/authenticated/origin-backups/objects/${xml}.xml`);
  assert.deepEqual(result.bytes,bytes);assert.match(result.filename,/^origin-55-[a-f0-9]{12}\.xml$/);
  for(const changed of [{...object,object_key:'../../auth'},{...object,size:0},{...object,size:9*1024*1024}])
    await assert.rejects(()=>verifiedXmlDownload(changed,xml,()=>assert.fail('fetch forbidden')),error=>error.status===502);
  for(const body of [new Uint8Array(bytes.length-1),new Uint8Array(bytes.length+1),new Uint8Array(bytes.length)])
    await assert.rejects(()=>verifiedXmlDownload(object,xml,async()=>new Response(body)),error=>error.status===502);
  await assert.rejects(()=>verifiedXmlDownload(object,xml,async()=>new Response(bytes,{headers:{'Content-Length':'1'}})),error=>error.status===502);
  await assert.rejects(()=>verifiedXmlDownload(object,xml,async()=>new Response(null,{status:302})),error=>error.status===502);
});

test('HTTP projection strips unknown fields and rejects an upstream claim of verified signature',async()=>{
  const route=parseHistoryRoute(new URL(`https://erp.example.test/v1/history/xml?backup=${backup}`));
  const page=await list();page.items[0].payload='DO_NOT_EXPOSE';
  const result=await executeHistoryRoute(route,{userId:user.fiscal,rpc:async(name,args)=>{
    assert.equal(name,'erp_history_xml');assert.equal(args.p_user_id,user.fiscal);return page;
  }});
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_EXPOSE|payload/);
  page.items[0].signature_verified=true;
  await assert.rejects(()=>executeHistoryRoute(route,{userId:user.fiscal,rpc:async()=>page}),error=>error.status===502);
});
