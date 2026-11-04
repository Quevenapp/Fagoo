-- Fix verified source imports without changing manual stock or document policy.
begin;
do $$declare r record;begin
 for r in select * from(values
  ('erp_sync.pull_stock(origin_sync.raw_record)','0cc541985f82cfbe63dd504f4704fa80e7b728315f926134b7c165de0d3c231c'),
  ('erp_sync.pull_title(origin_sync.raw_record)','6726f0288829a5a0b1486c447bea15996c81ba9bef7c4b6bf91c6c2cced09478'),
  ('erp_sync.pull_document(origin_sync.raw_record)','2b714bbe0aa7415a610daf621bb925423418ccb5a753d587db33ae39c5ad7f04'),
  ('erp_stock.post_physical_025(uuid,uuid,text,date,text,text,jsonb,uuid)','3e12674a61f06abb27b9d3eebc1dcf2dae615c5aace111290c09a959910e73a3'),
  ('erp_stock.guard_reserved_balance()','e431bed40d643d059f54beb4b555a75efd588180caaf29bfe6b27980f33166ac'),
  ('erp_stock.guard_negative_insert()','16591c65f066bfc4d61ce690a69a00bf9cb580975f6087f9e8ef8b2613364fbc')
 )v(sig,expected) loop
  if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'origin_sync_019_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- An import receipt authorizes only the exact stock difference observed in the source, in this transaction.
-- This does not activate the company setting that permits new manual negative stock.
create table erp_sync.stock_import(
 command_id uuid not null,product_id uuid not null references erp_catalog.product(record_id),
 warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 source_id text not null,source_version bigint not null,source_hash text not null,
 source_seen_at timestamptz not null,transaction_id bigint not null,
 quantity_before numeric(18,6) not null,quantity_after numeric(18,6) not null,
 balance_version integer not null,created_at timestamptz not null default clock_timestamp(),
 primary key(command_id,product_id,warehouse_id),check(quantity_before<>quantity_after)
);
alter table erp_sync.stock_import enable row level security;
revoke all on erp_sync.stock_import from public,anon,authenticated,service_role;
create trigger immutable_stock_import before update or delete on erp_sync.stock_import
 for each row execute function erp_stock.immutable_ledger();

create function erp_sync.stock_import_allowed(p_command uuid,p_product uuid,p_warehouse uuid,p_delta numeric,p_version integer)
returns boolean language sql stable security definer set search_path=pg_catalog as $$
 select erp_sync.applying() and exists(select 1 from erp_sync.stock_import i
  join origin_sync.raw_record r on r.entity='stock_balances' and r.source_id=i.source_id
   and r.version=i.source_version and r.version_hash=i.source_hash
  where i.command_id=p_command and i.product_id=p_product and i.warehouse_id=p_warehouse
   and i.transaction_id=txid_current() and i.quantity_after-i.quantity_before=p_delta and i.balance_version=p_version)
$$;
revoke all on function erp_sync.stock_import_allowed(uuid,uuid,uuid,numeric,integer) from public,anon,authenticated,service_role;

-- Zero-valued source accounts are real records, but must not create money or a payment.
-- Native user commands continue requiring a positive amount. The private marker cannot be supplied through their DTOs.
alter table erp_finance.title add column origin_zero_source_id text;
alter table erp_finance.title drop constraint title_amount_cents_check;
alter table erp_finance.title add constraint title_amount_cents_check
 check(amount_cents between 1 and 999999999999999 or(amount_cents=0 and origin_zero_source_id is not null));
create function erp_sync.guard_zero_title() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' and old.origin_zero_source_id is not null and new.amount_cents>0
  and new.origin_zero_source_id=old.origin_zero_source_id then new.origin_zero_source_id:=null;end if;
 if new.origin_zero_source_id is not null then
  if new.amount_cents<>0 or new.settled_cents<>0 or not erp_sync.applying()
   or not exists(select 1 from origin_sync.raw_record r where r.entity=case new.kind when 'payable' then 'payables' else 'receivables' end
    and r.source_id=new.origin_zero_source_id and erp_sync.origin_number(r.payload->'valor')::numeric=0
    and erp_sync.origin_number(r.payload->'saldo')::numeric=0) then
   raise exception 'ZERO_TITLE_SOURCE_REQUIRED' using errcode='22023'; end if;
 end if;
 return new;
end$$;
create trigger guard_zero_title before insert or update of amount_cents,settled_cents,origin_zero_source_id on erp_finance.title
 for each row execute function erp_sync.guard_zero_title();
revoke all on function erp_sync.guard_zero_title() from public,anon,authenticated,service_role;

-- Preserve a syntactically valid source due date exactly, including a year outside the input form's range.
-- Do not guess a corrected year. Issuance/competence and manual command validation remain unchanged.
create function erp_sync.source_due_date(v jsonb) returns date
language plpgsql immutable set search_path=pg_catalog as $$
declare d date;begin
 if jsonb_typeof(v) is distinct from 'string' or v#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null;end if;
 d:=(v#>>'{}')::date;
 if not isfinite(d) or d<date '1900-01-01' then return null;end if;
 return d;
exception when datetime_field_overflow or invalid_datetime_format then return null;
end$$;
revoke all on function erp_sync.source_due_date(jsonb) from public,anon,authenticated,service_role;

-- Empty source documents with an explicit zero total can be received without inventing an item.
-- Use the already-supported empty-body validation of service orders only inside the private importer.
create function erp_sync.normalize_document(p_kind text,p_body jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare result jsonb;begin
 if p_kind in('sales_orders','sales_proposals','purchase_orders') and p_body->'items'='[]'::jsonb then
  result:=erp_documents.normalize('service_orders',p_body);
  if (result#>>'{totals,total}')::numeric<>0 then raise exception 'ITEMS_UNAVAILABLE' using errcode='22023';end if;
  return result;
 end if;
 return erp_documents.normalize(p_kind,p_body);
end$$;
revoke all on function erp_sync.normalize_document(text,jsonb) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION erp_stock.post_physical_025(p_user_id uuid, p_command_id uuid, p_kind text, p_occurred_on date, p_reason text, p_reference text, p_items jsonb, p_reverses_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare v_hash text;v_command erp_stock.command%rowtype;v_line jsonb;v_product uuid;v_warehouse uuid;
  v_quantity numeric(18,6);v_unit text;v_kind text;v_format text;v_active boolean;v_warehouse_active boolean;
  v_balance erp_stock.balance%rowtype;v_version integer;v_id uuid;v_result jsonb;v_ordinal integer:=0;v_free boolean; v_import boolean;
begin
  perform erp_stock.require_access(p_user_id,true);
  -- 182: a reversal, or the compensation adjustment that erp_stock_reverse marks for this very command, is not refused for an
  -- inactive product or warehouse nor for a product that became a composition after the original lançamento.
  v_free:=p_kind='reversal' or(p_kind='adjustment' and btrim(coalesce(p_reason,''))='Estorno anterior ao balanço: saldo atual mantido'
    and p_command_id is not null and coalesce(current_setting('erp_stock.reversal_compensation',true),'')=p_command_id::text);
  if p_command_id is null or p_kind is null or p_kind not in ('receipt','issue','adjustment','transfer','reversal')
    or p_occurred_on is null or not isfinite(p_occurred_on) or p_occurred_on<date '1900-01-01'
    or p_occurred_on>(clock_timestamp() at time zone 'America/Sao_Paulo')::date
    or p_reason is null or length(btrim(p_reason)) not between 3 and 500 or p_reason ~ '[[:cntrl:]]'
    or length(p_reference)>100 or p_reference ~ '[[:cntrl:]]'
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
    or octet_length(p_items::text)>65536 or ((p_kind='reversal')<>(p_reverses_id is not null)) then
    raise exception 'erp_stock_invalid_command' using errcode='22023';
  end if;
  for v_line in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_line)<>'object' or jsonb_typeof(v_line->'product_id') is distinct from 'string'
      or jsonb_typeof(v_line->'warehouse_id') is distinct from 'string'
      or coalesce(v_line->>'product_id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(v_line->>'warehouse_id','')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or jsonb_typeof(v_line->'quantity') is distinct from 'string'
      or coalesce(v_line->>'quantity','')!~'^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$'
      or jsonb_typeof(v_line->'expected_version') is distinct from 'number'
      or coalesce(v_line->>'expected_version','')!~'^[0-9]{1,10}$'
      or exists(select 1 from jsonb_object_keys(v_line) k where k not in ('product_id','warehouse_id','quantity','expected_version')) then
      raise exception 'erp_stock_invalid_line' using errcode='22023';
    end if;
    if (v_line->>'quantity')::numeric=0 or (v_line->>'expected_version')::bigint>2147483647
      or (p_kind='receipt' and (v_line->>'quantity')::numeric<0)
      or (p_kind='issue' and (v_line->>'quantity')::numeric>0) then
      raise exception 'erp_stock_invalid_quantity' using errcode='22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_items) j group by (j->>'product_id')::uuid,(j->>'warehouse_id')::uuid having count(*)>1) then
    raise exception 'erp_stock_duplicate_position' using errcode='22023';
  end if;
  if p_kind='transfer' and (jsonb_array_length(p_items)<>2
    or (select count(distinct (j->>'product_id')::uuid) from jsonb_array_elements(p_items) j)<>1
    or (select sum((j->>'quantity')::numeric) from jsonb_array_elements(p_items) j)<>0) then
    raise exception 'erp_stock_invalid_transfer' using errcode='22023';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'kind',p_kind,'occurred_on',p_occurred_on,
    'reason',p_reason,'reference',p_reference,'items',p_items,'reverses_id',p_reverses_id)::text,'UTF8')),'hex');
  -- Single-company serialization is deliberate; avoids opposite-transfer deadlocks.
  perform pg_advisory_xact_lock(174852909,0);
  select * into v_command from erp_stock.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_stock_command_conflict' using errcode='40001'; end if;
    return v_command.result||'{"replayed":true}'::jsonb;
  end if;
  if p_kind='reversal' then
    if not exists(select 1 from erp_stock.movement where id=p_reverses_id and kind<>'reversal') then
      raise exception 'erp_stock_movement_not_found' using errcode='P0002'; end if;
    if exists(select 1 from erp_stock.movement where reverses_id=p_reverses_id) then
      raise exception 'erp_stock_already_reversed' using errcode='40001'; end if;
    if p_occurred_on<(select occurred_on from erp_stock.movement where id=p_reverses_id) then
      raise exception 'erp_stock_reversal_date_invalid' using errcode='22023'; end if;
  end if;
  insert into erp_stock.movement(kind,occurred_on,reason,reference,actor,command_id,reverses_id)
    values(p_kind,p_occurred_on,btrim(p_reason),nullif(btrim(p_reference),''),p_user_id,p_command_id,p_reverses_id) returning id into v_id;
  for v_line in select value from jsonb_array_elements(p_items) order by (value->>'product_id')::uuid,(value->>'warehouse_id')::uuid loop
    v_product:=(v_line->>'product_id')::uuid;v_warehouse:=(v_line->>'warehouse_id')::uuid;
    v_quantity:=(v_line->>'quantity')::numeric(18,6);v_version:=(v_line->>'expected_version')::integer;
    v_import:=p_kind='adjustment' and p_user_id=erp_sync.actor()
      and erp_sync.stock_import_allowed(p_command_id,v_product,v_warehouse,v_quantity,v_version);
    select p.unit,p.kind,p.format,r.active into v_unit,v_kind,v_format,v_active from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product for update of r,p;
    if not found or v_unit is null or v_kind is distinct from 'P' or (not v_active and not v_free and not v_import) then
      raise exception 'erp_stock_product_unavailable' using errcode='22023'; end if;
    -- 222: only a Físico composition with a structure has a stock of its own.
    if not v_free and not v_import and(v_format='V' or(v_format='E' and not erp_stock.composition_own_stock(v_product)))then raise exception 'erp_stock_composition_unsupported' using errcode='22023'; end if;
    select r.active into v_warehouse_active from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where w.record_id=v_warehouse for update of r;
    if not found or (not v_warehouse_active and not v_free and not v_import) then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023'; end if;
    insert into erp_stock.balance(product_id,warehouse_id,unit) values(v_product,v_warehouse,v_unit) on conflict do nothing;
    select * into v_balance from erp_stock.balance where product_id=v_product and warehouse_id=v_warehouse for update;
    if v_balance.version<>v_version or v_balance.version=2147483647 then raise exception 'erp_stock_version_conflict' using errcode='40001'; end if;
    if v_balance.unit<>v_unit then raise exception 'erp_stock_unit_conflict' using errcode='40001'; end if;
    -- 100: only a decrease is refused for ending below zero, and only while the company policy forbids it.
    if v_balance.quantity+v_quantity>999999999999.999999 or v_balance.quantity+v_quantity<-999999999999.999999
      or (v_quantity<0 and v_balance.quantity+v_quantity<0 and not erp_stock.negative_allowed() and not v_import) then
      raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023'; end if;
    update erp_stock.balance set quantity=quantity+v_quantity,version=version+1,updated_at=clock_timestamp() where product_id=v_product and warehouse_id=v_warehouse;
    v_ordinal:=v_ordinal+1;
    insert into erp_stock.entry(movement_id,ordinal,product_id,warehouse_id,quantity,unit,balance_after,balance_version)
      values(v_id,v_ordinal,v_product,v_warehouse,v_quantity,v_unit,v_balance.quantity+v_quantity,v_balance.version+1);
  end loop;
  v_result:=jsonb_build_object('movement',erp_stock.movement_dto(v_id),'replayed',false,'data_mode','erp_native');
  insert into erp_stock.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $function$
;
CREATE OR REPLACE FUNCTION erp_stock.guard_reserved_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$declare q numeric;begin
 q:=erp_stock.reserved_quantity(new.product_id,new.warehouse_id);
 if q>0 and new.quantity<q then
  raise exception 'erp_stock_reserved_quantity_unavailable' using errcode='40001';end if;
 if new.quantity<0 and new.quantity<old.quantity and not erp_stock.negative_allowed()
  and not exists(select 1 from erp_sync.stock_import i where i.transaction_id=txid_current()
   and i.product_id=new.product_id and i.warehouse_id=new.warehouse_id
   and i.quantity_before=old.quantity and i.quantity_after=new.quantity
   and i.balance_version=old.version and new.version=old.version+1) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION erp_stock.guard_negative_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$begin
 if tg_table_name='balance' then
  if new.quantity<0 and not erp_stock.negative_allowed() then
   raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 elsif new.quantity<0 and new.balance_after<0 and not erp_stock.negative_allowed()
  and not exists(select 1 from erp_sync.stock_import i join erp_stock.movement m on m.command_id=i.command_id
   where m.id=new.movement_id and m.actor=erp_sync.actor() and m.kind='adjustment'
    and i.transaction_id=txid_current() and i.product_id=new.product_id and i.warehouse_id=new.warehouse_id
    and i.quantity_after=new.balance_after and i.quantity_after-i.quantity_before=new.quantity
    and i.balance_version+1=new.balance_version) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 return new;
end$function$
;
CREATE OR REPLACE FUNCTION erp_sync.pull_stock(s origin_sync.raw_record)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_product uuid:=erp_sync.local_id('products',erp_sync.origin_ref(s.payload#>'{produto,id}')); dep jsonb; v_warehouse uuid; v_origin numeric;
 b erp_stock.balance; v_delta numeric; v_items jsonb:='[]'; v_pair erp_sync.stock_pair; v_skipped integer:=0; v_actor uuid:=erp_sync.actor(); v_command uuid:=gen_random_uuid(); v_line jsonb;
begin
 if v_product is null then raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
 perform pg_advisory_xact_lock(174852909,0);
 if s.entity<>'stock_balances' or not exists(select 1 from origin_sync.raw_record r
  where r.entity=s.entity and r.source_id=s.source_id and r.version=s.version and r.version_hash=s.version_hash and r.payload=s.payload) then
  raise exception 'STOCK_SOURCE_CHANGED' using errcode='40001'; end if;
 if not exists(select 1 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product and p.kind='P' and coalesce(p.format,'S')<>'V' and p.unit is not null) then
  return 'not_stocked'; end if;
 for dep in select value from jsonb_array_elements(case when jsonb_typeof(s.payload->'depositos')='array' then s.payload->'depositos' else '[]'::jsonb end) loop
  select warehouse_id into v_warehouse from erp_warehouse_import.binding where source_id=erp_sync.origin_ref(dep->'id') order by imported_at desc limit 1;
  v_origin:=erp_sync.origin_number(dep->'saldoFisico')::numeric;
  if v_warehouse is null or v_origin is null then continue; end if;
  select * into v_pair from erp_sync.stock_pair where product_id=v_product and warehouse_id=v_warehouse;
  -- Movimento do Brufap ainda não enviado, ou leitura anterior ao último envio: o saldo do Origin ainda não o contém.
  if exists(select 1 from erp_sync.outbox o where o.entity='stock' and o.state in('pending','sending')
     and (o.detail->>'product_id')::uuid=v_product and (o.detail->>'warehouse_id')::uuid=v_warehouse)
   or (v_pair.last_push_at is not null and s.last_seen_at<v_pair.last_push_at) then v_skipped:=v_skipped+1; continue; end if;
  select * into b from erp_stock.balance where product_id=v_product and warehouse_id=v_warehouse;
  v_delta:=round(v_origin-coalesce(b.quantity,0),6);
  if v_delta<>0 then
   v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_product,'warehouse_id',v_warehouse,'quantity',v_delta::text,'expected_version',coalesce(b.version,0)));
  end if;
  insert into erp_sync.stock_pair(product_id,warehouse_id,last_pull_at) values(v_product,v_warehouse,clock_timestamp())
  on conflict(product_id,warehouse_id) do update set last_pull_at=excluded.last_pull_at;
 end loop;
 if jsonb_array_length(v_items)>0 then
  for v_line in select value from jsonb_array_elements(v_items) loop
   insert into erp_sync.stock_import(command_id,product_id,warehouse_id,source_id,source_version,source_hash,
    source_seen_at,transaction_id,quantity_before,quantity_after,balance_version)
   select v_command,(v_line->>'product_id')::uuid,(v_line->>'warehouse_id')::uuid,s.source_id,s.version,s.version_hash,
    s.last_seen_at,txid_current(),coalesce(sb.quantity,0),coalesce(sb.quantity,0)+(v_line->>'quantity')::numeric,(v_line->>'expected_version')::integer
   from (select 1) x left join erp_stock.balance sb on sb.product_id=(v_line->>'product_id')::uuid and sb.warehouse_id=(v_line->>'warehouse_id')::uuid;
  end loop;
  perform erp_sync.set_applying(true);
  perform erp_stock.post(v_actor,v_command,'adjustment',(clock_timestamp() at time zone 'America/Sao_Paulo')::date,'Saldo sincronizado com o Origin',
   left('Origin '||(s.payload#>>'{produto,id}'),100),v_items);
  perform erp_sync.set_applying(false);
 end if;
 -- O envio pendente relê o saldo do Origin depois de confirmado (erp_sync_stage), e essa nova leitura volta para cá.
 if v_skipped=0 then perform erp_sync.resolve_issues('pull',s.entity,null,s.source_id); end if;
 return case when jsonb_array_length(v_items)>0 then 'adjusted' when v_skipped>0 then 'waiting_push' else 'unchanged' end;
end$function$
;
CREATE OR REPLACE FUNCTION erp_sync.pull_title(s origin_sync.raw_record)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_kind text:=case s.entity when 'receivables' then 'receivable' else 'payable' end; v_id uuid:=erp_sync.local_id(s.entity,s.source_id);
 v_remote timestamptz:=coalesce(s.source_updated_at,s.changed_at); t erp_finance.title; v_contact uuid; v_party text; v_amount bigint; v_paid bigint;
 v_situation text:=s.payload->>'situacao'; v_due date; v_issued date; v_actor uuid:=erp_sync.actor(); v_deleted boolean; v_account uuid; v_delta bigint;
 st erp_finance.settlement; v_result text:='updated'; v_category uuid; v_method uuid;
begin
 v_deleted:=coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if v_id is not null then
  select * into t from erp_finance.title where id=v_id for update;
  if not found then v_id:=null; end if;
 end if;
 if v_id is not null then
  if erp_sync.local_newer(s.entity,v_id,v_remote) then return 'local_newer'; end if;
  perform erp_sync.local_superseded(s.entity,v_id);
 elsif v_deleted then return 'deleted_unknown';
 end if;
 perform erp_sync.set_applying(true);
 if v_deleted or v_situation='5' then
  if v_id is not null and not t.cancelled then
   update erp_finance.title set cancelled=true,deleted_at=case when v_deleted then clock_timestamp() end,deleted_by=case when v_deleted then v_actor end,
    deleted_note=case when v_deleted then 'Excluída no Origin' end,version=version+1,updated_at=clock_timestamp() where id=v_id;
  end if;
  if v_id is not null then perform erp_sync.mark_pulled(s.entity,v_id,s,v_deleted); end if;
  perform erp_sync.set_applying(false);
  if v_id is null and not v_deleted and v_situation='5' then return 'cancelled_unknown'; end if;
  return 'cancelled';
 end if;
 v_party:=erp_sync.origin_ref(s.payload#>'{contato,id}');
 v_contact:=erp_sync.local_id('contacts',v_party);
 if v_contact is null then
  if exists(select 1 from erp_sync.inbox where entity='contacts' and source_id=v_party) then raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  raise exception 'CONTACT_NOT_IN_ORIGIN_SYNC' using errcode='22023';
 end if;
 v_amount:=erp_sync.cents(s.payload->'valor');
 if v_amount is null or v_amount<0 or (v_amount=0 and
  (erp_sync.origin_number(s.payload->'valor')::numeric is distinct from 0
   or erp_sync.origin_number(s.payload->'saldo')::numeric is distinct from 0)) then
  raise exception 'AMOUNT_INVALID' using errcode='22023'; end if;
 v_due:=erp_sync.source_due_date(s.payload->'vencimento');
 v_issued:=least(coalesce(erp_fiscal_invoices.origin_date(s.payload->'dataEmissao'),v_due),v_due);
 if v_due is null then raise exception 'DUE_DATE_INVALID' using errcode='22023'; end if;
 v_category:=erp_sync.category_native(erp_sync.origin_ref(s.payload#>'{categoria,id}'),v_kind);
 v_method:=erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>'{formaPagamento,id}'));
 if v_id is null then
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents,
   competence_on,original_due_on,payment_method_id,bank_number,origin_zero_source_id)
  values(gen_random_uuid(),1,1,v_kind,v_contact,v_category,left(coalesce(nullif(btrim(s.payload->>'historico'),''),'Conta do Origin '||s.source_id),240),
   left(s.payload->>'numeroDocumento',200),v_issued,v_due,v_amount,coalesce(erp_fiscal_invoices.origin_date(s.payload->'competencia'),v_issued),
   coalesce(erp_fiscal_invoices.origin_date(s.payload->'vencimentoOriginal'),v_due),v_method,nullif(btrim(left(regexp_replace(s.payload->>'numeroBanco','[[:cntrl:]]','','g'),40)),''),case when v_amount=0 then s.source_id end)
  returning * into t;
  v_id:=t.id; v_result:='created';
 else
  update erp_finance.title set contact_id=v_contact,due_on=v_due,issued_on=v_issued,
   amount_cents=case when settled_cents<=v_amount then v_amount else amount_cents end,
   origin_zero_source_id=case when v_amount=0 then s.source_id end,cancelled=false,
   category_id=coalesce(v_category,category_id),payment_method_id=coalesce(v_method,payment_method_id),
   description=left(coalesce(nullif(btrim(s.payload->>'historico'),''),description),240),source_reference=coalesce(left(s.payload->>'numeroDocumento',200),source_reference),
   competence_on=coalesce(erp_fiscal_invoices.origin_date(s.payload->'competencia'),competence_on),
   version=version+1,updated_at=clock_timestamp() where id=v_id returning * into t;
 end if;
 -- Valor pago no Origin: valor - saldo (situações 2 pago, 3 parcial, 7 confirmado); aberto sem saldo informado é zero.
 v_paid:=case when v_situation in('2','7') then coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),v_amount)
  when v_situation='3' then coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),t.settled_cents) else coalesce(v_amount-erp_sync.cents(s.payload->'saldo'),0) end;
 v_paid:=greatest(0,least(v_paid,v_amount));
 v_delta:=v_paid-t.settled_cents;
 if v_delta>0 then
  v_account:=erp_sync.account_native(erp_sync.origin_ref(s.payload#>'{portador,id}'));
  -- Sem conta financeira no Brufap a baixa não tem onde entrar: a conta volta para a fila e a pendência aparece na tela.
  if v_account is null then raise exception 'NO_FINANCE_ACCOUNT_FOR_SETTLEMENT' using errcode='55000'; end if;
  -- Conta que já chega paga: a data é a do pagamento informado (ou o vencimento), não a de hoje, para não jogar o histórico
  -- no caixa do dia. Pagamento observado depois: a data da observação.
  perform public.erp_finance_execute(v_actor,gen_random_uuid(),'settle',jsonb_build_object('id',v_id,'expected_version',t.version,'account_id',v_account,
   'posted_on',(case when v_result='created' then least(greatest(coalesce(erp_fiscal_invoices.origin_date(s.payload->'dataPagamento'),v_due),t.issued_on),current_date)
    else greatest(current_date,t.issued_on) end)::text,'principal_cents',v_delta::text,'note','Baixa registrada no Origin'));
 elsif v_delta<0 then
  -- Estorno no Origin: estorna as baixas mais recentes até o valor pago voltar ao do Origin.
  for st in select * from erp_finance.settlement x where x.title_id=v_id and x.kind='payment'
   and not exists(select 1 from erp_finance.settlement r where r.reverses_id=x.id) order by x.posted_on desc,x.created_at desc loop
   exit when (select settled_cents from erp_finance.title where id=v_id)<=v_paid;
   perform public.erp_finance_execute(v_actor,gen_random_uuid(),'reverse',jsonb_build_object('id',v_id,'expected_version',(select version from erp_finance.title where id=v_id),
    'settlement_id',st.id,'posted_on',greatest(current_date,st.posted_on)::text,'note','Baixa estornada no Origin'));
  end loop;
 end if;
 perform erp_sync.mark_pulled(s.entity,v_id,s,false);
 perform erp_sync.set_applying(false);
 return v_result;
end$function$
;
CREATE OR REPLACE FUNCTION erp_sync.pull_document(s origin_sync.raw_record)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_id uuid:=erp_sync.local_id(s.entity,s.source_id); v_remote timestamptz:=coalesce(s.source_updated_at,s.changed_at);
 v_plan jsonb; v_body jsonb; v_items jsonb:='[]'; v_data jsonb; v_row jsonb; v_raw jsonb; v_status text; v_contact uuid; v_party text;
 d erp_documents.document; v_actor uuid:=erp_sync.actor(); v_deleted boolean; v_number bigint; v_item_ids uuid[]; v_before jsonb; v_product uuid; v_pos integer:=0;
 v_inst jsonb;
begin
 v_deleted:=coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if v_id is not null then
  select * into d from erp_documents.document where id=v_id for update;
  if not found then v_id:=null; end if;
 end if;
 if v_id is not null then
  if erp_sync.local_newer(s.entity,v_id,v_remote) then return 'local_newer'; end if;
  perform erp_sync.local_superseded(s.entity,v_id);
 elsif v_deleted then return 'deleted_unknown';
 end if;
 if v_deleted then
  perform erp_sync.set_applying(true);
  if d.deleted_at is null then
   update erp_documents.document set deleted_at=clock_timestamp(),deleted_by=v_actor,delete_reason='Excluído no Origin',version=version+1,
    updated_at=clock_timestamp(),updated_by=v_actor where id=v_id;
  end if;
  perform erp_sync.mark_pulled(s.entity,v_id,s,true); perform erp_sync.set_applying(false);
  return 'deleted';
 end if;
 v_party:=erp_documents.origin_import_id(case when s.entity='purchase_orders' then coalesce(s.payload#>'{fornecedor,id}',s.payload#>'{contato,id}') else s.payload#>'{contato,id}' end);
 v_contact:=erp_sync.local_id('contacts',v_party);
 if v_contact is null then
  if exists(select 1 from erp_sync.inbox where entity='contacts' and source_id=v_party) then raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  raise exception 'CONTACT_NOT_IN_ORIGIN_SYNC' using errcode='22023';
 end if;
 v_plan:=erp_document_mirror.plan(row(s.entity,s.source_id,s.version,s.version_hash,s.payload,s.document_links,s.price_capture,s.last_seen_at,s.source_updated_at)::erp_document_mirror.source_version);
 for v_row in select value from jsonb_array_elements(v_plan->'items') loop
  v_pos:=v_pos+1;
  v_raw:=s.payload#>(string_to_array(trim(both '/' from v_row->>'source_path'),'/'));
  v_product:=erp_sync.local_id('products',v_row->>'source_id');
  if v_product is null and v_row->>'source_id' is not null and exists(select 1 from erp_sync.inbox where entity='products' and source_id=v_row->>'source_id') then
   raise exception 'DEPENDENCY_PENDING' using errcode='55000'; end if;
  if v_product is not null and not exists(select 1 from erp_catalog.record r where r.id=v_product and r.active) then v_product:=null; end if;
  if coalesce((v_row->>'quantity')::numeric,0)<=0 then continue; end if;
  v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',v_product,
   'description',coalesce(left(v_row->>'description',200),'Item '||v_pos),'code',left(v_row->>'code',100),'unit',coalesce(left(v_row->>'unit',16),'UN'),
   'quantity',round((v_row->>'quantity')::numeric,6)::text,'unit_price',round(coalesce((v_row->>'unit_price')::numeric,0),10)::text,
   'discount_percent',case when erp_sync.origin_number(v_raw->'desconto')::numeric between 0 and 100 then round(erp_sync.origin_number(v_raw->'desconto')::numeric,4)::text else '0' end,
   'detailed_description',v_row->>'detailed_description')));
 end loop;
 v_items:=erp_sync.origin_item_discounts(s.payload,v_items);
 if jsonb_array_length(v_items)=0 and s.entity<>'service_orders' and
  (jsonb_typeof(s.payload->'itens') is distinct from 'array'
   or erp_sync.origin_number(s.payload->'total')::numeric is distinct from 0
   or exists(select 1 from jsonb_array_elements(v_plan->'items') j where (j->>'quantity')::numeric is distinct from 0)) then
  raise exception 'ITEMS_UNAVAILABLE' using errcode='22023'; end if;
 v_body:=jsonb_strip_nulls(jsonb_build_object('date',coalesce(v_plan#>>'{body,date}',(d.body->>'date'),current_date::text),'contact_id',v_contact,
  'expected_date',v_plan#>>'{body,expected_date}','next_contact',v_plan#>>'{body,next_contact}',
  'notes',v_plan#>>'{body,notes}','internal_notes',v_plan#>>'{body,internal_notes}','delivery_terms',v_plan#>>'{body,delivery_terms}',
  'discount_mode','amount','discount_value',coalesce(round((v_plan#>>'{body,discount_value}')::numeric,2)::text,'0'),
  'freight',coalesce(round((v_plan#>>'{body,freight}')::numeric,2)::text,'0'),'other_expenses',coalesce(round((v_plan#>>'{body,other_expenses}')::numeric,2)::text,'0')))
  ||jsonb_build_object('items',v_items)
  ||case when s.entity='service_orders' then jsonb_strip_nulls(jsonb_build_object('equipment',left(v_plan#>>'{body,equipment}',200),'serial_number',left(v_plan#>>'{body,serial_number}',100),
   'technician',left(v_plan#>>'{body,technician}',200),'defect',v_plan#>>'{body,defect}')) else '{}'::jsonb end;
 -- Desconto em percentual no Origin (desconto.unidade='PERCENTUAL').
 if s.payload#>>'{desconto,unidade}'='PERCENTUAL' then v_body:=v_body||jsonb_build_object('discount_mode','percent'); end if;
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('due_date',x->>'due_date','amount',round((x->>'amount')::numeric,2)::text,'note',x->>'note',
  'payment_method_id',erp_sync.payment_method_native(erp_sync.origin_ref(s.payload#>array['parcelas',(n-1)::text,'formaPagamento','id']))))order by n),'[]'::jsonb)
 into v_inst from jsonb_array_elements(v_plan#>'{body,installments}') with ordinality t(x,n) where (x->>'amount')::numeric>0 and x->>'due_date' is not null;
 begin
  v_data:=erp_sync.normalize_document(s.entity,v_body||jsonb_build_object('installments',v_inst));
 exception when sqlstate '22023' then
  -- Parcelas que não fecham com o total no Origin: o documento entra sem parcelas, com pendência registrada.
  v_data:=erp_sync.normalize_document(s.entity,v_body);
  if jsonb_array_length(v_inst)>0 then perform erp_sync.note_issue('pull',s.entity,v_id,s.source_id,'INSTALLMENTS_NOT_APPLIED'); end if;
 end;
 v_status:=coalesce(erp_sync.native_status(s.entity,s.payload),case when d.authority='brufap' then d.status end,erp_documents.initial_status(s.entity));
 if erp_sync.native_status(s.entity,s.payload) is null then
  perform erp_sync.note_issue('pull',s.entity,v_id,s.source_id,'STATUS_UNMAPPED',erp_sync.origin_status(s.entity,s.payload)); end if;
 v_number:=nullif(erp_document_mirror.decimal(s.payload->'numero',0,10),'0')::bigint;
 if v_number is null and v_id is null then v_number:=erp_documents.next_number(s.entity); end if;
 perform erp_sync.set_applying(true);
 if v_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
  values(s.entity,v_number,v_status,v_contact,null,erp_catalog.dto(v_contact),v_data-'items',(v_data#>>'{totals,total}')::numeric,v_actor,v_actor,'origin','brufap')
  returning id into v_id;
 else
  v_before:=to_jsonb(d);
  if d.deleted_at is not null then
   update erp_documents.document set deleted_at=null,deleted_by=null,delete_reason=null,version=version+1,updated_at=clock_timestamp(),updated_by=v_actor where id=v_id;
  end if;
  update erp_documents.document set number=coalesce(v_number,number),status=v_status,contact_id=v_contact,
   contact_snapshot=case when contact_id=v_contact and authority='brufap' then contact_snapshot else erp_catalog.dto(v_contact) end,
   -- Campos que só o Brufap conhece (vendedor, condições comerciais, campos extras) ficam; os do Origin são substituídos.
   body=case when authority='brufap' then body else '{}'::jsonb end||(v_data-'items'),total=(v_data#>>'{totals,total}')::numeric,
   authority='brufap',version=version+1,updated_by=v_actor,updated_at=clock_timestamp() where id=v_id;
 end if;
 -- Mantém os IDs dos itens pela posição, para não quebrar vínculos de reserva, lote e nota por item.
 select array_agg(id order by position) into v_item_ids from erp_documents.item where document_id=v_id;
 select coalesce(jsonb_agg(x||jsonb_build_object('id',v_item_ids[n]) order by n),'[]'::jsonb) into v_items
 from jsonb_array_elements(v_data->'items') with ordinality t(x,n);
 perform erp_documents.replace_items(v_id,v_items);
 perform erp_sync.fill_item_snapshots(v_id);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
 values(v_actor,gen_random_uuid(),v_id,'origin_sync','Sincronização com o Origin',v_before,erp_documents.dto(v_id));
 perform erp_sync.mark_pulled(s.entity,v_id,s,false);
 perform erp_sync.set_applying(false);
 return case when v_before is null then 'created' else 'updated' end;
end$function$
;

commit;
