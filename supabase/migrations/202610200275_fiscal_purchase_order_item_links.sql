-- 275 (notas fiscais lane, wave F): "Vincular à pedido de compra" item a item (Estoque › Notas fiscais de entrada › Mais ações).
-- * A note of entry links a pedido de compra as before (142/215), and now may say which item of the note fulfils which item of the pedido
--   and how much (total or partial), with the summary of the items linked and still to link. Without items the link is the whole pedido,
--   as before. "Desvincular pedido compra" removes the pedido and its item links, in one audited command.
-- * The quantities never pass the item of the pedido (all notes together) nor the item of the note (all pedidos together); an item with a
--   product only links an item of the pedido with the same product (an item without product links any item).
-- * A link counts while the pedido is still linked to the note, the note is not deleted, the item of the note keeps its product and the
--   item of the pedido still exists; otherwise it is shown as no longer valid and left out of the Vinculação. Editing the pedido or the
--   note is never blocked by a link.
-- * Vinculação of the pedidos de compra list (176): Vinculado / Parcial / Não vinculado by product, counting the item links of the notes
--   that have them for that pedido and, for the other notes, their items with the product (the rule of 176); the items without product
--   count once the pedido has item links.
-- Nothing here posts stock or contas. Requires 142, 176 and 215; the replaced functions are hash-checked first.
begin;

do $$declare v record;begin
 if to_regclass('erp_fiscal_invoices.invoice_order') is null or to_regprocedure('erp_fiscal_invoices.require_single_invoice(uuid,text,jsonb)') is null
  or to_regprocedure('erp_fiscal_invoices.require_orders_readable(text,uuid,jsonb)') is null then raise exception 'fiscal_order_items_275_requires_176_215' using errcode='55000'; end if;
 for v in select * from(values
  ('public.erp_fiscal_invoice_link(uuid,uuid,jsonb)','c2bcc592e554db2c3d64f682e88c5a461b23d8f3bddcf44847dc13e5323ec73d'),
  ('public.erp_fiscal_invoice_order_link_states(uuid,jsonb)','75e321596fd3e909db2cc2452e050e8ad3d57a50da993a2307309b2532616c26'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'fiscal_order_items_275_previous_definition_changed' using errcode='55000',detail=v.sig; end if;
 end loop;
end$$;

create table erp_fiscal_invoices.invoice_order_item(
 invoice_id uuid not null references erp_fiscal_invoices.invoice(id),
 document_id uuid not null references erp_documents.document(id),
 invoice_position integer not null check(invoice_position between 1 and 990),
 -- The item of the pedido, without a foreign key: editing the pedido is never blocked; a removed item leaves the link invalid.
 document_item_id uuid not null,
 quantity numeric not null check(quantity>0 and quantity<100000000000 and quantity=trunc(quantity,4)),
 -- The product of the item of the note when it was linked; the link counts while the item keeps it.
 product_id uuid,
 command_id uuid not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 primary key(invoice_id,document_id,invoice_position,document_item_id)
);
create index erp_fiscal_invoice_order_item_document on erp_fiscal_invoices.invoice_order_item(document_id);
alter table erp_fiscal_invoices.invoice_order_item enable row level security;
revoke all on erp_fiscal_invoices.invoice_order_item from public,anon,authenticated,service_role;

-- Quantity of 4 decimals as text (the contract of the note items).
create function erp_fiscal_invoices.quantity_text(p numeric) returns text language sql immutable set search_path=pg_catalog as $$ select to_char(trunc(p,4),'FM99999999990.0000') $$;
-- The links of a pedido that count now, with the quantity that counts (never above the item of the note or of the pedido).
create function erp_fiscal_invoices.order_item_links(p_document uuid) returns table(invoice_id uuid,invoice_position integer,document_item_id uuid,product_id uuid,quantity numeric)
language sql stable set search_path=pg_catalog as $$
 select x.invoice_id,x.invoice_position,x.document_item_id,di.product_id,least(x.quantity,ni.quantity,di.quantity)
 from erp_fiscal_invoices.invoice_order_item x
 join erp_fiscal_invoices.invoice_order o on o.invoice_id=x.invoice_id and o.document_id=x.document_id
 join erp_fiscal_invoices.invoice n on n.id=x.invoice_id and n.deleted_at is null and n.direction='0'
 join erp_fiscal_invoices.invoice_item ni on ni.invoice_id=x.invoice_id and ni.position=x.invoice_position and ni.product_id is not distinct from x.product_id
 join erp_documents.item di on di.id=x.document_item_id and di.document_id=x.document_id
 where x.document_id=p_document and (ni.product_id is null or di.product_id is null or ni.product_id=di.product_id);
$$;

-- Vinculação of one pedido de compra: none, partial or linked (176 plus the item links).
create function erp_fiscal_invoices.order_link_state(p_document uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
begin
 if not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=p_document and n.deleted_at is null and n.direction='0') then
  return 'none'; end if;
 if exists(select 1 from (select i.product_id,sum(i.quantity) needed from erp_documents.item i where i.document_id=p_document and i.product_id is not null group by i.product_id) p
  where p.needed>coalesce((select sum(l.quantity) from erp_fiscal_invoices.order_item_links(p_document) l where l.product_id=p.product_id),0)
   +coalesce((select sum(ni.quantity) from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
     join erp_fiscal_invoices.invoice_item ni on ni.invoice_id=n.id where o.document_id=p_document and n.deleted_at is null and n.direction='0' and ni.product_id=p.product_id
      and not exists(select 1 from erp_fiscal_invoices.invoice_order_item x where x.invoice_id=n.id and x.document_id=p_document)),0)) then return 'partial'; end if;
 if exists(select 1 from erp_fiscal_invoices.invoice_order_item x where x.document_id=p_document)
  and exists(select 1 from erp_documents.item i where i.document_id=p_document and i.product_id is null
   and i.quantity>coalesce((select sum(l.quantity) from erp_fiscal_invoices.order_item_links(p_document) l where l.document_item_id=i.id),0)) then return 'partial'; end if;
 return 'linked';
end $$;

-- The item links of one note to one pedido, for the screen: each with the quantity linked, the quantity that counts and whether it counts.
create function erp_fiscal_invoices.order_item_rows(p_invoice uuid,p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('invoice_position',x.invoice_position,'document_item_id',x.document_item_id,'quantity',erp_fiscal_invoices.quantity_text(x.quantity),
   'counted',erp_fiscal_invoices.quantity_text(coalesce(l.quantity,0)),'valid',l.invoice_id is not null) order by x.invoice_position,x.document_item_id),'[]'::jsonb)
 from erp_fiscal_invoices.invoice_order_item x
 left join erp_fiscal_invoices.order_item_links(p_document) l on l.invoice_id=x.invoice_id and l.invoice_position=x.invoice_position and l.document_item_id=x.document_item_id
 where x.invoice_id=p_invoice and x.document_id=p_document;
$$;

-- 215 plus the items of the link (entry notes and pedidos de compra only) and their removal on "Desvincular pedido compra".
create or replace function public.erp_fiscal_invoice_link(p_user_id uuid,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare role text;h text;replay jsonb;v erp_fiscal_invoices.invoice%rowtype;v_id uuid;doc uuid;expected integer;action text;rec jsonb;result jsonb;
 items jsonb:='[]'::jsonb;e jsonb;v_pos integer;v_item uuid;v_qty numeric;ni erp_fiscal_invoices.invoice_item%rowtype;di erp_documents.item%rowtype;removed integer:=0;
begin
 role:=erp_fiscal_invoices.require_write(p_user_id);
 if p_command_id is null or p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('invoice_id','expected_version','action','document_id','items'))
  or not p_data ?& array['invoice_id','expected_version','action','document_id'] or jsonb_typeof(p_data->'action') is distinct from 'string' or p_data->>'action' not in('link','unlink')
  or (p_data?'items' and (p_data->>'action'<>'link' or jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items') not between 1 and 990)) then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 v_id:=erp_fiscal_invoices.uuid_input(p_data->'invoice_id');doc:=erp_fiscal_invoices.uuid_input(p_data->'document_id');expected:=erp_fiscal_invoices.version_input(p_data->'expected_version');action:=p_data->>'action';
 h:=erp_fiscal_invoices.command_hash(p_user_id,'invoice',action||'_order',p_data);
 replay:=erp_fiscal_invoices.command_replay(p_command_id,p_user_id,'invoice',h);
 if replay is not null then return replay; end if;
 select * into v from erp_fiscal_invoices.invoice where id=v_id for update;
 if not found then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 if v.version<>expected or v.version=2147483647 or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_version_conflict' using errcode='40001'; end if;
 if not exists(select 1 from erp_documents.document d where d.id=doc and d.kind=any(case v.direction when '1' then array['sales_orders','service_orders'] else array['purchase_orders'] end)) then
  raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
 if action='link' then
  perform erp_fiscal_invoices.require_orders_readable(role,v_id,jsonb_build_array(doc));
  if exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (select count(*) from erp_fiscal_invoices.invoice_order where invoice_id=v_id)>=20 then raise exception 'erp_fiscal_invoice_order_limit' using errcode='22023'; end if;
  perform erp_fiscal_invoices.require_single_invoice(v_id,v.direction,jsonb_build_array(doc));
  -- Item links of this note to pedidos it no longer has (a save that changed its pedidos) never count; they are dropped before the new
  -- link, so an earlier link of this same pedido never comes back with it (whole or item a item).
  delete from erp_fiscal_invoices.invoice_order_item x where x.invoice_id=v_id and not exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=v_id and o.document_id=x.document_id);
  insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values(v_id,doc);
  -- 275: the items of the link (item a item), only for a note of entry and a pedido de compra.
  if p_data?'items' then
   if v.direction<>'0' then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
   -- Every note linking this pedido waits here, so the quantities of the items of the pedido are summed once.
   perform pg_advisory_xact_lock(174852947,hashtext(doc::text));
   for e in select value from jsonb_array_elements(p_data->'items') loop
    if jsonb_typeof(e)<>'object' or exists(select 1 from jsonb_object_keys(e) k where k not in('position','document_item_id','quantity')) or not e ?& array['position','document_item_id','quantity']
     or jsonb_typeof(e->'position')<>'number' or (e->>'position')!~'^[1-9][0-9]{0,2}$' or jsonb_typeof(e->'quantity')<>'string' or (e->>'quantity')!~'^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$' then
     raise exception 'erp_fiscal_invoice_link_item_invalid' using errcode='22023'; end if;
    v_pos:=(e->>'position')::integer;v_item:=erp_fiscal_invoices.uuid_input(e->'document_item_id');v_qty:=(e->>'quantity')::numeric;
    if v_qty<=0 then raise exception 'erp_fiscal_invoice_link_item_invalid' using errcode='22023'; end if;
    select * into ni from erp_fiscal_invoices.invoice_item where invoice_id=v_id and position=v_pos;
    if not found then raise exception 'erp_fiscal_invoice_link_item_invalid' using errcode='22023'; end if;
    select * into di from erp_documents.item where id=v_item and document_id=doc;
    if not found then raise exception 'erp_fiscal_invoice_link_item_invalid' using errcode='22023'; end if;
    if ni.product_id is not null and di.product_id is not null and ni.product_id<>di.product_id then raise exception 'erp_fiscal_invoice_link_item_product_mismatch' using errcode='22023'; end if;
    -- One link never passes the item of the pedido nor the item of the note (the sums below count each link up to those quantities).
    if v_qty>di.quantity or v_qty>ni.quantity then raise exception 'erp_fiscal_invoice_link_item_exceeds' using errcode='22023'; end if;
    if exists(select 1 from erp_fiscal_invoices.invoice_order_item x where x.invoice_id=v_id and x.document_id=doc and x.invoice_position=v_pos and x.document_item_id=v_item) then
     raise exception 'erp_fiscal_invoice_link_item_invalid' using errcode='22023'; end if;
    insert into erp_fiscal_invoices.invoice_order_item(invoice_id,document_id,invoice_position,document_item_id,quantity,product_id,command_id,created_by)
     values(v_id,doc,v_pos,v_item,v_qty,ni.product_id,p_command_id,p_user_id);
   end loop;
   -- Never above the item of the pedido (all notes) nor the item of the note (all pedidos), for the items this command links (an
   -- item already above after an edit of the pedido or of the note never blocks the links of the other items).
   if exists(select 1 from erp_documents.item i where i.document_id=doc
     and exists(select 1 from erp_fiscal_invoices.invoice_order_item n where n.command_id=p_command_id and n.invoice_id=v_id and n.document_id=doc and n.document_item_id=i.id)
     and i.quantity<(select coalesce(sum(l.quantity),0) from erp_fiscal_invoices.order_item_links(doc) l where l.document_item_id=i.id))
    or exists(select 1 from erp_fiscal_invoices.invoice_item ii where ii.invoice_id=v_id
     and exists(select 1 from erp_fiscal_invoices.invoice_order_item n where n.command_id=p_command_id and n.invoice_id=v_id and n.document_id=doc and n.invoice_position=ii.position)
     and ii.quantity<(select coalesce(sum(x.quantity),0) from erp_fiscal_invoices.invoice_order_item x join erp_fiscal_invoices.invoice_order o on o.invoice_id=x.invoice_id and o.document_id=x.document_id
      where x.invoice_id=v_id and x.invoice_position=ii.position)) then
    raise exception 'erp_fiscal_invoice_link_item_exceeds' using errcode='22023'; end if;
  end if;
 else
  if not exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc) then raise exception 'erp_fiscal_invoice_order_state_conflict' using errcode='40001'; end if;
  if (erp_fiscal_invoices.edit_locks(v_id)->>'items')::boolean or (erp_fiscal_invoices.edit_locks(v_id)->>'installments')::boolean then
   raise exception 'erp_fiscal_invoice_locked_by_order' using errcode='40001'; end if;
  delete from erp_fiscal_invoices.invoice_order where invoice_id=v_id and document_id=doc;
  -- 275: the item links of that pedido go with it (the command and the audit keep how many).
  delete from erp_fiscal_invoices.invoice_order_item where invoice_id=v_id and document_id=doc;
  get diagnostics removed=row_count;
 end if;
 update erp_fiscal_invoices.invoice set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 rec:=erp_fiscal_invoices.invoice_record(v_id);
 insert into erp_fiscal_invoices.invoice_revision(invoice_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_invoices.invoice_envelope(rec,role)||jsonb_build_object('action',action||'_order','replayed',false,'document_id',doc);
 -- 275: the item links of the pedido after the command (empty after unlink) and how many the unlink removed.
 if v.direction='0' then result:=result||jsonb_build_object('items',erp_fiscal_invoices.order_item_rows(v_id,doc),'removed_items',removed); end if;
 insert into erp_fiscal_invoices.command(command_id,actor,scope,request_hash,result) values(p_command_id,p_user_id,'invoice',h,result);
 insert into erp_fiscal_invoices.audit(actor,command_id,scope,entity_id,version,action,reason) values(p_user_id,p_command_id,'invoice',v_id,(rec->>'version')::integer,action||'_order',
  doc::text||case when p_data?'items' then ' itens:'||jsonb_array_length(p_data->'items') when removed>0 then ' itens removidos:'||removed else '' end);
 return result;
end $$;

-- 176 with the item links (order_link_state).
create or replace function public.erp_fiscal_invoice_order_link_states(p_user_id uuid,p_document_ids jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.role_of(p_user_id);v_ids uuid[];v_items jsonb;
begin
 if p_document_ids is null or jsonb_typeof(p_document_ids)<>'array' or jsonb_array_length(p_document_ids)>100 then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if not erp_documents.allowed(role,'purchase_orders',false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 v_ids:=array(select distinct erp_fiscal_invoices.uuid_input(x) from jsonb_array_elements(p_document_ids) x);
 select coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'state',erp_fiscal_invoices.order_link_state(d.id)) order by d.id),'[]'::jsonb)
 into v_items from erp_documents.document d where d.id=any(v_ids) and d.kind='purchase_orders';
 return jsonb_build_object('items',v_items,'data_mode','erp_native');
end $$;

-- The summary of "Vincular à pedido de compra" for one note and one pedido: the item links of this note, what the other notes already
-- link of each item of the pedido and the Vinculação of the pedido. Read only; the pedido is read only by who reads pedidos de compra
-- (or when it is already linked to the note, as 176).
create function public.erp_fiscal_invoice_order_items(p_user_id uuid,p_invoice_id uuid,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v erp_fiscal_invoices.invoice%rowtype;
begin
 if p_invoice_id is null or p_document_id is null then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id;
 if not found or v.deleted_at is not null then raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 if v.direction<>'0' or not exists(select 1 from erp_documents.document d where d.id=p_document_id and d.kind='purchase_orders') then raise exception 'erp_fiscal_invoice_order_not_found' using errcode='22023'; end if;
 perform erp_fiscal_invoices.require_orders_readable(role,p_invoice_id,jsonb_build_array(p_document_id));
 return jsonb_build_object('invoice_id',p_invoice_id,'document_id',p_document_id,
  'linked',exists(select 1 from erp_fiscal_invoices.invoice_order o where o.invoice_id=p_invoice_id and o.document_id=p_document_id),
  'items',erp_fiscal_invoices.order_item_rows(p_invoice_id,p_document_id),
  'others',(select coalesce(jsonb_agg(jsonb_build_object('document_item_id',s.document_item_id,'quantity',erp_fiscal_invoices.quantity_text(s.quantity)) order by s.document_item_id),'[]'::jsonb)
   from (select l.document_item_id,sum(l.quantity) quantity from erp_fiscal_invoices.order_item_links(p_document_id) l where l.invoice_id<>p_invoice_id group by l.document_item_id) s),
  'state',erp_fiscal_invoices.order_link_state(p_document_id),'data_mode','erp_native');
end $$;

revoke all on function erp_fiscal_invoices.order_item_links(uuid),erp_fiscal_invoices.order_link_state(uuid),erp_fiscal_invoices.order_item_rows(uuid,uuid),erp_fiscal_invoices.quantity_text(numeric)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_link(uuid,uuid,jsonb),public.erp_fiscal_invoice_order_link_states(uuid,jsonb),public.erp_fiscal_invoice_order_items(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_link(uuid,uuid,jsonb),public.erp_fiscal_invoice_order_link_states(uuid,jsonb),public.erp_fiscal_invoice_order_items(uuid,uuid,uuid) to service_role;
commit;
