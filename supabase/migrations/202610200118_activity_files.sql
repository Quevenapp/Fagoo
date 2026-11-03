-- Sistema > Registro de atividades, Consulta de exclusões realizadas e Gerenciador de arquivos no padrão do Origin, só de
-- leitura e só para administrador. O registro une as auditorias e lançamentos que o Brufap já grava (cadastros, documentos,
-- estoque, financeiro, cobrança, notas, empresa, preferências, usuários, anexos e página inicial) com módulo e operação nos
-- termos do Origin. Nada é apagado no Brufap: a consulta de exclusões mostra arquivamentos, desativações e anexos descartados.
-- O gerenciador lista os anexos prontos dos documentos; baixar continua pela rota autenticada do documento. Nenhuma tabela
-- nova e nenhuma escrita.
begin;

create schema erp_activity;
revoke all on schema erp_activity from public,anon,authenticated,service_role;
alter default privileges in schema erp_activity revoke all on functions from public,anon,authenticated,service_role;

create function erp_activity.require_admin(p_actor uuid) returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_actor is null or not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin') then
  raise exception 'erp_activity_access_denied' using errcode='42501'; end if;
end $$;
-- Name from Sistema > Usuários, else the account e-mail (plpgsql: auth.users columns are read at run time only).
create function erp_activity.actor_label(p_actor uuid) returns text language plpgsql stable set search_path=pg_catalog as $$
declare v text;
begin
 select coalesce(p.name,lower(u.email)) into v from auth.users u left join erp_access.profile p on p.user_id=u.id where u.id=p_actor;
 return left(coalesce(v,'Usuário '||left(p_actor::text,8)),200);
end $$;
-- Audit texts come from many modules (some accept line breaks); the screen gets one line and a bounded length.
create function erp_activity.clean(p_text text,p_max integer) returns text language sql immutable set search_path=pg_catalog as $$
 select left(regexp_replace(p_text,'[[:cntrl:]]',' ','g'),p_max)
$$;
create function erp_activity.kind_module(p_kind text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_proposals' then 'propostas' when 'sales_orders' then 'pedidos_venda' when 'purchase_orders' then 'pedidos_compra' when 'service_orders' then 'ordens_servico' else 'documentos' end
$$;
create function erp_activity.kind_label(p_kind text) returns text language sql immutable set search_path=pg_catalog as $$
 select case p_kind when 'sales_proposals' then 'Proposta comercial' when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' when 'service_orders' then 'Ordem de serviço' else 'Documento' end
$$;
-- Origin operations: Atualização, Atualização de situação, Criação, Envio, Estorno, Exclusão, Lançamento, Transferência.
create function erp_activity.operation(p_action text) returns text language sql immutable set search_path=pg_catalog as $$
 select case
  when p_action like '%reverse%' or p_action like '%reversal%' then 'estorno'
  when p_action like '%archive%' or p_action in('abort','title_cancel') then 'exclusao'
  when p_action like '%transfer%' then 'transferencia'
  when p_action='transition' then 'atualizacao_situacao'
  when p_action like 'create%' or p_action like 'import%' or p_action in('finalize','title_create_group','opening') then 'criacao'
  when p_action like '%post%' or p_action like '%settle%' or p_action like '%reservation%' or p_action='settle' then 'lancamento'
  when p_action like '%send%' or p_action like '%authoriz%' then 'envio'
  else 'atualizacao' end
$$;

create function erp_activity.entries(p_from timestamptz,p_to timestamptz)
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
 select 'finance',a.id::text,a.created_at,a.actor,'financas',erp_activity.operation(a.action),null,
  case a.action when 'account_save' then 'Conta financeira' when 'category_save' then 'Categoria financeira' when 'title_create_group' then 'Contas incluídas'
   when 'title_update' then 'Conta alterada' when 'title_cancel' then 'Conta cancelada' when 'settle' then 'Baixa de conta' when 'reverse' then 'Estorno de baixa'
   when 'opening' then 'Saldo inicial de conta financeira' when 'document_post' then 'Contas lançadas pelo documento' when 'document_reverse' then 'Contas estornadas do documento'
   else 'Operação financeira' end
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
 select 'company',a.id::text,a.created_at,a.actor,'empresa','atualizacao',null,'Dados da empresa'
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
 select 'home',a.id::text,a.created_at,a.actor,'pagina_inicial','atualizacao',null,'Atalhos favoritos'
 from erp_home.shortcut_audit a where a.created_at>=p_from and a.created_at<p_to
 union all
 select 'users',a.id::text,a.created_at,a.actor,'usuarios',
  case when(a.before_data->>'active')::boolean and not(a.after_data->>'active')::boolean then 'exclusao'
   when a.before_data->>'role' is null and(a.after_data->>'active')::boolean then 'criacao' else 'atualizacao' end,
  null,left('Usuário '||erp_activity.actor_label(a.target),200)
 from erp_access.user_audit a where a.created_at>=p_from and a.created_at<p_to
$$;

-- Origin "De um período": São Paulo calendar dates, at most 366 days, newest first, 100 per page.
create function erp_activity.period(p_from date,p_to date) returns tstzrange language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>365 or p_from<date '2020-01-01' or p_to>date '2100-12-31' then
  raise exception 'erp_activity_input_invalid' using errcode='22023'; end if;
 return tstzrange((p_from::timestamp at time zone 'America/Sao_Paulo'),((p_to+1)::timestamp at time zone 'America/Sao_Paulo'),'[)');
end $$;
create function public.erp_activity_list(p_user_id uuid,p_from date,p_to date,p_module text,p_operation text,p_actor uuid,p_query text,p_limit integer,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_range tstzrange; v_q text; v_total integer; v_items jsonb;
begin
 perform erp_activity.require_admin(p_user_id);
 v_range:=erp_activity.period(p_from,p_to);
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
  or p_module is not null and p_module not in('clientes_fornecedores','produtos','depositos','propostas','pedidos_venda','pedidos_compra','ordens_servico','documentos','estoque','financas','cobranca','notas_fiscais','empresa','anexos','preferencias','pagina_inicial','usuarios')
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

create function public.erp_files_list(p_user_id uuid,p_query text,p_from date,p_to date,p_order text,p_limit integer,p_offset integer) returns jsonb
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
  where a.status='ready' and(v_range is null or coalesce(a.finished_at,a.created_at)<@v_range) and(v_q is null or strpos(lower(a.filename),v_q)>0)
 )
 select(select count(*) from files),(select coalesce(sum(size_bytes),0) from files),(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'filename',x.filename,'mime_type',x.mime_type,'size_bytes',x.size_bytes,'sha256',x.sha256,
   'created_at',x.at_time,'owner',jsonb_build_object('user_id',x.actor,'label',erp_activity.actor_label(x.actor)),'document',jsonb_build_object('kind',x.kind,'id',x.document_id,'number',x.number::text))
   order by case when p_order='nome' then lower(x.filename) end,case when p_order='tamanho' then x.size_bytes end desc,x.at_time desc,x.id),'[]'::jsonb)
  from(select * from files order by case when p_order='nome' then lower(filename) end,case when p_order='tamanho' then size_bytes end desc,at_time desc,id limit p_limit offset p_offset) x) into v_total,v_bytes,v_items;
 return jsonb_build_object('scope','files','data_mode','erp_native','query',v_q,'from',to_char(p_from,'YYYY-MM-DD'),'to',to_char(p_to,'YYYY-MM-DD'),'order',p_order,'limit',p_limit,'offset',p_offset,
  'total',v_total,'total_bytes',v_bytes::text,'has_more',p_offset+jsonb_array_length(v_items)<v_total,'items',v_items);
end $$;

revoke all on all functions in schema erp_activity from public,anon,authenticated,service_role;
revoke all on function public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer) from public,anon,authenticated;
revoke all on function public.erp_files_list(uuid,text,date,date,text,integer,integer) from public,anon,authenticated;
grant execute on function public.erp_activity_list(uuid,date,date,text,text,uuid,text,integer,integer) to service_role;
grant execute on function public.erp_files_list(uuid,text,date,date,text,integer,integer) to service_role;
commit;
