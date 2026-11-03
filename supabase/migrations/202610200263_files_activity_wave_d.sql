-- 263: Gerenciador de arquivos e Registro de atividades com as auditorias da onda D das outras frentes.
-- * Correção: erp_files_list (118) listava os anexos de documentos excluídos logicamente desde a 170 (a linha continua "pronta",
--   com deleted_at preenchido). A função passa a omitir os excluídos, com o mesmo contrato.
-- * Gerenciador de arquivos (Origin anexos.gerenciador.php), erp_files_list_v2: todos os arquivos prontos e não excluídos da
--   empresa, com a origem de cada um (anexos dos documentos, anexos e foto dos contatos, anexos das contas e dos lançamentos de
--   caixa, imagens armazenadas dos produtos e o logo da empresa), pesquisa, período, ordenação (Data, Nome, Tamanho) e o filtro
--   de origem. Baixar e excluir continuam pelas rotas autenticadas de cada módulo, que conferem as permissões de cada um.
-- * Registro de atividades: Frente de caixa (204-206: venda guardada, finalizada, cancelada, comanda trocada de mesa e devolução,
--   no módulo novo "Frente de Caixa"; configurações e favoritos em Preferências), estrutura das composições (222, Produto),
--   imagens armazenadas dos produtos (193, Produto), anexos das contas e dos lançamentos de caixa (211, erp_finance.file_audit),
--   remessas e retornos de cobrança com a operação de cada comando (gerar, reservar, excluir remessa e retorno; a baixa pelo
--   retorno fica em Pagamento/Recebimento), a exclusão de anexos de documentos (170), o logo da empresa (262) e a assinatura das
--   propostas (199). Antes e depois no detalhe para a Frente de caixa e a assinatura.
-- Substitui erp_files_list (118), erp_activity.entries, erp_activity_list e erp_activity_detail (232), conferidas pelo hash;
-- qualquer outra versão interrompe a migração. Nenhuma tabela nova e nenhuma escrita. Requer 262.
begin;

do $$declare v record;begin
 for v in select * from(values('public.erp_files_list(uuid,text,date,date,text,integer,integer)','bfdd4a2a82c01dd9a9283e6db79d79d76c4cb445ff674fcfcecd93aa01da36c8'),
  ('erp_activity.entries(timestamptz,timestamptz)','a85c29f2b4df2c55347f8141ba53168af5d50aa6b27a275c452b0c5a1bd39cb4'),
  ('public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer)','7990fcab6765057178f6d90185aee36675858707d418870cf425e82714f7af81'),
  ('public.erp_activity_detail(uuid,text,text)','4d167090ee0f0bb0d44758ecf14b525dfff0843a9b473576a8717d2e91109bec')) x(sig,hash) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex') from pg_proc where oid=to_regprocedure(v.sig)) is distinct from v.hash then
   raise exception 'activity_263_previous_definition_changed %',v.sig using errcode='55000';end if;
 end loop;
 if to_regclass('erp_company.logo_audit') is null or to_regclass('erp_pos.audit') is null or to_regclass('erp_finance.file_audit') is null
  or to_regclass('erp_stock.composition_command') is null or to_regclass('erp_catalog.product_image_audit') is null then
  raise exception 'activity_263_requires_262_and_wave_d' using errcode='55000';end if;
end$$;

-- Remessas e retornos (erp_cnab.audit) in the Origin terms of each command.
create function erp_activity.cnab_module(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_action like '%settle' then 'pagamento_recebimento' else 'cobranca' end
$$;
create function erp_activity.cnab_operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_action like '%exclude' then 'exclusao' when p_action in('reserve','operational_reserve','operational_reserve_v2') then 'criacao'
  when p_action in('finalize','operational_finalize','operational_finalize_v2') then 'envio'
  when p_action in('return_commit','operational_return') or p_action like '%settle' then 'lancamento' else 'atualizacao' end
$$;
create function erp_activity.cnab_label(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case when p_action='profile_save' then 'Configuração da cobrança bancária'
  when p_action in('approve','operational_approve','operational_approve_v2') then 'Configuração da cobrança bancária aprovada'
  when p_action in('human_review','operational_bind') then 'Conferência de ocorrência do retorno'
  when p_action in('reserve','operational_reserve','operational_reserve_v2') then 'Remessa de cobrança reservada'
  when p_action in('finalize','operational_finalize','operational_finalize_v2') then 'Arquivo de remessa gerado'
  when p_action='remittance_exclude' then 'Remessa excluída'
  when p_action in('return_commit','operational_return') then 'Arquivo de retorno importado'
  when p_action='return_exclude' then 'Retorno excluído'
  when p_action like '%settle' then 'Baixa pelo retorno de cobrança'
  else 'Cobrança bancária' end
$$;

create or replace function public.erp_files_list(p_user_id uuid,p_query text,p_from date,p_to date,p_order text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_range tstzrange; v_q text; v_total integer; v_bytes bigint; v_items jsonb;
begin
 perform erp_activity.require_admin(p_user_id);
 v_range:=case when p_from is null and p_to is null then null else erp_activity.period(p_from,p_to) end;
 if(p_from is null)<>(p_to is null) or p_order is null or p_order not in('data','nome','tamanho') or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with files as materialized(
  select a.id,a.filename,a.mime_type,a.size_bytes,a.sha256,a.actor,coalesce(a.finished_at,a.created_at) at_time,d.kind,d.id document_id,d.number
  from erp_attachments.attachment a join erp_documents.document d on d.id=a.document_id
  where a.status='ready' and a.deleted_at is null and(v_range is null or coalesce(a.finished_at,a.created_at)<@v_range) and(v_q is null or strpos(lower(a.filename),v_q)>0)
 )
 select(select count(*) from files),(select coalesce(sum(size_bytes),0) from files),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'filename',x.filename,'mime_type',x.mime_type,'size_bytes',x.size_bytes,'sha256',x.sha256,
   'created_at',x.at_time,'owner',jsonb_build_object('user_id',x.actor,'label',erp_activity.actor_label(x.actor)),'document',jsonb_build_object('kind',x.kind,'id',x.document_id,'number',x.number::text))
   order by case when p_order='nome' then lower(x.filename) end,case when p_order='tamanho' then x.size_bytes end desc,x.at_time desc,x.id),'[]'::jsonb)
  from(select * from files order by case when p_order='nome' then lower(filename) end,case when p_order='tamanho' then size_bytes end desc,at_time desc,id limit p_limit offset p_offset) x) into v_total,v_bytes,v_items;
 return jsonb_build_object('scope','files','data_mode','erp_native','query',v_q,'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'order',p_order,'limit',p_limit,'offset',p_offset,
  'total',v_total,'total_bytes',v_bytes::text,'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items);
end $$;

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
$$;
revoke all on function erp_activity.entries(timestamptz,timestamptz) from public,anon,authenticated,service_role;

create or replace function public.erp_activity_list(p_user_id uuid,p_from date,p_to date,p_module text,p_operation text,p_actor uuid,p_query text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_range tstzrange; v_q text; v_total integer; v_items jsonb;
begin
 perform erp_activity.require_admin(p_user_id);
 v_range:=erp_activity.period(p_from,p_to);
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_module is not null and p_module not in('campos_customizados','certificado_digital','caixa','comissao','financas','clientes_fornecedores','estoque','frente_caixa','cobranca','notas_fiscais','ordens_servico',
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

create or replace function public.erp_activity_detail(p_user_id uuid,p_source text,p_entry_id text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_id bigint;v_before jsonb;v_after jsonb;v_found boolean:=false;v_size integer;
begin
 perform erp_activity.require_admin(p_user_id);
 if p_source is null or p_source not in('catalog','documents','finance','stock','cnab','fiscal_drafts','company','attachments','preferences','list_preferences','home','users','frameworks',
   'taxonomy','pricing','auxiliary','numbering','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','goals','custom_fields','contact_files','imports',
   'pos','compositions','product_images','finance_files','company_logo','user_signatures')
   or p_entry_id is null or p_entry_id!~'^[0-9a-f-]{1,40}$' then
  raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 if p_source in('stock','cnab','fiscal_drafts','attachments','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','contact_files','imports',
   'compositions','product_images','finance_files','company_logo') then
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
  else select true,a.before_data,a.after_data into v_found,v_before,v_after from erp_preferences.framework_audit a where a.id=v_id;
 end case;
 if not coalesce(v_found,false) then raise exception 'erp_activity_entry_not_found' using errcode='P0002'; end if;
 v_size:=coalesce(octet_length(v_before::text),0)+coalesce(octet_length(v_after::text),0);
 return jsonb_build_object('scope','activity_detail','data_mode','erp_native','source',p_source,'id',p_entry_id,'available',true,'truncated',v_size>200000,
  'before',case when v_size>200000 then null else v_before end,'after',case when v_size>200000 then null else v_after end);
end $$;

-- Gerenciador de arquivos: every ready, non-deleted file of the company with its origin. Administrador only (as 118); the screen
-- downloads and deletes through the route of each origin, which checks the permissions of its module again.
create function public.erp_files_list_v2(p_user_id uuid,p_query text,p_from date,p_to date,p_order text,p_origin text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_range tstzrange; v_q text; v_total integer; v_bytes bigint; v_items jsonb;
begin
 perform erp_activity.require_admin(p_user_id);
 v_range:=case when p_from is null and p_to is null then null else erp_activity.period(p_from,p_to) end;
 if(p_from is null)<>(p_to is null) or p_order is null or p_order not in('data','nome','tamanho')
  or p_origin is not null and p_origin not in('documentos','contatos','financeiro','produtos','empresa')
  or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_query is not null and(length(p_query)>120 or p_query~'[\x01-\x1f\x7f]') then raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 v_q:=nullif(lower(btrim(coalesce(p_query,''))),'');
 with files as materialized(
  select a.id,'documentos'::text origin,a.filename,a.mime_type,a.size_bytes,a.sha256,a.actor,coalesce(a.finished_at,a.created_at) at_time,
   d.kind source_kind,d.id source_id,d.number::text source_code,erp_activity.clean(d.contact_snapshot->>'name',200) source_label
  from erp_attachments.attachment a join erp_documents.document d on d.id=a.document_id
  where a.status='ready' and a.deleted_at is null and(p_origin is null or p_origin='documentos')
  union all
  select c.id,'contatos',c.filename,c.mime_type,c.size_bytes,c.sha256,c.actor,coalesce(c.finished_at,c.created_at),
   case c.purpose when 'photo' then 'contact_photo' else 'contact' end,c.contact_id,erp_activity.clean(r.code,120),erp_activity.clean(r.name,200)
  from erp_attachments.contact_file c join erp_catalog.record r on r.id=c.contact_id
  where c.status='ready' and c.deleted_at is null and(p_origin is null or p_origin='contatos')
  union all
  select f.id,'financeiro',f.filename,f.mime_type,f.size_bytes,f.sha256,f.actor,coalesce(f.finished_at,f.created_at),f.owner_kind,f.owner_id,null,
   erp_activity.clean(coalesce(t.description,e.note),200)
  from erp_finance.file f left join erp_finance.title t on t.id=f.title_id left join erp_finance.cash_entry e on e.id=f.cash_entry_id
  where f.status='ready' and f.deleted_at is null and(p_origin is null or p_origin='financeiro')
  union all
  select i.id,'produtos',i.filename,i.mime_type,i.size_bytes,i.sha256,i.actor,coalesce(i.finished_at,i.created_at),'product',i.product_id,erp_activity.clean(r.code,120),erp_activity.clean(r.name,200)
  from erp_catalog.product_stored_image i join erp_catalog.record r on r.id=i.product_id
  where i.status='ready' and i.deleted_at is null and(p_origin is null or p_origin='produtos')
  union all
  select l.id,'empresa','logo.'||case l.mime_type when 'image/png' then 'png' else 'jpg' end,l.mime_type,l.size_bytes,l.sha256,l.actor,coalesce(l.finished_at,l.created_at),'logo',l.id,null,'Logo da empresa'
  from erp_company.logo l where l.status='ready' and l.deleted_at is null and(p_origin is null or p_origin='empresa')
 ), picked as materialized(
  select * from files where(v_range is null or at_time<@v_range) and(v_q is null or strpos(lower(filename),v_q)>0)
 )
 select(select count(*) from picked),(select coalesce(sum(size_bytes),0) from picked),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'origin',x.origin,'filename',x.filename,
   'mime_type',x.mime_type,'size_bytes',x.size_bytes,'sha256',x.sha256,'created_at',x.at_time,'owner',jsonb_build_object('user_id',x.actor,'label',erp_activity.actor_label(x.actor)),
   'source',jsonb_build_object('kind',x.source_kind,'id',x.source_id,'code',x.source_code,'label',x.source_label))
   order by case when p_order='nome' then lower(x.filename) end,case when p_order='tamanho' then x.size_bytes end desc,x.at_time desc,x.id),'[]'::jsonb)
  from(select * from picked order by case when p_order='nome' then lower(filename) end,case when p_order='tamanho' then size_bytes end desc,at_time desc,id limit p_limit offset p_offset) x)
 into v_total,v_bytes,v_items;
 return jsonb_build_object('scope','files','data_mode','erp_native','query',v_q,'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'order',p_order,'origin',p_origin,
  'limit',p_limit,'offset',p_offset,'total',v_total,'total_bytes',v_bytes::text,'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items);
end $$;

revoke all on all functions in schema erp_activity from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_files_list(uuid,text,date,date,text,integer,integer)','erp_files_list_v2(uuid,text,date,date,text,text,integer,integer)',
  'erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer)','erp_activity_detail(uuid,text,text)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
