-- Cadastros próprios da única empresa. Sem movimentos, saldos ou escrita na origem.
begin;
create schema erp_catalog;
revoke all on schema erp_catalog from public, anon, authenticated, service_role;

create table erp_catalog.record (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('contacts','products','warehouses')),
  name text not null check (length(name) between 1 and 200 and name=btrim(name)),
  code text check (length(code) <= 100),
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  human_edited boolean not null default false,
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id,entity)
);
create index erp_catalog_record_entity on erp_catalog.record(entity,id);
create table erp_catalog.contact (
  record_id uuid primary key references erp_catalog.record(id),
  trade_name text, person_type text check (person_type in ('J','F','E')),
  document text, ie text, email text, phone text, mobile text, postal_code text,
  street text, number text, complement text, district text, city text, state text,
  roles text[] not null default array[]::text[] check (roles <@ array['customer','supplier','carrier'])
);
create table erp_catalog.product (
  record_id uuid primary key references erp_catalog.record(id),
  unit text, price numeric(18,4) check (price >= 0),
  kind text check (kind in ('P','S','N')), format text check (format in ('S','V','E')),
  description text, ncm text, gtin text
);
create table erp_catalog.warehouse (
  record_id uuid primary key references erp_catalog.record(id), description text
);
create table erp_catalog.source_snapshot (
  entity text not null check (entity in ('contacts','products')),
  source_id text not null check (length(source_id) between 1 and 200),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_version bigint not null, payload jsonb not null, document_links jsonb not null,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (entity,source_id,source_hash)
);
create table erp_catalog.origin (
  entity text not null check (entity in ('contacts','products')),
  source_id text not null,
  record_id uuid not null unique,
  applied_hash text, latest_hash text not null,
  state text not null check (state in ('synced','local_modified','source_changed','source_deleted')),
  candidate jsonb,
  foreign key (record_id,entity) references erp_catalog.record(id,entity),
  foreign key (entity,source_id,latest_hash) references erp_catalog.source_snapshot(entity,source_id,source_hash),
  foreign key (entity,source_id,applied_hash) references erp_catalog.source_snapshot(entity,source_id,source_hash),
  primary key (entity,source_id)
);
create table erp_catalog.command (
  command_id uuid primary key, actor uuid not null references auth.users(id),
  request_hash text not null, result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table erp_catalog.audit (
  id bigint generated always as identity primary key,
  actor uuid not null references auth.users(id), command_id uuid not null,
  entity text not null, record_id uuid not null references erp_catalog.record(id),
  action text not null, before_data jsonb, after_data jsonb,
  created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['record','contact','product','warehouse','source_snapshot','origin','command','audit'] loop
    execute format('alter table erp_catalog.%I enable row level security',t);
  end loop;
end $$;
revoke all on all tables in schema erp_catalog from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_catalog from public,anon,authenticated,service_role;
alter default privileges in schema erp_catalog revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_catalog revoke all on functions from public,anon,authenticated,service_role;

create function erp_catalog.allowed(p_role text,p_entity text,p_write boolean)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select coalesce(case when p_write then
    case when p_entity='contacts' then p_role in ('admin','vendas','financeiro')
      when p_entity in ('products','warehouses') then p_role in ('admin','estoque') else false end
    else case when p_entity='warehouses' then p_role in ('admin','consulta','estoque')
      when p_entity in ('contacts','products') then p_entity=any(erp_access.resources_for_role(p_role)) else false end
    end,false);
$$;
create function erp_catalog.require_access(p_user_id uuid,p_entity text,p_write boolean)
returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found or not erp_catalog.allowed(v_role,p_entity,p_write) then
    raise exception 'erp_catalog_access_denied' using errcode='42501';
  end if;
  return v_role;
end $$;
create function public.erp_catalog_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
  return jsonb_build_object('read',(select coalesce(jsonb_agg(e order by e),'[]'::jsonb)
      from unnest(array['contacts','products','warehouses']) e where erp_catalog.allowed(v_role,e,false)),
    'write',(select coalesce(jsonb_agg(e order by e),'[]'::jsonb)
      from unnest(array['contacts','products','warehouses']) e where erp_catalog.allowed(v_role,e,true)),
    'data_mode','erp_native');
end $$;

create function erp_catalog.data(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('name',r.name,'code',r.code) || case r.entity
    when 'contacts' then (select to_jsonb(c)-'record_id' from erp_catalog.contact c where record_id=r.id)
    when 'products' then (select (to_jsonb(p)-'record_id')||jsonb_build_object('price',p.price::text) from erp_catalog.product p where record_id=r.id)
    when 'warehouses' then (select to_jsonb(w)-'record_id' from erp_catalog.warehouse w where record_id=r.id) end
  from erp_catalog.record r where r.id=p_id;
$$;
create function erp_catalog.dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select erp_catalog.data(r.id)||jsonb_build_object('id',r.id,'entity',r.entity,'active',r.active,
    'version',r.version,'created_at',r.created_at,'updated_at',r.updated_at,
    'source',(select jsonb_build_object('system','origin','source_id',o.source_id,'state',o.state,
      'applied_hash',o.applied_hash,'latest_hash',o.latest_hash) from erp_catalog.origin o where o.record_id=r.id))
  from erp_catalog.record r where r.id=p_id;
$$;

create function erp_catalog.validate_data(p_entity text,p_data jsonb,p_full boolean)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_specs jsonb; v_pair record; v_result jsonb:='{}'; v_text text;
begin
  if p_entity not in ('contacts','products','warehouses') or p_entity is null
     or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then
    raise exception 'erp_catalog_invalid_data' using errcode='22023'; end if;
  v_specs:='{"name":200,"code":100}'::jsonb || case p_entity
    when 'contacts' then '{"trade_name":200,"person_type":1,"document":30,"ie":30,"email":254,"phone":40,"mobile":40,"postal_code":20,"street":200,"number":30,"complement":200,"district":100,"city":100,"state":2,"roles":0}'::jsonb
    when 'products' then '{"unit":16,"price":0,"kind":1,"format":1,"description":4000,"ncm":8,"gtin":14}'::jsonb
    else '{"description":1000}'::jsonb end;
  for v_pair in select key,value from jsonb_each(p_data) loop
    if not v_specs ? v_pair.key then raise exception 'erp_catalog_unknown_field' using errcode='22023'; end if;
    if v_pair.key='roles' then
      if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>3
         or exists(select 1 from jsonb_array_elements(v_pair.value) a where jsonb_typeof(a)<>'string' or a#>>'{}' not in ('customer','supplier','carrier')) then
        raise exception 'erp_catalog_invalid_roles' using errcode='22023'; end if;
      v_result:=v_result||jsonb_build_object('roles',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from (select distinct value#>>'{}' s from jsonb_array_elements(v_pair.value)) q));
    elsif v_pair.key='price' then
      if v_pair.value<>'null'::jsonb and (jsonb_typeof(v_pair.value)<>'string'
        or v_pair.value#>>'{}' !~ '^(0|[1-9][0-9]{0,13})(\.[0-9]{1,4})?$') then
        raise exception 'erp_catalog_invalid_price' using errcode='22023'; end if;
      v_result:=v_result||jsonb_build_object('price',case when v_pair.value='null'::jsonb then null else (v_pair.value#>>'{}')::numeric(18,4)::text end);
    else
      if v_pair.value<>'null'::jsonb and jsonb_typeof(v_pair.value)<>'string' then
        raise exception 'erp_catalog_text_required' using errcode='22023'; end if;
      v_text:=nullif(btrim(v_pair.value#>>'{}'),'');
      if length(v_text)>(v_specs->>v_pair.key)::integer
        or (case when v_pair.key='description' then translate(v_text,E'\n\r\t','') else v_text end) ~ '[[:cntrl:]]' then
        raise exception 'erp_catalog_invalid_text' using errcode='22023'; end if;
      if (v_pair.key='person_type' and v_text not in ('J','F','E'))
        or (v_pair.key='kind' and v_text not in ('P','S','N'))
        or (v_pair.key='format' and v_text not in ('S','V','E')) then
        raise exception 'erp_catalog_invalid_enum' using errcode='22023'; end if;
      v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
    end if;
  end loop;
  if p_full and nullif(v_result->>'name','') is null then
    raise exception 'erp_catalog_name_required' using errcode='22023'; end if;
  if p_full and p_entity='contacts' and not v_result?'roles' then v_result:=v_result||'{"roles":[]}'::jsonb; end if;
  return v_result;
end $$;

create function erp_catalog.write_fields(p_id uuid,p_entity text,p_data jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
begin
  if p_entity='contacts' then
    insert into erp_catalog.contact select * from jsonb_populate_record(null::erp_catalog.contact,p_data||jsonb_build_object('record_id',p_id))
    on conflict(record_id) do update set trade_name=excluded.trade_name,person_type=excluded.person_type,document=excluded.document,
      ie=excluded.ie,email=excluded.email,phone=excluded.phone,mobile=excluded.mobile,postal_code=excluded.postal_code,
      street=excluded.street,number=excluded.number,complement=excluded.complement,district=excluded.district,
      city=excluded.city,state=excluded.state,roles=excluded.roles;
  elsif p_entity='products' then
    insert into erp_catalog.product select * from jsonb_populate_record(null::erp_catalog.product,p_data||jsonb_build_object('record_id',p_id))
    on conflict(record_id) do update set unit=excluded.unit,price=excluded.price,kind=excluded.kind,format=excluded.format,
      description=excluded.description,ncm=excluded.ncm,gtin=excluded.gtin;
  elsif p_entity='warehouses' then
    insert into erp_catalog.warehouse select * from jsonb_populate_record(null::erp_catalog.warehouse,p_data||jsonb_build_object('record_id',p_id))
    on conflict(record_id) do update set description=excluded.description;
  end if;
end $$;

create function public.erp_catalog_get(p_user_id uuid,p_entity text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform erp_catalog.require_access(p_user_id,p_entity,false);
  if not exists(select 1 from erp_catalog.record where id=p_id and entity=p_entity) then
    raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity',p_entity,'record',erp_catalog.dto(p_id),'data_mode','erp_native');
end $$;
create function public.erp_catalog_list(p_user_id uuid,p_entity text,p_limit integer default 25,
  p_after uuid default null,p_query text default null,p_active boolean default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean; v_last uuid;
begin
  perform erp_catalog.require_access(p_user_id,p_entity,false);
  if p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 then
    raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
  with page as materialized (
    select r.id from erp_catalog.record r left join erp_catalog.contact c on c.record_id=r.id
    where r.entity=p_entity and (p_after is null or r.id>p_after) and (p_active is null or r.active=p_active)
      and (nullif(btrim(p_query),'') is null or strpos(lower(concat_ws(' ',r.name,r.code,c.document)),lower(btrim(p_query)))>0)
    order by r.id limit p_limit+1
  ), visible as materialized (select id from page order by id limit p_limit)
  select coalesce((select jsonb_agg(erp_catalog.dto(id) order by id) from visible),'[]'::jsonb),
    (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)
  into v_items,v_more,v_last;
  return jsonb_build_object('entity',p_entity,'items',v_items,'has_more',v_more,
    'next_cursor',case when v_more then v_last end,'limit',p_limit,'data_mode','erp_native');
end $$;

create function erp_catalog.mutate(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,
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
create function public.erp_catalog_save(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,p_data,false,null);
$$;
create function public.erp_catalog_set_active(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,p_command_id uuid,p_active boolean)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,null,true,p_active);
$$;

-- Mapping deliberately excludes financial/stock fields. Full source stays in a
-- private immutable snapshot; missing names or incompatible values are rejected.
create function erp_catalog.map_origin(p_entity text,p_payload jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_data jsonb; v_address jsonb;
begin
  v_data:=jsonb_build_object('name',p_payload->'nome','code',p_payload->'codigo');
  if p_entity='contacts' then
    v_address:=p_payload#>'{endereco,geral}';
    v_data:=v_data||jsonb_build_object('trade_name',p_payload->'fantasia','person_type',p_payload->'tipo',
      'document',p_payload->'numeroDocumento','ie',p_payload->'ie','email',p_payload->'email',
      'phone',p_payload->'telefone','mobile',p_payload->'celular','postal_code',v_address->'cep',
      'street',v_address->'endereco','number',v_address->'numero','complement',v_address->'complemento',
      'district',v_address->'bairro','city',v_address->'municipio','state',v_address->'uf','roles','[]'::jsonb);
  elsif p_entity='products' then
    if p_payload?'preco' and p_payload->'preco'<>'null'::jsonb and jsonb_typeof(p_payload->'preco') not in ('number','string') then
      raise exception 'erp_catalog_invalid_source_price' using errcode='22023'; end if;
    v_data:=v_data||jsonb_build_object('unit',p_payload->'unidade','price',p_payload->>'preco',
      'kind',p_payload->'tipo','format',p_payload->'formato','description',p_payload->'descricaoCurta',
      'ncm',p_payload#>'{tributacao,ncm}','gtin',p_payload->'gtin');
  else raise exception 'erp_catalog_invalid_import_entity' using errcode='22023'; end if;
  return erp_catalog.validate_data(p_entity,v_data,true);
end $$;

create function public.erp_catalog_import_origin(p_user_id uuid,p_entity text,p_items jsonb,
  p_command_id uuid default null,p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_item jsonb; v_source origin_sync.raw_record%rowtype; v_origin erp_catalog.origin%rowtype;
  v_row erp_catalog.record%rowtype; v_command erp_catalog.command%rowtype; v_data jsonb; v_before jsonb;
  v_id uuid; v_source_id text; v_action text; v_status text; v_active boolean; v_error text;
  v_hash text; v_results jsonb:='[]'; v_result jsonb; v_has_origin boolean;
begin
  v_role:=erp_catalog.require_access(p_user_id,p_entity,true);
  if v_role<>'admin' then raise exception 'erp_catalog_import_denied' using errcode='42501'; end if;
  if p_entity not in ('contacts','products') or p_dry_run is null
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
    or octet_length(p_items::text)>65536 or (not p_dry_run and p_command_id is null) then
    raise exception 'erp_catalog_invalid_import' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) a group by a->>'source_id' having count(*)>1) then
    raise exception 'erp_catalog_duplicate_import_id' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'entity',p_entity,'items',p_items,'action','import_origin')::text,'UTF8')),'hex');
  if not p_dry_run then
    perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
    select * into v_command from erp_catalog.command where command_id=p_command_id;
    if found then
      if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then
        raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
      return v_command.result||'{"replayed":true}'::jsonb;
    end if;
    -- Serialize canonical imports. Human edits serialize on the local record.
    perform pg_advisory_xact_lock(174852907,hashtext(p_entity));
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'source_id') is distinct from 'string'
      or length(v_item->>'source_id') not between 1 and 200 or v_item->>'source_id'<>btrim(v_item->>'source_id')
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('source_id','source_hash'))
      or (v_item?'source_hash' and coalesce(v_item->>'source_hash','')!~'^[0-9a-f]{64}$')
      or (not p_dry_run and not v_item?'source_hash') then
      raise exception 'erp_catalog_invalid_import_item' using errcode='22023'; end if;
    v_source_id:=v_item->>'source_id'; v_action:=null; v_error:=null; v_id:=null; v_data:=null;
    select * into v_source from origin_sync.raw_record where entity=p_entity and source_id=v_source_id;
    if not found then
      v_results:=v_results||jsonb_build_array(jsonb_build_object('source_id',v_source_id,'action','missing_source'));
      continue;
    end if;
    if v_item?'source_hash' and v_item->>'source_hash'<>v_source.version_hash then
      raise exception 'erp_catalog_source_version_conflict' using errcode='40001'; end if;
    select * into v_origin from erp_catalog.origin where entity=p_entity and source_id=v_source_id;
    v_has_origin:=found;
    if v_has_origin then
      select * into v_row from erp_catalog.record where id=v_origin.record_id for update;
      v_id:=v_row.id;
    end if;
    begin v_data:=erp_catalog.map_origin(p_entity,v_source.payload);
    exception when sqlstate '22023' then v_error:='source_mapping_invalid'; end;
    v_status:=v_source.payload->>'situacao';
    if v_status not in ('A','I','E','S') or v_status is null then v_error:='source_status_unknown'; end if;
    v_active:=v_status in ('A','S');
    if v_error is not null then v_action:='invalid_source';
    elsif not v_has_origin then v_action:='create';
    elsif v_origin.latest_hash=v_source.version_hash then v_action:='unchanged';
    elsif v_status='E' then v_action:='pending_source_deleted';
    elsif v_row.human_edited then v_action:='pending_human_review';
    else v_action:='update'; end if;
    if not p_dry_run and v_error is null then
      insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)
      values(p_entity,v_source_id,v_source.version_hash,v_source.version,v_source.payload,v_source.document_links)
      on conflict(entity,source_id,source_hash) do nothing;
      if v_action='create' then
        insert into erp_catalog.record(entity,name,code,active,created_by,updated_by)
          values(p_entity,v_data->>'name',v_data->>'code',v_active,p_user_id,p_user_id) returning id into v_id;
        perform erp_catalog.write_fields(v_id,p_entity,v_data);
        insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state,candidate)
          values(p_entity,v_source_id,v_id,v_source.version_hash,v_source.version_hash,
            case when v_status='E' then 'source_deleted' else 'synced' end,null);
      elsif v_action='update' then
        if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
        v_before:=erp_catalog.dto(v_id);
        update erp_catalog.record set name=v_data->>'name',code=v_data->>'code',active=v_active,version=version+1,
          updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
        perform erp_catalog.write_fields(v_id,p_entity,v_data);
        update erp_catalog.origin set applied_hash=v_source.version_hash,latest_hash=v_source.version_hash,state='synced',candidate=null
          where entity=p_entity and source_id=v_source_id;
      elsif v_action in ('pending_human_review','pending_source_deleted') then
        v_before:=erp_catalog.dto(v_id);
        update erp_catalog.origin set latest_hash=v_source.version_hash,
          state=case when v_action='pending_source_deleted' then 'source_deleted' else 'source_changed' end,
          candidate=jsonb_build_object('data',v_data,'active',v_active,'source_hash',v_source.version_hash)
          where entity=p_entity and source_id=v_source_id;
      end if;
      if v_action<>'unchanged' then
        insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
          values(p_user_id,p_command_id,p_entity,v_id,'import_'||v_action,
            case when v_action='create' then null else v_before end,erp_catalog.dto(v_id));
      end if;
    end if;
    v_results:=v_results||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('source_id',v_source_id,
      'source_hash',v_source.version_hash,'source_version',v_source.version,'record_id',v_id,'action',v_action,'error',v_error)));
  end loop;
  v_result:=jsonb_build_object('entity',p_entity,'items',v_results,'dry_run',p_dry_run,
    'replayed',false,'data_mode','erp_native','operational_effects',false);
  if not p_dry_run then insert into erp_catalog.command(command_id,actor,request_hash,result)
    values(p_command_id,p_user_id,v_hash,v_result); end if;
  return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_access(uuid) from public,anon,authenticated;
revoke all on function public.erp_catalog_get(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_catalog_list(uuid,text,integer,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.erp_catalog_set_active(uuid,text,uuid,integer,uuid,boolean) from public,anon,authenticated;
revoke all on function public.erp_catalog_import_origin(uuid,text,jsonb,uuid,boolean) from public,anon,authenticated;
grant execute on function public.erp_catalog_access(uuid) to service_role;
grant execute on function public.erp_catalog_get(uuid,text,uuid) to service_role;
grant execute on function public.erp_catalog_list(uuid,text,integer,uuid,text,boolean) to service_role;
grant execute on function public.erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb) to service_role;
grant execute on function public.erp_catalog_set_active(uuid,text,uuid,integer,uuid,boolean) to service_role;
grant execute on function public.erp_catalog_import_origin(uuid,text,jsonb,uuid,boolean) to service_role;
commit;
