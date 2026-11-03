-- Conciliação bancária (OFX) no padrão Origin: extratos importados do arquivo .OFX (sem API bancária), linhas do banco
-- com FITID único por conta, vínculo de uma linha com um ou mais lançamentos do Brufap (mesmo valor), ocultar,
-- desvincular (com estorno opcional do lançamento criado pela conciliação), novo lançamento, transferência ou baixa a
-- partir da linha, e a situação da conciliação no extrato. O arquivo é lido pelo Worker; o banco confere tudo de novo.
begin;

create table erp_finance.bank_statement (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references erp_finance.account(id),
  file_name text not null check(length(file_name) between 1 and 200 and file_name!~'[[:cntrl:]]'),
  file_hash text not null check(file_hash~'^[a-f0-9]{64}$'),
  period_from date not null, period_to date not null, check(period_from<=period_to),
  bank_lines integer not null check(bank_lines between 0 and 5000), new_lines integer not null check(new_lines between 0 and 5000),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id),
  check((deleted_at is null)=(deleted_by is null))
);
create unique index erp_finance_bank_statement_file on erp_finance.bank_statement(account_id,file_hash) where deleted_at is null;
create table erp_finance.bank_statement_line (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references erp_finance.bank_statement(id),
  account_id uuid not null references erp_finance.account(id),
  fitid text not null check(length(fitid) between 1 and 255 and fitid!~'[[:cntrl:]]'),
  posted_on date not null check(posted_on between date '1900-01-01' and date '2100-12-31'),
  amount_cents bigint not null check(amount_cents<>0 and abs(amount_cents)<=999999999999999),
  memo text check(memo is null or (length(memo) between 1 and 255 and memo!~'[[:cntrl:]]')),
  trntype text check(trntype is null or trntype~'^[A-Z]{1,20}$'),
  state text not null default 'pending' check(state in ('pending','reconciled','hidden')),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
create unique index erp_finance_bank_line_fitid on erp_finance.bank_statement_line(account_id,fitid) where deleted_at is null;
create index erp_finance_bank_line_queue on erp_finance.bank_statement_line(account_id,state,posted_on,id) where deleted_at is null;
create table erp_finance.reconciliation_link (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null references erp_finance.bank_statement_line(id),
  entry_id uuid references erp_finance.cash_entry(id),
  movement_id uuid references erp_finance.movement(id),
  check((entry_id is null)<>(movement_id is null)),
  actor uuid not null references auth.users(id), command_id uuid not null, created_at timestamptz not null default clock_timestamp(),
  undone_at timestamptz, undone_by uuid references auth.users(id), undone_command uuid,
  check((undone_at is null and undone_by is null and undone_command is null) or (undone_at is not null and undone_by is not null and undone_command is not null))
);
create unique index erp_finance_reconciliation_entry on erp_finance.reconciliation_link(entry_id) where undone_at is null and entry_id is not null;
create unique index erp_finance_reconciliation_movement on erp_finance.reconciliation_link(movement_id) where undone_at is null and movement_id is not null;
create index erp_finance_reconciliation_line on erp_finance.reconciliation_link(line_id) where undone_at is null;
do $$ declare t text; begin foreach t in array array['bank_statement','bank_statement_line','reconciliation_link'] loop
  execute format('alter table erp_finance.%I enable row level security',t);
  execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

-- A reconciled lançamento keeps its value, date, type and account; a reconciled transferência or baixa is not undone.
-- Desvincular comes first, as the Origin alert "Divergência entre registro e movimentação" would otherwise stay.
create function erp_finance.reconciled_entry_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if (new.account_id,new.kind,new.amount_cents,new.posted_on,new.deleted_at is null) is distinct from (old.account_id,old.kind,old.amount_cents,old.posted_on,old.deleted_at is null)
    and exists(select 1 from erp_finance.reconciliation_link where entry_id=old.id and undone_at is null) then
    raise exception 'erp_finance_entry_reconciled' using errcode='40001'; end if;
  return new;
end $$;
create trigger reconciled_entry_guard before update on erp_finance.cash_entry for each row execute function erp_finance.reconciled_entry_guard();
create function erp_finance.reconciled_movement_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_table_name='transfer_deletion' then
    if exists(select 1 from erp_finance.reconciliation_link l join erp_finance.movement m on m.id=l.movement_id where m.transfer_id=new.transfer_id and l.undone_at is null) then
      raise exception 'erp_finance_transfer_reconciled' using errcode='40001'; end if;
  elsif new.kind='reversal' and exists(select 1 from erp_finance.reconciliation_link l join erp_finance.movement m on m.id=l.movement_id where m.settlement_id=new.reverses_id and l.undone_at is null) then
    raise exception 'erp_finance_settlement_reconciled' using errcode='40001';
  end if;
  return new;
end $$;
create trigger reconciled_transfer_guard before insert on erp_finance.transfer_deletion for each row execute function erp_finance.reconciled_movement_guard();
create trigger reconciled_settlement_guard before insert on erp_finance.settlement for each row execute function erp_finance.reconciled_movement_guard();

-- The extrato shows whether each line is reconciled and filters by it (Situação da conciliação).
create or replace function erp_finance.statement_line_dto(p_line erp_finance.statement_line)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_doc jsonb;
begin
  if p_line.title_id is not null then
    select jsonb_build_object('kind',d.kind,'number',d.number::text) into v_doc from erp_finance.document_title l join erp_finance.document_posting dp on dp.id=l.posting_id
      join erp_documents.document d on d.id=dp.document_id where l.title_id=p_line.title_id limit 1;
  end if;
  return jsonb_build_object('line_id',p_line.line_id,'line_kind',p_line.line_kind,'posted_on',p_line.posted_on,'competence_on',p_line.competence_on,'account_id',p_line.account_id,
    'account_name',(select name from erp_finance.account where id=p_line.account_id),'amount_cents',p_line.amount_cents::text,
    'category_id',p_line.category_id,'category_name',(select name from erp_finance.category where id=p_line.category_id),
    'contact_id',p_line.contact_id,'contact_name',(select name from erp_catalog.record where id=p_line.contact_id),'note',p_line.note,
    'title_id',p_line.title_id,'title_kind',p_line.title_kind,'document',v_doc,'transfer_id',p_line.transfer_id,'entry_id',p_line.entry_id,'entry_version',p_line.entry_version,
    'entry_origin',p_line.entry_origin,'reconciled',erp_finance.line_reconciled(p_line.line_kind,p_line.line_id));
end $$;
create function erp_finance.line_reconciled(p_kind text,p_id uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select case when p_kind='entry' then exists(select 1 from erp_finance.reconciliation_link where entry_id=p_id and undone_at is null)
    when p_kind in ('transfer','settlement') then exists(select 1 from erp_finance.reconciliation_link where movement_id=p_id and undone_at is null) else false end;
$$;

drop function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer);
create function public.erp_finance_statement_page(p_user_id uuid,p_account uuid default null,p_from date default null,p_to date default null,
  p_tab text default 'all',p_deleted boolean default false,p_categories text[] default null,p_amount_cents bigint default null,p_query text default null,
  p_order text default 'asc',p_page integer default 1,p_limit integer default 100,p_reconciliation text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_categories uuid[]; v_none boolean:=false; v_total bigint; v_items jsonb; v_days jsonb; v_summary jsonb; v_accounts uuid[];
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_tab is null or p_tab not in ('all','in','out') or p_deleted is null or p_order is null or p_order not in ('asc','desc') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' or p_amount_cents not between 1 and 999999999999999
    or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_from>p_to or p_to-p_from>3660
    or (p_reconciliation is not null and (p_reconciliation not in ('reconciled','unreconciled') or p_deleted))
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 200 or array_position(p_categories,null) is not null
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_account is not null and not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if p_categories is not null then v_none:='none'=any(p_categories); select array_agg(c::uuid) into v_categories from unnest(p_categories) c where c<>'none'; end if;
  select array_agg(id) into v_accounts from erp_finance.account where deleted_at is null and (p_account is null or id=p_account);
  with lines as materialized (
    select l.* from erp_finance.statement_lines(p_account,p_from,p_to,p_deleted) l where l.account_id=any(v_accounts)
  ), filtered as materialized (
    select l.* from lines l
    where (p_tab='all' or (p_tab='in' and l.amount_cents>0) or (p_tab='out' and l.amount_cents<0))
      and (p_amount_cents is null or abs(l.amount_cents)=p_amount_cents)
      and (p_categories is null or (v_none and l.category_id is null) or l.category_id=any(v_categories))
      and (v_query is null or strpos(lower(concat_ws(' ',l.note,(select name from erp_catalog.record r where r.id=l.contact_id))),v_query)>0)
      and (p_reconciliation is null or erp_finance.line_reconciled(l.line_kind,l.line_id)=(p_reconciliation='reconciled'))
  ), page as (
    select * from filtered order by case when p_order='asc' then posted_on end asc, case when p_order='desc' then posted_on end desc,
      case when p_order='asc' then created_at end asc, case when p_order='desc' then created_at end desc, line_id
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(erp_finance.statement_line_dto(row(p.line_id,p.line_kind,p.posted_on,p.created_at,p.account_id,p.amount_cents,p.category_id,p.contact_id,p.note,
      p.title_id,p.title_kind,p.transfer_id,p.entry_id,p.entry_version,p.entry_origin,p.competence_on)::erp_finance.statement_line) order by case when p_order='asc' then p.posted_on end asc, case when p_order='desc' then p.posted_on end desc,
      case when p_order='asc' then p.created_at end asc, case when p_order='desc' then p.created_at end desc, p.line_id),'[]'::jsonb) from page p),
    (select coalesce(jsonb_object_agg(d.on_day::text,(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=d.on_day)::text),'{}'::jsonb)
      from (select distinct posted_on as on_day from page) d),
    (select jsonb_build_object('before_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)::text,
      'previous_cents',((select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)
        +(select coalesce(sum(amount_cents),0) from lines where line_kind='opening' and not p_deleted))::text,
      'in_cents',(select coalesce(sum(amount_cents),0) from lines where amount_cents>0 and line_kind<>'opening' and not p_deleted)::text,
      'out_cents',(select coalesce(sum(-amount_cents),0) from lines where amount_cents<0 and line_kind<>'opening' and not p_deleted)::text,
      'closing_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=p_to)::text,
      'current_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts))::text,
      'reconciled_lines',(select count(*) from lines l where erp_finance.line_reconciled(l.line_kind,l.line_id))))
  into v_total,v_items,v_days,v_summary;
  return jsonb_build_object('entity','statement','account_id',p_account,'from',p_from,'to',p_to,'tab',p_tab,'deleted',p_deleted,'order',p_order,'page',p_page,'limit',p_limit,
    'reconciliation',p_reconciliation,'total',v_total,'items',v_items,'day_balances',case when p_deleted then '{}'::jsonb else v_days end,'summary',v_summary,'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Fila da conciliação
-- A candidate of the Brufap side: a lançamento (entry), a transfer leg or a baixa movement of the account, not linked yet.
create function erp_finance.reconciliation_target(p_kind text,p_id uuid)
returns table(account_id uuid,amount_cents bigint,posted_on date,ok boolean) language sql stable set search_path=pg_catalog as $$
  select e.account_id,case when e.kind='in' then e.amount_cents else -e.amount_cents end,e.posted_on,e.deleted_at is null
    from erp_finance.cash_entry e where p_kind='entry' and e.id=p_id
  union all
  select m.account_id,m.delta_cents,m.posted_on,(m.transfer_id is not null and not exists(select 1 from erp_finance.transfer_deletion d where d.transfer_id=m.transfer_id or d.reversal_id=m.transfer_id))
    or (m.settlement_id is not null and m.kind in ('payment','bank_fee') and not exists(select 1 from erp_finance.settlement x where x.reverses_id=m.settlement_id))
    from erp_finance.movement m where p_kind='movement' and m.id=p_id;
$$;
create function erp_finance.reconciliation_link_dto(p_link erp_finance.reconciliation_link)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb; v_day date;
begin
  -- The linked lançamento keeps its date while linked (reconciled_entry_guard), so only that day of the account is read.
  v_day:=coalesce((select e.posted_on from erp_finance.cash_entry e where e.id=p_link.entry_id),(select m.posted_on from erp_finance.movement m where m.id=p_link.movement_id));
  select jsonb_build_object('link_id',p_link.id,'kind',case when p_link.entry_id is not null then 'entry' else 'movement' end,'id',coalesce(p_link.entry_id,p_link.movement_id),
    'line_kind',l.line_kind,'posted_on',l.posted_on,'amount_cents',l.amount_cents::text,'note',l.note,'contact_name',(select name from erp_catalog.record where id=l.contact_id),
    'category_name',(select name from erp_finance.category where id=l.category_id),'entry_origin',l.entry_origin,'entry_version',l.entry_version,'title_kind',l.title_kind) into v
  from erp_finance.statement_lines((select account_id from erp_finance.bank_statement_line where id=p_link.line_id),v_day,v_day,false) l
  where (p_link.entry_id is not null and l.line_kind='entry' and l.entry_id=p_link.entry_id) or (p_link.movement_id is not null and l.line_id=p_link.movement_id) limit 1;
  return v;
end $$;
create function erp_finance.bank_line_dto(p_id uuid,p_suggest boolean)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b erp_finance.bank_statement_line%rowtype; v_links jsonb; v_suggestion jsonb;
begin
  select * into b from erp_finance.bank_statement_line where id=p_id;
  select coalesce(jsonb_agg(erp_finance.reconciliation_link_dto(k) order by k.created_at),'[]'::jsonb) into v_links from erp_finance.reconciliation_link k where k.line_id=p_id and k.undone_at is null;
  -- Sugestão: the unlinked lançamento of the same account and value closest in date (up to 3 days).
  if p_suggest and b.state='pending' then
    select jsonb_build_object('kind',case when l.line_kind='entry' then 'entry' else 'movement' end,'id',case when l.line_kind='entry' then l.entry_id else l.line_id end,'line_kind',l.line_kind,
      'posted_on',l.posted_on,'amount_cents',l.amount_cents::text,'note',l.note,'contact_name',(select name from erp_catalog.record where id=l.contact_id)) into v_suggestion
    from erp_finance.statement_lines(b.account_id,b.posted_on-3,b.posted_on+3,false) l
    where l.line_kind in ('entry','transfer','settlement') and l.amount_cents=b.amount_cents and not erp_finance.line_reconciled(l.line_kind,l.line_id)
      and (l.line_kind<>'settlement' or exists(select 1 from erp_finance.movement m where m.id=l.line_id and m.kind in ('payment','bank_fee') and not exists(select 1 from erp_finance.settlement x where x.reverses_id=m.settlement_id)))
    order by abs(l.posted_on-b.posted_on),l.created_at,l.line_id limit 1;
  end if;
  return jsonb_build_object('id',b.id,'statement_id',b.statement_id,'account_id',b.account_id,'fitid',b.fitid,'posted_on',b.posted_on,'amount_cents',b.amount_cents::text,'memo',b.memo,'trntype',b.trntype,
    'state',b.state,'version',b.version,'links',v_links,'suggestion',v_suggestion);
end $$;

-- Aba Conciliação: Pendentes (padrão) | Conciliados | Ocultos e Valor, com os Extratos importados da conta.
create function public.erp_finance_reconciliation_page(p_user_id uuid,p_account uuid,p_state text default 'pending',p_amount_cents bigint default null,p_page integer default 1,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_total bigint; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_account is null or p_state is null or p_state not in ('pending','reconciled','hidden') or p_amount_cents not between 1 and 999999999999999 or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select count(*) into v_total from erp_finance.bank_statement_line where account_id=p_account and deleted_at is null and state=p_state and (p_amount_cents is null or abs(amount_cents)=p_amount_cents);
  select coalesce(jsonb_agg(erp_finance.bank_line_dto(id,p_state='pending') order by posted_on,fitid,id),'[]'::jsonb) into v_items from (
    select id,posted_on,fitid from erp_finance.bank_statement_line where account_id=p_account and deleted_at is null and state=p_state and (p_amount_cents is null or abs(amount_cents)=p_amount_cents)
    order by posted_on,fitid,id limit p_limit offset (p_page-1)*p_limit) page;
  return jsonb_build_object('entity','reconciliation','account_id',p_account,'state',p_state,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,
    'counts',(select jsonb_build_object('pending',count(*) filter (where state='pending'),'reconciled',count(*) filter (where state='reconciled'),'hidden',count(*) filter (where state='hidden'))
      from erp_finance.bank_statement_line where account_id=p_account and deleted_at is null),
    'statements',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'file_name',s.file_name,'created_at',s.created_at,'period_from',s.period_from,'period_to',s.period_to,
      'lines',(select count(*) from erp_finance.bank_statement_line l where l.statement_id=s.id),'reconciled',(select count(*) from erp_finance.bank_statement_line l where l.statement_id=s.id and l.state='reconciled'))
      order by s.created_at desc,s.id),'[]'::jsonb) from erp_finance.bank_statement s where s.account_id=p_account and s.deleted_at is null),'data_mode','erp_native');
end $$;

-- Buscar: lançamentos sem vínculo da conta e contas em aberto do tipo do valor (para a baixa a partir do extrato).
create function public.erp_finance_reconciliation_candidates(p_user_id uuid,p_account uuid,p_from date,p_to date,p_query text default null,p_amount_cents bigint default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),''));
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_account is null or p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 or p_from<date '1900-01-01' or p_to>date '2100-12-31' or length(p_query)>120 or p_query~'[[:cntrl:]]'
    or p_amount_cents not between 1 and 999999999999999 then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','reconciliation_candidates','account_id',p_account,'from',p_from,'to',p_to,
    'movements',(select coalesce(jsonb_agg(c order by c->>'posted_on',c->>'id'),'[]'::jsonb) from (
      select jsonb_build_object('kind',case when l.line_kind='entry' then 'entry' else 'movement' end,'id',case when l.line_kind='entry' then l.entry_id else l.line_id end,'line_kind',l.line_kind,
        'posted_on',l.posted_on,'amount_cents',l.amount_cents::text,'note',l.note,'contact_name',(select name from erp_catalog.record where id=l.contact_id),'title_kind',l.title_kind) c
      from erp_finance.statement_lines(p_account,p_from,p_to,false) l
      where l.line_kind in ('entry','transfer','settlement') and not erp_finance.line_reconciled(l.line_kind,l.line_id)
        and (l.line_kind<>'settlement' or exists(select 1 from erp_finance.movement m where m.id=l.line_id and m.kind in ('payment','bank_fee') and not exists(select 1 from erp_finance.settlement x where x.reverses_id=m.settlement_id)))
        and (p_amount_cents is null or abs(l.amount_cents)=p_amount_cents)
        and (v_query is null or strpos(lower(concat_ws(' ',l.note,(select name from erp_catalog.record where id=l.contact_id))),v_query)>0)
      order by l.posted_on,l.line_id limit 100) x),
    'titles',(select coalesce(jsonb_agg(c order by c->>'due_on',c->>'id'),'[]'::jsonb) from (
      select jsonb_build_object('id',t.id,'kind',t.kind,'version',t.version,'contact_name',r.name,'description',t.description,'due_on',t.due_on,'balance_cents',(t.amount_cents-t.settled_cents)::text,
        'installment',t.installment,'installments',t.installments) c
      from erp_finance.title t join erp_catalog.record r on r.id=t.contact_id
      where not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents and t.due_on between p_from and p_to
        and (p_amount_cents is null or t.amount_cents-t.settled_cents=p_amount_cents)
        and (v_query is null or strpos(lower(concat_ws(' ',r.name,t.description,t.source_reference)),v_query)>0)
      order by t.due_on,t.id limit 100) x),'data_mode','erp_native');
end $$;

create function erp_finance.reconcile_links(p_line erp_finance.bank_statement_line,p_links jsonb,p_user uuid,p_command uuid)
returns void language plpgsql set search_path=pg_catalog as $$
declare v_link jsonb; v_kind text; v_id uuid; v_target record; v_sum numeric:=0; v_count integer:=0;
begin
  if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links) not between 1 and 50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
  for v_link in select value from jsonb_array_elements(p_links) loop
    perform erp_finance.keys(v_link,array['kind','id']);
    v_kind:=erp_finance.txt(v_link,'kind',20,true); v_id:=erp_finance.uuid_value(v_link->'id');
    if v_kind not in ('entry','movement') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    select * into v_target from erp_finance.reconciliation_target(v_kind,v_id);
    if not found or not v_target.ok or v_target.account_id<>p_line.account_id then raise exception 'erp_finance_invalid_reconciliation' using errcode='22023'; end if;
    if exists(select 1 from erp_finance.reconciliation_link where undone_at is null and ((v_kind='entry' and entry_id=v_id) or (v_kind='movement' and movement_id=v_id))) then
      raise exception 'erp_finance_reconciliation_taken' using errcode='40001'; end if;
    insert into erp_finance.reconciliation_link(line_id,entry_id,movement_id,actor,command_id) values(p_line.id,case when v_kind='entry' then v_id end,case when v_kind='movement' then v_id end,p_user,p_command);
    v_sum:=v_sum+v_target.amount_cents; v_count:=v_count+1;
  end loop;
  if v_sum<>p_line.amount_cents then raise exception 'erp_finance_reconciliation_divergence' using errcode='22023'; end if;
  update erp_finance.bank_statement_line set state='reconciled',version=version+1,updated_at=clock_timestamp() where id=p_line.id;
end $$;

create function erp_finance.ofx_text(p_data jsonb,p_key text,p_limit integer)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  v:=erp_finance.txt(p_data,p_key,p_limit);
  if v~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;

-- Gravação: importar e excluir extrato, conciliar, desvincular (com estorno opcional), ocultar e exibir, e criar a partir da
-- linha um lançamento de caixa, uma transferência ou a baixa de contas em aberto, já conciliados.
create function public.erp_finance_reconciliation_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_account erp_finance.account%rowtype; v_other erp_finance.account%rowtype; v_statement erp_finance.bank_statement%rowtype;
  v_line erp_finance.bank_statement_line%rowtype; v_item jsonb; v_new integer:=0; v_total integer:=0; v_from date; v_to date; v_entry erp_finance.cash_entry%rowtype; v_link erp_finance.reconciliation_link%rowtype;
  v_category uuid; v_note text; v_kind text; v_transfer uuid; v_movement uuid; v_title erp_finance.title%rowtype; v_bordero uuid; v_settlement uuid; v_principal bigint; v_sum numeric:=0;
  v_ids uuid[]; v_count integer; ca jsonb; cb jsonb; v_out uuid; v_in uuid;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('statement_import','statement_delete','line_reconcile','line_unreconcile','line_hide','line_show','line_create_entry','line_create_transfer','line_settle_titles') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>2097152 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='statement_import' then
    perform erp_finance.keys(p_data,array['account_id','file_name','file_hash','period_from','period_to','lines']);
    v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
    -- One import of a file at a time per account; its lines with a known FITID are skipped (a re-import never duplicates).
    perform pg_advisory_xact_lock(hashtextextended('erp_finance.ofx:'||v_account.id::text,0));
    v_from:=erp_finance.day(p_data->'period_from'); v_to:=erp_finance.day(p_data->'period_to');
    if jsonb_typeof(p_data->'lines') is distinct from 'array' or jsonb_array_length(p_data->'lines')>5000 or (p_data->>'file_hash')!~'^[a-f0-9]{64}$' then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    if exists(select 1 from erp_finance.bank_statement where account_id=v_account.id and file_hash=p_data->>'file_hash' and deleted_at is null) then raise exception 'erp_finance_statement_duplicate' using errcode='23505'; end if;
    insert into erp_finance.bank_statement(account_id,file_name,file_hash,period_from,period_to,bank_lines,new_lines,actor,command_id)
      values(v_account.id,erp_finance.ofx_text(p_data,'file_name',200),p_data->>'file_hash',least(v_from,v_to),greatest(v_from,v_to),jsonb_array_length(p_data->'lines'),0,p_user_id,p_command_id) returning * into v_statement;
    for v_item in select value from jsonb_array_elements(p_data->'lines') loop
      perform erp_finance.keys(v_item,array['fitid','posted_on','amount_cents','memo','trntype']);
      v_total:=v_total+1;
      if exists(select 1 from erp_finance.bank_statement_line where account_id=v_account.id and fitid=erp_finance.ofx_text(v_item,'fitid',255) and deleted_at is null) then continue; end if;
      if erp_finance.ofx_text(v_item,'fitid',255) is null or erp_finance.cents(v_item->'amount_cents',true,true)=0 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      if coalesce(v_item->>'trntype','')!~'^([A-Z]{1,20})?$' then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      insert into erp_finance.bank_statement_line(statement_id,account_id,fitid,posted_on,amount_cents,memo,trntype)
        values(v_statement.id,v_account.id,erp_finance.ofx_text(v_item,'fitid',255),erp_finance.day(v_item->'posted_on'),erp_finance.cents(v_item->'amount_cents',true,true),
          erp_finance.ofx_text(v_item,'memo',255),nullif(v_item->>'trntype',''));
      v_new:=v_new+1;
    end loop;
    update erp_finance.bank_statement set new_lines=v_new where id=v_statement.id;
    v_result:=jsonb_build_object('entity','reconciliation','record',jsonb_build_object('id',v_statement.id,'account_id',v_account.id,'file_name',v_statement.file_name,'period_from',v_statement.period_from,
      'period_to',v_statement.period_to,'bank_lines',v_total,'new_lines',v_new));

  elsif p_action='statement_delete' then
    perform erp_finance.keys(p_data,array['id']);
    select * into v_statement from erp_finance.bank_statement where id=erp_finance.uuid_value(p_data->'id');
    if not found or v_statement.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    -- The account first, as every line action: a line reconciled while this waited is seen below and keeps the file.
    perform 1 from erp_finance.account where id=v_statement.account_id for update;
    select * into v_statement from erp_finance.bank_statement where id=v_statement.id for update;
    if v_statement.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    -- Excluir extrato: only without reconciled lines; its lines leave the queue and may be imported again.
    if exists(select 1 from erp_finance.bank_statement_line where statement_id=v_statement.id and state='reconciled') then raise exception 'erp_finance_statement_reconciled' using errcode='40001'; end if;
    update erp_finance.bank_statement_line set deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where statement_id=v_statement.id and deleted_at is null;
    update erp_finance.bank_statement set deleted_at=clock_timestamp(),deleted_by=p_user_id where id=v_statement.id;
    v_result:=jsonb_build_object('entity','reconciliation','record',jsonb_build_object('id',v_statement.id,'deleted',true));

  else
    perform erp_finance.keys(p_data,case p_action when 'line_reconcile' then array['line_id','expected_version','links'] when 'line_unreconcile' then array['line_id','expected_version','reverse']
      when 'line_create_entry' then array['line_id','expected_version','category_id','contact_id','note'] when 'line_create_transfer' then array['line_id','expected_version','other_account_id']
      when 'line_settle_titles' then array['line_id','expected_version','items'] else array['line_id','expected_version'] end);
    select * into v_line from erp_finance.bank_statement_line where id=erp_finance.uuid_value(p_data->'line_id');
    if not found or v_line.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if p_action='line_settle_titles' then
      if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      select array_agg(erp_finance.uuid_value(value->'id') order by erp_finance.uuid_value(value->'id')) into v_ids from jsonb_array_elements(p_data->'items');
      -- Titles first, in UUID order, then the account: the lock order of the 010 baixa, the borderôs and CNAB.
      perform 1 from erp_finance.title where id=any(v_ids) order by id for update;
    elsif p_action='line_create_transfer' then
      -- Both accounts in id order, as transfer_create.
      perform 1 from erp_finance.account where id in (v_line.account_id,erp_finance.uuid_value(p_data->'other_account_id')) order by id for update;
    end if;
    -- The account (every cash writer locks it), then the line.
    v_account:=erp_finance.cash_account(v_line.account_id);
    select * into v_line from erp_finance.bank_statement_line where id=v_line.id for update;
    if v_line.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.bank_line_dto(v_line.id,false);
    if p_action in ('line_reconcile','line_create_entry','line_create_transfer','line_settle_titles','line_hide') and v_line.state<>'pending' then raise exception 'erp_finance_line_state' using errcode='40001'; end if;
    if p_action='line_show' and v_line.state<>'hidden' then raise exception 'erp_finance_line_state' using errcode='40001'; end if;
    if p_action='line_unreconcile' and v_line.state<>'reconciled' then raise exception 'erp_finance_line_state' using errcode='40001'; end if;

    if p_action='line_reconcile' then
      perform erp_finance.reconcile_links(v_line,p_data->'links',p_user_id,p_command_id);
    elsif p_action in ('line_hide','line_show') then
      update erp_finance.bank_statement_line set state=case when p_action='line_hide' then 'hidden' else 'pending' end,version=version+1,updated_at=clock_timestamp() where id=v_line.id;
    elsif p_action='line_unreconcile' then
      if jsonb_typeof(coalesce(p_data->'reverse','false'::jsonb))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      -- Reverter conciliação: the links are undone (history kept); "Estornar" also excludes the lançamentos de caixa linked,
      -- while baixas and transferências are undone in their own screens.
      if coalesce((p_data->>'reverse')::boolean,false) then
        if exists(select 1 from erp_finance.reconciliation_link where line_id=v_line.id and undone_at is null and movement_id is not null) then raise exception 'erp_finance_reconciliation_reverse_locked' using errcode='40001'; end if;
      end if;
      update erp_finance.reconciliation_link set undone_at=clock_timestamp(),undone_by=p_user_id,undone_command=p_command_id where line_id=v_line.id and undone_at is null;
      if coalesce((p_data->>'reverse')::boolean,false) then
        for v_link in select * from erp_finance.reconciliation_link where line_id=v_line.id and undone_command=p_command_id and entry_id is not null loop
          select * into v_entry from erp_finance.cash_entry where id=v_link.entry_id for update;
          if v_entry.deleted_at is null then
            perform erp_finance.cash_compensate(v_entry.id,p_user_id,p_command_id);
            update erp_finance.cash_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note='Estornado ao reverter a conciliação',version=version+1,updated_at=clock_timestamp() where id=v_entry.id;
          end if;
        end loop;
      end if;
      update erp_finance.bank_statement_line set state='pending',version=version+1,updated_at=clock_timestamp() where id=v_line.id;
    elsif p_action='line_create_entry' then
      -- Novo a partir do extrato: Registro de Caixa "<memo> - Criado via conciliação", reconciled in the same command.
      v_category:=erp_finance.cash_category(p_data->'category_id',case when v_line.amount_cents>0 then 'receivable' else 'payable' end);
      v_note:=coalesce(erp_finance.cash_text(p_data,'note',2000,false),left(coalesce(v_line.memo,'Lançamento do extrato')||' - Criado via conciliação',2000));
      insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,contact_id,note,origin,source_key,actor,command_id)
        values(v_account.id,case when v_line.amount_cents>0 then 'in' else 'out' end,abs(v_line.amount_cents),v_line.posted_on,v_line.posted_on,erp_finance.cash_contact(p_data->'contact_id'),v_note,'reconciliation','ofx:'||v_line.id,p_user_id,p_command_id)
        returning * into v_entry;
      perform erp_finance.cash_post(v_entry,v_category,p_user_id,p_command_id);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      perform erp_finance.reconcile_links(v_line,jsonb_build_array(jsonb_build_object('kind','entry','id',v_entry.id)),p_user_id,p_command_id);
    elsif p_action='line_create_transfer' then
      -- Transferência a partir do extrato: the leg of this account is the line; the other account gets the other leg.
      select * into v_other from erp_finance.account where id=erp_finance.uuid_value(p_data->'other_account_id');
      if not found or v_other.id=v_account.id then raise exception 'erp_finance_transfer_invalid' using errcode='22023'; end if;
      v_other:=erp_finance.cash_account(v_other.id);
      if exists(select 1 from erp_finance.movement where account_id in (v_account.id,v_other.id) and kind='opening' and posted_on>v_line.posted_on) then
        raise exception 'erp_finance_transfer_before_opening' using errcode='22023'; end if;
      v_transfer:=gen_random_uuid(); v_note:=left(case when v_line.amount_cents<0 then format('Transferência %s -> %s',v_account.name,v_other.name) else format('Transferência %s -> %s',v_other.name,v_account.name) end,500);
      ca:=erp_finance.transfer_account(case when v_line.amount_cents<0 then v_account.id else v_other.id end); cb:=erp_finance.transfer_account(case when v_line.amount_cents<0 then v_other.id else v_account.id end);
      insert into erp_finance.transfer(id,command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot,float_days)
        values(v_transfer,p_command_id,p_user_id,(ca->>'id')::uuid,(cb->>'id')::uuid,abs(v_line.amount_cents),v_line.posted_on,v_note,
          jsonb_build_object('id',ca->'id','name',ca->'name','kind',ca->'kind','version_before',ca->'version','version_after',(ca->>'version')::integer+1,'balance_before_cents',ca->>'balance_cents','balance_after_cents',((ca->>'balance_cents')::numeric-abs(v_line.amount_cents))::text,'opening_on',ca->'opening_on'),
          jsonb_build_object('id',cb->'id','name',cb->'name','kind',cb->'kind','version_before',cb->'version','version_after',(cb->>'version')::integer+1,'balance_before_cents',cb->>'balance_cents','balance_after_cents',((cb->>'balance_cents')::numeric+abs(v_line.amount_cents))::text,'opening_on',cb->'opening_on'),0);
      v_out:=erp_finance.find_or_create_category('Transferências de saída','payable');
      v_in:=coalesce((select d.category_id from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id where d.key='transfer_in' and c.active and c.deleted_at is null),erp_finance.find_or_create_category('Transferências de entrada','receivable'));
      insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id,category_id)
        values((ca->>'id')::uuid,'transfer_out',-abs(v_line.amount_cents),v_line.posted_on,v_note,p_user_id,p_command_id,v_transfer,v_out),((cb->>'id')::uuid,'transfer_in',abs(v_line.amount_cents),v_line.posted_on,v_note,p_user_id,p_command_id,v_transfer,v_in);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in (v_account.id,v_other.id);
      select id into v_movement from erp_finance.movement where transfer_id=v_transfer and account_id=v_account.id;
      perform erp_finance.reconcile_links(v_line,jsonb_build_array(jsonb_build_object('kind','movement','id',v_movement)),p_user_id,p_command_id);
    else
      -- Baixa a partir do extrato: the contas chosen (a receber for a crédito, a pagar for a débito) are settled on the date
      -- and in the account of the line, by their principal, in one borderô; the movements are reconciled with the line.
      if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      v_kind:=case when v_line.amount_cents>0 then 'receivable' else 'payable' end; v_count:=jsonb_array_length(p_data->'items');
      select array_agg(erp_finance.uuid_value(value->'id') order by erp_finance.uuid_value(value->'id')) into v_ids from jsonb_array_elements(p_data->'items');
      if (select count(distinct x) from unnest(v_ids) x)<>v_count then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      -- As every baixa (010, borderôs): not in the future and not before the saldo inicial of the account.
      if v_line.posted_on>(clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_finance_invalid_date' using errcode='22023'; end if;
      if exists(select 1 from erp_finance.movement where account_id=v_account.id and kind='opening' and posted_on>v_line.posted_on) then raise exception 'erp_finance_payment_before_opening' using errcode='22023'; end if;
      insert into erp_finance.bordero(kind,posted_on,account_id,note,grouped,actor,command_id) values(v_kind,v_line.posted_on,v_account.id,left(coalesce(v_line.memo,'Baixa pela conciliação'),500),v_count>1,p_user_id,p_command_id) returning id into v_bordero;
      for v_item in select value from jsonb_array_elements(p_data->'items') order by erp_finance.uuid_value(value->'id') loop
        perform erp_finance.keys(v_item,array['id','expected_version','principal_cents']);
        select * into v_title from erp_finance.title where id=erp_finance.uuid_value(v_item->'id');
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_title.version<>erp_finance.expected(v_item->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
        if v_title.kind<>v_kind or v_title.cancelled or v_title.deleted_at is not null then raise exception 'erp_finance_invalid_reconciliation' using errcode='22023'; end if;
        if v_line.posted_on<v_title.issued_on then raise exception 'erp_finance_payment_before_issue' using errcode='22023'; end if;
        v_principal:=erp_finance.cents(v_item->'principal_cents',false);
        if v_principal>v_title.amount_cents-v_title.settled_cents then raise exception 'erp_finance_overpayment' using errcode='40001'; end if;
        perform set_config('erp_finance.bordero_id',v_bordero::text,true); perform set_config('erp_finance.bordero_category','',true);
        insert into erp_finance.settlement(title_id,account_id,kind,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
          values(v_title.id,v_account.id,'payment',v_line.posted_on,v_principal,0,0,0,0,v_principal,left(coalesce(v_line.memo,'Baixa pela conciliação'),500),p_user_id,p_command_id) returning id into v_settlement;
        perform set_config('erp_finance.bordero_id','',true);
        update erp_finance.title set settled_cents=settled_cents+v_principal,version=version+1,updated_at=clock_timestamp() where id=v_title.id;
        perform erp_finance.post_settlement_movements(v_settlement,case when v_kind='receivable' then v_principal else -v_principal end);
        select id into v_movement from erp_finance.movement where settlement_id=v_settlement and kind='payment';
        v_item:=jsonb_build_object('kind','movement','id',v_movement); v_sum:=v_sum+v_principal;
        v_result:=coalesce(v_result,'[]'::jsonb)||jsonb_build_array(v_item);
      end loop;
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      perform erp_finance.reconcile_links(v_line,v_result,p_user_id,p_command_id);
    end if;
    v_result:=jsonb_build_object('entity','reconciliation','record',erp_finance.bank_line_dto(v_line.id,false));
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.reconciled_entry_guard(),erp_finance.reconciled_movement_guard(),erp_finance.statement_line_dto(erp_finance.statement_line),erp_finance.line_reconciled(text,uuid),
  erp_finance.reconciliation_target(text,uuid),erp_finance.reconciliation_link_dto(erp_finance.reconciliation_link),erp_finance.bank_line_dto(uuid,boolean),
  erp_finance.reconcile_links(erp_finance.bank_statement_line,jsonb,uuid,uuid),erp_finance.ofx_text(jsonb,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text),public.erp_finance_reconciliation_page(uuid,uuid,text,bigint,integer,integer),
  public.erp_finance_reconciliation_candidates(uuid,uuid,date,date,text,bigint),public.erp_finance_reconciliation_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text),public.erp_finance_reconciliation_page(uuid,uuid,text,bigint,integer,integer),
  public.erp_finance_reconciliation_candidates(uuid,uuid,date,date,text,bigint),public.erp_finance_reconciliation_execute(uuid,uuid,text,jsonb) to service_role;
commit;
