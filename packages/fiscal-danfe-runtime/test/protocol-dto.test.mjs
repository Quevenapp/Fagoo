import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {route,parsePayload,readBounded,MAX_HTML_BYTES,MAX_RESPONSE_BYTES} from '../src/protocol.mjs';
import {signRuntimeRequest,verifyRuntimeRequest,digest} from '../src/auth.mjs';
import {publicResult,HTML_CSP} from '../src/dto.mjs';
import {fixture,secret,keyId,audience,actor} from './fixtures.mjs';

test('only the canonical GET preview is admitted, with no query, body or alternate action',()=>{
 const id=randomUUID(),prefix='/internal/v1/fiscal-danfe',path=`${prefix}/candidates/${id}/preview`,selected=route(path,'GET');
 assert.equal(selected.candidateId,id);assert.deepEqual(parsePayload(new Uint8Array(),selected),{});
 for(const tail of ['?x=1','#x','/','/download'])assert.throws(()=>route(path+tail,'GET'));
 for(const p of [path.replace(id,id.toUpperCase()),prefix+'/run',prefix+'/candidates/%2e%2e/preview'])assert.throws(()=>route(p,'GET'));
 for(const method of ['POST','PUT','DELETE','HEAD'])assert.throws(()=>route(path,method));
 assert.throws(()=>parsePayload(new TextEncoder().encode('{}'),selected));assert.throws(()=>parsePayload(new Uint8Array(),{action:'run',method:'POST'}));
});
test('HMAC uses its own domain and binds actor/path/time/body without granting one-use execution',async()=>{
 const id=randomUUID(),path=`/internal/v1/fiscal-danfe/candidates/${id}/preview`,now=1792152000000,opts={secretBytes:secret,keyId,audience,actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array()),now};
 const header=await signRuntimeRequest(opts),check={header,secretBytes:secret,keyId,audience,method:'GET',path,now};
 assert.equal((await verifyRuntimeRequest(check)).actor,actor);assert.deepEqual(await verifyRuntimeRequest(check),await verifyRuntimeRequest(check));
 for(const change of [{path:path.replace(id,randomUUID())},{method:'POST'},{audience:'synthetic-signed'},{now:now+60001},{now:now-5001},{keyId:'other'}])await assert.rejects(()=>verifyRuntimeRequest({...check,...change}));
 const [key,encoded]=header.slice('Brufap-Danfe '.length).split('.');
 for(const domain of ['brufap-a1-request-v1','brufap-signed-request-v1','brufap-wsdl-request-v1','brufap-reconciliation-request-v1']){
  const mac=createHmac('sha256',secret).update(`${domain}.${key}.${encoded}`).digest('hex');await assert.rejects(()=>verifyRuntimeRequest({...check,header:`Brufap-Danfe ${key}.${encoded}.${mac}`}));
 }
});
test('HTML projection verifies UTF-8 size/hash, identity, closed flags and inactive HTML',async()=>{
 const f=await fixture();assert.deepEqual(await publicResult(f.dto,{candidateId:f.id}),f.dto);
 for(const change of [{candidate_id:randomUUID()},{authorized:true},{environment:'1'},{html_sha256:'f'.repeat(64)},{html_size_bytes:f.dto.html_size_bytes+1},{source_size_bytes:512001},{page_count:0},{profile:'authorized-danfe'},{credential_id:randomUUID()},{current:{...f.dto.current,lease_id:randomUUID()}}])await assert.rejects(()=>publicResult({...f.dto,...change},{candidateId:f.id}));
 for(const injection of ['<script>alert(1)</script>','<iframe src="https://never.invalid"></iframe>','<a href="https://never.invalid">link</a>','<svg onload="alert(1)"></svg>','<meta http-equiv="refresh" content="0;url=https://never.invalid">','<div style="background:url(https://never.invalid)">test</div>']){
  const html=f.dto.html.replace('</body>',injection+'</body>'),value={...f.dto,html,html_sha256:await digest(new TextEncoder().encode(html)),html_size_bytes:Buffer.byteLength(html)};await assert.rejects(()=>publicResult(value,{candidateId:f.id}));
 }
 const html=f.dto.html.replace(HTML_CSP,"default-src *"),badHash=await digest(new TextEncoder().encode(html));await assert.rejects(()=>publicResult({...f.dto,html,html_sha256:badHash,html_size_bytes:Buffer.byteLength(html)},{candidateId:f.id}));
 await assert.rejects(()=>publicResult({...f.dto,html:'x'.repeat(MAX_HTML_BYTES+1)},{candidateId:f.id}));assert.equal(MAX_RESPONSE_BYTES,8*1024*1024);
 const mutable=structuredClone(f.dto),pending=publicResult(mutable,{candidateId:f.id});mutable.html='PRIVATE_DIAGNOSTIC';mutable.current.basis_changed=true;assert.deepEqual(await pending,f.dto);
});
test('bounded readers cancel stalled bodies, reject size/encoding and honor pre-abort',async()=>{
 let cancelled=false;await assert.rejects(()=>readBounded(new Response(new ReadableStream({cancel(){cancelled=true;}})),{limit:100,deadline:Date.now()+10}));assert.equal(cancelled,true);
 for(const headers of [{'content-length':'101'},{'content-length':'2'},{'content-encoding':'gzip'}])await assert.rejects(()=>readBounded(new Response('x',{headers}),{limit:100,deadline:Date.now()+1000}));
 const a=new AbortController();a.abort();await assert.rejects(()=>readBounded(new Response('x'),{limit:100,deadline:Date.now()+1000,signal:a.signal}));
});
