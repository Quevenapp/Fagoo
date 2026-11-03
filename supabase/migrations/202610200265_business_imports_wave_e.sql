-- 265: Meu Negócio com o custo médio e os blocos de composições da Previsão de Estoque, e as importações de composições, campos
-- customizados e fornecedores de produtos.
-- * Preço de custo dos dashboards (Margem por Pedido, Mensal, Diário, Pedidos de Venda, Curva ABC, Novos x Recorrentes): o custo
--   médio do estoque (erp_stock.average_costs, com a base escolhida em Preferências › Estoque), calculado uma vez por consulta;
--   sem custo médio (produto sem entrada com preço), o "Preço de custo" do fornecedor padrão do produto; sem ele, o preço da
--   última compra (a regra de 150). O frete do vendedor continua sendo o frete do pedido.
-- * Previsão de Estoque, Giro de Produto (erp_home_business_forecast_v2): "Variações + Simples + Composições" lista cada produto
--   vendido, com o tipo da composição (Físico ou Virtual; a Virtual mostra o saldo que os componentes permitem); "Desmembrados" troca
--   cada composição com estrutura pelos seus componentes (quantidade vendida × quantidade por composição). "Produtos" (variações
--   agrupadas no produto pai) não existe: o Brufap não tem produtos com variações. erp_home_business_panel aceita p_mode.
-- * Importações de Dados: composições (a estrutura de cada produto, pela RPC da aba Estrutura, erp_stock_product_compose),
--   campos customizados (os valores de um produto pelo nome do campo, pela gravação do produto) e fornecedores de produtos (um
--   fornecedor por linha, incluído ou atualizado na lista do produto, pela gravação do produto). Cada linha passa pelas regras da
--   tela do módulo; nada aqui grava estoque, financeiro ou fiscal.
-- Substitui erp_home.biz_lines (150), erp_home_business_panel (229), erp_preferences.import_item e erp_preferences_import_batch
-- (228), conferidas pelo hash; qualquer outra versão interrompe a migração. Requer 145, 222 e 228.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_home.biz_lines(date,date,text[])','a865e35a04a8f2330d67a8fe7975109a01a9de377fb8f4e0b6b1190bcf7b972d'),
  ('public.erp_home_business_panel(uuid,text,jsonb)','41f3d6d4fe55ab1774ce5d2d450922303b131c1cc96b635ae3ef2587c56922a2'),
  ('erp_preferences.import_item(uuid,text,uuid,text,jsonb)','25d33a15885988ba4310b05435fd007f963d5f5af4573df7956c08ab5ce561e4'),
  ('public.erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb)','6156a22d5afaad6514992f682dd87f40dc23e785cef2ae486e90aac46430c6d4')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'business_imports_265_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
 if to_regprocedure('erp_stock.average_costs(uuid[])') is null or to_regprocedure('erp_stock.virtual_quantity(uuid,uuid)') is null
  or to_regprocedure('public.erp_stock_product_compose(uuid,uuid,integer,uuid,jsonb,jsonb,jsonb)') is null or to_regclass('erp_stock.composition_current') is null then
  raise exception 'business_imports_265_requires_145_222' using errcode='55000';end if;
end$$;

-- Preço de custo of a product line: the custo médio (null or zero: unknown), else the Preço de custo of the default supplier, else
-- the price of the latest purchase order (150).
create function erp_home.biz_cost(p_product uuid,p_average numeric) returns numeric language sql stable set search_path=pg_catalog as $$
 select coalesce(nullif(p_average,0),(select s.cost_price from erp_catalog.product_supplier s where s.record_id=p_product and s.is_default limit 1),erp_home.biz_unit_cost(p_product))
$$;

-- The job of the three new kinds (228 accepted only the first eight).
alter table erp_preferences.import_job drop constraint import_job_kind_check;
alter table erp_preferences.import_job add constraint import_job_kind_check check(kind in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe',
 'compositions','custom_fields','product_suppliers'));


create function public.erp_home_business_forecast_v2(p_user_id uuid,p_from date,p_to date,p_warehouse_id uuid,p_reserve boolean,p_mode text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_days integer;
begin
 v_role:=erp_home.biz_role(p_user_id);
 if not erp_home.biz_stock_visible(v_role) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 perform erp_home.biz_period(p_from,p_to);
 if p_reserve is null or p_mode is null or p_mode not in('itens','desmembrados') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 if p_warehouse_id is not null and not exists(select 1 from erp_catalog.warehouse where record_id=p_warehouse_id) then raise exception 'erp_home_business_warehouse_not_found' using errcode='P0002'; end if;
 v_s:=erp_home.biz_finished();v_days:=p_to-p_from+1;
 return erp_home.biz_envelope('previsao-estoque',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'warehouse_id',p_warehouse_id,'reserve',p_reserve,'mode',p_mode))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_warehouse_id is null or warehouse_id=p_warehouse_id),
    l as materialized(select l.* from erp_home.biz_lines(p_from,p_to,v_s) l join o on o.id=l.document_id where l.product_id is not null),
    -- itens: each sold product (simples and composições); desmembrados: a composição with its structure counts as its components.
    x as materialized(select l.product_id,l.code,l.name,l.quantity from l where p_mode='itens' or not exists(select 1 from erp_stock.composition_current c where c.product_id=l.product_id)
     union all select c.component_id,erp_home.biz_text(r.code,60),coalesce(erp_home.biz_text(r.name,200),'Componente sem descrição'),l.quantity*c.quantity from l
      join erp_stock.composition_current c on c.product_id=l.product_id join erp_catalog.record r on r.id=c.component_id where p_mode='desmembrados'),
    p as materialized(select x.product_id,max(x.code) code,max(x.name) name,sum(x.quantity) sold,
      (select c.stock_type from erp_stock.composition c join erp_catalog.product k on k.record_id=c.product_id where c.product_id=x.product_id and k.format='E') composition
     from x group by x.product_id order by sum(x.quantity) desc,max(x.name),x.product_id limit 300),
    -- A Virtual composição has no stock of its own: its stock is the whole compositions its components allow (222).
    s as materialized(select p.*,case when p.composition='virtual' then coalesce(erp_stock.virtual_quantity(p.product_id,p_warehouse_id),0)
      else erp_stock.count_physical(p.product_id,p_warehouse_id)-case when p_reserve then(select coalesce(sum(i.quantity),0) from erp_stock.reservation_item i join erp_stock.reservation x on x.id=i.reservation_id
      where x.state='active' and i.product_id=p.product_id and(i.warehouse_id=p_warehouse_id or(p_warehouse_id is null and not erp_stock.ignored_warehouse(i.warehouse_id)))) else 0 end end stock from p)
   select jsonb_build_object(
    'turnover',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'sold',erp_home.qty(sold),'per_day',erp_home.qty(sold/v_days),'stock',erp_home.qty(stock),'composition',composition,
       'coverage_days',case when sold<=0 then null else least(floor(greatest(stock,0)*v_days/sold),2147483647)::integer end) order by sold desc,name,product_id),'[]'::jsonb) from s),160000),
    'by_channel',(select coalesce(jsonb_agg(jsonb_build_object('channel',channel,'orders',orders,'units',erp_home.qty(units),'total',erp_home.money(total)) order by total desc,channel),'[]'::jsonb)
      from(select channel,count(*)::integer orders,sum(units) units,sum(total) total from o group by channel) x),
    'by_day',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'units',erp_home.qty((select sum(units) from o where o.day=g.d::date)),
       'total',erp_home.money((select sum(total) from o where o.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d))));
end $$;

create or replace function public.erp_home_business_panel(p_user_id uuid,p_panel text,p_args jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_key text; v_keys text[];
begin
 v_key:=case p_panel when 'mensal' then 'mensal' when 'diario' then 'diario' when 'pedidos-venda' then 'pedidos' when 'vendas-vendedor' then 'vendedor' when 'venda-canal' then 'canal'
  when 'previsao-estoque' then 'previsao_estoque' when 'margem-pedido' then 'margem_sku' when 'novos-recorrentes' then 'novos_recorrentes' when 'atividade-carteira' then 'carteira'
  when 'curva-abc' then 'curva_abc' when 'metas' then 'metas' when 'metas_save' then 'metas' when 'metas_command' then 'metas' end;
 v_keys:=case p_panel when 'mensal' then array['p_compare_from','p_compare_to','p_from','p_statuses','p_to'] when 'diario' then array['p_compare_day','p_day','p_statuses']
  when 'pedidos-venda' then array['p_from','p_state','p_statuses','p_to'] when 'vendas-vendedor' then array['p_from','p_seller','p_statuses','p_to'] when 'venda-canal' then array[]::text[]
  -- 265: with p_mode (Variações + Simples + Composições | Desmembrados) the panel answers the v2 Giro de Produto.
  when 'previsao-estoque' then case when p_args?'p_mode' then array['p_from','p_mode','p_reserve','p_to','p_warehouse_id'] else array['p_from','p_reserve','p_to','p_warehouse_id'] end when 'margem-pedido' then array['p_from','p_statuses','p_tab','p_to']
  when 'novos-recorrentes' then array['p_from','p_statuses','p_to'] when 'atividade-carteira' then array['p_brand','p_from','p_keywords','p_min_days','p_to']
  when 'curva-abc' then array['p_brand','p_from','p_statuses','p_to'] when 'metas' then array['p_tab'] when 'metas_save' then array['p_command_id','p_data','p_expected_version','p_goal_id']
  when 'metas_command' then array['p_command_id'] end;
 if v_key is null or p_args is null or jsonb_typeof(p_args)<>'object' or coalesce((select array_agg(k order by k) from jsonb_object_keys(p_args) k),array[]::text[])<>v_keys then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard');
 perform erp_access.require_permission(p_user_id,'meu_negocio.dashboard.'||v_key);
 return case p_panel
  when 'mensal' then public.erp_home_business_monthly(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,(p_args->>'p_compare_from')::date,(p_args->>'p_compare_to')::date)
  when 'diario' then public.erp_home_business_daily(p_user_id,p_args->'p_statuses',(p_args->>'p_day')::date,(p_args->>'p_compare_day')::date)
  when 'pedidos-venda' then public.erp_home_business_orders(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_state')
  when 'vendas-vendedor' then public.erp_home_business_sellers(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_seller')
  when 'venda-canal' then public.erp_home_business_channels(p_user_id)
  when 'previsao-estoque' then case when p_args?'p_mode' then public.erp_home_business_forecast_v2(p_user_id,(p_args->>'p_from')::date,(p_args->>'p_to')::date,(p_args->>'p_warehouse_id')::uuid,(p_args->>'p_reserve')::boolean,p_args->>'p_mode')
   else public.erp_home_business_forecast(p_user_id,(p_args->>'p_from')::date,(p_args->>'p_to')::date,(p_args->>'p_warehouse_id')::uuid,(p_args->>'p_reserve')::boolean) end
  when 'margem-pedido' then public.erp_home_business_margin(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_tab')
  when 'novos-recorrentes' then public.erp_home_business_customers(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date)
  when 'atividade-carteira' then public.erp_home_business_portfolio(p_user_id,(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_brand',(p_args->>'p_min_days')::integer,p_args->'p_keywords')
  when 'curva-abc' then public.erp_home_business_abc(p_user_id,p_args->'p_statuses',(p_args->>'p_from')::date,(p_args->>'p_to')::date,p_args->>'p_brand')
  when 'metas' then public.erp_home_business_goals(p_user_id,p_args->>'p_tab')
  when 'metas_save' then public.erp_home_business_goal_save(p_user_id,(p_args->>'p_command_id')::uuid,(p_args->>'p_goal_id')::uuid,(p_args->>'p_expected_version')::integer,p_args->'p_data')
  else public.erp_home_business_goal_command(p_user_id,(p_args->>'p_command_id')::uuid) end;
end $$;

create or replace function erp_home.biz_lines(p_from date,p_to date,p_statuses text[])
returns table(document_id uuid,day date,contact_id uuid,channel text,seller text,product_key text,product_id uuid,code text,name text,brand text,quantity numeric,total numeric,unit_cost numeric)
language sql stable set search_path=pg_catalog as $$
 with o as materialized(select * from erp_home.biz_orders(p_from,p_to,p_statuses)),
  -- 265: the custo médio of every product of the period, computed once (erp_stock.average_costs, base of Preferências › Estoque).
  c as materialized(select a.product_id,a.average_cost from erp_stock.average_costs(array(select distinct i.product_id from o join erp_documents.item i on i.document_id=o.id where i.product_id is not null)) a)
 select o.id,o.day,o.contact_id,o.channel,o.seller,coalesce(i.product_id::text,'d:'||lower(coalesce(erp_home.biz_text(i.data->>'description',200),''))),i.product_id,
  coalesce(erp_home.biz_text(r.code,60),erp_home.biz_text(i.product_snapshot->>'code',60)),
  coalesce(erp_home.biz_text(i.data->>'description',200),erp_home.biz_text(r.name,200),'Item sem descrição'),erp_home.biz_text(p.brand,100),
  i.quantity,i.total,case when i.product_id is null then null else erp_home.biz_cost(i.product_id,c.average_cost) end
 from o join erp_documents.item i on i.document_id=o.id left join c on c.product_id=i.product_id
 left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id
$$;

-- ---- Importações de Dados: composições, campos customizados e fornecedores de produtos ----
-- The cell of a Campo customizado as its type expects it (erp_catalog.custom_value checks it again in the product save): a list by
-- the text of the option, a check by Sim/Não, a date by dd/mm/aaaa, a number with a comma or a point; text as written.
create function erp_preferences.import_custom_value(p_field erp_catalog.custom_field,p_text text) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v text:=btrim(coalesce(p_text,'')); v_ids uuid[]; m text[];
begin
 if v='' then perform erp_preferences.import_fail('erp_preferences_import_required:item_value'); end if;
 case p_field.field_type
  when 'list' then
   select array_agg(o.id order by o.position) into v_ids from erp_catalog.custom_field_option o where o.field_id=p_field.id and lower(o.label)=lower(v);
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:item_value'); end if;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:item_value'); end if;
   return v_ids[1]::text;
  when 'boolean' then
   if lower(v) in('sim','s','true','1','x','verdadeiro') then return 'true'; end if;
   if lower(v) in('não','nao','n','false','0','falso') then return 'false'; end if;
   perform erp_preferences.import_fail('erp_preferences_import_invalid:item_value');
  when 'date' then
   m:=regexp_match(v,'^(\d{2})/(\d{2})/(\d{4})$');
   if m is not null then return m[3]||'-'||m[2]||'-'||m[1]; end if;
   return v;
  when 'decimal' then
   -- The rule of every other sheet cell (normalizeCell): with a comma, the points group the thousands and the comma separates the
   -- decimals (1.234,5 = 1234.5); without a comma, the point is the decimal separator (1.234 = 1.234, never 1234).
   if position(',' in v)>0 then return replace(replace(v,'.',''),',','.'); end if;
   return v;
  else return v;
 end case;
 return null;
end $$;

create function erp_preferences.import_item_e(p_user_id uuid,p_kind text,p_command uuid,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_res jsonb; v_items jsonb:='[]'::jsonb; v_item jsonb; v_comp integer; v_format text; v_ids uuid[]; v_field erp_catalog.custom_field%rowtype;
 v_values jsonb:='{}'::jsonb; v_supplier uuid; v_list jsonb; v_entry jsonb; v_old jsonb; v_post text; v_found boolean:=false; v_default boolean;
begin
 if p_kind='compositions' then
  -- Estrutura of one composição: the product (Código) becomes "Com composição" and its structure is replaced by the sheet's.
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  select p.format into v_format from erp_catalog.product p where p.record_id=v_id;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_items:=v_items||jsonb_build_array(jsonb_build_object('component_id',erp_preferences.import_product(v_item->>'code','item_code',true),'quantity',v_item->>'quantity'));
  end loop;
  v_post:=coalesce(p_data->>'post_mode',case when p_data->>'stock_type'='virtual' then 'components' end);
  if v_post is null then perform erp_preferences.import_fail('erp_preferences_import_required:post_mode'); end if;
  if p_data->>'stock_type'='virtual' and v_post<>'components' then perform erp_preferences.import_fail('erp_preferences_import_invalid:post_mode'); end if;
  select c.version into v_comp from erp_stock.composition c where c.product_id=v_id;
  -- The product save inside needs a patch: the format "Com composição" (unchanged when it already is).
  v_res:=public.erp_stock_product_compose(p_user_id,v_id,v_version,p_command,jsonb_build_object('format','E'),null,
   jsonb_build_object('expected_version',coalesce(v_comp,0),'stock_type',p_data->>'stock_type','post_mode',v_post,'items',v_items));
  return jsonb_build_object('action',case when v_comp is null then 'create' else 'update' end,'record_id',v_id,
   'reference',left('Composição '||(p_data->>'code')||' · '||jsonb_array_length(v_items)||' componente(s)',120),'unchanged',false);
 elsif p_kind='custom_fields' then
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   select array_agg(f.id order by f.id) into v_ids from erp_catalog.custom_field f where f.module='products' and lower(f.name)=lower(btrim(v_item->>'field'));
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:item_field'); end if;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:item_field'); end if;
   if v_values?(v_ids[1]::text) then perform erp_preferences.import_fail('erp_preferences_import_duplicate:item_field'); end if;
   select * into v_field from erp_catalog.custom_field where id=v_ids[1];
   v_values:=v_values||jsonb_build_object(v_field.id::text,erp_preferences.import_custom_value(v_field,v_item->>'value'));
  end loop;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,jsonb_build_object('custom_values',v_values),null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind='product_suppliers' then
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  v_supplier:=erp_preferences.import_contact(p_data->>'supplier_name',p_data->>'supplier_document','supplier_name','supplier_document');
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  -- The current list as the product form sends it; the sheet line updates the filled columns of its supplier or adds it.
  select coalesce(jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'description',s.description,'code',s.code,'purchase_price',erp_catalog.unit_price_numeric(s.purchase_price,14),
   'cost_price',erp_catalog.unit_price_numeric(s.cost_price,14),'warranty_months',s.warranty_months::text,'is_default',s.is_default) order by s.position),'[]'::jsonb) into v_old
   from erp_catalog.product_supplier s where s.record_id=v_id;
  v_default:=case when p_data?'is_default' then (p_data->>'is_default')::boolean end;
  v_list:='[]'::jsonb;
  for v_entry in select x from jsonb_array_elements(v_old) x loop
   if(v_entry->>'supplier_id')::uuid=v_supplier then
    v_found:=true;
    v_entry:=v_entry||jsonb_strip_nulls(jsonb_build_object('code',p_data->'supplier_code','description',p_data->'description','purchase_price',p_data->'purchase_price',
     'cost_price',p_data->'cost_price','warranty_months',p_data->'warranty_months'))||case when v_default is not null then jsonb_build_object('is_default',v_default) else '{}'::jsonb end;
   elsif v_default then v_entry:=v_entry||jsonb_build_object('is_default',false);
   end if;
   v_list:=v_list||jsonb_build_array(v_entry);
  end loop;
  if not v_found then
   v_list:=v_list||jsonb_build_array(jsonb_build_object('supplier_id',v_supplier,'description',p_data->'description','code',p_data->'supplier_code','purchase_price',p_data->'purchase_price',
    'cost_price',p_data->'cost_price','warranty_months',p_data->'warranty_months','is_default',coalesce(v_default,jsonb_array_length(v_old)=0)));
  end if;
  if v_found and v_list=v_old then
   return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',true);
  end if;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,jsonb_build_object('suppliers',v_list),null);
  return jsonb_build_object('action',case when v_found then 'update' else 'create' end,'record_id',v_id,
   'reference',left((p_data->>'code')||' · '||coalesce(p_data->>'supplier_name',p_data->>'supplier_document'),120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 end if;
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;


create or replace function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_patch jsonb; v_res jsonb; v_origin text; v_items jsonb:='[]'::jsonb; v_item jsonb; v_product uuid; v_line integer:=0;
 v_body jsonb; v_wh uuid; v_qty numeric; v_balance numeric; v_bversion integer; v_kind text; v_cents bigint; v_reason text; v_doc text; v_ids uuid[];
 v_contact erp_catalog.contact%rowtype; v_profile erp_catalog.contact_profile%rowtype; v_nature erp_fiscal_invoices.nature%rowtype; v_crt text; v_series text; v_person text; v_name text; v_text text;
begin
 if p_kind='products' then
  if p_data?'code' then v_id:=erp_preferences.import_product(p_data->>'code','code',false); end if;
  v_patch:=p_data-'category'-'product_group';
  if p_data?'category' then v_patch:=v_patch||jsonb_build_object('category_id',erp_preferences.import_named('categories',p_data->>'category','category')); end if;
  if p_data?'product_group' then v_patch:=v_patch||jsonb_build_object('product_group_id',erp_preferences.import_named('product_groups',p_data->>'product_group','product_group')); end if;
  if v_id is null then
   -- Preferências › Configurações de produtos: "Origem padrão de tributação de produtos" fills a new product without Origem.
   v_origin:=erp_preferences.get('produtos.origem_padrao')#>>'{}';
   if not v_patch?'origin' and v_origin~'^[0-8]$' then v_patch:=v_patch||jsonb_build_object('origin',v_origin); end if;
   v_res:=public.erp_catalog_product_save(p_user_id,null,0,p_command,v_patch,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_patch:=v_patch-'code';
  if v_patch='{}'::jsonb then return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',true); end if;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,v_patch,null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind='contacts' then
  v_doc:=nullif(erp_catalog.compact(p_data->>'document'),'');
  if v_doc is not null then
   select array_agg(r.id order by r.id) into v_ids from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id left join erp_catalog.contact_profile p on p.record_id=r.id
    where r.entity='contacts' and coalesce(p.situation,'A')<>'E' and erp_catalog.compact(c.document)=v_doc;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:document'); end if;
   v_id:=v_ids[1];
  end if;
  if v_id is null then
   v_res:=public.erp_catalog_contact_save(p_user_id,null,0,p_command,p_data,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_res:=public.erp_catalog_contact_save(p_user_id,v_id,v_version,p_command,p_data,null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(coalesce(v_res#>>'{record,name}',v_doc),120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind in('purchase_orders','sales_orders') then
  v_body:=jsonb_build_object('date',p_data->'date','contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'));
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_line:=v_line+1; v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',v_product,
    'description',coalesce(v_item->>'description',(select r.name from erp_catalog.record r where r.id=v_product)),
    'code',case when v_product is not null then (select r.code from erp_catalog.record r where r.id=v_product) end,
    'unit',coalesce(v_item->>'unit',(select p.unit from erp_catalog.product p where p.record_id=v_product),'UN'),
    'quantity',v_item->'quantity',
    'unit_price',coalesce(v_item->>'unit_price',(select erp_catalog.unit_price_numeric(p.price,10) from erp_catalog.product p where p.record_id=v_product and p.price is not null),'0'),
    'discount_percent',v_item->'discount_percent')));
  end loop;
  v_body:=v_body||jsonb_build_object('items',v_items)||jsonb_strip_nulls(jsonb_build_object('expected_date',p_data->'expected_date','freight',p_data->'freight',
   'notes',p_data->'notes','internal_notes',p_data->'internal_notes'));
  v_res:=public.erp_document_save(p_user_id,p_kind,null,0,p_command,v_body);
  return jsonb_build_object('action','create','record_id',v_res#>>'{document,id}','reference',left('nº '||(v_res#>>'{document,number}')||' (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind='stock_movements' then
  v_product:=erp_preferences.import_product(p_data->>'code','code',true);
  if p_data?'warehouse' then v_wh:=erp_preferences.import_named('warehouses',p_data->>'warehouse','warehouse');
  else select warehouse_id into v_wh from erp_stock.warehouse_default; if v_wh is null then perform erp_preferences.import_fail('erp_preferences_import_required:warehouse'); end if; end if;
  select b.quantity,b.version into v_balance,v_bversion from erp_stock.balance b where b.product_id=v_product and b.warehouse_id=v_wh;
  v_balance:=coalesce(v_balance,0); v_bversion:=coalesce(v_bversion,0); v_qty:=(p_data->>'quantity')::numeric;
  if p_data->>'movement' in('receipt','issue') and v_qty<=0 then perform erp_preferences.import_fail('erp_preferences_import_invalid:quantity'); end if;
  v_kind:=case p_data->>'movement' when 'balance' then 'adjustment' else p_data->>'movement' end;
  v_qty:=case p_data->>'movement' when 'receipt' then v_qty when 'issue' then -v_qty else v_qty-v_balance end;
  if v_qty=0 then return jsonb_build_object('action','update','record_id',null,'reference','Saldo já igual à quantidade','unchanged',true); end if;
  v_reason:=coalesce(nullif(btrim(p_data->>'note'),''),'Importação de movimentações de estoque');
  if length(v_reason)<3 then v_reason:='Importação: '||v_reason; end if;
  v_res:=public.erp_stock_post(p_user_id,p_command,v_kind,coalesce((p_data->>'date')::date,(clock_timestamp() at time zone 'America/Sao_Paulo')::date),v_reason,
   jsonb_build_array(jsonb_build_object('product_id',v_product,'warehouse_id',v_wh,'quantity',v_qty::numeric(18,6)::text,'expected_version',v_bversion)),left('Importação '||p_file,100));
  return jsonb_build_object('action','create','record_id',v_res#>>'{movement,id}','reference',left(case v_kind when 'receipt' then 'Entrada' when 'issue' then 'Saída' else 'Balanço' end||' '||(v_qty::numeric(18,6))::text,120),'unchanged',false);
 elsif p_kind='nfe' then
  -- Notas fiscais em lote: a rascunho de NF-e de saída in homologation, the same input the notas screen sends (recipient from
  -- the cadastro, items with the product NCM/CEST/GTIN/origem, Cálculo automático). Number and SEFAZ stay with the emission steps.
  -- Preferências › Empresa: the tax regime must be confirmed before any note.
  select f.crt into v_crt from erp_company.fiscal f where f.singleton;
  if v_crt is null then perform erp_preferences.import_fail('erp_preferences_import_company_regime'); end if;
  v_id:=erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document');
  select * into v_contact from erp_catalog.contact where record_id=v_id;
  select * into v_profile from erp_catalog.contact_profile where record_id=v_id;
  select r.name into v_name from erp_catalog.record r where r.id=v_id;
  v_doc:=nullif(erp_catalog.compact(v_contact.document),'');
  v_person:=coalesce(nullif(v_contact.person_type,''),case length(v_doc) when 14 then 'J' when 11 then 'F' end);
  if p_data?'nature' then
   select array_agg(n.id order by n.id) into v_ids from erp_fiscal_invoices.nature n
    where n.direction='1' and n.active and n.deleted_at is null and lower(btrim(n.description))=lower(btrim(p_data->>'nature'));
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:nature'); end if;
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:nature'); end if;
   select * into v_nature from erp_fiscal_invoices.nature where id=v_ids[1];
  else
   select n.* into v_nature from erp_fiscal_invoices.nature_default d join erp_fiscal_invoices.nature n on n.id=d.nature_id
    where n.active and n.deleted_at is null and d.code=any(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end)
    order by array_position(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end,d.code) limit 1;
   if v_nature.id is null then perform erp_preferences.import_fail('erp_preferences_import_required:nature'); end if;
  end if;
  v_series:=v_nature.series::text;
  if v_series is null and to_regclass('erp_fiscal_numbering.series') is not null then
   execute 'select series::text from erp_fiscal_numbering.series where model=''55'' and environment=''2'' and enabled order by series limit 1' into v_series;
  end if;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls((select jsonb_build_object('product_id',v_product,'code',left(r.code,60),
     'description',left(coalesce(v_item->>'description',r.name),120),'unit',left(coalesce(v_item->>'unit',p.unit,'UN'),6),'quantity',v_item->'quantity',
     'unit_price',coalesce(v_item->>'unit_price',erp_catalog.unit_price_numeric(p.price,10),'0'),
     'ncm',case when p.ncm~'^[0-9]{8}$' then p.ncm end,'cest',case when p.cest~'^[0-9]{7}$' then p.cest end,
     'gtin',case when p.gtin~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin end,'gtin_tax',case when p.gtin_tax~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin_tax end,
     'icms',case when p.origin~'^[0-8]$' then jsonb_build_object('origin',p.origin) end)
    from(select 1) one left join erp_catalog.record r on r.id=v_product left join erp_catalog.product p on p.record_id=v_product)));
  end loop;
  v_text:=nullif(regexp_replace(coalesce(v_contact.ie,''),'[^0-9]','','g'),'');
  v_body:=jsonb_build_object('model','55','direction','1','issue_type','N','series',coalesce(v_series,'1'),'nature_id',v_nature.id,
   'issue_date',coalesce(p_data->>'date',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD')),'crt',v_crt,'purpose','1',
   'presence',coalesce(v_nature.presence,'1'),'final_consumer',coalesce(v_nature.final_consumer,false),'auto_tax',true,'items',v_items,
   'recipient',jsonb_strip_nulls(jsonb_build_object('contact_id',v_id,'name',left(v_name,60),'person_type',v_person,
    'document',case when v_person in('F','J') and length(v_doc) in(11,14) then v_doc end,
    'ie',case when length(v_text) between 2 and 14 then v_text when upper(btrim(v_contact.ie))='ISENTO' then 'ISENTO' end,
    'ie_indicator',case when v_profile.taxpayer in('1','2','9') then v_profile.taxpayer end,
    'email',case when left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60)~'^[^[:space:]@]+@[^[:space:]@]+$' then left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60) end,
    'postal_code',case when regexp_replace(coalesce(v_contact.postal_code,''),'[^0-9]','','g')~'^[0-9]{8}$' then regexp_replace(v_contact.postal_code,'[^0-9]','','g') end,
    'street',nullif(left(v_contact.street,60),''),'number',nullif(left(v_contact.number,60),''),'complement',nullif(left(v_contact.complement,60),''),
    'district',nullif(left(v_contact.district,60),''),'city',nullif(left(v_contact.city,60),''),
    'state',case when upper(v_contact.state) in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then upper(v_contact.state) end)))
   ||jsonb_strip_nulls(jsonb_build_object('additional_info',p_data->'notes'));
  v_res:=public.erp_fiscal_invoice_execute(p_user_id,p_command,'create',jsonb_build_object('invoice',v_body));
  return jsonb_build_object('action','create','record_id',v_res#>>'{invoice,id}','reference',left('Rascunho de NF-e (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind in('receivables','payables') then
  v_kind:=case p_kind when 'receivables' then 'receivable' else 'payable' end;
  v_cents:=((p_data->>'amount')::numeric*100)::bigint;
  v_res:=public.erp_finance_title_execute(p_user_id,p_command,'title_create',jsonb_strip_nulls(jsonb_build_object('kind',v_kind,
   'contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'),
   'category_id',erp_preferences.import_named('finance_categories',p_data->>'category','category',v_kind),
   'account_id',erp_preferences.import_named('accounts',p_data->>'account','account'),
   'payment_method_id',erp_preferences.import_named('payment_methods',p_data->>'payment_method','payment_method',v_kind),
   'description',p_data->'description','source_reference',p_data->'source_reference','issued_on',p_data->'issued_on','competence_on',coalesce(p_data->'competence_on',p_data->'issued_on'),
   'total_cents',v_cents::text,'installments',jsonb_build_array(jsonb_build_object('amount_cents',v_cents::text,'due_on',p_data->'due_on')))));
  return jsonb_build_object('action','create','record_id',v_res#>>'{items,0,id}','reference',left(p_data->>'description',120),'unchanged',false);
 end if;
 -- 265: composições, campos customizados and fornecedores de produtos (erp_preferences.import_item_e).
 if p_kind in('compositions','custom_fields','product_suppliers') then return erp_preferences.import_item_e(p_user_id,p_kind,p_command,p_data); end if;
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;

create or replace function public.erp_preferences_import_batch(p_user_id uuid,p_command_id uuid,p_job_id uuid,p_kind text,p_file_name text,p_total_rows integer,p_dry_run boolean,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_preferences.import_command%rowtype; v_job erp_preferences.import_job%rowtype; v_item jsonb; v_row integer; v_done erp_preferences.import_row%rowtype;
 v_out jsonb; v_message text; v_state text; v_reason text; v_result jsonb; v_items jsonb:='[]'::jsonb; v_seed uuid:=coalesce(p_command_id,gen_random_uuid());
 v_new integer:=0; v_created integer:=0; v_updated integer:=0; v_unchanged integer:=0; v_invalid integer:=0; v_status text; v_action text; v_entry jsonb;
begin
 perform erp_preferences.import_require_admin(p_user_id);
 if p_kind is null or p_kind not in('products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe','compositions','custom_fields','product_suppliers') or p_dry_run is null
  or(not p_dry_run and(p_command_id is null or p_job_id is null)) or p_file_name is null or length(p_file_name) not between 1 and 200 or p_file_name~'[[:cntrl:]]'
  or btrim(p_file_name)<>p_file_name or p_total_rows is null or p_total_rows not between 1 and 10000
  or p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 50 or octet_length(p_rows::text)>262144
  or exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x)<>'object' or(select count(*) from jsonb_object_keys(x))<>3
   or jsonb_typeof(x->'row')<>'number' or(x->>'row')!~'^[1-9][0-9]{0,4}$' or(x->>'row')::integer not between 2 and 10001
   or jsonb_typeof(x->'lines')<>'array' or jsonb_array_length(x->'lines') not between 1 and 250 or x->'lines'->0<>x->'row' or jsonb_typeof(x->'data')<>'object')
  or(select count(distinct x->>'row') from jsonb_array_elements(p_rows) x)<>jsonb_array_length(p_rows) then
  raise exception 'erp_preferences_import_invalid' using errcode='22023'; end if;
 if not p_dry_run then
  v_hash:=encode(sha256(convert_to(jsonb_build_object('profile','erp-import-v1','actor',p_user_id,'kind',p_kind,'job',p_job_id,'file',p_file_name,'total',p_total_rows,'items',p_rows)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('erp-import-command:'||p_command_id::text,0));
  select * into v_command from erp_preferences.import_command where command_id=p_command_id;
  if found then
   if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_preferences_import_command_conflict' using errcode='40001'; end if;
   return v_command.result||jsonb_build_object('replayed',true,'job',erp_preferences.import_job_dto(v_command.job_id));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-import-job:'||p_job_id::text,0));
  select * into v_job from erp_preferences.import_job where id=p_job_id for update;
  if not found then
   insert into erp_preferences.import_job(id,kind,actor,file_name,total_rows) values(p_job_id,p_kind,p_user_id,p_file_name,p_total_rows) returning * into v_job;
  elsif v_job.actor<>p_user_id then raise exception 'erp_preferences_import_job_denied' using errcode='42501';
  elsif v_job.kind<>p_kind or v_job.file_name<>p_file_name or v_job.total_rows<>p_total_rows then raise exception 'erp_preferences_import_job_mismatch' using errcode='22023';
  elsif v_job.status='concluida' then raise exception 'erp_preferences_import_job_finished' using errcode='40001';
  end if;
 end if;
 for v_item in select x from jsonb_array_elements(p_rows) x order by (x->>'row')::integer loop
  v_row:=(v_item->>'row')::integer; v_out:=null; v_reason:=null;
  if not p_dry_run then
   select * into v_done from erp_preferences.import_row where job_id=p_job_id and row=v_row;
   -- A line already imported in this file answers its recorded result and is never sent to the module again.
   if found then v_items:=v_items||jsonb_build_array(erp_preferences.import_row_dto(v_done)); continue; end if;
  end if;
  begin
   v_out:=erp_preferences.import_item(p_user_id,p_kind,erp_preferences.import_item_command(v_seed,v_row),p_file_name,v_item->'data');
   if p_dry_run then raise exception 'erp_preferences_import_dry_run' using errcode='P0001'; end if;
  exception when sqlstate 'P0001' or sqlstate '22023' or sqlstate '22P02' or sqlstate '22003' or sqlstate '22007' or sqlstate '22008' or sqlstate '22001'
   or sqlstate '23505' or sqlstate '23503' or sqlstate '23502' or sqlstate '23514' or sqlstate 'P0002' or sqlstate '40001' then
   get stacked diagnostics v_message=message_text,v_state=returned_sqlstate;
   if v_message<>'erp_preferences_import_dry_run' then v_reason:=erp_preferences.import_reason(v_message,v_state); end if;
  end;
  v_action:=v_out->>'action';
  v_status:=case when v_reason is not null then 'invalid' when p_dry_run then 'valid' when v_action='create' then 'created' when (v_out->>'unchanged')::boolean then 'unchanged' else 'updated' end;
  v_entry:=jsonb_build_object('row',v_row,'status',v_status,'action',case when v_reason is null then v_action end,'reason',v_reason,
   'field',case when v_reason is not null then erp_preferences.import_field(v_reason) end,
   'record_id',case when v_status in('created','updated','unchanged') then v_out->>'record_id' end,
   'reference',case when v_reason is null and not p_dry_run then nullif(left(regexp_replace(v_out->>'reference','[[:cntrl:]]',' ','g'),120),'') end);
  v_items:=v_items||jsonb_build_array(v_entry);
  if not p_dry_run then
   insert into erp_preferences.import_row(job_id,row,lines,command_id,status,action,reason,field,record_id,reference)
    values(p_job_id,v_row,array(select jsonb_array_elements_text(v_item->'lines')::integer),p_command_id,v_status,v_entry->>'action',v_reason,v_entry->>'field',
     (v_entry->>'record_id')::uuid,v_entry->>'reference');
   v_new:=v_new+1;
   case v_status when 'created' then v_created:=v_created+1; when 'updated' then v_updated:=v_updated+1; when 'unchanged' then v_unchanged:=v_unchanged+1; else v_invalid:=v_invalid+1; end case;
  end if;
 end loop;
 -- The role may have changed while a lock was awaited: a refusal here undoes the whole batch before the receipt.
 perform erp_preferences.import_require_admin(p_user_id);
 if not p_dry_run then
  if v_job.rows_done+v_new>v_job.total_rows then raise exception 'erp_preferences_import_total_exceeded' using errcode='22023'; end if;
  update erp_preferences.import_job set rows_done=rows_done+v_new,created=created+v_created,updated=updated+v_updated,unchanged=unchanged+v_unchanged,invalid=invalid+v_invalid,
   status=case when rows_done+v_new=total_rows then 'concluida' else status end,finished_at=case when rows_done+v_new=total_rows then clock_timestamp() end,updated_at=clock_timestamp()
   where id=p_job_id;
 end if;
 v_result:=jsonb_build_object('scope','import_batch','data_mode','erp_native','kind',p_kind,'dry_run',p_dry_run,'replayed',false,
  'job',case when p_dry_run then null else erp_preferences.import_job_dto(p_job_id) end,'items',v_items);
 if not p_dry_run then
  insert into erp_preferences.import_command(command_id,actor,job_id,request_hash,result) values(p_command_id,p_user_id,p_job_id,v_hash,v_result-'job');
 end if;
 return v_result;
end $$;

revoke all on function erp_home.biz_cost(uuid,numeric),erp_home.biz_lines(date,date,text[]),erp_preferences.import_custom_value(erp_catalog.custom_field,text),
 erp_preferences.import_item_e(uuid,text,uuid,jsonb),erp_preferences.import_item(uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_home_business_forecast_v2(uuid,date,date,uuid,boolean,text)','erp_home_business_panel(uuid,text,jsonb)',
  'erp_preferences_import_batch(uuid,uuid,uuid,text,text,integer,boolean,jsonb)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
