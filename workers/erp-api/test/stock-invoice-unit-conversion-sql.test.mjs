import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneGFixture,migrationSql,fails} from './helpers/stock-lane-g-fixture.mjs';

// 295 on PGlite (every migration published up to 286, then the lane G files) with synthetic data only: an entry note item in another
// unit than the product enters the stock by the factor of the supplier or by the unidade tributária of the note (NFE-203).
let f;
before(async()=>{f=await stockLaneGFixture();});
after(()=>f?.close());
const preview=async(invoice,warehouse,{user=f.users.estoque}={})=>(await f.rpc('erp_stock_invoice_preview',{p_user_id:user,p_invoice_id:invoice,p_expected_version:await f.noteVersion(invoice),p_warehouse_id:warehouse})).preview;
const post=async(invoice,warehouse,{user=f.users.estoque,prior=null}={})=>{const p=prior??await preview(invoice,warehouse,{user});
 return f.rpc('erp_stock_invoice_post',{p_user_id:user,p_command_id:randomUUID(),p_invoice_id:invoice,p_expected_version:await f.noteVersion(invoice),p_warehouse_id:warehouse,p_preview_hash:p.preview_hash});};
const units=(invoice,user=f.users.estoque)=>f.rpc('erp_stock_invoice_units',{p_user_id:user,p_invoice_id:invoice});
const save=(invoice,position,factor,expected,{user=f.users.estoque,command=randomUUID()}={})=>f.rpc('erp_stock_invoice_unit_save',{p_user_id:user,p_command_id:command,p_invoice_id:invoice,
 p_position:position,p_expected_version:expected,p_factor:factor});
// The check-in source of the same prévia (Qtde Recebida of each line), read directly from the internal function.
const checkin=(invoice,warehouse,lines)=>f.scalar("select erp_stock.invoice_preview_data(i,$2,'checkin',$3::jsonb) v from erp_fiscal_invoices.invoice i where i.id=$1",[invoice,warehouse,JSON.stringify(lines)]);

test('295 entry points are SECURITY DEFINER for service_role only; tables have RLS and no grants; helpers are internal; the guard refuses a second run',async()=>{
 for(const signature of['public.erp_stock_invoice_units(uuid,uuid)','public.erp_stock_invoice_unit_save(uuid,uuid,uuid,integer,integer,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const table of['erp_stock.unit_conversion','erp_stock.unit_conversion_command']){
  assert.equal(await f.scalar(`select relrowsecurity v from pg_class where oid='${table}'::regclass`),true,table);
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_table_privilege('${role}','${table}','SELECT') v`),false,table);
 }
 for(const internal of['erp_stock.unit_key(text)','erp_stock.invoice_supplier(erp_fiscal_invoices.invoice)','erp_stock.invoice_unit_rule(uuid,uuid,text,text,jsonb,numeric,numeric)',
  'erp_stock.invoice_unit_price(numeric,jsonb,integer,uuid)','erp_stock.invoice_units_dto(text,erp_fiscal_invoices.invoice)','erp_stock.invoice_preview_data(erp_fiscal_invoices.invoice,uuid,text,jsonb)',
  'erp_stock.ledger_document_price(uuid,uuid)','erp_stock.average_costs(uuid[])','erp_stock.command_taken(uuid)'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200295_stock_invoice_unit_conversion.sql')),/stock_invoice_unit_conversion_295_previous_definition_changed/);await f.db.exec('rollback');
});

test('295 a note with the items in the unit of the product keeps the published prévia and hash',async()=>{
 const g=await stockLaneGFixture({upto:0});
 try{
  const target=await g.warehouse('Depósito hash 295'),item=await g.product('Produto hash 295');
  const entry=await g.note('0',[g.noteLine(item,'2','10')]);
  const call=async()=>(await g.rpc('erp_stock_invoice_preview',{p_user_id:g.users.estoque,p_invoice_id:entry.id,p_expected_version:await g.noteVersion(entry.id),p_warehouse_id:target.id})).preview;
  const old=await call();
  await g.db.exec(await migrationSql('202610200295_stock_invoice_unit_conversion.sql'));
  assert.equal((await call()).preview_hash,old.preview_hash);
 }finally{await g.close();}
});

test('295 Fator de conversão do fornecedor: blocked without a rule, saved by command (replay, CAS, conflict), then 2 CX enter as 24 UN at the price per UN',async()=>{
 const target=await f.warehouse('Depósito conversão'),item=await f.product('Produto vendido em caixa'),service=await f.product('Serviço conversão',{kind:'S'});
 const entry=await f.note('0',[f.noteLine(item,'2','120',{unit:'CX'}),f.noteLine(service,'1','50',{unit:'SV'})]);
 await assert.rejects(preview(entry.id,target.id),e=>e.code==='22023'&&/erp_invoice_stock_unit_mismatch/.test(e.message)&&e.detail==='1');
 const read=await units(entry.id);
 assert.deepEqual({supplier:read.supplier?.id,manage:read.can_manage,total:read.total,items:read.items.map(i=>[i.position,i.unit,i.quantity,i.product.unit,i.factor,i.rule,i.converted_quantity])},
  {supplier:f.contact.id,manage:true,total:1,items:[[1,'CX','2.000000','UN',null,null,null]]});
 assert.equal((await units(entry.id,f.users.fiscal)).can_manage,false,'fiscal reads, estoque writes');
 await assert.rejects(units(entry.id,f.users.vendas),fails('42501'));
 await assert.rejects(save(entry.id,1,'12',0,{user:f.users.fiscal}),fails('42501'));
 // Inputs: the factor is a positive decimal with up to 6 places; removing needs an existing factor.
 for(const bad of['0','-1','1.1234567','1e3','1000000',''])await assert.rejects(save(entry.id,1,bad,0),fails('22023'),bad);
 await assert.rejects(save(entry.id,1,null,0),fails('22023'));
 await assert.rejects(save(entry.id,2,'2',0),e=>e.code==='22023'&&e.detail==='no_product','a service has no stock unit to convert');
 await assert.rejects(save(entry.id,9,'2',0),fails('P0002'));
 const command=randomUUID();
 const saved=await save(entry.id,1,'12',0,{command});
 assert.deepEqual({unit:saved.unit,product_unit:saved.product_unit,before:saved.before,after:saved.after,replayed:saved.replayed,rule:saved.units.items[0].rule,converted:saved.units.items[0].converted_quantity},
  {unit:'CX',product_unit:'UN',before:null,after:{factor:'12.000000',version:1},replayed:false,rule:'supplier',converted:'24.000000'});
 assert.equal((await save(entry.id,1,'12',0,{command})).replayed,true);
 await assert.rejects(save(entry.id,1,'10',0,{command}),fails('40001'),'the same command with another body');
 await assert.rejects(save(entry.id,1,'10',0),fails('40001'),'a stale version');
 await assert.rejects(save(entry.id,1,'12.000',1),e=>e.code==='22023'&&/unchanged/.test(e.message));
 const p=await preview(entry.id,target.id);
 assert.deepEqual(p.positions.map(x=>[x.product_id,x.unit,x.quantity,x.sources]),[[item.id,'UN','24.000000',[{position:1,quantity:'24.000000',invoice_quantity:'2.000000',invoice_unit:'CX',conversion:'supplier',factor:'12.000000'}]]]);
 assert.deepEqual(p.ignored.map(i=>[i.position,i.reason]),[[2,'service']]);
 const posted=await post(entry.id,target.id,{prior:p});
 assert.equal(await f.balance(item.id,target.id),'24.000000');
 // The price of the note per UN (120 per CX / 12) in the extrato (who reads the notes) and in the custo médio.
 const ledger=await f.rpc('erp_stock_ledger',{p_user_id:f.users.admin,p_product_id:item.id,p_warehouse_id:null,p_kind:null,p_origin:null,p_date_from:null,p_date_to:null,p_limit:10,p_offset:0,p_direction:null});
 assert.deepEqual(ledger.items.map(r=>[r.unit_price,r.price_source]),[['10.0000000000','document']]);
 assert.ok(posted.movement.id);
 assert.equal(Number(await f.scalar('select average_cost::text v from erp_stock.average_costs(array[$1::uuid])',[item.id])),10);
 // The next note of the same supplier reuses the factor; another supplier has none.
 const next=await f.note('0',[f.noteLine(item,'1','120',{unit:'cx'})]);
 assert.equal((await preview(next.id,target.id)).positions[0].quantity,'12.000000');
 const stranger=await f.catalog('contacts',{name:'Outro fornecedor conversão'});
 const other=await f.note('0',[f.noteLine(item,'1','120',{unit:'CX'})],{supplier:stranger});
 await assert.rejects(preview(other.id,target.id),e=>/erp_invoice_stock_unit_mismatch/.test(e.message));
 // A conferência opened before the factor changes is refused by its hash; removing the factor blocks again.
 const stale=await preview(next.id,target.id);
 await save(next.id,1,'10',1);
 await assert.rejects(post(next.id,target.id,{prior:stale}),fails('40001'));
 assert.equal((await preview(next.id,target.id)).positions[0].quantity,'10.000000');
 const removed=await save(next.id,1,null,2);
 assert.deepEqual([removed.before,removed.after],[{factor:'10.000000',version:2},null]);
 await assert.rejects(preview(next.id,target.id),e=>/erp_invoice_stock_unit_mismatch/.test(e.message));
 // The audit: one immutable receipt per command with the factor before and after.
 assert.equal(await f.scalar('select count(*)::integer v from erp_stock.unit_conversion_command where product_id=$1',[item.id]),3);
 await assert.rejects(f.db.query('delete from erp_stock.unit_conversion_command where product_id=$1',[item.id]),fails('40001'));
});

test('295 Unidade tributária of the note, same unit in another case, exit notes, check-in and exact quantities',async()=>{
 const target=await f.warehouse('Depósito unidade tributária'),item=await f.product('Produto tributável'),plain=await f.product('Produto minúsculo');
 const entry=await f.note('0',[f.noteLine(item,'3','36',{unit:'CX',others:{tax_unit:'un',tax_quantity:'36'}}),f.noteLine(plain,'2','5',{unit:'un'})]);
 const p=await preview(entry.id,target.id);
 assert.deepEqual(p.positions.map(x=>[x.product_id,x.quantity,x.sources]).sort((a,b)=>a[0].localeCompare(b[0])),[
  [item.id,'36.000000',[{position:1,quantity:'36.000000',invoice_quantity:'3.000000',invoice_unit:'CX',conversion:'tax_unit'}]],
  [plain.id,'2.000000',[{position:2,quantity:'2.000000'}]]].sort((a,b)=>a[0].localeCompare(b[0])));
 const read=await units(entry.id);
 assert.deepEqual(read.items.map(i=>[i.position,i.rule,i.converted_quantity,i.tax]),[[1,'tax_unit','36.000000',{unit:'un',quantity:'36.0000'}]]);
 // Check-in (Qtde Recebida in the unit of the note): proportional to the quantidade tributária; an inexact share is refused.
 assert.equal((await checkin(entry.id,target.id,[{position:1,quantity:'1'}])).positions[0].quantity,'12.000000');
 const odd=await f.note('0',[f.noteLine(item,'3','10',{unit:'CX',others:{tax_unit:'UN',tax_quantity:'10'}})]);
 await assert.rejects(checkin(odd.id,target.id,[{position:1,quantity:'1'}]),e=>/erp_invoice_stock_conversion_inexact/.test(e.message));
 assert.equal((await checkin(odd.id,target.id,[{position:1,quantity:'3'}])).positions[0].quantity,'10.000000');
 // A factor of the supplier comes first; a product of a factor that would need more than 6 decimals is refused.
 await save(odd.id,1,'0.333333',0);
 const tiny=await f.note('0',[f.noteLine(item,'0.0001','10',{unit:'CX'})]);
 await assert.rejects(preview(tiny.id,target.id),e=>e.code==='22023'&&/erp_invoice_stock_conversion_inexact/.test(e.message));
 assert.equal((await units(tiny.id)).items[0].problem,'inexact');
 assert.equal((await preview(odd.id,target.id)).positions[0].sources[0].conversion,'supplier');
 // Exit notes: no conversion (the unit of the item must be the unit of the product, in any case).
 await f.launch(item.id,target.id,'receipt','50');
 const exit=await f.note('1',[f.noteLine(item,'1','10',{unit:'CX',others:{tax_unit:'UN',tax_quantity:'12'}})]);
 await assert.rejects(preview(exit.id,target.id),e=>/erp_invoice_stock_unit_mismatch/.test(e.message));
 assert.deepEqual((await units(exit.id)).items,[]);
 const lower=await f.note('1',[f.noteLine(item,'1','10',{unit:'un'})]);
 assert.equal((await preview(lower.id,target.id)).positions[0].quantity,'-1.000000');
 await assert.rejects(save(exit.id,1,'12',0),e=>e.code==='22023'&&e.detail==='not_entry');
 // A note without a contact of the cadastro: only the unidade tributária converts.
 const anonymous=await f.note('0',[f.noteLine(item,'1','10',{unit:'PC'})],{supplier:null});
 assert.equal((await units(anonymous.id)).supplier,null);
 await assert.rejects(save(anonymous.id,1,'2',0),e=>e.code==='22023'&&e.detail==='no_supplier');
});
