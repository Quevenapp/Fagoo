import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import{spawn}from'node:child_process';import{readFile,readdir}from'node:fs/promises';
import{bootstrap}from'../../../tools/migration/helpers/stock-reservation-fixture.mjs';
const psql=process.env.FAGOO_QUEUE_TEST_PSQL,port=process.env.FAGOO_QUEUE_TEST_PORT??'55432';
const literal=value=>value===null?'null':"'"+String(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
async function query(database,sql){return await new Promise((resolve,reject)=>{const p=spawn(psql,['-X','-q','-A','-t','-h','127.0.0.1','-p',port,'-U','fagoo_test','-v','ON_ERROR_STOP=1','-d',database],{windowsHide:true});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));p.stdin.end(sql);});}
const rpc=(database,name,args)=>query(database,`set role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${literal(v)}`).join(',')});`).then(JSON.parse);
async function sleeping(database,name){for(let attempt=0;attempt<30;attempt++){if(await query(database,`select count(*)from pg_stat_activity where application_name=${literal(name)} and wait_event='PgSleep'`)==='1')return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('lock holder not observed');}
test('real PostgreSQL concurrent issuance, replay, call arbitration, unit independence and lost effect ACK',{skip:!psql},async()=>{
 const database='queue_test_'+randomUUID().replaceAll('-',''),user=randomUUID();await query('postgres',`create database ${database};`);
 try{
  const dir=new URL('../../../supabase/migrations/',import.meta.url);
  const names=(await readdir(dir)).filter(n=>(/^20261(01[67]|019)\d{4}_.+\.sql$/.test(n)||/^20261020(010\d|011[0-8])_.+\.sql$/.test(n))).sort();
  let schema=bootstrap.replace(/create role (\w+)( bypassrls)?;/g,(_,role,option)=>`do $$begin if not exists(select 1 from pg_roles where rolname='${role}')then create role ${role}${option??''};end if;end$$;`);
  schema+="alter table auth.users add column email text,add column created_at timestamptz default now(),add column invited_at timestamptz,add column email_confirmed_at timestamptz,add column last_sign_in_at timestamptz,add column banned_until timestamptz,add column is_anonymous boolean default false;";
  for(const name of [...names,'202611090002_fagoo_identity.sql','202611090003_fagoo_queues.sql','202611090009_fagoo_print_destination.sql'])schema+=await readFile(new URL(name,dir),'utf8');
  await query(database,schema);await query(database,`insert into auth.users(id,email)values('${user}','synthetic@example.test');insert into erp_access.membership(user_id,role)values('${user}','admin');`);
  const config=(action,payload)=>rpc(database,'fagoo_command',{p_user_id:user,p_command_id:randomUUID(),p_action:action,p_payload:payload});
  const unit=await config('unit.save',{name:'Concorrência'}),other=await config('unit.save',{name:'Independente'}),args={p_user_id:user,p_device_id:null,p_unit_id:unit.id};
  const snap=await rpc(database,'fagoo_queue_snapshot',args),qid=snap.queues[0].id;
  const command=(type,payload={},id=randomUUID())=>rpc(database,'fagoo_queue_command',{...args,p_command_id:id,p_type:type,p_payload:payload,p_expected_version:null});
  const issued=await Promise.all(Array.from({length:12},()=>command('ticket.issue',{queue_id:qid})));
  assert(issued.every(r=>r.ok));assert.deepEqual(issued.map(r=>r.result.ticket.number).sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
  const same=randomUUID(),replays=await Promise.all(Array.from({length:12},()=>command('ticket.issue',{queue_id:qid},same)));for(const r of replays)assert.deepEqual(r,replays[0]);
  assert.equal(Number(await query(database,'select count(*) from fagoo.queue_ticket')),13);
  const called=await Promise.all(Array.from({length:16},(_,i)=>command('ticket.call_next',{desk:String(i+1)})));
  assert.equal(called.filter(r=>r.ok).length,13);assert.equal(new Set(called.filter(r=>r.ok).map(r=>r.result.ticket.id)).size,13);assert(called.filter(r=>!r.ok).every(r=>r.error.code==='queue_empty'));
  // A locked unit cannot block a different unit's snapshot/initialization.
  const app='queue_hold_'+randomUUID().slice(0,8),hold=query(database,`set application_name='${app}';begin;select 1 from fagoo.queue_runtime where unit_id='${unit.id}' for update;select pg_sleep(1.5);commit;`);
  await sleeping(database,app);const start=Date.now();const otherSnapshot=await rpc(database,'fagoo_queue_snapshot',{...args,p_unit_id:other.id});assert.equal(otherSnapshot.unit.id,other.id);assert(Date.now()-start<1200,'different unit waited for unrelated lock');await hold;
  const device=await config('device.save',{unit_id:unit.id,name:'Impressora',capabilities:['panel.read','print.execute','ticket.issue']});await config('device.issue',{id:device.id,token_hash:'a'.repeat(64)});
  await command('ticket.issue',{queue_id:qid,print:true,print_device_id:device.id});
  const claim=id=>rpc(database,'fagoo_queue_effect_claim',{...args,p_user_id:null,p_device_id:device.id,p_kind:'print',p_claim_id:id,p_after_revision:0});
  const claims=await Promise.all(Array.from({length:8},()=>claim(randomUUID())));assert.equal(claims.flatMap(r=>r.jobs).length,1);
  await query(database,"update fagoo.queue_effect set claimed_at=clock_timestamp()-interval '70 seconds' where kind='print';");assert.equal((await claim(randomUUID())).jobs.length,0);assert.equal(await query(database,"select status from fagoo.queue_effect where kind='print'"),'uncertain');
  assert.equal(Number(await query(database,'select count(*)-count(distinct revision) from fagoo.queue_event where unit_id='+literal(unit.id))),0);
  // Authorization is checked after a waiting unit lock, not only on request entry.
  const revokeName='queue_revoke_'+randomUUID().slice(0,8),revoke=query(database,`set application_name='${revokeName}';begin;select 1 from fagoo.queue_runtime where unit_id='${unit.id}' for update;select pg_sleep(1.5);update erp_access.membership set active=false where user_id='${user}';commit;`);
  await sleeping(database,revokeName);await assert.rejects(()=>command('ticket.issue',{queue_id:qid}),/fagoo_access_denied/);await revoke;
  await query(database,`update erp_access.membership set active=true where user_id='${user}';`);
  const fairness=(await command('queue.save',{name:'Alternância',prefix:'P',regulars_per_priority:1})).result.queue;
  for(let i=0;i<4;i++)await command('ticket.issue',{queue_id:fairness.id,priority:false});
  for(let i=0;i<4;i++)await command('ticket.issue',{queue_id:fairness.id,priority:true});
  await Promise.all(Array.from({length:8},(_,i)=>command('ticket.call_next',{desk:'F'+i,queue_ids:[fairness.id]})));
  const order=JSON.parse(await query(database,`select jsonb_agg((e.payload->'ticket'->>'priority')::boolean order by e.revision) from fagoo.queue_event e where e.type='ticket.call_next' and e.payload->'ticket'->>'queue_id'='${fairness.id}'`));
  assert.deepEqual(order,[true,false,true,false,true,false,true,false]);
 }finally{await query('postgres',`drop database ${database} with(force);`);}
});
