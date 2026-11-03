-- Local template only. The generator substitutes one validated UUID or SQL NULL.
-- This query deliberately requires the installed 089 schema; absence fails closed.
-- No XML, access key, taxpayer identity, address, bank data or object bytes are returned.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
WITH
params AS MATERIALIZED (
 SELECT __TARGET_ORDER_ID__::uuid AS target_order_id, statement_timestamp() AS observed_at
),
original AS MATERIALIZED (
 SELECT d.* FROM erp_documents.document d WHERE d.kind='sales_orders' AND d.number=1
),
selected_orders AS MATERIALIZED (
 SELECT d.* FROM erp_documents.document d
 WHERE d.kind='sales_orders' AND(d.id IN (SELECT id FROM original) OR d.id=(SELECT target_order_id FROM params))
),
company AS MATERIALIZED (
 SELECT i.version AS identity_version,i.data,i.updated_at,f.version AS fiscal_version,f.crt,f.confirmed_at
 FROM erp_company.identity i LEFT JOIN erp_company.fiscal f ON f.singleton=i.singleton WHERE i.singleton
),
policy_heads AS MATERIALIZED (
 SELECT DISTINCT ON (model) p.* FROM erp_fiscal_authorization.policy p ORDER BY model,version DESC
),
query_heads AS MATERIALIZED (
 SELECT DISTINCT ON (model) p.* FROM erp_fiscal_receipt_query.policy p ORDER BY model,version DESC
),
actors AS MATERIALIZED (
 SELECT m.user_id,m.role,m.updated_at FROM erp_access.membership m
 WHERE m.active AND m.role IN('admin','fiscal','vendas')
),
series AS MATERIALIZED (
 SELECT s.* FROM erp_fiscal_numbering.series s
 WHERE s.issuer_cnpj=(SELECT data->>'cnpj' FROM company) AND s.cuf='35'
 AND s.model='55' AND s.environment='2' AND s.series=2
),
related_orders AS MATERIALIZED (
 SELECT d.id,d.number,d.version,d.status,d.total::text AS total,d.created_at,d.updated_at
 FROM erp_documents.document d WHERE d.kind='sales_orders' AND d.contact_id=(SELECT contact_id FROM original)
 AND EXISTS(SELECT 1 FROM erp_documents.item i WHERE i.document_id=d.id
   AND (i.data->>'code'='345121' OR EXISTS(SELECT 1 FROM erp_catalog.record p WHERE p.id=i.product_id AND p.code='345121')))
),
protected_reservations AS MATERIALIZED (
 SELECT r.* FROM erp_fiscal_numbering.reservation r
 WHERE r.environment='2' AND r.series=2 AND r.issuer_cnpj=(SELECT data->>'cnpj' FROM company)
 AND ((r.model='55' AND r.number=42194) OR (r.model='65' AND r.number IN(4351,4352)))
),
selected_reservations AS MATERIALIZED (
 SELECT r.* FROM erp_fiscal_numbering.reservation r WHERE r.source_document_id IN(SELECT id FROM selected_orders)
 OR r.id IN(SELECT id FROM protected_reservations)
),
candidate_inventory AS MATERIALIZED (
 SELECT c.id,c.version,c.state,c.a1_version,c.basis_hash,c.created_at,c.finished_at,
 r.id AS reservation_id,r.source_document_id,r.model,r.series,r.number,a.signed_hash,a.size_bytes,
 EXISTS(SELECT 1 FROM erp_fiscal_authorization.attempt x WHERE x.candidate_id=c.id) AS has_attempt
 FROM erp_fiscal_signed.candidate c JOIN erp_fiscal_unsigned.job j ON j.id=c.unsigned_job_id
 JOIN erp_fiscal_numbering.reservation r ON r.id=j.reservation_id
 LEFT JOIN erp_fiscal_signed.artifact a ON a.candidate_id=c.id
 WHERE r.environment='2' AND r.issuer_cnpj=(SELECT data->>'cnpj' FROM company)
),
orders AS MATERIALIZED (
 SELECT d.id,d.number,d.version,d.status,d.total::text AS total,d.contact_id,d.warehouse_id,d.created_at,d.updated_at,
 encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex') AS row_hash,
 encode(sha256(convert_to(d.body::text,'UTF8')),'hex') AS body_hash,
 jsonb_build_object('date',d.body->'date','discount_mode',d.body->'discount_mode','discount_value',d.body->'discount_value',
  'freight',d.body->'freight','other_expenses',d.body->'other_expenses','installments_count',jsonb_array_length(coalesce(d.body->'installments','[]'::jsonb)),
  'commercial_present',d.body->'commercial' IS NOT NULL AND d.body->'commercial'<>'null'::jsonb,
  'notes_present',nullif(d.body->>'notes','') IS NOT NULL,'internal_notes_present',nullif(d.body->>'internal_notes','') IS NOT NULL,
  'payment_terms_present',nullif(d.body->>'payment_terms','') IS NOT NULL,'delivery_terms_present',nullif(d.body->>'delivery_terms','') IS NOT NULL) AS commercial_summary,
 (SELECT count(*) FROM erp_documents.item i WHERE i.document_id=d.id) AS item_count,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'position',i.position,
   'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',i.unit_price::text,
   'discount_percent',i.discount_percent::text,'total',i.total::text,
   'snapshot_version',i.product_snapshot->'version',
   'row_hash',encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')) ORDER BY i.position),'[]')
  FROM (SELECT x.* FROM erp_documents.item x WHERE x.document_id=d.id ORDER BY position LIMIT 2)i) AS items,
 (SELECT count(*) FROM erp_finance.document_posting x WHERE x.document_id=d.id) AS finance_postings,
 (SELECT count(*) FROM erp_stock.document_posting x WHERE x.document_id=d.id) AS stock_postings,
 (SELECT count(*) FROM erp_stock.reservation x WHERE x.document_id=d.id) AS stock_reservations,
 (SELECT count(*) FROM erp_cnab.billing_title b JOIN erp_finance.document_title t ON t.title_id=b.title_id
  JOIN erp_finance.document_posting p ON p.id=t.posting_id WHERE p.document_id=d.id) AS billing_titles,
 (SELECT count(*) FROM erp_fiscal_drafts.draft x WHERE x.source_document_id=d.id) AS fiscal_drafts,
 (SELECT count(*) FROM erp_fiscal_numbering.reservation x WHERE x.source_document_id=d.id) AS fiscal_reservations
 FROM selected_orders d
),
facts AS MATERIALIZED (
 SELECT jsonb_build_object(
 'contract','homologation-55-next-baseline-v1','read_only',true,'observed_at',(SELECT observed_at FROM params),
 'selection',jsonb_build_object('original_order_number','1','expected_product_code','345121','quantity','1','unit','CX','unit_price_from','original_order_item','expected_total','84.81',
  'model','55','environment','2','series',2,'target_order_id',(SELECT target_order_id FROM params)),
 'actor_inventory',jsonb_build_object('items',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.user_id),'[]') FROM(SELECT * FROM actors ORDER BY user_id LIMIT 25)a),
  'total',(SELECT count(*) FROM actors),'truncated',(SELECT count(*)>25 FROM actors),
  'active_admin_count',(SELECT count(*) FROM actors WHERE role='admin'),'active_fiscal_count',(SELECT count(*) FROM actors WHERE role='fiscal'),
  'authenticated_actor_proven',false),
 'original_order',(SELECT to_jsonb(o) FROM orders o WHERE o.number=1),
 'target_order',(SELECT to_jsonb(o) FROM orders o WHERE o.id=(SELECT target_order_id FROM params)),
 'catalog',jsonb_build_object(
  'contact',(SELECT jsonb_build_object('id',r.id,'version',r.version,'active',r.active,'person_type',c.person_type,
   'customer_role',c.roles@>ARRAY['customer']::text[],'document_present',nullif(c.document,'') IS NOT NULL,
   'document_matches_original_snapshot',c.document IS NOT DISTINCT FROM d.contact_snapshot->>'document',
   'snapshot_version',d.contact_snapshot->'version','state',c.state,
   'row_hash',encode(sha256(convert_to(jsonb_build_array(to_jsonb(r),to_jsonb(c))::text,'UTF8')),'hex'),
   'origin_source_id',o.source_id,'origin_state',o.state,'origin_applied_hash',o.applied_hash)
   FROM original d JOIN erp_catalog.record r ON r.id=d.contact_id AND r.entity='contacts'
   JOIN erp_catalog.contact c ON c.record_id=r.id LEFT JOIN erp_catalog.origin o ON o.record_id=r.id AND o.entity='contacts'),
  'products',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'active',r.active,'code',r.code,
   'unit',p.unit,'catalog_price',p.price::text,'ncm',p.ncm,'gtin',p.gtin,'kind',p.kind,'format',p.format,
   'row_hash',encode(sha256(convert_to(jsonb_build_array(to_jsonb(r),to_jsonb(p))::text,'UTF8')),'hex'),
   'origin_source_id',o.source_id,'origin_state',o.state,'origin_applied_hash',o.applied_hash) ORDER BY r.id),'[]')
   FROM erp_catalog.record r JOIN erp_catalog.product p ON p.record_id=r.id
   LEFT JOIN erp_catalog.origin o ON o.record_id=r.id AND o.entity='products'
   WHERE r.id IN(SELECT i.product_id FROM erp_documents.item i WHERE i.document_id IN(SELECT id FROM original) ORDER BY position LIMIT 2))),
 'company',(SELECT jsonb_build_object('identity_version',identity_version,'fiscal_version',fiscal_version,'crt',crt,'confirmed_at',confirmed_at,
   'state',data->'state','identity_hash',encode(sha256(convert_to(data::text,'UTF8')),'hex')) FROM company),
 'a1',(SELECT jsonb_build_object('version',h.version,'credential_id',h.credential_id,'object_hash',h.object_hash,'updated_at',h.updated_at,
   'configured',c.id IS NOT NULL,'company_identity_version',c.context->'company_identity_version',
   'company_matches',c.context->>'company_identity_version'=(SELECT identity_version::text FROM company) AND c.context->>'holder_cnpj'=(SELECT data->>'cnpj' FROM company),
   'not_before',c.metadata->'not_before','not_after',c.metadata->'not_after','certificate_fingerprint',c.metadata->'fingerprint_sha256',
   'time_valid_at_snapshot',(SELECT observed_at FROM params) BETWEEN(c.metadata->>'not_before')::timestamptz AND(c.metadata->>'not_after')::timestamptz,
   'private_bucket_metadata_matches',EXISTS(SELECT 1 FROM storage.buckets b WHERE b.id='brufap-a1-vault' AND b.name=b.id AND NOT b.public AND b.file_size_limit=1500000 AND b.allowed_mime_types=ARRAY['application/json']::text[]),
   'object_metadata_matches',EXISTS(SELECT 1 FROM storage.objects o JOIN erp_a1.sealed_object s ON s.credential_id=h.credential_id AND s.hash=h.object_hash
    WHERE o.bucket_id='brufap-a1-vault' AND o.name='credentials/'||h.credential_id::text||'/'||h.object_hash||'.json'
     AND o.metadata->>'size'=s.size_bytes::text AND o.metadata->>'mimetype'='application/json'),
   'bytes_verified',false,'private_key_opened',false) FROM erp_a1.head h LEFT JOIN erp_a1.credential c ON c.id=h.credential_id WHERE h.singleton),
 'series55',(SELECT jsonb_build_object('id',s.id,'version',s.version,'model',s.model,'environment',s.environment,'series',s.series,
   'first_number',s.first_number,'next_number',s.next_number::text,'enabled',s.enabled,'exclusive_use_confirmed',s.exclusive_use_confirmed,
   'identity_version',s.identity_version,'identity_matches',s.identity_version=(SELECT identity_version FROM company),'updated_at',s.updated_at,
   'row_hash',encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')) FROM series s),
 'authorization_policy_heads',(SELECT jsonb_agg(to_jsonb(p) ORDER BY model) FROM policy_heads p),
 'receipt_query_policy_heads',(SELECT jsonb_agg(to_jsonb(p) ORDER BY model) FROM query_heads p),
 'protocol062',jsonb_build_object('sql_policy_exists',false,'runtime_flag_observed',false,
  'attempts',(SELECT count(*) FROM erp_fiscal_reconciliation.attempt),'used',(SELECT count(*) FROM erp_fiscal_reconciliation.attempt WHERE used_at IS NOT NULL)),
 'related_orders',jsonb_build_object('total',(SELECT count(*) FROM related_orders),'truncated',(SELECT count(*)>25 FROM related_orders),
  'items',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.number DESC),'[]') FROM(SELECT * FROM related_orders ORDER BY number DESC LIMIT 25)d)),
 'reservations',jsonb_build_object('total',(SELECT count(*) FROM selected_reservations),'truncated',(SELECT count(*)>25 FROM selected_reservations),
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'source_document_id',r.source_document_id,'source_document_version',r.source_document_version,
   'draft_id',r.draft_id,'draft_version',r.draft_version,'model',r.model,'environment',r.environment,'series',r.series,'number',r.number,
   'series_id',r.series_id,'series_version',r.series_version,'actor',r.actor,'reserved_at',r.reserved_at,
   'row_hash',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')) ORDER BY r.id),'[]')
   FROM(SELECT * FROM selected_reservations ORDER BY id LIMIT 25)r)),
 'candidate_inventory',jsonb_build_object('total',(SELECT count(*) FROM candidate_inventory),'truncated',(SELECT count(*)>25 FROM candidate_inventory),
  'items',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM(SELECT * FROM candidate_inventory ORDER BY id LIMIT 25)c),
  'stored_without_attempt',(SELECT count(*) FROM candidate_inventory WHERE state='stored' AND NOT has_attempt),
  'eligibility_attested',false),
 'historical_authorizations',jsonb_build_object('total',(SELECT count(*) FROM erp_fiscal_authorization.attempt a JOIN erp_fiscal_authorization.intent i ON i.id=a.intent_id WHERE i.reservation_id IN(SELECT id FROM selected_reservations)),
  'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('attempt_id',a.id,'command_id',a.command_id,'candidate_id',a.candidate_id,'actor',a.actor,'model',a.model,
   'state',a.state,'used_at',a.used_at,'finished_at',a.finished_at,'policy_version',a.policy_version,'signed_hash',a.signed_hash,
   'result_outcome',r.evidence->'outcome','rejection_code',r.evidence->'rejection_code','cstat',r.evidence->'cstat',
   'protocol_cstat',r.evidence->'protocol_cstat','response_hash',r.response_hash,'processed_hash',r.processed_hash,
   'attempt_row_hash',encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),
   'result_row_hash',CASE WHEN r.attempt_id IS NOT NULL THEN encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') END) ORDER BY a.ordinal),'[]')
   FROM(SELECT x.* FROM erp_fiscal_authorization.attempt x JOIN erp_fiscal_authorization.intent i ON i.id=x.intent_id
    WHERE i.reservation_id IN(SELECT id FROM selected_reservations) ORDER BY x.ordinal LIMIT 25)a
   LEFT JOIN erp_fiscal_authorization.result r ON r.attempt_id=a.id)),
 'historical_revalidations',jsonb_build_object('total',(SELECT count(*) FROM erp_fiscal_authorization_revalidation.command c JOIN erp_fiscal_authorization.attempt a ON a.id=c.attempt_id JOIN erp_fiscal_authorization.intent i ON i.id=a.intent_id WHERE i.reservation_id IN(SELECT id FROM selected_reservations)),'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('command_id',v.id,'attempt_id',v.attempt_id,'actor',v.actor,
   'parser_profile',v.parser_profile,'source_hash',v.source_hash,'created_at',v.created_at,
   'original_state',v.receipt->'original_state','revalidated_state',v.receipt->'state','outcome',v.receipt#>'{evidence,outcome}',
   'cstat',v.receipt#>'{evidence,cstat}','protocol_cstat',v.receipt#>'{evidence,protocol_cstat}','processed_hash',v.receipt->'processed_hash',
   'row_hash',encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex')) ORDER BY v.id),'[]')
  FROM(SELECT c.* FROM erp_fiscal_authorization_revalidation.command c JOIN erp_fiscal_authorization.attempt a ON a.id=c.attempt_id
   JOIN erp_fiscal_authorization.intent i ON i.id=a.intent_id WHERE i.reservation_id IN(SELECT id FROM selected_reservations) ORDER BY c.id LIMIT 25)v)),
 'counts',jsonb_build_object('sales_orders',(SELECT count(*) FROM erp_documents.document WHERE kind='sales_orders'),
  'sales_numbering_last',(SELECT last_number::text FROM erp_documents.numbering WHERE kind='sales_orders'),
  'authorization_attempts',(SELECT count(*) FROM erp_fiscal_authorization.attempt),
  'authorization_consumed',(SELECT count(*) FROM erp_fiscal_authorization.attempt WHERE used_at IS NOT NULL),
  'authorization_unresolved',(SELECT count(*) FROM erp_fiscal_authorization.attempt WHERE state IN('prepared','request_ready','dispatched','submission_uncertain','receipt_pending')),
  'receipt_queries',(SELECT count(*) FROM erp_fiscal_receipt_query.query),
  'receipt_query_consumed',(SELECT count(*) FROM erp_fiscal_receipt_query.query WHERE used_at IS NOT NULL)),
 'limits',jsonb_build_object('database_snapshot_only',true,'runtime_flags_observed',false,'authenticated_actor_proven',false,
  'can_create_order',false,'can_emit',false,'can_transmit',false,'tax_rules_validated',false,'storage_bytes_read',false,
  'no_global_preservation_claim',true,'historical_rows_rewritten',false)
 ) AS value
)
,envelope AS(SELECT value||jsonb_build_object('checks',jsonb_build_object(
 'original_order_unique',(SELECT count(*)=1 FROM original),
 'original_single_item_1cx_total8481',(SELECT count(*)=1 AND coalesce(bool_and(i.data->>'code'='345121' AND i.data->>'unit'='CX' AND i.quantity=1 AND i.discount_percent=0 AND i.total=84.81 AND i.total=round(i.quantity*i.unit_price,2)),false) FROM erp_documents.item i WHERE i.document_id IN(SELECT id FROM original)),
 'original_total_8481',(SELECT total=84.81 FROM original),
 'original_reserved55_42194',(SELECT count(*)=1 FROM protected_reservations WHERE model='55' AND number=42194 AND source_document_id IN(SELECT id FROM original)),
 'historical65_4352_present',(SELECT count(*)=1 FROM protected_reservations WHERE model='65' AND number=4352),
 'contact_active_pf_customer',value#>>'{catalog,contact,active}'='true' AND value#>>'{catalog,contact,person_type}'='F' AND value#>>'{catalog,contact,customer_role}'='true',
 'catalog_contact_same_document',value#>>'{catalog,contact,document_present}'='true' AND value#>>'{catalog,contact,document_matches_original_snapshot}'='true',
 'current_product_active_code_unit',(SELECT count(*)=1 AND coalesce(bool_and(r.active AND r.code='345121' AND p.unit='CX'),false) FROM erp_catalog.record r JOIN erp_catalog.product p ON p.record_id=r.id WHERE r.id IN(SELECT i.product_id FROM erp_documents.item i WHERE i.document_id IN(SELECT id FROM original))),
 'single_active_admin',(SELECT count(*)=1 FROM actors WHERE role='admin'),
 'authorization_heads_closed',(SELECT count(*)=2 AND bool_and(NOT enabled) FROM policy_heads),
 'receipt_query_heads_closed',(SELECT count(*)=2 AND bool_and(NOT enabled) FROM query_heads),
 'series55_matches_current_identity',value#>>'{series55,identity_matches}'='true',
 'target_is_different_order',(SELECT target_order_id IS NULL OR target_order_id IS DISTINCT FROM(SELECT id FROM original) FROM params),
 'target_exists_if_requested',(SELECT target_order_id IS NULL OR EXISTS(SELECT 1 FROM selected_orders d WHERE d.id=target_order_id AND d.kind='sales_orders') FROM params),
 'target_same_contact_and_exact_price',(SELECT target_order_id IS NULL OR EXISTS(
   SELECT 1 FROM selected_orders d JOIN original o ON o.contact_id=d.contact_id
   WHERE d.id=target_order_id AND d.total=o.total AND d.total=84.81
   AND(SELECT count(*) FROM erp_documents.item WHERE document_id=d.id)=1
   AND EXISTS(SELECT 1 FROM erp_documents.item i JOIN erp_documents.item j ON j.document_id=o.id
    WHERE i.document_id=d.id AND i.product_id=j.product_id AND i.quantity=j.quantity AND i.quantity=1
     AND i.unit_price=j.unit_price AND i.discount_percent=0 AND i.total=j.total AND i.data->>'unit'='CX')) FROM params),
 'target_unprepared_without_effects',(SELECT target_order_id IS NULL OR EXISTS(SELECT 1 FROM orders o WHERE o.id=target_order_id
   AND o.status='draft' AND o.finance_postings=0 AND o.stock_postings=0 AND o.stock_reservations=0 AND o.billing_titles=0
   AND o.fiscal_drafts=0 AND o.fiscal_reservations=0) FROM params),
 'inventory_not_truncated',NOT(value#>>'{actor_inventory,truncated}')::boolean AND NOT(value#>>'{related_orders,truncated}')::boolean AND NOT(value#>>'{reservations,truncated}')::boolean AND NOT(value#>>'{candidate_inventory,truncated}')::boolean AND(value#>>'{historical_authorizations,total}')::integer<=25 AND(value#>>'{historical_revalidations,total}')::integer<=25
)) AS value FROM facts)
SELECT CASE WHEN octet_length(value::text)<=262144 THEN value ELSE jsonb_build_object('contract','homologation-55-next-baseline-v1','read_only',true,'error','BASELINE_TOO_LARGE','can_create_order',false,'can_emit',false,'can_transmit',false) END AS fiscal_test55_next_baseline FROM envelope;
COMMIT;
