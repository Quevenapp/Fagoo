-- Recaptura dirigida de preços exatos. GET externo somente pelo coletor; SQL só staging.
begin;
create schema origin_price_refresh;
revoke all on schema origin_price_refresh from public,anon,authenticated,service_role;
create table origin_price_refresh.origin (
 source_id text primary key check(source_id ~ '^[1-9][0-9]{0,39}$'),
 current_attempt uuid,last_attempt_at timestamptz,last_success_at timestamptz,next_attempt_at timestamptz,
 failures integer not null default 0 check(failures between 0 and 1000000),last_error text
);
create table origin_price_refresh.attempt (
 id uuid primary key,source_id text not null references origin_price_refresh.origin(source_id),
 owner uuid not null,scheduler_fence uuid not null,resource_fence uuid not null,checkpoint_version bigint not null check(checkpoint_version>=0),
 proposal_id text not null,proposal_hash text not null,proposal_version bigint not null,
 product_hash text not null,product_version bigint not null,product_seen_at timestamptz not null,
 document_links jsonb not null check(jsonb_typeof(document_links)='array'),source_updated_at timestamptz,
 state text not null default 'pending' check(state in('pending','stored','conflict','failed','superseded')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,response_hash text,error_code text,http_status integer,
 check((state='pending')=(finished_at is null)),
 check(proposal_hash ~ '^[0-9a-f]{64}$' and product_hash ~ '^[0-9a-f]{64}$' and proposal_version>0 and product_version>0)
);
alter table origin_price_refresh.origin add foreign key(current_attempt) references origin_price_refresh.attempt(id);
create table origin_price_refresh.scope_state (singleton boolean primary key default true check(singleton),retry_after timestamptz);
insert into origin_price_refresh.scope_state default values;
insert into origin_sync.resource_state(resource) values('proposal_prices') on conflict do nothing;
alter table origin_price_refresh.origin enable row level security;
alter table origin_price_refresh.attempt enable row level security;
alter table origin_price_refresh.scope_state enable row level security;
revoke all on all tables in schema origin_price_refresh from public,anon,authenticated,service_role;
create function origin_price_refresh.immutable_attempt() returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if TG_OP='DELETE' or OLD.state<>'pending' then raise exception 'price_attempt_immutable' using errcode='55000';end if;
 return NEW;
end;$$;
create trigger price_attempt_immutable before update or delete on origin_price_refresh.attempt for each row execute function origin_price_refresh.immutable_attempt();

create function origin_price_refresh.covered(p origin_sync.raw_record) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p.price_capture->>'profile'='origin-price-json-v1' and p.price_capture->>'source'='detail'
  and p.price_capture->>'source_hash'=p.version_hash and p.price_capture->>'source_version'=p.version::text,false);
$$;
create function origin_price_refresh.witness(p origin_sync.raw_record,p_product text) returns boolean language sql stable set search_path=pg_catalog as $$
 select p.entity='sales_proposals' and exists(select 1 from origin_reference_fetch.refs(p.payload,p.source_id) x where x.entity='products' and x.source_id=p_product)
 and not exists(select 1 from erp_documents.origin_import_origin o where o.entity='sales_proposals' and o.source_id=p.source_id);
$$;
create function origin_price_refresh.scope() returns table(source_id text,product_hash text,product_version bigint,product_seen_at timestamptz,
 proposal_id text,proposal_hash text,proposal_version bigint,covered boolean) language sql stable set search_path=pg_catalog as $$
 select distinct on(t.source_id) t.source_id,t.version_hash,t.version,t.last_seen_at,r.source_id,r.version_hash,r.version,origin_price_refresh.covered(t)
 from origin_sync.raw_record r cross join lateral origin_reference_fetch.refs(r.payload,r.source_id) x
 join origin_sync.raw_record t on t.entity='products' and t.source_id=x.source_id
 where r.entity='sales_proposals' and r.payload->>'situacao' in('Rascunho','Pendente','Aguardando') and x.entity='products'
 and not exists(select 1 from erp_documents.origin_import_origin o where o.entity='sales_proposals' and o.source_id=r.source_id)
 order by t.source_id,r.source_id collate "C";
$$;
create function origin_price_refresh.require_leases(p_owner uuid,p_scheduler uuid,p_resource uuid) returns void
 language plpgsql security definer set search_path=pg_catalog as $$declare s origin_sync.resource_state%rowtype;begin
 select * into s from origin_sync.resource_state where resource='__scheduler__' for update;
 if p_owner is null or p_scheduler is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_scheduler
  or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'price_scheduler_required' using errcode='55000';end if;
 select * into s from origin_sync.resource_state where resource='proposal_prices' for update;
 if p_resource is null or s.lease_owner is distinct from p_owner or s.lease_token is distinct from p_resource
  or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp() then raise exception 'price_resource_required' using errcode='55000';end if;
end;$$;
create function public.origin_sync_price_candidates(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_limit integer default 8)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare v jsonb;begin
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 if p_limit is null or p_limit not between 1 and 8 then raise exception 'invalid_price_limit' using errcode='22023';end if;
 with page as(select s.*,o.last_attempt_at from origin_price_refresh.scope() s left join origin_price_refresh.origin o using(source_id)
 where not s.covered and (o.next_attempt_at is null or o.next_attempt_at<=clock_timestamp())
 and not exists(select 1 from origin_price_refresh.scope_state where retry_after>clock_timestamp())
 order by o.last_attempt_at nulls first,s.source_id collate "C" limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'product_hash',product_hash,
 'product_version',product_version::text,'product_seen_at',product_seen_at,'proposal_id',proposal_id,'proposal_hash',proposal_hash,'proposal_version',proposal_version::text)
 order by last_attempt_at nulls first,source_id collate "C"),'[]'::jsonb)) into v from page;
 return v;
end;$$;
create function public.origin_sync_price_begin(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,
 p_source_id text,p_product_hash text,p_product_version bigint,p_product_seen_at timestamptz,p_proposal_id text,p_proposal_hash text,p_proposal_version bigint)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
 declare a origin_price_refresh.attempt%rowtype;o origin_price_refresh.origin%rowtype;r origin_sync.raw_record%rowtype;t origin_sync.raw_record%rowtype;cp bigint;begin
 if p_attempt_id is null or p_source_id is null or p_source_id !~ '^[1-9][0-9]{0,39}$' or p_proposal_id is null or p_proposal_id !~ '^[1-9][0-9]{0,39}$'
  or p_product_hash is null or p_product_hash !~ '^[0-9a-f]{64}$' or p_proposal_hash is null or p_proposal_hash !~ '^[0-9a-f]{64}$'
  or p_product_version is null or p_product_version<1 or p_proposal_version is null or p_proposal_version<1
  or p_product_seen_at is null or not isfinite(p_product_seen_at) then raise exception 'invalid_price_begin' using errcode='22023';end if;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_price_refresh.attempt where id=p_attempt_id;
 if found then
  if a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token or a.source_id<>p_source_id
   or a.product_hash<>p_product_hash or a.product_version<>p_product_version or a.product_seen_at<>p_product_seen_at
   or a.proposal_id<>p_proposal_id or a.proposal_hash<>p_proposal_hash or a.proposal_version<>p_proposal_version then raise exception 'price_command_conflict' using errcode='40001';end if;
  return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',true);
 end if;
 if exists(select 1 from origin_sync.batch_inbox where batch_id=p_attempt_id) then raise exception 'price_command_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852901,hashtext('products'));
 select * into r from origin_sync.raw_record where entity='sales_proposals' and source_id=p_proposal_id for share;
 if not found or r.version_hash<>p_proposal_hash or r.version<>p_proposal_version or not origin_price_refresh.witness(r,p_source_id)
  then raise exception 'price_witness_changed' using errcode='40001';end if;
 select * into t from origin_sync.raw_record where entity='products' and source_id=p_source_id for update;
 if not found or t.version_hash<>p_product_hash or t.version<>p_product_version or t.last_seen_at<>p_product_seen_at or origin_price_refresh.covered(t)
  then raise exception 'price_product_changed' using errcode='40001';end if;
 -- An import may commit its origin while this statement waited for its product SHARE lock.
 if not origin_price_refresh.witness(r,p_source_id) then raise exception 'price_witness_changed' using errcode='40001';end if;
 if exists(select 1 from origin_price_refresh.scope_state where retry_after>clock_timestamp()) then raise exception 'price_scope_backoff' using errcode='55000';end if;
 insert into origin_price_refresh.origin(source_id) values(p_source_id) on conflict do nothing;
 select * into o from origin_price_refresh.origin where source_id=p_source_id for update;
 if o.next_attempt_at>clock_timestamp() then raise exception 'price_backoff' using errcode='55000';end if;
 update origin_price_refresh.attempt set state='superseded',finished_at=clock_timestamp() where id=o.current_attempt and state='pending';
 select checkpoint_version into cp from origin_sync.resource_state where resource='proposal_prices';
 insert into origin_price_refresh.attempt(id,source_id,owner,scheduler_fence,resource_fence,checkpoint_version,proposal_id,proposal_hash,proposal_version,
 product_hash,product_version,product_seen_at,document_links,source_updated_at)
 values(p_attempt_id,p_source_id,p_owner,p_lease_token,p_resource_token,cp,p_proposal_id,p_proposal_hash,p_proposal_version,
 p_product_hash,p_product_version,p_product_seen_at,t.document_links,t.source_updated_at) returning * into a;
 update origin_price_refresh.origin set current_attempt=a.id,last_attempt_at=a.started_at,next_attempt_at=a.started_at+interval '5 minutes' where source_id=p_source_id;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('attempt_id',a.id,'state',a.state,'replayed',false);
end;$$;
-- Canonical success/replay lives only in batch_inbox, under the attempt UUID.
create function origin_price_refresh.apply_attempt(a origin_price_refresh.attempt,p_payload jsonb,p_capture jsonb) returns jsonb
 language sql set search_path=pg_catalog as $$
 select public.origin_sync_apply_price_batch('proposal_prices','products',a.owner,a.resource_fence,a.id,
 jsonb_build_array(jsonb_build_object('source_id',a.source_id,'payload',p_payload,'document_links',a.document_links,
 'source_updated_at',a.source_updated_at,'price_capture',p_capture)),'{}'::jsonb,a.checkpoint_version);
$$;
create function public.origin_sync_price_finish(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_payload jsonb,p_price_capture jsonb)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
 declare a origin_price_refresh.attempt%rowtype;r origin_sync.raw_record%rowtype;t origin_sync.raw_record%rowtype;h text;v jsonb;conflict boolean;begin
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>8388608
  or p_price_capture->>'source' is distinct from 'detail' then raise exception 'invalid_price_detail' using errcode='22023';end if;
 perform origin_sync.validate_price_capture('products',p_payload,p_price_capture);
 h:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'capture',p_price_capture)::text,'UTF8')),'hex');
 select * into a from origin_price_refresh.attempt where id=p_attempt_id;
 if not found or a.owner is distinct from p_owner or a.scheduler_fence is distinct from p_lease_token or a.resource_fence is distinct from p_resource_token then raise exception 'price_attempt_missing' using errcode='55000';end if;
 if a.source_id is distinct from origin_reference_fetch.exact_id(p_payload->'id') then raise exception 'price_response_identity' using errcode='22023';end if;
 -- Exact committed replay is readonly and follows005 even after lease turnover.
 if a.state='stored' then
  if a.response_hash<>h then raise exception 'price_response_conflict' using errcode='40001';end if;
  return origin_price_refresh.apply_attempt(a,p_payload,p_price_capture)||jsonb_build_object('stored',true,'conflict',false);
 end if;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_price_refresh.attempt where id=p_attempt_id for update;
 if a.state in('stored','conflict') then
  if a.response_hash<>h then raise exception 'price_response_conflict' using errcode='40001';end if;
  if a.state='stored' then return origin_price_refresh.apply_attempt(a,p_payload,p_price_capture)||jsonb_build_object('stored',true,'conflict',false);end if;
  return jsonb_build_object('stored',false,'conflict',true,'replayed',true);
 end if;
 if a.state<>'pending' or not exists(select 1 from origin_price_refresh.origin where source_id=a.source_id and current_attempt=a.id)
  then raise exception 'price_attempt_stale' using errcode='55000';end if;
 perform pg_advisory_xact_lock(174852901,hashtext('products'));
 select * into r from origin_sync.raw_record where entity='sales_proposals' and source_id=a.proposal_id for share;
 conflict:=not found or r.version_hash is distinct from a.proposal_hash or r.version is distinct from a.proposal_version or not origin_price_refresh.witness(r,a.source_id);
 select * into t from origin_sync.raw_record where entity='products' and source_id=a.source_id for update;
 conflict:=conflict or not found or t.version_hash is distinct from a.product_hash or t.version is distinct from a.product_version
  or t.last_seen_at is distinct from a.product_seen_at or origin_price_refresh.covered(t);
 -- Recheck the origin after the product wait, not only before acquiring that lock.
 conflict:=conflict or not origin_price_refresh.witness(r,a.source_id);
 if not conflict then
  v:=origin_price_refresh.apply_attempt(a,p_payload,p_price_capture);
  if (v->>'inserted')::integer<>0 or (v->>'updated')::integer+(v->>'unchanged')::integer<>1 or (v->>'price_captures')::integer<>1
   then raise exception 'price_batch_unconfirmed' using errcode='55000';end if;
  v:=v||jsonb_build_object('stored',true,'conflict',false);
 else v:=jsonb_build_object('stored',false,'conflict',true,'replayed',false);end if;
 update origin_price_refresh.attempt set state=case when conflict then 'conflict' else 'stored' end,finished_at=clock_timestamp(),response_hash=h where id=a.id;
 update origin_price_refresh.origin set last_success_at=case when conflict then last_success_at else clock_timestamp() end,
 next_attempt_at=case when conflict then clock_timestamp()+interval '5 minutes' else null end,failures=case when conflict then failures else 0 end,
 last_error=case when conflict then 'PRICE_SOURCE_CHANGED' else null end where source_id=a.source_id;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 return v;
end;$$;
create function public.origin_sync_price_fail(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_code text,p_http_status integer default null)
 returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a origin_price_refresh.attempt%rowtype;n integer;delay integer;begin
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' or (p_http_status is not null and p_http_status not between 100 and 599) then raise exception 'invalid_price_failure' using errcode='22023';end if;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_price_refresh.attempt where id=p_attempt_id for update;
 if not found or a.owner is distinct from p_owner or a.scheduler_fence is distinct from p_lease_token or a.resource_fence is distinct from p_resource_token then raise exception 'price_attempt_missing' using errcode='55000';end if;
 if a.state in('stored','conflict','superseded') then return jsonb_build_object('recorded',false,'already_finished',true);end if;
 if a.state='failed' then
  if a.error_code<>p_code or a.http_status is distinct from p_http_status then raise exception 'price_failure_conflict' using errcode='40001';end if;
  return jsonb_build_object('recorded',true,'already_finished',false);
 end if;
 select least(failures+1,1000000) into n from origin_price_refresh.origin where source_id=a.source_id and current_attempt=a.id for update;
 if not found then raise exception 'price_attempt_stale' using errcode='55000';end if;
 delay:=case when p_http_status in(403,404) then 86400 else least(86400,300*(2^least(n-1,8))::integer) end;
 update origin_price_refresh.attempt set state='failed',finished_at=clock_timestamp(),error_code=p_code,http_status=p_http_status where id=a.id;
 update origin_price_refresh.origin set failures=n,last_error=p_code,next_attempt_at=clock_timestamp()+make_interval(secs=>delay) where source_id=a.source_id;
 if p_http_status=403 then update origin_price_refresh.scope_state set retry_after=clock_timestamp()+interval '24 hours';end if;
 perform origin_price_refresh.require_leases(p_owner,p_lease_token,p_resource_token);
 return jsonb_build_object('recorded',true,'already_finished',false);
end;$$;
create function public.origin_sync_price_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 with s as materialized(select * from origin_price_refresh.scope())
 select jsonb_build_object('scope','unimported_open_proposal_products','referenced_products',(select count(*) from s),
 'captured_products',(select count(*) from s where covered),'pending_products',(select count(*) from s where not covered),
 'backing_off',(select count(*) from s join origin_price_refresh.origin o using(source_id) where not s.covered and o.next_attempt_at>now()),
 'current_scope_complete',not exists(select 1 from s where not covered),'coverage_complete',false,'erp_mutations',false,
 'retry_after',(select retry_after from origin_price_refresh.scope_state),
 'last_success_at',(select max(last_success_at) from origin_price_refresh.origin));
$$;
revoke all on all functions in schema origin_price_refresh from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_price_candidates(uuid,uuid,uuid,integer),
 public.origin_sync_price_begin(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text,text,bigint),
 public.origin_sync_price_finish(uuid,uuid,uuid,uuid,jsonb,jsonb),public.origin_sync_price_fail(uuid,uuid,uuid,uuid,text,integer),public.origin_sync_price_status()
 from public,anon,authenticated;
grant execute on function public.origin_sync_price_candidates(uuid,uuid,uuid,integer),
 public.origin_sync_price_begin(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz,text,text,bigint),
 public.origin_sync_price_finish(uuid,uuid,uuid,uuid,jsonb,jsonb),public.origin_sync_price_fail(uuid,uuid,uuid,uuid,text,integer),public.origin_sync_price_status()
 to service_role;
commit;
