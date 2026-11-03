import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {adoptionReceiptExportSql,adoptionDigest} from './execute_proposal_product_adoption.mjs';

test('manual receipt SQL binds the actual 013 PostgreSQL JSONB request hash and hides foreign receipts',async()=>{
 const db=new PGlite();try{
  await db.exec('create schema erp_catalog;create table erp_catalog.import_review_command(command_id uuid primary key,actor uuid,request_hash text,result jsonb);create table erp_catalog.command(command_id uuid primary key);');
  const actor=randomUUID(),command=randomUUID(),h='a'.repeat(64),ph='b'.repeat(64),at=new Date().toISOString();
  const e={source_id:'1',source_hash:h,source_version:'1',source_seen_at:at,proposal_id:'9',proposal_hash:h,proposal_version:'1',source_active:true,source_simple_product:true,capture:{profile:'origin-price-json-v1',source:'detail',response_sha256:h,capture_id:randomUUID(),observed_at:at,source_hash:h,source_version:'1',numeric_price:true}};
  const plan={profile:'proposal-product-adoption-plan-v1',plan_id:randomUUID(),actor,read_only:true,apply_enabled:false,requires_root_review:true,requires_repreview_before_apply:true,evidence_exported_at:at,batches:[{command_id:command,entity:'products',preview_hash:ph,items:[{source_id:'1',source_hash:h}],evidence:[e],mapper_review:[{}]}]};
  const args={p_user_id:actor,p_entity:'products',p_items:plan.batches[0].items,p_command_id:command,p_preview_hash:ph};
  const sql=adoptionReceiptExportSql(plan,createHash('sha256').update(JSON.stringify(plan)).digest('hex'));
  const read=async()=>(await db.exec(sql)).find(x=>x.rows?.[0]?.receipt_export)?.rows[0].receipt_export;
  let r=await read();assert.equal(r.found,false);assert.equal(r.request_matches,false);assert.equal(r.namespace_conflict,false);assert.equal(r.receipt,null);assert.equal(r.body_hash,adoptionDigest(args));
  const receipt={synthetic:true};
  await db.query("insert into erp_catalog.import_review_command values($1,$2,encode(sha256(convert_to(jsonb_build_object('actor',$2::uuid,'entity','products','items',$3::jsonb,'preview',$4::text)::text,'UTF8')),'hex'),$5)",[command,actor,JSON.stringify(args.p_items),ph,JSON.stringify(receipt)]);
  r=await read();assert.equal(r.found,true);assert.equal(r.request_matches,true);assert.deepEqual(r.receipt,receipt);
  await db.query('update erp_catalog.import_review_command set actor=$1',[randomUUID()]);r=await read();assert.equal(r.found,true);assert.equal(r.request_matches,false);assert.equal(r.receipt,null);
  await db.query('update erp_catalog.import_review_command set actor=$1,request_hash=$2',[actor,'f'.repeat(64)]);r=await read();assert.equal(r.request_matches,false);assert.equal(r.receipt,null);
  await db.exec('delete from erp_catalog.import_review_command');await db.query('insert into erp_catalog.command values($1)',[command]);r=await read();assert.equal(r.found,false);assert.equal(r.namespace_conflict,true);assert.equal(r.receipt,null);
  assert.equal((await db.query('select count(*)::int n from erp_catalog.command')).rows[0].n,1);
 }finally{await db.close();}
});
