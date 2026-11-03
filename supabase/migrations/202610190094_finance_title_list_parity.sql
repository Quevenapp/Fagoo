-- Contas a receber e a pagar no padrão Origin: página numerada por vencimento, total de registros e
-- somatórios do conjunto filtrado calculados no banco, filtros do painel "Filtrar" e o documento de origem.
-- Somente leitura: nenhuma tabela nova, nenhuma escrita. Papéis, centavos exatos e a data de São Paulo seguem a 010.
-- A listagem por cursor (erp_finance_list) continua igual para cobrança, transferências e categorias.
begin;

-- Ordenação e filtros novos: vencimento já usa erp_finance_title_kind(kind,due_on,id) da 010.
create index erp_finance_title_kind_issued on erp_finance.title(kind,issued_on,id);
create index erp_finance_title_kind_category on erp_finance.title(kind,category_id,due_on,id);
create index erp_finance_settlement_payment_day on erp_finance.settlement(title_id,posted_on) where kind='payment';

-- Documento que gerou o título (pedido de venda, OS ou pedido de compra). Expõe só id, tipo e número.
create function erp_finance.title_origin(p_title uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text)
 from erp_finance.document_title l
 join erp_finance.document_posting p on p.id=l.posting_id
 join erp_documents.document d on d.id=p.document_id
 where l.title_id=p_title;
$$;

-- 010 preservada; títulos passam a trazer "origin" ao lado de "record" (null quando lançado manualmente).
create or replace function public.erp_finance_get(p_user_id uuid,p_entity text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin perform erp_finance.require_access(p_user_id,false); v:=erp_finance.dto(p_entity,p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity',p_entity,'record',v,'data_mode','erp_native')
    ||case when p_entity='titles' then jsonb_build_object('origin',erp_finance.title_origin(p_id)) else '{}'::jsonb end;
end $$;

-- Página numerada (100 por página no Brufap), ordem por vencimento com desempate pelo id e somatórios exatos
-- de todo o conjunto filtrado. Situações combinam por "ou"; os demais filtros por "e".
create function public.erp_finance_title_page(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,
  p_order text default 'due_asc',p_query text default null,p_statuses text[] default null,p_date_field text default 'due',
  p_from date default null,p_to date default null,p_category text default null,p_min_cents bigint default null,
  p_max_cents bigint default null,p_document text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_query text:=lower(nullif(btrim(p_query),''));
  v_document text:=lower(nullif(btrim(p_document),''));
  v_digits text; v_category uuid; v_none boolean:=coalesce(p_category='none',false);
  v_total bigint; v_amount numeric; v_balance numeric; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in ('due_asc','due_desc')
    or length(p_query)>120 or p_query~'[[:cntrl:]]' or length(p_document)>60 or p_document~'[[:cntrl:]]'
    or p_date_field is null or p_date_field not in ('due','issued','settled')
    or (p_statuses is not null and (array_ndims(p_statuses) is distinct from 1 or cardinality(p_statuses) not between 1 and 5
      or array_position(p_statuses,null) is not null or not p_statuses<@array['open','partial','paid','cancelled','overdue']
      or (select count(distinct s) from unnest(p_statuses) s)<>cardinality(p_statuses)))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_category is not null and not v_none and p_category!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or p_min_cents not between 0 and 999999999999999 or p_max_cents not between 0 and 999999999999999 or p_min_cents>p_max_cents
  then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_category is not null and not v_none then v_category:=p_category::uuid; end if;
  -- CPF/CNPJ com ou sem máscara: só dígitos e pontuação de documento, ao menos três dígitos.
  if v_query~'^[0-9 ./-]+$' then v_digits:=regexp_replace(v_query,'[^0-9]','','g'); if length(v_digits)<3 then v_digits:=null; end if; end if;

  with filtered as materialized (
    select t.id,t.due_on,t.amount_cents,t.settled_cents,t.cancelled
    from erp_finance.title t
    join erp_catalog.record r on r.id=t.contact_id
    left join erp_catalog.contact c on c.record_id=t.contact_id
    left join erp_finance.document_title l on l.title_id=t.id
    left join erp_finance.document_posting dp on dp.id=l.posting_id
    left join erp_documents.document d on d.id=dp.document_id
    where t.kind=p_kind
      and (p_statuses is null
        or ('open'=any(p_statuses) and not t.cancelled and t.settled_cents=0)
        or ('partial'=any(p_statuses) and not t.cancelled and t.settled_cents>0 and t.settled_cents<t.amount_cents)
        or ('paid'=any(p_statuses) and not t.cancelled and t.settled_cents=t.amount_cents)
        or ('cancelled'=any(p_statuses) and t.cancelled)
        or ('overdue'=any(p_statuses) and not t.cancelled and t.settled_cents<t.amount_cents and t.due_on<v_today))
      and ((p_from is null and p_to is null)
        or (p_date_field='due' and t.due_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='issued' and t.issued_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='settled' and exists(select 1 from erp_finance.settlement s where s.title_id=t.id and s.kind='payment'
          and s.posted_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31')
          and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id))))
      and (p_category is null or (v_none and t.category_id is null) or t.category_id=v_category)
      and (p_min_cents is null or t.amount_cents>=p_min_cents) and (p_max_cents is null or t.amount_cents<=p_max_cents)
      and (v_document is null or strpos(lower(concat_ws(' ',t.source_reference,d.number::text)),v_document)>0)
      and (v_query is null
        or strpos(lower(concat_ws(' ',r.name,c.trade_name,c.email,c.document,t.description,t.source_reference,d.number::text)),v_query)>0
        or (v_digits is not null and strpos(regexp_replace(coalesce(c.document,''),'[^0-9]','','g'),v_digits)>0))
  ), page as (
    select id,due_on,amount_cents,settled_cents,cancelled from filtered
    order by case when p_order='due_asc' then due_on end asc,case when p_order='due_desc' then due_on end desc,
      case when p_order='due_asc' then id end asc,case when p_order='due_desc' then id end desc
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),(select coalesce(sum(amount_cents),0) from filtered),
    (select coalesce(sum(case when cancelled then 0 else amount_cents-settled_cents end),0) from filtered),
    (select coalesce(jsonb_agg(erp_finance.dto('titles',id)||jsonb_build_object(
        'overdue',not cancelled and settled_cents<amount_cents and due_on<v_today,'origin',erp_finance.title_origin(id))
      order by case when p_order='due_asc' then due_on end asc,case when p_order='due_desc' then due_on end desc,
        case when p_order='due_asc' then id end asc,case when p_order='due_desc' then id end desc),'[]'::jsonb) from page)
  into v_total,v_amount,v_balance,v_items;

  return jsonb_build_object('entity','titles','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'order',p_order,
    'total',v_total,'totals',jsonb_build_object('count',v_total,'amount_cents',v_amount::text,'balance_cents',v_balance::text),
    'data_mode','erp_native');
end $$;

revoke all on function erp_finance.title_origin(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_get(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_finance_title_page(uuid,text,integer,integer,text,text,text[],text,date,date,text,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.erp_finance_get(uuid,text,uuid) to service_role;
grant execute on function public.erp_finance_title_page(uuid,text,integer,integer,text,text,text[],text,date,date,text,bigint,bigint,text) to service_role;
commit;
