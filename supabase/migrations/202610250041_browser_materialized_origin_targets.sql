-- Avoid a planner under-estimate that cross-joined every document/history before
-- looking up the origin edge. Qualify histories first and materialize exact edges.
begin;
do $$
declare definition text;original text;replacement text;
begin
 definition:=pg_get_functiondef('erp_sync.browser_all_stock_targets()'::regprocedure);
 original:=$old$histories as materialized(select distinct on(product_source_id,warehouse_source_id)*from erp_sync.stock_history_snapshot
  order by product_source_id,warehouse_source_id,observed_at desc,recorded_at desc,id desc)$old$;
 replacement:=$new$histories as materialized(select distinct on(product_source_id,warehouse_source_id)id,product_source_id,warehouse_source_id,product_code,warehouse_name from erp_sync.stock_history_snapshot
  order by product_source_id,warehouse_source_id,observed_at desc,recorded_at desc,id desc),
 valid_histories as materialized(select s.*from histories s
  where exists(select 1 from products p where p.source_id=s.product_source_id and p.code=s.product_code)
  and exists(select 1 from warehouses w where w.source_id=s.warehouse_source_id and w.name=s.warehouse_name)),
 origins as materialized(select e.entity,e.source_id,e.source_number,s.product_source_id,s.product_code,s.warehouse_source_id,s.warehouse_name
  from valid_histories s join erp_sync.browser_stock_origin_edge e on e.snapshot_id=s.id)$new$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_materialized_history_definition_changed';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$from documents d join erp_sync.browser_stock_origin_edge e on e.entity=d.entity and e.source_id=d.source_id
 and ltrim(d.payload->>'numero','0')=ltrim(e.source_number,'0')
 join histories s on s.id=e.snapshot_id
 join products p on p.source_id=s.product_source_id and p.code=s.product_code
 join warehouses w on w.source_id=s.warehouse_source_id and w.name=s.warehouse_name$old$;
 replacement:=$new$from documents d join origins s on s.entity=d.entity and s.source_id=d.source_id
 and ltrim(d.payload->>'numero','0')=ltrim(s.source_number,'0')$new$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_materialized_origin_definition_changed';end if;
 execute replace(definition,original,replacement);
end$$;
commit;
