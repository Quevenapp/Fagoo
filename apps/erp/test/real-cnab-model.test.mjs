import test from 'node:test';
import assert from 'node:assert/strict';
import { cnabProfileData, cnabDocument, cnabDays, eligibleCnabTitle, sumCnabTitles, cnabBase64, cnabFileBytes, cnabHash } from '../src/lib/real-cnab-model.ts';
import { createAccessController } from '../src/lib/real-access.ts';
const id='a0000000-0000-4000-8000-000000000001';
const values={account_id:id,bank:'341',wallet:'109',agency:'1234',account:'12345',accountDigit:'6',cnpj:'12345678000195',companyName:'EMPRESA FICTICIA',agreementReference:'REFERENCIA SINTETICA',ourNumberStart:'00000001',remittanceSequenceStart:'1'};
test('profile validation preserves bank identifiers, explicit counters and unconfirmed defaults',()=>{
  const data=cnabProfileData(values,{});assert.equal(data.ourNumberStart,'00000001');assert.equal(data.contractVerified,false);assert.equal(data.simpleCollectionPolicyVerified,false);
  for(const change of [{agency:''},{ourNumberStart:'1'},{remittanceSequenceStart:''},{companyName:'não cabe no leiaute'},{account_id:''}])assert.throws(()=>cnabProfileData({...values,...change},{}));
  const inter={...values,bank:'077',wallet:'112',agency:'0001',account:'000123456'};assert.equal(cnabProfileData(inter,{}).ourNumberStart,null);
  assert.throws(()=>cnabProfileData({...inter,wallet:'110',ourNumberStart:'0000000035',rangeStart:'0000000030',rangeEnd:'0000000034'},{}));
  const range=cnabProfileData({...inter,wallet:'110',ourNumberStart:'0000000030',rangeStart:'0000000030',rangeEnd:'0000000034'},{range:true});assert.equal(range.reservedRange.start,'0000000030');
});
test('a bank and wallet must be an explicit supported pair; identifiers are never replaced',()=>{
  for(const pair of[{bank:'341',wallet:'110'},{bank:'341',wallet:'112'},{bank:'341',wallet:''},{bank:'077',wallet:'109'},{bank:'077',wallet:''},{bank:'001',wallet:'109'}])
    assert.throws(()=>cnabProfileData({...values,...pair},{}),/Selecione a carteira/);
  const inter={...values,bank:'077',wallet:'110',agency:'0001',account:'000123456',ourNumberStart:'0000000030',rangeStart:'0000000030',rangeEnd:'0000000034'};
  const actual=cnabProfileData(inter,{});
  assert.equal(actual.wallet,'110');assert.equal(actual.ourNumberStart,'0000000030');assert.deepEqual(actual.reservedRange,{start:'0000000030',end:'0000000034',verified:false});
  assert.equal(actual.remittanceSequenceStart,'1');assert.equal(actual.contractVerified,false);assert.equal(actual.simpleCollectionPolicyVerified,false);
});
test('selection eligibility and totals use exact cents and bank-specific limits',()=>{
  const title={kind:'receivable',cancelled:false,settled_cents:'0',amount_cents:'249',issued_on:'2026-10-01',due_on:'2026-10-16'};
  assert.equal(eligibleCnabTitle(title,'077','2026-10-16'),false);assert.equal(eligibleCnabTitle(title,'341','2026-10-16'),true);
  for(const change of[{settled_cents:'1'},{cancelled:true},{due_on:'2026-10-15'},{kind:'payable'}])assert.equal(eligibleCnabTitle({...title,...change},'341','2026-10-16'),false);
  assert.equal(sumCnabTitles([{amount_cents:'9999999999999'},{amount_cents:'1'}]),'10000000000000');
  assert.equal(cnabDocument(' DOC-001 '),'DOC-001');assert.throws(()=>cnabDocument('12345678901'));assert.throws(()=>cnabDocument('ação'));
  assert.equal(cnabDays('60'),60);for(const input of ['0','61','1.0','2e1',''])assert.throws(()=>cnabDays(input));
});
test('return bytes preserve original content; limits and SHA verify download identity',async()=>{
  const bytes=new Uint8Array([0,13,10,255,65]);assert.equal(cnabBase64(bytes),Buffer.from(bytes).toString('base64'));
  assert.deepEqual(await cnabFileBytes(new Blob([bytes])),bytes);assert.match(await cnabHash(bytes),/^[a-f0-9]{64}$/);
  await assert.rejects(()=>cnabFileBytes(new Blob([])));await assert.rejects(()=>cnabFileBytes(new Blob([new Uint8Array(4020001)])));
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const me={user_id:id,role:'financeiro',resources:['receivables'],data_mode:'staging_readonly'};
function auth(){return{getSession:async()=>({data:{session:{access_token:'fake-token',user:{id}}},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session:null},error:null}),signOut:async()=>({error:null})};}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
test('CNAB controller restricts paths and discards downloads arriving after logout',async()=>{
  let finish,signal;const controller=createAccessController(auth(),'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});
  const stop=controller.start();await tick();await assert.rejects(()=>controller.cnab('/v1/empresa'));await assert.rejects(()=>controller.cnabDownload('/v1/cnab/files/return/../other'));
  const pending=controller.cnabDownload(`/v1/cnab/files/return/${id}`);await controller.logout();assert.equal(signal.aborted,true);finish(new Response(new Uint8Array([1])));await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(controller.getSnapshot().phase,'signed_out');stop();
});
test('CNAB membership revocation clears authenticated data and rechecks authorization',async()=>{
  let calls=0;const controller=createAccessController(auth(),'https://api.example.test',async url=>url.endsWith('/me')?json(++calls===1?me:{},calls===1?200:403):json({},403));const stop=controller.start();await tick();
  await assert.rejects(()=>controller.cnab('/v1/cnab'));await tick();assert.equal(controller.getSnapshot().membership,null);assert.equal(controller.getSnapshot().phase,'pending');stop();
});
