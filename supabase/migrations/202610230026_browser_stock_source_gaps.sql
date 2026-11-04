begin;
create or replace function erp_sync.browser_status()returns jsonb language sql stable set search_path=pg_catalog as $$
 with latest as materialized(select distinct on(entity,source_id)entity,source_id,stock_flag,stock_label from erp_sync.indicator_observation order by entity,source_id,observed_at desc)
 select jsonb_build_object('pending',count(*)filter(where state='pending' or state='done'and due_at<=now() or state='running'and claimed_at<now()-interval '5 minutes'),
 'running',count(*)filter(where state='running'and claimed_at>=now()-interval '5 minutes'),'failed',count(*)filter(where state='failed'),
 'last_completed_at',max(last_completed_at),'indicator_records',(select count(*)from latest),
 'history_products',(select count(distinct(product_source_id,warehouse_source_id))from erp_sync.stock_history_snapshot),
 'unmapped_documents',(select count(*)from latest o where o.stock_flag is not null and
  (not exists(select 1 from erp_sync.indicator_products(o.entity,o.source_id))or not exists(select 1 from origin_sync.raw_record w where w.entity='warehouses'and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(o.stock_label from 'Depósito: (.+)$')))),
 'last_error',(select error from erp_sync.browser_job where error is not null order by claimed_at desc limit 1),'operational_effects',false)from erp_sync.browser_job
$$;
revoke all on function erp_sync.browser_status()from public,anon,authenticated,service_role;
commit;
