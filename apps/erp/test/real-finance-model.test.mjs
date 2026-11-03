import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyInput, centsInput, financeMoney, installmentPlan, settlementAmounts, validFinanceDate, todaySP, financeCommand } from '../src/lib/real-finance-model.ts';
import { createAccessController } from '../src/lib/real-access.ts';

test('currency input uses exact cents strings and rejects ambiguous or excessive precision', () => {
  assert.equal(moneyInput('9999999999999,99'), '999999999999999');
  assert.equal(moneyInput('0005,1'), '510'); assert.equal(moneyInput('-0,01', true), '-1');
  assert.equal(centsInput('-999999999999999'), '-9999999999999,99');
  assert.equal(financeMoney('90071992547409931234'), 'R$ 900.719.925.474.099.312,34');
  for (const input of ['1.234,56','1.23','1e2','1,001','-1','NaN','Infinity','','10000000000000,00']) assert.throws(() => moneyInput(input));
});

test('monthly installment plan preserves total, leap days and month-end without date overflow', () => {
  const plan = installmentPlan('10000','3','2028-01-31','2028-01-01');
  assert.deepEqual(plan, [{ amount_cents:'3334',due_on:'2028-01-31' },{amount_cents:'3333',due_on:'2028-02-29'},{amount_cents:'3333',due_on:'2028-03-31'}]);
  const maximum = installmentPlan('999999999999999','120','2026-01-30','2026-01-01');
  assert.equal(maximum.reduce((total,item)=>total+BigInt(item.amount_cents),0n),999999999999999n);
  assert.ok(maximum.every(item=>BigInt(item.amount_cents)>0n));
  for (const args of [['1','2','2026-01-31','2026-01-01'],['100','0','2026-01-31','2026-01-01'],['100','121','2026-01-31','2026-01-01'],['100','1','2026-01-01','2026-01-02'],['100','1','2026-02-30','2026-01-01']]) assert.throws(()=>installmentPlan(...args));
});

test('partial payments preview principal and net cash separately for AR and AP', () => {
  const values={principal:'60,00',interest:'2,00',penalty:'1,00',discount:'4,00',fee:'0,50'};
  const ar=settlementAmounts('receivable','10000',values),ap=settlementAmounts('payable','10000',values);
  assert.equal(ar.net_cash_cents,'5850'); assert.equal(ap.net_cash_cents,'5950'); assert.equal(ar.remaining_cents,'4000');
  assert.deepEqual(ar.components,{principal_cents:'6000',interest_cents:'200',penalty_cents:'100',discount_cents:'400',fee_cents:'50'});
  for(const invalid of [{principal:'0'},{principal:'101'},{principal:'50',discount:'51'},{principal:'50',fee:'51'}]) assert.throws(()=>settlementAmounts('receivable','10000',invalid));
  assert.throws(()=>settlementAmounts('payable','999999999999999',{principal:'9999999999999,99',fee:'0,01'}));
});

test('dates reject calendar overflow and derive the operational day in São Paulo', () => {
  assert.equal(validFinanceDate('2028-02-29'),'2028-02-29');
  for(const invalid of ['2026-02-29','2026-13-01','01/01/2026','2101-01-01'])assert.throws(()=>validFinanceDate(invalid));
  assert.equal(todaySP(new Date('2026-10-16T02:30:00Z')),'2026-10-15');
});

test('uncertain retry reuses command id only for identical action and payload', () => {
  let index=0; const uuid=()=>`command-${++index}`;
  const first=financeCommand(null,'settle',{principal_cents:'100'},uuid);
  assert.equal(financeCommand(first,'settle',{principal_cents:'100'},uuid).id,first.id);
  assert.notEqual(financeCommand(first,'settle',{principal_cents:'101'},uuid).id,first.id);
  assert.notEqual(financeCommand(first,'reverse',{principal_cents:'100'},uuid).id,first.id);
});

function authStub(){ const session={access_token:'synthetic-token',user:{id:'a0000000-0000-4000-8000-000000000001'}};return {session,auth:{getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signInWithPassword:async()=>({data:{session},error:null}),signOut:async()=>({error:null})}};}
test('financial mutation is aborted on logout and a late body cannot restore private data',async()=>{
  const {session,auth}=authStub();let finish,init;
  const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return new Response(JSON.stringify({user_id:session.user.id,role:'financeiro',resources:[],data_mode:'staging_readonly'}));init=options;return new Promise(resolve=>{finish=resolve;});});
  const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,0));
  const pending=controller.finance('/v1/financeiro/actions/settle',{method:'POST',body:{command_id:'synthetic',data:{principal_cents:'100'}}});
  assert.equal(init.headers.Authorization,'Bearer synthetic-token');assert.doesNotMatch(init.body,/synthetic-token/);
  await controller.logout();assert.equal(init.signal.aborted,true);finish(new Response('{"private":"late"}'));
  await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(controller.getSnapshot().phase,'signed_out');stop();
});
test('finance role revocation clears old views and checks current permissions',async()=>{
  const {session,auth}=authStub();let checks=0;const states=[];
  const controller=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?new Response(JSON.stringify({user_id:session.user.id,role:++checks===1?'financeiro':'consulta',resources:[],data_mode:'staging_readonly'})):new Response('{}',{status:403}));
  const unsubscribe=controller.subscribe(()=>states.push(controller.getSnapshot()));const stop=controller.start();await new Promise(resolve=>setTimeout(resolve,0));
  await assert.rejects(()=>controller.finance('/v1/financeiro/actions/opening',{method:'POST',body:{}}),error=>error.status===403);
  await new Promise(resolve=>setTimeout(resolve,0));assert.ok(states.some(state=>state.phase==='checking'&&state.membership===null));assert.equal(controller.getSnapshot().membership.role,'consulta');
  await assert.rejects(()=>controller.finance('/v1/cadastros/contacts'),error=>error.status===400);unsubscribe();stop();
});
