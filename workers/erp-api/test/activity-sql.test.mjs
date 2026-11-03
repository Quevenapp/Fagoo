import test from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{preferencesFixture,fails}from'./helpers/preferences-fixture.mjs';
import{parseActivity,captureActivityQuery}from'../../../packages/erp-domain/src/activity.mjs';
// The 118 contract of erp_files_list (the API calls erp_files_list_v2 since 263; this one stays for the API of before 263).
const files118=raw=>{assert.deepEqual(Object.keys(raw).sort(),['data_mode','from','has_more','items','limit','offset','order','query','scope','to','total','total_bytes']);
 for(const i of raw.items)assert.deepEqual(Object.keys(i).sort(),['created_at','document','filename','id','mime_type','owner','sha256','size_bytes']);return raw;};
const activity=(f,{user=f.users.admin,from='2020-01-01',to='2020-12-31',module=null,operation=null,actor=null,q=null,limit=100,offset=0}={})=>f.rpc('erp_activity_list',{p_user_id:user,p_from:from,p_to:to,p_module:module,p_operation:operation,p_actor:actor,p_query:q,p_limit:limit,p_offset:offset});
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
const year=()=>{const t=today();return{from:`${t.slice(0,4)}-01-01`,to:`${t.slice(0,4)}-12-31`};};

async function seed(f){
 const catalog=(entity,data)=>f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data});
 const contact=(await catalog('contacts',{name:'Cliente sintético 118'})).record;
 const product=(await catalog('products',{name:'Produto sintético 118',unit:'UN',kind:'P',format:'S',price:'1',code:'SINT-118'})).record;
 const warehouse=(await catalog('warehouses',{name:'Depósito sintético 118'})).record;
 const order=(await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:today(),contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Linha sintética',unit:'UN',quantity:'1',unit_price:'1'}]}})).document;
 await f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:today(),p_reason:'Entrada sintética 118',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity:'2',expected_version:0}],p_reference:'REF-118'});
 await f.save('empresa-geral',[{key:'empresa.decimais_peso',expected_version:0,value:2}]);
 const vendas=await f.rpc('erp_access_user_get',{p_user_id:f.users.admin,p_target:f.users.vendas});
 await f.rpc('erp_access_user_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_target:f.users.vendas,p_expected:{role:'vendas',active:true,profile_version:vendas.user.profile_version},p_data:{name:'Vendas Sintético',phone:null,role:'vendas',active:false}});
 return{contact,product,warehouse,order};
}

test('118 the activity log joins every audited module with Origin modules and operations, newest first',async()=>{const f=await preferencesFixture();try{
 const{order}=await seed(f),range=year(),q=captureActivityQuery(range),page=parseActivity(await activity(f,range),q);
 const pairs=page.items.map(e=>`${e.module}:${e.operation}`);
 for(const expected of['clientes_fornecedores:criacao','produtos:criacao','depositos:criacao','pedidos_venda:criacao','estoque:lancamento','preferencias:atualizacao','usuarios:exclusao'])assert.ok(pairs.includes(expected),expected);
 const sale=page.items.find(e=>e.module==='pedidos_venda');assert.equal(sale.code,String(order.number));assert.match(sale.description,/Pedido de venda nº/);
 assert.equal(page.items.find(e=>e.module==='estoque').code,'REF-118');assert.equal(page.items.find(e=>e.module==='usuarios').description,'Usuário Vendas Sintético');
 assert.equal(page.items.find(e=>e.module==='estoque').actor.user_id,f.users.estoque);
 const deletions=parseActivity(await activity(f,{...range,operation:'exclusao'}),captureActivityQuery({...range,operation:'exclusao'}));assert.deepEqual(deletions.items.map(e=>e.module),['usuarios']);
 const products=parseActivity(await activity(f,{...range,module:'produtos'}),captureActivityQuery({...range,module:'produtos'}));assert.equal(products.items.length,1);assert.equal(products.items[0].code,'SINT-118');
 const mine=parseActivity(await activity(f,{...range,actor:f.users.estoque}),captureActivityQuery({...range,actor:f.users.estoque}));assert.deepEqual(mine.items.map(e=>e.module),['estoque']);
 const found=parseActivity(await activity(f,{...range,q:'  SINT-118 '}),captureActivityQuery({...range,q:'  SINT-118 '}));assert.equal(found.items.length,1);
 const paged=await activity(f,{...range,limit:2,offset:2});assert.equal(paged.items.length,2);assert.equal(paged.has_more,true);
 assert.equal((await activity(f,{from:'2020-01-01',to:'2020-01-31'})).total,0);
}finally{await f.close();}});

test('118 only an administrador reads the log; periods and filters are bounded',async()=>{const f=await preferencesFixture();try{
 for(const role of['consulta','vendas','financeiro','estoque','fiscal','inactive'])await fails(assert,()=>activity(f,{user:f.users[role]}),'42501');
 for(const bad of[{from:'2026-01-01',to:'2027-01-02'},{from:'2026-02-01',to:'2026-01-01'},{from:'2019-12-31',to:'2020-01-01'},{module:'marketplace'},{operation:'apagar'},{limit:0},{limit:101},{q:'a\u0001'}])
  await fails(assert,()=>activity(f,bad),'22023');
 await fails(assert,()=>f.rpc('erp_files_list',{p_user_id:f.users.consulta,p_query:null,p_from:null,p_to:null,p_order:'data',p_limit:10,p_offset:0}),'42501');
 for(const fn of['erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer)','erp_files_list(uuid,text,date,date,text,integer,integer)']){
  assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${fn}','execute') v`),true);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${fn}','execute') v`),false);}
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_activity.entries(timestamptz,timestamptz)','execute') v"),false);
}finally{await f.close();}});

test('118 the file manager lists ready attachments with owner, document and total size, ordered as asked',async()=>{const f=await preferencesFixture();try{
 const{order}=await seed(f);
 const add=async(name,size,status='ready')=>f.db.query("insert into erp_attachments.attachment(document_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256,status,finished_by,finished_at)values($1,$2,$3,$4,$5,'application/pdf',$6,$7,$8,$3,clock_timestamp())",
  [order.id,randomUUID(),f.users.admin,createHash('sha256').update(name).digest('hex'),name,size,createHash('sha256').update(name+'x').digest('hex'),status]);
 await add('contrato.pdf',2048);await add('anexo-grande.pdf',9000);await add('descartado.pdf',100,'aborted');
 const byName=files118(await f.rpc('erp_files_list',{p_user_id:f.users.admin,p_query:null,p_from:null,p_to:null,p_order:'nome',p_limit:10,p_offset:0}));
 assert.deepEqual(byName.items.map(i=>i.filename),['anexo-grande.pdf','contrato.pdf']);assert.equal(byName.total_bytes,'11048');assert.equal(byName.items[0].document.number,String(order.number));
 const bySize=files118(await f.rpc('erp_files_list',{p_user_id:f.users.admin,p_query:'contrato',p_from:null,p_to:null,p_order:'tamanho',p_limit:10,p_offset:0}));
 assert.deepEqual(bySize.items.map(i=>i.filename),['contrato.pdf']);
 const t=today();assert.equal((await f.rpc('erp_files_list',{p_user_id:f.users.admin,p_query:null,p_from:t,p_to:t,p_order:'data',p_limit:10,p_offset:0})).total,2);
 await fails(assert,()=>f.rpc('erp_files_list',{p_user_id:f.users.admin,p_query:null,p_from:t,p_to:null,p_order:'data',p_limit:10,p_offset:0}),'22023');
 const range=year();const abort=parseActivity(await activity(f,{...range,module:'anexos'}),captureActivityQuery({...range,module:'anexos'}));assert.equal(abort.total,0);
}finally{await f.close();}});

test('118 an audit text with line breaks or long accented text never breaks the whole log',async()=>{const f=await preferencesFixture();try{
 const{order}=await seed(f),range=year();
 // Other modules may keep multi-line reasons; the log shows one bounded line instead of failing the page.
 await f.db.query("insert into erp_documents.audit(actor,command_id,document_id,action,reason)values($1,$2,$3,'transition',$4)",[f.users.admin,randomUUID(),order.id,'Motivo em\nduas linhas\tcom tabulação '+'ç😀'.repeat(120)]);
 const q=captureActivityQuery({...range,module:'pedidos_venda'}),page=parseActivity(await activity(f,{...range,module:'pedidos_venda'}),q);
 const entry=page.items.find(e=>e.description.includes('Motivo em'));assert.ok(entry);assert.doesNotMatch(entry.description,/[\n\t]/);
 assert.equal(entry.operation,'atualizacao_situacao');assert.ok([...entry.description].length<=200);
}finally{await f.close();}});
