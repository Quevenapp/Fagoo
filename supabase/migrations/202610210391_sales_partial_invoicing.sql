-- Leva H, lane documentos (VND-047, VND-083, VND-085): várias notas fiscais por pedido de venda, com controle do saldo por item.
-- * "Gerar nota fiscal parcial" grava a nota (erp_fiscal_invoice_execute, a mesma da 215) e, na mesma transação, o vínculo de
--   cada item da nota com o item do pedido e a quantidade faturada (erp_fiscal_invoices.invoice_order_item, a tabela da 275).
-- * O saldo de um item é a quantidade do pedido menos o que as notas parciais não excluídas, não canceladas e não denegadas já
--   faturaram. Duas gravações do mesmo pedido esperam uma pela outra (a mesma trava da 215), então ninguém fatura o mesmo saldo duas
--   vezes. Cancelar ou excluir a nota devolve o saldo.
-- * A nota "cheia" (Gerar nota fiscal) continua sendo uma só por pedido: ela não pode ser gerada quando já há nota parcial, e
--   nenhuma nota parcial entra quando já há nota cheia.
-- * Cada vínculo precisa bater com o item da nota (mesmo produto e mesma quantidade); um gatilho confere no fim da transação, também
--   quando a nota é editada depois.
-- * As notas do pedido apontam para as contas do pedido pela política da 375 (invoice_order); nenhuma cobrança nova por nota.
-- * A emissão continua em homologação; nada é transmitido.
-- A função substituída é conferida pelo hash; outra versão interrompe a migração.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_fiscal_invoices.require_single_invoice(uuid,text,jsonb)'))
  is distinct from '8c5642fbca988da3209db4932337b885d51a5c68addb091b8576e65c7c995252' then
  raise exception 'sales_partial_invoicing_391_previous_definition_changed erp_fiscal_invoices.require_single_invoice(uuid,text,jsonb)' using errcode='55000'; end if;
 if to_regprocedure('public.erp_fiscal_invoice_partial_create(uuid,uuid,uuid,jsonb)') is not null then
  raise exception 'sales_partial_invoicing_391_already_applied' using errcode='55000'; end if;
end$$;

-- Notas de saída que valem para o saldo: não excluídas, nem canceladas (3) nem denegadas (10).
create function erp_fiscal_invoices.counts_for_balance(p_invoice uuid) returns boolean language sql stable set search_path=pg_catalog as $$
 select exists(select 1 from erp_fiscal_invoices.invoice n where n.id=p_invoice and n.deleted_at is null and n.direction='1' and n.status not in(3,10))
$$;
-- A nota cheia de um pedido: uma nota de saída não excluída ligada ao pedido sem vínculos por item.
create function erp_fiscal_invoices.sales_full_invoice(p_document uuid) returns uuid language sql stable set search_path=pg_catalog as $$
 select o.invoice_id from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
 where o.document_id=p_document and n.deleted_at is null and n.direction='1'
  and not exists(select 1 from erp_fiscal_invoices.invoice_order_item x where x.invoice_id=o.invoice_id and x.document_id=o.document_id)
 order by n.created_at limit 1
$$;
-- Faturado por item do pedido pelas notas parciais que valem.
create function erp_fiscal_invoices.sales_item_invoiced(p_document uuid) returns table(document_item_id uuid,quantity numeric)
language sql stable set search_path=pg_catalog as $$
 select x.document_item_id,sum(x.quantity) from erp_fiscal_invoices.invoice_order_item x
 where x.document_id=p_document and erp_fiscal_invoices.counts_for_balance(x.invoice_id)
 group by x.document_item_id
$$;

-- 215 com a exceção da nota parcial: a gravação de erp_fiscal_invoice_partial_create já conferiu o saldo sob a mesma trava e marca
-- o pedido na transação. A nota cheia continua única e não entra ao lado de notas parciais.
create or replace function erp_fiscal_invoices.require_single_invoice(p_id uuid,p_direction text,p_orders jsonb) returns void language plpgsql set search_path=pg_catalog as $$
declare o uuid;
begin
 if p_direction<>'1' then return; end if;
 for o in select distinct erp_fiscal_invoices.uuid_input(x) id from jsonb_array_elements(erp_fiscal_invoices.array_input(p_orders,20)) x order by 1 loop
  if p_id is not null and exists(select 1 from erp_fiscal_invoices.invoice_order where invoice_id=p_id and document_id=o) then continue; end if;
  if coalesce(current_setting('erp.partial_invoice_document',true),'')=o::text then continue; end if;
  perform pg_advisory_xact_lock(174852946,hashtext(o::text));
  if exists(select 1 from erp_documents.document d where d.id=o and d.kind in('sales_orders','service_orders'))
   and exists(select 1 from erp_fiscal_invoices.invoice_order x join erp_fiscal_invoices.invoice n on n.id=x.invoice_id
    where x.document_id=o and n.deleted_at is null and n.direction='1' and n.id is distinct from p_id) then
   raise exception 'erp_fiscal_invoice_order_has_invoice' using errcode='40001'; end if;
 end loop;
end $$;

-- Saldo de faturamento do pedido (Resumo de faturamento): quantidade pedida, faturada e a faturar por item, e as notas do pedido.
create function erp_fiscal_invoices.sales_balance(p_document uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 with full_note as(select erp_fiscal_invoices.sales_full_invoice(p_document) id),
 inv as(select * from erp_fiscal_invoices.sales_item_invoiced(p_document))
 select jsonb_build_object('document_id',p_document,'full_invoice_id',(select id from full_note),
  'items',coalesce((select jsonb_agg(jsonb_build_object('document_item_id',i.id,'position',i.position,'product_id',i.product_id,
     'description',coalesce(i.data->>'description',i.product_snapshot->>'name'),'unit',i.data->>'unit',
     'ordered',erp_fiscal_invoices.quantity_text(i.quantity),
     'invoiced',erp_fiscal_invoices.quantity_text(case when (select id from full_note) is not null then i.quantity else coalesce(v.quantity,0) end),
     'remaining',erp_fiscal_invoices.quantity_text(case when (select id from full_note) is not null then 0 else greatest(i.quantity-coalesce(v.quantity,0),0) end))
    order by i.position) from erp_documents.item i left join inv v on v.document_item_id=i.id where i.document_id=p_document),'[]'::jsonb),
  'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'number',n.number,'series',n.series,'model',n.model,'status',n.status,
     'partial',exists(select 1 from erp_fiscal_invoices.invoice_order_item x where x.invoice_id=n.id and x.document_id=p_document),
     'counts',erp_fiscal_invoices.counts_for_balance(n.id)) order by n.created_at)
    from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
    where o.document_id=p_document and n.deleted_at is null and n.direction='1'),'[]'::jsonb))
$$;

create function public.erp_document_invoice_balance(p_user_id uuid,p_document_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_document_id is null or not exists(select 1 from erp_documents.document where id=p_document_id and kind='sales_orders') then
  raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- Contato acessível somente ao vendedor vinculado: the same scope as the pedido itself.
 if not erp_documents.contact_usable(p_user_id,(select contact_id from erp_documents.document where id=p_document_id)) then
  raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('scope','document_invoice_balance','data_mode','erp_native')||erp_fiscal_invoices.sales_balance(p_document_id);
end $$;

-- Gerar nota fiscal parcial: a nota (como em Gerar nota fiscal) e o vínculo de cada item com a quantidade faturada.
-- p_data = {invoice, items:[{position, document_item_id, quantity}]}.
create function public.erp_fiscal_invoice_partial_create(p_user_id uuid,p_command_id uuid,p_document_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_doc erp_documents.document%rowtype; v_result jsonb; v_invoice uuid; e jsonb; v_item erp_documents.item%rowtype; v_qty numeric; v_pos integer;
 v_note erp_fiscal_invoices.invoice_item%rowtype; v_done numeric; v_seen_pos integer[]:='{}'; v_seen_item uuid[]:='{}';
begin
 perform erp_fiscal_invoices.require_write(p_user_id);
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_command_id is null or p_document_id is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('invoice','items')) or not p_data ?& array['invoice','items']
  or jsonb_typeof(p_data->'items')<>'array' or jsonb_array_length(p_data->'items') not between 1 and 990 then
  raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
 -- The same command, sent again, answers as the note did (the links were written with it).
 if exists(select 1 from erp_fiscal_invoices.invoice_order_item where command_id=p_command_id) then
  perform set_config('erp.partial_invoice_document',p_document_id::text,true);
  v_result:=public.erp_fiscal_invoice_execute(p_user_id,p_command_id,'create',jsonb_build_object('invoice',p_data->'invoice','orders',jsonb_build_array(p_document_id)));
  perform set_config('erp.partial_invoice_document','',true);
  return v_result||jsonb_build_object('balance',erp_fiscal_invoices.sales_balance(p_document_id));
 end if;
 perform pg_advisory_xact_lock(174852946,hashtext(p_document_id::text));
 select * into v_doc from erp_documents.document where id=p_document_id for update;
 if not found or v_doc.kind<>'sales_orders' then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if not erp_documents.contact_usable(p_user_id,v_doc.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_doc.status in('cancelled','draft') then raise exception 'erp_fiscal_invoice_partial_status' using errcode='40001'; end if;
 if erp_fiscal_invoices.sales_full_invoice(p_document_id) is not null then raise exception 'erp_fiscal_invoice_order_has_invoice' using errcode='40001'; end if;
 for e in select x from jsonb_array_elements(p_data->'items') x loop
  if jsonb_typeof(e)<>'object' or exists(select 1 from jsonb_object_keys(e) k where k not in('position','document_item_id','quantity'))
   or not e ?& array['position','document_item_id','quantity'] then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
  v_pos:=(e->>'position')::integer; v_qty:=(e->>'quantity')::numeric;
  if v_pos not between 1 and 990 or v_qty<=0 or v_qty<>trunc(v_qty,4) or v_pos=any(v_seen_pos) then raise exception 'erp_fiscal_command_invalid' using errcode='22023'; end if;
  select * into v_item from erp_documents.item where id=erp_fiscal_invoices.uuid_input(e->'document_item_id') and document_id=p_document_id;
  if not found or v_item.id=any(v_seen_item) then raise exception 'erp_fiscal_invoice_partial_item_invalid' using errcode='22023'; end if;
  select coalesce(sum(quantity),0) into v_done from erp_fiscal_invoices.sales_item_invoiced(p_document_id) where document_item_id=v_item.id;
  if v_qty>v_item.quantity-v_done then raise exception 'erp_fiscal_invoice_partial_exceeds' using errcode='40001'; end if;
  v_seen_pos:=v_seen_pos||v_pos; v_seen_item:=v_seen_item||v_item.id;
 end loop;
 perform set_config('erp.partial_invoice_document',p_document_id::text,true);
 v_result:=public.erp_fiscal_invoice_execute(p_user_id,p_command_id,'create',jsonb_build_object('invoice',p_data->'invoice','orders',jsonb_build_array(p_document_id)));
 perform set_config('erp.partial_invoice_document','',true);
 v_invoice:=(v_result#>>'{invoice,id}')::uuid;
 if v_invoice is null or (select direction from erp_fiscal_invoices.invoice where id=v_invoice)<>'1' then raise exception 'erp_fiscal_invoice_partial_item_invalid' using errcode='22023'; end if;
 for e in select x from jsonb_array_elements(p_data->'items') x loop
  select * into v_item from erp_documents.item where id=(e->>'document_item_id')::uuid;
  select * into v_note from erp_fiscal_invoices.invoice_item where invoice_id=v_invoice and position=(e->>'position')::integer;
  if not found or v_note.product_id is distinct from v_item.product_id or v_note.quantity<>(e->>'quantity')::numeric then
   raise exception 'erp_fiscal_invoice_partial_mismatch' using errcode='22023'; end if;
  insert into erp_fiscal_invoices.invoice_order_item(invoice_id,document_id,invoice_position,document_item_id,quantity,product_id,command_id,created_by)
   values(v_invoice,p_document_id,v_note.position,v_item.id,v_note.quantity,v_note.product_id,p_command_id,p_user_id);
 end loop;
 return v_result||jsonb_build_object('balance',erp_fiscal_invoices.sales_balance(p_document_id));
end $$;

-- Integridade: o vínculo de uma nota de saída com o item do pedido de venda acompanha o item da nota (produto e quantidade).
create function erp_fiscal_invoices.check_sales_item_links() returns trigger language plpgsql set search_path=pg_catalog as $$
declare v_invoice uuid:=coalesce(new.invoice_id,old.invoice_id);
begin
 if exists(select 1 from erp_fiscal_invoices.invoice_order_item x join erp_fiscal_invoices.invoice n on n.id=x.invoice_id and n.direction='1'
   left join erp_fiscal_invoices.invoice_item ni on ni.invoice_id=x.invoice_id and ni.position=x.invoice_position
   where x.invoice_id=v_invoice and n.deleted_at is null and (ni.invoice_id is null or ni.product_id is distinct from x.product_id or ni.quantity<>x.quantity)) then
  raise exception 'erp_fiscal_invoice_partial_locked' using errcode='40001'; end if;
 return null;
end $$;
create constraint trigger sales_item_links_item after insert or update or delete on erp_fiscal_invoices.invoice_item
 deferrable initially deferred for each row execute function erp_fiscal_invoices.check_sales_item_links();

revoke all on function erp_fiscal_invoices.counts_for_balance(uuid),erp_fiscal_invoices.sales_full_invoice(uuid),erp_fiscal_invoices.sales_item_invoiced(uuid),
 erp_fiscal_invoices.require_single_invoice(uuid,text,jsonb),erp_fiscal_invoices.sales_balance(uuid),erp_fiscal_invoices.check_sales_item_links()
 from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_document_invoice_balance(uuid,uuid)','erp_fiscal_invoice_partial_create(uuid,uuid,uuid,jsonb)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
