-- 146: Relatórios de suprimentos do Origin (relatorios.php?id=2&nome=Suprimentos): Controle de Estoque (Entradas e Saídas,
-- Transferência, Saldos em uma data, Maior Circulação, Sem Movimentação, Abaixo do Estoque Mínimo, Visão Financeira e
-- Movimentação de um Produto), Notas de Entrada (por Operação, Fornecedor, Produto e Evolução) e Pedidos de Compras (por fornecedor
-- ou por produto). Requer 105/112/145. Somente leitura: nenhum dado é gravado.
-- Regras comuns: datas pela data do lançamento (occurred_on) ou do documento, em America/Sao_Paulo; sem depósito filtrado valem os
-- depósitos considerados (105) e cada lançamento é somado por produto dentro do escopo, então uma transferência entre depósitos
-- considerados se anula e uma transferência para um depósito desconsiderado conta como saída. Balanço tem coluna própria.
-- Quantidades e valores em numeric exato, devolvidos como texto. Perfis: estoque lido por admin, consulta, estoque, vendas e fiscal;
-- Visão Financeira (custo médio) e Pedidos de Compras só para quem lê pedidos de compra; Notas de Entrada só para administrador e
-- fiscal, os perfis que veem as notas nativas do Brufap (112/113: a consulta não vê essa visão).
begin;

do $$begin
 if to_regprocedure('erp_stock.average_costs(uuid[])')is null then raise exception 'stock_reports_146_requires_145' using errcode='55000';end if;
 if to_regclass('erp_fiscal_invoices.invoice')is null then raise exception 'stock_reports_146_requires_112' using errcode='55000';end if;
end$$;

create function erp_stock.report_period(p_from date,p_to date)returns void language plpgsql immutable set search_path=pg_catalog as $$begin
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_to-p_from>3660 then
  raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
end$$;
create function erp_stock.report_page(p_offset integer,p_limit integer)returns void language plpgsql immutable set search_path=pg_catalog as $$begin
 if p_offset is null or p_offset not between 0 and 100000 or p_limit is null or p_limit not between 1 and 500 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
end$$;
create function erp_stock.report_warehouse(p_warehouse uuid)returns void language plpgsql stable set search_path=pg_catalog as $$begin
 if p_warehouse is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse)then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
end$$;
-- Net quantity of each lançamento (movement) per product inside the scope: the filtered warehouse, or the considered warehouses.
create function erp_stock.report_lines(p_warehouse uuid,p_from date,p_to date,p_product uuid default null)
returns table(movement_id uuid,product_id uuid,occurred_on date,quantity numeric,balance boolean)
language sql stable set search_path=pg_catalog as $$
 select e.movement_id,e.product_id,m.occurred_on,sum(e.quantity),exists(select 1 from erp_stock.balance_count c where c.movement_id=e.movement_id)
 from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id
 where(p_warehouse is null and not erp_stock.ignored_warehouse(e.warehouse_id) or e.warehouse_id=p_warehouse)
  and(p_from is null or m.occurred_on>=p_from)and(p_to is null or m.occurred_on<=p_to)and(p_product is null or e.product_id=p_product)
 group by e.movement_id,e.product_id,m.occurred_on having sum(e.quantity)<>0
$$;
create function erp_stock.report_product(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('product_id',r.id,'code',r.code,'name',r.name,'unit',p.unit)from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_id
$$;
create function erp_stock.report_balance(p_product uuid,p_warehouse uuid)returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(b.quantity),0)from erp_stock.balance b where b.product_id=p_product and(b.warehouse_id=p_warehouse or(p_warehouse is null and not erp_stock.ignored_warehouse(b.warehouse_id)))
$$;

-- Entradas e Saídas de Estoque: por produto, no período.
create function public.erp_stock_report_movements(p_user_id uuid,p_date_from date,p_date_to date,p_warehouse_id uuid default null,p_product_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_date_from,p_date_to);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 if p_product_id is not null and not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 with lines as materialized(select * from erp_stock.report_lines(p_warehouse_id,p_date_from,p_date_to,p_product_id)),
  rows as materialized(select l.product_id,r.code,r.name,p.unit,coalesce(sum(l.quantity)filter(where not l.balance and l.quantity>0),0) entries,
    coalesce(sum(-l.quantity)filter(where not l.balance and l.quantity<0),0) exits,coalesce(sum(l.quantity)filter(where l.balance),0) balances,count(*) launches
   from lines l join erp_catalog.record r on r.id=l.product_id join erp_catalog.product p on p.record_id=l.product_id group by l.product_id,r.code,r.name,p.unit),
  page as materialized(select * from rows order by erp_catalog.fold(name),product_id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_movements','data_mode','erp_native','filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'warehouse_id',p_warehouse_id,'product_id',p_product_id),
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'entries',entries::numeric(38,6)::text,'exits',exits::numeric(38,6)::text,
    'balances',balances::numeric(38,6)::text,'net',(entries-exits+balances)::numeric(38,6)::text,'launches',launches::integer) order by erp_catalog.fold(name),product_id)from page),'[]'::jsonb),
  'totals',(select jsonb_build_object('entries',coalesce(sum(entries),0)::numeric(38,6)::text,'exits',coalesce(sum(exits),0)::numeric(38,6)::text,'balances',coalesce(sum(balances),0)::numeric(38,6)::text,
    'net',coalesce(sum(entries-exits+balances),0)::numeric(38,6)::text)from rows)) into v;
 return v;
end$$;

-- Transferência de Estoque: cada transferência do período (as duas linhas do 009), com a observação e o estorno.
create function public.erp_stock_report_transfers(p_user_id uuid,p_date_from date,p_date_to date,p_warehouse_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_date_from,p_date_to);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 with rows as materialized(select m.id,m.occurred_on,m.created_at,o.product_id,-o.quantity quantity,o.warehouse_id source_id,i.warehouse_id destination_id,
    coalesce((select d.note from erp_stock.movement_detail d where d.movement_id=m.id and d.product_id=o.product_id order by d.revision desc limit 1),m.reason) note,
    exists(select 1 from erp_stock.movement x where x.reverses_id=m.id) reversed
   from erp_stock.movement m join erp_stock.entry o on o.movement_id=m.id and o.quantity<0 join erp_stock.entry i on i.movement_id=m.id and i.quantity>0 and i.product_id=o.product_id
   where m.kind='transfer' and m.occurred_on between p_date_from and p_date_to and(p_warehouse_id is null or p_warehouse_id in(o.warehouse_id,i.warehouse_id))),
  page as materialized(select * from rows order by occurred_on desc,created_at desc,id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_transfers','data_mode','erp_native','filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'warehouse_id',p_warehouse_id),
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(erp_stock.report_product(p.product_id)||jsonb_build_object('movement_id',p.id,'occurred_on',p.occurred_on,'quantity',p.quantity::numeric(38,6)::text,
    'source_id',p.source_id,'source_name',(select name from erp_catalog.record where id=p.source_id),'destination_id',p.destination_id,'destination_name',(select name from erp_catalog.record where id=p.destination_id),
    'note',p.note,'reversed',p.reversed) order by p.occurred_on desc,p.created_at desc,p.id)from page p),'[]'::jsonb)) into v;
 return v;
end$$;

-- Saldos em Estoque em uma data: soma do razão até a data (inclusive), pela data dos lançamentos.
create function public.erp_stock_report_balances_at(p_user_id uuid,p_date date,p_warehouse_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_date,p_date);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 with rows as materialized(select l.product_id,r.code,r.name,p.unit,sum(l.quantity) quantity from erp_stock.report_lines(p_warehouse_id,null,p_date) l
   join erp_catalog.record r on r.id=l.product_id join erp_catalog.product p on p.record_id=l.product_id group by l.product_id,r.code,r.name,p.unit having sum(l.quantity)<>0),
  page as materialized(select * from rows order by erp_catalog.fold(name),product_id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_balances_at','data_mode','erp_native','filters',jsonb_build_object('date',p_date,'warehouse_id',p_warehouse_id),
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'quantity',quantity::numeric(38,6)::text) order by erp_catalog.fold(name),product_id)from page),'[]'::jsonb),
  'totals',jsonb_build_object('quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text)) into v;
 return v;
end$$;

-- Produtos com Maior Circulação: os mais movimentados do período (entradas + saídas, sem balanços).
create function public.erp_stock_report_top(p_user_id uuid,p_date_from date,p_date_to date,p_warehouse_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_date_from,p_date_to);perform erp_stock.report_page(0,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 with lines as materialized(select * from erp_stock.report_lines(p_warehouse_id,p_date_from,p_date_to) where not balance),
  rows as materialized(select l.product_id,coalesce(sum(l.quantity)filter(where l.quantity>0),0) entries,coalesce(sum(-l.quantity)filter(where l.quantity<0),0) exits,sum(abs(l.quantity)) moved,count(*) launches
   from lines l group by l.product_id),
  page as materialized(select r.*,c.name from rows r join erp_catalog.record c on c.id=r.product_id order by r.moved desc,erp_catalog.fold(c.name),r.product_id limit p_limit)
 select jsonb_build_object('scope','stock_report_top','data_mode','erp_native','filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'warehouse_id',p_warehouse_id),
  'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(erp_stock.report_product(p.product_id)||jsonb_build_object('entries',p.entries::numeric(38,6)::text,'exits',p.exits::numeric(38,6)::text,'moved',p.moved::numeric(38,6)::text,
    'launches',p.launches::integer) order by p.moved desc,erp_catalog.fold(p.name),p.product_id)from page p),'[]'::jsonb)) into v;
 return v;
end$$;

-- Produtos sem Movimentação: produtos com saldo no escopo sem nenhum lançamento desde a data (ou nunca movimentados no escopo).
create function public.erp_stock_report_idle(p_user_id uuid,p_since date,p_warehouse_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_since,p_since);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 with stock as materialized(select b.product_id,sum(b.quantity) quantity from erp_stock.balance b where b.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id))
   group by b.product_id having sum(b.quantity)<>0),
  last as materialized(select l.product_id,max(l.occurred_on) last_movement from erp_stock.report_lines(p_warehouse_id,null,null) l where l.product_id in(select product_id from stock) group by l.product_id),
  rows as materialized(select s.product_id,r.code,r.name,p.unit,s.quantity,x.last_movement from stock s join erp_catalog.record r on r.id=s.product_id join erp_catalog.product p on p.record_id=s.product_id
   left join last x on x.product_id=s.product_id where p.kind='P' and(x.last_movement is null or x.last_movement<p_since)),
  page as materialized(select * from rows order by last_movement nulls first,erp_catalog.fold(name),product_id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_idle','data_mode','erp_native','filters',jsonb_build_object('since',p_since,'warehouse_id',p_warehouse_id),
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'quantity',quantity::numeric(38,6)::text,'last_movement',last_movement)
   order by last_movement nulls first,erp_catalog.fold(name),product_id)from page),'[]'::jsonb)) into v;
 return v;
end$$;

-- Produtos Abaixo do Estoque Mínimo: saldo no escopo menor que o estoque mínimo do cadastro.
create function public.erp_stock_report_below_min(p_user_id uuid,p_warehouse_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 with rows as materialized(select r.id product_id,r.code,r.name,p.unit,p.stock_min,p.stock_max,erp_stock.report_balance(r.id,p_warehouse_id) quantity
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.kind='P' and r.active and p.stock_min is not null),
  below as materialized(select * from rows where quantity<stock_min),
  page as materialized(select * from below order by erp_catalog.fold(name),product_id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_below_min','data_mode','erp_native','filters',jsonb_build_object('warehouse_id',p_warehouse_id),
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from below)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'stock_min',stock_min::numeric(38,6)::text,'stock_max',stock_max::numeric(38,6)::text,
    'quantity',quantity::numeric(38,6)::text,'missing',(stock_min-quantity)::numeric(38,6)::text) order by erp_catalog.fold(name),product_id)from page),'[]'::jsonb)) into v;
 return v;
end$$;

-- Visão Financeira do Estoque: quantidade, custo médio (145), valor de custo, preço e valor de venda e a diferença, por produto.
create function public.erp_stock_report_financial(p_user_id uuid,p_warehouse_id uuid default null,p_offset integer default 0,p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_page(p_offset,p_limit);perform erp_stock.report_warehouse(p_warehouse_id);
 if not erp_stock.cost_visible(p_user_id)then raise exception 'erp_stock_access_denied' using errcode='42501';end if;
 with stock as materialized(select b.product_id,sum(b.quantity) quantity from erp_stock.balance b where b.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id))
   group by b.product_id having sum(b.quantity)<>0),
  costs as materialized(select c.product_id,c.average_cost from erp_stock.average_costs(array(select product_id from stock))c),
  rows as materialized(select s.product_id,r.code,r.name,p.unit,s.quantity,c.average_cost,p.price,
    case when c.average_cost is not null then round(s.quantity*c.average_cost,2)end cost_value,case when p.price is not null then round(s.quantity*p.price,2)end sale_value
   from stock s join erp_catalog.record r on r.id=s.product_id join erp_catalog.product p on p.record_id=s.product_id left join costs c on c.product_id=s.product_id where p.kind='P'),
  page as materialized(select * from rows order by erp_catalog.fold(name),product_id limit p_limit offset p_offset)
 select jsonb_build_object('scope','stock_report_financial','data_mode','erp_native','filters',jsonb_build_object('warehouse_id',p_warehouse_id),'cost_basis',erp_stock.settings_dto()->'average_cost_base',
  'offset',p_offset,'limit',p_limit,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'unit',unit,'quantity',quantity::numeric(38,6)::text,'average_cost',erp_stock.price_text(average_cost),
    'cost_value',cost_value::numeric(38,2)::text,'sale_price',erp_stock.price_text(price),'sale_value',sale_value::numeric(38,2)::text,
    'margin',case when cost_value is not null and sale_value is not null then(sale_value-cost_value)::numeric(38,2)::text end) order by erp_catalog.fold(name),product_id)from page),'[]'::jsonb),
  'totals',(select jsonb_build_object('quantity',coalesce(sum(quantity),0)::numeric(38,6)::text,'cost_value',coalesce(sum(cost_value),0)::numeric(38,2)::text,'sale_value',coalesce(sum(sale_value),0)::numeric(38,2)::text,
    'margin',coalesce(sum(sale_value-cost_value)filter(where cost_value is not null and sale_value is not null),0)::numeric(38,2)::text,
    'uncosted',count(*)filter(where cost_value is null)::integer,'unpriced',count(*)filter(where sale_value is null)::integer)from rows)) into v;
 return v;
end$$;

-- Movimentação de um Produto (com gráfico): saldo antes do período, entradas, saídas e saldo ao fim de cada dia com lançamento.
create function public.erp_stock_report_product(p_user_id uuid,p_product_id uuid,p_date_from date,p_date_to date,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;v_opening numeric;begin
 perform erp_stock.require_access(p_user_id,false);perform erp_stock.report_period(p_date_from,p_date_to);perform erp_stock.report_warehouse(p_warehouse_id);
 if p_product_id is null or not exists(select 1 from erp_catalog.product where record_id=p_product_id)then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 select coalesce(sum(quantity),0) into v_opening from erp_stock.report_lines(p_warehouse_id,null,p_date_from-1,p_product_id);
 with lines as materialized(select * from erp_stock.report_lines(p_warehouse_id,p_date_from,p_date_to,p_product_id)),
  days as materialized(select occurred_on on_day,coalesce(sum(quantity)filter(where quantity>0),0) entries,coalesce(sum(-quantity)filter(where quantity<0),0) exits,sum(quantity) net from lines group by occurred_on),
  running as materialized(select on_day,entries,exits,v_opening+sum(net)over(order by on_day) balance from days)
 select jsonb_build_object('scope','stock_report_product','data_mode','erp_native','product',erp_stock.report_product(p_product_id),
  'filters',jsonb_build_object('product_id',p_product_id,'date_from',p_date_from,'date_to',p_date_to,'warehouse_id',p_warehouse_id),
  'opening',v_opening::numeric(38,6)::text,
  'days',coalesce((select jsonb_agg(jsonb_build_object('date',on_day,'entries',entries::numeric(38,6)::text,'exits',exits::numeric(38,6)::text,'balance',balance::numeric(38,6)::text) order by on_day)from running),'[]'::jsonb),
  'closing',(v_opening+(select coalesce(sum(net),0)from days))::numeric(38,6)::text,
  'totals',(select jsonb_build_object('entries',coalesce(sum(entries),0)::numeric(38,6)::text,'exits',coalesce(sum(exits),0)::numeric(38,6)::text)from days)) into v;
 return v;
end$$;

-- Relatório de Pedidos de Compras agrupado por fornecedor ou por produto (data do pedido e situações escolhidas).
create function public.erp_stock_report_purchase_orders(p_user_id uuid,p_date_from date,p_date_to date,p_statuses jsonb,p_group text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;statuses text[];begin
 if not coalesce(erp_documents.allowed((select role from erp_access.membership where user_id=p_user_id and active),'purchase_orders',false),false)then
  raise exception 'erp_stock_access_denied' using errcode='42501';end if;
 perform erp_stock.report_period(p_date_from,p_date_to);
 statuses:=erp_stock.dashboard_statuses(p_statuses,array['open','in_progress','partially_fulfilled','fulfilled','cancelled'],5);
 if statuses is null or p_group is null or p_group not in('supplier','product')then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with docs as materialized(select d.id,d.contact_id,d.contact_snapshot->>'name' contact_name,d.total from erp_documents.document d
   where d.kind='purchase_orders' and d.status=any(statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_date_from and p_date_to),
  items as materialized(select i.document_id,i.product_id,coalesce(r.name,nullif(btrim(i.data->>'description'),''),'Item sem descrição') name,r.code,i.quantity,i.total from erp_documents.item i join docs on docs.id=i.document_id
   left join erp_catalog.record r on r.id=i.product_id),
  quantities as materialized(select document_id,sum(quantity) quantity from items group by document_id),
  -- One row per key: a supplier renamed between orders keeps one row (its current name), the documents keep their snapshots.
  rows as materialized(
   select x.key,coalesce((select r.name from erp_catalog.record r where r.id=min(x.contact_id::text)::uuid),min(x.label)) label,null::text code,count(*) orders,coalesce(sum(x.quantity),0) quantity,sum(x.total) value
   from(select coalesce(d.contact_id::text,'sem-fornecedor') key,d.contact_id,coalesce(d.contact_name,'Sem fornecedor') label,q.quantity,d.total
    from docs d left join quantities q on q.document_id=d.id where p_group='supplier')x group by x.key
   union all
   select x.key,min(x.name),min(x.code),count(distinct x.document_id),sum(x.quantity),sum(x.total)
   from(select coalesce(i.product_id::text,'item:'||i.name) key,i.name,i.code,i.document_id,i.quantity,i.total from items i where p_group='product')x group by x.key)
 select jsonb_build_object('scope','stock_report_purchase_orders','data_mode','erp_native','filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'statuses',to_jsonb(statuses),'group',p_group),
  'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('key',key,'label',label,'code',code,'orders',orders::integer,'quantity',quantity::numeric(38,6)::text,'value',value::numeric(38,2)::text)
   order by value desc,erp_catalog.fold(label),key)from(select * from rows order by value desc,erp_catalog.fold(label),key limit 2000)r),'[]'::jsonb),
  'totals',jsonb_build_object('orders',(select count(*)from docs)::integer,'quantity',(select coalesce(sum(quantity),0)from items)::numeric(38,6)::text,'value',(select coalesce(sum(total),0)from docs)::numeric(38,2)::text)) into v;
 return v;
end$$;

-- Relatórios de Notas de Entrada (112): por Operação, por Fornecedor, por Produto e Evolução (mês a mês), pela data de emissão.
-- Notas excluídas, canceladas e denegadas ficam de fora.
create function public.erp_stock_report_entry_notes(p_user_id uuid,p_date_from date,p_date_to date,p_group text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;v_role text;begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if v_role is null or v_role not in('admin','fiscal')then raise exception 'erp_stock_access_denied' using errcode='42501';end if;
 perform erp_stock.report_period(p_date_from,p_date_to);
 if p_group is null or p_group not in('nature','supplier','product','month')then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with notes as materialized(select n.id,n.nature_description,n.recipient->>'name' supplier,n.recipient->>'document' document,n.issue_date,(n.totals->>'total')::numeric total
   from erp_fiscal_invoices.invoice n where n.direction='0' and n.deleted_at is null and n.status not in(3,10) and n.issue_date between p_date_from and p_date_to),
  rows as materialized(
   select nature_description key,nature_description label,null::text code,count(*) notes,null::numeric quantity,sum(total) value from notes where p_group='nature' group by nature_description
   union all
   -- One row per CNPJ/CPF (the name of each note is a snapshot) and one per product (each note has its own description).
   select x.key,coalesce(min(x.supplier),'Sem fornecedor'),min(x.document),count(*),null,sum(x.total)
   from(select coalesce(document,'nome:'||supplier,'sem-fornecedor') key,supplier,document,total from notes where p_group='supplier')x group by x.key
   union all
   select x.key,min(x.label),min(x.code),count(distinct x.invoice_id),sum(x.quantity),sum(x.total)
   from(select coalesce(i.product_id::text,'item:'||coalesce(i.data->>'description','')) key,coalesce(r.name,nullif(btrim(i.data->>'description'),''),'Item sem descrição') label,r.code,i.invoice_id,i.quantity,i.total
    from erp_fiscal_invoices.invoice_item i join notes n on n.id=i.invoice_id left join erp_catalog.record r on r.id=i.product_id where p_group='product')x group by x.key
   union all
   select to_char(issue_date,'YYYY-MM'),to_char(issue_date,'MM/YYYY'),null,count(*),null,sum(total) from notes where p_group='month' group by to_char(issue_date,'YYYY-MM'),to_char(issue_date,'MM/YYYY'))
 select jsonb_build_object('scope','stock_report_entry_notes','data_mode','erp_native','filters',jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'group',p_group),
  'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('key',key,'label',label,'code',code,'notes',notes::integer,'quantity',quantity::numeric(38,4)::text,'value',value::numeric(38,2)::text)
   order by case when p_group='month' then key end,value desc,erp_catalog.fold(label),key)from(select * from rows order by case when p_group='month' then key end,value desc,erp_catalog.fold(label),key limit 2000)r),'[]'::jsonb),
  'totals',jsonb_build_object('notes',(select count(*)from notes)::integer,'value',(select coalesce(sum(total),0)from notes)::numeric(38,2)::text)) into v;
 return v;
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_report_movements','erp_stock_report_transfers','erp_stock_report_balances_at','erp_stock_report_top','erp_stock_report_idle','erp_stock_report_below_min',
 'erp_stock_report_financial','erp_stock_report_product','erp_stock_report_purchase_orders','erp_stock_report_entry_notes')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
