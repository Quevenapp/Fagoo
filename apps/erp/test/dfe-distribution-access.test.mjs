import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n,base='/v1/notas-recebidas';
test('045 controller limits JSON routes and authenticated downloads without keeping fiscal data in access state',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return url.endsWith('/download')?new Response('SYNTHETIC XML',{headers:{'Content-Type':'application/octet-stream'}}):Response.json({privateFiscal:'fixture'});});const stop=c.start();await tick();
 try{
  await c.dfeDistribution(base+'/settings?environment=2');await c.dfeDistribution(base+'/settings',{method:'POST',body:{fixture:true}});
  const blob=await c.dfeDistributionDownload(base+'/documents/'+id+'/download');assert.equal(await blob.text(),'SYNTHETIC XML');
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');}
  assert.equal(c.getSnapshot().privateFiscal,undefined);
  for(const path of ['https://foreign.invalid'+base,base+'-other',base+'/../cnab/profiles',base+'/%2e%2e/cnab',base+'/dispatch',base+'/documents?channel_id=x#fragment'])await assert.rejects(()=>c.dfeDistribution(path),status(400));
  for(const path of ['/v1/xmls-sincronizados/'+id+'/download',base+'/documents/'+id+'/download?path=x'])await assert.rejects(()=>c.dfeDistributionDownload(path),status(400));
  for(const options of [{method:'PATCH'},{method:'POST'},{method:'GET',body:{}}])await assert.rejects(()=>c.dfeDistribution(base+'/settings?environment=2',options),status(400));
  assert.equal(calls.length,3);
 }finally{stop();}
});
test('045 download refuses wrong MIME and oversized data; logout discards late private bytes',async()=>{
 for(const headers of [{'Content-Type':'text/html'},{'Content-Type':'application/octet-stream','Content-Length':'8388609'}]){
  const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('x',{headers}));const stop=c.start();await tick();
  try{await assert.rejects(()=>c.dfeDistributionDownload(base+'/documents/'+id+'/download'),status(502));}finally{stop();}
 }
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.dfeDistributionDownload(base+'/documents/'+id+'/download');await tick();await c.logout();assert.equal(signal.aborted,true);finish(new Response('late private bytes',{headers:{'Content-Type':'application/octet-stream'}}));await assert.rejects(pending,e=>e.name==='AbortError');stop();
});
