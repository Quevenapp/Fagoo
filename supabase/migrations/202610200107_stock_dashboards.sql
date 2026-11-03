-- 107: Dashboards de produtos do Origin (Meu Negócio > Produtos): Estoque de Produtos, Sugestão de Compras e Sem Movimentação.
-- Requer 105/106. Somente leitura sobre o razão, os documentos nativos e as reservas, mais a preferência de cada usuário
-- (situações dos pedidos de compra e "Situações de venda consideradas"), alterada por comando auditado.
-- Na convivência com o Origin, vendas e compras são as registradas no Brufap; o histórico do Origin não entra nos cálculos.
-- Não há preço de custo no cadastro do produto: Custo fica fora; Valor usa o preço de venda; o Valor Estimado da sugestão usa
-- o preço da última compra registrada no Brufap.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','5ec96c372cfec08f8031bee4c9a7c88ccb2cd97ded8dabb05845a9acf07f97d3'),
  ('erp_home.shortcut_catalog()','ca7f1f992024949351fc87207f38a2ecec20d4687581be0e31125bb095edd622'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_dashboards_107_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

create table erp_stock.dashboard_command(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create table erp_stock.dashboard_preference(
 actor uuid primary key references auth.users(id),
 purchase_statuses text[] not null check(cardinality(purchase_statuses) between 1 and 5 and purchase_statuses<@array['open','in_progress','partially_fulfilled','fulfilled','cancelled']),
 sales_statuses text[] not null check(cardinality(sales_statuses) between 1 and 7 and sales_statuses<@array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled']),
 version integer not null check(version between 1 and 2147483647),updated_at timestamptz not null,
 command_id uuid not null unique references erp_stock.dashboard_command(id)
);
create trigger immutable_stock_dashboard_command before update or delete on erp_stock.dashboard_command for each row execute function erp_stock.immutable_ledger();
create function erp_stock.guard_dashboard_preference()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.actor<>old.actor or new.version<>old.version+1 or new.command_id=old.command_id))
  or not exists(select 1 from erp_stock.dashboard_command c where c.id=new.command_id and c.actor=new.actor)then
  raise exception 'erp_stock_dashboard_preference_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_dashboard_preference before insert or update or delete on erp_stock.dashboard_preference for each row execute function erp_stock.guard_dashboard_preference();
do $$declare t text;begin foreach t in array array['dashboard_command','dashboard_preference']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
$$;

-- A JSON array of distinct allowed situations (1..max), as text[]; null when anything else.
create function erp_stock.dashboard_statuses(p_value jsonb,p_allowed text[],p_max integer)returns text[] language plpgsql immutable set search_path=pg_catalog as $$
declare v text[];begin
 if p_value is null or jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value) not between 1 and p_max
  or exists(select 1 from jsonb_array_elements(p_value)x where jsonb_typeof(x)<>'string')then return null;end if;
 v:=array(select x from jsonb_array_elements_text(p_value)x);
 if not(v<@p_allowed) or(select count(distinct x)from unnest(v)x)<>cardinality(v)then return null;end if;
 return array(select x from unnest(v)x order by x);
end$$;
-- Defaults: open purchase orders; every sale that is not a draft nor cancelled.
create function erp_stock.dashboard_preference_dto(p_actor uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce((select jsonb_build_object('purchase_statuses',to_jsonb(purchase_statuses),'sales_statuses',to_jsonb(sales_statuses),'version',version,'updated_at',updated_at)
  from erp_stock.dashboard_preference where actor=p_actor),
  jsonb_build_object('purchase_statuses',to_jsonb(array['open','in_progress','partially_fulfilled']),'sales_statuses',to_jsonb(array['open','verified','in_progress','partially_fulfilled','fulfilled']),'version',0,'updated_at',null))
$$;
create function public.erp_stock_dashboard_preference_get(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_stock.require_access(p_user_id,false);
 return jsonb_build_object('scope','stock_dashboard_preference','preference',erp_stock.dashboard_preference_dto(p_user_id),'data_mode','erp_native');
end$$;
create function public.erp_stock_dashboard_preference_set(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_purchase_statuses jsonb,p_sales_statuses jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.dashboard_command;p erp_stock.dashboard_preference;purchase text[];sales text[];result jsonb;at timestamptz;begin
 perform erp_stock.require_access(p_user_id,false);
 purchase:=erp_stock.dashboard_statuses(p_purchase_statuses,array['open','in_progress','partially_fulfilled','fulfilled','cancelled'],5);
 sales:=erp_stock.dashboard_statuses(p_sales_statuses,array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled'],7);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or purchase is null or sales is null then
  raise exception 'erp_stock_dashboard_preference_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-dashboard-preference-107','actor',p_user_id,'expected_version',p_expected_version,'purchase',to_jsonb(purchase),'sales',to_jsonb(sales))::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.require_access(p_user_id,false);
 select * into c from erp_stock.dashboard_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_stock_dashboard_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('preference',erp_stock.dashboard_preference_dto(p_user_id),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_dashboard_command_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852921,hashtext(p_user_id::text));
 select * into p from erp_stock.dashboard_preference where actor=p_user_id;
 if coalesce(p.version,0)<>p_expected_version then raise exception 'erp_stock_dashboard_version_conflict' using errcode='40001';end if;
 at:=clock_timestamp();
 result:=jsonb_build_object('scope','stock_dashboard_preference','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'from_version',p_expected_version,'to_version',p_expected_version+1,'saved_at',at));
 insert into erp_stock.dashboard_command(id,actor,request_hash,result)values(p_command_id,p_user_id,h,result);
 if p.actor is null then insert into erp_stock.dashboard_preference(actor,purchase_statuses,sales_statuses,version,updated_at,command_id)values(p_user_id,purchase,sales,1,at,p_command_id);
 else update erp_stock.dashboard_preference set purchase_statuses=purchase,sales_statuses=sales,version=version+1,updated_at=at,command_id=p_command_id where actor=p_user_id;end if;
 return result||jsonb_build_object('preference',erp_stock.dashboard_preference_dto(p_user_id),'replayed',false);
end$$;

-- Estoque de Produtos: "Pesquisar por" Código, Descrição ou GTIN, Depósito e Marca; Tabela de Estoques e Estoque por Depósito.
-- Sem depósito filtrado, a soma usa só os depósitos considerados (105). Valor = quantidade × preço de venda.
create function public.erp_stock_dashboard_stock(p_user_id uuid,p_query text default null,p_search_by text default 'description',p_warehouse_id uuid default null,
  p_brand text default null,p_page integer default 1,p_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;q text;begin
 perform erp_stock.require_access(p_user_id,false);
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
  stock as materialized(select s.product_id,sum(s.quantity) filter(where p_warehouse_id is not null or not s.ignored) quantity from scoped s group by s.product_id),
  rows as materialized(select p.id,p.name,p.code,p.price,coalesce(s.quantity,0) quantity from products p join stock s on s.product_id=p.id),
  page as materialized(select * from rows order by erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size),
  by_warehouse as materialized(select s.warehouse_id,bool_or(s.ignored) ignored,sum(s.quantity) quantity,sum(s.quantity*p.price) filter(where p.price is not null) value
   from scoped s join products p on p.id=s.product_id group by s.warehouse_id)
 select jsonb_build_object('scope','stock_dashboard_stock','data_mode','erp_native','page',p_page,'size',p_size,'total',(select count(*)from rows)::integer,
  'filters',jsonb_build_object('query',p_query,'search_by',p_search_by,'warehouse_id',p_warehouse_id,'brand',p_brand),
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',id,'code',code,'name',name,'quantity',quantity::numeric(38,6)::text,
    'value',case when price is null then null else round(quantity*price,2)::numeric(38,2)::text end) order by erp_catalog.fold(name),id)from page),'[]'::jsonb),
  'totals',jsonb_build_object('quantity',(select coalesce(sum(quantity),0)from rows)::numeric(38,6)::text,'value',(select coalesce(round(sum(quantity*price),2),0)from rows where price is not null)::numeric(38,2)::text,
   'unpriced',(select count(*)from rows where price is null)::integer),
  'warehouses',coalesce((select jsonb_agg(jsonb_build_object('warehouse_id',w.warehouse_id,'name',r.name,'ignored',w.ignored,'quantity',w.quantity::numeric(38,6)::text,
    'value',coalesce(round(w.value,2),0)::numeric(38,2)::text) order by erp_catalog.fold(r.name),w.warehouse_id)from by_warehouse w join erp_catalog.record r on r.id=w.warehouse_id),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- Sem Movimentação: produtos com estoque cuja última venda nativa (pedido de venda ou OS lançados e não estornados) é
-- anterior à data, ou que nunca venderam ("Sem Venda").
create function public.erp_stock_dashboard_idle(p_user_id uuid,p_since date,p_page integer default 1,p_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_since is null or not isfinite(p_since) or p_since not between date '1900-01-01' and date '2100-12-31' or p_page is null or p_page not between 1 and 100000
  or p_size is null or p_size not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with stock as materialized(select b.product_id,sum(b.quantity) quantity from erp_stock.balance b where not erp_stock.ignored_warehouse(b.warehouse_id) group by b.product_id having sum(b.quantity)>0),
  sales as materialized(select e.product_id,max(m.occurred_on) last_sale from erp_stock.document_posting dp join erp_documents.document d on d.id=dp.document_id
    join erp_stock.movement m on m.id=dp.movement_id join erp_stock.entry e on e.movement_id=m.id
   where dp.state='active' and d.kind in('sales_orders','service_orders') group by e.product_id),
  rows as materialized(select r.id,r.code,r.name,s.quantity,x.last_sale from stock s join erp_catalog.record r on r.id=s.product_id join erp_catalog.product p on p.record_id=s.product_id
   left join sales x on x.product_id=s.product_id where p.kind='P' and(x.last_sale is null or x.last_sale<p_since)),
  page as materialized(select * from rows order by last_sale nulls first,erp_catalog.fold(name),id limit p_size offset(p_page-1)*p_size)
 select jsonb_build_object('scope','stock_dashboard_idle','data_mode','erp_native','since',p_since,'page',p_page,'size',p_size,'total',(select count(*)from rows)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',id,'code',code,'name',name,'quantity',quantity::numeric(38,6)::text,'last_sale',last_sale)
   order by last_sale nulls first,erp_catalog.fold(name),id)from page),'[]'::jsonb)) into v_result;
 return v_result;
end$$;

-- Sugestão de Compras (fórmula inferida do Origin): arredondar para baixo(vendidas × cobertura ÷ dias − Estoque Atual − em
-- pedidos de compra), mínimo 0, em numeric exato (div trunca o quociente). Com Reserva = Sim, o Estoque Atual é o saldo menos o
-- reservado (o reservado já tem destino, então a sugestão aumenta). Dias do período inclusivos. Vendidas: itens de produto dos
-- pedidos de venda nas situações consideradas, pela data do pedido. Em pedidos: o que falta receber (090) dos pedidos de compra
-- nas situações escolhidas; um pedido lançado inteiro no estoque (018) não tem saldo a receber. Sem depósito filtrado, saldo e
-- reservas são os dos depósitos considerados (105). Pedido de Compra e Valor Estimado são dados de compra: só quem lê pedidos de
-- compra (008) consulta a sugestão.
create function public.erp_stock_purchase_suggestion(p_user_id uuid,p_date_from date,p_date_to date,p_coverage integer,p_warehouse_id uuid default null,
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
  rows as materialized(select s.product_id,r.code,r.name,s.quantity sold,erp_stock.count_physical(s.product_id,p_warehouse_id) stock,
    case when p_reserve then(select coalesce(sum(i.quantity),0)from erp_stock.reservation_item i join erp_stock.reservation x on x.id=i.reservation_id
     where x.state='active' and i.product_id=s.product_id and(i.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(i.warehouse_id))))else 0 end reserved,
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

-- Atalhos favoritos (097) espelham o menu real: Dashboard produtos, Sugestão de Compras e Conferência de estoque entram na
-- ordem do menu (apps/erp/src/lib/origin-menu.ts e workers/erp-api/src/home.mjs). Favoritos salvos guardam o caminho, não a ordem.
create or replace function erp_home.shortcut_catalog() returns table(ordinal integer,path text,roles text[],resource text)
language sql immutable set search_path=pg_catalog as $$
 values
  (1,'/painel-produtos-empresa',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (2,'/cadastros-reais?cadastro=products',null::text[],'products'),
  (3,'/cadastros-reais?cadastro=contacts',null::text[],'contacts'),
  (4,'/financeiro-empresa?area=accounts',array['admin','consulta','financeiro'],null::text),
  (5,'/financeiro-empresa?area=categories',array['admin','consulta','financeiro'],null),
  (6,'/documentos-empresa?tipo=sales_orders',array['admin','consulta','financeiro','vendas','estoque','fiscal'],null),
  (7,'/historico-fiscal?modelo=55',array['admin','consulta','fiscal'],null),
  (8,'/historico-fiscal?modelo=65',array['admin','consulta','fiscal'],null),
  (9,'/documentos-empresa?tipo=sales_proposals',array['admin','consulta','financeiro','vendas'],null),
  (10,'/documentos-empresa?tipo=service_orders',array['admin','consulta','financeiro','vendas'],null),
  (11,'/documentos-empresa?tipo=purchase_orders',array['admin','consulta','financeiro','estoque','fiscal'],null),
  (12,'/notas-recebidas',array['admin','fiscal','consulta'],null),
  (13,'/cadastros-reais?cadastro=contacts&contato=fornecedor',null::text[],'contacts'),
  (14,'/painel-produtos-empresa?painel=sugestao',array['admin','consulta','estoque','fiscal'],null),
  (15,'/estoque-empresa',array['admin','consulta','vendas','estoque','fiscal'],null),
  (16,'/conferencia-estoque-empresa',array['admin','estoque'],null),
  (17,'/cadastros-reais?cadastro=warehouses',array['admin','consulta','estoque'],null),
  (18,'/financeiro-empresa?area=payable',array['admin','consulta','financeiro'],null),
  (19,'/financeiro-empresa?area=receivable',array['admin','consulta','financeiro'],null),
  (20,'/cobranca-operacional',array['admin','consulta','financeiro'],null),
  (21,'/relatorio-vencimentos',array['admin','consulta','financeiro'],null)
$$;
revoke all on function erp_home.shortcut_catalog() from public,anon,authenticated,service_role;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_dashboard_preference_get','erp_stock_dashboard_preference_set','erp_stock_dashboard_stock','erp_stock_dashboard_idle','erp_stock_purchase_suggestion')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
