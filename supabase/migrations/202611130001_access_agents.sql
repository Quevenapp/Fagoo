-- Acesso de agentes externos. Um agente é um usuário técnico do Auth (sem senha e sem login), com associação comum em
-- erp_access.membership: as RPCs continuam recebendo p_user_id e aplicam a ele perfil, permissões de Sistema › Usuários,
-- horários de acesso e auditoria, como a qualquer membro. Esta migração acrescenta só a credencial:
-- * erp_access.agent marca a conta como agente. Uma conta que já tem associação nunca vira agente, para que um token
--   não substitua a senha e o segundo fator de uma pessoa.
-- * erp_access.agent_token guarda o SHA-256 do token, com validade, revogação e último uso. O token não é gravado.
-- * public.erp_access_agent_resolve atende o Worker: devolve o usuário de um token válido. O agente fora do limite
--   (administrador, financeiro ou poderes financeiros sensíveis: erp_access.mfa_in_scope) é recusado a cada chamada, com
--   a política de segundo fator ligada ou não, porque um token não tem sessão aal2.
-- * Registrar o agente, emitir e revogar tokens são funções privadas do operador da instalação, sem grant para
--   service_role: a API não cria agentes nem tokens.
begin;

do $$begin
 if to_regprocedure('erp_access.mfa_in_scope(uuid)') is null or to_regclass('erp_access.profile') is null
  or to_regprocedure('erp_access.users_history_immutable()') is null then
  raise exception 'access_agents_requires_117_and_310' using errcode='55000'; end if;
end$$;

create table erp_access.agent(
 user_id uuid primary key references auth.users(id),
 created_at timestamptz not null default clock_timestamp()
);
create table erp_access.agent_token(
 id uuid primary key,
 agent_id uuid not null references erp_access.agent(user_id),
 token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'),
 -- Os quatro últimos caracteres do token, para o operador reconhecer qual é qual.
 hint text not null check(hint~'^[A-Za-z0-9_-]{4}$'),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz check(expires_at is null or expires_at>created_at),
 revoked_at timestamptz,
 last_used_at timestamptz
);
create index erp_access_agent_token_agent on erp_access.agent_token(agent_id);
do $$declare t text;begin foreach t in array array['agent','agent_token'] loop
 execute format('alter table erp_access.%I enable row level security',t);
 execute format('revoke all on erp_access.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create trigger immutable_agent before update or delete on erp_access.agent for each row execute function erp_access.users_history_immutable();
-- Um token só muda no último uso e na revogação, que não volta atrás; nada é apagado.
create function erp_access.guard_agent_token() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or new.id<>old.id or new.agent_id<>old.agent_id or new.token_hash<>old.token_hash or new.hint<>old.hint
  or new.created_at<>old.created_at or new.expires_at is distinct from old.expires_at
  or(old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
  raise exception 'erp_access_history_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_agent_token before update or delete on erp_access.agent_token for each row execute function erp_access.guard_agent_token();

-- O limite do agente, conferido a cada chamada: associação ativa e fora do escopo do segundo fator.
create function erp_access.agent_allowed(p_user uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_access.agent a join erp_access.membership m on m.user_id=a.user_id where a.user_id=p_user and m.active)
  and not erp_access.mfa_in_scope(p_user)
$$;

-- O Worker envia o SHA-256 do token recebido. "unknown" cobre token inexistente, revogado ou vencido, sem distinguir;
-- "denied" é um token válido de um agente inativo ou fora do limite. O último uso é gravado no máximo uma vez por minuto.
create function public.erp_access_agent_resolve(p_token_hash text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog as $$
declare v_id uuid; v_agent uuid; v_used timestamptz;
begin
 if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$' then return jsonb_build_object('scope','agent_access','status','unknown'); end if;
 select id,agent_id,last_used_at into v_id,v_agent,v_used from erp_access.agent_token
  where token_hash=p_token_hash and revoked_at is null and(expires_at is null or expires_at>clock_timestamp());
 if not found then return jsonb_build_object('scope','agent_access','status','unknown'); end if;
 if not erp_access.agent_allowed(v_agent) then return jsonb_build_object('scope','agent_access','status','denied'); end if;
 if v_used is null or v_used<clock_timestamp()-interval '1 minute' then
  update erp_access.agent_token set last_used_at=clock_timestamp() where id=v_id; end if;
 return jsonb_build_object('scope','agent_access','status','ok','user_id',v_agent,'token_id',v_id);
end $$;

-- Operador: a conta do Auth já existe (criada sem senha) e ainda não tem associação. Perfis que movimentam dinheiro ou
-- administram a empresa não são oferecidos a agentes.
create function erp_access.agent_register(p_user uuid,p_name text,p_role text) returns void language plpgsql set search_path=pg_catalog as $$
begin
 if p_user is null or p_name is null or p_role is null or p_role not in('consulta','vendas','estoque','fiscal') then
  raise exception 'erp_access_agent_invalid' using errcode='22023'; end if;
 perform 1 from auth.users where id=p_user for key share;
 if not found then raise exception 'erp_access_agent_invalid' using errcode='22023'; end if;
 if exists(select 1 from erp_access.membership where user_id=p_user) or exists(select 1 from erp_access.agent where user_id=p_user) then
  raise exception 'erp_access_agent_exists' using errcode='23505'; end if;
 insert into erp_access.membership(user_id,role,active) values(p_user,p_role,true);
 insert into erp_access.profile(user_id,name,version,updated_at,updated_by) values(p_user,p_name,1,clock_timestamp(),p_user);
 insert into erp_access.agent(user_id) values(p_user);
end $$;
create function erp_access.agent_token_issue(p_agent uuid,p_token_hash text,p_hint text,p_expires_at timestamptz) returns uuid language plpgsql set search_path=pg_catalog as $$
declare v_id uuid:=gen_random_uuid();
begin
 if not exists(select 1 from erp_access.agent where user_id=p_agent) then raise exception 'erp_access_agent_not_found' using errcode='P0002'; end if;
 insert into erp_access.agent_token(id,agent_id,token_hash,hint,expires_at) values(v_id,p_agent,p_token_hash,p_hint,p_expires_at);
 return v_id;
end $$;
create function erp_access.agent_token_revoke(p_token uuid) returns boolean language plpgsql set search_path=pg_catalog as $$
begin
 update erp_access.agent_token set revoked_at=clock_timestamp() where id=p_token and revoked_at is null;
 return found;
end $$;

revoke all on function erp_access.guard_agent_token(),erp_access.agent_allowed(uuid),erp_access.agent_register(uuid,text,text),
 erp_access.agent_token_issue(uuid,text,text,timestamptz),erp_access.agent_token_revoke(uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_access_agent_resolve(text) from public,anon,authenticated,service_role;
grant execute on function public.erp_access_agent_resolve(text) to service_role;
commit;
