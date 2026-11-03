import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneCFixture,fails}from'./helpers/preferences-c-fixture.mjs';
import{parseNotifications,parseExpiring,captureNotificationsQuery}from'../../../packages/erp-domain/src/system-profile.mjs';
import{generatedBlock,committedBlock}from'../../../tools/preferences/generate-definitions.mjs';

// 187 (not applied yet): Cliente a ser visitado, Produto com data de validade próxima and the home "Produtos próximos da
// validade", on every migration applied in production plus wave C. Synthetic data only.
const day=async(f,offset=0)=>f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date+$1::integer)::text v",[offset]);
async function product(f,name,offset){
 const p=await f.catalog('products',{name,unit:'UN',kind:'P',format:'S',price:'10'});
 if(offset!==null)await f.db.query('insert into erp_catalog.product_detail(record_id,expiry_date) values($1,$2::date) on conflict(record_id) do update set expiry_date=excluded.expiry_date',[p.id,await day(f,offset)]);
 return p;
}
const bell=async(f,user)=>parseNotifications(await f.rpc('erp_home_notifications',{p_user_id:user,p_tab:'todas'}),captureNotificationsQuery({aba:'todas'}));

test('187 the Central de Notificações gains Cliente a ser visitado, Produto com data de validade próxima and Certificado A1 after the keys of 151',async()=>{const f=await laneCFixture();try{
 assert.equal(await committedBlock('187'),generatedBlock('187'),'run node tools/preferences/generate-definitions.mjs --write');
 assert.equal(await committedBlock('151'),generatedBlock('151'),'the applied 151 block never changes');
 // The page as 187 left it (283, wave F, adds Lote próximo ao vencimento as the 12th key: the current contract reads that page only after 283).
 const page=await f.rpc('erp_preferences_page',{p_user_id:f.users.admin,p_page:'central-notificacoes'});
 assert.deepEqual(page.items.slice(-3).map(i=>[i.key,i.version]),[['notificacoes.cliente_visitado',0],['notificacoes.validade',0],['notificacoes.certificado_a1',0]]);
 assert.equal(page.items.length,11);
 const saved=await f.preference('central-notificacoes','notificacoes.validade',[f.users.estoque]);assert.equal(saved.receipt.changes[0].key,'notificacoes.validade');
}finally{await f.close();}});

test('187 daily notifications: products expiring within the days of Configurações de produtos and contacts to visit today, to the right roles',async()=>{const f=await laneCFixture();try{
 await f.preference('cadastros-produtos','produtos.dias_aviso_validade',10);
 await product(f,'Iogurte sintético',5);await product(f,'Leite sintético',0);await product(f,'Queijo vencido',-3);await product(f,'Arroz distante',40);await product(f,'Sem validade',null);
 const removed=await product(f,'Excluído sintético',2);await f.rpc('erp_catalog_product_set_deleted',{p_user_id:f.users.admin,p_id:removed.id,p_expected_version:removed.version,p_command_id:randomUUID(),p_deleted:true});
 const contact=await f.catalog('contacts',{name:'Cliente a visitar'});
 await f.db.query('insert into erp_catalog.contact_profile(record_id,next_visit) values($1,$2::date) on conflict(record_id) do update set next_visit=excluded.next_visit',[contact.id,await day(f)]);
 const admin=await bell(f,f.users.admin);const byType=Object.fromEntries(admin.items.map(n=>[n.type,n]));
 assert.equal(byType.validade.quantity,2,'only today .. today+10, active and not deleted');assert.equal(byType.validade.amount,null);
 assert.equal(byType.cliente_visitado.quantity,1);
 // Recipients: nobody chosen means the administradores; a chosen recipient who reads the module receives it.
 await f.preference('central-notificacoes','notificacoes.validade',[f.users.estoque,f.users.financeiro].sort());
 assert.ok((await bell(f,f.users.estoque)).items.some(n=>n.type==='validade'));
 assert.ok(!(await bell(f,f.users.financeiro)).items.some(n=>n.type==='validade'),'financeiro does not read products');
 assert.ok(!(await bell(f,f.users.vendas)).items.some(n=>n.type==='cliente_visitado'),'not a chosen recipient');
 await f.preference('central-notificacoes','notificacoes.cliente_visitado',[f.users.financeiro]);
 assert.ok((await bell(f,f.users.financeiro)).items.some(n=>n.type==='cliente_visitado'));
 // Once per type and day.
 await bell(f,f.users.admin);assert.equal(await f.scalar("select count(*)::integer v from erp_home.notification where user_id=$1 and type='validade'",[f.users.admin]),1);
 await assert.rejects(()=>f.db.query("insert into erp_home.notification(user_id,type,day,quantity) values($1,'lote_vencimento',current_date,1)",[f.users.admin]),e=>e.code==='23514');
}finally{await f.close();}});

test('187 Produtos próximos da validade on the home: expired included, earliest first, at most 20 with the total, product readers only',async()=>{const f=await laneCFixture();try{
 const empty=parseExpiring(await f.rpc('erp_home_expiring',{p_user_id:f.users.admin}));assert.deepEqual([empty.days,empty.total,empty.items],[0,0,[]]);
 await f.preference('cadastros-produtos','produtos.dias_aviso_validade',7);
 await product(f,'Iogurte sintético',5);await product(f,'Queijo vencido',-3);await product(f,'Leite sintético',0);await product(f,'Arroz distante',8);
 for(let i=0;i<20;i++)await product(f,`Lote sintético ${String(i).padStart(2,'0')}`,6);
 const v=parseExpiring(await f.rpc('erp_home_expiring',{p_user_id:f.users.vendas}));
 assert.equal(v.days,7);assert.equal(v.total,23);assert.equal(v.items.length,20);
 assert.deepEqual(v.items.slice(0,3).map(p=>[p.name,p.expired]),[['Queijo vencido',true],['Leite sintético',false],['Iogurte sintético',false]]);
 assert.equal(v.business_date,await day(f));
 for(const role of['financeiro','inactive'])await fails(assert,()=>f.rpc('erp_home_expiring',{p_user_id:f.users[role]}),'42501');
 for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.erp_home_expiring(uuid)','execute') v`),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_home_expiring(uuid)','execute') v"),true);
 assert.equal(await f.scalar("select has_function_privilege('service_role','erp_home.expiring_products(date,date)','execute') v"),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role','public.erp_home_notifications(uuid,text)','execute') v"),true);
 // The contract refuses an item past the limit or out of order.
 const raw=await f.rpc('erp_home_expiring',{p_user_id:f.users.admin});
 assert.throws(()=>parseExpiring({...raw,items:[...raw.items].reverse()}));assert.throws(()=>parseExpiring({...raw,days:0}));
}finally{await f.close();}});

// The A1 in custody, written straight into the tables of 041 (only the validity of the metadata matters here).
async function custody(f,notAfter){
 const id=randomUUID(),hash=randomUUID().replace(/-/g,'').repeat(2);
 await f.db.query("insert into erp_a1.credential(id,context,metadata,actor) values($1,'{}'::jsonb,jsonb_build_object('not_before','2026-01-01T00:00:00Z','not_after',$2::text),$3)",[id,notAfter,f.users.admin]);
 await f.db.query("insert into erp_a1.sealed_object(hash,credential_id,size_bytes,key_id) values($1,$2,10,'k1')",[hash,id]);
 await f.db.query('update erp_a1.head set version=version+1,credential_id=$1,object_hash=$2',[id,hash]);
}
const notAfter=async(f,offset)=>f.scalar("select to_char((((clock_timestamp() at time zone 'America/Sao_Paulo')::date+$1::integer)::timestamp+interval '12 hours') at time zone 'America/Sao_Paulo' at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') v",[offset]);
test('187 Certificado A1 próximo do vencimento: within 30 days or already ended, only to administrador and fiscal',async()=>{const f=await laneCFixture();try{
 const types=async user=>(await bell(f,user)).items.map(n=>n.type);
 // The digest of today (the bell keeps one immutable row per user, type and day).
 const digest=async()=>f.scalar("select sum(quantity)::integer v from erp_home.notification_digest('certificado_a1',(clock_timestamp() at time zone 'America/Sao_Paulo')::date)");
 assert.equal(await digest(),0,'no certificate in custody');
 await custody(f,await notAfter(f,45));assert.equal(await digest(),0,'45 days away');
 await custody(f,await notAfter(f,31));assert.equal(await digest(),0,'31 days away');
 await custody(f,await notAfter(f,30));
 const admin=(await bell(f,f.users.admin)).items.find(n=>n.type==='certificado_a1');assert.deepEqual([admin.quantity,admin.amount],[1,null]);
 await f.preference('central-notificacoes','notificacoes.certificado_a1',[f.users.fiscal,f.users.vendas].sort());
 assert.ok((await types(f.users.fiscal)).includes('certificado_a1'));
 assert.ok(!(await types(f.users.vendas)).includes('certificado_a1'),'vendas does not handle the certificate');
 await custody(f,await notAfter(f,-2));assert.equal(await digest(),1,'an ended certificate keeps warning');
}finally{await f.close();}});

test('187 stops when a notification function it replaces is not the expected version',async()=>{const f=await laneCFixture({before:'202610200187'});try{
 await f.db.exec("create or replace function erp_home.notification_types() returns text[] language sql immutable set search_path=pg_catalog as $body$ select array['contas_pagar_atrasadas'] $body$;");
 await assert.rejects(()=>f.migrate('202610200187_notifications_expiry.sql'),e=>e.code==='55000'&&/notifications_187_previous_definition_changed/.test(e.message));
}finally{await f.close();}});
