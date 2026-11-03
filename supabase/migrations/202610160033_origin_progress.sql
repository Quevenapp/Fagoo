-- Painel agregado, somente leitura. Não certifica migração nem expõe o status administrativo do Worker.
begin;
create schema erp_integration;
revoke all on schema erp_integration from public,anon,authenticated,service_role;

create function erp_integration.safe_count(v jsonb) returns bigint language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='number' and v::text ~ '^[0-9]{1,15}$' then v::text::bigint else null end;
$$;
create function erp_integration.safe_time(v text) returns timestamptz language plpgsql immutable set search_path=pg_catalog as $$
begin
 if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return null;end if;
 return v::timestamptz;
exception when others then return null;
end; $$;
create function erp_integration.local_completion(v text) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}( [0-9]{2}:[0-9]{2}:[0-9]{2})?$' then return null;end if;
 perform v::timestamp;
 return v;
exception when others then return null;
end; $$;
create function erp_integration.run_summary(v jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='object' then jsonb_build_object(
  'status',case when v->>'status' in('completed','partial','failed','skipped_time','skipped_budget') then v->>'status' else 'unknown' end,
  'started_at',erp_integration.safe_time(v->>'startedAt'),'finished_at',erp_integration.safe_time(v->>'finishedAt'),
  'pages',erp_integration.safe_count(v->'pages'),'records',erp_integration.safe_count(v->'records'),
  'requests',erp_integration.safe_count(v->'requests'),'attempted',erp_integration.safe_count(v->'attempted'),
  'stored',erp_integration.safe_count(v->'stored'),'files',erp_integration.safe_count(v->'files'),
  'error_count',case when jsonb_typeof(v->'errors')='array' then jsonb_array_length(v->'errors') else null end
 ) else null end;
$$;

create function public.erp_origin_progress(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_entities jsonb;v_resources jsonb;v_xml jsonb;v_finance jsonb;v_run jsonb;
begin
 if p_user_id is null or not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then
  raise exception 'erp_admin_required' using errcode='42501';end if;
 with names(entity) as (values('contacts'),('products'),('sales_orders'),('sales_proposals'),('purchase_orders'),
  ('receivables'),('payables'),('nfe'),('nfce'),('payment_methods'),('sellers')),
 counts as (select n.entity,count(r.source_id) records,min(r.last_seen_at) oldest_observation,max(r.last_seen_at) newest_observation
  from names n left join origin_sync.raw_record r on r.entity=n.entity group by n.entity)
 select jsonb_agg(to_jsonb(counts) order by entity) into v_entities from counts;

 with names(resource,entity,windowed) as (values
  ('contacts','contacts',true),('contacts_deleted','contacts',false),
  ('products_zero','products',true),('products_positive','products',true),('products_negative','products',true),
  ('products_deleted_zero','products',false),('products_deleted_positive','products',false),('products_deleted_negative','products',false),
  ('sales_orders','sales_orders',true),('sales_proposals','sales_proposals',true),('purchase_orders','purchase_orders',true),
  ('receivables','receivables',true),('payables','payables',true),
  ('nfe_in','nfe',true),('nfe_out','nfe',true),('nfe_in_cancelled','nfe',true),('nfe_out_cancelled','nfe',true),('nfce','nfce',true),
  ('payment_methods_active','payment_methods',false),('payment_methods_inactive','payment_methods',false),('sellers','sellers',true),('sellers_deleted','sellers',false))
 select jsonb_agg(jsonb_build_object('resource',n.resource,'entity',n.entity,'windowed',n.windowed,
  'checkpoint_present',coalesce(s.checkpoint_version>0,false),'state_updated_at',case when s.checkpoint_version>0 then s.updated_at else null end,
  'recent_completed_local',case when n.windowed then erp_integration.local_completion(s.checkpoint->>'recentCompletedAt') else null end,
  'history_completed_local',case when n.windowed then erp_integration.local_completion(s.checkpoint->>'historyCompletedAt') else null end,
  'sweep_completed_local',case when not n.windowed then erp_integration.local_completion(s.checkpoint->>'unfilteredCompletedAt') else null end,
  'recent_open',coalesce(n.windowed and jsonb_typeof(s.checkpoint->'recent')='object',false),
  'history_open',coalesce(n.windowed and jsonb_typeof(s.checkpoint->'history')='object',false),
  'sweep_open',coalesce(not n.windowed and jsonb_typeof(s.checkpoint->'unfiltered')='object',false)
 ) order by n.resource) into v_resources from names n left join origin_sync.resource_state s on s.resource=n.resource;

 -- Uma origem atual pode ter XML preservado e estar em nova tentativa: métricas não são parcelas de um percentual.
 with sources as (
  select r.entity,r.source_id,
   coalesce(r.source_id ~ '^[0-9]{1,40}$' and jsonb_typeof(r.payload->'chaveAcesso')='string'
    and r.payload->>'chaveAcesso' ~ '^[0-9]{44}$' and substring(r.payload->>'chaveAcesso',21,2)=case r.entity when 'nfe' then '55' else '65' end,false) eligible,
   s.current_revision,s.state,s.last_success_at,s.next_attempt_at
  from origin_sync.raw_record r left join origin_fiscal.source s on s.entity=r.entity and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso'
  where r.entity in('nfe','nfce')
 ) select jsonb_build_object('known_origins',count(*),'eligible_origins',count(*) filter(where eligible),
  'without_valid_key',count(*) filter(where not eligible),
  'with_preserved_revision',count(*) filter(where eligible and current_revision is not null),
  'without_preserved_revision',count(*) filter(where eligible and current_revision is null),
  'never_attempted',count(*) filter(where eligible and state is null),
  'retry_origins',count(*) filter(where eligible and state='retry'),'blocked_origins',count(*) filter(where eligible and state='blocked'),
  'backing_off',count(*) filter(where eligible and next_attempt_at>now()),'last_success_at',max(last_success_at),
  'preserved_objects',(select count(*) from origin_fiscal.object),'preserved_revisions',(select count(*) from origin_fiscal.revision),
  'validation','structural_only','authorization_verified',false) into v_xml from sources;

 with counts as (
  select e.entity,e.retry_after,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3')) known_open_partial,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3') and r.last_seen_at<=now()-interval '1 hour') observed_over_hour_ago,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3') and not origin_finance_refresh.usable_balance(r.payload)) unavailable_balance,
   min(r.last_seen_at) filter(where r.payload->>'situacao' in('1','3')) oldest_observation,
   max(o.last_success_at) last_success_at,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3') and o.next_attempt_at>now()) backing_off
  from origin_finance_refresh.entity_state e left join origin_sync.raw_record r on r.entity=e.entity
  left join origin_finance_refresh.origin o on o.entity=r.entity and o.source_id=r.source_id group by e.entity,e.retry_after
 ) select jsonb_agg(to_jsonb(counts) order by entity) into v_finance from counts;
 select checkpoint->'lastRun' into v_run from origin_sync.resource_state where resource='__scheduler__';
 return jsonb_build_object('data_mode','integration_progress_readonly','as_of',now(),'role','admin',
  'coverage_certified',false,'erp_mutations',false,'runtime_configuration_known',false,
  'entities',v_entities,'resources',v_resources,'last_run',erp_integration.run_summary(v_run),
  'last_xml_run',erp_integration.run_summary(v_run->'xml'),'last_finance_run',erp_integration.run_summary(v_run->'finance_refresh'),
  'xml',v_xml,'finance_refresh',jsonb_build_object('entities',v_finance,
   'reference_limits',jsonb_build_object('max_ids',8,'max_seconds',40,'max_attempts',24,'shared_requests',120,'observation_age_seconds',3600)));
end; $$;
revoke all on all functions in schema erp_integration from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_progress(uuid) from public,anon,authenticated;
grant execute on function public.erp_origin_progress(uuid) to service_role;
commit;
