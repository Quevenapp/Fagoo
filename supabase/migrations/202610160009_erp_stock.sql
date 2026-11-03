-- Estoque próprio da única empresa. Não importa saldos nem movimenta pelo status de um pedido.
begin;
create schema erp_stock;
revoke all on schema erp_stock from public,anon,authenticated,service_role;
create table erp_stock.balance (
  product_id uuid not null references erp_catalog.product(record_id),
  warehouse_id uuid not null references erp_catalog.warehouse(record_id),
  quantity numeric(18,6) not null default 0 check(quantity>=0),
  unit text not null,version integer not null default 0 check(version>=0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(product_id,warehouse_id)
);
create table erp_stock.movement (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('receipt','issue','adjustment','transfer','reversal')),
  occurred_on date not null,reason text not null,reference text,
  actor uuid not null references auth.users(id),command_id uuid not null unique,
  reverses_id uuid unique references erp_stock.movement(id),
  created_at timestamptz not null default clock_timestamp(),
  check((kind='reversal')=(reverses_id is not null))
);
create table erp_stock.entry (
  movement_id uuid not null references erp_stock.movement(id),ordinal integer not null,
  product_id uuid not null references erp_catalog.product(record_id),
  warehouse_id uuid not null references erp_catalog.warehouse(record_id),
  quantity numeric(18,6) not null check(quantity<>0),unit text not null,
  balance_after numeric(18,6) not null check(balance_after>=0),balance_version integer not null,
  primary key(movement_id,ordinal),unique(movement_id,product_id,warehouse_id)
);
create index erp_stock_entry_product_warehouse on erp_stock.entry(product_id,warehouse_id,movement_id);
create table erp_stock.command (
  id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null,
  result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table erp_stock.balance enable row level security;
alter table erp_stock.movement enable row level security;
alter table erp_stock.entry enable row level security;
alter table erp_stock.command enable row level security;
revoke all on all tables in schema erp_stock from public,anon,authenticated,service_role;
alter default privileges in schema erp_stock revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_stock revoke all on functions from public,anon,authenticated,service_role;

create function erp_stock.require_access(p_user_id uuid,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found or (p_write and v_role not in ('admin','estoque'))
    or (not p_write and v_role not in ('admin','consulta','estoque','vendas','fiscal')) then
    raise exception 'erp_stock_access_denied' using errcode='42501';
  end if;
end $$;
create function erp_stock.immutable_ledger()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_stock_immutable_ledger' using errcode='40001'; end $$;
create trigger immutable_stock_movement before update or delete on erp_stock.movement for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_entry before update or delete on erp_stock.entry for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_command before update or delete on erp_stock.command for each row execute function erp_stock.immutable_ledger();

-- Unidade/tipo não podem reescrever a interpretação de movimentos já registrados.
create function erp_stock.protect_product_unit()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if (new.unit is distinct from old.unit or new.kind is distinct from old.kind)
    and exists(select 1 from erp_stock.entry where product_id=old.record_id) then
    raise exception 'erp_stock_product_unit_locked' using errcode='40001';
  end if;
  return new;
end $$;
create trigger protect_stock_product_unit before update on erp_catalog.product for each row execute function erp_stock.protect_product_unit();

create function erp_stock.movement_dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',m.id,'kind',m.kind,'occurred_on',m.occurred_on,'reason',m.reason,
    'reference',m.reference,'created_at',m.created_at,'reverses_id',m.reverses_id,
    'reversed_by',(select id from erp_stock.movement where reverses_id=m.id),
    'items',(select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,
      'quantity',e.quantity::text,'unit',e.unit,'balance_after',e.balance_after::text,'balance_version',e.balance_version)
      order by e.ordinal) from erp_stock.entry e where e.movement_id=m.id))
  from erp_stock.movement m where m.id=p_id;
$$;

create function erp_stock.post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,
  p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_hash text;v_command erp_stock.command%rowtype;v_line jsonb;v_product uuid;v_warehouse uuid;
  v_quantity numeric(18,6);v_unit text;v_kind text;v_active boolean;v_warehouse_active boolean;
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
    select p.unit,p.kind,r.active into v_unit,v_kind,v_active from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=v_product for update of r,p;
    if not found or v_unit is null or v_kind is distinct from 'P' or (not v_active and p_kind<>'reversal') then
      raise exception 'erp_stock_product_unavailable' using errcode='22023'; end if;
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

create function public.erp_stock_post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,p_reason text,p_items jsonb,p_reference text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_kind='reversal' then raise exception 'erp_stock_use_reversal_command' using errcode='22023'; end if;
  return erp_stock.post(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,p_items);
end $$;
create function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_count integer;
begin
  perform erp_stock.require_access(p_user_id,true);
  if p_versions is null or jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions) not between 1 and 100
    or exists(select 1 from jsonb_array_elements(p_versions) j where jsonb_typeof(j)<>'object'
      or exists(select 1 from jsonb_object_keys(j) k where k not in ('product_id','warehouse_id','expected_version'))) then
    raise exception 'erp_stock_invalid_versions' using errcode='22023'; end if;
  select count(*) into v_count from erp_stock.entry where movement_id=p_movement_id;
  if v_count=0 then raise exception 'erp_stock_movement_not_found' using errcode='P0002'; end if;
  select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,
    'quantity',(-e.quantity)::text,'expected_version',v->'expected_version') order by e.ordinal)
  into v_items from erp_stock.entry e join jsonb_array_elements(p_versions) v
    on v->>'product_id'=e.product_id::text and v->>'warehouse_id'=e.warehouse_id::text where e.movement_id=p_movement_id;
  if jsonb_array_length(p_versions)<>v_count or coalesce(jsonb_array_length(v_items),0)<>v_count then
    raise exception 'erp_stock_invalid_versions' using errcode='22023'; end if;
  return erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
end $$;

create function public.erp_stock_balances(p_user_id uuid,p_product_id uuid,p_warehouse_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or not exists(select 1 from erp_catalog.product where record_id=p_product_id) then
    raise exception 'erp_stock_product_not_found' using errcode='P0002'; end if;
  select jsonb_build_object('product_id',p_product_id,'items',coalesce(jsonb_agg(jsonb_build_object(
    'warehouse_id',w.record_id,'warehouse_name',r.name,'warehouse_active',r.active,'quantity',coalesce(b.quantity,0)::numeric(18,6)::text,
    'version',coalesce(b.version,0),'unit',p.unit) order by w.record_id),'[]'::jsonb),'data_mode','erp_native') into v_result
  from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id
  join erp_catalog.product p on p.record_id=p_product_id
  left join erp_stock.balance b on b.product_id=p_product_id and b.warehouse_id=w.record_id
  where p_warehouse_id is null or w.record_id=p_warehouse_id;
  return v_result;
end $$;
create function public.erp_stock_movements(p_user_id uuid,p_product_id uuid,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_result jsonb;
begin
  perform erp_stock.require_access(p_user_id,false);
  if p_product_id is null or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023'; end if;
  with ids as materialized(select distinct m.id from erp_stock.movement m join erp_stock.entry e on e.movement_id=m.id
    where e.product_id=p_product_id and (p_after is null or m.id>p_after) order by m.id limit p_limit+1),
  page as materialized(select id from ids order by id limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(erp_stock.movement_dto(id) order by id) from page),'[]'::jsonb),
    'limit',p_limit,'has_more',(select count(*)>p_limit from ids),
    'next_cursor',case when (select count(*)>p_limit from ids) then (select id from page order by id desc limit 1) end,
    'data_mode','erp_native') into v_result;
  return v_result;
end $$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_post(uuid,uuid,text,date,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb) from public,anon,authenticated;
revoke all on function public.erp_stock_balances(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.erp_stock_movements(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.erp_stock_post(uuid,uuid,text,date,text,jsonb,text) to service_role;
grant execute on function public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb) to service_role;
grant execute on function public.erp_stock_balances(uuid,uuid,uuid) to service_role;
grant execute on function public.erp_stock_movements(uuid,uuid,integer,uuid) to service_role;
commit;
