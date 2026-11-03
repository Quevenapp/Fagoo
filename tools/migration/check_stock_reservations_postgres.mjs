// Synthetic070 races in one disposable PostgreSQL17 cluster; private Unix socket, no TCP.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {bootstrap,migrations} from './helpers/stock-reservation-fixture.mjs';
const bin=process.env.BRUFAP_TEST_PG17_BIN;assert.ok(typeof bin==='string'&&isAbsolute(bin));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-reservations070-'),socket=join(root,'s'),port='56570';
await chmod(root,0o700);await mkdir(socket,{mode:0o700});let started=false;const children=new Set(),results=[];
const quote=v=>v===null?'null':typeof v==='number'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'";
function session(){const p=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});children.add(p);let out='',err='',ended=false;const timer=setTimeout(()=>p.kill('SIGKILL'),30000);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.stdin.on('error',()=>{});p.stdout.on('data',b=>{out+=b;if(out.length>2097152)p.kill('SIGKILL');});p.stderr.on('data',b=>{err+=b;if(err.length>65536)p.kill('SIGKILL');});p.on('close',code=>{ended=true;children.delete(p);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});return{done,write:s=>p.stdin.write(s+'\n'),end:s=>p.stdin.end(s+'\n'),async marker(v){const end=Date.now()+10000;while(!out.includes(v)){assert.equal(ended,false,err);assert.ok(Date.now()<end,'Marker timeout');await new Promise(r=>setTimeout(r,15));}}};}
async function run(sql){const s=session();s.end(sql);return s.done;}const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const result=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')||x.startsWith('[')));
const rpcSql=(name,args)=>{assert.match(name,/^erp_[a-z_]+$/);return `set local role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>{assert.match(k,/^p_[a-z_]+$/);return `${k}=>${quote(v)}`;}).join(',')});`;};
const rpc=async(name,args)=>result(await run('begin;'+rpcSql(name,args)+'commit;'));
const admin=randomUUID(),actor=randomUUID(),day='2026-10-15';
async function setup(qty='7'){
 const catalog=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 const product=await catalog('products',{name:'Produto sintético070',unit:'UN',kind:'P',format:'S',price:'1'}),warehouse=await catalog('warehouses',{name:'Depósito sintético070'}),contact=await catalog('contacts',{name:'Contato sintético070'});
 const physical=(quantity,version=1,command=randomUUID())=>({p_user_id:actor,p_command_id:command,p_kind:quantity.startsWith('-')?'issue':'receipt',p_occurred_on:day,p_reason:'Movimento sintético070',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity,expected_version:version}]});
 await rpc('erp_stock_post',physical('10',0));
 async function order(){let d=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:day,contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Produto',unit:'UN',quantity:qty,unit_price:'1'}]}})).document;for(const status of['open','verified'])d=(await rpc('erp_document_transition',{p_user_id:admin,p_kind:'sales_orders',p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Conferência sintética'})).document;return d;}
 const args=(d,action='reserve',r=null)=>({p_user_id:actor,p_document_id:d.id,p_expected_version:d.version,p_action:action,p_occurred_on:day,p_reason:'Conferência sintética070',p_reservation_id:r?.id??null,p_reservation_version:r?.version??null});
 const prepare=async(d,action='reserve',r=null,command=randomUUID())=>{const a=args(d,action,r),p=(await rpc('erp_stock_reservation_preview',a)).preview;return{...a,p_command_id:command,p_preview_hash:p.preview_hash,p_ignored_item_ids:action==='reserve'?p.ignored.map(i=>i.id):null};};
 const state=async()=>result(await run(`select jsonb_build_object('physical',(select quantity::text from erp_stock.balance where product_id='${product.id}'),'reserved',erp_stock.reserved_quantity('${product.id}','${warehouse.id}')::numeric(18,6)::text,'reservations',(select count(*)from erp_stock.reservation_item where product_id='${product.id}'),'movements',(select count(distinct movement_id)from erp_stock.entry where product_id='${product.id}'),'finance',(select count(*)from erp_finance.title));`));
 return{product,warehouse,physical,order,prepare,args,state};
}
async function waitLock(name){const end=Date.now()+10000;while(true){const r=ok(await run(`select count(*)from pg_stat_activity where application_name='${name}'and wait_event_type='Lock';`));if(r.out.trim()==='1')return;assert.ok(Date.now()<end,'Expected lock wait');await new Promise(r=>setTimeout(r,20));}}
async function race(name,firstSql,secondSql,{secondError=null,release='commit;'}={}){const first=session(),second=session();first.write(`begin;${firstSql}\n\\echo HELD`);try{await first.marker('HELD');second.end(`set application_name='${name}';begin;${secondSql}commit;`);await waitLock(name);first.end(release);const a=ok(await first.done),b=await second.done;if(secondError){assert.equal(b.code,3);assert.match(b.err,new RegExp(secondError));assert.doesNotMatch(b.err,/40P01/);}else ok(b);results.push({scenario:name,passed:true,lock_wait_observed:true});return{first:a,second:b};}finally{if(children.size){first.end('rollback;');second.end('rollback;');await Promise.allSettled([first.done,second.done]);}}}
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
 for(const name of migrations)ok(await run(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8')));
 const source=await readFile(new URL('../../supabase/migrations/202610160070_stock_reservations.sql',import.meta.url),'utf8');ok(await run(source));
 ok(await run(`insert into auth.users values('${admin}'),('${actor}');insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${actor}','estoque');`));
 {
  const f=await setup(),a=await f.order(),b=await f.order(),pa=await f.prepare(a),pb=await f.prepare(b);
  await race('two_orders_same_available',rpcSql('erp_stock_reservation_apply',pa),rpcSql('erp_stock_reservation_apply',pb),{secondError:'40001'});
  assert.deepEqual(await f.state(),{physical:'10.000000',reserved:'7.000000',reservations:1,movements:1,finance:0});
 }
 {
  const f=await setup(),d=await f.order(),p=await f.prepare(d);
  await race('manual_debit_before_reservation',rpcSql('erp_stock_post',f.physical('-4')),rpcSql('erp_stock_reservation_apply',p),{secondError:'22023'});
  assert.deepEqual(await f.state(),{physical:'6.000000',reserved:'0.000000',reservations:0,movements:2,finance:0});
 }
 {
  const f=await setup(),d=await f.order(),p=await f.prepare(d);
  await race('reservation_before_manual_debit',rpcSql('erp_stock_reservation_apply',p),rpcSql('erp_stock_post',f.physical('-4')),{secondError:'40001'});
  assert.deepEqual(await f.state(),{physical:'10.000000',reserved:'7.000000',reservations:1,movements:1,finance:0});
 }
 for(const same of[true,false]){
  const f=await setup(),d=await f.order(),reserved=await rpc('erp_stock_reservation_apply',await f.prepare(d));d.version=reserved.current.document.version;
  const p=await f.prepare(d,'consume',reserved.receipt.reservation),q={...p,p_command_id:same?p.p_command_id:randomUUID()};
  const r=await race(same?'consume_same_command':'consume_different_command',rpcSql('erp_stock_reservation_apply',p),rpcSql('erp_stock_reservation_apply',q),{secondError:same?null:'40001'});
  if(same){const a=result(r.first),b=result(r.second);assert.deepEqual(a.receipt,b.receipt);assert.equal(b.replayed,true);}
  assert.deepEqual(await f.state(),{physical:'3.000000',reserved:'0.000000',reservations:1,movements:2,finance:0});
 }
 {
  const f=await setup(),d=await f.order(),r=await rpc('erp_stock_reservation_apply',await f.prepare(d));d.version=r.current.document.version;
  await race('release_then_manual_full_debit',rpcSql('erp_stock_reservation_apply',await f.prepare(d,'release',r.receipt.reservation)),rpcSql('erp_stock_post',f.physical('-10')));
  assert.deepEqual(await f.state(),{physical:'0.000000',reserved:'0.000000',reservations:1,movements:2,finance:0});
 }
 {
  const f=await setup(),d=await f.order(),p=await f.prepare(d);
  await race('membership_revoked_during_catalog_wait',`select id from erp_catalog.record where id='${f.product.id}'for update;`,rpcSql('erp_stock_reservation_apply',p),{secondError:'42501',release:`update erp_access.membership set active=false where user_id='${actor}';commit;`});
  assert.equal((await f.state()).reservations,0);ok(await run(`update erp_access.membership set active=true where user_id='${actor}';`));
 }
 {
  const f=await setup();await race('manual_membership_revoked_during_catalog_wait',`select id from erp_catalog.record where id='${f.product.id}'for update;`,rpcSql('erp_stock_post',f.physical('-1')),{secondError:'42501',release:`update erp_access.membership set active=false where user_id='${actor}';commit;`});
  assert.equal((await f.state()).physical,'10.000000');ok(await run(`update erp_access.membership set active=true where user_id='${actor}';`));
 }
 {
  const f=await setup(),d=await f.order(),p=await f.prepare(d);await race('write_holds_membership_until_commit',rpcSql('erp_stock_reservation_apply',p),`update erp_access.membership set active=false where user_id='${actor}';`);
  assert.equal((await f.state()).reservations,1);ok(await run(`update erp_access.membership set active=true where user_id='${actor}';`));
 }
 for(const manualFirst of[true,false]){
  const f=await setup(),d=await f.order(),p=await f.prepare(d),m=f.physical('-1',1,p.p_command_id);
  await race(manualFirst?'manual_namespace_before_reserve':'reserve_namespace_before_manual',rpcSql(manualFirst?'erp_stock_post':'erp_stock_reservation_apply',manualFirst?m:p),rpcSql(manualFirst?'erp_stock_reservation_apply':'erp_stock_post',manualFirst?p:m),{secondError:'40001'});
  assert.equal((await f.state()).movements,manualFirst?2:1);
 }
 console.log(JSON.stringify({profile:'stock-reservations-070-postgres-v1',source_sha256:createHash('sha256').update(source).digest('hex'),postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,scenarios:results,finance_effects:0},null,2));
}finally{
 for(const child of children)child.kill('SIGKILL');
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-reservations070-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
