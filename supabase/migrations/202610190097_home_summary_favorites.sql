-- Página inicial no padrão Origin: "Resumo diário" por período (Hoje, 30D, 12M, Customizado) e
-- "Atalhos favoritos" por usuário. Somente registros nativos do Brufap; o histórico do Origin segue separado.
-- Não altera documentos, títulos, estoque, rascunhos fiscais nem a RPC erp_home_summary(uuid) existente.
begin;

-- Filtros novos: rascunhos de NF-e por data de criação. Pedidos (kind, body->>'date') e títulos
-- (kind, due_on) já têm índices nas migrações 015 e 010.
create index erp_fiscal_drafts_home_period on erp_fiscal_drafts.draft(model,created_at) where status='draft';

create schema erp_home;
revoke all on schema erp_home from public,anon,authenticated,service_role;

-- Uma lista por usuário autenticado. Acesso somente pelas RPCs abaixo, que recebem o ator verificado pela API.
create table erp_home.shortcut_preference(
 user_id uuid primary key references auth.users(id) on delete cascade,
 shortcuts text[] not null check(cardinality(shortcuts)<=20 and array_position(shortcuts,null) is null),
 version integer not null check(version>0),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create table erp_home.shortcut_command(
 command_id uuid primary key,actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null default clock_timestamp()
);
create table erp_home.shortcut_audit(
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),
 command_id uuid not null references erp_home.shortcut_command(command_id) deferrable initially deferred,
 before_data jsonb,after_data jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table erp_home.shortcut_preference enable row level security;
alter table erp_home.shortcut_command enable row level security;
alter table erp_home.shortcut_audit enable row level security;
revoke all on all tables in schema erp_home from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_home from public,anon,authenticated,service_role;
alter default privileges in schema erp_home revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_home revoke all on functions from public,anon,authenticated,service_role;

create function erp_home.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_home_history_immutable' using errcode='42501'; end $$;
create trigger immutable_command before update or delete on erp_home.shortcut_command for each row execute function erp_home.immutable_history();
create trigger immutable_audit before update or delete on erp_home.shortcut_audit for each row execute function erp_home.immutable_history();

create function erp_home.require_member(p_user_id uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v_role text;
begin
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 if not found then raise exception 'erp_home_access_denied' using errcode='42501'; end if;
 return v_role;
end $$;

-- Espelho de apps/erp/src/lib/origin-menu.ts resolveMenu('real'): telas reais do menu (sem a própria página
-- inicial). Itens com recurso seguem erp_access.resources_for_role; os demais seguem a lista de perfis.
-- Testes de paridade comparam esta tabela com o menu para cada perfil.
create function erp_home.shortcut_catalog() returns table(ordinal integer,path text,roles text[],resource text)
language sql immutable set search_path=pg_catalog as $$
 values
  (1,'/cadastros-reais?cadastro=products',null::text[],'products'),
  (2,'/cadastros-reais?cadastro=contacts',null::text[],'contacts'),
  (3,'/financeiro-empresa?area=accounts',array['admin','consulta','financeiro'],null::text),
  (4,'/financeiro-empresa?area=categories',array['admin','consulta','financeiro'],null),
  (5,'/documentos-empresa?tipo=sales_orders',array['admin','consulta','financeiro','vendas','estoque','fiscal'],null),
  (6,'/historico-fiscal?modelo=55',array['admin','consulta','fiscal'],null),
  (7,'/historico-fiscal?modelo=65',array['admin','consulta','fiscal'],null),
  (8,'/documentos-empresa?tipo=sales_proposals',array['admin','consulta','financeiro','vendas'],null),
  (9,'/documentos-empresa?tipo=service_orders',array['admin','consulta','financeiro','vendas'],null),
  (10,'/documentos-empresa?tipo=purchase_orders',array['admin','consulta','financeiro','estoque','fiscal'],null),
  (11,'/notas-recebidas',array['admin','fiscal','consulta'],null),
  (12,'/cadastros-reais?cadastro=contacts&contato=fornecedor',null::text[],'contacts'),
  (13,'/estoque-empresa',array['admin','consulta','vendas','estoque','fiscal'],null),
  (14,'/cadastros-reais?cadastro=warehouses',array['admin','consulta','estoque'],null),
  (15,'/financeiro-empresa?area=payable',array['admin','consulta','financeiro'],null),
  (16,'/financeiro-empresa?area=receivable',array['admin','consulta','financeiro'],null),
  (17,'/cobranca-operacional',array['admin','consulta','financeiro'],null),
  (18,'/relatorio-vencimentos',array['admin','consulta','financeiro'],null)
$$;
create function erp_home.shortcut_allowed(p_role text,p_path text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select coalesce((select (c.roles is null or p_role=any(c.roles))
   and (c.resource is null or c.resource=any(erp_access.resources_for_role(p_role)))
  from erp_home.shortcut_catalog() c where c.path=p_path),false)
$$;
create function erp_home.available_shortcuts(p_role text) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(c.path order by c.ordinal),'[]'::jsonb) from erp_home.shortcut_catalog() c where erp_home.shortcut_allowed(p_role,c.path)
$$;
-- Ordem dos atalhos do Origin capturados (Pedidos de venda, Notas fiscais, Listagem de produtos,
-- Clientes e fornecedores), mais contas a receber/pagar para quem usa o financeiro.
create function erp_home.default_shortcuts() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['/documentos-empresa?tipo=sales_orders','/historico-fiscal?modelo=55','/cadastros-reais?cadastro=products',
  '/cadastros-reais?cadastro=contacts','/financeiro-empresa?area=receivable','/financeiro-empresa?area=payable']
$$;
-- Uma permissão retirada depois de salvar esconde o atalho, sem apagar a lista gravada.
create function erp_home.visible_shortcuts(p_role text,p_shortcuts text[]) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(s order by o),'[]'::jsonb) from unnest(p_shortcuts) with ordinality u(s,o) where erp_home.shortcut_allowed(p_role,s)
$$;

create function public.erp_home_shortcuts_get(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_row erp_home.shortcut_preference;
begin
 v_role:=erp_home.require_member(p_user_id);
 select * into v_row from erp_home.shortcut_preference where user_id=p_user_id;
 return jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,
  'version',coalesce(v_row.version,0),'customized',v_row.user_id is not null,
  'shortcuts',erp_home.visible_shortcuts(v_role,coalesce(v_row.shortcuts,erp_home.default_shortcuts())),
  'available',erp_home.available_shortcuts(v_role));
end $$;

-- Substitui a lista inteira (adicionar, remover). CAS por versão, command_id idempotente, auditoria.
create function public.erp_home_shortcuts_save(p_user_id uuid,p_command_id uuid,p_expected_version integer,p_shortcuts jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_hash text; v_command erp_home.shortcut_command; v_row erp_home.shortcut_preference;
 v_list text[]; v_version integer; v_result jsonb;
begin
 v_role:=erp_home.require_member(p_user_id);
 if p_command_id is null or p_expected_version is null or p_expected_version<0 or p_expected_version>=2147483647
  or p_shortcuts is null or jsonb_typeof(p_shortcuts)<>'array' or jsonb_array_length(p_shortcuts)>20
  or exists(select 1 from jsonb_array_elements(p_shortcuts) e where jsonb_typeof(e)<>'string') then
  raise exception 'erp_home_shortcuts_invalid' using errcode='22023';
 end if;
 select coalesce(array_agg(e order by o),'{}'::text[]) into v_list from jsonb_array_elements_text(p_shortcuts) with ordinality x(e,o);
 if cardinality(v_list)<>(select count(distinct e) from unnest(v_list) e)
  or exists(select 1 from unnest(v_list) e where not exists(select 1 from erp_home.shortcut_catalog() c where c.path=e)) then
  raise exception 'erp_home_shortcuts_invalid' using errcode='22023';
 end if;
 if exists(select 1 from unnest(v_list) e where not erp_home.shortcut_allowed(v_role,e)) then
  raise exception 'erp_home_shortcut_forbidden' using errcode='42501';
 end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','shortcuts','actor',p_user_id,'version',p_expected_version,'shortcuts',p_shortcuts)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtext('erp_home_shortcuts'),hashtext(p_user_id::text));
 select * into v_command from erp_home.shortcut_command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_home_command_conflict' using errcode='40001'; end if;
  return v_command.result||jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,
   'available',erp_home.available_shortcuts(v_role),'replayed',true);
 end if;
 select * into v_row from erp_home.shortcut_preference where user_id=p_user_id for update;
 if coalesce(v_row.version,0)<>p_expected_version then raise exception 'erp_home_shortcuts_version_conflict' using errcode='40001'; end if;
 v_version:=p_expected_version+1;
 if v_row.user_id is null then
  insert into erp_home.shortcut_preference(user_id,shortcuts,version) values(p_user_id,v_list,v_version);
 else
  update erp_home.shortcut_preference set shortcuts=v_list,version=v_version,updated_at=clock_timestamp() where user_id=p_user_id;
 end if;
 v_result:=jsonb_build_object('version',v_version,'customized',true,'shortcuts',to_jsonb(v_list));
 insert into erp_home.shortcut_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 insert into erp_home.shortcut_audit(actor,command_id,before_data,after_data) values(p_user_id,p_command_id,
  case when v_row.user_id is null then null else jsonb_build_object('version',v_row.version,'shortcuts',to_jsonb(v_row.shortcuts)) end,
  jsonb_build_object('version',v_version,'shortcuts',to_jsonb(v_list)));
 return v_result||jsonb_build_object('scope','home_shortcuts','data_mode','erp_native','role',v_role,
  'available',erp_home.available_shortcuts(v_role),'replayed',false);
end $$;

-- Resumo por período. Reutiliza erp_home_summary(uuid) na mesma instrução (mesma data de referência)
-- e acrescenta o bloco "period", visível por perfil conforme a leitura de cada módulo.
create function public.erp_home_overview(p_user_id uuid,p_period text,p_from text default null,p_to text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
 v_base jsonb; v_role text; v_today date; v_from date; v_to date; v_grain text; v_from_text text; v_to_text text;
 v_sales jsonb:=null; v_receivable jsonb:=null; v_payable jsonb:=null; v_invoices jsonb:=null; v_points jsonb;
begin
 v_base:=public.erp_home_summary(p_user_id);
 v_role:=v_base->>'role'; v_today:=(v_base->>'business_date')::date;
 if p_period is null or p_period not in('hoje','30d','12m','customizado')
  or (p_period<>'customizado' and (p_from is not null or p_to is not null)) then
  raise exception 'erp_home_period_invalid' using errcode='22023';
 end if;
 if p_period='hoje' then v_from:=v_today; v_to:=v_today;
 elsif p_period='30d' then v_from:=v_today-29; v_to:=v_today;
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

revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
revoke all on function public.erp_home_overview(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.erp_home_shortcuts_get(uuid) from public,anon,authenticated;
revoke all on function public.erp_home_shortcuts_save(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.erp_home_overview(uuid,text,text,text) to service_role;
grant execute on function public.erp_home_shortcuts_get(uuid) to service_role;
grant execute on function public.erp_home_shortcuts_save(uuid,uuid,integer,jsonb) to service_role;
commit;
