-- 210: contas a receber e a pagar no padrão Origin, onda D (lane financeiro).
-- * Vendedor da conta a receber (Cadastros > Vendedores, 126, só leitura): a gaveta escolhe o vendedor; a conta lançada por um
--   pedido de venda ou OS fica com o vendedor do documento (o vendedor nativo do pedido, 164, ou o vendedor Origin do pedido
--   espelhado, como em Comissões 171) enquanto a conta não tiver um vendedor próprio. Contas a pagar não têm vendedor.
-- * Filtros da listagem (109): Tipo de pagamento (tPag da forma), Forma de pagamento e Vendedor.
-- * Histórico de até 2.000 caracteres: o texto inteiro fica em title.history e description continua com os primeiros 240
--   caracteres, que boletos, remessas, retornos, documentos e importações continuam lendo. Qualquer outro escritor que mude
--   description (recorrências, importações) descarta o histórico longo, para que os dois nunca divirjam.
-- * Categorização para DRE (135) aplicada nas baixas: cada baixa com juros, multa, desconto ou tarifa guarda, no momento da
--   baixa, as categorias padrão dos valores adicionais (erp_finance.settlement_category); os relatórios financeiros (212) as usam.
-- * Formas de pagamento da gaveta com o Prazo de recebimento (dias) e "dias úteis", que a gaveta usa no vencimento.
-- * Comissões (171): o vendedor nativo do pedido (164) também gera comissão.
-- Nenhuma conta, baixa, movimento, boleto ou documento existente é reescrito. Requer 108, 109, 126, 127, 135, 164, 171 e 175.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$ declare r record; begin
  for r in select * from (values
    ('erp_finance.dto(text,uuid)','c48e93a24308bee39cb33062265f57a87424ac7b78d162fe398d4f4cc8148af3'),
    ('public.erp_finance_title_execute(uuid,uuid,text,jsonb)','063497660e263619861e1848a7548485a26157a51ab4a84782f70f26141e7f15'),
    ('public.erp_finance_title_detail(uuid,uuid)','fb986abf6c0049cc4ee567cb71dc13734f226ae1e3209abddf461dfb6142a6eb'),
    ('public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text)','df2a55359273888823de39fbc51fc1d614f0a8127bc4f2e94e697c16b9fbf7d6'),
    ('public.erp_finance_payment_methods(uuid,text)','3daaf30e6224d92a58c4584df57a3bccbc6248f1c59796617220836d56a529b9'),
    ('erp_finance.commission_capture_title(uuid)','ed711366b0a94763ceb78e575b76eb4a88b1f08dcfe24c9caf9275d819bed1e7')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_parity_210_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Vendedor
alter table erp_finance.title add column seller_id uuid references erp_catalog.seller(id);
alter table erp_finance.title add constraint title_seller_receivable check(seller_id is null or kind='receivable');
create index erp_finance_title_seller on erp_finance.title(seller_id) where seller_id is not null;

-- Vendedor de um documento: o vendedor nativo (164) ou, no pedido espelhado do Origin, o vendedor Origin ligado ao contato (171).
create function erp_finance.document_seller(p_document erp_documents.document)
returns uuid language sql stable set search_path=pg_catalog as $$
  select coalesce((select s.id from erp_catalog.seller s where s.id=case when p_document.body->>'seller_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (p_document.body->>'seller_id')::uuid end),
    erp_finance.commission_seller(p_document.body#>'{commercial,seller_reference}'));
$$;
-- Vendedor efetivo de uma conta a receber: o da própria conta ou o do documento que a lançou.
create function erp_finance.title_seller(p_title uuid)
returns uuid language sql stable set search_path=pg_catalog as $$
  select coalesce(t.seller_id,(select erp_finance.document_seller(d) from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id
      join erp_documents.document d on d.id=p.document_id where l.title_id=t.id limit 1))
  from erp_finance.title t where t.id=p_title and t.kind='receivable';
$$;
-- The seller a conta may take: an existing seller whose contact is active; the current one stays even if inactivated.
create function erp_finance.seller_for(p_seller uuid,p_kind text,p_current uuid)
returns uuid language plpgsql stable set search_path=pg_catalog as $$
begin
  if p_seller is null or p_seller is not distinct from p_current then return p_seller; end if;
  if p_kind<>'receivable' or not exists(select 1 from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=p_seller and r.active) then
    raise exception 'erp_finance_invalid_seller' using errcode='22023'; end if;
  return p_seller;
end $$;

-- ---------------------------------------------------------------- Histórico longo
alter table erp_finance.title add column history text;
-- Length in UTF-16 units, the unit the API and the screens count (an emoji counts 2): every reader of description checks
-- 240 of them, so the short text is cut by this length, never by characters.
create function erp_finance.utf16_length(p_text text)
returns integer language sql immutable set search_path=pg_catalog as $$
  select 2*length(p_text)-length(regexp_replace(p_text,'[\U00010000-\U0010FFFF]','','g'));
$$;
alter table erp_finance.title add constraint title_history_check check(history is null
  or (erp_finance.utf16_length(history) between 241 and 2000 and history=btrim(history)
    and length(description)<length(history) and left(history,length(description))=description));
create function erp_finance.title_long_history()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  -- A writer that changes only the short description (recorrência, importação) drops the long text it did not see.
  if new.description is distinct from old.description and new.history is not distinct from old.history then new.history:=null; end if;
  return new;
end $$;
create trigger title_long_history before update on erp_finance.title for each row execute function erp_finance.title_long_history();
-- Histórico typed in the gaveta: the full text (up to 2.000) and the short description of every other reader (up to 240,
-- both in UTF-16 units, as the API validates them).
create function erp_finance.title_text(p_data jsonb,out description text,out history text)
language plpgsql immutable set search_path=pg_catalog as $$
declare v text:=erp_finance.txt(p_data,'description',2000,true); n integer:=240;
begin
  if erp_finance.utf16_length(v)>2000 then raise exception 'erp_finance_invalid_text' using errcode='22023'; end if;
  if erp_finance.utf16_length(v)<=240 then description:=v; history:=null; return; end if;
  description:=rtrim(left(v,n));
  while erp_finance.utf16_length(description)>240 loop n:=n-1; description:=rtrim(left(v,n)); end loop;
  history:=v;
end $$;

-- ---------------------------------------------------------------- Categorização para DRE nas baixas
create table erp_finance.settlement_category (
  settlement_id uuid primary key references erp_finance.settlement(id),
  interest_category_id uuid references erp_finance.category(id),
  penalty_category_id uuid references erp_finance.category(id),
  discount_category_id uuid references erp_finance.category(id),
  fee_category_id uuid references erp_finance.category(id),
  created_at timestamptz not null default clock_timestamp()
);
alter table erp_finance.settlement_category enable row level security;
revoke all on erp_finance.settlement_category from public,anon,authenticated,service_role;
create function erp_finance.settlement_category_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_finance_settlement_category_immutable' using errcode='42501'; end $$;
create trigger settlement_category_immutable before update or delete on erp_finance.settlement_category for each row execute function erp_finance.settlement_category_immutable();
-- Origin "Categorização para DRE": juros → Juros, multa → Acréscimos, desconto → Descontos e tarifa → Taxas (recebimentos) ou
-- Acréscimos (pagamentos, que não têm categoria de taxas). Gravado na baixa, com as categorias padrão daquele momento.
create function erp_finance.settlement_capture_categories()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_kind text; d jsonb;
begin
  if new.kind<>'payment' or new.interest_cents+new.penalty_cents+new.discount_cents+new.fee_cents=0 then return null; end if;
  select kind into v_kind from erp_finance.title where id=new.title_id;
  select jsonb_object_agg(key,category_id) into d from erp_finance.category_default where category_id is not null;
  d:=coalesce(d,'{}'::jsonb);
  if v_kind='receivable' then
    insert into erp_finance.settlement_category(settlement_id,interest_category_id,penalty_category_id,discount_category_id,fee_category_id)
      values(new.id,case when new.interest_cents>0 then (d->>'receipt_interest')::uuid end,case when new.penalty_cents>0 then (d->>'receipt_additions')::uuid end,
        case when new.discount_cents>0 then (d->>'receipt_discounts')::uuid end,case when new.fee_cents>0 then (d->>'receipt_fees')::uuid end);
  else
    insert into erp_finance.settlement_category(settlement_id,interest_category_id,penalty_category_id,discount_category_id,fee_category_id)
      values(new.id,case when new.interest_cents>0 then (d->>'payment_interest')::uuid end,case when new.penalty_cents>0 then (d->>'payment_additions')::uuid end,
        case when new.discount_cents>0 then (d->>'payment_discounts')::uuid end,case when new.fee_cents>0 then (d->>'payment_additions')::uuid end);
  end if;
  return null;
end $$;
create trigger settlement_capture_categories after insert on erp_finance.settlement for each row execute function erp_finance.settlement_capture_categories();

-- ---------------------------------------------------------------- DTO
CREATE OR REPLACE FUNCTION erp_finance.dto(p_entity text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v jsonb; v_seller uuid;
begin
  if p_entity='accounts' then
    select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'active',a.active,'opening_recorded',a.opening_recorded,
      'version',a.version,'created_at',a.created_at,'updated_at',a.updated_at,
      'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text) into v from erp_finance.account a where id=p_id;
  elsif p_entity='categories' then select to_jsonb(c) into v from erp_finance.category c where id=p_id;
  elsif p_entity='titles' then
    v_seller:=erp_finance.title_seller(p_id);
    -- 210: the long histórico (history) is read by the gaveta only (erp_finance_title_detail), never by lists.
    select (to_jsonb(t)-'amount_cents'-'settled_cents'-'history'-'seller_id')||jsonb_build_object('amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
      'balance_cents',(t.amount_cents-t.settled_cents)::text,'contact_name',c.name,'category_name',g.name,
      'document_linked',exists(select 1 from erp_finance.document_title l where l.title_id=t.id),
      -- 175: Forma de pagamento (name and the taxa it would take from this valor) and the Faturamento agrupado of the conta.
      'payment_method_name',(select left(f.description,100) from erp_catalog.payment_method f where f.id=t.payment_method_id),
      'payment_type',(select f.payment_type from erp_catalog.payment_method f where f.id=t.payment_method_id),
      'payment_fee_cents',case when t.payment_method_id is null then null else erp_finance.payment_method_fee(t.payment_method_id,t.amount_cents)::text end,
      'grouped_billing_id',(select g.billing_id from erp_finance.grouped_billing_title g where g.title_id=t.id),
      -- 210: Vendedor efetivo (the conta's own, or the document's while the conta has none).
      'seller_id',v_seller,'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id=v_seller),
      'seller_source',case when t.seller_id is not null then 'conta' when v_seller is not null then 'documento' end,
      'long_history',t.history is not null,
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

-- ---------------------------------------------------------------- Gaveta: incluir, alterar e excluir
CREATE OR REPLACE FUNCTION public.erp_finance_title_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_method uuid; v_seller uuid; v_text record; v_history text;
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
      'issued_on','competence_on','interest_month_bp','penalty_bp','total_cents','installments','payment_method_id','seller_id']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    v_contact:=erp_finance.uuid_value(p_data->'contact_id');
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then
      raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    v_category:=erp_finance.active_category(erp_finance.uuid_value(p_data->'category_id',false),v_kind);
    v_account:=erp_finance.active_account(erp_finance.uuid_value(p_data->'account_id',false));
    v_method:=erp_finance.payment_method_for(erp_finance.uuid_value(p_data->'payment_method_id',false),v_kind,null);
    v_seller:=erp_finance.seller_for(erp_finance.uuid_value(p_data->'seller_id',false),v_kind,null);
    v_issued:=erp_finance.day(p_data->'issued_on'); v_competence:=erp_finance.day(p_data->'competence_on');
    v_amount:=erp_finance.cents(p_data->'total_cents',false);
    select * into v_text from erp_finance.title_text(p_data); v_description:=v_text.description; v_history:=v_text.history;
    v_reference:=erp_finance.txt(p_data,'source_reference',200);
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
          competence_on,account_id,bank_number,interest_month_bp,penalty_bp,original_due_on,payment_method_id,seller_id,history)
        values(v_group,v_index,v_count,v_kind,v_contact,v_category,v_description,v_reference,v_issued,v_due,v_part,
          v_competence,v_account,v_bank,v_interest,v_penalty,v_due,v_method,v_seller,v_history) returning id into v_id;
      v_items:=v_items||jsonb_build_array(erp_finance.dto('titles',v_id));
    end loop;
    if v_total<>v_amount then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
    v_result:=jsonb_build_object('entity','titles','group_id',v_group,'items',v_items);

  else
    if p_action='title_edit' then
      perform erp_finance.keys(p_data,array['id','expected_version','contact_id','category_id','account_id','description','source_reference','bank_number',
        'issued_on','competence_on','due_on','amount_cents','interest_month_bp','penalty_bp','payment_method_id','seller_id']);
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
      v_seller:=case when p_data?'seller_id' then erp_finance.seller_for(erp_finance.uuid_value(p_data->'seller_id',false),v_title.kind,v_title.seller_id) else v_title.seller_id end;
      if p_data?'description' then select * into v_text from erp_finance.title_text(p_data); v_description:=v_text.description; v_history:=v_text.history;
      else v_description:=v_title.description; v_history:=v_title.history; end if;
      update erp_finance.title set contact_id=v_contact,issued_on=v_issued,amount_cents=v_amount,source_reference=v_reference,bank_number=v_bank,
        due_on=v_due,category_id=v_category,account_id=v_account,payment_method_id=v_method,seller_id=v_seller,
        description=v_description,history=v_history,
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

-- ---------------------------------------------------------------- Leitura da gaveta (108) com o histórico longo
CREATE OR REPLACE FUNCTION public.erp_finance_title_detail(p_user_id uuid, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    'settled_before',exists(select 1 from erp_finance.settlement where title_id=p_id),'original',v_original,
    'history',(select t.history from erp_finance.title t where t.id=p_id),'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Listagem (109) com Tipo de pagamento, Forma de pagamento e Vendedor
drop function public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text);
create function public.erp_finance_title_page_v2(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,
  p_order text default 'due_asc',p_query text default null,p_option text default 'issued',p_statuses text[] default null,p_date_field text default 'due',
  p_from date default null,p_to date default null,p_account text default null,p_categories text[] default null,p_remittance text default null,
  p_amount_cents bigint default null,p_document text default null,p_payment_type text default null,p_payment_method uuid default null,p_seller uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_query text:=lower(nullif(btrim(p_query),''));
  v_document text:=lower(nullif(btrim(p_document),''));
  v_digits text; v_account uuid; v_no_account boolean:=coalesce(p_account='none',false); v_categories uuid[]; v_no_category boolean:=false;
  v_total bigint; v_amount numeric; v_balance numeric; v_fee numeric; v_items jsonb;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or p_order is null or p_order not in ('due_asc','due_desc')
    or length(p_query)>120 or p_query~'[[:cntrl:]]' or length(p_document)>60 or p_document~'[[:cntrl:]]'
    or p_option is null or p_option not in ('open','overdue','issued','settled')
    or p_date_field is null or p_date_field not in ('due','issued','settled','competence')
    -- The Opção fixes the date of the period, as in Origin; only Emitidas chooses it and the Situação.
    or (p_option in ('open','overdue') and p_date_field<>'due') or (p_option='settled' and p_date_field<>'settled')
    or (p_statuses is not null and (p_option<>'issued' or array_ndims(p_statuses) is distinct from 1 or cardinality(p_statuses) not between 1 and 4
      or array_position(p_statuses,null) is not null or not p_statuses<@array['open','partial','paid','cancelled']
      or (select count(distinct s) from unnest(p_statuses) s)<>cardinality(p_statuses)))
    or (p_from is not null and (not isfinite(p_from) or p_from<date '1900-01-01' or p_from>date '2100-12-31'))
    or (p_to is not null and (not isfinite(p_to) or p_to<date '1900-01-01' or p_to>date '2100-12-31')) or p_from>p_to
    or (p_account is not null and not v_no_account and p_account!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 50
      or array_position(p_categories,null) is not null or (select count(distinct lower(c)) from unnest(p_categories) c)<>cardinality(p_categories)
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    or (p_remittance is not null and (p_remittance not in ('yes','no') or p_option<>'open'))
    or p_amount_cents not between 1 and 999999999999999
    -- 210: Tipo de pagamento (tPag of the forma, two digits) and Vendedor (contas a receber only).
    or (p_payment_type is not null and p_payment_type!~'^[0-9]{2}$') or (p_seller is not null and p_kind<>'receivable')
  then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if p_account is not null and not v_no_account then v_account:=p_account::uuid; end if;
  if p_categories is not null then
    v_no_category:='none'=any(p_categories);
    select array_agg(c::uuid) into v_categories from unnest(p_categories) c where c<>'none';
  end if;
  if v_query~'^[0-9 ./-]+$' then v_digits:=regexp_replace(v_query,'[^0-9]','','g'); if length(v_digits)<3 then v_digits:=null; end if; end if;

  with filtered as materialized (
    select t.id,t.due_on,t.amount_cents,t.settled_cents,t.cancelled
    from erp_finance.title t
    join erp_catalog.record r on r.id=t.contact_id
    left join erp_catalog.contact c on c.record_id=t.contact_id
    left join erp_finance.document_title l on l.title_id=t.id
    left join erp_finance.document_posting dp on dp.id=l.posting_id
    left join erp_documents.document d on d.id=dp.document_id
    where t.kind=p_kind and t.deleted_at is null
      and (p_option<>'open' or (not t.cancelled and t.settled_cents<t.amount_cents))
      and (p_option<>'overdue' or (not t.cancelled and t.settled_cents<t.amount_cents and t.due_on<v_today))
      and (p_option<>'settled' or exists(select 1 from erp_finance.settlement s where s.title_id=t.id and s.kind='payment'
        and s.posted_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31')
        and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id)))
      and (p_statuses is null
        or ('open'=any(p_statuses) and not t.cancelled and t.settled_cents=0)
        or ('partial'=any(p_statuses) and not t.cancelled and t.settled_cents>0 and t.settled_cents<t.amount_cents)
        or ('paid'=any(p_statuses) and not t.cancelled and t.settled_cents=t.amount_cents)
        or ('cancelled'=any(p_statuses) and t.cancelled))
      and ((p_from is null and p_to is null) or p_date_field='settled' and p_option='settled'
        or (p_date_field='due' and t.due_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='issued' and t.issued_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='competence' and t.competence_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31'))
        or (p_date_field='settled' and exists(select 1 from erp_finance.settlement s where s.title_id=t.id and s.kind='payment'
          and s.posted_on between coalesce(p_from,date '1900-01-01') and coalesce(p_to,date '2100-12-31')
          and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id))))
      and (p_account is null or (v_no_account and t.account_id is null) or t.account_id=v_account)
      and (p_categories is null or (v_no_category and t.category_id is null) or t.category_id=any(v_categories))
      and (p_remittance is null or (p_remittance='yes')=exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id))
      and (p_amount_cents is null or t.amount_cents=p_amount_cents)
      and (p_payment_method is null or t.payment_method_id=p_payment_method)
      and (p_payment_type is null or exists(select 1 from erp_catalog.payment_method f where f.id=t.payment_method_id and f.payment_type=p_payment_type))
      and (p_seller is null or coalesce(t.seller_id,case when d.id is not null then erp_finance.document_seller(d) end) is not distinct from p_seller)
      and (v_document is null or strpos(lower(concat_ws(' ',t.source_reference,d.number::text)),v_document)>0)
      and (v_query is null
        or strpos(lower(concat_ws(' ',r.name,c.trade_name,c.email,c.document,t.description,t.source_reference,t.bank_number,d.number::text)),v_query)>0
        or (v_digits is not null and strpos(regexp_replace(coalesce(c.document,''),'[^0-9]','','g'),v_digits)>0))
  ), page as (
    select id,due_on,amount_cents,settled_cents,cancelled from filtered
    order by case when p_order='due_asc' then due_on end asc,case when p_order='due_desc' then due_on end desc,
      case when p_order='due_asc' then id end asc,case when p_order='due_desc' then id end desc
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),(select coalesce(sum(amount_cents),0) from filtered),
    (select coalesce(sum(case when cancelled then 0 else amount_cents-settled_cents end),0) from filtered),
    (select coalesce(sum(s.fee_cents),0) from erp_finance.settlement s join filtered f on f.id=s.title_id
      where s.kind='payment' and not exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id)),
    (select coalesce(jsonb_agg(erp_finance.dto('titles',p.id)||jsonb_build_object(
        'overdue',not p.cancelled and p.settled_cents<p.amount_cents and p.due_on<v_today,'origin',erp_finance.title_origin(p.id),
        'account_name',(select a.name from erp_finance.account a join erp_finance.title t on t.account_id=a.id where t.id=p.id),
        'remittance',(select jsonb_build_object('id',r.id,'sequence',r.sequence,'state',r.state,'our_number',b.our_number)
          from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.title_id=p.id),
        'payments',erp_finance.title_payments(p.id),
        -- Contas adotadas do Origin (039) ficam com o Origin: não são excluídas no Brufap.
        'imported',exists(select 1 from erp_finance.origin_import_origin o where o.title_id=p.id))
      order by case when p_order='due_asc' then p.due_on end asc,case when p_order='due_desc' then p.due_on end desc,
        case when p_order='due_asc' then p.id end asc,case when p_order='due_desc' then p.id end desc),'[]'::jsonb) from page p)
  into v_total,v_amount,v_balance,v_fee,v_items;

  return jsonb_build_object('entity','titles','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'order',p_order,'option',p_option,
    'total',v_total,'totals',jsonb_build_object('count',v_total,'amount_cents',v_amount::text,'balance_cents',v_balance::text,'fee_cents',v_fee::text),
    'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Formas de pagamento da gaveta com o prazo de recebimento
CREATE OR REPLACE FUNCTION public.erp_finance_payment_methods(p_user_id uuid, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_kind is null or p_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  return jsonb_build_object('entity','payment_methods','kind',p_kind,'items',(select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'description',f.description,'payment_type',f.payment_type,
    'account_id',f.account_id,'interest_rate',f.interest_rate::text,'fine_rate',f.fine_rate::text,'fee_type',f.fee_type,'fee_rate',f.fee_rate::text,'fee_fixed',f.fee_fixed::text,'is_default',f.is_default,
    -- 210: Prazo de recebimento (dias) and "dias úteis" of the forma, used by the gaveta for the vencimento.
    'settlement_days',f.settlement_days,'business_days',f.business_days)
    order by f.is_default desc,lower(f.description),f.id),'[]'::jsonb) from (select * from erp_catalog.payment_method f where f.active and f.deleted_at is null
      and f.applicable in ('ambos',case when p_kind='receivable' then 'recebimentos' else 'pagamentos' end) order by f.is_default desc,lower(f.description),f.id limit 200) f),'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Comissões: o vendedor nativo do pedido (164)
CREATE OR REPLACE FUNCTION erp_finance.commission_capture_title(p_title uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare l erp_finance.document_title; p erp_finance.document_posting; d erp_documents.document; t erp_finance.title; v_seller uuid; v_calc record;
  v_total bigint; v_before bigint; v_upto bigint; v_n integer; v_commission numeric; v_id uuid;
begin
  select * into l from erp_finance.document_title where title_id=p_title;
  select * into p from erp_finance.document_posting where id=l.posting_id;
  if p.id is null or p.state<>'active' or coalesce(p.snapshot->>'kind','') not in ('sales_orders','service_orders') then return null; end if;
  if exists(select 1 from erp_finance.commission where title_id=p_title) then return null; end if;
  select * into d from erp_documents.document where id=p.document_id;
  -- 210: the native seller of the pedido (164) or, for a mirrored pedido, the Origin seller (171).
  v_seller:=erp_finance.document_seller(d);
  if v_seller is null then return null; end if;
  select * into v_calc from erp_finance.commission_document(d.id,v_seller);
  if v_calc.items_cents<=0 or v_calc.weighted<=0 then return null; end if;
  v_total:=(p.snapshot->>'total_cents')::bigint;
  if v_total is null or v_total<=0 then return null; end if;
  select coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<l.position),0),
      coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<=l.position),0),count(*)
    into v_before,v_upto,v_n from jsonb_array_elements(p.snapshot->'installments') x;
  v_commission:=round(v_calc.base_cents::numeric*v_calc.weighted/(v_calc.items_cents::numeric*100));
  select * into t from erp_finance.title where id=p_title;
  insert into erp_finance.commission(seller_id,origin,posting_id,title_id,document_id,position,positions,rule,parcel_cents,base_cents,rate,commission_cents,due_on,description,actor,command_id)
    values(v_seller,'document',p.id,t.id,d.id,l.position,v_n,v_calc.rule,t.amount_cents,
      (round(v_calc.base_cents::numeric*v_upto/v_total)-round(v_calc.base_cents::numeric*v_before/v_total))::bigint,
      round(v_calc.weighted/v_calc.items_cents,6),(round(v_commission*v_upto/v_total)-round(v_commission*v_before/v_total))::bigint,t.due_on,
      left(format('%s nº %s · parcela %s/%s',case d.kind when 'sales_orders' then 'Pedido de venda' else 'Ordem de serviço' end,d.number,l.position,v_n),240),p.actor,p.command_id)
    returning id into v_id;
  return v_id;
end $function$;
-- Contas already lançadas by pedidos/OS with a native seller get their commission now, as 171 did for the Origin sellers.
do $$ declare v uuid; begin
  for v in select l.title_id from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id join erp_documents.document d on d.id=p.document_id
    where p.state='active' and d.body?'seller_id' and not exists(select 1 from erp_finance.commission c where c.title_id=l.title_id) order by p.created_at,l.position loop
    begin perform erp_finance.commission_capture_title(v);
    exception when data_exception or check_violation then null; end;
  end loop;
end $$;

revoke all on function erp_finance.document_seller(erp_documents.document),erp_finance.title_seller(uuid),erp_finance.seller_for(uuid,text,uuid),
  erp_finance.title_long_history(),erp_finance.utf16_length(text),erp_finance.title_text(jsonb),erp_finance.settlement_category_immutable(),erp_finance.settlement_capture_categories(),
  erp_finance.dto(text,uuid),erp_finance.commission_capture_title(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_title_execute(uuid,uuid,text,jsonb)','erp_finance_title_detail(uuid,uuid)','erp_finance_payment_methods(uuid,text)',
    'erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
