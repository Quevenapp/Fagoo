import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSecureContext, rootCertificates} from 'node:tls';
import {createHash, X509Certificate} from 'node:crypto';
import {createSpWsdlTlsLoader, SP_WSDL_SERVER_TRUST} from '../src/wsdl-server-trust.mjs';
import {binary, exportPfx, HOLDER, NOW, PASSWORD} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

const fixture = await trustFixture();
const pfx = await exportPfx(fixture.leaf, [fixture.intermediate,fixture.root]);
const input = {pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:HOLDER,
  expectedFingerprint:createHash('sha256').update(fixture.leaf.certificateDer).digest('hex'),
  now:NOW,purpose:'sefaz-sp-wsdl-readonly-v1'};
const rootFile = new URL('../../fiscal-vault/trust/icp-brasil-v10.pem',import.meta.url);

test('SP WSDL server trust adds only pinned public SSL root, never the A1 issuer, without global configuration', async () => {
  const before = {...process.env}; let count = 0, trusted;
  const loader = await createSpWsdlTlsLoader({binaryPath:binary}, {now:()=>NOW, createContext(options) {
    count++; trusted=options.ca;
    assert.equal(options.ca.length,rootCertificates.length+1);
    assert.deepEqual(options.ca.slice(0,-1),rootCertificates);
    assert.equal(options.ca.includes(fixture.root.certificate),false);
    assert.equal(options.ca.includes(fixture.intermediate.certificate),false);
    assert.equal(options.minVersion,'TLSv1.2'); assert.equal(options.maxVersion,'TLSv1.3');
    assert.equal(new X509Certificate(options.ca.at(-1)).fingerprint256.replaceAll(':','').toLowerCase(),
      '6e0bff069a26994c15de2c4888cc54af84882e5495b7fbf66be9ccffec7489f6');
    return createSecureContext(options);
  }});
  await loader.withContext(input,()=>{});
  // A caller that retained the trusted dependency's argument cannot mutate the
  // CA set used by the next context.
  trusted.fill(fixture.root.certificate);
  await loader.withContext(input,()=>{});
  assert.equal(count,2); assert.deepEqual({...process.env},before);
  assert.equal(SP_WSDL_SERVER_TRUST,'node-bundled-plus-iti-ssl-v10-20261016');
});

test('wrong, concatenated, oversized or unreadable trust data fail before OpenSSL or client material is opened', async () => {
  const root=await readFile(rootFile);
  for (const readFileImpl of [
    async()=>Buffer.from(fixture.root.certificate),async()=>Buffer.concat([root,root]),
    async()=>Buffer.alloc(8193),async()=>Buffer.from('not a certificate'),
    async()=>{throw new Error('private-path-should-not-leak');},
  ]) {
    await assert.rejects(createSpWsdlTlsLoader({binaryPath:'/intentionally/not/openssl'},{readFileImpl,now:()=>NOW}),
      error=>error.message==='WSDL_SERVER_TRUST_INVALID'&&!JSON.stringify(error).includes('private-path'));
  }
});

test('root time is checked at construction and every use; caller A1 time does not override server trust time', async () => {
  for(const at of [new Date('2018-01-01T00:00:00Z'),new Date('2033-01-01T00:00:00Z'),new Date(NaN)])
    await assert.rejects(createSpWsdlTlsLoader({binaryPath:binary},{now:()=>at}),/WSDL_SERVER_TRUST_INVALID/);
  let at=NOW,called=0;
  const loader=await createSpWsdlTlsLoader({binaryPath:binary},{now:()=>at,createContext(){called++;throw new Error('unexpected');}});
  at=new Date('2033-01-01T00:00:00Z');
  await assert.rejects(loader.withContext(input,()=>{}),error=>
    error.code==='VAULT_TLS_CONTEXT_CREATION_FAILED'&&error.message==='VAULT_TLS_CONTEXT_CREATION_FAILED');
  assert.equal(called,0);
});
