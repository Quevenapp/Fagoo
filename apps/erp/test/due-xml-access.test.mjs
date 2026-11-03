import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const id='b0000000-0000-4000-8000-000000000001',uid='a0000000-0000-4000-8000-000000000001';
const session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('report and XML ports accept only own GET paths and private download IDs',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{
  if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return url.endsWith('/download')?new Response('synthetic-xml'):Response.json({ok:true});
 });const stop=c.start();await tick();
 try{
  await c.dueReport('/v1/relatorios/vencimentos?from=2026-10-16&to=2026-10-16');
  await c.syncedXml('/v1/xmls-sincronizados?model=65');
  assert.equal(await (await c.syncedXmlDownload(`/v1/xmls-sincronizados/${id}/download`)).text(),'synthetic-xml');
  for(const method of ['POST','PATCH','PUT','DELETE'])for(const [port,path] of [['dueReport','/v1/relatorios/vencimentos'],['syncedXml','/v1/xmls-sincronizados']])await assert.rejects(()=>c[port](path,{method}),e=>e instanceof AccessError&&e.status===400);
  await assert.rejects(()=>c.dueReport('/v1/relatorios/vencimentos',{body:{}}));
  await assert.rejects(()=>c.syncedXml('/v1/xmls-sincronizados/../cnab'));
  for(const path of [`https://other.invalid/v1/xmls-sincronizados/${id}/download`,`/v1/history/${id}/download`,`/v1/xmls-sincronizados/${id}/download?token=x`])await assert.rejects(()=>c.syncedXmlDownload(path));
  assert.equal(calls.length,3);for(const call of calls){assert.equal(call.options.method,'GET');assert.equal(call.options.headers.Authorization,'Bearer synthetic-token');assert.equal(call.options.credentials,'omit');}
 }finally{stop();}
});
test('logout cancels archive bytes and discards a late response',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>finish=resolve);});const stop=c.start();await tick();
 const pending=c.syncedXmlDownload(`/v1/xmls-sincronizados/${id}/download`);await tick();await c.logout();assert.equal(signal.aborted,true);finish(new Response('late-private-bytes'));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
