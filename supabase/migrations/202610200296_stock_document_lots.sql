-- 296: Lotes dos itens no lançamento e no estorno de estoque do documento, no padrão do Origin (onda G do estoque, contrato com a frente
-- de documentos, VND-029). Requer 258, 278 e 280.
-- - A frente de documentos guarda, em cada item de um produto com "Controle de lote" ("Informar lotes" do item), a lista opcional
--   erp_documents.item.data->'lots' = [{"lot_id": uuid, "quantity": "2.5"}] (até 50 lotes, cada lote uma vez, quantidade > 0 com até
--   6 casas, a soma não passa da quantidade do item). Sem a lista (ou com a lista vazia) nada muda: o item sai ou entra "Sem lote".
-- - Lançar estoque do pedido de venda, da OS e do pedido de compra lançado por inteiro (018/184, também pela reserva do pedido, 070):
--   a conferência mostra, em cada posição, os lotes informados (Lote, Validade, quantidade e o saldo do lote no depósito antes e depois)
--   e o lançamento grava as linhas de lote no mesmo movimento (saída: tira do lote; entrada: põe no lote). O que não tem lote continua
--   "Sem lote", e "Informar lotes" do lançamento (278) ainda pode completar depois. O lote nunca fica negativo; um lote inativo, de outro
--   produto ou de um produto sem "Controle de lote" é recusado na conferência.
-- - Estornar estoque do documento: as linhas de lote do lançamento voltam pelo gatilho de 258 (como sempre); a conferência agora mostra
--   esses lotes e recusa antes o estorno de uma entrada cujo lote já saiu.
-- - O recebimento parcial do pedido de compra (090) e a nota fiscal continuam "Sem lote" (o lote da nota é da frente de notas).
-- Funções substituídas (o corpo publicado é conferido pelo hash, sem CR; outra versão interrompe a migração). Nenhum documento, movimento,
-- saldo ou lote existente é reescrito; um documento sem lotes tem a mesma conferência (e o mesmo hash) de antes.
-- Ordem de travas (a mesma de todos os gravadores de estoque): comando -> documento -> mutex do estoque -> cadastro -> lotes e saldos.
begin;

do $$declare r record;begin
 if to_regclass('erp_stock.lot_entry') is null or to_regprocedure('public.erp_stock_movement_lots_assign(uuid,uuid,uuid,uuid,uuid,integer,jsonb)') is null
  or to_regclass('erp_stock.item_component') is null then
  raise exception 'stock_document_lots_296_requires_258_278_280' using errcode='55000';end if;
 for r in select * from(values
  ('erp_stock.document_preview_data(erp_documents.document,date,text)','f36006003a4d88445ddef3c1b12a023dbfcf00fb19afb27051f343bfac6636b5'),
  ('erp_stock.document_reverse_preview_data(erp_documents.document,uuid,integer,date,text)','3fe29324ba8a3d452e6e262e59432703a09933c6f4c4c3fc8cb5b953072bfe3b'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'stock_document_lots_296_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
 if to_regprocedure('erp_stock.document_item_lots(jsonb)') is not null then raise exception 'stock_document_lots_296_already_applied' using errcode='55000';end if;
end$$;

-- 1. The lots of an item (data->'lots' of erp_documents.item), validated again here: absent, null or [] is "Sem lote".
create function erp_stock.document_item_lots(p_data jsonb)returns table(lot_id uuid,quantity numeric,ordinal integer)
language plpgsql immutable set search_path=pg_catalog as $$
declare x jsonb;n integer:=0;q text;begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or not p_data ? 'lots' or jsonb_typeof(p_data->'lots')='null' then return;end if;
 if jsonb_typeof(p_data->'lots')<>'array' then raise exception 'erp_document_stock_lots_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_data->'lots')>50 or exists(select 1 from jsonb_array_elements(p_data->'lots') e where jsonb_typeof(e.value)<>'object')
  or(select count(distinct lower(value->>'lot_id')) from jsonb_array_elements(p_data->'lots'))<>jsonb_array_length(p_data->'lots') then
  raise exception 'erp_document_stock_lots_invalid' using errcode='22023';end if;
 for x in select value from jsonb_array_elements(p_data->'lots') loop
  n:=n+1;q:=case when jsonb_typeof(x->'quantity') in('string','number') then x->>'quantity' end;
  if jsonb_typeof(x)<>'object' or jsonb_typeof(x->'lot_id') is distinct from 'string' or coalesce(x->>'lot_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or coalesce(q,'')!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or q::numeric=0 then
   raise exception 'erp_document_stock_lots_invalid' using errcode='22023';end if;
  lot_id:=lower(x->>'lot_id')::uuid;quantity:=q::numeric;ordinal:=n;return next;
 end loop;
end$$;

-- 2. Conferência do lançamento (018/184/070 through document_preview_data) with the lots of the items. The rest of the body is the
-- published one (280); a document without lots has exactly the published preview.
create or replace function erp_stock.document_preview_data(d erp_documents.document,p_day date,p_reason text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare w erp_catalog.record;row record;ignored jsonb:='[]';positions jsonb;result jsonb;direction text;v_lines jsonb:='[]';l record;v_lots jsonb;begin
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
 -- 296: then the lots informed on the items, in id order (cadastro -> lotes e saldos).
 perform 1 from erp_stock.lot where id in(select x.lot_id from erp_documents.item i cross join lateral erp_stock.document_item_lots(i.data) x where i.document_id=d.id) order by id for update;
 select r.* into w from erp_catalog.record r join erp_catalog.warehouse x on x.record_id=r.id where r.id=d.warehouse_id and r.active;
 if not found then raise exception 'erp_stock_warehouse_unavailable' using errcode='22023';end if;
 for row in select i.id,i.position,i.product_id,i.quantity,i.data,r.active,r.version,p.unit,p.kind,p.format
  from erp_documents.item i left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
  where i.document_id=d.id order by i.position loop
  -- 296: "Informar lotes" of the item: a simple product with "Controle de lote", lots of that product, active, at most the quantity.
  select coalesce(jsonb_agg(jsonb_build_object('lot_id',x.lot_id,'quantity',x.quantity) order by x.ordinal),'[]'::jsonb) into v_lots from erp_stock.document_item_lots(row.data) x;
  if jsonb_array_length(v_lots)>0 then
   if row.product_id is null or erp_stock.lot_product_problem(row.product_id) is not null then
    raise exception 'erp_stock_lot_control_off' using errcode='22023',detail=row.position::text;end if;
   if exists(select 1 from jsonb_array_elements(v_lots) x left join erp_stock.lot t on t.id=(x->>'lot_id')::uuid where t.id is null or t.product_id<>row.product_id) then
    raise exception 'erp_stock_lot_not_found' using errcode='P0002',detail=row.position::text;end if;
   if exists(select 1 from jsonb_array_elements(v_lots) x join erp_stock.lot t on t.id=(x->>'lot_id')::uuid where not t.active) then
    raise exception 'erp_stock_lot_inactive' using errcode='22023',detail=row.position::text;end if;
   if(select sum((x->>'quantity')::numeric) from jsonb_array_elements(v_lots) x)>row.quantity then
    raise exception 'erp_document_stock_lots_exceed' using errcode='22023',detail=row.position::text;end if;
  end if;
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
    'source',jsonb_build_object('id',row.id,'position',row.position,'quantity',row.quantity::text))
    ||case when jsonb_array_length(v_lots)>0 then jsonb_build_object('lots',v_lots) else '{}'::jsonb end);
  end if;
 end loop;
 direction:=case when d.kind='purchase_orders' then 'receipt' else 'issue' end;
 with lines as(select(j->>'product_id')::uuid product_id,(j->>'quantity')::numeric qty,j->'source' source,j->'lots' item_lots from jsonb_array_elements(v_lines)j),
 groups as(select product_id,sum(qty) qty,jsonb_agg(source order by(source->>'position')::integer) sources from lines group by product_id),
 -- 296: the lots of a position (several items of the same product may inform the same lot).
 lot_lines as(select n.product_id,(x->>'lot_id')::uuid lot_id,sum((x->>'quantity')::numeric) qty,
   jsonb_agg(jsonb_build_object('id',n.source->>'id','position',(n.source->>'position')::integer,'quantity',((x->>'quantity')::numeric)::numeric(18,6)::text) order by(n.source->>'position')::integer) sources
  from lines n cross join jsonb_array_elements(n.item_lots) x where n.item_lots is not null group by n.product_id,(x->>'lot_id')::uuid),
 lot_positions as(select k.product_id,jsonb_agg(jsonb_build_object('lot_id',k.lot_id,'code',t.code,'expires_on',t.expires_on,
   'quantity',(case when direction='issue' then -k.qty else k.qty end)::numeric(18,6)::text,'balance_before',coalesce(lb.quantity,0)::numeric(18,6)::text,
   'balance_after',(coalesce(lb.quantity,0)+case when direction='issue' then -k.qty else k.qty end)::numeric(19,6)::text,'sources',k.sources) order by lower(t.code),k.lot_id) lots
  from lot_lines k join erp_stock.lot t on t.id=k.lot_id left join erp_stock.lot_balance lb on lb.lot_id=k.lot_id and lb.warehouse_id=w.id group by k.product_id)
 select coalesce(jsonb_agg(jsonb_build_object('product_id',g.product_id,'product_name',r.name,'catalog_version',r.version,
  'warehouse_id',w.id,'unit',p.unit,'quantity',(case when direction='issue' then -g.qty else g.qty end)::numeric(18,6)::text,
  'balance_before',coalesce(b.quantity,0)::numeric(18,6)::text,
  'balance_after',round(coalesce(b.quantity,0)+case when direction='issue' then -g.qty else g.qty end,6)::text,
  'expected_version',coalesce(b.version,0),'sources',g.sources)||case when lp.lots is not null then jsonb_build_object('lots',lp.lots) else '{}'::jsonb end order by g.product_id),'[]') into positions
 from groups g join erp_catalog.record r on r.id=g.product_id join erp_catalog.product p on p.record_id=g.product_id
 left join erp_stock.balance b on b.product_id=g.product_id and b.warehouse_id=w.id left join lot_positions lp on lp.product_id=g.product_id;
 if jsonb_array_length(positions) not between 1 and 100 then raise exception 'erp_document_stock_position_limit' using errcode='22023';end if;
 -- 182: a sales order needs both the company policy and "Permite venda de produtos com estoque negativo".
 if exists(select 1 from jsonb_array_elements(positions) j where ((j->>'quantity')::numeric<0 and (j->>'balance_after')::numeric<0
   and not(erp_stock.negative_allowed() and(d.kind<>'sales_orders' or erp_stock.sales_negative_allowed())))
  or (j->>'balance_after')::numeric>999999999999.999999 or (j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 -- 296: a lot never goes below zero, whatever the policy of negative stock (258).
 if exists(select 1 from jsonb_array_elements(positions) j cross join jsonb_array_elements(coalesce(j->'lots','[]'::jsonb)) x where(x->>'balance_after')::numeric<0) then
  raise exception 'erp_stock_lot_insufficient' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(positions) j cross join jsonb_array_elements(coalesce(j->'lots','[]'::jsonb)) x where(x->>'balance_after')::numeric>999999999999.999999) then
  raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 result:=jsonb_build_object('action','post','document',erp_stock.document_summary(d.id),'direction',direction,'occurred_on',p_day,'reason',p_reason,
  'warehouse',jsonb_build_object('id',w.id,'name',w.name,'version',w.version,'active',w.active),'positions',positions,'ignored',ignored);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

-- 3. The lots of a posted conferência go into the same movement: every writer of erp_stock.document_posting (018, 184, 239 and the
-- reserva consumida of 070) inserts the conferência as its snapshot right after erp_stock.post, in the same transaction.
create function erp_stock.post_document_lots()returns trigger language plpgsql set search_path=pg_catalog as $$
declare j jsonb;x jsonb;begin
 for j in select value from jsonb_array_elements(coalesce(new.snapshot->'positions','[]'::jsonb)) where value ? 'lots' order by value->>'product_id' loop
  for x in select value from jsonb_array_elements(j->'lots') order by value->>'lot_id' loop
   perform erp_stock.lot_apply(new.movement_id,(j->>'product_id')::uuid,(j->>'warehouse_id')::uuid,(x->>'lot_id')::uuid,(x->>'quantity')::numeric);
  end loop;
 end loop;
 return null;
end$$;
create trigger post_stock_document_lots after insert on erp_stock.document_posting for each row execute function erp_stock.post_document_lots();

-- 4. Conferência do estorno (224) with the lots that come back (the lot lines of the lançamento, 258/278). The rest of the body is the
-- published one; a lançamento without lots has exactly the published preview.
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
 -- 296: the lot balances that the reversal changes (258 gives every lot line of the lançamento back).
 perform 1 from erp_stock.lot_balance b join erp_stock.lot_entry x on x.lot_id=b.lot_id and x.warehouse_id=b.warehouse_id where x.movement_id=p.movement_id order by b.lot_id,b.warehouse_id for update of b;
 select jsonb_agg(jsonb_build_object('product_id',e.product_id,'product_name',r.name,'catalog_version',r.version,'warehouse_id',e.warehouse_id,
  'unit',e.unit,'quantity',(-e.quantity)::text,'balance_before',b.quantity::text,'balance_after',round(b.quantity-e.quantity,6)::text,
  'expected_version',b.version,'sources','[]'::jsonb)||case when erp_stock.balance_kept(p.movement_id,e.product_id,e.warehouse_id) then '{"balance_kept":true}'::jsonb else '{}'::jsonb end
  ||coalesce((select jsonb_build_object('lots',jsonb_agg(jsonb_build_object('lot_id',x.lot_id,'code',t.code,'expires_on',t.expires_on,'quantity',(-x.quantity)::numeric(18,6)::text,
     'balance_before',coalesce(lb.quantity,0)::numeric(18,6)::text,'balance_after',(coalesce(lb.quantity,0)-x.quantity)::numeric(19,6)::text) order by lower(t.code),x.lot_id))
    from erp_stock.lot_entry x join erp_stock.lot t on t.id=x.lot_id left join erp_stock.lot_balance lb on lb.lot_id=x.lot_id and lb.warehouse_id=x.warehouse_id
    where x.movement_id=p.movement_id and x.product_id=e.product_id and x.warehouse_id=e.warehouse_id having count(*)>0),'{}'::jsonb)
  order by e.product_id,e.warehouse_id) into positions
 from erp_stock.entry e join erp_stock.balance b on b.product_id=e.product_id and b.warehouse_id=e.warehouse_id join erp_catalog.record r on r.id=e.product_id where e.movement_id=p.movement_id;
 if positions is null or jsonb_array_length(positions) not between 1 and 100 or exists(select 1 from jsonb_array_elements(positions) j where((j->>'quantity')::numeric<0 and(j->>'balance_after')::numeric<0 and not erp_stock.negative_allowed() and not j?'balance_kept')
  or(j->>'balance_after')::numeric>999999999999.999999 or(j->>'balance_after')::numeric<-999999999999.999999 or(j->>'expected_version')::integer=2147483647) then raise exception 'erp_stock_insufficient_or_excess_quantity' using errcode='22023';end if;
 -- 296: the reversal of an entrada whose lot already left is refused here (the lot never goes below zero).
 if exists(select 1 from jsonb_array_elements(positions) j cross join jsonb_array_elements(coalesce(j->'lots','[]'::jsonb)) x where(x->>'balance_after')::numeric<0) then
  raise exception 'erp_stock_lot_insufficient' using errcode='22023';end if;
 result:=jsonb_build_object('action','reverse','document',erp_stock.document_summary(d.id),'posting',erp_stock.document_posting_summary(p.id),
  'direction','reversal','occurred_on',p_day,'reason',p_reason,'warehouse',p.snapshot->'warehouse','positions',positions,'ignored','[]'::jsonb);
 return result||jsonb_build_object('preview_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

revoke all on all functions in schema erp_stock from public,anon,authenticated,service_role;
commit;
