import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneEFixture,migrationSql,fails} from './helpers/stock-lane-e-fixture.mjs';

// 258 on PGlite (every migration published up to 233, then the lane E files) with synthetic data only: lots of a product, the balance
// per lot and warehouse, the Novo Lançamento and the transfers with Lote, reversals, "Excluir lote" and the Controle de lotes options.
let f;
before(async()=>{f=await stockLaneEFixture({upto:1});});
after(()=>f?.close());
const lots=(product,{warehouse=null,status='all',user=f.users.consulta}={})=>f.rpc('erp_stock_lots',{p_user_id:user,p_product_id:product,p_warehouse_id:warehouse,p_status:status,p_offset:0,p_limit:100});
const lotGet=(lot,user=f.users.consulta)=>f.rpc('erp_stock_lot_get',{p_user_id:user,p_lot_id:lot,p_limit:50});
const status=async(lot,active,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_lot_status',{p_user_id:user,p_command_id:command,p_lot_id:lot,
 p_expected_version:await f.scalar('select version v from erp_stock.lot where id=$1',[lot]),p_active:active});
const today=async()=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");

test('258 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_lots(uuid,uuid,uuid,text,integer,integer)','public.erp_stock_lot_get(uuid,uuid,integer)',
  'public.erp_stock_lot_save(uuid,uuid,uuid,uuid,integer,text,date,date,text)','public.erp_stock_lot_status(uuid,uuid,uuid,integer,boolean)',
  'public.erp_stock_lot_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer,jsonb)',
  'public.erp_stock_transfer_positions(uuid,uuid,uuid,jsonb)','public.erp_stock_transfer_batch(uuid,uuid,uuid,uuid,text,jsonb)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['erp_stock.lot','erp_stock.lot_balance','erp_stock.lot_entry','erp_stock.lot_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='${table}'::regclass`),true,table);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','${table}','SELECT') v`),false,table);
 }
 for(const internal of['erp_stock.lot_apply(uuid,uuid,uuid,uuid,numeric)','erp_stock.lots_expiring(date,date)','erp_stock.lot_settings()','erp_stock.command_taken(uuid)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200258_stock_lots.sql')),/stock_lots_258_previous_definition_changed/);await f.db.exec('rollback');
});

test('258 lot registration: create, replay, conflicts, unique code, lot control, required dates and edition with CAS',async()=>{
 const item=await f.lotProduct('Remédio lote'),plain=await f.product('Sem controle de lote');
 const command=randomUUID();
 const created=await f.lotSave(item.id,{code:' L-01 ',manufactured_on:'2026-09-01',expires_on:'2027-03-31',note:'Primeiro lote'},{command});
 assert.equal(created.created,true);assert.equal(created.replayed,false);
 assert.deepEqual({code:created.lot.code,made:created.lot.manufactured_on,expires:created.lot.expires_on,note:created.lot.note,version:created.lot.version,quantity:created.lot.quantity,active:created.lot.active},
  {code:'L-01',made:'2026-09-01',expires:'2027-03-31',note:'Primeiro lote',version:1,quantity:'0.000000',active:true});
 const replay=await f.lotSave(item.id,{code:' L-01 ',manufactured_on:'2026-09-01',expires_on:'2027-03-31',note:'Primeiro lote'},{command});
 assert.equal(replay.replayed,true);assert.equal(replay.lot.id,created.lot.id);
 await assert.rejects(f.lotSave(item.id,{code:'Outro'},{command}),fails('40001'));
 // Same code in another case, product without "Controle de lote", invalid fields, other profiles.
 await assert.rejects(f.lotSave(item.id,{code:'l-01'}),fails('22023'));
 await assert.rejects(f.lotSave(plain.id,{code:'X1'}),fails('22023'));
 await assert.rejects(f.lotSave(item.id,{code:'X2',manufactured_on:'2027-01-02',expires_on:'2027-01-01'}),fails('22023'));
 await assert.rejects(f.lotSave(item.id,{code:'X\n3'}),fails('22023'));
 await assert.rejects(f.lotSave(item.id,{code:''}),fails('22023'));
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal,f.users.financeiro])await assert.rejects(f.lotSave(item.id,{code:`P-${user.slice(0,4)}`},{user}),fails('42501'));
 // Preferências > Cadastros > Controle de lotes.
 await f.setPreferences('cadastros-lotes',{'lotes.validade_obrigatoria':true,'lotes.fabricacao_obrigatoria':true});
 await assert.rejects(f.lotSave(item.id,{code:'SEM-VAL',manufactured_on:'2026-10-01'}),error=>error.code==='22023'&&/expiry_required/.test(error.message));
 await assert.rejects(f.lotSave(item.id,{code:'SEM-FAB',expires_on:'2027-10-01'}),error=>error.code==='22023'&&/manufacture_required/.test(error.message));
 const both=await f.lotSave(item.id,{code:'COM-DATAS',manufactured_on:'2026-10-01',expires_on:'2027-10-01'});
 await f.setPreferences('cadastros-lotes',{'lotes.validade_obrigatoria':false,'lotes.fabricacao_obrigatoria':false});
 // Edition: dates and Obs. change with the expected version; the code never changes; an unchanged save is refused.
 const edited=await f.lotSave(item.id,{code:'L-01',manufactured_on:'2026-09-01',expires_on:'2027-04-30',note:null},{lot:created.lot.id,expected:1});
 assert.deepEqual([edited.created,edited.lot.version,edited.lot.expires_on,edited.lot.note],[false,2,'2027-04-30',null]);
 await assert.rejects(f.lotSave(item.id,{code:'L-01',expires_on:'2027-05-31'},{lot:created.lot.id,expected:1}),fails('40001'));
 await assert.rejects(f.lotSave(item.id,{code:'L-02',expires_on:'2027-05-31'},{lot:created.lot.id,expected:2}),fails('22023'));
 await assert.rejects(f.lotSave(item.id,{code:'L-01',manufactured_on:'2026-09-01',expires_on:'2027-04-30'},{lot:created.lot.id,expected:2}),fails('22023'));
 await assert.rejects(f.lotSave(item.id,{code:'L-01'},{lot:randomUUID(),expected:1}),fails('P0002'));
 // The rows are immutable outside the commands.
 await assert.rejects(f.db.query("update erp_stock.lot set code='Z' where id=$1",[created.lot.id]),/erp_stock_lot_immutable/);
 await assert.rejects(f.db.query('delete from erp_stock.lot where id=$1',[both.lot.id]),/erp_stock_lot_immutable/);
 await assert.rejects(f.db.query('delete from erp_stock.lot_command where lot_id=$1',[both.lot.id]),/erp_stock_immutable_ledger/);
 // One command family across the stock: a lot command UUID cannot be reused by another stock command.
 const depot=await f.warehouse('Depósito comando lote');
 await assert.rejects(f.launch(plain.id,depot.id,'receipt','1',{command}),fails('40001'));
});

test('258 Novo Lançamento with Lote: Entrada (new and existing), Saída, Balanço, Transferência, Sem lote and replay',async()=>{
 const depot=await f.warehouse('Depósito lote A'),other=await f.warehouse('Depósito lote B');
 const item=await f.lotProduct('Vacina lote');
 const command=randomUUID();
 const first=await f.lotLaunch(item.id,depot.id,'receipt','10',{code:'V1',manufactured_on:'2026-08-01',expires_on:'2027-02-28'},{price:'3.5',command});
 assert.equal(first.scope,'stock_launch');assert.equal(first.lot.created,true);assert.equal(first.lot.code,'V1');
 assert.deepEqual(first.lot.entries,[{warehouse_id:depot.id,quantity:'10.000000',balance_after:'10.000000'}]);
 assert.equal(first.movement.items[0].quantity,'10.000000');assert.equal(first.detail.unit_price,'3.5000000000');
 const replay=await f.rpc('erp_stock_lot_launch',{p_user_id:f.users.estoque,p_command_id:command,p_kind:'receipt',p_product_id:item.id,p_warehouse_id:depot.id,p_quantity:'10',
  p_expected_version:0,p_unit_price:'3.5',p_unit_cost:null,p_note:null,p_destination_id:null,p_destination_version:null,p_lot:{code:'V1',manufactured_on:'2026-08-01',expires_on:'2027-02-28'}});
 assert.equal(replay.replayed,true);assert.equal(replay.movement.id,first.movement.id);
 const v1=first.lot.id;
 // An existing lot, a plain Entrada without lot (Sem lote) and a Saída of the lot.
 await f.lotLaunch(item.id,depot.id,'receipt','5',{lot_id:v1});
 await f.launch(item.id,depot.id,'receipt','4');
 assert.equal(await f.balance(item.id,depot.id),'19.000000');assert.equal(await f.lotBalance(v1,depot.id),'15.000000');
 await assert.rejects(f.lotLaunch(item.id,depot.id,'issue','16',{lot_id:v1}),error=>error.code==='22023'&&/lot_insufficient/.test(error.message));
 const out=await f.lotLaunch(item.id,depot.id,'issue','6',{lot_id:v1});
 assert.deepEqual(out.lot.entries,[{warehouse_id:depot.id,quantity:'-6.000000',balance_after:'9.000000'}]);
 // Balanço of the lot: the quantity is the new lot quantity; the warehouse moves by the same difference.
 const counted=await f.lotLaunch(item.id,depot.id,'balance','7',{lot_id:v1});
 assert.deepEqual(counted.lot.balance,{counted:'7.000000',previous:'9.000000'});
 assert.deepEqual(counted.balance,{counted:'11.000000',previous:'13.000000',warehouse_id:depot.id,source:'launch'});
 assert.equal(await f.balance(item.id,depot.id),'11.000000');assert.equal(await f.lotBalance(v1,depot.id),'7.000000');
 await assert.rejects(f.lotLaunch(item.id,depot.id,'balance','7',{lot_id:v1}),fails('22023'));
 // A new lot found in the count ("Novo lote" in the Balanço).
 const found=await f.lotLaunch(item.id,depot.id,'balance','2',{code:'V2',manufactured_on:null,expires_on:'2026-11-30'});
 assert.equal(found.lot.created,true);assert.equal(await f.balance(item.id,depot.id),'13.000000');
 // Transferência: the lot leaves the source and enters the destination.
 const moved=await f.lotLaunch(item.id,depot.id,'transfer','3',{lot_id:v1},{destination:other.id});
 assert.deepEqual(moved.lot.entries.map(e=>[e.warehouse_id,e.quantity]),[[depot.id,'-3.000000'],[other.id,'3.000000']]);
 assert.deepEqual([await f.lotBalance(v1,depot.id),await f.lotBalance(v1,other.id)],['4.000000','3.000000']);
 // The list: lots of the warehouse, Sem lote = warehouse balance − lots.
 const listed=await lots(item.id,{warehouse:depot.id});
 assert.deepEqual(listed.items.map(l=>[l.code,l.quantity]),[['V2','2.000000'],['V1','4.000000']],'first to expire first');
 assert.deepEqual([listed.stock,listed.assigned,listed.unassigned],['10.000000','6.000000','4.000000']);
 const all=await lots(item.id);assert.deepEqual([all.stock,all.assigned,all.unassigned],['13.000000','9.000000','4.000000']);
 // Invalid lot inputs and other refusals.
 const invalid=async(kind,lot,quantity='1')=>assert.rejects(f.lotLaunch(item.id,depot.id,kind,quantity,lot),fails('22023'));
 await invalid('issue',{code:'NOVO'});await invalid('receipt',{lot_id:v1,code:'X'});await invalid('receipt',{code:'V3',expires_on:'2027-02-30'});
 await invalid('receipt',{code:'V3',other:true});await invalid('receipt',{});await invalid('receipt',{code:'v1'});
 await assert.rejects(f.lotLaunch(item.id,depot.id,'receipt','1',{lot_id:randomUUID()}),fails('P0002'));
 const plain=await f.product('Produto comum lote');
 await assert.rejects(f.lotLaunch(plain.id,depot.id,'receipt','1',{code:'P1'}),fails('22023'));
 await assert.rejects(f.lotLaunch(item.id,depot.id,'receipt','1',{lot_id:v1},{user:f.users.vendas}),fails('42501'));
 // The lot lines are immutable and cannot be forged.
 await assert.rejects(f.db.query('update erp_stock.lot_entry set quantity=1 where lot_id=$1',[v1]),/erp_stock_immutable_ledger/);
 await assert.rejects(f.db.query('insert into erp_stock.lot_entry(movement_id,product_id,warehouse_id,lot_id,quantity,balance_after)values($1,$2,$3,$4,$5,0)',
  [first.movement.id,item.id,depot.id,v1,'1']),/erp_stock_lot_entry_invalid/);
});

test('258 reversals give the lot lines back; a reversal never leaves a lot negative',async()=>{
 const depot=await f.warehouse('Depósito estorno lote'),other=await f.warehouse('Depósito estorno lote 2');
 const item=await f.lotProduct('Insumo estorno lote');
 const entry=await f.lotLaunch(item.id,depot.id,'receipt','8',{code:'E1'});
 const lot=entry.lot.id;
 const moved=await f.lotLaunch(item.id,depot.id,'transfer','2',{lot_id:lot},{destination:other.id});
 await f.reverse(moved.movement.id);
 assert.deepEqual([await f.lotBalance(lot,depot.id),await f.lotBalance(lot,other.id)],['8.000000','0.000000']);
 const out=await f.lotLaunch(item.id,depot.id,'issue','8',{lot_id:lot});
 // Reversing the Entrada would take 8 from a lot that has nothing left in the warehouse.
 await f.setPolicy(true);
 await assert.rejects(f.reverse(entry.movement.id),error=>error.code==='22023'&&/lot_insufficient/.test(error.message));
 await f.setPolicy(false);
 await f.reverse(out.movement.id);assert.equal(await f.lotBalance(lot,depot.id),'8.000000');
 await f.reverse(entry.movement.id);assert.equal(await f.lotBalance(lot,depot.id),'0.000000');
 const detail=await lotGet(lot);
 // Entrada, the two lines of the transfer and of its reversal, the Saída, its reversal and the reversal of the Entrada.
 assert.equal(detail.movements.total,8);assert.deepEqual(detail.movements.items.map(m=>[m.kind,m.quantity]).slice(0,2),[['reversal','-8.000000'],['reversal','8.000000']]);
 assert.ok(detail.movements.items.every(m=>m.origin&&typeof m.origin.type==='string'));
});

test('258 Excluir lote (inactive), expiry marks with the warning days, lot details and lots_expiring',async()=>{
 const depot=await f.warehouse('Depósito validade');
 const item=await f.lotProduct('Alimento validade');
 const day=await today();
 const plus=async days=>f.scalar('select ($1::date+$2::integer)::text v',[day,days]);
 const old=await f.lotLaunch(item.id,depot.id,'receipt','2',{code:'VENCIDO',expires_on:await plus(-1)});
 const soon=await f.lotLaunch(item.id,depot.id,'receipt','2',{code:'PROXIMO',expires_on:await plus(10)});
 const later=await f.lotLaunch(item.id,depot.id,'receipt','2',{code:'DEPOIS',expires_on:await plus(40)});
 const empty=await f.lotSave(item.id,{code:'VAZIO',expires_on:await plus(1)});
 await f.setPreferences('cadastros-lotes',{'lotes.dias_aviso_validade':15});
 let listed=await lots(item.id);
 const state=code=>listed.items.find(l=>l.code===code).expiry_state;
 assert.deepEqual([state('VENCIDO'),state('PROXIMO'),state('DEPOIS'),state('VAZIO')],['expired','expiring',null,null],'no mark without stock');
 assert.equal(listed.settings.warning_days,15);
 const expiring=await f.rows('select code from erp_stock.lots_expiring($1::date,$2::date) order by expires_on',[day,await plus(15)]);
 assert.deepEqual(expiring.map(r=>r.code),['PROXIMO']);
 // Excluir lote: only without stock; the inactive lot gets no new lançamentos and can be reactivated.
 await assert.rejects(status(old.lot.id,false),error=>error.code==='22023'&&/has_stock/.test(error.message));
 const off=await status(empty.lot.id,false);assert.equal(off.lot.active,false);
 await assert.rejects(f.lotLaunch(item.id,depot.id,'receipt','1',{lot_id:empty.lot.id}),error=>/lot_inactive/.test(error.message));
 await assert.rejects(status(empty.lot.id,false),fails('22023'));
 listed=await lots(item.id,{status:'inactive'});assert.deepEqual(listed.items.map(l=>l.code),['VAZIO']);
 listed=await lots(item.id,{status:'active'});assert.ok(!listed.items.some(l=>l.code==='VAZIO'));
 await status(empty.lot.id,true);
 // Details: per warehouse and lançamentos with the origin of the ledger.
 const detail=await lotGet(later.lot.id);
 assert.deepEqual(detail.warehouses.map(w=>[w.warehouse_id,w.quantity]),[[depot.id,'2.000000']]);
 assert.deepEqual(detail.movements.items.map(m=>[m.kind,m.quantity,m.origin.type]),[['receipt','2.000000','none']]);
 await assert.rejects(lotGet(randomUUID()),fails('P0002'));
 await assert.rejects(lots(item.id,{user:f.users.financeiro}),fails('42501'));
 await f.setPreferences('cadastros-lotes',{'lotes.dias_aviso_validade':0});
});

test('258 Transferência dos produtos selecionados with the Lote of each product',async()=>{
 const from=await f.warehouse('Origem lote lote'),to=await f.warehouse('Destino lote lote');
 const item=await f.lotProduct('Peça lote em lote'),plain=await f.product('Peça sem lote em lote');
 const entry=await f.lotLaunch(item.id,from.id,'receipt','6',{code:'B1',expires_on:'2027-01-31'});
 await f.launch(plain.id,from.id,'receipt','5');
 const positions=await f.rpc('erp_stock_transfer_positions',{p_user_id:f.users.estoque,p_source_id:from.id,p_destination_id:to.id,p_product_ids:[item.id,plain.id]});
 const row=id=>positions.items.find(i=>i.product_id===id);
 assert.equal(row(item.id).lot_control,true);assert.deepEqual(row(item.id).lots,[{id:entry.lot.id,code:'B1',expires_on:'2027-01-31',quantity:'6.000000'}]);
 assert.equal(row(plain.id).lot_control,false);assert.deepEqual(row(plain.id).lots,[]);
 const batch=(items,command=randomUUID())=>f.rpc('erp_stock_transfer_batch',{p_user_id:f.users.estoque,p_command_id:command,p_source_id:from.id,p_destination_id:to.id,p_note:'Transferência com lote',p_items:items});
 const items=async()=>[{product_id:item.id,quantity:'4',source_version:await f.version(item.id,from.id),destination_version:await f.version(item.id,to.id),lot_id:entry.lot.id},
  {product_id:plain.id,quantity:'2',source_version:await f.version(plain.id,from.id),destination_version:await f.version(plain.id,to.id)}];
 await assert.rejects(batch((await items()).map(i=>i.lot_id?{...i,quantity:'7'}:i)),error=>/lot_insufficient/.test(error.message));
 await assert.rejects(batch((await items()).map(i=>i.lot_id?i:{...i,lot_id:entry.lot.id})),fails('22023'),'a product without lot control has no Lote');
 const result=await batch(await items());
 assert.deepEqual(result.receipt.items.map(i=>[i.product_id,i.lot_code??null]).sort(),[[item.id,'B1'],[plain.id,null]].sort());
 assert.deepEqual([await f.lotBalance(entry.lot.id,from.id),await f.lotBalance(entry.lot.id,to.id)],['2.000000','4.000000']);
 assert.deepEqual([await f.balance(plain.id,from.id),await f.balance(plain.id,to.id)],['3.000000','2.000000']);
});
