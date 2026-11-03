import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:https';
import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {createReviewedAuthorizationTransport} from '../src/operational-transport.mjs';
import {operationalFixture,hash} from './operational-fixtures.mjs';
import {reviewedAuthorizationBinding} from '../src/authorization-soap-binding.mjs';

test('opt-in complete55/65 service uses real loopback mTLS + XSD; restart recovers without another socket',{skip:process.env.BRUFAP_AUTHORIZATION_MTLS_TEST!=='1',timeout:60000},async()=>{
 const client=await trustFixture();
 try{for(const model of ['55','65']){
  const hostname=new URL(reviewedAuthorizationBinding(model).endpoint).hostname,serverCert=await trustFixture({eku:['1.3.6.1.5.5.7.3.1'],dns:hostname}),f=await operationalFixture({model,credential:client.leaf});
  const key=c=>c.privateKey.export({format:'pem',type:'pkcs8'}),cert=c=>c.leaf.certificate+'\n'+c.intermediate.certificate;
  let posts=0;const sockets=new Set(),server=createServer({key:key(serverCert.leaf),cert:cert(serverCert),ca:[client.root.certificate],requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3'},(req,res)=>{
   posts++;assert.equal(req.socket.authorized,true);assert.equal(req.socket.getPeerCertificate().fingerprint256,new X509Certificate(client.leaf.certificate).fingerprint256);assert.equal(req.method,'POST');assert.equal(req.url,new URL(reviewedAuthorizationBinding(model).endpoint).pathname);assert.equal(req.headers.host,hostname);assert.match(req.headers['content-type'],/action="http:\/\//);assert.equal(req.headers.soapaction,undefined);
   const parts=[];req.on('data',b=>parts.push(b));req.on('end',()=>{assert.equal(hash(Buffer.concat(parts)),f.state.known.context.request_hash);assert.equal(f.state.used,1);res.writeHead(200,{'Content-Type':'application/soap+xml; charset=utf-8'});res.end(f.soapResponse());});
  });server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.on('tlsClientError',()=>{});
  const secureContext=createSecureContext({key:key(client.leaf),cert:cert(client),ca:[serverCert.root.certificate],minVersion:'TLSv1.2'}),anchor=hash(serverCert.root.certificateDer),trusted=new WeakSet([secureContext]);
  const driver=(options,callback)=>{assert.equal(options.hostname,hostname);assert.equal(options.port,443);assert.equal(options.servername,hostname);assert.equal(options.rejectUnauthorized,true);return request({...options,hostname:'127.0.0.1',port:server.address().port},callback);};
  const transport=createReviewedAuthorizationTransport({requestImpl:driver,serverTrustAnchorSha256:anchor,attestServerContext:c=>{assert.ok(trusted.has(c));return{server_trust_profile:'synthetic-mtls-v1',server_trust_anchor_sha256:anchor};}});
  const custody=async(v,action,o)=>{f.calls.custody.push(v);await action({secureContext,metadata:{...f.metadata,client_auth_usage:'explicit_client_auth',presented_chain_links_checked:true},signal:o.signal,deadline:o.deadline});};
  const original=f.ports.validate;let fail=true;const validate=(v,o)=>{if(fail&&v.kind==='response')throw Error('synthetic validator outage after TLS observation');return original(v,o);};
  try{
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const first=await f.service({transport,withPreparedSession:custody,validate}).run(f.input);assert.equal(first.status,'unconfirmed');assert.equal(posts,1);
   fail=false;f.state.current=false;f.state.reviewMissing=true;
   const recovered=await f.service({syntheticDispatchEnabled:false,transport:()=>{throw Error('no second transport');},withPreparedSession:()=>{throw Error('no PFX on recovery');}}).recover({actor:f.input.actor,commandId:f.input.commandId});
   assert.equal(recovered.status,'authorization_observed',JSON.stringify(recovered));assert.equal(recovered.artifact.tls_origin_verified,false);assert.equal(recovered.sefaz_authorized,false);assert.equal(recovered.tax_rules_validated,false);assert.equal(posts,1);assert.equal(f.state.used,1);assert.equal(f.calls.custody.length,1);
  }finally{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();for(const c of Object.values(serverCert).filter(v=>v?.privateDer))c.privateDer.fill(0);}
 }}finally{for(const c of [client.leaf,client.intermediate,client.root])c.privateDer.fill(0);}
});
