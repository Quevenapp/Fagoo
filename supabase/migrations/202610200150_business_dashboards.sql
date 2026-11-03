-- 150: Meu Negócio no padrão do Origin (dashboard.meu.negocio.php): Mensal, Diário, Pedidos de Venda, Vendas por Vendedor,
-- Venda Canal (24 meses), Previsão de Estoque, Margem por Pedido, Novos x Recorrentes, Atividade da Carteira, Curva ABC e
-- Metas, mais a preferência "Configurações Meu negócio" (situações consideradas como Pedido Finalizado).
-- Somente leitura sobre os pedidos de venda nativos (erp_documents), o cadastro e o estoque; só as metas são gravadas, por
-- comando idempotente com CAS e auditoria. Na convivência com o Origin, os números são os dos pedidos registrados no Brufap.
-- Regras de leitura (iguais às dos módulos): quem lê pedidos de venda lê os dashboards; custo e margem só para quem lê
-- pedidos de compra (o preço de custo é o preço da última compra registrada no Brufap, como na Sugestão de Compras da 107);
-- estoque só para quem lê o estoque (009). Impostos e taxas de venda não existem por pedido no Brufap e vêm nulos.
-- Datas: data do pedido (calendário de São Paulo). Valores em numeric, devolvidos como texto.
begin;

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.page(id,category,ordinal,scope,read_roles)values
 ('meu-negocio','meu-negocio',17,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]);
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('negocio.situacoes_finalizado','meu-negocio','situacoes',1,'multi','["open","fulfilled","cancelled","in_progress","draft","verified","partially_fulfilled"]'::jsonb,'["fulfilled","in_progress","verified"]'::jsonb,null,null,null,null,7,null);
-- END GENERATED DEFINITIONS

do $$begin
 if exists(select 1 from erp_preferences.definition d where d.page_id='meu-negocio' and not erp_preferences.value_valid(d,d.default_value)) then
  raise exception 'erp_preferences_default_invalid'; end if;
end$$;

-- Access: an active member whose role reads sales orders (008). Cost needs purchase orders; stock needs the stock (009).
create function erp_home.biz_role(p_user uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v text;
begin
 select role into v from erp_access.membership where user_id=p_user and active;
 if p_user is null or v is null or not erp_documents.allowed(v,'sales_orders',false) then
  raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 return v;
end $$;
create function erp_home.biz_cost_visible(p_role text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select erp_documents.allowed(p_role,'purchase_orders',false)
$$;
create function erp_home.biz_stock_visible(p_role text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_role in('admin','consulta','estoque','vendas','fiscal'),false)
$$;
create function erp_home.biz_status_order() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled']
$$;
-- Distinct statuses, returned in the canonical order above.
create function erp_home.biz_statuses(p_statuses text[]) returns text[] language plpgsql immutable set search_path=pg_catalog as $$
declare v text[];
begin
 if p_statuses is null or cardinality(p_statuses) not between 1 and 7 or array_position(p_statuses,null) is not null
  or(select count(distinct s) from unnest(p_statuses) s)<>cardinality(p_statuses) or not p_statuses<@erp_home.biz_status_order() then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 select array_agg(s order by o) into v from unnest(erp_home.biz_status_order()) with ordinality x(s,o) where s=any(p_statuses);
 return v;
end $$;
-- Requests carry the statuses as a JSON array of strings.
create function erp_home.biz_statuses_json(p jsonb) returns text[] language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or jsonb_typeof(p)<>'array' or exists(select 1 from jsonb_array_elements(p) x where jsonb_typeof(x)<>'string') then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_statuses(array(select jsonb_array_elements_text(p)));
end $$;
-- "Configurações Meu negócio": the statuses considered a finished order (preference of migration 150). The page lets the
-- administrador unmark every situação; with none marked the default of the definition applies (Em andamento, Atendido e
-- Verificado), so Venda Canal, Previsão de Estoque, Atividade da Carteira and Metas always run with at least one situação.
create function erp_home.biz_finished() returns text[] language sql stable set search_path=pg_catalog as $$
 select erp_home.biz_statuses(array(select jsonb_array_elements_text(case when jsonb_array_length(x.v)>0 then x.v else d.default_value end)))
 from erp_preferences.definition d cross join lateral(select coalesce(erp_preferences.get(d.key),d.default_value) v) x where d.key='negocio.situacoes_finalizado'
$$;
create function erp_home.biz_period(p_from date,p_to date,p_max integer default 732) returns void language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from>p_to or p_to-p_from>=p_max
  or p_from<date '2000-01-01' or p_to>date '2100-12-31' then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
end $$;
create function erp_home.biz_text(p_text text,p_max integer) returns text language sql immutable set search_path=pg_catalog as $$
 select nullif(btrim(left(btrim(regexp_replace(coalesce(p_text,''),'[[:cntrl:]]',' ','g')),p_max)),'')
$$;
-- Origin "Loja": the store of an order imported with a Origin store reference; every other order is "Pedido Manual".
create function erp_home.biz_channel(p_body jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce(erp_home.biz_text(p_body#>>'{commercial,store_reference,label}',80),
  case when p_body#>>'{commercial,store_reference,source_id}' is not null then 'Loja '||left(p_body#>>'{commercial,store_reference,source_id}',40) end,'Pedido Manual')
$$;
create function erp_home.biz_seller(p_body jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce(erp_home.biz_text(p_body#>>'{commercial,seller_reference,label}',80),
  case when p_body#>>'{commercial,seller_reference,source_id}' is not null then 'Vendedor '||left(p_body#>>'{commercial,seller_reference,source_id}',40) end)
$$;
create function erp_home.biz_freight(p_body jsonb) returns numeric language sql immutable set search_path=pg_catalog as $$
 select case when p_body->>'freight'~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$' then(p_body->>'freight')::numeric else 0 end
$$;
create function erp_home.biz_state(p_body jsonb,p_contact jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select case when s~'^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO|EX)$' then s end
 from(select upper(btrim(coalesce(nullif(p_body#>>'{delivery_address,state}',''),p_contact->>'state',''))) s) x
$$;

-- Sales orders of the period (order date) in the chosen statuses.
create function erp_home.biz_orders(p_from date,p_to date,p_statuses text[])
returns table(id uuid,number bigint,day date,status text,contact_id uuid,contact_name text,channel text,seller text,state text,total numeric,freight numeric,units numeric,warehouse_id uuid)
language sql stable set search_path=pg_catalog as $$
 select d.id,d.number,(d.body->>'date')::date,d.status,d.contact_id,coalesce(erp_home.biz_text(d.contact_snapshot->>'name',200),'Contato sem nome'),
  erp_home.biz_channel(d.body),erp_home.biz_seller(d.body),erp_home.biz_state(d.body,d.contact_snapshot),d.total,erp_home.biz_freight(d.body),
  coalesce((select sum(i.quantity) from erp_documents.item i where i.document_id=d.id),0),d.warehouse_id
 from erp_documents.document d
 where d.kind='sales_orders' and d.status=any(p_statuses) and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date between p_from and p_to
$$;
-- Preço de custo: unit price of the latest purchase order (not cancelled) of the product, as the 107 suggestion uses.
create function erp_home.biz_unit_cost(p_product uuid) returns numeric language sql stable set search_path=pg_catalog as $$
 select i.unit_price from erp_documents.document d join erp_documents.item i on i.document_id=d.id
 where d.kind='purchase_orders' and d.status<>'cancelled' and i.product_id=p_product
 order by d.body->>'date' desc nulls last,d.created_at desc,i.position limit 1
$$;
-- Order lines; a line without product keeps its description and has no cost.
create function erp_home.biz_lines(p_from date,p_to date,p_statuses text[])
returns table(document_id uuid,day date,contact_id uuid,channel text,seller text,product_key text,product_id uuid,code text,name text,brand text,quantity numeric,total numeric,unit_cost numeric)
language sql stable set search_path=pg_catalog as $$
 select o.id,o.day,o.contact_id,o.channel,o.seller,coalesce(i.product_id::text,'d:'||lower(coalesce(erp_home.biz_text(i.data->>'description',200),''))),i.product_id,
  coalesce(erp_home.biz_text(r.code,60),erp_home.biz_text(i.product_snapshot->>'code',60)),
  coalesce(erp_home.biz_text(i.data->>'description',200),erp_home.biz_text(r.name,200),'Item sem descrição'),erp_home.biz_text(p.brand,100),
  i.quantity,i.total,case when i.product_id is null then null else erp_home.biz_unit_cost(i.product_id) end
 from erp_home.biz_orders(p_from,p_to,p_statuses) o join erp_documents.item i on i.document_id=o.id
 left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
$$;
create function erp_home.money(p numeric) returns text language sql immutable set search_path=pg_catalog as $$ select round(coalesce(p,0),2)::numeric(38,2)::text $$;
create function erp_home.qty(p numeric) returns text language sql immutable set search_path=pg_catalog as $$ select round(coalesce(p,0),6)::numeric(38,6)::text $$;
create function erp_home.pct(p_part numeric,p_whole numeric) returns text language sql immutable set search_path=pg_catalog as $$
 select case when coalesce(p_whole,0)=0 then null else round(p_part*100/p_whole,2)::numeric(38,2)::text end
$$;
create function erp_home.ratio(p_part numeric,p_whole numeric) returns text language sql immutable set search_path=pg_catalog as $$
 select case when coalesce(p_whole,0)=0 then '0.00' else round(p_part/p_whole,2)::numeric(38,2)::text end
$$;
-- The longest prefix of a list (already in its order) whose JSON text fits in p_budget bytes. The long tables (products,
-- orders and customers, with names and e-mails of up to 200 and 254 characters) use it, so a dashboard answer always stays
-- inside the 256 KiB bound of the Preferências and Sistema routes; the screen says when it shows only the first rows.
create function erp_home.biz_fit(p jsonb,p_budget integer) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(x.v order by x.n),'[]'::jsonb)
 from(select e.v,e.n,sum(octet_length(e.v::text)+2) over(order by e.n) acc from jsonb_array_elements(coalesce(p,'[]'::jsonb)) with ordinality e(v,n)) x where x.acc<=p_budget
$$;
-- KPIs of one period: Valor Total, Quantidade de Pedidos, Produtos Vendidos and Ticket Médio.
create function erp_home.biz_kpis(p_from date,p_to date,p_statuses text[]) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('total',erp_home.money(sum(total)),'orders',count(*)::integer,'units',erp_home.qty(sum(units)),'ticket',erp_home.ratio(sum(total),count(*)))
 from erp_home.biz_orders(p_from,p_to,p_statuses)
$$;
create function erp_home.biz_status_rows(p_from date,p_to date,p_statuses text[]) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('status',s,'orders',coalesce(x.orders,0),'total',erp_home.money(x.total)) order by o),'[]'::jsonb)
 from unnest(p_statuses) with ordinality u(s,o)
 left join(select status,count(*)::integer orders,sum(total) total from erp_home.biz_orders(p_from,p_to,p_statuses) group by status) x on x.status=u.s
$$;
-- FATURAMENTO SEM FRETE, PREÇO DE CUSTO, MARGEM BRUTA, IMPOSTOS, TAXA VENDA e LUCRO. Without purchase access the cost and the
-- margin are null; lines without a known cost are counted, never priced at zero.
create function erp_home.biz_indicators(p_from date,p_to date,p_statuses text[],p_cost boolean) returns jsonb language sql stable set search_path=pg_catalog as $$
 with o as(select coalesce(sum(total-freight),0) revenue from erp_home.biz_orders(p_from,p_to,p_statuses)),
  l as(select coalesce(sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null),0) cost,count(*) filter(where unit_cost is null)::integer missing from erp_home.biz_lines(p_from,p_to,p_statuses) where p_cost)
 select jsonb_build_object('revenue_without_freight',erp_home.money(o.revenue),'cost',case when p_cost then erp_home.money(l.cost) end,
  'gross_margin',case when p_cost then erp_home.money(o.revenue-l.cost) end,'gross_margin_pct',case when p_cost then erp_home.pct(o.revenue-l.cost,o.revenue) end,
  'lines_without_cost',case when p_cost then l.missing end,'taxes',null,'fees',null,'profit',null)
 from o left join l on true
$$;
create function erp_home.biz_channels(p_from date,p_to date,p_statuses text[]) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('channel',channel,'orders',orders,'total',erp_home.money(total)) order by total desc,channel),'[]'::jsonb)
 from(select channel,count(*)::integer orders,sum(total) total from erp_home.biz_orders(p_from,p_to,p_statuses) group by channel order by sum(total) desc,channel limit 50) x
$$;
-- Products of the period by revenue, with Custo and Margem Bruta % (purchase readers only) and stock (stock readers only).
create function erp_home.biz_products(p_from date,p_to date,p_statuses text[],p_cost boolean,p_stock boolean,p_limit integer,p_brand text default null)
returns jsonb language sql stable set search_path=pg_catalog as $$
 with g as(select product_key,(array_agg(product_id))[1] product_id,max(code) code,max(name) name,sum(quantity) units,sum(total) total,
   sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
  from erp_home.biz_lines(p_from,p_to,p_statuses) where nullif(btrim(coalesce(p_brand,'')),'') is null or strpos(lower(coalesce(brand,'')),lower(btrim(p_brand)))>0
  group by product_key)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'units',erp_home.qty(units),'total',erp_home.money(total),
  'cost',case when p_cost and not missing then erp_home.money(cost) end,'margin_pct',case when p_cost and not missing then erp_home.pct(total-cost,total) end,
  'stock',case when p_stock and product_id is not null then erp_home.qty(erp_stock.count_physical(product_id,null)) end) order by total desc,units desc,name,product_key),'[]'::jsonb)
 from(select * from g order by total desc,units desc,name,product_key limit p_limit) x
$$;
create function erp_home.biz_day_series(p_from date,p_to date,p_statuses text[]) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('day',to_char(d,'YYYY-MM-DD'),'orders',coalesce(x.orders,0),'total',erp_home.money(x.total)) order by d),'[]'::jsonb)
 from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g(d)
 left join(select day,count(*)::integer orders,sum(total) total from erp_home.biz_orders(p_from,p_to,p_statuses) group by day) x on x.day=g.d::date
$$;
create function erp_home.biz_envelope(p_panel text,p_role text,p_filters jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','business_dashboard','data_mode','erp_native','panel',p_panel,'role',p_role,'as_of',clock_timestamp(),
  'business_date',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD'),
  'cost_visible',erp_home.biz_cost_visible(p_role),'stock_visible',erp_home.biz_stock_visible(p_role),'filters',p_filters)
$$;
create function erp_home.biz_today() returns date language sql stable set search_path=pg_catalog as $$ select(clock_timestamp() at time zone 'America/Sao_Paulo')::date $$;

-- Metas (Meu Negócio > Desempenho > Metas): Geral or by Vendedor; "Loja" is out of scope. Administrador writes; every
-- dashboard reader reads. Achieved = Valor Total of the orders in the finished statuses (Ajustes) inside the goal dates.
create table erp_home.goal_command(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create table erp_home.goal(
 id uuid primary key,
 name text not null check(length(name) between 1 and 120 and name=btrim(name) and name!~'[[:cntrl:]]'),
 start_on date not null,end_on date not null,
 segment text not null check(segment in('geral','vendedor')),
 seller text check(seller is null or(length(seller) between 1 and 80 and seller=btrim(seller) and seller!~'[[:cntrl:]]')),
 target numeric(18,2) not null check(target>0 and target<=999999999999.99),
 active boolean not null,
 version integer not null check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id),created_at timestamptz not null,
 updated_by uuid not null references auth.users(id),updated_at timestamptz not null,
 command_id uuid not null references erp_home.goal_command(id),
 check(start_on<=end_on and end_on-start_on<=3660),check((segment='vendedor')=(seller is not null))
);
create table erp_home.goal_audit(
 id bigint generated always as identity primary key,command_id uuid not null unique references erp_home.goal_command(id),
 actor uuid not null references auth.users(id),goal_id uuid not null references erp_home.goal(id),
 before_data jsonb,after_data jsonb not null,created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['goal_command','goal','goal_audit'] loop
 execute format('alter table erp_home.%I enable row level security',t);
 execute format('revoke all on erp_home.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
revoke all on all sequences in schema erp_home from public,anon,authenticated,service_role;
create trigger immutable_goal_command before update or delete on erp_home.goal_command for each row execute function erp_home.immutable_history();
create trigger immutable_goal_audit before update or delete on erp_home.goal_audit for each row execute function erp_home.immutable_history();
create function erp_home.guard_goal() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or tg_op='INSERT' and new.version<>1 or tg_op='UPDATE' and(new.id<>old.id or new.version<>old.version+1 or new.command_id=old.command_id
  or new.created_by<>old.created_by or new.created_at<>old.created_at) then raise exception 'erp_home_goal_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger guard_goal before insert or update or delete on erp_home.goal for each row execute function erp_home.guard_goal();
create function erp_home.goal_achieved(g erp_home.goal) returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(o.total),0) from erp_home.biz_orders(g.start_on,g.end_on,erp_home.biz_finished()) o where g.segment='geral' or o.seller=g.seller
$$;
create function erp_home.goal_dto(g erp_home.goal) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',g.id,'name',g.name,'start_on',to_char(g.start_on,'YYYY-MM-DD'),'end_on',to_char(g.end_on,'YYYY-MM-DD'),'segment',g.segment,'seller',g.seller,
  'target',erp_home.money(g.target),'achieved',erp_home.money(erp_home.goal_achieved(g)),'active',g.active,'version',g.version,'updated_at',g.updated_at)
$$;
-- "Metas em andamento": active and not finished yet (São Paulo date); "Metas inativas": the others.
create function erp_home.goal_running(g erp_home.goal) returns boolean language sql stable set search_path=pg_catalog as $$ select g.active and g.end_on>=erp_home.biz_today() $$;
create function erp_home.goals_json(p_running boolean,p_limit integer) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(erp_home.goal_dto(g) order by g.end_on,g.start_on,g.name,g.id),'[]'::jsonb)
 from(select * from erp_home.goal g where erp_home.goal_running(g)=p_running order by end_on,start_on,name,id limit p_limit) g
$$;

-- Dashboard Mensal.
create function public.erp_home_business_monthly(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_compare_from date,p_compare_to date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_year date;v_cost boolean;v_stock boolean;v_days integer;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to,366);
 if(p_compare_from is null)<>(p_compare_to is null) then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 if p_compare_from is not null then perform erp_home.biz_period(p_compare_from,p_compare_to,366); end if;
 v_cost:=erp_home.biz_cost_visible(v_role);v_stock:=erp_home.biz_stock_visible(v_role);v_year:=date_trunc('year',p_to::timestamp)::date;v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('mensal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'compare_from',to_char(p_compare_from,'YYYY-MM-DD'),'compare_to',to_char(p_compare_to,'YYYY-MM-DD')))
  ||jsonb_build_object('kpis',jsonb_build_object('current',erp_home.biz_kpis(p_from,p_to,v_s),'previous',case when p_compare_from is not null then erp_home.biz_kpis(p_compare_from,p_compare_to,v_s) end),
   'daily',jsonb_build_object('current',erp_home.biz_day_series(p_from,p_to,v_s),'previous',case when p_compare_from is not null then erp_home.biz_day_series(p_compare_from,p_compare_to,v_s) else '[]'::jsonb end),
   'statuses',erp_home.biz_status_rows(p_from,p_to,v_s),'indicators',erp_home.biz_indicators(p_from,p_to,v_s,v_cost),'channels',erp_home.biz_channels(p_from,p_to,v_s),
   'top_skus',(select coalesce(jsonb_agg(x||jsonb_build_object('forecast_days',case when x->>'stock' is null or(x->>'units')::numeric<=0 then null
      else least(floor(greatest((x->>'stock')::numeric,0)/((x->>'units')::numeric/v_days)),2147483647)::integer end)),'[]'::jsonb)
    from jsonb_array_elements(erp_home.biz_products(p_from,p_to,v_s,false,v_stock,10)) x),
   'months',(select coalesce(jsonb_agg(jsonb_build_object('month',to_char(m,'YYYY-MM'),'total',erp_home.money(
     (select sum(total) from erp_home.biz_orders(m::date,(m+interval '1 month'-interval '1 day')::date,v_s)))) order by m),'[]'::jsonb)
    from generate_series(date_trunc('month',p_to::timestamp)-interval '11 months',date_trunc('month',p_to::timestamp),interval '1 month') g(m)),
   'annual',erp_home.biz_kpis(v_year,(v_year+interval '1 year'-interval '1 day')::date,v_s),
   'goals',erp_home.goals_json(true,20));
end $$;

-- Dashboard Diário: one day against the comparison day; "Novos Clientes" are contacts whose first order (same statuses) is that day.
create function erp_home.biz_new_customers(p_day date,p_statuses text[]) returns integer language sql stable set search_path=pg_catalog as $$
 select count(distinct o.contact_id)::integer from erp_home.biz_orders(p_day,p_day,p_statuses) o
 where not exists(select 1 from erp_documents.document d where d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(p_statuses)
  and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_day)
$$;
create function public.erp_home_business_daily(p_user_id uuid,p_statuses jsonb,p_day date,p_compare_day date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_stock boolean;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_day,p_day,1);
 if p_compare_day is not null then perform erp_home.biz_period(p_compare_day,p_compare_day,1); end if;
 v_stock:=erp_home.biz_stock_visible(v_role);
 return erp_home.biz_envelope('diario',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'day',to_char(p_day,'YYYY-MM-DD'),'compare_day',to_char(p_compare_day,'YYYY-MM-DD')))
  ||jsonb_build_object('kpis',jsonb_build_object('current',erp_home.biz_kpis(p_day,p_day,v_s)||jsonb_build_object('new_customers',erp_home.biz_new_customers(p_day,v_s)),
    'previous',case when p_compare_day is not null then erp_home.biz_kpis(p_compare_day,p_compare_day,v_s)||jsonb_build_object('new_customers',erp_home.biz_new_customers(p_compare_day,v_s)) end),
   'statuses',erp_home.biz_status_rows(p_day,p_day,v_s),'indicators',erp_home.biz_indicators(p_day,p_day,v_s,erp_home.biz_cost_visible(v_role)),
   'top_skus',erp_home.biz_products(p_day,p_day,v_s,false,v_stock,10));
end $$;

-- Dashboard Pedidos de Venda: totals, Situação, Vendas por estado, por produto e por canal (optionally one UF).
create function public.erp_home_business_orders(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_state text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_cost boolean;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if p_state is not null and p_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO|EX)$' then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_cost:=erp_home.biz_cost_visible(v_role);
 return erp_home.biz_envelope('pedidos-venda',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'state',p_state))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_state is null or state=p_state),
    l as materialized(select l.*,o.state from erp_home.biz_lines(p_from,p_to,v_s) l join o on o.id=l.document_id)
   select jsonb_build_object(
    'totals',(select jsonb_build_object('orders',count(*)::integer,'units',erp_home.qty(sum(units)),'total',erp_home.money(sum(total)),'freight',erp_home.money(sum(freight)),'ticket',erp_home.ratio(sum(total),count(*))) from o),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'orders',coalesce(x.orders,0),'total',erp_home.money(x.total)) order by n),'[]'::jsonb)
      from unnest(v_s) with ordinality u(s,n) left join(select status,count(*)::integer orders,sum(total) total from o group by status) x on x.status=u.s),
    'by_state',(select coalesce(jsonb_agg(jsonb_build_object('state',state,'orders',orders,'units',erp_home.qty(units),'total',erp_home.money(total),'freight_avg',erp_home.ratio(freight,orders),'ticket',erp_home.ratio(total,orders)) order by total desc,state nulls last),'[]'::jsonb)
      from(select state,count(*)::integer orders,sum(units) units,sum(total) total,sum(freight) freight from o group by state) x),
    'by_product',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'units',erp_home.qty(units),'total',erp_home.money(total),
       'cost',case when v_cost and not missing then erp_home.money(cost) end,'margin_pct',case when v_cost and not missing then erp_home.pct(total-cost,total) end,'stock',null) order by total desc,units desc,name,product_key),'[]'::jsonb)
      from(select product_key,(array_agg(product_id))[1] product_id,max(code) code,max(name) name,sum(quantity) units,sum(total) total,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
       from l group by product_key order by sum(total) desc,sum(quantity) desc,max(name),product_key limit 300) x),160000),
    'by_channel',(select coalesce(jsonb_agg(jsonb_build_object('channel',c.channel,'orders',c.orders,'ticket',erp_home.ratio(c.total,c.orders),'units',erp_home.qty(c.units),
       'cost',case when v_cost and not c.missing then erp_home.money(c.cost) end,'total',erp_home.money(c.total),'freight',erp_home.money(c.freight),'unit_value',erp_home.ratio(c.total-c.freight,c.units),
       'margin_pct',case when v_cost and not c.missing then erp_home.pct(c.total-c.freight-c.cost,c.total-c.freight) end,'taxes',null,'fees',null,'contribution_pct',null) order by c.total desc,c.channel),'[]'::jsonb)
      from(select o.channel,count(*)::integer orders,sum(o.units) units,sum(o.total) total,sum(o.freight) freight,
        (select sum(round(l.quantity*l.unit_cost,2)) from l where l.channel=o.channel and l.unit_cost is not null) cost,
        coalesce((select bool_or(l.unit_cost is null) from l where l.channel=o.channel),false) missing from o group by o.channel) c))
   );
end $$;

-- Dashboard Vendas por Vendedor: by seller (orders without seller are "Sem vendedor"), by product, Evolução and Status.
create function public.erp_home_business_sellers(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_seller text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_cost boolean;v_seller text:=nullif(btrim(coalesce(p_seller,'')),'');v_days integer;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if length(p_seller)>80 or p_seller~'[[:cntrl:]]' then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_cost:=erp_home.biz_cost_visible(v_role);v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('vendas-vendedor',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'seller',v_seller))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where v_seller is null or seller=v_seller),
    l as materialized(select l.* from erp_home.biz_lines(p_from,p_to,v_s) l join o on o.id=l.document_id)
   select jsonb_build_object(
    'sellers',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from(select distinct seller s from erp_home.biz_orders(p_from,p_to,v_s) where seller is not null order by 1 limit 200) x),
    'by_seller',(select coalesce(jsonb_agg(jsonb_build_object('seller',x.seller,'orders',x.orders,'units',erp_home.qty(x.units),'freight',erp_home.money(x.freight),'total',erp_home.money(x.total),
       'ticket',erp_home.ratio(x.total,x.orders),'margin_pct',case when v_cost and not x.missing then erp_home.pct(x.total-x.freight-x.cost,x.total-x.freight) end) order by x.total desc,x.seller nulls last),'[]'::jsonb)
      from(select o.seller,count(*)::integer orders,sum(o.units) units,sum(o.freight) freight,sum(o.total) total,
        coalesce((select sum(round(l.quantity*l.unit_cost,2)) from l where l.seller is not distinct from o.seller and l.unit_cost is not null),0) cost,
        coalesce((select bool_or(l.unit_cost is null) from l where l.seller is not distinct from o.seller),false) missing from o group by o.seller) x),
    'by_product',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'units',erp_home.qty(units),'total',erp_home.money(total),
       'cost',case when v_cost and not missing then erp_home.money(cost) end,'margin_pct',case when v_cost and not missing then erp_home.pct(total-cost,total) end,'stock',null) order by total desc,units desc,name,product_key),'[]'::jsonb)
      from(select product_key,(array_agg(product_id))[1] product_id,max(code) code,max(name) name,sum(quantity) units,sum(total) total,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
       from l group by product_key order by sum(total) desc,sum(quantity) desc,max(name),product_key limit 300) x),120000),
    'evolution',case when v_days<=62 then(select coalesce(jsonb_agg(jsonb_build_object('bucket',to_char(g.d,'YYYY-MM-DD'),'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb)
       from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g(d))
     else(select coalesce(jsonb_agg(jsonb_build_object('bucket',to_char(g.m,'YYYY-MM'),'total',erp_home.money((select sum(total) from o where date_trunc('month',o.day::timestamp)=g.m))) order by g.m),'[]'::jsonb)
       from generate_series(date_trunc('month',p_from::timestamp),date_trunc('month',p_to::timestamp),interval '1 month') g(m)) end,
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'orders',coalesce(x.orders,0),'total',erp_home.money(x.total)) order by n),'[]'::jsonb)
      from unnest(v_s) with ordinality u(s,n) left join(select status,count(*)::integer orders,sum(total) total from o group by status) x on x.status=u.s))
   );
end $$;

-- Venda Canal (24 meses): monthly Valor Total per channel, statuses of "Configurações Meu negócio", no filters.
create function public.erp_home_business_channels(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_end date;v_start date;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_finished();v_end:=date_trunc('month',erp_home.biz_today()::timestamp)::date;v_start:=(v_end-interval '23 months')::date;
 return erp_home.biz_envelope('venda-canal',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(v_start,'YYYY-MM-DD'),'to',to_char((v_end+interval '1 month'-interval '1 day')::date,'YYYY-MM-DD')))
  ||(with o as materialized(select * from erp_home.biz_orders(v_start,(v_end+interval '1 month'-interval '1 day')::date,v_s)),
    c as materialized(select channel,row_number()over(order by sum(total) desc,channel) n from o group by channel order by 2 limit 20)
   select jsonb_build_object('channels',(select coalesce(jsonb_agg(channel order by n),'[]'::jsonb) from c),
    'months',(select jsonb_agg(jsonb_build_object('month',to_char(g.m,'YYYY-MM'),'values',(select coalesce(jsonb_agg(jsonb_build_object('channel',c.channel,
      'total',erp_home.money((select sum(o.total) from o where o.channel=c.channel and date_trunc('month',o.day::timestamp)=g.m))) order by c.n),'[]'::jsonb) from c)) order by g.m)
     from generate_series(v_start::timestamp,v_end::timestamp,interval '1 month') g(m))));
end $$;

-- Dashboard Previsão de Estoque: Giro de Produto (sold, average per day, current stock with or without the reserved quantity,
-- coverage in days), Vendas por Canal and Vendas por dia, in the statuses of "Configurações Meu negócio". Stock readers only.
create function public.erp_home_business_forecast(p_user_id uuid,p_from date,p_to date,p_warehouse_id uuid,p_reserve boolean) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_days integer;
begin
 v_role:=erp_home.biz_role(p_user_id);
 if not erp_home.biz_stock_visible(v_role) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 perform erp_home.biz_period(p_from,p_to);
 if p_reserve is null then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then raise exception 'erp_home_business_warehouse_not_found' using errcode='P0002'; end if;
 v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
    l as materialized(select l.* from erp_home.biz_lines(p_from,p_to,v_s) l join o on o.id=l.document_id where l.product_id is not null),
    p as materialized(select l.product_id,max(l.code) code,max(l.name) name,sum(l.quantity) sold from l group by l.product_id order by sum(l.quantity) desc,max(l.name),l.product_id limit 300),
    s as materialized(select p.*,erp_stock.count_physical(p.product_id,p_warehouse_id)-case when p_reserve then(select coalesce(sum(i.quantity),0) from erp_stock.reservation_item i join erp_stock.reservation x on x.id=i.reservation_id
      where x.state='active' and i.product_id=p.product_id and(i.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(i.warehouse_id)))) else 0 end stock from p)
   select jsonb_build_object(
    'turnover',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'sold',erp_home.qty(sold),'per_day',erp_home.qty(sold/v_days),'stock',erp_home.qty(stock),
       'coverage_days',case when sold<=0 then null else least(floor(greatest(stock,0)*v_days/sold),2147483647)::integer end) order by sold desc,name,product_id),'[]'::jsonb) from s),160000),
    'by_channel',(select coalesce(jsonb_agg(jsonb_build_object('channel',channel,'orders',orders,'units',erp_home.qty(units),'total',erp_home.money(total)) order by total desc,channel),'[]'::jsonb)
      from(select channel,count(*)::integer orders,sum(units) units,sum(total) total from o group by channel) x),
    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d))));
end $$;

-- Dashboard Margem por Pedido: Indicadores Operacionais and "Margem de Contribuição por pedido" (Todos, Lucro, Prejuízo).
-- Contribution = Faturamento sem frete - custo; an order with any line without cost is shown without margin.
create function public.erp_home_business_margin(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_tab text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];
begin
 v_role:=erp_home.biz_role(p_user_id);
 if not erp_home.biz_cost_visible(v_role) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if p_tab is null or p_tab not in('todos','lucro','prejuizo') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_envelope('margem-pedido',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'tab',p_tab))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s)),
    c as materialized(select o.*,x.cost,coalesce(x.missing,false) missing,o.total-o.freight revenue from o left join(select document_id,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
     from erp_home.biz_lines(p_from,p_to,v_s) group by document_id) x on x.document_id=o.id),
    k as materialized(select *,case when missing then null else revenue-coalesce(cost,0) end contribution from c)
   select jsonb_build_object(
    'indicators',(select jsonb_build_object('revenue',erp_home.money(sum(total)),'ticket',erp_home.ratio(sum(total),count(*)),'orders',count(*)::integer,'freight_buyer',null,'freight_seller',erp_home.money(sum(freight)),
      'cost',erp_home.money(sum(cost) filter(where not missing)),'taxes',null,'fees',null,'contribution',erp_home.money(sum(contribution)),
      'contribution_pct',erp_home.pct(sum(contribution),sum(revenue) filter(where not missing)),'orders_without_cost',(count(*) filter(where missing))::integer) from k),
    'progression',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'revenue',erp_home.money((select sum(revenue) from k where k.day=g.d::date)),
       'contribution',erp_home.money((select sum(contribution) from k where k.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d)),
    'total',(select count(*)::integer from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0),
    'orders',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number::text,'day',to_char(day,'YYYY-MM-DD'),'contact',contact_name,'channel',channel,'total',erp_home.money(total),
       'freight',erp_home.money(freight),'revenue',erp_home.money(revenue),'cost',case when missing then null else erp_home.money(cost) end,'contribution',case when missing then null else erp_home.money(contribution) end,
       'contribution_pct',case when missing then null else erp_home.pct(contribution,revenue) end) order by day desc,number desc),'[]'::jsonb)
      from(select * from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0 order by day desc,number desc limit 500) x),160000)));
end $$;

-- Dashboard Novos x Recorrentes: a customer is "novo" when the first order (same statuses, any date) is inside the period.
create function public.erp_home_business_customers(p_user_id uuid,p_statuses jsonb,p_from date,p_to date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_cost boolean;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);v_cost:=erp_home.biz_cost_visible(v_role);
 return erp_home.biz_envelope('novos-recorrentes',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD')))
  ||(with o as materialized(select o.*,not exists(select 1 from erp_documents.document d where d.kind='sales_orders' and d.contact_id=o.contact_id and d.status=any(v_s)
      and(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' and(d.body->>'date')::date<p_from) is_new from erp_home.biz_orders(p_from,p_to,v_s) o),
    lc as materialized(select l.contact_id,sum(round(l.quantity*l.unit_cost,2)) filter(where l.unit_cost is not null) cost,bool_or(l.unit_cost is null) missing from erp_home.biz_lines(p_from,p_to,v_s) l group by l.contact_id),
    cu as materialized(select o.contact_id,bool_and(o.is_new) is_new,max(o.contact_name) name,count(*)::integer orders,sum(o.units) units,sum(o.total) total,sum(o.total-o.freight) revenue,
      (array_agg(o.channel order by o.day desc,o.number desc))[1] channel from o group by o.contact_id),
    a as(select sum(total) total from cu)
   select jsonb_build_object(
    'cards',(select jsonb_object_agg(k,jsonb_build_object('customers',coalesce(x.customers,0),'orders',coalesce(x.orders,0),'total',erp_home.money(x.total),'units',erp_home.qty(x.units),
       'ticket',erp_home.ratio(x.total,x.orders),'share_pct',erp_home.pct(x.total,(select total from a)))) from unnest(array['recorrentes','novos']) k
      left join(select case when is_new then 'novos' else 'recorrentes' end g,count(*)::integer customers,sum(orders)::integer orders,sum(total) total,sum(units) units from cu group by 1) x on x.g=k),
    'chart',(select coalesce(jsonb_agg(jsonb_build_object('bucket',to_char(g.m,'YYYY-MM'),'new',erp_home.money((select sum(total) from o where o.is_new and date_trunc('month',o.day::timestamp)=g.m)),
       'recurring',erp_home.money((select sum(total) from o where not o.is_new and date_trunc('month',o.day::timestamp)=g.m))) order by g.m),'[]'::jsonb)
      from generate_series(date_trunc('month',p_from::timestamp),date_trunc('month',p_to::timestamp),interval '1 month') g(m)),
    'total',(select count(*)::integer from cu),
    'customers',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('contact_id',cu.contact_id,'name',cu.name,'kind',case when cu.is_new then 'novo' else 'recorrente' end,'channel',cu.channel,'orders',cu.orders,
       'units',erp_home.qty(cu.units),'total',erp_home.money(cu.total),'margin_pct',case when v_cost and lc.missing is false then erp_home.pct(cu.revenue-lc.cost,cu.revenue) end,
       'profit',case when v_cost and lc.missing is false then erp_home.money(cu.revenue-lc.cost) end,'mobile',erp_home.biz_text(coalesce(nullif(c.mobile,''),c.phone),40)) order by cu.total desc,cu.name,cu.contact_id),'[]'::jsonb)
      from(select * from cu order by total desc,name,contact_id limit 300) cu left join lc on lc.contact_id=cu.contact_id left join erp_catalog.contact c on c.record_id=cu.contact_id),160000)));
end $$;

-- Dashboard Atividade da Carteira: customers with orders in the period (statuses of Ajustes), purchase cycle and days without buying.
-- "Palavras chave" match the customer name (Brufap has no contact tags yet); Marca keeps customers who bought that brand.
create function public.erp_home_business_portfolio(p_user_id uuid,p_from date,p_to date,p_brand text,p_min_days integer,p_keywords jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_today date:=erp_home.biz_today();v_keywords text[];
begin
 v_role:=erp_home.biz_role(p_user_id);perform erp_home.biz_period(p_from,p_to,3661);
 if p_keywords is null or jsonb_typeof(p_keywords)<>'array' or jsonb_array_length(p_keywords)>10 or exists(select 1 from jsonb_array_elements(p_keywords) x where jsonb_typeof(x)<>'string') then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_keywords:=array(select jsonb_array_elements_text(p_keywords));
 if length(p_brand)>100 or p_brand~'[[:cntrl:]]' or p_min_days is not null and p_min_days not between 0 and 36600
  or exists(select 1 from unnest(v_keywords) k where length(k) not between 1 and 60 or k<>btrim(k) or k~'[[:cntrl:]]') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_s:=erp_home.biz_finished();
 return erp_home.biz_envelope('atividade-carteira',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'brand',nullif(btrim(coalesce(p_brand,'')),''),'min_days',p_min_days,'keywords',to_jsonb(v_keywords)))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) o
      where(nullif(btrim(coalesce(p_brand,'')),'') is null or exists(select 1 from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id
       where i.document_id=o.id and strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0))
       and(cardinality(v_keywords)=0 or exists(select 1 from unnest(v_keywords) k where strpos(lower(o.contact_name),lower(k))>0))),
    cu as materialized(select contact_id,max(contact_name) name,count(*)::integer orders,sum(total) total,min(day) first_day,max(day) last_day,count(distinct day)::integer days from o group by contact_id),
    f as materialized(select cu.*,v_today-cu.last_day idle from cu where p_min_days is null or v_today-cu.last_day>=p_min_days)
   select jsonb_build_object('total',(select count(*)::integer from f),'sum',(select erp_home.money(sum(total)) from f),
    'customers',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('contact_id',f.contact_id,'name',f.name,'orders',f.orders,'total',erp_home.money(f.total),
       'first_purchase',to_char(f.first_day,'YYYY-MM-DD'),'last_purchase',to_char(f.last_day,'YYYY-MM-DD'),
       'cycle_days',case when f.days>1 then round((f.last_day-f.first_day)::numeric/(f.days-1))::integer end,'days_without',greatest(f.idle,0),
       'document',erp_home.biz_text(c.document,20),'state',erp_home.biz_text(c.state,2),'email',erp_home.biz_text(c.email,254),'mobile',erp_home.biz_text(coalesce(nullif(c.mobile,''),c.phone),40))
       order by f.total desc,f.name,f.contact_id),'[]'::jsonb)
      from(select * from f order by total desc,name,contact_id limit 500) f left join erp_catalog.contact c on c.record_id=f.contact_id),160000)));
end $$;

-- Dashboard Curva ABC (Produtos): by cumulative share of the revenue after each product, A up to 80% (the first product is
-- always A), B up to 95%, C the rest.
create function public.erp_home_business_abc(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_brand text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if length(p_brand)>100 or p_brand~'[[:cntrl:]]' then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_envelope('curva-abc',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'brand',nullif(btrim(coalesce(p_brand,'')),'')))
  ||(with g as materialized(select product_key,(array_agg(product_id))[1] product_id,max(code) code,max(name) name,sum(quantity) units,sum(total) total
      from erp_home.biz_lines(p_from,p_to,v_s) where nullif(btrim(coalesce(p_brand,'')),'') is null or strpos(lower(coalesce(brand,'')),lower(btrim(p_brand)))>0 group by product_key),
    t as(select sum(total) total from g),
    r as materialized(select g.*,sum(g.total)over(order by g.total desc,g.units desc,g.name,g.product_key rows unbounded preceding) cumulative,
      row_number()over(order by g.total desc,g.units desc,g.name,g.product_key) n from g),
    c as materialized(select r.*,case when(select total from t)=0 then 'C' when r.n=1 or r.cumulative*100<=(select total from t)*80 then 'A' when r.cumulative*100<=(select total from t)*95 then 'B' else 'C' end curve from r)
   select jsonb_build_object('total',erp_home.money((select total from t)),
    'counts',jsonb_build_object('A',(select count(*)::integer from c where curve='A'),'B',(select count(*)::integer from c where curve='B'),'C',(select count(*)::integer from c where curve='C')),
    'products',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'units',erp_home.qty(units),'total',erp_home.money(total),
       'share_pct',erp_home.pct(total,(select total from t)),'cumulative_pct',erp_home.pct(cumulative,(select total from t)),'curve',curve) order by n),'[]'::jsonb)
      from(select * from c order by n limit 800) x),160000)));
end $$;

-- Metas.
create function public.erp_home_business_goals(p_user_id uuid,p_tab text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_home.biz_role(p_user_id);
 if p_tab is null or p_tab not in('andamento','inativas') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return jsonb_build_object('scope','business_goals','data_mode','erp_native','role',v_role,'tab',p_tab,'can_manage',v_role='admin',
  'business_date',to_char(erp_home.biz_today(),'YYYY-MM-DD'),'statuses',to_jsonb(erp_home.biz_finished()),
  'total',(select count(*)::integer from erp_home.goal g where erp_home.goal_running(g)=(p_tab='andamento')),'items',erp_home.goals_json(p_tab='andamento',200),
  'sellers',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from(select distinct erp_home.biz_seller(d.body) s from erp_documents.document d where d.kind='sales_orders' and erp_home.biz_seller(d.body) is not null order by 1 limit 200) x));
end $$;
-- Creates (p_goal_id null, expected 0) or replaces a goal (name, dates, segmentation, seller, target and situation).
create function public.erp_home_business_goal_save(p_user_id uuid,p_command_id uuid,p_goal_id uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;c erp_home.goal_command;g erp_home.goal;v_id uuid;v_name text;v_start date;v_end date;v_segment text;v_seller text;v_target numeric;v_active boolean;v_at timestamptz;v_before jsonb;v_result jsonb;
begin
 perform erp_home.biz_role(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or(p_goal_id is null)<>(p_expected_version=0)
  or p_data is null or jsonb_typeof(p_data)<>'object' or(select array_agg(k order by k) from jsonb_object_keys(p_data) k)<>array['active','end_on','name','segment','seller','start_on','target']
  or jsonb_typeof(p_data->'name')<>'string' or jsonb_typeof(p_data->'start_on')<>'string' or jsonb_typeof(p_data->'end_on')<>'string' or jsonb_typeof(p_data->'segment')<>'string'
  or jsonb_typeof(p_data->'seller') not in('null','string') or jsonb_typeof(p_data->'target')<>'string' or jsonb_typeof(p_data->'active')<>'boolean'
  or p_data->>'start_on'!~'^\d{4}-\d{2}-\d{2}$' or p_data->>'end_on'!~'^\d{4}-\d{2}-\d{2}$' or p_data->>'target'!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$' then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_name:=p_data->>'name';v_segment:=p_data->>'segment';v_seller:=p_data->>'seller';v_target:=(p_data->>'target')::numeric;v_active:=(p_data->>'active')::boolean;
 begin v_start:=(p_data->>'start_on')::date;v_end:=(p_data->>'end_on')::date;exception when others then raise exception 'erp_home_business_input_invalid' using errcode='22023';end;
 if length(v_name) not between 1 and 120 or v_name<>btrim(v_name) or v_name~'[[:cntrl:]]' or v_segment not in('geral','vendedor') or(v_segment='vendedor')<>(v_seller is not null)
  or v_seller is not null and(length(v_seller) not between 1 and 80 or v_seller<>btrim(v_seller) or v_seller~'[[:cntrl:]]') or v_target<=0
  or v_start>v_end or v_end-v_start>3660 or v_start<date '2000-01-01' or v_end>date '2100-12-31' then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-home-goal-v1','actor',p_user_id,'goal',p_goal_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_home_goal_command'),hashtext(p_command_id::text));
 select * into c from erp_home.goal_command where id=p_command_id;
 if c.id is not null then
  if c.actor<>p_user_id or c.request_hash<>v_hash then raise exception 'erp_home_goal_command_conflict' using errcode='40001'; end if;
  if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin') then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
  return c.result||jsonb_build_object('goal',(select erp_home.goal_dto(x) from erp_home.goal x where x.id=(c.result#>>'{receipt,goal_id}')::uuid),'replayed',true);
 end if;
 perform 1 from auth.users where id=p_user_id for key share;
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin' for share) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 v_at:=clock_timestamp();
 if p_goal_id is null then v_id:=gen_random_uuid();v_before:=null;
 else
  select * into g from erp_home.goal where id=p_goal_id for update;
  if g.id is null then raise exception 'erp_home_goal_not_found' using errcode='P0002'; end if;
  if g.version<>p_expected_version then raise exception 'erp_home_goal_version_conflict' using errcode='40001'; end if;
  v_id:=g.id;v_before:=erp_home.goal_dto(g)-'achieved'-'updated_at';
  if g.name=v_name and g.start_on=v_start and g.end_on=v_end and g.segment=v_segment and g.seller is not distinct from v_seller and g.target=v_target and g.active=v_active then
   raise exception 'erp_home_goal_unchanged' using errcode='22023'; end if;
 end if;
 v_result:=jsonb_build_object('scope','business_goal_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,'goal_id',v_id,'changed_at',v_at,
  'from_version',p_expected_version,'to_version',p_expected_version+1));
 insert into erp_home.goal_command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 if p_goal_id is null then
  insert into erp_home.goal(id,name,start_on,end_on,segment,seller,target,active,version,created_by,created_at,updated_by,updated_at,command_id)
   values(v_id,v_name,v_start,v_end,v_segment,v_seller,v_target,v_active,1,p_user_id,v_at,p_user_id,v_at,p_command_id);
 else
  update erp_home.goal set name=v_name,start_on=v_start,end_on=v_end,segment=v_segment,seller=v_seller,target=v_target,active=v_active,version=version+1,
   updated_by=p_user_id,updated_at=v_at,command_id=p_command_id where id=v_id and version=p_expected_version;
 end if;
 select * into g from erp_home.goal where id=v_id;
 insert into erp_home.goal_audit(command_id,actor,goal_id,before_data,after_data) values(p_command_id,p_user_id,v_id,v_before,erp_home.goal_dto(g)-'achieved'-'updated_at');
 return v_result||jsonb_build_object('goal',erp_home.goal_dto(g),'replayed',false);
end $$;
-- "Conferir resultado": the author reads the stored receipt of the same command, never re-executed.
create function public.erp_home_business_goal_command(p_user_id uuid,p_command_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_home.goal_command;
begin
 perform erp_home.biz_role(p_user_id);
 if p_command_id is null then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 select * into c from erp_home.goal_command where id=p_command_id;
 if c.id is null then raise exception 'erp_home_goal_command_not_found' using errcode='P0002'; end if;
 if c.actor<>p_user_id then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 return c.result||jsonb_build_object('goal',(select erp_home.goal_dto(x) from erp_home.goal x where x.id=(c.result#>>'{receipt,goal_id}')::uuid),'replayed',true);
end $$;

-- Metas keep their own audit (erp_home.goal_audit, before and after of every command); Registro de atividades (148) does
-- not list them yet.
revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_home_business_monthly','erp_home_business_daily','erp_home_business_orders','erp_home_business_sellers','erp_home_business_channels','erp_home_business_forecast',
 'erp_home_business_margin','erp_home_business_customers','erp_home_business_portfolio','erp_home_business_abc','erp_home_business_goals','erp_home_business_goal_save',
 'erp_home_business_goal_command')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
