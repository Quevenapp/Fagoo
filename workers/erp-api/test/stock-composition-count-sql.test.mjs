import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneDFixture,migrationSql} from './helpers/stock-lane-d-fixture.mjs';

// 226 on PGlite (published migrations up to 190, then 222-226) with synthetic data only: compositions in the Conferência de estoque
// and in the reservation by sale situation.
let f;
before(async()=>{f=await stockLaneDFixture({upto:5});});
after(()=>f?.close());

test('226 guards: published bodies only and a second run is refused',async()=>{
 await assert.rejects(f.db.exec(await migrationSql('202610200226_stock_composition_count_reservations.sql')),/stock_composition_count_226_previous_definition_changed/);await f.db.exec('rollback');
});

test('226 Conferência: a Físico composition is read and balanced; Virtual and unstructured compositions are refused',async()=>{
 const depot=await f.warehouse('Conferência composição');
 const a=await f.product('Conferido A');
 const physical=await f.kit('Kit conferido físico',[[a,'1']],{stock_type:'physical',post_mode:'both'},{code:'KCF-1'});
 const virtual=await f.kit('Kit conferido virtual',[[a,'1']],{},{code:'KCV-1'});
 const raw=await f.product('Kit conferido sem estrutura',{format:'E',code:'KCS-1'});
 const read=code=>f.rpc('erp_stock_count_read',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:null,p_code:code,p_quantity:'3',p_warehouse_id:depot.id});
 assert.equal((await read('KCF-1')).outcome,'read');
 assert.deepEqual([(await read('KCV-1')).reason,(await read('KCS-1')).reason],['invalid_format','invalid_format']);
 const session=(await f.rpc('erp_stock_count_get',{p_user_id:f.users.estoque})).count.session;
 const balanced=await f.rpc('erp_stock_count_balance',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_session_id:session.id,p_expected_version:session.version,p_scope:'counted',p_confirmed:false});
 assert.deepEqual(balanced.changed.map(c=>[c.product_id,c.counted]),[[physical.id,'3.000000']]);
 assert.equal(await f.balance(physical.id,depot.id),'3.000000');assert.equal(await f.balance(virtual.id,depot.id),undefined);
 assert.ok(raw.id);
});

test('226 reservation by sale situation: a composition item reserves its components (and its own stock for Físico)',async()=>{
 await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['em_aberto']});
 try{
  const depot=await f.warehouse('Situação composição');
  const a=await f.product('Situação A'),b=await f.product('Situação B');
  const virtual=await f.kit('Kit situação virtual',[[a,'2'],[b,'0.5']]);
  const both=await f.kit('Kit situação ambos',[[a,'1']],{stock_type:'physical',post_mode:'both'});
  const raw=await f.product('Kit situação sem estrutura',{format:'E'});
  await f.order('sales_orders',[f.item(virtual,'3'),f.item(both,'1'),f.item(raw,'4')],depot.id);
  const rows=await f.rows("select product_id,quantity::numeric(18,6)::text q from erp_stock.situation_reservations(null) where product_id in($1,$2,$3,$4,$5) order by q",[a.id,b.id,virtual.id,both.id,raw.id]);
  const by=Object.fromEntries(rows.map(r=>[r.product_id,r.q]));
  assert.deepEqual([by[a.id],by[b.id],by[both.id],by[virtual.id],by[raw.id]],['7.000000','1.500000','1.000000',undefined,undefined]);
  // The one-product read (Saldos do produto) gives the same quantities as the full read.
  const one=async id=>(await f.scalar('select coalesce(sum(quantity),0)::numeric(18,6)::text v from erp_stock.situation_reservations($1)',[id]));
  assert.deepEqual([await one(a.id),await one(b.id),await one(both.id),await one(virtual.id),await one(raw.id)],['7.000000','1.500000','1.000000','0.000000','0.000000']);
  const balances=await f.rpc('erp_stock_balances',{p_user_id:f.users.consulta,p_product_id:a.id,p_warehouse_id:null});
  assert.ok(balances.items.some(i=>i.situation_reserved_quantity==='7.000000'));
 }finally{await f.setPreferences('suprimentos-estoque',{'estoque.reserva_por_situacao':false,'estoque.reserva_situacoes':[]});}
});
