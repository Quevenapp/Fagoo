-- Reserva integral e explícita de pedido. Não cria saldo inicial nem movimento ao reservar/liberar.
-- Ordem: comando018 -> documento -> reserva -> mutex009 -> catálogo UUID -> posições.
begin;
create table erp_stock.reservation (
 id uuid primary key default gen_random_uuid(),document_id uuid not null references erp_documents.document(id),
 source_document_version integer not null check(source_document_version>0),version integer not null default 1 check(version in(1,2)),
 state text not null default 'active' check(state in('active','released','consumed')),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
 actor uuid not null references auth.users(id),command_id uuid not null unique,created_at timestamptz not null default clock_timestamp(),
 closed_by uuid references auth.users(id),closed_at timestamptz,close_reason text,close_command_id uuid unique,
 consumed_command_id uuid unique references erp_stock.movement(command_id) deferrable initially deferred,
 check((state='active' and version=1 and closed_by is null and closed_at is null and close_reason is null and close_command_id is null and consumed_command_id is null)
  or(state in('released','consumed') and version=2 and closed_by is not null and closed_at is not null and length(close_reason) between 3 and 500 and close_command_id is not null
    and((state='consumed' and consumed_command_id=close_command_id)or(state='released' and consumed_command_id is null))))
);
create unique index erp_stock_one_active_reservation on erp_stock.reservation(document_id) where state='active';
create index erp_stock_reservation_history on erp_stock.reservation(document_id,id);
create table erp_stock.reservation_item (
 reservation_id uuid not null references erp_stock.reservation(id),product_id uuid not null references erp_catalog.product(record_id),
 warehouse_id uuid not null references erp_catalog.warehouse(record_id),unit text not null,
 quantity numeric(18,6) not null check(quantity>0),primary key(reservation_id,product_id,warehouse_id)
);
create index erp_stock_reservation_position on erp_stock.reservation_item(product_id,warehouse_id,reservation_id);
create table erp_stock.reservation_command (
 id uuid primary key,actor uuid not null references auth.users(id),document_id uuid not null references erp_documents.document(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['reservation','reservation_item','reservation_command'] loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end $$;
create trigger immutable_reservation_item before update or delete on erp_stock.reservation_item for each row execute function erp_stock.immutable_ledger();
create trigger immutable_reservation_command before update or delete on erp_stock.reservation_command for each row execute function erp_stock.immutable_ledger();
create function erp_stock.guard_reservation() returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' then raise exception 'erp_stock_reservation_immutable' using errcode='40001';end if;
 if old.state<>'active' or new.state not in('released','consumed') or new.version<>2
  or(to_jsonb(new)-array['state','version','closed_by','closed_at','close_reason','close_command_id','consumed_command_id'])
    is distinct from(to_jsonb(old)-array['state','version','closed_by','closed_at','close_reason','close_command_id','consumed_command_id']) then
  raise exception 'erp_stock_reservation_immutable' using errcode='40001';end if;return new;
end $$;
create trigger immutable_reservation before update or delete on erp_stock.reservation for each row execute function erp_stock.guard_reservation();
create function erp_stock.reserved_quantity(p_product uuid,p_warehouse uuid) returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum(i.quantity),0) from erp_stock.reservation_item i join erp_stock.reservation r on r.id=i.reservation_id
 where r.state='active' and i.product_id=p_product and i.warehouse_id=p_warehouse
$$;
create function erp_stock.reservation_position_hash(p_product uuid,p_warehouse uuid) returns text language sql stable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(r.id,r.version,i.quantity::text,i.unit) order by r.id),'[]')::text,'UTF8')),'hex')
 from erp_stock.reservation_item i join erp_stock.reservation r on r.id=i.reservation_id where r.state='active' and i.product_id=p_product and i.warehouse_id=p_warehouse
$$;
-- Every physical debit, including a reversal of a receipt, must leave active reservations intact.
-- All exposed writers already take mutex009. No direct table grants are added.
create function erp_stock.guard_reserved_balance() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if new.quantity<erp_stock.reserved_quantity(new.product_id,new.warehouse_id) then
  raise exception 'erp_stock_reserved_quantity_unavailable' using errcode='40001';end if;return new;
end $$;
create trigger protect_reserved_balance before update on erp_stock.balance for each row execute function erp_stock.guard_reserved_balance();
create function erp_stock.guard_reserved_document() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_stock.reservation where document_id=old.id and state='active') then
  if tg_op='DELETE' then raise exception 'erp_document_active_reservation' using errcode='40001';end if;
  if(to_jsonb(new)-array['status','version','updated_at','updated_by']) is distinct from(to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not erp_documents.effects_transition_allowed(old.kind,old.status,new.status) then raise exception 'erp_document_active_reservation' using errcode='40001';end if;
 end if;if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger protect_reserved_document before update or delete on erp_documents.document for each row execute function erp_stock.guard_reserved_document();
create function erp_stock.guard_reserved_item() returns trigger language plpgsql security definer set search_path=pg_catalog as $$declare d uuid;begin
 d:=case when tg_op='INSERT' then new.document_id else old.document_id end;
 if exists(select 1 from erp_stock.reservation where state='active' and(document_id=d or(tg_op='UPDATE' and document_id=new.document_id))) then
  raise exception 'erp_document_active_reservation' using errcode='40001';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger protect_reserved_item before insert or update or delete on erp_documents.item for each row execute function erp_stock.guard_reserved_item();
create function erp_stock.guard_reserved_posting() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_stock.reservation where document_id=new.document_id and state='active') then
  raise exception 'erp_stock_use_reservation_consume' using errcode='40001';end if;return new;
end $$;
create trigger protect_reserved_posting before insert on erp_stock.document_posting for each row execute function erp_stock.guard_reserved_posting();
-- Final authorization is checked after all row/mutex waits. Holding the membership
-- row through commit makes a concurrent revocation serialize with the accepted write.
create function erp_stock.reservation_write_access(p_actor uuid) returns void language plpgsql set search_path=pg_catalog as $$begin
 perform 1 from erp_access.membership where user_id=p_actor for share;
 perform erp_stock.require_access(p_actor,true);
end $$;
-- Preserve the exact025 algorithm/result and historic hash. This wrapper adds authorization
-- after the mutex wait and a collision check against commands which do not move physical stock.
create function erp_stock.post_physical_025(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,
  p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_hash text;v_command erp_stock.command%rowtype;v_line jsonb;v_product uuid;v_warehouse uuid;
  v_quantity numeric(18,6);v_unit text;v_kind text;v_format text;v_active boolean;v_warehouse_active boolean;
  v_balance erp_stock.balance%rowtype;v_version integer;v_id uuid;v_result jsonb;v_ordinal integer:=0;
begin
  perform erp_stock.require_access(p_user_id,true);
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
    select p.unit,p.kind,p.format,r.active into v_unit,v_kind,v_format,v_active from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product for update of r,p;
    if not found or v_unit is null or v_kind is distinct from 'P' or (not v_active and p_kind<>'reversal') then
      raise exception 'erp_stock_product_unavailable' using errcode='22023'; end if;
    if p_kind<>'reversal' and v_format in('E','V') then raise exception 'erp_stock_composition_unsupported' using errcode='22023'; end if;
    select r.active into v_warehouse_active from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where w.record_id=v_warehouse for update of r;
    if not found or (not v_warehouse_active and p_kind<>'reversal') then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023'; end if;
    insert into erp_stock.balance(product_id,warehouse_id,unit) values(v_product,v_warehouse,v_unit) on conflict do nothing;
    select * into v_balance from erp_stock.balance where product_id=v_product and warehouse_id=v_warehouse for update;
    if v_balance.version<>v_version or v_balance.version=2147483647 then raise exception 'erp_stock_version_conflict' using errcode='40001'; end if;
    if v_balance.unit<>v_unit then raise exception 'erp_stock_unit_conflict' using errcode='40001'; end if;
    if v_balance.quantity+v_quantity<0 or v_balance.quantity+v_quantity>999999999999.999999 then
      raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023'; end if;
    update erp_stock.balance set quantity=quantity+v_quantity,version=version+1,updated_at=clock_timestamp() where product_id=v_product and warehouse_id=v_warehouse;
    v_ordinal:=v_ordinal+1;
    insert into erp_stock.entry(movement_id,ordinal,product_id,warehouse_id,quantity,unit,balance_after,balance_version)
      values(v_id,v_ordinal,v_product,v_warehouse,v_quantity,v_unit,v_balance.quantity+v_quantity,v_balance.version+1);
  end loop;
  v_result:=jsonb_build_object('movement',erp_stock.movement_dto(v_id),'replayed',false,'data_mode','erp_native');
  insert into erp_stock.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $$;
create or replace function erp_stock.post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$declare result jsonb;begin
 perform erp_stock.require_access(p_user_id,true);perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 if not exists(select 1 from erp_stock.command where id=p_command_id) and exists(select 1 from erp_stock.reservation_command where id=p_command_id) then
  raise exception 'erp_stock_command_conflict' using errcode='40001';end if;
 result:=erp_stock.post_physical_025(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,p_items,p_reverses_id);
 perform erp_stock.reservation_write_access(p_user_id);return result;
end $$;
create function erp_stock.availability(p_product uuid,p_warehouse uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b erp_stock.balance;p erp_catalog.product;q numeric;last_entry erp_stock.entry;state text;begin
 select * into p from erp_catalog.product where record_id=p_product;if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse) then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 select * into b from erp_stock.balance where product_id=p_product and warehouse_id=p_warehouse;
 select * into last_entry from erp_stock.entry where product_id=p_product and warehouse_id=p_warehouse order by balance_version desc limit 1;
 q:=erp_stock.reserved_quantity(p_product,p_warehouse);
 state:=case when b.product_id is null and last_entry.movement_id is null and q=0 then 'no_movements'
  when b.product_id is not null and b.version>0 and p.kind='P' and p.unit is not null and b.unit=p.unit
   and last_entry.balance_version=b.version and last_entry.balance_after=b.quantity and last_entry.unit=b.unit and b.quantity>=q then 'recorded' else 'review_required' end;
 return jsonb_build_object('product_id',p_product,'warehouse_id',p_warehouse,'unit',p.unit,'state',state,'physical_version',coalesce(b.version,0),
  'physical_quantity',case when state='recorded' then b.quantity::text end,'reserved_quantity',q::numeric(18,6)::text,
  'available_quantity',case when state='recorded' then(b.quantity-q)::numeric(18,6)::text end,
  'reservation_hash',erp_stock.reservation_position_hash(p_product,p_warehouse));
end $$;
create function erp_stock.reservation_dto(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'document_id',r.document_id,'source_document_version',r.source_document_version,'version',r.version,
  'state',r.state,'created_at',r.created_at,'occurred_on',r.snapshot->>'occurred_on','reason',r.snapshot->>'reason','warehouse_id',r.snapshot#>'{document,warehouse_id}',
  'positions',r.snapshot->'positions','ignored',r.snapshot->'ignored','closed_at',r.closed_at,'close_reason',r.close_reason,
  'movement_id',(select id from erp_stock.movement where command_id=r.consumed_command_id),
  'posting_id',(select id from erp_stock.document_posting where command_id=r.consumed_command_id)) from erp_stock.reservation r where r.id=p_id
$$;
create function erp_stock.reservation_current(p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('document',erp_stock.document_summary(d.id),'active_reservation',
  (select erp_stock.reservation_dto(id) from erp_stock.reservation where document_id=d.id and state='active'))
 from erp_documents.document d where d.id=p_document and d.kind='sales_orders'
$$;
create function erp_stock.reservation_lock(p_actor uuid,p_document uuid,p_version integer,p_reservation uuid default null,p_reservation_version integer default null)
returns erp_documents.document language plpgsql set search_path=pg_catalog as $$declare d erp_documents.document;r erp_stock.reservation;begin
 d:=erp_stock.document_lock(p_actor,'sales_orders',p_document,p_version);
 if p_reservation is not null then
  select * into r from erp_stock.reservation where id=p_reservation and document_id=d.id for update;
  if not found then raise exception 'erp_stock_reservation_not_found' using errcode='P0002';end if;
  if p_reservation_version is null or p_reservation_version<>r.version or r.state<>'active' then raise exception 'erp_stock_reservation_conflict' using errcode='40001';end if;
 end if;
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_actor,true);return d;
end $$;
create function erp_stock.reservation_preview(d erp_documents.document,p_action text,p_day date,p_reason text,p_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare base jsonb;r erp_stock.reservation;positions jsonb:='[]';ignored jsonb;row jsonb;a jsonb;qty numeric;physical numeric;reserved numeric;available numeric;out jsonb;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if p_action is null or p_action not in('reserve','release','consume') or(p_action='reserve')<>(p_id is null) then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
 if p_action='reserve' then
  if d.status not in('verified','in_progress') or exists(select 1 from erp_stock.reservation where document_id=d.id and state='active') then
   raise exception 'erp_stock_reservation_ineligible' using errcode='40001';end if;
  base:=erp_stock.document_preview_data(d,p_day,p_reason);ignored:=base->'ignored';
 elsif p_action='consume' then
  select * into r from erp_stock.reservation where id=p_id and document_id=d.id and state='active';
  base:=erp_stock.document_preview_data(d,p_day,p_reason);ignored:=base->'ignored';
  if ignored is distinct from r.snapshot->'ignored' or exists(select 1 from jsonb_array_elements(base->'positions') j
    full join (select * from erp_stock.reservation_item where reservation_id=p_id) i on i.product_id=(j->>'product_id')::uuid and i.warehouse_id=(j->>'warehouse_id')::uuid
    where i.reservation_id is null or j is null or i.quantity<>-(j->>'quantity')::numeric or i.unit<>j->>'unit') then
   raise exception 'erp_stock_reservation_content_changed' using errcode='40001';end if;
 else
  select * into r from erp_stock.reservation where id=p_id and document_id=d.id and state='active';
  perform 1 from erp_catalog.record where id in(select product_id from erp_stock.reservation_item where reservation_id=p_id union select warehouse_id from erp_stock.reservation_item where reservation_id=p_id) order by id for update;
  base:=r.snapshot;ignored:=base->'ignored';
 end if;
 if p_action<>'reserve' and(r.id is null or p_day<(r.snapshot->>'occurred_on')::date) then raise exception 'erp_stock_reservation_invalid_date' using errcode='22023';end if;
 for row in select value from jsonb_array_elements(base->'positions') loop
  qty:=abs((row->>'quantity')::numeric);a:=erp_stock.availability((row->>'product_id')::uuid,d.warehouse_id);
  if a->>'state'<>'recorded' then raise exception 'erp_stock_position_unavailable' using errcode='40001';end if;
  physical:=(a->>'physical_quantity')::numeric;reserved:=(a->>'reserved_quantity')::numeric;available:=physical-reserved;
  if(p_action='reserve' and qty>available)or(p_action<>'reserve' and qty>reserved) then raise exception 'erp_stock_available_quantity_insufficient' using errcode='40001';end if;
  positions:=positions||jsonb_build_array(jsonb_build_object('product_id',row->'product_id','product_name',row->'product_name','warehouse_id',d.warehouse_id,
   'unit',row->'unit','quantity',qty::numeric(18,6)::text,'sources',row->'sources','catalog_version',(select version from erp_catalog.record where id=(row->>'product_id')::uuid),
   'physical_version',a->'physical_version','reservation_hash',a->'reservation_hash','physical_before',physical::numeric(18,6)::text,
   'reserved_before',reserved::numeric(18,6)::text,'available_before',available::numeric(18,6)::text,
   'physical_after',(physical-case when p_action='consume' then qty else 0 end)::numeric(18,6)::text,
   'reserved_after',(reserved+case when p_action='reserve' then qty else -qty end)::numeric(18,6)::text,
   'available_after',(available+case when p_action='reserve' then -qty when p_action='release' then qty else 0 end)::numeric(18,6)::text));
 end loop;
 out:=jsonb_build_object('action',p_action,'document',erp_stock.document_summary(d.id),'reservation_id',p_id,
  'reservation_version',case when p_id is not null then r.version end,'occurred_on',p_day,'reason',p_reason,'positions',positions,'ignored',ignored);
 return out||jsonb_build_object('preview_hash',encode(sha256(convert_to(out::text,'UTF8')),'hex'));
end $$;
create function erp_stock.reservation_command_start(p_actor uuid,p_command uuid,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare c erp_stock.reservation_command;h text;begin
 perform erp_stock.require_access(p_actor,true);if p_command is null then raise exception 'erp_stock_command_required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_stock.require_access(p_actor,true);
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'data',p_data)::text,'UTF8')),'hex');
 select * into c from erp_stock.reservation_command where id=p_command;
 if found then if c.actor<>p_actor or c.request_hash<>h then raise exception 'erp_stock_command_conflict' using errcode='40001';end if;return c.result;end if;
 if exists(select 1 from erp_stock.document_command where id=p_command)or exists(select 1 from erp_stock.command where id=p_command) then raise exception 'erp_stock_command_conflict' using errcode='40001';end if;return null;
end $$;
create function public.erp_stock_reservation_preview(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_action text,p_occurred_on date,p_reason text,p_reservation_id uuid default null,p_reservation_version integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare d erp_documents.document;preview jsonb;begin
 if p_action is null or p_action not in('reserve','release','consume') or(p_action='reserve')<>(p_reservation_id is null) or(p_reservation_id is null and p_reservation_version is not null) then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
 d:=erp_stock.reservation_lock(p_user_id,p_document_id,p_expected_version,p_reservation_id,p_reservation_version);
 preview:=erp_stock.reservation_preview(d,p_action,p_occurred_on,p_reason,p_reservation_id);
 perform erp_stock.reservation_write_access(p_user_id);
 return jsonb_build_object('preview',preview,'data_mode','erp_native','scope','stock_reservations');
end $$;
create function public.erp_stock_reservation_apply(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_action text,p_preview_hash text,p_occurred_on date,p_reason text,p_ignored_item_ids jsonb default null,p_reservation_id uuid default null,p_reservation_version integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;receipt jsonb;preview jsonb;rid uuid;ack jsonb;wanted jsonb;physical jsonb;posted jsonb;begin
 if p_action is null or p_action not in('reserve','release','consume') then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
 data:=jsonb_build_object('document_id',p_document_id,'version',p_expected_version,'action',p_action,'preview_hash',p_preview_hash,'occurred_on',p_occurred_on,'reason',p_reason,
  'ignored',p_ignored_item_ids,'reservation_id',p_reservation_id,'reservation_version',p_reservation_version);
 receipt:=erp_stock.reservation_command_start(p_user_id,p_command_id,data);
 if receipt is not null then return jsonb_build_object('receipt',receipt,'current',erp_stock.reservation_current(p_document_id),'replayed',true,'data_mode','erp_native','scope','stock_reservations');end if;
 if p_action is null or p_action not in('reserve','release','consume') or(p_action='reserve')<>(p_reservation_id is null)or(p_reservation_id is null and p_reservation_version is not null) then raise exception 'erp_stock_reservation_invalid_action' using errcode='22023';end if;
 d:=erp_stock.reservation_lock(p_user_id,p_document_id,p_expected_version,p_reservation_id,p_reservation_version);
 -- A manual stock command may have committed while this command waited for mutex009.
 if exists(select 1 from erp_stock.command where id=p_command_id)or exists(select 1 from erp_stock.document_command where id=p_command_id) then raise exception 'erp_stock_command_conflict' using errcode='40001';end if;
 preview:=erp_stock.reservation_preview(d,p_action,p_occurred_on,p_reason,p_reservation_id);
 perform erp_stock.reservation_write_access(p_user_id);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$'or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_stock_reservation_preview_conflict' using errcode='40001';end if;
 if p_action='reserve' then
  if p_ignored_item_ids is null or jsonb_typeof(p_ignored_item_ids)<>'array'or jsonb_array_length(p_ignored_item_ids)>250 then raise exception 'erp_stock_ignored_ack_required' using errcode='22023';end if;
  select coalesce(jsonb_agg(value order by value),'[]')into ack from jsonb_array_elements(p_ignored_item_ids);
  select coalesce(jsonb_agg(value->'id'order by value->'id'),'[]')into wanted from jsonb_array_elements(preview->'ignored');
  if ack<>wanted then raise exception 'erp_stock_ignored_ack_required' using errcode='22023';end if;
  insert into erp_stock.reservation(document_id,source_document_version,snapshot,preview_hash,actor,command_id)
   values(d.id,d.version,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id)returning id into rid;
  insert into erp_stock.reservation_item(reservation_id,product_id,warehouse_id,unit,quantity)
   select rid,(j->>'product_id')::uuid,(j->>'warehouse_id')::uuid,j->>'unit',(j->>'quantity')::numeric from jsonb_array_elements(preview->'positions')j;
 else
  if p_ignored_item_ids is not null then raise exception 'erp_stock_reservation_invalid_ack' using errcode='22023';end if;rid:=p_reservation_id;
  update erp_stock.reservation set state=case when p_action='consume'then 'consumed'else 'released'end,version=2,closed_by=p_user_id,closed_at=clock_timestamp(),
   close_reason=btrim(p_reason),close_command_id=p_command_id,consumed_command_id=case when p_action='consume'then p_command_id end where id=rid;
 end if;
 if p_action='consume' then
  -- Same command lock was acquired BEFORE document/mutex. Deferred FK forces the
  -- consumed command to become an actual movement in this same transaction.
  physical:=erp_stock.document_preview_data(d,p_occurred_on,p_reason);
  select coalesce(jsonb_agg(value->'id'order by value->'id'),'[]')into wanted from jsonb_array_elements(physical->'ignored');
  posted:=public.erp_document_stock_post(p_user_id,'sales_orders',d.id,d.version,p_command_id,physical->>'preview_hash',p_occurred_on,p_reason,wanted);
 else
  update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp()where id=d.id;
 end if;
 receipt:=jsonb_build_object('command_id',p_command_id,'action',p_action,'document_id',d.id,'document_version',d.version+1,'reservation',erp_stock.reservation_dto(rid));
 insert into erp_stock.reservation_command(id,actor,document_id,request_hash,result)values(p_command_id,p_user_id,d.id,
  encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'data',data)::text,'UTF8')),'hex'),receipt);
 insert into erp_documents.audit(actor,command_id,document_id,action,after_data)values(p_user_id,p_command_id,d.id,'stock_reservation_'||p_action,receipt);
 return jsonb_build_object('receipt',receipt,'current',erp_stock.reservation_current(d.id),'replayed',false,'data_mode','erp_native','scope','stock_reservations');
end $$;
create function public.erp_stock_reservation_get(p_user_id uuid,p_document_id uuid,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare items jsonb;more boolean;cursor uuid;begin
 perform erp_stock.require_access(p_user_id,false);
 if p_document_id is null or not exists(select 1 from erp_documents.document where id=p_document_id and kind='sales_orders')then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 with page as materialized(select id from erp_stock.reservation where document_id=p_document_id and(p_after is null or id>p_after)order by id limit p_limit+1),
 shown as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg((erp_stock.reservation_dto(id)-array['positions','ignored'])||jsonb_build_object('positions_count',jsonb_array_length(erp_stock.reservation_dto(id)->'positions'),'ignored_count',jsonb_array_length(erp_stock.reservation_dto(id)->'ignored')) order by id)from shown),'[]'),(select count(*)>p_limit from page),(select id from shown order by id desc limit 1)into items,more,cursor;
 return jsonb_build_object('current',erp_stock.reservation_current(p_document_id),'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor end,'data_mode','erp_native','scope','stock_reservations');
end $$;
create function public.erp_stock_reservation_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_stock.reservation_command;begin
 perform erp_stock.require_access(p_user_id,false);select * into c from erp_stock.reservation_command where id=p_command_id and actor=p_user_id;
 if not found then raise exception 'erp_stock_command_not_found' using errcode='P0002';end if;
 return jsonb_build_object('receipt',c.result,'current',erp_stock.reservation_current(c.document_id),'replayed',true,'data_mode','erp_native','scope','stock_reservations');
end $$;
create function public.erp_stock_availability(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_stock.require_access(p_user_id,false);
 if p_product_id is null or p_warehouse_id is null then raise exception 'erp_stock_invalid_query'using errcode='22023';end if;
 return jsonb_build_object('position',erp_stock.availability(p_product_id,p_warehouse_id),'data_mode','erp_native','scope','stock_availability');
end $$;
revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_reservation_preview','erp_stock_reservation_apply','erp_stock_reservation_get','erp_stock_reservation_command','erp_stock_availability')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end $$;
commit;
