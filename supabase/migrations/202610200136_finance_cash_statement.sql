-- Caixas e bancos no padrão Origin: lançamentos de caixa avulsos (Incluir lançamento, Ajustar saldos, lançamentos da
-- Ficha financeira), extrato com saldo diário, transferência com float bancário e categorias, exclusão e restauração.
-- O razão continua só de inclusão: editar ou excluir um lançamento grava a compensação na mesma data do lançamento
-- original, e excluir uma transferência grava a transferência inversa. Assim a soma dos movimentos de cada dia é sempre
-- a soma das linhas visíveis do extrato. Nenhum banco é chamado; centavos inteiros exatos.
begin;

-- ---------------------------------------------------------------- Lançamentos de caixa
create table erp_finance.cash_entry (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references erp_finance.account(id),
  kind text not null check(kind in ('in','out')),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
  posted_on date not null check(posted_on between date '1900-01-01' and date '2100-12-31'),
  competence_on date not null check(competence_on between date '1900-01-01' and date '2100-12-31'),
  contact_id uuid references erp_catalog.contact(record_id),
  note text not null check(length(note) between 1 and 2000 and note!~'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  origin text not null check(origin in ('manual','adjustment','ledger','import','reconciliation')),
  source_key text check(source_key is null or length(source_key) between 1 and 200),
  version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id), deleted_note text,
  check((deleted_at is null and deleted_by is null and deleted_note is null) or (deleted_at is not null and deleted_by is not null and (deleted_note is null or length(deleted_note) between 1 and 500)))
);
create index erp_finance_cash_entry_account on erp_finance.cash_entry(account_id,posted_on,id);
create index erp_finance_cash_entry_contact on erp_finance.cash_entry(contact_id,posted_on) where contact_id is not null;
create unique index erp_finance_cash_entry_source on erp_finance.cash_entry(source_key) where source_key is not null;
alter table erp_finance.cash_entry enable row level security;
revoke all on erp_finance.cash_entry from public,anon,authenticated,service_role;

-- Each posting of an entry is a movement; editing or excluding compensates the active posting on its own date.
alter table erp_finance.movement add column entry_id uuid references erp_finance.cash_entry(id),
  add column compensates_id uuid unique references erp_finance.movement(id);
alter table erp_finance.movement drop constraint movement_kind_check;
alter table erp_finance.movement drop constraint movement_check;
alter table erp_finance.movement add constraint movement_kind_check check(kind in ('opening','payment','reversal','transfer_out','transfer_in','bank_fee','bank_fee_reversal','entry','entry_reversal'));
alter table erp_finance.movement add constraint movement_check check(
  (kind='opening' and settlement_id is null and transfer_id is null and entry_id is null and compensates_id is null)
  or (kind in ('payment','reversal','bank_fee','bank_fee_reversal') and settlement_id is not null and transfer_id is null and entry_id is null and compensates_id is null)
  or (kind in ('transfer_out','transfer_in') and settlement_id is null and transfer_id is not null and entry_id is null and compensates_id is null)
  or (kind='entry' and settlement_id is null and transfer_id is null and entry_id is not null and compensates_id is null)
  or (kind='entry_reversal' and settlement_id is null and transfer_id is null and entry_id is not null and compensates_id is not null));
create index erp_finance_movement_entry on erp_finance.movement(entry_id) where entry_id is not null;

-- Entry postings never change, except their category (reclassification inside the finance RPCs).
create function erp_finance.entry_movement_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and current_setting('erp_finance.reclassify',true)='on' and (to_jsonb(new)-'category_id')=(to_jsonb(old)-'category_id') then return new; end if;
  raise exception 'erp_finance_entry_immutable' using errcode='55000';
end $$;
create trigger erp_finance_entry_movement_immutable before update or delete on erp_finance.movement
  for each row when(old.entry_id is not null) execute function erp_finance.entry_movement_immutable();

-- ---------------------------------------------------------------- Transferências: float bancário e exclusão
alter table erp_finance.transfer add column in_posted_on date,
  add column float_days integer not null default 0 check(float_days between 0 and 30);
create table erp_finance.transfer_deletion (
  transfer_id uuid primary key references erp_finance.transfer(id),
  reversal_id uuid not null unique references erp_finance.transfer(id),
  actor uuid not null references auth.users(id), command_id uuid not null, note text,
  created_at timestamptz not null default clock_timestamp()
);
alter table erp_finance.transfer_deletion enable row level security;
revoke all on erp_finance.transfer_deletion from public,anon,authenticated,service_role;
create trigger erp_finance_transfer_deletion_immutable before update or delete on erp_finance.transfer_deletion
  for each row execute function erp_finance.transfer_immutable();

-- The entry leg of a transfer with float bancário is posted on its own date (posted_on + float); the 053 rules stay.
create or replace function erp_finance.transfer_leg_check()
returns trigger language plpgsql set search_path=pg_catalog as $$
declare t erp_finance.transfer;
begin
 if new.transfer_id is null then return new; end if;
 select * into t from erp_finance.transfer where id=new.transfer_id;
 if not found or new.actor is distinct from t.actor or new.command_id is distinct from t.command_id or new.note is distinct from t.note
  or not ((new.kind='transfer_out' and new.account_id=t.from_account_id and new.delta_cents=-t.amount_cents and new.posted_on=t.posted_on)
    or (new.kind='transfer_in' and new.account_id=t.to_account_id and new.delta_cents=t.amount_cents and new.posted_on=coalesce(t.in_posted_on,t.posted_on))) then
  raise exception 'erp_finance_transfer_leg_invalid' using errcode='22023';
 end if;
 return new;
end $$;

-- ---------------------------------------------------------------- Linhas do extrato
-- One logical line per lançamento (entries, transfer legs, baixas and the saldo inicial). Compensations of edited or
-- excluded entries and the inverse transfers of excluded transfers are not lines: they net to zero on their dates.
create type erp_finance.statement_line as (line_id uuid,line_kind text,posted_on date,created_at timestamptz,account_id uuid,amount_cents bigint,category_id uuid,contact_id uuid,note text,
  title_id uuid,title_kind text,transfer_id uuid,entry_id uuid,entry_version integer,entry_origin text,competence_on date);
create function erp_finance.statement_lines(p_account uuid,p_from date,p_to date,p_deleted boolean)
returns setof erp_finance.statement_line language sql stable set search_path=pg_catalog as $$
  -- Cash entries: current values; their category is the one of the active posting.
  select e.id,'entry',e.posted_on,e.created_at,e.account_id,case when e.kind='in' then e.amount_cents else -e.amount_cents end,
    (select m.category_id from erp_finance.movement m where m.entry_id=e.id and m.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=m.id) order by m.created_at desc limit 1),
    e.contact_id,e.note,null::uuid,null::text,null::uuid,e.id,e.version,e.origin,e.competence_on
  from erp_finance.cash_entry e
  where (p_account is null or e.account_id=p_account) and (p_from is null or e.posted_on>=p_from) and (p_to is null or e.posted_on<=p_to)
    and (e.deleted_at is not null)=p_deleted
  union all
  -- Transfer legs of transfers that are neither excluded nor the inverse of an excluded one.
  select m.id,'transfer',m.posted_on,m.created_at,m.account_id,m.delta_cents,m.category_id,null,m.note,null,null,m.transfer_id,null,null,null,m.posted_on
  from erp_finance.movement m
  where m.transfer_id is not null and (p_account is null or m.account_id=p_account) and (p_from is null or m.posted_on>=p_from) and (p_to is null or m.posted_on<=p_to)
    and not exists(select 1 from erp_finance.transfer_deletion d where d.reversal_id=m.transfer_id)
    and exists(select 1 from erp_finance.transfer_deletion d where d.transfer_id=m.transfer_id)=p_deleted
  union all
  -- Baixas, estornos and tarifas of retorno: never excluded from the extrato (they are undone by the borderô).
  -- A tarifa of a retorno (058) carries the fee category of its plan.
  select m.id,'settlement',m.posted_on,m.created_at,m.account_id,m.delta_cents,
    case when m.kind in ('bank_fee','bank_fee_reversal') then coalesce((select p.category_id from erp_finance.cnab_plan_for_settlement(s.id) p),i.category_id,b.category_id,t.category_id) else coalesce(i.category_id,b.category_id,t.category_id) end,t.contact_id,
    coalesce(m.note,t.description),t.id,t.kind,null,null,null,null,t.competence_on
  from erp_finance.movement m join erp_finance.settlement s on s.id=m.settlement_id join erp_finance.title t on t.id=s.title_id
    left join erp_finance.bordero_item i on i.settlement_id=coalesce(s.reverses_id,s.id) left join erp_finance.bordero b on b.id=i.bordero_id
  where not p_deleted and (p_account is null or m.account_id=p_account) and (p_from is null or m.posted_on>=p_from) and (p_to is null or m.posted_on<=p_to)
  union all
  select m.id,'opening',m.posted_on,m.created_at,m.account_id,m.delta_cents,m.category_id,null,coalesce(m.note,'Saldo inicial'),null,null,null,null,null,null,m.posted_on
  from erp_finance.movement m
  where m.kind='opening' and not p_deleted and (p_account is null or m.account_id=p_account) and (p_from is null or m.posted_on>=p_from) and (p_to is null or m.posted_on<=p_to);
$$;

create function erp_finance.statement_line_dto(p_line erp_finance.statement_line)
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
    'entry_origin',p_line.entry_origin);
end $$;

-- Caixas e bancos > extrato: Todas contas ou uma conta, período, abas Movimentações | Entradas | Saídas, Situação
-- (Registrados | Excluídos), Categoria, Valor e Pesquisa; saldo anterior, saldos diários e Informações do período.
create function public.erp_finance_statement_page(p_user_id uuid,p_account uuid default null,p_from date default null,p_to date default null,
  p_tab text default 'all',p_deleted boolean default false,p_categories text[] default null,p_amount_cents bigint default null,p_query text default null,
  p_order text default 'asc',p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_categories uuid[]; v_none boolean:=false; v_total bigint; v_items jsonb; v_days jsonb; v_summary jsonb; v_accounts uuid[];
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_tab is null or p_tab not in ('all','in','out') or p_deleted is null or p_order is null or p_order not in ('asc','desc') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' or p_amount_cents not between 1 and 999999999999999
    or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_from>p_to or p_to-p_from>3660
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
  ), page as (
    select * from filtered order by case when p_order='asc' then posted_on end asc, case when p_order='desc' then posted_on end desc,
      case when p_order='asc' then created_at end asc, case when p_order='desc' then created_at end desc, line_id
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(erp_finance.statement_line_dto(row(p.line_id,p.line_kind,p.posted_on,p.created_at,p.account_id,p.amount_cents,p.category_id,p.contact_id,p.note,
      p.title_id,p.title_kind,p.transfer_id,p.entry_id,p.entry_version,p.entry_origin,p.competence_on)::erp_finance.statement_line) order by case when p_order='asc' then p.posted_on end asc, case when p_order='desc' then p.posted_on end desc,
      case when p_order='asc' then p.created_at end asc, case when p_order='desc' then p.created_at end desc, p.line_id),'[]'::jsonb) from page p),
    -- Saldo ao fim de cada dia da página: todos os movimentos das contas até o dia (o razão inteiro, não o filtro).
    (select coalesce(jsonb_object_agg(d.on_day::text,(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=d.on_day)::text),'{}'::jsonb)
      from (select distinct posted_on as on_day from page) d),
    -- Informações: Saldo inicial (before the period, plus a saldo inicial of a conta opened in it) · Entradas · Saídas · Saldo final.
    (select jsonb_build_object('before_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)::text,
      'previous_cents',((select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)
        +(select coalesce(sum(amount_cents),0) from lines where line_kind='opening' and not p_deleted))::text,
      'in_cents',(select coalesce(sum(amount_cents),0) from lines where amount_cents>0 and line_kind<>'opening' and not p_deleted)::text,
      'out_cents',(select coalesce(sum(-amount_cents),0) from lines where amount_cents<0 and line_kind<>'opening' and not p_deleted)::text,
      'closing_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=p_to)::text,
      'current_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts))::text))
  into v_total,v_items,v_days,v_summary;
  return jsonb_build_object('entity','statement','account_id',p_account,'from',p_from,'to',p_to,'tab',p_tab,'deleted',p_deleted,'order',p_order,'page',p_page,'limit',p_limit,
    'total',v_total,'items',v_items,'day_balances',case when p_deleted then '{}'::jsonb else v_days end,'summary',v_summary,'data_mode','erp_native');
end $$;

create function erp_finance.cash_entry_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',e.id,'account_id',e.account_id,'account_name',a.name,'kind',e.kind,'amount_cents',e.amount_cents::text,'posted_on',e.posted_on,'competence_on',e.competence_on,
    'category_id',m.category_id,'category_name',g.name,'contact_id',e.contact_id,'contact_name',r.name,'note',e.note,'origin',e.origin,'version',e.version,
    'deleted',e.deleted_at is not null,'created_at',e.created_at,'updated_at',e.updated_at)
  from erp_finance.cash_entry e join erp_finance.account a on a.id=e.account_id left join erp_catalog.record r on r.id=e.contact_id
    left join lateral (select x.category_id from erp_finance.movement x where x.entry_id=e.id and x.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=x.id) order by x.created_at desc limit 1) m on true
    left join erp_finance.category g on g.id=m.category_id
  where e.id=p_id;
$$;
create function public.erp_finance_cash_entry_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  v:=erp_finance.cash_entry_view(p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','cash_entries','record',v,'data_mode','erp_native');
end $$;

-- Lock order of the cash writers: accounts by id, then the entry. Same command namespace and audit as 010.
create function erp_finance.cash_account(p_id uuid)
returns erp_finance.account language plpgsql set search_path=pg_catalog as $$
declare v erp_finance.account%rowtype;
begin
  select * into v from erp_finance.account where id=p_id for update;
  if not found or v.deleted_at is not null or not v.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.cash_category(p_value jsonb,p_kind text)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare v uuid:=erp_finance.uuid_value(p_value,false);
begin
  if v is null then return null; end if;
  perform 1 from erp_finance.category where id=v and active and deleted_at is null and (p_kind is null or kind=p_kind) for share;
  if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.cash_contact(p_value jsonb)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare v uuid:=erp_finance.uuid_value(p_value,false);
begin
  if v is null then return null; end if;
  if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v and r.active) then raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.cash_post(p_entry erp_finance.cash_entry,p_category uuid,p_user uuid,p_command uuid)
returns void language plpgsql set search_path=pg_catalog as $$
begin
  if exists(select 1 from erp_finance.movement where account_id=p_entry.account_id and kind='opening' and posted_on>p_entry.posted_on) then raise exception 'erp_finance_payment_before_opening' using errcode='22023'; end if;
  insert into erp_finance.movement(account_id,entry_id,kind,delta_cents,posted_on,note,actor,command_id,category_id)
    values(p_entry.account_id,p_entry.id,'entry',case when p_entry.kind='in' then p_entry.amount_cents else -p_entry.amount_cents end,p_entry.posted_on,left(p_entry.note,500),p_user,p_command,p_category);
end $$;
create function erp_finance.cash_compensate(p_entry uuid,p_user uuid,p_command uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare m erp_finance.movement%rowtype;
begin
  select * into m from erp_finance.movement x where x.entry_id=p_entry and x.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=x.id) order by x.created_at desc limit 1;
  if not found then raise exception 'erp_finance_entry_state' using errcode='40001'; end if;
  insert into erp_finance.movement(account_id,entry_id,compensates_id,kind,delta_cents,posted_on,note,actor,command_id,category_id)
    values(m.account_id,m.entry_id,m.id,'entry_reversal',-m.delta_cents,m.posted_on,m.note,p_user,p_command,m.category_id);
  return m.category_id;
end $$;
create function erp_finance.find_or_create_category(p_name text,p_kind text)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare v uuid;
begin
  select id into v from erp_finance.category where kind=p_kind and parent_id is null and deleted_at is null and lower(name)=lower(p_name) order by active desc,id limit 1;
  if v is null then
    -- Only the first transfer creates it: under the tree lock of 135 (one writer of siorigin names), looked up again.
    perform pg_advisory_xact_lock(hashtextextended('erp_finance.category_tree',0));
    select id into v from erp_finance.category where kind=p_kind and parent_id is null and deleted_at is null and lower(name)=lower(p_name) order by active desc,id limit 1;
    if v is null then insert into erp_finance.category(name,kind) values(p_name,p_kind) returning id into v; end if;
  end if;
  return v;
end $$;
create function erp_finance.cash_text(p_data jsonb,p_key text,p_limit integer,p_required boolean)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  v:=erp_finance.txt(p_data,p_key,p_limit,p_required);
  if v~'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;

-- Gravação: lançamento (incluir, editar, excluir, restaurar), ajuste de saldo, transferência (incluir, excluir) e a
-- categoria de uma linha do extrato (lançamento, transferência ou baixa), com a versão ou a categoria vista como CAS.
create function public.erp_finance_cash_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_entry erp_finance.cash_entry%rowtype; v_old erp_finance.cash_entry%rowtype; v_account erp_finance.account%rowtype;
  v_from erp_finance.account%rowtype; v_to erp_finance.account%rowtype; v_transfer erp_finance.transfer%rowtype; v_result jsonb; v_before jsonb; v_id uuid; v_kind text;
  v_amount bigint; v_day date; v_in_day date; v_competence date; v_category uuid; v_contact uuid; v_note text; v_origin text; v_float integer; v_reversal uuid; v_balance numeric;
  v_desired bigint; v_line_kind text; v_movement erp_finance.movement%rowtype; v_settlement erp_finance.settlement%rowtype; v_expected uuid; v_current uuid; v_out_category uuid; v_in_category uuid;
  ca jsonb; cb jsonb;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('entry_save','entry_delete','entry_restore','balance_adjust','transfer_create','transfer_delete','line_categorize') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='entry_save' then
    perform erp_finance.keys(p_data,array['id','expected_version','account_id','kind','amount_cents','posted_on','competence_on','category_id','contact_id','note','origin']);
    v_id:=erp_finance.uuid_value(p_data->'id',false);
    v_kind:=erp_finance.txt(p_data,'kind',3,true); if v_kind not in ('in','out') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_amount:=erp_finance.cents(p_data->'amount_cents',false); v_day:=erp_finance.day(p_data->'posted_on'); v_competence:=erp_finance.day(p_data->'competence_on');
    v_note:=erp_finance.cash_text(p_data,'note',2000,true); v_contact:=erp_finance.cash_contact(p_data->'contact_id');
    v_category:=erp_finance.cash_category(p_data->'category_id',null);
    v_origin:=coalesce(erp_finance.txt(p_data,'origin',20),'manual'); if v_origin not in ('manual','ledger') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if v_id is null then
      perform erp_finance.expected(p_data->'expected_version',true);
      v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
      insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,contact_id,note,origin,actor,command_id)
        values(v_account.id,v_kind,v_amount,v_day,v_competence,v_contact,v_note,v_origin,p_user_id,p_command_id) returning * into v_entry;
      perform erp_finance.cash_post(v_entry,v_category,p_user_id,p_command_id);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
    else
      select * into v_old from erp_finance.cash_entry where id=v_id;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      -- Accounts first (old and new, by id), then the entry: the order of every cash writer.
      perform 1 from erp_finance.account where id in (v_old.account_id,erp_finance.uuid_value(p_data->'account_id')) order by id for update;
      select * into v_old from erp_finance.cash_entry where id=v_id for update;
      if v_old.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      -- A Registro de Caixa "Criado via conciliação" or imported (138) is a lançamento like the others once created: no other
      -- routine changes it. While reconciled, 137 keeps its value, date, type and account (reconciled_entry_guard).
      if v_old.deleted_at is not null or v_old.origin not in ('manual','ledger','reconciliation','import') then raise exception 'erp_finance_entry_state' using errcode='40001'; end if;
      v_before:=erp_finance.cash_entry_view(v_id);
      v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
      if (v_account.id,v_kind,v_amount,v_day) is distinct from (v_old.account_id,v_old.kind,v_old.amount_cents,v_old.posted_on) then
        -- Changing the value, the date, the type or the account compensates the active posting on its date and posts again.
        perform erp_finance.cash_compensate(v_id,p_user_id,p_command_id);
        update erp_finance.cash_entry set account_id=v_account.id,kind=v_kind,amount_cents=v_amount,posted_on=v_day,competence_on=v_competence,contact_id=v_contact,note=v_note,
          version=version+1,updated_at=clock_timestamp() where id=v_id returning * into v_entry;
        perform erp_finance.cash_post(v_entry,v_category,p_user_id,p_command_id);
        update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in (v_old.account_id,v_account.id);
      else
        update erp_finance.cash_entry set competence_on=v_competence,contact_id=v_contact,note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_id returning * into v_entry;
        perform set_config('erp_finance.reclassify','on',true);
        update erp_finance.movement x set category_id=v_category where x.entry_id=v_id and x.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=x.id);
        perform set_config('erp_finance.reclassify','',true);
      end if;
    end if;
    v_result:=jsonb_build_object('entity','cash_entries','record',erp_finance.cash_entry_view(v_entry.id));

  elsif p_action in ('entry_delete','entry_restore') then
    perform erp_finance.keys(p_data,array['id','expected_version','note']);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_old from erp_finance.cash_entry where id=v_id;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    perform 1 from erp_finance.account where id=v_old.account_id for update;
    select * into v_old from erp_finance.cash_entry where id=v_id for update;
    if v_old.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.cash_entry_view(v_id); v_note:=erp_finance.cash_text(p_data,'note',500,false);
    if p_action='entry_delete' then
      -- A reconciled lançamento (any origin) is refused by 137 reconciled_entry_guard until the conciliação is undone.
      if v_old.deleted_at is not null then raise exception 'erp_finance_entry_state' using errcode='40001'; end if;
      perform erp_finance.cash_compensate(v_id,p_user_id,p_command_id);
      update erp_finance.cash_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note=v_note,version=version+1,updated_at=clock_timestamp() where id=v_id returning * into v_entry;
    else
      if v_old.deleted_at is null then raise exception 'erp_finance_entry_state' using errcode='40001'; end if;
      v_account:=erp_finance.cash_account(v_old.account_id);
      -- Restaurar: a new posting with the category the entry had when it was excluded.
      select m.category_id into v_category from erp_finance.movement m where m.entry_id=v_id and m.kind='entry_reversal' order by m.created_at desc limit 1;
      update erp_finance.cash_entry set deleted_at=null,deleted_by=null,deleted_note=null,version=version+1,updated_at=clock_timestamp() where id=v_id returning * into v_entry;
      perform erp_finance.cash_post(v_entry,v_category,p_user_id,p_command_id);
    end if;
    update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_old.account_id;
    v_result:=jsonb_build_object('entity','cash_entries','record',erp_finance.cash_entry_view(v_id),'note',v_note);

  elsif p_action='balance_adjust' then
    -- Ajustar saldos: a lançamento with the difference between the desired and the current balance, on the date of the adjustment.
    perform erp_finance.keys(p_data,array['account_id','desired_cents','current_cents','posted_on']);
    v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
    v_desired:=erp_finance.cents(p_data->'desired_cents',true,true); v_day:=erp_finance.day(p_data->'posted_on',true);
    select coalesce(sum(delta_cents),0) into v_balance from erp_finance.movement where account_id=v_account.id;
    if v_balance::text<>(p_data->>'current_cents') or jsonb_typeof(p_data->'current_cents')<>'string' then raise exception 'erp_finance_balance_changed' using errcode='40001'; end if;
    if v_desired=v_balance then raise exception 'erp_finance_invalid_cents' using errcode='22023'; end if;
    insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,note,origin,actor,command_id)
      values(v_account.id,case when v_desired>v_balance then 'in' else 'out' end,abs(v_desired-v_balance)::bigint,v_day,v_day,'Ajuste de saldo','adjustment',p_user_id,p_command_id) returning * into v_entry;
    perform erp_finance.cash_post(v_entry,null,p_user_id,p_command_id);
    update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
    v_result:=jsonb_build_object('entity','cash_entries','record',erp_finance.cash_entry_view(v_entry.id),'balance_cents',v_desired::text);

  elsif p_action='transfer_create' then
    -- Transferência entre contas: "Transferência A -> B", categorias de transferência e float bancário na perna de entrada.
    perform erp_finance.keys(p_data,array['from_account_id','to_account_id','amount_cents','posted_on','float_days','note']);
    if erp_finance.uuid_value(p_data->'from_account_id')=erp_finance.uuid_value(p_data->'to_account_id') then raise exception 'erp_finance_transfer_invalid' using errcode='22023'; end if;
    perform 1 from erp_finance.account where id in (erp_finance.uuid_value(p_data->'from_account_id'),erp_finance.uuid_value(p_data->'to_account_id')) order by id for update;
    v_from:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'from_account_id')); v_to:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'to_account_id'));
    v_amount:=erp_finance.cents(p_data->'amount_cents',false); v_day:=erp_finance.day(p_data->'posted_on',true);
    if jsonb_typeof(coalesce(p_data->'float_days','0'::jsonb))<>'number' or coalesce(p_data->>'float_days','0')!~'^[0-9]{1,2}$' or coalesce((p_data->>'float_days')::integer,0)>30 then raise exception 'erp_finance_transfer_invalid' using errcode='22023'; end if;
    v_float:=coalesce((p_data->>'float_days')::integer,0); v_in_day:=v_day+v_float;
    v_note:=coalesce(erp_finance.cash_text(p_data,'note',500,false),left(format('Transferência %s -> %s',v_from.name,v_to.name),500));
    if exists(select 1 from erp_finance.movement where account_id in (v_from.id,v_to.id) and kind='opening' and posted_on>v_day) then raise exception 'erp_finance_transfer_before_opening' using errcode='22023'; end if;
    v_out_category:=erp_finance.find_or_create_category('Transferências de saída','payable');
    v_in_category:=coalesce((select d.category_id from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id where d.key='transfer_in' and c.active and c.deleted_at is null),
      erp_finance.find_or_create_category('Transferências de entrada','receivable'));
    ca:=erp_finance.transfer_account(v_from.id); cb:=erp_finance.transfer_account(v_to.id);
    insert into erp_finance.transfer(command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot,in_posted_on,float_days)
      values(p_command_id,p_user_id,v_from.id,v_to.id,v_amount,v_day,v_note,
        jsonb_build_object('id',v_from.id,'name',v_from.name,'kind',v_from.kind,'version_before',v_from.version,'version_after',v_from.version+1,'balance_before_cents',ca->>'balance_cents','balance_after_cents',((ca->>'balance_cents')::numeric-v_amount)::text,'opening_on',ca->'opening_on'),
        jsonb_build_object('id',v_to.id,'name',v_to.name,'kind',v_to.kind,'version_before',v_to.version,'version_after',v_to.version+1,'balance_before_cents',cb->>'balance_cents','balance_after_cents',((cb->>'balance_cents')::numeric+v_amount)::text,'opening_on',cb->'opening_on'),
        case when v_float>0 then v_in_day end,v_float) returning * into v_transfer;
    insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id,category_id)
      values(v_from.id,'transfer_out',-v_amount,v_day,v_note,p_user_id,p_command_id,v_transfer.id,v_out_category),(v_to.id,'transfer_in',v_amount,v_in_day,v_note,p_user_id,p_command_id,v_transfer.id,v_in_category);
    update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in (v_from.id,v_to.id);
    v_result:=jsonb_build_object('entity','transfers','record',jsonb_build_object('id',v_transfer.id,'from_account_id',v_from.id,'to_account_id',v_to.id,'amount_cents',v_amount::text,
      'posted_on',v_day,'in_posted_on',v_in_day,'float_days',v_float,'note',v_note));

  elsif p_action='transfer_delete' then
    -- Excluir transferência: the inverse transfer on the dates of the original legs; the original stays as history.
    perform erp_finance.keys(p_data,array['transfer_id','note']);
    select * into v_transfer from erp_finance.transfer where id=erp_finance.uuid_value(p_data->'transfer_id');
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    perform 1 from erp_finance.account where id in (v_transfer.from_account_id,v_transfer.to_account_id) order by id for update;
    if exists(select 1 from erp_finance.transfer_deletion where transfer_id=v_transfer.id or reversal_id=v_transfer.id) then raise exception 'erp_finance_transfer_deleted' using errcode='40001'; end if;
    v_note:=erp_finance.cash_text(p_data,'note',500,false);
    select * into v_from from erp_finance.account where id=v_transfer.to_account_id; select * into v_to from erp_finance.account where id=v_transfer.from_account_id;
    if v_from.deleted_at is not null or v_to.deleted_at is not null then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
    v_reversal:=gen_random_uuid(); ca:=erp_finance.transfer_account(v_from.id); cb:=erp_finance.transfer_account(v_to.id);
    insert into erp_finance.transfer(id,command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot,in_posted_on,float_days)
      values(v_reversal,p_command_id,p_user_id,v_from.id,v_to.id,v_transfer.amount_cents,coalesce(v_transfer.in_posted_on,v_transfer.posted_on),v_transfer.note,
        jsonb_build_object('id',v_from.id,'name',v_from.name,'kind',v_from.kind,'version_before',v_from.version,'version_after',v_from.version+1,'balance_before_cents',ca->>'balance_cents','balance_after_cents',((ca->>'balance_cents')::numeric-v_transfer.amount_cents)::text,'opening_on',ca->'opening_on'),
        jsonb_build_object('id',v_to.id,'name',v_to.name,'kind',v_to.kind,'version_before',v_to.version,'version_after',v_to.version+1,'balance_before_cents',cb->>'balance_cents','balance_after_cents',((cb->>'balance_cents')::numeric+v_transfer.amount_cents)::text,'opening_on',cb->'opening_on'),
        case when v_transfer.in_posted_on is not null then v_transfer.posted_on end,0);
    insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id,category_id)
      select v_from.id,'transfer_out',-v_transfer.amount_cents,coalesce(v_transfer.in_posted_on,v_transfer.posted_on),v_transfer.note,p_user_id,p_command_id,v_reversal,(select category_id from erp_finance.movement where transfer_id=v_transfer.id and kind='transfer_in')
      union all select v_to.id,'transfer_in',v_transfer.amount_cents,v_transfer.posted_on,v_transfer.note,p_user_id,p_command_id,v_reversal,(select category_id from erp_finance.movement where transfer_id=v_transfer.id and kind='transfer_out');
    insert into erp_finance.transfer_deletion(transfer_id,reversal_id,actor,command_id,note) values(v_transfer.id,v_reversal,p_user_id,p_command_id,v_note);
    update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in (v_from.id,v_to.id);
    v_result:=jsonb_build_object('entity','transfers','record',jsonb_build_object('id',v_transfer.id,'deleted',true,'reversal_id',v_reversal),'note',v_note);

  else
    -- Alterar categorias: one line of the extrato; the category the user saw is the CAS.
    perform erp_finance.keys(p_data,array['line_kind','line_id','expected_category_id','category_id']);
    v_line_kind:=erp_finance.txt(p_data,'line_kind',20,true); v_id:=erp_finance.uuid_value(p_data->'line_id');
    v_expected:=erp_finance.uuid_value(p_data->'expected_category_id',false);
    if not p_data?'expected_category_id' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    perform set_config('erp_finance.reclassify','on',true);
    if v_line_kind='entry' then
      select * into v_old from erp_finance.cash_entry where id=v_id for update;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if v_old.deleted_at is not null then raise exception 'erp_finance_entry_state' using errcode='40001'; end if;
      select * into v_movement from erp_finance.movement x where x.entry_id=v_id and x.kind='entry' and not exists(select 1 from erp_finance.movement c where c.compensates_id=x.id) order by x.created_at desc limit 1 for update;
      v_category:=erp_finance.cash_category(p_data->'category_id',null);
      if v_movement.category_id is distinct from v_expected then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      update erp_finance.movement set category_id=v_category where id=v_movement.id;
      update erp_finance.cash_entry set version=version+1,updated_at=clock_timestamp() where id=v_id;
    elsif v_line_kind='transfer' then
      select * into v_movement from erp_finance.movement where id=v_id and transfer_id is not null for update;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if exists(select 1 from erp_finance.transfer_deletion where transfer_id=v_movement.transfer_id or reversal_id=v_movement.transfer_id) then raise exception 'erp_finance_transfer_deleted' using errcode='40001'; end if;
      v_category:=erp_finance.cash_category(p_data->'category_id',null);
      if v_movement.category_id is distinct from v_expected then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      update erp_finance.movement set category_id=v_category where id=v_id;
    elsif v_line_kind='settlement' then
      -- A baixa line changes the category of the baixa in its borderô (the category of the conta stays).
      select * into v_movement from erp_finance.movement where id=v_id and settlement_id is not null;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      -- The tarifa of a retorno (058) keeps the fee category of its immutable plan; only the baixa itself is reclassified.
      if v_movement.kind in ('bank_fee','bank_fee_reversal') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      select * into v_settlement from erp_finance.settlement where id=v_movement.settlement_id;
      select t.kind into v_kind from erp_finance.title t where t.id=v_settlement.title_id;
      v_category:=erp_finance.cash_category(p_data->'category_id',v_kind);
      select coalesce(i.category_id,b.category_id,t.category_id) into v_current from erp_finance.bordero_item i join erp_finance.bordero b on b.id=i.bordero_id
        join erp_finance.settlement s on s.id=i.settlement_id join erp_finance.title t on t.id=s.title_id where i.settlement_id=coalesce(v_settlement.reverses_id,v_settlement.id) for update of i;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if v_current is distinct from v_expected then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      update erp_finance.bordero_item set category_id=v_category where settlement_id=coalesce(v_settlement.reverses_id,v_settlement.id);
    else raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    perform set_config('erp_finance.reclassify','',true);
    v_result:=jsonb_build_object('entity','statement','record',jsonb_build_object('line_kind',v_line_kind,'line_id',v_id,'category_id',v_category));
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Ficha financeira do contato
-- Contas a receber e a pagar do contato (débito na emissão de uma conta a receber, crédito na de uma conta a pagar), as
-- baixas (o inverso) e os lançamentos da ficha (entrada = crédito, saída = débito), no período, com os totais e o saldo.
create function public.erp_finance_contact_ledger(p_user_id uuid,p_contact uuid,p_scope text default 'all',p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_debit numeric; v_credit numeric;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_contact is null or p_scope is null or p_scope not in ('all','receivable','payable') or p_from is null or p_to is null or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_to-p_from>3660 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if not exists(select 1 from erp_catalog.contact where record_id=p_contact) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  with rows as (
    select t.issued_on as on_day,t.created_at as at_ts,'title' line_kind,t.id ref_id,t.kind,
      case when t.installments>1 then format('%s %s/%s',t.description,t.installment,t.installments) else t.description end note,
      t.due_on,case when t.kind='receivable' then 'debit' else 'credit' end side,t.amount_cents amount,
      case when t.cancelled then 'cancelled' when t.settled_cents=t.amount_cents then 'paid' when t.settled_cents>0 then 'partial' when t.due_on=v_today then 'due_today' when t.due_on<v_today then 'overdue' else 'open' end situation,
      (select jsonb_build_object('kind',d.kind,'number',d.number::text) from erp_finance.document_title l join erp_finance.document_posting dp on dp.id=l.posting_id join erp_documents.document d on d.id=dp.document_id where l.title_id=t.id limit 1) origin,
      null::integer version
    from erp_finance.title t where t.contact_id=p_contact and t.deleted_at is null and (p_scope='all' or t.kind=p_scope) and t.issued_on between p_from and p_to
    union all
    select s.posted_on,s.created_at,case when s.kind='payment' then 'payment' else 'reversal' end,s.id,t.kind,
      coalesce(s.note,t.description),t.due_on,
      case when (t.kind='receivable')=(s.kind='payment') then 'credit' else 'debit' end,s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents,null,null,null
    from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id where t.contact_id=p_contact and (p_scope='all' or t.kind=p_scope) and s.posted_on between p_from and p_to
    union all
    select e.posted_on,e.created_at,'entry',e.id,case when e.kind='in' then 'receivable' else 'payable' end,e.note,null,case when e.kind='in' then 'credit' else 'debit' end,e.amount_cents,null,null,e.version
    from erp_finance.cash_entry e where e.contact_id=p_contact and e.deleted_at is null and (p_scope='all' or (p_scope='receivable' and e.kind='in') or (p_scope='payable' and e.kind='out')) and e.posted_on between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object('day',on_day,'line_kind',line_kind,'ref_id',ref_id,'kind',kind,'note',note,'due_on',due_on,'side',side,'amount_cents',amount::text,
      'situation',situation,'origin',origin,'version',version) order by on_day,at_ts,ref_id),'[]'::jsonb),
    coalesce(sum(amount) filter (where side='debit' and situation is distinct from 'cancelled'),0),coalesce(sum(amount) filter (where side='credit' and situation is distinct from 'cancelled'),0)
  into v_items,v_debit,v_credit from rows;
  if jsonb_array_length(v_items)>5000 then raise exception 'erp_finance_ledger_limit' using errcode='54000'; end if;
  return jsonb_build_object('entity','contact_ledger','contact_id',p_contact,'contact_name',(select name from erp_catalog.record where id=p_contact),'scope',p_scope,'from',p_from,'to',p_to,
    'items',v_items,'totals',jsonb_build_object('debit_cents',v_debit::text,'credit_cents',v_credit::text,'balance_cents',(v_credit-v_debit)::text),'data_mode','erp_native');
end $$;

revoke all on function erp_finance.entry_movement_immutable(),erp_finance.transfer_leg_check(),erp_finance.statement_lines(uuid,date,date,boolean),erp_finance.statement_line_dto(erp_finance.statement_line),
  erp_finance.cash_entry_view(uuid),erp_finance.cash_account(uuid),erp_finance.cash_category(jsonb,text),erp_finance.cash_contact(jsonb),
  erp_finance.cash_post(erp_finance.cash_entry,uuid,uuid,uuid),erp_finance.cash_compensate(uuid,uuid,uuid),erp_finance.find_or_create_category(text,text),
  erp_finance.cash_text(jsonb,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer),public.erp_finance_cash_entry_get(uuid,uuid),
  public.erp_finance_cash_execute(uuid,uuid,text,jsonb),public.erp_finance_contact_ledger(uuid,uuid,text,date,date) from public,anon,authenticated;
grant execute on function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer),public.erp_finance_cash_entry_get(uuid,uuid),
  public.erp_finance_cash_execute(uuid,uuid,text,jsonb),public.erp_finance_contact_ledger(uuid,uuid,text,date,date) to service_role;
commit;
