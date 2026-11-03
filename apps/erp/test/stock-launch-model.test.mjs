import test from 'node:test';
import assert from 'node:assert/strict';
import {amendBody,balanceSuffix,consideredTotal,launchBody,launchQuantity,ledgerNote,linePrices,moneyText,parseLaunchResult,parseReservations,parseStockTotals,priceDraft,priceInput,priceText,stockLevel} from '../src/lib/stock-launch-model.ts';

// Controle de estoque like Origin (migration 105): exact strings only, synthetic IDs.
const P='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',B='33333333-3333-4333-8333-333333333333',M='44444444-4444-4444-8444-444444444444';
test('prices: Origin input with comma or dot, ten decimals, no thousand separators; display with at least two decimals',()=>{
 assert.equal(priceInput('1,5','Preço de Compra'),'1.5');assert.equal(priceInput('0','Preço de Custo'),'0');assert.equal(priceInput('12345678901234.1234567890','x'),'12345678901234.1234567890');
 for(const value of['','1.000,00','1e3','-1','1,12345678901','123456789012345'])assert.throws(()=>priceInput(value,'Preço de Compra'),undefined,value);
 assert.throws(()=>priceInput('','Preço de Compra'),/Informe o preço de compra/);
 assert.deepEqual(['1.5000000000','1234.0000000000','0.1234567890',null,'x'].map(priceText),['1,50','1.234,00','0,123456789','-','-']);
 assert.equal(priceDraft('2.5'),'2,50');assert.equal(priceDraft(null),'');assert.equal(moneyText('1234567.89'),'R$ 1.234.567,89');assert.equal(moneyText('-3.10'),'−R$ 3,10');
});
test('quantities: Entrada/Saída positive; Balanço accepts zero and negative; "Quantidade inválida!" otherwise',()=>{
 assert.equal(launchQuantity('2,5','receipt'),'2.5');assert.equal(launchQuantity('0','balance'),'0');assert.equal(launchQuantity('-1,25','balance'),'-1.25');
 for(const [value,kind]of[['0','receipt'],['-1','issue'],['-0','balance'],['1.1234567','transfer'],['abc','balance'],['1.000,5','receipt']])
  assert.throws(()=>launchQuantity(value,kind),/Quantidade inválida!/,`${value} ${kind}`);
});
test('launch body follows the panel: Saída sends no cost, transfer needs another destination, note stays optional',()=>{
 const base={productId:P,warehouseId:A,expectedVersion:3,quantity:'2',unitPrice:'1,5',unitCost:'1,75',note:'  '};
 assert.deepEqual(launchBody({...base,kind:'receipt'}),{kind:'receipt',product_id:P,warehouse_id:A,quantity:'2',expected_version:3,unit_price:'1.5',note:null,unit_cost:'1.75'});
 assert.deepEqual(launchBody({...base,kind:'issue',unitCost:null}),{kind:'issue',product_id:P,warehouse_id:A,quantity:'2',expected_version:3,unit_price:'1.5',note:null});
 assert.equal(launchBody({...base,kind:'balance',quantity:'0'}).quantity,'0');
 assert.deepEqual(launchBody({...base,kind:'transfer',destinationId:B,destinationVersion:0}).destination_id,B);
 assert.throws(()=>launchBody({...base,kind:'transfer',destinationId:A,destinationVersion:0}),/outro depósito/);
 assert.throws(()=>launchBody({...base,kind:'receipt',unitCost:''}),/preço de custo/);assert.throws(()=>launchBody({...base,kind:'issue',unitPrice:''}),/preço de venda/);
 assert.throws(()=>launchBody({...base,kind:'receipt',expectedVersion:-1}),/Atualize os saldos/);
 // The observação is the one-line 009 reason: a line break is explained before anything is sent.
 assert.throws(()=>launchBody({...base,kind:'receipt',note:'Compra\nsegunda linha'}),/única linha/);
 assert.equal(launchBody({...base,kind:'receipt',note:'Compra\n'}).note,'Compra','a trailing line break is trimmed');
 assert.throws(()=>amendBody({revision:1,balance:null,items:[{product_id:P,quantity:'1.000000'}]},P,'1','1','Compra\nrevisada'),/única linha/);
});
test('ledger display: Balanço suffix, price columns by direction, considered total and the colored Saldo atual',()=>{
 const balance={counted:'5.000000',previous:'7.000000',warehouse_id:A,source:'launch'};
 assert.equal(balanceSuffix(balance),' Saldo: 5 (Saldo anterior: 7)');assert.equal(ledgerNote({note:null,reason:'Lançamento manual',balance}),'Lançamento manual Saldo: 5 (Saldo anterior: 7)');
 assert.equal(ledgerNote({note:'Ajustado',reason:'Lançamento manual',balance:null}),'Ajustado');
 const row={unit_price:'2.0000000000',unit_cost:'1.5000000000',balance:null};
 assert.deepEqual(linePrices(row,{quantity:'-1.000000'}),{sale:'2,00',purchase:'-',cost:'-'});assert.deepEqual(linePrices(row,{quantity:'1.000000'}),{sale:'-',purchase:'2,00',cost:'1,50'});
 assert.deepEqual(linePrices({...row,balance},{quantity:'-2.000000'}),{sale:'-',purchase:'2,00',cost:'1,50'});
 assert.equal(consideredTotal([{quantity:'1.500000',warehouse_ignored:false},{quantity:'10.000000',warehouse_ignored:true},{quantity:'-0.500000'}]),'1.000000');
 assert.equal(stockLevel('3.000000','4','10').tone,'low');assert.equal(stockLevel('-1.000000','4',null).tone,'negative');assert.equal(stockLevel('5.000000',null,null).tone,'normal');
 assert.equal(stockLevel('3.000000','4.5','10').title,'Estoque mínimo: 4,5\nEstoque máximo: 10\nEstoque faltante: 1,5');
});
test('defensive reads of launch, amend, totals and reservations',()=>{
 const body=launchBody({kind:'balance',productId:P,warehouseId:A,expectedVersion:2,quantity:'5',unitPrice:'1',unitCost:'1',note:''});
 const value={scope:'stock_launch',data_mode:'erp_native',kind:'balance',occurred_on:'2026-10-20',replayed:false,movement:{id:M,items:[{product_id:P,warehouse_id:A,quantity:'-2.000000',balance_after:'5.000000'}]},
  detail:{revision:1,unit_price:'1.0000000000',unit_cost:'1.0000000000',note:'Lançamento manual'},balance:{counted:'5.000000',previous:'7.000000',warehouse_id:A}};
 assert.equal(parseLaunchResult(value,body).balance.previous,'7.000000');
 for(const bad of[{kind:'receipt'},{balance:null},{movement:{id:M,items:[{product_id:B,warehouse_id:A,quantity:'-2.000000',balance_after:'5.000000'}]}},{detail:{...value.detail,revision:2}},{scope:'x'}])
  assert.throws(()=>parseLaunchResult({...value,...bad},body),undefined,JSON.stringify(bad));
 assert.deepEqual(amendBody({revision:1,balance:null,items:[{product_id:P,quantity:'-1.000000'}]},P,'2','','Venda'),{product_id:P,expected_revision:1,unit_price:'2',unit_cost:null,note:'Venda'});
 assert.throws(()=>amendBody({revision:1,balance:null,items:[{product_id:P,quantity:'1.000000'}]},P,'2','','Compra'),/preço de custo/);
 const totals={scope:'stock_totals',data_mode:'erp_native',warehouse_id:null,quantity:'3.000000',sale_value:'7.50',unpriced_products:0,ignored_warehouses:1,warehouses:[{id:A,name:'Geral',active:true,is_default:true,ignore_balance:false}]};
 assert.equal(parseStockTotals(totals,null).warehouses[0].is_default,true);
 for(const bad of[{warehouse_id:A},{sale_value:'7.5'},{warehouses:[{id:A,name:'Geral',active:true,is_default:true,ignore_balance:false},{id:B,name:'Outro',active:true,is_default:true,ignore_balance:false}]}])assert.throws(()=>parseStockTotals({...totals,...bad},null));
 const reservations={scope:'stock_product_reservations',product_id:P,warehouse_id:A,items:[{reservation_id:M,document_id:M,document_number:'5',status:'verified',contact_name:'Cliente',warehouse_id:A,quantity:'1.000000',unit:'UN'}],total:1,quantity:'1.000000'};
 assert.equal(parseReservations(reservations,P,A).items.length,1);assert.throws(()=>parseReservations(reservations,P,B));
});
