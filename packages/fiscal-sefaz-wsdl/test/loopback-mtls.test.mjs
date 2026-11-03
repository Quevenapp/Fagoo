import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:https';
import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {createWsdlEvidenceClient} from '../src/index.mjs';
import {plan,wsdl} from './fixtures.mjs';

test('opt-in real mTLS stays on loopback and rejects missing client, wrong CA and wrong server hostname',{skip:process.env.BRUFAP_WSDL_LOOPBACK_TEST!=='1',timeout:30000},async()=>{
 const hostname=plan().hostname,[client,serverCert]=await Promise.all([trustFixture(),trustFixture({eku:['1.3.6.1.5.5.7.3.1'],dns:hostname})]);
 const key=c=>c.leaf.privateKey.export({format:'pem',type:'pkcs8'}),cert=c=>c.leaf.certificate+'\n'+c.intermediate.certificate;
 let count=0;const sockets=new Set(),server=createServer({key:key(serverCert),cert:cert(serverCert),ca:[client.root.certificate],requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3'},(req,res)=>{
  count++;assert.equal(req.socket.authorized,true);assert.equal(req.socket.getPeerCertificate().fingerprint256,new X509Certificate(client.leaf.certificate).fingerprint256);assert.equal(req.method,'GET');assert.equal(req.url,plan().path);assert.equal(req.headers.host,hostname);let size=0;req.on('data',b=>size+=b.length);req.on('end',()=>{assert.equal(size,0);res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});res.end(wsdl());});
 });server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.on('tlsClientError',()=>{});
 const driver=(options,callback)=>{assert.ok([hostname,plan('65').hostname].includes(options.hostname));assert.equal(options.port,443);return request({...options,hostname:'127.0.0.1',port:server.address().port},callback);};
 const context=extra=>createSecureContext({key:key(client),cert:cert(client),ca:[serverCert.root.certificate],minVersion:'TLSv1.2',...extra});
 const run=(sc,p=plan())=>createWsdlEvidenceClient({requestImpl:driver,withAuthorizedTlsSession:async(_c,action)=>{await action(sc);}}).obtain(p);
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const result=await run(context());assert.equal(count,1);assert.equal(result.binding_verified,false);assert.equal(result.operation_authorized,false);assert.equal(result.can_emit,false);assert.equal(result.inspection.bindings.length,2);result.bytes.fill(0);
  await assert.rejects(()=>run(createSecureContext({ca:[serverCert.root.certificate]})),e=>e.code==='WSDL_CONNECTION_FAILED');
  await assert.rejects(()=>run(context({ca:[client.root.certificate]})),e=>e.code==='WSDL_CONNECTION_FAILED');
  await assert.rejects(()=>run(context(),plan('65')),e=>e.code==='WSDL_CONNECTION_FAILED');assert.equal(count,1);
 }finally{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
