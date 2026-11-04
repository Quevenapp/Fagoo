-- An empty SKU does not erase an exact product ID. Never use empty SKU fallback.
begin;
do $$declare definition text;begin
 definition:=pg_get_functiondef('erp_sync.indicator_products_from_source(text,text)'::regprocedure);
 if position('where nullif(code,'''')is not null'in definition)=0 then raise exception 'browser_blank_code_source_definition_changed';end if;
 definition:=replace(definition,'where nullif(code,'''')is not null','where code is not null');
 definition:=replace(definition,'where i.id is null and','where i.id is null and nullif(i.code,'''')is not null and');
 execute definition;
 definition:=pg_get_functiondef('erp_sync.browser_all_stock_targets()'::regprocedure);
 if position('where nullif(p.product_code,'''')is not null'in definition)=0 then raise exception 'browser_blank_code_bulk_definition_changed';end if;
 execute replace(definition,'where nullif(p.product_code,'''')is not null','where p.product_code is not null');
end$$;
alter function erp_sync.browser_enqueue()rename to browser_enqueue_before_blank_sku;
create function erp_sync.browser_enqueue()returns void language plpgsql set search_path=pg_catalog as $$
begin
 perform erp_sync.browser_enqueue_before_blank_sku();
 -- This is read coverage of candidates, not evidence that a document affected
 -- any product. Only a subsequently observed exact origin creates that edge.
 insert into erp_sync.browser_job(job_key,kind,task)
 select 'H:'||p.source_id||':'||w.source_id,'stock_history',jsonb_build_object('product_source_id',p.source_id,'product_code','','product_name',p.payload->>'nome','warehouse_source_id',w.source_id)
 from origin_sync.raw_record p cross join origin_sync.raw_record w
 where p.entity='products'and p.payload->>'codigo'=''and nullif(p.payload->>'nome','')is not null
 and coalesce(p.payload#>>'{_brufap_source,deleted}','false')<>'true'
 and not(coalesce(p.payload->>'formato','')='E'and coalesce(p.payload#>>'{estrutura,tipoEstoque}','')='V')
 and w.entity='warehouses'and exists(select 1 from erp_sync.indicator_observation o join erp_sync.issue i on i.entity=o.entity and i.source_id=o.source_id
  where i.code='BROWSER_STOCK_MAPPING_PENDING'and i.resolved_at is null
  and substring(o.stock_label from 'Depósito: (.+)$')=coalesce(w.payload->>'descricao',w.payload->>'nome'))
 on conflict(job_key)do nothing;
 update erp_sync.browser_job j set task=jsonb_set(j.task,'{product_name}',to_jsonb(p.payload->>'nome'))
 from origin_sync.raw_record p where j.kind='stock_history'and j.state<>'running'and j.task->>'product_code'=''
 and p.entity='products'and p.source_id=j.task->>'product_source_id'and p.payload->>'codigo'=''
 and nullif(p.payload->>'nome','')is not null and j.task->>'product_name'is distinct from p.payload->>'nome';
end$$;
do $$declare definition text;original text;begin
 definition:=pg_get_functiondef('erp_sync.indicator_history_without_component_labels(text,text,text)'::regprocedure);
 original:='select s.product_code,s.warehouse_name,s.observed_at,x,ordinal';
 if position(original in definition)=0 then raise exception 'browser_blank_history_identity_definition_changed';end if;
 definition:=replace(definition,original,'select s.product_source_id,s.product_code,s.warehouse_name,s.observed_at,x,ordinal');
 original:='jsonb_build_object(''product_code'',product_code,''warehouse'',warehouse_name';
 if position(original in definition)=0 then raise exception 'browser_blank_history_label_definition_changed';end if;
 execute replace(definition,original,$new$jsonb_build_object('product_code',product_code,'product_source_id',product_source_id,
  'product_name',(select p.payload->>'nome'from origin_sync.raw_record p where p.entity='products'and p.source_id=f.product_source_id),'warehouse',warehouse_name$new$);
end$$;
revoke all on function erp_sync.browser_enqueue_before_blank_sku(),erp_sync.browser_enqueue(),erp_sync.indicator_products_from_source(text,text),erp_sync.browser_all_stock_targets(),erp_sync.indicator_history_without_component_labels(text,text,text)from public,anon,authenticated,service_role;
commit;
