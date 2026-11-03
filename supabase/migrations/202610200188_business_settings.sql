-- 188: Meu Negócio › Ajustes ganha a alíquota de imposto e Empresa › Espaço e armazenamento ganha o limite de armazenamento.
-- * "Alíquota de imposto sobre as vendas (%)" (negocio.aliquota_imposto, 0 a 100 com 2 casas): o imposto estimado de cada
--   pedido é round((valor − frete) × alíquota / 100, 2). Entra em IMPOSTOS e LUCRO (lucro = faturamento sem frete − preço de
--   custo − impostos, só para quem vê o custo) dos dashboards Mensal e Diário, em Impostos e Margem Contribuição % de Vendas por
--   canal (Pedidos de Venda) e na margem de contribuição da Margem por Pedido (faturamento sem frete − custo − imposto). Taxas
--   de marketplace continuam fora do escopo. É estimativa gerencial: não muda nenhuma nota fiscal.
-- * "Limite de armazenamento (GB)" (armazenamento.limite_gb, 0 = sem limite): erp_access_storage devolve limit_bytes.
-- Substitui erp_home.biz_indicators, erp_home_business_orders e erp_home_business_margin (150) e erp_access_storage (151);
-- qualquer outra versão interrompe a migração.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_home.biz_indicators(date,date,text[],boolean)','7420c916a55a778e3c2ac380b50cce585327a7b7d627b6cee2fcbf65b27a194f'),
  ('public.erp_home_business_margin(uuid,jsonb,date,date,text)','0a976f2feec0056ecd07948734de43a3194e7b031b2470acef1d1fa128ef834c'),
  ('public.erp_home_business_orders(uuid,jsonb,date,date,text)','ff49cfc51acd4127471b7794693c19b4f718ef261d4c7707be1f7b1fa0711734'),
  ('public.erp_access_storage(uuid)','f3f8e27591c208d6a3fb2bdd6c67eb1e7caf50290c1e80d0c133d9ac0aa4e7c8')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'business_settings_188_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
end$$;

-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.page(id,category,ordinal,scope,read_roles)values
 ('empresa-armazenamento','empresa',19,'company',array['admin','consulta','vendas','financeiro','estoque','fiscal']::text[]);
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('negocio.aliquota_imposto','meu-negocio','impostos',2,'decimal',null,'"0"'::jsonb,0,100,2,null,null,null),
 ('armazenamento.limite_gb','empresa-armazenamento','limite',1,'integer',null,'0'::jsonb,0,100000,null,null,null,null);
-- END GENERATED DEFINITIONS

-- Alíquota of Meu Negócio › Ajustes (a value the page accepted, else 0).
create function erp_home.biz_tax_rate() returns numeric language sql stable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='string' and(v#>>'{}')~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$' and(v#>>'{}')::numeric<=100 then(v#>>'{}')::numeric else 0 end
 from(select erp_preferences.get('negocio.aliquota_imposto') v) x
$$;
create function erp_home.biz_tax(p_revenue numeric) returns numeric language sql stable set search_path=pg_catalog as $$ select round(coalesce(p_revenue,0)*erp_home.biz_tax_rate()/100,2) $$;

-- FATURAMENTO SEM FRETE, PREÇO DE CUSTO, MARGEM BRUTA, IMPOSTOS, TAXA VENDA e LUCRO. Without purchase access the cost, the margin
-- and the profit are null; lines without a known cost are counted, never priced at zero.
create or replace function erp_home.biz_indicators(p_from date,p_to date,p_statuses text[],p_cost boolean) returns jsonb language sql stable set search_path=pg_catalog as $$
 with o as(select coalesce(sum(total-freight),0) revenue,coalesce(sum(erp_home.biz_tax(total-freight)),0) taxes from erp_home.biz_orders(p_from,p_to,p_statuses)),
  l as(select coalesce(sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null),0) cost,count(*) filter(where unit_cost is null)::integer missing from erp_home.biz_lines(p_from,p_to,p_statuses) where p_cost)
 select jsonb_build_object('revenue_without_freight',erp_home.money(o.revenue),'cost',case when p_cost then erp_home.money(l.cost) end,
  'gross_margin',case when p_cost then erp_home.money(o.revenue-l.cost) end,'gross_margin_pct',case when p_cost then erp_home.pct(o.revenue-l.cost,o.revenue) end,
  'lines_without_cost',case when p_cost then l.missing end,'taxes',erp_home.money(o.taxes),'fees',null,'profit',case when p_cost then erp_home.money(o.revenue-l.cost-o.taxes) end)
 from o left join l on true
$$;

create or replace function public.erp_home_business_orders(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_state text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_cost boolean;
begin
 v_role:=erp_home.biz_role(p_user_id);v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if p_state is not null and p_state!~'^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO|EX)$' then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_cost:=erp_home.biz_cost_visible(v_role);
 return erp_home.biz_envelope('pedidos-venda',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'state',p_state))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) where p_state is null or state=p_state),
    l as materialized(select l.*,o.state from erp_home.biz_lines(p_from,p_to,v_s) l join o on o.id=l.document_id)
   select jsonb_build_object(
    'totals',(select jsonb_build_object('orders',count(*)::integer,'units',erp_home.qty(sum(units)),'total',erp_home.money(sum(total)),'freight',erp_home.money(sum(freight)),'ticket',erp_home.ratio(sum(total),count(*))) from o),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'orders',coalesce(x.orders,0),'total',erp_home.money(x.total)) order by n),'[]'::jsonb)
      from unnest(v_s) with ordinality u(s,n) left join(select status,count(*)::integer orders,sum(total) total from o group by status) x on x.status=u.s),
    'by_state',(select coalesce(jsonb_agg(jsonb_build_object('state',state,'orders',orders,'units',erp_home.qty(units),'total',erp_home.money(total),'freight_avg',erp_home.ratio(freight,orders),'ticket',erp_home.ratio(total,orders)) order by total desc,state nulls last),'[]'::jsonb)
      from(select state,count(*)::integer orders,sum(units) units,sum(total) total,sum(freight) freight from o group by state) x),
    'by_product',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'code',code,'name',name,'units',erp_home.qty(units),'total',erp_home.money(total),
       'cost',case when v_cost and not missing then erp_home.money(cost) end,'margin_pct',case when v_cost and not missing then erp_home.pct(total-cost,total) end,'stock',null) order by total desc,units desc,name,product_key),'[]'::jsonb)
      from(select product_key,(array_agg(product_id))[1] product_id,max(code) code,max(name) name,sum(quantity) units,sum(total) total,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
       from l group by product_key order by sum(total) desc,sum(quantity) desc,max(name),product_key limit 300) x),160000),
    'by_channel',(select coalesce(jsonb_agg(jsonb_build_object('channel',c.channel,'orders',c.orders,'ticket',erp_home.ratio(c.total,c.orders),'units',erp_home.qty(c.units),
       'cost',case when v_cost and not c.missing then erp_home.money(c.cost) end,'total',erp_home.money(c.total),'freight',erp_home.money(c.freight),'unit_value',erp_home.ratio(c.total-c.freight,c.units),
       'margin_pct',case when v_cost and not c.missing then erp_home.pct(c.total-c.freight-c.cost,c.total-c.freight) end,'taxes',erp_home.money(c.taxes),'fees',null,
       'contribution_pct',case when v_cost and not c.missing then erp_home.pct(c.total-c.freight-coalesce(c.cost,0)-c.taxes,c.total-c.freight) end) order by c.total desc,c.channel),'[]'::jsonb)
      from(select o.channel,count(*)::integer orders,sum(o.units) units,sum(o.total) total,sum(o.freight) freight,sum(erp_home.biz_tax(o.total-o.freight)) taxes,
        (select sum(round(l.quantity*l.unit_cost,2)) from l where l.channel=o.channel and l.unit_cost is not null) cost,
        coalesce((select bool_or(l.unit_cost is null) from l where l.channel=o.channel),false) missing from o group by o.channel) c))
   );
end $$;

create or replace function public.erp_home_business_margin(p_user_id uuid,p_statuses jsonb,p_from date,p_to date,p_tab text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];
begin
 v_role:=erp_home.biz_role(p_user_id);
 if not erp_home.biz_cost_visible(v_role) then raise exception 'erp_home_business_access_denied' using errcode='42501'; end if;
 v_s:=erp_home.biz_statuses_json(p_statuses);perform erp_home.biz_period(p_from,p_to);
 if p_tab is null or p_tab not in('todos','lucro','prejuizo') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 return erp_home.biz_envelope('margem-pedido',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'tab',p_tab))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s)),
    c as materialized(select o.*,x.cost,coalesce(x.missing,false) missing,o.total-o.freight revenue,erp_home.biz_tax(o.total-o.freight) tax from o left join(select document_id,sum(round(quantity*unit_cost,2)) filter(where unit_cost is not null) cost,bool_or(unit_cost is null) missing
     from erp_home.biz_lines(p_from,p_to,v_s) group by document_id) x on x.document_id=o.id),
    k as materialized(select *,case when missing then null else revenue-coalesce(cost,0)-tax end contribution from c)
   select jsonb_build_object(
    'indicators',(select jsonb_build_object('revenue',erp_home.money(sum(total)),'ticket',erp_home.ratio(sum(total),count(*)),'orders',count(*)::integer,'freight_buyer',null,'freight_seller',erp_home.money(sum(freight)),
      'cost',erp_home.money(sum(cost) filter(where not missing)),'taxes',erp_home.money(sum(tax)),'fees',null,'contribution',erp_home.money(sum(contribution)),
      'contribution_pct',erp_home.pct(sum(contribution),sum(revenue) filter(where not missing)),'orders_without_cost',(count(*) filter(where missing))::integer) from k),
    'progression',(select coalesce(jsonb_agg(jsonb_build_object('day',to_char(g.d,'YYYY-MM-DD'),'revenue',erp_home.money((select sum(revenue) from k where k.day=g.d::date)),
       'contribution',erp_home.money((select sum(contribution) from k where k.day=g.d::date))) order by g.d),'[]'::jsonb) from generate_series(p_from::timestamp,least(p_to,p_from+365)::timestamp,interval '1 day') g(d)),
    'total',(select count(*)::integer from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0),
    'orders',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number::text,'day',to_char(day,'YYYY-MM-DD'),'contact',contact_name,'channel',channel,'total',erp_home.money(total),
       'freight',erp_home.money(freight),'revenue',erp_home.money(revenue),'cost',case when missing then null else erp_home.money(cost) end,'contribution',case when missing then null else erp_home.money(contribution) end,
       'contribution_pct',case when missing then null else erp_home.pct(contribution,revenue) end) order by day desc,number desc),'[]'::jsonb)
      from(select * from k where p_tab='todos' or p_tab='lucro' and contribution>=0 or p_tab='prejuizo' and contribution<0 order by day desc,number desc limit 500) x),160000)));
end $$;

-- Espaço e armazenamento: bytes of the private buckets of the project, by group, and the limit set by the administrador.
create or replace function public.erp_access_storage(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_groups jsonb;v_total numeric;v_count bigint;v_limit jsonb;
begin
 v_role:=erp_access.member_role(p_user_id);
 with o as materialized(select erp_access.storage_group(bucket_id) g,case when metadata->>'size'~'^[0-9]{1,15}$' then(metadata->>'size')::numeric else 0 end bytes from storage.objects),
  g as(select k.g,k.n,coalesce(sum(o.bytes),0) bytes,count(o.g) objects from unnest(array['anexos','fiscal','cobranca','backup','certificado','outros']) with ordinality k(g,n) left join o on o.g=k.g group by k.g,k.n)
 select(select coalesce(sum(bytes),0) from o),(select count(*) from o),jsonb_agg(jsonb_build_object('group',g,'bytes',bytes::text,'objects',objects::integer) order by n) into v_total,v_count,v_groups from g;
 v_limit:=erp_preferences.get('armazenamento.limite_gb');
 return jsonb_build_object('scope','storage_usage','data_mode','erp_native','total_bytes',v_total::text,'objects',v_count::integer,
  'limit_bytes',case when jsonb_typeof(v_limit)='number' and(v_limit#>>'{}')~'^[1-9][0-9]{0,5}$' then((v_limit#>>'{}')::numeric*1073741824)::text end,
  'groups',case when v_role='admin' then v_groups end,'as_of',clock_timestamp());
end $$;

revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_home_business_orders','erp_home_business_margin','erp_access_storage')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
