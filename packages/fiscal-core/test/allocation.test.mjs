import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {allocateFiscalAmount,AllocationError,ALLOCATION_MAX_CENTS} from '../src/allocation.mjs';

const id=n=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const input=(weights,total='100',kind='freight',basis={type:'amount'})=>({kind,total_cents:total,basis,
 items:weights.map((weight,i)=>({id:id(i+1),...(basis.type==='equal'?{}:{weight}),
  ...(basis.type==='quantity'?{unit:basis.unit}:{}),...(kind==='discount'?{discount_capacity_cents:'100000'}:{})}))});
const allocated=result=>Object.fromEntries(result.items.map(row=>[row.id,row.allocated_cents]));
const checkCode=(code,line=null)=>error=>error instanceof AllocationError&&error.code===code&&error.item_id===line;
const freezeDeep=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freezeDeep);Object.freeze(value);}return value;};

test('largest remainders preserve exact cents and use canonical UUID ties while retaining input order',()=>{
 const request=input(['1','1','1']);request.items=[request.items[2],request.items[0],request.items[1]];
 const result=allocateFiscalAmount(request);
 assert.deepEqual(result.items.map(row=>row.id),[id(3),id(1),id(2)]);
 assert.deepEqual(allocated(result),{[id(3)]:'33',[id(1)]:'34',[id(2)]:'33'});
 assert.equal(result.items[1].floor_cents,'33');assert.equal(result.items[1].rounding_cent,'1');
 assert.equal(result.items[1].remainder_numerator,'1');assert.equal(result.basis.weight_total_units,'3');
 const unequal=allocateFiscalAmount(input(['1','2','4'],'3'));
 assert.deepEqual(unequal.items.map(row=>row.allocated_cents),['0','1','2']);
 assert.equal(unequal.allocated_total_cents,'3');assert.equal(unequal.undistributed_cents,'0');
});

test('permutations cannot transfer the rounding cent to another item',()=>{
 const request=input(['3','7','2','7','0'],'97'),expected=allocated(allocateFiscalAmount(request));
 const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest])):[[]];
 for(const items of permutations(request.items)){
  const result=allocateFiscalAmount({...request,items});
  assert.deepEqual(allocated(result),expected);
  assert.deepEqual(result.items.map(row=>row.id),items.map(row=>row.id));
 }
});

test('explicit quantity/manual bases use exact six-place weights without unit conversions',()=>{
 const request=input(['1.230000','2.460000','0.000000'],'10','other',{type:'quantity',unit:'PÇ'});
 const result=allocateFiscalAmount(request);
 assert.deepEqual(result.items.map(row=>row.allocated_cents),['3','7','0']);
 assert.deepEqual(result.items.map(row=>row.weight_units),['1230000','2460000','0']);
 assert.equal(result.basis.weight_scale,6);assert.equal(result.basis.unit,'PÇ');
 assert.deepEqual(allocated(result),allocated(allocateFiscalAmount(input(['1.23','2.46','0'],'10','other',{type:'manual'}))));
 const tiny=allocateFiscalAmount(input(['0.000001','0.000002'],'1','freight',{type:'manual'}));
 assert.deepEqual(tiny.items.map(row=>row.allocated_cents),['0','1']);
 for(const unit of['PC','pç','PC\u0327']){
  const invalid=structuredClone(request);invalid.items[0].unit=unit;
  assert.throws(()=>allocateFiscalAmount(invalid),checkCode('ALLOCATION_UNIT_MISMATCH',id(1)));
 }
 for(const unit of['',' UN','UN ', 'A\nB', 'A\u0085B', '\ud800', 'A'.repeat(17)]){
  assert.throws(()=>allocateFiscalAmount(input(['1'],'0','other',{type:'quantity',unit})),checkCode('ALLOCATION_INVALID_UNIT'));
 }
});

test('zero bases never silently become equal bases and zero weights never receive a cent',()=>{
 for(const type of['amount','quantity','manual']){
  const basis=type==='quantity'?{type,unit:'UN'}:{type};
  assert.throws(()=>allocateFiscalAmount(input(['0','0'],'1','freight',basis)),checkCode('ALLOCATION_ZERO_BASIS'));
  assert.deepEqual(allocateFiscalAmount(input(['0','0'],'0','freight',basis)).items.map(row=>row.allocated_cents),['0','0']);
  assert.deepEqual(allocateFiscalAmount(input(['0','1','0'],'99','freight',basis)).items.map(row=>row.allocated_cents),['0','99','0']);
 }
 const equal=allocateFiscalAmount(input([null,null,null],'2','other',{type:'equal'}));
 assert.deepEqual(equal.items.map(row=>row.allocated_cents),['1','1','0']);
 assert.equal(equal.basis.weight_scale,0);assert.equal(equal.basis.weight_total_units,'3');
});

test('discount caps are explicit and excessive proportional shares fail without redistribution',()=>{
 const request=input(['1','1'],'3','discount');request.items[0].discount_capacity_cents='1';request.items[1].discount_capacity_cents='2';
 assert.throws(()=>allocateFiscalAmount(request),checkCode('ALLOCATION_DISCOUNT_ITEM_EXCEEDS_CAPACITY',id(1)));
 // There is room overall, but choosing a different proportional rule is a new decision.
 assert.deepEqual(allocateFiscalAmount({...request,total_cents:'2'}).items.map(row=>row.allocated_cents),['1','1']);
 assert.throws(()=>allocateFiscalAmount({...request,total_cents:'4'}),checkCode('ALLOCATION_DISCOUNT_TOTAL_EXCEEDS_CAPACITY'));
 const zeroWeight=input(['0','1'],'2','discount');zeroWeight.items[1].discount_capacity_cents='1';
 assert.throws(()=>allocateFiscalAmount(zeroWeight),checkCode('ALLOCATION_DISCOUNT_TOTAL_EXCEEDS_CAPACITY'));
 const exactly=input(['1','2'],'3','discount');exactly.items[0].discount_capacity_cents='1';exactly.items[1].discount_capacity_cents='2';
 assert.deepEqual(allocateFiscalAmount(exactly).items.map(row=>row.allocated_cents),['1','2']);
 const zero=input(['0'],'0','discount');zero.items[0].discount_capacity_cents='0';
 assert.equal(allocateFiscalAmount(zero).items[0].allocated_cents,'0');
});

test('each component is independent, inputs remain untouched, and no arithmetic result asserts tax/XML readiness',()=>{
 const request=freezeDeep(input(['3','2','1'],'101','discount'));
 const initial=JSON.stringify(request),discount=allocateFiscalAmount(request);
 const freight=allocateFiscalAmount({...request,kind:'freight',items:request.items.map(({discount_capacity_cents,...item})=>item)});
 const other=allocateFiscalAmount({...request,kind:'other',items:request.items.map(({discount_capacity_cents,...item})=>item)});
 assert.deepEqual(allocated(discount),allocated(freight));assert.deepEqual(allocated(other),allocated(freight));
 assert.equal(JSON.stringify(request),initial);
 for(const result of[discount,freight,other]){
  for(const field of['operational_effects','emission_enabled','can_emit','tax_rules_validated','xsd_validated'])assert.equal(result[field],false);
  assert.equal(result.data_mode,'mathematical_allocation');assert.equal(result.algorithm,'largest-remainder-uuid-v1');
  assert.ok(!Object.hasOwn(result,'tax_base'));assert.ok(!Object.hasOwn(result,'net_invoice_value'));
  assert.doesNotThrow(()=>JSON.stringify(result));
 }
});

test('250 lines, maximum money and large weight products stay exact beyond Number precision',()=>{
 const request=input(Array.from({length:250},()=>ALLOCATION_MAX_CENTS),ALLOCATION_MAX_CENTS);
 const result=allocateFiscalAmount(request);
 assert.equal(result.items.length,250);
 assert.equal(result.items.reduce((sum,row)=>sum+BigInt(row.allocated_cents),0n),BigInt(ALLOCATION_MAX_CENTS));
 assert.equal(result.items[0].allocated_cents,'4000000000000');assert.equal(result.items[249].allocated_cents,'3999999999999');
 assert.equal(result.items.filter(row=>row.rounding_cent==='1').length,249);
 const decimal=allocateFiscalAmount(input(['999999999999.999999','999999999999.999998'],ALLOCATION_MAX_CENTS,'other',{type:'manual'}));
 assert.deepEqual(decimal.items.map(row=>row.allocated_cents),['500000000000000','499999999999999']);
 assert.throws(()=>allocateFiscalAmount(input(Array.from({length:251},()=> '1'))),checkCode('ALLOCATION_INVALID_ITEMS'));
 assert.throws(()=>allocateFiscalAmount(input([])),checkCode('ALLOCATION_INVALID_ITEMS'));
});

test('invalid input types, precision, IDs, unknown decisions and undeclared fields are rejected without echoing data',()=>{
 for(const total of[0,1n,null,'','01','-1','1.00','1e2',' 1','1000000000000000']){
  assert.throws(()=>allocateFiscalAmount(input(['1'],total)),checkCode('ALLOCATION_INVALID_TOTAL'));
 }
 for(const weight of[1,1n,null,'01','-1','1.00','1e2','1000000000000000']){
  assert.throws(()=>allocateFiscalAmount(input([weight])),checkCode('ALLOCATION_INVALID_WEIGHT',id(1)));
 }
 for(const weight of['0.0000001','1.2300000','1000000000000','1e-6','+1',1]){
  assert.throws(()=>allocateFiscalAmount(input([weight],'1','other',{type:'manual'})),checkCode('ALLOCATION_INVALID_WEIGHT',id(1)));
 }
 for(const mutate of[r=>r.kind='tax',r=>r.basis={type:'automatic'},r=>r.basis.unit='UN',r=>r.can_emit=true,r=>r.items[0].source_id='secret',r=>delete r.items[0].weight]){
  const invalid=input(['1']);mutate(invalid);assert.throws(()=>allocateFiscalAmount(invalid),AllocationError);
 }
 const duplicate=input(['1','2']);duplicate.items[1].id=duplicate.items[0].id.toUpperCase();
 assert.throws(()=>allocateFiscalAmount(duplicate),checkCode('ALLOCATION_DUPLICATE_ITEM',id(1)));
 const badId=input(['1']);badId.items[0].id='PRIVATE INPUT';
 assert.throws(()=>allocateFiscalAmount(badId),error=>error.code==='ALLOCATION_INVALID_ITEM'&&!JSON.stringify(error).includes('PRIVATE INPUT'));
 const missing=input(['1'],'1','discount');delete missing.items[0].discount_capacity_cents;
 assert.throws(()=>allocateFiscalAmount(missing),checkCode('ALLOCATION_INVALID_ITEM'));
 const noWeight=input(['1'],'1','other',{type:'equal'});noWeight.items[0].weight='0';
 assert.throws(()=>allocateFiscalAmount(noWeight),checkCode('ALLOCATION_INVALID_ITEM'));
 const sparse=input(['1']);sparse.items.length=2;
 assert.throws(()=>allocateFiscalAmount(sparse),checkCode('ALLOCATION_INVALID_ITEM'));
});

test('deterministic generated examples conserve each cent and each share is its exact floor or ceiling',()=>{
 let seed=20261016n;const next=()=>{seed=(seed*48271n)%2147483647n;return seed;};
 for(let cycle=0;cycle<100;cycle++){
  const count=1+Number(next()%25n),weights=Array.from({length:count},()=>next()%1000n),total=next()*100000n+next()%100000n;
  weights[0]+=1n;const denominator=weights.reduce((sum,v)=>sum+v,0n);
  const result=allocateFiscalAmount(input(weights.map(String),total.toString()));
  assert.equal(result.items.reduce((sum,row)=>sum+BigInt(row.allocated_cents),0n),total);
  result.items.forEach((row,i)=>{
   const numerator=total*weights[i],value=BigInt(row.allocated_cents);
   assert.ok(value===numerator/denominator||value===(numerator+denominator-1n)/denominator);
   if(weights[i]===0n)assert.equal(value,0n);
  });
  assert.deepEqual(allocated(allocateFiscalAmount(input(weights.map(w=>(w*7n).toString()),total.toString()))),allocated(result));
 }
});

test('money limit is anchored to selected official XSD fields, not treated as a complete fiscal validation',async()=>{
 const base=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/tiposBasico_v4.00.xsd',import.meta.url),'utf8');
 const node=base.split('<xs:simpleType name="TDec_1302">')[1].split('</xs:simpleType>')[0];
 assert.ok(node.includes('[0-9]{0,12}'));assert.ok(node.includes('[0-9]{2}'));
 assert.equal(ALLOCATION_MAX_CENTS,'9'.repeat(15));
 const layout=await readFile(new URL('../../fiscal-schema/schemas/pl010f-v1.04/leiauteNFe_v4.00.xsd',import.meta.url),'utf8');
 for(const tag of['vDesc','vFrete','vOutro']){
  assert.ok(layout.includes('name="'+tag+'" type="TDec_1302Opc"'));
  assert.ok(layout.includes('name="'+tag+'" type="TDec_1302"'));
 }
});
