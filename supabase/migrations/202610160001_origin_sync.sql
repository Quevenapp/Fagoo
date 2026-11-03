-- Brufap SaaS: staging de leitura da API Origin. Não altera tabelas do ERP.
-- Contrato: docs/integrations/origin-sync-rpc.md.
-- Apenas service_role executa as RPCs; tabelas privadas e RLS sem políticas públicas.
-- Access/refresh tokens chegam aqui somente dentro de envelope cifrado pelo Worker.
begin;

create schema if not exists origin_sync;
revoke all on schema origin_sync from public, anon, authenticated;

create table origin_sync.account (
  id smallint primary key default 1 check (id = 1),
  created_at timestamptz not null default clock_timestamp()
);
insert into origin_sync.account (id) values (1);

create table origin_sync.resource_state (
  resource text primary key check (
    resource in ('__oauth__', '__scheduler__') or resource ~ '^[a-z][a-z0-9_]{0,79}$'
  ),
  account_id smallint not null default 1 references origin_sync.account (id) check (account_id = 1),
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  checkpoint_version bigint not null default 0 check (checkpoint_version >= 0),
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (lease_owner is null and lease_token is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and lease_expires_at is not null)
  )
);

create table origin_sync.credentials (
  account_id smallint primary key default 1 references origin_sync.account (id) check (account_id = 1),
  ciphertext jsonb not null check (jsonb_typeof(ciphertext) = 'object' and ciphertext <> '{}'::jsonb),
  expires_at timestamptz not null,
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default clock_timestamp()
);

create table origin_sync.oauth_state (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index oauth_state_expiry_idx on origin_sync.oauth_state (expires_at);

create table origin_sync.raw_record (
  entity text not null check (entity in (
    'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe'
  )),
  last_resource text not null references origin_sync.resource_state (resource),
  source_id text not null check (length(source_id) between 1 and 200),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  document_links jsonb not null default '[]'::jsonb check (jsonb_typeof(document_links) = 'array'),
  version_hash text not null check (version_hash ~ '^[0-9a-f]{64}$'),
  version bigint not null default 1 check (version > 0),
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  changed_at timestamptz not null default clock_timestamp(),
  primary key (entity, source_id)
);
create index raw_record_changed_idx on origin_sync.raw_record (entity, changed_at);

-- Ledger/inbox de lotes processados: um batch_id representa uma requisição exata.
-- Não é endpoint de webhook nem autoriza receber eventos sem validação do remetente.
create table origin_sync.batch_inbox (
  batch_id uuid primary key,
  resource text not null references origin_sync.resource_state (resource),
  entity text not null check (entity in (
    'control', 'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe'
  )),
  owner uuid not null,
  lease_token uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_before jsonb not null,
  checkpoint_after jsonb not null,
  result jsonb not null,
  applied_at timestamptz not null default clock_timestamp()
);
create index batch_inbox_resource_idx on origin_sync.batch_inbox (resource, applied_at);

alter table origin_sync.account enable row level security;
alter table origin_sync.resource_state enable row level security;
alter table origin_sync.credentials enable row level security;
alter table origin_sync.oauth_state enable row level security;
alter table origin_sync.raw_record enable row level security;
alter table origin_sync.batch_inbox enable row level security;
revoke all on all tables in schema origin_sync from public, anon, authenticated, service_role;

create function public.origin_sync_claim(
  p_resource text,
  p_owner uuid,
  p_ttl_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_state origin_sync.resource_state%rowtype;
  v_now timestamptz;
begin
  if p_owner is null or p_resource is null or p_ttl_seconds is null
     or p_ttl_seconds < 30 or p_ttl_seconds > 900 then
    raise exception 'invalid_claim_arguments' using errcode = '22023';
  end if;
  insert into origin_sync.resource_state (resource) values (p_resource)
  on conflict (resource) do nothing;
  select * into v_state from origin_sync.resource_state
  where resource = p_resource for update;
  v_now := clock_timestamp();
  if v_state.lease_expires_at > v_now and v_state.lease_owner <> p_owner then
    return jsonb_build_object('acquired', false, 'lease_expires_at', v_state.lease_expires_at);
  end if;
  -- Claim repetido pelo mesmo job mantém o fence enquanto a lease estiver válida.
  if v_state.lease_expires_at is null or v_state.lease_expires_at <= v_now
     or v_state.lease_owner is distinct from p_owner then
    v_state.lease_token := gen_random_uuid();
  end if;
  update origin_sync.resource_state
  set lease_owner = p_owner, lease_token = v_state.lease_token,
      lease_expires_at = v_now + make_interval(secs => p_ttl_seconds), updated_at = v_now
  where resource = p_resource
  returning * into v_state;
  return jsonb_build_object(
    'acquired', true, 'lease_token', v_state.lease_token,
    'lease_expires_at', v_state.lease_expires_at,
    'checkpoint', v_state.checkpoint, 'checkpoint_version', v_state.checkpoint_version
  );
end;
$$;

create function public.origin_sync_renew(
  p_resource text, p_owner uuid, p_lease_token uuid, p_ttl_seconds integer default 300
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_state origin_sync.resource_state%rowtype;
  v_now timestamptz;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 900 then
    raise exception 'invalid_lease_ttl' using errcode = '22023';
  end if;
  select * into v_state from origin_sync.resource_state where resource = p_resource for update;
  v_now := clock_timestamp();
  if not found or p_owner is null or p_lease_token is null
     or v_state.lease_owner is distinct from p_owner
     or v_state.lease_token is distinct from p_lease_token
     or v_state.lease_expires_at is null or v_state.lease_expires_at <= v_now then
    raise exception 'lease_not_owned_or_expired' using errcode = '55000';
  end if;
  update origin_sync.resource_state
  set lease_expires_at = v_now + make_interval(secs => p_ttl_seconds), updated_at = v_now
  where resource = p_resource returning * into v_state;
  return jsonb_build_object('renewed', true, 'lease_expires_at', v_state.lease_expires_at);
end;
$$;

create function public.origin_sync_release(p_resource text, p_owner uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_released integer;
begin
  -- A lease vencida também pode ser limpa se ainda pertence ao mesmo fence.
  update origin_sync.resource_state
  set lease_owner = null, lease_token = null, lease_expires_at = null, updated_at = clock_timestamp()
  where resource = p_resource and lease_owner = p_owner and lease_token = p_lease_token;
  get diagnostics v_released = row_count;
  return jsonb_build_object('released', v_released = 1);
end;
$$;

create function public.origin_sync_get_credentials()
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_credentials origin_sync.credentials%rowtype;
begin
  select * into v_credentials from origin_sync.credentials where account_id = 1;
  if not found then
    return jsonb_build_object('ciphertext', null, 'expires_at', null, 'revision', 0);
  end if;
  return jsonb_build_object('ciphertext', v_credentials.ciphertext,
    'expires_at', v_credentials.expires_at, 'revision', v_credentials.revision);
end;
$$;

create function public.origin_sync_status()
returns jsonb language sql stable security definer set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'connected', exists(select 1 from origin_sync.credentials where account_id = 1),
    'expires_at', (select expires_at from origin_sync.credentials where account_id = 1),
    'entities', (
      select jsonb_agg(jsonb_build_object('entity', counts.entity, 'records', counts.records) order by counts.entity)
      from (
        select e.entity, count(r.source_id) as records
        from unnest(array['contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe']) as e(entity)
        left join origin_sync.raw_record r on r.entity = e.entity
        group by e.entity
      ) as counts
    ),
    'last_run', (select checkpoint -> 'lastRun' from origin_sync.resource_state where resource = '__scheduler__'),
    'resources', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'resource', resource, 'checkpoint_version', checkpoint_version, 'updated_at', updated_at
      ) order by resource), '[]'::jsonb)
      from origin_sync.resource_state
    )
  );
$$;

create function public.origin_sync_put_credentials(
  p_ciphertext jsonb, p_expires_at timestamptz, p_expected_revision bigint,
  p_owner uuid, p_lease_token uuid
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_state origin_sync.resource_state%rowtype;
  v_revision bigint;
  v_now timestamptz;
begin
  if p_ciphertext is null or jsonb_typeof(p_ciphertext) <> 'object'
     or p_ciphertext = '{}'::jsonb or octet_length(p_ciphertext::text) > 65536
     or p_expires_at is null or not isfinite(p_expires_at)
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_credentials_envelope' using errcode = '22023';
  end if;
  select * into v_state from origin_sync.resource_state where resource = '__oauth__' for update;
  v_now := clock_timestamp();
  if not found or p_owner is null or p_lease_token is null
     or v_state.lease_owner is distinct from p_owner
     or v_state.lease_token is distinct from p_lease_token
     or v_state.lease_expires_at is null or v_state.lease_expires_at <= v_now then
    raise exception 'oauth_lease_not_owned_or_expired' using errcode = '55000';
  end if;
  select revision into v_revision from origin_sync.credentials where account_id = 1 for update;
  v_revision := coalesce(v_revision, 0);
  if v_revision <> p_expected_revision then
    raise exception 'credentials_revision_conflict' using errcode = '40001';
  end if;
  v_revision := v_revision + 1;
  insert into origin_sync.credentials (account_id, ciphertext, expires_at, revision, updated_at)
  values (1, p_ciphertext, p_expires_at, v_revision, v_now)
  on conflict (account_id) do update
  set ciphertext = excluded.ciphertext, expires_at = excluded.expires_at,
      revision = excluded.revision, updated_at = excluded.updated_at;
  return jsonb_build_object('revision', v_revision, 'expires_at', p_expires_at);
end;
$$;

create function public.origin_sync_create_oauth_state(
  p_state_hash text, p_browser_hash text, p_expires_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null or not isfinite(p_expires_at)
     or p_expires_at <= v_now or p_expires_at > v_now + interval '10 minutes' then
    raise exception 'invalid_oauth_state_or_ttl' using errcode = '22023';
  end if;
  delete from origin_sync.oauth_state where expires_at <= v_now;
  insert into origin_sync.oauth_state (state_hash, browser_hash, expires_at)
  values (p_state_hash, p_browser_hash, p_expires_at);
  return jsonb_build_object('created', true, 'expires_at', p_expires_at);
end;
$$;

create function public.origin_sync_consume_oauth_state(p_state_hash text, p_browser_hash text)
returns boolean language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_deleted text;
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  delete from origin_sync.oauth_state
  where state_hash = p_state_hash and browser_hash = p_browser_hash
    and expires_at > clock_timestamp()
  returning state_hash into v_deleted;
  return v_deleted is not null;
end;
$$;

create function public.origin_sync_apply_batch(
  p_resource text, p_entity text, p_owner uuid, p_lease_token uuid, p_batch_id uuid,
  p_records jsonb, p_checkpoint jsonb, p_expected_checkpoint_version bigint
) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_state origin_sync.resource_state%rowtype;
  v_batch origin_sync.batch_inbox%rowtype;
  v_existing origin_sync.raw_record%rowtype;
  v_item jsonb;
  v_links jsonb;
  v_source_id text;
  v_source_updated_at timestamptz;
  v_hash text;
  v_request_hash text;
  v_now timestamptz;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_stale integer := 0;
  v_result jsonb;
begin
  if p_resource is null or p_entity is null or p_owner is null or p_lease_token is null or p_batch_id is null
     or p_records is null or jsonb_typeof(p_records) <> 'array'
     or p_checkpoint is null or jsonb_typeof(p_checkpoint) <> 'object'
     or p_expected_checkpoint_version is null or p_expected_checkpoint_version < 0 then
    raise exception 'invalid_batch_arguments' using errcode = '22023';
  end if;
  if jsonb_array_length(p_records) > 100 or octet_length(p_records::text) > 10485760
     or octet_length(p_checkpoint::text) > 65536 then
    raise exception 'batch_size_exceeded' using errcode = '22023';
  end if;
  if p_entity not in (
    'control', 'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe'
  ) then
    raise exception 'invalid_entity' using errcode = '22023';
  end if;
  if (p_resource in ('__oauth__', '__scheduler__') and
      (p_entity <> 'control' or jsonb_array_length(p_records) > 0))
     or (p_entity = 'control' and p_resource not in ('__oauth__', '__scheduler__')) then
    raise exception 'invalid_control_resource_entity_or_records' using errcode = '22023';
  end if;
  v_request_hash := encode(sha256(convert_to(jsonb_build_object(
    'resource', p_resource, 'entity', p_entity, 'records', p_records, 'checkpoint', p_checkpoint,
    'expected_checkpoint_version', p_expected_checkpoint_version
  )::text, 'UTF8')), 'hex');

  -- Serializa lote/checkpoint contra claim, renew e apply concorrentes deste recurso.
  select * into v_state from origin_sync.resource_state where resource = p_resource for update;
  if not found then
    raise exception 'resource_not_claimed' using errcode = '55000';
  end if;

  select * into v_batch from origin_sync.batch_inbox where batch_id = p_batch_id;
  if found then
    if v_batch.resource <> p_resource or v_batch.entity <> p_entity or v_batch.request_hash <> v_request_hash
       or v_batch.owner <> p_owner or v_batch.lease_token <> p_lease_token then
      raise exception 'batch_id_reused_with_different_request' using errcode = '22023';
    end if;
    -- Retry pós-commit funciona mesmo se a lease já venceu; nada é reexecutado.
    return v_batch.result || jsonb_build_object('replayed', true);
  end if;
  -- Cursores diferentes podem atualizar a mesma entidade/ID; serializar a escrita
  -- canônica entre eles. Colisões de hash somente serializam entidades adicionais.
  perform pg_advisory_xact_lock(174852901, hashtext(p_entity));
  v_now := clock_timestamp();
  if v_state.lease_owner is distinct from p_owner
     or v_state.lease_token is distinct from p_lease_token
     or v_state.lease_expires_at is null or v_state.lease_expires_at <= v_now then
    raise exception 'lease_not_owned_or_expired' using errcode = '55000';
  end if;
  if v_state.checkpoint_version <> p_expected_checkpoint_version then
    raise exception 'checkpoint_version_conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_records) as entry(item)
    group by item ->> 'source_id' having count(*) > 1
  ) then
    raise exception 'duplicate_source_id_in_batch' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_records)
  loop
    if jsonb_typeof(v_item) <> 'object' or not (v_item ? 'source_id')
       or jsonb_typeof(v_item -> 'source_id') <> 'string'
       or not (v_item ? 'payload') or jsonb_typeof(v_item -> 'payload') <> 'object' then
      raise exception 'invalid_record_shape' using errcode = '22023';
    end if;
    v_source_id := v_item ->> 'source_id';
    if length(v_source_id) < 1 or length(v_source_id) > 200 or v_source_id <> btrim(v_source_id) then
      raise exception 'invalid_source_id' using errcode = '22023';
    end if;
    v_links := coalesce(v_item -> 'document_links', '[]'::jsonb);
    if jsonb_typeof(v_links) <> 'array' then
      raise exception 'invalid_document_links' using errcode = '22023';
    end if;
    if v_item ? 'source_updated_at' and v_item -> 'source_updated_at' <> 'null'::jsonb
       and jsonb_typeof(v_item -> 'source_updated_at') <> 'string' then
      raise exception 'invalid_source_updated_at' using errcode = '22023';
    end if;
    v_source_updated_at := (v_item ->> 'source_updated_at')::timestamptz;
    if v_source_updated_at is not null and not isfinite(v_source_updated_at) then
      raise exception 'invalid_source_updated_at' using errcode = '22023';
    end if;
    v_hash := encode(sha256(convert_to(jsonb_build_object(
      'payload', v_item -> 'payload', 'document_links', v_links
    )::text, 'UTF8')), 'hex');
    select * into v_existing from origin_sync.raw_record
    where entity = p_entity and source_id = v_source_id;
    if not found then
      insert into origin_sync.raw_record (
        entity, last_resource, source_id, payload, document_links, version_hash,
        source_updated_at, first_seen_at, last_seen_at, changed_at
      ) values (
        p_entity, p_resource, v_source_id, v_item -> 'payload', v_links, v_hash,
        v_source_updated_at, v_now, v_now, v_now
      );
      v_inserted := v_inserted + 1;
    elsif v_source_updated_at is not null and v_existing.source_updated_at is not null
          and v_source_updated_at < v_existing.source_updated_at then
      update origin_sync.raw_record set last_seen_at = v_now
      where entity = p_entity and source_id = v_source_id;
      v_stale := v_stale + 1;
    elsif v_existing.version_hash = v_hash then
      update origin_sync.raw_record
      set last_resource = p_resource, last_seen_at = v_now,
          source_updated_at = coalesce(v_source_updated_at, source_updated_at)
      where entity = p_entity and source_id = v_source_id;
      v_unchanged := v_unchanged + 1;
    else
      update origin_sync.raw_record
      set last_resource = p_resource, payload = v_item -> 'payload', document_links = v_links, version_hash = v_hash,
          version = version + 1, source_updated_at = coalesce(v_source_updated_at, source_updated_at),
          last_seen_at = v_now, changed_at = v_now
      where entity = p_entity and source_id = v_source_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  -- Não concluir lote cuja lease venceu durante o processamento.
  if v_state.lease_expires_at <= clock_timestamp() then
    raise exception 'lease_expired_during_batch' using errcode = '55000';
  end if;
  update origin_sync.resource_state
  set checkpoint = p_checkpoint, checkpoint_version = checkpoint_version + 1, updated_at = clock_timestamp()
  where resource = p_resource;
  v_result := jsonb_build_object(
    'batch_id', p_batch_id, 'inserted', v_inserted, 'updated', v_updated,
    'unchanged', v_unchanged, 'stale', v_stale,
    'checkpoint_version', v_state.checkpoint_version + 1, 'replayed', false
  );
  insert into origin_sync.batch_inbox (
    batch_id, resource, entity, owner, lease_token, request_hash,
    checkpoint_before, checkpoint_after, result
  ) values (
    p_batch_id, p_resource, p_entity, p_owner, p_lease_token, v_request_hash,
    v_state.checkpoint, p_checkpoint, v_result
  );
  return v_result;
end;
$$;

-- Nunca conceder EXECUTE por default a PUBLIC, anon ou authenticated.
revoke all on function public.origin_sync_claim(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.origin_sync_renew(text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.origin_sync_release(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.origin_sync_get_credentials() from public, anon, authenticated;
revoke all on function public.origin_sync_status() from public, anon, authenticated;
revoke all on function public.origin_sync_put_credentials(jsonb, timestamptz, bigint, uuid, uuid) from public, anon, authenticated;
revoke all on function public.origin_sync_create_oauth_state(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.origin_sync_consume_oauth_state(text, text) from public, anon, authenticated;
revoke all on function public.origin_sync_apply_batch(text, text, uuid, uuid, uuid, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.origin_sync_claim(text, uuid, integer) to service_role;
grant execute on function public.origin_sync_renew(text, uuid, uuid, integer) to service_role;
grant execute on function public.origin_sync_release(text, uuid, uuid) to service_role;
grant execute on function public.origin_sync_get_credentials() to service_role;
grant execute on function public.origin_sync_status() to service_role;
grant execute on function public.origin_sync_put_credentials(jsonb, timestamptz, bigint, uuid, uuid) to service_role;
grant execute on function public.origin_sync_create_oauth_state(text, text, timestamptz) to service_role;
grant execute on function public.origin_sync_consume_oauth_state(text, text) to service_role;
grant execute on function public.origin_sync_apply_batch(text, text, uuid, uuid, uuid, jsonb, jsonb, bigint) to service_role;

comment on schema origin_sync is 'Staging privado e somente leitura da origem Origin; não é domínio financeiro/fiscal do ERP.';
comment on table origin_sync.credentials is 'Envelope cifrado pelo Worker; não armazenar tokens OAuth em texto claro.';
comment on table origin_sync.raw_record is 'Retrato mais recente por entidade/ID, compartilhado entre cursores; hash e versão sem efeitos no ERP.';
comment on table origin_sync.batch_inbox is 'Ledger idempotente de requisições exatas; checkpoint e registros no mesmo commit.';

-- Novas tabelas criadas por este mesmo papel neste schema continuam privadas.
alter default privileges in schema origin_sync revoke all on tables from public, anon, authenticated, service_role;

commit;
