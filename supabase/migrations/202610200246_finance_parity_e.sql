-- 246: financeiro no padrão Origin, onda E (lane financeiro).
-- * "Sem vendedor": a conta lançada por um pedido herda o vendedor do pedido; limpar o Vendedor na gaveta agora grava a escolha
--   (title.seller_none) em vez de voltar ao vendedor herdado. Escolher um vendedor de novo desfaz a escolha.
-- * Coluna Forma de pagamento com o banco: a listagem devolve o banco (código e nome) da conta financeira da forma de pagamento
--   ou, sem ela, da conta financeira da própria conta.
-- * Retornos: Nº Retorno (número sequencial do arquivo .RET, guardado pela API na leitura a partir desta versão) na listagem e
--   em Dados do retorno; "Excluir selecionados" passa a tomar a mesma trava da vinculação e da baixa pelo retorno (a trava
--   operacional, o perfil e o arquivo), e a vinculação/baixa recusa as ocorrências de um retorno já excluído.
-- * Fluxo de caixa previsto: as atrasadas são as contas em aberto vencidas antes de hoje (São Paulo), não antes do "De".
-- * Caixas e bancos > extrato: Situação "Cancelados" (as baixas estornadas e os estornos).
-- * Sistema > Usuários > Permissões > Finanças aplicadas no banco: toda escrita do financeiro e da cobrança passa pela auditoria,
--   que confere a chave da operação (erp_access.permitted); as listagens de contas, extrato, relatórios, remessas e retornos
--   conferem a chave da tela; erp_finance_access devolve as chaves permitidas para a interface.
-- Nada aqui gera arquivo de cobrança, chama banco ou baixa conta automaticamente. Requer 210, 212, 213 e 229.
begin;

do $$ declare r record; begin
  if to_regprocedure('erp_access.permitted(uuid,text)') is null then raise exception 'finance_parity_246_requires_229' using errcode='55000'; end if;
  for r in select * from (values
    ('erp_finance.title_seller(uuid)','d95a92f40ec6d6b6aa3fa5b2e345affcc5f9aa8c904d7f78f481f782b200b339'),
    ('erp_finance.dto(text,uuid)','90a921641fd44f6e47335fe4c599f6bb0349703d79662fb638a1982f5a9a3eea'),
    ('public.erp_finance_title_execute(uuid,uuid,text,jsonb)','382d01677fb454d284aa714aaeb9646641478a3a981d9c593141a0eb1a675878'),
    ('public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)','2e2827db887b9427c1a3404cc2b0200f191f8e6dce8d5f62fa941503dcf9c3d6'),
    ('public.erp_cnab_return_exclude(uuid,uuid,jsonb)','d663f2e82e812fee7812d69bcff49b51bb97d71ca16bec50a571fc3d89db4aa9'),
    ('erp_cnab.lock_operational_event(uuid,uuid,integer,integer)','478c9959704f32fd45a4531e46cfd0f76bfd045eccf74af12428096cee196919'),
    ('public.erp_finance_report(uuid,text,date,date,uuid,text,integer,integer)','ce4bca5c92f0ede6a900df69881f91a1b8076d074e7ecec18019dee78546f203'),
    ('public.erp_cnab_return_page(uuid,text,date,date,integer,integer)','6e700e04a426b165f8aa24816f035d21aa660b48c565b08f6a1e4eda9d73700d'),
    ('public.erp_cnab_return_detail(uuid,uuid,text,integer,integer)','1d5b52c660671a51c266be54b3a5dce1e154afee94d59a8b2605dfed6aecd1c3'),
    ('public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text)','1fb9fbca207e6788dc76b13dd9deee3fb720bbdb614fa4bdf58976a14069b9c5'),
    ('public.erp_cnab_remittance_page(uuid,text,date,date,integer,integer)','c9be5f8405117d9ee2a3d95ecda693ad71e6b1b6578c665e7a2b7d2749083557'),
    ('public.erp_cnab_remittance_detail(uuid,uuid)','cfd473b361816cf76494b0fb5d4faf30a82a36779bd1861190fe1cc5b42bae61'),
    ('public.erp_finance_access(uuid)','4d10c37741127d8b6c9d5331a17a5200a5900170dc956cbfd7daeef476dbdf1f')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_parity_246_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Permissões (229) no financeiro e na cobrança
create function erp_finance.require_permission(p_user uuid,p_key text)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
  if not erp_access.permitted(p_user,p_key) then raise exception 'erp_finance_permission_denied' using errcode='42501'; end if;
end $$;
-- Chave do catálogo de permissões de cada escrita auditada do financeiro. Contas a receber e a pagar se distinguem pelo tipo da
-- conta da resposta; uma operação sem chave própria no catálogo (configurações e importações do Origin) fica só com o perfil.
create function erp_finance.permission_key(p_action text,p_after jsonb)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v_kind text; v_side text;
begin
  if p_action like 'document\_%' then
    return case p_after#>>'{posting,kind}' when 'sales_orders' then 'vendas.pedidos_venda.lancar_contas' when 'purchase_orders' then 'suprimentos.pedidos_compra.lancar_contas'
      when 'service_orders' then 'financas.contas_receber.ie' end;
  end if;
  if p_action like 'invoice\_%' then
    return case p_after#>>'{posting,direction}' when 'receivable' then 'vendas.notas_fiscais.lancar_contas' when 'payable' then 'suprimentos.notas_entrada.lancar_contas' end;
  end if;
  v_kind:=coalesce(case when p_after->>'entity' in ('titles','recurrences') then p_after#>>'{record,kind}' end,
    case when jsonb_typeof(p_after->'items')='array' then coalesce(p_after#>>'{items,0,kind}',p_after#>>'{items,0,title,kind}') end,
    p_after#>>'{title,kind}',case when p_after->>'entity'='financial_import' then p_after->>'kind' end);
  v_side:=case v_kind when 'receivable' then 'financas.contas_receber' when 'payable' then 'financas.contas_pagar' end;
  return case
    -- Importar lançamentos de caixa (records_import of kind cash) are lançamentos of Caixas e bancos.
    when p_action='records_import' and v_kind='cash' then 'financas.caixas_bancos.ie'
    when p_action in ('title_create','title_create_group','title_edit','title_update','records_import') or p_action like 'recurrence\_%' then v_side||'.ie'
    when p_action='title_delete' then v_side||'.ex'
    when p_action='title_cancel' then v_side||'.cancelar'
    when p_action in ('settle','settle_batch','reverse') or p_action like 'bordero%' then v_side||'.baixar'
    -- The extrato of Caixas e bancos excludes transfers and changes the categoria of its lines with the keys of the extrato.
    when p_action in ('account_delete','entry_delete','transfer_delete') then 'financas.caixas_bancos.ex'
    when p_action like 'account\_%' or p_action in ('opening','entry_save','entry_restore','balance_adjust','line_categorize') then 'financas.caixas_bancos.ie'
    -- Conciliação Bancária: every action of a line of the bank statement, the transfer created from it included.
    when p_action like 'statement\_%' or p_action like 'line\_%' then 'financas.conciliacao'
    when p_action like '%transfer%' then 'financas.caixas_bancos.transferencia'
    when p_action='category_delete' then 'financas.categorias.ex'
    when p_action like 'category\_%' then 'financas.categorias.ie'
    when p_action like 'grouped\_billing\_%' then 'financas.faturamento_agrupado'
    when p_action like 'commission\_%' then 'vendas.comissoes'
    when p_action='session_delete' then 'vendas.controle_caixa.ex'
    when p_action like 'session\_%' then 'vendas.controle_caixa.ie'
  end;
end $$;
create function erp_finance.audit_permission()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_key text:=erp_finance.permission_key(new.action,new.after_data);
begin
  if v_key is not null and not erp_access.permitted(new.actor,v_key) then raise exception 'erp_finance_permission_denied' using errcode='42501',detail=v_key; end if;
  return new;
end $$;
create trigger audit_permission before insert on erp_finance.audit for each row execute function erp_finance.audit_permission();
create function erp_cnab.permission_key(p_action text)
returns text language sql immutable set search_path=pg_catalog as $$
  -- The v2 remessa (Incluir Remessa of the cobrança, Gerar remessa of Contas a receber and Emitir boletos of the notes) too.
  select case when p_action in ('reserve','operational_reserve','operational_reserve_v2') then 'financas.remessas.ie'
    when p_action in ('finalize','operational_finalize','operational_finalize_v2') then 'financas.remessas.gerar'
    when p_action='remittance_exclude' then 'financas.remessas.ex'
    when p_action='return_exclude' then 'financas.retornos.ex'
    when p_action in ('return_commit','operational_return','operational_bind','operational_settle','itau_net_credit_settle','human_review') then 'financas.retornos.ie' end;
$$;
create function erp_cnab.audit_permission()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_key text:=erp_cnab.permission_key(new.action);
begin
  if v_key is not null and not erp_access.permitted(new.actor,v_key) then raise exception 'erp_finance_permission_denied' using errcode='42501',detail=v_key; end if;
  return new;
end $$;
create trigger audit_permission before insert on erp_cnab.audit for each row execute function erp_cnab.audit_permission();

-- Acesso ao financeiro com as chaves permitidas (Finanças, Comissões, Controle de caixa e lançamento de contas dos documentos).
CREATE OR REPLACE FUNCTION public.erp_finance_access(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_role text;
begin v_role:=erp_finance.require_access(p_user_id,false);
  return jsonb_build_object('read',true,'write',v_role in ('admin','financeiro'),
    'permitted',(select coalesce(jsonb_agg(k order by i),'[]'::jsonb) from unnest(erp_access.permission_keys()) with ordinality x(k,i)
      where (k like 'financas.%' or k like 'vendas.comissoes%' or k like 'vendas.controle\_caixa%' or k like '%.lancar\_contas') and erp_access.permitted(p_user_id,k)),
    'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Vendedor: "sem vendedor" nas contas lançadas por pedidos
alter table erp_finance.title add column seller_none boolean not null default false;
alter table erp_finance.title add constraint title_seller_none check(not seller_none or (seller_id is null and kind='receivable'));
-- The seller the conta takes from what posted it (the pedido/OS today), ignoring its own.
create function erp_finance.title_inherited_seller(p_title uuid)
returns uuid language sql stable set search_path=pg_catalog as $$
  select erp_finance.document_seller(d) from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id
    join erp_documents.document d on d.id=p.document_id where l.title_id=p_title limit 1;
$$;
CREATE OR REPLACE FUNCTION erp_finance.title_seller(p_title uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  -- 246: "sem vendedor" chosen in the gaveta wins over the seller of the document.
  select case when t.seller_none then null else coalesce(t.seller_id,erp_finance.title_inherited_seller(t.id)) end
  from erp_finance.title t where t.id=p_title and t.kind='receivable';
$function$;

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
    select (to_jsonb(t)-'amount_cents'-'settled_cents'-'history'-'seller_id'-'seller_none')||jsonb_build_object('amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
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
      -- 246: "sem vendedor" chosen over the seller of the document.
      'seller_cleared',t.seller_none,
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

CREATE OR REPLACE FUNCTION public.erp_finance_title_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_method uuid; v_seller uuid; v_seller_none boolean; v_text record; v_history text;
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
      -- 246: clearing the Vendedor of a conta whose document has a seller keeps "sem vendedor"; choosing one undoes it.
      v_seller_none:=case when p_data?'seller_id' then v_seller is null and v_title.kind='receivable' and erp_finance.title_inherited_seller(v_id) is not null else v_title.seller_none end;
      if p_data?'description' then select * into v_text from erp_finance.title_text(p_data); v_description:=v_text.description; v_history:=v_text.history;
      else v_description:=v_title.description; v_history:=v_title.history; end if;
      update erp_finance.title set contact_id=v_contact,issued_on=v_issued,amount_cents=v_amount,source_reference=v_reference,bank_number=v_bank,
        due_on=v_due,category_id=v_category,account_id=v_account,payment_method_id=v_method,seller_id=v_seller,seller_none=v_seller_none,
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

-- ---------------------------------------------------------------- Listagem: banco da forma, "sem vendedor" e a permissão da tela
CREATE OR REPLACE FUNCTION public.erp_finance_title_page_v2(p_user_id uuid,p_kind text,p_page integer default 1,p_limit integer default 100,
  p_order text default 'due_asc',p_query text default null,p_option text default 'issued',p_statuses text[] default null,p_date_field text default 'due',
  p_from date default null,p_to date default null,p_account text default null,p_categories text[] default null,p_remittance text default null,
  p_amount_cents bigint default null,p_document text default null,p_payment_type text default null,p_payment_method uuid default null,p_seller uuid default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
  -- 246: Sistema > Usuários > Permissões > Finanças > Contas a Receber / Contas a Pagar.
  perform erp_finance.require_permission(p_user_id,case when p_kind='receivable' then 'financas.contas_receber' else 'financas.contas_pagar' end);
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
      -- 246: the effective Vendedor, which keeps "sem vendedor" (erp_finance.title_seller).
      and (p_seller is null or erp_finance.title_seller(t.id) is not distinct from p_seller)
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
        -- 246: the bank of the conta financeira of the forma (else of the conta itself) for the column Forma de pagamento.
        'payment_bank',(select jsonb_build_object('code',a.institution_code,'name',left(a.institution_name,80)) from erp_finance.title t
          left join erp_catalog.payment_method f on f.id=t.payment_method_id join erp_finance.account a on a.id=coalesce(f.account_id,t.account_id)
          where t.id=p.id and t.payment_method_id is not null and a.institution_code is not null),
        -- Contas adotadas do Origin (039) ficam com o Origin: não são excluídas no Brufap.
        'imported',exists(select 1 from erp_finance.origin_import_origin o where o.title_id=p.id))
      order by case when p_order='due_asc' then p.due_on end asc,case when p_order='due_desc' then p.due_on end desc,
        case when p_order='due_asc' then p.id end asc,case when p_order='due_desc' then p.id end desc),'[]'::jsonb) from page p)
  into v_total,v_amount,v_balance,v_fee,v_items;

  return jsonb_build_object('entity','titles','kind',p_kind,'items',v_items,'page',p_page,'limit',p_limit,'order',p_order,'option',p_option,
    'total',v_total,'totals',jsonb_build_object('count',v_total,'amount_cents',v_amount::text,'balance_cents',v_balance::text,'fee_cents',v_fee::text),
    'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Retornos: Nº Retorno e a trava da exclusão
-- Number of the .RET file (header positions 109-113 of the Itaú 400 layout), stored by the API in the evidence since 246.
create function erp_cnab.return_number(p_file erp_cnab.return_file)
returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_file.evidence->>'fileSequence'~'^[0-9]{1,7}$' then p_file.evidence->>'fileSequence' end;
$$;
CREATE OR REPLACE FUNCTION public.erp_cnab_return_page(p_user_id uuid, p_query text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_page integer DEFAULT 1, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_rows jsonb;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_finance.require_permission(p_user_id,'financas.retornos');
  perform erp_cnab.list_query(p_query);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_from>p_to
    or (p_from is not null and (p_from<date '1900-01-01' or p_from>date '2100-12-31')) or (p_to is not null and (p_to<date '1900-01-01' or p_to>date '2100-12-31')) then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with base as materialized (
    select f.*,'RETORNO_'||f.id::text||'.RET' filename,p.identity->>'bank' bank,erp_cnab.return_number(f) number from erp_cnab.return_file f join erp_cnab.profile p on p.id=f.profile_id
    where not exists(select 1 from erp_cnab.return_exclusion x where x.file_id=f.id)
      and (p_from is null or f.generated_on>=p_from) and (p_to is null or f.generated_on<=p_to)
  ), filtered as materialized (select * from base where v_query is null or strpos(lower(filename),v_query)>0 or strpos(file_hash,v_query)=1
    or (number is not null and ltrim(v_query,'0')<>'' and ltrim(number,'0')=ltrim(v_query,'0'))),
  page as (select * from filtered order by generated_on desc,created_at desc,id limit p_limit offset (p_page-1)*p_limit)
  select (select count(*) from filtered),(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'profile_id',p.profile_id,'purpose',p.purpose,'generated_on',p.generated_on,'created_at',p.created_at,
      'filename',p.filename,'bank',p.bank,'bank_name',erp_cnab.bank_label(p.bank),'number',p.number,'titles',p.record_count-2,
      'total_cents',(select coalesce(sum((e.payload->>'amountCents')::bigint),0) from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=p.id)::text,
      'excludable',not erp_cnab.return_applied(p.id)) order by p.generated_on desc,p.created_at desc,p.id),'[]'::jsonb) from page p)
  into v_total,v_rows;
  return jsonb_build_object('entity','cnab_returns','page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $function$;

CREATE OR REPLACE FUNCTION public.erp_cnab_return_detail(p_user_id uuid, p_id uuid, p_group text DEFAULT 'settlements'::text, p_page integer DEFAULT 1, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare f erp_cnab.return_file; p erp_cnab.profile; v_summary jsonb; v_rows jsonb; v_total bigint;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_finance.require_permission(p_user_id,'financas.retornos');
  if p_group is null or p_group not in ('entries','settlements','others') or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  select * into f from erp_cnab.return_file where id=p_id and not exists(select 1 from erp_cnab.return_exclusion x where x.file_id=p_id);
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select * into p from erp_cnab.profile where id=f.profile_id;
  with ev as materialized (
    select o.line,o.duplicate,e.id event_id,e.payload,erp_cnab.return_group(e.payload->>'kind') grp,coalesce((e.payload->>'amountCents')::bigint,0) amount,coalesce((e.payload->>'paidCents')::bigint,0) paid,
      coalesce((e.payload#>>'{adjustments,fee}')::bigint,0) fee,coalesce((e.payload#>>'{adjustments,interest}')::bigint,0) interest,coalesce((e.payload#>>'{adjustments,discount}')::bigint,0) discount
    from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=f.id)
  select jsonb_build_object('titles',count(*),'amount_cents',coalesce(sum(amount),0)::text,'amount_with_additions_cents',coalesce(sum(amount+interest),0)::text,
      'entries',count(*) filter (where grp='entries'),'entries_cents',coalesce(sum(amount) filter (where grp='entries'),0)::text,
      'settlements',count(*) filter (where grp='settlements'),'settlements_cents',coalesce(sum(paid) filter (where grp='settlements'),0)::text,
      'others',count(*) filter (where grp='others'),'interest_cents',coalesce(sum(interest),0)::text,'discount_cents',coalesce(sum(discount),0)::text,'fee_cents',coalesce(sum(fee),0)::text),
    count(*) filter (where grp=p_group),
    (select coalesce(jsonb_agg(x.item order by x.line),'[]'::jsonb) from (select v.line,jsonb_build_object('line',v.line,'event_id',v.event_id,'duplicate',v.duplicate,'kind',v.payload->>'kind','occurrence',v.payload->>'occurrence',
        'document_number',v.payload->>'documentNumber','our_number',v.payload->>'ourNumber','occurrence_date',v.payload->>'occurrenceDate','credit_date',v.payload->>'creditDate','due_date',v.payload->>'dueDate',
        'contact_name',(select left(coalesce(b.snapshot#>>'{title,payer,name}',''),200) from erp_cnab.return_event e2 join erp_cnab.billing_title b on b.id=e2.billing_title_id where e2.id=v.event_id),
        'fee_cents',v.fee::text,'interest_cents',v.interest::text,'amount_cents',v.amount::text,'paid_cents',v.paid::text) item
      from ev v where v.grp=p_group order by v.line limit p_limit offset (p_page-1)*p_limit) x)
  into v_summary,v_total,v_rows from ev;
  return jsonb_build_object('entity','cnab_return','record',jsonb_build_object('id',f.id,'profile_id',f.profile_id,'purpose',f.purpose,'generated_on',f.generated_on,'created_at',f.created_at,
      'filename','RETORNO_'||f.id::text||'.RET','bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'number',erp_cnab.return_number(f),
      'excludable',not erp_cnab.return_applied(f.id)),
    'summary',v_summary,'group',p_group,'page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $function$;

-- "Excluir selecionados": the same locks as the vinculação, the baixa (lock_operational_event) and the revisão of an ocorrência
-- (the global operational lock, the profile, then the file), so an occurrence applied concurrently is always seen.
CREATE OR REPLACE FUNCTION public.erp_cnab_return_exclude(p_user_id uuid, p_command_id uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_replay jsonb; f erp_cnab.return_file; v_result jsonb; v_hash text; v_id uuid; v_profile uuid;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['id']);
  v_id:=erp_finance.uuid_value(p_data->'id');
  v_replay:=erp_cnab.start_command(p_user_id,p_command_id,'return_exclude',p_data);
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(174852920,1);
  select profile_id into v_profile from erp_cnab.return_file where id=v_id;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  perform 1 from erp_cnab.profile where id=v_profile for update;
  select * into f from erp_cnab.return_file where id=v_id for update;
  if exists(select 1 from erp_cnab.return_exclusion x where x.file_id=f.id) then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if erp_cnab.return_applied(f.id) then raise exception 'erp_cnab_return_applied' using errcode='40001'; end if;
  insert into erp_cnab.return_exclusion(file_id,actor,command_id) values(f.id,p_user_id,p_command_id);
  perform erp_cnab.access(p_user_id,true);
  v_result:=jsonb_build_object('entity','cnab_return_exclusion','record',jsonb_build_object('id',f.id,'excluded',true),'data_mode','erp_native','replayed',false);
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','return_exclude','data',p_data)::text,'UTF8')),'hex');
  insert into erp_cnab.command values(p_command_id,p_user_id,v_hash,v_result,clock_timestamp());
  insert into erp_cnab.audit(actor,command_id,action,record_id) values(p_user_id,p_command_id,'return_exclude',f.id);
  return v_result;
end $function$;

-- 043/058 plus: an ocorrência of a retorno excluído (213) is never bound nor settled; checked under the global operational lock,
-- which the exclusion also takes.
CREATE OR REPLACE FUNCTION erp_cnab.lock_operational_event(p_event uuid, p_file uuid, p_line integer, p_approval integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$declare pid uuid;bill uuid;tid uuid;aid uuid;begin
 select profile_id,billing_title_id into pid,bill from erp_cnab.return_event where id=p_event and purpose='operational';if not found then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(174852920,1);select account_id into aid from erp_cnab.profile where id=pid for update;
 if exists(select 1 from erp_cnab.return_exclusion x where x.file_id=p_file)then raise exception 'erp_cnab_return_excluded'using errcode='40001';end if;
 perform 1 from erp_cnab.return_event where id=p_event for update;select title_id into tid from erp_cnab.billing_title where id=bill for update;
 perform 1 from erp_finance.title where id=tid for update;perform 1 from erp_finance.account where id=aid for update;
 perform erp_cnab.require_return_operational(pid,p_approval,bill);if not exists(select 1 from erp_cnab.return_occurrence where event_id=p_event and file_id=p_file and line=p_line)then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;return pid;
end $function$;

-- Remessas (213) with the permission of the screen.
CREATE OR REPLACE FUNCTION public.erp_cnab_remittance_page(p_user_id uuid, p_query text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_page integer DEFAULT 1, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_rows jsonb;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_finance.require_permission(p_user_id,'financas.remessas');
  perform erp_cnab.list_query(p_query);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or p_from>p_to
    or (p_from is not null and (p_from<date '1900-01-01' or p_from>date '2100-12-31')) or (p_to is not null and (p_to<date '1900-01-01' or p_to>date '2100-12-31')) then
    raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with base as materialized (
    select r.*,erp_cnab.remittance_filename(r) filename,p.identity->>'bank' bank,
      (select count(*) from erp_cnab.billing_title b where b.remittance_id=r.id) titles,
      (select coalesce(sum((b.snapshot#>>'{title,amountCents}')::bigint),0) from erp_cnab.billing_title b where b.remittance_id=r.id) total_cents
    from erp_cnab.remittance r join erp_cnab.profile p on p.id=r.profile_id
    where (p_from is null or r.generated_on>=p_from) and (p_to is null or r.generated_on<=p_to)
  ), filtered as materialized (
    select * from base where v_query is null or strpos(lower(filename),v_query)>0 or strpos(sequence::text,ltrim(v_query,'0'))>0 and ltrim(v_query,'0')<>''
  ), page as (select * from filtered order by generated_on desc,sequence desc,id limit p_limit offset (p_page-1)*p_limit)
  select (select count(*) from filtered),(select coalesce(jsonb_agg(jsonb_build_object('id',id,'profile_id',profile_id,'purpose',purpose,'state',state,'sequence',sequence::text,
      'generated_on',generated_on,'created_at',created_at,'filename',filename,'bank',bank,'bank_name',erp_cnab.bank_label(bank),'titles',titles,'total_cents',total_cents::text,
      'file_hash',file_hash,'byte_size',byte_size,'encoding_profile',snapshot->'encoding_profile','excludable',state='reserved' and object_path is null)
      order by generated_on desc,sequence desc,id),'[]'::jsonb) from page)
  into v_total,v_rows;
  return jsonb_build_object('entity','cnab_remittances','page',p_page,'limit',p_limit,'total',v_total,'items',v_rows,'data_mode','erp_native');
end $function$;
CREATE OR REPLACE FUNCTION public.erp_cnab_remittance_detail(p_user_id uuid, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare r erp_cnab.remittance; p erp_cnab.profile; v_rows jsonb; v_count bigint; v_total bigint;
begin
  perform erp_cnab.access(p_user_id);
  perform erp_finance.require_permission(p_user_id,'financas.remessas');
  select * into r from erp_cnab.remittance where id=p_id;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select * into p from erp_cnab.profile where id=r.profile_id;
  select count(*),coalesce(sum((b.snapshot#>>'{title,amountCents}')::bigint),0) into v_count,v_total from erp_cnab.billing_title b where b.remittance_id=r.id;
  select coalesce(jsonb_agg(x.item order by x.due_on,x.document_number,x.id),'[]'::jsonb) into v_rows from (
    select b.id,b.document_number,(b.snapshot#>>'{title,dueOn}')::date due_on,jsonb_build_object('billing_title_id',b.id,'title_id',b.title_id,'contact_name',left(coalesce(b.snapshot#>>'{title,payer,name}',c.name),200),
      'our_number',b.our_number,'document_number',b.document_number,'issued_on',b.snapshot#>>'{title,issuedOn}','due_on',b.snapshot#>>'{title,dueOn}','description',t.description,
      'amount_cents',b.snapshot#>>'{title,amountCents}') item
    from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id join erp_catalog.record c on c.id=t.contact_id where b.remittance_id=r.id
    order by (b.snapshot#>>'{title,dueOn}')::date,b.document_number,b.id limit 500) x;
  return jsonb_build_object('entity','cnab_remittance','record',jsonb_build_object('id',r.id,'profile_id',r.profile_id,'purpose',r.purpose,'state',r.state,'sequence',r.sequence::text,
      'generated_on',r.generated_on,'created_at',r.created_at,'filename',erp_cnab.remittance_filename(r),'file_hash',r.file_hash,'byte_size',r.byte_size,'encoding_profile',r.snapshot->'encoding_profile',
      'bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'excludable',r.state='reserved' and r.object_path is null),
    'account',jsonb_build_object('bank',p.identity->>'bank','bank_name',erp_cnab.bank_label(p.identity->>'bank'),'agency',p.identity->>'agency','account',p.identity->>'account',
      'account_digit',p.identity->>'accountDigit','wallet',p.identity->>'wallet','name',(select a.name from erp_finance.account a where a.id=p.account_id)),
    'titles',v_rows,'titles_total',v_count,'total_cents',v_total::text,'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Relatórios: atrasadas até hoje e permissões
CREATE OR REPLACE FUNCTION public.erp_finance_report(p_user_id uuid,p_report text,p_from date,p_to date,p_account uuid default null,p_group text default 'month',
  p_page integer default 1,p_limit integer default 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_accounts uuid[]; v_rows jsonb; v_summary jsonb; v_total bigint:=0; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_start bigint;
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_report is null or p_report not in ('cash_flow','forecast','categories','contacts') or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_from>p_to or p_group is null or p_group not in ('day','month')
    or (p_group='day' and p_to-p_from>366) or p_to-p_from>3660 or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  -- 246: Caixas e Bancos > Fluxo, Resumo por categoria and Resumo por cliente (Sistema > Usuários > Permissões).
  perform erp_finance.require_permission(p_user_id,case p_report when 'categories' then 'financas.caixas_bancos.resumo_categoria'
    when 'contacts' then 'financas.caixas_bancos.resumo_cliente' else 'financas.caixas_bancos.fluxo' end);
  if p_account is not null and not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into v_accounts from erp_finance.account where deleted_at is null and (p_account is null or id=p_account);

  if p_report='cash_flow' then
    -- Realizado: the movements of the period. With every conta, transfers between them are internal and stay out of Entradas/Saídas;
    -- the saldo of each day or month is always the whole ledger up to that day. A saldo inicial of the period joins the Saldo anterior.
    with b as (select * from erp_finance.report_buckets(p_from,p_to,p_group)),
      m as materialized (select x.posted_on,x.delta_cents from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on between p_from and p_to
        and x.kind<>'opening' and (p_account is not null or x.transfer_id is null)),
      r as (select b.start_on,b.end_on,coalesce((select sum(delta_cents) from m where m.posted_on between b.start_on and b.end_on and delta_cents>0),0) in_cents,
        coalesce((select sum(-delta_cents) from m where m.posted_on between b.start_on and b.end_on and delta_cents<0),0) out_cents,
        (select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<=b.end_on) balance_cents from b)
    select coalesce(jsonb_agg(jsonb_build_object('start_on',start_on,'end_on',end_on,'in_cents',in_cents::text,'out_cents',out_cents::text,'net_cents',(in_cents-out_cents)::text,
        'balance_cents',balance_cents::text) order by start_on),'[]'::jsonb),count(*),
      jsonb_build_object('previous_cents',((select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<p_from)
          +(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.kind='opening' and x.posted_on between p_from and p_to))::text,
        'in_cents',coalesce(sum(in_cents),0)::text,'out_cents',coalesce(sum(out_cents),0)::text,'net_cents',coalesce(sum(in_cents-out_cents),0)::text,
        'closing_cents',(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts) and x.posted_on<=p_to)::text)
    into v_rows,v_total,v_summary from r;

  elsif p_report='forecast' then
    -- Previsto: contas em aberto (not cancelled or excluded) by vencimento in the period, over the saldo atual of the contas; with a
    -- conta financeira, only the contas of that portador. 246: Atrasadas are the contas em aberto vencidas antes de hoje (São Paulo),
    -- whatever the period, shown apart.
    v_start:=(select coalesce(sum(x.delta_cents),0) from erp_finance.movement x where x.account_id=any(v_accounts));
    with o as materialized (select t.kind,t.due_on,t.amount_cents-t.settled_cents balance from erp_finance.title t
        where not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents and (p_account is null or t.account_id=p_account) and t.due_on<=greatest(p_to,v_today)),
      b as (select * from erp_finance.report_buckets(p_from,p_to,p_group)),
      r as (select b.start_on,b.end_on,coalesce((select sum(balance) from o where o.kind='receivable' and o.due_on between b.start_on and b.end_on),0) receivable_cents,
        coalesce((select sum(balance) from o where o.kind='payable' and o.due_on between b.start_on and b.end_on),0) payable_cents from b),
      c as (select r.*,v_start+sum(receivable_cents-payable_cents) over (order by start_on) balance_cents from r)
    select coalesce(jsonb_agg(jsonb_build_object('start_on',start_on,'end_on',end_on,'receivable_cents',receivable_cents::text,'payable_cents',payable_cents::text,
        'net_cents',(receivable_cents-payable_cents)::text,'balance_cents',balance_cents::text) order by start_on),'[]'::jsonb),count(*),
      jsonb_build_object('current_cents',v_start::text,'receivable_cents',coalesce(sum(receivable_cents),0)::text,'payable_cents',coalesce(sum(payable_cents),0)::text,
        'net_cents',coalesce(sum(receivable_cents-payable_cents),0)::text,'projected_cents',(v_start+coalesce(sum(receivable_cents-payable_cents),0))::text,
        'overdue_receivable_cents',(select coalesce(sum(balance),0) from o where o.kind='receivable' and o.due_on<v_today)::text,
        'overdue_payable_cents',(select coalesce(sum(balance),0) from o where o.kind='payable' and o.due_on<v_today)::text,'today',v_today)
    into v_rows,v_total,v_summary from c;

  elsif p_report='categories' then
    with parts as materialized (select * from erp_finance.report_settlement_parts(v_accounts,p_from,p_to) union all select * from erp_finance.report_entry_parts(v_accounts,p_from,p_to)),
      g as materialized (select p.category_id,sum(p.amount_cents) amount_cents from parts p group by p.category_id),
      n as materialized (select g.*,c.name,c.kind,(select x.name from erp_finance.category x where x.id=c.parent_id) parent_name,c.deleted_at is not null deleted from g left join erp_finance.category c on c.id=g.category_id),
      pg as (select * from n order by case n.kind when 'receivable' then 0 when 'payable' then 1 else 2 end,lower(coalesce(n.parent_name,n.name,'')),n.parent_name is not null,lower(coalesce(n.name,'')),n.category_id nulls last
        limit p_limit offset (p_page-1)*p_limit)
    select (select count(*) from n),
      (select coalesce(jsonb_agg(jsonb_build_object('category_id',category_id,'name',left(name,200),'parent_name',left(parent_name,200),'kind',kind,'deleted',coalesce(deleted,false),'amount_cents',amount_cents::text)
        order by case kind when 'receivable' then 0 when 'payable' then 1 else 2 end,lower(coalesce(parent_name,name,'')),parent_name is not null,lower(coalesce(name,'')),category_id nulls last),'[]'::jsonb) from pg),
      jsonb_build_object('in_cents',(select coalesce(sum(amount_cents),0) from g where amount_cents>0)::text,'out_cents',(select coalesce(sum(-amount_cents),0) from g where amount_cents<0)::text,
        'net_cents',(select coalesce(sum(amount_cents),0) from g)::text)
    into v_total,v_rows,v_summary;

  else
    -- Por cliente/fornecedor: the cash of the baixas (and estornos) of its contas and of the lançamentos de caixa with that contato.
    with flows as materialized (
        select t.contact_id,t.kind,case when s.kind='reversal' then -s.net_cash_cents else s.net_cash_cents end amount_cents
        from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id where s.account_id=any(v_accounts) and s.posted_on between p_from and p_to
        union all select e.contact_id,case when e.kind='in' then 'receivable' else 'payable' end,e.amount_cents
        from erp_finance.cash_entry e where e.contact_id is not null and e.deleted_at is null and e.account_id=any(v_accounts) and e.posted_on between p_from and p_to),
      g as materialized (select f.contact_id,coalesce(sum(f.amount_cents) filter (where f.kind='receivable'),0) received_cents,coalesce(sum(f.amount_cents) filter (where f.kind='payable'),0) paid_cents
        from flows f group by f.contact_id),
      n as materialized (select g.*,r.name from g join erp_catalog.record r on r.id=g.contact_id),
      pg as (select * from n order by lower(n.name),n.contact_id limit p_limit offset (p_page-1)*p_limit)
    select (select count(*) from n),
      (select coalesce(jsonb_agg(jsonb_build_object('contact_id',contact_id,'name',left(name,200),'received_cents',received_cents::text,'paid_cents',paid_cents::text,'net_cents',(received_cents-paid_cents)::text)
        order by lower(name),contact_id),'[]'::jsonb) from pg),
      jsonb_build_object('received_cents',(select coalesce(sum(received_cents),0) from g)::text,'paid_cents',(select coalesce(sum(paid_cents),0) from g)::text,
        'net_cents',(select coalesce(sum(received_cents-paid_cents),0) from g)::text)
    into v_total,v_rows,v_summary;
  end if;

  return jsonb_build_object('entity','finance_report','report',p_report,'from',p_from,'to',p_to,'account_id',p_account,'group',p_group,
    'page',case when p_report in ('categories','contacts') then p_page else 1 end,'limit',p_limit,'total',v_total,'items',v_rows,'summary',v_summary,'data_mode','erp_native');
end $function$;

-- ---------------------------------------------------------------- Extrato: Situação "Cancelados" e a permissão da tela
-- A baixa estornada and its estorno are both "Cancelados" (a subset of Registrados: the ledger keeps both movements, so the
-- saldos stay the same). Cash entries and transfers are undone by exclusion (Excluídos).
create function erp_finance.statement_line_cancelled(p_kind text,p_line uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select p_kind='settlement' and exists(select 1 from erp_finance.movement m join erp_finance.settlement s on s.id=m.settlement_id
    where m.id=p_line and (s.kind='reversal' or exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id)));
$$;
drop function public.erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text);
create function public.erp_finance_statement_page(p_user_id uuid,p_account uuid default null,p_from date default null,p_to date default null,
  p_tab text default 'all',p_deleted boolean default false,p_categories text[] default null,p_amount_cents bigint default null,p_query text default null,
  p_order text default 'asc',p_page integer default 1,p_limit integer default 100,p_reconciliation text default null,p_cancelled boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_categories uuid[]; v_none boolean:=false; v_total bigint; v_items jsonb; v_days jsonb; v_summary jsonb; v_accounts uuid[];
begin
  perform erp_finance.require_access(p_user_id,false);
  if p_tab is null or p_tab not in ('all','in','out') or p_deleted is null or p_order is null or p_order not in ('asc','desc') or p_page is null or p_page not between 1 and 100000
    or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' or p_amount_cents not between 1 and 999999999999999
    or p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_from>p_to or p_to-p_from>3660
    or (p_reconciliation is not null and (p_reconciliation not in ('reconciled','unreconciled') or p_deleted))
    or p_cancelled is null or (p_cancelled and p_deleted)
    or (p_categories is not null and (array_ndims(p_categories) is distinct from 1 or cardinality(p_categories) not between 1 and 200 or array_position(p_categories,null) is not null
      or exists(select 1 from unnest(p_categories) c where c<>'none' and c!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  perform erp_finance.require_permission(p_user_id,'financas.caixas_bancos');
  if p_account is not null and not exists(select 1 from erp_finance.account where id=p_account and deleted_at is null) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if p_categories is not null then v_none:='none'=any(p_categories); select array_agg(c::uuid) into v_categories from unnest(p_categories) c where c<>'none'; end if;
  select array_agg(id) into v_accounts from erp_finance.account where deleted_at is null and (p_account is null or id=p_account);
  with lines as materialized (
    select l.* from erp_finance.statement_lines(p_account,p_from,p_to,p_deleted) l where l.account_id=any(v_accounts)
      and (not p_cancelled or erp_finance.statement_line_cancelled(l.line_kind,l.line_id))
  ), filtered as materialized (
    select l.* from lines l
    where (p_tab='all' or (p_tab='in' and l.amount_cents>0) or (p_tab='out' and l.amount_cents<0))
      and (p_amount_cents is null or abs(l.amount_cents)=p_amount_cents)
      and (p_categories is null or (v_none and l.category_id is null) or l.category_id=any(v_categories))
      and (v_query is null or strpos(lower(concat_ws(' ',l.note,(select name from erp_catalog.record r where r.id=l.contact_id))),v_query)>0)
      and (p_reconciliation is null or erp_finance.line_reconciled(l.line_kind,l.line_id)=(p_reconciliation='reconciled'))
  ), page as (
    select * from filtered order by case when p_order='asc' then posted_on end asc, case when p_order='desc' then posted_on end desc,
      case when p_order='asc' then created_at end asc, case when p_order='desc' then created_at end desc, line_id
    limit p_limit offset (p_page-1)*p_limit
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(erp_finance.statement_line_dto(row(p.line_id,p.line_kind,p.posted_on,p.created_at,p.account_id,p.amount_cents,p.category_id,p.contact_id,p.note,
      p.title_id,p.title_kind,p.transfer_id,p.entry_id,p.entry_version,p.entry_origin,p.competence_on)::erp_finance.statement_line) order by case when p_order='asc' then p.posted_on end asc, case when p_order='desc' then p.posted_on end desc,
      case when p_order='asc' then p.created_at end asc, case when p_order='desc' then p.created_at end desc, p.line_id),'[]'::jsonb) from page p),
    (select coalesce(jsonb_object_agg(d.on_day::text,(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=d.on_day)::text),'{}'::jsonb)
      from (select distinct posted_on as on_day from page) d),
    (select jsonb_build_object('before_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)::text,
      'previous_cents',((select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<p_from)
        +(select coalesce(sum(amount_cents),0) from lines where line_kind='opening' and not p_deleted))::text,
      'in_cents',(select coalesce(sum(amount_cents),0) from lines where amount_cents>0 and line_kind<>'opening' and not p_deleted)::text,
      'out_cents',(select coalesce(sum(-amount_cents),0) from lines where amount_cents<0 and line_kind<>'opening' and not p_deleted)::text,
      'closing_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts) and m.posted_on<=p_to)::text,
      'current_cents',(select coalesce(sum(m.delta_cents),0) from erp_finance.movement m where m.account_id=any(v_accounts))::text,
      'reconciled_lines',(select count(*) from lines l where erp_finance.line_reconciled(l.line_kind,l.line_id))))
  into v_total,v_items,v_days,v_summary;
  return jsonb_build_object('entity','statement','account_id',p_account,'from',p_from,'to',p_to,'tab',p_tab,'deleted',p_deleted,'cancelled',p_cancelled,'order',p_order,'page',p_page,'limit',p_limit,
    'reconciliation',p_reconciliation,'total',v_total,'items',v_items,'day_balances',case when p_deleted or p_cancelled then '{}'::jsonb else v_days end,'summary',v_summary,'data_mode','erp_native');
end $$;

revoke all on function erp_finance.require_permission(uuid,text),erp_finance.permission_key(text,jsonb),erp_finance.audit_permission(),erp_cnab.permission_key(text),erp_cnab.audit_permission(),
  erp_finance.title_inherited_seller(uuid),erp_finance.title_seller(uuid),erp_finance.dto(text,uuid),erp_cnab.return_number(erp_cnab.return_file),
  erp_cnab.lock_operational_event(uuid,uuid,integer,integer),erp_finance.statement_line_cancelled(text,uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_access(uuid)','erp_finance_title_execute(uuid,uuid,text,jsonb)',
    'erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text,text,uuid,uuid)',
    'erp_cnab_return_page(uuid,text,date,date,integer,integer)','erp_cnab_return_detail(uuid,uuid,text,integer,integer)','erp_cnab_return_exclude(uuid,uuid,jsonb)',
    'erp_cnab_remittance_page(uuid,text,date,date,integer,integer)','erp_cnab_remittance_detail(uuid,uuid)',
    'erp_finance_report(uuid,text,date,date,uuid,text,integer,integer)',
    'erp_finance_statement_page(uuid,uuid,date,date,text,boolean,text[],bigint,text,text,integer,integer,text,boolean)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
