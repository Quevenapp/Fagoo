begin;
-- Global bounded leases, shared by all SaaS tabs/admins. A day batch cannot be
-- claimed twice while one of its anchors is being read in another slot.
create function erp_sync.browser_work_group(p_kind text,p_task jsonb)returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_kind='indicators'then 'I:'||(p_task->>'entity')||':'||(p_task->>'direction')||':'||(p_task->>'date')
 else 'H:'||(p_task->>'product_source_id')||':'||(p_task->>'warehouse_source_id')end
$$;
create index browser_job_live_groups on erp_sync.browser_job(erp_sync.browser_work_group(kind,task),claimed_at)where state='running';
do $$
declare definition text;original text;replacement text;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 original:=$old$if exists(select 1 from erp_sync.browser_job where state='running'and claimed_by=p_user_id and claimed_at>=now()-interval '5 minutes')then return jsonb_build_object('job',null);end if;$old$;
 replacement:=$new$if (select count(*)from erp_sync.browser_job where state='running'and claimed_at>=now()-interval '5 minutes')>=10 then return jsonb_build_object('job',null);end if;$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_parallel_limit_definition_changed';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$select * into j from erp_sync.browser_job where (state='pending' and due_at<=now())or(state='running' and claimed_at<now()-interval '5 minutes')or(state='done' and due_at<=now())$old$;
 replacement:=$new$select candidate.* into j from erp_sync.browser_job candidate where
  ((candidate.state='pending' and candidate.due_at<=now())or(candidate.state='running' and candidate.claimed_at<now()-interval '5 minutes')or(candidate.state='done' and candidate.due_at<=now()))
  and not exists(select 1 from erp_sync.browser_job live where live.state='running'and live.claimed_at>=now()-interval '5 minutes'
   and erp_sync.browser_work_group(live.kind,live.task)=erp_sync.browser_work_group(candidate.kind,candidate.task))$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_parallel_claim_definition_changed';end if;
 definition:=replace(definition,original,replacement);
 -- Initial work across either stage precedes daily refreshes. Fairness between
 -- indicators/history remains within that tier instead of refreshing old stock
 -- while an initial document scan has not yet been completed.
 original:=$old$order by case when kind<>coalesce((select b.kind from erp_sync.browser_job b where b.claimed_at is not null order by b.claimed_at desc,b.id desc limit 1),'indicators')then 0 else 1 end,
  case when last_completed_at is null then 0 else 1 end,case when error is null then 0 else 1 end,$old$;
 replacement:=$new$order by case when candidate.last_completed_at is null then 0 else 1 end,
  case when candidate.kind<>coalesce((select b.kind from erp_sync.browser_job b where b.claimed_at is not null order by b.claimed_at desc,b.id desc limit 1),'indicators')then 0 else 1 end,
  case when candidate.error is null then 0 else 1 end,$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_parallel_priority_definition_changed';end if;
 execute replace(definition,original,replacement);
end$$;
revoke all on function erp_sync.browser_work_group(text,jsonb)from public,anon,authenticated,service_role;
commit;
