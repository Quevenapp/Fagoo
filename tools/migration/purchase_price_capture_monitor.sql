-- Explicit administrator read, no RPC or automatic monitor. Captures are current observations.
begin isolation level repeatable read read only;
set local statement_timeout='15s';
set local search_path=pg_catalog;
set local timezone='UTC';
with source_totals as (
 select count(*) total from origin_sync.raw_record where entity='purchase_orders'
), sources as materialized (
 select version_hash,version,price_capture,last_seen_at from origin_sync.raw_record
 where entity='purchase_orders' order by source_id collate "C" limit 5000
), captures as (
 select *,price_capture->>'profile'='origin-purchase-price-json-v1'
  and price_capture->>'source'='detail' and price_capture->>'source_hash'=version_hash
  and price_capture->>'source_version'=version::text current_capture,
  erp_integration.safe_time(price_capture->>'observed_at') capture_observed_at
 from sources
), receipt_totals as (
 select count(*) total from origin_sync.batch_inbox where resource='purchase_orders' and entity='purchase_orders'
), receipts as materialized (
 select applied_at,result from origin_sync.batch_inbox where resource='purchase_orders' and entity='purchase_orders'
 order by applied_at desc,batch_id limit 1000
), scheduler as (
 select checkpoint->'lastRun' last_run from origin_sync.resource_state where resource='__scheduler__'
), last_errors as (
 select e.value from scheduler s cross join lateral jsonb_array_elements(
  case when jsonb_typeof(s.last_run->'errors')='array' then s.last_run->'errors' else '[]'::jsonb end
 )with ordinality e(value,ordinal) where e.ordinal<=100
), purchase_errors as (
 select case when value->>'code' in(
  'ORIGIN_UNAUTHORIZED','ORIGIN_FORBIDDEN','ORIGIN_RATE_LIMITED','ORIGIN_NOT_FOUND','ORIGIN_SERVER_ERROR',
  'ORIGIN_NETWORK_ERROR','ORIGIN_TIMEOUT','ORIGIN_TIME_BUDGET_EXHAUSTED','ORIGIN_REQUEST_BUDGET_EXHAUSTED',
  'ORIGIN_INVALID_JSON','ORIGIN_INVALID_DATA','ORIGIN_INVALID_DATA_SHAPE','ORIGIN_INVALID_ID_NUMBER','ORIGIN_INVALID_SOURCE_ID','ORIGIN_UNSAFE_NUMBER','ORIGIN_PAGE_TIME_BUDGET',
  'ORIGIN_DUPLICATE_JSON_KEY','ORIGIN_PRICE_CAPTURE_UNAVAILABLE','ORIGIN_PRICE_TOKEN_LIMIT',
  'ORIGIN_RESPONSE_COMPLEXITY_LIMIT','ORIGIN_RESPONSE_SIZE_LIMIT','ORIGIN_REDIRECT_BLOCKED',
  'DATABASE_TIMEOUT','DATABASE_TIME_BUDGET','DATABASE_UNAVAILABLE','DATABASE_UNCERTAIN_RESULT',
  'DATABASE_INVALID_RESPONSE','DATABASE_RESPONSE_SIZE_LIMIT','DATABASE_REDIRECT_BLOCKED'
 )then value->>'code' else 'OTHER_SANITIZED_ERROR' end code
 from last_errors where value->>'resource'='purchase_orders'
), state as (
 select checkpoint_version,updated_at,lease_expires_at,checkpoint from origin_sync.resource_state where resource='purchase_orders'
)
select jsonb_build_object(
 'profile','origin-purchase-price-monitor-v1','observed_at',clock_timestamp(),'read_only',true,
 'runtime_configuration_known',false,'coverage_certified',false,'can_import',false,'native_effects',false,
 'rpc071_present',to_regprocedure('public.origin_sync_apply_purchase_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)')is not null,
 'source_observations',(select jsonb_build_object('total',(select total from source_totals),'inspected',count(*),'limit',5000,
  'truncated',(select total from source_totals)>5000,'current_capture',count(*)filter(where current_capture),
  'without_current_capture',count(*)filter(where current_capture is not true),'missing_capture',count(*)filter(where price_capture is null),
  'other_or_invalid_capture',count(*)filter(where price_capture is not null and current_capture is not true),
  'oldest_capture_observation',min(capture_observed_at)filter(where current_capture),'newest_capture_observation',max(capture_observed_at)filter(where current_capture),
  'oldest_source_observation',min(last_seen_at),'newest_source_observation',max(last_seen_at))from captures),
 'recent_committed_receipts',(select jsonb_build_object('total',(select total from receipt_totals),'inspected',count(*),'limit',1000,
  'truncated',(select total from receipt_totals)>1000,'with_purchase_capture_count',count(*)filter(where erp_integration.safe_count(result->'purchase_price_captures')between 1 and 100),
  'capture_observations_sum',coalesce(sum(erp_integration.safe_count(result->'purchase_price_captures'))filter(where erp_integration.safe_count(result->'purchase_price_captures')between 1 and 100),0),
  'oldest_committed_at',min(applied_at),'newest_committed_at',max(applied_at))from receipts),
 'resource_state',(select jsonb_build_object('checkpoint_version',checkpoint_version::text,'state_updated_at',updated_at,
  'lease_active',lease_expires_at>clock_timestamp(),'recent_completed_local',erp_integration.local_completion(checkpoint->>'recentCompletedAt'),
  'history_completed_local',erp_integration.local_completion(checkpoint->>'historyCompletedAt'))from state),
 'last_persisted_cycle',(select jsonb_build_object('summary',erp_integration.run_summary(last_run),
  'purchase_capture_count',case when last_run#>>'{purchase_price_capture,profile}'='origin-purchase-price-json-v1' then erp_integration.safe_count(last_run#>'{purchase_price_capture,records}')else null end,
  'errors_inspected',least(case when jsonb_typeof(last_run->'errors')='array' then jsonb_array_length(last_run->'errors')else 0 end,100),
  'errors_truncated',case when jsonb_typeof(last_run->'errors')='array' then jsonb_array_length(last_run->'errors')>100 else false end,
  'purchase_errors',(select coalesce(jsonb_agg(jsonb_build_object('code',code,'count',n)order by code),'[]'::jsonb)from(select code,count(*)n from purchase_errors group by code)e))from scheduler),
 'limitations',jsonb_build_array('current_capture_is_not_full_http_history','receipt_sum_counts_observations_not_distinct_sources',
  'last_cycle_only_no_durable_error_history','uncommitted_or_lost_scheduler_ack_not_in_last_cycle','checkpoint_completion_is_not_source_or_native_coverage')
)as report;
rollback;
