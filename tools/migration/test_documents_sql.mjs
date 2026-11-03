import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { normalizeDocument, LEGACY_TRANSITIONS, TRANSITIONS } from '../../packages/erp-domain/src/index.mjs';
import { documentsResponse, documentsRoute } from '../../workers/erp-api/src/documents.mjs';

let db, contact, product, warehouse;
const users = {};
const sqlCode = code => error => error.code === code;
before(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);');
  for (const name of ['202610160001_origin_sync.sql','202610160002_origin_quotes_nfce.sql','202610160004_erp_access.sql','202610160005_origin_auxiliary_catalogs.sql','202610160006_erp_catalog.sql','202610160008_erp_documents.sql'])
    await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8'));
  for (const role of ['admin','consulta','vendas','financeiro','estoque','fiscal','inactive']) {
    users[role]=randomUUID();
    await db.query('INSERT INTO auth.users(id) VALUES ($1)',[users[role]]);
    await db.query('INSERT INTO erp_access.membership(user_id,role,active) VALUES($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);
  }
  const create = async (entity,data) => (await rpc('erp_catalog_save',['uuid','text','uuid','int','uuid','jsonb'],[users.admin,entity,null,0,randomUUID(),JSON.stringify(data)])).record;
  contact=await create('contacts',{name:'Contato sintético'});
  product=await create('products',{name:'Produto sintético',unit:'UN',price:'1.005'});
  warehouse=await create('warehouses',{name:'Depósito sintético'});
});
after(async()=>db?.close());
async function scalar(sql,args=[]){return(await db.query(sql,args)).rows[0].value;}
async function role(name,action){await db.exec(`SET ROLE ${name}`);try{return await action();}finally{await db.exec('RESET ROLE');}}
async function rpc(name,types,args){return role('service_role',()=>scalar(`SELECT public.${name}(${types.map((t,i)=>`$${i+1}::${t}`).join(',')}) AS value`,args));}
const body=()=>({date:'2026-10-16',contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Snapshot do item',code:'00001',unit:'UN',quantity:'3',unit_price:'1.005',discount_percent:'10'}],discount_mode:'percent',discount_value:'5',freight:'1.20',other_expenses:'0.30',payment_terms:'Duas parcelas planejadas',installments:[{due_date:'2026-11-01',amount:'2.04'},{due_date:'2026-12-01',amount:'2.04'}]});
const save=({kind='sales_proposals',id=null,version=0,command=randomUUID(),data=body(),user=users.admin}={})=>rpc('erp_document_save',['uuid','text','uuid','int','uuid','jsonb'],[user,kind,id,version,command,JSON.stringify(data)]);
const get=(doc,user=users.admin)=>rpc('erp_document_get',['uuid','text','uuid'],[user,doc.kind,doc.id]);
const transition=(doc,status,reason=null,command=randomUUID(),user=users.admin)=>rpc('erp_document_transition',['uuid','text','uuid','int','uuid','text','text'],[user,doc.kind,doc.id,doc.version,command,status,reason]);
const convert=(doc,command=randomUUID(),user=users.admin)=>rpc('erp_proposal_convert',['uuid','uuid','int','uuid'],[user,doc.id,doc.version,command]);
const num=kind=>scalar('SELECT last_number::text AS value FROM erp_documents.numbering WHERE kind=$1',[kind]);
const inputFrom=doc=>({date:doc.date,contact_id:doc.contact_id,warehouse_id:doc.warehouse_id,items:doc.items.map(i=>({id:i.id,product_id:i.product_id,description:i.description,code:i.code,unit:i.unit,quantity:i.quantity,unit_price:i.unit_price,discount_percent:i.discount_percent})),discount_mode:doc.discount_mode,discount_value:doc.discount_mode==='amount'?doc.discount_value:doc.discount_value,freight:doc.freight,other_expenses:doc.other_expenses,installments:doc.installments.map(p=>({due_date:p.due_date,amount:p.amount,method:p.method}))});

test('summary pagination has exclusive stable cursors and omits items, snapshots and internal notes',async()=>{
  for(let i=0;i<3;i++)await save({kind:'purchase_orders',data:{...body(),internal_notes:'PRIVATE_SYNTHETIC_NOTE'}});
  const list=(after=null,status=null)=>rpc('erp_document_list',['uuid','text','int','uuid','text'],[users.admin,'purchase_orders',2,after,status]);
  const first=await list();assert.equal(first.items.length,2);assert.equal(first.has_more,true);assert.equal(first.next_cursor,first.items.at(-1).id);
  const next=await list(first.next_cursor);assert.ok(next.items.every(row=>row.id>first.next_cursor));
  assert.equal(new Set([...first.items,...next.items].map(row=>row.id)).size,first.items.length+next.items.length);
  for(const row of [...first.items,...next.items]){
    assert.deepEqual(Object.keys(row).sort(),['id','kind','number','status','version','date','total','contact_id','contact_name','created_at','updated_at'].sort());
    assert.equal(typeof row.total,'string');assert.equal(row.contact_name,contact.name);
  }
  assert.doesNotMatch(JSON.stringify(first),/PRIVATE_SYNTHETIC_NOTE|product_snapshot|internal_notes/);
  assert.equal((await list(null,'cancelled')).items.length,0);
});

test('real SQL normalization matches JS decimal half-up and planned installments exactly',async()=>{
  // This file loads only 008; 202610200103 widens the map and keeps the 008 one as LEGACY_TRANSITIONS.
  assert.deepEqual(await scalar('SELECT erp_documents.transitions() AS value'),LEGACY_TRANSITIONS);
  const cases=[body(),{...body(),items:[{description:'Meio centavo',unit:'UN',quantity:'1',unit_price:'0.005',discount_percent:'0'}],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[]},
    {...body(),items:[{description:'Quantidade fracionária',unit:'KG',quantity:'0.123456',unit_price:'12.3456',discount_percent:'33.3333'},{description:'Item livre',unit:'H',quantity:'1.5',unit_price:'27.9999',discount_percent:'0'}],installments:[]}];
  for(const data of cases)assert.deepEqual(await scalar('SELECT erp_documents.normalize($1,$2::jsonb) AS value',['sales_proposals',JSON.stringify(data)]),normalizeDocument('sales_proposals',data));
  assert.equal(normalizeDocument('sales_proposals',body()).totals.total,'4.08');
});
test('real SQL snapshots and calculated DTOs satisfy the HTTP projection without leaking catalog metadata',async()=>{
  const result=await save();
  const route=documentsRoute(`/v1/documentos/sales_proposals/${result.document.id}`);
  const projected=documentsResponse(result,route,{type:'document'});
  assert.equal(projected.document.totals.total,'4.08');assert.equal(projected.document.items[0].product_snapshot.price,'1.0050');
  assert.equal(projected.document.contact_snapshot.name,contact.name);assert.equal(projected.document.contact_snapshot.source,undefined);
  assert.equal(projected.document.items[0].product_snapshot.source,undefined);
  let proposal=(await transition(result.document,'open')).document;proposal=(await transition(proposal,'approved')).document;
  const converted=documentsResponse(await convert(proposal),route,{type:'conversion'});
  assert.equal(converted.sale.source_proposal_id,proposal.id);assert.equal(converted.proposal.status,'completed');
});
test('private tables/RPCs and the approved role matrix deny unintended access',async()=>{
  const tables=(await db.query("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid=relnamespace WHERE nspname='erp_documents' AND relkind='r'")).rows;
  assert.equal(tables.length,5);assert.ok(tables.every(t=>t.relrowsecurity));
  for(const apiRole of ['anon','authenticated','service_role']){
    for(const table of tables)assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS value",[apiRole,`erp_documents.${table.relname}`]),false);
    await role(apiRole,async()=>{await assert.rejects(()=>db.query('SELECT * FROM erp_documents.document'),sqlCode('42501'));
      if(apiRole!=='service_role')await assert.rejects(()=>scalar('SELECT public.erp_document_access($1) AS value',[users.admin]),sqlCode('42501'));});
  }
  const expected={admin:[4,4],consulta:[4,0],financeiro:[4,0],vendas:[3,3],estoque:[2,1],fiscal:[2,0]};
  for(const [name,[read,write]]of Object.entries(expected)){
    const access=await rpc('erp_document_access',['uuid'],[users[name]]);assert.equal(access.read.length,read);assert.equal(access.write.length,write);
    for(const kind of Object.keys(TRANSITIONS)){
      if(access.write.includes(kind))assert.equal((await save({kind,user:users[name]})).document.kind,kind);
      else await assert.rejects(()=>save({kind,user:users[name]}),sqlCode('42501'));
    }
  }
  await assert.rejects(()=>save({user:users.inactive}),sqlCode('42501'));
});
test('transactional numbering, CAS, command replay and rollback prevent duplicate documents',async()=>{
  const command=randomUUID(),before=BigInt(await num('sales_orders'));
  const first=await save({kind:'sales_orders',command});
  assert.equal(first.document.number,String(before+1n));
  assert.deepEqual(await save({kind:'sales_orders',command}),{...first,replayed:true});
  assert.equal(await num('sales_orders'),String(before+1n));
  await assert.rejects(()=>save({kind:'sales_orders',command,data:{...body(),notes:'mudança'}}),sqlCode('40001'));
  const edited=await save({kind:'sales_orders',id:first.document.id,version:1,data:{...inputFrom(first.document),notes:'Observação'}});
  assert.equal(edited.document.version,2);assert.equal(edited.document.number,first.document.number);
  await assert.rejects(()=>save({kind:'sales_orders',id:first.document.id,version:1}),sqlCode('40001'));
  const bad={...body(),items:[{...body().items[0],product_id:randomUUID()}]};
  await assert.rejects(()=>save({kind:'sales_orders',data:bad}),sqlCode('22023'));
  assert.equal(await num('sales_orders'),String(before+1n));
});
test('contact/product references and price snapshots survive later catalog changes',async()=>{
  const first=(await save()).document;
  await rpc('erp_catalog_save',['uuid','text','uuid','int','uuid','jsonb'],[users.admin,'products',product.id,product.version,randomUUID(),JSON.stringify({price:'99.99',name:'Nome atual'})]);
  product=(await rpc('erp_catalog_get',['uuid','text','uuid'],[users.admin,'products',product.id])).record;
  const edited=(await save({id:first.id,version:1,data:inputFrom(first)})).document;
  assert.equal(edited.items[0].product_snapshot.price,'1.0050');
  assert.equal(edited.items[0].unit_price,'1.0050');
  assert.equal(edited.items[0].id,first.items[0].id);
  const cross=(await save()).document;
  const invalid=inputFrom(edited);invalid.items[0].id=cross.items[0].id;
  await assert.rejects(()=>save({id:edited.id,version:edited.version,data:invalid}),sqlCode('22023'));
  await assert.rejects(()=>save({data:{...body(),contact_id:product.id}}),sqlCode('22023'));
});
test('invalid money, totals, dates, shapes, FK and body sizes fail without partial writes',async()=>{
  const before=await scalar('SELECT count(*)::int AS value FROM erp_documents.document');
  for(const data of [{...body(),total:'0'},{...body(),date:'2026-02-30'},{...body(),status:'approved'},
    {...body(),items:[{...body().items[0],unit_price:1.005}]},{...body(),items:[{...body().items[0],quantity:'0'}]},
    {...body(),items:[{...body().items[0],discount_percent:'100.0001'}]},
    {...body(),installments:[{due_date:'2026-11-01',amount:'0.01'}]},
    {...body(),discount_mode:'amount',discount_value:'999.99'},
    {...body(),items:[{...body().items[0],quantity:'999999999',unit_price:'9999999999'}],installments:[]},
    {...body(),notes:'x'.repeat(262145)}])await assert.rejects(()=>save({data}),sqlCode('22023'));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_documents.document'),before);
});
test('the exact upsert branch cannot overwrite an item that belongs to another document',async()=>{
  const foreign=(await save()).document,own=(await save()).document;
  const original=await get(foreign),ownOriginal=await get(own);
  const functionText=await scalar("SELECT pg_get_functiondef('erp_documents.replace_items(uuid,jsonb)'::regprocedure) AS value");
  assert.match(functionText,/where erp_documents\.item\.document_id=excluded\.document_id;\s+if not found then raise exception 'erp_document_foreign_item'/);
  // Execute the actual final INSERT branch with the conflict already visible, as it
  // would be after a concurrent commit. PGlite is single-connection; no race is claimed.
  const branch=functionText.slice(functionText.indexOf('  insert into erp_documents.item'),functionText.indexOf(' end loop;',functionText.indexOf('  insert into erp_documents.item')));
  await db.exec(`CREATE FUNCTION public.qa_document_upsert(p_document uuid,v jsonb) RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${branch} END $$`);
  try{
    const item={...foreign.items[0],description:'Attempted replacement'};
    await assert.rejects(()=>db.query('SELECT public.qa_document_upsert($1::uuid,$2::jsonb)',[own.id,JSON.stringify(item)]),sqlCode('22023'));
    assert.deepEqual(await get(foreign),original);assert.deepEqual(await get(own),ownOriginal);
    const input=inputFrom(own);input.items[0].id=foreign.items[0].id;
    await assert.rejects(()=>save({id:own.id,version:own.version,data:input}),sqlCode('22023'));
  }finally{await db.exec('DROP FUNCTION public.qa_document_upsert(uuid,jsonb);');}
});
test('approval locks proposals; conversion copies snapshots once and completes the quote without cycles',async()=>{
  let proposal=(await save()).document;
  proposal=(await transition(proposal,'open')).document;
  proposal=(await transition(proposal,'approved')).document;
  await assert.rejects(()=>save({id:proposal.id,version:proposal.version,data:inputFrom(proposal)}),sqlCode('40001'));
  const command=randomUUID(),first=await convert(proposal,command);
  assert.equal(first.proposal.status,'completed');assert.equal(first.sale.status,'draft');
  assert.equal(first.sale.source_proposal_id,proposal.id);assert.equal(first.sale.totals.total,proposal.totals.total);
  assert.deepEqual(first.sale.contact_snapshot,proposal.contact_snapshot);
  assert.deepEqual(first.sale.items[0].product_snapshot,proposal.items[0].product_snapshot);
  assert.notEqual(first.sale.items[0].id,proposal.items[0].id);
  assert.deepEqual(first.sale.installments,proposal.installments);
  assert.deepEqual(await convert(proposal,command),{...first,replayed:true});
  await assert.rejects(()=>convert(proposal),sqlCode('40001'));
  await assert.rejects(()=>convert(first.proposal),sqlCode('40001'));
  await assert.rejects(()=>transition(first.proposal,'open','Reabrir'),sqlCode('22023'));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_documents.document WHERE source_proposal_id=$1',[proposal.id]),1);
  assert.equal(first.operational_effects,false);
});
test('templates and unapproved proposals cannot convert; cancellation/reopening requires audited reason',async()=>{
  let ordinary=(await save()).document;
  await assert.rejects(()=>convert(ordinary),sqlCode('22023'));
  await assert.rejects(()=>transition(ordinary,'cancelled'),sqlCode('22023'));
  ordinary=(await transition(ordinary,'cancelled','Cliente solicitou cancelamento')).document;
  await assert.rejects(()=>save({id:ordinary.id,version:ordinary.version}),sqlCode('40001'));
  await assert.rejects(()=>transition(ordinary,'open'),sqlCode('22023'));
  ordinary=(await transition(ordinary,'open','Cliente retomou negociação')).document;
  assert.equal(ordinary.status,'open');
  const reasons=(await db.query("SELECT reason FROM erp_documents.audit WHERE document_id=$1 AND action='transition' ORDER BY id",[ordinary.id])).rows;
  assert.deepEqual(reasons.map(r=>r.reason),['Cliente solicitou cancelamento','Cliente retomou negociação']);
  let template=(await save({data:{...body(),template:true}})).document;
  template=(await transition(template,'open')).document;
  await assert.rejects(()=>transition(template,'approved'),sqlCode('22023'));
});
test('service workflow retains equipment data and ending states remain purely documentary',async()=>{
  const reception=(await save({kind:'service_orders',data:{date:'2026-10-16',contact_id:contact.id,items:[],equipment:'Equipamento recebido',defect:'A diagnosticar'}})).document;
  assert.equal(reception.items.length,0);assert.equal(reception.totals.total,'0.00');
  let doc=(await save({kind:'service_orders',data:{...body(),equipment:'Máquina sintética',serial_number:'DEMO-001',technician:'Equipe interna',defect:'Falha relatada',solution:'Solução prevista'}})).document;
  for(const status of ['quoted','approved','in_progress','waiting_parts','in_progress','service_done','finalized'])doc=(await transition(doc,status)).document;
  assert.equal(doc.status,'finalized');assert.equal(doc.equipment,'Máquina sintética');
  assert.equal((await get(doc)).operational_effects,false);
  await assert.rejects(()=>save({kind:doc.kind,id:doc.id,version:doc.version,data:inputFrom(doc)}),sqlCode('40001'));
  doc=(await transition(doc,'open','Revisão autorizada')).document;assert.equal(doc.status,'open');
  assert.equal(await scalar('SELECT count(*)::int AS value FROM origin_sync.raw_record'),0);
});

test('multi-item conversion preserves positions and generates independent unique line identities',async()=>{
  const data={...body(),items:[1,2,3].map(n=>({...body().items[0],description:`Linha ${n}`,quantity:String(n)})),installments:[]};
  let proposal=(await save({data})).document;
  proposal=(await transition(proposal,'open')).document;proposal=(await transition(proposal,'approved')).document;
  const result=await convert(proposal);
  assert.equal(result.sale.items.length,3);assert.equal(new Set(result.sale.items.map(i=>i.id)).size,3);
  assert.deepEqual(result.sale.items.map(i=>i.position),[1,2,3]);
  assert.ok(result.sale.items.every(i=>!proposal.items.some(p=>p.id===i.id)));
  assert.deepEqual(result.sale.items.map(i=>i.total),proposal.items.map(i=>i.total));
  assert.equal(result.sale.totals.total,proposal.totals.total);
  const reordered=inputFrom(result.sale);reordered.items.reverse();
  const edited=(await save({kind:'sales_orders',id:result.sale.id,version:result.sale.version,data:reordered})).document;
  assert.deepEqual(edited.items.map(i=>i.id),result.sale.items.map(i=>i.id).reverse());
  assert.deepEqual(edited.items.map(i=>i.position),[1,2,3]);
});
