-- 249: Histórico da baixa com até 2.000 caracteres (lane financeiro, onda E).
-- * Baixa de lançamentos (settle_batch, 110): o Histórico aceita 2.000 caracteres, como no Origin. O texto inteiro fica em
--   settlement.history quando passa de 500; settlement.note, o borderô e o movimento da conta continuam com os primeiros 500,
--   que são o que as telas antigas leem. O extrato de Caixas e bancos mostra o histórico inteiro da baixa.
-- * A baixa individual antiga (erp_finance_execute 'settle') e o estorno continuam com 500 caracteres.
-- Nada aqui movimenta banco. Requer 110, 136 e 210.
begin;

do $$ declare r record; begin
  for r in select * from (values
    ('public.erp_finance_bordero_execute(uuid,uuid,text,jsonb)','259a5f276aa7406e5f356e5c26cbaa557292d444561dac3d75cdf453aa6c01f6'),
    ('erp_finance.statement_lines(uuid,date,date,boolean)','c71f754686259447670b8961c03b5703ccdc825382622256b4d95d3c9413c16b'),
    ('erp_finance.utf16_length(text)','1ce5e1743843cc6af218c50c1d7c7da13a4aaa815564fde468d88ad45381cf87')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_settle_history_249_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
end $$;

-- The whole Histórico of a baixa when it passes 500 UTF-16 units (the limit the API and the screens count); note keeps its beginning.
alter table erp_finance.settlement add column history text;
alter table erp_finance.settlement add constraint settlement_history_check check(history is null
  or (kind='payment' and erp_finance.utf16_length(history) between 501 and 2000 and history=btrim(history)
    and note is not null and length(note)<length(history) and left(history,length(note))=note));

create function erp_finance.settlement_text(p_data jsonb,out note text,out history text)
language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=erp_finance.txt(p_data,'note',2000); n integer:=500;
begin
  if erp_finance.utf16_length(v)>2000 then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  if v is null or erp_finance.utf16_length(v)<=500 then note:=v; history:=null; return; end if;
  note:=rtrim(left(v,n));
  while erp_finance.utf16_length(note)>500 loop n:=n-1; note:=rtrim(left(v,n)); end loop;
  history:=v;
end $$;

CREATE OR REPLACE FUNCTION public.erp_finance_bordero_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_kind text; v_grouped boolean; v_note text; v_item jsonb;
  v_title erp_finance.title%rowtype; v_account erp_finance.account%rowtype; v_original erp_finance.settlement%rowtype; v_bordero erp_finance.bordero%rowtype;
  v_destination uuid; v_category uuid; v_top_category uuid; v_day date; v_group_day date; v_id uuid; v_bordero_id uuid; v_settlement uuid;
  v_principal bigint; v_interest bigint; v_penalty bigint; v_discount bigint; v_fee bigint; v_net bigint; v_delta bigint;
  v_rows jsonb:='[]'::jsonb; v_borderos uuid[]:='{}'; v_ids uuid[]; v_count integer; v_text record; v_history text;
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
    v_grouped:=(p_data->>'grouped')::boolean;
    -- 249: the Histórico of the baixa takes 2,000 characters, as in Origin; the borderô and the movimento keep its first 500.
    select * into v_text from erp_finance.settlement_text(p_data); v_note:=v_text.note; v_history:=v_text.history;
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
      insert into erp_finance.settlement(title_id,account_id,kind,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,history,actor,command_id)
        values(v_id,v_account.id,'payment',v_day,v_principal,v_interest,v_penalty,v_discount,v_fee,v_net,v_note,v_history,p_user_id,p_command_id) returning id into v_settlement;
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
end $function$;

CREATE OR REPLACE FUNCTION erp_finance.statement_lines(p_account uuid, p_from date, p_to date, p_deleted boolean)
 RETURNS SETOF erp_finance.statement_line
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
    -- 249: the payment line shows the whole Histórico of the baixa (up to 2,000 characters).
    coalesce(case when m.kind='payment' then s.history end,m.note,t.description),t.id,t.kind,null,null,null,null,t.competence_on
  from erp_finance.movement m join erp_finance.settlement s on s.id=m.settlement_id join erp_finance.title t on t.id=s.title_id
    left join erp_finance.bordero_item i on i.settlement_id=coalesce(s.reverses_id,s.id) left join erp_finance.bordero b on b.id=i.bordero_id
  where not p_deleted and (p_account is null or m.account_id=p_account) and (p_from is null or m.posted_on>=p_from) and (p_to is null or m.posted_on<=p_to)
  union all
  select m.id,'opening',m.posted_on,m.created_at,m.account_id,m.delta_cents,m.category_id,null,coalesce(m.note,'Saldo inicial'),null,null,null,null,null,null,m.posted_on
  from erp_finance.movement m
  where m.kind='opening' and not p_deleted and (p_account is null or m.account_id=p_account) and (p_from is null or m.posted_on>=p_from) and (p_to is null or m.posted_on<=p_to);
$function$;

revoke all on function erp_finance.settlement_text(jsonb) from public,anon,authenticated,service_role;
revoke all on function erp_finance.statement_lines(uuid,date,date,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_bordero_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_finance_bordero_execute(uuid,uuid,text,jsonb) to service_role;
commit;
