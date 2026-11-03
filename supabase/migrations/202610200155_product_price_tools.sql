-- Ferramentas de preço do cadastro de produtos (produtos lane, onda C):
--  * "Reajuste e sincronização de preços" da listagem (Origin): Acrescer | Descontar em R$ ou %, Fixar, para os Produtos
--    selecionados (com a versão de cada um) ou os Produtos filtrados (os filtros da listagem v2, até 5.000), com a prévia
--    "Novo Preço" e a aplicação num comando idempotente: cada produto alterado ganha nova versão e auditoria. Percentual
--    arredonda o preço a duas casas (arredondamento comercial, como o Origin mostra); R$ e Fixar são exatos. Preço negativo,
--    produto sem preço (para acrescer/descontar), excluído ou alterado por outra operação fica de fora e aparece no resumo.
--    "Copiar" (preço de canal) e "Sincronizar com loja virtual" dependem de lojas e ficam fora do escopo.
--  * Informações de compra dos produtos (pedido de compra): fornecedor padrão, os dados do fornecedor escolhido, o preço da
--    última compra e o preço sugerido conforme Preferências > Configurações de pedidos de compra (preco_padrao / tipo).
--  * "Atualizar preços" da Formação de preços (nota de entrada): preço de venda e preço de custo do fornecedor da nota, com a
--    versão de cada produto, num comando.
-- Nada aqui gera estoque, título financeiro, imposto, XML ou escrita no Origin. Depende de 057, 096, 115, 119 e 120.
begin;

-- Regra do reajuste: {action: increase|discount|fix, unit: amount|percent, value: "10.5"} (Fixar só em R$; desconto em % até 100).
create function erp_catalog.price_rule_valid(p_rule jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_typeof(p_rule)='object' and not exists(select 1 from jsonb_object_keys(p_rule) k where k not in('action','unit','value'))
  and p_rule->>'action' in('increase','discount','fix') and p_rule->>'unit' in('amount','percent')
  and jsonb_typeof(p_rule->'value')='string' and p_rule->>'value'~'^(0|[1-9][0-9]{0,12})(\.[0-9]{1,4})?$'
  and(p_rule->>'action'<>'fix' or p_rule->>'unit'='amount')
  and(p_rule->>'action'<>'discount' or p_rule->>'unit'<>'percent' or(p_rule->>'value')::numeric<=100),false)
$$;
-- New price, or a reason: no_price (acrescer/descontar without a sale price), negative, too_large (above 14 integer digits).
create function erp_catalog.price_rule_result(p_price numeric,p_rule jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v numeric:=(p_rule->>'value')::numeric; r numeric; s integer:=case p_rule->>'action' when 'discount' then -1 else 1 end;
begin
 if p_rule->>'action'='fix' then r:=v;
 elsif p_price is null then return jsonb_build_object('status','no_price');
 elsif p_rule->>'unit'='percent' then r:=round(p_price*(1+s*v/100),2);
 else r:=p_price+s*v; end if;
 if r<0 then return jsonb_build_object('status','negative'); end if;
 if r>=100000000000000 or r<>trunc(r,10) then return jsonb_build_object('status','too_large'); end if;
 return jsonb_build_object('status',case when r is not distinct from p_price then 'unchanged' else 'ok' end,'price',erp_catalog.unit_price_numeric(r,14));
end $$;

-- Prévia "Novo Preço" dos produtos visíveis (até 100). Somente leitura.
create function public.erp_catalog_product_price_preview(p_user_id uuid,p_rule jsonb,p_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if not erp_catalog.price_rule_valid(p_rule) or p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null
  or(select count(distinct x) from unnest(p_ids) x)<>cardinality(p_ids) then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 return jsonb_build_object('entity','products','data_mode','erp_native','items',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'price',erp_catalog.unit_price_numeric(p.price,14),
   'status',x.r->>'status','new_price',x.r->>'price') order by u.n)
  from unnest(p_ids) with ordinality u(id,n) join erp_catalog.product p on p.record_id=u.id left join erp_catalog.product_detail d on d.record_id=u.id
  cross join lateral(select case when d.deleted_at is not null then jsonb_build_object('status','deleted') else erp_catalog.price_rule_result(p.price,p_rule) end r) x),'[]'::jsonb));
end $$;

-- Aplicação. p_items: [{id, expected_version}] (Produtos selecionados, até 100) ou p_filters: os filtros da listagem v2 (Produtos
-- filtrados, até 5.000; Excluídos não). Os produtos são travados em ordem de UUID; cada um alterado ganha versão e auditoria.
create function public.erp_catalog_product_price_adjust(p_user_id uuid,p_command_id uuid,p_rule jsonb,p_items jsonb default null,p_filters jsonb default null)
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
    'item_type','supplier_id','supplier_code','period','from','to'))
   or exists(select 1 from jsonb_each(f) e where jsonb_typeof(e.value) not in('string','null')) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
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
  v_filter:=erp_catalog.product_stock_filter(f->>'stock',(f->>'warehouse_id')::uuid);
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
-- Informações de compra (pedido de compra): até 100 produtos, com o fornecedor do pedido (opcional).
create function erp_catalog.purchase_price_mode() returns text
language sql stable set search_path=pg_catalog as $$
 select case when coalesce(erp_preferences.get('compras.preco_padrao'),'false'::jsonb)='true'::jsonb
  then case when erp_preferences.get('compras.preco_padrao_tipo')='"compra"'::jsonb then 'purchase' else 'cost' end else 'last_purchase' end
$$;
create function public.erp_catalog_product_purchase_info(p_user_id uuid,p_product_ids uuid[],p_supplier_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_mode text:=erp_catalog.purchase_price_mode(); v_orders boolean;
begin
 perform erp_catalog.require_access(p_user_id,'products',false);
 if p_product_ids is null or cardinality(p_product_ids) not between 1 and 100 or array_position(p_product_ids,null) is not null
  or(select count(distinct x) from unnest(p_product_ids) x)<>cardinality(p_product_ids) then raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 -- The last purchase comes from purchase orders: only a profile that may read them sees it (Vendas reads products, not purchases).
 v_orders:=exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and erp_documents.allowed(m.role,'purchase_orders',false));
 return jsonb_build_object('entity','products','data_mode','erp_native','supplier_id',p_supplier_id,'mode',v_mode,'items',coalesce((select jsonb_agg(x.item order by x.n) from(
  select u.n,jsonb_build_object('product_id',u.id,'version',r.version,'name',r.name,'code',r.code,'price',erp_catalog.unit_price_numeric(p.price,14),'deleted',d.deleted_at is not null,
   'default_supplier',(select jsonb_build_object('id',s.supplier_id,'name',c.name) from erp_catalog.product_supplier s join erp_catalog.record c on c.id=s.supplier_id where s.record_id=u.id and s.is_default),
   'supplier',(select jsonb_build_object('id',s.supplier_id,'code',s.code,'description',s.description,'purchase_price',erp_catalog.unit_price_numeric(s.purchase_price,14),
     'cost_price',erp_catalog.unit_price_numeric(s.cost_price,14)) from erp_catalog.product_supplier s where s.record_id=u.id and s.supplier_id=p_supplier_id),
   'last_purchase_price',lp.price,
   'suggested_price',erp_catalog.unit_price_numeric(case v_mode
     when 'cost' then coalesce(nullif(sp.cost_price,0),nullif(sp.purchase_price,0))
     when 'purchase' then coalesce(nullif(sp.purchase_price,0),nullif(sp.cost_price,0))
     else coalesce(lp.raw,nullif(sp.purchase_price,0),nullif(sp.cost_price,0)) end,14)) item
  from unnest(p_product_ids) with ordinality u(id,n)
  join erp_catalog.record r on r.id=u.id and r.entity='products' join erp_catalog.product p on p.record_id=u.id left join erp_catalog.product_detail d on d.record_id=u.id
  -- The supplier of the order when the product has it, else the default supplier of the product.
  left join lateral(select s.purchase_price,s.cost_price from erp_catalog.product_supplier s where s.record_id=u.id and(s.supplier_id=p_supplier_id or(s.is_default and not exists(
    select 1 from erp_catalog.product_supplier o where o.record_id=u.id and o.supplier_id=p_supplier_id))) order by s.supplier_id=p_supplier_id desc limit 1) sp on true
  -- Última compra: the latest purchase order (any supplier, not cancelled) with this product, by the order date.
  left join lateral(select i.unit_price raw,erp_catalog.unit_price_numeric(i.unit_price,14) price from erp_documents.item i join erp_documents.document o on o.id=i.document_id
    where v_orders and i.product_id=u.id and o.kind='purchase_orders' and o.status<>'cancelled' order by o.body->>'date' desc nulls last,o.created_at desc,i.position limit 1) lp on true) x),'[]'::jsonb));
end $$;

-- "Atualizar preços" (Formação de preços da nota de entrada): preço de venda e/ou preço de custo do fornecedor informado, com a
-- versão de cada produto; um produto alterado por outra operação recusa o comando inteiro (nada é gravado).
create function public.erp_catalog_product_prices_update(p_user_id uuid,p_command_id uuid,p_supplier_id uuid,p_items jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_item jsonb; v_row erp_catalog.record%rowtype; v_price text; v_cost text; v_before jsonb; v_out jsonb:='[]'::jsonb; v_result jsonb; v_position integer;
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
 v_result:=jsonb_build_object('entity','products','supplier_id',p_supplier_id,'items',v_out,'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_product_price_preview(uuid,jsonb,uuid[])','erp_catalog_product_price_adjust(uuid,uuid,jsonb,jsonb,jsonb)',
  'erp_catalog_product_purchase_info(uuid,uuid[],uuid)','erp_catalog_product_prices_update(uuid,uuid,uuid,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
