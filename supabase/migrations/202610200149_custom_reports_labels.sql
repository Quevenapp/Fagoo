-- 149: Sistema > Relatórios customizados e Etiquetas customizadas no padrão do Origin.
-- * Relatórios: visões base seguras (Produtos, Clientes e Fornecedores, Contas a Receber, Contas a Pagar, Vendas, Pedidos
--   de Compra, Propostas e Ordens de Serviço), cada uma lida só por quem já lê o módulo (as mesmas regras de perfil de
--   cadastros, documentos e finanças). Um relatório customizado guarda Título, colunas em ordem, filtros por coluna,
--   Limite para visualização (até 2.000), "Exportar com totalizadores" e os Usuários que o veem; o administrador cria,
--   altera e exclui por comando idempotente com versão e auditoria. A execução devolve uma página de linhas e os totais de
--   todas as linhas do limite.
-- * Etiquetas: cinco modelos padrão (Produto, Contato, Nota Fiscal, Ordem de Serviço e Pedido de Venda) que só se clonam, e
--   modelos customizados com etiqueta, página e campos posicionados. Os registros para imprimir (produtos, contatos,
--   pedidos de venda e ordens de serviço) vêm de uma busca que respeita o perfil; a impressão é feita no navegador.
-- Nada aqui altera dados de outros módulos; só leitura deles e só por funções deste módulo.
begin;

create function erp_preferences.report_catalog() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select '[
 {"base":"produtos","group":"cadastros","title":"Produtos","default_columns":["codigo","descricao","unidade","preco","situacao"],"columns":[
  {"id":"codigo","label":"Código","type":"text"},{"id":"descricao","label":"Descrição","type":"text"},{"id":"unidade","label":"Unidade","type":"text"},{"id":"preco","label":"Preço","type":"decimal"},
  {"id":"tipo","label":"Tipo","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"gtin","label":"GTIN/EAN","type":"text"},{"id":"ncm","label":"NCM","type":"text"}]},
 {"base":"contatos","group":"cadastros","title":"Clientes e Fornecedores","default_columns":["nome","documento","cidade","uf","telefone","email"],"columns":[
  {"id":"nome","label":"Nome","type":"text"},{"id":"fantasia","label":"Fantasia","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"ie","label":"IE","type":"text"},
  {"id":"cidade","label":"Cidade","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"telefone","label":"Telefone","type":"text"},{"id":"celular","label":"Celular","type":"text"},
  {"id":"email","label":"E-mail","type":"text"},{"id":"tipos","label":"Tipo de contato","type":"text"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"contas_receber","group":"financas","title":"Contas a Receber","default_columns":["vencimento","contato","descricao","valor","saldo","situacao"],"columns":[
  {"id":"vencimento","label":"Vencimento","type":"date"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},
  {"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"contas_pagar","group":"financas","title":"Contas a Pagar","default_columns":["vencimento","contato","descricao","valor","saldo","situacao"],"columns":[
  {"id":"vencimento","label":"Vencimento","type":"date"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},
  {"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"vendas","group":"vendas","title":"Vendas","default_columns":["numero","data","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"propostas","group":"vendas","title":"Propostas Comerciais","default_columns":["numero","data","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"pedidos_compra","group":"suprimentos","title":"Pedidos de Compra","default_columns":["numero","data","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"ordens_servico","group":"servicos","title":"Ordens de Serviço","default_columns":["numero","data","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]}
 ]'::jsonb
$$;
create function erp_preferences.report_base(p_base text) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select b from jsonb_array_elements(erp_preferences.report_catalog()) b where b->>'base'=p_base
$$;
-- The module rule of each base (catalog, documents and finance read rules).
create function erp_preferences.report_allowed(p_role text,p_base text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(case p_base when 'produtos' then erp_catalog.allowed(p_role,'products',false) when 'contatos' then erp_catalog.allowed(p_role,'contacts',false)
  when 'contas_receber' then p_role in('admin','financeiro','consulta') when 'contas_pagar' then p_role in('admin','financeiro','consulta')
  when 'vendas' then erp_documents.allowed(p_role,'sales_orders',false) when 'propostas' then erp_documents.allowed(p_role,'sales_proposals',false)
  when 'pedidos_compra' then erp_documents.allowed(p_role,'purchase_orders',false) when 'ordens_servico' then erp_documents.allowed(p_role,'service_orders',false) else false end,false)
$$;
create function erp_preferences.report_clean(p text,p_max integer) returns text language sql immutable set search_path=pg_catalog as $$
 select nullif(btrim(left(regexp_replace(coalesce(p,''),'[[:cntrl:]]',' ','g'),p_max)),'')
$$;
create function erp_preferences.report_document_status(p_kind text,p_status text) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce('{"sales_proposals":{"draft":"Rascunho","open":"Em aberto","pending":"Pendente","waiting":"Aguardando","approved":"Aprovado","rejected":"Não aprovado","completed":"Concluído","cancelled":"Cancelado"}}'::jsonb#>>array[p_kind,p_status],
  case when p_kind in('sales_orders','purchase_orders','service_orders') then erp_preferences.situation_base_label(p_kind,p_status) end,p_status)
$$;
-- Every row of a base as {column: text}; sort_key keeps the Origin order of each listing.
create function erp_preferences.report_source(p_base text) returns table(sort_key text,data jsonb) language sql stable set search_path=pg_catalog as $$
 select lower(r.name)||' '||r.id,jsonb_build_object('codigo',erp_preferences.report_clean(r.code,100),'descricao',erp_preferences.report_clean(r.name,200),'unidade',erp_preferences.report_clean(p.unit,20),
  'preco',p.price::text,'tipo',case p.kind when 'S' then 'Serviço' when 'N' then 'Não especificado' when 'P' then 'Produto' end,'situacao',case when r.active then 'Ativo' else 'Inativo' end,
  'gtin',erp_preferences.report_clean(p.gtin,20),'ncm',erp_preferences.report_clean(p.ncm,10))
 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where p_base='produtos'
 union all
 select lower(r.name)||' '||r.id,jsonb_build_object('nome',erp_preferences.report_clean(r.name,200),'fantasia',erp_preferences.report_clean(c.trade_name,200),'documento',erp_preferences.report_clean(c.document,20),
  'ie',erp_preferences.report_clean(c.ie,20),'cidade',erp_preferences.report_clean(c.city,100),'uf',erp_preferences.report_clean(c.state,2),'telefone',erp_preferences.report_clean(c.phone,40),
  'celular',erp_preferences.report_clean(c.mobile,40),'email',erp_preferences.report_clean(c.email,200),
  'tipos',nullif(array_to_string(array(select case x when 'customer' then 'Cliente' when 'supplier' then 'Fornecedor' else 'Transportador' end from unnest(c.roles) x order by x),', '),''),
  'situacao',case when r.active then 'Ativo' else 'Inativo' end)
 from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where p_base='contatos'
 union all
 select to_char(t.due_on,'YYYYMMDD')||' '||lower(r.name)||' '||t.id,jsonb_build_object('vencimento',t.due_on::text,'emissao',t.issued_on::text,'contato',erp_preferences.report_clean(r.name,200),
  'descricao',erp_preferences.report_clean(t.description,200),'categoria',erp_preferences.report_clean(c.name,120),'parcela',t.installment||'/'||t.installments,
  'valor',round(t.amount_cents::numeric/100,2)::text,'saldo',round(case when t.cancelled then 0 else t.amount_cents-t.settled_cents end::numeric/100,2)::text,
  'situacao',case when t.cancelled then 'Cancelada' when t.settled_cents=t.amount_cents then case t.kind when 'receivable' then 'Recebida' else 'Paga' end
   when t.settled_cents>0 then 'Parcial' when t.due_on<(clock_timestamp() at time zone 'America/Sao_Paulo')::date then 'Atrasada' else 'Em aberto' end)
 from erp_finance.title t join erp_catalog.record r on r.id=t.contact_id left join erp_finance.category c on c.id=t.category_id
 where(p_base='contas_receber' and t.kind='receivable') or(p_base='contas_pagar' and t.kind='payable')
 union all
 select lpad(d.number::text,12,'0'),jsonb_build_object('numero',d.number::text,'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,
  'contato',erp_preferences.report_clean(d.contact_snapshot->>'name',200),'situacao',erp_preferences.report_document_status(d.kind,d.status),
  'vendedor',erp_preferences.report_clean(d.body#>>'{commercial,seller_reference,label}',80),'itens',(select count(*) from erp_documents.item i where i.document_id=d.id)::text,'total',d.total::text)
 from erp_documents.document d
 where d.kind=case p_base when 'vendas' then 'sales_orders' when 'propostas' then 'sales_proposals' when 'pedidos_compra' then 'purchase_orders' when 'ordens_servico' then 'service_orders' end
$$;
create function erp_preferences.report_like(p text) returns text language sql immutable set search_path=pg_catalog as $$
 select '%'||replace(replace(replace(lower(p),'\','\\'),'%','\%'),'_','\_')||'%'
$$;
-- Columns and filters of a definition: known columns of the base, 1..30 distinct; up to 10 filters {column, value}.
create function erp_preferences.report_check(p_base text,p_columns jsonb,p_filters jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare b jsonb:=erp_preferences.report_base(p_base);f jsonb;v_type text;
begin
 if b is null or jsonb_typeof(p_columns)<>'array' or jsonb_array_length(p_columns) not between 1 and 30 or jsonb_typeof(p_filters)<>'array' or jsonb_array_length(p_filters)>10
  or exists(select 1 from jsonb_array_elements(p_columns) c where jsonb_typeof(c)<>'string' or not exists(select 1 from jsonb_array_elements(b->'columns') k where k->>'id'=c#>>'{}'))
  or(select count(distinct c#>>'{}') from jsonb_array_elements(p_columns) c)<>jsonb_array_length(p_columns) then
  raise exception 'erp_preferences_report_definition_invalid' using errcode='22023'; end if;
 for f in select x from jsonb_array_elements(p_filters) x loop
  if not erp_preferences.framework_keys(f,array['column','value']) or jsonb_typeof(f->'column')<>'string' or jsonb_typeof(f->'value')<>'string' then
   raise exception 'erp_preferences_report_definition_invalid' using errcode='22023'; end if;
  select k->>'type' into v_type from jsonb_array_elements(b->'columns') k where k->>'id'=f->>'column';
  perform erp_preferences.framework_text(f->'value',100);
  if v_type is null or v_type in('money','decimal','int') and f->>'value'!~'^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$' then
   raise exception 'erp_preferences_report_definition_invalid' using errcode='22023'; end if;
 end loop;
end $$;
create table erp_preferences.report(
 id uuid primary key,
 base text not null check(base in('produtos','contatos','contas_receber','contas_pagar','vendas','propostas','pedidos_compra','ordens_servico')),
 title text not null check(char_length(title) between 1 and 80 and title=btrim(title) and title!~'[[:cntrl:]]'),
 columns jsonb not null check(jsonb_typeof(columns)='array'),
 filters jsonb not null check(jsonb_typeof(filters)='array'),
 view_limit integer not null check(view_limit between 1 and 2000),
 with_totals boolean not null,
 users uuid[] not null check(cardinality(users)<=100 and array_position(users,null) is null),
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id)
);
create unique index erp_preferences_report_title on erp_preferences.report(lower(title));
alter table erp_preferences.report enable row level security;
revoke all on erp_preferences.report from public,anon,authenticated,service_role;
create function erp_preferences.report_dto(r erp_preferences.report) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'base',r.base,'title',r.title,'columns',r.columns,'filters',r.filters,'view_limit',r.view_limit,'with_totals',r.with_totals,
  'users',to_jsonb(array(select u::text from unnest(r.users) u order by u)),'version',r.version,'updated_at',r.updated_at)
$$;

-- List: the standard reports (one per base the role reads) and the custom reports the user sees (administrador: all).
create function public.erp_preferences_reports(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 return jsonb_build_object('scope','reports','data_mode','erp_native','can_manage',v_role='admin',
  'bases',(select coalesce(jsonb_agg(b order by o),'[]'::jsonb) from jsonb_array_elements(erp_preferences.report_catalog()) with ordinality x(b,o) where erp_preferences.report_allowed(v_role,b->>'base')),
  'reports',(select coalesce(jsonb_agg(erp_preferences.report_dto(r) order by lower(r.title),r.id),'[]'::jsonb) from erp_preferences.report r
   where erp_preferences.report_allowed(v_role,r.base) and(v_role='admin' or p_user_id=any(r.users))),
  'directory',case when v_role='admin' then erp_preferences.directory() end);
end $$;
-- One page of a definition (preview while editing, a standard report or a saved one); the role must read the base.
create function public.erp_preferences_report_run(p_user_id uuid,p_base text,p_columns jsonb,p_filters jsonb,p_view_limit integer,p_offset integer,p_page integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;b jsonb;v_count bigint;v_rows jsonb;v_totals jsonb;f jsonb;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_base is null or not erp_preferences.report_allowed(v_role,p_base) then raise exception 'erp_preferences_report_access_denied' using errcode='42501'; end if;
 perform erp_preferences.report_check(p_base,p_columns,p_filters);
 if p_view_limit is null or p_view_limit not between 1 and 2000 or p_page is null or p_page not between 1 and 200 or p_offset is null or p_offset<0 or p_offset>=greatest(p_view_limit,1) then
  raise exception 'erp_preferences_report_page_invalid' using errcode='22023'; end if;
 b:=erp_preferences.report_base(p_base);
 with src as materialized(select row_number() over(order by s.sort_key)::integer n,s.data from erp_preferences.report_source(p_base) s
  where not exists(select 1 from jsonb_array_elements(p_filters) x join jsonb_array_elements(b->'columns') k on k->>'id'=x->>'column'
   where case when k->>'type' in('money','decimal','int') then coalesce((s.data->>(x->>'column'))::numeric<>(x->>'value')::numeric,true)
    else coalesce(lower(s.data->>(x->>'column')),'') not like erp_preferences.report_like(x->>'value') end))
 select(select count(*) from src),
  -- The page stops before 180 kB of rows (the screen asks for the next one from offset + rows).
  (select coalesce(jsonb_agg(w.line order by w.n),'[]'::jsonb) from(select v.n,v.line,sum(length(v.line::text)) over(order by v.n) acc from(
   select r.n,(select jsonb_agg(r.data->(c#>>'{}') order by o) from jsonb_array_elements(p_columns) with ordinality y(c,o)) line
   from src r where r.n>p_offset and r.n<=least(p_offset+p_page,p_view_limit)) v) w where w.acc<=180000),
  (select coalesce(jsonb_object_agg(c#>>'{}',(select coalesce(sum((r.data->>(c#>>'{}'))::numeric),0) from src r where r.n<=p_view_limit)::text),'{}'::jsonb)
   from jsonb_array_elements(p_columns) c join jsonb_array_elements(b->'columns') k on k->>'id'=c#>>'{}' where k->>'type' in('money','decimal'))
 into v_count,v_rows,v_totals;
 return jsonb_build_object('scope','report_rows','data_mode','erp_native','base',p_base,'columns',p_columns,'rows',v_rows,'offset',p_offset,
  'total_rows',least(v_count,p_view_limit),'truncated',v_count>p_view_limit,'totals',v_totals);
end $$;
create function public.erp_preferences_report_save(p_user_id uuid,p_command_id uuid,p_report uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_row erp_preferences.report;v_title text;v_users uuid[];v_at timestamptz:=clock_timestamp();v_id uuid;v_result jsonb;v_before jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or(p_report is null)<>(p_expected_version=0)
  or not erp_preferences.framework_keys(p_data,array['base','columns','filters','title','users','view_limit','with_totals']) or jsonb_typeof(p_data->'base')<>'string'
  or jsonb_typeof(p_data->'with_totals')<>'boolean' or erp_preferences.framework_version(p_data->'view_limit') is null or(p_data->>'view_limit')::integer>2000
  or jsonb_typeof(p_data->'users')<>'array' or jsonb_array_length(p_data->'users')>100
  or exists(select 1 from jsonb_array_elements(p_data->'users') u where jsonb_typeof(u)<>'string' or u#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_preferences_report_input_invalid' using errcode='22023'; end if;
 perform erp_preferences.report_check(p_data->>'base',p_data->'columns',p_data->'filters');
 v_title:=erp_preferences.framework_text(p_data->'title',80);
 v_users:=array(select distinct(u#>>'{}')::uuid from jsonb_array_elements(p_data->'users') u order by 1);
 if cardinality(v_users)<>jsonb_array_length(p_data->'users') then raise exception 'erp_preferences_report_users_invalid' using errcode='22023'; end if;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','report_save','actor',p_user_id,'id',p_report,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'reports',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_reports'),0);
 if exists(select 1 from erp_preferences.report r where lower(r.title)=lower(v_title) and r.id is distinct from p_report) then raise exception 'erp_preferences_report_title_taken' using errcode='23505'; end if;
 if p_report is null then
  if(select count(*) from erp_preferences.report)>=200 then raise exception 'erp_preferences_report_limit' using errcode='22023'; end if;
  v_id:=gen_random_uuid();
 else
  select * into v_row from erp_preferences.report r where r.id=p_report for update;
  if v_row.id is null then raise exception 'erp_preferences_report_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_preferences_report_version_conflict' using errcode='40001'; end if;
  if v_row.base<>p_data->>'base' then raise exception 'erp_preferences_report_base_fixed' using errcode='22023'; end if;
  v_id:=p_report;v_before:=erp_preferences.report_dto(v_row);
 end if;
 -- Usuários: a person added now must be an active member; one already marked who lost access may stay (or be removed), so
 -- editing the report never requires reactivating someone first.
 if exists(select 1 from unnest(v_users) u where not u=any(coalesce(v_row.users,'{}'::uuid[])) and not exists(select 1 from erp_access.membership m where m.user_id=u and m.active)) then
  raise exception 'erp_preferences_report_users_invalid' using errcode='22023'; end if;
 v_result:=jsonb_build_object('scope','reports_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case when p_report is null then 'report_create' else 'report_update' end,'target',v_id::text,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'reports',v_hash,v_result,v_at);
 if p_report is null then
  insert into erp_preferences.report(id,base,title,columns,filters,view_limit,with_totals,users,version,created_at,created_by,updated_at,updated_by,command_id)
   values(v_id,p_data->>'base',v_title,p_data->'columns',p_data->'filters',(p_data->>'view_limit')::integer,(p_data->>'with_totals')::boolean,v_users,1,v_at,p_user_id,v_at,p_user_id,p_command_id) returning * into v_row;
 else
  update erp_preferences.report set title=v_title,columns=p_data->'columns',filters=p_data->'filters',view_limit=(p_data->>'view_limit')::integer,with_totals=(p_data->>'with_totals')::boolean,
   users=v_users,version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where id=v_id returning * into v_row;
  if v_before-'version'-'updated_at'=erp_preferences.report_dto(v_row)-'version'-'updated_at' then raise exception 'erp_preferences_report_unchanged' using errcode='22023'; end if;
 end if;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'reports',v_result#>>'{receipt,action}',v_id::text,v_before,erp_preferences.report_dto(v_row));
 return v_result||jsonb_build_object('replayed',false);
end $$;

-- Etiquetas customizadas.
create function erp_preferences.label_fields(p_type text) returns text[] language sql immutable set search_path=pg_catalog as $$
 select case p_type when 'produto' then array['codigo','descricao','preco','unidade','gtin','ncm']
  when 'contato' then array['nome','fantasia','documento','endereco','bairro','cidade_uf','cep','telefone']
  when 'pedido_venda' then array['numero','data','cliente','endereco_cliente','cidade_uf','cep','total']
  when 'ordem_servico' then array['numero','data','cliente','total']
  when 'nota_fiscal' then array['numero','serie','cliente','endereco_cliente','cidade_uf','chave'] end
$$;
create function erp_preferences.label_mm(p jsonb,p_min numeric,p_max numeric) returns numeric language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p is null or jsonb_typeof(p)<>'string' or p#>>'{}'!~'^(0|[1-9][0-9]{0,2})(\.[0-9])?$' then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 if(p#>>'{}')::numeric not between p_min and p_max then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 return(p#>>'{}')::numeric;
end $$;
-- Etiqueta, Página and Campos of a model; numbers in millimeters as decimal strings (one decimal place).
create function erp_preferences.label_check(p_type text,p_config jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare l jsonb:=p_config->'label';g jsonb:=p_config->'page';f jsonb;v_width numeric;v_height numeric;v_fields text[]:=erp_preferences.label_fields(p_type);
begin
 if v_fields is null or not erp_preferences.framework_keys(p_config,array['fields','label','page'])
  or not erp_preferences.framework_keys(l,array['barcode','barcode_text','columns_gap','currency','font','font_size','height','rows_gap','show_labels','width'])
  or not erp_preferences.framework_keys(g,array['height','margin_left','margin_top','orientation','size','width'])
  or jsonb_typeof(l->'font')<>'string' or l->>'font' not in('helvetica','courier','monospace','times')
  or jsonb_typeof(l->'barcode')<>'string' or l->>'barcode' not in('c128','ean13','upca','msi')
  or jsonb_typeof(l->'barcode_text')<>'boolean' or jsonb_typeof(l->'currency')<>'boolean' or jsonb_typeof(l->'show_labels')<>'boolean'
  or jsonb_typeof(g->'size')<>'string' or g->>'size' not in('A2','A3','A4','A5','custom') or jsonb_typeof(g->'orientation')<>'string' or g->>'orientation' not in('portrait','landscape')
  or jsonb_typeof(p_config->'fields')<>'array' or jsonb_array_length(p_config->'fields') not between 1 and 20 then
  raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 v_width:=erp_preferences.label_mm(l->'width',5,300);v_height:=erp_preferences.label_mm(l->'height',5,300);
 perform erp_preferences.label_mm(l->'font_size',4,72),erp_preferences.label_mm(l->'columns_gap',0,100),erp_preferences.label_mm(l->'rows_gap',0,100),
  erp_preferences.label_mm(g->'margin_left',0,100),erp_preferences.label_mm(g->'margin_top',0,100);
 if g->>'size'='custom' then perform erp_preferences.label_mm(g->'width',20,999),erp_preferences.label_mm(g->'height',20,999);
 elsif jsonb_typeof(g->'width')<>'null' or jsonb_typeof(g->'height')<>'null' then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
 for f in select x from jsonb_array_elements(p_config->'fields') x loop
  if not erp_preferences.framework_keys(f,array['barcode','bold','field','size','x','y']) or jsonb_typeof(f->'field')<>'string' or not(f->>'field'=any(v_fields))
   or jsonb_typeof(f->'bold')<>'boolean' or jsonb_typeof(f->'barcode')<>'boolean' then raise exception 'erp_preferences_label_config_invalid' using errcode='22023'; end if;
  perform erp_preferences.label_mm(f->'x',0,v_width),erp_preferences.label_mm(f->'y',0,v_height),erp_preferences.label_mm(f->'size',4,72);
 end loop;
end $$;
create function erp_preferences.label_defaults() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select '[
 {"id":"padrao-contato","type":"contato","description":"Etiqueta de contato","config":{"label":{"width":"100","height":"40","font":"helvetica","font_size":"9","barcode":"c128","barcode_text":true,"currency":false,"show_labels":false,"columns_gap":"3","rows_gap":"0"},
  "page":{"size":"A4","width":null,"height":null,"orientation":"portrait","margin_left":"5","margin_top":"10"},
  "fields":[{"field":"nome","x":"4","y":"4","size":"10","bold":true,"barcode":false},{"field":"endereco","x":"4","y":"11","size":"9","bold":false,"barcode":false},{"field":"bairro","x":"4","y":"17","size":"9","bold":false,"barcode":false},
   {"field":"cidade_uf","x":"4","y":"23","size":"9","bold":false,"barcode":false},{"field":"cep","x":"4","y":"29","size":"9","bold":true,"barcode":false}]}},
 {"id":"padrao-produto","type":"produto","description":"Etiqueta de produto","config":{"label":{"width":"50","height":"30","font":"helvetica","font_size":"8","barcode":"ean13","barcode_text":true,"currency":true,"show_labels":false,"columns_gap":"2","rows_gap":"2"},
  "page":{"size":"A4","width":null,"height":null,"orientation":"portrait","margin_left":"5","margin_top":"10"},
  "fields":[{"field":"descricao","x":"2","y":"2","size":"8","bold":true,"barcode":false},{"field":"preco","x":"2","y":"8","size":"11","bold":true,"barcode":false},{"field":"gtin","x":"2","y":"14","size":"8","bold":false,"barcode":true}]}},
 {"id":"padrao-nota-fiscal","type":"nota_fiscal","description":"Etiqueta de nota fiscal","config":{"label":{"width":"100","height":"50","font":"helvetica","font_size":"9","barcode":"c128","barcode_text":true,"currency":false,"show_labels":true,"columns_gap":"3","rows_gap":"0"},
  "page":{"size":"A4","width":null,"height":null,"orientation":"portrait","margin_left":"5","margin_top":"10"},
  "fields":[{"field":"numero","x":"4","y":"4","size":"10","bold":true,"barcode":false},{"field":"serie","x":"60","y":"4","size":"10","bold":false,"barcode":false},{"field":"cliente","x":"4","y":"11","size":"9","bold":false,"barcode":false},
   {"field":"endereco_cliente","x":"4","y":"17","size":"9","bold":false,"barcode":false},{"field":"cidade_uf","x":"4","y":"23","size":"9","bold":false,"barcode":false},{"field":"chave","x":"4","y":"30","size":"7","bold":false,"barcode":true}]}},
 {"id":"padrao-ordem-servico","type":"ordem_servico","description":"Etiqueta de ordem de serviço","config":{"label":{"width":"100","height":"30","font":"helvetica","font_size":"9","barcode":"c128","barcode_text":true,"currency":true,"show_labels":true,"columns_gap":"3","rows_gap":"0"},
  "page":{"size":"A4","width":null,"height":null,"orientation":"portrait","margin_left":"5","margin_top":"10"},
  "fields":[{"field":"numero","x":"4","y":"4","size":"10","bold":true,"barcode":false},{"field":"data","x":"60","y":"4","size":"9","bold":false,"barcode":false},{"field":"cliente","x":"4","y":"12","size":"9","bold":false,"barcode":false},
   {"field":"total","x":"4","y":"20","size":"9","bold":true,"barcode":false}]}},
 {"id":"padrao-pedido-venda","type":"pedido_venda","description":"Etiqueta de pedido de venda","config":{"label":{"width":"100","height":"50","font":"helvetica","font_size":"9","barcode":"c128","barcode_text":true,"currency":true,"show_labels":false,"columns_gap":"3","rows_gap":"0"},
  "page":{"size":"A4","width":null,"height":null,"orientation":"portrait","margin_left":"5","margin_top":"10"},
  "fields":[{"field":"numero","x":"4","y":"4","size":"10","bold":true,"barcode":false},{"field":"cliente","x":"4","y":"11","size":"9","bold":false,"barcode":false},{"field":"endereco_cliente","x":"4","y":"17","size":"9","bold":false,"barcode":false},
   {"field":"cidade_uf","x":"4","y":"23","size":"9","bold":false,"barcode":false},{"field":"cep","x":"4","y":"29","size":"9","bold":true,"barcode":false},{"field":"numero","x":"4","y":"36","size":"8","bold":false,"barcode":true}]}}
 ]'::jsonb
$$;
create table erp_preferences.label_template(
 id uuid primary key,
 type text not null check(type in('contato','produto','nota_fiscal','ordem_servico','pedido_venda')),
 description text not null check(char_length(description) between 1 and 80 and description=btrim(description) and description!~'[[:cntrl:]]'),
 config jsonb not null check(jsonb_typeof(config)='object'),
 version integer not null check(version between 1 and 2147483647),
 created_at timestamptz not null,
 created_by uuid not null references auth.users(id),
 updated_at timestamptz not null,
 updated_by uuid not null references auth.users(id),
 command_id uuid not null references erp_preferences.framework_command(id)
);
create unique index erp_preferences_label_description on erp_preferences.label_template(type,lower(description));
alter table erp_preferences.label_template enable row level security;
revoke all on erp_preferences.label_template from public,anon,authenticated,service_role;
create function erp_preferences.label_dto(t erp_preferences.label_template) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',t.id::text,'type',t.type,'description',t.description,'default',false,'config',t.config,'version',t.version,'updated_at',t.updated_at)
$$;
-- Padrões (fixed, version 0) and Customizadas. Every active member prints labels of what the role reads; only the
-- administrador manages the models.
create function public.erp_preferences_labels(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if v_role<>'admin' then raise exception 'erp_preferences_labels_access_denied' using errcode='42501'; end if;
 return jsonb_build_object('scope','labels','data_mode','erp_native',
  'items',(select jsonb_agg(d||jsonb_build_object('default',true,'version',0,'updated_at',null) order by o) from jsonb_array_elements(erp_preferences.label_defaults()) with ordinality x(d,o))
   ||(select coalesce(jsonb_agg(erp_preferences.label_dto(t) order by lower(t.description),t.id),'[]'::jsonb) from erp_preferences.label_template t));
end $$;
create function public.erp_preferences_label_save(p_user_id uuid,p_command_id uuid,p_label uuid,p_expected_version integer,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_row erp_preferences.label_template;v_description text;v_at timestamptz:=clock_timestamp();v_id uuid;v_result jsonb;v_before jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_version not between 0 and 2147483646 or(p_label is null)<>(p_expected_version=0)
  or not erp_preferences.framework_keys(p_data,array['config','description','type']) or jsonb_typeof(p_data->'type')<>'string' then
  raise exception 'erp_preferences_label_input_invalid' using errcode='22023'; end if;
 perform erp_preferences.label_check(p_data->>'type',p_data->'config');v_description:=erp_preferences.framework_text(p_data->'description',80);
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','label_save','actor',p_user_id,'id',p_label,'version',p_expected_version,'data',p_data));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,'labels',v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_labels'),0);
 if exists(select 1 from erp_preferences.label_template t where t.type=p_data->>'type' and lower(t.description)=lower(v_description) and t.id is distinct from p_label)
  or exists(select 1 from jsonb_array_elements(erp_preferences.label_defaults()) d where d->>'type'=p_data->>'type' and lower(d->>'description')=lower(v_description)) then
  raise exception 'erp_preferences_label_description_taken' using errcode='23505'; end if;
 if p_label is null then
  if(select count(*) from erp_preferences.label_template)>=100 then raise exception 'erp_preferences_label_limit' using errcode='22023'; end if;
  v_id:=gen_random_uuid();
 else
  select * into v_row from erp_preferences.label_template t where t.id=p_label for update;
  if v_row.id is null then raise exception 'erp_preferences_label_not_found' using errcode='P0002'; end if;
  if v_row.version<>p_expected_version then raise exception 'erp_preferences_label_version_conflict' using errcode='40001'; end if;
  if v_row.type<>p_data->>'type' then raise exception 'erp_preferences_label_type_fixed' using errcode='22023'; end if;
  if v_row.description=v_description and v_row.config=p_data->'config' then raise exception 'erp_preferences_label_unchanged' using errcode='22023'; end if;
  v_id:=p_label;v_before:=erp_preferences.label_dto(v_row);
 end if;
 v_result:=jsonb_build_object('scope','labels_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case when p_label is null then 'label_create' else 'label_update' end,'target',v_id::text,'count',1,'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,'labels',v_hash,v_result,v_at);
 if p_label is null then
  insert into erp_preferences.label_template(id,type,description,config,version,created_at,created_by,updated_at,updated_by,command_id)
   values(v_id,p_data->>'type',v_description,p_data->'config',1,v_at,p_user_id,v_at,p_user_id,p_command_id) returning * into v_row;
 else
  update erp_preferences.label_template set description=v_description,config=p_data->'config',version=version+1,updated_at=v_at,updated_by=p_user_id,command_id=p_command_id where id=v_id returning * into v_row;
 end if;
 insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
  values(v_at,p_user_id,p_command_id,'labels',v_result#>>'{receipt,action}',v_id::text,v_before,erp_preferences.label_dto(v_row));
 return v_result||jsonb_build_object('replayed',false);
end $$;
-- "Excluir" of custom reports or custom label models: all or nothing, each by version.
create function public.erp_preferences_framework_delete(p_user_id uuid,p_command_id uuid,p_target text,p_items jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_replay jsonb;v_at timestamptz:=clock_timestamp();v_result jsonb;i jsonb;v_report erp_preferences.report;v_label erp_preferences.label_template;v_area text;
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null or p_target is null or p_target not in('reports','labels') or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
  or exists(select 1 from jsonb_array_elements(p_items) x where not erp_preferences.framework_keys(x,array['expected_version','id']) or jsonb_typeof(x->'id')<>'string'
   or x->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or erp_preferences.framework_version(x->'expected_version') is null)
  or(select count(distinct x->>'id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then
  raise exception 'erp_preferences_framework_input_invalid' using errcode='22023'; end if;
 v_area:=p_target;
 v_hash:=erp_preferences.framework_hash(jsonb_build_object('op','framework_delete','actor',p_user_id,'target',p_target,'items',p_items));
 v_replay:=erp_preferences.framework_replay(p_command_id,p_user_id,v_area,v_hash);if v_replay is not null then return v_replay; end if;
 perform pg_advisory_xact_lock(hashtext('erp_preferences_'||p_target),0);
 v_result:=jsonb_build_object('scope',p_target||'_command','data_mode','erp_native','receipt',jsonb_build_object('command_id',p_command_id,
  'action',case p_target when 'reports' then 'reports_delete' else 'labels_delete' end,'target',null,'count',jsonb_array_length(p_items),'changed_at',v_at));
 insert into erp_preferences.framework_command(id,actor,area,request_hash,result,created_at) values(p_command_id,p_user_id,v_area,v_hash,v_result,v_at);
 for i in select x from jsonb_array_elements(p_items) x order by x->>'id' loop
  if p_target='reports' then
   select * into v_report from erp_preferences.report r where r.id=(i->>'id')::uuid for update;
   if v_report.id is null then raise exception 'erp_preferences_report_not_found' using errcode='P0002'; end if;
   if v_report.version<>(i->>'expected_version')::integer then raise exception 'erp_preferences_report_version_conflict' using errcode='40001'; end if;
   delete from erp_preferences.report r where r.id=v_report.id;
   insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
    values(v_at,p_user_id,p_command_id,'reports','report_delete',v_report.id::text,erp_preferences.report_dto(v_report),null);
  else
   select * into v_label from erp_preferences.label_template t where t.id=(i->>'id')::uuid for update;
   if v_label.id is null then raise exception 'erp_preferences_label_not_found' using errcode='P0002'; end if;
   if v_label.version<>(i->>'expected_version')::integer then raise exception 'erp_preferences_label_version_conflict' using errcode='40001'; end if;
   delete from erp_preferences.label_template t where t.id=v_label.id;
   insert into erp_preferences.framework_audit(created_at,actor,command_id,area,action,target,before_data,after_data)
    values(v_at,p_user_id,p_command_id,'labels','label_delete',v_label.id::text,erp_preferences.label_dto(v_label),null);
  end if;
 end loop;
 return v_result||jsonb_build_object('replayed',false);
end $$;
-- Records to print (up to 100 by search), only of what the role reads; the values are the label fields of the type.
create function public.erp_preferences_label_records(p_user_id uuid,p_type text,p_query text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_like text;v_kind text;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_type is null or p_type not in('produto','contato','pedido_venda','ordem_servico') then raise exception 'erp_preferences_label_type_invalid' using errcode='22023'; end if;
 v_kind:=case p_type when 'pedido_venda' then 'sales_orders' when 'ordem_servico' then 'service_orders' end;
 if not(case p_type when 'produto' then erp_catalog.allowed(v_role,'products',false) when 'contato' then erp_catalog.allowed(v_role,'contacts',false) else erp_documents.allowed(v_role,v_kind,false) end) then
  raise exception 'erp_preferences_label_access_denied' using errcode='42501'; end if;
 v_like:=erp_preferences.tag_query(p_query);
 return jsonb_build_object('scope','label_records','data_mode','erp_native','type',p_type,'items',coalesce((select jsonb_agg(x.item order by x.sort) from(
  select lower(r.name)||r.id sort,jsonb_build_object('id',r.id,'values',jsonb_build_object('codigo',erp_preferences.report_clean(r.code,100),'descricao',erp_preferences.report_clean(r.name,200),
   'preco',p.price::text,'unidade',erp_preferences.report_clean(p.unit,20),'gtin',erp_preferences.report_clean(p.gtin,20),'ncm',erp_preferences.report_clean(p.ncm,10))) item
  from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where p_type='produto' and r.active and(v_like is null or lower(r.name) like v_like or lower(coalesce(r.code,'')) like v_like)
  union all
  select lower(r.name)||r.id,jsonb_build_object('id',r.id,'values',jsonb_build_object('nome',erp_preferences.report_clean(r.name,200),'fantasia',erp_preferences.report_clean(c.trade_name,200),
   'documento',erp_preferences.report_clean(c.document,20),'endereco',erp_preferences.report_clean(concat_ws(', ',c.street,c.number)||coalesce(' - '||nullif(btrim(c.complement),''),''),200),
   'bairro',erp_preferences.report_clean(c.district,100),'cidade_uf',erp_preferences.report_clean(concat_ws('/',c.city,c.state),110),'cep',erp_preferences.report_clean(c.postal_code,9),'telefone',erp_preferences.report_clean(c.phone,40)))
  from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id where p_type='contato' and r.active and(v_like is null or lower(r.name) like v_like)
  union all
  select lpad(d.number::text,12,'0'),jsonb_build_object('id',d.id,'values',jsonb_build_object('numero',d.number::text,'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,
   'cliente',erp_preferences.report_clean(d.contact_snapshot->>'name',200),
   'endereco_cliente',erp_preferences.report_clean(concat_ws(', ',d.contact_snapshot->>'street',d.contact_snapshot->>'number'),200),
   'cidade_uf',erp_preferences.report_clean(concat_ws('/',d.contact_snapshot->>'city',d.contact_snapshot->>'state'),110),'cep',erp_preferences.report_clean(d.contact_snapshot->>'postal_code',9),'total',d.total::text)
   -(case when p_type='ordem_servico' then array['endereco_cliente','cidade_uf','cep'] else array[]::text[] end))
  from erp_documents.document d where d.kind=v_kind and(v_like is null or d.number::text like v_like or lower(coalesce(d.contact_snapshot->>'name','')) like v_like)
  order by 1 limit 100) x),'[]'::jsonb));
end $$;

revoke all on all functions in schema erp_preferences from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_preferences_reports','erp_preferences_report_run','erp_preferences_report_save','erp_preferences_labels','erp_preferences_label_save','erp_preferences_framework_delete','erp_preferences_label_records')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
