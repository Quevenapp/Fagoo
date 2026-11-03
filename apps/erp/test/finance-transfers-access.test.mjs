import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',BASE='/v1/transferencias-internas';
const session={access_token:'synthetic-token',user:{id:uid}},tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
async function setup(role='admin',respond=()=>Response.json({synthetic:true})){
 const calls=[],controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json({user_id:uid,role,resources:[],data_mode:'staging_readonly'});calls.push({url,options});return respond(url,options);});const stop=controller.start();await tick();return{controller,calls,stop};
}
test('053 controller restricts roles, fixed paths and methods before sending requests',async()=>{
 for(const role of ['admin','financeiro','consulta','vendas','estoque','fiscal']){
  const s=await setup(role);try{
   if(['admin','financeiro','consulta'].includes(role)){for(const path of [BASE,BASE+'?limit=25',BASE+'?account_id='+id+'&limit=25&after='+id,BASE+'/'+id,BASE+'/commands/'+id])await s.controller.financeTransfers(path);}
   else await assert.rejects(()=>s.controller.financeTransfers(BASE),status(403));
   if(['admin','financeiro'].includes(role))await s.controller.financeTransfers(BASE,{method:'POST',body:{synthetic:true}});else await assert.rejects(()=>s.controller.financeTransfers(BASE,{method:'POST',body:{synthetic:true}}),status(403));
   for(const {options} of s.calls){assert.equal(options.headers.Authorization,'Bearer synthetic-token');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');}
   assert.equal(s.controller.getSnapshot().synthetic,undefined);
  }finally{s.stop();}
 }
 const s=await setup();try{
  for(const path of ['https://foreign.invalid'+BASE,BASE+'-other',BASE+'/../financeiro',BASE+'/%2fsecret',BASE+'#fragment',BASE+'/commands/'+id+'?token=x',BASE+'/unknown'])await assert.rejects(()=>s.controller.financeTransfers(path),status(400));
  for(const options of [{method:'PATCH'},{method:'DELETE'},{method:'GET',body:{}}])await assert.rejects(()=>s.controller.financeTransfers(BASE,options),status(400));
  await assert.rejects(()=>s.controller.financeTransfers(BASE+'/'+id,{method:'POST',body:{}}),status(400));assert.equal(s.calls.length,0);
 }finally{s.stop();}
});
test('053 controller enforces256KiB response bound and rejects malformed or late readback',async()=>{
 for(const response of [new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(256*1024+1)}}),new Response(JSON.stringify({text:'x'.repeat(256*1024)}),{headers:{'Content-Type':'application/json'}})]){
  const s=await setup('consulta',()=>response);try{await assert.rejects(()=>s.controller.financeTransfers(BASE),status(502));}finally{s.stop();}
 }
 let finish,signal;const s=await setup('admin',(_url,options)=>{signal=options.signal;return new Promise(resolve=>finish=resolve);});
 try{const pending=s.controller.financeTransfers(BASE,{method:'POST',body:{synthetic:true}});await tick();await s.controller.logout();assert.equal(signal.aborted,true);finish(Response.json({synthetic:'late'}));await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(s.controller.getSnapshot().phase,'signed_out');await assert.rejects(()=>s.controller.financeTransfers(BASE),status(403));}finally{s.stop();}
});
