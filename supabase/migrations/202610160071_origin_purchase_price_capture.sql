-- Current purchase-detail price observation only. No native purchase/import/stock writes.
begin;

create function origin_sync.validate_purchase_price_capture(p_payload jsonb,p_capture jsonb)
returns void language plpgsql immutable set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p_capture) is distinct from 'object'
  or p_capture->>'profile' is distinct from 'origin-purchase-price-json-v1'
  or p_capture->>'source' is distinct from 'detail'
 then raise exception 'purchase_price_capture_invalid' using errcode='22023';end if;
 -- The bounded token grammar and exact /itens/{index}/valor checks are shared.
 -- This translation validates bytes/numbers only; it does not grant proposal semantics.
 perform origin_sync.validate_price_capture('sales_proposals',p_payload,
  p_capture||jsonb_build_object('profile','origin-price-json-v1'));
end;$$;

-- Retain059 intact for every existing entity and retain the same005/063 ledger.
alter function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) rename to apply_batch_legacy_071;
alter function public.apply_batch_legacy_071(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) set schema origin_sync;
revoke all on function origin_sync.apply_batch_legacy_071(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated,service_role;

create function public.origin_sync_apply_batch(p_resource text,p_entity text,p_owner uuid,p_lease_token uuid,p_batch_id uuid,p_records jsonb,p_checkpoint jsonb,p_expected_checkpoint_version bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare item jsonb;old origin_sync.raw_record%rowtype;h text;v_result jsonb;captures integer:=0;sid text;
begin
 if p_entity is distinct from 'purchase_orders' then
  return origin_sync.apply_batch_legacy_071(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
 end if;
 if p_resource is distinct from 'purchase_orders' then raise exception 'purchase_resource_invalid' using errcode='22023';end if;
 perform 1 from origin_sync.resource_state where resource=p_resource for update;
 if exists(select 1 from origin_sync.batch_inbox where batch_id=p_batch_id) then
  -- Original owner/fence/request hash checked by005/063, including old observations.
  return origin_sync.apply_batch_legacy_059(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
 end if;
 if jsonb_typeof(p_records) is distinct from 'array' then raise exception 'purchase_records_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852901,hashtext(p_entity));
 for item in select value from jsonb_array_elements(p_records) loop
  select * into old from origin_sync.raw_record where entity=p_entity and source_id=item->>'source_id';
  h:=encode(sha256(convert_to(jsonb_build_object('payload',item->'payload','document_links',coalesce(item->'document_links','[]'::jsonb))::text,'UTF8')),'hex');
  if item?'price_capture' then
   perform origin_sync.validate_purchase_price_capture(item->'payload',item->'price_capture');
   sid:=item->>'source_id';
   if jsonb_typeof(item->'source_id') is distinct from 'string' or sid!~'^[1-9][0-9]{0,39}$'
    or jsonb_typeof(item#>'{payload,id}') not in('string','number')
    or item#>>'{payload,id}' is distinct from sid
   then raise exception 'purchase_source_binding_invalid' using errcode='22023';end if;
   -- Do not erase imported backup links because the API detail omitted them.
   if old.document_links is not null and old.document_links<>'[]'::jsonb
    and item->'document_links' is distinct from old.document_links
   then raise exception 'purchase_source_links_required' using errcode='40001';end if;
  elsif old.price_capture is not null and old.version_hash is distinct from h then
   raise exception 'purchase_price_capture_required' using errcode='40001';
  end if;
 end loop;
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
  then raise exception 'lease_expired_during_purchase_capture' using errcode='55000';end if;
  v_result:=v_result||jsonb_build_object('purchase_price_captures',captures);
  update origin_sync.batch_inbox set result=v_result where batch_id=p_batch_id;
 end if;
 return v_result;
end;$$;

-- An enabled071 collector cannot silently use a server without this contract.
create function public.origin_sync_apply_purchase_price_batch(p_resource text,p_entity text,p_owner uuid,p_lease_token uuid,p_batch_id uuid,p_records jsonb,p_checkpoint jsonb,p_expected_checkpoint_version bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_resource is distinct from 'purchase_orders' or p_entity is distinct from 'purchase_orders'
  or jsonb_typeof(p_records) is distinct from 'array'
 then raise exception 'purchase_price_batch_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_records) not between 1 and 100 or exists(select 1 from jsonb_array_elements(p_records) x where jsonb_typeof(x) is distinct from 'object' or not(x?'price_capture'))
 then raise exception 'purchase_price_batch_capture_required' using errcode='22023';end if;
 return public.origin_sync_apply_batch(p_resource,p_entity,p_owner,p_lease_token,p_batch_id,p_records,p_checkpoint,p_expected_checkpoint_version);
end;$$;

revoke all on function origin_sync.validate_purchase_price_capture(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.origin_sync_apply_purchase_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) to service_role;
grant execute on function public.origin_sync_apply_purchase_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint) to service_role;
commit;
