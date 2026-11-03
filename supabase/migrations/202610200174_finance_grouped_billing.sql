-- Financeiro > Faturamento agrupado no padrão do Origin (onda C, lane financeiro), e as preferências de lançamento de contas
-- dos documentos que dependem do financeiro.
-- Faturamento agrupado: os pedidos de venda do período (situação apta ao lançamento, sem contas lançadas e fora de outro
-- faturamento) são agrupados por cliente; "GERAR CONTAS" cria as contas a receber do cliente pela Condição (30, 30 60 90,
-- 3x...), uma conta por prazo, com a soma dos pedidos escolhidos. Os pedidos ficam travados como os pedidos com contas
-- lançadas (017) até "Excluir" o faturamento, que só vale sem baixa nem boleto e cancela as contas. Também "Faturar pedidos
-- selecionados" da listagem de pedidos. As notas fiscais de saída ainda não lançam contas no Brufap e não entram aqui.
-- Lançamento de contas dos documentos (017): "Utilizar número da venda/da OS no número do documento das contas a receber"
-- preenche o Nº documento das contas; "Utilizar data atual no lançamento de contas de ordens de serviço" muda as datas.
begin;

create table erp_finance.grouped_billing (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  contact_id uuid not null references erp_catalog.contact(record_id),
  issued_on date not null check(issued_on between date '1900-01-01' and date '2100-12-31'),
  condition text not null check(length(condition) between 1 and 200 and condition!~'[[:cntrl:]]'),
  total_cents bigint not null check(total_cents between 1 and 999999999999999),
  state text not null default 'active' check(state in ('active','deleted')),
  version integer not null default 1 check(version>0),
  actor uuid not null references auth.users(id), command_id uuid not null, created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz, deleted_by uuid references auth.users(id),
  check((state='deleted')=(deleted_at is not null) and (deleted_at is null)=(deleted_by is null))
);
create index erp_finance_grouped_billing_day on erp_finance.grouped_billing(issued_on,id);
create table erp_finance.grouped_billing_document (
  billing_id uuid not null references erp_finance.grouped_billing(id),
  document_id uuid not null references erp_documents.document(id),
  total_cents bigint not null check(total_cents between 1 and 999999999999999),
  active boolean not null default true,
  primary key(billing_id,document_id)
);
create unique index erp_finance_grouped_billing_one_active on erp_finance.grouped_billing_document(document_id) where active;
create table erp_finance.grouped_billing_title (
  title_id uuid primary key references erp_finance.title(id),
  billing_id uuid not null references erp_finance.grouped_billing(id),
  position integer not null check(position between 1 and 120), unique(billing_id,position)
);
do $$ declare t text; begin foreach t in array array['grouped_billing','grouped_billing_document','grouped_billing_title'] loop
  execute format('alter table erp_finance.%I enable row level security',t);
  execute format('revoke all on erp_finance.%I from public,anon,authenticated,service_role',t);
end loop; end $$;

-- The contas of a faturamento keep the cliente, the valor and the parcela (as the contas of a document, 017).
create function erp_finance.guard_grouped_title()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from erp_finance.grouped_billing_title where title_id=old.id) then
    if tg_op='DELETE' then raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
    if (new.group_id,new.installment,new.installments,new.kind,new.contact_id,new.issued_on,new.amount_cents) is distinct from (old.group_id,old.installment,old.installments,old.kind,old.contact_id,old.issued_on,old.amount_cents) then
      raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
    -- Cancelled or excluded only with its faturamento (Excluir in Listar Faturamentos Gerados).
    if (new.cancelled,new.deleted_at is null) is distinct from (old.cancelled,old.deleted_at is null) and current_setting('erp_finance.grouped_owner',true) is distinct from 'on' then
      raise exception 'erp_finance_source_locked' using errcode='40001'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger protect_grouped_billing_title before update or delete on erp_finance.title for each row execute function erp_finance.guard_grouped_title();

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
   or not erp_documents.effects_transition_allowed(old.kind,old.status,new.status) then raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $function$;

CREATE OR REPLACE FUNCTION erp_finance.guard_posted_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ declare d uuid; begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_finance.document_posting where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id)))
  or exists(select 1 from erp_finance.grouped_billing_document g where g.active and(g.document_id=d or(tg_op='UPDATE' and g.document_id=new.document_id))) then
  raise exception 'erp_document_active_finance' using errcode='40001'; end if;
 if tg_op='DELETE' then return old; end if;return new;
end $function$;

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

-- "Utilizar número da venda / da OS no número do documento das contas a receber": the Nº documento of each conta lançada.
create function erp_finance.document_title_number()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;
begin
  select x.* into d from erp_finance.document_posting p join erp_documents.document x on x.id=p.document_id where p.id=new.posting_id;
  if (d.kind='sales_orders' and coalesce(erp_preferences.get('vendas.numero_documento_conta'),'false'::jsonb)='true'::jsonb)
    or (d.kind='service_orders' and coalesce(erp_preferences.get('os.numero_documento_conta'),'false'::jsonb)='true'::jsonb) then
    update erp_finance.title set source_reference=d.number::text where id=new.title_id and source_reference is null;
  end if;
  return null;
end $$;
create trigger document_title_number after insert on erp_finance.document_title for each row execute function erp_finance.document_title_number();

-- ---------------------------------------------------------------- Pedidos a faturar
-- Eligible pedidos de venda: the situação of the 017 lançamento, total above zero, no active lançamento and no active faturamento.
create function erp_finance.grouped_billing_eligible(p_document erp_documents.document)
returns boolean language sql stable set search_path=pg_catalog as $$
  select p_document.kind='sales_orders' and p_document.status in ('verified','in_progress','partially_fulfilled','fulfilled') and p_document.total>0
    and not exists(select 1 from erp_finance.document_posting p where p.document_id=p_document.id and p.state='active')
    and not exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_document.id and g.active);
$$;
create function erp_finance.grouped_billing_access(p_user uuid,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
  perform erp_finance.require_access(p_user,p_write);
  -- The pedidos are read as the finance lançamento reads them (017).
  perform erp_documents.require_access(p_user,'sales_orders',false);
end $$;

-- Clientes com pedidos no período (data do pedido), or the pedidos chosen in the listagem (Faturar pedidos selecionados).
create function public.erp_finance_grouped_billing_candidates(p_user_id uuid,p_from date default null,p_to date default null,p_documents uuid[] default null,p_query text default null,
  p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.grouped_billing_access(p_user_id,false);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
    or (p_documents is null and (p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 or p_from<date '1900-01-01' or p_to>date '2100-12-31'))
    or (p_documents is not null and (array_ndims(p_documents) is distinct from 1 or cardinality(p_documents) not between 1 and 200 or array_position(p_documents,null) is not null)) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with docs as materialized (
    select d.id,d.contact_id,d.number,(d.body->>'date')::date as day,(d.total*100)::bigint as cents from erp_documents.document d
    where d.kind='sales_orders' and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
  ), clients as materialized (
    select x.contact_id,r.name,count(*) documents,sum(x.cents) cents from docs x join erp_catalog.record r on r.id=x.contact_id
    where v_query is null or strpos(lower(r.name),v_query)>0 group by x.contact_id,r.name
  )
  select (select count(*) from clients),(select coalesce(jsonb_agg(jsonb_build_object('contact_id',c.contact_id,'contact_name',c.name,'documents',c.documents,'total_cents',c.cents::text) order by lower(c.name),c.contact_id),'[]'::jsonb)
    from (select * from clients order by lower(name),contact_id limit p_limit offset (p_page-1)*p_limit) c) into v_total,v_items;
  return jsonb_build_object('entity','grouped_billing_candidates','from',p_from,'to',p_to,'selected',p_documents is not null,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,'data_mode','erp_native');
end $$;
-- Seleção de notas fiscais e vendas: the pedidos of one cliente in the period (or among the chosen ones), up to 500.
create function public.erp_finance_grouped_billing_documents(p_user_id uuid,p_contact uuid,p_from date default null,p_to date default null,p_documents uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_total bigint;
begin
  perform erp_finance.grouped_billing_access(p_user_id,false);
  if p_contact is null or (p_documents is null and (p_from is null or p_to is null or p_from>p_to or p_to-p_from>366))
    or (p_documents is not null and (array_ndims(p_documents) is distinct from 1 or cardinality(p_documents) not between 1 and 200 or array_position(p_documents,null) is not null)) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with docs as materialized (
    select d.id,d.number,d.body->>'date' as day,(d.total*100)::bigint as cents,d.version from erp_documents.document d
    where d.kind='sales_orders' and d.contact_id=p_contact and erp_finance.grouped_billing_eligible(d)
      and (case when p_documents is not null then d.id=any(p_documents) else (d.body->>'date') between p_from::text and p_to::text end)
  ) select (select count(*) from docs),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'number',x.number::text,'date',x.day,'total_cents',x.cents::text,'version',x.version) order by x.day,x.number),'[]'::jsonb)
    from (select * from docs order by day,number limit 500) x) into v_total,v_items;
  return jsonb_build_object('entity','grouped_billing_documents','contact_id',p_contact,'total',v_total,'items',v_items,'data_mode','erp_native');
end $$;

create function erp_finance.grouped_billing_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',b.id,'number',b.number::text,'contact_id',b.contact_id,'contact_name',r.name,'issued_on',b.issued_on,'condition',b.condition,'total_cents',b.total_cents::text,
    'state',b.state,'version',b.version,'created_at',b.created_at,
    'documents',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'number',d.number::text,'total_cents',g.total_cents::text) order by d.number),'[]'::jsonb)
      from erp_finance.grouped_billing_document g join erp_documents.document d on d.id=g.document_id where g.billing_id=b.id),
    'titles',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'position',l.position,'due_on',t.due_on,'amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,'cancelled',t.cancelled) order by l.position),'[]'::jsonb)
      from erp_finance.grouped_billing_title l join erp_finance.title t on t.id=l.title_id where l.billing_id=b.id),
    -- Excluir only while no conta has a baixa (even estornada) or a boleto.
    'deletable',b.state='active' and not exists(select 1 from erp_finance.grouped_billing_title l join erp_finance.settlement s on s.title_id=l.title_id where l.billing_id=b.id)
      and not exists(select 1 from erp_finance.grouped_billing_title l join erp_cnab.billing_title c on c.title_id=l.title_id where l.billing_id=b.id))
  from erp_finance.grouped_billing b join erp_catalog.record r on r.id=b.contact_id where b.id=p_id;
$$;
-- Listar Faturamentos Gerados (os ativos), pela data de geração.
create function public.erp_finance_grouped_billing_page(p_user_id uuid,p_from date default null,p_to date default null,p_query text default null,p_page integer default 1,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_query text:=lower(nullif(btrim(p_query),'')); v_total bigint; v_items jsonb;
begin
  perform erp_finance.grouped_billing_access(p_user_id,false);
  if p_page is null or p_page not between 1 and 100000 or p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]' or (p_from is not null and p_to is not null and p_from>p_to) then
    raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
  with filtered as materialized (
    select b.id,b.issued_on,b.number from erp_finance.grouped_billing b join erp_catalog.record r on r.id=b.contact_id
    where b.state='active' and (p_from is null or b.issued_on>=p_from) and (p_to is null or b.issued_on<=p_to) and (v_query is null or strpos(lower(r.name),v_query)>0)
  ) select (select count(*) from filtered),(select coalesce(jsonb_agg(erp_finance.grouped_billing_view(x.id) order by x.issued_on desc,x.number desc),'[]'::jsonb)
    from (select * from filtered order by issued_on desc,number desc limit p_limit offset (p_page-1)*p_limit) x) into v_total,v_items;
  return jsonb_build_object('entity','grouped_billings','from',p_from,'to',p_to,'page',p_page,'limit',p_limit,'total',v_total,'items',v_items,'data_mode','erp_native');
end $$;

create function public.erp_finance_grouped_billing_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_item jsonb; v_ids uuid[]; v_days integer[]; v_doc erp_documents.document; v_total bigint; v_sum bigint;
  v_billing uuid; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date; v_count integer; v_part bigint; v_title uuid; v_category uuid; v_numbers text; v_created jsonb:='[]'::jsonb;
  v_row erp_finance.grouped_billing%rowtype; v_contact uuid; v_index integer;
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
    -- GERAR CONTAS: each cliente with its pedidos (the total read is the CAS) and the Condição in days after today.
    perform erp_finance.keys(p_data,array['items','category_id']);
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 50 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    v_category:=coalesce(erp_finance.cash_category(p_data->'category_id','receivable'),
      (select d.category_id from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id where d.key='sale' and c.active and c.deleted_at is null));
    -- Lock order of the 017 lançamento: every pedido in UUID order, then the contas.
    select array_agg(x order by x) into v_ids from (select distinct erp_finance.uuid_value(d.id) x from jsonb_array_elements(p_data->'items') i(item), jsonb_array_elements(i.item->'document_ids') d(id)) y;
    if v_ids is null or cardinality(v_ids)>500 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
    perform 1 from erp_documents.document where id=any(v_ids) order by id for update;
    for v_item in select value from jsonb_array_elements(p_data->'items') loop
      perform erp_finance.keys(v_item,array['contact_id','document_ids','total_cents','condition','days']);
      v_contact:=erp_finance.uuid_value(v_item->'contact_id');
      if jsonb_typeof(v_item->'document_ids') is distinct from 'array' or jsonb_array_length(v_item->'document_ids') not between 1 and 200 or jsonb_typeof(v_item->'days') is distinct from 'array'
        or jsonb_array_length(v_item->'days') not between 1 and 120 then raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      select array_agg((value#>>'{}')::integer order by ordinality) into v_days from jsonb_array_elements(v_item->'days') with ordinality
        where jsonb_typeof(value)='number' and (value#>>'{}')~'^[0-9]{1,4}$';
      if coalesce(cardinality(v_days),0)<>jsonb_array_length(v_item->'days') or exists(select 1 from generate_subscripts(v_days,1) k where v_days[k]>3650 or (k>1 and v_days[k]<v_days[k-1])) then
        raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      v_sum:=0; v_numbers:=null;
      for v_doc in select d.* from erp_documents.document d where d.id in (select erp_finance.uuid_value(x) from jsonb_array_elements(v_item->'document_ids') x) order by d.number loop
        if v_doc.contact_id<>v_contact or not erp_finance.grouped_billing_eligible(v_doc) then raise exception 'erp_finance_grouped_billing_document' using errcode='40001'; end if;
        perform erp_documents.require_access(p_user_id,'sales_orders',false);
        v_sum:=v_sum+(v_doc.total*100)::bigint; v_numbers:=concat_ws(', ',v_numbers,v_doc.number::text);
      end loop;
      if (select count(distinct x) from jsonb_array_elements(v_item->'document_ids') x)<>jsonb_array_length(v_item->'document_ids')
        or (select count(*) from erp_documents.document where id in (select erp_finance.uuid_value(x) from jsonb_array_elements(v_item->'document_ids') x))<>jsonb_array_length(v_item->'document_ids') then
        raise exception 'erp_finance_invalid_items' using errcode='22023'; end if;
      v_total:=erp_finance.cents(v_item->'total_cents',false);
      if v_sum<>v_total then raise exception 'erp_finance_grouped_billing_total' using errcode='40001'; end if;
      v_count:=cardinality(v_days);
      if v_total<v_count then raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      if v_today+v_days[v_count]>date '2100-12-31' then raise exception 'erp_finance_invalid_condition' using errcode='22023'; end if;
      insert into erp_finance.grouped_billing(contact_id,issued_on,condition,total_cents,actor,command_id)
        values(v_contact,v_today,erp_finance.cash_text(v_item,'condition',200,true),v_total,p_user_id,p_command_id) returning id into v_billing;
      insert into erp_finance.grouped_billing_document(billing_id,document_id,total_cents)
        select v_billing,d.id,(d.total*100)::bigint from erp_documents.document d where d.id in (select erp_finance.uuid_value(x) from jsonb_array_elements(v_item->'document_ids') x);
      -- Equal parcelas in exact cents, the first ones absorbing the remainder (as Gerar parcelas of the pedido).
      for v_index in 1..v_count loop
        v_part:=v_total/v_count+case when (v_index-1)<v_total%v_count then 1 else 0 end;
        insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents,competence_on)
          values(v_billing,v_index,v_count,'receivable',v_contact,v_category,left('Faturamento agrupado: pedidos nº '||v_numbers,240),v_today,v_today+v_days[v_index],v_part,v_today) returning id into v_title;
        insert into erp_finance.grouped_billing_title(title_id,billing_id,position) values(v_title,v_billing,v_index);
      end loop;
      v_created:=v_created||jsonb_build_array(erp_finance.grouped_billing_view(v_billing));
    end loop;
    v_result:=jsonb_build_object('entity','grouped_billings','items',v_created);

  else
    -- Excluir selecionados (Listar Faturamentos Gerados): the contas without baixa or boleto are cancelled and the pedidos freed.
    perform erp_finance.keys(p_data,array['id','expected_version']);
    select * into v_row from erp_finance.grouped_billing where id=erp_finance.uuid_value(p_data->'id');
    if not found or v_row.state<>'active' then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    perform 1 from erp_documents.document where id in (select document_id from erp_finance.grouped_billing_document where billing_id=v_row.id) order by id for update;
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
    update erp_finance.grouped_billing set state='deleted',deleted_at=clock_timestamp(),deleted_by=p_user_id,version=version+1 where id=v_row.id;
    v_result:=jsonb_build_object('entity','grouped_billings','record',jsonb_build_object('id',v_row.id,'deleted',true));
  end if;

  perform erp_finance.grouped_billing_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.guard_grouped_title(),erp_finance.guard_posted_document(),erp_finance.guard_posted_item(),erp_finance.document_preview_data(erp_documents.document,uuid,jsonb),
  erp_finance.document_title_number(),erp_finance.grouped_billing_eligible(erp_documents.document),erp_finance.grouped_billing_access(uuid,boolean),erp_finance.grouped_billing_view(uuid) from public,anon,authenticated,service_role;
do $$ declare f text; begin
  foreach f in array array['erp_finance_grouped_billing_candidates(uuid,date,date,uuid[],text,integer,integer)','erp_finance_grouped_billing_documents(uuid,uuid,date,date,uuid[])',
    'erp_finance_grouped_billing_page(uuid,date,date,text,integer,integer)','erp_finance_grouped_billing_execute(uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
commit;
