import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,migrationSql,fails} from './helpers/stock-lane-e-fixture.mjs';

// 259 on PGlite (every migration published up to 233, then the lane E files) with synthetic data only: Lançar estoque / Estornar
// estoque by the Brufap notes (letter E: S by the note, R by the reference), the check-in that posts the received quantities, the
// extrato origin "Notas Fiscais" and the pedidos that do not post again.
let f,saleNature,buyNature;
before(async()=>{
 f=await stockLaneEFixture({upto:2});
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1) on conflict do nothing",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1) on conflict do nothing",[f.users.admin]);
 const nature=async data=>(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
 saleNature=await nature({description:'Venda sintética 259',direction:'1',crt:'1'});buyNature=await nature({description:'Compra sintética 259',direction:'0',crt:'1',presence:'9'});
});
after(()=>f?.close());
let numbers=900000;
const line=(product,quantity,price='10',over={})=>({product_id:product?.id??null,description:over.description??'Item sintético',code:'S-1',unit:'UN',quantity,unit_price:price,...over});
const note=async(direction,items,{orders=[],model='55',...over}={})=>{
 const total=items.reduce((sum,i)=>sum+Number(i.quantity)*Number(i.unit_price),0).toFixed(2);
 const data={model,direction,issue_type:model==='65'?'C':direction==='0'?'T':'N',series:'1',...(direction==='0'?{number:String(++numbers)}:{}),nature_id:direction==='1'?saleNature.id:buyNature.id,
  issue_date:'2026-10-20',crt:'1',purpose:'1',presence:direction==='1'?'1':'9',final_consumer:model==='65',recipient:{name:'Contato sintético 259',person_type:'J',document:'12345678000190',state:'SP'},
  items,payment:{installments:[{date:'2026-11-20',amount:total}]},...over};
 return(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:data,orders}})).invoice;};
const version=async id=>f.scalar('select version v from erp_fiscal_invoices.invoice where id=$1',[id]);
const preview=async(invoice,warehouse,{user=f.users.estoque}={})=>(await f.rpc('erp_stock_invoice_preview',{p_user_id:user,p_invoice_id:invoice,p_expected_version:await version(invoice),p_warehouse_id:warehouse})).preview;
const post=async(invoice,warehouse,{user=f.users.estoque,command=randomUUID(),prior=null}={})=>{const p=prior??await preview(invoice,warehouse,{user});
 return f.rpc('erp_stock_invoice_post',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:await version(invoice),p_warehouse_id:warehouse,p_preview_hash:p.preview_hash});};
const flags=(ids,user=f.users.fiscal)=>f.rpc('erp_stock_invoice_flags',{p_user_id:user,p_ids:ids});
const reverse=async(invoice,{user=f.users.estoque,command=randomUUID()}={})=>{const g=await f.rpc('erp_stock_invoice_get',{p_user_id:user,p_invoice_id:invoice});
 const posting=g.flag;const p=(await f.rpc('erp_stock_invoice_reverse_preview',{p_user_id:user,p_invoice_id:invoice,p_posting_id:posting.posting_id,p_posting_version:posting.posting_version})).preview;
 return{preview:p,result:await f.rpc('erp_stock_invoice_reverse',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_posting_id:posting.posting_id,p_posting_version:posting.posting_version,p_preview_hash:p.preview_hash})};};
const ledger=(product,user=f.users.admin,origin=null)=>f.rpc('erp_stock_ledger',{p_user_id:user,p_product_id:product,p_warehouse_id:null,p_kind:null,p_origin:origin,p_date_from:null,p_date_to:null,p_limit:100,p_offset:0,p_direction:null});

test('259 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_invoice_flags(uuid,jsonb)','public.erp_stock_invoice_get(uuid,uuid)','public.erp_stock_invoice_preview(uuid,uuid,integer,uuid)',
  'public.erp_stock_invoice_post(uuid,uuid,uuid,integer,uuid,text)','public.erp_stock_invoice_reverse_preview(uuid,uuid,uuid,integer)','public.erp_stock_invoice_reverse(uuid,uuid,uuid,uuid,integer,text)',
  'public.erp_stock_checkin_post_preview(uuid,uuid,integer,uuid)','public.erp_stock_checkin_finish_post(uuid,uuid,uuid,integer,uuid,text)',
  'public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)','public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['erp_stock.invoice_posting','erp_stock.invoice_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='${table}'::regclass`),true,table);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','${table}','SELECT') v`),false,table);
 }
 for(const internal of['erp_stock.invoice_preview_data(erp_fiscal_invoices.invoice,uuid,text,jsonb)','erp_stock.invoice_flag(uuid)','erp_stock.invoice_posted_for_document(uuid)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200259_stock_invoice_postings.sql')),/stock_invoice_postings_259_previous_definition_changed/);await f.db.exec('rollback');
});

test('259 Lançar estoque of an exit note: prévia, one movement, letter S, replay, conflicts, extrato origin and the reversal',async()=>{
 const depot=await f.warehouse('Depósito nota saída');
 const a=await f.product('Peça nota A',{price:'10'}),b=await f.product('Peça nota B'),service=await f.product('Serviço nota',{kind:'S'});
 await f.launch(a.id,depot.id,'receipt','10');await f.launch(b.id,depot.id,'receipt','10');
 const exit=await note('1',[line(a,'2','12.5'),line(a,'1','12.5'),line(b,'3'),line(service,'1','50'),line(null,'1','5',{description:'Frete avulso'})]);
 const p=await preview(exit.id,depot.id);
 assert.equal(p.direction,'issue');assert.equal(p.reason,`Lançamento de estoque da NF-e ${p.invoice.label.slice(5)}`);
 assert.deepEqual(p.positions.map(x=>[x.product_id,x.quantity,x.balance_after]).sort(),[[a.id,'-3.000000','7.000000'],[b.id,'-3.000000','7.000000']].sort());
 assert.deepEqual(p.ignored.map(i=>i.reason),['service','unlinked_item']);
 // Readers see the state; only stock writers post.
 for(const user of[f.users.vendas,f.users.consulta,f.users.financeiro])await assert.rejects(f.rpc('erp_stock_invoice_get',{p_user_id:user,p_invoice_id:exit.id}),fails('42501'));
 await assert.rejects(preview(exit.id,depot.id,{user:f.users.fiscal}),fails('42501'));
 const command=randomUUID(),posted=await post(exit.id,depot.id,{command,prior:p});
 assert.equal(posted.replayed,false);assert.equal(posted.flag.flag,'S');assert.equal(posted.flag.warehouse.id,depot.id);
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id)],['7.000000','7.000000']);
 const replay=await f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:command,p_invoice_id:exit.id,p_expected_version:await version(exit.id),p_warehouse_id:depot.id,p_preview_hash:p.preview_hash});
 assert.equal(replay.replayed,true);assert.equal(replay.posting.id,posted.posting.id);
 await assert.rejects(f.rpc('erp_stock_invoice_post',{p_user_id:f.users.admin,p_command_id:command,p_invoice_id:exit.id,p_expected_version:await version(exit.id),p_warehouse_id:depot.id,p_preview_hash:p.preview_hash}),fails('40001'));
 await assert.rejects(post(exit.id,depot.id,{prior:p}),fails('40001'),'already posted');
 assert.deepEqual((await flags([exit.id])).items.map(i=>[i.invoice_id,i.flag,i.warehouse.name]),[[exit.id,'S','Depósito nota saída']]);
 // Extrato: origem Notas Fiscais with the note; the price of the note for admin and fiscal only.
 const row=(await ledger(a.id)).items.find(r=>r.id===posted.movement.id);
 assert.deepEqual([row.origin.type,row.origin.document_id,row.origin.document_kind,row.origin.via],['invoices',exit.id,'nfe_saida','invoice_stock']);
 assert.deepEqual([row.unit_price,row.price_source],['12.5000000000','document']);
 const hidden=(await ledger(a.id,f.users.estoque)).items.find(r=>r.id===posted.movement.id);assert.deepEqual([hidden.unit_price,hidden.price_source],[null,null]);
 assert.equal((await ledger(a.id,f.users.admin,'invoices')).total,1);
 // The extrato never reverses it: the note does.
 await assert.rejects(f.reverse(posted.movement.id),error=>error.code==='40001'&&/reverse_via_invoice/.test(error.message));
 const {preview:rp,result}=await reverse(exit.id);
 assert.equal(rp.reason,`Estorno do estoque da ${rp.invoice.label}`);assert.equal(result.flag.flag,null);assert.equal(result.posting.state,'reversed');
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id)],['10.000000','10.000000']);
 assert.equal((await ledger(a.id,f.users.admin,'invoices')).total,2,'the reversal keeps the note origin');
 // A note can post again after the reversal; the history keeps both postings.
 await post(exit.id,depot.id);
 const state=await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.fiscal,p_invoice_id:exit.id});
 assert.deepEqual([state.flag.flag,state.postings.length,state.can_manage,state.block],['S',2,false,'posted']);
 await assert.rejects(f.db.query("update erp_stock.invoice_posting set warehouse_id=warehouse_id where invoice_id=$1",[exit.id]),/erp_invoice_stock_immutable/);
 await assert.rejects(f.db.query('delete from erp_stock.invoice_command where invoice_id=$1',[exit.id]),/erp_stock_immutable_ledger/);
});

test('259 note rules: version CAS, cancelled or deleted notes, negative policy, unit and compositions, NFC-e and the date preference',async()=>{
 const depot=await f.warehouse('Depósito regras nota');
 const a=await f.product('Peça regra nota');await f.launch(a.id,depot.id,'receipt','2');
 const exit=await note('1',[line(a,'5')]);
 await assert.rejects(preview(exit.id,depot.id),fails('22023'),'the policy forbids negative stock');
 await f.setPolicy(true);
 const p=await preview(exit.id,depot.id);
 await assert.rejects(f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:exit.id,p_expected_version:(await version(exit.id))+1,p_warehouse_id:depot.id,p_preview_hash:p.preview_hash}),fails('40001'));
 await assert.rejects(f.rpc('erp_stock_invoice_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:exit.id,p_expected_version:await version(exit.id),p_warehouse_id:depot.id,p_preview_hash:'0'.repeat(64)}),fails('40001'));
 await post(exit.id,depot.id,{prior:p});assert.equal(await f.balance(a.id,depot.id),'-3.000000');
 await reverse(exit.id);await f.setPolicy(false);
 // Unit of the item different from the product's.
 const box=await note('1',[line(a,'1','10',{unit:'CX'})]);
 await assert.rejects(preview(box.id,depot.id),error=>/unit_mismatch/.test(error.message));
 // A composition leaves by its components; an entry note does not receive compositions.
 const c=await f.product('Componente nota');await f.launch(c.id,depot.id,'receipt','10');
 const kit=await f.kit('Kit nota',[[c,'2']]);
 const kitNote=await note('1',[line(kit,'3')]);
 const kp=await preview(kitNote.id,depot.id);
 assert.deepEqual(kp.positions.map(x=>[x.product_id,x.quantity]),[[c.id,'-6.000000']]);assert.equal(kp.positions[0].sources[0].kit_product_id,kit.id);
 const entryKit=await note('0',[line(kit,'1')]);
 await assert.rejects(preview(entryKit.id,depot.id),error=>/composition_unsupported/.test(error.message));
 // NFC-e: model 65 posts as an exit with its own label.
 const nfce=await note('1',[line(a,'1')],{model:'65',presence:'1'});
 const np=await preview(nfce.id,depot.id);assert.match(np.invoice.label,/^NFC-e/);assert.deepEqual([np.invoice.screen,np.direction],['nfce','issue']);
 // "Ao lançar estoque utilizar data atual ou data entrada/saída".
 await f.setPreferences('suprimentos-estoque',{'estoque.data_lancamento':'data_documento'});
 const dated=await note('1',[line(a,'1')],{issue_date:'2026-10-15'});
 assert.equal((await preview(dated.id,depot.id)).occurred_on,'2026-10-15');
 await f.setPreferences('suprimentos-estoque',{'estoque.data_lancamento':'data_atual'});
 // A cancelled (3) or deleted note does not post.
 const cancelled=await note('1',[line(a,'1')]);
 await f.db.query('update erp_fiscal_invoices.invoice set status=3,version=version+1 where id=$1',[cancelled.id]);
 await assert.rejects(preview(cancelled.id,depot.id),error=>error.code==='40001'&&/ineligible/.test(error.message));
 assert.equal((await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.fiscal,p_invoice_id:cancelled.id})).block,'cancelled');
 const gone=await note('1',[line(a,'1')]);
 await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'delete',p_data:{id:gone.id,expected_version:gone.version,reason:'Nota sintética excluída'}});
 await assert.rejects(preview(gone.id,depot.id),error=>error.code==='40001'&&/ineligible/.test(error.message));
});

test('259 entry note: Entrada by the note feeds the custo médio; the purchase order linked to it does not receive again (and R the other way)',async()=>{
 const depot=await f.warehouse('Depósito nota entrada');
 const a=await f.product('Insumo nota entrada');
 const purchase=await f.order('purchase_orders',[f.item(a,'4','7')],depot.id);
 const entry=await note('0',[line(a,'4','8.5')],{orders:[purchase.id]});
 const posted=await post(entry.id,depot.id);
 assert.equal(posted.posting.direction,'receipt');assert.equal(await f.balance(a.id,depot.id),'4.000000');
 const averages=await f.rows('select average_cost::text c from erp_stock.average_costs($1::uuid[])',[[a.id]]);
 assert.equal(averages[0].c,'8.5000000000','the price of the note item');
 // The purchase order of the note neither posts nor receives the same stock again.
 const receive=await f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:purchase.id,p_expected_version:purchase.version,p_warehouse_id:depot.id,
  p_occurred_on:'2026-10-20',p_reason:'Recebimento sintético',p_items:[]}).catch(e=>e);
 assert.ok(receive.code==='22023'||/posted_by_invoice/.test(receive.message??''),'refused');
 const items=await f.rows('select id from erp_documents.item where document_id=$1',[purchase.id]);
 await assert.rejects(f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:purchase.id,p_expected_version:purchase.version,p_warehouse_id:depot.id,
  p_occurred_on:'2026-10-20',p_reason:'Recebimento sintético',p_items:[{item_id:items[0].id,quantity:'4'}]}),error=>/posted_by_invoice/.test(error.message));
 // R: a note whose pedido received the stock is "lançado pela referência" and does not post.
 await reverse(entry.id);
 const second=await f.order('purchase_orders',[f.item(a,'2','7')],depot.id);
 const secondItems=await f.rows('select id from erp_documents.item where document_id=$1',[second.id]);
 const rp=(await f.rpc('erp_stock_purchase_receive_preview',{p_user_id:f.users.estoque,p_document_id:second.id,p_expected_version:second.version,p_warehouse_id:depot.id,p_occurred_on:'2026-10-20',p_reason:'Recebimento sintético',
  p_items:[{item_id:secondItems[0].id,quantity:'2'}]})).preview;
 await f.rpc('erp_stock_purchase_receive',{p_user_id:f.users.estoque,p_document_id:second.id,p_expected_version:second.version,p_warehouse_id:depot.id,p_occurred_on:'2026-10-20',p_reason:'Recebimento sintético',
  p_items:[{item_id:secondItems[0].id,quantity:'2'}],p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_confirm:true});
 const byReference=await note('0',[line(a,'2','7')],{orders:[second.id]});
 const flag=(await flags([byReference.id])).items[0];
 assert.deepEqual([flag.flag,flag.reference.document_id,flag.reference.via,flag.warehouse.id],['R',second.id,'purchase_receipt',depot.id]);
 await assert.rejects(preview(byReference.id,depot.id),error=>/posted_by_reference/.test(error.message));
});

test('259 exit note linked to a sales order: S keeps the order from posting and from the reserva pelas situações; R the other way',async()=>{
 const depot=await f.warehouse('Depósito nota pedido');
 const a=await f.product('Peça nota pedido');await f.launch(a.id,depot.id,'receipt','10');
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['verificado']});
 const sale=await f.transition(await f.order('sales_orders',[f.item(a,'3')],depot.id),'verified');
 const reserved=async()=>f.scalar('select coalesce(sum(quantity),0)::numeric(18,6)::text v from erp_stock.situation_reservations($1) where document_id=$2',[a.id,sale.id]);
 assert.equal(await reserved(),'3.000000');
 const exit=await note('1',[line(a,'3')],{orders:[sale.id]});
 await post(exit.id,depot.id);
 assert.equal(await reserved(),'0.000000','the note posted the stock of the order');
 await assert.rejects(f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética'}),
  error=>/posted_by_invoice/.test(error.message));
 await reverse(exit.id);
 // The order posts its own stock: the note becomes R and hides its reversal.
 const dp=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_preview_hash:dp.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Baixa sintética',p_ignored_item_ids:[]});
 const flag=(await flags([exit.id])).items[0];
 assert.deepEqual([flag.flag,flag.reference.kind,flag.reference.via,flag.warehouse.id],['R','sales_orders','document_stock',depot.id]);
 const state=await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:exit.id});assert.equal(state.block,'reference');
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false,'estoque.reserva_situacoes':[]});
});

test('259 Estornar estoque of a note after a Balanço with "Considerar estorno ..." off keeps the balance (224 rule)',async()=>{
 const depot=await f.warehouse('Depósito estorno nota');
 const a=await f.product('Peça estorno nota');await f.launch(a.id,depot.id,'receipt','10');
 const exit=await note('1',[line(a,'4')]);await post(exit.id,depot.id);
 await f.launch(a.id,depot.id,'balance','5');
 await f.setPreferences('suprimentos-estoque',{'estoque.estorno_balanco':false});
 const {preview:rp,result}=await reverse(exit.id);
 assert.equal(rp.positions[0].balance_kept,true);assert.equal(result.balance_adjustments.length,1);
 assert.equal(await f.balance(a.id,depot.id),'5.000000','the balance of the Balanço stays');
 await f.setPreferences('suprimentos-estoque',{'estoque.estorno_balanco':true});
});

test('259 Check-in de Recebimentos: Finalizar with Lançar estoque posts the Qtde Recebida (refused items out) in one command',async()=>{
 const depot=await f.warehouse('Depósito check-in');
 const a=await f.product('Peça check-in A'),b=await f.product('Peça check-in B'),c=await f.product('Peça check-in C');
 const entry=await note('0',[line(a,'5','3'),line(b,'2','4'),line(c,'1','9')]);
 const checkin=(fn,args)=>f.rpc(fn,{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:entry.id,...args});
 let state=await checkin('erp_stock_checkin_save',{p_expected_version:0,p_items:[{position:1,received:'4'},{position:2,received:'2'}]});
 state=await checkin('erp_stock_checkin_issue',{p_expected_version:state.version,p_position:3,p_kind:'refused',p_quantity:null,p_action:'none'});
 const pv=await f.rpc('erp_stock_checkin_post_preview',{p_user_id:f.users.estoque,p_invoice_id:entry.id,p_expected_version:state.version,p_warehouse_id:depot.id});
 assert.deepEqual(pv.preview.positions.map(x=>[x.product_id,x.quantity]).sort(),[[a.id,'4.000000'],[b.id,'2.000000']].sort());
 assert.equal(pv.preview.source,'checkin');assert.match(pv.preview.reason,/^Check-in de recebimento da NF-e/);
 await assert.rejects(f.rpc('erp_stock_checkin_post_preview',{p_user_id:f.users.estoque,p_invoice_id:entry.id,p_expected_version:state.version+1,p_warehouse_id:depot.id}),fails('40001'));
 const command=randomUUID();
 const done=await f.rpc('erp_stock_checkin_finish_post',{p_user_id:f.users.estoque,p_command_id:command,p_invoice_id:entry.id,p_expected_version:state.version,p_warehouse_id:depot.id,p_preview_hash:pv.preview.preview_hash});
 assert.equal(done.replayed,false);assert.equal(done.checkin.checkin.state,'finished');assert.deepEqual([done.flag.flag,done.flag.source],['S','checkin']);
 assert.deepEqual([await f.balance(a.id,depot.id),await f.balance(b.id,depot.id),await f.balance(c.id,depot.id)],['4.000000','2.000000',undefined]);
 const replay=await f.rpc('erp_stock_checkin_finish_post',{p_user_id:f.users.estoque,p_command_id:command,p_invoice_id:entry.id,p_expected_version:state.version,p_warehouse_id:depot.id,p_preview_hash:pv.preview.preview_hash});
 assert.equal(replay.replayed,true);assert.equal(replay.posting.id,done.posting.id);
 // A finished check-in finishes once; the note can still be reversed from its menu.
 await assert.rejects(f.rpc('erp_stock_checkin_post_preview',{p_user_id:f.users.estoque,p_invoice_id:entry.id,p_expected_version:done.checkin.version,p_warehouse_id:depot.id}),fails('40001'));
 await reverse(entry.id);assert.equal(await f.balance(a.id,depot.id),'0.000000');
 // Nothing received: nothing to post.
 const empty=await note('0',[line(a,'1')]);
 const fresh=await f.rpc('erp_stock_checkin_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:empty.id,p_expected_version:0,p_items:[{position:1,received:'1'}]});
 const zero=await f.rpc('erp_stock_checkin_save',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_invoice_id:empty.id,p_expected_version:fresh.version,p_items:[{position:1,received:'0'}]});
 await assert.rejects(f.rpc('erp_stock_checkin_post_preview',{p_user_id:f.users.estoque,p_invoice_id:empty.id,p_expected_version:zero.version,p_warehouse_id:depot.id}),error=>/nothing_received/.test(error.message));
 await assert.rejects(f.rpc('erp_stock_checkin_post_preview',{p_user_id:f.users.fiscal,p_invoice_id:empty.id,p_expected_version:zero.version,p_warehouse_id:depot.id}),fails('42501'));
});

// Review of wave E: the reservation of the linked pedido, the note deleted with its stock posted, a cancelled note that keeps its
// posting and the check-in preference.
test('259 a linked sales order with an active reservation (070) keeps the note from posting until the reservation leaves',async()=>{
 const depot=await f.warehouse('Depósito nota reservada');
 const a=await f.product('Peça nota reservada');await f.launch(a.id,depot.id,'receipt','10');
 const sale=await f.transition(await f.order('sales_orders',[f.item(a,'3')],depot.id),'verified');
 const reservation=(action,doc,extra={})=>f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:doc.id,p_expected_version:doc.version,p_action:action,p_occurred_on:'2026-10-20',p_reason:'Reserva sintética',...extra});
 const rp=(await reservation('reserve',sale)).preview;
 const reserved=await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:rp.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Reserva sintética',p_ignored_item_ids:[]});
 const exit=await note('1',[line(a,'3')],{orders:[sale.id]});
 assert.equal((await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:exit.id})).block,'reserved');
 await assert.rejects(preview(exit.id,depot.id),error=>error.code==='40001'&&/reserved_document/.test(error.message));
 // Releasing the reservation lets the note post its stock (and the pedido then neither reserves nor posts it again).
 const current=await f.rpc('erp_stock_reservation_get',{p_user_id:f.users.estoque,p_document_id:sale.id});
 const doc={id:sale.id,version:await f.scalar('select version v from erp_documents.document where id=$1',[sale.id])};
 const active=current.active_reservation??current.current?.active_reservation??reserved.current?.active_reservation;
 const release=(await reservation('release',doc,{p_reservation_id:active.id,p_reservation_version:active.version})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_action:'release',p_preview_hash:release.preview_hash,
  p_occurred_on:'2026-10-20',p_reason:'Reserva sintética',p_reservation_id:active.id,p_reservation_version:active.version});
 assert.equal((await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:exit.id})).block,null);
 await post(exit.id,depot.id);assert.equal(await f.balance(a.id,depot.id),'7.000000');
 await reverse(exit.id);
});

test('259 a note with its stock posted is not deleted before Estornar estoque; a cancelled note keeps its posting and is reversed',async()=>{
 const depot=await f.warehouse('Depósito nota excluída');
 const a=await f.product('Peça nota excluída');await f.launch(a.id,depot.id,'receipt','5');
 const exit=await note('1',[line(a,'2')]);await post(exit.id,depot.id);
 const remove=async()=>f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'delete',p_data:{id:exit.id,expected_version:await version(exit.id),reason:'Nota sintética excluída'}});
 await assert.rejects(remove(),error=>error.code==='40001'&&/erp_invoice_stock_posted_delete/.test(error.message));
 // Cancelada: the letter stays S and the block says cancelled; the reversal goes on from the note.
 await f.db.query('update erp_fiscal_invoices.invoice set status=3,version=version+1 where id=$1',[exit.id]);
 const state=await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:exit.id});
 assert.deepEqual([state.flag.flag,state.block],['S','cancelled']);
 await reverse(exit.id);assert.equal(await f.balance(a.id,depot.id),'5.000000');
 // After the reversal the note can be deleted (by its own rules); here only the guard is exercised.
 await f.db.query('update erp_fiscal_invoices.invoice set deleted_at=clock_timestamp(),deleted_by=$2,delete_reason=$3,version=version+1 where id=$1',[exit.id,f.users.admin,'Nota sintética excluída']);
 assert.equal((await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:exit.id})).block,'deleted');
});

test('259 "Lançar estoque ao finalizar Check-in na NF de Entrada" travels with the stock state of the note',async()=>{
 const a=await f.product('Peça preferência check-in');
 const entry=await note('0',[line(a,'1')]);
 const get=async()=>(await f.rpc('erp_stock_invoice_get',{p_user_id:f.users.estoque,p_invoice_id:entry.id})).checkin_post;
 assert.equal(await get(),false);
 await f.setPreferences('notas-nfe',{'nfe.estoque_checkin':true});assert.equal(await get(),true);
 await f.setPreferences('notas-nfe',{'nfe.estoque_checkin':false});assert.equal(await get(),false);
});
