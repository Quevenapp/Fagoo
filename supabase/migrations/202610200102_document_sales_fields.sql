-- Campos do Origin nos pedidos, propostas e OS, colunas e filtros da listagem que dependem deles, e o próximo número.
-- Campos novos do corpo (opcionais, aceitos em todos os tipos e só gravados quando enviados): ship_date, finish_date,
-- start_time, end_time, customer_po_number, quote_requested, quoted, warranty_days, warranty_months, warranty_info,
-- reception_notes, template_name e delivery_address. O núcleo de 057 continua validando o resto do corpo.
-- Somente leitura na listagem e no próximo número; nada aqui lança estoque, contas ou nota fiscal.
-- Requer 008, 015, 017, 018, 019, 022, 054, 057, 070, 090 e 095.
begin;

create function erp_documents.extension_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days',
  'warranty_months','warranty_info','reception_notes','template_name','delivery_address']
$$;

-- Endereço de entrega (Origin "Endereço de entrega diferente da cobrança"): objeto completo ou null.
create function erp_documents.delivery_address(v jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_postal text; v_state text; v_result jsonb;
begin
 if v is null or v='null'::jsonb then return 'null'::jsonb; end if;
 if jsonb_typeof(v)<>'object' or not(v?&array['name','postal_code','state','city','district','street','number','complement','country'])
  or exists(select 1 from jsonb_object_keys(v) k where k not in('name','postal_code','state','city','district','street','number','complement','country')) then
  raise exception 'erp_document_delivery_address_invalid' using errcode='22023'; end if;
 v_postal:=erp_documents.text_value(v->'postal_code',9);
 if v_postal is not null then
  if v_postal!~'^[0-9]{5}-?[0-9]{3}$' then raise exception 'erp_document_delivery_address_invalid' using errcode='22023'; end if;
  v_postal:=replace(v_postal,'-','');
 end if;
 v_state:=upper(erp_documents.text_value(v->'state',2));
 if v_state is not null and v_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$' then
  raise exception 'erp_document_delivery_address_invalid' using errcode='22023'; end if;
 v_result:=jsonb_build_object('name',erp_documents.text_value(v->'name',120),'postal_code',v_postal,'state',v_state,
  'city',erp_documents.text_value(v->'city',100),'district',erp_documents.text_value(v->'district',100),
  'street',erp_documents.text_value(v->'street',100),'number',erp_documents.text_value(v->'number',30),
  'complement',erp_documents.text_value(v->'complement',100),'country',erp_documents.text_value(v->'country',60));
 if v_result->'street'='null'::jsonb or v_result->'city'='null'::jsonb then
  raise exception 'erp_document_delivery_address_invalid' using errcode='22023'; end if;
 return v_result;
end $$;

-- Valida e devolve só os campos novos presentes no corpo (ausente continua ausente, como em 054).
create function erp_documents.extension_data(p_body jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_result jsonb:='{}'; v jsonb; k text;
begin
 foreach k in array erp_documents.extension_keys() loop
  if not p_body?k then continue; end if;
  v:=p_body->k;
  if k in('ship_date','finish_date') then v:=to_jsonb(erp_documents.date_value(v));
  elsif k in('start_time','end_time') then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'erp_document_time_invalid' using errcode='22023'; end if;
  elsif k in('quote_requested','quoted') then
   if v<>'null'::jsonb and jsonb_typeof(v)<>'boolean' then raise exception 'erp_document_flag_invalid' using errcode='22023'; end if;
  elsif k='warranty_days' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,3})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='warranty_months' then
   if v<>'null'::jsonb and (jsonb_typeof(v)<>'string' or v#>>'{}'!~'^(0|[1-9][0-9]{0,2})$') then
    raise exception 'erp_document_warranty_invalid' using errcode='22023'; end if;
  elsif k='customer_po_number' then v:=to_jsonb(erp_documents.text_value(v,60));
  elsif k='template_name' then v:=to_jsonb(erp_documents.text_value(v,120));
  elsif k in('warranty_info','reception_notes') then v:=to_jsonb(erp_documents.text_value(v,4000,false,true));
  elsif k='delivery_address' then v:=erp_documents.delivery_address(v);
  end if;
  v_result:=v_result||jsonb_build_object(k,coalesce(v,'null'::jsonb));
 end loop;
 return v_result;
end $$;

-- 057 stays the validation core for every existing field; the wrapper adds the new optional fields.
alter function erp_documents.normalize(text,jsonb) rename to normalize_core;
create function erp_documents.normalize(p_kind text,p_body jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 return erp_documents.normalize_core(p_kind,p_body-erp_documents.extension_keys())||erp_documents.extension_data(p_body);
end $$;

-- An older full-replacement client must not silently erase the new fields either (same guard and code as 054).
create or replace function erp_documents.require_commercial_input(p_current jsonb,p_input jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if erp_documents.has_commercial_data(p_current) and (not(p_input?'commercial')
  or exists(select 1 from jsonb_array_elements(p_input->'items') i where not(i?'detailed_description'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_input->'installments','[]'::jsonb)) p where not(p?&array['note','payment_reference']))) then
  raise exception 'erp_document_commercial_fields_required' using errcode='40001';end if;
 if exists(select 1 from unnest(erp_documents.extension_keys()) k where coalesce(p_current->k,'null'::jsonb)<>'null'::jsonb and not p_input?k) then
  raise exception 'erp_document_fields_required' using errcode='40001';end if;
end $$;

-- Listagem: 095 mais as colunas opcionais do Origin e a primeira venda do cliente.
create index erp_documents_kind_ship_number on erp_documents.document(kind,(body->>'ship_date'),number) where body?'ship_date';
create index erp_documents_service_finish_number on erp_documents.document((body->>'finish_date'),number) where kind='service_orders' and body?'finish_date';
create index erp_documents_sales_contact_date on erp_documents.document(contact_id,(body->>'date'),number) where kind='sales_orders' and status<>'cancelled';

create function erp_documents.address_text(v jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select nullif(concat_ws(' - ',nullif(concat_ws(', ',nullif(v->>'street',''),nullif(v->>'number',''),nullif(v->>'complement','')),''),
  nullif(v->>'district',''),nullif(concat_ws('/',nullif(v->>'city',''),nullif(v->>'state','')),''),
  case when nullif(v->>'postal_code','') is not null then 'CEP '||(v->>'postal_code') end),'')
$$;

create or replace function erp_documents.list_row(p_id uuid,p_fiscal boolean,p_stock boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'template',coalesce(d.body->'template'='true'::jsonb,false),
  'total',d.total::text,'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name',
  'warehouse_id',d.warehouse_id,'warehouse_name',case when p_stock then w.name end,
  'source_proposal_id',d.source_proposal_id,'source_proposal_number',p.number::text,
  'finance_active',exists(select 1 from erp_finance.document_posting f where f.document_id=d.id and f.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting s where s.document_id=d.id and s.state='active'),
  'receipt_active',d.kind='purchase_orders' and erp_purchase_receipts.active(d.id),
  'reservation_active',case when p_stock then d.kind='sales_orders' and exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active') end,
  'fiscal_draft',case when p_fiscal and d.kind='sales_orders' then exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft') end,
  'internal_notes',left(d.body->>'internal_notes',280),
  'created_at',d.created_at,'updated_at',d.updated_at,
  -- 102: colunas opcionais e "1ª venda" (o mesmo perfil já lê esses dados no documento).
  'customer_po_number',d.body->>'customer_po_number','ship_date',d.body->>'ship_date',
  'contact_email',nullif(d.contact_snapshot->>'email',''),'contact_phone',coalesce(nullif(d.contact_snapshot->>'phone',''),nullif(d.contact_snapshot->>'mobile','')),
  'contact_document',nullif(d.contact_snapshot->>'document',''),
  'address',left(coalesce(erp_documents.address_text(nullif(d.body->'delivery_address','null'::jsonb)),erp_documents.address_text(d.contact_snapshot)),500),
  'carrier_name',left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)))
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 where d.id=p_id;
$$;

drop function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text);
create function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null,
 p_page integer default null,p_order text default 'id',p_statuses text[] default null,p_date_type text default 'date',
 p_warehouse_id uuid default null,p_product_id uuid default null,p_city text default null,p_state text default null,
 p_technician text default null,p_equipment text default null,p_serial_number text default null,p_internal_note text default null,
 p_postal_code text default null,p_district text default null,p_tracking_code text default null,p_customer_po_number text default null,
 p_carrier text default null,p_contact_email text default null,p_template boolean default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_stock boolean; v_statuses text[]; v_query text; v_digits text; v_from date; v_to date; v_offset bigint;
 v_cursor erp_documents.document%rowtype; v_cursor_day text; v_items jsonb; v_more boolean; v_last uuid; v_count bigint; v_amount numeric;
 v_city text; v_technician text; v_equipment text; v_serial text; v_note text;
 v_postal text; v_district text; v_tracking text; v_po text; v_carrier text; v_email text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in ('admin','fiscal');
 -- Mesmos perfis de leitura de erp_stock.require_access (009).
 v_stock:=v_role in ('admin','consulta','estoque','vendas','fiscal');
 v_statuses:=case when p_statuses is not null then p_statuses when p_status is not null then array[p_status] end;
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and p_statuses is not null)
  or (v_statuses is not null and (coalesce(cardinality(v_statuses),0) not between 1 and 20 or array_position(v_statuses,null) is not null
   or exists(select 1 from unnest(v_statuses) s where not (erp_documents.transitions()->p_kind)?s)
   or (select count(distinct s) from unnest(v_statuses) s)<>cardinality(v_statuses)))
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
 -- CPF/CNPJ (e o CEP na OS) com ou sem máscara: compara só os dígitos quando a pesquisa é numérica com pelo menos 5 dígitos.
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
  where d.kind=p_kind
   and (v_statuses is null or d.status=any(v_statuses))
   and (v_from is null and v_to is null
    or p_date_type='date' and (v_from is null or d.body->>'date'>=p_date_from) and (v_to is null or d.body->>'date'<=p_date_to)
    or p_date_type='expected_date' and (v_from is null or d.body->>'expected_date'>=p_date_from) and (v_to is null or d.body->>'expected_date'<=p_date_to)
    or p_date_type='next_contact' and (v_from is null or d.body->>'next_contact'>=p_date_from) and (v_to is null or d.body->>'next_contact'<=p_date_to)
    or p_date_type='ship_date' and (v_from is null or d.body->>'ship_date'>=p_date_from) and (v_to is null or d.body->>'ship_date'<=p_date_to)
    or p_date_type='finish_date' and (v_from is null or d.body->>'finish_date'>=p_date_from) and (v_to is null or d.body->>'finish_date'<=p_date_to)
    -- Garantia: data de saída (ou da OS) mais os dias de garantia.
    or p_date_type='warranty_until' and d.body->>'warranty_days' is not null
     and (v_from is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)>=v_from)
     and (v_to is null or (coalesce(d.body->>'ship_date',d.body->>'date')::date+(d.body->>'warranty_days')::integer)<=v_to))
   and (p_warehouse_id is null or d.warehouse_id=p_warehouse_id)
   and (p_product_id is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=p_product_id))
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
   and (v_carrier is null or strpos(lower(coalesce(d.body#>>'{commercial,transport,carrier_reference,label}','')),v_carrier)>0)
   and (v_email is null or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_email)>0)
   and (p_template is null or coalesce(d.body->'template'='true'::jsonb,false)=p_template)
   and (v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'trade_name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'email','')),v_query)>0
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
  'total_count',v_count,'total_amount',v_amount::numeric(20,2)::text,'data_mode','erp_native','operational_effects',false);
end $$;

-- Próximo número (Origin "Pedido de venda - <próximo número>"): apenas leitura, não reserva o número.
create function public.erp_document_next_number(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v bigint; begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select last_number into v from erp_documents.numbering where kind=p_kind;
 if not found then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 return jsonb_build_object('kind',p_kind,'next_number',case when v<9999999999 then (v+1)::text end,'reserved',false,
  'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.extension_keys(),erp_documents.delivery_address(jsonb),erp_documents.extension_data(jsonb),
 erp_documents.normalize(text,jsonb),erp_documents.normalize_core(text,jsonb),erp_documents.require_commercial_input(jsonb,jsonb),
 erp_documents.address_text(jsonb),erp_documents.list_row(uuid,boolean,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text,integer,text,text[],text,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,boolean) to service_role;
revoke all on function public.erp_document_next_number(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_next_number(uuid,text) to service_role;
commit;
