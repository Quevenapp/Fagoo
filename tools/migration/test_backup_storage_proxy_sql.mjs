import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {executeHistoryRoute,parseHistoryRoute} from '../../workers/erp-api/src/history.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const bytes=new TextEncoder().encode('<NFe>synthetic-private-backup-policy</NFe>');
const xml=hash(bytes),backup=hash('synthetic-policy-backup'),file=hash('synthetic-policy-member');
const path=`objects/${xml}.xml`;
const roles=['admin','fiscal','consulta','financeiro','vendas','estoque','inactive'];
const users=Object.fromEntries(roles.map((role,index)=>[role,`a0000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`]));
const migration=name=>readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8');
const sqlError=code=>error=>error.code===code;
let db;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function asRole(role,action){await db.exec(`set role ${role}`);try{return await action();}finally{await db.exec('reset role');}}
async function bootstrap(){
 const database=new PGlite();
 await database.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key);
  create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon,authenticated,service_role;
  grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
  create policy synthetic_unrelated_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);`);
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history'])await database.exec(await migration(name));
 return database;
}
before(async()=>{
 db=await bootstrap();await db.exec(await migration('0036_backup_storage_proxy'));
 for(const role of roles){await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active) values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 await db.query("insert into origin_backup.batch(backup_sha,manifest,status) values($1,'{\"counts\":{\"xml\":1,\"issue\":0}}','stored')",[backup]);
 for(const [kind,data] of [['file',{kind:'xml',storage_representation:'object',object_key:path,object_sha256:xml,object_size:bytes.length}],['xml',{sha256:xml,kind:'invoice',model:'55',environment:'1',signature_present:false,protocol_present:false,validation:'structural_only',signature_verified:false,xsd_validated:false}]])
  await db.query('insert into origin_backup.record(backup_sha,kind,file_id,record_no,data) values($1,$2,$3,0,$4::jsonb)',[backup,kind,file,JSON.stringify(data)]);
 await db.query('insert into storage.objects values($1,$2,$3::jsonb)',['origin-backups',path,JSON.stringify({size:bytes.length,mimetype:'application/xml'})]);
 await db.exec("insert into storage.objects values('unrelated-bucket','synthetic-public-policy-test','{}');");
});
after(()=>db?.close());

test('036 is restrictive for both browser roles and preserves private backup configuration',async()=>{
 const policy=(await db.query("select polpermissive,polcmd,array(select rolname from pg_roles where oid=any(polroles) order by rolname) roles from pg_policy where polname='origin_backup_proxy_only' and polrelid='storage.objects'::regclass")).rows[0];
 assert.equal(policy.polpermissive,false);assert.equal(policy.polcmd,'*');assert.deepEqual(policy.roles,['anon','authenticated']);
 assert.equal(await scalar("select relrowsecurity value from pg_class where oid='storage.objects'::regclass"),true);
 assert.equal(await scalar("select public value from storage.buckets where id='origin-backups'"),false);
});

test('036 blocks direct reads, writes and bucket moves despite a permissive generic browser policy',async()=>{
 for(const role of ['anon','authenticated'])await asRole(role,async()=>{
  assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='origin-backups'"),0);
  await assert.rejects(()=>db.query("insert into storage.objects values('origin-backups','forged','{}')"),sqlError('42501'));
  assert.equal((await db.query("update storage.objects set metadata='{}' where bucket_id='origin-backups' returning name")).rows.length,0);
  assert.equal((await db.query("delete from storage.objects where bucket_id='origin-backups' returning name")).rows.length,0);
  assert.equal((await db.query("update storage.objects set bucket_id='unrelated-bucket' where bucket_id='origin-backups' returning name")).rows.length,0);
  await assert.rejects(()=>db.query("update storage.objects set bucket_id='origin-backups' where bucket_id='unrelated-bucket'"),sqlError('42501'));
  assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='unrelated-bucket'"),1);
  const name=`synthetic-${role}`;await db.query("insert into storage.objects values('unrelated-bucket',$1,'{}')",[name]);
  assert.equal((await db.query("update storage.objects set metadata='{\"allowed\":true}' where bucket_id='unrelated-bucket' and name=$1 returning name",[name])).rows.length,1);
  assert.equal((await db.query("delete from storage.objects where bucket_id='unrelated-bucket' and name=$1 returning name",[name])).rows.length,1);
 });
 assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='origin-backups'"),1);
});

test('036 leaves service Storage and membership-gated proxy downloads functional without browser RPC grants',async()=>{
 for(const role of ['anon','authenticated'])await asRole(role,()=>assert.rejects(()=>scalar('select public.erp_history_xml_object($1,$2,$3) value',[users.admin,backup,xml]),sqlError('42501')));
 const route=parseHistoryRoute(new URL(`https://synthetic.invalid/v1/history/xml/${xml}/download?backup=${backup}`));
 const calls=[];
 await asRole('service_role',async()=>{
  assert.equal(await scalar("select count(*)::int value from storage.objects where bucket_id='origin-backups'"),1);
  await db.exec("insert into storage.objects values('origin-backups','synthetic-service-upload','{}');delete from storage.objects where name='synthetic-service-upload';");
  await assert.rejects(()=>db.query('select * from origin_backup.record'),sqlError('42501'));
  const rpc=(name,args)=>{assert.equal(name,'erp_history_xml_object');calls.push(args);return scalar('select public.erp_history_xml_object($1,$2,$3) value',[args.p_user_id,args.p_backup_sha,args.p_xml_sha]);};
  for(const role of ['admin','fiscal','consulta']){
   const result=await executeHistoryRoute(route,{userId:users[role],rpc,fetchObject:async requestPath=>{assert.equal(requestPath,`/storage/v1/object/authenticated/origin-backups/${path}`);return new Response(bytes);}});
   assert.deepEqual(result.bytes,bytes);assert.match(result.filename,/^origin-55-[a-f0-9]{12}\.xml$/);
  }
  assert.equal(calls.length,6);assert.deepEqual(calls[0],calls[1]);
  for(const role of ['financeiro','vendas','estoque','inactive'])await assert.rejects(()=>executeHistoryRoute(route,{userId:users[role],rpc,fetchObject:()=>assert.fail('Storage must not be reached')}),sqlError('42501'));
 });
});

test('036 refuses to claim protection when Storage RLS is disabled or the backup bucket is public',async()=>{
 for(const change of ['alter table storage.objects disable row level security',"update storage.buckets set public=true where id='origin-backups'"]){
  const isolated=await bootstrap();try{
   await isolated.exec(change);await assert.rejects(()=>isolated.exec(migrationText),sqlError('55000'));await isolated.exec('rollback');
   assert.equal((await isolated.query("select count(*)::int n from pg_policy where polname='origin_backup_proxy_only'")).rows[0].n,0);
  }finally{await isolated.close();}
 }
});
const migrationText=await migration('0036_backup_storage_proxy');
