-- Surface integration work separately from executable push/pull queues.
begin;
create function erp_sync.indicator_integration_gaps()returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 with latest as materialized(
  select distinct on(entity,source_id) entity,source_id,stock_flag,observed_at
  from erp_sync.indicator_observation order by entity,source_id,observed_at desc
 ),counts as(select count(*)records,count(*)filter(where stock_flag is not null)stock_records,max(observed_at)observed_at from latest)
 select case when records=0 then '[]'::jsonb else
  (case when stock_records=0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
   'code','STOCK_MOVEMENT_DETAIL_NOT_IMPLEMENTED','records',stock_records,'last_observed_at',observed_at,
   'state','implementation_pending','automatic_retry',false))end)
  ||jsonb_build_array(jsonb_build_object('code','STOCK_INDICATOR_REFRESH_ASSISTED','records',records,
   'last_observed_at',observed_at,'state','implementation_pending','automatic_retry',false))end
 from counts
$$;
create or replace function erp_sync.status_dto()returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('scope','origin_sync','enabled',erp_sync.enabled(),'actor_configured',erp_sync.actor() is not null,
  'push',jsonb_build_object('pending',(select count(*)from erp_sync.outbox where state in('pending','sending')),
   'failed',(select count(*)from erp_sync.outbox where state='failed'),
   'last_sent_at',(select max(finished_at)from erp_sync.outbox where state='done')),
  'pull',jsonb_build_object('pending',(select count(*)from erp_sync.inbox),
   'failed',(select count(*)from erp_sync.inbox where attempts>0),
   'last_applied_at',(select max(pulled_at)from erp_sync.link)),
  'issues',(select count(*)from erp_sync.issue where resolved_at is null),
  'recent_issues',(select coalesce(jsonb_agg(jsonb_build_object('at',created_at,'direction',direction,'entity',entity,
   'record_id',record_id,'source_id',source_id,'code',code,'detail',detail)order by created_at desc),'[]'::jsonb)
   from(select *from erp_sync.issue where resolved_at is null order by created_at desc limit 20)i),
  'run',(select jsonb_build_object('id',id,'state',state,'phase',phase,'requested_at',requested_at,'started_at',started_at,
   'finished_at',finished_at,'stats',stats,'error',error)from erp_sync.run order by requested_at desc limit 1),
  'integration_gaps',erp_sync.indicator_integration_gaps())
$$;
revoke all on function erp_sync.indicator_integration_gaps(),erp_sync.status_dto()from public,anon,authenticated,service_role;
commit;
