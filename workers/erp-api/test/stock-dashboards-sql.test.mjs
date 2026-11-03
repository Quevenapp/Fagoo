import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockOriginFixture,fails} from './helpers/stock-origin-fixture.mjs';
import {createHandler} from '../src/index.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// Migration 107: Estoque de Produtos, Sem Movimentação, Sugestão de Compras and Ajustes (PGlite, synthetic data only).
let f,s;
const PUBLIC=['erp_stock_dashboard_preference_get(uuid)','erp_stock_dashboard_preference_set(uuid,uuid,integer,jsonb,jsonb)','erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer)',
 'erp_stock_dashboard_idle(uuid,date,integer,integer)','erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text)'];
const api=async(path,user=f.users.vendas,body)=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const request=body===undefined?new Request(url):new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const operation=await stockOperation(request,route,url.searchParams);return stockResponse(await f.rpc(operation.rpc,{...operation.args,p_user_id:user}),route,operation);};

test.before(async()=>{
 f=await stockOriginFixture();
 const pen=await f.catalog('products',{name:'Caneta azul',code:'CAN-1',unit:'UN',kind:'P',format:'S',price:'2.5',brand:'Acme',gtin:'7891234567895'});
 const pencil=await f.catalog('products',{name:'Lápis preto',code:'LAP-1',unit:'UN',kind:'P',format:'S',brand:'Outra'});
 const idle=await f.catalog('products',{name:'Borracha',code:'BOR-1',unit:'UN',kind:'P',format:'S',price:'1'});
 const a=await f.warehouse('Geral'),b=await f.warehouse('Avarias',true);
 await f.launch(pen.id,a.id,'receipt','10');await f.launch(pen.id,b.id,'receipt','5');await f.launch(pencil.id,a.id,'receipt','3');await f.launch(idle.id,a.id,'receipt','2');
 const sale=await f.order('sales_orders',[{product_id:pen.id,description:'Caneta',unit:'UN',quantity:'6',unit_price:'2.5'},{product_id:idle.id,description:'Borracha',unit:'UN',quantity:'1',unit_price:'1'}],a.id);
 const p=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_occurred_on:'2026-10-10',p_reason:'Venda sintética'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_preview_hash:p.preview_hash,p_occurred_on:'2026-10-10',p_reason:'Venda sintética',p_ignored_item_ids:[]});
 const purchase=await f.order('purchase_orders',[{product_id:pen.id,description:'Caneta',unit:'UN',quantity:'4',unit_price:'1.2'}],a.id);
 s={pen,pencil,idle,a,b,sale,purchase};
});
test.after(async()=>f?.close());

test('107 grants and readers: only service_role runs the RPCs; stock readers see the dashboards; financeiro does not',async()=>{
 for(const role of['anon','authenticated','service_role'])for(const fn of PUBLIC)assert.equal(await f.scalar('select has_function_privilege($1,$2,\'execute\')v',[role,`public.${fn}`]),role==='service_role',`${role} ${fn}`);
 for(const fn of PUBLIC)assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'config',proconfig)v from pg_proc where oid=$1::regprocedure",[`public.${fn}`]),{definer:true,config:['search_path=pg_catalog']},fn);
 for(const role of['admin','consulta','vendas','fiscal','estoque'])assert.equal((await f.rpc('erp_stock_dashboard_stock',{p_user_id:f.users[role]})).scope,'stock_dashboard_stock',role);
 await assert.rejects(f.rpc('erp_stock_dashboard_stock',{p_user_id:f.users.financeiro}),fails('42501'));
 await assert.rejects(f.rpc('erp_stock_dashboard_preference_get',{p_user_id:f.users.financeiro}),fails('42501'));
});

test('107 Estoque de Produtos: Pesquisar por Código/Descrição/GTIN, Marca and Depósito; ignored warehouses stay out of the total',async()=>{
 const all=await api('/v1/estoque/painel/estoque');
 const pen=all.items.find(item=>item.product_id===s.pen.id);assert.deepEqual([pen.quantity,pen.value],['4.000000','10.00'],'Avarias is desconsiderado (10 received, 6 sold in Geral)');
 const pencil=all.items.find(item=>item.product_id===s.pencil.id);assert.equal(pencil.value,null,'no sale price');assert.equal(all.totals.unpriced,1);
 assert.deepEqual(all.warehouses.map(item=>[item.name,item.ignored,item.quantity]).sort(),[['Avarias',true,'5.000000'],['Geral',false,await f.scalar('select sum(quantity)::numeric(38,6)::text v from erp_stock.balance where warehouse_id=$1',[s.a.id])]]);
 assert.deepEqual((await api('/v1/estoque/painel/estoque?q=can&pesquisar_por=code')).items.map(item=>item.code),['CAN-1']);
 assert.deepEqual((await api('/v1/estoque/painel/estoque?q=lapis&pesquisar_por=description')).items.map(item=>item.code),['LAP-1'],'accent-insensitive');
 assert.deepEqual((await api('/v1/estoque/painel/estoque?q=789123&pesquisar_por=gtin')).items.map(item=>item.code),['CAN-1']);
 assert.deepEqual((await api('/v1/estoque/painel/estoque?marca=acme')).items.map(item=>item.code),['CAN-1']);
 const ignored=await api(`/v1/estoque/painel/estoque?warehouse_id=${s.b.id}`);assert.deepEqual([ignored.items[0].quantity,ignored.totals.quantity],['5.000000','5.000000'],'a filtered ignored warehouse shows its own stock');
 await assert.rejects(api('/v1/estoque/painel/estoque?pesquisar_por=sku'),error=>error.status===400);
});

test('107 Sem Movimentação: products with stock and no native sale since the date ("Sem Venda" when never sold)',async()=>{
 const today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const since=await api(`/v1/estoque/painel/sem-movimentacao?data=${today}`);
 assert.ok(since.items.some(item=>item.product_id===s.pencil.id&&item.last_sale===null),'never sold');
 assert.deepEqual(since.items.filter(item=>item.product_id===s.pen.id).map(item=>item.last_sale),['2026-10-10'],'last native sale before the date');
 assert.equal((await api('/v1/estoque/painel/sem-movimentacao?data=2026-10-10')).items.some(item=>item.product_id===s.pen.id),false,'sold on the date itself');
 assert.ok(since.items.every(item=>item.last_sale===null||item.last_sale<today));
 const old=await api('/v1/estoque/painel/sem-movimentacao?data=2000-01-01');assert.ok(old.items.every(item=>item.last_sale===null),'nothing sold before 2000');
 await assert.rejects(api('/v1/estoque/painel/sem-movimentacao?data=2026-02-30'),error=>error.status===400);
});

test('107 Sugestão de Compras: exact inferred formula over native sales and pending purchase quantities; Ajustes per user',async()=>{
 const today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const preference=(await api('/v1/estoque/painel/ajustes')).preference;assert.deepEqual([preference.version,preference.purchase_statuses],[0,['open','in_progress','partially_fulfilled']]);
 const query=(extra='')=>`/v1/estoque/painel/sugestao?de=2026-10-01&ate=2026-10-30&cobertura=30&compras=open,in_progress&vendas=${preference.sales_statuses.join(',')}${extra}`;
 // Pedido de Compra and Valor Estimado are purchase data (008): vendas does not read purchase orders.
 await assert.rejects(api(query(),f.users.vendas),fails('42501'));
 for(const role of['admin','consulta','fiscal'])assert.equal((await api(query(),f.users[role])).total>0,true,role);
 const suggest=path=>api(path,f.users.estoque);
 const result=await suggest(query());const row=result.items.find(item=>item.product_id===s.pen.id);
 // 6 sold in 30 days, coverage 30: 6 − stock (considered: Geral 4) − 4 pending purchase → 0; coverage 120 → 24 − 4 − 4 = 16.
 const stock=Number(row.stock);assert.deepEqual([row.sold,row.stock,row.ordered,row.suggestion],['6.000000','4.000000','4.000000','0']);
 assert.equal(row.unit_price,'1.2000000000');assert.equal(row.value,'0.00');
 const longer=(await suggest(query('').replace('cobertura=30','cobertura=120'))).items.find(item=>item.product_id===s.pen.id);assert.equal(longer.suggestion,String(Math.floor(6*120/30-stock-4)));
 assert.equal(longer.value,'19.20','Valor Estimado = sugestão × preço da última compra');
 const reserved=(await suggest(query('&reserva=sim').replace('cobertura=30','cobertura=120'))).items.find(item=>item.product_id===s.pen.id);assert.equal(reserved.reserved,'0.000000');
 const ninth=(await suggest(query('').replace('cobertura=30','cobertura=47'))).items.find(item=>item.product_id===s.pen.id);assert.equal(ninth.suggestion,'1','floor(6 × 47 ÷ 30 − 8) = floor(1.4)');
 assert.equal((await suggest(query('').replace('compras=open,in_progress','compras=cancelled'))).items.find(item=>item.product_id===s.pen.id).ordered,'0.000000');
 assert.equal((await suggest(query('&marca=Outra'))).total,0,'"Nenhum resultado encontrado - Verifique os filtros utilizados."');
 await assert.rejects(suggest(query().replace('de=2026-10-01','de=2026-11-01')),error=>error.status===400,'"Filtros inválidos!"');
 // Ajustes: audited, versioned, per user.
 const command=randomUUID(),body={command_id:command,expected_version:0,purchase_statuses:['open'],sales_statuses:['fulfilled','open']};
 const saved=await api('/v1/estoque/painel/ajustes',f.users.vendas,body);assert.deepEqual([saved.preference.version,saved.preference.sales_statuses],[1,['fulfilled','open']]);
 assert.equal((await api('/v1/estoque/painel/ajustes',f.users.vendas,body)).replayed,true);
 await assert.rejects(api('/v1/estoque/painel/ajustes',f.users.vendas,{...body,command_id:randomUUID()}),error=>error.status===400||error.code==='40001'||error.status===409);
 assert.equal((await api('/v1/estoque/painel/ajustes',f.users.consulta)).preference.version,0,'another user keeps the defaults');
 await assert.rejects(f.rpc('erp_stock_dashboard_preference_set',{p_user_id:f.users.vendas,p_command_id:randomUUID(),p_expected_version:1,p_purchase_statuses:['open','open'],p_sales_statuses:['open']}),fails('22023'));
 await assert.rejects(f.db.query('delete from erp_stock.dashboard_preference'),error=>/immutable/.test(error.message));
 assert.ok(today>='2026-10-20');
});

test('107 composed handler: GET dashboards through the authenticated worker',async()=>{
 const USER='a3000000-0000-4000-8000-000000000001',env={SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',ALLOWED_ORIGINS:'https://erp.example.test'};
 const value=await f.rpc('erp_stock_dashboard_idle',{p_user_id:f.users.vendas,p_since:'2026-10-01',p_page:1,p_size:100});const calls=[];
 const handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(JSON.stringify(url.endsWith('/user')?{id:USER}:value),{status:200});}});
 const response=await handler(new Request('https://api.example.test/v1/estoque/painel/sem-movimentacao?data=2026-10-01',{headers:{Authorization:'Bearer synthetic-user'}}),env);
 assert.equal(response.status,200);assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_stock_dashboard_idle'));assert.deepEqual(JSON.parse(calls[1].body),{p_since:'2026-10-01',p_page:1,p_size:100,p_user_id:USER});
});

test('107 Atalhos favoritos: the new stock screens join the 097 catalog in menu order, with the menu permissions',async()=>{
 const {HOME_SHORTCUTS}=await import('../src/home.mjs');
 const all=(await f.db.query('select path v from erp_home.shortcut_catalog() order by ordinal')).rows.map(row=>row.v);
 // Migration 152 (preferências lane) regenerates the catalog from the menu later, in the menu order of that day (Cadastros >
 // Contas Financeiras now opens the registry, so Caixas e bancos holds the extrato path); every 107 shortcut stays in it.
 // Wave D: Financeiro > Remessas e retornos and Ver relatórios financeiros open the Origin-structured screens, so these two 107 paths left the menu.
 // Wave E: Estoque > Notas fiscais de entrada opens the Origin purchase notes (/notas-entrada, with the Notas recebidas tab).
 const RETIRED=['/cobranca-operacional','/relatorio-vencimentos','/notas-recebidas'];
 assert.deepEqual(all.filter(path=>!Object.hasOwn(HOME_SHORTCUTS,path)&&!RETIRED.includes(path)),[],'every other 107 shortcut is still a worker shortcut');assert.equal(all.length,21);
 for(const [role,expected]of[['estoque',true],['admin',true],['consulta',false],['vendas',false]])
  assert.equal((await f.scalar('select erp_home.shortcut_allowed($1,$2)v',[role,'/conferencia-estoque-empresa'])),expected,role);
 for(const role of['admin','consulta','vendas','estoque','fiscal'])assert.equal(await f.scalar('select erp_home.shortcut_allowed($1,$2)v',[role,'/painel-produtos-empresa?painel=sugestao']),role!=='vendas',role);
 assert.equal(await f.scalar('select erp_home.shortcut_allowed($1,$2)v',['vendas','/painel-produtos-empresa']),true);
 assert.equal(await f.scalar('select erp_home.shortcut_allowed($1,$2)v',['financeiro','/painel-produtos-empresa']),false);
});

test('107 Sugestão de Compras with Reserva = Sim: the reserved quantity leaves Estoque Atual and raises the suggestion; ignored warehouses stay out',async()=>{
 const pen=await f.catalog('products',{name:'Caneta reservada',code:'RES-1',unit:'UN',kind:'P',format:'S',price:'3'});
 await f.launch(pen.id,s.a.id,'receipt','10');await f.launch(pen.id,s.b.id,'receipt','4');
 const reserve=async target=>{const sale=await f.order('sales_orders',[{product_id:pen.id,description:'Caneta reservada',unit:'UN',quantity:target===s.a.id?'6':'1',unit_price:'3'}],target);
  const preview=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_reservation_id:null,p_reservation_version:null})).preview;
  await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:preview.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});};
 // 6 reserved in Geral; 1 reserved in Avarias, which is desconsiderado and never enters "Todos".
 await reserve(s.a.id);await reserve(s.b.id);
 const sales=(await api('/v1/estoque/painel/ajustes',f.users.estoque)).preference.sales_statuses.join(',');
 const path=answer=>`/v1/estoque/painel/sugestao?de=2026-10-01&ate=2026-10-30&cobertura=60&compras=open&vendas=${sales}&reserva=${answer}`;
 const find=async(answer,extra='')=>(await api(`${path(answer)}${extra}`,f.users.estoque)).items.find(item=>item.product_id===pen.id);
 const without=await find('nao'),withReserve=await find('sim');
 // 7 sold in 30 days (6 + 1), coverage 60 -> 14; Todos considers only Geral (10): 14 - 10 = 4; Reserva = Sim: 14 - (10 - 6) = 10.
 assert.deepEqual([without.sold,without.stock,without.reserved,without.suggestion],['7.000000','10.000000','0.000000','4']);
 assert.deepEqual([withReserve.stock,withReserve.reserved,withReserve.suggestion],['10.000000','6.000000','10'],'the Avarias reservation stays out of Todos');
 const onlyB=await find('sim',`&warehouse_id=${s.b.id}`);
 assert.deepEqual([onlyB.sold,onlyB.stock,onlyB.reserved,onlyB.suggestion],['1.000000','4.000000','1.000000','0'],'a filtered warehouse uses its own balance and reservations');
});
