-- Financeiro > Controle de caixa no padrão do Origin (onda C, lane financeiro).
-- Caixa aberto por um operador numa conta financeira do tipo Caixa ("Loja"), com o Troco; Sangrias e Suprimentos geram
-- o lançamento de saída ou entrada na própria conta (exclusão só aqui, desfeita na mesma data); Valores informados por
-- forma de pagamento (Cadastros > Formas de pagamento, só leitura); Fechar, Reabrir Caixa e Conferido. A frente de caixa
-- (PDV) não existe no Brufap: o "Total registrado" por forma fica zerado e o caixa mostra o dinheiro esperado (troco +
-- suprimentos − sangrias). Nada é escrito no Origin e nenhuma operação bancária acontece.
begin;

create table erp_finance.cash_session (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references erp_finance.account(id),
  operator_id uuid not null references auth.users(id),
  opened_at timestamptz not null default clock_timestamp(),
  opened_on date not null check(opened_on between date '1900-01-01' and date '2100-12-31'),
  previous_change_cents bigint not null default 0 check(previous_change_cents between 0 and 999999999999999),
  change_cents bigint not null check(change_cents between 0 and 999999999999999),
  state text not null default 'open' check(state in ('open','closed')),
  closed_by uuid references auth.users(id), closed_at timestamptz,
  checked boolean not null default false, checked_by uuid references auth.users(id), checked_at timestamptz,
  version integer not null default 1 check(version>0),
  command_id uuid not null, created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id),
  check((state='open')=(closed_at is null) and (closed_at is null)=(closed_by is null)),
  check((checked)=(checked_at is not null) and (checked_at is null)=(checked_by is null) and (not checked or state='closed')),
  check((deleted_at is null)=(deleted_by is null))
);
create unique index erp_finance_cash_session_open on erp_finance.cash_session(account_id,operator_id) where state='open' and deleted_at is null;
create index erp_finance_cash_session_day on erp_finance.cash_session(opened_on,id) where deleted_at is null;
-- Valores informados: one line per forma de pagamento of the closing (replaced as a whole with the version of the caixa).
create table erp_finance.cash_session_value (
  session_id uuid not null references erp_finance.cash_session(id),
  position integer not null check(position between 1 and 50),
  payment_method_id uuid not null references erp_catalog.payment_method(id),
  amount_cents bigint not null check(amount_cents between 0 and 999999999999999),
  primary key(session_id,position)
);
-- Sangrias e suprimentos: each one is a lançamento of the account of the caixa.
create table erp_finance.cash_session_move (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references erp_finance.cash_session(id),
  kind text not null check(kind in ('withdrawal','supply')),
  posted_on date not null check(posted_on between date '1900-01-01' and date '2100-12-31'),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
  note text check(note is null or (length(note) between 1 and 240 and note!~'[[:cntrl:]]')),
  cash_entry_id uuid not null unique references erp_finance.cash_entry(id),
  actor uuid not null references auth.users(id), command_id uuid not null, created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id), check((deleted_at is null)=(deleted_by is null))
);
create index erp_finance_cash_session_move_session on erp_finance.cash_session_move(session_id,created_at);
do $$ declare t text; begin foreach t in array array['cash_session','cash_session_value','cash_session_move'] loop
  execute format('alter table erp_finance.%I enable row level security',t);
  execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

alter table erp_finance.cash_entry drop constraint cash_entry_origin_check;
alter table erp_finance.cash_entry add constraint cash_entry_origin_check check(origin in ('manual','adjustment','ledger','import','reconciliation','commission','cash_session'));
-- The lançamentos of the Comissões (171) and of the Controle de caixa are changed only by their screens.
create or replace function erp_finance.owned_entry_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.origin in ('commission','cash_session') and current_setting('erp_finance.commission_owner',true) is distinct from 'on' and current_setting('erp_finance.owned_writer',true) is distinct from 'on'
    and (new.account_id,new.kind,new.amount_cents,new.posted_on,new.deleted_at is null,new.note) is distinct from (old.account_id,old.kind,old.amount_cents,old.posted_on,old.deleted_at is null,old.note) then
    raise exception 'erp_finance_entry_owned' using errcode='40001'; end if;
  return new;
end $$;
-- A conta financeira with caixas is in use (Excluir offers Inativar).
CREATE OR REPLACE FUNCTION erp_finance.account_view(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'account_type',a.account_type,'institution_code',a.institution_code,'institution_name',a.institution_name,
    'agency',a.agency,'account_number',a.account_number,'account_digit',a.account_digit,'start_on',a.start_on,'active',a.active,
    'default_movements',a.default_movements,'default_boleto',a.default_boleto,
    'boleto',case when a.default_boleto then 'default' when p.id is not null then 'active' else 'none' end,
    'opening_recorded',a.opening_recorded,'opening_cents',(select m.delta_cents::text from erp_finance.movement m where m.account_id=a.id and m.kind='opening'),
    'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text,
    'first_movement_on',(select min(m.posted_on) from erp_finance.movement m where m.account_id=a.id),
    'in_use',exists(select 1 from erp_finance.movement m where m.account_id=a.id and m.kind<>'opening') or exists(select 1 from erp_finance.title t where t.account_id=a.id)
      or p.id is not null or exists(select 1 from erp_finance.bordero b where b.account_id=a.id) or exists(select 1 from erp_finance.recurrence r where r.account_id=a.id)
      or exists(select 1 from erp_finance.cash_entry e where e.account_id=a.id) or exists(select 1 from erp_finance.bank_statement s where s.account_id=a.id)
      or exists(select 1 from erp_finance.commission_entry c where c.account_id=a.id) or exists(select 1 from erp_catalog.payment_method f where f.account_id=a.id and f.deleted_at is null)
      or exists(select 1 from erp_finance.cash_session c where c.account_id=a.id),
    'cnab',case when p.id is null then null else jsonb_build_object('bank',p.identity->>'bank','agency',p.identity->>'agency','account',p.identity->>'account','account_digit',p.identity->>'accountDigit') end,
    'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at)
  from erp_finance.account a left join erp_cnab.profile p on p.account_id=a.id where a.id=p_id and a.deleted_at is null;
$function$;

create function erp_finance.cash_session_view(p_id uuid,p_lines boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
  with s as (select * from erp_finance.cash_session where id=p_id),
  moves as (select m.* from erp_finance.cash_session_move m where m.session_id=p_id and m.deleted_at is null),
  sums as (select coalesce(sum(amount_cents) filter (where kind='supply'),0) supplies,coalesce(sum(amount_cents) filter (where kind='withdrawal'),0) withdrawals from moves),
  informed as (select v.payment_method_id,sum(v.amount_cents) amount from erp_finance.cash_session_value v where v.session_id=p_id group by v.payment_method_id)
  select jsonb_build_object('id',s.id,'account_id',s.account_id,'account_name',left(a.name,200),'operator_id',s.operator_id,'operator_name',erp_activity.actor_label(s.operator_id),
    'opened_at',s.opened_at,'opened_on',s.opened_on,'previous_change_cents',s.previous_change_cents::text,'change_cents',s.change_cents::text,'state',s.state,
    'closed_by_name',case when s.closed_by is null then null else erp_activity.actor_label(s.closed_by) end,'closed_at',s.closed_at,'checked',s.checked,
    'supply_cents',sums.supplies::text,'withdrawal_cents',sums.withdrawals::text,'expected_cash_cents',(s.change_cents+sums.supplies-sums.withdrawals)::text,
    'informed_cents',(select coalesce(sum(amount),0)::text from informed),'version',s.version,'created_at',s.created_at)
    ||case when not p_lines then '{}'::jsonb else jsonb_build_object(
      'values',(select coalesce(jsonb_agg(jsonb_build_object('payment_method_id',v.payment_method_id,'payment_method_name',left(f.description,100),'amount_cents',v.amount_cents::text) order by v.position),'[]'::jsonb)
        from erp_finance.cash_session_value v join erp_catalog.payment_method f on f.id=v.payment_method_id where v.session_id=p_id),
      -- Formas de pagamento: registrado by the frente de caixa (none in the Brufap) and informado on the closing.
      'methods',(select coalesce(jsonb_agg(jsonb_build_object('payment_method_id',i.payment_method_id,'name',left(f.description,100),'registered_cents','0','informed_cents',i.amount::text,
        'difference_cents',i.amount::text) order by lower(f.description),f.id),'[]'::jsonb) from informed i join erp_catalog.payment_method f on f.id=i.payment_method_id),
      'moves',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'kind',m.kind,'posted_on',m.posted_on,'note',m.note,'amount_cents',m.amount_cents::text,'created_at',m.created_at) order by m.created_at,m.id),'[]'::jsonb) from moves m)) end
  from s join erp_finance.account a on a.id=s.account_id cross join sums;
$$;

-- ---------------------------------------------------------------- Listagem
-- Pesquisar por operador; Situação Todos | Abertos | Fechados | Conferidos; "Listar todos os caixas" (sem ele, só os do usuário);
-- período pela data de abertura; Quantidade de controle de caixa.
create function public.erp_finance_cash_session_page(p_user_id uuid,p_state text default 'all',p_all boolean default false,p_query text default null,p_from date default null,p_to date default null,
  p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_state is null or p_state not in ('all','open','closed','checked') or p_all is null or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or length(p_query)>120 or p_query~'[[:cntrl:]]' or (p_from is not null and p_to is not null and p_from>p_to) or p_from<date '1900-01-01' or p_to>date '2100-12-31' then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with filtered as materialized (
    select s.id,s.opened_at from erp_finance.cash_session s
    where s.deleted_at is null and (p_all or s.operator_id=p_user_id) and (p_from is null or s.opened_on>=p_from) and (p_to is null or s.opened_on<=p_to)
      and (p_state='all' or (p_state='open' and s.state='open') or (p_state='closed' and s.state='closed' and not s.checked) or (p_state='checked' and s.checked))
      and (v_query is null or strpos(lower(erp_activity.actor_label(s.operator_id)),v_query)>0)
  ) select (select count(*) from filtered),(select coalesce(jsonb_agg(erp_finance.cash_session_view(x.id,false) order by x.opened_at desc,x.id),'[]'::jsonb)
      from (select * from filtered order by opened_at desc,id limit p_limit offset (p_page-1)*p_limit) x) into v_total,v_items;
  return jsonb_build_object('entity','cash_sessions','state',p_state,'all',p_all,'from',p_from,'to',p_to,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,'data_mode','erp_native');
end $$;

create function public.erp_finance_cash_session_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if not exists(select 1 from erp_finance.cash_session where id=p_id and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  v:=erp_finance.cash_session_view(p_id,true);
  return jsonb_build_object('entity','cash_sessions','record',v,'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Comandos
create function erp_finance.cash_session_values(p_session uuid,p_values jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
declare v_item jsonb; n integer:=0;
begin
  if jsonb_typeof(p_values) is distinct from 'array' or jsonb_array_length(p_values)>50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
  delete from erp_finance.cash_session_value where session_id=p_session;
  for v_item in select value from jsonb_array_elements(p_values) loop
    perform erp_finance.keys(v_item,array['payment_method_id','amount_cents']); n:=n+1;
    if not exists(select 1 from erp_catalog.payment_method where id=erp_finance.uuid_value(v_item->'payment_method_id') and deleted_at is null) then raise exception 'erp_finance_invalid_payment_method' using errcode='22023'; end if;
    insert into erp_finance.cash_session_value(session_id,position,payment_method_id,amount_cents) values(p_session,n,erp_finance.uuid_value(v_item->'payment_method_id'),erp_finance.cents(v_item->'amount_cents'));
  end loop;
end $$;

create function public.erp_finance_cash_session_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_session erp_finance.cash_session%rowtype; v_account erp_finance.account%rowtype; v_id uuid;
  v_entry erp_finance.cash_entry%rowtype; v_move erp_finance.cash_session_move%rowtype; v_kind text; v_day date; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_value boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('session_open','session_save','session_close','session_reopen','session_move','session_move_delete','session_delete') then
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

  if p_action='session_open' then
    -- Abrir Caixa: a conta financeira do tipo Caixa and the Troco; one open caixa per operator in each conta.
    perform erp_finance.keys(p_data,array['account_id','change_cents']);
    v_account:=erp_finance.cash_account(erp_finance.uuid_value(p_data->'account_id'));
    if v_account.kind<>'cash' then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
    if exists(select 1 from erp_finance.cash_session where account_id=v_account.id and operator_id=p_user_id and state='open' and deleted_at is null) then raise exception 'erp_finance_cash_session_open' using errcode='40001'; end if;
    insert into erp_finance.cash_session(account_id,operator_id,opened_on,previous_change_cents,change_cents,command_id)
      values(v_account.id,p_user_id,v_today,coalesce((select s.change_cents from erp_finance.cash_session s where s.account_id=v_account.id and s.deleted_at is null order by s.opened_at desc,s.id desc limit 1),0),
        erp_finance.cents(p_data->'change_cents'),p_command_id) returning id into v_id;
  else
    perform erp_finance.keys(p_data,case p_action when 'session_save' then array['id','expected_version','values','checked'] when 'session_close' then array['id','expected_version','values']
      when 'session_move' then array['id','expected_version','kind','posted_on','amount_cents','note'] when 'session_move_delete' then array['id','expected_version','move_id'] else array['id','expected_version'] end);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_session from erp_finance.cash_session where id=v_id;
    if not found or v_session.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    -- The account first (every cash writer locks it), then the caixa.
    perform 1 from erp_finance.account where id=v_session.account_id for update;
    select * into v_session from erp_finance.cash_session where id=v_id for update;
    if v_session.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.cash_session_view(v_id,true);
    if p_action='session_save' then
      -- Salvar: the Valores informados while the caixa is open, and Conferido of a closed caixa.
      if jsonb_typeof(p_data->'checked') is distinct from 'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_value:=(p_data->>'checked')::boolean;
      if v_value and v_session.state<>'closed' then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
      if p_data?'values' then
        if v_session.state<>'open' then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
        perform erp_finance.cash_session_values(v_id,p_data->'values');
      end if;
      update erp_finance.cash_session set checked=v_value,checked_by=case when v_value then coalesce(checked_by,p_user_id) end,checked_at=case when v_value then coalesce(checked_at,clock_timestamp()) end,
        version=version+1 where id=v_id;
    elsif p_action='session_close' then
      if v_session.state<>'open' then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
      perform erp_finance.cash_session_values(v_id,p_data->'values');
      update erp_finance.cash_session set state='closed',closed_by=p_user_id,closed_at=clock_timestamp(),version=version+1 where id=v_id;
    elsif p_action='session_reopen' then
      -- Reabrir Caixa: a closed caixa (not conferido) of the same conta goes back to open, if its operator has no other open caixa there.
      if v_session.state<>'closed' or v_session.checked then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
      if exists(select 1 from erp_finance.cash_session where account_id=v_session.account_id and operator_id=v_session.operator_id and state='open' and deleted_at is null) then raise exception 'erp_finance_cash_session_open' using errcode='40001'; end if;
      update erp_finance.cash_session set state='open',closed_by=null,closed_at=null,version=version+1 where id=v_id;
    elsif p_action='session_move' then
      -- Sangria (saída) ou Suprimento (entrada) in the conta of the caixa, while it is open.
      if v_session.state<>'open' then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
      v_kind:=erp_finance.txt(p_data,'kind',20,true); if v_kind not in ('withdrawal','supply') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      v_day:=coalesce(case when p_data?'posted_on' and p_data->'posted_on'<>'null'::jsonb then erp_finance.day(p_data->'posted_on',true) end,v_today);
      if v_day<v_session.opened_on then raise exception 'erp_finance_invalid_date' using errcode='22023'; end if;
      v_account:=erp_finance.cash_account(v_session.account_id);
      v_move.id:=gen_random_uuid();
      insert into erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,note,origin,source_key,actor,command_id)
        values(v_account.id,case when v_kind='supply' then 'in' else 'out' end,erp_finance.cents(p_data->'amount_cents',false),v_day,v_day,
          coalesce(erp_finance.cash_text(p_data,'note',240,false),case when v_kind='supply' then 'Suprimento de caixa' else 'Sangria de caixa' end),'cash_session','cash_session:'||v_move.id::text,p_user_id,p_command_id)
        returning * into v_entry;
      perform erp_finance.cash_post(v_entry,null,p_user_id,p_command_id);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      insert into erp_finance.cash_session_move(id,session_id,kind,posted_on,amount_cents,note,cash_entry_id,actor,command_id)
        values(v_move.id,v_id,v_kind,v_day,v_entry.amount_cents,erp_finance.cash_text(p_data,'note',240,false),v_entry.id,p_user_id,p_command_id);
      update erp_finance.cash_session set version=version+1 where id=v_id;
    elsif p_action='session_move_delete' then
      if v_session.state<>'open' then raise exception 'erp_finance_cash_session_state' using errcode='40001'; end if;
      select * into v_move from erp_finance.cash_session_move where id=erp_finance.uuid_value(p_data->'move_id') and session_id=v_id for update;
      if not found or v_move.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      select * into v_entry from erp_finance.cash_entry where id=v_move.cash_entry_id for update;
      if v_entry.deleted_at is null then
        perform set_config('erp_finance.owned_writer','on',true);
        perform erp_finance.cash_compensate(v_entry.id,p_user_id,p_command_id);
        update erp_finance.cash_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note='Excluído no Controle de caixa',version=version+1,updated_at=clock_timestamp() where id=v_entry.id;
        perform set_config('erp_finance.owned_writer','',true);
        update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_entry.account_id;
      end if;
      update erp_finance.cash_session_move set deleted_at=clock_timestamp(),deleted_by=p_user_id where id=v_move.id;
      update erp_finance.cash_session set version=version+1 where id=v_id;
    else
      -- Excluir: only a caixa without sangrias or suprimentos (the lançamentos stay in Caixas e bancos).
      if v_session.checked or exists(select 1 from erp_finance.cash_session_move where session_id=v_id and deleted_at is null) then raise exception 'erp_finance_cash_session_in_use' using errcode='40001'; end if;
      update erp_finance.cash_session set deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1 where id=v_id;
    end if;
  end if;
  v_result:=jsonb_build_object('entity','cash_sessions','record',case when p_action='session_delete' then jsonb_build_object('id',v_id,'deleted',true) else erp_finance.cash_session_view(v_id,true) end);

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.owned_entry_guard(),erp_finance.account_view(uuid),erp_finance.cash_session_view(uuid,boolean),erp_finance.cash_session_values(uuid,jsonb)
  from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_cash_session_page(uuid,text,boolean,text,date,date,integer,integer)','erp_finance_cash_session_get(uuid,uuid)','erp_finance_cash_session_execute(uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
