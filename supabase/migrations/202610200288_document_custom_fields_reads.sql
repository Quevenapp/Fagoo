-- 288: Documentos (onda G), parte 2: Campos customizados da OS (Preferências › Sistema › Campos customizados › Ordem de Serviço) e as
-- leituras do editor: lotes dos produtos (Informar lotes), regra de comissão do vendedor (aba Comissões) e a busca da Descrição da
-- linha sem os tipos de item que não se vendem.
-- * Campos customizados da OS (Origin): Adicionar campo / Editar Campo com tipo fixo depois de criado (Inteiro, Decimal, Lista, Texto,
--   Texto Longo, Lógico, Data), nome único, dica, informação, obrigatório, tamanhos, opções da lista, largura e situação; só o
--   administrador grava (comando, versão esperada, auditoria imutável), até 60 campos. Um campo com valor gravado em alguma OS não é
--   excluído (inative-o) e uma opção usada não é removida. Quem lê ordens de serviço lê os campos.
-- * Informar lotes: se cada produto tem "Controle de lote" e os lotes de um produto com a quantidade no depósito (ou nos depósitos
--   considerados); quem lê o documento e o estoque (também na consulta de um documento travado ou do perfil Consulta).
-- * Aba Comissões dos itens (pedido de venda e OS): a regra do vendedor (Cadastros › Vendedores: fixa ou por faixa de desconto) e os
--   Adicionais da base (Preferências › Vendas), só leitura, como o Financeiro › Comissões calcula ao lançar as contas.
-- * Busca da Descrição da linha (pedido de venda, proposta e OS): a mesma busca dos produtos (nome, código ou GTIN, só ativos) sem
--   matéria-prima, produto em processo, material de uso e consumo e ativo imobilizado (Tipo do item SPED 01, 03, 07 e 08); produtos sem
--   o tipo (como os espelhados do Origin) continuam na busca.
-- Nenhuma função existente é substituída. Nada escreve no Origin.
begin;

do $$begin
 if to_regclass('erp_documents.custom_field') is null then raise exception 'document_custom_fields_288_requires_287' using errcode='55000'; end if;
 if to_regprocedure('public.erp_document_custom_fields(uuid,text)') is not null then raise exception 'document_custom_fields_288_already_applied' using errcode='55000'; end if;
end$$;

-- ---------------------------------------------------------------- Campos customizados da OS
-- One field; `documents` (how many OS have a value) only for the administrador, who decides on Excluir.
create function erp_documents.custom_field_item(p_id uuid,p_counts boolean) returns jsonb language sql stable set search_path=pg_catalog as $function$
 select jsonb_build_object('id',f.id,'kind',f.kind,'field_type',f.field_type,'name',f.name,'hint',f.hint,'info',f.info,'required',f.required,
  'min_length',f.min_length,'max_length',f.max_length,'width',f.width,'options',f.options,'active',f.active,'version',f.version,
  'created_at',f.created_at,'updated_at',f.updated_at,
  'documents',case when p_counts then (select count(*) from erp_documents.document d where d.kind=f.kind and d.body->'custom_fields'?f.id::text)::integer end)
 from erp_documents.custom_field f where f.id=p_id
$function$;

create function public.erp_document_custom_fields(p_user_id uuid,p_kind text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_admin boolean;
begin
 if p_kind is distinct from 'service_orders' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 v_admin:=exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin');
 return jsonb_build_object('kind',p_kind,'can_manage',v_admin,
  'items',coalesce((select jsonb_agg(erp_documents.custom_field_item(f.id,v_admin) order by lower(f.name),f.id) from erp_documents.custom_field f where f.kind=p_kind),'[]'::jsonb),
  'data_mode','erp_native','operational_effects',false);
end $function$;

-- The drawer: every key present; the type never changes after creation; Tamanho mínimo/máximo only for integer, decimal, text and
-- long text (up to the size of the type); a list has 1 to 50 options with distinct labels, the ones kept carry their id.
create function erp_documents.custom_field_input(p_data jsonb,p_current erp_documents.custom_field) returns jsonb
language plpgsql volatile set search_path=pg_catalog as $function$
declare v_type text; v_size integer; v_min integer; v_max integer; v_options jsonb:='[]'::jsonb; o jsonb; v_id text; v_label text; v_ids text[]:='{}'; v_labels text[]:='{}';
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or (select count(*) from jsonb_object_keys(p_data))<>10
  or not(p_data?&array['field_type','name','hint','info','required','min_length','max_length','width','options','active']) then
  raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
 v_type:=p_data->>'field_type';
 if jsonb_typeof(p_data->'field_type') is distinct from 'string' or v_type not in('integer','decimal','list','text','long_text','boolean','date')
  or (p_current.id is not null and v_type<>p_current.field_type) then raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
 if jsonb_typeof(p_data->'required')<>'boolean' or jsonb_typeof(p_data->'active')<>'boolean' or jsonb_typeof(p_data->'width')<>'string'
  or p_data->>'width' not in('small','medium','large','extra_large') or jsonb_typeof(p_data->'options')<>'array' then
  raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
 v_size:=case v_type when 'integer' then 19 when 'decimal' then 22 when 'text' then 255 when 'long_text' then 4000 end;
 if p_data->'min_length'<>'null'::jsonb then
  if v_size is null or jsonb_typeof(p_data->'min_length')<>'number' or p_data->>'min_length'!~'^[1-9][0-9]{0,3}$' or (p_data->>'min_length')::integer>v_size then
   raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
  v_min:=(p_data->>'min_length')::integer; end if;
 if p_data->'max_length'<>'null'::jsonb then
  if v_size is null or jsonb_typeof(p_data->'max_length')<>'number' or p_data->>'max_length'!~'^[1-9][0-9]{0,3}$' or (p_data->>'max_length')::integer>v_size then
   raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
  v_max:=(p_data->>'max_length')::integer; end if;
 if v_min>v_max then raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
 if (v_type='list')<>(jsonb_array_length(p_data->'options') between 1 and 50) then raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
 for o in select value from jsonb_array_elements(p_data->'options') loop
  if jsonb_typeof(o)<>'object' or (select count(*) from jsonb_object_keys(o))<>2 or not(o?&array['id','label']) then
   raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
  v_label:=erp_documents.text_value(o->'label',60,true);
  if lower(v_label)=any(v_labels) then raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
  v_labels:=v_labels||lower(v_label);
  if o->'id'='null'::jsonb then v_id:=gen_random_uuid()::text;
  else
   v_id:=lower(erp_documents.text_value(o->'id',36,true));
   if v_id!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_id=any(v_ids) or p_current.id is null
    or not exists(select 1 from jsonb_array_elements(p_current.options) c where c->>'id'=v_id) then
    raise exception 'erp_document_custom_field_input_invalid' using errcode='22023'; end if;
  end if;
  v_ids:=v_ids||v_id;
  v_options:=v_options||jsonb_build_array(jsonb_build_object('id',v_id,'label',v_label));
 end loop;
 return jsonb_build_object('field_type',v_type,'name',erp_documents.text_value(p_data->'name',60,true),'hint',erp_documents.text_value(p_data->'hint',100),
  'info',erp_documents.text_value(p_data->'info',300,false,true),'required',p_data->'required','min_length',v_min,'max_length',v_max,'width',p_data->>'width',
  'options',v_options,'active',p_data->'active');
end $function$;

create function public.erp_document_custom_field_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; v_current erp_documents.custom_field; v_input jsonb; v_id uuid; v_before jsonb; v_result jsonb;
begin
 if p_kind is distinct from 'service_orders' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin') then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 if p_expected_version is null or p_expected_version<0 or (p_id is null)<>(p_expected_version=0) then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','custom_field_save','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,'data',p_data)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 -- One writer per kind: the limit of 60 fields and the unique name.
 perform 1 from erp_documents.numbering where kind=p_kind for update;
 if p_id is not null then
  select * into v_current from erp_documents.custom_field where id=p_id and kind=p_kind for update;
  if not found then raise exception 'erp_document_custom_field_not_found' using errcode='P0002'; end if;
  if v_current.version<>p_expected_version or v_current.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
  v_before:=erp_documents.custom_field_item(p_id,true);
 elsif (select count(*) from erp_documents.custom_field where kind=p_kind)>=60 then raise exception 'erp_document_custom_field_limit' using errcode='22023'; end if;
 v_input:=erp_documents.custom_field_input(p_data,v_current);
 if exists(select 1 from erp_documents.custom_field f where f.kind=p_kind and lower(f.name)=lower(v_input->>'name') and f.id is distinct from p_id) then
  raise exception 'erp_document_custom_field_duplicate' using errcode='22023'; end if;
 -- An option removed from the list must not be the value of any OS.
 if p_id is not null and exists(select 1 from jsonb_array_elements(v_current.options) o
   where not exists(select 1 from jsonb_array_elements(v_input->'options') n where n->>'id'=o->>'id')
    and exists(select 1 from erp_documents.document d where d.kind=p_kind and d.body#>>array['custom_fields',p_id::text]=o->>'id')) then
  raise exception 'erp_document_custom_field_option_in_use' using errcode='22023'; end if;
 if p_id is null then
  insert into erp_documents.custom_field(kind,field_type,name,hint,info,required,min_length,max_length,width,options,active,created_by,updated_by)
  values(p_kind,v_input->>'field_type',v_input->>'name',v_input->>'hint',v_input->>'info',(v_input->>'required')::boolean,(v_input->>'min_length')::integer,
   (v_input->>'max_length')::integer,v_input->>'width',v_input->'options',(v_input->>'active')::boolean,p_user_id,p_user_id) returning id into v_id;
 else
  v_id:=p_id;
  update erp_documents.custom_field set name=v_input->>'name',hint=v_input->>'hint',info=v_input->>'info',required=(v_input->>'required')::boolean,
   min_length=(v_input->>'min_length')::integer,max_length=(v_input->>'max_length')::integer,width=v_input->>'width',options=v_input->'options',
   active=(v_input->>'active')::boolean,version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'field',erp_documents.custom_field_item(v_id,true),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.custom_field_audit(actor,command_id,field_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,case when p_id is null then 'create' else 'update' end,v_before,v_result->'field');
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

create function public.erp_document_custom_field_delete(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; v_current erp_documents.custom_field; v_before jsonb; v_result jsonb;
begin
 if p_kind is distinct from 'service_orders' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and m.role='admin') then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','custom_field_delete','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 perform 1 from erp_documents.numbering where kind=p_kind for update;
 select * into v_current from erp_documents.custom_field where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_custom_field_not_found' using errcode='P0002'; end if;
 if v_current.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document d where d.kind=p_kind and d.body->'custom_fields'?p_id::text) then
  raise exception 'erp_document_custom_field_in_use' using errcode='22023'; end if;
 v_before:=erp_documents.custom_field_item(p_id,true);
 delete from erp_documents.custom_field where id=p_id;
 v_result:=jsonb_build_object('kind',p_kind,'deleted',p_id,'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.custom_field_audit(actor,command_id,field_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,'delete',v_before,null);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

-- ---------------------------------------------------------------- Informar lotes
-- Whether each product of the document has "Controle de lote" (up to 250 products).
create function public.erp_document_lot_products(p_user_id uuid,p_kind text,p_product_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_product_ids is null or cardinality(p_product_ids) not between 1 and 250
  or array_position(p_product_ids,null) is not null or (select count(distinct x) from unnest(p_product_ids) x)<>cardinality(p_product_ids) then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 return jsonb_build_object('kind',p_kind,'items',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.record_id,'lot_control',coalesce(d.lot_control,false)) order by p.record_id)
   from erp_catalog.product p left join erp_catalog.product_detail d on d.record_id=p.record_id where p.record_id=any(p_product_ids)),'[]'::jsonb),
  'data_mode','erp_native','operational_effects',false);
end $function$;
-- The lots of one product (active first, at most 100) with the quantity in the depósito of the document (or the considered ones).
create function public.erp_document_lot_options(p_user_id uuid,p_kind text,p_product_id uuid,p_warehouse_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_product jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_product_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 -- Reading the lots writes nothing: whoever reads the document and the stock sees them (Informar lotes of a locked document).
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_stock.require_access(p_user_id,false);
 select jsonb_build_object('id',r.id,'name',left(r.name,200),'code',r.code,'unit',p.unit,'lot_control',coalesce(d.lot_control,false)) into v_product
  from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id left join erp_catalog.product_detail d on d.record_id=r.id where r.id=p_product_id;
 if v_product is null then raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse w where w.record_id=p_warehouse_id) then raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 return jsonb_build_object('kind',p_kind,'product',v_product,'warehouse_id',p_warehouse_id,
  'total',(select count(*) from erp_stock.lot l where l.product_id=p_product_id)::integer,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'manufactured_on',x.manufactured_on,'expires_on',x.expires_on,'active',x.active,
    'quantity',erp_stock.lot_quantity(x.id,p_warehouse_id)::numeric(18,6)::text) order by x.active desc,x.expires_on nulls last,lower(x.code),x.id)
   from (select * from erp_stock.lot l where l.product_id=p_product_id order by l.active desc,l.expires_on nulls last,lower(l.code),l.id limit 100) x),'[]'::jsonb),
  'data_mode','erp_native','operational_effects',false);
end $function$;

-- ---------------------------------------------------------------- Aba Comissões
-- The commission rule of a vendedor (fixa or by the discount of the item) and the Adicionais da base of Preferências › Vendas.
create function public.erp_document_seller_commission(p_user_id uuid,p_kind text,p_seller_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare s erp_catalog.seller; v_extra jsonb:=coalesce(erp_documents.preference('vendas.base_comissao'),'[]'::jsonb);
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders') or p_seller_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select * into s from erp_catalog.seller where id=p_seller_id;
 if not found then raise exception 'erp_document_seller_unavailable' using errcode='22023'; end if;
 return jsonb_build_object('kind',p_kind,'seller_id',s.id,'mode',s.commission_mode,'rate',case when s.commission_rate is null then null else s.commission_rate::numeric(7,4)::text end,
  'bands',coalesce((select jsonb_agg(jsonb_build_object('discount_up_to',(b->>'discount_up_to')::numeric(7,4)::text,'rate',(b->>'rate')::numeric(7,4)::text)
   order by (b->>'discount_up_to')::numeric) from jsonb_array_elements(s.commission_bands) b),'[]'::jsonb),
  'additions',to_jsonb(array(select x from unnest(array['desconto','frete']) x where jsonb_typeof(v_extra)='array' and v_extra?x)),
  'data_mode','erp_native','operational_effects',false);
end $function$;

-- ---------------------------------------------------------------- Busca da Descrição da linha
-- erp_catalog_product_list (096/119) for the active products, without the item types that are not sold.
create function public.erp_document_product_search(p_user_id uuid,p_kind text,p_query text,p_limit integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_terms text[]; v_items jsonb; v_more boolean; v_last uuid;
begin
 if p_kind is null or p_kind not in('sales_orders','sales_proposals','service_orders') or p_limit is null or p_limit not between 1 and 25
  or p_query is null or char_length(btrim(p_query)) not between 2 and 120 or p_query~'[[:cntrl:]]' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,true);
 perform erp_catalog.require_access(p_user_id,'products',false);
 v_terms:=erp_catalog.search_terms(p_query);
 with page as materialized(
  select r.id from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.entity='products' and r.active
   and not exists(select 1 from erp_catalog.product_detail d where d.record_id=r.id and (d.deleted_at is not null or d.item_type in('01','03','07','08')))
   and(v_terms is null or erp_catalog.matches(v_terms,erp_catalog.fold(concat_ws(' ',r.name,r.code,p.gtin)),regexp_replace(lower(coalesce(p.gtin,'')),'[^0-9a-z]','','g'),regexp_replace(coalesce(p.gtin,''),'[^0-9]','','g')))
  order by r.id limit p_limit+1)
 select coalesce((select jsonb_agg(erp_catalog.dto(x.id) order by x.id) from (select id from page order by id limit p_limit) x),'[]'::jsonb),(select count(*)>p_limit from page),
  (select x.id from (select id from page order by id limit p_limit) x order by x.id desc limit 1)
  into v_items,v_more,v_last;
 return jsonb_build_object('entity','products','items',v_items,'has_more',v_more,'next_cursor',case when v_more then v_last end,'limit',p_limit,
  'data_mode','erp_native','operational_effects',false);
end $function$;

revoke all on function erp_documents.custom_field_item(uuid,boolean),erp_documents.custom_field_input(jsonb,erp_documents.custom_field) from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_document_custom_fields(uuid,text)','erp_document_custom_field_save(uuid,text,uuid,integer,uuid,jsonb)',
  'erp_document_custom_field_delete(uuid,text,uuid,integer,uuid)','erp_document_lot_products(uuid,text,uuid[])','erp_document_lot_options(uuid,text,uuid,uuid)',
  'erp_document_seller_commission(uuid,text,uuid)','erp_document_product_search(uuid,text,text,integer)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
