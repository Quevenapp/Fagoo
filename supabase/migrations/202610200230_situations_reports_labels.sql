-- 230: Gerenciador de transições, Relatórios customizados, Etiquetas customizadas e Atividade da Carteira (onda D).
-- * Situações padrão do Origin para pedidos de venda que a frente de documentos acrescenta: "Venda Agenciada" (agency_sale,
--   #FF7835) e "Faturado parcialmente" (partially_invoiced, #B83147). O Gerenciador lista as situações-base de
--   erp_documents.transitions(); enquanto o tipo de documento não tiver essas situações, nada muda na tela.
-- * Relatórios customizados: visões base NF-e de saída, NF-e de entrada e NFC-e, das notas próprias do Brufap
--   (erp_fiscal_invoices, sem as excluídas), lidas por quem lê as notas (administrador, consulta e fiscal).
-- * Etiquetas customizadas: registros do tipo Nota Fiscal para imprimir e as etiquetas dos produtos de uma nota, com a
--   quantidade de cada item ("Imprimir etiquetas" da lista de notas).
-- * Correção: a pesquisa dos registros para imprimir etiquetas usava erp_preferences.tag_query, que a 185 retirou junto com as
--   tags da 148 (a busca falhava com "função inexistente"); a função passa a ter o próprio filtro (erp_preferences.label_query).
-- * Dashboard Atividade da Carteira: as palavras-chave encontram as tags de Contatos do cliente (migração 153) ou parte do nome.
-- Substitui funções das migrações 148, 149 e 150 (conferidas pelo hash; outra versão interrompe a migração). Nenhuma tabela nova.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_preferences.situation_base_label(text,text)','30bbf3c200f405a0d9eb4af4d4d5541d024def90379414880004ef8caf1b4056'),
  ('erp_preferences.situation_base_color(text)','9aac246b96a8d54070753d4fd260d9d9286f08652f9f8f8919d546ed1688b148'),
  ('erp_preferences.situation_bases(text)','8288dbc3a9ca805632fa0149aa1f7bd1fd8ad44a89d35e66641e8959d9deeaa9'),
  ('erp_preferences.report_catalog()','eed8e40b88ba0a7902685877da08f3b4321bc9b424e6c5cc0e668b54cf0e6b7b'),
  ('erp_preferences.report_allowed(text,text)','db202ed9164500a4195f0c5e476c9e74dc7c12d9339058c2602490f9cbce32e8'),
  ('erp_preferences.report_source(text)','ae39a99bdbe21f57d8bebbcf9380b097916fabf9b2396f2057e22ad0f0f7743d'),
  ('public.erp_preferences_label_records(uuid,text,text)','ce22644bb390fa20bb556ca5e7998a9bc37765d711cd6aea834b10c34bfeb169'),
  ('public.erp_home_business_portfolio(uuid,date,date,text,integer,jsonb)','520c7a5ebe13743e03027e3ec380c2337e0d6c6cf9014427ae4e9e865193a2ed')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'preferences_230_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
end$$;

-- ---- Gerenciador de transições: nomes e cores do Origin para Venda Agenciada e Faturado parcialmente ----
create or replace function erp_preferences.situation_base_label(p_kind text,p_status text) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce('{"sales_orders":{"draft":"Em digitação","open":"Em aberto","verified":"Verificado","in_progress":"Em andamento","agency_sale":"Venda Agenciada","partially_fulfilled":"Atendido parcialmente","partially_invoiced":"Faturado parcialmente","fulfilled":"Atendido","cancelled":"Cancelado"},
  "purchase_orders":{"open":"Em aberto","in_progress":"Em andamento","partially_fulfilled":"Atendido parcialmente","fulfilled":"Atendido","cancelled":"Cancelado"},
  "service_orders":{"open":"Em aberto","quoted":"Orçada","approved":"Aprovada","rejected":"Não aprovada","in_progress":"Em andamento","waiting_parts":"Aguardando componentes","service_done":"Serviço concluído","finalized":"Finalizada","no_repair":"Finalizada sem conserto","cancelled":"Cancelado"}}'::jsonb#>>array[p_kind,p_status],
  left(initcap(replace(p_status,'_',' ')),40))
$$;
create or replace function erp_preferences.situation_base_color(p_status text) returns text language sql immutable set search_path=pg_catalog as $$
 select coalesce('{"draft":"#9e9e9e","open":"#e6a700","quoted":"#8d6e63","approved":"#43a047","rejected":"#e53935","verified":"#7e57c2","in_progress":"#1e88e5","agency_sale":"#ff7835","waiting_parts":"#fb8c00",
  "partially_fulfilled":"#26a69a","partially_invoiced":"#b83147","service_done":"#00897b","fulfilled":"#2e7d32","finalized":"#2e7d32","no_repair":"#6d4c41","cancelled":"#d32f2f"}'::jsonb->>p_status,'#607d8b')
$$;
create or replace function erp_preferences.situation_bases(p_kind text) returns table(status text,label text,color text,ordinal integer) language sql stable set search_path=pg_catalog as $$
 select k.status,erp_preferences.situation_base_label(p_kind,k.status),erp_preferences.situation_base_color(k.status),coalesce(o.ordinal,1000)::integer
 from jsonb_object_keys(case when p_kind in('sales_orders','purchase_orders','service_orders') then coalesce(erp_documents.transitions()->p_kind,'{}'::jsonb) else '{}'::jsonb end) k(status)
 left join unnest(array['draft','open','quoted','approved','rejected','verified','in_progress','agency_sale','waiting_parts','partially_fulfilled','partially_invoiced','service_done','fulfilled','finalized','no_repair','cancelled'])
  with ordinality o(status,ordinal) on o.status=k.status
 where k.status~'^[a-z_]{2,40}$'
$$;

-- ---- Relatórios customizados: NF-e de saída, NF-e de entrada e NFC-e ----
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
  {"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]}
 ]'::jsonb
$$;
create or replace function erp_preferences.report_allowed(p_role text,p_base text) returns boolean language sql stable set search_path=pg_catalog as $$
 select coalesce(case p_base when 'produtos' then erp_catalog.allowed(p_role,'products',false) when 'contatos' then erp_catalog.allowed(p_role,'contacts',false)
  when 'contas_receber' then p_role in('admin','financeiro','consulta') when 'contas_pagar' then p_role in('admin','financeiro','consulta')
  when 'vendas' then erp_documents.allowed(p_role,'sales_orders',false) when 'propostas' then erp_documents.allowed(p_role,'sales_proposals',false)
  when 'pedidos_compra' then erp_documents.allowed(p_role,'purchase_orders',false) when 'ordens_servico' then erp_documents.allowed(p_role,'service_orders',false)
  -- 230: the notes as the notas lane reads them (erp_fiscal_invoices.require_read).
  when 'notas_saida' then p_role in('admin','consulta','fiscal') when 'notas_entrada' then p_role in('admin','consulta','fiscal') when 'nfce' then p_role in('admin','consulta','fiscal')
  else false end,false)
$$;
-- Situação of a note with the names of the notas lane (INVOICE_STATUS).
create function erp_preferences.report_invoice_status(p_status smallint) returns text language sql immutable set search_path=pg_catalog as $$
 select '{"1":"Pendente","2":"Em contingência","3":"Cancelada","4":"Aguardando recibo","5":"Rejeitada","6":"Autorizada","7":"Emitida DANFE","8":"Registrada","9":"Aguardando protocolo",
  "10":"Denegada","11":"Consulta situação","12":"Bloqueada","14":"Enviando Carta de correção","15":"Enviando Cancelamento","16":"Enviando Autorização"}'::jsonb->>p_status::text
$$;
create or replace function erp_preferences.report_source(p_base text) returns table(sort_key text,data jsonb) language sql stable set search_path=pg_catalog as $$
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
 where i.deleted_at is null and((p_base='notas_saida' and i.model='55' and i.direction='1') or(p_base='notas_entrada' and i.model='55' and i.direction='0') or(p_base='nfce' and i.model='65'))
$$;

-- ---- Etiquetas customizadas: registros de Nota Fiscal e os produtos de uma nota ----
-- Pesquisa (até 60 caracteres, uma linha) as a LIKE pattern; the same rule as the retired erp_preferences.tag_query of 148.
create function erp_preferences.label_query(p_query text) returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_query is not null and(char_length(p_query) not between 1 and 60 or p_query~'[[:cntrl:]]' or p_query<>btrim(p_query)) then
  raise exception 'erp_preferences_label_query_invalid' using errcode='22023'; end if;
 return case when p_query is null then null else '%'||replace(replace(replace(lower(p_query),'\','\\'),'%','\%'),'_','\_')||'%' end;
end $$;
create or replace function public.erp_preferences_label_records(p_user_id uuid,p_type text,p_query text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_like text;v_kind text;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if p_type is null or p_type not in('produto','contato','pedido_venda','ordem_servico','nota_fiscal') then raise exception 'erp_preferences_label_type_invalid' using errcode='22023'; end if;
 v_kind:=case p_type when 'pedido_venda' then 'sales_orders' when 'ordem_servico' then 'service_orders' end;
 if not(case p_type when 'produto' then erp_catalog.allowed(v_role,'products',false) when 'contato' then erp_catalog.allowed(v_role,'contacts',false)
   when 'nota_fiscal' then v_role in('admin','consulta','fiscal') else erp_documents.allowed(v_role,v_kind,false) end) then
  raise exception 'erp_preferences_label_access_denied' using errcode='42501'; end if;
 v_like:=erp_preferences.label_query(p_query);
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
  union all
  -- 230: NF-e de saída e entrada of Brufap (not deleted), by number or recipient.
  select lpad(coalesce(i.number,0)::text,12,'0')||i.id,jsonb_build_object('id',i.id,'values',jsonb_build_object('numero',i.number::text,'serie',i.series::text,
   'cliente',erp_preferences.report_clean(i.recipient->>'name',200),'endereco_cliente',erp_preferences.report_clean(concat_ws(', ',i.recipient->>'street',i.recipient->>'number'),200),
   'cidade_uf',erp_preferences.report_clean(concat_ws('/',i.recipient->>'city',i.recipient->>'state'),110),'chave',i.access_key))
  from erp_fiscal_invoices.invoice i where p_type='nota_fiscal' and i.model='55' and i.deleted_at is null
   and(v_like is null or coalesce(i.number::text,'') like v_like or lower(coalesce(i.recipient->>'name','')) like v_like)
  order by 1 limit 100) x),'[]'::jsonb));
end $$;
-- "Imprimir etiquetas" of a note: the product labels of its items with the quantity of each (Origin prints one label per unit).
create function public.erp_preferences_label_invoice_products(p_user_id uuid,p_invoice_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v erp_fiscal_invoices.invoice%rowtype;
begin
 v_role:=erp_preferences.reader_role(p_user_id);
 if v_role not in('admin','consulta','fiscal') or not erp_catalog.allowed(v_role,'products',false) then raise exception 'erp_preferences_label_access_denied' using errcode='42501'; end if;
 if p_invoice_id is null then raise exception 'erp_preferences_label_type_invalid' using errcode='22023'; end if;
 select * into v from erp_fiscal_invoices.invoice where id=p_invoice_id and deleted_at is null;
 if not found then raise exception 'erp_preferences_label_invoice_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('scope','label_invoice_products','data_mode','erp_native','invoice',jsonb_build_object('id',v.id,'model',v.model,'number',v.number::text,'series',v.series::text),
  'items',coalesce((select jsonb_agg(jsonb_build_object('position',i.position,'product_id',i.product_id,'quantity',trim_scale(i.quantity)::text,
   'values',jsonb_build_object('codigo',erp_preferences.report_clean(coalesce(r.code,i.data->>'code'),100),'descricao',erp_preferences.report_clean(coalesce(r.name,i.data->>'description'),200),
    'preco',coalesce(p.price,i.unit_price)::text,'unidade',erp_preferences.report_clean(coalesce(p.unit,i.data->>'unit'),20),'gtin',erp_preferences.report_clean(coalesce(p.gtin,i.data->>'gtin'),20),
    'ncm',erp_preferences.report_clean(coalesce(p.ncm,i.data->>'ncm'),10))) order by i.position)
   from(select * from erp_fiscal_invoices.invoice_item where invoice_id=v.id order by position limit 990) i
   left join erp_catalog.record r on r.id=i.product_id left join erp_catalog.product p on p.record_id=i.product_id),'[]'::jsonb));
end $$;

-- ---- Dashboard Atividade da Carteira: palavras-chave nas tags de Contatos ou no nome ----
create or replace function public.erp_home_business_portfolio(p_user_id uuid,p_from date,p_to date,p_brand text,p_min_days integer,p_keywords jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text;v_s text[];v_today date:=erp_home.biz_today();v_keywords text[];
begin
 v_role:=erp_home.biz_role(p_user_id);perform erp_home.biz_period(p_from,p_to,3661);
 if p_keywords is null or jsonb_typeof(p_keywords)<>'array' or jsonb_array_length(p_keywords)>10 or exists(select 1 from jsonb_array_elements(p_keywords) x where jsonb_typeof(x)<>'string') then
  raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_keywords:=array(select jsonb_array_elements_text(p_keywords));
 if length(p_brand)>100 or p_brand~'[[:cntrl:]]' or p_min_days is not null and p_min_days not between 0 and 36600
  or exists(select 1 from unnest(v_keywords) k where length(k) not between 1 and 60 or k<>btrim(k) or k~'[[:cntrl:]]') then raise exception 'erp_home_business_input_invalid' using errcode='22023'; end if;
 v_s:=erp_home.biz_finished();
 return erp_home.biz_envelope('atividade-carteira',v_role,jsonb_build_object('statuses',to_jsonb(v_s),'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),
   'brand',nullif(btrim(coalesce(p_brand,'')),''),'min_days',p_min_days,'keywords',to_jsonb(v_keywords)))
  ||(with o as materialized(select * from erp_home.biz_orders(p_from,p_to,v_s) o
      where(nullif(btrim(coalesce(p_brand,'')),'') is null or exists(select 1 from erp_documents.item i join erp_catalog.product p on p.record_id=i.product_id
       where i.document_id=o.id and strpos(lower(coalesce(p.brand,'')),lower(btrim(p_brand)))>0))
       -- 230: a keyword is a tag of Contatos of the customer (same name, accents and case ignored) or part of the name.
       and(cardinality(v_keywords)=0 or exists(select 1 from unnest(v_keywords) k where strpos(lower(o.contact_name),lower(k))>0
        or exists(select 1 from erp_catalog.contact_tag ct join erp_catalog.taxonomy t on t.id=ct.tag_id where ct.record_id=o.contact_id and erp_catalog.fold(t.name)=erp_catalog.fold(k))))),
    cu as materialized(select contact_id,max(contact_name) name,count(*)::integer orders,sum(total) total,min(day) first_day,max(day) last_day,count(distinct day)::integer days from o group by contact_id),
    f as materialized(select cu.*,v_today-cu.last_day idle from cu where p_min_days is null or v_today-cu.last_day>=p_min_days)
   select jsonb_build_object('total',(select count(*)::integer from f),'sum',(select erp_home.money(sum(total)) from f),
    'customers',erp_home.biz_fit((select coalesce(jsonb_agg(jsonb_build_object('contact_id',f.contact_id,'name',f.name,'orders',f.orders,'total',erp_home.money(f.total),
       'first_purchase',to_char(f.first_day,'YYYY-MM-DD'),'last_purchase',to_char(f.last_day,'YYYY-MM-DD'),
       'cycle_days',case when f.days>1 then round((f.last_day-f.first_day)::numeric/(f.days-1))::integer end,'days_without',greatest(f.idle,0),
       'document',erp_home.biz_text(c.document,20),'state',erp_home.biz_text(c.state,2),'email',erp_home.biz_text(c.email,254),'mobile',erp_home.biz_text(coalesce(nullif(c.mobile,''),c.phone),40))
       order by f.total desc,f.name,f.contact_id),'[]'::jsonb)
      from(select * from f order by total desc,name,contact_id limit 500) f left join erp_catalog.contact c on c.record_id=f.contact_id),160000)));
end $$;

revoke all on function erp_preferences.label_query(text),erp_preferences.situation_base_label(text,text),erp_preferences.situation_base_color(text),erp_preferences.situation_bases(text),erp_preferences.report_catalog(),
 erp_preferences.report_allowed(text,text),erp_preferences.report_invoice_status(smallint),erp_preferences.report_source(text) from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_preferences_label_records(uuid,text,text)','erp_preferences_label_invoice_products(uuid,uuid)',
  'erp_home_business_portfolio(uuid,date,date,text,integer,jsonb)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
