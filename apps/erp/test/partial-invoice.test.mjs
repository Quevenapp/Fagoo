import test from'node:test';import assert from'node:assert/strict';
import{cutSource,picksProblem,quantity4}from'../src/lib/partial-invoice-model.ts';

// Leva H, lane documentos (VND-047): the pedido cut to the chosen quantities for "Gerar nota fiscal parcial". Synthetic data only.
const item=(position,quantity,price,discount)=>({position,product_id:`00000000-0000-4000-8000-00000000000${position}`,description:`Item ${position}`,code:null,unit:'UN',quantity,unit_price:price,
 gross:(Number(quantity)*Number(price)).toFixed(2),discount,total:(Number(quantity)*Number(price)-Number(discount)).toFixed(2),product:null,composition:null});
const source={eligible:false,reasons:[{code:'has_invoice',items:[]}],existing_invoice:{id:'x'},items:[item(1,'100','10','100.00'),item(2,'10','5','0.00')],
 totals:{gross:'1050.00',line_discount:'100.00',discount:'95.00',freight:'19.00',other_expenses:'0.00',total:'874.00'},installments:[{position:1}]};
const balance={document_id:'d',full_invoice_id:null,items:[{position:1,document_item_id:'a',remaining:'60.0000'},{position:2,document_item_id:'b',remaining:'10.0000'}],invoices:[]};

test('the cut keeps only the chosen quantities, shares discount and freight by value and drops the parcels',()=>{
 const cut=cutSource(source,[{position:1,quantity:'40'}]);
 assert.equal(cut.eligible,true);assert.deepEqual(cut.reasons,[]);assert.deepEqual(cut.installments,[]);
 assert.deepEqual(cut.items.map(i=>[i.position,i.quantity,i.gross,i.discount,i.total]),[[1,'40','400.00','40.00','360.00']]);
 // Net of the pedido 1000 - 100 + 50 = 950; picked net 360 → 360/950 of the pedido discount 95 = 36,00 and of the freight 19 = 7,20.
 assert.deepEqual(cut.totals,{gross:'400.00',line_discount:'40.00',discount:'36.00',freight:'7.20',other_expenses:'0.00',total:'331.20'});
 assert.throws(()=>cutSource(source,[{position:1,quantity:'101'}]),/fora do pedido/);
 assert.throws(()=>cutSource({...source,reasons:[{code:'cancelled',items:[]}]},[{position:1,quantity:'1'}]),/não pode gerar nota/);
});

test('the quantities typed are checked against the balance of each item',()=>{
 assert.equal(picksProblem(balance,[{position:1,quantity:'60'},{position:2,quantity:'2.5'}]),null);
 assert.match(picksProblem(balance,[{position:1,quantity:'60.0001'}]),/passa do saldo/);
 assert.match(picksProblem(balance,[]),/pelo menos um item/);
 assert.match(picksProblem(balance,[{position:1,quantity:'1.12345'}]),/4 casas/);
 assert.match(picksProblem({...balance,full_invoice_id:'n'},[{position:1,quantity:'1'}]),/nota fiscal completa/);
 assert.equal(quantity4('2.5'),'2.5000');
});

test('NFE-209: the product labels of entry notes, one per quantity rounded up, only products of the cadastro',async()=>{
 const{invoiceLabelProducts}=await import('../src/lib/document-labels-model.ts');
 const labels=invoiceLabelProducts([{items:[{product_id:'p1',description:'Parafuso',code:'P1',quantity:'2.5000',gtin:'7891234567895'},{description:'Frete avulso',quantity:'1'}]},{items:[{product_id:'p1',description:'Parafuso',quantity:'1'}]}]);
 assert.deepEqual(labels.products,[{id:'p1',name:'Parafuso',code:'P1',price:null,gtin:'7891234567895'}]);
 assert.deepEqual(labels.quantities,{p1:'4'});assert.equal(labels.orders,2);
});
