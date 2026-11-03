import test from 'node:test';
import assert from 'node:assert/strict';
import {explicitDocumentPlan,reverseDocumentInput,financialEligible} from '../src/lib/document-finance-model.ts';
import {documentEffectState,effectTransitionAllowed} from '../src/lib/document-effects-model.ts';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const id='a0000000-0000-4000-8000-000000000001',posting='b0000000-0000-4000-8000-000000000001';
const document={id,kind:'sales_orders',version:3,status:'verified',date:'2026-10-16',totals:{total:'3.02'},installments:[]};
const row={amount:'3,02',due_on:'2026-11-01',method:'Prazo sintético'};
test('explicit plan preserves exact cents and dates; saved document installments cannot be replaced',()=>{
 assert.deepEqual(explicitDocumentPlan(document,[row]),[{amount_cents:'302',due_on:'2026-11-01',method:'Prazo sintético'}]);
 assert.equal(explicitDocumentPlan({...document,installments:[{amount:'3.02',due_date:'2026-11-01'}]},[]),null);
 assert.deepEqual(explicitDocumentPlan({...document,totals:{total:'0.03'}},[{...row,amount:'0,01'},{...row,amount:'0,02'}]).map(v=>v.amount_cents),['1','2']);
 for(const rows of [[],Array.from({length:121},()=>row),[{...row,amount:'3,01'}],[{...row,amount:'0'}],[{...row,amount:'3.02'}],[{...row,due_on:''}],[{...row,due_on:'2026-10-15'}],[{...row,due_on:'2026-02-30'}],[{...row,method:'x\ntext'}]])assert.throws(()=>explicitDocumentPlan(document,rows));
});
test('financial reversal binds current document version and all title versions without sending principal replacements',()=>{
 const preview={document_id:id,document_version:3,posting:{id:posting,state:'active',version:1},preview_hash:'a'.repeat(64),titles:[{id:'title-1',version:4,settled_cents:'0',cnab_linked:false}]};
 const input=reverseDocumentInput(document,preview,'  Correção conferida  ');assert.equal(input.reason,'Correção conferida');assert.deepEqual(input.title_versions,[{id:'title-1',version:4}]);assert.equal(input.amount_cents,undefined);
 for(const patch of [{document_id:'other'},{document_version:4},{posting:{...preview.posting,state:'reversed'}},{titles:[{...preview.titles[0],settled_cents:'1'}]},{titles:[{...preview.titles[0],cnab_linked:true}]}])assert.throws(()=>reverseDocumentInput(document,{...preview,...patch},'Conferido'));
 for(const reason of ['','xx','x\ntext','x'.repeat(1001)])assert.throws(()=>reverseDocumentInput(document,preview,reason));
});
test('eligibility and effect transitions do not offer cancellation or reopening with active links',()=>{
 assert.equal(financialEligible(document),true);assert.equal(financialEligible({...document,status:'draft'}),false);assert.equal(financialEligible({...document,kind:'sales_proposals',status:'approved'}),false);
 for(const [kind,from,to]of [['sales_orders','verified','in_progress'],['purchase_orders','in_progress','fulfilled'],['service_orders','waiting_parts','in_progress'],['service_orders','service_done','finalized']])assert.equal(effectTransitionAllowed(kind,from,to),true);
 for(const [kind,from,to]of [['sales_orders','verified','cancelled'],['sales_orders','verified','open'],['purchase_orders','fulfilled','in_progress'],['sales_proposals','approved','completed']])assert.equal(effectTransitionAllowed(kind,from,to),false);
});
test('operational flags protect document bodies for roles that cannot consult effect values',()=>{
 assert.deepEqual(documentEffectState({finance_active:true,stock_active:false},null,null),{known:true,finance:true,stock:false,active:true,originFinance:false,originInvoice:false,origin:false});
 // 016: the Origin effects lock apart from the native ones.
 assert.deepEqual(documentEffectState({finance_active:false,stock_active:false,origin_invoice:true},null,null),{known:true,finance:false,stock:false,active:false,originFinance:false,originInvoice:true,origin:true});
 assert.equal(documentEffectState(undefined,false,false).known,false);assert.equal(documentEffectState({finance_active:false},false,false).known,false);
 assert.equal(documentEffectState({finance_active:false,stock_active:false},false,false).active,false);
 assert.equal(documentEffectState({finance_active:false,stock_active:false},true,false).active,true);
});
const session={access_token:'synthetic-token',user:{id}};const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const me={user_id:id,role:'admin',resources:[],data_mode:'staging_readonly'},tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('effect clients keep bearer private and reject out-of-prefix/traversal paths before calling fetch',async()=>{
 const calls=[];const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({data_mode:'erp_native'});});const stop=controller.start();await tick();
 try{const base=`/v1/documentos/sales_orders/${id}/financeiro`;await controller.documentFinance(`${base}/preview`,{method:'POST',body:{expected_document_version:3}});await controller.documentStock('/v1/documentos-estoque?kind=sales_orders');
  assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(JSON.parse(calls[0].options.body),{expected_document_version:3});
  for(const path of ['/v1/financeiro/titles','https://evil.invalid','/v1/documentos/sales_proposals/x/financeiro',`${base}/../outside`,`${base}/%2e%2e/outside`])await assert.rejects(()=>controller.documentFinance(path),e=>e instanceof AccessError&&e.status===400);
  for(const path of ['/v1/documentos', '/v1/documentos-estoque-other','/v1/documentos-estoque/../outside'])await assert.rejects(()=>controller.documentStock(path),e=>e instanceof AccessError&&e.status===400);
  assert.equal(calls.length,2);
 }finally{stop();}
});
test('effect clients abort on logout and reject responses larger than one MiB',async()=>{
 for(const method of ['documentFinance','documentStock']){
  const path=method==='documentFinance'?`/v1/documentos/sales_orders/${id}/financeiro`:'/v1/documentos-estoque?kind=sales_orders';let finish,signal;
  const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=controller.start();await tick();
  const pending=controller[method](path);await tick();await controller.logout();assert.equal(signal.aborted,true);finish(Response.json({data_mode:'erp_native'}));await assert.rejects(pending,e=>e.name==='AbortError');stop();
  const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(1024*1024+1)}}));const stopBounded=bounded.start();await tick();try{await assert.rejects(()=>bounded[method](path),e=>e instanceof AccessError&&e.status===502);}finally{stopBounded();}
 }
});
