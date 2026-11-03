// Synthetic HTTPS driver and real PKCS12/TLS context loader. Never a network call.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {createSecureContext} from 'node:tls';
import {receiptFixture} from './receipt-fixtures.mjs';import {preparedFixture} from './receipt-query-port-fixture.mjs';
import {createReceiptQueryTransport} from '../src/receipt-query-transport.mjs';
import {createSpReceiptQueryTlsLoader,requireReceiptQueryServerContext} from '../src/receipt-query-server-trust.mjs';
import {createSpAuthorizationTlsLoader} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';import {binary,exportPfx,PASSWORD,HOLDER} from '../../fiscal-vault/test/fixtures.mjs';import {hash} from '../src/service-common.mjs';
let f,client,pfx,loader,legacy;
test.before(async()=>{f=await receiptFixture();client=await trustFixture();pfx=await exportPfx(client.leaf,[client.intermediate,client.root]);loader=await createSpReceiptQueryTlsLoader({binaryPath:binary});legacy=await createSpAuthorizationTlsLoader({binaryPath:binary});});
test.after(()=>{f?.close();pfx?.fill(0);for(const c of Object.values(client??{}))c.privateDer?.fill(0);});
const input=(deadline,purpose='sp-receipt-query-homologation-v1')=>({pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:HOLDER,expectedFingerprint:hash(client.leaf.certificateDer),purpose,now:new Date(),deadline});
function driver(options={}){const calls=[],writes=[];const requestImpl=(configuration,onResponse)=>{
 calls.push(configuration);const req=new EventEmitter(),socket=new EventEmitter();req.destroy=()=>{};socket.destroy=()=>{};socket.encrypted=true;socket.authorized=options.authorized??true;socket.getProtocol=()=>options.protocol??'TLSv1.2';
 req.end=body=>{writes.push(Buffer.from(body));const res=new EventEmitter();res.destroy=()=>{};res.statusCode=options.status??200;res.headers=options.headers??{'content-type':'application/soap+xml','content-length':'4'};res.rawHeaders=options.rawHeaders??Object.entries(res.headers).flat();res.complete=options.complete??true;onResponse(res);queueMicrotask(()=>{res.emit('data',options.bytes??Buffer.from('TEST'));res.emit('end');});};
 queueMicrotask(()=>{req.emit('socket',socket);if(options.delay)setTimeout(()=>socket.emit('secureConnect'),options.delay);else queueMicrotask(()=>socket.emit('secureConnect'));});return req;
 };return{requestImpl,calls,writes};}
async function run(x,d,fn){const deadline=Date.now()+10000;await loader.withContext(input(deadline),async session=>{await fn(createReceiptQueryTransport({requestImpl:d.requestImpl}),session,{signal:new AbortController().signal,deadline});});}
test('55/65 fixed receipt endpoint and exact bytes require successful089 grant; only one end per nonce',async()=>{
 for(const model of ['55','65']){const x=await preparedFixture(f,{certificate_fingerprint:hash(client.leaf.certificateDer)},model),d=driver();try{await run(x,d,async(t,s,o)=>{const r=await t({request:x.soap,used:x.used},s,o);assert.equal(await r.response.text(),'TEST');assert.equal(r.tls.server_identity_verified,true);await assert.rejects(t({request:x.soap,used:x.used},s,o));});assert.equal(d.calls.length,1);assert.equal(d.writes.length,1);assert.equal(hash(d.writes[0]),x.used.grant.request_hash);assert.equal(d.calls[0].hostname,new URL(x.soap.endpoint).hostname);assert.equal(d.calls[0].method,'POST');assert.equal(d.calls[0].rejectUnauthorized,true);assert.equal(d.calls[0].maxHeaderSize,8192);}finally{x.close();}}
});
test('unattested contexts, legacy authorization contexts, changed grant and forged SOAP fail before driver',async()=>{
 const x=await preparedFixture(f,{certificate_fingerprint:hash(client.leaf.certificateDer)});try{
  for(const mutate of [(v,s)=>s.secureContext=createSecureContext(),v=>v.used.grant.request_hash='0'.repeat(64),v=>v.used.grant.purpose='sp-authorization-homologation-v1',v=>v.request={...v.request},v=>v.used.grant.source_binding_hash='not-a-hash']){const d=driver();await run(x,d,async(t,session,o)=>{const v={request:x.soap,used:structuredClone(x.used)},s={...session};mutate(v,s);await assert.rejects(t(v,s,o));});assert.equal(d.calls.length,0);}
  const d=driver(),deadline=Date.now()+10000;await legacy.withContext(input(deadline,'sp-authorization-homologation-v1'),async session=>{assert.throws(()=>requireReceiptQueryServerContext(session.secureContext,hash(client.leaf.certificateDer)));await assert.rejects(createReceiptQueryTransport({requestImpl:d.requestImpl})({request:x.soap,used:x.used},session,{signal:new AbortController().signal,deadline}));});assert.equal(d.calls.length,0);
 }finally{x.close();}
});
test('TLS failure/deadline before handshake yields zero request bodies',async()=>{
 const x=await preparedFixture(f,{certificate_fingerprint:hash(client.leaf.certificateDer)});try{for(const options of [{authorized:false},{protocol:'TLSv1.1'},{delay:60}]){const d=driver(options);await run(x,d,async(t,s,o)=>{await assert.rejects(t({request:x.soap,used:x.used},s,{...o,deadline:options.delay?Date.now()+20:o.deadline}));});assert.equal(d.writes.length,0);}}finally{x.close();}
});
test('redirect, duplicate headers, invalid MIME, overflow and truncated replies never return an attested body',async()=>{
 const x=await preparedFixture(f,{certificate_fingerprint:hash(client.leaf.certificateDer)});try{for(const options of [{status:302},{headers:{'content-type':'text/plain'}},{rawHeaders:['content-type','application/soap+xml','content-type','application/soap+xml']},{headers:{'content-type':'application/soap+xml'},bytes:Buffer.alloc(512001)},{complete:false},{bytes:Buffer.alloc(0)}]){const d=driver(options);await run(x,d,async(t,s,o)=>{await assert.rejects(t({request:x.soap,used:x.used},s,o));});assert.equal(d.writes.length,1);}}finally{x.close();}
});
