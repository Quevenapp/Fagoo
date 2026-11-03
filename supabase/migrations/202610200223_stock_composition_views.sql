-- 223: Composições nas telas de estoque (onda D). Requer 222. Somente leitura: nenhum movimento, saldo ou cadastro é gravado.
-- - Meu Negócio > Estoque de Produtos, filtro "Tipo de Estoque": Virtual = composições com estoque Virtual, com o saldo virtual de cada
--   depósito (máximo de composições completas com os componentes daquele depósito) e o total dos depósitos considerados; Físico = os
--   demais produtos, inclusive a composição Físico, que tem saldo próprio. Sem filtro, as duas aparecem (o saldo virtual vem dos
--   componentes, que também aparecem nas suas linhas). Antes da 222, "Virtual" listava as composições que tivessem saldo registrado.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_stock.virtual_positions(uuid)')is null then raise exception 'stock_composition_views_223_requires_222' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text)','90b908b01a1232dceb03b540ce52ddcbd54638d361ffcc14e827d28128c14345'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_composition_views_223_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- Estoque de Produtos (181) with the saldo virtual of the Virtual compositions. The rest of the body is the published one.
create or replace function public.erp_stock_dashboard_stock(p_user_id uuid,p_query text default null,p_search_by text default 'description',p_warehouse_id uuid default null,
  p_brand text default null,p_page integer default 1,p_size integer default 100,p_supplier_id uuid default null,p_stock_type text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;q text;v_cost boolean;begin
 perform erp_stock.require_access(p_user_id,false);
 v_cost:=erp_stock.cost_visible(p_user_id);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100 or p_search_by is null or p_search_by not in('code','description','gtin')
  or length(p_query)>120 or p_query~'[[:cntrl:]]' or length(p_brand)>100 or p_brand~'[[:cntrl:]]' or(p_stock_type is not null and p_stock_type not in('physical','virtual'))then
  raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 if p_supplier_id is not null and not exists(select 1 from erp_catalog.contact where record_id=p_supplier_id)then raise exception 'erp_stock_supplier_not_found' using errcode='P0002';end if;
 q:=nullif(erp_catalog.fold(btrim(p_query)),'');
 with products as materialized(select r.id,r.name,r.code,p.price,p.gtin,
    -- 223: a Virtual composition (with a structure) has no stock of its own; its saldo comes from the components.
    (p.format='E' and exists(select 1 from erp_stock.composition c where c.product_id=r.id and c.stock_type='virtual')
     and exists(select 1 from erp_stock.composition_current i where i.product_id=r.id)) is_virtual
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where p.kind='P'
    and(q is null or case p_search_by when 'code' then strpos(erp_catalog.fold(coalesce(r.code,'')),q)>0 when 'gtin' then strpos(coalesce(p.gtin,''),btrim(p_query))>0 or strpos(coalesce(p.gtin_tax,''),btrim(p_query))>0 else strpos(erp_catalog.fold(r.name),q)>0 end)
    and(nullif(btrim(p_brand),'')is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold(btrim(p_brand)))>0)
    and(p_supplier_id is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and s.supplier_id=p_supplier_id))),
  typed as materialized(select * from products where p_stock_type is null or(p_stock_type='virtual')=is_virtual),
  scoped as materialized(select b.product_id,b.warehouse_id,b.quantity,erp_stock.ignored_warehouse(b.warehouse_id) ignored from erp_stock.balance b join typed p on p.id=b.product_id
    where not p.is_virtual and(p_warehouse_id is null or b.warehouse_id=p_warehouse_id)
   union all
   select p.id,v.warehouse_id,v.quantity,erp_stock.ignored_warehouse(v.warehouse_id) from typed p cross join lateral erp_stock.virtual_positions(p.id) v
    where p.is_virtual and(p_warehouse_id is null or v.warehouse_id=p_warehouse_id)),
  costs as materialized(select c.product_id,c.average_cost from erp_stock.average_costs(array(select distinct product_id from scoped))c where v_cost),
  supplier as materialized(select s.record_id product_id,s.cost_price from erp_catalog.product_supplier s
   where v_cost and s.is_default and s.cost_price is not null and s.record_id in(select product_id from scoped)),
  stock as materialized(select s.product_id,sum(s.quantity) filter(where p_warehouse_id is not null or not s.ignored) quantity from scoped s group by s.product_id),
  rows as materialized(select p.id,p.name,p.code,p.price,coalesce(s.quantity,0) quantity,c.average_cost,x.cost_price supplier_cost,coalesce(x.cost_price,c.average_cost) unit_cost
   from typed p join stock s on s.product_id=p.id left join costs c on c.product_id=p.id left join supplier x on x.product_id=p.id),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size),
  by_warehouse as materialized(select s.warehouse_id,bool_or(s.ignored) ignored,sum(s.quantity) quantity,sum(s.quantity*p.price) filter(where p.price is not null) value,
    sum(s.quantity*c.average_cost) filter(where c.average_cost is not null) cost,
    sum(s.quantity*coalesce(x.cost_price,c.average_cost)) filter(where coalesce(x.cost_price,c.average_cost) is not null) stock_cost
   from scoped s join typed p on p.id=s.product_id left join costs c on c.product_id=s.product_id left join supplier x on x.product_id=s.product_id group by s.warehouse_id)
 select jsonb_build_object('scope','stock_dashboard_stock','data_mode','erp_native','page',p_page,'size',p_size,'total',(select count(*)from rows)::integer,
  'filters',jsonb_build_object('query',p_query,'search_by',p_search_by,'warehouse_id',p_warehouse_id,'brand',p_brand,'supplier_id',p_supplier_id,'stock_type',p_stock_type),
  'cost_basis',erp_stock.settings_dto()->'average_cost_base','cost_visible',v_cost,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',id,'code',code,'name',name,'quantity',quantity::numeric(38,6)::text,
    'value',case when price is null then null else round(quantity*price,2)::numeric(38,2)::text end,
    'average_cost',erp_stock.price_text(average_cost),'cost',case when average_cost is null then null else round(quantity*average_cost,2)::numeric(38,2)::text end,
    'supplier_cost',erp_stock.price_text(supplier_cost),'unit_cost',erp_stock.price_text(unit_cost),
    'cost_source',case when supplier_cost is not null then 'supplier' when average_cost is not null then 'average' end,
    'stock_cost',case when unit_cost is null then null else round(quantity*unit_cost,2)::numeric(38,2)::text end) order by erp_catalog.fold(name),id)from page),'[]'::jsonb),
  'totals',jsonb_build_object('quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,'value',(select coalesce(round(sum(quantity*price),2),0)from rows where price is not null)::numeric(38,2)::text,
   'unpriced',(select count(*)from rows where price is null)::integer,
   'cost',case when v_cost then(select coalesce(round(sum(quantity*average_cost),2),0)from rows where average_cost is not null)::numeric(38,2)::text end,
   -- Products without a cost are counted only when they have stock (a zero balance has no cost to show).
   'uncosted',case when v_cost then(select count(*)from rows where average_cost is null and quantity<>0)::integer end,
   'stock_cost',case when v_cost then(select coalesce(round(sum(quantity*unit_cost),2),0)from rows where unit_cost is not null)::numeric(38,2)::text end,
   'stock_uncosted',case when v_cost then(select count(*)from rows where unit_cost is null and quantity<>0)::integer end,
   'supplier_costed',case when v_cost then(select count(*)from rows where supplier_cost is not null)::integer end),
  'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouse_id',w.warehouse_id,'name',r.name,'ignored',w.ignored,'quantity',w.quantity::numeric(38,6)::text,
    'value',coalesce(round(w.value,2),0)::numeric(38,2)::text,'cost',case when v_cost then coalesce(round(w.cost,2),0)::numeric(38,2)::text end,
    'stock_cost',case when v_cost then coalesce(round(w.stock_cost,2),0)::numeric(38,2)::text end) order by erp_catalog.fold(r.name),w.warehouse_id)
   from by_warehouse w join erp_catalog.record r on r.id=w.warehouse_id),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

revoke all on function public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text) to service_role;
commit;
