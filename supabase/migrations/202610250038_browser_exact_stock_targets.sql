-- Recover stock lookup targets from exact, immutable observed origin IDs.
-- This only projects observations; it does not edit source documents or ledgers.
begin;
create table erp_sync.browser_stock_origin_edge(
 snapshot_id uuid not null references erp_sync.stock_history_snapshot,
 entity text not null check(entity in('sales_orders','purchase_orders','service_orders','nfe','nfce')),
 source_id text not null check(source_id~'^[1-9][0-9]{0,39}$'),
 source_number text not null check(source_number~'^[0-9]{1,20}$'),
 primary key(snapshot_id,entity,source_id,source_number)
);
create index browser_stock_origin_lookup on erp_sync.browser_stock_origin_edge(entity,source_id,snapshot_id);
alter table erp_sync.browser_stock_origin_edge enable row level security;
revoke all on erp_sync.browser_stock_origin_edge from public,anon,authenticated,service_role;
create trigger browser_stock_origin_edge_immutable before update or delete on erp_sync.browser_stock_origin_edge for each row execute function erp_sync.indicator_observation_immutable();
create function erp_sync.browser_record_origin_edges()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 insert into erp_sync.browser_stock_origin_edge(snapshot_id,entity,source_id,source_number)
 select distinct new.id,x->>'origin_entity',x->>'origin_source_id',x->>'origin_number'
 from jsonb_array_elements(new.items)x where x->>'origin_entity'in('sales_orders','purchase_orders','service_orders','nfe','nfce')
 and x->>'origin_source_id'~'^[1-9][0-9]{0,39}$'and x->>'origin_number'~'^[0-9]{1,20}$'on conflict do nothing;
 return new;
end$$;
create trigger browser_record_origin_edges after insert on erp_sync.stock_history_snapshot for each row execute function erp_sync.browser_record_origin_edges();
insert into erp_sync.browser_stock_origin_edge(snapshot_id,entity,source_id,source_number)
 select distinct s.id,x->>'origin_entity',x->>'origin_source_id',x->>'origin_number'
 from erp_sync.stock_history_snapshot s cross join lateral jsonb_array_elements(s.items)x
 where x->>'origin_entity'in('sales_orders','purchase_orders','service_orders','nfe','nfce')
 and x->>'origin_source_id'~'^[1-9][0-9]{0,39}$'and x->>'origin_number'~'^[0-9]{1,20}$'on conflict do nothing;

create function erp_sync.browser_origin_targets(p_entity text,p_source text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 select distinct s.product_source_id,s.product_code,s.warehouse_source_id,s.warehouse_name
 from erp_sync.browser_stock_origin_edge e join erp_sync.stock_history_snapshot s on s.id=e.snapshot_id
 join origin_sync.raw_record d on d.entity=e.entity and d.source_id=e.source_id and ltrim(d.payload->>'numero','0')=ltrim(e.source_number,'0')
 join origin_sync.raw_record p on p.entity='products'and p.source_id=s.product_source_id and p.payload->>'codigo'=s.product_code
 join origin_sync.raw_record w on w.entity='warehouses'and w.source_id=s.warehouse_source_id and coalesce(w.payload->>'descricao',w.payload->>'nome')=s.warehouse_name
 where e.entity=p_entity and e.source_id=p_source and not exists(
  select 1 from erp_sync.stock_history_snapshot newer where newer.product_source_id=s.product_source_id and newer.warehouse_source_id=s.warehouse_source_id
  and(newer.observed_at,newer.recorded_at,newer.id)>(s.observed_at,s.recorded_at,s.id))
$$;
alter function erp_sync.indicator_products(text,text)rename to indicator_products_from_source;
create function erp_sync.indicator_products(p_entity text,p_source text)returns table(source_id text,code text)
language sql stable set search_path=pg_catalog as $$
 select source_id,code from erp_sync.indicator_products_from_source(p_entity,p_source)
 union select product_source_id,product_code from erp_sync.browser_origin_targets(p_entity,p_source)
$$;
create function erp_sync.browser_stock_targets(p_entity text,p_source text,p_label text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 -- The explicit tooltip warehouse applies to the source item targets.
 select p.source_id,p.code,w.source_id,coalesce(w.payload->>'descricao',w.payload->>'nome')
 from erp_sync.indicator_products_from_source(p_entity,p_source)p join origin_sync.raw_record w on w.entity='warehouses'
 and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(p_label from 'Depósito: (.+)$')
 and(select count(*)from origin_sync.raw_record w2 where w2.entity='warehouses'and coalesce(w2.payload->>'descricao',w2.payload->>'nome')=substring(p_label from 'Depósito: (.+)$'))=1
 union
 -- A missing tooltip warehouse can be recovered only per observed product/warehouse pair.
 -- An explicit conflicting warehouse is never overridden by old history.
 select *from erp_sync.browser_origin_targets(p_entity,p_source)t where position('Depósito:'in p_label)=0
 or t.warehouse_name=substring(p_label from 'Depósito: (.+)$')
$$;
do $$
declare definition text;original text;replacement text;
begin
 definition:=pg_get_functiondef('erp_sync.browser_enqueue()'::regprocedure);
 original:=$old$select distinct 'H:'||p.source_id||':'||w.source_id,'stock_history',jsonb_build_object('product_source_id',p.source_id,'product_code',p.code,'warehouse_source_id',w.source_id)
 from(select distinct on(entity,source_id) * from erp_sync.indicator_observation order by entity,source_id,observed_at desc)o
 cross join lateral erp_sync.indicator_products(o.entity,o.source_id)p
 join origin_sync.raw_record w on w.entity='warehouses' and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(o.stock_label from 'Depósito: (.+)$')
 where o.stock_flag is not null and not exists(select 1 from erp_sync.browser_job j where j.job_key='H:'||p.source_id||':'||w.source_id)$old$;
 replacement:=$new$select distinct 'H:'||t.product_source_id||':'||t.warehouse_source_id,'stock_history',jsonb_build_object('product_source_id',t.product_source_id,'product_code',t.product_code,'warehouse_source_id',t.warehouse_source_id)
 from(select distinct on(entity,source_id) * from erp_sync.indicator_observation order by entity,source_id,observed_at desc)o
 cross join lateral erp_sync.browser_stock_targets(o.entity,o.source_id,o.stock_label)t
 where o.stock_flag is not null and not exists(select 1 from erp_sync.browser_job j where j.job_key='H:'||t.product_source_id||':'||t.warehouse_source_id)$new$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_exact_targets_definition_changed';end if;
 execute replace(definition,original,replacement);
end$$;
create or replace function erp_sync.browser_unmapped_count()returns bigint
language sql stable set search_path=pg_catalog as $$
 with latest as materialized(select distinct on(entity,source_id)entity,source_id,stock_flag,stock_label from erp_sync.indicator_observation order by entity,source_id,observed_at desc)
 select count(*)from latest o where o.stock_flag is not null and not exists(select 1 from erp_sync.browser_stock_targets(o.entity,o.source_id,o.stock_label))
$$;
revoke all on function erp_sync.browser_record_origin_edges(),erp_sync.browser_origin_targets(text,text),erp_sync.indicator_products_from_source(text,text),erp_sync.indicator_products(text,text),erp_sync.browser_stock_targets(text,text,text),erp_sync.browser_unmapped_count()from public,anon,authenticated,service_role;
-- Retain the normal shared status cache; refresh once, without running the writer.
select erp_sync.browser_refresh_mapping_status(true);
commit;
