-- Native purchase receipts only. No adoption, finance, fiscal, status transition or opening.
-- Existing018 receipts and its one-active-posting index are preserved literally.
begin;
create schema erp_purchase_receipts;
revoke all on schema erp_purchase_receipts from public,anon,authenticated,service_role;
alter default privileges in schema erp_purchase_receipts revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_purchase_receipts revoke all on functions from public,anon,authenticated,service_role;
create table erp_purchase_receipts.command(
 id uuid primary key,actor uuid not null references auth.users(id),document_id uuid not null references erp_documents.document(id),
 action text not null check(action in('receive','reverse')),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_purchase_receipts.receipt(
 id uuid primary key default gen_random_uuid(),document_id uuid not null references erp_documents.document(id),
 source_document_version integer not null check(source_document_version>0),document_version integer not null check(document_version=source_document_version+1),
 command_id uuid not null unique references erp_purchase_receipts.command(id) deferrable initially deferred,
 movement_id uuid not null unique references erp_stock.movement(id),actor uuid not null references auth.users(id),
 snapshot jsonb not null,preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
create index purchase_receipt_document on erp_purchase_receipts.receipt(document_id,id);
create table erp_purchase_receipts.reversal(
 id uuid primary key default gen_random_uuid(),receipt_id uuid not null unique references erp_purchase_receipts.receipt(id),
 document_id uuid not null references erp_documents.document(id),source_document_version integer not null check(source_document_version>0),
 document_version integer not null check(document_version=source_document_version+1),
 command_id uuid not null unique references erp_purchase_receipts.command(id) deferrable initially deferred,
 movement_id uuid not null unique references erp_stock.movement(id),actor uuid not null references auth.users(id),
 snapshot jsonb not null,preview_hash text not null check(preview_hash~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['command','receipt','reversal']loop
 execute format('alter table erp_purchase_receipts.%I enable row level security',t);
 execute format('revoke all on erp_purchase_receipts.%I from public,anon,authenticated,service_role',t);
 execute format('create trigger immutable_purchase_%1$s before update or delete on erp_purchase_receipts.%1$I for each row execute function erp_stock.immutable_ledger()',t);
end loop;end$$;

-- VOLATILE deliberately: authorization after a wait must use a fresh statement snapshot.
create function erp_purchase_receipts.access(p_actor uuid,p_lock boolean default false) returns void
language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role in('admin','estoque'))then
  raise exception 'purchase_receipt_access_denied' using errcode='42501';end if;
 if p_lock then
  perform 1 from auth.users where id=p_actor for key share;
  if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role in('admin','estoque'))then raise exception 'purchase_receipt_access_denied' using errcode='42501';end if;
  perform 1 from erp_access.membership where user_id=p_actor for share;
  if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role in('admin','estoque'))then raise exception 'purchase_receipt_access_denied' using errcode='42501';end if;
 end if;
end$$;
create function erp_purchase_receipts.active(p_document uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_purchase_receipts.receipt r where r.document_id=p_document and not exists(select 1 from erp_purchase_receipts.reversal x where x.receipt_id=r.id))
$$;
create function erp_purchase_receipts.chain_hash(p_document uuid) returns text language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(r.id,r.command_id,r.preview_hash,r.document_version,x.id,x.command_id,x.preview_hash,x.document_version)order by r.id),'[]')::text,'UTF8')),'hex')
 from erp_purchase_receipts.receipt r left join erp_purchase_receipts.reversal x on x.receipt_id=r.id where r.document_id=p_document
$$;
create function erp_purchase_receipts.received(p_document uuid,p_item uuid) returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(sum((i->>'quantity')::numeric),0) from erp_purchase_receipts.receipt r cross join lateral jsonb_array_elements(r.snapshot->'items')i
 where r.document_id=p_document and i->>'item_id'=p_item::text and not exists(select 1 from erp_purchase_receipts.reversal x where x.receipt_id=r.id)
$$;
create function erp_purchase_receipts.document(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,'date',d.body->>'date','warehouse_id',d.warehouse_id,
 'eligible',erp_stock.document_eligible(d.kind,d.status) and not exists(select 1 from erp_stock.document_posting where document_id=d.id),
 'mode',case when exists(select 1 from erp_stock.document_posting where document_id=d.id)then'legacy_full' when exists(select 1 from erp_purchase_receipts.receipt where document_id=d.id)then'item_receipts'else'available'end,
 'chain_hash',erp_purchase_receipts.chain_hash(d.id),'active_receipts',(select count(*)::integer from erp_purchase_receipts.receipt r where r.document_id=d.id and not exists(select 1 from erp_purchase_receipts.reversal x where x.receipt_id=r.id)))
 from erp_documents.document d where d.id=p_id and d.kind='purchase_orders'
$$;
create function erp_purchase_receipts.current(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('document',erp_purchase_receipts.document(p_id),'items',coalesce(jsonb_agg(jsonb_build_object(
 'item_id',i.id,'position',i.position,'product_id',i.product_id,'description',i.data->>'description','unit',i.data->>'unit',
 'ordered_quantity',i.quantity::text,'received_quantity',q.qty::numeric(18,6)::text,'remaining_quantity',(i.quantity-q.qty)::numeric(18,6)::text,'catalog_version',r.version,
 'eligibility',case when i.product_id is null then'unlinked_item'when p.kind='S'then'service'when not coalesce(r.active,false)then'inactive_product'
 when p.kind is distinct from'P'or p.format in('E','V')or p.unit is null then'unsupported_product'when p.unit is distinct from i.data->>'unit'then'unit_mismatch'else'eligible'end
 )order by i.position),'[]'))from erp_documents.item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
 cross join lateral(select erp_purchase_receipts.received(p_id,i.id)qty)q where i.document_id=p_id
 and not exists(select 1 from erp_stock.document_posting where document_id=p_id)
$$;
create function erp_purchase_receipts.record(p_id uuid,p_reverse boolean default false,p_full boolean default true) returns jsonb language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 with row as(select to_jsonb(r)j from erp_purchase_receipts.receipt r where not p_reverse and r.id=p_id union all select to_jsonb(x) from erp_purchase_receipts.reversal x where p_reverse and x.id=p_id)
 select jsonb_build_object('id',j->'id','document_id',j->'document_id','source_document_version',j->'source_document_version','document_version',j->'document_version',
 'command_id',j->'command_id','movement_id',j->'movement_id','occurred_on',j#>'{snapshot,occurred_on}','reason',j#>'{snapshot,reason}',
 'created_at',j->'created_at','warehouse_id',j#>'{snapshot,warehouse,id}','item_count',jsonb_array_length(j#>'{snapshot,items}'),'position_count',jsonb_array_length(j#>'{snapshot,positions}'),'preview_hash',j->'preview_hash')
 ||case when p_full then jsonb_build_object('items',j#>'{snapshot,items}','positions',j#>'{snapshot,positions}')else'{}'::jsonb end
 ||case when p_reverse then jsonb_build_object('receipt_id',j->'receipt_id')else'{}'::jsonb end from row
$$;
create function erp_purchase_receipts.lock_document(p_actor uuid,p_document uuid,p_version integer) returns erp_documents.document
language plpgsql set search_path=pg_catalog as $$declare d erp_documents.document;begin
 perform erp_purchase_receipts.access(p_actor);
 if p_document is null or p_version is null or p_version not between 1 and 2147483646 then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 select * into d from erp_documents.document where id=p_document and kind='purchase_orders'for update;
 perform erp_purchase_receipts.access(p_actor);
 if d.id is null then raise exception 'purchase_receipt_document_not_found'using errcode='P0002';end if;
 if d.version<>p_version then raise exception 'purchase_receipt_document_changed'using errcode='40001';end if;
 return d;
end$$;

create function erp_purchase_receipts.apply(p_actor uuid,p_document uuid,p_version integer,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid,p_command uuid,p_hash text,p_confirm boolean)
returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare d erp_documents.document;c erp_purchase_receipts.command;request_hash text;preview jsonb;items jsonb;movement jsonb;original_movement uuid;id uuid;result jsonb;begin
 perform erp_purchase_receipts.access(p_actor);
 if p_command is null or p_confirm is distinct from true or p_hash is null or p_hash!~'^[a-f0-9]{64}$'
 or p_action not in('receive','reverse')or p_action is null then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'document_id',p_document,'version',p_version,'action',p_action,'occurred_on',p_day,'reason',p_reason,'items',p_items,'receipt_id',p_receipt,'preview_hash',p_hash,'confirm',p_confirm)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command::text));perform erp_purchase_receipts.access(p_actor);
 select *into c from erp_purchase_receipts.command where command.id=p_command;
 if c.id is not null then
  perform erp_purchase_receipts.access(p_actor,true);
  if c.actor<>p_actor or c.request_hash<>request_hash then raise exception 'purchase_receipt_command_conflict'using errcode='40001';end if;
  return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','receipt',c.result,'current',erp_purchase_receipts.current(c.document_id),'replayed',true);
 end if;
 d:=erp_purchase_receipts.lock_document(p_actor,p_document,p_version);
 preview:=erp_purchase_receipts.preview(p_actor,d,p_action,p_day,p_reason,p_items,p_receipt);
 if p_hash<>preview->>'preview_hash'then raise exception 'purchase_receipt_preview_changed'using errcode='40001';end if;
 -- Global009 and command018 mutexes are held; old and new command families cannot mix.
 if exists(select 1 from erp_stock.command where command.id=p_command)
 or exists(select 1 from erp_stock.document_command where document_command.id=p_command)
 or exists(select 1 from erp_stock.reservation_command where reservation_command.id=p_command)then raise exception 'purchase_receipt_command_conflict'using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('product_id',j->'product_id','warehouse_id',j->'warehouse_id','quantity',j->'quantity','expected_version',j->'physical_version')order by j->>'product_id')into items from jsonb_array_elements(preview->'positions')j;
 if p_action='reverse'then select movement_id into original_movement from erp_purchase_receipts.receipt where receipt.id=p_receipt;end if;
 movement:=erp_stock.post(p_actor,p_command,case when p_action='receive'then'receipt'else'reversal'end,p_day,p_reason,'Recebimento compra '||d.number::text,items,original_movement);
 if p_action='receive'then
  insert into erp_purchase_receipts.receipt(document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash)
  values(d.id,d.version,d.version+1,p_command,(movement#>>'{movement,id}')::uuid,p_actor,preview-'preview_hash',p_hash)returning receipt.id into id;
 else
  insert into erp_purchase_receipts.reversal(receipt_id,document_id,source_document_version,document_version,command_id,movement_id,actor,snapshot,preview_hash)
  values(p_receipt,d.id,d.version,d.version+1,p_command,(movement#>>'{movement,id}')::uuid,p_actor,preview-'preview_hash',p_hash)returning reversal.id into id;
 end if;
 update erp_documents.document set version=version+1,updated_by=p_actor,updated_at=clock_timestamp()where document.id=d.id;
 result:=jsonb_build_object('command_id',p_command,'action',p_action,'document_id',d.id,'document_version',d.version+1,
 'receipt',erp_purchase_receipts.record(case when p_action='receive'then id else p_receipt end),
 'reversal',case when p_action='reverse'then erp_purchase_receipts.record(id,true)end);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,after_data)values(p_actor,p_command,d.id,'purchase_'||p_action,btrim(p_reason),result);
 insert into erp_purchase_receipts.command(id,actor,document_id,action,request_hash,result)values(p_command,p_actor,d.id,p_action,request_hash,result);
 -- auth.users KEY SHARE and membership SHARE remain held through deferred FK checks/commit.
 perform erp_purchase_receipts.access(p_actor);
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','receipt',result,'current',erp_purchase_receipts.current(d.id),'replayed',false);
end$$;
create function public.erp_purchase_receipts_receive(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_occurred_on date,p_reason text,p_items jsonb,p_command_id uuid,p_preview_hash text,p_confirm boolean)
returns jsonb language sql security definer set search_path=pg_catalog set timezone='UTC' as $$
 select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'receive',p_occurred_on,p_reason,p_items,null,p_command_id,p_preview_hash,p_confirm)
$$;
create function public.erp_purchase_receipts_reverse(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_receipt_id uuid,p_occurred_on date,p_reason text,p_command_id uuid,p_preview_hash text,p_confirm boolean)
returns jsonb language sql security definer set search_path=pg_catalog set timezone='UTC' as $$
 select erp_purchase_receipts.apply(p_user_id,p_document_id,p_expected_version,'reverse',p_occurred_on,p_reason,null,p_receipt_id,p_command_id,p_preview_hash,p_confirm)
$$;

create function erp_purchase_receipts.guard_document() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if erp_purchase_receipts.active(old.id)then
  if tg_op='DELETE'or(to_jsonb(new)-array['status','version','updated_at','updated_by'])is distinct from(to_jsonb(old)-array['status','version','updated_at','updated_by'])
   or not erp_documents.effects_transition_allowed(old.kind,old.status,new.status)then raise exception 'purchase_receipt_active'using errcode='40001';end if;
 end if;if tg_op='DELETE'then return old;end if;return new;
end$$;
create trigger protect_purchase_receipt_document before update or delete on erp_documents.document for each row execute function erp_purchase_receipts.guard_document();
create function erp_purchase_receipts.guard_item() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if(tg_op<>'INSERT'and erp_purchase_receipts.active(old.document_id))or(tg_op<>'DELETE'and erp_purchase_receipts.active(new.document_id))then
  raise exception 'purchase_receipt_active'using errcode='40001';end if;if tg_op='DELETE'then return old;end if;return new;
end$$;
create trigger protect_purchase_receipt_item before insert or update or delete on erp_documents.item for each row execute function erp_purchase_receipts.guard_item();
create function erp_purchase_receipts.guard_legacy() returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_purchase_receipts.receipt where document_id=new.document_id)then raise exception 'purchase_receipt_legacy_mixing'using errcode='40001';end if;return new;
end$$;
create trigger protect_purchase_receipt_legacy before insert on erp_stock.document_posting for each row execute function erp_purchase_receipts.guard_legacy();

-- Existing function contract/ACL/identity retained; only the current stock flag expands.
create or replace function erp_documents.effect_flags(p_id uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('finance_active',exists(select 1 from erp_finance.document_posting p where p.document_id=p_id and p.state='active'),
 'stock_active',exists(select 1 from erp_stock.document_posting p where p.document_id=p_id and p.state='active')or erp_purchase_receipts.active(p_id))
$$;

create function erp_purchase_receipts.preview(p_actor uuid,d erp_documents.document,p_action text,p_day date,p_reason text,p_items jsonb,p_receipt uuid default null)
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
  where coalesce(b.quantity,0)+g.qty<0 or coalesce(b.quantity,0)+g.qty>999999999999.999999
  or coalesce(b.quantity,0)+g.qty-erp_stock.reserved_quantity(g.product_id,w.id)<0 or b.version=2147483647)then
  raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 with groups as(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')
 select jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',c.name,'warehouse_id',w.id,'unit',p.unit,'quantity',g.qty::numeric(18,6)::text,
  'catalog_version',c.version,'physical_version',coalesce(b.version,0),'reservation_hash',erp_stock.reservation_position_hash(g.product_id,w.id),
  'physical_before',coalesce(b.quantity,0)::numeric(18,6)::text,'reserved_before',q.qty::numeric(18,6)::text,'available_before',(coalesce(b.quantity,0)-q.qty)::numeric(18,6)::text,
  'physical_after',(coalesce(b.quantity,0)+g.qty)::numeric(18,6)::text,'available_after',(coalesce(b.quantity,0)+g.qty-q.qty)::numeric(18,6)::text)order by g.product_id)into positions
 from groups g join erp_catalog.record c on c.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id cross join lateral(select erp_stock.reserved_quantity(g.product_id,w.id)qty)q;
 if positions is null or jsonb_array_length(positions)not between 1 and 100 then raise exception 'purchase_receipt_position_limit'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions)j where(j->>'physical_after')::numeric<0 or(j->>'physical_after')::numeric>999999999999.999999 or(j->>'available_after')::numeric<0 or(j->>'physical_version')::integer=2147483647)then raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 result:=jsonb_build_object('action',p_action,'document',erp_purchase_receipts.document(d.id),'receipt_id',p_receipt,'occurred_on',p_day,'reason',btrim(p_reason),
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'items',lines,'positions',positions);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

create function public.erp_purchase_receipts_get(p_user_id uuid,p_document_id uuid,p_limit integer default 25,p_after uuid default null,p_receipt_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare page jsonb;more boolean;cursor uuid;selected jsonb;begin
 perform erp_purchase_receipts.access(p_user_id);
 if p_document_id is null or p_limit is null or p_limit not between 1 and 25 then raise exception 'purchase_receipt_input_invalid'using errcode='22023';end if;
 if erp_purchase_receipts.document(p_document_id)is null then raise exception 'purchase_receipt_document_not_found'using errcode='P0002';end if;
 if p_receipt_id is not null then
  if not exists(select 1 from erp_purchase_receipts.receipt where id=p_receipt_id and document_id=p_document_id)then raise exception 'purchase_receipt_not_found'using errcode='P0002';end if;
  selected:=jsonb_build_object('receipt',erp_purchase_receipts.record(p_receipt_id),'reversal',(select erp_purchase_receipts.record(id,true)from erp_purchase_receipts.reversal where receipt_id=p_receipt_id));
 end if;
 with candidates as materialized(select id from erp_purchase_receipts.receipt where document_id=p_document_id and(p_after is null or id>p_after)order by id limit p_limit+1),
 shown as materialized(select id from candidates order by id limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('receipt',erp_purchase_receipts.record(id,false,false),'reversal',(select erp_purchase_receipts.record(x.id,true,false)from erp_purchase_receipts.reversal x where x.receipt_id=s.id))order by id)from shown s),'[]'),
 (select count(*)>p_limit from candidates),(select id from shown order by id desc limit 1)into page,more,cursor;
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','current',erp_purchase_receipts.current(p_document_id),'items',page,'selected',selected,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor end);
end$$;
create function public.erp_purchase_receipts_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare c erp_purchase_receipts.command;begin
 perform erp_purchase_receipts.access(p_user_id);select * into c from erp_purchase_receipts.command where id=p_command_id and actor=p_user_id;
 if c.id is null then raise exception 'purchase_receipt_command_not_found'using errcode='P0002';end if;
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','receipt',c.result,'current',erp_purchase_receipts.current(c.document_id),'replayed',true);
end$$;
create function public.erp_purchase_receipts_preview(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_occurred_on date,p_reason text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','preview',erp_purchase_receipts.preview(p_user_id,d,'receive',p_occurred_on,p_reason,p_items));
end$$;
create function public.erp_purchase_receipts_reverse_preview(p_user_id uuid,p_document_id uuid,p_expected_version integer,p_receipt_id uuid,p_occurred_on date,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare d erp_documents.document;begin
 d:=erp_purchase_receipts.lock_document(p_user_id,p_document_id,p_expected_version);
 return jsonb_build_object('scope','purchase_receipts','data_mode','erp_native','preview',erp_purchase_receipts.preview(p_user_id,d,'reverse',p_occurred_on,p_reason,null,p_receipt_id));
end$$;

-- Keep018 behavior byte-for-byte except blocking reversal of the new linked movements.
create or replace function public.erp_stock_reverse(p_user_id uuid,p_movement_id uuid,p_command_id uuid,p_occurred_on date,p_reason text,p_versions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare v_items jsonb;v_count integer;begin
 perform erp_stock.require_access(p_user_id,true);
 perform pg_advisory_xact_lock(174852909,0);
 if exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_movement_id)or exists(select 1 from erp_purchase_receipts.reversal where movement_id=p_movement_id)then raise exception 'purchase_receipt_reverse_via_receipt'using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where movement_id=p_movement_id or reversal_movement_id=p_movement_id) then raise exception 'erp_stock_reverse_via_document' using errcode='40001';end if;
 if p_versions is null or jsonb_typeof(p_versions)<>'array' or jsonb_array_length(p_versions) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_versions) j where jsonb_typeof(j)<>'object' or exists(select 1 from jsonb_object_keys(j) k where k not in('product_id','warehouse_id','expected_version'))) then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 select count(*) into v_count from erp_stock.entry where movement_id=p_movement_id;
 if v_count=0 then raise exception 'erp_stock_movement_not_found' using errcode='P0002';end if;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'warehouse_id',e.warehouse_id,'quantity',(-e.quantity)::text,'expected_version',v->'expected_version') order by e.ordinal) into v_items
 from erp_stock.entry e join jsonb_array_elements(p_versions) v on v->>'product_id'=e.product_id::text and v->>'warehouse_id'=e.warehouse_id::text where e.movement_id=p_movement_id;
 if jsonb_array_length(p_versions)<>v_count or coalesce(jsonb_array_length(v_items),0)<>v_count then raise exception 'erp_stock_invalid_versions' using errcode='22023';end if;
 return erp_stock.post(p_user_id,p_command_id,'reversal',p_occurred_on,p_reason,null,v_items,p_movement_id);
end $$;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
do $$declare f record;begin for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname like 'erp_purchase_receipts_%'loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);execute format('grant execute on function %s to service_role',f.sig);
end loop;end$$;
commit;
