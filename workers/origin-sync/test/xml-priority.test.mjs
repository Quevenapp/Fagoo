import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createXmlPriorityPlan, createXmlPriority } from '../src/xml-priority.mjs';
import { collectXml } from '../src/xml-sync.mjs';
import { invoice, keyFor, encoded } from './xml-fixtures.mjs';

const time = Date.parse('2026-10-17T18:30:00.000Z'), snapshot = '2026-10-17T18:25:44.000Z';
const candidates = (count=1) => Array.from({length:count},(_,i) => ({entity:'nfe',source_id:String(i+1),key:keyFor('55'),fingerprint:'a'.repeat(64)}));
const plan = (count=1, extra={}) => createXmlPriorityPlan({campaign:'synthetic-xml-priority',snapshot_time:snapshot,candidates:candidates(count),...extra});
const observation = (candidate, extra={}) => ({...candidate,source_exists:true,source_matches:true,current_fingerprint:candidate.fingerprint,
  state:null,attempt_id:null,attempt_state:null,attempt_fingerprint:null,started_at:null,finished_at:null,next_attempt_at:null,
  error_code:null,terminal_confirmed:false,stored_files:0,eligible:true,...extra});
const done = (candidate,outcome='stored',extra={}) => observation(candidate,{state:outcome,attempt_id:randomUUID(),attempt_state:outcome,
  attempt_fingerprint:candidate.fingerprint,started_at:'2026-10-17T18:29:00.000Z',finished_at:'2026-10-17T18:29:01.000Z',
  next_attempt_at:'2026-10-18T18:29:01.000Z',error_code:outcome==='stored'?null:'ORIGIN_XML_DOCUMENT_UNAVAILABLE',
  terminal_confirmed:true,stored_files:outcome==='stored'?1:0,eligible:false,...extra});
function harness(input=candidates()) {
  const rows=new Map(input.map(c=>[c.source_id,observation(c)])),calls=[];
  const options={owner:randomUUID(),lease:{lease_token:randomUUID()},now:()=>time};
  const repo={async rpc(name,args,opts){calls.push({name,args,opts});assert.equal(name,'origin_sync_xml_priority_sources');
    assert.equal(args.p_owner,options.owner);assert.equal(args.p_lease_token,options.lease.lease_token);assert.equal(opts.deadline,time+10000);
    return{profile:'origin-xml-priority-sources-v1',observed_at:new Date(time).toISOString(),items:args.p_candidates.map(c=>structuredClone(rows.get(c.source_id)))};
  }};
  return{repo,rows,calls,options,create:async(extra={})=>createXmlPriority(repo,{...options,plan:await plan(input.length),...extra}),list:{limit:2,deadline:time+10000}};
}

test('private selection pins ordered identities, fingerprint and cutoff and rejects ambiguous inputs',async()=>{
  const p=await plan();assert.equal((await createXmlPriorityPlan(p)).hash,p.hash);
  for(const extra of[{snapshot_time:'bad'},{candidates:[]},{candidates:candidates(51)},
    {candidates:[...candidates(),...candidates()]},{candidates:[{...candidates()[0],key:keyFor('65')}]},
    {candidates:[{...candidates()[0],payload:{}}]},{hash:'b'.repeat(64)},{secret:'never'}])await assert.rejects(plan(1,extra),/XML_PRIORITY_PLAN_/);
  assert.notEqual((await plan(1,{snapshot_time:'2026-10-17T18:25:45.000Z'})).hash,p.hash);
});
test('exact targets use the fenced read RPC and are not offered twice in the same cycle',async()=>{
  const h=harness(candidates(3)),p=await h.create();assert.deepEqual((await p.candidateProvider.list(h.list)).items.map(c=>c.source_id),['1','2']);
  assert.deepEqual((await p.candidateProvider.list(h.list)).items.map(c=>c.source_id),['3']);
  assert.equal(p.checkpoint().cursor,0);assert.equal(p.summary().confirmed,0);
  assert.doesNotMatch(JSON.stringify(p.summary()),/source_id|fingerprint|key|attempt_id/);
});
test('a finish ACK advances only after its exact terminal attempt is independently confirmed',async()=>{
  const h=harness(),p=await h.create(),c=(await p.candidateProvider.list(h.list)).items[0],row=done(c);h.rows.set(c.source_id,row);
  await p.candidateProvider.settled(c,{attempt_id:row.attempt_id,deadline:h.list.deadline});
  assert.equal(p.checkpoint().cursor,1);assert.equal(p.summary().all_targets_stored,true);assert.equal(p.summary().recovered,0);
  assert.equal((await p.candidateProvider.list(h.list)).items.length,0);
});
test('retry and blocked ACKs complete an examination without claiming XML coverage',async()=>{
  for(const outcome of ['retry','blocked']){const h=harness(),p=await h.create(),c=(await p.candidateProvider.list(h.list)).items[0],row=done(c,outcome);h.rows.set(c.source_id,row);
    await p.candidateProvider.settled(c,{attempt_id:row.attempt_id,deadline:h.list.deadline});assert.equal(p.summary().failed,1);
    assert.equal(p.summary().remaining,0);assert.equal(p.summary().all_targets_stored,false);assert.equal(p.summary().coverage_complete,false);
  }
});
test('lost finish ACK or scheduler checkpoint ACK is recovered without authorizing another GET',async()=>{
  const h=harness(),p=await h.create();const old=p.checkpoint();await p.candidateProvider.list(h.list);
  h.rows.set('1',done(candidates()[0]));const resumed=await h.create({checkpoint:old});
  assert.deepEqual(await resumed.candidateProvider.list(h.list),{items:[]});assert.equal(resumed.summary().stored,1);assert.equal(resumed.summary().recovered,1);
});
test('pending attempt is not mistaken for a terminal ACK; a new cycle can retry it under a new lease',async()=>{
  const h=harness();h.rows.set('1',observation(candidates()[0],{state:'pending',attempt_id:randomUUID(),attempt_state:'pending',attempt_fingerprint:'a'.repeat(64),started_at:'2026-10-17T18:29:00.000Z'}));
  const p=await h.create(),c=(await p.candidateProvider.list(h.list)).items[0];
  await assert.rejects(p.candidateProvider.settled(c,{attempt_id:h.rows.get('1').attempt_id,deadline:h.list.deadline}),/TERMINAL_UNCONFIRMED/);
  assert.equal(p.checkpoint().cursor,0);assert.equal((await(await h.create({checkpoint:p.checkpoint()})).candidateProvider.list(h.list)).items.length,1);
});
test('changed sources remain explicit residuals while other exact targets can progress',async()=>{
  const h=harness(candidates(2));h.rows.set('1',observation(candidates()[0],{source_matches:false,current_fingerprint:'b'.repeat(64),eligible:false}));
  const p=await h.create();assert.deepEqual((await p.candidateProvider.list(h.list)).items.map(c=>c.source_id),['2']);
  assert.equal(p.checkpoint().residuals[0].code,'XML_PRIORITY_SOURCE_CHANGED');assert.equal(p.checkpoint().cursor,0);
});
test('backoff and observations before the pinned cutoff do not count as this finite examination',async()=>{
  const h=harness();h.rows.set('1',done(candidates()[0],'retry',{started_at:'2026-10-16T18:00:00Z',finished_at:'2026-10-16T18:00:01Z'}));
  const p=await h.create();assert.deepEqual(await p.candidateProvider.list(h.list),{items:[]});assert.equal(p.summary().confirmed,0);
  assert.equal(p.checkpoint().residuals[0].code,'XML_PRIORITY_BACKOFF');
});
test('microsecond cutoff never rounds an earlier terminal observation into confirmation',async()=>{
  const cutoff='2026-10-17T18:25:44.031972+00:00';
  for(const [finished_at,expected]of [['2026-10-17T18:25:44.031971Z',0],['2026-10-17T15:25:44.031972-03:00',1],['2026-10-17T18:25:44.031973Z',1]]){
    const h=harness();h.rows.set('1',done(candidates()[0],'retry',{started_at:'2026-10-17T18:25:40Z',finished_at}));
    const p=await h.create({plan:await plan(1,{snapshot_time:cutoff})});await p.candidateProvider.list(h.list);assert.equal(p.summary().confirmed,expected);
  }
  await assert.rejects(plan(1,{snapshot_time:'2026-02-30T00:00:00Z'}),/PLAN_INVALID/);
});
test('unverified archive or mismatched terminal attempt cannot advance or trigger a new GET',async()=>{
  const h=harness();h.rows.set('1',done(candidates()[0],'stored',{terminal_confirmed:false,stored_files:0,eligible:true}));
  const p=await h.create();assert.deepEqual(await p.candidateProvider.list(h.list),{items:[]});assert.equal(p.summary().confirmed,0);
  h.rows.set('1',observation(candidates()[0]));const q=await h.create(),c=(await q.candidateProvider.list(h.list)).items[0];h.rows.set('1',done(c));
  await assert.rejects(q.candidateProvider.settled(c,{attempt_id:randomUUID(),deadline:h.list.deadline}),/ATTEMPT_CHANGED/);assert.equal(q.summary().confirmed,0);
});
test('invalid metadata and failed/expired reads fail closed without advancing',async()=>{
  for(const change of[{fingerprint:'b'.repeat(64)},{source_id:'999'},{terminal_confirmed:true},{eligible:'true'},
    {current_fingerprint:'b'.repeat(64)},{attempt_id:'invalid'}, {finished_at:'invalid'}]){
    const h=harness();h.rows.set('1',{...h.rows.get('1'),...change});const p=await h.create();await assert.rejects(p.candidateProvider.list(h.list),/XML_PRIORITY_SOURCES_INVALID/);assert.equal(p.summary().confirmed,0);
  }
  const h=harness(),p=await h.create();await assert.rejects(p.candidateProvider.list({...h.list,deadline:time}),/TIME_LIMIT/);
  h.repo.rpc=async()=>{throw new Error('DATABASE_UNAVAILABLE');};await assert.rejects(p.candidateProvider.list(h.list),/DATABASE_UNAVAILABLE/);assert.equal(p.checkpoint().cursor,0);
});
test('checkpoint cannot change plan, skip cursor entries, duplicate results or fabricate completion',async()=>{
  const h=harness(),p=await h.create(),cp=p.checkpoint();
  for(const change of[{plan_hash:'b'.repeat(64)},{cursor:1},{completed_at:new Date(time).toISOString()},{total:9},{results:[{index:0}]}])await assert.rejects(h.create({checkpoint:{...cp,...change}}),/CHECKPOINT_INVALID/);
  const row=done(candidates()[0]);h.rows.set('1',row);await p.candidateProvider.list(h.list);assert.equal((await h.create({checkpoint:p.checkpoint()})).summary().stored,1);
});

function collectorHarness({loseFinish=false,loseFail=false,loseReadback=false}={}) {
  const c=candidates()[0],attempt=randomUUID(),visited={visited:new Set(),stopped:false};let current=observation(c),gets=0,read=0;
  const repo={async rpc(name,args){
    if(name==='origin_sync_xml_priority_sources'){if(loseReadback&&++read>1)throw new Error('DATABASE_UNAVAILABLE');return{profile:'origin-xml-priority-sources-v1',observed_at:new Date(time).toISOString(),items:[structuredClone(current)]};}
    if(name==='origin_sync_xml_begin')return{...c,attempt_id:attempt};
    if(name==='origin_sync_xml_finish'){current=done(c,'stored',{attempt_id:attempt});if(loseFinish)throw new Error('DATABASE_UNAVAILABLE');return{stored:true,files:1,unchanged:false};}
    if(name==='origin_sync_xml_fail'){if(current.state==='stored')return{recorded:false,already_stored:true};current=done(c,'retry',{attempt_id:attempt});if(loseFail)throw new Error('DATABASE_UNAVAILABLE');return{recorded:true};}
    throw new Error('UNEXPECTED_RPC');
  }};
  const client={requestsMade:0,remainingRequests:120,async get(){gets++;this.requestsMade++;this.remainingRequests--;if(loseFail)throw Object.assign(new Error('ORIGIN_HTTP_ERROR'),{status:404});return[encoded(invoice())];}};
  return{repo,client,visited,get gets(){return gets;},options:{owner:randomUUID(),lease:{lease_token:randomUUID()},now:()=>time,deadline:time+40000,storage:{async ensure(){}},examinations:visited}};
}
test('collector provider callback follows successful finish and keeps the normal selector untouched',async()=>{
  const h=collectorHarness(),p=await createXmlPriority(h.repo,{...h.options,plan:await plan()});
  const result=await collectXml(h.repo,h.client,{...h.options,candidateProvider:p.candidateProvider});
  assert.equal(result.keys,1);assert.equal(p.summary().stored,1);assert.equal(h.gets,1);
});
test('lost finish response plus already_stored failure ACK confirms success without a duplicate GET',async()=>{
  const h=collectorHarness({loseFinish:true}),p=await createXmlPriority(h.repo,{...h.options,plan:await plan()});
  await collectXml(h.repo,h.client,{...h.options,candidateProvider:p.candidateProvider});assert.equal(p.summary().stored,1);assert.equal(h.visited.stopped,true);
  await collectXml(h.repo,h.client,{...h.options,candidateProvider:p.candidateProvider});assert.equal(h.gets,1);
});
test('lost failure ACK and post-finish readback failure leave cursor durable recovery to the next claim',async()=>{
  for(const mode of ['loseFail','loseReadback']){const h=collectorHarness({[mode]:true}),p=await createXmlPriority(h.repo,{...h.options,plan:await plan()});
    const result=await collectXml(h.repo,h.client,{...h.options,candidateProvider:p.candidateProvider});assert.equal(p.summary().confirmed,0);assert.equal(h.visited.stopped,true);
    await collectXml(h.repo,h.client,{...h.options,candidateProvider:p.candidateProvider});assert.equal(h.gets,1);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(keyFor('55')+'|source_id|attempt_id'));
  }
});
