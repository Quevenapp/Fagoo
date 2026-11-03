// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {bootstrap,quote} from './helpers/financial-import-postgres-fixture.mjs';
import {seedFinancialImportAuthorizationApply} from './helpers/financial-import-authorization-apply-fixture.mjs';
import {prepareReceiptQueryApply,prepareReceiptQueryReadback,SOURCE_HASHES} from './prepare_receipt_query_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-receipt-query-apply089-'),socket=join(root,'s'),port='56589';
await chmod(root,0o700);await mkdir(socket,{mode:0o700});let started=false;const children=new Set(),results=[];
function session(){
 const p=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
 children.add(p);let out='',err='',ended=false;
 const timer=setTimeout(()=>p.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{
  p.on('error',reject);p.stdin.on('error',()=>{});
  p.stdout.on('data',b=>{out+=b;if(out.length>2097152)p.kill('SIGKILL');});
  p.stderr.on('data',b=>{err+=b;if(err.length>65536)p.kill('SIGKILL');});
  p.on('close',code=>{ended=true;children.delete(p);clearTimeout(timer);resolve({code,out,err});});
 });done.catch(()=>{});
 return{done,write:s=>p.stdin.write(s+'\n'),end:s=>p.stdin.end(s+'\n'),async marker(value){
  const end=Date.now()+10000;
  while(!out.includes(value)){assert.equal(ended,false,err);assert.ok(Date.now()<end,'Marker timeout');await new Promise(r=>setTimeout(r,20));}
 }};
}
async function run(sql){const s=session();s.end(sql);return s.done;}
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const value=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')));
const scalar=async sql=>ok(await run(sql)).out.trim();
const rpc=async(name,args)=>value(await run(`begin;set local role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>k+'=>'+quote(v)).join(',')});commit;`));
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -c timezone=UTC -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(await scalar('show listen_addresses;'),'');ok(await run(bootstrap));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=88).sort();assert.equal(files.length,88);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 const seed=await seedFinancialImportAuthorizationApply({run,result:value,ok,rpc});
 const sql=await prepareReceiptQueryApply(),readback=await prepareReceiptQueryReadback(),lookup='public.erp_fiscal_receipt_query_history(uuid,uuid,uuid,integer,integer)';
 const oldFunctions=await scalar("select md5(jsonb_agg(to_jsonb(p)order by p.oid)::text)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname~'^(erp|origin)_'or n.nspname='public'and p.proname~'^(erp|origin)_';");
 const unchanged=async()=>{
  assert.equal(await scalar("select to_regnamespace('erp_fiscal_receipt_query')::text;"),'');
  assert.equal(await scalar("select md5(jsonb_agg(to_jsonb(p)order by p.oid)::text)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname~'^(erp|origin)_'or n.nspname='public'and p.proname~'^(erp|origin)_';"),oldFunctions);
  assert.equal(await scalar("select value from erp_access.fixture087 where id=1;"),'PRIVATE_SENTINEL');
  assert.equal(await scalar('select count(*)from erp_finance.title;'),'1');
  assert.equal(await scalar('select count(*)from erp_finance.command;'),'1');
  assert.equal(await scalar('select count(*)from erp_sales_history.snapshot;'),'276');
  assert.equal(await scalar('select count(*)from erp_warehouse_import.binding;'),'1');
 };
 for(const table of['origin_sync.resource_state','erp_finance.command','erp_sales_history.snapshot','auth.users','erp_fiscal_authorization.attempt','erp_a1.credential']){
  const holder=session();holder.write(`begin;lock table ${table} in row exclusive mode;\n\\echo WRITER_HELD`);
  try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);await unchanged();results.push({scenario:'writer_nowait_'+table,passed:true});}
  finally{holder.end('rollback;');ok(await holder.done);}
 }
 const inject=v=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n'+v);
 for(const[name,input,expected]of[
  ['old_row_rolls_back_all_new_objects',inject("update erp_access.fixture087 set value='changed';"),'existing_data_changed'],
  ['historical_receipt_rolls_back_all_new_objects',inject("alter table erp_finance.command disable trigger user;update erp_finance.command set result=result||'{\"changed\":true}';alter table erp_finance.command enable trigger user;"),'existing_data_changed'],
  ['history083_rolls_back_all_new_objects',inject("alter table erp_sales_history.snapshot disable trigger user;update erp_sales_history.snapshot set captured_at=captured_at+interval'1 second';alter table erp_sales_history.snapshot enable trigger user;"),'existing_data_changed'],
  ['global_default_rolls_back_all_new_objects',inject('alter default privileges grant select on tables to anon;'),'default_privileges_changed'],
  ['new_rpc_grant_option_rolls_back',inject(`grant execute on function ${lookup}to service_role with grant option;`),'function_contract_failed'],
  ['unrelated_function_identity_with_identical_acl_rolls_back',inject("do $probe$ declare s text;old_attrs jsonb;new_attrs jsonb;old_oid oid;new_oid oid;begin old_oid:='public.erp_access_me(uuid)'::regprocedure;select to_jsonb(p)-'oid' into old_attrs from pg_proc p where oid=old_oid;s:=pg_get_functiondef(old_oid);execute 'drop function public.erp_access_me(uuid)';execute s;revoke all on function public.erp_access_me(uuid)from public,anon,authenticated,service_role;grant execute on function public.erp_access_me(uuid)to service_role;new_oid:='public.erp_access_me(uuid)'::regprocedure;select to_jsonb(p)-'oid' into new_attrs from pg_proc p where oid=new_oid;if old_oid=new_oid or old_attrs is distinct from new_attrs then raise exception 'fixture_only_oid_change_required';end if;end$probe$;"),'other_functions_changed'],
  ['new_policy_enabled_rolls_back',inject("alter table erp_fiscal_receipt_query.policy disable trigger immutable;update erp_fiscal_receipt_query.policy set enabled=true;alter table erp_fiscal_receipt_query.policy enable trigger immutable;"),'new_table_seed_invalid'],
  ['deferred_guard_timing_rolls_back',inject('drop trigger receipt_query_use_commit on erp_fiscal_receipt_query.query;create constraint trigger receipt_query_use_commit after update on erp_fiscal_receipt_query.query for each row execute function erp_fiscal_receipt_query.commit_use();'),'table_contract_failed'],
  ['new_fk_referenced_internal_trigger_rolls_back',inject("do $probe$declare n text;begin select tgname into strict n from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint where k.conname='query_actor_fkey'and k.connamespace='erp_fiscal_receipt_query'::regnamespace and t.tgrelid='auth.users'::regclass limit 1;execute format('alter table auth.users disable trigger %I',n);end $probe$;"),'table_contract_failed'],
 ]){assert.notEqual(input,sql);const rejected=await run(input);assert.equal(rejected.code,3);assert.ok(rejected.err.includes(expected),rejected.err);await unchanged();results.push({scenario:name,passed:true});}
 const reader=session();reader.write('begin;lock table erp_finance.command,origin_sync.resource_state,auth.users,erp_fiscal_authorization.attempt in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.protected_table_count,160);assert.equal(audit.new_tables,5);assert.equal(audit.new_service_only_rpcs,8);assert.equal(audit.new_private_helpers,23);assert.equal(audit.new_triggers,7);assert.equal(audit.new_queries_empty,true);assert.equal(audit.new_policy_seeds_disabled,2);assert.equal(audit.new_policy_rows.every(p=>p.enabled===false),true);assert.equal(audit.native_mutation_performed,false);results.push({scenario:'ordinary_readers_compatible_with_fk_ddl_and_five_new_tables',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','other_functions_sha256','other_catalog_sha256','default_privileges_sha256','new_policy_rows','catalog_contract_sha256'])assert.deepEqual(proof[k],audit[k]);results.push({scenario:'readonly_commit_readback_matches_full_fingerprints_and_seed_contract',passed:true});
 assert.deepEqual(await rpc('erp_origin_financial_import_apply',seed.args),{...seed.receipt,replayed:true});assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'preexisting039_receipt_replays_after089_without_mutation',passed:true});
 for(const role of['anon','authenticated','service_role'])assert.equal(await scalar(`select has_function_privilege('${role}','${lookup}','EXECUTE');`),role==='service_role'?'t':'f');results.push({scenario:'new_rpc_service_only_acl',passed:true});
 const repeated=await run(sql);assert.equal(repeated.code,3);assert.match(repeated.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused_without_changes',passed:true});
 ok(await run(`grant execute on function ${lookup}to service_role with grant option;`));const badReadback=await run(readback);assert.equal(badReadback.code,3);assert.match(badReadback.err,/function_contract_failed/);ok(await run(`revoke grant option for execute on function ${lookup}from service_role;`));assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'readback_rejects_later_grant_option',passed:true});
 console.log(JSON.stringify({profile:'receipt-query-089-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_HASHES,protected_tables:audit.protected_table_count,scenarios:results,new_tables:5,new_functions:31,redefined_functions:0,new_policies_disabled:2,preserved_history_snapshots:276,preserved_warehouse_bindings:1,preserved_financial_receipts:1},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-receipt-query-apply089-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
