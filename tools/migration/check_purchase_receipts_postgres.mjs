// Native PG17 purchase090 races. Disposable synthetic cluster, private Unix socket only.
// No real data, financial operation, network, TLS or existing PostgreSQL instance.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, chmod, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
const quote=v=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'";

const sourceHash='37f5cac3bab4beac61aa1adb9583c799d2c35d12850bf192e49ecf2e7469bc4a';
const fixtureHash='e11784ff16c255b6d24f8919b4eada0b908b89dd258499a4be8daa3594f6e21a';
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(sha(await readFile(new URL('./helpers/purchase-receipts-fixture.mjs',import.meta.url))),fixtureHash);
const bin=process.env.BRUFAP_TEST_PG17_BIN;assert.ok(typeof bin==='string'&&isAbsolute(bin));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const requestedTmp=process.env.BRUFAP_TEST_TMPDIR??tmpdir(),port='56590';
assert.ok(isAbsolute(requestedTmp),'BRUFAP_TEST_TMPDIR must be an absolute existing directory');
const tempBase=await realpath(requestedTmp),tempStat=await lstat(tempBase);
assert.ok(tempStat.isDirectory(),'BRUFAP_TEST_TMPDIR must be a directory');
// pg_ctl passes -o through a shell, and PostgreSQL parses a list of socket directories.
assert.match(tempBase,/^\/[A-Za-z0-9_./-]*$/,'Temporary path must use only ASCII letters, digits, /, _, . and -');
assert.ok(!(tempStat.mode&0o022)||(tempStat.mode&0o1000),'Shared temporary directory must have the sticky bit');
assert.ok(Buffer.byteLength(join(tempBase,'brufap-purchase090-XXXXXX','s',`.s.PGSQL.${port}`))<104,
 'Temporary path is too long for a portable Unix socket; set BRUFAP_TEST_TMPDIR=/tmp');
const root=await mkdtemp(join(tempBase,'brufap-purchase090-')),socket=join(root,'s'),rootIdentity=await lstat(root);
async function assertOwnRoot(){
 assert.equal(dirname(root),tempBase);assert.match(basename(root),/^brufap-purchase090-[A-Za-z0-9]+$/);
 const current=await lstat(root);assert.ok(current.isDirectory()&&!current.isSymbolicLink());
 assert.equal(current.dev,rootIdentity.dev);assert.equal(current.ino,rootIdentity.ino);
 assert.equal(await realpath(root),root,'Refusing to clean a substituted temporary directory');
}
let started=false;const children=new Set(),results=[];let lockWaits=0;
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
const applySql=p=>rpcSql(p.p_receipt_id?'erp_purchase_receipts_reverse':'erp_purchase_receipts_receive',p);
const errorCode=r=>r.err.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]??null;
const expectError=(r,code)=>{assert.equal(r.code,3,r.err);assert.equal(errorCode(r),code,r.err);assert.doesNotMatch(r.err,/40P01/);};
const record=(scenario,extra={})=>{results.push({scenario,passed:true,...extra});process.stderr.write('PASS '+scenario+'\n');};
async function waitLock(name){const until=Date.now()+10000;while(true){const r=ok(await run(`select count(*)from pg_stat_activity where application_name=${quote(name)}and wait_event_type='Lock';`));if(r.out.trim()==='1'){lockWaits++;return;}assert.ok(Date.now()<until,'Expected real lock wait: '+name);await new Promise(r=>setTimeout(r,20));}}
async function race(name,hold,request,{release='commit;'}={}){
  const a=session(),b=session();a.write(`begin;${hold}\n\\echo HELD`);
  try{await a.marker('HELD');b.end(`set application_name=${quote(name)};begin;${request}commit;`);await waitLock(name);a.end(release);return {first:ok(await a.done),second:await b.done};}
  finally{a.end('rollback;');b.end('rollback;');await Promise.allSettled([a.done,b.done]);}
}
const admin=randomUUID(),actor=randomUUID(),day='2026-10-15';
const sigs=['public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)','erp_documents.effect_flags(uuid)'];
const functionSql=`select coalesce(jsonb_object_agg(p.oid::text,encode(sha256(convert_to((case when p.oid=any(array[${sigs.map(x=>quote(x)+'::regprocedure').join(',')}])then to_jsonb(p)-'prosrc'else to_jsonb(p)end)::text,'UTF8')),'hex')),'{}')from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname~'^(erp|origin)_'or n.nspname='public'and p.proname~'^(erp|origin)_')and n.nspname<>'erp_purchase_receipts'and p.proname not like'erp_purchase_receipts_%';`;
async function snapshot({protectedOnly=false}={}){return result(await run(`do $$declare r record;v jsonb;out jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))
 ${protectedOnly?"and n.nspname not in('erp_catalog','erp_documents','erp_stock','erp_access','erp_purchase_receipts','auth')":''}order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),''''),''UTF8'')),''hex''))from %I.%I x',r.ns,r.name)into v;out:=out||jsonb_build_object(r.ns||'.'||r.name,v);end loop;
 perform set_config('brufap.purchase090_snapshot',out::text,false);end$$;select current_setting('brufap.purchase090_snapshot')::jsonb;`));}
const restore=()=>run(`insert into erp_access.membership(user_id,role,active)values('${actor}','estoque',true)on conflict(user_id)do update set role='estoque',active=true;`).then(ok);
const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Synthetic090 state'})).document;
async function setup({quantity='5',initial=null}={}){
 const product=await catalog('products',{name:'Synthetic090 product',unit:'UN',kind:'P',format:'S',price:'1'}),warehouse=await catalog('warehouses',{name:'Synthetic090 warehouse'}),contact=await catalog('contacts',{name:'Synthetic090 contact'});
 async function order(kind='purchase_orders',qty=quantity){let d=(await rpc('erp_document_save',{p_user_id:admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:day,contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Synthetic090 item',unit:'UN',quantity:qty,unit_price:'1'}]}})).document;for(const status of kind==='purchase_orders'?['in_progress']:['open','verified'])d=await transition(d,status);return d;}
 const d=await order(),ids=result(await run(`select jsonb_agg(id order by position)from erp_documents.item where document_id='${d.id}';`));
 const selection=qty=>ids.map(item_id=>({item_id,quantity:qty}));
 const base=(doc=d)=>({p_user_id:actor,p_document_id:doc.id,p_expected_version:doc.version,p_occurred_on:day,p_reason:'Synthetic090 receipt'});
 async function prepare(qty='1',{doc=d,command=randomUUID(),receipt=null}={}){const a={...base(doc),...(receipt?{p_receipt_id:receipt.id}:{p_items:selection(qty)})},p=(await rpc(receipt?'erp_purchase_receipts_reverse_preview':'erp_purchase_receipts_preview',a)).preview;return{...a,p_command_id:command,p_preview_hash:p.preview_hash,p_confirm:true};}
 async function receive(qty='1'){const args=await prepare(qty),r=await rpc('erp_purchase_receipts_receive',args);d.version=r.current.document.version;return{...r,args};}
 async function reverse(receipt){const args=await prepare(null,{receipt}),r=await rpc('erp_purchase_receipts_reverse',args);d.version=r.current.document.version;return{...r,args};}
 async function legacy(doc=d,command=randomUUID()){const a={p_user_id:actor,p_kind:'purchase_orders',p_document_id:doc.id,p_expected_version:doc.version,p_occurred_on:day,p_reason:'Synthetic090 legacy'},p=(await rpc('erp_document_stock_preview',a)).preview;return{...a,p_command_id:command,p_preview_hash:p.preview_hash,p_ignored_item_ids:p.ignored.map(x=>x.id)};}
 async function physical(qty,command=randomUUID()){const v=result(await run(`select jsonb_build_object('v',coalesce((select version from erp_stock.balance where product_id='${product.id}'and warehouse_id='${warehouse.id}'),0));`));return{p_user_id:actor,p_command_id:command,p_kind:qty.startsWith('-')?'issue':'receipt',p_occurred_on:day,p_reason:'Synthetic090 physical',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity:qty,expected_version:v.v}]};}
 async function reserve(sale,command=randomUUID()){const a={p_user_id:actor,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:day,p_reason:'Synthetic090 reserved',p_reservation_id:null,p_reservation_version:null},p=(await rpc('erp_stock_reservation_preview',a)).preview;return{...a,p_command_id:command,p_preview_hash:p.preview_hash,p_ignored_item_ids:p.ignored.map(x=>x.id)};}
 const state=async()=>result(await run(`select jsonb_build_object('physical',coalesce((select quantity::text from erp_stock.balance where product_id='${product.id}'and warehouse_id='${warehouse.id}'),'0.000000'),'movements',(select count(*)from erp_stock.entry where product_id='${product.id}'),'receipts',(select count(*)from erp_purchase_receipts.receipt where document_id='${d.id}'),'reversals',(select count(*)from erp_purchase_receipts.reversal where document_id='${d.id}'),'version',(select version from erp_documents.document where id='${d.id}'));`));
 if(initial)await rpc('erp_stock_post',await physical(initial));
 return{product,warehouse,contact,d,ids,order,selection,base,prepare,receive,reverse,legacy,physical,reserve,state};
}
async function failedRace(name,hold,args,release,expected='40001'){
 const before=await snapshot(),r=await race(name,hold,applySql(args),{release});expectError(r.second,expected);
 const after=await snapshot();for(const k of Object.keys(before))if(!['erp_access.membership','erp_catalog.record','erp_catalog.product','erp_stock.balance','erp_documents.document'].includes(k))assert.deepEqual(after[k],before[k],name+': '+k);
 record(name,{lock_wait_observed:true});return r;
}
try{
 await chmod(root,0o700);await mkdir(socket,{mode:0o700});
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=89).sort();assert.equal(files.length,89);
 const baseline=[];for(const file of files){const sql=await readFile(new URL(file,dir),'utf8');baseline.push({file,sha256:sha(sql)});ok(await run(sql));}
 ok(await run(`alter database postgres set timezone='UTC';insert into auth.users values('${admin}'),('${actor}');insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${actor}','estoque');`));
 const old=await setup(),legacyArgs=await old.legacy(),oldReceipt=await rpc('erp_document_stock_post',legacyArgs);old.d.version=oldReceipt.document_version;
 const before=await snapshot(),functions=result(await run(functionSql));
 const source=await readFile(new URL('202610160090_purchase_receipts.sql',dir),'utf8');assert.equal(createHash('sha256').update(source).digest('hex'),sourceHash);ok(await run(source));
 const after=await snapshot();for(const[k,v]of Object.entries(before))assert.deepEqual(after[k],v,k);assert.deepEqual(result(await run(functionSql)),functions);
 assert.deepEqual(result(await run(`select jsonb_build_object('tables',(select count(*)from pg_class where relnamespace='erp_purchase_receipts'::regnamespace and relkind='r'),'rpc',(select count(*)from pg_proc where pronamespace='public'::regnamespace and proname like'erp_purchase_receipts_%'));`)),{tables:3,rpc:6});
 record('090_preserves_old_rows_all_function_identity_acl_except_two_reviewed_bodies',{old_table_count:Object.keys(before).length});
 const protectedBefore=await snapshot({protectedOnly:true});
 const replayOld=await rpc('erp_document_stock_post',legacyArgs);assert.equal(replayOld.replayed,true);assert.deepEqual(replayOld.posting,oldReceipt.posting);record('legacy018_receipt_replays_without_new_movement');
 for(const role of['anon','authenticated','service_role']){for(const t of['command','receipt','reversal'])expectError(await run(`set role ${role};select*from erp_purchase_receipts.${t};`),'42501');if(role!=='service_role')expectError(await run(`set role ${role};select public.erp_purchase_receipts_get('${actor}','${old.d.id}');`),'42501');}
 const acl=result(await run(`select jsonb_build_object('rls',(select bool_and(relrowsecurity)from pg_class where relnamespace='erp_purchase_receipts'::regnamespace and relkind='r'),'excess_function_grants',(select count(*)from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where(p.pronamespace='erp_purchase_receipts'::regnamespace or p.pronamespace='public'::regnamespace and p.proname like'erp_purchase_receipts_%')and a.grantee<>p.proowner and(a.is_grantable or a.grantee<>to_regrole('service_role')or p.pronamespace<>'public'::regnamespace)));`));assert.deepEqual(acl,{rls:true,excess_function_grants:0});record('private_tables_rls_six_service_only_rpcs_no_grant_option');
 for(const same of[true,false]){
  const f=await setup(),a=await f.prepare('3'),b={...a,p_command_id:same?a.p_command_id:randomUUID()};const r=await race(same?'receive_same_uuid':'receive_two_uuids_cannot_overfill',applySql(a),applySql(b));if(same){assert.deepEqual(result(r.first).receipt,result(r.second).receipt);assert.equal(result(r.second).replayed,true);}else expectError(r.second,'40001');assert.equal((await f.state()).physical,'3.000000');assert.equal((await f.state()).receipts,1);record(same?'receive_same_uuid':'receive_two_uuids_cannot_overfill',{lock_wait_observed:true});
 }
 for(const newFirst of[true,false]){
  const f=await setup(),a=await f.prepare(),b=await f.legacy(),r=await race(newFirst?'partial_before_legacy018':'legacy018_before_partial',newFirst?applySql(a):rpcSql('erp_document_stock_post',b),newFirst?rpcSql('erp_document_stock_post',b):applySql(a));expectError(r.second,'40001');assert.equal((await f.state()).movements,1);record(newFirst?'partial_before_legacy018':'legacy018_before_partial',{lock_wait_observed:true});
 }
 for(const same of[true,false]){
  const f=await setup(),r=await f.receive('3'),a=await f.prepare(null,{receipt:r.receipt.receipt}),b={...a,p_command_id:same?a.p_command_id:randomUUID()};const x=await race(same?'reverse_same_uuid':'reverse_twice_distinct_uuid',applySql(a),applySql(b));if(same){assert.deepEqual(result(x.first).receipt,result(x.second).receipt);assert.equal(result(x.second).replayed,true);}else expectError(x.second,'40001');assert.equal((await f.state()).physical,'0.000000');assert.equal((await f.state()).reversals,1);record(same?'reverse_same_uuid':'reverse_twice_distinct_uuid',{lock_wait_observed:true});
 }
 for(const manualFirst of[false,true]){
  const f=await setup(),a=await f.prepare(),b=await f.physical('1',a.p_command_id);const x=await race(manualFirst?'manual009_uuid_before_partial':'partial_uuid_before_manual009',manualFirst?rpcSql('erp_stock_post',b):applySql(a),manualFirst?applySql(a):rpcSql('erp_stock_post',b));expectError(x.second,'40001');assert.equal((await f.state()).movements,1);assert.equal((await f.state()).receipts,manualFirst?0:1);record(manualFirst?'manual009_uuid_before_partial':'partial_uuid_before_manual009',{lock_wait_observed:true});
 }
 for(const differentActor of[false,true]){
  const f=await setup(),a=await f.prepare(),b={...a,...(differentActor?{p_user_id:admin}:{p_reason:'Different synthetic090 reason'})};const x=await race(differentActor?'same_uuid_other_actor':'same_uuid_other_body',applySql(a),applySql(b));expectError(x.second,'40001');assert.equal((await f.state()).receipts,1);assert.equal((await f.state()).movements,1);record(differentActor?'same_uuid_other_actor':'same_uuid_other_body',{lock_wait_observed:true});
 }
 for(const stage of['command','document','global','record','product','balance','auth','membership']){
  const f=await setup({initial:'1'}),a=await f.prepare();const holds={command:`select pg_advisory_xact_lock(174852918,hashtext('${a.p_command_id}'));`,document:`select id from erp_documents.document where id='${f.d.id}'for update;`,global:'select pg_advisory_xact_lock(174852909,0);',record:`select id from erp_catalog.record where id='${f.product.id}'for update;`,product:`select record_id from erp_catalog.product where record_id='${f.product.id}'for update;`,balance:`select product_id from erp_stock.balance where product_id='${f.product.id}'for update;`,auth:`select id from auth.users where id='${actor}'for update;`,membership:`select user_id from erp_access.membership where user_id='${actor}'for update;`};
  await failedRace('new_receive_acl_revoked_after_'+stage,holds[stage],a,`update erp_access.membership set active=false where user_id='${actor}';${stage==='document'?`update erp_documents.document set version=version+1 where id='${f.d.id}';`:''}commit;`,'42501');assert.equal((await f.state()).receipts,0);await restore();
 }
 for(const stage of['command','auth','membership']){
  const f=await setup(),a=await f.receive(),hold=stage==='command'?`select pg_advisory_xact_lock(174852918,hashtext('${a.args.p_command_id}'));`:stage==='auth'?`select id from auth.users where id='${actor}'for update;`:`select user_id from erp_access.membership where user_id='${actor}'for update;`;
  await failedRace('replay_acl_revoked_after_'+stage,hold,a.args,`update erp_access.membership set active=false where user_id='${actor}';commit;`,'42501');await restore();
 }
 for(const replay of[false,true])for(const stage of['command','auth']){
  const f=await setup(),a=replay?(await f.receive()).args:await f.prepare(),before=await f.state();
  const hold=stage==='command'?`select pg_advisory_xact_lock(174852918,hashtext('${a.p_command_id}'));`:`select id from auth.users where id='${actor}'for update;`;
  await failedRace((replay?'replay':'new_receive')+'_membership_deleted_after_'+stage,hold,a,`delete from erp_access.membership where user_id='${actor}';commit;`,'42501');
  assert.deepEqual(await f.state(),before);await restore();
 }
 for(const stage of['auth','membership']){
  const f=await setup(),r=await f.receive(),a=await f.prepare(null,{receipt:r.receipt.receipt});await failedRace('reverse_acl_revoked_after_'+stage,stage==='auth'?`select id from auth.users where id='${actor}'for update;`:`select user_id from erp_access.membership where user_id='${actor}'for update;`,a,`update erp_access.membership set active=false where user_id='${actor}';commit;`,'42501');assert.equal((await f.state()).reversals,0);await restore();
 }
 for(const change of['document','catalog','balance']){
  const f=await setup({initial:'1'}),a=await f.prepare();const hold=change==='document'?`select id from erp_documents.document where id='${f.d.id}'for update;`:change==='catalog'?`select id from erp_catalog.record where id='${f.product.id}'for update;`:`select product_id from erp_stock.balance where product_id='${f.product.id}'for update;`;
  const mutation=change==='document'?`update erp_documents.document set version=version+1 where id='${f.d.id}';`:change==='catalog'?`update erp_catalog.record set version=version+1 where id='${f.product.id}';`:`update erp_stock.balance set quantity=quantity+1,version=version+1 where product_id='${f.product.id}';`;
  await failedRace('CAS_'+change+'_changed_during_wait',hold,a,mutation+'commit;');assert.equal((await f.state()).receipts,0);
 }
 {
  const f=await setup({initial:'1'});ok(await run(`update erp_stock.balance set quantity=999999999999,version=version+1 where product_id='${f.product.id}';`));
  const before=await snapshot();expectError(await run('begin;'+rpcSql('erp_purchase_receipts_preview',{...f.base(),p_items:f.selection('1')})+'commit;'),'40001');assert.deepEqual(await snapshot(),before);
  ok(await run(`update erp_stock.balance set quantity=999999999998.999999,version=version+1 where product_id='${f.product.id}';`));
  await f.receive('1');assert.equal((await f.state()).physical,'999999999999.999999');assert.equal((await f.state()).receipts,1);
  record('balance_overflow_closed_before_cast_and_exact_limit_accepted');
 }
 for(const reverseFirst of[false,true]){
  const f=await setup(),r=await f.receive('5'),sale=await f.order('sales_orders','1'),a=await f.prepare(null,{receipt:r.receipt.receipt}),b=await f.reserve(sale);const x=await race(reverseFirst?'reverse_before_reservation070':'reservation070_before_reverse',reverseFirst?applySql(a):rpcSql('erp_stock_reservation_apply',b),reverseFirst?rpcSql('erp_stock_reservation_apply',b):applySql(a));expectError(x.second,reverseFirst?'22023':'40001');assert.equal((await f.state()).reversals,reverseFirst?1:0);record(reverseFirst?'reverse_before_reservation070':'reservation070_before_reverse',{lock_wait_observed:true});
 }
 for(const reverse of[false,true]){
  const f=await setup(),r=reverse?await f.receive():null,a=await f.prepare(reverse?null:'1',{receipt:r?.receipt.receipt??null});const x=await race(reverse?'reverse_membership_protected_until_commit':'receive_membership_protected_until_commit',applySql(a),`update erp_access.membership set active=false where user_id='${actor}';`);ok(x.second);assert.equal((await f.state()).receipts,1);if(reverse)assert.equal((await f.state()).reversals,1);record(reverse?'reverse_membership_protected_until_commit':'receive_membership_protected_until_commit',{lock_wait_observed:true});await restore();
 }
 {
  const f=await setup(),r=await f.receive('2'),z=await f.reverse(r.receipt.receipt),a=await f.legacy(),before=await snapshot();expectError(await run('begin;'+rpcSql('erp_document_stock_post',a)+'commit;'),'40001');assert.deepEqual(await snapshot(),before);assert.equal((await rpc('erp_purchase_receipts_get',{p_user_id:actor,p_document_id:f.d.id})).current.document.mode,'item_receipts');
  for(const movement of[r.receipt.receipt.movement_id,z.receipt.reversal.movement_id])expectError(await run('begin;'+rpcSql('erp_stock_reverse',{p_user_id:actor,p_movement_id:movement,p_command_id:randomUUID(),p_occurred_on:day,p_reason:'Synthetic090 no generic bypass',p_versions:[]})+'commit;'),'40001');record('permanent_partial_mode_and_generic_reverse_bypass_rejected_atomically');
 }
 {
  const f=await setup(),a=await f.prepare(),before=await snapshot();ok(await run("create function public.fail090native()returns trigger language plpgsql as $$begin raise exception 'synthetic late failure';end$$;create trigger fail090native before insert on erp_purchase_receipts.command for each row execute function public.fail090native();"));
  try{expectError(await run('begin;'+applySql(a)+'commit;'),'P0001');assert.deepEqual(await snapshot(),before);}finally{ok(await run('drop trigger fail090native on erp_purchase_receipts.command;drop function public.fail090native();'));}record('late_command_failure_rolls_back_stock_audit_document_and_receipt');
 }
 assert.deepEqual(await snapshot({protectedOnly:true}),protectedBefore);assert.deepEqual(result(await run(functionSql)),functions);
 assert.deepEqual(result(await run('select jsonb_build_object(\'titles\',(select count(*)from erp_finance.title),\'movements\',(select count(*)from erp_finance.movement));')),{titles:0,movements:0});record('all_finance_fiscal_origin_rows_and_prior_routines_preserved');
 console.log(JSON.stringify({profile:'purchase-receipts090-postgres-v1',source_sha256:sourceHash,fixture_sha256:fixtureHash,fixture_mode:'native_inline_full_001_089',baseline,baseline_sha256:sha(JSON.stringify(baseline)),postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,real_data:false,scenarios:results,passed:results.length,lock_waits:lockWaits,finance_effects:0},null,2));
}finally{
 for(const child of children)child.kill('SIGKILL');
 await assertOwnRoot();
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 await assertOwnRoot();await rm(root,{recursive:true,force:true});
}
