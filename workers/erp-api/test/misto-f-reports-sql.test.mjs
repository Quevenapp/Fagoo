import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoFixture,fails}from'./helpers/misto-f-fixture.mjs';
import{REPORT_BASES,REPORT_BASES_264,sameJson,parseReports,captureReportRun,parseReportRows}from'../../../packages/erp-domain/src/reports-labels.mjs';

// Synthetic data only. 284 (PRF-241): the other standard reports of Origin (Curva ABC, Pessoas de Contato, Fichas Financeiras, Ocorrências,
// Transporte por Nota Fiscal e por Venda) and the Situação Devolvido of the contas.
let f,customer;
const run=async(base,columns=null,user=f.users.admin,filters=[])=>{const b=REPORT_BASES.find(x=>x.base===base);
 const input=captureReportRun({base,columns:columns??b.columns.map(c=>c.id),filters,view_limit:2000,offset:0,page:200});
 const rows=parseReportRows(await f.rpc('erp_preferences_report_run',{p_user_id:user,p_base:base,p_columns:input.columns,p_filters:input.filters,p_view_limit:input.view_limit,p_offset:0,p_page:200}),input);
 return rows.rows.map(r=>Object.fromEntries(input.columns.map((c,i)=>[c,r[i]])));};
const order=async(items,{statuses=[],body={}}={})=>f.document('sales_orders',{contact:customer.id,items,statuses,body});
before(async()=>{f=await mistoFixture();customer=await f.catalog('contacts',{name:'Cliente Relatórios F',roles:['customer'],document:'11444777000161',person_type:'J'});});
after(async()=>f?.close());

test('284 the catalog is the domain one, every base private to its module and its permission; 264 keeps its 16 bases',async()=>{
 const before=await mistoFixture({before:'202610200284'});try{
  assert.ok(sameJson(await before.scalar('select erp_preferences.report_catalog() v'),JSON.parse(JSON.stringify(REPORT_BASES_264))));
  await before.db.exec("create or replace function erp_preferences.report_catalog() returns jsonb language sql immutable set search_path=pg_catalog as $$ select '[]'::jsonb $$;");
  await assert.rejects(()=>before.migrate('202610200284_custom_reports_wave_f.sql'),e=>e.code==='55000'&&/preferences_284_previous_definition_changed/.test(e.message));
 }finally{await before.close();}
 assert.ok(sameJson(await f.scalar('select erp_preferences.report_catalog() v'),JSON.parse(JSON.stringify(REPORT_BASES))));
 assert.equal(REPORT_BASES_264.length,16);assert.deepEqual(REPORT_BASES.slice(16).map(b=>b.title),['Curva ABC de itens de vendas','Pessoas de Contato','Ficha Financeira a Receber','Ficha Financeira a Pagar',
  'Ocorrências por Proposta Comercial','Ocorrências por Ordem de Serviço','Ocorrências por Venda','Transporte por Nota Fiscal','Transporte por Venda']);
 const bases=async user=>parseReports(await f.rpc('erp_preferences_reports',{p_user_id:user})).bases.map(b=>b.base);
 assert.equal((await bases(f.users.admin)).length,REPORT_BASES.length);
 const fin=await bases(f.users.financeiro);assert.ok(fin.includes('ficha_receber')&&fin.includes('ficha_pagar')&&!fin.includes('transporte_nota'));
 assert.ok(!(await bases(f.users.estoque)).includes('ficha_receber'),'estoque does not read the finance');
 const sales=await bases(f.users.vendas);assert.ok(sales.includes('curva_abc')&&sales.includes('ocorrencias_vendas')&&sales.includes('ocorrencias_propostas')&&sales.includes('transporte_venda')&&!sales.includes('ficha_receber')&&!sales.includes('transporte_nota'));
 assert.ok((await bases(f.users.fiscal)).includes('transporte_nota'));
 // Sistema › Usuários › Permissões: the Ficha Financeira needs "Ficha Financeira".
 await f.permissions(f.users.financeiro,['outros.relatorios_customizados','financas.contas_receber','financas.contas_pagar']);
 assert.ok(!(await bases(f.users.financeiro)).includes('ficha_receber'));
 await fails(assert,()=>run('ficha_receber',null,f.users.financeiro),'42501');
 await f.permissions(f.users.financeiro,null);
 await fails(assert,()=>run('transporte_nota',null,f.users.financeiro),'42501');
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_function_privilege($1,'erp_preferences.report_freight(text)','execute') v",[role]),false);
});

test('284 Curva ABC de itens de vendas: value of the pedidos (Em digitação and Cancelado left out), percent, accumulated and the class',async()=>{
 const p=async(code,price)=>f.catalog('products',{name:`Produto ${code}`,code,unit:'UN',kind:'P',format:'S',price});
 const a=await p('ABC-A','10'),b=await p('ABC-B','1'),c=await p('ABC-C','1');
 await order([{product_id:a.id,description:'A',quantity:'9',unit_price:'10'},{product_id:b.id,description:'B',quantity:'1.5',unit_price:'10'}]);
 await order([{product_id:c.id,description:'C',quantity:'5',unit_price:'1'},{product_id:b.id,description:'B',quantity:'1',unit_price:'1'}]);
 await order([{product_id:c.id,description:'C',quantity:'999',unit_price:'100'}],{statuses:['cancelled']});
 await order([{product_id:a.id,description:'A',quantity:'999',unit_price:'100'}],{statuses:['draft']});
 const rows=(await run('curva_abc')).filter(r=>r.codigo?.startsWith('ABC-'));
 assert.deepEqual(rows.map(r=>[r.classe,r.codigo,r.quantidade,r.valor,r.pedidos]),[['A','ABC-A','9','90.00','1'],['B','ABC-B','2.5','16.00','2'],['C','ABC-C','5','5.00','1']]);
 const all=await run('curva_abc');assert.equal(all.at(-1).acumulado,'100.00');
 assert.equal(rows[0].percentual,(90*100/all.reduce((s,r)=>s+Number(r.valor),0)).toFixed(2));
});

test('284 Pessoas de Contato, Fichas Financeiras with Devolvido, and the Contas with the Situação Devolvido',async()=>{
 const ana=await f.catalog('contacts',{name:'Ana Pessoa F',email:'ana@sintetico.test',phone:'19 3333-0000'});
 await f.rpc('erp_catalog_contact_save',{p_user_id:f.users.admin,p_id:customer.id,p_expected_version:await f.scalar('select version v from erp_catalog.record where id=$1',[customer.id]),p_command_id:randomUUID(),p_data:{persons:[ana.id]},p_acknowledged:null});
 assert.deepEqual((await run('pessoas_contato')).filter(r=>r.contato==='Cliente Relatórios F').map(r=>[r.documento,r.nome,r.email,r.telefone]),[['11444777000161','Ana Pessoa F','ana@sintetico.test','19 3333-0000']]);
 const title=async(cents,kind='receivable')=>(await f.rpc('erp_finance_title_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_create',p_data:{kind,contact_id:customer.id,
  description:'Conta da ficha F',issued_on:'2026-01-05',competence_on:'2026-01-05',total_cents:cents,installments:[{amount_cents:cents,due_on:'2099-01-31'}]}})).items[0];
 const open=await title('15000'),returned=await title('2500'),payable=await title('990','payable');
 await f.scalar('select erp_finance.titles_mark_returned($1,$2,$3::uuid[],$4::jsonb) is not null v',[f.users.vendas,randomUUID(),[returned.id],JSON.stringify({kind:'pos_return',id:'77'})]);
 const ficha=(await run('ficha_receber')).filter(r=>r.contato==='Cliente Relatórios F');
 assert.deepEqual(ficha.map(r=>[r.valor,r.pago,r.saldo,r.situacao]).sort(),[['150.00','0.00','150.00','Em aberto'],['25.00','0.00','0.00','Devolvido']].sort());
 assert.deepEqual((await run('ficha_pagar')).filter(r=>r.contato==='Cliente Relatórios F').map(r=>[r.valor,r.situacao]),[['9.90','Em aberto']]);
 assert.ok((await run('contas_receber')).some(r=>r.valor==='25.00'&&r.situacao==='Devolvido'));
 assert.ok(open.id&&payable.id);
});

test('284 Ocorrências por Venda / Proposta / OS and Transporte por Venda follow their documents',async()=>{
 const sale=await order([{description:'Item livre',quantity:'1',unit_price:'5'}],{body:{freight:'12.5',carrier_id:null,
  commercial:{introduction:null,attention_to:null,seller_reference:null,store_reference:null,business_unit_reference:null,
   transport:{freight_mode:'1',volume_count:'3',gross_weight:'7.25',delivery_days:'4',carrier_reference:{system:'origin',source_id:'55',label:'Transportadora Sintética'},service_reference:null,tracking_code:'BR123'}}}});
 const now=await f.scalar("select to_char(clock_timestamp() at time zone 'America/Sao_Paulo','YYYY-MM-DD') v");
 await f.rpc('erp_document_occurrence_add',{p_user_id:f.users.admin,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_occurred_on:now,p_occurred_time:'10:00',
  p_text:'Cliente pediu entrega à tarde',p_status:null,p_next_contact:null});
 const occurrences=(await run('ocorrencias_vendas')).filter(r=>r.numero===String(sale.number));
 assert.deepEqual(occurrences.map(r=>[r.ocorrencia,r.situacao,r.data]),[['Cliente pediu entrega à tarde','Em aberto',now]]);
 assert.ok(!('proximo_contato' in occurrences[0]));
 const proposal=await f.document('sales_proposals',{contact:customer.id,items:[{description:'Serviço',quantity:'1',unit_price:'9'}]});
 await f.rpc('erp_document_occurrence_add',{p_user_id:f.users.admin,p_kind:'sales_proposals',p_document_id:proposal.id,p_expected_version:proposal.version,p_command_id:randomUUID(),p_occurred_on:now,p_occurred_time:'11:30',
  p_text:'Retornar em breve',p_status:null,p_next_contact:'2099-02-01'});
 const prop=(await run('ocorrencias_propostas')).find(r=>r.numero===String(proposal.number));assert.deepEqual([prop.ocorrencia,prop.proximo_contato,prop.data],['Retornar em breve','2099-02-01',now]);assert.match(prop.hora,/^[0-2][0-9]:[0-5][0-9]$/);
 assert.equal((await run('ocorrencias_os')).length,0);
 const transport=(await run('transporte_venda')).find(r=>r.numero===String(sale.number));
 assert.deepEqual([transport.transportador,transport.frete,transport.valor_frete,transport.volumes,transport.peso_bruto,transport.prazo,transport.rastreamento],
  ['Transportadora Sintética','1 - Contratação do Frete por conta do Destinatário (FOB)','12.50','3','7.25','4','BR123']);
 assert.deepEqual((await run('transporte_venda',['numero','frete'],f.users.admin,[{column:'rastreamento',value:'BR123'}])).length,1);
 // Transporte por Nota Fiscal: an NF-e de saída of Brufap with its transport (the notas lane flow).
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$2::jsonb,$1) on conflict do nothing",[f.users.admin,JSON.stringify({state:'SP',cnpj:'11222333000181'})]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Venda relatório F',direction:'1',crt:'1'}}})).nature;
 const invoice=(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{orders:[],invoice:{model:'55',direction:'1',issue_type:'N',series:'1',
  nature_id:nature.id,issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'1',final_consumer:false,freight:'15.00',recipient:{name:'Cliente Relatórios F',person_type:'J',document:'11444777000161',state:'SP'},
  transport:{mode:'manual',freight_by:'1',tracking_code:'TR-1',carrier:{name:'Transportadora da Nota F',document:'04252011000110'},vehicle:{plate:'ABC1D23',state:'SP'},
   volumes:{quantity:'2',gross_weight:'3.5',net_weight:'3',species:'caixas'}},
  items:[{product_id:null,description:'Item da nota',code:'N-1',unit:'UN',quantity:'1',unit_price:'10'}],payment:{installments:[{date:'2026-11-20',amount:'25.00'}]}}}})).invoice;
 assert.ok(invoice.id);
 const note=(await run('transporte_nota')).find(r=>r.transportador==='Transportadora da Nota F');
 assert.deepEqual([note.documento_transportador,note.frete,note.valor_frete,note.volumes,note.especie,note.peso_bruto,note.peso_liquido,note.placa,note.rastreamento],
  ['04252011000110','1 - Contratação do Frete por conta do Destinatário (FOB)','15.00','2','caixas','3.5','3','ABC1D23','TR-1']);
});
