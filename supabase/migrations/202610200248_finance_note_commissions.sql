-- 248: comissões das contas lançadas pelas notas fiscais e o pedido de compra Em aberto (lane financeiro, onda E).
-- * Financeiro > Comissões: cada parcela lançada por uma NF-e de saída do Brufap (247) com Vendedor (215) gera a comissão do
--   vendedor, com a regra, a base e a alíquota do vendedor naquele momento, como as parcelas dos pedidos (171). A base é a dos
--   produtos da nota com os adicionais de Preferências > Vendas (desconto, frete, ICMS ST e IPI); com Preferências > Notas Fiscais
--   "Considerar total da nota como base de comissão", é o total da nota. Estornar contas da nota anula a comissão.
-- * Pedido de compra Em aberto lança contas (o Origin lança as contas a pagar ao criar o pedido): erp_finance.document_preview_data
--   aceita a situação Em aberto do pedido de compra, e o pedido com contas lançadas segue de Em aberto para Em andamento ou Atendido.
-- Nada aqui emite, transmite ou paga comissão. Requer 171, 210 e 247.
begin;

do $$ declare r record; begin
  if to_regclass('erp_finance.invoice_posting') is null then raise exception 'finance_commissions_248_requires_247' using errcode='55000'; end if;
  for r in select * from (values
    ('erp_finance.commission_rows(uuid)','87bc72b19cc4aa84894a3f518bbd502e658f5fc5d31e479cab9b2289ac6a4dd4'),
    ('erp_finance.guard_posted_document()','690d5d6374c0448555260030a1a0568c968433120c563ae917b783e3ffa34859'),
    ('erp_finance.document_preview_data(erp_documents.document,uuid,jsonb)','cdcb4ecfdfeb79d4df83cddacf7fe2f20f6c87356df78660ed29ef1986ea1eaf')) v(sig,expected) loop
    if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
      raise exception 'finance_commissions_248_previous_definition_changed' using errcode='55000',detail=r.sig; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- Comissões das notas
alter table erp_finance.commission add column invoice_posting_id uuid references erp_finance.invoice_posting(id);
alter table erp_finance.commission add column invoice_id uuid references erp_fiscal_invoices.invoice(id);
do $$ declare c text; begin
  -- The 171 shape check of the origins (document | manual) gives way to the one with the notes.
  for c in select conname from pg_constraint where conrelid='erp_finance.commission'::regclass and contype='c'
    and (pg_get_constraintdef(oid) like '%origin%manual%' or pg_get_constraintdef(oid) like '%''document''%''manual''%') loop
    execute format('alter table erp_finance.commission drop constraint %I',c);
  end loop;
end $$;
alter table erp_finance.commission add constraint commission_origin check(origin in ('document','manual','invoice'));
alter table erp_finance.commission add constraint commission_origin_shape check(
  (origin='document' and posting_id is not null and title_id is not null and document_id is not null and position is not null and positions is not null and credit_on is null and deleted_at is null
    and invoice_posting_id is null and invoice_id is null)
  or (origin='invoice' and invoice_posting_id is not null and title_id is not null and invoice_id is not null and position is not null and positions is not null and credit_on is null and deleted_at is null
    and posting_id is null and document_id is null)
  or (origin='manual' and posting_id is null and title_id is null and document_id is null and invoice_posting_id is null and invoice_id is null and position is null and positions is null and credit_on is not null));
create index erp_finance_commission_invoice_posting on erp_finance.commission(invoice_posting_id) where invoice_posting_id is not null;

-- Base, weighted rate and items of a note for a seller (as commission_document of the pedidos, 171).
create function erp_finance.commission_invoice(p_invoice uuid,p_seller uuid,out base_cents bigint,out weighted numeric,out items_cents bigint,out rule text)
language plpgsql stable set search_path=pg_catalog as $$
declare v erp_fiscal_invoices.invoice; s erp_catalog.seller; v_extra jsonb:=coalesce(erp_preferences.get('vendas.base_comissao'),'[]'::jsonb); v_base numeric;
  v_money constant text:='^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
begin
  select * into v from erp_fiscal_invoices.invoice where id=p_invoice; select * into s from erp_catalog.seller where id=p_seller;
  select coalesce(sum(round(i.total*100)),0)::bigint,coalesce(sum(round(i.total*100)*case when s.commission_mode='fixa' then coalesce(s.commission_rate,0)
      else coalesce((select (b->>'rate')::numeric from jsonb_array_elements(s.commission_bands) b
        where (case when i.total>0 then round(i.discount/i.total*100,2) else 0 end)<=(b->>'discount_up_to')::numeric order by (b->>'discount_up_to')::numeric limit 1),0) end),0)
    into items_cents,weighted from erp_fiscal_invoices.invoice_item i where i.invoice_id=v.id;
  if coalesce(erp_preferences.get('nfe.base_comissao_total'),'false'::jsonb)='true'::jsonb then
    -- Preferências > Notas Fiscais "Considerar total da nota como base de comissão".
    v_base:=coalesce(erp_finance.invoice_total_cents(v.totals),0);
  else
    v_base:=items_cents;
    if jsonb_typeof(v_extra)='array' and v_extra?'desconto' then v_base:=v_base-round(coalesce(v.discount,0)*100); end if;
    if jsonb_typeof(v_extra)='array' and v_extra?'frete' then v_base:=v_base+round(coalesce(v.freight,0)*100); end if;
    if jsonb_typeof(v_extra)='array' and v_extra?'icms_st' and v.totals->>'st'~v_money then v_base:=v_base+round((v.totals->>'st')::numeric*100); end if;
    if jsonb_typeof(v_extra)='array' and v_extra?'ipi' and v.totals->>'ipi'~v_money then v_base:=v_base+round((v.totals->>'ipi')::numeric*100); end if;
  end if;
  base_cents:=greatest(v_base,0)::bigint; rule:=s.commission_rule;
end $$;
-- One parcela of the lançamento of a note: its share of the base and of the commission (cumulative rounding, as 171).
create function erp_finance.commission_capture_invoice_title(p_title uuid)
returns uuid language plpgsql set search_path=pg_catalog as $$
declare l erp_finance.invoice_title; p erp_finance.invoice_posting; v erp_fiscal_invoices.invoice; t erp_finance.title; v_seller uuid; v_calc record;
  v_total bigint; v_before bigint; v_upto bigint; v_n integer; v_commission numeric; v_id uuid;
begin
  select * into l from erp_finance.invoice_title where title_id=p_title;
  select * into p from erp_finance.invoice_posting where id=l.posting_id;
  if p.id is null or p.state<>'active' or p.snapshot->>'direction' is distinct from 'receivable' then return null; end if;
  if exists(select 1 from erp_finance.commission where title_id=p_title) then return null; end if;
  select * into v from erp_fiscal_invoices.invoice where id=p.invoice_id;
  select s.id into v_seller from erp_catalog.seller s where s.id=v.seller_id;
  if v_seller is null then return null; end if;
  select * into v_calc from erp_finance.commission_invoice(v.id,v_seller);
  if v_calc.items_cents<=0 or v_calc.weighted<=0 then return null; end if;
  v_total:=(p.snapshot->>'total_cents')::bigint;
  if v_total is null or v_total<=0 then return null; end if;
  select coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<l.position),0),
      coalesce(sum((x->>'amount_cents')::bigint) filter (where (x->>'position')::integer<=l.position),0),count(*)
    into v_before,v_upto,v_n from jsonb_array_elements(p.snapshot->'installments') x;
  v_commission:=round(v_calc.base_cents::numeric*v_calc.weighted/(v_calc.items_cents::numeric*100));
  select * into t from erp_finance.title where id=p_title;
  insert into erp_finance.commission(seller_id,origin,invoice_posting_id,title_id,invoice_id,position,positions,rule,parcel_cents,base_cents,rate,commission_cents,due_on,description,actor,command_id)
    values(v_seller,'invoice',p.id,t.id,v.id,l.position,v_n,v_calc.rule,t.amount_cents,
      (round(v_calc.base_cents::numeric*v_upto/v_total)-round(v_calc.base_cents::numeric*v_before/v_total))::bigint,
      round(v_calc.weighted/v_calc.items_cents,6),(round(v_commission*v_upto/v_total)-round(v_commission*v_before/v_total))::bigint,t.due_on,
      left(format('%s · parcela %s/%s',erp_finance.invoice_label(v.model,v.number),l.position,v_n),240),p.actor,p.command_id)
    returning id into v_id;
  return v_id;
end $$;
create function erp_finance.commission_capture_invoice() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  begin perform erp_finance.commission_capture_invoice_title(new.title_id);
  exception when data_exception or check_violation then null; end;
  return null;
end $$;
create trigger commission_capture_invoice after insert on erp_finance.invoice_title for each row execute function erp_finance.commission_capture_invoice();
-- Contas already lançadas by notes (247) with a seller get their commission now, as 171 did for the pedidos.
do $$ declare v uuid; begin
  for v in select l.title_id from erp_finance.invoice_title l join erp_finance.invoice_posting p on p.id=l.posting_id
    where p.state='active' and p.snapshot->>'direction'='receivable' and not exists(select 1 from erp_finance.commission c where c.title_id=l.title_id) order by p.created_at,l.position loop
    begin perform erp_finance.commission_capture_invoice_title(v);
    exception when data_exception or check_violation then null; end;
  end loop;
end $$;

-- Situação of each commission (171) with the commissions of the notes: released by the same rules, anulada when the conta is cancelled
-- or the lançamento of the note is estornado. The "documento" of a note is the note itself (kind fiscal_invoices).
CREATE OR REPLACE FUNCTION erp_finance.commission_rows(p_seller uuid)
 RETURNS TABLE(id uuid, seller_id uuid, origin text, rule text, parcel_cents bigint, base_cents bigint, rate numeric, commission_cents bigint, due_on date, description text, created_on date, released_on date, void boolean, document_id uuid, document_kind text, document_number bigint, title_id uuid, version integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  with c as materialized (
    select x.*,coalesce(x.posting_id,x.invoice_posting_id) effect_id from erp_finance.commission x where (p_seller is null or x.seller_id=p_seller) and x.deleted_at is null
  ), done as materialized (
    select l.posting_id,l.position,t.id title_id,(t.cancelled or t.deleted_at is not null) gone,
      case when not t.cancelled and t.deleted_at is null and t.settled_cents=t.amount_cents then
        (select max(s.posted_on) from erp_finance.settlement s where s.title_id=t.id and s.kind='payment' and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)) end paid_on
    from erp_finance.document_title l join erp_finance.title t on t.id=l.title_id where l.posting_id in (select posting_id from c where posting_id is not null)
    union all
    select l.posting_id,l.position,t.id,(t.cancelled or t.deleted_at is not null),
      case when not t.cancelled and t.deleted_at is null and t.settled_cents=t.amount_cents then
        (select max(s.posted_on) from erp_finance.settlement s where s.title_id=t.id and s.kind='payment' and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)) end
    from erp_finance.invoice_title l join erp_finance.title t on t.id=l.title_id where l.posting_id in (select invoice_posting_id from c where invoice_posting_id is not null)
  ), effect as materialized (
    select p.id,p.created_at,p.state from erp_finance.document_posting p where p.id in (select posting_id from c where posting_id is not null)
    union all select p.id,p.created_at,p.state from erp_finance.invoice_posting p where p.id in (select invoice_posting_id from c where invoice_posting_id is not null)
  )
  select c.id,c.seller_id,c.origin,c.rule,c.parcel_cents,c.base_cents,c.rate,c.commission_cents,c.due_on,c.description,
    case when c.origin='manual' then c.credit_on else (p.created_at at time zone 'America/Sao_Paulo')::date end,
    case when c.origin='manual' then c.credit_on
      when c.rule='faturamento' then (p.created_at at time zone 'America/Sao_Paulo')::date
      when c.rule='parcial' then (select x.paid_on from done x where x.title_id=c.title_id)
      when c.rule='primeira_parcela' then (select x.paid_on from done x where x.posting_id=c.effect_id and x.position=1)
      else (select case when bool_and(x.paid_on is not null) then max(x.paid_on) end from done x where x.posting_id=c.effect_id and not x.gone) end,
    c.origin in ('document','invoice') and (coalesce((select x.gone from done x where x.title_id=c.title_id),true) or p.state<>'active'),
    coalesce(c.document_id,c.invoice_id),case when c.origin='invoice' then 'fiscal_invoices' else d.kind end,coalesce(d.number,i.number::bigint),c.title_id,c.version
  from c left join effect p on p.id=c.effect_id left join erp_documents.document d on d.id=c.document_id left join erp_fiscal_invoices.invoice i on i.id=c.invoice_id;
$function$;

-- ---------------------------------------------------------------- Pedido de compra Em aberto
-- 247 plus: the pedido de compra lança contas from Em aberto (Origin posts the contas a pagar when the pedido is created).
CREATE OR REPLACE FUNCTION erp_finance.document_preview_data(d erp_documents.document, p_category uuid, p_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare direction text;c erp_catalog.record;g erp_finance.category;issued date;total bigint;amount bigint;due date;part jsonb;parts jsonb:='[]';n integer:=0;sum_cents numeric:=0;source text;r jsonb;
 v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;v_dates text:='nao';v_base date;begin
 if not(case d.kind when 'sales_orders' then d.status in('verified','in_progress','partially_fulfilled','fulfilled')
  when 'purchase_orders' then d.status in('open','in_progress','partially_fulfilled','fulfilled')
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
-- 174 plus: the pedido de compra with contas lançadas Em aberto still moves on to Em andamento, Atendido parcialmente and Atendido.
CREATE OR REPLACE FUNCTION erp_finance.guard_posted_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ begin
 -- 174: a pedido in an active Faturamento agrupado is locked like a pedido with contas lançadas.
 if exists(select 1 from erp_finance.document_posting where document_id=old.id and state='active') or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=old.id and g.active) then
  if tg_op='DELETE' then raise exception 'erp_document_active_finance' using errcode='40001'; end if;
  if (to_jsonb(new)-array['status','version','updated_at','updated_by']) is distinct from (to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not (erp_documents.effects_transition_allowed(old.kind,old.status,new.status)
     or (old.kind='purchase_orders' and old.status='open' and new.status in ('in_progress','partially_fulfilled','fulfilled'))) then
   raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $function$;

revoke all on function erp_finance.commission_invoice(uuid,uuid),erp_finance.commission_capture_invoice_title(uuid),erp_finance.commission_capture_invoice(),
  erp_finance.commission_rows(uuid),erp_finance.document_preview_data(erp_documents.document,uuid,jsonb),erp_finance.guard_posted_document() from public,anon,authenticated,service_role;
commit;
