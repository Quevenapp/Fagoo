import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:https';
import {createSecureContext} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {prepareDistributionExchange,createDistributionTransport} from '../src/distribution-transport.mjs';

// HTTPS certificates are generated in memory. The sole driver always connects to
// an ephemeral loopback port; it never resolves or connects to the official host.
test('real Node mTLS on loopback validates both peers and hostname while the public prototype remains unapproved',async()=>{
 const hostname='hom1.nfe.fazenda.gov.br';
 const [client,remote]=await Promise.all([trustFixture(),trustFixture({eku:['1.3.6.1.5.5.7.3.1'],dns:hostname})]);
 const key=c=>c.leaf.privateKey.export({format:'pem',type:'pkcs8'}),cert=c=>c.leaf.certificate+'\n'+c.intermediate.certificate;
 let calls=0,verified=false;const sockets=new Set();
 const server=createServer({key:key(remote),cert:cert(remote),ca:[client.root.certificate],requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3'},(req,res)=>{
  calls++;verified=req.socket.authorized&&req.socket.getPeerCertificate().fingerprint256===new X509Certificate(client.leaf.certificate).fingerprint256;
  assert.equal(req.method,'POST');assert.equal(req.url,'/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');assert.equal(req.headers.host,hostname);let xml='';req.on('data',b=>xml+=b.toString('utf8'));req.on('end',()=>{assert.match(xml,/<ultNSU>000000000000005<\/ultNSU>/);res.writeHead(200,{'Content-Type':'text/xml; charset=utf-8'});res.end('<synthetic>NO SEFAZ OR REAL DOCUMENT</synthetic>');});
 });
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.on('tlsClientError',()=>{});
 const connection=options=>{assert.ok([hostname,'www1.nfe.fazenda.gov.br'].includes(options.hostname));assert.equal(options.port,443);return{...options,hostname:'127.0.0.1',port:server.address().port};};
 const driver=createDistributionTransport({requestImpl:(options,cb)=>request(connection(options),cb)});
 const plan=()=>prepareDistributionExchange({environment:'2',authorUf:'35',interestedCnpj:'11222333000181',lastNsu:'000000000000005'});
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const context=createSecureContext({key:key(client),cert:cert(client),ca:[remote.root.certificate],minVersion:'TLSv1.2',maxVersion:'TLSv1.3'});
  const result=await driver.exchange(plan(),{secureContext:context});assert.equal(calls,1);assert.equal(verified,true);assert.equal(result.can_query,false);assert.equal(result.binding_verified,false);assert.match(result.bytes.toString('utf8'),/NO SEFAZ/);
  const missingClient=createSecureContext({ca:[remote.root.certificate],minVersion:'TLSv1.2'});await assert.rejects(()=>driver.exchange(plan(),{secureContext:missingClient}),e=>e.code==='DFE_TRANSPORT_CONNECTION_FAILED');assert.equal(calls,1);
  const wrongTrust=createSecureContext({key:key(client),cert:cert(client),ca:[client.root.certificate],minVersion:'TLSv1.2'});await assert.rejects(()=>driver.exchange(plan(),{secureContext:wrongTrust}),e=>e.code==='DFE_TRANSPORT_CONNECTION_FAILED'&&!e.may_have_been_sent);assert.equal(calls,1);
  const wrongHostname=prepareDistributionExchange({environment:'1',authorUf:'35',interestedCnpj:'11222333000181',lastNsu:'000000000000005'});await assert.rejects(()=>driver.exchange(wrongHostname,{secureContext:context}),e=>e.code==='DFE_TRANSPORT_CONNECTION_FAILED'&&!e.may_have_been_sent);assert.equal(calls,1);
 }finally{for(const s of sockets)s.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
