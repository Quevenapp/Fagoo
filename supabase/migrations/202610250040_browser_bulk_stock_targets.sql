-- Discover/count the same exact targets in one pass, rather than thousands
-- of per-document SQL calls. Original observations and source records stay intact.
begin;
create function erp_sync.browser_all_stock_targets()
returns table(entity text,source_id text,product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 with latest as materialized(select distinct on(entity,source_id)entity,source_id,stock_flag,stock_label
  from erp_sync.indicator_observation order by entity,source_id,observed_at desc),
 documents as materialized(select o.*,d.payload from latest o join origin_sync.raw_record d using(entity,source_id) where o.stock_flag is not null),
 products as materialized(select source_id,payload->>'codigo'code from origin_sync.raw_record where entity='products'),
 unique_codes as materialized(select code,min(source_id)source_id from products where nullif(code,'')is not null group by code having count(*)=1),
 warehouses as materialized(select source_id,coalesce(payload->>'descricao',payload->>'nome')name from origin_sync.raw_record where entity='warehouses'),
 unique_warehouses as materialized(select name,min(source_id)source_id from warehouses group by name having count(*)=1),
 items as materialized(select d.entity,d.source_id,d.stock_label,
  coalesce(nullif(i#>>'{produto,id}','0'),nullif(i->>'idProduto','0'))id,
  coalesce(nullif(i->>'codigo',''),nullif(i#>>'{produto,codigo}',''))code
  from documents d cross join lateral jsonb_array_elements(case when d.entity='service_orders'
  then coalesce(nullif(d.payload->'pecas','null'::jsonb),nullif(d.payload->'itens','null'::jsonb),'[]'::jsonb)
  else coalesce(nullif(d.payload->'itens','null'::jsonb),'[]'::jsonb)end)i),
 source_products as materialized(
  select i.entity,i.source_id,i.stock_label,p.source_id product_source_id,p.code product_code from items i join products p on p.source_id=i.id where i.id is not null
  union all
  select i.entity,i.source_id,i.stock_label,p.source_id,p.code from items i join unique_codes p on p.code=i.code where i.id is null),
 histories as materialized(select distinct on(product_source_id,warehouse_source_id)*from erp_sync.stock_history_snapshot
  order by product_source_id,warehouse_source_id,observed_at desc,recorded_at desc,id desc)
 select distinct p.entity,p.source_id,p.product_source_id,p.product_code,w.source_id,w.name from source_products p
 join unique_warehouses w on w.name=substring(p.stock_label from 'Depósito: (.+)$') where nullif(p.product_code,'')is not null
 union
 select d.entity,d.source_id,s.product_source_id,s.product_code,s.warehouse_source_id,s.warehouse_name
 from documents d join erp_sync.browser_stock_origin_edge e on e.entity=d.entity and e.source_id=d.source_id
 and ltrim(d.payload->>'numero','0')=ltrim(e.source_number,'0')
 join histories s on s.id=e.snapshot_id
 join products p on p.source_id=s.product_source_id and p.code=s.product_code
 join warehouses w on w.source_id=s.warehouse_source_id and w.name=s.warehouse_name
 where position('Depósito:'in d.stock_label)=0 or s.warehouse_name=substring(d.stock_label from 'Depósito: (.+)$')
$$;
create or replace function erp_sync.browser_unmapped_count()returns bigint
language sql stable set search_path=pg_catalog as $$
 with latest as materialized(select distinct on(entity,source_id)entity,source_id,stock_flag
 from erp_sync.indicator_observation order by entity,source_id,observed_at desc),
 targets as materialized(select distinct entity,source_id from erp_sync.browser_all_stock_targets())
 select count(*)from latest o where o.stock_flag is not null and not exists(select 1 from targets t where(t.entity,t.source_id)=(o.entity,o.source_id))
$$;
do $$
declare definition text;original text;
begin
 definition:=pg_get_functiondef('erp_sync.browser_enqueue()'::regprocedure);
 original:=$old$from(select distinct on(entity,source_id) * from erp_sync.indicator_observation order by entity,source_id,observed_at desc)o
 cross join lateral erp_sync.browser_stock_targets(o.entity,o.source_id,o.stock_label)t
 where o.stock_flag is not null and not exists$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_bulk_targets_definition_changed';end if;
 execute replace(definition,original,$new$from erp_sync.browser_all_stock_targets()t
 where not exists$new$);
end$$;
revoke all on function erp_sync.browser_all_stock_targets(),erp_sync.browser_unmapped_count()from public,anon,authenticated,service_role;
commit;
