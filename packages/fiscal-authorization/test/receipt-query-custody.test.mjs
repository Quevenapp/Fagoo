// Synthetic current A1 may differ from historical signing A1. No DB, socket or actual credential.
import test from 'node:test';import assert from 'node:assert/strict';
import {receiptFixture} from './receipt-fixtures.mjs';import {preparedFixture} from './receipt-query-port-fixture.mjs';
import {createReceiptQueryCustodyPort} from '../src/receipt-query-custody.mjs';
import {createReceiptQueryPreparationAuthorizer} from '../src/receipt-query-preparation.mjs';
import {createSpReceiptQueryTlsLoader,requireReceiptQueryServerContext} from '../src/receipt-query-server-trust.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import * as publicVault from '../../fiscal-vault/src/index.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';import {binary,exportPfx,KEK,PASSWORD,CONTEXT} from '../../fiscal-vault/test/fixtures.mjs';import {hash} from '../src/service-common.mjs';
let f,client,sealed,envelope,loader;
test.before(async()=>{f=await receiptFixture();client=await trustFixture();const pfx=await exportPfx(client.leaf,[client.intermediate,client.root]);try{envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'test',loader:await createOpenSslLoader({binaryPath:binary}),now:new Date()});sealed=envelopeBytes(envelope);}finally{pfx.fill(0);}loader=await createSpReceiptQueryTlsLoader({binaryPath:binary});});
test.after(()=>{f?.close();sealed?.fill(0);for(const c of Object.values(client??{}))c.privateDer?.fill(0);});
const prepared=()=>preparedFixture(f,{credential_id:CONTEXT.credential_id,envelope_hash:hash(sealed),certificate_fingerprint:hash(client.leaf.certificateDer)});
function port(patch={}){const events=[],owned=[],key=Buffer.from(KEK),config={authorizePreparation:async v=>{events.push('authorize');return v.context;},readObject:async()=>{events.push('read');const b=Buffer.from(sealed);owned.push(b);return b;},loader:{withContext:async(v,a)=>{events.push('load');owned.push(v.pfxBytes,v.passwordBytes);return loader.withContext(v,a);}},keyring:new Map([['test',key]]),...patch};return{run:createReceiptQueryCustodyPort(config),events,owned,key,config};}
test('new purpose retains041 AAD and captures current cert while preserving historical source',async()=>{const p=await prepared(),x=port();try{let called=0;await x.run(p.value,async s=>{called++;assert.equal(s.metadata.fingerprint_sha256,hash(client.leaf.certificateDer));requireReceiptQueryServerContext(s.secureContext,s.metadata.fingerprint_sha256);},{deadline:Date.now()+10000});assert.equal(called,1);assert.deepEqual(x.events,['authorize','read','load']);assert.ok(x.owned.every(b=>b.every(v=>v===0)));assert.deepEqual(x.key,KEK);assert.equal(envelope.context.purpose,'offline-homologation');assert.equal(publicVault.withReceiptQueryCredential,undefined);}finally{p.close();}});
test('ACL denial or changed preparation precedes encrypted-object read',async()=>{const p=await prepared();try{for(const result of ['deny','change']){const x=port({authorizePreparation:async v=>{if(result==='deny')throw Object.assign(Error('42501'),{code:'42501'});return{...v.context,nonce:'a0000000-0000-4000-8000-000000000001'};}});await assert.rejects(x.run(p.value,async()=>assert.fail(),{deadline:Date.now()+10000}));assert.deepEqual(x.events,[]);}}finally{p.close();}});
test('keys/inputs/options snapshot before await; shared buffers and wrong ciphertext refuse loading',async()=>{const p=await prepared();try{
 let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r),x=port({authorizePreparation:async v=>{entered();await gate;return v.context;}}),input={...p.value,context:{...p.value.context}},opts={deadline:Date.now()+10000},pending=x.run(input,async()=>{},opts);await seen;input.context.envelope_hash='0'.repeat(64);input.actor='bad';opts.deadline=0;x.key.fill(0);release();await pending;assert.ok(x.owned.every(b=>b.every(v=>v===0)));
 const bytes=Buffer.from('invalid ciphertext'),y=port({readObject:async()=>bytes});await assert.rejects(y.run(p.value,async()=>assert.fail(),{deadline:Date.now()+10000}));assert.ok(bytes.every(v=>v===0));assert.equal(y.events.includes('load'),false);
 const z=port({keyring:new Map([['test',new Uint8Array(new SharedArrayBuffer(32))]])});await assert.rejects(z.run(p.value,async()=>assert.fail(),{deadline:Date.now()+10000}));assert.deepEqual(z.events,[]);
 }finally{p.close();}});
test('abort wipes late ciphertext and retained callback cannot reopen expired custody',async()=>{const p=await prepared();try{
 let release,entered;const seen=new Promise(r=>entered=r),bytes=Buffer.from(sealed),x=port({readObject:async()=>{entered();return new Promise(r=>release=r);}}),ac=new AbortController(),pending=x.run(p.value,async()=>assert.fail(),{signal:ac.signal,deadline:Date.now()+10000});await seen;ac.abort();await assert.rejects(pending);release(bytes);await new Promise(r=>setImmediate(r));assert.ok(bytes.every(v=>v===0));
 let retained;const y=port({loader:{withContext:async(v,action)=>{retained=()=>loader.withContext(v,action);}}});await assert.rejects(y.run(p.value,async()=>assert.fail(),{deadline:Date.now()+10000}));await assert.rejects(retained());
 }finally{p.close();}});
test('preparation authorizer checks fresh command and current context without begin replay or Storage',async()=>{const p=await prepared();try{
 const r=p.x.state.record;r.current.state='request_ready';r.current.finished_at=null;r.error_code=null;r.recovery={...p.value.context};r.receipt.a1_version=r.recovery.a1_version;const a=createReceiptQueryPreparationAuthorizer({rpc:p.x.ports.rpc});
 // The source is historical; only the separately captured current A1 metadata changes.
 const out=await a(p.value,{});assert.equal(out.query_id,p.value.context.query_id);assert.deepEqual(p.x.calls.slice(-2),['command','context']);
 p.x.state.policyOff=true;await assert.rejects(a(p.value,{}));
 }finally{p.close();}});
