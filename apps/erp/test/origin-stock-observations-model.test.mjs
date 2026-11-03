import test from 'node:test';import assert from 'node:assert/strict';
import {stockObserved,stockObservationLabel,parseStockObservationsPage,parseStockObservationsDetail,captureStockObservationsRequest,stockObservationsListPath,stockObservationsDetailPath} from '../src/lib/origin-stock-observations-model.ts';
import {stockQaObserved,stockQaRows,createStockObservationsFixture} from '../src/qa/stock-observations-fixture.ts';
test('087 observed quantities preserve all available digits, zero and negatives without numeric arithmetic',()=>{
 for(const [input,output]of[['0','0'],['-0.125','-0,125'],['12.123456789012345678901','12,123456789012345678901'],['9007199254740993.000001','9007199254740993,000001']])assert.equal(stockObserved(stockQaObserved(input),true),output);
 assert.equal(new Set(['absent','null','invalid'].map(state=>stockObserved(stockQaObserved(null,state),true))).size,3);
 assert.ok(!['absent','null','invalid'].some(state=>stockObserved(stockQaObserved(null,state),true)==='0'));
});
test('087 request is GET-only and binds exact IDs including leading zeros',()=>{
 const path=stockObservationsListPath('007','A & B','001'),input={method:'GET',signal:new AbortController().signal},c=captureStockObservationsRequest(path,input);
 input.method='POST';assert.equal(c.options.method,'GET');assert.equal(c.warehouseSourceId,'007');assert.equal(c.after,'001');assert.equal(new URL(path,'https://synthetic.invalid').searchParams.get('q'),'A & B');
 const detail=captureStockObservationsRequest(stockObservationsDetailPath('007','001'));assert.equal(detail.productSourceId,'001');assert.equal(detail.warehouseSourceId,'007');assert.ok(Object.isFrozen(c.options));
});
test('087 malformed IDs/queries/body and accessor options never dispatch or execute getters',()=>{
 const base='/v1/estoque-origin-observado',good=stockObservationsListPath('007');let touched=0;
 for(const path of[base,base+'?warehouse_source_id=0',base+'?warehouse_source_id=7&warehouse_source_id=8',base+'?warehouse_source_id=7&limit=26',base+'?warehouse_source_id=7&limit=01',base+'?warehouse_source_id=7&after=0',base+'?warehouse_source_id=7&q=%00',base+'?warehouse_source_id=7&unknown=1',base+'/001?warehouse_source_id=7&q=x',base+'/%30%30%31?warehouse_source_id=7',good+'#x'])assert.throws(()=>captureStockObservationsRequest(path));
 for(const options of[{method:'POST'},{body:{}},{signal:{}},{get method(){touched++;return'GET';}},{[Symbol()]:true},Object.create({method:'GET'})])assert.throws(()=>captureStockObservationsRequest(good,options));assert.equal(touched,0);
});
test('087 DTO binds warehouse/product and rejects effects or fabricated precision flags',async()=>{
 const f=createStockObservationsFixture(),raw=await f.controller.stockObservations(stockObservationsListPath('007'));
 const page=parseStockObservationsPage(raw,{warehouseSourceId:'007',limit:25,after:null});assert.ok(Object.isFrozen(page.items[0]));
 assert.throws(()=>parseStockObservationsPage(raw,{warehouseSourceId:'7',limit:25,after:null}));
 for(const key of['native_effects','can_import_balance','lexical_precision_certified','reconciled','units_compared'])assert.throws(()=>parseStockObservationsPage({...raw,[key]:true},{warehouseSourceId:'007',limit:25,after:null}));
 const d=await f.controller.stockObservations(stockObservationsDetailPath('007','001'));assert.equal(parseStockObservationsDetail(d,{warehouseSourceId:'007',productSourceId:'001'}).item.product_source_id,'001');assert.throws(()=>parseStockObservationsDetail(d,{warehouseSourceId:'007',productSourceId:'1'}));
});
test('087 missing observations and absent/duplicate warehouse remain different states',()=>{
 const rows=stockQaRows();assert.match(stockObservationLabel(rows[2]),/ainda não observado/);
 assert.notEqual(stockObservationLabel({...rows[0],observation:{...rows[0].observation,warehouse:{...rows[0].observation.warehouse,state:'absent'}}}),stockObservationLabel(rows[2]));
 assert.match(stockObservationLabel({...rows[0],observation:{...rows[0].observation,warehouse:{...rows[0].observation.warehouse,state:'invalid'}}}),/conferência/);
});
