-- Cadastros > Listas de preços, onda C: as categorias Vendedor e Forma de pagamento do Origin (até 30 vendedores e 30 formas
-- de pagamento por lista), a lista criada já com os produtos selecionados na listagem de produtos ("Criar lista de preço" com
-- seleção; "Vincular a uma lista" usa a inclusão de itens de 121), o filtro de período (Cadastrada em, datas de São Paulo) e a
-- consulta do preço da lista para um conjunto de produtos (para os documentos, quando eles passarem a usar a lista). A
-- categoria Loja continua fora do escopo. Nada aqui muda preço de produto, documento, estoque ou financeiro. Depende de 121 e 124-127.
begin;

alter table erp_pricing.price_list drop constraint price_list_category_check;
alter table erp_pricing.price_list add constraint price_list_category_check check(category in('other','contact','seller','payment_method','region'));
create table erp_pricing.price_list_seller(
 list_id uuid not null references erp_pricing.price_list(id) on delete cascade,
 seller_id uuid not null references erp_catalog.seller(id), primary key(list_id,seller_id)
);
create table erp_pricing.price_list_payment_method(
 list_id uuid not null references erp_pricing.price_list(id) on delete cascade,
 payment_method_id uuid not null references erp_catalog.payment_method(id), primary key(list_id,payment_method_id)
);
create index erp_pricing_price_list_seller_seller on erp_pricing.price_list_seller(seller_id);
create index erp_pricing_price_list_payment_method_method on erp_pricing.price_list_payment_method(payment_method_id);
do $$ declare t text; begin
 foreach t in array array['price_list_seller','price_list_payment_method'] loop
  execute format('alter table erp_pricing.%I enable row level security',t);
  execute format('revoke all on table erp_pricing.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;

-- Cabeçalho com os novos vínculos (nome do vendedor = nome do contato; forma de pagamento = descrição).
create or replace function erp_pricing.header(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',l.id,'name',l.name,'category',l.category,'list_type',l.list_type,'factor',l.factor::text,'factor_unit',l.factor_unit,
  'direction',l.direction,'considers_datetime',l.considers_datetime,'starts_on',to_char(l.starts_on,'YYYY-MM-DD'),'ends_on',to_char(l.ends_on,'YYYY-MM-DD'),
  'start_time',to_char(l.start_time,'HH24:MI'),'end_time',to_char(l.end_time,'HH24:MI'),'version',l.version,'created_at',l.created_at,'updated_at',l.updated_at,
  'rule',erp_pricing.rule_text(l),'products',(select count(*) from erp_pricing.price_list_item i where i.list_id=l.id)::integer,
  'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',c.contact_id,'name',r.name) order by erp_catalog.fold(r.name),c.contact_id)
   from erp_pricing.price_list_contact c join erp_catalog.record r on r.id=c.contact_id where c.list_id=l.id),'[]'::jsonb),
  'sellers',coalesce((select jsonb_agg(jsonb_build_object('id',s.seller_id,'name',r.name) order by erp_catalog.fold(r.name),s.seller_id)
   from erp_pricing.price_list_seller s join erp_catalog.seller x on x.id=s.seller_id join erp_catalog.record r on r.id=x.contact_id where s.list_id=l.id),'[]'::jsonb),
  'payment_methods',coalesce((select jsonb_agg(jsonb_build_object('id',m.payment_method_id,'name',p.description) order by erp_catalog.fold(p.description),m.payment_method_id)
   from erp_pricing.price_list_payment_method m join erp_catalog.payment_method p on p.id=m.payment_method_id where m.list_id=l.id),'[]'::jsonb),
  'regions',coalesce((select jsonb_agg(g.state order by g.state) from erp_pricing.price_list_region g where g.list_id=l.id),'[]'::jsonb))
 from erp_pricing.price_list l where l.id=p_id
$$;

-- Listagem: as abas, a busca, a categoria (com Vendedor e Forma de pagamento), o produto e o período "Cadastrada em".
drop function public.erp_pricing_lists(uuid,text,text,text,uuid);
create function public.erp_pricing_lists(p_user_id uuid,p_list_type text default null,p_query text default null,p_category text default null,p_product_id uuid default null,
 p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_terms text[];
begin
 perform erp_pricing.require(p_user_id,false);
 if(p_list_type is not null and p_list_type not in('rates','period','custom')) or(p_category is not null and p_category not in('other','contact','seller','payment_method','region'))
  or(p_query is not null and(length(p_query)>120 or p_query~'[[:cntrl:]]'))
  or(p_from is not null and(not isfinite(p_from) or p_from not between date '1900-01-01' and date '2100-12-31'))
  or(p_to is not null and(not isfinite(p_to) or p_to not between date '1900-01-01' and date '2100-12-31')) or p_from>p_to then
  raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 v_terms:=erp_catalog.search_terms(p_query);
 return jsonb_build_object('data_mode','erp_native','items',coalesce((select jsonb_agg(erp_pricing.header(l.id)-'contacts'-'sellers'-'payment_methods'-'regions' order by erp_catalog.fold(l.name),l.id)
  from erp_pricing.price_list l where(p_list_type is null or l.list_type=p_list_type) and(p_category is null or l.category=p_category)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(l.name),'',''))
   and(p_product_id is null or exists(select 1 from erp_pricing.price_list_item i where i.list_id=l.id and i.product_id=p_product_id))
   and(p_from is null or l.created_at>=p_from::timestamp at time zone 'America/Sao_Paulo')
   and(p_to is null or l.created_at<(p_to+1)::timestamp at time zone 'America/Sao_Paulo')
  ),'[]'::jsonb));
end $$;

-- Dados gerais (121) com os vínculos de Vendedor e Forma de pagamento e, só na inclusão, os produtos da seleção (add_products,
-- até 500, nenhum excluído). Os corpos de 121 continuam valendo (as chaves novas são opcionais).
create or replace function public.erp_pricing_list_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_row erp_pricing.price_list%rowtype; v_new erp_pricing.price_list%rowtype; v_id uuid; v_before jsonb; v_result jsonb;
 v_contacts uuid[]; v_regions text[]; v_sellers uuid[]; v_methods uuid[]; v_products uuid[]; v_changed boolean;
begin
 perform erp_pricing.require(p_user_id,true);
 if p_data is null or jsonb_typeof(p_data)<>'object' or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','category','list_type','factor','factor_unit','direction','considers_datetime','starts_on','ends_on','start_time','end_time',
   'contacts','regions','sellers','payment_methods','add_products'))
  or jsonb_typeof(p_data->'name') is distinct from 'string' or jsonb_typeof(p_data->'considers_datetime') is distinct from 'boolean'
  or jsonb_typeof(p_data->'contacts') is distinct from 'array' or jsonb_array_length(p_data->'contacts')>30 or jsonb_typeof(p_data->'regions') is distinct from 'array'
  or jsonb_typeof(coalesce(p_data->'sellers','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_data->'sellers','[]'))>30
  or jsonb_typeof(coalesce(p_data->'payment_methods','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_data->'payment_methods','[]'))>30
  or jsonb_typeof(coalesce(p_data->'add_products','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_data->'add_products','[]'))>500 or(p_id is not null and p_data?'add_products')
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
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(c)),'{}') into v_sellers from jsonb_array_elements(coalesce(p_data->'sellers','[]')) c;
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(c)),'{}') into v_methods from jsonb_array_elements(coalesce(p_data->'payment_methods','[]')) c;
 select coalesce(array_agg(distinct erp_catalog.detail_uuid(c)),'{}') into v_products from jsonb_array_elements(coalesce(p_data->'add_products','[]')) c;
 if v_new.name='' or length(v_new.name)>120 or v_new.name~'[[:cntrl:]]' or v_new.category not in('other','contact','seller','payment_method','region') or v_new.category is null
  or v_new.list_type not in('rates','period','custom') or v_new.list_type is null or v_new.factor_unit not in('percent','amount') or v_new.factor_unit is null
  or v_new.direction not in('increase','discount') or v_new.direction is null or(v_new.list_type<>'custom' and(v_new.factor is null or v_new.factor<=0))
  or(v_new.factor_unit='percent' and v_new.direction='discount' and v_new.factor>100)
  or cardinality(v_contacts)<>jsonb_array_length(p_data->'contacts') or cardinality(v_regions)<>jsonb_array_length(p_data->'regions')
  or cardinality(v_sellers)<>jsonb_array_length(coalesce(p_data->'sellers','[]')) or cardinality(v_methods)<>jsonb_array_length(coalesce(p_data->'payment_methods','[]'))
  or cardinality(v_products)<>jsonb_array_length(coalesce(p_data->'add_products','[]'))
  or(v_new.category<>'contact' and cardinality(v_contacts)>0) or(v_new.category<>'region' and cardinality(v_regions)>0)
  or(v_new.category<>'seller' and cardinality(v_sellers)>0) or(v_new.category<>'payment_method' and cardinality(v_methods)>0)
  or exists(select 1 from unnest(v_regions) s where s not in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'))
  or exists(select 1 from unnest(v_contacts) c where not exists(select 1 from erp_catalog.contact where record_id=c))
  or exists(select 1 from unnest(v_sellers) s where not exists(select 1 from erp_catalog.seller where id=s))
  or exists(select 1 from unnest(v_methods) m where not exists(select 1 from erp_catalog.payment_method where id=m))
  or exists(select 1 from unnest(v_products) a where not exists(select 1 from erp_catalog.product where record_id=a)
   or exists(select 1 from erp_catalog.product_detail d where d.record_id=a and d.deleted_at is not null))
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
  insert into erp_pricing.price_list_item(list_id,product_id) select v_id,a from unnest(v_products) a;
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
  delete from erp_pricing.price_list_seller where list_id=v_id; delete from erp_pricing.price_list_payment_method where list_id=v_id;
 end if;
 insert into erp_pricing.price_list_contact(list_id,contact_id) select v_id,c from unnest(v_contacts) c;
 insert into erp_pricing.price_list_region(list_id,state) select v_id,s from unnest(v_regions) s;
 insert into erp_pricing.price_list_seller(list_id,seller_id) select v_id,s from unnest(v_sellers) s;
 insert into erp_pricing.price_list_payment_method(list_id,payment_method_id) select v_id,m from unnest(v_methods) m;
 if p_id is not null then
  v_changed:=(erp_pricing.header(v_id)-'version'-'updated_at') is distinct from(v_before-'version'-'updated_at');
  if v_changed then
   if v_row.version=2147483647 then raise exception 'erp_pricing_version_exhausted' using errcode='40001'; end if;
   update erp_pricing.price_list set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  end if;
 end if;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(v_id),'replayed',false,'data_mode','erp_native');
 if v_changed then insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,case when p_id is null then 'create' else 'update' end,v_before,
  v_result->'list'||case when cardinality(v_products)>0 then jsonb_build_object('added_products',cardinality(v_products)) else '{}'::jsonb end); end if;
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Clonar lista: também copia os vendedores e as formas de pagamento vinculados.
create or replace function public.erp_pricing_list_clone(p_user_id uuid,p_id uuid,p_command_id uuid,p_name text)
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
 insert into erp_pricing.price_list_seller(list_id,seller_id) select v_id,seller_id from erp_pricing.price_list_seller where list_id=p_id;
 insert into erp_pricing.price_list_payment_method(list_id,payment_method_id) select v_id,payment_method_id from erp_pricing.price_list_payment_method where list_id=p_id;
 v_result:=jsonb_build_object('saved',true,'list',erp_pricing.header(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_pricing.audit(actor,command_id,list_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,'clone',jsonb_build_object('source',p_id),v_result->'list');
 insert into erp_pricing.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Preço da lista para um conjunto de produtos (até 100), com a vigência no horário de São Paulo: produto fora da lista sai
-- sem preço. É a consulta que os pedidos e as propostas usarão para a coluna "Preço lista"; só leitura.
create function erp_pricing.valid_now(p_list erp_pricing.price_list) returns boolean
language sql stable set search_path=pg_catalog as $$
 select (p_list.starts_on is null or p_list.starts_on<=(clock_timestamp() at time zone 'America/Sao_Paulo')::date)
  and(p_list.ends_on is null or p_list.ends_on>=(clock_timestamp() at time zone 'America/Sao_Paulo')::date)
  and(not p_list.considers_datetime or(
   (p_list.start_time is null or p_list.starts_on is null or (clock_timestamp() at time zone 'America/Sao_Paulo')>=(p_list.starts_on+p_list.start_time))
   and(p_list.end_time is null or p_list.ends_on is null or (clock_timestamp() at time zone 'America/Sao_Paulo')<=(p_list.ends_on+p_list.end_time))))
$$;
create function public.erp_pricing_list_prices(p_user_id uuid,p_id uuid,p_product_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_list erp_pricing.price_list%rowtype;
begin
 perform erp_pricing.require(p_user_id,false);
 if p_id is null or p_product_ids is null or cardinality(p_product_ids) not between 1 and 100 or array_position(p_product_ids,null) is not null
  or(select count(distinct x) from unnest(p_product_ids) x)<>cardinality(p_product_ids) then raise exception 'erp_pricing_invalid_query' using errcode='22023'; end if;
 select * into v_list from erp_pricing.price_list where id=p_id;
 if not found then raise exception 'erp_pricing_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('data_mode','erp_native','list',jsonb_build_object('id',v_list.id,'name',v_list.name,'list_type',v_list.list_type,'rule',erp_pricing.rule_text(v_list),
   'valid_now',erp_pricing.valid_now(v_list),'version',v_list.version),
  'items',(select coalesce(jsonb_agg(jsonb_build_object('product_id',u.id,'in_list',i.product_id is not null,
    'list_price',case when i.product_id is null then null else(erp_pricing.list_price(v_list,p.price,i.custom_price))::numeric(18,2)::text end) order by u.n),'[]'::jsonb)
   from unnest(p_product_ids) with ordinality u(id,n) join erp_catalog.product p on p.record_id=u.id
   left join erp_pricing.price_list_item i on i.list_id=v_list.id and i.product_id=u.id));
end $$;

revoke all on all functions in schema erp_pricing from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_pricing_lists(uuid,text,text,text,uuid,date,date)','erp_pricing_list_save(uuid,uuid,integer,uuid,jsonb)','erp_pricing_list_clone(uuid,uuid,uuid,text)',
  'erp_pricing_list_prices(uuid,uuid,uuid[])'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
