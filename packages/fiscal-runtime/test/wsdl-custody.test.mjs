import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {SecureContext} from 'node:tls';
import {createWsdlCustodyPort,WsdlCustodyError} from '../src/wsdl-custody.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {createWsdlTlsLoader} from '../../fiscal-vault/src/wsdl-tls-loader.mjs';
import {VaultError} from '../../fiscal-vault/src/common.mjs';
import {prepareWsdlRequest} from '../../fiscal-sefaz-wsdl/src/profile.mjs';
import {binary,exportPfx,PASSWORD,CONTEXT,KEK,NOW,HOLDER,OTHER} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

const certificates=await trustFixture(),pfx=await exportPfx(certificates.leaf,[certificates.intermediate,certificates.root]);
const offline=await createOpenSslLoader({binaryPath:binary}),tls=await createWsdlTlsLoader({binaryPath:binary});
const envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:CONTEXT,kekBytes:KEK,keyId:'synthetic-key',loader:offline,now:NOW});
const sealed=envelopeBytes(envelope),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>structuredClone(value),tick=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const wiped=bytes=>assert.equal(bytes.every(n=>n===0),true);
const reject=(promise,code)=>assert.rejects(promise,error=>error instanceof WsdlCustodyError&&error.code===code&&!error.cause&&!JSON.stringify(error).includes('PRIVATE-DETAIL'));
function fixture(overrides={}){
  const actor=randomUUID(),attempt=randomUUID(),deadline=Date.now()+5000;
  const plan=prepareWsdlRequest({model:'55',operation:'status',requestId:attempt});
  const execution={private_executor_only:true,lease_id:randomUUID(),scope:{
    attempt_id:attempt,command_id:randomUUID(),actor,nonce:randomUUID(),expires_at:new Date(NOW.getTime()+60000).toISOString(),
    purpose:plan.purpose,effective_profile:'wsdl-mtls-client-v1',environment:'2',model:'55',operation:'status',method:'GET',endpoint:plan.url,
    identity_version:CONTEXT.company_identity_version,issuer_cnpj:HOLDER,a1_version:CONTEXT.credential_version,
    credential_id:CONTEXT.credential_id,envelope_hash:hash(sealed),certificate_fingerprint:envelope.metadata.fingerprint_sha256,
  },credential:{id:CONTEXT.credential_id,context:clone(CONTEXT),metadata:clone(envelope.metadata),object:{
    bucket:'brufap-a1-vault',key:`credentials/${CONTEXT.credential_id}/${hash(sealed)}.json`,hash:hash(sealed),size_bytes:sealed.length,key_id:'synthetic-key',
  }}};
  const value={actor,execution,context:{purpose:plan.purpose,environment:'2',model:'55',operation:'status',request_id:attempt,method:'GET',endpoint:plan.url,deadline}};
  const events=[],owned=[],key=Buffer.from(KEK),keys=new Map([['synthetic-key',key]]);
  let loads=0;
  const port=createWsdlCustodyPort({
    authorizePreparation:async(input,options)=>{events.push({type:'authorize',input,options});return clone(input.execution);},
    readObject:async(reference,options)=>{events.push({type:'read',reference,options});const bytes=Buffer.from(sealed);owned.push(bytes);return bytes;},
    loader:{async withContext(input,action){loads++;events.push({type:'load',input});await tls.withContext(input,action);}},
    keyring:keys,now:()=>NOW.getTime(),...overrides,
  });
  return{value,port,events,owned,key,keys,loads:()=>loads,options:{deadline}};
}

test('fresh authorization precedes envelope IO/open and async use-before-handshake action is awaited',async()=>{
  const f=fixture(),entered=gate(),release=gate();let completed=false,scope;
  const pending=f.port(f.value,async value=>{scope=value;f.events.push({type:'consume-use051'});entered.resolve();await release.promise;f.events.push({type:'synthetic-GET'});},f.options).then(()=>{completed=true;});
  await entered.promise;assert.equal(completed,false);assert.deepEqual(f.events.map(e=>e.type),['authorize','read','load','consume-use051']);
  assert.ok(scope.secureContext instanceof SecureContext);assert.equal(scope.metadata.holder_cnpj,HOLDER);assert.equal(scope.metadata.can_emit,false);
  assert.deepEqual(f.events[1].reference,{bucket:'brufap-a1-vault',path:f.value.execution.credential.object.key,hash:hash(sealed),size:sealed.length,key_id:'synthetic-key'});
  release.resolve();assert.equal(await pending,undefined);assert.equal(scope.signal.aborted,true);
  for(const bytes of f.owned)wiped(bytes);wiped(f.events[2].input.pfxBytes);wiped(f.events[2].input.passwordBytes);
  assert.deepEqual(f.key,KEK);
});

test('no preparation authorizer or no injected TLS loader is a configuration error',()=>{
  for(const config of [{},{readObject:()=>{},loader:tls,keyring:new Map([['key',KEK]])},{readObject:()=>{},authorizePreparation:()=>{},keyring:new Map([['key',KEK]])}])
    assert.throws(()=>createWsdlCustodyPort(config),/WSDL_CUSTODY_CONFIGURATION_INVALID/);
});

test('scope, actor, exact route, credential and lease substitutions fail before any authorization or Storage IO',async()=>{
  for(const change of [
    v=>{v.actor=randomUUID();},v=>{v.execution.scope.endpoint='https://example.invalid/';},v=>{v.context.endpoint+='&extra=1';},
    v=>{v.execution.scope.method='POST';},v=>{v.execution.scope.environment='1';},v=>{v.execution.scope.purpose='offline-homologation';},
    v=>{v.execution.credential.object.key='../private';},v=>{v.execution.credential.object.bucket='other';},v=>{v.execution.credential.object.size_bytes=1500001;},
    v=>{v.execution.credential.context.holder_cnpj=OTHER;},v=>{v.execution.scope.identity_version++;},v=>{v.execution.scope.certificate_fingerprint='0'.repeat(64);},
    v=>{v.execution.scope.credential_id=randomUUID();},v=>{v.execution.scope.a1_version=0;},v=>{v.context.request_id=randomUUID();},
    v=>{v.execution.extra='PRIVATE-DETAIL';},v=>{Object.defineProperty(v,'actor',{get(){throw Error('PRIVATE-DETAIL');}});},
  ]){
    const f=fixture();change(f.value);await assert.rejects(f.port(f.value,()=>assert.fail('action'),f.options),e=>e instanceof WsdlCustodyError&&!JSON.stringify(e).includes('PRIVATE-DETAIL'));
    assert.equal(f.events.length,0);assert.equal(f.loads(),0);
  }
  const expired=fixture();expired.value.execution.scope.expires_at=NOW.toISOString();await reject(expired.port(expired.value,()=>{},expired.options),'WSDL_CUSTODY_LEASE_EXPIRED');assert.equal(expired.events.length,0);
});

test('revocation/CAS rejection and changed fresh execution prevent Storage and TLS initialization',async()=>{
  const denied=fixture({authorizePreparation:async()=>{throw Error('PRIVATE-DETAIL');}});
  await reject(denied.port(denied.value,()=>assert.fail('action'),denied.options),'WSDL_CUSTODY_AUTHORIZATION_REJECTED');assert.equal(denied.events.length,0);
  for(const alter of [e=>{e.scope.a1_version++;},e=>{e.scope.nonce=randomUUID();},e=>{e.lease_id=randomUUID();},e=>{e.credential.object.key_id='other';},e=>{e.scope.expires_at=new Date(NOW.getTime()+59000).toISOString();}]){
    const f=fixture({authorizePreparation:async input=>{const e=clone(input.execution);alter(e);return e;}});
    await reject(f.port(f.value,()=>assert.fail('action'),f.options),'WSDL_CUSTODY_PREPARATION_CHANGED');assert.equal(f.events.length,0);
  }
});

test('caller mutation during authorization cannot change command, metadata, key bytes, Date or options',async()=>{
  const entered=gate(),release=gate();let authorized;
  const f=fixture({authorizePreparation:async input=>{authorized=input;entered.resolve();await release.promise;return clone(input.execution);}}),original=clone(f.value);
  let calls=0;const pending=f.port(f.value,()=>{calls++;},f.options);
  await entered.promise;f.value.actor=randomUUID();f.value.execution.credential.object.key='../changed';f.value.execution.credential.metadata.fingerprint_sha256='0'.repeat(64);
  f.key.fill(0);f.options.deadline=Date.now()-1;
  release.resolve();await pending;assert.equal(calls,1);assert.deepEqual(authorized,original);assert.equal(f.loads(),1);
});

test('key selection, byte limit/hash and authenticated envelope metadata cannot be substituted',async()=>{
  const missing=fixture();missing.keys.delete('synthetic-key');await reject(missing.port(missing.value,()=>{},missing.options),'WSDL_CUSTODY_KEY_UNAVAILABLE');assert.equal(missing.events.length,0);
  const bad=Buffer.from('PRIVATE-DETAIL'),wrong=fixture({readObject:async()=>bad});await reject(wrong.port(wrong.value,()=>{},wrong.options),'WSDL_CUSTODY_OBJECT_INVALID');wiped(bad);assert.equal(wrong.loads(),0);
  const altered=clone(envelope);altered.metadata.legacy_provider_enabled=!altered.metadata.legacy_provider_enabled;
  const raw=envelopeBytes(altered),f=fixture({readObject:async()=>Buffer.from(raw)});
  f.value.execution.scope.envelope_hash=hash(raw);f.value.execution.credential.object.hash=hash(raw);f.value.execution.credential.object.size_bytes=raw.length;f.value.execution.credential.object.key=`credentials/${CONTEXT.credential_id}/${hash(raw)}.json`;
  await reject(f.port(f.value,()=>{},f.options),'WSDL_CUSTODY_ENVELOPE_CONFLICT');assert.equal(f.loads(),0);
  f.value.execution.credential.metadata=clone(altered.metadata);
  await reject(f.port(f.value,()=>{},f.options),'WSDL_CUSTODY_OPEN_FAILED');assert.equal(f.loads(),0);
});

test('expiry after object delivery wipes its bytes and prevents opening; remaining lease caps callback deadline',async()=>{
  let at=NOW.getTime();const bytes=Buffer.from(sealed),f=fixture({now:()=>at,readObject:async()=>{at+=61000;return bytes;}});
  await reject(f.port(f.value,()=>assert.fail('action'),f.options),'WSDL_CUSTODY_LEASE_EXPIRED');wiped(bytes);assert.equal(f.loads(),0);
  const short=fixture();short.value.execution.scope.expires_at=new Date(NOW.getTime()+1000).toISOString();
  await short.port(short.value,value=>{assert.ok(value.deadline<=Date.now()+1000);assert.ok(value.deadline<short.options.deadline);},short.options);
});

test('abort and deadline stop stale authorizers; no late authorization can open Storage',async()=>{
  for(const mode of ['abort','deadline']){
    const entered=gate(),release=gate(),abort=new AbortController();let authSignal;
    const f=fixture({authorizePreparation:async(input,options)=>{authSignal=options.signal;entered.resolve();await release.promise;return clone(input.execution);}});
    if(mode==='deadline'){f.options.deadline=Date.now()+80;f.value.context.deadline=f.options.deadline;}else f.options.signal=abort.signal;
    const pending=f.port(f.value,()=>assert.fail('action'),f.options);await entered.promise;if(mode==='abort')abort.abort();
    await reject(pending,mode==='abort'?'WSDL_CUSTODY_ABORTED':'WSDL_CUSTODY_TIMEOUT');assert.equal(authSignal.aborted,true);
    release.resolve();await tick();assert.equal(f.events.length,0);assert.equal(f.loads(),0);
  }
});

test('late Storage bytes are wiped after abort and can never initialize TLS',async()=>{
  const entered=gate(),release=gate(),abort=new AbortController(),bytes=Buffer.from(sealed);let readSignal;
  const f=fixture({readObject:async(_ref,options)=>{readSignal=options.signal;entered.resolve();await release.promise;return bytes;}});
  const pending=f.port(f.value,()=>assert.fail('action'),{...f.options,signal:abort.signal});await entered.promise;abort.abort();await reject(pending,'WSDL_CUSTODY_ABORTED');assert.equal(readSignal.aborted,true);
  release.resolve();await tick();wiped(bytes);assert.equal(f.loads(),0);
});

test('late TLS callbacks after abort cannot consume use051 and active actions receive cancellation',async()=>{
  const entered=gate(),release=gate(),abort=new AbortController();let lateScope,calls=0;
  const f=fixture({loader:{async withContext(input,action){await tls.withContext(input,async scope=>{lateScope=scope;entered.resolve();await release.promise;await action(scope);});}}});
  const pending=f.port(f.value,()=>{calls++;},{...f.options,signal:abort.signal});await entered.promise;abort.abort();await reject(pending,'WSDL_CUSTODY_ABORTED');assert.equal(lateScope.signal.aborted,true);release.resolve();await tick();assert.equal(calls,0);
  const started=gate(),stop=gate(),active=fixture(),signal=new AbortController();let scope;
  const running=active.port(active.value,async value=>{scope=value;started.resolve();await stop.promise;},{...active.options,signal:signal.signal});
  await started.promise;signal.abort();await reject(running,'WSDL_CUSTODY_ABORTED');assert.equal(scope.signal.aborted,true);stop.resolve();await tick();
});

test('no return value, private diagnostics or a second callback crosses the custody port',async()=>{
  for(const action of [()=>({pfx:'PRIVATE-DETAIL'}),()=>{throw Error('PRIVATE-DETAIL');}]){
    const f=fixture();await assert.rejects(f.port(f.value,action,f.options),e=>e instanceof WsdlCustodyError&&!JSON.stringify(e).includes('PRIVATE-DETAIL'));
  }
  let calls=0;const twice=fixture({loader:{async withContext(input,action){await tls.withContext(input,async scope=>{await action(scope);try{await action(scope);}catch{}});}}});
  await reject(twice.port(twice.value,()=>{calls++;},twice.options),'WSDL_CUSTODY_OPEN_FAILED');assert.equal(calls,1);
});

test('revocation failure from use051 in the callback never reaches the synthetic GET',async()=>{
  const f=fixture();let gets=0,uses=0;
  await reject(f.port(f.value,async()=>{uses++;await Promise.reject(Error('PRIVATE-DETAIL'));gets++;},f.options),'WSDL_CUSTODY_OPEN_FAILED');
  assert.equal(uses,1);assert.equal(gets,0);for(const bytes of f.owned)wiped(bytes);
});

test('private diagnostic distinguishes authorization, object IO and object validation without changing public failures',async()=>{
  const cases=[
    [{authorizePreparation:async()=>{throw Object.assign(Error('PRIVATE-AUTH'),{code:'42501'});}},'WSDL_CUSTODY_AUTHORIZATION_REJECTED','authorization_replay','authorization_denied'],
    [{readObject:async()=>{throw Object.assign(Error('PRIVATE-PATH'),{code:'A1_UPSTREAM_UNAVAILABLE'});}},'WSDL_CUSTODY_OPEN_FAILED','encrypted_object_read','object_io_unavailable'],
    [{readObject:async()=>Buffer.from('PRIVATE-CIPHERTEXT')},'WSDL_CUSTODY_OBJECT_INVALID','encrypted_object_validation','object_integrity_invalid'],
    [{loader:{withContext(){throw new VaultError('VAULT_PFX_REJECTED');}}},'WSDL_CUSTODY_OPEN_FAILED','pkcs12_validation','pkcs12_rejected'],
  ];
  for(const[ports,publicCode,phase,code]of cases){
    const lines=[],f=fixture({...ports,diagnostic:line=>lines.push(line)});
    await reject(f.port(f.value,()=>assert.fail('action'),f.options),publicCode);
    assert.equal(lines.length,1);const event=JSON.parse(lines[0]);
    assert.equal(event.phase,phase);assert.equal(event.code,code);
    assert.doesNotMatch(lines[0],/PRIVATE|credential|issuer|fingerprint|BEGIN|\/|\d{14}/);
    for(const bytes of f.owned)wiped(bytes);
  }
});

test('envelope decryption and local TLS construction are separate diagnostic phases',async()=>{
  const decryptLines=[],decrypt=fixture({diagnostic:line=>decryptLines.push(line)});
  decrypt.key.fill(1);
  await reject(decrypt.port(decrypt.value,()=>assert.fail('action'),decrypt.options),'WSDL_CUSTODY_OPEN_FAILED');
  assert.equal(decrypt.loads(),0);assert.equal(JSON.parse(decryptLines[0]).phase,'envelope_open');
  assert.equal(JSON.parse(decryptLines[0]).code,'credential_open_rejected');
  const local=await createWsdlTlsLoader({binaryPath:binary},{createContext(){throw Error('PRIVATE-TLS-KEY');}});
  const lines=[],f=fixture({loader:local,diagnostic:line=>lines.push(line)});
  await reject(f.port(f.value,()=>assert.fail('action'),f.options),'WSDL_CUSTODY_OPEN_FAILED');
  assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).phase,'tls_local');
  assert.equal(JSON.parse(lines[0]).code,'tls_context_creation_failed');
  assert.doesNotMatch(lines[0],/PRIVATE|BEGIN|key|cert/i);for(const bytes of f.owned)wiped(bytes);
});

test('success and failures after custody handoff never claim to be pre-use failures',async()=>{
  for(const action of [async()=>{},async()=>{throw Error('PRIVATE-AFTER-USE');}]){
    const lines=[],f=fixture({diagnostic:line=>lines.push(line)});
    try{await f.port(f.value,action,f.options);}catch(e){assert.equal(e.code,'WSDL_CUSTODY_OPEN_FAILED');}
    assert.equal(lines.length,0);for(const bytes of f.owned)wiped(bytes);
  }
});

test('throwing diagnostic sinks preserve cleanup and an aborted late authorizer emits only once',async()=>{
  const bad=fixture({readObject:async()=>{throw Error('PRIVATE-READ');},diagnostic(){throw Error('PRIVATE-SINK');}});
  await reject(bad.port(bad.value,()=>assert.fail('action'),bad.options),'WSDL_CUSTODY_OPEN_FAILED');
  const entered=gate(),release=gate(),lines=[],signal=new AbortController();
  const f=fixture({authorizePreparation:async value=>{entered.resolve();await release.promise;return clone(value.execution);},diagnostic:line=>lines.push(line)});
  const pending=f.port(f.value,()=>assert.fail('action'),{...f.options,signal:signal.signal});
  await entered.promise;signal.abort();await reject(pending,'WSDL_CUSTODY_ABORTED');
  release.resolve();await tick();assert.equal(lines.length,1);assert.equal(JSON.parse(lines[0]).phase,'authorization_replay');
  assert.equal(JSON.parse(lines[0]).code,'aborted');assert.equal(f.loads(),0);
});
