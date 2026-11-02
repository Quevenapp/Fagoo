import { handleBusinessRequest } from './business/router.mjs';
import { handleFiscalRequest } from './fiscal/router.mjs';
import { can } from './auth.mjs';
const text={type:'string'},id={type:'string',format:'uuid'},decimal={type:'string',pattern:'^-?[0-9]+(\\.[0-9]+)?$'},version={type:'integer',minimum:0};
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const page={limit:{type:'integer',minimum:1,maximum:1000},cursor:text};
const query=(base,args)=>{const url=new URL(base,'http://internal');for(const[k,v]of Object.entries(args))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));return url.pathname+url.search;};
const read=(name,description,scope,path,properties,required=[])=>({name,description,scope,inputSchema:object(properties,required),method:'GET',path:a=>query(path,a)});
const write=(name,description,scope,path,properties,required,method='POST')=>({name,description,scope,inputSchema:object(properties,required),method,path:typeof path==='function'?path:()=>path});
const productFields={command_id:id,code:text,name:text,unit:text,gtin:text,ncm:text,sale_price:decimal,cost_price:decimal,stock_min:decimal,stock_max:decimal,lead_days:{type:'integer',minimum:0},pack_quantity:decimal};
const command={command_id:id,expected_version:version};
export const MCP_TOOLS=[
 read('fagoo_products','Consultar produtos e parâmetros de estoque com paginação.','catalog:read','/api/v1/products',{q:text,...page}),
 {name:'fagoo_product',description:'Consultar produto, códigos e condições dos fornecedores.',scope:'catalog:read',inputSchema:object({resource_id:id},['resource_id']),method:'GET',path:a=>`/api/v1/products/${a.resource_id}`},
 read('fagoo_contacts','Consultar clientes e fornecedores.','catalog:read','/api/v1/contacts',{q:text,kind:{enum:['customer','supplier','both']},...page}),
 read('fagoo_warehouses','Consultar depósitos disponíveis.','stock:read','/api/v1/warehouses',{}),
 read('fagoo_stock','Consultar saldos, reservas e quantidades disponíveis.','stock:read','/api/v1/stock',{warehouse_id:id,product_id:id,...page}),
 read('fagoo_stock_movements','Entradas e saídas de estoque, com datas e paginação para análise externa.','stock:read','/api/v1/stock/movements',{warehouse_id:id,product_id:id,from:text,to:text,...page}),
 read('fagoo_orders','Consultar pedidos e seus estados.','orders:read','/api/v1/orders',{kind:{enum:['sale','purchase']},...page}),
 {name:'fagoo_order',description:'Consultar pedido com itens e versões necessárias para comandos.',scope:'orders:read',inputSchema:object({resource_id:id},['resource_id']),method:'GET',path:a=>`/api/v1/orders/${a.resource_id}`},
 read('fagoo_sales_series','Histórico agregado para análises externas. Percorra next_cursor até has_more=false.','analytics:read','/api/v1/analytics/sales-series',{from:text,to:text,group:{enum:['product_day','customer_product_month']},...page},['from','to']),
 read('fagoo_replenishment_context','Dados completos para reposição. Custos podem excluir frete e tributos ainda não configurados.',['analytics:read','stock:read'],'/api/v1/analytics/replenishment-context',{from:text,to:text,...page},['from','to']),
 read('fagoo_customer_context','Compra anterior e condição comercial atual para um cliente/produto.',['orders:read','catalog:read'],'/api/v1/commerce/customer-context',{contact_id:id,product_id:id,quantity:decimal,payment_terms:text},['contact_id','product_id']),
 read('fagoo_events','Consultar eventos persistidos após um cursor.','events:read','/api/v1/events',{after:text,limit:{type:'integer',minimum:1,maximum:1000}}),
 read('fagoo_received_invoices','Consultar documentos recebidos; não atesta validade fiscal ou assinatura.','fiscal:read','/api/v1/invoices/received',page),
 {name:'fagoo_received_invoice',description:'Itens, pendências fiscais e candidatos do catálogo para conciliação de documento recebido.',scope:'fiscal:read',inputSchema:object({resource_id:id},['resource_id']),method:'GET',path:a=>`/api/v1/invoices/received/${a.resource_id}`},
 read('fagoo_payables','Consultar obrigações a pagar; não executa pagamentos.','finance:read','/api/v1/payables',page),
 read('fagoo_receivables','Consultar valores a receber.','finance:read','/api/v1/receivables',page),
 write('fagoo_ack_events','Confirmar processamento de eventos por esta integração.','events:write','/api/v1/events/ack',{command_id:id,sequence:{type:'string',pattern:'^[0-9]{1,18}$'}},['command_id','sequence']),
 write('fagoo_create_product','Cadastrar produto. Repetir o mesmo command_id preserva o resultado.','catalog:write','/api/v1/products',productFields,['command_id','code','name']),
 write('fagoo_update_product','Atualizar produto ou mínimo/máximo com controle de versão.','catalog:write',a=>`/api/v1/products/${a.resource_id}`,{resource_id:id,expected_version:version,...productFields},['resource_id','command_id','expected_version'],'PATCH'),
 write('fagoo_create_contact','Cadastrar cliente ou fornecedor.','catalog:write','/api/v1/contacts',{command_id:id,name:text,kind:{enum:['customer','supplier','both']},document:text,payment_terms:text},['command_id','name','kind']),
 write('fagoo_link_supplier_product','Vincular código/descrição do fornecedor e conversão de unidades após conciliação.','catalog:write',a=>`/api/v1/products/${a.resource_id}/suppliers`,{resource_id:id,...command,supplier_id:id,code:text,description:text,unit_factor:decimal,price:decimal,lead_days:{type:'integer',minimum:0}},['resource_id','command_id','expected_version','supplier_id']),
 write('fagoo_create_order','Criar pedido com preços verificados; overrides exigem permissão própria.','orders:write','/api/v1/orders',{command_id:id,kind:{enum:['sale','purchase']},contact_id:id,warehouse_id:id,payment_terms:text,expected_on:text,items:{type:'array',minItems:1,items:object({product_id:id,quantity:decimal,unit_price:decimal,unit_factor:decimal},['product_id','quantity'])}},['command_id','kind','contact_id','warehouse_id','items']),
 write('fagoo_confirm_order','Confirmar pedido; vendas reservam estoque.','orders:write',a=>`/api/v1/orders/${a.resource_id}/confirm`,{resource_id:id,...command},['resource_id','command_id','expected_version']),
 write('fagoo_receive_order','Lançar recebimento após confirmação física do estoquista.','stock:write',a=>`/api/v1/orders/${a.resource_id}/receipts`,{resource_id:id,...command,confirmed:{const:true},items:{type:'array',minItems:1,items:object({item_id:id,quantity:decimal},['item_id','quantity'])}},['resource_id','command_id','expected_version','confirmed','items']),
 write('fagoo_fulfill_order','Efetivar entrega confirmada de uma venda.',['stock:write','orders:write'],a=>`/api/v1/orders/${a.resource_id}/fulfill`,{resource_id:id,...command,confirmed:{const:true}},['resource_id','command_id','expected_version','confirmed']),
 write('fagoo_post_finance','Lançar parcelas uma única vez; não executa pagamento bancário.','finance:write',a=>`/api/v1/orders/${a.resource_id}/finance`,{resource_id:id,...command,installments:{type:'array',minItems:1,items:object({due_on:text,amount:decimal},['due_on','amount'])}},['resource_id','command_id','expected_version','installments']),
];
function validate(value,schema){
 if(schema.const!==undefined)return value===schema.const;
 if(schema.enum&&!schema.enum.includes(value))return false;
 if(schema.type==='string')return typeof value==='string'&&value.length<=10000&&(!schema.pattern||new RegExp(schema.pattern).test(value))&&(schema.format!=='uuid'||/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
 if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=(schema.minimum??-Infinity)&&value<=(schema.maximum??Infinity);
 if(schema.type==='array')return Array.isArray(value)&&value.length>=(schema.minItems??0)&&value.length<=250&&value.every(v=>validate(v,schema.items));
 if(schema.type==='object'){if(!value||typeof value!=='object'||Array.isArray(value)||(schema.required||[]).some(k=>!Object.hasOwn(value,k)))return false;return Object.entries(value).every(([k,v])=>schema.properties[k]&&validate(v,schema.properties[k]));}
 return true;
}
const available=(actor,tool)=>(Array.isArray(tool.scope)?tool.scope:[tool.scope]).every(scope=>can(actor,scope));
export async function handleMcp(request,context){
 if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
 if(!request.headers.get('content-type')?.includes('application/json'))return new Response(null,{status:415});
 let input;try{input=await request.json();}catch{return Response.json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},{status:400});}
 if(!input||input.jsonrpc!=='2.0'||typeof input.method!=='string')return Response.json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}},{status:400});
 if(input.method.startsWith('notifications/'))return new Response(null,{status:202});
 const reply=result=>Response.json({jsonrpc:'2.0',id:input.id??null,result},{headers:{'Cache-Control':'no-store'}});
 const error=(code,message)=>Response.json({jsonrpc:'2.0',id:input.id??null,error:{code,message}});
 if(input.method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'FAGOO',version:'0.1.0-alpha.1'},instructions:'Use paginação e metadados de cobertura. Preserve command_id ao repetir operações. A confirmação física deve vir do responsável pelo recebimento.'});
 if(input.method==='ping')return reply({});
 if(input.method==='tools/list')return reply({tools:MCP_TOOLS.filter(t=>available(context.actor,t)).map(({name,description,inputSchema})=>({name,description,inputSchema}))});
 if(input.method==='tools/call'){
  const tool=MCP_TOOLS.find(t=>t.name===input.params?.name&&available(context.actor,t));if(!tool)return error(-32602,'Unknown or unavailable tool');
  const args=input.params.arguments||{};if(!validate(args,tool.inputSchema))return error(-32602,'Invalid arguments');
  const payload={...args};delete payload.resource_id;
  const operation=new Request('http://internal'+tool.path(args),{method:tool.method,...(tool.method!=='GET'?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});
  const result=await handleFiscalRequest(operation,context)||await handleBusinessRequest(operation,context);
  const data=result?await result.json():{error:'NOT_IMPLEMENTED'};
  return reply({isError:!result||!result.ok,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
 }
 return error(-32601,'Method not found');
}
