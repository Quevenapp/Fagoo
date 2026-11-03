-- 290: Documentos (onda G), parte 4: "Observações" e "Observações internas" editáveis com efeitos ativos (Origin: "Não é possível
-- alterar o pedido, pois já foram realizadas as seguintes ações: Lançamento de Contas, Lançamento de Estoque"; tudo fica só leitura,
-- exceto as observações).
-- * erp_document_notes_save (pedido de venda, OS e pedido de compra): grava só notes e internal_notes do corpo, com comando
--   (Conferir resultado), versão lida (CAS), o escopo do vendedor, a permissão de gravar o tipo (e "Inclusão e edição" da OS) e
--   auditoria. Vale com estoque, contas, reservas, faturamento agrupado ou recebimentos ativos, e também no documento editável sem
--   efeitos; um documento travado pela situação e sem efeitos continua recusado.
-- * Contrato com as travas das outras frentes: a gravação muda só body->notes, body->internal_notes, version, updated_at e
--   updated_by da linha de erp_documents.document (nenhum item, total, situação, contato ou depósito). As travas do estoque (279) já
--   aceitam essa mudança no pedido de venda e na OS; as do financeiro (frente mista) passam a aceitá-la exatamente assim.
-- Nenhuma função existente é substituída. Nada escreve no Origin.
begin;

do $$begin
 if to_regprocedure('erp_stock.effect_edit_allowed(erp_documents.document,erp_documents.document)') is null or to_regclass('erp_finance.grouped_billing_document') is null then
  raise exception 'document_notes_save_290_requires_174_279' using errcode='55000'; end if;
 if to_regprocedure('public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text)') is not null then raise exception 'document_notes_save_290_already_applied' using errcode='55000'; end if;
end$$;

-- Whether a document has an active effect that locks the rest of its form (stock, contas, reservas, faturamento agrupado, recebimentos).
create function erp_documents.effects_active(p_id uuid) returns boolean language sql stable set search_path=pg_catalog as $function$
 select exists(select 1 from erp_stock.document_posting s where s.document_id=p_id and s.state='active')
  or exists(select 1 from erp_finance.document_posting x where x.document_id=p_id and x.state='active')
  or exists(select 1 from erp_finance.grouped_billing_document g where g.document_id=p_id and g.active)
  or exists(select 1 from erp_stock.reservation r where r.document_id=p_id and r.state='active')
  or erp_purchase_receipts.active(p_id)
$function$;

create function public.erp_document_notes_save(p_user_id uuid,p_kind text,p_id uuid,p_expected_version integer,p_command_id uuid,p_notes text,p_internal_notes text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $function$
declare v_hash text; v_replay jsonb; v_row erp_documents.document%rowtype; v_notes text; v_internal text; v_before jsonb; v_result jsonb;
begin
 if p_kind is null or p_kind not in('sales_orders','service_orders','purchase_orders') or p_id is null then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','notes','actor',p_user_id,'kind',p_kind,'id',p_id,'version',p_expected_version,
  'notes',p_notes,'internal_notes',p_internal_notes)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 v_notes:=erp_documents.text_value(to_jsonb(p_notes),4000,false,true);
 v_internal:=erp_documents.text_value(to_jsonb(p_internal_notes),4000,false,true);
 select * into v_row from erp_documents.document where id=p_id and kind=p_kind for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- 238: a document of a contact the user does not see is not found (Contato acessível somente ao vendedor vinculado).
 if not erp_documents.contact_usable(p_user_id,v_row.contact_id) then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_row.version<>p_expected_version or v_row.version=2147483647 then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if not erp_documents.editable(v_row.status) and not erp_documents.effects_active(p_id) then raise exception 'erp_document_state_locked' using errcode='40001'; end if;
 if (v_row.body->>'notes') is distinct from v_notes or (v_row.body->>'internal_notes') is distinct from v_internal then
  v_before:=erp_documents.dto(p_id);
  update erp_documents.document set body=body||jsonb_build_object('notes',v_notes,'internal_notes',v_internal),version=version+1,
   updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
  insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values(p_user_id,p_command_id,p_id,'notes',v_before,erp_documents.dto(p_id));
 end if;
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(p_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $function$;

revoke all on function erp_documents.effects_active(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text) from public,anon,authenticated;
grant execute on function public.erp_document_notes_save(uuid,text,uuid,integer,uuid,text,text) to service_role;
commit;
