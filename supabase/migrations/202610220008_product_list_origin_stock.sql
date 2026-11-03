-- Lista de produtos: saldo observado no Origin ao lado do estoque nativo, nunca somado nem misturado com ele.
-- * erp_stock_mirror.product_summary lê a posição corrente do espelho (001, current_position) pelo vínculo comprovado
--   erp_catalog.origin(products) e, com depósito escolhido, pelo vínculo erp_warehouse_import.binding (086). Nome e SKU
--   nunca associam saldos. Sem depósito escolhido, uma única posição é mostrada; várias posições não são somadas.
-- * erp_stock_mirror_product_summary: leitura em lote (até 250 produtos) para a página e a exportação, com a mesma
--   permissão do estoque nativo e do espelho (erp_stock.require_access). Somente service_role executa.
-- * Filtro Estoque da listagem/exportação/reajuste: novos valores origin_* (físico observado no Origin), ao lado dos nativos,
--   que continuam iguais. erp_catalog.stock_summary (234) não muda.
-- Somente leitura: nada aqui escreve no Origin, projeta o espelho, cria movimento, reserva, abertura ou saldo nativo.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regclass('erp_stock_mirror.current_position') is null or to_regclass('erp_warehouse_import.binding') is null
  or to_regprocedure('public.erp_stock_mirror_list(uuid,text,text,uuid,text,integer,bigint)') is null then
  raise exception 'product_list_origin_stock_requires_001_086' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_catalog.product_filters_valid(text,text,text,text,text,text,text,text,text,text,text,text,text,date,date)','97e6c5b4a30fb34accc53ea43832f0dd97023148192591da2dd2a027cc35f5e4'),
  ('erp_catalog.product_stock_filter(text,uuid)','1af7b82098c05edc2ce30796a7f7f744070c4142345e5e3bc7888656d0f0fc26'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'product_list_origin_stock_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- Estados: unlinked (produto sem vínculo Origin), warehouse_unlinked (depósito escolhido sem vínculo Origin),
-- not_observed (vinculado, sem posição no espelho), source_deleted (posição excluída na fonte), multiple_warehouses
-- (várias posições sem depósito escolhido; não somadas) e observed (uma posição; físico e virtual com o estado da fonte).
create function erp_stock_mirror.product_summary(p_ids uuid[],p_warehouse_id uuid)
returns table(product_id uuid,product_source_id text,state text,warehouse_source_id text,warehouse_name text,
 physical numeric,virtual numeric,physical_state text,virtual_state text,observed_at timestamptz,source_version bigint,positions integer,issues jsonb)
language sql stable set search_path=pg_catalog as $$
 with candidates as materialized(
  select p.record_id as id,o.source_id from erp_catalog.product p
   left join erp_catalog.origin o on o.entity='products' and o.record_id=p.record_id
   where p_ids is null or p.record_id=any(p_ids)
 ),wh as materialized(select b.source_id from erp_warehouse_import.binding b where b.warehouse_id=p_warehouse_id),
 cp as materialized(
  select c.* from erp_stock_mirror.current_position c
   where c.product_source_id in(select x.source_id from candidates x where x.source_id is not null)
    and(p_warehouse_id is null or c.warehouse_source_id in(select source_id from wh))
 ),agg as materialized(
  select c.id,c.source_id,count(p.id) filter(where not p.source_deleted)::integer as live,count(p.id) filter(where p.source_deleted)::integer as removed
   from candidates c left join cp p on p.product_source_id=c.source_id group by c.id,c.source_id
 )
 select a.id,a.source_id,
  case when a.source_id is null then 'unlinked' when p_warehouse_id is not null and not exists(select 1 from wh) then 'warehouse_unlinked'
   when a.live=1 then 'observed' when a.live>1 then 'multiple_warehouses' when a.removed>0 then 'source_deleted' else 'not_observed' end,
  nullif(s.warehouse_source_id,''),s.warehouse_name,s.physical,s.virtual,s.physical_state,s.virtual_state,s.observed_at,s.source_version,a.live,coalesce(s.issues,'[]'::jsonb)
 from agg a left join lateral(select * from cp where cp.product_source_id=a.source_id and not cp.source_deleted and a.live=1
  and(p_warehouse_id is null or exists(select 1 from wh))) s on true
$$;

create function public.erp_stock_mirror_product_summary(p_user_id uuid,p_product_ids uuid[],p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source text;v_items jsonb;
begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_ids is null or cardinality(p_product_ids)>250 or array_position(p_product_ids,null) is not null
  or(select count(distinct x) from unnest(p_product_ids) x)<>cardinality(p_product_ids) then
  raise exception 'stock_mirror_invalid_query' using errcode='22023'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'stock_mirror_warehouse_not_found' using errcode='P0002'; end if;
 select b.source_id into v_source from erp_warehouse_import.binding b where b.warehouse_id=p_warehouse_id;
 select coalesce(jsonb_agg(jsonb_build_object('product_id',s.product_id,'product_source_id',s.product_source_id,'state',s.state,
   'warehouse_source_id',s.warehouse_source_id,'warehouse_name',s.warehouse_name,'physical',s.physical::text,'virtual',s.virtual::text,
   'physical_state',s.physical_state,'virtual_state',s.virtual_state,'observed_at',s.observed_at,'source_version',s.source_version,
   'positions',s.positions,'issues',s.issues) order by u.n),'[]'::jsonb)
  into v_items from unnest(p_product_ids) with ordinality u(id,n) join erp_stock_mirror.product_summary(p_product_ids,p_warehouse_id) s on s.product_id=u.id;
 return jsonb_build_object('scope','product_stock_mirror','data_mode','origin_mirror','origin','origin','read_only',true,
  'warehouse',case when p_warehouse_id is null then null else jsonb_build_object('id',p_warehouse_id,'source_id',v_source,'linked',v_source is not null) end,
  'items',v_items);
end$$;

-- Filtros da página e da exportação (120): os valores nativos de antes e os origin_* (físico observado no Origin).
create or replace function erp_catalog.product_filters_valid(p_situation text,p_query text,p_product_type text,p_ncm_presence text,p_ncm text,p_brand text,
 p_stock text,p_images text,p_tag text,p_category text,p_item_type text,p_supplier_code text,p_period text,p_from date,p_to date) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_situation in('latest','active','inactive','deleted')
  and(p_query is null or(length(p_query)<=120 and p_query!~'[[:cntrl:]]'))
  and(p_product_type is null or p_product_type in('composition','no_composition','products','simple','with_variations','variations','services'))
  and(p_ncm_presence is null or p_ncm_presence in('present','missing'))
  and(p_ncm is null or(p_ncm~'^[0-9]{2,8}$' and p_ncm_presence is distinct from 'missing'))
  and(p_brand is null or(length(p_brand)<=100 and p_brand!~'[[:cntrl:]]'))
  and(p_stock is null or p_stock in('zero','negative','positive','no_movements','origin_zero','origin_negative','origin_positive','origin_not_observed','origin_unlinked'))
  and(p_images is null or p_images in('yes','no'))
  and(p_tag is null or p_tag='none' or p_tag~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and(p_category is null or p_category='none' or p_category~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  and(p_item_type is null or p_item_type in('00','01','02','03','04','05','06','07','08','09','10','99'))
  and(p_supplier_code is null or(length(p_supplier_code)<=60 and p_supplier_code!~'[[:cntrl:]]'))
  and((p_period is null and p_from is null and p_to is null) or(p_period in('created','updated','expiry') and num_nonnulls(p_from,p_to)>0))
  and(p_from is null or(isfinite(p_from) and p_from between date '1900-01-01' and date '2100-12-31'))
  and(p_to is null or(isfinite(p_to) and p_to between date '1900-01-01' and date '2100-12-31'))
  and(p_from is null or p_to is null or p_from<=p_to),false)
$$;

-- Os valores nativos seguem a regra de 096/120; origin_* usam o físico observado da mesma posição que a lista mostra.
-- Várias posições sem depósito escolhido não entram em maior/menor/igual a zero, porque não são somadas.
create or replace function erp_catalog.product_stock_filter(p_stock text,p_warehouse_id uuid) returns uuid[]
language sql stable set search_path=pg_catalog as $$
 select case when p_stock is null then null
  when p_stock in('origin_zero','origin_negative','origin_positive','origin_not_observed','origin_unlinked') then(select coalesce(array_agg(s.product_id),'{}'::uuid[])
   from erp_stock_mirror.product_summary(null,p_warehouse_id) s
   where case p_stock when 'origin_unlinked' then s.state='unlinked' when 'origin_not_observed' then s.state='not_observed'
    else s.state='observed' and s.physical_state='value' and case p_stock when 'origin_zero' then s.physical=0 when 'origin_positive' then s.physical>0 else s.physical<0 end end)
  else(select coalesce(array_agg(s.product_id),'{}'::uuid[])
  from(select product_id,case when p_warehouse_id is null then state else warehouse_state end as state,
    case when p_warehouse_id is null then quantity else warehouse_quantity end as quantity
   from erp_catalog.stock_summary(null,p_warehouse_id)) s
  where case p_stock when 'no_movements' then s.state='no_movements'
   else s.state='recorded' and case p_stock when 'zero' then s.quantity=0 when 'positive' then s.quantity>0 else s.quantity<0 end end) end
$$;

revoke all on function erp_stock_mirror.product_summary(uuid[],uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_mirror_product_summary(uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.erp_stock_mirror_product_summary(uuid,uuid[],uuid) to service_role;
commit;
