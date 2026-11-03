import test from 'node:test';
import assert from 'node:assert/strict';
import {EMPTY_POSITION_FILTERS,positionQuantity,positionLimit,positionFilters,positionCursor,positionParams,stockPositionPage,stockWarehousePage} from '../src/lib/stock-positions-model.ts';
const productId='11111111-1111-4111-8111-111111111111',warehouseId='22222222-2222-4222-8222-222222222222';
const sample=()=>({scope:'stock_positions',data_mode:'erp_native',warehouse:null,limit:25,has_more:false,next_cursor:null,items:[{product:{id:productId,version:1,name:'Produto sintético',code:'TEST',active:true,unit:'KG',kind:'P',format:'S',gtin:null,brand:'Marca %',location:'Prat_1',stock_min:'6.000000',stock_max:'8.000000'},global:{quantity:'7.000000',state:'recorded',recorded_warehouse_count:'2',scope:'all_recorded_warehouses'},selected_position:null,limit_state:'within'}]});
test('stock positions keep all six decimal places and large sums exact, without Number rounding',()=>{
 assert.equal(positionQuantity('0.000000'),'0,000000');assert.equal(positionQuantity('0.000001'),'0,000001');assert.equal(positionQuantity('1999999999999.999998'),'1.999.999.999.999,999998');
 for(const bad of ['1','1.1234567','-0.000000','--1.000000','1e6','01.000000',1])assert.throws(()=>positionQuantity(bad));
 // Negative balances exist when the company policy allows them (migration100) and are shown with a minus sign.
 assert.equal(positionQuantity('-1.000000'),'−1,000000');assert.equal(positionQuantity('-1234.500000'),'−1.234,500000');
});
test('negative recorded balances stay readable: below the minimum, and a warehouse may exceed the global sum',()=>{
 const raw=sample();raw.items[0].global.quantity='-2.000000';raw.items[0].limit_state='below_min';assert.equal(stockPositionPage(raw,EMPTY_POSITION_FILTERS).items[0].limit_state,'below_min');
 const selected=sample();selected.warehouse={id:warehouseId,name:'Depósito sintético',active:true};selected.items[0].global.quantity='2.000000';selected.items[0].global.recorded_warehouse_count='2';selected.items[0].limit_state='below_min';
 selected.items[0].selected_position={warehouse_id:warehouseId,quantity:'5.000000',state:'recorded',version:3};assert.equal(stockPositionPage(selected,{...EMPTY_POSITION_FILTERS,warehouse_id:warehouseId}).items[0].selected_position.quantity,'5.000000');
 selected.items[0].selected_position.quantity='-0.000000';assert.throws(()=>stockPositionPage(selected,{...EMPTY_POSITION_FILTERS,warehouse_id:warehouseId}));
 const limits=sample();limits.items[0].product.stock_min='-1.000000';assert.throws(()=>stockPositionPage(limits,EMPTY_POSITION_FILTERS));
});
test('limit classification is based on registered global quantity, preserving unknown/no limits states and exact boundaries',()=>{
 assert.equal(positionLimit(null,'no_movements','1.000000',null),'no_movements');assert.equal(positionLimit(null,'review_required','1.000000',null),'review_required');
 assert.equal(positionLimit('0.000000','recorded',null,null),'not_configured');
 assert.equal(positionLimit('0.000001','recorded','0.000001','0.000001'),'within');
 assert.equal(positionLimit('0.000000','recorded','0.000001',null),'below_min');
 assert.equal(positionLimit('999999999999.999999','recorded',null,'999999999999.999998'),'above_max');
});
test('filters and cursor round trip through URL, preserve literals, reject malformed state and do not persist any form',()=>{
 const filters={...EMPTY_POSITION_FILTERS,q:'SKU 01',warehouse_id:warehouseId,brand:'Marca %',location:'Prat_1',stock_state:'no_movements',limit_state:'within'};
 const params=positionParams(filters,productId,false);assert.deepEqual(positionFilters(params),filters);assert.equal(positionCursor(params),productId);assert.equal(params.has('limit'),false);assert.equal(positionParams(filters).get('limit'),'25');
 for(const bad of ['q=x&q=y','active=1','warehouse_id=none','stock_state=zero','limit_state=available','q=%00'])assert.throws(()=>positionFilters(new URLSearchParams(bad)));
 assert.throws(()=>positionCursor(new URLSearchParams('after=broken')));assert.throws(()=>positionCursor(new URLSearchParams(`after=${productId}&after=${productId}`)));
});
test('position DTO keeps global thresholds independent of selected warehouse and projects only permitted fields',()=>{
 const raw=sample();raw.warehouse={id:warehouseId,name:'Depósito sintético',active:false};raw.items[0].selected_position={warehouse_id:warehouseId,quantity:'2.000000',state:'recorded',version:1};raw.items[0].product.price='999.0000';
 const filters={...EMPTY_POSITION_FILTERS,warehouse_id:warehouseId};const page=stockPositionPage(raw,filters);assert.equal(page.items[0].limit_state,'within');assert.equal(page.items[0].global.quantity,'7.000000');assert.equal(page.items[0].selected_position.quantity,'2.000000');assert.equal(Object.hasOwn(page.items[0].product,'price'),false);
 const zero=sample();zero.items[0].global.quantity='0.000000';zero.items[0].limit_state='below_min';assert.equal(stockPositionPage(zero,EMPTY_POSITION_FILTERS).items[0].global.quantity,'0.000000');
 const missing=sample();Object.assign(missing.items[0].global,{state:'no_movements',quantity:null,recorded_warehouse_count:'0'});missing.items[0].limit_state='no_movements';assert.equal(stockPositionPage(missing,EMPTY_POSITION_FILTERS).items[0].global.quantity,null);
});
test('malformed or inconsistent upstream stock data cannot render as a usable balance',()=>{
 for(const mutate of [v=>v.items[0].global.quantity=7,v=>v.items[0].global.quantity='7.1',v=>v.items[0].global.state='no_movements',v=>v.items[0].limit_state='below_min',v=>v.items[0].product.stock_min='9.000000',v=>v.items.push(v.items[0]),v=>v.items[0].global.recorded_warehouse_count='0']){const raw=sample();mutate(raw);assert.throws(()=>stockPositionPage(raw,EMPTY_POSITION_FILTERS));}
 const bad=sample();bad.warehouse={id:warehouseId,name:'Depósito',active:true};bad.items[0].selected_position={warehouse_id:warehouseId,quantity:null,state:'review_required',version:1};assert.throws(()=>stockPositionPage(bad,{...EMPTY_POSITION_FILTERS,warehouse_id:warehouseId}));
});
test('warehouse options expose name/status only, retaining archived warehouses and strict pagination',()=>{
 const raw={items:[{id:warehouseId,name:'Depósito arquivado',active:false,private_note:'discard'}],limit:100,has_more:false,next_cursor:null,scope:'stock_warehouse_options',data_mode:'erp_native'};
 assert.deepEqual(stockWarehousePage(raw).items,[{id:warehouseId,name:'Depósito arquivado',active:false}]);assert.throws(()=>stockWarehousePage({...raw,has_more:true,next_cursor:warehouseId}));
});
