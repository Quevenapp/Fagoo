-- Selective exact HTTP price capture. Current observation only; no ERP writes/backfill.
begin;
alter table origin_sync.raw_record add column price_capture jsonb;
alter table origin_reference_fetch.attempt add column price_capture jsonb;
comment on column origin_sync.raw_record.price_capture is 'Current selective price-token observation, bound to source hash/version. Not a complete HTTP history; null means legacy/unknown.';

create function origin_sync.validate_price_capture(p_entity text,p_payload jsonb,p_capture jsonb)
returns void language plpgsql immutable set search_path=pg_catalog as $$
declare t jsonb;paths text[]:='{}';expected text[]:='{}';path text;parts text[];v jsonb;lex text;n numeric;idx integer;expo text;
begin
 if p_entity not in('products','sales_proposals') or p_entity is null
  or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_capture) is distinct from 'object'
  or (select count(*) from jsonb_object_keys(p_capture))<>4
  or not(p_capture ?& array['profile','response_sha256','source','tokens'])
  or p_capture->>'profile'<>'origin-price-json-v1' or jsonb_typeof(p_capture->'profile')<>'string'
  or jsonb_typeof(p_capture->'response_sha256') is distinct from 'string' or p_capture->>'response_sha256'!~'^[0-9a-f]{64}$'
  or jsonb_typeof(p_capture->'source') is distinct from 'string' or p_capture->>'source' not in('detail','list_fallback')
  or (p_entity='sales_proposals' and p_capture->>'source'<>'detail')
  or jsonb_typeof(p_capture->'tokens') is distinct from 'array' or octet_length(p_capture::text)>131072
 then raise exception 'price_capture_invalid' using errcode='22023';end if;
 if p_capture->>'source'='list_fallback' and p_payload->'_brufap_source' is distinct from '{"deleted":true,"detail_available":false}'::jsonb
 then raise exception 'price_capture_fallback_invalid' using errcode='22023';end if;
 if p_entity='products' and jsonb_typeof(p_payload->'preco')='number' then expected:=array['/preco'];end if;
 if p_entity='sales_proposals' and jsonb_typeof(p_payload->'itens')='array' then
  select coalesce(array_agg('/itens/'||(ordinality-1)::text||'/valor' order by ordinality),'{}') into expected
   from jsonb_array_elements(p_payload->'itens') with ordinality x(value,ordinality) where jsonb_typeof(value->'valor')='number';
 end if;
 for t in select value from jsonb_array_elements(p_capture->'tokens') loop
  if jsonb_typeof(t) is distinct from 'object' or (select count(*) from jsonb_object_keys(t))<>2 or not(t ?& array['path','lexeme'])
   or jsonb_typeof(t->'path') is distinct from 'string' or jsonb_typeof(t->'lexeme') is distinct from 'string'
  then raise exception 'price_capture_token_invalid' using errcode='22023';end if;
  path:=t->>'path';lex:=t->>'lexeme';
  if not(path=any(expected)) or path=any(paths) or length(lex)>128
   or lex!~'^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]{1,3})?$'
  then raise exception 'price_capture_token_invalid' using errcode='22023';end if;
  expo:=substring(lex from '[eE]([+-]?[0-9]+)$');
  if expo is not null and abs(expo::integer)>128 then raise exception 'price_capture_token_limit' using errcode='22023';end if;
  n:=lex::numeric;
  if length(trim_scale(n)::text)>256 then raise exception 'price_capture_token_limit' using errcode='22023';end if;
  parts:=string_to_array(substring(path from 2),'/');v:=p_payload#>parts;
  if jsonb_typeof(v) is distinct from 'number' or (v#>>'{}') is distinct from trim_scale(n)::text then raise exception 'price_capture_token_mismatch' using errcode='22023';end if;
  paths:=array_append(paths,path);
 end loop;
 if cardinality(paths)<>cardinality(expected) then raise exception 'price_capture_token_missing' using errcode='22023';end if;
end;$$;

-- Keep the exact old implementation and replay ledger, without an exposed bypass.
alter function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) rename to apply_batch_legacy_059;
alter function public.apply_batch_legacy_059(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) set schema origin_sync;
revoke all on function origin_sync.apply_batch_legacy_059(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated,service_role;

create function public.origin_sync_apply_batch(p_resource text,p_entity text,p_owner uuid,p_lease_token uuid,p_batch_id uuid,p_records jsonb,p_checkpoint jsonb,p_expected_checkpoint_version bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare item jsonb;old origin_sync.raw_record%rowtype;h text;v_result jsonb;captures integer:=0;
begin
 -- Same lock order as005. A committed legacy/new request is replayed verbatim.
 perform 1 from origin_sync.resource_state where resource=p_resource for update;
 if exists(select 1 from origin_sync.batch_inbox where batch_id=p_batch_id) then
  return origin_sync.apply_batch_legacy_059(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
 end if;
 if p_entity in('products','sales_proposals') and jsonb_typeof(p_records)='array' then
  perform pg_advisory_xact_lock(174852901,hashtext(p_entity));
  for item in select value from jsonb_array_elements(p_records) loop
   if item?'price_capture' then perform origin_sync.validate_price_capture(p_entity,item->'payload',item->'price_capture');
   else
    select * into old from origin_sync.raw_record where entity=p_entity and source_id=item->>'source_id';
    h:=encode(sha256(convert_to(jsonb_build_object('payload',item->'payload','document_links',coalesce(item->'document_links','[]'::jsonb))::text,'UTF8')),'hex');
    if old.price_capture is not null and old.version_hash is distinct from h then
     raise exception 'price_capture_required' using errcode='40001';
    end if;
   end if;
  end loop;
 elsif jsonb_typeof(p_records)='array' and exists(select 1 from jsonb_array_elements(p_records) x where x?'price_capture') then
  raise exception 'price_capture_entity_invalid' using errcode='22023';
 end if;
 v_result:=origin_sync.apply_batch_legacy_059(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
 for item in select value from jsonb_array_elements(p_records) loop
  if item?'price_capture' then
   h:=encode(sha256(convert_to(jsonb_build_object('payload',item->'payload','document_links',coalesce(item->'document_links','[]'::jsonb))::text,'UTF8')),'hex');
   update origin_sync.raw_record set price_capture=(item->'price_capture')||jsonb_build_object('source_hash',version_hash,'source_version',version::text,'capture_id',p_batch_id,'observed_at',clock_timestamp())
    where entity=p_entity and source_id=item->>'source_id' and version_hash=h;
   if found then captures:=captures+1;end if;
  end if;
 end loop;
 if captures>0 then
  if not exists(select 1 from origin_sync.resource_state where resource=p_resource and lease_owner=p_owner and lease_token=p_lease_token and lease_expires_at>clock_timestamp())
  then raise exception 'lease_expired_during_price_capture' using errcode='55000';end if;
  v_result:=v_result||jsonb_build_object('price_captures',captures);
  update origin_sync.batch_inbox set result=v_result where batch_id=p_batch_id;
 end if;
 return v_result;
end;$$;

-- Explicit entry point: an enabled worker cannot silently write through pre059 SQL.
create function public.origin_sync_apply_price_batch(p_resource text,p_entity text,p_owner uuid,p_lease_token uuid,p_batch_id uuid,p_records jsonb,p_checkpoint jsonb,p_expected_checkpoint_version bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_entity is null or p_entity not in('products','sales_proposals') or jsonb_typeof(p_records) is distinct from 'array'
 then raise exception 'price_batch_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_records) not between 1 and 100 or exists(select 1 from jsonb_array_elements(p_records) x where jsonb_typeof(x) is distinct from 'object' or not(x?'price_capture'))
 then raise exception 'price_batch_capture_required' using errcode='22023';end if;
 return public.origin_sync_apply_batch(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
end;$$;

create function public.origin_sync_reference_finish_precise(p_owner uuid,p_lease_token uuid,p_resource_token uuid,p_attempt_id uuid,p_payload jsonb,p_price_capture jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;a origin_reference_fetch.attempt%rowtype;
begin
 perform origin_sync.validate_price_capture('products',p_payload,p_price_capture);
 if p_price_capture->>'source'<>'detail' then raise exception 'price_capture_detail_required' using errcode='22023';end if;
 --Same056 lock order. Capture while pending; its terminal-attempt trigger stays intact.
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 select * into a from origin_reference_fetch.attempt where id=p_attempt_id for update;
 if not found or a.owner<>p_owner or a.scheduler_fence<>p_lease_token or a.resource_fence<>p_resource_token
 then raise exception 'reference_attempt_missing' using errcode='55000';end if;
 if a.entity<>'products' then raise exception 'price_capture_entity_invalid' using errcode='22023';end if;
 if a.state='pending' then
  if a.price_capture is not null and a.price_capture is distinct from p_price_capture then raise exception 'price_capture_replay_conflict' using errcode='40001';end if;
  update origin_reference_fetch.attempt set price_capture=p_price_capture where id=p_attempt_id;
 end if;
 result:=public.origin_sync_reference_finish(p_owner,p_lease_token,p_resource_token,p_attempt_id,p_payload);
 if (result->>'replayed')::boolean then
  if a.price_capture is distinct from p_price_capture then raise exception 'price_capture_replay_conflict' using errcode='40001';end if;
  return result;
 end if;
 if (result->>'stored')::boolean then
  select * into a from origin_reference_fetch.attempt where id=p_attempt_id;
  update origin_sync.raw_record set price_capture=p_price_capture||jsonb_build_object('source_hash',version_hash,'source_version',version::text,'capture_id',p_attempt_id,'observed_at',clock_timestamp())
   where entity='products' and source_id=a.source_id and version_hash=a.result_hash;
  if not found then raise exception 'price_capture_result_conflict' using errcode='40001';end if;
 end if;
 perform origin_reference_fetch.require_leases(p_owner,p_lease_token,p_resource_token);
 return result;
end;$$;

revoke all on function origin_sync.validate_price_capture(text,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.origin_sync_reference_finish_precise(uuid,uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.origin_sync_apply_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) to service_role;
grant execute on function public.origin_sync_reference_finish_precise(uuid,uuid,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.origin_sync_apply_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) to service_role;
commit;
