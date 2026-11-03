-- 284: Relatórios customizados com os demais relatórios padrão do Origin sobre dados que o Brufap já tem (frente mista, onda F):
-- * Curva ABC de itens de vendas (os produtos dos pedidos de venda, sem Em digitação e Cancelado, pelo valor vendido: A até 80% do
--   valor acumulado antes do item, B até 95%, C o resto), Pessoas de Contato, Ficha Financeira a Receber, Ficha Financeira a Pagar,
--   Ocorrências por Proposta Comercial, Ocorrências por Ordem de Serviço, Ocorrências por Venda (as ocorrências removidas ficam de
--   fora), Transporte por Nota Fiscal (NF-e de saída do Brufap) e Transporte por Venda. Só leitura, sobre as tabelas das outras
--   frentes, lidas por quem lê cada módulo e com a permissão do módulo (Sistema › Usuários › Permissões); a Ficha Financeira usa
--   "Ficha Financeira" (Finanças).
-- * Contas a Receber e Contas a Pagar mostram a Situação "Devolvido" das contas marcadas pela devolução (281).
-- * Contratos não entra (o Brufap não tem o módulo); Ordens de Produção, Ocorrências por Ordem de Produção, Balanças Comerciais,
--   Produto Loja, NFS-e e Nota Serviço Parcela estão fora do escopo.
-- Substitui erp_preferences.report_catalog, report_allowed, report_permission e report_source (264), conferidas pelo hash; qualquer
-- outra versão interrompe a migração. Requer 281. Nenhuma tabela nova e nenhuma escrita.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_preferences.report_catalog()','b8c76c2c40a656b82513b9de53a60e2f94de2d41535abf1898cd3743d91986bc'),
  ('erp_preferences.report_allowed(text,text)','ca50d4426601787b57f979a814a7c2ee99c34da9627e9339ac4589f6b2793c7d'),
  ('erp_preferences.report_permission(text)','aecc4281c24279510875610b60c7942bc672402cc918dde3fad3a26b3f1d22cf'),
  ('erp_preferences.report_source(text)','38d72dd713deea4cf80fb45def9435803faee4f0271986007126ad3a5429a750')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'preferences_284_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
 if to_regclass('erp_finance.title_return') is null or to_regclass('erp_documents.occurrence_removal') is null or to_regclass('erp_catalog.contact_person') is null then
  raise exception 'preferences_284_requires_124_129_281' using errcode='55000';end if;
end$$;

-- Frete por conta (modFrete of the NF-e and the transport of the pedidos), with the Origin labels.
create function erp_preferences.report_freight(p_code text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_code when '0' then '0 - Contratação do Frete por conta do Remetente (CIF)' when '1' then '1 - Contratação do Frete por conta do Destinatário (FOB)'
  when '2' then '2 - Contratação do Frete por conta de Terceiros' when '3' then '3 - Transporte Próprio por conta do Remetente'
  when '4' then '4 - Transporte Próprio por conta do Destinatário' when '9' then '9 - Sem Ocorrência de Transporte' end
$$;

create or replace function erp_preferences.report_catalog() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select '[
 {"base":"produtos","group":"cadastros","title":"Produtos","default_columns":["codigo","descricao","unidade","preco","situacao"],"columns":[{"id":"codigo","label":"Código","type":"text"},{"id":"descricao","label":"Descrição","type":"text"},{"id":"unidade","label":"Unidade","type":"text"},{"id":"preco","label":"Preço","type":"decimal"},{"id":"tipo","label":"Tipo","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"gtin","label":"GTIN/EAN","type":"text"},{"id":"ncm","label":"NCM","type":"text"}]},
 {"base":"contatos","group":"cadastros","title":"Clientes e Fornecedores","default_columns":["nome","documento","cidade","uf","telefone","email"],"columns":[{"id":"nome","label":"Nome","type":"text"},{"id":"fantasia","label":"Fantasia","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"ie","label":"IE","type":"text"},{"id":"cidade","label":"Cidade","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"telefone","label":"Telefone","type":"text"},{"id":"celular","label":"Celular","type":"text"},{"id":"email","label":"E-mail","type":"text"},{"id":"tipos","label":"Tipo de contato","type":"text"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"contas_receber","group":"financas","title":"Contas a Receber","default_columns":["vencimento","contato","descricao","valor","saldo","situacao"],"columns":[{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"contas_pagar","group":"financas","title":"Contas a Pagar","default_columns":["vencimento","contato","descricao","valor","saldo","situacao"],"columns":[{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"vendas","group":"vendas","title":"Vendas","default_columns":["numero","data","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"propostas","group":"vendas","title":"Propostas Comerciais","default_columns":["numero","data","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"pedidos_compra","group":"suprimentos","title":"Pedidos de Compra","default_columns":["numero","data","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"ordens_servico","group":"servicos","title":"Ordens de Serviço","default_columns":["numero","data","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"vendedor","label":"Vendedor","type":"text"},{"id":"itens","label":"Itens","type":"int"},{"id":"total","label":"Total","type":"money"}]},
 {"base":"notas_saida","group":"vendas","title":"NF-e de saída","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"notas_entrada","group":"suprimentos","title":"NF-e de entrada","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"uf","label":"UF","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"nfce","group":"vendas","title":"NFC-e","default_columns":["numero","serie","emissao","contato","situacao","total"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"natureza","label":"Natureza de operação","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"total","label":"Valor total","type":"money"},{"id":"chave","label":"Chave de acesso","type":"text"}]},
 {"base":"recebimentos","group":"financas","title":"Recebimentos","default_columns":["data","contato","descricao","valor","conta"],"columns":[{"id":"data","label":"Data do recebimento","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"valor","label":"Valor recebido","type":"money"},{"id":"juros","label":"Juros","type":"money"},{"id":"multa","label":"Multa","type":"money"},{"id":"desconto","label":"Desconto","type":"money"},{"id":"tarifa","label":"Tarifa","type":"money"},{"id":"liquido","label":"Valor líquido","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"pagamentos","group":"financas","title":"Pagamentos","default_columns":["data","contato","descricao","valor","conta"],"columns":[{"id":"data","label":"Data do pagamento","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"contato","label":"Fornecedor","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"categoria","label":"Categoria","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"valor","label":"Valor pago","type":"money"},{"id":"juros","label":"Juros","type":"money"},{"id":"multa","label":"Multa","type":"money"},{"id":"desconto","label":"Desconto","type":"money"},{"id":"tarifa","label":"Tarifa","type":"money"},{"id":"liquido","label":"Valor líquido","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"venda_parcela","group":"vendas","title":"Venda Parcela","default_columns":["numero","data","contato","parcela","vencimento","valor"],"columns":[{"id":"numero","label":"Número da venda","type":"int"},{"id":"data","label":"Data da venda","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"valor","label":"Valor da parcela","type":"money"},{"id":"forma","label":"Forma de pagamento","type":"text"},{"id":"observacao","label":"Observação","type":"text"}]},
 {"base":"comissoes","group":"financas","title":"Comissões","default_columns":["vendedor","pedido","base","aliquota","comissao","situacao"],"columns":[{"id":"vendedor","label":"Vendedor","type":"text"},{"id":"origem","label":"Origem","type":"text"},{"id":"pedido","label":"Número do pedido","type":"int"},{"id":"descricao","label":"Descrição","type":"text"},{"id":"parcela","label":"Valor da parcela","type":"money"},{"id":"base","label":"Base de cálculo","type":"money"},{"id":"aliquota","label":"Alíquota (%)","type":"decimal"},{"id":"comissao","label":"Comissão","type":"money"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"liberada","label":"Liberada em","type":"date"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"caixa","group":"financas","title":"Caixa","default_columns":["data","conta","descricao","entrada","saida"],"columns":[{"id":"data","label":"Data","type":"date"},{"id":"conta","label":"Conta financeira","type":"text"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"contato","label":"Contato","type":"text"},{"id":"categoria","label":"Categoria","type":"text"},{"id":"tipo","label":"Tipo","type":"text"},{"id":"entrada","label":"Entrada","type":"money"},{"id":"saida","label":"Saída","type":"money"}]},
 {"base":"curva_abc","group":"vendas","title":"Curva ABC de itens de vendas","default_columns":["classe","codigo","descricao","quantidade","valor","acumulado"],"columns":[{"id":"classe","label":"Classe","type":"text"},{"id":"codigo","label":"Código","type":"text"},{"id":"descricao","label":"Descrição","type":"text"},{"id":"quantidade","label":"Quantidade vendida","type":"decimal"},{"id":"valor","label":"Valor total","type":"money"},{"id":"percentual","label":"% do total","type":"decimal"},{"id":"acumulado","label":"% acumulado","type":"decimal"},{"id":"pedidos","label":"Pedidos","type":"int"}]},
 {"base":"pessoas_contato","group":"cadastros","title":"Pessoas de Contato","default_columns":["contato","nome","email","telefone"],"columns":[{"id":"contato","label":"Contato","type":"text"},{"id":"documento","label":"CPF/CNPJ do contato","type":"text"},{"id":"nome","label":"Nome","type":"text"},{"id":"email","label":"E-mail","type":"text"},{"id":"telefone","label":"Telefone","type":"text"},{"id":"celular","label":"Celular","type":"text"}]},
 {"base":"ficha_receber","group":"financas","title":"Ficha Financeira a Receber","default_columns":["contato","vencimento","descricao","valor","pago","saldo","situacao"],"columns":[{"id":"contato","label":"Cliente","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"pago","label":"Valor recebido","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"ficha_pagar","group":"financas","title":"Ficha Financeira a Pagar","default_columns":["contato","vencimento","descricao","valor","pago","saldo","situacao"],"columns":[{"id":"contato","label":"Fornecedor","type":"text"},{"id":"documento","label":"CPF/CNPJ","type":"text"},{"id":"emissao","label":"Emissão","type":"date"},{"id":"vencimento","label":"Vencimento","type":"date"},{"id":"descricao","label":"Histórico","type":"text"},{"id":"parcela","label":"Parcela","type":"text"},{"id":"valor","label":"Valor","type":"money"},{"id":"pago","label":"Valor pago","type":"money"},{"id":"saldo","label":"Saldo","type":"money"},{"id":"situacao","label":"Situação","type":"text"}]},
 {"base":"ocorrencias_propostas","group":"vendas","title":"Ocorrências por Proposta Comercial","default_columns":["numero","contato","data","situacao","ocorrencia","proximo_contato"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"contato","label":"Cliente","type":"text"},{"id":"data","label":"Data","type":"date"},{"id":"hora","label":"Hora","type":"text"},{"id":"situacao_anterior","label":"Situação anterior","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"ocorrencia","label":"Ocorrência","type":"text"},{"id":"proximo_contato","label":"Próximo contato","type":"date"},{"id":"usuario","label":"Usuário","type":"text"}]},
 {"base":"ocorrencias_os","group":"servicos","title":"Ocorrências por Ordem de Serviço","default_columns":["numero","contato","data","situacao","ocorrencia"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"contato","label":"Cliente","type":"text"},{"id":"data","label":"Data","type":"date"},{"id":"hora","label":"Hora","type":"text"},{"id":"situacao_anterior","label":"Situação anterior","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"ocorrencia","label":"Ocorrência","type":"text"},{"id":"usuario","label":"Usuário","type":"text"}]},
 {"base":"ocorrencias_vendas","group":"vendas","title":"Ocorrências por Venda","default_columns":["numero","contato","data","situacao","ocorrencia"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"contato","label":"Cliente","type":"text"},{"id":"data","label":"Data","type":"date"},{"id":"hora","label":"Hora","type":"text"},{"id":"situacao_anterior","label":"Situação anterior","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"ocorrencia","label":"Ocorrência","type":"text"},{"id":"usuario","label":"Usuário","type":"text"}]},
 {"base":"transporte_nota","group":"vendas","title":"Transporte por Nota Fiscal","default_columns":["numero","emissao","contato","transportador","frete","volumes","peso_bruto"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"serie","label":"Série","type":"int"},{"id":"emissao","label":"Data de emissão","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"transportador","label":"Transportador","type":"text"},{"id":"documento_transportador","label":"CPF/CNPJ do transportador","type":"text"},{"id":"frete","label":"Frete por conta","type":"text"},{"id":"valor_frete","label":"Valor do frete","type":"money"},{"id":"volumes","label":"Volumes","type":"int"},{"id":"especie","label":"Espécie","type":"text"},{"id":"peso_bruto","label":"Peso bruto","type":"decimal"},{"id":"peso_liquido","label":"Peso líquido","type":"decimal"},{"id":"placa","label":"Placa","type":"text"},{"id":"rastreamento","label":"Código de rastreamento","type":"text"}]},
 {"base":"transporte_venda","group":"vendas","title":"Transporte por Venda","default_columns":["numero","data","contato","transportador","frete","volumes","peso_bruto"],"columns":[{"id":"numero","label":"Número","type":"int"},{"id":"data","label":"Data","type":"date"},{"id":"contato","label":"Cliente","type":"text"},{"id":"situacao","label":"Situação","type":"text"},{"id":"transportador","label":"Transportador","type":"text"},{"id":"frete","label":"Frete por conta","type":"text"},{"id":"valor_frete","label":"Valor do frete","type":"money"},{"id":"volumes","label":"Volumes","type":"decimal"},{"id":"peso_bruto","label":"Peso bruto","type":"decimal"},{"id":"prazo","label":"Prazo de entrega (dias)","type":"int"},{"id":"rastreamento","label":"Código de rastreamento","type":"text"}]}
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
  -- 284: Curva ABC, Pessoas de Contato, Fichas Financeiras, Ocorrências and Transporte, as each module reads them.
  when 'curva_abc' then erp_documents.allowed(p_role,'sales_orders',false) when 'pessoas_contato' then erp_catalog.allowed(p_role,'contacts',false)
  when 'ficha_receber' then p_role in('admin','financeiro','consulta') when 'ficha_pagar' then p_role in('admin','financeiro','consulta')
  when 'ocorrencias_propostas' then erp_documents.allowed(p_role,'sales_proposals',false) when 'ocorrencias_os' then erp_documents.allowed(p_role,'service_orders',false)
  when 'ocorrencias_vendas' then erp_documents.allowed(p_role,'sales_orders',false) when 'transporte_venda' then erp_documents.allowed(p_role,'sales_orders',false)
  when 'transporte_nota' then p_role in('admin','consulta','fiscal')
  else false end,false)
$$;
create or replace function erp_preferences.report_permission(p_base text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_base when 'produtos' then 'cadastros.produtos' when 'contatos' then 'cadastros.clientes_fornecedores' when 'contas_receber' then 'financas.contas_receber'
  when 'contas_pagar' then 'financas.contas_pagar' when 'vendas' then 'vendas.pedidos_venda' when 'propostas' then 'vendas.propostas' when 'pedidos_compra' then 'suprimentos.pedidos_compra'
  when 'ordens_servico' then 'servicos.ordem_servico' when 'notas_saida' then 'vendas.notas_fiscais' when 'notas_entrada' then 'suprimentos.notas_entrada' when 'nfce' then 'vendas.nfce'
  when 'recebimentos' then 'financas.contas_receber' when 'pagamentos' then 'financas.contas_pagar' when 'venda_parcela' then 'vendas.pedidos_venda'
  when 'comissoes' then 'vendas.comissoes' when 'caixa' then 'financas.caixas_bancos'
  -- 284.
  when 'curva_abc' then 'vendas.pedidos_venda' when 'pessoas_contato' then 'cadastros.clientes_fornecedores' when 'ficha_receber' then 'financas.ficha' when 'ficha_pagar' then 'financas.ficha'
  when 'ocorrencias_propostas' then 'vendas.propostas' when 'ocorrencias_os' then 'servicos.ordem_servico' when 'ocorrencias_vendas' then 'vendas.pedidos_venda'
  when 'transporte_venda' then 'vendas.pedidos_venda' when 'transporte_nota' then 'vendas.notas_fiscais' end
$$;
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
  'situacao',case when t.cancelled and exists(select 1 from erp_finance.title_return x where x.title_id=t.id) then 'Devolvido' when t.cancelled then 'Cancelada' when t.settled_cents=t.amount_cents then case t.kind when 'receivable' then 'Recebida' else 'Paga' end
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
 elsif p_base='curva_abc' then
  -- 284: Curva ABC de itens de vendas: the products of the pedidos de venda (Em digitação and Cancelado left out) by sold value; A up to
  -- 80% of the value accumulated before the item, B up to 95%, C the rest (exact numeric sums, rounded only in the cells).
  return query with sold as materialized(select i.product_id,sum(i.quantity) qty,sum(i.total) amount,count(distinct d.id)::integer orders
    from erp_documents.document d join erp_documents.item i on i.document_id=d.id
    where d.kind='sales_orders' and d.status not in('draft','cancelled') and i.product_id is not null group by i.product_id),
   ranked as materialized(select s.*,r.code,r.name,row_number() over(order by s.amount desc,s.product_id) n,
    sum(s.amount) over(order by s.amount desc,s.product_id rows between unbounded preceding and current row) cum,sum(s.amount) over() total
    from sold s join erp_catalog.record r on r.id=s.product_id)
  select lpad(x.n::text,10,'0'),jsonb_build_object('classe',case when x.total<=0 then 'C' when(x.cum-x.amount)*100<80*x.total then 'A' when(x.cum-x.amount)*100<95*x.total then 'B' else 'C' end,
   'codigo',erp_preferences.report_clean(x.code,100),'descricao',erp_preferences.report_clean(x.name,200),'quantidade',trim_scale(x.qty)::text,
   'valor',round(x.amount,2)::numeric(17,2)::text,'percentual',case when x.total>0 then round(x.amount*100/x.total,2)::text end,
   'acumulado',case when x.total>0 then round(x.cum*100/x.total,2)::text end,'pedidos',x.orders::text)
  from ranked x;
 elsif p_base='pessoas_contato' then
  -- 284: Pessoas de Contato of each contato (Cadastros › Clientes e fornecedores › Pessoas de contato), in the order of the contato.
  return query select lower(r.name)||' '||r.id||' '||lpad(p.position::text,2,'0'),jsonb_build_object('contato',erp_preferences.report_clean(r.name,200),
   'documento',erp_preferences.report_clean(c.document,20),'nome',erp_preferences.report_clean(pr.name,200),'email',erp_preferences.report_clean(pc.email,200),
   'telefone',erp_preferences.report_clean(pc.phone,40),'celular',erp_preferences.report_clean(pc.mobile,40))
  from erp_catalog.contact_person p join erp_catalog.record r on r.id=p.contact_id join erp_catalog.contact c on c.record_id=p.contact_id
   join erp_catalog.record pr on pr.id=p.person_id join erp_catalog.contact pc on pc.record_id=p.person_id;
 elsif p_base in('ficha_receber','ficha_pagar') then
  -- 284: Ficha Financeira a Receber / a Pagar: every conta of each contato (excluded ones never), by contato and vencimento.
  return query select lower(r.name)||' '||r.id||' '||to_char(t.due_on,'YYYYMMDD')||' '||t.id,jsonb_build_object('contato',erp_preferences.report_clean(r.name,200),
   'documento',erp_preferences.report_clean(c.document,20),'emissao',t.issued_on::text,'vencimento',t.due_on::text,'descricao',erp_preferences.report_clean(t.description,200),
   'parcela',t.installment||'/'||t.installments,'valor',erp_preferences.report_cents(t.amount_cents),'pago',erp_preferences.report_cents(t.settled_cents),
   'saldo',erp_preferences.report_cents(case when t.cancelled then 0 else t.amount_cents-t.settled_cents end),
   'situacao',case when t.cancelled and exists(select 1 from erp_finance.title_return x where x.title_id=t.id) then 'Devolvido' when t.cancelled then 'Cancelada'
    when t.settled_cents=t.amount_cents then case t.kind when 'receivable' then 'Recebida' else 'Paga' end
    when t.settled_cents>0 then case t.kind when 'receivable' then 'Parcialmente Recebida' else 'Parcialmente Paga' end
    when t.due_on<(clock_timestamp() at time zone 'America/Sao_Paulo')::date then 'Atrasada' else 'Em aberto' end)
  from erp_finance.title t join erp_catalog.record r on r.id=t.contact_id left join erp_catalog.contact c on c.record_id=t.contact_id
  where t.deleted_at is null and t.kind=case p_base when 'ficha_receber' then 'receivable' else 'payable' end;
 elsif p_base in('ocorrencias_propostas','ocorrencias_os','ocorrencias_vendas') then
  -- 284: Ocorrências por Proposta Comercial / Ordem de Serviço / Venda (103/163), the removed ones left out, by document and sequence.
  return query select lpad(d.number::text,12,'0')||lpad(o.sequence::text,8,'0'),jsonb_build_object('numero',d.number::text,
   'contato',erp_preferences.report_clean(d.contact_snapshot->>'name',200),'data',o.occurred_on::text,'hora',o.occurred_time,
   'situacao_anterior',erp_preferences.report_clean(coalesce(o.situation_before->>'name',erp_preferences.report_document_status(d.kind,o.status_before)),80),
   'situacao',erp_preferences.report_clean(coalesce(o.situation_after->>'name',erp_preferences.report_document_status(d.kind,coalesce(o.status_after,o.status_before))),80),
   'ocorrencia',erp_preferences.report_clean(o.text,200),'usuario',erp_preferences.report_clean(erp_activity.actor_label(o.actor_id),120))
   ||case when p_base='ocorrencias_propostas' then jsonb_build_object('proximo_contato',o.next_contact::text) else '{}'::jsonb end
  from erp_documents.occurrence o join erp_documents.document d on d.id=o.document_id
  where d.kind=case p_base when 'ocorrencias_propostas' then 'sales_proposals' when 'ocorrencias_os' then 'service_orders' else 'sales_orders' end
   and not exists(select 1 from erp_documents.occurrence_removal x where x.occurrence_id=o.id);
 elsif p_base='transporte_venda' then
  -- 284: Transporte por Venda: the transport of each pedido de venda (Transportador, Frete por conta, volumes, peso, prazo e rastreamento).
  return query select lpad(d.number::text,12,'0'),jsonb_build_object('numero',d.number::text,'data',case when(d.body->>'date')~'^\d{4}-\d{2}-\d{2}$' then d.body->>'date' end,
   'contato',erp_preferences.report_clean(d.contact_snapshot->>'name',200),'situacao',erp_preferences.report_document_status(d.kind,d.status),
   'transportador',erp_preferences.report_clean(coalesce((select r.name from erp_catalog.record r where r.id::text=d.body->>'carrier_id'),d.body#>>'{commercial,transport,carrier_reference,label}'),200),
   'frete',erp_preferences.report_freight(d.body#>>'{commercial,transport,freight_mode}'),
   'valor_frete',case when(d.body->>'freight')~'^[0-9]{1,15}(\.[0-9]{1,6})?$' then round((d.body->>'freight')::numeric,2)::numeric(17,2)::text end,
   'volumes',case when(d.body#>>'{commercial,transport,volume_count}')~'^[0-9]{1,12}(\.[0-9]{1,6})?$' then trim_scale((d.body#>>'{commercial,transport,volume_count}')::numeric)::text end,
   'peso_bruto',case when(d.body#>>'{commercial,transport,gross_weight}')~'^[0-9]{1,12}(\.[0-9]{1,6})?$' then trim_scale((d.body#>>'{commercial,transport,gross_weight}')::numeric)::text end,
   'prazo',case when(d.body#>>'{commercial,transport,delivery_days}')~'^(0|[1-9][0-9]{0,5})$' then d.body#>>'{commercial,transport,delivery_days}' end,
   'rastreamento',erp_preferences.report_clean(d.body#>>'{commercial,transport,tracking_code}',200))
  from erp_documents.document d where d.kind='sales_orders';
 elsif p_base='transporte_nota' then
  -- 284: Transporte por Nota Fiscal: the transport of the NF-e de saída of Brufap (transportador, modalidade, volumes, pesos e placa).
  return query select to_char(date '2100-12-31'-i.issue_date,'FM000000')||lpad(coalesce(999999999-i.number,999999999)::text,9,'0')||i.id,jsonb_build_object('numero',i.number::text,
   'serie',i.series::text,'emissao',i.issue_date::text,'contato',erp_preferences.report_clean(i.recipient->>'name',200),
   'transportador',erp_preferences.report_clean(i.transport#>>'{carrier,name}',200),'documento_transportador',erp_preferences.report_clean(i.transport#>>'{carrier,document}',20),
   'frete',erp_preferences.report_freight(i.transport->>'freight_by'),'valor_frete',i.freight::numeric(17,2)::text,
   'volumes',case when(i.transport#>>'{volumes,quantity}')~'^[0-9]{1,15}$' then (i.transport#>>'{volumes,quantity}')::bigint::text end,
   'especie',erp_preferences.report_clean(i.transport#>>'{volumes,species}',60),
   'peso_bruto',case when(i.transport#>>'{volumes,gross_weight}')~'^[0-9]{1,12}(\.[0-9]{1,3})?$' then trim_scale((i.transport#>>'{volumes,gross_weight}')::numeric)::text end,
   'peso_liquido',case when(i.transport#>>'{volumes,net_weight}')~'^[0-9]{1,12}(\.[0-9]{1,3})?$' then trim_scale((i.transport#>>'{volumes,net_weight}')::numeric)::text end,
   'placa',erp_preferences.report_clean(i.transport#>>'{vehicle,plate}',10),'rastreamento',erp_preferences.report_clean(i.transport->>'tracking_code',60))
  from erp_fiscal_invoices.invoice i
  where i.deleted_at is null and i.model='55' and i.direction='1';
 end if;
end $$;

revoke all on function erp_preferences.report_freight(text),erp_preferences.report_catalog(),erp_preferences.report_allowed(text,text),erp_preferences.report_permission(text),
 erp_preferences.report_source(text) from public,anon,authenticated,service_role;
commit;
