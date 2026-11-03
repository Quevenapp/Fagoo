import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createFiscalDanfeClient,DanfeClientError,DANFE_BASE} from '../src/lib/fiscal-danfe-client.ts';
import {AccessError} from '../src/lib/real-access.ts';
import {fixture,actor} from '../../../packages/fiscal-danfe-runtime/test/fixtures.mjs';
import {MAX_HTML_BYTES,MAX_RESPONSE_BYTES} from '../../../packages/fiscal-danfe-runtime/src/protocol.mjs';

const f55=await fixture(),f65=await fixture({model:'65'}),origin='https://danfe.synthetic.invalid';
const path=`${DANFE_BASE}/candidates/${f55.id}/preview`,token='synthetic-session-token-123456789';
const ready=(role='fiscal')=>({phase:'ready',membership:{user_id:actor,role}}),copy=structuredClone;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const json=(value,init={})=>Response.json(value,init),bad=e=>e instanceof DanfeClientError&&e instanceof AccessError&&e.status>=500&&!String(e).includes('SYNTHETIC_PRIVATE');
function setup(fetcher=async()=>json(f55.dto),getToken=()=>token){
 let state=ready(),epoch=0;const calls=[];
 const client=createFiscalDanfeClient({origin,getToken,getSnapshot:()=>state,getEpoch:()=>epoch,fetchImpl:async(...args)=>{calls.push(args);return fetcher(...args);}});
 return{client,calls,set state(v){state=v;},advance(){epoch++;}};
}
const send=(f,o={})=>f.client(path,o);
test('DANFE client awaits the real renderer DTO hash for both models and performs only explicit GETs',async()=>{
 for(const dto of [f55.dto,f65.dto]){
  const p=setup(async()=>json(dto));assert.equal(p.calls.length,0);const out=await send(p);assert.deepEqual(out,dto);assert.equal(Object.isFrozen(out),true);
  assert.equal(out.authorized,false);assert.equal(out.can_transmit,false);assert.match(out.html,/SEM VALOR FISCAL/);assert.match(out.html,/NÃO AUTORIZADA/);
  assert.equal(p.calls.length,1);const[url,o]=p.calls[0];assert.equal(url,origin+path);assert.equal(o.method,'GET');assert.equal(o.body,undefined);assert.equal(o.headers.Authorization,`Bearer ${token}`);
  assert.equal(o.redirect,'manual');assert.equal(o.cache,'no-store');assert.equal(o.credentials,'omit');assert.equal(o.signal.aborted,true);
 }
});
test('DANFE route, role, token and descriptor validation reject before dispatch; no body or other method is accepted',async()=>{
 const p=setup();for(const route of [path+'?download=1',path+'#x',path+'/',path.replace('/preview','/run'),path.replace('/preview','/%70review'),'https://evil.invalid'+path,path.replace(f55.id,f55.id.toUpperCase())])await assert.rejects(p.client(route),e=>e.status===400);
 for(const o of [{method:'POST'},{method:'PATCH'},{body:undefined},{body:{}},{signal:{}},{download:true}])await assert.rejects(send(p,o),e=>e.status===400);
 let touched=false;await assert.rejects(send(p,Object.defineProperty({},'signal',{enumerable:true,get(){touched=true;return undefined;}})),e=>e.status===400);assert.equal(touched,false);
 for(const state of [{phase:'signed_out',membership:null},ready('consulta'),ready('financeiro'),ready('vendas'),ready('estoque')]){p.state=state;await assert.rejects(send(p),e=>[401,403].includes(e.status));}assert.equal(p.calls.length,0);
 for(const value of [null,'short','SYNTHETIC_PRIVATE\nheader']){const q=setup(undefined,()=>value);await assert.rejects(send(q),e=>e.status===401);assert.equal(q.calls.length,0);}
 for(const url of ['http://gateway.invalid','https://gateway.invalid/','https://u:p@gateway.invalid','https://gateway.invalid/x'])assert.throws(()=>createFiscalDanfeClient({origin:url,getToken:()=>token,getSnapshot:ready}));
});
test('DANFE snapshots original signal before token await and never sends after cancellation or session change',async()=>{
 const tokenGate=gate(),p=setup(undefined,()=>tokenGate.promise),abort=new AbortController(),options={method:'GET',signal:abort.signal};
 const pending=send(p,options);options.method='POST';options.signal=new AbortController().signal;const rejected=assert.rejects(pending,e=>e.name==='AbortError');abort.abort();await rejected;
 tokenGate.resolve(token);await tick();assert.equal(p.calls.length,0);
 const late=gate(),q=setup(undefined,()=>late.promise),request=send(q);q.advance();late.resolve(token);await assert.rejects(request,e=>e.name==='AbortError');assert.equal(q.calls.length,0);
});
test('DANFE late HTTP/body and asynchronous digest results are discarded after logout, actor or permission change',async t=>{
 for(const change of [p=>p.state={phase:'signed_out',membership:null},p=>p.state={...ready(),membership:{user_id:f55.id,role:'fiscal'}},p=>p.state=ready('consulta')]){
  const http=gate(),entered=gate(),p=setup(()=>{entered.resolve();return http.promise;}),request=send(p);await entered.promise;change(p);let cancelled=false;
  http.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await assert.rejects(request,e=>e.name==='AbortError');await tick();assert.equal(cancelled,true);assert.equal(p.calls.length,1);
 }
 const entered=gate(),release=gate(),original=crypto.subtle.digest.bind(crypto.subtle);
 t.mock.method(crypto.subtle,'digest',(...args)=>{entered.resolve();return release.promise.then(()=>original(...args));});
 const p=setup(),request=send(p);await entered.promise;p.advance();release.resolve();await assert.rejects(request,e=>e.name==='AbortError');assert.equal(p.calls.length,1);
});
test('DANFE validates candidate, UTF8 size, content hash and safe HTML rather than trusting a success status',async()=>{
 const altered=[];
 for(const change of [v=>v.candidate_id=actor,v=>v.html_sha256='0'.repeat(64),v=>v.html_size_bytes--,v=>v.source_size_bytes=512001,v=>v.authorized=true,v=>{v.current.artifact_current=true;v.current.a1_changed=true;},v=>v.credential_id=actor,v=>v.html='x'.repeat(MAX_HTML_BYTES+1)]){const v=copy(f55.dto);change(v);altered.push(v);}
 const injected=copy(f55.dto);injected.html=injected.html.replace('</body>','<script>SYNTHETIC_PRIVATE</script></body>');injected.html_size_bytes=Buffer.byteLength(injected.html);injected.html_sha256=createHash('sha256').update(injected.html).digest('hex');altered.push(injected);
 for(const value of altered){const p=setup(async()=>json(value));await assert.rejects(send(p),e=>bad(e)&&e.status===502);assert.equal(p.calls.length,1);}
});
test('DANFE 401/403 and other closed read errors retain status; malformed errors and IO never trigger another GET',async()=>{
 for(const [status,error]of [[401,'DANFE_UNAUTHENTICATED'],[403,'DANFE_FORBIDDEN'],[404,'DANFE_NOT_FOUND'],[409,'DANFE_NOT_STORED']]){
  const p=setup(async()=>json({error,recovery_required:false},{status}));await assert.rejects(send(p),e=>e instanceof DanfeClientError&&e.status===status&&e.code===error);assert.equal(p.calls.length,1);
 }
 for(const value of [{error:'SYNTHETIC_PRIVATE',recovery_required:false},{error:'DANFE_FORBIDDEN',recovery_required:true},{error:'DANFE_FORBIDDEN',recovery_required:false,trace:'SYNTHETIC_PRIVATE'}]){
  const p=setup(async()=>json(value,{status:403}));await assert.rejects(send(p),bad);assert.equal(p.calls.length,1);
 }
 const p=setup(()=>{throw Error('SYNTHETIC_PRIVATE');});await assert.rejects(send(p),bad);assert.equal(p.calls.length,1);
});
test('DANFE refuses redirects, wrong effective URL/MIME, malformed UTF8 and bounded encoded/decoded lengths',async()=>{
 const wrong=json(f55.dto);Object.defineProperty(wrong,'url',{value:'https://other.invalid/'});
 const responses=[new Response(null,{status:302,headers:{location:'https://other.invalid'}}),wrong,new Response('SYNTHETIC_PRIVATE',{headers:{'content-type':'text/html'}}),
  json(f55.dto,{headers:{'content-length':'1'}}),json(f55.dto,{headers:{'content-length':String(MAX_RESPONSE_BYTES+1)}}),json(f55.dto,{headers:{'content-encoding':'unknown'}}),
  new Response(new Uint8Array([0xc0,0xaf]),{headers:{'content-type':'application/json'}}),new Response('x'.repeat(MAX_RESPONSE_BYTES+1),{headers:{'content-type':'application/json'}}),
  json({error:'DANFE_FORBIDDEN',recovery_required:false,padding:'x'.repeat(8192)},{status:403})];
 for(const r of responses){const p=setup(async()=>r);await assert.rejects(send(p),bad);assert.equal(p.calls.length,1);}
 // Browser fetch already decompressed the payload; count decoded bytes and verify HTML hash.
 const p=setup(async()=>json(f55.dto,{headers:{'content-encoding':'br','content-length':'80'}}));assert.equal((await send(p)).html_sha256,f55.dto.html_sha256);
});
test('DANFE total deadline cancels stalled fetch/body and late bodies without retries',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const mode of ['fetch','body']){
  const entered=gate(),late=gate();let cancelled=false;
  const p=setup((url,o)=>{entered.resolve(o.signal);return mode==='fetch'?late.promise:new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});});
  const request=send(p),signal=await entered.promise;await tick();t.mock.timers.tick(65000);await assert.rejects(request,e=>e.status===504);assert.equal(signal.aborted,true);
  if(mode==='fetch')late.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
  await tick();assert.equal(cancelled,true);assert.equal(p.calls.length,1);
 }
 t.mock.timers.reset();
});
