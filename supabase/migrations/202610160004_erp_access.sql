-- API interna de consulta. Não cria usuários, não autoriza cadastros automaticamente
-- e não altera o staging ou o domínio financeiro/fiscal.
begin;

create schema erp_access;
revoke all on schema erp_access from public, anon, authenticated, service_role;

create table erp_access.membership (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal')),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table erp_access.membership enable row level security;
revoke all on erp_access.membership from public, anon, authenticated, service_role;
comment on table erp_access.membership is 'Allowlist explícita da única empresa; vazia por padrão. Associação por UUID Auth verificado, nunca por metadados editáveis ou primeiro cadastro.';

create function erp_access.resources_for_role(p_role text)
returns text[] language sql immutable set search_path = pg_catalog
as $$
  select case p_role
    when 'admin' then array['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce']
    when 'consulta' then array['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce']
    when 'vendas' then array['contacts','products','sales_orders','sales_proposals']
    when 'financeiro' then array['contacts','receivables','payables']
    when 'estoque' then array['contacts','products','purchase_orders']
    when 'fiscal' then array['contacts','products','sales_orders','purchase_orders','nfe','nfce']
    else array[]::text[] end;
$$;

-- Objetos/arrays nunca viram texto de resposta por acidente. IDs e valores
-- monetários são strings, sem conversão de identificadores para Number.
create function erp_access.scalar_text(p_value jsonb, p_max integer default 200)
returns text language sql immutable set search_path = pg_catalog
as $$
  select case when jsonb_typeof(p_value) in ('string','number','boolean')
    then left(p_value #>> '{}', p_max) else null end;
$$;

create function erp_access.record_summary(
  p_entity text, p_id text, p_payload jsonb, p_contact jsonb, p_seen_at timestamptz
) returns jsonb language sql stable set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'id', p_id,
    'entity', p_entity,
    'name', case when p_entity in ('contacts','products') then erp_access.scalar_text(p_payload -> 'nome') end,
    'code', case when p_entity in ('contacts','products') then erp_access.scalar_text(p_payload -> 'codigo') end,
    'number', erp_access.scalar_text(p_payload -> 'numero'),
    'date', left(erp_access.scalar_text(case when p_entity in ('receivables','payables','nfe','nfce')
      then p_payload -> 'dataEmissao' else p_payload -> 'data' end), 10),
    'due_date', case when p_entity in ('receivables','payables') then left(erp_access.scalar_text(p_payload -> 'vencimento'), 10) end,
    'status', coalesce(erp_access.scalar_text(p_payload #> '{situacao,id}'), erp_access.scalar_text(p_payload -> 'situacao')),
    'amount', erp_access.scalar_text(case
      when p_entity = 'products' then p_payload -> 'preco'
      when p_entity in ('receivables','payables') then p_payload -> 'valor'
      when p_entity in ('nfe','nfce') then p_payload -> 'valorNota'
      when p_entity in ('sales_orders','purchase_orders','sales_proposals') then p_payload -> 'total' end),
    'balance', case when p_entity in ('receivables','payables') then erp_access.scalar_text(p_payload -> 'saldo') end,
    'counterparty_id', case when p_entity = 'purchase_orders' then erp_access.scalar_text(p_payload #> '{fornecedor,id}')
      when p_entity not in ('contacts','products') then erp_access.scalar_text(p_payload #> '{contato,id}') end,
    'counterparty_name', case when p_entity not in ('contacts','products') then coalesce(
      erp_access.scalar_text(p_payload #> '{contato,nome}'), erp_access.scalar_text(p_contact -> 'nome')) end,
    'model', case when p_entity = 'nfe' then '55' when p_entity = 'nfce' then '65' end,
    'series', case when p_entity in ('nfe','nfce') then erp_access.scalar_text(p_payload -> 'serie') end,
    'direction', case when p_entity = 'nfe' then erp_access.scalar_text(p_payload -> 'tipo') end,
    'last_seen_at', p_seen_at
  );
$$;

create function public.erp_access_me(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id = p_user_id and active;
  if not found then raise exception 'erp_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('user_id', p_user_id::text, 'role', v_role,
    'resources', erp_access.resources_for_role(v_role), 'data_mode', 'staging_readonly');
end;
$$;

create function public.erp_read_records(
  p_user_id uuid, p_entity text, p_limit integer default 25, p_offset integer default 0,
  p_query text default null, p_status text default null, p_from date default null, p_to date default null
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_role text; v_result jsonb;
begin
  select role into v_role from erp_access.membership where user_id = p_user_id and active;
  if not found or not (p_entity = any(erp_access.resources_for_role(v_role))) or p_entity is null then
    raise exception 'erp_access_denied' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 100000
     or length(p_query) > 120 or length(p_status) > 80
     or (p_from is not null and (not isfinite(p_from) or p_from < date '1900-01-01' or p_from > date '2100-12-31'))
     or (p_to is not null and (not isfinite(p_to) or p_to < date '1900-01-01' or p_to > date '2100-12-31'))
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'erp_invalid_query' using errcode = '22023';
  end if;

  with summaries as materialized (
    select r.source_id, erp_access.record_summary(r.entity, r.source_id, r.payload, c.payload, r.last_seen_at) as item
    from origin_sync.raw_record r
    left join origin_sync.raw_record c on c.entity = 'contacts' and c.source_id = case
      when r.entity = 'purchase_orders' then erp_access.scalar_text(r.payload #> '{fornecedor,id}')
      when r.entity not in ('contacts','products') then erp_access.scalar_text(r.payload #> '{contato,id}') end
    where r.entity = p_entity
  ), filtered as materialized (
    select * from summaries
    where (nullif(btrim(p_query), '') is null or strpos(lower(concat_ws(' ', item ->> 'name', item ->> 'code', item ->> 'number', item ->> 'counterparty_name')), lower(btrim(p_query))) > 0)
      and (nullif(p_status, '') is null or item ->> 'status' = p_status)
      and (p_from is null or item ->> 'date' >= p_from::text)
      and (p_to is null or item ->> 'date' <= p_to::text)
  ), page as (
    select source_id, item from filtered order by source_id collate "C" limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'entity', p_entity, 'items', coalesce((select jsonb_agg(item order by source_id collate "C") from page), '[]'::jsonb),
    'limit', p_limit, 'offset', p_offset, 'total', (select count(*) from filtered),
    'has_more', (select count(*) from filtered) > p_offset + p_limit,
    'next_offset', case when (select count(*) from filtered) > p_offset + p_limit then p_offset + p_limit end,
    'data_mode', 'staging_readonly'
  ) into v_result;
  return v_result;
end;
$$;

revoke all on all functions in schema erp_access from public, anon, authenticated, service_role;
revoke all on function public.erp_access_me(uuid) from public, anon, authenticated;
revoke all on function public.erp_read_records(uuid,text,integer,integer,text,text,date,date) from public, anon, authenticated;
grant execute on function public.erp_access_me(uuid) to service_role;
grant execute on function public.erp_read_records(uuid,text,integer,integer,text,text,date,date) to service_role;
alter default privileges in schema erp_access revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema erp_access revoke all on functions from public, anon, authenticated, service_role;

commit;
