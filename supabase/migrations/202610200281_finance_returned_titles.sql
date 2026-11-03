-- 281: situação "Devolvido" das contas a receber e a pagar (Origin: Cancelada | Devolvido | Em aberto | Parcialmente Recebida |
-- Recebida; nas contas a pagar Paga e Parcialmente Paga). Frente mista da onda F, parte financeira.
-- * erp_finance.title_return: a marca de devolução de uma conta, uma vez e para sempre (imutável), com o comando, o autor e a
--   origem (a devolução da venda da Frente de caixa, a nota fiscal de devolução ou a devolução de um pedido). A conta devolvida é
--   uma conta cancelada (cancelled=true): saldos, listagens Em aberto e Atrasadas, notificações, remessas e relatórios continuam
--   tratando-a como cancelada, sem nenhuma outra mudança.
-- * erp_finance.titles_mark_returned(ator, comando, contas, origem): a função que a devolução chama dentro da própria transação,
--   depois das próprias conferências de permissão (não tem execução pública). Conta em aberto e sem baixa é cancelada e marcada;
--   conta já cancelada (por exemplo pelo Estornar contas do pedido ou da nota) só é marcada. Recusa conta com baixa (o valor
--   recebido é devolvido pelo caixa, não pela conta), conta em remessa de cobrança, conta de Faturamento agrupado, conta lançada
--   por nota fiscal ainda ativa (estorne as contas da nota antes) e conta excluída. Repetir o mesmo comando não muda nada; outra
--   devolução da mesma conta é recusada. Uma linha de auditoria "title_returned" por chamada.
-- * erp_finance.dto('titles') ganha "returned" (a Situação Devolvido); o status continua "cancelled" para quem já lê a conta.
-- * Listagem (erp_finance_title_page_v2, Emitidas): a Situação aceita "returned" (Devolvido); "cancelled" (Cancelada) passa a
--   deixar as devolvidas de fora, como no Origin.
-- Quem chama: a devolução da Frente de caixa (erp_pos, frente de documentos) e a NF de devolução (frente de notas) ainda não
-- chamam esta função; até lá nenhuma conta fica Devolvida. Substitui erp_finance.dto (247) e erp_finance_title_page_v2 (246),
-- conferidas pelo hash; qualquer outra versão interrompe a migração. Nada aqui escreve no Origin, emite nota ou opera banco.
begin;

do $$ declare r record; begin
  for r in select * from (values
    ('erp_finance.dto(text,uuid)','f711e8dc754062aa6eccaffe2c5f6d13164b4616db577113efa6661a9eeec232'),
    ('public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)','3a259378d21f0c61635d8f7bfffd4cbd5b5ac7c2e687d4374438b95c2e8335b9')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_returned_281_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
  if to_regclass('erp_finance.invoice_title') is null or to_regclass('erp_finance.grouped_billing_title') is null or to_regclass('erp_cnab.billing_title') is null then
    raise exception 'finance_returned_281_requires_174_247' using errcode='55000'; end if;
  if to_regclass('erp_finance.title_return') is not null then raise exception 'finance_returned_281_already_applied' using errcode='55000'; end if;
end $$;

-- ---------------------------------------------------------------- Marca de devolução
create table erp_finance.title_return (
  title_id uuid primary key references erp_finance.title(id),
  -- Who returned it: {"kind": "pos_return" | "invoice_return" | "document_return", "id": text, "label": text}.
  source jsonb not null check (jsonb_typeof(source)='object' and source->>'kind' in ('pos_return','invoice_return','document_return')
    and octet_length(source::text)<=1000),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index erp_finance_title_return_command on erp_finance.title_return(command_id);
alter table erp_finance.title_return enable row level security;
revoke all on erp_finance.title_return from public,anon,authenticated,service_role;
create function erp_finance.title_return_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_finance_title_return_immutable' using errcode='42501'; end $$;
create trigger title_return_immutable before update or delete on erp_finance.title_return for each row execute function erp_finance.title_return_immutable();

create function erp_finance.titles_mark_returned(p_actor uuid,p_command_id uuid,p_titles uuid[],p_source jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_title erp_finance.title; v_return erp_finance.title_return; v_marked uuid[]:='{}'; v_cancelled uuid[]:='{}'; v_replayed uuid[]:='{}';
  v_before jsonb:='[]'::jsonb; v_result jsonb;
begin
  if p_actor is null or p_command_id is null or p_titles is null or array_ndims(p_titles) is distinct from 1 or cardinality(p_titles) not between 1 and 120
    or array_position(p_titles,null) is not null or (select count(distinct t) from unnest(p_titles) t)<>cardinality(p_titles)
    or p_source is null or jsonb_typeof(p_source)<>'object' or exists(select 1 from jsonb_object_keys(p_source) k where k not in ('kind','id','label'))
    or p_source->>'kind' is null or p_source->>'kind' not in ('pos_return','invoice_return','document_return')
    or jsonb_typeof(p_source->'id') is distinct from 'string' or length(p_source->>'id') not between 1 and 60 or p_source->>'id'~'[[:cntrl:]]'
    or (p_source?'label' and (jsonb_typeof(p_source->'label')<>'string' or length(p_source->>'label') not between 1 and 120 or p_source->>'label'~'[[:cntrl:]]')) then
    raise exception 'erp_finance_title_return_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_access.membership where user_id=p_actor and active) then raise exception 'erp_finance_access_denied' using errcode='42501'; end if;
  -- Titles first (the finance and CNAB lock order), in UUID order.
  perform 1 from erp_finance.title where id=any(p_titles) order by id for update;
  for v_title in select * from erp_finance.title where id=any(p_titles) order by id loop
    select * into v_return from erp_finance.title_return where title_id=v_title.id;
    if found then
      if v_return.command_id<>p_command_id then raise exception 'erp_finance_title_already_returned' using errcode='40001',detail=v_title.id::text; end if;
      v_replayed:=v_replayed||v_title.id; continue;
    end if;
    if v_title.deleted_at is not null then raise exception 'erp_finance_title_return_unavailable' using errcode='40001',detail=v_title.id::text; end if;
    if v_title.settled_cents<>0 then raise exception 'erp_finance_active_payments' using errcode='40001',detail=v_title.id::text; end if;
    if exists(select 1 from erp_finance.grouped_billing_title g where g.title_id=v_title.id) then raise exception 'erp_finance_source_locked' using errcode='40001',detail=v_title.id::text; end if;
    if not v_title.cancelled then
      if exists(select 1 from erp_cnab.billing_title b where b.title_id=v_title.id) then raise exception 'erp_finance_billed_locked' using errcode='40001',detail=v_title.id::text; end if;
      -- A conta of a nota fiscal is cancelled only by the Estornar contas of the note (247).
      if exists(select 1 from erp_finance.invoice_title l where l.title_id=v_title.id) then raise exception 'erp_finance_source_locked' using errcode='40001',detail=v_title.id::text; end if;
    end if;
    v_before:=v_before||jsonb_build_array(jsonb_build_object('id',v_title.id,'version',v_title.version,'cancelled',v_title.cancelled));
    if not v_title.cancelled then
      update erp_finance.title set cancelled=true,version=version+1,updated_at=clock_timestamp() where id=v_title.id;
      v_cancelled:=v_cancelled||v_title.id;
    end if;
    insert into erp_finance.title_return(title_id,source,actor,command_id) values(v_title.id,p_source,p_actor,p_command_id);
    v_marked:=v_marked||v_title.id;
  end loop;
  if cardinality(v_marked)+cardinality(v_replayed)<>cardinality(p_titles) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  v_result:=jsonb_build_object('entity','title_returns','source',p_source,'returned',to_jsonb(v_marked),'cancelled',to_jsonb(v_cancelled),'replayed',to_jsonb(v_replayed),
    'items',(select coalesce(jsonb_agg(erp_finance.dto('titles',t) order by t),'[]'::jsonb) from unnest(v_marked) t));
  if cardinality(v_marked)>0 then
    insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_actor,p_command_id,'title_returned',jsonb_build_object('titles',v_before),v_result);
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------- DTO (247) com "returned"
CREATE OR REPLACE FUNCTION erp_finance.dto(p_entity text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v jsonb; v_seller uuid;
begin
  if p_entity='accounts' then
    select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'active',a.active,'opening_recorded',a.opening_recorded,
      'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at,
      'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text) into v from erp_finance.account a where id=p_id;
  elsif p_entity='categories' then select to_jsonb(c) into v from erp_finance.category c where id=p_id;
  elsif p_entity='titles' then
    v_seller:=erp_finance.title_seller(p_id);
    -- 210: the long histórico (history) is read by the gaveta only (erp_finance_title_detail), never by lists.
    select (to_jsonb(t)-'amount_cents'-'settled_cents'-'history'-'seller_id'-'seller_none')||jsonb_build_object('amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
      'balance_cents',(t.amount_cents-t.settled_cents)::text,'contact_name',c.name,'category_name',g.name,
      -- 247: the contas of a nota fiscal are linked to it as the contas of a pedido are to the pedido.
      'document_linked',exists(select 1 from erp_finance.document_title l where l.title_id=t.id) or exists(select 1 from erp_finance.invoice_title l where l.title_id=t.id),
      -- 175: Forma de pagamento (name and the taxa it would take from this valor) and the Faturamento agrupado of the conta.
      'payment_method_name',(select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id),
      'payment_type',(select f.payment_type from erp_catalog.payment_method f where f.id=t.payment_method_id),
      'payment_fee_cents',case when t.payment_method_id is null then null else erp_finance.payment_method_fee(t.payment_method_id,t.amount_cents)::text end,
      'grouped_billing_id',(select g.billing_id from erp_finance.grouped_billing_title g where g.title_id=t.id),
      -- 210: Vendedor efetivo (the conta's own, or the document's while the conta has none).
      'seller_id',v_seller,'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=v_seller),
      'seller_source',case when t.seller_id is not null then 'conta' when v_seller is not null then 'documento' end,
      -- 246: "sem vendedor" chosen over the seller of the document.
      'seller_cleared',t.seller_none,
      'long_history',t.history is not null,
      'status',case when t.cancelled then 'cancelled' when t.settled_cents=0 then 'open' when t.settled_cents=t.amount_cents then 'paid' else 'partial' end,
      -- 281: Situação Devolvido (a cancelled conta marked by a devolução).
      'returned',t.cancelled and exists(select 1 from erp_finance.title_return x where x.title_id=t.id),
      'overdue',not t.cancelled and t.settled_cents<t.amount_cents and t.due_on<(clock_timestamp() at time zone 'America/Sao_Paulo')::date)
      into v from erp_finance.title t join erp_catalog.record c on c.id=t.contact_id left join erp_finance.category g on g.id=t.category_id where t.id=p_id;
  elsif p_entity='settlements' then
    select (to_jsonb(s)-'actor'-'command_id'-'principal_cents'-'interest_cents'-'penalty_cents'-'discount_cents'-'fee_cents'-'net_cash_cents')||
      jsonb_build_object('principal_cents',s.principal_cents::text,'interest_cents',s.interest_cents::text,'penalty_cents',s.penalty_cents::text,
        'discount_cents',s.discount_cents::text,'fee_cents',s.fee_cents::text,'net_cash_cents',s.net_cash_cents::text,
        'reversed',exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)) into v from erp_finance.settlement s where id=p_id;
  elsif p_entity='movements' then select (to_jsonb(m)-'actor'-'command_id'-'delta_cents')||jsonb_build_object('delta_cents',m.delta_cents::text)
    into v from erp_finance.movement m where id=p_id;
  else raise exception 'erp_finance_invalid_entity' using errcode='22023'; end if;
  return v;
end $function$;

-- ---------------------------------------------------------------- Listagem (246) com a Situação Devolvido
CREATE OR REPLACE FUNCTION public.erp_finance_title_page_v2(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,
  p_order text default 'due_asc',p_query text default null,p_option text default 'issued',p_statuses text[] default null,p_date_field text default 'due',
  p_from date default null,p_to date default null,p_account text default null,p_categories text[] default null,p_remittance text default null,
  p_amount_cents bigint default null,p_document text default null,p_payment_type text default null,p_payment_method uuid default null,p_seller uuid default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    -- 281: Devolvido (returned) besides Cancelada, Em aberto, Parcialmente Recebida/Paga and Recebida/Paga.
    or (p_statuses is not null and (p_option<>'issued' or array_ndims(p_statuses) is distinct from 1 or cardinality(p_statuses) not between 1 and 5
      or array_position(p_statuses,null) is not null or not p_statuses<@array['open','partial','paid','cancelled','returned']
      or (select count(distinct s) from unnest(p_statuses) s)<>cardinality(p_statuses)))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_account is not null and not v_no_account and p_account!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 50
      or array_position(p_categories,null) is not null or (select count(distinct lower(c)) from unnest(p_categories) c)<>cardinality(p_categories)
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    or (p_remittance is not null and (p_remittance not in ('yes','no') or p_option<>'open'))
    or p_amount_cents not between 1 and 999999999999999
    -- 210: Tipo de pagamento (tPag of the forma, two digits) and Vendedor (contas a receber only).
    or (p_payment_type is not null and p_payment_type!~'^[0-9]{2}$') or (p_seller is not null and p_kind<>'receivable')
  then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  -- 246: Sistema > Usuários > Permissões > Finanças > Contas a Receber / Contas a Pagar.
  perform erp_finance.require_permission(p_user_id,case when p_kind='receivable' then 'financas.contas_receber' else 'financas.contas_pagar' end);
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
        or ('cancelled'=any(p_statuses) and t.cancelled and not exists(select 1 from erp_finance.title_return x where x.title_id=t.id))
        or ('returned'=any(p_statuses) and t.cancelled and exists(select 1 from erp_finance.title_return x where x.title_id=t.id)))
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
      and (p_payment_method is null or t.payment_method_id=p_payment_method)
      and (p_payment_type is null or exists(select 1 from erp_catalog.payment_method f where f.id=t.payment_method_id and f.payment_type=p_payment_type))
      -- 246: the effective Vendedor, which keeps "sem vendedor" (erp_finance.title_seller).
      and (p_seller is null or erp_finance.title_seller(t.id) is not distinct from p_seller)
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
        -- 246: the bank of the conta financeira of the forma (else of the conta itself) for the column Forma de pagamento.
        'payment_bank',(select jsonb_build_object('code',a.institution_code,'name',left(a.institution_name,80)) from erp_finance.title t
          left join erp_catalog.payment_method f on f.id=t.payment_method_id join erp_finance.account a on a.id=coalesce(f.account_id,t.account_id)
          where t.id=p.id and t.payment_method_id is not null and a.institution_code is not null),
        -- Contas adotadas do Origin (039) ficam com o Origin: não são excluídas no Brufap.
        'imported',exists(select 1 from erp_finance.origin_import_origin o where o.title_id=p.id))
      order by case when p_order='due_asc' then p.due_on end asc,case when p_order='due_desc' then p.due_on end desc,
        case when p_order='due_asc' then p.id end asc,case when p_order='due_desc' then p.id end desc),'[]'::jsonb) from page p)
  into v_total,v_amount,v_balance,v_fee,v_items;

  return jsonb_build_object('entity','titles','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'order',p_order,'option',p_option,
    'total',v_total,'totals',jsonb_build_object('count',v_total,'amount_cents',v_amount::text,'balance_cents',v_balance::text,'fee_cents',v_fee::text),
    'data_mode','erp_native');
end $function$;

revoke all on function erp_finance.title_return_immutable(),erp_finance.titles_mark_returned(uuid,uuid,uuid[],jsonb),erp_finance.dto(text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid) to service_role;
commit;
