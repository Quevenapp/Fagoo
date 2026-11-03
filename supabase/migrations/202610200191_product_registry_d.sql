-- Cadastro de produtos no padrão do Origin, onda D (área de produtos):
-- * Características > "Itens p/ caixa" decimal, com até seis casas (Origin: "Quantidade de itens por caixa/embalagem"). O valor
--   exato fica no detalhe do produto (product_detail.items_per_box, chave items_per_box_decimal do formulário); a coluna inteira
--   do catálogo (product.items_per_box, lida pelas rotas antigas e pelo retrato dos documentos) passa a ser o espelho inteiro do
--   valor (vazia quando o valor tem casas decimais). Uma gravação antiga que mude a coluna inteira é copiada para o detalhe.
--   As funções comuns do catálogo (data, dto, validate_data, write_fields) não mudam.
-- * Listagem > filtro "Campos customizados": escolher a categoria e adicionar filtros por campo (Texto/Texto longo contém,
--   Inteiro/Decimal/Data de–até, Lista igual à opção, Lógico Sim/Não), até 10 filtros, todos juntos (E). Uma página nova
--   (erp_catalog_product_page_custom) com os mesmos parâmetros da v2 mais p_custom, usada só com o filtro, e o conjunto
--   "Produtos filtrados" do reajuste de preços com o mesmo filtro. A exportação não usa o filtro (o Origin também o ignora).
-- * Preferências > Configurações de produtos > Código do produto "Sequencial EAN": o produto novo sem código recebe um GTIN-13
--   com o prefixo GS1 da empresa (novo campo), o próximo número do item (o maior já usado + 1, ou o "Próximo número do item"
--   da preferência, o que for maior) e o dígito verificador. Mesma trava do Sequencial.
-- * Tributação: o regime tributário confirmado da empresa (CRT) para o formulário mostrar os campos condicionais do IPI.
-- * Estoque > "Controle de lote": a chave do produto (product_detail.lot_control), recusada em produto com variações. Só fica
--   gravada: os lotes, o saldo por lote e os lançamentos com lote pertencem ao estoque e ainda não existem.
-- * Origem padrão de tributação de produtos também no produto criado pela gravação comum do catálogo (erp_catalog_save, usada
--   hoje pela criação automática de produtos dos documentos) quando ele chega sem Origem.
-- * Criação automática de produtos a partir dos documentos (Preferências > Configurações de produtos > "Cadastrar
--   automaticamente produtos a partir de …"): erp_catalog.document_product, para o perfil que grava o documento mesmo sem
--   permissão de gravar produtos (Vendas), com a Origem padrão e o código Sequencial/EAN. A chamada dentro da gravação dos
--   documentos pertence à área de documentos.
-- Nada aqui gera estoque, título financeiro, imposto, XML ou escrita no Origin. Depende de 006/023/096/115/119/120/155/156.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regclass('erp_catalog.product_custom_value') is null or to_regprocedure('erp_catalog.product_custom_resolve(uuid,jsonb)') is null
  or to_regprocedure('erp_preferences.get(text,uuid)') is null or to_regclass('erp_company.fiscal') is null then
  raise exception 'product_registry_191_requires_115_156' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_catalog.product_detail_keys()','73f599c76b85ce39bb35bc32bf15d66c7a5fb04eff9a6cc2d2959abb608ebc2c'),
  ('erp_catalog.product_detail_validate(jsonb)','cc0295827210d4993bb3791e5d9ebf60c727c6e1a0096d61dd900b023353b676'),
  ('erp_catalog.product_detail_data(uuid,boolean)','a09f9c8b5eed1b09d8021b6f4c2eabaf0a413ddb59fb8f27de0b3514ea6f894e'),
  ('erp_catalog.product_detail_write(uuid,jsonb)','2a22a062dc550bd86ec87e33dd824f7eb9291fb1af5d9919a8b2e8a612c15853'),
  ('public.erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)','8b925be989e779be3b3a6d41bdbf535d6db779588cb96657dabc4f9782dc26fd'),
  ('public.erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)','7876cd6227977998178ab372ff1886094498a2eb13ddb524afd6d19c7c0183d6'),
  ('public.erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb)','d8d63b4334b7ea1a1dd79dc105a751a459cb199c0588f0bd8df3640723f8f2f4'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'product_registry_191_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('produtos.ean_prefixo','cadastros-produtos','geral',18,'text',null,'""'::jsonb,null,null,null,11,null,'plain'),
 ('produtos.ean_proximo','cadastros-produtos','geral',19,'integer',null,'0'::jsonb,0,99999,null,null,null,null);
-- END GENERATED DEFINITIONS

-- ---------------------------------------------------------------------------------------------------------------
-- Itens p/ caixa decimal.
alter table erp_catalog.product_detail add column items_per_box numeric(12,6) check(items_per_box>=0);
-- Estoque > Controle de lote (Origin): only the switch of the product; the lot ledger belongs to the stock area.
alter table erp_catalog.product_detail add column lot_control boolean not null default false;
-- A write of the integer catalog column outside the product form (routes of 006/023/096, import review) is copied to the detail,
-- so both never disagree; the form path writes the detail itself and marks the transaction while it mirrors the integer column.
create function erp_catalog.items_per_box_follow() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if coalesce(current_setting('erp_catalog.items_per_box_detail',true),'')<>'on' then
  insert into erp_catalog.product_detail(record_id,items_per_box) values(new.record_id,new.items_per_box)
   on conflict(record_id) do update set items_per_box=excluded.items_per_box;
 end if;
 return null;
end $$;
create trigger erp_catalog_product_items_per_box_insert after insert on erp_catalog.product
 for each row when(new.items_per_box is not null) execute function erp_catalog.items_per_box_follow();
create trigger erp_catalog_product_items_per_box_update after update of items_per_box on erp_catalog.product
 for each row when(old.items_per_box is distinct from new.items_per_box) execute function erp_catalog.items_per_box_follow();

create or replace function erp_catalog.product_detail_keys() returns text[]
language sql immutable set search_path=pg_catalog as $$
 select array['expiry_date','free_shipping','discreet_description','complementary_description','external_link','video_url','notes',
  'crossdocking_days','category_id','product_group_id','fci_number','item_type','tax_percent','icms_st_retention_base','icms_st_retention_value',
  'icms_own_substitute_value','ipi_tipi_exception','ipi_framework_class','ipi_fixed_value','ipi_seal_code','pis_fixed_value','cofins_fixed_value',
  'anp_code','anp_description','glp_percent','glgnn_percent','glgni_percent','starting_value','dun_codes','suppliers','tag_ids','images','custom_values',
  'items_per_box_decimal','lot_control']
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
  -- Itens p/ caixa: up to 999999 with six decimal places, exact (a string, never a float).
  when 'items_per_box_decimal' then v_result:=v_result||jsonb_build_object(v_pair.key,erp_catalog.detail_decimal(v_pair.value,6,6));
  when 'lot_control' then
   if jsonb_typeof(v_pair.value)<>'boolean' then raise exception 'erp_catalog_invalid_flag' using errcode='22023'; end if;
   v_result:=v_result||jsonb_build_object(v_pair.key,v_pair.value);
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

-- Detalhe atual (156) mais items_per_box_decimal: o valor exato do detalhe ou, sem ele, a coluna inteira do catálogo.
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
  'items_per_box_decimal',(coalesce(d.items_per_box,p.items_per_box::numeric))::numeric(12,6)::text,'lot_control',coalesce(d.lot_control,false),
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
declare d jsonb:=p_detail; v_box numeric;
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
  starting_value=case when d?'starting_value' then(d->>'starting_value')::numeric else starting_value end,
  lot_control=case when d?'lot_control' then(d->>'lot_control')::boolean else lot_control end
 where record_id=p_id;
 -- Itens p/ caixa: the exact value in the detail; the integer catalog column mirrors it (empty for a value with decimals).
 if d?'items_per_box_decimal' then
  v_box:=(d->>'items_per_box_decimal')::numeric;
  perform set_config('erp_catalog.items_per_box_detail','on',true);
  update erp_catalog.product set items_per_box=case when v_box=trunc(v_box) then v_box::integer end where record_id=p_id;
  update erp_catalog.product_detail set items_per_box=v_box where record_id=p_id;
  perform set_config('erp_catalog.items_per_box_detail','',true);
 end if;
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

-- ---------------------------------------------------------------------------------------------------------------
-- Código do produto: Sequencial e Sequencial EAN.
-- GTIN-13 check digit of 12 digits: weights 3 and 1 from the rightmost digit, (10 − sum mod 10) mod 10.
create function erp_catalog.gtin_check_digit(p_digits text) returns text
language sql immutable set search_path=pg_catalog as $$
 select ((10-(sum(substr(p_digits,length(p_digits)+1-i,1)::integer*case when i%2=1 then 3 else 1 end)%10))%10)::text
 from generate_series(1,length(p_digits)) i
$$;
-- The next code of a new product without a code, or null for "Manual". Sequencial: the largest numeric code + 1. Sequencial EAN:
-- prefixo GS1 (7 to 11 digits) + item number (the largest used with the prefix + 1, at least "Próximo número do item") + check digit.
-- One lock for both, so two simultaneous inclusions never take the same number. Without a valid prefix, p_strict refuses the save
-- (product form) and the automatic creation from documents leaves the code empty.
create function erp_catalog.next_product_code(p_strict boolean) returns text
language plpgsql set search_path=pg_catalog as $$
declare v_mode jsonb:=erp_preferences.get('produtos.codigo'); v_prefix text; v_digits integer; v_next bigint; v_floor jsonb; v_body text;
begin
 if v_mode='"sequencial"'::jsonb then
  perform pg_advisory_xact_lock(174852909,0);
  return(select(coalesce(max(code::numeric),0)+1)::text from erp_catalog.record where entity='products' and code~'^[0-9]{1,18}$');
 end if;
 if v_mode is distinct from '"sequencial_ean"'::jsonb then return null; end if;
 v_prefix:=erp_preferences.get('produtos.ean_prefixo')#>>'{}';
 if v_prefix is null or v_prefix!~'^[0-9]{7,11}$' then
  if p_strict then raise exception 'erp_catalog_ean_prefix_missing' using errcode='22023'; end if;
  return null;
 end if;
 v_digits:=12-length(v_prefix);
 perform pg_advisory_xact_lock(174852909,0);
 select coalesce(max(substr(code,length(v_prefix)+1,v_digits)::bigint)+1,0) into v_next from erp_catalog.record
  where entity='products' and code~'^[0-9]{13}$' and left(code,length(v_prefix))=v_prefix;
 v_floor:=erp_preferences.get('produtos.ean_proximo');
 if jsonb_typeof(v_floor)='number' then v_next:=greatest(v_next,(v_floor#>>'{}')::bigint); end if;
 if v_next>=power(10,v_digits)::bigint then
  if p_strict then raise exception 'erp_catalog_ean_exhausted' using errcode='22023'; end if;
  return null;
 end if;
 v_body:=v_prefix||lpad(v_next::text,v_digits,'0');
 return v_body||erp_catalog.gtin_check_digit(v_body);
end $$;

-- Gravação do formulário de produto (156) com o código Sequencial EAN; o resto é igual.
create or replace function public.erp_catalog_product_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb,p_acknowledged jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_keys text[]:=erp_catalog.product_detail_keys(); v_base jsonb; v_detail jsonb; v_data jsonb; v_hash text; v_command erp_catalog.command%rowtype;
 v_row erp_catalog.record%rowtype; v_id uuid; v_before jsonb; v_result jsonb; v_changed boolean:=false; v_base_changed boolean:=false;
 v_active boolean; v_codes jsonb:='[]'::jsonb; v_current jsonb; v_detail_changed boolean:=false; v_code text;
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
  -- Preferências > Configurações de produtos > Código do produto: Sequencial or Sequencial EAN numbers a new product without code.
  if nullif(v_data->>'code','') is null then
   v_code:=erp_catalog.next_product_code(true);
   if v_code is not null then v_data:=v_data||jsonb_build_object('code',v_code); end if;
  end if;
  -- Origem padrão de tributação: a body without the Origem key (an import, an integration) gets it, as the form pre-fills it.
  if not p_data?'origin' and jsonb_typeof(erp_preferences.get('produtos.origem_padrao'))='string' and erp_preferences.get('produtos.origem_padrao')#>>'{}'~'^[0-8]$' then
   v_data:=v_data||jsonb_build_object('origin',erp_preferences.get('produtos.origem_padrao')#>>'{}'); end if;
  perform erp_catalog.validate_product_identifiers(v_data,null);
  v_data:=erp_catalog.validate_data('products',v_data,true);
  perform erp_catalog.product_detail_references(v_detail);
  -- Origin: "Não é possível criar um produto com variações quando possuir um lote preenchido."
  if v_data->>'format'='V' and(v_detail->>'lot_control')::boolean then raise exception 'erp_catalog_lot_control_variations' using errcode='22023'; end if;
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
  if coalesce(case when v_data<>'{}'::jsonb then v_data->>'format' end,(select format from erp_catalog.product where record_id=v_id))='V'
   and coalesce((v_detail->>'lot_control')::boolean,(select lot_control from erp_catalog.product_detail where record_id=v_id),false) then
   raise exception 'erp_catalog_lot_control_variations' using errcode='22023'; end if;
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

-- Gravação comum do catálogo (006): um produto novo sem Origem recebe a Origem padrão de tributação (Preferências >
-- Configurações de produtos), como no formulário. Contatos, depósitos, edições e produtos com Origem não mudam.
-- mutate confere a repetição pelo hash do corpo recebido: um comando já gravado ("Conferir resultado", a repetição de um envio
-- incerto) recebe a Origem com que o produto foi criado (nenhuma, se foi gravado antes da 191), e não a preferência de agora,
-- para continuar devolvendo o mesmo resultado depois de a Origem padrão mudar ou da publicação desta migração.
create or replace function public.erp_catalog_save(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_data jsonb:=p_data; v_done jsonb; v_origin jsonb;
begin
 if p_entity='products' and p_id is null and jsonb_typeof(p_data)='object' and coalesce(p_data->>'origin','')='' then
  select c.result into v_done from erp_catalog.command c where c.command_id=p_command_id and c.actor=p_user_id;
  if found then
   if nullif(v_done#>>'{record,origin}','') is not null then v_data:=p_data||jsonb_build_object('origin',v_done#>>'{record,origin}'); end if;
  else
   v_origin:=erp_preferences.get('produtos.origem_padrao');
   if jsonb_typeof(v_origin)='string' and v_origin#>>'{}'~'^[0-8]$' then v_data:=p_data||jsonb_build_object('origin',v_origin#>>'{}'); end if;
  end if;
 end if;
 return erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,v_data,false,null);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Filtro "Campos customizados" da listagem: [{field_id, value | from/to}], até 10, todos juntos. Devolve os produtos que atendem
-- (null sem filtro). Texto e Texto longo: contém (sem acento e sem diferenciar maiúsculas); Inteiro, Decimal e Data: de/até
-- (inclusive); Lista: a opção; Lógico: 'true' (Sim) ou 'false' (Não). Um campo inexistente ou um valor fora do tipo é recusado.
create function erp_catalog.product_custom_filter(p_custom jsonb) returns uuid[]
language plpgsql stable set search_path=pg_catalog as $$
declare v_item jsonb; v_field erp_catalog.custom_field%rowtype; v_set uuid[]; v_ids uuid[]; v_value text; v_from text; v_to text;
 v_number constant text:='^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$';
begin
 if p_custom is null or p_custom='null'::jsonb then return null; end if;
 if jsonb_typeof(p_custom)<>'array' or jsonb_array_length(p_custom) not between 1 and 10 then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 for v_item in select value from jsonb_array_elements(p_custom) loop
  if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in('field_id','value','from','to'))
   or jsonb_typeof(v_item->'field_id') is distinct from 'string' or v_item->>'field_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or exists(select 1 from jsonb_each(v_item) e where e.key<>'field_id' and(jsonb_typeof(e.value) not in('string','null') or length(e.value#>>'{}')>255)) then
   raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
  select * into v_field from erp_catalog.custom_field where id=(v_item->>'field_id')::uuid and module='products';
  if not found then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
  v_value:=nullif(v_item->>'value',''); v_from:=nullif(v_item->>'from',''); v_to:=nullif(v_item->>'to','');
  if v_field.field_type in('text','long_text') then
   v_value:=nullif(btrim(v_value),'');
   if v_value is null or v_value~'[[:cntrl:]]' or v_from is not null or v_to is not null then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   select coalesce(array_agg(v.record_id),'{}') into v_set from erp_catalog.product_custom_value v
    where v.field_id=v_field.id and strpos(erp_catalog.fold(v.value),erp_catalog.fold(v_value))>0;
  elsif v_field.field_type in('integer','decimal') then
   if v_value is not null or num_nonnulls(v_from,v_to)=0 or(v_from is not null and v_from!~v_number) or(v_to is not null and v_to!~v_number)
    or v_from::numeric>v_to::numeric then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   select coalesce(array_agg(v.record_id),'{}') into v_set from erp_catalog.product_custom_value v
    where v.field_id=v_field.id and(v_from is null or v.value::numeric>=v_from::numeric) and(v_to is null or v.value::numeric<=v_to::numeric);
  elsif v_field.field_type='date' then
   if v_value is not null or num_nonnulls(v_from,v_to)=0 then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   v_from:=erp_catalog.detail_date(to_jsonb(v_from)); v_to:=erp_catalog.detail_date(to_jsonb(v_to));
   if v_from>v_to then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   select coalesce(array_agg(v.record_id),'{}') into v_set from erp_catalog.product_custom_value v
    where v.field_id=v_field.id and(v_from is null or v.value>=v_from) and(v_to is null or v.value<=v_to);
  elsif v_field.field_type='list' then
   v_value:=lower(v_value);
   if v_value is null or v_from is not null or v_to is not null or v_value!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not exists(select 1 from erp_catalog.custom_field_option o where o.id=v_value::uuid and o.field_id=v_field.id) then
    raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   select coalesce(array_agg(v.record_id),'{}') into v_set from erp_catalog.product_custom_value v where v.field_id=v_field.id and v.value=v_value;
  else
   if v_value is null or v_value not in('true','false') or v_from is not null or v_to is not null then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
   select coalesce(array_agg(v.record_id),'{}') into v_set from erp_catalog.product_custom_value v where v.field_id=v_field.id and v.value=v_value;
  end if;
  v_ids:=case when v_ids is null then v_set else array(select x from unnest(v_ids) x intersect select y from unnest(v_set) y) end;
 end loop;
 return v_ids;
end $$;
-- Both product sets of the page ($7 of product_filter_sql): the stock filter and the custom field filter.
create function erp_catalog.product_ids_and(p_a uuid[],p_b uuid[]) returns uuid[]
language sql immutable set search_path=pg_catalog as $$
 select case when p_a is null then p_b when p_b is null then p_a else array(select x from unnest(p_a) x intersect select y from unnest(p_b) y) end
$$;

-- Página v2 (120) com o filtro "Campos customizados" (p_custom obrigatório; sem ele a tela usa a v2).
create function public.erp_catalog_product_page_custom(p_user_id uuid,p_page integer default 1,p_size integer default 100,
 p_sort text default 'created_desc',p_query text default null,p_situation text default 'latest',p_product_type text default null,
 p_ncm_presence text default null,p_ncm text default null,p_brand text default null,p_stock text default null,p_warehouse_id uuid default null,
 p_images text default null,p_tag text default null,p_category text default null,p_item_type text default null,
 p_supplier_id uuid default null,p_supplier_code text default null,p_period text default null,p_from date default null,p_to date default null,
 p_custom jsonb default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_stock boolean; v_terms text[]; v_filter uuid[]; v_ids uuid[]; v_total bigint; v_items jsonb;
 v_brand text:=nullif(btrim(p_brand),''); v_code text:=nullif(btrim(p_supplier_code),'');
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_page is null or p_page not between 1 and 100000 or p_size is null or p_size not between 1 and 100
  or p_sort is null or p_sort not in('created_desc','name_asc','name_desc','code_asc','code_desc') or p_custom is null or p_custom='null'::jsonb
  or not erp_catalog.product_filters_valid(p_situation,p_query,p_product_type,p_ncm_presence,p_ncm,p_brand,p_stock,p_images,p_tag,p_category,p_item_type,p_supplier_code,p_period,p_from,p_to) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 v_stock:=erp_catalog.can_read_stock(p_user_id);
 if(p_stock is not null or p_warehouse_id is not null) and not v_stock then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then
  raise exception 'erp_catalog_warehouse_not_found' using errcode='P0002'; end if;
 v_filter:=erp_catalog.product_ids_and(erp_catalog.product_stock_filter(p_stock,p_warehouse_id),erp_catalog.product_custom_filter(p_custom));
 v_terms:=erp_catalog.search_terms(p_query);
 execute erp_catalog.page_sql(erp_catalog.product_filter_sql(p_period),p_sort,true,20) into v_total,v_ids
  using p_situation,v_terms,p_product_type,p_ncm_presence,p_ncm,v_brand,v_filter,p_images,p_tag,p_category,p_item_type,p_supplier_id,v_code,
   case when p_period in('created','updated') and p_from is not null then p_from::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period in('created','updated') and p_to is not null then(p_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
   case when p_period='expiry' then p_from end,case when p_period='expiry' then p_to end,null::boolean,false,(p_page-1)*p_size,p_size;
 select coalesce(jsonb_agg(erp_catalog.product_list_item(u.id)||jsonb_build_object('stock',case when v_stock then jsonb_build_object(
    'state',s.state,'quantity',case when s.state='recorded' then round(s.quantity,6)::text end,
    'warehouse',case when p_warehouse_id is not null then jsonb_build_object('id',p_warehouse_id,'state',s.warehouse_state,
     'quantity',case when s.warehouse_state='recorded' then round(s.warehouse_quantity,6)::text end) end) end) order by u.n),'[]'::jsonb)
  into v_items from unnest(v_ids) with ordinality u(id,n)
  left join erp_catalog.stock_summary(case when v_stock then v_ids else '{}'::uuid[] end,p_warehouse_id) s on s.product_id=u.id;
 return jsonb_build_object('entity','products','items',v_items,'page',p_page,'size',p_size,'total',v_total,'sort',p_sort,
  'stock_visible',v_stock,'data_mode','erp_native');
end $$;

-- Reajuste de preços (155): "Produtos filtrados" também com o filtro Campos customizados (filters.custom, a mesma lista da página).
create or replace function public.erp_catalog_product_price_adjust(p_user_id uuid,p_command_id uuid,p_rule jsonb,p_items jsonb default null,p_filters jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_ids uuid[]; v_expected jsonb:='{}'::jsonb; v_row record; v_result jsonb; v_outcome jsonb;
 v_applied integer:=0; v_unchanged integer:=0; v_skipped jsonb:='[]'::jsonb; v_skipped_total integer:=0; f jsonb:=p_filters; v_filter uuid[]; v_period text;
 v_from date; v_to date; v_before jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_command_id is null or not erp_catalog.price_rule_valid(p_rule) or(p_items is null)=(p_filters is null) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if p_items is not null then
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
   or exists(select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in('id','expected_version'))
    or erp_catalog.detail_uuid(x->'id') is null or jsonb_typeof(x->'expected_version')<>'number' or(x->>'expected_version')!~'^[1-9][0-9]{0,9}$' or(x->>'expected_version')::bigint>2147483647) then
   raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  select array_agg(distinct(x->>'id')::uuid),jsonb_object_agg(lower(x->>'id'),(x->>'expected_version')::integer) into v_ids,v_expected from jsonb_array_elements(p_items) x;
  if cardinality(v_ids)<>jsonb_array_length(p_items) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 else
  if jsonb_typeof(f)<>'object' or exists(select 1 from jsonb_object_keys(f) k where k not in('situation','query','product_type','ncm_presence','ncm','brand','stock','warehouse_id','images','tag','category',
    'item_type','supplier_id','supplier_code','period','from','to','custom'))
   or exists(select 1 from jsonb_each(f) e where e.key<>'custom' and jsonb_typeof(e.value) not in('string','null'))
   or(f?'custom' and jsonb_typeof(f->'custom') not in('array','null')) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  v_period:=f->>'period';
  begin v_from:=(f->>'from')::date; v_to:=(f->>'to')::date; exception when others then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end;
  if coalesce(f->>'situation','latest')='deleted' or(f->>'warehouse_id' is not null and f->>'warehouse_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(f->>'supplier_id' is not null and f->>'supplier_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or not erp_catalog.product_filters_valid(coalesce(f->>'situation','latest'),f->>'query',f->>'product_type',f->>'ncm_presence',f->>'ncm',f->>'brand',f->>'stock',f->>'images',f->>'tag',f->>'category',
    f->>'item_type',f->>'supplier_code',v_period,v_from,v_to) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  if(f->>'stock' is not null or f->>'warehouse_id' is not null) and not erp_catalog.can_read_stock(p_user_id) then raise exception 'erp_catalog_stock_access_denied' using errcode='42501'; end if;
 end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','price_adjust','rule',p_rule,'items',p_items,'filters',p_filters)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 if p_filters is not null then
  v_filter:=erp_catalog.product_ids_and(erp_catalog.product_stock_filter(f->>'stock',(f->>'warehouse_id')::uuid),erp_catalog.product_custom_filter(f->'custom'));
  execute 'select coalesce(array_agg(r.id order by r.id),''{}''::uuid[])'||erp_catalog.product_filter_sql(v_period) into v_ids
   using coalesce(f->>'situation','latest'),erp_catalog.search_terms(f->>'query'),f->>'product_type',f->>'ncm_presence',f->>'ncm',nullif(btrim(f->>'brand'),''),v_filter,f->>'images',f->>'tag',f->>'category',
    f->>'item_type',(f->>'supplier_id')::uuid,nullif(btrim(f->>'supplier_code'),''),
    case when v_period in('created','updated') and v_from is not null then v_from::timestamp at time zone 'America/Sao_Paulo' end,
    case when v_period in('created','updated') and v_to is not null then(v_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
    case when v_period='expiry' then v_from end,case when v_period='expiry' then v_to end,null::boolean,false;
  if cardinality(v_ids)>5000 then raise exception 'erp_catalog_adjust_too_many' using errcode='22023'; end if;
 end if;
 for v_row in select r.id,r.version,r.name,p.price,d.deleted_at from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_catalog.product_detail d on d.record_id=r.id
   where r.entity='products' and r.id=any(v_ids) order by r.id for update of r loop
  v_outcome:=case when v_row.deleted_at is not null then jsonb_build_object('status','deleted')
   when p_items is not null and(v_expected->>(v_row.id::text))::integer<>v_row.version then jsonb_build_object('status','conflict')
   else erp_catalog.price_rule_result(v_row.price,p_rule) end;
  if v_outcome->>'status'='ok' then
   if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
   v_before:=jsonb_build_object('price',erp_catalog.unit_price_numeric(v_row.price,14));
   update erp_catalog.product set price=(v_outcome->>'price')::numeric where record_id=v_row.id;
   update erp_catalog.record set version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_row.id;
   update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_row.id;
   insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
    values(p_user_id,p_command_id,'products',v_row.id,'price_adjust',v_before,jsonb_build_object('price',v_outcome->>'price','rule',p_rule));
   v_applied:=v_applied+1;
  elsif v_outcome->>'status'='unchanged' then v_unchanged:=v_unchanged+1;
  else
   v_skipped_total:=v_skipped_total+1;
   if jsonb_array_length(v_skipped)<50 then v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_row.id,'name',v_row.name,'reason',v_outcome->>'status')); end if;
  end if;
 end loop;
 -- A selected product that is not a product (or does not exist) is reported, not silently ignored.
 if p_items is not null then
  v_skipped_total:=v_skipped_total+(select count(*) from unnest(v_ids) x where not exists(select 1 from erp_catalog.product p where p.record_id=x))::integer;
  v_skipped:=v_skipped||coalesce((select jsonb_agg(jsonb_build_object('id',x,'name',null,'reason','not_found')) from unnest(v_ids) x where not exists(select 1 from erp_catalog.product p where p.record_id=x)),'[]'::jsonb);
 end if;
 v_result:=jsonb_build_object('entity','products','total',cardinality(v_ids),'applied',v_applied,'unchanged',v_unchanged,'skipped_total',v_skipped_total,'skipped',v_skipped,
  'rule',p_rule,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Contexto do formulário: o regime tributário confirmado da empresa (Preferências > Dados da empresa), para os campos condicionais
-- do IPI. Só o CRT confirmado, nada mais da empresa; quem lê produtos lê o contexto.
create function public.erp_catalog_product_form_context(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 return jsonb_build_object('crt',(select f.crt from erp_company.fiscal f where f.singleton and f.confirmed_at is not null),'data_mode','erp_native');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Criação automática de produto a partir do item livre de um documento (proposta, pedido de venda, pedido de compra ou OS), com a
-- preferência do tipo ligada: o produto ativo de mesmo código, ou um produto novo (descrição, código ou o código Sequencial/EAN,
-- unidade, Tipo Produto ou Serviço, Formato Simples, a Origem padrão e, nas saídas, o preço). Para o perfil que grava o documento:
-- a gravação do documento já conferiu essa permissão, e o perfil Vendas não grava produtos pelo cadastro. Comando derivado do
-- comando do documento e da posição do item (a repetição devolve o mesmo produto), auditoria 'create' com o ator do documento.
-- Interna (sem execução pública); chamada pela gravação dos documentos.
create function erp_catalog.document_product(p_user_id uuid,p_kind text,p_command_id uuid,p_item jsonb) returns uuid
language plpgsql set search_path=pg_catalog as $$
declare v_role text; v_id uuid; v_code text; v_data jsonb; v_hash text; v_command uuid; v_stored erp_catalog.command%rowtype; v_origin jsonb; v_result jsonb;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if v_role is null or p_kind is null or p_kind not in('sales_proposals','sales_orders','purchase_orders','service_orders') or not erp_documents.allowed(v_role,p_kind,true) then
  raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_item is null or jsonb_typeof(p_item)<>'object' or p_item->>'product_id' is not null
  or(p_item?'kind' and coalesce(p_item->>'kind','') not in('P','S')) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if erp_preferences.get(case p_kind when 'purchase_orders' then 'produtos.cadastro_auto_compras' when 'service_orders' then 'produtos.cadastro_auto_os'
   else 'produtos.cadastro_auto_vendas' end) is distinct from 'true'::jsonb then return null; end if;
 v_code:=nullif(btrim(coalesce(p_item->>'code','')),'');
 if v_code is not null then
  select r.id into v_id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
   where r.entity='products' and r.active and lower(r.code)=lower(v_code)
    and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and d.deleted_at is not null)
   order by r.created_at,r.id limit 1;
  if v_id is not null then return v_id; end if;
 end if;
 v_command:=md5('document-auto-product:'||p_command_id::text||':'||coalesce(p_item->>'position',''))::uuid;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','document_product','kind',p_kind,'item',p_item-'position')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(v_command::text));
 select * into v_stored from erp_catalog.command where command_id=v_command;
 if found then
  if v_stored.actor<>p_user_id or v_stored.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return(v_stored.result#>>'{record,id}')::uuid;
 end if;
 v_origin:=erp_preferences.get('produtos.origem_padrao');
 v_data:=jsonb_build_object('name',p_item->>'description','code',coalesce(v_code,erp_catalog.next_product_code(false)),'unit',p_item->>'unit',
  'kind',coalesce(p_item->>'kind','P'),'format','S','price',case when p_kind='purchase_orders' then null else p_item->>'unit_price' end,
  'origin',case when jsonb_typeof(v_origin)='string' and v_origin#>>'{}'~'^[0-8]$' then v_origin#>>'{}' end);
 v_data:=erp_catalog.validate_data('products',v_data,true);
 perform erp_catalog.validate_product_identifiers(v_data,null);
 insert into erp_catalog.record(entity,name,code,active,created_by,updated_by,human_edited)
  values('products',v_data->>'name',v_data->>'code',true,p_user_id,p_user_id,true) returning id into v_id;
 perform erp_catalog.write_fields(v_id,'products',v_data);
 v_result:=jsonb_build_object('entity','products','record',erp_catalog.dto(v_id),'document_kind',p_kind,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
  values(p_user_id,v_command,'products',v_id,'create',null,erp_catalog.product_full(v_id)||jsonb_build_object('created_from',p_kind));
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(v_command,p_user_id,v_hash,v_result);
 return v_id;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_product_save(uuid,uuid,integer,uuid,jsonb,jsonb)','erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)',
  'erp_catalog_product_form_context(uuid)','erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_catalog_product_page_custom(uuid,integer,integer,text,text,text,text,text,text,text,text,uuid,text,text,text,text,uuid,text,text,date,date,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
