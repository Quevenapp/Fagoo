-- 232: Registro de atividades com as auditorias da onda C e da onda D desta frente, cada ação na operação e no módulo do Origin.
-- * Módulos novos do filtro (nomes do Origin): Campos Customizados (campos customizados de produtos, 156) e Comissão (comissões
--   manuais, créditos e débitos do extrato e pagamentos de comissões, 171).
-- * Controle de caixa (173): abrir caixa é Criação; fechar e reabrir são Atualização de situação; sangria e suprimento são
--   Lançamento; excluir caixa e excluir sangria ou suprimento são Exclusão; módulo Caixa.
-- * Faturamento agrupado (174): gerar contas é Criação e excluir é Exclusão (Contas a Pagar/Receber).
-- * Recebimento de pedido de compra (090/184): lançar o recebimento é Lançamento (estornar já era Estorno).
-- * Anexos e foto do contato (170): anexo concluído é Criação, exclusão é Exclusão (Contato). Reservas e envios abandonados
--   não entram.
-- * Tags de Contatos (153) ficam no módulo Contato; as de produtos continuam em Produto. Etiquetas de contatos (158) entram como
--   Envio no módulo Contato.
-- * Importações de planilhas (228): uma linha por importação, Criação, no módulo do que foi importado; cada cadastro, pedido,
--   movimentação, conta e nota importados também entram pela auditoria do próprio módulo.
-- * Usuários (229): tipo, horários e permissões de um usuário entram com a própria descrição (antes e depois no detalhe).
-- * Detalhe (antes e depois) também para os campos customizados. Anexos do contato e importações não guardam antes e depois.
-- Substitui erp_activity.operation, finance_module, finance_label, entries, erp_activity_list e erp_activity_detail (186);
-- qualquer outra versão interrompe a migração. Nenhuma tabela nova e nenhuma escrita.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_activity.operation(text)','177b768772db8f24136c9f652fe096a11d23085a0f08ffaa1d16aea783747fb3'),
  ('erp_activity.finance_module(text)','88ffc6d36913993636b3c65a1f37f73857137653f0fae4ca222bafdabb14358d'),
  ('erp_activity.finance_label(text)','104193ff32bd7c9ca4499400d1f7b297ecb99a18bdbc99391fc49bb6ac25cc54'),
  ('erp_activity.entries(timestamptz,timestamptz)','08adcff9b67111c3409d8ead4f342546456b4e38cc73038a1bd490c00c32f9c4'),
  ('public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer)','24e49a269378705a9aca6d130b9d19b04eda7ee4d8b2821c582d2fece87d69d2'),
  ('public.erp_activity_detail(uuid,text,text)','3ec7212104ae1c2a2704c35582dcafa1b1a59dd0479b6ddfda148bb026f53ae0')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'activity_232_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
end$$;

-- Origin operations: Atualização, Atualização de situação, Criação, Envio, Estorno, Exclusão, Lançamento, Transferência.
create or replace function erp_activity.operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case
  when p_action in('purchase_receive','commission_payment','commission_entry','session_move') then 'lancamento'
  when p_action in('commission_manual','session_open','grouped_billing_generate') then 'criacao'
  when p_action in('session_close','session_reopen') then 'atualizacao_situacao'
  when p_action like '%undelete%' or p_action like '%restore%' then 'atualizacao'
  when p_action like '%reverse%' or p_action like '%reversal%' or p_action like '%unreconcile%' then 'estorno'
  when p_action like '%delete%' or p_action like '%archive%' or p_action like '%\_remove' or p_action in('abort','title_cancel','disable') then 'exclusao'
  when p_action like '%transfer%' then 'transferencia'
  when p_action in('transition','set_active','activate','inactivate') or p_action like '%\_set\_active' or p_action like 'convert\_to%' then 'atualizacao_situacao'
  when p_action in('line_create_entry','balance_adjust') then 'lancamento'
  when p_action like 'create%' or p_action like '%\_create%' or p_action like '%import%' or p_action in('finalize','opening','clone','recurrence_generate','occurrence','configure') then 'criacao'
  when p_action like '%post%' or p_action like '%settle%' or p_action like '%reservation%' then 'lancamento'
  when p_action like '%send%' or p_action like '%authoriz%' or p_action like '%export%' then 'envio'
  else 'atualizacao' end
$$;
-- Financial audit (erp_finance.audit) by Origin module: baixas, estornos de baixa and borderôs are Pagamento/Recebimento;
-- comissões are Comissão; the caixa (lançamentos, ajuste de saldo, extratos, conciliação, transferências and the Controle de
-- caixa) is Caixa; everything else is Contas a Pagar/Receber (the "financas" module).
create or replace function erp_activity.finance_module(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_action in('settle','settle_batch','reverse','line_settle_titles') or p_action like 'bordero%' then 'pagamento_recebimento'
  when p_action like 'commission\_%' then 'comissao'
  when p_action like 'entry\_%' or p_action like 'statement\_%' or p_action like 'line\_%' or p_action like '%transfer%' or p_action='balance_adjust' or p_action like 'session\_%' then 'caixa'
  else 'financas' end
$$;
create or replace function erp_activity.finance_label(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case
  when p_action in('account_save','account_create','account_update') then 'Conta financeira' when p_action='account_delete' then 'Conta financeira excluída'
  when p_action='account_set_active' then 'Situação da conta financeira' when p_action='account_set_default' then 'Conta financeira padrão'
  when p_action in('category_save','category_create','category_update','category_move') then 'Categoria financeira' when p_action='category_delete' then 'Categoria financeira excluída'
  when p_action='category_set_active' then 'Situação da categoria financeira' when p_action='category_set_default' then 'Categoria financeira padrão'
  when p_action='category_import' then 'Importação de categorias financeiras'
  when p_action in('title_create','title_create_group') then 'Contas incluídas' when p_action in('title_update','title_edit') then 'Conta alterada'
  when p_action='title_cancel' then 'Conta cancelada' when p_action='title_delete' then 'Conta excluída'
  when p_action='settle' then 'Baixa de conta' when p_action='settle_batch' then 'Baixa de contas em lote' when p_action='reverse' then 'Estorno de baixa'
  when p_action like 'bordero%' then 'Borderô'
  when p_action='opening' then 'Saldo inicial de conta financeira'
  when p_action='document_post' then 'Contas lançadas pelo documento' when p_action='document_reverse' then 'Contas estornadas do documento'
  when p_action='entry_save' then 'Lançamento de caixa' when p_action='entry_delete' then 'Lançamento de caixa excluído' when p_action='entry_restore' then 'Lançamento de caixa restaurado'
  when p_action='balance_adjust' then 'Ajuste de saldo'
  when p_action='statement_import' then 'Extrato bancário importado' when p_action='statement_delete' then 'Extrato bancário excluído'
  when p_action='line_settle_titles' then 'Baixa pela conciliação bancária' when p_action like 'line\_%' then 'Conciliação bancária'
  when p_action in('internal_transfer','transfer_create') then 'Transferência entre contas' when p_action='transfer_delete' then 'Transferência entre contas excluída'
  when p_action like 'recurrence\_%' then 'Conta recorrente'
  when p_action='records_import' then 'Importação de registros financeiros' when p_action='origin_import_batch' then 'Importação do financeiro do Origin'
  when p_action='commission_payment' then 'Pagamento de comissões' when p_action='commission_entry' then 'Crédito ou débito no extrato de comissões'
  when p_action='commission_manual' then 'Comissão manual' when p_action='commission_delete' then 'Comissão excluída'
  when p_action='session_open' then 'Caixa aberto' when p_action='session_save' then 'Caixa alterado' when p_action='session_close' then 'Caixa fechado'
  when p_action='session_reopen' then 'Caixa reaberto' when p_action='session_move' then 'Sangria ou suprimento de caixa'
  when p_action='session_move_delete' then 'Sangria ou suprimento de caixa excluído' when p_action='session_delete' then 'Caixa excluído'
  when p_action='grouped_billing_generate' then 'Faturamento agrupado: contas geradas' when p_action='grouped_billing_delete' then 'Faturamento agrupado excluído'
  else 'Operação financeira' end
$$;

create or replace function erp_activity.entries(p_from timestamptz,p_to timestamptz)
returns table(source text,entry_id text,created_at timestamptz,actor uuid,module text,operation text,code text,description text)
language sql stable set search_path=pg_catalog as $$
 select 'catalog',a.id::text,a.created_at,a.actor,case a.entity when 'contacts' then 'clientes_fornecedores' when 'products' then 'produtos' else 'depositos' end,
  erp_activity.operation(a.action),r.code,left(r.name,200)
 from erp_catalog.audit a join erp_catalog.record r on r.id=a.record_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'documents',a.id::text,a.created_at,a.actor,erp_activity.kind_module(d.kind),erp_activity.operation(a.action),d.number::text,
  left(erp_activity.kind_label(d.kind)||' nº '||d.number||coalesce(' · '||nullif(btrim(a.reason),''),''),200)
 from erp_documents.audit a join erp_documents.document d on d.id=a.document_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'finance',a.id::text,a.created_at,a.actor,erp_activity.finance_module(a.action),erp_activity.operation(a.action),null,erp_activity.finance_label(a.action)
 from erp_finance.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'stock',m.id::text,m.created_at,m.actor,'estoque',case m.kind when 'transfer' then 'transferencia' when 'reversal' then 'estorno' else 'lancamento' end,m.reference,left(m.reason,200)
 from erp_stock.movement m where m.created_at>=p_from and m.created_at<p_to
 union all
 select 'cnab',a.id::text,a.created_at,a.actor,'cobranca','lancamento',null,'Cobrança bancária'
 from erp_cnab.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'fiscal_drafts',a.id::text,a.created_at,a.actor,'notas_fiscais',erp_activity.operation(a.action),null,
  'Rascunho de '||case d.model when '65' then 'NFC-e' else 'NF-e' end||' (homologação)'
 from erp_fiscal_drafts.audit a join erp_fiscal_drafts.draft d on d.id=a.draft_id where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'company',a.id::text,a.created_at,a.actor,'empresa','atualizacao',null,
  left(case a.action when 'save_extra' then 'Dados complementares da empresa' when 'save_partners' then 'Dados do sócio(s)' when 'confirm_fiscal' then 'Regime tributário confirmado'
   when 'clear_fiscal_confirmation' then 'Confirmação do regime tributário retirada' when 'fiscal_reset_identity_changed' then 'Regime tributário a confirmar (CNPJ alterado)'
   else 'Dados da empresa'||coalesce(' · dados bloqueados corrigidos: '||(a.after_data->>'motivo'),'') end,200)
 from erp_company.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'attachments',a.id::text,a.created_at,a.actor,'anexos',erp_activity.operation(a.action),null,left('Anexo '||t.filename,200)
 from erp_attachments.audit a join erp_attachments.attachment t on t.id=a.attachment_id where a.action in('finalize','abort') and a.created_at>=p_from and a.created_at<p_to
 union all
 select 'preferences',a.id::text,a.created_at,a.actor,'preferencias','atualizacao',a.key,'Preferência alterada'
 from erp_preferences.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'list_preferences',a.id::text,a.created_at,a.actor,'preferencias','atualizacao',a.list_id,'Listagem customizada'
 from erp_list_preferences.audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'home',a.id::text,a.created_at,a.actor,'pagina_inicial','atualizacao',null,case when a.after_data?'charts' then 'Gráficos da página inicial' else 'Atalhos favoritos' end
 from erp_home.shortcut_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 229: tipo, horários e permissões (a linha guarda user_type, schedule e permissions) têm a própria descrição.
 select 'users',a.id::text,a.created_at,a.actor,'usuarios',
  case when(a.before_data->>'active')::boolean and not(a.after_data->>'active')::boolean then 'exclusao'
   when a.before_data->>'role' is null and(a.after_data->>'active')::boolean then 'criacao' else 'atualizacao' end,
  null,left(case when a.after_data?'schedule' then 'Tipo, horários e permissões do usuário ' else 'Usuário ' end||erp_activity.actor_label(a.target),200)
 from erp_access.user_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'frameworks',a.id::text,a.created_at,a.actor,'preferencias',
  case when a.action like '%create' then 'criacao' when a.action like '%delete' then 'exclusao' else 'atualizacao' end,left(a.target,120),
  case a.area when 'situations' then case when a.action like 'transition%' then 'Transição de situação' else 'Situação personalizada' end
   when 'tags' then case when a.action like 'tag_group%' then 'Grupo de tags' else 'Tag' end when 'reports' then 'Relatório customizado' else 'Etiqueta customizada' end
 from erp_preferences.framework_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 119: categorias de produtos, grupos de produtos, grupos de tags e tags; 153: as tags de Contatos ficam em Contato.
 select 'taxonomy',a.id::text,a.created_at,a.actor,
  case when coalesce(t.tag_type,a.after_data->>'tag_type',a.before_data->>'tag_type')='contacts' then 'clientes_fornecedores' else 'produtos' end,erp_activity.operation(a.action),null,
  left(case a.kind when 'categories' then 'Categoria de produtos' when 'product_groups' then 'Grupo de produtos' when 'tag_groups' then 'Grupo de tags' else 'Tag' end
   ||coalesce(' '||coalesce(t.name,a.after_data->>'name',a.before_data->>'name'),''),200)
 from erp_catalog.taxonomy_audit a left join erp_catalog.taxonomy t on t.id=a.item_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 121: listas de preços (Produto).
 select 'pricing',a.id::text,a.created_at,a.actor,'produtos',erp_activity.operation(a.action),null,
  left('Lista de preços'||coalesce(' '||coalesce(l.name,a.after_data->>'name',a.before_data->>'name'),'')||case a.action when 'items' then ' · produtos' when 'adjust' then ' · reajuste' else '' end,200)
 from erp_pricing.audit a left join erp_pricing.price_list l on l.id=a.list_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 124-128: tipos de contatos, próximo código, comentários, importação, exportação e (158) etiquetas, vendedores e
 -- funcionários (Contato) e formas de pagamento (Contas a Pagar/Receber).
 select 'auxiliary',a.id::text,a.created_at,a.actor,case a.subject when 'payment_method' then 'financas' else 'clientes_fornecedores' end,
  case when a.subject='contacts_export' then 'envio' when a.subject='contact_import' then 'criacao' when a.action='next_number' then 'atualizacao' when a.action='default' then 'atualizacao'
   else erp_activity.operation(a.action) end,
  case when a.subject in('seller','contact_comment') then (select left(r.code,120) from erp_catalog.record r where r.id=case a.subject when 'seller' then s.contact_id else erp_activity.uuid_or_null(a.after_data->>'contact_id') end) end,
  left(case a.subject
   when 'contact_type' then 'Tipo de contato'||coalesce(' '||coalesce(a.after_data->>'label',a.before_data->>'label'),'')
   when 'contact_code' then 'Próximo código de contato'||coalesce(': '||(a.after_data->>'next_number'),'')
   when 'contact_comment' then 'Comentário no contato'||coalesce(' '||(select r.name from erp_catalog.record r where r.id=erp_activity.uuid_or_null(a.after_data->>'contact_id')),'')
   when 'contacts_export' then case when a.action='labels' then 'Etiquetas de contatos' else 'Exportação de contatos' end||coalesce(' ('||(a.after_data->>'total')||')','')
   when 'contact_import' then 'Importação de contatos'||coalesce(' ('||(a.after_data->>'rows')||' linhas)','')
   when 'seller' then 'Vendedor'||coalesce(' '||(select r.name from erp_catalog.record r where r.id=s.contact_id),'')
   when 'payment_method' then 'Forma de pagamento'||coalesce(' '||coalesce(pm.description,a.after_data->>'description',a.before_data->>'description'),'')
   when 'employee' then 'Funcionário'||coalesce(' '||e.name,'')
   else 'Cadastro auxiliar de contatos' end,200)
 from erp_catalog.auxiliary_audit a
  left join erp_catalog.seller s on a.subject='seller' and s.id=a.subject_id
  left join erp_catalog.payment_method pm on a.subject='payment_method' and pm.id=a.subject_id
  left join erp_catalog.employee e on a.subject='employee' and e.id=a.subject_id
 where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 129: próximo número de cada documento (módulo do documento).
 select 'numbering',n.id::text,n.created_at,n.actor,erp_activity.kind_module(n.kind),'atualizacao',(n.after_last+1)::text,
  left('Próximo número: '||erp_activity.kind_label(n.kind)||' nº '||(n.after_last+1),200)
 from erp_documents.numbering_audit n where n.created_at>=p_from and n.created_at<p_to
 union all
 -- 111-143: notas fiscais, eventos (cancelamento, carta de correção, inutilização), naturezas de operação e impostos.
 select 'fiscal_invoices',a.id::text,a.created_at,a.actor,'notas_fiscais',
  case when a.action='cancel' then 'atualizacao_situacao' else erp_activity.operation(a.action) end,
  case when a.scope='invoice' then i.number::text end,
  left(case a.scope
   when 'invoice' then coalesce(case i.model when '65' then 'NFC-e' else 'NF-e' end,'Nota fiscal')||coalesce(' nº '||i.number,'')||coalesce(' série '||i.series,'')
    ||case a.action when 'link_order' then ' · pedido vinculado' when 'unlink_order' then ' · pedido desvinculado' when 'import' then ' · importada do XML' when 'reconcile' then ' · conciliada' else '' end
   when 'event' then case a.action when 'cancel' then 'Cancelamento de nota fiscal' when 'correction' then 'Carta de correção' when 'inutilization' then 'Inutilização de numeração' else 'Evento de nota fiscal' end
   when 'nature' then case when a.action='confirm_review' then 'Revisão das naturezas de operação' else 'Natureza de operação'||coalesce(' '||nullif(btrim(a.reason),''),'') end
   when 'tax_settings' then 'Configurações de impostos'
   else 'Notas fiscais' end,200)
 from erp_fiscal_invoices.audit a left join erp_fiscal_invoices.invoice i on a.scope='invoice' and i.id=a.entity_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 041: certificado A1 (custódia no servidor). Tentativas recusadas não mudam nada e não entram.
 select 'a1',a.id::text,a.created_at,a.actor,'certificado_digital',erp_activity.operation(a.action),null,
  case a.action when 'configure' then 'Certificado A1 configurado' when 'rewrap' then 'Certificado A1 protegido novamente' when 'disable' then 'Certificado A1 desativado' else 'Certificado A1' end
 from erp_a1.audit a where a.action<>'reject' and a.created_at>=p_from and a.created_at<p_to
 union all
 -- 106: conferência de estoque (depósito escolhido, reinício e balanço); as leituras uma a uma não entram.
 select 'stock_count',c.id::text,c.created_at,c.actor,'estoque',case c.action when 'balance' then 'lancamento' else 'atualizacao' end,null,
  case c.action when 'balance' then 'Balanço da conferência de estoque' when 'restart' then 'Conferência de estoque reiniciada' else 'Depósito da conferência de estoque' end
  ||coalesce(' · '||(select left(r.name,120) from erp_catalog.record r where r.id=s.warehouse_id),'')
 from erp_stock.count_command c join erp_stock.count_session s on s.id=c.session_id where c.action in('warehouse','restart','balance') and c.created_at>=p_from and c.created_at<p_to
 union all
 -- 105: depósito padrão e "Desconsiderar saldo deste depósito" (Depósitos).
 select 'warehouse_settings',w.id::text,w.created_at,w.actor,'depositos','atualizacao',r.code,
  left(case w.action when 'default' then 'Depósito padrão' else 'Saldo do depósito considerado ou desconsiderado' end||coalesce(' · '||r.name,''),200)
 from erp_stock.warehouse_command w left join erp_catalog.record r on r.id=w.warehouse_id where w.created_at>=p_from and w.created_at<p_to
 union all
 -- 147: check-in de recebimentos (Estoque): o primeiro comando de uma nota cria o check-in; Finalizar muda a situação.
 select 'checkin',c.id::text,c.created_at,c.actor,'estoque',
  case when c.action='finish' then 'atualizacao_situacao'
   when not exists(select 1 from erp_stock.checkin_command p where p.invoice_id=c.invoice_id and(p.created_at,p.id)<(c.created_at,c.id)) then 'criacao' else 'atualizacao' end,
  i.number::text,
  left('Check-in de recebimento'||coalesce(' da nota nº '||i.number,'')||case c.action when 'finish' then ' · finalizado' when 'restart' then ' · reiniciado' else '' end,200)
 from erp_stock.checkin_command c left join erp_fiscal_invoices.invoice i on i.id=c.invoice_id where c.created_at>=p_from and c.created_at<p_to
 union all
 -- 150: metas de Meu Negócio.
 select 'goals',g.id::text,g.created_at,g.actor,'meu_negocio',
  case when g.before_data is null then 'criacao' when(g.before_data->>'active')::boolean is distinct from(g.after_data->>'active')::boolean then 'atualizacao_situacao' else 'atualizacao' end,
  null,left('Meta'||coalesce(' '||(g.after_data->>'name'),''),200)
 from erp_home.goal_audit g where g.created_at>=p_from and g.created_at<p_to
 union all
 -- 156: campos customizados (Campos Customizados), com as categorias do Agrupador.
 select 'custom_fields',a.id::text,a.created_at,a.actor,'campos_customizados',case a.action when 'create' then 'criacao' when 'delete' then 'exclusao' else 'atualizacao' end,null,
  left('Campo customizado'||coalesce(' '||coalesce(c.name,a.after_data->>'name',a.before_data->>'name'),'')||case a.action when 'categories' then ' · categorias' else '' end,200)
 from erp_catalog.custom_field_audit a left join erp_catalog.custom_field c on c.id=a.field_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 170: anexos e foto do contato (Contato): concluído e excluído.
 select 'contact_files',a.id::text,a.created_at,a.actor,'clientes_fornecedores',case a.action when 'finalize' then 'criacao' else 'exclusao' end,r.code,
  left(case c.purpose when 'photo' then 'Foto do contato' else 'Anexo do contato' end||coalesce(' '||r.name,'')||' · '||c.filename,200)
 from erp_attachments.contact_file_audit a join erp_attachments.contact_file c on c.id=a.file_id left join erp_catalog.record r on r.id=c.contact_id
 where a.action in('finalize','delete') and a.created_at>=p_from and a.created_at<p_to
 union all
 -- 228: importações de planilhas (uma linha por importação, no módulo do que foi importado).
 select 'imports',j.id::text,j.created_at,j.actor,
  case j.kind when 'products' then 'produtos' when 'contacts' then 'clientes_fornecedores' when 'purchase_orders' then 'pedidos_compra' when 'stock_movements' then 'estoque'
   when 'sales_orders' then 'pedidos_venda' when 'nfe' then 'notas_fiscais' else 'financas' end,'criacao',null,
  left('Importação de planilha de '||case j.kind when 'products' then 'produtos' when 'contacts' then 'contatos' when 'purchase_orders' then 'pedidos de compra'
   when 'stock_movements' then 'movimentações de estoque' when 'receivables' then 'contas a receber' when 'payables' then 'contas a pagar' when 'sales_orders' then 'pedidos de venda'
   else 'notas fiscais' end||' · '||j.file_name||' ('||j.total_rows||' linhas)',200)
 from erp_preferences.import_job j where j.created_at>=p_from and j.created_at<p_to
$$;
revoke all on function erp_activity.entries(timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.erp_activity_list(p_user_id uuid,p_from date,p_to date,p_module text,p_operation text,p_actor uuid,p_query text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_range tstzrange; v_q text; v_total integer; v_items jsonb;
begin
 perform erp_activity.require_admin(p_user_id);
 v_range:=erp_activity.period(p_from,p_to);
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_module is not null and p_module not in('campos_customizados','certificado_digital','caixa','comissao','financas','clientes_fornecedores','estoque','cobranca','notas_fiscais','ordens_servico',
   'pagamento_recebimento','pedidos_compra','pedidos_venda','produtos','propostas','anexos','depositos','documentos','empresa','meu_negocio','pagina_inicial','preferencias','usuarios')
  or p_operation is not null and p_operation not in('atualizacao','atualizacao_situacao','criacao','envio','estorno','exclusao','lancamento','transferencia')
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with found as materialized(
  select e.* from erp_activity.entries(lower(v_range),upper(v_range)) e
  where(p_module is null or e.module=p_module) and(p_operation is null or e.operation=p_operation) and(p_actor is null or e.actor=p_actor)
   and(v_q is null or strpos(lower(coalesce(e.code,'')),v_q)>0 or strpos(lower(coalesce(e.description,'')),v_q)>0)
 )
 select(select count(*) from found),(select coalesce(jsonb_agg(jsonb_build_object('source',x.source,'id',x.entry_id,'created_at',x.created_at,'actor',jsonb_build_object('user_id',x.actor,'label',erp_activity.actor_label(x.actor)),
   'module',x.module,'operation',x.operation,'code',erp_activity.clean(x.code,120),'description',erp_activity.clean(x.description,200)) order by x.created_at desc,x.source,x.entry_id),'[]'::jsonb)
  from(select * from found order by created_at desc,source,entry_id limit p_limit offset p_offset) x) into v_total,v_items;
 return jsonb_build_object('scope','activity','data_mode','erp_native','from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'module',p_module,'operation',p_operation,
  'actor',p_actor,'query',v_q,'limit',p_limit,'offset',p_offset,'total',v_total,'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items);
end $$;

-- Antes e depois (administrador). Origens sem esse dado respondem available=false; acima de 200 mil bytes, truncated=true.
create or replace function public.erp_activity_detail(p_user_id uuid,p_source text,p_entry_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_id bigint;v_before jsonb;v_after jsonb;v_found boolean:=false;v_size integer;
begin
 perform erp_activity.require_admin(p_user_id);
 if p_source is null or p_source not in('catalog','documents','finance','stock','cnab','fiscal_drafts','company','attachments','preferences','list_preferences','home','users','frameworks',
   'taxonomy','pricing','auxiliary','numbering','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','goals','custom_fields','contact_files','imports')
   or p_entry_id is null or p_entry_id!~'^[0-9a-f-]{1,40}$' then
  raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 if p_source in('stock','cnab','fiscal_drafts','attachments','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','contact_files','imports') then
  return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',false,'truncated',false,'before',null,'after',null);
 end if;
 if p_entry_id!~'^[1-9][0-9]{0,17}$' then raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 v_id:=p_entry_id::bigint;
 case p_source
  when 'catalog' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.audit a where a.id=v_id;
  when 'documents' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_documents.audit a where a.id=v_id;
  when 'finance' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_finance.audit a where a.id=v_id;
  when 'company' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_company.audit a where a.id=v_id;
  when 'preferences' then select true,jsonb_build_object(a.key,a.before_value),jsonb_build_object(a.key,a.after_value) into v_found,v_before,v_after from erp_preferences.audit a where a.id=v_id;
  when 'list_preferences' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_list_preferences.audit a where a.id=v_id;
  when 'home' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_home.shortcut_audit a where a.id=v_id;
  when 'users' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_access.user_audit a where a.id=v_id;
  when 'taxonomy' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.taxonomy_audit a where a.id=v_id;
  when 'pricing' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_pricing.audit a where a.id=v_id;
  when 'auxiliary' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.auxiliary_audit a where a.id=v_id;
  when 'numbering' then select true,jsonb_build_object('proximo_numero',n.before_last+1),jsonb_build_object('proximo_numero',n.after_last+1) into v_found,v_before,v_after from erp_documents.numbering_audit n where n.id=v_id;
  when 'goals' then select true,g.before_data,g.after_data into v_found,v_before,v_after from erp_home.goal_audit g where g.id=v_id;
  when 'custom_fields' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.custom_field_audit a where a.id=v_id;
  else select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_preferences.framework_audit a where a.id=v_id;
 end case;
 if not coalesce(v_found,false) then raise exception 'erp_activity_entry_not_found' using errcode='P0002'; end if;
 v_size:=coalesce(octet_length(v_before::text),0)+coalesce(octet_length(v_after::text),0);
 return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',true,'truncated',v_size>200000,
  'before',case when v_size>200000 then null else v_before end,'after',case when v_size>200000 then null else v_after end);
end $$;

revoke all on all functions in schema erp_activity from public,anon,authenticated,service_role;
revoke all on function public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function public.erp_activity_detail(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer) to service_role;
grant execute on function public.erp_activity_detail(uuid,text,text) to service_role;
commit;
