import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {parseIntegrationSummary} from '../src/lib/integration-progress-model.ts';
import {integrationProgressResponse} from '../../../workers/erp-api/src/integration-progress.mjs';

import {progressFixture as fixture} from './helpers/integration-progress-fixtures.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('033 model retains only safe aggregates and rejects incomplete or inflated coverage',()=>{
 const v=fixture(9876);assert.deepEqual(parseIntegrationSummary(v),integrationProgressResponse(v));
 const enriched={...v,secret:'PRIVATE',entities:v.entities.map(row=>({...row,payload:{name:'PRIVATE'}}))};
 assert.doesNotMatch(JSON.stringify(parseIntegrationSummary(enriched)),/PRIVATE|payload|secret/);
 for(const mutate of [x=>x.coverage_certified=true,x=>x.runtime_configuration_known=true,x=>x.entities[0].newest_observation='2026-02-30T12:00:00Z',x=>x.resources.pop(),x=>x.xml.authorization_verified=true,x=>x.finance_refresh.entities[0].unavailable_balance=1]){
  const value=structuredClone(v);mutate(value);assert.throws(()=>parseIntegrationSummary(value));
 }
});
test('033 refresh removes old metrics while pending and never replaces missing observations with zero dates',async()=>{
 const pending=deferred();let calls=0;const signals=[];
 const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async(path,options)=>{assert.equal(path,'/v1/integracao-origin');signals.push(options.signal);return ++calls===1?fixture(9876):pending.promise;}}},{expandChildren:true});
 try{
  assert.match(app.text(),/9\.876/);assert.match(app.text(),/Sem registro/);assert.match(app.text(),/não confirmam uma migração concluída/);
  await app.click('Atualizar andamento');assert.equal(signals[0].aborted,true);assert.doesNotMatch(app.text(),/9\.876/);assert.match(app.text(),/Consultando integração/);
  pending.resolve(fixture(1234));await app.flush();assert.match(app.text(),/1\.234/);assert.doesNotMatch(app.text(),/9\.876/);
 }finally{app.unmount();}assert.equal(signals[1].aborted,true);
});
test('033 late completion from an old controller or closed screen cannot replace the current session',async()=>{
 const old=deferred(),last=deferred();let oldSignal,lastSignal;
 const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:(_p,o)=>{oldSignal=o.signal;return old.promise;}}});
 await app.updateProps({controller:{integrationProgress:async()=>fixture(2222)}});assert.equal(oldSignal.aborted,true);assert.match(app.text(),/2\.222/);
 old.resolve(fixture(9999));await app.flush();assert.doesNotMatch(app.text(),/9\.999/);
 await app.updateProps({controller:{integrationProgress:(_p,o)=>{lastSignal=o.signal;return last.promise;}}});app.unmount();assert.equal(lastSignal.aborted,true);last.resolve(fixture(8888));await app.flush();
});
test('033 access loss and invalid responses show no stale metrics and permit read-only retry',async()=>{
 let step=0;const app=await mountComponent('IntegrationProgress.tsx',{controller:{integrationProgress:async()=>{step++;if(step===1)return fixture(9876);if(step===2)throw new AccessError(403);if(step===3)return{...fixture(),role:'consulta'};return fixture();}}});
 try{
  await app.click('Atualizar andamento');assert.match(app.text(),/restrito aos administradores ativos/);assert.doesNotMatch(app.text(),/9\.876/);
  await app.click('Atualizar andamento');assert.match(app.text(),/Não foi possível/);assert.doesNotMatch(app.text(),/Dados conhecidos/);
  await app.click('Atualizar andamento');assert.match(app.text(),/Dados conhecidos/);assert.doesNotMatch(app.text(),/Não foi possível/);
  assert.equal(app.nodes().filter(n=>n.type==='button').length,1);
 }finally{app.unmount();}
});
