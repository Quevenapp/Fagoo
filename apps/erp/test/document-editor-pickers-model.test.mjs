import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTACT_WRITER_ROLES,PRODUCT_CODE_PAGES,findProductByCode,incrementQuantity,productCodeMatches,productCodeMessage,productCodeOutcome,productStockLabels,quickContactAllowed,quickContactInitial,quickContactPayload,quickContactRecord,quickContactRole,validCnpj,validCpf} from '../src/lib/document-editor-pickers.ts';
import {EMPTY_POSITION_FILTERS,stockPositionPage} from '../src/lib/stock-positions-model.ts';

const ids=['10000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000104'];
const product=(id,extra={})=>({id,entity:'products',version:1,active:true,name:`Produto ${id.slice(-3)}`,code:null,gtin:null,unit:'UN',price:'1.0000',source:null,...extra});
const values=(extra={})=>({name:'Cliente fictício',person_type:'J',document:'',phone:'',mobile:'',email:'',roles:['customer'],...extra});

test('quick contact follows the document type and the roles allowed to write contacts',()=>{
 assert.equal(quickContactRole('sales_proposals'),'customer');assert.equal(quickContactRole('sales_orders'),'customer');assert.equal(quickContactRole('service_orders'),'customer');assert.equal(quickContactRole('purchase_orders'),'supplier');
 assert.deepEqual(CONTACT_WRITER_ROLES,['admin','vendas','financeiro']);
 assert.equal(quickContactAllowed({write:['contacts']},'vendas'),true);assert.equal(quickContactAllowed({write:['contacts']},'admin'),true);
 // The server answer and the session role must both allow it; neither alone is enough.
 assert.equal(quickContactAllowed({write:[]},'admin'),false);assert.equal(quickContactAllowed({write:['contacts']},'estoque'),false);assert.equal(quickContactAllowed(null,'admin'),false);assert.equal(quickContactAllowed({write:['contacts']},undefined),false);
});

test('quick contact starts from the search text: names fill Nome and CPF/CNPJ fill the document',()=>{
 assert.deepEqual(quickContactInitial('sales_orders','  Cliente novo  '),values({name:'Cliente novo'}));
 assert.deepEqual(quickContactInitial('purchase_orders','529.982.247-25'),values({name:'',person_type:'F',document:'529.982.247-25',roles:['supplier']}));
 assert.deepEqual(quickContactInitial('sales_orders','11222333000181'),values({name:'',document:'11222333000181'}));
 assert.equal(quickContactInitial('sales_orders','1234').name,'1234');assert.equal(quickContactInitial('sales_orders','x'.repeat(300)).name.length,200);
});

test('CPF and CNPJ check digits, including the alphanumeric CNPJ',()=>{
 for(const value of ['529.982.247-25','52998224725'])assert.equal(validCpf(value),true);
 for(const value of ['529.982.247-24','111.111.111-11','5299822472','5299822472a',''])assert.equal(validCpf(value),false);
 for(const value of ['11.222.333/0001-81','11222333000181','12.ABC.345/01DE-35','12abc34501de35'])assert.equal(validCnpj(value),true);
 for(const value of ['11.222.333/0001-82','00000000000000','12.ABC.345/01DE-36','12ABC34501DEX5','1122233300018'])assert.equal(validCnpj(value),false);
});

test('quick contact payload is the existing catalog body with the document role and no invented data',()=>{
 const {data}=quickContactPayload('sales_orders',values({name:' Cliente fictício ',person_type:'F',document:'529.982.247-25',phone:'(11) 0000-0000',email:'cliente@example.invalid',roles:['carrier','customer']}));
 assert.equal(data.name,'Cliente fictício');assert.equal(data.person_type,'F');assert.equal(data.document,'529.982.247-25');assert.equal(data.phone,'(11) 0000-0000');assert.equal(data.email,'cliente@example.invalid');
 assert.deepEqual(data.roles,['customer','carrier']);
 for(const key of ['code','trade_name','ie','mobile','postal_code','street','number','complement','district','city','state'])assert.equal(data[key],null,key);
 assert.deepEqual(quickContactPayload('purchase_orders',values({roles:['supplier'],document:'12.abc.345/01de-35'})).data,{...quickContactPayload('purchase_orders',values({roles:['supplier']})).data,document:'12.ABC.345/01DE-35'});
 assert.equal(quickContactPayload('sales_orders',values({person_type:'E',document:'P-123 456'})).data.document,'P-123 456');
 const refused=(input,kind='sales_orders')=>{try{quickContactPayload(kind,input);}catch(error){return error.field;}return null;};
 assert.equal(refused(values({name:'  '})),'name');assert.equal(refused(values({person_type:'X'})),'person_type');
 assert.equal(refused(values({person_type:'F',document:'529.982.247-24'})),'document');assert.equal(refused(values({document:'11.222.333/0001-82'})),'document');
 assert.equal(refused(values({email:'sem-arroba'})),'email');assert.equal(refused(values({phone:'9'.repeat(41)})),'phone');
 assert.equal(refused(values({roles:['supplier']})),'roles');assert.equal(refused(values({roles:['customer']}),'purchase_orders'),'roles');
 assert.equal(refused(values({roles:['customer','customer']})),'roles');assert.equal(refused(values({roles:['customer','admin']})),'roles');
});

test('quick contact responses must be the exact catalog record',()=>{
 const record={id:ids[0],entity:'contacts',version:1,active:true,name:'Cliente fictício',roles:['customer']};
 assert.equal(quickContactRecord({entity:'contacts',record}).id,ids[0]);assert.equal(quickContactRecord({entity:'contacts',record},ids[0].toUpperCase()).id,ids[0]);
 assert.equal(quickContactRecord({entity:'contacts',record:{...record,active:false}}).active,false);
 for(const bad of [null,{entity:'products',record},{entity:'contacts',record:{...record,entity:'products'}},{entity:'contacts',record:{...record,id:'x'}},{entity:'contacts',record:{...record,name:' '}},{entity:'contacts',record:{...record,version:0}},{entity:'contacts',record:{...record,roles:undefined}},{entity:'contacts',record:{...record,active:'true'}}])assert.throws(()=>quickContactRecord(bad));
 assert.throws(()=>quickContactRecord({entity:'contacts',record},ids[1]));
});

test('code entry adds exactly one to the line quantity without floats',()=>{
 assert.equal(incrementQuantity('1'),'2');assert.equal(incrementQuantity('2.5'),'3.5');assert.equal(incrementQuantity('0.000001'),'1.000001');assert.equal(incrementQuantity('100000000.000000'),'100000001');
 assert.equal(incrementQuantity('999999998.999999'),'999999999.999999');
 for(const bad of ['999999999','999999999.000001','','1,5','-1','1e3','0.0000001','01'])assert.equal(incrementQuantity(bad),null,bad);
});

test('exact code or GTIN match decides; inactive, ambiguous, missing and incomplete results never add',()=>{
 const rows=[product(ids[0],{code:'ABC-1',gtin:'7890000000017'}),product(ids[1],{code:'abc-10'}),product(ids[2],{code:'X',gtin:'SEM GTIN',active:false}),product(ids[3],{code:'7890000000017',active:false})];
 assert.deepEqual(productCodeMatches(rows,' abc-1 ').map(row=>row.id),[ids[0]]);
 assert.deepEqual(productCodeMatches(rows,'7890000000017').map(row=>row.id),[ids[0],ids[3]]);
 assert.deepEqual(productCodeMatches(rows,'SEM GTIN'),[]);assert.deepEqual(productCodeMatches(rows,''),[]);
 assert.deepEqual(productCodeOutcome(productCodeMatches(rows,'7890000000017'),true),{kind:'add',row:rows[0]});
 assert.deepEqual(productCodeOutcome([rows[3]],true),{kind:'inactive',row:rows[3]});
 assert.deepEqual(productCodeOutcome([rows[0],rows[1]],true),{kind:'ambiguous',count:2});assert.deepEqual(productCodeOutcome([rows[0],rows[1]],false),{kind:'ambiguous',count:2});
 assert.deepEqual(productCodeOutcome([],true),{kind:'missing'});assert.deepEqual(productCodeOutcome([rows[0]],false),{kind:'too_many'});
 assert.match(productCodeMessage('X',{kind:'inactive',row:rows[2]}),/está inativo e não pode ser incluído/);
 assert.match(productCodeMessage('ABC',{kind:'ambiguous',count:2}),/Mais de um produto ativo usa o código ou GTIN ABC/);
 assert.match(productCodeMessage('ABC',{kind:'missing'}),/Nenhum produto encontrado com o código ou GTIN ABC/);
 assert.match(productCodeMessage('ABC',{kind:'too_many'}),/Muitos produtos contêm ABC/);
});

test('code lookup reads the existing product search (active and inactive) until the result is complete',async()=>{
 const calls=[],signal=new AbortController().signal;
 const pages=[{entity:'products',items:[product(ids[0],{code:'99'})],has_more:true,next_cursor:ids[0],limit:100,data_mode:'erp_native'},{entity:'products',items:[product(ids[1],{code:'990'}),product(ids[2],{gtin:'99'})],has_more:false,next_cursor:null,limit:100,data_mode:'erp_native'}];
 let outcome=await findProductByCode(async(path,options)=>{calls.push(path);assert.equal(options.signal,signal);return pages[calls.length-1];},' 99 ',signal);
 assert.deepEqual(calls,['/v1/cadastros/products?limit=100&q=99',`/v1/cadastros/products?limit=100&q=99&after=${ids[0]}`]);
 assert.deepEqual(outcome,{kind:'ambiguous',count:2});
 calls.length=0;outcome=await findProductByCode(async path=>{calls.push(path);return pages[1];},'990',signal);assert.equal(outcome.kind,'add');assert.equal(outcome.row.id,ids[1]);assert.equal(calls.length,1);
 // A search that never completes is reported, never guessed.
 calls.length=0;outcome=await findProductByCode(async path=>{calls.push(path);return{entity:'products',items:[product(ids[calls.length%4],{code:calls.length===1?'7':'77'})],has_more:true,next_cursor:ids[3],limit:100,data_mode:'erp_native'};},'7',signal);
 assert.deepEqual(outcome,{kind:'too_many'});assert.equal(calls.length,PRODUCT_CODE_PAGES);
 calls.length=0;for(const code of ['',' ','x'.repeat(121),'a\u0000b'])assert.deepEqual(await findProductByCode(async path=>{calls.push(path);},code,signal),{kind:'invalid'});assert.equal(calls.length,0);
 for(const bad of [{entity:'contacts',items:[],has_more:false,next_cursor:null},{entity:'products',items:[],has_more:true,next_cursor:null},{entity:'products',items:[{...product(ids[0]),active:'yes'}],has_more:false,next_cursor:null},{entity:'products',items:[{...product(ids[0]),id:'bad'}],has_more:false,next_cursor:null},{entity:'products',items:new Array(101).fill(product(ids[0])),has_more:false,next_cursor:null}])
  await assert.rejects(findProductByCode(async()=>bad,'1',signal),/PRODUCT_CODE_RESPONSE_INVALID/);
});

test('picker stock labels keep “sem lançamentos” distinct from zero and name the scope',()=>{
 const warehouse='20000000-0000-4000-8000-000000000201';
 const row=(id,global,selected)=>({product:{id,version:1,name:'Produto',code:null,active:true,unit:'UN',kind:'P',format:'S',gtin:null,brand:null,location:null,stock_min:null,stock_max:null},global,selected_position:selected,limit_state:global.state==='recorded'?'not_configured':global.state});
 const recorded=(quantity)=>({state:'recorded',quantity,recorded_warehouse_count:'1',scope:'all_recorded_warehouses'});
 const raw={scope:'stock_positions',data_mode:'erp_native',warehouse:{id:warehouse,name:'Depósito fictício',active:true},limit:25,has_more:false,next_cursor:null,items:[
  row(ids[0],recorded('1234.500000'),{warehouse_id:warehouse,state:'recorded',quantity:'1234.500000',version:3}),
  row(ids[1],recorded('0.000000'),{warehouse_id:warehouse,state:'recorded',quantity:'0.000000',version:2}),
  row(ids[2],recorded('5.000000'),{warehouse_id:warehouse,state:'no_movements',quantity:null,version:0}),
  row(ids[3],{state:'review_required',quantity:null,recorded_warehouse_count:'1',scope:'all_recorded_warehouses'},{warehouse_id:warehouse,state:'review_required',quantity:null,version:1})]};
 const labels=productStockLabels(stockPositionPage(raw,{...EMPTY_POSITION_FILTERS,warehouse_id:warehouse}));
 assert.deepEqual([...labels],[[ids[0],'Estoque: 1.234,5 UN'],[ids[1],'Estoque: 0 UN'],[ids[2],'Estoque: sem lançamentos'],[ids[3],'Estoque: em conferência']]);
 const global={...raw,warehouse:null,items:[row(ids[0],recorded('7.000000'),null),row(ids[1],{state:'no_movements',quantity:null,recorded_warehouse_count:'0',scope:'all_recorded_warehouses'},null)]};
 assert.deepEqual([...productStockLabels(stockPositionPage(global,EMPTY_POSITION_FILTERS))],[[ids[0],'Estoque total: 7 UN'],[ids[1],'Estoque total: sem lançamentos']]);
});
