import assert from 'node:assert/strict';
import test from 'node:test';
import {quantityInput,quantityText,stockItems} from '../src/lib/stock-model.ts';
test('stock quantity entry preserves six decimals without floating point or ambiguous thousands',()=>{
  assert.equal(quantityInput('999999999999,123456'),'999999999999.123456');
  assert.equal(quantityText('999999999999.123456'),'999.999.999.999,123456');
  assert.equal(quantityText('-0.100000'),'−0,1');
  for(const value of ['1.000,00','1e3','0','-1','1.1234567','1000000000000'])assert.throws(()=>quantityInput(value));
  assert.equal(quantityInput('-1,25',true),'-1.25');
});
test('stock command composes opposite transfer lines with separate current versions',()=>{
  const balances=[{warehouse_id:'a',warehouse_active:true,version:4},{warehouse_id:'b',warehouse_active:true,version:8}];
  assert.deepEqual(stockItems('p','transfer','0,123456','a','b',balances),[{product_id:'p',warehouse_id:'a',quantity:'-0.123456',expected_version:4},{product_id:'p',warehouse_id:'b',quantity:'0.123456',expected_version:8}]);
  assert.throws(()=>stockItems('p','transfer','1','a','a',balances));
  assert.throws(()=>stockItems('p','receipt','1','missing','',balances));
  assert.equal(stockItems('p','issue','2','a','',balances)[0].quantity,'-2');
});
