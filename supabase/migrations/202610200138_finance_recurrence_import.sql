-- Contas recorrentes e Importação de registros financeiros no padrão Origin.
-- Recorrentes: uma conta com ocorrência Semanal, Quinzenal, Mensal, Bimestral, Trimestral, Semestral ou Anual cria a
-- recorrência e a primeira conta; "Gerar contas" cria a próxima, uma por comando e uma por data (nunca em dobro), até a
-- data limite, com dias úteis (feriados nacionais, Carnaval, Sexta-feira Santa e Corpus Christi) quando pedido.
-- Importação: planilha CSV de contas a receber, a pagar ou registros de caixa; o banco confere cada linha (contato pelo
-- CPF/CNPJ ou nome, categoria e conta pelo nome) e só insere as linhas novas, guardando a impressão digital de cada uma.
begin;

-- ---------------------------------------------------------------- Dias úteis
create function erp_finance.easter(p_year integer)
returns date language plpgsql immutable set search_path=pg_catalog as $$
declare a integer:=p_year%19; b integer:=p_year/100; c integer:=p_year%100; d integer; e integer; f integer; g integer; h integer; i integer; k integer; l integer; m integer;
begin
  d:=b/4; e:=b%4; f:=(b+8)/25; g:=(b-f+1)/3; h:=(19*a+b-d-g+15)%30; i:=c/4; k:=c%4; l:=(32+2*e+2*i-h-k)%7; m:=(a+11*h+22*l)/451;
  return make_date(p_year,(h+l-7*m+114)/31,((h+l-7*m+114)%31)+1);
end $$;
create function erp_finance.is_business_day(p_day date)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare v_easter date:=erp_finance.easter(extract(year from p_day)::integer); v_md text:=to_char(p_day,'MM-DD');
begin
  if extract(isodow from p_day) in (6,7) then return false; end if;
  if v_md in ('01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25') or (v_md='11-20' and extract(year from p_day)>=2024) then return false; end if;
  return p_day not in (v_easter-48,v_easter-47,v_easter-2,v_easter+60);
end $$;
create function erp_finance.next_business_day(p_day date)
returns date language plpgsql immutable set search_path=pg_catalog as $$
declare v date:=p_day; n integer:=0;
begin
  while not erp_finance.is_business_day(v) and n<15 loop v:=v+1; n:=n+1; end loop;
  return v;
end $$;

-- ---------------------------------------------------------------- Recorrências
create table erp_finance.recurrence (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('receivable','payable')),
  contact_id uuid not null references erp_catalog.contact(record_id),
  category_id uuid references erp_finance.category(id), account_id uuid references erp_finance.account(id),
  description text not null check(length(description) between 1 and 240), source_reference text check(source_reference is null or length(source_reference) between 1 and 200),
  bank_number text check(bank_number is null or length(bank_number) between 1 and 60),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
  interest_month_bp integer not null default 0 check(interest_month_bp between 0 and 10000), penalty_bp integer not null default 0 check(penalty_bp between 0 and 10000),
  frequency text not null check(frequency in ('weekly','biweekly','monthly','bimonthly','quarterly','semiannual','annual')),
  due_day integer check(due_day between 1 and 31), second_day integer check(second_day between 1 and 31), weekday integer check(weekday between 0 and 6),
  check((frequency='weekly' and weekday is not null and due_day is null and second_day is null) or (frequency='biweekly' and due_day is not null and second_day is not null and weekday is null and second_day<>due_day)
    or (frequency not in ('weekly','biweekly') and due_day is not null and second_day is null and weekday is null)),
  business_days boolean not null default false, end_on date, lead_days integer not null check(lead_days between 0 and 3660),
  next_on date, generated integer not null default 1 check(generated>=1),
  active boolean not null default true, version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
alter table erp_finance.recurrence enable row level security;
revoke all on erp_finance.recurrence from public,anon,authenticated,service_role;
alter table erp_finance.title add column recurrence_id uuid references erp_finance.recurrence(id), add column recurrence_on date;
alter table erp_finance.title add constraint title_recurrence_check check((recurrence_id is null)=(recurrence_on is null));
create unique index erp_finance_title_recurrence on erp_finance.title(recurrence_id,recurrence_on) where recurrence_id is not null;
create index erp_finance_recurrence_category on erp_finance.recurrence(category_id) where category_id is not null;
create index erp_finance_recurrence_account on erp_finance.recurrence(account_id) where account_id is not null;

-- A recurrence keeps generating contas with its categoria and conta financeira: both count as a use (135), so neither is
-- excluded while a recurrence points to it (inativar stays possible).
create or replace function erp_finance.category_in_use(p_id uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from erp_finance.title where category_id=p_id) or exists(select 1 from erp_finance.bordero where category_id=p_id)
    or exists(select 1 from erp_finance.bordero_item where category_id=p_id) or exists(select 1 from erp_finance.movement where category_id=p_id)
    or exists(select 1 from erp_finance.cnab_cash_plan where category_id=p_id) or exists(select 1 from erp_finance.recurrence where category_id=p_id);
$$;
create or replace function erp_finance.account_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'account_type',a.account_type,'institution_code',a.institution_code,'institution_name',a.institution_name,
    'agency',a.agency,'account_number',a.account_number,'account_digit',a.account_digit,'start_on',a.start_on,'active',a.active,
    'default_movements',a.default_movements,'default_boleto',a.default_boleto,
    'boleto',case when a.default_boleto then 'default' when p.id is not null then 'active' else 'none' end,
    'opening_recorded',a.opening_recorded,'opening_cents',(select m.delta_cents::text from erp_finance.movement m where m.account_id=a.id and m.kind='opening'),
    'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text,
    'first_movement_on',(select min(m.posted_on) from erp_finance.movement m where m.account_id=a.id),
    'in_use',exists(select 1 from erp_finance.movement m where m.account_id=a.id) or exists(select 1 from erp_finance.title t where t.account_id=a.id)
      or p.id is not null or exists(select 1 from erp_finance.bordero b where b.account_id=a.id) or exists(select 1 from erp_finance.recurrence r where r.account_id=a.id),
    'cnab',case when p.id is null then null else jsonb_build_object('bank',p.identity->>'bank','agency',p.identity->>'agency','account',p.identity->>'account','account_digit',p.identity->>'accountDigit') end,
    'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at)
  from erp_finance.account a left join erp_cnab.profile p on p.account_id=a.id where a.id=p_id and a.deleted_at is null;
$$;
revoke all on function erp_finance.category_in_use(uuid),erp_finance.account_view(uuid) from public,anon,authenticated,service_role;

-- Next nominal date after p_from: one week, the two days of the month (Quinzenal) or the dia de vencimento of the next
-- month of the step, capped at the last day of that month.
create function erp_finance.recurrence_next(p_frequency text,p_due_day integer,p_second_day integer,p_from date)
returns date language plpgsql immutable set search_path=pg_catalog as $$
declare v_step integer; v_month date; v_candidate date; v_days integer[];
begin
  if p_frequency='weekly' then return p_from+7; end if;
  if p_frequency='biweekly' then
    v_days:=array[least(p_due_day,p_second_day),greatest(p_due_day,p_second_day)];
    for k in 0..2 loop
      v_month:=(date_trunc('month',p_from)+make_interval(months=>k))::date;
      foreach v_step in array v_days loop
        v_candidate:=v_month+(least(v_step,extract(day from (v_month+interval '1 month'-interval '1 day'))::integer)-1);
        if v_candidate>p_from then return v_candidate; end if;
      end loop;
    end loop;
    return null;
  end if;
  v_step:=case p_frequency when 'monthly' then 1 when 'bimonthly' then 2 when 'quarterly' then 3 when 'semiannual' then 6 else 12 end;
  v_month:=(date_trunc('month',p_from)+make_interval(months=>v_step))::date;
  return v_month+(least(p_due_day,extract(day from (v_month+interval '1 month'-interval '1 day'))::integer)-1);
end $$;

create function erp_finance.recurrence_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',r.id,'kind',r.kind,'contact_id',r.contact_id,'contact_name',c.name,'category_id',r.category_id,'category_name',g.name,'account_id',r.account_id,
    'description',r.description,'amount_cents',r.amount_cents::text,'frequency',r.frequency,'due_day',r.due_day,'second_day',r.second_day,'weekday',r.weekday,
    'business_days',r.business_days,'end_on',r.end_on,'next_on',case when r.active and (r.end_on is null or r.next_on<=r.end_on) then r.next_on end,'generated',r.generated,'active',r.active,
    'open_titles',(select count(*) from erp_finance.title t where t.recurrence_id=r.id and not t.cancelled and t.settled_cents<t.amount_cents),'version',r.version,'created_at',r.created_at)
  from erp_finance.recurrence r join erp_catalog.record c on c.id=r.contact_id left join erp_finance.category g on g.id=r.category_id where r.id=p_id;
$$;

create function erp_finance.recurrence_title(p_rec erp_finance.recurrence,p_nominal date,p_user uuid,p_command uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare v_due date:=case when p_rec.business_days then erp_finance.next_business_day(p_nominal) else p_nominal end; v_issued date; v_id uuid;
begin
  v_issued:=v_due-p_rec.lead_days;
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
      competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on,recurrence_id,recurrence_on)
    values(gen_random_uuid(),1,1,p_rec.kind,p_rec.contact_id,p_rec.category_id,p_rec.description,p_rec.source_reference,v_issued,v_due,p_rec.amount_cents,
      v_issued,p_rec.account_id,p_rec.bank_number,p_rec.interest_month_bp,p_rec.penalty_bp,v_due,p_rec.id,p_nominal) returning id into v_id;
  return v_id;
end $$;

-- Contas recorrentes: Situação (Todas | Ativas | Inativas, padrão Ativas), Pesquisar, a receber ou a pagar.
create function public.erp_finance_recurrence_page(p_user_id uuid,p_kind text,p_active boolean default true,p_query text default null,p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with filtered as materialized (
    select r.id,r.created_at from erp_finance.recurrence r join erp_catalog.record c on c.id=r.contact_id
    where r.kind=p_kind and (p_active is null or r.active=p_active) and (v_query is null or strpos(lower(concat_ws(' ',c.name,r.description)),v_query)>0)
  ) select (select count(*) from filtered),(select coalesce(jsonb_agg(erp_finance.recurrence_view(id) order by created_at desc,id),'[]'::jsonb) from (select * from filtered order by created_at desc,id limit p_limit offset (p_page-1)*p_limit) page)
    into v_total,v_items;
  return jsonb_build_object('entity','recurrences','kind',p_kind,'active',p_active,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,'data_mode','erp_native');
end $$;

create function public.erp_finance_recurrence_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  v:=erp_finance.recurrence_view(p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','recurrences','record',v,'data_mode','erp_native');
end $$;

create function public.erp_finance_recurrence_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_rec erp_finance.recurrence%rowtype; v_result jsonb; v_before jsonb; v_kind text; v_frequency text; v_due date; v_issued date; v_competence date;
  v_title uuid; v_end date; v_due_day integer; v_second integer; v_weekday integer; v_changes jsonb; v_scope text; v_from date; v_count integer:=0; v_row erp_finance.title%rowtype; v_value boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('recurrence_create','recurrence_generate','recurrence_set_active','recurrence_update') then raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='recurrence_create' then
    perform erp_finance.keys(p_data,array['kind','contact_id','category_id','account_id','description','source_reference','bank_number','issued_on','competence_on','due_on','amount_cents',
      'interest_month_bp','penalty_bp','frequency','due_day','second_day','weekday','end_on','business_days']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true); if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_frequency:=erp_finance.txt(p_data,'frequency',20,true);
    if v_frequency not in ('weekly','biweekly','monthly','bimonthly','quarterly','semiannual','annual') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    v_issued:=erp_finance.day(p_data->'issued_on'); v_competence:=erp_finance.day(p_data->'competence_on'); v_due:=erp_finance.day(p_data->'due_on');
    if v_due<v_issued then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
    v_end:=case when p_data?'end_on' and p_data->'end_on'<>'null'::jsonb then erp_finance.day(p_data->'end_on') end;
    if v_end is not null and v_end<v_due then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    v_due_day:=case when p_data?'due_day' and p_data->'due_day'<>'null'::jsonb then erp_finance.expected(p_data->'due_day') end;
    v_second:=case when p_data?'second_day' and p_data->'second_day'<>'null'::jsonb then erp_finance.expected(p_data->'second_day') end;
    v_weekday:=case when p_data?'weekday' and p_data->'weekday'<>'null'::jsonb then (p_data->>'weekday')::integer end;
    if p_data?'weekday' and p_data->'weekday'<>'null'::jsonb and (jsonb_typeof(p_data->'weekday')<>'number' or (p_data->>'weekday')!~'^[0-6]$') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if jsonb_typeof(coalesce(p_data->'business_days','false'::jsonb))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    -- Semanal: the dia da semana of the vencimento; the others: the dia de vencimento of the first conta (and the 2º for Quinzenal).
    if v_frequency='weekly' and v_weekday is distinct from extract(dow from v_due)::integer then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if v_frequency<>'weekly' and (v_due_day is null or v_due_day>31) then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if v_frequency='biweekly' and (v_second is null or v_second>31 or v_second=v_due_day) then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=erp_finance.uuid_value(p_data->'contact_id') and r.active) then
      raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    insert into erp_finance.recurrence(kind,contact_id,category_id,account_id,description,source_reference,bank_number,amount_cents,interest_month_bp,penalty_bp,frequency,due_day,second_day,weekday,
        business_days,end_on,lead_days,actor,command_id)
      values(v_kind,erp_finance.uuid_value(p_data->'contact_id'),
        erp_finance.active_category(erp_finance.uuid_value(p_data->'category_id',false),v_kind),erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false)),
        erp_finance.txt(p_data,'description',240,true),erp_finance.txt(p_data,'source_reference',200),erp_finance.bank_number(p_data),erp_finance.cents(p_data->'amount_cents',false),
        coalesce(erp_finance.bp(p_data,'interest_month_bp'),0),coalesce(erp_finance.bp(p_data,'penalty_bp'),0),v_frequency,
        case when v_frequency<>'weekly' then v_due_day end,case when v_frequency='biweekly' then v_second end,case when v_frequency='weekly' then v_weekday end,
        coalesce((p_data->>'business_days')::boolean,false),v_end,v_due-v_issued,p_user_id,p_command_id) returning * into v_rec;
    -- The first conta keeps the emissão and competência informed; the next ones keep the same distance to the vencimento.
    v_title:=erp_finance.recurrence_title(v_rec,v_due,p_user_id,p_command_id);
    update erp_finance.title set issued_on=v_issued,competence_on=v_competence where id=v_title;
    update erp_finance.recurrence set next_on=erp_finance.recurrence_next(frequency,due_day,second_day,v_due) where id=v_rec.id;
    v_result:=jsonb_build_object('entity','recurrences','record',erp_finance.recurrence_view(v_rec.id),'title',erp_finance.dto('titles',v_title));

  else
    perform erp_finance.keys(p_data,case p_action when 'recurrence_set_active' then array['id','expected_version','active'] when 'recurrence_update' then array['id','expected_version','from_title_id','scope','future','changes']
      else array['id','expected_version'] end);
    select * into v_rec from erp_finance.recurrence where id=erp_finance.uuid_value(p_data->'id') for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_rec.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.recurrence_view(v_rec.id);
    if p_action='recurrence_generate' then
      -- Gerar contas: the next conta of an active recurrence, until the data limite; one date never twice (unique index).
      if not v_rec.active or v_rec.next_on is null or (v_rec.end_on is not null and v_rec.next_on>v_rec.end_on) then raise exception 'erp_finance_recurrence_finished' using errcode='40001'; end if;
      v_title:=erp_finance.recurrence_title(v_rec,v_rec.next_on,p_user_id,p_command_id);
      update erp_finance.recurrence set next_on=erp_finance.recurrence_next(frequency,due_day,second_day,v_rec.next_on),generated=generated+1,version=version+1,updated_at=clock_timestamp() where id=v_rec.id;
      v_result:=jsonb_build_object('entity','recurrences','record',erp_finance.recurrence_view(v_rec.id),'title',erp_finance.dto('titles',v_title));
    elsif p_action='recurrence_set_active' then
      if jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
      v_value:=(p_data->>'active')::boolean;
      if v_value=v_rec.active then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      update erp_finance.recurrence set active=v_value,version=version+1,updated_at=clock_timestamp() where id=v_rec.id;
      v_result:=jsonb_build_object('entity','recurrences','record',erp_finance.recurrence_view(v_rec.id));
    else
      -- Alterar contas em aberto (as seguintes ou todas) e os lançamentos de contas futuras: histórico, valor, categoria,
      -- conta financeira e percentuais. Contas com baixa, boleto, documento ou importação ficam como estão.
      v_scope:=erp_finance.txt(p_data,'scope',20,true); if v_scope not in ('none','following','all') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      if jsonb_typeof(p_data->'future') is distinct from 'boolean' or jsonb_typeof(p_data->'changes') is distinct from 'object' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_changes:=p_data->'changes'; perform erp_finance.keys(v_changes,array['description','amount_cents','category_id','account_id','interest_month_bp','penalty_bp']);
      if (select count(*) from jsonb_object_keys(v_changes))=0 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      if v_changes?'description' then perform erp_finance.txt(v_changes,'description',240,true); end if;
      if v_changes?'amount_cents' then perform erp_finance.cents(v_changes->'amount_cents',false); end if;
      if v_changes?'category_id' then perform erp_finance.active_category(erp_finance.uuid_value(v_changes->'category_id',false),v_rec.kind); end if;
      if v_changes?'account_id' then perform erp_finance.active_account(erp_finance.uuid_value(v_changes->'account_id',false)); end if;
      select recurrence_on into v_from from erp_finance.title where id=erp_finance.uuid_value(p_data->'from_title_id') and recurrence_id=v_rec.id;
      if not found then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      if v_scope<>'none' then
        for v_row in select t.* from erp_finance.title t where t.recurrence_id=v_rec.id and t.id<>erp_finance.uuid_value(p_data->'from_title_id') and (v_scope='all' or t.recurrence_on>v_from)
          and not t.cancelled and t.deleted_at is null and t.settled_cents=0 and not exists(select 1 from erp_finance.settlement s where s.title_id=t.id)
          and not exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id) and not exists(select 1 from erp_finance.document_title d where d.title_id=t.id)
          and not exists(select 1 from erp_finance.origin_import_origin o where o.title_id=t.id) order by t.id for update loop
          update erp_finance.title set description=coalesce(erp_finance.txt(v_changes,'description',240),description),
            amount_cents=coalesce(case when v_changes?'amount_cents' then erp_finance.cents(v_changes->'amount_cents',false) end,amount_cents),
            category_id=case when v_changes?'category_id' then erp_finance.uuid_value(v_changes->'category_id',false) else category_id end,
            account_id=case when v_changes?'account_id' then erp_finance.uuid_value(v_changes->'account_id',false) else account_id end,
            interest_month_bp=coalesce(erp_finance.bp(v_changes,'interest_month_bp'),interest_month_bp),penalty_bp=coalesce(erp_finance.bp(v_changes,'penalty_bp'),penalty_bp),
            version=version+1,updated_at=clock_timestamp() where id=v_row.id;
          v_count:=v_count+1;
        end loop;
      end if;
      if (p_data->>'future')::boolean then
        update erp_finance.recurrence set description=coalesce(erp_finance.txt(v_changes,'description',240),description),
          amount_cents=coalesce(case when v_changes?'amount_cents' then erp_finance.cents(v_changes->'amount_cents',false) end,amount_cents),
          category_id=case when v_changes?'category_id' then erp_finance.uuid_value(v_changes->'category_id',false) else category_id end,
          account_id=case when v_changes?'account_id' then erp_finance.uuid_value(v_changes->'account_id',false) else account_id end,
          interest_month_bp=coalesce(erp_finance.bp(v_changes,'interest_month_bp'),interest_month_bp),penalty_bp=coalesce(erp_finance.bp(v_changes,'penalty_bp'),penalty_bp) where id=v_rec.id;
      end if;
      update erp_finance.recurrence set version=version+1,updated_at=clock_timestamp() where id=v_rec.id;
      v_result:=jsonb_build_object('entity','recurrences','record',erp_finance.recurrence_view(v_rec.id),'updated_titles',v_count);
    end if;
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------- Importação de registros financeiros
create table erp_finance.import_row (
  row_hash text primary key check(row_hash~'^[a-f0-9]{64}$'),
  import_kind text not null check(import_kind in ('receivable','payable','cash')),
  title_id uuid references erp_finance.title(id), entry_id uuid references erp_finance.cash_entry(id), check((title_id is null)<>(entry_id is null)),
  file_name text not null, line integer not null, actor uuid not null references auth.users(id), command_id uuid not null, created_at timestamptz not null default clock_timestamp()
);
alter table erp_finance.import_row enable row level security;
revoke all on erp_finance.import_row from public,anon,authenticated,service_role;

-- One sheet line resolved against the registers: contato pelo CPF/CNPJ (só dígitos) ou pelo nome único, categoria do tipo e
-- conta financeira pelo nome único; the fingerprint is the canonical line, so the same line is never inserted twice.
create function erp_finance.import_resolve(p_kind text,p_row jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_errors text[]:='{}'; v_contact uuid; v_category uuid; v_account uuid; v_count integer; v_doc text; v_amount bigint; v_issued date; v_due date; v_competence date; v_side text; v_canonical jsonb; v_category_kind text;
begin
  if jsonb_typeof(p_row) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_row) k where k not in ('line','issued_on','due_on','competence_on','amount_cents','side','description','contact_name','contact_document','category','account','document')) then
    raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
  begin v_issued:=erp_finance.day(p_row->'issued_on'); exception when others then v_errors:=array_append(v_errors,'data'); end;
  if p_kind<>'cash' then begin v_due:=erp_finance.day(p_row->'due_on'); exception when others then v_errors:=array_append(v_errors,'vencimento'); end; end if;
  begin v_competence:=coalesce(case when p_row?'competence_on' and p_row->'competence_on'<>'null'::jsonb then erp_finance.day(p_row->'competence_on') end,v_issued); exception when others then v_errors:=array_append(v_errors,'competencia'); end;
  begin v_amount:=erp_finance.cents(p_row->'amount_cents',false); exception when others then v_errors:=array_append(v_errors,'valor'); end;
  if p_kind='cash' then v_side:=p_row->>'side'; if v_side is null or v_side not in ('in','out') then v_errors:=array_append(v_errors,'tipo'); end if; end if;
  if v_due<v_issued then v_errors:=array_append(v_errors,'vencimento'); end if;
  if nullif(btrim(p_row->>'description'),'') is null or length(p_row->>'description')>(case when p_kind='cash' then 2000 else 240 end) or (p_row->>'description')~'[[:cntrl:]]' then v_errors:=array_append(v_errors,'historico'); end if;
  v_doc:=nullif(regexp_replace(coalesce(p_row->>'contact_document',''),'[^0-9]','','g'),'');
  if v_doc is not null then
    select count(*),min(c.record_id::text)::uuid into v_count,v_contact from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id
      where r.active and regexp_replace(coalesce(c.document,''),'[^0-9]','','g')=v_doc;
  elsif nullif(btrim(p_row->>'contact_name'),'') is not null then
    select count(*),min(c.record_id::text)::uuid into v_count,v_contact from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where r.active and lower(r.name)=lower(btrim(p_row->>'contact_name'));
  else v_count:=case when p_kind='cash' then 1 else 0 end; v_contact:=null; end if;
  if v_count<>1 then v_errors:=array_append(v_errors,'contato'); v_contact:=null; end if;
  v_category_kind:=case when p_kind='cash' then case when v_side='in' then 'receivable' else 'payable' end else p_kind end;
  if nullif(btrim(p_row->>'category'),'') is not null then
    select count(*),min(id::text)::uuid into v_count,v_category from erp_finance.category where kind=v_category_kind and active and deleted_at is null and lower(name)=lower(btrim(p_row->>'category'));
    if v_count<>1 then v_errors:=array_append(v_errors,'categoria'); end if;
  end if;
  if nullif(btrim(p_row->>'account'),'') is not null then
    select count(*),min(id::text)::uuid into v_count,v_account from erp_finance.account where active and deleted_at is null and lower(name)=lower(btrim(p_row->>'account'));
    if v_count<>1 then v_errors:=array_append(v_errors,'conta'); end if;
  elsif p_kind='cash' then v_errors:=array_append(v_errors,'conta'); end if;
  if length(p_row->>'document')>200 then v_errors:=array_append(v_errors,'documento'); end if;
  v_canonical:=jsonb_build_object('kind',p_kind,'issued_on',p_row->'issued_on','due_on',p_row->'due_on','competence_on',p_row->'competence_on','amount_cents',p_row->'amount_cents','side',p_row->'side',
    'description',btrim(coalesce(p_row->>'description','')),'contact',coalesce(v_doc,lower(btrim(coalesce(p_row->>'contact_name','')))),'category',lower(btrim(coalesce(p_row->>'category',''))),
    'account',lower(btrim(coalesce(p_row->>'account',''))),'document',btrim(coalesce(p_row->>'document','')));
  return jsonb_build_object('line',p_row->'line','errors',to_jsonb(v_errors),'hash',encode(sha256(convert_to(v_canonical::text,'UTF8')),'hex'),'contact_id',v_contact,'category_id',v_category,'account_id',v_account,
    'issued_on',v_issued,'due_on',v_due,'competence_on',v_competence,'amount_cents',v_amount::text,'side',v_side);
end $$;

create function erp_finance.import_rows_check(p_data jsonb)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v_kind text;
begin
  perform erp_finance.keys(p_data,array['kind','file_name','rows']);
  v_kind:=erp_finance.txt(p_data,'kind',20,true); if v_kind not in ('receivable','payable','cash') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
  if erp_finance.txt(p_data,'file_name',200,true)~'[[:cntrl:]]' or jsonb_typeof(p_data->'rows') is distinct from 'array' or jsonb_array_length(p_data->'rows') not between 1 and 1000 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
  return v_kind;
end $$;

-- Prévia: each line with its errors, new or already imported (read-only). A line equal to an earlier line of the same file
-- is also "already imported": the import inserts the first one and skips the others, so the prévia says it beforehand.
create function public.erp_finance_import_preview(p_user_id uuid,p_data jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_kind text;
begin
  perform erp_finance.require_access(p_user_id,true);
  v_kind:=erp_finance.import_rows_check(p_data);
  return jsonb_build_object('entity','financial_import','kind',v_kind,'rows',(select coalesce(jsonb_agg(jsonb_build_object('line',r->'line','errors',r->'errors','status',
    case when jsonb_array_length(r->'errors')>0 then 'error' when repeat>1 or exists(select 1 from erp_finance.import_row i where i.row_hash=r->>'hash') then 'duplicate' else 'new' end) order by n),'[]'::jsonb)
    from (select r,n,row_number() over (partition by case when jsonb_array_length(r->'errors')=0 then r->>'hash' end order by n) repeat
      from (select erp_finance.import_resolve(v_kind,value) r,ordinality n from jsonb_array_elements(p_data->'rows') with ordinality) resolved) x),'data_mode','erp_native');
end $$;

-- Importar: every line must be valid; lines already imported are skipped; the others become contas or lançamentos de caixa.
create function public.erp_finance_import_execute(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_finance.command%rowtype; v_kind text; v_row jsonb; v_resolved jsonb; v_created integer:=0; v_skipped integer:=0; v_id uuid; v_entry erp_finance.cash_entry%rowtype; v_result jsonb; v_account erp_finance.account%rowtype;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>1048576 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','records_import','data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;
  v_kind:=erp_finance.import_rows_check(p_data);
  perform pg_advisory_xact_lock(hashtextextended('erp_finance.import',0));
  for v_row in select value from jsonb_array_elements(p_data->'rows') loop
    v_resolved:=erp_finance.import_resolve(v_kind,v_row);
    if jsonb_array_length(v_resolved->'errors')>0 then raise exception 'erp_finance_import_invalid_row' using errcode='22023'; end if;
    if exists(select 1 from erp_finance.import_row where row_hash=v_resolved->>'hash') then v_skipped:=v_skipped+1; continue; end if;
    if v_kind='cash' then
      v_account:=erp_finance.cash_account((v_resolved->>'account_id')::uuid);
      insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,contact_id,note,origin,actor,command_id)
        values(v_account.id,v_resolved->>'side',(v_resolved->>'amount_cents')::bigint,(v_resolved->>'issued_on')::date,(v_resolved->>'competence_on')::date,(v_resolved->>'contact_id')::uuid,
          btrim(v_row->>'description'),'import',p_user_id,p_command_id) returning * into v_entry;
      perform erp_finance.cash_post(v_entry,(v_resolved->>'category_id')::uuid,p_user_id,p_command_id);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      insert into erp_finance.import_row(row_hash,import_kind,entry_id,file_name,line,actor,command_id) values(v_resolved->>'hash',v_kind,v_entry.id,p_data->>'file_name',coalesce((v_row->>'line')::integer,0),p_user_id,p_command_id);
    else
      insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,competence_on,account_id)
        values(gen_random_uuid(),1,1,v_kind,(v_resolved->>'contact_id')::uuid,(v_resolved->>'category_id')::uuid,btrim(v_row->>'description'),nullif(btrim(coalesce(v_row->>'document','')),''),
          (v_resolved->>'issued_on')::date,(v_resolved->>'due_on')::date,(v_resolved->>'amount_cents')::bigint,(v_resolved->>'competence_on')::date,(v_resolved->>'account_id')::uuid) returning id into v_id;
      insert into erp_finance.import_row(row_hash,import_kind,title_id,file_name,line,actor,command_id) values(v_resolved->>'hash',v_kind,v_id,p_data->>'file_name',coalesce((v_row->>'line')::integer,0),p_user_id,p_command_id);
    end if;
    v_created:=v_created+1;
  end loop;
  perform erp_finance.require_access(p_user_id,true);
  v_result:=jsonb_build_object('entity','financial_import','kind',v_kind,'created',v_created,'skipped',v_skipped,'action','records_import','data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'records_import',null,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.easter(integer),erp_finance.is_business_day(date),erp_finance.next_business_day(date),erp_finance.recurrence_next(text,integer,integer,date),erp_finance.recurrence_view(uuid),
  erp_finance.recurrence_title(erp_finance.recurrence,date,uuid,uuid),erp_finance.import_resolve(text,jsonb),erp_finance.import_rows_check(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_recurrence_page(uuid,text,boolean,text,integer,integer),public.erp_finance_recurrence_get(uuid,uuid),public.erp_finance_recurrence_execute(uuid,uuid,text,jsonb),
  public.erp_finance_import_preview(uuid,jsonb),public.erp_finance_import_execute(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_finance_recurrence_page(uuid,text,boolean,text,integer,integer),public.erp_finance_recurrence_get(uuid,uuid),public.erp_finance_recurrence_execute(uuid,uuid,text,jsonb),
  public.erp_finance_import_preview(uuid,jsonb),public.erp_finance_import_execute(uuid,uuid,jsonb) to service_role;
commit;
