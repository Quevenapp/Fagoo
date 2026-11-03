-- Cadastro de produtos no padrão do Origin, onda E (área de produtos), parte 1: listagem, exportação e estoque da listagem.
-- * Listagem > Tipo "Produtos com composição" revela o filtro "Componente" do Origin ("Digite o nome ou código"): as composições
--   (formato "Com composição") cuja estrutura atual (erp_stock.composition_current, migração 222) usa o produto escolhido.
--   Página nova (erp_catalog_product_page_v3) com os parâmetros da v2, o filtro Campos customizados opcional e o Componente; a
--   v2 (120) e a página com Campos customizados (191) continuam iguais. A exportação recebe o Componente pela v2 dela.
-- * Exportação de produtos: o estoque exportado é o do depósito padrão (Preferências > Depósitos, migração 105), como no Origin;
--   sem depósito padrão, a soma dos depósitos considerados. erp_catalog_product_export (120) mantém a assinatura e passa a
--   responder pela erp_catalog_product_export_v2 (mesmos parâmetros mais o Componente), que diz qual estoque exportou.
-- * Estoque da listagem (coluna Estoque, cubo de Marcadores, filtro Estoque, Relatório de preço e o reajuste por estoque): um
--   depósito com "Desconsiderar saldo deste depósito" fica fora do total, como no extrato, nos relatórios e no saldo das
--   composições do estoque. O saldo do depósito escolhido no filtro Depósito continua sendo o dele. Uma posição em revisão em
--   qualquer depósito continua deixando o total em revisão (o total nunca esconde uma posição que não confere).
-- Somente leitura: nada aqui escreve no Origin, gera estoque, título, imposto ou XML. Depende de 096/105/120/191/222.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regclass('erp_stock.composition_current') is null or to_regclass('erp_stock.warehouse_default') is null
  or to_regprocedure('public.erp_catalog_product_page_custom(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,jsonb)') is null then
  raise exception 'product_list_234_requires_105_191_222' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_catalog.stock_summary(uuid[],uuid)','78ffc35baec26fa437b9bfe8213ffdd52a5111746a17e2d483147a3c9bd8baab'),
  ('public.erp_catalog_product_export(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean)','56c53ec7f7d553fb6df037ba3d80475ea2a20f599f085c95b3dc1a1a730243ca'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'product_list_234_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Estoque da listagem (096): mesma regra de posição (saldo e razão precisam conferir); o total soma só os depósitos considerados.
-- Um produto com posições apenas em depósitos desconsiderados tem total zero; sem posição nenhuma continua "sem lançamentos".
create or replace function erp_catalog.stock_summary(p_ids uuid[],p_warehouse_id uuid)
returns table(product_id uuid,state text,quantity numeric,warehouse_state text,warehouse_quantity numeric)
language sql stable set search_path=pg_catalog as $$
 with candidates as materialized(
  select p.record_id as id,p.unit,p.kind from erp_catalog.product p where p_ids is null or p.record_id=any(p_ids)
 ),ledger as materialized(
  select e.product_id,e.warehouse_id,count(*) as entry_count,sum(e.quantity) as ledger_quantity,max(e.balance_version) as last_version,
   bool_and(e.unit is not distinct from c.unit) as units_match
   from erp_stock.entry e join candidates c on c.id=e.product_id group by e.product_id,e.warehouse_id
 ),balances as materialized(select b.* from erp_stock.balance b join candidates c on c.id=b.product_id),
 positions as materialized(
  select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.warehouse_id,l.warehouse_id) as warehouse_id,b.quantity,
   case when b.product_id is null or l.product_id is null or c.unit is null or c.kind is distinct from 'P'
     or b.unit is distinct from c.unit or not coalesce(l.units_match,false)
     or b.version<>l.entry_count or b.version<>l.last_version or b.quantity<>l.ledger_quantity
    then 'review_required' else 'recorded' end as state,
   coalesce(ws.ignore_balance,false) as ignored
   from balances b full join ledger l on l.product_id=b.product_id and l.warehouse_id=b.warehouse_id
   join candidates c on c.id=coalesce(b.product_id,l.product_id)
   left join erp_stock.warehouse_setting ws on ws.warehouse_id=coalesce(b.warehouse_id,l.warehouse_id)
 )
 select c.id,
  case when bool_or(s.state='review_required') then 'review_required' when count(s.warehouse_id)=0 then 'no_movements' else 'recorded' end,
  case when coalesce(bool_or(s.state='review_required'),false) or count(s.warehouse_id)=0 then null else coalesce(sum(s.quantity) filter(where not s.ignored),0) end,
  case when p_warehouse_id is null then null else coalesce(max(s.state) filter(where s.warehouse_id=p_warehouse_id),'no_movements') end,
  case when p_warehouse_id is null then null else max(s.quantity) filter(where s.warehouse_id=p_warehouse_id and s.state='recorded') end
 from candidates c left join positions s on s.product_id=c.id group by c.id
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Filtro "Componente" (Tipo "Produtos com composição"): as composições cuja estrutura atual usa o produto; null sem o filtro.
create function erp_catalog.product_component_filter(p_component_id uuid) returns uuid[]
language sql stable set search_path=pg_catalog as $$
 select case when p_component_id is null then null else(select coalesce(array_agg(distinct i.product_id),'{}'::uuid[])
  from erp_stock.composition_current i join erp_catalog.product p on p.record_id=i.product_id where i.component_id=p_component_id and p.format='E') end
$$;
-- O Componente só vale com o Tipo "Produtos com composição" e precisa ser um produto do cadastro.
create function erp_catalog.product_component_valid(p_product_type text,p_component_id uuid) returns boolean
language sql stable set search_path=pg_catalog as $$
 select p_component_id is null or(p_product_type is not distinct from 'composition' and exists(select 1 from erp_catalog.product p where p.record_id=p_component_id))
$$;

-- Página v3: os filtros da v2, Campos customizados (opcional) e o Componente. Usada pela tela só com o Componente.
create function public.erp_catalog_product_page_v3(p_user_id uuid,p_page integer default 1,p_size integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null,
 p_custom jsonb default null,p_component_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_total bigint; v_items jsonb;
 v_brand text:=nullif(btrim(p_brand),''); v_code text:=nullif(btrim(p_supplier_code),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100
  or p_sort is null or p_sort not in('created_desc','name_asc','name_desc','code_asc','code_desc')
  or not erp_catalog.product_filters_valid(p_situation,p_query,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,p_images,p_tag,p_category,p_item_type,p_supplier_code,p_period,p_from,p_to)
  or not erp_catalog.product_component_valid(p_product_type,p_component_id) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 v_filter:=erp_catalog.product_ids_and(erp_catalog.product_ids_and(erp_catalog.product_stock_filter(p_stock,p_warehouse_id),
  case when p_custom is null or p_custom='null'::jsonb then null else erp_catalog.product_custom_filter(p_custom) end),erp_catalog.product_component_filter(p_component_id));
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

-- ---------------------------------------------------------------------------------------------------------------
-- Exportação de produtos (120) com o Componente e o estoque do depósito padrão. stock_scope diz qual estoque foi exportado:
-- default_warehouse (o depósito padrão, em stock_warehouse), considered_warehouses (sem depósito padrão: a soma dos depósitos
-- considerados) ou null (perfil sem consulta de estoque).
create function public.erp_catalog_product_export_v2(p_user_id uuid,p_offset integer default 0,p_limit integer default 250,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null,
 p_include_deleted boolean default false,p_component_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_total bigint; v_items jsonb; v_default uuid;
 v_brand text:=nullif(btrim(p_brand),''); v_code text:=nullif(btrim(p_supplier_code),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_offset is null or p_offset not between 0 and 10000000 or p_limit is null or p_limit not between 1 and 250 or p_include_deleted is null
  or p_sort is null or p_sort not in('created_desc','name_asc','name_desc','code_asc','code_desc')
  or not erp_catalog.product_filters_valid(p_situation,p_query,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,p_images,p_tag,p_category,p_item_type,p_supplier_code,p_period,p_from,p_to)
  or not erp_catalog.product_component_valid(p_product_type,p_component_id) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 if v_stock then select warehouse_id into v_default from erp_stock.warehouse_default where singleton; end if;
 v_filter:=erp_catalog.product_ids_and(erp_catalog.product_stock_filter(p_stock,p_warehouse_id),erp_catalog.product_component_filter(p_component_id));
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
    'stock',case when not v_stock then null when v_default is not null then case when k.warehouse_state='recorded' then round(k.warehouse_quantity,6)::text end
     when k.state='recorded' then round(k.quantity,6)::text end,
    'source_id',(select o.source_id from erp_catalog.origin o where o.record_id=u.id))
   order by u.n),'[]'::jsonb)
  into v_items from unnest(v_ids) with ordinality u(id,n)
  left join erp_catalog.stock_summary(case when v_stock then v_ids else '{}'::uuid[] end,v_default) k on k.product_id=u.id;
 return jsonb_build_object('entity','products','items',v_items,'offset',p_offset,'limit',p_limit,'total',v_total,'stock_visible',v_stock,
  'stock_scope',case when not v_stock then null when v_default is null then 'considered_warehouses' else 'default_warehouse' end,
  'stock_warehouse',case when v_default is not null then(select jsonb_build_object('id',r.id,'name',r.name) from erp_catalog.record r where r.id=v_default) end,
  'data_mode','erp_native');
end $$;

-- 120 keeps its signature (the Worker of before this migration calls it) and answers through the v2, without the Componente.
create or replace function public.erp_catalog_product_export(p_user_id uuid,p_offset integer default 0,p_limit integer default 250,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null,
 p_include_deleted boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 return public.erp_catalog_product_export_v2(p_user_id,p_offset,p_limit,p_sort,p_query,p_situation,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,
  p_warehouse_id,p_images,p_tag,p_category,p_item_type,p_supplier_id,p_supplier_code,p_period,p_from,p_to,p_include_deleted,null);
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_product_page_v3(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,jsonb,uuid)',
  'erp_catalog_product_export_v2(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean,uuid)',
  'erp_catalog_product_export(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,boolean)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
