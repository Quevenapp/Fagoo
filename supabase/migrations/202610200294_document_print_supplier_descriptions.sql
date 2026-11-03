-- 294: Documentos (onda G), parte 6: "Exibir descrição do produto no fornecedor" das impressões (Preferências › Vendas › Configuração
-- de Impressão). Leitura só para a impressão: a descrição do produto na aba Fornecedores do cadastro (erp_catalog.product_supplier),
-- do fornecedor do pedido de compra ou, nos documentos de venda, do fornecedor padrão (sem padrão, o primeiro da lista). Quem lê o
-- documento lê as descrições dos produtos dos itens dele; nada muda. Nenhuma função existente é substituída. Nada escreve no Origin.
begin;

do $$begin
 if to_regclass('erp_catalog.product_supplier') is null then raise exception 'document_print_supplier_294_requires_119' using errcode='55000'; end if;
 if to_regprocedure('public.erp_document_supplier_descriptions(uuid,text,uuid)') is not null then raise exception 'document_print_supplier_294_already_applied' using errcode='55000'; end if;
end$$;

create function public.erp_document_supplier_descriptions(p_user_id uuid,p_kind text,p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare d erp_documents.document;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select * into d from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found or not erp_documents.contact_usable(p_user_id,d.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document_id',p_document_id,
  'items',coalesce((select jsonb_agg(jsonb_build_object('item_id',i.id,'product_id',i.product_id,'description',s.description) order by i.position)
   from erp_documents.item i cross join lateral(select left(btrim(regexp_replace(ps.description,'[[:cntrl:]]+',' ','g')),120) description from erp_catalog.product_supplier ps
    where ps.record_id=i.product_id and nullif(btrim(regexp_replace(ps.description,'[[:cntrl:]]+',' ','g')),'') is not null
    order by (p_kind='purchase_orders' and ps.supplier_id=d.contact_id) desc,ps.is_default desc,ps.position limit 1) s
   where i.document_id=p_document_id and i.product_id is not null),'[]'::jsonb),
  'data_mode','erp_native','operational_effects',false);
end $function$;

revoke all on function public.erp_document_supplier_descriptions(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.erp_document_supplier_descriptions(uuid,text,uuid) to service_role;
commit;
