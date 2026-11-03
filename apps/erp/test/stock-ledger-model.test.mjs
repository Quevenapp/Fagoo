import test from 'node:test';
import assert from 'node:assert/strict';
import {EMPTY_LEDGER_FILTERS,STOCK_LABELS,STOCK_LEDGER_SIZE,STOCK_ORIGIN_LABELS,ledgerMoment,ledgerPageCount,ledgerQuery,originHref,originLabel,originReadable,quantityText,stockLedgerPage,validLedgerFilters} from '../src/lib/stock-model.ts';

const product='11111111-1111-4111-8111-111111111111',warehouse='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',doc='44444444-4444-4444-8444-444444444444';
const none={type:'none',document_id:null,document_kind:null,document_number:null,via:null};
const row=(patch={})=>({id:'55555555-5555-4555-8555-555555555555',kind:'receipt',occurred_on:'2026-10-19',reason:'Entrada sintética',reference:null,created_at:'2026-10-19T16:04:05+00:00',recorded_at_local:'2026-10-19T13:04:05',
 reverses_id:null,reversed_by:null,other_items:0,origin:none,items:[{product_id:product,warehouse_id:warehouse,quantity:'1.000001',unit:'UN',balance_after:'1.000001',balance_version:1}],
 revision:0,note:null,unit_price:null,unit_cost:null,price_source:null,balance:null,...patch});
const page=(patch={})=>({product_id:product,items:[row()],limit:100,offset:0,total:1,has_more:false,next_offset:null,totals:{entries:'1.000001',exits:'0.000000',current_balance:'1.000001',unit:'UN'},data_mode:'erp_native',...patch});

test('Origin wording: Tipo keeps the FAGOO kinds and Tipo de Origem only lists origins that exist',()=>{
 assert.deepEqual(Object.values(STOCK_LABELS),['Entrada','Saída','Ajuste','Transferência','Estorno']);
 // 259: the Brufap notes post stock (Notas Fiscais, first as in Origin); 364: Origem excluída for a lançamento whose note or document was deleted.
 assert.deepEqual(Object.values(STOCK_ORIGIN_LABELS),['Notas Fiscais','Vendas','Compras','Serviços','Transferências','Sem origem','Origem excluída']);
 assert.equal(STOCK_LEDGER_SIZE,100);assert.deepEqual(EMPTY_LEDGER_FILTERS,{warehouse_id:'',kind:'',origin:'',from:'',to:'',direction:''});
});

test('ledger query always pages by 100 from offset and omits empty filters in a fixed order',()=>{
 assert.equal(ledgerQuery(product,EMPTY_LEDGER_FILTERS,1),`product_id=${product}&limit=100&offset=0`);
 assert.equal(ledgerQuery(product,{warehouse_id:warehouse,kind:'reversal',origin:'transfers',from:'2026-10-01',to:'2026-10-31',direction:''},3),
  `product_id=${product}&limit=100&offset=200&warehouse_id=${warehouse}&kind=reversal&origin=transfers&date_from=2026-10-01&date_to=2026-10-31`);
 assert.equal(ledgerQuery(product,{...EMPTY_LEDGER_FILTERS,to:'2026-10-31'},1),`product_id=${product}&limit=100&offset=0&date_to=2026-10-31`);
 for(const filters of[{...EMPTY_LEDGER_FILTERS,kind:'balance'},{...EMPTY_LEDGER_FILTERS,origin:'fiscal'},{...EMPTY_LEDGER_FILTERS,from:'2026-02-30'},{...EMPTY_LEDGER_FILTERS,from:'2026-10-02',to:'2026-10-01'},{...EMPTY_LEDGER_FILTERS,warehouse_id:'x'}]){
  assert.equal(validLedgerFilters(filters),false);assert.throws(()=>ledgerQuery(product,filters,1));
 }
 for(const value of[0,1.5,-1])assert.throws(()=>ledgerQuery(product,EMPTY_LEDGER_FILTERS,value));
 assert.throws(()=>ledgerQuery('not-a-uuid',EMPTY_LEDGER_FILTERS,1));
 assert.deepEqual([ledgerPageCount(0),ledgerPageCount(100),ledgerPageCount(101),ledgerPageCount(322)],[1,1,2,4]);
});

test('ledger page must answer this product, page and filter set; decimals stay exact strings',()=>{
 const value=stockLedgerPage(page(),product,EMPTY_LEDGER_FILTERS,1);
 assert.equal(value.items[0].items[0].quantity,'1.000001');assert.equal(quantityText(value.totals.entries),'1,000001');
 assert.equal(stockLedgerPage(page({offset:100,items:[],total:101,has_more:false}),product,EMPTY_LEDGER_FILTERS,2).offset,100);
 const filtered={...EMPTY_LEDGER_FILTERS,warehouse_id:warehouse,kind:'receipt',origin:'none',from:'2026-10-19',to:'2026-10-19'};
 assert.equal(stockLedgerPage(page(),product,filtered,1).items.length,1);
 const bad=[page({product_id:other}),page({limit:25}),page({offset:100}),page({data_mode:'staging_readonly'}),page({total:'1'}),page({items:null}),
  page({totals:{entries:'1.5',exits:'0.000000',current_balance:'1.000001',unit:'UN'}}),page({totals:{entries:'1.000001',exits:'0.000000',current_balance:'-0.000000',unit:'UN'}}),page({totals:{entries:'-1.000001',exits:'0.000000',current_balance:'1.000001',unit:'UN'}}),page({totals:{entries:1,exits:'0.000000',current_balance:'1.000001',unit:'UN'}}),
  page({items:[row({items:[{product_id:other,warehouse_id:warehouse,quantity:'1',unit:'UN',balance_after:'1',balance_version:1}]})]}),page({items:[row({items:[]})]}),
  page({items:[row({items:[{product_id:product,warehouse_id:warehouse,quantity:1,unit:'UN',balance_after:'1',balance_version:1}]})]}),
  page({items:[row({recorded_at_local:'19/10/2026 13:04'})]}),page({items:[row({kind:'balance'})]}),page({items:[row({other_items:-1})]}),
  page({items:[row({origin:{...none,type:'deleted'}})]}),page({items:[row({origin:{...none,document_id:doc}})]}),
  page({items:[row({origin:{type:'sales',document_id:doc,document_kind:'service_orders',document_number:'1',via:'document_stock'}})]})];
 for(const value of bad)assert.throws(()=>stockLedgerPage(value,product,EMPTY_LEDGER_FILTERS,1));
 for(const filters of[{...EMPTY_LEDGER_FILTERS,kind:'issue'},{...EMPTY_LEDGER_FILTERS,origin:'sales'},{...EMPTY_LEDGER_FILTERS,warehouse_id:other},{...EMPTY_LEDGER_FILTERS,from:'2026-10-20'},{...EMPTY_LEDGER_FILTERS,to:'2026-10-18'}])
  assert.throws(()=>stockLedgerPage(page(),product,filters,1));
});

test('date and time follow Origin (dd/mm/aaaa hh:mm:ss) in São Paulo; back-dated rows show when they were registered',()=>{
 assert.deepEqual(ledgerMoment(row()),{date:'19/10/2026',time:'13:04:05',recorded:'19/10/2026 13:04:05',backdated:false});
 assert.deepEqual(ledgerMoment(row({occurred_on:'2026-10-01'})),{date:'01/10/2026',time:'13:04:05',recorded:'19/10/2026 13:04:05',backdated:true});
 assert.equal(ledgerMoment(row({recorded_at_local:'invalid'})).backdated,false);
});

test('origin links reuse the document deep link; transfers and manual lançamentos have no link',()=>{
 const sale={type:'sales',document_id:doc,document_kind:'sales_orders',document_number:'12',via:'document_stock'};
 assert.equal(originHref(sale),`/documentos-empresa?tipo=sales_orders&documento=${doc}`);assert.equal(originLabel(sale),'Pedido de venda 12');
 assert.equal(originLabel({...sale,type:'purchases',document_kind:'purchase_orders',via:'purchase_receipt'}),'Pedido de compra 12');
 assert.equal(originLabel({...sale,type:'services',document_kind:'service_orders'}),'Ordem de serviço 12');
 assert.equal(originHref({...none,type:'transfers'}),null);assert.equal(originLabel({...none,type:'transfers'}),'Transferência entre depósitos');
 assert.equal(originHref(none),null);assert.equal(originLabel(none),'Sem origem');
});

test('origin links follow erp_documents.allowed for reads; filter dates stay inside the API window',()=>{
 const origin=kind=>({type:{sales_orders:'sales',purchase_orders:'purchases',service_orders:'services'}[kind],document_id:doc,document_kind:kind,document_number:'7',via:'document_stock'});
 const readers=kind=>['admin','consulta','financeiro','vendas','estoque','fiscal','desconhecido',undefined].filter(role=>originReadable(origin(kind),role));
 assert.deepEqual(readers('sales_orders'),['admin','consulta','financeiro','vendas','estoque','fiscal']);
 assert.deepEqual(readers('purchase_orders'),['admin','consulta','financeiro','estoque','fiscal']);
 assert.deepEqual(readers('service_orders'),['admin','consulta','financeiro','vendas']);
 assert.equal(originReadable(none,'admin'),false);assert.equal(originReadable({...none,type:'transfers'},'admin'),false);
 for(const [from,to]of[['1900-01-01','2100-12-31'],['1900-01-01',''],['','2100-12-31']])assert.equal(validLedgerFilters({...EMPTY_LEDGER_FILTERS,from,to}),true);
 for(const [from,to]of[['1899-12-31',''],['','2101-01-01'],['0001-01-01','2026-10-19'],['2026-10-19','9999-12-31']]){
  assert.equal(validLedgerFilters({...EMPTY_LEDGER_FILTERS,from,to}),false,`${from}..${to}`);assert.throws(()=>ledgerQuery(product,{...EMPTY_LEDGER_FILTERS,from,to},1));
 }
});

test('a negative Saldo atual total is accepted and shown with the minus sign (Permitir estoque negativo)',()=>{
 const value=stockLedgerPage(page({totals:{entries:'1.000001',exits:'4.000000',current_balance:'-2.999999',unit:'UN'}}),product,EMPTY_LEDGER_FILTERS,1);
 assert.equal(value.totals.current_balance,'-2.999999');assert.equal(quantityText(value.totals.current_balance),'−2,999999');
});

test('105 Tipo Entrada/Saída/Balanço: the direction filter, prices and the Balanço count are validated with the row',async()=>{
 const {STOCK_DIRECTION_LABELS}=await import('../src/lib/stock-model.ts');
 assert.deepEqual(Object.values(STOCK_DIRECTION_LABELS),['Entrada','Saída','Balanço']);
 assert.equal(ledgerQuery(product,{...EMPTY_LEDGER_FILTERS,direction:'balance'},1),`product_id=${product}&limit=100&offset=0&direction=balance`);
 assert.equal(validLedgerFilters({...EMPTY_LEDGER_FILTERS,direction:'adjustment'}),false);
 const counted=row({kind:'adjustment',revision:1,note:'Contagem',unit_price:'1.5000000000',unit_cost:'1.7500000000',price_source:'detail',
  items:[{product_id:product,warehouse_id:warehouse,quantity:'-2.000000',unit:'UN',balance_after:'5.000000',balance_version:3}],balance:{counted:'5.000000',previous:'7.000000',warehouse_id:warehouse,source:'launch'}});
 const value=stockLedgerPage(page({items:[counted]}),product,{...EMPTY_LEDGER_FILTERS,direction:'balance'},1);
 assert.deepEqual([value.items[0].balance.counted,value.items[0].note,value.items[0].unit_price],['5.000000','Contagem','1.5000000000']);
 for(const bad of[{balance:{...counted.balance,counted:'6.000000'}},{balance:{...counted.balance,warehouse_id:other}},{kind:'receipt'},{revision:0},{price_source:'document'},{unit_price:'1.5'},{note:null}])
  assert.throws(()=>stockLedgerPage(page({items:[{...counted,...bad}]}),product,EMPTY_LEDGER_FILTERS,1),JSON.stringify(bad));
 assert.throws(()=>stockLedgerPage(page({items:[counted]}),product,{...EMPTY_LEDGER_FILTERS,direction:'entry'},1),'a Balanço is never an Entrada');
 assert.throws(()=>stockLedgerPage(page(),product,{...EMPTY_LEDGER_FILTERS,direction:'exit'},1),'a positive line is not a Saída');
 assert.equal(stockLedgerPage(page(),product,{...EMPTY_LEDGER_FILTERS,direction:'entry'},1).items.length,1);
 const document={type:'sales',document_id:doc,document_kind:'sales_orders',document_number:'5',via:'document_stock'};
 assert.equal(stockLedgerPage(page({items:[row({kind:'issue',origin:document,unit_price:'7.2500000000',price_source:'document',items:[{product_id:product,warehouse_id:warehouse,quantity:'-1.000000',unit:'UN',balance_after:'0.000001',balance_version:2}]})]}),product,EMPTY_LEDGER_FILTERS,1).items[0].unit_price,'7.2500000000');
 assert.throws(()=>stockLedgerPage(page({items:[row({unit_price:'7.2500000000',price_source:'document'})]}),product,EMPTY_LEDGER_FILTERS,1),'a document price needs a document');
});
