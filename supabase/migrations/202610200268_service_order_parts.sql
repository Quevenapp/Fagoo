-- 268: Documentos (onda F), parte 2: Peças e Serviços executados separados na ordem de serviço, como no Origin.
-- * Cada item da OS ganha o grupo ('part' Peças | 'service' Serviços executados) e, nos serviços, Orçar e OK (quote, done). O total
--   da OS continua a soma de todos os itens; Total peças e Total serviços são as somas de cada grupo. Itens gravados antes desta
--   migração não têm grupo e continuam lidos pelo tipo do produto (Serviço = S), como no Relatório de Ordem de Serviço.
-- * Uma OS cujos itens já têm o grupo só é regravada por um cliente que envia o grupo de todos os itens (o ERP anterior recebe 409,
--   "campos obrigatórios", em vez de juntar os serviços nas peças).
-- * Preferências › Cadastros › Produtos "Cadastrar automaticamente produtos/serviços a partir de ordens de serviço": o serviço livre
--   vira um cadastro do tipo Serviço (S) e a peça livre um Produto (P), pela função interna da frente de produtos (191).
-- * Equipamento da OS: texto de até 4.000 caracteres, com quebras de linha (Origin textarea); antes 200.
-- * Gerar ordem de serviço da proposta (pré-preenchida, 240): os serviços (S) da proposta vão para os Serviços executados.
-- * Ordens de serviço, filtros Peça e Serviço da listagem: p_product_id (Peça, já existente) e o novo p_service_id (Serviço). A
--   assinatura de erp_document_list ganha o parâmetro com valor padrão; a de 238 é removida.
-- Substitui funções das migrações 196, 238 e 240 (conferidas pelo hash; outra versão interrompe a migração). Nenhum efeito de estoque,
-- financeiro ou fiscal é criado; nada escreve no Origin.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_catalog.document_product(uuid,text,uuid,jsonb)') is null or to_regprocedure('erp_documents.normalize_core(text,jsonb)') is null then
  raise exception 'service_order_parts_268_requires_191_196' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_documents.normalize(text,jsonb)','c5314814ba4ffaf1bc702fd4a4cec1b5d20b58199d06828ffa95f685d43536b7'),
  ('erp_documents.require_commercial_input(jsonb,jsonb)','9a3094818f50ebcb0990d677c6af9226f2a836e42b86dc6ce943bac71bbd29d4'),
  ('erp_documents.auto_products(uuid,text,uuid,jsonb)','76e4e40752b79fa18e95d34278f255c668d4f127cafab3593cfcae96b91d2112'),
  ('public.erp_document_conversion_preview(uuid,text,uuid)','11c518316c28dfd7339eeabc56b3abaa5f185ebff141ab60d22838229a146613'),
  ('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid)','bfec00a7da02af99d82c88a8f60c23038491e100a2861eef3e85a7b2b4375cd5'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'service_order_parts_268_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- ---------------------------------------------------------------- Normalização
create or replace function erp_documents."normalize"(p_kind text, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
declare v_core jsonb; v_result jsonb; v_items jsonb:='[]'; v_item jsonb; v_out jsonb; v_i integer:=0; v_installments jsonb:='[]';
 v_ipi numeric:=0; v_st numeric:=0; v_total numeric; v_sum numeric:=0; v_amount numeric; v_code text;
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 -- 268: equipment leaves the core (200 characters there) and is checked here with 4,000 and line breaks.
 v_core:=p_body-erp_documents.extension_keys()-array['installments','tax_ipi','tax_icms_st','equipment'];
 if jsonb_typeof(p_body->'items')='array' then
  v_core:=jsonb_set(v_core,'{items}',(select coalesce(jsonb_agg(case when jsonb_typeof(i.value)='object' then i.value-array['list_price','supplier_code','group','quote','done'] else i.value end order by i.n),'[]'::jsonb)
   from jsonb_array_elements(p_body->'items') with ordinality i(value,n)));
 end if;
 v_result:=erp_documents.normalize_core(p_kind,v_core)||erp_documents.extension_data(p_body);
 if p_kind<>'service_orders' and erp_documents.text_value(p_body->'equipment',4000,false,true) is not null then
  raise exception 'erp_document_service_field_invalid' using errcode='22023'; end if;
 v_result:=v_result||jsonb_build_object('equipment',erp_documents.text_value(p_body->'equipment',4000,false,true));
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
  v_items:=v_items||jsonb_build_array(v_out);
 end loop;
 v_result:=jsonb_set(v_result,'{items}',v_items);
 if p_body?'tax_ipi' then v_ipi:=erp_documents.decimal_value(p_body->'tax_ipi',2,12); end if;
 if p_body?'tax_icms_st' then v_st:=erp_documents.decimal_value(p_body->'tax_icms_st',2,12); end if;
 if p_kind='purchase_orders' and (v_ipi<>0 or v_st<>0) then raise exception 'erp_document_tax_invalid' using errcode='22023'; end if;
 v_total:=(v_result#>>'{totals,total}')::numeric+v_ipi+v_st;
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'tax_ipi' or p_body?'tax_icms_st' then
  v_result:=jsonb_set(v_result,'{totals}',(v_result->'totals')||jsonb_build_object('ipi',v_ipi::numeric(18,2)::text,'icms_st',v_st::numeric(18,2)::text,'total',v_total::numeric(18,2)::text))
   ||case when p_body?'tax_ipi' then jsonb_build_object('tax_ipi',v_ipi::numeric(18,2)::text) else '{}'::jsonb end
   ||case when p_body?'tax_icms_st' then jsonb_build_object('tax_icms_st',v_st::numeric(18,2)::text) else '{}'::jsonb end;
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
 return jsonb_set(v_result,'{installments}',v_installments);
end $function$;

create or replace function erp_documents.require_commercial_input(p_current jsonb, p_input jsonb)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
begin
 if erp_documents.has_commercial_data(p_current) and (not(p_input?'commercial')
  or exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?'detailed_description'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['note','payment_reference']))) then
  raise exception 'erp_document_commercial_fields_required' using errcode='40001';end if;
 if exists(select 1 from unnest(erp_documents.extension_keys()) k where coalesce(p_current->k,'null'::jsonb)<>'null'::jsonb and not p_input?k) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
 if (exists(select 1 from jsonb_array_elements(coalesce(p_current->'items','[]'::jsonb)) i where coalesce(i->'list_price','null'::jsonb)<>'null'::jsonb or coalesce(i->'supplier_code','null'::jsonb)<>'null'::jsonb)
   and exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?&array['list_price','supplier_code'])))
  or (exists(select 1 from jsonb_array_elements(coalesce(p_current->'installments','[]'::jsonb)) p where coalesce(p->'payment_method_id','null'::jsonb)<>'null'::jsonb or coalesce(p->'details','null'::jsonb)<>'null'::jsonb)
   and exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['payment_method_id','details'])))
  or ((coalesce(p_current->>'tax_ipi','0')::numeric<>0 or coalesce(p_current->>'tax_icms_st','0')::numeric<>0) and not(p_input?&array['tax_ipi','tax_icms_st'])) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
 -- 268: an OS whose items carry the group is only saved by a client that sends the group, Orçar and OK of every item.
 if exists(select 1 from jsonb_array_elements(coalesce(p_current->'items','[]'::jsonb)) i where i?'group')
  and exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?&array['group','quote','done'])) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
end $function$;

-- ---------------------------------------------------------------- Produtos e serviços automáticos
create or replace function erp_documents.auto_products(p_user_id uuid, p_kind text, p_command uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare v_item jsonb; v_out jsonb:='[]'; v_id uuid;
begin
 if erp_documents.preference(erp_documents.auto_product_key(p_kind)) is distinct from 'true'::jsonb
  or not exists(select 1 from jsonb_array_elements(p_items) i where i->>'product_id' is null)
  -- The vendedor without "Permite incluir produtos não cadastrados" keeps the free item, which the save then refuses (164).
  or (p_kind='sales_orders' and exists(select 1 from erp_catalog.seller s where s.user_id=p_user_id and not s.allow_unregistered_products)) then
  return p_items; end if;
 for v_item in select value from jsonb_array_elements(p_items) loop
  if v_item->>'product_id' is null then
   -- 268: the free serviço of the OS becomes a Serviço (S) of the cadastro; the peça a Produto (P).
   v_id:=erp_catalog.document_product(p_user_id,p_kind,p_command,case when p_kind='service_orders' and v_item->>'group'='service' then v_item||jsonb_build_object('kind','S') else v_item end);
   if v_id is not null then v_item:=jsonb_set(v_item,'{product_id}',to_jsonb(v_id::text)); end if;
  end if;
  v_out:=v_out||jsonb_build_array(v_item);
 end loop;
 return v_out;
end $function$;

-- ---------------------------------------------------------------- Gerar ordem de serviço da proposta (pré-preenchida)
create or replace function public.erp_document_conversion_preview(p_user_id uuid, p_kind text, p_proposal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_source erp_documents.document%rowtype; v_body jsonb; v_items jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_proposal_id and kind='sales_proposals';
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if not erp_documents.contact_usable(p_user_id,v_source.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_proposal_id) then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status in('cancelled','completed') or coalesce((v_source.body->>'template')::boolean,false) then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_body:=case when p_kind='sales_orders' then erp_documents.sale_body_from_proposal(v_source.body) else v_source.body||'{"template":false}'::jsonb end;
 v_body:=v_body-array['totals','template_name','valid_until','next_contact','template'];
 v_body:=jsonb_set(v_body,'{installments}',(select coalesce(jsonb_agg(p.value-'position' order by p.n),'[]'::jsonb) from jsonb_array_elements(coalesce(v_body->'installments','[]'::jsonb)) with ordinality p(value,n)));
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  -- 240: Preferências › Propostas "Enviar informações da descrição detalhada dos produtos para a venda" (off: the pedido starts without it).
  'discount_percent',i.discount_percent::text,'detailed_description',case when p_kind='sales_orders' and erp_documents.preference('propostas.enviar_descricao_venda')='false'::jsonb
   then 'null'::jsonb else coalesce(i.data->'detailed_description','null'::jsonb) end)
  ||case when i.data?'list_price' then jsonb_build_object('list_price',i.data->'list_price') else '{}'::jsonb end
  -- 268: in the OS a product of type Serviço (S) goes to the Serviços executados, the other items to the Peças.
  ||case when p_kind='service_orders' then jsonb_build_object('group',case when i.product_snapshot->>'kind'='S' then 'service' else 'part' end,'quote',false,'done',false) else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_proposal_id;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind','sales_proposals','number',v_source.number::text,'version',v_source.version),
  'kind',p_kind,'data',v_body||jsonb_build_object('items',v_items),'contact',jsonb_build_object('id',v_source.contact_id,'name',left(v_source.contact_snapshot->>'name',200)),
  'price_list_name',(select left(l.name,120) from erp_pricing.price_list l where l.id::text=v_body->>'price_list_id'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $function$;

-- ---------------------------------------------------------------- Listagem: filtros Peça e Serviço
drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid);
create function public.erp_document_list(p_user_id uuid, p_kind text, p_limit integer DEFAULT 25, p_after uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_page integer DEFAULT NULL::integer, p_order text DEFAULT 'id'::text, p_statuses text[] DEFAULT NULL::text[], p_date_type text DEFAULT 'date'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_technician text DEFAULT NULL::text, p_equipment text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text, p_postal_code text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_tracking_code text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_carrier text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_template boolean DEFAULT NULL::boolean, p_situations text[] DEFAULT NULL::text[], p_seller_id uuid DEFAULT NULL::uuid, p_component_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
 v_warranty text:=coalesce(erp_documents.preference('os.garantia_base')#>>'{}','nao_utilizar');
 v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not (erp_documents.transitions()->p_kind)?s)
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
  or (p_situations is not null and (v_statuses is not null or not erp_documents.situation_adopted(p_kind) or coalesce(cardinality(p_situations),0) not between 1 and 50
   or array_position(p_situations,null) is not null or exists(select 1 from unnest(p_situations) s where not erp_documents.situation_key_valid(p_kind,s))
   or (select count(distinct s) from unnest(p_situations) s)<>cardinality(p_situations)))
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_page is not null and (p_page not between 1 and 100000 or p_after is not null))
  or p_order is null or p_order not in ('date_desc','date_asc','number_desc','number_asc','id')
  or p_date_type is null or p_date_type not in ('date','expected_date','next_contact','ship_date','finish_date','warranty_until')
  or (p_date_type='next_contact' and p_kind<>'sales_proposals')
  or (p_date_type='ship_date' and p_kind not in ('sales_orders','service_orders'))
  or (p_date_type in ('finish_date','warranty_until') and p_kind<>'service_orders')
  or ((p_city is not null or p_state is not null) and p_kind not in ('sales_orders','sales_proposals'))
  or ((p_technician is not null or p_equipment is not null or p_serial_number is not null) and p_kind<>'service_orders')
  or (p_internal_note is not null and p_kind<>'purchase_orders')
  or ((p_postal_code is not null or p_district is not null or p_tracking_code is not null or p_customer_po_number is not null or p_carrier is not null) and p_kind<>'sales_orders')
  or ((p_contact_email is not null or p_template is not null) and p_kind<>'sales_proposals')
  or (p_seller_id is not null and p_kind not in ('sales_orders','sales_proposals','service_orders'))
  or (p_component_id is not null and p_kind<>'sales_orders')
  -- 268: the filters Peça (p_product_id) and Serviço (p_service_id) of the ordens de serviço.
  or (p_service_id is not null and p_kind<>'service_orders')
  or length(p_city)>100 or length(p_technician)>200 or length(p_equipment)>200 or length(p_serial_number)>100 or length(p_internal_note)>200
  or length(p_district)>100 or length(p_tracking_code)>200 or length(p_customer_po_number)>60 or length(p_carrier)>200 or length(p_contact_email)>254
  or (p_postal_code is not null and p_postal_code!~'^[0-9]{1,8}$')
  or concat(p_city,p_technician,p_equipment,p_serial_number,p_internal_note,p_district,p_tracking_code,p_customer_po_number,p_carrier,p_contact_email) ~ '[[:cntrl:]]'
  or (p_state is not null and p_state !~ '^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_city:=lower(nullif(btrim(p_city),''));v_technician:=lower(nullif(btrim(p_technician),''));v_equipment:=lower(nullif(btrim(p_equipment),''));
 v_serial:=lower(nullif(btrim(p_serial_number),''));v_note:=lower(nullif(btrim(p_internal_note),''));
 v_postal:=p_postal_code;v_district:=lower(nullif(btrim(p_district),''));v_tracking:=lower(nullif(btrim(p_tracking_code),''));
 v_po:=lower(nullif(btrim(p_customer_po_number),''));v_carrier:=lower(nullif(btrim(p_carrier),''));v_email:=lower(nullif(btrim(p_contact_email),''));
 if (p_city is not null and v_city is null) or (p_technician is not null and v_technician is null) or (p_equipment is not null and v_equipment is null)
  or (p_serial_number is not null and v_serial is null) or (p_internal_note is not null and v_note is null)
  or (p_district is not null and v_district is null) or (p_tracking_code is not null and v_tracking is null) or (p_customer_po_number is not null and v_po is null)
  or (p_carrier is not null and v_carrier is null) or (p_contact_email is not null and v_email is null) then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 v_digits:=case when v_query ~ '^[0-9./ -]+$' then regexp_replace(v_query,'[^0-9]','','g') end;
 if length(v_digits)<5 then v_digits:=null; end if;
 if p_after is not null and p_order<>'id' then
  select * into v_cursor from erp_documents.document where id=p_after and kind=p_kind;
  if not found then raise exception 'erp_document_cursor_invalid' using errcode='22023'; end if;
  v_cursor_day:=v_cursor.body->>'date';
 end if;
 v_offset:=case when p_page is null then 0 else (p_page-1)::bigint*p_limit end;
 with filtered as materialized(
  select d.id,d.number,d.body->>'date' as day,d.total from erp_documents.document d
  left join erp_documents.document_situation ds on ds.document_id=d.id
  where d.kind=p_kind
   and (v_statuses is null or d.status=any(v_statuses))
   and (p_situations is null or coalesce(ds.situation_id::text,d.status)=any(p_situations))
   and (p_seller_id is null or d.body->>'seller_id'=p_seller_id::text)
   -- 238: Preferências › Contatos "Contato acessível somente ao vendedor vinculado": the documents of the contacts of the seller.
   and (v_scope is null or exists(select 1 from erp_catalog.contact_profile cp where cp.record_id=d.contact_id and cp.seller_id=v_scope))
   -- 238: Origin "Componente": pedidos with a product whose current structure (Estoque › composições) has the component.
   and (p_component_id is null or exists(select 1 from erp_documents.item i join erp_stock.composition_current c on c.product_id=i.product_id
    where i.document_id=d.id and c.component_id=p_component_id))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or erp_documents.warranty_until(d.body,v_warranty)>=v_from)
     and (v_to is null or erp_documents.warranty_until(d.body,v_warranty)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
   and (p_service_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_service_id))
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0)
   and (p_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=p_state)
   and (v_technician is null or strpos(lower(coalesce(d.body->>'technician','')),v_technician)>0)
   and (v_equipment is null or strpos(lower(coalesce(d.body->>'equipment','')),v_equipment)>0)
   and (v_serial is null or strpos(lower(coalesce(d.body->>'serial_number','')),v_serial)>0)
   and (v_note is null or strpos(lower(coalesce(d.body->>'internal_notes','')),v_note)>0)
   and (v_postal is null or strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_postal)=1
    or strpos(coalesce(d.body#>>'{delivery_address,postal_code}',''),v_postal)=1)
   and (v_district is null or strpos(lower(coalesce(d.contact_snapshot->>'district','')),v_district)>0
    or strpos(lower(coalesce(d.body#>>'{delivery_address,district}','')),v_district)>0)
   and (v_tracking is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,tracking_code}','')),v_tracking)>0)
   and (v_po is null or strpos(lower(coalesce(d.body->>'customer_po_number','')),v_po)>0)
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0
    or exists(select 1 from erp_catalog.record r where r.id::text=d.body->>'carrier_id' and strpos(lower(r.name),v_carrier)>0))
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
    or (p_kind='purchase_orders' and strpos(lower(coalesce(d.body->>'order_reference','')),v_query)>0)
    or (v_digits is not null and strpos(regexp_replace(coalesce(d.contact_snapshot->>'document',''),'[^0-9]','','g'),v_digits)>0)
    or (v_digits is not null and p_kind='service_orders' and strpos(regexp_replace(coalesce(d.contact_snapshot->>'postal_code',''),'[^0-9]','','g'),v_digits)>0))
 ), ordered as materialized(
  select f.id,row_number() over(order by
    case when p_order='id' then f.id end,
    case when p_order='date_desc' then f.day end desc,
    case when p_order='date_asc' then f.day end,
    case when p_order in ('date_desc','number_desc') then f.number end desc,
    case when p_order in ('date_asc','number_asc') then f.number end) as position
  from filtered f
  where p_after is null
   or (p_order='id' and f.id>p_after)
   or (p_order='date_desc' and (f.day,f.number)<(v_cursor_day,v_cursor.number))
   or (p_order='date_asc' and (f.day,f.number)>(v_cursor_day,v_cursor.number))
   or (p_order='number_desc' and f.number<v_cursor.number)
   or (p_order='number_asc' and f.number>v_cursor.number)
 ), page as materialized(
  select id,position from ordered where position>v_offset and position<=v_offset+p_limit+1
 )
 select coalesce((select jsonb_agg(erp_documents.list_row(id,v_fiscal,v_stock) order by position) from page where position<=v_offset+p_limit),'[]'::jsonb),
  (select count(*) from page)>p_limit,
  (select id from page where position<=v_offset+p_limit order by position desc limit 1),
  (select count(*) from filtered),(select coalesce(sum(total),0) from filtered)
 into v_items,v_more,v_last,v_count,v_amount;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'page',p_page,
  'order',p_order,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'total_count',v_count,'total_amount',case when erp_documents.list_totals_visible(p_user_id,p_kind) then v_amount::numeric(20,2)::text end,
  'data_mode','erp_native','operational_effects',false);
end $function$;

revoke all on function erp_documents."normalize"(text,jsonb),erp_documents.require_commercial_input(jsonb,jsonb),erp_documents.auto_products(uuid,text,uuid,jsonb)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid),public.erp_document_conversion_preview(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.erp_document_conversion_preview(uuid,text,uuid) to service_role;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid) to service_role;
commit;
