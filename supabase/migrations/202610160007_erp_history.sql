-- Histórico fiscal preservado, independente do emissor e dos saldos operacionais.
-- Depende de 003 e 004. Nenhum grant de tabela ou Storage para o navegador.
begin;

create function erp_access.require_history_role(p_user_id uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id = p_user_id and active;
  if not found or v_role not in ('admin','consulta','fiscal') then
    raise exception 'erp_access_denied' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

create function public.erp_history_backups(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_result jsonb;
begin
  perform erp_access.require_history_role(p_user_id);
  select jsonb_build_object('items',coalesce(jsonb_agg(item order by created_at desc,backup_sha),'[]'::jsonb),'data_mode','backup_readonly')
  into v_result from (
    select b.created_at,b.backup_sha,jsonb_build_object(
      'id',b.backup_sha,'status',b.status,'created_at',b.created_at,'finished_at',b.finished_at,
      'xml_occurrences',coalesce((b.manifest #>> '{counts,xml}')::integer,0),
      'issues',coalesce((b.manifest #>> '{counts,issue}')::integer,0),
      'available',b.status in ('stored','stored_with_issues')
    ) item from origin_backup.batch b order by b.created_at desc,b.backup_sha limit 100
  ) batches;
  return v_result;
end;
$$;

create function public.erp_history_xml(
  p_user_id uuid,p_backup_sha text,p_limit integer default 25,p_offset integer default 0,
  p_query text default null,p_model text default null,p_kind text default null
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_result jsonb;
begin
  perform erp_access.require_history_role(p_user_id);
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or length(p_query)>64 or p_query ~ '[[:cntrl:]]'
    or (p_model is not null and p_model not in ('55','65'))
    or (p_kind is not null and p_kind not in ('invoice','event')) then
    raise exception 'erp_invalid_query' using errcode='22023';
  end if;
  if not exists(select 1 from origin_backup.batch where backup_sha=p_backup_sha and status in ('stored','stored_with_issues')) then
    raise exception 'erp_history_not_ready' using errcode='P0002';
  end if;
  with originals as materialized (
    select r.data->>'sha256' id,min(r.file_id) file_id,count(*) occurrences
    from origin_backup.record r where r.backup_sha=p_backup_sha and r.kind='xml'
      and r.data->>'sha256' ~ '^[0-9a-f]{64}$'
    group by r.data->>'sha256'
  ), summaries as materialized (
    select o.id,jsonb_build_object('id',o.id,'occurrences',o.occurrences,
      'key',erp_access.scalar_text(r.data->'key',44),'model',erp_access.scalar_text(r.data->'model',2),
      'environment',erp_access.scalar_text(r.data->'environment',1),'kind',erp_access.scalar_text(r.data->'kind',20),
      'protocol',erp_access.scalar_text(r.data->'protocol',20),
      'protocol_present',r.data->'protocol_present'='true'::jsonb,
      'signature_present',r.data->'signature_present'='true'::jsonb,
      'event_type',erp_access.scalar_text(r.data->'event_type',6),'sequence',erp_access.scalar_text(r.data->'sequence',6),
      'issues',coalesce((select jsonb_agg(code order by code) from (
        select distinct erp_access.scalar_text(i.data->'code',80) code
        from origin_backup.record i join origin_backup.record x
          on x.backup_sha=i.backup_sha and x.file_id=i.file_id and x.kind='xml'
        where i.backup_sha=p_backup_sha and i.kind='issue' and x.data->>'sha256'=o.id
      ) codes where code is not null),'[]'::jsonb),
      'validation','structural_only','signature_verified',false,'xsd_validated',false
    ) item from originals o join origin_backup.record r
      on r.backup_sha=p_backup_sha and r.kind='xml' and r.file_id=o.file_id and r.record_no=0
  ), filtered as materialized (
    select * from summaries where
      (nullif(btrim(p_query),'') is null or strpos(lower(concat_ws(' ',item->>'key',item->>'protocol')),lower(btrim(p_query)))>0)
      and (p_model is null or item->>'model'=p_model)
      and (p_kind is null or item->>'kind'=p_kind)
  ), page as (select * from filtered order by item->>'key' collate "C",id collate "C" limit p_limit offset p_offset)
  select jsonb_build_object('backup_id',p_backup_sha,'items',coalesce((select jsonb_agg(item order by item->>'key' collate "C",id collate "C") from page),'[]'::jsonb),
    'limit',p_limit,'offset',p_offset,'total',(select count(*) from filtered),
    'has_more',(select count(*) from filtered)>p_offset+p_limit,
    'next_offset',case when (select count(*) from filtered)>p_offset+p_limit then p_offset+p_limit end,
    'data_mode','backup_readonly') into v_result;
  return v_result;
end;
$$;

-- Retorna localização somente ao Worker autenticado. Nunca é resposta pública.
create function public.erp_history_xml_object(p_user_id uuid,p_backup_sha text,p_xml_sha text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_object jsonb;
begin
  perform erp_access.require_history_role(p_user_id);
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$' or p_xml_sha is null or p_xml_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'erp_invalid_query' using errcode='22023';
  end if;
  select jsonb_build_object('bucket','origin-backups','object_key',f.data->>'object_key',
    'sha256',p_xml_sha,'size',(f.data->>'object_size')::integer,
    'model',erp_access.scalar_text(x.data->'model',2)) into v_object
  from origin_backup.record x
  join origin_backup.record f on f.backup_sha=x.backup_sha and f.file_id=x.file_id and f.kind='file' and f.record_no=0
  join origin_backup.batch b on b.backup_sha=x.backup_sha and b.status in ('stored','stored_with_issues')
  join storage.buckets bucket on bucket.id='origin-backups' and bucket.public=false
  join storage.objects obj on obj.bucket_id=bucket.id and obj.name=f.data->>'object_key'
  where x.backup_sha=p_backup_sha and x.kind='xml' and x.data->>'sha256'=p_xml_sha
    and f.data->>'storage_representation'='object' and f.data->>'object_sha256'=p_xml_sha
    and f.data->>'object_key'='objects/'||p_xml_sha||'.xml'
    and (f.data->>'object_size')::bigint between 1 and 8388608
  order by x.file_id limit 1;
  if v_object is null then raise exception 'erp_history_not_found' using errcode='P0002'; end if;
  return v_object;
end;
$$;

revoke all on function erp_access.require_history_role(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_history_backups(uuid) from public,anon,authenticated;
revoke all on function public.erp_history_xml(uuid,text,integer,integer,text,text,text) from public,anon,authenticated;
revoke all on function public.erp_history_xml_object(uuid,text,text) from public,anon,authenticated;
grant execute on function public.erp_history_backups(uuid) to service_role;
grant execute on function public.erp_history_xml(uuid,text,integer,integer,text,text,text) to service_role;
grant execute on function public.erp_history_xml_object(uuid,text,text) to service_role;
commit;
