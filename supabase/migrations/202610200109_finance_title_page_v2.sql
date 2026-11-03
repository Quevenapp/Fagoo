-- Listagem de contas a receber e a pagar no padrão Origin, segunda versão: "Opção" (Em aberto, Atrasadas, Emitidas,
-- Recebidas/Pagas), conta financeira (portador), várias categorias com "Sem categoria", data de competência,
-- "Em remessa", valor exato e as colunas da listagem customizada (liquidação, taxa, juros, acréscimos, descontos,
-- conta financeira, remessa). Contas excluídas (108) saem da listagem e dos totais. Somente leitura; a 094 fica
-- como estava para quem ainda a chama. Papéis, centavos exatos e a data de São Paulo seguem a 010.
begin;

create index erp_finance_title_kind_competence on erp_finance.title(kind,competence_on,id);

-- Somatórios das baixas efetivas (não estornadas) de um título, para as colunas da listagem.
create function erp_finance.title_payments(p_title uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('settled_on',max(s.posted_on),'fee_cents',coalesce(sum(s.fee_cents),0)::text,'interest_cents',coalesce(sum(s.interest_cents),0)::text,
   'penalty_cents',coalesce(sum(s.penalty_cents),0)::text,'discount_cents',coalesce(sum(s.discount_cents),0)::text,
   'settled_by_return',coalesce(bool_or(exists(select 1 from erp_cnab.operational_settlement o where o.settlement_id=s.id)),false))
 from erp_finance.settlement s
 where s.title_id=p_title and s.kind='payment' and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id);
$$;

create function public.erp_finance_title_page_v2(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,
  p_order text default 'due_asc',p_query text default null,p_option text default 'issued',p_statuses text[] default null,p_date_field text default 'due',
  p_from date default null,p_to date default null,p_account text default null,p_categories text[] default null,p_remittance text default null,
  p_amount_cents bigint default null,p_document text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_query text:=lower(nullif(btrim(p_query),''));
  v_document text:=lower(nullif(btrim(p_document),''));
  v_digits text; v_account uuid; v_no_account boolean:=coalesce(p_account='none',false); v_categories uuid[]; v_no_category boolean:=false;
  v_total bigint; v_amount numeric; v_balance numeric; v_fee numeric; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in ('due_asc','due_desc')
    or length(p_query)>120 or p_query~'[[:cntrl:]]' or length(p_document)>60 or p_document~'[[:cntrl:]]'
    or p_option is null or p_option not in ('open','overdue','issued','settled')
    or p_date_field is null or p_date_field not in ('due','issued','settled','competence')
    -- The Opção fixes the date of the period, as in Origin; only Emitidas chooses it and the Situação.
    or (p_option in ('open','overdue') and p_date_field<>'due') or (p_option='settled' and p_date_field<>'settled')
    or (p_statuses is not null and (p_option<>'issued' or array_ndims(p_statuses) is distinct from 1 or cardinality(p_statuses) not between 1 and 4
      or array_position(p_statuses,null) is not null or not p_statuses<@array['open','partial','paid','cancelled']
      or (select count(distinct s) from unnest(p_statuses) s)<>cardinality(p_statuses)))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_account is not null and not v_no_account and p_account!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 50
      or array_position(p_categories,null) is not null or (select count(distinct lower(c)) from unnest(p_categories) c)<>cardinality(p_categories)
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    or (p_remittance is not null and (p_remittance not in ('yes','no') or p_option<>'open'))
    or p_amount_cents not between 1 and 999999999999999
  then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_account is not null and not v_no_account then v_account:=p_account::uuid; end if;
  if p_categories is not null then
    v_no_category:='none'=any(p_categories);
    select array_agg(c::uuid) into v_categories from unnest(p_categories) c where c<>'none';
  end if;
  if v_query~'^[0-9 ./-]+$' then v_digits:=regexp_replace(v_query,'[^0-9]','','g'); if length(v_digits)<3 then v_digits:=null; end if; end if;

  with filtered as materialized (
    select t.id,t.due_on,t.amount_cents,t.settled_cents,t.cancelled
    from erp_finance.title t
    join erp_catalog.record r on r.id=t.contact_id
    left join erp_catalog.contact c on c.record_id=t.contact_id
    left join erp_finance.document_title l on l.title_id=t.id
    left join erp_finance.document_posting dp on dp.id=l.posting_id
    left join erp_documents.document d on d.id=dp.document_id
    where t.kind=p_kind and t.deleted_at is null
      and (p_option<>'open' or (not t.cancelled and t.settled_cents<t.amount_cents))
      and (p_option<>'overdue' or (not t.cancelled and t.settled_cents<t.amount_cents and t.due_on<v_today))
      and (p_option<>'settled' or exists(select 1 from erp_finance.settlement s where s.title_id=t.id and s.kind='payment'
        and s.posted_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31')
        and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id)))
      and (p_statuses is null
        or ('open'=any(p_statuses) and not t.cancelled and t.settled_cents=0)
        or ('partial'=any(p_statuses) and not t.cancelled and t.settled_cents>0 and t.settled_cents<t.amount_cents)
        or ('paid'=any(p_statuses) and not t.cancelled and t.settled_cents=t.amount_cents)
        or ('cancelled'=any(p_statuses) and t.cancelled))
      and ((p_from is null and p_to is null) or p_date_field='settled' and p_option='settled'
        or (p_date_field='due' and t.due_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='issued' and t.issued_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='competence' and t.competence_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='settled' and exists(select 1 from erp_finance.settlement s where s.title_id=t.id and s.kind='payment'
          and s.posted_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31')
          and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id))))
      and (p_account is null or (v_no_account and t.account_id is null) or t.account_id=v_account)
      and (p_categories is null or (v_no_category and t.category_id is null) or t.category_id=any(v_categories))
      and (p_remittance is null or (p_remittance='yes')=exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id))
      and (p_amount_cents is null or t.amount_cents=p_amount_cents)
      and (v_document is null or strpos(lower(concat_ws(' ',t.source_reference,d.number::text)),v_document)>0)
      and (v_query is null
        or strpos(lower(concat_ws(' ',r.name,c.trade_name,c.email,c.document,t.description,t.source_reference,t.bank_number,d.number::text)),v_query)>0
        or (v_digits is not null and strpos(regexp_replace(coalesce(c.document,''),'[^0-9]','','g'),v_digits)>0))
  ), page as (
    select id,due_on,amount_cents,settled_cents,cancelled from filtered
    order by case when p_order='due_asc' then due_on end asc,case when p_order='due_desc' then due_on end desc,
      case when p_order='due_asc' then id end asc,case when p_order='due_desc' then id end desc
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),(select coalesce(sum(amount_cents),0) from filtered),
    (select coalesce(sum(case when cancelled then 0 else amount_cents-settled_cents end),0) from filtered),
    (select coalesce(sum(s.fee_cents),0) from erp_finance.settlement s join filtered f on f.id=s.title_id
      where s.kind='payment' and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id)),
    (select coalesce(jsonb_agg(erp_finance.dto('titles',p.id)||jsonb_build_object(
        'overdue',not p.cancelled and p.settled_cents<p.amount_cents and p.due_on<v_today,'origin',erp_finance.title_origin(p.id),
        'account_name',(select a.name from erp_finance.account a join erp_finance.title t on t.account_id=a.id where t.id=p.id),
        'remittance',(select jsonb_build_object('id',r.id,'sequence',r.sequence,'state',r.state,'our_number',b.our_number)
          from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.title_id=p.id),
        'payments',erp_finance.title_payments(p.id),
        -- Contas adotadas do Origin (039) ficam com o Origin: não são excluídas no Brufap.
        'imported',exists(select 1 from erp_finance.origin_import_origin o where o.title_id=p.id))
      order by case when p_order='due_asc' then p.due_on end asc,case when p_order='due_desc' then p.due_on end desc,
        case when p_order='due_asc' then p.id end asc,case when p_order='due_desc' then p.id end desc),'[]'::jsonb) from page p)
  into v_total,v_amount,v_balance,v_fee,v_items;

  return jsonb_build_object('entity','titles','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'order',p_order,'option',p_option,
    'total',v_total,'totals',jsonb_build_object('count',v_total,'amount_cents',v_amount::text,'balance_cents',v_balance::text,'fee_cents',v_fee::text),
    'data_mode','erp_native');
end $$;

revoke all on function erp_finance.title_payments(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text) from public,anon,authenticated;
grant execute on function public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text) to service_role;
commit;
