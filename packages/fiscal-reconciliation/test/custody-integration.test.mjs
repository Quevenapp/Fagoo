// Entirely synthetic: isolated SQL 062, PKCS12 generated in RAM, fake HTTP/socket
// drivers and a fixture XSD report. This is not evidence of a SEFAZ consultation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operationalFixture} from './operational-fixture.mjs';
import {wire} from './protocol-wire.mjs';
import {hash} from './fixture.mjs';
import {createReconciliationRpc} from '../src/rpc.mjs';
import {createProtocolPreparationAuthorizer} from '../src/preparation.mjs';
import {createProtocolTransport} from '../src/protocol-transport.mjs';
import {createProtocolCustodyPort} from '../../fiscal-runtime/src/protocol-custody.mjs';
import {createSpProtocolTlsLoader} from '../../fiscal-runtime/src/protocol-server-trust.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {binary,exportPfx,PASSWORD,KEK,HOLDER} from '../../fiscal-vault/test/fixtures.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';

let f,tls,envelope,raw,key,version;
const sources=new Map(),owned=[],events=[];
test.before(async()=>{
 f=await operationalFixture();
 const certificates=await trustFixture(),pfx=await exportPfx(certificates.leaf,[certificates.intermediate,certificates.root]);
 const offline=await createOpenSslLoader({binaryPath:binary});tls=await createSpProtocolTlsLoader({binaryPath:binary});
 const head=await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin});
 const company=await f.callSql('erp_company_get',{p_user_id:f.users.admin,p_section:'identity'});assert.equal(company.record.data.cnpj,HOLDER);
 const commandId=randomUUID(),reserved=await f.callSql('erp_a1_reserve',{p_user_id:f.users.admin,p_command_id:commandId,p_request_hash:hash(randomUUID()),
  p_action:'configure',p_expected_version:head.current.version,p_expected_identity_version:company.record.version,p_reason:'PKCS12 fictício exclusivamente no teste em memória'});
 try{envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:reserved.context,kekBytes:KEK,keyId:'integration-fixture',loader:offline,now:new Date()});}finally{pfx.fill(0);}
 raw=envelopeBytes(envelope);key=`credentials/${reserved.credential_id}/${hash(raw)}.json`;
 await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',key,JSON.stringify({size:raw.length,mimetype:'application/json'})]);
 const configured=await f.callSql('erp_a1_finalize',{p_user_id:f.users.admin,p_command_id:commandId,p_lease_id:reserved.lease_id,p_metadata:envelope.metadata,p_object_hash:hash(raw),p_size_bytes:raw.length,p_key_id:'integration-fixture'});
 version=configured.current.version;f.input.expectedA1Version=version;sources.set('55',{...f.input});
 const next=await f.source('65');sources.set('65',{...f.input,candidateId:next.receipt.candidate_id,signedHash:next.artifact.signed_hash});
});
test.after(async()=>{raw?.fill(0);await f?.close();});
const input=(model='55')=>({...sources.get(model),commandId:randomUUID()});
function compose(x,patch={}){
 const traces=[],before=events.length;
 const rpc=createReconciliationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-service-role-no-real-credential',fetchImpl:async(url,o)=>{
  assert.equal(o.method,'POST');assert.equal(o.redirect,'manual');assert.equal(o.headers['Accept-Encoding'],'identity');assert.ok(o.signal instanceof AbortSignal);
  const name=url.split('/').at(-1),args=JSON.parse(Buffer.from(o.body).toString('utf8'));assert.equal(args.p_user_id,x.actor);
  events.push(name);
  try{return new Response(JSON.stringify(await f.callSql(name,args)),{headers:{'content-type':'application/json'}});}
  catch(error){return new Response(JSON.stringify({code:error.code,message:'SYNTHETIC_PRIVATE_SQL_DETAIL'}),{status:400,headers:{'content-type':'application/json'}});}
 }});
 const selectedRpc=patch.rpc?patch.rpc(rpc):rpc;
 const authorize=createProtocolPreparationAuthorizer({rpc:selectedRpc});
 const withPreparedSession=createProtocolCustodyPort({keyring:new Map([['integration-fixture',KEK]]),
  authorizePreparation:async(v,o)=>{events.push('authorize');return patch.authorize?patch.authorize(v,o,authorize):authorize(v,o);},
  readObject:async object=>{events.push('open-envelope');assert.equal(object.bucket,'brufap-a1-vault');assert.equal(object.path,key);assert.equal(object.hash,hash(raw));assert.equal(object.size,raw.length);
   const command=await f.opCall('command',{p_command_id:x.commandId});assert.equal(command.current.state,'prepared');assert.equal(command.current.grant_consumed,false);
   const bytes=Buffer.from(raw);owned.push(bytes);return bytes;},
  loader:{async withContext(v,action){events.push('load-pkcs12');owned.push(v.pfxBytes,v.passwordBytes);await tls.withContext(v,action);}},
 });
 const transport=async(value,session,o)=>{
  const command=await f.opCall('command',{p_command_id:x.commandId});assert.equal(command.current.grant_consumed,true);assert.equal(command.current.state,'dispatched');
  assert.equal(session.metadata.fingerprint_sha256,envelope.metadata.fingerprint_sha256);
  assert.equal(session.metadata.icp_brasil_chain_validated,false);assert.equal(session.metadata.can_transmit,false);
  const driver=wire({body:f.response(value.request.accessKey,value.grant.reference_digest)});traces.push(driver.trace);
  const actual=createProtocolTransport({requestImpl:(options,callback)=>{events.push('requestImpl');assert.equal(options.rejectUnauthorized,true);assert.equal(options.method,'POST');assert.equal(options.hostname,new URL(value.request.endpoint).hostname);assert.equal(options.headers['Accept-Encoding'],'identity');return driver.requestImpl(options,callback);}});
  return actual(value,session,o);
 };
 const service=f.operationalService({rpc:selectedRpc,withPreparedSession,transport,...(patch.validateProtocol?{validateProtocol:patch.validateProtocol}:{})});
 return{service,traces,events:()=>events.slice(before),rpc:selectedRpc};
}
const wiped=()=>owned.forEach(b=>assert.ok(b.every(x=>x===0),'owned credential bytes must be wiped'));
test('SQL 062→RPC→AEAD041→PKCS12→branded TLS→single consumed grant→fixed POST, for 55 and 65',async()=>{
 for(const model of ['55','65']){
  const x=input(model),c=compose(x),result=await c.service.run(x);assert.equal(result.status,'stored',JSON.stringify(result));
  assert.equal(result.receipt.model,model);assert.equal(result.receipt.a1_version,version);assert.equal(result.artifact.cstat,'217');assert.equal(result.artifact.tls_origin_verified,true);
  assert.equal(result.sefaz_authorized,false);assert.equal(result.can_query,false);assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);
  const sequence=c.events();assert.ok(sequence.indexOf('authorize')<sequence.indexOf('open-envelope'));assert.ok(sequence.indexOf('open-envelope')<sequence.indexOf('load-pkcs12'));
  assert.ok(sequence.indexOf('load-pkcs12')<sequence.indexOf('erp_fiscal_protocol_use'));assert.ok(sequence.indexOf('erp_fiscal_protocol_use')<sequence.indexOf('requestImpl'));
  assert.equal(sequence.filter(n=>n==='erp_fiscal_protocol_use').length,1);assert.equal(c.traces.length,1);assert.equal(c.traces[0].ends,1);
  const sql=await f.opCall('command',{p_command_id:x.commandId}),ctx=sql.recovery.context;
  assert.equal(hash(c.traces[0].bytes),ctx.request_hash);assert.equal(c.traces[0].bytes.length,ctx.request_size);
  assert.equal(hash(f.files.get(`reconciliation/${ctx.attempt_id}/responses/${ctx.request_hash}.xml`)),sql.artifact.response_hash);
  assert.equal(sql.artifact.evidence.transport.client.certificate_fingerprint,envelope.metadata.fingerprint_sha256);
  assert.equal(sql.artifact.evidence.transport.client.icp_brasil_chain_validated,false);assert.equal(envelope.context.purpose,'offline-homologation');
  const count=c.events().length,replay=await c.service.run(x);assert.equal(replay.status,'stored');assert.equal(replay.recovered,true);
  assert.ok(c.events().slice(count).every(n=>n==='erp_fiscal_protocol_command'));assert.equal(c.traces.length,1);wiped();
 }
});
test('revoked preparation ACL refuses custody before any envelope read or grant use',async()=>{
 const x=input(),c=compose(x,{authorize:async(v,o,authorize)=>{
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[x.actor]);return authorize(v,o);
 }});
 try{const result=await c.service.run(x);assert.notEqual(result.status,'stored');assert.equal(c.traces.length,0);assert.ok(!c.events().includes('open-envelope'));assert.ok(!c.events().includes('erp_fiscal_protocol_use'));}
 finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[x.actor]);}
 wiped();
});
test('lost use ACK cannot perform a handshake or POST; recovery reads only the existing command and journal',async()=>{
 const x=input();let lost=false;
 const c=compose(x,{rpc:rpc=>async(n,a,o)=>{const value=await rpc(n,a,o);if(n==='erp_fiscal_protocol_use'&&!lost){lost=true;throw Error('SYNTHETIC_PRIVATE_LOST_ACK');}return value;}});
 const out=await c.service.run(x);assert.equal(out.status,'unconfirmed');assert.equal(out.retry_transport_allowed,false);assert.equal(c.traces.length,0);
 const start=c.events().length,recovered=await c.service.recover({actor:x.actor,commandId:x.commandId});assert.equal(recovered.status,'unconfirmed');
 assert.ok(c.events().slice(start).every(n=>n==='erp_fiscal_protocol_command'));assert.equal(c.traces.length,0);wiped();
});
test('lost finish ACK plus unavailable readback recovers later without reopening or another use/POST',async()=>{
 const x=input('65');let finished=false,unavailable=true;
 const c=compose(x,{rpc:rpc=>async(n,a,o)=>{if(n==='erp_fiscal_protocol_command'&&finished&&unavailable)throw Error('SYNTHETIC_PRIVATE_READBACK');const value=await rpc(n,a,o);if(n==='erp_fiscal_protocol_finish'&&!finished){finished=true;throw Error('SYNTHETIC_PRIVATE_FINISH_ACK');}return value;}});
 const out=await c.service.run(x);assert.equal(out.status,'unconfirmed');assert.equal(c.traces.length,1);wiped();
 unavailable=false;const start=c.events().length,recovered=await c.service.recover({actor:x.actor,commandId:x.commandId});assert.equal(recovered.status,'stored');assert.equal(recovered.recovered,true);
 assert.ok(c.events().slice(start).every(n=>n==='erp_fiscal_protocol_command'));assert.equal(c.traces[0].ends,1);wiped();
});
