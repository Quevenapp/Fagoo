begin;
-- Exact ID lookups and a separate indexed SKU fallback avoid an OR join over the product archive.
create index if not exists raw_stock_product_code on origin_sync.raw_record((payload->>'codigo'),source_id)where entity='products';
create or replace function erp_sync.indicator_products(p_entity text,p_source text)returns table(source_id text,code text)
language sql stable set search_path=pg_catalog as $$
 with items as materialized(
  select coalesce(nullif(i#>>'{produto,id}','0'),nullif(i->>'idProduto','0'))id,i->>'codigo'code
  from origin_sync.raw_record r cross join lateral jsonb_array_elements(coalesce(r.payload->'itens','[]'))i
  where r.entity=p_entity and r.source_id=p_source
 ),found as(
  select p.source_id,p.payload->>'codigo'code from items i join origin_sync.raw_record p on p.entity='products'and p.source_id=i.id where i.id is not null
  union all
  select p.source_id,p.payload->>'codigo'code from items i join origin_sync.raw_record p on p.entity='products'and p.payload->>'codigo'=i.code
   where i.id is null and (select count(*)from origin_sync.raw_record p2 where p2.entity='products'and p2.payload->>'codigo'=i.code)=1
 )select distinct source_id,code from found where nullif(code,'')is not null
$$;
revoke all on function erp_sync.indicator_products(text,text)from public,anon,authenticated,service_role;
commit;
