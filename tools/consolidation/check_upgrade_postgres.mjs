// Full distribution rehearsal against an explicitly selected LOCAL PostgreSQL 17 cluster.
// Synthetic Auth/storage fixtures are used; this does not claim to test GoTrue or physical devices.
import {spawnSync} from 'node:child_process';import {readFile,readdir,mkdtemp,writeFile,copyFile,rm,rmdir} from 'node:fs/promises';
import {resolve,join,dirname,basename,sep} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,createHash} from 'node:crypto';import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),bin=process.env.FAGOO_TEST_PG_BIN,python=process.env.FAGOO_TEST_PYTHON;
assert.ok(bin&&python,'Set FAGOO_TEST_PG_BIN and FAGOO_TEST_PYTHON explicitly');
const host=process.env.FAGOO_TEST_PG_HOST??'127.0.0.1';assert.ok(['127.0.0.1','localhost','::1'].includes(host),'Only loopback test databases are accepted');
const env={...process.env,PGHOST:host,PGPORT:process.env.FAGOO_TEST_PG_PORT??'55432',PGUSER:process.env.FAGOO_TEST_PG_USER??'fagoo_test',PGCONNECT_TIMEOUT:'5'};
delete env.PGDATABASE;delete env.PGSERVICE;delete env.PGSERVICEFILE;
const suffix=randomUUID().replaceAll('-','').slice(0,14),databases=['fresh','upgrade','restore'].map(kind=>`fagoo_rehearsal_${kind}_${suffix}`),created=[];
const temporary=await mkdtemp(join(tmpdir(),'fagoo-pg-rehearsal-')),oldDir=join(temporary,'old'),fullDir=join(temporary,'full'),results=[];
const clusters=[{name:'fresh',port:process.env.FAGOO_TEST_FRESH_PORT??'55442'},{name:'upgrade',port:process.env.FAGOO_TEST_UPGRADE_PORT??'55443'}].map(c=>({...c,directory:join(temporary,c.name+'-data'),started:false}));
const ports=new Map([[databases[0],clusters[0].port],[databases[1],clusters[1].port],[databases[2],clusters[1].port]]);
const executable=name=>join(bin,process.platform==='win32'?name+'.exe':name);
function raw(database,sql){return spawnSync(executable('psql'),['-XAtq','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{input:sql,encoding:'utf8',env:{...env,PGPORT:ports.get(database)??env.PGPORT},windowsHide:true,maxBuffer:32*1024*1024,timeout:180000});}
function run(database,sql){const result=raw(database,sql);if(result.error||result.status!==0)throw new Error('SQL failed: '+(result.stderr??result.error?.message??'').slice(0,2400));return result.stdout.trim();}
const quote=value=>"'"+String(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
function rpc(database,name,args){assert.match(name,/^fagoo_[a-z_]+$/);const statement=`set role service_role;select public.${name}(${Object.entries(args).map(([key,value])=>`${key}=>${value===null?'null':quote(value)}`).join(',')});`;return JSON.parse(run(database,statement).split('\n').at(-1));}
function generated(directory,standalone=false){const source="import sys;sys.path.insert(0,sys.argv[1]);from migrate import program;sys.stdout.reconfigure(encoding='utf-8',newline='\\n');sys.stdout.write(program(sys.argv[2],initialize_standalone=sys.argv[3]=='yes'))";const result=spawnSync(python,['-c',source,join(root,'infra'),directory,standalone?'yes':'no'],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000});assert.equal(result.status,0,result.stderr);return result.stdout;}
const bootstrap=`create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}',raw_app_meta_data jsonb not null default '{}',created_at timestamptz not null default now(),invited_at timestamptz,email_confirmed_at timestamptz,last_sign_in_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),aal text,not_after timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),refreshed_at timestamptz,user_agent text,ip inet);
create table auth.mfa_factors(id uuid primary key,user_id uuid references auth.users(id),factor_type text,status text,created_at timestamptz default now());
create table auth.mfa_challenges(id uuid primary key,factor_id uuid references auth.mfa_factors(id),created_at timestamptz default now(),verified_at timestamptz,ip_address inet);
create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;`;
try{
 for(const cluster of clusters){
  assert.match(cluster.port,/^\d{4,5}$/);let started=spawnSync(executable('initdb'),['-D',cluster.directory,'-U',env.PGUSER,'--auth=trust','--encoding=UTF8','--no-locale'],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(started.status,0,started.stderr);
  started=spawnSync(executable('pg_ctl'),['-D',cluster.directory,'-l',join(temporary,cluster.name+'.log'),'-o',`-h 127.0.0.1 -p ${cluster.port}`,'-w','start'],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(started.status,0,started.stderr);cluster.started=true;
  env.PGPORT=cluster.port;run('postgres',"create role anon;create role authenticated;create role service_role bypassrls;");
 }
 assert.match(run('postgres','select version();'),/PostgreSQL 17\./);
 run('postgres',"do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;end $$;");
 const {mkdir}=await import('node:fs/promises');await mkdir(oldDir);await mkdir(fullDir);const all=(await readdir(join(root,'supabase/migrations'))).filter(name=>name.endsWith('.sql')).sort(),older=all.filter(name=>name<'202611090002');
 for(const name of all)await copyFile(join(root,'supabase/migrations',name),join(fullDir,name));
 for(const name of older)await copyFile(join(root,'supabase/migrations',name),join(oldDir,name));
 for(const db of databases){assert.match(db,/^fagoo_rehearsal_(fresh|upgrade|restore)_[a-f0-9]{14}$/);env.PGPORT=ports.get(db);run('postgres',`create database ${db};`);created.push(db);}
 const [fresh,upgrade,restore]=databases;run(fresh,bootstrap);run(upgrade,bootstrap);
 run(fresh,generated(fullDir,true));assert.equal(Number(run(fresh,'select count(*) from fagoo_system.schema_migration;')),all.length);results.push({gate:'clean_full_schema',migrations:all.length,status:'passed'});
 run(upgrade,generated(oldDir));assert.equal(Number(run(upgrade,'select count(*) from fagoo_system.schema_migration;')),older.length);
 const admin=randomUUID(),user=randomUUID(),contact=randomUUID();
 run(upgrade,`insert into auth.users(id,email) values('${admin}','admin@synthetic.test'),('${user}','operator@synthetic.test');insert into erp_access.membership(user_id,role) values('${admin}','admin'),('${user}','vendas');insert into erp_catalog.record(id,entity,name) values('${contact}','contacts','Contato preservado');insert into erp_catalog.contact(record_id,phone) values('${contact}','5511999999999');`);
 const baseline=run(upgrade,`select jsonb_build_object('members',(select jsonb_agg(to_jsonb(m)order by user_id)from erp_access.membership m),'contacts',(select jsonb_agg(to_jsonb(c)order by record_id)from erp_catalog.contact c),'records',(select jsonb_agg(to_jsonb(r)order by id)from erp_catalog.record r));`);
 run(upgrade,generated(fullDir));const after=run(upgrade,`select jsonb_build_object('members',(select jsonb_agg(to_jsonb(m)order by user_id)from erp_access.membership m),'contacts',(select jsonb_agg(to_jsonb(c)order by record_id)from erp_catalog.contact c),'records',(select jsonb_agg(to_jsonb(r)order by id)from erp_catalog.record r));`);assert.equal(after,baseline);results.push({gate:'upgrade_full_v031_distribution',old_migrations:older.length,new_migrations:all.length-older.length,preserved:['auth_membership','canonical_contacts','catalog_records'],status:'passed'});
 const scheduleFixture=await readFile(join(root,'tools/consolidation/fixtures/background-schedule.sql'),'utf8');
 run(fresh,scheduleFixture);run(upgrade,scheduleFixture);
 results.push({gate:'humans_schedule_admin_devices_and_background_service',installations:['clean','upgraded'],fixture_sha256:createHash('sha256').update(scheduleFixture).digest('hex'),status:'passed'});
 const unit=rpc(upgrade,'fagoo_command',{p_user_id:admin,p_command_id:randomUUID(),p_action:'unit.save',p_payload:{name:'Unidade de ensaio'}}),other=rpc(upgrade,'fagoo_command',{p_user_id:admin,p_command_id:randomUUID(),p_action:'unit.save',p_payload:{name:'Unidade isolada'}});
 rpc(upgrade,'fagoo_command',{p_user_id:admin,p_command_id:randomUUID(),p_action:'member.save',p_payload:{unit_id:unit.id,user_id:user,capabilities:['crm.read','crm.write']}});
 const crm=rpc(upgrade,'fagoo_crm_read',{p_user_id:user,p_unit_id:unit.id,p_section:'snapshot',p_query:'',p_contact_id:null});assert.equal(crm.funnels.length,1);
 const opportunity=rpc(upgrade,'fagoo_crm_command',{p_user_id:user,p_unit_id:unit.id,p_command_id:randomUUID(),p_action:'opportunity.save',p_payload:{title:'Ensaio preservado',contact_id:contact,owner_id:user,funnel_id:crm.funnels[0].id,stage:'new'}});assert.equal(opportunity.status,'succeeded');
 const denied=raw(upgrade,`set role service_role;select public.fagoo_crm_read('${user}','${other.id}');`);assert.notEqual(denied.status,0);assert.match(denied.stderr,/42501/);
 const projection=rpc(upgrade,'fagoo_contact_project',{p_unit_id:unit.id,p_source_namespace:'test-channel',p_source_id:'test-person',p_name:'Contato de canal',p_phone:'5511999999999'});assert.notEqual(projection.contact_id,contact);results.push({gate:'crm_unit_isolation_and_contact_identity',status:'passed'});
 const queue=rpc(upgrade,'fagoo_queue_snapshot',{p_user_id:admin,p_device_id:null,p_unit_id:unit.id}).queues[0];
 const ticket=rpc(upgrade,'fagoo_queue_command',{p_user_id:admin,p_device_id:null,p_unit_id:unit.id,p_command_id:randomUUID(),p_type:'ticket.issue',p_payload:{queue_id:queue.id},p_expected_version:null}).result.ticket;
 rpc(upgrade,'fagoo_relationship_link',{p_user_id:admin,p_unit_id:unit.id,p_command_id:randomUUID(),p_ticket_id:ticket.id,p_contact_id:contact,p_expected_version:0});
 assert.ok(rpc(upgrade,'fagoo_relationship_history',{p_user_id:admin,p_unit_id:unit.id,p_contact_id:contact}).events.some(event=>event.kind==='queue.issued'));
 assert.equal(rpc(upgrade,'fagoo_relationship_history',{p_user_id:user,p_unit_id:unit.id,p_contact_id:contact}).events.some(event=>event.kind.startsWith('queue.')),false);results.push({gate:'explicit_relationship_source_authorization',status:'passed'});
 run(upgrade,generated(fullDir));assert.equal(Number(run(upgrade,'select count(*) from fagoo_system.schema_migration;')),all.length);results.push({gate:'immutable_ledger_replay',status:'passed'});
 const ledgerSql='select jsonb_agg(jsonb_build_object(\'version\',version,\'sha256\',sha256) order by version) from fagoo_system.schema_migration;',ledger=run(upgrade,ledgerSql);assert.equal(run(fresh,ledgerSql),ledger,'The clean and upgraded installations must use the exact same migration hashes');
 results.push({gate:'fresh_upgrade_identical_schema_hashes',schema_set_sha256:createHash('sha256').update(ledger).digest('hex'),status:'passed'});
 const dump=join(temporary,'synthetic.dump');let result=spawnSync(executable('pg_dump'),['--format=custom','--no-owner','--file',dump,'--dbname',upgrade],{env:{...env,PGPORT:ports.get(upgrade)},windowsHide:true,encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stderr);
 result=spawnSync(executable('pg_restore'),['--no-owner','--exit-on-error','--dbname',restore,dump],{env:{...env,PGPORT:ports.get(restore)},windowsHide:true,encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stderr);
 const digestSql="select string_agg(schema_name||'.'||table_name||':'||checksum,E'\\n' order by schema_name,table_name) from (select n.nspname schema_name,c.relname table_name,(xpath('/row/value/text()',query_to_xml(format('select md5(coalesce(string_agg(row_to_json(t)::text,E''\\n'' order by row_to_json(t)::text),'''')) as value from %I.%I t',n.nspname,c.relname),false,true,'')))[1]::text checksum from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname not in('pg_catalog','information_schema') and n.nspname not like 'pg_toast%') s;";
 assert.equal(run(restore,digestSql),run(upgrade,digestSql));results.push({gate:'full_pg_dump_restore_all_user_tables',archive_sha256:createHash('sha256').update(await readFile(dump)).digest('hex'),status:'passed'});
 for(const name of all)assert.deepEqual(await readFile(join(fullDir,name)),await readFile(join(root,'supabase/migrations',name)),'Distribution changed during rehearsal: '+name);
 const evidence={format:1,postgres:'17.11',synthetic:true,runtime:'synthetic Auth/storage schemas; real PostgreSQL',completed_at:new Date().toISOString(),results};
 if(process.env.FAGOO_TEST_EVIDENCE)await writeFile(resolve(process.env.FAGOO_TEST_EVIDENCE),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(evidence,null,2));
}finally{
 for(const db of created.reverse()){assert.match(db,/^fagoo_rehearsal_(fresh|upgrade|restore)_[a-f0-9]{14}$/);env.PGPORT=ports.get(db);run('postgres',`drop database ${db} with(force);`);}
 for(const cluster of clusters)if(cluster.started){const stopped=spawnSync(executable('pg_ctl'),['-D',cluster.directory,'-m','fast','-w','stop'],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(stopped.status,0,stopped.stderr);cluster.started=false;}
 // The only recursive deletion is the checked temporary directory created by this process, after both servers stop.
 assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert.ok(basename(temporary).startsWith('fagoo-pg-rehearsal-'));assert.ok(clusters.every(c=>resolve(c.directory).startsWith(resolve(temporary)+sep)&&!c.started));
 await rm(temporary,{recursive:true,force:true});
}
