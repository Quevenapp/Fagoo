import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{acessoHFixture,fails}from'./helpers/acesso-h-fixture.mjs';

// Leva H, lane acesso (PRF-208, PRF-209): the MFA policy, the per-session gate and the factor reset. Synthetic data only.
const session=async(f,user,aal)=>{const id=randomUUID();await f.db.query('insert into auth.sessions(id,user_id,created_at,aal)values($1,$2,clock_timestamp(),$3)',[id,user,aal]);return id;};
const factor=async(f,user,status='verified')=>{const id=randomUUID();await f.db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at)values($1,$2,'totp',$3,clock_timestamp())",[id,user,status]);return id;};
const gate=(f,user,sid)=>f.rpc('erp_access_gate_v2',{p_user_id:user,p_session_id:sid});
const policy=(f,{user,sid,on,version,command=randomUUID()})=>f.rpc('erp_access_security_policy_save',{p_user_id:user,p_session_id:sid,p_command_id:command,p_expected_version:version,p_mfa_required:on});

test('H 310: the new RPCs are service-only and the helpers private',async()=>{const f=await acessoHFixture();try{
 for(const sig of['erp_access_gate_v2(uuid,uuid)','erp_access_security_policy_get(uuid,uuid)','erp_access_security_policy_save(uuid,uuid,uuid,integer,boolean)','erp_access_mfa_reset(uuid,uuid,uuid,uuid)','erp_access_me(uuid)']){
  assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${sig}','execute') v`),true,sig);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${sig}','execute') v`),false,`${role} ${sig}`);}
 for(const sig of['erp_access.mfa_required(uuid)','erp_access.session_aal2(uuid,uuid)','erp_access.require_aal2(uuid,uuid)','erp_access.security_gates()'])
  assert.equal(await f.scalar(`select has_function_privilege('service_role','${sig}','execute') v`),false,sig);
 for(const t of['security_policy','security_command','security_event'])assert.equal(await f.scalar(`select has_table_privilege('service_role','erp_access.${t}','select') v`),false,t);
}finally{await f.close();}});

test('H 310: with the policy off nobody is asked for a second factor and the gate flag keeps its 229 meaning',async()=>{const f=await acessoHFixture();try{
 const sid=await session(f,f.users.admin,'aal1');
 const g=await gate(f,f.users.admin,sid);
 assert.deepEqual([g.scope,g.open,g.mfa_required,g.mfa_ok],['access_gate',true,false,true]);
 assert.equal((await f.rpc('erp_access_me',{p_user_id:f.users.vendas})).gate_required,false);
 await fails(assert,()=>gate(f,f.users.inactive,sid),'42501');
}finally{await f.close();}});

test('H 310: turning the policy on needs an administrador in an aal2 session; then admin and financeiro need aal2, the others do not',async()=>{const f=await acessoHFixture();try{
 const weak=await session(f,f.users.admin,'aal1'),strong=await session(f,f.users.admin,'aal2');
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:weak,on:true,version:0}),'28000');
 const finStrong=await session(f,f.users.financeiro,'aal2');
 await fails(assert,()=>policy(f,{user:f.users.financeiro,sid:finStrong,on:true,version:0}),'42501');
 const otherSession=await session(f,f.users.other,'aal2');
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:otherSession,on:true,version:0}),'28000');// another user's session
 await factor(f,f.users.admin);
 const command=randomUUID(),on=await policy(f,{user:f.users.admin,sid:strong,on:true,version:0,command});
 assert.deepEqual([on.scope,on.replayed,on.policy.mfa_required,on.policy.version,on.receipt.to_version],['access_security_command',false,true,1,1]);
 assert.ok(on.gates.every(g=>g.gate_required===true),'every member goes through the gate');
 assert.equal(on.gates.length,8);
 const scope=Object.fromEntries(on.policy.members.map(m=>[m.user_id,m.factor]));
 assert.deepEqual(Object.keys(scope).sort(),[f.users.admin,f.users.other,f.users.financeiro].sort());assert.equal(scope[f.users.admin],true);
 // The same command replays the receipt (and the gates); another body under it is a conflict.
 const again=await policy(f,{user:f.users.admin,sid:weak,on:true,version:0,command});assert.equal(again.replayed,true);assert.equal(again.receipt.changed_at,on.receipt.changed_at);
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:strong,on:false,version:0,command}),'40001');
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:strong,on:true,version:1}),'22023');// unchanged
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:strong,on:false,version:0}),'40001');// stale version
 // The gate: admin aal1 refused, admin aal2 allowed; financeiro aal1 refused; vendas and estoque unaffected.
 assert.deepEqual([(await gate(f,f.users.admin,weak)).mfa_ok,(await gate(f,f.users.admin,strong)).mfa_ok],[false,true]);
 assert.equal((await gate(f,f.users.admin,null)).mfa_ok,false);
 const fin=await gate(f,f.users.financeiro,await session(f,f.users.financeiro,'aal1'));assert.deepEqual([fin.mfa_required,fin.mfa_ok],[true,false]);
 const sales=await gate(f,f.users.vendas,await session(f,f.users.vendas,'aal1'));assert.deepEqual([sales.mfa_required,sales.mfa_ok,sales.open],[false,true,true]);
 // An expired aal2 session does not count.
 const old=randomUUID();await f.db.query("insert into auth.sessions(id,user_id,aal,not_after)values($1,$2,'aal2',clock_timestamp()-interval '1 minute')",[old,f.users.admin]);
 assert.equal((await gate(f,f.users.admin,old)).mfa_ok,false);
 // A seller with a sensitive finance permission enters the scope live, without another flag.
 await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by) values($1,'normal',false,'[]',array['financas.contas_receber','financas.contas_receber.baixar'],1,clock_timestamp(),$2)",[f.users.vendas,f.users.admin]);
 assert.equal((await gate(f,f.users.vendas,await session(f,f.users.vendas,'aal1'))).mfa_required,true);
 assert.equal((await f.rpc('erp_access_me',{p_user_id:f.users.estoque})).gate_required,true);
 // Turning it off needs aal2 too; the history is immutable.
 await fails(assert,()=>policy(f,{user:f.users.admin,sid:weak,on:false,version:1}),'28000');
 const off=await policy(f,{user:f.users.admin,sid:strong,on:false,version:1});assert.equal(off.policy.mfa_required,false);
 assert.deepEqual((await f.db.query('select action from erp_access.security_event order by id')).rows.map(r=>r.action),['mfa_policy_on','mfa_policy_off']);
 await fails(assert,()=>f.db.query('delete from erp_access.security_event'),'42501');
 await fails(assert,()=>f.db.query("update erp_access.security_command set kind='policy'"),'42501');
}finally{await f.close();}});

test('H 310: the factor reset is an aal2 administrador command for another user; it returns the factors once and replays',async()=>{const f=await acessoHFixture();try{
 const strong=await session(f,f.users.admin,'aal2'),weak=await session(f,f.users.admin,'aal1');
 const a=await factor(f,f.users.financeiro),b=await factor(f,f.users.financeiro,'unverified');
 const reset=(sid,target=f.users.financeiro,command=randomUUID(),user=f.users.admin)=>f.rpc('erp_access_mfa_reset',{p_user_id:user,p_session_id:sid,p_command_id:command,p_target:target});
 await fails(assert,()=>reset(weak),'28000');
 await fails(assert,()=>reset(strong,f.users.admin),'42501');// never the own factor
 const finStrong=await session(f,f.users.financeiro,'aal2');
 await fails(assert,()=>reset(finStrong,f.users.vendas,randomUUID(),f.users.financeiro),'42501');
 await fails(assert,()=>reset(strong,randomUUID()),'P0002');
 const command=randomUUID(),done=await reset(strong,f.users.financeiro,command);
 assert.equal(done.replayed,false);assert.deepEqual([...done.factors].sort(),[a,b].sort());
 const again=await reset(weak,f.users.financeiro,command);assert.equal(again.replayed,true);assert.deepEqual(again.factors,done.factors);
 await fails(assert,()=>reset(strong,f.users.vendas,command),'40001');
 const event=(await f.db.query("select target,detail from erp_access.security_event where action='mfa_reset'")).rows;
 assert.equal(event.length,1);assert.equal(event[0].target,f.users.financeiro);assert.deepEqual(event[0].detail,{factors:2});
}finally{await f.close();}});

test('H 310: the users list carries the MFA column and the policy screen tells who still has no factor',async()=>{const f=await acessoHFixture();try{
 await factor(f,f.users.fiscal);await factor(f,f.users.other,'unverified');
 const list=await f.rpc('erp_access_users_list_v2',{p_user_id:f.users.admin,p_query:null,p_status:'todos',p_type:'todos',p_limit:100,p_offset:0});
 const mfa=Object.fromEntries(list.items.map(i=>[i.user_id,i.mfa]));
 assert.equal(mfa[f.users.fiscal],true);assert.equal(mfa[f.users.other],false);assert.equal(mfa[f.users.admin],false);
 const view=await f.rpc('erp_access_security_policy_get',{p_user_id:f.users.admin,p_session_id:await session(f,f.users.admin,'aal1')});
 assert.deepEqual([view.scope,view.policy.mfa_required,view.policy.version,view.self.factor,view.self.aal2],['access_security_policy',false,0,false,false]);
 await fails(assert,()=>f.rpc('erp_access_security_policy_get',{p_user_id:f.users.vendas,p_session_id:null}),'42501');
}finally{await f.close();}});
