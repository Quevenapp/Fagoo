-- A fiscal badge may explicitly delegate stock to its sales order. Recover
-- only a unique, exact reverse invoice ID and real observed order movements.
begin;
create index if not exists raw_sales_invoice_reference on origin_sync.raw_record((payload#>>'{notaFiscal,id}'),source_id)where entity='sales_orders';
create function erp_sync.browser_invoice_reference_origins(p_entity text,p_source text)
returns table(entity text,source_id text,source_number text)
language sql stable set search_path=pg_catalog as $$
 with fiscal as materialized(select stock_flag,stock_label from erp_sync.indicator_observation
  where entity=p_entity and source_id=p_source order by observed_at desc limit 1),
 orders as materialized(select source_id,payload->>'numero'number from origin_sync.raw_record
  where entity='sales_orders'and payload#>>'{notaFiscal,id}'=p_source)
 select 'sales_orders',r.source_id,r.number from orders r cross join fiscal f
 cross join lateral(select stock_flag,stock_label from erp_sync.indicator_observation
  where entity='sales_orders'and source_id=r.source_id order by observed_at desc limit 1)o
 where p_entity in('nfe','nfce')and f.stock_flag='R'and o.stock_flag='S'
 and not exists(select 1 from origin_sync.raw_record where entity in('nfe','nfce')and source_id=p_source)
 and(select count(*)from orders)=1 and r.number~'^[0-9]{1,20}$'
 and(position('Depósito:'in f.stock_label)=0 or substring(f.stock_label from 'Depósito: (.+)$')=substring(o.stock_label from 'Depósito: (.+)$'))
$$;
alter function erp_sync.browser_origin_targets(text,text)rename to browser_origin_targets_without_invoice_reference;
create function erp_sync.browser_origin_targets(p_entity text,p_source text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 select *from erp_sync.browser_origin_targets_without_invoice_reference(p_entity,p_source)
 union
 select t.*from erp_sync.browser_invoice_reference_origins(p_entity,p_source)r
 cross join lateral erp_sync.browser_origin_targets_without_invoice_reference(r.entity,r.source_id)t
$$;
alter function erp_sync.browser_all_stock_targets()rename to browser_all_stock_targets_without_invoice_reference;
create function erp_sync.browser_all_stock_targets()
returns table(entity text,source_id text,product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 select *from erp_sync.browser_all_stock_targets_without_invoice_reference()
 union
 select o.entity,o.source_id,t.*from(select distinct on(entity,source_id)entity,source_id,stock_flag,stock_label
  from erp_sync.indicator_observation where entity in('nfe','nfce') order by entity,source_id,observed_at desc)o
 cross join lateral erp_sync.browser_invoice_reference_origins(o.entity,o.source_id)r
 cross join lateral erp_sync.browser_origin_targets_without_invoice_reference(r.entity,r.source_id)t
 where o.stock_flag='R'and(position('Depósito:'in o.stock_label)=0 or t.warehouse_name=substring(o.stock_label from 'Depósito: (.+)$'))
$$;
do $$declare definition text;original text;begin
 definition:=pg_get_functiondef('erp_sync.indicator_history_without_component_labels(text,text,text)'::regprocedure);
 original:=$old$(x->>'origin_entity'=p_entity and x->>'origin_source_id'=p_source)or(p_note is not null and x->>'origin_entity'='nfe'and x->>'origin_source_id'=p_note)$old$;
 if position(original in definition)=0 then raise exception 'browser_invoice_reference_history_definition_changed';end if;
 execute replace(definition,original,original||$new$or exists(select 1 from erp_sync.browser_invoice_reference_origins(p_entity,p_source)r
  cross join lateral erp_sync.browser_origin_targets_without_invoice_reference(r.entity,r.source_id)t
  where x->>'origin_entity'=r.entity and x->>'origin_source_id'=r.source_id and ltrim(x->>'origin_number','0')=ltrim(r.source_number,'0')
  and s.product_source_id=t.product_source_id and s.warehouse_source_id=t.warehouse_source_id)$new$);
end$$;
revoke all on function erp_sync.browser_invoice_reference_origins(text,text),erp_sync.browser_origin_targets_without_invoice_reference(text,text),erp_sync.browser_origin_targets(text,text),erp_sync.browser_all_stock_targets_without_invoice_reference(),erp_sync.browser_all_stock_targets()from public,anon,authenticated,service_role;
commit;
