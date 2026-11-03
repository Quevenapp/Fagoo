-- Owner/admin-only local/export query, deliberately not an ERP RPC.
-- One readonly snapshot, aggregates only; no names, source IDs, prices or tokens.
begin isolation level repeatable read read only;
set local statement_timeout='15s';
with sources as materialized (
 select source_id,payload,version_hash,version,price_capture,document_links,last_seen_at
 from origin_sync.raw_record where entity='purchase_orders' order by source_id collate "C" limit 5000
), checked as materialized (
 select *,octet_length(payload::text)<=524288 as size_ok,
  coalesce(jsonb_typeof(payload->'id') in('number','string') and payload->>'id'=source_id and source_id~'^[1-9][0-9]{0,39}$',false) as id_ok,
  coalesce(price_capture->>'profile'='origin-purchase-price-json-v1' and price_capture->>'source'='detail'
   and price_capture->>'source_hash'=version_hash and price_capture->>'source_version'=version::text,false) as capture_bound,
  case when jsonb_typeof(payload->'itens')='array' then jsonb_array_length(payload->'itens') else 0 end as line_count
 from sources
), lines as materialized (
 select s.source_id,item.value as item
 from checked s cross join lateral jsonb_array_elements(case when s.size_ok and s.line_count between 1 and 250 then s.payload->'itens' else '[]'::jsonb end) item
), refs as materialized (
 select source_id,'supplier'::text as purpose,'contacts'::text as entity,payload#>'{fornecedor,id}' as ref from checked where size_ok
 union all select source_id,'product','products',item#>'{produto,id}' from lines
), ref_ids as (
 select *,case when jsonb_typeof(ref) in('number','string') and ref#>>'{}'~'^[1-9][0-9]{0,39}$' then ref#>>'{}' end as ref_id from refs
), bindings as materialized (
 select i.purpose,i.ref_id,s.source_id is not null as staged,o.record_id is not null as linked,
  coalesce(r.active and not r.human_edited and o.state='synced' and o.candidate is null
   and o.applied_hash=s.version_hash and o.latest_hash=s.version_hash and r.entity=i.entity
   and case when i.entity='contacts' then exists(select 1 from erp_catalog.contact c where c.record_id=r.id)
    else exists(select 1 from erp_catalog.product p where p.record_id=r.id and p.kind in('P','S') and p.format='S') end,false) as exact_current_binding
 from ref_ids i left join origin_sync.raw_record s on s.entity=i.entity and s.source_id=i.ref_id
 left join erp_catalog.origin o on o.entity=i.entity and o.source_id=i.ref_id
 left join erp_catalog.record r on r.id=o.record_id
), reference_counts as (
 select purpose,count(*) as references,count(*) filter(where ref_id is null) as invalid_id,
  count(*) filter(where ref_id is not null and not staged) as missing_staging,
  count(*) filter(where ref_id is not null and staged and not linked) as missing_native_binding,
  count(*) filter(where linked and not exact_current_binding) as current_binding_needs_review,
  count(*) filter(where exact_current_binding) as exact_current_binding
 from bindings group by purpose
), status_counts as (
 select case when jsonb_typeof(payload#>'{situacao,valor}')='number' and payload#>>'{situacao,valor}' in('0','1','2','3')
  then payload#>>'{situacao,valor}' else 'unknown' end as source_value,
  count(*) as records,count(*) filter(where jsonb_typeof(payload#>'{situacao,id}') in('number','string') and payload#>>'{situacao,id}'~'^[1-9][0-9]{0,39}$') as with_exact_situation_id
 from checked group by 1
), shape_counts as (
 select count(*) filter(where not id_ok) as source_id_invalid,count(*) filter(where not size_ok) as source_too_large,
  count(*) filter(where line_count not between 1 and 250) as items_missing_or_outside_limit,
  count(*) filter(where not capture_bound) as price_capture_current_missing,
  count(*) filter(where document_links<>'[]'::jsonb) as source_has_document_links,
  count(*) filter(where not(payload?'desconto')) as discount_absent,
  count(*) filter(where payload->'desconto'='null'::jsonb) as discount_null,
  count(*) filter(where payload#>'{desconto,valor}'='0'::jsonb and payload#>>'{desconto,unidade}' in('REAL','PERCENTUAL')) as discount_explicit_zero,
  count(*) filter(where jsonb_typeof(payload#>'{desconto,valor}')='number' and payload#>'{desconto,valor}'<>'0'::jsonb) as discount_nonzero,
  count(*) filter(where jsonb_typeof(payload#>'{transporte,frete}') is distinct from 'number') as freight_missing_or_invalid,
  count(*) filter(where jsonb_typeof(payload#>'{transporte,frete}')='number' and payload#>'{transporte,frete}'<>'0'::jsonb) as freight_nonzero,
  count(*) filter(where jsonb_typeof(payload->'tributacao')='object') as taxation_object_present,
  count(*) filter(where jsonb_typeof(payload->'total') is distinct from 'number' or jsonb_typeof(payload->'totalProdutos') is distinct from 'number') as totals_missing_or_nonnumeric,
  count(*) filter(where jsonb_typeof(payload->'parcelas')='array' and payload->'parcelas'<>'[]'::jsonb) as installments_present
 from checked
), line_counts as (
 select count(*) as inspected_lines,
  count(*) filter(where jsonb_typeof(item->'valor') is distinct from 'number') as price_missing_or_nonnumeric,
  count(*) filter(where case when jsonb_typeof(item->'valor')='number' then (item->>'valor')::numeric<0 or (item->>'valor')::numeric>=10000000000 or trunc((item->>'valor')::numeric,10)<>(item->>'valor')::numeric else false end) as price_outside_native057,
  count(*) filter(where jsonb_typeof(item->'quantidade') is distinct from 'number') as quantity_missing_or_nonnumeric,
  count(*) filter(where case when jsonb_typeof(item->'quantidade')='number' then (item->>'quantidade')::numeric<=0 or (item->>'quantidade')::numeric>=1000000000 or trunc((item->>'quantidade')::numeric,6)<>(item->>'quantidade')::numeric else false end) as quantity_outside_native008,
  count(*) filter(where jsonb_typeof(item->'unidade') is distinct from 'string' or length(item->>'unidade') not between 1 and 16) as unit_missing_or_outside_limit,
  count(*) filter(where exists(select 1 from erp_catalog.origin o join erp_catalog.product p on p.record_id=o.record_id
   where o.entity='products' and o.source_id=item#>>'{produto,id}' and p.unit is distinct from item->>'unidade')) as unit_differs_from_exact_link,
  count(*) filter(where item?'notaFiscal' and item->'notaFiscal' not in('null'::jsonb,'{}'::jsonb)) as invoice_reference_present,
  count(*) filter(where jsonb_typeof(item->'aliquotaIPI')='number' and item->'aliquotaIPI'<>'0'::jsonb) as ipi_nonzero
 from lines
)
select jsonb_build_object(
 'profile','origin-purchase-readiness-observation-v1','observed_at',statement_timestamp(),
 'read_only',true,'can_import',false,'coverage_certified',false,'native_effects',false,
 'source_total',(select count(*) from origin_sync.raw_record where entity='purchase_orders'),
 'sources_inspected',(select count(*) from checked),'source_limit',5000,
 'truncated',(select count(*)>5000 from origin_sync.raw_record where entity='purchase_orders'),
 'last_seen_min',(select min(last_seen_at) from checked),'last_seen_max',(select max(last_seen_at) from checked),
 'status_counts',coalesce((select jsonb_agg(to_jsonb(s) order by source_value) from status_counts s),'[]'::jsonb),
 'reference_counts',coalesce((select jsonb_agg(to_jsonb(r) order by purpose) from reference_counts r),'[]'::jsonb),
 'shape_counts',(select to_jsonb(s) from shape_counts s),'line_counts',(select to_jsonb(l) from line_counts l),
 'pending_contracts',jsonb_build_array('SOURCE_STATUS_REVIEW','SOURCE_EFFECTS_NOT_PROVEN','COMMERCIAL_MATH_NOT_RECONCILED','PERMANENT_PURCHASE_ORIGIN_NOT_IMPLEMENTED'),
 'notes',jsonb_build_array('counts_are_observations_not_import_eligibility','status_zero_does_not_prove_absence_of_stock_or_finance_effects','capture_is_current_selective_observation_not_http_history')
) as report;
rollback;
