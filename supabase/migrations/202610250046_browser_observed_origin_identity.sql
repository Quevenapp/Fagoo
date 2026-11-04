-- A raw archive is not the only existing proof of a document's identity.
-- When it is absent, require the latest exact ID/number seen in the document
-- list AND the same exact origin ID/number in the latest product history.
-- A present raw record always wins, including when it contradicts observation.
begin;
create or replace function erp_sync.browser_origin_targets(p_entity text,p_source text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 with observed as materialized(select source_number from erp_sync.indicator_observation where entity=p_entity and source_id=p_source order by observed_at desc limit 1)
 select distinct s.product_source_id,s.product_code,s.warehouse_source_id,s.warehouse_name
 from erp_sync.browser_stock_origin_edge e join erp_sync.stock_history_snapshot s on s.id=e.snapshot_id
 left join origin_sync.raw_record d on d.entity=e.entity and d.source_id=e.source_id
 left join observed o on true
 join origin_sync.raw_record p on p.entity='products'and p.source_id=s.product_source_id and p.payload->>'codigo'=s.product_code
 join origin_sync.raw_record w on w.entity='warehouses'and w.source_id=s.warehouse_source_id and coalesce(w.payload->>'descricao',w.payload->>'nome')=s.warehouse_name
 where e.entity=p_entity and e.source_id=p_source
 and ltrim(case when d.source_id is null then o.source_number else d.payload->>'numero'end,'0')=ltrim(e.source_number,'0')
 and not exists(select 1 from erp_sync.stock_history_snapshot newer where newer.product_source_id=s.product_source_id and newer.warehouse_source_id=s.warehouse_source_id
 and(newer.observed_at,newer.recorded_at,newer.id)>(s.observed_at,s.recorded_at,s.id))
$$;
do $$declare definition text;original text;begin
 definition:=pg_get_functiondef('erp_sync.browser_all_stock_targets()'::regprocedure);
 original:='entity,source_id,stock_flag,stock_label';
 definition:=replace(definition,original,'entity,source_id,source_number,stock_flag,stock_label');
 original:='documents as materialized(select o.*,d.payload from latest o join origin_sync.raw_record d using(entity,source_id) where o.stock_flag is not null)';
 if position(original in definition)=0 then raise exception 'browser_observed_document_definition_changed';end if;
 definition:=replace(definition,original,$new$documents as materialized(select o.*,coalesce(d.payload,'{}'::jsonb)payload,
  case when d.source_id is null then o.source_number else d.payload->>'numero'end document_number
  from latest o left join origin_sync.raw_record d using(entity,source_id) where o.stock_flag is not null)$new$);
 original:='ltrim(d.payload->>''numero'',''0'')=ltrim(s.source_number,''0'')';
 if position(original in definition)=0 then raise exception 'browser_observed_origin_definition_changed';end if;
 execute replace(definition,original,'ltrim(d.document_number,''0'')=ltrim(s.source_number,''0'')');
end$$;
revoke all on function erp_sync.browser_origin_targets(text,text),erp_sync.browser_all_stock_targets()from public,anon,authenticated,service_role;
commit;
