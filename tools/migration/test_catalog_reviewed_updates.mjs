import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {readFile,readdir,stat,writeFile,symlink} from 'node:fs/promises';import {join} from 'node:path';
import {catalogUpdateFixture} from './catalog_update_test_fixture.mjs';
import {adoptionDigest} from './execute_proposal_product_adoption.mjs';
import {prepareCatalogUpdateReview,executeReviewedCatalogUpdates,recoverReviewedCatalogUpdates,verifyCatalogUpdatePreservation,catalogUpdateReceiptExportSql,catalogUpdatePreservationSql} from './execute_catalog_reviewed_updates.mjs';
async function fixture(){
 const f=await catalogUpdateFixture(),calls=[];const args=()=>({p_user_id:f.actor,p_entity:'products',p_items:f.plan.items,p_command_id:f.plan.command_id,p_preview_hash:f.plan.preview_hash});
 const query=async(sql,key)=>(await f.db.exec(sql)).find(x=>x.rows?.[0]?.[key])?.rows[0][key];
 const ports={receipt:async()=>{calls.push('receipt');return query(catalogUpdateReceiptExportSql(f.plan,f.planHash),'receipt_export');},preservation:async()=>{calls.push('preservation');return f.proof();},proposal:async id=>{calls.push('proposal');const w=f.plan.expected[0].witnesses[0];return{dry_run:true,persisted:false,source_id:id,source_hash:w.source_hash,source_version:w.source_version,source_status:'Rascunho',existing:null,bindings:f.plan.expected.map(e=>({entity:'products',source_id:e.source_id,source_hash:e.source_hash,source_version:e.source_version,record_id:e.record_id}))};},catalog:async items=>{calls.push('catalog');return f.rpc('erp_catalog_import_preview',{p_user_id:f.actor,p_entity:'products',p_items:items});},apply:async a=>{calls.push('apply');return f.rpc('erp_catalog_import_apply',a);}};
 try{const review=await prepareCatalogUpdateReview({plan:f.plan,planHash:f.planHash,ports});calls.length=0;
 const input={plan:f.plan,planHash:f.planHash,review,approvedReviewHash:adoptionDigest(review),directory:f.directory,ports};
 return{...f,calls,ports,input,review,args,state:async()=>JSON.parse(await readFile(join(f.directory,`catalog-reviewed-updates-${f.plan.command_id}.json`),'utf8'))};}catch(e){await f.close();throw e;}
}
test('real013 update preserves full023 extras, exact057 price, existing snapshots and unselected draft; non1 versions increment exactly once',async()=>{
 const f=await fixture();try{const apply=f.ports.apply,catalog=f.ports.catalog;let accepted=false;
 f.ports.apply=async a=>{const s=await f.state();assert.equal(s.state,'pending');assert.equal(s.body_hash,adoptionDigest(a));const r=await apply(a);accepted=true;return r;};
 f.ports.catalog=async a=>{if(accepted)assert.equal((await f.state()).state,'acknowledged');return catalog(a);};
 const result=await executeReviewedCatalogUpdates(f.input);assert.equal(result.outcome,'verified');assert.equal(f.calls[0],'receipt');assert.equal(f.calls.filter(x=>x==='apply').length,1);
 const post=await f.proof();assert.deepEqual(post.selected.map(x=>x.version),[4,2]);assert.equal(post.selected[1].before_data.price,'2.1234567891');assert.equal(post.selected[0].before_data.brand,'Private synthetic brand');assert.equal(post.selected[0].before_data.items_per_box,'7');assert.deepEqual(post.preserved_relations,f.review.preservation.preserved_relations);
 assert.equal((await stat(join(f.directory,`catalog-reviewed-updates-${f.plan.command_id}.json`))).mode&511,384);
 f.calls.length=0;assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'verified');assert.deepEqual(f.calls,['catalog','preservation']);
 }finally{await f.close();}
});
test('lost ACK leaves durable pending; absent ledger never permits another POST; exact ledger recovers same UUID',async()=>{
 const f=await fixture();try{const apply=f.ports.apply,receipt=f.ports.receipt;f.ports.apply=async a=>{await apply(a);throw Error('lost');};assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'uncertain');assert.equal((await f.state()).state,'pending');
 f.ports.receipt=async()=>({...await receipt(),found:false,request_matches:false,receipt:null});f.calls.length=0;assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'uncertain');assert.equal(f.calls.includes('apply'),false);
 f.ports.receipt=receipt;f.calls.length=0;assert.equal((await recoverReviewedCatalogUpdates(f.input)).outcome,'verified');assert.deepEqual(f.calls,['receipt','catalog','preservation']);
 }finally{await f.close();}
});
test('ACK is durable before failed readback; stale pre-export requires fresh SQL without reapplying',async()=>{
 const f=await fixture();try{const before=await f.proof();f.ports.preservation=async()=>before;const r=await executeReviewedCatalogUpdates(f.input);assert.equal(r.outcome,'acknowledged');assert.equal(r.preservation_export_required,true);assert.equal((await f.state()).state,'acknowledged');
 f.ports.preservation=async()=>{throw Error('read failed');};assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'acknowledged');f.ports.preservation=()=>f.proof();assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'verified');assert.equal(f.calls.filter(x=>x==='apply').length,1);
 }finally{await f.close();}
});
test('extra selected delta, source/local CAS, human change, witness import and freshness stop before POST',async()=>{
 const f=await fixture();try{const original=f.ports.preservation;
 for(const change of [p=>p.selected[0].version++,p=>p.selected[0].source_hash='f'.repeat(64),p=>p.selected[0].human_edited=true,p=>p.selected[0].stock_locked=true,p=>p.witnesses[0].already_imported=true,p=>p.selected[0].expected_data.brand='Undeclared delta',p=>p.selected[1].expected_data.price='2.2000',p=>p.selected[0].capture.source='list_fallback',p=>p.selected[0].numeric_price=false,p=>p.exported_at=new Date(Date.now()-300001).toISOString()]){
 f.ports.preservation=async()=>{const p=await original();change(p);return p;};await assert.rejects(executeReviewedCatalogUpdates(f.input));assert.equal(f.calls.includes('apply'),false);assert.deepEqual(await readdir(f.directory),[]);
 }
 }finally{await f.close();}
});
test('post-proof compares approved BEFORE expected data; collateral fields, snapshots, document rows, ACL and RLS are rejected',async()=>{
 const f=await fixture();try{assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'verified');const post=await f.proof();
 for(const change of [p=>{p.selected[0].before_data.brand='Unexpected';p.selected[0].expected_data.brand='Unexpected';p.selected[0].data_hash='e'.repeat(64);p.selected[0].expected_data_hash='e'.repeat(64);},p=>p.selected[1].version++,p=>p.selected[1].target_snapshot_semantic_hash='f'.repeat(64),p=>p.audit[0].actor=randomUUID(),p=>p.command_rows.inner=2,p=>p.preserved_relations.find(x=>x.schema==='erp_documents'&&x.table==='item').hash='e'.repeat(64),p=>p.preserved_relations[0].access_hash='e'.repeat(64),p=>p.functions[0].access_hash='e'.repeat(64)]){const bad=structuredClone(post);change(bad);assert.throws(()=>verifyCatalogUpdatePreservation(bad,f.review,f.plan,f.planHash));}
 await f.db.query("update erp_catalog.product set brand='Unauthorized' where record_id=$1",[f.records[0]]);const changed=await f.proof();assert.equal(changed.selected[0].data_hash,changed.selected[0].expected_data_hash);assert.notEqual(changed.selected[0].data_hash,f.review.preservation.selected[0].expected_data_hash);assert.throws(()=>verifyCatalogUpdatePreservation(changed,f.review,f.plan,f.planHash),/SELECTED_DATA_CHANGED/);
 }finally{await f.close();}
});
test('target snapshot already present must remain byte-for-byte and new target snapshot must match raw semantic hash',async()=>{
 const f=await catalogUpdateFixture();try{
 await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='products' and source_id=$1",[f.plan.items[0].source_id]);
 const pre=await f.proof();await f.rpc('erp_catalog_import_apply',{p_user_id:f.actor,p_entity:'products',p_items:f.plan.items,p_command_id:f.plan.command_id,p_preview_hash:f.plan.preview_hash});const post=await f.proof();
 assert.equal(pre.selected[0].target_snapshot_hash,post.selected[0].target_snapshot_hash);assert.equal(post.selected[1].target_snapshot_semantic_hash,pre.selected[1].expected_snapshot_hash);
 verifyCatalogUpdatePreservation(post,{preservation:pre},f.plan,f.planHash);
 await f.db.query("update erp_catalog.source_snapshot set captured_at=captured_at+interval '1 second' where entity='products' and source_id=$1 and source_hash=$2",[f.plan.items[0].source_id,f.plan.items[0].source_hash]);const changed=await f.proof();assert.throws(()=>verifyCatalogUpdatePreservation(changed,{preservation:pre},f.plan,f.planHash),/SNAPSHOT_CHANGED/);
 }finally{await f.close();}
});
test('capture renewal with identical hash/version is fixed by a fresh review, never silently replaces approved evidence',async()=>{
 const f=await fixture();try{await f.db.query("update origin_sync.raw_record set last_seen_at=clock_timestamp(),price_capture=price_capture||jsonb_build_object('capture_id',$1::uuid,'observed_at',clock_timestamp()) where entity='products'",[randomUUID()]);await assert.rejects(executeReviewedCatalogUpdates(f.input),/REVIEW_CHANGED/);
 const review=await prepareCatalogUpdateReview({plan:f.plan,planHash:f.planHash,ports:f.ports});assert.notEqual(adoptionDigest(review),f.input.approvedReviewHash);assert.equal((await executeReviewedCatalogUpdates({...f.input,review,approvedReviewHash:adoptionDigest(review)})).outcome,'verified');
 }finally{await f.close();}
});
test('wrong ACK remains pending; same command does not use a second apply even if ledger absent',async()=>{
 const f=await fixture();try{f.ports.apply=async a=>{f.calls.push('apply');return{entity:'products',data_mode:'erp_native',operational_effects:false,dry_run:false,replayed:false,preview_hash:a.p_preview_hash,items:f.plan.expected.map(x=>({source_id:x.source_id,source_hash:x.source_hash,source_version:x.source_version,record_id:randomUUID(),action:'update',error:null}))};};assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'uncertain');assert.equal((await executeReviewedCatalogUpdates(f.input)).outcome,'uncertain');assert.equal(f.calls.filter(x=>x==='apply').length,1);
 }finally{await f.close();}
});
test('captured plan/ports resist mutation during await; abort leaves pending and late ACK is ignored',async()=>{
 const f=await fixture();try{const supplied=structuredClone(f.plan),receipt=f.ports.receipt;f.ports.receipt=async a=>{const r=await receipt(a);supplied.expected[0].record_version=99;f.ports.apply=()=>{throw Error('replacement');};return r;};assert.equal((await executeReviewedCatalogUpdates({...f.input,plan:supplied})).outcome,'verified');}finally{await f.close();}
 const g=await fixture();try{const abort=new AbortController();let resolve;g.ports.apply=async()=>{g.calls.push('apply');queueMicrotask(()=>abort.abort());return new Promise(r=>{resolve=r;});};assert.equal((await executeReviewedCatalogUpdates({...g.input,signal:abort.signal})).outcome,'uncertain');resolve({});await new Promise(r=>setImmediate(r));assert.equal((await g.state()).state,'pending');}finally{await g.close();}
});
test('exclusive lock, approved hash, accessor refusal, and recovery-only scope prevent accidental apply',async()=>{
 const f=await fixture();try{assert.equal((await recoverReviewedCatalogUpdates(f.input)).outcome,'not_recorded');assert.equal(f.calls.includes('apply'),false);await assert.rejects(executeReviewedCatalogUpdates({...f.input,approvedReviewHash:'a'.repeat(64)}),/REVIEW_NOT_APPROVED/);
 const p=structuredClone(f.plan);let read=0;Object.defineProperty(p,'actor',{get(){read++;return f.actor;},enumerable:true});await assert.rejects(executeReviewedCatalogUpdates({...f.input,plan:p}),/INPUT_DESCRIPTOR/);assert.equal(read,0);
 const lock=join(f.directory,'catalog-reviewed-updates.lock');await writeFile(lock,'existing owner',{mode:0o600});await assert.rejects(executeReviewedCatalogUpdates(f.input),{code:'EEXIST'});assert.equal(await readFile(lock,'utf8'),'existing owner');
 }finally{await f.close();}
});
test('SQL exports are read-only, namespace/actor/request bound, and relation hashes detect real nonselected/ACL changes',async()=>{
 const f=await fixture();try{const sql=catalogUpdateReceiptExportSql(f.plan,f.planHash);assert.match(sql,/^begin read only;/);assert.match(sql,/request_hash=e.h/);assert.match(sql,/namespace_conflict/);assert.doesNotMatch(sql,/insert into|delete from|update .*set|erp_catalog_import_apply\(/i);
 const before=await f.proof();await f.db.query('update erp_catalog.product set price=price+1 where record_id=$1',[f.unselected]);const after=await f.proof();assert.notEqual(adoptionDigest(before.preserved_relations),adoptionDigest(after.preserved_relations));
 await f.db.exec('grant select on erp_catalog.product to service_role');const acl=await f.proof();assert.notEqual(acl.preserved_relations.find(x=>x.table==='product').access_hash,before.preserved_relations.find(x=>x.table==='product').access_hash);
 assert.match(catalogUpdatePreservationSql(f.plan,f.planHash),/repeatable read read only/);
 }finally{await f.close();}
});
