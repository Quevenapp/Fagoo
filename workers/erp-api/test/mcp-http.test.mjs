import test from'node:test';import assert from'node:assert/strict';
import{createHandler}from'../src/index.mjs';
import{MCP_PROTOCOL_VERSIONS,MCP_RESULT_CHARS,MCP_BODY_BYTES,mcpTools,mcpToolRequest,handleMcp}from'../src/mcp.mjs';
import{catalogRoute,catalogOperation}from'../src/catalog.mjs';
import{documentsRoute,documentsOperation}from'../src/documents.mjs';
import{parseFinanceRoute}from'../src/finance.mjs';
import{parseStockPositionsRoute}from'../src/stock-positions.mjs';
import{parseDueReportRoute}from'../src/due-report.mjs';
import{homeOperation}from'../src/home.mjs';

// MCP for agents (src/mcp.mjs): POST /mcp over the agent token of 202611130001. Synthetic data only.
const AGENT='10000000-0000-4000-8000-000011130002',TOKEN_ID='20000000-0000-4000-8000-000011130002',BASE='https://project.supabase.co';
const ID='30000000-0000-4000-8000-000011130002',WAREHOUSE='40000000-0000-4000-8000-000011130002';
const TOKEN='fagoo_agt_'+'Z9y8X7w6_-'.repeat(4)+'abc';
const off={SUPABASE_URL:BASE,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.synthetic.test'},env={...off,ERP_AGENT_ACCESS_ENABLED:'true'};
const resolved={scope:'agent_access',status:'ok',user_id:AGENT,token_id:TOKEN_ID};
const gate=(over={})=>({scope:'access_gate',data_mode:'erp_native',user_id:AGENT,open:true,until:null,mfa_required:false,mfa_ok:true,...over});
const me={user_id:AGENT,role:'consulta',resources:['contacts','products'],data_mode:'staging_readonly',access_window:'open',gate_required:false};
const product={id:ID,version:1,name:'Parafuso sintético',code:'P-1',active:true,unit:'UN',kind:'P',format:'S',gtin:null,brand:null,location:null,stock_min:null,stock_max:null};
const positions={data_mode:'erp_native',scope:'stock_positions',limit:20,has_more:false,next_cursor:null,warehouse:null,
 items:[{product,global:{state:'recorded',scope:'all_recorded_warehouses',recorded_warehouse_count:'1',quantity:'5.000000'},selected_position:null,limit_state:'not_configured'}]};
/** A database for the calls of an agent; `calls` keeps what the Worker sent. `answers` replaces an RPC answer by name. */
const backend=(answers={})=>{const calls=[];
 return{calls,handler:createHandler({fetchImpl:async(url,o)=>{const name=url.split('/').at(-1);calls.push({path:url.replace(BASE,''),name,o});
  const answer=answers[name]??{erp_access_agent_resolve:resolved,erp_access_gate_v2:gate(),erp_access_me:me,erp_stock_positions:positions}[name];
  return answer instanceof Response?answer:Response.json(answer??null);}})};};
const rpc=(method,params,id=1)=>({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});
const post=(h,message,{token=TOKEN,environment=env,headers={},method='POST',raw}={})=>h(new Request('https://api.synthetic.test/mcp',{method,
 headers:{...(token?{Authorization:`Bearer ${token}`}:{}),'Content-Type':'application/json',...headers},...(method==='POST'?{body:raw??JSON.stringify(message)}:{})}),environment);
const tool=(h,name,args,options)=>post(h,rpc('tools/call',{name,arguments:args}),options);
const names=b=>b.calls.map(c=>c.name);
const refused=async response=>{const body=await response.json();assert.equal(body.result.isError,true,JSON.stringify(body));return JSON.parse(body.result.content[0].text).error;};

test('/mcp does not exist while agent access is off and is closed to browsers, other methods and session tokens',async()=>{
 const b=backend();
 for(const environment of[off,{...off,ERP_AGENT_ACCESS_ENABLED:'false'}]){const r=await post(b.handler,rpc('initialize'),{environment});assert.equal(r.status,404);assert.equal((await r.json()).error.code,'ERP_NOT_FOUND');}
 const browser=await post(b.handler,rpc('initialize'),{headers:{Origin:'https://erp.synthetic.test'}});
 assert.equal(browser.status,403);assert.equal((await browser.json()).error.code,'ERP_ORIGIN_NOT_ALLOWED');assert.equal(browser.headers.get('Access-Control-Allow-Origin'),null);
 for(const method of['GET','DELETE','OPTIONS']){const r=await post(b.handler,null,{method});assert.equal(r.status,405,method);assert.equal(r.headers.get('Allow'),'POST');}
 for(const token of[null,'synthetic.session.token','fagoo_agt_short']){const r=await post(b.handler,rpc('initialize'),{token});
  assert.equal(r.status,401,String(token));assert.equal(r.headers.get('WWW-Authenticate'),'Bearer');assert.equal((await r.json()).error.code,'ERP_UNAUTHENTICATED');}
 // None of the refusals above reached the database or Auth.
 assert.equal(b.calls.length,0);
});

test('every message is authenticated: a revoked token, an agent out of its limits and a closed access window stop at the door',async()=>{
 for(const[answers,status,code]of[[{erp_access_agent_resolve:{scope:'agent_access',status:'unknown'}},401,'ERP_UNAUTHENTICATED'],
  [{erp_access_agent_resolve:{scope:'agent_access',status:'denied'}},403,'ERP_AGENT_ACCESS_DENIED'],[{erp_access_gate_v2:gate({open:false})},403,'ERP_ACCESS_OUTSIDE_SCHEDULE']]){
  for(const message of[rpc('initialize'),rpc('tools/list'),rpc('tools/call',{name:'consultar_acesso'}),{jsonrpc:'2.0',method:'notifications/initialized'}]){
   const b=backend(answers),r=await post(b.handler,message);assert.equal(r.status,status,code);assert.equal((await r.json()).error.code,code);
   assert.equal(r.headers.get('WWW-Authenticate'),status===401?'Bearer':null);assert.equal(names(b).includes('erp_access_me'),false);}}
});

test('initialize negotiates the version and announces tools only; notifications and ping need no data',async()=>{
 const b=backend();
 for(const[asked,answered]of[['2025-11-25','2025-11-25'],['2025-06-18','2025-06-18'],['2025-03-26','2025-03-26'],['2024-11-05','2024-11-05'],['2099-01-01',MCP_PROTOCOL_VERSIONS[0]],[undefined,MCP_PROTOCOL_VERSIONS[0]]]){
  const r=await post(b.handler,rpc('initialize',{protocolVersion:asked,capabilities:{},clientInfo:{name:'synthetic',version:'1'}},'init-1'));
  assert.equal(r.status,200);assert.match(r.headers.get('Content-Type'),/^application\/json/);assert.equal(r.headers.get('Mcp-Session-Id'),null);
  const body=await r.json();assert.deepEqual([body.jsonrpc,body.id,body.result.protocolVersion],['2.0','init-1',answered]);
  assert.deepEqual(body.result.capabilities,{tools:{listChanged:false}});assert.equal(body.result.serverInfo.name,'fagoo-erp');assert.equal(typeof body.result.instructions,'string');}
 const notified=await post(b.handler,{jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(notified.status,202);assert.equal(await notified.text(),'');
 const answered=await post(b.handler,{jsonrpc:'2.0',id:9,result:{}});assert.equal(answered.status,202);
 assert.deepEqual(await(await post(b.handler,rpc('ping',undefined,7))).json(),{jsonrpc:'2.0',id:7,result:{}});
 const unknown=await post(b.handler,rpc('resources/list'));assert.equal(unknown.status,200);assert.equal((await unknown.json()).error.code,-32601);
 // Only the token resolution and the gate (kept for the minute) were asked of the database.
 assert.deepEqual([...new Set(names(b))].sort(),['erp_access_agent_resolve','erp_access_gate_v2']);
});

test('malformed messages are refused as JSON-RPC errors without touching a route',async()=>{
 const b=backend();
 for(const[options,code]of[[{raw:'{'},-32700],[{raw:'x'.repeat(MCP_BODY_BYTES+1)},-32700],[{headers:{'Content-Type':'text/plain'}},-32700],[{raw:JSON.stringify([rpc('ping')])},-32600],
  [{raw:JSON.stringify({id:1,method:'ping'})},-32600],[{raw:JSON.stringify({jsonrpc:'2.0',id:null,method:'ping'})},-32600],[{raw:JSON.stringify({jsonrpc:'2.0',id:1.5,method:'ping'})},-32600],
  [{raw:JSON.stringify({jsonrpc:'2.0',id:1})},-32600],[{headers:{'MCP-Protocol-Version':'1999-01-01'}},-32600]]){
  const r=await post(b.handler,rpc('ping'),options);assert.equal(r.status,400,JSON.stringify(options).slice(0,80));assert.equal((await r.json()).error.code,code);}
 assert.equal((await post(b.handler,rpc('ping'),{headers:{'MCP-Protocol-Version':'2025-06-18'}})).status,200);
 for(const params of[undefined,{},{name:7},{name:'apagar_tudo'},{name:'criar_pedido',arguments:{}}]){const body=await(await post(b.handler,rpc('tools/call',params))).json();assert.equal(body.error.code,-32602,JSON.stringify(params));}
 assert.deepEqual([...new Set(names(b))].sort(),['erp_access_agent_resolve','erp_access_gate_v2']);
});

const READS=['consultar_acesso','listar_cadastros','consultar_cadastro','listar_documentos','consultar_documento','listar_posicoes_estoque','listar_titulos','consultar_titulo','consultar_vencimentos','consultar_painel'];
const WRITES=['criar_contato','atualizar_contato','criar_produto','atualizar_produto','criar_proposta','criar_pedido_venda','registrar_ocorrencia'];
test('tools/list announces the reads as reads and the writes as writes, each with a closed schema',async()=>{
 const b=backend(),{result}=await(await post(b.handler,rpc('tools/list'))).json();
 assert.deepEqual(result.tools,mcpTools());
 assert.deepEqual(result.tools.map(t=>t.name),[...READS,...WRITES]);
 /** Every object of a schema is closed and names what it requires; every leaf says what it is. */
 const closed=(schema,at)=>{assert.ok(schema.type&&schema.description!==''&&(at===''||schema.description),at);
  if(schema.type==='object'){assert.equal(schema.additionalProperties,false,at);for(const key of schema.required)assert.ok(Object.hasOwn(schema.properties,key),`${at}.${key}`);
   for(const[key,property]of Object.entries(schema.properties))closed(property,`${at}.${key}`);}
  if(schema.type==='array'&&schema.items.type==='object')closed({...schema.items,description:'item'},`${at}[]`);};
 for(const t of result.tools){const write=WRITES.includes(t.name);
  assert.match(t.name,write?/^(criar|atualizar|registrar)_[a-z_]+$/:/^(consultar|listar)_[a-z_]+$/);assert.ok(t.description.length>20&&t.title);
  assert.deepEqual(t.annotations,{title:t.title,readOnlyHint:!write,destructiveHint:t.name.startsWith('atualizar_'),idempotentHint:!write,openWorldHint:false});
  // A write says so in its description and takes a command id.
  assert.equal(/Grava no ERP/.test(t.description),write,t.name);assert.equal(Object.hasOwn(t.inputSchema.properties,'comando_id'),write,t.name);
  closed(t.inputSchema,'');}
});

test('each tool becomes one GET the API routes accept, on a read RPC',async()=>{
 const get=path=>new Request('https://api.synthetic.test'+path),url=path=>new URL('https://api.synthetic.test'+path);
 const catalog=async path=>catalogOperation(get(path),catalogRoute(url(path).pathname),url(path).searchParams);
 const documents=async path=>documentsOperation(get(path),documentsRoute(url(path).pathname),url(path).searchParams);
 const cases=[
  ['consultar_acesso',{},'/v1/me',null],
  ['listar_cadastros',{tipo:'contatos',busca:'Cliente & Cia',ativo:true},'/v1/cadastros/contacts?limit=20&q=Cliente+%26+Cia&active=true',async p=>{const o=await catalog(p);assert.deepEqual([o.rpc,o.args.p_query,o.args.p_active,o.args.p_limit],['erp_catalog_list','Cliente & Cia',true,20]);}],
  ['listar_cadastros',{tipo:'produtos',limite:50,apos:ID},`/v1/cadastros/products?limit=50&after=${ID}`,async p=>{const o=await catalog(p);assert.deepEqual([o.rpc,o.args.p_after],['erp_catalog_product_list',ID]);}],
  ['listar_cadastros',{tipo:'depositos'},'/v1/cadastros/warehouses?limit=20',async p=>assert.equal((await catalog(p)).args.p_entity,'warehouses')],
  ['consultar_cadastro',{tipo:'contatos',id:ID.toUpperCase()},`/v1/cadastros/contacts/${ID}`,async p=>{const o=await catalog(p);assert.deepEqual([o.rpc,o.args.p_id],['erp_catalog_get',ID]);}],
  ['listar_documentos',{tipo:'pedidos_venda',situacoes:['open','in_progress'],data_de:'2026-11-01',data_ate:'2026-11-13',busca:'42'},
   '/v1/documentos/sales_orders?page=1&order=date_desc&limit=20&q=42&status=open%2Cin_progress&date_from=2026-11-01&date_to=2026-11-13',
   async p=>{const o=await documents(p);assert.deepEqual([o.rpc,o.args.p_kind,o.args.p_page,o.args.p_order,o.args.p_statuses,o.args.p_date_from],['erp_document_list','sales_orders',1,'date_desc',['open','in_progress'],'2026-11-01']);}],
  ['listar_documentos',{tipo:'ordens_servico',ordem:'number_asc',pagina:3,limite:5},'/v1/documentos/service_orders?page=3&order=number_asc&limit=5',async p=>assert.equal((await documents(p)).args.p_page,3)],
  ['consultar_documento',{tipo:'propostas',id:ID},`/v1/documentos/sales_proposals/${ID}`,async p=>{const o=await documents(p);assert.deepEqual([o.rpc,o.args.p_id],['erp_document_get',ID]);}],
  ['listar_posicoes_estoque',{busca:'Parafuso',deposito_id:WAREHOUSE,situacao_limite:'below_min'},`/v1/posicoes-estoque?limit=20&q=Parafuso&warehouse_id=${WAREHOUSE}&limit_state=below_min`,
   p=>{const o=parseStockPositionsRoute(get(p));assert.deepEqual([o.rpc,o.args.p_warehouse_id,o.args.p_limit_state],['erp_stock_positions',WAREHOUSE,'below_min']);}],
  ['listar_titulos',{tipo:'receber',opcao:'overdue',de:'2026-10-01',ate:'2026-11-13'},'/v1/financeiro/titles?page=1&limit=20&kind=receivable&order=due_asc&option=overdue&from=2026-10-01&to=2026-11-13',
   async p=>{const o=await parseFinanceRoute(get(p));assert.deepEqual([o.rpc,o.args.p_kind,o.args.p_option,o.args.p_date_field,o.args.p_from],['erp_finance_title_page_v2','receivable','overdue','due','2026-10-01']);}],
  ['listar_titulos',{tipo:'pagar',opcao:'settled',ordem:'due_desc'},'/v1/financeiro/titles?page=1&limit=20&kind=payable&order=due_desc&option=settled',async p=>assert.equal((await parseFinanceRoute(get(p))).args.p_date_field,'settled')],
  ['consultar_titulo',{id:ID},`/v1/financeiro/titles/${ID}`,async p=>{const o=await parseFinanceRoute(get(p));assert.deepEqual([o.kind,o.rpc,o.args.p_id],['get','erp_finance_get',ID]);}],
  ['consultar_vencimentos',{},'/v1/relatorios/vencimentos',p=>assert.deepEqual(parseDueReportRoute(get(p)).args,{p_from:null,p_to:null})],
  ['consultar_vencimentos',{de:'2026-01-01',ate:'2027-01-01'},'/v1/relatorios/vencimentos?from=2026-01-01&to=2027-01-01',p=>assert.equal(parseDueReportRoute(get(p)).rpc,'erp_finance_due_report')],
  ['consultar_painel',{},'/v1/inicio',p=>assert.equal(homeOperation(get(p),url(p).searchParams).rpc,'erp_home_summary')],
  ['consultar_painel',{periodo:'30d'},'/v1/inicio?periodo=30d',p=>assert.deepEqual(homeOperation(get(p),url(p).searchParams).args,{p_period:'30d',p_from:null,p_to:null})],
 ];
 for(const[name,args,expected,check]of cases){const request=mcpToolRequest(name,args);assert.deepEqual(request,{method:'GET',path:expected},name);await check?.(request.path);}
 // Every read of the list is covered above, and null stands for what was left out.
 assert.deepEqual([...new Set(cases.map(c=>c[0]))],READS);
 assert.equal(mcpToolRequest('listar_cadastros',{tipo:'produtos',busca:null,ativo:undefined}).path,'/v1/cadastros/products?limit=20');
 assert.equal(mcpToolRequest('apagar_tudo',{}),null);
});

const COMMAND='50000000-0000-4000-8000-000011130002';
const contato={name:'Cliente Sintético',person_type:'J',document:'11222333000181',roles:['customer']};
const documento={date:'2026-11-13',contact_id:ID,items:[{product_id:WAREHOUSE,description:'Parafuso sintético',unit:'UN',quantity:'2',unit_price:'10.50'}],notes:'Linha 1\nLinha 2'};
test('each write becomes one POST or PATCH the API routes accept, with a command id, on the save RPCs only',async()=>{
 const send=r=>new Request('https://api.synthetic.test'+r.path,{method:r.method,headers:{'Content-Type':'application/json'},body:JSON.stringify(r.body)});
 const catalog=async r=>catalogOperation(send(r),catalogRoute(r.path),new URLSearchParams());
 const documents=async r=>documentsOperation(send(r),documentsRoute(r.path),new URLSearchParams());
 const cases=[
  ['criar_contato',{dados:contato},'POST','/v1/cadastros/contacts',async r=>{const o=await catalog(r);
   assert.deepEqual([o.rpc,o.args.p_id,o.args.p_expected_version,o.args.p_command_id,o.args.p_data,o.args.p_acknowledged],['erp_catalog_save_checked',null,0,COMMAND,contato,[]]);
   assert.deepEqual(r.check,{path:'/v1/cadastros/contacts/check',body:{data:contato},acknowledged:[]});
   assert.equal((await catalog({method:'POST',path:r.check.path,body:r.check.body})).rpc,'erp_catalog_check');}],
  ['atualizar_contato',{id:ID.toUpperCase(),versao:3,dados:{phone:'11 4000-0000',email:null},confirmar_avisos:['duplicate_document']},'PATCH',`/v1/cadastros/contacts/${ID}`,async r=>{const o=await catalog(r);
   assert.deepEqual([o.rpc,o.args.p_id,o.args.p_expected_version,o.args.p_data,o.args.p_acknowledged],['erp_catalog_save_checked',ID,3,{phone:'11 4000-0000',email:null},['duplicate_document']]);
   assert.deepEqual(r.check.body,{id:ID,data:{phone:'11 4000-0000',email:null}});}],
  ['criar_produto',{dados:{name:'Parafuso sintético',code:'P-1',unit:'UN',price:'10.50',kind:'P'}},'POST','/v1/cadastros/products',async r=>{const o=await catalog(r);assert.deepEqual([o.rpc,o.args.p_entity,o.args.p_data.price],['erp_catalog_save_checked','products','10.50']);
   assert.equal((await catalog({method:'POST',path:r.check.path,body:r.check.body})).rpc,'erp_catalog_check');}],
  ['atualizar_produto',{id:ID,versao:1,dados:{price:'11'}},'PATCH',`/v1/cadastros/products/${ID}`,async r=>assert.deepEqual((await catalog(r)).args.p_data,{price:'11'})],
  ['criar_proposta',{dados:{...documento,valid_until:'2026-12-13'}},'POST','/v1/documentos/sales_proposals',async r=>{const o=await documents(r);
   assert.deepEqual([o.rpc,o.args.p_kind,o.args.p_id,o.args.p_expected_version,o.args.p_command_id,o.args.p_body.valid_until,o.args.p_body.items.length],['erp_document_save','sales_proposals',null,0,COMMAND,'2026-12-13',1]);}],
  ['criar_pedido_venda',{dados:{...documento,expected_date:'2026-11-20',freight:'25.00'}},'POST','/v1/documentos/sales_orders',async r=>{const o=await documents(r);assert.deepEqual([o.rpc,o.args.p_kind,o.args.p_body.freight],['erp_document_save','sales_orders','25.00']);}],
  ['registrar_ocorrencia',{tipo:'pedidos_venda',id:ID,versao:2,data:'2026-11-13',hora:'09:30',texto:'Cliente pediu retorno.'},'POST',`/v1/documentos/sales_orders/${ID}/ocorrencias`,async r=>{const o=await documents(r);
   assert.deepEqual([o.rpc,o.args.p_document_id,o.args.p_expected_version,o.args.p_occurred_time,o.args.p_text,o.args.p_status,o.args.p_next_contact],['erp_document_occurrence_add',ID,2,'09:30','Cliente pediu retorno.',null,null]);}],
 ];
 for(const[name,args,method,path,check]of cases){const request=mcpToolRequest(name,args,()=>COMMAND);
  assert.deepEqual([request.method,request.path,request.command,request.body.command_id],[method,path,COMMAND,COMMAND],name);await check(request);}
 assert.deepEqual(cases.map(c=>c[0]),WRITES);
 // The agent may bring its own command id; without one, each call gets a new one.
 assert.equal(mcpToolRequest('criar_contato',{dados:contato,comando_id:COMMAND.toUpperCase().replace('5','A')}).command,COMMAND.replace('5','a'));
 const fresh=[mcpToolRequest('criar_contato',{dados:contato}).command,mcpToolRequest('criar_contato',{dados:contato}).command];
 assert.match(fresh[0],/^[0-9a-f-]{36}$/);assert.notEqual(fresh[0],fresh[1]);
});

test('a refused argument goes back to the model by name and never reaches a route',async()=>{
 const b=backend();
 for(const[name,args,field]of[['consultar_acesso',{extra:1},'extra'],['listar_cadastros',{},'tipo'],['listar_cadastros',{tipo:'contacts/../financeiro'},'tipo'],['listar_cadastros',{tipo:'contatos',limite:51},'limite'],
  ['listar_cadastros',{tipo:'contatos',limite:'20'},'limite'],['listar_cadastros',{tipo:'contatos',busca:'a\nb'},'busca'],['listar_cadastros',{tipo:'contatos',busca:'x'.repeat(121)},'busca'],
  ['listar_cadastros',{tipo:'contatos',ativo:'true'},'ativo'],['consultar_cadastro',{tipo:'contatos',id:`${ID}/active`},'id'],['consultar_cadastro',{tipo:'contatos'},'id'],
  ['listar_documentos',{tipo:'pedidos_compra',situacoes:['draft']},'situacoes'],['listar_documentos',{tipo:'propostas',situacoes:['open','open']},'situacoes'],['listar_documentos',{tipo:'propostas',situacoes:[]},'situacoes'],
  ['listar_documentos',{tipo:'propostas',data_de:'2026-02-30'},'data_de'],['listar_documentos',{tipo:'propostas',data_de:'2026-11-13',data_ate:'2026-11-01'},'data_ate'],['listar_documentos',{tipo:'propostas',ordem:'total_desc'},'ordem'],
  ['listar_posicoes_estoque',{deposito_id:'x'},'deposito_id'],['listar_titulos',{tipo:'ambos'},'tipo'],['listar_titulos',{tipo:'receber',opcao:'todas'},'opcao'],['listar_titulos',{tipo:'receber',de:'2026-11-13',ate:'2026-11-01'},'ate'],
  ['consultar_vencimentos',{de:'2026-11-01'},'ate'],['consultar_vencimentos',{ate:'2026-11-01'},'de'],['consultar_vencimentos',{de:'2026-01-01',ate:'2027-01-02'},'ate'],['consultar_painel',{periodo:'customizado'},'periodo']]){
  const error=await refused(await tool(b.handler,name,args));assert.deepEqual([error.code,error.field],['MCP_INVALID_ARGUMENT',field],`${name} ${JSON.stringify(args)}`);assert.ok(error.hint);}
 assert.equal((await refused(await post(b.handler,rpc('tools/call',{name:'consultar_acesso',arguments:[]})))).field,'arguments');
 assert.deepEqual([...new Set(names(b))].sort(),['erp_access_agent_resolve','erp_access_gate_v2']);
});

test('a refused write argument is named down to the field and nothing is sent',async()=>{
 const b=backend(),item=documento.items[0];
 for(const[name,args,field,reason]of[['criar_contato',{},'dados'],['criar_contato',{dados:{}},'dados.name'],['criar_contato',{dados:{name:null}},'dados.name'],['criar_contato',{dados:{name:'  '}},'dados.name'],
  ['criar_contato',{dados:{name:'X',cpf:'1'}},'dados.cpf'],['criar_contato',{dados:{name:'X',roles:['admin']}},'dados.roles'],['criar_contato',{dados:{name:'X',person_type:'X'}},'dados.person_type'],
  ['criar_contato',{dados:contato,confirmar_avisos:['tudo']},'confirmar_avisos'],['criar_contato',{dados:contato,comando_id:'1'},'comando_id'],['criar_contato',{dados:contato,id:ID},'id'],['criar_contato',{dados:[contato]},'dados'],
  ['atualizar_contato',{id:ID,dados:{phone:'1'}},'versao'],['atualizar_contato',{id:ID,versao:0,dados:{phone:'1'}},'versao'],['atualizar_contato',{id:ID,versao:1,dados:{}},'dados'],['atualizar_contato',{versao:1,dados:{phone:'1'}},'id'],
  ['criar_produto',{dados:{name:'P',price:'10,50'}},'dados.price'],['criar_produto',{dados:{name:'P',price:10.5}},'dados.price'],['criar_produto',{dados:{name:'P',kind:'N'}},'dados.kind'],['atualizar_produto',{id:'x',versao:1,dados:{price:'1'}},'id'],
  ['criar_proposta',{dados:{...documento,items:[]}},'dados.items'],['criar_proposta',{dados:{...documento,items:[{...item,quantity:'1,5'}]}},'dados.items.0.quantity'],['criar_proposta',{dados:{...documento,items:[{...item,unit:undefined}]}},'dados.items.0.unit'],
  ['criar_proposta',{dados:{...documento,items:[{...item,quantity:'0'}]}},'dados','DOCUMENT_QUANTITY_INVALID'],['criar_proposta',{dados:{...documento,contact_id:undefined}},'dados.contact_id'],['criar_proposta',{dados:{...documento,status:'approved'}},'dados.status'],
  ['criar_proposta',{dados:{...documento,number:'77'}},'dados.number'],['criar_pedido_venda',{dados:{...documento,valid_until:'2026-12-01'}},'dados.valid_until'],['criar_pedido_venda',{dados:{...documento,date:'13/11/2026'}},'dados.date'],
  ['registrar_ocorrencia',{tipo:'pedidos_venda',id:ID,versao:1,data:'2026-11-13',hora:'25:00',texto:'x'},'hora'],['registrar_ocorrencia',{tipo:'pedidos_venda',id:ID,versao:1,data:'2026-11-13',hora:'09:30',texto:'x',status:'cancelled'},'status'],
  ['registrar_ocorrencia',{tipo:'notas',id:ID,versao:1,data:'2026-11-13',hora:'09:30',texto:'x'},'tipo'],['registrar_ocorrencia',{tipo:'pedidos_venda',id:ID,versao:1,data:'2026-11-13',hora:'09:30'},'texto']]){
  const error=await refused(await tool(b.handler,name,JSON.parse(JSON.stringify(args))));assert.deepEqual([error.code,error.field,error.reason],['MCP_INVALID_ARGUMENT',field,reason],`${name} ${JSON.stringify(args)}`);}
 assert.deepEqual([...new Set(names(b))].sort(),['erp_access_agent_resolve','erp_access_gate_v2']);
});

const saved={entity:'contacts',data_mode:'erp_native',replayed:false,record:{id:ID,entity:'contacts',version:1,active:true,name:'Cliente Sintético',person_type:'J',document:'11222333000181',roles:['customer'],created_at:'2026-11-13T12:00:00+00:00',updated_at:'2026-11-13T12:00:00+00:00'}};
const duplicate={entity:'contacts',data_mode:'erp_native',warnings:[{code:'duplicate_document',field:'document',total:1,matches:[{id:WAREHOUSE,name:'Cliente Sintético Antigo',code:null,active:true}]}]};
const sql=(code,message,status=400)=>()=>new Response(JSON.stringify({code,message}),{status});
test('a write is one save as the agent, with the command id; the record written comes back',async()=>{
 const b=backend({erp_catalog_save_checked:saved}),body=await(await tool(b.handler,'criar_contato',{dados:contato,comando_id:COMMAND})).json();
 assert.equal(body.result.isError,undefined);assert.deepEqual(JSON.parse(body.result.content[0].text).record.id,ID);
 assert.deepEqual(names(b),['erp_access_agent_resolve','erp_access_gate_v2','erp_catalog_save_checked']);
 assert.deepEqual(JSON.parse(b.calls[2].o.body),{p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:COMMAND,p_data:contato,p_acknowledged:[],p_user_id:AGENT});
 for(const c of b.calls){assert.equal(c.o.headers.Authorization,'Bearer synthetic-service');assert.equal(JSON.stringify([c.path,c.o.headers,c.o.body]).includes(TOKEN),false);}
});

test('an unconfirmed warning is told apart from a stale version, and nothing is saved until the person confirms',async()=>{
 const answers={erp_catalog_save_checked:null,erp_catalog_check:duplicate},b=backend(answers);
 answers.erp_catalog_save_checked=sql('40001','erp_catalog_warning_unacknowledged',409)();
 const warned=await refused(await tool(b.handler,'criar_contato',{dados:contato,comando_id:COMMAND}));
 assert.deepEqual([warned.code,warned.command_id,warned.warnings],['MCP_WARNINGS_UNCONFIRMED',COMMAND,duplicate.warnings]);assert.match(warned.hint,/confirmar_avisos/);
 assert.deepEqual(names(b).slice(2),['erp_catalog_save_checked','erp_catalog_check']);assert.deepEqual(JSON.parse(b.calls.at(-1).o.body),{p_entity:'contacts',p_id:null,p_data:contato,p_user_id:AGENT});
 // Confirmed by name: the save carries the confirmation and the SQL decides again.
 answers.erp_catalog_save_checked=saved;b.calls.length=0;
 assert.equal((await(await tool(b.handler,'criar_contato',{dados:contato,comando_id:COMMAND,confirmar_avisos:['duplicate_document']})).json()).result.isError,undefined);
 assert.deepEqual(JSON.parse(b.calls.at(-1).o.body).p_acknowledged,['duplicate_document']);assert.equal(names(b).includes('erp_catalog_check'),false);
 // A conflict with no pending warning is the version or the command: a plain conflict, with the command id.
 answers.erp_catalog_save_checked=sql('40001','erp_catalog_version_conflict',409)();answers.erp_catalog_check={...duplicate,warnings:[]};
 const stale=await refused(await tool(b.handler,'atualizar_contato',{id:ID,versao:1,dados:{phone:'1'},comando_id:COMMAND}));
 assert.deepEqual([stale.code,stale.command_id,stale.warnings],['ERP_CONFLICT',COMMAND,undefined]);assert.match(stale.hint,/version/);
 // A warning already confirmed does not hide a real conflict.
 answers.erp_catalog_save_checked=sql('40001','erp_catalog_version_conflict',409)();answers.erp_catalog_check=duplicate;
 assert.equal((await refused(await tool(b.handler,'atualizar_contato',{id:ID,versao:1,dados:{phone:'1'},confirmar_avisos:['duplicate_document']}))).code,'ERP_CONFLICT');
});

test('a refused or interrupted write names its command id so the same command can be repeated without duplicating',async()=>{
 const answers={},b=backend(answers);
 answers.erp_catalog_save_checked=sql('42501','erp_catalog_forbidden',403)();
 const forbidden=await refused(await tool(b.handler,'criar_produto',{dados:{name:'Parafuso sintético'}}));
 assert.equal(forbidden.code,'ERP_FORBIDDEN');assert.match(forbidden.command_id,/^[0-9a-f-]{36}$/);assert.equal(names(b).includes('erp_catalog_check'),false);
 answers.erp_catalog_save_checked=new Response('synthetic gateway failure',{status:502});
 const lost=await refused(await tool(b.handler,'criar_produto',{dados:{name:'Parafuso sintético'}}));
 assert.equal(lost.code,'ERP_UPSTREAM_UNAVAILABLE');assert.match(lost.hint,/comando_id/);
 answers.erp_catalog_save_checked={...saved,entity:'products',replayed:true,record:{id:ID,entity:'products',version:1,active:true,name:'Parafuso sintético',created_at:'2026-11-13T12:00:00+00:00',updated_at:'2026-11-13T12:00:00+00:00'}};
 const again=await(await tool(b.handler,'criar_produto',{dados:{name:'Parafuso sintético'},comando_id:lost.command_id})).json();
 assert.equal(JSON.parse(again.result.content[0].text).replayed,true);assert.equal(JSON.parse(b.calls.at(-1).o.body).p_command_id,lost.command_id);
 // A saved write whose answer is too large for a model is still reported as saved.
 const message=()=>new Request('https://api.synthetic.test/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rpc('tools/call',{name:'criar_contato',arguments:{dados:contato,comando_id:COMMAND}}))});
 const sent=[],large=await handleMcp(message(),{call:async(path,options)=>{sent.push([path,options.method,options.body.command_id]);return new Response('x'.repeat(MCP_RESULT_CHARS+1));}});
 assert.deepEqual(sent,[['/v1/cadastros/contacts','POST',COMMAND]]);assert.equal(large.body.result.isError,undefined);
 assert.deepEqual([JSON.parse(large.body.result.content[0].text).saved,JSON.parse(large.body.result.content[0].text).command_id],[true,COMMAND]);
});

test('a tool call is answered by the API itself, as the agent: one token resolution, the service key upstream, the token nowhere',async()=>{
 const b=backend(),r=await tool(b.handler,'consultar_acesso',{});
 assert.equal(r.status,200);const body=await r.json();assert.equal(body.result.isError,undefined);assert.equal(body.result.content.length,1);
 const access=JSON.parse(body.result.content[0].text);assert.deepEqual([access.user_id,access.role,access.resources],[AGENT,'consulta',['contacts','products']]);
 assert.deepEqual(names(b),['erp_access_agent_resolve','erp_access_gate_v2','erp_access_me']);
 assert.deepEqual(JSON.parse(b.calls[2].o.body),{p_user_id:AGENT});
 const stock=await(await tool(b.handler,'listar_posicoes_estoque',{busca:'Parafuso'})).json(),page=JSON.parse(stock.result.content[0].text);
 assert.deepEqual([page.items.length,page.items[0].product.name,page.items[0].global.quantity,page.has_more],[1,'Parafuso sintético','5.000000',false]);
 const sent=b.calls.at(-1);assert.equal(sent.name,'erp_stock_positions');assert.equal(sent.o.method,'POST');
 assert.deepEqual(JSON.parse(sent.o.body),{p_user_id:AGENT,p_limit:20,p_after:null,p_query:'Parafuso',p_active:null,p_warehouse_id:null,p_brand:null,p_location:null,p_stock_state:null,p_limit_state:null});
 for(const c of b.calls){assert.equal(c.o.headers.Authorization,'Bearer synthetic-service');assert.equal(JSON.stringify([c.path,c.o.headers,c.o.body]).includes(TOKEN),false);assert.equal(c.path.includes('/auth/'),false);}
});

test('what the API refuses comes back as a tool error with its code; a result too large for a model is not returned',async()=>{
 const denied=backend({erp_stock_positions:new Response(JSON.stringify({code:'42501',message:'synthetic private detail'}),{status:403})});
 const response=await tool(denied.handler,'listar_posicoes_estoque',{}),raw=await response.clone().text(),error=await refused(response);
 assert.equal(response.status,200);assert.equal(error.code,'ERP_FORBIDDEN');assert.match(error.request_id,/^[0-9a-f-]{36}$/);assert.ok(error.hint);assert.equal(raw.includes('synthetic private detail'),false);
 const broken=backend({erp_stock_positions:{...positions,scope:'other'}});assert.equal((await refused(await tool(broken.handler,'listar_posicoes_estoque',{}))).code,'ERP_UPSTREAM_INVALID_RESPONSE');
 const message=()=>new Request('https://api.synthetic.test/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rpc('tools/call',{name:'consultar_acesso'}))});
 const large=await handleMcp(message(),{call:async()=>new Response('x'.repeat(MCP_RESULT_CHARS+1))});
 assert.equal(JSON.parse(large.body.result.content[0].text).error.code,'MCP_RESULT_TOO_LARGE');assert.equal(large.body.result.isError,true);
 const fits=await handleMcp(message(),{call:async path=>{assert.equal(path,'/v1/me');return new Response('y'.repeat(MCP_RESULT_CHARS));}});assert.equal(fits.body.result.isError,undefined);
 const opaque=await handleMcp(message(),{call:async()=>new Response('<html>synthetic</html>',{status:500})});
 assert.deepEqual(JSON.parse(opaque.body.result.content[0].text),{error:{code:'ERP_INTERNAL_ERROR'}});
});
