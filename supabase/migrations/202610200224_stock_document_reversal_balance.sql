-- 224: "Considerar estorno para o cálculo do saldo atual se houver balanço após o lançamento original" (Preferências > Suprimentos >
-- Estoque) também no estorno pelo documento: o estorno do lançamento de estoque do pedido de venda, da OS ou do pedido de compra (018) e
-- o estorno de um recebimento de compra (090). Requer 145 (estorno manual após balanço), 182 e 222. Nenhum movimento, saldo ou documento
-- existente é reescrito; muda só a regra dos próximos estornos.
-- - Opção ligada (o padrão do Origin): nada muda.
-- - Opção desligada: cada posição do lançamento original com um Balanço registrado depois dele (e não estornado) recebe o ajuste de
--   compensação da 145, com comando derivado do comando do estorno, antes do estorno quando ele baixaria o saldo e depois dele quando
--   aumentaria. O estorno fica no histórico do documento e o saldo atual da posição não muda. A prévia marca essas posições
--   ("balance_kept") e não as recusa por saldo, porque o saldo delas não muda.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_stock.derived_command(uuid,text)')is null or to_regclass('erp_stock.composition')is null then
  raise exception 'stock_document_reversal_224_requires_145_222' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.post(uuid,uuid,text,date,text,text,jsonb,uuid)','a8b54f2292e334e35ff0a5cc5c16a1b528be011f42557bf1e4b452a23fb96b95'),
  ('erp_stock.document_reverse_preview_data(erp_documents.document,uuid,integer,date,text)','054cf0de91c01a425c9f8961b9c6ff5d6a8d80cde3cb9447694b45789376636e'),
  ('erp_purchase_receipts.preview(uuid,erp_documents.document,text,date,text,jsonb,uuid)','7e94d5f2287c23c0277b7ecc802e8519938a66a1b6bd3406e87e8d0ab6f04298'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_document_reversal_224_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- A position of a lançamento keeps its current balance when the option is off and a Balanço was registered for it after the lançamento
-- (182: a Balanço that was itself reversed does not count). The rule of erp_stock_reverse (145/182).
create function erp_stock.balance_kept(p_movement uuid,p_product uuid,p_warehouse uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(erp_preferences.get('estoque.estorno_balanco')='false'::jsonb,false)
  and not exists(select 1 from erp_stock.movement where id=p_movement and kind='reversal')
  and exists(select 1 from erp_stock.balance_count c join erp_stock.movement b on b.id=c.movement_id join erp_stock.movement o on o.id=p_movement
   where c.product_id=p_product and c.warehouse_id=p_warehouse and b.created_at>o.created_at and not exists(select 1 from erp_stock.movement x where x.reverses_id=b.id))
$$;

-- 1. Motor (070) with the compensation of a document or receipt reversal. The manual "Estornar lançamento" keeps doing its own (145/182):
-- it never reverses a movement of a document or a receipt. The compensations go straight to the engine, marked for their own command.
create or replace function erp_stock.post(p_user_id uuid,p_command_id uuid,p_kind text,p_occurred_on date,p_reason text,p_reference text,p_items jsonb,p_reverses_id uuid default null)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare result jsonb;v_items jsonb:=p_items;v_before jsonb;v_after jsonb;v_pre uuid;v_post uuid;v_reason text:='Estorno anterior ao balanço: saldo atual mantido';begin
 perform erp_stock.require_access(p_user_id,true);perform pg_advisory_xact_lock(174852909,0);perform erp_stock.require_access(p_user_id,true);
 if not exists(select 1 from erp_stock.command where id=p_command_id) and exists(select 1 from erp_stock.reservation_command where id=p_command_id) then
  raise exception 'erp_stock_command_conflict' using errcode='40001';end if;
 if p_kind='reversal' and p_reverses_id is not null and p_command_id is not null and jsonb_typeof(p_items)='array'
  and not exists(select 1 from erp_stock.command where id=p_command_id)
  and(exists(select 1 from erp_stock.document_posting where movement_id=p_reverses_id)or exists(select 1 from erp_purchase_receipts.receipt where movement_id=p_reverses_id))then
  -- 224: the positions that keep their balance; a reversal that lowers one is compensated before it, one that raises it after it.
  select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity',ltrim(i->>'quantity','-'),'expected_version',i->'expected_version'))
   into v_before from jsonb_array_elements(p_items) i
   where jsonb_typeof(i)='object' and i->>'quantity' like '-%' and erp_stock.balance_kept(p_reverses_id,(i->>'product_id')::uuid,(i->>'warehouse_id')::uuid);
  select jsonb_agg(jsonb_build_object('product_id',i->'product_id','warehouse_id',i->'warehouse_id','quantity','-'||(i->>'quantity'),'expected_version',to_jsonb((i->>'expected_version')::bigint+1)))
   into v_after from jsonb_array_elements(p_items) i
   where jsonb_typeof(i)='object' and i->>'quantity' not like '-%' and erp_stock.balance_kept(p_reverses_id,(i->>'product_id')::uuid,(i->>'warehouse_id')::uuid);
  if v_before is not null or v_after is not null then
   v_pre:=erp_stock.derived_command(p_command_id,'before');v_post:=erp_stock.derived_command(p_command_id,'after');
   if v_before is not null then
    select jsonb_agg(case when exists(select 1 from jsonb_array_elements(v_before) b where b->'product_id'=i->'product_id' and b->'warehouse_id'=i->'warehouse_id')
      then jsonb_set(i,'{expected_version}',to_jsonb((i->>'expected_version')::bigint+1)) else i end) into v_items from jsonb_array_elements(p_items) i;
    perform set_config('erp_stock.reversal_compensation',v_pre::text,true);
    perform erp_stock.post_physical_025(p_user_id,v_pre,'adjustment',p_occurred_on,v_reason,null,v_before);
    perform set_config('erp_stock.reversal_compensation','',true);
   end if;
   result:=erp_stock.post_physical_025(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,v_items,p_reverses_id);
   if v_after is not null then
    perform set_config('erp_stock.reversal_compensation',v_post::text,true);
    perform erp_stock.post_physical_025(p_user_id,v_post,'adjustment',p_occurred_on,v_reason,null,v_after);
    perform set_config('erp_stock.reversal_compensation','',true);
   end if;
   perform erp_stock.reservation_write_access(p_user_id);
   return result||jsonb_build_object('balance_adjustments',(select coalesce(jsonb_agg(c.result->'movement' order by c.created_at,c.id),'[]'::jsonb)from erp_stock.command c where c.id in(v_pre,v_post)));
  end if;
 end if;
 result:=erp_stock.post_physical_025(p_user_id,p_command_id,p_kind,p_occurred_on,p_reason,p_reference,p_items,p_reverses_id);
 perform erp_stock.reservation_write_access(p_user_id);return result;
end $$;

-- 2. Prévia do estorno do documento (100): the positions that keep their balance are marked and are not refused for the balance they
-- would reach without the compensation. The rest of the body is the published one; without such a position the preview (and its hash)
-- is exactly the published one.
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
  'expected_version',b.version,'sources','[]'::jsonb)||case when erp_stock.balance_kept(p.movement_id,e.product_id,e.warehouse_id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end
  order by e.product_id,e.warehouse_id) into positions
 from erp_stock.entry e join erp_stock.balance b on b.product_id=e.product_id and b.warehouse_id=e.warehouse_id join erp_catalog.record r on r.id=e.product_id where e.movement_id=p.movement_id;
 if positions is null or jsonb_array_length(positions) not between 1 and 100 or exists(select 1 from jsonb_array_elements(positions) j where((j->>'quantity')::numeric<0 and(j->>'balance_after')::numeric<0 and not erp_stock.negative_allowed() and not j?'balance_kept')
  or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','reverse','document',erp_stock.document_summary(d.id),'posting',erp_stock.document_posting_summary(p.id),
  'direction','reversal','occurred_on',p_day,'reason',p_reason,'warehouse',p.snapshot->'warehouse','positions',positions,'ignored','[]'::jsonb);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

-- 3. Prévia do recebimento de compra (100) for a reversal: a position that keeps its balance is marked ("balance_kept") and is not
-- refused for the balance or the reservations it would reach without the compensation (its balance does not change). The rest of the
-- body is the published one; without such a position the preview (and its hash) is exactly the published one.
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
 -- 224: a reversed position that keeps its balance (Balanço after the receipt, option off) is not refused for its balance.
 if exists(select 1 from(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')g
  left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id
  where((g.qty<0 and coalesce(b.quantity,0)+g.qty<0 and not erp_stock.negative_allowed())
  or coalesce(b.quantity,0)+g.qty>999999999999.999999 or coalesce(b.quantity,0)+g.qty<-999999999999.999999
  or(g.qty<0 and erp_stock.reserved_quantity(g.product_id,w.id)>0 and coalesce(b.quantity,0)+g.qty-erp_stock.reserved_quantity(g.product_id,w.id)<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id))or b.version=2147483647)then
  raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 with groups as(select(j->>'product_id')::uuid product_id,sum((j->>'quantity')::numeric)qty from jsonb_array_elements(lines)j group by j->>'product_id')
 select jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',c.name,'warehouse_id',w.id,'unit',p.unit,'quantity',g.qty::numeric(18,6)::text,
  'catalog_version',c.version,'physical_version',coalesce(b.version,0),'reservation_hash',erp_stock.reservation_position_hash(g.product_id,w.id),
  'physical_before',coalesce(b.quantity,0)::numeric(18,6)::text,'reserved_before',q.qty::numeric(18,6)::text,'available_before',(coalesce(b.quantity,0)-q.qty)::numeric(18,6)::text,
  'physical_after',(coalesce(b.quantity,0)+g.qty)::numeric(18,6)::text,'available_after',(coalesce(b.quantity,0)+g.qty-q.qty)::numeric(18,6)::text)
  -- 224: the conferência of the reversal says which positions keep their balance (the compensation is posted with the reversal).
  ||case when p_action='reverse' and erp_stock.balance_kept(r.movement_id,g.product_id,w.id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end order by g.product_id)into positions
 from groups g join erp_catalog.record c on c.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id cross join lateral(select erp_stock.reserved_quantity(g.product_id,w.id)qty)q;
 if positions is null or jsonb_array_length(positions)not between 1 and 100 then raise exception 'purchase_receipt_position_limit'using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions)j where(((j->>'quantity')::numeric<0 and(j->>'physical_after')::numeric<0 and not erp_stock.negative_allowed())
  or(j->>'physical_after')::numeric>999999999999.999999 or(j->>'physical_after')::numeric<-999999999999.999999
  or((j->>'quantity')::numeric<0 and(j->>'reserved_before')::numeric>0 and(j->>'available_after')::numeric<0))
  and not(p_action='reverse' and erp_stock.balance_kept(r.movement_id,(j->>'product_id')::uuid,w.id))or(j->>'physical_version')::integer=2147483647)then raise exception 'purchase_receipt_balance_unavailable'using errcode='40001';end if;
 result:=jsonb_build_object('action',p_action,'document',erp_purchase_receipts.document(d.id),'receipt_id',p_receipt,'occurred_on',p_day,'reason',btrim(p_reason),
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'items',lines,'positions',positions);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end$$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_purchase_receipts from public,anon,authenticated,service_role;
commit;
