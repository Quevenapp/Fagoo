import test from'node:test';import{readFile}from'node:fs/promises';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{stockOpeningFixture,WAREHOUSE_SOURCE}from'./helpers/stock-opening-fixture.mjs';
const fails=(fn,code,message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
const line=(p,quantity='2')=>({product_id:p.id,description:'Linha sintética',unit:'UN',quantity,unit_price:'1'});

// Every decreasing path, run identically before and after migration100 (policy OFF).
async function decreasingPaths(f,{expectRefusal=true}={}){
 const out=[];const attempt=async(label,fn)=>{try{await fn();out.push([label,'ok']);}catch(e){out.push([label,e.code,e.message]);}};
 const p=await f.catalog('products',{name:'Peça política100',unit:'UN',kind:'P',format:'S',price:'1'}),other=await f.catalog('warehouses',{name:'Destino política100'});
 await attempt('issue on empty position',()=>f.post(p.id,'-1'));
 await f.post(p.id,'3');
 await attempt('issue beyond balance',()=>f.post(p.id,'-3.000001'));
 await attempt('negative adjustment beyond balance',()=>f.post(p.id,'-4',{kind:'adjustment'}));
 await attempt('transfer beyond balance',async()=>f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'transfer',p_occurred_on:'2026-10-15',p_reason:'Transferência sintética',p_reference:null,
  p_items:[{product_id:p.id,warehouse_id:f.warehouse.id,quantity:'-5',expected_version:await f.version(p.id)},{product_id:p.id,warehouse_id:other.id,quantity:'5',expected_version:0}]}));
 const receipt=await f.post(p.id,'2');await f.post(p.id,'-4');
 await attempt('manual reversal of a receipt',()=>f.reverse(receipt.movement.id));
 const sale=await f.order('sales_orders',[line(p,'2')]);
 await attempt('sales order stock posting',()=>f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_occurred_on:'2026-10-15',p_reason:'Baixa sintética'}));
 await attempt('reservation of a sales order',()=>f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética'}));
 const purchase=await f.order('purchase_orders',[line(p,'3')]);
 const pp=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_occurred_on:'2026-10-15',p_reason:'Entrada sintética'})).preview;
 const posted=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_command_id:randomUUID(),p_preview_hash:pp.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Entrada sintética',p_ignored_item_ids:[]});
 await f.post(p.id,'-4');
 await attempt('purchase document posting reversal',()=>f.rpc('erp_document_stock_reverse_preview',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:posted.document_version,p_posting_id:posted.posting.id,p_posting_version:posted.posting.version,p_occurred_on:'2026-10-15',p_reason:'Estorno sintético'}));
 const received=await f.order('purchase_orders',[line(p,'2')]);const item=await f.scalar('select id v from erp_documents.item where document_id=$1',[received.id]);
 const rp=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:received.id,p_expected_version:received.version,p_occurred_on:'2026-10-15',p_reason:'Recebimento sintético',p_items:[{item_id:item,quantity:'2'}]})).preview;
 const got=await f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:received.id,p_expected_version:received.version,p_occurred_on:'2026-10-15',p_reason:'Recebimento sintético',p_items:[{item_id:item,quantity:'2'}],p_command_id:randomUUID(),p_preview_hash:rp.preview_hash,p_confirm:true});
 await f.post(p.id,'-2');
 await attempt('purchase receipt reversal',()=>f.rpc('erp_purchase_receipts_reverse_preview',{p_user_id:f.users.estoque,p_document_id:received.id,p_expected_version:got.current.document.version,p_receipt_id:got.receipt.receipt.id,p_occurred_on:'2026-10-15',p_reason:'Estorno sintético'}));
 out.push(['final balance',await f.balance(p.id)]);
 if(expectRefusal)for(const row of out.slice(0,-1))assert.notEqual(row[1],'ok',row[0]);
 return{out,product:p};
}

test('100 with the policy OFF every decreasing path keeps exactly the refusals and codes of the published schema',async()=>{
 const before=await stockOpeningFixture({migrated:false}),after=await stockOpeningFixture();
 try{
  const a=await decreasingPaths(before),b=await decreasingPaths(after);
  assert.deepEqual(b.out,a.out);
  assert.deepEqual((await after.policy()).policy,{allow_negative:false,version:0,updated_at:null});
  assert.deepEqual(a.out.find(r=>r[0]==='issue beyond balance'),['issue beyond balance','22023','erp_stock_insufficient_or_excess_quantity']);
  assert.deepEqual(a.out.find(r=>r[0]==='purchase receipt reversal'),['purchase receipt reversal','40001','purchase_receipt_balance_unavailable']);
  // The table checks are now explicit numeric(18,6) bounds; the sign rule moved into the policy-aware writers and trigger.
  assert.deepEqual((await after.db.query("select conname,pg_get_constraintdef(oid)d from pg_constraint where conrelid in('erp_stock.balance'::regclass,'erp_stock.entry'::regclass)and contype='c'order by conname")).rows.map(r=>r.conname),
   ['balance_quantity_bounds','balance_version_check','entry_balance_after_bounds','entry_quantity_check']);
  // A direct balance write cannot bypass the policy either.
  await after.db.query("insert into erp_stock.balance(product_id,warehouse_id,unit,quantity,version)values($1,$2,'UN',0,0)",[b.product.id,(await after.catalog('warehouses',{name:'Depósito direto'})).id]);
  await fails(()=>after.db.query('update erp_stock.balance set quantity=-1 where product_id=$1 and quantity=0 and version=0',[b.product.id]),'22023','erp_stock_insufficient_or_excess_quantity');
  // Nor can a direct insert: the dropped >=0 checks covered inserts too.
  const direct=await after.catalog('warehouses',{name:'Depósito direto 2'});
  await fails(()=>after.db.query("insert into erp_stock.balance(product_id,warehouse_id,unit,quantity,version)values($1,$2,'UN',-1,1)",[b.product.id,direct.id]),'22023','erp_stock_insufficient_or_excess_quantity');
  const movement=await after.scalar('select id v from erp_stock.movement order by created_at limit 1');
  await fails(()=>after.db.query("insert into erp_stock.entry(movement_id,ordinal,product_id,warehouse_id,quantity,unit,balance_after,balance_version)values($1,99,$2,$3,-1,'UN',-1,1)",[movement,b.product.id,direct.id]),'22023','erp_stock_insufficient_or_excess_quantity');
 }finally{await before.close();await after.close();}
});

test('100 with the policy ON each decreasing path may end below zero; reservations stay protected; OFF again never rewrites',async()=>{
 const f=await stockOpeningFixture();try{
  const changed=await f.setPolicy(true);assert.equal(changed.policy.allow_negative,true);assert.equal(changed.receipt.from.allow_negative,false);
  const{out,product:p}=await decreasingPaths(f,{expectRefusal:false});
  const outcome=Object.fromEntries(out.map(r=>[r[0],r.slice(1)]));
  for(const label of['issue on empty position','issue beyond balance','negative adjustment beyond balance','transfer beyond balance','manual reversal of a receipt','sales order stock posting','purchase document posting reversal','purchase receipt reversal'])assert.deepEqual(outcome[label],['ok'],label);
  // A reservation still needs available stock: negative positions are never reserved.
  assert.deepEqual(outcome['reservation of a sales order'],['40001','erp_stock_available_quantity_insufficient']);
  const final=outcome['final balance'][0];assert.ok(final.quantity.startsWith('-'));
  const entries=await f.scalar('select jsonb_agg(balance_after::text order by balance_version)v from erp_stock.entry where product_id=$1 and warehouse_id=$2',[p.id,f.warehouse.id]);
  assert.ok(entries.some(v=>v.startsWith('-')));assert.equal(entries.at(-1),final.quantity);
  const availability=(await f.rpc('erp_stock_availability',{p_user_id:f.users.vendas,p_product_id:p.id,p_warehouse_id:f.warehouse.id})).position;
  assert.equal(availability.state,'recorded');assert.equal(availability.physical_quantity,final.quantity);assert.equal(availability.available_quantity,final.quantity);
  const positions=await f.rpc('erp_stock_positions',{p_user_id:f.users.consulta,p_limit:100,p_after:null,p_query:'Peça política100',p_active:null,p_warehouse_id:f.warehouse.id,p_brand:null,p_location:null,p_stock_state:null,p_limit_state:null});
  assert.equal(positions.items[0].selected_position.state,'recorded');assert.equal(positions.items[0].selected_position.quantity,final.quantity);
  assert.equal((await f.rpc('erp_stock_balances',{p_user_id:f.users.fiscal,p_product_id:p.id,p_warehouse_id:f.warehouse.id})).items[0].quantity,final.quantity);
  // Reserved stock is never consumed by an unreserved decrease, even with the policy ON.
  const q=await f.catalog('products',{name:'Peça reservada100',unit:'UN',kind:'P',format:'S',price:'1'});await f.post(q.id,'2');
  const sale=await f.order('sales_orders',[line(q,'2')]);
  const rp=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética'})).preview;
  await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:rp.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
  await fails(()=>f.post(q.id,'-1'),'40001','erp_stock_reserved_quantity_unavailable');
  // Turning OFF keeps the negative balance, refuses any further decrease, and still accepts increases that stay negative.
  const negative=await f.balance(p.id);await f.setPolicy(false);assert.deepEqual(await f.balance(p.id),negative);
  await fails(()=>f.post(p.id,'-0.000001'),'22023','erp_stock_insufficient_or_excess_quantity');
  await fails(()=>f.post(p.id,'-1',{kind:'adjustment'}),'22023','erp_stock_insufficient_or_excess_quantity');
  await f.post(p.id,'0.5');const raised=await f.balance(p.id);assert.equal(BigInt(raised.quantity.replace('.',''))-BigInt(negative.quantity.replace('.','')),500000n);
 }finally{await f.close();}
});

test('100 policy changes are admin-only, versioned, audited, idempotent and readable by stock readers',async()=>{
 const f=await stockOpeningFixture();try{
  for(const role of['admin','estoque','vendas','consulta','fiscal'])assert.equal((await f.rpc('erp_stock_policy_get',{p_user_id:f.users[role]})).can_manage,role==='admin');
  await fails(()=>f.rpc('erp_stock_policy_get',{p_user_id:f.users.financeiro}),'42501');
  for(const role of['estoque','vendas','consulta','fiscal'])await fails(()=>f.setPolicy(true,{user:f.users[role],expected:0}),'42501');
  await fails(()=>f.setPolicy(true,{expected:1}),'40001','erp_stock_policy_version_conflict');
  await fails(()=>f.setPolicy(false,{expected:0}),'22023','erp_stock_policy_unchanged');
  await fails(()=>f.setPolicy(true,{reason:'x'}),'22023');
  await fails(()=>f.rpc('erp_stock_policy_set',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:0,p_allow_negative:true,p_reason:'Sem confirmação',p_confirmed:false}),'22023');
  const command=randomUUID(),first=await f.setPolicy(true,{command,expected:0});assert.equal(first.replayed,false);assert.equal(first.policy.version,1);
  const again=await f.setPolicy(true,{command,expected:0});assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);assert.equal(again.policy.version,1);
  await fails(()=>f.setPolicy(true,{command,expected:0,reason:'Outra justificativa'}),'40001','erp_stock_policy_command_conflict');
  assert.deepEqual((await f.rpc('erp_stock_policy_command',{p_user_id:f.users.admin,p_command_id:command})).receipt,first.receipt);
  await fails(()=>f.rpc('erp_stock_policy_command',{p_user_id:f.users.other,p_command_id:command}),'42501');
  await fails(()=>f.rpc('erp_stock_policy_command',{p_user_id:f.users.admin,p_command_id:randomUUID()}),'P0002');
  const audit=await f.scalar('select jsonb_agg(jsonb_build_object(\'actor\',actor,\'from\',from_allow,\'to\',to_allow,\'reason\',reason)order by created_at)v from erp_stock.policy_command');
  assert.deepEqual(audit,[{actor:f.users.admin,from:false,to:true,reason:'Decisão sintética da política'}]);
  await fails(()=>f.db.query('update erp_stock.policy set allow_negative=false'),'40001');await fails(()=>f.db.query('delete from erp_stock.policy_command'),'40001');
  // Losing the admin role refuses the change and the recovery read.
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);
  try{await fails(()=>f.setPolicy(false,{expected:1}),'42501');await fails(()=>f.rpc('erp_stock_policy_command',{p_user_id:f.users.admin,p_command_id:command}),'42501');}
  finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
  for(const name of['erp_stock_policy_get(uuid)','erp_stock_policy_set(uuid,uuid,integer,boolean,text,boolean)','erp_stock_policy_command(uuid,uuid)','erp_stock_opening_warehouses(uuid)','erp_stock_opening_page(uuid,text,integer,text,text)','erp_stock_opening_batch(uuid,text,date,integer)','erp_stock_opening_apply(uuid,text,date,jsonb,text,uuid,boolean)','erp_stock_opening_command(uuid,uuid)'])
   for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege($1,'public.${name}','execute')v`,[role]),role==='service_role',`${name} ${role}`);
  for(const helper of['erp_stock.negative_allowed()','erp_stock.opening_rows(text,uuid,boolean,text[])','erp_stock.command_taken(uuid)'])assert.equal(await f.scalar(`select has_function_privilege('service_role','${helper}','execute')v`),false);
 }finally{await f.close();}
});

// Synthetic Origin observations covering every preview group.
async function openingData(f){
 const p={};
 p.positive=await f.linked('9101');await f.observe('9101',[{id:WAREHOUSE_SOURCE,saldoFisico:10.5,saldoVirtual:9}]);
 p.zero=await f.linked('9102');await f.observe('9102',[{id:WAREHOUSE_SOURCE,saldoFisico:0,saldoVirtual:0},{id:'700002',saldoFisico:3}]);
 p.negative=await f.linked('9103');await f.observe('9103',[{id:WAREHOUSE_SOURCE,saldoFisico:-2.25}]);
 await f.stageRaw('products','9104',{id:'9104',nome:'Produto sem cadastro nativo'});await f.observe('9104',[{id:WAREHOUSE_SOURCE,saldoFisico:4}]);
 p.missing=await f.linked('9105');
 p.absent=await f.linked('9106');await f.observe('9106',[{id:'700002',saldoFisico:7}]);
 p.precision=await f.linked('9107');await f.observe('9107',[{id:WAREHOUSE_SOURCE,saldoFisico:1.1234567}]);
 p.text=await f.linked('9108');await f.observe('9108',[{id:WAREHOUSE_SOURCE,saldoFisico:'5'}]);
 p.moved=await f.linked('9109');await f.observe('9109',[{id:WAREHOUSE_SOURCE,saldoFisico:8}]);await f.post(p.moved.id,'1');
 p.service=await f.linked('9110',{kind:'S'});await f.observe('9110',[{id:WAREHOUSE_SOURCE,saldoFisico:1}]);
 p.nulled=await f.linked('9111');await f.observe('9111',[{id:WAREHOUSE_SOURCE,saldoFisico:null}]);
 p.range=await f.linked('9112');await f.observe('9112',[{id:WAREHOUSE_SOURCE,saldoFisico:1000000000000}]);
 p.duplicate=await f.linked('9113');await f.observe('9113',[{id:WAREHOUSE_SOURCE,saldoFisico:1},{id:WAREHOUSE_SOURCE,saldoFisico:2}]);
 p.trailing=await f.linked('9114');await f.stageRaw('stock_balances','9114','{"produto":{"id":"9114"},"depositos":[{"id":"700001","saldoFisico":3.1400000}]}');
 return p;
}

test('100 opening preview classifies every pair, counts groups and keeps the native unit',async()=>{
 const f=await stockOpeningFixture();try{
  const p=await openingData(f),page=await f.page();
  assert.deepEqual(page.counts,{total:14,positive:2,zero:1,negative:1,negative_blocked:1,no_native_product:1,no_observation:2,invalid:6,adopted:0,native_movements:1,pending:3});
  const row=id=>page.items.find(i=>i.product_source_id===id);
  assert.deepEqual([row('9101').status,row('9101').target,row('9101').current.quantity,row('9101').adjustment,row('9101').product.unit],['positive','10.500000',null,'10.500000','UN']);
  assert.equal(row('9102').status,'zero');assert.equal(row('9103').status,'negative_blocked');assert.equal(row('9103').reason,'NEGATIVE_NOT_ALLOWED');assert.equal(row('9103').group,'negative');
  assert.equal(row('9104').status,'no_native_product');assert.equal(row('9104').product,null);
  assert.equal(row('9105').reason,'OBSERVATION_MISSING');assert.equal(row('9106').reason,'WAREHOUSE_ABSENT');
  assert.deepEqual(['9107','9108','9110','9111','9112','9113'].map(id=>row(id).reason),['PHYSICAL_PRECISION','PHYSICAL_INVALID','PRODUCT_UNAVAILABLE','PHYSICAL_NULL','PHYSICAL_RANGE','WAREHOUSE_LIST_INVALID']);
  assert.equal(row('9109').status,'native_movements');assert.equal(row('9109').current.quantity,'1.000000');assert.equal(row('9109').adjustment,null);
  assert.equal(row('9114').target,'3.140000');
  assert.equal(page.unit_source,'native_product');assert.equal(page.policy.allow_negative,false);
  // Pagination by exact ID order and group filter.
  const first=await f.page({p_limit:5});assert.deepEqual(first.items.map(i=>i.product_source_id),['9101','9102','9103','9104','9105']);assert.equal(first.next_cursor,'9105');
  assert.deepEqual((await f.page({p_limit:5,p_after:'9105'})).items[0].product_source_id,'9106');
  assert.deepEqual((await f.page({p_group:'invalid'})).items.map(i=>i.product_source_id),['9107','9108','9110','9111','9112','9113']);
  await fails(()=>f.page({p_limit:51}),'22023');await fails(()=>f.page({p_group:'other'}),'22023');await fails(()=>f.page({p_warehouse_source_id:'700002'}),'P0002');
  // With the policy ON the negative target becomes adoptable.
  await f.setPolicy(true);assert.equal((await f.page()).counts.pending,4);
  const warehouses=await f.rpc('erp_stock_opening_warehouses',{p_user_id:f.users.admin});assert.deepEqual(warehouses.items.map(w=>[w.source_id,w.warehouse_id,w.active]),[[WAREHOUSE_SOURCE,f.warehouse.id,true]]);
 }finally{await f.close();}
});

test('100 Origin text made only of control characters is shown as absent and never breaks the closed page or batch',async()=>{
 const{parseStockOpeningPage,parseStockOpeningBatch}=await import('../../../packages/erp-domain/src/stock-opening-dto.mjs');
 const f=await stockOpeningFixture();try{
  await f.stageRaw('products','9201',{id:'9201',nome:'\t',codigo:'\n'});await f.observe('9201',[{id:WAREHOUSE_SOURCE,saldoFisico:1}]);
  const p=await f.linked('9202');await f.stageRaw('products','9202',{id:'9202',nome:' \u0085 ',codigo:'SINT-9202'});
  await f.stageRaw('stock_balances','9202',{produto:{id:'9202',codigo:'\u0007'},depositos:[{id:WAREHOUSE_SOURCE,saldoFisico:2}]});
  const page=parseStockOpeningPage(await f.page(),{warehouseSourceId:WAREHOUSE_SOURCE,limit:50});
  assert.deepEqual(page.items.map(i=>[i.product_source_id,i.source.name,i.source.code]),[['9201',null,'SINT-9201'],['9202',null,'SINT-9202']]);
  const batch=parseStockOpeningBatch(await f.batch(),{warehouseSourceId:WAREHOUSE_SOURCE,occurredOn:'2026-10-18',limit:100});
  assert.deepEqual(batch.items.map(i=>[i.product_source_id,i.product.id,i.source.name]),[['9202',p.id,null]]);
 }finally{await f.close();}
});

test('100 apply adopts a pinned batch once: adjustment per pair, zero receipt without movement, durable replay',async()=>{
 const f=await stockOpeningFixture();try{
  const p=await openingData(f),b=await f.batch();
  assert.deepEqual(b.items.map(i=>i.product_source_id),['9101','9102','9114']);assert.equal(b.pending,3);assert.match(b.preview_hash,/^[a-f0-9]{64}$/);
  const command=randomUUID(),result=await f.apply(b,{p_command_id:command});
  assert.equal(result.replayed,false);assert.deepEqual(result.receipt.summary,{adopted:2,adopted_zero:1,skipped:0});
  const byId=Object.fromEntries(result.receipt.items.map(i=>[i.product_source_id,i]));
  assert.equal(byId['9101'].outcome,'adopted');assert.equal(byId['9102'].outcome,'adopted_zero');assert.equal(byId['9102'].movement_id,null);
  const movement=await f.scalar("select to_jsonb(m)v from erp_stock.movement m where id=$1",[byId['9101'].movement_id]);
  assert.deepEqual([movement.kind,movement.reason,movement.occurred_on,movement.reference],['adjustment','Saldo de abertura (Origin)','2026-10-18','Abertura Origin depósito '+WAREHOUSE_SOURCE]);
  assert.deepEqual(await f.balance(p.positive.id),{quantity:'10.500000',version:1});assert.equal(await f.balance(p.zero.id),null);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.entry where movement_id=$1',[byId['9101'].movement_id]),1);
  const ledger=await f.scalar('select count(*)::int v from erp_stock.movement');
  // Same command, same body: stored result, no new effect. Another body: conflict.
  const replay=await f.apply(b,{p_command_id:command});assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,result.receipt);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),ledger);
  await fails(()=>f.apply(b,{p_command_id:command,p_occurred_on:'2026-10-17'}),'40001','stock_opening_command_conflict');
  // Recovery by GET reflects the receipts; a fresh command for the same pairs never adopts twice.
  const lookup=await f.command(command);assert.deepEqual(lookup.receipt,result.receipt);assert.deepEqual(lookup.current.map(r=>[r.product_source_id,r.state]),[['9101','adopted'],['9102','adopted_zero'],['9114','adopted']]);
  const again=await f.apply(b);assert.deepEqual(again.receipt.items.map(i=>[i.outcome,i.reason]),[['skipped','ALREADY_ADOPTED'],['skipped','ALREADY_ADOPTED'],['skipped','ALREADY_ADOPTED']]);
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement'),ledger);
  const page=await f.page();assert.equal(page.counts.adopted,3);assert.equal(page.items.find(i=>i.product_source_id==='9102').receipt.state,'adopted_zero');
  const next=await f.batch();assert.deepEqual(next.items,[]);assert.equal(next.preview_hash,null);assert.equal(next.pending,0);
  await fails(()=>f.db.query('update erp_stock.opening_receipt set target=1'),'40001');await fails(()=>f.db.query('delete from erp_stock.opening_command'),'40001');
 }finally{await f.close();}
});

test('100 apply refuses a tampered batch and reports changed sources, negatives and native movements per pair',async()=>{
 const f=await stockOpeningFixture();try{
  const p=await openingData(f);await f.setPolicy(true);
  const b=await f.batch({p_limit:4});assert.deepEqual(b.items.map(i=>i.product_source_id),['9101','9102','9103','9114']);
  const tampered=f.intent(b);tampered[0].target='99.000000';
  await fails(()=>f.rpc('erp_stock_opening_apply',{p_user_id:f.users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:b.occurred_on,p_items:tampered,p_preview_hash:b.preview_hash,p_command_id:randomUUID(),p_confirmed:true}),'40001','stock_opening_preview_conflict');
  await fails(()=>f.apply(b,{p_occurred_on:'2026-10-17'}),'40001','stock_opening_preview_conflict');
  await fails(()=>f.apply(b,{p_user_id:f.users.other}),'40001','stock_opening_preview_conflict');
  await fails(()=>f.apply(b,{p_confirmed:false}),'22023');
  await fails(()=>f.apply(b,{p_occurred_on:'2999-01-01'}),'22023','stock_opening_date_invalid');
  // The observation of 9101 changes after the preview; the policy goes OFF before the apply.
  await f.observe('9101',[{id:WAREHOUSE_SOURCE,saldoFisico:11}]);await f.setPolicy(false);
  const result=await f.apply(b);
  assert.deepEqual(result.receipt.items.map(i=>[i.product_source_id,i.outcome,i.reason]),[['9101','skipped','SOURCE_CHANGED'],['9102','adopted_zero',null],['9103','skipped','NEGATIVE_NOT_ALLOWED'],['9114','adopted',null]]);
  assert.equal(await f.balance(p.positive.id),null);assert.equal(await f.balance(p.negative.id),null);
  // A forged request for a pair with native movements carries a valid hash but is still never overwritten.
  const forged=[{product_source_id:'9109',product_id:p.moved.id,unit:'UN',source_hash:await f.scalar("select version_hash v from origin_sync.raw_record where entity='stock_balances'and source_id='9109'"),source_version:'1',target:'8.000000'}];
  const hash=await f.scalar("select erp_stock.opening_preview_hash($1,$2,$3,'2026-10-18',$4::jsonb)v",[f.users.admin,WAREHOUSE_SOURCE,f.warehouse.id,JSON.stringify(forged)]);
  const forgedResult=await f.rpc('erp_stock_opening_apply',{p_user_id:f.users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:'2026-10-18',p_items:forged,p_preview_hash:hash,p_command_id:randomUUID(),p_confirmed:true});
  assert.deepEqual(forgedResult.receipt.items.map(i=>[i.outcome,i.reason]),[['skipped','NATIVE_MOVEMENTS']]);assert.deepEqual(await f.balance(p.moved.id),{quantity:'1.000000',version:1});
  // With the policy ON the negative target is adopted below zero.
  await f.setPolicy(true);const negative=await f.batch();assert.deepEqual(negative.items.map(i=>i.product_source_id),['9101','9103']);
  const adopted=await f.apply(negative);assert.deepEqual(adopted.receipt.summary,{adopted:2,adopted_zero:0,skipped:0});
  assert.deepEqual(await f.balance(p.negative.id),{quantity:'-2.250000',version:1});assert.deepEqual(await f.balance(p.positive.id),{quantity:'11.000000',version:1});
 }finally{await f.close();}
});

test('100 the native unit shown in the pinned batch is confirmed: a unit change before the apply is refused per pair',async()=>{
 const{parseStockOpeningResult}=await import('../../../packages/erp-domain/src/stock-opening-dto.mjs');
 const f=await stockOpeningFixture();try{
  const a=await f.linked('9101'),b=await f.linked('9102');
  await f.observe('9101',[{id:WAREHOUSE_SOURCE,saldoFisico:10.5}]);await f.observe('9102',[{id:WAREHOUSE_SOURCE,saldoFisico:4}]);
  const first=await f.batch();assert.deepEqual(first.items.map(i=>[i.product_source_id,i.product.unit]),[['9101','UN'],['9102','UN']]);
  // The request must carry the unit the administrator saw; it is part of the preview hash.
  const missing=f.intent(first).map(({unit,...rest})=>rest);
  await fails(()=>f.rpc('erp_stock_opening_apply',{p_user_id:f.users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:first.occurred_on,p_items:missing,p_preview_hash:first.preview_hash,p_command_id:randomUUID(),p_confirmed:true}),'22023','stock_opening_items_invalid');
  const relabeled=f.intent(first);relabeled[1].unit='CX';
  await fails(()=>f.rpc('erp_stock_opening_apply',{p_user_id:f.users.admin,p_warehouse_source_id:WAREHOUSE_SOURCE,p_occurred_on:first.occurred_on,p_items:relabeled,p_preview_hash:first.preview_hash,p_command_id:randomUUID(),p_confirmed:true}),'40001','stock_opening_preview_conflict');
  // The product unit changes after the preview (no movement exists yet, so the catalogue still allows it).
  await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:a.id,p_expected_version:a.version,p_command_id:randomUUID(),p_data:{name:'Produto sintético 9101',unit:'CX',kind:'P',format:'S',price:'1'}});
  const sent=f.intent(first),command=randomUUID(),result=await f.apply(first,{p_command_id:command});
  assert.deepEqual(result.receipt.items.map(i=>[i.product_source_id,i.outcome,i.reason]),[['9101','skipped','UNIT_CHANGED'],['9102','adopted',null]]);
  assert.equal(await f.balance(a.id),null);assert.deepEqual(result.current.map(c=>[c.product_source_id,c.unit]),[['9102','UN']]);
  assert.equal(parseStockOpeningResult(result,{commandId:command,warehouseSourceId:WAREHOUSE_SOURCE,input:{command_id:command,occurred_on:first.occurred_on,preview_hash:first.preview_hash,confirmed:true,items:sent}}).receipt.summary.skipped,1);
  // The next batch shows the current unit and adopts in it.
  const next=await f.batch();assert.deepEqual(next.items.map(i=>[i.product_source_id,i.product.unit]),[['9101','CX']]);
  const adopted=await f.apply(next);assert.deepEqual(adopted.current.map(c=>[c.product_source_id,c.unit,c.target]),[['9101','CX','10.500000']]);
  assert.deepEqual(await f.scalar("select jsonb_build_object('unit',unit,'quantity',quantity::text)v from erp_stock.balance where product_id=$1",[a.id]),{unit:'CX',quantity:'10.500000'});
  assert.equal(b.id,result.current[0].product_id);
 }finally{await f.close();}
});

test('100 adoption is admin-only, revalidated after role loss, and reversed only through the normal stock reversal',async()=>{
 const f=await stockOpeningFixture();try{
  const p=await openingData(f);
  for(const role of['estoque','vendas','consulta','fiscal','financeiro']){
   await fails(()=>f.page({p_user_id:f.users[role]}),'42501');await fails(()=>f.batch({p_user_id:f.users[role]}),'42501');
   await fails(()=>f.rpc('erp_stock_opening_warehouses',{p_user_id:f.users[role]}),'42501');}
  const b=await f.batch({p_limit:1});
  await f.db.query("update erp_access.membership set role='estoque' where user_id=$1",[f.users.admin]);
  try{await fails(()=>f.apply(b),'42501');}finally{await f.db.query("update erp_access.membership set role='admin' where user_id=$1",[f.users.admin]);}
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.opening_receipt'),0);
  const command=randomUUID(),result=await f.apply(b,{p_command_id:command}),movement=result.receipt.items[0].movement_id;
  await fails(()=>f.command(command,f.users.other),'42501');await fails(()=>f.command(command,f.users.estoque),'42501');
  await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.admin]);
  try{await fails(()=>f.apply(b,{p_command_id:command}),'42501');await fails(()=>f.command(command),'42501');}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.admin]);}
  // The normal reversal undoes the opening and preserves history; receipts and preview reflect it; no re-adoption.
  const reversal=await f.reverse(movement,{day:'2026-10-18'});
  assert.equal(reversal.movement.reverses_id,movement);assert.deepEqual(await f.balance(p.positive.id),{quantity:'0.000000',version:2});
  const lookup=await f.command(command);assert.equal(lookup.current[0].state,'reversed');assert.equal(lookup.current[0].reversal_movement_id,reversal.movement.id);
  const row=(await f.page()).items.find(i=>i.product_source_id==='9101');assert.equal(row.status,'adopted_reversed');assert.equal(row.receipt.state,'reversed');
  assert.ok(!(await f.batch()).items.some(i=>i.product_source_id==='9101'));
  assert.equal(await f.scalar('select count(*)::int v from erp_stock.movement where id=$1',[movement]),1);
 }finally{await f.close();}
});

test('100 SQL→HTTP→DTO: warehouses, page, batch, apply, recovery and policy pass the closed contracts',async()=>{
 const{parseStockOpeningRoute,executeStockOpeningRoute}=await import('../src/stock-opening.mjs');
 const f=await stockOpeningFixture();try{
  await openingData(f);
  const api=async(path,body,user=f.users.admin)=>executeStockOpeningRoute(await parseStockOpeningRoute(new Request('https://erp.invalid'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})),{userId:user,rpc:f.rpc});
  const warehouses=await api('/v1/saldo-abertura-estoque');assert.equal(warehouses.items[0].source_id,WAREHOUSE_SOURCE);
  const page=await api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}?limit=50`);assert.equal(page.items.length,14);
  assert.equal((await api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}?grupo=invalid&limit=3`)).next_cursor,'9110');
  const policy=await api('/v1/politica-estoque',undefined,f.users.vendas);assert.equal(policy.can_manage,false);
  await assert.rejects(()=>api('/v1/politica-estoque',{command_id:randomUUID(),expected_version:0,allow_negative:true,reason:'Venda sem saldo na virada',confirmed:true},f.users.estoque),e=>e.status===403);
  const policyCommand=randomUUID(),changed=await api('/v1/politica-estoque',{command_id:policyCommand,expected_version:0,allow_negative:true,reason:'Venda sem saldo na virada',confirmed:true});
  assert.equal(changed.policy.allow_negative,true);assert.equal((await api('/v1/politica-estoque/comandos/'+policyCommand)).receipt.to.version,1);
  const batch=await api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}/lote`,{occurred_on:'2026-10-18',limit:100});assert.deepEqual(batch.items.map(i=>i.status),['positive','zero','negative','positive']);
  const{stockOpeningIntent}=await import('../../../packages/erp-domain/src/stock-opening-dto.mjs');const intent=stockOpeningIntent(batch,randomUUID());
  const done=await api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}/adotar`,intent);assert.deepEqual(done.receipt.summary,{adopted:3,adopted_zero:1,skipped:0});
  const recovered=await api('/v1/saldo-abertura-estoque/comandos/'+intent.command_id);assert.deepEqual(recovered.receipt,done.receipt);assert.equal(recovered.replayed,true);
  await assert.rejects(()=>api('/v1/saldo-abertura-estoque/comandos/'+intent.command_id,undefined,f.users.other),e=>e.status===403);
  await assert.rejects(()=>api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}/adotar`,{...intent,occurred_on:'2026-10-17'}),e=>e.status===409);
  const after=await api(`/v1/saldo-abertura-estoque/${WAREHOUSE_SOURCE}?grupo=adopted`);assert.deepEqual(after.items.map(i=>i.receipt.state),['adopted','adopted_zero','adopted','adopted']);
 }finally{await f.close();}
});

test('100 a policy reason with Unicode whitespace at its edges is stored as SQL btrim keeps it and stays confirmable by the API',async()=>{
 const{parseStockOpeningRoute,executeStockOpeningRoute}=await import('../src/stock-opening.mjs');
 const f=await stockOpeningFixture();try{
  const api=async(path,body)=>executeStockOpeningRoute(await parseStockOpeningRoute(new Request('https://erp.invalid'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})),{userId:f.users.admin,rpc:f.rpc});
  const command=randomUUID(),changed=await api('/v1/politica-estoque',{command_id:command,expected_version:0,allow_negative:true,reason:' Venda sem saldo na virada  ',confirmed:true});
  assert.equal(changed.receipt.reason,'Venda sem saldo na virada ');assert.equal(changed.policy.allow_negative,true);
  assert.equal((await api('/v1/politica-estoque/comandos/'+command)).receipt.reason,'Venda sem saldo na virada ');
 }finally{await f.close();}
});

test('100 negative balances pass every existing stock API projection: balances, ledger, positions, availability, document and purchase previews',async()=>{
 const{stockRoute,stockOperation,stockResponse}=await import('../src/stock.mjs');const{parseStockPositionsRoute,executeStockPositionsRoute}=await import('../src/stock-positions.mjs');
 const{parseStockReservationsRoute,executeStockReservationsRoute}=await import('../src/stock-reservations.mjs');const{parseDocumentStockRoute,executeDocumentStockRoute}=await import('../src/document-stock.mjs');
 const{parsePurchaseReceiptsRoute,executePurchaseReceiptsRoute}=await import('../src/purchase-receipts.mjs');
 const f=await stockOpeningFixture();try{
  // The stock API speaks the 105 and 145 contracts (deploy order DB → API), so the projections are checked on top of them.
  for(const name of['202610200105_stock_ledger_warehouses_origin','202610200106_stock_count','202610200107_stock_dashboards','202610200115_erp_preferences','202610200145_stock_preferences_cost'])
   await f.db.exec((await readFile(new URL(`../../../supabase/migrations/${name}.sql`,import.meta.url),'utf8')).replaceAll('\r\n','\n'));
  await f.setPolicy(true);const p=await f.catalog('products',{name:'Peça negativa100',unit:'UN',kind:'P',format:'S',price:'1'}),other=await f.catalog('warehouses',{name:'Outro depósito100'});
  await f.post(p.id,'-3');await f.post(p.id,'5',{target:other.id});
  const user=f.users.estoque,get=path=>new Request('https://erp.invalid'+path),post=(path,body)=>new Request('https://erp.invalid'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const stock=async path=>{const u=new URL('https://erp.invalid'+path),route=stockRoute(u.pathname),op=await stockOperation(get(path),route,u.searchParams);return stockResponse(await f.rpc(op.rpc,{...op.args,p_user_id:user}),route,op);};
  const balances=await stock(`/v1/estoque/saldos?product_id=${p.id}&warehouse_id=${f.warehouse.id}`);assert.equal(balances.items[0].quantity,'-3.000000');
  const ledger=await stock(`/v1/estoque/movimentos?product_id=${p.id}`);assert.ok(ledger.items.some(m=>m.items.some(i=>i.balance_after==='-3.000000')));
  // Ledger mode of 098 (offset present): the Saldo atual total is signed, filtered by depósito or summed across all of them.
  const ledgerPage=await stock(`/v1/estoque/movimentos?product_id=${p.id}&offset=0&warehouse_id=${f.warehouse.id}`);assert.equal(ledgerPage.totals.current_balance,'-3.000000');assert.equal(ledgerPage.totals.exits,'3.000000');
  assert.equal((await stock(`/v1/estoque/movimentos?product_id=${p.id}&offset=0`)).totals.current_balance,'2.000000');
  const positions=await executeStockPositionsRoute(parseStockPositionsRoute(get(`/v1/posicoes-estoque?q=Peça%20negativa100&warehouse_id=${other.id}`)),{userId:user,rpc:f.rpc});
  assert.equal(positions.items[0].global.quantity,'2.000000');assert.equal(positions.items[0].selected_position.quantity,'5.000000');
  const negative=await executeStockPositionsRoute(parseStockPositionsRoute(get(`/v1/posicoes-estoque?q=Peça%20negativa100&warehouse_id=${f.warehouse.id}`)),{userId:user,rpc:f.rpc});assert.equal(negative.items[0].selected_position.quantity,'-3.000000');
  const availability=await executeStockReservationsRoute(await parseStockReservationsRoute(get(`/v1/reservas-estoque/disponibilidade?product_id=${p.id}&warehouse_id=${f.warehouse.id}`)),{userId:user,rpc:f.rpc});
  assert.deepEqual([availability.position.state,availability.position.physical_quantity,availability.position.available_quantity],['recorded','-3.000000','-3.000000']);
  const sale=await f.order('sales_orders',[line(p,'2')]);
  const preview=await executeDocumentStockRoute(await parseDocumentStockRoute(post(`/v1/documentos-estoque/sales_orders/${sale.id}/preview`,{expected_document_version:sale.version,occurred_on:'2026-10-15',reason:'Venda sem saldo'})),{userId:user,rpc:f.rpc});
  assert.deepEqual([preview.preview.positions[0].balance_before,preview.preview.positions[0].balance_after],['-3.000000','-5.000000']);
  const purchase=await f.order('purchase_orders',[line(p,'1')]);const item=await f.scalar('select id v from erp_documents.item where document_id=$1',[purchase.id]);
  const received=await executePurchaseReceiptsRoute(await parsePurchaseReceiptsRoute(post(`/v1/recebimentos-compras/${purchase.id}/preview`,{expected_document_version:purchase.version,occurred_on:'2026-10-15',reason:'Recebimento com saldo negativo',items:[{item_id:item,quantity:'1'}]})),{userId:user,rpc:f.rpc});
  assert.deepEqual([received.preview.positions[0].physical_before,received.preview.positions[0].physical_after,received.preview.positions[0].available_after],['-3.000000','-2.000000','-2.000000']);
 }finally{await f.close();}
});
