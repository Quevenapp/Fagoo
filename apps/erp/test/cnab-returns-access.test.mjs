import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n,base='/v1/retornos-operacionais';
test('043 controller restricts JSON/download paths and never persists bank data in shared state',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return url.includes('/files/')?new Response('SYNTHETIC CNAB'):Response.json({privateBank:'fixture'});});const stop=c.start();await tick();
 try{
  await c.cnabReturns(base+'/files');const blob=await c.cnabReturnsDownload(base+'/files/'+id+'/download');assert.equal(await blob.text(),'SYNTHETIC CNAB');
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');}
  assert.equal(c.getSnapshot().privateBank,undefined);
  for(const path of ['https://foreign.invalid'+base,base+'-other',base+'/../cnab/profiles',base+'/%2e%2e/cnab'])await assert.rejects(()=>c.cnabReturns(path),status(400));
  for(const path of ['/v1/cnab/files/remittance/'+id,base+'/files/return/'+id,base+'/files/'+id+'/download'+'?token=x'])await assert.rejects(()=>c.cnabReturnsDownload(path),status(400));
  assert.equal(calls.length,2);
 }finally{stop();}
});
test('043 controller aborts download on logout and refuses oversized archives',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.cnabReturnsDownload(base+'/files/'+id+'/download');await tick();await c.logout();assert.equal(signal.aborted,true);finish(new Response('late private bytes'));await assert.rejects(pending,e=>e.name==='AbortError');stop();
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('x',{headers:{'Content-Length':'4020001'}}));const end=bounded.start();await tick();
 try{await assert.rejects(()=>bounded.cnabReturnsDownload(base+'/files/'+id+'/download'),status(502));}finally{end();}
});
