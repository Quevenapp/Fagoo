-- 289: Documentos (onda G), parte 3: filtros "Lote" e "Busca customizada" (Adicionar filtros) das listagens.
-- * Lote (até 50 lotes separados por ;), pedidos de venda e ordens de serviço: os documentos com um item de um desses lotes, informado
--   no item (Informar lotes, 287) ou lançado pelo estoque do documento (Informar lotes da linha do lançamento, 278). Sem diferença de
--   maiúsculas.
-- * Busca customizada (Adicionar filtros): até 10 condições campo/operador/valor, todas juntas, sobre os campos da listagem (número,
--   datas, total, desconto, frete, dados do contato, observações e os campos de cada tipo) e, nas OS, os campos customizados (com o
--   tipo da definição). Operadores: contém, não contém, igual, diferente, começa com, maior, maior ou igual, menor, menor ou igual,
--   vazio e não vazio, conforme o tipo do campo. Valores exatos (texto; números e datas sem conversão de ponto flutuante).
-- Troca erp_document_list (assinatura nova com p_lots e p_custom, com valor padrão; a de 268 é removida, conferida pelo hash). Só
-- leitura: nenhum documento muda. Nada escreve no Origin.
begin;

do $$begin
 if to_regclass('erp_documents.custom_field') is null or to_regclass('erp_stock.lot_entry') is null then raise exception 'document_list_search_289_requires_278_287' using errcode='55000'; end if;
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid)'))
  is distinct from '9d0020145144a21db0a1cb3214e1e5bbe12a73efbf83d994838532ee83492b30' then
  raise exception 'document_list_search_289_previous_definition_changed' using errcode='55000',detail='public.erp_document_list';end if;
end$$;

-- ---------------------------------------------------------------- Busca customizada
-- The fields of each list and their type (text, number, date; the campos customizados of the OS by their definition).
create function erp_documents.list_conditions(p_kind text,p_custom jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog as $function$
declare c jsonb; v_out jsonb:='[]'::jsonb; v_field text; v_op text; v_value text; v_type text; v_money boolean:=false; f erp_documents.custom_field;
begin
 if p_custom is null then return null; end if;
 if jsonb_typeof(p_custom)<>'array' or jsonb_array_length(p_custom) not between 1 and 10 then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 for c in select value from jsonb_array_elements(p_custom) loop
  if jsonb_typeof(c)<>'object' or (select count(*) from jsonb_object_keys(c))<>3 or not(c?&array['field','op','value'])
   or jsonb_typeof(c->'field')<>'string' or jsonb_typeof(c->'op')<>'string' or (c->'value'<>'null'::jsonb and jsonb_typeof(c->'value')<>'string') then
   raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
  v_field:=c->>'field'; v_op:=c->>'op'; v_value:=c->>'value'; v_type:=null; v_money:=false;
  if v_field in('contact_name','contact_document','contact_email','contact_city','contact_state','notes','internal_notes') then v_type:='text';
  elsif v_field in('date','expected_date') then v_type:='date';
  elsif v_field='number' then v_type:='number';
  elsif v_field in('total','discount','freight') then v_type:='number'; v_money:=true;
  elsif v_field='ship_date' and p_kind in('sales_orders','service_orders') then v_type:='date';
  elsif v_field='customer_po_number' and p_kind='sales_orders' then v_type:='text';
  elsif v_field in('valid_until','next_contact') and p_kind='sales_proposals' then v_type:='date';
  elsif v_field='order_reference' and p_kind='purchase_orders' then v_type:='text';
  elsif v_field='finish_date' and p_kind='service_orders' then v_type:='date';
  elsif v_field in('equipment','serial_number','technician') and p_kind='service_orders' then v_type:='text';
  elsif p_kind='service_orders' and v_field~'^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   select * into f from erp_documents.custom_field x where x.id=substr(v_field,8)::uuid and x.kind=p_kind;
   if not found then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
   v_type:=case f.field_type when 'integer' then 'number' when 'decimal' then 'number' when 'date' then 'date' when 'boolean' then 'boolean' when 'list' then 'option' else 'text' end;
  end if;
  if v_type is null or v_op not in('contains','not_contains','eq','ne','starts_with','gt','ge','lt','le','empty','not_empty')
   or (v_type='text' and v_op in('gt','ge','lt','le')) or (v_type in('number','date') and v_op in('contains','not_contains','starts_with'))
   or (v_type in('boolean','option') and v_op not in('eq','ne','empty','not_empty')) or (v_field='number' and v_op in('empty','not_empty'))
   or ((v_op in('empty','not_empty'))<>(v_value is null)) then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
  if v_value is not null and not (case v_type
    when 'text' then char_length(btrim(v_value)) between 1 and 120 and v_value!~'[[:cntrl:]]'
    when 'number' then case when v_field='number' then v_value~'^[1-9][0-9]{0,9}$' when v_money then v_value~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$'
     else v_value~'^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' end
    when 'date' then v_value~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' and erp_documents.date_value(to_jsonb(v_value))::text=v_value
    when 'boolean' then v_value in('true','false')
    else exists(select 1 from jsonb_array_elements(f.options) o where o->>'id'=v_value) end) then
   raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
  v_out:=v_out||jsonb_build_array(jsonb_build_object('field',v_field,'type',v_type,'op',v_op,'value',case when v_type='text' then btrim(v_value) else v_value end));
 end loop;
 return v_out;
end $function$;
-- The text of a field of the document (null when it has none).
create function erp_documents.list_condition_value(d erp_documents.document,p_field text) returns text
language sql immutable set search_path=pg_catalog as $function$
 select case
  when p_field='number' then d.number::text
  when p_field='total' then d.total::text
  when p_field='discount' then d.body#>>'{totals,discount}'
  when p_field='freight' then d.body#>>'{totals,freight}'
  when p_field='contact_name' then d.contact_snapshot->>'name'
  when p_field='contact_document' then d.contact_snapshot->>'document'
  when p_field='contact_email' then d.contact_snapshot->>'email'
  when p_field='contact_city' then d.contact_snapshot->>'city'
  when p_field='contact_state' then d.contact_snapshot->>'state'
  when p_field like 'custom:%' then d.body#>>array['custom_fields',substr(p_field,8)]
  else d.body->>p_field end
$function$;
-- One condition: empty / not empty; a document without the field only matches "diferente" and "não contém".
create function erp_documents.list_condition(p_type text,p_op text,p_actual text,p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $function$
declare a text:=nullif(btrim(coalesce(p_actual,'')),'');
begin
 if p_op='empty' then return a is null; end if;
 if p_op='not_empty' then return a is not null; end if;
 if a is null then return p_op in('ne','not_contains'); end if;
 if p_type='text' then
  return case p_op when 'contains' then strpos(lower(a),lower(p_value))>0 when 'not_contains' then strpos(lower(a),lower(p_value))=0
   when 'eq' then lower(a)=lower(p_value) when 'ne' then lower(a)<>lower(p_value) when 'starts_with' then left(lower(a),char_length(p_value))=lower(p_value) end;
 elsif p_type='number' then
  if a!~'^-?[0-9]+(\.[0-9]+)?$' then return p_op='ne'; end if;
  return case p_op when 'eq' then a::numeric=p_value::numeric when 'ne' then a::numeric<>p_value::numeric when 'gt' then a::numeric>p_value::numeric
   when 'ge' then a::numeric>=p_value::numeric when 'lt' then a::numeric<p_value::numeric when 'le' then a::numeric<=p_value::numeric end;
 elsif p_type='date' then
  if a!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return p_op='ne'; end if;
  return case p_op when 'eq' then a=p_value when 'ne' then a<>p_value when 'gt' then a>p_value when 'ge' then a>=p_value when 'lt' then a<p_value when 'le' then a<=p_value end;
 end if;
 return case p_op when 'eq' then a=p_value when 'ne' then a<>p_value end;
end $function$;
create function erp_documents.list_conditions_match(d erp_documents.document,p_conditions jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $function$
declare c jsonb;
begin
 for c in select value from jsonb_array_elements(p_conditions) loop
  if not coalesce(erp_documents.list_condition(c->>'type',c->>'op',erp_documents.list_condition_value(d,c->>'field'),c->>'value'),false) then return false; end if;
 end loop;
 return true;
end $function$;

-- ---------------------------------------------------------------- Listagem
-- 268 plus p_lots (Lote) and p_custom (Busca customizada).

drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid);
create function public.erp_document_list(p_user_id uuid, p_kind text, p_limit integer DEFAULT 25, p_after uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_query text DEFAULT NULL::text, p_date_from text DEFAULT NULL::text, p_date_to text DEFAULT NULL::text, p_page integer DEFAULT NULL::integer, p_order text DEFAULT 'id'::text, p_statuses text[] DEFAULT NULL::text[], p_date_type text DEFAULT 'date'::text, p_warehouse_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_technician text DEFAULT NULL::text, p_equipment text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text, p_postal_code text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_tracking_code text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text, p_carrier text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_template boolean DEFAULT NULL::boolean, p_situations text[] DEFAULT NULL::text[], p_seller_id uuid DEFAULT NULL::uuid, p_component_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid, p_lots text[] DEFAULT NULL::text[], p_custom jsonb DEFAULT NULL::jsonb)
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
 -- 289: Lote (até 50 lotes separados por ;) and Busca customizada (Adicionar filtros).
 v_lots text[]; v_conditions jsonb;
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
  -- 289: Lote of the pedidos de venda and of the OS: 1 to 50 codes.
  or (p_lots is not null and (p_kind not in('sales_orders','service_orders') or coalesce(cardinality(p_lots),0) not between 1 and 50 or array_position(p_lots,null) is not null
   or exists(select 1 from unnest(p_lots) x where char_length(btrim(x)) not between 1 and 60 or x~'[[:cntrl:]]')))
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
 v_lots:=case when p_lots is not null then array(select distinct lower(btrim(x)) from unnest(p_lots) x) end;
 v_conditions:=erp_documents.list_conditions(p_kind,p_custom);
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
   -- 289: Lote: a lot informed in an item (Informar lotes) or posted by the stock of the document (Informar lotes of the line, 278).
   and (v_lots is null or exists(select 1 from erp_documents.item i cross join jsonb_array_elements(case when jsonb_typeof(i.data->'lots')='array' then i.data->'lots' else '[]'::jsonb end) l
     join erp_stock.lot x on x.id::text=l->>'lot_id' where i.document_id=d.id and lower(x.code)=any(v_lots))
    or exists(select 1 from erp_stock.document_posting sp join erp_stock.lot_entry e on e.movement_id=sp.movement_id join erp_stock.lot x on x.id=e.lot_id
     where sp.document_id=d.id and sp.state='active' and lower(x.code)=any(v_lots)))
   -- 289: Busca customizada: every condition of Adicionar filtros.
   and (v_conditions is null or erp_documents.list_conditions_match(d,v_conditions))
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


revoke all on function erp_documents.list_conditions(text,jsonb),erp_documents.list_condition_value(erp_documents.document,text),
 erp_documents.list_condition(text,text,text,text),erp_documents.list_conditions_match(erp_documents.document,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb) from public,anon,authenticated;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean,text[],uuid,uuid,uuid,text[],jsonb) to service_role;
commit;
