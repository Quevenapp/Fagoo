import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{preferencesFixture,fails}from'./helpers/preferences-fixture.mjs';
import{parseUsersList,parseUserResult,parseInvitePending,captureUsersQuery}from'../../../packages/erp-domain/src/access-users.mjs';
// The 117 list has no Tipo de usuário; the 229 contract (erp_access_users_list_v2) adds it, so the old answer is read as all Normal.
const list=(f,{user=f.users.admin,q=null,status='todos',limit=100,offset=0}={})=>f.rpc('erp_access_users_list',{p_user_id:user,p_query:q,p_status:status,p_limit:limit,p_offset:offset})
 .then(v=>v&&Array.isArray(v.items)?{...v,type:'todos',items:v.items.map(i=>({...i,user_type:'normal'}))}:v);
const get=(f,target,user=f.users.admin)=>f.rpc('erp_access_user_get',{p_user_id:user,p_target:target});
const save=(f,target,expected,data,{user=f.users.admin,command=randomUUID()}={})=>f.rpc('erp_access_user_save',{p_user_id:user,p_command_id:command,p_target:target,p_expected:expected,p_data:data});
const begin=(f,{command=randomUUID(),email='nova.pessoa@sintetico.test',name='Nova Pessoa',role='vendas',user=f.users.admin}={})=>f.rpc('erp_access_user_invite_begin',{p_user_id:user,p_command_id:command,p_email:email,p_name:name,p_role:role});
const complete=(f,command,target,user=f.users.admin)=>f.rpc('erp_access_user_invite_complete',{p_user_id:user,p_command_id:command,p_target:target});
const lookup=(f,command,user=f.users.admin)=>f.rpc('erp_access_user_command',{p_user_id:user,p_command_id:command});
const expectedOf=u=>({role:u.role,active:u.active,profile_version:u.profile_version});

test('117 only an active administrador lists accounts; filters, search and pages follow the contract',async()=>{const f=await preferencesFixture();try{
 for(const role of['consulta','vendas','financeiro','estoque','fiscal','inactive'])await fails(assert,()=>list(f,{user:f.users[role]}),'42501');
 const orphan=randomUUID();await f.db.query("insert into auth.users(id,email,invited_at)values($1,'convidado@sintetico.test',clock_timestamp())",[orphan]);
 const all=parseUsersList(await list(f),captureUsersQuery());assert.equal(all.total,9);assert.deepEqual(all.counts,{ativo:7,inativo:1,sem_acesso:1});
 assert.equal(all.items.find(u=>u.user_id===orphan).status,'sem_acesso');assert.equal(all.items.find(u=>u.user_id===orphan).invited,true);
 const pending=parseUsersList(await list(f,{status:'sem_acesso'}),captureUsersQuery({status:'sem_acesso'}));assert.deepEqual(pending.items.map(u=>u.user_id),[orphan]);
 const search=parseUsersList(await list(f,{q:'financeiro@'}),captureUsersQuery({q:'financeiro@'}));assert.deepEqual(search.items.map(u=>u.email),['financeiro@sintetico.test']);
 const page=parseUsersList(await list(f,{limit:3,offset:3}),captureUsersQuery({limit:3,offset:3}));assert.equal(page.items.length,3);assert.equal(page.has_more,true);
 for(const bad of[{status:'x'},{limit:0},{limit:101},{offset:-1},{q:'a\u0001'}])await fails(assert,()=>list(f,bad),'22023');
 await fails(assert,()=>get(f,randomUUID()),'P0002');assert.equal((await get(f,orphan)).user.email,'convidado@sintetico.test');
}finally{await f.close();}});

test('117 saving compares with what the screen read, keeps the actor an administrador and audits before and after',async()=>{const f=await preferencesFixture();try{
 const vendas=(await get(f,f.users.vendas)).user;
 const named=await save(f,f.users.vendas,expectedOf(vendas),{name:'Vendedora Sintética',phone:'(11) 98765-4321',role:'vendas',active:true});
 parseUserResult(named,{commandId:named.receipt.command_id,target:f.users.vendas});assert.deepEqual(named.receipt.before,{name:null,phone:null,role:'vendas',active:true});
 assert.equal(named.user.profile_version,1);
 await fails(assert,()=>save(f,f.users.vendas,expectedOf(vendas),{name:'Outra',phone:null,role:'vendas',active:true}),'40001','erp_access_users_version_conflict');
 const off=await save(f,f.users.vendas,expectedOf(named.user),{name:'Vendedora Sintética',phone:'(11) 98765-4321',role:'consulta',active:false});
 assert.deepEqual([off.user.status,off.user.role],['inativo','consulta']);assert.equal(await f.scalar('select active v from erp_access.membership where user_id=$1',[f.users.vendas]),false);
 await fails(assert,()=>f.page('empresa-geral',f.users.vendas),'42501');
 const on=await save(f,f.users.vendas,expectedOf(off.user),{name:'Vendedora Sintética',phone:'(11) 98765-4321',role:'vendas',active:true});assert.equal(on.user.status,'ativo');
 await fails(assert,()=>save(f,f.users.vendas,expectedOf(on.user),{name:'Vendedora Sintética',phone:'(11) 98765-4321',role:'vendas',active:true}),'22023','erp_access_users_unchanged');
 const me=(await get(f,f.users.admin)).user;
 await fails(assert,()=>save(f,f.users.admin,expectedOf(me),{name:'Eu',phone:null,role:'consulta',active:true}),'42501','erp_access_users_self_change');
 await fails(assert,()=>save(f,f.users.admin,expectedOf(me),{name:'Eu',phone:null,role:'admin',active:false}),'42501','erp_access_users_self_change');
 assert.equal((await save(f,f.users.admin,expectedOf(me),{name:'Administrador Sintético',phone:null,role:'admin',active:true})).user.name,'Administrador Sintético');
 for(const data of[{name:' x',phone:null,role:'vendas',active:true},{name:'x',phone:'12',role:'vendas',active:true},{name:'x',phone:null,role:'root',active:true},{name:'x',phone:null,role:'vendas'}])
  await fails(assert,()=>save(f,f.users.estoque,{role:'estoque',active:true,profile_version:0},data),'22023');
 await fails(assert,()=>save(f,f.users.estoque,{role:'estoque',active:true,profile_version:0},{name:'x',phone:null,role:'vendas',active:true},{user:f.users.consulta}),'42501');
 const audit=(await f.db.query('select before_data,after_data from erp_access.user_audit order by id')).rows;assert.equal(audit.length,4);assert.deepEqual(audit[1].after_data,{name:'Vendedora Sintética',phone:'(11) 98765-4321',role:'consulta',active:false});
 // The directory of Preferências "users" fields now shows names.
 assert.equal((await f.page('vendas-vendas')).directory.find(d=>d.user_id===f.users.vendas).label,'Vendedora Sintética');
}finally{await f.close();}});

test('117 the same save command replays once; a different body or actor under the same id conflicts',async()=>{const f=await preferencesFixture();try{
 const command=randomUUID(),u=(await get(f,f.users.fiscal)).user,data={name:'Fiscal Sintético',phone:null,role:'fiscal',active:true};
 const first=await save(f,f.users.fiscal,expectedOf(u),data,{command}),again=await save(f,f.users.fiscal,expectedOf(u),data,{command});
 assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);assert.equal(await f.scalar('select count(*)::int v from erp_access.user_audit'),1);
 await fails(assert,()=>save(f,f.users.fiscal,expectedOf(u),{...data,name:'Outro'},{command}),'40001','erp_access_users_command_conflict');
 await fails(assert,()=>save(f,f.users.fiscal,expectedOf(u),data,{command,user:f.users.other}),'40001','erp_access_users_command_conflict');
 assert.equal((await lookup(f,command)).replayed,true);await fails(assert,()=>lookup(f,command,f.users.other),'42501');await fails(assert,()=>lookup(f,randomUUID()),'P0002');
}finally{await f.close();}});

test('117 an account without access is granted by its verified id; inactive grant keeps only the profile',async()=>{const f=await preferencesFixture();try{
 const orphan=randomUUID();await f.db.query("insert into auth.users(id,email)values($1,'sem.acesso@sintetico.test')",[orphan]);
 const kept=await save(f,orphan,{role:null,active:false,profile_version:0},{name:'Sem Acesso',phone:null,role:'consulta',active:false});
 assert.deepEqual([kept.user.status,kept.user.role,kept.receipt.after.role],['sem_acesso',null,null]);assert.equal(await f.scalar('select count(*)::int v from erp_access.membership where user_id=$1',[orphan]),0);
 const granted=await save(f,orphan,{role:null,active:false,profile_version:1},{name:'Sem Acesso',phone:null,role:'consulta',active:true});
 assert.deepEqual([granted.user.status,granted.user.role],['ativo','consulta']);assert.equal((await f.page('empresa-geral',orphan)).role,'consulta');
}finally{await f.close();}});

test('117 invite: recorded before Auth, completed once by the invited account, and safely resumed after a lost answer',async()=>{const f=await preferencesFixture();try{
 const command=randomUUID(),pending=parseInvitePending(await begin(f,{command}),{commandId:command,email:'nova.pessoa@sintetico.test'});assert.equal(pending.existing_user_id,null);
 assert.equal(parseInvitePending(await begin(f,{command}),{commandId:command}).existing_user_id,null);
 await fails(assert,()=>begin(f,{command,role:'consulta'}),'40001','erp_access_users_command_conflict');
 await fails(assert,()=>begin(f,{email:'NOVA.pessoa@sintetico.test'}),'22023');
 // Supabase Auth created the invited account; the Worker answer was lost before "complete".
 const invited=randomUUID();await f.db.query("insert into auth.users(id,email,invited_at)values($1,'Nova.Pessoa@sintetico.test',clock_timestamp())",[invited]);
 assert.equal(parseInvitePending(await begin(f,{command}),{commandId:command}).existing_user_id,invited);
 assert.equal(parseInvitePending(await lookup(f,command),{commandId:command}).existing_user_id,invited);
 await fails(assert,()=>complete(f,command,invited,f.users.other),'42501');
 const stranger=randomUUID();await f.db.query("insert into auth.users(id,email,invited_at)values($1,'outra@sintetico.test',clock_timestamp())",[stranger]);
 await fails(assert,()=>complete(f,command,stranger),'40001','erp_access_users_invite_target_invalid');
 const done=parseUserResult(await complete(f,command,invited),{commandId:command,target:invited,invite:{command_id:command,email:'nova.pessoa@sintetico.test',name:'Nova Pessoa',role:'vendas'}});
 assert.deepEqual([done.user.status,done.user.role,done.user.name,done.replayed],['ativo','vendas','Nova Pessoa',false]);
 assert.equal((await complete(f,command,invited)).replayed,true);await fails(assert,()=>complete(f,command,stranger),'40001','erp_access_users_command_conflict');
 assert.equal((await begin(f,{command})).replayed,true);assert.equal((await lookup(f,command)).receipt.kind,'invite');
 await fails(assert,()=>begin(f,{email:'nova.pessoa@sintetico.test'}),'23505','erp_access_users_email_exists');
 await fails(assert,()=>begin(f,{user:f.users.vendas,email:'x@sintetico.test'}),'42501');
 assert.equal(await f.scalar("select count(*)::int v from erp_access.user_audit where after_data->>'role'='vendas'"),1);
 await fails(assert,()=>f.db.query("update erp_access.user_command set state='done' where id=$1",[command]),'42501','erp_access_history_immutable');
}finally{await f.close();}});

test('117 functions and tables are private; only service_role executes the six RPCs',async()=>{const f=await preferencesFixture();try{
 for(const role of['anon','authenticated','service_role'])for(const t of['profile','user_command','user_audit'])assert.equal(await f.scalar(`select has_table_privilege('${role}','erp_access.${t}','select') v`),false);
 for(const fn of['erp_access_users_list(uuid,text,text,integer,integer)','erp_access_user_get(uuid,uuid)','erp_access_user_save(uuid,uuid,uuid,jsonb,jsonb)','erp_access_user_invite_begin(uuid,uuid,text,text,text)','erp_access_user_invite_complete(uuid,uuid,uuid)','erp_access_user_command(uuid,uuid)']){
  assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${fn}','execute') v`),true,fn);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${fn}','execute') v`),false);}
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_access.user_dto(uuid)','execute') v"),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.directory()','execute') v"),false);
}finally{await f.close();}});

test('117 an invite Auth never completed blocks the e-mail only while it may still be in flight',async()=>{const f=await preferencesFixture();try{
 const email='recusado@sintetico.test',first=randomUUID();parseInvitePending(await begin(f,{command:first,email}),{commandId:first,email});
 // Recent pending invite of the same e-mail: a second command does not call Auth at the same time.
 await fails(assert,()=>begin(f,{email}),'23505','erp_access_users_invite_in_progress');
 // Auth refused it (no SMTP, rate limit) and nobody resumed it: after the window a new command may invite again.
 const stale=randomUUID();await f.db.query("insert into erp_access.user_command(id,actor,kind,email,role,name,request_hash,state,created_at)values($1,$2,'invite','antigo@sintetico.test','vendas','Antigo',repeat('a',64),'pending',clock_timestamp()-interval '6 minutes')",[stale,f.users.admin]);
 const next=randomUUID();assert.equal(parseInvitePending(await begin(f,{command:next,email:'antigo@sintetico.test'}),{commandId:next}).state,'pending');
 assert.equal(await f.scalar("select count(*)::int v from erp_access.user_command where email='antigo@sintetico.test' and state='pending'"),2);
 // The old command, if resumed after Auth created the account for the new one, finds that account and never invites again.
 const invited=randomUUID();await f.db.query("insert into auth.users(id,email,invited_at)values($1,'antigo@sintetico.test',clock_timestamp())",[invited]);
 assert.equal(parseInvitePending(await lookup(f,stale),{commandId:stale}).existing_user_id,invited);
}finally{await f.close();}});
