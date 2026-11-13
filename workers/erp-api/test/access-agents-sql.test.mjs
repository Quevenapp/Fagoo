import test from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{acessoHFixture,fails}from'./helpers/acesso-h-fixture.mjs';

// Agent access (202611130001) over the access model of wave H: the agent account, its tokens and the resolver. Synthetic data only.
const MIGRATION='202611130001_access_agents.sql';
const sha=text=>createHash('sha256').update(text).digest('hex');
const fixture=async()=>{const f=await acessoHFixture();await f.migrate(MIGRATION);return f;};
const account=async f=>{const id=randomUUID();await f.db.query('insert into auth.users(id,email)values($1,$2)',[id,`agente-${id}@agentes.fagoo.invalid`]);return id;};
const register=(f,user,role='consulta',name='Agente sintético')=>f.db.query('select erp_access.agent_register($1,$2,$3)',[user,name,role]);
const issue=async(f,agent,{hash=sha(randomUUID()),expires=null}={})=>({hash,id:(await f.db.query('select erp_access.agent_token_issue($1,$2,$3,$4) v',[agent,hash,'ab_-',expires])).rows[0].v});
const resolve=(f,hash)=>f.rpc('erp_access_agent_resolve',{p_token_hash:hash});
const agent=async(f,role)=>{const id=await account(f);await register(f,id,role);return id;};

test('agents: the resolver is service-only; the operator functions and the tables are private',async()=>{const f=await fixture();try{
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_access_agent_resolve(text)','execute') v"),true);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_access_agent_resolve(text)','execute') v`),false,role);
 for(const sig of['erp_access.agent_register(uuid,text,text)','erp_access.agent_token_issue(uuid,text,text,timestamptz)','erp_access.agent_token_revoke(uuid)','erp_access.agent_allowed(uuid)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}','${sig}','execute') v`),false,`${role} ${sig}`);
 for(const t of['agent','agent_token'])for(const p of['select','insert','update','delete'])assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_access.${t}','${p}') v`),false,`${t} ${p}`);
 assert.equal(await f.scalar("select bool_and(relrowsecurity) v from pg_class where oid in('erp_access.agent'::regclass,'erp_access.agent_token'::regclass)"),true);
}finally{await f.close();}});

test('agents: registering makes an ordinary member with a profile; people, privileged roles and unknown accounts are refused',async()=>{const f=await fixture();try{
 const id=await account(f);await register(f,id,'vendas','Hermes');
 assert.deepEqual((await f.db.query('select m.role,m.active,p.name from erp_access.membership m join erp_access.profile p using(user_id) join erp_access.agent a using(user_id) where m.user_id=$1',[id])).rows,[{role:'vendas',active:true,name:'Hermes'}]);
 // The RPCs see it as any member of that role.
 const me=await f.rpc('erp_access_me',{p_user_id:id});assert.deepEqual([me.user_id,me.role],[id,'vendas']);
 await fails(assert,()=>register(f,id),'23505');// already an agent
 await fails(assert,()=>register(f,f.users.vendas),'23505');// a person's account never becomes an agent
 await fails(assert,()=>register(f,f.users.inactive),'23505');
 for(const role of['admin','financeiro','outro',null])await fails(assert,async()=>register(f,await account(f),role),'22023');
 await fails(assert,()=>register(f,randomUUID()),'22023');// no Auth account
 await fails(assert,async()=>register(f,await account(f),'consulta',null),'22023');
 await fails(assert,async()=>register(f,await account(f),'consulta',' espaço '),'23514');
 // A refused registration leaves nothing behind.
 assert.equal(await f.scalar('select count(*)::int v from erp_access.agent'),1);
 await fails(assert,()=>issue(f,f.users.vendas),'P0002');// tokens only for agents
}finally{await f.close();}});

test('agents: a valid token resolves to its agent; unknown, expired and revoked tokens are indistinguishable',async()=>{const f=await fixture();try{
 const id=await agent(f,'consulta'),t=await issue(f,id);
 assert.deepEqual(await resolve(f,t.hash),{scope:'agent_access',status:'ok',user_id:id,token_id:t.id});
 const used=await f.scalar('select last_used_at v from erp_access.agent_token where id=$1',[t.id]);assert.ok(used);
 // The last use is written at most once a minute.
 await resolve(f,t.hash);assert.deepEqual(await f.scalar('select last_used_at v from erp_access.agent_token where id=$1',[t.id]),used);
 const unknown={scope:'agent_access',status:'unknown'};
 for(const hash of[sha('outro'),'x',t.hash.toUpperCase(),t.hash+'0','',null])assert.deepEqual(await resolve(f,hash),unknown,String(hash));
 // A future expiry is honoured; a past one is refused. (The check forbids issuing a token that is already expired.)
 const later=await issue(f,id,{expires:'2999-01-01T00:00:00Z'});assert.equal((await resolve(f,later.hash)).status,'ok');
 await fails(assert,()=>issue(f,id,{expires:'2000-01-01T00:00:00Z'}),'23514');
 const short=await issue(f,id,{expires:new Date(Date.now()+400).toISOString()});await new Promise(done=>setTimeout(done,600));
 assert.deepEqual(await resolve(f,short.hash),unknown);
 // Revoking is final and touches one token only.
 assert.equal(await f.scalar('select erp_access.agent_token_revoke($1) v',[t.id]),true);
 assert.equal(await f.scalar('select erp_access.agent_token_revoke($1) v',[t.id]),false);
 assert.deepEqual(await resolve(f,t.hash),unknown);assert.equal((await resolve(f,later.hash)).status,'ok');
 await fails(assert,()=>issue(f,id,{hash:later.hash}),'23505');// one hash, one token
 await fails(assert,()=>issue(f,id,{hash:'x'}),'23514');
}finally{await f.close();}});

test('agents: an inactive agent or one moved into the second-factor scope is denied at every call, even with the MFA policy off',async()=>{const f=await fixture();try{
 const id=await agent(f,'vendas'),t=await issue(f,id);const status=async()=>(await resolve(f,t.hash)).status;
 assert.equal(await status(),'ok');
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[id]);assert.equal(await status(),'denied');
 await f.db.query('update erp_access.membership set active=true where user_id=$1',[id]);assert.equal(await status(),'ok');
 // Sistema › Usuários may change the profile or the permissions later; the limit is checked live.
 for(const role of['admin','financeiro']){await f.db.query('update erp_access.membership set role=$2 where user_id=$1',[id,role]);assert.equal(await status(),'denied',role);}
 await f.db.query("update erp_access.membership set role='vendas' where user_id=$1",[id]);assert.equal(await status(),'ok');
 await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',array['financas.contas_receber','financas.contas_receber.baixar'],1,clock_timestamp(),$2)",[id,f.users.admin]);
 assert.equal(await status(),'denied');
 await f.db.query("update erp_access.user_control set permissions=array['vendas.propostas'] where user_id=$1",[id]);assert.equal(await status(),'ok');
 // A denied call does not count as a use.
 const fresh=await issue(f,id);await f.db.query('update erp_access.membership set active=false where user_id=$1',[id]);await resolve(f,fresh.hash);
 assert.equal(await f.scalar('select last_used_at v from erp_access.agent_token where id=$1',[fresh.id]),null);
}finally{await f.close();}});

test('agents: with the MFA policy on, an agent inside its limits passes the gate without a session',async()=>{const f=await fixture();try{
 const id=await agent(f,'consulta'),strong=randomUUID();
 await f.db.query("insert into auth.sessions(id,user_id,created_at,aal)values($1,$2,clock_timestamp(),'aal2')",[strong,f.users.admin]);
 await f.db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at)values($1,$2,'totp','verified',clock_timestamp())",[randomUUID(),f.users.admin]);
 await f.rpc('erp_access_security_policy_save',{p_user_id:f.users.admin,p_session_id:strong,p_command_id:randomUUID(),p_expected_version:0,p_mfa_required:true});
 const g=await f.rpc('erp_access_gate_v2',{p_user_id:id,p_session_id:null});assert.deepEqual([g.open,g.mfa_required,g.mfa_ok],[true,false,true]);
 // A person in the scope is still refused without an aal2 session: the policy did not weaken.
 assert.equal((await f.rpc('erp_access_gate_v2',{p_user_id:f.users.admin,p_session_id:null})).mfa_ok,false);
}finally{await f.close();}});

test('agents: the history is immutable',async()=>{const f=await fixture();try{
 const id=await agent(f,'estoque'),t=await issue(f,id);
 await fails(assert,()=>f.db.query('delete from erp_access.agent_token where id=$1',[t.id]),'42501');
 await fails(assert,()=>f.db.query('update erp_access.agent_token set token_hash=$2 where id=$1',[t.id,sha('troca')]),'42501');
 await fails(assert,()=>f.db.query("update erp_access.agent_token set expires_at='2999-01-01' where id=$1",[t.id]),'42501');
 const other=await agent(f,'fiscal');
 await fails(assert,()=>f.db.query('update erp_access.agent_token set agent_id=$2 where id=$1',[t.id,other]),'42501');
 await f.db.query('select erp_access.agent_token_revoke($1)',[t.id]);
 await fails(assert,()=>f.db.query('update erp_access.agent_token set revoked_at=null where id=$1',[t.id]),'42501');
 await fails(assert,()=>f.db.query('delete from erp_access.agent where user_id=$1',[id]),'42501');
}finally{await f.close();}});
