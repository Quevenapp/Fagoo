import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {BUCKETS,inspectStorageInventory} from './private-storage-snapshot.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const template=await readFile(new URL('./private-storage-inventory.sql',import.meta.url),'utf8');
const sql="set fagoo.storage_project='synthetic-project';\n"+template;
const journalSchema=`create schema erp_fiscal_authorization;create schema erp_fiscal_reviewed_authorization;create schema erp_fiscal_reconciliation;
create table erp_fiscal_authorization.request(attempt_id uuid primary key,sha256 text,size_bytes integer);
create table erp_fiscal_authorization.result(attempt_id uuid primary key,response_hash text,response_size integer,processed_hash text,processed_size integer);
create table erp_fiscal_reviewed_authorization.observation(attempt_id uuid primary key,sha256 text,size_bytes integer,request_hash text,response_hash text);
create table erp_fiscal_reconciliation.attempt(id uuid primary key,request_hash text,request_size integer);
create table erp_fiscal_reconciliation.artifact(attempt_id uuid primary key,response_hash text,size_bytes integer,evidence jsonb);`;
const exportInventory=async db=>(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.inventory)?.inventory;
const inspect=v=>{const bytes=Buffer.from(JSON.stringify(v));return inspectStorageInventory(bytes,sha(bytes));};
test('private export requires explicit project metadata and contains no hosted destination',()=>{
 assert.match(template,/current_setting\('fagoo\.storage_project'\)/);assert.doesNotMatch(template,/https?:\/\/[^\s]+\.supabase\.co/);
});

test('inventory SQL is readonly, bounded, private, projects only safe metadata and binds encrypted A1 ledger',async()=>{
 const db=new PGlite();try{
  await db.exec(`create schema storage;create schema erp_a1;create table storage.buckets(id text primary key,public boolean not null);create table storage.objects(bucket_id text,name text,metadata jsonb,updated_at timestamptz);create table erp_a1.sealed_object(hash text primary key,credential_id uuid,size_bytes bigint,key_id text);`);
  await db.exec(journalSchema);
  for(const id of Object.keys(BUCKETS))await db.query('insert into storage.buckets values($1,false)',[id]);
  await db.query("insert into storage.buckets values('not-allowlisted',false)");
  const hash=sha('opaque encrypted fixture'),credential='11111111-1111-4111-8111-111111111111';
  await db.query('insert into erp_a1.sealed_object values($1,$2,24,$3)',[hash,credential,'must-never-be-projected']);
  await db.query('insert into storage.objects values($1,$2,$3,now())',['brufap-a1-vault',`credentials/${credential}/${hash}.json`,{size:24,mimetype:'application/json',eTag:'a'.repeat(32),cacheControl:'3600',secret_field:'never-project-this'}]);
  await db.query('insert into storage.objects values($1,$2,$3,now())',['origin-fiscal-xml',`objects/${sha('xml')}.xml`,{size:3,mimetype:'application/xml'}]);
  await db.query('insert into storage.objects values($1,$2,$3,now())',['erp-attachments','old/opaque.bin',{size:0,mimetype:'application/octet-stream'}]);
  await db.query('insert into storage.objects values($1,$2,$3,now())',['not-allowlisted','unknown',{size:55}]);
  const fingerprint=()=>db.query("select (select jsonb_agg(to_jsonb(t)) from storage.objects t)objects,(select jsonb_agg(to_jsonb(t)) from erp_a1.sealed_object t)sealed");
  const before=await fingerprint(),results=await db.exec(sql),inventory=results.flatMap(x=>x.rows??[]).find(x=>x.inventory)?.inventory;
  assert.ok(inventory);assert.equal(inventory.total_objects,3);assert.equal(inventory.unknown_private_bucket_count,1);assert.equal(inventory.truncated,false);assert.equal(inventory.read_only,true);
  const bytes=Buffer.from(JSON.stringify(inventory)),parsed=inspectStorageInventory(bytes,sha(bytes));assert.equal(parsed.withExpectedHash,2);assert.equal(parsed.withoutExpectedHash,1);assert.equal(parsed.inventory.objects.find(x=>x.bucket==='brufap-a1-vault').hash_basis,'a1_sealed_ledger');assert.ok(!bytes.includes('must-never-be-projected')&&!bytes.includes('never-project-this'));assert.deepEqual(await fingerprint(),before);
  await db.exec("update storage.objects set metadata=jsonb_set(metadata,'{size}','25') where bucket_id='brufap-a1-vault'");
  const bad=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.inventory)?.inventory;assert.deepEqual(bad.objects.find(x=>x.bucket==='brufap-a1-vault').issues,['A1_SEALED_REFERENCE_REQUIRED']);assert.throws(()=>inspectStorageInventory(Buffer.from(JSON.stringify(bad)),sha(JSON.stringify(bad))));
  await db.exec("delete from storage.objects;insert into storage.objects select 'erp-attachments','fixture/'||i,jsonb_build_object('size',0),now()from generate_series(1,10002)i");
  const large=(await db.exec(sql)).flatMap(x=>x.rows??[]).find(x=>x.inventory)?.inventory;assert.equal(large.total_objects,10002);assert.equal(large.objects.length,10001);assert.equal(large.truncated,true);assert.throws(()=>inspectStorageInventory(Buffer.from(JSON.stringify(large)),sha(JSON.stringify(large))));
 }finally{await db.close();}
});

test('fiscal journals use exact committed content hash, fail closed on missing/mismatched references',async()=>{
 const db=new PGlite();try{
  await db.exec(`create schema storage;create schema erp_a1;create table storage.buckets(id text primary key,public boolean not null);create table storage.objects(bucket_id text,name text,metadata jsonb,updated_at timestamptz);create table erp_a1.sealed_object(hash text primary key,credential_id uuid,size_bytes bigint);${journalSchema}`);
  for(const id of Object.keys(BUCKETS))await db.query('insert into storage.buckets values($1,false)',[id]);
  const id='11111111-1111-4111-8111-111111111111',qh=sha('request'),rh=sha('response'),oh=sha('observation'),ph=sha('processed');
  await db.query('insert into erp_fiscal_authorization.request values($1,$2,7)',[id,qh]);
  await db.query('insert into erp_fiscal_authorization.result values($1,$2,8,$3,9)',[id,rh,ph]);
  await db.query('insert into erp_fiscal_reviewed_authorization.observation values($1,$2,11,$3,$4)',[id,oh,qh,rh]);
  await db.query('insert into erp_fiscal_reconciliation.attempt values($1,$2,7)',[id,qh]);
  await db.query('insert into erp_fiscal_reconciliation.artifact values($1,$2,8,$3)',[id,rh,{origin:'operational',transport_receipt_hash:oh,transport_receipt_size:11}]);
  const refs=[];for(const namespace of ['authorization','reconciliation']){
   for(const[kind,hash,size]of [['requests',qh,7],['responses',rh,8],['observations',oh,11],...(namespace==='authorization'?[['processed',ph,9]]:[])]){
    const key=`${namespace}/${id}/${kind}/${kind==='processed'?ph:qh}.${kind==='observations'?'json':'xml'}`;
    refs.push({key,hash,size});await db.query('insert into storage.objects values($1,$2,$3,now())',['brufap-fiscal-artifacts',key,{size,mimetype:'application/octet-stream'}]);
   }
  }
  const exported=await exportInventory(db);assert.equal(exported.total_objects,7);assert.equal(inspect(exported).withExpectedHash,7);
  for(const ref of refs){const o=exported.objects.find(o=>o.key===ref.key);assert.equal(o.expected_sha256,ref.hash);assert.equal(o.hash_basis,'fiscal_journal_ledger');assert.deepEqual(o.issues,[]);}
  // A name carrying a request hash cannot be relabeled as content-addressed (including old broken exports).
  for(const basis of ['content_addressed_path',null]){const bad=structuredClone(exported),o=bad.objects.find(o=>o.key.includes('/responses/'));o.hash_basis=basis;o.expected_sha256=basis?qh:null;assert.throws(()=>inspect(bad),{code:'STORAGE_EXPECTED_HASH_INVALID'});}
  for(const change of [o=>o.bucket='erp-attachments',o=>o.key=o.key.replace('/responses/','/unknown/'),o=>o.key=o.key.replace('.xml','.json'),o=>o.metadata.mime_type='text/plain',o=>o.size_bytes=512001]){const bad=structuredClone(exported);change(bad.objects.find(o=>o.key.includes('/responses/')));assert.throws(()=>inspect(bad));}
  const badRequest=structuredClone(exported);badRequest.objects.find(o=>o.key.includes('/requests/')).expected_sha256=rh;assert.throws(()=>inspect(badRequest));
  await db.exec("update storage.objects set metadata=jsonb_set(metadata,'{size}','99') where name like '%/responses/%'");
  const wrongSize=await exportInventory(db);assert.equal(wrongSize.objects.filter(o=>o.issues.includes('FISCAL_JOURNAL_REFERENCE_REQUIRED')).length,2);assert.throws(()=>inspect(wrongSize));
  await db.exec("update storage.objects set metadata=jsonb_set(metadata,'{size}','8') where name like '%/responses/%';delete from erp_fiscal_authorization.result;");
  const missing=await exportInventory(db);for(const kind of ['responses','observations','processed']){const o=missing.objects.find(o=>o.key.startsWith('authorization/')&&o.key.includes('/'+kind+'/'));assert.equal(o.expected_sha256,null);assert.equal(o.hash_basis,null);assert.deepEqual(o.issues,['FISCAL_JOURNAL_REFERENCE_REQUIRED']);}assert.throws(()=>inspect(missing));
  await db.query('insert into storage.objects values($1,$2,$3,now())',['brufap-fiscal-artifacts',`authorization/${id}/unrecognized/${qh}.xml`,{size:7,mimetype:'application/octet-stream'}]);
  const unknown=await exportInventory(db);assert.deepEqual(unknown.objects.find(o=>o.key.includes('/unrecognized/')).issues,['FISCAL_JOURNAL_REFERENCE_REQUIRED']);
 }finally{await db.close();}
});
