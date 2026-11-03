import test from'node:test';import assert from'node:assert/strict';
import{laneCFixture,fails}from'./helpers/preferences-c-fixture.mjs';
import{captureBusinessQuery,businessArgs,parseBusinessPanel,BUSINESS_RPC}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{parseStorage}from'../../../packages/erp-domain/src/system-profile.mjs';

// 188 (not applied yet): the alíquota de imposto of Meu Negócio › Ajustes and the storage limit of Espaço e armazenamento, on
// every migration applied in production plus wave C. One synthetic company: a purchase price for the pen, two orders in October.
async function company(){
 const f=await laneCFixture();
 const a=await f.catalog('contacts',{name:'Cliente Alfa',state:'SP'}),b=await f.catalog('contacts',{name:'Cliente Beta',state:'RJ'});
 const pen=await f.catalog('products',{name:'Caneta azul',code:'CAN-1',unit:'UN',kind:'P',format:'S',price:'3'}),pencil=await f.catalog('products',{name:'Lápis',code:'LAP-1',unit:'UN',kind:'P',format:'S',price:'1'});
 await f.document('purchase_orders',{contact:b.id,date:'2026-10-01',items:[{product_id:pen.id,description:'Caneta azul',quantity:'10',unit_price:'1.25'}]});
 await f.document('sales_orders',{contact:a.id,date:'2026-10-10',statuses:['verified'],body:{freight:'5'},items:[{product_id:pen.id,description:'Caneta azul',quantity:'2',unit_price:'3'},{product_id:pencil.id,description:'Lápis',quantity:'5',unit_price:'1'}]});
 await f.document('sales_orders',{contact:b.id,date:'2026-10-12',statuses:['in_progress'],items:[{product_id:pen.id,description:'Caneta azul',quantity:'4',unit_price:'2.5'}]});
 return{...f,pen,pencil};
}
const S='verified,in_progress,fulfilled';
async function panel(f,name,input,user=f.users.admin){const q=captureBusinessQuery(name,input);return parseBusinessPanel(await f.rpc(BUSINESS_RPC[name],{p_user_id:user,...businessArgs(q)}),q);}

test('188 IMPOSTOS and LUCRO follow the alíquota of Ajustes; without it the taxes are zero; profit only for cost readers',async()=>{const f=await company();try{
 const before=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 // Revenue without freight 21.00 (11.00 + 10.00); cost 7.50 (6 pens × 1.25); no alíquota yet.
 assert.deepEqual(before.indicators,{revenue_without_freight:'21.00',cost:'7.50',gross_margin:'13.50',gross_margin_pct:'64.29',lines_without_cost:1,taxes:'0.00',fees:null,profit:'13.50'});
 await f.preference('meu-negocio','negocio.aliquota_imposto','10.5');
 const v=await panel(f,'mensal',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 // Per order, half up: 11.00 × 10.5% = 1.155 → 1.16; 10.00 × 10.5% = 1.05.
 assert.equal(v.indicators.taxes,'2.21');assert.equal(v.indicators.profit,'11.29');
 const vendas=await panel(f,'diario',{situacoes:S,dia:'2026-10-12'},f.users.vendas);assert.deepEqual([vendas.indicators.taxes,vendas.indicators.profit,vendas.indicators.cost],['1.05',null,null]);
 // Margem por Pedido: contribution = revenue − cost − tax; the order with a pencil (no cost) stays out.
 const m=await panel(f,'margem-pedido',{situacoes:S,de:'2026-10-01',ate:'2026-10-31',aba:'todos'});
 assert.equal(m.indicators.taxes,'2.21');const o2=m.orders.find(o=>o.revenue==='10.00');assert.equal(o2.contribution,'3.95');assert.equal(m.indicators.contribution,'3.95');
 // Vendas por canal: Impostos and Margem Contribuição %.
 const o=await panel(f,'pedidos-venda',{situacoes:S,de:'2026-10-01',ate:'2026-10-31'});
 assert.deepEqual(o.by_channel.map(c=>[c.channel,c.taxes,c.contribution_pct]),[['Pedido Manual','2.21',null]]);
 const only=await panel(f,'pedidos-venda',{situacoes:'in_progress',de:'2026-10-01',ate:'2026-10-31'});assert.deepEqual(only.by_channel.map(c=>[c.taxes,c.contribution_pct]),[['1.05','39.50']]);
 const seller=await panel(f,'pedidos-venda',{situacoes:'in_progress',de:'2026-10-01',ate:'2026-10-31'},f.users.vendas);assert.deepEqual(seller.by_channel.map(c=>[c.taxes,c.contribution_pct,c.cost]),[['1.05',null,null]]);
 await fails(assert,()=>f.preference('meu-negocio','negocio.aliquota_imposto','100.01'),'22023');
}finally{await f.close();}});

test('188 Espaço e armazenamento: the limit set by the administrador comes back in bytes; 0 means no limit',async()=>{const f=await laneCFixture();try{
 await f.db.query("insert into storage.objects(bucket_id,name,metadata) values('erp-attachments','a.pdf','{\"size\":\"1024\"}')");
 const free=parseStorage(await f.rpc('erp_access_storage',{p_user_id:f.users.vendas}));assert.equal(free.limit_bytes,null);
 await f.preference('empresa-armazenamento','armazenamento.limite_gb',2);
 const limited=parseStorage(await f.rpc('erp_access_storage',{p_user_id:f.users.vendas}));assert.deepEqual([limited.total_bytes,limited.limit_bytes,limited.groups],['1024','2147483648',null]);
 await fails(assert,()=>f.preference('empresa-armazenamento','armazenamento.limite_gb',2,f.users.vendas),'42501');
 await f.preference('empresa-armazenamento','armazenamento.limite_gb',0);assert.equal(parseStorage(await f.rpc('erp_access_storage',{p_user_id:f.users.admin})).limit_bytes,null);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_access_storage(uuid)','execute') v`),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_home_business_margin(uuid,jsonb,date,date,text)','execute') v"),true);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_home.biz_tax_rate()','execute') v"),false);
}finally{await f.close();}});

test('188 stops when a function it replaces is not the expected version',async()=>{const f=await laneCFixture({before:'202610200188'});try{
 await f.db.exec("create or replace function erp_home.biz_indicators(p_from date,p_to date,p_statuses text[],p_cost boolean) returns jsonb language sql stable set search_path=pg_catalog as $body$ select '{}'::jsonb $body$;");
 await assert.rejects(()=>f.migrate('202610200188_business_settings.sql'),e=>e.code==='55000'&&/business_settings_188_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
