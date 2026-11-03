-- Minimal current relationship flags, with existing role checks and no effect writes.
-- Requires 017 and 018. Command results/audits retain their original snapshots;
-- replay responses refresh only relationship flags, never document/title values.
begin;

create function erp_documents.effect_flags(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object(
  'finance_active',exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting p where p.document_id=p_id and p.state='active'));
$$;

create function erp_documents.project_result_flags(p_result jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb:=p_result; key text;
begin
 foreach key in array array['document','proposal','sale'] loop
  if jsonb_typeof(result->key)='object' then
   result:=jsonb_set(result,array[key,'effect_flags'],erp_documents.effect_flags((result->key->>'id')::uuid),true);
  end if;
 end loop;
 return result;
end $$;

create or replace function erp_documents.dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select d.body||jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'effect_flags',erp_documents.effect_flags(d.id),'contact_snapshot',d.contact_snapshot,'source_proposal_id',d.source_proposal_id,'created_at',d.created_at,'updated_at',d.updated_at,
  'items',(select coalesce(jsonb_agg(i.data||jsonb_build_object('product_snapshot',i.product_snapshot) order by position),'[]'::jsonb)
    from erp_documents.item i where document_id=d.id)) from erp_documents.document d where id=p_id;
$$;

create or replace function erp_documents.command_replay(p_actor uuid,p_command uuid,p_hash text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v erp_documents.command%rowtype; begin
 if p_command is null then raise exception 'erp_document_command_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852908,hashtext(p_command::text));
 select * into v from erp_documents.command where command_id=p_command;
 if found then
  if v.actor<>p_actor or v.request_hash<>p_hash then raise exception 'erp_document_command_conflict' using errcode='40001'; end if;
  return erp_documents.project_result_flags(v.result)||'{"replayed":true}'::jsonb; end if;
 return null;
end $$;

-- Historical existence is deliberate: reversed/cancelled source titles keep
-- their immutable principal/source fields, even when the document is editable.
create function erp_finance.project_result_link(p_result jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb:=p_result; rows jsonb;
begin
 if result->>'entity'='titles' then
  if jsonb_typeof(result->'record')='object' then
   result:=jsonb_set(result,'{record,document_linked}',to_jsonb(exists(
    select 1 from erp_finance.document_title l where l.title_id=(result->'record'->>'id')::uuid)),true);
  end if;
  if jsonb_typeof(result->'items')='array' then
   select coalesce(jsonb_agg(item||jsonb_build_object('document_linked',exists(
    select 1 from erp_finance.document_title l where l.title_id=(item->>'id')::uuid)) order by position),'[]'::jsonb)
    into rows from jsonb_array_elements(result->'items') with ordinality as items(item,position);
   result:=jsonb_set(result,'{items}',rows,false);
  end if;
 end if;
 return result;
end $$;

create or replace function erp_finance.dto(p_entity text,p_id uuid)
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
      'document_linked',exists(select 1 from erp_finance.document_title l where l.title_id=t.id),
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

create or replace function public.erp_finance_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
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
    return erp_finance.project_result_link(v_command.result)||jsonb_build_object('replayed',true);
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

-- New helpers are private; CREATE OR REPLACE preserves existing RPC ACLs.
revoke all on function erp_documents.effect_flags(uuid) from public,anon,authenticated,service_role;
revoke all on function erp_documents.project_result_flags(jsonb) from public,anon,authenticated,service_role;
revoke all on function erp_finance.project_result_link(jsonb) from public,anon,authenticated,service_role;
commit;
