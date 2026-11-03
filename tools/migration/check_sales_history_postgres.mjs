// Synthetic083 races in one disposable PostgreSQL17 cluster; private Unix socket, no TCP.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
const bin=process.env.BRUFAP_TEST_PG17_BIN;assert.ok(typeof bin==='string'&&isAbsolute(bin));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-sales-history083-'),socket=join(root,'s'),port='56583';
await chmod(root,0o700);await mkdir(socket,{mode:0o700});let started=false;const children=new Set(),results=[];
const quote=v=>v===null?'null':typeof v==='number'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'";
function session(){const p=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});children.add(p);let out='',err='',ended=false;const timer=setTimeout(()=>p.kill('SIGKILL'),30000);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.stdin.on('error',()=>{});p.stdout.on('data',b=>{out+=b;if(out.length>2097152)p.kill('SIGKILL');});p.stderr.on('data',b=>{err+=b;if(err.length>65536)p.kill('SIGKILL');});p.on('close',code=>{ended=true;children.delete(p);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});return{done,write:s=>p.stdin.write(s+'\n'),end:s=>p.stdin.end(s+'\n'),async marker(v){const end=Date.now()+10000;while(!out.includes(v)){assert.equal(ended,false,err);assert.ok(Date.now()<end,'Marker timeout');await new Promise(r=>setTimeout(r,15));}}};}
async function run(sql){const s=session();s.end(sql);return s.done;}const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const result=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')||x.startsWith('[')));
const rpcSql=(name,args)=>{assert.match(name,/^erp_[a-z_]+$/);return `set local role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>{assert.match(k,/^p_[a-z_]+$/);return `${k}=>${quote(v)}`;}).join(',')});`;};
const rpc=async(name,args)=>result(await run('begin;'+rpcSql(name,args)+'commit;'));
async function waitLock(name){const end=Date.now()+10000;while(true){const r=ok(await run(`select count(*)from pg_stat_activity where application_name='${name}'and wait_event_type='Lock';`));if(r.out.trim()==='1')return;assert.ok(Date.now()<end,'Expected lock wait');await new Promise(r=>setTimeout(r,20));}}
async function race(name,firstSql,secondSql,{secondError=null,release='commit;'}={}){const first=session(),second=session();first.write(`begin;${firstSql}\n\\echo HELD`);try{await first.marker('HELD');second.end(`set application_name='${name}';begin;${secondSql}commit;`);await waitLock(name);first.end(release);const a=ok(await first.done),b=await second.done;if(secondError){assert.equal(b.code,3);assert.match(b.err,new RegExp(secondError));assert.doesNotMatch(b.err,/40P01/);}else ok(b);results.push({scenario:name,passed:true,lock_wait_observed:true});return{first:a,second:b};}finally{if(children.size){first.end('rollback;');second.end('rollback;');await Promise.allSettled([first.done,second.done]);}}}
const admin=randomUUID(),other=randomUUID();
const fingerprintSql=`do $$declare r record;v jsonb;all_rows jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname like 'erp_%'or n.nspname in('origin_sync','origin_backup','origin_reference_fetch','auth','storage'))and n.nspname<>'erp_sales_history'and not(n.nspname='origin_sync'and c.relname='raw_record')order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),'''')))from %I.%I x',r.ns,r.name)into v;all_rows:=all_rows||jsonb_build_object(r.ns||'.'||r.name,v);end loop;
 perform set_config('brufap.history_fixture',all_rows::text,false);end$$;select current_setting('brufap.history_fixture')::jsonb;`;
const fingerprint=async()=>result(await run(fingerprintSql));
const countHistory=async id=>result(await run(`select jsonb_build_object('snapshots',(select count(*)from erp_sales_history.snapshot where source_id=${quote(id)}),'commands',(select count(*)from erp_sales_history.command c join erp_sales_history.snapshot s using(history_id)where s.source_id=${quote(id)}));`));
const captureSql=p=>rpcSql('erp_origin_sales_history_capture',p);
const preview=async id=>rpc('erp_origin_sales_history_preview',{p_user_id:admin,p_source_id:id});
const prepare=async id=>{const p=await preview(id);return{p_user_id:admin,p_source_id:id,p_source_hash:p.source.source_hash,p_source_version:p.source.source_version,p_snapshot_hash:p.snapshot_hash,p_command_id:randomUUID()};};
const roleRestore=async()=>ok(await run(`update erp_access.membership set active=true,role='admin'where user_id='${admin}';`));
const checkFailure=async(id,p)=>{assert.deepEqual(await countHistory(id),{snapshots:0,commands:0});const r=await run(`begin;${rpcSql('erp_origin_sales_history_command',{p_user_id:admin,p_command_id:p.p_command_id})}commit;`);assert.equal(r.code,3);assert.match(r.err,/P0002/);};
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=81).sort();assert.equal(files.length,81);for(const name of files)ok(await run(await readFile(new URL(name,dir),'utf8')));
 ok(await run(`insert into auth.users values('${admin}'),('${other}');insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${other}','admin');insert into origin_sync.resource_state(resource)values('sales_orders');`));
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const contact=await catalog('contacts',{name:'Contato sintético083'}),product=await catalog('products',{name:'Produto sintético083',unit:'UN',kind:'P',format:'S',price:'1.2345678912'});
 await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-17',contact_id:contact.id,items:[{product_id:product.id,description:'Pedido preservado',unit:'UN',quantity:'1',unit_price:'1.2345678912'}]}});
 ok(await run(`insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents)values('${randomUUID()}',1,1,'receivable','${contact.id}','Título sintético','2026-10-17','2026-11-17',123);insert into storage.buckets(id,name,public)values('synthetic083','synthetic083',false);insert into storage.objects values('synthetic083','synthetic','{}');`));
 for(let id=101;id<=115;id++){const p={id,numero:1,contato:{id:21},itens:[{codigo:'SYNTHETIC',produto:{id:22},unidade:'CX',quantidade:2,valor:1.23}],total:1};ok(await run(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('sales_orders','sales_orders','${id}',${quote(p)}::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',${quote(p)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'));`));}
 const initial=await fingerprint(),source=await readFile(new URL('202610160083_origin_sales_history.sql',dir),'utf8');ok(await run(source));assert.deepEqual(await fingerprint(),initial);
 {
  const p=await prepare('101'),r=await race('same_command_replay',captureSql(p),captureSql(p));assert.deepEqual(result(r.first).receipt,result(r.second).receipt);assert.deepEqual(await countHistory('101'),{snapshots:1,commands:1});
  await race('same_command_different_body',`select pg_advisory_xact_lock(174853083,hashtext('${p.p_command_id}'));`,captureSql({...p,p_snapshot_hash:'f'.repeat(64)}),{secondError:'40001'});
  await race('same_command_other_actor',`select pg_advisory_xact_lock(174853083,hashtext('${p.p_command_id}'));`,captureSql({...p,p_user_id:other}),{secondError:'40001'});
  await race('replay_rechecks_admin_after_wait',`select pg_advisory_xact_lock(174853083,hashtext('${p.p_command_id}'));`,captureSql(p),{secondError:'42501',release:`update erp_access.membership set active=false where user_id='${admin}';commit;`});await roleRestore();assert.deepEqual(await countHistory('101'),{snapshots:1,commands:1});
 }
 {
  const p=await prepare('102');await race('same_source_distinct_commands',captureSql(p),captureSql({...p,p_command_id:randomUUID()}),{secondError:'40001'});assert.deepEqual(await countHistory('102'),{snapshots:1,commands:1});
 }
 for(const[id,patch,name]of[['103','active=false','source_wait_membership_revoked'],['104',"role='consulta'",'source_wait_role_changed']]){
  const p=await prepare(id);await race(name,`select pg_advisory_xact_lock(174853084,hashtext('${id}'));`,captureSql(p),{secondError:'42501',release:`update erp_access.membership set ${patch} where user_id='${admin}';commit;`});await roleRestore();await checkFailure(id,p);
 }
 {
  const p=await prepare('105');await race('raw_source_version_changed_during_wait',"select source_id from origin_sync.raw_record where entity='sales_orders'and source_id='105'for update;",captureSql(p),{secondError:'40001',release:"update origin_sync.raw_record set version=version+1 where entity='sales_orders'and source_id='105';commit;"});await checkFailure('105',p);
 }
 {
  const p=await prepare('106');await race('price_capture_changed_during_wait',"select source_id from origin_sync.raw_record where entity='sales_orders'and source_id='106'for update;",captureSql(p),{secondError:'40001',release:"update origin_sync.raw_record set price_capture='{}'where entity='sales_orders'and source_id='106';commit;"});await checkFailure('106',p);
 }
 {
  const p=await prepare('107');await race('membership_locked_then_revoked',`select user_id from erp_access.membership where user_id='${admin}'for update;`,captureSql(p),{secondError:'42501',release:`update erp_access.membership set active=false where user_id='${admin}';commit;`});await roleRestore();await checkFailure('107',p);
 }
 {
  const p=await prepare('108');await race('capture_holds_admin_until_commit',captureSql(p),`update erp_access.membership set active=false where user_id='${admin}';`);await roleRestore();assert.deepEqual(await countHistory('108'),{snapshots:1,commands:1});
 }
 {
  const p=await prepare('109');const r=await race('capture_holds_source_until_commit',captureSql(p),"update origin_sync.raw_record set version=version+1 where entity='sales_orders'and source_id='109';");const saved=result(r.first).receipt;const detail=await rpc('erp_origin_sales_history_detail',{p_user_id:admin,p_history_id:saved.history_id});assert.equal(detail.current.source.state,'changed');assert.equal(detail.snapshot.source.source_version,'1');
 }
 {
  const p=await prepare('110');const r=await run(`begin;${captureSql(p)}select 1/0;commit;`);assert.equal(r.code,3);assert.match(r.err,/22012/);await checkFailure('110',p);results.push({scenario:'late_transaction_failure_rolls_back_snapshot_and_command',passed:true});
 }
 {
  const p=await prepare('111');await race('source_captured_and_actor_revoked_during_wait',captureSql({...p,p_user_id:other}),captureSql(p),{secondError:'42501',release:`reset role;update erp_access.membership set active=false where user_id='${admin}';commit;`});await roleRestore();assert.deepEqual(await countHistory('111'),{snapshots:1,commands:1});
 }
 for(const[id,mutation,name]of[['112',"update origin_sync.raw_record set version=version+1 where entity='sales_orders'and source_id='112';",'raw_changed_and_actor_revoked_during_wait'],['113',"delete from origin_sync.raw_record where entity='sales_orders'and source_id='113';",'raw_deleted_and_actor_revoked_during_wait']]){
  const p=await prepare(id);await race(name,`select source_id from origin_sync.raw_record where entity='sales_orders'and source_id='${id}'for update;`,captureSql(p),{secondError:'42501',release:`${mutation}update erp_access.membership set active=false where user_id='${admin}';commit;`});await roleRestore();await checkFailure(id,p);
 }
 assert.deepEqual(await fingerprint(),initial);results.push({scenario:'all_previous_ledgers_native_order_catalog_auth_storage_preserved',passed:true});
 console.log(JSON.stringify({profile:'sales-history-083-postgres-v1',source_sha256:createHash('sha256').update(source).digest('hex'),postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,protected_tables:Object.keys(initial).length,scenarios:results},null,2));
}finally{
 for(const child of children)child.kill('SIGKILL');
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-sales-history083-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
