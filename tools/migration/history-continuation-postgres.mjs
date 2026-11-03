// PostgreSQL17-only concurrency checks in an owned disposable Unix-socket cluster.
// Loads synthetic 001–092; never opens a project database or a TCP listener.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const q=v=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'";
const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'Explicit local PostgreSQL17 binary directory required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const tempBase=await realpath(process.env.BRUFAP_TEST_TMPDIR??tmpdir()),tempStat=await lstat(tempBase);
assert.match(tempBase,/^\/[A-Za-z0-9_./-]*$/);assert.ok(tempStat.isDirectory());
assert.ok(!(tempStat.mode&0o022)||(tempStat.mode&0o1000),'Shared temporary parent must have sticky bit');
const root=await mkdtemp(join(tempBase,'brufap-migration093-')),identity=await lstat(root),socket=join(root,'s'),port='56593';
assert.ok(Buffer.byteLength(join(socket,`.s.PGSQL.${port}`))<104);await mkdir(socket,{mode:0o700});
let started=false;const children=new Set(),results=[];
async function assertOwned(){const st=await lstat(root);assert.equal(dirname(root),tempBase);assert.match(basename(root),/^brufap-migration093-[A-Za-z0-9]+$/);assert.ok(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.dev,identity.dev);assert.equal(st.ino,identity.ino);assert.equal(await realpath(root),root);}
function session(){
 const child=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
 children.add(child);let out='',err='',ended=false;const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.stdin.on('error',()=>{});child.stdout.on('data',b=>{out+=b;if(out.length>8388608)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>262144)child.kill('SIGKILL');});child.on('close',code=>{ended=true;children.delete(child);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});
 return{done,write:s=>child.stdin.write(s+'\n'),end:s=>{if(!child.stdin.writableEnded)child.stdin.end(s+'\n');},async marker(mark){const until=Date.now()+10000;while(!out.includes(mark)){assert.equal(ended,false,err);assert.ok(Date.now()<until,'Marker timeout');await new Promise(r=>setTimeout(r,15));}}};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const value=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')||x.startsWith('[')));
const rejected=(r,code)=>{assert.equal(r.code,3,r.err);assert.match(r.err,new RegExp(`ERROR:\\s+${code}:`));assert.doesNotMatch(r.err,/40P01/);};
const record=(scenario,detail={})=>{results.push({scenario,passed:true,...detail});process.stderr.write('PASS '+scenario+'\n');};
const owner=randomUUID(),token=randomUUID(),actor=randomUUID();
const sourceUrl=new URL('../../supabase/migrations/202610170093_origin_sales_history_continuation.sql',import.meta.url),source=await readFile(sourceUrl,'utf8'),sourceHash=sha(source);
const rpc=(name,args)=>`set local role service_role;select public.erp_origin_sales_history_continuation_${name}(${Object.entries({p_user_id:actor,...args}).map(([k,v])=>`${k}=>${q(v)}`).join(',')});`;
const fenced={p_owner:owner,p_scheduler_token:token};
const prepare=async()=>value(await run('begin;'+rpc('prepare',{...fenced,p_batch_id:randomUUID()})+'commit;'));
const applySql=p=>rpc('apply',{...fenced,p_batch_id:p.batch_id,p_prepare_hash:p.prepare_hash});
const apply=p=>run("begin;set local statement_timeout='5s';"+applySql(p)+'commit;');
const history=async()=>value(await run("select jsonb_build_object('snapshots',(select coalesce(jsonb_agg(to_jsonb(s)order by source_id),'[]')from erp_sales_history.snapshot s),'commands',(select coalesce(jsonb_agg(to_jsonb(c)order by command_id),'[]')from erp_sales_history.command c));"));
const {parseSalesPriceJson,salesPriceCapture}=await import('../../workers/origin-sync/src/sales-price-json.mjs');
let seq=939000;
async function sale(){
 const id=String(++seq),wire=JSON.stringify({data:{id,itens:[{id:1,quantidade:2,valor:1.23456789}],data:'2024-01-01'}});
 const parsed=await parseSalesPriceJson(wire,new TextEncoder().encode(wire),'sales_detail'),capture=salesPriceCapture(parsed.data);
 ok(await run(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash)
 values('sales_orders','sales_orders',${q(id)},${q(parsed.data)}::jsonb,'[]',encode(sha256(convert_to(jsonb_build_object('payload',${q(parsed.data)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'));
 update origin_sync.raw_record set price_capture=${q(capture)}::jsonb||jsonb_build_object('source_hash',version_hash,'source_version',version::text,'capture_id',gen_random_uuid(),'observed_at',clock_timestamp())where entity='sales_orders'and source_id=${q(id)};`));return id;
}
const functionsSql="select coalesce(jsonb_object_agg(p.oid::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),'{}')from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname~'^(erp|origin)_'or n.nspname='public')and n.nspname<>'erp_sales_history_continuation'and p.proname!~'^erp_origin_sales_history_continuation_';";
async function protectedData(){return value(await run(`do $$declare r record;v jsonb;out jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))and n.nspname not in('erp_sales_history_continuation','erp_sales_history')and not(n.nspname='origin_sync'and c.relname in('raw_record','resource_state'))order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),''''),''UTF8'')),''hex''))from %I.%I x',r.ns,r.name)into v;out:=out||jsonb_build_object(r.ns||'.'||r.name,v);end loop;
 perform set_config('brufap.history093_test',out::text,false);end$$;select current_setting('brufap.history093_test')::jsonb;`));}
async function heldFailure(name,hold,p){const holder=session();holder.write('begin;'+hold+'\n\\echo HELD');try{
 await holder.marker('HELD');const at=Date.now();rejected(await apply(p),'55P03');assert.ok(Date.now()-at<2500,'NOWAIT must not approach statement timeout');record(name,{elapsed_ms:Date.now()-at});
}finally{holder.end('rollback;');ok(await holder.done);}}
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610(?:16|17)0\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=92).sort();assert.equal(files.length,92);
 for(const f of files)ok(await run(await readFile(new URL(f,dir),'utf8')));
 ok(await run(`insert into auth.users(id)values('${actor}');insert into erp_access.membership(user_id,role)values('${actor}','admin');insert into origin_sync.resource_state(resource,lease_owner,lease_token,lease_expires_at)values('__scheduler__','${owner}','${token}',clock_timestamp()+interval'10 minutes'),('sales_orders',null,null,null)on conflict(resource)do update set lease_owner=excluded.lease_owner,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at;`));
 const baselineFunctions=value(await run(functionsSql)),before=await protectedData();ok(await run(source));assert.deepEqual(value(await run(functionsSql)),baselineFunctions);assert.deepEqual(await protectedData(),before);record('all_001_092_functions_and_163_non_history_non_source_tables_preserved_at_install');
 const id=await sale(),p=await prepare();assert.equal(p.proof.items.length,1);
 await heldFailure('scheduler_transition_nowait',"select resource from origin_sync.resource_state where resource='__scheduler__'for update;",p);
 await heldFailure('membership_revocation_nowait',`select user_id from erp_access.membership where user_id='${actor}'for update;`,p);
 await heldFailure('auth_user_deletion_nowait',`select id from auth.users where id='${actor}'for update;`,p);
 await heldFailure('raw_source_update_nowait',`select source_id from origin_sync.raw_record where entity='sales_orders'and source_id='${id}'for update;`,p);
 await heldFailure('old083_command_advisory_nowait',`select pg_advisory_xact_lock(174853083,hashtext('${p.proof.items[0].command_id}'));`,p);
 await heldFailure('old083_source_advisory_nowait',`select pg_advisory_xact_lock(174853084,hashtext('${id}'));`,p);
 await heldFailure('another_continuation_nowait','select pg_advisory_xact_lock(174853093,0);',p);
 await heldFailure('history_ddl_nowait','lock table erp_sales_history.snapshot in access exclusive mode;',p);
 const holder=session();holder.write(`begin;select source_id from origin_sync.raw_record where source_id='${id}'for share;\n\\echo SHARED`);
 try{await holder.marker('SHARED');const done=value(await apply(p));assert.equal(done.status,'applied');record('compatible_source_reader_allows_capture');}finally{holder.end('rollback;');ok(await holder.done);}
 const preserved=await history(),recovered=value(await run('begin;'+rpc('get',{p_batch_id:p.batch_id})+'commit;'));assert.equal(recovered.batch.status,'applied');assert.deepEqual(recovered.batch.terminal.result.receipts.map(x=>x.command_id),p.proof.items.map(x=>x.command_id));assert.deepEqual(value(await apply(p)),recovered.batch);record('commit_ACK_loss_recovered_exactly_and_replay_cannot_duplicate083');
 // A live single-source083 command can win between prepare and apply. Batch rejection must retain its UUIDs and add nothing.
 const id2=await sale(),p2=await prepare(),it=p2.proof.items[0];
 ok(await run(`set role service_role;select public.erp_origin_sales_history_capture('${actor}','${id2}','${it.source_hash}','${it.source_version}','${it.snapshot_hash}','${randomUUID()}');`));
 const beforeConflict=await history(),conflict=value(await apply(p2));assert.equal(conflict.status,'rejected');assert.equal(conflict.terminal.result.reason,'already_captured');assert.deepEqual(await history(),beforeConflict);record('single083_winner_rejects_batch_without_overwriting_or_partial_history');
 const id3=await sale(),p3=await prepare(),writer=session();writer.write(`begin;update origin_sync.raw_record set last_seen_at=last_seen_at+interval'1 microsecond'where entity='sales_orders'and source_id='${id3}';\n\\echo CHANGED`);
 try{await writer.marker('CHANGED');rejected(await apply(p3),'55P03');writer.end('commit;');ok(await writer.done);const result=value(await apply(p3));assert.equal(result.status,'rejected');assert.equal(result.terminal.result.reason,'source_changed');record('concurrent_source_change_nowait_then_durable_CAS_rejection');}finally{writer.end('rollback;');await writer.done;}
 const p4=await prepare();assert.equal(value(await apply(p4)).status,'applied');
 const id4=await sale(),p5=await prepare();ok(await run(`update erp_access.membership set active=false where user_id='${actor}';`));rejected(await apply(p5),'42501');ok(await run(`update erp_access.membership set active=true where user_id='${actor}';`));assert.equal(value(await apply(p5)).status,'applied');record('committed_admin_revocation_rejects_until_explicit_restore');
 const final=await history();for(const old of preserved.snapshots)assert.deepEqual(final.snapshots.find(x=>x.source_id===old.source_id),old);for(const old of preserved.commands)assert.deepEqual(final.commands.find(x=>x.command_id===old.command_id),old);
 assert.deepEqual(await protectedData(),before);assert.deepEqual(value(await run(functionsSql)),baselineFunctions);
 for(const role of['anon','authenticated'])rejected(await run(`set role ${role};select public.erp_origin_sales_history_continuation_get('${actor}',null);`),'42501');
 const acl=value(await run("select jsonb_build_object('functions',count(*),'bad_acl',coalesce(sum((select count(*)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee<>p.proowner and(a.is_grantable or a.grantee<>to_regrole('service_role')or n.nspname<>'public'))),0),'bad_search_path',count(*)filter(where not('search_path=pg_catalog'=any(p.proconfig))))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_sales_history_continuation'or(n.nspname='public'and p.proname~'^erp_origin_sales_history_continuation_');"));assert.deepEqual(acl,{functions:9,bad_acl:0,bad_search_path:0});record('private_tables_five_helpers_four_service_only_rpcs_and_prior_records_preserved');
 assert.equal(sha(await readFile(sourceUrl,'utf8')),sourceHash);
 console.log(JSON.stringify({profile:'origin-history-continuation-093-postgres-v1',source_sha256:sourceHash,postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,real_data:false,baseline:'001-092',protected_tables:Object.keys(before).length,passed:results.length,scenarios:results},null,2));
}finally{
 for(const child of children)child.kill('SIGKILL');await assertOwned();
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 await assertOwned();await rm(root,{recursive:true,force:true});
}
