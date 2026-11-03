// Synthetic PFX only; no socket, external credentials, database or grant.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {createSecureContext,rootCertificates} from 'node:tls';
import {withReceiptQueryCredential,withAuthorizationCredential,withProtocolCredential,withWsdlCredential} from '../src/envelope.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../src/index.mjs';
import * as publicVault from '../src/index.mjs';
import {createReceiptQueryTlsLoader} from '../src/receipt-query-tls-loader.mjs';
import {createAuthorizationTlsLoader} from '../src/authorization-tls-loader.mjs';
import {createSpReceiptQueryTlsLoader,requireReceiptQueryServerContext,SP_RECEIPT_QUERY_ROOT_HASH} from '../../fiscal-authorization/src/receipt-query-server-trust.mjs';
import {requireAuthorizationServerContext} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {trustFixture} from './trust-fixtures.mjs';
import {binary,exportPfx,KEK,PASSWORD,CONTEXT} from './fixtures.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),f=await trustFixture(),pfx=await exportPfx(f.leaf,[f.intermediate,f.root]),offline=await createOpenSslLoader({binaryPath:binary});
const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'synthetic',loader:offline,now:new Date()}),sealed=envelopeBytes(envelope);
const loader=await createSpReceiptQueryTlsLoader({binaryPath:binary});
const input=()=>({envelope,expectedEnvelopeHash:hash(sealed),expectedContext:CONTEXT,kekBytes:KEK,expectedKeyId:'synthetic',loader,purpose:'sp-receipt-query-homologation-v1',now:new Date(),deadline:Date.now()+10000});
test.after(()=>{pfx.fill(0);sealed.fill(0);for(const c of[f.leaf,f.intermediate,f.root])c.privateDer.fill(0);});
test('089 opens unchanged041 AAD and yields only scoped TLS; no public export or authority flags',async()=>{
 const original=hash(envelopeBytes(envelope));let called=0,owned=[];
 await withReceiptQueryCredential({...input(),loader:{withContext(v,action){owned.push(v.pfxBytes,v.passwordBytes);return loader.withContext(v,action);}}},s=>{called++;assert.equal(s.metadata.fingerprint_sha256,envelope.metadata.fingerprint_sha256);assert.equal(s.metadata.can_transmit,false);assert.equal(requireReceiptQueryServerContext(s.secureContext,s.metadata.fingerprint_sha256).server_trust_anchor_sha256,SP_RECEIPT_QUERY_ROOT_HASH);assert.throws(()=>requireAuthorizationServerContext(s.secureContext,s.metadata.fingerprint_sha256));});
 assert.equal(called,1);assert.ok(owned.every(b=>b.every(v=>v===0)));assert.equal(envelope.context.purpose,'offline-homologation');assert.equal(hash(envelopeBytes(envelope)),original);assert.equal(publicVault.withReceiptQueryCredential,undefined);
});
test('purposes remain disjoint and callbacks never run on mismatches',async()=>{
 for(const open of[withAuthorizationCredential,withProtocolCredential,withWsdlCredential])await assert.rejects(open(input(),()=>assert.fail()));
 for(const purpose of['sp-authorization-homologation-v1','sefaz-sp-protocol-homologation-v1','production','offline-homologation'])await assert.rejects(withReceiptQueryCredential({...input(),purpose},()=>assert.fail()));
 const old=await createAuthorizationTlsLoader({binaryPath:binary});await assert.rejects(withReceiptQueryCredential({...input(),loader:old},()=>assert.fail()));
 const bare=await createReceiptQueryTlsLoader({binaryPath:binary});await assert.rejects(bare.withContext({pfxBytes:pfx,passwordBytes:PASSWORD,expectedHolderCnpj:CONTEXT.holder_cnpj,expectedFingerprint:envelope.metadata.fingerprint_sha256,purpose:'sp-authorization-homologation-v1',now:new Date(),deadline:Date.now()+10000},()=>assert.fail()));
});
test('trust attests actual installed leaf and pinned public roots, never the PFX issuer chain',async()=>{
 let settings;const pinned=await createSpReceiptQueryTlsLoader({binaryPath:binary},{createContext(options){settings=options;assert.deepEqual(options.ca.slice(0,-1),rootCertificates);assert.equal(hash(new X509Certificate(options.ca.at(-1)).raw),SP_RECEIPT_QUERY_ROOT_HASH);assert.equal(options.ca.includes(f.root.certificate),false);return createSecureContext(options);}});
 await withReceiptQueryCredential({...input(),loader:pinned},s=>{assert.throws(()=>requireReceiptQueryServerContext(s.secureContext,'0'.repeat(64)));});assert.ok(settings);
 await assert.rejects(createSpReceiptQueryTlsLoader({binaryPath:binary},{readFileImpl:async()=>Buffer.from(f.root.certificate)}),/SERVER_TRUST_INVALID/);
});
test('envelope integrity and cancellation close before exposing a context; action failures stay sanitized',async()=>{
 const forged=structuredClone(envelope);forged.payload.tag=Buffer.alloc(16).toString('base64');await assert.rejects(withReceiptQueryCredential({...input(),envelope:forged,expectedEnvelopeHash:hash(envelopeBytes(forged))},()=>assert.fail()));
 await assert.rejects(withReceiptQueryCredential(input(),()=>{throw Error('PRIVATE_VALUE_MUST_NOT_LEAK');}),e=>!JSON.stringify(e).includes('PRIVATE_VALUE'));
 const abort=new AbortController();abort.abort();await assert.rejects(withReceiptQueryCredential({...input(),signal:abort.signal},()=>assert.fail()));
});
