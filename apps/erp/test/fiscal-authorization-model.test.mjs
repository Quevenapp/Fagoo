import test from 'node:test';import assert from 'node:assert/strict';
import {captureAuthorizationRequest as capture,authorizationResponse,bindAuthorizationResult,AUTHORIZATION_BASE as BASE} from '../src/lib/fiscal-authorization-model.ts';
import {authorizationQaCandidate as candidate,authorizationQaPreview as preview,authorizationQaResult as result,authorizationQaHistory as history} from '../src/qa/authorization-fixture.ts';
const c=candidate(),p={method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}};
test('064 UI port captures inert payloads and has no run/recover path',()=>{
 const body={...p.body},signal=new AbortController().signal,options={method:'POST',body,signal},s=capture(BASE+'/preview',options);body.signed_hash='0'.repeat(64);options.signal=undefined;assert.equal(s.payload.signed_hash,c.artifact.sha256);assert.equal(s.signal,signal);assert.ok(Object.isFrozen(s.payload));
 for(const [path,options] of [[BASE+'/run',p],[BASE+'/recover',{method:'POST',body:{command_id:result().command_id}}],[BASE+'/preview?x=1',p],['https://else.invalid'+BASE+'/preview',p],[BASE+'/preview',{...p,body:{...p.body,actor:'injected'}}],[BASE+'/preview',{...p,body:{...p.body,candidate_id:[c.candidate_id]}}],[BASE+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:26,before:null}}],[BASE+'/candidates/'+c.candidate_id+'/history',{method:'POST',body:{limit:25,before:'1000000000000000'}}]])assert.throws(()=>capture(path,options));
 let reads=0;assert.throws(()=>capture(BASE+'/preview',{method:'POST',body:Object.defineProperty({},'candidate_id',{enumerable:true,get(){reads++;return c.candidate_id;}})}));assert.equal(reads,0);
});
test('064 preview/history/command DTOs preserve synthetic distinction and exact candidate binding',()=>{
 for(const model of ['55','65']){const c=candidate(model),selection=capture(BASE+'/preview',{method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}});assert.equal(authorizationResponse(preview(c),selection).can_prepare,false);
 const h=authorizationResponse(history(c),capture(`${BASE}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}}));h.items.forEach(r=>bindAuthorizationResult(r,c));assert.equal(h.items[1].current.authorized_in_homologation,false);
 for(const key of ['signed_hash','signed_size','model','candidate_version','signing_a1_version','basis_hash','completion_hash']){const r=result(c);r.receipt[key]=typeof r.receipt[key]==='number'?r.receipt[key]+1:'wrong';assert.throws(()=>bindAuthorizationResult(r,c));}
 const old=result(c),updated=result(c,true);assert.equal(bindAuthorizationResult(updated,c,old).status,'authorization_observed');updated.receipt.a1_version++;assert.throws(()=>bindAuthorizationResult(updated,c,old));
 }
 const bad=preview();bad.can_prepare=true;assert.throws(()=>authorizationResponse(bad,capture(BASE+'/preview',p)));
});
test('current certificate difference does not reinterpret or prevent reading a historical signature',()=>{
 const old=result(),r=result();r.current.a1_changed=true;r.current.candidate.a1_version=3;r.current.candidate.a1_changed=true;r.current.candidate.artifact_current=false;
 const v=authorizationResponse(r,capture(BASE+'/commands/'+r.command_id));assert.equal(bindAuthorizationResult(v,c,old).receipt.a1_version,2);assert.equal(v.current.candidate.a1_version,3);
});
