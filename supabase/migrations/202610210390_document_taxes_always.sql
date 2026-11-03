-- Leva H, lane documentos (VND-123, VND-194, EST-041): IPI e ICMS ST devidos entram no total sempre, independentemente da
-- preferência de exibição.
-- * "Exibir IPI e ICMS ST" (propostas.exibir_ipi_st) passa a ser só de apresentação: check_tax_preference não recusa mais
--   valores de impostos quando ela está desligada (a 196 recusava com erp_document_tax_disabled).
-- * O pedido de compra aceita o Total ICMS ST (campo), além do IPI dos itens; o total, as parcelas e a impressão o incluem.
-- O rascunho fiscal de um pedido com IPI/ST já não responde 502 desde a 251 (o capture leva os totais de impostos).
-- As funções substituídas são conferidas pelo hash; outra versão interrompe a migração.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_documents.check_tax_preference(jsonb,jsonb)','58509e0350b5adaeb663958b48d7e39eeb3f7bd5d456f68af9661bb85a45df37'),
  ('erp_documents.normalize(text,jsonb)','0253874d18709601d8a4d143d55c8db4ce6fcaa803e222747a061500687fd9dd'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.hash then
   raise exception 'document_taxes_390_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- A preferência só decide se a tela mostra o bloco; os impostos devidos são gravados e somados sempre.
create or replace function erp_documents.check_tax_preference(p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 return;
end $$;

create or replace function erp_documents."normalize"(p_kind text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_core jsonb; v_result jsonb; v_items jsonb:='[]'; v_item jsonb; v_out jsonb; v_i integer:=0; v_installments jsonb:='[]';
 v_ipi numeric:=0; v_st numeric:=0; v_total numeric; v_sum numeric:=0; v_amount numeric; v_code text;
 v_item_ipi numeric:=0; v_rated boolean:=false; v_rate numeric; v_lots jsonb; v_lot jsonb; v_lot_sum numeric; v_seen uuid[]; v_lot_id uuid; v_qty numeric;
 v_fields jsonb; v_key text; v_value jsonb;
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 -- 268: equipment leaves the core (200 characters there) and is checked here with 4,000 and line breaks.
 -- 287: custom_fields (campos customizados of the OS) are checked here too.
 v_core:=p_body-erp_documents.extension_keys()-array['installments','tax_ipi','tax_icms_st','equipment','custom_fields'];
 if jsonb_typeof(p_body->'items')='array' then
  v_core:=jsonb_set(v_core,'{items}',(select coalesce(jsonb_agg(case when jsonb_typeof(i.value)='object' then i.value-array['list_price','supplier_code','group','quote','done','lots','warranty_days','ipi_rate'] else i.value end order by i.n),'[]'::jsonb)
   from jsonb_array_elements(p_body->'items') with ordinality i(value,n)));
 end if;
 v_result:=erp_documents.normalize_core(p_kind,v_core)||erp_documents.extension_data(p_body);
 if p_kind<>'service_orders' and erp_documents.text_value(p_body->'equipment',4000,false,true) is not null then
  raise exception 'erp_document_service_field_invalid' using errcode='22023'; end if;
 v_result:=v_result||jsonb_build_object('equipment',erp_documents.text_value(p_body->'equipment',4000,false,true));
 -- 270: Outros itens ou serviços and Condições comerciais belong to the proposta.
 if p_kind<>'sales_proposals' and (coalesce(v_result->'other_items','null'::jsonb)<>'null'::jsonb or coalesce(v_result->'commercial_conditions','null'::jsonb)<>'null'::jsonb) then
  raise exception 'erp_document_other_items_invalid' using errcode='22023'; end if;
 if p_kind='purchase_orders' and v_result->>'price_list_id' is not null then raise exception 'erp_document_price_list_invalid' using errcode='22023'; end if;
 if (p_kind='sales_proposals' and v_result->>'payment_account_id' is not null)
  or (p_kind<>'sales_orders' and (v_result->>'payment_means' is not null or v_result->>'payment_indicator' is not null)) then
  raise exception 'erp_document_payment_invalid' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_body->'items') loop
  v_out:=v_result->'items'->v_i; v_i:=v_i+1;
  if v_item?'list_price' then
   v_out:=v_out||jsonb_build_object('list_price',case when v_item->'list_price'='null'::jsonb then null
    else erp_catalog.unit_price_numeric(erp_catalog.unit_price(v_item->'list_price',10)::numeric,10) end);
  end if;
  if v_item?'supplier_code' then
   v_code:=erp_documents.text_value(v_item->'supplier_code',100);
   if v_code is not null and p_kind<>'purchase_orders' then raise exception 'erp_document_supplier_code_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('supplier_code',v_code);
  end if;
  -- 268: Peças / Serviços executados of the OS; Orçar and OK only of a serviço.
  if v_item?'group' or v_item?'quote' or v_item?'done' then
   if p_kind<>'service_orders' or (v_item?'group' and coalesce(v_item->>'group','') not in('part','service'))
    or (v_item?'quote' and jsonb_typeof(v_item->'quote')<>'boolean') or (v_item?'done' and jsonb_typeof(v_item->'done')<>'boolean')
    or ((v_item->'quote'='true'::jsonb or v_item->'done'='true'::jsonb) and v_item->>'group' is distinct from 'service') then
    raise exception 'erp_document_item_group_invalid' using errcode='22023'; end if;
   v_out:=v_out||case when v_item?'group' then jsonb_build_object('group',v_item->>'group') else '{}'::jsonb end
    ||case when v_item?'quote' then jsonb_build_object('quote',v_item->'quote') else '{}'::jsonb end
    ||case when v_item?'done' then jsonb_build_object('done',v_item->'done') else '{}'::jsonb end;
  end if;
  -- 287: Informar lotes (pedido de venda and peças of the OS): lots of the product adding up to the quantity; [] = Sem lote.
  if v_item?'lots' and v_item->'lots'<>'null'::jsonb then
   if p_kind not in('sales_orders','service_orders') or jsonb_typeof(v_item->'lots')<>'array' or jsonb_array_length(v_item->'lots')>50 then
    raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
   if jsonb_array_length(v_item->'lots')>0 then
    if v_out->>'product_id' is null or (p_kind='service_orders' and v_item->>'group' is not distinct from 'service') then
     raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
    v_lots:='[]'::jsonb; v_lot_sum:=0; v_seen:='{}';
    for v_lot in select value from jsonb_array_elements(v_item->'lots') loop
     if jsonb_typeof(v_lot)<>'object' or (select count(*) from jsonb_object_keys(v_lot))<>2 or not(v_lot?&array['lot_id','quantity']) then
      raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_lot_id:=erp_documents.uuid_value(v_lot->'lot_id',true);
     if v_lot_id=any(v_seen) then raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_seen:=v_seen||v_lot_id;
     v_qty:=erp_documents.decimal_value(v_lot->'quantity',6,9);
     if v_qty<=0 then raise exception 'erp_document_item_lots_invalid' using errcode='22023'; end if;
     v_lot_sum:=v_lot_sum+v_qty;
     v_lots:=v_lots||jsonb_build_array(jsonb_build_object('lot_id',v_lot_id,'quantity',v_qty::numeric(18,6)::text));
    end loop;
    if v_lot_sum<>(v_out->>'quantity')::numeric then raise exception 'erp_document_item_lots_quantity' using errcode='22023'; end if;
    v_out:=v_out||jsonb_build_object('lots',v_lots);
   end if;
  end if;
  -- 287: Garantia (dias) of the item of the OS.
  if v_item?'warranty_days' and v_item->'warranty_days'<>'null'::jsonb then
   if p_kind<>'service_orders' or jsonb_typeof(v_item->'warranty_days')<>'string' or v_item->>'warranty_days'!~'^(0|[1-9][0-9]{0,3})$' then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('warranty_days',v_item->>'warranty_days');
  end if;
  -- 287: IPI % of the item of the pedido de compra; its IPI is the total of the item × the rate, in cents.
  if v_item?'ipi_rate' and v_item->'ipi_rate'<>'null'::jsonb then
   if p_kind<>'purchase_orders' then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
   v_rate:=erp_documents.decimal_value(v_item->'ipi_rate',4,3);
   if v_rate>100 then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
   v_out:=v_out||jsonb_build_object('ipi_rate',v_rate::numeric(7,4)::text);
   v_item_ipi:=v_item_ipi+round((v_out->>'total')::numeric*v_rate/100,2); v_rated:=true;
  end if;
  v_items:=v_items||jsonb_build_array(v_out);
 end loop;
 v_result:=jsonb_set(v_result,'{items}',v_items);
 -- 287: Campos customizados of the OS: {id: value}, empty values dropped; the definitions are checked by check_links.
 if p_body?'custom_fields' and p_body->'custom_fields'<>'null'::jsonb then
  if p_kind<>'service_orders' or jsonb_typeof(p_body->'custom_fields')<>'object' or (select count(*) from jsonb_object_keys(p_body->'custom_fields'))>60 then
   raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
  v_fields:='{}'::jsonb;
  for v_key,v_value in select x.key,x.value from jsonb_each(p_body->'custom_fields') x loop
   if v_key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or (v_value<>'null'::jsonb and jsonb_typeof(v_value)<>'string')
    or length(v_value#>>'{}')>4000 or translate(coalesce(v_value#>>'{}',''),E'\n\r\t','')~'[[:cntrl:]]' then
    raise exception 'erp_document_custom_field_invalid' using errcode='22023'; end if;
   if coalesce(v_value#>>'{}','')<>'' then v_fields:=v_fields||jsonb_build_object(v_key,v_value#>>'{}'); end if;
  end loop;
  if v_fields<>'{}'::jsonb then v_result:=v_result||jsonb_build_object('custom_fields',v_fields); end if;
 end if;
 if p_body?'tax_ipi' then v_ipi:=erp_documents.decimal_value(p_body->'tax_ipi',2,12); end if;
 if p_body?'tax_icms_st' then v_st:=erp_documents.decimal_value(p_body->'tax_icms_st',2,12); end if;
 -- 287: the pedido de compra takes its IPI only from the IPI % of the items (a tax_ipi sent with them follows the items and is not
 -- kept).
 if v_rated then v_ipi:=v_item_ipi;
 elsif p_kind='purchase_orders' and v_ipi<>0 then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 -- Leva H (EST-041): o pedido de compra também tem o Total ICMS ST (campo), que soma no total como no Origin.
 -- 270: Total outros itens of the proposta adds to its total.
 v_total:=(v_result#>>'{totals,total}')::numeric+v_ipi+v_st+coalesce((v_result#>>'{other_items,total}')::numeric,0);
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'tax_ipi' or p_body?'tax_icms_st' or v_rated then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('ipi',v_ipi::numeric(18,2)::text,'icms_st',v_st::numeric(18,2)::text,'total',v_total::numeric(18,2)::text))
   ||case when p_body?'tax_ipi' and not v_rated then jsonb_build_object('tax_ipi',v_ipi::numeric(18,2)::text) else '{}'::jsonb end
   ||case when p_body?'tax_icms_st' then jsonb_build_object('tax_icms_st',v_st::numeric(18,2)::text) else '{}'::jsonb end;
 end if;
 if coalesce(v_result->'other_items','null'::jsonb)<>'null'::jsonb then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('other_items',v_result#>>'{other_items,total}','total',v_total::numeric(18,2)::text));
 end if;
 if p_body?'installments' and (jsonb_typeof(p_body->'installments')<>'array' or jsonb_array_length(p_body->'installments')>120) then
  raise exception 'erp_document_installments_invalid' using errcode='22023'; end if;
 v_i:=0;
 for v_item in select value from jsonb_array_elements(coalesce(p_body->'installments','[]'::jsonb)) loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('due_date','amount','method','note','payment_reference','payment_method_id','details')) then
   raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_amount:=erp_documents.decimal_value(v_item->'amount',2,12);
  if v_amount<=0 then raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_i:=v_i+1; v_sum:=v_sum+v_amount;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('position',v_i,'due_date',erp_documents.date_value(v_item->'due_date',true),
   'amount',v_amount::numeric(18,2)::text,'method',erp_documents.text_value(v_item->'method',100))
   ||case when v_item?'note' then jsonb_build_object('note',erp_documents.text_value(v_item->'note',2000,false,true)) else '{}'::jsonb end
   ||case when v_item?'payment_reference' then jsonb_build_object('payment_reference',erp_documents.commercial_reference(v_item->'payment_reference')) else '{}'::jsonb end
   ||case when v_item?'payment_method_id' then jsonb_build_object('payment_method_id',erp_documents.uuid_value(v_item->'payment_method_id')) else '{}'::jsonb end
   ||case when v_item?'details' then jsonb_build_object('details',erp_documents.installment_details(p_kind,v_item->'details',v_amount)) else '{}'::jsonb end);
 end loop;
 if v_i>0 and v_sum<>v_total then raise exception 'erp_document_installment_total_mismatch' using errcode='22023'; end if;
 -- 270: Condições comerciais Nenhum or Texto carry no parcelas.
 if v_i>0 and v_result#>>'{commercial_conditions,mode}' in('none','text') then raise exception 'erp_document_conditions_invalid' using errcode='22023'; end if;
 return jsonb_set(v_result,'{installments}',v_installments);
end $function$;

-- ---------------------------------------------------------------- Conferências da gravação
-- 168 plus: the lots of each item are lots of its product (Estoque › Lotes e validades), and the campos customizados of the OS.
create or replace function erp_documents.check_links(p_kind text,p_data jsonb,p_before jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_kind='sales_proposals' and p_data->>'category_id' is not null then raise exception 'erp_document_category_invalid' using errcode='22023'; end if;
 if p_data->>'category_id' is not null and (p_before is null or p_before->>'category_id' is distinct from p_data->>'category_id')
  and not erp_documents.category_usable(p_kind,p_data->>'category_id') then
  raise exception 'erp_document_category_unavailable' using errcode='22023'; end if;
 if p_data->>'carrier_id' is not null and (p_before is null or p_before->>'carrier_id' is distinct from p_data->>'carrier_id')
  and not erp_documents.carrier_usable(p_data->>'carrier_id') then
  raise exception 'erp_document_carrier_unavailable' using errcode='22023'; end if;
 -- 287: a lot of another product (or a lot that does not exist) is refused.
 if exists(select 1 from jsonb_array_elements(coalesce(p_data->'items','[]'::jsonb)) i cross join jsonb_array_elements(coalesce(i->'lots','[]'::jsonb)) l
  where not exists(select 1 from erp_stock.lot x where x.id=(l->>'lot_id')::uuid and x.product_id=(i->>'product_id')::uuid)) then
  raise exception 'erp_document_item_lot_unavailable' using errcode='22023'; end if;
 if p_kind='service_orders' then perform erp_documents.check_custom_fields(p_kind,p_data->'custom_fields',p_before); end if;
end $$;

revoke all on function erp_documents.check_tax_preference(jsonb,jsonb),erp_documents."normalize"(text,jsonb) from public,anon,authenticated,service_role;
commit;
