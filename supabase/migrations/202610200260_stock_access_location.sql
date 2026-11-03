-- 260: Permissões dos dashboards de produtos, Localização nos relatórios de estoque e o lançamento direto de composições (onda E do
-- estoque). Requer 107, 181, 222, 223, 229 (permissões de Sistema › Usuários) e 259. Nenhum movimento, saldo ou cadastro é gravado.
-- - Meu Negócio › Dashboard: Estoque de Produtos, Sugestão de Compras e Sem Movimentação seguem a permissão de cada dashboard
--   (meu_negocio.dashboard e meu_negocio.dashboard.estoque_produtos / .sugestao_compras / .sem_movimentacao), como os demais
--   dashboards (229). Sem conjunto gravado o usuário tem o que o perfil permite; o administrador tem tudo.
-- - Sem Movimentação: a saída lançada por uma nota de saída do Brufap (259) também conta como venda (Última Venda).
-- - Localização do produto (cadastro) para as telas de estoque: "Exibir localização nos relatórios de estoque" e "... no controle de
--   estoque" (Preferências › Cadastros › Configurações de produtos) são aplicadas na tela; esta leitura devolve a localização dos
--   produtos de uma página (até 500), para quem lê estoque.
-- - Composição Físico com "Lançar estoque" Componentes ou Produto e componente: Entrada e Saída diretas do estoque próprio pelo
--   Novo Lançamento comum (erp_stock_launch) são recusadas; o lançamento é o da composição (222).
begin;

do $$declare r record;begin
 if to_regprocedure('erp_access.require_permission(uuid,text)')is null or to_regclass('erp_stock.invoice_posting')is null or to_regclass('erp_stock.composition')is null then
  raise exception 'stock_access_location_260_requires_222_229_259' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer,uuid,text)','713deb1f509700be2ec499ef4a1de4692e649839388c373909887f1ea9725846'),
  ('public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text,uuid)','65d07d04624e7e5d530c85aac72bf0601b138b793741d7ed75e655a9cfb38848'),
  ('public.erp_stock_dashboard_idle(uuid,date,integer,integer)','11f55a8340a9fe17fe8c4b6585d9453249ff30630243b501a1941df788cd9311'),
  ('public.erp_stock_launch(uuid,uuid,text,uuid,uuid,text,integer,text,text,text,uuid,integer)','e67025c9b07e54df8d84e5a59121a70710c48ee06b4c0c45e5d11c4cce603e47'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_access_location_260_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Dashboards de produtos (107/181/223) with the permission of Meu Negócio. The rest of each body is the published one.
create or replace function public.erp_stock_dashboard_stock(p_user_id uuid,p_query text default null,p_search_by text default 'description',p_warehouse_id uuid default null,
  p_brand text default null,p_page integer default 1,p_size integer default 100,p_supplier_id uuid default null,p_stock_type text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;q text;v_cost boolean;begin
 perform erp_stock.require_access(p_user_id,false);
 -- 260: Sistema › Usuários › Permissões › Meu Negócio › Dashboard (229): the panel follows its permission, like the other dashboards.
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard');perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard.estoque_produtos');
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

create or replace function public.erp_stock_purchase_suggestion(p_user_id uuid,p_date_from date,p_date_to date,p_coverage integer,p_warehouse_id uuid default null,
  p_reserve boolean default false,p_purchase_statuses jsonb default null,p_sales_statuses jsonb default null,p_brand text default null,p_supplier_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_days integer;v_result jsonb;purchase text[];sales text[];v_mode text;begin
 perform erp_stock.require_access(p_user_id,false);
 -- 260: Sistema › Usuários › Permissões › Meu Negócio › Dashboard (229): the panel follows its permission, like the other dashboards.
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard');perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard.sugestao_compras');
 if not erp_documents.allowed((select role from erp_access.membership where user_id=p_user_id and active),'purchase_orders',false)then
  raise exception 'erp_stock_access_denied' using errcode='42501';end if;
 purchase:=erp_stock.dashboard_statuses(p_purchase_statuses,array['open','in_progress','partially_fulfilled','fulfilled','cancelled'],5);
 sales:=erp_stock.dashboard_statuses(p_sales_statuses,array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled'],7);
 if p_date_from is null or p_date_to is null or not isfinite(p_date_from) or not isfinite(p_date_to) or p_date_from>p_date_to or p_date_from<date '1900-01-01' or p_date_to>date '2100-12-31'
  or p_date_to-p_date_from>3660 or p_coverage is null or p_coverage not between 1 and 3650 or p_reserve is null or purchase is null or sales is null
  or length(p_brand)>100 or p_brand~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 if p_supplier_id is not null and not exists(select 1 from erp_catalog.contact where record_id=p_supplier_id)then raise exception 'erp_stock_supplier_not_found' using errcode='P0002';end if;
 v_mode:=case when coalesce(erp_preferences.get('compras.preco_padrao')='true'::jsonb,false)then
  case when erp_preferences.get('compras.preco_padrao_tipo')#>>'{}'='compra' then 'compra' else 'custo' end else 'ultima_compra' end;
 v_days:=p_date_to-p_date_from+1;
 with sold as materialized(select i.product_id,sum(i.quantity) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   join erp_catalog.product p on p.record_id=i.product_id
   where d.kind='sales_orders' and d.status=any(sales) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to
    and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and p.kind='P'
    and(nullif(btrim(p_brand),'')is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold(btrim(p_brand)))>0)
    and(p_supplier_id is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=i.product_id and s.supplier_id=p_supplier_id))
   group by i.product_id),
  ordered as materialized(select i.product_id,sum(greatest(i.quantity-erp_purchase_receipts.received(d.id,i.id),0)) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status=any(purchase) and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and i.product_id in(select product_id from sold)
    and not exists(select 1 from erp_stock.document_posting dp where dp.document_id=d.id and dp.state='active')
   group by i.product_id),
  last_purchase as materialized(select distinct on(i.product_id) i.product_id,i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id in(select product_id from sold) order by i.product_id,d.body->>'date' desc nulls last,d.created_at desc,i.position),
  -- The supplier of each product: the filtered one or, without a filter, the default one.
  supplier as materialized(select s.record_id product_id,s.supplier_id,r.name supplier_name,s.purchase_price,s.cost_price from erp_catalog.product_supplier s join erp_catalog.record r on r.id=s.supplier_id
   where s.record_id in(select product_id from sold) and(case when p_supplier_id is null then s.is_default else s.supplier_id=p_supplier_id end)),
  situation as materialized(select x.product_id,x.warehouse_id,x.quantity from erp_stock.situation_reservations()x where p_reserve and x.product_id in(select product_id from sold)),
  rows as materialized(select s.product_id,r.code,r.name,p.unit,s.quantity sold,erp_stock.count_physical(s.product_id,p_warehouse_id) stock,
    case when p_reserve then(select coalesce(sum(i.quantity),0)from erp_stock.reservation_item i join erp_stock.reservation x on x.id=i.reservation_id
     where x.state='active' and i.product_id=s.product_id and(i.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(i.warehouse_id))))
     +(select coalesce(sum(x.quantity),0)from situation x where x.product_id=s.product_id
      and(x.warehouse_id is null or x.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(x.warehouse_id))))else 0 end reserved,
    coalesce(o.quantity,0) ordered,f.supplier_id,f.supplier_name,
    case v_mode when 'custo' then f.cost_price when 'compra' then f.purchase_price end supplier_price,lp.unit_price last_price
   from sold s join erp_catalog.record r on r.id=s.product_id join erp_catalog.product p on p.record_id=s.product_id left join ordered o on o.product_id=s.product_id
   left join last_purchase lp on lp.product_id=s.product_id left join supplier f on f.product_id=s.product_id),
  computed as materialized(select *,greatest(div(sold*p_coverage-(stock-reserved+ordered)*v_days,v_days),0) suggestion,coalesce(supplier_price,last_price) unit_price,
    case when supplier_price is not null then case v_mode when 'custo' then 'supplier_cost' else 'supplier_purchase' end when last_price is not null then 'last_purchase' end price_source from rows)
 select jsonb_build_object('scope','stock_purchase_suggestion','data_mode','erp_native','days',v_days,'price_mode',v_mode,
  'filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'coverage',p_coverage,'warehouse_id',p_warehouse_id,'reserve',p_reserve,
   'purchase_statuses',to_jsonb(purchase),'sales_statuses',to_jsonb(sales),'brand',p_brand,'supplier_id',p_supplier_id),
  'total',(select count(*)from computed)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'sold',sold::numeric(38,6)::text,'stock',stock::numeric(38,6)::text,
    'reserved',reserved::numeric(38,6)::text,'ordered',ordered::numeric(38,6)::text,'suggestion',suggestion::numeric(38,0)::text,
    'unit_price',erp_stock.price_text(unit_price),'value',case when unit_price is null then null else round(suggestion*unit_price,2)::numeric(38,2)::text end,
    'price_source',price_source,'supplier_id',supplier_id,'supplier_name',supplier_name)
   order by suggestion desc,erp_catalog.fold(name),product_id)from(select * from computed order by suggestion desc,erp_catalog.fold(name),product_id limit 2000)c),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

create or replace function public.erp_stock_dashboard_idle(p_user_id uuid,p_since date,p_page integer default 1,p_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 -- 260: Sistema › Usuários › Permissões › Meu Negócio › Dashboard (229): the panel follows its permission, like the other dashboards.
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard');perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard.sem_movimentacao');
 if p_since is null or not isfinite(p_since) or p_since not between date '1900-01-01' and date '2100-12-31' or p_page is null or p_page not between 1 and 100000
  or p_size is null or p_size not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with stock as materialized(select b.product_id,sum(b.quantity) quantity from erp_stock.balance b where not erp_stock.ignored_warehouse(b.warehouse_id) group by b.product_id having sum(b.quantity)>0),
  sales as materialized(select e.product_id,max(m.occurred_on) last_sale from(
     select dp.movement_id from erp_stock.document_posting dp join erp_documents.document d on d.id=dp.document_id where dp.state='active' and d.kind in('sales_orders','service_orders')
     -- 260: the stock posted by an exit note of the Brufap (259) is a sale too.
     union all select ip.movement_id from erp_stock.invoice_posting ip join erp_fiscal_invoices.invoice v on v.id=ip.invoice_id where ip.state='active' and v.direction='1')x
    join erp_stock.movement m on m.id=x.movement_id join erp_stock.entry e on e.movement_id=m.id group by e.product_id),
  rows as materialized(select r.id,r.code,r.name,s.quantity,x.last_sale from stock s join erp_catalog.record r on r.id=s.product_id join erp_catalog.product p on p.record_id=s.product_id
   left join sales x on x.product_id=s.product_id where p.kind='P' and(x.last_sale is null or x.last_sale<p_since)),
  page as materialized(select * from rows order by last_sale nulls first,erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size)
 select jsonb_build_object('scope','stock_dashboard_idle','data_mode','erp_native','since',p_since,'page',p_page,'size',p_size,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',id,'code',code,'name',name,'quantity',quantity::numeric(38,6)::text,'last_sale',last_sale)
   order by last_sale nulls first,erp_catalog.fold(name),id)from page),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 2. Novo Lançamento (105) with the composition rule. The rest of the body is the published one.
create or replace function public.erp_stock_launch(p_user_id uuid,p_command_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid,p_quantity text,
  p_expected_version integer,p_unit_price text default null,p_unit_cost text default null,p_note text default null,
  p_destination_id uuid default null,p_destination_version integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.ledger_command;v_note text;v_reason text;v_default text;v_quantity numeric;v_price numeric;v_cost numeric;v_day date;
  b erp_stock.balance;v_current numeric:=0;v_delta numeric;v_items jsonb;v_post jsonb;v_movement uuid;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_command_id is null or p_kind is null or p_kind not in('receipt','issue','balance','transfer') or p_product_id is null or p_warehouse_id is null
  or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_quantity is null
  or p_quantity!~(case when p_kind='balance' then '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' else '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' end)
  or p_quantity~'^-0(\.0+)?$' or(p_kind<>'balance' and p_quantity::numeric=0)
  or(p_kind='transfer')<>(p_destination_id is not null)or(p_destination_id is null)<>(p_destination_version is null)
  or p_destination_version not between 0 and 2147483646 or p_destination_id=p_warehouse_id
  or(p_kind='issue' and p_unit_cost is not null)or length(p_note)>500 or p_note~'[[:cntrl:]]' then
  raise exception 'erp_stock_launch_invalid' using errcode='22023';end if;
 v_price:=erp_stock.price_105(p_unit_price);v_cost:=erp_stock.price_105(p_unit_cost);v_quantity:=p_quantity::numeric;
 v_default:=case when p_kind='transfer' then 'Transferência' else 'Lançamento manual' end;
 v_note:=coalesce(nullif(btrim(p_note),''),v_default);v_reason:=case when length(v_note)>=3 then v_note else v_default end;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-launch-105','actor',p_user_id,'kind',p_kind,'product_id',p_product_id,
  'warehouse_id',p_warehouse_id,'quantity',p_quantity,'expected_version',p_expected_version,'unit_price',p_unit_price,'unit_cost',p_unit_cost,
  'note',p_note,'destination_id',p_destination_id,'destination_version',p_destination_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,true);
 select * into c from erp_stock.ledger_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'launch' or c.request_hash<>h then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 -- 260: a Físico composition whose "Lançar estoque" is Componentes or Produto e componente is launched by the Novo Lançamento of the
 -- composition (222), which also moves the components: a direct Entrada or Saída of its own stock is refused. Balanço and
 -- transferência keep moving its own stock.
 if p_kind in('receipt','issue') and exists(select 1 from erp_stock.composition k join erp_catalog.product x on x.record_id=k.product_id
   where k.product_id=p_product_id and x.format='E' and k.post_mode in('components','both'))then
  raise exception 'erp_stock_composition_launch_required' using errcode='22023';end if;
 v_day:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
 if p_kind='balance' then
  -- Every balance writer holds mutex009, so the balance read here is the one the 009 post will update.
  select * into b from erp_stock.balance where product_id=p_product_id and warehouse_id=p_warehouse_id;
  v_current:=coalesce(b.quantity,0);
  if coalesce(b.version,0)<>p_expected_version then raise exception 'erp_stock_version_conflict' using errcode='40001';end if;
  v_delta:=v_quantity-v_current;
  if v_delta=0 then raise exception 'erp_stock_balance_unchanged' using errcode='22023';end if;
  if abs(v_delta)>999999999999.999999 then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity',v_delta::numeric(18,6)::text,'expected_version',p_expected_version));
 elsif p_kind='transfer' then
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity','-'||p_quantity,'expected_version',p_expected_version),
   jsonb_build_object('product_id',p_product_id,'warehouse_id',p_destination_id,'quantity',p_quantity,'expected_version',p_destination_version));
 else
  v_items:=jsonb_build_array(jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,'quantity',case when p_kind='issue' then '-'||p_quantity else p_quantity end,'expected_version',p_expected_version));
 end if;
 v_post:=erp_stock.post(p_user_id,p_command_id,case when p_kind='balance' then 'adjustment' else p_kind end,v_day,v_reason,null,v_items);
 if coalesce((v_post->>'replayed')::boolean,true)then raise exception 'erp_stock_launch_conflict' using errcode='40001';end if;
 v_movement:=(v_post#>>'{movement,id}')::uuid;
 v_result:=jsonb_build_object('scope','stock_launch','data_mode','erp_native','kind',p_kind,'occurred_on',v_day,'movement',v_post->'movement',
  'detail',jsonb_build_object('revision',1,'unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),'note',v_note),
  'balance',case when p_kind='balance' then jsonb_build_object('counted',v_quantity::numeric(18,6)::text,'previous',v_current::numeric(18,6)::text,'warehouse_id',p_warehouse_id,'source','launch')end);
 insert into erp_stock.ledger_command(id,actor,action,movement_id,request_hash,result)values(p_command_id,p_user_id,'launch',v_movement,h,v_result);
 insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id)values(v_movement,p_product_id,1,v_price,v_cost,v_note,p_user_id,p_command_id);
 if p_kind='balance' then
  insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source)values(v_movement,p_product_id,p_warehouse_id,v_quantity,v_current,'launch');
 end if;
 perform erp_stock.reservation_write_access(p_user_id);
 return v_result||jsonb_build_object('replayed',false);
end$$;

-- 3. Localização dos produtos de uma página dos relatórios de estoque (cadastro, 006/119), para quem lê estoque.
create function public.erp_stock_product_locations(p_user_id uuid,p_ids jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_ids is null or jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids) not between 1 and 500
  or exists(select 1 from jsonb_array_elements(p_ids)x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  or(select count(distinct x)from jsonb_array_elements_text(p_ids)x)<>jsonb_array_length(p_ids)then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 -- The location of a product mirrored from Origin may carry a tab or a line break: it is shown on one line.
 select jsonb_build_object('scope','stock_product_locations','data_mode','erp_native','items',coalesce(jsonb_agg(jsonb_build_object('product_id',p.record_id,
  'location',nullif(btrim(regexp_replace(p.location,'[[:cntrl:]]+',' ','g')),'')) order by p.record_id),'[]'::jsonb))
  into v_result from erp_catalog.product p where p.record_id in(select x::uuid from jsonb_array_elements_text(p_ids)x);
 return v_result;
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_dashboard_stock','erp_stock_purchase_suggestion','erp_stock_dashboard_idle','erp_stock_launch','erp_stock_product_locations')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
