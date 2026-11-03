-- Gaveta de contas a receber e a pagar no padrão Origin: competência, conta financeira (portador), nº no banco,
-- juros mensal e multa (%), vencimento original e exclusão lógica. As ações novas ficam em
-- public.erp_finance_title_execute; erp_finance_execute (010/019/058) continua igual para os demais chamadores.
-- Nenhum movimento de caixa, banco, boleto ou remessa é criado aqui. Centavos continuam inteiros exatos e
-- percentuais são centésimos de ponto percentual (1,00% = 100), sempre inteiros.
begin;

alter table erp_finance.title
  add column competence_on date,
  add column account_id uuid references erp_finance.account(id),
  add column bank_number text,
  add column interest_month_bp integer not null default 0,
  add column penalty_bp integer not null default 0,
  add column original_due_on date,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users(id),
  add column deleted_note text;

-- Títulos existentes: competência = emissão; vencimento original = o da criação registrada na auditoria, ou o atual.
update erp_finance.title t set competence_on=t.issued_on,
  original_due_on=coalesce((select (item->>'due_on')::date from erp_finance.audit a
    cross join lateral jsonb_array_elements(case when jsonb_typeof(a.after_data->'items')='array' then a.after_data->'items' else '[]'::jsonb end) item
    where a.action='title_create_group' and item->>'id'=t.id::text order by a.id limit 1),t.due_on);

-- Escritores antigos (010, 017, 039) não conhecem os campos: a competência nasce igual à emissão e o
-- vencimento original igual ao primeiro vencimento.
create function erp_finance.title_defaults()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  new.competence_on:=coalesce(new.competence_on,new.issued_on);
  new.original_due_on:=coalesce(new.original_due_on,new.due_on);
  return new;
end $$;
create trigger title_defaults before insert on erp_finance.title for each row execute function erp_finance.title_defaults();

alter table erp_finance.title
  alter column competence_on set not null,
  alter column original_due_on set not null,
  add constraint title_competence_range check(competence_on between date '1900-01-01' and date '2100-12-31'),
  add constraint title_bank_number_check check(bank_number is null or (length(bank_number) between 1 and 60 and bank_number=btrim(bank_number) and bank_number!~'[[:cntrl:]]')),
  add constraint title_interest_month_bp_check check(interest_month_bp between 0 and 10000),
  add constraint title_penalty_bp_check check(penalty_bp between 0 and 10000),
  add constraint title_deleted_check check((deleted_at is null and deleted_by is null and deleted_note is null)
    or (deleted_at is not null and deleted_by is not null and cancelled and (deleted_note is null or length(deleted_note) between 1 and 500)));

-- O vencimento original não muda depois da criação, e uma conta excluída não volta nem muda.
create function erp_finance.title_history_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.deleted_at is not null then raise exception 'erp_finance_deleted_title' using errcode='40001'; end if;
  if new.original_due_on is distinct from old.original_due_on then raise exception 'erp_finance_original_due_locked' using errcode='40001'; end if;
  return new;
end $$;
create trigger title_history_guard before update on erp_finance.title for each row execute function erp_finance.title_history_guard();

create index erp_finance_title_kind_account on erp_finance.title(kind,account_id,due_on,id);

create function erp_finance.bp(p_data jsonb,p_key text)
returns integer language plpgsql immutable set search_path=pg_catalog as $$
declare v integer;
begin
  if not p_data?p_key then return null; end if;
  if jsonb_typeof(p_data->p_key) is distinct from 'number' or (p_data->>p_key)!~'^[0-9]{1,5}$' then raise exception 'erp_finance_invalid_percent' using errcode='22023'; end if;
  v:=(p_data->>p_key)::integer;
  if v>10000 then raise exception 'erp_finance_invalid_percent' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.bank_number(p_data jsonb)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
  v:=erp_finance.txt(p_data,'bank_number',60);
  if v~'[[:cntrl:]]' then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  return v;
end $$;
create function erp_finance.active_account(p_id uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
begin
  if p_id is null then return null; end if;
  perform 1 from erp_finance.account where id=p_id and active for share;
  if not found then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
  return p_id;
end $$;
create function erp_finance.active_category(p_id uuid,p_kind text)
returns uuid language plpgsql set search_path=pg_catalog as $$
begin
  if p_id is null then return null; end if;
  perform 1 from erp_finance.category where id=p_id and active and kind in (p_kind,'both') for share;
  if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
  return p_id;
end $$;

-- Cobrança vinculada (boleto do Brufap): nosso número, remessa e se o arquivo já foi gerado.
create function erp_finance.title_billing(p_title uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('our_number',b.our_number,'document_number',b.document_number,'remittance_id',r.id,
   'remittance_sequence',r.sequence,'remittance_state',r.state,'file_generated',r.state='ready')
 from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.title_id=p_title;
$$;

-- Gravação da gaveta: incluir (Única ou Parcelada), editar e excluir. Mesmo comando idempotente, auditoria e
-- verificação de papel da 010, com a versão esperada do título.
create function public.erp_finance_title_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_title erp_finance.title%rowtype; v_result jsonb; v_before jsonb;
  v_id uuid; v_version integer; v_kind text; v_contact uuid; v_category uuid; v_account uuid; v_issued date; v_competence date; v_due date;
  v_amount bigint; v_part bigint; v_total numeric:=0; v_count integer; v_index integer:=0; v_group uuid; v_item jsonb; v_items jsonb:='[]'::jsonb;
  v_description text; v_reference text; v_bank text; v_interest integer; v_penalty integer; v_note text;
  v_linked boolean; v_imported boolean; v_billed boolean; v_settled boolean;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('title_create','title_edit','title_delete') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return erp_finance.project_result_link(v_command.result)||jsonb_build_object('replayed',true);
  end if;

  if p_action='title_create' then
    perform erp_finance.keys(p_data,array['kind','contact_id','category_id','account_id','description','source_reference','bank_number',
      'issued_on','competence_on','interest_month_bp','penalty_bp','total_cents','installments']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_contact:=erp_finance.uuid_value(p_data->'contact_id');
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then
      raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    v_category:=erp_finance.active_category(erp_finance.uuid_value(p_data->'category_id',false),v_kind);
    v_account:=erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false));
    v_issued:=erp_finance.day(p_data->'issued_on'); v_competence:=erp_finance.day(p_data->'competence_on');
    v_amount:=erp_finance.cents(p_data->'total_cents',false);
    v_description:=erp_finance.txt(p_data,'description',240,true); v_reference:=erp_finance.txt(p_data,'source_reference',200);
    v_bank:=erp_finance.bank_number(p_data);
    v_interest:=coalesce(erp_finance.bp(p_data,'interest_month_bp'),0); v_penalty:=coalesce(erp_finance.bp(p_data,'penalty_bp'),0);
    if jsonb_typeof(p_data->'installments') is distinct from 'array' or jsonb_array_length(p_data->'installments') not between 1 and 120 then
      raise exception 'erp_finance_invalid_installments' using errcode='22023'; end if;
    v_count:=jsonb_array_length(p_data->'installments'); v_group:=gen_random_uuid();
    for v_item in select value from jsonb_array_elements(p_data->'installments') loop
      perform erp_finance.keys(v_item,array['amount_cents','due_on']);
      v_part:=erp_finance.cents(v_item->'amount_cents',false); v_due:=erp_finance.day(v_item->'due_on');
      if v_due<v_issued then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_index:=v_index+1; v_total:=v_total+v_part;
      insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
          competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on)
        values(v_group,v_index,v_count,v_kind,v_contact,v_category,v_description,v_reference,v_issued,v_due,v_part,
          v_competence,v_account,v_bank,v_interest,v_penalty,v_due) returning id into v_id;
      v_items:=v_items||jsonb_build_array(erp_finance.dto('titles',v_id));
    end loop;
    if v_total<>v_amount then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
    v_result:=jsonb_build_object('entity','titles','group_id',v_group,'items',v_items);

  else
    if p_action='title_edit' then
      perform erp_finance.keys(p_data,array['id','expected_version','contact_id','category_id','account_id','description','source_reference','bank_number',
        'issued_on','competence_on','due_on','amount_cents','interest_month_bp','penalty_bp']);
    else perform erp_finance.keys(p_data,array['id','expected_version','note']); end if;
    v_id:=erp_finance.uuid_value(p_data->'id'); v_version:=erp_finance.expected(p_data->'expected_version');
    select * into v_title from erp_finance.title where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_title.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    if v_title.deleted_at is not null then raise exception 'erp_finance_deleted_title' using errcode='40001'; end if;
    v_linked:=exists(select 1 from erp_finance.document_title where title_id=v_id);
    v_imported:=exists(select 1 from erp_finance.origin_import_origin where title_id=v_id);
    v_billed:=exists(select 1 from erp_cnab.billing_title where title_id=v_id);
    v_settled:=exists(select 1 from erp_finance.settlement where title_id=v_id);
    v_before:=erp_finance.dto('titles',v_id);

    if p_action='title_edit' then
      if v_title.cancelled then raise exception 'erp_finance_cancelled_title' using errcode='40001'; end if;
      v_contact:=case when p_data?'contact_id' then erp_finance.uuid_value(p_data->'contact_id') else v_title.contact_id end;
      v_issued:=case when p_data?'issued_on' then erp_finance.day(p_data->'issued_on') else v_title.issued_on end;
      v_amount:=case when p_data?'amount_cents' then erp_finance.cents(p_data->'amount_cents',false) else v_title.amount_cents end;
      v_reference:=case when p_data?'source_reference' then erp_finance.txt(p_data,'source_reference',200) else v_title.source_reference end;
      v_bank:=case when p_data?'bank_number' then erp_finance.bank_number(p_data) else v_title.bank_number end;
      -- Contato, emissão e valor ficam com o documento de origem, com a importação do Origin, com o boleto e com as baixas.
      if v_contact<>v_title.contact_id then
        if v_linked or v_imported or v_billed or v_settled then raise exception 'erp_finance_contact_locked' using errcode='40001'; end if;
        if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then
          raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
      end if;
      if v_issued<>v_title.issued_on and (v_linked or v_imported or v_settled) then raise exception 'erp_finance_issue_locked' using errcode='40001'; end if;
      if v_amount<>v_title.amount_cents and (v_linked or v_imported or v_billed or v_settled) then raise exception 'erp_finance_principal_locked' using errcode='40001'; end if;
      if v_reference is distinct from v_title.source_reference and (v_linked or v_imported) then raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
      if v_bank is distinct from v_title.bank_number and v_billed then raise exception 'erp_finance_billed_locked' using errcode='40001'; end if;
      v_due:=case when p_data?'due_on' then erp_finance.day(p_data->'due_on') else v_title.due_on end;
      if v_due<v_issued then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_category:=case when p_data?'category_id' then erp_finance.uuid_value(p_data->'category_id',false) else v_title.category_id end;
      if v_category is distinct from v_title.category_id then perform erp_finance.active_category(v_category,v_title.kind); end if;
      v_account:=case when p_data?'account_id' then erp_finance.uuid_value(p_data->'account_id',false) else v_title.account_id end;
      if v_account is distinct from v_title.account_id then perform erp_finance.active_account(v_account); end if;
      update erp_finance.title set contact_id=v_contact,issued_on=v_issued,amount_cents=v_amount,source_reference=v_reference,bank_number=v_bank,
        due_on=v_due,category_id=v_category,account_id=v_account,
        description=case when p_data?'description' then erp_finance.txt(p_data,'description',240,true) else description end,
        competence_on=case when p_data?'competence_on' then erp_finance.day(p_data->'competence_on') else competence_on end,
        interest_month_bp=coalesce(erp_finance.bp(p_data,'interest_month_bp'),interest_month_bp),
        penalty_bp=coalesce(erp_finance.bp(p_data,'penalty_bp'),penalty_bp),
        version=version+1,updated_at=clock_timestamp() where id=v_id;
    else
      -- Exclusão lógica: a conta some das listagens e dos totais, sem apagar o histórico. Só sem baixa ativa,
      -- fora de remessa e sem documento de origem ou importação do Origin.
      v_note:=erp_finance.txt(p_data,'note',500);
      if v_title.settled_cents<>0 then raise exception 'erp_finance_active_payments' using errcode='40001'; end if;
      if v_billed then raise exception 'erp_finance_billed_locked' using errcode='40001'; end if;
      if v_linked or v_imported then raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
      update erp_finance.title set cancelled=true,deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note=v_note,
        version=version+1,updated_at=clock_timestamp() where id=v_id;
    end if;
    v_result:=jsonb_build_object('entity','titles','record',erp_finance.dto('titles',v_id),'note',v_note);
  end if;

  -- O papel pode ter mudado enquanto um bloqueio esperava; a falha desfaz tudo antes do recibo do comando.
  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

-- Leitura da gaveta: título, origem, conta financeira, cobrança vinculada e o registro de criação (somente consulta).
create function public.erp_finance_title_detail(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb; v_account jsonb; v_original jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_id is null then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  v:=erp_finance.dto('titles',p_id);
  if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select jsonb_build_object('id',a.id,'name',a.name,'active',a.active) into v_account
    from erp_finance.account a join erp_finance.title t on t.account_id=a.id where t.id=p_id;
  select jsonb_build_object('contact_name',item->>'contact_name','due_on',item->>'due_on','amount_cents',item->>'amount_cents',
      'description',item->>'description','created_at',a.created_at) into v_original
    from erp_finance.audit a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.after_data->'items')='array' then a.after_data->'items' else '[]'::jsonb end) item
    where a.action in ('title_create_group','title_create') and item->>'id'=p_id::text order by a.id limit 1;
  return jsonb_build_object('entity','titles','record',v,'origin',erp_finance.title_origin(p_id),'account',v_account,
    'billing',erp_finance.title_billing(p_id),'imported',exists(select 1 from erp_finance.origin_import_origin where title_id=p_id),
    'settled_before',exists(select 1 from erp_finance.settlement where title_id=p_id),'original',v_original,'data_mode','erp_native');
end $$;

revoke all on function erp_finance.title_defaults(),erp_finance.title_history_guard(),erp_finance.bp(jsonb,text),erp_finance.bank_number(jsonb),
  erp_finance.active_account(uuid),erp_finance.active_category(uuid,text),erp_finance.title_billing(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_title_execute(uuid,uuid,text,jsonb),public.erp_finance_title_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_finance_title_execute(uuid,uuid,text,jsonb),public.erp_finance_title_detail(uuid,uuid) to service_role;
commit;
