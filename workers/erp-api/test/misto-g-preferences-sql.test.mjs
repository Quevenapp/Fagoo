import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoGFixture,fails}from'./helpers/misto-g-fixture.mjs';
import{preferencePage}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{preferenceValueValid,storedFields}from'../../../packages/erp-domain/src/preferences/core.mjs';
import{parsePreferencesPage,parsePreferencesResult}from'../../../packages/erp-domain/src/preferences/dto.mjs';
import{captureImportBatch,templateRows,parseImportBatchResult}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';
import{REPORT_BASES,captureReportRun,parseReportRows,parseReports}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{parsePreferencesRoute}from'../src/preferences.mjs';

// Synthetic data only. 299: Preferências › Suprimentos › Estoque › "Situações de vendas consideradas" also offers the custom situações
// of the pedidos de venda (Gerenciador de transições), stored as their ids after the default options, as the stock lane reads them (277).
const PAGE='suprimentos-estoque',KEY='estoque.reserva_situacoes';
const field=storedFields(preferencePage(PAGE)).find(f=>f.key===KEY);
const save=async(f,value,user)=>{const current=(await f.page(PAGE)).items.find(i=>i.key===KEY);
 return f.rpc('erp_preferences_save',{p_user_id:user??f.users.admin,p_command_id:randomUUID(),p_page:PAGE,p_changes:[{key:KEY,expected_version:current.version,value}]});};
const setSituation=async(f,id,active)=>{const row=(await f.db.query('select kind,base_status,name,color,version from erp_preferences.situation where id=$1',[id])).rows[0];
 return f.rpc('erp_preferences_situation_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:row.kind,p_situation:id,p_expected_version:row.version,p_data:{base_status:row.base_status,name:row.name,color:row.color,active}});};

test('299 the page lists the custom situações of the pedidos de venda; saving keeps the defaults first and the ids ascending',async()=>{const f=await mistoGFixture();try{
 const empty=await f.page(PAGE);assert.deepEqual(empty.situations,[]);assert.deepEqual(parsePreferencesPage(empty,PAGE).situations,[]);
 const paying=await f.situation('sales_orders','verified','Aguardando pagamento','#ff8800'),picking=await f.situation('sales_orders','open','Em separação');
 await f.situation('purchase_orders','in_progress','Compra em trânsito');
 const view=await f.page(PAGE,f.users.estoque);parsePreferencesPage(view,PAGE);
 assert.deepEqual(view.situations.map(s=>[s.name,s.base_status,s.base_label,s.kind,s.active]),[['Em separação','open','Em aberto','sales_orders',true],['Aguardando pagamento','verified','Verificado','sales_orders',true]]);
 // Other pages keep their shape (no situations key).
 const other=await f.page('empresa-geral');assert.equal(Object.hasOwn(other,'situations'),false);parsePreferencesPage(other,'empresa-geral');
 const ids=[paying,picking].sort(),value=['em_digitacao',...ids];
 const saved=await save(f,value);const result=parsePreferencesResult(saved,{commandId:saved.receipt.command_id,pageId:PAGE});
 assert.deepEqual(result.page.items.find(i=>i.key===KEY).value,value);
 // The stock lane reserves by these ids once "Considerar situações de vendas" is on (277).
 await f.preference(PAGE,'estoque.reserva_por_situacao',true);
 assert.deepEqual(await f.scalar('select to_jsonb(erp_stock.reserve_situation_ids()) v'),ids);
 assert.deepEqual(await f.scalar('select to_jsonb(erp_stock.reserve_statuses()) v'),['draft']);
 // Wrong orders, repeated ids, upper case, ids of other kinds and unknown ids are refused.
 for(const bad of[[...ids].reverse(),[ids[0],ids[0]],[ids[0].toUpperCase()],[ids[0],'em_digitacao'],['nao-e-uuid']])await fails(assert,()=>save(f,bad),'22023');
 const purchase=(await f.db.query("select id::text v from erp_preferences.situation where kind='purchase_orders'")).rows[0].v;
 await fails(assert,()=>save(f,[purchase]),'22023');await fails(assert,()=>save(f,[randomUUID()]),'22023');
 // Only the administrador saves the page.
 await fails(assert,()=>save(f,[ids[0]],f.users.estoque),'42501');
}finally{await f.close();}});

test('299 a situação name is counted in characters, as the database counts it: 40 emoji still read as a valid page',async()=>{const f=await mistoGFixture();try{
 // 40 code points, 80 UTF-16 code units: valid for char_length() in erp_preferences.situation (148), so the page must parse.
 const name='📦'.repeat(40),id=await f.situation('sales_orders','fulfilled',name);
 const view=parsePreferencesPage(await f.page(PAGE),PAGE);assert.equal(view.situations.find(s=>s.id===id).name,name);
}finally{await f.close();}});

test('299 an inactive situação already chosen may stay or be removed; it cannot be added again',async()=>{const f=await mistoGFixture();try{
 const a=await f.situation('sales_orders','verified','Conferência'),b=await f.situation('sales_orders','in_progress','Embalando');
 await save(f,[a]);await setSituation(f,a,false);
 const view=await f.page(PAGE);assert.equal(view.situations.find(s=>s.id===a).active,false);
 // Keeping it while adding an active one, then removing it, both pass.
 await save(f,[a,b].sort());await save(f,[b]);
 await fails(assert,()=>save(f,[a,b].sort()),'22023');
 // Reactivated, it can be chosen again.
 await setSituation(f,a,true);await save(f,[a,b].sort());
}finally{await f.close();}});

test('299 value validation of the key is identical in SQL and in the shared schema, also with custom ids',async()=>{const f=await mistoGFixture();try{
 const u1='10000000-0000-4000-8000-000000000001',u2='10000000-0000-4000-8000-000000000002',opts=field.options.map(o=>o[0]);
 const many=Array.from({length:31},(_,i)=>`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
 const candidates=[[],[u1],[u1,u2],[u2,u1],[u1,u1],['em_aberto',u1],[u1,'em_aberto'],['verificado','em_aberto'],[...opts],[...opts,u1,u2],many,many.slice(0,30),['aaaaaaaa-0000-4000-8000-00000000000a'],['AAAAAAAA-0000-4000-8000-00000000000A'],['x'],[1],null,'em_aberto',{}];
 for(const value of candidates)assert.equal(await f.scalar('select erp_preferences.value_valid(d,$2::jsonb) v from erp_preferences.definition d where d.key=$1',[KEY,value===null?null:JSON.stringify(value)]),
  preferenceValueValid(field,value),JSON.stringify(value));
 assert.equal(await f.scalar("select situation_kind v from erp_preferences.definition where key=$1",[KEY]),'sales_orders');
 assert.equal(await f.scalar("select count(*)::integer v from erp_preferences.definition where situation_kind is not null"),1);
 for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}','erp_preferences.page_situations(text)','execute') v`),false,role);
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_preferences_save(uuid,uuid,text,jsonb)','execute') v`),false,role);
}finally{await f.close();}});

test('299 replaces only the published functions: another version stops the migration',async()=>{const f=await mistoGFixture({before:'202610200299'});try{
 await f.db.exec(`create or replace function erp_preferences.page_dto(p_page erp_preferences.page,p_role text,p_user uuid) returns jsonb language sql stable set search_path=pg_catalog as $$ select '{}'::jsonb $$;`);
 await assert.rejects(()=>f.migrate('202610200299_preferences_reserve_situations.sql'),e=>e.code==='55000'&&/preferences_reserve_situations_299_previous_definition_changed/.test(e.message));
}finally{await f.close();}});

// 300: Importar lotes. The rows go through erp_stock_lot_import (277) with the derived command of each line.
test('300 PRF-027 Importar lotes: validates without writing, creates, updates the dates and the Obs., and refuses what + Adicionar lote refuses',async()=>{const f=await mistoGFixture();try{
 const version=id=>f.scalar('select version v from erp_catalog.record where id=$1',[id]);
 const lotProduct=async(code,lot)=>{const p=await f.catalog('products',{name:`Produto ${code}`,code,unit:'UN',kind:'P',format:'S',price:'10'});
  if(lot)await f.rpc('erp_catalog_product_save',{p_user_id:f.users.admin,p_id:p.id,p_expected_version:await version(p.id),p_command_id:randomUUID(),p_data:{name:`Produto ${code}`,lot_control:true},p_acknowledged:null});return p;};
 const withLots=await lotProduct('LOT-A',true);await lotProduct('SEM-LOTE',false);
 // The sheet as the browser reads it (dd/mm/aaaa dates), then the strict capture of the Worker.
 const sheet=[['Código do produto','Lote','Data de fabricação','Data de validade','Obs.'],['LOT-A','L-01','01/10/2026','31/01/2027','Primeira partida'],['SEM-LOTE','L-01','',''],['NAO-EXISTE','X','','',''],
  ['LOT-A','L-02','10/02/2027','01/02/2027','']];
 const parsed=templateRows('lots',sheet);assert.deepEqual(parsed.missing,[]);assert.deepEqual(parsed.items.map(i=>i.problems),[[],[],[],[]]);
 assert.deepEqual(parsed.items[0].data,{code:'LOT-A',lot:'L-01',manufactured_on:'2026-10-01',expires_on:'2027-01-31',note:'Primeira partida'});
 const items=parsed.items.map(({row,lines,data})=>({row,lines,data}));
 const batch=async(rows,dry,command=dry?null:randomUUID(),job=dry?null:randomUUID(),user=f.users.admin,total=rows.length)=>{
  const input=captureImportBatch('lots',{command_id:command,job_id:job,file_name:'lotes.csv',total_rows:total,dry_run:dry,items:rows});
  return parseImportBatchResult(await f.rpc('erp_preferences_import_batch',{p_user_id:user,p_command_id:command,p_job_id:job,p_kind:'lots',p_file_name:'lotes.csv',p_total_rows:total,p_dry_run:dry,p_rows:input.items}),input);};
 const dry=await batch(items,true);
 assert.deepEqual(dry.items.map(i=>[i.status,i.reason]),[['valid',null],['invalid','erp_stock_lot_control_off'],['invalid','erp_preferences_import_not_found:code'],['invalid','erp_stock_lot_invalid']]);
 assert.equal(await f.scalar('select count(*)::integer v from erp_stock.lot'),0,'the validation writes nothing');
 const command=randomUUID(),job=randomUUID(),done=await batch(items,false,command,job);
 assert.deepEqual(done.items.map(i=>i.status),['created','invalid','invalid','invalid']);assert.equal(done.job.created,1);assert.equal(done.job.invalid,3);assert.equal(done.job.status,'concluida');
 assert.equal(done.items[0].reference,'Lote L-01 · LOT-A');
 const lot=(await f.db.query("select id::text,code,manufactured_on::text made,expires_on::text expires,note,version from erp_stock.lot where product_id=$1",[withLots.id])).rows[0];
 assert.deepEqual([lot.code,lot.made,lot.expires,lot.note,lot.version,done.items[0].record_id],['L-01','2026-10-01','2027-01-31','Primeira partida',1,lot.id]);
 // The same command answers the recorded batch; nothing is written twice.
 const again=await batch(items,false,command,job);assert.equal(again.replayed,true);assert.equal(await f.scalar('select count(*)::integer v from erp_stock.lot'),1);
 // An existing lot: only the filled columns change; equal values are "Sem alteração".
 const update=await batch([{row:2,lines:[2],data:{code:'LOT-A',lot:'l-01',note:'Conferido'}}],false);assert.equal(update.items[0].status,'updated');
 assert.deepEqual((await f.db.query("select expires_on::text v,note from erp_stock.lot where product_id=$1",[withLots.id])).rows[0],{v:'2027-01-31',note:'Conferido'});
 const same=await batch([{row:2,lines:[2],data:{code:'LOT-A',lot:'L-01',expires_on:'2027-01-31'}}],false);assert.equal(same.items[0].status,'unchanged');
 // Preferências › Cadastros › Controle de lotes: Data de validade obrigatória for a new lot.
 await f.preference('cadastros-lotes','lotes.validade_obrigatoria',true);
 const required=await batch([{row:2,lines:[2],data:{code:'LOT-A',lot:'L-03'}}],true);assert.deepEqual(required.items.map(i=>i.reason),['erp_stock_lot_expiry_required']);
 // Only the administrador imports.
 await fails(assert,()=>f.rpc('erp_preferences_import_batch',{p_user_id:f.users.estoque,p_command_id:null,p_job_id:null,p_kind:'lots',p_file_name:'lotes.csv',p_total_rows:1,p_dry_run:true,p_rows:[{row:2,lines:[2],data:{code:'LOT-A',lot:'L-09'}}]}),'42501');
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_preferences.import_item_lot(uuid,uuid,jsonb)','execute') v"),false);
 // The Worker capture is strict: a lot without Código or with an unknown column is refused before the database.
 assert.throws(()=>captureImportBatch('lots',{command_id:null,job_id:null,file_name:'x.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{lot:'L'}}]}),e=>e.status===400);
 assert.throws(()=>captureImportBatch('lots',{command_id:null,job_id:null,file_name:'x.csv',total_rows:1,dry_run:true,items:[{row:2,lines:[2],data:{code:'A',lot:'L',saldo:'1'}}]}),e=>e.status===400);
}finally{await f.close();}});

test('300 replaces only the published import functions: another version stops the migration',async()=>{const f=await mistoGFixture({before:'202610200300'});try{
 await f.db.exec(`create or replace function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language sql as $$ select '{}'::jsonb $$;`);
 await assert.rejects(()=>f.migrate('202610200300_preferences_lot_import.sql'),e=>e.code==='55000'&&/preferences_lot_import_300_previous_definition_changed/.test(e.message));
}finally{await f.close();}});

// VND-258: the Ocorrências of an Ordem de Serviço in the gerenciador de relatórios customizados (base of 284, applied).
test('VND-258 Ocorrências por Ordem de Serviço lists the occurrences of the OS for the readers of the OS',async()=>{const f=await mistoGFixture();try{
 const customer=await f.catalog('contacts',{name:'Cliente OS G',roles:['customer'],document:'11444777000161',person_type:'J'});
 const os=await f.document('service_orders',{contact:customer.id,items:[{description:'Revisão sintética',quantity:'1',unit_price:'80'}]});
 await f.rpc('erp_document_occurrence_add',{p_user_id:f.users.admin,p_kind:'service_orders',p_document_id:os.id,p_expected_version:os.version,p_command_id:randomUUID(),p_occurred_on:'2026-10-15',p_occurred_time:'09:15',
  p_text:'Equipamento recebido com avaria',p_status:null,p_next_contact:null});
 const base=REPORT_BASES.find(b=>b.base==='ocorrencias_os');assert.equal(base.title,'Ocorrências por Ordem de Serviço');
 const input=captureReportRun({base:'ocorrencias_os',columns:base.columns.map(c=>c.id),filters:[],view_limit:2000,offset:0,page:200});
 const rows=parseReportRows(await f.rpc('erp_preferences_report_run',{p_user_id:f.users.vendas,p_base:'ocorrencias_os',p_columns:input.columns,p_filters:input.filters,p_view_limit:2000,p_offset:0,p_page:200}),input)
  .rows.map(r=>Object.fromEntries(input.columns.map((c,i)=>[c,r[i]])));
 const mine=rows.filter(r=>r.numero===String(os.number));
 // The day of the occurrence follows "Permite a edição da data e hora das ocorrências" (off: the day it was recorded).
 assert.deepEqual(mine.map(r=>[r.contato,r.ocorrencia]),[['Cliente OS G','Equipamento recebido com avaria']]);assert.equal(mine[0].data.length,10);
 const bases=async user=>parseReports(await f.rpc('erp_preferences_reports',{p_user_id:user})).bases.map(b=>b.base);
 assert.ok((await bases(f.users.financeiro)).includes('ocorrencias_os'));assert.ok(!(await bases(f.users.estoque)).includes('ocorrencias_os'));
}finally{await f.close();}});

test('299 the Worker takes the custom ids canonical (defaults first, ids ascending) and refuses any other form before the database',async()=>{
 const u1='10000000-0000-4000-8000-000000000001',u2='10000000-0000-4000-8000-000000000002';
 const req=value=>new Request('https://api.synthetic.invalid/v1/preferencias/suprimentos-estoque',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({command_id:randomUUID(),changes:[{key:KEY,expected_version:0,value}]})});
 const ok=await parsePreferencesRoute(req(['verificado',u1,u2]));assert.deepEqual(ok.args.p_changes[0].value,['verificado',u1,u2]);
 for(const bad of[[u2,u1],[u1,'verificado'],['aaaaaaaa-0000-4000-8000-00000000000a'.toUpperCase()],[u1,u1]])await assert.rejects(()=>parsePreferencesRoute(req(bad)),e=>e.status===400,JSON.stringify(bad));
});
