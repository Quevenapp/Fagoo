import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';

const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001';
const session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'fiscal',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n,base='/v1/numeracao-fiscal';

test('046 controller confines routes, methods and cursors to fiscal numbering',async()=>{
 const calls=[];
 const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{
  if(url.endsWith('/me'))return Response.json(me);
  calls.push({url,options});return Response.json({privateReceipt:'synthetic'});
 });const stop=c.start();await tick();
 try{
  for(const path of [base+'/series',base+'/series?model=55&limit=25&after='+id,...['reservations','drafts','commands'].map(kind=>`${base}/${kind}/${id}`)])await c.fiscalNumbering(path);
  for(const kind of ['series','reservations'])await c.fiscalNumbering(`${base}/${kind}`,{method:'POST',body:{fixture:true}});
  assert.equal(calls.length,7);
  for(const {options} of calls){assert.equal(options.headers.Authorization,'Bearer synthetic-token');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');}
  assert.equal(c.getSnapshot().privateReceipt,undefined);
  for(const path of ['https://foreign.invalid'+base,base+'-other/series',base+'/series/../series',base+'/%2e%2e/series',base+'/series#fragment',base+'/dispatch',base+'/series?actor='+uid,base+'/series?model=55&model=65',base+'/series?model=57',base+'/series?limit=26',base+'/series?limit=01',base+'/series?after=invalid',`${base}/commands/${id}?token=x`])await assert.rejects(()=>c.fiscalNumbering(path),status(400));
  for(const options of [{method:'PATCH'},{method:'POST'},{method:'GET',body:{}},{method:'DELETE'}])await assert.rejects(()=>c.fiscalNumbering(base+'/series',options),status(400));
  assert.equal(calls.length,7);
 }finally{stop();}
});

test('046 controller bounds responses and rechecks membership after forbidden access',async()=>{
 let checks=0;
 const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'fiscal':'vendas'}):Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}));const stop=c.start();await tick();
 try{await assert.rejects(()=>c.fiscalNumbering(base+'/series'),status(403));await tick();assert.equal(c.getSnapshot().membership.role,'vendas');assert.equal(checks,2);}finally{stop();}
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(128*1024+1)}}));const end=bounded.start();await tick();
 try{await assert.rejects(()=>bounded.fiscalNumbering(base+'/series'),status(502));}finally{end();}
});

test('046 controller rejects late mutation replies after logout and propagates cancellation',async()=>{
 let finish,signal;
 const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.fiscalNumbering(base+'/series',{method:'POST',body:{}});await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({privateReceipt:'late'}));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
