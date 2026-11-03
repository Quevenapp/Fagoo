import test from 'node:test';import assert from 'node:assert/strict';
import {createFiscalReviewedAuthorizationClient} from '../src/lib/fiscal-reviewed-authorization-client.ts';
import {createReviewedAuthorizationQaFixture,REVIEWED_QA_ORIGIN,REVIEWED_QA_ACTOR} from '../src/qa/reviewed-authorization-fixture.ts';
import {revalidationContextPath,revalidationIntent,revalidationCommandPath,bindRevalidationContext,bindRevalidationResult} from '../src/lib/fiscal-stored-response-revalidation-model.ts';
const B='/v1/fiscal-authorization/reviewed',state=()=>({phase:'ready',membership:{user_id:REVIEWED_QA_ACTOR,role:'fiscal'}});
test('QA079 uses real client/projections for55 lostACK/GET and65 success, without authorization or recover POST',async()=>{
 const f=createReviewedAuthorizationQaFixture({allowRevalidation:true}),client=createFiscalReviewedAuthorizationClient({origin:REVIEWED_QA_ORIGIN,getToken:()=> 'synthetic-079-token',getSnapshot:state,fetchImpl:f.fetch});
 for(const model of ['55','65']){const candidate=f.candidate(model),page=await client(`${B}/candidates/${candidate.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}}),original=page.items[0],ctx=bindRevalidationContext(await client(revalidationContextPath(original)),candidate,original),body=revalidationIntent(ctx,candidate,`a7900000-0000-4000-8000-0000000000${model}`,true);
  const pending=client(B+'/revalidations',{method:'POST',body});if(model==='55'){await assert.rejects(pending,e=>e.status===503&&e.recovery_required);await assert.rejects(client(revalidationCommandPath(body)),e=>e.status===503&&!e.recovery_required);}else assert.equal((await pending).read_only,false);
  const saved=bindRevalidationResult(await client(revalidationCommandPath(body)),body,ctx,candidate);assert.equal(saved.receipt.state,'authorized_homologation');const reload=bindRevalidationContext(await client(revalidationContextPath(original)),candidate,original);assert.equal(reload.existing.command_id,body.command_id);assert.equal(reload.can_revalidate,false);
 }
 assert.deepEqual([f.counts.revalidationRun,f.counts.revalidationCommand,f.counts.run,f.counts.recover,f.counts.forbidden],[2,3,0,0,0]);
});
test('QA079 already-recorded scenario discovers both receipts with zero writes',async()=>{
 const f=createReviewedAuthorizationQaFixture({revalidationLookupOnly:true}),client=createFiscalReviewedAuthorizationClient({origin:REVIEWED_QA_ORIGIN,getToken:()=> 'synthetic-079-token',getSnapshot:state,fetchImpl:f.fetch});for(const model of ['55','65']){const c=f.candidate(model),p=await client(`${B}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before:null}}),ctx=bindRevalidationContext(await client(revalidationContextPath(p.items[0])),c,p.items[0]);assert.equal(ctx.existing.receipt.state,'authorized_homologation');assert.equal(ctx.can_revalidate,false);}assert.equal(f.counts.revalidationRun+f.counts.run+f.counts.recover+f.counts.forbidden,0);
});
