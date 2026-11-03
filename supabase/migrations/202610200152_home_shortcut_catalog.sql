-- 152: Atalhos favoritos (Meu Negócio > Página inicial) acompanham o menu real do Origin no Brufap. A lista de telas de
-- erp_home.shortcut_catalog() é gerada do menu (apps/erp/src/lib/origin-menu.ts) por tools/home/generate-shortcut-catalog.mjs,
-- junto com HOME_SHORTCUTS do Worker; os testes falham se o menu, o Worker e este bloco divergirem. Esta migração entra com os
-- dashboards de Meu Negócio da 150. Se outra entrega acrescentar telas reais ao menu antes desta migração ser aplicada, basta
-- regerar o bloco (node tools/home/generate-shortcut-catalog.mjs --write). Somente a lista muda: as regras de 097 (perfis,
-- recursos, atalhos salvos que deixam de valer ficam ocultos) continuam as mesmas.
-- Também acrescenta os períodos 7D, 3M e 6M aos gráficos (erp_home_overview).
begin;

-- The version replaced here is the one of migration 107 (estoque lane); any other version stops the migration.
do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('erp_home.shortcut_catalog()')) is distinct from 'dc2126b7e7cceb7e96a28690ca154b3dec7b6b849d3e9728986e3a77ffc1d0f8' then
  raise exception 'home_shortcut_catalog_152_previous_definition_changed' using errcode='55000';end if;
end$$;

-- BEGIN GENERATED HOME SHORTCUTS (tools/home/generate-shortcut-catalog.mjs)
create or replace function erp_home.shortcut_catalog() returns table(ordinal integer,path text,roles text[],resource text)
language sql immutable set search_path=pg_catalog as $$
 values
  (1,'/meu-negocio?painel=mensal',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (2,'/meu-negocio?painel=margem-pedido',array['admin','consulta','financeiro','estoque','fiscal'],null::text),
  (3,'/painel-produtos-empresa',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (4,'/meu-negocio?painel=novos-recorrentes',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (5,'/meu-negocio?painel=curva-abc',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (6,'/meu-negocio?painel=metas',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (7,'/cadastros-reais?cadastro=products',null::text[],'products'),
  (8,'/cadastros-reais?cadastro=contacts',null::text[],'contacts'),
  (9,'/vendedores-empresa',array['admin','consulta','vendas','financeiro'],null::text),
  (10,'/funcionarios-empresa',array['admin'],null::text),
  (11,'/financeiro-empresa?area=contas-financeiras',array['admin','consulta','financeiro'],null::text),
  (12,'/financeiro-empresa?area=categories',array['admin','consulta','financeiro'],null::text),
  (13,'/formas-pagamento-empresa',array['admin','consulta','vendas','financeiro'],null::text),
  (14,'/categorias-produtos',null::text[],'products'),
  (15,'/listas-precos',null::text[],'products'),
  (16,'/documentos-empresa?tipo=sales_orders',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (17,'/historico-fiscal?modelo=55',array['admin','consulta','fiscal'],null::text),
  (18,'/historico-fiscal?modelo=65',array['admin','consulta','fiscal'],null::text),
  (19,'/documentos-empresa?tipo=sales_proposals',array['admin','consulta','vendas','financeiro'],null::text),
  (20,'/documentos-empresa?tipo=service_orders',array['admin','consulta','vendas','financeiro'],null::text),
  (21,'/documentos-empresa?tipo=service_orders&acao=relatorios',array['admin','consulta','vendas','financeiro'],null::text),
  (22,'/documentos-empresa?tipo=sales_orders&acao=relatorios',array['admin','consulta','vendas','financeiro','estoque','fiscal'],null::text),
  (23,'/documentos-empresa?tipo=purchase_orders',array['admin','consulta','financeiro','estoque','fiscal'],null::text),
  (24,'/notas-recebidas',array['admin','consulta','fiscal'],null::text),
  (25,'/cadastros-reais?cadastro=contacts&contato=fornecedor',null::text[],'contacts'),
  (26,'/painel-produtos-empresa?painel=sugestao',array['admin','consulta','estoque','fiscal'],null::text),
  (27,'/checkin-recebimentos',array['admin','estoque','fiscal'],null::text),
  (28,'/estoque-empresa',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (29,'/conferencia-estoque-empresa',array['admin','estoque'],null::text),
  (30,'/cadastros-reais?cadastro=warehouses',array['admin','consulta','estoque'],null::text),
  (31,'/relatorios-estoque',array['admin','consulta','vendas','estoque','fiscal'],null::text),
  (32,'/financeiro-empresa?area=accounts',array['admin','consulta','financeiro'],null::text),
  (33,'/financeiro-empresa?area=payable',array['admin','consulta','financeiro'],null::text),
  (34,'/financeiro-empresa?area=receivable',array['admin','consulta','financeiro'],null::text),
  (35,'/cobranca-operacional',array['admin','consulta','financeiro'],null::text),
  (36,'/financeiro-empresa?area=ficha',array['admin','consulta','financeiro'],null::text),
  (37,'/relatorio-vencimentos',array['admin','consulta','financeiro'],null::text)
$$;
revoke all on function erp_home.shortcut_catalog() from public,anon,authenticated,service_role;
-- END GENERATED HOME SHORTCUTS


-- Gráficos da página inicial: períodos 7D, 30D, 3M, 6M, 12M e Customizado do Origin (o Resumo diário mantém Hoje). Só a
-- escolha do período muda; os blocos e as regras de 097 são os mesmos. A versão substituída é a de 097.
do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure('public.erp_home_overview(uuid,text,text,text)')) is distinct from 'b898c52f9a7139a753a9c696e637c4802b9442c93b048e5970fd86120e47fd18' then
  raise exception 'home_overview_152_previous_definition_changed' using errcode='55000';end if;
end$$;
create or replace function public.erp_home_overview(p_user_id uuid,p_period text,p_from text default null,p_to text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
 v_base jsonb; v_role text; v_today date; v_from date; v_to date; v_grain text; v_from_text text; v_to_text text;
 v_sales jsonb:=null; v_receivable jsonb:=null; v_payable jsonb:=null; v_invoices jsonb:=null; v_points jsonb;
begin
 v_base:=public.erp_home_summary(p_user_id);
 v_role:=v_base->>'role'; v_today:=(v_base->>'business_date')::date;
 if p_period is null or p_period not in('hoje','7d','30d','3m','6m','12m','customizado')
  or (p_period<>'customizado' and (p_from is not null or p_to is not null)) then
  raise exception 'erp_home_period_invalid' using errcode='22023';
 end if;
 if p_period='hoje' then v_from:=v_today; v_to:=v_today;
 elsif p_period='7d' then v_from:=v_today-6; v_to:=v_today;
 elsif p_period='30d' then v_from:=v_today-29; v_to:=v_today;
 elsif p_period='3m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '2 months')::date; v_to:=v_today;
 elsif p_period='6m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '5 months')::date; v_to:=v_today;
 elsif p_period='12m' then v_from:=(date_trunc('month',v_today::timestamp)-interval '11 months')::date; v_to:=v_today;
 else
  if p_from is null or p_to is null or p_from!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_to!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or p_from<'1900-01-01' or p_to>'2100-12-31' then
   raise exception 'erp_home_period_invalid' using errcode='22023';
  end if;
  begin v_from:=p_from::date; v_to:=p_to::date;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception 'erp_home_period_invalid' using errcode='22023'; end;
  if to_char(v_from,'YYYY-MM-DD')<>p_from or to_char(v_to,'YYYY-MM-DD')<>p_to then raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
 end if;
 if v_to<v_from or v_to-v_from>365 then raise exception 'erp_home_period_invalid' using errcode='22023'; end if;
 v_grain:=case when v_to-v_from+1>62 then 'month' else 'day' end;
 v_from_text:=to_char(v_from,'YYYY-MM-DD'); v_to_text:=to_char(v_to,'YYYY-MM-DD');

 -- Pedidos de venda pela data do pedido. Valores em centavos exatos (numeric, nunca ponto flutuante).
 if erp_documents.allowed(v_role,'sales_orders',false) then
  with orders as materialized(
   select d.status,d.total from erp_documents.document d
   where d.kind='sales_orders' and d.body->>'date'>=v_from_text and d.body->>'date'<=v_to_text
  ) select jsonb_build_object('count',(select count(*) from orders),
    'statuses',(select jsonb_agg(jsonb_build_object('status',s,'count',(select count(*) from orders o where o.status=s),
      'total_cents',(select (coalesce(sum(o.total),0)*100)::bigint::text from orders o where o.status=s)) order by s)
     from jsonb_object_keys(erp_documents.transitions()->'sales_orders') s)) into v_sales;
 end if;

 -- Contas pela data de vencimento, sem canceladas. Taxas: tarifas das baixas desses títulos menos estornos.
 if v_role in('admin','financeiro','consulta') then
  select jsonb_build_object('count',count(*),'total_cents',coalesce(sum(t.amount_cents),0)::text,
    'open_cents',coalesce(sum(t.amount_cents-t.settled_cents),0)::text,
    'fee_cents',(select coalesce(sum(case when s.kind='payment' then s.fee_cents else -s.fee_cents end),0)::text
      from erp_finance.settlement s join erp_finance.title x on x.id=s.title_id
      where x.kind='receivable' and not x.cancelled and x.due_on between v_from and v_to))
   into v_receivable from erp_finance.title t where t.kind='receivable' and not t.cancelled and t.due_on between v_from and v_to;
  select jsonb_build_object('count',count(*),'total_cents',coalesce(sum(t.amount_cents),0)::text,
    'open_cents',coalesce(sum(t.amount_cents-t.settled_cents),0)::text)
   into v_payable from erp_finance.title t where t.kind='payable' and not t.cancelled and t.due_on between v_from and v_to;
 end if;

 -- "Novas NF-es": rascunhos de NF-e (modelo 55, homologação) criados no período e não arquivados.
 if v_role in('admin','fiscal') then
  select jsonb_build_object('count',count(*),
    'total_cents',coalesce(sum(round((d.snapshot#>>'{totals,total}')::numeric*100)),0)::bigint::text)
   into v_invoices from erp_fiscal_drafts.draft d
   where d.model='55' and d.status='draft'
    and d.created_at>=(v_from::timestamp at time zone 'America/Sao_Paulo')
    and d.created_at<((v_to+1)::timestamp at time zone 'America/Sao_Paulo');
 end if;

 -- Pontos do gráfico: por dia até 62 dias, senão por mês (meses das pontas podem ser parciais).
 with buckets as materialized(
  select g::date as start,case when v_grain='day' then to_char(g,'YYYY-MM-DD') else to_char(g,'YYYY-MM') end as bucket
  from generate_series(case when v_grain='day' then v_from::timestamp else date_trunc('month',v_from::timestamp) end,
   v_to::timestamp,case when v_grain='day' then interval '1 day' else interval '1 month' end) g
 ), sales as(
  select case when v_grain='day' then d.body->>'date' else left(d.body->>'date',7) end as bucket,sum(d.total) as total
  from erp_documents.document d
  where v_sales is not null and d.kind='sales_orders' and d.status<>'cancelled' and d.body->>'date'>=v_from_text and d.body->>'date'<=v_to_text
  group by 1
 ), titles as(
  select case when v_grain='day' then to_char(t.due_on,'YYYY-MM-DD') else to_char(t.due_on,'YYYY-MM') end as bucket,
   sum(t.amount_cents) filter(where t.kind='receivable') as receivable,sum(t.amount_cents) filter(where t.kind='payable') as payable
  from erp_finance.title t
  where v_receivable is not null and not t.cancelled and t.due_on between v_from and v_to
  group by 1
 ) select jsonb_agg(jsonb_build_object('bucket',b.bucket,
   'sales_cents',case when v_sales is null then null else (coalesce(s.total,0)*100)::bigint::text end,
   'receivable_cents',case when v_receivable is null then null else coalesce(t.receivable,0)::text end,
   'payable_cents',case when v_payable is null then null else coalesce(t.payable,0)::text end) order by b.start)
  into v_points from buckets b left join sales s on s.bucket=b.bucket left join titles t on t.bucket=b.bucket;

 return v_base||jsonb_build_object('period',jsonb_build_object('key',p_period,'from',v_from_text,'to',v_to_text,
  'day_count',v_to-v_from+1,'grain',v_grain,'points',v_points,
  'sales',v_sales,'receivable',v_receivable,'payable',v_payable,'invoices',v_invoices));
end $$;
revoke all on function public.erp_home_overview(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_home_overview(uuid,text,text,text) to service_role;

commit;
