-- Native commercial extension. This migration does not import any source.
-- 055 will own the separately reviewed v2 mapper and immutable import evidence.
begin;
create function erp_documents.commercial_reference(v jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if v='null'::jsonb then return 'null'::jsonb;end if;
 if v is null or jsonb_typeof(v)<>'object' or not(v?&array['system','source_id','label'])
  or exists(select 1 from jsonb_object_keys(v) k where k not in('system','source_id','label'))
  or v->'system' is distinct from '"origin"'::jsonb or jsonb_typeof(v->'source_id') is distinct from 'string'
  or v->>'source_id'!~'^[1-9][0-9]{0,39}$' then
  raise exception 'erp_document_reference_invalid' using errcode='22023';end if;
 return jsonb_build_object('system','origin','source_id',v->'source_id','label',erp_documents.text_value(v->'label',200));
end $$;
create function erp_documents.commercial_data(v jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare t jsonb; transport jsonb:='null'; volume text; weight text;
begin
 if v='null'::jsonb then return 'null'::jsonb;end if;
 if v is null or jsonb_typeof(v)<>'object' or not(v?&array['introduction','attention_to','seller_reference','store_reference','business_unit_reference','transport'])
  or exists(select 1 from jsonb_object_keys(v) k where k not in('introduction','attention_to','seller_reference','store_reference','business_unit_reference','transport')) then
  raise exception 'erp_document_commercial_fields_invalid' using errcode='22023';end if;
 t:=v->'transport';
 if t<>'null'::jsonb then
  if jsonb_typeof(t)<>'object' or not(t?&array['freight_mode','volume_count','gross_weight','delivery_days','carrier_reference','service_reference','tracking_code'])
   or exists(select 1 from jsonb_object_keys(t) k where k not in('freight_mode','volume_count','gross_weight','delivery_days','carrier_reference','service_reference','tracking_code')) then
   raise exception 'erp_document_transport_fields_invalid' using errcode='22023';end if;
  if t->'freight_mode'<>'null'::jsonb and (jsonb_typeof(t->'freight_mode')<>'string' or t->>'freight_mode' not in('0','1','2','3','4','9')) then
   raise exception 'erp_document_freight_mode_invalid' using errcode='22023';end if;
  if t->'delivery_days'<>'null'::jsonb and (jsonb_typeof(t->'delivery_days')<>'string' or t->>'delivery_days'!~'^(0|[1-9][0-9]{0,5})$') then
   raise exception 'erp_document_delivery_days_invalid' using errcode='22023';end if;
  if t->'volume_count'<>'null'::jsonb then volume:=erp_documents.decimal_value(t->'volume_count',6,12)::numeric(18,6)::text;end if;
  if t->'gross_weight'<>'null'::jsonb then weight:=erp_documents.decimal_value(t->'gross_weight',6,12)::numeric(18,6)::text;end if;
  transport:=jsonb_build_object('freight_mode',t->'freight_mode','volume_count',volume,'gross_weight',weight,'delivery_days',t->'delivery_days',
   'carrier_reference',erp_documents.commercial_reference(t->'carrier_reference'),'service_reference',erp_documents.commercial_reference(t->'service_reference'),
   'tracking_code',erp_documents.text_value(t->'tracking_code',200));
 end if;
 return jsonb_build_object('introduction',erp_documents.text_value(v->'introduction',4000,false,true),'attention_to',erp_documents.text_value(v->'attention_to',200),
  'seller_reference',erp_documents.commercial_reference(v->'seller_reference'),'store_reference',erp_documents.commercial_reference(v->'store_reference'),
  'business_unit_reference',erp_documents.commercial_reference(v->'business_unit_reference'),'transport',transport);
end $$;
-- Presence is preserved in old outputs. No rewrite/backfill of old bodies, hashes or receipts.
create function erp_documents.has_commercial_data(v jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(v->'commercial'<>'null'::jsonb,false)
  or exists(select 1 from jsonb_array_elements(coalesce(v->'items','[]'::jsonb)) i where i->'detailed_description'<>'null'::jsonb)
  or exists(select 1 from jsonb_array_elements(coalesce(v->'installments','[]'::jsonb)) p where p->'note'<>'null'::jsonb or p->'payment_reference'<>'null'::jsonb)
$$;
-- An older full-replacement client must not silently erase fields it cannot display.
-- Explicit null/empty arrays remain deliberate edits, covered by the caller's CAS.
create function erp_documents.require_commercial_input(p_current jsonb,p_input jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if erp_documents.has_commercial_data(p_current) and (not(p_input?'commercial')
  or exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?'detailed_description'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['note','payment_reference']))) then
  raise exception 'erp_document_commercial_fields_required' using errcode='40001';end if;
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
  v_price:=erp_documents.decimal_value(v_item->'unit_price',4,10);
  v_percent:=erp_documents.decimal_value(coalesce(v_item->'discount_percent','"0"'::jsonb),4,3);
  if v_qty<=0 or v_percent>100 then raise exception 'erp_document_item_value_invalid' using errcode='22023'; end if;
  v_base:=round(v_qty*v_price,2); v_item_discount:=round(v_base*v_percent/100,2);
  v_gross:=v_gross+v_base; v_line_discount:=v_line_discount+v_item_discount; v_i:=v_i+1;
  if v_gross>999999999999.99 then raise exception 'erp_document_total_limit' using errcode='22023'; end if;
  v_row:=jsonb_build_object('gross',v_base::numeric(18,2)::text,'discount',v_item_discount::numeric(18,2)::text,'total',(v_base-v_item_discount)::numeric(18,2)::text);
  v_totals_items:=v_totals_items||jsonb_build_array(v_row);
  v_items:=v_items||jsonb_build_array(v_row||jsonb_build_object('id',v_id,'product_id',erp_documents.uuid_value(v_item->'product_id'),
   'description',erp_documents.text_value(v_item->'description',200,true),'code',erp_documents.text_value(v_item->'code',100),
   'unit',erp_documents.text_value(v_item->'unit',16,true),'quantity',v_qty::numeric(18,6)::text,'unit_price',v_price::numeric(18,4)::text,
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

create or replace function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_data jsonb; v_row erp_documents.document%rowtype; v_id uuid;
 v_contact uuid; v_warehouse uuid; v_snapshot jsonb; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_expected_version is null or (p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version<1) then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','save','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 v_data:=erp_documents.normalize(p_kind,p_body); v_contact:=(v_data->>'contact_id')::uuid; v_warehouse:=(v_data->>'warehouse_id')::uuid;
 if p_id is not null then
  select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  if not erp_documents.editable(v_row.status) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
  v_before:=erp_documents.dto(p_id);
  perform erp_documents.require_commercial_input(v_before,p_body);
 end if;
 if p_id is not null and v_row.contact_id=v_contact then v_snapshot:=v_row.contact_snapshot;
 else
  select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where r.id=v_contact and r.active;
  if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 end if;
 if v_warehouse is not null and (p_id is null or v_row.warehouse_id is distinct from v_warehouse)
  and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
  values(p_kind,erp_documents.next_number(p_kind),case when p_kind in('sales_proposals','sales_orders') then 'draft' else 'open' end,
   v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 else
  v_id:=p_id;
  update erp_documents.document set version=version+1,contact_id=v_contact,warehouse_id=v_warehouse,contact_snapshot=v_snapshot,
   body=v_data-'items',total=(v_data#>>'{totals,total}')::numeric,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
 end if;
 perform erp_documents.replace_items(v_id,v_data->'items');
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,case when p_id is null then 'create' else 'edit' end,v_before,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
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
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',i.unit_price::text,
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

create or replace function public.erp_document_copy(p_user_id uuid,p_kind text,p_source_id uuid,p_expected_source_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_hash text; v_replay jsonb; v_data jsonb; v_items jsonb;
 v_contact uuid; v_warehouse uuid; v_refs uuid[]; v_snapshot jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_source_id is null or p_expected_source_version is null or p_expected_source_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','copy_document','actor',p_user_id,'kind',p_kind,'source',p_source_id,
  'source_version',p_expected_source_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 -- No source write; SHARE preserves the reviewed source revision through commit.
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 perform erp_documents.require_commercial_input(erp_documents.dto(p_source_id),p_body);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 -- Every current catalog snapshot is taken under the same deterministic record lock order.
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 -- The submitted commercial values/dates are normalized, never reset after confirmation.
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),case when p_kind in('sales_proposals','sales_orders') then 'draft' else 'open' end,
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 -- Client line identities are local form keys, never reused across documents.
 select coalesce(jsonb_agg(value||'{"id":null}'::jsonb order by position),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_data->'items') with ordinality as lines(value,position);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id)
  values(v_id,p_source_id,p_kind,v_source.number,p_expected_source_version,p_user_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'copy_source',erp_documents.copy_source_dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,'create_from_copy',jsonb_build_object('copy_source',erp_documents.copy_source_dto(v_id)),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;
revoke all on function erp_documents.commercial_reference(jsonb),erp_documents.commercial_data(jsonb),
 erp_documents.has_commercial_data(jsonb),erp_documents.require_commercial_input(jsonb,jsonb)
 from public,anon,authenticated,service_role;
-- CREATE OR REPLACE preserves the existing ACLs and signatures of normalize/save/copy.
commit;
