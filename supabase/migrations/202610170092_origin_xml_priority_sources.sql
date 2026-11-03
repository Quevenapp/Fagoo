-- Read-only inspection for a private, finite XML selection. Existing collection RPCs remain unchanged.
begin;
create function public.origin_sync_xml_priority_sources(p_owner uuid,p_lease_token uuid,p_candidates jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
set lock_timeout='750ms' set statement_timeout='5s' as $$
declare v_result jsonb;
begin
 if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates) not between 1 and 50
  or octet_length(p_candidates::text)>131072 then raise exception 'invalid_xml_priority_candidates' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_candidates) x where jsonb_typeof(x)<>'object'
  or (select count(*) from jsonb_object_keys(x))<>4 or not(x ?& array['entity','source_id','key','fingerprint'])
  or jsonb_typeof(x->'entity') is distinct from 'string' or x->>'entity' not in('nfe','nfce')
  or jsonb_typeof(x->'source_id') is distinct from 'string' or x->>'source_id' !~ '^[0-9]{1,40}$'
  or jsonb_typeof(x->'key') is distinct from 'string' or x->>'key' !~ '^[0-9]{44}$'
  or substring(x->>'key',21,2) is distinct from case x->>'entity' when 'nfe' then '55' else '65' end
  or jsonb_typeof(x->'fingerprint') is distinct from 'string' or x->>'fingerprint' !~ '^[0-9a-f]{64}$')
  or (select count(distinct (x->>'entity',x->>'source_id')) from jsonb_array_elements(p_candidates) x)<>jsonb_array_length(p_candidates)
 then raise exception 'invalid_xml_priority_candidates' using errcode='22023';end if;
 -- Do not wait for DDL or a competing lease transition. All acquired locks are read locks.
 lock table origin_sync.resource_state,origin_sync.raw_record,origin_fiscal.source,origin_fiscal.attempt,
  origin_fiscal.revision,origin_fiscal.item,origin_fiscal.object,storage.buckets,storage.objects in access share mode nowait;
 perform 1 from origin_sync.resource_state where resource='__scheduler__' for share nowait;
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 with requested as (
  select x->>'entity' entity,x->>'source_id' source_id,x->>'key' key,x->>'fingerprint' fingerprint,ordinality ord
  from jsonb_array_elements(p_candidates) with ordinality q(x,ordinality)
 ), base as (
  select q.*,r.entity is not null source_exists,
   case when r.entity is not null then origin_fiscal.fingerprint(r.payload) end current_fingerprint,
   coalesce(r.payload->>'chaveAcesso'=q.key and origin_fiscal.fingerprint(r.payload)=q.fingerprint,false) source_matches,
   s.id source_uuid,s.state,s.last_fingerprint,s.last_error,s.current_revision,s.next_attempt_at,
   a.id attempt_id,a.state attempt_state,a.fingerprint attempt_fingerprint,a.started_at,a.finished_at,a.error_code,a.result,a.manifest_hash
  from requested q left join origin_sync.raw_record r on r.entity=q.entity and r.source_id=q.source_id
  left join origin_fiscal.source s on s.entity=q.entity and s.source_id=q.source_id and s.access_key=q.key
  left join origin_fiscal.attempt a on a.id=s.current_attempt and a.source=s.id
 ), checked as (
  select b.*,coalesce(source_matches and last_fingerprint=fingerprint and attempt_fingerprint=fingerprint
   and state=attempt_state and finished_at is not null and finished_at>=started_at and (
    (state in('retry','blocked') and error_code ~ '^[A-Z][A-Z0-9_]{0,79}$' and last_error=error_code and next_attempt_at is not null)
    or (state='stored' and result->'stored'='true'::jsonb and jsonb_typeof(result->'files')='number'
     and result->>'files' ~ '^(?:[1-9]|10)$' and exists(
      select 1 from origin_fiscal.revision rv where rv.id=current_revision and rv.source=source_uuid
       and rv.id::text=result->>'revision_id' and rv.manifest_hash=b.manifest_hash
       and (select count(*) from origin_fiscal.item i where i.revision=rv.id)::text=result->>'files'
       and not exists(select 1 from origin_fiscal.item i left join origin_fiscal.object o on o.hash=i.object_hash
        left join storage.objects so on so.bucket_id='origin-fiscal-xml' and so.name='objects/'||o.hash||'.xml'
        where i.revision=rv.id and (o.hash is null or o.metadata->>'key' is distinct from b.key
         or o.metadata->>'model' is distinct from substring(b.key,21,2) or so.name is null
         or so.metadata->>'size' is distinct from o.size::text
         or coalesce(so.metadata->>'mimetype','') not in('application/xml','application/octet-stream')))
     ))),false) terminal_confirmed
  from base b
 )
 select jsonb_build_object('profile','origin-xml-priority-sources-v1','observed_at',clock_timestamp(),
  'items',coalesce(jsonb_agg(jsonb_build_object('entity',entity,'source_id',source_id,'key',key,'fingerprint',fingerprint,
   'source_exists',source_exists,'source_matches',source_matches,'current_fingerprint',current_fingerprint,
   'state',state,'attempt_id',attempt_id,'attempt_state',attempt_state,'attempt_fingerprint',attempt_fingerprint,
   'started_at',started_at,'finished_at',finished_at,'next_attempt_at',next_attempt_at,'error_code',error_code,
   'terminal_confirmed',terminal_confirmed,'stored_files',case when terminal_confirmed and state='stored' then (result->>'files')::integer else 0 end,
   'eligible',source_matches and (state='pending' or next_attempt_at is null or next_attempt_at<=clock_timestamp() or last_fingerprint is distinct from fingerprint)
  )order by ord),'[]'::jsonb)) into v_result from checked;
 perform origin_fiscal.storage_ready();perform origin_fiscal.require_scheduler(p_owner,p_lease_token);
 return v_result;
end; $$;
revoke all on function public.origin_sync_xml_priority_sources(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.origin_sync_xml_priority_sources(uuid,uuid,jsonb) to service_role;
commit;
