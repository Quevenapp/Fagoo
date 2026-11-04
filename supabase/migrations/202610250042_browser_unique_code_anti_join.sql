-- Express uniqueness as an anti-join so PostgreSQL does not estimate a single
-- unique SKU and repeatedly rescan all document items for each real SKU.
begin;
do $$
declare definition text;original text;
begin
 definition:=pg_get_functiondef('erp_sync.browser_all_stock_targets()'::regprocedure);
 original:=$old$unique_codes as materialized(select code,min(source_id)source_id from products where nullif(code,'')is not null group by code having count(*)=1)$old$;
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_unique_code_definition_changed';end if;
 execute replace(definition,original,$new$unique_codes as materialized(select p.code,p.source_id from products p where nullif(p.code,'')is not null
  and not exists(select 1 from products duplicate where duplicate.code=p.code and duplicate.source_id<>p.source_id))$new$);
end$$;
commit;
