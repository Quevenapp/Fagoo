import test from'node:test';import assert from'node:assert/strict';import{createTransientInviteAuth}from'../src/lib/invite-auth-client.ts';
const config={supabaseUrl:'https://syntheticproject.supabase.co',publicKey:'sb_publishable_synthetic_test_key_0000000',apiUrl:'https://api.synthetic.invalid'};
const id='10000000-0000-4000-8000-000000000001',user={id,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',email_confirmed_at:'2026-10-16T10:00:00Z',invited_at:'2026-10-16T09:00:00Z',app_metadata:{},user_metadata:{},created_at:'2026-10-16T09:00:00Z'};
const jwt=()=>[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'synthetic-signature'].join('.');
const session=()=>({access_token:jwt(),refresh_token:'synthetic_refresh_039',token_type:'bearer',expires_in:3600,user});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('transient SDK stays lazy, supports verify/user/password and only local-scope logout without sharing storage',async()=>{
 const calls=[];const port=createTransientInviteAuth(config,async(url,options)=>{calls.push({url:String(url),options});if(String(url).includes('/verify'))return response(session());if(String(url).includes('/logout'))return new Response(null,{status:204});return response(user);});assert.equal(calls.length,0);
 const verified=await port.auth.verifyOtp({token_hash:'a'.repeat(64),type:'invite'});assert.equal(verified.error,null);await port.auth.getUser();await port.auth.updateUser({password:'Synthetic password only!'});await port.endSession();assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/auth/v1/verify','/auth/v1/user','/auth/v1/user','/auth/v1/logout']);assert.equal(new URL(calls.at(-1).url).search,'?scope=local');
 for(const c of calls){assert.equal(new URL(c.url).origin,config.supabaseUrl);assert.equal(c.options.credentials,'omit');assert.equal(c.options.cache,'no-store');assert.equal(c.options.redirect,'error');}
 assert.deepEqual(JSON.parse(calls[2].options.body),{password:'Synthetic password only!',code_challenge:null,code_challenge_method:null});await assert.rejects(()=>port.auth.getUser(),e=>e.name==='AbortError');assert.equal(calls.length,4);
});
test('discard closes the port before SDK loading and never calls remote logout on an unverified invite',async()=>{
 let calls=0;const port=createTransientInviteAuth(config,async()=>{calls++;throw new Error('network must not run');});port.clearSession();await assert.rejects(()=>port.auth.verifyOtp({token_hash:'a'.repeat(64),type:'invite'}),e=>e.name==='AbortError');await port.endSession();assert.equal(calls,0);
});
test('discard aborts in-flight fetch and a late successful SDK response cannot restore the usable port',async()=>{
 let release,signal;const port=createTransientInviteAuth(config,async(_url,options)=>{signal=options.signal;return new Promise(r=>{release=r;});});const pending=port.auth.verifyOtp({token_hash:'a'.repeat(64),type:'invite'});while(!release)await new Promise(r=>setTimeout(r,1));port.clearSession();assert.equal(signal.aborted,true);release(response(session()));await assert.rejects(()=>pending,e=>e.name==='AbortError');await assert.rejects(()=>port.auth.getUser(),e=>e.name==='AbortError');
});
test('Auth responses are bounded and redirects are refused without following Location',async()=>{
 for(const reply of[()=>new Response('x'.repeat(524289)),()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid'}})]){let count=0;const port=createTransientInviteAuth(config,async()=>{count++;return reply();});const value=await port.auth.verifyOtp({token_hash:'a'.repeat(64),type:'invite'});assert.notEqual(value.error,null);assert.equal(count,1);port.clearSession();}
});
