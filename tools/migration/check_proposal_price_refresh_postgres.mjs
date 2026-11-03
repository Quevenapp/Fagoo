// Real PostgreSQL060/055 races; synthetic staging and native draft fixtures only.
// No bank API, secrets, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const name='brufap-price060-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),owner=randomUUID(),sessions=new Set(),results=[];
let seq=9601000000;
let container=null;
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^(?:erp|origin_sync)_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+quote(value);}).join(',')});`;};
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

 let bootstrap='create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;';
 const migrations=['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0032_proposal_service_conversion','0034_document_copy','0052_origin_proposal_import','0054_document_commercial','0055_origin_proposal_import_v2','0056_origin_reference_fetch','0059_origin_price_capture','0060_origin_proposal_price_refresh'];
 for(const file of migrations)bootstrap+='\n'+await readFile(new URL(`../../supabase/migrations/20261016${file}.sql`,import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin');insert into origin_sync.resource_state(resource)values('synthetic060');`));
 const claim=resource=>rpc('origin_sync_claim',{p_resource:resource,p_owner:owner,p_ttl_seconds:600});
 const scheduler=await claim('__scheduler__'),resource=await claim('proposal_prices');
 const fences={p_owner:owner,p_lease_token:scheduler.lease_token,p_resource_token:resource.lease_token};
 const call=(name,args={})=>rpc('origin_sync_price_'+name,{...fences,...args});
 const callSql=(name,args={})=>roleSql(rpcSql('origin_sync_price_'+name,{...fences,...args}));
 async function stage(entity,id,payload){
  ok(await run(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values(${quote(entity)},'synthetic060',${quote(id)},${quote(payload)}::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',${quote(payload)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'));`));
 }
 const raw=async id=>value(await run(`select to_jsonb(r) from origin_sync.raw_record r where entity='products' and source_id=${quote(id)};`));
 async function pair(){
  const contact=String(++seq),product=String(++seq),proposal=String(++seq);
  await stage('contacts',contact,{id:contact,nome:'Contato fictício060',situacao:'A',tipo:'J'});
  await stage('products',product,{id:product,nome:'Produto fictício060',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:1.2});
  for(const[entity,id]of[['contacts',contact],['products',product]]){
   const row=value(await run(`select jsonb_build_object('hash',version_hash)from origin_sync.raw_record where entity=${quote(entity)}and source_id=${quote(id)};`));
   await rpc('erp_catalog_import_origin',{p_user_id:admin,p_entity:entity,p_items:[{source_id:id,source_hash:row.hash}],p_command_id:randomUUID(),p_dry_run:false});
  }
  await stage('sales_proposals',proposal,{id:proposal,numero:60,data:'2026-10-16',situacao:'Rascunho',contato:{id:contact},total:1.2,totalProdutos:1.2,desconto:0,outrasDespesas:0,totalOutrosItens:0,garantia:0,dataProximoContato:'0000-00-00',introducao:'',aosCuidadosDe:'',vendedor:{id:0},loja:{id:0},transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:product,descricao:'Produto fictício060'},codigo:'SYNTH060',unidade:'UN',quantidade:1,valor:1.2,desconto:0,descricaoDetalhada:''}],parcelas:[],observacoes:'',observacaoInterna:'',prazoEntrega:''});
  const preview=await rpc('erp_origin_proposal_import_preview_v2',{p_user_id:admin,p_source_id:proposal});assert.equal(preview.can_apply,true,JSON.stringify(preview.issues));
  const candidate=(await call('candidates',{p_limit:8})).items.find(v=>v.source_id===product);assert.ok(candidate);
  const args={p_attempt_id:randomUUID(),...Object.fromEntries(Object.entries(candidate).map(([k,v])=>['p_'+k,v]))};
  const importArgs={p_user_id:admin,p_source_id:proposal,p_preview_hash:preview.preview_hash,p_command_id:randomUUID(),p_confirm_import:true,p_duplicate_reviewed:true};
  const finishArgs={p_attempt_id:args.p_attempt_id,p_payload:{id:product,nome:'Produto fictício060',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:1.23},p_price_capture:{profile:'origin-price-json-v1',response_sha256:'f'.repeat(64),source:'detail',tokens:[{path:'/preco',lexeme:'1.23'}]}};
  return{product,proposal,args,importArgs,finishArgs,before:await raw(product)};
 }
 async function importedWhileWaiting(stageName){
  const p=await pair();if(stageName==='finish')await call('begin',p.args);
  const blocker=session(),application='price060_'+randomUUID();let released=false,pending;
  blocker.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';select source_id from origin_sync.raw_record where entity='products' and source_id=${quote(p.product)}for share;\n\\echo LOCKED`);
  try{
   await blocker.marker('LOCKED');pending=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${callSql(stageName,stageName==='begin'?p.args:p.finishArgs)}`);
   await waiting(application);
   // 055 holds the same product SHARE lock while inserting its origin. Both
   // operations may hold the proposal SHARE lock; recheck after product wait is essential.
   blocker.end(`${roleSql(rpcSql('erp_origin_proposal_import_apply_v2',p.importArgs))}commit;`);released=true;
   const imported=value(await blocker.done);assert.equal(imported.receipt.policy,'origin-open-proposal-v2');
   const refresh=await pending;
   if(stageName==='begin')rejected(refresh,'40001');else assert.deepEqual(value(refresh),{stored:false,conflict:true,replayed:false});
   assert.deepEqual(await raw(p.product),p.before);
   const state=value(await run(`select jsonb_build_object('attempts',(select count(*)from origin_price_refresh.attempt where id=${quote(p.args.p_attempt_id)}),'batches',(select count(*)from origin_sync.batch_inbox where batch_id=${quote(p.args.p_attempt_id)}),'origins',(select count(*)from erp_documents.origin_import_origin where source_id=${quote(p.proposal)}),'state',(select state from origin_price_refresh.attempt where id=${quote(p.args.p_attempt_id)}));`));
   assert.deepEqual(state,{attempts:stageName==='begin'?0:1,batches:0,origins:1,state:stageName==='begin'?null:'conflict'});
   assert.ok(!(await call('candidates',{p_limit:8})).items.some(v=>v.source_id===p.product));
   results.push({scenario:'055_import_commits_while060_'+stageName+'_waits_for_product',lock_wait_observed:true,passed:true});
  }finally{if(!released)blocker.end('rollback;');await blocker.done;if(pending)await pending;}
 }
 await importedWhileWaiting('begin');
 await importedWhileWaiting('finish');
 {
  const p=await pair();await call('begin',p.args);
  const first=session(),application='price060_'+randomUUID();let released=false,pending;
  first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${callSql('finish',p.finishArgs)}\n\\echo CAPTURED`);
  try{
   await first.marker('CAPTURED');pending=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${roleSql(rpcSql('erp_origin_proposal_import_apply_v2',p.importArgs))}`);
   await waiting(application);first.end('commit;');released=true;
   assert.equal(value(await first.done).stored,true);rejected(await pending,'40001');
   const observed=await raw(p.product);assert.equal(observed.payload.preco,1.23);assert.equal(observed.price_capture.source_hash,observed.version_hash);
   assert.equal((await call('finish',p.finishArgs)).replayed,true);
   const state=value(await run(`select jsonb_build_object('batches',(select count(*)from origin_sync.batch_inbox where batch_id=${quote(p.args.p_attempt_id)}),'origins',(select count(*)from erp_documents.origin_import_origin where source_id=${quote(p.proposal)}));`));
   assert.deepEqual(state,{batches:1,origins:0});
   results.push({scenario:'060_capture_before055_invalidates_import_preview_then_replays',lock_wait_observed:true,passed:true});
  }finally{if(!released)first.end('rollback;');await first.done;if(pending)await pending;}
 }
 const totals=value(await run("select jsonb_build_object('native_drafts',(select count(*)from erp_documents.origin_import_origin),'captures',(select count(*)from origin_price_refresh.attempt where state='stored'),'conflicts',(select count(*)from origin_price_refresh.attempt where state='conflict'),'finance',(select count(*)from erp_finance.title),'stock',(select count(*)from erp_stock.entry));"));
 assert.deepEqual(totals,{native_drafts:2,captures:1,conflicts:1,finance:0,stock:0});
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',multi_session:true,network:'none',memory_bytes:268435456,storage:'tmpfs',scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
