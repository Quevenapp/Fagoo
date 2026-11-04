-- Repair uncertain indicator evidence before initial stock scans or daily refreshes.
-- The immutable old observation remains available; completing a valid new read
-- automatically removes this priority. Lease bounds and batch grouping remain.
begin;
create function erp_sync.browser_indicator_needs_review(p_kind text,p_task jsonb)returns boolean
language sql stable set search_path=pg_catalog as $$
 select case when p_kind='indicators'then coalesce((
  select o.finance and o.finance_label is null from erp_sync.indicator_observation o
  where o.entity=p_task->>'entity'and o.source_id=p_task->>'source_id'
  order by o.observed_at desc limit 1
 ),false)else false end
$$;
do $$
declare definition text; original text:=$old$order by case when candidate.last_completed_at is null then 0 else 1 end,$old$;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_review_priority_definition_changed';end if;
 execute replace(definition,original,$new$order by case when erp_sync.browser_indicator_needs_review(candidate.kind,candidate.task)then -1 when candidate.last_completed_at is null then 0 else 1 end,$new$);
end$$;
revoke all on function erp_sync.browser_indicator_needs_review(text,jsonb)from public,anon,authenticated,service_role;
commit;
