-- Documentos próprios: cálculos exatos, sem emissão, estoque ou financeiro.
begin;
create schema erp_documents;
revoke all on schema erp_documents from public,anon,authenticated,service_role;
create table erp_documents.numbering (
  kind text primary key check(kind in ('sales_proposals','sales_orders','purchase_orders','service_orders')),
  last_number bigint not null default 0 check(last_number between 0 and 9999999999)
);
insert into erp_documents.numbering(kind) values('sales_proposals'),('sales_orders'),('purchase_orders'),('service_orders');
create table erp_documents.document (
  id uuid primary key default gen_random_uuid(),kind text not null references erp_documents.numbering(kind),
  number bigint not null check(number between 1 and 9999999999),version integer not null default 1 check(version>0),
  status text not null,contact_id uuid not null references erp_catalog.contact(record_id),
  warehouse_id uuid references erp_catalog.warehouse(record_id),contact_snapshot jsonb not null,
  body jsonb not null check(jsonb_typeof(body)='object'),total numeric(18,2) not null check(total between 0 and 999999999999.99),
  source_proposal_id uuid unique references erp_documents.document(id),
  created_by uuid not null references auth.users(id),updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
  unique(kind,number)
);
create index erp_documents_kind_id on erp_documents.document(kind,id);
create table erp_documents.item (
  id uuid primary key,document_id uuid not null references erp_documents.document(id),position integer not null check(position between 1 and 250),
  product_id uuid references erp_catalog.product(record_id),product_snapshot jsonb,
  quantity numeric(18,6) not null check(quantity>0),unit_price numeric(18,4) not null check(unit_price>=0),
  discount_percent numeric(7,4) not null check(discount_percent between 0 and 100),total numeric(18,2) not null check(total>=0),
  data jsonb not null check(jsonb_typeof(data)='object'),unique(document_id,position) deferrable initially deferred
);
create table erp_documents.command (
  command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null,
  result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_documents.audit (
  id bigint generated always as identity primary key,actor uuid not null references auth.users(id),
  command_id uuid not null,document_id uuid not null references erp_documents.document(id),action text not null,
  reason text,before_data jsonb,after_data jsonb,created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin foreach t in array array['numbering','document','item','command','audit'] loop
  execute format('alter table erp_documents.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema erp_documents from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_documents from public,anon,authenticated,service_role;
alter default privileges in schema erp_documents revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_documents revoke all on functions from public,anon,authenticated,service_role;

create function erp_documents.allowed(p_role text,p_kind text,p_write boolean)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(case when p_kind not in ('sales_proposals','sales_orders','purchase_orders','service_orders') then false
  when p_write then case when p_kind='purchase_orders' then p_role in ('admin','estoque') else p_role in ('admin','vendas') end
  when p_role in ('admin','consulta','financeiro') then true
  when p_role='vendas' then p_kind in ('sales_proposals','sales_orders','service_orders')
  when p_role in ('estoque','fiscal') then p_kind in ('sales_orders','purchase_orders') else false end,false);
$$;
create function erp_documents.require_access(p_user_id uuid,p_kind text,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found or not erp_documents.allowed(v_role,p_kind,p_write) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
end $$;
create function erp_documents.transitions()
returns jsonb language sql immutable set search_path=pg_catalog as $$ select '{
 "sales_proposals":{"draft":["open","cancelled"],"open":["pending","waiting","approved","rejected","cancelled"],"pending":["open","waiting","approved","rejected","cancelled"],"waiting":["open","pending","approved","rejected","cancelled"],"approved":["open","cancelled"],"rejected":["open"],"cancelled":["open"],"completed":[]},
 "sales_orders":{"draft":["open","cancelled"],"open":["verified","in_progress","cancelled"],"verified":["open","in_progress","cancelled"],"in_progress":["partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open"],"cancelled":["open"]},
 "purchase_orders":{"open":["in_progress","cancelled"],"in_progress":["partially_fulfilled","fulfilled","cancelled"],"partially_fulfilled":["in_progress","fulfilled","cancelled"],"fulfilled":["open"],"cancelled":["open"]},
 "service_orders":{"open":["quoted","no_repair","cancelled"],"quoted":["approved","rejected","cancelled"],"approved":["in_progress","cancelled"],"rejected":["quoted","no_repair"],"in_progress":["waiting_parts","service_done","no_repair","cancelled"],"waiting_parts":["in_progress","no_repair","cancelled"],"service_done":["in_progress","finalized"],"finalized":["open"],"no_repair":["open"],"cancelled":["open"]}
 }'::jsonb $$;
create function erp_documents.editable(p_status text)
returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(p_status not in ('approved','completed','fulfilled','finalized','no_repair','cancelled','rejected','service_done'),false);
$$;
alter table erp_documents.document add constraint erp_document_state_valid
 check ((erp_documents.transitions()->kind)?status);
create function erp_documents.text_value(p_value jsonb,p_max integer,p_required boolean default false,p_multiline boolean default false)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare v text; begin
 if p_value is null or p_value='null'::jsonb then v:=null;
 elsif jsonb_typeof(p_value)<>'string' then raise exception 'erp_document_text_invalid' using errcode='22023';
 else v:=nullif(btrim(p_value#>>'{}'),''); end if;
 if (p_required and v is null) or length(v)>p_max
   or (case when p_multiline then translate(v,E'\n\r\t','') else v end) ~ '[[:cntrl:]]' then
  raise exception 'erp_document_text_invalid' using errcode='22023'; end if;
 return v;
end $$;
create function erp_documents.decimal_value(p_value jsonb,p_precision integer,p_digits integer)
returns numeric language plpgsql immutable set search_path=pg_catalog as $$
declare v text; begin
 if p_value is null or jsonb_typeof(p_value)<>'string' then raise exception 'erp_document_decimal_invalid' using errcode='22023'; end if;
 v:=p_value#>>'{}';
 if v !~ ('^(0|[1-9][0-9]{0,'||(p_digits-1)||'})(\.[0-9]{1,'||p_precision||'})?$') then
  raise exception 'erp_document_decimal_invalid' using errcode='22023'; end if;
 return v::numeric;
end $$;
create function erp_documents.uuid_value(p_value jsonb,p_required boolean default false)
returns uuid language plpgsql immutable set search_path=pg_catalog as $$
declare v text; begin
 v:=erp_documents.text_value(p_value,36,p_required);
 if v is not null and v !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
  raise exception 'erp_document_id_invalid' using errcode='22023'; end if;
 return v::uuid;
end $$;
create function erp_documents.date_value(p_value jsonb,p_required boolean default false)
returns date language plpgsql immutable set search_path=pg_catalog as $$
declare v text; d date; begin
 v:=erp_documents.text_value(p_value,10,p_required);
 if v is not null then
  if v !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_document_date_invalid' using errcode='22023'; end if;
  begin d:=v::date; exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'erp_document_date_invalid' using errcode='22023'; end;
 end if;
 return d;
end $$;

create function erp_documents.normalize(p_kind text,p_body jsonb)
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
 if exists(select 1 from jsonb_object_keys(p_body) k where k not in ('date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','items','discount_mode','discount_value','freight','other_expenses','installments','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution')) then
  raise exception 'erp_document_unknown_field' using errcode='22023'; end if;
 if (p_body?'template' and jsonb_typeof(p_body->'template')<>'boolean')
  or (p_body->'template'='true'::jsonb and p_kind<>'sales_proposals') then
  raise exception 'erp_document_template_invalid' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_body->'items') loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('id','product_id','description','code','unit','quantity','unit_price','discount_percent')) then
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
   'discount_percent',v_percent::numeric(7,4)::text,'position',v_i));
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
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('due_date','amount','method')) then
   raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_base:=erp_documents.decimal_value(v_item->'amount',2,12);
  if v_base<=0 then raise exception 'erp_document_installment_invalid' using errcode='22023'; end if;
  v_i:=v_i+1; v_installment_total:=v_installment_total+v_base;
  v_installments:=v_installments||jsonb_build_array(jsonb_build_object('position',v_i,'due_date',erp_documents.date_value(v_item->'due_date',true),
   'amount',v_base::numeric(18,2)::text,'method',erp_documents.text_value(v_item->'method',100)));
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
 return v_result;
end $$;

create function erp_documents.dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select d.body||jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'contact_snapshot',d.contact_snapshot,'source_proposal_id',d.source_proposal_id,'created_at',d.created_at,'updated_at',d.updated_at,
  'items',(select coalesce(jsonb_agg(i.data||jsonb_build_object('product_snapshot',i.product_snapshot) order by position),'[]'::jsonb)
    from erp_documents.item i where document_id=d.id)) from erp_documents.document d where id=p_id;
$$;
create function erp_documents.summary(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'kind',kind,'number',number::text,'status',status,'version',version,
  'date',body->>'date','total',total::text,'contact_id',contact_id,'contact_name',contact_snapshot->>'name',
  'created_at',created_at,'updated_at',updated_at) from erp_documents.document where id=p_id;
$$;
create function erp_documents.next_number(p_kind text)
returns bigint language plpgsql set search_path=pg_catalog as $$
declare v bigint; begin
 update erp_documents.numbering set last_number=last_number+1 where kind=p_kind and last_number<9999999999 returning last_number into v;
 if not found then raise exception 'erp_document_number_exhausted' using errcode='40001'; end if; return v;
end $$;
create function erp_documents.command_replay(p_actor uuid,p_command uuid,p_hash text)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v erp_documents.command%rowtype; begin
 if p_command is null then raise exception 'erp_document_command_required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852908,hashtext(p_command::text));
 select * into v from erp_documents.command where command_id=p_command;
 if found then
  if v.actor<>p_actor or v.request_hash<>p_hash then raise exception 'erp_document_command_conflict' using errcode='40001'; end if;
  return v.result||'{"replayed":true}'::jsonb; end if;
 return null;
end $$;
create function erp_documents.replace_items(p_document uuid,p_items jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
declare v jsonb; v_id uuid; v_product uuid; v_old erp_documents.item%rowtype; v_snapshot jsonb; v_new jsonb:='[]';
begin
 for v in select value from jsonb_array_elements(p_items) loop
  v_id:=coalesce((v->>'id')::uuid,gen_random_uuid()); v_product:=(v->>'product_id')::uuid; v_snapshot:=null;
  select * into v_old from erp_documents.item where id=v_id;
  if found and v_old.document_id<>p_document then raise exception 'erp_document_foreign_item' using errcode='22023'; end if;
  if v_product is not null then
   if found and v_old.product_id=v_product then v_snapshot:=v_old.product_snapshot;
   else
    select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=v_product and r.active;
    if not found then raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
   end if;
  end if;
  v_new:=v_new||jsonb_build_array(v||jsonb_build_object('id',v_id,'product_snapshot',v_snapshot));
 end loop;
 delete from erp_documents.item where document_id=p_document
  and id not in(select (value->>'id')::uuid from jsonb_array_elements(v_new));
 for v in select value from jsonb_array_elements(v_new) loop
  insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
   values((v->>'id')::uuid,p_document,(v->>'position')::integer,(v->>'product_id')::uuid,v->'product_snapshot',
    (v->>'quantity')::numeric,(v->>'unit_price')::numeric,(v->>'discount_percent')::numeric,(v->>'total')::numeric,v-'product_snapshot')
   on conflict(id) do update set position=excluded.position,product_id=excluded.product_id,product_snapshot=excluded.product_snapshot,
    quantity=excluded.quantity,unit_price=excluded.unit_price,discount_percent=excluded.discount_percent,total=excluded.total,data=excluded.data
    where erp_documents.item.document_id=excluded.document_id;
  if not found then raise exception 'erp_document_foreign_item' using errcode='22023'; end if;
 end loop;
end $$;

create function public.erp_document_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('read',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,false)),
  'write',(select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from jsonb_object_keys(erp_documents.transitions()) k where erp_documents.allowed(v_role,k,true)),
  'data_mode','erp_native','operational_effects',false);
end $$;
create function public.erp_document_get(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_documents.document where id=p_id and kind=p_kind) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'data_mode','erp_native','operational_effects',false);
end $$;
create function public.erp_document_list(p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean; v_last uuid; begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_limit is null or p_limit not between 1 and 100 or (p_status is not null and not (erp_documents.transitions()->p_kind)?p_status) then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 with page as materialized(select id from erp_documents.document where kind=p_kind and (p_after is null or id>p_after)
  and(p_status is null or status=p_status) order by id limit p_limit+1), visible as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_documents.summary(id) order by id) from visible),'[]'::jsonb),
  (select count(*)>p_limit from page),(select id from visible order by id desc limit 1) into v_items,v_more,v_last;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'has_more',v_more,'next_cursor',case when v_more then v_last end,
  'data_mode','erp_native','operational_effects',false);
end $$;

create function public.erp_document_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_body jsonb)
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

create function public.erp_document_transition(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,
 p_command_id uuid,p_status text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_before jsonb; v_result jsonb; v_reason text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','transition','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'status',p_status,'reason',p_reason)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if p_status is null or not coalesce((erp_documents.transitions()#>array[p_kind,v_row.status])?p_status,false) then
  raise exception 'erp_document_transition_invalid' using errcode='22023'; end if;
 v_reason:=erp_documents.text_value(to_jsonb(p_reason),1000);
 if (p_status='cancelled'
   or (p_status='open' and v_row.status in('approved','rejected','fulfilled','finalized','no_repair','cancelled'))
   or (v_row.status='rejected' and p_status='quoted') or(v_row.status='service_done' and p_status='in_progress'))
  and coalesce(length(v_reason),0)<3 then raise exception 'erp_document_reason_required' using errcode='22023'; end if;
 if coalesce((v_row.body->>'template')::boolean,false) and p_status='approved' then raise exception 'erp_document_template_not_approvable' using errcode='22023'; end if;
 v_before:=erp_documents.dto(p_id);
 update erp_documents.document set status=p_status,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,reason,before_data,after_data)
  values(p_user_id,p_command_id,p_id,'transition',v_reason,v_before,erp_documents.dto(p_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create function public.erp_proposal_convert(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_sale erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- A different command may not bypass CAS after a completed conversion.
 if v_source.version<>p_expected_version or v_source.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 select * into v_sale from erp_documents.document where source_proposal_id=p_id;
 if found then raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status<>'approved' or (v_source.body->>'template')::boolean then raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_before:=erp_documents.dto(p_id);
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('sales_orders',erp_documents.next_number('sales_orders'),'draft',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body||'{"template":false}'::jsonb,v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
   i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'sale',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_sale',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_documents from public,anon,authenticated,service_role;
revoke all on function public.erp_document_access(uuid) from public,anon,authenticated;
revoke all on function public.erp_document_get(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text) from public,anon,authenticated;
revoke all on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text) from public,anon,authenticated;
revoke all on function public.erp_proposal_convert(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.erp_document_access(uuid) to service_role;
grant execute on function public.erp_document_get(uuid,text,uuid) to service_role;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text) to service_role;
grant execute on function public.erp_document_save(uuid,text,uuid,integer,uuid,jsonb) to service_role;
grant execute on function public.erp_document_transition(uuid,text,uuid,integer,uuid,text,text) to service_role;
grant execute on function public.erp_proposal_convert(uuid,uuid,integer,uuid) to service_role;
commit;
