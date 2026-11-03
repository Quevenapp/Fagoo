import test from 'node:test';import assert from 'node:assert/strict';
import {createCnabOperationalV2QaFixture} from '../src/qa/cnab-operational-v2-fixture.ts';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {v2Profiles,v2Page,v2Preview,CNAB_V2_BASE as BASE,CNAB_ENCODINGS as E} from '../src/lib/cnab-operational-v2-model.ts';
import {todaySP} from '../src/lib/real-finance-model.ts';
const tick=()=>new Promise(r=>setTimeout(r,0));
test('067 QA uses real controller with in-memory read-only fixtures; zero previews are explicit and no writes/download available',async()=>{
 const f=createCnabOperationalV2QaFixture(),session={access_token:'qa-synthetic-token-unsigned-safe',user:{id:'e0000000-0000-4000-8000-000000000001'}},auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};const c=createAccessController(auth,'http://127.0.0.1:9011',(url,init)=>f.fetch(url,init)),stop=c.start();await tick();
 try{const p=v2Profiles(await c.cnabOperationalV2(BASE+'/profiles'))[0],page=v2Page(await c.cnabOperationalV2(BASE+'/remittances?limit=25'));assert.equal(page.items.length,3);assert.equal(page.items[2].encoding_profile,null);const titles=(await c.finance('/v1/financeiro/titles?kind=receivable&status=open&limit=15')).items;
  const b={command_id:crypto.randomUUID(),profile_id:p.profile.id,expected_version:1,expected_approval_version:1,generated_on:todaySP(),titles:titles.map((t,i)=>({title_id:t.id,expected_version:1,document_number:'QA'+i})),confirm_operational:false,encoding_profile:E[1],confirm_encoding_profile:false,zero_daily_title_ids:[]};const raw=await c.cnabOperationalV2(BASE+'/remittances/preview',{method:'POST',body:b}),v=v2Preview(raw,b);assert.equal(v.can_reserve,false);const reviewed={...b,zero_daily_title_ids:[titles[1].id]};assert.equal(v2Preview(await c.cnabOperationalV2(BASE+'/remittances/preview',{method:'POST',body:reviewed}),reviewed).can_reserve,true);
  const no={...b,encoding_profile:E[0]};assert.equal(v2Preview(await c.cnabOperationalV2(BASE+'/remittances/preview',{method:'POST',body:no}),no).can_reserve,true);
  await assert.rejects(()=>c.cnabOperationalV2(BASE+'/remittances',{method:'POST',body:{...reviewed,confirm_operational:true,confirm_encoding_profile:true,preview_hash:v.preview_hash}}),e=>e instanceof AccessError&&e.status===403);await tick();assert.equal(v2Page(await c.cnabOperationalV2(BASE+'/remittances?limit=25')).items.length,3);assert.deepEqual(f.counts(),{previews:3,blockedWrites:1});assert.equal((await f.fetch('https://bank.invalid/')).status,403);
 }finally{stop();}
});
