-- Reexames malsucedidos não devem impedir a primeira consulta das demais notas.
begin;
create or replace function public.origin_sync_xml_candidates(p_owner uuid,p_lease_token uuid,p_limit integer default 2)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_xml_limit' using errcode='22023';end if;
 with eligible as materialized (
  select r.entity,r.source_id,r.payload->>'chaveAcesso' key,origin_fiscal.fingerprint(r.payload) fingerprint,
   row_number() over(partition by r.entity order by greatest(a.started_at,s.last_checked_at) asc nulls first,r.source_id collate "C") lane
  from origin_sync.raw_record r
  left join origin_fiscal.source s on s.entity=r.entity and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso'
  left join origin_fiscal.attempt a on a.id=s.current_attempt and a.source=s.id
  where r.entity in('nfe','nfce') and r.source_id ~ '^[0-9]{1,40}$' and jsonb_typeof(r.payload->'chaveAcesso')='string'
   and r.payload->>'chaveAcesso' ~ '^[0-9]{44}$' and substring(r.payload->>'chaveAcesso',21,2)=case r.entity when 'nfe' then '55' else '65' end
   and (s.next_attempt_at is null or s.next_attempt_at<=clock_timestamp() or s.last_fingerprint is distinct from origin_fiscal.fingerprint(r.payload))
 ), page as (select * from eligible order by lane,entity limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('entity',entity,'source_id',source_id,'key',key,'fingerprint',fingerprint) order by lane,entity),'[]'::jsonb)) into result from page;
 return result;
end; $$;
revoke all on function public.origin_sync_xml_candidates(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.origin_sync_xml_candidates(uuid,uuid,integer) to service_role;
commit;
