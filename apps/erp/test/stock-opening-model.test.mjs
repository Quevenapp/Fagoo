import test from'node:test';import assert from'node:assert/strict';
import{captureStockOpeningRequest,stockOpeningPagePath,stockOpeningActionPath,stockOpeningCommandPath,stockPolicyCommandPath,openingDateProblem,openingQuantity,openingNegative,policyIntent,
 openingResults,openingBatchPreview,parseStockOpeningBatch,parseStockOpeningResult,stockOpeningIntent,OPENING_REASON_LABELS,OPENING_STATUS_LABELS,OPENING_GROUP_LABELS,POLICY_CONFIRMATION}from'../src/lib/stock-opening-model.ts';
import{createStockOpeningFixture,OPENING_QA_SOURCE}from'../src/qa/stock-opening-fixture.ts';
const COMMAND='10000000-0000-4000-8000-0000000000c1';

test('100 request capture: closed paths, admin-only writes, policy read open to stock readers, frozen bodies',()=>{
 assert.equal(stockOpeningPagePath('700001',{limit:50,after:'9105',group:'invalid'}),'/v1/saldo-abertura-estoque/700001?limit=50&after=9105&grupo=invalid');
 assert.equal(stockOpeningActionPath('700001','lote'),'/v1/saldo-abertura-estoque/700001/lote');
 for(const bad of[()=>stockOpeningPagePath('0'),()=>stockOpeningPagePath('700001',{limit:51}),()=>stockOpeningActionPath('700001','apagar'),()=>stockOpeningCommandPath('x'),()=>stockPolicyCommandPath(COMMAND.toUpperCase())])assert.throws(bad);
 assert.equal(captureStockOpeningRequest('/v1/politica-estoque').admin,false);
 assert.equal(captureStockOpeningRequest('/v1/politica-estoque',{method:'POST',body:{command_id:COMMAND,expected_version:0,allow_negative:true,reason:'Venda sem saldo',confirmed:true}}).admin,true);
 assert.equal(captureStockOpeningRequest('/v1/saldo-abertura-estoque').admin,true);
 const body={occurred_on:'2026-10-18',limit:100},captured=captureStockOpeningRequest('/v1/saldo-abertura-estoque/700001/lote',{method:'POST',body});body.limit=1;assert.equal(captured.options.body.limit,100);assert.ok(Object.isFrozen(captured.options.body));
 for(const[path,options]of[['/v1/saldo-abertura-estoque/700001/lote',{method:'GET'}],['/v1/saldo-abertura-estoque/700001?limit=1&limit=2',{}],['/v1/saldo-abertura-estoque/700001?q=x',{}],['/v1/politica-estoque',{method:'PATCH'}],
  ['/v1/estoque/saldos',{}],['/v1/saldo-abertura-estoque/700001/adotar',{method:'POST',body:{confirmed:true}}],['/v1/saldo-abertura-estoque#x',{}],['/v1/saldo-abertura-estoque',{method:'GET',body:{}}],['/v1/saldo-abertura-estoque',{extra:1}]])
  assert.throws(()=>captureStockOpeningRequest(path,options),undefined,path);
});

test('100 model: cut date, signed quantities, policy confirmation and per-item results in Origin batch vocabulary',async()=>{
 assert.equal(openingDateProblem('2026-10-18','2026-10-19'),null);assert.match(openingDateProblem('2026-10-20','2026-10-19'),/futuro/);assert.match(openingDateProblem('2026-02-30','2026-10-19'),/válida/);assert.match(openingDateProblem('','2026-10-19'),/data de corte/);
 assert.equal(openingQuantity('-2.250000'),'−2,25');assert.equal(openingQuantity('10.500000'),'10,5');assert.equal(openingQuantity(null),'—');assert.equal(openingNegative('-0.000001'),true);assert.equal(openingNegative('0.000000'),false);
 assert.equal(OPENING_REASON_LABELS.NEGATIVE_NOT_ALLOWED,'Estoque negativo não permitido');assert.equal(OPENING_GROUP_LABELS.native_movements,'Com lançamentos nativos');assert.equal(OPENING_STATUS_LABELS.adopted_reversed,'Adoção estornada');
 const policy={allow_negative:false,version:3,updated_at:'2026-10-18T10:00:00+00:00'};
 assert.throws(()=>policyIntent(policy,true,'Venda sem saldo',COMMAND,false));assert.throws(()=>policyIntent(policy,false,'Venda sem saldo',COMMAND,true));assert.throws(()=>policyIntent(policy,true,'ok',COMMAND,true));
 assert.deepEqual({...policyIntent(policy,true,'  Venda sem saldo  ',COMMAND,true)},{command_id:COMMAND,expected_version:3,allow_negative:true,reason:'Venda sem saldo',confirmed:true});
 assert.match(POLICY_CONFIRMATION.enable,/Reservas continuam/);assert.match(POLICY_CONFIRMATION.disable,/não são alterados/);
 const f=createStockOpeningFixture(),raw=await f.controller.stockOpening(stockOpeningActionPath(OPENING_QA_SOURCE,'lote'),{method:'POST',body:{occurred_on:'2026-10-18',limit:100}});
 const batch=parseStockOpeningBatch(raw,{warehouseSourceId:OPENING_QA_SOURCE,occurredOn:'2026-10-18',limit:100});
 assert.deepEqual(openingBatchPreview(batch).map(r=>r.label),['SINT-9101 · Produto sintético 9101','SINT-9102 · Produto sintético 9102']);assert.match(openingBatchPreview(batch)[0].message,/Origin 10,5 · atual sem lançamentos · ajuste 10,5 UN/);
 const intent=stockOpeningIntent(batch,COMMAND),done=parseStockOpeningResult(await f.controller.stockOpening(stockOpeningActionPath(OPENING_QA_SOURCE,'adotar'),{method:'POST',body:intent}),{commandId:COMMAND,warehouseSourceId:OPENING_QA_SOURCE,input:intent});
 assert.deepEqual(openingResults(done,batch).map(r=>[r.outcome,r.message]),[['ok','Saldo ajustado para 10,5 UN'],['ok','Saldo zero registrado, sem movimento de estoque.']]);
 const skipped={...done,receipt:{...done.receipt,items:[{...done.receipt.items[0],outcome:'skipped',reason:'SOURCE_CHANGED',adjustment:null,movement_id:null,receipt_id:null}]}};
 assert.deepEqual(openingResults(skipped,null).map(r=>[r.label,r.outcome]),[['Produto 9101 no Origin','skipped']]);
});
