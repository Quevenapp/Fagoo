-- Alternate examination directions within each model without removing inputs.
begin;
create or replace function public.origin_sync_xml_candidates(p_owner uuid,p_lease_token uuid,p_limit integer default 2)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_xml_limit' using errcode='22023';end if;
 with base as materialized (
  select r.entity,r.source_id,r.payload->>'chaveAcesso' key,origin_fiscal.fingerprint(r.payload) fingerprint,
   case when jsonb_typeof(r.payload->'tipo') in('number','string') and r.payload->>'tipo' in('0','1')
    then r.payload->>'tipo' else 'unknown' end direction,
   greatest(a.started_at,s.last_checked_at) last_exam,s.next_attempt_at,s.last_fingerprint
  from origin_sync.raw_record r
  left join origin_fiscal.source s on s.entity=r.entity and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso'
  left join origin_fiscal.attempt a on a.id=s.current_attempt and a.source=s.id
  where r.entity in('nfe','nfce') and r.source_id ~ '^[0-9]{1,40}$' and jsonb_typeof(r.payload->'chaveAcesso')='string'
   and r.payload->>'chaveAcesso' ~ '^[0-9]{44}$' and substring(r.payload->>'chaveAcesso',21,2)=case r.entity when 'nfe' then '55' else '65' end
 ), activity as (
  -- Backoff rows still contribute activity; filtering them first would reset
  -- their direction's priority whenever a low-ID examination failed.
  select entity,direction,max(last_exam) last_activity from base group by entity,direction
 ), directions as (
  select entity,direction,row_number() over(partition by entity order by last_activity asc nulls first,direction collate "C") direction_rank from activity
 ), eligible as (
  select b.*,d.direction_rank,row_number() over(partition by b.entity,b.direction order by b.last_exam asc nulls first,b.source_id collate "C") inner_lane
  from base b join directions d using(entity,direction)
  where b.next_attempt_at is null or b.next_attempt_at<=clock_timestamp() or b.last_fingerprint is distinct from b.fingerprint
 ), lanes as (
  select *,row_number() over(partition by entity order by inner_lane,direction_rank) lane from eligible
 ), page as (select * from lanes order by lane,entity limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('entity',entity,'source_id',source_id,'key',key,'fingerprint',fingerprint) order by lane,entity),'[]'::jsonb)) into result from page;
 return result;
end; $$;
revoke all on function public.origin_sync_xml_candidates(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.origin_sync_xml_candidates(uuid,uuid,integer) to service_role;
commit;
