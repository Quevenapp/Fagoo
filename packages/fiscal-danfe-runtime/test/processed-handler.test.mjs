import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {processedFixtures} from './processed-fixtures.mjs';
import {createProcessedSource} from '../src/processed-source.mjs';
import {createProcessedRuntimeHandler} from '../src/processed-handler.mjs';
import {signRuntimeRequest,digest} from '../src/processed-auth.mjs';
import {signRuntimeRequest as signLegacy} from '../src/auth.mjs';
import {decodeProcessedXml,publicProcessedResult,HTML_CSP} from '../src/processed-dto.mjs';
const secret=new Uint8Array(32).fill(12),keyId='synthetic',audience='synthetic-danfe',actor='10000000-0000-4000-8000-000000000001';
let f;test.before(async()=>f=await processedFixtures());test.after(()=>f?.close());
const path=(x,action)=>`/internal/v1/fiscal-danfe/${x.input.sourceKind==='authorization'?'authorizations':'revalidations'}/${x.input.commandId}/${action}`;
async function request(x,action='xml',options={}){const p=path(x,action),header=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor,nonce:'d0000000-0000-4000-8000-000000000001',method:'GET',path:p,bodyHash:await digest(new Uint8Array()),now:Date.now()});return new Request('http://runtime.internal'+p,{headers:{authorization:header},...options});}
const config=x=>({readSource:createProcessedSource(x.ports),render:()=>assert.fail('XML download must not invoke renderer'),transportSecret:secret,transportKeyId:keyId,audience});
test('all four sources download exact nfeProc with final ACL, no layout dependency or mutation',async()=>{
 for(const kind of ['authorization','revalidation'])for(const model of ['55','65']){const x=f.create(model,kind),h=createProcessedRuntimeHandler(config(x));try{const r=await h(await request(x));assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const value=await publicProcessedResult(await r.json(),{sourceKind:kind,commandId:x.input.commandId,action:'xml'});assert.deepEqual(Buffer.from(decodeProcessedXml(value.xml_base64)),Buffer.from(x.processed.processedXml));assert.equal(value.source.model,model);assert.equal(value.tax_rules_validated,false);assert.equal(x.calls.command.length,3);}finally{h.dispose();}}
});
test('authorization and legacy path allowlists reject before source reads',async()=>{
 const x=f.create(),h=createProcessedRuntimeHandler(config(x));try{assert.equal((await h(new Request('http://runtime.internal'+path(x,'xml')))).status,401);const p=`/internal/v1/fiscal-danfe/candidates/${x.record.receipt.candidate_id}/preview`,header=await signLegacy({secretBytes:secret,keyId,audience,actor,nonce:'d0000000-0000-4000-8000-000000000001',method:'GET',path:p,bodyHash:await digest(new Uint8Array())});assert.equal((await h(new Request('http://runtime.internal'+p,{headers:{authorization:header}}))).status,404);assert.equal(x.calls.command.length,0);}finally{h.dispose();}
});
test('last ACL failure after rendering returns only403, not XML or HTML',async()=>{
 const x=f.create(),base=x.ports.authorizationRpc;let n=0;const h=createProcessedRuntimeHandler({...config(x),readSource:createProcessedSource({...x.ports,authorizationRpc:async(...a)=>{if(++n===3)throw Object.assign(Error('PRIVATE'),{code:'42501'});return base(...a);}})});
 try{const r=await h(await request(x)),v=await r.json();assert.equal(r.status,403);assert.deepEqual(v,{error:'DANFE_FORBIDDEN',recovery_required:false});}finally{h.dispose();}
});
test('print projection is separate and sanitized; unsupported layout cannot suppress XML download',async()=>{
 const x=f.create(),html=`<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${HTML_CSP}"><meta name="referrer" content="no-referrer"><title>Teste</title><style>body{color:black}</style></head><body><p>HOMOLOGAÇÃO - SEM VALOR FISCAL</p></body></html>`;
 const h=createProcessedRuntimeHandler({...config(x),render:()=>({html,sha256:createHash('sha256').update(html).digest('hex'),profile:'processed-danfe55-moc7-v1',page_count:1})});try{const r=await h(await request(x,'print'));assert.equal(r.status,200);assert.equal((await r.json()).action,'print');assert.equal(x.calls.command.length,3);}finally{h.dispose();}
 const bad=createProcessedRuntimeHandler({...config(x),render:()=>({html:html.replace('</body>','<script>private()</script></body>'),sha256:'0'.repeat(64),profile:'processed-danfe55-moc7-v1',page_count:1})});try{const r=await bad(await request(x,'print'));assert.equal(r.status,502);assert.equal((await r.json()).html,undefined);assert.equal((await bad(await request(x))).status,200);}finally{bad.dispose();}
});
test('abort fences late source result and subsequent access after dispose',async()=>{
 const x=f.create();let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r),base=createProcessedSource(x.ports),abort=new AbortController();const h=createProcessedRuntimeHandler({...config(x),readSource:async(...args)=>{enter();await hold;return base(...args);}});
 const pending=h(await request(x,'xml',{signal:abort.signal}));await entered;abort.abort();assert.equal((await pending).status,503);release();await new Promise(r=>setImmediate(r));assert.equal(x.calls.read.length,0);h.dispose();assert.equal((await h(await request(x))).status,503);
});
test('public XML DTO rejects corruption, wrong binding and noncanonical base64',async()=>{
 const x=f.create(),h=createProcessedRuntimeHandler(config(x));try{const v=await(await h(await request(x))).json(),b={sourceKind:'authorization',commandId:x.input.commandId,action:'xml'};for(const bad of [{...v,xml_base64:'AAAA'},{...v,filename:'../private.xml'},{...v,source:{...v.source,source_command_id:'f0000000-0000-4000-8000-000000000001'}}])await assert.rejects(publicProcessedResult(bad,b));assert.throws(()=>decodeProcessedXml('YQ='));assert.throws(()=>decodeProcessedXml('YR=='));}finally{h.dispose();}
});
