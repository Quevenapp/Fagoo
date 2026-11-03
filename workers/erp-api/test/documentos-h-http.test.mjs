import test from'node:test';import assert from'node:assert/strict';
import{fiscalInvoicesRoute,fiscalInvoicesMethods,parseFiscalInvoicesRoute}from'../src/fiscal-invoices.mjs';
import{parseInvoiceBalance,capturePartialItems}from'../../../packages/erp-domain/src/sales-invoice-balance.mjs';

// Leva H, lane documentos (391): the routes of "Resumo de faturamento" and "Gerar nota fiscal parcial". Synthetic data only.
const DOC='10000000-0000-4000-8000-000000000391',ITEM='20000000-0000-4000-8000-000000000391',CMD='30000000-0000-4000-8000-000000000391',NOTE='40000000-0000-4000-8000-000000000391';
const req=(path,init)=>new Request('https://api.synthetic.test'+path,init);
const balance={document_id:DOC,full_invoice_id:null,items:[{document_item_id:ITEM,position:1,product_id:null,description:'Peça',unit:'UN',ordered:'100.0000',invoiced:'40.0000',remaining:'60.0000'}],
 invoices:[{id:NOTE,number:null,series:1,model:'55',status:1,partial:true,counts:true}]};

test('391 balance route: GET only, the pedido id, and a checked answer',async()=>{
 const route=fiscalInvoicesRoute(`/v1/notas-fiscais/pedido/${DOC}/saldo`);
 assert.deepEqual(route,{kind:'order_balance',id:DOC});assert.deepEqual(fiscalInvoicesMethods(route),['GET']);
 const parsed=await parseFiscalInvoicesRoute(req(`/v1/notas-fiscais/pedido/${DOC}/saldo`),route);
 assert.deepEqual([parsed.rpc,parsed.args],['erp_document_invoice_balance',{p_document_id:DOC}]);
 assert.equal(parsed.check({scope:'document_invoice_balance',data_mode:'erp_native',...balance}).items[0].remaining,'60.0000');
 for(const bad of[{...balance},{scope:'document_invoice_balance',data_mode:'erp_native',...balance,document_id:NOTE},
  {scope:'document_invoice_balance',data_mode:'erp_native',...balance,items:[{...balance.items[0],remaining:'61.0000'}]}])
  assert.throws(()=>parsed.check(bad),e=>e.status===502,JSON.stringify(bad).slice(0,80));
 await assert.rejects(()=>parseFiscalInvoicesRoute(req(`/v1/notas-fiscais/pedido/${DOC}/saldo?x=1`),route),e=>e.status===400);
 assert.equal(fiscalInvoicesRoute('/v1/notas-fiscais/pedido/x/saldo').kind,'unknown');
});

test('391 partial items: positive 4-decimal quantities, distinct positions and items',()=>{
 assert.deepEqual(capturePartialItems([{position:1,document_item_id:ITEM,quantity:'40.0000'}]),[{position:1,document_item_id:ITEM,quantity:'40.0000'}]);
 for(const bad of[[],[{position:1,document_item_id:ITEM,quantity:'0.0000'}],[{position:1,document_item_id:ITEM,quantity:'40'}],[{position:0,document_item_id:ITEM,quantity:'1.0000'}],
  [{position:1,document_item_id:ITEM,quantity:'1.0000'},{position:1,document_item_id:DOC,quantity:'1.0000'}],[{position:1,document_item_id:ITEM,quantity:'1.0000',x:1}]])
  assert.throws(()=>capturePartialItems(bad),e=>e.status===400,JSON.stringify(bad));
 assert.throws(()=>parseInvoiceBalance({...balance,full_invoice_id:'x'},DOC,{scoped:false}),e=>e.status===502);
});

test('391 partial route: POST only, a strict body before any RPC',async()=>{
 const route=fiscalInvoicesRoute('/v1/notas-fiscais/parcial');assert.deepEqual(fiscalInvoicesMethods(route),['POST']);
 const post=body=>req('/v1/notas-fiscais/parcial',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 for(const bad of[{command_id:CMD,document_id:DOC,invoice:{},items:[]},{command_id:CMD,document_id:'x',invoice:{},items:[{position:1,document_item_id:ITEM,quantity:'1.0000'}]},{command_id:CMD,document_id:DOC,items:[]}])
  await assert.rejects(()=>parseFiscalInvoicesRoute(post(bad),route),e=>e.status===400,JSON.stringify(bad));
});

test('392 lixeira route: POST only, a strict body and a checked answer per document',async()=>{
 const{documentsRoute,documentsMethods,documentsOperation,documentsResponse}=await import('../src/documents.mjs');
 const route=documentsRoute('/v1/documentos/sales_orders/lixeira');assert.equal(route.action,'trash');assert.deepEqual(documentsMethods(route),['POST']);
 const post=body=>new Request('https://api.synthetic.test/v1/documentos/sales_orders/lixeira',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const op=await documentsOperation(post({command_id:CMD,action:'delete',ids:[DOC],reason:'Pedido duplicado'}),route,new URLSearchParams());
 assert.deepEqual([op.rpc,op.args],['erp_document_trash',{p_kind:'sales_orders',p_command_id:CMD,p_action:'delete',p_ids:[DOC],p_reason:'Pedido duplicado'}]);
 for(const bad of[{command_id:CMD,action:'delete',ids:[DOC],reason:'x'},{command_id:CMD,action:'restore',ids:[DOC],reason:'x'},{command_id:CMD,action:'drop',ids:[DOC],reason:null},{command_id:CMD,action:'restore',ids:[],reason:null}])
  await assert.rejects(()=>documentsOperation(post(bad),route,new URLSearchParams()),e=>e.status===400,JSON.stringify(bad));
 const answer={scope:'document_trash',data_mode:'erp_native',kind:'sales_orders',action:'delete',command_id:CMD,replayed:false,results:[{id:DOC,ok:false,reason:'invoice_linked'}]};
 assert.deepEqual(documentsResponse(answer,route,op).results,[{id:DOC,ok:false,reason:'invoice_linked'}]);
 assert.throws(()=>documentsResponse({...answer,results:[{id:DOC,ok:false,reason:'other'}]},route,op),e=>e.status===502);
});
