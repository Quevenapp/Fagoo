-- Bounded read-only Origin migration ingestion. No new tables or native ERP writes.
begin;

create function origin_sync.migration_entity(p_resource text) returns text
language plpgsql immutable set search_path=pg_catalog as $$
begin
 return case
  when p_resource in('contacts','contacts_deleted') then 'contacts'
  when p_resource in('products_zero','products_positive','products_negative','products_deleted_zero','products_deleted_positive','products_deleted_negative') then 'products'
  when p_resource in('nfe_in','nfe_out','nfe_in_cancelled','nfe_out_cancelled') then 'nfe'
  when p_resource in('payment_methods_active','payment_methods_inactive') then 'payment_methods'
  when p_resource in('sellers','sellers_deleted') then 'sellers'
  when p_resource in('warehouses_active','warehouses_inactive') then 'warehouses'
  when p_resource in('cash_entries_registered','cash_entries_deleted') then 'cash_entries'
  when p_resource in('sales_orders','sales_proposals','purchase_orders','receivables','payables','nfce',
    'service_orders','product_categories','financial_categories','ledger_accounts','stock_balances') then p_resource
  else null end;
end;$$;

create function origin_sync.migration_require_leases(p_resource text,p_owner uuid,p_scheduler_token uuid,p_resource_token uuid)
returns void language plpgsql volatile set search_path=pg_catalog as $$
begin
 if p_owner is null or p_scheduler_token is null or p_resource_token is null
  or not exists(select 1 from origin_sync.resource_state where resource='__scheduler__'
   and lease_owner=p_owner and lease_token=p_scheduler_token and lease_expires_at>clock_timestamp())
  or not exists(select 1 from origin_sync.resource_state where resource=p_resource
   and lease_owner=p_owner and lease_token=p_resource_token and lease_expires_at>clock_timestamp())
 then raise exception 'migration_leases_required' using errcode='55000';end if;
end;$$;

create function origin_sync.migration_source_metadata(p_entity text,p_ids jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'source_id',i.id,'exists',r.source_id is not null,'source_hash',r.version_hash,
  'source_version',r.version::text,
  'last_seen_at',to_char(r.last_seen_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'document_links',r.document_links) order by i.id collate "C"),'[]'::jsonb)
 from jsonb_array_elements_text(p_ids)i(id)
 left join origin_sync.raw_record r on r.entity=p_entity and r.source_id=i.id;
$$;

create function public.origin_sync_migration_sources(p_resource text,p_owner uuid,p_scheduler_token uuid,p_resource_token uuid,p_ids jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare entity text;result jsonb;
begin
 entity:=origin_sync.migration_entity(p_resource);
 if entity is null or jsonb_typeof(p_ids) is distinct from 'array' then
  raise exception 'migration_source_query_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_ids)>100 or exists(select 1 from jsonb_array_elements(p_ids)x
   where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[1-9][0-9]{0,39}$')
  or(select count(*)from jsonb_array_elements_text(p_ids))<>(select count(distinct x)from jsonb_array_elements_text(p_ids)x)
 then raise exception 'migration_source_ids_invalid' using errcode='22023';end if;
 perform origin_sync.migration_require_leases(p_resource,p_owner,p_scheduler_token,p_resource_token);
 result:=origin_sync.migration_source_metadata(entity,p_ids);
 if octet_length(result::text)>786432 then raise exception 'migration_metadata_size_limit' using errcode='22023';end if;
 perform origin_sync.migration_require_leases(p_resource,p_owner,p_scheduler_token,p_resource_token);
 return result;
end;$$;

create function public.origin_sync_migration_apply(p_resource text,p_entity text,p_owner uuid,
 p_scheduler_token uuid,p_resource_token uuid,p_batch_id uuid,p_records jsonb,p_checkpoint jsonb,
 p_expected_checkpoint_version bigint,p_expected_sources jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 ids jsonb;record_ids jsonb;expected jsonb;actual jsonb;input_hash text;guard_hash text;cp jsonb;records jsonb:='[]';
 item jsonb;old origin_sync.raw_record%rowtype;prior origin_sync.batch_inbox%rowtype;v_result jsonb;
begin
 if p_entity is distinct from origin_sync.migration_entity(p_resource) or p_entity is null
  or p_owner is null or p_scheduler_token is null or p_resource_token is null or p_batch_id is null
  or p_expected_checkpoint_version is null or p_expected_checkpoint_version<0
  or jsonb_typeof(p_records) is distinct from 'array' or jsonb_typeof(p_checkpoint) is distinct from 'object'
  or jsonb_typeof(p_expected_sources) is distinct from 'array'
 then raise exception 'migration_apply_arguments_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_records)>25 or jsonb_array_length(p_expected_sources)>25
  or jsonb_array_length(p_expected_sources)<jsonb_array_length(p_records)
  or octet_length(p_records::text)>10485760 or octet_length(p_checkpoint::text)>62000
  or octet_length(p_expected_sources::text)>786432
 then raise exception 'migration_apply_size_limit' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_records) loop
  if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'source_id') is distinct from 'string'
   or item->>'source_id'!~'^[1-9][0-9]{0,39}$' or jsonb_typeof(item->'payload') is distinct from 'object'
   or jsonb_typeof(item->'document_links') is distinct from 'array'
   or exists(select 1 from jsonb_object_keys(item)k where k not in('source_id','payload','document_links','price_capture'))
   or(case when p_entity='stock_balances' then item#>>'{payload,produto,id}' else item#>>'{payload,id}'end) is distinct from item->>'source_id'
  then raise exception 'migration_record_invalid' using errcode='22023';end if;
 end loop;
 select coalesce(jsonb_agg(to_jsonb(id)order by id collate "C"),'[]')into record_ids
 from(select value->>'source_id'id from jsonb_array_elements(p_records))s;
 if jsonb_array_length(record_ids)<>(select count(distinct value)from jsonb_array_elements_text(record_ids))then
  raise exception 'migration_duplicate_source' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_expected_sources)loop
  if jsonb_typeof(item) is distinct from 'object' or(select count(*)from jsonb_object_keys(item))<>6
   or not(item ?& array['source_id','exists','source_hash','source_version','last_seen_at','document_links'])
   or jsonb_typeof(item->'source_id') is distinct from 'string' or item->>'source_id'!~'^[1-9][0-9]{0,39}$'
   or jsonb_typeof(item->'exists') is distinct from 'boolean'
  then raise exception 'migration_expected_source_invalid' using errcode='22023';end if;
 end loop;
 select coalesce(jsonb_agg(value order by value->>'source_id' collate "C"),'[]')into expected from jsonb_array_elements(p_expected_sources);
 select coalesce(jsonb_agg(to_jsonb(value->>'source_id')order by value->>'source_id' collate "C"),'[]')into ids from jsonb_array_elements(expected);
 if jsonb_array_length(ids)<>(select count(distinct value)from jsonb_array_elements_text(ids))
  or exists(select 1 from jsonb_array_elements_text(record_ids)r(id)where not(ids ? r.id))
  or exists(select 1 from jsonb_array_elements(expected)e where not(record_ids ? (e->>'source_id'))and e->'exists' is distinct from 'true'::jsonb)
 then raise exception 'migration_expected_identity_mismatch' using errcode='22023';end if;
 input_hash:=encode(sha256(convert_to(jsonb_build_object('resource',p_resource,'entity',p_entity,'owner',p_owner,
  'scheduler_token',p_scheduler_token,'resource_token',p_resource_token,'batch_id',p_batch_id,
  'records',p_records,'checkpoint',p_checkpoint,'expected_version',p_expected_checkpoint_version,'expected_sources',expected)::text,'UTF8')),'hex');
 -- Replay authenticates the original entire request. It never compares old CAS values to new data.
 perform 1 from origin_sync.resource_state where resource=p_resource for update nowait;
 select * into prior from origin_sync.batch_inbox where batch_id=p_batch_id;
 if found then
  if prior.resource is distinct from p_resource or prior.entity is distinct from p_entity
   or prior.owner is distinct from p_owner or prior.lease_token is distinct from p_resource_token
   or prior.result#>>'{migration_receipt,request_sha256}' is distinct from input_hash
  then raise exception 'migration_batch_reused_with_different_request' using errcode='22023';end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 perform 1 from origin_sync.resource_state where resource='__scheduler__' for update nowait;
 perform origin_sync.migration_require_leases(p_resource,p_owner,p_scheduler_token,p_resource_token);
 -- Protect both existing rows and absent IDs against any concurrent writer, without waiting.
 if jsonb_array_length(ids)>0 then
  lock table origin_sync.raw_record in share row exclusive mode nowait;
 end if;
 if not pg_try_advisory_xact_lock(174852901,hashtext(p_entity))then
  raise exception 'migration_source_busy' using errcode='55P03';end if;
 perform 1 from origin_sync.raw_record where entity=p_entity and source_id in(select jsonb_array_elements_text(ids))
  order by source_id collate "C" for update nowait;
 actual:=origin_sync.migration_source_metadata(p_entity,ids);
 if actual is distinct from expected then raise exception 'migration_source_changed' using errcode='40001';end if;
 for item in select value from jsonb_array_elements(p_records)loop
  select * into old from origin_sync.raw_record where entity=p_entity and source_id=item->>'source_id';
  if item->'document_links' is distinct from coalesce(old.document_links,'[]'::jsonb)then
   raise exception 'migration_source_links_changed' using errcode='40001';end if;
  if p_entity in('service_orders','warehouses','product_categories','financial_categories','ledger_accounts','cash_entries','stock_balances')then
   if old.source_updated_at is not null then raise exception 'migration_extra_source_date_unsupported' using errcode='40001';end if;
  elsif old.source_id is not null then item:=item||jsonb_build_object('source_updated_at',old.source_updated_at);end if;
  records:=records||jsonb_build_array(item);
 end loop;
 guard_hash:=encode(sha256(convert_to(expected::text,'UTF8')),'hex');
 cp:=p_checkpoint||jsonb_build_object('_migration_guard',jsonb_build_object('profile','origin-migration-source-guard-v1',
  'request_sha256',input_hash,'sources_sha256',guard_hash));
 v_result:=public.origin_sync_apply_batch(p_resource,p_entity,p_owner,p_resource_token,p_batch_id,records,cp,p_expected_checkpoint_version);
 perform origin_sync.migration_require_leases(p_resource,p_owner,p_scheduler_token,p_resource_token);
 v_result:=v_result||jsonb_build_object('migration_receipt',jsonb_build_object('profile','origin-migration-receipt-v1',
  'request_sha256',input_hash,'sources_sha256',guard_hash,'records',jsonb_array_length(records),
  'source_ids',record_ids,'guarded_source_ids',ids,'migration_checkpoint',p_checkpoint->'migration','observed_at',clock_timestamp()));
 update origin_sync.batch_inbox set result=v_result where batch_id=p_batch_id;
 return v_result;
end;$$;

revoke all on function origin_sync.migration_entity(text) from public,anon,authenticated,service_role;
revoke all on function origin_sync.migration_require_leases(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function origin_sync.migration_source_metadata(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_migration_sources(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_migration_apply(text,text,uuid,uuid,uuid,uuid,jsonb,jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.origin_sync_migration_sources(text,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.origin_sync_migration_apply(text,text,uuid,uuid,uuid,uuid,jsonb,jsonb,bigint,jsonb) to service_role;
commit;
