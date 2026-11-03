-- Administrative aggregate only. No IDs, names, amounts, payloads or automatic scheduling.
begin isolation level repeatable read read only;
set local statement_timeout='30s';
set local search_path=pg_catalog;
set local timezone='UTC';
with raw_totals as (
 select count(*) total from origin_sync.raw_record where entity='sales_orders'
), raw as materialized (
 select r.*,r.source_id~'^[1-9][0-9]{0,39}$'and origin_reference_fetch.exact_id(r.payload->'id')=r.source_id exact_id,
  exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id)historical,
  erp_cutover.sales_capture(r)->>'state'capture_state
 from origin_sync.raw_record r where entity='sales_orders'order by r.source_id collate "C" limit 20000
), leases as (
 select resource,lease_owner,lease_token,lease_expires_at from origin_sync.resource_state where resource in('__scheduler__','sales_orders')
), scope as (
 select retry_after,retry_after>statement_timestamp()backing_off from origin_sales_price_refresh.scope_state where singleton
), pending as materialized (
 select r.source_id,r.capture_state,o.last_attempt_at,o.next_attempt_at,o.last_success_at,o.failures,o.last_error,a.state,a.http_status,
  coalesce(a.state='pending'and exists(select 1 from leases s join leases t on t.resource='sales_orders'
   where s.resource='__scheduler__'and s.lease_owner=a.owner and t.lease_owner=a.owner
    and s.lease_token=a.scheduler_fence and t.lease_token=a.resource_fence
    and least(s.lease_expires_at,t.lease_expires_at)>statement_timestamp()),false)current_fences_live
 from raw r left join origin_sales_price_refresh.origin o using(source_id)
 left join origin_sales_price_refresh.attempt a on a.id=o.current_attempt
 where r.exact_id is true and not r.historical and r.capture_state<>'bound'
), attempt_total as (
 select count(*) total from origin_sales_price_refresh.attempt where started_at>=statement_timestamp()-interval'24hours'
), recent as materialized (
 select a.state,a.http_status,a.started_at,a.finished_at,a.error_code,b.batch_id is not null has_receipt,
  case when b.batch_id is not null then erp_integration.safe_count(b.result->'sales_price_captures')end capture_count
 from origin_sales_price_refresh.attempt a left join origin_sync.batch_inbox b on b.batch_id=a.id
 where a.started_at>=statement_timestamp()-interval'24hours'order by a.started_at desc,a.id limit 10000
), by_window as (
 select date_bin(interval'5minutes',started_at,timestamptz'2000-01-01')window_start,count(*) attempts,
  count(*)filter(where state='stored')stored,count(*)filter(where state='stored'and has_receipt and capture_count=1)stored_with_receipt,
  count(*)filter(where state='failed')failed,count(*)filter(where state='conflict')conflicts,
  count(*)filter(where state='pending')pending,count(*)filter(where state='superseded')superseded
 from recent group by 1 order by 1 desc limit 24
), last_cycle as (
 select checkpoint->'lastRun'v from origin_sync.resource_state where resource='__scheduler__'
)
select jsonb_build_object(
 'profile','sales-history-083-collection-diagnostic-v1','observed_at',statement_timestamp(),'read_only',true,
 'coverage_certified',false,'runtime_configuration_verified',false,'historical_writes',false,'native_effects',false,
 'sources',jsonb_build_object('total',(select total from raw_totals),'inspected',(select count(*)from raw),'limit',20000,
  'truncated',(select total from raw_totals)>20000,'exact_ids',(select count(*)from raw where exact_id is true),
  'invalid_identity',(select count(*)from raw where exact_id is not true),
  'preserved_current_sources',(select count(*)from raw where historical),'all_history_snapshots',(select count(*)from erp_sales_history.snapshot),
  'pending_bound',(select count(*)from raw where exact_id is true and not historical and capture_state='bound'),
  'pending_without_bound',(select count(*)from pending),
  'capture_counts',(select coalesce(jsonb_object_agg(capture_state,n),'{}')from(select capture_state,count(*)n from raw group by capture_state)c),
  'pending_capture_counts',(select coalesce(jsonb_object_agg(capture_state,n),'{}')from(select capture_state,count(*)n from pending group by capture_state)c)),
 'queue',jsonb_build_object(
  'scope_retry_after',(select retry_after from scope),'scope_backoff_active',coalesce((select backing_off from scope),false),
  'never_attempted',(select count(*)from pending where last_attempt_at is null),
  'attempted',(select count(*)from pending where last_attempt_at is not null),
  'source_backoff_active',(select count(*)from pending where next_attempt_at>statement_timestamp()),
  'candidate_filter_eligible',(select count(*)from pending where(next_attempt_at is null or next_attempt_at<=statement_timestamp())and not coalesce((select backing_off from scope),false)),
  'current_pending_live_fences',(select count(*)from pending where state='pending'and current_fences_live),
  'current_pending_stale_fences',(select count(*)from pending where state='pending'and not current_fences_live),
  'stored_still_not_bound',(select count(*)from pending where state='stored'),
  'current_attempt_states',(select coalesce(jsonb_object_agg(state,n),'{}')from(select coalesce(state,'none')state,count(*)n from pending group by 1)c),
  'backoff_reasons',(select coalesce(jsonb_agg(jsonb_build_object('code',code,'http_status',http_status,'count',n)order by code,http_status),'[]')from(
   select case when last_error is null then 'NO_RECORDED_ERROR'when last_error in('ORIGIN_UNAUTHORIZED','ORIGIN_FORBIDDEN','ORIGIN_NOT_FOUND','ORIGIN_RATE_LIMITED','ORIGIN_SERVER_ERROR','ORIGIN_HTTP_ERROR','ORIGIN_NETWORK_ERROR','ORIGIN_TIMEOUT','ORIGIN_TIME_BUDGET_EXHAUSTED','ORIGIN_REQUEST_BUDGET_EXHAUSTED','ORIGIN_RESPONSE_SIZE_LIMIT','ORIGIN_RESPONSE_COMPLEXITY_LIMIT','ORIGIN_UNSAFE_NUMBER','ORIGIN_INVALID_ID_NUMBER','ORIGIN_INVALID_JSON','ORIGIN_INVALID_RESPONSE','ORIGIN_INVALID_DATA_SHAPE','ORIGIN_REDIRECT_BLOCKED','SALES_PRICE_SOURCE_CHANGED','SALES_PRICE_OUTSIDE_READINESS_LIMIT','SALES_PRICE_PHASE_ENDED','SALES_PRICE_CAPTURE_REQUIRED','SALES_PRICE_DETAIL_IDENTITY_INVALID')then last_error else'OTHER_SANITIZED_ERROR'end code,http_status,count(*)n
   from pending where next_attempt_at>statement_timestamp()group by 1,2)x),
  'next_source_retry_at',(select min(next_attempt_at)from pending where next_attempt_at>statement_timestamp()),
  'last_directed_success_at',(select max(last_success_at)from origin_sales_price_refresh.origin)),
 'recent_attempts',jsonb_build_object('hours',24,'total',(select total from attempt_total),'inspected',(select count(*)from recent),'limit',10000,
  'truncated',(select total from attempt_total)>10000,'stored_without_matching_receipt',(select count(*)from recent where state='stored'and(not has_receipt or capture_count is distinct from 1)),
  'window_minutes',5,'returned_windows_limit',24,'windows',(select coalesce(jsonb_agg(to_jsonb(w)order by window_start),'[]')from by_window w)),
 'last_persisted_cycle',(select jsonb_build_object('summary',erp_integration.run_summary(v),
  'directed_status',case when v#>>'{sales_price_refresh,status}'in('completed','disabled','skipped_time','skipped_budget','already_running','partial')then v#>>'{sales_price_refresh,status}'else null end,
  'directed_attempted',erp_integration.safe_count(v#>'{sales_price_refresh,attempted}'),'directed_requests',erp_integration.safe_count(v#>'{sales_price_refresh,requests}'),
  'directed_stored',erp_integration.safe_count(v#>'{sales_price_refresh,stored}'),'directed_conflicts',erp_integration.safe_count(v#>'{sales_price_refresh,conflicts}'),
  'directed_recovered',erp_integration.safe_count(v#>'{sales_price_refresh,recovered}'),
  'directed_stop_json',case when jsonb_typeof(v#>'{sales_price_refresh,stop_json}')='boolean'then v#>'{sales_price_refresh,stop_json}'else null end,
  'normal_sales_captures',erp_integration.safe_count(v#>'{sales_price_capture,records}'))from last_cycle),
 'limitations',jsonb_build_array('absent_is_no_capture_metadata_not_missing_catalog','bound_is_numeric_itens_valor_provenance_only',
  'stored_counts_receipts_not_distinct_current_bound_sources','attempted_is_not_external_get_count','candidate_filter_is_not_a_claim_or_begin_authorization',
  'live_pending_fences_may_be_current_work_not_ack_loss','stale_pending_is_not_permission_to_resend','last_cycle_is_not_full_scheduler_history',
  'window_counts_use_attempt_start_not_snapshot_capture_time','last_error_is_origin_history_not_proof_of_current_attempt_failure',
  'no_backup_matching_or_global_coverage','historical_snapshots_are_never_updated')
)as report;
rollback;
