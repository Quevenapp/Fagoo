-- 100: política "Permitir estoque negativo" e adoção revisada do saldo de abertura do Origin por depósito vinculado086.
-- Requer 009/018/025/070/086/087/090. A política nasce desligada: com ela desligada, todas as baixas mantêm
-- exatamente as recusas e os códigos anteriores. Nenhum saldo existente é reescrito; abertura e reversão usam o razão009.
-- Ordem de locks: comando 174852918 -> mutex 174852909 -> catálogo por UUID -> produto -> saldo -> fonte SHARE -> acesso.
begin;

-- Redefinitions below are byte-for-byte copies of the published bodies except for the policy-aware checks.
-- Refuse to apply over any other definition (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 for r in select * from(values
  ('erp_stock.post_physical_025(uuid,uuid,text,date,text,text,jsonb,uuid)','65c98d14307359f8c600f64bffe33d05394fa90da5984042183f7c30e96973ec'),
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','9c326cd0026ddfebea659ad7bc3b50128f52f8f9a744c6023df8f4e1599f52bb'),
  ('erp_stock.document_reverse_preview_data(erp_documents.document,uuid,integer,date,text)','f49ed455f8c6837e7426398ac397efd34d73db5b24b6f1bd9b121618c0dbeb0e'),
  ('erp_stock.availability(uuid,uuid)','1b9d74f694002edd2edf7eb0176ddb70e9074adc25221d8bdf92e04ea2d99bc0'),
  ('erp_stock.guard_reserved_balance()','01e568e71fc045bd8e0c4415c72e6766e77acd3b79508559bb00e723053411fe'),
  ('erp_purchase_receipts.preview(uuid,erp_documents.document,text,date,text,jsonb,uuid)','926534b26e873d12e0dbbca8ea29c89b94496ab3771833e30e7551cea0340242'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_opening_100_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 1. Company policy: one row, default OFF, changed only by an audited admin command with expected version.
create table erp_stock.policy(
 singleton boolean primary key default true check(singleton),
 allow_negative boolean not null default false,
 version integer not null default 0 check(version between 0 and 2147483647),
 updated_at timestamptz,updated_by uuid references auth.users(id),command_id uuid unique,
 check((version=0 and not allow_negative and updated_at is null and updated_by is null and command_id is null)
  or(version>0 and updated_at is not null and updated_by is not null and command_id is not null))
);
insert into erp_stock.policy default values;
-- Each accepted change is one immutable command row; it is also the audit trail (who, when, from, to, why).
create table erp_stock.policy_command(
 id uuid primary key,actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 from_version integer not null check(from_version between 0 and 2147483646),to_version integer not null check(to_version=from_version+1),
 from_allow boolean not null,to_allow boolean not null check(to_allow<>from_allow),
 reason text not null check(length(reason) between 3 and 500 and reason=btrim(reason)),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create function erp_stock.guard_policy()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op<>'UPDATE' or new.singleton is distinct from old.singleton or new.version<>old.version+1 or new.allow_negative=old.allow_negative
  or new.command_id is null or new.command_id is not distinct from old.command_id or new.updated_by is null or new.updated_at is null
  or not exists(select 1 from erp_stock.policy_command c where c.id=new.command_id and c.to_version=new.version and c.to_allow=new.allow_negative and c.actor=new.updated_by) then
  raise exception 'erp_stock_policy_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_policy before update or delete on erp_stock.policy for each row execute function erp_stock.guard_policy();
create trigger immutable_stock_policy_command before update or delete on erp_stock.policy_command for each row execute function erp_stock.immutable_ledger();
-- Read inside the writers after mutex009; the policy writer takes the same mutex, so a decision never straddles a change.
create function erp_stock.negative_allowed()returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce((select allow_negative from erp_stock.policy where singleton),false)
$$;
create function erp_stock.policy_dto()returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('allow_negative',p.allow_negative,'version',p.version,'updated_at',p.updated_at)from erp_stock.policy p where p.singleton
$$;

-- 2. Table checks: the >=0 constraints become explicit numeric(18,6) bounds; the sign rule lives in the policy-aware writers.
do $$declare c record;n integer:=0;begin
 for c in select conname,conrelid::regclass rel from pg_constraint where contype='c'
  and((conrelid='erp_stock.balance'::regclass and pg_get_constraintdef(oid)='CHECK ((quantity >= (0)::numeric))')
   or(conrelid='erp_stock.entry'::regclass and pg_get_constraintdef(oid)='CHECK ((balance_after >= (0)::numeric))'))loop
  execute format('alter table %s drop constraint %I',c.rel,c.conname);n:=n+1;
 end loop;
 if n<>2 then raise exception 'stock_opening_100_constraint_baseline_changed' using errcode='55000';end if;
end$$;
alter table erp_stock.balance add constraint balance_quantity_bounds check(quantity between -999999999999.999999 and 999999999999.999999);
alter table erp_stock.entry add constraint entry_balance_after_bounds check(balance_after between -999999999999.999999 and 999999999999.999999);

-- 3. Database guard on every balance update. Reservations stay fully covered (a reserved position never drops below
-- its active reserved quantity, so it never turns negative); an unreserved decrease below zero needs the policy ON.
-- Increases are never refused for staying negative, so turning the policy OFF never traps an existing negative balance.
create or replace function erp_stock.guard_reserved_balance() returns trigger language plpgsql security definer set search_path=pg_catalog as $$declare q numeric;begin
 q:=erp_stock.reserved_quantity(new.product_id,new.warehouse_id);
 if q>0 and new.quantity<q then
  raise exception 'erp_stock_reserved_quantity_unavailable' using errcode='40001';end if;
 if new.quantity<0 and new.quantity<old.quantity and not erp_stock.negative_allowed() then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 return new;
end $$;
-- The dropped >=0 checks also covered inserts. Writers insert a balance at zero and an entry only after the policy-aware
-- update, so no published path reaches this guard; a direct insert cannot bypass the policy either.
create function erp_stock.guard_negative_insert()returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if tg_table_name='balance' then
  if new.quantity<0 and not erp_stock.negative_allowed() then
   raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 elsif new.quantity<0 and new.balance_after<0 and not erp_stock.negative_allowed() then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 return new;
end$$;
create trigger guard_negative_balance_insert before insert on erp_stock.balance for each row execute function erp_stock.guard_negative_insert();
create trigger guard_negative_entry_insert before insert on erp_stock.entry for each row execute function erp_stock.guard_negative_insert();

-- 4. Policy-aware redefinitions of the decreasing paths (manual issue/adjustment/transfer/reversal, document posting
-- and its reversal, purchase receipt reversal) and of availability. Bodies are otherwise unchanged.
create or replace function erp_stock.post_physical_025(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,
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
    -- 100: only a decrease is refused for ending below zero, and only while the company policy forbids it.
    if v_balance.quantity+v_quantity>999999999999.999999 or v_balance.quantity+v_quantity<-999999999999.999999
      or (v_quantity<0 and v_balance.quantity+v_quantity<0 and not erp_stock.negative_allowed()) then
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

create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock.
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id) order by record_id for update;
 select r.* into w from erp_catalog.record r join erp_catalog.warehouse x on x.record_id=r.id where r.id=d.warehouse_id and r.active;
 if not found then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 for row in select i.id,i.position,i.product_id,i.quantity,i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_documents.item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.kind='S' then
   ignored:=ignored||jsonb_build_array(jsonb_build_object('id',row.id,'position',row.position,'product_id',row.product_id,
    'description',row.data->>'description','quantity',row.quantity::text,'unit',row.data->>'unit','catalog_version',row.version,
    'reason',case when row.product_id is null then 'unlinked_item' else 'service' end));
  elsif row.kind is distinct from 'P' or not coalesce(row.active,false) or row.unit is null then
   raise exception 'erp_stock_product_unavailable' using errcode='22023';
  elsif row.format in('E','V') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with groups as(select i.product_id,sum(i.quantity) qty,jsonb_agg(jsonb_build_object('id',i.id,'position',i.position,'quantity',i.quantity::text) order by i.position) sources
  from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id and p.kind='P' group by i.product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources) order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_document_stock_position_limit' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions) j where ((j->>'quantity')::numeric<0 and (j->>'balance_after')::numeric<0 and not erp_stock.negative_allowed())
  or (j->>'balance_after')::numeric>999999999999.999999 or (j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','post','document',erp_stock.document_summary(d.id),'direction',direction,'occurred_on',p_day,'reason',p_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

create or replace function erp_stock.document_reverse_preview_data(d erp_documents.document,p_id uuid,p_version integer,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare p erp_stock.document_posting;positions jsonb;result jsonb;begin
 perform erp_stock.document_meta(p_day,p_reason);
 select * into p from erp_stock.document_posting where id=p_id and document_id=d.id for update;
 if not found then raise exception 'erp_document_stock_not_found' using errcode='P0002';end if;
 if p_version is null or p_version<1 then raise exception 'erp_document_stock_invalid_version' using errcode='22023';end if;
 if p.version<>p_version or p.state<>'active' or p.version=2147483647 then raise exception 'erp_document_stock_version_conflict' using errcode='40001';end if;
 if p_day<(select occurred_on from erp_stock.movement where id=p.movement_id) then raise exception 'erp_stock_reversal_date_invalid' using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852909,0);
 perform 1 from erp_catalog.record where id in(select product_id from erp_stock.entry where movement_id=p.movement_id union select warehouse_id from erp_stock.entry where movement_id=p.movement_id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_stock.entry where movement_id=p.movement_id) order by record_id for update;
 perform 1 from erp_stock.balance b join erp_stock.entry e on e.product_id=b.product_id and e.warehouse_id=b.warehouse_id where e.movement_id=p.movement_id order by b.product_id,b.warehouse_id for update of b;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'product_name',r.name,'catalog_version',r.version,'warehouse_id',e.warehouse_id,
  'unit',e.unit,'quantity',(-e.quantity)::text,'balance_before',b.quantity::text,'balance_after',round(b.quantity-e.quantity,6)::text,
  'expected_version',b.version,'sources','[]'::jsonb) order by e.product_id,e.warehouse_id) into positions
 from erp_stock.entry e join erp_stock.balance b on b.product_id=e.product_id and b.warehouse_id=e.warehouse_id join erp_catalog.record r on r.id=e.product_id where e.movement_id=p.movement_id;
 if positions is null or jsonb_array_length(positions) not between 1 and 100 or exists(select 1 from jsonb_array_elements(positions) j where((j->>'quantity')::numeric<0 and(j->>'balance_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','reverse','document',erp_stock.document_summary(d.id),'posting',erp_stock.document_posting_summary(p.id),
  'direction','reversal','occurred_on',p_day,'reason',p_reason,'warehouse',p.snapshot->'warehouse','positions',positions,'ignored','[]'::jsonb);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

create or replace function erp_stock.availability(p_product uuid,p_warehouse uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b erp_stock.balance;p erp_catalog.product;q numeric;last_entry erp_stock.entry;state text;begin
 select * into p from erp_catalog.product where record_id=p_product;if not found then raise exception 'erp_stock_product_not_found' using errcode='P0002';end if;
 if not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse) then raise exception 'erp_stock_warehouse_not_found' using errcode='P0002';end if;
 select * into b from erp_stock.balance where product_id=p_product and warehouse_id=p_warehouse;
 select * into last_entry from erp_stock.entry where product_id=p_product and warehouse_id=p_warehouse order by balance_version desc limit 1;
 q:=erp_stock.reserved_quantity(p_product,p_warehouse);
 state:=case when b.product_id is null and last_entry.movement_id is null and q=0 then 'no_movements'
  when b.product_id is not null and b.version>0 and p.kind='P' and p.unit is not null and b.unit=p.unit
   and last_entry.balance_version=b.version and last_entry.balance_after=b.quantity and last_entry.unit=b.unit and(q=0 or b.quantity>=q) then 'recorded' else 'review_required' end;
 return jsonb_build_object('product_id',p_product,'warehouse_id',p_warehouse,'unit',p.unit,'state',state,'physical_version',coalesce(b.version,0),
  'physical_quantity',case when state='recorded' then b.quantity::text end,'reserved_quantity',q::numeric(18,6)::text,
  'available_quantity',case when state='recorded' then(b.quantity-q)::numeric(18,6)::text end,
  'reservation_hash',erp_stock.reservation_position_hash(p_product,p_warehouse));
end $$;

create or replace function erp_purchase_receipts.preview(p_actor uuid,d erp_documents.document,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare r erp_purchase_receipts.receipt;selection jsonb;lines jsonb:='[]';positions jsonb;w erp_catalog.record;row record;qty numeric;net numeric;result jsonb;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if p_action not in('receive','reverse')or p_action is null then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id)then raise exception 'purchase_receipt_legacy_mode'using errcode='40001';end if;
 if p_action='receive'then
  if not erp_stock.document_eligible(d.kind,d.status)then raise exception 'purchase_receipt_ineligible_state'using errcode='40001';end if;
  if p_items is null or jsonb_typeof(p_items)<>'array'or jsonb_array_length(p_items)not between 1 and 250 or octet_length(p_items::text)>131072 then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'or jsonb_typeof(j->'item_id')is distinct from'string'
   or coalesce(j->>'item_id','')!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'or jsonb_typeof(j->'quantity')is distinct from'string'
   or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$'or exists(select 1 from jsonb_object_keys(j)k where k not in('item_id','quantity')))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_items)j where(j->>'quantity')::numeric<=0)
   or exists(select 1 from jsonb_array_elements(p_items)j group by j->>'item_id'having count(*)>1)
   or exists(select 1 from jsonb_array_elements(p_items)j where not exists(select 1 from erp_documents.item where id=(j->>'item_id')::uuid and document_id=d.id))then raise exception 'purchase_receipt_items_invalid'using errcode='22023';end if;
  selection:=p_items;
 else
  select * into r from erp_purchase_receipts.receipt where id=p_receipt and document_id=d.id;
  if r.id is null then raise exception 'purchase_receipt_not_found'using errcode='P0002';end if;
  if exists(select 1 from erp_purchase_receipts.reversal where receipt_id=r.id)then raise exception 'purchase_receipt_already_reversed'using errcode='40001';end if;
  if p_day<(r.snapshot->>'occurred_on')::date then raise exception 'purchase_receipt_reversal_date_invalid'using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('item_id',j->'item_id','quantity',j->'quantity'))into selection from jsonb_array_elements(r.snapshot->'items')j;
 end if;
 -- Same business-lock order as018/070. All sources are reread after the mutex/catalog waits.
 perform pg_advisory_xact_lock(174852909,0);perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_catalog.product where record_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by record_id for update;
 perform erp_purchase_receipts.access(p_actor);
 perform 1 from erp_stock.balance where warehouse_id=d.warehouse_id and product_id in(select i.product_id from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid where i.document_id=d.id)order by product_id,warehouse_id for update;
 perform erp_purchase_receipts.access(p_actor,true);
 select c.* into w from erp_catalog.record c join erp_catalog.warehouse x on x.record_id=c.id where c.id=d.warehouse_id;
 if w.id is null or(p_action='receive'and not w.active)then raise exception 'purchase_receipt_warehouse_unavailable'using errcode='22023';end if;
 for row in select i.*,c.active,c.version catalog_version,p.unit product_unit,p.kind product_kind,p.format,j->>'quantity' requested
  from erp_documents.item i join jsonb_array_elements(selection)j on i.id=(j->>'item_id')::uuid
  left join erp_catalog.record c on c.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id where i.document_id=d.id order by i.position loop
  if row.product_id is null or row.product_kind is distinct from'P'or row.product_unit is null or(p_action='receive'and(not coalesce(row.active,false)or row.format in('E','V')))then raise exception 'purchase_receipt_product_unavailable'using errcode='22023';end if;
  if row.product_unit is distinct from row.data->>'unit'then raise exception 'purchase_receipt_unit_mismatch'using errcode='22023';end if;
  qty:=row.requested::numeric*case when p_action='receive'then 1 else -1 end;net:=erp_purchase_receipts.received(d.id,row.id);
  if net+qty<0 or net+qty>row.quantity then raise exception 'purchase_receipt_quantity_exceeded'using errcode='40001';end if;
  lines:=lines||jsonb_build_array(jsonb_build_object('item_id',row.id,'position',row.position,'product_id',row.product_id,'unit',row.product_unit,'ordered_quantity',row.quantity::text,
   'quantity',qty::numeric(18,6)::text,'received_before',net::numeric(18,6)::text,'received_after',(net+qty)::numeric(18,6)::text,'remaining_after',(row.quantity-net-qty)::numeric(18,6)::text));
 end loop;
 if jsonb_array_length(lines)<>jsonb_array_length(selection)then raise exception 'purchase_receipt_items_changed'using errcode='40001';end if;
 -- Check numeric range before formatting numeric(18,6); a full position must
 -- produce the same closed business conflict, never an intermediate cast overflow.
 if exists(select 1 from(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')g
  left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id
  where(g.qty<0 and coalesce(b.quantity,0)+g.qty<0 and not erp_stock.negative_allowed())
  or coalesce(b.quantity,0)+g.qty>999999999999.999999 or coalesce(b.quantity,0)+g.qty<-999999999999.999999
  or(g.qty<0 and erp_stock.reserved_quantity(g.product_id,w.id)>0 and coalesce(b.quantity,0)+g.qty-erp_stock.reserved_quantity(g.product_id,w.id)<0)or b.version=2147483647)then
  raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 with groups as(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')
 select jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',c.name,'warehouse_id',w.id,'unit',p.unit,'quantity',g.qty::numeric(18,6)::text,
  'catalog_version',c.version,'physical_version',coalesce(b.version,0),'reservation_hash',erp_stock.reservation_position_hash(g.product_id,w.id),
  'physical_before',coalesce(b.quantity,0)::numeric(18,6)::text,'reserved_before',q.qty::numeric(18,6)::text,'available_before',(coalesce(b.quantity,0)-q.qty)::numeric(18,6)::text,
  'physical_after',(coalesce(b.quantity,0)+g.qty)::numeric(18,6)::text,'available_after',(coalesce(b.quantity,0)+g.qty-q.qty)::numeric(18,6)::text)order by g.product_id)into positions
 from groups g join erp_catalog.record c on c.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id cross join lateral(select erp_stock.reserved_quantity(g.product_id,w.id)qty)q;
 if positions is null or jsonb_array_length(positions)not between 1 and 100 then raise exception 'purchase_receipt_position_limit'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions)j where((j->>'quantity')::numeric<0 and(j->>'physical_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'physical_after')::numeric>999999999999.999999 or(j->>'physical_after')::numeric<-999999999999.999999
  or((j->>'quantity')::numeric<0 and(j->>'reserved_before')::numeric>0 and(j->>'available_after')::numeric<0)or(j->>'physical_version')::integer=2147483647)then raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 result:=jsonb_build_object('action',p_action,'document',erp_purchase_receipts.document(d.id),'receipt_id',p_receipt,'occurred_on',p_day,'reason',btrim(p_reason),
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'items',lines,'positions',positions);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

-- 5. Opening balance adoption. One immutable receipt per native product+warehouse: never adopted twice. A zero target
-- is recorded without any movement. A non-zero target is one 'adjustment' movement per pair (the product screen reverses
-- single-product movements), so each opening can be undone only by the normal reversal of that movement.
create table erp_stock.opening_command(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 warehouse_source_id text not null references erp_warehouse_import.binding(source_id),occurred_on date not null,
 preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=262144),
 created_at timestamptz not null default clock_timestamp()
);
create table erp_stock.opening_receipt(
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references erp_catalog.product(record_id),warehouse_id uuid not null references erp_catalog.warehouse(record_id),
 warehouse_source_id text not null references erp_warehouse_import.binding(source_id),
 product_source_id text not null check(product_source_id~'^[0-9]{1,40}$' and product_source_id!~'^0+$'),
 command_id uuid not null references erp_stock.opening_command(id) deferrable initially deferred,
 movement_id uuid unique references erp_stock.movement(id),outcome text not null check(outcome in('adopted','adopted_zero')),
 target numeric(18,6) not null,previous_quantity numeric(18,6) not null,adjustment numeric(18,6) not null,unit text not null,
 source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),source_version bigint not null check(source_version>0),
 source_seen_at timestamptz not null,occurred_on date not null,actor uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 unique(product_id,warehouse_id),unique(warehouse_source_id,product_source_id),
 check(target=previous_quantity+adjustment),
 check((outcome='adopted_zero' and movement_id is null and target=0 and adjustment=0)or(outcome='adopted' and movement_id is not null and adjustment<>0))
);
create index erp_stock_opening_receipt_command on erp_stock.opening_receipt(command_id,product_source_id);
create trigger immutable_stock_opening_command before update or delete on erp_stock.opening_command for each row execute function erp_stock.immutable_ledger();
create trigger immutable_stock_opening_receipt before update or delete on erp_stock.opening_receipt for each row execute function erp_stock.immutable_ledger();
create type erp_stock.opening_row as(
 product_source_id text,group_code text,status text,reason text,product_id uuid,product_name text,product_code text,unit text,
 source_name text,source_code text,source_hash text,source_version bigint,source_seen_at timestamptz,physical text,
 current_quantity text,current_version integer,target text,adjustment text,receipt_id uuid);
do $$declare t text;begin foreach t in array array['policy','policy_command','opening_command','opening_receipt'] loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- 6. Policy RPCs. Readers are the stock readers (screens explain refusals); only an active administrador changes it.
-- VOLATILE deliberately: authorization after a lock wait must read a fresh snapshot.
create function erp_stock.policy_access(p_actor uuid,p_lock boolean default false)returns void language plpgsql set search_path=pg_catalog as $$begin
 if p_lock then
  perform 1 from auth.users where id=p_actor for key share;
  perform 1 from erp_access.membership where user_id=p_actor for share;
 end if;
 if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin')then
  raise exception 'erp_stock_policy_access_denied' using errcode='42501';end if;
end$$;
-- One UUID identifies one effect across every stock command family.
create function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
$$;
create function public.erp_stock_policy_get(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_stock.require_access(p_user_id,false);
 return jsonb_build_object('scope','stock_policy','policy',erp_stock.policy_dto(),
  'can_manage',exists(select 1 from erp_access.membership where user_id=p_user_id and active and role='admin'),'data_mode','erp_native');
end$$;
create function public.erp_stock_policy_set(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_allow_negative boolean,p_reason text,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.policy_command;p erp_stock.policy;at timestamptz;result jsonb;begin
 perform erp_stock.policy_access(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or p_allow_negative is null
  or p_reason is null or length(btrim(p_reason)) not between 3 and 500 or p_reason~'[[:cntrl:]]' or p_confirmed is distinct from true then
  raise exception 'erp_stock_policy_input_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-negative-policy-v1','actor',p_user_id,'expected_version',p_expected_version,
  'allow_negative',p_allow_negative,'reason',p_reason,'confirmed',true)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.policy_access(p_user_id);
 select * into c from erp_stock.policy_command where id=p_command_id;
 if found then
  perform erp_stock.policy_access(p_user_id,true);
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_stock_policy_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('policy',erp_stock.policy_dto(),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'erp_stock_policy_command_conflict' using errcode='40001';end if;
 -- The global stock mutex serializes the change with every writer that reads the policy.
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.policy_access(p_user_id,true);
 select * into p from erp_stock.policy where singleton for update;
 if p.version<>p_expected_version then raise exception 'erp_stock_policy_version_conflict' using errcode='40001';end if;
 if p.allow_negative=p_allow_negative then raise exception 'erp_stock_policy_unchanged' using errcode='22023';end if;
 at:=clock_timestamp();
 result:=jsonb_build_object('scope','stock_policy','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'from',jsonb_build_object('allow_negative',p.allow_negative,'version',p.version),'to',jsonb_build_object('allow_negative',p_allow_negative,'version',p.version+1),
  'reason',btrim(p_reason),'changed_at',at));
 insert into erp_stock.policy_command(id,actor,request_hash,from_version,to_version,from_allow,to_allow,reason,result)
  values(p_command_id,p_user_id,h,p.version,p.version+1,p.allow_negative,p_allow_negative,btrim(p_reason),result);
 update erp_stock.policy set allow_negative=p_allow_negative,version=version+1,updated_at=at,updated_by=p_user_id,command_id=p_command_id where singleton;
 perform erp_stock.policy_access(p_user_id);
 return result||jsonb_build_object('policy',erp_stock.policy_dto(),'replayed',false);
end$$;
create function public.erp_stock_policy_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_stock.policy_command;begin
 perform erp_stock.policy_access(p_user_id);
 if p_command_id is null then raise exception 'erp_stock_policy_input_invalid' using errcode='22023';end if;
 select * into c from erp_stock.policy_command where id=p_command_id;
 if not found then raise exception 'erp_stock_policy_command_not_found' using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception 'erp_stock_policy_access_denied' using errcode='42501';end if;
 return c.result||jsonb_build_object('policy',erp_stock.policy_dto(),'replayed',true);
end$$;

-- 7. Opening adoption RPCs: administrador only, revalidated after every lock wait.
create function erp_stock.opening_access(p_actor uuid,p_lock boolean default false)returns void language plpgsql set search_path=pg_catalog as $$begin
 if p_lock then
  perform 1 from auth.users where id=p_actor for key share;
  perform 1 from erp_access.membership where user_id=p_actor for share;
 end if;
 if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin')then
  raise exception 'stock_opening_access_denied' using errcode='42501';end if;
end$$;
create function erp_stock.opening_day(p_day date)returns void language plpgsql set search_path=pg_catalog as $$begin
 if p_day is null or not isfinite(p_day) or p_day<date '1900-01-01' or p_day>(clock_timestamp() at time zone 'America/Sao_Paulo')::date then
  raise exception 'stock_opening_date_invalid' using errcode='22023';end if;
end$$;
create function erp_stock.opening_binding(p_source text)returns erp_warehouse_import.binding language plpgsql stable set search_path=pg_catalog as $$
declare b erp_warehouse_import.binding;begin
 if p_source is null or p_source!~'^[0-9]{1,40}$' or p_source~'^0+$' then raise exception 'stock_opening_query_invalid' using errcode='22023';end if;
 select * into b from erp_warehouse_import.binding where source_id=p_source;
 if not found then raise exception 'stock_opening_warehouse_not_found' using errcode='P0002';end if;
 return b;
end$$;
-- Origin text is display only: control characters become spaces and text left empty is null (never "").
create function erp_stock.opening_text(v text,p_max integer)returns text language sql immutable set search_path=pg_catalog as $$
 select nullif(left(btrim(regexp_replace(v,'[[:cntrl:]\u007f-\u009f]',' ','g')),p_max),'')
$$;
create function erp_stock.opening_warehouse_dto(b erp_warehouse_import.binding)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('source_id',b.source_id,'warehouse_id',b.warehouse_id,'name',r.name,'active',r.active,
  'source_name',erp_stock.opening_text(b.source->>'name',200),'imported_at',b.imported_at)
 from erp_catalog.record r where r.id=b.warehouse_id
$$;
-- Exact JSONB number text from the stored observation: never a string, finite by JSON, within numeric(18,6), at most six
-- decimals once trailing zeros are dropped. Everything else is classified, never rounded into a quantity.
create function erp_stock.opening_number(v jsonb)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare t text;n numeric;begin
 if v is null then return jsonb_build_object('state','absent','value',null);end if;
 if v='null'::jsonb then return jsonb_build_object('state','null','value',null);end if;
 if jsonb_typeof(v)<>'number' then return jsonb_build_object('state','invalid','value',null);end if;
 t:=v#>>'{}';
 if length(t)>80 or t!~'^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' then return jsonb_build_object('state','invalid','value',null);end if;
 n:=t::numeric;
 if abs(n)>999999999999.999999 then return jsonb_build_object('state','range','value',null);end if;
 if n<>round(n,6) then return jsonb_build_object('state','precision','value',null);end if;
 return jsonb_build_object('state','value','value',n::numeric(18,6)::text);
end$$;
-- One row per valid Origin product ID (union of products and stock_balances, as087), classified for one bound warehouse.
create function erp_stock.opening_rows(p_source text,p_warehouse uuid,p_allow boolean,p_ids text[] default null)
returns setof erp_stock.opening_row language sql stable set search_path=pg_catalog as $$
 with ids as materialized(
  select r.source_id from origin_sync.raw_record r where r.entity in('products','stock_balances') and r.source_id~'^[0-9]{1,40}$' and r.source_id!~'^0+$'
   and(p_ids is null or r.source_id=any(p_ids)) group by r.source_id),
 base as materialized(
  select i.source_id,s.source_id is not null has_obs,s.version_hash,s.version,s.last_seen_at,s.payload sp,pr.payload pp,
   coalesce(s.source_id is not null and jsonb_typeof(s.payload)='object' and octet_length(s.payload::text)<=131072 and isfinite(s.last_seen_at) and s.version>=1
    and erp_cutover.stock_observation_id(s.payload#>'{produto,id}')=i.source_id
    and s.version_hash=encode(sha256(convert_to(jsonb_build_object('payload',s.payload,'document_links',s.document_links)::text,'UTF8')),'hex'),false) obs_ok,
   rc.id record_id,rc.name record_name,rc.code record_code,rc.active,p.unit,p.kind,p.format
  from ids i left join origin_sync.raw_record s on s.entity='stock_balances' and s.source_id=i.source_id
  left join origin_sync.raw_record pr on pr.entity='products' and pr.source_id=i.source_id
  left join erp_catalog.origin o on o.entity='products' and o.source_id=i.source_id
  left join erp_catalog.record rc on rc.id=o.record_id and rc.entity='products'
  left join erp_catalog.product p on p.record_id=rc.id),
 listed as materialized(
  select b.*,case when not b.obs_ok then null when jsonb_typeof(b.sp->'depositos')='array' then
    case when jsonb_array_length(b.sp->'depositos')<=1000 then b.sp->'depositos' end end deps
  from base b),
 observed as materialized(
  select l.*,case when not l.has_obs then 'missing' when not l.obs_ok then 'invalid' when not(l.sp?'depositos')then 'unavailable'
    when l.deps is null then 'invalid'
    when exists(select 1 from jsonb_array_elements(l.deps)e where erp_cutover.stock_observation_id(e->'id')is null)then 'invalid'
    when exists(select 1 from jsonb_array_elements(l.deps)e group by erp_cutover.stock_observation_id(e->'id')having count(*)>1)then 'invalid'
    when exists(select 1 from jsonb_array_elements(l.deps)e where erp_cutover.stock_observation_id(e->'id')=p_source)then 'present' else 'absent' end list_state,
   (select e from jsonb_array_elements(coalesce(l.deps,'[]'::jsonb))e where erp_cutover.stock_observation_id(e->'id')=p_source limit 1) entry
  from listed l),
 measured as materialized(
  select o.*,case when o.list_state='present' then erp_stock.opening_number(o.entry->'saldoFisico')end num,
   rcp.id rid,rcp.movement_id rmov,bal.quantity bq,bal.version bv,
   o.record_id is not null and exists(select 1 from erp_stock.entry e where e.product_id=o.record_id and e.warehouse_id=p_warehouse) has_entries,
   rcp.id is not null and exists(select 1 from erp_stock.movement m where m.reverses_id=rcp.movement_id) reversed
  from observed o left join erp_stock.opening_receipt rcp on rcp.product_id=o.record_id and rcp.warehouse_id=p_warehouse
  left join erp_stock.balance bal on bal.product_id=o.record_id and bal.warehouse_id=p_warehouse),
 classified as materialized(
  select m.*,case
    when m.record_id is null then 'no_native_product'
    when m.rid is not null then case when m.rmov is null then 'adopted_zero' when m.reversed then 'adopted_reversed' else 'adopted' end
    when m.has_entries then 'native_movements'
    when m.list_state in('missing','unavailable','absent') then 'no_observation'
    when m.list_state='invalid' or m.num->>'state'<>'value' then 'invalid'
    when not coalesce(m.active,false) or m.kind is distinct from 'P' or m.unit is null or m.format in('E','V') then 'invalid'
    when (m.num->>'value')::numeric>0 then 'positive' when (m.num->>'value')::numeric=0 then 'zero'
    when p_allow then 'negative' else 'negative_blocked' end status
  from measured m)
 select c.source_id,
  case when c.status in('negative','negative_blocked') then 'negative' when c.status in('adopted','adopted_zero','adopted_reversed') then 'adopted' else c.status end,
  c.status,
  case c.status when 'no_native_product' then 'NATIVE_PRODUCT_MISSING' when 'adopted' then 'ALREADY_ADOPTED' when 'adopted_zero' then 'ALREADY_ADOPTED'
   when 'adopted_reversed' then 'ALREADY_ADOPTED' when 'native_movements' then 'NATIVE_MOVEMENTS'
   when 'no_observation' then case c.list_state when 'missing' then 'OBSERVATION_MISSING' when 'unavailable' then 'WAREHOUSE_LIST_MISSING' else 'WAREHOUSE_ABSENT' end
   when 'invalid' then case when c.list_state='invalid' then case when c.obs_ok then 'WAREHOUSE_LIST_INVALID' else 'SOURCE_INVALID' end
    when c.num->>'state'<>'value' then 'PHYSICAL_'||upper(c.num->>'state') else 'PRODUCT_UNAVAILABLE' end
   when 'negative_blocked' then 'NEGATIVE_NOT_ALLOWED' end,
  c.record_id,erp_stock.opening_text(c.record_name,200),erp_stock.opening_text(c.record_code,100),c.unit,
  erp_stock.opening_text(case when jsonb_typeof(c.pp->'nome')='string' then c.pp->>'nome' end,200),
  coalesce(erp_stock.opening_text(case when jsonb_typeof(c.sp#>'{produto,codigo}') in('string','number') then c.sp#>>'{produto,codigo}' end,100),
   erp_stock.opening_text(case when jsonb_typeof(c.pp->'codigo') in('string','number') then c.pp->>'codigo' end,100)),
  case when c.has_obs then c.version_hash end,case when c.has_obs then c.version end,case when c.has_obs then c.last_seen_at end,
  c.num->>'value',c.bq::text,coalesce(c.bv,0),
  case when c.status in('positive','zero','negative','negative_blocked') then c.num->>'value' end,
  case when c.status in('positive','zero','negative','negative_blocked') then((c.num->>'value')::numeric-coalesce(c.bq,0))::numeric(18,6)::text end,
  c.rid
 from classified c
$$;
create function erp_stock.opening_receipt_dto(r erp_stock.opening_receipt)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'command_id',r.command_id,'product_source_id',r.product_source_id,'product_id',r.product_id,'warehouse_id',r.warehouse_id,
  'outcome',r.outcome,'state',case when r.movement_id is null then 'adopted_zero' when x.id is not null then 'reversed' else 'adopted' end,
  'target',r.target::text,'previous_quantity',r.previous_quantity::text,'adjustment',r.adjustment::text,'unit',r.unit,
  'movement_id',r.movement_id,'reversal_movement_id',x.id,'occurred_on',r.occurred_on,'source_hash',r.source_hash,'source_version',r.source_version::text,
  'created_at',r.created_at)
 from(select 1)anchor left join erp_stock.movement x on r.movement_id is not null and x.reverses_id=r.movement_id
$$;
create function erp_stock.opening_row_dto(r erp_stock.opening_row)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('product_source_id',r.product_source_id,'group',r.group_code,'status',r.status,'reason',r.reason,
  'product',case when r.product_id is null then null else jsonb_build_object('id',r.product_id,'name',r.product_name,'code',r.product_code,'unit',r.unit)end,
  'source',jsonb_build_object('name',r.source_name,'code',r.source_code,'source_hash',r.source_hash,'source_version',r.source_version::text,'last_seen_at',r.source_seen_at),
  'physical',r.physical,'current',jsonb_build_object('quantity',r.current_quantity,'version',r.current_version),'target',r.target,'adjustment',r.adjustment,
  'receipt',(select erp_stock.opening_receipt_dto(x)from erp_stock.opening_receipt x where x.id=r.receipt_id))
$$;
create function erp_stock.opening_preview_hash(p_actor uuid,p_source text,p_warehouse uuid,p_day date,p_items jsonb)returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('profile','origin-stock-opening-v1','actor',p_actor,'warehouse_source_id',p_source,'warehouse_id',p_warehouse,
  'occurred_on',p_day,'items',coalesce((select jsonb_agg(jsonb_build_object('product_source_id',j->>'product_source_id','product_id',j->>'product_id',
   'unit',j->>'unit','source_hash',j->>'source_hash','source_version',j->>'source_version','target',j->>'target')order by j->>'product_source_id' collate "C")
  from jsonb_array_elements(p_items)j),'[]'::jsonb))::text,'UTF8')),'hex')
$$;
create function erp_stock.opening_current(p_command uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(erp_stock.opening_receipt_dto(r)order by r.product_source_id collate "C"),'[]'::jsonb)from erp_stock.opening_receipt r where r.command_id=p_command
$$;
create function erp_stock.opening_counts(p_rows erp_stock.opening_row[])returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('total',count(*),'positive',count(*)filter(where r.group_code='positive'),'zero',count(*)filter(where r.group_code='zero'),
  'negative',count(*)filter(where r.group_code='negative'),'negative_blocked',count(*)filter(where r.status='negative_blocked'),
  'no_native_product',count(*)filter(where r.group_code='no_native_product'),'no_observation',count(*)filter(where r.group_code='no_observation'),
  'invalid',count(*)filter(where r.group_code='invalid'),'adopted',count(*)filter(where r.group_code='adopted'),
  'native_movements',count(*)filter(where r.group_code='native_movements'),'pending',count(*)filter(where r.status in('positive','zero','negative')))
 from unnest(p_rows)r
$$;

create function public.erp_stock_opening_warehouses(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_stock.opening_access(p_user_id);
 return jsonb_build_object('scope','stock_opening_warehouses','profile','origin-stock-opening-v1',
  'items',coalesce((select jsonb_agg(erp_stock.opening_warehouse_dto(b)order by b.source_id collate "C")
   from(select * from erp_warehouse_import.binding order by source_id collate "C" limit 100)b),'[]'::jsonb),
  'has_more',(select count(*)>100 from erp_warehouse_import.binding),'policy',erp_stock.policy_dto(),'data_mode','erp_native');
end$$;
create function public.erp_stock_opening_page(p_user_id uuid,p_warehouse_source_id text,p_limit integer default 25,p_after text default null,p_group text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare b erp_warehouse_import.binding;all_rows erp_stock.opening_row[];rows jsonb;more boolean;begin
 perform erp_stock.opening_access(p_user_id);
 if p_limit is null or p_limit not between 1 and 50 or(p_after is not null and(p_after!~'^[0-9]{1,40}$' or p_after~'^0+$'))
  or(p_group is not null and p_group not in('positive','zero','negative','no_native_product','no_observation','invalid','adopted','native_movements'))then
  raise exception 'stock_opening_query_invalid' using errcode='22023';end if;
 b:=erp_stock.opening_binding(p_warehouse_source_id);
 select coalesce(array_agg(r),'{}') into all_rows from erp_stock.opening_rows(b.source_id,b.warehouse_id,erp_stock.negative_allowed())r;
 with selected as materialized(select r from unnest(all_rows)r where(p_group is null or r.group_code=p_group)
   and(p_after is null or r.product_source_id collate "C">p_after collate "C")order by r.product_source_id collate "C" limit p_limit+1),
  visible as(select r from selected order by(r).product_source_id collate "C" limit p_limit)
 select coalesce((select jsonb_agg(erp_stock.opening_row_dto(v.r)order by(v.r).product_source_id collate "C")from visible v),'[]'::jsonb),
  (select count(*)>p_limit from selected)into rows,more;
 return jsonb_build_object('scope','stock_opening','profile','origin-stock-opening-v1','warehouse',erp_stock.opening_warehouse_dto(b),
  'policy',erp_stock.policy_dto(),'counts',erp_stock.opening_counts(all_rows),'group',p_group,'items',rows,'limit',p_limit,'has_more',more,
  'next_cursor',case when more then rows->-1->>'product_source_id' end,'unit_source','native_product','observed_at',statement_timestamp(),'data_mode','erp_native');
end$$;
-- The next batch is the first pending pairs in exact ID order; the hash pins actor, warehouse, cut date and every
-- (product, native unit, observation version, target) the administrator confirms: the observation has no unit, so the
-- unit shown in the batch is part of what is confirmed and a later unit change is refused per pair.
create function public.erp_stock_opening_batch(p_user_id uuid,p_warehouse_source_id text,p_occurred_on date,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare b erp_warehouse_import.binding;pending erp_stock.opening_row[];items jsonb;core jsonb;begin
 perform erp_stock.opening_access(p_user_id);
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'stock_opening_query_invalid' using errcode='22023';end if;
 perform erp_stock.opening_day(p_occurred_on);
 b:=erp_stock.opening_binding(p_warehouse_source_id);
 select coalesce(array_agg(r order by r.product_source_id collate "C"),'{}') into pending
  from erp_stock.opening_rows(b.source_id,b.warehouse_id,erp_stock.negative_allowed())r where r.status in('positive','zero','negative');
 select coalesce(jsonb_agg(erp_stock.opening_row_dto(x.r)order by x.n),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('product_source_id',(x.r).product_source_id,'product_id',(x.r).product_id,'unit',(x.r).unit,'source_hash',(x.r).source_hash,
   'source_version',(x.r).source_version::text,'target',(x.r).target)order by x.n),'[]'::jsonb)
  into items,core from(select pending[n] r,n from generate_subscripts(pending,1)n where n<=p_limit)x;
 return jsonb_build_object('scope','stock_opening_batch','profile','origin-stock-opening-v1','warehouse',erp_stock.opening_warehouse_dto(b),
  'policy',erp_stock.policy_dto(),'occurred_on',p_occurred_on,'items',items,'pending',cardinality(pending),'limit',p_limit,
  'preview_hash',case when jsonb_array_length(items)>0 then erp_stock.opening_preview_hash(p_user_id,b.source_id,b.warehouse_id,p_occurred_on,core)end,
  'unit_source','native_product','observed_at',statement_timestamp(),'data_mode','erp_native');
end$$;
create function public.erp_stock_opening_apply(p_user_id uuid,p_warehouse_source_id text,p_occurred_on date,p_items jsonb,p_preview_hash text,p_command_id uuid,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.opening_command;b erp_warehouse_import.binding;w erp_catalog.record;allow boolean;ids text[];pids uuid[];
 item jsonb;r erp_stock.opening_row;results jsonb:='[]';outcome text;why text;mid uuid;rid uuid;derived uuid;movement jsonb;receipt jsonb;result jsonb;begin
 perform erp_stock.opening_access(p_user_id);
 if p_command_id is null or p_confirmed is distinct from true or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$'
  or p_warehouse_source_id is null or p_warehouse_source_id!~'^[0-9]{1,40}$' or p_warehouse_source_id~'^0+$' then
  raise exception 'stock_opening_input_invalid' using errcode='22023';end if;
 perform erp_stock.opening_day(p_occurred_on);
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 or octet_length(p_items::text)>65536
  or exists(select 1 from jsonb_array_elements(p_items)j where jsonb_typeof(j)<>'object'
   or exists(select 1 from jsonb_object_keys(j)k where k not in('product_source_id','product_id','unit','source_hash','source_version','target'))
   or jsonb_typeof(j->'unit') is distinct from 'string' or length(j->>'unit') not between 1 and 64
   or jsonb_typeof(j->'product_source_id') is distinct from 'string' or coalesce(j->>'product_source_id','')!~'^[0-9]{1,40}$' or j->>'product_source_id'~'^0+$'
   or jsonb_typeof(j->'product_id') is distinct from 'string' or coalesce(j->>'product_id','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   or jsonb_typeof(j->'source_hash') is distinct from 'string' or coalesce(j->>'source_hash','')!~'^[a-f0-9]{64}$'
   or jsonb_typeof(j->'source_version') is distinct from 'string' or coalesce(j->>'source_version','')!~'^[1-9][0-9]{0,17}$'
   or jsonb_typeof(j->'target') is distinct from 'string' or coalesce(j->>'target','')!~'^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$' or j->>'target'='-0.000000')
  or exists(select 1 from jsonb_array_elements(p_items)j group by j->>'product_source_id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_items)j group by j->>'product_id' having count(*)>1)then
  raise exception 'stock_opening_items_invalid' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','origin-stock-opening-v1','actor',p_user_id,'warehouse_source_id',p_warehouse_source_id,
  'occurred_on',p_occurred_on,'items',p_items,'preview_hash',p_preview_hash,'confirmed',true)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_stock.opening_access(p_user_id);
 select * into c from erp_stock.opening_command where id=p_command_id;
 if found then
  perform erp_stock.opening_access(p_user_id,true);
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'stock_opening_command_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('current',erp_stock.opening_current(p_command_id),'replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id)then raise exception 'stock_opening_command_conflict' using errcode='40001';end if;
 b:=erp_stock.opening_binding(p_warehouse_source_id);
 if p_preview_hash<>erp_stock.opening_preview_hash(p_user_id,b.source_id,b.warehouse_id,p_occurred_on,p_items)then
  raise exception 'stock_opening_preview_conflict' using errcode='40001';end if;
 select array_agg(j->>'product_source_id'),array_agg((j->>'product_id')::uuid)into ids,pids from jsonb_array_elements(p_items)j;
 -- Same business order as018/070/090, and staging sources under SHARE after the catalogue as088.
 perform pg_advisory_xact_lock(174852909,0);perform erp_stock.opening_access(p_user_id);
 perform 1 from erp_catalog.record where id=b.warehouse_id or id=any(pids)order by id for update;perform erp_stock.opening_access(p_user_id);
 perform 1 from erp_catalog.product where record_id=any(pids)order by record_id for update;perform erp_stock.opening_access(p_user_id);
 perform 1 from erp_stock.balance where warehouse_id=b.warehouse_id and product_id=any(pids)order by product_id,warehouse_id for update;
 perform 1 from origin_sync.raw_record where entity='stock_balances' and source_id=any(ids)order by source_id collate "C" for share;
 perform erp_stock.opening_access(p_user_id,true);
 select * into w from erp_catalog.record where id=b.warehouse_id;
 if w.id is null or not w.active then raise exception 'stock_opening_warehouse_unavailable' using errcode='22023';end if;
 allow:=erp_stock.negative_allowed();
 for item in select value from jsonb_array_elements(p_items)order by value->>'product_source_id' collate "C" loop
  r:=null;outcome:='skipped';why:=null;mid:=null;rid:=null;
  select * into r from erp_stock.opening_rows(b.source_id,b.warehouse_id,allow,array[item->>'product_source_id']);
  if r.product_source_id is null then why:='SOURCE_CHANGED';
  elsif r.product_id is null then why:='NATIVE_PRODUCT_MISSING';
  elsif r.product_id<>(item->>'product_id')::uuid then why:='PRODUCT_CHANGED';
  elsif r.status in('adopted','adopted_zero','adopted_reversed') then why:='ALREADY_ADOPTED';
  elsif r.status='native_movements' then why:='NATIVE_MOVEMENTS';
  elsif r.source_hash is distinct from item->>'source_hash' or r.source_version::text is distinct from item->>'source_version' then why:='SOURCE_CHANGED';
  elsif r.status not in('positive','zero','negative') then why:=coalesce(r.reason,'SOURCE_CHANGED');
  elsif r.target is distinct from item->>'target' then why:='SOURCE_CHANGED';
  -- The adopted quantity is read in the native unit the administrator saw in the pinned batch, never in another one.
  elsif r.unit is distinct from item->>'unit' then why:='UNIT_CHANGED';
  else
   if r.status='zero' then outcome:='adopted_zero';
   else
    -- Deterministic per-pair stock command: a replay of this batch can never post the pair again.
    derived:=md5(p_command_id::text||':'||r.product_id::text||':'||b.warehouse_id::text)::uuid;
    if erp_stock.command_taken(derived)then raise exception 'stock_opening_command_conflict' using errcode='40001';end if;
    movement:=erp_stock.post(p_user_id,derived,'adjustment',p_occurred_on,'Saldo de abertura (Origin)','Abertura Origin depósito '||b.source_id,
     jsonb_build_array(jsonb_build_object('product_id',r.product_id,'warehouse_id',b.warehouse_id,'quantity',r.adjustment,'expected_version',r.current_version)));
    mid:=(movement#>>'{movement,id}')::uuid;outcome:='adopted';
   end if;
   insert into erp_stock.opening_receipt(product_id,warehouse_id,warehouse_source_id,product_source_id,command_id,movement_id,outcome,target,previous_quantity,
    adjustment,unit,source_hash,source_version,source_seen_at,occurred_on,actor)
   values(r.product_id,b.warehouse_id,b.source_id,r.product_source_id,p_command_id,mid,outcome,r.target::numeric,coalesce(r.current_quantity::numeric,0),
    r.adjustment::numeric,r.unit,r.source_hash,r.source_version,r.source_seen_at,p_occurred_on,p_user_id)returning id into rid;
  end if;
  results:=results||jsonb_build_array(jsonb_build_object('product_source_id',item->>'product_source_id','product_id',item->>'product_id','outcome',outcome,'reason',why,
   'target',item->>'target','adjustment',case when outcome='skipped' then null else r.adjustment end,'movement_id',mid,'receipt_id',rid));
 end loop;
 receipt:=jsonb_build_object('command_id',p_command_id,'warehouse_source_id',b.source_id,'warehouse_id',b.warehouse_id,'occurred_on',p_occurred_on,
  'preview_hash',p_preview_hash,'completed_at',clock_timestamp(),'items',results,'summary',jsonb_build_object(
   'adopted',(select count(*)from jsonb_array_elements(results)x where x->>'outcome'='adopted'),
   'adopted_zero',(select count(*)from jsonb_array_elements(results)x where x->>'outcome'='adopted_zero'),
   'skipped',(select count(*)from jsonb_array_elements(results)x where x->>'outcome'='skipped')));
 result:=jsonb_build_object('scope','stock_opening_command','profile','origin-stock-opening-v1','data_mode','erp_native','receipt',receipt);
 insert into erp_stock.opening_command(id,actor,request_hash,warehouse_source_id,occurred_on,preview_hash,result)
  values(p_command_id,p_user_id,h,b.source_id,p_occurred_on,p_preview_hash,result);
 -- auth.users KEY SHARE and membership SHARE stay held through the deferred FKs and commit.
 perform erp_stock.opening_access(p_user_id,true);
 return result||jsonb_build_object('current',erp_stock.opening_current(p_command_id),'replayed',false);
end$$;
create function public.erp_stock_opening_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_stock.opening_command;begin
 perform erp_stock.opening_access(p_user_id);
 if p_command_id is null then raise exception 'stock_opening_query_invalid' using errcode='22023';end if;
 select * into c from erp_stock.opening_command where id=p_command_id;
 if not found then raise exception 'stock_opening_command_not_found' using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception 'stock_opening_access_denied' using errcode='42501';end if;
 return c.result||jsonb_build_object('current',erp_stock.opening_current(p_command_id),'replayed',true);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
revoke all on type erp_stock.opening_row from public;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_policy_get','erp_stock_policy_set','erp_stock_policy_command','erp_stock_opening_warehouses','erp_stock_opening_page',
 'erp_stock_opening_batch','erp_stock_opening_apply','erp_stock_opening_command')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
