-- Canonical cloud identity and operational units; does not change existing ERP grants.
begin;
create schema fagoo;
revoke all on schema fagoo from public,anon,authenticated,service_role;
alter default privileges in schema fagoo revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema fagoo revoke all on functions from public,anon,authenticated,service_role;

alter table erp_access.membership drop constraint membership_role_check;
alter table erp_access.membership add constraint membership_role_check check(role in('admin','consulta','vendas','financeiro','estoque','fiscal','operacao'));
alter table erp_access.user_command drop constraint user_command_role_check;
alter table erp_access.user_command add constraint user_command_role_check check(role is null or role in('admin','consulta','vendas','financeiro','estoque','fiscal','operacao'));

create function fagoo.capabilities() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['units.manage','queue.read','queue.operate','queue.configure','panel.read','ticket.issue','print.execute','audio.execute','crm.read','crm.write','communication.read','communication.claim','communication.reply','communication.transfer','communication.configure','team.chat']::text[];
$$;
create table fagoo.unit(
 id uuid primary key default gen_random_uuid(), name text not null check(length(btrim(name)) between 1 and 120),
 timezone text not null default 'America/Sao_Paulo',active boolean not null default true,
 settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=65536),
 version integer not null default 1 check(version>0), created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table fagoo.unit_member(
 unit_id uuid not null references fagoo.unit(id),user_id uuid not null references auth.users(id),
 capabilities text[] not null default '{}' check(capabilities <@ fagoo.capabilities()),
 team_ids text[] not null default '{}' check(cardinality(team_ids)<=100),
 primary key(unit_id,user_id)
);
create table fagoo.device(
 id uuid primary key default gen_random_uuid(),unit_id uuid not null references fagoo.unit(id),
 name text not null check(length(btrim(name)) between 1 and 120),active boolean not null default true,
 capabilities text[] not null default '{}' check(capabilities <@ array['panel.read','ticket.issue','print.execute','audio.execute']),
 token_hash text unique check(token_hash ~ '^[a-f0-9]{64}$'),
 settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=65536),
 version integer not null default 1 check(version>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index fagoo_device_unit on fagoo.device(unit_id);
create table fagoo.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),action text not null,
 request_hash text not null,result jsonb not null,created_at timestamptz not null default now()
);
create table fagoo.audit(
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),command_id uuid not null references fagoo.command(command_id),
 action text not null,unit_id uuid references fagoo.unit(id),details jsonb not null,created_at timestamptz not null default now()
);
alter table fagoo.unit enable row level security;
alter table fagoo.unit_member enable row level security;
alter table fagoo.device enable row level security;
alter table fagoo.command enable row level security;
alter table fagoo.audit enable row level security;
revoke all on all tables in schema fagoo from public,anon,authenticated,service_role;
revoke all on all sequences in schema fagoo from public,anon,authenticated,service_role;

create function fagoo.require_unit(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_capability text)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_unit_id is null or p_capability is null or not p_capability=any(fagoo.capabilities())
 or (p_user_id is null)=(p_device_id is null)
 or not exists(select 1 from fagoo.unit where id=p_unit_id and active) then
  raise exception 'fagoo_access_denied' using errcode='42501'; end if;
 if p_user_id is not null then
  if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and
   (m.role='admin' or exists(select 1 from fagoo.unit_member u where u.unit_id=p_unit_id and u.user_id=m.user_id and p_capability=any(u.capabilities)))) then
   raise exception 'fagoo_access_denied' using errcode='42501'; end if;
 else
  if not exists(select 1 from fagoo.device d where d.id=p_device_id and d.unit_id=p_unit_id and d.active and d.token_hash is not null and p_capability=any(d.capabilities)) then
   raise exception 'fagoo_access_denied' using errcode='42501'; end if;
 end if;
end $$;

create function public.fagoo_context(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_units jsonb;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'fagoo_access_denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'timezone',u.timezone,'version',u.version,
 'capabilities',case when v_role='admin' then fagoo.capabilities() else m.capabilities end,
 'team_ids',coalesce(m.team_ids,'{}')) order by u.name,u.id),'[]') into v_units
 from fagoo.unit u left join fagoo.unit_member m on m.unit_id=u.id and m.user_id=p_user_id
 where u.active and(v_role='admin' or m.user_id is not null);
 return jsonb_build_object('user_id',p_user_id,'role',v_role,'units',v_units,'online_required',true);
end $$;
create function public.fagoo_device_auth(p_token_hash text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
 if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'fagoo_device_denied' using errcode='42501';end if;
 select jsonb_build_object('id',d.id,'unit_id',d.unit_id,'name',d.name,'capabilities',d.capabilities,'settings',d.settings,'version',d.version,'mode','panel') into v
 from fagoo.device d join fagoo.unit u on u.id=d.unit_id where d.token_hash=p_token_hash and d.active and u.active;
 if v is null then raise exception 'fagoo_device_denied' using errcode='42501';end if;
 return v;
end $$;
create function public.fagoo_setup(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_access.read_admin(p_user_id);
 return jsonb_build_object('units',(select coalesce(jsonb_agg(to_jsonb(u) order by name,id),'[]') from fagoo.unit u),
 'devices',(select coalesce(jsonb_agg(to_jsonb(d)-'token_hash' order by name,id),'[]') from fagoo.device d),
 'members',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',coalesce(p.name,u.email),'role',m.role,'active',m.active,
 'units',(select coalesce(jsonb_agg(to_jsonb(g)-'user_id'),'[]') from fagoo.unit_member g where g.user_id=m.user_id)) order by m.created_at,m.user_id),'[]')
 from erp_access.membership m join auth.users u on u.id=m.user_id left join erp_access.profile p on p.user_id=m.user_id),
 'capabilities',fagoo.capabilities());
end $$;
create function public.fagoo_command_receipt(p_user_id uuid,p_command_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
 perform erp_access.read_admin(p_user_id);
 select result into v from fagoo.command where command_id=p_command_id and actor=p_user_id;
 if v is null then raise exception 'fagoo_command_not_found' using errcode='P0002';end if;
 return v||jsonb_build_object('replayed',true);
end $$;

create function public.fagoo_command(p_user_id uuid,p_command_id uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;c fagoo.command%rowtype;v_id uuid;v_unit uuid;v_result jsonb;v_caps text[];v_teams text[];v_expected integer;v_old integer;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_action is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>70000 then
  raise exception 'fagoo_invalid_command' using errcode='22023';end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'payload',case when p_action='device.issue' then p_payload-'token_hash' else p_payload end)::text,'UTF8')),'hex');
 -- Configuration commands serialize briefly; operational commands lock their own unit.
 perform pg_advisory_xact_lock(1900910001);
 select * into c from fagoo.command where command_id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'fagoo_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if p_action='unit.save' then
  v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());v_unit:=v_id;
  if nullif(btrim(p_payload->>'name'),'') is null or not exists(select 1 from pg_timezone_names where name=coalesce(p_payload->>'timezone','America/Sao_Paulo')) then
   raise exception 'fagoo_invalid_unit' using errcode='22023';end if;
  select version into v_old from fagoo.unit where id=v_id for update;
  v_expected:=(p_payload->>'expected_version')::integer;
  if v_old is not null and v_expected is distinct from v_old then raise exception 'fagoo_version_conflict' using errcode='40001';end if;
  insert into fagoo.unit(id,name,timezone,active,settings) values(v_id,btrim(p_payload->>'name'),coalesce(p_payload->>'timezone','America/Sao_Paulo'),coalesce((p_payload->>'active')::boolean,true),coalesce(p_payload->'settings','{}'))
  on conflict(id) do update set name=excluded.name,timezone=excluded.timezone,active=excluded.active,settings=excluded.settings,version=fagoo.unit.version+1,updated_at=now();
  select to_jsonb(u) into v_result from fagoo.unit u where id=v_id;
 elsif p_action='member.save' then
  v_id:=(p_payload->>'user_id')::uuid;v_unit:=(p_payload->>'unit_id')::uuid;
  if not exists(select 1 from erp_access.membership where user_id=v_id and active) then raise exception 'fagoo_invalid_member' using errcode='22023';end if;
  v_caps:=array(select jsonb_array_elements_text(coalesce(p_payload->'capabilities','[]')));
  v_teams:=array(select jsonb_array_elements_text(coalesce(p_payload->'team_ids','[]')));
  if not(v_caps <@ fagoo.capabilities()) then raise exception 'fagoo_invalid_capabilities' using errcode='22023';end if;
  insert into fagoo.unit_member(unit_id,user_id,capabilities,team_ids) values(v_unit,v_id,v_caps,v_teams)
  on conflict(unit_id,user_id) do update set capabilities=excluded.capabilities,team_ids=excluded.team_ids;
  select to_jsonb(m) into v_result from fagoo.unit_member m where unit_id=v_unit and user_id=v_id;
 elsif p_action='device.save' then
  v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());v_unit:=(p_payload->>'unit_id')::uuid;
  if nullif(btrim(p_payload->>'name'),'') is null then raise exception 'fagoo_invalid_device' using errcode='22023';end if;
  v_caps:=array(select jsonb_array_elements_text(coalesce(p_payload->'capabilities','[]')));
  if not(v_caps <@ array['panel.read','ticket.issue','print.execute','audio.execute']) then raise exception 'fagoo_invalid_device_capabilities' using errcode='22023';end if;
  select version into v_old from fagoo.device where id=v_id for update;
  if v_old is not null and (p_payload->>'expected_version')::integer is distinct from v_old then raise exception 'fagoo_version_conflict' using errcode='40001';end if;
  insert into fagoo.device(id,unit_id,name,capabilities,settings,active) values(v_id,v_unit,btrim(p_payload->>'name'),v_caps,coalesce(p_payload->'settings','{}'),coalesce((p_payload->>'active')::boolean,true))
  on conflict(id) do update set unit_id=excluded.unit_id,name=excluded.name,capabilities=excluded.capabilities,settings=excluded.settings,active=excluded.active,
  token_hash=case when fagoo.device.unit_id<>excluded.unit_id or not excluded.active then null else fagoo.device.token_hash end,version=fagoo.device.version+1,updated_at=now();
  select to_jsonb(d)-'token_hash' into v_result from fagoo.device d where id=v_id;
 elsif p_action='device.issue' then
  v_id:=(p_payload->>'id')::uuid;
  if p_payload->>'token_hash' is null or (p_payload->>'token_hash') !~ '^[a-f0-9]{64}$' then raise exception 'fagoo_invalid_device_token' using errcode='22023';end if;
  update fagoo.device set token_hash=p_payload->>'token_hash',version=version+1,updated_at=now() where id=v_id and active returning unit_id into v_unit;
  if not found then raise exception 'fagoo_device_not_found' using errcode='P0002';end if;
  v_result:=jsonb_build_object('id',v_id,'unit_id',v_unit,'issued',true);
 else raise exception 'fagoo_unknown_command' using errcode='22023';end if;
 v_result:=v_result||jsonb_build_object('command_id',p_command_id,'replayed',false);
 insert into fagoo.command(command_id,actor,action,request_hash,result) values(p_command_id,p_user_id,p_action,v_hash,v_result);
 insert into fagoo.audit(actor,command_id,action,unit_id,details) values(p_user_id,p_command_id,p_action,v_unit,jsonb_build_object('record_id',v_id));
 return v_result;
end $$;

create function public.fagoo_device_exit(p_user_id uuid,p_device_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_unit uuid;
begin
 select unit_id into v_unit from fagoo.device where id=p_device_id and active;
 perform fagoo.require_unit(p_user_id,null,v_unit,'units.manage');
 -- Revocation prevents the previous panel session from surviving the authorized exit.
 update fagoo.device set token_hash=null,version=version+1,updated_at=now() where id=p_device_id;
 return jsonb_build_object('allowed',true,'device_id',p_device_id);
end $$;

revoke all on all functions in schema fagoo from public,anon,authenticated,service_role;
do $$ declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('fagoo_context','fagoo_device_auth','fagoo_setup','fagoo_command','fagoo_command_receipt','fagoo_device_exit') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
create or replace function public.erp_access_user_save(p_user_id uuid,p_command_id uuid,p_target uuid,p_expected jsonb,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; c erp_access.user_command; m erp_access.membership; p erp_access.profile; v_before jsonb; v_after jsonb; v_at timestamptz; v_result jsonb;
 v_name text; v_phone text; v_role text; v_active boolean;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_target is null or p_expected is null or jsonb_typeof(p_expected)<>'object' or p_data is null or jsonb_typeof(p_data)<>'object'
  or(select array_agg(k order by k) from jsonb_object_keys(p_expected) k)<>array['active','profile_version','role']
  or(select array_agg(k order by k) from jsonb_object_keys(p_data) k)<>array['active','name','phone','role']
  or jsonb_typeof(p_expected->'active')<>'boolean' or jsonb_typeof(p_expected->'profile_version')<>'number' or(p_expected->>'profile_version')!~'^(0|[1-9][0-9]{0,9})$'
  or jsonb_typeof(p_expected->'role') not in('null','string') or jsonb_typeof(p_data->'name')<>'string' or jsonb_typeof(p_data->'phone') not in('null','string')
  or jsonb_typeof(p_data->'role')<>'string' or jsonb_typeof(p_data->'active')<>'boolean' then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_name:=p_data->>'name';v_phone:=p_data->>'phone';v_role:=p_data->>'role';v_active:=(p_data->>'active')::boolean;
 if length(v_name) not between 1 and 120 or v_name<>btrim(v_name) or v_name~'[\x01-\x1f\x7f]' or v_phone is not null and(v_phone!~'^[0-9+() -]{8,20}$' or v_phone<>btrim(v_phone))
  or v_role not in('admin','consulta','vendas','financeiro','estoque','fiscal','operacao') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-access-user-save-v1','actor',p_user_id,'target',p_target,'expected',p_expected,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_access_user_command'),hashtext(p_command_id::text));
 select * into c from erp_access.user_command where id=p_command_id;
 if c.id is not null then
  perform erp_access.require_admin(p_user_id,true);
  if c.actor<>p_user_id or c.kind<>'save' or c.request_hash<>v_hash then raise exception 'erp_access_users_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('user',erp_access.user_dto(c.target),'replayed',true);
 end if;
 -- Every change to who is administrador is serialized, so the "at least one active administrador" rule cannot race.
 perform pg_advisory_xact_lock(hashtext('erp_access_users'),0);
 perform erp_access.require_admin(p_user_id,true);
 perform 1 from auth.users where id=p_target for key share;
 if not found then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 select * into m from erp_access.membership where user_id=p_target for update;
 select * into p from erp_access.profile where user_id=p_target for update;
 if m.role is distinct from(p_expected->>'role') or coalesce(m.active,false)<>(p_expected->>'active')::boolean or coalesce(p.version,0)<>(p_expected->>'profile_version')::integer then
  raise exception 'erp_access_users_version_conflict' using errcode='40001'; end if;
 if p_target=p_user_id and(v_role<>'admin' or not v_active) then raise exception 'erp_access_users_self_change' using errcode='42501'; end if;
 v_before:=jsonb_build_object('name',p.name,'phone',p.phone,'role',m.role,'active',coalesce(m.active,false));
 v_after:=jsonb_build_object('name',v_name,'phone',v_phone,'role',case when m.user_id is null and not v_active then null else v_role end,'active',v_active);
 if v_before=v_after then raise exception 'erp_access_users_unchanged' using errcode='22023'; end if;
 v_at:=clock_timestamp();
 v_result:=jsonb_build_object('scope','access_user_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'kind','save','target',p_target,
  'changed_at',v_at,'before',v_before,'after',v_after));
 insert into erp_access.user_command(id,actor,kind,target,request_hash,state,result,completed_at) values(p_command_id,p_user_id,'save',p_target,v_hash,'done',v_result,v_at);
 if p.user_id is null then insert into erp_access.profile(user_id,name,phone,version,updated_at,updated_by) values(p_target,v_name,v_phone,1,v_at,p_user_id);
 elsif p.name<>v_name or p.phone is distinct from v_phone then update erp_access.profile set name=v_name,phone=v_phone,version=version+1,updated_at=v_at,updated_by=p_user_id where user_id=p_target;
 end if;
 if m.user_id is null then
  if v_active then insert into erp_access.membership(user_id,role,active) values(p_target,v_role,true); end if;
 elsif m.role<>v_role or m.active<>v_active then update erp_access.membership set role=v_role,active=v_active,updated_at=v_at where user_id=p_target;
 end if;
 if not exists(select 1 from erp_access.membership where active and role='admin') then raise exception 'erp_access_users_last_admin' using errcode='22023'; end if;
 insert into erp_access.user_audit(command_id,actor,target,before_data,after_data) values(p_command_id,p_user_id,p_target,v_before,v_after);
 perform erp_access.require_admin(p_user_id,true);
 return v_result||jsonb_build_object('user',erp_access.user_dto(p_target),'replayed',false);
end $$;

-- Invite, step 1 of 2: records the intent before the Worker asks Supabase Auth to send the invitation. A repeated call with the
-- same command returns the pending intent and the account if Auth already created it (a lost answer), so nothing is sent twice.
create or replace function public.erp_access_user_invite_begin(p_user_id uuid,p_command_id uuid,p_email text,p_name text,p_role text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; c erp_access.user_command; v_existing uuid;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_email is null or length(p_email)>254 or p_email<>lower(btrim(p_email)) or p_email!~'^[^@ ]+@[^@ ]+\.[^@ ]+$' or p_email~'[\x01-\x1f\x7f]'
  or p_name is null or length(p_name) not between 1 and 120 or p_name<>btrim(p_name) or p_name~'[\x01-\x1f\x7f]'
  or p_role is null or p_role not in('admin','consulta','vendas','financeiro','estoque','fiscal','operacao') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-access-user-invite-v1','actor',p_user_id,'email',p_email,'name',p_name,'role',p_role)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_access_user_command'),hashtext(p_command_id::text));
 perform erp_access.require_admin(p_user_id,true);
 select * into c from erp_access.user_command where id=p_command_id;
 select id into v_existing from auth.users where lower(email)=p_email order by created_at limit 1;
 if c.id is not null then
  if c.actor<>p_user_id or c.kind<>'invite' or c.request_hash<>v_hash then raise exception 'erp_access_users_command_conflict' using errcode='40001'; end if;
  if c.state='done' then return c.result||jsonb_build_object('user',erp_access.user_dto(c.target),'replayed',true); end if;
  return jsonb_build_object('scope','access_invite','data_mode','erp_native','state','pending','command_id',c.id,'email',c.email,'existing_user_id',v_existing);
 end if;
 if v_existing is not null then raise exception 'erp_access_users_email_exists' using errcode='23505'; end if;
 -- Two commands for one e-mail never call Auth at the same time. A pending invite older than the Worker deadline (25 s)
 -- is no longer in flight, so after 5 minutes a new command may invite again (the old one, if resumed, finds the account).
 perform pg_advisory_xact_lock(hashtext('erp_access_user_invite_email'),hashtext(p_email));
 if exists(select 1 from erp_access.user_command where kind='invite' and state='pending' and email=p_email and created_at>clock_timestamp()-interval '5 minutes') then
  raise exception 'erp_access_users_invite_in_progress' using errcode='23505'; end if;
 insert into erp_access.user_command(id,actor,kind,email,role,name,request_hash,state) values(p_command_id,p_user_id,'invite',p_email,p_role,p_name,v_hash,'pending');
 return jsonb_build_object('scope','access_invite','data_mode','erp_native','state','pending','command_id',p_command_id,'email',p_email,'existing_user_id',null);
end $$;

-- Invite, step 2 of 2: binds the Auth account created by the invitation (same e-mail, invited) to the company with the chosen
-- perfil. The membership is granted by verified UUID, never by metadata or first sign-up.

commit;
