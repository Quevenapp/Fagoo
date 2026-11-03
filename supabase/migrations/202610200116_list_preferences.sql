-- Listagens do Origin por usuário: colunas da "listagem customizada" (ordem e visibilidade) e filtros padrão ("Tornar padrão").
-- Cada usuário ativo grava só as próprias listas; o valor é versionado (CAS), muda por comando idempotente (command_id) e
-- cada mudança fica auditada. A lista é identificada por um nome estável escolhido pela tela (ex.: documentos.sales_orders);
-- o servidor confere formato e limites, não o significado das colunas, que continuam conferidas pela própria tela.
-- Não altera nenhuma listagem existente: as telas passam a usar estes valores quando adotarem o hook useListPreferences.
begin;

create schema erp_list_preferences;
revoke all on schema erp_list_preferences from public,anon,authenticated,service_role;

create table erp_list_preferences.command(
 id uuid primary key,
 actor uuid not null references auth.users(id),
 list_id text not null,
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp()
);
create table erp_list_preferences.preference(
 user_id uuid not null references auth.users(id),
 list_id text not null check(length(list_id)<=60 and list_id~'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
 columns text[] check(columns is null or cardinality(columns) between 1 and 60),
 filters jsonb check(filters is null or jsonb_typeof(filters)='object'),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 command_id uuid not null references erp_list_preferences.command(id),
 primary key(user_id,list_id)
);
create table erp_list_preferences.audit(
 id bigint generated always as identity primary key,
 command_id uuid not null unique references erp_list_preferences.command(id),
 actor uuid not null references auth.users(id),
 list_id text not null,
 from_version integer not null check(from_version between 0 and 2147483646),
 to_version integer not null check(to_version=from_version+1),
 before_data jsonb not null,after_data jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['command','preference','audit'] loop
 execute format('alter table erp_list_preferences.%I enable row level security',t);
 execute format('revoke all on erp_list_preferences.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_list_preferences from public,anon,authenticated,service_role;
alter default privileges in schema erp_list_preferences revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_list_preferences revoke all on functions from public,anon,authenticated,service_role;

create function erp_list_preferences.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_list_preferences_history_immutable' using errcode='42501'; end $$;
create trigger immutable_command before update or delete on erp_list_preferences.command for each row execute function erp_list_preferences.immutable_history();
create trigger immutable_audit before update or delete on erp_list_preferences.audit for each row execute function erp_list_preferences.immutable_history();
create function erp_list_preferences.guard_preference() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or tg_op='UPDATE' and(new.user_id<>old.user_id or new.list_id<>old.list_id or new.version<>old.version+1 or new.command_id=old.command_id)
  or tg_op='INSERT' and new.version<>1
  or not exists(select 1 from erp_list_preferences.command c where c.id=new.command_id and c.actor=new.user_id and c.list_id=new.list_id) then
  raise exception 'erp_list_preferences_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_preference before insert or update or delete on erp_list_preferences.preference for each row execute function erp_list_preferences.guard_preference();

-- Mirror of packages/erp-domain/src/list-preferences.mjs (listPreferenceValid). Identifiers are lower-case ASCII names.
create function erp_list_preferences.valid(p_columns jsonb,p_filters jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare k text; v jsonb;
begin
 -- SQL NULL and JSON null both mean: no saved value (the screen default).
 if p_columns is not null and jsonb_typeof(p_columns)<>'null' then
  if jsonb_typeof(p_columns)<>'array' or jsonb_array_length(p_columns) not between 1 and 60
   or exists(select 1 from jsonb_array_elements(p_columns) c where jsonb_typeof(c)<>'string' or c#>>'{}'!~'^[a-z][a-z0-9_]{0,39}$')
   or(select count(distinct c#>>'{}') from jsonb_array_elements(p_columns) c)<>jsonb_array_length(p_columns) then return false; end if;
 end if;
 if p_filters is not null and jsonb_typeof(p_filters)<>'null' then
  if jsonb_typeof(p_filters)<>'object' or(select count(*) from jsonb_object_keys(p_filters))>20 or octet_length(p_filters::text)>8192 then return false; end if;
  for k,v in select key,value from jsonb_each(p_filters) loop
   if k!~'^[a-z][a-z0-9_]{0,39}$' then return false; end if;
   case jsonb_typeof(v)
    when 'string' then if length(v#>>'{}')>200 or(v#>>'{}')~'[\x01-\x1f\x7f]' then return false; end if;
    when 'boolean' then null;
    when 'number' then if v::text!~'^-?(0|[1-9][0-9]{0,8})$' then return false; end if;
    when 'array' then
     if jsonb_array_length(v)>50 or exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e)<>'string' or length(e#>>'{}')>100 or(e#>>'{}')~'[\x01-\x1f\x7f]') then return false; end if;
    else return false;
   end case;
  end loop;
 end if;
 return true;
end $$;
create function erp_list_preferences.member(p_actor uuid,p_lock boolean) returns void language plpgsql set search_path=pg_catalog as $$
begin
 if p_lock then perform 1 from auth.users where id=p_actor for key share; end if;
 if p_actor is null or not exists(select 1 from erp_access.membership where user_id=p_actor and active) then
  raise exception 'erp_list_preferences_access_denied' using errcode='42501'; end if;
end $$;
create function erp_list_preferences.reader(p_actor uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_actor is null or not exists(select 1 from erp_access.membership where user_id=p_actor and active) then
  raise exception 'erp_list_preferences_access_denied' using errcode='42501'; end if;
end $$;
create function erp_list_preferences.list_valid(p_list text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select p_list is not null and length(p_list)<=60 and p_list~'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
$$;
create function erp_list_preferences.dto(p_user uuid,p_list text) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','list_preferences','data_mode','erp_native','list_id',p_list,
  'version',coalesce(p.version,0),'columns',to_jsonb(p.columns),'filters',p.filters,'updated_at',p.updated_at)
 from(select 1) x left join erp_list_preferences.preference p on p.user_id=p_user and p.list_id=p_list
$$;

create function public.erp_list_preferences_get(p_user_id uuid,p_list_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_list_preferences.reader(p_user_id);
 if not erp_list_preferences.list_valid(p_list_id) then raise exception 'erp_list_preferences_input_invalid' using errcode='22023'; end if;
 return erp_list_preferences.dto(p_user_id,p_list_id);
end $$;

-- Replaces both values of one list. JSON null clears a value (back to the screen default); at most 200 lists per user.
create function public.erp_list_preferences_save(p_user_id uuid,p_command_id uuid,p_list_id text,p_expected_version integer,p_columns jsonb,p_filters jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_list_preferences.command; v_row erp_list_preferences.preference; v_version integer; v_at timestamptz; v_result jsonb;
 v_columns text[]; v_filters jsonb; v_before jsonb; v_after jsonb;
begin
 perform erp_list_preferences.reader(p_user_id);
 if p_command_id is null or not erp_list_preferences.list_valid(p_list_id) or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or not erp_list_preferences.valid(p_columns,p_filters) then raise exception 'erp_list_preferences_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-list-preferences-v1','actor',p_user_id,'list',p_list_id,'version',p_expected_version,
  'columns',coalesce(p_columns,'null'::jsonb),'filters',coalesce(p_filters,'null'::jsonb))::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_list_preferences_command'),hashtext(p_command_id::text));
 select * into v_command from erp_list_preferences.command where id=p_command_id;
 if v_command.id is not null then
  perform erp_list_preferences.member(p_user_id,true);
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_list_preferences_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('preference',erp_list_preferences.dto(p_user_id,p_list_id),'replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtext('erp_list_preferences_user'),hashtext(p_user_id::text));
 perform erp_list_preferences.member(p_user_id,true);
 select * into v_row from erp_list_preferences.preference where user_id=p_user_id and list_id=p_list_id for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_list_preferences_version_conflict' using errcode='40001'; end if;
 v_columns:=case when p_columns is null or jsonb_typeof(p_columns)='null' then null else array(select jsonb_array_elements_text(p_columns)) end;
 v_filters:=case when p_filters is null or jsonb_typeof(p_filters)='null' then null else p_filters end;
 v_before:=jsonb_build_object('columns',to_jsonb(v_row.columns),'filters',v_row.filters);
 v_after:=jsonb_build_object('columns',to_jsonb(v_columns),'filters',v_filters);
 if v_before=v_after then raise exception 'erp_list_preferences_unchanged' using errcode='22023'; end if;
 if v_row.user_id is null and(select count(*) from erp_list_preferences.preference where user_id=p_user_id)>=200 then
  raise exception 'erp_list_preferences_limit' using errcode='22023'; end if;
 v_version:=p_expected_version+1;v_at:=clock_timestamp();
 v_result:=jsonb_build_object('scope','list_preferences_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'list_id',p_list_id,
  'from_version',p_expected_version,'to_version',v_version,'changed_at',v_at));
 insert into erp_list_preferences.command(id,actor,list_id,request_hash,result) values(p_command_id,p_user_id,p_list_id,v_hash,v_result);
 if v_row.user_id is null then
  insert into erp_list_preferences.preference(user_id,list_id,columns,filters,version,updated_at,command_id) values(p_user_id,p_list_id,v_columns,v_filters,1,v_at,p_command_id);
 else
  update erp_list_preferences.preference set columns=v_columns,filters=v_filters,version=v_version,updated_at=v_at,command_id=p_command_id where user_id=p_user_id and list_id=p_list_id;
 end if;
 insert into erp_list_preferences.audit(command_id,actor,list_id,from_version,to_version,before_data,after_data) values(p_command_id,p_user_id,p_list_id,p_expected_version,v_version,v_before,v_after);
 return v_result||jsonb_build_object('preference',erp_list_preferences.dto(p_user_id,p_list_id),'replayed',false);
end $$;

create function public.erp_list_preferences_command(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_command erp_list_preferences.command;
begin
 perform erp_list_preferences.reader(p_user_id);
 if p_command_id is null then raise exception 'erp_list_preferences_input_invalid' using errcode='22023'; end if;
 select * into v_command from erp_list_preferences.command where id=p_command_id;
 if v_command.id is null then raise exception 'erp_list_preferences_command_not_found' using errcode='P0002'; end if;
 if v_command.actor<>p_user_id then raise exception 'erp_list_preferences_access_denied' using errcode='42501'; end if;
 return v_command.result||jsonb_build_object('preference',erp_list_preferences.dto(p_user_id,v_command.list_id),'replayed',true);
end $$;

revoke all on all functions in schema erp_list_preferences from public,anon,authenticated,service_role;
revoke all on function public.erp_list_preferences_get(uuid,text) from public,anon,authenticated;
revoke all on function public.erp_list_preferences_save(uuid,uuid,text,integer,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.erp_list_preferences_command(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_list_preferences_get(uuid,text) to service_role;
grant execute on function public.erp_list_preferences_save(uuid,uuid,text,integer,jsonb,jsonb) to service_role;
grant execute on function public.erp_list_preferences_command(uuid,uuid) to service_role;
commit;
