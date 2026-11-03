// Real PostgreSQL concurrency probe using only fictitious native accounts.
// No bank API, secrets, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const name='brufap-transfer053-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),finance=randomUUID(),sessions=new Set(),results=[];
let today;
let container=null;
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+quote(value);}).join(',')});`;};
const roleSql=sql=>`set role service_role; ${sql}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function session(){
 assert.match(container,/^[a-f0-9]{64}$/);
 const child=spawn('docker',['exec','-i',container,'psql','-XAtq','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{stdio:['pipe','pipe','pipe']});
 sessions.add(child);let stdout='',stderr='',ended=false;
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{
  child.once('error',error=>{clearTimeout(timer);sessions.delete(child);ended=true;reject(error);});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>2097152)child.kill('SIGKILL');});
  child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>65536)child.kill('SIGKILL');});
  child.once('close',code=>{ended=true;clearTimeout(timer);sessions.delete(child);resolve({code,stdout,stderr});});
 });
 done.catch(()=>{});
 return{done,write:sql=>child.stdin.write(sql+'\n'),end:sql=>child.stdin.end(sql+'\n'),async marker(marker){
  const deadline=Date.now()+10000;
  while(!stdout.includes(marker)){assert.equal(ended,false,stderr);assert.ok(Date.now()<deadline,'Transaction marker timed out');await pause(20);}
 }};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.stderr);return r;};
const value=r=>JSON.parse(ok(r).stdout.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));
const rpc=async(name,args)=>value(await run(roleSql(rpcSql(name,args))));
function rejected(r,code){assert.equal(r.code,3,r.stdout);assert.match(r.stderr,new RegExp('\\b'+code+'\\b'));assert.doesNotMatch(r.stderr,/\b40P01\b/);}
async function waiting(application){
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){
  const r=ok(await run(`select count(*) from pg_stat_activity where application_name=${quote(application)} and wait_event_type='Lock';`));
  if(r.stdout.trim()==='1')return;await pause(20);
 }assert.fail('Expected an observed PostgreSQL lock wait');
}
async function race(scenario,firstSql,secondSql,check){
 const first=session(),application='transfer053_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{if(!ended)first.end('rollback;');await first.done;if(second)await second;}
}
const nativeArgs=(action,data,command=randomUUID())=>({p_user_id:finance,p_command_id:command,p_action:action,p_data:data});
const account=async name=>(await rpc('erp_finance_execute',nativeArgs('account_save',{expected_version:0,name,kind:'cash'}))).record;
async function pair(){return[await account('Conta A fictícia'),await account('Conta B fictícia')];}
const transfer=(a,b,extra={})=>({p_user_id:finance,p_command_id:randomUUID(),p_data:{from_account_id:a.id,to_account_id:b.id,expected_from_version:a.version,expected_to_version:b.version,amount_cents:'12345',posted_on:today,note:'Ensaio local sintético de transferência',confirmed:true,...extra}});
const postSql=args=>roleSql(rpcSql('erp_finance_transfer_post',args));
const post=args=>rpc('erp_finance_transfer_post',args);
const get=command=>rpc('erp_finance_transfer_command',{p_user_id:finance,p_command_id:command});
const financialState=async ids=>value(await run(`select jsonb_build_object('accounts',(select jsonb_agg(jsonb_build_object('id',a.id,'version',a.version,'balance',(select coalesce(sum(m.delta_cents),0)::text from erp_finance.movement m where m.account_id=a.id))order by a.id)from erp_finance.account a where a.id in(${ids.map(quote).join(',')})),'transfers',(select count(*)from erp_finance.transfer t where t.from_account_id in(${ids.map(quote).join(',')})),'legs',(select count(*)from erp_finance.movement m where m.account_id in(${ids.map(quote).join(',')})and m.transfer_id is not null));`));
async function assertPair(r){
 const id=r.receipt.id;
 assert.equal(r.receipt.movements.length,2);assert.equal(r.bank_operation_performed,false);
 const state=value(await run(`select jsonb_build_object('transfers',(select count(*)from erp_finance.transfer where id=${quote(id)}),'legs',(select count(*)from erp_finance.movement where transfer_id=${quote(id)}),'sum',(select sum(delta_cents)::text from erp_finance.movement where transfer_id=${quote(id)}),'audit',(select count(*)from erp_finance.audit where command_id=${quote(r.receipt.command_id)} and action='internal_transfer'),'commands',(select count(*)from erp_finance.command where id=${quote(r.receipt.command_id)} and result->>'action'='internal_transfer'));`));
 assert.deepEqual(state,{transfers:1,legs:2,sum:'0',audit:1,commands:1});
}
async function revokeWhileWaiting(scenario,lockSql,args){
 const blocker=session(),application='transfer053_'+randomUUID();let released=false,pending;
 blocker.write(`begin;set local lock_timeout='12s';${lockSql}\n\\echo FIRST_DONE`);
 try{
  await blocker.marker('FIRST_DONE');pending=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${postSql(args)}`);
  await waiting(application);ok(await run(`update erp_access.membership set active=false where user_id=${quote(finance)};`));
  blocker.end('commit;');released=true;ok(await blocker.done);rejected(await pending,'42501');
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{
  if(!released)blocker.end('rollback;');await blocker.done;if(pending)await pending;
  ok(await run(`update erp_access.membership set active=true where user_id=${quote(finance)};`));
 }
}
function cleanup(){
 for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}
 if(container){const own=container;container=null;execFileSync('docker',['rm','--force',own],{stdio:'pipe',timeout:15000});}
}
const interrupt=()=>{try{cleanup();}finally{process.exitCode=130;process.exit();}};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 // --pull=never avoids network even when the official image is absent locally.
 container=execFileSync('docker',['create','--pull=never','--name',name,'--network','none','--memory','256m','--memory-swap','256m','--cpus','1','--shm-size','32m','--tmpfs','/var/lib/postgresql/data:rw,size=128m','--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB='+database,'postgres:17-alpine','postgres','-c','shared_buffers=32MB','-c','work_mem=2MB','-c','maintenance_work_mem=16MB','-c','max_connections=12','-c','max_worker_processes=2','-c','max_parallel_workers=0','-c','huge_pages=off'],{encoding:'utf8',timeout:30000}).trim();
 assert.match(container,/^[a-f0-9]{64}$/);
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8',timeout:5000}))[0];
 assert.equal(info.Name,'/'+name);assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(info.HostConfig.Memory,268435456);assert.equal(info.HostConfig.MemorySwap,268435456);assert.ok(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);assert.equal(info.Mounts.some(m=>['bind','volume'].includes(m.Type)),false);assert.equal(Object.keys(info.HostConfig.PortBindings??{}).length,0);
 execFileSync('docker',['start',container],{stdio:'pipe',timeout:10000});
 const readyUntil=Date.now()+20000;
 while(true){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],{stdio:'pipe',timeout:2000});break;}catch(error){if(Date.now()>readyUntil)throw error;await pause(100);}}
 let bootstrap='create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);';
 for(const file of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0010_erp_finance','0053_finance_transfers'])bootstrap+='\n'+await readFile(new URL(`../../supabase/migrations/20261016${file}.sql`,import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(finance)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(finance)},'financeiro');`));
 today=value(await run("select jsonb_build_object('today',(clock_timestamp()at time zone'America/Sao_Paulo')::date::text);")).today;
 {
  const[a,b]=await pair(),args=transfer(a,b),sql=postSql(args);
  await race('same_command_exactly_one_pair',sql,sql,async(one,two)=>{
   const first=value(one),replay=value(two);assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,first.receipt);assert.deepEqual(replay.current,first.current);await assertPair(first);
   const state=await financialState([a.id,b.id]);assert.equal(state.transfers,1);assert.equal(state.legs,2);assert.ok(state.accounts.every(a=>a.version===2));
  });
 }
 {
  const[a,b]=await pair(),first=transfer(a,b),second=transfer(a,b);
  await race('different_commands_same_CAS_one_conflict',postSql(first),postSql(second),async(one,two)=>{
   await assertPair(value(one));rejected(two,'40001');rejected(await run(roleSql(rpcSql('erp_finance_transfer_command',{p_user_id:finance,p_command_id:second.p_command_id}))),'P0002');
   const state=await financialState([a.id,b.id]);assert.equal(state.transfers,1);assert.equal(state.legs,2);assert.ok(state.accounts.every(a=>a.version===2));
  });
 }
 {
  // Hold the lowest UUID, then start BOTH directions. Neither may hold the high
  // UUID while waiting for low; NOWAIT on high independently proves that order.
  const[low,high]=(await pair()).sort((a,b)=>a.id.localeCompare(b.id));
  const forward=transfer(low,high),backward=transfer(high,low),blocker=session();let released=false,one,two;
  blocker.write(`begin;select id from erp_finance.account where id=${quote(low.id)}for update;\n\\echo FIRST_DONE`);
  try{
   await blocker.marker('FIRST_DONE');const app1='transfer053_'+randomUUID(),app2='transfer053_'+randomUUID();
   one=run(`set application_name=${quote(app1)};set lock_timeout='12s';set statement_timeout='20s';${postSql(forward)}`);
   two=run(`set application_name=${quote(app2)};set lock_timeout='12s';set statement_timeout='20s';${postSql(backward)}`);
   await waiting(app1);await waiting(app2);
   ok(await run(`begin;select id from erp_finance.account where id=${quote(high.id)}for update nowait;rollback;`));
   blocker.end('commit;');released=true;ok(await blocker.done);
   const answers=await Promise.all([one,two]),winner=answers.findIndex(r=>r.code===0);assert.ok(winner>=0);rejected(answers[1-winner],'40001');await assertPair(value(answers[winner]));
   const loser=[forward,backward][1-winner];const retried=await post({...loser,p_data:{...loser.p_data,expected_from_version:2,expected_to_version:2}});await assertPair(retried);
   const state=await financialState([low.id,high.id]);assert.equal(state.transfers,2);assert.equal(state.legs,4);assert.ok(state.accounts.every(a=>a.version===3&&a.balance==='0'));
   results.push({scenario:'opposite_directions_lock_UUID_order_then_explicit_CAS_retry',lock_wait_observed:true,high_UUID_not_locked_before_low:true,passed:true});
  }finally{if(!released)blocker.end('rollback;');await blocker.done;if(one)await one;if(two)await two;}
 }
 {
  const[a,b]=await pair(),args=transfer(a,b),done=await post(args),before=await financialState([a.id,b.id]);
  await revokeWhileWaiting('replay_reauthorizes_after_command_wait',`select pg_advisory_xact_lock(hashtextextended(${quote(args.p_command_id)},0));`,args);
  assert.deepEqual(await financialState([a.id,b.id]),before);await assertPair(done);assert.equal((await post(args)).replayed,true);
 }
 {
  const[a,b]=await pair(),args=transfer(a,b),before=await financialState([a.id,b.id]),lowest=[a.id,b.id].sort()[0];
  await revokeWhileWaiting('new_write_reauthorizes_after_account_wait',`select id from erp_finance.account where id=${quote(lowest)}for update;`,args);
  assert.deepEqual(await financialState([a.id,b.id]),before);rejected(await run(roleSql(rpcSql('erp_finance_transfer_command',{p_user_id:finance,p_command_id:args.p_command_id}))),'P0002');
 }
 for(const transferFirst of[false,true]){
  const[a,b]=await pair(),args=transfer(a,b),opening=nativeArgs('opening',{id:a.id,expected_version:1,amount_cents:'1',posted_on:today,note:'Abertura fictícia'},args.p_command_id);
  const transferSql=postSql(args),legacySql=roleSql(rpcSql('erp_finance_execute',opening));
  await race(transferFirst?'transfer_before_010_same_command':'010_before_transfer_same_command',transferFirst?transferSql:legacySql,transferFirst?legacySql:transferSql,async(one,two)=>{
   rejected(two,'40001');if(transferFirst)await assertPair(value(one));else{assert.equal(value(one).action,'opening');const state=await financialState([a.id,b.id]);assert.equal(state.transfers,0);assert.equal(state.legs,0);}
  });
 }
 const totals=value(await run("select jsonb_build_object('transfers',(select count(*)from erp_finance.transfer),'transfer_legs',(select count(*)from erp_finance.movement where transfer_id is not null),'transfer_sum',(select sum(delta_cents)::text from erp_finance.movement where transfer_id is not null),'transfer_commands',(select count(*)from erp_finance.command where result->>'action'='internal_transfer'),'transfer_audits',(select count(*)from erp_finance.audit where action='internal_transfer'),'titles',(select count(*)from erp_finance.title),'settlements',(select count(*)from erp_finance.settlement));"));
 assert.deepEqual(totals,{transfers:6,transfer_legs:12,transfer_sum:'0',transfer_commands:6,transfer_audits:6,titles:0,settlements:0});
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',multi_session:true,network:'none',memory_bytes:268435456,storage:'tmpfs',scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
