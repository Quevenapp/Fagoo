import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFixture,fails} from './helpers/stock-lane-b-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 147 on PGlite with synthetic data only: Check-in de Recebimentos over the native entry notes (112).
let f,nature,saleNature;
before(async()=>{
 f=await stockLaneFixture();
 await f.db.query("insert into erp_company.identity(singleton,version,data,updated_by) values(true,1,'{\"state\":\"SP\",\"cnpj\":\"11222333000181\"}',$1)",[f.users.admin]);
 await f.db.query("insert into erp_company.fiscal(singleton,version,crt,confirmed_at,confirmed_by) values(true,1,'1',now(),$1)",[f.users.admin]);
 const natures=async data=>(await f.rpc('erp_fiscal_nature_execute',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_action:'create',p_data:{nature:data}})).nature;
 nature=await natures({description:'Compra sintética',direction:'0',crt:'1',presence:'9'});
 saleNature=await natures({description:'Venda sintética',direction:'1',crt:'1',presence:'1',rules:[{tax:'icms',data:{situation:'102',cfop:'5102'}}]});
});
after(()=>f?.close());
const line=(product,quantity,price,over={})=>({product_id:product?.id??null,description:over.description??'Peça sintética',code:'F-1',unit:'UN',quantity,unit_price:price,ncm:'84713012',cfop:'1102',
 icms:{origin:'0',situation:'102'},pis:{situation:'49'},cofins:{situation:'49'},...over});
const noteData=(items,over={})=>({model:'55',direction:'0',issue_type:'T',series:'1',number:over.number??String(100+Math.floor(Math.random()*800000)),nature_id:nature.id,issue_date:'2026-10-20',crt:'1',purpose:'1',
 presence:'9',final_consumer:false,recipient:{name:'Fornecedor sintético',person_type:'J',document:'12345678000190',state:'SP'},items,...over});
const createNote=async(items,{orders,...over}={})=>(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:noteData(items,over),...(orders?{orders}:{})}})).invoice;
const get=(invoice,user=f.users.estoque)=>f.rpc('erp_stock_checkin_get',{p_user_id:user,p_invoice_id:invoice});
const save=(invoice,version,items,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_checkin_save',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:version,p_items:items});
const issue=(invoice,version,position,kind,quantity,{user=f.users.estoque,command=randomUUID(),action='none'}={})=>f.rpc('erp_stock_checkin_issue',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:version,p_position:position,p_kind:kind,p_quantity:quantity,p_action:action});
const batch=(invoice,version,positions,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_checkin_batch',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:version,p_positions:positions});
const restart=(invoice,version,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_checkin_restart',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:version});
const finish=(invoice,version,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_checkin_finish',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,p_expected_version:version});

test('147 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants',async()=>{
 for(const signature of['public.erp_stock_checkin_notes(uuid,text,integer,integer)','public.erp_stock_checkin_get(uuid,uuid)','public.erp_stock_checkin_save(uuid,uuid,uuid,integer,jsonb)',
  'public.erp_stock_checkin_issue(uuid,uuid,uuid,integer,integer,text,text,text)','public.erp_stock_checkin_batch(uuid,uuid,uuid,integer,jsonb)','public.erp_stock_checkin_restart(uuid,uuid,uuid,integer)',
  'public.erp_stock_checkin_finish(uuid,uuid,uuid,integer)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['checkin','checkin_item','checkin_event','checkin_command']){
  assert.equal(await f.scalar('select relrowsecurity v from pg_class where oid=$1::regclass',[`erp_stock.${table}`]),true);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}',$1,'SELECT') v`,[`erp_stock.${table}`]),false);
 }
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_stock.checkin_dto(uuid)','EXECUTE') v"),false);
});

test('147 Notas: entry notes only, newest first, searched by número or chave; readers and writers by role',async()=>{
 const p=await f.product('Produto notas');
 const first=await createNote([line(p,'1','5')],{number:'700001'}),second=await createNote([line(p,'2','5')],{number:'700002'});
 const out=await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{invoice:{...noteData([line(p,'1','5',{cfop:'5102'})],{direction:'1',issue_type:'N',nature_id:saleNature.id,presence:'1',number:undefined})}}}).catch(e=>e);
 assert.ok(out.invoice||out.code,'an exit note never appears in the check-in');
 const deleted=await createNote([line(p,'1','5')],{number:'700003'});
 await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'delete',p_data:{id:deleted.id,expected_version:deleted.version,reason:'Nota sintética excluída'}});
 const list=await f.rpc('erp_stock_checkin_notes',{p_user_id:f.users.fiscal,p_query:null,p_offset:0,p_limit:50});
 const numbers=list.items.map(i=>i.number);
 assert.ok(numbers.indexOf(700002)<numbers.indexOf(700001),'newest first');assert.equal(numbers.includes(700003),false,'a deleted note is out');
 assert.ok(list.items.every(i=>i.open&&i.checkin_state==='pending'||i.checkin_state));assert.equal(list.can_manage,false);
 const found=await f.rpc('erp_stock_checkin_notes',{p_user_id:f.users.estoque,p_query:'NFe 700002',p_offset:0,p_limit:50});
 assert.deepEqual([found.total,found.items[0].invoice_id,found.items[0].supplier.name,found.items[0].items_count,found.can_manage],[1,second.id,'Fornecedor sintético',1,true]);
 for(const query of['abc','12345678901'])await assert.rejects(f.rpc('erp_stock_checkin_notes',{p_user_id:f.users.estoque,p_query:query,p_offset:0,p_limit:50}),fails('22023'));
 // consulta does not see the native notes of the Brufap (112/113), here either.
 for(const user of[f.users.consulta,f.users.vendas,f.users.financeiro,randomUUID()]){
  await assert.rejects(f.rpc('erp_stock_checkin_notes',{p_user_id:user,p_query:null,p_offset:0,p_limit:50}),fails('42501'));
  await assert.rejects(get(first.id,user),fails('42501'));
 }
 for(const user of[f.users.consulta,f.users.fiscal])await assert.rejects(save(first.id,0,[{position:1,received:'1'}],{user}),fails('42501'));
 await assert.rejects(get(deleted.id),fails('P0002'),'a deleted note without check-in is not found');
});

test('147 Qtde Recebida: the first save starts the check-in with a copy of the items; CAS, replay and conflicts',async()=>{
 const p=await f.product('Produto conferido'),q=await f.product('Produto outro');
 const note=await createNote([line(p,'3','10'),line(q,'1.5','4.25',{description:'Outra peça',code:'F-2',gtin:'7891234567895'})]);
 const before=await get(note.id);
 assert.deepEqual([before.version,before.checkin,before.items.map(i=>[i.position,i.quantity,i.received,i.state,i.supplier_code])],[0,null,[[1,'3.0000','0.0000','pending','F-1'],[2,'1.5000','0.0000','pending','F-2']]]);
 const command=randomUUID(),first=await save(note.id,0,[{position:1,received:'2'},{position:2,received:'0'}],{command});
 assert.deepEqual([first.replayed,first.receipt.from_version,first.receipt.to_version,first.version,first.checkin.state,first.note.checkin_state],[false,0,1,1,'in_progress','in_progress']);
 assert.deepEqual(first.receipt.detail.changes,[{position:1,from:'0.0000',to:'2.0000',description:'Peça sintética'}],'unchanged positions are not recorded');
 assert.deepEqual(first.items.map(i=>[i.received,i.state]),[['2.0000','in_progress'],['0.0000','pending']]);
 assert.deepEqual(first.events.map(e=>[e.action,e.position,e.previous,e.quantity]),[['received',1,'0.0000','2.0000']]);
 const again=await save(note.id,0,[{position:1,received:'2'},{position:2,received:'0'}],{command});
 assert.deepEqual([again.replayed,again.receipt],[true,first.receipt],'the same command returns the same receipt');
 await assert.rejects(save(note.id,0,[{position:1,received:'3'}],{command}),fails('40001'),'same UUID, other body');
 await assert.rejects(save(note.id,0,[{position:1,received:'3'}]),fails('40001'),'stale expected version');
 await assert.rejects(save(note.id,1,[{position:1,received:'2'}]),fails('22023'),'nothing changes');
 await assert.rejects(save(note.id,1,[{position:9,received:'2'}]),fails('P0002'));
 for(const items of[[],[{position:1,received:'2.12345'}],[{position:1,received:2}],[{position:1,received:'-1'}],[{position:1,received:'1',x:1}],[{position:1,received:'1'},{position:1,received:'2'}]])
  await assert.rejects(save(note.id,1,items),fails('22023'));
 const used=await f.launch(p.id,(await f.warehouse('Depósito checkin')).id,'receipt','1');
 await assert.rejects(save(note.id,1,[{position:1,received:'3'}],{command:used.movement.id===null?randomUUID():await f.scalar('select command_id v from erp_stock.movement where id=$1',[used.movement.id])}),fails('40001'),'a UUID of another stock family');
 const over=await save(note.id,1,[{position:1,received:'4'}]);
 assert.deepEqual([over.items[0].state,over.summary],['complete',{total:2,complete:1,issue:0,refused:0,pending:1}],'more than the note is accepted (the screen warns)');
});

test('147 pendências, check-in em lote, a changed note, Reiniciar and Finalizar (nothing is posted)',async()=>{
 const p=await f.product('Produto pendência'),q=await f.product('Produto lote');
 const note=await createNote([line(p,'5','2'),line(q,'2','3',{description:'Peça lote'})]);
 let r=await issue(note.id,0,1,'missing','2');
 assert.deepEqual([r.version,r.items[0].issue,r.items[0].issue_quantity,r.items[0].issue_action,r.items[0].state],[1,'missing','2.0000','none','issue']);
 await assert.rejects(issue(note.id,1,1,'damaged','6'),fails('22023'),'not more than the note');
 await assert.rejects(issue(note.id,1,1,'damaged','1',{action:'credit'}),fails('22023'),'only "Não aplicar nenhuma ação" exists');
 await assert.rejects(issue(note.id,1,1,'refused','1'),fails('22023'),'refused has no quantity');
 r=await issue(note.id,1,1,'refused',null);
 assert.deepEqual([r.items[0].issue,r.items[0].issue_quantity],['refused',null]);
 await assert.rejects(issue(note.id,2,1,'missing','1'),fails('22023'),'a refused item accepts no new pendência');
 await assert.rejects(save(note.id,2,[{position:1,received:'1'}]),fails('22023'));
 await assert.rejects(batch(note.id,2,[1]),fails('22023'));
 r=await batch(note.id,2,[2]);
 assert.deepEqual([r.items[1].received,r.items[1].state,r.summary],['2.0000','complete',{total:2,complete:1,issue:0,refused:1,pending:0}]);
 assert.deepEqual(r.events.map(e=>e.action),['missing','refused','batch']);
 // The note is edited after the check-in started: the copy is stale until Reiniciar.
 const edited=(await f.rpc('erp_fiscal_invoice_execute',{p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_action:'update',p_data:{id:note.id,expected_version:note.version,
  invoice:noteData([line(p,'6','2'),line(q,'2','3',{description:'Peça lote'})],{number:String(note.number)})}})).invoice;
 const stale=await get(note.id);assert.deepEqual([stale.checkin.stale,stale.items[0].quantity],[true,'5.0000']);
 await assert.rejects(save(note.id,3,[{position:2,received:'1'}]),fails('40001'),'a stale check-in only restarts');
 r=await restart(note.id,3);
 assert.deepEqual([r.version,r.checkin.stale,r.checkin.invoice_version,r.items.map(i=>[i.quantity,i.received,i.issue])],[4,false,edited.version,[['6.0000','0.0000',null],['2.0000','0.0000',null]]]);
 assert.deepEqual(r.receipt.detail,{from_invoice_version:note.version,to_invoice_version:edited.version});
 await save(note.id,4,[{position:1,received:'6'}]);
 const movements=await f.scalar('select count(*)::int v from erp_stock.movement');
 r=await finish(note.id,5);
 assert.deepEqual([r.version,r.checkin.state,r.note.checkin_state,r.receipt.to_version],[7,'finished','finished',7]);
 assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),movements,'Finalizar does not post stock');
 for(const call of[()=>save(note.id,7,[{position:2,received:'1'}]),()=>restart(note.id,7),()=>finish(note.id,7),()=>issue(note.id,7,2,'missing','1')])await assert.rejects(call(),fails('40001'));
 assert.equal((await get(note.id,f.users.fiscal)).checkin.state,'finished','the finished check-in stays readable');
 await assert.rejects(finish((await createNote([line(p,'1','1')])).id,0),fails('22023'),'Finalizar needs a started check-in');
});

test('147 Solicitado and Preço diferente come from the linked purchase orders; the history and copies are immutable',async()=>{
 const p=await f.product('Produto solicitado'),w=await f.warehouse('Depósito pedido');
 const po=await f.order('purchase_orders',[f.item(p,'4','9.5'),f.item(p,'1','9.5')],w.id,['in_progress']);
 const note=await createNote([line(p,'5','10'),line(null,'1','1',{description:'Frete sintético',product_id:undefined})],{orders:[po.id]});
 const view=await get(note.id);
 assert.deepEqual(view.items[0].requested,{quantity:'5.0000',prices:['9.5000000000']});assert.equal(view.items[1].requested,null,'an item without product has no requested quantity');
 const started=await save(note.id,0,[{position:1,received:'5'}]);
 const id=started.checkin.id;
 await assert.rejects(f.db.query('update erp_stock.checkin_item set quantity=1 where checkin_id=$1',[id]),fails('40001'));
 await assert.rejects(f.db.query('delete from erp_stock.checkin where id=$1',[id]),fails('40001'));
 await assert.rejects(f.db.query('update erp_stock.checkin_event set quantity=1'),fails('40001'));
 await assert.rejects(f.db.query('delete from erp_stock.checkin_command'),fails('40001'));
 await assert.rejects(f.db.query('update erp_stock.checkin set version=version+5 where id=$1',[id]),fails('40001'));
 assert.equal(await f.scalar('select erp_stock.command_taken($1) v',[started.receipt.command_id]),true,'the check-in commands share the stock UUID space');
});

test('147 SQL → HTTP → DTO: real answers of every route pass the strict projections',async()=>{
 const project=async(path,value,method='GET',body)=>{const req=new Request(`https://api.example.test${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),url=new URL(req.url);
  const op=await stockOperation(req,stockRoute(url.pathname),url.searchParams);return stockResponse(value,stockRoute(url.pathname),op);};
 const p=await f.product('Produto DTO checkin'),w=await f.warehouse('Depósito DTO checkin');
 const po=await f.order('purchase_orders',[f.item(p,'2','4')],w.id,['in_progress']);
 const note=await createNote([line(p,'2','4.5'),line(p,'1','4.5',{description:'Segunda linha'})],{orders:[po.id],number:'812345'});
 const base=`/v1/estoque/checkin/notas/${note.id}`;
 const list=await project('/v1/estoque/checkin/notas?q=812345',await f.rpc('erp_stock_checkin_notes',{p_user_id:f.users.estoque,p_query:'812345',p_offset:0,p_limit:50}));
 assert.equal(list.items[0].invoice_id,note.id);
 assert.equal((await project(base,await get(note.id))).items[0].requested.quantity,'2.0000');
 const command=async(action,body,rpc,args)=>{const full={command_id:randomUUID(),...body};return project(`${base}/${action}`,await f.rpc(rpc,{p_user_id:f.users.estoque,p_command_id:full.command_id,p_invoice_id:note.id,...args(full)}),'POST',full);};
 let out=await command('recebidos',{expected_version:0,items:[{position:1,received:'1.5'}]},'erp_stock_checkin_save',b=>({p_expected_version:b.expected_version,p_items:b.items}));
 assert.equal(out.items[0].state,'in_progress');
 out=await command('pendencias',{expected_version:1,position:2,kind:'damaged',quantity:'1',action:'none'},'erp_stock_checkin_issue',b=>({p_expected_version:b.expected_version,p_position:b.position,p_kind:b.kind,p_quantity:b.quantity,p_action:b.action}));
 out=await command('lote',{expected_version:2,positions:[1]},'erp_stock_checkin_batch',b=>({p_expected_version:b.expected_version,p_positions:b.positions}));
 assert.deepEqual(out.summary,{total:2,complete:1,issue:1,refused:0,pending:0});
 out=await command('reinicio',{expected_version:3},'erp_stock_checkin_restart',b=>({p_expected_version:b.expected_version}));
 out=await command('recebidos',{expected_version:4,items:[{position:2,received:'1'}]},'erp_stock_checkin_save',b=>({p_expected_version:b.expected_version,p_items:b.items}));
 out=await command('finalizacao',{expected_version:5},'erp_stock_checkin_finish',b=>({p_expected_version:b.expected_version}));
 assert.deepEqual([out.checkin.state,out.events.map(e=>e.action)],['finished',['received','damaged','batch','restart','received','finish']]);
});
