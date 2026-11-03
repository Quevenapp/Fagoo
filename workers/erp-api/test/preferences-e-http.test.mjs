import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{parsePreferencesRoute as parse,preferencesMethods,executePreferencesRoute}from'../src/preferences.mjs';
import{REPORT_BASES,REPORT_BASES_230,parseReports}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{capturePreferencesSave}from'../../../packages/erp-domain/src/preferences/dto.mjs';
import{captureBusinessQuery,parseBusinessPanel}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{IMPORT_SLUGS,importKindOf}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';
import{createHandler}from'../src/index.mjs';

// Wave E routes of Preferências, Sistema and Meu Negócio (262-266). Synthetic data only.
const ACTOR='10000000-0000-4000-8000-000000000265',PRODUCT='30000000-0000-4000-8000-000000000265';
const req=(path,init)=>new Request('https://synthetic.invalid'+path,init);
const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('264 the Prefixo GS1 is captured with the digits format before the database; the report catalog keeps the older answers',async()=>{
 const change=value=>({command_id:randomUUID(),changes:[{key:'produtos.ean_prefixo',expected_version:0,value}]});
 for(const bad of['789123','789123456789','78912a4',' 7891234'])assert.throws(()=>capturePreferencesSave(change(bad),'cadastros-produtos'),e=>e.status===400,bad);
 for(const good of['','7891234','78912345678'])assert.equal(capturePreferencesSave(change(good),'cadastros-produtos').changes[0].value,good);
 const route=await parse(req('/v1/preferencias/cadastros-produtos',json(change('7891234'))));assert.equal(route.rpc,'erp_preferences_save');
 await assert.rejects(()=>parse(req('/v1/preferencias/cadastros-produtos',json(change('12')))),e=>e.status===400);
 assert.deepEqual(REPORT_BASES.slice(11,16).map(b=>[b.base,b.group,b.title]),[['recebimentos','financas','Recebimentos'],['pagamentos','financas','Pagamentos'],['venda_parcela','vendas','Venda Parcela'],
  ['comissoes','financas','Comissões'],['caixa','financas','Caixa']]);
 const older={scope:'reports',data_mode:'erp_native',can_manage:false,bases:JSON.parse(JSON.stringify(REPORT_BASES_230)),reports:[],directory:null};assert.equal(parseReports(older).bases.length,11);
 const swapped={...older,bases:JSON.parse(JSON.stringify([REPORT_BASES[12],REPORT_BASES[11]]))};assert.throws(()=>parseReports(swapped),e=>e.status===502,'the catalog order');
});

test('265 Previsão de Estoque: modo is strict, the panel receives p_mode and the answer carries the mode and the composição',async()=>{
 const route=await parse(req('/v1/meu-negocio/previsao-estoque?de=2026-10-01&ate=2026-10-20&reserva=nao&modo=desmembrados'));
 assert.equal(route.rpc,'erp_home_business_panel');assert.deepEqual(route.args.p_args,{p_from:'2026-10-01',p_to:'2026-10-20',p_warehouse_id:null,p_reserve:false,p_mode:'desmembrados'});
 assert.equal((await parse(req('/v1/meu-negocio/previsao-estoque?de=2026-10-01&ate=2026-10-20&reserva=sim'))).args.p_args.p_mode,'itens','default: Variações + Simples + Composições');
 for(const path of['/v1/meu-negocio/previsao-estoque?de=2026-10-01&ate=2026-10-20&reserva=sim&modo=produtos','/v1/meu-negocio/previsao-estoque?de=2026-10-01&ate=2026-10-20&reserva=sim&modo=desmembrados&modo=itens'])
  await assert.rejects(()=>parse(req(path)),e=>e.status===400,path);
 const q=captureBusinessQuery('previsao-estoque',{de:'2026-10-20',ate:'2026-10-20',reserva:'nao',modo:'desmembrados'});
 const answer=(mode,composition,from='2026-10-20')=>({scope:'business_dashboard',data_mode:'erp_native',panel:'previsao-estoque',role:'admin',as_of:'2026-10-20T12:00:00Z',business_date:'2026-10-20',cost_visible:true,stock_visible:true,
  filters:{statuses:['fulfilled'],from,to:'2026-10-20',warehouse_id:null,reserve:false,mode},turnover:[{product_id:PRODUCT,code:'A',name:'Componente',sold:'1.000000',per_day:'1.000000',stock:'2.000000',composition,coverage_days:2}],
  by_channel:[],by_day:Array.from({length:21-Number(from.slice(8))},(_,i)=>({day:`2026-10-${String(Number(from.slice(8))+i).padStart(2,'0')}`,units:'1.000000',total:'1.00'}))});
 assert.equal(parseBusinessPanel(answer('desmembrados',null),q).filters.mode,'desmembrados');
 assert.throws(()=>parseBusinessPanel(answer('itens',null),q),e=>e.status===502,'another mode');
 assert.throws(()=>parseBusinessPanel(answer('desmembrados','kit'),q),e=>e.status===502,'an unknown composição type');
 const out=await executePreferencesRoute(route,{userId:ACTOR,rpc:async(name,args)=>{assert.equal(name,'erp_home_business_panel');assert.equal(args.p_args.p_mode,'desmembrados');return answer('desmembrados','virtual','2026-10-01');}});
 assert.equal(out.turnover[0].composition,'virtual');
});

test('265 Importações de composições, campos customizados and fornecedores de produtos have strict batch routes',async()=>{
 assert.deepEqual([IMPORT_SLUGS.compositions,IMPORT_SLUGS.custom_fields,IMPORT_SLUGS.product_suppliers],['composicoes','campos-customizados','fornecedores-produtos']);
 assert.equal(importKindOf('fornecedores-produtos'),'product_suppliers');
 for(const slug of['composicoes','campos-customizados','fornecedores-produtos'])assert.deepEqual(preferencesMethods(`/v1/importacoes/${slug}/lote`),['POST']);
 const body={command_id:null,job_id:null,file_name:'composicoes.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2,3],data:{code:'KIT-1',stock_type:'virtual',items:[{code:'A',quantity:'2'},{code:'B',quantity:'0.5'}]}}]};
 const route=await parse(req('/v1/importacoes/composicoes/lote',json(body)));assert.equal(route.args.p_kind,'compositions');assert.equal(route.mutation,false);
 for(const broken of[{...body,items:[{...body.items[0],data:{...body.items[0].data,stock_type:'kit'}}]},{...body,items:[{...body.items[0],lines:[2]}]},
  {...body,items:[{...body.items[0],data:{code:'KIT-1',stock_type:'virtual',items:[{code:'A',quantity:'0'},{code:'B',quantity:'1'}]}}]}])
  await assert.rejects(()=>parse(req('/v1/importacoes/composicoes/lote',json(broken))),e=>e.status===400);
 const fields={command_id:randomUUID(),job_id:randomUUID(),file_name:'campos.csv',total_rows:1,dry_run:false,items:[{row:2,lines:[2],data:{code:'P-1',items:[{field:'Cor',value:'Azul'}]}}]};
 assert.equal((await parse(req('/v1/importacoes/campos-customizados/lote',json(fields)))).mutation,true);
 await assert.rejects(()=>parse(req('/v1/importacoes/campos-customizados/lote',json({...fields,items:[{row:2,lines:[2],data:{code:'P-1',items:[{field:'Cor'}]}}]}))),e=>e.status===400);
 const suppliers={command_id:null,job_id:null,file_name:'f.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{code:'P-1',supplier_document:'11222333000181',purchase_price:'4.5',is_default:true}}]};
 assert.equal((await parse(req('/v1/importacoes/fornecedores-produtos/lote',json(suppliers)))).args.p_kind,'product_suppliers');
 await assert.rejects(()=>parse(req('/v1/importacoes/fornecedores-produtos/lote',json({...suppliers,items:[{row:2,lines:[2],data:{code:'P-1',warranty_months:'1000',supplier_name:'X'}}]}))),e=>e.status===400);
});

const env={SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-265',ALLOWED_ORIGINS:'https://erp.synthetic.test'},headers={Authorization:'Bearer synthetic-token',Origin:'https://erp.synthetic.test'};
test('262 the logo route of the real API: strict methods and never an upstream error text',async()=>{
 const h=createHandler({fetchImpl:async url=>new URL(url).pathname==='/auth/v1/user'?Response.json({id:ACTOR}):Response.json({code:'42501',message:'PRIVATE'},{status:403})});
 const r=await h(new Request('https://api.synthetic.test/v1/anexos-empresa/logo',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),mime_type:'image/png',size_bytes:10,sha256:'a'.repeat(64)})}),env);
 assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/PRIVATE/);
 const put=await h(new Request('https://api.synthetic.test/v1/anexos-empresa/logo',{method:'PUT',headers}),env);assert.equal(put.status,405);
 const unknown=await h(new Request(`https://api.synthetic.test/v1/anexos-empresa/logo/${PRODUCT}/apagar`,{method:'POST',headers}),env);assert.ok([404,405].includes(unknown.status));assert.doesNotMatch(await unknown.text(),/PRIVATE/);
});
