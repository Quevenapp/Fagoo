-- Read-only export for a private0600 file. No payload, price, name, URL or token lexeme.
-- Requires060; run through the administrative SQL console, not an ERP/UI endpoint.
with eligible as materialized (
 select s.*,r.price_capture,r.payload->>'situacao' in('A','S') as source_active,
  r.payload->>'tipo'='P' and r.payload->>'formato'='S' as source_simple_product
 from origin_price_refresh.scope() s
 join origin_sync.raw_record r on r.entity='products' and r.source_id=s.source_id
 where s.covered and not exists(select 1 from erp_catalog.origin o where o.entity='products' and o.source_id=s.source_id)
), page as(select * from eligible order by source_id collate "C" limit 501)
select jsonb_build_object(
 'profile','proposal-product-adoption-evidence-v1','read_only',true,'exported_at',clock_timestamp(),
 'has_more',(select count(*)>500 from page),
 'items',coalesce((select jsonb_agg(jsonb_build_object(
  'source_id',source_id,'source_hash',product_hash,'source_version',product_version::text,'source_seen_at',product_seen_at,
  'proposal_id',proposal_id,'proposal_hash',proposal_hash,'proposal_version',proposal_version::text,
  'source_active',coalesce(source_active,false),'source_simple_product',coalesce(source_simple_product,false),
  'capture',jsonb_build_object('profile',price_capture->'profile','source',price_capture->'source',
   'response_sha256',price_capture->'response_sha256','capture_id',price_capture->'capture_id',
   'observed_at',price_capture->'observed_at','source_hash',price_capture->'source_hash','source_version',price_capture->'source_version',
   'numeric_price',exists(select 1 from jsonb_array_elements(price_capture->'tokens') t where t->>'path'='/preco'))
 ) order by source_id collate "C") from(select * from page order by source_id collate "C" limit 500) bounded),'[]'::jsonb)
) evidence;
