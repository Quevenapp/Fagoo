-- 280: "Componentes do item (kit)" do pedido de venda e da OS, no padrão do Origin (lápis "Editar componentes do produto" do item;
-- modal com Componente, Qtde Un, Estoque, Qtde Total, "Remover componente" e "Adicionar outro componente"). Onda F do estoque.
-- Requer 222, 226, 238, 259 e 277.
-- - Um item de composição (formato "Com composição", com estrutura e "Lançar estoque" Componentes ou Produto e componente) pode ter os
--   seus componentes próprios: os produtos e a quantidade por composição. O cadastro do produto e a estrutura não mudam; os outros
--   pedidos continuam com a estrutura. "Restaurar estrutura" volta ao que está no cadastro. Os componentes são do produto do item: o
--   item que troca de produto (ou sai do pedido) perde os componentes editados (gatilho em erp_documents.item, só apaga as linhas de
--   erp_stock.item_component desse item).
-- - Só enquanto o pedido pode ser editado e sem estoque lançado, sem reserva ativa e sem a nota fiscal que lançou o estoque. A gravação
--   é um comando idempotente ("Conferir resultado"), com versão esperada do pedido e dos componentes do item, auditoria do documento,
--   e passa a versão do pedido (as conferências abertas de estoque ficam recusadas pelo hash).
-- - O Lançar estoque do pedido (018/184), a reserva do pedido (070) e a reserva pelas situações de venda (145) passam a movimentar os
--   componentes do item. A nota fiscal continua com a estrutura do cadastro (o desmembramento na nota é da frente de notas).
-- Funções substituídas (o corpo publicado é conferido pelo hash, sem CR; outra versão interrompe a migração).
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.composition_current') is null or to_regprocedure('erp_stock.reserve_situation_ids()') is null
  or to_regprocedure('erp_documents.contact_usable(uuid,uuid)') is null then
  raise exception 'stock_item_components_280_requires_222_238_277' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.command_taken(uuid)','935e3fa5f33062cd40802f648ef67ad5976660915725f35057d9aae98fec74a2'),
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','b2ebfd139eca17c8f3ec445d25ff15b7d42e732285594848dada7ee4ee7bd96b'),
  ('erp_stock.situation_reservations(uuid)','f8f72875d60b374b7ef30e477537d7cfbee4bf34cc7823536c30482fa3052fbf'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_item_components_280_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regclass('erp_stock.item_component') is not null then raise exception 'stock_item_components_280_already_applied' using errcode='55000';end if;
end$$;

-- 1. Tables. The components of an item ([{component_id, quantity}] per composition) and one immutable receipt per command.
create table erp_stock.item_component(
 item_id uuid primary key,
 document_id uuid not null references erp_documents.document(id),
 product_id uuid not null references erp_catalog.product(record_id),
 components jsonb not null check(jsonb_typeof(components)='array' and jsonb_array_length(components) between 1 and 100),
 version integer not null check(version between 1 and 2147483647),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references auth.users(id),command_id uuid not null
);
create index erp_stock_item_component_document on erp_stock.item_component(document_id);
create table erp_stock.item_component_command(
 id uuid primary key,actor uuid not null references auth.users(id),document_id uuid not null references erp_documents.document(id),item_id uuid not null,
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_stock_item_component_command before update or delete on erp_stock.item_component_command for each row execute function erp_stock.immutable_ledger();
-- Only a command writes the components of an item: a new row starts at version 1, every change is one version more.
create function erp_stock.guard_item_component()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if(tg_op='INSERT' and new.version<>1)or(tg_op='UPDATE' and(new.item_id<>old.item_id or new.document_id<>old.document_id or new.product_id<>old.product_id
   or new.version<>old.version+1 or new.command_id=old.command_id))then
  raise exception 'erp_stock_item_component_immutable' using errcode='40001';end if;
 return new;
end$$;
create trigger guard_stock_item_component before insert or update on erp_stock.item_component for each row execute function erp_stock.guard_item_component();
-- As in Origin, the components belong to the product of the item: an item that changes its product (or leaves the pedido) loses the
-- components edited for the previous one, so going back to that product starts again from its structure.
create function erp_stock.forget_item_components()returns trigger language plpgsql security definer set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or new.product_id is distinct from old.product_id then
  delete from erp_stock.item_component where item_id=old.id;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end$$;
create trigger forget_stock_item_components after update of product_id or delete on erp_documents.item for each row execute function erp_stock.forget_item_components();
do $$declare t text;begin foreach t in array array['item_component','item_component_command']loop
 execute format('alter table erp_stock.%I enable row level security',t);
 execute format('revoke all on erp_stock.%I from public,anon,authenticated,service_role',t);
end loop;end$$;

-- One UUID identifies one effect across every stock command family, now including the components of an item.
create or replace function erp_stock.command_taken(p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_stock.command where id=p_id)or exists(select 1 from erp_stock.document_command where id=p_id)
  or exists(select 1 from erp_stock.reservation_command where id=p_id)or exists(select 1 from erp_purchase_receipts.command where id=p_id)
  or exists(select 1 from erp_stock.policy_command where id=p_id)or exists(select 1 from erp_stock.opening_command where id=p_id)
  or exists(select 1 from erp_stock.warehouse_command where id=p_id)or exists(select 1 from erp_stock.ledger_command where id=p_id)
  or exists(select 1 from erp_stock.count_command where id=p_id)or exists(select 1 from erp_stock.dashboard_command where id=p_id)
  or exists(select 1 from erp_stock.checkin_command where id=p_id)or exists(select 1 from erp_stock.supply_command where id=p_id)
  or exists(select 1 from erp_stock.composition_command where id=p_id)or exists(select 1 from erp_stock.lot_command where id=p_id)
  or exists(select 1 from erp_stock.invoice_command where id=p_id)or exists(select 1 from erp_stock.item_component_command where id=p_id)
$$;

-- 2. The components of an item: the edited ones (same product as the item), else the structure of the composition.
create function erp_stock.item_component_rows(p_item uuid,p_product uuid)returns table(component_id uuid,quantity numeric,post_mode text,ordinal integer)
language sql stable set search_path=pg_catalog as $$
 select(x.value->>'component_id')::uuid,(x.value->>'quantity')::numeric,c.post_mode,x.n::integer from erp_stock.item_component k
   join erp_stock.composition c on c.product_id=k.product_id cross join lateral jsonb_array_elements(k.components) with ordinality x(value,n)
  where k.item_id=p_item and k.product_id=p_product
 union all
 select ci.component_id,ci.quantity,ci.post_mode,ci.position from erp_stock.composition_current ci
  where ci.product_id=p_product and not exists(select 1 from erp_stock.item_component k where k.item_id=p_item and k.product_id=p_product)
$$;
-- composition_lines (222) for one item: the same rules, with the components of the item.
create function erp_stock.item_composition_lines(p_item uuid,p_product uuid,p_quantity numeric)returns table(product_id uuid,quantity numeric,per_kit numeric,role text)
language plpgsql stable set search_path=pg_catalog as $$
declare c erp_stock.composition;v_problem text;begin
 if not exists(select 1 from erp_stock.item_component k where k.item_id=p_item and k.product_id=p_product)then
  return query select * from erp_stock.composition_lines(p_product,p_quantity);return;end if;
 select * into c from erp_stock.composition x where x.product_id=p_product;
 if c.product_id is null or not exists(select 1 from erp_catalog.product p where p.record_id=p_product and p.format='E')then
  raise exception 'erp_stock_composition_structure_missing' using errcode='22023';end if;
 if c.post_mode in('product','both')then return query select p_product,p_quantity,1::numeric,'composition'::text;end if;
 if c.post_mode in('components','both')then
  select erp_stock.component_problem(i.component_id) into v_problem from erp_stock.item_component_rows(p_item,p_product) i where erp_stock.component_problem(i.component_id) is not null limit 1;
  if v_problem is not null then raise exception 'erp_stock_composition_component_unavailable' using errcode='22023',detail=v_problem;end if;
  return query select i.component_id,erp_stock.component_quantity(p_quantity,i.quantity),i.quantity,'component'::text from erp_stock.item_component_rows(p_item,p_product) i order by i.ordinal;
 end if;
end$$;

-- 3. Stock of the pedido (018/184/070 through document_preview_data) and the reservation by situation (145/277) with them.
create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';l record;begin
 perform erp_stock.document_meta(p_day,p_reason);
 if not erp_stock.document_eligible(d.kind,d.status) then raise exception 'erp_document_stock_ineligible_state' using errcode='40001';end if;
 if exists(select 1 from erp_stock.document_posting where document_id=d.id and state='active') then raise exception 'erp_document_stock_already_posted' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852909,0);
 -- 259: the stock of a pedido whose note posted it ("S" of the note) is not posted again.
 if erp_stock.invoice_posted_for_document(d.id) then raise exception 'erp_document_stock_posted_by_invoice' using errcode='40001';end if;
 -- The 011 importer takes catalog rows in UUID order; never prelock catalog before the stock lock. 222: the components of the
 -- compositions of the document are locked in the same pass and order.
 -- 280: also the components of an item whose kit components were edited ("Componentes do item (kit)").
 perform 1 from erp_catalog.record where id=d.warehouse_id or id in(select product_id from erp_documents.item where document_id=d.id)
  or id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id)
  or id in(select c.component_id from erp_documents.item i cross join lateral erp_stock.item_component_rows(i.id,i.product_id) c where i.document_id=d.id) order by id for update;
 perform 1 from erp_catalog.product where record_id in(select product_id from erp_documents.item where document_id=d.id)
  or record_id in(select c.component_id from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id where i.document_id=d.id)
  or record_id in(select c.component_id from erp_documents.item i cross join lateral erp_stock.item_component_rows(i.id,i.product_id) c where i.document_id=d.id) order by record_id for update;
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
  elsif row.format='V' or(row.format='E' and d.kind='purchase_orders') then raise exception 'erp_document_stock_composition_unsupported' using errcode='22023';
  elsif row.unit is distinct from row.data->>'unit' then raise exception 'erp_document_stock_unit_mismatch' using errcode='22023';
  elsif row.format='E' then
   -- 280: the components edited for this item replace the structure of the composition.
   for l in select * from erp_stock.item_composition_lines(row.id,row.product_id,row.quantity) loop
    v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',l.product_id,'quantity',l.quantity::text,'source',case when l.role='composition'
     then jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::numeric(18,6)::text)
     else jsonb_build_object('id',row.id,'position',row.position,'quantity',l.quantity::numeric(18,6)::text,'kit_product_id',row.product_id,
      'kit_quantity',row.quantity::numeric(18,6)::text,'component_quantity',l.per_kit::numeric(18,6)::text)end));
   end loop;
  else
   v_lines:=v_lines||jsonb_build_array(jsonb_build_object('product_id',row.product_id,'quantity',row.quantity::text,
    'source',jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::text)));
  end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with lines as(select(j->>'product_id')::uuid product_id,(j->>'quantity')::numeric qty,j->'source' source from jsonb_array_elements(v_lines)j),
 groups as(select product_id,sum(qty) qty,jsonb_agg(source order by(source->>'position')::integer) sources from lines group by product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources) order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_document_stock_position_limit' using errcode='22023';end if;
 -- 182: a sales order needs both the company policy and "Permite venda de produtos com estoque negativo".
 if exists(select 1 from jsonb_array_elements(positions) j where ((j->>'quantity')::numeric<0 and (j->>'balance_after')::numeric<0
   and not(erp_stock.negative_allowed() and(d.kind<>'sales_orders' or erp_stock.sales_negative_allowed())))
  or (j->>'balance_after')::numeric>999999999999.999999 or (j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','post','document',erp_stock.document_summary(d.id),'direction',direction,'occurred_on',p_day,'reason',p_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

create or replace function erp_stock.situation_reservations(p_product uuid default null)
returns table(document_id uuid,document_number bigint,status text,contact_name text,product_id uuid,warehouse_id uuid,quantity numeric,unit text)
language sql stable set search_path=pg_catalog as $$
 with s as(select erp_stock.reserve_statuses() statuses,erp_stock.reserve_situation_ids() situation_ids,(erp_stock.settings_dto()->>'reserve_by_warehouse')::boolean by_warehouse,
   (select d.warehouse_id from erp_stock.warehouse_default d where d.singleton) standard),
 items as(select d.id,d.number,d.status,d.contact_snapshot,d.warehouse_id,i.product_id,i.quantity,p.unit,p.format,i.id item_id
  from s cross join erp_documents.document d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
  -- 277: also a pedido in a custom situation (situação personalizada, 163) chosen in "Reserva de estoque pelas situações de venda".
  where(cardinality(s.statuses)>0 or cardinality(s.situation_ids)>0) and d.kind='sales_orders'
   and(d.status=any(s.statuses) or exists(select 1 from erp_documents.document_situation ds where ds.document_id=d.id and ds.situation_id=any(s.situation_ids)))
   -- One product (Saldos do produto): its own items and the composition items that have it as a component, as the 145 filter did.
   and(p_product is null or i.product_id=p_product or exists(select 1 from erp_stock.item_component_rows(i.id,i.product_id) c where c.component_id=p_product))
   and p.kind='P' and p.unit is not null and i.data->>'unit' is not distinct from p.unit
   and not exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active')
   -- 259: a pedido whose note posted the stock has no reservation left.
   and not erp_stock.invoice_posted_for_document(d.id)
   and not exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active')),
 -- 222: a composition item reserves what its lançamento would move; a composition without a structure reserves nothing.
 lines as(select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id target,x.quantity qty,x.unit target_unit from items x where x.format is distinct from 'E'
  union all
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,x.product_id,x.quantity,x.unit from items x join erp_stock.composition c on c.product_id=x.product_id
   where x.format='E' and c.post_mode in('product','both')
  union all
  -- 280: the components edited for the item ("Componentes do item (kit)") instead of the structure.
  select x.id,x.number,x.status,x.contact_snapshot,x.warehouse_id,ci.component_id,x.quantity*ci.quantity,cp.unit from items x cross join lateral erp_stock.item_component_rows(x.item_id,x.product_id) ci
   join erp_catalog.product cp on cp.record_id=ci.component_id
   where x.format='E' and ci.post_mode in('components','both') and cp.kind='P' and cp.unit is not null)
 select l.id,l.number,l.status,l.contact_snapshot->>'name',l.target,case when s.by_warehouse then coalesce(l.warehouse_id,s.standard)end,sum(l.qty),l.target_unit
 from s cross join lines l where p_product is null or l.target=p_product
 group by l.id,l.number,l.status,l.contact_snapshot,l.target,l.target_unit,s.by_warehouse,s.standard,l.warehouse_id
$$;

-- 4. Leitura do modal "Componentes do item (kit)": a composição do item, os componentes (do item ou da estrutura) com o estoque e se
-- podem ser alterados agora. Quem lê o documento.
create function erp_stock.item_components_dto(p_user uuid,p_document uuid,p_item uuid)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document;i erp_documents.item;p erp_catalog.product;c erp_stock.composition;k erp_stock.item_component;v_role text;v_stock boolean;v_reason text;begin
 select * into d from erp_documents.document where id=p_document;
 select * into i from erp_documents.item where id=p_item and document_id=p_document;
 if i.id is null then raise exception 'erp_document_item_not_found' using errcode='P0002';end if;
 select * into p from erp_catalog.product where record_id=i.product_id;
 select * into c from erp_stock.composition where product_id=i.product_id;
 select * into k from erp_stock.item_component where item_id=i.id and product_id=i.product_id;
 select role into v_role from erp_access.membership where user_id=p_user and active;
 v_stock:=coalesce(v_role in('admin','consulta','estoque','vendas','fiscal'),false);
 v_reason:=case when p.record_id is null or p.format is distinct from 'E' then 'not_composition'
  when c.product_id is null or not exists(select 1 from erp_stock.composition_current x where x.product_id=i.product_id) then 'no_structure'
  when c.post_mode='product' then 'product_only'
  when not erp_documents.allowed(v_role,d.kind,true) then 'role'
  when not erp_documents.editable(d.status) then 'locked'
  when exists(select 1 from erp_stock.document_posting x where x.document_id=d.id and x.state='active') then 'posted'
  when exists(select 1 from erp_stock.reservation x where x.document_id=d.id and x.state='active') then 'reserved'
  when erp_stock.invoice_posted_for_document(d.id) then 'invoice' end;
 return jsonb_build_object('document',jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,'warehouse_id',d.warehouse_id),
  'item',jsonb_build_object('id',i.id,'position',i.position,'product_id',i.product_id,'description',i.data->>'description','quantity',i.quantity::numeric(18,6)::text,'unit',i.data->>'unit'),
  'product',(select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'format',p.format) from erp_catalog.record r where r.id=i.product_id),
  'composition',case when c.product_id is not null then jsonb_build_object('stock_type',c.stock_type,'post_mode',c.post_mode,'version',c.version) end,
  'structure',coalesce((select jsonb_agg(jsonb_build_object('component_id',x.component_id,'quantity',x.quantity::numeric(18,6)::text) order by x.position)
   from erp_stock.composition_current x where x.product_id=i.product_id),'[]'::jsonb),
  'edited',k.item_id is not null,'version',coalesce(k.version,0),'stock_visible',v_stock,
  'components',coalesce((select jsonb_agg(jsonb_build_object('component_id',x.component_id,'name',r.name,'code',r.code,'unit',cp.unit,'active',r.active,
    'problem',erp_stock.component_problem(x.component_id),'quantity',x.quantity::numeric(18,6)::text,'total',(x.quantity*i.quantity)::numeric(30,12)::text,
    'stock',case when v_stock then(select coalesce(sum(b.quantity),0) from erp_stock.balance b where b.product_id=x.component_id
      and(b.warehouse_id=d.warehouse_id or(d.warehouse_id is null and not erp_stock.ignored_warehouse(b.warehouse_id))))::numeric(18,6)::text end) order by x.ordinal)
   from erp_stock.item_component_rows(i.id,i.product_id) x join erp_catalog.record r on r.id=x.component_id left join erp_catalog.product cp on cp.record_id=x.component_id),'[]'::jsonb),
  'editable',v_reason is null,'reason_code',v_reason);
end$$;
create function public.erp_stock_item_components(p_user_id uuid,p_document_id uuid,p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document;begin
 if p_document_id is null or p_item_id is null then raise exception 'erp_stock_invalid_query' using errcode='22023';end if;
 select * into d from erp_documents.document where id=p_document_id and kind in('sales_orders','service_orders');
 if d.id is null then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 perform erp_documents.require_access(p_user_id,d.kind,false);
 -- 238: a document of a contact the user does not see is not found.
 if not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 return jsonb_build_object('scope','stock_item_components','data_mode','erp_native')||erp_stock.item_components_dto(p_user_id,d.id,p_item_id);
end$$;

-- 5. Gravação ("Salvar" do modal): p_components [{"component_id": uuid, "quantity": "1.5"}] (por composição) ou null ("Restaurar estrutura").
-- Grava quem edita o documento (o perfil do pedido de venda ou da OS).
create function public.erp_stock_item_components_save(p_user_id uuid,p_command_id uuid,p_document_id uuid,p_expected_document_version integer,p_item_id uuid,
  p_expected_version integer,p_components jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_stock.item_component_command;d erp_documents.document;v_kind text;v_view jsonb;k erp_stock.item_component;v_before jsonb;v_after jsonb;v_result jsonb;v_clean jsonb;begin
 if p_command_id is null or p_document_id is null or p_item_id is null or p_expected_document_version is null or p_expected_document_version not between 1 and 2147483646
  or p_expected_version is null or p_expected_version not between 0 and 2147483646
  or(p_components is not null and(jsonb_typeof(p_components)<>'array' or jsonb_array_length(p_components) not between 1 and 100
   or exists(select 1 from jsonb_array_elements(p_components)j where jsonb_typeof(j)<>'object' or exists(select 1 from jsonb_object_keys(j)x where x not in('component_id','quantity'))
    or jsonb_typeof(j->'component_id') is distinct from 'string' or coalesce(j->>'component_id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(j->'quantity') is distinct from 'string' or coalesce(j->>'quantity','')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or(j->>'quantity')::numeric=0)
   or(select count(distinct j->>'component_id')from jsonb_array_elements(p_components)j)<>jsonb_array_length(p_components)))then
  raise exception 'erp_stock_item_components_invalid' using errcode='22023';end if;
 select kind into v_kind from erp_documents.document where id=p_document_id and kind in('sales_orders','service_orders');
 if v_kind is null then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 perform erp_documents.require_access(p_user_id,v_kind,true);
 h:=encode(sha256(convert_to(jsonb_build_object('profile','stock-item-components-280','actor',p_user_id,'document_id',p_document_id,'document_version',p_expected_document_version,
  'item_id',p_item_id,'expected_version',p_expected_version,'components',p_components)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852918,hashtext(p_command_id::text));perform erp_documents.require_access(p_user_id,v_kind,true);
 select * into c from erp_stock.item_component_command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_stock_item_components_conflict' using errcode='40001';end if;
  return c.result||jsonb_build_object('replayed',true);
 end if;
 if erp_stock.command_taken(p_command_id) or exists(select 1 from erp_documents.command where command_id=p_command_id) then
  raise exception 'erp_stock_item_components_conflict' using errcode='40001';end if;
 -- The document first (as every document writer), then the components of the item.
 select * into d from erp_documents.document where id=p_document_id for update;
 if not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002';end if;
 if d.version<>p_expected_document_version or d.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001';end if;
 v_view:=erp_stock.item_components_dto(p_user_id,d.id,p_item_id);
 if not(v_view->>'editable')::boolean then raise exception 'erp_stock_item_components_locked' using errcode='40001',detail=v_view->>'reason_code';end if;
 select * into k from erp_stock.item_component where item_id=p_item_id for update;
 -- Components saved while the item had another product never apply to the current one (item_component_rows matches the product, and
 -- forget_item_components drops them when the product changes): the item reads as not edited (version 0), so such a row is dropped
 -- and this save starts again at version 1.
 if k.item_id is not null and k.product_id<>(v_view#>>'{item,product_id}')::uuid then
  delete from erp_stock.item_component where item_id=p_item_id;k:=null;end if;
 if coalesce(k.version,0)<>p_expected_version then raise exception 'erp_stock_item_components_version_conflict' using errcode='40001';end if;
 v_before:=v_view->'components';
 if p_components is null then
  if k.item_id is null then raise exception 'erp_stock_item_components_unchanged' using errcode='22023';end if;
 else
  if exists(select 1 from jsonb_array_elements(p_components)j where erp_stock.component_problem((j->>'component_id')::uuid) is not null
    or(j->>'component_id')::uuid=(v_view#>>'{item,product_id}')::uuid)then
   raise exception 'erp_stock_composition_component_unavailable' using errcode='22023';end if;
  select jsonb_agg(jsonb_build_object('component_id',j->>'component_id','quantity',((j->>'quantity')::numeric)::numeric(18,6)::text) order by n) into v_clean
   from jsonb_array_elements(p_components) with ordinality x(j,n);
  if v_clean=(select jsonb_agg(jsonb_build_object('component_id',x->>'component_id','quantity',x->>'quantity') order by n) from jsonb_array_elements(v_before) with ordinality y(x,n)) then
   raise exception 'erp_stock_item_components_unchanged' using errcode='22023';end if;
 end if;
 if p_components is null then delete from erp_stock.item_component where item_id=p_item_id;
 elsif k.item_id is null then
  insert into erp_stock.item_component(item_id,document_id,product_id,components,version,updated_by,command_id)
   values(p_item_id,d.id,(v_view#>>'{item,product_id}')::uuid,v_clean,1,p_user_id,p_command_id);
 else update erp_stock.item_component set components=v_clean,version=version+1,updated_at=clock_timestamp(),updated_by=p_user_id,command_id=p_command_id where item_id=p_item_id;
 end if;
 -- The pedido changes version: an open stock or reservation conferência of it is refused by its hash and the editor reads it again.
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 v_view:=erp_stock.item_components_dto(p_user_id,d.id,p_item_id);v_after:=v_view->'components';
 v_result:=jsonb_build_object('scope','stock_item_components_save','data_mode','erp_native','restored',p_components is null)||v_view;
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
  values(p_user_id,p_command_id,d.id,'kit_components','Componentes do item (kit)',jsonb_build_object('item_id',p_item_id,'components',v_before),jsonb_build_object('item_id',p_item_id,'components',v_after));
 insert into erp_stock.item_component_command(id,actor,document_id,item_id,request_hash,result)values(p_command_id,p_user_id,d.id,p_item_id,h,v_result);
 return v_result||jsonb_build_object('replayed',false);
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_stock_item_components','erp_stock_item_components_save')loop
 execute format('revoke all on function %s from public,anon,authenticated',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
