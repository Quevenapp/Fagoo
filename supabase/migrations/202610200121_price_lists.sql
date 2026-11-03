-- Cadastros > Listas de preços no padrão do Origin: lista de taxas, por período ou customizada, com fator em % ou R$, acréscimo
-- ou desconto, validade (data e hora opcionais, horário de São Paulo), vínculos por contato ou UF e os produtos da lista.
-- O preço da lista é calculado aqui com decimal exato e arredondado a duas casas, como o Origin mostra. A aplicação da lista
-- nos pedidos, propostas e PDV depende das telas de vendas e não faz parte desta migração. Depende de 006/057/096/119.
begin;
create schema erp_pricing;
revoke all on schema erp_pricing from public,anon,authenticated,service_role;

create table erp_pricing.price_list(
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(name) between 1 and 120 and name=btrim(name) and name!~'[[:cntrl:]]'),
 category text not null check(category in('other','contact','region')),
 list_type text not null check(list_type in('rates','period','custom')),
 factor numeric(15,4) check(factor>0),
 factor_unit text not null check(factor_unit in('percent','amount')),
 direction text not null check(direction in('increase','discount')),
 considers_datetime boolean not null default false,
 starts_on date, ends_on date, start_time time(0), end_time time(0),
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check(list_type='custom' or factor is not null),
 check(factor_unit<>'percent' or direction<>'discount' or factor<=100),
 check(starts_on is null or ends_on is null or starts_on<=ends_on),
 check(considers_datetime or(start_time is null and end_time is null)),
 check(list_type<>'period' or starts_on is not null or ends_on is not null)
);
create unique index erp_pricing_price_list_name on erp_pricing.price_list(erp_catalog.fold(name));
create table erp_pricing.price_list_item(
 list_id uuid not null references erp_pricing.price_list(id) on delete cascade,
 product_id uuid not null references erp_catalog.product(record_id),
 custom_price numeric check(custom_price is null or(custom_price>=0 and custom_price<100000000000000 and custom_price=trunc(custom_price,10))),
 added_at timestamptz not null default clock_timestamp(),
 primary key(list_id,product_id)
);
create index erp_pricing_price_list_item_product on erp_pricing.price_list_item(product_id);
create table erp_pricing.price_list_contact(
 list_id uuid not null references erp_pricing.price_list(id) on delete cascade,
 contact_id uuid not null references erp_catalog.contact(record_id), primary key(list_id,contact_id)
);
create table erp_pricing.price_list_region(
 list_id uuid not null references erp_pricing.price_list(id) on delete cascade,
 state text not null check(state in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')),
 primary key(list_id,state)
);
create table erp_pricing.command(
 command_id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_pricing.audit(
 id bigint generated always as identity primary key, actor uuid not null references auth.users(id), command_id uuid not null,
 list_id uuid not null, action text not null check(action in('create','update','items','adjust','delete','clone')),
 before_data jsonb, after_data jsonb, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['price_list','price_list_item','price_list_contact','price_list_region','command','audit'] loop
  execute format('alter table erp_pricing.%I enable row level security',t);
  execute format('revoke all on table erp_pricing.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke all on all sequences in schema erp_pricing from public,anon,authenticated,service_role;
alter default privileges in schema erp_pricing revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_pricing revoke all on functions from public,anon,authenticated,service_role;

-- Preço da lista: taxas e por período aplicam o fator sobre o preço de venda do produto; a customizada usa o preço do item
-- (ou o preço de venda quando ainda não tem). Duas casas, arredondamento comercial, nunca negativo.
create function erp_pricing.list_price(p_list erp_pricing.price_list,p_base numeric,p_custom numeric) returns numeric
language sql immutable set search_path=pg_catalog as $$
 select case when p_list.list_type='custom' then round(coalesce(p_custom,p_base),2)
  -- Rates and period lists start from the sale price: no sale price, no list price (GREATEST would turn null into 0).
  when p_base is null then null
  else greatest(0,round(case p_list.factor_unit
   when 'percent' then p_base*(1+(case p_list.direction when 'increase' then 1 else -1 end)*p_list.factor/100)
   else p_base+(case p_list.direction when 'increase' then 1 else -1 end)*p_list.factor end,2)) end
$$;
create function erp_pricing.rule_text(p_list erp_pricing.price_list) returns text
language sql immutable set search_path=pg_catalog as $$
 select case when p_list.list_type='custom' then 'Customizada'
  else(case p_list.direction when 'increase' then 'Acréscimo ' else 'Desconto ' end)||case p_list.factor_unit
   when 'percent' then replace(trim_scale(p_list.factor)::text,'.',',')||' %' else 'R$ '||replace(to_char(p_list.factor,'FM999999999990.00'),'.',',') end end
$$;
create function erp_pricing.header(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',l.id,'name',l.name,'category',l.category,'list_type',l.list_type,'factor',l.factor::text,'factor_unit',l.factor_unit,
  'direction',l.direction,'considers_datetime',l.considers_datetime,'starts_on',to_char(l.starts_on,'YYYY-MM-DD'),'ends_on',to_char(l.ends_on,'YYYY-MM-DD'),
  'start_time',to_char(l.start_time,'HH24:MI'),'end_time',to_char(l.end_time,'HH24:MI'),'version',l.version,'created_at',l.created_at,'updated_at',l.updated_at,
  'rule',erp_pricing.rule_text(l),'products',(select count(*) from erp_pricing.price_list_item i where i.list_id=l.id)::integer,
  'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',c.contact_id,'name',r.name) order by erp_catalog.fold(r.name),c.contact_id)
   from erp_pricing.price_list_contact c join erp_catalog.record r on r.id=c.contact_id where c.list_id=l.id),'[]'::jsonb),
  'regions',coalesce((select jsonb_agg(g.state order by g.state) from erp_pricing.price_list_region g where g.list_id=l.id),'[]'::jsonb))
 from erp_pricing.price_list l where l.id=p_id
$$;
create function erp_pricing.require(p_user_id uuid,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin perform erp_catalog.require_access(p_user_id,'products',p_write); end $$;
-- Mesmo protocolo dos cadastros: trava do comando, replay pelo mesmo corpo, recusa de outro corpo com o mesmo id.
create function erp_pricing.replay(p_user_id uuid,p_command_id uuid,p_hash text) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v erp_pricing.command%rowtype;
begin
 if p_command_id is null then raise exception 'erp_pricing_invalid_command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852910,hashtext(p_command_id::text));
 select * into v from erp_pricing.command where command_id=p_command_id;
 if not found then return null; end if;
 if v.actor<>p_user_id or v.request_hash<>p_hash then raise exception 'erp_pricing_command_conflict' using errcode='40001'; end if;
 return v.result||'{"replayed":true}'::jsonb;
end $$;
create function erp_pricing.hash(p_value jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(p_value::text,'UTF8')),'hex') $$;

create function public.erp_pricing_lists(p_user_id uuid,p_list_type text default null,p_query text default null,p_category text default null,p_product_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[];
begin
 perform erp_pricing.require(p_user_id,false);
 if(p_list_type is not null and p_list_type not in('rates','period','custom')) or(p_category is not null and p_category not in('other','contact','region'))
  or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]')) then raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 return jsonb_build_object('data_mode','erp_native','items',coalesce((select jsonb_agg(erp_pricing.header(l.id)-'contacts'-'regions' order by erp_catalog.fold(l.name),l.id)
  from erp_pricing.price_list l where(p_list_type is null or l.list_type=p_list_type) and(p_category is null or l.category=p_category)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(l.name),'',''))
   and(p_product_id is null or exists(select 1 from erp_pricing.price_list_item i where i.list_id=l.id and i.product_id=p_product_id))
  ),'[]'::jsonb));
end $$;

-- Detalhe: cabeçalho, vínculos e os produtos (100 por vez), com o preço de venda do produto e o preço da lista.
create function public.erp_pricing_list_get(p_user_id uuid,p_id uuid,p_query text default null,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_list erp_pricing.price_list%rowtype; v_terms text[]; v_total integer; v_items jsonb;
begin
 perform erp_pricing.require(p_user_id,false);
 if p_offset is null or p_offset not between 0 and 1000000 or p_limit is null or p_limit not between 1 and 100
  or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]')) then raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 select * into v_list from erp_pricing.price_list where id=p_id;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 with f as materialized(select i.product_id,i.custom_price,r.name,r.code,p.gtin,p.price from erp_pricing.price_list_item i
   join erp_catalog.record r on r.id=i.product_id join erp_catalog.product p on p.record_id=i.product_id
   where i.list_id=p_id and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),'','')))
 select(select count(*) from f)::integer,coalesce((select jsonb_agg(jsonb_build_object('product_id',x.product_id,'name',x.name,'code',x.code,'gtin',x.gtin,
   'product_price',erp_catalog.unit_price_numeric(x.price,14),'custom_price',erp_catalog.unit_price_numeric(x.custom_price,14),
   'list_price',(erp_pricing.list_price(v_list,x.price,x.custom_price))::numeric(18,2)::text) order by erp_catalog.fold(x.name),x.product_id)
  from(select * from f order by erp_catalog.fold(name),product_id offset p_offset limit p_limit) x),'[]'::jsonb) into v_total,v_items;
 return jsonb_build_object('data_mode','erp_native','list',erp_pricing.header(p_id),'items',v_items,'total',v_total,'offset',p_offset,'limit',p_limit);
end $$;

-- Dados gerais: nome único, categoria, tipo, fator, acréscimo/desconto, validade e vínculos (até 30 contatos; UFs).
create function public.erp_pricing_list_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_new erp_pricing.price_list%rowtype; v_id uuid; v_before jsonb; v_result jsonb;
 v_contacts uuid[]; v_regions text[]; v_changed boolean;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_data is null or jsonb_typeof(p_data)<>'object' or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','category','list_type','factor','factor_unit','direction','considers_datetime','starts_on','ends_on','start_time','end_time','contacts','regions'))
  or jsonb_typeof(p_data->'name') is distinct from 'string' or jsonb_typeof(p_data->'considers_datetime') is distinct from 'boolean'
  or jsonb_typeof(p_data->'contacts') is distinct from 'array' or jsonb_array_length(p_data->'contacts')>30 or jsonb_typeof(p_data->'regions') is distinct from 'array'
  or(p_data->>'factor' is not null and p_data->>'factor'!~'^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$')
  or(p_data->>'starts_on' is not null and p_data->>'starts_on'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') or(p_data->>'ends_on' is not null and p_data->>'ends_on'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  or(p_data->>'start_time' is not null and p_data->>'start_time'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') or(p_data->>'end_time' is not null and p_data->>'end_time'!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_new.name:=btrim(p_data->>'name'); v_new.category:=p_data->>'category'; v_new.list_type:=p_data->>'list_type'; v_new.factor:=(p_data->>'factor')::numeric;
 v_new.factor_unit:=p_data->>'factor_unit'; v_new.direction:=p_data->>'direction'; v_new.considers_datetime:=(p_data->>'considers_datetime')::boolean;
 begin
  v_new.starts_on:=(p_data->>'starts_on')::date; v_new.ends_on:=(p_data->>'ends_on')::date; v_new.start_time:=(p_data->>'start_time')::time; v_new.end_time:=(p_data->>'end_time')::time;
 exception when others then raise exception 'erp_pricing_invalid_data' using errcode='22023'; end;
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(c)),'{}') into v_contacts from jsonb_array_elements(p_data->'contacts') c;
 select coalesce(array_agg(distinct g#>>'{}' order by g#>>'{}'),'{}') into v_regions from jsonb_array_elements(p_data->'regions') g where jsonb_typeof(g)='string';
 if v_new.name='' or length(v_new.name)>120 or v_new.name~'[[:cntrl:]]' or v_new.category not in('other','contact','region') or v_new.category is null
  or v_new.list_type not in('rates','period','custom') or v_new.list_type is null or v_new.factor_unit not in('percent','amount') or v_new.factor_unit is null
  or v_new.direction not in('increase','discount') or v_new.direction is null or(v_new.list_type<>'custom' and(v_new.factor is null or v_new.factor<=0))
  or(v_new.factor_unit='percent' and v_new.direction='discount' and v_new.factor>100)
  or cardinality(v_contacts)<>jsonb_array_length(p_data->'contacts') or cardinality(v_regions)<>jsonb_array_length(p_data->'regions')
  or(v_new.category<>'contact' and cardinality(v_contacts)>0) or(v_new.category<>'region' and cardinality(v_regions)>0)
  or exists(select 1 from unnest(v_regions) s where s not in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'))
  or exists(select 1 from unnest(v_contacts) c where not exists(select 1 from erp_catalog.contact where record_id=c))
  or(v_new.starts_on is not null and v_new.starts_on not between date '1900-01-01' and date '2100-12-31') or(v_new.ends_on is not null and v_new.ends_on not between date '1900-01-01' and date '2100-12-31')
  or v_new.starts_on>v_new.ends_on or(not v_new.considers_datetime and(v_new.start_time is not null or v_new.end_time is not null))
  or(v_new.list_type='period' and v_new.starts_on is null and v_new.ends_on is null)
  or(v_new.considers_datetime and v_new.starts_on=v_new.ends_on and v_new.start_time>v_new.end_time) then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_hash:=erp_pricing.hash(jsonb_build_object('actor',p_user_id,'action','save','id',p_id,'version',p_expected_version,'data',p_data));
 v_replay:=erp_pricing.replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(174852911,0);
 if exists(select 1 from erp_pricing.price_list where erp_catalog.fold(name)=erp_catalog.fold(v_new.name) and id is distinct from p_id) then
  return jsonb_build_object('saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native'); end if;
 if p_id is null then
  if(select count(*) from erp_pricing.price_list)>=1000 then raise exception 'erp_pricing_limit' using errcode='22023'; end if;
  insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction,considers_datetime,starts_on,ends_on,start_time,end_time,created_by,updated_by)
   values(v_new.name,v_new.category,v_new.list_type,v_new.factor,v_new.factor_unit,v_new.direction,v_new.considers_datetime,v_new.starts_on,v_new.ends_on,v_new.start_time,v_new.end_time,p_user_id,p_user_id) returning id into v_id;
  v_changed:=true;
 else
  select * into v_row from erp_pricing.price_list where id=p_id for update;
  if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_pricing_version_conflict' using errcode='40001'; end if;
  -- The type is chosen when the list is included (as in Origin); custom prices never fall under a rates or period rule.
  if v_new.list_type<>v_row.list_type then raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
  v_id:=p_id; v_before:=erp_pricing.header(v_id);
  update erp_pricing.price_list set name=v_new.name,category=v_new.category,list_type=v_new.list_type,factor=v_new.factor,factor_unit=v_new.factor_unit,direction=v_new.direction,
   considers_datetime=v_new.considers_datetime,starts_on=v_new.starts_on,ends_on=v_new.ends_on,start_time=v_new.start_time,end_time=v_new.end_time where id=v_id;
  delete from erp_pricing.price_list_contact where list_id=v_id; delete from erp_pricing.price_list_region where list_id=v_id;
 end if;
 insert into erp_pricing.price_list_contact(list_id,contact_id) select v_id,c from unnest(v_contacts) c;
 insert into erp_pricing.price_list_region(list_id,state) select v_id,s from unnest(v_regions) s;
 if p_id is not null then
  v_changed:=(erp_pricing.header(v_id)-'version'-'updated_at') is distinct from(v_before-'version'-'updated_at');
  if v_changed then
   if v_row.version=2147483647 then raise exception 'erp_pricing_version_exhausted' using errcode='40001'; end if;
   update erp_pricing.price_list set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  end if;
 end if;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(v_id),'replayed',false,'data_mode','erp_native');
 if v_changed then insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,case when p_id is null then 'create' else 'update' end,v_before,v_result->'list'); end if;
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Produtos da lista: incluir, retirar, preço customizado por produto e o reajuste em massa da lista customizada
-- (Acrescer, Descontar ou Fixar, em R$ ou %, para todos os produtos ou só os escolhidos). Uma versão nova por comando.
create function public.erp_pricing_list_items(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_change jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_add uuid[]; v_remove uuid[]; v_prices jsonb; v_adjust jsonb; v_target uuid[];
 v_value numeric; v_count integer; v_result jsonb; v_before integer;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_change is null or jsonb_typeof(p_change)<>'object' or p_expected_version is null or p_expected_version not between 1 and 2147483647 or p_id is null
  or exists(select 1 from jsonb_object_keys(p_change) k where k not in('add','remove','prices','adjust'))
  or jsonb_typeof(coalesce(p_change->'add','[]'))<>'array' or jsonb_typeof(coalesce(p_change->'remove','[]'))<>'array' or jsonb_typeof(coalesce(p_change->'prices','[]'))<>'array'
  or jsonb_array_length(coalesce(p_change->'add','[]'))+jsonb_array_length(coalesce(p_change->'remove','[]'))+jsonb_array_length(coalesce(p_change->'prices','[]'))>500 then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(a)),'{}') into v_add from jsonb_array_elements(coalesce(p_change->'add','[]')) a;
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(a)),'{}') into v_remove from jsonb_array_elements(coalesce(p_change->'remove','[]')) a;
 v_prices:=coalesce(p_change->'prices','[]'); v_adjust:=p_change->'adjust';
 if exists(select 1 from jsonb_array_elements(v_prices) x where jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in('product_id','custom_price'))
   or erp_catalog.detail_uuid(x->'product_id') is null or jsonb_typeof(x->'custom_price') not in('string','null'))
  or(v_adjust is not null and(jsonb_typeof(v_adjust)<>'object' or exists(select 1 from jsonb_object_keys(v_adjust) k where k not in('action','unit','value','products'))
   or coalesce(v_adjust->>'action','') not in('increase','discount','fix') or coalesce(v_adjust->>'unit','') not in('amount','percent') or coalesce(v_adjust->>'value','')!~'^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$'
   or(v_adjust->>'action'='fix' and v_adjust->>'unit'<>'amount') or(v_adjust->>'action'='discount' and v_adjust->>'unit'='percent' and(v_adjust->>'value')::numeric>100)
   or(v_adjust?'products' and jsonb_typeof(v_adjust->'products')<>'array'))) then
  raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_hash:=erp_pricing.hash(jsonb_build_object('actor',p_user_id,'action','items','id',p_id,'version',p_expected_version,'change',p_change));
 v_replay:=erp_pricing.replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_pricing.price_list where id=p_id for update;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_pricing_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from unnest(v_add) a where not exists(select 1 from erp_catalog.product where record_id=a)
   or exists(select 1 from erp_catalog.product_detail d where d.record_id=a and d.deleted_at is not null))
  or((jsonb_array_length(v_prices)>0 or v_adjust is not null) and v_row.list_type<>'custom') then raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_before:=(select count(*) from erp_pricing.price_list_item where list_id=p_id);
 if v_before+cardinality(v_add)>15000 then raise exception 'erp_pricing_item_limit' using errcode='22023'; end if;
 insert into erp_pricing.price_list_item(list_id,product_id) select p_id,a from unnest(v_add) a on conflict do nothing;
 delete from erp_pricing.price_list_item where list_id=p_id and product_id=any(v_remove);
 update erp_pricing.price_list_item i set custom_price=case when x->>'custom_price' is null then null else erp_catalog.unit_price(x->'custom_price',14)::numeric end
  from jsonb_array_elements(v_prices) x where i.list_id=p_id and i.product_id=(x->>'product_id')::uuid;
 if v_adjust is not null then
  v_value:=(v_adjust->>'value')::numeric;
  if jsonb_typeof(v_adjust->'products')='array' then select coalesce(array_agg(erp_catalog.detail_uuid(a)),'{}') into v_target from jsonb_array_elements(v_adjust->'products') a; end if;
  update erp_pricing.price_list_item i set custom_price=greatest(0,round(case v_adjust->>'action' when 'fix' then v_value
    else case v_adjust->>'unit' when 'percent' then coalesce(i.custom_price,p.price,0)*(1+(case v_adjust->>'action' when 'increase' then 1 else -1 end)*v_value/100)
     else coalesce(i.custom_price,p.price,0)+(case v_adjust->>'action' when 'increase' then 1 else -1 end)*v_value end end,2))
   from erp_catalog.product p where p.record_id=i.product_id and i.list_id=p_id and(v_target is null or i.product_id=any(v_target));
 end if;
 if v_row.version=2147483647 then raise exception 'erp_pricing_version_exhausted' using errcode='40001'; end if;
 update erp_pricing.price_list set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(p_id),'replayed',false,'data_mode','erp_native');
 insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,case when v_adjust is null then 'items' else 'adjust' end,
  jsonb_build_object('products',v_before),jsonb_build_object('change',p_change,'products',(v_result#>>'{list,products}')::integer));
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

create function public.erp_pricing_list_delete(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_before jsonb; v_result jsonb;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_hash:=erp_pricing.hash(jsonb_build_object('actor',p_user_id,'action','delete','id',p_id,'version',p_expected_version));
 v_replay:=erp_pricing.replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_row from erp_pricing.price_list where id=p_id for update;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_pricing_version_conflict' using errcode='40001'; end if;
 v_before:=erp_pricing.header(p_id);
 delete from erp_pricing.price_list where id=p_id;
 v_result:=jsonb_build_object('deleted',true,'id',p_id,'replayed',false,'data_mode','erp_native');
 insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,'delete',v_before,null);
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Clonar lista: os dados gerais, os vínculos e os produtos com os preços; até 15.000 produtos, como no Origin.
create function public.erp_pricing_list_clone(p_user_id uuid,p_id uuid,p_command_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_id uuid; v_name text:=btrim(p_name); v_result jsonb;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_id is null or v_name is null or v_name='' or length(v_name)>120 or v_name~'[[:cntrl:]]' then raise exception 'erp_pricing_invalid_data' using errcode='22023'; end if;
 v_hash:=erp_pricing.hash(jsonb_build_object('actor',p_user_id,'action','clone','id',p_id,'name',v_name));
 v_replay:=erp_pricing.replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(174852911,0);
 select * into v_row from erp_pricing.price_list where id=p_id for share;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 if(select count(*) from erp_pricing.price_list_item where list_id=p_id)>15000 then
  return jsonb_build_object('saved',false,'reason','too_many_products','replayed',false,'data_mode','erp_native'); end if;
 if exists(select 1 from erp_pricing.price_list where erp_catalog.fold(name)=erp_catalog.fold(v_name)) then
  return jsonb_build_object('saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native'); end if;
 insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction,considers_datetime,starts_on,ends_on,start_time,end_time,created_by,updated_by)
  values(v_name,v_row.category,v_row.list_type,v_row.factor,v_row.factor_unit,v_row.direction,v_row.considers_datetime,v_row.starts_on,v_row.ends_on,v_row.start_time,v_row.end_time,p_user_id,p_user_id) returning id into v_id;
 insert into erp_pricing.price_list_item(list_id,product_id,custom_price) select v_id,product_id,custom_price from erp_pricing.price_list_item where list_id=p_id;
 insert into erp_pricing.price_list_contact(list_id,contact_id) select v_id,contact_id from erp_pricing.price_list_contact where list_id=p_id;
 insert into erp_pricing.price_list_region(list_id,state) select v_id,state from erp_pricing.price_list_region where list_id=p_id;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,'clone',jsonb_build_object('source',p_id),v_result->'list');
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Listas de preço do produto (aba Características): nome, tipo, preço do produto na lista e regra aplicada.
create function public.erp_pricing_product_lists(p_user_id uuid,p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_pricing.require(p_user_id,false);
 if p_product_id is null then raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('data_mode','erp_native','product_id',p_product_id,'items',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'list_type',l.list_type,
   'rule',erp_pricing.rule_text(l),'list_price',(erp_pricing.list_price(l,p.price,i.custom_price))::numeric(18,2)::text) order by erp_catalog.fold(l.name),l.id)
  from erp_pricing.price_list_item i join erp_pricing.price_list l on l.id=i.list_id join erp_catalog.product p on p.record_id=i.product_id where i.product_id=p_product_id),'[]'::jsonb));
end $$;

revoke all on all functions in schema erp_pricing from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_pricing_lists(uuid,text,text,text,uuid)','erp_pricing_list_get(uuid,uuid,text,integer,integer)','erp_pricing_list_save(uuid,uuid,integer,uuid,jsonb)',
  'erp_pricing_list_items(uuid,uuid,integer,uuid,jsonb)','erp_pricing_list_delete(uuid,uuid,integer,uuid)','erp_pricing_list_clone(uuid,uuid,uuid,text)','erp_pricing_product_lists(uuid,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
