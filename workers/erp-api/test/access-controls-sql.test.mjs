import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{laneDFixture,fails}from'./helpers/preferences-d-fixture.mjs';
import{PERMISSION_KEYS,permissionStatus,parseControls,parseControlsResult,captureControlsSave,parseMyPermissions}from'../../../packages/erp-domain/src/user-permissions.mjs';
import{parseUsersList,captureUsersQuery}from'../../../packages/erp-domain/src/access-users.mjs';

// 229 Sistema › Usuários: Tipo de usuário, Restringir horários de acesso and Permissões (PRF-206, PRF-214, PRF-216..224, CTT-110). Synthetic data only.
const ALL_DAYS=[0,1,2,3,4,5,6],ALWAYS={start:'00:00',end:'23:59',days:ALL_DAYS};
const todaySP=()=>Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',weekday:'short'}).formatToParts(new Date()).find(p=>p.type==='weekday').value.replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/,d=>({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6})[d]));
function controls(f){
 const get=(target,user=f.users.admin)=>f.rpc('erp_access_user_controls_get',{p_user_id:user,p_target:target});
 const save=async(target,data,{version,user=f.users.admin,command=randomUUID()}={})=>{const v=version??(await get(target)).version;
  const body=captureControlsSave({command_id:command,expected_version:v,data:{user_type:'normal',schedule:{enabled:false,windows:[]},permissions:null,...data}});
  const raw=await f.rpc('erp_access_user_controls_save',{p_user_id:user,p_command_id:body.command_id,p_target:target,p_expected_version:body.expected_version,p_data:body.data});
  return parseControlsResult(raw,{target,input:body});};
 return{get,save};
}

test('229 RPCs are service-only, the helpers private; the catalog is the one of the screen; erp_access_me is replaced only from 004',async()=>{const f=await laneDFixture();try{
 for(const sig of['erp_access_user_controls_get(uuid,uuid)','erp_access_user_controls_save(uuid,uuid,uuid,integer,jsonb)','erp_access_permissions_me(uuid)','erp_access_gate(uuid)','erp_access_me(uuid)',
  'erp_access_users_list_v2(uuid,text,text,text,integer,integer)','erp_home_business_panel(uuid,text,jsonb)']){
  assert.equal(await f.scalar(`select has_function_privilege('service_role','public.${sig}','execute') v`),true,sig);
  for(const role of['anon','authenticated'])assert.equal(await f.scalar(`select has_function_privilege('${role}','public.${sig}','execute') v`),false,`${role} ${sig}`);}
 for(const sig of['erp_access.permitted(uuid,text)','erp_access.schedule_allows(uuid,timestamp with time zone)','erp_access.require_schedule(uuid)','erp_access.require_permission(uuid,text)'])
  assert.equal(await f.scalar(`select has_function_privilege('service_role','${sig}','execute') v`),false,sig);
 assert.equal(await f.scalar("select has_table_privilege('service_role','erp_access.user_control','select') v"),false);
 assert.deepEqual(await f.scalar('select erp_access.permission_keys() v'),PERMISSION_KEYS.filter(k=>permissionStatus(k)!=='admin'));
}finally{await f.close();}
 const g=await laneDFixture({before:'202610200229'});try{
  await g.db.exec("create or replace function public.erp_access_me(p_user_id uuid) returns jsonb language sql stable security definer set search_path=pg_catalog as $$ select '{}'::jsonb $$");
  await assert.rejects(()=>g.migrate('202610200229_access_controls.sql'),e=>e.code==='55000'&&/access_controls_229_previous_definition_changed/.test(e.message));
 }finally{await g.close();}
});

test('229 controls: one command with CAS, replay, audit; the administrador keeps everything; only an administrador changes them',async()=>{const f=await laneDFixture();try{
 const{get,save}=controls(f);
 const fresh=parseControls(await get(f.users.vendas),f.users.vendas);
 assert.deepEqual([fresh.version,fresh.user_type,fresh.schedule,fresh.permissions,fresh.gate_required],[0,'normal',{enabled:false,windows:[]},null,false]);
 const command=randomUUID(),data={user_type:'contador',schedule:{enabled:true,windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}]},permissions:['meu_negocio.dashboard','meu_negocio.dashboard.mensal']};
 const saved=await save(f.users.vendas,data,{command});
 assert.deepEqual([saved.controls.version,saved.controls.user_type,saved.controls.gate_required,saved.replayed],[1,'contador',true,false]);
 const again=await save(f.users.vendas,data,{command,version:0});assert.equal(again.replayed,true);assert.equal(again.controls.version,1);
 await fails(assert,()=>save(f.users.vendas,{...data,user_type:'normal'},{command,version:0}),'40001');
 await fails(assert,()=>save(f.users.vendas,data,{version:0}),'40001');
 await fails(assert,()=>save(f.users.vendas,data),'22023');// unchanged
 const audit=(await f.db.query("select a.before_data,a.after_data,c.kind from erp_access.user_audit a join erp_access.user_command c on c.id=a.command_id where a.target=$1",[f.users.vendas])).rows;
 assert.equal(audit.length,1);assert.equal(audit[0].kind,'controls');assert.equal(audit[0].after_data.user_type,'contador');assert.equal(audit[0].before_data.permissions,null);
 // Administrador: every permission and never blocked; the type can change.
 await fails(assert,()=>save(f.users.other,{schedule:{enabled:true,windows:[ALWAYS]}}),'22023');
 await fails(assert,()=>save(f.users.other,{permissions:['outros.sped']}),'22023');
 assert.equal((await save(f.users.other,{user_type:'contador'})).controls.user_type,'contador');
 for(const user of[f.users.vendas,f.users.consulta,f.users.inactive])await fails(assert,()=>get(f.users.other,user),'42501');
 // Invalid windows and permission sets are refused by the database too.
 for(const bad of[{schedule:{enabled:true,windows:[]}},{schedule:{enabled:false,windows:[{start:'18:00',end:'08:00',days:[1]}]}},{schedule:{enabled:false,windows:[{start:'08:00',end:'18:00',days:[3,1]}]}},
  {permissions:['meu_negocio.dashboard.mensal']},{permissions:['outros.usuarios']},{permissions:['x.y']}])
  await fails(assert,()=>f.rpc('erp_access_user_controls_save',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_target:f.users.estoque,p_expected_version:0,
   p_data:{user_type:'normal',schedule:{enabled:false,windows:[]},permissions:null,...bad}}),'22023');
 await fails(assert,()=>f.db.query('delete from erp_access.user_audit'),'42501');
}finally{await f.close();}});

test('229 PRF-214/CTT-110 access windows: São Paulo weekday and minute, the end minute included, the seller windows too; the administrador is never blocked',async()=>{const f=await laneDFixture();try{
 const{save}=controls(f);
 await save(f.users.vendas,{schedule:{enabled:true,windows:[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}]}});
 const allows=(user,at)=>f.scalar('select erp_access.schedule_allows($1,$2::timestamptz) v',[user,at]);
 assert.equal(await allows(f.users.vendas,'2026-10-19 14:00:00-03'),true,'monday afternoon');
 assert.equal(await allows(f.users.vendas,'2026-10-19 18:00:40-03'),true,'the Fim minute is included');
 assert.equal(await allows(f.users.vendas,'2026-10-19 18:01:00-03'),false);
 assert.equal(await allows(f.users.vendas,'2026-10-18 10:00:00-03'),false,'sunday');
 assert.equal(await allows(f.users.vendas,'2026-10-19 23:30:00+00'),false,'23:30 UTC is 20:30 in São Paulo: outside the window');
 assert.equal(await allows(f.users.vendas,'2026-10-24 12:00:00+00'),false,'saturday 09:00 in São Paulo');assert.equal(await allows(f.users.vendas,'2026-10-23 12:00:00+00'),true,'friday 09:00 in São Paulo');
 assert.equal(await f.scalar("select erp_access.schedule_until($1,'2026-10-19 14:00:00-03'::timestamptz)::text v",[f.users.vendas]),'2026-10-19 18:00:59-03');
 for(const at of['2026-10-18 03:00:00-03','2026-10-19 23:00:00-03'])assert.equal(await allows(f.users.admin,at),true,`admin ${at}`);
 assert.equal(await allows(f.users.estoque,'2026-10-18 03:00:00-03'),true,'no windows, no restriction');
 // A seller linked to the user (Cadastros › Vendedores) narrows the access too.
 const contact=await f.catalog('contacts',{name:'Vendedor Sintético'});
 await f.db.query("insert into erp_catalog.seller(id,contact_id,user_id,access_hours_enabled,access_windows,version,created_by,updated_by) values(gen_random_uuid(),$1,$2,true,$3,1,$4,$4)",
  [contact.id,f.users.estoque,JSON.stringify([{start:'09:00',end:'12:00',days:[1]}]),f.users.admin]);
 assert.equal(await allows(f.users.estoque,'2026-10-19 10:00:00-03'),true);assert.equal(await allows(f.users.estoque,'2026-10-19 14:00:00-03'),false);
 assert.equal(await f.scalar('select erp_access.gate_required($1) v',[f.users.estoque]),true);
 assert.equal((await controls(f).get(f.users.estoque)).seller.name,'Vendedor Sintético');
 // Now: open or closed according to today's weekday in São Paulo.
 const other=(todaySP()+3)%7;
 await save(f.users.financeiro,{schedule:{enabled:true,windows:[{start:'00:00',end:'23:59',days:[other]}]}});
 assert.equal((await f.rpc('erp_access_me',{p_user_id:f.users.financeiro})).access_window,'closed');
 assert.deepEqual((await f.rpc('erp_access_gate',{p_user_id:f.users.financeiro})).open,false);
 await fails(assert,()=>f.scalar('select erp_access.require_schedule($1) v',[f.users.financeiro]),'42501');
 await save(f.users.fiscal,{schedule:{enabled:true,windows:[ALWAYS]}});
 const me=await f.rpc('erp_access_me',{p_user_id:f.users.fiscal});assert.equal(me.access_window,'open');assert.deepEqual(Object.keys(me).sort(),['access_window','data_mode','resources','role','user_id']);
 const mine=parseMyPermissions(await f.rpc('erp_access_permissions_me',{p_user_id:f.users.fiscal}));assert.equal(mine.access.open,true);assert.match(mine.access.until,/T23:59:59/);
 await fails(assert,()=>f.rpc('erp_access_gate',{p_user_id:f.users.inactive}),'42501');
}finally{await f.close();}});

test('229 PRF-222 permissions: a saved set narrows the profile; Meu Negócio dashboards follow it on the server; the list filters Tipo de usuário',async()=>{const f=await laneDFixture();try{
 const{save}=controls(f),permitted=(user,key)=>f.scalar('select erp_access.permitted($1,$2) v',[user,key]);
 assert.equal(await permitted(f.users.vendas,'meu_negocio.dashboard.mensal'),true,'no saved set: everything of the profile');
 assert.equal(await permitted(f.users.vendas,'x.y'),false);
 await save(f.users.vendas,{permissions:['meu_negocio.dashboard','meu_negocio.dashboard.mensal','vendas.pedidos_venda']});
 assert.equal(await permitted(f.users.vendas,'meu_negocio.dashboard.mensal'),true);assert.equal(await permitted(f.users.vendas,'meu_negocio.dashboard.diario'),false);
 assert.equal(await permitted(f.users.admin,'meu_negocio.dashboard.diario'),true,'the administrador always');
 const panel=(user,name,args)=>f.rpc('erp_home_business_panel',{p_user_id:user,p_panel:name,p_args:args});
 assert.equal((await panel(f.users.vendas,'mensal',{p_statuses:['verified'],p_from:'2026-10-01',p_to:'2026-10-20',p_compare_from:null,p_compare_to:null})).panel,'mensal');
 await fails(assert,()=>panel(f.users.vendas,'diario',{p_statuses:['verified'],p_day:'2026-10-20',p_compare_day:null}),'42501');
 await fails(assert,()=>panel(f.users.vendas,'metas',{p_tab:'andamento'}),'42501');
 assert.equal((await panel(f.users.admin,'metas',{p_tab:'andamento'})).scope,'business_goals');
 for(const[name,args]of[['mensal',{}],['mensal',{p_statuses:['verified'],p_from:'2026-10-01',p_to:'2026-10-20',p_compare_from:null,p_compare_to:null,x:1}],['nada',{}],['venda-canal',null]])
  await fails(assert,()=>panel(f.users.admin,name,args),'22023');
 // Without the module key, no dashboard opens even with its own key.
 await save(f.users.consulta,{permissions:['vendas.pedidos_venda']});await fails(assert,()=>panel(f.users.consulta,'venda-canal',{}),'42501');
 const mine=parseMyPermissions(await f.rpc('erp_access_permissions_me',{p_user_id:f.users.vendas}));assert.deepEqual(mine.permissions,['vendas.pedidos_venda','meu_negocio.dashboard','meu_negocio.dashboard.mensal']);
 assert.equal(parseMyPermissions(await f.rpc('erp_access_permissions_me',{p_user_id:f.users.admin})).permissions,null);
 // Sistema › Usuários: Tipo de usuário (Todos | Normal | Contador).
 await save(f.users.estoque,{user_type:'contador'});
 const list=async type=>parseUsersList(await f.rpc('erp_access_users_list_v2',{p_user_id:f.users.admin,p_query:null,p_status:'todos',p_type:type,p_limit:100,p_offset:0}),captureUsersQuery({type}));
 assert.deepEqual((await list('contador')).items.map(u=>u.email),['estoque@sintetico.test']);assert.equal((await list('normal')).items.some(u=>u.email==='estoque@sintetico.test'),false);
 assert.equal((await list('todos')).total,8);
 await fails(assert,()=>f.rpc('erp_access_users_list_v2',{p_user_id:f.users.admin,p_query:null,p_status:'todos',p_type:'api',p_limit:100,p_offset:0}),'22023');
}finally{await f.close();}});

test('229 a user made administrador after saving windows and permissions still opens: the controls show no restriction and a save clears them',async()=>{const f=await laneDFixture();try{
 const{get,save}=controls(f);
 await save(f.users.vendas,{schedule:{enabled:true,windows:[{start:'08:00',end:'09:00',days:[1]}]},permissions:['meu_negocio.dashboard']});
 await f.db.query("update erp_access.membership set role='admin' where user_id=$1",[f.users.vendas]);
 const promoted=parseControls(await get(f.users.vendas),f.users.vendas);
 assert.deepEqual([promoted.role,promoted.schedule.enabled,promoted.permissions,promoted.version],['admin',false,null,1]);
 assert.equal(await f.scalar("select erp_access.schedule_allows($1,'2026-10-18 03:00:00-03'::timestamptz) v",[f.users.vendas]),true);
 const cleared=await save(f.users.vendas,{user_type:'contador',schedule:{enabled:false,windows:promoted.schedule.windows}});
 assert.deepEqual([cleared.controls.version,cleared.controls.user_type,cleared.controls.gate_required],[2,'contador',false]);
 // Back to another profile, nothing saved before the promotion comes back.
 await f.db.query("update erp_access.membership set role='vendas' where user_id=$1",[f.users.vendas]);
 const back=parseControls(await get(f.users.vendas),f.users.vendas);assert.deepEqual([back.schedule.enabled,back.permissions],[false,null]);
 assert.equal(await f.scalar("select erp_access.permitted($1,'meu_negocio.dashboard.diario') v",[f.users.vendas]),true);
}finally{await f.close();}});
