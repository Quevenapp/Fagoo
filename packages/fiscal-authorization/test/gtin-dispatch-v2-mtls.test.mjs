import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:https';
import {createSecureContext,rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {createAuthorizationDispatchTransport} from '../src/dispatch-transport.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {reviewedAuthorizationBinding} from '../src/authorization-soap-binding.mjs';
import {hash} from './dispatch-fixture.mjs';
import {gtinDispatchFixture} from './gtin-dispatch-v2-fixture.mjs';
import {SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';

test('opt-in077 GTINv2 SQL/RPC→encrypted041→OpenSSL→real loopback mTLS→XSD; disabled restart recovers with zero new sockets',{skip:process.env.BRUFAP_AUTHORIZATION_MTLS_TEST!=='1',timeout:60000},async()=>{
 for(const model of ['55','65']){
  const binding=reviewedAuthorizationBinding(model),hostname=new URL(binding.endpoint).hostname;
  const client=await trustFixture(),serverCert=await trustFixture({eku:['1.3.6.1.5.5.7.3.1'],dns:hostname});
  const f=await gtinDispatchFixture({certificates:client,createContext(options){
   assert.deepEqual(options.ca.slice(0,-1),rootCertificates);assert.equal(hash(new X509Certificate(options.ca.at(-1)).raw),SP_AUTHORIZATION_ROOT_HASH);
   assert.equal(options.ca.includes(client.root.certificate),false);
   // Trusted TEST seam only: production still requested the pinned official
   // roots. Our local peer uses a generated CA, never a real SEFAZ credential.
   return createSecureContext({...options,ca:[serverCert.root.certificate]});
  }});
  const c=await f.source(model),sockets=new Set();let posts=0,socketCalls=0,batchId;
  const key=x=>x.privateKey.export({format:'pem',type:'pkcs8'}),chain=x=>x.leaf.certificate+'\n'+x.intermediate.certificate;
  const server=createServer({key:key(serverCert.leaf),cert:chain(serverCert),ca:[client.root.certificate],requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3'},(req,res)=>{
   posts++;assert.equal(req.socket.authorized,true);assert.equal(req.socket.getPeerCertificate().fingerprint256,new X509Certificate(client.leaf.certificate).fingerprint256);
   assert.equal(req.method,'POST');assert.equal(req.url,new URL(binding.endpoint).pathname);assert.equal(req.headers.host,hostname);assert.equal(req.headers.soapaction,undefined);
   assert.equal(f.events.filter(n=>n.endsWith('_use')).length,1);const chunks=[];
   req.on('data',b=>chunks.push(b));req.on('end',()=>{const args=f.rpcCalls.find(x=>x.name.endsWith('_prepare')).args;assert.equal(hash(Buffer.concat(chunks)),args.p_request_hash);res.writeHead(200,{'Content-Type':'application/soap+xml; charset=utf-8'});res.end(f.soapResponse(c,batchId));});
  });
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.on('tlsClientError',()=>{});
  const actual=createAuthorizationDispatchTransport({requestImpl:(options,cb)=>{socketCalls++;assert.equal(options.hostname,hostname);assert.equal(options.port,443);assert.equal(options.servername,hostname);assert.equal(options.rejectUnauthorized,true);assert.equal(options.headers['Accept-Encoding'],'identity');return request({...options,hostname:'127.0.0.1',port:server.address().port},cb);}});
  const transport=(v,s,o)=>{batchId=v.grant.batch_id;return actual(v,s,o);};
  try{
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const x=f.compose(c,{transport,validate:(v,o)=>{if(v.kind==='response')throw Error('SYNTHETIC_VALIDATOR_UNAVAILABLE');return f.ports.validate(v,o);}});
   const selected=await f.request(c);const first=await x.service.runReviewed({actor:c.input.actor,request:selected});assert.equal(first.status,'unconfirmed');assert.equal(posts,1);assert.equal(socketCalls,1);
   await f.disable();await f.enable('operational',false);await f.age(c.input.commandId);
   const never=()=>{throw Error('RECOVERY_MUST_NOT_OPEN_OR_TRANSMIT');},before=f.events.length;
   const recovered=await createAuthorizationDispatchService({...x.ports,enabled:false,validate:f.ports.validate,readReview:never,withPreparedSession:never,transport:never}).recover({actor:c.input.actor,commandId:c.input.commandId});
   assert.equal(recovered.status,'authorized_homologation',JSON.stringify(recovered));assert.equal(recovered.artifact.tls_origin_verified,true);assert.equal(recovered.tax_rules_validated,false);assert.equal(recovered.production_authorized,false);assert.equal(recovered.can_emit,false);assert.equal(recovered.can_transmit,false);
   assert.equal(posts,1);assert.equal(socketCalls,1);assert.ok(f.events.slice(before).every(n=>n.endsWith('_command')||n.endsWith('_finish')));assert.ok(f.owned.every(b=>b.every(x=>x===0)));
  }finally{
   for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.close();
   for(const set of [client,serverCert])for(const x of [set.leaf,set.intermediate,set.root])x.privateDer.fill(0);
  }
 }
});
