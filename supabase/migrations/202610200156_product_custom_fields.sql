-- Campos customizados de produtos (Preferências > Sistema > Campos customizados, aba Produtos), como no Origin:
-- definição do campo (tipo fixo depois de criado, nome, dica de preenchimento, informação sobre o campo, obrigatório,
-- tamanhos mínimo e máximo, lista de opções, largura e Agrupador com as categorias de produtos onde o campo aparece),
-- Situação Ativo/Inativo, exclusão recusada quando há valores gravados, e os valores no formulário do produto, gravados no
-- mesmo comando, versão e auditoria do produto (data.custom_values). O formulário "Nova categoria" escolhe os campos
-- aplicáveis à categoria no mesmo comando da categoria (custom_field_ids).
--
-- Abas Ordem de Serviço e Clientes e Fornecedores: ainda sem campos (module só aceita 'products'). Não altera estoque,
-- financeiro, documentos fiscais nem o Origin. Depende de 119/120/153.
begin;

-- ---------------------------------------------------------------------------------------------------------------
-- Definições, opções da lista, categorias do Agrupador, valores por produto e auditoria.
create table erp_catalog.custom_field(
 id uuid primary key default gen_random_uuid(),
 module text not null default 'products' check(module='products'),
 field_type text not null check(field_type in('integer','decimal','list','text','long_text','boolean','date')),
 name text not null check(length(name) between 1 and 60 and name=btrim(name) and name!~'[[:cntrl:]]'),
 hint text check(length(hint) between 1 and 100 and hint=btrim(hint) and hint!~'[[:cntrl:]]'),
 info text check(length(info) between 1 and 300 and info=btrim(info,E' \t\r\n')),
 required boolean not null default false,
 min_length integer check(min_length between 1 and 4000),
 max_length integer check(max_length between 1 and 4000),
 width text not null default 'medium' check(width in('small','medium','large','extra_large')),
 grouped boolean not null default false,
 active boolean not null default true,
 version integer not null default 1 check(version between 1 and 2147483647),
 created_by uuid not null references auth.users(id), updated_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check(min_length is null or max_length is null or min_length<=max_length),
 check((min_length is null and max_length is null) or field_type in('integer','decimal','text','long_text'))
);
create unique index erp_catalog_custom_field_name on erp_catalog.custom_field(module,erp_catalog.fold(name));
create table erp_catalog.custom_field_option(
 id uuid primary key default gen_random_uuid(),
 field_id uuid not null references erp_catalog.custom_field(id) on delete cascade,
 position integer not null check(position between 1 and 50),
 label text not null check(length(label) between 1 and 60 and label=btrim(label) and label!~'[[:cntrl:]]'),
 constraint erp_catalog_custom_field_option_position unique(field_id,position) deferrable initially deferred
);
create table erp_catalog.custom_field_category(
 field_id uuid not null references erp_catalog.custom_field(id) on delete cascade,
 category_id uuid not null, category_kind text not null default 'categories' check(category_kind='categories'),
 primary key(field_id,category_id),
 foreign key(category_id,category_kind) references erp_catalog.taxonomy(id,kind) on delete cascade
);
create index erp_catalog_custom_field_category_category on erp_catalog.custom_field_category(category_id);
-- Sem cascata para o campo: um campo com valores não é excluído (a exclusão é recusada e o campo pode ser inativado).
create table erp_catalog.product_custom_value(
 record_id uuid not null references erp_catalog.product(record_id),
 field_id uuid not null references erp_catalog.custom_field(id),
 value text not null check(length(value) between 1 and 4000),
 primary key(record_id,field_id)
);
create index erp_catalog_product_custom_value_field on erp_catalog.product_custom_value(field_id);
create table erp_catalog.custom_field_audit(
 id bigint generated always as identity primary key,
 actor uuid not null references auth.users(id), command_id uuid not null, field_id uuid not null,
 action text not null check(action in('create','update','delete','categories')),
 before_data jsonb, after_data jsonb,
 created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['custom_field','custom_field_option','custom_field_category','product_custom_value','custom_field_audit'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on table erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke all on all sequences in schema erp_catalog from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Leitura de um campo: definição, opções (na ordem), categorias do Agrupador e quantos produtos têm valor.
create function erp_catalog.custom_field_item(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',f.id,'module',f.module,'field_type',f.field_type,'name',f.name,'hint',f.hint,'info',f.info,
  'required',f.required,'min_length',f.min_length,'max_length',f.max_length,'width',f.width,'grouped',f.grouped,'active',f.active,
  'version',f.version,'created_at',f.created_at,'updated_at',f.updated_at,
  'options',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'label',o.label) order by o.position) from erp_catalog.custom_field_option o where o.field_id=f.id),'[]'::jsonb),
  'category_ids',coalesce((select jsonb_agg(c.category_id::text order by c.category_id::text) from erp_catalog.custom_field_category c where c.field_id=f.id),'[]'::jsonb),
  'products',(select count(*) from erp_catalog.product_custom_value v where v.field_id=f.id)::integer)
 from erp_catalog.custom_field f where f.id=p_id
$$;

-- A categoria do produto e as categorias acima dela: um campo agrupado numa categoria aparece também nas subcategorias.
create function erp_catalog.category_lineage(p_category uuid) returns uuid[]
language sql stable set search_path=pg_catalog as $$
 with recursive up(id,depth) as(
  select t.id,0 from erp_catalog.taxonomy t where t.id=p_category and t.kind='categories'
  union all select t.parent_id,u.depth+1 from up u join erp_catalog.taxonomy t on t.id=u.id where t.parent_id is not null and u.depth<50)
 select coalesce(array_agg(id),'{}'::uuid[]) from up
$$;
create function erp_catalog.custom_field_applies(p_field_id uuid,p_grouped boolean,p_lineage uuid[]) returns boolean
language sql stable set search_path=pg_catalog as $$
 select not p_grouped or exists(select 1 from erp_catalog.custom_field_category c where c.field_id=p_field_id and c.category_id=any(p_lineage))
$$;

-- Valor de um campo, na forma canônica (texto): vazio ou null apaga; inteiro e decimal exatos (o decimal sem zeros à
-- direita); texto sem quebra de linha e texto longo com quebras; lógico 'true'/'false'; data AAAA-MM-DD; lista = id da opção.
-- O tamanho mínimo/máximo vale para a quantidade de caracteres do valor (inteiro, decimal, texto e texto longo).
create function erp_catalog.custom_value(p_field erp_catalog.custom_field,p_value jsonb) returns text
language plpgsql stable set search_path=pg_catalog as $$
declare v text;
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 v:=p_value#>>'{}';
 v:=case when p_field.field_type in('text','long_text') then nullif(btrim(v),'') else nullif(v,'') end;
 if v is null then return null; end if;
 if p_field.field_type='integer' then
  if v!~'^-?(0|[1-9][0-9]{0,17})$' or v='-0' then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 elsif p_field.field_type='decimal' then
  if v!~'^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$' then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
  v:=trim_scale(v::numeric)::text;
 elsif p_field.field_type='text' then
  if length(v)>255 or v~'[[:cntrl:]]' then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 elsif p_field.field_type='long_text' then
  if length(v)>4000 or translate(v,E'\n\r\t','')~'[[:cntrl:]]' then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 elsif p_field.field_type='boolean' then
  if v not in('true','false') then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 elsif p_field.field_type='date' then
  v:=erp_catalog.detail_date(to_jsonb(v));
 else
  v:=lower(v);
  if v!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or not exists(select 1 from erp_catalog.custom_field_option o where o.id=v::uuid and o.field_id=p_field.id) then
   raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 end if;
 if(p_field.min_length is not null and length(v)<p_field.min_length) or(p_field.max_length is not null and length(v)>p_field.max_length) then
  raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 return v;
end $$;

create function erp_catalog.product_custom_values(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_object_agg(v.field_id::text,v.value),'{}'::jsonb) from erp_catalog.product_custom_value v where v.record_id=p_id
$$;

-- Valores do formulário do produto. O corpo traz os campos exibidos (ausente = não muda; null ou vazio = apaga). Ao trocar
-- a categoria, os valores dos campos agrupados que não se aplicam à nova categoria são removidos (aviso do Origin). Um valor
-- novo ou alterado exige campo ativo e aplicável à categoria; com custom_values no corpo, todo campo ativo, obrigatório e
-- aplicável precisa de valor. Devolve o detalhe com custom_values = mapa final completo, comparável ao gravado.
create function erp_catalog.product_custom_resolve(p_id uuid,p_detail jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_current jsonb:='{}'; v_final jsonb; v_patch jsonb:=p_detail->'custom_values'; v_old uuid; v_category uuid; v_lineage uuid[];
 v_field erp_catalog.custom_field%rowtype; v_key text; v_value text;
begin
 if not(p_detail?'custom_values' or p_detail?'category_id') then return p_detail; end if;
 if p_id is not null then
  v_current:=erp_catalog.product_custom_values(p_id);
  select d.category_id into v_old from erp_catalog.product_detail d where d.record_id=p_id;
 end if;
 v_category:=case when p_detail?'category_id' then(p_detail->>'category_id')::uuid else v_old end;
 v_lineage:=erp_catalog.category_lineage(v_category);
 v_final:=v_current;
 if v_category is distinct from v_old and v_final<>'{}'::jsonb then
  v_final:=coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(v_final) e join erp_catalog.custom_field f on f.id=e.key::uuid
   where erp_catalog.custom_field_applies(f.id,f.grouped,v_lineage)),'{}'::jsonb);
 end if;
 if v_patch is not null then
  -- Os campos e as opções usados ficam travados até o fim da gravação: uma exclusão concorrente espera e então os encontra em uso.
  perform 1 from erp_catalog.custom_field f where f.id in(select k::uuid from jsonb_object_keys(v_patch) k) order by f.id for key share;
  perform 1 from erp_catalog.custom_field_option o where o.field_id in(select k::uuid from jsonb_object_keys(v_patch) k) order by o.id for key share;
  for v_key in select k from jsonb_object_keys(v_patch) k order by k loop
   select * into v_field from erp_catalog.custom_field where id=v_key::uuid and module='products';
   if not found then raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
   v_value:=erp_catalog.custom_value(v_field,v_patch->v_key);
   if v_value is not distinct from v_final->>v_key then continue; end if;
   if v_value is null then v_final:=v_final-v_key; continue; end if;
   if not v_field.active or not erp_catalog.custom_field_applies(v_field.id,v_field.grouped,v_lineage) then
    raise exception 'erp_catalog_custom_field_unavailable' using errcode='22023'; end if;
   v_final:=v_final||jsonb_build_object(v_key,v_value);
  end loop;
  if exists(select 1 from erp_catalog.custom_field f where f.module='products' and f.active and f.required
    and erp_catalog.custom_field_applies(f.id,f.grouped,v_lineage) and not v_final?(f.id::text)) then
   raise exception 'erp_catalog_custom_field_required' using errcode='22023'; end if;
 end if;
 if octet_length(v_final::text)>8192 then raise exception 'erp_catalog_invalid_custom_value' using errcode='22023'; end if;
 return p_detail||jsonb_build_object('custom_values',v_final);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Detalhe do produto (119) com custom_values: chave aceita no corpo, devolvida na leitura e gravada com o produto.
create or replace function erp_catalog.product_detail_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['expiry_date','free_shipping','discreet_description','complementary_description','external_link','video_url','notes',
  'crossdocking_days','category_id','product_group_id','fci_number','item_type','tax_percent','icms_st_retention_base','icms_st_retention_value',
  'icms_own_substitute_value','ipi_tipi_exception','ipi_framework_class','ipi_fixed_value','ipi_seal_code','pis_fixed_value','cofins_fixed_value',
  'anp_code','anp_description','glp_percent','glgnn_percent','glgni_percent','starting_value','dun_codes','suppliers','tag_ids','images','custom_values']
$$;

create or replace function erp_catalog.product_detail_validate(p_data jsonb) returns jsonb
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
  when 'custom_values' then
   -- Só a forma aqui (até 60 campos, id → texto ou null); tipo, opção, situação e categoria são conferidos na gravação.
   if jsonb_typeof(v_pair.value)<>'object' or(select count(*) from jsonb_object_keys(v_pair.value))>60
    or exists(select 1 from jsonb_each(v_pair.value) e where e.key!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(e.value) not in('string','null') or length(e.value#>>'{}')>4000) then
    raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_pair.value);
  else raise exception 'erp_catalog_unknown_field' using errcode='22023';
  end case;
 end loop;
 return v_result;
end $$;

create or replace function erp_catalog.product_detail_data(p_id uuid,p_display boolean) returns jsonb
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
  'images',coalesce((select jsonb_agg(jsonb_build_object('url',x.url) order by x.position) from erp_catalog.product_image x where x.record_id=p.record_id),'[]'::jsonb),
  'custom_values',erp_catalog.product_custom_values(p.record_id))
  ||case when p_display then jsonb_build_object('deleted_at',d.deleted_at,
   'cost_price',(select erp_catalog.unit_price_numeric(s.cost_price,14) from erp_catalog.product_supplier s where s.record_id=p.record_id and s.is_default)) else '{}'::jsonb end
 from erp_catalog.product p left join erp_catalog.product_detail d on d.record_id=p.record_id where p.record_id=p_id
$$;

create or replace function erp_catalog.product_detail_write(p_id uuid,p_detail jsonb) returns void
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
 -- custom_values chega aqui já resolvido (mapa final completo, erp_catalog.product_custom_resolve).
 if d?'custom_values' and d->'custom_values' is distinct from erp_catalog.product_custom_values(p_id) then
  delete from erp_catalog.product_custom_value where record_id=p_id;
  insert into erp_catalog.product_custom_value(record_id,field_id,value) select p_id,e.key::uuid,e.value#>>'{}' from jsonb_each(d->'custom_values') e;
 end if;
end $$;

-- Gravação do formulário de produto (119), agora com os campos customizados resolvidos antes da comparação e da gravação.
create or replace function public.erp_catalog_product_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb default null)
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
  v_detail:=erp_catalog.product_custom_resolve(null,v_detail);
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
  v_detail:=erp_catalog.product_custom_resolve(v_id,v_detail);
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

-- ---------------------------------------------------------------------------------------------------------------
-- Tela Campos Customizados: lista da aba Produtos (até 60 campos, sem paginação, como no Origin).
create function public.erp_catalog_custom_fields(p_user_id uuid,p_module text default 'products')
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_module is distinct from 'products' then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('module',p_module,'data_mode','erp_native','items',coalesce((select jsonb_agg(erp_catalog.custom_field_item(f.id) order by erp_catalog.fold(f.name),f.id)
  from erp_catalog.custom_field f where f.module=p_module),'[]'::jsonb));
end $$;

-- Liga/desliga uma categoria do Agrupador dos campos (formulário "Nova categoria"): cada campo alterado ganha versão e auditoria;
-- um campo sem Agrupador passa a ser agrupado (aparece só nas categorias marcadas).
create function erp_catalog.category_custom_fields_set(p_user_id uuid,p_command_id uuid,p_category_id uuid,p_field_ids uuid[]) returns integer
language plpgsql set search_path=pg_catalog as $$
declare v_field uuid; v_before jsonb; v_count integer:=0; v_member boolean; v_wanted boolean;
begin
 if exists(select 1 from unnest(p_field_ids) x where not exists(select 1 from erp_catalog.custom_field f where f.id=x and f.module='products')) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 for v_field in select f.id from erp_catalog.custom_field f where f.module='products'
   and(f.id=any(p_field_ids) or exists(select 1 from erp_catalog.custom_field_category c where c.field_id=f.id and c.category_id=p_category_id))
   order by f.id for no key update loop
  v_member:=exists(select 1 from erp_catalog.custom_field_category c where c.field_id=v_field and c.category_id=p_category_id);
  v_wanted:=v_field=any(p_field_ids);
  if v_member=v_wanted and(not v_wanted or(select grouped from erp_catalog.custom_field where id=v_field)) then continue; end if;
  if(select version from erp_catalog.custom_field where id=v_field)=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_before:=erp_catalog.custom_field_item(v_field);
  if v_wanted then insert into erp_catalog.custom_field_category(field_id,category_id) values(v_field,p_category_id) on conflict do nothing;
  else delete from erp_catalog.custom_field_category where field_id=v_field and category_id=p_category_id; end if;
  update erp_catalog.custom_field set grouped=grouped or v_wanted,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_field;
  insert into erp_catalog.custom_field_audit(actor,command_id,field_id,action,before_data,after_data) values(p_user_id,p_command_id,v_field,'categories',v_before,erp_catalog.custom_field_item(v_field));
  v_count:=v_count+1;
 end loop;
 return v_count;
end $$;

-- Gaveta "Adicionar campo" / "Editar Campo" e o toggle de Situação. Tipo fixo depois de criado; Lista com 1 a 50 opções
-- (as opções guardam o id: renomear ou reordenar não muda os valores dos produtos; remover uma opção em uso é recusado);
-- Agrupador com até 100 categorias de produtos. Nome único por aba. Comando com versão esperada e auditoria.
create function public.erp_catalog_custom_field_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.custom_field%rowtype; v_new erp_catalog.custom_field%rowtype; v_id uuid;
 v_before jsonb; v_after jsonb; v_result jsonb; v_cap integer; v_options jsonb; v_option jsonb; v_categories uuid[]; v_removed uuid[]; v_used integer; v_n integer;
 v_text text; v_old uuid[]; v_touched uuid[]; v_cat uuid; v_cat_before jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_command_id is null or p_expected_version is null or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>32768 or p_data='{}'::jsonb
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('field_type','name','hint','info','required','min_length','max_length','width','grouped','category_ids','options','active'))
  or(p_id is null and(jsonb_typeof(p_data->'field_type') is distinct from 'string' or jsonb_typeof(p_data->'name') is distinct from 'string'))
  or(p_data?'field_type' and(jsonb_typeof(p_data->'field_type')<>'string' or p_data->>'field_type' not in('integer','decimal','list','text','long_text','boolean','date')))
  or(p_data?'name' and jsonb_typeof(p_data->'name')<>'string')
  or exists(select 1 from jsonb_each(p_data) e where e.key in('hint','info') and jsonb_typeof(e.value) not in('string','null'))
  or exists(select 1 from jsonb_each(p_data) e where e.key in('required','grouped','active') and jsonb_typeof(e.value)<>'boolean')
  or exists(select 1 from jsonb_each(p_data) e where e.key in('min_length','max_length') and e.value<>'null'::jsonb
   and(jsonb_typeof(e.value)<>'number' or(e.value#>>'{}')!~'^[1-9][0-9]{0,3}$'))
  or(p_data?'width' and(jsonb_typeof(p_data->'width')<>'string' or p_data->>'width' not in('small','medium','large','extra_large')))
  or(p_data?'category_ids' and(jsonb_typeof(p_data->'category_ids')<>'array' or jsonb_array_length(p_data->'category_ids')>100
   or exists(select 1 from jsonb_array_elements(p_data->'category_ids') x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(select count(distinct x#>>'{}') from jsonb_array_elements(p_data->'category_ids') x)<>jsonb_array_length(p_data->'category_ids')))
  or(p_data?'options' and(jsonb_typeof(p_data->'options')<>'array' or jsonb_array_length(p_data->'options')>50
   or exists(select 1 from jsonb_array_elements(p_data->'options') o where jsonb_typeof(o)<>'object'
    or exists(select 1 from jsonb_object_keys(o) k where k not in('id','label')) or jsonb_typeof(o->'label') is distinct from 'string'
    or(o?'id' and o->'id'<>'null'::jsonb and(jsonb_typeof(o->'id')<>'string' or o->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))))) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','custom_field_save','id',p_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- One writer of definitions at a time (name uniqueness and the limit of 60 stay exact); taken before any category or field row.
 perform pg_advisory_xact_lock(174852913,hashtext('products'));
 if p_id is not null then
  select * into v_row from erp_catalog.custom_field where id=p_id for no key update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if p_data?'field_type' and p_data->>'field_type'<>v_row.field_type then raise exception 'erp_catalog_custom_field_type_fixed' using errcode='22023'; end if;
  v_new:=v_row; v_before:=erp_catalog.custom_field_item(p_id);
 else
  if(select count(*) from erp_catalog.custom_field where module='products')>=60 then
   return jsonb_build_object('saved',false,'reason','limit','replayed',false,'data_mode','erp_native'); end if;
  v_new.field_type:=p_data->>'field_type'; v_new.module:='products'; v_new.required:=false; v_new.width:='medium'; v_new.grouped:=false; v_new.active:=true;
 end if;
 if p_data?'name' then v_new.name:=btrim(p_data->>'name'); end if;
 if p_data?'hint' then v_new.hint:=nullif(btrim(p_data->>'hint'),''); end if;
 if p_data?'info' then v_new.info:=nullif(btrim(p_data->>'info',E' \t\r\n'),''); end if;
 if p_data?'required' then v_new.required:=(p_data->>'required')::boolean; end if;
 if p_data?'min_length' then v_new.min_length:=(p_data->>'min_length')::integer; end if;
 if p_data?'max_length' then v_new.max_length:=(p_data->>'max_length')::integer; end if;
 if p_data?'width' then v_new.width:=p_data->>'width'; end if;
 if p_data?'grouped' then v_new.grouped:=(p_data->>'grouped')::boolean; end if;
 if p_data?'active' then v_new.active:=(p_data->>'active')::boolean; end if;
 v_cap:=case v_new.field_type when 'integer' then 19 when 'decimal' then 22 when 'text' then 255 when 'long_text' then 4000 end;
 if v_new.name is null or v_new.name='' or length(v_new.name)>60 or v_new.name~'[[:cntrl:]]'
  or length(v_new.hint)>100 or v_new.hint~'[[:cntrl:]]' or length(v_new.info)>300 or translate(v_new.info,E'\n\r\t','')~'[[:cntrl:]]'
  or((v_new.min_length is not null or v_new.max_length is not null) and v_cap is null)
  or v_new.min_length>v_cap or v_new.max_length>v_cap or v_new.min_length>v_new.max_length
  or(p_data?'options' and v_new.field_type<>'list') or(p_data?'category_ids' and not v_new.grouped and jsonb_array_length(p_data->'category_ids')>0) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 -- Lista: as opções informadas (com id = opção existente deste campo) substituem as atuais, na ordem enviada.
 if v_new.field_type='list' then
  v_options:=case when p_data?'options' then p_data->'options' else(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'label',o.label) order by o.position),'[]'::jsonb)
   from erp_catalog.custom_field_option o where o.field_id=p_id) end;
  if jsonb_array_length(v_options)=0
   or exists(select 1 from jsonb_array_elements(v_options) o where btrim(o->>'label')='' or length(btrim(o->>'label'))>60 or o->>'label'~'[[:cntrl:]]')
   or(select count(distinct erp_catalog.fold(btrim(o->>'label'))) from jsonb_array_elements(v_options) o)<>jsonb_array_length(v_options)
   or(select count(distinct o->>'id') from jsonb_array_elements(v_options) o where o->>'id' is not null)<>(select count(*) from jsonb_array_elements(v_options) o where o->>'id' is not null)
   or exists(select 1 from jsonb_array_elements(v_options) o where o->>'id' is not null
    and(p_id is null or not exists(select 1 from erp_catalog.custom_field_option x where x.id=(o->>'id')::uuid and x.field_id=p_id))) then
   raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 end if;
 if exists(select 1 from erp_catalog.custom_field f where f.module='products' and erp_catalog.fold(f.name)=erp_catalog.fold(v_new.name) and f.id is distinct from p_id) then
  return jsonb_build_object('saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native'); end if;
 -- Agrupador: categorias de produtos existentes. The categories gained or lost are locked before any link changes (a concurrent
 -- deletion waits) and get a new version below, so a category form opened before this save gets a conflict instead of undoing it.
 v_old:=(select coalesce(array_agg(c.category_id),'{}'::uuid[]) from erp_catalog.custom_field_category c where c.field_id=p_id);
 if not v_new.grouped then v_categories:='{}';
 elsif p_data?'category_ids' then v_categories:=(select coalesce(array_agg((x#>>'{}')::uuid),'{}'::uuid[]) from jsonb_array_elements(p_data->'category_ids') x);
 else v_categories:=v_old; end if;
 v_touched:=(select coalesce(array_agg(x order by x),'{}'::uuid[]) from((select unnest(v_categories) except select unnest(v_old)) union(select unnest(v_old) except select unnest(v_categories))) q(x));
 perform 1 from erp_catalog.taxonomy t where(t.id=any(v_categories) or t.id=any(v_touched)) and t.kind='categories' order by t.id for no key update;
 if(select count(*) from erp_catalog.taxonomy t where t.id=any(v_categories) and t.kind='categories')<>cardinality(v_categories) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 -- Opções removidas: travadas antes da conferência, então um produto gravando a opção termina antes e é contado.
 if p_id is not null and v_new.field_type='list' then
  select coalesce(array_agg(o.id order by o.id),'{}'::uuid[]) into v_removed from erp_catalog.custom_field_option o where o.field_id=p_id
   and o.id::text not in(select x->>'id' from jsonb_array_elements(v_options) x where x->>'id' is not null);
  perform 1 from erp_catalog.custom_field_option o where o.id=any(v_removed) order by o.id for update;
  select count(*) into v_used from erp_catalog.product_custom_value v where v.field_id=p_id and v.value in(select unnest(v_removed)::text);
  if v_used>0 then return jsonb_build_object('saved',false,'reason','option_in_use','products',v_used,'replayed',false,'data_mode','erp_native'); end if;
 end if;
 if p_id is null then
  insert into erp_catalog.custom_field(module,field_type,name,hint,info,required,min_length,max_length,width,grouped,active,created_by,updated_by)
   values('products',v_new.field_type,v_new.name,v_new.hint,v_new.info,v_new.required,v_new.min_length,v_new.max_length,v_new.width,v_new.grouped,v_new.active,p_user_id,p_user_id)
   returning id into v_id;
 else
  v_id:=p_id;
  update erp_catalog.custom_field set name=v_new.name,hint=v_new.hint,info=v_new.info,required=v_new.required,min_length=v_new.min_length,max_length=v_new.max_length,
   width=v_new.width,grouped=v_new.grouped,active=v_new.active where id=v_id;
 end if;
 if v_new.field_type='list' then
  delete from erp_catalog.custom_field_option o where o.field_id=v_id and o.id::text not in(select x->>'id' from jsonb_array_elements(v_options) x where x->>'id' is not null);
  v_n:=0;
  for v_option in select value from jsonb_array_elements(v_options) loop
   v_n:=v_n+1; v_text:=btrim(v_option->>'label');
   if v_option->>'id' is not null then update erp_catalog.custom_field_option set position=v_n,label=v_text where id=(v_option->>'id')::uuid;
   else insert into erp_catalog.custom_field_option(field_id,position,label) values(v_id,v_n,v_text); end if;
  end loop;
 end if;
 delete from erp_catalog.custom_field_category c where c.field_id=v_id and not c.category_id=any(v_categories);
 insert into erp_catalog.custom_field_category(field_id,category_id) select v_id,x from unnest(v_categories) x on conflict do nothing;
 -- Each category that gained or lost this field: new version and audit (its form shows the linked fields).
 for v_cat in select t.id from erp_catalog.taxonomy t where t.id=any(v_touched) and t.kind='categories' order by t.id loop
  v_cat_before:=erp_catalog.taxonomy_item(v_cat);
  if(v_cat_before->>'version')::integer=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  update erp_catalog.taxonomy set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_cat;
  insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'categories',v_cat,'update',v_cat_before,erp_catalog.taxonomy_item(v_cat)||jsonb_build_object('custom_field_id',v_id,'linked',v_cat=any(v_categories)));
 end loop;
 v_after:=erp_catalog.custom_field_item(v_id);
 if p_id is null then
  insert into erp_catalog.custom_field_audit(actor,command_id,field_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,'create',null,v_after);
 elsif(v_after-'products'-'version'-'updated_at')<>(v_before-'products'-'version'-'updated_at') then
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  update erp_catalog.custom_field set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  v_after:=erp_catalog.custom_field_item(v_id);
  insert into erp_catalog.custom_field_audit(actor,command_id,field_id,action,before_data,after_data) values(p_user_id,p_command_id,v_id,'update',v_before,v_after);
 end if;
 v_result:=jsonb_build_object('saved',true,'field',v_after,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Exclusão: recusada quando algum produto tem valor no campo (inative o campo em vez de excluir); remove as opções e o Agrupador.
create function public.erp_catalog_custom_field_delete(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.custom_field%rowtype; v_before jsonb; v_result jsonb; v_used integer;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_id is null or p_command_id is null or p_expected_version is null or p_expected_version not between 1 and 2147483647 then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','custom_field_delete','id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform pg_advisory_xact_lock(174852913,hashtext('products'));
 -- FOR UPDATE waits for product saves holding the field (FOR KEY SHARE), so the count below sees their values.
 select * into v_row from erp_catalog.custom_field where id=p_id for update;
 if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 select count(*) into v_used from erp_catalog.product_custom_value where field_id=p_id;
 if v_used>0 then return jsonb_build_object('id',p_id,'deleted',false,'reason','in_use','products',v_used,'replayed',false,'data_mode','erp_native'); end if;
 v_before:=erp_catalog.custom_field_item(p_id);
 delete from erp_catalog.custom_field where id=p_id;
 insert into erp_catalog.custom_field_audit(actor,command_id,field_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,'delete',v_before,null);
 v_result:=jsonb_build_object('id',p_id,'deleted',true,'products',0,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Inclusão e edição de taxonomia (153) + "Campos customizáveis aplicáveis nesta categoria" (custom_field_ids, só categorias),
-- no mesmo comando da categoria. A trava das definições vem antes da linha da categoria (mesma ordem da gaveta do campo).
create or replace function public.erp_catalog_taxonomy_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_spec jsonb:=erp_catalog.taxonomy_spec(p_kind); v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.taxonomy%rowtype;
 v_name text; v_parent uuid; v_parent_kind text; v_parent_type text; v_type text; v_id uuid; v_before jsonb; v_result jsonb; v_tagged boolean:=p_kind in('tag_groups','tags');
 v_fields uuid[]; v_linked integer:=0;
begin
 perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,null,true);
 if v_spec is null or p_command_id is null or p_expected_version is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or(p_id is null and p_expected_version<>0) or(p_id is not null and p_expected_version not between 1 and 2147483647)
  or exists(select 1 from jsonb_object_keys(p_data) k where k not in('name','parent_id','tag_type','custom_field_ids'))
  or jsonb_typeof(p_data->'name') is distinct from 'string'
  or(p_data?'parent_id' and jsonb_typeof(p_data->'parent_id') not in('string','null'))
  or(p_data->>'parent_id' is not null and p_data->>'parent_id'!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
  or(p_data?'tag_type' and(not v_tagged or jsonb_typeof(p_data->'tag_type') is distinct from 'string' or p_data->>'tag_type' not in('products','contacts')))
  or(p_data?'custom_field_ids' and(p_kind<>'categories' or jsonb_typeof(p_data->'custom_field_ids')<>'array' or jsonb_array_length(p_data->'custom_field_ids')>60
   or exists(select 1 from jsonb_array_elements(p_data->'custom_field_ids') x where jsonb_typeof(x)<>'string' or x#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(select count(distinct x#>>'{}') from jsonb_array_elements(p_data->'custom_field_ids') x)<>jsonb_array_length(p_data->'custom_field_ids'))) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_name:=btrim(p_data->>'name'); v_parent:=(p_data->>'parent_id')::uuid;
 -- The type decides the permission: the stored type (edição), else the requested one, the group's type or Produtos.
 if v_tagged then
  if p_id is not null then
   select tag_type into v_type from erp_catalog.taxonomy where id=p_id and kind=p_kind;
   if v_type is not null and p_data?'tag_type' and p_data->>'tag_type'<>v_type then raise exception 'erp_catalog_taxonomy_type_fixed' using errcode='22023'; end if;
  else
   if v_parent is not null then select tag_type into v_parent_type from erp_catalog.taxonomy where id=v_parent; end if;
   v_type:=coalesce(p_data->>'tag_type',v_parent_type,'products');
  end if;
  perform erp_catalog.require_taxonomy_access(p_user_id,p_kind,coalesce(v_type,p_data->>'tag_type','products'),true);
 end if;
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
 if p_data?'custom_field_ids' then
  perform pg_advisory_xact_lock(174852913,hashtext('products'));
  v_fields:=(select coalesce(array_agg((x#>>'{}')::uuid),'{}'::uuid[]) from jsonb_array_elements(p_data->'custom_field_ids') x);
 end if;
 if p_id is null then
  if v_parent is not null then
   select kind,tag_type into v_parent_kind,v_parent_type from erp_catalog.taxonomy where id=v_parent for key share;
   if v_parent_kind is distinct from v_spec->>'parent' or(v_tagged and v_parent_type is distinct from v_type) then
    raise exception 'erp_catalog_taxonomy_parent_invalid' using errcode='22023'; end if;
  end if;
  if(select count(*) from erp_catalog.taxonomy where kind=p_kind)>=2000 then raise exception 'erp_catalog_taxonomy_limit' using errcode='22023'; end if;
 else
  select * into v_row from erp_catalog.taxonomy where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if p_data?'parent_id' and v_parent is distinct from v_row.parent_id then raise exception 'erp_catalog_taxonomy_parent_fixed' using errcode='22023'; end if;
  v_parent:=v_row.parent_id; v_type:=v_row.tag_type;
 end if;
 if exists(select 1 from erp_catalog.taxonomy t where t.kind=p_kind and t.parent_id is not distinct from v_parent and t.tag_type is not distinct from v_type
   and erp_catalog.fold(t.name)=erp_catalog.fold(v_name) and t.id is distinct from p_id) then
  return jsonb_build_object('kind',p_kind,'saved',false,'reason','duplicate_name','replayed',false,'data_mode','erp_native');
 end if;
 if p_id is null then
  insert into erp_catalog.taxonomy(kind,parent_id,name,tag_type,created_by,updated_by) values(p_kind,v_parent,v_name,case when v_tagged then v_type end,p_user_id,p_user_id) returning id into v_id;
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
 if v_fields is not null then v_linked:=erp_catalog.category_custom_fields_set(p_user_id,p_command_id,v_id,v_fields); end if;
 -- The linked fields are part of the category form: changing them gives the category a new version (once per command), so a
 -- form opened before gets a conflict instead of silently undoing this change.
 if v_linked>0 and p_id is not null and v_row.name is not distinct from v_name then
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_before:=erp_catalog.taxonomy_item(v_id);
  update erp_catalog.taxonomy set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
  insert into erp_catalog.taxonomy_audit(actor,command_id,kind,item_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_kind,v_id,'update',v_before,erp_catalog.taxonomy_item(v_id)||jsonb_build_object('custom_field_ids',to_jsonb(v_fields)));
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'saved',true,'item',erp_catalog.taxonomy_item(v_id),'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_custom_fields(uuid,text)','erp_catalog_custom_field_save(uuid,uuid,integer,uuid,jsonb)',
  'erp_catalog_custom_field_delete(uuid,uuid,integer,uuid)','erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)',
  'erp_catalog_taxonomy_save(uuid,text,uuid,integer,uuid,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
