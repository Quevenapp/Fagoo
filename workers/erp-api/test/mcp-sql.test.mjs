import test from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{acessoHFixture}from'./helpers/acesso-h-fixture.mjs';
import{createHandler}from'../src/index.mjs';

// MCP for agents (src/mcp.mjs) against the real SQL of the access model (wave H) plus 202611130001: the Worker, the token
// resolver, the gate and the read RPCs each tool reaches. Synthetic data only.
const MIGRATION='202611130001_access_agents.sql',BASE='https://project.supabase.co';
const env={SUPABASE_URL:BASE,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'',ERP_AGENT_ACCESS_ENABLED:'true'};
const sha=text=>createHash('sha256').update(text).digest('hex');
const newToken=()=>'fagoo_agt_'+createHash('sha256').update(randomUUID()).digest('base64url');
/** PostgREST as the Worker sees it: an RPC by name with the service key, and SQL errors as { code, message }. */
const bridge=f=>async(url,o)=>{const name=url.split('/').at(-1);assert.ok(url.startsWith(`${BASE}/rest/v1/rpc/`),url);assert.equal(o.headers.Authorization,'Bearer synthetic-service');
 try{return Response.json(await f.rpc(name,JSON.parse(o.body)));}
 catch(e){return new Response(JSON.stringify({code:e.code??'XX000',message:e.message}),{status:e.code==='42501'?403:e.code==='P0002'?404:400});}};
const agent=async(f,role)=>{const id=randomUUID(),token=newToken();
 await f.db.query('insert into auth.users(id,email)values($1,$2)',[id,`agente-${id}@agentes.fagoo.invalid`]);
 await f.db.query('select erp_access.agent_register($1,$2,$3)',[id,`Agente ${role}`,role]);
 const tokenId=(await f.db.query('select erp_access.agent_token_issue($1,$2,$3,$4) v',[id,sha(token),token.slice(-4),null])).rows[0].v;
 return{id,token,tokenId};};
const call=async(handler,token,name,args={})=>{
 const response=await handler(new Request('https://api.synthetic.test/mcp',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);
 if(response.status!==200)return{status:response.status,code:(await response.json()).error.code};
 const{result}=await response.json(),value=JSON.parse(result.content[0].text);
 return result.isError?{status:200,code:value.error.code,error:value.error}:{status:200,value};};

test('mcp over the real SQL: an agent reads what its profile reads, is refused the rest and stops when the token is revoked',async()=>{const f=await acessoHFixture();try{
 await f.migrate(MIGRATION);
 const contact=await f.catalog('contacts',{name:'Cliente Sintético MCP',roles:['customer']}),product=await f.catalog('products',{name:'Produto Sintético MCP',code:'MCP-1',unit:'UN',price:'10.00',kind:'P'});
 const order=await f.document('sales_orders',{contact:contact.id,items:[{product_id:product.id,description:'Produto Sintético MCP',quantity:'2',unit_price:'10.00'}]});
 const handler=createHandler({fetchImpl:bridge(f)}),consulta=await agent(f,'consulta'),estoque=await agent(f,'estoque');
 const ok=async(who,name,args)=>{const answer=await call(handler,who.token,name,args);assert.equal(answer.code,undefined,`${name} ${JSON.stringify(args)}`);return answer.value;};
 const refused=async(who,name,args)=>(await call(handler,who.token,name,args)).code;

 // Consulta reads every module the tools reach.
 const access=await ok(consulta,'consultar_acesso',{});assert.deepEqual([access.user_id,access.role],[consulta.id,'consulta']);
 const contacts=await ok(consulta,'listar_cadastros',{tipo:'contatos',busca:'Sintético MCP'});assert.deepEqual(contacts.items.map(item=>item.id),[contact.id]);
 assert.equal((await ok(consulta,'consultar_cadastro',{tipo:'contatos',id:contact.id})).record.name,'Cliente Sintético MCP');
 assert.ok((await ok(consulta,'listar_cadastros',{tipo:'produtos',busca:'MCP-1'})).items.some(item=>item.id===product.id));
 assert.ok(Array.isArray((await ok(consulta,'listar_cadastros',{tipo:'depositos'})).items));
 const orders=await ok(consulta,'listar_documentos',{tipo:'pedidos_venda'});assert.equal(orders.total_count,1);assert.deepEqual(orders.items.map(item=>item.id),[order.id]);
 assert.equal((await ok(consulta,'listar_documentos',{tipo:'pedidos_venda',data_de:'2026-10-16'})).total_count,0);
 const detail=await ok(consulta,'consultar_documento',{tipo:'pedidos_venda',id:order.id});assert.deepEqual([detail.document.id,detail.document.items.length],[order.id,1]);
 assert.equal((await ok(consulta,'listar_posicoes_estoque',{busca:'MCP-1'})).scope,'stock_positions');
 const titles=await ok(consulta,'listar_titulos',{tipo:'receber',opcao:'open'});assert.deepEqual([titles.kind,titles.option,titles.total],['receivable','open',0]);
 assert.equal((await ok(consulta,'consultar_vencimentos',{})).day_count,30);
 assert.equal((await ok(consulta,'consultar_painel',{})).role,'consulta');assert.equal((await ok(consulta,'consultar_painel',{periodo:'30d'})).period.key,'30d');
 // What is not there, and what the profile does not read, is refused by the SQL and named to the model.
 assert.equal(await refused(consulta,'consultar_cadastro',{tipo:'contatos',id:randomUUID()}),'ERP_NOT_FOUND');
 assert.equal(await refused(consulta,'consultar_titulo',{id:randomUUID()}),'ERP_NOT_FOUND');
 assert.ok((await ok(estoque,'listar_cadastros',{tipo:'produtos'})).items.length>=1);
 for(const[name,args]of[['listar_titulos',{tipo:'receber'}],['listar_titulos',{tipo:'pagar',opcao:'overdue'}],['consultar_vencimentos',{}]])
  assert.equal(await refused(estoque,name,args),'ERP_FORBIDDEN',name);

 // The reads left the record at its version; the use of the token is recorded.
 assert.equal((await ok(consulta,'consultar_cadastro',{tipo:'contatos',id:contact.id})).record.version,contact.version);
 assert.equal(await f.scalar('select last_used_at is not null v from erp_access.agent_token where id=$1',[consulta.tokenId]),true);
 // An agent moved beyond its limits, an inactive agent and a revoked token stop at the door, before any tool.
 await f.db.query("update erp_access.membership set role='financeiro',updated_at=clock_timestamp() where user_id=$1",[estoque.id]);
 assert.deepEqual(await call(handler,estoque.token,'consultar_acesso'),{status:403,code:'ERP_AGENT_ACCESS_DENIED'});
 await f.db.query('select erp_access.agent_token_revoke($1)',[consulta.tokenId]);
 assert.deepEqual(await call(handler,consulta.token,'consultar_acesso'),{status:401,code:'ERP_UNAUTHENTICATED'});
}finally{await f.close();}});

test('mcp writes over the real SQL: the profile decides, a command is saved once, a duplicate waits for the person and a stale version is refused',async()=>{const f=await acessoHFixture();try{
 await f.migrate(MIGRATION);
 const handler=createHandler({fetchImpl:bridge(f)}),vendas=await agent(f,'vendas'),consulta=await agent(f,'consulta'),estoque=await agent(f,'estoque');
 const ok=async(who,name,args)=>{const answer=await call(handler,who.token,name,args);assert.equal(answer.code,undefined,`${name} ${JSON.stringify(answer.error)}`);return answer.value;};
 const refused=async(who,name,args)=>(await call(handler,who.token,name,args)).error;
 const contacts=()=>f.scalar("select count(*)::int v from erp_catalog.record where entity='contacts'");
 const dados={name:'Cliente Novo MCP',person_type:'J',document:'11222333000181',roles:['customer']},command=randomUUID();

 // Cadastros: vendas writes contacts; the record is the agent's work and the same command saves once.
 const created=await ok(vendas,'criar_contato',{dados,comando_id:command});
 assert.deepEqual([created.record.name,created.record.version,created.record.document,created.record.roles],['Cliente Novo MCP',1,'11222333000181',['customer']]);
 const replay=await ok(vendas,'criar_contato',{dados,comando_id:command});assert.deepEqual([replay.record.id,replay.replayed],[created.record.id,true]);assert.equal(await contacts(),1);
 assert.equal(await f.scalar('select actor v from erp_catalog.audit where record_id=$1 order by 1 limit 1',[created.record.id]),vendas.id);
 // The same document again: nothing is saved, the existing contact is named, and the confirmed repeat saves.
 const second=randomUUID(),warned=await refused(vendas,'criar_contato',{dados:{...dados,name:'Cliente Repetido MCP'},comando_id:second});
 assert.deepEqual([warned.code,warned.command_id,warned.warnings.map(w=>w.code),warned.warnings[0].matches.map(m=>m.id)],['MCP_WARNINGS_UNCONFIRMED',second,['duplicate_document'],[created.record.id]]);
 assert.equal(await contacts(),1);
 assert.equal((await ok(vendas,'criar_contato',{dados:{...dados,name:'Cliente Repetido MCP'},comando_id:second,confirmar_avisos:['duplicate_document']})).record.name,'Cliente Repetido MCP');assert.equal(await contacts(),2);
 // An update needs the version read; a stale one is a plain conflict and changes nothing.
 const updated=await ok(vendas,'atualizar_contato',{id:created.record.id,versao:1,dados:{phone:'11 4000-0000',document:null}});
 assert.deepEqual([updated.record.version,updated.record.phone,updated.record.document,updated.record.name],[2,'11 4000-0000',null,'Cliente Novo MCP']);
 const stale=await refused(vendas,'atualizar_contato',{id:created.record.id,versao:1,dados:{phone:'11 5000-0000'}});assert.deepEqual([stale.code,stale.warnings],['ERP_CONFLICT',undefined]);assert.match(stale.command_id,/^[0-9a-f-]{36}$/);
 assert.equal((await ok(consulta,'consultar_cadastro',{tipo:'contatos',id:created.record.id})).record.phone,'11 4000-0000');
 // What the profile does not write is refused by the SQL.
 assert.equal((await refused(consulta,'criar_contato',{dados:{name:'Recusado MCP'}})).code,'ERP_FORBIDDEN');
 assert.equal((await refused(consulta,'atualizar_contato',{id:created.record.id,versao:2,dados:{phone:'1'}})).code,'ERP_FORBIDDEN');
 assert.equal((await refused(vendas,'criar_produto',{dados:{name:'Produto Recusado MCP'}})).code,'ERP_FORBIDDEN');assert.equal(await contacts(),2);
 const product=await ok(estoque,'criar_produto',{dados:{name:'Produto Novo MCP',code:'MCP-9',unit:'UN',price:'10.50',kind:'P'}});assert.deepEqual([product.record.code,product.record.version],['MCP-9',1]);
 assert.equal((await ok(estoque,'atualizar_produto',{id:product.record.id,versao:1,dados:{price:'12.00',brand:'Marca Sintética'}})).record.brand,'Marca Sintética');

 // Documents: a proposta is born a rascunho and a pedido em aberto; the occurrence leaves the situation alone.
 const body={date:'2026-11-13',contact_id:created.record.id,items:[{product_id:product.record.id,description:'Produto Novo MCP',unit:'UN',quantity:'2',unit_price:'10.50'}],notes:'Linha 1\nLinha 2'};
 const proposalCommand=randomUUID(),proposal=await ok(vendas,'criar_proposta',{dados:{...body,valid_until:'2026-12-13'},comando_id:proposalCommand});
 assert.deepEqual([proposal.kind,proposal.document.status,proposal.document.items.length],['sales_proposals','draft',1]);
 assert.equal((await ok(vendas,'criar_proposta',{dados:{...body,valid_until:'2026-12-13'},comando_id:proposalCommand})).document.id,proposal.document.id);
 const order=await ok(vendas,'criar_pedido_venda',{dados:{...body,expected_date:'2026-11-20',freight:'5.00'}});
 assert.deepEqual([order.kind,order.document.status,order.operational_effects],['sales_orders','open',false]);
 assert.equal((await ok(consulta,'listar_documentos',{tipo:'pedidos_venda'})).total_count,1);assert.equal((await ok(consulta,'listar_documentos',{tipo:'propostas'})).total_count,1);
 const noted=await ok(vendas,'registrar_ocorrencia',{tipo:'pedidos_venda',id:order.document.id,versao:order.document.version,data:'2026-11-13',hora:'09:30',texto:'Cliente pediu retorno.'});
 // A note alone does not change the document (same situation, same version); a version that is not the current one is refused.
 assert.deepEqual([noted.document.status,noted.document.version],['open',order.document.version]);
 assert.equal((await refused(vendas,'registrar_ocorrencia',{tipo:'pedidos_venda',id:order.document.id,versao:order.document.version+1,data:'2026-11-13',hora:'09:31',texto:'Versão errada.'})).code,'ERP_CONFLICT');
 for(const[name,args]of[['criar_proposta',{dados:body}],['criar_pedido_venda',{dados:body}],['registrar_ocorrencia',{tipo:'pedidos_venda',id:order.document.id,versao:noted.document.version,data:'2026-11-13',hora:'10:00',texto:'Recusada.'}]])
  assert.match((await refused(consulta,name,args)).code,/^ERP_(FORBIDDEN|DOCUMENT_PERMISSION_DENIED)$/,name);
 assert.equal((await ok(consulta,'listar_documentos',{tipo:'pedidos_venda'})).total_count,1);
}finally{await f.close();}});
