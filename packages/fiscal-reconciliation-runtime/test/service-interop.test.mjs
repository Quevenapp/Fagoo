// SQL 062 and the operational code path, in an isolated PGlite database.
// The certificate, transport and validator are fixtures: no network or fiscal evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {operationalFixture} from '../../fiscal-reconciliation/test/operational-fixture.mjs';
import {createReconciliationRuntimeHandler} from '../src/handler.mjs';
import {signRuntimeRequest,digest} from '../src/auth.mjs';

const secret=randomBytes(32),keyId='fixture',audience='fixture-reconciliation';
const prefix='/internal/v1/fiscal-reconciliation';
let f;
test.before(async()=>{f=await operationalFixture();});
test.after(async()=>{await f?.close();secret.fill(0);});
const input=()=>({...f.input,commandId:randomUUID()});
const body=x=>({command_id:x.commandId,candidate_id:x.candidateId,signed_hash:x.signedHash,
 expected_a1_version:x.expectedA1Version,expected_identity_version:x.expectedIdentityVersion,confirmed:true});
const handler=service=>createReconciliationRuntimeHandler({service,transportSecret:secret,transportKeyId:keyId,audience});
async function request(action,x,{actor=x.actor,payload,bodyHash,requestAudience=audience}={}){
 const path=action==='command'?`${prefix}/commands/${x.commandId}`:
  action==='history'?`${prefix}/candidates/${x.candidateId}/history`:`${prefix}/${action}`;
 const method=action==='command'?'GET':'POST';
 const value=payload??(action==='run'?body(x):action==='history'?{limit:25,before:null}:{command_id:x.commandId});
 const bytes=Buffer.from(method==='POST'?JSON.stringify(value):'');
 const authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience:requestAudience,actor,nonce:randomUUID(),method,path,bodyHash:bodyHash??await digest(bytes)});
 return new Request(`http://runtime.internal${path}`,{method,headers:{authorization,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:bytes}:{})});
}
async function read(response,status=200){
 assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');
 const value=await response.json();
 const walk=v=>{if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){
  assert.ok(!['credential','credential_id','certificate_fingerprint','envelope_hash','issuer_cnpj','access_key','reference_digest','lease_id','nonce','actor','execution','recovery','context','bucket','key','xml','signed_xml','secureContext'].includes(k),`private key ${k}`);walk(x);
 }};walk(value);return value;
}
test('real 062 run, command, history and recover project consistent public DTOs and separate query evidence from authorization',async()=>{
 const x=input(),h=handler(f.operationalService());try{
  const saved=await read(await h(await request('run',x)));
  assert.equal(saved.status,'stored');assert.equal(saved.profile,'sefaz-sp-protocol-homologation-v1');assert.equal(saved.origin,'operational');
  assert.equal(saved.artifact.cstat,'217');assert.equal(saved.artifact.tls_origin_verified,true);
  for(const k of ['can_query','can_emit','can_transmit','sefaz_authorized'])assert.equal(saved[k],false,k);
  const calls=f.calls.transport,opens=f.calls.custody;
  const current=await read(await h(await request('command',x)));assert.equal(current.read_only,true);assert.deepEqual(current.receipt,saved.receipt);
  const history=await read(await h(await request('history',x)));assert.equal(history.items[0].command_id,x.commandId);assert.equal(history.items[0].read_only,true);
  const recovered=await read(await h(await request('recover',x)));assert.equal(recovered.status,'stored');assert.equal(recovered.recovered,true);assert.equal(recovered.read_only,false);
  assert.equal(f.calls.transport,calls);assert.equal(f.calls.custody,opens);
 }finally{h.dispose();}
});
test('feature disabled still reads and recovers a prepared command, without begin/use/custody/transport',async()=>{
 const x=input();await f.opCall('begin',{p_command_id:x.commandId,p_candidate_id:x.candidateId,p_signed_hash:x.signedHash,
  p_expected_a1_version:x.expectedA1Version,p_expected_identity_version:x.expectedIdentityVersion,p_confirmed:true});
 const h=handler(f.operationalService({enabled:false})),before=f.calls.rpc.length,calls=f.calls.transport,opens=f.calls.custody;try{
  const blocked=await read(await h(await request('run',x)),409);assert.equal(blocked.error,'RECONCILIATION_DISABLED');assert.equal(blocked.recovery_required,false);
  assert.equal((await read(await h(await request('command',x)))).status,'prepared');
  assert.equal((await read(await h(await request('recover',x)))).status,'prepared');
  await read(await h(await request('history',x)));
  assert.ok(f.calls.rpc.slice(before).every(n=>['_command','_history'].some(s=>n.endsWith(s))));
  assert.equal(f.calls.transport,calls);assert.equal(f.calls.custody,opens);
 }finally{h.dispose();}
});
test('HMAC domain, body binding and exact route payload fail before any SQL; current ACL gates another actor and revoked membership',async()=>{
 const x=input(),h=handler(f.operationalService());try{
  const before=f.calls.rpc.length;
  await read(await h(await request('run',x,{requestAudience:'another-reconciliation'})),401);
  await read(await h(await request('run',x,{bodyHash:'0'.repeat(64)})),401);
  await read(await h(await request('recover',x,{payload:{command_id:x.commandId,candidate_id:x.candidateId}})),400);
  assert.equal(f.calls.rpc.length,before);
  await read(await h(await request('run',x)));
  await read(await h(await request('command',x,{actor:f.users.admin})),403);
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[x.actor]);
  try{await read(await h(await request('command',x)),403);await read(await h(await request('history',x)),403);}
  finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[x.actor]);}
 }finally{h.dispose();}
});
test('synthetic 061 receipt is never projected as operational 062 or queried again',async()=>{
 const x=input(),old=await f.service().run(x);assert.equal(old.origin,'synthetic');
 const h=handler(f.operationalService()),calls=f.calls.transport;try{
  const command=await read(await h(await request('command',x)),409);assert.equal(command.error,'RECONCILIATION_CONFLICT');
  const recovered=await read(await h(await request('recover',x)),409);assert.equal(recovered.error,'RECONCILIATION_CONFLICT');assert.equal(recovered.receipt,undefined);
  assert.equal(f.calls.transport,calls);
 }finally{h.dispose();}
});
test('lost use ACK stays recoverable through the same command without another POST or credential opening',async()=>{
 const x=input();let once=true;
 const h=handler(f.operationalService({rpc:async(n,a,o)=>{const v=await f.opPorts.rpc(n,a,o);if(n==='erp_fiscal_protocol_use'&&once){once=false;throw Error('SYNTHETIC_PRIVATE_ACK');}return v;}}));
 try{
  const calls=f.calls.transport,out=await read(await h(await request('run',x)));assert.equal(out.status,'unconfirmed');assert.equal(out.recovery_required,true);assert.equal(f.calls.transport,calls);
  const opened=f.calls.custody,recover=handler(f.operationalService({enabled:false}));try{
   const current=await read(await recover(await request('command',x)));assert.equal(current.current.grant_consumed,true);
   const again=await read(await recover(await request('recover',x)));assert.equal(again.status,'unconfirmed');assert.equal(again.retry_transport_allowed,false);
   assert.equal(f.calls.transport,calls);assert.equal(f.calls.custody,opened);
  }finally{recover.dispose();}
 }finally{h.dispose();}
});
test('stored journal recovers after validator failure and A1 disable; historical selection and current A1 remain distinct',async()=>{
 const x=input(),h=handler(f.operationalService({validateProtocol:async(bytes,o)=>{if(o.direction==='response')throw Error('SYNTHETIC_VALIDATOR_UNAVAILABLE');return f.opPorts.validateProtocol(bytes,o);}}));
 try{assert.equal((await read(await h(await request('run',x)))).status,'unconfirmed');}finally{h.dispose();}
 const calls=f.calls.transport,opens=f.calls.custody,head=await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin});
 await f.callSql('erp_a1_disable',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_request_hash:'a'.repeat(64),p_expected_version:head.current.version,p_reason:'Synthetic fixture disable'});
 const off=handler(f.operationalService({enabled:false}));try{
  const recovered=await read(await off(await request('recover',x)));assert.equal(recovered.status,'stored');
  assert.equal(recovered.receipt.a1_version,x.expectedA1Version);assert.equal(recovered.current.a1_changed,true);assert.notEqual(recovered.current.a1_version,recovered.receipt.a1_version);
  assert.equal(recovered.sefaz_authorized,false);assert.equal(f.calls.transport,calls);assert.equal(f.calls.custody,opens);
  await read(await off(await request('command',x)));await read(await off(await request('history',x)));
 }finally{off.dispose();}
});
