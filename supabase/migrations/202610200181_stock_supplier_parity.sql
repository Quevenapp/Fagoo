-- 181: Estoque no padrão do Origin, onda C — fornecedores, imagens e DUN do cadastro do produto (119) no estoque.
-- Requer 105-107, 115, 119 e 145-147. Somente leitura sobre o cadastro (erp_catalog.product_supplier, product_dun e product_image,
-- que pertencem ao cadastro de produtos) e sobre o razão: nenhum movimento, saldo, preço, custo, reserva ou cadastro é gravado aqui.
-- - Meu Negócio > Estoque de Produtos: filtros Fornecedor e Tipo de Estoque (Físico | Virtual) e a coluna Custo do Origin
--   (custo do fornecedor padrão × quantidade). Sem fornecedor padrão com custo, a linha usa o custo médio (145) e diz isso;
--   "sem custo" conta só produtos com estoque diferente de zero. As colunas da 145 (custo médio) continuam na resposta.
-- - Sugestão de Compras: filtro Fornecedor; Valor Estimado pelo preço padrão dos pedidos de compra (Preferências > Suprimentos >
--   Configurações de pedidos de compras: preço de custo ou de compra do fornecedor) e, sem ele, pelo preço da última compra; a unidade
--   e o fornecedor de cada produto, para "Gerar pedido de compra com os selecionados" (o pedido é criado pela API de documentos).
-- - Novo Lançamento: o fornecedor padrão e os seus preços para "Preço de compra/custo do fornecedor padrão" (145 sugeria nada).
-- - Seletores de depósito dos painéis, da conferência e dos relatórios: lista leve dos depósitos (sem calcular totais).
-- - Conferência de estoque: a imagem do produto; Check-in: códigos DUN e o código do produto no fornecedor da nota e o nome de quem
--   iniciou e finalizou a conferência (Sistema › Usuários).
-- Composições com estoque virtual não existem no Brufap: "Virtual" lista os produtos de formato Com composição que tiverem saldo.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regclass('erp_catalog.product_supplier')is null or to_regclass('erp_catalog.product_dun')is null or to_regclass('erp_catalog.product_image')is null
  or to_regclass('erp_access.profile')is null then raise exception 'stock_supplier_181_requires_119' using errcode='55000';end if;
 if to_regprocedure('erp_stock.average_costs(uuid[])')is null or to_regprocedure('erp_stock.checkin_note_dto(uuid)')is null then
  raise exception 'stock_supplier_181_requires_145_147' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer)','dcd791c0a64a531204b29a616692485957821caef1e4724dde94cc72d58b7994'),
  ('public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text)','c69dc0efdf7d6a234e117370b960c38d3803e791786fb419d9bb1230d125b375'),
  ('public.erp_stock_launch_context(uuid,uuid)','42d1db9b5f332b1e1e10aca3ec9e661d525a9c13b4827927492898ae97f26ef9'),
  ('erp_stock.count_dto(uuid)','356c4aefb8ef3c1770254f1fd32778b7843ec6f1b9d556b04eb0a9b14b36ebea'),
  ('erp_stock.checkin_items(uuid)','bea5e7cecd31c47a6b917412b47837a8ce4f2cce091c9e76b904d925da139c4b'),
  ('erp_stock.checkin_dto(uuid)','09a8bf3a340dd73c62fbe3e2c560311f88031ee94cabfd6dd3116fa7aa911cd9'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_supplier_181_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Fornecedor padrão do produto (aba Fornecedores do cadastro, 119): no máximo um por produto (índice único parcial).
create function erp_stock.default_supplier(p_product uuid)returns table(supplier_id uuid,supplier_name text,code text,purchase_price numeric,cost_price numeric)
language sql stable set search_path=pg_catalog as $$
 select s.supplier_id,r.name,s.code,s.purchase_price,s.cost_price from erp_catalog.product_supplier s join erp_catalog.record r on r.id=s.supplier_id
 where s.record_id=p_product and s.is_default
$$;

-- 2. Seletores "Depósito": a lista dos depósitos para todo leitor de estoque (os nomes já aparecem nos saldos, 009/105), sem os
-- totais de /totais. Ativos primeiro quando houver mais de 500; a tela mostra os inativos só enquanto são o filtro atual.
create function public.erp_stock_warehouse_options(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 with rows as materialized(select r.id,r.name,r.active,coalesce(d.warehouse_id=r.id,false) is_default,erp_stock.ignored_warehouse(r.id) ignore_balance
   from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id cross join erp_stock.warehouse_default d),
  page as materialized(select * from rows order by active desc,erp_catalog.fold(name),id limit 500)
 select jsonb_build_object('scope','stock_warehouse_options','data_mode','erp_native','total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'is_default',is_default,'ignore_balance',ignore_balance)
   order by erp_catalog.fold(name),id)from page),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 3. Filtro "Fornecedor": contatos fornecedores ativos e todo contato ligado a um produto (aba Fornecedores), com busca por nome
-- ou código. Até 50 por consulta; "products" diz a quantos produtos o fornecedor está ligado.
create function public.erp_stock_suppliers(p_user_id uuid,p_query text default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare q text;v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if length(p_query)>120 or p_query~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 q:=nullif(erp_catalog.fold(btrim(p_query)),'');
 with rows as materialized(select r.id,r.name,r.code,r.active,(select count(*)from erp_catalog.product_supplier s where s.supplier_id=r.id)::integer products
   from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
   where((r.active and 'supplier'=any(c.roles))or exists(select 1 from erp_catalog.product_supplier s where s.supplier_id=r.id))
    and(q is null or strpos(erp_catalog.fold(r.name),q)>0 or strpos(erp_catalog.fold(coalesce(r.code,'')),q)>0)),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit 50)
 select jsonb_build_object('scope','stock_suppliers','data_mode','erp_native','query',p_query,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'code',code,'active',active,'products',products) order by erp_catalog.fold(name),id)from page),'[]'::jsonb))
 into v_result;
 return v_result;
end$$;

-- 4. Estoque de Produtos (107/145) com Fornecedor e Tipo de Estoque. Custo do Origin = custo do fornecedor padrão × quantidade
-- (stock_cost, unit_cost, cost_source); sem esse custo, o custo médio da 145. average_cost e cost (custo médio × quantidade) ficam
-- como na 145. Tudo isso é dado de compra: null para quem não lê pedidos de compra (cost_visible).
drop function public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer);
create function public.erp_stock_dashboard_stock(p_user_id uuid,p_query text default null,p_search_by text default 'description',p_warehouse_id uuid default null,
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
 with products as materialized(select r.id,r.name,r.code,p.price,p.gtin from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where p.kind='P'
    and(q is null or case p_search_by when 'code' then strpos(erp_catalog.fold(coalesce(r.code,'')),q)>0 when 'gtin' then strpos(coalesce(p.gtin,''),btrim(p_query))>0 or strpos(coalesce(p.gtin_tax,''),btrim(p_query))>0 else strpos(erp_catalog.fold(r.name),q)>0 end)
    and(nullif(btrim(p_brand),'')is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold(btrim(p_brand)))>0)
    and(p_supplier_id is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and s.supplier_id=p_supplier_id))
    -- Tipo de Estoque: Virtual = composição (formato E); Físico = os demais, que têm estoque próprio.
    and(p_stock_type is null or(p_stock_type='virtual')=(p.format is not distinct from 'E'))),
  scoped as materialized(select b.product_id,b.warehouse_id,b.quantity,erp_stock.ignored_warehouse(b.warehouse_id) ignored from erp_stock.balance b join products p on p.id=b.product_id
   where p_warehouse_id is null or b.warehouse_id=p_warehouse_id),
  costs as materialized(select c.product_id,c.average_cost from erp_stock.average_costs(array(select distinct product_id from scoped))c where v_cost),
  supplier as materialized(select s.record_id product_id,s.cost_price from erp_catalog.product_supplier s
   where v_cost and s.is_default and s.cost_price is not null and s.record_id in(select product_id from scoped)),
  stock as materialized(select s.product_id,sum(s.quantity) filter(where p_warehouse_id is not null or not s.ignored) quantity from scoped s group by s.product_id),
  rows as materialized(select p.id,p.name,p.code,p.price,coalesce(s.quantity,0) quantity,c.average_cost,x.cost_price supplier_cost,coalesce(x.cost_price,c.average_cost) unit_cost
   from products p join stock s on s.product_id=p.id left join costs c on c.product_id=p.id left join supplier x on x.product_id=p.id),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size),
  by_warehouse as materialized(select s.warehouse_id,bool_or(s.ignored) ignored,sum(s.quantity) quantity,sum(s.quantity*p.price) filter(where p.price is not null) value,
    sum(s.quantity*c.average_cost) filter(where c.average_cost is not null) cost,
    sum(s.quantity*coalesce(x.cost_price,c.average_cost)) filter(where coalesce(x.cost_price,c.average_cost) is not null) stock_cost
   from scoped s join products p on p.id=s.product_id left join costs c on c.product_id=s.product_id left join supplier x on x.product_id=s.product_id group by s.warehouse_id)
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

-- 5. Sugestão de Compras (107/145) com Fornecedor. A fórmula e as regras são as da 145. Valor Estimado: com "Definir o preço padrão
-- dos pedidos de compra" ligado, o preço de custo ou de compra do fornecedor (o filtrado ou, sem filtro, o padrão); sem esse preço ou
-- com a opção desligada, o preço da última compra registrada no Brufap (107). price_source diz a origem de cada preço.
drop function public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text);
create function public.erp_stock_purchase_suggestion(p_user_id uuid,p_date_from date,p_date_to date,p_coverage integer,p_warehouse_id uuid default null,
  p_reserve boolean default false,p_purchase_statuses jsonb default null,p_sales_statuses jsonb default null,p_brand text default null,p_supplier_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_days integer;v_result jsonb;purchase text[];sales text[];v_mode text;begin
 perform erp_stock.require_access(p_user_id,false);
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

-- 6. Novo Lançamento e Transferência (145) com o fornecedor padrão: "Preço de compra do fornecedor padrão" e "Preço de custo do
-- fornecedor padrão" usam default_supplier (preço de compra e de custo da aba Fornecedores). O resto é o da 145.
create or replace function public.erp_stock_launch_context(p_user_id uuid,p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;p erp_catalog.product;v_price numeric;v_cost numeric;v_on date;v_movement uuid;v_source text;v_avg numeric;v_type text;f record;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into p from erp_catalog.product where record_id=p_product_id;
 if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 s:=erp_stock.settings_dto();v_type:=s->>'price_type';
 if v_type='ultima_compra' then
  select x.unit_price,x.unit_cost,x.occurred_on,x.movement_id,x.source into v_price,v_cost,v_on,v_movement,v_source from erp_stock.last_purchase(p_product_id,(s->>'consider_balances')::boolean)x;
 end if;
 select c.average_cost into v_avg from erp_stock.average_costs(array[p_product_id])c;
 select * into f from erp_stock.default_supplier(p_product_id);
 return jsonb_build_object('scope','stock_launch_context','data_mode','erp_native','product_id',p_product_id,
  'settings',jsonb_build_object('show_unit_price',s->'show_unit_price','price_type',v_type,'consider_balances',s->'consider_balances','average_cost_base',s->'average_cost_base'),
  'last_purchase',case when v_price is not null then jsonb_build_object('unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),
   'occurred_on',v_on,'movement_id',v_movement,'source',v_source)end,
  'average_cost',erp_stock.price_text(v_avg),'sale_price',erp_stock.price_text(p.price),
  'default_supplier',case when f.supplier_id is not null then jsonb_build_object('supplier_id',f.supplier_id,'supplier_name',f.supplier_name,'code',f.code,
   'purchase_price',erp_stock.price_text(f.purchase_price),'cost_price',erp_stock.price_text(f.cost_price))end);
end$$;

-- 7. Conferência de estoque (106): a imagem do produto (primeira imagem do cadastro, 119) na coluna Imagem.
create or replace function erp_stock.count_dto(p_session uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with s as(select * from erp_stock.count_session where id=p_session),
 live as(select r.* from erp_stock.count_reading r where r.session_id=p_session and r.deleted_at is null),
 items as(select l.product_id,sum(l.quantity) counted,max(l.created_at) last_at from live l group by l.product_id),
 -- The page keeps the 1500 most recently read products (bounded response); the balanço always uses every reading.
 shown as(select * from items order by last_at desc,product_id limit 1500)
 select jsonb_build_object('session',jsonb_build_object('id',s.id,'state',s.state,'version',s.version,'warehouse_id',s.warehouse_id,
   'warehouse_name',(select name from erp_catalog.record where id=s.warehouse_id),'created_at',s.created_at,'balance_scope',s.balance_scope,'closed_at',s.closed_at),
  'total_read',(select coalesce(sum(quantity),0)from live)::numeric(38,6)::text,'readings',(select count(*)from live)::integer,'items_total',(select count(*)from items)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',i.product_id,'code',r.code,'name',r.name,'location',p.location,'unit',p.unit,
    'counted',i.counted::numeric(38,6)::text,'physical',erp_stock.count_physical(i.product_id,s.warehouse_id)::numeric(38,6)::text,
    'difference',(i.counted-erp_stock.count_physical(i.product_id,s.warehouse_id))::numeric(38,6)::text,
    'image_url',(select x.url from erp_catalog.product_image x where x.record_id=i.product_id order by x.position limit 1)) order by i.last_at desc,i.product_id)
   from shown i join erp_catalog.record r on r.id=i.product_id join erp_catalog.product p on p.record_id=i.product_id),'[]'::jsonb),
  'log',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'quantity',x.quantity::text,'product_id',x.product_id,'product_name',r.name,
    'recorded_at_local',to_char(x.created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD"T"HH24:MI:SS'),'deleted',x.deleted_at is not null) order by x.created_at desc,x.id)
   from(select * from erp_stock.count_reading where session_id=p_session order by created_at desc,id limit 200)x join erp_catalog.record r on r.id=x.product_id),'[]'::jsonb))
 from s
$$;

-- 8. Check-in (147): códigos DUN do produto (caixa e quantidade por caixa) e o código do produto no fornecedor da nota (aba Fornecedores).
create or replace function erp_stock.checkin_items(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with c as(select id from erp_stock.checkin where invoice_id=p_invoice),
 supplier as(select case when v.recipient->>'contact_id'~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then(v.recipient->>'contact_id')::uuid end id
  from erp_fiscal_invoices.invoice v where v.id=p_invoice),
 rows as(
  select i.position,i.product_id,i.description,i.supplier_code,i.gtin,i.unit,i.quantity,i.unit_price,i.received,i.issue,i.issue_quantity,i.issue_action
  from erp_stock.checkin_item i join c on c.id=i.checkin_id
  union all
  select i.position,i.product_id,coalesce(i.data->>'description',''),i.data->>'code',i.data->>'gtin',i.data->>'unit',i.quantity,i.unit_price,0,null,null,null
  from erp_fiscal_invoices.invoice_item i where i.invoice_id=p_invoice and not exists(select 1 from c))
 select coalesce(jsonb_agg(jsonb_build_object('position',r.position,'product_id',r.product_id,'product_code',p.code,'product_gtin',x.gtin,'description',r.description,
   'supplier_code',r.supplier_code,'gtin',r.gtin,'unit',r.unit,'quantity',r.quantity::numeric(24,4)::text,'unit_price',r.unit_price::numeric(24,10)::text,
   'received',r.received::numeric(24,4)::text,'issue',r.issue,'issue_quantity',r.issue_quantity::numeric(24,4)::text,'issue_action',r.issue_action,
   'state',erp_stock.checkin_item_state(r.received,r.quantity,r.issue),'requested',erp_stock.checkin_requested(p_invoice,r.product_id),
   'catalog_supplier_code',(select s.code from erp_catalog.product_supplier s,supplier f where s.record_id=r.product_id and s.supplier_id=f.id),
   'product_duns',coalesce((select jsonb_agg(jsonb_build_object('code',d.code,'quantity',d.quantity::numeric(18,6)::text) order by d.position)
    from erp_catalog.product_dun d where d.record_id=r.product_id),'[]'::jsonb)) order by r.position),'[]'::jsonb)
 from rows r left join erp_catalog.record p on p.id=r.product_id left join erp_catalog.product x on x.record_id=r.product_id
$$;
-- "Usuário responsável" do Resumo da conferência: o nome de quem iniciou e de quem finalizou (Sistema › Usuários, 117).
create or replace function erp_stock.checkin_dto(p_invoice uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 with c as(select * from erp_stock.checkin where invoice_id=p_invoice),items as(select erp_stock.checkin_items(p_invoice) j)
 select jsonb_build_object('note',erp_stock.checkin_note_dto(p_invoice),
  'checkin',(select jsonb_build_object('id',c.id,'state',c.state,'version',c.version,'invoice_version',c.invoice_version,
    'stale',c.invoice_version<>(select version from erp_fiscal_invoices.invoice where id=p_invoice),'started_at',c.started_at,'updated_at',c.updated_at,'finished_at',c.finished_at)from c),
  -- Kept outside "checkin", whose keys the published API checks exactly.
  'responsible',(select jsonb_build_object('started_by_name',(select left(p.name,120) from erp_access.profile p where p.user_id=c.started_by),
    'finished_by_name',(select left(p.name,120) from erp_access.profile p where p.user_id=c.finished_by))from c),
  'version',coalesce((select version from c),0),'items',(select j from items),
  'summary',(select jsonb_build_object('total',count(x)::integer,'complete',count(x)filter(where x->>'state'='complete')::integer,
    'issue',count(x)filter(where x->>'state'='issue' and x->>'issue'<>'refused')::integer,'refused',count(x)filter(where x->>'issue'='refused')::integer,
    'pending',count(x)filter(where x->>'state' in('pending','in_progress'))::integer)from items left join lateral jsonb_array_elements(items.j)x on true),
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'position',e.position,'description',e.description,'quantity',e.quantity::numeric(24,4)::text,
    'previous',e.previous::numeric(24,4)::text,'at',e.created_at) order by e.id)from(select * from erp_stock.checkin_event where checkin_id=(select id from c) order by id desc limit 500)e),'[]'::jsonb))
$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_warehouse_options','erp_stock_suppliers','erp_stock_dashboard_stock','erp_stock_purchase_suggestion','erp_stock_launch_context')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
