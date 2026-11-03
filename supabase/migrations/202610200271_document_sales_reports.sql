-- 271: Documentos (onda F), parte 5: Relatório de Vendas com os parâmetros do Origin e o Relatório de Romaneio.
-- * Relatório de Vendas: Vendedor (cadastro de vendedores; o agrupamento por Vendedor usa o vendedor do pedido e, sem ele, a
--   referência de origem Origin), Fornecedor e Tags dos produtos (com "Incluir produtos sem classificação"), Categorias de receitas e
--   despesas (com as subcategorias), Tipo de contato (com "Sem vínculo"), "Data do faturamento" (emissão da primeira nota fiscal do
--   Brufap vinculada ao pedido, não cancelada nem denegada; perfis Administrador e Fiscal, que leem as notas) e "Exibir lucro" com as
--   bases Preço de custo (fornecedor padrão do produto), Preço da última compra e Preço da última compra até a data do pedido (só para
--   quem lê os pedidos de compra, como o custo do estoque: erp_stock.cost_visible). Lucro = Valor - preço base x quantidade; os itens
--   sem preço base (ou sem produto) entram com custo zero e são contados à parte. "Preço de custo até a data do pedido" fica
--   indisponível: o Brufap não guarda o histórico do preço de custo. Lojas, Unidades e as origens de canal e de loja virtual ficam de
--   fora (não existem no Brufap).
-- * Opções do relatório: tipos de contato, tags de produtos, vendedores e o que o perfil pode usar.
-- * Relatório de Romaneio: pedidos do período (data do pedido, prevista ou de saída), por situação, transportador e cliente, com o
--   endereço de entrega, transportador, modalidade do frete, volumes, peso bruto e itens; os 100 primeiros pedidos por consulta.
-- Os relatórios seguem o "Contato acessível somente ao vendedor vinculado" (267). Substitui public.erp_document_sales_report da 267
-- (conferida pelo hash; outra versão interrompe a migração). Somente leitura: nenhum efeito de estoque, financeiro ou fiscal; nada
-- escreve no Origin.
begin;

do $$begin
 if to_regclass('erp_documents.print_header') is null then raise exception 'document_sales_reports_271_requires_270' using errcode='55000'; end if;
 if (select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('public.erp_document_sales_report(uuid,jsonb)'))
  is distinct from '5be3a7e369238cf891dc3d94b2c4d595f6723e8cb95962c5931d5b8f973a686c' then
  raise exception 'document_sales_reports_271_previous_definition_changed' using errcode='55000',detail='public.erp_document_sales_report(uuid,jsonb)'; end if;
end$$;

-- A JSON list of distinct ids (at most p_max); null when absent.
create function erp_documents.report_uuid_list(p_value jsonb,p_max integer) returns uuid[] language plpgsql immutable set search_path=pg_catalog as $function$
declare v uuid[];
begin
 if p_value is null or p_value='null'::jsonb then return null; end if;
 if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)>p_max
  or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x)<>'string' or x#>>'{}'!~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  or (select count(distinct lower(x)) from jsonb_array_elements_text(p_value) x)<>jsonb_array_length(p_value) then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 select coalesce(array_agg(x::uuid),'{}'::uuid[]) into v from jsonb_array_elements_text(p_value) x;
 return v;
end $function$;

-- Vendedor of a pedido: the native vendedor (Cadastros > Vendedores) and, without it, the Origin origin reference.
create function erp_documents.report_seller_key(p_body jsonb) returns text language sql immutable set search_path=pg_catalog as $function$
 select case when p_body->>'seller_id'~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then 'vendedor:'||lower(p_body->>'seller_id')
  else coalesce(erp_documents.report_seller(p_body),'') end
$function$;
create function erp_documents.report_seller_label(p_body jsonb) returns text language sql stable set search_path=pg_catalog as $function$
 select coalesce((select left(r.name,300) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id
   where s.id=case when p_body->>'seller_id'~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then (p_body->>'seller_id')::uuid end),
  erp_documents.report_seller(p_body),'Sem vendedor')
$function$;

-- Preço da última compra até uma data: the rule of erp_stock.last_purchase (145), limited to the lançamentos up to that day.
create function erp_documents.report_last_purchase_until(p_product uuid,p_until date,p_balances boolean) returns numeric language sql stable set search_path=pg_catalog as $function$
 select x.price from(select m.id,m.occurred_on,m.created_at,
   case when d.movement_id is not null then d.unit_price else erp_stock.ledger_document_price(m.id,e.product_id) end price
  from erp_stock.entry e join erp_stock.movement m on m.id=e.movement_id
  left join lateral(select y.movement_id,y.unit_price from erp_stock.movement_detail y where y.movement_id=m.id and y.product_id=e.product_id order by y.revision desc limit 1) d on true
  left join erp_stock.balance_count c on c.movement_id=m.id
  where e.product_id=p_product and m.occurred_on<=p_until and not exists(select 1 from erp_stock.movement r where r.reverses_id=m.id)
   and((m.kind='receipt' and e.quantity>0) or (p_balances and c.movement_id is not null))) x
 where x.price is not null order by x.occurred_on desc,x.created_at desc,x.id desc limit 1
$function$;
-- Base of "Exibir lucro": Preço de custo (fornecedor padrão), Preço da última compra, Preço da última compra até a data do pedido.
create function erp_documents.report_unit_cost(p_product uuid,p_base text,p_until date,p_balances boolean) returns numeric language sql stable set search_path=pg_catalog as $function$
 select case when p_product is null then null
  when p_base='cost' then (select d.cost_price from erp_stock.default_supplier(p_product) d limit 1)
  when p_base='last_purchase' then (select l.unit_price from erp_stock.last_purchase(p_product,p_balances) l)
  when p_base='last_purchase_until' and p_until is not null then erp_documents.report_last_purchase_until(p_product,p_until,p_balances) end
$function$;

create or replace function public.erp_document_sales_report(p_user_id uuid,p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_from date; v_to date; v_group text; v_sub text; v_order text; v_date text; v_statuses text[]; v_freight boolean; v_items boolean;
 v_contact uuid; v_product uuid; v_warehouse uuid; v_city text; v_state text; v_without boolean; v_first boolean; v_groups jsonb; v_totals jsonb; v_count bigint; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
 v_seller uuid; v_supplier uuid; v_categories text[]; v_types uuid[]; v_untyped boolean; v_tags uuid[]; v_untagged boolean; v_item_filter boolean;
 v_profit boolean; v_base text; v_balances boolean; v_fiscal boolean;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in
   ('from','to','date_type','group','subgroup','order','statuses','include_freight','contact_id','product_id','warehouse_id','city','state','without_invoice','first_purchase',
    'seller_id','supplier_id','category_ids','contact_type_ids','contact_untyped','tag_ids','untagged','show_profit','profit_base'))
  or exists(select 1 from unnest(array['include_freight','without_invoice','first_purchase','contact_untyped','untagged','show_profit']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'boolean')
  or exists(select 1 from unnest(array['date_type','group','subgroup','order','profit_base']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'string') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(p_filters->'from',true); v_to:=erp_documents.date_value(p_filters->'to',true);
 v_group:=coalesce(p_filters->>'group','contact'); v_sub:=nullif(p_filters->>'subgroup','none'); v_order:=coalesce(p_filters->>'order','name'); v_date:=coalesce(p_filters->>'date_type','date');
 v_freight:=coalesce((p_filters->>'include_freight')::boolean,true); v_without:=coalesce((p_filters->>'without_invoice')::boolean,false); v_first:=coalesce((p_filters->>'first_purchase')::boolean,false);
 v_contact:=erp_documents.uuid_value(p_filters->'contact_id'); v_product:=erp_documents.uuid_value(p_filters->'product_id'); v_warehouse:=erp_documents.uuid_value(p_filters->'warehouse_id');
 v_seller:=erp_documents.uuid_value(p_filters->'seller_id'); v_supplier:=erp_documents.uuid_value(p_filters->'supplier_id');
 v_city:=lower(erp_documents.text_value(p_filters->'city',100)); v_state:=upper(erp_documents.text_value(p_filters->'state',2));
 -- Tipo de contato and Tags: the filter exists when the list is sent; "Sem vínculo" / "Incluir produtos sem classificação" go with it.
 v_types:=erp_documents.report_uuid_list(p_filters->'contact_type_ids',100); v_untyped:=coalesce((p_filters->>'contact_untyped')::boolean,false);
 v_tags:=erp_documents.report_uuid_list(p_filters->'tag_ids',500); v_untagged:=coalesce((p_filters->>'untagged')::boolean,false);
 v_profit:=coalesce((p_filters->>'show_profit')::boolean,false); v_base:=case when v_profit then coalesce(p_filters->>'profit_base','cost') end;
 if (p_filters?'contact_untyped' and v_types is null) or (p_filters?'untagged' and v_tags is null) or (p_filters?'profit_base' and not v_profit)
  or (v_profit and v_base not in('cost','last_purchase','last_purchase_until')) then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 if p_filters ? 'statuses' and p_filters->'statuses'<>'null'::jsonb then
  if jsonb_typeof(p_filters->'statuses')<>'array' or jsonb_array_length(p_filters->'statuses') not between 1 and 20
   or exists(select 1 from jsonb_array_elements(p_filters->'statuses') s where jsonb_typeof(s)<>'string' or not (erp_documents.transitions()->'sales_orders')?(s#>>'{}')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  select array_agg(distinct s) into v_statuses from jsonb_array_elements_text(p_filters->'statuses') s;
 end if;
 -- Categorias de receitas e despesas: the chosen categorias and their subcategorias.
 if p_filters ? 'category_ids' and p_filters->'category_ids'<>'null'::jsonb then
  with recursive c as(select x.id from erp_finance.category x where x.id=any(erp_documents.report_uuid_list(p_filters->'category_ids',50)) and x.kind='receivable'
   union select x.id from erp_finance.category x join c on x.parent_id=c.id where x.kind='receivable')
  select coalesce(array_agg(c.id::text),'{}'::text[]) into v_categories from c;
 end if;
 if v_from>v_to or v_to-v_from>731 or v_group not in('contact','product','seller','district') or (v_sub is not null and (v_sub not in('contact','product','seller') or v_sub=v_group))
  or v_order not in('name','amount','items','sales') or v_date not in('date','expected_date','invoice')
  or (v_state is not null and v_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 -- The Brufap notas (and their drafts) are read only by admin and fiscal (113), so only they filter or date by them.
 v_fiscal:=exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal'));
 if (v_without or v_date='invoice') and not v_fiscal then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 -- Cost and purchase prices are purchase data (145): only the readers of pedidos de compra see the lucro.
 if v_profit and not erp_stock.cost_visible(p_user_id) then raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 v_balances:=coalesce((erp_stock.settings_dto()->>'consider_balances')::boolean,false);
 v_items:=v_group='product' or coalesce(v_sub,'')='product';
 v_item_filter:=v_product is not null or v_supplier is not null or v_tags is not null;
 with base as materialized(
  select d.id,d.contact_id,d.contact_snapshot,d.body,d.total,coalesce((d.body->>'freight')::numeric,0) freight,
   case when v_base='last_purchase_until' then (d.body->>'date')::date end on_date
  from erp_documents.document d
  where d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   -- 267: only the contacts of the seller of the user (Contato acessível somente ao vendedor vinculado).
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
   and (case v_date when 'expected_date' then d.body->>'expected_date'
     -- Data do faturamento: the first nota of the Brufap linked to the pedido (not deleted, cancelled or denied).
     when 'invoice' then (select min(n.issue_date)::text from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
      where o.document_id=d.id and n.deleted_at is null and n.direction='1' and n.status not in(3,10))
     else d.body->>'date' end) between v_from::text and v_to::text
   and (v_contact is null or d.contact_id=v_contact) and (v_warehouse is null or d.warehouse_id=v_warehouse)
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0) and (v_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=v_state)
   and (v_seller is null or lower(d.body->>'seller_id')=v_seller::text)
   and (v_categories is null or lower(d.body->>'category_id')=any(v_categories))
   and (v_types is null or exists(select 1 from erp_catalog.contact_type_link l where l.contact_id=d.contact_id and l.type_id=any(v_types))
    or (v_untyped and not exists(select 1 from erp_catalog.contact_type_link l where l.contact_id=d.contact_id)))
   and (not v_without or (not exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft')
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
 ), items as materialized(
  -- Produtos, Fornecedor and Tags choose the items; a pedido enters when one of its items is chosen.
  select i.document_id,i.product_id,i.quantity,i.total,i.data,
   (v_product is null or i.product_id=v_product)
   and (v_supplier is null or exists(select 1 from erp_catalog.product_supplier s where s.record_id=i.product_id and s.supplier_id=v_supplier))
   and (v_tags is null or exists(select 1 from erp_catalog.product_tag t where t.record_id=i.product_id and t.tag_id=any(v_tags))
    or (v_untagged and not exists(select 1 from erp_catalog.product_tag t where t.record_id=i.product_id))) chosen
  from erp_documents.item i join base b on b.id=i.document_id
 ), orders as materialized(
  select b.* from base b where not v_item_filter or exists(select 1 from items it where it.document_id=b.id and it.chosen)
 ), prices as materialized(
  select x.product_id,x.on_date,erp_documents.report_unit_cost(x.product_id,v_base,x.on_date,v_balances) price
  from (select distinct it.product_id,o.on_date from items it join orders o on o.id=it.document_id where v_profit and it.product_id is not null) x
 ), priced as materialized(
  select it.document_id,it.product_id,it.quantity,it.total,it.data,it.chosen,it.quantity*p.price cost,(it.product_id is null or p.price is null) costless
  from items it join orders o on o.id=it.document_id left join prices p on v_profit and p.product_id=it.product_id and p.on_date is not distinct from o.on_date
 ), lines as materialized(
  -- One row per item when a product dimension is used (value = item total); else one row per pedido (value = total, with or without frete).
  select o.id order_id,o.contact_id,o.contact_snapshot,o.body,pi.product_id,pi.data->>'description' description,pi.data->>'code' code,pi.quantity,pi.total as amount,
   case when v_profit then coalesce(pi.cost,0) end cost,case when v_profit and pi.costless then 1 else 0 end costless
  from orders o join priced pi on pi.document_id=o.id where v_items and pi.chosen
  union all
  select o.id,o.contact_id,o.contact_snapshot,o.body,null,null,null,(select coalesce(sum(pi.quantity),0) from priced pi where pi.document_id=o.id),
   o.total-case when v_freight then 0 else o.freight end,
   case when v_profit then (select coalesce(sum(pi.cost),0) from priced pi where pi.document_id=o.id) end,
   case when v_profit then (select count(*)::integer from priced pi where pi.document_id=o.id and pi.costless) else 0 end
  from orders o where not v_items
 ), keyed as materialized(
  select l.*,
   case v_group when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then erp_documents.report_seller_key(l.body)
    else lower(coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'')) end group_key,
   case v_group when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then erp_documents.report_seller_label(l.body) else coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'Sem bairro') end group_label,
   case v_sub when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then erp_documents.report_seller_key(l.body) end sub_key,
   case v_sub when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then erp_documents.report_seller_label(l.body) end sub_label
  from lines l
 ), subs as (
  select group_key,sub_key,min(sub_label) label,count(distinct order_id) sales,sum(quantity) items,sum(amount) amount,sum(cost) cost from keyed where v_sub is not null group by group_key,sub_key
 ), groups as (
  select k.group_key,min(k.group_label) label,count(distinct k.order_id) sales,sum(k.quantity) items,sum(k.amount) amount,sum(k.cost) cost from keyed k group by k.group_key
 ), ranked as (
  select g.*,row_number() over(order by case when v_order='amount' then g.amount end desc nulls last,case when v_order='items' then g.items end desc nulls last,
   case when v_order='sales' then g.sales end desc nulls last,lower(g.label),g.group_key) position from groups g
 )
 select coalesce(jsonb_agg(jsonb_build_object('key',r.group_key,'label',r.label,'sales',r.sales,'items',r.items::text,'amount',r.amount::numeric(20,2)::text,
   'cost',case when v_profit then round(r.cost,2)::text end,'profit',case when v_profit then (round(r.amount,2)-round(r.cost,2))::text end,
   'subgroups',case when v_sub is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('key',s.sub_key,'label',s.label,'sales',s.sales,'items',s.items::text,'amount',s.amount::numeric(20,2)::text,
     'cost',case when v_profit then round(s.cost,2)::text end,'profit',case when v_profit then (round(s.amount,2)-round(s.cost,2))::text end)
    order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key),'[]'::jsonb)
    -- The 500 first sub groups in the chosen order (not an arbitrary 500).
    from (select * from subs s where s.group_key=r.group_key order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,
     case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key limit 500) s) end) order by r.position) filter(where r.position<=2000),'[]'::jsonb),
  count(*),
  jsonb_build_object('sales',(select count(*) from orders),'items',(select coalesce(sum(quantity),0) from keyed)::text,'amount',(select coalesce(sum(amount),0) from keyed)::numeric(20,2)::text,
   'cost',case when v_profit then (select round(coalesce(sum(cost),0),2) from keyed)::text end,
   'profit',case when v_profit then (select round(coalesce(sum(amount),0),2)-round(coalesce(sum(cost),0),2) from keyed)::text end,
   'items_without_cost',(select coalesce(sum(costless),0) from keyed)::integer)
 into v_groups,v_count,v_totals from ranked r;
 return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'date_type',v_date,'item_values',v_items,'include_freight',v_freight,
  'show_profit',v_profit,'profit_base',v_base,'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $function$;

-- Opções do Relatório de Vendas: Tipo de contato, Tags (dos produtos), Vendedor, and which parameters the profile may use.
create function public.erp_document_sales_report_options(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_scope uuid; v_types jsonb; v_tags jsonb; v_tag_count integer; v_sellers jsonb; v_seller_count integer;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 v_scope:=erp_catalog.contact_scope(p_user_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.label) order by t.position,t.label,t.id),'[]'::jsonb) into v_types
  from (select * from erp_catalog.contact_type where active order by position,label,id limit 100) t;
 with tags as(select t.id,left(case when g.name is not null then g.name||' › '||t.name else t.name end,200) name from erp_catalog.taxonomy t
   left join erp_catalog.taxonomy g on g.id=t.parent_id where t.kind='tags' and t.tag_type='products')
 select (select count(*)::integer from tags),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by lower(x.name),x.id),'[]'::jsonb)
   from (select * from tags order by lower(name),id limit 500) x) into v_tag_count,v_tags;
 -- A seller-scoped user (267) sees only the own vendedor.
 with sellers as(select s.id,left(r.name,200) name from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where r.active and (v_scope is null or s.id=v_scope))
 select (select count(*)::integer from sellers),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name) order by lower(x.name),x.id),'[]'::jsonb)
   from (select * from sellers order by lower(name),id limit 500) x) into v_seller_count,v_sellers;
 return jsonb_build_object('report','sales_options','contact_types',v_types,'tags',v_tags,'tag_count',v_tag_count,'sellers',v_sellers,'seller_count',v_seller_count,
  'profit_visible',erp_stock.cost_visible(p_user_id),
  'invoice_visible',exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal')),
  'data_mode','erp_native','operational_effects',false);
end $function$;

-- Endereço de entrega of the romaneio: the delivery address of the pedido when filled, else the address of the client.
create function erp_documents.romaneio_address(p_body jsonb,p_contact jsonb) returns jsonb language sql immutable set search_path=pg_catalog as $function$
 select case when nullif(btrim(coalesce(p_body#>>'{delivery_address,street}','')),'') is not null or nullif(btrim(coalesce(p_body#>>'{delivery_address,city}','')),'') is not null
  then jsonb_build_object('source','delivery','name',left(nullif(btrim(p_body#>>'{delivery_address,name}'),''),200),'street',left(nullif(btrim(p_body#>>'{delivery_address,street}'),''),200),
   'number',left(nullif(btrim(p_body#>>'{delivery_address,number}'),''),60),'complement',left(nullif(btrim(p_body#>>'{delivery_address,complement}'),''),200),
   'district',left(nullif(btrim(p_body#>>'{delivery_address,district}'),''),120),'city',left(nullif(btrim(p_body#>>'{delivery_address,city}'),''),120),
   'state',left(nullif(btrim(p_body#>>'{delivery_address,state}'),''),2),'postal_code',left(nullif(btrim(p_body#>>'{delivery_address,postal_code}'),''),9))
  else jsonb_build_object('source','contact','name',null,'street',left(nullif(btrim(p_contact->>'street'),''),200),'number',left(nullif(btrim(p_contact->>'number'),''),60),
   'complement',left(nullif(btrim(p_contact->>'complement'),''),200),'district',left(nullif(btrim(p_contact->>'district'),''),120),'city',left(nullif(btrim(p_contact->>'city'),''),120),
   'state',left(nullif(btrim(p_contact->>'state'),''),2),'postal_code',left(nullif(btrim(p_contact->>'postal_code'),''),9)) end
$function$;

-- Relatório de Romaneio: the pedidos to deliver, with address, transportador, volumes, peso bruto and items.
create function public.erp_document_sales_romaneio(p_user_id uuid,p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_from date; v_to date; v_date text; v_statuses text[]; v_carrier uuid; v_contact uuid; v_rows jsonb; v_count bigint; v_totals jsonb; v_scope uuid:=erp_catalog.contact_scope(p_user_id);
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in('from','to','date_type','statuses','carrier_id','contact_id'))
  or (p_filters?'date_type' and jsonb_typeof(p_filters->'date_type')<>'string') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(p_filters->'from',true); v_to:=erp_documents.date_value(p_filters->'to',true); v_date:=coalesce(p_filters->>'date_type','date');
 v_carrier:=erp_documents.uuid_value(p_filters->'carrier_id'); v_contact:=erp_documents.uuid_value(p_filters->'contact_id');
 if p_filters ? 'statuses' and p_filters->'statuses'<>'null'::jsonb then
  if jsonb_typeof(p_filters->'statuses')<>'array' or jsonb_array_length(p_filters->'statuses') not between 1 and 20
   or exists(select 1 from jsonb_array_elements(p_filters->'statuses') s where jsonb_typeof(s)<>'string' or not (erp_documents.transitions()->'sales_orders')?(s#>>'{}')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  select array_agg(distinct s) into v_statuses from jsonb_array_elements_text(p_filters->'statuses') s;
 end if;
 if v_from>v_to or v_to-v_from>366 or v_date not in('date','expected_date','ship_date') then raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 with orders as materialized(
  select d.id,d.number,d.status,d.contact_snapshot c,d.body b from erp_documents.document d
  -- Without a chosen situação, the cancelled pedidos stay out of the romaneio.
  where d.kind='sales_orders' and (case when v_statuses is null then d.status<>'cancelled' else d.status=any(v_statuses) end)
   and erp_catalog.contact_visible_to(v_scope,d.contact_id)
   and (case v_date when 'expected_date' then d.body->>'expected_date' when 'ship_date' then d.body->>'ship_date' else d.body->>'date' end) between v_from::text and v_to::text
   and (v_contact is null or d.contact_id=v_contact) and (v_carrier is null or lower(d.body->>'carrier_id')=v_carrier::text)
 ), ranked as(select o.*,row_number() over(order by o.b->>'date',o.number,o.id) position from orders o)
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'number',r.number::text,'status',r.status,'date',r.b->>'date','expected_date',r.b->>'expected_date','ship_date',r.b->>'ship_date',
   'contact_name',left(coalesce(r.c->>'name',''),200),'phone',left(nullif(btrim(r.c->>'phone'),''),60),'address',erp_documents.romaneio_address(r.b,r.c),
   'carrier',coalesce((select left(x.name,200) from erp_catalog.record x where x.id=case when r.b->>'carrier_id'~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then (r.b->>'carrier_id')::uuid end),
    left(nullif(btrim(r.b#>>'{commercial,transport,carrier_reference,label}'),''),200)),
   'freight_mode',r.b#>>'{commercial,transport,freight_mode}','volumes',(r.b#>>'{commercial,transport,volume_count}')::numeric::text,
   'gross_weight',(r.b#>>'{commercial,transport,gross_weight}')::numeric::text,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('code',left(nullif(btrim(i.data->>'code'),''),100),'description',left(coalesce(i.data->>'description',''),300),
     'unit',left(nullif(btrim(i.data->>'unit'),''),20),'quantity',i.quantity::text) order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=r.id))
   order by r.position) filter(where r.position<=100),'[]'::jsonb),
  count(*),
  jsonb_build_object('orders',count(*),'volumes',coalesce(sum((r.b#>>'{commercial,transport,volume_count}')::numeric),0)::text,
   'gross_weight',coalesce(sum((r.b#>>'{commercial,transport,gross_weight}')::numeric),0)::text)
 into v_rows,v_count,v_totals from ranked r;
 return jsonb_build_object('report','romaneio','from',v_from::text,'to',v_to::text,'date_type',v_date,'rows',v_rows,'row_count',v_count,'truncated',v_count>100,'totals',v_totals,
  'data_mode','erp_native','operational_effects',false);
end $function$;

revoke all on function erp_documents.report_uuid_list(jsonb,integer),erp_documents.report_seller_key(jsonb),erp_documents.report_seller_label(jsonb),
 erp_documents.report_last_purchase_until(uuid,date,boolean),erp_documents.report_unit_cost(uuid,text,date,boolean),erp_documents.romaneio_address(jsonb,jsonb)
 from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_document_sales_report(uuid,jsonb)','erp_document_sales_report_options(uuid)','erp_document_sales_romaneio(uuid,jsonb)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
