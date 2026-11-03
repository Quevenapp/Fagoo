// Real PostgreSQL concurrency probe using only fictitious native accounts.
// No bank API, secrets, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {createNetCreditFixture} from '../../workers/erp-api/test/helpers/itau-net-credit-fixture.mjs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const name='brufap-netcredit058-'+randomUUID(),database='brufap_synthetic';
const sessions=new Set(),results=[];
let f;
let container=null;
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+(['p_event_hashes','p_controls'].includes(key)?'ARRAY['+value.map(quote).join(',')+']::text[]':quote(value));}).join(',')});`;};
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
 const first=session(),application='netcredit058_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{if(!ended)first.end('rollback;');await first.done;if(second)await second;}
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
 const adapter={
  exec:async sql=>{ok(await run(sql));},
  query:async(sql,args=[])=>{const bound=sql.replace(/\$(\d+)/g,(_,n)=>quote(args[Number(n)-1]));if(/^\s*select\b/i.test(bound)){
   const answer=ok(await run(`select coalesce(jsonb_agg(row_to_json(q)),'[]')from(${bound})q;`));return{rows:JSON.parse(answer.stdout.trim())};
  }ok(await run(bound));return{rows:[]};},close:async()=>{},
 };
 f=await createNetCreditFixture({database:adapter,invokeRpc:rpc});
 const manual=(p,action,data={},command=randomUUID())=>({p_user_id:f.users.financeiro,p_command_id:command,p_action:action,p_data:{id:p.source.title.id,expected_version:action==='reverse'?2:1,posted_on:f.today,...(action==='settle'?{account_id:p.source.account.id,principal_cents:'12345'}:{settlement_id:p.receipt.settlement_id,note:'ESTORNO SINTETICO'}),...data}});
 const paymentSql=args=>roleSql(rpcSql('erp_cnab_itau_net_credit_settle',args));
 const engineSql=args=>roleSql(rpcSql('erp_finance_execute',args));
 async function prepared(){const source=await f.prepare(),category=await f.category(),imported=await f.importFile(source,f.source(source,{paid:'12000',fee:'345'})),preview=await f.netPreview(imported,category);assert.equal(preview.context.settlement.allowed,true);return{source,category,imported,body:f.netCommand(imported,category,preview)};}
 async function position(p){return value(await run(`select jsonb_build_object('settlements',(select count(*)from erp_finance.settlement where title_id=${quote(p.source.title.id)}),'movements',(select count(*)from erp_finance.movement where account_id=${quote(p.source.account.id)}),'cash',(select coalesce(sum(delta_cents),0)::text from erp_finance.movement where account_id=${quote(p.source.account.id)}),'dedupe',(select count(*)from erp_cnab.operational_settlement where title_id=${quote(p.source.title.id)}),'plans',(select count(*)from erp_finance.cnab_cash_plan where title_id=${quote(p.source.title.id)}),'settled',(select settled_cents::text from erp_finance.title where id=${quote(p.source.title.id)}));`));}
 async function assertPaid(p){assert.deepEqual(await position(p),{settlements:1,movements:2,cash:'12000',dedupe:1,plans:1,settled:'12345'});}
 async function revocation(scenario,lockSql,pendingSql,code='42501'){
  const block=session(),application='netcredit058_'+randomUUID();let released=false,pending;
  block.write(`begin;set local lock_timeout='12s';${lockSql}\n\\echo FIRST_DONE`);
  try{await block.marker('FIRST_DONE');pending=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${pendingSql}`);await waiting(application);
   ok(await run(`update erp_access.membership set active=false where user_id=${quote(f.users.financeiro)};`));
   block.end('commit;');released=true;ok(await block.done);rejected(await pending,code);results.push({scenario,lock_wait_observed:true,passed:true});
  }finally{if(!released)block.end('rollback;');await block.done;if(pending)await pending;ok(await run(`update erp_access.membership set active=true where user_id=${quote(f.users.financeiro)};`));}
 }
 {
  const p=await prepared();await race('same_command_one_pair_then_historical_replay',paymentSql(p.body),paymentSql(p.body),async(a,b)=>{const first=value(a),second=value(b);assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.deepEqual(first.receipt,second.receipt);await assertPaid(p);});
 }
 {
  const p=await prepared(),other={...p.body,p_command_id:randomUUID()};await race('different_commands_same_event_one_conflict',paymentSql(p.body),paymentSql(other),async(a,b)=>{value(a);rejected(b,'40001');await assertPaid(p);});
 }
 for(const netFirst of[false,true]){
  const p=await prepared(),legacy=manual(p,'settle');
  await race(netFirst?'net_before_manual_no_deadlock':'manual_before_net_no_deadlock',netFirst?paymentSql(p.body):engineSql(legacy),netFirst?engineSql(legacy):paymentSql(p.body),async(a,b)=>{
   value(a);rejected(b,'40001');if(netFirst)await assertPaid(p);else assert.deepEqual(await position(p),{settlements:1,movements:1,cash:'12345',dedupe:0,plans:0,settled:'12345'});
  });
 }
 {
  const p=await prepared();p.receipt=(await rpc('erp_cnab_itau_net_credit_settle',p.body)).receipt;const reverse=manual(p,'reverse');
  await race('same_reversal_command_one_inverse_pair',engineSql(reverse),engineSql(reverse),async(a,b)=>{const first=value(a),second=value(b);assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.equal(second.settlement.id,first.settlement.id);assert.deepEqual(await position(p),{settlements:2,movements:4,cash:'0',dedupe:1,plans:1,settled:'0'});});
 }
 {
  const p=await prepared();p.receipt=(await rpc('erp_cnab_itau_net_credit_settle',p.body)).receipt;const reverse=manual(p,'reverse');
  await race('different_reversal_commands_one_conflict',engineSql(reverse),engineSql({...reverse,p_command_id:randomUUID()}),async(a,b)=>{value(a);rejected(b,'40001');assert.deepEqual(await position(p),{settlements:2,movements:4,cash:'0',dedupe:1,plans:1,settled:'0'});});
 }
 {
  const p=await prepared();p.receipt=(await rpc('erp_cnab_itau_net_credit_settle',p.body)).receipt;
  await race('reversal_then_payment_replay_preserves_historical_receipt',engineSql(manual(p,'reverse')),paymentSql(p.body),async(a,b)=>{value(a);assert.deepEqual(value(b).receipt,p.receipt);assert.equal(value(b).replayed,true);assert.deepEqual(await position(p),{settlements:2,movements:4,cash:'0',dedupe:1,plans:1,settled:'0'});});
 }
 {
  const p=await prepared();await rpc('erp_cnab_itau_net_credit_settle',p.body);
  await revocation('net_replay_reauthorizes_after_command_wait',`select pg_advisory_xact_lock(hashtextextended(${quote(p.body.p_command_id)},0));`,paymentSql(p.body));await assertPaid(p);
 }
 {
  const p=await prepared();await revocation('net_new_write_reauthorizes_after_title_wait',`select id from erp_finance.title where id=${quote(p.source.title.id)}for update;`,paymentSql(p.body));assert.deepEqual(await position(p),{settlements:0,movements:0,cash:'0',dedupe:0,plans:0,settled:'0'});
 }
 {
  const p=await prepared();p.receipt=(await rpc('erp_cnab_itau_net_credit_settle',p.body)).receipt;const reverse=manual(p,'reverse');
  await revocation('reversal_reauthorizes_after_command_wait',`select pg_advisory_xact_lock(hashtextextended(${quote(reverse.p_command_id)},0));`,engineSql(reverse));await assertPaid(p);
 }
 {
  const p=await prepared();p.receipt=(await rpc('erp_cnab_itau_net_credit_settle',p.body)).receipt;const reverse=manual(p,'reverse');
  await revocation('reversal_reauthorizes_after_title_wait',`select id from erp_finance.title where id=${quote(p.source.title.id)}for update;`,engineSql(reverse));await assertPaid(p);
 }
 const totals=value(await run("select jsonb_build_object('plans',(select count(*)from erp_finance.cnab_cash_plan),'payments',(select count(*)from erp_finance.settlement where kind='payment'),'reversals',(select count(*)from erp_finance.settlement where kind='reversal'),'fee_legs',(select count(*)from erp_finance.movement where kind='bank_fee'),'fee_reversals',(select count(*)from erp_finance.movement where kind='bank_fee_reversal'));"));
 assert.deepEqual(totals,{plans:9,payments:10,reversals:3,fee_legs:9,fee_reversals:3});
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',multi_session:true,network:'none',memory_bytes:268435456,storage:'tmpfs',scenarios:results,totals},null,2));
}finally{await f?.close();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
