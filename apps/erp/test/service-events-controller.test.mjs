import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const actor='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',event='c0000000-0000-4000-8000-000000000001',base=`/v1/ordens-servico/${id}/eventos`;
const session={access_token:'synthetic-token',user:{id:actor}},me={user_id:actor,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('049 controller only dispatches exact event routes, methods, pagination and bounded JSON',async()=>{
 const calls=[],c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({synthetic:true});}),stop=c.start();await tick();
 try{
  for(const path of[base,base+'?limit=25&before=9999999999',base+'/'+event])await c.serviceEvents(path);
  await c.serviceEvents(base,{method:'POST',body:{fixture:true}});assert.equal(calls.length,4);
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');}
  for(const path of['https://foreign.invalid'+base,base.replace('ordens-servico','ordens-servico-other'),base+'/../'+event,base+'#x',base+'/journal',base+'?actor=x',base+'?limit=0',base+'?limit=01',base+'?limit=26',base+'?limit=2&limit=2',base+'?before=0',base+'?before=01',base+'?before=10000000000',base+'/'+event+'?limit=1',base.replace(id,'%2f'+id)])await assert.rejects(()=>c.serviceEvents(path),status(400));
  for(const [path,options]of[[base,{method:'POST'}],[base+'?limit=1',{method:'POST',body:{}}],[base+'/'+event,{method:'POST',body:{}}],[base,{method:'PATCH',body:{}}],[base,{body:{}}]])await assert.rejects(()=>c.serviceEvents(path,options),status(400));
  await assert.rejects(()=>c.serviceEvents(base,{method:'POST',body:{text:'x'.repeat(64*1024)}}),status(413));const circular={};circular.self=circular;await assert.rejects(()=>c.serviceEvents(base,{method:'POST',body:circular}),status(400));assert.equal(calls.length,4);
 }finally{stop();}
});
test('049 controller enforces read/write roles and limits response to1MiB',async()=>{
 for(const role of ['admin','vendas','financeiro','consulta','estoque','fiscal']){const calls=[],c=createAccessController(auth,'https://api.example.test',async url=>{if(url.endsWith('/me'))return Response.json({...me,role});calls.push(url);return Response.json({synthetic:true});}),stop=c.start();await tick();try{
  if(['admin','vendas','financeiro','consulta'].includes(role))await c.serviceEvents(base);else await assert.rejects(()=>c.serviceEvents(base),status(403));
  if(['admin','vendas'].includes(role))await c.serviceEvents(base,{method:'POST',body:{}});else await assert.rejects(()=>c.serviceEvents(base,{method:'POST',body:{}}),status(403));
 }finally{stop();}}
 const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(1024*1024+1)}})),stop=c.start();await tick();try{await assert.rejects(()=>c.serviceEvents(base),status(502));}finally{stop();}
});
test('049 controller aborts a pending append on logout and does not accept its late receipt',async()=>{
 let release,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(r=>release=r);}),stop=c.start();await tick();
 const result=c.serviceEvents(base,{method:'POST',body:{fixture:true}});await tick();await c.logout();assert.equal(signal.aborted,true);release(Response.json({late:true}));await assert.rejects(result,e=>e.name==='AbortError');stop();
});
