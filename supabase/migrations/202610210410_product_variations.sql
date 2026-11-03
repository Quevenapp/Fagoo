-- Leva H, lane produtos (PRD-109, VND-153, PRD-009): variações básicas.
-- * O produto com variações (Formato V) só agrupa: não entra em documento (pedido, proposta, OS, compra, PDV) e não movimenta
--   estoque (os fluxos de estoque já recusavam o formato V).
-- * Cada variação é um produto comum (Formato S), o SKU filho, com código, preço, GTIN e estoque próprios, ligado ao pai com os
--   atributos (Cor, Tamanho...). "Adicionar variação" cria o filho pela mesma gravação de produtos (validação, auditoria e
--   permissões de Cadastros › Produtos) e exige a permissão Salvar variações. A combinação de atributos é única por pai.
-- * Seleções customizadas › Variações passa a listar os SKUs filhos; a busca da linha dos documentos não oferece o pai.
-- * O pai não sai do Formato V enquanto tiver variações.
-- As funções substituídas são conferidas pelo hash; outra versão interrompe a migração.
begin;

do $$declare r record;begin
 for r in select * from(values
  ('erp_catalog.product_filter_sql(text)','306c5722bf202836de7d51368493deaacf16b75b74d1f160eb30a968cb8dfae1'),
  ('public.erp_document_product_search(uuid,text,text,integer)','c59f582ed165804d9ec6482b5fc25996b42c020bde23044dc30dd568da1c8aae'))v(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.hash then
   raise exception 'product_variations_410_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
 if to_regclass('erp_catalog.product_variation') is not null then raise exception 'product_variations_410_already_applied' using errcode='55000'; end if;
end$$;

create table erp_catalog.product_variation(
 child_id uuid primary key references erp_catalog.record(id),
 parent_id uuid not null references erp_catalog.record(id),
 attributes jsonb not null check(jsonb_typeof(attributes)='object'),
 attributes_key text not null,
 position integer not null check(position between 1 and 500),
 command_id uuid not null unique,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 check(child_id<>parent_id),
 unique(parent_id,attributes_key)
);
create index erp_catalog_product_variation_parent on erp_catalog.product_variation(parent_id,position);
alter table erp_catalog.product_variation enable row level security;
revoke all on erp_catalog.product_variation from public,anon,authenticated,service_role;

create function erp_catalog.variation_dto(p_parent uuid) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('parent',jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'format',p.format),
  'children',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'code',c.code,'active',c.active,'gtin',cp.gtin,'price',cp.price::text,'attributes',v.attributes)
    order by v.position) from erp_catalog.product_variation v join erp_catalog.record c on c.id=v.child_id join erp_catalog.product cp on cp.record_id=c.id where v.parent_id=r.id),'[]'::jsonb))
 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=p_parent
$$;

create function public.erp_catalog_product_variations(p_user_id uuid,p_parent uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_parent is null or not exists(select 1 from erp_catalog.record where id=p_parent and entity='products') then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('scope','product_variations','data_mode','erp_native')||erp_catalog.variation_dto(p_parent);
end $$;

-- Adicionar variação: p_data = {attributes:{Cor:'Azul',...}, code, gtin (opcional), price (opcional; o do pai quando ausente)}.
create function public.erp_catalog_product_variation_add(p_user_id uuid,p_command_id uuid,p_parent uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_parent jsonb; v_attrs jsonb; v_key text; v_name text; v_data jsonb; v_child jsonb; v_hash text; v_prior jsonb; v_pos integer; k text;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if not erp_access.permitted(p_user_id,'cadastros.produtos.variacoes') then raise exception 'erp_catalog_access_denied' using errcode='42501'; end if;
 if p_command_id is null or p_parent is null or p_data is null or jsonb_typeof(p_data)<>'object'
  or exists(select 1 from jsonb_object_keys(p_data) x where x not in('attributes','code','gtin','price')) or not p_data ?& array['attributes','code']
  or jsonb_typeof(p_data->'attributes')<>'object' or (select count(*) from jsonb_object_keys(p_data->'attributes')) not between 1 and 5 then
  raise exception 'erp_catalog_variation_invalid' using errcode='22023'; end if;
 for k in select x from jsonb_object_keys(p_data->'attributes') x loop
  if char_length(btrim(k)) not between 1 and 60 or k~'[[:cntrl:]]' or jsonb_typeof(p_data->'attributes'->k)<>'string'
   or char_length(btrim(p_data->'attributes'->>k)) not between 1 and 60 or (p_data->'attributes'->>k)~'[[:cntrl:]]' then raise exception 'erp_catalog_variation_invalid' using errcode='22023'; end if;
 end loop;
 v_attrs:=(select jsonb_object_agg(btrim(x.key),btrim(x.value#>>'{}')) from jsonb_each(p_data->'attributes') x);
 v_key:=(select string_agg(lower(x.key)||'='||lower(x.value#>>'{}'),'|' order by lower(x.key)) from jsonb_each(v_attrs) x);
 v_hash:=encode(sha256(convert_to(jsonb_build_object('parent',p_parent,'data',p_data)::text,'UTF8')),'hex');
 select result into v_prior from erp_catalog.product_variation v join lateral(select erp_catalog.variation_dto(v.parent_id) result) z on true where v.command_id=p_command_id;
 if found then
  if not exists(select 1 from erp_catalog.product_variation where command_id=p_command_id and parent_id=p_parent and attributes_key=v_key) then
   raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('scope','product_variation_command','data_mode','erp_native','replayed',true,'child_id',(select child_id from erp_catalog.product_variation where command_id=p_command_id))||v_prior;
 end if;
 perform 1 from erp_catalog.record where id=p_parent for update;
 v_parent:=erp_catalog.dto(p_parent);
 if v_parent is null or v_parent->>'entity'<>'products' or v_parent->>'format'<>'V' or (v_parent->>'active')::boolean is not true then raise exception 'erp_catalog_variation_parent_invalid' using errcode='22023'; end if;
 if exists(select 1 from erp_catalog.product_variation where child_id=p_parent) then raise exception 'erp_catalog_variation_parent_invalid' using errcode='22023'; end if;
 if exists(select 1 from erp_catalog.product_variation where parent_id=p_parent and attributes_key=v_key) then raise exception 'erp_catalog_variation_duplicate' using errcode='23505'; end if;
 v_name:=left(v_parent->>'name'||' '||(select string_agg(x.value#>>'{}',' ' order by x.key) from jsonb_each(v_attrs) x),200);
 v_data:=(select jsonb_object_agg(x.key,x.value) from jsonb_each(v_parent) x where x.key in('unit','kind','ncm','brand','condition','production','net_weight','gross_weight','width','height','depth',
   'dimension_unit','volumes','items_per_box','cest','origin') and x.value<>'null'::jsonb)
  ||jsonb_build_object('name',v_name,'code',p_data->>'code','format','S','price',coalesce(p_data->>'price',v_parent->>'price','0'))
  ||case when p_data ? 'gtin' and p_data->>'gtin' is not null then jsonb_build_object('gtin',p_data->>'gtin') else '{}'::jsonb end;
 v_child:=public.erp_catalog_save(p_user_id,'products',null,0,p_command_id,v_data);
 select coalesce(max(position),0)+1 into v_pos from erp_catalog.product_variation where parent_id=p_parent;
 insert into erp_catalog.product_variation(child_id,parent_id,attributes,attributes_key,position,command_id,created_by)
  values((v_child#>>'{record,id}')::uuid,p_parent,v_attrs,v_key,v_pos,p_command_id,p_user_id);
 return jsonb_build_object('scope','product_variation_command','data_mode','erp_native','replayed',false,'child_id',(v_child#>>'{record,id}')::uuid)||erp_catalog.variation_dto(p_parent);
end $$;

-- O pai não deixa o Formato V com variações ligadas; um filho não vira pai.
create function erp_catalog.guard_variation_parent() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if old.format='V' and new.format is distinct from 'V' and exists(select 1 from erp_catalog.product_variation where parent_id=new.record_id) then
  raise exception 'erp_catalog_variation_parent_locked' using errcode='40001'; end if;
 if new.format='V' and exists(select 1 from erp_catalog.product_variation where child_id=new.record_id) then
  raise exception 'erp_catalog_variation_parent_invalid' using errcode='22023'; end if;
 return new;
end $$;
create trigger guard_variation_parent before update on erp_catalog.product for each row execute function erp_catalog.guard_variation_parent();

-- VND-153: o pai com variações não entra em item de documento novo (ou trocado); os itens que já existiam continuam legíveis.
create function erp_documents.guard_variation_item() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.product_id is not null and (tg_op='INSERT' or new.product_id is distinct from old.product_id)
  and exists(select 1 from erp_catalog.product p where p.record_id=new.product_id and p.format='V') then
  raise exception 'erp_document_variation_parent' using errcode='22023'; end if;
 return new;
end $$;
create trigger guard_variation_item before insert or update on erp_documents.item for each row execute function erp_documents.guard_variation_item();

create or replace function erp_catalog.product_filter_sql(p_period text) returns text
language sql immutable set search_path=pg_catalog as $$
 select format($q$ from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
  left join erp_catalog.product_detail d on d.record_id=r.id
  where r.entity='products'
   and(case $1::text when 'deleted' then d.deleted_at is not null
     else(d.deleted_at is null and case $1::text when 'active' then r.active when 'inactive' then not r.active else true end)
      or($19::boolean and d.deleted_at is not null) end)
   and($2::text[] is null or erp_catalog.matches($2,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
   and(case $3::text when 'composition' then p.format='E' when 'no_composition' then p.format is distinct from 'E'
     when 'products' then p.kind='P' when 'simple' then p.format='S' when 'with_variations' then p.format='V'
     when 'variations' then exists(select 1 from erp_catalog.product_variation v where v.child_id=r.id) when 'services' then p.kind='S' else true end)
   and($4::text is null or case $4 when 'present' then nullif(btrim(p.ncm),'') is not null else nullif(btrim(p.ncm),'') is null end)
   and($5::text is null or left(coalesce(p.ncm,''),length($5))=$5)
   and($6::text is null or strpos(erp_catalog.fold(coalesce(p.brand,'')),erp_catalog.fold($6))>0)
   and($7::uuid[] is null or r.id=any($7))
   and($8::text is null or case $8 when 'yes' then exists(select 1 from erp_catalog.product_image i where i.record_id=r.id)
     else not exists(select 1 from erp_catalog.product_image i where i.record_id=r.id) end)
   and($9::text is null or case $9 when 'none' then not exists(select 1 from erp_catalog.product_tag x where x.record_id=r.id)
     else exists(select 1 from erp_catalog.product_tag x where x.record_id=r.id and x.tag_id=$9::uuid) end)
   and($10::text is null or case $10 when 'none' then d.category_id is null else d.category_id=$10::uuid end)
   and($11::text is null or d.item_type=$11)
   and($12::uuid is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and s.supplier_id=$12))
   and($13::text is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=r.id and strpos(erp_catalog.fold(coalesce(s.code,'')),erp_catalog.fold($13))>0))
   and($14::timestamptz is null or %1$s>=$14) and($15::timestamptz is null or %1$s<$15)
   and($16::date is null or d.expiry_date>=$16) and($17::date is null or d.expiry_date<=$17)
   and($18::boolean is null or true)$q$,
  case p_period when 'created' then 'r.created_at' else 'r.updated_at' end)
$$;


create or replace function public.erp_document_product_search(p_user_id uuid,p_kind text,p_query text,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_terms text[]; v_items jsonb; v_more boolean; v_last uuid;
begin
 if p_kind is null or p_kind not in('sales_orders','sales_proposals','service_orders') or p_limit is null or p_limit not between 1 and 25
  or p_query is null or char_length(btrim(p_query)) not between 2 and 120 or p_query~'[[:cntrl:]]' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,true);
 perform erp_catalog.require_access(p_user_id,'products',false);
 v_terms:=erp_catalog.search_terms(p_query);
 with page as materialized(
  -- Leva H (VND-153): the product with variations only groups them; the line takes the SKU of the variation.
  select r.id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.entity='products' and r.active and p.format is distinct from 'V'
   and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and (d.deleted_at is not null or d.item_type in('01','03','07','08')))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
  order by r.id limit p_limit+1)
 select coalesce((select jsonb_agg(erp_catalog.dto(x.id) order by x.id) from (select id from page order by id limit p_limit) x),'[]'::jsonb),(select count(*)>p_limit from page),
  (select x.id from (select id from page order by id limit p_limit) x order by x.id desc limit 1)
  into v_items,v_more,v_last;
 return jsonb_build_object('entity','products','items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_last end,'limit',p_limit,
  'data_mode','erp_native','operational_effects',false);
end $function$;


revoke all on function erp_catalog.product_filter_sql(text),erp_catalog.variation_dto(uuid),erp_catalog.guard_variation_parent(),erp_documents.guard_variation_item() from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_catalog_product_variations(uuid,uuid)','erp_catalog_product_variation_add(uuid,uuid,uuid,jsonb)','erp_document_product_search(uuid,text,text,integer)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
