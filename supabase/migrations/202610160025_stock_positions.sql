-- Posições registradas: ausência de lançamento não é saldo de abertura zero.
-- Os limites são globais por produto. Não há custo, reserva ou soma entre produtos.
begin;

create function public.erp_stock_positions(p_user_id uuid,p_limit integer default 25,p_after uuid default null,
 p_query text default null,p_active boolean default null,p_warehouse_id uuid default null,p_brand text default null,
 p_location text default null,p_stock_state text default null,p_limit_state text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb; warehouse jsonb;
begin
 perform erp_stock.require_access(p_user_id,false);
 if p_limit is null or p_limit not between 1 and 100
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]' or length(p_brand)>100 or p_brand ~ '[[:cntrl:]]'
  or length(p_location)>100 or p_location ~ '[[:cntrl:]]'
  or (p_stock_state is not null and p_stock_state not in('recorded','no_movements','review_required'))
  or (p_limit_state is not null and p_limit_state not in('below_min','within','above_max','not_configured','no_movements','review_required')) then
  raise exception 'erp_stock_invalid_query' using errcode='22023'; end if;
 if p_warehouse_id is not null then
  select jsonb_build_object('id',r.id,'name',r.name,'active',r.active) into warehouse
   from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id where w.record_id=p_warehouse_id;
  if not found then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 end if;
 with candidates as materialized (
  select r.id,r.version,r.name,r.code,r.active,p.unit,p.kind,p.format,p.gtin,p.brand,p.location,p.stock_min,p.stock_max
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id
   where (p.kind='P' or exists(select 1 from erp_stock.balance b where b.product_id=r.id) or exists(select 1 from erp_stock.entry e where e.product_id=r.id))
    and (p_after is null or r.id>p_after) and (p_active is null or r.active=p_active)
    and (nullif(btrim(p_query),'') is null or strpos(lower(r.name),lower(btrim(p_query)))>0 or strpos(lower(coalesce(r.code,'')),lower(btrim(p_query)))>0 or strpos(lower(coalesce(p.gtin,'')),lower(btrim(p_query)))>0)
    and (nullif(btrim(p_brand),'') is null or strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0)
    and (nullif(btrim(p_location),'') is null or strpos(lower(coalesce(p.location,'')),lower(btrim(p_location)))>0)
 ), ledger as materialized (
  select e.product_id,e.warehouse_id,count(*) as entry_count,sum(e.quantity) as ledger_quantity,
   max(e.balance_version) as last_version,bool_and(e.unit is not distinct from p.unit) as units_match
   from erp_stock.entry e join candidates p on p.id=e.product_id group by e.product_id,e.warehouse_id
 ), balances as materialized(select b.* from erp_stock.balance b join candidates p on p.id=b.product_id),
 positions as materialized (
  select coalesce(b.product_id,l.product_id) as product_id,coalesce(b.warehouse_id,l.warehouse_id) as warehouse_id,
   b.quantity,b.version,coalesce(l.entry_count,0) as entry_count,
   case when b.product_id is null or l.product_id is null or p.unit is null or p.kind is distinct from 'P'
     or b.unit is distinct from p.unit or not coalesce(l.units_match,false)
     or b.version<>l.entry_count or b.version<>l.last_version or b.quantity<>l.ledger_quantity
    then 'review_required' else 'recorded' end as state
   from balances b full join ledger l using(product_id,warehouse_id)
   join candidates p on p.id=coalesce(b.product_id,l.product_id)
 ), totals as materialized (
  select p.id,count(s.warehouse_id) as position_count,count(s.warehouse_id) filter(where s.entry_count>0) as recorded_count,
   bool_or(s.state='review_required') as needs_review,sum(s.quantity) as quantity
   from candidates p left join positions s on s.product_id=p.id group by p.id
 ), states as materialized (
  select p.*,t.recorded_count,
   case when t.needs_review then 'review_required' when t.position_count=0 then 'no_movements' else 'recorded' end as global_state,
   case when not coalesce(t.needs_review,false) and t.position_count>0 then round(t.quantity,6)::text end as global_quantity,
   case when s.state is null then 'no_movements' else s.state end as selected_state,
   case when s.state='recorded' then s.quantity::text end as selected_quantity,
   coalesce(s.version,0) as selected_version
   from candidates p join totals t on t.id=p.id
   left join positions s on s.product_id=p.id and s.warehouse_id=p_warehouse_id
 ), classified as materialized (
  select s.*,case when global_state<>'recorded' then global_state
   when stock_min is null and stock_max is null then 'not_configured'
   when stock_min is not null and global_quantity::numeric<stock_min then 'below_min'
   when stock_max is not null and global_quantity::numeric>stock_max then 'above_max' else 'within' end as limit_state
   from states s
 ), ids as materialized (
  select * from classified where (p_stock_state is null or case when p_warehouse_id is null then global_state else selected_state end=p_stock_state)
   and (p_limit_state is null or limit_state=p_limit_state) order by id limit p_limit+1
 ), page as materialized(select * from ids order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
   'product',jsonb_build_object('id',id,'version',version,'name',name,'code',code,'active',active,'unit',unit,'kind',kind,'format',format,'gtin',gtin,'brand',brand,'location',location,'stock_min',stock_min::text,'stock_max',stock_max::text),
   'global',jsonb_build_object('state',global_state,'quantity',global_quantity,'recorded_warehouse_count',recorded_count::text,'scope','all_recorded_warehouses'),
   'selected_position',case when p_warehouse_id is not null then jsonb_build_object('warehouse_id',p_warehouse_id,'state',selected_state,'quantity',selected_quantity,'version',selected_version) end,
   'limit_state',limit_state) order by id) from page),'[]'::jsonb),
  'warehouse',warehouse,'limit',p_limit,'has_more',(select count(*)>p_limit from ids),
  'next_cursor',case when (select count(*)>p_limit from ids) then(select id from page order by id desc limit 1) end,
  'data_mode','erp_native','scope','stock_positions') into result;
 return result;
end $$;

create function public.erp_stock_position_warehouses(p_user_id uuid,p_limit integer default 100,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_stock.require_access(p_user_id,false);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 return (with ids as materialized(select r.id,r.name,r.active from erp_catalog.warehouse w join erp_catalog.record r on r.id=w.record_id
   where p_after is null or r.id>p_after order by r.id limit p_limit+1),page as materialized(select * from ids order by id limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by id) from page),'[]'::jsonb),
   'limit',p_limit,'has_more',(select count(*)>p_limit from ids),'next_cursor',case when(select count(*)>p_limit from ids)then(select id from page order by id desc limit 1)end,
   'data_mode','erp_native','scope','stock_warehouse_options'));
end $$;

revoke all on function public.erp_stock_positions(uuid,integer,uuid,text,boolean,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.erp_stock_position_warehouses(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.erp_stock_positions(uuid,integer,uuid,text,boolean,uuid,text,text,text,text) to service_role;
grant execute on function public.erp_stock_position_warehouses(uuid,integer,uuid) to service_role;

-- Manual-engine replacement below preserves lock order, completed-command replay and reversals.
create or replace function erp_stock.post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,
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
commit;
