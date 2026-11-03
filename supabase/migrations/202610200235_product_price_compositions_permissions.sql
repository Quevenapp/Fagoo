-- Cadastro de produtos no padrão do Origin, onda E (área de produtos), parte 2: composições nas ferramentas de preço e as
-- permissões de Campos Customizados.
-- * Preferências > Cadastros > Configurações de produtos > "Atualizar preço de custo / peso / preço de venda das composições com
--   base nos componentes" (migração 222) passam a valer também no reajuste de preços da listagem (erp_catalog_product_price_adjust),
--   na formação de preços da nota de entrada (erp_catalog_product_prices_update) e no preço na linha da listagem
--   (erp_catalog_save de um produto existente): as composições que usam um produto alterado são recalculadas pela função do
--   estoque (erp_stock.composition_apply_values), cada uma com o comando derivado, a versão e a auditoria do cadastro da
--   composição. Uma composição alterada pelo próprio comando fica com o valor do comando. As respostas não mudam.
--   Ordem de travas: os produtos do comando e as composições que os usam, por UUID, antes da primeira gravação (a mesma ordem da
--   gravação de um componente pelo formulário, 222).
-- * Listagem > filtro "Componente" também no conjunto "Produtos filtrados" do reajuste (filters.component_id).
-- * Sistema > Usuários > Permissões > Preferências > Campos Customizados (migração 229): a tela Campos Customizados exige
--   "Campos Customizados" e "Produtos"; incluir e editar exigem também "Inclusão e edição"; excluir, "Exclusão". O formulário do
--   produto continua lendo e gravando os valores dos campos (a permissão é da tela de Preferências, como no Origin).
-- Nada aqui escreve no Origin, gera estoque, título, imposto ou XML. Depende de 155/156/191/222/229/234.
begin;

-- Replaced bodies must still be the published ones (CR stripped so a CRLF checkout hashes the same text).
do $$declare r record;begin
 if to_regprocedure('erp_stock.composition_apply_values(uuid,uuid,uuid,boolean)') is null or to_regprocedure('erp_access.permitted(uuid,text)') is null
  or to_regprocedure('erp_catalog.product_component_filter(uuid)') is null then
  raise exception 'product_prices_235_requires_222_229_234' using errcode='55000'; end if;
 for r in select * from(values
  ('public.erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)','7cc515eb4c07df9ccd28553ababdaaf701ca6be7884c7a027066e28e56ad0b1e'),
  ('public.erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)','4096be383af2fda2de3182859956b993272c16e40994b26dd9197972d070f336'),
  ('public.erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb)','b0fc0e6c676bc2a3a3e5820e4cd1610e1516fb837e0c868d257217a4d77a8bea'),
  ('public.erp_catalog_custom_field_save(uuid,uuid,integer,uuid,jsonb)','8075adb67a6577fc60ed038d6ea42eb6c49189b863f491a90c36e4bf0cd45e79'),
  ('public.erp_catalog_custom_field_delete(uuid,uuid,integer,uuid)','2a5bfe486d7686fe5c5254e4bd2b287b1371b3a74b6b9be8821b43718ceab754'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(r.sig)) is distinct from r.expected then
   raise exception 'product_prices_235_previous_definition_changed %',r.sig using errcode='55000'; end if;
 end loop;
end$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Composições dos produtos alterados. A recalculation already running (the cost of a composition goes through
-- erp_catalog_product_prices_update) does not start another one.
create function erp_catalog.composition_sync_on() returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce(current_setting('erp_catalog.composition_sync',true),'')<>'on'
  and coalesce((select(s->>'update_cost')::boolean or(s->>'update_weight')::boolean or(s->>'update_price')::boolean from erp_stock.composition_settings() s),false)
$$;
-- The compositions ("Com composição", current structure) that use one of the products, without the products themselves, in UUID order.
create function erp_catalog.composition_kits(p_products uuid[]) returns uuid[]
language sql stable set search_path=pg_catalog as $$
 select coalesce(array_agg(distinct i.product_id order by i.product_id),'{}'::uuid[]) from erp_stock.composition_current i
  join erp_catalog.product k on k.record_id=i.product_id where i.component_id=any(p_products) and k.format='E' and not i.product_id=any(p_products)
$$;
-- Recalculates each composition with the Preferências of 222 (price, weights and the cost of its default supplier). Returns how many
-- compositions changed.
create function erp_catalog.composition_sync(p_user_id uuid,p_command_id uuid,p_kits uuid[]) returns integer
language plpgsql set search_path=pg_catalog as $$
declare v_kit uuid; v_out jsonb; v_count integer:=0;
begin
 if p_kits is null or cardinality(p_kits)=0 then return 0; end if;
 perform set_config('erp_catalog.composition_sync','on',true);
 foreach v_kit in array p_kits loop
  v_out:=erp_stock.composition_apply_values(p_user_id,p_command_id,v_kit);
  if coalesce(v_out,'{}'::jsonb)-'skipped'-'cost_skipped'<>'{}'::jsonb then v_count:=v_count+1; end if;
 end loop;
 perform set_config('erp_catalog.composition_sync','',true);
 return v_count;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reajuste de preços (191) com o filtro Componente e as composições dos produtos reajustados.
create or replace function public.erp_catalog_product_price_adjust(p_user_id uuid,p_command_id uuid,p_rule jsonb,p_items jsonb default null,p_filters jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_ids uuid[]; v_expected jsonb:='{}'::jsonb; v_row record; v_result jsonb; v_outcome jsonb;
 v_applied integer:=0; v_unchanged integer:=0; v_skipped jsonb:='[]'::jsonb; v_skipped_total integer:=0; f jsonb:=p_filters; v_filter uuid[]; v_period text;
 v_from date; v_to date; v_before jsonb; v_sync boolean; v_changed uuid[]:='{}'::uuid[];
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
    'item_type','supplier_id','supplier_code','period','from','to','custom','component_id'))
   or exists(select 1 from jsonb_each(f) e where e.key<>'custom' and jsonb_typeof(e.value) not in('string','null'))
   or(f?'custom' and jsonb_typeof(f->'custom') not in('array','null')) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
  v_period:=f->>'period';
  begin v_from:=(f->>'from')::date; v_to:=(f->>'to')::date; exception when others then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end;
  if coalesce(f->>'situation','latest')='deleted' or(f->>'warehouse_id' is not null and f->>'warehouse_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(f->>'supplier_id' is not null and f->>'supplier_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or(f->>'component_id' is not null and(f->>'component_id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or not erp_catalog.product_component_valid(f->>'product_type',(f->>'component_id')::uuid)))
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
  v_filter:=erp_catalog.product_ids_and(erp_catalog.product_ids_and(erp_catalog.product_stock_filter(f->>'stock',(f->>'warehouse_id')::uuid),erp_catalog.product_custom_filter(f->'custom')),
   erp_catalog.product_component_filter((f->>'component_id')::uuid));
  execute 'select coalesce(array_agg(r.id order by r.id),''{}''::uuid[])'||erp_catalog.product_filter_sql(v_period) into v_ids
   using coalesce(f->>'situation','latest'),erp_catalog.search_terms(f->>'query'),f->>'product_type',f->>'ncm_presence',f->>'ncm',nullif(btrim(f->>'brand'),''),v_filter,f->>'images',f->>'tag',f->>'category',
    f->>'item_type',(f->>'supplier_id')::uuid,nullif(btrim(f->>'supplier_code'),''),
    case when v_period in('created','updated') and v_from is not null then v_from::timestamp at time zone 'America/Sao_Paulo' end,
    case when v_period in('created','updated') and v_to is not null then(v_to+1)::timestamp at time zone 'America/Sao_Paulo' end,
    case when v_period='expiry' then v_from end,case when v_period='expiry' then v_to end,null::boolean,false;
  if cardinality(v_ids)>5000 then raise exception 'erp_catalog_adjust_too_many' using errcode='22023'; end if;
 end if;
 -- 222/235: with a composition preference on, the products and the compositions that use them are locked in UUID order first.
 v_sync:=erp_catalog.composition_sync_on();
 if v_sync then perform 1 from erp_catalog.record where id=any(v_ids||erp_catalog.composition_kits(v_ids)) order by id for update; end if;
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
   v_applied:=v_applied+1; v_changed:=v_changed||v_row.id;
  elsif v_outcome->>'status'='unchanged' then v_unchanged:=v_unchanged+1;
  else
   v_skipped_total:=v_skipped_total+1;
   if jsonb_array_length(v_skipped)<50 then v_skipped:=v_skipped||jsonb_build_array(jsonb_build_object('id',v_row.id,'name',v_row.name,'reason',v_outcome->>'status')); end if;
  end if;
 end loop;
 if v_sync and cardinality(v_changed)>0 then perform erp_catalog.composition_sync(p_user_id,p_command_id,erp_catalog.composition_kits(v_changed)); end if;
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

-- Formação de preços da nota de entrada (155) com as composições dos produtos atualizados.
create or replace function public.erp_catalog_product_prices_update(p_user_id uuid,p_command_id uuid,p_supplier_id uuid,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_item jsonb; v_row erp_catalog.record%rowtype; v_price text; v_cost text; v_before jsonb; v_out jsonb:='[]'::jsonb; v_result jsonb; v_position integer;
 v_ids uuid[]; v_sync boolean;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 if p_command_id is null or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in('product_id','expected_version','price','cost_price'))
   or erp_catalog.detail_uuid(x->'product_id') is null or jsonb_typeof(x->'expected_version')<>'number' or(x->>'expected_version')!~'^[1-9][0-9]{0,9}$' or(x->>'expected_version')::bigint>2147483647
   or(not x?'price' and not x?'cost_price') or jsonb_typeof(coalesce(x->'price','"0"'))<>'string' or jsonb_typeof(coalesce(x->'cost_price','"0"'))<>'string')
  or(select count(distinct x->>'product_id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items)
  or(p_supplier_id is null and exists(select 1 from jsonb_array_elements(p_items) x where x?'cost_price')) then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if p_supplier_id is not null and not exists(select 1 from erp_catalog.contact where record_id=p_supplier_id) then raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','prices_update','supplier',p_supplier_id,'items',p_items)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 -- 222/235: with a composition preference on, the products and the compositions that use them are locked in UUID order first.
 v_ids:=array(select(x->>'product_id')::uuid from jsonb_array_elements(p_items) x);
 v_sync:=erp_catalog.composition_sync_on();
 if v_sync then perform 1 from erp_catalog.record where id=any(v_ids||erp_catalog.composition_kits(v_ids)) order by id for update; end if;
 for v_item in select x from jsonb_array_elements(p_items) x order by(x->>'product_id')::uuid loop
  select * into v_row from erp_catalog.record where id=(v_item->>'product_id')::uuid and entity='products' for update;
  if not found then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  if v_row.version<>(v_item->>'expected_version')::integer then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
  if exists(select 1 from erp_catalog.product_detail where record_id=v_row.id and deleted_at is not null) then raise exception 'erp_catalog_product_deleted' using errcode='40001'; end if;
  if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
  v_price:=case when v_item?'price' then erp_catalog.unit_price(v_item->'price',14) end; v_cost:=case when v_item?'cost_price' then erp_catalog.unit_price(v_item->'cost_price',14) end;
  v_before:=jsonb_build_object('price',(select erp_catalog.unit_price_numeric(price,14) from erp_catalog.product where record_id=v_row.id),
   'cost_price',(select erp_catalog.unit_price_numeric(cost_price,14) from erp_catalog.product_supplier where record_id=v_row.id and supplier_id=p_supplier_id));
  if v_price is not null then update erp_catalog.product set price=v_price::numeric where record_id=v_row.id; end if;
  if v_cost is not null then
   update erp_catalog.product_supplier set cost_price=v_cost::numeric where record_id=v_row.id and supplier_id=p_supplier_id;
   if not found then
    select coalesce(max(position),0)+1 into v_position from erp_catalog.product_supplier where record_id=v_row.id;
    if v_position>20 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
    insert into erp_catalog.product_supplier(record_id,position,supplier_id,cost_price,is_default)
     values(v_row.id,v_position,p_supplier_id,v_cost::numeric,not exists(select 1 from erp_catalog.product_supplier where record_id=v_row.id));
   end if;
  end if;
  update erp_catalog.record set version=version+1,human_edited=true,updated_by=p_user_id,updated_at=clock_timestamp() where id=v_row.id;
  update erp_catalog.origin set state=case when state in('source_changed','source_deleted') then state else 'local_modified' end where record_id=v_row.id;
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
   values(p_user_id,p_command_id,'products',v_row.id,'prices_update',v_before,jsonb_build_object('price',coalesce(v_price,v_before->>'price'),'cost_price',coalesce(v_cost,v_before->>'cost_price'),'supplier_id',p_supplier_id));
  v_out:=v_out||jsonb_build_array(jsonb_build_object('product_id',v_row.id,'version',v_row.version+1,
   'price',(select erp_catalog.unit_price_numeric(price,14) from erp_catalog.product where record_id=v_row.id),
   'cost_price',(select erp_catalog.unit_price_numeric(cost_price,14) from erp_catalog.product_supplier where record_id=v_row.id and supplier_id=p_supplier_id)));
 end loop;
 if v_sync then perform erp_catalog.composition_sync(p_user_id,p_command_id,erp_catalog.composition_kits(v_ids)); end if;
 v_result:=jsonb_build_object('entity','products','supplier_id',p_supplier_id,'items',v_out,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

-- Gravação comum do catálogo (191): o preço na linha da listagem (e o peso pelas rotas antigas) de um produto existente também
-- recalcula as composições que o usam. O resto do corpo é o publicado em 191.
create or replace function public.erp_catalog_save(p_user_id uuid,p_entity text,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_data jsonb:=p_data; v_done jsonb; v_origin jsonb; v_kits uuid[]; v_result jsonb;
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
 if p_entity='products' and p_id is not null and jsonb_typeof(p_data)='object' and(p_data?'price' or p_data?'net_weight' or p_data?'gross_weight')
  and erp_catalog.composition_sync_on() then
  perform erp_catalog.require_access(p_user_id,'products',true);
  v_kits:=erp_catalog.composition_kits(array[p_id]);
  if cardinality(v_kits)>0 then perform 1 from erp_catalog.record where id=p_id or id=any(v_kits) order by id for update; end if;
 end if;
 v_result:=erp_catalog.mutate(p_user_id,p_entity,p_id,p_expected_version,p_command_id,v_data,false,null);
 if cardinality(v_kits)>0 and v_result->>'replayed'='false' then perform erp_catalog.composition_sync(p_user_id,p_command_id,erp_catalog.composition_kits(array[p_id])); end if;
 return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Permissões de Campos Customizados (229): view = "Campos Customizados" e "Produtos"; ie/ex também "Inclusão e edição"/"Exclusão".
create function erp_catalog.custom_field_permitted(p_user_id uuid,p_action text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select p_action in('view','ie','ex') and erp_access.permitted(p_user_id,'preferencias.campos_customizados') and erp_access.permitted(p_user_id,'preferencias.campos_customizados.produtos')
  and(p_action='view' or erp_access.permitted(p_user_id,'preferencias.campos_customizados.'||p_action))
$$;
create function erp_catalog.require_custom_field_permission(p_user_id uuid,p_action text) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if not erp_catalog.custom_field_permitted(p_user_id,p_action) then raise exception 'erp_access_permission_denied' using errcode='42501'; end if;
end $$;

-- Tela Campos Customizados (aba Produtos): a lista de 156 e o que o usuário pode fazer nela.
create function public.erp_catalog_custom_fields_screen(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_catalog.require_access(p_user_id,'products',false);
 perform erp_catalog.require_custom_field_permission(p_user_id,'view');
 return public.erp_catalog_custom_fields(p_user_id,'products')||jsonb_build_object('permissions',jsonb_build_object(
  'insert_edit',erp_catalog.allowed(v_role,'products',true) and erp_catalog.custom_field_permitted(p_user_id,'ie'),
  'delete',erp_catalog.allowed(v_role,'products',true) and erp_catalog.custom_field_permitted(p_user_id,'ex')));
end $$;

-- Gaveta "Adicionar campo" / "Editar Campo" (156) com a permissão "Inclusão e edição". O resto do corpo é o publicado em 156.
create or replace function public.erp_catalog_custom_field_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.custom_field%rowtype; v_new erp_catalog.custom_field%rowtype; v_id uuid;
 v_before jsonb; v_after jsonb; v_result jsonb; v_cap integer; v_options jsonb; v_option jsonb; v_categories uuid[]; v_removed uuid[]; v_used integer; v_n integer;
 v_text text; v_old uuid[]; v_touched uuid[]; v_cat uuid; v_cat_before jsonb;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 perform erp_catalog.require_custom_field_permission(p_user_id,'ie');
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

-- Exclusão (156) com a permissão "Exclusão". O resto do corpo é o publicado em 156.
create or replace function public.erp_catalog_custom_field_delete(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_row erp_catalog.custom_field%rowtype; v_before jsonb; v_result jsonb; v_used integer;
begin
 perform erp_catalog.require_access(p_user_id,'products',true);
 perform erp_catalog.require_custom_field_permission(p_user_id,'ex');
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

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)','erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)',
  'erp_catalog_save(uuid,text,uuid,integer,uuid,jsonb)','erp_catalog_custom_fields_screen(uuid)','erp_catalog_custom_field_save(uuid,uuid,integer,uuid,jsonb)',
  'erp_catalog_custom_field_delete(uuid,uuid,integer,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
