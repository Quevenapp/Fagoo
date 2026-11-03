import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runSync } from '../src/sync.mjs';
import { createXmlPriorityPlan } from '../src/xml-priority.mjs';
import { keyFor } from './xml-fixtures.mjs';

const now = new Date('2026-10-17T18:30:00Z');
const candidate = i => ({entity:'nfe',source_id:String(i),key:keyFor('55'),fingerprint:'a'.repeat(64)});
const plan = count => createXmlPriorityPlan({campaign:'synthetic-scheduler',snapshot_time:'2026-10-17T18:25:44.031972Z',
  candidates:Array.from({length:count},(_,i)=>candidate(i+1))});
const pending = c => ({...c,source_exists:true,source_matches:true,current_fingerprint:c.fingerprint,state:null,
  attempt_id:null,attempt_state:null,attempt_fingerprint:null,started_at:null,finished_at:null,next_attempt_at:null,
  error_code:null,terminal_confirmed:false,stored_files:0,eligible:true});
const terminal = c => ({...pending(c),state:'stored',attempt_id:randomUUID(),attempt_state:'stored',
  attempt_fingerprint:c.fingerprint,started_at:'2026-10-17T18:29:00Z',finished_at:'2026-10-17T18:29:01.000001Z',
  terminal_confirmed:true,stored_files:1,eligible:false});
const empty = () => ({status:'completed',keys:0,files:0,unchanged:0,requests:0,errors:[],stop_json:false});
function fixture(p, {lostAck=false,committed=false}={}) {
  let cp = {custom:{retained:true}}, fail = lostAck;
  const rows = new Map(p.candidates.map(c=>[c.source_id,pending(c)])), reads=[], collected=[], regular=[];
  const repo = {
    async claim() {return {acquired:true,lease_token:randomUUID(),checkpoint_version:1,checkpoint:structuredClone(cp)};},
    async rpc(name,args) {
      assert.equal(name,'origin_sync_xml_priority_sources'); reads.push(args.p_candidates.length);
      return {profile:'origin-xml-priority-sources-v1',observed_at:now.toISOString(),
        items:args.p_candidates.map(c=>structuredClone(rows.get(c.source_id)))};
    },
    async apply(_resource,_entity,_owner,_lease,_records,next) {
      if (!fail || committed) cp=structuredClone(next);
      if (fail) {fail=false;throw new Error('DATABASE_UNAVAILABLE');}
      return {};
    },
    async release() {return {released:true};},
  };
  class Client {constructor() {this.requestsMade=0;this.remainingRequests=120;}}
  const xmlCollector = async (_repo,_client,options) => {
    if (!options.candidateProvider) {regular.push(true);return empty();}
    const {items}=await options.candidateProvider.list({limit:options.maxCandidates??2,deadline:options.deadline});
    for (const c of items) {
      assert.ok(!collected.includes(c.source_id),'a confirmed target never causes another GET');
      collected.push(c.source_id);const done=terminal(c);rows.set(c.source_id,done);
      await options.candidateProvider.settled(c,{attempt_id:done.attempt_id,deadline:options.deadline});
    }
    return {...empty(),keys:items.length,files:items.length};
  };
  const env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01',XML_SYNC_ENABLED:'true',XML_RESIDUAL_ENABLED:'true',
    XML_PRIORITY_ENABLED:'true',XML_PRIORITY_PLAN:p};
  const run=()=>runSync(repo,env,{now:()=>now,clock:()=>now.getTime(),getToken:async()=> 'synthetic-token',
    Client,resources:[],xmlCollector});
  return {run,repo,env,reads,collected,regular,checkpoint:()=>structuredClone(cp)};
}

test('priority targets share front/residual collection and persist only confirmed progress with the scheduler',async()=>{
  const f=fixture(await plan(3)),result=await f.run();
  assert.deepEqual(f.collected,['1','2','3']); assert.equal(result.xml_priority.confirmed,3);
  assert.equal(result.xml_priority.all_targets_stored,true);assert.equal(result.xml_priority.coverage_complete,false);
  assert.equal(f.checkpoint().xml_priority.results.length,3);assert.deepEqual(f.checkpoint().custom,{retained:true});
  assert.doesNotMatch(JSON.stringify(result.xml_priority),/source_id|fingerprint|attempt_id/);
  await f.run();assert.deepEqual(f.collected,['1','2','3']);assert.equal(f.regular.length,2);
});

for(const committed of [false,true])test(`lost global ACK recovers XML confirmations without another GET (committed=${committed})`,async()=>{
  const f=fixture(await plan(1),{lostAck:true,committed});
  await assert.rejects(f.run(),/DATABASE_UNAVAILABLE/);assert.deepEqual(f.collected,['1']);
  const result=await f.run();assert.deepEqual(f.collected,['1']);assert.equal(result.xml_priority.confirmed,1);
  assert.equal(result.xml_priority.recovered,committed?0:1);assert.equal(f.checkpoint().xml_priority.results.length,1);
});

test('unpinning the private XML selection fails before claiming or loading credentials',async()=>{
  const p=await plan(1),f=fixture(p);let access=0;
  f.repo.claim=()=>{access++;throw new Error('UNEXPECTED_ACCESS');};
  await assert.rejects(runSync(f.repo,{...f.env,XML_PRIORITY_PLAN:{...p,hash:undefined}},
    {getToken:()=>{access++;}}),/XML_PRIORITY_CONFIG_INVALID/);
  assert.equal(access,0);
});

test('explicit selection-only mode retains XML proof and stops before the normal queue after the selected cohort',async()=>{
  const f=fixture(await plan(3));f.env.XML_PRIORITY_ONLY='true';
  await f.run();const confirmed=f.checkpoint().xml_priority;
  const result=await f.run();
  assert.deepEqual(f.collected,['1','2','3']);assert.deepEqual(f.regular,[]);
  assert.deepEqual(f.checkpoint().xml_priority,confirmed);
  assert.equal(result.xml_priority.all_targets_stored,true);
  assert.equal(result.xml_priority.coverage_complete,false);
  assert.deepEqual(f.checkpoint().custom,{retained:true});
});

for(const committed of [false,true])test(`selection-only mode recovers a lost ACK before stopping (committed=${committed})`,async()=>{
  const f=fixture(await plan(1),{lostAck:true,committed});f.env.XML_PRIORITY_ONLY='true';
  await assert.rejects(f.run(),/DATABASE_UNAVAILABLE/);
  const result=await f.run();assert.deepEqual(f.collected,['1']);assert.deepEqual(f.regular,[]);
  assert.equal(result.xml_priority.confirmed,1);
  assert.equal(result.xml_priority.recovered,committed?0:1);
});

for(const state of ['retry','blocked'])test(`selection-only mode preserves confirmed ${state} as a failure requiring separate follow-up`,async()=>{
  const f=fixture(await plan(1));f.env.XML_PRIORITY_ONLY='true';
  f.repo.rpc=async(name,args)=>{
    assert.equal(name,'origin_sync_xml_priority_sources');
    return {profile:'origin-xml-priority-sources-v1',observed_at:now.toISOString(),
      items:args.p_candidates.map(c=>({...terminal(c),state,attempt_state:state,stored_files:0,
        error_code:'ORIGIN_XML_DOCUMENT_UNAVAILABLE',next_attempt_at:'2026-10-18T18:29:01Z'}))};
  };
  for(let run=0;run<2;run++){
    const result=await f.run();assert.deepEqual(f.collected,[]);assert.deepEqual(f.regular,[]);
    assert.equal(result.xml_priority.confirmed,1);assert.equal(result.xml_priority.failed,1);
    assert.equal(result.xml_priority.stored,0);assert.equal(result.xml_priority.all_targets_stored,false);
    assert.equal(f.checkpoint().xml_priority.results[0].outcome,state);
  }
});

for(const change of [{XML_PRIORITY_ONLY:'true',XML_PRIORITY_ENABLED:'false'},
  {XML_PRIORITY_ONLY:'true',XML_SYNC_ENABLED:'false'},{XML_PRIORITY_ONLY:'yes'}])
test(`selection-only configuration fails before credentials or claims: ${JSON.stringify(change)}`,async()=>{
  const f=fixture(await plan(1));Object.assign(f.env,change);let access=0;
  f.repo.claim=()=>{access++;throw new Error('UNEXPECTED_ACCESS');};
  await assert.rejects(f.run(),/XML_PRIORITY_CONFIG_INVALID/);assert.equal(access,0);
});
