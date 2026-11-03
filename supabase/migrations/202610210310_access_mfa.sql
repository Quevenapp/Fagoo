-- Leva H, lane acesso (PRF-208, PRF-209): segundo fator TOTP do Supabase Auth. O administrador liga a política da empresa em
-- Preferências › Segurança; com ela ligada, administradores, o perfil financeiro e quem tem poderes financeiros sensíveis
-- (baixar, cancelar, transferir, gerar remessa, ler retornos, boletos) só usam o Brufap numa sessão aal2.
-- A conferência é do banco: o Worker passa o session_id do token já validado pelo Auth e erp_access_gate_v2 lê o aal da
-- própria sessão em auth.sessions. Com a política ligada, todo membro passa pelo portão (gate_required), para que a troca de
-- perfil ou de permissões valha na hora, sem depender de outra marca no Auth.
-- Ligar ou desligar a política e redefinir o segundo fator de outro usuário exigem administrador numa sessão aal2; cada comando
-- fica registrado uma vez (o mesmo comando reenviado devolve o mesmo recibo) e o histórico é imutável. Nenhum segredo é lido.
-- Sistema › Usuários ganha a coluna MFA (fator TOTP verificado).
begin;

create table erp_access.security_policy(
 singleton boolean primary key default true check(singleton),
 mfa_required boolean not null,
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id)
);
create table erp_access.security_command(
 id uuid primary key,
 actor uuid not null references auth.users(id),
 kind text not null check(kind in('policy','mfa_reset')),
 target uuid references auth.users(id),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 created_at timestamptz not null default clock_timestamp(),
 check((kind='mfa_reset')=(target is not null))
);
create table erp_access.security_event(
 id bigint generated always as identity primary key,
 command_id uuid not null unique references erp_access.security_command(id),
 actor uuid not null references auth.users(id),
 target uuid references auth.users(id),
 action text not null check(action in('mfa_policy_on','mfa_policy_off','mfa_reset')),
 detail jsonb not null check(jsonb_typeof(detail)='object'),
 created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['security_policy','security_command','security_event'] loop
 execute format('alter table erp_access.%I enable row level security',t);
 execute format('revoke all on erp_access.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_access from public,anon,authenticated,service_role;
create trigger immutable_security_command before update or delete on erp_access.security_command for each row execute function erp_access.users_history_immutable();
create trigger immutable_security_event before update or delete on erp_access.security_event for each row execute function erp_access.users_history_immutable();

create function erp_access.mfa_policy_on() returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select mfa_required from erp_access.security_policy where singleton),false)
$$;
-- Poderes financeiros que movimentam dinheiro ou cobrança; quem tem algum deles entra na exigência.
create function erp_access.mfa_sensitive_keys() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['financas.caixas_bancos.transferencia','financas.contas_pagar.baixar','financas.contas_pagar.cancelar','financas.contas_receber.baixar',
  'financas.contas_receber.cancelar','financas.ficha.baixar','financas.remessas.gerar','financas.retornos.ie','financas.boletos']
$$;
-- Quem precisaria do segundo fator se a política estivesse ligada (a tela mostra antes de ligar).
create function erp_access.mfa_in_scope(p_user uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select m.role in('admin','financeiro') or(c.permissions is not null and c.permissions&&erp_access.mfa_sensitive_keys())
  from erp_access.membership m left join erp_access.user_control c on c.user_id=m.user_id where m.user_id=p_user and m.active),false)
$$;
create function erp_access.mfa_required(p_user uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_access.mfa_policy_on() and erp_access.mfa_in_scope(p_user)
$$;
-- As tabelas do Auth são lidas só em SQL dinâmico (validadas na execução), como na 151.
create function erp_access.has_verified_factor(p_user uuid) returns boolean language plpgsql stable set search_path=pg_catalog as $$
declare v boolean:=false;
begin
 if p_user is null or to_regclass('auth.mfa_factors') is null then return false; end if;
 execute $q$select exists(select 1 from auth.mfa_factors where user_id=$1 and status::text='verified' and factor_type::text='totp')$q$ into v using p_user;
 return v;
end $$;
create function erp_access.session_aal2(p_user uuid,p_session uuid) returns boolean language plpgsql stable set search_path=pg_catalog as $$
declare v boolean:=false;
begin
 if p_user is null or p_session is null or to_regclass('auth.sessions') is null then return false; end if;
 execute $q$select exists(select 1 from auth.sessions where id=$1 and user_id=$2 and aal::text='aal2' and(not_after is null or not_after>clock_timestamp()))$q$ into v using p_session,p_user;
 return v;
end $$;
create function erp_access.require_aal2(p_user uuid,p_session uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if not erp_access.session_aal2(p_user,p_session) then raise exception 'erp_access_mfa_required' using errcode='28000'; end if;
end $$;

-- 229 + leva H: com a política ligada, todo membro passa pelo portão do Worker (horários e segundo fator).
create or replace function erp_access.gate_required(p_user uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select c.schedule_enabled from erp_access.user_control c where c.user_id=p_user),false)
  or coalesce((select s.access_hours_enabled and jsonb_array_length(s.access_windows)>0 from erp_catalog.seller s where s.user_id=p_user),false)
  or erp_access.mfa_policy_on()
$$;

-- O portão do Worker (a cada minuto por sessão): horário de acesso e, quando exigido, sessão aal2.
create function public.erp_access_gate_v2(p_user_id uuid,p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_required boolean;
begin
 if p_user_id is null or not exists(select 1 from erp_access.membership where user_id=p_user_id and active) then raise exception 'erp_access_denied' using errcode='42501'; end if;
 v_required:=erp_access.mfa_required(p_user_id);
 return jsonb_build_object('scope','access_gate','data_mode','erp_native','user_id',p_user_id,'open',erp_access.schedule_allows(p_user_id),'until',erp_access.schedule_until(p_user_id),
  'mfa_required',v_required,'mfa_ok',not v_required or erp_access.session_aal2(p_user_id,p_session_id));
end $$;

-- /v1/me: o mesmo de 229, mais gate_required (o Worker grava a marca do Auth de quem ainda não a tem, p.ex. um convidado
-- depois de ligada a política).
create or replace function public.erp_access_me(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id = p_user_id and active;
  if not found then raise exception 'erp_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('user_id', p_user_id::text, 'role', v_role,
    'resources', erp_access.resources_for_role(v_role), 'data_mode', 'staging_readonly',
    'access_window', case when erp_access.schedule_allows(p_user_id) then 'open' else 'closed' end,
    'gate_required', erp_access.gate_required(p_user_id));
end;
$$;

-- plpgsql: as colunas de auth.users são validadas na execução, não na criação (como na 117).
create function erp_access.security_policy_dto() returns jsonb language plpgsql stable set search_path=pg_catalog as $$
begin
 return jsonb_build_object('mfa_required',erp_access.mfa_policy_on(),'version',coalesce((select version from erp_access.security_policy where singleton),0),
  'updated_at',(select updated_at from erp_access.security_policy where singleton),
  'members',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'name',coalesce(p.name,u.email),'role',m.role,'factor',erp_access.has_verified_factor(m.user_id))
    order by lower(coalesce(p.name,u.email)),m.user_id),'[]'::jsonb)
   from erp_access.membership m join auth.users u on u.id=m.user_id left join erp_access.profile p on p.user_id=m.user_id
   where m.active and erp_access.mfa_in_scope(m.user_id)));
end $$;

-- Preferências › Segurança (administrador).
create function public.erp_access_security_policy_get(p_user_id uuid,p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_access.read_admin(p_user_id);
 return jsonb_build_object('scope','access_security_policy','data_mode','erp_native','policy',erp_access.security_policy_dto(),
  'self',jsonb_build_object('factor',erp_access.has_verified_factor(p_user_id),'aal2',erp_access.session_aal2(p_user_id,p_session_id)));
end $$;

-- Liga ou desliga a exigência. Devolve a marca do Auth de cada membro (o Worker grava cada uma; uma gravação perdida é
-- "não confirmada" e o mesmo comando, reenviado, devolve o recibo e as marcas de novo).
create function public.erp_access_security_policy_save(p_user_id uuid,p_session_id uuid,p_command_id uuid,p_expected_version integer,p_mfa_required boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_access.security_command; v_row erp_access.security_policy; v_at timestamptz; v_result jsonb;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version<0 or p_mfa_required is null then raise exception 'erp_access_security_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('kind','policy','expected_version',p_expected_version,'mfa_required',p_mfa_required)::text,'UTF8')),'hex');
 select * into v_command from erp_access.security_command where id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.kind<>'policy' or v_command.request_hash<>v_hash then raise exception 'erp_access_security_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('replayed',true,'gates',erp_access.security_gates());
 end if;
 perform erp_access.require_aal2(p_user_id,p_session_id);
 select * into v_row from erp_access.security_policy where singleton for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_access_security_version_conflict' using errcode='40001'; end if;
 if coalesce(v_row.mfa_required,false)=p_mfa_required then raise exception 'erp_access_security_unchanged' using errcode='22023'; end if;
 v_at:=clock_timestamp();
 if v_row.version is null then insert into erp_access.security_policy values(true,p_mfa_required,1,v_at,p_user_id);
 else update erp_access.security_policy set mfa_required=p_mfa_required,version=version+1,updated_at=v_at,updated_by=p_user_id where singleton; end if;
 v_result:=jsonb_build_object('scope','access_security_command','data_mode','erp_native',
  'receipt',jsonb_build_object('command_id',p_command_id,'from_version',p_expected_version,'to_version',p_expected_version+1,'changed_at',v_at),
  'policy',erp_access.security_policy_dto());
 insert into erp_access.security_command(id,actor,kind,request_hash,result) values(p_command_id,p_user_id,'policy',v_hash,v_result);
 insert into erp_access.security_event(command_id,actor,action,detail) values(p_command_id,p_user_id,case when p_mfa_required then 'mfa_policy_on' else 'mfa_policy_off' end,
  jsonb_build_object('from_version',p_expected_version,'to_version',p_expected_version+1));
 return v_result||jsonb_build_object('replayed',false,'gates',erp_access.security_gates());
end $$;
create function erp_access.security_gates() returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'gate_required',erp_access.gate_required(m.user_id)) order by m.user_id),'[]'::jsonb) from erp_access.membership m
$$;

-- Recuperação: o administrador (aal2) redefine o segundo fator de outro usuário que perdeu o aparelho. O banco registra o
-- comando e devolve os fatores que o Worker remove pelo Auth admin; o usuário cadastra um novo no próximo acesso.
create function public.erp_access_mfa_reset(p_user_id uuid,p_session_id uuid,p_command_id uuid,p_target uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_access.security_command; v_factors jsonb:='[]'; v_result jsonb;
begin
 perform erp_access.read_admin(p_user_id);
 if p_command_id is null or p_target is null then raise exception 'erp_access_security_input_invalid' using errcode='22023'; end if;
 if p_target=p_user_id then raise exception 'erp_access_mfa_reset_self' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=p_target) then raise exception 'erp_access_user_not_found' using errcode='P0002'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('kind','mfa_reset','target',p_target)::text,'UTF8')),'hex');
 select * into v_command from erp_access.security_command where id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.kind<>'mfa_reset' or v_command.request_hash<>v_hash then raise exception 'erp_access_security_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('replayed',true);
 end if;
 perform erp_access.require_aal2(p_user_id,p_session_id);
 if to_regclass('auth.mfa_factors') is not null then
  execute $q$select coalesce(jsonb_agg(id::text order by created_at,id),'[]'::jsonb) from auth.mfa_factors where user_id=$1$q$ into v_factors using p_target;
 end if;
 v_result:=jsonb_build_object('scope','access_mfa_reset','data_mode','erp_native','command_id',p_command_id,'target',p_target,'factors',v_factors,'changed_at',clock_timestamp());
 insert into erp_access.security_command(id,actor,kind,target,request_hash,result) values(p_command_id,p_user_id,'mfa_reset',p_target,v_hash,v_result);
 insert into erp_access.security_event(command_id,actor,target,action,detail) values(p_command_id,p_user_id,p_target,'mfa_reset',jsonb_build_object('factors',jsonb_array_length(v_factors)));
 return v_result||jsonb_build_object('replayed',false);
end $$;

-- Sistema › Usuários: a lista da 229 com a coluna MFA.
create or replace function public.erp_access_users_list_v2(p_user_id uuid,p_query text,p_status text,p_type text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_total integer; v_counts jsonb; v_q text;
begin
 perform erp_access.read_admin(p_user_id);
 if p_status is null or p_status not in('todos','ativo','inativo','sem_acesso') or p_type is null or p_type not in('todos','normal','contador')
  or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_access_users_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with accounts as materialized(
  select erp_access.user_dto(u.id)||jsonb_build_object('user_type',coalesce(c.user_type,'normal'),'mfa',erp_access.has_verified_factor(u.id)) d from auth.users u left join erp_access.user_control c on c.user_id=u.id
 ), filtered as materialized(
  select d from accounts where d->>'user_id' is not null and(p_status='todos' or d->>'status'=p_status) and(p_type='todos' or d->>'user_type'=p_type)
   and(v_q is null or strpos(lower(coalesce(d->>'name','')),v_q)>0 or strpos(d->>'email',v_q)>0)
 )
 select(select count(*) from filtered),
  (select coalesce(jsonb_agg(d order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id'),'[]'::jsonb) from(select d from filtered order by lower(coalesce(d->>'name',d->>'email')),d->>'email',d->>'user_id' limit p_limit offset p_offset) x),
  (select jsonb_build_object('ativo',count(*) filter(where d->>'status'='ativo'),'inativo',count(*) filter(where d->>'status'='inativo'),'sem_acesso',count(*) filter(where d->>'status'='sem_acesso')) from accounts where d->>'user_id' is not null)
  into v_total,v_items,v_counts;
 return jsonb_build_object('scope','access_users','data_mode','erp_native','status',p_status,'type',p_type,'query',v_q,'limit',p_limit,'offset',p_offset,'total',v_total,
  'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items,'counts',v_counts,'actor',p_user_id);
end $$;

revoke all on function erp_access.mfa_policy_on(),erp_access.mfa_sensitive_keys(),erp_access.mfa_in_scope(uuid),erp_access.mfa_required(uuid),erp_access.has_verified_factor(uuid),
 erp_access.session_aal2(uuid,uuid),erp_access.require_aal2(uuid,uuid),erp_access.gate_required(uuid),erp_access.security_policy_dto(),erp_access.security_gates()
 from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_access_gate_v2','erp_access_me','erp_access_security_policy_get','erp_access_security_policy_save','erp_access_mfa_reset','erp_access_users_list_v2')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
