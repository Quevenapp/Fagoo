import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {OriginClient,OriginApiError} from '../src/client.mjs';
import {XmlStorage} from '../src/xml-storage.mjs';
import {collectXml} from '../src/xml-sync.mjs';
import {Repository} from '../src/repository.mjs';
import {runSync} from '../src/sync.mjs';
import {getResource} from '../src/resources.mjs';
import {invoice,event,keyFor,encoded} from './xml-fixtures.mjs';
const bytes=new TextEncoder().encode(invoice());
const document={bytes,size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};
const fixedBase='https://synthetic.supabase.co',key='synthetic-service-key';
const storageFor=fetchImpl=>new XmlStorage({base:fixedBase,key,fetch:fetchImpl});
function harness(models=['55']){
 const calls=[],stored=[],candidates=models.map((model,i)=>({entity:model==='55'?'nfe':'nfce',source_id:String(i+1),key:keyFor(model),fingerprint:'a'.repeat(64)}));
 const repo={calls,async rpc(name,args,options){calls.push({name,args,options});
  if(name==='origin_sync_xml_candidates')return{items:candidates};
  if(name==='origin_sync_xml_begin')return{attempt_id:randomUUID(),entity:args.p_entity,source_id:args.p_source_id,key:args.p_key,fingerprint:args.p_fingerprint};
  if(name==='origin_sync_xml_finish')return{stored:true,files:args.p_documents.length,unchanged:false};
  if(name==='origin_sync_xml_fail')return{recorded:true};throw new Error('TEST_UNEXPECTED_RPC');
 }};
 const storage={async ensure(value,options){stored.push({value,options});}};
 return{repo,storage,stored,candidates,options:{owner:randomUUID(),lease:{lease_token:randomUUID()},deadline:Date.now()+180000,storage}};
}
test('XML fixed endpoint accepts only XML array and blocks arbitrary URL, PDF and extra parameters',async()=>{
 const calls=[];const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json({data:[encoded(invoice())]});}});
 assert.equal((await client.get('/nfe/documento/'+keyFor('55'),{formato:'xml'})).length,1);
 assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'manual');assert.equal(new URL(calls[0].url).hostname,'api.provider.example');
 for(const[path,params]of[['https://evil.invalid',{}],['/nfe/documento/'+keyFor('55'),{formato:'pdf'}],['/nfe/documento/'+keyFor('55'),{formato:'xml',url:'https://evil.invalid'}]])await assert.rejects(client.get(path,params),/ORIGIN_INVALID_/);
 assert.equal(calls.length,1);
 const wrong=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',fetchImpl:async()=>Response.json({data:{nome:'x',conteudo:'x'}})});
 await assert.rejects(wrong.get('/nfe/documento/'+keyFor('55'),{formato:'xml'}),/ORIGIN_INVALID_DATA_SHAPE/);
});
test('scoped XML deadlines preserve the shared client and retain 429 semantics without sleeping past budget',async()=>{
 let clock=1000,calls=0;const waits=[];
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',now:()=>clock,sleep:async ms=>{clock+=ms;waits.push(ms);},deadline:100000,
  fetchImpl:async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'30'}}):Response.json({data:[]})});
 await assert.rejects(client.get('/nfe/documento/'+keyFor('55'),{formato:'xml'},{deadline:clock+20000}),error=>error.status===429&&error.code==='ORIGIN_TIME_BUDGET_EXHAUSTED');
 assert.deepEqual(waits,[]);assert.deepEqual(await client.get('/contatos'),[]);assert.equal(client.requestsMade,2);
 await assert.rejects(client.get('/contatos',{}, {deadline:1}),/ORIGIN_TIME_BUDGET_EXHAUSTED/);assert.equal(client.requestsMade,2);
});
test('immutable Storage POST is recovered by authenticated hash verification after conflict or lost response',async()=>{
 for(const lost of[false,true]){const calls=[];const storage=storageFor(async(url,init)=>{calls.push({url,init});
   if(init.method==='POST'){if(lost)throw new Error('network unknown');return new Response('',{status:409});}
   return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
  });await storage.ensure(document);
  assert.equal(calls.length,2);assert.match(calls[0].url,new RegExp('/objects/'+document.hash+'\\.xml$'));assert.match(calls[1].url,/\/object\/authenticated\/origin-fiscal-xml\//);
  assert.equal(calls[0].init.headers['x-upsert'],'false');assert.equal(calls[1].init.headers.Authorization,'Bearer '+key);assert.ok(calls.every(c=>c.init.redirect==='manual'));
 }
});
test('Storage refuses redirects, corrupt or oversized objects and never forwards authentication to Location',async()=>{
 for(const mode of['redirect','hash','size','missing']){
  const calls=[];const storage=storageFor(async(url,init)=>{calls.push(url);if(init.method==='POST')return mode==='redirect'?new Response('',{status:302,headers:{location:'https://evil.invalid'}}):Response.json({});
   if(mode==='missing')return new Response('',{status:404});if(mode==='size')return new Response(bytes,{headers:{'content-length':String(bytes.length+1)}});return new Response(new Uint8Array(bytes.length));});
  await assert.rejects(storage.ensure(document),/XML_STORAGE_/);assert.ok(calls.every(u=>u.startsWith(fixedBase+'/')));if(mode==='redirect')assert.equal(calls.length,1);
 }
});
test('Storage and Repository deadlines cover stalled response bodies and abort every attempt',async()=>{
 const signals=[];const stall=()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([123]));}}));
 const storage=storageFor(async(_url,init)=>{signals.push(init.signal);return init.method==='POST'?Response.json({}):stall();});
 await assert.rejects(storage.ensure(document,{deadline:Date.now()+20}),/XML_STORAGE_TIMEOUT/);assert.ok(signals.every(s=>s.aborted));
 const repoSignals=[];const repo=new Repository({SUPABASE_URL:fixedBase,SUPABASE_SERVICE_ROLE_KEY:key},{timeoutMs:5,sleep:async()=>{},fetchImpl:async(_url,init)=>{repoSignals.push(init.signal);return stall();}});
 await assert.rejects(repo.rpc('origin_sync_xml_status'),/DATABASE_UNAVAILABLE/);assert.equal(repoSignals.length,3);assert.ok(repoSignals.every(s=>s.aborted));
 const oversized=new Repository({SUPABASE_URL:fixedBase,SUPABASE_SERVICE_ROLE_KEY:key},{fetchImpl:async()=>new Response('{}',{headers:{'content-length':'1048577'}})});
 await assert.rejects(oversized.rpc('origin_sync_xml_status'),/DATABASE_RESPONSE_SIZE_LIMIT/);
});
test('Storage never starts a request after the deadline, including a delayed upload result',async()=>{
 let calls=0;const expired=storageFor(async()=>{calls++;return Response.json({});});
 await assert.rejects(expired.ensure(document,{deadline:1}),/XML_STORAGE_TIMEOUT/);assert.equal(calls,0);
 const delayed=storageFor(async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,25));return Response.json({});});
 await assert.rejects(delayed.ensure(document,{deadline:Date.now()+10}),/XML_STORAGE_TIMEOUT/);
 await new Promise(resolve=>setTimeout(resolve,35));assert.equal(calls,1);
});
test('collector validates all files before upload and commits only after every immutable object is verified',async()=>{
 const h=harness();const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>Response.json({data:[encoded(invoice()),encoded(event())]})});
 const result=await collectXml(h.repo,client,h.options);assert.equal(result.keys,1);assert.equal(result.files,2);assert.equal(result.requests,1);
 assert.equal(h.stored.length,2);const finish=h.repo.calls.find(c=>c.name==='origin_sync_xml_finish');assert.equal(finish.args.p_documents.length,2);assert.ok(finish.args.p_documents.every(d=>!('bytes'in d)));
 const begin=h.repo.calls.find(c=>c.name==='origin_sync_xml_begin');assert.ok(begin.options.deadline<=Date.now()+20000);assert.ok(h.stored.every(d=>d.options.deadline<=begin.options.deadline));
 const invalid=harness();const badClient=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',fetchImpl:async()=>Response.json({data:[encoded(invoice()),encoded('bad XML')]})});
 assert.equal((await collectXml(invalid.repo,badClient,invalid.options)).status,'partial');assert.equal(invalid.stored.length,0);assert.ok(!invalid.repo.calls.some(c=>c.name==='origin_sync_xml_finish'));
});
test('failed Storage leaves no completed manifest and the next scheduled attempt can safely retry the complete set',async()=>{
 const h=harness();let uploads=0;h.options.storage={async ensure(){if(++uploads===2)throw new Error('XML_STORAGE_READ_FAILED');}};
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',intervalMs:0,fetchImpl:async()=>Response.json({data:[encoded(invoice()),encoded(event())]})});
 const failed=await collectXml(h.repo,client,h.options);assert.equal(failed.keys,0);assert.ok(!h.repo.calls.some(c=>c.name==='origin_sync_xml_finish'));assert.equal(h.repo.calls.at(-1).args.p_blocked,false);
 h.options.storage=h.storage;const retry=await collectXml(h.repo,client,h.options);assert.equal(retry.keys,1);assert.equal(retry.files,2);
});
test('two XML candidates share retries/rate limiter and consume at most six Origin requests',async()=>{
 const h=harness(['55','65']);let clock=Date.now(),calls=0;const waits=[];
 const client=new OriginClient('synthetic-token',{ apiOrigin: 'https://api.provider.example',now:()=>clock,sleep:async ms=>{clock+=ms;waits.push(ms);},fetchImpl:async url=>{
  calls++;if(calls%3!==0)return new Response('',{status:503});return Response.json({data:[encoded(invoice(url.includes(keyFor('65'))?'65':'55'))]});}});
 const result=await collectXml(h.repo,client,{...h.options,now:()=>clock});
 assert.equal(result.keys,2);assert.equal(result.requests,6);assert.equal(calls,6);assert.ok(waits.length>=4);assert.ok(client.remainingRequests===114);
});
test('collector keeps JSON eligible on403/structural error, stops on401/429, and exposes no key or body',async()=>{
 for(const status of[401,403,429]){const h=harness();const client={requestsMade:1,remainingRequests:119,async get(){throw new OriginApiError('ORIGIN_DENIED',{status});}};
  const result=await collectXml(h.repo,client,h.options);assert.equal(result.stop_json,status!==403);assert.equal(h.repo.calls.at(-1).args.p_blocked,status===403);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(keyFor('55')+'|source_id|synthetic-token'));
 }
 const h=harness();h.repo.rpc=async()=>({items:[null]});assert.equal((await collectXml(h.repo,{requestsMade:0,remainingRequests:120},h.options)).status,'partial');
});
test('scheduler XML flag defaults off; partial XML or an isolated failure preserves JSON checkpoint work',async()=>{
 const env={ORIGIN_ENABLED: 'true', ORIGIN_API_ORIGIN: 'https://api.provider.example', SYNC_ENABLED: 'true',SYNC_START_DATE:'2024-01-01'};
 for(const behavior of['disabled','403','throw','401']){
  const commits=[],claims=[];const repo={async claim(resource){claims.push(resource);return{acquired:true,lease_token:randomUUID(),checkpoint:{},checkpoint_version:0};},async renew(){},async release(){},async apply(...args){commits.push(args);return{checkpoint_version:1};}};
  let xmlCalls=0;class Client{requestsMade=0;remainingRequests=120;async get(){this.requestsMade++;this.remainingRequests--;return[];}}
  const result=await runSync(repo,{...env,...(behavior==='disabled'?{}:{XML_SYNC_ENABLED:'true'})},{getToken:async()=>'synthetic-token',Client,resources:[getResource('contacts')],xmlCollector:async()=>{
   xmlCalls++;if(behavior==='throw')throw new Error('contains private key and URL');
   return{status:'partial',keys:0,files:0,unchanged:0,requests:0,errors:[{code:'ORIGIN_DENIED'}],stop_json:behavior==='401'};
  }});
  assert.equal(xmlCalls,behavior==='disabled'?0:1);assert.equal(commits.filter(c=>c[0]==='contacts').length,behavior==='401'?0:2);
  assert.equal(commits.at(-1)[0],'__scheduler__');assert.equal(claims[0],'__scheduler__');assert.doesNotMatch(JSON.stringify(result),/private key|https|synthetic-token/);
 }
});
