-- 264: Relatórios customizados com mais visões do Origin, permissões de Sistema › Usuários que passam a valer nas telas desta frente
-- e o formato "só dígitos" das preferências.
-- * Relatórios customizados: visões base Recebimentos e Pagamentos (cada baixa, com juros, multa, desconto, tarifa, valor líquido e a
--   situação Estornado), Venda Parcela (as parcelas dos pedidos de venda), Comissões (as comissões dos vendedores, liberadas,
--   pendentes ou anuladas) e Caixa (os lançamentos de Caixas e bancos). Só leitura, sobre as tabelas das outras frentes, lidas por
--   quem lê cada módulo (finanças: administrador, financeiro e consulta; Venda Parcela: quem lê pedidos de venda).
-- * Permissões (Sistema › Usuários › Permissões; o administrador sempre tem todas, e um usuário sem permissões gravadas tem tudo o
--   que o perfil permite): "Relatórios customizados" abre a tela e cada visão base exige também a permissão do módulo que ela lê
--   (Produtos, Clientes e Fornecedores, Contas a Receber/Pagar, Pedidos de Venda, Propostas, Pedidos de Compra, Ordem de Serviço,
--   Notas Fiscais, Notas de Entrada, NFC-e, Comissões e Caixas e bancos); "Espaço Meu Contador" abre Preferências › Contabilidade e
--   "Central de notificações" a página de notificações; "Acesso aos dados da empresa" abre Empresa › Dados da empresa (a identidade
--   continua lida pelas impressões, que precisam dela).
-- * Preferências de texto com o formato "digits": só dígitos, de min_length até max_length (vazio = não informado). O "Prefixo GS1 da
--   empresa (Sequencial EAN)" (produtos.ean_prefixo, 191) passa a aceitar só de 7 a 11 dígitos na tela, na API e no banco; a
--   migração para se o valor gravado não seguir essa regra (corrija-o antes, na tela de Configurações de produtos).
-- Substitui erp_preferences.value_valid e page_dto (115), report_catalog, report_allowed e report_source (230),
-- erp_preferences_reports e erp_preferences_report_run (149), erp_company_access (016) e erp_company_extra_get (151), conferidas pelo
-- hash; qualquer outra versão interrompe a migração.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_preferences.value_valid(erp_preferences.definition,jsonb)','42ade86128c9af9cf27db5b8058fe01924b493725c1e7401557c38eb9d8f5a31'),
  ('erp_preferences.page_dto(erp_preferences.page,text,uuid)','56814b670a521c5d3aee69052edeb6be26a54794c8ef8ef67b817b02bca945ea'),
  ('erp_preferences.report_catalog()','070eca4f8b5a252ec12c7e59f2a8d51d16b6ad5c47c66cd20cf1c2a578dcb8d2'),
  ('erp_preferences.report_allowed(text,text)','fd61cf033c05ee2dc0004c8de77d356eabc9d80ede8fc0b8eaf67e3096d3c762'),
  ('erp_preferences.report_source(text)','6e535df330c466a079aeb2692fd13fc7a2efa78c2d185b2c0d9bc0982b295a4a'),
  ('public.erp_preferences_reports(uuid)','162106061bd231f54a8a246ca6c05931d2574fc77317589efb61ecfe362b2a74'),
  ('public.erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)','0a85ba570ffa32e9c12ecc95d1950d5ca8126ba59cb9bc17fd08e86999023bc2'),
  ('public.erp_company_access(uuid)','410d7d58ff88f0df078248db9404f6435f2b878f8b3edc3e915342015277d919'),
  ('public.erp_company_extra_get(uuid)','005a2ceed560d90987e887ddec0a2ceb39ddfc059a31562f131decb77bf5e697')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'preferences_264_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
 if to_regprocedure('erp_access.permitted(uuid,text)') is null or to_regprocedure('erp_finance.commission_rows(uuid)') is null
  or to_regprocedure('erp_finance.statement_lines(uuid,date,date,boolean)') is null then
  raise exception 'preferences_264_requires_136_171_229' using errcode='55000';end if;
 if not exists(select 1 from erp_preferences.definition where key='produtos.ean_prefixo' and kind='text' and format='plain' and max_length=11) then
  raise exception 'preferences_264_ean_prefix_definition_changed' using errcode='55000';end if;
 -- The stored Prefixo GS1 must already follow the new rule (empty, or 7 to 11 digits).
 if exists(select 1 from erp_preferences.company_value where key='produtos.ean_prefixo' and not(jsonb_typeof(value)='string' and(value#>>'{}'='' or value#>>'{}'~'^[0-9]{7,11}$'))) then
  raise exception 'preferences_264_ean_prefix_invalid' using errcode='55000',hint='Corrija o Prefixo GS1 em Preferências › Cadastros › Configurações de produtos (7 a 11 dígitos) e aplique de novo.';end if;
end$$;

-- ---- Formato "digits" das preferências de texto ----
alter table erp_preferences.definition drop constraint definition_format_check;
alter table erp_preferences.definition add constraint definition_format_check check(format in('plain','email','email_list','digits'));
alter table erp_preferences.definition add column min_length integer;
alter table erp_preferences.definition add constraint definition_min_length_check check(min_length is null or(format='digits' and min_length between 1 and max_length));

-- ---- Permissão de cada página de preferências (null: só o perfil) ----
create function erp_preferences.page_permission(p_page text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_page when 'contabilidade-contador' then 'contabilidade.meu_contador' when 'central-notificacoes' then 'preferencias.central_notificacoes' end
$$;

-- ---- Relatórios customizados: valores, permissão de cada visão base ----
create function erp_preferences.report_cents(p bigint) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p is null then null else round(p::numeric/100,2)::numeric(17,2)::text end
$$;
-- The module permission each base reads (Sistema › Usuários › Permissões).
create function erp_preferences.report_permission(p_base text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_base when 'produtos' then 'cadastros.produtos' when 'contatos' then 'cadastros.clientes_fornecedores' when 'contas_receber' then 'financas.contas_receber'
  when 'contas_pagar' then 'financas.contas_pagar' when 'vendas' then 'vendas.pedidos_venda' when 'propostas' then 'vendas.propostas' when 'pedidos_compra' then 'suprimentos.pedidos_compra'
  when 'ordens_servico' then 'servicos.ordem_servico' when 'notas_saida' then 'vendas.notas_fiscais' when 'notas_entrada' then 'suprimentos.notas_entrada' when 'nfce' then 'vendas.nfce'
  when 'recebimentos' then 'financas.contas_receber' when 'pagamentos' then 'financas.contas_pagar' when 'venda_parcela' then 'vendas.pedidos_venda'
  when 'comissoes' then 'vendas.comissoes' when 'caixa' then 'financas.caixas_bancos' end
$$;
-- A base the user sees: the role reads its module, and the user has "Relatórios customizados" and the module permission.
create function erp_preferences.report_visible(p_user uuid,p_role text,p_base text) returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_preferences.report_allowed(p_role,p_base) and erp_access.permitted(p_user,'outros.relatorios_customizados')
  and coalesce(erp_access.permitted(p_user,erp_preferences.report_permission(p_base)),false)
$$;


create or replace function erp_preferences.value_valid(d erp_preferences.definition,v jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb; s text; t text; seen text[]:='{}'; prev text;
begin
 if d.key is null or v is null then return false; end if;
 case d.kind
 when 'toggle' then return jsonb_typeof(v)='boolean';
 when 'choice' then return jsonb_typeof(v)='string' and d.options?(v#>>'{}');
 when 'multi' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
  if exists(select 1 from jsonb_array_elements(v) x where jsonb_typeof(x)<>'string' or not d.options?(x#>>'{}')) then return false; end if;
  -- Distinct and in option order, so one choice has one representation.
  return not exists(select 1 from(select o.i,lag(o.i)over(order by x.n) as before_i from jsonb_array_elements_text(v) with ordinality x(val,n)
   join jsonb_array_elements_text(d.options) with ordinality o(opt,i) on o.opt=x.val) q where q.before_i is not null and q.i<=q.before_i);
 when 'integer' then
  if jsonb_typeof(v)<>'number' or v::text!~'^-?(0|[1-9][0-9]{0,8})$' then return false; end if;
  return v::text::integer between d.min_value and d.max_value;
 when 'decimal' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  if s!~('^(0|[1-9][0-9]{0,8})(\.[0-9]{1,'||d.scale||'})?$') then return false; end if;
  return s::numeric between d.min_value and d.max_value;
 when 'text' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  if length(s)>d.max_length or s~'[\x01-\x1f\x7f]' or s~'^ | $' then return false; end if;
  if s='' or d.format='plain' then return true; end if;
  if d.format='email' then return s~'^[^@ ]+@[^@ ]+\.[^@ ]+$'; end if;
  -- 264: only digits, from min_length (or 1) to max_length.
  if d.format='digits' then return s~'^[0-9]+$' and length(s) between coalesce(d.min_length,1) and d.max_length; end if;
  return cardinality(regexp_split_to_array(s,','))<=d.max_items
   and not exists(select 1 from unnest(regexp_split_to_array(s,',')) p where btrim(p,' ')!~'^[^@ ]+@[^@ ]+\.[^@ ]+$');
 when 'textarea' then
  if jsonb_typeof(v)<>'string' then return false; end if; s:=v#>>'{}';
  return length(s)<=d.max_length and s!~'[\x01-\x09\x0b-\x1f\x7f]' and s!~'^[ \n]|[ \n]$';
 when 'users' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
  for e in select x from jsonb_array_elements(v) x loop
   if jsonb_typeof(e)<>'string' or e#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (prev is not null and (e#>>'{}') collate "C"<=prev collate "C") then return false; end if;
   prev:=e#>>'{}';
  end loop;
  return true;
 when 'keymap' then
  if jsonb_typeof(v)<>'object' or (select count(*) from jsonb_object_keys(v))<>jsonb_array_length(d.options->'actions') then return false; end if;
  if exists(select 1 from jsonb_array_elements_text(d.options->'actions') a where not v?a or jsonb_typeof(v->a)<>'string' or not(d.options->'keys')?(v->>a)) then return false; end if;
  return(select count(distinct v->>a) from jsonb_array_elements_text(d.options->'actions') a)=jsonb_array_length(d.options->'actions');
 when 'documents' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>d.max_items then return false; end if;
  for e in select x from jsonb_array_elements(v) x loop
   if jsonb_typeof(e)<>'object' or(select count(*) from jsonb_object_keys(e))<>2 or not(e?'document' and e?'name')
    or jsonb_typeof(e->'document')<>'string' or jsonb_typeof(e->'name')<>'string' then return false; end if;
   s:=e->>'document';t:=e->>'name';
   if not(erp_catalog.valid_cpf(s) or erp_catalog.valid_cnpj(s)) or s=any(seen) then return false; end if;
   if length(t)>80 or t~'[\x01-\x1f\x7f]' or t~'^ | $' then return false; end if;
   seen:=seen||s;
  end loop;
  return true;
 else return false;
 end case;
end $$;

create or replace function erp_preferences.page_dto(p_page erp_preferences.page,p_role text,p_user uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare v_key text:=erp_preferences.page_permission(p_page.id);
begin
 -- 264: Espaço Meu Contador and Central de Notificações follow the permission of the user (the administrador always has it).
 if v_key is not null and not erp_access.permitted(p_user,v_key) then raise exception 'erp_preferences_permission_denied' using errcode='42501'; end if;
 return(select jsonb_build_object('scope','preferences_page','data_mode','erp_native','page',p_page.id,'owner',p_page.scope,'role',p_role,
  'can_manage',p_page.scope='user' or p_role='admin',
  'items',(select coalesce(jsonb_agg(jsonb_build_object('key',d.key,'value',coalesce(v.value,d.default_value),'version',coalesce(v.version,0),'updated_at',v.updated_at) order by d.ordinal),'[]'::jsonb)
   from erp_preferences.definition d
   left join lateral(select c.value,c.version,c.updated_at from erp_preferences.company_value c where p_page.scope='company' and c.key=d.key
    union all select u.value,u.version,u.updated_at from erp_preferences.user_value u where p_page.scope='user' and u.key=d.key and u.user_id=p_user) v on true
   where d.page_id=p_page.id),
  'directory',case when(p_page.scope='user' or p_role='admin')and exists(select 1 from erp_preferences.definition d where d.page_id=p_page.id and d.kind='users')
   then erp_preferences.directory() end));
end $$;

create or replace function erp_preferences.report_catalog() returns jsonb language sql immutable set search_path=pg_catalog as $$
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
  {"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"notas_saida","group":"vendas","title":"NF-e de saída","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},
  {"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"notas_entrada","group":"suprimentos","title":"NF-e de entrada","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},
  {"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"nfce","group":"vendas","title":"NFC-e","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[
  {"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},
  {"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"recebimentos","group":"financas","title":"Recebimentos","default_columns":["data","contato","descricao","valor","conta"],"columns":[
  {"id":"data","label":"Data do recebimento","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},
  {"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"valor","label":"Valor recebido","type":"money"},
  {"id":"juros","label":"Juros","type":"money"},{"id":"multa","label":"Multa","type":"money"},{"id":"desconto","label":"Desconto","type":"money"},{"id":"tarifa","label":"Tarifa","type":"money"},
  {"id":"liquido","label":"Valor líquido","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"pagamentos","group":"financas","title":"Pagamentos","default_columns":["data","contato","descricao","valor","conta"],"columns":[
  {"id":"data","label":"Data do pagamento","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},
  {"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"valor","label":"Valor pago","type":"money"},
  {"id":"juros","label":"Juros","type":"money"},{"id":"multa","label":"Multa","type":"money"},{"id":"desconto","label":"Desconto","type":"money"},{"id":"tarifa","label":"Tarifa","type":"money"},
  {"id":"liquido","label":"Valor líquido","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"venda_parcela","group":"vendas","title":"Venda Parcela","default_columns":["numero","data","contato","parcela","vencimento","valor"],"columns":[
  {"id":"numero","label":"Número da venda","type":"int"},{"id":"data","label":"Data da venda","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},
  {"id":"parcela","label":"Parcela","type":"text"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"valor","label":"Valor da parcela","type":"money"},{"id":"forma","label":"Forma de pagamento","type":"text"},
  {"id":"observacao","label":"Observação","type":"text"}]},
 {"base":"comissoes","group":"financas","title":"Comissões","default_columns":["vendedor","pedido","base","aliquota","comissao","situacao"],"columns":[
  {"id":"vendedor","label":"Vendedor","type":"text"},{"id":"origem","label":"Origem","type":"text"},{"id":"pedido","label":"Número do pedido","type":"int"},{"id":"descricao","label":"Descrição","type":"text"},
  {"id":"parcela","label":"Valor da parcela","type":"money"},{"id":"base","label":"Base de cálculo","type":"money"},{"id":"aliquota","label":"Alíquota (%)","type":"decimal"},{"id":"comissao","label":"Comissão","type":"money"},
  {"id":"vencimento","label":"Vencimento","type":"date"},{"id":"liberada","label":"Liberada em","type":"date"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"caixa","group":"financas","title":"Caixa","default_columns":["data","conta","descricao","entrada","saida"],"columns":[
  {"id":"data","label":"Data","type":"date"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"contato","label":"Contato","type":"text"},
  {"id":"categoria","label":"Categoria","type":"text"},{"id":"tipo","label":"Tipo","type":"text"},{"id":"entrada","label":"Entrada","type":"money"},{"id":"saida","label":"Saída","type":"money"}]}
 ]'::jsonb
$$;

create or replace function erp_preferences.report_allowed(p_role text,p_base text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(case p_base when 'produtos' then erp_catalog.allowed(p_role,'products',false) when 'contatos' then erp_catalog.allowed(p_role,'contacts',false)
  when 'contas_receber' then p_role in('admin','financeiro','consulta') when 'contas_pagar' then p_role in('admin','financeiro','consulta')
  when 'vendas' then erp_documents.allowed(p_role,'sales_orders',false) when 'propostas' then erp_documents.allowed(p_role,'sales_proposals',false)
  when 'pedidos_compra' then erp_documents.allowed(p_role,'purchase_orders',false) when 'ordens_servico' then erp_documents.allowed(p_role,'service_orders',false)
  -- 230: the notes as the notas lane reads them (erp_fiscal_invoices.require_read).
  when 'notas_saida' then p_role in('admin','consulta','fiscal') when 'notas_entrada' then p_role in('admin','consulta','fiscal') when 'nfce' then p_role in('admin','consulta','fiscal')
  -- 264: baixas, comissões and the extrato of Caixas e bancos as the finance lane reads them; the parcelas of the sales orders.
  when 'recebimentos' then p_role in('admin','financeiro','consulta') when 'pagamentos' then p_role in('admin','financeiro','consulta')
  when 'comissoes' then p_role in('admin','financeiro','consulta') when 'caixa' then p_role in('admin','financeiro','consulta')
  when 'venda_parcela' then erp_documents.allowed(p_role,'sales_orders',false)
  else false end,false)
$$;

-- 264: one query per base (plpgsql), so a report reads only the tables of its own base.
create or replace function erp_preferences.report_source(p_base text) returns table(sort_key text,data jsonb) language plpgsql stable set search_path=pg_catalog as $$
#variable_conflict use_column
begin
 if p_base in('produtos','contatos','contas_receber','contas_pagar','vendas','propostas','pedidos_compra','ordens_servico','notas_saida','notas_entrada','nfce') then
  return query
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
 union all
 -- 230: Brufap's own notes, newest issue first as in the notas lists; a draft has no number yet.
 select to_char(date '2100-12-31'-i.issue_date,'FM000000')||lpad(coalesce(999999999-i.number,999999999)::text,9,'0')||i.id,
  jsonb_strip_nulls(jsonb_build_object('numero',i.number::text,'serie',i.series::text,'emissao',i.issue_date::text,'contato',erp_preferences.report_clean(i.recipient->>'name',200),
   'documento',erp_preferences.report_clean(i.recipient->>'document',20),'natureza',erp_preferences.report_clean(i.nature_description,60),'situacao',erp_preferences.report_invoice_status(i.status),
   'total',case when(i.totals->>'total')~'^-?[0-9]{1,15}(\.[0-9]+)?$' then round((i.totals->>'total')::numeric,2)::numeric(17,2)::text end,'chave',i.access_key))
  ||case when p_base<>'nfce' then jsonb_strip_nulls(jsonb_build_object('uf',erp_preferences.report_clean(i.recipient->>'state',2))) else '{}'::jsonb end
 from erp_fiscal_invoices.invoice i
 where i.deleted_at is null and((p_base='notas_saida' and i.model='55' and i.direction='1') or(p_base='notas_entrada' and i.model='55' and i.direction='0') or(p_base='nfce' and i.model='65'));
 elsif p_base in('recebimentos','pagamentos') then
  -- Each baixa (Recebimentos / Pagamentos), oldest first; an estornada baixa stays with the situação Estornado.
  return query select to_char(s.posted_on,'YYYYMMDD')||' '||to_char(s.created_at,'YYYYMMDDHH24MISSUS')||' '||s.id,jsonb_build_object('data',s.posted_on::text,'vencimento',t.due_on::text,
   'contato',erp_preferences.report_clean(r.name,200),'descricao',erp_preferences.report_clean(t.description,200),'categoria',erp_preferences.report_clean(c.name,120),
   'parcela',t.installment||'/'||t.installments,'conta',erp_preferences.report_clean(a.name,200),
   'valor',erp_preferences.report_cents(s.principal_cents+s.interest_cents+s.penalty_cents-s.discount_cents),'juros',erp_preferences.report_cents(s.interest_cents),
   'multa',erp_preferences.report_cents(s.penalty_cents),'desconto',erp_preferences.report_cents(s.discount_cents),'tarifa',erp_preferences.report_cents(s.fee_cents),
   'liquido',erp_preferences.report_cents(s.net_cash_cents),
   'situacao',case when exists(select 1 from erp_finance.settlement x where x.reverses_id=s.id) then 'Estornado' when t.kind='receivable' then 'Recebido' else 'Pago' end)
  from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id left join erp_catalog.record r on r.id=t.contact_id
   left join erp_finance.category c on c.id=t.category_id left join erp_finance.account a on a.id=s.account_id
  where s.kind='payment' and t.kind=case p_base when 'recebimentos' then 'receivable' else 'payable' end;
 elsif p_base='venda_parcela' then
  -- Venda Parcela: each parcela of the sales orders (Condições de pagamento), in the order of the venda.
  return query select lpad(d.number::text,12,'0')||lpad(i.n::text,4,'0'),jsonb_build_object('numero',d.number::text,
   'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,'contato',erp_preferences.report_clean(d.contact_snapshot->>'name',200),
   'situacao',erp_preferences.report_document_status(d.kind,d.status),'parcela',i.n||'/'||jsonb_array_length(d.body->'installments'),
   'vencimento',case when(i.p->>'due_date')~'^\d{4}-\d{2}-\d{2}$' then i.p->>'due_date' end,
   'valor',case when(i.p->>'amount')~'^[0-9]{1,15}(\.[0-9]{1,6})?$' then round((i.p->>'amount')::numeric,2)::numeric(17,2)::text end,
   'forma',erp_preferences.report_clean(coalesce((select m.description from erp_catalog.payment_method m where m.id::text=i.p->>'payment_method_id'),i.p->>'method'),120),
   'observacao',erp_preferences.report_clean(i.p->>'note',200))
  from erp_documents.document d cross join lateral jsonb_array_elements(case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]'::jsonb end) with ordinality i(p,n)
  where d.kind='sales_orders';
 elsif p_base='comissoes' then
  -- Comissões of the vendedores as the finance lane computes them (liberada, pendente or anulada), excluded ones never.
  return query select lower(coalesce(sr.name,''))||' '||to_char(x.due_on,'YYYYMMDD')||' '||x.id,jsonb_build_object('vendedor',erp_preferences.report_clean(sr.name,200),
   'origem',case x.origin when 'document' then 'Venda' else 'Manual' end,'pedido',x.document_number::text,'descricao',erp_preferences.report_clean(x.description,200),
   'parcela',erp_preferences.report_cents(x.parcel_cents),'base',erp_preferences.report_cents(x.base_cents),'aliquota',trim_scale(x.rate)::text,
   'comissao',erp_preferences.report_cents(x.commission_cents),'vencimento',x.due_on::text,'liberada',x.released_on::text,
   'situacao',case when x.void then 'Anulada' when x.released_on is not null then 'Liberada' else 'Pendente' end)
  from erp_finance.commission_rows(null) x join erp_catalog.seller s on s.id=x.seller_id left join erp_catalog.record sr on sr.id=s.contact_id;
 elsif p_base='caixa' then
  -- Caixa: the lançamentos of Caixas e bancos (entries, transferências, baixas and saldo inicial), as the extrato shows them.
  return query select to_char(l.posted_on,'YYYYMMDD')||' '||to_char(l.created_at,'YYYYMMDDHH24MISSUS')||' '||l.line_id,jsonb_build_object('data',l.posted_on::text,
   'conta',erp_preferences.report_clean(a.name,200),'descricao',erp_preferences.report_clean(l.note,200),'contato',erp_preferences.report_clean(r.name,200),
   'categoria',erp_preferences.report_clean(c.name,120),
   'tipo',case l.line_kind when 'entry' then 'Lançamento' when 'transfer' then 'Transferência' when 'settlement' then case l.title_kind when 'receivable' then 'Recebimento' else 'Pagamento' end else 'Saldo inicial' end,
   'entrada',case when l.amount_cents>0 then erp_preferences.report_cents(l.amount_cents) end,'saida',case when l.amount_cents<0 then erp_preferences.report_cents(-l.amount_cents) end)
  from erp_finance.statement_lines(null,null,null,false) l left join erp_finance.account a on a.id=l.account_id left join erp_catalog.record r on r.id=l.contact_id
   left join erp_finance.category c on c.id=l.category_id;
 end if;
end $$;

create or replace function public.erp_preferences_reports(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 -- 264: Sistema › Usuários › Permissões › Outros › Relatórios customizados.
 perform erp_access.require_permission(p_user_id,'outros.relatorios_customizados');
 return jsonb_build_object('scope','reports','data_mode','erp_native','can_manage',v_role='admin',
  'bases',(select coalesce(jsonb_agg(b order by o),'[]'::jsonb) from jsonb_array_elements(erp_preferences.report_catalog()) with ordinality x(b,o) where erp_preferences.report_visible(p_user_id,v_role,b->>'base')),
  'reports',(select coalesce(jsonb_agg(erp_preferences.report_dto(r) order by lower(r.title),r.id),'[]'::jsonb) from erp_preferences.report r
   where erp_preferences.report_visible(p_user_id,v_role,r.base) and(v_role='admin' or p_user_id=any(r.users))),
  'directory',case when v_role='admin' then erp_preferences.directory() end);
end $$;

create or replace function public.erp_preferences_report_run(p_user_id uuid,p_base text,p_columns jsonb,p_filters jsonb,p_view_limit integer,p_offset integer,p_page integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;b jsonb;v_count bigint;v_rows jsonb;v_totals jsonb;f jsonb;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_base is null or not erp_preferences.report_visible(p_user_id,v_role,p_base) then raise exception 'erp_preferences_report_access_denied' using errcode='42501'; end if;
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

create or replace function public.erp_company_access(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r text;begin r:=erp_company.require_access(p_user_id,'read');
 -- 264: Sistema › Usuários › Permissões › Outros › Acesso aos dados da empresa (the administrador always has it).
 if not erp_access.permitted(p_user_id,'outros.dados_empresa') then raise exception 'erp_company_forbidden' using errcode='42501';end if;
 return jsonb_build_object('read_identity',true,'write_identity',r='admin','read_fiscal',r in('admin','fiscal'),'write_fiscal',r in('admin','fiscal'),'data_mode','erp_native','emission_enabled',false);end $$;

create or replace function public.erp_company_extra_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;
begin
 v_role:=erp_company.require_access(p_user_id,'read');
 if not erp_access.permitted(p_user_id,'outros.dados_empresa') then raise exception 'erp_company_forbidden' using errcode='42501'; end if;
 return jsonb_build_object('scope','company_extra','data_mode','erp_native','can_manage',v_role='admin','record',erp_company.extra_dto());
end $$;

-- ---- Prefixo GS1 da empresa (Sequencial EAN): 7 a 11 dígitos ----
do $$declare v_rows integer;begin
 update erp_preferences.definition set format='digits',min_length=7 where key='produtos.ean_prefixo' and kind='text' and format='plain' and max_length=11;
 get diagnostics v_rows=row_count;
 if v_rows<>1 then raise exception 'preferences_264_ean_prefix_definition_changed' using errcode='55000'; end if;
 if exists(select 1 from erp_preferences.definition d where not erp_preferences.value_valid(d,d.default_value)) then raise exception 'erp_preferences_default_invalid'; end if;
 if exists(select 1 from erp_preferences.company_value c join erp_preferences.definition d on d.key=c.key where d.key='produtos.ean_prefixo' and not erp_preferences.value_valid(d,c.value)) then
  raise exception 'preferences_264_ean_prefix_invalid' using errcode='55000'; end if;
end$$;

revoke all on function erp_preferences.value_valid(erp_preferences.definition,jsonb),erp_preferences.page_dto(erp_preferences.page,text,uuid),erp_preferences.page_permission(text),
 erp_preferences.report_catalog(),erp_preferences.report_allowed(text,text),erp_preferences.report_source(text),erp_preferences.report_cents(bigint),erp_preferences.report_permission(text),
 erp_preferences.report_visible(uuid,text,text) from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_preferences_reports(uuid)','erp_preferences_report_run(uuid,text,jsonb,jsonb,integer,integer,integer)',
  'erp_company_access(uuid)','erp_company_extra_get(uuid)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
