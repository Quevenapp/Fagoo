import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController} from '../src/lib/real-access.ts';import {backupFixture} from './helpers/backup-import-fixture.mjs';
const actor='b0000000-0000-4000-8000-000000000001',other='b0000000-0000-4000-8000-000000000002',tick=()=>new Promise(r=>setTimeout(r,0));
function setup({role='admin',before=async()=>{}}={}){const fixture=backupFixture(),calls=[];let emit,gate,currentRole=role,currentActor=actor;
 const auth={getSession:async()=>({data:{session:{access_token:'synthetic-backup',user:{id:actor}}},error:null}),onAuthStateChange:fn=>(emit=fn,{data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
 const controller=createAccessController(auth,'https://api.synthetic.test',async(url,options)=>{if(url.endsWith('/me')){if(gate)await gate;return Response.json({user_id:currentActor,role:currentRole,resources:[],data_mode:'staging_readonly'});}calls.push({url,...options});await before(options);const result=await fixture.request(new URL(url).pathname,options);return url.endsWith('/finish')?new Response('event: result\ndata: '+JSON.stringify(result)+'\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json(result);});
 return{controller,calls,fixture,refresh(role,wait){currentRole=role;gate=wait;emit('TOKEN_REFRESHED',{access_token:'renewed-backup',user:{id:currentActor}});},changeActor(){currentActor=other;emit('SIGNED_IN',{access_token:'other-backup',user:{id:other}});}};
}
test('backup port is admin-only and rejects unknown routes/verbs/body before network',async()=>{
 for(const role of ['consulta','financeiro','fiscal','vendas','estoque']){const f=setup({role}),stop=f.controller.start();await tick();await assert.rejects(()=>f.controller.backupImport('/v1/backup-import/capabilities'),e=>e.status===403);assert.equal(f.calls.length,0);stop();}
 const f=setup(),stop=f.controller.start();await tick();try{for(const [path,o]of [['https://evil.test',{}],['/v1/backup-import/begin',{method:'PUT'}],['/v1/backup-import/begin',{method:'POST',body:new Blob()}],['/v1/backup-import/capabilities',{method:'POST'}],['/v1/backup-import/finish',{method:'POST',onProgress:'not-function'}]])await assert.rejects(()=>f.controller.backupImport(path,o),e=>e.status===400);assert.equal(f.calls.length,0);}finally{stop();}
});
test('same actor token refresh revalidates admin before dispatch and captures immutable request options',async()=>{
 for(const nextRole of ['admin','consulta']){const f=setup(),stop=f.controller.start();await tick();try{let release;const gate=new Promise(r=>release=r);f.refresh(nextRole,gate);const body=new Blob(['exact bytes']),o={method:'PUT',body,manifestHash:f.fixture.capabilities.manifest_sha256},path='/v1/backup-import/'+f.fixture.capabilities.objects[0].key,p=f.controller.backupImport(path,o);o.method='POST';o.body=new Blob(['changed']);release();
  if(nextRole==='consulta'){await assert.rejects(p,e=>e.status===403);assert.equal(f.calls.length,0);}else{await p;assert.equal(f.calls.length,1);const c=f.calls[0];assert.equal(c.method,'PUT');assert.equal(c.headers['X-Backup-Manifest'],f.fixture.capabilities.manifest_sha256);assert.equal(c.body,body);assert.equal(await c.body.text(),'exact bytes');assert.equal(c.headers.Authorization,'Bearer renewed-backup');assert.equal(c.credentials,'omit');assert.equal(c.redirect,'error');assert.equal(c.cache,'no-store');assert.equal(c.referrerPolicy,'no-referrer');}
 }finally{stop();}}
});
test('actor changes and cancellation abort pending upload and discard late responses',async()=>{
 for(const kind of ['actor','cancel']){let release;const gate=new Promise(r=>release=r),f=setup({before:()=>gate}),stop=f.controller.start();await tick();try{const a=new AbortController(),p=f.controller.backupImport('/v1/backup-import/capabilities',{signal:a.signal});await tick();if(kind==='actor')f.changeActor();else a.abort();assert.equal(f.calls[0].signal.aborted,true);release();await assert.rejects(p,e=>e.name==='AbortError');assert.doesNotMatch(JSON.stringify(f.controller.getSnapshot()),/manifest_sha256|synthetic-backup|opaque original/);}finally{release();stop();}}
});
test('finish waits for refreshed JWT and rejects an unpinned mutation before dispatch',async()=>{
 const f=setup(),stop=f.controller.start();await tick();try{
  for(const manifestHash of [undefined,'invalid'])await assert.rejects(()=>f.controller.backupImport('/v1/backup-import/begin',{method:'POST',manifestHash}),e=>e.status===400);
  assert.equal(f.calls.length,0);let release;const gate=new Promise(r=>release=r);f.refresh('admin',gate);
  const promise=f.controller.backupImport('/v1/backup-import/finish',{method:'POST',manifestHash:f.fixture.capabilities.manifest_sha256});await tick();assert.equal(f.calls.length,0);release();
  assert.deepEqual(await promise,f.fixture.result);assert.equal(f.calls[0].headers.Authorization,'Bearer renewed-backup');assert.equal(f.calls[0].headers['X-Backup-Manifest'],f.fixture.capabilities.manifest_sha256);
 }finally{stop();}
});
