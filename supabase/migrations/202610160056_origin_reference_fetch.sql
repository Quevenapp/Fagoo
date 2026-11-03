-- GET dirigido de referências ausentes de propostas abertas. Somente staging.
begin;
create schema origin_reference_fetch;
revoke all on schema origin_reference_fetch from public,anon,authenticated,service_role;
create table origin_reference_fetch.origin (
 entity text not null check(entity in('contacts','products')),
 source_id text not null check(source_id ~ '^[1-9][0-9]{0,39}$'),
 current_attempt uuid,last_attempt_at timestamptz,last_success_at timestamptz,next_attempt_at timestamptz,
 failures integer not null default 0 check(failures between 0 and 1000000),last_error text,
 primary key(entity,source_id)
);
create table origin_reference_fetch.attempt (
 id uuid primary key,entity text not null,source_id text not null,
 owner uuid not null,scheduler_fence uuid not null,resource_fence uuid not null,
 proposal_id text not null,proposal_hash text not null check(proposal_hash ~ '^[0-9a-f]{64}$'),proposal_version bigint not null check(proposal_version>0),
 state text not null default 'pending' check(state in('pending','stored','conflict','failed','superseded')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 response_hash text,result_hash text,result jsonb,error_code text,http_status integer,
 foreign key(entity,source_id) references origin_reference_fetch.origin(entity,source_id),
 check((state='pending')=(finished_at is null))
);
alter table origin_reference_fetch.origin add foreign key(current_attempt) references origin_reference_fetch.attempt(id);
create table origin_reference_fetch.entity_state (
 entity text primary key check(entity in('contacts','products')),last_attempt_at timestamptz,retry_after timestamptz,last_error text
);
insert into origin_reference_fetch.entity_state(entity) values('contacts'),('products');
insert into origin_sync.resource_state(resource) values('proposal_references') on conflict do nothing;
alter table origin_reference_fetch.origin enable row level security;
alter table origin_reference_fetch.attempt enable row level security;
alter table origin_reference_fetch.entity_state enable row level security;
revoke all on all tables in schema origin_reference_fetch from public,anon,authenticated,service_role;
create index reference_attempt_origin on origin_reference_fetch.attempt(entity,source_id,started_at desc);
create index reference_open_proposals on origin_sync.raw_record(source_id) where entity='sales_proposals' and payload->>'situacao' in('Rascunho','Pendente','Aguardando');

create function origin_reference_fetch.immutable_attempt() returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 if TG_OP='DELETE' or OLD.state<>'pending' then raise exception 'reference_attempt_immutable' using errcode='55000';end if;
 return NEW;
end;$$;
create trigger reference_attempt_immutable before update or delete on origin_reference_fetch.attempt for each row execute function origin_reference_fetch.immutable_attempt();
create function origin_reference_fetch.exact_id(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p) in('string','number') and p#>>'{}' ~ '^[1-9][0-9]{0,39}$' then p#>>'{}' end;
$$;
create function origin_reference_fetch.refs(p jsonb,p_id text) returns table(entity text,source_id text)
 language sql immutable set search_path=pg_catalog as $$
 with valid as(select p where jsonb_typeof(p)='object' and octet_length(p::text)<=524288
  and origin_reference_fetch.exact_id(p->'id')=p_id and jsonb_typeof(p->'situacao')='string'
  and p->>'situacao' in('Rascunho','Pendente','Aguardando')
  and jsonb_typeof(p->'itens')='array' and jsonb_array_length(case when jsonb_typeof(p->'itens')='array' then p->'itens' else '[]'::jsonb end) between 1 and 250),
 refs as(select 'contacts'::text entity,origin_reference_fetch.exact_id(p#>'{contato,id}') source_id from valid
 union select 'products',origin_reference_fetch.exact_id(i#>'{produto,id}') from valid cross join lateral jsonb_array_elements(p->'itens') i)
 select entity,source_id from refs where source_id is not null;
$$;
-- Same global/resource lock order as the scheduler. Never changes a checkpoint.
create function origin_reference_fetch.require_leases(p_owner uuid,p_scheduler uuid,p_resource uuid) returns void
 language plpgsql security definer set search_path=pg_catalog as $$ declare s origin_sync.resource_state%rowtype;begin
 select * into s from origin_sync.resource_state where resource='__scheduler__' for update;
 if p_owner is null or p_scheduler is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_scheduler
  or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'reference_scheduler_required' using errcode='55000';end if;
 select * into s from origin_sync.resource_state where resource='proposal_references' for update;
 if p_resource is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_resource
  or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'reference_resource_required' using errcode='55000';end if;
end;$$;
create function origin_reference_fetch.missing() returns table(entity text,source_id text,proposal_id text,proposal_hash text,proposal_version bigint)
 language sql stable set search_path=pg_catalog as $$
 select distinct on(x.entity,x.source_id) x.entity,x.source_id,r.source_id,r.version_hash,r.version
 from origin_sync.raw_record r cross join lateral origin_reference_fetch.refs(r.payload,r.source_id) x
 where r.entity='sales_proposals' and r.payload->>'situacao' in('Rascunho','Pendente','Aguardando') and not exists(select 1 from origin_sync.raw_record t where t.entity=x.entity and t.source_id=x.source_id)
 order by x.entity,x.source_id,r.source_id collate "C";
$$;
create function public.origin_sync_reference_candidates(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_limit integer default 10)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare v jsonb;begin
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_reference_limit' using errcode='22023';end if;
 with eligible as materialized(select m.*,e.last_attempt_at entity_attempt,
 row_number() over(partition by m.entity order by o.last_attempt_at nulls first,m.source_id collate "C") lane
 from origin_reference_fetch.missing() m join origin_reference_fetch.entity_state e using(entity)
 left join origin_reference_fetch.origin o using(entity,source_id)
 where (e.retry_after is null or e.retry_after<=clock_timestamp()) and (o.next_attempt_at is null or o.next_attempt_at<=clock_timestamp())),
 page as(select * from eligible order by lane,entity_attempt nulls first,entity limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('entity',entity,'source_id',source_id,
 'proposal_id',proposal_id,'proposal_hash',proposal_hash,'proposal_version',proposal_version::text)
 order by lane,entity_attempt nulls first,entity),'[]'::jsonb)) into v from page;
 return v;
end;$$;
create function public.origin_sync_reference_begin(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,
 p_entity text,p_source_id text,p_proposal_id text,p_proposal_hash text,p_proposal_version bigint)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
 declare a origin_reference_fetch.attempt%rowtype;o origin_reference_fetch.origin%rowtype;r origin_sync.raw_record%rowtype;begin
 if p_attempt_id is null or p_entity is null or p_entity not in('contacts','products') or p_source_id is null or p_source_id !~ '^[1-9][0-9]{0,39}$'
  or p_proposal_id is null or p_proposal_id !~ '^[1-9][0-9]{0,39}$' or p_proposal_hash is null or p_proposal_hash !~ '^[0-9a-f]{64}$'
  or p_proposal_version is null or p_proposal_version<1 then raise exception 'invalid_reference_begin' using errcode='22023';end if;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_reference_fetch.attempt where id=p_attempt_id;
 if found then
  if a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token or a.entity<>p_entity or a.source_id<>p_source_id
   or a.proposal_id<>p_proposal_id or a.proposal_hash<>p_proposal_hash or a.proposal_version<>p_proposal_version then raise exception 'reference_command_conflict' using errcode='40001';end if;
  return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',true);
 end if;
 perform pg_advisory_xact_lock(174852901,hashtext(p_entity));
 select * into r from origin_sync.raw_record where entity='sales_proposals' and source_id=p_proposal_id for share;
 if not found or r.version_hash<>p_proposal_hash or r.version<>p_proposal_version
  or not exists(select 1 from origin_reference_fetch.refs(r.payload,r.source_id) x where x.entity=p_entity and x.source_id=p_source_id)
  or exists(select 1 from origin_sync.raw_record where entity=p_entity and source_id=p_source_id) then raise exception 'reference_source_changed' using errcode='40001';end if;
 if exists(select 1 from origin_reference_fetch.entity_state where entity=p_entity and retry_after>clock_timestamp()) then raise exception 'reference_scope_backoff' using errcode='55000';end if;
 insert into origin_reference_fetch.origin(entity,source_id) values(p_entity,p_source_id) on conflict do nothing;
 select * into o from origin_reference_fetch.origin where entity=p_entity and source_id=p_source_id for update;
 if o.next_attempt_at>clock_timestamp() then raise exception 'reference_backoff' using errcode='55000';end if;
 update origin_reference_fetch.attempt set state='superseded',finished_at=clock_timestamp() where id=o.current_attempt and state='pending';
 insert into origin_reference_fetch.attempt(id,entity,source_id,owner,scheduler_fence,resource_fence,proposal_id,proposal_hash,proposal_version)
 values(p_attempt_id,p_entity,p_source_id,p_owner,p_lease_token,p_resource_token,p_proposal_id,p_proposal_hash,p_proposal_version) returning * into a;
 update origin_reference_fetch.origin set current_attempt=a.id,last_attempt_at=a.started_at,next_attempt_at=a.started_at+interval '5 minutes' where entity=p_entity and source_id=p_source_id;
 update origin_reference_fetch.entity_state set last_attempt_at=a.started_at where entity=p_entity;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',false);
end;$$;
create function public.origin_sync_reference_finish(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_payload jsonb)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
 declare a origin_reference_fetch.attempt%rowtype;r origin_sync.raw_record%rowtype;h text;v_hash text;v jsonb;conflict boolean;begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>8388608
  or origin_reference_fetch.exact_id(p_payload->'id') is null then raise exception 'invalid_reference_detail' using errcode='22023';end if;
 h:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_reference_fetch.attempt where id=p_attempt_id for update;
 if not found or a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token then raise exception 'reference_attempt_missing' using errcode='55000';end if;
 if a.source_id is distinct from origin_reference_fetch.exact_id(p_payload->'id') then raise exception 'reference_response_identity' using errcode='22023';end if;
 if a.state in('stored','conflict') then
  if a.response_hash<>h then raise exception 'reference_response_conflict' using errcode='40001';end if;
  return a.result||jsonb_build_object('replayed',true);
 end if;
 if a.state<>'pending' or not exists(select 1 from origin_reference_fetch.origin where entity=a.entity and source_id=a.source_id and current_attempt=a.id)
  then raise exception 'reference_attempt_stale' using errcode='55000';end if;
 perform pg_advisory_xact_lock(174852901,hashtext(a.entity));
 select * into r from origin_sync.raw_record where entity='sales_proposals' and source_id=a.proposal_id for share;
 conflict:=not found or r.version_hash is distinct from a.proposal_hash or r.version is distinct from a.proposal_version
  or not exists(select 1 from origin_reference_fetch.refs(r.payload,r.source_id) x where x.entity=a.entity and x.source_id=a.source_id)
  or exists(select 1 from origin_sync.raw_record where entity=a.entity and source_id=a.source_id);
 if not conflict then
  v_hash:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'document_links','[]'::jsonb)::text,'UTF8')),'hex');
  insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash)
   values(a.entity,'proposal_references',a.source_id,p_payload,'[]',v_hash);
 end if;
 v:=jsonb_build_object('stored',not conflict,'conflict',conflict,'replayed',false);
 update origin_reference_fetch.attempt set state=case when conflict then 'conflict' else 'stored' end,finished_at=clock_timestamp(),response_hash=h,result_hash=v_hash,result=v where id=a.id;
 update origin_reference_fetch.origin set last_success_at=case when conflict then last_success_at else clock_timestamp() end,
  next_attempt_at=case when conflict then clock_timestamp()+interval '5 minutes' else null end,
  failures=case when conflict then failures else 0 end,last_error=case when conflict then 'REFERENCE_SOURCE_CHANGED' else null end where entity=a.entity and source_id=a.source_id;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 return v;
end;$$;
create function public.origin_sync_reference_fail(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_code text,p_http_status integer default null)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare a origin_reference_fetch.attempt%rowtype;n integer;delay integer;begin
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' or (p_http_status is not null and p_http_status not between 100 and 599) then raise exception 'invalid_reference_failure' using errcode='22023';end if;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_reference_fetch.attempt where id=p_attempt_id for update;
 if not found or a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token then raise exception 'reference_attempt_missing' using errcode='55000';end if;
 if a.state in('stored','conflict','superseded') then return jsonb_build_object('recorded',false,'already_finished',true);end if;
 if a.state='failed' then
  if a.error_code<>p_code or a.http_status is distinct from p_http_status then raise exception 'reference_failure_conflict' using errcode='40001';end if;
  return jsonb_build_object('recorded',true,'already_finished',false);
 end if;
 select least(failures+1,1000000) into n from origin_reference_fetch.origin where entity=a.entity and source_id=a.source_id and current_attempt=a.id for update;
 if not found then raise exception 'reference_attempt_stale' using errcode='55000';end if;
 delay:=case when p_http_status=403 then 86400 when p_http_status=404 then least(86400,3600*(2^least(n-1,5))::integer) else least(86400,300*(2^least(n-1,8))::integer) end;
 update origin_reference_fetch.attempt set state='failed',finished_at=clock_timestamp(),error_code=p_code,http_status=p_http_status where id=a.id;
 update origin_reference_fetch.origin set failures=n,last_error=p_code,next_attempt_at=clock_timestamp()+make_interval(secs=>delay) where entity=a.entity and source_id=a.source_id;
 if p_http_status=403 then update origin_reference_fetch.entity_state set retry_after=clock_timestamp()+interval '24 hours',last_error='ORIGIN_SCOPE_PENDING' where entity=a.entity;end if;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('recorded',true,'already_finished',false);
end;$$;
create function public.origin_sync_reference_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 with missing as materialized(select * from origin_reference_fetch.missing()), counts as(
 select e.entity,e.retry_after,e.last_error,
 (select count(*) from missing m where m.entity=e.entity) missing_references,
 (select count(*) from missing m join origin_reference_fetch.origin o using(entity,source_id) where m.entity=e.entity and o.next_attempt_at>now()) backing_off,
 (select count(*) from origin_reference_fetch.attempt a where a.entity=e.entity and a.state='stored') stored_attempts,
 (select count(*) from origin_reference_fetch.attempt a where a.entity=e.entity and a.state='pending') pending_attempts,
 (select max(last_success_at) from origin_reference_fetch.origin o where o.entity=e.entity) last_success_at
 from origin_reference_fetch.entity_state e)
 select jsonb_build_object('entities',jsonb_agg(to_jsonb(counts) order by entity),'coverage_complete',false,'erp_mutations',false,'deletion_inferred',false) from counts;
$$;
revoke all on all functions in schema origin_reference_fetch from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_reference_candidates(uuid,uuid,uuid,integer),public.origin_sync_reference_begin(uuid,uuid,uuid,uuid,text,text,text,text,bigint),
 public.origin_sync_reference_finish(uuid,uuid,uuid,uuid,jsonb),public.origin_sync_reference_fail(uuid,uuid,uuid,uuid,text,integer),public.origin_sync_reference_status() from public,anon,authenticated;
grant execute on function public.origin_sync_reference_candidates(uuid,uuid,uuid,integer),public.origin_sync_reference_begin(uuid,uuid,uuid,uuid,text,text,text,text,bigint),
 public.origin_sync_reference_finish(uuid,uuid,uuid,uuid,jsonb),public.origin_sync_reference_fail(uuid,uuid,uuid,uuid,text,integer),public.origin_sync_reference_status() to service_role;
commit;
