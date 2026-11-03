import test from'node:test';import assert from'node:assert/strict';
import{startEnrollment,verifyCode,removeFactor,changePassword,passwordProblem,mfaFactors,accountSecurityMessage,AccountSecurityError}from'../src/lib/account-security.ts';
import{parseSecurityPolicy,parseSecurityPolicyAnswer,parseMfaResetAnswer}from'../../../packages/erp-domain/src/access-security.mjs';

// Leva H, lane acesso (PRF-208, PRF-291): the own second factor and password change against a synthetic Auth port.
const ok=data=>({data,error:null}),err=(code,status=400)=>({data:null,error:{code,status,message:code}});
function port(over={}){const calls=[];let factors=[];const p={calls,set factors(v){factors=v;},
 mfa:{async listFactors(){calls.push('list');return ok({all:factors});},async enroll(v){calls.push(['enroll',v.factorType]);return ok({id:'f-new',totp:{qr_code:'data:image/svg+xml;utf-8,<svg/>',secret:'SECRET',uri:'otpauth://x'}});},
  async challengeAndVerify(v){calls.push(['verify',v]);return v.code==='123456'?ok({}):err('mfa_verification_failed',422);},async unenroll(v){calls.push(['unenroll',v.factorId]);return ok({});}},
 async updateUser(v){calls.push(['update',v]);return ok({});},async reauthenticate(){calls.push('reauth');return ok({});},...over};return p;}

test('enrollment removes unfinished factors first and never starts over a verified one',async()=>{
 const p=port();p.factors=[{id:'old',factor_type:'totp',status:'unverified'}];
 const started=await startEnrollment(p);assert.equal(started.factorId,'f-new');assert.deepEqual(p.calls,['list',['unenroll','old'],['enroll','totp']]);
 p.factors=[{id:'v',factor_type:'totp',status:'verified'}];await assert.rejects(()=>startEnrollment(p),e=>e instanceof AccountSecurityError&&e.reason==='already_enrolled');
 assert.equal((await mfaFactors(p)).verified.id,'v');
 const bad=port({mfa:{...port().mfa,async enroll(){return ok({id:'x',totp:{qr_code:'javascript:alert(1)',secret:'s'}});}}});await assert.rejects(()=>startEnrollment(bad),e=>e.reason==='unavailable');
});

test('codes: six digits (spaces ignored) go to Auth; a refused code is invalid_code',async()=>{
 const p=port();await verifyCode(p,'f1','123 456');assert.deepEqual(p.calls.at(-1),['verify',{factorId:'f1',code:'123456'}]);
 await assert.rejects(()=>verifyCode(p,'f1','12345'),e=>e.reason==='invalid_code');assert.equal(p.calls.length,1);
 await assert.rejects(()=>verifyCode(p,'f1','654321'),e=>e.reason==='invalid_code');
 const aal=port({mfa:{...port().mfa,async unenroll(){return err('insufficient_aal',403);}}});await assert.rejects(()=>removeFactor(aal,'f1'),e=>e.reason==='needs_aal2');
 assert.match(accountSecurityMessage(new AccountSecurityError('invalid_code')),/Código inválido/);assert.match(accountSecurityMessage(new Error('x')),/Tente novamente/);
});

test('password: local rules, then reauthentication by e-mail code when Auth asks for it',async()=>{
 assert.match(passwordProblem('curta','curta'),/12 caracteres/);assert.match(passwordProblem('a'.repeat(12),'b'.repeat(12)),/confirmação/);assert.equal(passwordProblem('a'.repeat(12),'a'.repeat(12)),null);
 assert.equal(await changePassword(port(),'senha-longa-123'),'done');
 let n=0;const p=port({async updateUser(v){p.calls.push(['update',v]);return n++===0?err('reauthentication_needed'):ok({});}});
 assert.equal(await changePassword(p,'senha-longa-123'),'needs_nonce');assert.ok(p.calls.includes('reauth'));
 assert.equal(await changePassword(p,'senha-longa-123',' 123456 '),'done');assert.deepEqual(p.calls.at(-1),['update',{password:'senha-longa-123',nonce:'123456'}]);
 const wrong=port({async updateUser(){return err('reauthentication_not_valid');}});await assert.rejects(()=>changePassword(wrong,'senha-longa-123','000000'),e=>e.reason==='invalid_nonce');
 for(const[code,reason]of[['same_password','same_password'],['weak_password','weak_password'],['other','unavailable']])
  await assert.rejects(()=>changePassword(port({async updateUser(){return err(code);}}),'senha-longa-123'),e=>e.reason===reason,code);
});

test('policy and reset answers are checked exactly; the browser never receives factor ids or gates',()=>{
 const U='10000000-0000-4000-8000-000000000310',C='30000000-0000-4000-8000-000000000310',S='2026-10-21T12:00:00-03:00';
 const policy={mfa_required:false,version:0,updated_at:null,members:[{user_id:U,name:'Admin',role:'admin',factor:false}]};
 assert.equal(parseSecurityPolicy({scope:'access_security_policy',data_mode:'erp_native',policy,self:{factor:false,aal2:false}}).policy.version,0);
 assert.throws(()=>parseSecurityPolicy({scope:'access_security_policy',data_mode:'erp_native',policy:{...policy,updated_at:S},self:{factor:false,aal2:false}}),e=>e.status===502);
 const input={command_id:C,expected_version:0,mfa_required:true},answer={scope:'access_security_command',data_mode:'erp_native',receipt:{command_id:C,from_version:0,to_version:1,changed_at:S},policy:{...policy,mfa_required:true,version:1,updated_at:S},replayed:false};
 assert.equal(parseSecurityPolicyAnswer(answer,input).policy.mfa_required,true);
 assert.throws(()=>parseSecurityPolicyAnswer({...answer,gates:[]},input),e=>e.status===502);
 assert.throws(()=>parseSecurityPolicyAnswer({...answer,policy:{...answer.policy,mfa_required:false}},input),e=>e.status===502);
 const reset={scope:'access_mfa_reset',data_mode:'erp_native',command_id:C,target:U,removed:1,changed_at:S,replayed:false};
 assert.equal(parseMfaResetAnswer(reset,{commandId:C,target:U}).removed,1);
 assert.throws(()=>parseMfaResetAnswer({...reset,factors:[U]},{commandId:C,target:U}),e=>e.status===502);
});
