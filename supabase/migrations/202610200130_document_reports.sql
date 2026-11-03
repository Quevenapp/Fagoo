-- Relatórios de vendas e de serviço do Origin, somente leitura, sobre os documentos nativos do Brufap:
-- * erp_document_sales_report: Relatório de Vendas (agrupa por cliente, produto, vendedor ou bairro, com sub agrupamento),
--   com Período, Data a ser considerada (pedido ou prevista), Situação, Incluir Frete, Cliente, Produto, Depósito, Cidade, UF,
--   "Não considerar pedidos com nota fiscal gerada" (só administrador e fiscal, que leem as notas do Brufap) e "Filtrar por
--   primeira compra". Agrupado (ou sub agrupado) por produto, o
--   valor é o total dos itens; nos outros agrupamentos é o total do pedido (com ou sem o frete).
-- * erp_document_sales_abc: curva ABC dos itens vendidos no período (A até 80% do valor acumulado, B até 95%, C o restante).
-- * erp_document_service_report: Relatório de Ordem de Serviço (Número, Nome, Data, Total das peças, Total de serviços, Preço total
--   e Situação), com as condições "Coluna + Valor" do relatório customizável. Serviços são os itens ligados a um produto do tipo
--   Serviço (S); o restante são peças.
-- * erp_document_service_occurrence_report: Relatório de Ocorrências por Ordem de Serviço (ocorrências não removidas).
-- Valores em numeric e devolvidos como texto exato; nenhum efeito é criado. Requer 008, 022, 102, 103, 112, 117 e 129.
begin;

-- The vendedor of a pedido is the declared Origin reference (054); the Brufap has no native seller yet.
create function erp_documents.report_seller(p_body jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
 select coalesce(nullif(btrim(p_body#>>'{commercial,seller_reference,label}'),''),case when p_body#>>'{commercial,seller_reference,source_id}' is not null
  then 'Vendedor Origin '||(p_body#>>'{commercial,seller_reference,source_id}') end)
$$;

create function public.erp_document_sales_report(p_user_id uuid,p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_group text; v_sub text; v_order text; v_date text; v_statuses text[]; v_freight boolean; v_items boolean;
 v_contact uuid; v_product uuid; v_warehouse uuid; v_city text; v_state text; v_without boolean; v_first boolean; v_groups jsonb; v_totals jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or exists(select 1 from jsonb_object_keys(p_filters) k where k not in
   ('from','to','date_type','group','subgroup','order','statuses','include_freight','contact_id','product_id','warehouse_id','city','state','without_invoice','first_purchase'))
  or exists(select 1 from unnest(array['include_freight','without_invoice','first_purchase']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'boolean')
  or exists(select 1 from unnest(array['date_type','group','subgroup','order']) k where p_filters?k and jsonb_typeof(p_filters->k)<>'string') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(p_filters->'from',true); v_to:=erp_documents.date_value(p_filters->'to',true);
 v_group:=coalesce(p_filters->>'group','contact'); v_sub:=nullif(p_filters->>'subgroup','none'); v_order:=coalesce(p_filters->>'order','name'); v_date:=coalesce(p_filters->>'date_type','date');
 v_freight:=coalesce((p_filters->>'include_freight')::boolean,true); v_without:=coalesce((p_filters->>'without_invoice')::boolean,false); v_first:=coalesce((p_filters->>'first_purchase')::boolean,false);
 v_contact:=erp_documents.uuid_value(p_filters->'contact_id'); v_product:=erp_documents.uuid_value(p_filters->'product_id'); v_warehouse:=erp_documents.uuid_value(p_filters->'warehouse_id');
 v_city:=lower(erp_documents.text_value(p_filters->'city',100)); v_state:=upper(erp_documents.text_value(p_filters->'state',2));
 if p_filters ? 'statuses' and p_filters->'statuses'<>'null'::jsonb then
  if jsonb_typeof(p_filters->'statuses')<>'array' or jsonb_array_length(p_filters->'statuses') not between 1 and 20
   or exists(select 1 from jsonb_array_elements(p_filters->'statuses') s where jsonb_typeof(s)<>'string' or not (erp_documents.transitions()->'sales_orders')?(s#>>'{}')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  select array_agg(distinct s) into v_statuses from jsonb_array_elements_text(p_filters->'statuses') s;
 end if;
 if v_from>v_to or v_to-v_from>731 or v_group not in('contact','product','seller','district') or (v_sub is not null and (v_sub not in('contact','product','seller') or v_sub=v_group))
  or v_order not in('name','amount','items','sales') or v_date not in('date','expected_date')
  or (v_state is not null and v_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|EX|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$') then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 -- The Brufap notas (and their drafts) are read only by admin and fiscal (113), so only they filter by them.
 if v_without and not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal')) then
  raise exception 'erp_document_access_denied' using errcode='42501'; end if;
 v_items:=v_group='product' or coalesce(v_sub,'')='product';
 with orders as materialized(
  select d.id,d.contact_id,d.contact_snapshot,d.body,d.total,coalesce((d.body->>'freight')::numeric,0) freight
  from erp_documents.document d
  where d.kind='sales_orders' and (v_statuses is null or d.status=any(v_statuses))
   and (case when v_date='expected_date' then d.body->>'expected_date' else d.body->>'date' end) between v_from::text and v_to::text
   and (v_contact is null or d.contact_id=v_contact) and (v_warehouse is null or d.warehouse_id=v_warehouse)
   and (v_city is null or strpos(lower(coalesce(d.contact_snapshot->>'city','')),v_city)>0) and (v_state is null or upper(coalesce(d.contact_snapshot->>'state',''))=v_state)
   and (v_product is null or exists(select 1 from erp_documents.item i where i.document_id=d.id and i.product_id=v_product))
   and (not v_without or (not exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft')
    and not exists(select 1 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null)))
   and (not v_first or (d.status<>'cancelled' and not exists(select 1 from erp_documents.document f where f.kind='sales_orders' and f.contact_id=d.contact_id and f.status<>'cancelled'
    and f.id<>d.id and (f.body->>'date',f.number)<(d.body->>'date',d.number))))
 ), lines as materialized(
  -- One row per item when a product dimension is used (value = item total); else one row per pedido (value = total, with or without frete).
  select o.id order_id,o.contact_id,o.contact_snapshot,o.body,i.product_id,i.data->>'description' description,i.data->>'code' code,i.quantity,
   i.total as amount from orders o join erp_documents.item i on i.document_id=o.id where v_items and (v_product is null or i.product_id=v_product)
  union all
  select o.id,o.contact_id,o.contact_snapshot,o.body,null,null,null,(select coalesce(sum(i.quantity),0) from erp_documents.item i where i.document_id=o.id),
   o.total-case when v_freight then 0 else o.freight end from orders o where not v_items
 ), keyed as materialized(
  select l.*,
   case v_group when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then coalesce(erp_documents.report_seller(l.body),'')
    else lower(coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'')) end group_key,
   case v_group when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then coalesce(erp_documents.report_seller(l.body),'Sem vendedor') else coalesce(nullif(btrim(l.body#>>'{delivery_address,district}'),''),nullif(btrim(l.contact_snapshot->>'district'),''),'Sem bairro') end group_label,
   case v_sub when 'contact' then l.contact_id::text when 'product' then coalesce(l.product_id::text,'livre:'||lower(l.description)) when 'seller' then coalesce(erp_documents.report_seller(l.body),'') end sub_key,
   case v_sub when 'contact' then l.contact_snapshot->>'name' when 'product' then l.description||case when l.code is not null then ' ('||l.code||')' else '' end
    when 'seller' then coalesce(erp_documents.report_seller(l.body),'Sem vendedor') end sub_label
  from lines l
 ), subs as (
  select group_key,sub_key,min(sub_label) label,count(distinct order_id) sales,sum(quantity) items,sum(amount) amount from keyed where v_sub is not null group by group_key,sub_key
 ), groups as (
  select k.group_key,min(k.group_label) label,count(distinct k.order_id) sales,sum(k.quantity) items,sum(k.amount) amount from keyed k group by k.group_key
 ), ranked as (
  select g.*,row_number() over(order by case when v_order='amount' then g.amount end desc nulls last,case when v_order='items' then g.items end desc nulls last,
   case when v_order='sales' then g.sales end desc nulls last,lower(g.label),g.group_key) position from groups g
 )
 select coalesce(jsonb_agg(jsonb_build_object('key',r.group_key,'label',r.label,'sales',r.sales,'items',r.items::text,'amount',r.amount::numeric(20,2)::text,
   'subgroups',case when v_sub is null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('key',s.sub_key,'label',s.label,'sales',s.sales,'items',s.items::text,'amount',s.amount::numeric(20,2)::text)
    order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key),'[]'::jsonb)
    -- The 500 first sub groups in the chosen order (not an arbitrary 500).
    from (select * from subs s where s.group_key=r.group_key order by case when v_order='amount' then s.amount end desc nulls last,case when v_order='items' then s.items end desc nulls last,
     case when v_order='sales' then s.sales end desc nulls last,lower(s.label),s.sub_key limit 500) s) end) order by r.position) filter(where r.position<=2000),'[]'::jsonb),
  count(*),
  jsonb_build_object('sales',(select count(*) from orders),'items',(select coalesce(sum(quantity),0) from keyed)::text,'amount',(select coalesce(sum(amount),0) from keyed)::numeric(20,2)::text)
 into v_groups,v_count,v_totals from ranked r;
 return jsonb_build_object('report','sales','group',v_group,'subgroup',v_sub,'from',v_from::text,'to',v_to::text,'item_values',v_items,'include_freight',v_freight,
  'groups',v_groups,'group_count',v_count,'truncated',v_count>2000,'totals',v_totals,'data_mode','erp_native','operational_effects',false);
end $$;

-- Curva ABC: value of the items sold (pedidos não cancelados) in the period, ranked; A up to 80% accumulated, B up to 95%, C the rest.
create function public.erp_document_sales_abc(p_user_id uuid,p_from text,p_to text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_rows jsonb; v_total numeric; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',false);
 v_from:=erp_documents.date_value(to_jsonb(p_from),true); v_to:=erp_documents.date_value(to_jsonb(p_to),true);
 if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 with lines as(
  select coalesce(i.product_id::text,'livre:'||lower(i.data->>'description')) key,i.product_id,i.data->>'description' description,i.data->>'code' code,i.quantity,i.total
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date' between v_from::text and v_to::text
 ), products as(
  select key,(array_agg(product_id))[1] product_id,min(description) description,min(code) code,sum(quantity) quantity,sum(total) amount from lines group by key
 ), ranked as(
  select p.*,row_number() over(order by p.amount desc,lower(p.description),p.key) position,sum(p.amount) over() total,
   sum(p.amount) over(order by p.amount desc,lower(p.description),p.key rows between unbounded preceding and current row) accumulated from products p
 )
 select coalesce(jsonb_agg(jsonb_build_object('position',r.position,'product_id',r.product_id,'description',r.description,'code',r.code,'quantity',r.quantity::text,
   'amount',r.amount::numeric(20,2)::text,'percent',case when r.total>0 then round(r.amount*100/r.total,2) else 0 end::numeric(7,2)::text,
   'accumulated',case when r.total>0 then round(r.accumulated*100/r.total,2) else 0 end::numeric(7,2)::text,
   'class',case when r.total=0 or (r.accumulated-r.amount)*100<80*r.total then 'A' when (r.accumulated-r.amount)*100<95*r.total then 'B' else 'C' end) order by r.position) filter(where r.position<=5000),'[]'::jsonb),
  max(r.total),count(*) into v_rows,v_total,v_count from ranked r;
 return jsonb_build_object('report','abc','from',v_from::text,'to',v_to::text,'items',v_rows,'item_count',v_count,'truncated',v_count>5000,
  'total',coalesce(v_total,0)::numeric(20,2)::text,'data_mode','erp_native','operational_effects',false);
end $$;

-- Relatório de Ordem de Serviço with the Origin "Coluna + Valor" conditions (all of them must match).
create function public.erp_document_service_report(p_user_id uuid,p_conditions jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_rows jsonb; v_count bigint; v_condition jsonb;
begin
 perform erp_documents.require_access(p_user_id,'service_orders',false);
 if p_conditions is null or jsonb_typeof(p_conditions)<>'array' or jsonb_array_length(p_conditions)>10 then raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 for v_condition in select x from jsonb_array_elements(p_conditions) x loop
  if jsonb_typeof(v_condition)<>'object' or (select count(*) from jsonb_object_keys(v_condition))<>2 or not(v_condition?'column' and v_condition?'value') or jsonb_typeof(v_condition->'value')<>'string'
   or v_condition->>'column' not in('number','name','date','parts','services','total','status') or length(v_condition->>'value') not between 1 and 120 or (v_condition->>'value')~'[[:cntrl:]]'
   or (v_condition->>'column'='number' and v_condition->>'value'!~'^[1-9][0-9]{0,9}$') or (v_condition->>'column'='date' and v_condition->>'value'!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
   or (v_condition->>'column' in('parts','services','total') and v_condition->>'value'!~'^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$')
   or (v_condition->>'column'='status' and not (erp_documents.transitions()->'service_orders')?(v_condition->>'value')) then
   raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
  if v_condition->>'column'='date' then perform erp_documents.date_value(v_condition->'value',true); end if;
 end loop;
 with os as(
  select d.id,d.number,d.contact_snapshot->>'name' as name,d.body->>'date' as day,d.status,d.total,
   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and coalesce(i.product_snapshot->>'kind','')='S'),0) services,
   coalesce((select sum(i.total) from erp_documents.item i where i.document_id=d.id and coalesce(i.product_snapshot->>'kind','')<>'S'),0) parts
  from erp_documents.document d where d.kind='service_orders'
 ), filtered as(
  select o.* from os o where not exists(select 1 from jsonb_array_elements(p_conditions) c where not case c->>'column'
   when 'number' then o.number=(c->>'value')::bigint when 'name' then strpos(lower(coalesce(o.name,'')),lower(btrim(c->>'value')))>0
   when 'date' then o.day=c->>'value' when 'parts' then o.parts=(c->>'value')::numeric when 'services' then o.services=(c->>'value')::numeric
   when 'total' then o.total=(c->>'value')::numeric else o.status=c->>'value' end)
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'number',f.number::text,'name',f.name,'date',f.day,'parts',f.parts::numeric(20,2)::text,'services',f.services::numeric(20,2)::text,
   'total',f.total::text,'status',f.status) order by f.day desc,f.number desc) filter(where f.rn<=5000),'[]'::jsonb),count(*)
 into v_rows,v_count from (select f.*,row_number() over(order by f.day desc,f.number desc) rn from filtered f) f;
 return jsonb_build_object('report','service_orders','rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $$;

-- Relatório de Ocorrências por Ordem de Serviço: the occurrences still shown in the modal, in a period.
create function public.erp_document_service_occurrence_report(p_user_id uuid,p_from text,p_to text,p_status text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_rows jsonb; v_count bigint;
begin
 perform erp_documents.require_access(p_user_id,'service_orders',false);
 v_from:=erp_documents.date_value(to_jsonb(p_from),true); v_to:=erp_documents.date_value(to_jsonb(p_to),true);
 if v_from>v_to or v_to-v_from>366 or (p_status is not null and not (erp_documents.transitions()->'service_orders')?p_status) then
  raise exception 'erp_document_report_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('document_id',x.document_id,'number',x.number::text,'name',x.name,'occurred_on',x.occurred_on::text,'occurred_time',x.occurred_time,
   'text',x.text,'status_before',x.status_before,'status_after',x.status_after,'actor_name',x.actor_name,'actor_role',x.actor_role) order by x.occurred_on desc,x.occurred_time desc,x.number desc,x.sequence desc) filter(where x.rn<=5000),'[]'::jsonb),count(*)
 into v_rows,v_count from (
  select o.*,d.number,d.contact_snapshot->>'name' name,(select left(p.name,120) from erp_access.profile p where p.user_id=o.actor_id) actor_name,
   row_number() over(order by o.occurred_on desc,o.occurred_time desc,d.number desc,o.sequence desc) rn
  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.kind='service_orders' and o.occurred_on between v_from and v_to and (p_status is null or coalesce(o.status_after,o.status_before)=p_status)
   and not exists(select 1 from erp_documents.occurrence_removal r where r.occurrence_id=o.id)) x;
 return jsonb_build_object('report','service_occurrences','from',v_from::text,'to',v_to::text,'rows',v_rows,'row_count',v_count,'truncated',v_count>5000,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function erp_documents.report_seller(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_sales_report(uuid,jsonb),public.erp_document_sales_abc(uuid,text,text),public.erp_document_service_report(uuid,jsonb),
 public.erp_document_service_occurrence_report(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_sales_report(uuid,jsonb),public.erp_document_sales_abc(uuid,text,text),public.erp_document_service_report(uuid,jsonb),
 public.erp_document_service_occurrence_report(uuid,text,text,text) to service_role;
commit;
