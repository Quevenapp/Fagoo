-- Directed GET recapture of current API sales only. No native or historical writes.
begin;
create schema origin_sales_price_refresh;
revoke all on schema origin_sales_price_refresh from public,anon,authenticated,service_role;
create table origin_sales_price_refresh.origin (
 source_id text primary key check(source_id~'^[1-9][0-9]{0,39}$'),current_attempt uuid,
 last_attempt_at timestamptz,last_success_at timestamptz,next_attempt_at timestamptz,
 failures integer not null default 0 check(failures between 0 and 1000000),last_error text
);
create table origin_sales_price_refresh.attempt (
 id uuid primary key,source_id text not null references origin_sales_price_refresh.origin(source_id),
 owner uuid not null,scheduler_fence uuid not null,resource_fence uuid not null,
 checkpoint jsonb not null check(jsonb_typeof(checkpoint)='object'),checkpoint_version bigint not null check(checkpoint_version>=0),
 source_hash text not null check(source_hash~'^[0-9a-f]{64}$'),source_version bigint not null check(source_version>0),source_seen_at timestamptz not null,
 document_links jsonb not null check(jsonb_typeof(document_links)='array'),source_updated_at timestamptz,
 state text not null default 'pending' check(state in('pending','stored','conflict','failed','superseded')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,response_hash text,error_code text,http_status integer,
 check((state='pending')=(finished_at is null))
);
alter table origin_sales_price_refresh.origin add foreign key(current_attempt) references origin_sales_price_refresh.attempt(id);
create table origin_sales_price_refresh.scope_state(singleton boolean primary key default true check(singleton),retry_after timestamptz);
insert into origin_sales_price_refresh.scope_state default values;
alter table origin_sales_price_refresh.origin enable row level security;
alter table origin_sales_price_refresh.attempt enable row level security;
alter table origin_sales_price_refresh.scope_state enable row level security;
revoke all on all tables in schema origin_sales_price_refresh from public,anon,authenticated,service_role;
create function origin_sales_price_refresh.immutable_attempt() returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if TG_OP='DELETE' or OLD.state<>'pending' or (to_jsonb(NEW)-array['state','finished_at','response_hash','error_code','http_status']) is distinct from (to_jsonb(OLD)-array['state','finished_at','response_hash','error_code','http_status'])
 then raise exception 'sales_price_attempt_immutable' using errcode='55000';end if;return NEW;
end;$$;
create trigger sales_price_attempt_immutable before update or delete on origin_sales_price_refresh.attempt for each row execute function origin_sales_price_refresh.immutable_attempt();
create function origin_sales_price_refresh.eligible(s origin_sync.raw_record) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(s.entity='sales_orders' and s.source_id~'^[1-9][0-9]{0,39}$'
 and origin_reference_fetch.exact_id(s.payload->'id')=s.source_id
 and not exists(select 1 from erp_sales_history.snapshot h where h.source_id=s.source_id)
 and erp_cutover.sales_capture(s)->>'state'<>'bound',false);
$$;
create function origin_sales_price_refresh.require_leases(p_owner uuid,p_scheduler uuid,p_resource uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$declare s origin_sync.resource_state;begin
 select * into s from origin_sync.resource_state where resource='__scheduler__' for update;
 if p_owner is null or p_scheduler is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_scheduler
 or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'sales_price_scheduler_required' using errcode='55000';end if;
 select * into s from origin_sync.resource_state where resource='sales_orders' for update;
 if p_resource is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_resource
 or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'sales_price_resource_required' using errcode='55000';end if;
end;$$;
create function public.origin_sync_sales_price_candidates(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_limit integer default 40)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare v jsonb;begin
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 if p_limit is null or p_limit not between 1 and 40 then raise exception 'sales_price_limit_invalid' using errcode='22023';end if;
 with page as(select s.*,o.last_attempt_at from origin_sync.raw_record s left join origin_sales_price_refresh.origin o using(source_id)
 where s.entity='sales_orders' and origin_sales_price_refresh.eligible(s)
 and (o.next_attempt_at is null or o.next_attempt_at<=clock_timestamp())
 and not exists(select 1 from origin_sales_price_refresh.scope_state where retry_after>clock_timestamp())
 order by o.last_attempt_at nulls first,s.source_id collate "C" limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'source_hash',version_hash,
 'source_version',version::text,'source_seen_at',last_seen_at)order by last_attempt_at nulls first,source_id collate "C"),'[]'::jsonb))into v from page;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);return v;
end;$$;
create function public.origin_sync_sales_price_begin(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,
 p_source_id text,p_source_hash text,p_source_version bigint,p_source_seen_at timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_sales_price_refresh.attempt;o origin_sales_price_refresh.origin;s origin_sync.raw_record;cp origin_sync.resource_state;begin
 if p_attempt_id is null or p_source_id is null or p_source_id!~'^[1-9][0-9]{0,39}$' or p_source_hash is null or p_source_hash!~'^[0-9a-f]{64}$'
 or p_source_version is null or p_source_version<1 or p_source_seen_at is null or not isfinite(p_source_seen_at)
 then raise exception 'sales_price_begin_invalid' using errcode='22023';end if;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_sales_price_refresh.attempt where id=p_attempt_id;
 if found then
  if a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token or a.source_id<>p_source_id
  or a.source_hash<>p_source_hash or a.source_version<>p_source_version or a.source_seen_at<>p_source_seen_at
  then raise exception 'sales_price_command_conflict' using errcode='40001';end if;
  return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',true);
 end if;
 if exists(select 1 from origin_sync.batch_inbox where batch_id=p_attempt_id)then raise exception 'sales_price_command_conflict' using errcode='40001';end if;
 -- Same order as078, then the083 source mutex BEFORE the raw row lock.
 perform pg_advisory_xact_lock(174852901,hashtext('sales_orders'));
 perform pg_advisory_xact_lock(174853084,hashtext(p_source_id));
 select * into s from origin_sync.raw_record where entity='sales_orders' and source_id=p_source_id for update;
 if not found or s.version_hash is distinct from p_source_hash or s.version is distinct from p_source_version
 or s.last_seen_at is distinct from p_source_seen_at or not origin_sales_price_refresh.eligible(s)
 then raise exception 'sales_price_source_changed' using errcode='40001';end if;
 if exists(select 1 from origin_sales_price_refresh.scope_state where retry_after>clock_timestamp())then raise exception 'sales_price_scope_backoff' using errcode='55000';end if;
 insert into origin_sales_price_refresh.origin(source_id)values(p_source_id)on conflict do nothing;
 select * into o from origin_sales_price_refresh.origin where source_id=p_source_id for update;
 if o.next_attempt_at>clock_timestamp()then raise exception 'sales_price_backoff' using errcode='55000';end if;
 select * into a from origin_sales_price_refresh.attempt where id=o.current_attempt;
 if found and a.state='pending' then
  -- Never repeat a GET on an uncertain attempt while its fences are still current.
  if a.owner=p_owner and a.scheduler_fence=p_lease_token and a.resource_fence=p_resource_token then raise exception 'sales_price_attempt_pending' using errcode='55000';end if;
  update origin_sales_price_refresh.attempt set state='superseded',finished_at=clock_timestamp() where id=a.id;
 end if;
 select * into cp from origin_sync.resource_state where resource='sales_orders';
 insert into origin_sales_price_refresh.attempt(id,source_id,owner,scheduler_fence,resource_fence,checkpoint,checkpoint_version,source_hash,source_version,source_seen_at,document_links,source_updated_at)
 values(p_attempt_id,p_source_id,p_owner,p_lease_token,p_resource_token,cp.checkpoint,cp.checkpoint_version,p_source_hash,p_source_version,p_source_seen_at,s.document_links,s.source_updated_at)returning * into a;
 update origin_sales_price_refresh.origin set current_attempt=a.id,last_attempt_at=a.started_at,next_attempt_at=a.started_at+interval '5 minutes'where source_id=p_source_id;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',false);
end;$$;
create function origin_sales_price_refresh.apply_attempt(a origin_sales_price_refresh.attempt,p_payload jsonb,p_capture jsonb) returns jsonb
language sql set search_path=pg_catalog as $$
 select public.origin_sync_apply_sales_price_batch('sales_orders','sales_orders',a.owner,a.resource_fence,a.id,
 jsonb_build_array(jsonb_build_object('source_id',a.source_id,'payload',p_payload,'document_links',a.document_links,'source_updated_at',a.source_updated_at,'price_capture',p_capture)),
 a.checkpoint,a.checkpoint_version);
$$;
create function public.origin_sync_sales_price_finish(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_payload jsonb,p_price_capture jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_sales_price_refresh.attempt;s origin_sync.raw_record;cp origin_sync.resource_state;h text;v jsonb;conflict boolean;begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>8388608 then raise exception 'sales_price_detail_invalid' using errcode='22023';end if;
 perform origin_sync.validate_sales_price_capture(p_payload,p_price_capture);
 h:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'capture',p_price_capture)::text,'UTF8')),'hex');
 select * into a from origin_sales_price_refresh.attempt where id=p_attempt_id;
 if not found or a.owner is distinct from p_owner or a.scheduler_fence is distinct from p_lease_token or a.resource_fence is distinct from p_resource_token
 then raise exception 'sales_price_attempt_missing' using errcode='55000';end if;
 if a.source_id is distinct from origin_reference_fetch.exact_id(p_payload->'id')then raise exception 'sales_price_response_identity' using errcode='22023';end if;
 if a.state='stored' then
  if a.response_hash<>h then raise exception 'sales_price_response_conflict' using errcode='40001';end if;
  return origin_sales_price_refresh.apply_attempt(a,p_payload,p_price_capture)||jsonb_build_object('stored',true,'conflict',false);
 end if;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_sales_price_refresh.attempt where id=p_attempt_id for update;
 if a.state in('stored','conflict')then
  if a.response_hash<>h then raise exception 'sales_price_response_conflict' using errcode='40001';end if;
  if a.state='stored' then return origin_sales_price_refresh.apply_attempt(a,p_payload,p_price_capture)||jsonb_build_object('stored',true,'conflict',false);end if;
  return jsonb_build_object('stored',false,'conflict',true,'replayed',true);
 end if;
 if a.state<>'pending' or not exists(select 1 from origin_sales_price_refresh.origin where source_id=a.source_id and current_attempt=a.id)
 then raise exception 'sales_price_attempt_stale' using errcode='55000';end if;
 perform pg_advisory_xact_lock(174852901,hashtext('sales_orders'));
 perform pg_advisory_xact_lock(174853084,hashtext(a.source_id));
 select * into s from origin_sync.raw_record where entity='sales_orders' and source_id=a.source_id for update;
 conflict:=not found or s.version_hash is distinct from a.source_hash or s.version is distinct from a.source_version
 or s.last_seen_at is distinct from a.source_seen_at or not origin_sales_price_refresh.eligible(s)
 or s.document_links is distinct from a.document_links or s.source_updated_at is distinct from a.source_updated_at;
 select * into cp from origin_sync.resource_state where resource='sales_orders';
 conflict:=conflict or cp.checkpoint_version<>a.checkpoint_version or cp.checkpoint<>a.checkpoint;
 if not conflict then
  v:=origin_sales_price_refresh.apply_attempt(a,p_payload,p_price_capture);
  if (v->>'inserted')::integer is distinct from 0 or (v->>'updated')::integer+(v->>'unchanged')::integer is distinct from 1 or (v->>'sales_price_captures')::integer is distinct from 1
  then raise exception 'sales_price_batch_unconfirmed' using errcode='55000';end if;
  v:=v||jsonb_build_object('stored',true,'conflict',false);
  select * into s from origin_sync.raw_record where entity='sales_orders' and source_id=a.source_id;
 else v:=jsonb_build_object('stored',false,'conflict',true,'replayed',false);end if;
 update origin_sales_price_refresh.attempt set state=case when conflict then 'conflict'else'stored'end,finished_at=clock_timestamp(),response_hash=h where id=a.id;
 update origin_sales_price_refresh.origin set last_success_at=case when conflict then last_success_at else clock_timestamp()end,
 next_attempt_at=case when conflict then clock_timestamp()+interval '5 minutes'when erp_cutover.sales_capture(s)->>'state'<>'bound' then clock_timestamp()+interval '24 hours'else null end,failures=case when conflict then failures else 0 end,
 last_error=case when conflict then 'SALES_PRICE_SOURCE_CHANGED'when erp_cutover.sales_capture(s)->>'state'<>'bound' then 'SALES_PRICE_OUTSIDE_READINESS_LIMIT'else null end where source_id=a.source_id;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);return v;
end;$$;
create function public.origin_sync_sales_price_fail(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_code text,p_http_status integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a origin_sales_price_refresh.attempt;n integer;delay integer;begin
 if p_code is null or p_code!~'^[A-Z][A-Z0-9_]{0,79}$'or(p_http_status is not null and p_http_status not between 100 and 599)
 then raise exception 'sales_price_failure_invalid' using errcode='22023';end if;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_sales_price_refresh.attempt where id=p_attempt_id for update;
 if not found or a.owner is distinct from p_owner or a.scheduler_fence is distinct from p_lease_token or a.resource_fence is distinct from p_resource_token
 then raise exception 'sales_price_attempt_missing' using errcode='55000';end if;
 if a.state in('stored','conflict','superseded')then return jsonb_build_object('recorded',false,'already_finished',true);end if;
 if a.state='failed' then
  if a.error_code<>p_code or a.http_status is distinct from p_http_status then raise exception 'sales_price_failure_conflict' using errcode='40001';end if;
  return jsonb_build_object('recorded',true,'already_finished',false);
 end if;
 select least(failures+1,1000000)into n from origin_sales_price_refresh.origin where source_id=a.source_id and current_attempt=a.id for update;
 if not found then raise exception 'sales_price_attempt_stale' using errcode='55000';end if;
 delay:=case when p_http_status in(403,404)then 86400 else least(86400,300*(2^least(n-1,8))::integer)end;
 update origin_sales_price_refresh.attempt set state='failed',finished_at=clock_timestamp(),error_code=p_code,http_status=p_http_status where id=a.id;
 update origin_sales_price_refresh.origin set failures=n,last_error=p_code,next_attempt_at=clock_timestamp()+make_interval(secs=>delay)where source_id=a.source_id;
 if p_http_status=403 then update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp()+interval '24 hours';end if;
 perform origin_sales_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('recorded',true,'already_finished',false);
end;$$;
-- Historical attempt lookup is independent of current leases. No finish/retry is performed.
create function public.origin_sync_sales_price_attempt(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare a origin_sales_price_refresh.attempt;receipt jsonb;begin
 if p_owner is null or p_lease_token is null or p_resource_token is null or p_attempt_id is null then raise exception 'sales_price_lookup_invalid' using errcode='22023';end if;
 select * into a from origin_sales_price_refresh.attempt where id=p_attempt_id;
 if not found then return jsonb_build_object('attempt_id',p_attempt_id,'state','missing','receipt',null);end if;
 if a.owner is distinct from p_owner or a.scheduler_fence is distinct from p_lease_token or a.resource_fence is distinct from p_resource_token
 then raise exception 'sales_price_attempt_missing' using errcode='55000';end if;
 if a.state='stored' then
  select result into receipt from origin_sync.batch_inbox where batch_id=a.id;
  if receipt is null then raise exception 'sales_price_receipt_missing' using errcode='55000';end if;
 end if;
 return jsonb_build_object('attempt_id',a.id,'state',a.state,'receipt',receipt);
end;$$;
create function public.origin_sync_sales_price_status()returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 with s as materialized(select r.*,exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id)historical,
 erp_cutover.sales_capture(r)->>'state'='bound'covered from origin_sync.raw_record r where r.entity='sales_orders'and r.source_id~'^[1-9][0-9]{0,39}$'and origin_reference_fetch.exact_id(r.payload->'id')=r.source_id)
 select jsonb_build_object('scope','current_api_sales_without_history','sources',(select count(*)from s),'excluded_historical',(select count(*)from s where historical),
 'bound_pending_history',(select count(*)from s where not historical and covered),'pending',(select count(*)from s where not historical and not covered),
 'backing_off',(select count(*)from s join origin_sales_price_refresh.origin o using(source_id)where not historical and not covered and o.next_attempt_at>statement_timestamp()),
 'retry_after',(select retry_after from origin_sales_price_refresh.scope_state),'last_success_at',(select max(last_success_at)from origin_sales_price_refresh.origin),
 'coverage_complete',false,'native_effects',false,'historical_writes',false);
$$;
revoke all on all functions in schema origin_sales_price_refresh from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_sales_price_candidates(uuid,uuid,uuid,integer),public.origin_sync_sales_price_begin(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz),
 public.origin_sync_sales_price_finish(uuid,uuid,uuid,uuid,jsonb,jsonb),public.origin_sync_sales_price_fail(uuid,uuid,uuid,uuid,text,integer),
 public.origin_sync_sales_price_attempt(uuid,uuid,uuid,uuid),public.origin_sync_sales_price_status()from public,anon,authenticated,service_role;
grant execute on function public.origin_sync_sales_price_candidates(uuid,uuid,uuid,integer),public.origin_sync_sales_price_begin(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz),
 public.origin_sync_sales_price_finish(uuid,uuid,uuid,uuid,jsonb,jsonb),public.origin_sync_sales_price_fail(uuid,uuid,uuid,uuid,text,integer),
 public.origin_sync_sales_price_attempt(uuid,uuid,uuid,uuid),public.origin_sync_sales_price_status()to service_role;
commit;
