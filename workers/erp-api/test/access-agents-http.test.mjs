import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{createHandler}from'../src/index.mjs';
import{AGENT_TOKEN,isAgentToken,agentTokenHash,agentResolution}from'../src/agent-auth.mjs';

// Agent access (202611130001): the token path of the Worker. Synthetic data only.
const AGENT='10000000-0000-4000-8000-000011130001',TOKEN_ID='20000000-0000-4000-8000-000011130001',BASE='https://project.supabase.co';
const TOKEN='fagoo_agt_'+'A1b2C3d4_-'.repeat(4)+'xyz',HASH=createHash('sha256').update(TOKEN).digest('hex');
const off={SUPABASE_URL:BASE,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.synthetic.test'},env={...off,ERP_AGENT_ACCESS_ENABLED:'true'};
const call=(h,path,{token=TOKEN,origin=null,environment=env}={})=>h(new Request('https://api.synthetic.test'+path,{headers:{Authorization:`Bearer ${token}`,...(origin?{Origin:origin}:{})}}),environment);
const resolved={scope:'agent_access',status:'ok',user_id:AGENT,token_id:TOKEN_ID};
const gate=(over={})=>({scope:'access_gate',data_mode:'erp_native',user_id:AGENT,open:true,until:null,mfa_required:false,mfa_ok:true,...over});
const me=(over={})=>({user_id:AGENT,role:'consulta',resources:['contacts','products'],data_mode:'staging_readonly',access_window:'open',gate_required:false,...over});
/** A database that answers the three calls of an agent on /v1/me; `calls` keeps what the Worker sent. */
const backend=({resolve=resolved,gateAnswer=gate(),meAnswer=me()}={})=>{const calls=[];
 return{calls,handler:createHandler({fetchImpl:async(url,o)=>{calls.push({path:url.replace(BASE,''),o});
  return Response.json(url.endsWith('/erp_access_agent_resolve')?resolve:url.endsWith('/erp_access_gate_v2')?gateAnswer:meAnswer);}})};};
const code=async response=>(await response.json()).error.code;

test('agent token: the format, the hash and the answers the database may give',async()=>{
 assert.equal(AGENT_TOKEN.test(TOKEN),true);assert.equal(TOKEN.length,53);
 for(const bad of['fagoo_agt_','fagoo_agt_short',TOKEN+'x',TOKEN.slice(0,-1)+'.',' '+TOKEN])assert.equal(AGENT_TOKEN.test(bad),false,bad);
 assert.deepEqual([isAgentToken(TOKEN),isAgentToken('fagoo_agt_short'),isAgentToken('eyJhbGciOi.synthetic.jwt'),isAgentToken(null)],[true,true,false,false]);
 assert.equal(await agentTokenHash(TOKEN),HASH);
 assert.deepEqual(agentResolution(resolved),{status:'ok',userId:AGENT});
 assert.deepEqual(agentResolution({scope:'agent_access',status:'unknown'}),{status:'unknown'});
 assert.deepEqual(agentResolution({scope:'agent_access',status:'denied',user_id:AGENT}),{status:'denied'});
 for(const bad of[null,[],'ok',{status:'ok',user_id:AGENT},{scope:'agent_access',status:'ok'},{scope:'agent_access',status:'ok',user_id:'x'},{scope:'agent_access',status:'other',user_id:AGENT}])
  assert.equal(agentResolution(bad),null,JSON.stringify(bad));
});

test('agent access is off by default: the token is refused without any upstream call and never reaches Auth',async()=>{
 const b=backend();
 for(const environment of[off,{...off,ERP_AGENT_ACCESS_ENABLED:'false'},{...off,ERP_AGENT_ACCESS_ENABLED:true},{...off,ERP_AGENT_ACCESS_ENABLED:'TRUE'}]){
  const r=await call(b.handler,'/v1/me',{environment});assert.equal(r.status,401);assert.equal(await code(r),'ERP_UNAUTHENTICATED');}
 assert.equal(b.calls.length,0);
});

test('an agent is resolved by the hash of its token, gated without a session and then served like any member',async()=>{
 const b=backend(),r=await call(b.handler,'/v1/me');
 assert.equal(r.status,200);const body=await r.json();assert.deepEqual([body.user_id,body.role],[AGENT,'consulta']);
 assert.deepEqual(b.calls.map(c=>c.path),['/rest/v1/rpc/erp_access_agent_resolve','/rest/v1/rpc/erp_access_gate_v2','/rest/v1/rpc/erp_access_me']);
 assert.deepEqual(JSON.parse(b.calls[0].o.body),{p_token_hash:HASH});
 assert.deepEqual(JSON.parse(b.calls[1].o.body),{p_user_id:AGENT,p_session_id:null});
 assert.deepEqual(JSON.parse(b.calls[2].o.body),{p_user_id:AGENT});
 // Only the service key authorizes the upstream calls; the token itself leaves the Worker nowhere.
 for(const c of b.calls){assert.equal(c.o.headers.Authorization,'Bearer synthetic-service');assert.equal(JSON.stringify([c.path,c.o.headers,c.o.body]).includes(TOKEN),false);}
 // The gate answer is kept for the minute, the token is resolved at every request.
 assert.equal((await call(b.handler,'/v1/me')).status,200);
 assert.deepEqual(b.calls.slice(3).map(c=>c.path),['/rest/v1/rpc/erp_access_agent_resolve','/rest/v1/rpc/erp_access_me']);
});

test('an agent under the MFA policy is not flagged in Auth: /v1/me writes nothing for it',async()=>{
 const b=backend({meAnswer:me({gate_required:true})}),r=await call(b.handler,'/v1/me');
 assert.equal(r.status,200);assert.equal(b.calls.some(c=>c.path.includes('/auth/')),false);
});

test('unknown, revoked or expired tokens are unauthenticated; an agent out of its limits is refused by name',async()=>{
 for(const[resolve,status,name]of[[{scope:'agent_access',status:'unknown'},401,'ERP_UNAUTHENTICATED'],[{scope:'agent_access',status:'denied'},403,'ERP_AGENT_ACCESS_DENIED'],
  [{scope:'other',status:'ok',user_id:AGENT},502,'ERP_UPSTREAM_INVALID_RESPONSE'],[{scope:'agent_access',status:'ok',user_id:'x'},502,'ERP_UPSTREAM_INVALID_RESPONSE']]){
  const b=backend({resolve}),r=await call(b.handler,'/v1/me');assert.equal(r.status,status,name);assert.equal(await code(r),name);
  assert.deepEqual(b.calls.map(c=>c.path),['/rest/v1/rpc/erp_access_agent_resolve'],name);}
 // A malformed token carrying the prefix is refused before any call, and is not tried as a session.
 const b=backend();for(const token of['fagoo_agt_short',TOKEN+'x'])assert.equal((await call(b.handler,'/v1/me',{token})).status,401);assert.equal(b.calls.length,0);
});

test('the gate decides for an agent too: access windows and, with no session, any second-factor requirement',async()=>{
 for(const[gateAnswer,name]of[[gate({open:false}),'ERP_ACCESS_OUTSIDE_SCHEDULE'],[gate({mfa_required:true,mfa_ok:false}),'ERP_MFA_REQUIRED']]){
  const b=backend({gateAnswer}),r=await call(b.handler,'/v1/me');assert.equal(r.status,403,name);assert.equal(await code(r),name);
  assert.equal(b.calls.some(c=>c.path.endsWith('/erp_access_me')),false,name);}
 const forged=backend({gateAnswer:gate({user_id:'30000000-0000-4000-8000-000011130001'})});assert.equal((await call(forged.handler,'/v1/me')).status,502);
});

test('an agent token is not a browser credential and is refused on the security, system update and Wabotia pairing routes',async()=>{
 const b=backend(),browser=await call(b.handler,'/v1/me',{origin:'https://erp.synthetic.test'});
 assert.equal(browser.status,403);assert.equal(await code(browser),'ERP_ORIGIN_NOT_ALLOWED');
 const security=await call(b.handler,'/v1/seguranca/politica');assert.equal(security.status,403);assert.equal(await code(security),'ERP_FORBIDDEN');
 const updates=await call(b.handler,'/v1/system/updates',{environment:{...env,SUPABASE_DEPLOYMENT:'self-hosted',FAGOO_UPDATE_AGENT_TOKEN:'a'.repeat(64)}});
 assert.equal(updates.status,403);
 const pairing=await call(b.handler,'/v1/system/wabotia');assert.equal(pairing.status,403);assert.equal(await code(pairing),'ERP_FORBIDDEN');
 assert.equal(b.calls.length,0);
});

test('session tokens keep their path: Auth validates them and no agent call is made',async()=>{
 const USER='40000000-0000-4000-8000-000011130001',calls=[];
 const h=createHandler({fetchImpl:async url=>{calls.push(url.replace(BASE,''));return Response.json(url.endsWith('/auth/v1/user')?{id:USER}:me({user_id:USER,access_window:undefined,gate_required:undefined}));}});
 for(const environment of[off,env]){calls.length=0;
  const r=await call(h,'/v1/me',{token:'synthetic.session.token',origin:'https://erp.synthetic.test',environment});assert.equal(r.status,200);
  assert.deepEqual(calls,['/auth/v1/user','/rest/v1/rpc/erp_access_me']);}
 const anonymous=createHandler({fetchImpl:async()=>Response.json({id:USER,is_anonymous:true})});
 assert.equal((await call(anonymous,'/v1/me',{token:'synthetic.session.token'})).status,403);
 const invalid=createHandler({fetchImpl:async()=>Response.json({id:'x'})});
 assert.equal((await call(invalid,'/v1/me',{token:'synthetic.session.token'})).status,401);
});
