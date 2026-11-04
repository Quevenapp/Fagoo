-- Preserve observed production origins without inventing a native document link.
begin;
create table erp_sync.browser_stock_origin_gap(
 snapshot_id uuid not null references erp_sync.stock_history_snapshot,
 entity text not null check(entity='production_orders'),
 source_id text not null check(source_id~'^[1-9][0-9]{0,39}$'),
 source_number text check(source_number~'^[0-9]{1,20}$'),
 primary key(snapshot_id,entity,source_id)
);
alter table erp_sync.browser_stock_origin_gap enable row level security;
revoke all on erp_sync.browser_stock_origin_gap from public,anon,authenticated,service_role;
create trigger browser_stock_origin_gap_immutable before update or delete on erp_sync.browser_stock_origin_gap for each row execute function erp_sync.indicator_observation_immutable();
create function erp_sync.browser_record_origin_gaps()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 insert into erp_sync.browser_stock_origin_gap(snapshot_id,entity,source_id,source_number)
 select distinct new.id,x->>'unmapped_origin_entity',x->>'unmapped_origin_source_id',x->>'unmapped_origin_number'
 from jsonb_array_elements(new.items)x where x->>'unmapped_origin_entity'is not null on conflict do nothing;
 return new;
end$$;
create trigger browser_record_origin_gaps after insert on erp_sync.stock_history_snapshot for each row execute function erp_sync.browser_record_origin_gaps();
do $$
declare definition text;original text:=$old$foreach h in array array['quantity','sale_price','purchase_price','cost_price']loop$old$;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_origin_gap_definition_changed';end if;
 execute replace(definition,original,$new$if x ?| array['unmapped_origin_entity','unmapped_origin_source_id','unmapped_origin_number']then
    if not(x ?& array['unmapped_origin_entity','unmapped_origin_source_id','unmapped_origin_number'])
     or x->>'unmapped_origin_entity'is distinct from'production_orders'
     or coalesce(x->>'unmapped_origin_source_id','')!~'^[1-9][0-9]{0,39}$'
     or(x->>'unmapped_origin_number'is not null and x->>'unmapped_origin_number'!~'^[0-9]{1,20}$')
     or x->>'origin_entity'is not null or x->>'origin_source_id'is not null or x->>'origin_number'is not null
    then raise exception 'browser_history_origin_gap_invalid'using errcode='22023';end if;
   end if;
   foreach h in array array['quantity','sale_price','purchase_price','cost_price']loop$new$);
end$$;
create or replace function erp_sync.indicator_integration_gaps()returns jsonb
language sql stable security definer set search_path=pg_catalog as $$
 select case when count(*)=0 then'[]'::jsonb else jsonb_build_array(jsonb_build_object(
 'code','STOCK_PRODUCTION_ORIGIN_LINK_PENDING','records',count(distinct g.source_id),
 'last_observed_at',max(s.observed_at),'state','implementation_pending','automatic_retry',false))end
 from erp_sync.browser_stock_origin_gap g join erp_sync.stock_history_snapshot s on s.id=g.snapshot_id
$$;
revoke all on function erp_sync.browser_record_origin_gaps(),erp_sync.indicator_integration_gaps()from public,anon,authenticated,service_role;
commit;
