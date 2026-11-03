import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneCFixture,fails}from'./helpers/preferences-c-fixture.mjs';
import{STORED_PREFERENCE_PAGES}from'../../../packages/erp-domain/src/preferences/catalog.mjs';
import{definitionRows,fieldMigration,preferenceValueValid,storedFields}from'../../../packages/erp-domain/src/preferences/core.mjs';
import{MIGRATIONS,generatedBlock,committedBlock}from'../../../tools/preferences/generate-definitions.mjs';

// Wave C of Preferências and Sistema (migrations 202610200185-190, not applied yet) on top of every migration applied in
// production (through 152). Synthetic data only.
const exists=(f,sig)=>f.scalar('select to_regprocedure($1) is not null v',[sig]);

test('185 retires the tag groups and tags of 148: tables and RPCs are gone, the audit of the area stays',async()=>{const f=await laneCFixture();try{
 assert.equal(await f.scalar("select to_regclass('erp_preferences.tag') is null and to_regclass('erp_preferences.tag_group') is null v"),true);
 for(const sig of['public.erp_preferences_tag_groups(uuid,text,text)','public.erp_preferences_tags(uuid,text,uuid,text)','public.erp_preferences_tag_group_save(uuid,uuid,uuid,integer,jsonb)',
  'public.erp_preferences_tag_save(uuid,uuid,uuid,integer,jsonb)','public.erp_preferences_tags_delete(uuid,uuid,text,jsonb)','erp_preferences.tag_query(text)'])assert.equal(await exists(f,sig),false,sig);
 // The product tag screens of migration 119 are the only tags.
 assert.equal(await exists(f,'public.erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)'),true);
 // The Gerenciador de transições keeps working on the same framework tables.
 const saved=await f.rpc('erp_preferences_situation_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_kind:'sales_orders',p_situation:null,p_expected_version:0,p_data:{base_status:'open',name:'Aguardando PIX',color:'#ff8800',active:true}});
 assert.equal(saved.receipt.action,'situation_create');
 assert.equal(await f.scalar("select bool_or(pg_get_constraintdef(oid) like '%tags%') v from pg_constraint where conrelid='erp_preferences.framework_audit'::regclass and contype='c'"),true);
}finally{await f.close();}});

test('185 stops when a tag group or a tag of 148 exists, and applies once they are gone',async()=>{const f=await laneCFixture({before:'202610200185'});try{
 const group=await f.rpc('erp_preferences_tag_group_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_group:null,p_expected_version:0,p_data:{type:'produtos',name:'Cores'}});
 await assert.rejects(()=>f.migrate('202610200185_retire_preference_tags.sql'),e=>e.code==='55000'&&/preferences_tags_185_rows_exist/.test(e.message));await f.db.exec('rollback');
 assert.equal(await f.scalar('select count(*)::integer v from erp_preferences.tag_group'),1);
 await f.rpc('erp_preferences_tags_delete',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_target:'groups',p_items:[{id:group.receipt.target,expected_version:1}]});
 await f.migrate('202610200185_retire_preference_tags.sql');
 assert.equal(await f.scalar("select to_regclass('erp_preferences.tag_group') is null v"),true);
 // The audit of the retired area is immutable and still readable.
 assert.deepEqual((await f.db.query("select action from erp_preferences.framework_audit where area='tags' order by id")).rows.map(r=>r.action),['tag_group_create','tag_group_delete']);
 await fails(assert,()=>f.db.query("delete from erp_preferences.framework_audit where area='tags'"),'42501');
}finally{await f.close();}});

test('187+ every stored preference of the schema (keys of later migrations included) exists in SQL with the same rules',async()=>{const f=await laneCFixture();try{
 for(const migration of Object.keys(MIGRATIONS))assert.equal(await committedBlock(migration),generatedBlock(migration),migration);
 const pages=(await f.db.query('select id,category,scope,read_roles from erp_preferences.page order by ordinal')).rows;
 assert.deepEqual(pages.map(p=>[p.id,p.category,p.scope,p.read_roles]),STORED_PREFERENCE_PAGES.map(p=>[p.id,p.category,p.scope,[...p.readRoles]]));
 const rows=(await f.db.query('select key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format from erp_preferences.definition order by page_id,ordinal')).rows;
 // Keys of migrations after this fixture (191+, other lanes' wave D) are checked by the tests of the lane that adds them.
 const fixture=(p,x)=>fieldMigration(p,x)<='190';
 const expected=STORED_PREFERENCE_PAGES.flatMap(p=>{const keys=new Set(storedFields(p).filter(x=>fixture(p,x)).map(x=>x.key));return definitionRows(p).filter(r=>keys.has(r.key));}).sort((a,b)=>a.page_id<b.page_id?-1:a.page_id>b.page_id?1:a.ordinal-b.ordinal);
 assert.deepEqual(rows,expected.map(r=>({...r})));
 const later=STORED_PREFERENCE_PAGES.flatMap(p=>storedFields(p).filter(x=>x.since&&fixture(p,x)));assert.ok(later.length>=2);
 for(const field of later)for(const value of[[],['10000000-0000-4000-8000-000000000001'],['x'],null,'0','12.50','12.555',5,-1])
  assert.equal(await f.scalar('select erp_preferences.value_valid(d,$2::jsonb) v from erp_preferences.definition d where d.key=$1',[field.key,value===null?null:JSON.stringify(value)]),preferenceValueValid(field,value),`${field.key} ${JSON.stringify(value)}`);
}finally{await f.close();}});
