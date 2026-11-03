-- Cadastro de produtos no padrão do Origin, parte 1: categorias de produtos, grupos de produtos, tags e grupos de tags,
-- e os dados completos do formulário (Características, Imagens externas, Estoque, Fornecedores e Tributação) num
-- detalhe próprio do produto, gravado no mesmo comando, versão e auditoria do cadastro.
--
-- Nada aqui altera as funções comuns do catálogo (data, dto, validate_data, write_fields, mutate, save_checked):
-- o detalhe fica fora de erp_catalog.dto(), que continua sendo o retrato do produto copiado para os itens dos
-- documentos. Não gera estoque, saldo financeiro, imposto, XML nem escrita no Origin. Depende de 006/023/057/096.
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Categorias de produtos, grupos de produtos, grupos de tags e tags: uma tabela, quatro tipos.
-- O pai é fixado na inclusão (subcategoria/subgrupo, ou o grupo da tag) e não muda depois, então não há ciclos.
create table erp_catalog.taxonomy(
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in('categories','product_groups','tag_groups','tags')),
 parent_id uuid,
 name text not null check(length(name) between 1 and 100 and name=btrim(name) and name!~'[[:cntrl:]]'),
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(id,kind),
 foreign key(parent_id) references erp_catalog.taxonomy(id),
 check(parent_id is distinct from id),
 check(kind<>'tag_groups' or parent_id is null)
);
create unique index erp_catalog_taxonomy_name on erp_catalog.taxonomy(kind,coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),erp_catalog.fold(name));
create index erp_catalog_taxonomy_parent on erp_catalog.taxonomy(parent_id) where parent_id is not null;
create table erp_catalog.taxonomy_audit(
 id bigint generated always as identity primary key,
 actor uuid not null references auth.users(id), command_id uuid not null,
 kind text not null, item_id uuid not null, action text not null check(action in('create','update','delete')),
 before_data jsonb, after_data jsonb,
 created_at timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Detalhe do produto (1:1) e listas gravadas com o produto.
create table erp_catalog.product_detail(
 record_id uuid primary key references erp_catalog.product(record_id),
 expiry_date date check(expiry_date between date '1900-01-01' and date '2100-12-31'),
 free_shipping boolean,
 discreet_description text check(length(discreet_description)<=120),
 complementary_description text check(length(complementary_description)<=4000),
 external_link text check(length(external_link)<=120),
 video_url text check(length(video_url)<=100),
 notes text check(length(notes)<=2000),
 crossdocking_days integer check(crossdocking_days between 0 and 9999),
 category_id uuid, category_kind text not null default 'categories' check(category_kind='categories'),
 product_group_id uuid, product_group_kind text not null default 'product_groups' check(product_group_kind='product_groups'),
 fci_number text check(fci_number~'^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'),
 item_type text check(item_type in('00','01','02','03','04','05','06','07','08','09','10','99')),
 tax_percent numeric(7,4) check(tax_percent between 0 and 100),
 icms_st_retention_base numeric(15,2) check(icms_st_retention_base>=0),
 icms_st_retention_value numeric(15,2) check(icms_st_retention_value>=0),
 icms_own_substitute_value numeric(15,2) check(icms_own_substitute_value>=0),
 ipi_tipi_exception text check(ipi_tipi_exception~'^[0-9]{1,3}$'),
 ipi_framework_class text check(ipi_framework_class~'^[0-9]{3}$'),
 ipi_fixed_value numeric(15,4) check(ipi_fixed_value>=0),
 ipi_seal_code text check(length(ipi_seal_code)<=60 and ipi_seal_code~'^[0-9A-Za-z./-]+$'),
 pis_fixed_value numeric(15,4) check(pis_fixed_value>=0),
 cofins_fixed_value numeric(15,4) check(cofins_fixed_value>=0),
 anp_code text check(anp_code~'^[0-9]{9}$'),
 anp_description text check(length(anp_description)<=95),
 glp_percent numeric(7,4) check(glp_percent between 0 and 100),
 glgnn_percent numeric(7,4) check(glgnn_percent between 0 and 100),
 glgni_percent numeric(7,4) check(glgni_percent between 0 and 100),
 starting_value numeric(15,2) check(starting_value>=0),
 deleted_at timestamptz, deleted_by uuid references auth.users(id),
 check((deleted_at is null)=(deleted_by is null)),
 foreign key(category_id,category_kind) references erp_catalog.taxonomy(id,kind),
 foreign key(product_group_id,product_group_kind) references erp_catalog.taxonomy(id,kind)
);
create index erp_catalog_product_detail_category on erp_catalog.product_detail(category_id) where category_id is not null;
create index erp_catalog_product_detail_group on erp_catalog.product_detail(product_group_id) where product_group_id is not null;
create index erp_catalog_product_detail_deleted on erp_catalog.product_detail(record_id) where deleted_at is not null;
create index erp_catalog_product_detail_expiry on erp_catalog.product_detail(expiry_date) where expiry_date is not null;
create table erp_catalog.product_dun(
 record_id uuid not null references erp_catalog.product(record_id), position integer not null check(position between 1 and 10),
 code text not null check(code~'^[0-9]{14}$'), quantity numeric(18,6) not null check(quantity>0),
 primary key(record_id,position), unique(record_id,code)
);
create table erp_catalog.product_supplier(
 record_id uuid not null references erp_catalog.product(record_id), position integer not null check(position between 1 and 20),
 supplier_id uuid not null references erp_catalog.contact(record_id),
 description text check(length(description)<=120), code text check(length(code)<=60),
 purchase_price numeric check(purchase_price is null or(purchase_price>=0 and purchase_price<100000000000000 and purchase_price=trunc(purchase_price,10))),
 cost_price numeric check(cost_price is null or(cost_price>=0 and cost_price<100000000000000 and cost_price=trunc(cost_price,10))),
 warranty_months integer check(warranty_months between 0 and 999),
 is_default boolean not null default false,
 primary key(record_id,position), unique(record_id,supplier_id)
);
create unique index erp_catalog_product_supplier_default on erp_catalog.product_supplier(record_id) where is_default;
create index erp_catalog_product_supplier_contact on erp_catalog.product_supplier(supplier_id);
create table erp_catalog.product_tag(
 record_id uuid not null references erp_catalog.product(record_id),
 tag_id uuid not null, tag_kind text not null default 'tags' check(tag_kind='tags'),
 primary key(record_id,tag_id), foreign key(tag_id,tag_kind) references erp_catalog.taxonomy(id,kind)
);
create index erp_catalog_product_tag_tag on erp_catalog.product_tag(tag_id);
create table erp_catalog.product_image(
 record_id uuid not null references erp_catalog.product(record_id), position integer not null check(position between 1 and 20),
 kind text not null default 'external' check(kind='external'),
 url text not null check(length(url) between 9 and 1000 and url~'^https://[^[:space:][:cntrl:]]+$'),
 primary key(record_id,position), unique(record_id,url)
);

do $$ declare t text; begin
 foreach t in array array['taxonomy','taxonomy_audit','product_detail','product_dun','product_supplier','product_tag','product_image'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on table erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke all on all sequences in schema erp_catalog from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Tipos de taxonomia: nome máximo, tipo do pai e limite de registros por tipo.
create function erp_catalog.taxonomy_spec(p_kind text) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case p_kind
  when 'categories' then '{"name":50,"parent":"categories"}'::jsonb
  when 'product_groups' then '{"name":100,"parent":"product_groups"}'::jsonb
  when 'tag_groups' then '{"name":60,"parent":null}'::jsonb
  when 'tags' then '{"name":60,"parent":"tag_groups"}'::jsonb end
$$;
create function erp_catalog.taxonomy_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id,'kind',t.kind,'parent_id',t.parent_id,'name',t.name,'version',t.version,
  'created_at',t.created_at,'updated_at',t.updated_at,
  'children',(select count(*) from erp_catalog.taxonomy c where c.parent_id=t.id)::integer,
  'products',case t.kind
   when 'categories' then (select count(*) from erp_catalog.product_detail d where d.category_id=t.id)
   when 'product_groups' then (select count(*) from erp_catalog.product_detail d where d.product_group_id=t.id)
   when 'tags' then (select count(*) from erp_catalog.product_tag x where x.tag_id=t.id) else 0 end::integer)
 from erp_catalog.taxonomy t where t.id=p_id
$$;

create function public.erp_catalog_taxonomy_list(p_user_id uuid,p_kind text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if erp_catalog.taxonomy_spec(p_kind) is null then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('kind',p_kind,'data_mode','erp_native','items',coalesce((select jsonb_agg(erp_catalog.taxonomy_item(t.id) order by erp_catalog.fold(t.name),t.id)
  from erp_catalog.taxonomy t where t.kind=p_kind),'[]'::jsonb));
end $$;


-- Ao excluir uma categoria ou uma tag, os produtos que a usavam mudam: nova versão, edição humana e auditoria,
-- como numa gravação do formulário. Os registros são travados em ordem de UUID.
create function erp_catalog.taxonomy_detach(p_user_id uuid,p_command_id uuid,p_item erp_catalog.taxonomy) returns integer
language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_before jsonb; v_count integer:=0;
begin
 for v_id in select r.id from erp_catalog.record r where r.entity='products' and(
   (p_item.kind='categories' and exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.category_id=p_item.id))
   or(p_item.kind='tags' and exists(select 1 from erp_catalog.product_tag x where x.record_id=r.id and x.tag_id=p_item.id)))
  order by r.id for update of r loop
  if(select version from erp_catalog.record where id=v_id)=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_before:=erp_catalog.product_full(v_id);
  perform set_config('erp_catalog.product_lifecycle','on',true);
  -- Only the link to this item is removed: a product saved meanwhile with another category keeps it (no lost update).
  if p_item.kind='categories' then update erp_catalog.product_detail set category_id=null where record_id=v_id and category_id=p_item.id;
  else delete from erp_catalog.product_tag where record_id=v_id and tag_id=p_item.id; end if;
  if not found then perform set_config('erp_catalog.product_lifecycle','',true); continue; end if;
  update erp_catalog.record set version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_id;
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'products',v_id,case when p_item.kind='categories' then 'category_removed' else 'tag_removed' end,v_before,erp_catalog.product_full(v_id));
  perform set_config('erp_catalog.product_lifecycle','',true);
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;

-- Inclusão e edição: nome obrigatório e único no mesmo pai (sem acento e sem diferenciar maiúsculas). Nome repetido não
-- é gravado nem registrado como comando: a resposta diz o motivo e um novo envio (outro comando) pode tentar de novo.
create function public.erp_catalog_taxonomy_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_spec jsonb:=erp_catalog.taxonomy_spec(p_kind); v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype;
 v_name text; v_parent uuid; v_parent_kind text; v_id uuid; v_before jsonb; v_result jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if v_spec is null or p_command_id is null or p_expected_version is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','parent_id'))
  or jsonb_typeof(p_data->'name') is distinct from 'string'
  or(p_data?'parent_id' and jsonb_typeof(p_data->'parent_id') not in('string','null'))
  or(p_data->>'parent_id' is not null and p_data->>'parent_id'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_name:=btrim(p_data->>'name'); v_parent:=(p_data->>'parent_id')::uuid;
 if v_name='' or length(v_name)>(v_spec->>'name')::integer or v_name~'[[:cntrl:]]' then raise exception 'erp_catalog_invalid_text' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','taxonomy_save','kind',p_kind,'id',p_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- One writer per kind at a time: the unique name check and the per-kind limit stay exact.
 perform pg_advisory_xact_lock(174852908,hashtext(p_kind));
 if p_id is null then
  if v_parent is not null then
   select kind into v_parent_kind from erp_catalog.taxonomy where id=v_parent for key share;
   if v_parent_kind is distinct from v_spec->>'parent' then raise exception 'erp_catalog_taxonomy_parent_invalid' using errcode='22023'; end if;
  end if;
  if(select count(*) from erp_catalog.taxonomy where kind=p_kind)>=2000 then raise exception 'erp_catalog_taxonomy_limit' using errcode='22023'; end if;
 else
  select * into v_row from erp_catalog.taxonomy where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if p_data?'parent_id' and v_parent is distinct from v_row.parent_id then raise exception 'erp_catalog_taxonomy_parent_fixed' using errcode='22023'; end if;
  v_parent:=v_row.parent_id;
 end if;
 if exists(select 1 from erp_catalog.taxonomy t where t.kind=p_kind and t.parent_id is not distinct from v_parent
   and erp_catalog.fold(t.name)=erp_catalog.fold(v_name) and t.id is distinct from p_id) then
  return jsonb_build_object('kind',p_kind,'saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native');
 end if;
 if p_id is null then
  insert into erp_catalog.taxonomy(kind,parent_id,name,created_by,updated_by) values(p_kind,v_parent,v_name,p_user_id,p_user_id) returning id into v_id;
  insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,v_id,'create',null,erp_catalog.taxonomy_item(v_id));
 else
  v_id:=p_id;
  if v_row.name is distinct from v_name then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   v_before:=erp_catalog.taxonomy_item(v_id);
   update erp_catalog.taxonomy set name=v_name,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
   insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,v_id,'update',v_before,erp_catalog.taxonomy_item(v_id));
  end if;
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'saved',true,'item',erp_catalog.taxonomy_item(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Exclusão. Categoria ou grupo com subníveis e grupo de tags com tags não são excluídos; grupo de produtos em uso também
-- não. Os produtos de uma categoria excluída ficam "Sem categoria" e os de uma tag excluída perdem só essa tag.
create function public.erp_catalog_taxonomy_delete(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype; v_before jsonb; v_result jsonb; v_affected integer:=0;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if erp_catalog.taxonomy_spec(p_kind) is null or p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','taxonomy_delete','kind',p_kind,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852908,hashtext(p_kind));
 select * into v_row from erp_catalog.taxonomy where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_before:=erp_catalog.taxonomy_item(p_id);
 if(v_before->>'children')::integer>0 then
  return jsonb_build_object('kind',p_kind,'id',p_id,'deleted',false,'reason','has_children','replayed',false,'data_mode','erp_native'); end if;
 if p_kind='product_groups' and(v_before->>'products')::integer>0 then
  return jsonb_build_object('kind',p_kind,'id',p_id,'deleted',false,'reason','in_use','replayed',false,'data_mode','erp_native'); end if;
 if p_kind in('categories','tags') then v_affected:=erp_catalog.taxonomy_detach(p_user_id,p_command_id,v_row); end if;
 delete from erp_catalog.taxonomy where id=p_id;
 insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data) values(p_user_id,p_command_id,p_kind,p_id,'delete',v_before,null);
 v_result:=jsonb_build_object('kind',p_kind,'id',p_id,'deleted',true,'products',v_affected,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Campos do detalhe. Texto: limite e se aceita quebra de linha. Decimais: casas inteiras e decimais (strings exatas).
create function erp_catalog.product_detail_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['expiry_date','free_shipping','discreet_description','complementary_description','external_link','video_url','notes',
  'crossdocking_days','category_id','product_group_id','fci_number','item_type','tax_percent','icms_st_retention_base','icms_st_retention_value',
  'icms_own_substitute_value','ipi_tipi_exception','ipi_framework_class','ipi_fixed_value','ipi_seal_code','pis_fixed_value','cofins_fixed_value',
  'anp_code','anp_description','glp_percent','glgnn_percent','glgni_percent','starting_value','dun_codes','suppliers','tag_ids','images']
$$;
create function erp_catalog.detail_decimal(p_value jsonb,p_integers integer,p_scale integer,p_max numeric default null) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_catalog_invalid_decimal' using errcode='22023'; end if;
 v:=p_value#>>'{}';
 if v!~('^(0|[1-9][0-9]{0,'||(p_integers-1)||'})(\.[0-9]{1,'||p_scale||'})?$') or(p_max is not null and v::numeric>p_max) then
  raise exception 'erp_catalog_invalid_decimal' using errcode='22023'; end if;
 return round(v::numeric,p_scale)::text;
end $$;
create function erp_catalog.detail_text(p_value jsonb,p_max integer,p_lines boolean default false) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_catalog_text_required' using errcode='22023'; end if;
 v:=nullif(btrim(p_value#>>'{}'),'');
 if length(v)>p_max or(case when p_lines then translate(v,E'\n\r\t','') else v end)~'[[:cntrl:]]' then
  raise exception 'erp_catalog_invalid_text' using errcode='22023'; end if;
 return v;
end $$;
create function erp_catalog.detail_date(p_value jsonb) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare v text; y integer; m integer; d integer;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 v:=p_value#>>'{}';
 if jsonb_typeof(p_value)<>'string' or v!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'erp_catalog_invalid_date' using errcode='22023'; end if;
 y:=substr(v,1,4)::integer; m:=substr(v,6,2)::integer; d:=substr(v,9,2)::integer;
 if y not between 1900 and 2100 or m not between 1 and 12 or d<1 or d>extract(day from make_date(y,m,1)+interval '1 month'-interval '1 day') then
  raise exception 'erp_catalog_invalid_date' using errcode='22023'; end if;
 return v;
end $$;
create function erp_catalog.detail_uuid(p_value jsonb) returns uuid
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'string' or p_value#>>'{}'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 return (p_value#>>'{}')::uuid;
end $$;

-- Normaliza só as chaves do detalhe que vieram no corpo; a ausência conserva o valor atual. A saída tem o mesmo formato
-- de erp_catalog.product_detail_data(id,false), por isso a comparação das duas diz se algo mudou.
create function erp_catalog.product_detail_validate(p_data jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_pair record; v_result jsonb:='{}'; v_text text; v_list jsonb; v_item jsonb; v_out jsonb; v_seen text[]; v_defaults integer; v_n integer;
begin
 for v_pair in select key,value from jsonb_each(p_data) loop
  case v_pair.key
  when 'expiry_date' then
   v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_date(v_pair.value));
  when 'free_shipping' then
   if jsonb_typeof(v_pair.value) not in('boolean','null') then raise exception 'erp_catalog_invalid_flag' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_pair.value);
  when 'discreet_description' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_text(v_pair.value,120));
  when 'complementary_description' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_text(v_pair.value,4000,true));
  when 'notes' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_text(v_pair.value,2000,true));
  when 'anp_description' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_text(v_pair.value,95));
  when 'external_link','video_url' then
   v_text:=erp_catalog.detail_text(v_pair.value,case when v_pair.key='video_url' then 100 else 120 end);
   if v_text is not null and v_text!~'^https?://[^[:space:]]+$' then raise exception 'erp_catalog_invalid_url' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  when 'crossdocking_days' then
   if v_pair.value<>'null'::jsonb and(jsonb_typeof(v_pair.value)<>'string' or v_pair.value#>>'{}'!~'^(0|[1-9][0-9]{0,3})$') then
    raise exception 'erp_catalog_invalid_count' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,case when v_pair.value='null'::jsonb then null else((v_pair.value#>>'{}')::integer)::text end);
  when 'category_id','product_group_id' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_uuid(v_pair.value));
  when 'fci_number' then
   v_text:=upper(erp_catalog.detail_text(v_pair.value,36));
   if v_text is not null and v_text!~'^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then raise exception 'erp_catalog_invalid_identifier' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  when 'item_type' then
   v_text:=erp_catalog.detail_text(v_pair.value,2);
   if v_text is not null and v_text not in('00','01','02','03','04','05','06','07','08','09','10','99') then raise exception 'erp_catalog_invalid_enum' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  when 'ipi_tipi_exception','ipi_framework_class','anp_code' then
   v_text:=erp_catalog.detail_text(v_pair.value,9);
   if v_text is not null and v_text!~(case v_pair.key when 'ipi_tipi_exception' then '^[0-9]{1,3}$' when 'ipi_framework_class' then '^[0-9]{3}$' else '^[0-9]{9}$' end) then
    raise exception 'erp_catalog_invalid_identifier' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  when 'ipi_seal_code' then
   v_text:=erp_catalog.detail_text(v_pair.value,60);
   if v_text is not null and v_text!~'^[0-9A-Za-z./-]+$' then raise exception 'erp_catalog_invalid_identifier' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_text);
  when 'tax_percent','glp_percent','glgnn_percent','glgni_percent' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_decimal(v_pair.value,3,4,100));
  when 'icms_st_retention_base','icms_st_retention_value','icms_own_substitute_value','starting_value' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_decimal(v_pair.value,13,2));
  when 'ipi_fixed_value','pis_fixed_value','cofins_fixed_value' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_decimal(v_pair.value,11,4));
  when 'dun_codes' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>10 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_list:='[]'; v_seen:=array[]::text[];
   for v_item in select value from jsonb_array_elements(v_pair.value) loop
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in('code','quantity'))
     or jsonb_typeof(v_item->'code') is distinct from 'string' or v_item->>'code'!~'^[0-9]{14}$' or v_item->>'code'=any(v_seen) then
     raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
    v_out:=jsonb_build_object('code',v_item->>'code','quantity',erp_catalog.detail_decimal(v_item->'quantity',12,6));
    if v_out->>'quantity' is null or(v_out->>'quantity')::numeric<=0 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
    v_seen:=v_seen||(v_item->>'code'); v_list:=v_list||jsonb_build_array(v_out);
   end loop;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_list);
  when 'suppliers' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>20 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_list:='[]'; v_seen:=array[]::text[]; v_defaults:=0;
   for v_item in select value from jsonb_array_elements(v_pair.value) loop
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in('supplier_id','description','code','purchase_price','cost_price','warranty_months','is_default'))
     or jsonb_typeof(v_item->'is_default') is distinct from 'boolean' or(v_item?'warranty_months' and v_item->'warranty_months'<>'null'::jsonb
      and(jsonb_typeof(v_item->'warranty_months')<>'string' or v_item->>'warranty_months'!~'^(0|[1-9][0-9]{0,2})$')) then
     raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
    v_out:=jsonb_build_object('supplier_id',erp_catalog.detail_uuid(v_item->'supplier_id'),
     'description',erp_catalog.detail_text(v_item->'description',120),'code',erp_catalog.detail_text(v_item->'code',60),
     'purchase_price',case when coalesce(v_item->'purchase_price','null'::jsonb)='null'::jsonb then null else erp_catalog.unit_price(v_item->'purchase_price',14) end,
     'cost_price',case when coalesce(v_item->'cost_price','null'::jsonb)='null'::jsonb then null else erp_catalog.unit_price(v_item->'cost_price',14) end,
     'warranty_months',case when coalesce(v_item->'warranty_months','null'::jsonb)='null'::jsonb then null else((v_item->>'warranty_months')::integer)::text end,
     'is_default',v_item->'is_default');
    if v_out->>'supplier_id' is null or v_out->>'supplier_id'=any(v_seen) then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
    if(v_item->'is_default')='true'::jsonb then v_defaults:=v_defaults+1; end if;
    v_seen:=v_seen||(v_out->>'supplier_id'); v_list:=v_list||jsonb_build_array(v_out);
   end loop;
   if v_defaults>1 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_list);
  when 'tag_ids' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>50 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   select count(*),count(distinct erp_catalog.detail_uuid(value)) into v_n,v_defaults from jsonb_array_elements(v_pair.value);
   if v_n<>v_defaults then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,(select coalesce(jsonb_agg(u order by u),'[]'::jsonb) from(select erp_catalog.detail_uuid(value)::text u from jsonb_array_elements(v_pair.value)) q));
  when 'images' then
   if jsonb_typeof(v_pair.value)<>'array' or jsonb_array_length(v_pair.value)>20 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_list:='[]'; v_seen:=array[]::text[];
   for v_item in select value from jsonb_array_elements(v_pair.value) loop
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k<>'url') or jsonb_typeof(v_item->'url') is distinct from 'string'
     or length(v_item->>'url') not between 9 and 1000 or v_item->>'url'!~'^https://[^[:space:][:cntrl:]]+$' or v_item->>'url'=any(v_seen) then
     raise exception 'erp_catalog_invalid_url' using errcode='22023'; end if;
    v_seen:=v_seen||(v_item->>'url'); v_list:=v_list||jsonb_build_array(jsonb_build_object('url',v_item->>'url'));
   end loop;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_list);
  else raise exception 'erp_catalog_unknown_field' using errcode='22023';
  end case;
 end loop;
 return v_result;
end $$;

-- Detalhe atual. p_display acrescenta o nome e o código de cada fornecedor (só leitura, fora da comparação).
create function erp_catalog.product_detail_data(p_id uuid,p_display boolean) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('expiry_date',to_char(d.expiry_date,'YYYY-MM-DD'),'free_shipping',d.free_shipping,
  'discreet_description',d.discreet_description,'complementary_description',d.complementary_description,
  'external_link',d.external_link,'video_url',d.video_url,'notes',d.notes,'crossdocking_days',d.crossdocking_days::text,
  'category_id',d.category_id,'product_group_id',d.product_group_id,'fci_number',d.fci_number,'item_type',d.item_type,
  'tax_percent',d.tax_percent::text,'icms_st_retention_base',d.icms_st_retention_base::text,'icms_st_retention_value',d.icms_st_retention_value::text,
  'icms_own_substitute_value',d.icms_own_substitute_value::text,'ipi_tipi_exception',d.ipi_tipi_exception,'ipi_framework_class',d.ipi_framework_class,
  'ipi_fixed_value',d.ipi_fixed_value::text,'ipi_seal_code',d.ipi_seal_code,'pis_fixed_value',d.pis_fixed_value::text,'cofins_fixed_value',d.cofins_fixed_value::text,
  'anp_code',d.anp_code,'anp_description',d.anp_description,'glp_percent',d.glp_percent::text,'glgnn_percent',d.glgnn_percent::text,
  'glgni_percent',d.glgni_percent::text,'starting_value',d.starting_value::text,
  'dun_codes',coalesce((select jsonb_agg(jsonb_build_object('code',x.code,'quantity',x.quantity::text) order by x.position) from erp_catalog.product_dun x where x.record_id=p.record_id),'[]'::jsonb),
  'suppliers',coalesce((select jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'description',s.description,'code',s.code,
     'purchase_price',erp_catalog.unit_price_numeric(s.purchase_price,14),'cost_price',erp_catalog.unit_price_numeric(s.cost_price,14),
     'warranty_months',s.warranty_months::text,'is_default',s.is_default)
    ||case when p_display then(select jsonb_build_object('supplier_name',r.name,'supplier_code',r.code) from erp_catalog.record r where r.id=s.supplier_id) else '{}'::jsonb end
    order by s.position) from erp_catalog.product_supplier s where s.record_id=p.record_id),'[]'::jsonb),
  'tag_ids',coalesce((select jsonb_agg(x.tag_id::text order by x.tag_id::text) from erp_catalog.product_tag x where x.record_id=p.record_id),'[]'::jsonb),
  'images',coalesce((select jsonb_agg(jsonb_build_object('url',x.url) order by x.position) from erp_catalog.product_image x where x.record_id=p.record_id),'[]'::jsonb))
  ||case when p_display then jsonb_build_object('deleted_at',d.deleted_at,
   'cost_price',(select erp_catalog.unit_price_numeric(s.cost_price,14) from erp_catalog.product_supplier s where s.record_id=p.record_id and s.is_default)) else '{}'::jsonb end
 from erp_catalog.product p left join erp_catalog.product_detail d on d.record_id=p.record_id where p.record_id=p_id
$$;

-- Produto inteiro (retrato do catálogo + detalhe), usado na leitura do formulário e na auditoria.
create function erp_catalog.product_full(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select erp_catalog.dto(p_id)||erp_catalog.product_detail_data(p_id,true)
$$;

-- Referências do detalhe: categoria e grupo do tipo certo, tags existentes e fornecedores que são contatos.
create function erp_catalog.product_detail_references(p_detail jsonb) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if(p_detail->>'category_id' is not null and not exists(select 1 from erp_catalog.taxonomy where id=(p_detail->>'category_id')::uuid and kind='categories'))
  or(p_detail->>'product_group_id' is not null and not exists(select 1 from erp_catalog.taxonomy where id=(p_detail->>'product_group_id')::uuid and kind='product_groups'))
  or exists(select 1 from jsonb_array_elements_text(coalesce(p_detail->'tag_ids','[]'::jsonb)) t where not exists(select 1 from erp_catalog.taxonomy where id=t::uuid and kind='tags'))
  or exists(select 1 from jsonb_array_elements(coalesce(p_detail->'suppliers','[]'::jsonb)) s where not exists(select 1 from erp_catalog.contact where record_id=(s->>'supplier_id')::uuid)) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
end $$;

create function erp_catalog.product_detail_write(p_id uuid,p_detail jsonb) returns void
language plpgsql set search_path=pg_catalog as $$
declare d jsonb:=p_detail;
begin
 insert into erp_catalog.product_detail(record_id) values(p_id) on conflict(record_id) do nothing;
 update erp_catalog.product_detail set
  expiry_date=case when d?'expiry_date' then(d->>'expiry_date')::date else expiry_date end,
  free_shipping=case when d?'free_shipping' then(d->>'free_shipping')::boolean else free_shipping end,
  discreet_description=case when d?'discreet_description' then d->>'discreet_description' else discreet_description end,
  complementary_description=case when d?'complementary_description' then d->>'complementary_description' else complementary_description end,
  external_link=case when d?'external_link' then d->>'external_link' else external_link end,
  video_url=case when d?'video_url' then d->>'video_url' else video_url end,
  notes=case when d?'notes' then d->>'notes' else notes end,
  crossdocking_days=case when d?'crossdocking_days' then(d->>'crossdocking_days')::integer else crossdocking_days end,
  category_id=case when d?'category_id' then(d->>'category_id')::uuid else category_id end,
  product_group_id=case when d?'product_group_id' then(d->>'product_group_id')::uuid else product_group_id end,
  fci_number=case when d?'fci_number' then d->>'fci_number' else fci_number end,
  item_type=case when d?'item_type' then d->>'item_type' else item_type end,
  tax_percent=case when d?'tax_percent' then(d->>'tax_percent')::numeric else tax_percent end,
  icms_st_retention_base=case when d?'icms_st_retention_base' then(d->>'icms_st_retention_base')::numeric else icms_st_retention_base end,
  icms_st_retention_value=case when d?'icms_st_retention_value' then(d->>'icms_st_retention_value')::numeric else icms_st_retention_value end,
  icms_own_substitute_value=case when d?'icms_own_substitute_value' then(d->>'icms_own_substitute_value')::numeric else icms_own_substitute_value end,
  ipi_tipi_exception=case when d?'ipi_tipi_exception' then d->>'ipi_tipi_exception' else ipi_tipi_exception end,
  ipi_framework_class=case when d?'ipi_framework_class' then d->>'ipi_framework_class' else ipi_framework_class end,
  ipi_fixed_value=case when d?'ipi_fixed_value' then(d->>'ipi_fixed_value')::numeric else ipi_fixed_value end,
  ipi_seal_code=case when d?'ipi_seal_code' then d->>'ipi_seal_code' else ipi_seal_code end,
  pis_fixed_value=case when d?'pis_fixed_value' then(d->>'pis_fixed_value')::numeric else pis_fixed_value end,
  cofins_fixed_value=case when d?'cofins_fixed_value' then(d->>'cofins_fixed_value')::numeric else cofins_fixed_value end,
  anp_code=case when d?'anp_code' then d->>'anp_code' else anp_code end,
  anp_description=case when d?'anp_description' then d->>'anp_description' else anp_description end,
  glp_percent=case when d?'glp_percent' then(d->>'glp_percent')::numeric else glp_percent end,
  glgnn_percent=case when d?'glgnn_percent' then(d->>'glgnn_percent')::numeric else glgnn_percent end,
  glgni_percent=case when d?'glgni_percent' then(d->>'glgni_percent')::numeric else glgni_percent end,
  starting_value=case when d?'starting_value' then(d->>'starting_value')::numeric else starting_value end
 where record_id=p_id;
 if d?'dun_codes' then
  delete from erp_catalog.product_dun where record_id=p_id;
  insert into erp_catalog.product_dun(record_id,position,code,quantity)
   select p_id,n,x->>'code',(x->>'quantity')::numeric from jsonb_array_elements(d->'dun_codes') with ordinality e(x,n);
 end if;
 if d?'suppliers' then
  delete from erp_catalog.product_supplier where record_id=p_id;
  insert into erp_catalog.product_supplier(record_id,position,supplier_id,description,code,purchase_price,cost_price,warranty_months,is_default)
   select p_id,n,(x->>'supplier_id')::uuid,x->>'description',x->>'code',(x->>'purchase_price')::numeric,(x->>'cost_price')::numeric,
    (x->>'warranty_months')::integer,(x->>'is_default')::boolean from jsonb_array_elements(d->'suppliers') with ordinality e(x,n);
 end if;
 if d?'tag_ids' then
  delete from erp_catalog.product_tag where record_id=p_id;
  insert into erp_catalog.product_tag(record_id,tag_id) select p_id,t::uuid from jsonb_array_elements_text(d->'tag_ids') t;
 end if;
 if d?'images' then
  delete from erp_catalog.product_image where record_id=p_id;
  insert into erp_catalog.product_image(record_id,position,url) select p_id,n,x->>'url' from jsonb_array_elements(d->'images') with ordinality e(x,n);
 end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Leitura do formulário: retrato do catálogo mais o detalhe.
create function public.erp_catalog_product_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_id is null or not exists(select 1 from erp_catalog.record where id=p_id and entity='products') then
  raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('entity','products','record',erp_catalog.product_full(p_id),'data_mode','erp_native');
end $$;

-- Gravação do formulário de produto: campos do catálogo (mesma validação de erp_catalog_save), detalhe, listas e a
-- situação "Ativado" num único comando, com uma nova versão e uma auditoria. Mesma identidade de comando de
-- erp_catalog_save/erp_catalog_save_checked (o replay de um comando antigo devolve o resultado original), mesma ordem de
-- travas (comando, depois registro) e, com p_acknowledged, os mesmos avisos confirmados de erp_catalog_save_checked.
-- Produto excluído não é alterado por esta gravação.
create function public.erp_catalog_product_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_keys text[]:=erp_catalog.product_detail_keys(); v_base jsonb; v_detail jsonb; v_data jsonb; v_hash text; v_command erp_catalog.command%rowtype;
 v_row erp_catalog.record%rowtype; v_id uuid; v_before jsonb; v_result jsonb; v_changed boolean:=false; v_base_changed boolean:=false;
 v_active boolean; v_codes jsonb:='[]'::jsonb; v_current jsonb; v_detail_changed boolean:=false;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_command_id is null or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536
  or(p_data?'active' and jsonb_typeof(p_data->'active')<>'boolean') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if p_acknowledged is not null and(jsonb_typeof(p_acknowledged)<>'array' or jsonb_array_length(p_acknowledged)>2
  or exists(select 1 from jsonb_array_elements(p_acknowledged) a where jsonb_typeof(a)<>'string' or a#>>'{}' not in('duplicate_code','duplicate_gtin'))
  or(select count(distinct a#>>'{}') from jsonb_array_elements(p_acknowledged) a)<>jsonb_array_length(p_acknowledged)) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_base:=(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_data) where key<>'active' and not key=any(v_keys));
 v_detail:=erp_catalog.product_detail_validate((select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_data) where key=any(v_keys)));
 v_data:=case when v_base='{}'::jsonb then '{}'::jsonb else erp_catalog.validate_data('products',v_base,false) end;
 if v_data='{}'::jsonb and v_detail='{}'::jsonb and not p_data?'active' then raise exception 'erp_catalog_empty_patch' using errcode='22023'; end if;
 v_active:=(p_data->>'active')::boolean;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'entity','products','id',p_id,
   'version',p_expected_version,'data',p_data,'set_active',false,'active',null)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- Same lock order as erp_catalog_taxonomy_delete (taxonomy rows, then the product): a save that links a category or tag
 -- waits for a concurrent deletion of it instead of deadlocking with it, and then reports the missing reference.
 perform 1 from erp_catalog.taxonomy t where t.id in(select(v_detail->>'category_id')::uuid union all select(v_detail->>'product_group_id')::uuid
  union all select x::uuid from jsonb_array_elements_text(coalesce(v_detail->'tag_ids','[]'::jsonb)) x) order by t.id for key share;
 if p_id is null then
  -- Preferências > Configurações de produtos > Código do produto "Sequencial": a new product without a code gets the next
  -- number after the largest numeric code, serialized so two inclusions never take the same number.
  if nullif(v_data->>'code','') is null and erp_preferences.get('produtos.codigo')='"sequencial"'::jsonb then
   perform pg_advisory_xact_lock(174852909,0);
   v_data:=v_data||jsonb_build_object('code',(select(coalesce(max(code::numeric),0)+1)::text from erp_catalog.record where entity='products' and code~'^[0-9]{1,18}$'));
  end if;
  perform erp_catalog.validate_product_identifiers(v_data,null);
  v_data:=erp_catalog.validate_data('products',v_data,true);
  perform erp_catalog.product_detail_references(v_detail);
  if p_acknowledged is not null then
   select coalesce(jsonb_agg(w->'code'),'[]'::jsonb) into v_codes from jsonb_array_elements(erp_catalog.warnings('products',null,v_data)) w;
   if exists(select 1 from jsonb_array_elements_text(v_codes) c where not p_acknowledged?c) then
    raise exception 'erp_catalog_warning_unacknowledged' using errcode='40001'; end if;
  end if;
  insert into erp_catalog.record(entity,name,code,active,created_by,updated_by,human_edited)
   values('products',v_data->>'name',v_data->>'code',coalesce(v_active,true),p_user_id,p_user_id,true) returning id into v_id;
  perform erp_catalog.write_fields(v_id,'products',v_data);
  perform erp_catalog.product_detail_write(v_id,v_detail);
  v_changed:=true;
 else
  select * into v_row from erp_catalog.record where id=p_id and entity='products' for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if exists(select 1 from erp_catalog.product_detail where record_id=p_id and deleted_at is not null) then
   raise exception 'erp_catalog_product_deleted' using errcode='40001'; end if;
  if p_acknowledged is not null then
   select coalesce(jsonb_agg(w->'code'),'[]'::jsonb) into v_codes from jsonb_array_elements(erp_catalog.warnings('products',p_id,v_data)) w;
   if exists(select 1 from jsonb_array_elements_text(v_codes) c where not p_acknowledged?c) then
    raise exception 'erp_catalog_warning_unacknowledged' using errcode='40001'; end if;
  end if;
  v_id:=p_id; v_before:=erp_catalog.product_full(v_id);
  if v_data<>'{}'::jsonb then
   perform erp_catalog.validate_product_identifiers(v_data,erp_catalog.data(v_id));
   v_data:=erp_catalog.validate_data('products',erp_catalog.data(v_id)||v_data,true);
   v_base_changed:=v_data is distinct from erp_catalog.data(v_id);
  end if;
  perform erp_catalog.product_detail_references(v_detail);
  v_current:=erp_catalog.product_detail_data(v_id,false);
  v_detail_changed:=(v_current||v_detail) is distinct from v_current;
  v_changed:=v_base_changed or v_detail_changed or(v_active is not null and v_active is distinct from v_row.active);
  if v_changed then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   update erp_catalog.record set name=case when v_base_changed then v_data->>'name' else name end,code=case when v_base_changed then v_data->>'code' else code end,
    active=coalesce(v_active,active),version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
   if v_base_changed then perform erp_catalog.write_fields(v_id,'products',v_data); end if;
   if v_detail<>'{}'::jsonb then perform erp_catalog.product_detail_write(v_id,v_detail); end if;
   update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_id;
  end if;
 end if;
 v_result:=jsonb_build_object('entity','products','record',erp_catalog.product_full(v_id),'replayed',false,'data_mode','erp_native');
 if v_changed then insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'products',v_id,case when p_id is null then 'create'
   -- Only the "Ativado" switch changed: the same actions as Ativar/Inativar of erp_catalog_set_active.
   when not v_base_changed and not v_detail_changed then case when v_active then 'restore' else 'archive' end else 'update' end,v_before,erp_catalog.product_full(v_id)); end if;
 if jsonb_array_length(v_codes)>0 then insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'products',v_id,'warnings_acknowledged',null,jsonb_build_object('warnings',v_codes)); end if;
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Produto excluído é somente leitura em todos os caminhos de gravação (formulário, preço na linha, Ativar/Inativar, avisos
-- confirmados e aplicação de revisão da importação): só Restaurar, a exclusão de categoria/tag e a própria exclusão o alteram,
-- e só dentro da transação delas.
create function erp_catalog.guard_deleted_product() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if coalesce(current_setting('erp_catalog.product_lifecycle',true),'')<>'on'
  and exists(select 1 from erp_catalog.product_detail d where d.record_id=old.id and d.deleted_at is not null) then
  raise exception 'erp_catalog_product_deleted' using errcode='40001'; end if;
 return new;
end $$;
create trigger erp_catalog_record_deleted_product before update on erp_catalog.record
 for each row when(old.entity='products') execute function erp_catalog.guard_deleted_product();

-- Excluir / Restaurar (exclusão lógica do Origin): o excluído fica inativo, fora das situações padrão e dos seletores
-- dos documentos, e somente leitura. Restaurar devolve o produto como ativo. Comando, versão e auditoria próprios.
create function public.erp_catalog_product_set_deleted(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_deleted boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.record%rowtype; v_before jsonb; v_result jsonb; v_deleted boolean;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_id is null or p_command_id is null or p_deleted is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','product_set_deleted','id',p_id,'version',p_expected_version,'deleted',p_deleted)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 select * into v_row from erp_catalog.record where id=p_id and entity='products' for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_deleted:=exists(select 1 from erp_catalog.product_detail where record_id=p_id and deleted_at is not null);
 if v_deleted is distinct from p_deleted then
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  perform set_config('erp_catalog.product_lifecycle','on',true);
  v_before:=erp_catalog.product_full(p_id);
  insert into erp_catalog.product_detail(record_id) values(p_id) on conflict(record_id) do nothing;
  update erp_catalog.product_detail set deleted_at=case when p_deleted then clock_timestamp() end,deleted_by=case when p_deleted then p_user_id end where record_id=p_id;
  update erp_catalog.record set active=not p_deleted,version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=p_id;
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'products',p_id,case when p_deleted then 'delete' else 'undelete' end,v_before,erp_catalog.product_full(p_id));
  perform set_config('erp_catalog.product_lifecycle','',true);
 end if;
 v_result:=jsonb_build_object('entity','products','record',erp_catalog.product_full(p_id),'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Seletor de produtos dos documentos e do financeiro (cursor): mesma assinatura e ordem de 096; produto excluído fica fora.
create or replace function public.erp_catalog_product_list(p_user_id uuid,p_limit integer default 25,p_after uuid default null,
 p_query text default null,p_active boolean default null,p_kind text default null,p_format text default null,
 p_ncm_presence text default null,p_brand text default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_more boolean;v_last uuid;v_terms text[];
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_limit is null or p_limit not between 1 and 100 or length(p_query)>120 or p_query~'[[:cntrl:]]'
  or length(p_brand)>100 or p_brand~'[[:cntrl:]]'or(p_kind is not null and p_kind not in('P','S','N'))
  or(p_format is not null and p_format not in('S','V','E'))or(p_ncm_presence is not null and p_ncm_presence not in('present','missing'))then
  raise exception 'erp_catalog_invalid_query' using errcode='22023';end if;
 v_terms:=erp_catalog.search_terms(p_query);
 with page as materialized(
  select r.id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.entity='products'
   and(p_after is null or r.id>p_after)and(p_active is null or r.active=p_active)
   and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.deleted_at is not null)
   and(p_kind is null or p.kind=p_kind)and(p_format is null or p.format=p_format)
   and(p_ncm_presence is null or case p_ncm_presence when 'present'then nullif(btrim(p.ncm),'')is not null else nullif(btrim(p.ncm),'')is null end)
   and(nullif(btrim(p_brand),'')is null or strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0)
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
  order by r.id limit p_limit+1
 ),visible as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_catalog.dto(id)order by id)from visible),'[]'::jsonb),
  (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)into v_items,v_more,v_last;
 return jsonb_build_object('entity','products','items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_last end,'limit',p_limit,'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_taxonomy_list(uuid,text)','erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_catalog_taxonomy_delete(uuid,text,uuid,integer,uuid)','erp_catalog_product_get(uuid,uuid)',
  'erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)',
  'erp_catalog_product_set_deleted(uuid,uuid,integer,uuid,boolean)','erp_catalog_product_list(uuid,integer,uuid,text,boolean,text,text,text,text)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
