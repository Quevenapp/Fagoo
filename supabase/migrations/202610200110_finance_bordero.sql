-- Borderôs no padrão Origin ("Gerenciar recebimentos" / "Gerenciar pagamentos"): toda baixa pertence a um borderô;
-- a baixa de lançamentos selecionados pode ser agrupada num único borderô, com uma conta de destino e uma data.
-- Excluir o borderô estorna as baixas dele, sem apagar o histórico. Cada baixa continua com o seu próprio movimento
-- de caixa (o invariante da 058 não muda); o borderô agrupado reúne esses movimentos. Nenhum banco é chamado.
begin;

create table erp_finance.bordero (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('receivable','payable')),
  posted_on date not null,
  account_id uuid not null references erp_finance.account(id),
  category_id uuid references erp_finance.category(id),
  note text check(note is null or length(note) between 1 and 500),
  grouped boolean not null default false,
  version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id), deleted_note text,
  check((deleted_at is null and deleted_by is null and deleted_note is null) or (deleted_at is not null and deleted_by is not null and length(deleted_note) between 1 and 500))
);
create table erp_finance.bordero_item (
  settlement_id uuid primary key references erp_finance.settlement(id),
  bordero_id uuid not null references erp_finance.bordero(id),
  category_id uuid references erp_finance.category(id)
);
create index erp_finance_bordero_kind_day on erp_finance.bordero(kind,posted_on,id);
create index erp_finance_bordero_item_bordero on erp_finance.bordero_item(bordero_id);
alter table erp_finance.bordero enable row level security;
alter table erp_finance.bordero_item enable row level security;
revoke all on erp_finance.bordero,erp_finance.bordero_item from public,anon,authenticated,service_role;

-- Items never move between borderôs; a borderô only changes to record its exclusion.
create function erp_finance.bordero_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_table_name='bordero_item' or tg_op='DELETE' then raise exception 'erp_finance_bordero_immutable' using errcode='55000'; end if;
  if old.deleted_at is not null or (new.id,new.kind,new.posted_on,new.account_id,new.category_id,new.note,new.grouped,new.actor,new.command_id,new.created_at)
    is distinct from (old.id,old.kind,old.posted_on,old.account_id,old.category_id,old.note,old.grouped,old.actor,old.command_id,old.created_at) then
    raise exception 'erp_finance_bordero_immutable' using errcode='55000'; end if;
  return new;
end $$;
create trigger bordero_immutable before update or delete on erp_finance.bordero for each row execute function erp_finance.bordero_immutable();
create trigger bordero_item_immutable before update or delete on erp_finance.bordero_item for each row execute function erp_finance.bordero_immutable();

-- Every payment joins a borderô. The batch below names it for the transaction; any other writer (010 settle,
-- CNAB returns) gets a borderô of its own baixa.
create function erp_finance.settlement_bordero()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_bordero uuid; v_category uuid; v_kind text;
begin
  if new.kind<>'payment' then return null; end if;
  v_bordero:=nullif(current_setting('erp_finance.bordero_id',true),'')::uuid;
  v_category:=nullif(current_setting('erp_finance.bordero_category',true),'')::uuid;
  if v_bordero is null then
    select kind into v_kind from erp_finance.title where id=new.title_id;
    insert into erp_finance.bordero(kind,posted_on,account_id,note,actor,command_id) values(v_kind,new.posted_on,new.account_id,new.note,new.actor,new.command_id) returning id into v_bordero;
  end if;
  insert into erp_finance.bordero_item(settlement_id,bordero_id,category_id) values(new.id,v_bordero,v_category);
  return null;
end $$;
create trigger settlement_bordero after insert on erp_finance.settlement for each row execute function erp_finance.settlement_bordero();

-- Existing baixas: one borderô each, with their own date, conta, histórico and author.
with created as (
  insert into erp_finance.bordero(id,kind,posted_on,account_id,note,actor,command_id,created_at)
  select s.id,t.kind,s.posted_on,s.account_id,s.note,s.actor,s.command_id,s.created_at
  from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id where s.kind='payment'
  returning id
) insert into erp_finance.bordero_item(settlement_id,bordero_id) select id,id from created;

create function erp_finance.bordero_active(p_bordero uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_finance.bordero_item i where i.bordero_id=p_bordero
   and not exists(select 1 from erp_finance.settlement x where x.reverses_id=i.settlement_id));
$$;
-- Lines of a borderô with the Origin columns (Juros, Desconto, Acréscimo, Tarifa, Valor Pago) and its totals.
create function erp_finance.bordero_dto(p_bordero uuid,p_lines boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
 with lines as (
   select s.id settlement_id,s.title_id,t.contact_id,r.name contact_name,coalesce(t.source_reference,d.number::text) document_number,t.description,
     s.principal_cents,s.interest_cents,s.penalty_cents,s.discount_cents,s.fee_cents,s.net_cash_cents,
     s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents paid_cents,
     exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id) reversed,i.category_id,g.name category_name
   from erp_finance.bordero_item i join erp_finance.settlement s on s.id=i.settlement_id join erp_finance.title t on t.id=s.title_id
   join erp_catalog.record r on r.id=t.contact_id
   left join erp_finance.category g on g.id=i.category_id
   left join erp_finance.document_title l on l.title_id=t.id left join erp_finance.document_posting dp on dp.id=l.posting_id left join erp_documents.document d on d.id=dp.document_id
   where i.bordero_id=p_bordero
 ), active as (select * from lines where not reversed)
 select jsonb_build_object('id',b.id,'kind',b.kind,'posted_on',b.posted_on,'account_id',b.account_id,'account_name',a.name,'category_id',b.category_id,'category_name',c.name,
   'note',b.note,'grouped',b.grouped,'version',b.version,'created_at',b.created_at,'deleted_at',b.deleted_at,'active',(select count(*)>0 from active),
   'contact_name',case when (select count(distinct contact_id) from lines)=1 then (select min(contact_name) from lines) end,
   'contacts',(select count(distinct contact_id) from lines),'items',(select count(*) from lines),
   'totals',jsonb_build_object('paid_cents',(select coalesce(sum(paid_cents),0) from active)::text,'interest_cents',(select coalesce(sum(interest_cents),0) from active)::text,
     'penalty_cents',(select coalesce(sum(penalty_cents),0) from active)::text,'discount_cents',(select coalesce(sum(discount_cents),0) from active)::text,
     'fee_cents',(select coalesce(sum(fee_cents),0) from active)::text,'net_cash_cents',(select coalesce(sum(net_cash_cents),0) from active)::text))
   ||case when p_lines then jsonb_build_object('lines',(select coalesce(jsonb_agg(jsonb_build_object('settlement_id',settlement_id,'title_id',title_id,'contact_name',contact_name,
       'document_number',document_number,'description',description,'principal_cents',principal_cents::text,'interest_cents',interest_cents::text,'penalty_cents',penalty_cents::text,
       'discount_cents',discount_cents::text,'fee_cents',fee_cents::text,'paid_cents',paid_cents::text,'net_cash_cents',net_cash_cents::text,'reversed',reversed,
       'category_id',category_id,'category_name',category_name) order by contact_name,settlement_id),'[]'::jsonb) from lines)) else '{}'::jsonb end
 from erp_finance.bordero b join erp_finance.account a on a.id=b.account_id left join erp_finance.category c on c.id=b.category_id where b.id=p_bordero;
$$;

-- Baixa de lançamentos (1 a 100 contas) and Excluir borderô, with the 010 command, audit and role checks.
create function public.erp_finance_bordero_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_kind text; v_grouped boolean; v_note text; v_item jsonb;
  v_title erp_finance.title%rowtype; v_account erp_finance.account%rowtype; v_original erp_finance.settlement%rowtype; v_bordero erp_finance.bordero%rowtype;
  v_destination uuid; v_category uuid; v_top_category uuid; v_day date; v_group_day date; v_id uuid; v_bordero_id uuid; v_settlement uuid;
  v_principal bigint; v_interest bigint; v_penalty bigint; v_discount bigint; v_fee bigint; v_net bigint; v_delta bigint;
  v_rows jsonb:='[]'::jsonb; v_borderos uuid[]:='{}'; v_ids uuid[]; v_count integer;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('settle_batch','bordero_delete') then raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='settle_batch' then
    perform erp_finance.keys(p_data,array['kind','grouped','account_id','category_id','note','items']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    if jsonb_typeof(p_data->'grouped') is distinct from 'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    v_grouped:=(p_data->>'grouped')::boolean; v_note:=erp_finance.txt(p_data,'note',500);
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 100 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    v_count:=jsonb_array_length(p_data->'items');
    v_destination:=erp_finance.uuid_value(p_data->'account_id',false); v_top_category:=erp_finance.uuid_value(p_data->'category_id',false);
    -- Lançamento agrupado: two or more contas, one destino and one date, as in Origin.
    if v_grouped and (v_count<2 or v_destination is null) then raise exception 'erp_finance_invalid_grouping' using errcode='22023'; end if;
    if not v_grouped and (v_destination is not null or v_top_category is not null) then raise exception 'erp_finance_invalid_grouping' using errcode='22023'; end if;
    select array_agg(erp_finance.uuid_value(value->'id') order by erp_finance.uuid_value(value->'id')) into v_ids from jsonb_array_elements(p_data->'items');
    if (select count(distinct x) from unnest(v_ids) x)<>v_count then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    -- Titles first, in UUID order, then accounts: the lock order of the 010 settle and of CNAB.
    perform 1 from erp_finance.title where id=any(v_ids) order by id for update;
    if v_grouped then
      select * into v_account from erp_finance.account where id=v_destination for update;
      if not found or not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
      if v_top_category is not null then perform erp_finance.active_category(v_top_category,v_kind); end if;
    end if;
    for v_item in select value from jsonb_array_elements(p_data->'items') order by erp_finance.uuid_value(value->'id') loop
      perform erp_finance.keys(v_item,array['id','expected_version','account_id','category_id','posted_on','principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents']);
      v_id:=erp_finance.uuid_value(v_item->'id');
      select * into v_title from erp_finance.title where id=v_id;
      if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if v_title.version<>erp_finance.expected(v_item->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_title.kind<>v_kind then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      if v_title.cancelled then raise exception 'erp_finance_cancelled_title' using errcode='40001'; end if;
      v_day:=erp_finance.day(v_item->'posted_on',true);
      if v_day<v_title.issued_on then raise exception 'erp_finance_payment_before_issue' using errcode='22023'; end if;
      if v_grouped then
        if erp_finance.uuid_value(v_item->'account_id')<>v_destination or (v_group_day is not null and v_day<>v_group_day) then raise exception 'erp_finance_invalid_grouping' using errcode='22023'; end if;
        v_group_day:=v_day;
      else
        select * into v_account from erp_finance.account where id=erp_finance.uuid_value(v_item->'account_id') for update;
        if not found or not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
      end if;
      if exists(select 1 from erp_finance.movement where account_id=v_account.id and kind='opening' and posted_on>v_day) then raise exception 'erp_finance_payment_before_opening' using errcode='22023'; end if;
      v_category:=erp_finance.uuid_value(v_item->'category_id',false);
      if v_category is not null then perform erp_finance.active_category(v_category,v_kind); end if;
      v_principal:=erp_finance.cents(v_item->'principal_cents',false);
      v_interest:=erp_finance.cents(v_item->'interest_cents'); v_penalty:=erp_finance.cents(v_item->'penalty_cents');
      v_discount:=erp_finance.cents(v_item->'discount_cents'); v_fee:=erp_finance.cents(v_item->'fee_cents');
      if v_principal>v_title.amount_cents-v_title.settled_cents then raise exception 'erp_finance_overpayment' using errcode='40001'; end if;
      v_net:=v_principal+v_interest+v_penalty-v_discount+case when v_kind='payable' then v_fee else -v_fee end;
      if v_net<0 or v_net>999999999999999 or v_discount>v_principal+v_interest+v_penalty then raise exception 'erp_finance_invalid_net_cash' using errcode='22023'; end if;
      if v_grouped then
        if v_bordero_id is null then
          insert into erp_finance.bordero(kind,posted_on,account_id,category_id,note,grouped,actor,command_id) values(v_kind,v_day,v_destination,v_top_category,v_note,true,p_user_id,p_command_id) returning id into v_bordero_id;
          v_borderos:=array_append(v_borderos,v_bordero_id);
        end if;
      else
        insert into erp_finance.bordero(kind,posted_on,account_id,category_id,note,actor,command_id) values(v_kind,v_day,v_account.id,v_category,v_note,p_user_id,p_command_id) returning id into v_bordero_id;
        v_borderos:=array_append(v_borderos,v_bordero_id);
      end if;
      perform set_config('erp_finance.bordero_id',v_bordero_id::text,true); perform set_config('erp_finance.bordero_category',coalesce(v_category::text,''),true);
      insert into erp_finance.settlement(title_id,account_id,kind,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
        values(v_id,v_account.id,'payment',v_day,v_principal,v_interest,v_penalty,v_discount,v_fee,v_net,v_note,p_user_id,p_command_id) returning id into v_settlement;
      perform set_config('erp_finance.bordero_id','',true); perform set_config('erp_finance.bordero_category','',true);
      update erp_finance.title set settled_cents=settled_cents+v_principal,version=version+1,updated_at=clock_timestamp() where id=v_id;
      perform erp_finance.post_settlement_movements(v_settlement,case when v_kind='receivable' then v_net else -v_net end);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      if not v_grouped then v_bordero_id:=null; end if;
      v_rows:=v_rows||jsonb_build_array(jsonb_build_object('title',erp_finance.dto('titles',v_id),'settlement',erp_finance.dto('settlements',v_settlement),
        'bordero_id',(select bordero_id from erp_finance.bordero_item where settlement_id=v_settlement)));
    end loop;
    v_result:=jsonb_build_object('entity','borderos','items',v_rows,'borderos',(select coalesce(jsonb_agg(erp_finance.bordero_dto(b,false) order by b),'[]'::jsonb) from unnest(v_borderos) b));

  else
    perform erp_finance.keys(p_data,array['id','expected_version','posted_on','note']);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_bordero from erp_finance.bordero where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_bordero.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    if v_bordero.deleted_at is not null or not erp_finance.bordero_active(v_id) then raise exception 'erp_finance_bordero_inactive' using errcode='40001'; end if;
    v_day:=erp_finance.day(p_data->'posted_on',true); v_note:=erp_finance.txt(p_data,'note',500,true);
    v_before:=erp_finance.bordero_dto(v_id,true);
    -- Each active baixa of the borderô is reversed like the 010 "Estornar baixa": titles in UUID order, then the account.
    select array_agg(s.title_id order by s.title_id) into v_ids from erp_finance.bordero_item i join erp_finance.settlement s on s.id=i.settlement_id
      where i.bordero_id=v_id and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id);
    perform 1 from erp_finance.title where id=any(v_ids) order by id for update;
    for v_original in select s.* from erp_finance.bordero_item i join erp_finance.settlement s on s.id=i.settlement_id
      where i.bordero_id=v_id and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id) order by s.title_id,s.id loop
      select * into v_title from erp_finance.title where id=v_original.title_id;
      if v_title.cancelled then raise exception 'erp_finance_cancelled_title' using errcode='40001'; end if;
      if v_day<v_original.posted_on then raise exception 'erp_finance_invalid_reversal_date' using errcode='22023'; end if;
      select * into v_account from erp_finance.account where id=v_original.account_id for update;
      insert into erp_finance.settlement(title_id,account_id,kind,reverses_id,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
        values(v_title.id,v_account.id,'reversal',v_original.id,v_day,v_original.principal_cents,v_original.interest_cents,v_original.penalty_cents,v_original.discount_cents,v_original.fee_cents,v_original.net_cash_cents,v_note,p_user_id,p_command_id) returning id into v_settlement;
      update erp_finance.title set settled_cents=settled_cents-v_original.principal_cents,version=version+1,updated_at=clock_timestamp() where id=v_title.id;
      perform erp_finance.post_settlement_movements(v_settlement,case when v_title.kind='receivable' then -v_original.net_cash_cents else v_original.net_cash_cents end);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
      v_rows:=v_rows||jsonb_build_array(jsonb_build_object('title',erp_finance.dto('titles',v_title.id),'settlement',erp_finance.dto('settlements',v_settlement),'bordero_id',v_id));
    end loop;
    -- Every baixa may have been reversed by "Estornar baixa" while the locks waited: nothing is recorded then.
    if jsonb_array_length(v_rows)=0 then raise exception 'erp_finance_bordero_inactive' using errcode='40001'; end if;
    update erp_finance.bordero set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note=v_note,version=version+1 where id=v_id;
    v_result:=jsonb_build_object('entity','borderos','items',v_rows,'borderos',jsonb_build_array(erp_finance.bordero_dto(v_id,false)),'note',v_note);
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

-- "Gerenciar recebimentos / pagamentos": active borderôs of the kind, newest first, with the totals of the filter.
create function public.erp_finance_bordero_page(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,p_query text default null,
  p_account uuid default null,p_categories text[] default null,p_from date default null,p_to date default null,p_amount_cents bigint default null,p_title uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_categories uuid[]; v_none boolean:=false; v_total bigint; v_totals jsonb; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100
    or length(p_query)>120 or p_query~'[[:cntrl:]]' or p_amount_cents not between 1 and 999999999999999
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 50 or array_position(p_categories,null) is not null
      or (select count(distinct lower(c)) from unnest(p_categories) c)<>cardinality(p_categories)
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
  then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_categories is not null then v_none:='none'=any(p_categories); select array_agg(c::uuid) into v_categories from unnest(p_categories) c where c<>'none'; end if;
  with filtered as materialized (
    select b.id,b.posted_on,(erp_finance.bordero_dto(b.id,false)) dto from erp_finance.bordero b
    where b.kind=p_kind and b.deleted_at is null and erp_finance.bordero_active(b.id)
      and (p_account is null or b.account_id=p_account)
      and (p_from is null or b.posted_on>=p_from) and (p_to is null or b.posted_on<=p_to)
      and (p_categories is null or exists(select 1 from erp_finance.bordero_item i where i.bordero_id=b.id
        and ((v_none and coalesce(i.category_id,b.category_id) is null) or coalesce(i.category_id,b.category_id)=any(v_categories))))
      and (p_title is null or exists(select 1 from erp_finance.bordero_item i join erp_finance.settlement s on s.id=i.settlement_id where i.bordero_id=b.id and s.title_id=p_title))
      and (v_query is null or strpos(lower(coalesce(b.note,'')),v_query)>0 or exists(select 1 from erp_finance.bordero_item i join erp_finance.settlement s on s.id=i.settlement_id
        join erp_finance.title t on t.id=s.title_id join erp_catalog.record r on r.id=t.contact_id where i.bordero_id=b.id and strpos(lower(concat_ws(' ',r.name,t.description,t.source_reference)),v_query)>0))
  ), valued as (select * from filtered where p_amount_cents is null or (dto->'totals'->>'paid_cents')::bigint=p_amount_cents)
  select (select count(*) from valued),
    jsonb_build_object('count',(select count(*) from valued),'paid_cents',(select coalesce(sum((dto->'totals'->>'paid_cents')::numeric),0) from valued)::text,
      'penalty_cents',(select coalesce(sum((dto->'totals'->>'penalty_cents')::numeric),0) from valued)::text,'discount_cents',(select coalesce(sum((dto->'totals'->>'discount_cents')::numeric),0) from valued)::text,
      'interest_cents',(select coalesce(sum((dto->'totals'->>'interest_cents')::numeric),0) from valued)::text,'fee_cents',(select coalesce(sum((dto->'totals'->>'fee_cents')::numeric),0) from valued)::text),
    (select coalesce(jsonb_agg(dto order by posted_on desc,id desc),'[]'::jsonb) from (select * from valued order by posted_on desc,id desc limit p_limit offset (p_page-1)*p_limit) page)
  into v_total,v_totals,v_items;
  return jsonb_build_object('entity','borderos','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'total',v_total,'totals',v_totals,'data_mode','erp_native');
end $$;

create function public.erp_finance_bordero_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_id is null then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  v:=erp_finance.bordero_dto(p_id,true);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity','borderos','record',v,'data_mode','erp_native');
end $$;

revoke all on function erp_finance.bordero_immutable(),erp_finance.settlement_bordero(),erp_finance.bordero_active(uuid),erp_finance.bordero_dto(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_bordero_execute(uuid,uuid,text,jsonb),public.erp_finance_bordero_page(uuid,text,integer,integer,text,uuid,text[],date,date,bigint,uuid),public.erp_finance_bordero_get(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_finance_bordero_execute(uuid,uuid,text,jsonb),public.erp_finance_bordero_page(uuid,text,integer,integer,text,uuid,text[],date,date,bigint,uuid),public.erp_finance_bordero_get(uuid,uuid) to service_role;
commit;
