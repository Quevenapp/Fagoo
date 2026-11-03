import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {parseIntegrationSummary} from '../src/lib/integration-progress-model.ts';
import {integrationProgressResponse} from '../../../workers/erp-api/src/integration-progress.mjs';
import {progressFixture,progressExtraFixture} from './helpers/integration-progress-fixtures.mjs';

test('065 keeps missing or explicit null extension unknown; legacy metrics remain readable',async()=>{
 for(const value of [progressFixture(1234),{...progressFixture(1234),extra_resources:null}]){
  const mapped=integrationProgressResponse(value);assert.equal(mapped.extra_resources,null);assert.deepEqual(parseIntegrationSummary(value),mapped);
  const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async()=>value}},{expandChildren:true});
  try{assert.match(app.text(),/1\.234/);assert.match(app.text(),/indicadores destes conjuntos ainda não estão disponíveis/);assert.match(app.text(),/não informa se a coleta está ativada/);assert.doesNotMatch(app.text(),/Produtos sem resposta neste lote/);}finally{app.unmount();}
 }
});
test('065 renders seven staging sets and nine collector variants without claiming native balances or completeness',async()=>{
 const value=progressExtraFixture();value.extra_resources.entities.find(x=>x.entity==='stock_balances').records=31;
 const stock=value.extra_resources.entities.find(x=>x.entity==='stock_balances');stock.oldest_observation=stock.newest_observation='2026-09-10T10:00:00Z';
 value.extra_resources.private='PRIVATE_PAYLOAD';value.extra_resources.stock_last_observation.source_id='PRIVATE_ID';
 const mapped=integrationProgressResponse(value);assert.deepEqual(parseIntegrationSummary(value),mapped);assert.doesNotMatch(JSON.stringify(mapped),/PRIVATE_/);
 const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async(path)=>{assert.equal(path,'/v1/integracao-origin');return value;}}},{expandChildren:true});
 try{
  for(const label of ['Ordens de serviço','Depósitos','Categorias de produtos','Categorias financeiras','Contas contábeis','Lançamentos de caixas e bancos','Observações de estoque por produto','Data de entrada','Registrados no período','Excluídos no período'])assert.ok(app.text().includes(label),label);
  assert.match(app.text(),/não o estoque total/);assert.match(app.text(),/Produto sem resposta não tem saldo zero presumido/);assert.match(app.text(),/não certificam cobertura ou conciliação/);assert.match(app.text(),/16\/10\/2026,? 09:00/);assert.equal(app.nodes().filter(n=>n.type==='button').length,1);
  const card=app.nodes().find(n=>n.type==='article'&&JSON.stringify(n).includes('Produtos solicitados no lote'));assert.ok(card);
  assert.match(app.text(),/31/);assert.match(app.text(),/25/);assert.match(app.text(),/17/);assert.match(app.text(),/8/);
 }finally{app.unmount();}
});
test('065 missing stock diagnostic remains unknown, while a valid empty batch reports only zero requested',async()=>{
 for(const missing of [true,false]){
  const value=progressExtraFixture({requested:0,returned:0});if(missing)value.extra_resources.stock_last_observation=null;
  const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async()=>value}},{expandChildren:true});
  try{assert.equal(app.text().includes('Sem observação de lote registrada ou válida'),missing);assert.equal(app.text().includes('Produtos solicitados no lote'),!missing);assert.match(app.text(),/Produto sem resposta não tem saldo zero presumido/);}finally{app.unmount();}
 }
});
test('065 API and UI reject inconsistent extension metadata and never promote coverage',()=>{
 const mutate=[v=>v.profile='other',v=>v.coverage_certified=true,v=>v.entities.pop(),v=>v.entities[0].entity='contacts',v=>v.resources.pop(),v=>v.resources[0].windowed=false,v=>v.resources[0].recent_open=true,v=>v.stock_last_observation.requested=26,v=>v.stock_last_observation.unavailable++,v=>v.stock_last_observation.returned=-1,v=>v.stock_last_observation.coverage_complete=true,v=>v.stock_last_observation.observed_at='2026-02-30T00:00:00Z',v=>delete v.stock_last_observation];
 for(const change of mutate){const value=progressExtraFixture();change(value.extra_resources);assert.throws(()=>integrationProgressResponse(value),e=>e.status===502);assert.throws(()=>parseIntegrationSummary(value),/INTEGRATION_PROGRESS_INVALID/);}
});
test('065 refresh and access loss remove extra diagnostics; only explicit GET retries occur',async()=>{
 let count=0;const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async(path,o)=>{assert.equal(path,'/v1/integracao-origin');assert.equal(o.method,undefined);if(++count===2)throw new AccessError(403);return progressExtraFixture();}}},{expandChildren:true});
 try{assert.match(app.text(),/Produtos sem resposta neste lote/);await app.click('Atualizar andamento');assert.match(app.text(),/restrito aos administradores/);assert.doesNotMatch(app.text(),/Produtos sem resposta neste lote/);assert.equal(count,2);await app.click('Atualizar andamento');assert.equal(count,3);assert.match(app.text(),/Produtos sem resposta neste lote/);}finally{app.unmount();}
});
