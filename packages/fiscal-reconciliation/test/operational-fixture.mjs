import {readFile} from 'node:fs/promises';
import {createSecureContext} from 'node:tls';
import {serviceFixture} from './service-fixture.mjs';
import {createReconciliationService} from '../src/service.mjs';
import {OPERATIONAL_PROFILE,SERVER_TRUST_PROFILE,SERVER_TRUST_ANCHOR_SHA256} from '../src/profiles.mjs';
import {hash} from './fixture.mjs';
export async function operationalFixture({beforeMigration}={}){
 const f=await serviceFixture();try{
  if(beforeMigration)await beforeMigration(f);
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160062_fiscal_protocol_operational.sql',import.meta.url),'utf8'));
  const storage={...f.ports.storage,putImmutable:async o=>{if(!o.key.includes('/observations/'))return f.ports.storage.putImmutable(o);if(o.bytes.length>8192||hash(o.bytes)!==o.sha256||o.upsert!==false)throw Error('SYNTHETIC_STORAGE_REJECTED');f.calls.storage.push(['put',o.key]);if(f.files.has(o.key))return{status:409,requires_readback:true};f.files.set(o.key,Buffer.from(o.bytes));await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',o.key,JSON.stringify({size:o.bytes.length,mimetype:'application/octet-stream'})]);return{status:201,requires_readback:true};}};
  const transport=async({request,grant},session,o)=>{f.calls.transport++;if(grant.purpose!==OPERATIONAL_PROFILE||!session.secureContext||o.signal.aborted)throw Error('SYNTHETIC_TRANSPORT_REJECTED');return{response:new Response(f.response(request.accessKey,grant.reference_digest),{headers:{'content-type':'application/soap+xml'}}),tls:{protocol:'TLSv1.3',server_identity_verified:true,server_trust_profile:SERVER_TRUST_PROFILE,server_trust_anchor_sha256:SERVER_TRUST_ANCHOR_SHA256}};};
  const withPreparedSession=async(value,action,o)=>{f.calls.custody++;const m=value.execution.credential.metadata;await action(Object.freeze({secureContext:createSecureContext(),metadata:Object.freeze({fingerprint_sha256:m.fingerprint_sha256,holder_cnpj:m.holder_cnpj,not_before:m.not_before,not_after:m.not_after,client_auth_usage:'explicit_client_auth',presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,can_emit:false,can_transmit:false}),signal:o.signal,deadline:o.deadline}));};
  const ports={...f.ports,mode:'operational',enabled:true,storage,transport,withPreparedSession};
  return{...f,opPorts:ports,operationalService:(patch={})=>createReconciliationService({...ports,...patch}),opCall:(name,args)=>f.callSql('erp_fiscal_protocol_'+name,{p_user_id:f.input.actor,...args})};
 }catch(e){await f.close();throw e;}
}
