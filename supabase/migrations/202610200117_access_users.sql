-- Sistema > Usuários no padrão do Origin, sobre o modelo de acesso existente (004): a conta é do Supabase Auth; o acesso à
-- empresa é a membership (perfil e situação). O administrador lista as contas, convida (o Worker chama o convite do Auth e
-- esta migração registra o comando antes e conclui depois), libera, altera o perfil, desativa e reativa. Nada é apagado: a
-- exclusão do Origin vira desativação da membership e a conta do Auth fica para a auditoria. Ninguém altera o próprio perfil
-- de administrador nem deixa a empresa sem administrador ativo. Nome e celular ficam em erp_access.profile.
-- As colunas de auth.users são lidas só dentro de funções plpgsql (validadas na execução, não na criação).
begin;

create table erp_access.profile(
 user_id uuid primary key references auth.users(id),
 name text not null check(length(name) between 1 and 120 and name=btrim(name) and name!~'[\x01-\x1f\x7f]'),
 phone text check(phone is null or phone~'^[0-9+() -]{8,20}$' and phone=btrim(phone)),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id)
);
-- One row per command. An invite starts "pending" (recorded before the Auth call) and becomes "done" once, with its receipt.
create table erp_access.user_command(
 id uuid primary key,
 actor uuid not null references auth.users(id),
 kind text not null check(kind in('save','invite')),
 target uuid references auth.users(id),
 email text check(email is null or(length(email)<=254 and email=lower(email))),
 role text check(role is null or role in('admin','consulta','vendas','financeiro','estoque','fiscal')),
 name text check(name is null or length(name) between 1 and 120),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 state text not null check(state in('pending','done')),
 result jsonb check(result is null or jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,
 check((state='done')=(result is not null and completed_at is not null and target is not null)),
 check(kind='invite' or state='done'),
 check(kind<>'invite' or(email is not null and role is not null and name is not null))
);
-- Not unique: an invite Auth refused (no SMTP, rate limit) stays pending forever and must not block the e-mail for good.
-- A recent pending invite of the same e-mail still refuses a second command (see erp_access_user_invite_begin).
create index erp_access_user_command_pending_email on erp_access.user_command(email,created_at) where kind='invite' and state='pending';
create table erp_access.user_audit(
 id bigint generated always as identity primary key,
 command_id uuid not null unique references erp_access.user_command(id),
 actor uuid not null references auth.users(id),
 target uuid not null references auth.users(id),
 before_data jsonb not null,after_data jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['profile','user_command','user_audit'] loop
 execute format('alter table erp_access.%I enable row level security',t);
 execute format('revoke all on erp_access.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_access from public,anon,authenticated,service_role;

create function erp_access.users_history_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_access_history_immutable' using errcode='42501'; end $$;
create trigger immutable_user_audit before update or delete on erp_access.user_audit for each row execute function erp_access.users_history_immutable();
-- A command changes once: a pending invite becomes done with its target and receipt; nothing else is ever rewritten.
create function erp_access.guard_user_command() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or old.state<>'pending' or new.state<>'done' or new.id<>old.id or new.actor<>old.actor or new.kind<>old.kind or new.email<>old.email
  or new.role<>old.role or new.name<>old.name or new.request_hash<>old.request_hash or new.created_at<>old.created_at then
  raise exception 'erp_access_history_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_user_command before update or delete on erp_access.user_command for each row execute function erp_access.guard_user_command();

create function erp_access.require_admin(p_actor uuid,p_lock boolean) returns void language plpgsql set search_path=pg_catalog as $$
begin
 if p_lock then perform 1 from auth.users where id=p_actor for key share; perform 1 from erp_access.membership where user_id=p_actor for share; end if;
 if p_actor is null or not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin') then
  raise exception 'erp_access_users_access_denied' using errcode='42501'; end if;
end $$;
create function erp_access.read_admin(p_actor uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_actor is null or not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin') then
  raise exception 'erp_access_users_access_denied' using errcode='42501'; end if;
end $$;
-- "ativo": active membership; "inativo": membership turned off; "sem_acesso": Auth account (invited or not) without membership.
create function erp_access.user_dto(p_target uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare u record; m erp_access.membership; p erp_access.profile;
begin
 select id,email,created_at,invited_at,email_confirmed_at,last_sign_in_at into u from auth.users where id=p_target;
 if u.id is null then return null; end if;
 select * into m from erp_access.membership where user_id=p_target;
 select * into p from erp_access.profile where user_id=p_target;
 return jsonb_build_object('user_id',u.id,'email',lower(u.email),'name',p.name,'phone',p.phone,'profile_version',coalesce(p.version,0),
  'role',m.role,'active',coalesce(m.active,false),'status',case when m.user_id is null then 'sem_acesso' when m.active then 'ativo' else 'inativo' end,
  'invited',u.invited_at is not null,'confirmed',u.email_confirmed_at is not null,'last_sign_in_at',u.last_sign_in_at,'created_at',u.created_at);
end $$;

create function public.erp_access_users_list(p_user_id uuid,p_query text,p_status text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_total integer; v_counts jsonb; v_q text;
begin
 perform erp_access.read_admin(p_user_id);
 if p_status is null or p_status not in('todos','ativo','inativo','sem_acesso') or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with accounts as materialized(
  select erp_access.user_dto(u.id) d from auth.users u
 ), filtered as materialized(
  select d from accounts where d is not null and(p_status='todos' or d->>'status'=p_status)
   and(v_q is null or strpos(lower(coalesce(d->>'name','')),v_q)>0 or strpos(d->>'email',v_q)>0)
 )
 select(select count(*) from filtered),
  (select coalesce(jsonb_agg(d order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id'),'[]'::jsonb) from(select d from filtered order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id' limit p_limit offset p_offset) x),
  (select jsonb_build_object('ativo',count(*) filter(where d->>'status'='ativo'),'inativo',count(*) filter(where d->>'status'='inativo'),'sem_acesso',count(*) filter(where d->>'status'='sem_acesso')) from accounts where d is not null)
  into v_total,v_items,v_counts;
 return jsonb_build_object('scope','access_users','data_mode','erp_native','status',p_status,'query',v_q,'limit',p_limit,'offset',p_offset,'total',v_total,
  'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items,'counts',v_counts,'actor',p_user_id);
end $$;

create function public.erp_access_user_get(p_user_id uuid,p_target uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
 perform erp_access.read_admin(p_user_id);
 v:=erp_access.user_dto(p_target);
 if v is null then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('scope','access_user','data_mode','erp_native','user',v,'actor',p_user_id);
end $$;

-- Saves the whole desired state of one account (name, celular, perfil, situação) after comparing with what the screen read.
create function public.erp_access_user_save(p_user_id uuid,p_command_id uuid,p_target uuid,p_expected jsonb,p_data jsonb) returns jsonb
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
  or v_role not in('admin','consulta','vendas','financeiro','estoque','fiscal') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
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
create function public.erp_access_user_invite_begin(p_user_id uuid,p_command_id uuid,p_email text,p_name text,p_role text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; c erp_access.user_command; v_existing uuid;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_email is null or length(p_email)>254 or p_email<>lower(btrim(p_email)) or p_email!~'^[^@ ]+@[^@ ]+\.[^@ ]+$' or p_email~'[\x01-\x1f\x7f]'
  or p_name is null or length(p_name) not between 1 and 120 or p_name<>btrim(p_name) or p_name~'[\x01-\x1f\x7f]'
  or p_role is null or p_role not in('admin','consulta','vendas','financeiro','estoque','fiscal') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
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
create function public.erp_access_user_invite_complete(p_user_id uuid,p_command_id uuid,p_target uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_access.user_command; u record; v_at timestamptz; v_after jsonb; v_result jsonb;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_target is null then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('erp_access_user_command'),hashtext(p_command_id::text));
 perform pg_advisory_xact_lock(hashtext('erp_access_users'),0);
 perform erp_access.require_admin(p_user_id,true);
 select * into c from erp_access.user_command where id=p_command_id for update;
 if c.id is null or c.kind<>'invite' then raise exception 'erp_access_users_command_not_found' using errcode='P0002'; end if;
 if c.actor<>p_user_id then raise exception 'erp_access_users_access_denied' using errcode='42501'; end if;
 if c.state='done' then
  if c.target<>p_target then raise exception 'erp_access_users_command_conflict' using errcode='40001'; end if;
  return c.result||jsonb_build_object('user',erp_access.user_dto(c.target),'replayed',true);
 end if;
 select id,email,invited_at into u from auth.users where id=p_target for key share;
 if u.id is null or lower(u.email)<>c.email or u.invited_at is null then raise exception 'erp_access_users_invite_target_invalid' using errcode='40001'; end if;
 if exists(select 1 from erp_access.membership where user_id=p_target) or exists(select 1 from erp_access.profile where user_id=p_target) then
  raise exception 'erp_access_users_invite_target_invalid' using errcode='40001'; end if;
 v_at:=clock_timestamp();
 insert into erp_access.profile(user_id,name,phone,version,updated_at,updated_by) values(p_target,c.name,null,1,v_at,p_user_id);
 insert into erp_access.membership(user_id,role,active) values(p_target,c.role,true);
 v_after:=jsonb_build_object('name',c.name,'phone',null,'role',c.role,'active',true);
 v_result:=jsonb_build_object('scope','access_user_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'kind','invite','target',p_target,
  'changed_at',v_at,'before',jsonb_build_object('name',null,'phone',null,'role',null,'active',false),'after',v_after));
 update erp_access.user_command set state='done',target=p_target,result=v_result,completed_at=v_at where id=p_command_id;
 insert into erp_access.user_audit(command_id,actor,target,before_data,after_data) values(p_command_id,p_user_id,p_target,v_result#>'{receipt,before}',v_after);
 return v_result||jsonb_build_object('user',erp_access.user_dto(p_target),'replayed',false);
end $$;

-- "Conferir resultado" of either command: the receipt when done, or the pending invite and the account Auth may have created.
create function public.erp_access_user_command(p_user_id uuid,p_command_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_access.user_command; v_existing uuid;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 select * into c from erp_access.user_command where id=p_command_id;
 if c.id is null then raise exception 'erp_access_users_command_not_found' using errcode='P0002'; end if;
 if c.actor<>p_user_id then raise exception 'erp_access_users_access_denied' using errcode='42501'; end if;
 if c.state='done' then return c.result||jsonb_build_object('user',erp_access.user_dto(c.target),'replayed',true); end if;
 select id into v_existing from auth.users where lower(email)=c.email order by created_at limit 1;
 return jsonb_build_object('scope','access_invite','data_mode','erp_native','state','pending','command_id',c.id,'email',c.email,'existing_user_id',v_existing);
end $$;

-- Preferências "users" fields now show the person's name (or e-mail) instead of a bare identifier.
create or replace function erp_preferences.directory() returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'role',m.role,'label',left(coalesce(p.name,lower(u.email)),200)) order by m.created_at,m.user_id),'[]'::jsonb) into v
 from(select user_id,role,created_at from erp_access.membership where active order by created_at,user_id limit 500) m
 left join erp_access.profile p on p.user_id=m.user_id left join auth.users u on u.id=m.user_id;
 return v;
end $$;
revoke all on function erp_preferences.directory() from public,anon,authenticated,service_role;

revoke all on function erp_access.users_history_immutable(),erp_access.guard_user_command(),erp_access.require_admin(uuid,boolean),erp_access.read_admin(uuid),erp_access.user_dto(uuid) from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_access_users_list','erp_access_user_get','erp_access_user_save','erp_access_user_invite_begin','erp_access_user_invite_complete','erp_access_user_command')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
