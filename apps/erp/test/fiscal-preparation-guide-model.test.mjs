import test from 'node:test';import assert from 'node:assert/strict';
import {guideCompany,guideFiscal,guideOrders,guideA1,guideSeries,guideRows,fiscalCopyPending,preparationActor} from '../src/lib/fiscal-preparation-guide-model.ts';
import {guideFixture} from './helpers/fiscal-preparation-guide-fixture.mjs';
const value=x=>({ok:true,value:x}),data=s=>({company:value(guideCompany(s.company)),fiscal:value(guideFiscal(s.fiscal)),a1:value(guideA1(s.a1)),series:value(guideSeries(s.series,s.model)),orders:value(guideOrders(s.orders))});
for(const model of ['55','65'])test(`guide${model} distinguishes missing setup from recorded metadata without readiness or choices`,()=>{
 const s=guideFixture({model});assert.ok(guideRows(data(s),model).every(r=>r.state==='recorded'));assert.deepEqual(guideRows(data(guideFixture({model,empty:true})),model).map(r=>r.state),['missing','missing','attention','missing']);assert.ok(!JSON.stringify(guideRows(data(s),model)).includes(s.orders.items[0].contact_name));assert.equal(preparationActor({...s.state,phase:'checking'}),null);
});
test('guide handles stale company versions, absent IE, expired A1 and model-bound series conservatively',()=>{
 const s=guideFixture();s.fiscal.record.identity_version=2;assert.equal(guideRows(data(s),'55')[0].state,'attention');s.fiscal.record.identity_version=1;s.company.record.data.ie=null;s.a1.current.time_valid_now=false;s.series.items[0].identity_version=2;s.series.items[0].company_changed=true;assert.deepEqual(guideRows(data(s),'55').slice(0,3).map(r=>r.state),['attention','attention','attention']);assert.throws(()=>guideSeries(s.series,'65'));
});
test('guide does not call unavailable reads absent or claim completeness from the first page',()=>{
 const s=guideFixture(),d=data(s);d.company={ok:false};d.fiscal={ok:false};d.a1={ok:false};assert.deepEqual(guideRows(d,'55').slice(0,2).map(r=>r.state),['unknown','unknown']);
 const rows=Array.from({length:25},(_,i)=>({...s.orders.items[0],id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,status:'cancelled'}));s.orders.items=rows;s.orders.has_more=true;s.orders.next_cursor=rows.at(-1).id;const order=guideRows(data(s),'55')[3];assert.equal(order.state,'attention');assert.match(order.detail,/outras páginas/);assert.doesNotMatch(order.summary,/Nenhum pedido de venda cadastrado/);
});
test('guide validates fiscal and orders boundaries without exposing raw fields',()=>{
 const s=guideFixture();for(const change of [v=>v.emission_enabled=true,v=>v.record.confirmed=false,v=>v.record.crt='9',v=>v.record.identity_version='1']){const raw=structuredClone(s.fiscal);change(raw);assert.throws(()=>guideFiscal(raw));}
 for(const change of [v=>v.operational_effects=true,v=>v.items.push(v.items[0]),v=>v.items[0].kind='purchase_orders',v=>v.has_more=true,v=>v.items[0].status='made-up']){const raw=structuredClone(s.orders);change(raw);assert.throws(()=>guideOrders(raw));}
 assert.deepEqual(guideOrders(s.orders),{count:1,notCancelled:1,hasMore:false});
});
test('022 checklist never reports absence of048/050 artifacts and preserves actual copy warnings',()=>{
 const input=['COMPANY_CONFIGURATION_CHANGED','FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED','TRANSPORT_UNAVAILABLE','HOMOLOGATION_NOT_PERFORMED','ITEM_NCM_MISSING','TAX_REVIEW_REQUIRED'];
 assert.deepEqual(fiscalCopyPending(input),['COMPANY_CONFIGURATION_CHANGED','ITEM_NCM_MISSING','TAX_REVIEW_REQUIRED']);assert.equal(input.length,8);
});
