// Optional PostgreSQL 17 concurrency checks. Starts and removes only this disposable,
// network-isolated, tmpfs-backed container. All business data is synthetic.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';

const container='brufap-unsigned048-pg',database='brufap_synthetic',sessions=new Set(),results=[];
const admin=randomUUID(),fiscal=randomUUID();let started=false,contact,product,series=100;
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(name,args)=>{assert.match(name,/^erp_[a-z_]+$/);return`select public.${name}(${Object.entries(args).map(([k,v])=>{assert.match(k,/^p_[a-z0-9_]+$/);return k+'=>'+quote(v);}).join(',')});`;};
const roleSql=sql=>`set role service_role; ${sql}`;
function session(){
 const child=spawn('docker',['exec','-i',container,'psql','-XAtq','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{stdio:['pipe','pipe','pipe']});
 sessions.add(child);let stdout='',stderr='',wake,ended=false;
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{
  child.on('error',reject);
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>8388608)child.kill('SIGKILL');wake?.();});
  child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>65536)child.kill('SIGKILL');});
  child.on('close',code=>{ended=true;clearTimeout(timer);sessions.delete(child);wake?.();resolve({code,stdout,stderr});});
 });
 return{done,write:sql=>child.stdin.write(sql+'\n'),end:sql=>child.stdin.end(sql+'\n'),async marker(value){
  const deadline=Date.now()+15000;while(!stdout.includes(value)){
   assert.equal(ended,false,stderr);assert.ok(Date.now()<deadline,'Transaction did not reach its marker');
   await new Promise(resolve=>{const timer=setTimeout(resolve,25);wake=()=>{clearTimeout(timer);resolve();};});
  }
 }};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.stderr);return r;};
const value=r=>JSON.parse(ok(r).stdout.trim().split('\n').filter(s=>s.startsWith('{')||s.startsWith('[')).at(-1));
const rpc=async(name,args)=>value(await run(roleSql(rpcSql(name,args))));
async function waiting(name){
 const end=Date.now()+8000;while(Date.now()<end){const r=ok(await run(`select count(*) from pg_stat_activity where application_name=${quote(name)} and wait_event_type='Lock';`));
  if(r.stdout.trim()==='1')return;await new Promise(resolve=>setTimeout(resolve,25));
 }assert.fail('Concurrent connection did not wait for a PostgreSQL lock');
}
async function race(name,firstSql,secondSql,check){
 const first=session(),application='brufap048_'+name;let firstEnded=false;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  const second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');firstEnded=true;const a=await first.done,b=await second;ok(a);await check(a,b);
  results.push({scenario:name,lock_wait_observed:true,passed:true});
 }catch(error){if(!firstEnded)first.end('rollback;');throw error;}
}
const companyData={legal_name:'EMPRESA FICTICIA CONCORRENCIA',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'};
async function setCompany(data=companyData){
 const current=await rpc('erp_company_get',{p_user_id:admin,p_section:'identity'});
 return rpc('erp_company_save_identity',{p_user_id:admin,p_expected_version:current.record?.version??0,p_command_id:randomUUID(),p_data:data});
}
async function confirmRegime(){
 const identity=await rpc('erp_company_get',{p_user_id:admin,p_section:'identity'}),f=await rpc('erp_company_get',{p_user_id:admin,p_section:'fiscal'});
 await rpc('erp_company_confirm_fiscal',{p_user_id:admin,p_expected_version:f.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'REGIME FICTICIO PARA ENSAIO LOCAL'});
}
const completionArgs=(f,version=0,completion=f.completion)=>({p_user_id:fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_expected_identity_version:f.draft.record.snapshot.company.identity_version,p_expected_fiscal_version:f.draft.record.snapshot.company.fiscal_version,p_expected_completion_version:version,p_completion:completion,p_command_id:randomUUID()});
async function fixture(){
 const document=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'}]}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model:'55',preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:fiscal,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const sample=businessFixture();await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:sample.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
 const{identity,...completion}=sample.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);
 const f={draft,completion};await rpc('erp_fiscal_completion_save',completionArgs(f));
 const configured=await rpc('erp_fiscal_numbering_configure',{p_user_id:admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:'55',p_environment:'2',p_series:String(series++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'SERIE FICTICIA PARA ENSAIO LOCAL'});
 f.reservation=await rpc('erp_fiscal_numbering_reserve',{p_user_id:fiscal,p_command_id:randomUUID(),p_series_id:configured.current_series.id,p_expected_series_version:configured.current_series.version,p_expected_identity_version:configured.current_series.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});return f;
}
async function startArgs(f){
 const b=await rpc('erp_fiscal_unsigned_basis',{p_user_id:fiscal,p_draft_id:f.draft.record.id,p_completion_version:1});
 const now=value(await run(`select jsonb_build_object('now',to_char(clock_timestamp() at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00');`)).now;
 return{p_user_id:fiscal,p_command_id:randomUUID(),p_reservation_id:f.reservation.receipt.id,p_completion_version:1,p_completion_hash:b.proofs.completion_hash,p_basis_hash:b.basis_hash,p_builder_version:'brufap-business-builder-v1',p_seed:{cNF:'12345678',issuedAt:now}};
}
const begin=args=>rpc('erp_fiscal_unsigned_begin',args);
const get=j=>rpc('erp_fiscal_unsigned_get',{p_user_id:fiscal,p_job_id:j.receipt.job_id});
const failure=j=>({p_user_id:fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_error_code:'CONTENT_INCOMPLETE'});
async function uploaded(j){
 const v=j.execution.inputs,xml=buildBusinessXml({draft:v.draft,itemPreparation:v.itemPreparation,taxPreparation:v.taxPreparation,completion:{...v.completionPreparation.record.completion,identity:Object.fromEntries(['series','number','cNF','issuedAt'].map(k=>[k,j.execution.identity[k]]))}}).unsignedXml;
 const hash=createHash('sha256').update(xml).digest('hex'),size=Buffer.byteLength(xml);
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote('jobs/'+j.receipt.job_id+'/'+hash+'.xml')},${quote({size,mimetype:'application/octet-stream'})});`));
 return{p_user_id:fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_xml_hash:hash,p_size_bytes:size,p_access_key:j.receipt.access_key};
}
const rejected=(result,code)=>{assert.equal(result.code,3,result.stdout);assert.match(result.stderr,new RegExp('\\b'+code+'\\b'));};
async function counts(reservation){return value(await run(`select jsonb_build_object('identity',(select count(*)from erp_fiscal_unsigned.identity where reservation_id=${quote(reservation)}),'jobs',(select count(*)from erp_fiscal_unsigned.job where reservation_id=${quote(reservation)}),'attempts',(select count(*)from erp_fiscal_unsigned.attempt a join erp_fiscal_unsigned.job j on j.id=a.job_id where j.reservation_id=${quote(reservation)}),'artifacts',(select count(*)from erp_fiscal_unsigned.artifact a join erp_fiscal_unsigned.job j on j.id=a.job_id where j.reservation_id=${quote(reservation)}));`));}
try{
 execFileSync('docker',['run','--detach','--rm','--name',container,'--network','none','--tmpfs','/var/lib/postgresql/data:rw','--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB='+database,'postgres:17-alpine'],{stdio:'pipe',timeout:30000});started=true;
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];assert.equal(info.HostConfig.NetworkMode,'none');assert.ok(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);assert.equal(info.Mounts.some(m=>['bind','volume'].includes(m.Type)),false);assert.equal(Object.keys(info.HostConfig.PortBindings??{}).length,0);
 // The entrypoint's temporary initialization server listens only on its Unix
 // socket. TCP readiness inside the isolated container proves final startup.
 const readyUntil=Date.now()+20000;while(true){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],{stdio:'pipe',timeout:2000});break;}catch(error){if(Date.now()>readyUntil)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
 let bootstrap='create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;';
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs'])bootstrap+='\n'+await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(fiscal)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(fiscal)},'fiscal');insert into storage.buckets values('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);`));
 await setCompany();await confirmRegime();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 for(const same of[true,false]){
  const f=await fixture(),a=await startArgs(f),b=same?a:{...a,p_command_id:randomUUID(),p_seed:{...a.p_seed,cNF:'87654321'}};
  await race(same?'same_command':'alias_command',roleSql(rpcSql('erp_fiscal_unsigned_begin',a)),roleSql(rpcSql('erp_fiscal_unsigned_begin',b)),async(first,second)=>{
   const one=value(first),two=value(second);assert.deepEqual(two.receipt,one.receipt);assert.equal(two.execution,null);assert.equal(two.replayed,same);assert.ok(one.execution);assert.equal(one.receipt.identity.cNF,'12345678');
   assert.deepEqual(await counts(a.p_reservation_id),{identity:1,jobs:1,attempts:1,artifacts:0});
  });
 }
 {
  const f=await fixture(),a=await startArgs(f),update=completionArgs(f,1,{...f.completion,additional_information:'CORRECAO CONCORRENTE'});
  await race('completion_before_begin',roleSql(rpcSql('erp_fiscal_completion_save',update)),roleSql(rpcSql('erp_fiscal_unsigned_begin',a)),async(first,second)=>{
   assert.equal(value(first).record.version,2);rejected(second,'40001');assert.deepEqual(await counts(a.p_reservation_id),{identity:0,jobs:0,attempts:0,artifacts:0});
  });
 }
 {
  const f=await fixture(),a=await startArgs(f),update=completionArgs(f,1,{...f.completion,additional_information:'CORRECAO APOS BEGIN'});
  await race('begin_before_completion',roleSql(rpcSql('erp_fiscal_unsigned_begin',a)),roleSql(rpcSql('erp_fiscal_completion_save',update)),async(first,second)=>{
   assert.equal(value(second).record.version,2);assert.equal((await get(value(first))).current.basis_changed,true);
  });
 }
 for(const finishFirst of[false,true]){
  const f=await fixture(),j=await begin(await startArgs(f)),end=await uploaded(j),update=completionArgs(f,1,{...f.completion,additional_information:'CORRECAO DURANTE PUBLICACAO'});
  const finishSql=roleSql(rpcSql('erp_fiscal_unsigned_finish',end)),updateSql=roleSql(rpcSql('erp_fiscal_completion_save',update));
  await race(finishFirst?'finish_before_completion':'completion_before_finish',finishFirst?finishSql:updateSql,finishFirst?updateSql:finishSql,async(first,second)=>{
   if(finishFirst){assert.equal(value(first).current.state,'stored');assert.equal(value(second).record.version,2);}else rejected(second,'40001');
   const state=await get(j);assert.equal(state.current.basis_changed,true);assert.equal(state.current.artifact_current,false);assert.equal(state.artifact!==null,finishFirst);
  });
 }
 {
  const f=await fixture(),args=await startArgs(f),j=await begin(args),end=await uploaded(j);
  // Synthetic clock fixture only; guards stay enabled during both real concurrent RPCs.
  ok(await run(`alter table erp_fiscal_unsigned.job disable trigger guard_job;update erp_fiscal_unsigned.job set lease_until=clock_timestamp()-interval'1 second'where id=${quote(j.receipt.job_id)};alter table erp_fiscal_unsigned.job enable trigger guard_job;`));
  await race('lease_takeover_fences_old_finish',roleSql(rpcSql('erp_fiscal_unsigned_begin',args)),roleSql(rpcSql('erp_fiscal_unsigned_finish',end)),async(first,second)=>{
   const resumed=value(first);rejected(second,'40001');assert.notEqual(resumed.execution.lease_id,j.execution.lease_id);assert.deepEqual(resumed.receipt.identity,j.receipt.identity);
   assert.equal((await rpc('erp_fiscal_unsigned_finish',{...end,p_lease_id:resumed.execution.lease_id})).current.state,'stored');
   assert.deepEqual(await counts(args.p_reservation_id),{identity:1,jobs:1,attempts:2,artifacts:1});
  });
 }
 {
  const j=await begin(await startArgs(await fixture())),end=await uploaded(j),call=roleSql(rpcSql('erp_fiscal_unsigned_finish',end));
  await race('same_finish',call,call,async(first,second)=>{assert.equal(value(first).replayed,false);assert.equal(value(second).replayed,true);assert.deepEqual(value(second).artifact,value(first).artifact);});
 }
 for(const mode of['finish_replay','fail_pending','fail_replay']){
  const j=await begin(await startArgs(await fixture()));let call;
  if(mode==='finish_replay'){const end=await uploaded(j);await rpc('erp_fiscal_unsigned_finish',end);call=roleSql(rpcSql('erp_fiscal_unsigned_finish',end));}
  else{if(mode==='fail_replay')await rpc('erp_fiscal_unsigned_fail',failure(j));call=roleSql(rpcSql('erp_fiscal_unsigned_fail',failure(j)));}
  const identity=await rpc('erp_company_get',{p_user_id:admin,p_section:'identity'});
  const update=rpcSql('erp_company_save_identity',{p_user_id:admin,p_expected_version:identity.record.version,p_command_id:randomUUID(),p_data:{...companyData,cnpj:TEST_RECIPIENT}});
  await race('issuer_change_'+mode,roleSql(update),call,async(first,second)=>{assert.equal(value(first).record.data.cnpj,TEST_RECIPIENT);rejected(second,'42501');});
  await setCompany();await confirmRegime();if(mode==='fail_pending')assert.equal((await get(j)).current.state,'pending');
 }
 const effects=value(await run("select jsonb_build_object('stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title),'reservations',(select count(*)from erp_fiscal_numbering.reservation),'identities',(select count(*)from erp_fiscal_unsigned.identity),'jobs',(select count(*)from erp_fiscal_unsigned.job),'attempts',(select count(*)from erp_fiscal_unsigned.attempt));"));
 assert.equal(effects.stock,0);assert.equal(effects.finance,0);assert.equal(effects.reservations,11);assert.equal(effects.identities,10);assert.equal(effects.jobs,10);assert.equal(effects.attempts,11);
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',network:'none',storage:'tmpfs',multi_session:true,scenarios:results,effects},null,2));
}finally{
 for(const child of sessions){child.stdin.end('rollback;\n');child.kill('SIGTERM');}
 if(started)execFileSync('docker',['rm','--force',container],{stdio:'pipe',timeout:15000});
}
