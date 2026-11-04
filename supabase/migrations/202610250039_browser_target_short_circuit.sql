-- Let existence checks stop after a valid source target, without scanning
-- historical evidence for every already-mapped document on each cache refresh.
begin;
create function erp_sync.browser_source_stock_targets(p_entity text,p_source text,p_label text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 select p.source_id,p.code,w.source_id,coalesce(w.payload->>'descricao',w.payload->>'nome')
 from erp_sync.indicator_products_from_source(p_entity,p_source)p join origin_sync.raw_record w on w.entity='warehouses'
 and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(p_label from 'Depósito: (.+)$')
 and(select count(*)from origin_sync.raw_record w2 where w2.entity='warehouses'and coalesce(w2.payload->>'descricao',w2.payload->>'nome')=substring(p_label from 'Depósito: (.+)$'))=1
$$;
create or replace function erp_sync.browser_stock_targets(p_entity text,p_source text,p_label text)
returns table(product_source_id text,product_code text,warehouse_source_id text,warehouse_name text)
language sql stable set search_path=pg_catalog as $$
 select *from erp_sync.browser_source_stock_targets(p_entity,p_source,p_label)
 union all
 select t.*from erp_sync.browser_origin_targets(p_entity,p_source)t
 where(position('Depósito:'in p_label)=0 or t.warehouse_name=substring(p_label from 'Depósito: (.+)$'))
 and not exists(select 1 from erp_sync.browser_source_stock_targets(p_entity,p_source,p_label)s
  where(s.product_source_id,s.warehouse_source_id)=(t.product_source_id,t.warehouse_source_id))
$$;
revoke all on function erp_sync.browser_source_stock_targets(text,text,text),erp_sync.browser_stock_targets(text,text,text)from public,anon,authenticated,service_role;
commit;
