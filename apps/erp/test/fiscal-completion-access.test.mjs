import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',base='/v1/complemento-fiscal/'+id;
const session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'fiscal',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('047 controller only permits scoped GET/history and explicit preview/save with bounded query values',async()=>{
 const calls=[],c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({fixture:true});}),stop=c.start();await tick();
 try{
  for(const path of[base,base+'?version=1',base+'?version=2147483647',base+'/history',base+'/history?limit=25&before=99'])await c.fiscalCompletion(path);
  for(const suffix of['preview','save'])await c.fiscalCompletion(base+'/'+suffix,{method:'POST',body:{fixture:true}});
  assert.equal(calls.length,7);for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');}
  for(const path of['https://foreign.invalid'+base,base.replace('/complemento-fiscal/','/complemento-fiscal-extra/'),base+'/../'+id,base+'#x',base+'/xml',base+'/reserve',base+'?actor=x',base+'?version=0',base+'?version=01',base+'?version=2147483648',base+'?version=1&version=2',base+'/history?limit=26',base+'/history?version=1',base+'/history?before=1.5'])await assert.rejects(()=>c.fiscalCompletion(path),status(400));
  for(const [path,options]of[[base,{method:'POST',body:{}}],[base+'/preview',{}],[base+'/save',{method:'POST'}],[base+'/save?x=1',{method:'POST',body:{}}],[base,{body:{}}],[base+'/history',{method:'DELETE'}]])await assert.rejects(()=>c.fiscalCompletion(path,options),status(400));
  assert.equal(calls.length,7);
 }finally{stop();}
});
test('047 controller checks role, limits response to2MiB and refreshes membership after403',async()=>{
 const denied=createAccessController(auth,'https://api.example.test',async()=>Response.json({...me,role:'consulta'})),end=denied.start();await tick();try{await assert.rejects(()=>denied.fiscalCompletion(base),status(403));}finally{end();}
 const limited=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(2*1024*1024+1)}})),stop=limited.start();await tick();try{await assert.rejects(()=>limited.fiscalCompletion(base),status(502));}finally{stop();}
 let checks=0;const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'fiscal':'vendas'}):Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403})),finish=c.start();await tick();try{await assert.rejects(()=>c.fiscalCompletion(base),status(403));await tick();assert.equal(c.getSnapshot().membership.role,'vendas');}finally{finish();}
});
test('047 controller aborts mutation on logout and rejects a late private receipt',async()=>{
 let release,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(r=>release=r);}),stop=c.start();await tick();
 const request=c.fiscalCompletion(base+'/save',{method:'POST',body:{fixture:true}});await tick();await c.logout();assert.equal(signal.aborted,true);release(Response.json({receipt:'late'}));await assert.rejects(request,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
