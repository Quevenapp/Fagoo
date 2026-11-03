// Complete production migration chain, synthetic source documents, real RPCs and table triggers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { documentMirrorFixture } from './helpers/document-mirror-fixture.mjs';
import { documentMirrorRecord, documentMirrorSummary, documentOriginTotals } from '../../../packages/erp-domain/src/document-mirror.mjs';

let f, contactA, contactB, sellerA, native;
const docs = {}, kinds = ['sales_orders', 'sales_proposals', 'purchase_orders', 'service_orders'];
async function linkedContact(source, seller) {
 const contact=await f.catalog('contacts',{name:'Contato observado '+source});
 await f.stage('contacts',source,{id:source,nome:'Contato observado '+source});
 await f.db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)select entity,source_id,version_hash,version,payload,document_links from origin_sync.raw_record where entity='contacts'and source_id=$1",[source]);
 await f.db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state)select entity,source_id,$2,version_hash,version_hash,'synced'from origin_sync.raw_record where entity='contacts'and source_id=$1",[source,contact.id]);
 if(seller)await f.db.query('insert into erp_catalog.contact_profile(record_id,seller_id)values($1,$2)on conflict(record_id)do update set seller_id=excluded.seller_id',[contact.id,seller]);
 return contact;
}
const payload=(id,contact,total='25.13')=>({id,numero:7100,data:'2026-10-22',total,contato:{id:contact,nome:'Observado '+contact},situacao:{id:991,nome:'Estado externo'},itens:[{produto:{id:777},descricao:'Produto observado',quantidade:'2',valor:'12.565',valorTotal:total}]});
const list=(kind='sales_orders',args={})=>f.rpc('erp_document_list',{p_user_id:f.users.admin,p_kind:kind,...args});
const get=(id,kind='sales_orders',user=f.users.admin)=>f.rpc('erp_document_get',{p_user_id:user,p_kind:kind,p_id:id});
const denied=action=>assert.rejects(action,e=>e.code==='42501'&&/mirror/.test(e.message));

before(async()=>{
 f=await documentMirrorFixture({guards:true});
 const sellerContact=await f.catalog('contacts',{name:'Vendedor sintético carteira'});
 sellerA=await f.scalar('insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by)values($1,$2,$3,$3)returning id v',[sellerContact.id,f.users.consulta,f.users.admin]);
 contactA=await linkedContact('301',sellerA);contactB=await linkedContact('302',null);
 await f.preference('cadastros-contatos','contatos.acesso_vendedor',true);
 native=await f.document('sales_orders',{contact:contactA.id,date:'2026-10-22',items:[{description:'Nativo',quantity:'1',unit_price:'10'}]});
 for(const[k,kind]of kinds.entries())await f.stage(kind,String(1000+k),payload(String(1000+k),'301'));
 await f.stage('sales_orders','2001',payload('2001','302'));
 await f.stage('sales_orders','2002',{...payload('2002','999'),numero:null,total:null,itens:[{descricao:'Parcial'}]});
 const result=await f.documentProject(100);assert.equal(result.failed,0);assert.equal(result.applied,6);
 for(const row of(await f.db.query('select entity,source_id,document_id from erp_documents.origin_mirror')).rows)docs[row.source_id]={id:row.document_id,kind:row.entity};
});
after(async()=>{if(f)await f.close();});

test('projector creates all four observed kinds without native effects, and DTOs accept nulls',async()=>{
 for(const[id,{id:documentId,kind}]of Object.entries(docs)){
  const result=await get(documentId,kind),parsed=documentMirrorRecord(result.document,kind);
  assert.equal(parsed.readonly,true);assert.equal(parsed.origin,'origin');assert.equal(parsed.mirror.source_id,id);
  assert.equal(parsed.status,'source_unknown');
 }
 const partial=(await get(docs['2002'].id)).document;
 assert.equal(partial.total,null);assert.equal(partial.number,null);assert.equal(partial.contact_id,null);assert.equal(partial.items[0].quantity,null);
 for(const table of ['erp_stock.document_posting','erp_stock.reservation','erp_finance.document_posting','erp_finance.commission','erp_finance.commission_operation','erp_documents.item_cost_applied','erp_documents.freight_paid','erp_fiscal_drafts.draft','erp_fiscal_invoices.invoice_order','erp_purchase_receipts.receipt','erp_documents.service_event','erp_documents.service_journal_entry'])assert.equal(await f.scalar(`select count(*)::integer v from ${table}`),0,table);
});

test('list separates origins, preserves unknown totals, and supports explicit origin filters',async()=>{
 const all=await list();assert.equal(all.total_count,4);assert.equal(all.total_amount,null);
 assert.deepEqual(documentOriginTotals(all.origin_totals),{brufap:{count:1,known_total_count:1,total:'10.00'},origin:{count:3,known_total_count:2,total:null}});
 for(const row of all.items.filter(x=>x.origin==='origin'))documentMirrorSummary(row,'sales_orders');
 const brufap=await list('sales_orders',{p_origin:'brufap'});assert.equal(brufap.total_count,1);assert.equal(brufap.total_amount,'10.00');
 const origin=await list('sales_orders',{p_origin:'origin'});assert.equal(origin.total_count,3);assert.equal(origin.total_amount,null);
 await assert.rejects(()=>list('sales_orders',{p_origin:'invalid'}),e=>e.code==='22023');
});

test('seller wallet governs mirror list, search, direct details, history, export and labels',async()=>{
 const user=f.users.consulta;
 assert.equal((await list('sales_orders',{p_user_id:user,p_origin:'origin'})).total_count,1);
 assert.equal((await list('sales_orders',{p_user_id:user,p_query:'Observado 302'})).total_count,0);
 for(const source of ['2001','2002'])await assert.rejects(()=>get(docs[source].id,'sales_orders',user),e=>e.code==='P0002');
 assert.equal((await get(docs['1000'].id,'sales_orders',user)).document.id,docs['1000'].id);
 const exported=await f.rpc('erp_document_export',{p_user_id:user,p_kind:'sales_orders',p_date_from:'2026-10-22',p_date_to:'2026-10-22',p_page:1});
 assert.equal(exported.items.some(x=>x.id===docs['2001'].id),false);assert.equal(exported.items.filter(x=>x.origin==='origin').length,1);
 const labels=await f.rpc('erp_preferences_label_records',{p_user_id:user,p_type:'pedido_venda',p_query:null});
 assert.equal(labels.items.some(x=>x.id===docs['2001'].id||x.id===docs['2002'].id),false);
 const history=await f.rpc('erp_document_history',{p_user_id:user,p_kind:'sales_orders',p_contact_id:contactA.id});
 assert.equal(history.items.find(x=>x.document_id===docs['1000'].id).origin,'origin');
});

test('POS consumer exception cannot grant seller access to an unrelated mirror',async()=>{
 await f.db.query('update erp_pos.settings set consumer_contact_id=$1 where singleton',[contactB.id]);
 assert.equal(await f.scalar('select erp_documents.contact_usable($1,$2)v',[f.users.consulta,contactB.id]),true);
 await assert.rejects(()=>get(docs['2001'].id,'sales_orders',f.users.consulta),e=>e.code==='P0002');
});

test('GUC spoofing cannot modify documents/items or change external identity',async()=>{
 await f.db.exec("set erp_mirror.writer='document_mirror'");
 try{
  await denied(()=>f.db.query("update erp_documents.document set body=body||'{\"notes\":\"spoof\"}'where id=$1",[docs['1000'].id]));
  await denied(()=>f.db.query('delete from erp_documents.document where id=$1',[docs['1000'].id]));
  await denied(()=>f.db.query("update erp_documents.document set origin='brufap',authority='brufap'where id=$1",[docs['1000'].id]));
  await denied(()=>f.db.query("update erp_documents.item set data=data||'{\"description\":\"spoof\"}'where document_id=$1",[docs['1000'].id]));
  await denied(()=>f.db.query('delete from erp_documents.item where document_id=$1',[docs['1000'].id]));
 }finally{await f.db.exec('reset erp_mirror.writer');}
});

test('all direct effect FKs refuse mirror targets at the table boundary',async()=>{
 const rows=(await f.db.query(`select distinct c.conrelid::regclass::text relation,
  array(select a.attname from unnest(c.conkey)k(n)join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.n)cols
 from pg_constraint c where c.contype='f'and c.confrelid='erp_documents.document'::regclass
 and c.conrelid not in('erp_documents.document'::regclass,'erp_documents.item'::regclass,'erp_documents.origin_mirror'::regclass,'erp_document_mirror.revision'::regclass,'erp_documents.origin_import_origin'::regclass)`)).rows;
 const groups=new Map();for(const r of rows){if(!groups.has(r.relation))groups.set(r.relation,new Set());for(const col of r.cols)groups.get(r.relation).add(col);}
 assert.equal(groups.size,31);
 for(const[relation,set]of groups){const cols=[...set];await assert.rejects(()=>f.db.query(`insert into ${relation}(${cols.join(',')})values(${cols.map(()=>'$1').join(',')})`,[docs['1000'].id]),e=>e.code==='42501'&&e.message==='erp_document_mirror_effect_forbidden',relation);}
});

test('legacy effect and copy RPCs reject mirrors before malformed command/replay processing',async()=>{
 const names=['erp_document_save','erp_document_transition','erp_document_notes_save','erp_document_copy','erp_document_copy_preview','erp_document_conversion_preview','erp_document_proposal_version','erp_proposal_convert','erp_proposal_convert_to_service','erp_sales_order_convert_to_service','erp_document_finance_post','erp_document_finance_preview','erp_document_finance_reverse','erp_document_stock_post','erp_document_stock_preview','erp_document_stock_reverse','erp_stock_reservation_apply','erp_stock_reservation_preview','erp_purchase_receipts_receive','erp_purchase_receipts_preview','erp_document_checkout_save','erp_document_freight_paid_save','erp_fiscal_invoice_partial_create','erp_service_event_append','erp_service_journal_append'];
 for(const name of names){
  const args=(await f.db.query(`select p.proargnames names, array(select format_type(x,null)from unnest(p.proargtypes::oid[])x)types from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname=$1`,[name])).rows[0];
  const values=Object.fromEntries(args.names.map((key,i)=>[key,key==='p_user_id'?f.users.admin:['p_document_id','p_source_id','p_proposal_id','p_id'].includes(key)&&args.types[i]==='uuid'?docs['1000'].id:key==='p_kind'?'sales_orders':null]));
  await denied(()=>f.rpc(name,values));
 }
});

test('legacy imports cannot reimport an existing mirror, including replay requests',async()=>{
 for(const name of ['erp_origin_proposal_import_apply','erp_origin_proposal_import_apply_v2'])await denied(()=>f.rpc(name,{p_user_id:f.users.admin,p_source_id:'1001',p_preview_hash:null,p_command_id:randomUUID(),p_confirm_import:true,p_duplicate_reviewed:true}));
 await denied(()=>f.db.query("insert into erp_documents.origin_import_origin(entity,source_id,document_id)values('sales_proposals','1001',$1)",[native.id]));
});

test('duplicate external numbers paginate deterministically without loss or repetition',async()=>{
 for(const order of ['number_asc','number_desc','date_asc','date_desc']){
  const ids=[];let after=null;
  do{const page=await list('sales_orders',{p_origin:'origin',p_order:order,p_limit:1,...(after?{p_after:after}:{})});ids.push(...page.items.map(x=>x.id));after=page.has_more?page.next_cursor:null;}while(after&&ids.length<10);
  assert.equal(ids.length,3,order);assert.equal(new Set(ids).size,3,order);
 }
});

test('native documents remain editable, native numbering ignores mirror numbers and reports declare coverage',async()=>{
 const result=await f.rpc('erp_document_notes_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:native.id,p_expected_version:native.version,p_command_id:randomUUID(),p_notes:'Nota nativa',p_internal_notes:null});
 assert.equal(result.document.origin,'brufap');
 const numbering=await f.rpc('erp_document_next_number',{p_user_id:f.users.admin,p_kind:'sales_orders'});
 assert.equal(numbering.minimum_next_number,'2');
 const abc=await f.rpc('erp_document_sales_abc',{p_user_id:f.users.admin,p_from:'2026-10-22',p_to:'2026-10-22'});
 assert.equal(abc.total,'10.00');assert.equal(abc.origin,'brufap');assert.equal(abc.mirror_excluded_count,3);assert.equal(abc.coverage.partial,true);
 const report=await f.rpc('erp_document_sales_report',{p_user_id:f.users.admin,p_filters:{from:'2026-10-22',to:'2026-10-22'}});
 assert.equal(report.totals.amount,'10.00');assert.equal(report.origin,'brufap');assert.equal(report.coverage.partial,true);
 const service=await f.rpc('erp_document_service_report',{p_user_id:f.users.admin,p_conditions:[]});assert.equal(service.row_count,0);assert.equal(service.mirror_excluded_count,1);
});

test('new observations update current mirror and immutable revisions while source deletions disappear from lists',async()=>{
 await f.stage('sales_orders','1000',{...payload('1000','301','30.17'),_brufap_source:{deleted:true}});
 const result=await f.documentProject(100);assert.equal(result.failed,0);assert.equal(result.applied,1);
 const current=(await get(docs['1000'].id)).document;assert.equal(current.total,'30.17');assert.equal(current.version,2);assert.equal(current.mirror.source_deleted,true);
 assert.equal((await list('sales_orders',{p_origin:'origin'})).total_count,2);
 assert.equal(await f.scalar("select count(*)::integer v from erp_document_mirror.revision where entity='sales_orders'and source_id='1000'"),2);
});

test('private guards and writer capabilities cannot be called by authenticated or service roles',async()=>{
 assert.equal(await f.scalar("select pg_has_role('service_role','erp_document_mirror_writer','MEMBER')v"),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_document_mirror.apply(erp_document_mirror.source_version,uuid,timestamptz)','EXECUTE')v"),false);
 assert.equal(await f.scalar("select has_table_privilege('erp_document_mirror_writer','erp_finance.title','INSERT')v"),false);
 for(const role of ['anon','authenticated'])assert.equal(await f.scalar("select has_table_privilege($1,'erp_documents.document','SELECT')v",[role]),false);
});

test('JSON fiscal, grouped billing and trash commands reject mirrors before replay or downstream work',async()=>{
 await denied(()=>f.rpc('erp_fiscal_draft_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:docs['1000'].id}}));
 await denied(()=>f.rpc('erp_fiscal_invoice_link',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_data:{document_id:docs['1000'].id}}));
 await denied(()=>f.rpc('erp_finance_grouped_billing_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'grouped_billing_generate',p_data:{items:[{document_ids:[docs['1000'].id]}]}}));
 await denied(()=>f.rpc('erp_document_trash',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'sales_orders',p_action:'delete',p_ids:[docs['1000'].id],p_reason:'Teste de proteção'}));
});

test('mirror access capability and native Home coverage obey module permissions as well as seller scope',async()=>{
 assert.equal((await f.rpc('erp_document_access',{p_user_id:f.users.admin})).mirror_available,true);
 const summary=await f.rpc('erp_home_summary',{p_user_id:f.users.admin});assert.equal(summary.origin,'brufap');assert.equal(summary.coverage.partial,true);
 assert.equal(summary.mirror_excluded_count,5); // One sales source was removed; remaining kinds still count.
 await f.db.query("insert into erp_access.user_control(user_id,user_type,schedule_enabled,windows,permissions,version,updated_at,updated_by)values($1,'normal',false,'[]',array['vendas.pedidos_venda'],1,clock_timestamp(),$2)",[f.users.consulta,f.users.admin]);
 const limited=await f.scalar('select erp_document_mirror.report_coverage($1,null,null,null)v',[f.users.consulta]);
 assert.equal(limited.mirror_excluded_count,0); // Visible sales was removed; proposals, purchases and OS require their own cards.
 await f.db.query('delete from erp_access.user_control where user_id=$1',[f.users.consulta]);
});

test('detail, list totals, history and print preserve source precision beyond native numeric columns',async()=>{
 const total='123.456789012345678901',quantity='1.1234567',price='0.12345678901234567890123456789';
 await f.stage('sales_orders','2001',{...payload('2001','302',total),itens:[{descricao:'Exato',quantidade:quantity,valor:price,valorTotal:total}]});
 assert.equal((await f.documentProject()).failed,0);
 const current=(await get(docs['2001'].id)).document;assert.equal(current.total,total);assert.equal(current.items[0].quantity,quantity);assert.equal(current.items[0].unit_price,price);
 const page=await list('sales_orders',{p_origin:'origin',p_query:'Observado 302'});assert.equal(page.origin_totals.origin.total,total);assert.equal(page.total_amount,null);
 const exported=await f.rpc('erp_document_export',{p_user_id:f.users.admin,p_kind:'sales_orders',p_date_from:'2026-10-22',p_date_to:'2026-10-22',p_page:1});
 const printed=exported.items.find(x=>x.id===docs['2001'].id);assert.equal(printed.total,total);assert.equal(printed.items[0].quantity,quantity);assert.equal(printed.items[0].unit_price,price);assert.equal(printed.items[0].total,total);
 const history=await f.rpc('erp_document_history',{p_user_id:f.users.admin,p_kind:'sales_orders',p_contact_id:contactB.id});
 const observed=history.items.find(x=>x.document_id===docs['2001'].id);assert.equal(observed.quantity,quantity);assert.equal(observed.unit_price,price);
});

test('source ID, nonnumeric source number and observed status are searchable within the seller wallet',async()=>{
 await f.stage('sales_orders','94001',{...payload('94001','301'),numero:'External #AB-77',situacao:{id:994,nome:'Aguardando triagem externa'}});
 assert.equal((await f.documentProject()).failed,0);
 for(const query of ['94001','ab-77','TRIAGEM','994']){
  const result=await list('sales_orders',{p_user_id:f.users.consulta,p_origin:'origin',p_query:query});
  assert.equal(result.total_count,1,query);assert.equal(result.items[0].mirror.source_id,'94001');
 }
 assert.equal((await list('sales_orders',{p_origin:'origin',p_query:'2001'})).total_count,1);
 assert.equal((await list('sales_orders',{p_user_id:f.users.consulta,p_origin:'origin',p_query:'2001'})).total_count,0);
});

test('stock source lot reads reject the POS wallet exception and never advertise writes for a mirror',async()=>{
 const product=await f.catalog('products',{name:'Produto de lotes',code:'LOTE-SYNTH',unit:'UN',kind:'P',format:'S',price:'1'});
 await assert.rejects(()=>f.rpc('erp_stock_source_lots',{p_user_id:f.users.consulta,p_source:'document',p_source_id:docs['2001'].id,p_product_id:product.id}),e=>e.code==='P0002');
 const mirror=await f.rpc('erp_stock_source_lots',{p_user_id:f.users.admin,p_source:'document',p_source_id:docs['2001'].id,p_product_id:product.id});
 assert.equal(mirror.can_write,false);assert.equal(mirror.posted,false);assert.deepEqual(mirror.lines,[]);
 const operational=await f.rpc('erp_stock_source_lots',{p_user_id:f.users.admin,p_source:'document',p_source_id:native.id,p_product_id:product.id});assert.equal(operational.can_write,true);
});

test('custom commercial reports and contact history explicitly identify the native coverage',async()=>{
 const run=base=>f.rpc('erp_preferences_report_run',{p_user_id:f.users.admin,p_base:base,p_columns:base==='produtos'?['codigo']:['numero','total'],p_filters:[],p_view_limit:2000,p_offset:0,p_page:20});
 const sales=await run('vendas');assert.equal(sales.origin,'brufap');assert.equal(sales.mirror_excluded_count,3);assert.equal(sales.coverage.partial,true);assert.equal(sales.total_rows,1);
 const products=await run('produtos');assert.equal(Object.hasOwn(products,'origin'),false);assert.equal(Object.hasOwn(products,'coverage'),false);
 for(const name of ['erp_catalog_contact_sales','erp_catalog_contact_history']){
  const result=await f.rpc(name,{p_user_id:f.users.admin,p_contact_id:contactA.id,...(name.endsWith('_history')?{p_kind:'sales_orders'}:{})});
  assert.equal(result.origin,'brufap');assert.equal(result.mirror_excluded_count,1);assert.equal(result.coverage.partial,true);assert.equal(result.items.length,1);assert.equal(result.items[0].id,native.id);
 }
});
