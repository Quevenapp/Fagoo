import test,{before,after}from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoFixture,fails}from'./helpers/misto-f-fixture.mjs';
import{parseActivity,captureActivityQuery,parseActivityDetail}from'../../../packages/erp-domain/src/activity.mjs';
import{generatedBlock,committedBlock}from'../../../tools/preferences/generate-definitions.mjs';

// Synthetic data only. 283: Registro de atividades with the wave E audits, "Lote próximo ao vencimento", the home summary without the
// disregarded warehouses, DATA MATRIX in the label models and the compositions following a spreadsheet import.
let f;
const today=async()=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
const shift=(day,days)=>new Date(Date.parse(`${day}T12:00:00Z`)+days*86400000).toISOString().slice(0,10);
const warehouse=async(name,ignore=false)=>(await f.rpc('erp_stock_warehouse_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_warehouse_id:null,p_expected_version:0,p_expected_setting_version:0,p_name:name,p_ignore_balance:ignore})).warehouse;
const recordVersion=id=>f.scalar('select version v from erp_catalog.record where id=$1',[id]);
const balanceVersion=async(item,target)=>(await f.scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) v',[item,target]))??0;
const launch=async(item,target,quantity,user=f.users.estoque)=>f.rpc('erp_stock_launch',{p_user_id:user,p_command_id:randomUUID(),p_kind:'receipt',p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
 p_expected_version:await balanceVersion(item,target),p_unit_price:null,p_unit_cost:null,p_note:null,p_destination_id:null,p_destination_version:null});
const lotProduct=async name=>{const p=await f.catalog('products',{name,unit:'UN',kind:'P',format:'S',price:'10'});
 await f.rpc('erp_catalog_product_save',{p_user_id:f.users.admin,p_id:p.id,p_expected_version:await recordVersion(p.id),p_command_id:randomUUID(),p_data:{name,lot_control:true},p_acknowledged:null});return p;};
const lotLaunch=async(item,target,quantity,lot)=>f.rpc('erp_stock_lot_launch',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'receipt',p_product_id:item,p_warehouse_id:target,p_quantity:quantity,
 p_expected_version:await balanceVersion(item,target),p_unit_price:null,p_unit_cost:null,p_note:null,p_destination_id:null,p_destination_version:null,p_lot:lot});
const activity=async(from,to,module=null)=>{const q=captureActivityQuery({from,to,module,limit:100});
 return parseActivity(await f.rpc('erp_activity_list',{p_user_id:f.users.admin,p_from:q.from,p_to:q.to,p_module:q.module,p_operation:null,p_actor:null,p_query:null,p_limit:q.limit,p_offset:0}),q);};
let saleNature;
before(async()=>{f=await mistoFixture();
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,$2::jsonb,$1) on conflict do nothing",[f.users.admin,JSON.stringify({state:'SP',cnpj:'11222333000181'})]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 saleNature=(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:{description:'Venda sintética F',direction:'1',crt:'1'}}})).nature;
});
// An outgoing NF-e of Brufap (the notas lane flow), with the item of a product.
const note=async(product,quantity)=>{const total=(Number(quantity)*10).toFixed(2);
 return(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{orders:[],invoice:{model:'55',direction:'1',issue_type:'N',series:'1',
  nature_id:saleNature.id,issue_date:'2026-10-20',crt:'1',purpose:'1',presence:'1',final_consumer:false,recipient:{name:'Contato sintético F',person_type:'J',document:'12345678000190',state:'SP'},
  items:[{product_id:product.id,description:'Item sintético',code:'S-1',unit:'UN',quantity,unit_price:'10'}],payment:{installments:[{date:'2026-11-20',amount:total}]}}}})).invoice;};
const originNote=async(id,payload)=>{
 if(!await f.scalar("select exists(select 1 from origin_sync.resource_state where resource='misto_f_test') v"))await f.db.exec("insert into origin_sync.resource_state(resource) values('misto_f_test')");
 await f.db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','misto_f_test',$1,$2::jsonb,$3)",[id,JSON.stringify(payload),'b'.repeat(64)]);};
after(async()=>f?.close());

test('283 replaces only the published versions and keeps every helper private',async()=>{
 const before=await mistoFixture({before:'202610200283'});try{
  await before.db.exec("create or replace function erp_activity.operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $$ select 'x' $$;");
  await assert.rejects(()=>before.migrate('202610200283_preferences_activity_notifications_f.sql'),e=>e.code==='55000'&&/preferences_283_previous_definition_changed/.test(e.message));
 }finally{await before.close();}
 for(const sig of['erp_activity.entries(timestamptz,timestamptz)','erp_home.notification_digest(text,date)','erp_home.lot_expiry_days()','erp_preferences.label_check(text,jsonb)','erp_preferences.import_item(uuid,text,uuid,text,jsonb)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar("select has_function_privilege($1,$2,'execute') v",[role,sig]),false,`${role} ${sig}`);
 for(const sig of['public.erp_activity_detail(uuid,text,text)','public.erp_home_summary(uuid)']){
  for(const role of['anon','authenticated'])assert.equal(await f.scalar("select has_function_privilege($1,$2,'execute') v",[role,sig]),false,`${role} ${sig}`);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'execute') v",[sig]),true,sig);
 }
 assert.equal(await committedBlock('283'),generatedBlock('283'),'node tools/preferences/generate-definitions.mjs --write');
});

test('283 Registro de atividades: lots, invoice tags, the stock and contas of the notes and the Devolvido, with the Origin modules',async()=>{
 const day=await today(),depot=await warehouse('Depósito atividades F');
 const product=await lotProduct('Produto com lote F');
 const saved=await f.rpc('erp_stock_lot_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_product_id:product.id,p_lot_id:null,p_expected_version:0,p_code:'LT-F1',p_manufactured_on:null,p_expires_on:null,p_note:null});
 await f.rpc('erp_stock_lot_status',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_lot_id:saved.lot.id,p_expected_version:saved.lot.version,p_active:false});
 await lotLaunch(product.id,depot.id,'3',{code:'LT-F2',manufactured_on:null,expires_on:null});
 // A Origin note mirrored in the staging and its tags (Marcadores).
 await originNote('777001',{numero:'4321'});
 const tag=(await f.rpc('erp_catalog_taxonomy_save',{p_user_id:f.users.admin,p_kind:'tags',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Conferida F',tag_type:'invoices'}}));
 const tagId=tag.item?.id??tag.record?.id;
 await f.rpc('erp_catalog_invoice_tags_save',{p_user_id:f.users.fiscal,p_origin:'origin',p_model:'55',p_id:'777001',p_expected_version:0,p_command_id:randomUUID(),p_tag_ids:[tagId],p_mode:'replace'});
 const list=await activity(day,day);
 const lots=list.items.filter(e=>e.source==='lots').map(e=>[e.operation,e.description]);
 assert.deepEqual(lots.sort(),[['criacao','Lote LT-F1 do produto Produto com lote F'],['exclusao','Lote LT-F1 do produto Produto com lote F · excluído'],['criacao','Lote LT-F2 do produto Produto com lote F · criado no lançamento de estoque']].sort());
 assert.ok(list.items.filter(e=>e.source==='lots').every(e=>e.module==='estoque'));
 const tags=list.items.find(e=>e.source==='invoice_tags');
 assert.deepEqual([tags.module,tags.operation,tags.code,tags.description],['notas_fiscais','atualizacao','4321','Tags alteradas na NF-e nº 4321 (Origin)']);
 const detail=parseActivityDetail(await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'invoice_tags',p_entry_id:tags.id}),{source:'invoice_tags',id:tags.id});
 assert.deepEqual([detail.available,detail.before,detail.after],[true,{tag_ids:[]},{tag_ids:[tagId]}]);
 const lotEntry=list.items.find(e=>e.source==='lots');
 assert.equal((await f.rpc('erp_activity_detail',{p_user_id:f.users.admin,p_source:'lots',p_entry_id:lotEntry.id})).available,false);
 // "Informar lotes de produtos" of the stock lane (wave F, 278 adds the action "assign" to the lot commands): Atualização, own description.
 // Simulated here with the constraint of 278 and a synthetic receipt; this branch does not carry 278.
 await f.db.exec("alter table erp_stock.lot_command drop constraint lot_command_action_check;alter table erp_stock.lot_command add constraint lot_command_action_check check(action in('save','status','launch','assign'))");
 const assign=randomUUID();
 await f.db.query("insert into erp_stock.lot_command(id,actor,action,product_id,lot_id,request_hash,result) values($1,$2,'assign',$3,$4,$5,'{}'::jsonb)",[assign,f.users.estoque,product.id,saved.lot.id,'c'.repeat(64)]);
 const assigned=(await activity(day,day)).items.find(e=>e.source==='lots'&&e.id===assign);
 assert.deepEqual([assigned.module,assigned.operation,assigned.description],['estoque','atualizacao','Lotes informados no lançamento de estoque do produto Produto com lote F']);
 assert.deepEqual((await activity(day,day,'notas_fiscais')).items.map(e=>e.source).filter(s=>s==='invoice_tags'),['invoice_tags']);
 // The stock posted by a Brufap note (259): Notas Fiscais, and the movement itself in Estoque.
 const sold=await f.catalog('products',{name:'Produto da nota F',unit:'UN',kind:'P',format:'S',price:'10'});
 await launch(sold.id,depot.id,'5');
 const invoice=await note(sold,'2');
 const version=await f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[invoice.id]);
 const preview=(await f.rpc('erp_stock_invoice_preview',{p_user_id:f.users.estoque,p_invoice_id:invoice.id,p_expected_version:version,p_warehouse_id:depot.id})).preview;
 await f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:invoice.id,p_expected_version:version,p_warehouse_id:depot.id,p_preview_hash:preview.preview_hash});
 const posted=(await activity(day,day,'notas_fiscais')).items.filter(e=>e.source==='invoice_stock');
 assert.deepEqual(posted.map(e=>[e.operation,e.description]),[['lancamento','Estoque lançado pela NF-e']]);
 // Tags of the Brufap note too (administrador and fiscal).
 await f.rpc('erp_catalog_invoice_tags_save',{p_user_id:f.users.admin,p_origin:'brufap',p_model:'55',p_id:invoice.id,p_expected_version:0,p_command_id:randomUUID(),p_tag_ids:[tagId],p_mode:'replace'});
 assert.ok((await activity(day,day,'notas_fiscais')).items.some(e=>e.source==='invoice_tags'&&e.description==='Tags alteradas na NF-e'));
 for(const[action,label,operation]of[['invoice_post','Contas lançadas pela nota fiscal','lancamento'],['invoice_reverse','Contas estornadas da nota fiscal','estorno'],['title_returned','Contas devolvidas (situação Devolvido)','atualizacao_situacao']]){
  assert.equal(await f.scalar('select erp_activity.finance_label($1) v',[action]),label);assert.equal(await f.scalar('select erp_activity.operation($1) v',[action]),operation,action);}
 // A Devolvido written by 281 shows in Contas a Pagar/Receber.
 const contact=await f.catalog('contacts',{name:'Cliente devolução F',roles:['customer']});
 const title=(await f.rpc('erp_finance_title_execute',{p_user_id:f.users.financeiro,p_command_id:randomUUID(),p_action:'title_create',p_data:{kind:'receivable',contact_id:contact.id,description:'Venda F',issued_on:day,competence_on:day,total_cents:'1000',installments:[{amount_cents:'1000',due_on:day}]}})).items[0];
 await f.scalar('select erp_finance.titles_mark_returned($1,$2,$3::uuid[],$4::jsonb) is not null v',[f.users.vendas,randomUUID(),[title.id],JSON.stringify({kind:'pos_return',id:'1'})]);
 const returned=(await activity(day,day,'financas')).items.find(e=>e.description==='Contas devolvidas (situação Devolvido)');
 assert.equal(returned.operation,'atualizacao_situacao');
});

test('283 Lote próximo ao vencimento: a daily notice of the lots with stock that expire within the days of Controle de lotes',async()=>{
 const day=await today(),depot=await warehouse('Depósito lotes F'),ignored=await warehouse('Depósito desconsiderado lotes F',true);
 const product=await lotProduct('Produto validade F');
 await lotLaunch(product.id,depot.id,'2',{code:'VENCE-5',manufactured_on:null,expires_on:shift(day,5)});
 await lotLaunch(product.id,depot.id,'2',{code:'VENCE-40',manufactured_on:null,expires_on:shift(day,40)});
 await lotLaunch(product.id,ignored.id,'2',{code:'IGNORADO',manufactured_on:null,expires_on:shift(day,3)});
 await f.preference('cadastros-lotes','lotes.dias_aviso_validade',10);
 assert.equal(await f.scalar('select erp_home.lot_expiry_days() v'),10);
 const digest=await f.scalar("select quantity v from erp_home.notification_digest('lote_vencimento',$1::date) where quantity>0",[day]);
 assert.equal(digest,1,'only VENCE-5: VENCE-40 is later and the disregarded warehouse is left out');
 // Nobody chosen: the administradores receive it; a chosen estoque user receives it, a financeiro never does.
 const bell=await f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'todas'});
 const notice=bell.items.find(n=>n.type==='lote_vencimento');assert.equal(notice.quantity,1);
 assert.equal((await f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'todas'})).items.filter(n=>n.type==='lote_vencimento').length,1,'once per day');
 await f.preference('central-notificacoes','notificacoes.lote_vencimento',[f.users.estoque,f.users.financeiro].sort());
 assert.ok((await f.rpc('erp_home_notifications',{p_user_id:f.users.estoque,p_tab:'todas'})).items.some(n=>n.type==='lote_vencimento'));
 assert.ok(!(await f.rpc('erp_home_notifications',{p_user_id:f.users.financeiro,p_tab:'todas'})).items.some(n=>n.type==='lote_vencimento'));
 assert.equal(await f.scalar("select erp_home.notification_roles('lote_vencimento')::text v"),'{admin,consulta,vendas,estoque,fiscal}');
});

test('283 the home summary leaves the disregarded warehouses out of the stock positions',async()=>{
 const before=(await f.rpc('erp_home_summary',{p_user_id:f.users.estoque})).stock;
 const kept=await warehouse('Depósito resumo F'),left=await warehouse('Depósito resumo desconsiderado F',true);
 const product=await f.catalog('products',{name:'Produto resumo F',unit:'UN',kind:'P',format:'S',price:'1'});
 await launch(product.id,kept.id,'4');await launch(product.id,left.id,'7');
 const after=(await f.rpc('erp_home_summary',{p_user_id:f.users.estoque})).stock;
 assert.equal(after.positions-before.positions,1);assert.equal(after.warehouses-before.warehouses,1);
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.balance where product_id=$1',[product.id]),2,'both balances exist');
 assert.equal((await f.rpc('erp_home_summary',{p_user_id:f.users.financeiro})).stock,null,'financeiro does not read the stock');
});

test('283 DATA MATRIX is accepted in the label models; other formats stay refused',async()=>{
 const config=barcode=>({label:{barcode,barcode_text:true,columns_gap:'2.0',currency:true,font:'helvetica',font_size:'10.0',height:'30.0',rows_gap:'2.0',show_labels:true,width:'60.0'},
  page:{height:null,margin_left:'5.0',margin_top:'5.0',orientation:'portrait',size:'A4',width:null},fields:[{barcode:true,bold:false,field:'codigo',size:'10.0',x:'1.0',y:'1.0'}]});
 await f.db.query("select erp_preferences.label_check('produto',$1::jsonb)",[JSON.stringify(config('datamatrix'))]);
 for(const bad of['pdf417','ebct','dm'])await fails(assert,()=>f.db.query("select erp_preferences.label_check('produto',$1::jsonb)",[JSON.stringify(config(bad))]),'22023');
});

test('283 a spreadsheet import of a component recalculates the compositions that use it',async()=>{
 const settings=await f.rpc('erp_preferences_page',{p_user_id:f.users.admin,p_page:'cadastros-produtos'});
 const changes=['produtos.composicao_preco','produtos.composicao_peso','produtos.composicao_custo'].map(key=>({key,expected_version:settings.items.find(i=>i.key===key).version,value:true}));
 await f.rpc('erp_preferences_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_page:'cadastros-produtos',p_changes:changes});
 const component=await f.catalog('products',{name:'Componente F',code:'COMP-F1',unit:'UN',kind:'P',format:'S',price:'10'});
 const kit=await f.catalog('products',{name:'Kit F',code:'KIT-F1',unit:'UN',kind:'P',format:'E',price:'1'});
 await f.rpc('erp_stock_product_compose',{p_user_id:f.users.admin,p_id:kit.id,p_expected_version:await recordVersion(kit.id),p_command_id:randomUUID(),p_data:{name:'Kit F'},p_acknowledged:null,
  p_composition:{expected_version:0,stock_type:'virtual',post_mode:'components',items:[{component_id:component.id,quantity:'3'}]}});
 assert.equal(await f.scalar('select price::text v from erp_catalog.product where record_id=$1',[kit.id]),'30.0000','the Estrutura save applied the price');
 const run=async(kind,rows)=>f.rpc('erp_preferences_import_batch',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_job_id:randomUUID(),p_kind:kind,p_file_name:'planilha-f.csv',p_total_rows:rows.length,p_dry_run:false,p_rows:rows});
 const result=await run('products',[{row:2,lines:[2],data:{code:'COMP-F1',price:'12.5'}}]);
 assert.ok(JSON.stringify(result).includes('update'),JSON.stringify(result).slice(0,400));
 assert.equal(await f.scalar('select price::text v from erp_catalog.product where record_id=$1',[kit.id]),'37.5000');
 // The default supplier's cost of the component (Importar fornecedores de produtos) gives the cost of the composition.
 const supplier=await f.catalog('contacts',{name:'Fornecedor F',roles:['supplier'],document:'11444777000161',person_type:'J'});
 const kitSupplier=await f.catalog('contacts',{name:'Fornecedor do kit F',roles:['supplier'],document:'04252011000110',person_type:'J'});
 assert.ok(supplier.id);
 await f.rpc('erp_catalog_product_save',{p_user_id:f.users.admin,p_id:kit.id,p_expected_version:await recordVersion(kit.id),p_command_id:randomUUID(),
  p_data:{suppliers:[{supplier_id:kitSupplier.id,description:null,code:null,purchase_price:null,cost_price:'1',warranty_months:null,is_default:true}]},p_acknowledged:null});
 await run('product_suppliers',[{row:2,lines:[2],data:{code:'COMP-F1',supplier_name:'Fornecedor F',supplier_document:'11444777000161',cost_price:'4',is_default:true}}]);
 assert.equal(await f.scalar('select cost_price::numeric(18,4)::text v from erp_catalog.product_supplier where record_id=$1 and is_default',[kit.id]),'12.0000');
 // Off, the import changes only the component.
 const off=await f.rpc('erp_preferences_page',{p_user_id:f.users.admin,p_page:'cadastros-produtos'});
 await f.rpc('erp_preferences_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_page:'cadastros-produtos',p_changes:['produtos.composicao_preco','produtos.composicao_peso','produtos.composicao_custo'].map(key=>({key,expected_version:off.items.find(i=>i.key===key).version,value:false}))});
 await run('products',[{row:2,lines:[2],data:{code:'COMP-F1',price:'20'}}]);
 assert.equal(await f.scalar('select price::text v from erp_catalog.product where record_id=$1',[kit.id]),'37.5000');
});
