-- 145: Preferências > Suprimentos > Estoque aplicadas ao estoque do Brufap (Origin preferencias.php#suprimento/suprimento-estoque).
-- Requer 105/107 (estoque no padrão do Origin) e 115 (erp_preferences.get). Somente leitura sobre o razão: nenhum movimento,
-- saldo, preço, custo ou reserva existente é gravado ou reescrito aqui.
-- - Preço sugerido do lançamento manual e da transferência: "Preço da última compra" (entradas manuais, recebimentos e lançamentos
--   de pedidos de compra e, com "Considerar balanços para o Preço da última compra", os balanços). As opções do fornecedor padrão
--   dependem dos fornecedores do produto, que o cadastro do Brufap ainda não tem: com elas, nenhum preço é sugerido.
-- - Custo médio por produto (todos os depósitos), calculado sobre o razão na ordem de registro com a base escolhida em "Fazer o
--   cálculo do custo médio com base no preço de compra ou no custo de lançamento". Cada entrada com preço (Entrada, recebimento de
--   compra, acréscimo de Balanço) refaz a média ponderada pelo saldo; saídas, transferências e estornos não mudam a média; entrada
--   sem preço entra pelo custo médio vigente; com saldo zero ou negativo a média recomeça. Arredondamento: 10 casas por entrada.
--   Ele dá o "Valor de Custo do Estoque" do totalizador e a coluna Custo dos dashboards.
-- - Reserva de estoque pelas situações de venda: com a opção ligada, pedidos de venda nas situações marcadas, sem estoque lançado e
--   sem reserva explícita (070), contam como reservados no depósito do pedido (ou no depósito padrão) quando "Reserva de estoque por
--   depósito" está ligada, ou para todos os depósitos considerados quando desligada. Essa reserva é informativa (saldo atual
--   disponível, "Visualizar vendas" e Sugestão de Compras com Reserva = Sim): ela não bloqueia lançamentos e não muda a política
--   "Permitir estoque negativo" (100) nem a proteção das reservas explícitas (070), que continuam valendo como antes.
-- - "Considerar estorno para o cálculo do saldo atual se houver balanço após o lançamento original" desligada: o estorno manual
--   (Estornar lançamento do extrato) de um lançamento com Balanço registrado depois dele no mesmo depósito fica no histórico e o
--   saldo atual não muda. O razão continua imutável: junto do estorno são gravados ajustes de compensação no mesmo comando
--   (antes do estorno quando ele baixa o saldo, depois quando ele aumenta), com a mesma política de estoque negativo e reservas.
--   Estornos feitos pelo documento (pedido, OS, recebimento de compra) seguem as regras do documento e não usam esta opção.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('erp_preferences.get(text,uuid)')is null then raise exception 'stock_preferences_145_requires_115' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_stock_balances(uuid,uuid,uuid)','ee5aa1144339b498fe1e19f179e27687a70e9a07b182a7f7f1391379ce17bc24'),
  ('public.erp_stock_totals(uuid,uuid)','6d844026d0678403aa17ce316f680267c449efe03cebdf1533a514f678356a07'),
  ('public.erp_stock_product_reservations(uuid,uuid,uuid)','69bae83ed56fa6fa465a21229352aa7fa0eef27ad3c9810947048365575ca1d2'),
  ('public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer)','69b1abe800acbb12a1467f4bab5c283eb9fa7c6d96074250609c29589b46f3e5'),
  ('public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text)','62e83c89e46b6a120ae9479bcd47ba62707d843d11cf41e350550d4d1274b0cf'),
  ('public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)','9caf60426574a74ce44465d6ce4626cb71618ed582599d96b06ca8495dd576d4'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_preferences_145_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Company settings of the page (115). The catalog default applies until an administrator saves the page.
-- Origin options mapped to Brufap sales order situations; "Venda Agenciada" and "Checkout parcial" do not exist in Brufap.
create function erp_stock.reserve_statuses()returns text[] language sql stable set search_path=pg_catalog as $$
 select case when coalesce(erp_preferences.get('estoque.reserva_por_situacao')='true'::jsonb,false) then coalesce(array(
   select m.status from jsonb_array_elements_text(case when jsonb_typeof(erp_preferences.get('estoque.reserva_situacoes'))='array' then erp_preferences.get('estoque.reserva_situacoes') else '[]'::jsonb end)x
   join(values('em_digitacao','draft',1),('em_aberto','open',2),('verificado','verified',3),('em_andamento','in_progress',4),('atendido','fulfilled',5),('cancelado','cancelled',6))m(option,status,ord)on m.option=x
   order by m.ord),'{}'::text[])else '{}'::text[] end
$$;
create function erp_stock.settings_dto()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object(
  'show_unit_price',coalesce(erp_preferences.get('estoque.exibir_preco_unitario')='true'::jsonb,false),
  'price_type',case when erp_preferences.get('estoque.tipo_preco_entrada')#>>'{}' in('ultima_compra','compra_fornecedor','custo_fornecedor')then erp_preferences.get('estoque.tipo_preco_entrada')#>>'{}' else 'ultima_compra' end,
  'consider_balances',coalesce(erp_preferences.get('estoque.considerar_balancos')='true'::jsonb,false),
  'average_cost_base',case when erp_preferences.get('estoque.custo_medio_base')#>>'{}'='custo_lancamento' then 'custo_lancamento' else 'preco_compra' end,
  'reserve_by_situation',coalesce(erp_preferences.get('estoque.reserva_por_situacao')='true'::jsonb,false),
  'reserve_statuses',to_jsonb(erp_stock.reserve_statuses()),
  'reserve_by_warehouse',coalesce(erp_preferences.get('estoque.reserva_por_deposito')<>'false'::jsonb,true))
$$;

-- Custo médio and last purchase prices are purchase data: only readers of purchase orders (008) see them, as in the extrato (105).
create function erp_stock.cost_visible(p_actor uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_documents.allowed((select role from erp_access.membership where user_id=p_actor and active),'purchase_orders',false),false)
$$;

-- 2. Custo médio of each product over the whole ledger (null products = every product with entries). Exact numeric; the average is
-- rounded to 10 decimals at each costed entry, so a read always reproduces the same value from the same ledger and revisions.
-- The price of a lançamento is its latest revision (105) or, without one, the unambiguous item price of its purchase document
-- (018 posting or 090 receipt); Custo Lançamento falls back to the price when the lançamento has no cost. Prices are resolved in
-- one set-based pass and only the running average is computed row by row.
create function erp_stock.average_costs(p_products uuid[] default null)returns table(product_id uuid,average_cost numeric)
language plpgsql stable set search_path=pg_catalog as $$
declare r record;v_product uuid;v_qty numeric;v_avg numeric;v_base text;begin
 v_base:=erp_stock.settings_dto()->>'average_cost_base';
 for r in
  with scoped as materialized(select e.product_id p,e.quantity q,m.kind,m.id movement,m.created_at,e.ordinal from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id
    where p_products is null or e.product_id=any(p_products)),
   -- Only an increase of a receipt or of an adjustment (Balanço) brings a purchase price; transfers and reversals never do.
   costed as materialized(select distinct movement,p from scoped where q>0 and kind in('receipt','adjustment')),
   detail as materialized(select distinct on(x.movement_id,x.product_id) x.movement_id,x.product_id,x.unit_price,x.unit_cost from erp_stock.movement_detail x
    join costed c on c.movement=x.movement_id and c.p=x.product_id order by x.movement_id,x.product_id,x.revision desc),
   linked as materialized(select c.movement,c.p,coalesce((select dp.document_id from erp_stock.document_posting dp where dp.movement_id=c.movement limit 1),
     (select rr.document_id from erp_purchase_receipts.receipt rr where rr.movement_id=c.movement)) document_id
    from costed c where not exists(select 1 from detail d where d.movement_id=c.movement and d.product_id=c.p)),
   docprice as materialized(select l.movement,l.p,case when count(distinct i.unit_price)=1 then min(i.unit_price)end price
    from linked l join erp_documents.item i on i.document_id=l.document_id and i.product_id=l.p group by l.movement,l.p)
  select s.p,s.q,s.kind,case when not(s.q>0 and s.kind in('receipt','adjustment'))then null when d.movement_id is not null then
    case when v_base='custo_lancamento' then coalesce(d.unit_cost,d.unit_price)else d.unit_price end else dp.price end cost
  from scoped s left join detail d on d.movement_id=s.movement and d.product_id=s.p left join docprice dp on dp.movement=s.movement and dp.p=s.p
  order by s.p,s.created_at,s.movement,s.ordinal loop
  if v_product is distinct from r.p then
   if v_product is not null then product_id:=v_product;average_cost:=v_avg;return next;end if;
   v_product:=r.p;v_qty:=0;v_avg:=null;
  end if;
  if r.cost is not null then
   if v_avg is null or v_qty<=0 then v_avg:=r.cost;else v_avg:=round((v_qty*v_avg+r.q*r.cost)/(v_qty+r.q),10);end if;
  end if;
  v_qty:=v_qty+r.q;
 end loop;
 if v_product is not null then product_id:=v_product;average_cost:=v_avg;return next;end if;
end$$;
-- "Preço da última compra": newest entry with a price among manual Entradas, purchase order receipts/lançamentos and, when the
-- company considers them, Balanços. Reversed lançamentos and transfers are not purchases.
create function erp_stock.last_purchase(p_product uuid,p_balances boolean)returns table(unit_price numeric,unit_cost numeric,occurred_on date,movement_id uuid,source text)
language sql stable set search_path=pg_catalog as $$
 select x.price,x.cost,x.occurred_on,x.id,case when x.balance then 'balance' when erp_stock.ledger_origin(x.id)->>'type'='purchases' then 'purchase_order' else 'manual' end
 from(select m.id,m.occurred_on,m.created_at,c.movement_id is not null balance,
   case when d.movement_id is not null then d.unit_price else erp_stock.ledger_document_price(m.id,e.product_id)end price,d.unit_cost cost
  from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id
  left join lateral(select x.movement_id,x.unit_price,x.unit_cost from erp_stock.movement_detail x where x.movement_id=m.id and x.product_id=e.product_id order by x.revision desc limit 1)d on true
  left join erp_stock.balance_count c on c.movement_id=m.id
  where e.product_id=p_product and not exists(select 1 from erp_stock.movement r where r.reverses_id=m.id)
   and((m.kind='receipt' and e.quantity>0)or(p_balances and c.movement_id is not null)))x
 where x.price is not null order by x.occurred_on desc,x.created_at desc,x.id desc limit 1
$$;

-- 3. Reserva de estoque pelas situações de venda. warehouse_id is null when the reservation is not per warehouse (or the order
-- has no warehouse and there is no depósito padrão): it then counts for all considered warehouses.
create function erp_stock.situation_reservations(p_product uuid default null)
returns table(document_id uuid,document_number bigint,status text,contact_name text,product_id uuid,warehouse_id uuid,quantity numeric,unit text)
language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.reserve_statuses() statuses,(erp_stock.settings_dto()->>'reserve_by_warehouse')::boolean by_warehouse,
   (select d.warehouse_id from erp_stock.warehouse_default d where d.singleton) standard)
 select d.id,d.number,d.status,d.contact_snapshot->>'name',i.product_id,case when s.by_warehouse then coalesce(d.warehouse_id,s.standard)end,sum(i.quantity),p.unit
 from s cross join erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
 where cardinality(s.statuses)>0 and d.kind='sales_orders' and d.status=any(s.statuses) and(p_product is null or i.product_id=p_product)
  and p.kind='P' and p.unit is not null and i.data->>'unit' is not distinct from p.unit
  and not exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active')
  and not exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active')
 group by d.id,d.number,d.status,d.contact_snapshot,i.product_id,p.unit,s.by_warehouse,s.standard,d.warehouse_id
$$;

-- 4. Saldos do produto (105) com a reserva por situação no depósito e a parte sem depósito (reserva global).
create or replace function public.erp_stock_balances(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;s jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or not exists(select 1 from erp_catalog.product where record_id=p_product_id) then
    raise exception 'erp_stock_product_not_found' using errcode='P0002'; end if;
  s:=erp_stock.settings_dto();
  with situation as materialized(select x.warehouse_id,x.quantity from erp_stock.situation_reservations(p_product_id)x)
  select jsonb_build_object('product_id',p_product_id,'items',coalesce(jsonb_agg(jsonb_build_object(
    'warehouse_id',w.record_id,'warehouse_name',r.name,'warehouse_active',r.active,'quantity',coalesce(b.quantity,0)::numeric(18,6)::text,
    'version',coalesce(b.version,0),'unit',p.unit,'warehouse_default',coalesce(d.warehouse_id=w.record_id,false),
    'warehouse_ignored',erp_stock.ignored_warehouse(w.record_id),
    'reserved_quantity',(erp_stock.reserved_quantity(p_product_id,w.record_id)+coalesce((select sum(x.quantity)from situation x where x.warehouse_id=w.record_id),0))::numeric(18,6)::text,
    'situation_reserved_quantity',coalesce((select sum(x.quantity)from situation x where x.warehouse_id=w.record_id),0)::numeric(18,6)::text) order by w.record_id),'[]'::jsonb),
   'reservation',jsonb_build_object('by_situation',s->'reserve_by_situation','by_warehouse',s->'reserve_by_warehouse','statuses',s->'reserve_statuses',
    'unassigned_quantity',(select coalesce(sum(x.quantity),0)from situation x where x.warehouse_id is null)::numeric(18,6)::text),
   'data_mode','erp_native') into v_result
  from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id
  join erp_catalog.product p on p.record_id=p_product_id
  cross join erp_stock.warehouse_default d
  left join erp_stock.balance b on b.product_id=p_product_id and b.warehouse_id=w.record_id
  where p_warehouse_id is null or w.record_id=p_warehouse_id;
  return v_result;
end $$;

-- 5. "Visualizar vendas": reservas explícitas (070) e pedidos reservados pela situação (source='situation', sem reserva própria).
create or replace function public.erp_stock_product_reservations(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 with rows as materialized(
   select r.id,'reservation'::text source,d.id document_id,d.number,d.status,d.contact_snapshot->>'name' contact_name,i.warehouse_id,i.quantity,i.unit,r.created_at
   from erp_stock.reservation r join erp_stock.reservation_item i on i.reservation_id=r.id join erp_documents.document d on d.id=r.document_id
   where r.state='active' and i.product_id=p_product_id and(p_warehouse_id is null or i.warehouse_id=p_warehouse_id)
   union all
   select null,'situation',x.document_id,x.document_number,x.status,x.contact_name,x.warehouse_id,x.quantity,x.unit,null
   from erp_stock.situation_reservations(p_product_id)x where p_warehouse_id is null or x.warehouse_id=p_warehouse_id or x.warehouse_id is null),
  page as materialized(select * from rows order by number desc,source,id limit 100)
 select jsonb_build_object('product_id',p_product_id,'warehouse_id',p_warehouse_id,
  'items',coalesce((select jsonb_agg(jsonb_build_object('reservation_id',id,'source',source,'document_id',document_id,'document_number',number::text,'status',status,
    'contact_name',contact_name,'warehouse_id',warehouse_id,'warehouse_ignored',case when warehouse_id is not null then erp_stock.ignored_warehouse(warehouse_id) else false end,
    'quantity',quantity::numeric(18,6)::text,'unit',unit,'reserved_at',created_at) order by number desc,source,id)from page),'[]'::jsonb),
  'total',(select count(*)from rows)::integer,'quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,
  'reservation',(select jsonb_build_object('by_situation',s->'reserve_by_situation','by_warehouse',s->'reserve_by_warehouse','statuses',s->'reserve_statuses')from(select erp_stock.settings_dto() s)x),
  'scope','stock_product_reservations','data_mode','erp_native') into v_result;
 return v_result;
end$$;

-- 6. Totalizador sem produto (105) com o Valor de Custo do Estoque: quantidade × custo médio, sem os depósitos desconsiderados
-- quando nenhum depósito é filtrado. Produtos com saldo e sem custo médio ficam de fora e são contados. O custo médio vem dos
-- preços de compra: como no extrato (105), só quem lê pedidos de compra (008) o vê; para os demais ele é null.
create or replace function public.erp_stock_totals(p_user_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;v_cost boolean;begin
 perform erp_stock.require_access(p_user_id,false);
 v_cost:=erp_stock.cost_visible(p_user_id);
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then
  raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 with scoped as materialized(select b.product_id,b.quantity,p.price from erp_stock.balance b join erp_catalog.product p on p.record_id=b.product_id
   where b.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id))),
  costs as materialized(select c.product_id,c.average_cost from erp_stock.average_costs(array(select distinct product_id from scoped))c where v_cost)
 select jsonb_build_object('warehouse_id',p_warehouse_id,'quantity',(select coalesce(sum(quantity),0)from scoped)::numeric(38,6)::text,
  'sale_value',(select coalesce(round(sum(quantity*price),2),0)from scoped where price is not null)::numeric(38,2)::text,
  'unpriced_products',(select count(distinct product_id)from scoped where price is null and quantity<>0)::integer,
  'cost_visible',v_cost,
  'cost_value',case when v_cost then(select coalesce(round(sum(s.quantity*c.average_cost),2),0)from scoped s join costs c on c.product_id=s.product_id where c.average_cost is not null)::numeric(38,2)::text end,
  'uncosted_products',case when v_cost then(select count(distinct s.product_id)from scoped s left join costs c on c.product_id=s.product_id where c.average_cost is null and s.quantity<>0)::integer end,
  'cost_basis',erp_stock.settings_dto()->'average_cost_base',
  'ignored_warehouses',(select count(*)from erp_stock.warehouse_setting where ignore_balance)::integer,
  -- Selector of the extrato for every stock reader: names were already visible in the 009 balances.
  'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'active',r.active,'is_default',coalesce(d.warehouse_id=r.id,false),
    'ignore_balance',erp_stock.ignored_warehouse(r.id))order by erp_catalog.fold(r.name),r.id),'[]'::jsonb)
   from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id cross join erp_stock.warehouse_default d),
  'scope','stock_totals','data_mode','erp_native') into v_result;
 return v_result;
end$$;

-- 7. Lançamento manual e transferência: preferências da página e o preço sugerido. Só quem lança estoque consulta (admin e
-- estoque, que também leem pedidos de compra, de onde vem parte dos preços).
create function public.erp_stock_launch_context(p_user_id uuid,p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;p erp_catalog.product;v_price numeric;v_cost numeric;v_on date;v_movement uuid;v_source text;v_avg numeric;v_type text;begin
 perform erp_stock.require_access(p_user_id,true);
 if p_product_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into p from erp_catalog.product where record_id=p_product_id;
 if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 s:=erp_stock.settings_dto();v_type:=s->>'price_type';
 if v_type='ultima_compra' then
  select x.unit_price,x.unit_cost,x.occurred_on,x.movement_id,x.source into v_price,v_cost,v_on,v_movement,v_source from erp_stock.last_purchase(p_product_id,(s->>'consider_balances')::boolean)x;
 end if;
 select c.average_cost into v_avg from erp_stock.average_costs(array[p_product_id])c;
 return jsonb_build_object('scope','stock_launch_context','data_mode','erp_native','product_id',p_product_id,
  'settings',jsonb_build_object('show_unit_price',s->'show_unit_price','price_type',v_type,'consider_balances',s->'consider_balances','average_cost_base',s->'average_cost_base'),
  'last_purchase',case when v_price is not null then jsonb_build_object('unit_price',erp_stock.price_text(v_price),'unit_cost',erp_stock.price_text(v_cost),
   'occurred_on',v_on,'movement_id',v_movement,'source',v_source)end,
  'average_cost',erp_stock.price_text(v_avg),'sale_price',erp_stock.price_text(p.price));
end$$;

-- 8. Estoque de Produtos (107) com a coluna Custo (quantidade × custo médio) na tabela, no total e por depósito; null para quem
-- não lê pedidos de compra.
create or replace function public.erp_stock_dashboard_stock(p_user_id uuid,p_query text default null,p_search_by text default 'description',p_warehouse_id uuid default null,
  p_brand text default null,p_page integer default 1,p_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;q text;v_cost boolean;begin
 perform erp_stock.require_access(p_user_id,false);
 v_cost:=erp_stock.cost_visible(p_user_id);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100 or p_search_by is null or p_search_by not in('code','description','gtin')
  or length(p_query)>120 or p_query~'[[:cntrl:]]' or length(p_brand)>100 or p_brand~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 q:=nullif(erp_catalog.fold(btrim(p_query)),'');
 with products as materialized(select r.id,r.name,r.code,p.price,p.gtin from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where p.kind='P'
    and(q is null or case p_search_by when 'code' then strpos(erp_catalog.fold(coalesce(r.code,'')),q)>0 when 'gtin' then strpos(coalesce(p.gtin,''),btrim(p_query))>0 or strpos(coalesce(p.gtin_tax,''),btrim(p_query))>0 else strpos(erp_catalog.fold(r.name),q)>0 end)
    and(nullif(btrim(p_brand),'')is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold(btrim(p_brand)))>0)),
  scoped as materialized(select b.product_id,b.warehouse_id,b.quantity,erp_stock.ignored_warehouse(b.warehouse_id) ignored from erp_stock.balance b join products p on p.id=b.product_id
   where p_warehouse_id is null or b.warehouse_id=p_warehouse_id),
  costs as materialized(select c.product_id,c.average_cost from erp_stock.average_costs(array(select distinct product_id from scoped))c where v_cost),
  stock as materialized(select s.product_id,sum(s.quantity) filter(where p_warehouse_id is not null or not s.ignored) quantity from scoped s group by s.product_id),
  rows as materialized(select p.id,p.name,p.code,p.price,coalesce(s.quantity,0) quantity,c.average_cost from products p join stock s on s.product_id=p.id left join costs c on c.product_id=p.id),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size),
  by_warehouse as materialized(select s.warehouse_id,bool_or(s.ignored) ignored,sum(s.quantity) quantity,sum(s.quantity*p.price) filter(where p.price is not null) value,
    sum(s.quantity*c.average_cost) filter(where c.average_cost is not null) cost
   from scoped s join products p on p.id=s.product_id left join costs c on c.product_id=s.product_id group by s.warehouse_id)
 select jsonb_build_object('scope','stock_dashboard_stock','data_mode','erp_native','page',p_page,'size',p_size,'total',(select count(*)from rows)::integer,
  'filters',jsonb_build_object('query',p_query,'search_by',p_search_by,'warehouse_id',p_warehouse_id,'brand',p_brand),
  'cost_basis',erp_stock.settings_dto()->'average_cost_base','cost_visible',v_cost,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',id,'code',code,'name',name,'quantity',quantity::numeric(38,6)::text,
    'value',case when price is null then null else round(quantity*price,2)::numeric(38,2)::text end,
    'average_cost',erp_stock.price_text(average_cost),'cost',case when average_cost is null then null else round(quantity*average_cost,2)::numeric(38,2)::text end) order by erp_catalog.fold(name),id)from page),'[]'::jsonb),
  'totals',jsonb_build_object('quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,'value',(select coalesce(round(sum(quantity*price),2),0)from rows where price is not null)::numeric(38,2)::text,
   'unpriced',(select count(*)from rows where price is null)::integer,
   'cost',case when v_cost then(select coalesce(round(sum(quantity*average_cost),2),0)from rows where average_cost is not null)::numeric(38,2)::text end,
   'uncosted',case when v_cost then(select count(*)from rows where average_cost is null)::integer end),
  'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouse_id',w.warehouse_id,'name',r.name,'ignored',w.ignored,'quantity',w.quantity::numeric(38,6)::text,
    'value',coalesce(round(w.value,2),0)::numeric(38,2)::text,'cost',case when v_cost then coalesce(round(w.cost,2),0)::numeric(38,2)::text end) order by erp_catalog.fold(r.name),w.warehouse_id)
   from by_warehouse w join erp_catalog.record r on r.id=w.warehouse_id),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 9. Sugestão de Compras (107): com Reserva = Sim, o reservado inclui a reserva pelas situações de venda (no depósito filtrado, nos
-- depósitos considerados sem filtro, e sempre a reserva sem depósito). O resto da fórmula e das regras é o da 107.
create or replace function public.erp_stock_purchase_suggestion(p_user_id uuid,p_date_from date,p_date_to date,p_coverage integer,p_warehouse_id uuid default null,
  p_reserve boolean default false,p_purchase_statuses jsonb default null,p_sales_statuses jsonb default null,p_brand text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_days integer;v_result jsonb;purchase text[];sales text[];begin
 perform erp_stock.require_access(p_user_id,false);
 if not erp_documents.allowed((select role from erp_access.membership where user_id=p_user_id and active),'purchase_orders',false)then
  raise exception 'erp_stock_access_denied' using errcode='42501';end if;
 purchase:=erp_stock.dashboard_statuses(p_purchase_statuses,array['open','in_progress','partially_fulfilled','fulfilled','cancelled'],5);
 sales:=erp_stock.dashboard_statuses(p_sales_statuses,array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled'],7);
 if p_date_from is null or p_date_to is null or not isfinite(p_date_from) or not isfinite(p_date_to) or p_date_from>p_date_to or p_date_from<date '1900-01-01' or p_date_to>date '2100-12-31'
  or p_date_to-p_date_from>3660 or p_coverage is null or p_coverage not between 1 and 3650 or p_reserve is null or purchase is null or sales is null
  or length(p_brand)>100 or p_brand~'[[:cntrl:]]' then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 v_days:=p_date_to-p_date_from+1;
 with sold as materialized(select i.product_id,sum(i.quantity) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   join erp_catalog.product p on p.record_id=i.product_id
   where d.kind='sales_orders' and d.status=any(sales) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to
    and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and p.kind='P'
    and(nullif(btrim(p_brand),'')is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold(btrim(p_brand)))>0)
   group by i.product_id),
  ordered as materialized(select i.product_id,sum(greatest(i.quantity-erp_purchase_receipts.received(d.id,i.id),0)) quantity from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status=any(purchase) and(p_warehouse_id is null or d.warehouse_id=p_warehouse_id) and i.product_id in(select product_id from sold)
    and not exists(select 1 from erp_stock.document_posting dp where dp.document_id=d.id and dp.state='active')
   group by i.product_id),
  last_purchase as materialized(select distinct on(i.product_id) i.product_id,i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
   where d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id in(select product_id from sold) order by i.product_id,d.body->>'date' desc nulls last,d.created_at desc,i.position),
  situation as materialized(select x.product_id,x.warehouse_id,x.quantity from erp_stock.situation_reservations()x where p_reserve and x.product_id in(select product_id from sold)),
  rows as materialized(select s.product_id,r.code,r.name,s.quantity sold,erp_stock.count_physical(s.product_id,p_warehouse_id) stock,
    case when p_reserve then(select coalesce(sum(i.quantity),0)from erp_stock.reservation_item i join erp_stock.reservation x on x.id=i.reservation_id
     where x.state='active' and i.product_id=s.product_id and(i.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(i.warehouse_id))))
     +(select coalesce(sum(x.quantity),0)from situation x where x.product_id=s.product_id
      and(x.warehouse_id is null or x.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(x.warehouse_id))))else 0 end reserved,
    coalesce(o.quantity,0) ordered,lp.unit_price
   from sold s join erp_catalog.record r on r.id=s.product_id left join ordered o on o.product_id=s.product_id left join last_purchase lp on lp.product_id=s.product_id),
  computed as materialized(select *,greatest(div(sold*p_coverage-(stock-reserved+ordered)*v_days,v_days),0) suggestion from rows)
 select jsonb_build_object('scope','stock_purchase_suggestion','data_mode','erp_native','days',v_days,
  'filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'coverage',p_coverage,'warehouse_id',p_warehouse_id,'reserve',p_reserve,
   'purchase_statuses',to_jsonb(purchase),'sales_statuses',to_jsonb(sales),'brand',p_brand),
  'total',(select count(*)from computed)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'sold',sold::numeric(38,6)::text,'stock',stock::numeric(38,6)::text,
    'reserved',reserved::numeric(38,6)::text,'ordered',ordered::numeric(38,6)::text,'suggestion',suggestion::numeric(38,0)::text,
    'unit_price',erp_stock.price_text(unit_price),'value',case when unit_price is null then null else round(suggestion*unit_price,2)::numeric(38,2)::text end)
   order by suggestion desc,erp_catalog.fold(name),product_id)from(select * from computed order by suggestion desc,erp_catalog.fold(name),product_id limit 2000)c),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- 10. Estornar lançamento (009/018/090) com a opção "Considerar estorno ... se houver balanço após o lançamento original".
-- Ligada (padrão): exatamente o comportamento anterior. Desligada: cada posição do lançamento com um Balanço registrado depois dele
-- recebe um ajuste de compensação, de modo que o saldo atual fica como estava; os ajustes têm comandos derivados do comando do
-- estorno e a repetição do comando devolve os mesmos movimentos. As versões esperadas do pedido continuam valendo (CAS).
create function erp_stock.derived_command(p_command uuid,p_part text)returns uuid language sql immutable set search_path=pg_catalog as $$
 select(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
 from(select md5('stock-reverse-balance-145:'||p_part||':'||p_command::text)h)x
$$;
create or replace function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_count integer;v_pre uuid;v_after uuid;v_absorbed jsonb;v_before_items jsonb;v_after_items jsonb;v_result jsonb;v_reason text:='Estorno anterior ao balanço: saldo atual mantido';begin
 perform erp_stock.require_access(p_user_id,true);
 perform pg_advisory_xact_lock(174852909,0);
 if exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_movement_id)or exists(select 1 from erp_purchase_receipts.reversal where movement_id=p_movement_id)then raise exception 'purchase_receipt_reverse_via_receipt'using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_document' using errcode='40001';end if;
 if p_versions is null or jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_versions) j where jsonb_typeof(j)<>'object' or exists(select 1 from jsonb_object_keys(j) k where k not in('product_id','warehouse_id','expected_version'))) then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 select count(*) into v_count from erp_stock.entry where movement_id=p_movement_id;
 if v_count=0 then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,'quantity',(-e.quantity)::text,'expected_version',v->'expected_version') order by e.ordinal) into v_items
 from erp_stock.entry e join jsonb_array_elements(p_versions) v on v->>'product_id'=e.product_id::text and v->>'warehouse_id'=e.warehouse_id::text where e.movement_id=p_movement_id;
 if jsonb_array_length(p_versions)<>v_count or coalesce(jsonb_array_length(v_items),0)<>v_count then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 v_pre:=erp_stock.derived_command(p_command_id,'before');v_after:=erp_stock.derived_command(p_command_id,'after');
 -- A repeated command returns what the first execution recorded (the stored reversal and its compensations, if any). The
 -- positions compensated before the reversal were posted one version later, exactly as in the first execution.
 if exists(select 1 from erp_stock.command where id=p_command_id) then
  select jsonb_agg(case when exists(select 1 from erp_stock.command c,jsonb_array_elements(c.result#>'{movement,items}') b where c.id=v_pre
    and b->>'product_id'=i->>'product_id' and b->>'warehouse_id'=i->>'warehouse_id') then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end)
   into v_items from jsonb_array_elements(v_items) i;
 end if;
 if exists(select 1 from erp_stock.command where id=p_command_id)
  or coalesce(erp_preferences.get('estoque.estorno_balanco')<>'false'::jsonb,true)
  or exists(select 1 from erp_stock.movement where id=p_movement_id and kind='reversal') then
  v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
  return v_result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_after)));
 end if;
 -- Positions of the original lançamento with a Balanço registered after it (same product and warehouse).
 select coalesce(jsonb_agg(i),'[]'::jsonb) into v_absorbed from jsonb_array_elements(v_items) i
 where exists(select 1 from erp_stock.balance_count c join erp_stock.movement b on b.id=c.movement_id join erp_stock.movement o on o.id=p_movement_id
  where c.product_id=(i->>'product_id')::uuid and c.warehouse_id=(i->>'warehouse_id')::uuid and b.created_at>o.created_at);
 if jsonb_array_length(v_absorbed)=0 then
  v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
  return v_result||jsonb_build_object('balance_adjustments','[]'::jsonb);
 end if;
 -- A reversal that lowers a position is compensated before it (never below the balance), one that raises it after it.
 select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity',ltrim(i->>'quantity','-'),'expected_version',i->'expected_version'))
  into v_before_items from jsonb_array_elements(v_absorbed) i where i->>'quantity' like '-%';
 select jsonb_agg(case when exists(select 1 from jsonb_array_elements(coalesce(v_before_items,'[]'::jsonb)) b where b->'product_id'=i->'product_id' and b->'warehouse_id'=i->'warehouse_id')
   then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end) into v_items from jsonb_array_elements(v_items) i;
 select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity','-'||(i->>'quantity'),'expected_version',to_jsonb((i->>'expected_version')::bigint+1)))
  into v_after_items from jsonb_array_elements(v_absorbed) i where i->>'quantity' not like '-%';
 if v_before_items is not null then perform erp_stock.post(p_user_id,v_pre,'adjustment',p_occurred_on,v_reason,null,v_before_items);end if;
 v_result:=erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
 if v_after_items is not null then perform erp_stock.post(p_user_id,v_after,'adjustment',p_occurred_on,v_reason,null,v_after_items);end if;
 return v_result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_after)));
end $$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_balances','erp_stock_product_reservations','erp_stock_totals','erp_stock_launch_context','erp_stock_dashboard_stock','erp_stock_purchase_suggestion','erp_stock_reverse')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
