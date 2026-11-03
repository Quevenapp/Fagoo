-- 283: Preferências, Sistema e Meu Negócio na frente mista da onda F.
-- * Registro de atividades com as auditorias da onda E das outras frentes: as tags (Marcadores) das notas fiscais do Brufap e das
--   espelhadas do Origin (236, módulo Notas Fiscais, com antes e depois no detalhe); os lotes (258, Estoque: incluir, editar, "Excluir
--   lote", reativar e o "Novo lote" criado num lançamento); o Lançar estoque, o Estornar estoque e o "Lançar estoque ao finalizar
--   Check-in" das notas fiscais (259, Notas Fiscais; o movimento também entra em Estoque); as contas lançadas e estornadas pelas notas
--   (247) e as contas devolvidas (281, Atualização de situação) com a própria descrição.
-- * Central de Notificações: "Lote próximo ao vencimento" (Origin), um aviso por dia com os lotes com saldo (depósitos considerados) de
--   produtos ativos cuja Data de validade vence de hoje até hoje + "Número de dias antes da data de validade" (Preferências › Cadastros ›
--   Controle de lotes), lidos de erp_stock.lots_expiring (258); para quem consulta o estoque. Sem destinatários escolhidos, os
--   administradores recebem, como nas outras notificações.
-- * Página inicial: o resumo do estoque deixa de fora os depósitos com "Desconsiderar saldo deste depósito" (105), como a coluna Estoque
--   dos produtos (234).
-- * Etiquetas customizadas: o formato de código DATA MATRIX (ECC 200, gerado no navegador, sem biblioteca e sem rede).
-- * Importações de Dados: a importação de produtos (preço e pesos) e a de fornecedores de produtos (custo do fornecedor padrão)
--   recalculam as composições que usam o produto quando "Atualizar preço de custo / peso / preço de venda das composições com base nos
--   componentes" (222) está ligada, como o formulário, o reajuste de preços e a formação de preços da nota (235).
-- Substitui erp_activity.operation, finance_label (232), entries e erp_activity_detail (263), erp_home.notification_roles,
-- notification_types e notification_digest (187), erp_home_summary (021), erp_preferences.label_check (231), import_item e
-- import_item_e (265), conferidas pelo hash; qualquer outra versão interrompe a migração. Requer 236, 247, 258, 259 e 281.
begin;

do $$declare v record;begin
 for v in select * from(values('erp_activity.operation(text)','7280e282ba9c05565973c58208c6d1bef9d1d85976361c863eb61c1f500b3849'),
  ('erp_activity.finance_label(text)','fc724c5f8d211c206abbb67c1e09339db7e240609caa43d4312999b809209ac5'),
  ('erp_activity.entries(timestamptz,timestamptz)','5373886affe331c9e175b14227b3cfb44d88453ab6755dfa2002341fd97e2a38'),
  ('public.erp_activity_detail(uuid,text,text)','6ffc8d3f8e6ef2757b84ea070fb9719080cef3143f6a6495b92be52787cf6d9f'),
  ('erp_home.notification_roles(text)','20d75bf6ca938886218ee7c742097fb125b94ea7ac8ee6ad507c802a92f712eb'),
  ('erp_home.notification_types()','36499ef2875b4c93715971e1d72a23bc63a96e0a106ec367a567849ec2ec65db'),
  ('erp_home.notification_digest(text,date)','47cc5f1b43276cf81c1e7111bd54b930824cd84650e3af022ca10289179e8d47'),
  ('public.erp_home_summary(uuid)','6364b92c509a91c37b2e30362d1bb84b7ddfd7d3008a13ab4ec92666dbac11f5'),
  ('erp_preferences.label_check(text,jsonb)','533df0b4fdc93d2267851f4b6595626f7dd27068732b3d7139b714f65b6a0f1b'),
  ('erp_preferences.import_item(uuid,text,uuid,text,jsonb)','4e5c2503fc7cc84ed2ec205fbc22cd2f125b63129c382cff504bdc93c7d92a41'),
  ('erp_preferences.import_item_e(uuid,text,uuid,jsonb)','6e80403aaaf76b56a7556e8bf155afc70b1124772ad991b6e15a16e5bb5820e9')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'preferences_283_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
 if to_regclass('erp_catalog.invoice_tag_audit') is null or to_regclass('erp_stock.lot_command') is null or to_regclass('erp_stock.invoice_command') is null
  or to_regclass('erp_finance.title_return') is null or to_regprocedure('erp_stock.lots_expiring(date,date)') is null
  or to_regprocedure('erp_catalog.composition_sync(uuid,uuid,uuid[])') is null then
  raise exception 'preferences_283_requires_236_258_259_281' using errcode='55000';end if;
end$$;

-- ---- Registro de atividades ----
create or replace function erp_activity.operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case
  when p_action in('purchase_receive','commission_payment','commission_entry','session_move') then 'lancamento'
  when p_action in('commission_manual','session_open','grouped_billing_generate') then 'criacao'
  when p_action in('session_close','session_reopen','title_returned') then 'atualizacao_situacao'
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
  -- 283: contas of the notas fiscais (247) and the Devolvido of a devolução (281).
  when p_action='invoice_post' then 'Contas lançadas pela nota fiscal' when p_action='invoice_reverse' then 'Contas estornadas da nota fiscal'
  when p_action='title_returned' then 'Contas devolvidas (situação Devolvido)'
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
 -- 263: remessas e retornos (Geração de cobranças) com a operação de cada comando; a baixa pelo retorno é Pagamento/Recebimento.
 select 'cnab',a.id::text,a.created_at,a.actor,erp_activity.cnab_module(a.action),erp_activity.cnab_operation(a.action),r.sequence::text,erp_activity.cnab_label(a.action)
 from erp_cnab.audit a left join erp_cnab.remittance r on r.id=a.record_id where a.created_at>=p_from and a.created_at<p_to
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
 -- 170: a exclusão lógica de um anexo de documento (Excluir selecionados) também entra, como Exclusão.
 select 'attachments',a.id::text,a.created_at,a.actor,'anexos',erp_activity.operation(a.action),null,
  left('Anexo '||t.filename||case a.action when 'delete' then ' · excluído' when 'abort' then ' · envio cancelado' else '' end,200)
 from erp_attachments.audit a join erp_attachments.attachment t on t.id=a.attachment_id where a.action in('finalize','abort','delete') and a.created_at>=p_from and a.created_at<p_to
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
   when 'sales_orders' then 'pedidos_venda' when 'nfe' then 'notas_fiscais' when 'compositions' then 'produtos' when 'product_suppliers' then 'produtos'
   when 'custom_fields' then 'campos_customizados' else 'financas' end,'criacao',null,
  left('Importação de planilha de '||case j.kind when 'products' then 'produtos' when 'contacts' then 'contatos' when 'purchase_orders' then 'pedidos de compra'
   when 'stock_movements' then 'movimentações de estoque' when 'receivables' then 'contas a receber' when 'payables' then 'contas a pagar' when 'sales_orders' then 'pedidos de venda'
   when 'compositions' then 'composições' when 'custom_fields' then 'campos customizados' when 'product_suppliers' then 'fornecedores de produtos'
   else 'notas fiscais' end||' · '||j.file_name||' ('||j.total_rows||' linhas)',200)
 from erp_preferences.import_job j where j.created_at>=p_from and j.created_at<p_to
 union all
 -- 204-206: Frente de caixa. Guardar, finalizar, cancelar, trocar a mesa e devolver uma venda (Frente de Caixa); as configurações
 -- e os favoritos ficam em Preferências. O pedido de venda e os lançamentos de estoque e contas também entram pelas próprias auditorias.
 select 'pos',a.id::text,a.created_at,a.actor,case when a.action like 'sale%' then 'frente_caixa' else 'preferencias' end,
  case a.action when 'sale_save' then case when a.before_data is null then 'criacao' else 'atualizacao' end
   when 'sale_finish' then case when a.before_data is null then 'criacao' else 'atualizacao_situacao' end
   when 'sale_cancel' then 'atualizacao_situacao' when 'sale_transfer' then 'transferencia' when 'sale_return' then 'estorno'
   when 'favorite_add' then 'criacao' when 'favorite_remove' then 'exclusao' else 'atualizacao' end,
  d.number::text,
  left(case a.action when 'settings_save' then 'Configurações da frente de caixa' when 'favorite_add' then 'Produto favorito da frente de caixa incluído'
   when 'favorite_remove' then 'Produto favorito da frente de caixa removido'
   else 'Venda'||coalesce(' nº '||d.number,'')||' na frente de caixa'||case a.action when 'sale_finish' then ' · finalizada' when 'sale_cancel' then ' · cancelada'
    when 'sale_transfer' then ' · comanda transferida de mesa' when 'sale_return' then ' · devolução' else ' · guardada' end end,200)
 from erp_pos.audit a left join erp_pos.sale s on s.id=a.sale_id left join erp_documents.document d on d.id=s.document_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 222: estrutura das composições (Produto). A primeira gravação da estrutura é Criação; as seguintes e a atualização dos valores
 -- pelos componentes (Preferências › Configurações de produtos) são Atualização.
 select 'compositions',c.id::text,c.created_at,c.actor,'produtos',
  case when c.action='save' and not exists(select 1 from erp_stock.composition_command p where p.product_id=c.product_id and p.action='save' and(p.created_at,p.id)<(c.created_at,c.id)) then 'criacao' else 'atualizacao' end,
  left(r.code,120),left('Estrutura da composição'||coalesce(' '||r.name,'')||case c.action when 'sync' then ' · valores atualizados pelos componentes' else '' end,200)
 from erp_stock.composition_command c left join erp_catalog.record r on r.id=c.product_id where c.created_at>=p_from and c.created_at<p_to
 union all
 -- 193: imagens armazenadas do produto (Produto): imagem concluída, excluída e a ordem das imagens. Reservas e envios cancelados não entram.
 select 'product_images',a.id::text,a.created_at,a.actor,'produtos',case a.action when 'finalize' then 'criacao' when 'delete' then 'exclusao' else 'atualizacao' end,
  left(r.code,120),left(case a.action when 'order' then 'Ordem das imagens do produto' else 'Imagem do produto' end||coalesce(' '||r.name,'')||coalesce(' · '||i.filename,''),200)
 from erp_catalog.product_image_audit a left join erp_catalog.product_stored_image i on i.id=a.image_id left join erp_catalog.record r on r.id=a.product_id
 where a.action in('finalize','delete','order') and a.created_at>=p_from and a.created_at<p_to
 union all
 -- 211: anexos das contas (Contas a Pagar/Receber) e dos lançamentos de Caixas e bancos (Caixa): concluído e excluído.
 select 'finance_files',a.id::text,a.created_at,a.actor,case f.owner_kind when 'cash_entry' then 'caixa' else 'financas' end,case a.action when 'finalize' then 'criacao' else 'exclusao' end,null,
  left(case f.owner_kind when 'cash_entry' then 'Anexo do lançamento de caixa' else 'Anexo da conta' end||coalesce(' '||coalesce(t.description,e.note),'')||' · '||f.filename,200)
 from erp_finance.file_audit a join erp_finance.file f on f.id=a.file_id left join erp_finance.title t on t.id=f.title_id left join erp_finance.cash_entry e on e.id=f.cash_entry_id
 where a.action in('finalize','delete') and a.created_at>=p_from and a.created_at<p_to
 union all
 -- 262: logo da empresa (Dados da empresa): enviado, substituído por um novo e removido.
 select 'company_logo',a.id::text,a.created_at,a.actor,'empresa',case a.action when 'finalize' then 'atualizacao' else 'exclusao' end,null,
  case when a.action='finalize' then 'Logo da empresa enviado' when a.command_id is null then 'Logo anterior da empresa substituído' else 'Logo da empresa removido' end
 from erp_company.logo_audit a where a.action in('finalize','delete') and a.created_at>=p_from and a.created_at<p_to
 union all
 -- 199: assinatura das propostas de cada usuário (Propostas Comerciais).
 select 'user_signatures',a.id::text,a.created_at,a.user_id,'propostas',case when a.before_data is null then 'criacao' else 'atualizacao' end,null,'Assinatura das propostas do usuário'
 from erp_documents.user_signature_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 236: tags (Marcadores) das notas fiscais do Brufap e das espelhadas do Origin (Notas Fiscais), com antes e depois no detalhe.
 select 'invoice_tags',a.id::text,a.created_at,a.actor,'notas_fiscais',case a.action when 'tag_removed' then 'exclusao' else 'atualizacao' end,
  coalesce(i.number::text,(select left(n.payload->>'numero',20) from origin_sync.raw_record n where a.origin='origin' and n.entity=case a.model when '65' then 'nfce' else 'nfe' end and n.source_id=a.invoice_id)),
  left(case a.action when 'tags_added' then 'Tags incluídas' when 'tag_removed' then 'Tag excluída' else 'Tags alteradas' end||' na '||case a.model when '65' then 'NFC-e' else 'NF-e' end
   ||coalesce(' nº '||coalesce(i.number::text,(select left(n.payload->>'numero',20) from origin_sync.raw_record n where a.origin='origin' and n.entity=case a.model when '65' then 'nfce' else 'nfe' end and n.source_id=a.invoice_id)),'')
   ||case a.origin when 'origin' then ' (Origin)' else '' end,200)
 from erp_catalog.invoice_tag_audit a left join erp_fiscal_invoices.invoice i on a.origin='brufap' and i.id::text=a.invoice_id where a.created_at>=p_from and a.created_at<p_to
 union all
 -- 258: lotes (Estoque): incluir e editar um lote, "Excluir lote" (inativa) e reativar; o "Novo lote" criado num lançamento. O lançamento
 -- com lote entra pelo próprio movimento de estoque. "Informar lotes de produtos" de um lançamento gravado (ação "assign", que a frente de
 -- estoque acrescenta na onda F) é Atualização, com a própria descrição.
 select 'lots',c.id::text,c.created_at,c.actor,'estoque',
  case when c.action='save' and(c.result->>'created')::boolean then 'criacao' when c.action='launch' then 'criacao'
   when c.action='status' and(c.result#>>'{lot,active}')::boolean then 'atualizacao_situacao' when c.action='status' then 'exclusao' else 'atualizacao' end,
  left(r.code,120),
  left(case when c.action='assign' then 'Lotes informados no lançamento de estoque'||coalesce(' do produto '||r.name,'')
   else 'Lote '||coalesce(l.code,'')||coalesce(' do produto '||r.name,'')||case when c.action='launch' then ' · criado no lançamento de estoque'
   when c.action='status' and(c.result#>>'{lot,active}')::boolean then ' · reativado' when c.action='status' then ' · excluído' else '' end end,200)
 from erp_stock.lot_command c left join erp_stock.lot l on l.id=c.lot_id left join erp_catalog.record r on r.id=c.product_id
 where(c.action<>'launch' or(c.result#>>'{lot,created}')::boolean) and c.created_at>=p_from and c.created_at<p_to
 union all
 -- 259: Lançar estoque e Estornar estoque pela nota fiscal e "Lançar estoque ao finalizar Check-in" (Notas Fiscais); o movimento
 -- também entra em Estoque.
 select 'invoice_stock',c.id::text,c.created_at,c.actor,'notas_fiscais',case c.action when 'reverse' then 'estorno' else 'lancamento' end,i.number::text,
  left(case c.action when 'reverse' then 'Estoque estornado da ' else 'Estoque lançado pela ' end||case i.model when '65' then 'NFC-e' else 'NF-e' end||coalesce(' nº '||i.number,'')
   ||case c.action when 'checkin' then ' · ao finalizar o check-in' else '' end,200)
 from erp_stock.invoice_command c left join erp_fiscal_invoices.invoice i on i.id=c.invoice_id where c.created_at>=p_from and c.created_at<p_to
$$;
revoke all on function erp_activity.entries(timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.erp_activity_detail(p_user_id uuid,p_source text,p_entry_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_id bigint;v_before jsonb;v_after jsonb;v_found boolean:=false;v_size integer;
begin
 perform erp_activity.require_admin(p_user_id);
 if p_source is null or p_source not in('catalog','documents','finance','stock','cnab','fiscal_drafts','company','attachments','preferences','list_preferences','home','users','frameworks',
   'taxonomy','pricing','auxiliary','numbering','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','goals','custom_fields','contact_files','imports',
   'pos','compositions','product_images','finance_files','company_logo','user_signatures','invoice_tags','lots','invoice_stock')
   or p_entry_id is null or p_entry_id!~'^[0-9a-f-]{1,40}$' then
  raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 if p_source in('stock','cnab','fiscal_drafts','attachments','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','contact_files','imports',
   'compositions','product_images','finance_files','company_logo','lots','invoice_stock') then
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
  when 'pos' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_pos.audit a where a.id=v_id;
  when 'user_signatures' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_documents.user_signature_audit a where a.id=v_id;
  when 'invoice_tags' then select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_catalog.invoice_tag_audit a where a.id=v_id;
  else select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_preferences.framework_audit a where a.id=v_id;
 end case;
 if not coalesce(v_found,false) then raise exception 'erp_activity_entry_not_found' using errcode='P0002'; end if;
 v_size:=coalesce(octet_length(v_before::text),0)+coalesce(octet_length(v_after::text),0);
 return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',true,'truncated',v_size>200000,
  'before',case when v_size>200000 then null else v_before end,'after',case when v_size>200000 then null else v_after end);
end $$;

-- ---- Central de Notificações: Lote próximo ao vencimento ----
-- BEGIN GENERATED DEFINITIONS (tools/preferences/generate-definitions.mjs)
insert into erp_preferences.definition(key,page_id,section,ordinal,kind,options,default_value,min_value,max_value,scale,max_length,max_items,format)values
 ('notificacoes.lote_vencimento','central-notificacoes','notificacoes',12,'users',null,'[]'::jsonb,null,null,null,null,100,null);
-- END GENERATED DEFINITIONS

do $$declare c text;begin
 for c in select conname from pg_constraint where conrelid='erp_home.notification'::regclass and contype='c' and pg_get_constraintdef(oid) like '%contas_pagar_atrasadas%' loop
  execute format('alter table erp_home.notification drop constraint %I',c);
 end loop;
end$$;
alter table erp_home.notification add constraint notification_type_check check(type in('contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado',
 'pagamento_efetuado','pagamento_recebido','proximo_contato','cliente_visitado','validade','certificado_a1','lote_vencimento'));

-- "Número de dias antes da data de validade" of the lots (0 to 9999; an unreadable value counts as 0).
create function erp_home.lot_expiry_days() returns integer language sql stable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='number' and(v#>>'{}')~'^[0-9]{1,4}$' then(v#>>'{}')::integer else 0 end from(select erp_preferences.get('lotes.dias_aviso_validade') v) x
$$;
create or replace function erp_home.notification_roles(p_type text) returns text[] language sql immutable set search_path=pg_catalog as $$
 select case when p_type in('contas_pagar_atrasadas','contas_receber_atrasadas','pagamento_efetuado','pagamento_recebido') then array['admin','consulta','financeiro']
  when p_type in('estoque_abaixo_minimo','estoque_maximo','estoque_zerado','validade','lote_vencimento') then array['admin','consulta','vendas','estoque','fiscal']
  when p_type='proximo_contato' then array['admin','consulta','financeiro','vendas']
  when p_type='cliente_visitado' then array['admin','consulta','vendas','financeiro','estoque','fiscal']
  when p_type='certificado_a1' then array['admin','fiscal'] else array[]::text[] end
$$;
create or replace function erp_home.notification_types() returns text[] language sql immutable set search_path=pg_catalog as $$
 select array['contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado','pagamento_efetuado','pagamento_recebido','proximo_contato',
  'cliente_visitado','validade','certificado_a1','lote_vencimento']
$$;
create or replace function erp_home.notification_digest(p_type text,p_today date) returns table(quantity integer,amount numeric) language sql stable set search_path=pg_catalog as $$
 select count(*)::integer,round(sum(t.amount_cents-t.settled_cents)/100.0,2) from erp_finance.title t
  where p_type in('contas_pagar_atrasadas','contas_receber_atrasadas') and t.kind=case p_type when 'contas_pagar_atrasadas' then 'payable' else 'receivable' end
   and not t.cancelled and t.due_on<p_today and t.amount_cents>t.settled_cents
 union all
 select count(*)::integer,round(sum(s.principal_cents)/100.0,2) from erp_finance.settlement s join erp_finance.title t on t.id=s.title_id
  where p_type in('pagamento_efetuado','pagamento_recebido') and t.kind=case p_type when 'pagamento_efetuado' then 'payable' else 'receivable' end
   and s.kind='payment' and s.posted_on=p_today and not exists(select 1 from erp_finance.settlement r where r.reverses_id=s.id)
 union all
 select count(*)::integer,null from(select p.record_id,p.stock_min,p.stock_max,erp_stock.count_physical(p.record_id,null) stock,exists(select 1 from erp_stock.balance b where b.product_id=p.record_id) positioned
   from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where r.active and coalesce(p.kind,'P')='P') x
  where p_type='estoque_abaixo_minimo' and x.stock_min is not null and x.stock<x.stock_min
   or p_type='estoque_maximo' and x.stock_max is not null and x.stock_max>0 and x.stock>=x.stock_max
   or p_type='estoque_zerado' and x.positioned and x.stock<=0
 union all
 select count(*)::integer,null from erp_documents.document d
  where p_type='proximo_contato' and d.kind='sales_proposals' and d.status not in('completed','cancelled','rejected') and d.body->>'next_contact'=to_char(p_today,'YYYY-MM-DD')
 union all
 select count(*)::integer,null from erp_catalog.contact_profile cp join erp_catalog.record r on r.id=cp.record_id
  where p_type='cliente_visitado' and r.active and cp.next_visit=p_today
 union all
 select count(*)::integer,null from erp_home.expiring_products(p_today,p_today+erp_home.expiry_days()) x where p_type='validade'
 union all
 -- 283: Lote próximo ao vencimento: the lots with stock (considered warehouses) of active products whose Data de validade falls from today
 -- to today + "Número de dias antes da data de validade" (Preferências › Cadastros › Controle de lotes), from the stock lane (258).
 select count(*)::integer,null from erp_stock.lots_expiring(p_today,p_today+erp_home.lot_expiry_days()) x where p_type='lote_vencimento'
 union all
 -- The A1 in custody (erp_a1.head, metadata validated by 041) that ends within 30 days of today, or already ended.
 select count(*)::integer,null from erp_a1.head h join erp_a1.credential c on c.id=h.credential_id
  where p_type='certificado_a1' and h.singleton and(c.metadata->>'not_after')::timestamptz<((p_today+31)::timestamp at time zone 'America/Sao_Paulo')
$$;

-- ---- Página inicial: resumo sem os depósitos desconsiderados ----
create or replace function public.erp_home_summary(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_role text; v_today date := (statement_timestamp() at time zone 'America/Sao_Paulo')::date;
  v_catalog jsonb; v_documents jsonb; v_stock jsonb := null; v_finance jsonb := null;
begin
  select role into v_role from erp_access.membership where user_id=p_user_id and active;
  if not found then raise exception 'erp_home_access_denied' using errcode='42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('entity',e,'active',
    (select count(*) from erp_catalog.record r where r.entity=e and r.active),
    'archived',(select count(*) from erp_catalog.record r where r.entity=e and not r.active)) order by e),'[]'::jsonb)
    into v_catalog from unnest(array['contacts','products','warehouses']) e where erp_catalog.allowed(v_role,e,false);

  select coalesce(jsonb_agg(jsonb_build_object('kind',k,'count',
    (select count(*) from erp_documents.document d where d.kind=k),
    'statuses',(select coalesce(jsonb_agg(jsonb_build_object('status',s,'count',
      (select count(*) from erp_documents.document d where d.kind=k and d.status=s)) order by s),'[]'::jsonb)
      from jsonb_object_keys(erp_documents.transitions()->k) s)) order by k),'[]'::jsonb)
    into v_documents from unnest(array['sales_proposals','sales_orders','purchase_orders','service_orders']) k
    where erp_documents.allowed(v_role,k,false);

  if v_role in ('admin','consulta','estoque','vendas','fiscal') then
    select jsonb_build_object('positions',count(*),'positive_positions',count(*) filter(where quantity>0),
      'zero_positions',count(*) filter(where quantity=0),'products',count(distinct product_id),
      'warehouses',count(distinct warehouse_id)) into v_stock from erp_stock.balance
     -- 283: "Desconsiderar saldo deste depósito" (105) leaves the warehouse out of the summary, as of the product totals (234).
     where not erp_stock.ignored_warehouse(warehouse_id);
  end if;

  if v_role in ('admin','financeiro','consulta') then
    select jsonb_build_object('titles',(select jsonb_agg(jsonb_build_object('kind',k,
      'buckets',(select jsonb_agg(jsonb_build_object('bucket',bucket,'count',counted,'balance_cents',balance) order by ordinal)
      from (select b.bucket,b.ordinal,count(t.id) counted,coalesce(sum(t.amount_cents-t.settled_cents),0)::text balance
        from (values ('overdue',1),('today',2),('next_7_days',3),('later',4)) b(bucket,ordinal)
        left join erp_finance.title t on t.kind=k and not t.cancelled and t.amount_cents>t.settled_cents
          and case b.bucket when 'overdue' then t.due_on<v_today when 'today' then t.due_on=v_today
            when 'next_7_days' then t.due_on>v_today and t.due_on<=v_today+7 else t.due_on>v_today+7 end
        group by b.bucket,b.ordinal) buckets)) order by k) from unnest(array['receivable','payable']) k),
      'accounts',jsonb_build_object('active',(select count(*) from erp_finance.account where active),
        'archived',(select count(*) from erp_finance.account where not active),
        'opening_pending',(select count(*) from erp_finance.account where active and not opening_recorded),
        'recorded_balance_cents',(select coalesce(sum(delta_cents),0)::text from erp_finance.movement))) into v_finance;
  end if;
  return jsonb_build_object('data_mode','erp_native','as_of',statement_timestamp(),'business_date',v_today,
    'timezone','America/Sao_Paulo','role',v_role,'catalog',v_catalog,'documents',v_documents,'stock',v_stock,'finance',v_finance);
end $$;

-- ---- Etiquetas customizadas: DATA MATRIX ----
create or replace function erp_preferences.label_check(p_type text,p_config jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare l jsonb:=p_config->'label';g jsonb:=p_config->'page';f jsonb;v_width numeric;v_height numeric;v_fields text[]:=erp_preferences.label_fields(p_type);
begin
 if v_fields is null or not erp_preferences.framework_keys(p_config,array['fields','label','page'])
  or not erp_preferences.framework_keys(l,array['barcode','barcode_text','columns_gap','currency','font','font_size','height','rows_gap','show_labels','width'])
  or not erp_preferences.framework_keys(g,array['height','margin_left','margin_top','orientation','size','width'])
  or jsonb_typeof(l->'font')<>'string' or l->>'font' not in('helvetica','courier','monospace','times')
  or jsonb_typeof(l->'barcode')<>'string' or l->>'barcode' not in('c128','ean13','upca','msi','upce','c93','qr','datamatrix')
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

-- ---- Importações de Dados: composições dos componentes importados ----
create or replace function erp_preferences.import_item_e(p_user_id uuid,p_kind text,p_command uuid,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_res jsonb; v_items jsonb:='[]'::jsonb; v_item jsonb; v_comp integer; v_format text; v_ids uuid[]; v_field erp_catalog.custom_field%rowtype;
 v_values jsonb:='{}'::jsonb; v_supplier uuid; v_list jsonb; v_entry jsonb; v_old jsonb; v_post text; v_found boolean:=false; v_default boolean; v_kits uuid[]:='{}';
begin
 if p_kind='compositions' then
  -- Estrutura of one composição: the product (Código) becomes "Com composição" and its structure is replaced by the sheet's.
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  select p.format into v_format from erp_catalog.product p where p.record_id=v_id;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_items:=v_items||jsonb_build_array(jsonb_build_object('component_id',erp_preferences.import_product(v_item->>'code','item_code',true),'quantity',v_item->>'quantity'));
  end loop;
  v_post:=coalesce(p_data->>'post_mode',case when p_data->>'stock_type'='virtual' then 'components' end);
  if v_post is null then perform erp_preferences.import_fail('erp_preferences_import_required:post_mode'); end if;
  if p_data->>'stock_type'='virtual' and v_post<>'components' then perform erp_preferences.import_fail('erp_preferences_import_invalid:post_mode'); end if;
  select c.version into v_comp from erp_stock.composition c where c.product_id=v_id;
  -- The product save inside needs a patch: the format "Com composição" (unchanged when it already is).
  v_res:=public.erp_stock_product_compose(p_user_id,v_id,v_version,p_command,jsonb_build_object('format','E'),null,
   jsonb_build_object('expected_version',coalesce(v_comp,0),'stock_type',p_data->>'stock_type','post_mode',v_post,'items',v_items));
  return jsonb_build_object('action',case when v_comp is null then 'create' else 'update' end,'record_id',v_id,
   'reference',left('Composição '||(p_data->>'code')||' · '||jsonb_array_length(v_items)||' componente(s)',120),'unchanged',false);
 elsif p_kind='custom_fields' then
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   select array_agg(f.id order by f.id) into v_ids from erp_catalog.custom_field f where f.module='products' and lower(f.name)=lower(btrim(v_item->>'field'));
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:item_field'); end if;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:item_field'); end if;
   if v_values?(v_ids[1]::text) then perform erp_preferences.import_fail('erp_preferences_import_duplicate:item_field'); end if;
   select * into v_field from erp_catalog.custom_field where id=v_ids[1];
   v_values:=v_values||jsonb_build_object(v_field.id::text,erp_preferences.import_custom_value(v_field,v_item->>'value'));
  end loop;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,jsonb_build_object('custom_values',v_values),null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind='product_suppliers' then
  v_id:=erp_preferences.import_product(p_data->>'code','code',true);
  v_supplier:=erp_preferences.import_contact(p_data->>'supplier_name',p_data->>'supplier_document','supplier_name','supplier_document');
  select r.version into v_version from erp_catalog.record r where r.id=v_id;
  -- The current list as the product form sends it; the sheet line updates the filled columns of its supplier or adds it.
  select coalesce(jsonb_agg(jsonb_build_object('supplier_id',s.supplier_id,'description',s.description,'code',s.code,'purchase_price',erp_catalog.unit_price_numeric(s.purchase_price,14),
   'cost_price',erp_catalog.unit_price_numeric(s.cost_price,14),'warranty_months',s.warranty_months::text,'is_default',s.is_default) order by s.position),'[]'::jsonb) into v_old
   from erp_catalog.product_supplier s where s.record_id=v_id;
  v_default:=case when p_data?'is_default' then (p_data->>'is_default')::boolean end;
  v_list:='[]'::jsonb;
  for v_entry in select x from jsonb_array_elements(v_old) x loop
   if(v_entry->>'supplier_id')::uuid=v_supplier then
    v_found:=true;
    v_entry:=v_entry||jsonb_strip_nulls(jsonb_build_object('code',p_data->'supplier_code','description',p_data->'description','purchase_price',p_data->'purchase_price',
     'cost_price',p_data->'cost_price','warranty_months',p_data->'warranty_months'))||case when v_default is not null then jsonb_build_object('is_default',v_default) else '{}'::jsonb end;
   elsif v_default then v_entry:=v_entry||jsonb_build_object('is_default',false);
   end if;
   v_list:=v_list||jsonb_build_array(v_entry);
  end loop;
  if not v_found then
   v_list:=v_list||jsonb_build_array(jsonb_build_object('supplier_id',v_supplier,'description',p_data->'description','code',p_data->'supplier_code','purchase_price',p_data->'purchase_price',
    'cost_price',p_data->'cost_price','warranty_months',p_data->'warranty_months','is_default',coalesce(v_default,jsonb_array_length(v_old)=0)));
  end if;
  if v_found and v_list=v_old then
   return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',true);
  end if;
  -- 283: the cost of the default supplier of a component recalculates the compositions that use it (as the product form, 222/235).
  if erp_catalog.composition_sync_on() then
   v_kits:=erp_catalog.composition_kits(array[v_id]);
   if cardinality(v_kits)>0 then perform 1 from erp_catalog.record where id=v_id or id=any(v_kits) order by id for update; end if;
  end if;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,jsonb_build_object('suppliers',v_list),null);
  if cardinality(v_kits)>0 and(v_res#>>'{record,version}')::integer<>v_version then perform erp_catalog.composition_sync(p_user_id,p_command,erp_catalog.composition_kits(array[v_id])); end if;
  return jsonb_build_object('action',case when v_found then 'update' else 'create' end,'record_id',v_id,
   'reference',left((p_data->>'code')||' · '||coalesce(p_data->>'supplier_name',p_data->>'supplier_document'),120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 end if;
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;
create or replace function erp_preferences.import_item(p_user_id uuid,p_kind text,p_command uuid,p_file text,p_data jsonb) returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_id uuid; v_version integer; v_patch jsonb; v_res jsonb; v_origin text; v_items jsonb:='[]'::jsonb; v_item jsonb; v_product uuid; v_line integer:=0;
 v_body jsonb; v_wh uuid; v_qty numeric; v_balance numeric; v_bversion integer; v_kind text; v_cents bigint; v_reason text; v_doc text; v_ids uuid[];
 v_contact erp_catalog.contact%rowtype; v_profile erp_catalog.contact_profile%rowtype; v_nature erp_fiscal_invoices.nature%rowtype; v_crt text; v_series text; v_person text; v_name text; v_text text;
 v_kits uuid[]:='{}';
begin
 if p_kind='products' then
  if p_data?'code' then v_id:=erp_preferences.import_product(p_data->>'code','code',false); end if;
  v_patch:=p_data-'category'-'product_group';
  if p_data?'category' then v_patch:=v_patch||jsonb_build_object('category_id',erp_preferences.import_named('categories',p_data->>'category','category')); end if;
  if p_data?'product_group' then v_patch:=v_patch||jsonb_build_object('product_group_id',erp_preferences.import_named('product_groups',p_data->>'product_group','product_group')); end if;
  if v_id is null then
   -- Preferências › Configurações de produtos: "Origem padrão de tributação de produtos" fills a new product without Origem.
   v_origin:=erp_preferences.get('produtos.origem_padrao')#>>'{}';
   if not v_patch?'origin' and v_origin~'^[0-8]$' then v_patch:=v_patch||jsonb_build_object('origin',v_origin); end if;
   v_res:=public.erp_catalog_product_save(p_user_id,null,0,p_command,v_patch,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_patch:=v_patch-'code';
  if v_patch='{}'::jsonb then return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',true); end if;
  -- 283: with "Atualizar preço de custo / peso / preço de venda das composições com base nos componentes" (222), the compositions that use
  -- the product follow its new price and weights, each with the derived command, the version and the audit of the composition (235). Lock
  -- order of 235: the product and the compositions, by UUID, before the first write.
  if v_patch ?| array['price','net_weight','gross_weight'] and erp_catalog.composition_sync_on() then
   v_kits:=erp_catalog.composition_kits(array[v_id]);
   if cardinality(v_kits)>0 then perform 1 from erp_catalog.record where id=v_id or id=any(v_kits) order by id for update; end if;
  end if;
  v_res:=public.erp_catalog_product_save(p_user_id,v_id,v_version,p_command,v_patch,null);
  if cardinality(v_kits)>0 and(v_res#>>'{record,version}')::integer<>v_version then perform erp_catalog.composition_sync(p_user_id,p_command,erp_catalog.composition_kits(array[v_id])); end if;
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(p_data->>'code',120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind='contacts' then
  v_doc:=nullif(erp_catalog.compact(p_data->>'document'),'');
  if v_doc is not null then
   select array_agg(r.id order by r.id) into v_ids from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id left join erp_catalog.contact_profile p on p.record_id=r.id
    where r.entity='contacts' and coalesce(p.situation,'A')<>'E' and erp_catalog.compact(c.document)=v_doc;
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:document'); end if;
   v_id:=v_ids[1];
  end if;
  if v_id is null then
   v_res:=public.erp_catalog_contact_save(p_user_id,null,0,p_command,p_data,null);
   return jsonb_build_object('action','create','record_id',v_res#>>'{record,id}','reference',left(coalesce(v_res#>>'{record,code}',v_res#>>'{record,name}'),120),'unchanged',false);
  end if;
  select version into v_version from erp_catalog.record where id=v_id;
  v_res:=public.erp_catalog_contact_save(p_user_id,v_id,v_version,p_command,p_data,null);
  return jsonb_build_object('action','update','record_id',v_id,'reference',left(coalesce(v_res#>>'{record,name}',v_doc),120),'unchanged',(v_res#>>'{record,version}')::integer=v_version);
 elsif p_kind in('purchase_orders','sales_orders') then
  v_body:=jsonb_build_object('date',p_data->'date','contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'));
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_line:=v_line+1; v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('product_id',v_product,
    'description',coalesce(v_item->>'description',(select r.name from erp_catalog.record r where r.id=v_product)),
    'code',case when v_product is not null then (select r.code from erp_catalog.record r where r.id=v_product) end,
    'unit',coalesce(v_item->>'unit',(select p.unit from erp_catalog.product p where p.record_id=v_product),'UN'),
    'quantity',v_item->'quantity',
    'unit_price',coalesce(v_item->>'unit_price',(select erp_catalog.unit_price_numeric(p.price,10) from erp_catalog.product p where p.record_id=v_product and p.price is not null),'0'),
    'discount_percent',v_item->'discount_percent')));
  end loop;
  v_body:=v_body||jsonb_build_object('items',v_items)||jsonb_strip_nulls(jsonb_build_object('expected_date',p_data->'expected_date','freight',p_data->'freight',
   'notes',p_data->'notes','internal_notes',p_data->'internal_notes'));
  v_res:=public.erp_document_save(p_user_id,p_kind,null,0,p_command,v_body);
  return jsonb_build_object('action','create','record_id',v_res#>>'{document,id}','reference',left('nº '||(v_res#>>'{document,number}')||' (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind='stock_movements' then
  v_product:=erp_preferences.import_product(p_data->>'code','code',true);
  if p_data?'warehouse' then v_wh:=erp_preferences.import_named('warehouses',p_data->>'warehouse','warehouse');
  else select warehouse_id into v_wh from erp_stock.warehouse_default; if v_wh is null then perform erp_preferences.import_fail('erp_preferences_import_required:warehouse'); end if; end if;
  select b.quantity,b.version into v_balance,v_bversion from erp_stock.balance b where b.product_id=v_product and b.warehouse_id=v_wh;
  v_balance:=coalesce(v_balance,0); v_bversion:=coalesce(v_bversion,0); v_qty:=(p_data->>'quantity')::numeric;
  if p_data->>'movement' in('receipt','issue') and v_qty<=0 then perform erp_preferences.import_fail('erp_preferences_import_invalid:quantity'); end if;
  v_kind:=case p_data->>'movement' when 'balance' then 'adjustment' else p_data->>'movement' end;
  v_qty:=case p_data->>'movement' when 'receipt' then v_qty when 'issue' then -v_qty else v_qty-v_balance end;
  if v_qty=0 then return jsonb_build_object('action','update','record_id',null,'reference','Saldo já igual à quantidade','unchanged',true); end if;
  v_reason:=coalesce(nullif(btrim(p_data->>'note'),''),'Importação de movimentações de estoque');
  if length(v_reason)<3 then v_reason:='Importação: '||v_reason; end if;
  v_res:=public.erp_stock_post(p_user_id,p_command,v_kind,coalesce((p_data->>'date')::date,(clock_timestamp() at time zone 'America/Sao_Paulo')::date),v_reason,
   jsonb_build_array(jsonb_build_object('product_id',v_product,'warehouse_id',v_wh,'quantity',v_qty::numeric(18,6)::text,'expected_version',v_bversion)),left('Importação '||p_file,100));
  return jsonb_build_object('action','create','record_id',v_res#>>'{movement,id}','reference',left(case v_kind when 'receipt' then 'Entrada' when 'issue' then 'Saída' else 'Balanço' end||' '||(v_qty::numeric(18,6))::text,120),'unchanged',false);
 elsif p_kind='nfe' then
  -- Notas fiscais em lote: a rascunho de NF-e de saída in homologation, the same input the notas screen sends (recipient from
  -- the cadastro, items with the product NCM/CEST/GTIN/origem, Cálculo automático). Number and SEFAZ stay with the emission steps.
  -- Preferências › Empresa: the tax regime must be confirmed before any note.
  select f.crt into v_crt from erp_company.fiscal f where f.singleton;
  if v_crt is null then perform erp_preferences.import_fail('erp_preferences_import_company_regime'); end if;
  v_id:=erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document');
  select * into v_contact from erp_catalog.contact where record_id=v_id;
  select * into v_profile from erp_catalog.contact_profile where record_id=v_id;
  select r.name into v_name from erp_catalog.record r where r.id=v_id;
  v_doc:=nullif(erp_catalog.compact(v_contact.document),'');
  v_person:=coalesce(nullif(v_contact.person_type,''),case length(v_doc) when 14 then 'J' when 11 then 'F' end);
  if p_data?'nature' then
   select array_agg(n.id order by n.id) into v_ids from erp_fiscal_invoices.nature n
    where n.direction='1' and n.active and n.deleted_at is null and lower(btrim(n.description))=lower(btrim(p_data->>'nature'));
   if cardinality(v_ids)>1 then perform erp_preferences.import_fail('erp_preferences_import_ambiguous:nature'); end if;
   if v_ids is null then perform erp_preferences.import_fail('erp_preferences_import_not_found:nature'); end if;
   select * into v_nature from erp_fiscal_invoices.nature where id=v_ids[1];
  else
   select n.* into v_nature from erp_fiscal_invoices.nature_default d join erp_fiscal_invoices.nature n on n.id=d.nature_id
    where n.active and n.deleted_at is null and d.code=any(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end)
    order by array_position(case v_person when 'F' then array['VF','S'] when 'J' then array['VJ','S'] else array['S'] end,d.code) limit 1;
   if v_nature.id is null then perform erp_preferences.import_fail('erp_preferences_import_required:nature'); end if;
  end if;
  v_series:=v_nature.series::text;
  if v_series is null and to_regclass('erp_fiscal_numbering.series') is not null then
   execute 'select series::text from erp_fiscal_numbering.series where model=''55'' and environment=''2'' and enabled order by series limit 1' into v_series;
  end if;
  for v_item in select x from jsonb_array_elements(p_data->'items') x loop
   v_product:=null;
   if v_item?'code' then v_product:=erp_preferences.import_product(v_item->>'code','item_code',true); end if;
   v_items:=v_items||jsonb_build_array(jsonb_strip_nulls((select jsonb_build_object('product_id',v_product,'code',left(r.code,60),
     'description',left(coalesce(v_item->>'description',r.name),120),'unit',left(coalesce(v_item->>'unit',p.unit,'UN'),6),'quantity',v_item->'quantity',
     'unit_price',coalesce(v_item->>'unit_price',erp_catalog.unit_price_numeric(p.price,10),'0'),
     'ncm',case when p.ncm~'^[0-9]{8}$' then p.ncm end,'cest',case when p.cest~'^[0-9]{7}$' then p.cest end,
     'gtin',case when p.gtin~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin end,'gtin_tax',case when p.gtin_tax~'^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$' then p.gtin_tax end,
     'icms',case when p.origin~'^[0-8]$' then jsonb_build_object('origin',p.origin) end)
    from(select 1) one left join erp_catalog.record r on r.id=v_product left join erp_catalog.product p on p.record_id=v_product)));
  end loop;
  v_text:=nullif(regexp_replace(coalesce(v_contact.ie,''),'[^0-9]','','g'),'');
  v_body:=jsonb_build_object('model','55','direction','1','issue_type','N','series',coalesce(v_series,'1'),'nature_id',v_nature.id,
   'issue_date',coalesce(p_data->>'date',to_char((clock_timestamp() at time zone 'America/Sao_Paulo')::date,'YYYY-MM-DD')),'crt',v_crt,'purpose','1',
   'presence',coalesce(v_nature.presence,'1'),'final_consumer',coalesce(v_nature.final_consumer,false),'auto_tax',true,'items',v_items,
   'recipient',jsonb_strip_nulls(jsonb_build_object('contact_id',v_id,'name',left(v_name,60),'person_type',v_person,
    'document',case when v_person in('F','J') and length(v_doc) in(11,14) then v_doc end,
    'ie',case when length(v_text) between 2 and 14 then v_text when upper(btrim(v_contact.ie))='ISENTO' then 'ISENTO' end,
    'ie_indicator',case when v_profile.taxpayer in('1','2','9') then v_profile.taxpayer end,
    'email',case when left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60)~'^[^[:space:]@]+@[^[:space:]@]+$' then left(coalesce(nullif(v_profile.nfe_email,''),v_contact.email),60) end,
    'postal_code',case when regexp_replace(coalesce(v_contact.postal_code,''),'[^0-9]','','g')~'^[0-9]{8}$' then regexp_replace(v_contact.postal_code,'[^0-9]','','g') end,
    'street',nullif(left(v_contact.street,60),''),'number',nullif(left(v_contact.number,60),''),'complement',nullif(left(v_contact.complement,60),''),
    'district',nullif(left(v_contact.district,60),''),'city',nullif(left(v_contact.city,60),''),
    'state',case when upper(v_contact.state) in('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO') then upper(v_contact.state) end)))
   ||jsonb_strip_nulls(jsonb_build_object('additional_info',p_data->'notes'));
  v_res:=public.erp_fiscal_invoice_execute(p_user_id,p_command,'create',jsonb_build_object('invoice',v_body));
  return jsonb_build_object('action','create','record_id',v_res#>>'{invoice,id}','reference',left('Rascunho de NF-e (planilha '||(p_data->>'number')||')',120),'unchanged',false);
 elsif p_kind in('receivables','payables') then
  v_kind:=case p_kind when 'receivables' then 'receivable' else 'payable' end;
  v_cents:=((p_data->>'amount')::numeric*100)::bigint;
  v_res:=public.erp_finance_title_execute(p_user_id,p_command,'title_create',jsonb_strip_nulls(jsonb_build_object('kind',v_kind,
   'contact_id',erp_preferences.import_contact(p_data->>'contact_name',p_data->>'contact_document','contact_name','contact_document'),
   'category_id',erp_preferences.import_named('finance_categories',p_data->>'category','category',v_kind),
   'account_id',erp_preferences.import_named('accounts',p_data->>'account','account'),
   'payment_method_id',erp_preferences.import_named('payment_methods',p_data->>'payment_method','payment_method',v_kind),
   'description',p_data->'description','source_reference',p_data->'source_reference','issued_on',p_data->'issued_on','competence_on',coalesce(p_data->'competence_on',p_data->'issued_on'),
   'total_cents',v_cents::text,'installments',jsonb_build_array(jsonb_build_object('amount_cents',v_cents::text,'due_on',p_data->'due_on')))));
  return jsonb_build_object('action','create','record_id',v_res#>>'{items,0,id}','reference',left(p_data->>'description',120),'unchanged',false);
 end if;
 -- 265: composições, campos customizados and fornecedores de produtos (erp_preferences.import_item_e).
 if p_kind in('compositions','custom_fields','product_suppliers') then return erp_preferences.import_item_e(p_user_id,p_kind,p_command,p_data); end if;
 perform erp_preferences.import_fail('erp_preferences_import_kind_invalid');
 return null;
end $$;

revoke all on all functions in schema erp_activity from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_home from public,anon,authenticated,service_role;
revoke all on function erp_preferences.label_check(text,jsonb),erp_preferences.import_item(uuid,text,uuid,text,jsonb),erp_preferences.import_item_e(uuid,text,uuid,jsonb)
 from public,anon,authenticated,service_role;
-- The public RPCs replaced here keep only the service role.
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('erp_activity_detail','erp_home_summary')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
