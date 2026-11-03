import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createStockAvailabilityFixture,stockAvailabilityIds as ids}from'../src/qa/stock-availability-fixture.ts';
import{stockAvailabilityView,stockAvailabilitySelection}from'../src/lib/stock-availability.ts';
const child=(v,name)=>v.nodes().find(n=>typeof n.type==='function'&&n.type.name===name);
const policy=allow=>({scope:'stock_policy',policy:{allow_negative:allow,version:allow?1:0,updated_at:allow?'2026-10-18T10:00:00+00:00':null},can_manage:false,data_mode:'erp_native'});
// The extrato opens from the URL (/estoque-empresa?produto=<uuid>, migration 105 screen).
async function open(f){const v=await mountComponent('RealStock.tsx',{controller:f.controller},{expandChildren:false,location:`/estoque-empresa?produto=${ids.product}`});await v.flush();return v;}

test('100 product stock shows a negative balance and ledger line clearly and names the company policy',async()=>{
 const f=createStockAvailabilityFixture();f.warehouses[0].quantity='-3.000000';const reads=[];
 f.controller.stockOpening=async(path,options)=>{reads.push([path,options.method]);return policy(true);};
 const read=f.controller.stock;f.controller.stock=async(path,options)=>{const raw=await read(path,options);// The screen reads the 098 ledger mode (offset present): one issue that left the balance negative, and a signed Saldo atual total.
 return path.startsWith('/v1/estoque/movimentos')?{...raw,items:[{id:ids.recorded,kind:'issue',occurred_on:'2026-10-18',reason:'Venda sem saldo',reference:null,created_at:'2026-10-18T13:00:00Z',recorded_at_local:'2026-10-18T10:00:00',reverses_id:null,reversed_by:null,other_items:0,origin:{type:'none',document_id:null,document_kind:null,document_number:null,via:null},items:[{product_id:ids.product,warehouse_id:ids.recorded,quantity:'-3.000000',unit:'UN',balance_after:'-3.000000',balance_version:2}],revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null}],total:1,has_more:false,next_offset:null,totals:{entries:'0.000000',exits:'3.000000',current_balance:'-3.000000',unit:'UN'}}:raw;};
 const v=await open(f);try{
  assert.deepEqual(reads,[['/v1/politica-estoque','GET']]);
  assert.match(v.text(),/Estoque negativo: permitido pela política da empresa/);assert.match(v.text(),/−3/);
  // Saldo atual and the Saldos por depósito row are marked negative (Origin has no per-line Saldo column).
  assert.ok(v.nodes().some(n=>n.type==='dd'&&n.props.className==='is-negative'));assert.ok(v.nodes().some(n=>n.type==='span'&&n.props.className==='is-negative'));assert.match(v.text(),/Saída sem saldo|Venda sem saldo/);
 }finally{v.unmount();}
});
test('100 product stock without the policy port stays neutral and never fails',async()=>{
 const f=createStockAvailabilityFixture(),v=await open(f);try{assert.doesNotMatch(v.text(),/Estoque negativo:/);assert.match(v.text(),/18,125/);}finally{v.unmount();}
 const g=createStockAvailabilityFixture();g.controller.stockOpening=async()=>{throw new Error('offline');};const w=await open(g);try{assert.doesNotMatch(w.text(),/Estoque negativo:/);}finally{w.unmount();}
});
test('100 availability of an unreserved negative position is shown as recorded, never as review or zero',()=>{
 const selection=stockAvailabilitySelection(ids.product,ids.recorded,[{warehouse_id:ids.recorded,warehouse_name:'Principal',warehouse_active:true}]);
 const raw={data_mode:'erp_native',scope:'stock_availability',position:{product_id:ids.product,warehouse_id:ids.recorded,unit:'UN',state:'recorded',physical_version:2,physical_quantity:'-3.000000',reserved_quantity:'0.000000',available_quantity:'-3.000000',reservation_hash:'a'.repeat(64)}};
 const view=stockAvailabilityView(raw,selection);assert.deepEqual([view.state,view.physical,view.available],['recorded','−3','−3']);
 for(const bad of[{physical_quantity:'-0.000000',available_quantity:'0.000000'},{reserved_quantity:'-1.000000',available_quantity:'-2.000000'}])assert.throws(()=>stockAvailabilityView({...raw,position:{...raw.position,...bad}},selection));
});
