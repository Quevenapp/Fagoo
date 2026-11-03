import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createInviteActivation} from '../src/lib/invite-activation.ts';

const origin='https://activation.synthetic.invalid';
const id='66666666-7777-4888-8999-111111111111';
const hash='a'.repeat(64);
const password='Synthetic password 2026!';
const user=()=>({id,email:'activation@example.invalid',email_confirmed_at:'2026-10-16T09:00:00Z',invited_at:'2026-10-16T08:59:00Z',is_anonymous:false});
const result=()=>({error:null,data:{user:user()}});
const session=()=>({error:null,data:{user:user(),session:{access_token:'synthetic',user:user()}}});
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function setup(port={},extra={}){
 const calls=[];
 const client={verifyOtp:async()=>{calls.push('verify');return session();},setSession:async()=>{calls.push('session');return session();},getUser:async()=>{calls.push('user');return result();},updateUser:async()=>{calls.push('password');return result();},...port};
 const controller=createInviteActivation({href:`${origin}/ativar-acesso?token_hash=${hash}&type=invite`,expectedOrigin:origin,replaceUrl:()=>calls.push('scrub'),createAuth:()=>{calls.push('construct');return client;},abortRequests:()=>calls.push('abort'),clearSession:()=>calls.push('clear'),...extra});
 return{controller,calls};
}
test('independent activation: timeout after password commit remains unconfirmed despite a late valid ACK',async()=>{
 const pending=deferred();let writes=0;
 const s=setup({async updateUser(){writes++;return pending.promise;}},{timeoutMs:10});
 await s.controller.verify();await s.controller.setPassword(password,password);
 assert.equal(s.controller.getSnapshot().phase,'password_unconfirmed');assert.ok(s.calls.includes('abort'));
 const cleared=s.calls.filter(x=>x==='clear').length;
 pending.resolve(result());await new Promise(r=>setTimeout(r,0));
 assert.equal(s.controller.getSnapshot().phase,'password_unconfirmed');assert.ok(s.calls.filter(x=>x==='clear').length>cleared);
 await s.controller.setPassword('Another synthetic password!','Another synthetic password!');
 assert.equal(writes,1);assert.equal(s.controller.getSnapshot().email,null);
 assert.doesNotMatch(JSON.stringify(s.controller.getSnapshot()),/synthetic|example.invalid|66666666/i);
});
test('independent activation: a lost consumed invitation is not replayed automatically or by another click',async()=>{
 let consumed=0;const s=setup({async verifyOtp(){consumed++;throw Error('synthetic bearer '+hash);}});
 await s.controller.verify();await s.controller.verify();
 assert.equal(consumed,1);assert.equal(s.controller.getSnapshot().phase,'unavailable');
 assert.equal(s.calls.filter(x=>x==='user').length,0);assert.doesNotMatch(JSON.stringify(s.controller.getSnapshot()),/bearer|aaaaaa/);
});
test('independent activation: StrictMode-like subscription replay retains one controller and one explicit verification',async()=>{
 const pending=deferred();let verifications=0;const s=setup({async verifyOtp(){verifications++;return pending.promise;}});
 let events=0;const unsubscribe=s.controller.subscribe(()=>events++);unsubscribe();const unsubscribeAgain=s.controller.subscribe(()=>events++);
 const first=s.controller.verify();await s.controller.verify();pending.resolve(session());await first;
 assert.equal(verifications,1);assert.equal(s.calls.filter(x=>x==='construct').length,1);assert.equal(s.calls.filter(x=>x==='scrub').length,1);
 assert.equal(s.controller.getSnapshot().phase,'ready');assert.equal(events,2);unsubscribeAgain();s.controller.dispose();
});
test('independent activation: dispose while rechecking user prevents password mutation and masks the late identity',async()=>{
 const pending=deferred();let reads=0,writes=0;const s=setup({async getUser(){return ++reads===1?result():pending.promise;},async updateUser(){writes++;return result();}});
 await s.controller.verify();const action=s.controller.setPassword(password,password);s.controller.dispose();pending.resolve(result());await action;
 assert.equal(writes,0);assert.equal(s.controller.getSnapshot().phase,'disposed');assert.equal(s.controller.getSnapshot().email,null);
});
