import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {queuesFixture} from './helpers/queues-fixture.mjs';

test('print requires a paired executor and rolls back issuance without consuming a number',async()=>{
 const f=await queuesFixture();try{
  const unpaired=await f.configure('device.save',{unit_id:f.unit.id,name:'Unpaired printer',capabilities:['panel.read','print.execute']});
  const refused=await f.command('ticket.issue',{queue_id:f.queue.id,print:true,print_device_id:unpaired.id});
  assert.equal(refused.ok,false);assert.equal(refused.error.code,'queue_printer_not_available');
  assert.equal(await f.scalar('select count(*)::int v from fagoo.queue_ticket'),0);
  assert.equal(await f.scalar('select count(*)::int v from fagoo.queue_effect'),0);
  const first=await f.issue({print:true,print_device_id:f.device.id});assert.equal(first.number,1);
  const copy=await f.command('print.reprint',{ticket_id:first.id,confirmed:true,print_device_id:unpaired.id});assert.equal(copy.error.code,'queue_printer_not_available');
  const other=await f.configure('device.save',{unit_id:f.other.id,name:'Other unit',capabilities:['panel.read','print.execute']});
  await f.configure('device.issue',{id:other.id,token_hash:'b'.repeat(64)});
  assert.equal((await f.command('ticket.issue',{queue_id:f.queue.id,print:true,print_device_id:other.id})).error.code,'queue_printer_not_available');
  const own=await f.issue({print:true,print_device_id:other.id},{deviceId:f.device.id});
  assert.equal((await f.db.query("select device_id from fagoo.queue_effect where payload->>'ticket_id'=$1",[own.id])).rows[0].device_id,f.device.id);
 }finally{await f.close();}
});

test('issuance is atomic/idempotent, public/device projection is redacted and unit permissions are checked again',async()=>{
 const f=await queuesFixture();try{
  const commandId=randomUUID(),payload={queue_id:f.queue.id,phone:'5511999999999',print:true,print_device_id:f.device.id};
  const first=await f.command('ticket.issue',payload,{commandId});assert.equal(first.ok,true,JSON.stringify(first));
  assert.deepEqual(await f.command('ticket.issue',payload,{commandId}),first);
  await assert.rejects(()=>f.command('ticket.issue',{...payload,priority:true},{commandId}),{code:'22023'});
  assert.equal((await f.issue()).number,2);
  assert.equal(await f.scalar('select count(*)::int v from fagoo.queue_effect'),1);
  const pub=await f.rpc('fagoo_queue_public',{p_token:first.result.ticket.public_token});assert.equal(pub.ticket.display_number,'A001');
  assert.deepEqual(Object.keys(pub.ticket).sort(),['called_at','closed_at','desk','display_number','status']);
  for(const read of[pub,await f.snapshot({deviceId:f.device.id}),await f.rpc('fagoo_queue_events',{...f.args({deviceId:f.device.id}),p_after:0})]){
   const json=JSON.stringify(read);assert.equal(json.includes('5511999999999'),false);assert.equal(json.includes(first.result.ticket.public_token),false);assert.equal(json.includes(f.users.admin),false);
  }
  await assert.rejects(()=>f.snapshot({user:f.users.operacao,unitId:f.other.id}),{code:'42501'});
  await assert.rejects(()=>f.command('config.save',{title:'Proibido'},{deviceId:f.device.id}),{code:'42501'});
  await f.db.query('update fagoo.device set active=false where id=$1',[f.device.id]);
  await assert.rejects(()=>f.snapshot({deviceId:f.device.id}),{code:'42501'});
  await f.db.exec('set role service_role');await assert.rejects(()=>f.db.query('select * from fagoo.queue_ticket'),{code:'42501'});await f.db.exec('reset role');
 }finally{await f.close();}
});

test('multiple subscribers, late subscription, provider receipts and stale-call guards never replay unknown deliveries',async()=>{
 const f=await queuesFixture();try{
  const t=await f.issue({phone:'5511999999999'});
  const subscribe=(platform,token)=>f.rpc('fagoo_queue_push_subscribe',{p_token:t.public_token,p_platform:platform,p_push_token:token});
  const fcm=await subscribe('fcm','synthetic-fcm-token'),apns=await subscribe('apns','a'.repeat(64));assert.equal(fcm.status,'active');assert.equal(apns.status,'active');
  assert.equal((await subscribe('fcm','synthetic-fcm-token')).subscription_id,fcm.subscription_id);
  await f.command('ticket.call_next',{desk:'1'});
  await subscribe('fcm','late-subscriber');
  const claim=randomUUID(),notices=(await f.rpc('fagoo_queue_notice_claim',{p_claim_id:claim,p_limit:20})).notices;
  assert.equal(notices.length,4);assert(notices.every(n=>n.kind==='call'));assert.equal(notices.filter(n=>n.channel==='whatsapp').length,1);assert.equal(notices.filter(n=>n.channel==='push_fcm').length,2);
  assert.equal(new Set(notices.map(n=>n.notice_id)).size,4);
  const wa=notices.find(n=>n.channel==='whatsapp'),args={p_notice_id:wa.notice_id,p_claim_id:claim,p_delivery_id:'delivery-synthetic'};
  assert.equal(await f.rpc('fagoo_queue_notice_delivery_allowed',args),true);
  await f.rpc('fagoo_queue_notice_ack',{...args,p_status:'unknown'});
  assert.equal((await f.rpc('fagoo_queue_notice_pending_deliveries',{})).notices.length,1);
  assert.equal(await f.rpc('fagoo_queue_notice_delivery_allowed',args),true);
  assert.equal(await f.rpc('fagoo_queue_notice_delivery_allowed',{...args,p_delivery_id:'wrong'}),false);
  await f.command('ticket.recall',{ticket_id:t.id});
  assert.equal(await f.rpc('fagoo_queue_notice_delivery_allowed',args),false);
  assert.equal(await f.rpc('fagoo_queue_notice_revalidate',{p_notice_id:wa.notice_id,p_claim_id:claim}),null);
  assert.equal((await f.rpc('fagoo_queue_notice_ack',{...args,p_status:'expired'})).status,'expired');
  assert.equal((await f.rpc('fagoo_queue_notice_pending_deliveries',{})).notices.length,0);
  const next=(await f.rpc('fagoo_queue_notice_claim',{p_claim_id:randomUUID(),p_limit:20})).notices;assert.equal(next.length,4);assert(next.every(n=>!notices.some(old=>old.notice_id===n.notice_id)));
  await f.db.query("update fagoo.queue_subscription set status='revoked' where id=$1",[fcm.subscription_id]);
  const revoked=next.find(n=>n.destination==='synthetic-fcm-token');assert.equal(await f.rpc('fagoo_queue_notice_delivery_allowed',{p_notice_id:revoked.notice_id,p_claim_id:revoked.claim_id,p_delivery_id:null}),false);
  for(let i=0;i<6;i++)await subscribe('fcm','extra-subscriber-'+i);
  await assert.rejects(()=>subscribe('fcm','eleventh-subscriber'),{code:'22023'});
 }finally{await f.close();}
});

test('cancel of an unconfirmed command is a transactional barrier; committed commands retain their real receipt',async()=>{
 const f=await queuesFixture();try{
  const id=randomUUID(),args={...f.args(),p_command_id:id};
  const cancelled=await f.rpc('fagoo_queue_cancel_unconfirmed',args);assert.equal(cancelled.error.code,'queue_command_cancelled');
  assert.deepEqual(await f.command('ticket.issue',{queue_id:f.queue.id},{commandId:id}),cancelled);assert.equal((await f.snapshot()).tickets.length,0);
  const done=randomUUID(),issued=await f.command('ticket.issue',{queue_id:f.queue.id},{commandId:done});assert.deepEqual(await f.rpc('fagoo_queue_cancel_unconfirmed',{...args,p_command_id:done}),issued);
  await assert.rejects(()=>f.rpc('fagoo_queue_cancel_unconfirmed',{...args,p_user_id:f.users.operacao,p_command_id:done}),{code:'42501'});
  const copy=await f.command('print.reprint',{ticket_id:issued.result.ticket.id,confirmed:true},{deviceId:f.device.id});assert.equal(copy.ok,true);assert.equal(copy.result.ticket.public_token,undefined);assert.equal(copy.result.ticket.phone,undefined);assert.equal(copy.result.ticket.operator_user_id,undefined);
  const history=await f.rpc('fagoo_queue_history',{...f.args(),p_before:null});assert.equal(history.tickets.length,1);assert.equal(history.before,issued.result.ticket.id);assert.equal((await f.rpc('fagoo_queue_history',{...f.args(),p_before:history.before})).tickets.length,0);
 }finally{await f.close();}
});

test('priority alternation, reserved desk, stable identity and service across transfers match Vinki',async()=>{
 const f=await queuesFixture();try{
  assert.equal((await f.command('queue.save',{id:f.queue.id,name:'Atendimento',prefix:'A',regulars_per_priority:2})).ok,true);
  const normal1=await f.issue(),normal2=await f.issue(),priority1=await f.issue({priority:true}),priority2=await f.issue({priority:true});
  const call=async(desk='1',more={})=>{const r=await f.command('ticket.call_next',{desk,...more});assert.equal(r.ok,true,JSON.stringify(r));return r.result.ticket;};
  assert.equal((await call()).id,priority1.id);assert.equal((await call()).id,normal1.id);assert.equal((await call()).id,normal2.id);assert.equal((await call()).id,priority2.id);
  let r=await f.command('ticket.start',{ticket_id:priority2.id});assert.equal(r.ok,true,JSON.stringify(r));const service=r.result.service_id;
  r=await f.command('ticket.transfer',{ticket_id:priority2.id,desk:'Especial'});assert.equal(r.result.ticket.display_number,priority2.display_number);assert.equal(r.result.ticket.issued_at,priority2.issued_at);
  assert.equal((await f.command('ticket.call_next',{desk:'Outro'})).error.code,'queue_empty');
  const reserved=await call('Especial',{queue_ids:[randomUUID()]});assert.equal(reserved.id,priority2.id);
  assert.equal((await f.command('ticket.start',{ticket_id:reserved.id})).result.service_id,service);
  assert.equal((await f.command('ticket.complete',{ticket_id:reserved.id})).result.ticket.status,'concluida');
  assert.equal((await f.command('ticket.transfer',{ticket_id:reserved.id,desk:'1'})).error.code,'queue_invalid_transition');
  assert.equal((await f.command('ticket.recall',{ticket_id:normal1.id})).result.ticket.recalls,1);
  assert.equal((await f.command('ticket.complete',{ticket_id:normal1.id})).error.code,'queue_invalid_transition');
 }finally{await f.close();}
});

test('lost print acknowledgement becomes uncertain, never repeats; audio primes silently and obsolete calls expire',async()=>{
 const f=await queuesFixture();try{
  const t=await f.issue({print:true,print_device_id:f.device.id});const claimId=randomUUID();
  const claim=(kind,id=claimId,after=0)=>f.rpc('fagoo_queue_effect_claim',{...f.args({deviceId:f.device.id}),p_kind:kind,p_claim_id:id,p_after_revision:after});
  const jobs=(await claim('print')).jobs;assert.equal(jobs.length,1);assert.deepEqual((await claim('print')).jobs,jobs);
  assert.equal((await claim('print',randomUUID())).jobs.length,0);
  await f.db.exec("update fagoo.queue_effect set claimed_at=clock_timestamp()-interval '61 seconds'");
  assert.equal((await claim('print',randomUUID())).jobs.length,0);assert.equal(await f.scalar('select status v from fagoo.queue_effect'),'uncertain');
  const ack={...f.args({deviceId:f.device.id}),p_job_id:jobs[0].id,p_claim_id:claimId,p_result:'impresso'};
  assert.equal((await f.rpc('fagoo_queue_effect_ack',ack)).status,'done');assert.equal((await f.rpc('fagoo_queue_effect_ack',ack)).status,'done');
  await assert.rejects(()=>f.rpc('fagoo_queue_effect_ack',{...ack,p_result:'falhou'}),{code:'22023'});
  await f.command('ticket.call_next',{desk:'1'});const revision=(await f.snapshot()).revision;
  assert.equal((await claim('audio',randomUUID(),revision)).jobs.length,0);
  await f.command('ticket.recall',{ticket_id:t.id});assert.equal((await claim('audio',randomUUID(),revision)).jobs.length,1);
  await f.command('ticket.recall',{ticket_id:t.id});await f.command('ticket.transfer',{ticket_id:t.id,desk:'2'});
  assert.equal((await claim('audio',randomUUID(),revision)).jobs.length,0);
  assert.equal((await f.command('print.reprint',{ticket_id:t.id,print_device_id:f.device.id})).error.code,'queue_reprint_confirmation');
  assert.equal((await f.command('print.reprint',{ticket_id:t.id,print_device_id:f.device.id,confirmed:true})).ok,true);
  assert.equal((await claim('print',randomUUID())).jobs.length,1);
 }finally{await f.close();}
});

test('business-day closure, order lifecycle, expiring campaigns and single-use ratings remain server authoritative',async()=>{
 const f=await queuesFixture();try{
  const t=await f.issue({phone:'5511999999999'});await f.command('ticket.call_next',{desk:'1'});await f.command('ticket.start',{ticket_id:t.id});
  const invite=(await f.command('rating.request',{ticket_id:t.id})).result.rating_invite_id;
  assert.equal((await f.rpc('fagoo_queue_public',{p_token:t.public_token})).rating.invite_id,invite);
  assert.equal((await f.rpc('fagoo_queue_public_rating',{p_token:t.public_token,p_invite_id:invite,p_stars:5,p_comment:'Ótimo'})).saved,true);
  await assert.rejects(()=>f.rpc('fagoo_queue_public_rating',{p_token:t.public_token,p_invite_id:invite,p_stars:4,p_comment:null}),{code:'22023'});
  await f.db.exec("update fagoo.queue_ticket set business_day=(clock_timestamp() at time zone 'America/Sao_Paulo')::date-1");
  assert.equal((await f.snapshot()).tickets.length,0);assert.equal(await f.scalar('select status v from fagoo.queue_ticket'),'concluida');
  const order=(await f.command('order.create',{code:'Mesa 5'})).result.order;
  assert.equal((await f.command('order.transition',{order_id:order.id,status:'pronto'})).error.code,'queue_invalid_transition');
  for(const status of['em_preparo','pronto','retirado'])assert.equal((await f.command('order.transition',{order_id:order.id,status})).result.order.status,status);
  assert.equal((await f.snapshot()).orders.length,0);
  const campaign={title:'Promoção',media_url:'https://example.com/banner.png',media_type:'image',starts_at:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString()};
  const saved=await f.command('campaign.save',campaign);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal((await f.snapshot()).campaigns.length,1);
  await f.db.exec("update fagoo.queue_campaign set starts_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'");assert.equal((await f.snapshot()).campaigns.length,0);
  assert.equal(await f.scalar('select bool_and(free_only) v from fagoo.queue_notice'),true);
 }finally{await f.close();}
});
