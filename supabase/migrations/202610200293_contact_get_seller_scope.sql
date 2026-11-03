-- 293: Contatos (onda G): "Contato acessível somente ao vendedor vinculado" também na leitura antiga GET /v1/cadastros/contacts/{id}
-- (erp_catalog_get). Para quem não é administrador e está vinculado a um vendedor com a preferência ligada, o contato de outro
-- vendedor responde "não encontrado", como a listagem, o formulário e os documentos (238/267); o consumidor padrão da Frente de caixa
-- continua visível (erp_documents.contact_usable). Produtos e depósitos não mudam. A resposta continua a mesma (a API não muda).
-- Substitui erp_catalog_get da 006 (conferida pelo hash; outra versão interrompe a migração). Nada escreve no Origin.
begin;

do $$begin
 if to_regprocedure('erp_documents.contact_usable(uuid,uuid)') is null then raise exception 'contact_get_scope_293_requires_238' using errcode='55000'; end if;
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('public.erp_catalog_get(uuid,text,uuid)'))
  is distinct from '315e9794723ec03bba74bd5c4bb7b734a47329d459b93a1e7c1f117565285038' then
  raise exception 'contact_get_scope_293_previous_definition_changed' using errcode='55000',detail='public.erp_catalog_get(uuid,text,uuid)'; end if;
end$$;

create or replace function public.erp_catalog_get(p_user_id uuid,p_entity text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
  perform erp_catalog.require_access(p_user_id,p_entity,false);
  if not exists(select 1 from erp_catalog.record where id=p_id and entity=p_entity) then
    raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  -- 293: Contato acessível somente ao vendedor vinculado (the consumidor padrão of the Frente de caixa stays visible).
  if p_entity='contacts' and not erp_documents.contact_usable(p_user_id,p_id) then
    raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('entity',p_entity,'record',erp_catalog.dto(p_id),'data_mode','erp_native');
end $$;

revoke all on function public.erp_catalog_get(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.erp_catalog_get(uuid,text,uuid) to service_role;
commit;
