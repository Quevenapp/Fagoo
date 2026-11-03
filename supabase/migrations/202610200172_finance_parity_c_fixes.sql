-- Financeiro no padrão Origin, onda C (lane financeiro): correções e telas que faltavam nas migrações 135 a 138.
-- - Reverter conciliação com "Estornar a(s) movimentação(ções) relacionada(s)" estorna também as baixas (o estorno do 010,
--   na data da baixa) e as transferências (a transferência inversa), como no Origin.
-- - Excluir uma conta financeira cujo único movimento é o saldo inicial: o saldo inicial é compensado na mesma data; a
--   cobrança (perfil CNAB), os lançamentos, as contas, os borderôs, as recorrências, os extratos OFX, os pagamentos de
--   comissão e as formas de pagamento continuam impedindo a exclusão (use Inativar).
-- - Ocorrência Parcelada como o Origin a gera: uma recorrência com o nº de parcelas; cada parcela tem o valor informado,
--   a primeira conta nasce na inclusão e as seguintes em "Gerar contas", até a última.
-- - Ficha financeira paginada (100 linhas por página, totais do período inteiro), para caber no limite da resposta.
-- - Contas em aberto do contato (lidas pelos pedidos quando as Preferências permitem a visualização).
begin;

-- ---------------------------------------------------------------- Compensação do saldo inicial
alter table erp_finance.movement drop constraint movement_kind_check;
alter table erp_finance.movement add constraint movement_kind_check check(kind in ('opening','opening_reversal','payment','reversal','transfer_out','transfer_in','bank_fee','bank_fee_reversal','entry','entry_reversal'));
alter table erp_finance.movement drop constraint movement_check;
alter table erp_finance.movement add constraint movement_check check(
  (kind='opening' and settlement_id is null and transfer_id is null and entry_id is null and compensates_id is null)
  or (kind='opening_reversal' and settlement_id is null and transfer_id is null and entry_id is null and compensates_id is not null)
  or (kind in ('payment','reversal','bank_fee','bank_fee_reversal') and settlement_id is not null and transfer_id is null and entry_id is null and compensates_id is null)
  or (kind in ('transfer_out','transfer_in') and settlement_id is null and transfer_id is not null and entry_id is null and compensates_id is null)
  or (kind='entry' and settlement_id is null and transfer_id is null and entry_id is not null and compensates_id is null)
  or (kind='entry_reversal' and settlement_id is null and transfer_id is null and entry_id is not null and compensates_id is not null));

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
      or exists(select 1 from erp_finance.commission_entry c where c.account_id=a.id) or exists(select 1 from erp_catalog.payment_method f where f.account_id=a.id and f.deleted_at is null),
    'cnab',case when p.id is null then null else jsonb_build_object('bank',p.identity->>'bank','agency',p.identity->>'agency','account',p.identity->>'account','account_digit',p.identity->>'accountDigit') end,
    'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at)
  from erp_finance.account a left join erp_cnab.profile p on p.account_id=a.id where a.id=p_id and a.deleted_at is null;
$function$;

CREATE OR REPLACE FUNCTION public.erp_finance_account_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_account erp_finance.account%rowtype; v_result jsonb; v_before jsonb; v_id uuid;
  v_type text; v_kind text; v_name text; v_code text; v_institution text; v_agency text; v_number text; v_digit text; v_start date; v_opening bigint;
  v_default boolean; v_first date; v_profile jsonb; v_target text; v_value boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('account_create','account_update','account_set_active','account_set_default','account_delete') then
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
  -- One default account at a time: every writer of the flags takes this lock first.
  perform pg_advisory_xact_lock(hashtextextended('erp_finance.account_defaults',0));

  if p_action in ('account_create','account_update') then
    if p_action='account_create' then
      perform erp_finance.keys(p_data,array['account_type','institution_code','institution_name','name','agency','account_number','account_digit','start_on','opening_cents','default_movements']);
    else
      perform erp_finance.keys(p_data,array['id','expected_version','account_type','institution_code','institution_name','name','agency','account_number','account_digit','start_on','opening_cents','default_movements','default_boleto']);
      v_id:=erp_finance.uuid_value(p_data->'id');
      select * into v_account from erp_finance.account where id=v_id for update;
      if not found or v_account.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
      if v_account.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      v_before:=erp_finance.account_view(v_id);
    end if;
    v_type:=erp_finance.txt(p_data,'account_type',20,true);
    if v_type not in ('checking','savings','cash','receiving','other') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_kind:=case when v_type in ('checking','savings') then 'bank' when v_type='cash' then 'cash' else 'other' end;
    v_code:=erp_finance.account_text(p_data,'institution_code','^[0-9]{3}$'); v_institution:=erp_finance.txt(p_data,'institution_name',80);
    if v_type in ('checking','savings','receiving') and (v_code is null or v_institution is null) then raise exception 'erp_finance_institution_required' using errcode='22023'; end if;
    if v_type in ('cash','other') then v_code:=null; v_institution:=null; end if;
    if (v_code is null)<>(v_institution is null) or v_institution~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    v_agency:=erp_finance.account_text(p_data,'agency','^[0-9A-Za-z-]{1,10}$'); v_number:=erp_finance.account_text(p_data,'account_number','^[0-9A-Za-z.-]{1,20}$');
    v_digit:=erp_finance.account_text(p_data,'account_digit','^[0-9A-Za-z]{1,2}$');
    if v_kind='bank' and (v_agency is null or v_number is null or v_digit is null) then raise exception 'erp_finance_bank_data_required' using errcode='22023'; end if;
    if v_kind<>'bank' then v_agency:=null; v_number:=null; v_digit:=null; end if;
    v_name:=erp_finance.txt(p_data,'name',200,true);
    -- Origin: Descrição com até 50 caracteres; nomes antigos mais longos só mudam quando editados.
    if length(v_name)>50 and (p_action='account_create' or v_name is distinct from v_account.name) then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
    v_start:=erp_finance.day(p_data->'start_on',true);
    if jsonb_typeof(coalesce(p_data->'default_movements','false'::jsonb))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    v_default:=coalesce((p_data->>'default_movements')::boolean,false);
    if p_action='account_create' then
      if not p_data?'opening_cents' then raise exception 'erp_finance_invalid_cents' using errcode='22023'; end if;
      v_opening:=erp_finance.cents(p_data->'opening_cents',true,true);
      if v_default then update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements; end if;
      insert into erp_finance.account(name,kind,account_type,institution_code,institution_name,agency,account_number,account_digit,start_on,opening_recorded,default_movements)
        values(v_name,v_kind,v_type,v_code,v_institution,v_agency,v_number,v_digit,v_start,true,v_default) returning id into v_id;
      insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_opening,v_start,'Saldo inicial',p_user_id,p_command_id);
    else
      select jsonb_build_object('agency',p.identity->>'agency','account',p.identity->>'account','digit',p.identity->>'accountDigit') into v_profile from erp_cnab.profile p where p.account_id=v_id;
      if v_profile is not null and (v_kind<>'bank' or v_agency is distinct from v_profile->>'agency' or v_number is distinct from v_profile->>'account' or v_digit is distinct from v_profile->>'digit') then
        raise exception 'erp_finance_account_profile_mismatch' using errcode='22023'; end if;
      -- "Tornar padrão de emissão de boletos": só conta bancária com cobrança (perfil CNAB) configurada.
      if jsonb_typeof(coalesce(p_data->'default_boleto',to_jsonb(v_account.default_boleto)))<>'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_value:=coalesce((p_data->>'default_boleto')::boolean,v_account.default_boleto);
      if v_value and (v_kind<>'bank' or v_profile is null or not v_account.active) then raise exception 'erp_finance_boleto_profile_required' using errcode='22023'; end if;
      if v_value and not v_account.default_boleto then update erp_finance.account set default_boleto=false,version=version+1,updated_at=clock_timestamp() where default_boleto and id<>v_id; end if;
      select min(posted_on) into v_first from erp_finance.movement where account_id=v_id;
      if v_first is not null and v_start>v_first then raise exception 'erp_finance_start_after_movement' using errcode='22023'; end if;
      if p_data?'opening_cents' then
        if v_account.opening_recorded or not v_account.active then raise exception 'erp_finance_opening_conflict' using errcode='40001'; end if;
        v_opening:=erp_finance.cents(p_data->'opening_cents',true,true);
      end if;
      if v_default and not v_account.default_movements then
        if not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
        update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements and id<>v_id;
      end if;
      update erp_finance.account set name=v_name,kind=v_kind,account_type=v_type,institution_code=v_code,institution_name=v_institution,agency=v_agency,account_number=v_number,
        account_digit=v_digit,start_on=v_start,default_movements=v_default,default_boleto=v_value,opening_recorded=opening_recorded or v_opening is not null,version=version+1,updated_at=clock_timestamp() where id=v_id;
      if v_opening is not null then
        insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_opening,v_start,'Saldo inicial',p_user_id,p_command_id);
      end if;
    end if;

  else
    perform erp_finance.keys(p_data,case p_action when 'account_set_active' then array['id','expected_version','active'] when 'account_set_default' then array['id','expected_version','target','value']
      else array['id','expected_version'] end);
    v_id:=erp_finance.uuid_value(p_data->'id');
    select * into v_account from erp_finance.account where id=v_id for update;
    if not found or v_account.deleted_at is not null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_account.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.account_view(v_id);
    if p_action='account_set_active' then
      if jsonb_typeof(p_data->'active') is distinct from 'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
      v_value:=(p_data->>'active')::boolean;
      if v_value=v_account.active then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      -- Inativar tira a conta dos padrões, como no Origin (uma conta inativa não recebe movimentações nem boletos).
      update erp_finance.account set active=v_value,default_movements=default_movements and v_value,default_boleto=default_boleto and v_value,
        version=version+1,updated_at=clock_timestamp() where id=v_id;
    elsif p_action='account_set_default' then
      v_target:=erp_finance.txt(p_data,'target',20,true);
      if v_target not in ('movements','boleto') or jsonb_typeof(p_data->'value') is distinct from 'boolean' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
      v_value:=(p_data->>'value')::boolean;
      if v_value and not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
      if v_target='boleto' and v_value and (v_account.kind<>'bank' or not exists(select 1 from erp_cnab.profile where account_id=v_id)) then
        raise exception 'erp_finance_boleto_profile_required' using errcode='22023'; end if;
      if v_value=(case v_target when 'movements' then v_account.default_movements else v_account.default_boleto end) then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
      if v_value then
        if v_target='movements' then update erp_finance.account set default_movements=false,version=version+1,updated_at=clock_timestamp() where default_movements and id<>v_id;
        else update erp_finance.account set default_boleto=false,version=version+1,updated_at=clock_timestamp() where default_boleto and id<>v_id; end if;
      end if;
      update erp_finance.account set default_movements=case when v_target='movements' then v_value else default_movements end,
        default_boleto=case when v_target='boleto' then v_value else default_boleto end,version=version+1,updated_at=clock_timestamp() where id=v_id;
    else
      -- Excluir: só conta sem uso (o saldo inicial não conta, como no Origin). O saldo inicial é compensado na mesma data,
      -- então nenhum total soma a conta excluída; o cadastro, os movimentos e a auditoria ficam.
      if (v_before->>'in_use')::boolean or exists(select 1 from erp_finance.transfer where from_account_id=v_id or to_account_id=v_id) then
        raise exception 'erp_finance_account_in_use' using errcode='40001'; end if;
      update erp_finance.account set active=false,default_movements=false,default_boleto=false,deleted_at=clock_timestamp(),deleted_by=p_user_id,
        version=version+1,updated_at=clock_timestamp() where id=v_id;
      insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,compensates_id)
        select m.account_id,'opening_reversal',-m.delta_cents,m.posted_on,'Conta excluída',p_user_id,p_command_id,m.id from erp_finance.movement m
        where m.account_id=v_id and m.kind='opening' and m.delta_cents<>0 and not exists(select 1 from erp_finance.movement c where c.compensates_id=m.id);
    end if;
  end if;

  perform erp_finance.require_access(p_user_id,true);
  v_result:=jsonb_build_object('entity','financial_accounts','record',case when p_action='account_delete' then jsonb_build_object('id',v_id,'deleted',true) else erp_finance.account_view(v_id) end,
    'action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $function$;

-- ---------------------------------------------------------------- Estorno pela conciliação
-- The 010 reversal of one baixa, on the date of the baixa (the conta keeps its history; CNAB plans post their tarifa leg).
create function erp_finance.settlement_reverse(p_settlement uuid,p_user uuid,p_command uuid,p_note text)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare s erp_finance.settlement; t erp_finance.title; v_id uuid;
begin
  select * into s from erp_finance.settlement where id=p_settlement;
  if not found or s.kind<>'payment' then raise exception 'erp_finance_reversal_conflict' using errcode='40001'; end if;
  if exists(select 1 from erp_finance.settlement where reverses_id=s.id) then return null; end if;
  select * into t from erp_finance.title where id=s.title_id for update;
  insert into erp_finance.settlement(title_id,account_id,kind,reverses_id,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
    values(t.id,s.account_id,'reversal',s.id,s.posted_on,s.principal_cents,s.interest_cents,s.penalty_cents,s.discount_cents,s.fee_cents,s.net_cash_cents,left(p_note,500),p_user,p_command) returning id into v_id;
  update erp_finance.title set settled_cents=settled_cents-s.principal_cents,version=version+1,updated_at=clock_timestamp() where id=t.id;
  perform erp_finance.post_settlement_movements(v_id,case when t.kind='receivable' then -s.net_cash_cents else s.net_cash_cents end);
  update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=s.account_id;
  return v_id;
end $$;
-- The inverse transfer of Excluir transferência (136), on the dates of the original legs.
create function erp_finance.transfer_reverse(p_transfer uuid,p_user uuid,p_command uuid,p_note text)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare v_transfer erp_finance.transfer; v_from erp_finance.account; v_to erp_finance.account; v_reversal uuid:=gen_random_uuid(); ca jsonb; cb jsonb;
begin
  select * into v_transfer from erp_finance.transfer where id=p_transfer;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if exists(select 1 from erp_finance.transfer_deletion where transfer_id=v_transfer.id or reversal_id=v_transfer.id) then return null; end if;
  select * into v_from from erp_finance.account where id=v_transfer.to_account_id; select * into v_to from erp_finance.account where id=v_transfer.from_account_id;
  if v_from.deleted_at is not null or v_to.deleted_at is not null then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
  ca:=erp_finance.transfer_account(v_from.id); cb:=erp_finance.transfer_account(v_to.id);
  insert into erp_finance.transfer(id,command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot,in_posted_on,float_days)
    values(v_reversal,p_command,p_user,v_from.id,v_to.id,v_transfer.amount_cents,coalesce(v_transfer.in_posted_on,v_transfer.posted_on),v_transfer.note,
      jsonb_build_object('id',v_from.id,'name',v_from.name,'kind',v_from.kind,'version_before',v_from.version,'version_after',v_from.version+1,'balance_before_cents',ca->>'balance_cents','balance_after_cents',((ca->>'balance_cents')::numeric-v_transfer.amount_cents)::text,'opening_on',ca->'opening_on'),
      jsonb_build_object('id',v_to.id,'name',v_to.name,'kind',v_to.kind,'version_before',v_to.version,'version_after',v_to.version+1,'balance_before_cents',cb->>'balance_cents','balance_after_cents',((cb->>'balance_cents')::numeric+v_transfer.amount_cents)::text,'opening_on',cb->'opening_on'),
      case when v_transfer.in_posted_on is not null then v_transfer.posted_on end,0);
  insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id,category_id)
    select v_from.id,'transfer_out',-v_transfer.amount_cents,coalesce(v_transfer.in_posted_on,v_transfer.posted_on),v_transfer.note,p_user,p_command,v_reversal,(select category_id from erp_finance.movement where transfer_id=v_transfer.id and kind='transfer_in')
    union all select v_to.id,'transfer_in',v_transfer.amount_cents,v_transfer.posted_on,v_transfer.note,p_user,p_command,v_reversal,(select category_id from erp_finance.movement where transfer_id=v_transfer.id and kind='transfer_out');
  insert into erp_finance.transfer_deletion(transfer_id,reversal_id,actor,command_id,note) values(v_transfer.id,v_reversal,p_user,p_command,left(p_note,500));
  update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in (v_from.id,v_to.id);
  return v_reversal;
end $$;

CREATE OR REPLACE FUNCTION public.erp_finance_reconciliation_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_account erp_finance.account%rowtype; v_other erp_finance.account%rowtype; v_statement erp_finance.bank_statement%rowtype;
  v_line erp_finance.bank_statement_line%rowtype; v_item jsonb; v_new integer:=0; v_total integer:=0; v_from date; v_to date; v_entry erp_finance.cash_entry%rowtype; v_link erp_finance.reconciliation_link%rowtype;
  v_category uuid; v_note text; v_kind text; v_transfer uuid; v_movement uuid; v_title erp_finance.title%rowtype; v_bordero uuid; v_settlement uuid; v_principal bigint; v_sum numeric:=0;
  v_ids uuid[]; v_count integer; ca jsonb; cb jsonb; v_out uuid; v_in uuid; v_mov erp_finance.movement%rowtype;
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
    elsif p_action='line_unreconcile' and p_data->'reverse'='true'::jsonb then
      -- Estornar (172): the contas of the baixas linked first (UUID order), then every account of the movements linked (id order):
      -- the lock order of the baixa, the borderôs and the transfers. The line version below proves the links did not change.
      perform 1 from erp_finance.title where id in (select s.title_id from erp_finance.reconciliation_link l join erp_finance.movement m on m.id=l.movement_id
        join erp_finance.settlement s on s.id=m.settlement_id where l.line_id=v_line.id and l.undone_at is null) order by id for update;
      perform 1 from erp_finance.account where id=v_line.account_id or id in (select x.account_id from erp_finance.reconciliation_link l join erp_finance.movement m on m.id=l.movement_id
        join erp_finance.movement x on x.transfer_id=m.transfer_id where l.line_id=v_line.id and l.undone_at is null) order by id for update;
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
      -- Reverter conciliação: the links are undone (history kept); "Estornar" also undoes what was linked, as in Origin: the
      -- lançamentos de caixa are excluded, the baixas are estornadas (the 010 reversal, on the date of the baixa) and the
      -- transferências get the inverse transfer. One transfer per command: a line linked to two transfers is undone in Caixas e bancos.
      if coalesce((p_data->>'reverse')::boolean,false) and (select count(distinct m.transfer_id) from erp_finance.reconciliation_link l join erp_finance.movement m on m.id=l.movement_id
        where l.line_id=v_line.id and l.undone_at is null and m.transfer_id is not null)>1 then raise exception 'erp_finance_reconciliation_reverse_locked' using errcode='40001'; end if;
      update erp_finance.reconciliation_link set undone_at=clock_timestamp(),undone_by=p_user_id,undone_command=p_command_id where line_id=v_line.id and undone_at is null;
      if coalesce((p_data->>'reverse')::boolean,false) then
        for v_link in select * from erp_finance.reconciliation_link where line_id=v_line.id and undone_command=p_command_id and entry_id is not null loop
          select * into v_entry from erp_finance.cash_entry where id=v_link.entry_id for update;
          if v_entry.deleted_at is null then
            perform erp_finance.cash_compensate(v_entry.id,p_user_id,p_command_id);
            update erp_finance.cash_entry set deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note='Estornado ao reverter a conciliação',version=version+1,updated_at=clock_timestamp() where id=v_entry.id;
          end if;
        end loop;
        for v_link in select * from erp_finance.reconciliation_link where line_id=v_line.id and undone_command=p_command_id and movement_id is not null order by movement_id loop
          select * into v_mov from erp_finance.movement where id=v_link.movement_id;
          if v_mov.settlement_id is not null then perform erp_finance.settlement_reverse(v_mov.settlement_id,p_user_id,p_command_id,'Estornado ao reverter a conciliação');
          elsif v_mov.transfer_id is not null then perform erp_finance.transfer_reverse(v_mov.transfer_id,p_user_id,p_command_id,'Estornado ao reverter a conciliação'); end if;
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
end $function$;

-- ---------------------------------------------------------------- Parcelada
alter table erp_finance.recurrence add column installments integer check(installments between 2 and 120);
alter table erp_finance.recurrence drop constraint recurrence_frequency_check;
alter table erp_finance.recurrence add constraint recurrence_frequency_check check(frequency in ('weekly','biweekly','monthly','bimonthly','quarterly','semiannual','annual','installments'));
alter table erp_finance.recurrence add constraint recurrence_installments_rule check((frequency='installments')=(installments is not null) and (installments is null or end_on is null));
-- Forma de pagamento of the conta that starts the recurrence (Cadastros > Formas de pagamento, 127): kept for the next
-- contas (175 copies it to each conta generated).
alter table erp_finance.recurrence add column payment_method_id uuid references erp_catalog.payment_method(id);

CREATE OR REPLACE FUNCTION erp_finance.recurrence_next(p_frequency text, p_due_day integer, p_second_day integer, p_from date)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
  v_step:=case p_frequency when 'monthly' then 1 when 'installments' then 1 when 'bimonthly' then 2 when 'quarterly' then 3 when 'semiannual' then 6 else 12 end;
  v_month:=(date_trunc('month',p_from)+make_interval(months=>v_step))::date;
  return v_month+(least(p_due_day,extract(day from (v_month+interval '1 month'-interval '1 day'))::integer)-1);
end $function$;

CREATE OR REPLACE FUNCTION erp_finance.recurrence_title(p_rec erp_finance.recurrence, p_nominal date, p_user uuid, p_command uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare v_due date:=case when p_rec.business_days then erp_finance.next_business_day(p_nominal) else p_nominal end; v_issued date; v_id uuid;
  -- Parcelada (172): the contas of the recurrence form one group, parcela n of N (the recurrence row is locked by the caller).
  v_number integer:=(select count(*)+1 from erp_finance.title t where t.recurrence_id=p_rec.id);
begin
  v_issued:=v_due-p_rec.lead_days;
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
      competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on,recurrence_id,recurrence_on)
    values(case when p_rec.installments is null then gen_random_uuid() else p_rec.id end,case when p_rec.installments is null then 1 else v_number end,coalesce(p_rec.installments,1),p_rec.kind,p_rec.contact_id,p_rec.category_id,p_rec.description,p_rec.source_reference,v_issued,v_due,p_rec.amount_cents,
      v_issued,p_rec.account_id,p_rec.bank_number,p_rec.interest_month_bp,p_rec.penalty_bp,v_due,p_rec.id,p_nominal) returning id into v_id;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION erp_finance.recurrence_view(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select jsonb_build_object('id',r.id,'kind',r.kind,'contact_id',r.contact_id,'contact_name',c.name,'category_id',r.category_id,'category_name',g.name,'account_id',r.account_id,
    'description',r.description,'amount_cents',r.amount_cents::text,'frequency',r.frequency,'due_day',r.due_day,'second_day',r.second_day,'weekday',r.weekday,
    'business_days',r.business_days,'end_on',r.end_on,'next_on',case when r.active and (r.end_on is null or r.next_on<=r.end_on) and (r.installments is null or r.generated<r.installments) then r.next_on end,'installments',r.installments,'generated',r.generated,'active',r.active,
    'open_titles',(select count(*) from erp_finance.title t where t.recurrence_id=r.id and not t.cancelled and t.settled_cents<t.amount_cents),'version',r.version,'created_at',r.created_at)
  from erp_finance.recurrence r join erp_catalog.record c on c.id=r.contact_id left join erp_finance.category g on g.id=r.category_id where r.id=p_id;
$function$;

CREATE OR REPLACE FUNCTION public.erp_finance_recurrence_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_rec erp_finance.recurrence%rowtype; v_result jsonb; v_before jsonb; v_kind text; v_frequency text; v_due date; v_issued date; v_competence date;
  v_title uuid; v_end date; v_due_day integer; v_second integer; v_weekday integer; v_changes jsonb; v_scope text; v_from date; v_count integer:=0; v_row erp_finance.title%rowtype; v_value boolean;
  v_method uuid;
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
      'interest_month_bp','penalty_bp','frequency','due_day','second_day','weekday','end_on','business_days','installments','payment_method_id']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true); if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    -- Forma de pagamento: active, not excluded and applicable to recebimentos (receber) or pagamentos (pagar), as the conta (175).
    v_method:=erp_finance.uuid_value(p_data->'payment_method_id',false);
    if v_method is not null and not exists(select 1 from erp_catalog.payment_method f where f.id=v_method and f.active and f.deleted_at is null
      and f.applicable in ('ambos',case when v_kind='receivable' then 'recebimentos' else 'pagamentos' end)) then
      raise exception 'erp_finance_invalid_payment_method' using errcode='22023'; end if;
    v_frequency:=erp_finance.txt(p_data,'frequency',20,true);
    if v_frequency not in ('weekly','biweekly','monthly','bimonthly','quarterly','semiannual','annual','installments') then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
    -- Parcelada (172): "Parcelas" (2 a 120) and no Data limite; it generates until the last parcela.
    if (v_frequency='installments')<>(p_data?'installments' and p_data->'installments'<>'null'::jsonb) or (v_frequency='installments' and (jsonb_typeof(p_data->'installments')<>'number'
      or (p_data->>'installments')!~'^[0-9]{1,3}$' or (p_data->>'installments')::integer not between 2 and 120 or (p_data?'end_on' and p_data->'end_on'<>'null'::jsonb))) then
      raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
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
        business_days,end_on,lead_days,installments,payment_method_id,actor,command_id)
      values(v_kind,erp_finance.uuid_value(p_data->'contact_id'),
        erp_finance.active_category(erp_finance.uuid_value(p_data->'category_id',false),v_kind),erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false)),
        erp_finance.txt(p_data,'description',240,true),erp_finance.txt(p_data,'source_reference',200),erp_finance.bank_number(p_data),erp_finance.cents(p_data->'amount_cents',false),
        coalesce(erp_finance.bp(p_data,'interest_month_bp'),0),coalesce(erp_finance.bp(p_data,'penalty_bp'),0),v_frequency,
        case when v_frequency<>'weekly' then v_due_day end,case when v_frequency='biweekly' then v_second end,case when v_frequency='weekly' then v_weekday end,
        coalesce((p_data->>'business_days')::boolean,false),v_end,v_due-v_issued,case when v_frequency='installments' then (p_data->>'installments')::integer end,v_method,p_user_id,p_command_id) returning * into v_rec;
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
      if not v_rec.active or v_rec.next_on is null or (v_rec.end_on is not null and v_rec.next_on>v_rec.end_on) or (v_rec.installments is not null and v_rec.generated>=v_rec.installments) then
        raise exception 'erp_finance_recurrence_finished' using errcode='40001'; end if;
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
end $function$;

-- ---------------------------------------------------------------- Ficha financeira paginada
-- Same lines as 136, 100 per page in the order of the ficha, with the Débitos, Créditos and Saldo of the whole period.
create function public.erp_finance_contact_ledger_page(p_user_id uuid,p_contact uuid,p_scope text default 'all',p_from date default null,p_to date default null,p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_debit numeric; v_credit numeric; v_total bigint;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_contact is null or p_scope is null or p_scope not in ('all','receivable','payable') or p_from is null or p_to is null or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_to-p_from>3660
    or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if not exists(select 1 from erp_catalog.contact where record_id=p_contact) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  with rows as materialized (
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
  select (select count(*) from rows),
    (select coalesce(jsonb_agg(jsonb_build_object('day',on_day,'line_kind',line_kind,'ref_id',ref_id,'kind',kind,'note',note,'due_on',due_on,'side',side,'amount_cents',amount::text,
      'situation',situation,'origin',origin,'version',version) order by on_day,at_ts,ref_id),'[]'::jsonb) from (select * from rows order by on_day,at_ts,ref_id limit p_limit offset (p_page-1)*p_limit) x),
    (select coalesce(sum(amount) filter (where side='debit' and situation is distinct from 'cancelled'),0) from rows),
    (select coalesce(sum(amount) filter (where side='credit' and situation is distinct from 'cancelled'),0) from rows)
  into v_total,v_items,v_debit,v_credit;
  return jsonb_build_object('entity','contact_ledger','contact_id',p_contact,'contact_name',(select name from erp_catalog.record where id=p_contact),'scope',p_scope,'from',p_from,'to',p_to,
    'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,
    'totals',jsonb_build_object('debit_cents',v_debit::text,'credit_cents',v_credit::text,'balance_cents',(v_credit-v_debit)::text),'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Contas em aberto do contato
-- "Permite a visualização das contas a receber em aberto nos pedidos/notas fiscais" (Vendas) and "... a pagar ..." (Suprimentos):
-- the financeiro always reads them; the other profiles of the pedidos only while the preference is on. Up to 50 contas, by
-- vencimento, with the totals of all; "Contato acessível somente ao vendedor vinculado" still applies.
create function public.erp_finance_contact_open_titles(p_user_id uuid,p_contact uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_scope uuid; v_result jsonb;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if p_kind is null or p_kind not in ('receivable','payable') or p_contact is null then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if v_role is null or not (v_role in ('admin','financeiro','consulta')
    or (p_kind='receivable' and v_role in ('vendas','estoque','fiscal') and coalesce(erp_preferences.get('vendas.ver_contas_receber'),'false'::jsonb)='true'::jsonb)
    or (p_kind='payable' and v_role in ('estoque','fiscal') and coalesce(erp_preferences.get('compras.ver_contas_pagar'),'false'::jsonb)='true'::jsonb)) then
    raise exception 'erp_finance_access_denied' using errcode='42501'; end if;
  if not exists(select 1 from erp_catalog.contact where record_id=p_contact) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  v_scope:=erp_catalog.contact_scope(p_user_id);
  if v_scope is not null and not exists(select 1 from erp_catalog.contact_profile where record_id=p_contact and seller_id=v_scope) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  with open as materialized (
    select t.* from erp_finance.title t where t.contact_id=p_contact and t.kind=p_kind and not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents
  )
  select jsonb_build_object('entity','contact_open_titles','contact_id',p_contact,'kind',p_kind,'total',(select count(*) from open),
    'balance_cents',(select coalesce(sum(amount_cents-settled_cents),0)::text from open),'overdue',(select count(*) from open where due_on<v_today),
    'overdue_cents',(select coalesce(sum(amount_cents-settled_cents),0)::text from open where due_on<v_today),
    'items',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'description',case when x.installments>1 then format('%s %s/%s',x.description,x.installment,x.installments) else x.description end,
      'due_on',x.due_on,'amount_cents',x.amount_cents::text,'balance_cents',(x.amount_cents-x.settled_cents)::text,'overdue',x.due_on<v_today) order by x.due_on,x.id),'[]'::jsonb)
      from (select * from open order by due_on,id limit 50) x),'data_mode','erp_native') into v_result;
  return v_result;
end $$;

revoke all on function erp_finance.account_view(uuid),erp_finance.settlement_reverse(uuid,uuid,uuid,text),erp_finance.transfer_reverse(uuid,uuid,uuid,text),
  erp_finance.recurrence_next(text,integer,integer,date),erp_finance.recurrence_title(erp_finance.recurrence,date,uuid,uuid),erp_finance.recurrence_view(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_account_execute(uuid,uuid,text,jsonb)','erp_finance_reconciliation_execute(uuid,uuid,text,jsonb)','erp_finance_recurrence_execute(uuid,uuid,text,jsonb)',
    'erp_finance_contact_ledger_page(uuid,uuid,text,date,date,integer,integer)','erp_finance_contact_open_titles(uuid,uuid,text)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
