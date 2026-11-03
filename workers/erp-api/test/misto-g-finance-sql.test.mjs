import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{mistoGFixture,fails}from'./helpers/misto-g-fixture.mjs';

// Synthetic data only. 303: with contas lançadas (or an active Faturamento agrupado) a document still saves Observações and
// Observações internas (the contract of wave G with the documentos lane, erp_document_notes_save); everything else stays locked.
async function postedOrder(f){
 const contact=await f.catalog('contacts',{name:'Cliente Sintético G',person_type:'F'});
 let d=(await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),
  p_body:{date:'2026-10-15',contact_id:contact.id,items:[{description:'Peça sintética',unit:'UN',quantity:'2',unit_price:'10',discount_percent:'0'}],
   installments:[{due_date:'2099-01-10',amount:'20.00'}],notes:'Antes',internal_notes:'Interna antes'}})).document;
 for(const s of d.status==='draft'?['open','verified']:['verified'])d=await f.transition(d,s);
 const scope={p_user_id:f.users.admin,p_kind:'sales_orders',p_document_id:d.id,p_expected_version:d.version};
 const preview=await f.rpc('erp_document_finance_preview',scope);
 await f.rpc('erp_document_finance_post',{...scope,p_command_id:randomUUID(),p_preview_hash:preview.preview.preview_hash});
 return d.id;
}
const row=async(f,id)=>(await f.db.query('select status,version,body,total::text total from erp_documents.document where id=$1',[id])).rows[0];
// What erp_document_notes_save writes: the two texts, a new version and the actor; nothing else.
const notesWrite=(f,id,notes,internal)=>f.db.query(`update erp_documents.document set body=body||jsonb_build_object('notes',$2::text,'internal_notes',$3::text),version=version+1,
 updated_at=clock_timestamp(),updated_by=$4 where id=$1`,[id,notes,internal,f.users.admin]);

test('303 contas lançadas: only Observações and Observações internas change; the rest of the document and the items stay locked',async()=>{const f=await mistoGFixture();try{
 const id=await postedOrder(f);
 assert.equal(await f.scalar("select count(*)::integer v from erp_finance.document_posting where document_id=$1 and state='active'",[id]),1);
 const before=await row(f,id);
 await notesWrite(f,id,'Observação nova','Interna nova');
 const after=await row(f,id);
 assert.deepEqual([after.body.notes,after.body.internal_notes,after.status,after.total,after.version],['Observação nova','Interna nova',before.status,before.total,before.version+1]);
 const rest=b=>{const{notes,internal_notes,...other}=b;return other;};assert.deepEqual(rest(after.body),rest(before.body));
 // Clearing them is a change of the same two fields.
 await f.db.query(`update erp_documents.document set body=body-'notes'-'internal_notes',version=version+1 where id=$1`,[id]);
 // Any other field of the body, the total, the contact or a change of situação with the notes stays refused.
 await fails(assert,()=>f.db.query(`update erp_documents.document set body=body||'{"notes":"x","freight":"9.00"}'::jsonb,version=version+1 where id=$1`,[id]),'40001');
 await fails(assert,()=>f.db.query('update erp_documents.document set total=total+1,version=version+1 where id=$1',[id]),'40001');
 await fails(assert,()=>f.db.query(`update erp_documents.document set body=body||'{"notes":"x"}'::jsonb,status='cancelled',version=version+1 where id=$1`,[id]),'40001');
 await fails(assert,()=>f.db.query('delete from erp_documents.document where id=$1',[id]),'40001');
 // Items: the identical rewrite passes, a change, a new item or a removal does not.
 await f.db.query('update erp_documents.item set quantity=quantity where document_id=$1',[id]);
 await fails(assert,()=>f.db.query('update erp_documents.item set quantity=quantity+1 where document_id=$1',[id]),'40001');
 await fails(assert,()=>f.db.query('delete from erp_documents.item where document_id=$1',[id]),'40001');
 await fails(assert,()=>f.db.query(`insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
  select gen_random_uuid(),document_id,position+1,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data from erp_documents.item where document_id=$1`,[id]),'40001');
 // The allowed transitions with contas lançadas do not change (Verificado -> Em andamento).
 const current=(await f.db.query('select version from erp_documents.document where id=$1',[id])).rows[0].version;
 const moved=await f.transition({kind:'sales_orders',id,version:current},'in_progress');assert.equal(moved.status,'in_progress');
 // Private helpers: no grant to the API roles.
 for(const sig of['erp_finance.notes_edit_allowed(erp_documents.document,erp_documents.document)','erp_finance.notes_item_allowed(text,erp_documents.item,erp_documents.item)','erp_finance.guard_posted_document()'])
  for(const role of['anon','authenticated','service_role'])assert.equal(await f.scalar(`select has_function_privilege('${role}','${sig}','execute') v`),false,`${role} ${sig}`);
}finally{await f.close();}});

test('303 the notes rule itself (the same for an active Faturamento agrupado), and a document without contas stays free',async()=>{const f=await mistoGFixture();try{
 const contact=await f.catalog('contacts',{name:'Cliente Sem Contas',person_type:'F'});
 const d=await f.document('sales_orders',{contact:contact.id,items:[{description:'Item livre',quantity:'1',unit_price:'5',discount_percent:'0'}]});
 // Without contas the document row is free (the module rules decide).
 await f.db.query(`update erp_documents.document set body=body||'{"freight":"1.00"}'::jsonb,version=version+1 where id=$1`,[d.id]);
 // The rule itself: notes and internal notes only, with the same situação.
 const check=(patch,status=null)=>f.scalar(`select erp_finance.notes_edit_allowed(o,n) v from erp_documents.document o,
  lateral(select (jsonb_populate_record(o,jsonb_build_object('body',o.body||$2::jsonb,'version',o.version+1)||case when $3::text is null then '{}'::jsonb else jsonb_build_object('status',$3::text) end)).*) n where o.id=$1`,[d.id,JSON.stringify(patch),status]);
 assert.equal(await check({notes:'a',internal_notes:'b'}),true);
 assert.equal(await check({notes:'a',seller_id:null}),false);
 assert.equal(await check({notes:'a'},'cancelled'),false);
}finally{await f.close();}});

test('303 replaces only the published guards: another version stops the migration',async()=>{const f=await mistoGFixture({before:'202610200303'});try{
 await f.db.exec(`create or replace function erp_finance.guard_posted_item() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin return new;end$$;`);
 await assert.rejects(()=>f.migrate('202610200303_finance_notes_guard.sql'),e=>e.code==='55000'&&/finance_notes_guard_303_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
