import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneEFixture,fails}from'./helpers/preferences-e-fixture.mjs';
// 284 (wave F) adds bases after these 16: the wave E database keeps the 264 catalog.
import{REPORT_BASES_264 as REPORT_BASES,sameJson,parseReports,captureReportRun,parseReportRows}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{STORED_PREFERENCE_PAGES}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{definitionRows,preferenceValueValid,storedFields}from'../../../packages/erp-domain/src/preferences/core.mjs';
import{PERMISSION_KEYS,permissionStatus}from'../../../packages/erp-domain/src/user-permissions.mjs';

// Wave E of Preferências, Sistema e Empresa: migration 264 (relatórios, permissões das telas desta frente e o formato "digits").
// Synthetic data only.
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
const KEYS=PERMISSION_KEYS.filter(k=>permissionStatus(k)!=='admin');
/** Saves the access controls of a user with every permission except `without` (and their sub-permissions). */
async function restrict(f,user,without){
 const keep=KEYS.filter(k=>!without.some(w=>k===w||k.startsWith(`${w}.`)));
 await f.db.query("insert into erp_access.user_control(user_id,permissions,version,updated_at,updated_by) values($1,$2,1,clock_timestamp(),$3) on conflict(user_id) do update set permissions=excluded.permissions,version=erp_access.user_control.version+1",[user,keep,f.users.admin]);
}
const run=async(f,user,base,columns,{filters=[],view_limit=2000}={})=>{const input=captureReportRun({base,columns,filters,view_limit,offset:0,page:200});
 return parseReportRows(await f.rpc('erp_preferences_report_run',{p_user_id:user,p_base:base,p_columns:columns,p_filters:filters,p_view_limit:view_limit,p_offset:0,p_page:200}),input);};

test('264 replaces only the applied definitions and stops on a Prefixo GS1 that is not 7 to 11 digits',async()=>{
 const f=await laneEFixture({before:'202610200264'});try{
  await f.db.exec("create or replace function erp_preferences.report_cents_probe() returns int language sql as $$ select 1 $$");
  await f.preference('cadastros-produtos','produtos.ean_prefixo','ABC123');
  await assert.rejects(()=>f.migrate('202610200264_reports_permissions_digits.sql'),e=>e.code==='55000'&&/preferences_264_ean_prefix_invalid/.test(e.message));
  await f.db.exec('rollback');
  await f.db.exec("create or replace function erp_preferences.report_allowed(p_role text,p_base text) returns boolean language sql stable set search_path=pg_catalog as $$ select true $$");
  await assert.rejects(()=>f.migrate('202610200264_reports_permissions_digits.sql'),e=>e.code==='55000'&&/preferences_264_previous_definition_changed erp_preferences.report_allowed/.test(e.message));
 }finally{await f.close();}
});

test('264 Prefixo GS1 da empresa: the format "digits" (7 to 11) is the same in the page schema, the API and the database',async()=>{const f=await laneEFixture();try{
 const page=STORED_PREFERENCE_PAGES.find(p=>p.id==='cadastros-produtos'),field=storedFields(page).find(x=>x.key==='produtos.ean_prefixo');
 const row=(await f.db.query("select key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format,min_length from erp_preferences.definition where key='produtos.ean_prefixo'")).rows[0];
 assert.deepEqual(row,{...definitionRows(page).find(r=>r.key==='produtos.ean_prefixo')});
 assert.deepEqual([row.format,row.min_length,row.max_length],['digits',7,11]);
 for(const value of['','7891234','78912345678','789123','789123456789','78912 34','7891234a',' 7891234','x',0,null,'０１２３４５６７'])
  assert.equal(await f.scalar('select erp_preferences.value_valid(d,$1::jsonb) v from erp_preferences.definition d where d.key=$2',[value===null?null:JSON.stringify(value),'produtos.ean_prefixo']),preferenceValueValid(field,value),JSON.stringify(value));
 await fails(assert,()=>f.preference('cadastros-produtos','produtos.ean_prefixo','789123'),'22023');
 const saved=await f.preference('cadastros-produtos','produtos.ean_prefixo','7891234');assert.equal(saved.receipt.changes[0].after,'7891234');
 assert.equal(await f.scalar("select count(*)::integer v from erp_preferences.definition where format is not null and min_length is not null"),1);
 await assert.rejects(()=>f.db.query("update erp_preferences.definition set min_length=3 where key='financas.cobranca_remetente'"),e=>e.code==='23514','min_length only with digits');
}finally{await f.close();}});

test('264 Espaço Meu Contador and Central de Notificações follow the permission; the administrador and a user without saved permissions keep them',async()=>{const f=await laneEFixture();try{
 const read=user=>f.rpc('erp_preferences_page',{p_user_id:user,p_page:'contabilidade-contador'});
 assert.equal((await read(f.users.financeiro)).page,'contabilidade-contador','no saved set: everything of the profile');
 await restrict(f,f.users.financeiro,['contabilidade.meu_contador']);
 await fails(assert,()=>read(f.users.financeiro),'42501');
 assert.equal((await read(f.users.admin)).page,'contabilidade-contador');
 await restrict(f,f.users.fiscal,['preferencias.central_notificacoes']);
 await fails(assert,()=>f.rpc('erp_preferences_page',{p_user_id:f.users.fiscal,p_page:'central-notificacoes'}),'42501');
 assert.equal((await read(f.users.fiscal)).page,'contabilidade-contador','the other pages are not affected');
 assert.equal((await f.rpc('erp_preferences_page',{p_user_id:f.users.fiscal,p_page:'cadastros-produtos'})).page,'cadastros-produtos');
}finally{await f.close();}});

test('264 Empresa: "Acesso aos dados da empresa" opens the screen; the identity stays readable for the prints',async()=>{const f=await laneEFixture();try{
 assert.equal((await f.rpc('erp_company_access',{p_user_id:f.users.financeiro})).read_identity,true);
 await restrict(f,f.users.financeiro,['outros.dados_empresa']);
 await fails(assert,()=>f.rpc('erp_company_access',{p_user_id:f.users.financeiro}),'42501');
 await fails(assert,()=>f.rpc('erp_company_extra_get',{p_user_id:f.users.financeiro}),'42501');
 assert.equal((await f.rpc('erp_company_get',{p_user_id:f.users.financeiro,p_section:'identity'})).section,'identity');
 assert.equal((await f.rpc('erp_company_access',{p_user_id:f.users.admin})).write_identity,true);
}finally{await f.close();}});

async function financeSeed(f){
 const customer=await f.catalog('contacts',{name:'Cliente Sintético Relatórios'}),supplier=await f.catalog('contacts',{name:'Fornecedor Sintético Relatórios'});
 const caixa=(await f.rpc('erp_finance_account_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'account_create',p_data:{account_type:'cash',name:'Caixa sintético',start_on:'2020-01-01',opening_cents:'0'}})).record;
 const title=async(kind,contact,cents)=>(await f.rpc('erp_finance_title_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_create',p_data:{kind,contact_id:contact,description:kind==='receivable'?'Venda sintética':'Compra sintética',
  issued_on:'2026-03-01',competence_on:'2026-03-01',total_cents:cents,installments:[{amount_cents:cents,due_on:'2026-03-10'}]}})).items[0];
 const receivable=await title('receivable',customer.id,'10000'),payable=await title('payable',supplier.id,'4000');
 await f.rpc('erp_finance_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'settle',p_data:{id:receivable.id,expected_version:receivable.version,account_id:caixa.id,posted_on:'2026-03-11',principal_cents:'10000',interest_cents:'150',discount_cents:'50'}});
 await f.rpc('erp_finance_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'settle',p_data:{id:payable.id,expected_version:payable.version,account_id:caixa.id,posted_on:'2026-03-12',principal_cents:'4000'}});
 await f.rpc('erp_finance_cash_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'entry_save',p_data:{account_id:caixa.id,kind:'out',amount_cents:'1200',posted_on:'2026-03-13',competence_on:'2026-03-13',note:'Lançamento sintético',expected_version:0}});
 const seller=(await f.rpc('erp_catalog_seller_from_contact',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_contact_id:customer.id})).seller.id;
 await f.rpc('erp_finance_commission_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'commission_manual',p_data:{seller_id:seller,due_on:'2026-03-20',credit_on:'2026-03-20',parcel_cents:'10000',rate:'5'}});
 const product=await f.catalog('products',{name:'Produto Sintético Parcela',code:'PAR-1',unit:'UN',kind:'P',format:'S',price:'100'});
 const order=await f.document('sales_orders',{contact:customer.id,items:[{product_id:product.id,description:'Produto Sintético Parcela',quantity:'1',unit_price:'100'}],
  body:{installments:[{due_date:'2026-04-10',amount:'60.00',method:'Boleto'},{due_date:'2026-05-10',amount:'40.00',method:'Boleto'}]}});
 return{customer,supplier,caixa,order};
}

test('264 PRF-241 Recebimentos, Pagamentos, Venda Parcela, Comissões and Caixa: same catalog as the API, exact values and the readers of each module',async()=>{const f=await laneEFixture();try{
 assert.ok(sameJson(await f.scalar('select erp_preferences.report_catalog() v'),JSON.parse(JSON.stringify(REPORT_BASES))));
 const s=await financeSeed(f);
 const bases=async user=>parseReports(await f.rpc('erp_preferences_reports',{p_user_id:user})).bases.map(b=>b.base);
 assert.deepEqual((await bases(f.users.financeiro)).filter(b=>['recebimentos','pagamentos','comissoes','caixa','venda_parcela'].includes(b)),['recebimentos','pagamentos','venda_parcela','comissoes','caixa']);
 assert.deepEqual((await bases(f.users.estoque)).filter(b=>['recebimentos','pagamentos','comissoes','caixa','venda_parcela'].includes(b)),['venda_parcela'],'the stock profile reads the sales orders, not the finance');
 assert.deepEqual((await bases(f.users.vendas)).filter(b=>['recebimentos','pagamentos','comissoes','caixa','venda_parcela'].includes(b)),['venda_parcela']);
 const rec=await run(f,f.users.financeiro,'recebimentos',['data','contato','valor','juros','desconto','liquido','situacao','conta']);
 assert.deepEqual(rec.rows,[['2026-03-11','Cliente Sintético Relatórios','101.00','1.50','0.50','101.00','Recebido','Caixa sintético']]);assert.deepEqual(rec.totals,{valor:'101.00',juros:'1.50',desconto:'0.50',liquido:'101.00'});
 const pay=await run(f,f.users.financeiro,'pagamentos',['data','contato','valor','situacao']);assert.deepEqual(pay.rows,[['2026-03-12','Fornecedor Sintético Relatórios','40.00','Pago']]);
 const parcel=await run(f,f.users.vendas,'venda_parcela',['numero','parcela','vencimento','valor','forma']);
 assert.deepEqual(parcel.rows,[[String(s.order.number),'1/2','2026-04-10','60.00','Boleto'],[String(s.order.number),'2/2','2026-05-10','40.00','Boleto']]);assert.deepEqual(parcel.totals,{valor:'100.00'});
 const com=await run(f,f.users.financeiro,'comissoes',['vendedor','origem','parcela','aliquota','comissao','liberada','situacao']);
 assert.deepEqual(com.rows,[['Cliente Sintético Relatórios','Manual','100.00','5','5.00','2026-03-20','Liberada']]);
 const cash=await run(f,f.users.financeiro,'caixa',['data','descricao','tipo','entrada','saida'],{filters:[{column:'tipo',value:'Lançamento'}]});
 assert.deepEqual(cash.rows,[['2026-03-13','Lançamento sintético','Lançamento',null,'12.00']]);
 const all=await run(f,f.users.financeiro,'caixa',['tipo','entrada','saida']);
 assert.deepEqual(all.rows.map(r=>r[0]).sort(),['Lançamento','Pagamento','Recebimento','Saldo inicial'].sort());assert.deepEqual(all.totals,{entrada:'101.00',saida:'52.00'});
 await fails(assert,()=>run(f,f.users.vendas,'caixa',['data']),'42501');
 await restrict(f,f.users.estoque,['vendas.pedidos_venda']);
 await fails(assert,()=>run(f,f.users.estoque,'venda_parcela',['numero']),'42501');
 await fails(assert,()=>run(f,f.users.estoque,'recebimentos',['data']),'42501');
}finally{await f.close();}});

test('264 Relatórios customizados follow "Relatórios customizados" and the permission of the module of each base',async()=>{const f=await laneEFixture();try{
 await financeSeed(f);
 await restrict(f,f.users.financeiro,['financas.contas_receber']);
 const visible=parseReports(await f.rpc('erp_preferences_reports',{p_user_id:f.users.financeiro})).bases.map(b=>b.base);
 assert.ok(!visible.includes('recebimentos')&&!visible.includes('contas_receber')&&visible.includes('pagamentos'));
 await fails(assert,()=>run(f,f.users.financeiro,'recebimentos',['data']),'42501');
 assert.equal((await run(f,f.users.financeiro,'pagamentos',['data'])).rows.length,1);
 await restrict(f,f.users.financeiro,['outros.relatorios_customizados']);
 await fails(assert,()=>f.rpc('erp_preferences_reports',{p_user_id:f.users.financeiro}),'42501');
 await fails(assert,()=>run(f,f.users.financeiro,'pagamentos',['data']),'42501');
 assert.ok(parseReports(await f.rpc('erp_preferences_reports',{p_user_id:f.users.admin})).bases.length===REPORT_BASES.length);
 for(const fn of['erp_preferences_reports(uuid)','erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)','erp_company_access(uuid)','erp_company_extra_get(uuid)'])
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,['public.'+fn]),false,`${role} ${fn}`);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.report_source(text)','EXECUTE') v"),false);
}finally{await f.close();}});
