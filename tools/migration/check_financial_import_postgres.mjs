// Native PG17 audit of published039. Synthetic disposable cluster, private Unix socket, no TCP.
// This checker reports security findings and exits 1; it never changes the production migrations.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { bootstrap, quote, createFinancialImportFixture } from './helpers/financial-import-postgres-fixture.mjs';

const sourceHash='49596562b9a808a17e14eb9323fedadd1ac8e6c86764cdae1b0dcedb387186b1';
const bin=process.env.BRUFAP_TEST_PG17_BIN;assert.ok(typeof bin==='string'&&isAbsolute(bin));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-financial-import039-'),socket=join(root,'s'),port='56539';
await chmod(root,0o700);await mkdir(socket,{mode:0o700});
let started=false;const children=new Set(),results=[],findings=[];let lockWaits=0;
function session(){
  const child=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
  children.add(child);let out='',err='',ended=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{out+=b;if(out.length>4194304)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>65536)child.kill('SIGKILL');});
    child.on('close',code=>{ended=true;children.delete(child);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});
  return {done,write:s=>child.stdin.write(s+'\n'),end:s=>{if(!child.stdin.writableEnded)child.stdin.end(s+'\n');},async marker(value){const until=Date.now()+10000;while(!out.includes(value)){assert.equal(ended,false,err);assert.ok(Date.now()<until,'Marker timeout');await new Promise(r=>setTimeout(r,15));}}};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const result=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(s=>s.startsWith('{')||s.startsWith('[')));
const rpcSql=(name,args)=>{assert.match(name,/^erp_[a-z_]+$/);return `set local role service_role;select public.${name}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z_]+$/);return `${key}=>${quote(value)}`;}).join(',')});`;};
const rpc=async(name,args)=>result(await run('begin;'+rpcSql(name,args)+'commit;'));
const applySql=p=>rpcSql('erp_origin_financial_import_apply',p);
const errorCode=r=>r.err.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]??null;
const expectError=(r,code)=>{assert.equal(r.code,3,r.err);assert.equal(errorCode(r),code,r.err);assert.doesNotMatch(r.err,/40P01/);};
const record=(scenario,extra={})=>results.push({scenario,passed:true,...extra});
async function waitLock(name){const until=Date.now()+10000;while(true){const r=ok(await run(`select count(*)from pg_stat_activity where application_name=${quote(name)}and wait_event_type='Lock';`));if(r.out.trim()==='1'){lockWaits++;return;}assert.ok(Date.now()<until,'Expected real lock wait: '+name);await new Promise(r=>setTimeout(r,20));}}
async function race(name,hold,request,{release='commit;'}={}){
  const a=session(),b=session();a.write(`begin;${hold}\n\\echo HELD`);
  try{await a.marker('HELD');b.end(`set application_name=${quote(name)};begin;${request}commit;`);await waitLock(name);a.end(release);return {first:ok(await a.done),second:await b.done};}
  finally{a.end('rollback;');b.end('rollback;');await Promise.allSettled([a.done,b.done]);}
}
const ledgerSql=`select jsonb_build_object(${['title','command','audit','origin_import_origin','settlement','movement'].map(t=>`'${t}',(select coalesce(jsonb_agg(to_jsonb(x)order by to_jsonb(x)::text),'[]')from erp_finance.${t} x)`).join(',')});`;
const ledger=async()=>result(await run(ledgerSql));
const protectedSql=`do $$declare r record;v jsonb;all_rows jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and
 (n.nspname like'erp_%'or n.nspname in('origin_sync','origin_backup','origin_reference_fetch','auth','storage'))
 and n.nspname not in('erp_catalog','origin_sync','origin_finance_refresh','erp_access')
 and not(n.nspname='erp_finance'and c.relname in('title','command','audit','origin_import_origin','category','account'))order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),''''),''UTF8'')),''hex''))from %I.%I x',r.ns,r.name)into v;all_rows:=all_rows||jsonb_build_object(r.ns||'.'||r.name,v);end loop;
 perform set_config('brufap.financial039_fixture',all_rows::text,false);end$$;select current_setting('brufap.financial039_fixture')::jsonb;`;
const countSource=async s=>result(await run(`select jsonb_build_object('origins',count(*),'title_ids',count(distinct title_id))from erp_finance.origin_import_origin where entity=${quote(s.entity)}and source_id=${quote(s.id)};`));
async function failedRace(name,hold,p,release,expected='40001'){
  const before=await ledger(),r=await race(name,hold,applySql(p),{release});expectError(r.second,expected);assert.deepEqual(await ledger(),before);record(name,{lock_wait_observed:true});
}
async function securityRace(name,hold,p,release,{newImport=false}={}){
  const before=await ledger(),r=await race(name,hold,applySql(p),{release});
  if(errorCode(r.second)==='42501'){assert.deepEqual(await ledger(),before);record(name,{lock_wait_observed:true});return;}
  if(r.second.code!==0)throw Error('Unexpected result in '+name+': '+r.second.err);
  const response=result(r.second),after=await ledger();
  assert.equal(response.replayed,!newImport);
  const delta=after.title.length-before.title.length;
  assert.equal(delta,newImport?p.p_items.length:0);
  findings.push({scenario:name,severity:newImport?'P1':'P2',expected:'42501',observed:'successful_import_response',replayed:response.replayed,new_titles:delta,lock_wait_observed:true});
  results.push({scenario:name,passed:false,lock_wait_observed:true,expected:'42501',actual:'success'});
}

try{
  execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
  execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
  assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
  const dir=new URL('../../supabase/migrations/',import.meta.url),migrations=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=85).sort(),migrationHashes={};assert.equal(migrations.length,85);
  for(const file of migrations){const source=await readFile(new URL(file,dir),'utf8');migrationHashes[file]=createHash('sha256').update(source).digest('hex');if(file.includes('0039_'))assert.equal(migrationHashes[file],sourceHash);ok(await run(source));}
  const f=await createFinancialImportFixture({run,result,ok,rpc}),{admin,other}=f;
  const protectedBefore=result(await run(protectedSql));
  let replay;
  for(const entity of ['receivables','payables']){
    const s=await f.source({entity}),p=await f.prepare([s]);const r=await race(entity+'_same_uuid',applySql(p),applySql(p));
    assert.deepEqual(result(r.first).batch,result(r.second).batch);assert.equal(result(r.second).replayed,true);assert.deepEqual(await countSource(s),{origins:1,title_ids:1});record(entity+'_same_uuid',{lock_wait_observed:true});if(entity==='receivables')replay=p;
    const t=await f.source({entity}),q=await f.prepare([t]);const c=await race(entity+'_same_source_distinct_uuid',applySql(q),applySql({...q,p_command_id:randomUUID()}));expectError(c.second,'40001');assert.deepEqual(await countSource(t),{origins:1,title_ids:1});record(entity+'_same_source_distinct_uuid',{lock_wait_observed:true});
  }
  for(const [name,patch]of[['different_body',{p_preview_hash:'f'.repeat(64)}],['different_actor',{p_user_id:other}]]){
    await failedRace('same_uuid_'+name,`select pg_advisory_xact_lock(hashtextextended('${replay.p_command_id}',0));`,{...replay,...patch},'commit;');
  }
  await securityRace('replay_role_revoked_during_command_wait',`select pg_advisory_xact_lock(hashtextextended('${replay.p_command_id}',0));`,replay,`update erp_access.membership set active=false where user_id='${admin}';commit;`);await f.restoreActor();
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('new_import_role_revoked_during_entity_wait',"select pg_advisory_xact_lock(174852939,hashtext('receivables'));",p,`update erp_access.membership set active=false where user_id='${admin}';commit;`,'42501');await f.restoreActor();
  }
  for(const [name,field]of[['raw_version','version=version+1'],['raw_seen','last_seen_at=last_seen_at+interval\'1 second\''],['raw_hash',"version_hash=repeat('a',64)"]]){
    const s=await f.source(),p=await f.prepare([s]);await failedRace(name+'_changed_after_lock',`select source_id from origin_sync.raw_record where entity='receivables'and source_id='${s.id}'for update;`,p,`update origin_sync.raw_record set ${field} where entity='receivables'and source_id='${s.id}';commit;`);
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('contact_record_changed_after_lock',`select id from erp_catalog.record where id='${s.contact}'for update;`,p,`update erp_catalog.record set human_edited=true,version=version+1 where id='${s.contact}';commit;`);
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('contact_raw_changed_after_lock',`select source_id from origin_sync.raw_record where entity='contacts'and source_id='${s.contactSource}'for update;`,p,`update origin_sync.raw_record set last_seen_at=last_seen_at+interval'1 second'where entity='contacts'and source_id='${s.contactSource}';commit;`);
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('contact_parent_remapped_after_parent_lock',`select id from erp_catalog.record where id='${s.contact}'for update;`,p,`update erp_catalog.origin set record_id='${s.alternate}'where entity='contacts'and source_id='${s.contactSource}';commit;`);
  }
  {
    const s=await f.source({category:true}),p=await f.prepare([s]);await failedRace('category_changed_after_lock',`select id from erp_finance.category where id='${s.categoryId}'for update;`,p,`update erp_finance.category set active=false,version=version+1 where id='${s.categoryId}';commit;`);
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('refresh_attempt_changed_after_lock',`select source_id from origin_finance_refresh.origin where entity='receivables'and source_id='${s.id}'for update;`,p,`update origin_finance_refresh.origin set current_attempt=null where entity='receivables'and source_id='${s.id}';commit;`);
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await failedRace('contact_remap_plus_revocation_during_wait',`select id from erp_catalog.record where id='${s.contact}'for update;`,p,`update erp_catalog.origin set record_id='${s.alternate}'where entity='contacts'and source_id='${s.contactSource}';update erp_access.membership set active=false where user_id='${admin}';commit;`,'40001');await f.restoreActor();
    // Data stays unchanged but the pre-ACL conflict discloses source state after role loss.
    findings.push({scenario:'contact_remap_plus_revocation_during_wait',severity:'P2',expected:'42501',observed:'40001_before_authorization',new_titles:0,lock_wait_observed:true});results.at(-1).passed=false;
  }
  {
    const s=await f.source(),p=await f.prepare([s]);await securityRace('actor_fk_wait_after_plan_then_role_revoked',`select id from auth.users where id='${admin}'for update;`,p,`update erp_access.membership set active=false where user_id='${admin}';commit;`,{newImport:true});await f.restoreActor();
  }
  {
    const first=await f.source(),last=await f.source({description:'Synthetic late failure'}),p=await f.prepare([first,last]);
    ok(await run("create function public.financial039_test_fail()returns trigger language plpgsql as $$begin if NEW.description='Synthetic late failure'then raise exception'synthetic late failure'using errcode='22023';end if;return NEW;end$$;create trigger z_financial039_test_fail before insert on erp_finance.title for each row execute function public.financial039_test_fail();"));
    try{const before=await ledger();expectError(await run('begin;'+applySql(p)+'commit;'),'22023');assert.deepEqual(await ledger(),before);record('second_insert_failure_rolls_back_whole_batch');}
    finally{ok(await run('drop trigger z_financial039_test_fail on erp_finance.title;drop function public.financial039_test_fail();'));}
  }
  {
    const s=await f.source(),p=await f.prepare([s]),before=await ledger();expectError(await run('begin;'+applySql(p)+'select 1/0;commit;'),'22012');assert.deepEqual(await ledger(),before);record('late_transaction_failure_rolls_back_whole_batch');
  }
  {
    const current=await rpc('erp_origin_financial_import_batch',{p_user_id:admin,p_command_id:replay.p_command_id});
    const title=current.batch.items[0].title_id;
    await rpc('erp_finance_execute',{p_user_id:admin,p_command_id:randomUUID(),p_action:'title_cancel',p_data:{id:title,expected_version:1,note:'Synthetic cancellation'}});
    const before=await ledger(),r=await rpc('erp_origin_financial_import_apply',replay);assert.equal(r.replayed,true);assert.deepEqual(r.batch,current.batch);assert.deepEqual(await ledger(),before);record('ack_lost_replay_preserves_receipt_and_cancelled_current');
    for(const sql of [`update erp_finance.command set result='{}'where id='${replay.p_command_id}'`,`delete from erp_finance.origin_import_origin where title_id='${title}'`])expectError(await run(sql),'55000');assert.deepEqual(await ledger(),before);record('receipt_and_origin_immutable');
  }
  for(const oldFirst of [true,false]){
    const s=await f.source(),p=await f.prepare([s]);const legacy=rpcSql('erp_finance_execute',{p_user_id:admin,p_command_id:p.p_command_id,p_action:'account_save',p_data:{expected_version:0,name:'Synthetic account collision',kind:'cash'}});
    const r=await race(oldFirst?'legacy_command_wins':'import_command_wins',oldFirst?legacy:applySql(p),oldFirst?applySql(p):legacy);expectError(r.second,'40001');assert.deepEqual(await countSource(s),{origins:oldFirst?0:1,title_ids:oldFirst?0:1});record(oldFirst?'legacy_command_wins':'import_command_wins',{lock_wait_observed:true});
  }
  assert.deepEqual(result(await run(protectedSql)),protectedBefore);record('native_stock_documents_fiscal_bank_settlement_and_movement_preserved');
  const output={profile:'financial-import-039-postgres-audit-v1',source_sha256:sourceHash,baseline_migrations:migrationHashes,postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,production_sources_modified:false,lock_waits:lockWaits,scenarios:results,findings,all_security_expectations_passed:findings.length===0};
  console.log(JSON.stringify(output,null,2));if(findings.length)process.exitCode=1;
}finally{
  for(const child of children)child.kill('SIGKILL');
  if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
  assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-financial-import039-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
