import test from 'node:test';
import assert from 'node:assert/strict';
import {createReviewedAuthorizationRpc} from '../src/reviewed-ledger-rpc.mjs';
import {SUBSET_POLICY_HASHES,reviewedPreparationEvidence} from '../src/reviewed-ledger-dto.mjs';
const U='11111111-1111-4111-8111-111111111111',H='a'.repeat(64),G='b'.repeat(64);
const opts=ms=>({signal:new AbortController().signal,deadline:Date.now()+(ms??1000)});
const make=fetchImpl=>createReviewedAuthorizationRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-credential-not-secret',fetchImpl});
const proof=()=>({candidate_id:U,candidate_version:1,signed_hash:H,facts_hash:G,profile:'sp-crt1-internal-sale-homologation-20261016-v1',profile_hash:'e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504',review_id:U,review_version:1,review_hash:H,reviewed_by:U,reviewed_at:'2026-10-16T00:00:00.000Z',valid_until:'2026-10-25T23:59:59.000Z',coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false});
const preparation=()=>({origin:'operational',request_hash:H,payload_hash:G,signed_hash:H,model:'55',environment:'2',batch_id:'1',access_key:'35261012345678000195550010000000011000000010',reference_digest:Buffer.alloc(20,17).toString('base64'),certificate_fingerprint:H,schema_profile:'brufap-authorization-pl010f-v1.04',schema_manifest_hash:'6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda',validator_hash:'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612',binding_profile:'sp55-authorization-soap12-reviewed-20261016-v1',rule_profile:proof().profile,signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false});
const args=()=>({p_user_id:U,p_attempt_id:U,p_lease_id:U,p_request_hash:H,p_request_size:32,p_evidence:preparation(),p_rule_review:proof()});
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code&&e.message===code&&!JSON.stringify(e).includes('PRIVATE_SENTINEL'));
test('reviewed RPC captures nested proof/evidence and original signal before any await',async()=>{
 let captured,bytes;const rpc=make(async(url,o)=>{captured=JSON.parse(o.body.toString());bytes=o.body;assert.match(url,/erp_fiscal_reviewed_authorization_prepare$/);assert.equal(o.redirect,'manual');assert.equal(o.credentials,'omit');return Response.json({code:'40001',message:'PRIVATE_SENTINEL'},{status:400});});
 const a=args(),o=opts(),pending=rpc('erp_fiscal_reviewed_authorization_prepare',a,o);a.p_rule_review.review_hash=G;a.p_evidence.origin='synthetic';o.signal=new AbortController().signal;
 await rejects(()=>pending,'40001');assert.equal(captured.p_rule_review.review_hash,H);assert.equal(captured.p_evidence.origin,'operational');assert.ok(bytes.every(x=>x===0));
});
test('reviewed RPC rejects getters, unknown keys and false full-tax attestation before HTTP',async()=>{
 let calls=0,getters=0;const rpc=make(async()=>{calls++;throw Error('PRIVATE_SENTINEL');});
 const a=args();Object.defineProperty(a.p_rule_review,'review_hash',{enumerable:true,get(){getters++;return H;}});
 await assert.rejects(()=>rpc('erp_fiscal_reviewed_authorization_prepare',a,opts()));
 await assert.rejects(()=>rpc('erp_fiscal_reviewed_authorization_prepare',{...args(),p_unsafe:true},opts()));
 const b=args();b.p_evidence.tax_rules_validated=true;await assert.rejects(()=>rpc('erp_fiscal_reviewed_authorization_prepare',b,opts()));
 await rejects(()=>rpc('erp_fiscal_authorization_use',args(),opts()),'AUTHORIZATION_RPC_UNSUPPORTED');assert.equal(calls,0);assert.equal(getters,0);
 assert.equal(reviewedPreparationEvidence(preparation()).tax_rules_validated,false);assert.notEqual(SUBSET_POLICY_HASHES['55'],SUBSET_POLICY_HASHES['65']);
});
test('empty stream chunk fails immediately; unresolved cancellation does not extend the deadline',async()=>{
 let cancels=0,reads=0;const rpc=make(async()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array());},cancel(){cancels++;return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}}));
 const start=Date.now();await rejects(()=>rpc('erp_fiscal_reviewed_authorization_prepare',args(),opts(1000)),'AUTHORIZATION_RPC_BODY_LIMIT');assert.ok(Date.now()-start<500);assert.ok(reads<=2);assert.equal(cancels,1);
});
test('abort cancels a never-resolving HTTP driver and does not retry',async()=>{
 let calls=0,signal;const rpc=make(async(_url,o)=>{calls++;signal=o.signal;return new Promise(()=>{});}),controller=new AbortController();
 const pending=rpc('erp_fiscal_reviewed_authorization_prepare',args(),{signal:controller.signal,deadline:Date.now()+1000});await Promise.resolve();controller.abort();await rejects(()=>pending,'AUTHORIZATION_RPC_ABORTED');assert.equal(calls,1);assert.equal(signal.aborted,true);
});
test('deadline and response bounds sanitize failed, compressed, forged and oversized replies',async()=>{
 const query={p_user_id:U,p_command_id:U},name='erp_fiscal_reviewed_authorization_command';
 await rejects(()=>make(async()=>new Promise(()=>{}))(name,query,opts(15)),'AUTHORIZATION_RPC_TIMEOUT');
 for(const response of [Response.json({private:'PRIVATE_SENTINEL'}),Response.json({},{headers:{'content-encoding':'gzip'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'262145'}})])await assert.rejects(()=>make(async()=>response)(name,query,opts()),e=>!JSON.stringify(e).includes('PRIVATE_SENTINEL'));
 for(const code of ['42501','55000','P0002','22023'])await rejects(()=>make(async()=>Response.json({code,message:'PRIVATE_SENTINEL'},{status:400}))(name,query,opts()),code);
});
