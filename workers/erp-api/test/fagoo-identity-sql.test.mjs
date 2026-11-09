import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fagooFixture} from './helpers/fagoo-fixture.mjs';
test('operational membership grants no ERP resources; units and devices are separate authorities',async()=>{
 const f=await fagooFixture();try{
  assert.deepEqual(await f.scalar("select erp_access.resources_for_role('operacao') v"),[]);
  const one=await f.configure('unit.save',{name:'Matriz'}),two=await f.configure('unit.save',{name:'Anexo'});
  assert.deepEqual((await f.rpc('fagoo_context',{p_user_id:f.users.operacao})).units,[]);
  await f.configure('member.save',{user_id:f.users.operacao,unit_id:one.id,capabilities:['team.chat','communication.read'],team_ids:['recepcao']});
  const me=await f.rpc('fagoo_context',{p_user_id:f.users.operacao});assert.equal(me.units.length,1);assert.equal(me.units[0].id,one.id);
  const require=(user,device,unit,cap)=>f.scalar('select fagoo.require_unit($1,$2,$3,$4) v',[user,device,unit,cap]);
  await require(f.users.operacao,null,one.id,'team.chat');
  for(const args of [[f.users.operacao,null,two.id,'team.chat'],[f.users.operacao,null,one.id,'crm.read'],[null,null,one.id,'panel.read']])await assert.rejects(()=>require(...args),{code:'42501'});
  const d=await f.configure('device.save',{name:'Painel',unit_id:one.id,capabilities:['panel.read','ticket.issue']});
  await assert.rejects(()=>require(null,d.id,one.id,'panel.read'),{code:'42501'});
  await f.configure('device.issue',{id:d.id,token_hash:'a'.repeat(64)});
  await require(null,d.id,one.id,'panel.read');
  for(const args of [[null,d.id,one.id,'team.chat'],[null,d.id,two.id,'panel.read'],[f.users.admin,d.id,one.id,'panel.read']])await assert.rejects(()=>require(...args),{code:'42501'});
  assert.equal((await f.rpc('fagoo_device_auth',{p_token_hash:'a'.repeat(64)})).mode,'panel');
  await f.rpc('fagoo_device_exit',{p_user_id:f.users.admin,p_device_id:d.id});
  await assert.rejects(()=>f.rpc('fagoo_device_auth',{p_token_hash:'a'.repeat(64)}),{code:'42501'});
  await f.db.exec('set role service_role');await assert.rejects(()=>f.db.query('select * from fagoo.device'),{code:'42501'});await f.db.exec('reset role');
 }finally{await f.close();}
});
test('configuration commands are idempotent, version checked and never record a device secret',async()=>{
 const f=await fagooFixture();try{
  const command=randomUUID(),payload={name:'Unidade principal'};
  const u=await f.configure('unit.save',payload,{command});assert.equal((await f.configure('unit.save',payload,{command})).replayed,true);
  await assert.rejects(()=>f.configure('unit.save',{name:'Outro'},{command}),{code:'40001'});
  await assert.rejects(()=>f.configure('unit.save',{id:u.id,name:'Sem versão'}),{code:'40001'});
  const saved=await f.configure('unit.save',{id:u.id,name:'Renomeada',expected_version:1});assert.equal(saved.version,2);
  await assert.rejects(()=>f.configure('unit.save',{name:'Proibido'},{user:f.users.operacao}),{code:'42501'});
  await assert.rejects(()=>f.configure('device.save',{name:'Inválido',unit_id:u.id,capabilities:['team.chat']}),{code:'22023'});
  const d=await f.configure('device.save',{name:'Tela',unit_id:u.id,capabilities:['panel.read']});
  const issue=randomUUID();await f.configure('device.issue',{id:d.id,token_hash:'b'.repeat(64)},{command:issue});
  const repeat=await f.configure('device.issue',{id:d.id,token_hash:'c'.repeat(64)},{command:issue});assert.equal(repeat.replayed,true);
  assert.equal(await f.scalar('select token_hash v from fagoo.device where id=$1',[d.id]),'b'.repeat(64));
  assert.equal(JSON.stringify(await f.rpc('fagoo_setup',{p_user_id:f.users.admin})).includes('b'.repeat(64)),false);
  const invited=await f.rpc('erp_access_user_invite_begin',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_email:'new@synthetic.test',p_name:'Operador',p_role:'operacao'});assert.ok(invited);
 }finally{await f.close();}
});
