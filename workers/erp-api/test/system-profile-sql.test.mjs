import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{systemFixture,fails}from'./helpers/system-fixture.mjs';
import{parseProfile,parseStorage,parseNotifications,parseNotificationsRead,captureNotificationsRead,parseCompanyExtra,captureCompanyExtraSave,parseCompanyExtraResult,parseUserSecurity}from'../../../packages/erp-domain/src/system-profile.mjs';
import{generatedBlock,committedBlock}from'../../../tools/preferences/generate-definitions.mjs';

const today=f=>f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
const extra=(patch={})=>({person_type:'juridica',ie_exempt:false,municipal_registration:null,suframa:null,cnae:'4751201',company_size:'micro',segments:['servicos','comercio'],revenue:'ate_60k',employees:'ate_5',
 contacts:'Fulano Sintético',mobile:'(11) 99999-0000',billing_email:'cobranca@sintetico.test',site:'www.sintetico.test',substitute_ies:[{uf:'RJ',ie:'12345678'}],...patch});

test('151 Meu perfil and Armazenamento: every active member reads them; the detail by group is for administradores',async()=>{const f=await systemFixture();try{
 await f.db.query("insert into erp_access.profile(user_id,name,version,updated_at,updated_by)values($1,'Ana Sintética',1,clock_timestamp(),$1)",[f.users.vendas]);
 await f.rpc('erp_company_save_identity',{p_user_id:f.users.admin,p_expected_version:0,p_command_id:randomUUID(),p_data:{legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',
  postal_code:'01001000',street:'Rua Sintética',number:'1',district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP'}});
 const me=parseProfile(await f.rpc('erp_access_profile_me',{p_user_id:f.users.vendas}));
 assert.deepEqual([me.name,me.email,me.role,me.company.legal_name],['Ana Sintética','vendas@sintetico.test','vendas','Empresa Sintética Ltda']);
 for(const user of[f.users.inactive,randomUUID()])await fails(assert,()=>f.rpc('erp_access_profile_me',{p_user_id:user}),'42501');
 await f.db.query("insert into storage.objects(bucket_id,name,metadata)values('erp-attachments','a/1',jsonb_build_object('size',1024)),('origin-fiscal-xml','x/1',jsonb_build_object('size',2048)),('brufap-fiscal-artifacts','y/1','{\"size\":\"10\"}'),('outro','z',null)");
 const admin=parseStorage(await f.rpc('erp_access_storage',{p_user_id:f.users.admin}));
 assert.equal(admin.total_bytes,'3082');assert.equal(admin.objects,4);assert.deepEqual(admin.groups.map(g=>[g.group,g.bytes]),[['anexos','1024'],['fiscal','2058'],['cobranca','0'],['backup','0'],['certificado','0'],['outros','0']]);
 const vendas=parseStorage(await f.rpc('erp_access_storage',{p_user_id:f.users.vendas}));assert.equal(vendas.groups,null);assert.equal(vendas.total_bytes,'3082');
}finally{await f.close();}});

test('151 Notificações: one digest per type and day for the recipients who read the module; marking read is a recorded command',async()=>{const f=await systemFixture();try{
 const day=await today(f),c=await f.catalog('contacts',{name:'Cliente atrasado'});
 await f.db.query("insert into erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,settled_cents) values($1,1,1,'receivable',$2,'Título sintético',$3::date-30,$3::date-5,15000,2500),($4,1,1,'payable',$2,'Conta sintética',$3::date-30,$3::date-1,1000,0),($5,1,1,'receivable',$2,'Em dia',$3::date,$3::date+5,500,0)",
  [randomUUID(),c.id,day,randomUUID(),randomUUID()]);
 const p=await f.catalog('products',{name:'Caneta mínima',code:'MIN-1',unit:'UN',kind:'P',format:'S',price:'1',stock_min:'5'});
 await f.document('sales_proposals',{contact:c.id,date:day,body:{next_contact:day},items:[{product_id:p.id,description:'Caneta mínima',quantity:'1',unit_price:'1'}],statuses:['open']});
 const admin=parseNotifications(await f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'nao_lidas'}),{tab:'nao_lidas'});
 assert.deepEqual(admin.items.map(n=>[n.type,n.quantity,n.amount]).sort(),[['contas_pagar_atrasadas',1,'10.00'],['contas_receber_atrasadas',1,'125.00'],['estoque_abaixo_minimo',1,null],['proximo_contato',1,null]]);
 assert.equal(admin.unread,4);
 // Opening again the same day does not create more; consulta is not a recipient until the Central lists it.
 assert.equal((await f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'todas'})).items.length,4);
 assert.equal((await f.rpc('erp_home_notifications',{p_user_id:f.users.consulta,p_tab:'nao_lidas'})).items.length,0);
 await f.preference('central-notificacoes',[{key:'notificacoes.contas_receber_atrasadas',expected_version:0,value:[f.users.vendas,f.users.consulta].sort()}]);
 assert.deepEqual((await f.rpc('erp_home_notifications',{p_user_id:f.users.consulta,p_tab:'nao_lidas'})).items.map(n=>n.type),['contas_receber_atrasadas']);
 assert.equal((await f.rpc('erp_home_notifications',{p_user_id:f.users.vendas,p_tab:'nao_lidas'})).items.length,0,'vendas does not read finanças');
 // Marking one, then all; the same command replays; another body under the same id conflicts.
 const one=captureNotificationsRead({command_id:randomUUID(),ids:[admin.items[0].id]});
 const r1=parseNotificationsRead(await f.rpc('erp_home_notifications_read',{p_user_id:f.users.admin,p_command_id:one.command_id,p_ids:one.ids}),one);
 assert.equal(r1.receipt.marked,1);assert.equal(r1.view.unread,3);
 assert.equal((await f.rpc('erp_home_notifications_read',{p_user_id:f.users.admin,p_command_id:one.command_id,p_ids:one.ids})).replayed,true);
 await fails(assert,()=>f.rpc('erp_home_notifications_read',{p_user_id:f.users.admin,p_command_id:one.command_id,p_ids:null}),'40001');
 const all=captureNotificationsRead({command_id:randomUUID(),ids:null});
 const r2=parseNotificationsRead(await f.rpc('erp_home_notifications_read',{p_user_id:f.users.admin,p_command_id:all.command_id,p_ids:null}),all);assert.deepEqual([r2.receipt.marked,r2.view.unread],[3,0]);
 await fails(assert,()=>f.rpc('erp_home_notifications_read',{p_user_id:f.users.consulta,p_command_id:randomUUID(),p_ids:[admin.items[1].id]}),'P0002');
 await fails(assert,()=>f.rpc('erp_home_notifications',{p_user_id:f.users.admin,p_tab:'x'}),'22023');
 await fails(assert,()=>f.db.query('update erp_home.notification set quantity=9'),'42501');await fails(assert,()=>f.db.query('delete from erp_home.notification'),'42501');
 assert.equal(await committedBlock('151'),generatedBlock('151'));
}finally{await f.close();}});

test('151 Dados da empresa: administrador saves with CAS and replay; everyone reads; the data is validated in SQL',async()=>{const f=await systemFixture();try{
 assert.equal(parseCompanyExtra(await f.rpc('erp_company_extra_get',{p_user_id:f.users.vendas})).record,null);
 const input=captureCompanyExtraSave({command_id:randomUUID(),expected_version:0,data:extra()}),args={p_command_id:input.command_id,p_expected_version:0,p_data:input.data};
 await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.vendas,...args}),'42501');
 const saved=parseCompanyExtraResult(await f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,...args}),input);
 assert.equal(saved.record.data.cnae,'4751-2/01');assert.deepEqual(saved.record.data.segments,['comercio','servicos']);
 assert.equal((await f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,...args})).replayed,true);
 await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,...args,p_data:extra({contacts:'Outro'})}),'40001');
 await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:0,p_data:extra({contacts:'Outro'})}),'40001');
 for(const bad of[extra({segments:[]}),extra({cnae:'12'}),extra({substitute_ies:[{uf:'RJ',ie:'1'},{uf:'RJ',ie:'22'}]}),extra({site:'sem ponto'}),extra({extra:1}),extra({company_size:'gigante'})])
  await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:1,p_data:bad}),'22023');
 await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:1,p_data:extra()}),'22023');
 assert.equal(parseCompanyExtra(await f.rpc('erp_company_extra_get',{p_user_id:f.users.fiscal})).record.version,1);
 assert.equal(await f.scalar("select count(*)::int v from erp_company.audit where action='save_extra'"),1);
}finally{await f.close();}});

test('151 Usuários security view: administrador reads sessions and second-factor attempts, never secrets; RPCs are service-only',async()=>{const f=await systemFixture();try{
 await f.db.query("insert into auth.sessions(id,user_id,created_at,updated_at,user_agent,ip,aal)values($1,$2,clock_timestamp()-interval '1 day',clock_timestamp(),'Mozilla/5.0 Sintético','203.0.113.7','aal1')",[randomUUID(),f.users.vendas]);
 const factor=randomUUID();await f.db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,secret)values($1,$2,'totp','verified',clock_timestamp(),'NEVER')",[factor,f.users.vendas]);
 await f.db.query("insert into auth.mfa_challenges(id,factor_id,created_at,verified_at,ip_address,otp_code)values($1,$2,clock_timestamp(),clock_timestamp(),'203.0.113.7','NEVER'),($3,$2,clock_timestamp()-interval '1 hour',null,'203.0.113.8','NEVER')",[randomUUID(),factor,randomUUID()]);
 const v=parseUserSecurity(await f.rpc('erp_access_user_security',{p_user_id:f.users.admin,p_target:f.users.vendas}),f.users.vendas);
 assert.equal(v.mfa,true);assert.deepEqual(v.sessions.map(s=>[s.ip,s.device]),[['203.0.113.7','Mozilla/5.0 Sintético']]);assert.deepEqual(v.challenges.map(c=>c.valid),[true,false]);
 assert.doesNotMatch(JSON.stringify(v),/NEVER/);
 await fails(assert,()=>f.rpc('erp_access_user_security',{p_user_id:f.users.consulta,p_target:f.users.vendas}),'42501');
 await fails(assert,()=>f.rpc('erp_access_user_security',{p_user_id:f.users.admin,p_target:randomUUID()}),'P0002');
 const grants=(await f.db.query(`select p.proname,array(select r.rolname from pg_roles r where has_function_privilege(r.oid,p.oid,'execute') and r.rolname in('anon','authenticated','service_role') order by 1) roles
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('erp_access_profile_me','erp_access_storage','erp_home_notifications','erp_home_notifications_read','erp_company_extra_get','erp_company_extra_save','erp_access_user_security') order by 1`)).rows;
 assert.equal(grants.length,7);for(const g of grants)assert.deepEqual(g.roles,['service_role'],g.proname);
}finally{await f.close();}});

test('151 review: a recorded company data command replays even after a later change, so a 409 to the same command means it was never recorded',async()=>{const f=await systemFixture();try{
 const first=captureCompanyExtraSave({command_id:randomUUID(),expected_version:0,data:extra()});
 await f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:first.command_id,p_expected_version:0,p_data:first.data});
 await f.rpc('erp_company_extra_save',{p_user_id:f.users.other,p_command_id:randomUUID(),p_expected_version:1,p_data:extra({contacts:'Outra pessoa'})});
 const again=await f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:first.command_id,p_expected_version:0,p_data:first.data});
 assert.equal(again.replayed,true);assert.equal(again.record.version,2);
 await fails(assert,()=>f.rpc('erp_company_extra_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_expected_version:0,p_data:first.data}),'40001');
}finally{await f.close();}});
