-- 374: frete cobrado e frete pago, custo aplicado na operação e histórico de custo (leva H, lane financeiro: PRF-268, VND-269).
-- Decisões recomendadas 3.5, adotadas em 21/10/2026:
-- * Frete cobrado do cliente (o Frete do pedido, que entra no total) e frete pago pela empresa (erp_documents.freight_paid, um custo
--   informado por pedido, fora do total do cliente) são campos distintos. Sem o frete pago informado, a margem é estimada e o
--   frete pago fica pendente.
-- * Histórico de custo do cadastro (erp_catalog.product_cost_history): cada mudança do Preço de custo ou do Preço de compra do
--   fornecedor padrão (119, 155, 235) fica registrada com a data; a partir desta migração, com o valor de hoje como ponto inicial.
-- * Custo aplicado na operação (erp_documents.item_cost_applied): na confirmação comercial do pedido de venda, cada item guarda o
--   custo daquele momento (custo médio, Preço de custo ou último pedido de compra, como o Meu Negócio já calculava) e a base usada.
--   Pedidos confirmados antes desta migração não ganham custo aplicado (seria o custo de hoje).
-- * Meu Negócio (biz_lines, 150/265) e a Margem por pedido (188) usam o custo aplicado, senão o custo do cadastro na data do pedido,
--   senão a última compra até a data; nunca o custo atual para uma venda antiga. Sem custo, a linha fica sem custo (pendente).
-- * Relatório de vendas (271): "Preço de custo até a data do pedido" (cost_until) e "Custo aplicado na operação" (applied).
-- Nenhum estoque, conta ou documento é alterado; o frete pago não gera conta a pagar.
begin;

do $$ declare r record; begin
  for r in select * from (values
    ('erp_home.biz_lines(date,date,text[])','b5d2729b86df5dfbe78809625831e7570b29c3832df6452032e4b41dfc6b5df9'),
    ('public.erp_document_sales_report(uuid,jsonb)','700d4990e760a0fab5d778d0a1f12a3e30577faddd9e512b944fafece622a16b'),
    ('erp_documents.report_unit_cost(uuid,text,date,boolean)','9649448304c96af7b54f7bff08ac4e1d377c3fdba0aa3f962bbe15aa4e74dfa0'),
    ('public.erp_home_business_margin(uuid,jsonb,date,date,text)','5699de48cb9bc6748cca1377e6e5a59b2fb5567e4cba6074ca69007627236646')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'cost_history_374_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
  if to_regclass('erp_catalog.product_cost_history') is not null then raise exception 'cost_history_374_already_applied' using errcode='55000'; end if;
end $$;

-- ---------------------------------------------------------------- Histórico de custo do cadastro
create table erp_catalog.product_cost_history (
  id bigint generated always as identity primary key,
  product_id uuid not null references erp_catalog.product(record_id),
  cost_price numeric(30,10) check(cost_price is null or cost_price>=0),
  purchase_price numeric(30,10) check(purchase_price is null or purchase_price>=0),
  valid_from timestamptz not null default clock_timestamp(),
  source text not null check(source in ('inicial','cadastro'))
);
create index erp_catalog_product_cost_history_product on erp_catalog.product_cost_history(product_id,valid_from desc,id desc);
alter table erp_catalog.product_cost_history enable row level security;
revoke all on erp_catalog.product_cost_history from public,anon,authenticated,service_role;
create function erp_catalog.product_cost_history_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_catalog_cost_history_immutable' using errcode='55000'; end $$;
create trigger product_cost_history_immutable before update or delete on erp_catalog.product_cost_history for each row execute function erp_catalog.product_cost_history_immutable();
-- A change of the default supplier's prices (the product save rewrites the rows: equal values are not a change).
create function erp_catalog.product_cost_capture() returns trigger language plpgsql set search_path=pg_catalog as $$
declare h erp_catalog.product_cost_history;
begin
  if not new.is_default then return null; end if;
  select * into h from erp_catalog.product_cost_history where product_id=new.record_id order by valid_from desc,id desc limit 1;
  if h.id is null or h.cost_price is distinct from new.cost_price or h.purchase_price is distinct from new.purchase_price then
    insert into erp_catalog.product_cost_history(product_id,cost_price,purchase_price,source) values(new.record_id,new.cost_price,new.purchase_price,'cadastro');
  end if;
  return null;
end $$;
create trigger product_cost_capture after insert or update on erp_catalog.product_supplier for each row execute function erp_catalog.product_cost_capture();
insert into erp_catalog.product_cost_history(product_id,cost_price,purchase_price,source)
  select s.record_id,s.cost_price,s.purchase_price,'inicial' from erp_catalog.product_supplier s where s.is_default order by s.record_id;
-- Preço de custo of the cadastro at the end of a day (São Paulo); null before the history starts.
create function erp_catalog.product_cost_at(p_product uuid,p_day date) returns numeric language sql stable set search_path=pg_catalog as $$
  select h.cost_price from erp_catalog.product_cost_history h where h.product_id=p_product and h.valid_from<((p_day+1)::timestamp at time zone 'America/Sao_Paulo')
  order by h.valid_from desc,h.id desc limit 1;
$$;

-- ---------------------------------------------------------------- Custo aplicado na operação
create table erp_documents.item_cost_applied (
  item_id uuid primary key,
  document_id uuid not null references erp_documents.document(id),
  product_id uuid not null,
  unit_cost numeric(30,10) not null check(unit_cost>=0),
  basis text not null check(basis in ('custo_medio','preco_custo','ultimo_pedido_compra')),
  applied_on date not null check(applied_on between date '1900-01-01' and date '2100-12-31'),
  applied_at timestamptz not null default clock_timestamp()
);
create index erp_documents_item_cost_applied_document on erp_documents.item_cost_applied(document_id);
alter table erp_documents.item_cost_applied enable row level security;
revoke all on erp_documents.item_cost_applied from public,anon,authenticated,service_role;
create function erp_documents.item_cost_applied_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_cost_applied_immutable' using errcode='55000'; end $$;
create trigger item_cost_applied_immutable before update or delete on erp_documents.item_cost_applied for each row execute function erp_documents.item_cost_applied_immutable();
-- At the commercial confirmation of a pedido de venda, each item without an applied cost keeps the cost of that moment.
create function erp_documents.cost_apply(p_document uuid) returns integer language plpgsql set search_path=pg_catalog as $$
declare d erp_documents.document; r record; v_avg numeric; v_cost numeric; v_basis text; v_count integer:=0;
begin
  select * into d from erp_documents.document where id=p_document;
  if d.id is null or d.kind<>'sales_orders' or not erp_finance.commission_confirmed(d.kind,d.status) then return 0; end if;
  for r in select i.id,i.product_id from erp_documents.item i where i.document_id=d.id and i.product_id is not null
    and not exists(select 1 from erp_documents.item_cost_applied a where a.item_id=i.id) order by i.position loop
    select nullif(a.average_cost,0) into v_avg from erp_stock.average_costs(array[r.product_id]) a where a.product_id=r.product_id;
    v_cost:=v_avg; v_basis:='custo_medio';
    if v_cost is null then select s.cost_price into v_cost from erp_catalog.product_supplier s where s.record_id=r.product_id and s.is_default limit 1; v_basis:='preco_custo'; end if;
    if v_cost is null then v_cost:=erp_home.biz_unit_cost(r.product_id); v_basis:='ultimo_pedido_compra'; end if;
    if v_cost is not null and v_cost>=0 then
      insert into erp_documents.item_cost_applied(item_id,document_id,product_id,unit_cost,basis,applied_on)
        values(r.id,d.id,r.product_id,v_cost,v_basis,(clock_timestamp() at time zone 'America/Sao_Paulo')::date) on conflict(item_id) do nothing;
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end $$;
create function erp_documents.cost_apply_capture() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  begin perform erp_documents.cost_apply(new.id);
  exception when data_exception or check_violation then null; end;
  return null;
end $$;
create constraint trigger cost_apply_capture after insert or update on erp_documents.document deferrable initially deferred
  for each row when (new.kind='sales_orders') execute function erp_documents.cost_apply_capture();

-- ---------------------------------------------------------------- Frete pago pela empresa
create table erp_documents.freight_paid (
  document_id uuid primary key references erp_documents.document(id),
  amount numeric(14,2) not null check(amount between 0 and 999999999999.99),
  note text check(note is null or (length(note) between 1 and 200 and note!~'[[:cntrl:]]')),
  version integer not null default 1 check(version between 1 and 2147483647),
  updated_by uuid not null references auth.users(id), updated_at timestamptz not null default clock_timestamp()
);
create table erp_documents.freight_paid_command (
  command_id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_documents.freight_paid_audit (
  id bigint generated always as identity primary key, document_id uuid not null, actor uuid not null references auth.users(id), command_id uuid not null,
  before_amount numeric(14,2), after_amount numeric(14,2), note text, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin foreach t in array array['freight_paid','freight_paid_command','freight_paid_audit'] loop
  execute format('alter table erp_documents.%I enable row level security',t);
  execute format('revoke all on erp_documents.%I from public,anon,authenticated,service_role',t);
end loop; end $$;
create function erp_documents.freight_paid_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_document_audit_immutable' using errcode='55000'; end $$;
create trigger freight_paid_audit_immutable before update or delete on erp_documents.freight_paid_audit for each row execute function erp_documents.freight_paid_audit_immutable();
create function erp_documents.freight_paid_view(p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('document_id',d.id,'kind',d.kind,'freight_charged',erp_home.biz_freight(d.body)::numeric(14,2)::text,
    'freight_paid',case when f.document_id is null then null else f.amount::text end,'note',f.note,'version',coalesce(f.version,0),
    'applied_costs',(select coalesce(jsonb_agg(jsonb_build_object('item_id',a.item_id,'product_id',a.product_id,'unit_cost',a.unit_cost::text,'basis',a.basis,'applied_on',a.applied_on)
      order by a.applied_at,a.item_id),'[]'::jsonb) from erp_documents.item_cost_applied a where a.document_id=d.id))
  from erp_documents.document d left join erp_documents.freight_paid f on f.document_id=d.id where d.id=p_document;
$$;
create function public.erp_document_freight_paid_get(p_user_id uuid,p_kind text,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  if p_kind is distinct from 'sales_orders' or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
  perform erp_documents.require_access(p_user_id,p_kind,false);
  if not erp_home.biz_cost_visible(erp_home.biz_role(p_user_id)) then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
  if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','freight_paid','kind',p_kind,'data_mode','erp_native','operational_effects',false,'item',erp_documents.freight_paid_view(p_document_id));
end $$;
create function public.erp_document_freight_paid_save(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_documents.freight_paid_command; v_row erp_documents.freight_paid; v_amount numeric; v_note text; v_result jsonb;
begin
  if p_kind is distinct from 'sales_orders' or p_document_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646
    or jsonb_typeof(p_data) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in ('amount','note')) or not p_data?&array['amount','note']
    or jsonb_typeof(p_data->'amount') not in ('string','null') or jsonb_typeof(p_data->'note') not in ('string','null')
    or (p_data->>'amount' is not null and p_data->>'amount'!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$') then raise exception 'erp_document_input_invalid' using errcode='22023'; end if;
  perform erp_documents.require_access(p_user_id,p_kind,true);
  if not erp_home.biz_cost_visible(erp_home.biz_role(p_user_id)) then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
  v_amount:=(p_data->>'amount')::numeric; v_note:=nullif(btrim(p_data->>'note'),'');
  if v_note is not null and (length(v_note)>200 or v_note~'[[:cntrl:]]') then raise exception 'erp_document_input_invalid' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-document-freight-paid-v1','actor',p_user_id,'document',p_document_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852931,hashtext(p_command_id::text));
  select * into v_command from erp_documents.freight_paid_command where command_id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_document_command_conflict' using errcode='40001'; end if;
    return v_command.result||'{"replayed":true}'::jsonb;
  end if;
  perform 1 from erp_documents.document where id=p_document_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  select * into v_row from erp_documents.freight_paid where document_id=p_document_id for update;
  if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if v_amount is null then
    if v_row.document_id is not null then raise exception 'erp_document_input_invalid' using errcode='22023'; end if;
  else
    insert into erp_documents.freight_paid(document_id,amount,note,version,updated_by) values(p_document_id,v_amount,v_note,1,p_user_id)
      on conflict(document_id) do update set amount=excluded.amount,note=excluded.note,version=erp_documents.freight_paid.version+1,updated_by=p_user_id,updated_at=clock_timestamp();
  end if;
  insert into erp_documents.freight_paid_audit(document_id,actor,command_id,before_amount,after_amount,note) values(p_document_id,p_user_id,p_command_id,v_row.amount,v_amount,v_note);
  v_result:=jsonb_build_object('entity','freight_paid','kind',p_kind,'data_mode','erp_native','operational_effects',false,'replayed',false,'item',erp_documents.freight_paid_view(p_document_id));
  insert into erp_documents.freight_paid_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Linhas do Meu Negócio com o custo histórico
CREATE OR REPLACE FUNCTION erp_home.biz_lines(p_from date, p_to date, p_statuses text[])
 RETURNS TABLE(document_id uuid, day date, contact_id uuid, channel text, seller text, product_key text, product_id uuid, code text, name text, brand text, quantity numeric, total numeric, unit_cost numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 with o as materialized(select * from erp_home.biz_orders(p_from,p_to,p_statuses)),
  c as materialized(select null::uuid product_id)
 select o.id,o.day,o.contact_id,o.channel,o.seller,coalesce(i.product_id::text,'d:'||lower(coalesce(erp_home.biz_text(i.data->>'description',200),''))),i.product_id,
  coalesce(erp_home.biz_text(r.code,60),erp_home.biz_text(i.product_snapshot->>'code',60)),
  coalesce(erp_home.biz_text(i.data->>'description',200),erp_home.biz_text(r.name,200),'Item sem descrição'),erp_home.biz_text(p.brand,100),
  -- 374: the cost applied on the operation (frozen at the commercial confirmation), else the cost of the cadastro at the order date
  -- (product_cost_history), else the last purchase up to that date. The current cost is never used for an old sale.
  i.quantity,i.total,case when i.product_id is null then null else coalesce((select a.unit_cost from erp_documents.item_cost_applied a where a.item_id=i.id),
   erp_catalog.product_cost_at(i.product_id,o.day),erp_documents.report_last_purchase_until(i.product_id,o.day,false)) end
 from o join erp_documents.item i on i.document_id=o.id left join c on c.product_id=i.product_id
 left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
$function$;

-- ---------------------------------------------------------------- Margem por pedido: frete cobrado e frete pago
CREATE OR REPLACE FUNCTION public.erp_home_business_margin(p_user_id uuid, p_statuses jsonb, p_from date, p_to date, p_tab text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_role text;v_s text[];
begin
 v_role:=erp_home.biz_role(p_user_id);
 if not erp_home.biz_cost_visible(v_role) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if p_tab is null or p_tab not in('todos','lucro','prejuizo') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_envelope('margem-pedido',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'tab',p_tab))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s)),
    -- 374: frete cobrado do cliente (o.freight, in the total) and frete pago pela empresa (erp_documents.freight_paid, a cost; pending when not informed).
    c as materialized(select o.*,x.cost,coalesce(x.missing,false) missing,o.total-o.freight revenue,erp_home.biz_tax(o.total-o.freight) tax,fp.amount freight_paid from o
     left join erp_documents.freight_paid fp on fp.document_id=o.id left join(select document_id,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
     from erp_home.biz_lines(p_from,p_to,v_s) group by document_id) x on x.document_id=o.id),
    k as materialized(select *,case when missing then null else total-coalesce(cost,0)-coalesce(freight_paid,0)-tax end contribution from c)
   select jsonb_build_object(
    'indicators',(select jsonb_build_object('revenue',erp_home.money(sum(total)),'ticket',erp_home.ratio(sum(total),count(*)),'orders',count(*)::integer,'freight_buyer',erp_home.money(sum(freight)),'freight_seller',erp_home.money(coalesce(sum(freight_paid),0)),'freight_paid_pending',(count(*) filter(where freight_paid is null))::integer,
      'cost',erp_home.money(sum(cost) filter(where not missing)),'taxes',erp_home.money(sum(tax)),'fees',null,'contribution',erp_home.money(sum(contribution)),
      'contribution_pct',erp_home.pct(sum(contribution),sum(revenue) filter(where not missing)),'orders_without_cost',(count(*) filter(where missing))::integer) from k),
    'progression',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'revenue',erp_home.money((select sum(revenue) from k where k.day=g.d::date)),
       'contribution',erp_home.money((select sum(contribution) from k where k.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d)),
    'total',(select count(*)::integer from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0),
    'orders',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number::text,'day',to_char(day,'YYYY-MM-DD'),'contact',contact_name,'channel',channel,'total',erp_home.money(total),
       'freight',erp_home.money(freight),'freight_paid',case when freight_paid is null then null else erp_home.money(freight_paid) end,'revenue',erp_home.money(revenue),'cost',case when missing then null else erp_home.money(cost) end,'contribution',case when missing then null else erp_home.money(contribution) end,
       'contribution_pct',case when missing then null else erp_home.pct(contribution,revenue) end) order by day desc,number desc),'[]'::jsonb)
      from(select * from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0 order by day desc,number desc limit 500) x),160000)));
end $function$;

-- ---------------------------------------------------------------- Relatório de vendas: Preço de custo até a data e Custo aplicado
CREATE OR REPLACE FUNCTION erp_documents.report_unit_cost(p_product uuid, p_base text, p_until date, p_balances boolean)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select case when p_product is null then null
  when p_base='cost' then (select d.cost_price from erp_stock.default_supplier(p_product) d limit 1)
  when p_base='last_purchase' then (select l.unit_price from erp_stock.last_purchase(p_product,p_balances) l)
  when p_base='last_purchase_until' and p_until is not null then erp_documents.report_last_purchase_until(p_product,p_until,p_balances)
  -- 374: Preço de custo até a data do pedido (product_cost_history); Custo aplicado falls back to it for items without a frozen cost.
  when p_base in('cost_until','applied') and p_until is not null then erp_catalog.product_cost_at(p_product,p_until) end
$function$;

CREATE OR REPLACE FUNCTION public.erp_document_sales_report(p_user_id uuid, p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_from date; v_to date; v_group text; v_sub text; v_order text; v_date text; v_statuses text[]; v_freight boolean; v_items boolean;
 v_contact uuid; v_product uuid; v_warehouse uuid; v_city text; v_state text; v_without boolean; v_first boolean; v_groups jsonb; v_totals jsonb; v_count bigint; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
 v_seller uuid; v_supplier uuid; v_categories text[]; v_types uuid[]; v_untyped boolean; v_tags uuid[]; v_untagged boolean; v_item_filter boolean;
 v_profit boolean; v_base text; v_balances boolean; v_fiscal boolean;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in
   ('from','to','date_type','group','subgroup','order','statuses','include_freight','contact_id','product_id','warehouse_id','city','state','without_invoice','first_purchase',
    'seller_id','supplier_id','category_ids','contact_type_ids','contact_untyped','tag_ids','untagged','show_profit','profit_base'))
  or exists(select 1 from unnest(array['include_freight','without_invoice','first_purchase','contact_untyped','untagged','show_profit']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'boolean')
  or exists(select 1 from unnest(array['date_type','group','subgroup','order','profit_base']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'string') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(p_filters->'from',true); v_to:=erp_documents.date_value(p_filters->'to',true);
 v_group:=coalesce(p_filters->>'group','contact'); v_sub:=nullif(p_filters->>'subgroup','none'); v_order:=coalesce(p_filters->>'order','name'); v_date:=coalesce(p_filters->>'date_type','date');
 v_freight:=coalesce((p_filters->>'include_freight')::boolean,true); v_without:=coalesce((p_filters->>'without_invoice')::boolean,false); v_first:=coalesce((p_filters->>'first_purchase')::boolean,false);
 v_contact:=erp_documents.uuid_value(p_filters->'contact_id'); v_product:=erp_documents.uuid_value(p_filters->'product_id'); v_warehouse:=erp_documents.uuid_value(p_filters->'warehouse_id');
 v_seller:=erp_documents.uuid_value(p_filters->'seller_id'); v_supplier:=erp_documents.uuid_value(p_filters->'supplier_id');
 v_city:=lower(erp_documents.text_value(p_filters->'city',100)); v_state:=upper(erp_documents.text_value(p_filters->'state',2));
 -- Tipo de contato and Tags: the filter exists when the list is sent; "Sem vínculo" / "Incluir produtos sem classificação" go with it.
 v_types:=erp_documents.report_uuid_list(p_filters->'contact_type_ids',100); v_untyped:=coalesce((p_filters->>'contact_untyped')::boolean,false);
 v_tags:=erp_documents.report_uuid_list(p_filters->'tag_ids',500); v_untagged:=coalesce((p_filters->>'untagged')::boolean,false);
 v_profit:=coalesce((p_filters->>'show_profit')::boolean,false); v_base:=case when v_profit then coalesce(p_filters->>'profit_base','cost') end;
 if (p_filters?'contact_untyped' and v_types is null) or (p_filters?'untagged' and v_tags is null) or (p_filters?'profit_base' and not v_profit)
  or (v_profit and v_base not in('cost','last_purchase','last_purchase_until','cost_until','applied')) then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 if p_filters ? 'statuses' and p_filters->'statuses'<>'null'::jsonb then
  if jsonb_typeof(p_filters->'statuses')<>'array' or jsonb_array_length(p_filters->'statuses') not between 1 and 20
   or exists(select 1 from jsonb_array_elements(p_filters->'statuses') s where jsonb_typeof(s)<>'string' or not (erp_documents.transitions()->'sales_orders')?(s#>>'{}')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  select array_agg(distinct s) into v_statuses from jsonb_array_elements_text(p_filters->'statuses') s;
 end if;
 -- Categorias de receitas e despesas: the chosen categorias and their subcategorias.
 if p_filters ? 'category_ids' and p_filters->'category_ids'<>'null'::jsonb then
  with recursive c as(select x.id from erp_finance.category x where x.id=any(erp_documents.report_uuid_list(p_filters->'category_ids',50)) and x.kind='receivable'
   union select x.id from erp_finance.category x join c on x.parent_id=c.id where x.kind='receivable')
  select coalesce(array_agg(c.id::text),'{}'::text[]) into v_categories from c;
 end if;
 if v_from>v_to or v_to-v_from>731 or v_group not in('contact','product','seller','district') or (v_sub is not null and (v_sub not in('contact','product','seller') or v_sub=v_group))
  or v_order not in('name','amount','items','sales') or v_date not in('date','expected_date','invoice')
  or (v_state is not null and v_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 -- The Brufap notas (and their drafts) are read only by admin and fiscal (113), so only they filter or date by them.
 v_fiscal:=exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal'));
 if (v_without or v_date='invoice') and not v_fiscal then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 -- Cost and purchase prices are purchase data (145): only the readers of pedidos de compra see the lucro.
 if v_profit and not erp_stock.cost_visible(p_user_id) then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 v_balances:=coalesce((erp_stock.settings_dto()->>'consider_balances')::boolean,false);
 v_items:=v_group='product' or coalesce(v_sub,'')='product';
 v_item_filter:=v_product is not null or v_supplier is not null or v_tags is not null;
 with base as materialized(
  select d.id,d.contact_id,d.contact_snapshot,d.body,d.total,coalesce((d.body->>'freight')::numeric,0) freight,
   case when v_base in('last_purchase_until','cost_until','applied') then (d.body->>'date')::date end on_date
  from erp_documents.document d
  where d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   -- 267: only the contacts of the seller of the user (Contato acessível somente ao vendedor vinculado).
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
   and (case v_date when 'expected_date' then d.body->>'expected_date'
     -- Data do faturamento: the first nota of the Brufap linked to the pedido (not deleted, cancelled or denied).
     when 'invoice' then (select min(n.issue_date)::text from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
      where o.document_id=d.id and n.deleted_at is null and n.direction='1' and n.status not in(3,10))
     else d.body->>'date' end) between v_from::text and v_to::text
   and (v_contact is null or d.contact_id=v_contact) and (v_warehouse is null or d.warehouse_id=v_warehouse)
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0) and (v_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=v_state)
   and (v_seller is null or lower(d.body->>'seller_id')=v_seller::text)
   and (v_categories is null or lower(d.body->>'category_id')=any(v_categories))
   and (v_types is null or exists(select 1 from erp_catalog.contact_type_link l where l.contact_id=d.contact_id and l.type_id=any(v_types))
    or (v_untyped and not exists(select 1 from erp_catalog.contact_type_link l where l.contact_id=d.contact_id)))
   and (not v_without or (not exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft')
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
 ), items as materialized(
  -- Produtos, Fornecedor and Tags choose the items; a pedido enters when one of its items is chosen.
  select i.id item_id,i.document_id,i.product_id,i.quantity,i.total,i.data,
   (v_product is null or i.product_id=v_product)
   and (v_supplier is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=i.product_id and s.supplier_id=v_supplier))
   and (v_tags is null or exists(select 1 from erp_catalog.product_tag t where t.record_id=i.product_id and t.tag_id=any(v_tags))
    or (v_untagged and not exists(select 1 from erp_catalog.product_tag t where t.record_id=i.product_id))) chosen
  from erp_documents.item i join base b on b.id=i.document_id
 ), orders as materialized(
  select b.* from base b where not v_item_filter or exists(select 1 from items it where it.document_id=b.id and it.chosen)
 ), prices as materialized(
  select x.product_id,x.on_date,erp_documents.report_unit_cost(x.product_id,v_base,x.on_date,v_balances) price
  from (select distinct it.product_id,o.on_date from items it join orders o on o.id=it.document_id where v_profit and it.product_id is not null) x
 ), priced as materialized(
  select it.document_id,it.product_id,it.quantity,it.total,it.data,it.chosen,it.quantity*coalesce(ac.unit_cost,p.price) cost,(it.product_id is null or coalesce(ac.unit_cost,p.price) is null) costless
  from items it join orders o on o.id=it.document_id left join prices p on v_profit and p.product_id=it.product_id and p.on_date is not distinct from o.on_date
  -- 374: Custo aplicado na operação (frozen at the commercial confirmation), else the cost of the cadastro at the order date.
  left join erp_documents.item_cost_applied ac on v_base='applied' and ac.item_id=it.item_id
 ), lines as materialized(
  -- One row per item when a product dimension is used (value = item total); else one row per pedido (value = total, with or without frete).
  select o.id order_id,o.contact_id,o.contact_snapshot,o.body,pi.product_id,pi.data->>'description' description,pi.data->>'code' code,pi.quantity,pi.total as amount,
   case when v_profit then coalesce(pi.cost,0) end cost,case when v_profit and pi.costless then 1 else 0 end costless
  from orders o join priced pi on pi.document_id=o.id where v_items and pi.chosen
  union all
  select o.id,o.contact_id,o.contact_snapshot,o.body,null,null,null,(select coalesce(sum(pi.quantity),0) from priced pi where pi.document_id=o.id),
   o.total-case when v_freight then 0 else o.freight end,
   case when v_profit then (select coalesce(sum(pi.cost),0) from priced pi where pi.document_id=o.id) end,
   case when v_profit then (select count(*)::integer from priced pi where pi.document_id=o.id and pi.costless) else 0 end
  from orders o where not v_items
 ), keyed as materialized(
  select l.*,
   case v_group when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then erp_documents.report_seller_key(l.body)
    else lower(coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'')) end group_key,
   case v_group when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then erp_documents.report_seller_label(l.body) else coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'Sem bairro') end group_label,
   case v_sub when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then erp_documents.report_seller_key(l.body) end sub_key,
   case v_sub when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then erp_documents.report_seller_label(l.body) end sub_label
  from lines l
 ), subs as (
  select group_key,sub_key,min(sub_label) label,count(distinct order_id) sales,sum(quantity) items,sum(amount) amount,sum(cost) cost from keyed where v_sub is not null group by group_key,sub_key
 ), groups as (
  select k.group_key,min(k.group_label) label,count(distinct k.order_id) sales,sum(k.quantity) items,sum(k.amount) amount,sum(k.cost) cost from keyed k group by k.group_key
 ), ranked as (
  select g.*,row_number() over(order by case when v_order='amount' then g.amount end desc nulls last,case when v_order='items' then g.items end desc nulls last,
   case when v_order='sales' then g.sales end desc nulls last,lower(g.label),g.group_key) position from groups g
 )
 select coalesce(jsonb_agg(jsonb_build_object('key',r.group_key,'label',r.label,'sales',r.sales,'items',r.items::text,'amount',r.amount::numeric(20,2)::text,
   'cost',case when v_profit then round(r.cost,2)::text end,'profit',case when v_profit then (round(r.amount,2)-round(r.cost,2))::text end,
   'subgroups',case when v_sub is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('key',s.sub_key,'label',s.label,'sales',s.sales,'items',s.items::text,'amount',s.amount::numeric(20,2)::text,
     'cost',case when v_profit then round(s.cost,2)::text end,'profit',case when v_profit then (round(s.amount,2)-round(s.cost,2))::text end)
    order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key),'[]'::jsonb)
    -- The 500 first sub groups in the chosen order (not an arbitrary 500).
    from (select * from subs s where s.group_key=r.group_key order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,
     case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key limit 500) s) end) order by r.position) filter(where r.position<=2000),'[]'::jsonb),
  count(*),
  jsonb_build_object('sales',(select count(*) from orders),'items',(select coalesce(sum(quantity),0) from keyed)::text,'amount',(select coalesce(sum(amount),0) from keyed)::numeric(20,2)::text,
   'cost',case when v_profit then (select round(coalesce(sum(cost),0),2) from keyed)::text end,
   'profit',case when v_profit then (select round(coalesce(sum(amount),0),2)-round(coalesce(sum(cost),0),2) from keyed)::text end,
   'items_without_cost',(select coalesce(sum(costless),0) from keyed)::integer)
 into v_groups,v_count,v_totals from ranked r;
 return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'date_type',v_date,'item_values',v_items,'include_freight',v_freight,
  'show_profit',v_profit,'profit_base',v_base,'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $function$;

revoke all on function erp_catalog.product_cost_history_immutable(),erp_catalog.product_cost_capture(),erp_catalog.product_cost_at(uuid,date),
  erp_documents.item_cost_applied_immutable(),erp_documents.cost_apply(uuid),erp_documents.cost_apply_capture(),erp_documents.freight_paid_audit_immutable(),
  erp_documents.freight_paid_view(uuid),erp_home.biz_lines(date,date,text[]),erp_documents.report_unit_cost(uuid,text,date,boolean) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_document_freight_paid_get(uuid,text,uuid)','erp_document_freight_paid_save(uuid,text,uuid,integer,uuid,jsonb)',
    'erp_home_business_margin(uuid,jsonb,date,date,text)','erp_document_sales_report(uuid,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
