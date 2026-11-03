import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneEFixture,fails}from'./helpers/preferences-e-fixture.mjs';
import{captureBusinessQuery,businessArgs,parseBusinessPanel}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{captureImportBatch,parseImportBatchResult,templateRows}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';

// Wave E of Meu Negócio and Importações de Dados: migration 265 (custo médio, Giro de Produto by composições and desmembrados, and
// the imports of composições, campos customizados and fornecedores de produtos). Synthetic data only.
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
const shift=(d,n)=>new Date(Date.parse(`${d}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
const panel=async(f,name,input,user=f.users.admin)=>{const q=captureBusinessQuery(name,input);return parseBusinessPanel(await f.rpc('erp_home_business_panel',{p_user_id:user,p_panel:name,p_args:businessArgs(q)}),q);};
const launch=async(f,product,warehouse,quantity,price)=>{const version=Number(await f.scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v',[product,warehouse]));
 return f.rpc('erp_stock_launch',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_product_id:product,p_warehouse_id:warehouse,p_quantity:quantity,p_expected_version:version,p_unit_price:price,p_unit_cost:price,p_note:'Entrada sintética'});};
const compose=async(f,product,items,{stock_type='virtual',post_mode='components'}={})=>{const version=Number(await f.scalar('select version v from erp_catalog.record where id=$1',[product]));
 const current=Number(await f.scalar('select coalesce((select version from erp_stock.composition where product_id=$1),0) v',[product]));
 return f.rpc('erp_stock_product_compose',{p_user_id:f.users.admin,p_id:product,p_expected_version:version,p_command_id:randomUUID(),p_data:{format:'E'},p_acknowledged:null,
  p_composition:{expected_version:current,stock_type,post_mode,items}});};
async function seed(f){
 const contact=await f.catalog('contacts',{name:'Cliente Sintético Margem'}),supplier=await f.catalog('contacts',{name:'Fornecedor Sintético Margem',document:'11222333000181'});
 const warehouse=await f.catalog('warehouses',{name:'Depósito sintético 265'});
 const a=await f.catalog('products',{name:'Componente A',code:'CMP-A',unit:'UN',kind:'P',format:'S',price:'10'});
 const b=await f.catalog('products',{name:'Produto com fornecedor',code:'FOR-B',unit:'UN',kind:'P',format:'S',price:'20'});
 const c=await f.catalog('products',{name:'Produto com compra',code:'COM-C',unit:'UN',kind:'P',format:'S',price:'5'});
 const k=await f.catalog('products',{name:'Kit sintético',code:'KIT-K',unit:'UN',kind:'P',format:'S',price:'30'});
 await launch(f,a.id,warehouse.id,'10','4');
 const bv=Number(await f.scalar('select version v from erp_catalog.record where id=$1',[b.id]));
 await f.rpc('erp_catalog_product_save',{p_user_id:f.users.admin,p_id:b.id,p_expected_version:bv,p_command_id:randomUUID(),p_data:{suppliers:[{supplier_id:supplier.id,cost_price:'7',is_default:true}]},p_acknowledged:null});
 await f.document('purchase_orders',{contact:supplier.id,items:[{product_id:c.id,description:'Produto com compra',quantity:'1',unit_price:'3'}]});
 await compose(f,k.id,[{component_id:a.id,quantity:'2'}]);
 const order=await f.document('sales_orders',{contact:contact.id,date:today(),statuses:['in_progress'],items:[{product_id:a.id,description:'Componente A',quantity:'2',unit_price:'10'},
  {product_id:b.id,description:'Produto com fornecedor',quantity:'1',unit_price:'20'},{product_id:c.id,description:'Produto com compra',quantity:'1',unit_price:'5'},{product_id:k.id,description:'Kit sintético',quantity:'1',unit_price:'30'}]});
 return{contact,supplier,warehouse,a,b,c,k,order};
}

test('265 replaces only the applied definitions: another version stops the migration',async()=>{
 const f=await laneEFixture({before:'202610200265'});try{
  await f.db.exec("create or replace function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$ begin return null; end $$");
  await assert.rejects(()=>f.migrate('202610200265_business_imports_wave_e.sql'),e=>e.code==='55000'&&/business_imports_265_previous_definition_changed erp_preferences.import_item/.test(e.message));
 }finally{await f.close();}
});

test('265 PRF-268 Margem por Pedido uses the custo médio, then the Preço de custo of the default supplier, then the last purchase',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const m=await panel(f,'margem-pedido',{situacoes:'in_progress',de:shift(today(),-1),ate:today(),aba:'todos'});
 const row=m.orders.find(o=>o.id===s.order.id);
 // A: 2 × custo médio 4; B: Preço de custo 7 of the supplier; C: last purchase 3; K (Virtual kit): its components never had a purchase, so no cost.
 assert.equal(row.cost,null,'the kit without any cost leaves the order without margin');
 assert.equal(m.indicators.orders_without_cost,1);
 const lines=(await f.db.query('select product_id::text p,trim_scale(unit_cost)::text c from erp_home.biz_lines($1,$2,$3) order by code',[shift(today(),-1),today(),['in_progress']])).rows;
 assert.deepEqual(Object.fromEntries(lines.map(l=>[l.p,l.c])),{[s.a.id]:'4',[s.b.id]:'7',[s.c.id]:'3',[s.k.id]:null});
 const mensal=await panel(f,'mensal',{situacoes:'in_progress',de:shift(today(),-1),ate:today()});
 assert.equal(mensal.indicators.cost,'18.00');assert.equal(mensal.indicators.lines_without_cost,1);
}finally{await f.close();}});

test('265 PRF-267 Previsão de Estoque: Variações + Simples + Composições with the Virtual stock, and Desmembrados by the components',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const items=await panel(f,'previsao-estoque',{de:shift(today(),-6),ate:today(),reserva:'nao'});
 assert.equal(items.filters.mode,'itens');
 const kit=items.turnover.find(r=>r.product_id===s.k.id),a=items.turnover.find(r=>r.product_id===s.a.id);
 assert.deepEqual([kit.composition,kit.sold,kit.stock],['virtual','1.000000','5.000000'],'10 A in stock make 5 kits');
 assert.deepEqual([a.composition,a.sold,a.stock],[null,'2.000000','10.000000']);
 const split=await panel(f,'previsao-estoque',{de:shift(today(),-6),ate:today(),reserva:'nao',modo:'desmembrados'});
 assert.equal(split.filters.mode,'desmembrados');
 assert.equal(split.turnover.some(r=>r.product_id===s.k.id),false,'the kit is counted by its components');
 assert.equal(split.turnover.find(r=>r.product_id===s.a.id).sold,'4.000000','2 sold directly + 1 kit × 2');
 // Without p_mode (the API of before 265) the panel still answers the 150 shape.
 const old=await f.rpc('erp_home_business_panel',{p_user_id:f.users.admin,p_panel:'previsao-estoque',p_args:{p_from:shift(today(),-6),p_to:today(),p_warehouse_id:null,p_reserve:false}});
 assert.equal(Object.hasOwn(old.filters,'mode'),false);assert.equal(Object.hasOwn(old.turnover[0],'composition'),false);
 await fails(assert,()=>f.rpc('erp_home_business_panel',{p_user_id:f.users.admin,p_panel:'previsao-estoque',p_args:{p_from:today(),p_to:today(),p_warehouse_id:null,p_reserve:false,p_mode:'produtos'}}),'22023');
 assert.equal(await f.scalar("select has_function_privilege('anon','public.erp_home_business_forecast_v2(uuid,date,date,uuid,boolean,text)','EXECUTE') v"),false);
}finally{await f.close();}});

const batch=async(f,kind,cells,{dry=false,job=randomUUID(),command=randomUUID(),file='planilha.csv'}={})=>{
 const parsed=templateRows(kind,cells);assert.deepEqual(parsed.items.flatMap(i=>i.problems),[],'the browser accepts the sheet');
 const body={command_id:dry?null:command,job_id:dry?null:job,file_name:file,total_rows:parsed.items.length,dry_run:dry,items:parsed.items.map(i=>({row:i.row,lines:i.lines,data:i.data}))};
 const input=captureImportBatch(kind,body);
 return parseImportBatchResult(await f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:input.command_id,p_job_id:input.job_id,p_kind:kind,p_file_name:file,p_total_rows:input.total_rows,p_dry_run:dry,
  p_rows:input.items}),input);};

test('265 PRF-027 Importar composições: the structure of each product through the Estrutura RPC, validated before importing',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const header=['Código do produto','Tipo de estoque','Lançar estoque','Código do componente','Quantidade'];
 const sheet=[header,['FOR-B','Físico','Produto e componente','CMP-A','3'],['FOR-B','','','COM-C','0,5'],['COM-C','Virtual','Produto','CMP-A','1'],['KIT-K','Virtual','','INEXISTENTE','1']];
 // Review: the Estrutura holds up to 100 componentes (erp_stock_product_compose); the sheet says so before sending.
 const big=templateRows('compositions',[header,...Array.from({length:101},(_,i)=>['KIT-K','Virtual','',`CMP-${i}`,'1'])]);
 assert.deepEqual(big.items[0].problems,['A composição tem mais de 100 componentes (o limite da aba Estrutura)']);
 assert.throws(()=>captureImportBatch('compositions',{command_id:null,job_id:null,file_name:'x.csv',total_rows:1,dry_run:true,items:[{row:2,lines:Array.from({length:101},(_,i)=>i+2),
  data:{code:'KIT-K',stock_type:'virtual',items:Array.from({length:101},(_,i)=>({code:`CMP-${i}`,quantity:'1'}))}}]}));
 const dry=await batch(f,'compositions',sheet,{dry:true});
 assert.deepEqual(dry.items.map(i=>[i.row,i.status,i.reason]),[[2,'valid',null],[4,'invalid','erp_preferences_import_invalid:post_mode'],[5,'invalid','erp_preferences_import_not_found:item_code']]);
 assert.equal(await f.scalar('select count(*)::integer v from erp_stock.composition where product_id=$1',[s.b.id]),0,'a validation writes nothing');
 const command=randomUUID(),job=randomUUID(),done=await batch(f,'compositions',sheet,{command,job});
 assert.deepEqual(done.items.map(i=>i.status),['created','invalid','invalid']);
 assert.deepEqual((await f.db.query('select c.stock_type,c.post_mode,i.quantity::text q,r.code from erp_stock.composition c join erp_stock.composition_current i on i.product_id=c.product_id join erp_catalog.record r on r.id=i.component_id where c.product_id=$1 order by i.position',[s.b.id])).rows,
  [{stock_type:'physical',post_mode:'both',q:'3.000000',code:'CMP-A'},{stock_type:'physical',post_mode:'both',q:'0.500000',code:'COM-C'}]);
 assert.equal(await f.scalar('select format v from erp_catalog.product where record_id=$1',[s.b.id]),'E');
 const again=await batch(f,'compositions',sheet,{command,job});assert.equal(again.replayed,true,'the same batch command answers its receipt');
 const update=await batch(f,'compositions',[header,['KIT-K','Virtual','Componentes','CMP-A','4']]);
 assert.deepEqual(update.items.map(i=>[i.status,i.action,i.reason]),[['updated','update',null]]);
 assert.equal(await f.scalar("select string_agg(i.quantity::text,',') v from erp_stock.composition_current i where i.product_id=$1",[s.k.id]),'4.000000');
 const line=(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:today(),p_to:today(),p_module:'produtos',p_operation:'criacao',p_actor:null,p_query:'composições',p_limit:100,p_offset:0})).items;
 assert.ok(line.some(i=>i.source==='imports'&&/Importação de planilha de composições · planilha\.csv/.test(i.description)));
}finally{await f.close();}});

test('265 PRF-027 Importar campos customizados and fornecedores de produtos through the product save',async()=>{const f=await laneEFixture();try{
 const s=await seed(f);
 const color=(await f.rpc('erp_catalog_custom_field_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{field_type:'list',name:'Cor',options:[{label:'Azul'},{label:'Verde'}]}})).field;
 const weight=(await f.rpc('erp_catalog_custom_field_save',{p_user_id:f.users.admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{field_type:'decimal',name:'Peso da embalagem'}})).field;
 const header=['Código do produto','Campo customizado','Valor'];
 const fields=await batch(f,'custom_fields',[header,['CMP-A','Cor','verde'],['CMP-A','Peso da embalagem','1,25'],['COM-C','Tamanho','P'],['FOR-B','Cor','Roxo']]);
 assert.deepEqual(fields.items.map(i=>[i.row,i.status,i.reason]),[[2,'updated',null],[4,'invalid','erp_preferences_import_not_found:item_field'],[5,'invalid','erp_preferences_import_not_found:item_value']]);
 const values=await f.scalar('select erp_catalog.product_custom_values($1) v',[s.a.id]);
 assert.equal(values[weight.id],'1.25');assert.equal(values[color.id],color.options.find(o=>o.label==='Verde').id);
 // Review: a point without a comma is the decimal separator, as in every other cell of the sheets (normalizeCell); with a comma the
 // points group the thousands.
 const points=await batch(f,'custom_fields',[header,['COM-C','Peso da embalagem','2.125'],['FOR-B','Peso da embalagem','1.234,5']]);
 assert.deepEqual(points.items.map(i=>i.status),['updated','updated']);
 assert.equal((await f.scalar('select erp_catalog.product_custom_values($1) v',[s.c.id]))[weight.id],'2.125','never 2125');
 assert.equal((await f.scalar('select erp_catalog.product_custom_values($1) v',[s.b.id]))[weight.id],'1234.5');
 const sh=['Código do produto','Fornecedor','CPF/CNPJ do fornecedor','Código no fornecedor','Preço de compra','Preço de custo','Fornecedor padrão'];
 const added=await batch(f,'product_suppliers',[sh,['CMP-A','','11.222.333/0001-81','F-77','4,50','5','Sim'],['COM-C','Fornecedor inexistente','','','1','','']]);
 assert.deepEqual(added.items.map(i=>[i.status,i.reason]),[['created',null],['invalid','erp_preferences_import_not_found:supplier_name']]);
 const list=async id=>(await f.db.query('select code,trim_scale(purchase_price)::text pp,trim_scale(cost_price)::text cp,is_default d from erp_catalog.product_supplier where record_id=$1 order by position',[id])).rows;
 assert.deepEqual(await list(s.a.id),[{code:'F-77',pp:'4.5',cp:'5',d:true}]);
 const updated=await batch(f,'product_suppliers',[sh,['CMP-A','Fornecedor Sintético Margem','','','4,80','','']]);
 assert.deepEqual(updated.items.map(i=>i.status),['updated']);assert.deepEqual(await list(s.a.id),[{code:'F-77',pp:'4.8',cp:'5',d:true}]);
 const same=await batch(f,'product_suppliers',[sh,['CMP-A','Fornecedor Sintético Margem','','F-77','','','']]);assert.deepEqual(same.items.map(i=>i.status),['unchanged']);
 assert.throws(()=>captureImportBatch('product_suppliers',{command_id:null,job_id:null,file_name:'x.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{code:'CMP-A'}}]}),'the supplier name or document is required');
 assert.throws(()=>captureImportBatch('compositions',{command_id:null,job_id:null,file_name:'x.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{code:'K',stock_type:'virtual',items:[{code:'A'}]}}]}),'a componente needs its quantity');
}finally{await f.close();}});
