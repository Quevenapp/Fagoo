-- Amplia o staging para propostas comerciais e NFC-e, sem transformar dados do ERP.
-- A migração anterior já foi aplicada: não recriar tabelas, credenciais ou leases.
begin;

alter table origin_sync.raw_record drop constraint raw_record_entity_check;
alter table origin_sync.raw_record add constraint raw_record_entity_check check (entity in (
  'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe',
  'sales_proposals', 'nfce'
));

alter table origin_sync.batch_inbox drop constraint batch_inbox_entity_check;
alter table origin_sync.batch_inbox add constraint batch_inbox_entity_check check (entity in (
  'control', 'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe',
  'sales_proposals', 'nfce'
));

create or replace function public.origin_sync_status()
returns jsonb language sql stable security definer set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'connected', exists(select 1 from origin_sync.credentials where account_id = 1),
    'expires_at', (select expires_at from origin_sync.credentials where account_id = 1),
    'entities', (
      select jsonb_agg(jsonb_build_object('entity', counts.entity, 'records', counts.records) order by counts.entity)
      from (
        select e.entity, count(r.source_id) as records
        from unnest(array[
          'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe',
          'sales_proposals', 'nfce'
        ]) as e(entity)
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

create or replace function public.origin_sync_apply_batch(
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
    'control', 'contacts', 'products', 'sales_orders', 'purchase_orders', 'receivables', 'payables', 'nfe',
    'sales_proposals', 'nfce'
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

-- CREATE OR REPLACE preserva os ACLs; reafirmar o contrato service-only destas RPCs.
revoke all on function public.origin_sync_status() from public, anon, authenticated;
revoke all on function public.origin_sync_apply_batch(text, text, uuid, uuid, uuid, jsonb, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.origin_sync_status() to service_role;
grant execute on function public.origin_sync_apply_batch(text, text, uuid, uuid, uuid, jsonb, jsonb, bigint) to service_role;

commit;
