-- Financeiro próprio: movimentos explícitos, valores em centavos, nenhuma integração bancária.
begin;
create schema erp_finance;
revoke all on schema erp_finance from public,anon,authenticated,service_role;

create table erp_finance.account (
  id uuid primary key default gen_random_uuid(), name text not null,
  kind text not null check(kind in ('bank','cash','other')), active boolean not null default true,
  opening_recorded boolean not null default false, version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table erp_finance.category (
  id uuid primary key default gen_random_uuid(), name text not null,
  kind text not null check(kind in ('receivable','payable','both')), active boolean not null default true,
  version integer not null default 1, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create table erp_finance.title (
  id uuid primary key default gen_random_uuid(), group_id uuid not null, installment integer not null, installments integer not null,
  kind text not null check(kind in ('receivable','payable')),
  contact_id uuid not null references erp_catalog.contact(record_id), category_id uuid references erp_finance.category(id),
  description text not null, source_reference text,
  issued_on date not null, due_on date not null check(due_on>=issued_on),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
  settled_cents bigint not null default 0 check(settled_cents>=0 and settled_cents<=amount_cents),
  cancelled boolean not null default false, version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique(group_id,installment), check(installment between 1 and installments and installments between 1 and 120)
);
create table erp_finance.settlement (
  id uuid primary key default gen_random_uuid(), title_id uuid not null references erp_finance.title(id),
  account_id uuid not null references erp_finance.account(id),
  kind text not null check(kind in ('payment','reversal')), reverses_id uuid unique references erp_finance.settlement(id),
  posted_on date not null, principal_cents bigint not null check(principal_cents>0),
  interest_cents bigint not null check(interest_cents>=0), penalty_cents bigint not null check(penalty_cents>=0),
  discount_cents bigint not null check(discount_cents>=0), fee_cents bigint not null check(fee_cents>=0),
  net_cash_cents bigint not null check(net_cash_cents>=0), note text,
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check((kind='payment' and reverses_id is null) or (kind='reversal' and reverses_id is not null))
);
create table erp_finance.movement (
  id uuid primary key default gen_random_uuid(), account_id uuid not null references erp_finance.account(id),
  settlement_id uuid unique references erp_finance.settlement(id),
  kind text not null check(kind in ('opening','payment','reversal')),
  delta_cents bigint not null, posted_on date not null, note text,
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check((kind='opening' and settlement_id is null) or (kind in ('payment','reversal') and settlement_id is not null))
);
create unique index erp_finance_one_opening on erp_finance.movement(account_id) where kind='opening';
create index erp_finance_movement_account on erp_finance.movement(account_id,posted_on,id);
create index erp_finance_title_kind on erp_finance.title(kind,due_on,id);
create index erp_finance_settlement_title on erp_finance.settlement(title_id,id);
create table erp_finance.command (
  id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null,
  result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_finance.audit (
  id bigint generated always as identity primary key, actor uuid not null references auth.users(id), command_id uuid not null,
  action text not null, before_data jsonb, after_data jsonb not null, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['account','category','title','settlement','movement','command','audit'] loop
    execute format('alter table erp_finance.%I enable row level security',t);
  end loop;
end $$;
revoke all on all tables in schema erp_finance from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_finance from public,anon,authenticated,service_role;
alter default privileges in schema erp_finance revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_finance revoke all on functions from public,anon,authenticated,service_role;

create function erp_finance.require_access(p_actor uuid,p_write boolean)
returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_actor and active;
  if not found or v_role not in ('admin','financeiro','consulta') or (p_write and v_role='consulta') then
    raise exception 'erp_finance_access_denied' using errcode='42501'; end if;
  return v_role;
end $$;
create function erp_finance.keys(p_data jsonb,p_allowed text[])
returns void language plpgsql immutable set search_path=pg_catalog as $$
begin
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536
    or exists(select 1 from jsonb_object_keys(p_data) k where not k=any(p_allowed)) then
    raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
end $$;
create function erp_finance.txt(p_data jsonb,p_key text,p_limit integer,p_required boolean default false)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  if p_data ? p_key and jsonb_typeof(p_data->p_key) not in ('string','null') then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  v:=nullif(btrim(p_data->>p_key),'');
  if (p_required and v is null) or length(v)>p_limit then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.cents(p_value jsonb,p_zero boolean default true,p_signed boolean default false)
returns bigint language plpgsql immutable set search_path=pg_catalog as $$
declare v bigint;
begin
  if jsonb_typeof(p_value) is distinct from 'string' or (p_value#>>'{}')!~(case when p_signed then '^-?[0-9]{1,15}$' else '^[0-9]{1,15}$' end) then
    raise exception 'erp_finance_invalid_cents' using errcode='22023'; end if;
  v:=(p_value#>>'{}')::bigint;
  if not p_zero and v<=0 then raise exception 'erp_finance_invalid_cents' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.day(p_value jsonb,p_past boolean default false)
returns date language plpgsql stable set search_path=pg_catalog as $$
declare v date;
begin
  if jsonb_typeof(p_value) is distinct from 'string' or (p_value#>>'{}')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_finance_invalid_date' using errcode='22023'; end if;
  begin v:=(p_value#>>'{}')::date; exception when others then raise exception 'erp_finance_invalid_date' using errcode='22023'; end;
  if v<date '1900-01-01' or v>date '2100-12-31' or (p_past and v>(clock_timestamp() at time zone 'America/Sao_Paulo')::date) then
    raise exception 'erp_finance_invalid_date' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.uuid_value(p_value jsonb,p_required boolean default true)
returns uuid language plpgsql immutable set search_path=pg_catalog as $$
begin
  if (p_value is null or p_value='null'::jsonb) and not p_required then return null; end if;
  if jsonb_typeof(p_value) is distinct from 'string' or (p_value#>>'{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'erp_finance_invalid_id' using errcode='22023'; end if;
  return (p_value#>>'{}')::uuid;
end $$;
create function erp_finance.expected(p_value jsonb,p_create boolean default false)
returns integer language plpgsql immutable set search_path=pg_catalog as $$
declare v integer;
begin
  if jsonb_typeof(p_value) is distinct from 'number' or (p_value#>>'{}')!~'^[0-9]{1,10}$' then raise exception 'erp_finance_invalid_version' using errcode='22023'; end if;
  begin v:=(p_value#>>'{}')::integer; exception when others then raise exception 'erp_finance_invalid_version' using errcode='22023'; end;
  if (p_create and v<>0) or (not p_create and v<1) then raise exception 'erp_finance_invalid_version' using errcode='22023'; end if;
  return v;
end $$;

create function erp_finance.dto(p_entity text,p_id uuid)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v jsonb;
begin
  if p_entity='accounts' then
    select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'active',a.active,'opening_recorded',a.opening_recorded,
      'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at,
      'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text) into v from erp_finance.account a where id=p_id;
  elsif p_entity='categories' then select to_jsonb(c) into v from erp_finance.category c where id=p_id;
  elsif p_entity='titles' then
    select (to_jsonb(t)-'amount_cents'-'settled_cents')||jsonb_build_object('amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
      'balance_cents',(t.amount_cents-t.settled_cents)::text,'contact_name',c.name,'category_name',g.name,
      'status',case when t.cancelled then 'cancelled' when t.settled_cents=0 then 'open' when t.settled_cents=t.amount_cents then 'paid' else 'partial' end,
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
end $$;
create function public.erp_finance_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin v_role:=erp_finance.require_access(p_user_id,false);
  return jsonb_build_object('read',true,'write',v_role in ('admin','financeiro'),'data_mode','erp_native');
end $$;
create function public.erp_finance_get(p_user_id uuid,p_entity text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin perform erp_finance.require_access(p_user_id,false); v:=erp_finance.dto(p_entity,p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity',p_entity,'record',v,'data_mode','erp_native');
end $$;
create function public.erp_finance_list(p_user_id uuid,p_entity text,p_limit integer default 25,p_after uuid default null,
  p_query text default null,p_status text default null,p_kind text default null,p_from date default null,p_to date default null,p_parent_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_entity is null or p_entity not in ('accounts','categories','titles','settlements','movements') or p_limit is null or p_limit not between 1 and 100
    or length(p_query)>120 or (p_status is not null and p_status not in ('open','partial','paid','cancelled','overdue'))
    or (p_kind is not null and p_kind not in ('receivable','payable','both','bank','cash','other','payment','reversal','opening'))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_entity in ('settlements','movements') and p_parent_id is null) then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with ids as (
    select id from erp_finance.account where p_entity='accounts'
    union all select id from erp_finance.category where p_entity='categories'
    union all select id from erp_finance.title where p_entity='titles'
    union all select id from erp_finance.settlement where p_entity='settlements' and title_id=p_parent_id
    union all select id from erp_finance.movement where p_entity='movements' and account_id=p_parent_id
  ), items as materialized (select id,erp_finance.dto(p_entity,id) item from ids where p_after is null or id>p_after), page as (
    select id,item from items where (nullif(btrim(p_query),'') is null or strpos(lower(concat_ws(' ',item->>'name',item->>'description',item->>'contact_name',item->>'source_reference')),lower(btrim(p_query)))>0)
      and (p_status is null or item->>'status'=p_status or (p_status='overdue' and item->>'overdue'='true'))
      and (p_kind is null or item->>'kind'=p_kind)
      and (p_from is null or coalesce(item->>'due_on',item->>'posted_on')>=p_from::text)
      and (p_to is null or coalesce(item->>'due_on',item->>'posted_on')<=p_to::text)
    order by id limit p_limit+1
  ) select coalesce(jsonb_agg(item order by id),'[]'::jsonb),count(*)>p_limit into v_items,v_more from page;
  if v_more then v_items:=v_items-p_limit; end if;
  return jsonb_build_object('entity',p_entity,'items',v_items,'limit',p_limit,'has_more',v_more,
    'next_cursor',case when v_more then v_items->(p_limit-1)->>'id' end,'data_mode','erp_native');
end $$;

create function public.erp_finance_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_id uuid; v_version integer;
  v_account erp_finance.account%rowtype; v_category erp_finance.category%rowtype; v_title erp_finance.title%rowtype; v_original erp_finance.settlement%rowtype;
  v_name text; v_kind text; v_active boolean; v_contact uuid; v_category_id uuid; v_issued date; v_due date; v_day date;
  v_amount bigint; v_principal bigint; v_interest bigint; v_penalty bigint; v_discount bigint; v_fee bigint; v_net bigint; v_delta bigint;
  v_group uuid; v_item jsonb; v_items jsonb:='[]'::jsonb; v_count integer; v_index integer:=0; v_total numeric:=0; v_settlement uuid; v_note text;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('account_save','category_save','title_create_group','title_update','title_cancel','settle','reverse','opening') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action in ('account_save','category_save') then
    perform erp_finance.keys(p_data,array['id','expected_version','name','kind','active']);
    v_id:=erp_finance.uuid_value(p_data->'id',false); v_version:=erp_finance.expected(p_data->'expected_version',v_id is null);
    v_name:=erp_finance.txt(p_data,'name',200,true); v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if p_data?'active' and jsonb_typeof(p_data->'active')<>'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
    v_active:=coalesce((p_data->>'active')::boolean,true);
    if p_action='account_save' then
      if v_kind not in ('bank','cash','other') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      if v_id is null then insert into erp_finance.account(name,kind,active) values(v_name,v_kind,v_active) returning id into v_id;
      else
        select * into v_account from erp_finance.account where id=v_id for update;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_account.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
        v_before:=erp_finance.dto('accounts',v_id);
        update erp_finance.account set name=v_name,kind=v_kind,active=case when p_data?'active' then v_active else active end,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      v_result:=jsonb_build_object('entity','accounts','record',erp_finance.dto('accounts',v_id));
    else
      if v_kind not in ('receivable','payable','both') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      if v_id is null then insert into erp_finance.category(name,kind,active) values(v_name,v_kind,v_active) returning id into v_id;
      else
        select * into v_category from erp_finance.category where id=v_id for update;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_category.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
        if v_kind<>'both' and exists(select 1 from erp_finance.title where category_id=v_id and kind<>v_kind) then raise exception 'erp_finance_category_in_use' using errcode='40001'; end if;
        v_before:=erp_finance.dto('categories',v_id);
        update erp_finance.category set name=v_name,kind=v_kind,active=case when p_data?'active' then v_active else active end,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      v_result:=jsonb_build_object('entity','categories','record',erp_finance.dto('categories',v_id));
    end if;

  elsif p_action='title_create_group' then
    perform erp_finance.keys(p_data,array['kind','contact_id','category_id','description','source_reference','issued_on','total_cents','installments']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true); v_contact:=erp_finance.uuid_value(p_data->'contact_id'); v_category_id:=erp_finance.uuid_value(p_data->'category_id',false);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    if v_category_id is not null then
      perform 1 from erp_finance.category where id=v_category_id and active and kind in (v_kind,'both') for share;
      if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
    end if;
    v_issued:=erp_finance.day(p_data->'issued_on'); v_amount:=erp_finance.cents(p_data->'total_cents',false);
    v_name:=erp_finance.txt(p_data,'description',240,true); v_note:=erp_finance.txt(p_data,'source_reference',200);
    if jsonb_typeof(p_data->'installments') is distinct from 'array' or jsonb_array_length(p_data->'installments') not between 1 and 120 then raise exception 'erp_finance_invalid_installments' using errcode='22023'; end if;
    v_count:=jsonb_array_length(p_data->'installments'); v_group:=gen_random_uuid();
    for v_item in select value from jsonb_array_elements(p_data->'installments') loop
      perform erp_finance.keys(v_item,array['amount_cents','due_on']);
      v_principal:=erp_finance.cents(v_item->'amount_cents',false); v_due:=erp_finance.day(v_item->'due_on');
      if v_due<v_issued then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_index:=v_index+1; v_total:=v_total+v_principal;
      insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents)
        values(v_group,v_index,v_count,v_kind,v_contact,v_category_id,v_name,v_note,v_issued,v_due,v_principal) returning id into v_id;
      v_items:=v_items||jsonb_build_array(erp_finance.dto('titles',v_id));
    end loop;
    if v_total<>v_amount then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
    v_result:=jsonb_build_object('entity','titles','group_id',v_group,'items',v_items);

  elsif p_action in ('title_update','title_cancel','settle','reverse') then
    if p_action='title_update' then perform erp_finance.keys(p_data,array['id','expected_version','description','source_reference','due_on','amount_cents','category_id']);
    elsif p_action='title_cancel' then perform erp_finance.keys(p_data,array['id','expected_version','note']);
    elsif p_action='settle' then perform erp_finance.keys(p_data,array['id','expected_version','account_id','posted_on','principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents','note']);
    else perform erp_finance.keys(p_data,array['id','expected_version','settlement_id','posted_on','note']); end if;
    v_id:=erp_finance.uuid_value(p_data->'id'); v_version:=erp_finance.expected(p_data->'expected_version');
    select * into v_title from erp_finance.title where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_title.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    if v_title.cancelled then raise exception 'erp_finance_cancelled_title' using errcode='40001'; end if;
    v_before:=erp_finance.dto('titles',v_id);
    if p_action='title_update' then
      v_amount:=case when p_data?'amount_cents' then erp_finance.cents(p_data->'amount_cents',false) else v_title.amount_cents end;
      if v_amount<>v_title.amount_cents and (v_title.installments>1 or exists(select 1 from erp_finance.settlement where title_id=v_id)) then
        raise exception 'erp_finance_principal_locked' using errcode='40001'; end if;
      v_due:=case when p_data?'due_on' then erp_finance.day(p_data->'due_on') else v_title.due_on end;
      if v_due<v_title.issued_on then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_category_id:=case when p_data?'category_id' then erp_finance.uuid_value(p_data->'category_id',false) else v_title.category_id end;
      if v_category_id is not null then
        perform 1 from erp_finance.category where id=v_category_id and active and kind in (v_title.kind,'both') for share;
        if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
      end if;
      update erp_finance.title set description=case when p_data?'description' then erp_finance.txt(p_data,'description',240,true) else description end,
        source_reference=case when p_data?'source_reference' then erp_finance.txt(p_data,'source_reference',200) else source_reference end,
        due_on=v_due,amount_cents=v_amount,category_id=v_category_id,version=version+1,updated_at=clock_timestamp() where id=v_id;
    elsif p_action='title_cancel' then
      if v_title.settled_cents<>0 then raise exception 'erp_finance_active_payments' using errcode='40001'; end if;
      v_note:=erp_finance.txt(p_data,'note',500,true);
      update erp_finance.title set cancelled=true,version=version+1,updated_at=clock_timestamp() where id=v_id;
    else
      v_day:=erp_finance.day(p_data->'posted_on',true); v_note:=erp_finance.txt(p_data,'note',500,p_action='reverse');
      if v_day<v_title.issued_on then raise exception 'erp_finance_payment_before_issue' using errcode='22023'; end if;
      if p_action='settle' then
        select * into v_account from erp_finance.account where id=erp_finance.uuid_value(p_data->'account_id') for update;
        if not found or not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
        if exists(select 1 from erp_finance.movement where account_id=v_account.id and kind='opening' and posted_on>v_day) then raise exception 'erp_finance_payment_before_opening' using errcode='22023'; end if;
        v_principal:=erp_finance.cents(p_data->'principal_cents',false);
        v_interest:=erp_finance.cents(coalesce(p_data->'interest_cents','"0"'::jsonb)); v_penalty:=erp_finance.cents(coalesce(p_data->'penalty_cents','"0"'::jsonb));
        v_discount:=erp_finance.cents(coalesce(p_data->'discount_cents','"0"'::jsonb)); v_fee:=erp_finance.cents(coalesce(p_data->'fee_cents','"0"'::jsonb));
        if v_principal>v_title.amount_cents-v_title.settled_cents then raise exception 'erp_finance_overpayment' using errcode='40001'; end if;
        v_net:=v_principal+v_interest+v_penalty-v_discount+case when v_title.kind='payable' then v_fee else -v_fee end;
        if v_net<0 or v_net>999999999999999 or v_discount>v_principal+v_interest+v_penalty then raise exception 'erp_finance_invalid_net_cash' using errcode='22023'; end if;
        insert into erp_finance.settlement(title_id,account_id,kind,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
          values(v_id,v_account.id,'payment',v_day,v_principal,v_interest,v_penalty,v_discount,v_fee,v_net,v_note,p_user_id,p_command_id) returning id into v_settlement;
        v_delta:=case when v_title.kind='receivable' then v_net else -v_net end;
        update erp_finance.title set settled_cents=settled_cents+v_principal,version=version+1,updated_at=clock_timestamp() where id=v_id;
      else
        select * into v_original from erp_finance.settlement where id=erp_finance.uuid_value(p_data->'settlement_id') and title_id=v_id;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_original.kind<>'payment' or exists(select 1 from erp_finance.settlement where reverses_id=v_original.id) then raise exception 'erp_finance_reversal_conflict' using errcode='40001'; end if;
        if v_day<v_original.posted_on then raise exception 'erp_finance_invalid_reversal_date' using errcode='22023'; end if;
        select * into v_account from erp_finance.account where id=v_original.account_id for update;
        insert into erp_finance.settlement(title_id,account_id,kind,reverses_id,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
          values(v_id,v_account.id,'reversal',v_original.id,v_day,v_original.principal_cents,v_original.interest_cents,v_original.penalty_cents,v_original.discount_cents,v_original.fee_cents,v_original.net_cash_cents,v_note,p_user_id,p_command_id) returning id into v_settlement;
        v_delta:=case when v_title.kind='receivable' then -v_original.net_cash_cents else v_original.net_cash_cents end;
        update erp_finance.title set settled_cents=settled_cents-v_original.principal_cents,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      insert into erp_finance.movement(account_id,settlement_id,kind,delta_cents,posted_on,note,actor,command_id)
        values(v_account.id,v_settlement,case when p_action='settle' then 'payment' else 'reversal' end,v_delta,v_day,v_note,p_user_id,p_command_id);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
    end if;
    v_result:=jsonb_build_object('entity','titles','record',erp_finance.dto('titles',v_id),'note',v_note);
    if v_settlement is not null then v_result:=v_result||jsonb_build_object('settlement',erp_finance.dto('settlements',v_settlement),'account',erp_finance.dto('accounts',v_account.id)); end if;

  elsif p_action='opening' then
    perform erp_finance.keys(p_data,array['id','expected_version','amount_cents','posted_on','note']);
    v_id:=erp_finance.uuid_value(p_data->'id'); v_version:=erp_finance.expected(p_data->'expected_version');
    v_day:=erp_finance.day(p_data->'posted_on',true); v_amount:=erp_finance.cents(p_data->'amount_cents',true,true); v_note:=erp_finance.txt(p_data,'note',500,true);
    select * into v_account from erp_finance.account where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_account.version<>v_version or v_account.opening_recorded or not v_account.active then raise exception 'erp_finance_opening_conflict' using errcode='40001'; end if;
    if exists(select 1 from erp_finance.movement where account_id=v_id and posted_on<v_day) then raise exception 'erp_finance_opening_after_movement' using errcode='22023'; end if;
    v_before:=erp_finance.dto('accounts',v_id);
    insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_amount,v_day,v_note,p_user_id,p_command_id);
    update erp_finance.account set opening_recorded=true,version=version+1,updated_at=clock_timestamp() where id=v_id;
    v_result:=jsonb_build_object('entity','accounts','record',erp_finance.dto('accounts',v_id));
  end if;

  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on all functions in schema erp_finance from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_access(uuid) from public,anon,authenticated;
revoke all on function public.erp_finance_get(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_finance_list(uuid,text,integer,uuid,text,text,text,date,date,uuid) from public,anon,authenticated;
revoke all on function public.erp_finance_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_finance_access(uuid) to service_role;
grant execute on function public.erp_finance_get(uuid,text,uuid) to service_role;
grant execute on function public.erp_finance_list(uuid,text,integer,uuid,text,text,text,date,date,uuid) to service_role;
grant execute on function public.erp_finance_execute(uuid,uuid,text,jsonb) to service_role;
commit;
