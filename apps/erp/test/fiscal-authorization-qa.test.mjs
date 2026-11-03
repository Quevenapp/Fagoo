import test from 'node:test';import assert from 'node:assert/strict';
import {createAuthorizationQaFixture} from '../src/qa/authorization-fixture.ts';
import {captureAuthorizationRequest,authorizationResponse,bindAuthorizationResult} from '../src/lib/fiscal-authorization-model.ts';
import {readFile} from 'node:fs/promises';
const base='https://unsigned.qa.invalid/v1/fiscal-authorization';
test('QA55/65 fixtures use exact public DTOs, one failed command read then terminal synthetic response, and zero sends',async()=>{
 const f=createAuthorizationQaFixture();for(const model of ['55','65']){const c=f.candidate(model),p={method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}},h={method:'POST',body:{limit:25,before:null}},request=async(path,options)=>{const response=await f.fetch(base+path,{...options,...(options.body?{body:JSON.stringify(options.body)}:{})});return {response,value:await response.json()};};
 const preview=await request('/preview',p);assert.equal(authorizationResponse(preview.value,captureAuthorizationRequest('/v1/fiscal-authorization/preview',p)).can_prepare,false);
 const path='/candidates/'+c.candidate_id+'/history',history=await request(path,h),rows=authorizationResponse(history.value,captureAuthorizationRequest('/v1/fiscal-authorization'+path,h));rows.items.forEach(v=>bindAuthorizationResult(v,c));const row=rows.items[0],command='/commands/'+row.command_id;
 const lost=await request(command,{method:'GET'});assert.equal(lost.response.status,503);assert.equal(lost.value.recovery_required,false);
 const stored=await request(command,{method:'GET'}),result=authorizationResponse(stored.value,captureAuthorizationRequest('/v1/fiscal-authorization'+command));bindAuthorizationResult(result,c,row);assert.equal(result.status,'authorization_observed');assert.equal(result.current.authorized_in_homologation,false);
 }
 assert.deepEqual(f.counts,{preview:2,history:2,command:4,forbidden:0});
 const vite=await readFile(new URL('../vite.config.ts',import.meta.url),'utf8');assert.doesNotMatch(vite,/qa\.html|qa\.tsx/);
});
