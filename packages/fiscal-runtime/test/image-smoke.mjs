// Mount read-only into the production image; all inputs and upstream responses are synthetic.
import assert from 'node:assert/strict';
import {access,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {fromEnvironment} from '/app/packages/fiscal-runtime/src/server.mjs';
import {digest,signRuntimeRequest} from '/app/packages/fiscal-signed-runtime/src/auth.mjs';
import {signRuntimeRequest as signDanfe} from '/app/packages/fiscal-danfe-runtime/src/auth.mjs';
import {signRuntimeRequest as signProtocol} from '/app/packages/fiscal-reconciliation-runtime/src/auth.mjs';
import {signRuntimeRequest as signAuthorization} from '/app/packages/fiscal-authorization-runtime/src/auth.mjs';
assert.notEqual(process.getuid(),0);
for(const name of ['/app/private','/app/Backup','/app/.env','/app/packages/fiscal-runtime/test'])await assert.rejects(access(name));
const rootFiles=await readdir('/app/packages',{recursive:true});
assert.equal(rootFiles.some(name=>/\.(?:pfx|p12|key)$/.test(name)),false);
const transport=randomBytes(32),actor=randomUUID(),candidate=randomUUID();let calls=0;
const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-image-service-key',A1_TRANSPORT_SECRET:transport.toString('base64'),
 A1_TRANSPORT_KEY_ID:'image-test',A1_AUDIENCE:'image-test',A1_FINGERPRINT_SECRET:randomBytes(32).toString('base64'),
 A1_KEK_RING_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),A1_CURRENT_KEK_ID:'synthetic',A1_OPENSSL_PATH:'/usr/bin/openssl'};
const runtime=await fromEnvironment(env,{fetchImpl:async(url,options)=>{
 calls++;
 if(url==='https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/erp_access_me'){
  assert.deepEqual(JSON.parse(options.body),{p_user_id:actor});
  return Response.json({user_id:actor,role:'admin',resources:[],data_mode:'staging_readonly'});
 }
 assert.equal(url,'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/erp_fiscal_signed_get');
 assert.deepEqual(JSON.parse(options.body),{p_user_id:actor,p_candidate_id:candidate});
 return Response.json({code:'42501',message:'Synthetic denial'},{status:403});
}});
try{
 for(const path of ['/internal/v1/a1',`/internal/v1/fiscal-signed/candidates/${candidate}`,`/internal/v1/fiscal-danfe/candidates/${candidate}/preview`,`/internal/v1/fiscal-reconciliation/commands/${candidate}`,'/internal/v1/fiscal-authorization/reviewed/status']){
  const result=await runtime.handler(new Request(`http://runtime.internal${path}`));assert.equal(result.status,401);
 }
 assert.equal(calls,0);
 const path=`/internal/v1/fiscal-signed/candidates/${candidate}`;
 const authorization=await signRuntimeRequest({secretBytes:transport,keyId:'image-test',audience:'image-test-signed',actor,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(new Uint8Array())});
 const result=await runtime.handler(new Request(`http://runtime.internal${path}`,{headers:{Authorization:authorization}}));
 assert.equal(result.status,403);assert.equal((await result.json()).error,'SIGNED_FORBIDDEN');assert.equal(calls,1);
 const previewPath=`/internal/v1/fiscal-danfe/candidates/${candidate}/preview`;
 const previewAuth=await signDanfe({secretBytes:transport,keyId:'image-test',audience:'image-test-danfe',actor,nonce:randomUUID(),method:'GET',path:previewPath,bodyHash:await digest(new Uint8Array())});
 const preview=await runtime.handler(new Request(`http://runtime.internal${previewPath}`,{headers:{Authorization:previewAuth}}));
 assert.equal(preview.status,403);assert.deepEqual(await preview.json(),{error:'DANFE_FORBIDDEN',recovery_required:false});assert.equal(calls,2);
 const protocolPath='/internal/v1/fiscal-reconciliation/run',body=JSON.stringify({command_id:randomUUID(),candidate_id:candidate,signed_hash:'a'.repeat(64),expected_a1_version:1,expected_identity_version:1,confirmed:true});
 const protocolAuth=await signProtocol({secretBytes:transport,keyId:'image-test',audience:'image-test-reconciliation',actor,nonce:randomUUID(),method:'POST',path:protocolPath,bodyHash:await digest(new TextEncoder().encode(body))});
 const protocol=await runtime.handler(new Request(`http://runtime.internal${protocolPath}`,{method:'POST',headers:{Authorization:protocolAuth,'Content-Type':'application/json'},body}));
 assert.equal(protocol.status,409);assert.deepEqual(await protocol.json(),{error:'RECONCILIATION_DISABLED',recovery_required:false});assert.equal(calls,2);
 const reviewedPath='/internal/v1/fiscal-authorization/reviewed/status';
 const reviewedAuth=await signAuthorization({secretBytes:transport,keyId:'image-test',audience:'image-test-authorization',actor,nonce:randomUUID(),method:'GET',path:reviewedPath,bodyHash:await digest(new Uint8Array())});
 const reviewed=await runtime.handler(new Request('http://runtime.internal'+reviewedPath,{headers:{Authorization:reviewedAuth}}));
 assert.equal(reviewed.status,200);const reviewedStatus=await reviewed.json();assert.equal(reviewedStatus.runtime_enabled,false);assert.equal(reviewedStatus.policy_checked,false);assert.equal(reviewedStatus.can_transmit,false);assert.equal(calls,3);
 const reviewedRunPath='/internal/v1/fiscal-authorization/reviewed/run',reviewedCommand=randomUUID(),reviewedBody=JSON.stringify({request_profile:'authorization-reviewed-selection-v1',command_id:reviewedCommand,candidate_id:candidate,signed_hash:'a'.repeat(64),expected_candidate_version:1,expected_a1_version:1,expected_identity_version:1,expected_policy_version:1,expected_review_id:randomUUID(),expected_review_version:1,expected_review_hash:'b'.repeat(64),expected_facts_hash:'c'.repeat(64),expected_profile_hash:'d'.repeat(64),confirmed:true});
 const reviewedRunAuth=await signAuthorization({secretBytes:transport,keyId:'image-test',audience:'image-test-authorization',actor,nonce:randomUUID(),method:'POST',path:reviewedRunPath,bodyHash:await digest(new TextEncoder().encode(reviewedBody))});
 const reviewedRun=await runtime.handler(new Request('http://runtime.internal'+reviewedRunPath,{method:'POST',headers:{Authorization:reviewedRunAuth,'Content-Type':'application/json'},body:reviewedBody}));
 assert.equal(reviewedRun.status,503);assert.deepEqual(await reviewedRun.json(),{error:'AUTHORIZATION_SERVICE_DISABLED',recovery_required:false,command_id:reviewedCommand});assert.equal(calls,3);
 for(const key of ['SUPABASE_SERVICE_ROLE_KEY','A1_TRANSPORT_SECRET','A1_FINGERPRINT_SECRET','A1_KEK_RING_JSON'])assert.equal(Object.hasOwn(env,key),false);
 console.log(JSON.stringify({production_image:'verified',non_root:true,private_files:false,synthetic_auth_checks:10,protocol_enabled:false,reviewed_enabled:false,real_certificate_used:false,can_transmit:false,node:process.version}));
}finally{runtime.dispose();transport.fill(0);}
