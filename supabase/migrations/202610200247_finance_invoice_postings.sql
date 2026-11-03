-- 247: contas lançadas pelas notas fiscais do Brufap (lane financeiro, pedidos das frentes de notas e de documentos).
-- * ⋮ Lançar contas / Estornar contas da nota (NF-e e NFC-e de saída: contas a receber; nota de entrada: contas a pagar pelas
--   duplicatas): prévia por hash com as parcelas da nota (sem parcelas, uma à vista na emissão), a Categoria e o Destino (conta
--   financeira) escolhidos na prévia, um comando idempotente, auditoria e um efeito só: a nota cujo pedido de origem já lançou
--   contas (letra V) não lança, e o pedido cuja nota lançou contas também não. Nota cancelada ou denegada não lança contas.
-- * Enquanto a nota tem contas lançadas (ou está num Faturamento agrupado), as parcelas, o total e o destinatário da nota não mudam
--   e a nota não é excluída; as contas da nota mantêm cliente, emissão e valor e só são canceladas pelo Estornar contas.
-- * Preferências > Notas Fiscais > Configurações de NF-e "Automação lançamento de contas pagar ao criar NF de Entrada": ao gravar
--   uma nota de entrada nova, as contas a pagar são lançadas na mesma transação, com o perfil de quem grava (administrador ou
--   financeiro); qualquer recusa deixa a nota gravada sem contas.
-- * Faturamento agrupado com as NF-e de saída do Brufap ("Nota Fiscal nº", "N Nota(s) Fiscal(is)"), ao lado dos pedidos de venda.
-- * A conta mostra "Nota fiscal de origem", herda o vendedor da nota, o extrato mostra a letra N e a Ficha financeira a origem.
-- Nada aqui emite, transmite ou altera a nota fiscal (as travas 022/041/046/064 não mudam). Requer 112, 174, 215, 219 e 246.
begin;

do $$ declare r record; begin
  if to_regclass('erp_fiscal_invoices.invoice') is null or to_regprocedure('erp_finance.title_inherited_seller(uuid)') is null then
    raise exception 'finance_invoice_247_requires_112_246' using errcode='55000'; end if;
  if not exists(select 1 from pg_attribute where attrelid='erp_fiscal_invoices.invoice'::regclass and attname='seller_id' and not attisdropped) then
    raise exception 'finance_invoice_247_requires_215' using errcode='55000'; end if;
  for r in select * from (values
    ('erp_finance.title_origin(uuid)','772ee60e22705dad350ed850adbfa2e236b29684cc6a7a1cb8f4a9b570da3b55'),
    ('erp_finance.dto(text,uuid)','2280d9c6226a0d285289c7a0020c809d9a89aa10e482d6b1f15ee494e958f977'),
    ('erp_finance.title_inherited_seller(uuid)','4d94022ce8333bb0b4fcbcf02c331645fa36251fa62219883895048f637e4061'),
    ('erp_finance.document_preview_data(erp_documents.document,uuid,jsonb)','12984267286dc9bbe0293fa7834283944a5dc1d2f95e56b8d0a143c8a92dc900'),
    ('erp_finance.grouped_billing_eligible(erp_documents.document)','1052b9f9512532b71b8f22b37cd5a16425ccd3136ca0c88d75672871ee5d9de3'),
    ('public.erp_finance_grouped_billing_candidates(uuid,date,date,uuid[],text,integer,integer)','21472525fbff4fbd1a92ad14a8b24b927956139ffaa23c253bad828128fe71e3'),
    ('public.erp_finance_grouped_billing_documents(uuid,uuid,date,date,uuid[])','4ec9db731070354044712cf88c7b2738932d7f5872c889a69378b51a4cc14fe1'),
    ('erp_finance.grouped_billing_view(uuid)','99f0dc65f37b35183f6f3fca4d71381b00df16fa9b1698bbb536e64dc444f376'),
    ('public.erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)','48788a86a60baf246b07234ade94b3fccaf699584c6354fd7c7c5472858b0671'),
    ('erp_finance.statement_line_dto(erp_finance.statement_line)','7ef3b759b31d81a2d9f86ef27e75cb333aa06bbdbffabd2bc5528d0520285a85'),
    ('public.erp_finance_contact_ledger_page(uuid,uuid,text,date,date,integer,integer)','adc780b8fed8eeee83065926eddd0d6885ea49a38177cae774b9f37ba6d025b1')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_invoice_247_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Lançamentos da nota
create table erp_finance.invoice_posting (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
  invoice_version integer not null check(invoice_version>0),
  group_id uuid not null unique,
  state text not null default 'active' check(state in ('active','reversed')),
  version integer not null default 1 check(version>0),
  origin text not null default 'manual' check(origin in ('manual','automatic')),
  snapshot jsonb not null, preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
  actor uuid not null references auth.users(id), command_id uuid not null unique,
  created_at timestamptz not null default clock_timestamp(),
  reversed_at timestamptz, reversed_by uuid references auth.users(id), reason text,
  check((state='active' and reversed_at is null and reversed_by is null and reason is null)
    or (state='reversed' and reversed_at is not null and reversed_by is not null and length(reason) between 3 and 1000))
);
create unique index erp_finance_invoice_one_active on erp_finance.invoice_posting(invoice_id) where state='active';
create index erp_finance_invoice_posting_history on erp_finance.invoice_posting(invoice_id,created_at,id);
create table erp_finance.invoice_title (
  title_id uuid primary key references erp_finance.title(id),
  posting_id uuid not null references erp_finance.invoice_posting(id),
  position integer not null check(position between 1 and 120), unique(posting_id,position)
);
-- Faturamento agrupado das NF-e de saída (174 tinha só os pedidos de venda).
create table erp_finance.grouped_billing_invoice (
  billing_id uuid not null references erp_finance.grouped_billing(id),
  invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
  total_cents bigint not null check(total_cents between 1 and 999999999999999),
  active boolean not null default true,
  primary key(billing_id,invoice_id)
);
create unique index erp_finance_grouped_billing_invoice_one_active on erp_finance.grouped_billing_invoice(invoice_id) where active;
do $$ declare t text; begin foreach t in array array['invoice_posting','invoice_title','grouped_billing_invoice'] loop
  execute format('alter table erp_finance.%I enable row level security',t);
  execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

-- What the contas of a note use from it.
create function erp_finance.invoice_kind(p_direction text) returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_direction='0' then 'payable' else 'receivable' end;
$$;
create function erp_finance.invoice_label(p_model text,p_number integer) returns text language sql immutable set search_path=pg_catalog as $$
  select case when p_model='65' then 'NFC-e' else 'Nota fiscal' end||' nº '||coalesce(p_number::text,'(sem número)');
$$;
create function erp_finance.invoice_total_cents(p_totals jsonb) returns bigint language sql immutable set search_path=pg_catalog as $$
  select case when p_totals->>'total'~'^[0-9]{1,13}(\.[0-9]{1,2})?$' then round((p_totals->>'total')::numeric*100)::bigint end;
$$;
create function erp_finance.invoice_contact(p_recipient jsonb) returns uuid language sql immutable set search_path=pg_catalog as $$
  select case when p_recipient->>'contact_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_recipient->>'contact_id')::uuid end;
$$;
-- Origin pedidos (V/O) whose contas are already lançadas or faturadas em grupo: the effect is theirs.
create function erp_finance.invoice_orders_posted(p_invoice uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text) order by d.number),'[]'::jsonb)
  from erp_fiscal_invoices.invoice_order o join erp_documents.document d on d.id=o.document_id
  where o.invoice_id=p_invoice and (exists(select 1 from erp_finance.document_posting p where p.document_id=d.id and p.state='active')
    or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=d.id and g.active));
$$;
create function erp_finance.invoice_effect_active(p_invoice uuid) returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from erp_finance.invoice_posting p where p.invoice_id=p_invoice and p.state='active')
    or exists(select 1 from erp_finance.grouped_billing_invoice g where g.invoice_id=p_invoice and g.active);
$$;
-- Why Lançar contas is not possible now (null: it is), in the order the screen explains it.
create function erp_finance.invoice_blocked_reason(v erp_fiscal_invoices.invoice) returns text language sql stable set search_path=pg_catalog as $$
  select case when exists(select 1 from erp_finance.invoice_posting p where p.invoice_id=v.id and p.state='active') then 'erp_finance_invoice_already_posted'
    when exists(select 1 from erp_finance.grouped_billing_invoice g where g.invoice_id=v.id and g.active) then 'erp_finance_invoice_grouped'
    when v.deleted_at is not null then 'erp_finance_invoice_deleted'
    when v.status in (3,10) then 'erp_finance_invoice_ineligible_state'
    when jsonb_array_length(erp_finance.invoice_orders_posted(v.id))>0 then 'erp_finance_invoice_order_posted'
    when erp_finance.invoice_contact(v.recipient) is null then 'erp_finance_invalid_contact'
    when coalesce(erp_finance.invoice_total_cents(v.totals),0)<=0 then 'erp_finance_invoice_zero_total' end;
$$;

create function erp_finance.invoice_posting_summary(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',p.id,'invoice_id',p.invoice_id,'source_invoice_version',p.invoice_version,'group_id',p.group_id,'state',p.state,'version',p.version,'origin',p.origin,
    'direction',p.snapshot->>'direction','model',p.snapshot->>'model','number',p.snapshot->>'number','total_cents',p.snapshot->>'total_cents',
    'installments',jsonb_array_length(p.snapshot->'installments'),'category_id',p.snapshot->>'category_id','created_at',p.created_at,'reversed_at',p.reversed_at,'reason',p.reason)
  from erp_finance.invoice_posting p where p.id=p_id;
$$;
create function erp_finance.invoice_title_rows(p_posting uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'position',l.position,'version',t.version,'due_on',t.due_on,'amount_cents',t.amount_cents::text,
    'settled_cents',t.settled_cents::text,'balance_cents',(t.amount_cents-t.settled_cents)::text,'cancelled',t.cancelled,'category_id',t.category_id,'account_id',t.account_id,
    'payment_method_id',t.payment_method_id,'description',t.description,'cnab_linked',exists(select 1 from erp_cnab.billing_title b where b.title_id=t.id)) order by l.position),'[]'::jsonb)
  from erp_finance.invoice_title l join erp_finance.title t on t.id=l.title_id where l.posting_id=p_posting;
$$;

-- Prévia: the parcelas of the note (or one à vista on the emissão), the Categoria (chosen, else the padrão of Vendas/Compras) and
-- the Destino (the conta financeira chosen, else the one of the forma de pagamento of each parcela).
create function erp_finance.invoice_preview_data(v erp_fiscal_invoices.invoice,p_category uuid,p_account uuid)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_kind text:=erp_finance.invoice_kind(v.direction); v_reason text:=erp_finance.invoice_blocked_reason(v); c erp_catalog.record; g erp_finance.category; a erp_finance.account;
  v_total bigint; v_parts jsonb:='[]'::jsonb; v_part jsonb; v_amount bigint; v_due date; v_sum bigint:=0; n integer:=0; v_method erp_catalog.payment_method; v_account uuid; v_seller uuid; r jsonb;
begin
  if v_reason is not null then
    raise exception '%',v_reason using errcode=case when v_reason in ('erp_finance_invalid_contact','erp_finance_invoice_zero_total') then '22023' else '40001' end; end if;
  select r0.* into c from erp_catalog.record r0 join erp_catalog.contact x on x.record_id=r0.id where r0.id=erp_finance.invoice_contact(v.recipient) and r0.active;
  if not found then raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
  if p_category is not null then
    select * into g from erp_finance.category where id=p_category and active and deleted_at is null and kind in (v_kind,'both');
    if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
  else
    select x.* into g from erp_finance.category_default d join erp_finance.category x on x.id=d.category_id
      where d.key=case when v_kind='receivable' then 'sale' else 'purchase' end and x.active and x.deleted_at is null;
  end if;
  if p_account is not null then
    select * into a from erp_finance.account where id=p_account and active and deleted_at is null;
    if not found then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
  end if;
  v_total:=erp_finance.invoice_total_cents(v.totals);
  for v_part in select value from jsonb_array_elements(case when jsonb_array_length(coalesce(v.payment->'installments','[]'::jsonb))>0 then v.payment->'installments'
      else jsonb_build_array(jsonb_build_object('date',v.issue_date,'amount',to_char(v_total/100.0,'FM9999999999990.00'))) end) loop
    if v_part->>'amount'!~'^[0-9]{1,13}(\.[0-9]{1,2})?$' or v_part->>'date'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_finance_invoice_invalid_installment' using errcode='22023'; end if;
    v_amount:=round((v_part->>'amount')::numeric*100)::bigint; v_due:=(v_part->>'date')::date;
    if v_amount<=0 or v_due<v.issue_date or v_due>date '2100-12-31' then raise exception 'erp_finance_invoice_invalid_installment' using errcode='22023'; end if;
    v_method:=null;
    if v_part->>'payment_method_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_method from erp_catalog.payment_method where id=(v_part->>'payment_method_id')::uuid and deleted_at is null; end if;
    v_account:=coalesce(a.id,(select x.id from erp_finance.account x where x.id=v_method.account_id and x.active and x.deleted_at is null));
    n:=n+1; v_sum:=v_sum+v_amount;
    v_parts:=v_parts||jsonb_build_array(jsonb_build_object('position',n,'amount_cents',v_amount::text,'due_on',v_due,'method',v_part->>'method',
      'payment_method_id',v_method.id,'payment_method_name',left(v_method.description,100),'account_id',v_account,'account_name',(select left(x.name,200) from erp_finance.account x where x.id=v_account)));
  end loop;
  if n not between 1 and 120 or v_sum<>v_total then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
  if v_kind='receivable' then select s.id into v_seller from erp_catalog.seller s where s.id=v.seller_id; end if;
  r:=jsonb_build_object('invoice_id',v.id,'invoice_version',v.version,'model',v.model,'direction',v_kind,'series',v.series,'number',v.number::text,'status',v.status,
    'issued_on',v.issue_date,'contact_id',c.id,'contact_name',left(c.name,200),'contact_version',c.version,'total_cents',v_total::text,
    'category_id',g.id,'category_name',left(g.name,200),'account_id',a.id,'account_name',left(a.name,200),'seller_id',v_seller,'installments',v_parts);
  return r||jsonb_build_object('preview_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
end $$;

-- Lock order: the origin pedidos (as the 017 lançamento and the Faturamento agrupado take them), then the note. The links can only
-- change under the note lock (notas lane), so they are read again under it.
create function erp_finance.invoice_lock(p_invoice uuid) returns erp_fiscal_invoices.invoice language plpgsql set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; v_before uuid[]; v_after uuid[];
begin
  if p_invoice is null then raise exception 'erp_finance_invalid_id' using errcode='22023'; end if;
  select coalesce(array_agg(document_id order by document_id),'{}'::uuid[]) into v_before from erp_fiscal_invoices.invoice_order where invoice_id=p_invoice;
  perform 1 from erp_documents.document where id=any(v_before) order by id for share;
  select * into v from erp_fiscal_invoices.invoice where id=p_invoice for update;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select coalesce(array_agg(document_id order by document_id),'{}'::uuid[]) into v_after from erp_fiscal_invoices.invoice_order where invoice_id=p_invoice;
  if v_after is distinct from v_before then raise exception 'erp_finance_invoice_changed' using errcode='40001'; end if;
  return v;
end $$;

create function erp_finance.invoice_read_access(p_user uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_user and active;
  if v_role is null or v_role not in ('admin','financeiro','consulta','fiscal') then raise exception 'erp_finance_access_denied' using errcode='42501'; end if;
  return v_role;
end $$;

create function public.erp_finance_invoice_finance_get(p_user_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; v_role text:=erp_finance.invoice_read_access(p_user_id); v_active uuid; v_grouped jsonb;
begin
  if p_invoice_id is null then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select id into v_active from erp_finance.invoice_posting where invoice_id=v.id and state='active';
  select jsonb_build_object('id',b.id,'number',b.number::text) into v_grouped from erp_finance.grouped_billing_invoice g join erp_finance.grouped_billing b on b.id=g.billing_id where g.invoice_id=v.id and g.active;
  return jsonb_build_object('entity','invoice_finance',
    'invoice',jsonb_build_object('id',v.id,'version',v.version,'model',v.model,'direction',v.direction,'kind',erp_finance.invoice_kind(v.direction),'series',v.series,'number',v.number::text,
      'status',v.status,'issue_date',v.issue_date,'total_cents',coalesce(erp_finance.invoice_total_cents(v.totals),0)::text,'contact_id',erp_finance.invoice_contact(v.recipient),
      'contact_name',left(coalesce((select r.name from erp_catalog.record r where r.id=erp_finance.invoice_contact(v.recipient)),v.recipient->>'name'),200),'deleted',v.deleted_at is not null),
    'active_posting',case when v_active is not null then erp_finance.invoice_posting_summary(v_active) end,
    'titles',case when v_active is not null then erp_finance.invoice_title_rows(v_active) else '[]'::jsonb end,
    'grouped_billing',v_grouped,'orders_posted',erp_finance.invoice_orders_posted(v.id),'blocked_reason',erp_finance.invoice_blocked_reason(v),
    'postings',(select coalesce(jsonb_agg(erp_finance.invoice_posting_summary(x.id) order by x.created_at desc,x.id),'[]'::jsonb)
      from (select id,created_at from erp_finance.invoice_posting where invoice_id=v.id order by created_at desc,id limit 20) x),
    'writable',v_role in ('admin','financeiro'),'data_mode','erp_native','cash_movement_performed',false);
end $$;

create function public.erp_finance_invoice_finance_preview(p_user_id uuid,p_invoice_id uuid,p_expected_version integer,p_category_id uuid default null,p_account_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_invoice_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if v.version<>p_expected_version then raise exception 'erp_finance_invoice_version_conflict' using errcode='40001'; end if;
  return jsonb_build_object('preview',erp_finance.invoice_preview_data(v,p_category_id,p_account_id),'data_mode','erp_native','cash_movement_performed',false);
end $$;

-- Lançar contas (manual, or the automation of the entry note with p_origin 'automatic').
create function erp_finance.invoice_post(p_user_id uuid,p_command_id uuid,p_data jsonb,p_origin text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; v_replay jsonb; v_preview jsonb; v_pid uuid; v_gid uuid:=gen_random_uuid(); v_tid uuid; v_part jsonb; v_label text; v_result jsonb;
  v_category uuid; v_account uuid;
begin
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['invoice_id','expected_version','preview_hash','category_id','account_id']);
  v_replay:=erp_finance.document_command_start(p_user_id,p_command_id,'invoice_post',p_data);
  if v_replay is not null then return v_replay; end if;
  v_category:=erp_finance.uuid_value(p_data->'category_id',false); v_account:=erp_finance.uuid_value(p_data->'account_id',false);
  v:=erp_finance.invoice_lock(erp_finance.uuid_value(p_data->'invoice_id'));
  if v.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_invoice_version_conflict' using errcode='40001'; end if;
  v_preview:=erp_finance.invoice_preview_data(v,v_category,v_account);
  if jsonb_typeof(p_data->'preview_hash') is distinct from 'string' or p_data->>'preview_hash'<>v_preview->>'preview_hash' then
    raise exception 'erp_finance_invoice_preview_conflict' using errcode='40001'; end if;
  insert into erp_finance.invoice_posting(invoice_id,invoice_version,group_id,origin,snapshot,preview_hash,actor,command_id)
    values(v.id,v.version,v_gid,p_origin,v_preview-'preview_hash',v_preview->>'preview_hash',p_user_id,p_command_id) returning id into v_pid;
  v_label:=erp_finance.invoice_label(v.model,v.number);
  for v_part in select value from jsonb_array_elements(v_preview->'installments') loop
    insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
        competence_on,account_id,payment_method_id,original_due_on)
      values(v_gid,(v_part->>'position')::integer,jsonb_array_length(v_preview->'installments'),v_preview->>'direction',(v_preview->>'contact_id')::uuid,(v_preview->>'category_id')::uuid,
        v_label,v.number::text,v.issue_date,(v_part->>'due_on')::date,(v_part->>'amount_cents')::bigint,v.issue_date,(v_part->>'account_id')::uuid,(v_part->>'payment_method_id')::uuid,
        (v_part->>'due_on')::date) returning id into v_tid;
    insert into erp_finance.invoice_title(title_id,posting_id,position) values(v_tid,v_pid,(v_part->>'position')::integer);
  end loop;
  v_result:=jsonb_build_object('invoice_id',v.id,'invoice_version',v.version,'posting',erp_finance.invoice_posting_summary(v_pid),'titles',erp_finance.invoice_title_rows(v_pid));
  -- The audit checks Lançar contas of Notas fiscais / Notas de entrada (Sistema > Usuários > Permissões, 246).
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'invoice_post',null,v_result);
  return erp_finance.document_command_finish(p_user_id,p_command_id,'invoice_post',p_data,v_result);
end $$;
create function public.erp_finance_invoice_finance_post(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform erp_finance.require_access(p_user_id,true);
  return erp_finance.invoice_post(p_user_id,p_command_id,p_data,'manual');
end $$;

-- Estornar contas: only while no conta of the lançamento has an active baixa or a boleto, with the version of each conta (the rule of
-- the 017 estorno of the pedido, which the screen follows: a baixa already estornada leaves the conta em aberto).
create function public.erp_finance_invoice_finance_reverse(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; v_replay jsonb; p erp_finance.invoice_posting; v_expected jsonb; v_actual jsonb; v_part jsonb; v_note text; v_result jsonb; v_before jsonb;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  perform erp_finance.keys(p_data,array['invoice_id','posting_id','expected_version','titles','reason']);
  v_replay:=erp_finance.document_command_start(p_user_id,p_command_id,'invoice_reverse',p_data);
  if v_replay is not null then return v_replay; end if;
  select * into v from erp_fiscal_invoices.invoice where id=erp_finance.uuid_value(p_data->'invoice_id') for update;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  select * into p from erp_finance.invoice_posting where id=erp_finance.uuid_value(p_data->'posting_id') and invoice_id=v.id for update;
  if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  if p.state<>'active' or p.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_invoice_version_conflict' using errcode='40001'; end if;
  perform 1 from erp_finance.title t join erp_finance.invoice_title l on l.title_id=t.id where l.posting_id=p.id order by t.id for update of t;
  if exists(select 1 from erp_finance.title t join erp_finance.invoice_title l on l.title_id=t.id where l.posting_id=p.id and t.settled_cents<>0)
    or exists(select 1 from erp_cnab.billing_title b join erp_finance.invoice_title l on l.title_id=b.title_id where l.posting_id=p.id) then
    raise exception 'erp_finance_invoice_reverse_blocked' using errcode='40001'; end if;
  v_note:=erp_finance.txt(p_data,'reason',1000,true);
  if length(v_note)<3 then raise exception 'erp_finance_invoice_reason_required' using errcode='22023'; end if;
  if jsonb_typeof(p_data->'titles') is distinct from 'array' or jsonb_array_length(p_data->'titles') not between 1 and 120 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
  for v_part in select value from jsonb_array_elements(p_data->'titles') loop
    perform erp_finance.keys(v_part,array['id','version']); perform erp_finance.uuid_value(v_part->'id'); perform erp_finance.expected(v_part->'version'); end loop;
  select jsonb_agg(jsonb_build_object('id',lower(value->>'id'),'version',(value->>'version')::integer) order by lower(value->>'id')) into v_expected from jsonb_array_elements(p_data->'titles');
  select jsonb_agg(jsonb_build_object('id',t.id::text,'version',t.version) order by t.id::text) into v_actual from erp_finance.title t join erp_finance.invoice_title l on l.title_id=t.id where l.posting_id=p.id;
  if v_expected is distinct from v_actual then raise exception 'erp_finance_invoice_title_version_conflict' using errcode='40001'; end if;
  v_before:=jsonb_build_object('posting',erp_finance.invoice_posting_summary(p.id),'titles',erp_finance.invoice_title_rows(p.id));
  perform set_config('erp_finance.invoice_owner',p.id::text,true);
  update erp_finance.title t set cancelled=true,version=version+1,updated_at=clock_timestamp() from erp_finance.invoice_title l
    where l.title_id=t.id and l.posting_id=p.id and not t.cancelled;
  perform set_config('erp_finance.invoice_owner','',true);
  update erp_finance.invoice_posting set state='reversed',version=version+1,reversed_at=clock_timestamp(),reversed_by=p_user_id,reason=v_note where id=p.id;
  v_result:=jsonb_build_object('invoice_id',v.id,'invoice_version',v.version,'posting',erp_finance.invoice_posting_summary(p.id),'titles',erp_finance.invoice_title_rows(p.id));
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,'invoice_reverse',v_before,v_result);
  return erp_finance.document_command_finish(p_user_id,p_command_id,'invoice_reverse',p_data,v_result);
end $$;

-- Letra C (contas lançadas pela nota) and the Categoria of those contas, for a page of the lists of notes (up to 100).
create function public.erp_finance_invoice_finance_flags(p_user_id uuid,p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform erp_finance.invoice_read_access(p_user_id);
  if p_ids is null or array_ndims(p_ids) is distinct from 1 or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  return jsonb_build_object('entity','invoice_finance_flags','items',(select coalesce(jsonb_agg(jsonb_build_object('invoice_id',i.id,
      'posted',exists(select 1 from erp_finance.invoice_posting p where p.invoice_id=i.id and p.state='active'),
      'grouped',exists(select 1 from erp_finance.grouped_billing_invoice g where g.invoice_id=i.id and g.active),
      'category_ids',(select coalesce(jsonb_agg(distinct t.category_id) filter (where t.category_id is not null),'[]'::jsonb) from erp_finance.invoice_posting p
        join erp_finance.invoice_title l on l.posting_id=p.id join erp_finance.title t on t.id=l.title_id where p.invoice_id=i.id and p.state='active'))
    order by i.id),'[]'::jsonb) from erp_fiscal_invoices.invoice i where i.id=any(p_ids)),'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------- Travas
-- While a note has contas (or is in a Faturamento agrupado), what they were made from does not change.
create function erp_finance.guard_finance_invoice() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if erp_finance.invoice_effect_active(old.id) then
    if tg_op='DELETE' or (new.deleted_at is not null and old.deleted_at is null)
      or (new.payment,new.totals,erp_finance.invoice_contact(new.recipient),new.direction,new.model,new.issue_date)
        is distinct from (old.payment,old.totals,erp_finance.invoice_contact(old.recipient),old.direction,old.model,old.issue_date) then
      raise exception 'erp_fiscal_invoice_active_finance' using errcode='40001'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger finance_posted_invoice before update or delete on erp_fiscal_invoices.invoice for each row execute function erp_finance.guard_finance_invoice();
-- A pedido linked to a note never has its contas twice: checked when the transaction ends, once every link is written.
create function erp_finance.guard_invoice_order_effect() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=new.invoice_id and o.document_id=new.document_id)
    and erp_finance.invoice_effect_active(new.invoice_id)
    and (exists(select 1 from erp_finance.document_posting p where p.document_id=new.document_id and p.state='active')
      or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=new.document_id and g.active)) then
    raise exception 'erp_finance_invoice_order_posted' using errcode='40001'; end if;
  return null;
end $$;
create constraint trigger finance_invoice_order_effect after insert or update on erp_fiscal_invoices.invoice_order deferrable initially deferred
  for each row execute function erp_finance.guard_invoice_order_effect();
-- The contas of a note keep cliente, emissão, valor and parcela, and are cancelled only by its Estornar contas.
create function erp_finance.guard_invoice_title() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_posting uuid;
begin
  select posting_id into v_posting from erp_finance.invoice_title where title_id=old.id;
  if v_posting is not null then
    if tg_op='DELETE' then raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
    if (new.group_id,new.installment,new.installments,new.kind,new.contact_id,new.issued_on,new.amount_cents) is distinct from (old.group_id,old.installment,old.installments,old.kind,old.contact_id,old.issued_on,old.amount_cents) then
      raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
    if (new.cancelled,new.deleted_at is null) is distinct from (old.cancelled,old.deleted_at is null) and current_setting('erp_finance.invoice_owner',true) is distinct from v_posting::text then
      raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger protect_invoice_title before update or delete on erp_finance.title for each row execute function erp_finance.guard_invoice_title();

-- ---------------------------------------------------------------- Automação da NF de entrada
-- "Automação lançamento de contas pagar ao criar NF de Entrada": at the end of the transaction that created the entry note (items
-- and pedidos de compra already stored), with the profile of whoever created it. Any refusal keeps the note without contas.
create function erp_finance.invoice_auto_finance() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; v_preview jsonb;
begin
  if new.direction<>'0' or coalesce(erp_preferences.get('nfe.contas_pagar_entrada'),'false'::jsonb)<>'true'::jsonb then return null; end if;
  select * into v from erp_fiscal_invoices.invoice where id=new.id;
  if not found or v.deleted_at is not null or erp_finance.invoice_blocked_reason(v) is not null
    or not exists(select 1 from erp_access.membership m where m.user_id=v.created_by and m.active and m.role in ('admin','financeiro')) then return null; end if;
  begin
    v_preview:=erp_finance.invoice_preview_data(v,null,null);
    perform erp_finance.invoice_post(v.created_by,md5('invoice-auto-finance:'||v.id::text)::uuid,
      jsonb_build_object('invoice_id',v.id,'expected_version',v.version,'preview_hash',v_preview->>'preview_hash'),'automatic');
  -- The save of the note never fails because of the automation (as the preference says): any refusal keeps it without contas.
  exception when others then null;
  end;
  return null;
end $$;
create constraint trigger finance_invoice_auto_finance after insert on erp_fiscal_invoices.invoice deferrable initially deferred
  for each row execute function erp_finance.invoice_auto_finance();

-- ---------------------------------------------------------------- Pedidos: um efeito só
-- 174 plus: a pedido whose note already has contas (or is faturada em grupo) does not lançar contas again.
CREATE OR REPLACE FUNCTION erp_finance.document_preview_data(d erp_documents.document, p_category uuid, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare direction text;c erp_catalog.record;g erp_finance.category;issued date;total bigint;amount bigint;due date;part jsonb;parts jsonb:='[]';n integer:=0;sum_cents numeric:=0;source text;r jsonb;
 v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;v_dates text:='nao';v_base date;begin
 if not(case d.kind when 'sales_orders' then d.status in('verified','in_progress','partially_fulfilled','fulfilled')
  when 'purchase_orders' then d.status in('in_progress','partially_fulfilled','fulfilled')
  when 'service_orders' then d.status in('approved','in_progress','waiting_parts','service_done','finalized') else false end) then
  raise exception 'erp_document_finance_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_finance.document_posting where document_id=d.id and state='active')
  or exists(select 1 from erp_finance.grouped_billing_document x where x.document_id=d.id and x.active) then raise exception 'erp_document_finance_already_posted' using errcode='40001';end if;
 -- 247: the contas of the pedido were lançadas by its nota fiscal (letra C of the note).
 if exists(select 1 from erp_fiscal_invoices.invoice_order o where o.document_id=d.id and erp_finance.invoice_effect_active(o.invoice_id)) then
  raise exception 'erp_document_finance_invoice_posted' using errcode='40001';end if;
 direction:=case when d.kind='purchase_orders' then 'payable' else 'receivable' end;
 select r.* into c from erp_catalog.record r join erp_catalog.contact x on x.record_id=r.id where r.id=d.contact_id and r.active for share of r,x;
 if not found then raise exception 'erp_finance_invalid_contact' using errcode='22023';end if;
 if p_category is not null then select * into g from erp_finance.category where id=p_category and active and kind in(direction,'both') for share;
  if not found then raise exception 'erp_finance_invalid_category' using errcode='22023';end if;end if;
 issued:=erp_finance.day(d.body->'date');total:=(d.total*100)::bigint;
 -- Preferências > Serviços "Utilizar data atual no lançamento de contas de ordens de serviço" (174): the contas of an OS are
 -- lançadas today, with every parcela today (data_atual) or keeping its distance to the OS date (recalcular).
 if d.kind='service_orders' then v_dates:=coalesce(erp_preferences.get('os.data_contas')#>>'{}','nao'); end if;
 v_base:=issued;if v_dates in('data_atual','recalcular') then issued:=v_today;end if;
 if total<=0 then raise exception 'erp_document_finance_zero_total' using errcode='22023';end if;
 if jsonb_array_length(d.body->'installments')>0 then
  if p_plan is not null then raise exception 'erp_document_finance_saved_plan_required' using errcode='22023';end if;source:='document';
 else source:='explicit';if p_plan is null or jsonb_typeof(p_plan)<>'array' or jsonb_array_length(p_plan) not between 1 and 120 or octet_length(p_plan::text)>32768 then
  raise exception 'erp_document_finance_plan_required' using errcode='22023';end if;end if;
 for part in select value from jsonb_array_elements(case when source='document' then d.body->'installments' else p_plan end) loop
  if source='explicit' then perform erp_finance.keys(part,array['amount_cents','due_on','method']);amount:=erp_finance.cents(part->'amount_cents',false);due:=erp_finance.day(part->'due_on');
  else amount:=(erp_documents.decimal_value(part->'amount',2,12)*100)::bigint;due:=erp_finance.day(part->'due_date');end if;
  if v_dates='data_atual' then due:=v_today;elsif v_dates='recalcular' then due:=v_today+greatest(due-v_base,0);end if;
  if amount<=0 or due<issued then raise exception 'erp_document_finance_invalid_installment' using errcode='22023';end if;
  n:=n+1;sum_cents:=sum_cents+amount;
  parts:=parts||jsonb_build_array(jsonb_build_object('position',n,'amount_cents',amount::text,'due_on',due,'method',erp_finance.txt(part,'method',100)));
 end loop;
 if sum_cents<>total or n not between 1 and 120 then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023';end if;
 r:=jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text,'document_version',d.version,'status',d.status,
  'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name','contact_version',c.version,'issued_on',issued,'direction',direction,'total_cents',total::text,
  'category_id',g.id,'category_name',g.name,'category_version',g.version,'plan_source',source,'installments',parts);
 return r||jsonb_build_object('preview_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex'));
end $function$;

-- ---------------------------------------------------------------- A conta: origem, vendedor e documento vinculado
CREATE OR REPLACE FUNCTION erp_finance.title_origin(p_title uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 select coalesce((select jsonb_build_object('document_id',d.id,'kind',d.kind,'number',d.number::text)
   from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id join erp_documents.document d on d.id=p.document_id where l.title_id=p_title),
  -- 247: "Nota fiscal de origem" of the contas lançadas by a note.
  (select jsonb_build_object('invoice_id',i.id,'kind','fiscal_invoices','model',i.model,'direction',i.direction,'number',i.number::text)
   from erp_finance.invoice_title l join erp_finance.invoice_posting p on p.id=l.posting_id join erp_fiscal_invoices.invoice i on i.id=p.invoice_id where l.title_id=p_title));
$function$;
CREATE OR REPLACE FUNCTION erp_finance.title_inherited_seller(p_title uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select coalesce((select erp_finance.document_seller(d) from erp_finance.document_title l join erp_finance.document_posting p on p.id=l.posting_id
      join erp_documents.document d on d.id=p.document_id where l.title_id=p_title limit 1),
    -- 247: the Vendedor of the nota fiscal (215) that lançou the conta a receber.
    (select s.id from erp_finance.invoice_title l join erp_finance.invoice_posting p on p.id=l.posting_id join erp_fiscal_invoices.invoice i on i.id=p.invoice_id
      join erp_catalog.seller s on s.id=i.seller_id where l.title_id=p_title and i.direction='1' limit 1));
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
      -- 247: the contas of a nota fiscal are linked to it as the contas of a pedido are to the pedido.
      'document_linked',exists(select 1 from erp_finance.document_title l where l.title_id=t.id) or exists(select 1 from erp_finance.invoice_title l where l.title_id=t.id),
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

-- Extrato: letra N (Nota fiscal) of the baixas of contas lançadas by a note.
CREATE OR REPLACE FUNCTION erp_finance.statement_line_dto(p_line erp_finance.statement_line)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_doc jsonb;
begin
  if p_line.title_id is not null then
    select jsonb_build_object('kind',d.kind,'number',d.number::text) into v_doc from erp_finance.document_title l join erp_finance.document_posting dp on dp.id=l.posting_id
      join erp_documents.document d on d.id=dp.document_id where l.title_id=p_line.title_id limit 1;
    if v_doc is null then
      select jsonb_build_object('kind','fiscal_invoices','number',i.number::text) into v_doc from erp_finance.invoice_title l join erp_finance.invoice_posting ip on ip.id=l.posting_id
        join erp_fiscal_invoices.invoice i on i.id=ip.invoice_id where l.title_id=p_line.title_id and i.number is not null limit 1;
    end if;
  end if;
  return jsonb_build_object('line_id',p_line.line_id,'line_kind',p_line.line_kind,'posted_on',p_line.posted_on,'competence_on',p_line.competence_on,'account_id',p_line.account_id,
    'account_name',(select name from erp_finance.account where id=p_line.account_id),'amount_cents',p_line.amount_cents::text,
    'category_id',p_line.category_id,'category_name',(select name from erp_finance.category where id=p_line.category_id),
    'contact_id',p_line.contact_id,'contact_name',(select name from erp_catalog.record where id=p_line.contact_id),'note',p_line.note,
    'title_id',p_line.title_id,'title_kind',p_line.title_kind,'document',v_doc,'transfer_id',p_line.transfer_id,'entry_id',p_line.entry_id,'entry_version',p_line.entry_version,
    'entry_origin',p_line.entry_origin,'reconciled',erp_finance.line_reconciled(p_line.line_kind,p_line.line_id));
end $function$;

-- Ficha financeira (172/175): the Origem "Nota fiscal" of the contas lançadas by a note, and Sistema > Usuários > Permissões > Ficha.
CREATE OR REPLACE FUNCTION public.erp_finance_contact_ledger_page(p_user_id uuid, p_contact uuid, p_scope text DEFAULT 'all'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_page integer DEFAULT 1, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_items jsonb; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_debit numeric; v_credit numeric; v_total bigint;
begin
  perform erp_finance.require_access(p_user_id,false);
  perform erp_finance.require_permission(p_user_id,'financas.ficha');
  if p_contact is null or p_scope is null or p_scope not in ('all','receivable','payable') or p_from is null or p_to is null or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2100-12-31' or p_to-p_from>3660
    or p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  if not exists(select 1 from erp_catalog.contact where record_id=p_contact) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
  with rows as materialized (
    select t.issued_on as on_day,t.created_at as at_ts,'title' line_kind,t.id ref_id,t.kind,
      case when t.installments>1 then format('%s %s/%s',t.description,t.installment,t.installments) else t.description end note,
      t.due_on,case when t.kind='receivable' then 'debit' else 'credit' end side,t.amount_cents amount,
      case when t.cancelled then 'cancelled' when t.settled_cents=t.amount_cents then 'paid' when t.settled_cents>0 then 'partial' when t.due_on=v_today then 'due_today' when t.due_on<v_today then 'overdue' else 'open' end situation,
      coalesce((select jsonb_build_object('kind',d.kind,'number',d.number::text) from erp_finance.document_title l join erp_finance.document_posting dp on dp.id=l.posting_id join erp_documents.document d on d.id=dp.document_id where l.title_id=t.id limit 1),
        (select jsonb_build_object('kind','fiscal_invoices','number',i.number::text) from erp_finance.invoice_title l join erp_finance.invoice_posting ip on ip.id=l.posting_id
          join erp_fiscal_invoices.invoice i on i.id=ip.invoice_id where l.title_id=t.id and i.number is not null limit 1)) origin,
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
end $function$;

-- ---------------------------------------------------------------- Faturamento agrupado com as notas fiscais
-- A pedido de venda whose note has contas or is faturada em grupo is no longer eligible (one effect).
CREATE OR REPLACE FUNCTION erp_finance.grouped_billing_eligible(p_document erp_documents.document)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select p_document.kind='sales_orders' and p_document.status in ('verified','in_progress','partially_fulfilled','fulfilled') and p_document.total>0
    and not exists(select 1 from erp_finance.document_posting p where p.document_id=p_document.id and p.state='active')
    and not exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_document.id and g.active)
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o where o.document_id=p_document.id and erp_finance.invoice_effect_active(o.invoice_id));
$function$;
-- NF-e de saída do Brufap a faturar: not cancelled, denied or excluded, with the cliente and a total, no contas, no other faturamento and
-- no pedido of origin with contas or faturamento.
create function erp_finance.grouped_billing_invoice_eligible(v erp_fiscal_invoices.invoice)
returns boolean language sql stable set search_path=pg_catalog as $$
  select v.model='55' and v.direction='1' and v.deleted_at is null and v.status not in (3,10) and coalesce(erp_finance.invoice_total_cents(v.totals),0)>0
    and erp_finance.invoice_contact(v.recipient) is not null and not erp_finance.invoice_effect_active(v.id) and jsonb_array_length(erp_finance.invoice_orders_posted(v.id))=0;
$$;

CREATE OR REPLACE FUNCTION public.erp_finance_grouped_billing_candidates(p_user_id uuid,p_from date default null,p_to date default null,p_documents uuid[] default null,p_query text default null,
  p_page integer default 1,p_limit integer default 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.grouped_billing_access(p_user_id,false);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
    or (p_documents is null and (p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 or p_from<date '1900-01-01' or p_to>date '2100-12-31'))
    or (p_documents is not null and (array_ndims(p_documents) is distinct from 1 or cardinality(p_documents) not between 1 and 200 or array_position(p_documents,null) is not null)) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with docs as materialized (
    -- 247: a pedido whose note is listed for the same cliente is that one sale: the Valor Total counts the note only, as the
    -- selection chooses by default (a note and its pedido are never billed together).
    select d.contact_id,'sales_orders'::text as kind,case when p_documents is null and exists(select 1 from erp_fiscal_invoices.invoice_order o
        join erp_fiscal_invoices.invoice i on i.id=o.invoice_id where o.document_id=d.id and erp_finance.invoice_contact(i.recipient)=d.contact_id
          and i.issue_date between p_from and p_to and erp_finance.grouped_billing_invoice_eligible(i)) then 0 else (d.total*100)::bigint end as cents
    from erp_documents.document d
    where d.kind='sales_orders' and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
    -- 247: the NF-e de saída of the period (not with the pedidos chosen in the listagem).
    union all
    select erp_finance.invoice_contact(i.recipient),'fiscal_invoices',erp_finance.invoice_total_cents(i.totals) from erp_fiscal_invoices.invoice i
    where p_documents is null and i.issue_date between p_from and p_to and erp_finance.grouped_billing_invoice_eligible(i)
  ), clients as materialized (
    select x.contact_id,r.name,count(*) filter (where x.kind='sales_orders') documents,count(*) filter (where x.kind='fiscal_invoices') invoices,sum(x.cents) cents
    from docs x join erp_catalog.record r on r.id=x.contact_id join erp_catalog.contact c on c.record_id=r.id
    where v_query is null or strpos(lower(r.name),v_query)>0 group by x.contact_id,r.name
  )
  select (select count(*) from clients),(select coalesce(jsonb_agg(jsonb_build_object('contact_id',c.contact_id,'contact_name',c.name,'documents',c.documents,'invoices',c.invoices,'total_cents',c.cents::text) order by lower(c.name),c.contact_id),'[]'::jsonb)
    from (select * from clients order by lower(name),contact_id limit p_limit offset (p_page-1)*p_limit) c) into v_total,v_items;
  return jsonb_build_object('entity','grouped_billing_candidates','from',p_from,'to',p_to,'selected',p_documents is not null,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,'data_mode','erp_native');
end $function$;

CREATE OR REPLACE FUNCTION public.erp_finance_grouped_billing_documents(p_user_id uuid,p_contact uuid,p_from date default null,p_to date default null,p_documents uuid[] default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_items jsonb; v_total bigint;
begin
  perform erp_finance.grouped_billing_access(p_user_id,false);
  if p_contact is null or (p_documents is null and (p_from is null or p_to is null or p_from>p_to or p_to-p_from>366))
    or (p_documents is not null and (array_ndims(p_documents) is distinct from 1 or cardinality(p_documents) not between 1 and 200 or array_position(p_documents,null) is not null)) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with docs as materialized (
    select d.id,'sales_orders'::text as kind,d.number::text as number,d.number::bigint as number_sort,d.body->>'date' as day,(d.total*100)::bigint as cents,d.version,null::jsonb as orders from erp_documents.document d
    where d.kind='sales_orders' and d.contact_id=p_contact and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
    -- 247: "Nota Fiscal nº" items, with the pedidos of origin so a pedido and its note are never chosen together.
    union all
    select i.id,'fiscal_invoices',i.number::text,i.number::bigint,i.issue_date::text,erp_finance.invoice_total_cents(i.totals),i.version,
      (select coalesce(jsonb_agg(o.document_id order by o.document_id),'[]'::jsonb) from erp_fiscal_invoices.invoice_order o where o.invoice_id=i.id)
    from erp_fiscal_invoices.invoice i
    where p_documents is null and erp_finance.invoice_contact(i.recipient)=p_contact and i.issue_date between p_from and p_to and erp_finance.grouped_billing_invoice_eligible(i)
  ) select (select count(*) from docs),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'number',x.number,'date',x.day,'total_cents',x.cents::text,'version',x.version,
      'orders',x.orders) order by x.day,x.kind desc,x.number_sort nulls last,x.id),'[]'::jsonb)
    from (select * from docs order by day,kind desc,number_sort nulls last,id limit 500) x) into v_total,v_items;
  return jsonb_build_object('entity','grouped_billing_documents','contact_id',p_contact,'total',v_total,'items',v_items,'data_mode','erp_native');
end $function$;

CREATE OR REPLACE FUNCTION erp_finance.grouped_billing_view(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  select jsonb_build_object('id',b.id,'number',b.number::text,'contact_id',b.contact_id,'contact_name',r.name,'issued_on',b.issued_on,'condition',b.condition,'total_cents',b.total_cents::text,
    'state',b.state,'version',b.version,'created_at',b.created_at,
    'documents',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'total_cents',g.total_cents::text) order by d.number),'[]'::jsonb)
      from erp_finance.grouped_billing_document g join erp_documents.document d on d.id=g.document_id where g.billing_id=b.id),
    -- 247: the notas fiscais of the faturamento.
    'invoices',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'number',i.number::text,'total_cents',g.total_cents::text) order by i.number nulls last,i.id),'[]'::jsonb)
      from erp_finance.grouped_billing_invoice g join erp_fiscal_invoices.invoice i on i.id=g.invoice_id where g.billing_id=b.id),
    'titles',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'position',l.position,'due_on',t.due_on,'amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,'cancelled',t.cancelled) order by l.position),'[]'::jsonb)
      from erp_finance.grouped_billing_title l join erp_finance.title t on t.id=l.title_id where l.billing_id=b.id),
    -- Excluir only while no conta has a baixa (even estornada) or a boleto.
    'deletable',b.state='active' and not exists(select 1 from erp_finance.grouped_billing_title l join erp_finance.settlement s on s.title_id=l.title_id where l.billing_id=b.id)
      and not exists(select 1 from erp_finance.grouped_billing_title l join erp_cnab.billing_title c on c.title_id=l.title_id where l.billing_id=b.id))
  from erp_finance.grouped_billing b join erp_catalog.record r on r.id=b.contact_id where b.id=p_id;
$function$;

CREATE OR REPLACE FUNCTION public.erp_finance_grouped_billing_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_item jsonb; v_ids uuid[]; v_days integer[]; v_doc erp_documents.document; v_total bigint; v_sum bigint;
  v_billing uuid; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_count integer; v_part bigint; v_title uuid; v_category uuid; v_numbers text; v_created jsonb:='[]'::jsonb;
  v_row erp_finance.grouped_billing%rowtype; v_contact uuid; v_index integer;
  v_invoice_ids uuid[]; v_invoice erp_fiscal_invoices.invoice; v_links uuid[]; v_notes text; v_docs_of_item uuid[]; v_invoices_of_item uuid[];
begin
  perform erp_finance.grouped_billing_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('grouped_billing_generate','grouped_billing_delete') then raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>262144 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.grouped_billing_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return v_command.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='grouped_billing_generate' then
    -- GERAR CONTAS: each cliente with its pedidos and notas fiscais (the total read is the CAS) and the Condição in days after today.
    perform erp_finance.keys(p_data,array['items','category_id']);
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    v_category:=coalesce(erp_finance.cash_category(p_data->'category_id','receivable'),
      (select d.category_id from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id where d.key='sale' and c.active and c.deleted_at is null));
    for v_item in select value from jsonb_array_elements(p_data->'items') loop
      perform erp_finance.keys(v_item,array['contact_id','document_ids','invoice_ids','total_cents','condition','days']);
      if jsonb_typeof(coalesce(v_item->'document_ids','[]'::jsonb)) is distinct from 'array' or jsonb_typeof(coalesce(v_item->'invoice_ids','[]'::jsonb)) is distinct from 'array'
        or jsonb_array_length(coalesce(v_item->'document_ids','[]'::jsonb)) not between 0 and 200 or jsonb_array_length(coalesce(v_item->'invoice_ids','[]'::jsonb)) not between 0 and 200
        or jsonb_array_length(coalesce(v_item->'document_ids','[]'::jsonb))+jsonb_array_length(coalesce(v_item->'invoice_ids','[]'::jsonb))<1 then
        raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    end loop;
    select array_agg(x order by x) into v_invoice_ids from (select distinct erp_finance.uuid_value(d.id) x from jsonb_array_elements(p_data->'items') i(item), jsonb_array_elements(coalesce(i.item->'invoice_ids','[]'::jsonb)) d(id)) y;
    -- Lock order of the 017 lançamento: every pedido (the chosen ones and the pedidos of the chosen notes) in UUID order, then the notes, then the contas.
    select array_agg(x order by x) into v_ids from (
      select distinct erp_finance.uuid_value(d.id) x from jsonb_array_elements(p_data->'items') i(item), jsonb_array_elements(coalesce(i.item->'document_ids','[]'::jsonb)) d(id)
      union select o.document_id from erp_fiscal_invoices.invoice_order o where o.invoice_id=any(coalesce(v_invoice_ids,'{}'::uuid[]))) y;
    if coalesce(cardinality(v_ids),0)+coalesce(cardinality(v_invoice_ids),0)>500 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    perform 1 from erp_documents.document where id=any(coalesce(v_ids,'{}'::uuid[])) order by id for update;
    perform 1 from erp_fiscal_invoices.invoice where id=any(coalesce(v_invoice_ids,'{}'::uuid[])) order by id for update;
    -- The links of the notes can only change under the note lock (notas lane): read again, they must be among the locked pedidos.
    if exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=any(coalesce(v_invoice_ids,'{}'::uuid[])) and not o.document_id=any(coalesce(v_ids,'{}'::uuid[]))) then
      raise exception 'erp_finance_grouped_billing_document' using errcode='40001'; end if;
    for v_item in select value from jsonb_array_elements(p_data->'items') loop
      v_contact:=erp_finance.uuid_value(v_item->'contact_id');
      if jsonb_typeof(v_item->'days') is distinct from 'array' or jsonb_array_length(v_item->'days') not between 1 and 120 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      select array_agg((value#>>'{}')::integer order by ordinality) into v_days from jsonb_array_elements(v_item->'days') with ordinality
        where jsonb_typeof(value)='number' and (value#>>'{}')~'^[0-9]{1,4}$';
      if coalesce(cardinality(v_days),0)<>jsonb_array_length(v_item->'days') or exists(select 1 from generate_subscripts(v_days,1) k where v_days[k]>3650 or (k>1 and v_days[k]<v_days[k-1])) then
        raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      select coalesce(array_agg(erp_finance.uuid_value(x)),'{}'::uuid[]) into v_docs_of_item from jsonb_array_elements(coalesce(v_item->'document_ids','[]'::jsonb)) x;
      select coalesce(array_agg(erp_finance.uuid_value(x)),'{}'::uuid[]) into v_invoices_of_item from jsonb_array_elements(coalesce(v_item->'invoice_ids','[]'::jsonb)) x;
      if (select count(distinct x) from unnest(v_docs_of_item) x)<>cardinality(v_docs_of_item) or (select count(distinct x) from unnest(v_invoices_of_item) x)<>cardinality(v_invoices_of_item)
        or (select count(*) from erp_documents.document where id=any(v_docs_of_item))<>cardinality(v_docs_of_item)
        or (select count(*) from erp_fiscal_invoices.invoice where id=any(v_invoices_of_item))<>cardinality(v_invoices_of_item) then
        raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      v_sum:=0; v_numbers:=null; v_notes:=null;
      for v_doc in select d.* from erp_documents.document d where d.id=any(v_docs_of_item) order by d.number loop
        if v_doc.contact_id<>v_contact or not erp_finance.grouped_billing_eligible(v_doc) then raise exception 'erp_finance_grouped_billing_document' using errcode='40001'; end if;
        perform erp_documents.require_access(p_user_id,'sales_orders',false);
        v_sum:=v_sum+(v_doc.total*100)::bigint; v_numbers:=concat_ws(', ',v_numbers,v_doc.number::text);
      end loop;
      for v_invoice in select i.* from erp_fiscal_invoices.invoice i where i.id=any(v_invoices_of_item) order by i.number nulls last,i.id loop
        if erp_finance.invoice_contact(v_invoice.recipient) is distinct from v_contact or not erp_finance.grouped_billing_invoice_eligible(v_invoice) then
          raise exception 'erp_finance_grouped_billing_document' using errcode='40001'; end if;
        -- A note and its pedido are one sale: never both in the faturamento.
        if exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=v_invoice.id and o.document_id=any(v_docs_of_item)) then
          raise exception 'erp_finance_grouped_billing_duplicate' using errcode='22023'; end if;
        v_sum:=v_sum+erp_finance.invoice_total_cents(v_invoice.totals); v_notes:=concat_ws(', ',v_notes,coalesce(v_invoice.number::text,'(sem número)'));
      end loop;
      v_total:=erp_finance.cents(v_item->'total_cents',false);
      if v_sum<>v_total then raise exception 'erp_finance_grouped_billing_total' using errcode='40001'; end if;
      v_count:=cardinality(v_days);
      if v_total<v_count then raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      if v_today+v_days[v_count]>date '2100-12-31' then raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      insert into erp_finance.grouped_billing(contact_id,issued_on,condition,total_cents,actor,command_id)
        values(v_contact,v_today,erp_finance.cash_text(v_item,'condition',200,true),v_total,p_user_id,p_command_id) returning id into v_billing;
      insert into erp_finance.grouped_billing_document(billing_id,document_id,total_cents)
        select v_billing,d.id,(d.total*100)::bigint from erp_documents.document d where d.id=any(v_docs_of_item);
      insert into erp_finance.grouped_billing_invoice(billing_id,invoice_id,total_cents)
        select v_billing,i.id,erp_finance.invoice_total_cents(i.totals) from erp_fiscal_invoices.invoice i where i.id=any(v_invoices_of_item);
      -- Equal parcelas in exact cents, the first ones absorbing the remainder (as Gerar parcelas of the pedido).
      for v_index in 1..v_count loop
        v_part:=v_total/v_count+case when (v_index-1)<v_total%v_count then 1 else 0 end;
        insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents,competence_on)
          values(v_billing,v_index,v_count,'receivable',v_contact,v_category,left('Faturamento agrupado: '||concat_ws(' · ','pedidos nº '||v_numbers,'notas nº '||v_notes),240),v_today,v_today+v_days[v_index],v_part,v_today) returning id into v_title;
        insert into erp_finance.grouped_billing_title(title_id,billing_id,position) values(v_title,v_billing,v_index);
      end loop;
      v_created:=v_created||jsonb_build_array(erp_finance.grouped_billing_view(v_billing));
    end loop;
    v_result:=jsonb_build_object('entity','grouped_billings','items',v_created);

  else
    -- Excluir selecionados (Listar Faturamentos Gerados): the contas without baixa or boleto are cancelled and the pedidos and notes freed.
    perform erp_finance.keys(p_data,array['id','expected_version']);
    select * into v_row from erp_finance.grouped_billing where id=erp_finance.uuid_value(p_data->'id');
    if not found or v_row.state<>'active' then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    perform 1 from erp_documents.document where id in (select document_id from erp_finance.grouped_billing_document where billing_id=v_row.id) order by id for update;
    perform 1 from erp_fiscal_invoices.invoice where id in (select invoice_id from erp_finance.grouped_billing_invoice where billing_id=v_row.id) order by id for update;
    perform 1 from erp_finance.title where id in (select title_id from erp_finance.grouped_billing_title where billing_id=v_row.id) order by id for update;
    select * into v_row from erp_finance.grouped_billing where id=v_row.id for update;
    if v_row.version<>erp_finance.expected(p_data->'expected_version') then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    v_before:=erp_finance.grouped_billing_view(v_row.id);
    if not (v_before->>'deletable')::boolean then raise exception 'erp_finance_grouped_billing_locked' using errcode='40001'; end if;
    perform set_config('erp_finance.grouped_owner','on',true);
    update erp_finance.title set cancelled=true,deleted_at=clock_timestamp(),deleted_by=p_user_id,deleted_note='Faturamento agrupado excluído',version=version+1,updated_at=clock_timestamp()
      where id in (select title_id from erp_finance.grouped_billing_title where billing_id=v_row.id) and deleted_at is null;
    perform set_config('erp_finance.grouped_owner','',true);
    update erp_finance.grouped_billing_document set active=false where billing_id=v_row.id;
    update erp_finance.grouped_billing_invoice set active=false where billing_id=v_row.id;
    update erp_finance.grouped_billing set state='deleted',deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1 where id=v_row.id;
    v_result:=jsonb_build_object('entity','grouped_billings','record',jsonb_build_object('id',v_row.id,'deleted',true));
  end if;

  perform erp_finance.grouped_billing_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $function$;

revoke all on function erp_finance.invoice_kind(text),erp_finance.invoice_label(text,integer),erp_finance.invoice_total_cents(jsonb),erp_finance.invoice_contact(jsonb),
  erp_finance.invoice_orders_posted(uuid),erp_finance.invoice_effect_active(uuid),erp_finance.invoice_blocked_reason(erp_fiscal_invoices.invoice),
  erp_finance.invoice_posting_summary(uuid),erp_finance.invoice_title_rows(uuid),erp_finance.invoice_preview_data(erp_fiscal_invoices.invoice,uuid,uuid),
  erp_finance.invoice_lock(uuid),erp_finance.invoice_read_access(uuid),erp_finance.invoice_post(uuid,uuid,jsonb,text),erp_finance.guard_finance_invoice(),
  erp_finance.guard_invoice_order_effect(),erp_finance.guard_invoice_title(),erp_finance.invoice_auto_finance(),erp_finance.document_preview_data(erp_documents.document,uuid,jsonb),
  erp_finance.title_origin(uuid),erp_finance.title_inherited_seller(uuid),erp_finance.dto(text,uuid),erp_finance.statement_line_dto(erp_finance.statement_line),
  erp_finance.grouped_billing_eligible(erp_documents.document),erp_finance.grouped_billing_invoice_eligible(erp_fiscal_invoices.invoice),erp_finance.grouped_billing_view(uuid)
  from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_invoice_finance_get(uuid,uuid)','erp_finance_invoice_finance_preview(uuid,uuid,integer,uuid,uuid)','erp_finance_invoice_finance_post(uuid,uuid,jsonb)',
    'erp_finance_invoice_finance_reverse(uuid,uuid,jsonb)','erp_finance_invoice_finance_flags(uuid,uuid[])','erp_finance_contact_ledger_page(uuid,uuid,text,date,date,integer,integer)',
    'erp_finance_grouped_billing_candidates(uuid,date,date,uuid[],text,integer,integer)','erp_finance_grouped_billing_documents(uuid,uuid,date,date,uuid[])',
    'erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
