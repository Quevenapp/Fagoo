-- Cadastro de produtos no padrão do Origin, parte 2: a listagem com os filtros e as colunas do Origin e a leitura em lotes
-- da exportação para planilha. Somente leitura. Depende de 096 e 119.
--   Situação: Últimos Incluídos (ativos e inativos, sem os excluídos) | Ativos | Inativos | Excluídos.
--   Tipo do Origin num único filtro; Imagens; Tags; Categoria; Classificação (Tipo do item); Fornecedor; Cód fornecedor;
--   período "Alterado em" (horário de São Paulo) ou "Data de validade" (data, sem fuso).
-- erp_catalog_product_page (096) continua igual para quem ainda a usa.
begin;

-- Um único FROM/WHERE para a página e para a exportação. Todos os valores do usuário seguem como parâmetros ($1..$19);
-- só a coluna do período vem de um fragmento fixo.
create function erp_catalog.product_filter_sql(p_period text) returns text
language sql immutable set search_path=pg_catalog as $$
 select format($q$ from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
  left join erp_catalog.product_detail d on d.record_id=r.id
  where r.entity='products'
   and(case $1::text when 'deleted' then d.deleted_at is not null
     else(d.deleted_at is null and case $1::text when 'active' then r.active when 'inactive' then not r.active else true end)
      or($19::boolean and d.deleted_at is not null) end)
   and($2::text[] is null or erp_catalog.matches($2,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
   and(case $3::text when 'composition' then p.format='E' when 'no_composition' then p.format is distinct from 'E'
     when 'products' then p.kind='P' when 'simple' then p.format='S' when 'with_variations' then p.format='V'
     when 'variations' then false when 'services' then p.kind='S' else true end)
   and($4::text is null or case $4 when 'present' then nullif(btrim(p.ncm),'') is not null else nullif(btrim(p.ncm),'') is null end)
   and($5::text is null or left(coalesce(p.ncm,''),length($5))=$5)
   and($6::text is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold($6))>0)
   and($7::uuid[] is null or r.id=any($7))
   and($8::text is null or case $8 when 'yes' then exists(select 1 from erp_catalog.product_image i where i.record_id=r.id)
     else not exists(select 1 from erp_catalog.product_image i where i.record_id=r.id) end)
   and($9::text is null or case $9 when 'none' then not exists(select 1 from erp_catalog.product_tag x where x.record_id=r.id)
     else exists(select 1 from erp_catalog.product_tag x where x.record_id=r.id and x.tag_id=$9::uuid) end)
   and($10::text is null or case $10 when 'none' then d.category_id is null else d.category_id=$10::uuid end)
   and($11::text is null or d.item_type=$11)
   and($12::uuid is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and s.supplier_id=$12))
   and($13::text is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and strpos(erp_catalog.fold(coalesce(s.code,'')),erp_catalog.fold($13))>0))
   and($14::timestamptz is null or %1$s>=$14) and($15::timestamptz is null or %1$s<$15)
   and($16::date is null or d.expiry_date>=$16) and($17::date is null or d.expiry_date<=$17)
   and($18::boolean is null or true)$q$,
  case p_period when 'created' then 'r.created_at' else 'r.updated_at' end)
$$;

-- Validação comum aos filtros da página e da exportação.
create function erp_catalog.product_filters_valid(p_situation text,p_query text,p_product_type text,p_ncm_presence text,p_ncm text,p_brand text,
 p_stock text,p_images text,p_tag text,p_category text,p_item_type text,p_supplier_code text,p_period text,p_from date,p_to date) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_situation in('latest','active','inactive','deleted')
  and(p_query is null or(length(p_query)<=120 and p_query!~'[[:cntrl:]]'))
  and(p_product_type is null or p_product_type in('composition','no_composition','products','simple','with_variations','variations','services'))
  and(p_ncm_presence is null or p_ncm_presence in('present','missing'))
  and(p_ncm is null or(p_ncm~'^[0-9]{2,8}$' and p_ncm_presence is distinct from 'missing'))
  and(p_brand is null or(length(p_brand)<=100 and p_brand!~'[[:cntrl:]]'))
  and(p_stock is null or p_stock in('zero','negative','positive','no_movements'))
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

-- Produtos do filtro de estoque (mesma regra de posições de 096), ou null sem o filtro.
create function erp_catalog.product_stock_filter(p_stock text,p_warehouse_id uuid) returns uuid[]
language sql stable set search_path=pg_catalog as $$
 select case when p_stock is null then null else(select coalesce(array_agg(s.product_id),'{}'::uuid[])
  from(select product_id,case when p_warehouse_id is null then state else warehouse_state end as state,
    case when p_warehouse_id is null then quantity else warehouse_quantity end as quantity
   from erp_catalog.stock_summary(null,p_warehouse_id)) s
  where case p_stock when 'no_movements' then s.state='no_movements'
   else s.state='recorded' and case p_stock when 'zero' then s.quantity=0 when 'positive' then s.quantity>0 else s.quantity<0 end end) end
$$;

-- Item da listagem: o item enxuto de 096 mais as colunas da listagem customizada do Origin e a miniatura (primeira imagem).
create function erp_catalog.product_list_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select erp_catalog.list_item(p_id)||jsonb_build_object(
  'stock_min',p.stock_min::text,'stock_max',p.stock_max::text,'location',p.location,
  'cost_price',(select erp_catalog.unit_price_numeric(s.cost_price,14) from erp_catalog.product_supplier s where s.record_id=p_id and s.is_default),
  'thumbnail',(select i.url from erp_catalog.product_image i where i.record_id=p_id order by i.position limit 1),
  'category_id',d.category_id,'expiry_date',to_char(d.expiry_date,'YYYY-MM-DD'),'deleted',d.deleted_at is not null)
 from erp_catalog.product p left join erp_catalog.product_detail d on d.record_id=p.record_id where p.record_id=p_id
$$;

create function public.erp_catalog_product_page_v2(p_user_id uuid,p_page integer default 1,p_size integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_total bigint; v_items jsonb;
 v_brand text:=nullif(btrim(p_brand),''); v_code text:=nullif(btrim(p_supplier_code),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100
  or p_sort is null or p_sort not in('created_desc','name_asc','name_desc','code_asc','code_desc')
  or not erp_catalog.product_filters_valid(p_situation,p_query,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,p_images,p_tag,p_category,p_item_type,p_supplier_code,p_period,p_from,p_to) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 v_filter:=erp_catalog.product_stock_filter(p_stock,p_warehouse_id);
 v_terms:=erp_catalog.search_terms(p_query);
 execute erp_catalog.page_sql(erp_catalog.product_filter_sql(p_period),p_sort,true,20) into v_total,v_ids
  using p_situation,v_terms,p_product_type,p_ncm_presence,p_ncm,v_brand,v_filter,p_images,p_tag,p_category,p_item_type,p_supplier_id,v_code,
   case when p_period in('created','updated') and p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period in('created','updated') and p_to is not null then(p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period='expiry' then p_from end,case when p_period='expiry' then p_to end,null::boolean,false,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.product_list_item(u.id)||jsonb_build_object('stock',case when v_stock then jsonb_build_object(
    'state',s.state,'quantity',case when s.state='recorded' then round(s.quantity,6)::text end,
    'warehouse',case when p_warehouse_id is not null then jsonb_build_object('id',p_warehouse_id,'state',s.warehouse_state,
     'quantity',case when s.warehouse_state='recorded' then round(s.warehouse_quantity,6)::text end) end) end) order by u.n),'[]'::jsonb)
  into v_items from unnest(v_ids) with ordinality u(id,n)
  left join erp_catalog.stock_summary(case when v_stock then v_ids else '{}'::uuid[] end,p_warehouse_id) s on s.product_id=u.id;
 return jsonb_build_object('entity','products','items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,
  'stock_visible',v_stock,'data_mode','erp_native');
end $$;

-- Exportação de produtos: os mesmos filtros da listagem, mais "Incluir produtos marcados como excluídos", em lotes de até 250
-- (a planilha de 1000 linhas do Origin é montada pela tela em 4 leituras, para que cada resposta caiba no limite da API).
-- Estoque: soma dos depósitos para quem pode consultar estoque (o Brufap não tem depósito padrão).
create function public.erp_catalog_product_export(p_user_id uuid,p_offset integer default 0,p_limit integer default 250,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null,
 p_include_deleted boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_total bigint; v_items jsonb;
 v_brand text:=nullif(btrim(p_brand),''); v_code text:=nullif(btrim(p_supplier_code),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_offset is null or p_offset not between 0 and 10000000 or p_limit is null or p_limit not between 1 and 250 or p_include_deleted is null
  or p_sort is null or p_sort not in('created_desc','name_asc','name_desc','code_asc','code_desc')
  or not erp_catalog.product_filters_valid(p_situation,p_query,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,p_images,p_tag,p_category,p_item_type,p_supplier_code,p_period,p_from,p_to) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 v_filter:=erp_catalog.product_stock_filter(p_stock,p_warehouse_id);
 v_terms:=erp_catalog.search_terms(p_query);
 execute erp_catalog.page_sql(erp_catalog.product_filter_sql(p_period),p_sort,true,20) into v_total,v_ids
  using p_situation,v_terms,p_product_type,p_ncm_presence,p_ncm,v_brand,v_filter,p_images,p_tag,p_category,p_item_type,p_supplier_id,v_code,
   case when p_period in('created','updated') and p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period in('created','updated') and p_to is not null then(p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period='expiry' then p_from end,case when p_period='expiry' then p_to end,null::boolean,p_include_deleted,p_offset,p_limit;
 select coalesce(jsonb_agg(erp_catalog.dto(u.id)-'source'-'entity'
   ||(erp_catalog.product_detail_data(u.id,true)-'suppliers'-'dun_codes'-'images')
   ||jsonb_build_object('category',(select t.name from erp_catalog.taxonomy t join erp_catalog.product_detail d on d.category_id=t.id where d.record_id=u.id),
    'product_group',(select t.name from erp_catalog.taxonomy t join erp_catalog.product_detail d on d.product_group_id=t.id where d.record_id=u.id),
    'tags',(select coalesce(jsonb_agg(t.name order by erp_catalog.fold(t.name)),'[]'::jsonb) from erp_catalog.product_tag x join erp_catalog.taxonomy t on t.id=x.tag_id where x.record_id=u.id),
    'images',(select coalesce(jsonb_agg(i.url order by i.position),'[]'::jsonb) from erp_catalog.product_image i where i.record_id=u.id),
    'supplier',(select jsonb_build_object('name',c.name,'description',s.description,'code',s.code,'purchase_price',erp_catalog.unit_price_numeric(s.purchase_price,14),
      'cost_price',erp_catalog.unit_price_numeric(s.cost_price,14),'warranty_months',s.warranty_months::text)
     from erp_catalog.product_supplier s join erp_catalog.record c on c.id=s.supplier_id where s.record_id=u.id order by s.is_default desc,s.position limit 1),
    'stock',case when v_stock and s.state='recorded' then round(s.quantity,6)::text end,'source_id',(select o.source_id from erp_catalog.origin o where o.record_id=u.id))
   order by u.n),'[]'::jsonb)
  into v_items from unnest(v_ids) with ordinality u(id,n)
  left join erp_catalog.stock_summary(case when v_stock then v_ids else '{}'::uuid[] end,null) s on s.product_id=u.id;
 return jsonb_build_object('entity','products','items',v_items,'offset',p_offset,'limit',p_limit,'total',v_total,'stock_visible',v_stock,'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_product_page_v2(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date) from public,anon,authenticated;
revoke all on function public.erp_catalog_product_export(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean) from public,anon,authenticated;
grant execute on function public.erp_catalog_product_page_v2(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date) to service_role;
grant execute on function public.erp_catalog_product_export(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean) to service_role;
commit;
