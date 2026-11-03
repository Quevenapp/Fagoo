import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {receiptQueryFixture,hash,PREFIX} from './receipt-query-sql-fixture.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../src/receipt-query-manifest.mjs';
import {projectReceiptQuerySource} from '../src/receipt-query-evidence.mjs';
const err=code=>e=>e.code===code;
test('089 isolated queries preserve immutable emission history and enforce explicit source/CAS/single use',async t=>{
 const f=await receiptQueryFixture();try{
  await t.test('five private tables, eight closed RPCs, disabled seeds and exact source manifest',async()=>{
   const tables=(await f.db.query("select c.relname,c.relrowsecurity,has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')granted from pg_class c where relnamespace='erp_fiscal_receipt_query'::regnamespace and relkind='r'order by relname")).rows;
   assert.equal(tables.length,5);assert.ok(tables.every(x=>x.relrowsecurity&&!x.granted));
   const rpc=(await f.db.query("select p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')authenticated,has_function_privilege('service_role',p.oid,'EXECUTE')service,exists(select 1 from aclexplode(p.proacl)a where a.is_grantable)delegable from pg_proc p where pronamespace='public'::regnamespace and proname like $1",[PREFIX+'%'])).rows;
   assert.equal(rpc.length,8);assert.ok(rpc.every(x=>x.prosecdef&&!x.anon&&!x.authenticated&&x.service&&!x.delegable));assert.ok(rpc.every(x=>x.proconfig.includes('search_path=pg_catalog')&&x.proconfig.includes('TimeZone=UTC')));
   assert.equal((await f.db.query('select erp_fiscal_receipt_query.manifest()v')).rows[0].v,RECEIPT_QUERY_SOURCE_MANIFEST_HASH);
   assert.equal((await f.db.query('select count(*)::int n from erp_fiscal_receipt_query.policy where enabled')).rows[0].n,0);
   assert.ok((await f.db.query("select has_function_privilege('service_role',p.oid,'EXECUTE')granted from pg_proc p where pronamespace='erp_fiscal_receipt_query'::regnamespace")).rows.every(x=>!x.granted));
  });
  await f.enableQuery();
  for(const model of['55','65'])for(const kind of['authorization','revalidation'])await t.test(`${model}/${kind}: 103→105→explicit new query104; old ledgers byte-identical`,async()=>{
   const x=await f.querySource(model,kind),old=await f.snapshot();
   assert.deepEqual(projectReceiptQuerySource(x.context.source,{actor:f.users.fiscal,sourceKind:kind,sourceCommandId:x.contextArgs.p_source_command_id,authorizationCommandId:x.c.input.commandId,authorizationAttemptId:x.b.value.receipt.attempt_id}),x.context.source);assert.equal(x.context.source.source_kind,kind);assert.equal(x.context.can_query,false);assert.equal(x.context.source_validation_required,true);assert.equal(x.context.private_eligible_for_attested_source,true);
   const b=await f.queryBegin(x),replay=await f.queryCall('begin',b.args);assert.equal(replay.replayed,true);assert.equal(replay.execution,null);assert.deepEqual(replay.receipt,b.value.receipt);
   const p=await f.queryPrepare(b);await f.queryUse(b);await assert.rejects(f.queryUse(b),err('40001'));
   const args=await f.queryFinishArgs(b,p),r=await f.queryCall('finish',args);assert.equal(r.current.state,'receipt_pending');assert.equal(r.resolution.state,'pending');
   assert.equal((await f.queryCall('finish',args)).replayed,true);await assert.rejects(f.queryCall('finish',{...args,p_response_hash:hash('other')}),err('40001'));
   await assert.rejects(f.queryBegin(x),err('40001'));await f.ageQuery(b);
   const b2=await f.queryBegin(x),p2=await f.queryPrepare(b2);await f.queryUse(b2);const final=await f.queryCall('finish',await f.queryFinishArgs(b2,p2,model==='55'?'100':'150'));
   assert.equal(final.current.state,'authorized_homologation');assert.equal(final.resolution.state,'authorized_homologation');assert.equal(final.resolution.selected_query_id,b2.value.query_id);
   const h=await f.queryCall('history',{p_user_id:f.users.fiscal,p_authorization_command_id:x.c.input.commandId,p_expected_attempt_id:x.b.value.receipt.attempt_id,p_limit:1,p_before:null});assert.equal(h.items.length,1);assert.equal(h.next_before,2);
   const h2=await f.queryCall('history',{p_user_id:f.users.fiscal,p_authorization_command_id:x.c.input.commandId,p_expected_attempt_id:x.b.value.receipt.attempt_id,p_limit:1,p_before:h.next_before});assert.equal(h2.items[0].query_id,b.value.query_id);assert.equal(h2.next_before,null);
   await assert.rejects(f.queryBegin(x),err('40001'));assert.deepEqual(await f.snapshot(),old);
  });
  await t.test('UTC history has identical source/CAS from UTC and Sao_Paulo callers; nonUTC079 fails closed',async()=>{
   const x=await f.querySource('55','revalidation'),utc=await f.queryCall('context',x.contextArgs);
   await f.db.exec("set timezone='America/Sao_Paulo'");try{
    const local=await f.queryCall('context',x.contextArgs);assert.deepEqual(local.source,utc.source);assert.deepEqual(local.selection,utc.selection);
    await assert.rejects(f.querySource('55','revalidation'),e=>e.code==='40001'&&e.message==='revalidation_source_conflict');
   }finally{await f.db.exec("set timezone='UTC'");}
  });
  await t.test('ten deliberately expired preparations exhaust the attempt hourly budget',async()=>{
   const x=await f.querySource();for(let i=0;i<10;i++){const b=await f.queryBegin(x);await f.ageQuery(b);}
   const c=await f.queryCall('context',x.contextArgs);assert.ok(c.blockers.includes('RATE_LIMIT'));
   await assert.rejects(f.queryBegin(x),e=>e.code==='40001'&&e.message==='receipt_query_rate_limit');
  });
  await t.test('invalid/null selection and closed history bounds do not write',async()=>{
   const x=await f.querySource(),a=await f.queryBeginArgs(x),before=await f.queryCounts();
   for(const patch of[{p_command_id:null},{p_selection:null},{p_source_validation:null},{p_confirmed:null},{p_confirmed:false},{p_selection:{...a.p_selection,extra:true}},{p_selection:{...a.p_selection,expected_a1_version:0}},{p_selection:{...a.p_selection,expected_candidate_version:1000000000}}])await assert.rejects(f.queryCall('begin',{...a,...patch}),err('22023'));
   for(const p_limit of[null,0,26])await assert.rejects(f.queryCall('history',{p_user_id:f.users.fiscal,p_authorization_command_id:x.c.input.commandId,p_expected_attempt_id:x.b.value.receipt.attempt_id,p_limit,p_before:null}),err('22023'));
   assert.deepEqual(await f.queryCounts(),before);
  });
  await t.test('read-only context refuses optimistic eligibility for wrong A1/policy/storage metadata',async()=>{
   const x=await f.querySource(),get=()=>f.queryCall('context',x.contextArgs),old=await f.snapshot();
   assert.deepEqual((await get()).blockers,['SOURCE_VALIDATION_REQUIRED']);
   const rows=(await f.db.query("select *from storage.objects where bucket_id='brufap-a1-vault'")).rows;
   await f.db.query("delete from storage.objects where bucket_id='brufap-a1-vault'");try{let c=await get();assert.ok(c.blockers.includes('A1_STORAGE_INVALID'));assert.equal(c.private_eligible_for_attested_source,false);}finally{for(const r of rows)await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',[r.bucket_id,r.name,JSON.stringify(r.metadata)]);}
   const version=await f.enableQuery(false);assert.ok((await get()).blockers.includes('POLICY_DISABLED'));await f.enableQuery();
   await f.db.exec('begin');try{await f.db.query('update erp_a1.head set version=version+1,credential_id=null,object_hash=null where singleton');const c=await get();assert.ok(c.blockers.includes('A1_UNAVAILABLE'));assert.equal(c.private_eligible_for_attested_source,false);}finally{await f.db.exec('rollback');}
   // Query policy append is deliberate; old authorization journals are entirely unchanged.
   assert.deepEqual(await f.snapshot(),old);assert.ok(version>1);
  });
  await t.test('source, validation and selection mismatches never create query',async()=>{
   const x=await f.querySource(),a=await f.queryBeginArgs(x),before=await f.queryCounts();
   for(const patch of[{expected_chain_hash:hash('stale')},{expected_source_binding_hash:hash('stale')},{expected_signed_hash:hash('stale')},{expected_candidate_version:99},{expected_candidate_id:randomUUID()},{expected_authorization_command_id:randomUUID()},{expected_identity_version:99},{expected_a1_version:99},{expected_query_policy_version:99}])await assert.rejects(f.queryCall('begin',{...a,p_selection:{...a.p_selection,...patch}}),err('40001'));
   for(const patch of[{manifest_hash:hash('bad')},{source_binding_hash:hash('bad')},{receipt_number:'035000000000002'},{payload_hash:hash('bad')},{tmed_seconds:-1},{tmed_seconds:10000},{tmed_seconds:'0'},{signature_verified:false},{tls_origin_verified:false},{can_query:true},{tax_rules_validated:true},{extra:true}])await assert.rejects(f.queryCall('begin',{...a,p_source_validation:{...a.p_source_validation,...patch}}),err('22023'));
   assert.deepEqual(await f.queryCounts(),before);
  });
  await t.test('cadence begins at trusted observation/tMed and no zero/default is inferred',async()=>{
   const x=await f.querySource(),a=await f.queryBeginArgs(x);
   await assert.rejects(f.queryCall('begin',{...a,p_source_validation:{...a.p_source_validation,observed_at:new Date().toISOString()}}),err('40001'));
   await assert.rejects(f.queryCall('begin',{...a,p_source_validation:{...a.p_source_validation,tmed_seconds:9999}}),err('40001'));
   await assert.rejects(f.queryCall('begin',{...a,p_source_validation:{...a.p_source_validation,observed_at:null}}),err('22023'));
  });
  await t.test('ACK lost before use expires without locking the chain forever',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x);await f.ageQuery(b);
   assert.equal((await f.queryCall('begin',b.args)).execution,null);
   const next=await f.queryBegin(x);assert.notEqual(next.value.query_id,b.value.query_id);
   await assert.rejects(f.queryPrepare(b),err('40001'));assert.equal((await f.queryCall('command',{p_user_id:f.users.fiscal,p_command_id:b.value.query_id})).current.grant_consumed,false);
  });
  await t.test('failed-before-dispatch remains historical; deliberate successor waits lease/cadence',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),args={...f.queryIds(b),p_error_code:'RECEIPT_QUERY_CUSTODY_FAILED'};
   assert.equal((await f.queryCall('fail',args)).current.state,'failed_before_dispatch');assert.equal((await f.queryCall('fail',args)).replayed,true);
   await assert.rejects(f.queryBegin(x),err('40001'));await f.ageQuery(b);assert.equal((await f.queryBegin(x)).value.receipt.ordinal,2);
  });
  await t.test('a late predecessor finish invalidates an already prepared successor before use',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);await f.ageQuery(b);
   const next=await f.queryBegin(x);await f.queryPrepare(next);await f.queryCall('finish',await f.queryFinishArgs(b,p,'100'));
   await assert.rejects(f.queryUse(next),err('40001'));assert.equal((await f.queryCall('command',{p_user_id:f.users.fiscal,p_command_id:next.value.query_id})).current.grant_consumed,false);
  });
  await t.test('late105 never regresses authorization; incompatible protocols produce explicit conflict',async()=>{
   for(const late of['105','100']){
    const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);await f.ageQuery(b);
    const next=await f.queryBegin(x),pn=await f.queryPrepare(next);await f.queryUse(next);await f.queryCall('finish',await f.queryFinishArgs(next,pn,'100'));
    const args=await f.queryFinishArgs(b,p,late);if(late==='100')args.p_evidence.protocol_number='135260000000002';
    const out=await f.queryCall('finish',args);assert.equal(out.resolution.state,late==='105'?'authorized_homologation':'conflict');
    if(late==='100')assert.equal(out.resolution.selected_query_id,null);
   }
  });
  await t.test('semantic protocols compare validated instants rather than response bytes; noncanonical evidence is refused',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);await f.ageQuery(b);
   const next=await f.queryBegin(x),pn=await f.queryPrepare(next);await f.queryUse(next);await f.queryCall('finish',await f.queryFinishArgs(next,pn,'100'));
   const args=await f.queryFinishArgs(b,p,'100');args.p_evidence.received_at='2026-10-17T09:00:00-03:00';
   await assert.rejects(f.queryCall('finish',args),err('22023'));args.p_evidence.received_at=new Date(args.p_evidence.received_at).toISOString();
   assert.equal((await f.queryCall('finish',args)).resolution.state,'authorized_homologation');
  });
  await t.test('identical SOAP hashes do not permit cross-query/nonce/observation substitution',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);await f.ageQuery(b);
   const next=await f.queryBegin(x),pn=await f.queryPrepare(next);await f.queryUse(next);assert.equal(p.args.p_request_hash,pn.args.p_request_hash);
   const args=await f.queryFinishArgs(next,pn),old=await f.queryFinishArgs(b,p),counts=await f.queryCounts();
   await assert.rejects(f.queryCall('finish',{...args,p_evidence:old.p_evidence}),err('22023'));
   for(const patch of[{nonce:b.value.recovery.nonce},{query_id:b.value.query_id},{source_binding_hash:hash('other')},{receipt_number:'035000000000002'},{tls_origin_verified:false},{observation_hash:hash('other')}])await assert.rejects(f.queryCall('finish',{...args,p_evidence:{...args.p_evidence,...patch}}),err('22023'));
   assert.deepEqual(await f.queryCounts(),counts);
  });
  await t.test('Storage failures roll back all ledger writes and a later exact recovery succeeds',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);const args=await f.queryFinishArgs(b,p,'100');
   const key=`receipt-queries/${b.value.query_id}/processed/${args.p_processed_hash}.xml`;await f.db.query('delete from storage.objects where name=$1',[key]);const before=await f.queryCounts();
   await assert.rejects(f.queryCall('finish',args),err('40001'));assert.deepEqual(await f.queryCounts(),before);
   await f.queryObject(b,'processed',args.p_processed_hash);assert.equal((await f.queryCall('finish',args)).current.state,'authorized_homologation');
  });
  await t.test('source/receipt/request/result/audit remain immutable',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);await f.queryCall('finish',await f.queryFinishArgs(b,p));
   for(const sql of["update erp_fiscal_receipt_query.query set source='{}'where id=$1","update erp_fiscal_receipt_query.query set receipt='{}'where id=$1","delete from erp_fiscal_receipt_query.query where id=$1","update erp_fiscal_receipt_query.request set evidence='{}'where query_id=$1","delete from erp_fiscal_receipt_query.result where query_id=$1","delete from erp_fiscal_receipt_query.audit where query_id=$1"])await assert.rejects(f.db.query(sql,[b.value.query_id]),err('42501'));
  });
  await t.test('command replay and reads require the original active actor',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x);
   await assert.rejects(f.queryCall('begin',{...b.args,p_user_id:f.users.admin}),err('42501'));
   await assert.rejects(f.queryCall('command',{p_user_id:f.users.admin,p_command_id:b.value.query_id}),err('42501'));
   await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.fiscal]);try{await assert.rejects(f.queryCall('begin',b.args),err('42501'));await assert.rejects(f.queryCall('context',x.contextArgs),err('42501'));}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.fiscal]);}
  });
  await t.test('historical finish/replay works with A1 and query policies disabled, without grants',async()=>{
   const x=await f.querySource(),b=await f.queryBegin(x),p=await f.queryPrepare(b);await f.queryUse(b);const args=await f.queryFinishArgs(b,p,'150');const old=await f.snapshot();
   await f.enableQuery(false);await f.db.exec('update erp_a1.head set version=version+1,credential_id=null,object_hash=null where singleton');
   const out=await f.queryCall('finish',args);assert.equal(out.current.state,'authorized_homologation');assert.equal((await f.queryCall('finish',args)).replayed,true);assert.equal((await f.queryCall('begin',b.args)).execution,null);
   assert.deepEqual(await f.snapshot(),old);
  });
 }finally{await f.close();}
});
