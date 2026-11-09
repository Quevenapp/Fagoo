import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fagooFixture} from './helpers/fagoo-fixture.mjs';
import {handleCrm,crmRoute} from '../src/crm.mjs';

test('CRM HTTP validates scope, actor, methods and bounded commands before RPC',async()=>{
 const unit=randomUUID(),user=randomUUID(),calls=[];
 const call=(path,options={},actor={userId:user})=>handleCrm({request:new Request('https://synthetic.test'+path,options),...actor,rpc:async(name,args)=>{calls.push({name,args});return {ok:true};}});
 assert.equal(crmRoute('/v1/crm/units/x'),true);assert.equal(crmRoute('/v1/crm-evil'),false);
 await call(`/v1/crm/units/${unit}/snapshot?query=Ana`);assert.equal(calls[0].args.p_user_id,user);
 for(const [path,options,actor,status] of [
  [`/v1/crm/units/${unit}/snapshot`,{}, {userId:user,deviceId:randomUUID()},403],
  [`/v1/crm/units/${unit}/snapshot?user_id=forged`,{},undefined,400],
  [`/v1/crm/units/${unit}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),action:'task.complete',payload:{id:randomUUID()},userId:randomUUID()})},undefined,400],
  [`/v1/crm/units/${unit}/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(33000)},undefined,413],
  [`/v1/crm/units/${unit}/snapshot`,{method:'DELETE'},undefined,405],
 ])await assert.rejects(()=>call(path,options,actor),e=>e.status===status);
 assert.equal(calls.length,1);
});

test('CRM canonical SQL preserves ownership, units, stages, tasks, replay and ERP effects',async(t)=>{
 const f=await fagooFixture();try{
  // Preferences fixture intentionally stops before contact-profile lane. Apply the actual visibility functions
  // against a minimal synthetic profile instead of introducing production access bypasses.
  await f.db.exec(`create table if not exists erp_catalog.crm_test_visibility(user_id uuid,contact_id uuid);
   create or replace function erp_catalog.contact_scope(p_user_id uuid) returns uuid language sql stable as $$ select p_user_id $$;
   create or replace function erp_catalog.contact_visible_to(p_scope uuid,p_id uuid) returns boolean language sql stable as $$ select not exists(select 1 from erp_catalog.crm_test_visibility where user_id=p_scope) or exists(select 1 from erp_catalog.crm_test_visibility where user_id=p_scope and contact_id=p_id) $$;
   create or replace function erp_catalog.contact_require_visible(p_user_id uuid,p_id uuid) returns void language plpgsql stable as $$begin if not erp_catalog.contact_visible_to(p_user_id,p_id) then raise exception 'hidden' using errcode='42501';end if;end $$;`);
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202611090003_fagoo_queues.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202611090004_fagoo_crm.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202611090007_fagoo_contact_sources.sql',import.meta.url),'utf8'));
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202611090008_fagoo_relationship_history.sql',import.meta.url),'utf8'));
  const unit=await f.configure('unit.save',{name:'Matriz'}),other=await f.configure('unit.save',{name:'Outra'});
  const projection={p_unit_id:unit.id,p_source_namespace:'whatsapp:synthetic-line',p_source_id:'synthetic-person',p_name:'Nome do canal',p_phone:'5500000000'};
  const projected=await f.rpc('fagoo_contact_project',projection);assert.equal(projected.created,true);
  await f.db.query('update erp_catalog.record set name=$2,human_edited=true where id=$1',[projected.contact_id,'Nome revisado no ERP']);
  const replay=await f.rpc('fagoo_contact_project',{...projection,p_name:'Nome de canal alterado'});assert.equal(replay.contact_id,projected.contact_id);assert.equal(replay.name,'Nome revisado no ERP');assert.equal(replay.created,false);
  assert.notEqual((await f.rpc('fagoo_contact_project',{...projection,p_source_id:'another-person-same-phone'})).contact_id,projected.contact_id);
  await f.db.exec('set role authenticated');await assert.rejects(()=>f.db.query('select public.fagoo_contact_project($1,$2,$3,$4,$5)',Object.values(projection)),{code:'42501'});await f.db.exec('reset role');
  await f.configure('member.save',{user_id:f.users.operacao,unit_id:unit.id,capabilities:['crm.read','crm.write']});
  await f.configure('member.save',{user_id:f.users.vendas,unit_id:unit.id,capabilities:['crm.read','crm.write']});
  const contact=randomUUID(),contact2=randomUUID();for(const id of [contact,contact2]){await f.db.query("insert into erp_catalog.record(id,entity,name) values($1,'contacts',$2)",[id,'Contato '+id]);await f.db.query('insert into erp_catalog.contact(record_id,document,email,phone)values($1,$2,$3,$4)',[id,'SECRET-DOCUMENT','synthetic@example.test','5500000000']);}
  const read=(user=f.users.operacao,unitId=unit.id)=>f.rpc('fagoo_crm_read',{p_user_id:user,p_unit_id:unitId,p_section:'snapshot',p_query:'',p_contact_id:null});
  const send=(action,payload,{user=f.users.operacao,unitId=unit.id,command=randomUUID()}={})=>f.rpc('fagoo_crm_command',{p_user_id:user,p_unit_id:unitId,p_command_id:command,p_action:action,p_payload:payload});
  const snapshot=await read(),funnel=snapshot.funnels[0];assert.deepEqual(funnel.stages.map(s=>s.name),['Novo','Contato','Proposta','Negociação','Ganho','Perdido']);assert.equal(JSON.stringify(snapshot.contacts).includes('SECRET-DOCUMENT'),false);
  const command=randomUUID(),payload={title:'Contrato',contact_id:contact,owner_id:f.users.operacao,funnel_id:funnel.id,stage:'new',amount:'99.00'};
  const created=await send('opportunity.save',payload,{command});assert.equal((await send('opportunity.save',payload,{command})).replayed,true);
  await assert.rejects(()=>send('opportunity.save',{...payload,title:'Mutado'},{command}),{code:'23505'});
  await assert.rejects(()=>send('opportunity.save',{...payload,actor:f.users.admin}),{code:'22023'});
  await assert.rejects(()=>read(f.users.operacao,other.id),{code:'42501'});
  assert.equal((await read(f.users.vendas)).opportunities.length,0);
  await assert.rejects(()=>send('opportunity.move',{id:created.id,stage:'won',expected_version:1},{user:f.users.vendas}),{code:'42501'});
  await assert.rejects(()=>send('opportunity.move',{id:created.id,stage:'won',expected_version:99}),{code:'40001'});
  await send('opportunity.move',{id:created.id,stage:'won',expected_version:1});
  assert.equal((await read()).opportunities[0].stage,'won');assert.equal(await f.scalar('select count(*)::int v from erp_documents.document'),0);
  const task=await send('task.save',{title:'Retornar',contact_id:contact,owner_id:f.users.operacao,opportunity_id:created.id,due_at:'2026-11-10T12:00:00Z'});
  await send('task.complete',{id:task.id,expected_version:1});assert.ok((await read()).tasks[0].completed_at);
  await assert.rejects(()=>send('task.save',{title:'Contato incorreto',contact_id:contact2,opportunity_id:created.id,due_at:'2026-11-10T12:00:00Z'}),{code:'42501'});
  await send('note.add',{contact_id:contact,title:'Conversamos sobre o prazo.'});assert.equal((await read()).timeline.length,5);
  await assert.rejects(()=>send('funnel.save',{id:funnel.id,name:'Novo',stages:funnel.stages,expected_version:1}),{code:'42501'});
  await assert.rejects(()=>send('funnel.save',{id:funnel.id,name:'Novo',stages:funnel.stages.filter(s=>s.id!=='won'),expected_version:1},{user:f.users.admin}),{code:'23505'});
  await f.db.query('insert into erp_catalog.crm_test_visibility values($1,$2)',[f.users.operacao,contact2]);assert.equal((await read()).opportunities.length,0);
  await assert.rejects(()=>send('opportunity.move',{id:created.id,stage:'new',expected_version:2}),{code:'42501'});
  const receipt=await f.rpc('fagoo_crm_receipt',{p_user_id:f.users.operacao,p_unit_id:unit.id,p_command_id:command});assert.equal(receipt.id,created.id);
  assert.equal((await f.rpc('fagoo_crm_receipt',{p_user_id:f.users.vendas,p_unit_id:unit.id,p_command_id:command})).status,'not_found');
  await f.db.query('delete from erp_catalog.crm_test_visibility where user_id=$1',[f.users.operacao]);
  await f.configure('member.save',{user_id:f.users.operacao,unit_id:unit.id,capabilities:['crm.read','crm.write','queue.read','queue.operate']});
  const queue=(await f.rpc('fagoo_queue_snapshot',{p_user_id:f.users.admin,p_device_id:null,p_unit_id:unit.id})).queues[0];
  const queueCommand=(type,payload)=>f.rpc('fagoo_queue_command',{p_user_id:f.users.admin,p_device_id:null,p_unit_id:unit.id,p_command_id:randomUUID(),p_type:type,p_payload:payload,p_expected_version:null});
  const ticket=(await queueCommand('ticket.issue',{queue_id:queue.id})).result.ticket;await queueCommand('ticket.call_next',{desk:'1'});await queueCommand('ticket.start',{ticket_id:ticket.id});
  const invitation=(await queueCommand('rating.request',{ticket_id:ticket.id})).result.rating_invite_id;await f.rpc('fagoo_queue_public_rating',{p_token:ticket.public_token,p_invite_id:invitation,p_stars:5,p_comment:'Avaliação sintética'});
  const linkArgs={p_user_id:f.users.operacao,p_unit_id:unit.id,p_command_id:randomUUID(),p_ticket_id:ticket.id,p_contact_id:contact,p_expected_version:0};
  assert.equal((await f.rpc('fagoo_relationship_link',linkArgs)).link.contact_id,contact);assert.equal((await f.rpc('fagoo_relationship_link',linkArgs)).replayed,true);
  await assert.rejects(()=>f.rpc('fagoo_relationship_link',{...linkArgs,p_command_id:randomUUID()}),{code:'40001'});
  await assert.rejects(()=>f.rpc('fagoo_relationship_link',{...linkArgs,p_user_id:f.users.vendas,p_command_id:randomUUID()}),{code:'42501'});
  const document=randomUUID();await f.db.query("insert into erp_documents.document(id,kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)values($1,'sales_orders',1,'draft',$2,'{}','{}',99,$3,$3)",[document,contact,f.users.admin]);
  const history=user=>f.rpc('fagoo_relationship_history',{p_user_id:user,p_unit_id:unit.id,p_contact_id:contact});
  let relation=await history(f.users.operacao);assert.ok(relation.events.some(e=>e.kind==='queue.rating'&&e.title.includes('5/5')));assert.equal(relation.events.some(e=>e.kind==='commercial.document'),false);
  assert.ok((await history(f.users.admin)).events.some(e=>e.kind==='commercial.document'&&e.href.includes(document)));
  await f.configure('member.save',{user_id:f.users.operacao,unit_id:unit.id,capabilities:['crm.read','crm.write']});relation=await history(f.users.operacao);assert.equal(relation.events.some(e=>e.kind.startsWith('queue.')),false);assert.ok(relation.events.some(e=>e.kind==='note.add'));
  await f.db.exec('set role service_role');await assert.rejects(()=>f.db.query('select * from fagoo.crm_opportunity'),{code:'42501'});await f.db.exec('reset role');
 }finally{await f.close();}
});
