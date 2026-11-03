-- Preservação privada do backup; nenhuma escrita no ERP ou no staging da API.
begin;

create schema origin_backup;
revoke all on schema origin_backup from public, anon, authenticated;

create table origin_backup.batch (
  backup_sha text primary key check (backup_sha ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  status text not null default 'uploading' check (status in ('uploading', 'stored', 'stored_with_issues')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- kind=file preserva cada ocorrência física, inclusive paths ZIP repetidos.
-- kind=csv preserva posição/strings; source_id é evidência, não chave de merge.
-- kind=xml preserva metadados estruturais; não afirma validade fiscal/assinatura.
create table origin_backup.record (
  backup_sha text not null references origin_backup.batch(backup_sha),
  kind text not null check (kind in ('file', 'csv', 'xml', 'issue')),
  file_id text not null check (file_id ~ '^[0-9a-f]{64}$'),
  record_no integer not null check (record_no between 0 and 1000000),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  primary key (backup_sha, kind, file_id, record_no)
);
create index backup_csv_source on origin_backup.record ((data ->> 'entity'), (data ->> 'source_id')) where kind = 'csv';
create index backup_xml_key on origin_backup.record ((data ->> 'model'), (data ->> 'environment'), (data ->> 'key')) where kind = 'xml';
create index backup_xml_event on origin_backup.record ((data ->> 'event_id')) where kind = 'xml';

create table origin_backup.chunk (
  backup_sha text not null references origin_backup.batch(backup_sha),
  chunk_id text not null check (chunk_id ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('file', 'csv', 'xml', 'issue')),
  request_hash text not null,
  records integer not null,
  created_at timestamptz not null default now(),
  primary key (backup_sha, chunk_id)
);

alter table origin_backup.batch enable row level security;
alter table origin_backup.record enable row level security;
alter table origin_backup.chunk enable row level security;
revoke all on all tables in schema origin_backup from public, anon, authenticated, service_role;
alter default privileges in schema origin_backup revoke all on tables from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('origin-backups', 'origin-backups', false, 41943040,
  array['application/zip', 'application/xml', 'text/csv', 'application/octet-stream'])
on conflict (id) do nothing;
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'origin-backups' and public = false
      and file_size_limit >= 41943040) then
    raise exception 'backup_bucket_config_requires_review';
  end if;
end;
$$;
-- Nenhuma política de Storage para anon/authenticated é criada. A service_role
-- pode enviar os objetos; funções abaixo têm EXECUTE somente para esse papel.

create function public.origin_backup_begin(p_backup_sha text, p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_existing origin_backup.batch%rowtype;
  v_kind text;
begin
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$'
     or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or octet_length(p_manifest::text) > 65536
     or p_manifest ->> 'source_sha256' is distinct from p_backup_sha
     or p_manifest ->> 'format_version' is distinct from '1'
     or p_manifest -> 'operational_effects' is distinct from 'false'::jsonb
     or jsonb_typeof(p_manifest -> 'counts') is distinct from 'object'
     or coalesce(p_manifest ->> 'source_size', '') !~ '^[0-9]{1,9}$'
     or coalesce(p_manifest ->> 'object_count', '') !~ '^[0-9]{1,6}$' then
    raise exception 'invalid_backup_manifest' using errcode = '22023';
  end if;
  if (p_manifest ->> 'source_size')::bigint not between 1 and 41943040
     or (p_manifest ->> 'object_count')::integer not between 1 and 25001 then
    raise exception 'backup_manifest_size_limit' using errcode = '22023';
  end if;
  foreach v_kind in array array['file', 'csv', 'xml', 'issue'] loop
    if coalesce(p_manifest -> 'counts' ->> v_kind, '') !~ '^[0-9]{1,7}$'
       or (p_manifest -> 'counts' ->> v_kind)::bigint > 1000000 then
      raise exception 'invalid_backup_expected_counts' using errcode = '22023';
    end if;
  end loop;
  if not exists (select 1 from storage.buckets where id = 'origin-backups' and public = false) then
    raise exception 'private_backup_bucket_required';
  end if;
  perform pg_advisory_xact_lock(174852903, hashtext(p_backup_sha));
  select * into v_existing from origin_backup.batch where backup_sha = p_backup_sha for update;
  if found then
    if v_existing.manifest <> p_manifest then
      raise exception 'immutable_backup_manifest_conflict' using errcode = '22023';
    end if;
    return jsonb_build_object('status', v_existing.status, 'replayed', true);
  end if;
  insert into origin_backup.batch (backup_sha, manifest) values (p_backup_sha, p_manifest);
  return jsonb_build_object('status', 'uploading', 'replayed', false);
end;
$$;

create function public.origin_backup_apply_chunk(p_backup_sha text, p_kind text, p_chunk_id text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_batch origin_backup.batch%rowtype;
  v_chunk origin_backup.chunk%rowtype;
  v_item jsonb;
  v_existing jsonb;
  v_request_hash text;
  v_file_id text;
  v_number integer;
  v_inserted integer := 0;
begin
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$'
     or p_kind is null or p_kind not in ('file', 'csv', 'xml', 'issue')
     or p_chunk_id is null or p_chunk_id !~ '^[0-9a-f]{64}$'
     or p_records is null or jsonb_typeof(p_records) <> 'array'
     or jsonb_array_length(p_records) not between 1 and 250
     or octet_length(p_records::text) > 4194304 then
    raise exception 'invalid_backup_chunk' using errcode = '22023';
  end if;
  select * into v_batch from origin_backup.batch where backup_sha = p_backup_sha for update;
  if not found then raise exception 'backup_not_started'; end if;
  v_request_hash := encode(sha256(convert_to(p_records::text, 'UTF8')), 'hex');
  select * into v_chunk from origin_backup.chunk where backup_sha = p_backup_sha and chunk_id = p_chunk_id;
  if found then
    if v_chunk.kind <> p_kind or v_chunk.request_hash <> v_request_hash then
      raise exception 'immutable_backup_chunk_conflict' using errcode = '22023';
    end if;
    return jsonb_build_object('replayed', true, 'records', v_chunk.records);
  end if;
  if v_batch.status <> 'uploading' then raise exception 'backup_already_finished'; end if;
  for v_item in select value from jsonb_array_elements(p_records) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'data') is distinct from 'object'
       or coalesce(v_item ->> 'file_id', '') !~ '^[0-9a-f]{64}$'
       or coalesce(v_item ->> 'record_no', '') !~ '^[0-9]{1,7}$' then
      raise exception 'invalid_backup_record' using errcode = '22023';
    end if;
    v_file_id := v_item ->> 'file_id';
    v_number := (v_item ->> 'record_no')::integer;
    if v_number > 1000000 or (p_kind in ('file', 'xml') and v_number <> 0)
       or (p_kind in ('csv', 'issue') and v_number = 0) then
      raise exception 'invalid_backup_record_position' using errcode = '22023';
    end if;
    if p_kind = 'file' then
      if coalesce(v_item -> 'data' ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
         or coalesce(v_item -> 'data' ->> 'object_key', '') !~ '^objects/[0-9a-f]{64}\.(zip|csv|xml|bin)$'
         or coalesce(v_item -> 'data' ->> 'size', '') !~ '^[0-9]{1,9}$'
         or (v_item -> 'data' ->> 'size')::bigint > 134217728
         or coalesce(v_item -> 'data' ->> 'object_sha256', '') !~ '^[0-9a-f]{64}$'
         or coalesce(v_item -> 'data' ->> 'object_size', '') !~ '^[0-9]{1,9}$'
         or (v_item -> 'data' ->> 'object_size')::bigint > 41943040
         or coalesce(v_item -> 'data' ->> 'storage_representation', '') not in ('object', 'container_original') then
        raise exception 'invalid_backup_file' using errcode = '22023';
      end if;
      if substring(v_item -> 'data' ->> 'object_key' from 9 for 64) <> v_item -> 'data' ->> 'object_sha256'
         or ((v_item -> 'data' ->> 'storage_representation') = 'object' and
            ((v_item -> 'data' ->> 'sha256') <> (v_item -> 'data' ->> 'object_sha256')
             or (v_item -> 'data' ->> 'size')::bigint <> (v_item -> 'data' ->> 'object_size')::bigint))
         or ((v_item -> 'data' ->> 'storage_representation') = 'container_original' and
             (v_item -> 'data' ->> 'object_sha256') <> p_backup_sha) then
        raise exception 'backup_object_reference_mismatch' using errcode = '22023';
      end if;
    elsif not exists (select 1 from origin_backup.record where backup_sha = p_backup_sha and kind = 'file' and file_id = v_file_id and record_no = 0) then
      raise exception 'backup_source_file_missing';
    end if;
    if p_kind = 'csv' and (
      jsonb_typeof(v_item -> 'data' -> 'payload') is distinct from 'object'
      or coalesce(v_item -> 'data' ->> 'entity', '') not in ('contacts', 'products', 'purchase_orders', 'sales_orders', 'cash_movements', 'receivables', 'payables', 'stock_snapshot')
    ) then raise exception 'invalid_backup_csv_payload' using errcode = '22023'; end if;
    if p_kind = 'csv' and exists (select 1 from jsonb_each(v_item -> 'data' -> 'payload') p where jsonb_typeof(p.value) <> 'string') then
      raise exception 'backup_csv_values_must_remain_text' using errcode = '22023';
    end if;
    if p_kind = 'xml' and (
      v_item -> 'data' ->> 'validation' is distinct from 'structural_only'
      or v_item -> 'data' -> 'signature_verified' is distinct from 'false'::jsonb
      or v_item -> 'data' -> 'xsd_validated' is distinct from 'false'::jsonb
    ) then raise exception 'invalid_backup_xml_validation_claim' using errcode = '22023'; end if;
    select data into v_existing from origin_backup.record
    where backup_sha = p_backup_sha and kind = p_kind and file_id = v_file_id and record_no = v_number;
    if found then
      if v_existing <> (v_item -> 'data') then
        raise exception 'immutable_backup_record_conflict' using errcode = '22023';
      end if;
    else
      insert into origin_backup.record (backup_sha, kind, file_id, record_no, data)
      values (p_backup_sha, p_kind, v_file_id, v_number, v_item -> 'data');
      v_inserted := v_inserted + 1;
    end if;
  end loop;
  if (select count(*) from origin_backup.record where backup_sha = p_backup_sha and kind = p_kind)
     > (v_batch.manifest -> 'counts' ->> p_kind)::bigint then
    raise exception 'backup_expected_count_exceeded';
  end if;
  insert into origin_backup.chunk (backup_sha, chunk_id, kind, request_hash, records)
  values (p_backup_sha, p_chunk_id, p_kind, v_request_hash, jsonb_array_length(p_records));
  return jsonb_build_object('replayed', false, 'records', jsonb_array_length(p_records), 'inserted', v_inserted);
end;
$$;

create function public.origin_backup_finish(p_backup_sha text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare
  v_batch origin_backup.batch%rowtype;
  v_kind text;
  v_count bigint;
  v_status text;
begin
  select * into v_batch from origin_backup.batch where backup_sha = p_backup_sha for update;
  if not found then raise exception 'backup_not_started'; end if;
  foreach v_kind in array array['file', 'csv', 'xml', 'issue'] loop
    select count(*) into v_count from origin_backup.record where backup_sha = p_backup_sha and kind = v_kind;
    if v_count <> (v_batch.manifest -> 'counts' ->> v_kind)::bigint then
      raise exception 'backup_expected_count_mismatch';
    end if;
  end loop;
  if not exists (select 1 from storage.buckets where id = 'origin-backups' and public = false) then
    raise exception 'private_backup_bucket_required';
  end if;
  if exists (
    select 1 from origin_backup.record r where r.backup_sha = p_backup_sha and r.kind = 'file'
    and not exists (select 1 from storage.objects o where o.bucket_id = 'origin-backups' and o.name = r.data ->> 'object_key')
  ) then raise exception 'backup_storage_object_missing'; end if;
  if (select count(distinct data ->> 'object_key') from origin_backup.record where backup_sha = p_backup_sha and kind = 'file')
      <> (v_batch.manifest ->> 'object_count')::integer then
    raise exception 'backup_object_count_mismatch';
  end if;
  v_status := case when (v_batch.manifest -> 'counts' ->> 'issue')::integer > 0 then 'stored_with_issues' else 'stored' end;
  update origin_backup.batch set status = v_status, finished_at = coalesce(finished_at, now()) where backup_sha = p_backup_sha;
  return jsonb_build_object('status', v_status, 'operational_effects', false);
end;
$$;

revoke all on function public.origin_backup_begin(text, jsonb) from public, anon, authenticated;
revoke all on function public.origin_backup_apply_chunk(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.origin_backup_finish(text) from public, anon, authenticated;
grant execute on function public.origin_backup_begin(text, jsonb) to service_role;
grant execute on function public.origin_backup_apply_chunk(text, text, text, jsonb) to service_role;
grant execute on function public.origin_backup_finish(text) to service_role;

commit;
