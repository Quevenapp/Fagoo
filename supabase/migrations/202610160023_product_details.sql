-- Informações locais do produto. Não calcula tributos nem altera posições de estoque.
begin;
alter table erp_catalog.product
 add column brand text check(length(brand)<=100),
 add column condition text check(condition in('new','used','refurbished','unspecified')),
 add column production text check(production in('own','third_party')),
 add column net_weight numeric(18,6) check(net_weight>=0),
 add column gross_weight numeric(18,6) check(gross_weight>=0),
 add column width numeric(18,6) check(width>=0),
 add column height numeric(18,6) check(height>=0),
 add column depth numeric(18,6) check(depth>=0),
 add column dimension_unit text check(dimension_unit in('m','cm','mm')),
 add column volumes integer check(volumes between 0 and 999999),
 add column items_per_box integer check(items_per_box between 0 and 999999),
 add column gtin_tax text check(gtin_tax='SEM GTIN' or gtin_tax~'^([0-9]{8}|[0-9]{12,14})$'),
 add column stock_min numeric(18,6) check(stock_min>=0),
 add column stock_max numeric(18,6) check(stock_max>=0),
 add column location text check(length(location)<=100),
 add column cest text check(cest~'^[0-9]{7}$'),
 add column origin text check(origin~'^[0-8]$'),
 add column additional_info text check(length(additional_info)<=2000),
 add constraint product_stock_metadata_range check(stock_min is null or stock_max is null or stock_min<=stock_max);

create or replace function erp_catalog.data(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('name',r.name,'code',r.code)||case r.entity
  when 'contacts' then(select to_jsonb(c)-'record_id' from erp_catalog.contact c where record_id=r.id)
  when 'products' then(select(to_jsonb(p)-'record_id')||jsonb_build_object('price',p.price::text,
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
   if v_pair.value<>'null'::jsonb and(jsonb_typeof(v_pair.value)<>'string' or v_pair.value#>>'{}'!~'^(0|[1-9][0-9]{0,13})(\.[0-9]{1,4})?$')then
    raise exception 'erp_catalog_invalid_price' using errcode='22023';end if;
   v_result:=v_result||jsonb_build_object('price',case when v_pair.value='null'::jsonb then null else(v_pair.value#>>'{}')::numeric(18,4)::text end);
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

-- Old source values stay readable/importable and can be resubmitted unchanged.
-- This stricter shape check is called only for a new human mutation, after replay and row locking.
create function erp_catalog.validate_product_identifiers(p_patch jsonb,p_previous jsonb) returns void
language plpgsql immutable set search_path=pg_catalog as $$
declare k text;v text;
begin
 foreach k in array array['ncm','gtin']loop
  if p_patch?k and p_patch->k is distinct from p_previous->k then
   v:=p_patch->>k;
   if(k='ncm'and v!~'^[0-9]{8}$')or(k='gtin'and v<>'SEM GTIN'and v!~'^([0-9]{8}|[0-9]{12,14})$')then
    raise exception 'erp_catalog_invalid_identifier' using errcode='22023';end if;
  end if;
 end loop;
end $$;

create or replace function erp_catalog.write_fields(p_id uuid,p_entity text,p_data jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
begin
 if p_entity='contacts'then
  insert into erp_catalog.contact select * from jsonb_populate_record(null::erp_catalog.contact,p_data||jsonb_build_object('record_id',p_id))
  on conflict(record_id)do update set trade_name=excluded.trade_name,person_type=excluded.person_type,document=excluded.document,
   ie=excluded.ie,email=excluded.email,phone=excluded.phone,mobile=excluded.mobile,postal_code=excluded.postal_code,
   street=excluded.street,number=excluded.number,complement=excluded.complement,district=excluded.district,city=excluded.city,state=excluded.state,roles=excluded.roles;
 elsif p_entity='products'then
  insert into erp_catalog.product as existing select * from jsonb_populate_record(null::erp_catalog.product,p_data||jsonb_build_object('record_id',p_id))
  on conflict(record_id)do update set unit=excluded.unit,price=excluded.price,kind=excluded.kind,format=excluded.format,
   description=excluded.description,ncm=excluded.ncm,gtin=excluded.gtin,
   brand=case when p_data?'brand'then excluded.brand else existing.brand end,
   condition=case when p_data?'condition'then excluded.condition else existing.condition end,
   production=case when p_data?'production'then excluded.production else existing.production end,
   net_weight=case when p_data?'net_weight'then excluded.net_weight else existing.net_weight end,
   gross_weight=case when p_data?'gross_weight'then excluded.gross_weight else existing.gross_weight end,
   width=case when p_data?'width'then excluded.width else existing.width end,
   height=case when p_data?'height'then excluded.height else existing.height end,
   depth=case when p_data?'depth'then excluded.depth else existing.depth end,
   dimension_unit=case when p_data?'dimension_unit'then excluded.dimension_unit else existing.dimension_unit end,
   volumes=case when p_data?'volumes'then excluded.volumes else existing.volumes end,
   items_per_box=case when p_data?'items_per_box'then excluded.items_per_box else existing.items_per_box end,
   gtin_tax=case when p_data?'gtin_tax'then excluded.gtin_tax else existing.gtin_tax end,
   stock_min=case when p_data?'stock_min'then excluded.stock_min else existing.stock_min end,
   stock_max=case when p_data?'stock_max'then excluded.stock_max else existing.stock_max end,
   location=case when p_data?'location'then excluded.location else existing.location end,
   cest=case when p_data?'cest'then excluded.cest else existing.cest end,
   origin=case when p_data?'origin'then excluded.origin else existing.origin end,
   additional_info=case when p_data?'additional_info'then excluded.additional_info else existing.additional_info end;
 elsif p_entity='warehouses'then
  insert into erp_catalog.warehouse select * from jsonb_populate_record(null::erp_catalog.warehouse,p_data||jsonb_build_object('record_id',p_id))
  on conflict(record_id)do update set description=excluded.description;
 end if;
end $$;

-- Existing mutation is retained, with the two human identifier checks inserted after replay.
-- See the identical command/row lock order and unchanged import logic in 006/011/013.
create or replace function erp_catalog.mutate(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,
  p_command_id uuid,p_data jsonb,p_set_active boolean,p_active boolean)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.record%rowtype;
  v_id uuid; v_data jsonb; v_before jsonb; v_result jsonb; v_changed boolean;
begin
  perform erp_catalog.require_access(p_user_id,p_entity,true);
  if p_command_id is null or p_expected_version is null or p_expected_version<0
    or (p_id is null and (p_expected_version<>0 or p_set_active))
    or (p_id is not null and p_expected_version<1) or (p_set_active and p_active is null) then
    raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  if not p_set_active then
    v_data:=erp_catalog.validate_data(p_entity,p_data,false);
    if v_data='{}'::jsonb then raise exception 'erp_catalog_empty_patch' using errcode='22023'; end if;
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'entity',p_entity,'id',p_id,
    'version',p_expected_version,'data',p_data,'set_active',p_set_active,'active',p_active)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
  select * into v_command from erp_catalog.command where command_id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then
      raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
    return v_command.result||'{"replayed":true}'::jsonb;
  end if;
  if p_id is null then
    if p_entity='products' then perform erp_catalog.validate_product_identifiers(v_data,null); end if;
    v_data:=erp_catalog.validate_data(p_entity,v_data,true);
    insert into erp_catalog.record(entity,name,code,created_by,updated_by,human_edited)
      values(p_entity,v_data->>'name',v_data->>'code',p_user_id,p_user_id,true) returning id into v_id;
    perform erp_catalog.write_fields(v_id,p_entity,v_data);
    v_changed:=true;
  else
    select * into v_row from erp_catalog.record where id=p_id and entity=p_entity for update;
    if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
    if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
    v_id:=p_id; v_before:=erp_catalog.dto(v_id);
    if p_set_active then v_changed:=v_row.active is distinct from p_active;
    else
      if p_entity='products' then perform erp_catalog.validate_product_identifiers(v_data,erp_catalog.data(v_id)); end if;
      v_data:=erp_catalog.validate_data(p_entity,erp_catalog.data(v_id)||v_data,true);
      v_changed:=v_data is distinct from erp_catalog.data(v_id);
    end if;
    if v_changed then
      if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
      update erp_catalog.record set name=case when p_set_active then name else v_data->>'name' end,
        code=case when p_set_active then code else v_data->>'code' end,
        active=case when p_set_active then p_active else active end,version=version+1,human_edited=true,
        updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
      if not p_set_active then perform erp_catalog.write_fields(v_id,p_entity,v_data); end if;
      update erp_catalog.origin set state=case when state in ('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_id;
    end if;
  end if;
  v_result:=jsonb_build_object('entity',p_entity,'record',erp_catalog.dto(v_id),'replayed',false,'data_mode','erp_native');
  if v_changed then insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
    values(p_user_id,p_command_id,p_entity,v_id,case when p_id is null then 'create' when p_set_active and p_active then 'restore'
      when p_set_active then 'archive' else 'update' end,v_before,erp_catalog.dto(v_id)); end if;
  insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  return v_result;
end $$;

create function public.erp_catalog_product_list(p_user_id uuid,p_limit integer default 25,p_after uuid default null,
 p_query text default null,p_active boolean default null,p_kind text default null,p_format text default null,
 p_ncm_presence text default null,p_brand text default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_more boolean;v_last uuid;
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
  or length(p_brand)>100 or p_brand~'[[:cntrl:]]'or(p_kind is not null and p_kind not in('P','S','N'))
  or(p_format is not null and p_format not in('S','V','E'))or(p_ncm_presence is not null and p_ncm_presence not in('present','missing'))then
  raise exception 'erp_catalog_invalid_query' using errcode='22023';end if;
 with page as materialized(
  select r.id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.entity='products'
   and(p_after is null or r.id>p_after)and(p_active is null or r.active=p_active)
   and(p_kind is null or p.kind=p_kind)and(p_format is null or p.format=p_format)
   and(p_ncm_presence is null or case p_ncm_presence when 'present'then nullif(btrim(p.ncm),'')is not null else nullif(btrim(p.ncm),'')is null end)
   and(nullif(btrim(p_brand),'')is null or strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0)
   and(nullif(btrim(p_query),'')is null or strpos(lower(concat_ws(' ',r.name,r.code,p.gtin)),lower(btrim(p_query)))>0)
  order by r.id limit p_limit+1
 ),visible as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_catalog.dto(id)order by id)from visible),'[]'::jsonb),
  (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)into v_items,v_more,v_last;
 return jsonb_build_object('entity','products','items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_last end,'limit',p_limit,'data_mode','erp_native');
end $$;
revoke all on function erp_catalog.validate_product_identifiers(jsonb,jsonb)from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_product_list(uuid,integer,uuid,text,boolean,text,text,text,text)from public,anon,authenticated;
grant execute on function public.erp_catalog_product_list(uuid,integer,uuid,text,boolean,text,text,text,text)to service_role;
commit;
