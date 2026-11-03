-- Exact unit-price scale expansion only. No source/document/history rewrite or automatic import.
-- Requires 023/044/054. 052/055 import plans keep their original four-place price policy.
begin;
-- Unconstrained numeric plus CHECK refuses excess precision instead of rounding before validation.
alter table erp_catalog.product alter column price type numeric;
alter table erp_catalog.product add constraint product_price_exact_10 check(
 price is null or (price>=0 and price<100000000000000 and price=trunc(price,10)));
alter table erp_documents.item alter column unit_price type numeric;
alter table erp_documents.item add constraint item_unit_price_exact_10 check(
 unit_price>=0 and unit_price<10000000000 and unit_price=trunc(unit_price,10));

create function erp_catalog.unit_price(p_value jsonb,p_integers integer) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text; whole text; fraction text;
begin
 if p_integers is null or p_integers not in(10,14) or jsonb_typeof(p_value) is distinct from 'string' then
  raise exception 'erp_unit_price_invalid' using errcode='22023';end if;
 v:=p_value#>>'{}';
 if octet_length(v)>80 or v!~('^(0|[1-9][0-9]{0,'||(p_integers-1)::text||'})(\.[0-9]+)?$') then
  raise exception 'erp_unit_price_invalid' using errcode='22023';end if;
 whole:=split_part(v,'.',1);fraction:=rtrim(split_part(v,'.',2),'0');
 if length(fraction)>10 then raise exception 'erp_unit_price_invalid' using errcode='22023';end if;
 return whole||'.'||rpad(fraction,case when length(fraction)<=4 then 4 else 10 end,'0');
end $$;
create function erp_catalog.unit_price_numeric(p_value numeric,p_integers integer) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_value is null then null else erp_catalog.unit_price(to_jsonb(trim_scale(p_value)::text),p_integers) end
$$;
create or replace function erp_catalog.data(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('name',r.name,'code',r.code)||case r.entity
  when 'contacts' then(select to_jsonb(c)-'record_id' from erp_catalog.contact c where record_id=r.id)
  when 'products' then(select(to_jsonb(p)-'record_id')||jsonb_build_object('price',erp_catalog.unit_price_numeric(p.price,14),
   'net_weight',p.net_weight::text,'gross_weight',p.gross_weight::text,'width',p.width::text,'height',p.height::text,'depth',p.depth::text,
   'volumes',p.volumes::text,'items_per_box',p.items_per_box::text,'stock_min',p.stock_min::text,'stock_max',p.stock_max::text)
   from erp_catalog.product p where record_id=r.id)
  when 'warehouses' then(select to_jsonb(w)-'record_id' from erp_catalog.warehouse w where record_id=r.id)end
 from erp_catalog.record r where r.id=p_id;
$$;

create or replace function erp_catalog.validate_data(p_entity text,p_data jsonb,p_full boolean)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_specs jsonb;v_pair record;v_result jsonb:='{}';v_text text;
begin
 if p_entity not in('contacts','products','warehouses') or p_entity is null or p_data is null
  or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then
  raise exception 'erp_catalog_invalid_data' using errcode='22023';end if;
 v_specs:='{"name":200,"code":100}'::jsonb||case p_entity
  when 'contacts' then '{"trade_name":200,"person_type":1,"document":30,"ie":30,"email":254,"phone":40,"mobile":40,"postal_code":20,"street":200,"number":30,"complement":200,"district":100,"city":100,"state":2,"roles":0}'::jsonb
  when 'products' then '{"unit":16,"price":0,"kind":1,"format":1,"description":4000,"ncm":8,"gtin":14,"brand":100,"condition":11,"production":11,"net_weight":0,"gross_weight":0,"width":0,"height":0,"depth":0,"dimension_unit":2,"volumes":0,"items_per_box":0,"gtin_tax":14,"stock_min":0,"stock_max":0,"location":100,"cest":7,"origin":1,"additional_info":2000}'::jsonb
  else '{"description":1000}'::jsonb end;
 for v_pair in select key,value from jsonb_each(p_data) loop
  if not v_specs?v_pair.key then raise exception 'erp_catalog_unknown_field' using errcode='22023';end if;
  if v_pair.key='roles' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>3
    or exists(select 1 from jsonb_array_elements(v_pair.value)a where jsonb_typeof(a)<>'string' or a#>>'{}' not in('customer','supplier','carrier')) then
    raise exception 'erp_catalog_invalid_roles' using errcode='22023';end if;
   v_result:=v_result||jsonb_build_object('roles',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb)from(select distinct value#>>'{}'s from jsonb_array_elements(v_pair.value))q));
  elsif v_pair.key='price' then
   v_result:=v_result||jsonb_build_object('price',case when v_pair.value='null'::jsonb then null else erp_catalog.unit_price(v_pair.value,14) end);
  elsif v_pair.key in('net_weight','gross_weight','width','height','depth','stock_min','stock_max')then
   if v_pair.value<>'null'::jsonb and(jsonb_typeof(v_pair.value)<>'string' or v_pair.value#>>'{}'!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$')then
    raise exception 'erp_catalog_invalid_measure' using errcode='22023';end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,case when v_pair.value='null'::jsonb then null else(v_pair.value#>>'{}')::numeric(18,6)::text end);
  elsif v_pair.key in('volumes','items_per_box')then
   if v_pair.value<>'null'::jsonb and(jsonb_typeof(v_pair.value)<>'string' or v_pair.value#>>'{}'!~'^(0|[1-9][0-9]{0,5})$')then
    raise exception 'erp_catalog_invalid_count' using errcode='22023';end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,case when v_pair.value='null'::jsonb then null else(v_pair.value#>>'{}')::integer::text end);
  else
   if v_pair.value<>'null'::jsonb and jsonb_typeof(v_pair.value)<>'string'then raise exception 'erp_catalog_text_required' using errcode='22023';end if;
   v_text:=nullif(btrim(v_pair.value#>>'{}'),'');
   if length(v_text)>(v_specs->>v_pair.key)::integer or(case when v_pair.key in('description','additional_info')then translate(v_text,E'\n\r\t','')else v_text end)~'[[:cntrl:]]'then
    raise exception 'erp_catalog_invalid_text' using errcode='22023';end if;
   if(v_pair.key='person_type'and v_text not in('J','F','E'))or(v_pair.key='kind'and v_text not in('P','S','N'))or(v_pair.key='format'and v_text not in('S','V','E'))
    or(v_pair.key='condition'and v_text not in('new','used','refurbished','unspecified'))or(v_pair.key='production'and v_text not in('own','third_party'))
    or(v_pair.key='dimension_unit'and v_text not in('m','cm','mm'))or(v_pair.key='origin'and v_text!~'^[0-8]$')then
    raise exception 'erp_catalog_invalid_enum' using errcode='22023';end if;
   if(v_pair.key='gtin_tax'and v_text<>'SEM GTIN'and v_text!~'^([0-9]{8}|[0-9]{12,14})$')or(v_pair.key='cest'and v_text!~'^[0-9]{7}$')then
    raise exception 'erp_catalog_invalid_identifier' using errcode='22023';end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  end if;
 end loop;
 if p_full and nullif(v_result->>'name','')is null then raise exception 'erp_catalog_name_required' using errcode='22023';end if;
 if p_full and p_entity='contacts'and not v_result?'roles'then v_result:=v_result||'{"roles":[]}'::jsonb;end if;
 if p_entity='products'and(v_result->>'stock_min')::numeric>(v_result->>'stock_max')::numeric then
  raise exception 'erp_catalog_stock_metadata_range' using errcode='22023';end if;
 return v_result;
end $$;

create or replace function erp_documents.normalize(p_kind text,p_body jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_item jsonb; v_row jsonb; v_items jsonb:='[]'; v_installments jsonb:='[]'; v_totals_items jsonb:='[]';
 v_seen uuid[]:=array[]::uuid[]; v_id uuid; v_i integer:=0; v_field record; v_result jsonb; v_mode text;
 v_qty numeric; v_price numeric; v_percent numeric; v_base numeric; v_item_discount numeric;
 v_gross numeric:=0; v_line_discount numeric:=0; v_subtotal numeric; v_discount numeric; v_value numeric;
 v_freight numeric; v_other numeric; v_total numeric; v_installment_total numeric:=0;
begin
 if p_kind is null or not erp_documents.transitions()?p_kind or p_body is null or jsonb_typeof(p_body)<>'object'
  or octet_length(p_body::text)>262144 or jsonb_typeof(p_body->'items') is distinct from 'array'
  or jsonb_array_length(p_body->'items')>250 or(jsonb_array_length(p_body->'items')=0 and p_kind<>'service_orders') then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 if exists(select 1 from jsonb_object_keys(p_body) k where k not in ('date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','items','discount_mode','discount_value','freight','other_expenses','installments','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial')) then
  raise exception 'erp_document_unknown_field' using errcode='22023'; end if;
 if (p_body?'template' and jsonb_typeof(p_body->'template')<>'boolean')
  or (p_body->'template'='true'::jsonb and p_kind<>'sales_proposals') then
  raise exception 'erp_document_template_invalid' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_body->'items') loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('id','product_id','description','code','unit','quantity','unit_price','discount_percent','detailed_description')) then
   raise exception 'erp_document_item_invalid' using errcode='22023'; end if;
  v_id:=erp_documents.uuid_value(v_item->'id');
  if v_id=any(v_seen) then raise exception 'erp_document_item_duplicate' using errcode='22023'; end if;
  if v_id is not null then v_seen:=array_append(v_seen,v_id); end if;
  v_qty:=erp_documents.decimal_value(v_item->'quantity',6,9);
  v_price:=erp_catalog.unit_price(v_item->'unit_price',10)::numeric;
  v_percent:=erp_documents.decimal_value(coalesce(v_item->'discount_percent','"0"'::jsonb),4,3);
  if v_qty<=0 or v_percent>100 then raise exception 'erp_document_item_value_invalid' using errcode='22023'; end if;
  v_base:=round(v_qty*v_price,2); v_item_discount:=round(v_base*v_percent/100,2);
  v_gross:=v_gross+v_base; v_line_discount:=v_line_discount+v_item_discount; v_i:=v_i+1;
  if v_gross>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
  v_row:=jsonb_build_object('gross',v_base::numeric(18,2)::text,'discount',v_item_discount::numeric(18,2)::text,'total',(v_base-v_item_discount)::numeric(18,2)::text);
  v_totals_items:=v_totals_items||jsonb_build_array(v_row);
  v_items:=v_items||jsonb_build_array(v_row||jsonb_build_object('id',v_id,'product_id',erp_documents.uuid_value(v_item->'product_id'),
   'description',erp_documents.text_value(v_item->'description',200,true),'code',erp_documents.text_value(v_item->'code',100),
   'unit',erp_documents.text_value(v_item->'unit',16,true),'quantity',v_qty::numeric(18,6)::text,'unit_price',erp_catalog.unit_price_numeric(v_price,10),
   'discount_percent',v_percent::numeric(7,4)::text,'position',v_i)
   ||case when v_item?'detailed_description' then jsonb_build_object('detailed_description',erp_documents.text_value(v_item->'detailed_description',4000,false,true)) else '{}'::jsonb end);
 end loop;
 v_subtotal:=v_gross-v_line_discount;
 v_mode:=coalesce(erp_documents.text_value(p_body->'discount_mode',10),'amount');
 if v_mode not in ('amount','percent') then raise exception 'erp_document_discount_mode_invalid' using errcode='22023'; end if;
 if v_mode='percent' then
  v_value:=erp_documents.decimal_value(coalesce(p_body->'discount_value','"0"'::jsonb),4,3);
  if v_value>100 then raise exception 'erp_document_percent_invalid' using errcode='22023'; end if;
  v_discount:=round(v_subtotal*v_value/100,2);
 else v_value:=erp_documents.decimal_value(coalesce(p_body->'discount_value','"0"'::jsonb),2,12); v_discount:=v_value; end if;
 if v_discount>v_subtotal then raise exception 'erp_document_discount_exceeds_subtotal' using errcode='22023'; end if;
 v_freight:=erp_documents.decimal_value(coalesce(p_body->'freight','"0"'::jsonb),2,12);
 v_other:=erp_documents.decimal_value(coalesce(p_body->'other_expenses','"0"'::jsonb),2,12);
 v_total:=v_subtotal-v_discount+v_freight+v_other;
 if v_total>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
 if p_body?'installments' and (jsonb_typeof(p_body->'installments')<>'array' or jsonb_array_length(p_body->'installments')>120) then
  raise exception 'erp_document_installments_invalid' using errcode='22023'; end if;
 v_i:=0;
 for v_item in select value from jsonb_array_elements(coalesce(p_body->'installments','[]'::jsonb)) loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('due_date','amount','method','note','payment_reference')) then
   raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_base:=erp_documents.decimal_value(v_item->'amount',2,12);
  if v_base<=0 then raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_i:=v_i+1; v_installment_total:=v_installment_total+v_base;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('position',v_i,'due_date',erp_documents.date_value(v_item->'due_date',true),
   'amount',v_base::numeric(18,2)::text,'method',erp_documents.text_value(v_item->'method',100))
   ||case when v_item?'note' then jsonb_build_object('note',erp_documents.text_value(v_item->'note',2000,false,true)) else '{}'::jsonb end
   ||case when v_item?'payment_reference' then jsonb_build_object('payment_reference',erp_documents.commercial_reference(v_item->'payment_reference')) else '{}'::jsonb end);
 end loop;
 if v_i>0 and v_installment_total<>v_total then raise exception 'erp_document_installment_total_mismatch' using errcode='22023'; end if;
 v_result:=jsonb_build_object('date',erp_documents.date_value(p_body->'date',true),'contact_id',erp_documents.uuid_value(p_body->'contact_id',true),
  'warehouse_id',erp_documents.uuid_value(p_body->'warehouse_id'),'expected_date',erp_documents.date_value(p_body->'expected_date'),
  'valid_until',erp_documents.date_value(p_body->'valid_until'),'next_contact',erp_documents.date_value(p_body->'next_contact'),
  'template',coalesce(p_body->'template','false'::jsonb),'items',v_items,'discount_mode',v_mode,
  'discount_value',case when v_mode='percent' then v_value::numeric(7,4)::text else v_value::numeric(18,2)::text end,
  'freight',v_freight::numeric(18,2)::text,'other_expenses',v_other::numeric(18,2)::text,'installments',v_installments,
  'totals',jsonb_build_object('items',v_totals_items,'gross',v_gross::numeric(18,2)::text,'line_discount',v_line_discount::numeric(18,2)::text,
    'subtotal',v_subtotal::numeric(18,2)::text,'discount',v_discount::numeric(18,2)::text,'freight',v_freight::numeric(18,2)::text,
    'other_expenses',v_other::numeric(18,2)::text,'total',v_total::numeric(18,2)::text));
 for v_field in select key,value from jsonb_each('{"notes":4000,"internal_notes":4000,"payment_terms":4000,"delivery_terms":2000,"equipment":200,"serial_number":100,"technician":200,"defect":4000,"solution":4000}'::jsonb) loop
  if p_kind<>'service_orders' and v_field.key in ('equipment','serial_number','technician','defect','solution')
   and erp_documents.text_value(p_body->v_field.key,4000) is not null then
   raise exception 'erp_document_service_field_invalid' using errcode='22023'; end if;
  v_result:=v_result||jsonb_build_object(v_field.key,erp_documents.text_value(p_body->v_field.key,(v_field.value#>>'{}')::integer,false,
   v_field.key in ('notes','internal_notes','payment_terms','delivery_terms','defect','solution')));
 end loop;
 if p_body?'commercial' then
  v_result:=v_result||jsonb_build_object('commercial',erp_documents.commercial_data(p_body->'commercial'));
  if v_result#>>'{commercial,transport,freight_mode}'='9' and v_freight<>0 then
   raise exception 'erp_document_transport_conflict' using errcode='22023';end if;
 end if;
 return v_result;
end $$;

create or replace function public.erp_document_copy_preview(p_user_id uuid,p_kind text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),
  'discount_percent',i.discount_percent::text)
  ||case when i.data?'detailed_description' then jsonb_build_object('detailed_description',i.data->'detailed_description') else '{}'::jsonb end order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',(clock_timestamp() at time zone 'America/Sao_Paulo')::date,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',null,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 if erp_documents.has_commercial_data(erp_documents.dto(p_source_id)) then
  select coalesce(jsonb_agg(value||jsonb_build_object('detailed_description',value->'detailed_description') order by ordinality),'[]'::jsonb) into v_items
   from jsonb_array_elements(v_items) with ordinality;
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial','items',v_items);
 elsif v_source.body?'commercial' then
  v_data:=v_data||jsonb_build_object('commercial',v_source.body->'commercial');
 end if;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;
revoke all on function erp_catalog.unit_price(jsonb,integer),erp_catalog.unit_price_numeric(numeric,integer)
 from public,anon,authenticated,service_role;
-- Replaced functions retain their previously restricted ACLs and signatures.
commit;
