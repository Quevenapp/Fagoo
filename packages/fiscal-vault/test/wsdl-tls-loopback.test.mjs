import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:https';
import {createSecureContext} from 'node:tls';
import {createHash, X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import {createWsdlTlsLoader} from '../src/wsdl-tls-loader.mjs';
import {trustFixture} from './trust-fixtures.mjs';
import {exportPfx, binary, HOLDER, PASSWORD, NOW} from './fixtures.mjs';

test('opt-in synthetic PFX becomes scoped mTLS context for one WSDL GET on loopback', {skip:process.env.BRUFAP_WSDL_LOOPBACK_TEST !== '1',timeout:30000}, async () => {
  const {createWsdlEvidenceClient} = await import('../../fiscal-sefaz-wsdl/src/index.mjs');
  const {plan, wsdl} = await import('../../fiscal-sefaz-wsdl/test/fixtures.mjs');
  const hostname = plan().hostname;
  const [client, serverCredentials] = await Promise.all([trustFixture(), trustFixture({eku:['1.3.6.1.5.5.7.3.1'],dns:hostname})]);
  const pfx = await exportPfx(client.leaf, [client.intermediate,client.root]);
  const fingerprint = createHash('sha256').update(client.leaf.certificateDer).digest('hex');
  const args = {pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:HOLDER,expectedFingerprint:fingerprint,purpose:'sefaz-sp-wsdl-readonly-v1',now:NOW};
  const sockets = new Set(); let received = 0, pem;
  const server = createServer({key:serverCredentials.leaf.privateKey.export({format:'pem',type:'pkcs8'}),cert:serverCredentials.leaf.certificate+'\n'+serverCredentials.intermediate.certificate,
    ca:[client.root.certificate],requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxVersion:'TLSv1.3'}, (req,res) => {
    received++; assert.equal(req.socket.authorized,true);
    assert.equal(req.socket.getPeerCertificate().fingerprint256,new X509Certificate(client.leaf.certificate).fingerprint256);
    assert.equal(req.method,'GET'); assert.equal(req.url,plan().path); assert.equal(req.headers.host,hostname);
    res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'}); res.end(wsdl());
  });
  server.on('connection',socket => { sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); }); server.on('tlsClientError',()=>{});
  try {
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    const loader = await createWsdlTlsLoader({binaryPath:binary}, {createContext(options) {
      pem = options.key;
      // Only this test dependency adds its synthetic server CA; it is never a runtime default.
      return createSecureContext({...options,ca:[serverCredentials.root.certificate]});
    }});
    const evidence = await createWsdlEvidenceClient({
      requestImpl:(options,callback) => { assert.equal(options.hostname,hostname); return request({...options,hostname:'127.0.0.1',port:server.address().port},callback); },
      withAuthorizedTlsSession:async (context,action,options) => {
        assert.equal(context.method,'GET'); assert.equal(context.purpose,args.purpose);
        await loader.withContext({...args,signal:options.signal,deadline:options.deadline}, async ({secureContext,metadata}) => {
          assert.equal(metadata.fingerprint_sha256,fingerprint); assert.equal(pem.every(byte=>byte===0),true);
          await action(secureContext);
        });
      },
    }).obtain(plan());
    assert.equal(received,1); assert.equal(evidence.binding_verified,false); assert.equal(evidence.can_transmit,false);
    assert.equal(evidence.wsdl_hash,createHash('sha256').update(evidence.bytes).digest('hex')); evidence.bytes.fill(0);
  } finally {
    for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); pfx.fill(0);
  }
});
