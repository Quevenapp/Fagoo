-- Financeiro > Comissões no padrão do Origin (onda C, lane financeiro).
-- Razão de comissões: cada parcela de um pedido de venda ou ordem de serviço lançada pela conferência financeira do
-- documento (017) gera a comissão do vendedor do documento, com a regra, a base e a alíquota do vendedor no momento do
-- lançamento (Cadastros > Vendedores, migração 126, só leitura). A liberação segue a regra do vendedor: parcial (a parcela
-- recebida), integral no faturamento (o lançamento das contas), integral após a primeira ou após a última parcela. As
-- comissões manuais, os outros lançamentos (créditos e débitos) e os pagamentos completam o extrato do vendedor; o
-- pagamento gera o lançamento de caixa na conta de origem ou, com "Gerenciar comissões através de contas à pagar", uma
-- conta a pagar ao vendedor. Nada é escrito no Origin e nenhum documento é alterado.
-- O vendedor do documento é a referência Origin do pedido (Vendedor, 054): o vendedor Origin (origin_sync sellers) aponta o
-- contato, e o contato (erp_catalog.origin) é o do vendedor cadastrado no Brufap. Sem esse vínculo não há comissão.
begin;

-- ---------------------------------------------------------------- Razão
create table erp_finance.commission (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references erp_catalog.seller(id),
  origin text not null check(origin in ('document','manual')),
  posting_id uuid references erp_finance.document_posting(id),
  title_id uuid unique references erp_finance.title(id),
  document_id uuid references erp_documents.document(id),
  position integer check(position between 1 and 120), positions integer check(positions between 1 and 120),
  rule text not null check(rule in ('parcial','faturamento','primeira_parcela','ultima_parcela')),
  parcel_cents bigint not null check(parcel_cents between 0 and 999999999999999),
  base_cents bigint not null check(base_cents between 0 and 999999999999999),
  rate numeric(10,6) not null check(rate between 0 and 100),
  commission_cents bigint not null check(commission_cents between 0 and 999999999999999),
  due_on date not null check(due_on between date '1900-01-01' and date '2100-12-31'),
  credit_on date check(credit_on between date '1900-01-01' and date '2100-12-31'),
  description text not null check(length(description) between 1 and 240 and description!~'[[:cntrl:]]'),
  version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id),
  check((deleted_at is null)=(deleted_by is null)),
  check((origin='document' and posting_id is not null and title_id is not null and document_id is not null and position is not null and positions is not null and credit_on is null and deleted_at is null)
    or (origin='manual' and posting_id is null and title_id is null and document_id is null and position is null and positions is null and credit_on is not null))
);
create index erp_finance_commission_seller on erp_finance.commission(seller_id,created_at,id);
create index erp_finance_commission_posting on erp_finance.commission(posting_id) where posting_id is not null;

-- Outros lançamentos (créditos e débitos) e pagamentos, sempre "Referente ao mês" (primeiro dia do mês).
create table erp_finance.commission_entry (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references erp_catalog.seller(id),
  kind text not null check(kind in ('credit','debit','payment')),
  month date not null check(extract(day from month)=1 and month between date '1900-01-01' and date '2100-12-01'),
  posted_on date not null check(posted_on between date '1900-01-01' and date '2100-12-31'),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
  description text not null check(length(description) between 1 and 240 and description!~'[[:cntrl:]]'),
  category_id uuid references erp_finance.category(id), account_id uuid references erp_finance.account(id),
  cash_entry_id uuid unique references erp_finance.cash_entry(id), title_id uuid unique references erp_finance.title(id),
  version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id),
  check((deleted_at is null)=(deleted_by is null)),
  check((kind='payment' and ((cash_entry_id is null)<>(title_id is null))) or (kind<>'payment' and cash_entry_id is null and title_id is null and category_id is null and account_id is null))
);
create index erp_finance_commission_entry_seller on erp_finance.commission_entry(seller_id,month,id);
do $$ declare t text; begin foreach t in array array['commission','commission_entry'] loop
  execute format('alter table erp_finance.%I enable row level security',t);
  execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

-- The payment by caixa is a lançamento of the extrato with its own origin. It is excluded in Comissões only (the
-- extrato shows it like the other lançamentos and refuses to edit or exclude it there).
alter table erp_finance.cash_entry drop constraint cash_entry_origin_check;
alter table erp_finance.cash_entry add constraint cash_entry_origin_check check(origin in ('manual','adjustment','ledger','import','reconciliation','commission'));
create function erp_finance.owned_entry_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.origin='commission' and current_setting('erp_finance.commission_owner',true) is distinct from 'on'
    and (new.account_id,new.kind,new.amount_cents,new.posted_on,new.deleted_at is null,new.note) is distinct from (old.account_id,old.kind,old.amount_cents,old.posted_on,old.deleted_at is null,old.note) then
    raise exception 'erp_finance_entry_owned' using errcode='40001'; end if;
  return new;
end $$;
create trigger owned_entry_guard before update on erp_finance.cash_entry for each row execute function erp_finance.owned_entry_guard();

-- ---------------------------------------------------------------- Vendedor e base do documento
-- Vendedor Origin do documento -> contato Origin do vendedor -> contato do Brufap -> vendedor do Brufap.
create function erp_finance.commission_seller(p_reference jsonb)
returns uuid language sql stable set search_path=pg_catalog as $$
  select s.id from origin_sync.raw_record r
    join erp_catalog.origin o on o.entity='contacts' and o.source_id=(r.payload#>>'{contato,id}')
    join erp_catalog.seller s on s.contact_id=o.record_id
  where jsonb_typeof(p_reference)='object' and p_reference->>'system'='origin' and r.entity='sellers' and r.source_id=(p_reference->>'source_id')
  order by s.id limit 1;
$$;
-- Base de comissão (Preferências > Vendas "Adicionais da base de comissão"): os itens com os descontos de cada item;
-- Desconto subtrai o desconto do pedido e Frete soma o frete. ICMS ST, IPI e taxas de pagamento não existem no pedido do
-- Brufap (nada a somar ou subtrair). Comissão média: a alíquota fixa do vendedor, ou a de cada item pela faixa do seu
-- desconto (Desconto de até %), ponderada pelo valor dos itens.
create function erp_finance.commission_document(p_document uuid,p_seller uuid,out base_cents bigint,out weighted numeric,out items_cents bigint,out rule text)
language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document; s erp_catalog.seller; v_extra jsonb:=coalesce(erp_preferences.get('vendas.base_comissao'),'[]'::jsonb); v_base numeric;
begin
  select * into d from erp_documents.document where id=p_document; select * into s from erp_catalog.seller where id=p_seller;
  select coalesce(sum(round(i.total*100)),0)::bigint,coalesce(sum(round(i.total*100)*case when s.commission_mode='fixa' then coalesce(s.commission_rate,0)
      else coalesce((select (b->>'rate')::numeric from jsonb_array_elements(s.commission_bands) b where i.discount_percent<=(b->>'discount_up_to')::numeric
        order by (b->>'discount_up_to')::numeric limit 1),0) end),0)
    into items_cents,weighted from erp_documents.item i where i.document_id=d.id;
  v_base:=items_cents;
  if jsonb_typeof(v_extra)='array' and v_extra?'desconto' then v_base:=v_base-round(coalesce(nullif(d.body#>>'{totals,discount}','')::numeric,0)*100); end if;
  if jsonb_typeof(v_extra)='array' and v_extra?'frete' then v_base:=v_base+round(coalesce(nullif(d.body#>>'{totals,freight}','')::numeric,0)*100); end if;
  base_cents:=greatest(v_base,0)::bigint; rule:=s.commission_rule;
end $$;

-- One parcela of a posting: its share of the base and of the commission of the document (cumulative rounding, so the
-- parcelas add up exactly to the document).
create function erp_finance.commission_capture_title(p_title uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare l erp_finance.document_title; p erp_finance.document_posting; d erp_documents.document; t erp_finance.title; v_seller uuid; v_calc record;
  v_total bigint; v_before bigint; v_upto bigint; v_n integer; v_commission numeric; v_id uuid;
begin
  select * into l from erp_finance.document_title where title_id=p_title;
  select * into p from erp_finance.document_posting where id=l.posting_id;
  if p.id is null or p.state<>'active' or coalesce(p.snapshot->>'kind','') not in ('sales_orders','service_orders') then return null; end if;
  if exists(select 1 from erp_finance.commission where title_id=p_title) then return null; end if;
  select * into d from erp_documents.document where id=p.document_id;
  v_seller:=erp_finance.commission_seller(d.body#>'{commercial,seller_reference}');
  if v_seller is null then return null; end if;
  select * into v_calc from erp_finance.commission_document(d.id,v_seller);
  if v_calc.items_cents<=0 or v_calc.weighted<=0 then return null; end if;
  v_total:=(p.snapshot->>'total_cents')::bigint;
  if v_total is null or v_total<=0 then return null; end if;
  select coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<l.position),0),
      coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<=l.position),0),count(*)
    into v_before,v_upto,v_n from jsonb_array_elements(p.snapshot->'installments') x;
  v_commission:=round(v_calc.base_cents::numeric*v_calc.weighted/(v_calc.items_cents::numeric*100));
  select * into t from erp_finance.title where id=p_title;
  insert into erp_finance.commission(seller_id,origin,posting_id,title_id,document_id,position,positions,rule,parcel_cents,base_cents,rate,commission_cents,due_on,description,actor,command_id)
    values(v_seller,'document',p.id,t.id,d.id,l.position,v_n,v_calc.rule,t.amount_cents,
      (round(v_calc.base_cents::numeric*v_upto/v_total)-round(v_calc.base_cents::numeric*v_before/v_total))::bigint,
      round(v_calc.weighted/v_calc.items_cents,6),(round(v_commission*v_upto/v_total)-round(v_commission*v_before/v_total))::bigint,t.due_on,
      left(format('%s nº %s · parcela %s/%s',case d.kind when 'sales_orders' then 'Pedido de venda' else 'Ordem de serviço' end,d.number,l.position,v_n),240),p.actor,p.command_id)
    returning id into v_id;
  return v_id;
end $$;
-- The posting (017) links each conta to the document: the commission is captured in the same transaction. A seller rule
-- the base cannot apply (a value out of range) leaves the parcela without commission instead of refusing the posting.
create function erp_finance.commission_capture()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  begin perform erp_finance.commission_capture_title(new.title_id);
  exception when data_exception or check_violation then null; end;
  return null;
end $$;
create trigger commission_capture after insert on erp_finance.document_title for each row execute function erp_finance.commission_capture();
-- Contas already lançadas (active postings) get their commission now, with the rules of today. As in the trigger, a
-- parcela whose seller rule the base cannot apply stays without commission instead of stopping the migration.
do $$ declare v uuid; begin
  for v in select l.title_id from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id
    where p.state='active' order by p.created_at,l.position loop
    begin perform erp_finance.commission_capture_title(v);
    exception when data_exception or check_violation then null; end;
  end loop;
end $$;

-- ---------------------------------------------------------------- Situação
-- Each commission with the day it was released (liberada) and whether its conta was cancelled or excluded (anulada).
-- A parcela is received when its balance is zero: the day of the latest payment that still counts.
create function erp_finance.commission_rows(p_seller uuid)
returns table(id uuid,seller_id uuid,origin text,rule text,parcel_cents bigint,base_cents bigint,rate numeric,commission_cents bigint,due_on date,description text,
  created_on date,released_on date,void boolean,document_id uuid,document_kind text,document_number bigint,title_id uuid,version integer)
language sql stable set search_path=pg_catalog as $$
  with c as materialized (
    select x.* from erp_finance.commission x where (p_seller is null or x.seller_id=p_seller) and x.deleted_at is null
  ), done as materialized (
    select l.posting_id,l.position,t.id title_id,(t.cancelled or t.deleted_at is not null) gone,
      case when not t.cancelled and t.deleted_at is null and t.settled_cents=t.amount_cents then
        (select max(s.posted_on) from erp_finance.settlement s where s.title_id=t.id and s.kind='payment' and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)) end paid_on
    from erp_finance.document_title l join erp_finance.title t on t.id=l.title_id where l.posting_id in (select posting_id from c where posting_id is not null)
  )
  select c.id,c.seller_id,c.origin,c.rule,c.parcel_cents,c.base_cents,c.rate,c.commission_cents,c.due_on,c.description,
    case when c.origin='manual' then c.credit_on else (p.created_at at time zone 'America/Sao_Paulo')::date end,
    case when c.origin='manual' then c.credit_on
      when c.rule='faturamento' then (p.created_at at time zone 'America/Sao_Paulo')::date
      when c.rule='parcial' then (select x.paid_on from done x where x.title_id=c.title_id)
      when c.rule='primeira_parcela' then (select x.paid_on from done x where x.posting_id=c.posting_id and x.position=1)
      else (select case when bool_and(x.paid_on is not null) then max(x.paid_on) end from done x where x.posting_id=c.posting_id and not x.gone) end,
    c.origin='document' and (coalesce((select x.gone from done x where x.title_id=c.title_id),true) or p.state<>'active'),
    c.document_id,d.kind,d.number,c.title_id,c.version
  from c left join erp_finance.document_posting p on p.id=c.posting_id left join erp_documents.document d on d.id=c.document_id;
$$;
-- A payment counts while its lançamento de caixa or its conta a pagar exists.
create function erp_finance.commission_entry_counts(p_entry erp_finance.commission_entry)
returns boolean language sql stable set search_path=pg_catalog as $$
  select p_entry.deleted_at is null and (p_entry.kind<>'payment'
    or exists(select 1 from erp_finance.cash_entry x where x.id=p_entry.cash_entry_id and x.deleted_at is null)
    or exists(select 1 from erp_finance.title t where t.id=p_entry.title_id and not t.cancelled and t.deleted_at is null));
$$;
create function erp_finance.commission_entry_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',e.id,'seller_id',e.seller_id,'kind',e.kind,'month',e.month,'posted_on',e.posted_on,'amount_cents',e.amount_cents::text,'description',e.description,
    'category_id',e.category_id,'account_id',e.account_id,'account_name',left(a.name,200),'source',case when e.cash_entry_id is not null then 'cash' when e.title_id is not null then 'payable' end,
    'title_id',e.title_id,'counts',erp_finance.commission_entry_counts(e),'deleted',e.deleted_at is not null,'version',e.version,'created_at',e.created_at)
  from erp_finance.commission_entry e left join erp_finance.account a on a.id=e.account_id where e.id=p_id;
$$;
create function erp_finance.commission_seller_view(p_seller uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',s.id,'contact_id',s.contact_id,'name',r.name,'code',r.code,
    'situation',erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id))),
    'rule',s.commission_rule,'mode',s.commission_mode,'rate',s.commission_rate::text)
  from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id left join erp_catalog.contact_profile cp on cp.record_id=s.contact_id where s.id=p_seller;
$$;
create function erp_finance.commission_seller_visible(p_user uuid,p_seller uuid)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_scope uuid:=erp_catalog.contact_scope(p_user);
begin
  if p_seller is null or not exists(select 1 from erp_catalog.seller where id=p_seller) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  -- "Contato acessível somente ao vendedor vinculado": a user linked to a seller sees only that seller.
  if v_scope is not null and v_scope<>p_seller then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
end $$;

-- ---------------------------------------------------------------- Listagem (Comissões)
-- Mês base (Este mês por padrão): Vendedor, Faturado, Saldo ant., (+)Comis. mês, (+)Out. créditos, (-)Out. débitos, (-)Pgtos,
-- (*)Comis. pend. e (=)Saldo, com a linha Total de todo o filtro. Situação: Todos | Ativos | Inativos | Sem movimentos
-- (situação do contato do vendedor; excluídos nunca aparecem). Sem "Listar vendedores sem movimentações", só os vendedores
-- com algum valor no mês.
create function public.erp_finance_commission_page(p_user_id uuid,p_month date,p_situation text default 'all',p_with_idle boolean default false,p_query text default null,
  p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_query text:=lower(nullif(btrim(p_query),'')); v_scope uuid; v_total bigint; v_items jsonb; v_totals jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_month is null or extract(day from p_month)<>1 or p_month not between date '1900-01-01' and date '2100-12-01' or p_situation is null or p_situation not in ('all','A','I','S')
    or p_with_idle is null or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  v_from:=p_month; v_to:=(p_month+interval '1 month')::date-1; v_scope:=erp_catalog.contact_scope(p_user_id);
  with sellers as materialized (
    select s.id,r.name,erp_catalog.contact_situation(r.active,coalesce(cp.situation,erp_catalog.contact_source_situation(r.id))) situation
    from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id left join erp_catalog.contact_profile cp on cp.record_id=s.contact_id
    where (v_scope is null or s.id=v_scope) and (v_query is null or strpos(lower(concat_ws(' ',r.name,r.code)),v_query)>0)
  ), picked as materialized (select * from sellers where situation<>'E' and (p_situation='all' or situation=p_situation)
  ), rows as materialized (select x.* from erp_finance.commission_rows(null) x where x.seller_id in (select id from picked) and not x.void
  ), entries as materialized (select e.seller_id,e.kind,e.month,e.amount_cents from erp_finance.commission_entry e where e.seller_id in (select id from picked) and erp_finance.commission_entry_counts(e)
  ), sums as materialized (
    select s.id,s.name,s.situation,
      coalesce((select sum(r.parcel_cents) from rows r where r.seller_id=s.id and r.released_on between v_from and v_to),0) billed,
      coalesce((select sum(r.commission_cents) from rows r where r.seller_id=s.id and r.released_on<v_from),0)
        +coalesce((select sum(case e.kind when 'credit' then e.amount_cents else -e.amount_cents end) from entries e where e.seller_id=s.id and e.month<v_from),0) previous,
      coalesce((select sum(r.commission_cents) from rows r where r.seller_id=s.id and r.released_on between v_from and v_to),0) month_commission,
      coalesce((select sum(e.amount_cents) from entries e where e.seller_id=s.id and e.kind='credit' and e.month=v_from),0) credits,
      coalesce((select sum(e.amount_cents) from entries e where e.seller_id=s.id and e.kind='debit' and e.month=v_from),0) debits,
      coalesce((select sum(e.amount_cents) from entries e where e.seller_id=s.id and e.kind='payment' and e.month=v_from),0) payments,
      coalesce((select sum(r.commission_cents) from rows r where r.seller_id=s.id and r.created_on<=v_to and (r.released_on is null or r.released_on>v_to)),0) pending
    from picked s
  ), shown as materialized (
    select x.*,x.previous+x.month_commission+x.credits-x.debits-x.payments balance from sums x
    where p_with_idle or x.billed<>0 or x.previous<>0 or x.month_commission<>0 or x.credits<>0 or x.debits<>0 or x.payments<>0 or x.pending<>0
  )
  select (select count(*) from shown),
    (select coalesce(jsonb_agg(jsonb_build_object('seller_id',x.id,'name',x.name,'situation',x.situation,'billed_cents',x.billed::text,'previous_cents',x.previous::text,
      'commission_cents',x.month_commission::text,'credit_cents',x.credits::text,'debit_cents',x.debits::text,'payment_cents',x.payments::text,'pending_cents',x.pending::text,
      'balance_cents',x.balance::text) order by lower(x.name),x.id),'[]'::jsonb) from (select * from shown order by lower(name),id limit p_limit offset (p_page-1)*p_limit) x),
    (select jsonb_build_object('billed_cents',coalesce(sum(billed),0)::text,'previous_cents',coalesce(sum(previous),0)::text,'commission_cents',coalesce(sum(month_commission),0)::text,
      'credit_cents',coalesce(sum(credits),0)::text,'debit_cents',coalesce(sum(debits),0)::text,'payment_cents',coalesce(sum(payments),0)::text,'pending_cents',coalesce(sum(pending),0)::text,
      'balance_cents',coalesce(sum(balance),0)::text) from shown)
    into v_total,v_items,v_totals;
  return jsonb_build_object('entity','commissions','month',to_char(p_month,'YYYY-MM'),'situation',p_situation,'with_idle',p_with_idle,'page',p_page,'limit',p_limit,'total',v_total,
    'items',v_items,'totals',v_totals,'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Extrato do vendedor
-- Comissões do mês, (+) Créditos, (-) Débitos, (-) Pagamentos efetuados, Comissões ainda pendentes e o Resumo; cada seção
-- mostra até 500 linhas e o total de todas.
create function public.erp_finance_commission_statement(p_user_id uuid,p_seller uuid,p_month date)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_result jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_month is null or extract(day from p_month)<>1 or p_month not between date '1900-01-01' and date '2100-12-01' then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  perform erp_finance.commission_seller_visible(p_user_id,p_seller);
  v_from:=p_month; v_to:=(p_month+interval '1 month')::date-1;
  with rows as materialized (select x.* from erp_finance.commission_rows(p_seller) x where not x.void
  ), entries as materialized (select e.*,erp_finance.commission_entry_counts(e) counts from erp_finance.commission_entry e where e.seller_id=p_seller and e.deleted_at is null
  ), month_rows as materialized (select * from rows where released_on between v_from and v_to
  ), pending as materialized (select * from rows where created_on<=v_to and (released_on is null or released_on>v_to)
  ), totals as (
    select coalesce((select sum(commission_cents) from rows where released_on<v_from),0)
        +coalesce((select sum(case kind when 'credit' then amount_cents else -amount_cents end) from entries where counts and month<v_from),0) previous,
      coalesce((select sum(commission_cents) from month_rows),0) commissions,
      coalesce((select sum(amount_cents) from entries where counts and kind='credit' and month=v_from),0) credits,
      coalesce((select sum(amount_cents) from entries where counts and kind='debit' and month=v_from),0) debits,
      coalesce((select sum(amount_cents) from entries where counts and kind='payment' and month=v_from),0) payments,
      coalesce((select sum(commission_cents) from pending),0) pending
  )
  select jsonb_build_object('entity','commission_statement','seller',erp_finance.commission_seller_view(p_seller),'month',to_char(p_month,'YYYY-MM'),
    'commissions',jsonb_build_object('total',(select count(*) from month_rows),'parcel_cents',(select coalesce(sum(parcel_cents),0)::text from month_rows),
      'base_cents',(select coalesce(sum(base_cents),0)::text from month_rows),'commission_cents',(select coalesce(sum(commission_cents),0)::text from month_rows),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'origin',r.origin,'day',r.released_on,'description',r.description,'parcel_cents',r.parcel_cents::text,'base_cents',r.base_cents::text,
        'rate',to_char(r.rate,'FM990.00'),'commission_cents',r.commission_cents::text,'document',case when r.document_id is null then null else jsonb_build_object('id',r.document_id,'kind',r.document_kind,'number',r.document_number::text) end,
        'title_id',r.title_id,'version',r.version) order by r.released_on,r.description,r.id),'[]'::jsonb) from (select * from month_rows order by released_on,description,id limit 500) r)),
    'credits',(select jsonb_build_object('total',count(*),'amount_cents',coalesce(sum(amount_cents),0)::text,'items',coalesce((select jsonb_agg(erp_finance.commission_entry_view(y.id) order by y.posted_on,y.id) from
      (select id,posted_on from entries where counts and kind='credit' and month=v_from order by posted_on,id limit 500) y),'[]'::jsonb)) from entries where counts and kind='credit' and month=v_from),
    'debits',(select jsonb_build_object('total',count(*),'amount_cents',coalesce(sum(amount_cents),0)::text,'items',coalesce((select jsonb_agg(erp_finance.commission_entry_view(y.id) order by y.posted_on,y.id) from
      (select id,posted_on from entries where counts and kind='debit' and month=v_from order by posted_on,id limit 500) y),'[]'::jsonb)) from entries where counts and kind='debit' and month=v_from),
    'payments',(select jsonb_build_object('total',count(*),'amount_cents',coalesce(sum(amount_cents),0)::text,'items',coalesce((select jsonb_agg(erp_finance.commission_entry_view(y.id) order by y.posted_on,y.id) from
      (select id,posted_on from entries where counts and kind='payment' and month=v_from order by posted_on,id limit 500) y),'[]'::jsonb)) from entries where counts and kind='payment' and month=v_from),
    'pending',jsonb_build_object('total',(select count(*) from pending),'commission_cents',(select coalesce(sum(commission_cents),0)::text from pending),
      'items',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'due_on',r.due_on,'description',r.description,'situation',case when r.due_on<v_today then 'overdue' else 'upcoming' end,
        'commission_cents',r.commission_cents::text) order by r.due_on,r.id),'[]'::jsonb) from (select * from pending order by due_on,id limit 500) r)),
    'summary',(select jsonb_build_object('previous_cents',previous::text,'commission_cents',commissions::text,'credit_cents',credits::text,'debit_cents',debits::text,'payment_cents',payments::text,
      'pending_cents',pending::text,'balance_cents',(previous+commissions+credits-debits-payments)::text) from totals),
    'payable',coalesce(erp_preferences.get('financas.comissoes_contas_pagar'),'false'::jsonb)='true'::jsonb,'data_mode','erp_native') into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------- Pagamento, Outro lançamento, Comissão manual e exclusões
create function public.erp_finance_commission_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_seller uuid; v_contact uuid; v_month date; v_day date; v_amount bigint; v_text text;
  v_account erp_finance.account%rowtype; v_category uuid; v_entry erp_finance.cash_entry%rowtype; v_title uuid; v_id uuid; v_kind text; v_rate numeric; v_due date; v_credit date;
  v_row erp_finance.commission_entry%rowtype; v_commission erp_finance.commission%rowtype; v_payable boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('commission_payment','commission_entry','commission_manual','commission_delete') then raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action in ('commission_payment','commission_entry') then
    perform erp_finance.keys(p_data,case p_action when 'commission_payment' then array['seller_id','month','posted_on','category_id','account_id','amount_cents','description']
      else array['seller_id','month','posted_on','amount_cents','kind','description'] end);
    v_seller:=erp_finance.uuid_value(p_data->'seller_id'); perform erp_finance.commission_seller_visible(p_user_id,v_seller);
    v_month:=erp_finance.day(p_data->'month'); if extract(day from v_month)<>1 or v_month>date '2100-12-01' then raise exception 'erp_finance_invalid_date' using errcode='22023'; end if;
    v_day:=erp_finance.day(p_data->'posted_on'); v_amount:=erp_finance.cents(p_data->'amount_cents',false); v_text:=erp_finance.cash_text(p_data,'description',240,true);
    if v_text~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('erp_finance.commission:'||v_seller::text,0));
    if p_action='commission_entry' then
      v_kind:=erp_finance.txt(p_data,'kind',10,true); if v_kind not in ('credit','debit') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      insert into erp_finance.commission_entry(seller_id,kind,month,posted_on,amount_cents,description,actor,command_id)
        values(v_seller,v_kind,v_month,v_day,v_amount,v_text,p_user_id,p_command_id) returning id into v_id;
    else
      select s.contact_id into v_contact from erp_catalog.seller s where s.id=v_seller;
      v_payable:=coalesce(erp_preferences.get('financas.comissoes_contas_pagar'),'false'::jsonb)='true'::jsonb;
      v_id:=gen_random_uuid();
      if v_payable then
        -- "Gerenciar comissões através de contas à pagar": a conta a pagar to the seller, due on the Data operação.
        v_category:=erp_finance.cash_category(p_data->'category_id','payable');
        insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents,competence_on,account_id)
          values(gen_random_uuid(),1,1,'payable',v_contact,v_category,v_text,v_day,v_day,v_amount,v_day,erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false)))
          returning id into v_title;
        insert into erp_finance.commission_entry(id,seller_id,kind,month,posted_on,amount_cents,description,category_id,account_id,title_id,actor,command_id)
          values(v_id,v_seller,'payment',v_month,v_day,v_amount,v_text,v_category,erp_finance.uuid_value(p_data->'account_id',false),v_title,p_user_id,p_command_id);
      else
        -- The lançamento de caixa (saída) in the Conta origem, with the seller as contact.
        v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
        v_category:=erp_finance.cash_category(p_data->'category_id','payable');
        insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,contact_id,note,origin,source_key,actor,command_id)
          values(v_account.id,'out',v_amount,v_day,v_day,(select r.id from erp_catalog.record r where r.id=v_contact and r.active),v_text,'commission','commission:'||v_id::text,p_user_id,p_command_id)
          returning * into v_entry;
        perform erp_finance.cash_post(v_entry,v_category,p_user_id,p_command_id);
        update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
        insert into erp_finance.commission_entry(id,seller_id,kind,month,posted_on,amount_cents,description,category_id,account_id,cash_entry_id,actor,command_id)
          values(v_id,v_seller,'payment',v_month,v_day,v_amount,v_text,v_category,v_account.id,v_entry.id,p_user_id,p_command_id);
      end if;
    end if;
    v_result:=jsonb_build_object('entity','commission_entries','record',erp_finance.commission_entry_view(v_id));

  elsif p_action='commission_manual' then
    -- Comissão manual: Data vencimento, Data crédito (liberação) e Valor parcela, com a alíquota do vendedor ou a informada.
    perform erp_finance.keys(p_data,array['seller_id','due_on','credit_on','parcel_cents','rate','description']);
    v_seller:=erp_finance.uuid_value(p_data->'seller_id'); perform erp_finance.commission_seller_visible(p_user_id,v_seller);
    v_due:=erp_finance.day(p_data->'due_on'); v_credit:=erp_finance.day(p_data->'credit_on'); v_amount:=erp_finance.cents(p_data->'parcel_cents',false);
    if p_data?'rate' and p_data->'rate'<>'null'::jsonb then
      if jsonb_typeof(p_data->'rate')<>'string' or (p_data->>'rate')!~'^(0|[1-9][0-9]?|100)(\.[0-9]{1,4})?$' or (p_data->>'rate')::numeric>100 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_rate:=(p_data->>'rate')::numeric;
    else select commission_rate into v_rate from erp_catalog.seller where id=v_seller; end if;
    if v_rate is null or v_rate<=0 or round(v_amount*v_rate/100)<1 then raise exception 'erp_finance_commission_rate_required' using errcode='22023'; end if;
    v_text:=coalesce(erp_finance.cash_text(p_data,'description',240,false),'Comissão manual');
    if v_text~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('erp_finance.commission:'||v_seller::text,0));
    insert into erp_finance.commission(seller_id,origin,rule,parcel_cents,base_cents,rate,commission_cents,due_on,credit_on,description,actor,command_id)
      values(v_seller,'manual',(select commission_rule from erp_catalog.seller where id=v_seller),v_amount,v_amount,v_rate,round(v_amount*v_rate/100)::bigint,v_due,v_credit,v_text,p_user_id,p_command_id)
      returning * into v_commission;
    v_result:=jsonb_build_object('entity','commissions','record',jsonb_build_object('id',v_commission.id,'seller_id',v_seller,'origin','manual','due_on',v_due,'credit_on',v_credit,
      'parcel_cents',v_amount::text,'rate',to_char(v_rate,'FM990.00'),'commission_cents',v_commission.commission_cents::text,'description',v_text,'version',1,'deleted',false));

  else
    -- Excluir: uma comissão manual, um outro lançamento ou um pagamento por caixa (o lançamento de caixa é desfeito na
    -- mesma data). Pagamento por conta a pagar é excluído em Contas a pagar.
    perform erp_finance.keys(p_data,array['target','id','expected_version']);
    v_kind:=erp_finance.txt(p_data,'target',20,true); v_id:=erp_finance.uuid_value(p_data->'id');
    if v_kind='commission' then
      select * into v_commission from erp_finance.commission where id=v_id;
      if not found or v_commission.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      perform erp_finance.commission_seller_visible(p_user_id,v_commission.seller_id);
      perform pg_advisory_xact_lock(hashtextextended('erp_finance.commission:'||v_commission.seller_id::text,0));
      select * into v_commission from erp_finance.commission where id=v_id for update;
      if v_commission.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_commission.origin<>'manual' or v_commission.deleted_at is not null then raise exception 'erp_finance_commission_locked' using errcode='40001'; end if;
      v_before:=to_jsonb(v_commission)-'actor'-'command_id'-'deleted_by';
      update erp_finance.commission set deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1 where id=v_id;
      v_result:=jsonb_build_object('entity','commissions','record',jsonb_build_object('id',v_id,'deleted',true));
    elsif v_kind='entry' then
      select * into v_row from erp_finance.commission_entry where id=v_id;
      if not found or v_row.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      perform erp_finance.commission_seller_visible(p_user_id,v_row.seller_id);
      if v_row.title_id is not null then raise exception 'erp_finance_commission_payment_title' using errcode='40001'; end if;
      -- The seller first, as the Pagamento (which locks the seller and then the Conta origem); then the lock order of every
      -- cash writer: the account, then the lançamento.
      perform pg_advisory_xact_lock(hashtextextended('erp_finance.commission:'||v_row.seller_id::text,0));
      if v_row.account_id is not null then perform 1 from erp_finance.account where id=v_row.account_id for update; end if;
      select * into v_row from erp_finance.commission_entry where id=v_id for update;
      if v_row.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_row.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      v_before:=erp_finance.commission_entry_view(v_id);
      if v_row.cash_entry_id is not null then
        select * into v_entry from erp_finance.cash_entry where id=v_row.cash_entry_id for update;
        if v_entry.deleted_at is null then
          perform set_config('erp_finance.commission_owner','on',true);
          perform erp_finance.cash_compensate(v_entry.id,p_user_id,p_command_id);
          update erp_finance.cash_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note='Pagamento de comissão excluído',version=version+1,updated_at=clock_timestamp() where id=v_entry.id;
          perform set_config('erp_finance.commission_owner','',true);
          update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_entry.account_id;
        end if;
      end if;
      update erp_finance.commission_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1 where id=v_id;
      v_result:=jsonb_build_object('entity','commission_entries','record',erp_finance.commission_entry_view(v_id));
    else raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.owned_entry_guard(),erp_finance.commission_seller(jsonb),erp_finance.commission_document(uuid,uuid),erp_finance.commission_capture_title(uuid),
  erp_finance.commission_capture(),erp_finance.commission_rows(uuid),erp_finance.commission_entry_counts(erp_finance.commission_entry),erp_finance.commission_entry_view(uuid),
  erp_finance.commission_seller_view(uuid),erp_finance.commission_seller_visible(uuid,uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_commission_page(uuid,date,text,boolean,text,integer,integer)','erp_finance_commission_statement(uuid,uuid,date)',
    'erp_finance_commission_execute(uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
