// Synthetic SQL050/068/069, PKCS12 and injected HTTP. No real credentials/network.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reviewedFixture,hash} from './reviewed-ledger-fixture.mjs';
import {createAuthorizationDispatchService} from '../src/dispatch-service.mjs';
import {createAuthorizationPreparationAuthorizer} from '../src/dispatch-preparation.mjs';
import {createAuthorizationDispatchTransport} from '../src/dispatch-transport.mjs';
import {createAuthorizationCustodyPort} from '../../fiscal-runtime/src/authorization-custody.mjs';
import {createAuthorizationVaultReader} from '../../fiscal-runtime/src/authorization-vault-read.mjs';
import {createSpAuthorizationTlsLoader} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {createOpenSslLoader,sealCredential,envelopeBytes} from '../../fiscal-vault/src/index.mjs';
import {trustFixture} from '../../fiscal-vault/test/trust-fixtures.mjs';
import {exportPfx,binary,PASSWORD,KEK} from '../../fiscal-vault/test/fixtures.mjs';
import {wire} from '../../fiscal-reconciliation/test/protocol-wire.mjs';
export {hash};
export async function dispatchFixture({certificates:provided,createContext,sourceOptions}={}){
 const certificates=provided??await trustFixture(),events=[],owned=[];let envelope,sealed,vaultKey;
 const f=await reviewedFixture({sourceOptions,credential:certificates.leaf,configureCredential:async(db)=>{
  const head=await db.callSql('erp_a1_metadata',{p_user_id:db.users.admin}),command=randomUUID();
  const reserved=await db.callSql('erp_a1_reserve',{p_user_id:db.users.admin,p_command_id:command,p_request_hash:hash(randomUUID()),p_action:'configure',p_expected_version:head.current.version,p_expected_identity_version:1,p_reason:'PKCS12 fictício para teste local do envio'});
  const pfx=await exportPfx(certificates.leaf,[certificates.intermediate,certificates.root]);
  try{envelope=await sealCredential({pfxBytes:pfx,passwordBytes:PASSWORD,context:reserved.context,kekBytes:KEK,keyId:'dispatch-test',loader:await createOpenSslLoader({binaryPath:binary}),now:new Date()});}finally{pfx.fill(0);}
  sealed=envelopeBytes(envelope);vaultKey=`credentials/${reserved.credential_id}/${hash(sealed)}.json`;
  await db.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',vaultKey,JSON.stringify({size:sealed.length,mimetype:'application/json'})]);
  await db.callSql('erp_a1_finalize',{p_user_id:db.users.admin,p_command_id:command,p_lease_id:reserved.lease_id,p_metadata:envelope.metadata,p_object_hash:hash(sealed),p_size_bytes:sealed.length,p_key_id:'dispatch-test'});
 }});
 try{
  const version=await f.enable(),loader=await createSpAuthorizationTlsLoader({binaryPath:binary},createContext?{createContext}:{});
  const reader=f.reader,rpc=f.rpc;
  const source=async(model='55')=>{const c=await f.candidate(model);await f.review(c);return{...c,input:{...c.input,expectedPolicyVersion:version}};};
  function compose(c,patch={}){
   const selectedRpc=patch.rpc??(async(n,a,o)=>{events.push(n);return rpc(n,a,o);});
   const readReview=patch.readReview??(async(q,o)=>{events.push('review');return reader(q,o);});
   const authorize=createAuthorizationPreparationAuthorizer({rpc:selectedRpc,readReview});
   const vaultReader=createAuthorizationVaultReader({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-service-key-no-real-secret',fetchImpl:async(url,o)=>{
    events.push('vault-read');assert.equal(o.method,'GET');assert.equal(url.split('brufap-a1-vault/')[1],vaultKey);assert.equal(o.redirect,'manual');
    return new Response(Buffer.from(sealed),{headers:{'content-type':'application/json','content-length':String(sealed.length)}});
   }});
   const custody=createAuthorizationCustodyPort({keyring:new Map([['dispatch-test',KEK]]),authorizePreparation:patch.authorize??(async(v,o)=>{events.push('authorize');return authorize(v,o);}),
    readObject:patch.readObject??(async(r,o)=>{const b=await vaultReader(r,o);owned.push(b);return b;}),loader:{async withContext(v,action){events.push('pkcs12');owned.push(v.pfxBytes,v.passwordBytes);return loader.withContext(v,action);}}});
   let request;const transport=patch.transport??(async(v,session,o)=>{
    const body=soapResponse(c,v.request.batchId,patch.responseOptions);const driver=wire({body});
    const send=createAuthorizationDispatchTransport({requestImpl:(options,cb)=>{events.push('POST');request={options,trace:driver.trace};return driver.requestImpl(options,cb);}});
    return send(v,session,o);
   });
   const ports={enabled:true,rpc:selectedRpc,storage:f.ports.storage,validate:patch.validate??f.ports.validate,readReview,withPreparedSession:patch.withPreparedSession??custody,transport};
   return{ports,service:createAuthorizationDispatchService({...ports,...(patch.enabled===undefined?{}:{enabled:patch.enabled})}),request:()=>request,authorize,custody};
  }
  function soapResponse(c,batchId,options={}){const payload=f.response({...c.request,batchId},options).toString();const binding=c.request.model==='55'?'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4':'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4';return Buffer.from(`<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${binding}">${payload.replace(/^<\?xml[^?]*\?>/,'')}</nfeResultMsg></Body></Envelope>`);}
  return{...f,source,compose,soapResponse,certificates,envelope,sealed,vaultKey,events,owned,version,close:async()=>{sealed?.fill(0);if(!provided)for(const x of [certificates.leaf,certificates.intermediate,certificates.root])x.privateDer.fill(0);await f.close();}};
 }catch(e){await f.close();throw e;}
}
