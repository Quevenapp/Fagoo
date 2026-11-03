-- Forma de pagamento nas contas a receber e a pagar (onda C, lane financeiro): a conta guarda a forma de pagamento do
-- cadastro (Cadastros > Formas de pagamento, migração 127, só leitura). A gaveta escolhe a forma (as aplicáveis ao tipo da
-- conta) e traz dela os juros, a multa e a conta financeira; a listagem tem a coluna Forma de pagamento e o Líquido
-- desconta a taxa da forma enquanto não há tarifa registrada; a Ficha financeira mostra a forma; a baixa sugere a taxa;
-- o Buscar da conciliação mostra a forma e pesquisa por forma, vencimento e valor; as contas geradas por uma recorrência (e
-- pela Parcelada) levam a forma escolhida na inclusão.
-- Nada muda nas contas existentes (sem forma) nem nas regras de baixa, boleto ou documento.
begin;

alter table erp_finance.title add column payment_method_id uuid references erp_catalog.payment_method(id);
create index erp_finance_title_payment_method on erp_finance.title(payment_method_id) where payment_method_id is not null;

-- Taxa da forma sobre um valor: Alíquota (%), Fixa (R$) ou Alíquota + Fixa, em centavos (meio centavo para cima), nunca acima do valor.
create function erp_finance.payment_method_fee(p_method uuid,p_amount bigint)
returns bigint language sql stable set search_path=pg_catalog as $$
  select least(p_amount,(case when f.fee_type in ('aliquota','aliquota_fixa') then round(p_amount*coalesce(f.fee_rate,0)/100) else 0 end
    +case when f.fee_type in ('fixa','aliquota_fixa') then round(coalesce(f.fee_fixed,0)*100) else 0 end)::bigint)
  from erp_catalog.payment_method f where f.id=p_method;
$$;
-- A forma of the conta: active, not excluded and applicable to recebimentos (receber) or pagamentos (pagar); the current one stays.
create function erp_finance.payment_method_for(p_method uuid,p_kind text,p_current uuid)
returns uuid language plpgsql stable set search_path=pg_catalog as $$
begin
  if p_method is null or p_method is not distinct from p_current then return p_method; end if;
  if not exists(select 1 from erp_catalog.payment_method f where f.id=p_method and f.active and f.deleted_at is null
    and f.applicable in ('ambos',case when p_kind='receivable' then 'recebimentos' else 'pagamentos' end)) then
    raise exception 'erp_finance_invalid_payment_method' using errcode='22023'; end if;
  return p_method;
end $$;
-- Formas offered by the gaveta and the baixa: the finance profiles read them as the cadastro does (127).
create function public.erp_finance_payment_methods(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  return jsonb_build_object('entity','payment_methods','kind',p_kind,'items',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'description',f.description,'payment_type',f.payment_type,
    'account_id',f.account_id,'interest_rate',f.interest_rate::text,'fine_rate',f.fine_rate::text,'fee_type',f.fee_type,'fee_rate',f.fee_rate::text,'fee_fixed',f.fee_fixed::text,'is_default',f.is_default)
    order by f.is_default desc,lower(f.description),f.id),'[]'::jsonb) from (select * from erp_catalog.payment_method f where f.active and f.deleted_at is null
      and f.applicable in ('ambos',case when p_kind='receivable' then 'recebimentos' else 'pagamentos' end) order by f.is_default desc,lower(f.description),f.id limit 200) f),'data_mode','erp_native');
end $$;

CREATE OR REPLACE FUNCTION erp_finance.dto(p_entity text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
      -- 175: Forma de pagamento (name and the taxa it would take from this valor) and the Faturamento agrupado of the conta.
      'payment_method_name',(select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id),
      'payment_fee_cents',case when t.payment_method_id is null then null else erp_finance.payment_method_fee(t.payment_method_id,t.amount_cents)::text end,
      'grouped_billing_id',(select g.billing_id from erp_finance.grouped_billing_title g where g.title_id=t.id),
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
end $function$;

CREATE OR REPLACE FUNCTION public.erp_finance_title_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_method uuid;
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
      'issued_on','competence_on','interest_month_bp','penalty_bp','total_cents','installments','payment_method_id']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_contact:=erp_finance.uuid_value(p_data->'contact_id');
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then
      raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    v_category:=erp_finance.active_category(erp_finance.uuid_value(p_data->'category_id',false),v_kind);
    v_account:=erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false));
    v_method:=erp_finance.payment_method_for(erp_finance.uuid_value(p_data->'payment_method_id',false),v_kind,null);
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
          competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on,payment_method_id)
        values(v_group,v_index,v_count,v_kind,v_contact,v_category,v_description,v_reference,v_issued,v_due,v_part,
          v_competence,v_account,v_bank,v_interest,v_penalty,v_due,v_method) returning id into v_id;
      v_items:=v_items||jsonb_build_array(erp_finance.dto('titles',v_id));
    end loop;
    if v_total<>v_amount then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
    v_result:=jsonb_build_object('entity','titles','group_id',v_group,'items',v_items);

  else
    if p_action='title_edit' then
      perform erp_finance.keys(p_data,array['id','expected_version','contact_id','category_id','account_id','description','source_reference','bank_number',
        'issued_on','competence_on','due_on','amount_cents','interest_month_bp','penalty_bp','payment_method_id']);
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
      v_method:=case when p_data?'payment_method_id' then erp_finance.payment_method_for(erp_finance.uuid_value(p_data->'payment_method_id',false),v_title.kind,v_title.payment_method_id) else v_title.payment_method_id end;
      update erp_finance.title set contact_id=v_contact,issued_on=v_issued,amount_cents=v_amount,source_reference=v_reference,bank_number=v_bank,
        due_on=v_due,category_id=v_category,account_id=v_account,payment_method_id=v_method,
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
end $function$;

-- The contas of a recurrence (and of a Parcelada, 172) keep the forma de pagamento chosen when the recurrence was included.
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
      competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on,recurrence_id,recurrence_on,payment_method_id)
    values(case when p_rec.installments is null then gen_random_uuid() else p_rec.id end,case when p_rec.installments is null then 1 else v_number end,coalesce(p_rec.installments,1),p_rec.kind,p_rec.contact_id,p_rec.category_id,p_rec.description,p_rec.source_reference,v_issued,v_due,p_rec.amount_cents,
      v_issued,p_rec.account_id,p_rec.bank_number,p_rec.interest_month_bp,p_rec.penalty_bp,v_due,p_rec.id,p_nominal,p_rec.payment_method_id) returning id into v_id;
  return v_id;
end $function$;

create or replace function public.erp_finance_contact_ledger_page(p_user_id uuid,p_contact uuid,p_scope text default 'all',p_from date default null,p_to date default null,p_page integer default 1,p_limit integer default 100)
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
      null::integer version,(select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id) as method
    from erp_finance.title t where t.contact_id=p_contact and t.deleted_at is null and (p_scope='all' or t.kind=p_scope) and t.issued_on between p_from and p_to
    union all
    select s.posted_on,s.created_at,case when s.kind='payment' then 'payment' else 'reversal' end,s.id,t.kind,
      coalesce(s.note,t.description),t.due_on,
      case when (t.kind='receivable')=(s.kind='payment') then 'credit' else 'debit' end,s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents,null,null,null,
      (select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id)
    from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id where t.contact_id=p_contact and (p_scope='all' or t.kind=p_scope) and s.posted_on between p_from and p_to
    union all
    select e.posted_on,e.created_at,'entry',e.id,case when e.kind='in' then 'receivable' else 'payable' end,e.note,null,case when e.kind='in' then 'credit' else 'debit' end,e.amount_cents,null,null,e.version,null::text
    from erp_finance.cash_entry e where e.contact_id=p_contact and e.deleted_at is null and (p_scope='all' or (p_scope='receivable' and e.kind='in') or (p_scope='payable' and e.kind='out')) and e.posted_on between p_from and p_to
  )
  select (select count(*) from rows),
    (select coalesce(jsonb_agg(jsonb_build_object('day',on_day,'line_kind',line_kind,'ref_id',ref_id,'kind',kind,'note',note,'due_on',due_on,'side',side,'amount_cents',amount::text,
      'situation',situation,'origin',origin,'version',version,'payment_method',method) order by on_day,at_ts,ref_id),'[]'::jsonb) from (select * from rows order by on_day,at_ts,ref_id limit p_limit offset (p_page-1)*p_limit) x),
    (select coalesce(sum(amount) filter (where side='debit' and situation is distinct from 'cancelled'),0) from rows),
    (select coalesce(sum(amount) filter (where side='credit' and situation is distinct from 'cancelled'),0) from rows)
  into v_total,v_items,v_debit,v_credit;
  return jsonb_build_object('entity','contact_ledger','contact_id',p_contact,'contact_name',(select name from erp_catalog.record where id=p_contact),'scope',p_scope,'from',p_from,'to',p_to,
    'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,
    'totals',jsonb_build_object('debit_cents',v_debit::text,'credit_cents',v_credit::text,'balance_cents',(v_credit-v_debit)::text),'data_mode','erp_native');
end $$;

create or replace function public.erp_finance_reconciliation_candidates(p_user_id uuid,p_account uuid,p_from date,p_to date,p_query text default null,p_amount_cents bigint default null)
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
        and (v_query is null or strpos(lower(concat_ws(' ',l.note,(select name from erp_catalog.record where id=l.contact_id),to_char(l.posted_on,'DD/MM/YYYY'),
          replace(to_char(abs(l.amount_cents)/100.0,'FM999999999999990.00'),'.',','))),v_query)>0)
      order by l.posted_on,l.line_id limit 100) x),
    'titles',(select coalesce(jsonb_agg(c order by c->>'due_on',c->>'id'),'[]'::jsonb) from (
      select jsonb_build_object('id',t.id,'kind',t.kind,'version',t.version,'contact_name',r.name,'description',t.description,'due_on',t.due_on,'balance_cents',(t.amount_cents-t.settled_cents)::text,
        'installment',t.installment,'installments',t.installments,'payment_method_name',(select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id)) c
      from erp_finance.title t join erp_catalog.record r on r.id=t.contact_id
      where not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents and t.due_on between p_from and p_to
        and (p_amount_cents is null or t.amount_cents-t.settled_cents=p_amount_cents)
        and (v_query is null or strpos(lower(concat_ws(' ',r.name,t.description,t.source_reference,(select f.description from erp_catalog.payment_method f where f.id=t.payment_method_id),
          to_char(t.due_on,'DD/MM/YYYY'),replace(to_char((t.amount_cents-t.settled_cents)/100.0,'FM999999999999990.00'),'.',','))),v_query)>0)
      order by t.due_on,t.id limit 100) x),'data_mode','erp_native');
end $$;

revoke all on function erp_finance.payment_method_fee(uuid,bigint),erp_finance.payment_method_for(uuid,text,uuid),erp_finance.dto(text,uuid),
  erp_finance.recurrence_title(erp_finance.recurrence,date,uuid,uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_payment_methods(uuid,text)','erp_finance_title_execute(uuid,uuid,text,jsonb)','erp_finance_contact_ledger_page(uuid,uuid,text,date,date,integer,integer)',
    'erp_finance_reconciliation_candidates(uuid,uuid,date,date,text,bigint)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
