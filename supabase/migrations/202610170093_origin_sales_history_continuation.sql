-- Durable, bounded continuation of immutable 083 observations. No native business writes.
-- Cursor exhaustion describes one pass only; collection can add lower source IDs later.
begin;
create schema erp_sales_history_continuation;
revoke all on schema erp_sales_history_continuation from public,anon,authenticated,service_role;
alter default privileges in schema erp_sales_history_continuation revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_sales_history_continuation revoke all on functions from public,anon,authenticated,service_role;

create table erp_sales_history_continuation.prepared (
 batch_id uuid primary key,
 actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 prepare_hash text not null check(prepare_hash ~ '^[a-f0-9]{64}$'),
 prepared_at timestamptz not null,
 expires_at timestamptz not null,
 proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=131072),
 residuals jsonb not null check(jsonb_typeof(residuals)='array' and jsonb_array_length(residuals)<=100),
 check(isfinite(prepared_at) and expires_at=prepared_at+interval '10 minutes'),
 check(proof->>'profile'='origin-sales-history-continuation-prepare-v1'
  and proof->>'batch_id'=batch_id::text and proof->>'actor'=actor::text
  and jsonb_typeof(proof->'items')='array' and jsonb_array_length(proof->'items')<=25
  and proof->'residuals'=residuals
  and prepare_hash=encode(sha256(convert_to(proof::text,'UTF8')),'hex'))
);
create table erp_sales_history_continuation.terminal (
 batch_id uuid primary key references erp_sales_history_continuation.prepared(batch_id),
 status text not null check(status in('applied','rejected','empty')),
 result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=262144),
 result_hash text not null check(result_hash=encode(sha256(convert_to(result::text,'UTF8')),'hex')),
 finished_at timestamptz not null default clock_timestamp(),
 check(result->>'profile'='origin-sales-history-continuation-result-v1'
  and result->>'batch_id'=batch_id::text and result->>'status'=status)
);
create index continuation_prepared_order on erp_sales_history_continuation.prepared(prepared_at,batch_id);
create index continuation_residuals on erp_sales_history_continuation.prepared using gin(residuals jsonb_path_ops);
alter table erp_sales_history_continuation.prepared enable row level security;
alter table erp_sales_history_continuation.terminal enable row level security;
revoke all on all tables in schema erp_sales_history_continuation from public,anon,authenticated,service_role;
create trigger immutable_prepared before update or delete on erp_sales_history_continuation.prepared for each row execute function erp_sales_history.immutable();
create trigger immutable_terminal before update or delete on erp_sales_history_continuation.terminal for each row execute function erp_sales_history.immutable();

create function erp_sales_history_continuation.identity(s origin_sync.raw_record) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version::text,
  'price_capture_hash',encode(sha256(convert_to(coalesce(s.price_capture::text,'null'),'UTF8')),'hex'))
$$;
create function erp_sales_history_continuation.classify(s origin_sync.raw_record) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb; reason text;
begin
 begin
  v:=erp_sales_history.input(s);
 exception when sqlstate '22023' then
  get stacked diagnostics reason=message_text;
  if reason not in('sales_history_source_invalid','sales_history_source_too_large') then raise;end if;
  return erp_sales_history_continuation.identity(s)||jsonb_build_object('eligible',false,'reason',reason);
 end;
 if v->'price_capture_verification'->>'state' is distinct from 'bound' then
  return erp_sales_history_continuation.identity(s)||jsonb_build_object('eligible',false,'reason','price_capture_not_bound');
 end if;
 return erp_sales_history_continuation.identity(s)||jsonb_build_object('eligible',true,
  'snapshot_hash',encode(sha256(convert_to(v::text,'UTF8')),'hex'));
end $$;
create function erp_sales_history_continuation.require_lease(p_owner uuid,p_scheduler_token uuid) returns void
language plpgsql set search_path=pg_catalog as $$
begin
 if p_owner is null or p_scheduler_token is null or not exists(select 1 from origin_sync.resource_state
  where resource='__scheduler__' and lease_owner=p_owner and lease_token=p_scheduler_token and lease_expires_at>clock_timestamp()) then
  raise exception 'sales_history_continuation_lease_lost' using errcode='55000';
 end if;
end $$;
create function erp_sales_history_continuation.envelope(p_batch_id uuid,p_status text default null) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('profile','origin-sales-history-continuation-state-v1','status',coalesce(p_status,t.status,'prepared'),
  'batch_id',p.batch_id,'actor',p.actor,'request_hash',p.request_hash,'prepare_hash',p.prepare_hash,
  'prepared_at',p.prepared_at,'expires_at',p.expires_at,'proof',p.proof,
  'terminal',case when t.batch_id is not null then jsonb_build_object('status',t.status,'result',t.result,'result_hash',t.result_hash,'finished_at',t.finished_at)end,
  'native_effects',false,'fiscal_effects',false,'coverage_certified',false)
 from erp_sales_history_continuation.prepared p left join erp_sales_history_continuation.terminal t using(batch_id) where p.batch_id=p_batch_id
$$;
create function erp_sales_history_continuation.finish(p_batch_id uuid,p_prepare_hash text,p_status text,p_reason text,p_receipts jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare v jsonb;
begin
 v:=jsonb_build_object('profile','origin-sales-history-continuation-result-v1','batch_id',p_batch_id,'prepare_hash',p_prepare_hash,
  'status',p_status,'reason',p_reason,'receipts',p_receipts,'captured_count',jsonb_array_length(p_receipts),
  'native_effects',false,'fiscal_effects',false,'coverage_certified',false);
 insert into erp_sales_history_continuation.terminal(batch_id,status,result,result_hash)
 values(p_batch_id,p_status,v,encode(sha256(convert_to(v::text,'UTF8')),'hex'));
end $$;

create function public.erp_origin_sales_history_continuation_get(p_user_id uuid,p_batch_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare id uuid;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_batch_id is not null then id:=p_batch_id;
 else select p.batch_id into id from erp_sales_history_continuation.prepared p
  where not exists(select 1 from erp_sales_history_continuation.terminal t where t.batch_id=p.batch_id)
  order by p.prepared_at,p.batch_id limit 1;
 end if;
 return jsonb_build_object('profile','origin-sales-history-continuation-get-v1','batch',erp_sales_history_continuation.envelope(id));
end $$;

create function public.erp_origin_sales_history_continuation_prepare(p_user_id uuid,p_owner uuid,p_scheduler_token uuid,
 p_batch_id uuid,p_after text default null,p_limit integer default 25) returns jsonb
language plpgsql security definer set search_path=pg_catalog set lock_timeout='750ms' as $$
declare req text;existing erp_sales_history_continuation.prepared;pending uuid;s origin_sync.raw_record;
 item jsonb;items jsonb:='[]';residuals jsonb:='[]';proof jsonb;ph text;at_time timestamptz;
 scanned integer:=0;cursor_id text:=p_after;reached_end boolean;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_batch_id is null or p_limit is null or p_limit not between 1 and 25 or(p_after is not null and length(p_after) not between 1 and 200) then
  raise exception 'sales_history_continuation_request_invalid' using errcode='22023';end if;
 req:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'batch_id',p_batch_id,'after',p_after,'limit',p_limit)::text,'UTF8')),'hex');
 lock table erp_sales_history_continuation.prepared,erp_sales_history_continuation.terminal in row exclusive mode nowait;
 lock table origin_sync.resource_state,origin_sync.raw_record,erp_sales_history.snapshot,erp_access.membership,auth.users in access share mode nowait;
 if not pg_try_advisory_xact_lock(174853093,0) then raise exception 'sales_history_continuation_busy' using errcode='55P03';end if;
 perform 1 from erp_access.membership where user_id=p_user_id for share nowait;
 perform 1 from auth.users where id=p_user_id for key share nowait;
 perform erp_cutover.require_admin(p_user_id);
 select * into existing from erp_sales_history_continuation.prepared where batch_id=p_batch_id;
 if found then
  if existing.actor<>p_user_id or existing.request_hash<>req then raise exception 'sales_history_continuation_request_conflict' using errcode='40001';end if;
  return erp_sales_history_continuation.envelope(p_batch_id);
 end if;
 perform 1 from origin_sync.resource_state where resource='__scheduler__' for share nowait;
 perform erp_sales_history_continuation.require_lease(p_owner,p_scheduler_token);
 select p.batch_id into pending from erp_sales_history_continuation.prepared p
  where not exists(select 1 from erp_sales_history_continuation.terminal t where t.batch_id=p.batch_id)
  order by p.prepared_at,p.batch_id limit 1;
 if pending is not null then return erp_sales_history_continuation.envelope(pending,'pending_existing');end if;
 at_time:=clock_timestamp();
 for s in select r.* from origin_sync.raw_record r where r.entity='sales_orders' and(p_after is null or r.source_id>p_after)
  and not exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id)
  and not exists(select 1 from erp_sales_history_continuation.prepared p where p.residuals @> jsonb_build_array(erp_sales_history_continuation.identity(r)))
  order by r.source_id limit 100 for share of r nowait loop
  scanned:=scanned+1;cursor_id:=s.source_id;
  item:=erp_sales_history_continuation.classify(s);
  if item->'eligible'='true'::jsonb then
   items:=items||jsonb_build_array(item||jsonb_build_object('command_id',gen_random_uuid()));
  else residuals:=residuals||jsonb_build_array(item);end if;
  exit when jsonb_array_length(items)>=p_limit;
 end loop;
 select not exists(select 1 from origin_sync.raw_record r where r.entity='sales_orders' and(cursor_id is null or r.source_id>cursor_id)
  and not exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id)
  and not exists(select 1 from erp_sales_history_continuation.prepared p where p.residuals @> jsonb_build_array(erp_sales_history_continuation.identity(r)))) into reached_end;
 proof:=jsonb_build_object('profile','origin-sales-history-continuation-prepare-v1','batch_id',p_batch_id,'actor',p_user_id,
  'after',p_after,'limit',p_limit,'prepared_at',at_time,'expires_at',at_time+interval '10 minutes',
  'items',items,'residuals',residuals,'scanned',scanned,'next_after',cursor_id,'reached_end_of_pass',reached_end,
  'coverage_certified',false,'native_effects',false,'fiscal_effects',false);
 ph:=encode(sha256(convert_to(proof::text,'UTF8')),'hex');
 insert into erp_sales_history_continuation.prepared(batch_id,actor,request_hash,prepare_hash,prepared_at,expires_at,proof,residuals)
 values(p_batch_id,p_user_id,req,ph,at_time,at_time+interval '10 minutes',proof,residuals);
 if jsonb_array_length(items)=0 then perform erp_sales_history_continuation.finish(p_batch_id,ph,'empty',null,'[]');end if;
 perform erp_sales_history_continuation.require_lease(p_owner,p_scheduler_token);
 perform erp_cutover.require_admin(p_user_id);
 return erp_sales_history_continuation.envelope(p_batch_id);
end $$;

create function public.erp_origin_sales_history_continuation_apply(p_user_id uuid,p_owner uuid,p_scheduler_token uuid,
 p_batch_id uuid,p_prepare_hash text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set lock_timeout='750ms' as $$
declare p erp_sales_history_continuation.prepared;item jsonb;current_item jsonb;s origin_sync.raw_record;
 receipts jsonb:='[]';r jsonb;reason text;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_batch_id is null or p_prepare_hash is null or p_prepare_hash!~'^[a-f0-9]{64}$' then
  raise exception 'sales_history_continuation_request_invalid' using errcode='22023';end if;
 lock table erp_sales_history_continuation.prepared in access share mode nowait;
 lock table erp_sales_history_continuation.terminal,erp_sales_history.snapshot,erp_sales_history.command in row exclusive mode nowait;
 lock table origin_sync.resource_state,origin_sync.raw_record,erp_access.membership,auth.users in access share mode nowait;
 if not pg_try_advisory_xact_lock(174853093,0) then raise exception 'sales_history_continuation_busy' using errcode='55P03';end if;
 select * into p from erp_sales_history_continuation.prepared where batch_id=p_batch_id;
 if not found then raise exception 'sales_history_continuation_not_found' using errcode='P0002';end if;
 if p.actor<>p_user_id or p.prepare_hash<>p_prepare_hash then raise exception 'sales_history_continuation_request_conflict' using errcode='40001';end if;
 perform 1 from erp_access.membership where user_id=p_user_id for share nowait;
 perform 1 from auth.users where id=p_user_id for key share nowait;
 perform erp_cutover.require_admin(p_user_id);
 if exists(select 1 from erp_sales_history_continuation.terminal where batch_id=p_batch_id) then
  return erp_sales_history_continuation.envelope(p_batch_id);end if;
 perform 1 from origin_sync.resource_state where resource='__scheduler__' for share nowait;
 perform erp_sales_history_continuation.require_lease(p_owner,p_scheduler_token);
 if p.expires_at<=clock_timestamp() then reason:='prepared_expired';end if;
 -- Try every original 083 lock before calling unchanged capture(), so no blocking lock upgrade is hidden there.
 for item in select x from jsonb_array_elements(p.proof->'items')x order by x->>'command_id' loop
  if not pg_try_advisory_xact_lock(174853083,hashtext(item->>'command_id')) then raise exception 'sales_history_command_busy' using errcode='55P03';end if;
 end loop;
 for item in select x from jsonb_array_elements(p.proof->'items')x order by x->>'source_id' loop
  if not pg_try_advisory_xact_lock(174853084,hashtext(item->>'source_id')) then raise exception 'sales_history_source_busy' using errcode='55P03';end if;
 end loop;
 perform r.source_id from origin_sync.raw_record r where r.entity='sales_orders' and r.source_id in
  (select x->>'source_id' from jsonb_array_elements(p.proof->'items')x) order by r.source_id for share nowait;
 for item in select x from jsonb_array_elements(p.proof->'items')x loop
  if exists(select 1 from erp_sales_history.snapshot h where h.source_id=item->>'source_id') then reason:=coalesce(reason,'already_captured');end if;
  if exists(select 1 from erp_sales_history.command c where c.command_id=(item->>'command_id')::uuid) then reason:=coalesce(reason,'command_conflict');end if;
  select * into s from origin_sync.raw_record where entity='sales_orders' and source_id=item->>'source_id';
  if not found then reason:=coalesce(reason,'source_missing');
  else current_item:=erp_sales_history_continuation.classify(s);
   if current_item is distinct from item-'command_id' then reason:=coalesce(reason,'source_changed');end if;
  end if;
 end loop;
 if p.expires_at<=clock_timestamp() then reason:=coalesce(reason,'prepared_expired');end if;
 if reason is not null then
  perform erp_sales_history_continuation.finish(p_batch_id,p_prepare_hash,'rejected',reason,'[]');
 else
  for item in select x from jsonb_array_elements(p.proof->'items')x order by x->>'source_id' loop
   r:=public.erp_origin_sales_history_capture(p_user_id,item->>'source_id',item->>'source_hash',item->>'source_version',item->>'snapshot_hash',(item->>'command_id')::uuid);
   receipts:=receipts||jsonb_build_array(r->'receipt');
  end loop;
  perform erp_sales_history_continuation.finish(p_batch_id,p_prepare_hash,'applied',null,receipts);
 end if;
 -- Expiry/revocation during capture rolls back the complete transaction, including the terminal.
 perform erp_sales_history_continuation.require_lease(p_owner,p_scheduler_token);
 perform erp_cutover.require_admin(p_user_id);
 return erp_sales_history_continuation.envelope(p_batch_id);
end $$;

create function public.erp_origin_sales_history_continuation_inventory(p_user_id uuid,p_after text default null,p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare total bigint;missing bigint;cached bigint;items jsonb;
begin
 perform erp_cutover.require_admin(p_user_id);
 if p_limit is null or p_limit not between 1 and 100 or(p_after is not null and length(p_after) not between 1 and 200) then
  raise exception 'sales_history_continuation_request_invalid' using errcode='22023';end if;
 select count(*) into total from erp_sales_history.snapshot;
 select count(*),count(*)filter(where exists(select 1 from erp_sales_history_continuation.prepared p
  where p.residuals @> jsonb_build_array(erp_sales_history_continuation.identity(r)))) into missing,cached
 from origin_sync.raw_record r where r.entity='sales_orders' and not exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id);
 select coalesce(jsonb_agg(erp_sales_history_continuation.classify(s) order by s.source_id),'[]') into items
 from(select r.* from origin_sync.raw_record r where r.entity='sales_orders' and(p_after is null or r.source_id>p_after)
  and not exists(select 1 from erp_sales_history.snapshot h where h.source_id=r.source_id) order by r.source_id limit p_limit)s;
 return jsonb_build_object('profile','origin-sales-history-continuation-inventory-v1','observed_at',statement_timestamp(),
  'snapshot',pg_current_snapshot()::text,'history_count',total,'missing',missing,'cached_invalid',cached,'unclassified_pending',missing-cached,
  'items',items,'eligible_in_page',(select count(*) from jsonb_array_elements(items)x where x->'eligible'='true'::jsonb),
  'next_after',items->-1->>'source_id','native_effects',false,'fiscal_effects',false,'coverage_certified',false);
end $$;

revoke all on all functions in schema erp_sales_history_continuation from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_sales_history_continuation_get(uuid,uuid),
 public.erp_origin_sales_history_continuation_prepare(uuid,uuid,uuid,uuid,text,integer),
 public.erp_origin_sales_history_continuation_apply(uuid,uuid,uuid,uuid,text),
 public.erp_origin_sales_history_continuation_inventory(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.erp_origin_sales_history_continuation_get(uuid,uuid),
 public.erp_origin_sales_history_continuation_prepare(uuid,uuid,uuid,uuid,text,integer),
 public.erp_origin_sales_history_continuation_apply(uuid,uuid,uuid,uuid,text),
 public.erp_origin_sales_history_continuation_inventory(uuid,text,integer) to service_role;
commit;
