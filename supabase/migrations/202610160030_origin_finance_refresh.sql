-- Atualização dirigida de AP/AR conhecidos. Somente staging; nenhum lançamento ERP.
begin;
create schema origin_finance_refresh;
revoke all on schema origin_finance_refresh from public,anon,authenticated,service_role;

create table origin_finance_refresh.origin (
 entity text not null check(entity in('receivables','payables')),
 source_id text not null check(source_id ~ '^[0-9]{1,40}$' and source_id !~ '^0+$'),
 current_attempt uuid,last_attempt_at timestamptz,last_success_at timestamptz,
 next_attempt_at timestamptz,failures integer not null default 0 check(failures between 0 and 1000000),
 last_error text check(last_error ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 primary key(entity,source_id),foreign key(entity,source_id) references origin_sync.raw_record(entity,source_id)
);
create table origin_finance_refresh.attempt (
 id uuid primary key,entity text not null,source_id text not null,
 owner uuid not null,fence uuid not null,
 source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
 source_seen_at timestamptz not null,source_status text not null check(source_status in('1','3')),
 state text not null default 'pending' check(state in('pending','stored','conflict','failed','superseded')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 response_hash text,response_status text check(response_status in('1','2','3','4','5','6','7')),
 result_hash text,result_version bigint,result jsonb,error_code text,http_status integer,
 foreign key(entity,source_id) references origin_finance_refresh.origin(entity,source_id),
 check((state='pending' and finished_at is null) or (state<>'pending' and finished_at is not null))
);
alter table origin_finance_refresh.origin add foreign key(current_attempt) references origin_finance_refresh.attempt(id);
create table origin_finance_refresh.entity_state (
 entity text primary key check(entity in('receivables','payables')),
 retry_after timestamptz,last_error text
);
insert into origin_finance_refresh.entity_state(entity) values('receivables'),('payables');
create index finance_refresh_attempt_origin on origin_finance_refresh.attempt(entity,source_id,started_at desc);
create index finance_refresh_raw_candidates on origin_sync.raw_record(entity,last_seen_at,source_id)
 where entity in('receivables','payables') and payload->>'situacao' in('1','3');
alter table origin_finance_refresh.origin enable row level security;
alter table origin_finance_refresh.attempt enable row level security;
alter table origin_finance_refresh.entity_state enable row level security;
revoke all on all tables in schema origin_finance_refresh from public,anon,authenticated,service_role;

create function origin_finance_refresh.immutable_attempt() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' or OLD.state<>'pending' then raise exception 'immutable_finance_refresh_attempt' using errcode='55000';end if;
 return NEW;
end; $$;
create trigger finance_refresh_attempt_immutable before update or delete on origin_finance_refresh.attempt
 for each row execute function origin_finance_refresh.immutable_attempt();

-- Todas as mutações tomam primeiro a linha scheduler. A rede ocorre fora da transação.
create function origin_finance_refresh.require_scheduler(p_owner uuid,p_fence uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare s origin_sync.resource_state%rowtype;
begin
 select * into s from origin_sync.resource_state where resource='__scheduler__' for update;
 if not found or p_owner is null or p_fence is null or s.lease_owner is distinct from p_owner
  or s.lease_token is distinct from p_fence or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then
  raise exception 'finance_refresh_scheduler_required' using errcode='55000';end if;
end; $$;

create function origin_finance_refresh.usable_balance(p jsonb) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_typeof(p->'saldo')='number' and p->>'saldo' ~ '^[0-9]{1,14}(\.[0-9]{1,2})?$',false);
$$;

create function public.origin_sync_finance_refresh_candidates(
 p_owner uuid,p_lease_token uuid,p_limit integer default 8,p_stale_seconds integer default 3600
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_result jsonb;
begin
 perform origin_finance_refresh.require_scheduler(p_owner,p_lease_token);
 if p_limit is null or p_limit not between 1 and 8 or p_stale_seconds is null or p_stale_seconds not between 300 and 86400 then
  raise exception 'invalid_finance_refresh_limit' using errcode='22023';end if;
 with eligible as materialized (
  select r.entity,r.source_id,r.version_hash,r.last_seen_at,
   row_number() over(partition by r.entity order by greatest(r.last_seen_at,o.last_attempt_at),r.source_id collate "C") lane
  from origin_sync.raw_record r
  join origin_finance_refresh.entity_state e on e.entity=r.entity
  left join origin_finance_refresh.origin o on o.entity=r.entity and o.source_id=r.source_id
  where r.payload->>'situacao' in('1','3') and jsonb_typeof(r.payload->'situacao') in('number','string')
   and r.source_id ~ '^[0-9]{1,40}$' and r.source_id !~ '^0+$'
   and r.last_seen_at<=clock_timestamp()-make_interval(secs=>p_stale_seconds)
   and (e.retry_after is null or e.retry_after<=clock_timestamp())
   and (o.next_attempt_at is null or o.next_attempt_at<=clock_timestamp())
 ), page as (select * from eligible order by lane,entity limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
  'entity',entity,'source_id',source_id,'source_hash',version_hash,'source_seen_at',last_seen_at
 ) order by lane,entity),'[]'::jsonb)) into v_result from page;
 return v_result;
end; $$;

create function public.origin_sync_finance_refresh_begin(
 p_owner uuid,p_lease_token uuid,p_attempt_id uuid,p_entity text,p_source_id text,
 p_source_hash text,p_source_seen_at timestamptz,p_stale_seconds integer default 3600
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_finance_refresh.attempt%rowtype;o origin_finance_refresh.origin%rowtype;r origin_sync.raw_record%rowtype;
begin
 if p_attempt_id is null or p_entity is null or p_entity not in('receivables','payables')
  or p_source_id is null or p_source_id !~ '^[0-9]{1,40}$' or p_source_id ~ '^0+$'
  or p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' or p_source_seen_at is null or not isfinite(p_source_seen_at)
  or p_stale_seconds is null or p_stale_seconds not between 300 and 86400 then
  raise exception 'invalid_finance_refresh_begin' using errcode='22023';end if;
 perform origin_finance_refresh.require_scheduler(p_owner,p_lease_token);
 select * into a from origin_finance_refresh.attempt where id=p_attempt_id;
 if found then
  if a.owner is distinct from p_owner or a.fence is distinct from p_lease_token or a.entity<>p_entity or a.source_id<>p_source_id
   or a.source_hash<>p_source_hash or a.source_seen_at<>p_source_seen_at then raise exception 'finance_refresh_command_conflict' using errcode='40001';end if;
  return jsonb_build_object('attempt_id',a.id,'entity',a.entity,'source_id',a.source_id,'source_hash',a.source_hash,
   'source_seen_at',a.source_seen_at,'state',a.state,'replayed',true);
 end if;
 -- Mesmo advisory da 005: resource/scheduler -> entidade -> registro canônico.
 perform pg_advisory_xact_lock(174852901,hashtext(p_entity));
 select * into r from origin_sync.raw_record where entity=p_entity and source_id=p_source_id for update;
 if not found or r.version_hash<>p_source_hash or r.last_seen_at<>p_source_seen_at
  or coalesce(r.payload->>'situacao','') not in('1','3')
  or r.last_seen_at>clock_timestamp()-make_interval(secs=>p_stale_seconds) then
  raise exception 'finance_refresh_source_changed' using errcode='40001';end if;
 if exists(select 1 from origin_finance_refresh.entity_state where entity=p_entity and retry_after>clock_timestamp()) then
  raise exception 'finance_refresh_entity_backoff' using errcode='55000';end if;
 insert into origin_finance_refresh.origin(entity,source_id) values(p_entity,p_source_id) on conflict do nothing;
 select * into o from origin_finance_refresh.origin where entity=p_entity and source_id=p_source_id for update;
 if o.next_attempt_at>clock_timestamp() then raise exception 'finance_refresh_origin_backoff' using errcode='55000';end if;
 if o.current_attempt is not null then
  update origin_finance_refresh.attempt set state='superseded',finished_at=clock_timestamp()
   where id=o.current_attempt and state='pending';
 end if;
 insert into origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status)
 values(p_attempt_id,p_entity,p_source_id,p_owner,p_lease_token,p_source_hash,p_source_seen_at,r.payload->>'situacao') returning * into a;
 update origin_finance_refresh.origin set current_attempt=a.id,last_attempt_at=a.started_at,
  next_attempt_at=clock_timestamp()+interval '5 minutes' where entity=p_entity and source_id=p_source_id;
 return jsonb_build_object('attempt_id',a.id,'entity',a.entity,'source_id',a.source_id,'source_hash',a.source_hash,
  'source_seen_at',a.source_seen_at,'state',a.state,'replayed',false);
end; $$;

create function public.origin_sync_finance_refresh_finish(
 p_owner uuid,p_lease_token uuid,p_attempt_id uuid,p_payload jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_finance_refresh.attempt%rowtype;r origin_sync.raw_record%rowtype;
 v_response_hash text;v_hash text;v_result jsonb;v_now timestamptz;v_unchanged boolean;
begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>8388608
  or jsonb_typeof(p_payload->'id') not in('string','number') or coalesce(p_payload->>'id','') !~ '^[0-9]{1,40}$'
  or jsonb_typeof(p_payload->'situacao') not in('string','number') or coalesce(p_payload->>'situacao','') not in('1','2','3','4','5','6','7') then
  raise exception 'invalid_finance_refresh_detail' using errcode='22023';end if;
 v_response_hash:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 select * into a from origin_finance_refresh.attempt where id=p_attempt_id;
 if not found or a.owner is distinct from p_owner or a.fence is distinct from p_lease_token then
  raise exception 'finance_refresh_attempt_missing' using errcode='55000';end if;
 if a.source_id is distinct from p_payload->>'id' then raise exception 'finance_refresh_detail_identity' using errcode='22023';end if;
 if a.state in('stored','conflict') then
  if a.response_hash<>v_response_hash then raise exception 'finance_refresh_replay_conflict' using errcode='40001';end if;
  return a.result||jsonb_build_object('replayed',true);
 end if;
 perform origin_finance_refresh.require_scheduler(p_owner,p_lease_token);
 select * into a from origin_finance_refresh.attempt where id=p_attempt_id for update;
 -- Recheck after serialization: another call may have committed while we waited.
 if a.state in('stored','conflict') then
  if a.response_hash<>v_response_hash then raise exception 'finance_refresh_replay_conflict' using errcode='40001';end if;
  return a.result||jsonb_build_object('replayed',true);
 end if;
 if a.state<>'pending' or not exists(select 1 from origin_finance_refresh.origin where entity=a.entity and source_id=a.source_id and current_attempt=a.id) then
  raise exception 'finance_refresh_attempt_stale' using errcode='55000';end if;
 perform pg_advisory_xact_lock(174852901,hashtext(a.entity));
 select * into r from origin_sync.raw_record where entity=a.entity and source_id=a.source_id for update;
 v_now:=clock_timestamp();
 if r.version_hash is distinct from a.source_hash or r.last_seen_at is distinct from a.source_seen_at then
  v_result:=jsonb_build_object('stored',false,'conflict',true,'unchanged',false,'balance_available',false,'replayed',false);
  update origin_finance_refresh.attempt set state='conflict',finished_at=v_now,response_hash=v_response_hash,response_status=p_payload->>'situacao',result=v_result where id=a.id;
  update origin_finance_refresh.origin set next_attempt_at=v_now+interval '5 minutes',last_error='FINANCE_SOURCE_CHANGED'
   where entity=a.entity and source_id=a.source_id;
  return v_result;
 end if;
 -- Conserva links/documentos e timestamp de origem. O GET não fornece relógio de alteração comprovado.
 v_hash:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'document_links',r.document_links)::text,'UTF8')),'hex');
 v_unchanged:=v_hash=r.version_hash;
 if not v_unchanged and r.version>=9223372036854775807 then raise exception 'finance_refresh_version_limit' using errcode='22023';end if;
 update origin_sync.raw_record set payload=p_payload,version_hash=v_hash,version=version+case when v_unchanged then 0 else 1 end,
  last_seen_at=v_now,changed_at=case when v_unchanged then changed_at else v_now end,
  last_resource=case a.entity when 'receivables' then 'receivables_refresh' else 'payables_refresh' end
  where entity=a.entity and source_id=a.source_id;
 v_result:=jsonb_build_object('stored',true,'conflict',false,'unchanged',v_unchanged,
  'balance_available',origin_finance_refresh.usable_balance(p_payload),'replayed',false);
 update origin_finance_refresh.attempt set state='stored',finished_at=v_now,response_hash=v_response_hash,response_status=p_payload->>'situacao',
  result_hash=v_hash,result_version=r.version+case when v_unchanged then 0 else 1 end,result=v_result where id=a.id;
 update origin_finance_refresh.origin set last_success_at=v_now,next_attempt_at=null,failures=0,last_error=null where entity=a.entity and source_id=a.source_id;
 if not exists(select 1 from origin_sync.resource_state where resource='__scheduler__' and lease_owner=p_owner and lease_token=p_lease_token and lease_expires_at>clock_timestamp()) then
  raise exception 'finance_refresh_lease_expired' using errcode='55000';end if;
 return v_result;
end; $$;

create function public.origin_sync_finance_refresh_fail(
 p_owner uuid,p_lease_token uuid,p_attempt_id uuid,p_code text,p_http_status integer default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_finance_refresh.attempt%rowtype;o origin_finance_refresh.origin%rowtype;v_retry integer;v_failures integer;
begin
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' or (p_http_status is not null and p_http_status not between 100 and 599) then
  raise exception 'invalid_finance_refresh_failure' using errcode='22023';end if;
 perform origin_finance_refresh.require_scheduler(p_owner,p_lease_token);
 select * into a from origin_finance_refresh.attempt where id=p_attempt_id for update;
 if not found or a.owner is distinct from p_owner or a.fence is distinct from p_lease_token then
  raise exception 'finance_refresh_attempt_missing' using errcode='55000';end if;
 if a.state in('stored','conflict') then return jsonb_build_object('recorded',false,'already_finished',true,'replayed',true);end if;
 if a.state='failed' then
  if a.error_code<>p_code or a.http_status is distinct from p_http_status then raise exception 'finance_refresh_replay_conflict' using errcode='40001';end if;
  return jsonb_build_object('recorded',true,'already_finished',false,'replayed',true);
 end if;
 select * into o from origin_finance_refresh.origin where entity=a.entity and source_id=a.source_id for update;
 if a.state<>'pending' or o.current_attempt is distinct from a.id then raise exception 'finance_refresh_attempt_stale' using errcode='55000';end if;
 v_failures:=least(o.failures+1,1000000);
 v_retry:=case when p_http_status=403 then 86400
  when p_http_status=404 then least(86400,3600*(2^least(v_failures-1,5))::integer)
  else least(86400,300*(2^least(v_failures-1,8))::integer) end;
 update origin_finance_refresh.attempt set state='failed',finished_at=clock_timestamp(),error_code=p_code,http_status=p_http_status where id=a.id;
 update origin_finance_refresh.origin set failures=v_failures,last_error=p_code,next_attempt_at=clock_timestamp()+make_interval(secs=>v_retry)
  where entity=a.entity and source_id=a.source_id;
 if p_http_status=403 then update origin_finance_refresh.entity_state set retry_after=clock_timestamp()+interval '24 hours',last_error='ORIGIN_SCOPE_DENIED' where entity=a.entity;end if;
 return jsonb_build_object('recorded',true,'already_finished',false,'replayed',false);
end; $$;

create function public.origin_sync_finance_refresh_status(p_stale_seconds integer default 3600)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;
begin
 if p_stale_seconds is null or p_stale_seconds not between 300 and 86400 then raise exception 'invalid_finance_refresh_limit' using errcode='22023';end if;
 with counts as (
  select e.entity,e.retry_after,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3')) known_open_partial,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3') and r.last_seen_at<=now()-make_interval(secs=>p_stale_seconds)) stale,
   count(r.source_id) filter(where r.payload->>'situacao' in('1','3') and not origin_finance_refresh.usable_balance(r.payload)) unavailable_balance,
   min(r.last_seen_at) filter(where r.payload->>'situacao' in('1','3')) oldest_observation,
   max(o.last_success_at) last_success_at,
   count(r.source_id) filter(where o.next_attempt_at>now()) backing_off
  from origin_finance_refresh.entity_state e left join origin_sync.raw_record r on r.entity=e.entity
  left join origin_finance_refresh.origin o on o.entity=r.entity and o.source_id=r.source_id group by e.entity,e.retry_after
 ) select jsonb_build_object('stale_seconds',p_stale_seconds,'entities',jsonb_agg(to_jsonb(counts) order by entity),
  'coverage_complete',false,'erp_mutations',false) into v_result from counts;
 return v_result;
end; $$;

insert into origin_sync.resource_state(resource) values('receivables_refresh'),('payables_refresh') on conflict do nothing;
revoke all on all functions in schema origin_finance_refresh from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_finance_refresh_candidates(uuid,uuid,integer,integer),
 public.origin_sync_finance_refresh_begin(uuid,uuid,uuid,text,text,text,timestamptz,integer),
 public.origin_sync_finance_refresh_finish(uuid,uuid,uuid,jsonb),
 public.origin_sync_finance_refresh_fail(uuid,uuid,uuid,text,integer),
 public.origin_sync_finance_refresh_status(integer) from public,anon,authenticated;
grant execute on function public.origin_sync_finance_refresh_candidates(uuid,uuid,integer,integer),
 public.origin_sync_finance_refresh_begin(uuid,uuid,uuid,text,text,text,timestamptz,integer),
 public.origin_sync_finance_refresh_finish(uuid,uuid,uuid,jsonb),
 public.origin_sync_finance_refresh_fail(uuid,uuid,uuid,text,integer),
 public.origin_sync_finance_refresh_status(integer) to service_role;
commit;
