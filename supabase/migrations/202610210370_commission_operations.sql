-- 370: comissão por operação (leva H, lane financeiro: VND-117, PRF-124, VND-310, VND-264).
-- Decisões recomendadas 3.4, adotadas em 21/10/2026:
-- * Percentual por vendedor (Cadastros > Vendedores, 126): alíquota fixa ou por faixa de desconto do item.
-- * Base padrão: itens líquidos após o desconto. Frete, IPI e ICMS-ST destacados ficam fora; a taxa do meio de pagamento não
--   reduz a base. "Adicionais da base de comissão" (vendas.base_comissao) é a política explícita da empresa: o padrão passa a
--   ser ["desconto"]; Frete, ICMS ST e IPI somam e Taxas de pagamento subtrai, só quando marcados.
-- * A comissão é estimada na confirmação comercial (pedido de venda Verificado, Em andamento, Atendido...; OS Aprovada, Em
--   andamento...). A regra do vendedor, a política da base, a base e o percentual ficam congelados na operação
--   (erp_finance.commission_operation): mudar o vendedor ou a preferência depois não altera operações já confirmadas.
-- * Elegível: pela regra congelada do vendedor; na regra parcial, proporcional ao que foi recebido das contas ligadas à venda
--   (lançadas pelo pedido, pela nota do pedido ou pelo faturamento agrupado). Estorno de baixa reduz o recebido e, com ele, o
--   elegível.
-- * Devolução de uma conta (title_return, 281) e cancelamento da venda geram ajustes negativos registrados uma única vez
--   (erp_finance.commission_adjustment); comissões já pagas conservam o histórico (commission_entry não é tocado).
-- * O razão de parcelas de Comissões (171/210) passa a ler a base e o percentual congelados da operação, quando ela existe: uma
--   só fonte para o extrato, a aba Comissões do pedido e o Relatório complementar de comissões.
-- Nenhuma conta, baixa, movimento ou documento é escrito; nada vai para o Origin.
begin;

do $$ declare r record; begin
  for r in select * from (values
    ('erp_finance.commission_document(uuid,uuid)','81f4f216788dd001bedf602a60721b0c273362bcfb09c4cf1b7af9716a0571f3'),
    ('public.erp_document_seller_commission(uuid,text,uuid)','6f4b09c2f9264a9cdd5a7dd920f76f275be223058b373b1606bb50f73ca8d583')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'commission_operations_370_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
  if to_regclass('erp_finance.commission_operation') is not null then raise exception 'commission_operations_370_already_applied' using errcode='55000'; end if;
end $$;

-- ---------------------------------------------------------------- Política da base
update erp_preferences.definition set default_value='["desconto"]'::jsonb where key='vendas.base_comissao';

create function erp_finance.commission_policy()
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('version',1,'base','itens_liquidos','release','regra_do_vendedor',
    'additions',to_jsonb(array(select x from unnest(array['desconto','frete','icms_st','ipi','taxas_pagamento']) x
      where jsonb_typeof(coalesce(erp_preferences.get('vendas.base_comissao'),'["desconto"]'::jsonb))='array'
        and coalesce(erp_preferences.get('vendas.base_comissao'),'["desconto"]'::jsonb)?x)));
$$;
create function erp_finance.commission_confirmed(p_kind text,p_status text)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select coalesce(case p_kind when 'sales_orders' then p_status in ('verified','in_progress','partially_fulfilled','fulfilled','partially_invoiced')
    when 'service_orders' then p_status in ('approved','in_progress','waiting_parts','service_done','finalized') else false end,false);
$$;
create function erp_finance.cents_of(p_value text)
returns bigint language sql immutable set search_path=pg_catalog as $$
  select coalesce(round(case when p_value~'^-?\d{1,15}(\.\d+)?$' then p_value::numeric else 0 end*100),0)::bigint;
$$;

-- Componentes da base de um documento e a base pela política: itens (com o desconto de cada item) menos o desconto do pedido
-- (Desconto), mais frete, ICMS ST e IPI só quando marcados, menos a taxa de comissão das parcelas (Taxas de pagamento).
create function erp_finance.commission_amounts(p_document uuid,p_policy jsonb,out items_cents bigint,out discount_cents bigint,out freight_cents bigint,
  out ipi_cents bigint,out icms_st_cents bigint,out fee_cents bigint,out base_cents bigint)
language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document; v_add jsonb:=coalesce(p_policy->'additions','[]'::jsonb);
begin
  select * into d from erp_documents.document where id=p_document;
  select coalesce(sum(round(i.total*100)),0)::bigint into items_cents from erp_documents.item i where i.document_id=p_document;
  discount_cents:=erp_finance.cents_of(d.body#>>'{totals,discount}'); freight_cents:=erp_finance.cents_of(d.body#>>'{totals,freight}');
  ipi_cents:=erp_finance.cents_of(d.body#>>'{totals,ipi}'); icms_st_cents:=erp_finance.cents_of(d.body#>>'{totals,icms_st}');
  fee_cents:=coalesce((select sum(erp_finance.cents_of(x#>>'{details,commission_fee_amount}')) from jsonb_array_elements(
    case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]'::jsonb end) x),0);
  base_cents:=greatest(items_cents-case when v_add?'desconto' then discount_cents else 0 end+case when v_add?'frete' then freight_cents else 0 end
    +case when v_add?'icms_st' then icms_st_cents else 0 end+case when v_add?'ipi' then ipi_cents else 0 end
    -case when v_add?'taxas_pagamento' then fee_cents else 0 end,0);
end $$;
-- Percentual médio do vendedor sobre os itens (fixo, ou o da faixa do desconto de cada item, ponderado pelo valor do item).
create function erp_finance.commission_weighted(p_document uuid,p_seller uuid,out items_cents bigint,out weighted numeric)
language sql stable set search_path=pg_catalog as $$
  select coalesce(sum(round(i.total*100)),0)::bigint,coalesce(sum(round(i.total*100)*case when s.commission_mode='fixa' then coalesce(s.commission_rate,0)
      else coalesce((select (b->>'rate')::numeric from jsonb_array_elements(s.commission_bands) b where i.discount_percent<=(b->>'discount_up_to')::numeric
        order by (b->>'discount_up_to')::numeric limit 1),0) end),0)
  from erp_catalog.seller s left join erp_documents.item i on i.document_id=p_document where s.id=p_seller group by s.id;
$$;

-- ---------------------------------------------------------------- Registro
create table erp_finance.commission_operation (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references erp_documents.document(id),
  kind text not null check(kind in ('sales_orders','service_orders')),
  seller_id uuid not null references erp_catalog.seller(id),
  state text not null default 'active' check(state in ('active','superseded','cancelled')),
  rule text not null check(rule in ('parcial','faturamento','primeira_parcela','ultima_parcela')),
  policy jsonb not null check(jsonb_typeof(policy)='object' and jsonb_typeof(policy->'additions')='array'),
  items_cents bigint not null check(items_cents between 0 and 999999999999999),
  discount_cents bigint not null check(discount_cents between 0 and 999999999999999),
  freight_cents bigint not null check(freight_cents between 0 and 999999999999999),
  ipi_cents bigint not null check(ipi_cents between 0 and 999999999999999),
  icms_st_cents bigint not null check(icms_st_cents between 0 and 999999999999999),
  fee_cents bigint not null check(fee_cents between 0 and 999999999999999),
  base_cents bigint not null check(base_cents between 0 and 999999999999999),
  rate numeric(10,6) not null check(rate between 0 and 100),
  estimated_cents bigint not null check(estimated_cents between 0 and 999999999999999),
  total_cents bigint not null check(total_cents between 0 and 999999999999999),
  confirmed_status text not null check(length(confirmed_status) between 1 and 40),
  confirmed_on date not null check(confirmed_on between date '1900-01-01' and date '2100-12-31'),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz, ended_reason text check(ended_reason is null or length(ended_reason) between 1 and 80),
  check((state='active')=(ended_at is null))
);
create unique index erp_finance_commission_operation_active on erp_finance.commission_operation(document_id) where state='active';
create index erp_finance_commission_operation_seller on erp_finance.commission_operation(seller_id,confirmed_on,id);
create table erp_finance.commission_adjustment (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references erp_finance.commission_operation(id),
  kind text not null check(kind in ('return','cancel')),
  source_key text not null unique check(length(source_key) between 1 and 120),
  amount_cents bigint not null check(amount_cents between -999999999999999 and 0),
  occurred_on date not null check(occurred_on between date '1900-01-01' and date '2100-12-31'),
  note text not null check(length(note) between 1 and 240 and note!~'[[:cntrl:]]'),
  created_at timestamptz not null default clock_timestamp()
);
create index erp_finance_commission_adjustment_operation on erp_finance.commission_adjustment(operation_id);
alter table erp_finance.commission_operation enable row level security;
alter table erp_finance.commission_adjustment enable row level security;
revoke all on erp_finance.commission_operation,erp_finance.commission_adjustment from public,anon,authenticated,service_role;

-- Frozen: the vendedor, the regra, the política and the percentual never change; only the state ends (and, while no conta
-- exists, the base follows the items of the same operation with the frozen política and percentual). Adjustments are immutable.
create function erp_finance.commission_operation_frozen() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' or new.document_id<>old.document_id or new.kind<>old.kind or new.seller_id<>old.seller_id or new.rule<>old.rule or new.policy<>old.policy
    or new.rate<>old.rate or new.confirmed_on<>old.confirmed_on or new.created_at<>old.created_at or (old.state<>'active' and new is distinct from old) then
    raise exception 'erp_finance_commission_frozen' using errcode='55000'; end if;
  return new;
end $$;
create trigger commission_operation_frozen before update or delete on erp_finance.commission_operation for each row execute function erp_finance.commission_operation_frozen();
create function erp_finance.commission_adjustment_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_finance_commission_frozen' using errcode='55000'; end $$;
create trigger commission_adjustment_immutable before update or delete on erp_finance.commission_adjustment for each row execute function erp_finance.commission_adjustment_immutable();

-- Contas ligadas à venda: as do lançamento do próprio pedido/OS, as das notas geradas dele e as do faturamento agrupado.
create function erp_finance.commission_operation_titles(p_document uuid)
returns table(title_id uuid,title_position integer,effect text) language sql stable set search_path=pg_catalog as $$
  select l.title_id,l.position,'document' from erp_finance.document_posting p join erp_finance.document_title l on l.posting_id=p.id
    where p.document_id=p_document and p.state='active'
  union all
  select l.title_id,l.position,'invoice' from erp_fiscal_invoices.invoice_order o join erp_finance.invoice_posting p on p.invoice_id=o.invoice_id and p.state='active'
    join erp_finance.invoice_title l on l.posting_id=p.id where o.document_id=p_document
  union all
  select l.title_id,l.position,'grouped' from erp_finance.grouped_billing_document g join erp_finance.grouped_billing b on b.id=g.billing_id and b.state='active'
    join erp_finance.grouped_billing_title l on l.billing_id=b.id where g.document_id=p_document and g.active;
$$;

-- Keeps the operation of a document in step with its situation; idempotent (a reprocessed confirmation keeps one operation).
create function erp_finance.commission_operation_sync(p_document uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare d erp_documents.document; o erp_finance.commission_operation; v_seller uuid; v_amounts record; v_weighted record; s erp_catalog.seller;
  v_rate numeric; v_estimated bigint; v_total bigint; v_net bigint; v_id uuid;
begin
  select * into d from erp_documents.document where id=p_document;
  if d.id is null or d.kind not in ('sales_orders','service_orders') then return null; end if;
  select * into o from erp_finance.commission_operation where document_id=d.id and state='active' for update;
  v_seller:=erp_finance.document_seller(d);
  if not erp_finance.commission_confirmed(d.kind,d.status) or v_seller is null or (o.id is not null and o.seller_id<>v_seller) then
    if o.id is not null then
      if d.status='cancelled' then
        select o.estimated_cents+coalesce(sum(a.amount_cents),0) into v_net from erp_finance.commission_adjustment a where a.operation_id=o.id;
        if v_net>0 then
          insert into erp_finance.commission_adjustment(operation_id,kind,source_key,amount_cents,occurred_on,note)
            values(o.id,'cancel','cancel:'||o.id,-v_net,(clock_timestamp() at time zone 'America/Sao_Paulo')::date,'Venda cancelada') on conflict(source_key) do nothing;
        end if;
        update erp_finance.commission_operation set state='cancelled',ended_at=clock_timestamp(),ended_reason='Venda cancelada' where id=o.id;
      else
        update erp_finance.commission_operation set state='superseded',ended_at=clock_timestamp(),
          ended_reason=case when v_seller is distinct from o.seller_id then 'Vendedor alterado' else 'Confirmação desfeita' end where id=o.id;
      end if;
      o:=null;
    end if;
    if not erp_finance.commission_confirmed(d.kind,d.status) or v_seller is null then return null; end if;
  end if;
  v_total:=round(coalesce(d.total,0)*100)::bigint;
  if o.id is not null then
    -- The same operation: the base follows its items only while no conta was lançada, with the frozen política and percentual.
    if o.total_cents=v_total or exists(select 1 from erp_finance.commission_operation_titles(d.id)) then return o.id; end if;
    select * into v_amounts from erp_finance.commission_amounts(d.id,o.policy);
    update erp_finance.commission_operation set items_cents=v_amounts.items_cents,discount_cents=v_amounts.discount_cents,freight_cents=v_amounts.freight_cents,
      ipi_cents=v_amounts.ipi_cents,icms_st_cents=v_amounts.icms_st_cents,fee_cents=v_amounts.fee_cents,base_cents=v_amounts.base_cents,
      estimated_cents=round(v_amounts.base_cents*o.rate/100)::bigint,total_cents=v_total,version=version+1 where id=o.id;
    return o.id;
  end if;
  select * into s from erp_catalog.seller where id=v_seller;
  select * into v_weighted from erp_finance.commission_weighted(d.id,v_seller);
  select * into v_amounts from erp_finance.commission_amounts(d.id,erp_finance.commission_policy());
  if coalesce(v_weighted.items_cents,0)<=0 then return null; end if;
  v_rate:=round(v_weighted.weighted/v_weighted.items_cents,6); v_estimated:=round(v_amounts.base_cents*v_rate/100)::bigint;
  insert into erp_finance.commission_operation(document_id,kind,seller_id,rule,policy,items_cents,discount_cents,freight_cents,ipi_cents,icms_st_cents,fee_cents,
      base_cents,rate,estimated_cents,total_cents,confirmed_status,confirmed_on)
    values(d.id,d.kind,v_seller,coalesce(s.commission_rule,'parcial'),erp_finance.commission_policy(),v_amounts.items_cents,v_amounts.discount_cents,v_amounts.freight_cents,
      v_amounts.ipi_cents,v_amounts.icms_st_cents,v_amounts.fee_cents,v_amounts.base_cents,v_rate,v_estimated,v_total,d.status,
      (clock_timestamp() at time zone 'America/Sao_Paulo')::date)
    returning id into v_id;
  return v_id;
end $$;
-- At commit (the items of a save are written after the document row), so the base sees the final items.
create function erp_finance.commission_operation_capture() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  begin perform erp_finance.commission_operation_sync(new.id);
  exception when data_exception or check_violation then null; end;
  return null;
end $$;
create constraint trigger commission_operation_capture after insert or update on erp_documents.document deferrable initially deferred
  for each row when (new.kind in ('sales_orders','service_orders')) execute function erp_finance.commission_operation_capture();

-- Devolução de uma conta ligada à venda: ajuste proporcional ao valor da conta, uma vez por conta, sem passar do líquido.
create function erp_finance.commission_return_capture() returns trigger language plpgsql set search_path=pg_catalog as $$
declare o erp_finance.commission_operation; t erp_finance.title; v_net bigint; v_amount bigint;
begin
  select * into t from erp_finance.title where id=new.title_id;
  select c.* into o from erp_finance.commission_operation c where c.state in ('active','cancelled') and c.total_cents>0
    and exists(select 1 from erp_finance.commission_operation_titles(c.document_id) x where x.title_id=new.title_id) order by c.created_at desc limit 1;
  if o.id is null then return null; end if;
  select o.estimated_cents+coalesce(sum(a.amount_cents),0) into v_net from erp_finance.commission_adjustment a where a.operation_id=o.id;
  v_amount:=least(round(o.estimated_cents::numeric*t.amount_cents/o.total_cents)::bigint,greatest(v_net,0));
  if v_amount>0 then
    insert into erp_finance.commission_adjustment(operation_id,kind,source_key,amount_cents,occurred_on,note)
      values(o.id,'return','return:'||new.title_id,-v_amount,(new.created_at at time zone 'America/Sao_Paulo')::date,left(coalesce(new.source->>'label','Conta devolvida'),240))
      on conflict(source_key) do nothing;
  end if;
  return null;
end $$;
create trigger commission_return_capture after insert on erp_finance.title_return for each row execute function erp_finance.commission_return_capture();

-- Estimada, ajustada, líquida, recebida e elegível de uma operação.
create function erp_finance.commission_operation_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  with o as (select * from erp_finance.commission_operation where id=p_id),
  adj as (select coalesce(sum(a.amount_cents),0)::bigint adjusted,
    coalesce(jsonb_agg(jsonb_build_object('kind',a.kind,'amount_cents',a.amount_cents::text,'occurred_on',a.occurred_on,'note',a.note) order by a.created_at,a.id),'[]'::jsonb) items
    from erp_finance.commission_adjustment a where a.operation_id=p_id),
  t as (select x.title_position position,x.effect,y.amount_cents,y.settled_cents,y.cancelled,exists(select 1 from erp_finance.title_return r where r.title_id=y.id) returned
    from o cross join lateral erp_finance.commission_operation_titles(o.document_id) x join erp_finance.title y on y.id=x.title_id where y.deleted_at is null),
  sums as (select coalesce(sum(settled_cents),0)::bigint received,count(*) titles,
    coalesce(bool_and(settled_cents=amount_cents) filter (where not cancelled),false) all_paid,
    coalesce(bool_or(position=1 and settled_cents=amount_cents and not cancelled),false) first_paid from t),
  calc as (select o.*,adj.adjusted,adj.items adjustments,greatest(o.estimated_cents+adj.adjusted,0) net,sums.* from o,adj,sums)
  select jsonb_build_object('id',c.id,'document_id',c.document_id,'kind',c.kind,'seller_id',c.seller_id,'state',c.state,'rule',c.rule,'policy',c.policy,
    'items_cents',c.items_cents::text,'discount_cents',c.discount_cents::text,'freight_cents',c.freight_cents::text,'ipi_cents',c.ipi_cents::text,
    'icms_st_cents',c.icms_st_cents::text,'fee_cents',c.fee_cents::text,'base_cents',c.base_cents::text,'rate',c.rate::numeric(10,4)::text,
    'estimated_cents',c.estimated_cents::text,'adjusted_cents',c.adjusted::text,'net_cents',c.net::text,'total_cents',c.total_cents::text,
    'received_cents',c.received::text,'titles',c.titles,
    'eligible_cents',(case when c.state='superseded' then 0 when c.rule='parcial' then least(c.net,case when c.total_cents=0 then 0 else round(c.estimated_cents::numeric*c.received/c.total_cents)::bigint end)
      when c.rule='faturamento' then case when c.titles>0 then c.net else 0 end
      when c.rule='primeira_parcela' then case when c.first_paid then c.net else 0 end
      else case when c.titles>0 and c.all_paid then c.net else 0 end end)::text,
    'adjustments',c.adjustments,'confirmed_status',c.confirmed_status,'confirmed_on',c.confirmed_on,'ended_at',c.ended_at,'ended_reason',c.ended_reason,'version',c.version)
  from calc c;
$$;

-- ---------------------------------------------------------------- Razão de parcelas (171/210) com a operação congelada
CREATE OR REPLACE FUNCTION erp_finance.commission_document(p_document uuid, p_seller uuid, OUT base_cents bigint, OUT weighted numeric, OUT items_cents bigint, OUT rule text)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare o erp_finance.commission_operation; v_weighted record; v_amounts record; s erp_catalog.seller;
begin
  -- 370: the frozen operation of the sale (base, percentual and regra of the commercial confirmation).
  select * into o from erp_finance.commission_operation where document_id=p_document and seller_id=p_seller and state='active';
  if o.id is not null then
    items_cents:=o.items_cents; weighted:=o.rate*o.items_cents; base_cents:=o.base_cents; rule:=o.rule; return;
  end if;
  select * into s from erp_catalog.seller where id=p_seller;
  select * into v_weighted from erp_finance.commission_weighted(p_document,p_seller);
  select * into v_amounts from erp_finance.commission_amounts(p_document,erp_finance.commission_policy());
  items_cents:=coalesce(v_weighted.items_cents,0); weighted:=coalesce(v_weighted.weighted,0); base_cents:=v_amounts.base_cents; rule:=s.commission_rule;
end $function$;

-- ---------------------------------------------------------------- Aba Comissões: todos os adicionais da política
CREATE OR REPLACE FUNCTION public.erp_document_seller_commission(p_user_id uuid, p_kind text, p_seller_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare s erp_catalog.seller;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_seller_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select * into s from erp_catalog.seller where id=p_seller_id;
 if not found then raise exception 'erp_document_seller_unavailable' using errcode='22023'; end if;
 return jsonb_build_object('kind',p_kind,'seller_id',s.id,'mode',s.commission_mode,'rate',case when s.commission_rate is null then null else s.commission_rate::numeric(7,4)::text end,
  'bands',coalesce((select jsonb_agg(jsonb_build_object('discount_up_to',(b->>'discount_up_to')::numeric(7,4)::text,'rate',(b->>'rate')::numeric(7,4)::text)
   order by (b->>'discount_up_to')::numeric) from jsonb_array_elements(s.commission_bands) b),'[]'::jsonb),
  -- 370: every addition of the política (Desconto, Frete, ICMS ST, IPI, Taxas de pagamento).
  'additions',erp_finance.commission_policy()->'additions',
  'data_mode','erp_native','operational_effects',false);
end $function$;

-- The operation of a pedido/OS for the aba Comissões: the frozen values and each item's share of the base (cumulative rounding).
create function public.erp_document_commission_operation(p_user_id uuid,p_kind text,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare o erp_finance.commission_operation; v_items jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_document_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select * into o from erp_finance.commission_operation where document_id=p_document_id and state='active';
 if o.id is not null then
   with i as (select x.position,left(coalesce(x.data->>'description',x.product_snapshot->>'name',''),240) description,round(x.total*100)::bigint cents
       from erp_documents.item x where x.document_id=p_document_id),
     c as (select i.*,sum(cents) over (order by position) upto,sum(cents) over (order by position)-cents before from i)
   select coalesce(jsonb_agg(jsonb_build_object('position',c.position,'description',c.description,'item_cents',c.cents::text,
       'base_cents',(case when o.items_cents=0 then 0 else round(o.base_cents::numeric*c.upto/o.items_cents)-round(o.base_cents::numeric*c.before/o.items_cents) end)::text,
       'commission_cents',(case when o.items_cents=0 then 0 else round(o.estimated_cents::numeric*c.upto/o.items_cents)-round(o.estimated_cents::numeric*c.before/o.items_cents) end)::text)
     order by c.position),'[]'::jsonb) into v_items from c;
 end if;
 return jsonb_build_object('kind',p_kind,'document_id',p_document_id,'operation',case when o.id is null then null else erp_finance.commission_operation_view(o.id) end,
   'items',coalesce(v_items,'[]'::jsonb),'data_mode','erp_native','operational_effects',false);
end $function$;

-- ---------------------------------------------------------------- Relatório complementar de comissões
-- Operações confirmadas no período (Data da confirmação), por vendedor: estimada, ajustada, elegível e, do extrato do vendedor,
-- os pagamentos do período. Mostra a venda, o vendedor, a base, o percentual, as contas ligadas e o recebido, sem recalcular
-- as regras de operações antigas.
create function public.erp_finance_commission_report(p_user_id uuid,p_from date,p_to date,p_seller_id uuid default null,p_state text default 'all',
  p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_scope uuid; v_total bigint; v_items jsonb; v_sellers jsonb; v_totals jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if not erp_access.permitted(p_user_id,'vendas.comissoes') then raise exception 'erp_finance_forbidden' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_to-p_from>366 or p_state is null
    or p_state not in ('all','active','cancelled') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  v_scope:=erp_catalog.contact_scope(p_user_id);
  if p_seller_id is not null then perform erp_finance.commission_seller_visible(p_user_id,p_seller_id); end if;
  with ops as materialized (
    select o.id,o.seller_id,o.confirmed_on,d.kind,d.number,(d.body->>'date') document_date,coalesce(d.contact_snapshot->>'name','') contact_name,erp_finance.commission_operation_view(o.id) v
    from erp_finance.commission_operation o join erp_documents.document d on d.id=o.document_id
    where o.state<>'superseded' and (p_state='all' or o.state=p_state) and o.confirmed_on between p_from and p_to
      and (p_seller_id is null or o.seller_id=p_seller_id) and (v_scope is null or o.seller_id=v_scope)
  ), pays as materialized (
    select e.seller_id,sum(e.amount_cents)::bigint paid from erp_finance.commission_entry e
    where e.kind='payment' and e.posted_on between p_from and p_to and erp_finance.commission_entry_counts(e)
      and (p_seller_id is null or e.seller_id=p_seller_id) and (v_scope is null or e.seller_id=v_scope) group by e.seller_id
  ), per as materialized (
    select s.id seller_id,r.name,coalesce(sum((o.v->>'estimated_cents')::bigint),0)::bigint estimated,coalesce(sum((o.v->>'adjusted_cents')::bigint),0)::bigint adjusted,
      coalesce(sum((o.v->>'eligible_cents')::bigint),0)::bigint eligible,coalesce(max(p.paid),0)::bigint paid,count(o.id) operations
    from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id left join ops o on o.seller_id=s.id left join pays p on p.seller_id=s.id
    where s.id in (select seller_id from ops union select seller_id from pays) group by s.id,r.name
  )
  select (select count(*) from ops),
    (select coalesce(jsonb_agg(x.v||jsonb_build_object('document_number',x.number::text,'document_date',x.document_date,'contact_name',x.contact_name,
        'seller_name',(select name from per where per.seller_id=x.seller_id)) order by x.confirmed_on,x.number,x.id),'[]'::jsonb)
      from (select * from ops order by confirmed_on,number,id limit p_limit offset (p_page-1)*p_limit) x),
    (select coalesce(jsonb_agg(jsonb_build_object('seller_id',seller_id,'name',name,'operations',operations,'estimated_cents',estimated::text,'adjusted_cents',adjusted::text,
        'eligible_cents',eligible::text,'paid_cents',paid::text) order by lower(name),seller_id),'[]'::jsonb) from per),
    (select jsonb_build_object('estimated_cents',coalesce(sum(estimated),0)::text,'adjusted_cents',coalesce(sum(adjusted),0)::text,
        'eligible_cents',coalesce(sum(eligible),0)::text,'paid_cents',coalesce(sum(paid),0)::text) from per)
    into v_total,v_items,v_sellers,v_totals;
  return jsonb_build_object('entity','commission_report','from',p_from,'to',p_to,'seller_id',p_seller_id,'state',p_state,'page',p_page,'limit',p_limit,'total',v_total,
    'items',v_items,'sellers',v_sellers,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $$;

-- Sales already confirmed get their operation now, with the política in force today (their former base is not reconstructed).
do $$ declare v uuid; begin
  for v in select d.id from erp_documents.document d where d.kind in ('sales_orders','service_orders') and erp_finance.commission_confirmed(d.kind,d.status) order by d.created_at,d.id loop
    begin perform erp_finance.commission_operation_sync(v);
    exception when data_exception or check_violation then null; end;
  end loop;
end $$;

revoke all on function erp_finance.commission_policy(),erp_finance.commission_confirmed(text,text),erp_finance.cents_of(text),
  erp_finance.commission_amounts(uuid,jsonb),erp_finance.commission_weighted(uuid,uuid),erp_finance.commission_operation_frozen(),
  erp_finance.commission_adjustment_immutable(),erp_finance.commission_operation_titles(uuid),erp_finance.commission_operation_sync(uuid),
  erp_finance.commission_operation_capture(),erp_finance.commission_return_capture(),erp_finance.commission_operation_view(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_document_commission_operation(uuid,text,uuid)','erp_finance_commission_report(uuid,date,date,uuid,text,integer,integer)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
