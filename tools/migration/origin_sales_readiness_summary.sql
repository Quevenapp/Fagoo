-- Administrative inspection, not an import preview or eligibility policy.
-- Reuses 052 decimal/ID/binding checks and the 076 binding-state projection.
-- No matching by name, SKU, order number, amount or invoice number.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
-- Revalidate078 in the same read-only snapshot. The transaction-local setting
-- transports aggregates only; no helper, temporary object or source row is written.
DO $capture$
DECLARE s origin_sync.raw_record%rowtype;c jsonb;state text;seen timestamptz;
 counts jsonb:='{"absent":0,"other_profile":0,"unbound":0,"bound":0}';
 inspected integer:=0;tokens bigint:=0;oldest timestamptz;newest timestamptz;
BEGIN
 FOR s IN SELECT * FROM origin_sync.raw_record WHERE entity='sales_orders'
  ORDER BY source_id COLLATE "C" LIMIT 20000 LOOP
  inspected:=inspected+1;c:=s.price_capture;state:='unbound';seen:=null;
  IF c IS NULL THEN state:='absent';
  ELSIF c->>'profile' IS DISTINCT FROM 'origin-sales-price-json-v1' THEN state:='other_profile';
  ELSE
   BEGIN
    IF jsonb_typeof(c->'observed_at')='string' THEN seen:=(c->>'observed_at')::timestamptz;END IF;
    IF NOT isfinite(seen) THEN seen:=null;END IF;
   EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN seen:=null;END;
   IF octet_length(s.payload::text)<=524288 AND octet_length(c::text)<=131072
    AND c->>'source_hash'=s.version_hash AND c->>'source_version'=s.version::text
    AND c->>'capture_id'~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' AND seen IS NOT NULL THEN
    BEGIN
     PERFORM origin_sync.validate_sales_price_capture(s.payload,jsonb_build_object(
      'profile',c->'profile','source',c->'source','response_sha256',c->'response_sha256','tokens',c->'tokens'));
     state:='bound';tokens:=tokens+jsonb_array_length(c->'tokens');
     oldest:=least(oldest,seen);newest:=greatest(newest,seen);
    EXCEPTION WHEN sqlstate '22023' OR numeric_value_out_of_range OR invalid_text_representation THEN state:='unbound';END;
   END IF;
  END IF;
  counts:=jsonb_set(counts,ARRAY[state],to_jsonb((counts->>state)::integer+1));
 END LOOP;
 PERFORM set_config('brufap.sales_readiness_capture',jsonb_build_object(
  'profile','origin-sales-price-json-v1','inspected_sources',inspected,'states',counts,
  'validated_numeric_tokens',tokens,'oldest_bound_observation',oldest,'newest_bound_observation',newest,
  'coverage_certified',false,'commercial_math_reconciled',false,'current_capture_is_history',false)::text,true);
END $capture$;
WITH sources AS MATERIALIZED (
 SELECT s.*,octet_length(s.payload::text)<=524288 AS size_supported,
  CASE WHEN jsonb_typeof(s.payload->'itens')='array' THEN jsonb_array_length(s.payload->'itens') END item_count
 FROM origin_sync.raw_record s WHERE s.entity='sales_orders'
 ORDER BY s.source_id COLLATE "C" LIMIT 20000
), checked AS MATERIALIZED (
 SELECT s.*,erp_cutover.purchase_binding('contacts',s.payload#>'{contato,id}') customer,
  erp_cutover.purchase_invoice(s.payload->'notaFiscal') invoice,
  erp_documents.origin_import_id(s.payload#>'{situacao,id}') situation_id,
  erp_cutover.purchase_observed(s.payload#>'{situacao,valor}',true) situation_value
 FROM sources s
), lines AS MATERIALIZED (
 SELECT s.source_id,x.ordinality::integer position,x.value item,
  erp_cutover.purchase_binding('products',x.value#>'{produto,id}') product,
  erp_documents.origin_import_number(x.value->'quantidade',6,9) quantity,
  erp_documents.origin_import_number(x.value->'valor',10,10) unit_price,
  erp_documents.origin_import_number(x.value->'desconto',6,3) discount
 FROM checked s CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN s.size_supported AND s.item_count BETWEEN 1 AND 250 THEN s.payload->'itens' ELSE '[]'::jsonb END
 )WITH ORDINALITY x
), issues AS MATERIALIZED (
 SELECT source_id,'SOURCE_ID_INVALID_OR_MISMATCHED' code FROM checked WHERE erp_documents.origin_import_id(payload->'id') IS DISTINCT FROM source_id OR source_id!~'^[1-9][0-9]{0,39}$'
 UNION ALL SELECT source_id,'SOURCE_TOO_LARGE' FROM checked WHERE NOT size_supported
 UNION ALL SELECT source_id,'ITEM_COUNT_OUTSIDE_LIMIT' FROM checked WHERE item_count IS NULL OR item_count NOT BETWEEN 1 AND 250
 UNION ALL SELECT source_id,'CUSTOMER_BINDING_UNAVAILABLE' FROM checked WHERE customer->>'state'<>'current'
 UNION ALL SELECT source_id,'SITUATION_UNAVAILABLE' FROM checked WHERE situation_id IS NULL OR situation_value->>'state'<>'value'
 UNION ALL SELECT source_id,'INVOICE_REFERENCE_UNVERIFIED' FROM checked WHERE invoice->>'state' IN('declared','invalid')
 UNION ALL SELECT source_id,'ITEM_INVALID' FROM lines WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
 UNION ALL SELECT source_id,'PRODUCT_BINDING_UNAVAILABLE' FROM lines WHERE product->>'state'<>'current'
 UNION ALL SELECT source_id,'QUANTITY_OUTSIDE_NATIVE_LIMIT' FROM lines WHERE quantity IS NULL OR quantity::numeric<=0
 UNION ALL SELECT source_id,'PRICE_OUTSIDE_NATIVE_LIMIT' FROM lines WHERE unit_price IS NULL
 UNION ALL SELECT source_id,'LINE_DISCOUNT_OUTSIDE_OBSERVED_PERCENT_LIMIT' FROM lines WHERE discount IS NULL OR discount::numeric>100
 UNION ALL SELECT source_id,'UNIT_INVALID' FROM lines WHERE jsonb_typeof(item->'unidade') IS DISTINCT FROM 'string' OR coalesce(item->>'unidade','')='' OR length(item->>'unidade')>16 OR item->>'unidade'~'[[:cntrl:]]' OR item->>'unidade'~U&'[\007F-\009F]'
 UNION ALL SELECT source_id,'UNIT_DIFFERS_FROM_LINK' FROM lines WHERE product->>'record_id' IS NOT NULL AND product->>'unit' IS DISTINCT FROM item->>'unidade'
), ranked AS MATERIALIZED (
 SELECT s.source_id,s.version_hash,s.version,s.last_seen_at,s.item_count,
  erp_cutover.purchase_observed(s.payload->'numero',false,80) source_number,
  s.situation_id,s.situation_value,s.invoice->>'state' invoice_state,
  (SELECT count(*) FROM issues i WHERE i.source_id=s.source_id) local_issue_occurrences,
  (SELECT count(DISTINCT code) FROM issues i WHERE i.source_id=s.source_id) local_issue_categories
 FROM checked s
 ORDER BY local_issue_occurrences,s.source_id COLLATE "C" LIMIT 5
)
SELECT jsonb_build_object(
 'profile','origin-sales-readiness-inspection-v2','observed_at',statement_timestamp(),
 'read_only',true,'can_import',false,'coverage_certified',false,'native_effects',false,
 'pending_contracts',jsonb_build_array('SOURCE_STATUS_POLICY_UNREVIEWED','SOURCE_EFFECTS_NOT_PROVEN','COMMERCIAL_MATH_NOT_RECONCILED','PERMANENT_SALES_ORIGIN_NOT_IMPLEMENTED','HISTORICAL_EFFECT_GUARD_NOT_IMPLEMENTED'),
 'price_capture',current_setting('brufap.sales_readiness_capture')::jsonb,
 'source_counts',jsonb_build_object('total',(SELECT count(*) FROM origin_sync.raw_record WHERE entity='sales_orders'),'inspected',(SELECT count(*) FROM sources),'source_limit',20000,'truncated',(SELECT count(*) FROM origin_sync.raw_record WHERE entity='sales_orders')>20000,'item_rows_observed',(SELECT coalesce(sum(item_count),0) FROM checked),'item_rows_inspected',(SELECT count(*) FROM lines),'omitted_source_details',(SELECT count(*) FROM checked WHERE NOT size_supported OR item_count IS NULL OR item_count NOT BETWEEN 1 AND 250),'oldest_observation',(SELECT min(last_seen_at) FROM sources),'newest_observation',(SELECT max(last_seen_at) FROM sources),'without_local_issues',(SELECT count(*) FROM checked s WHERE NOT EXISTS(SELECT 1 FROM issues i WHERE i.source_id=s.source_id))),
 'issues',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY code) FROM(SELECT code,count(*) occurrences,count(DISTINCT source_id) sources FROM issues GROUP BY code)x),'[]'),
 'customer_bindings',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY state) FROM(SELECT customer->>'state' state,count(*) source_occurrences,count(DISTINCT customer->>'source_id') unique_ids FROM checked GROUP BY customer->>'state')x),'[]'),
 'product_bindings',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY state) FROM(SELECT product->>'state' state,count(*) line_occurrences,count(DISTINCT product->>'source_id') unique_ids FROM lines GROUP BY product->>'state')x),'[]'),
 'situations',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY id,value_state,value) FROM(SELECT situation_id id,situation_value->>'state' value_state,situation_value->>'value' value,count(*) sources FROM checked GROUP BY situation_id,situation_value->>'state',situation_value->>'value')x),'[]'),
 'invoice_references',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY state) FROM(SELECT invoice->>'state' state,count(*) sources FROM checked GROUP BY invoice->>'state')x),'[]'),
 'commercial_observations',jsonb_build_object('positive_line_discounts',(SELECT count(*) FROM lines WHERE discount::numeric>0),'positive_ipi_lines',(SELECT count(*) FROM lines WHERE erp_documents.origin_import_number(item->'aliquotaIPI',6,3)::numeric>0),'declared_taxation_objects',(SELECT count(*) FROM checked WHERE jsonb_typeof(payload->'tributacao')='object'),'installment_rows',(SELECT coalesce(sum(CASE WHEN jsonb_typeof(payload->'parcelas')='array' THEN jsonb_array_length(payload->'parcelas') ELSE 0 END),0) FROM checked),'order_discount_units',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY observed_state,observed_value) FROM(SELECT v->>'state' observed_state,v->>'value' observed_value,count(*) sources FROM(SELECT erp_cutover.purchase_observed(payload#>'{desconto,unidade}',false,40)v FROM checked)a GROUP BY v->>'state',v->>'value')x),'[]'),'reconciliation_performed',false,'price_precision_proven',false),
 'lowest_local_issue_samples',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY local_issue_occurrences,source_id COLLATE "C") FROM ranked x),'[]'),
 'backup',jsonb_build_object('rows',(SELECT count(*) FROM origin_backup.record r JOIN origin_backup.batch b USING(backup_sha) WHERE r.kind='csv' AND r.data->>'entity'='sales_orders' AND b.status IN('stored','stored_with_issues')),'rows_without_source_id',(SELECT count(*) FROM origin_backup.record r JOIN origin_backup.batch b USING(backup_sha) WHERE r.kind='csv' AND r.data->>'entity'='sales_orders' AND b.status IN('stored','stored_with_issues') AND nullif(r.data->>'source_id','') IS NULL),'per_order_comparison','not_available_without_exact_identity','current_payload_is_history',false),
 'native',jsonb_build_object('sales_orders',(SELECT count(*) FROM erp_documents.document WHERE kind='sales_orders'),'proposal_conversions',(SELECT count(*) FROM erp_documents.document WHERE kind='sales_orders' AND source_proposal_id IS NOT NULL),'numbering_last_number',(SELECT last_number::text FROM erp_documents.numbering WHERE kind='sales_orders'),'test_order_1',(SELECT jsonb_build_object('id',id,'number',number::text,'version',version,'status',status,'row_sha256',encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex'))FROM erp_documents.document d WHERE kind='sales_orders' AND number=1),'current_origin_entity_constraint',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='erp_documents.origin_import_origin'::regclass AND conname='origin_import_origin_entity_check')),
 'limitations',jsonb_build_array('Lower local issue count is not eligibility. Capture state is reported separately; all sources retain global pending contracts.','078 revalidation covers numeric itens.valor tokens only; empty valid capture does not prove a numeric price.','Quantity, discount, valorLista, IPI, totals and installments have no lexical precision proof from078.','Native unit/quantity/price limits are checked without conversion or rounding.','Situation ID/value and invoice ID are observations, not operational or fiscal proof.','Current staging is not the backup nor a complete change history.','No heuristic association of existing orders, converted proposals, invoices or financial titles.')
) AS sales_readiness_summary;
COMMIT;
