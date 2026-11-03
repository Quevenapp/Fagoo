-- 165: categoria padrão nas contas lançadas pelos documentos (Cadastros › Categorias financeiras, menus "Padrão venda",
-- "Padrão serviço" e "Padrão compra" da migração 135). Sem categoria escolhida na conferência, o Lançar contas do pedido de
-- venda, da OS e do pedido de compra usa a categoria padrão do tipo (venda, serviço ou compra), conferida como as demais
-- (ativa, do tipo certo); sem padrão definido, as contas continuam sem categoria. A prévia e o lançamento calculam a mesma
-- categoria, então o hash da conferência muda se o padrão mudar no meio (o lançamento é recusado com conflito).
-- Nenhuma conta é lançada sozinha. Requer 017 e 135.
begin;

create function erp_documents.finance_category(p_kind text,p_category uuid) returns uuid language sql stable set search_path=pg_catalog as $$
 select coalesce(p_category,(select d.category_id from erp_finance.category_default d join erp_finance.category c on c.id=d.category_id
  where d.key=case p_kind when 'sales_orders' then 'sale' when 'service_orders' then 'service' when 'purchase_orders' then 'purchase' end and c.active and c.deleted_at is null))
$$;

-- 017 with the default category of the kind when none is chosen.
create or replace function public.erp_document_finance_preview(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$ declare d erp_documents.document;begin
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 return jsonb_build_object('preview',erp_finance.document_preview_data(d,erp_documents.finance_category(p_kind,p_category_id),p_plan),'data_mode','erp_native','cash_movement_performed',false);
end $$;
create or replace function public.erp_document_finance_post(p_user_id uuid,p_kind text,p_document_id uuid,p_expected_version integer,p_command_id uuid,p_preview_hash text,p_category_id uuid default null,p_plan jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;data jsonb;replay jsonb;preview jsonb;pid uuid;gid uuid:=gen_random_uuid();tid uuid;part jsonb;label text;result jsonb;before_doc jsonb;v_category uuid;begin
 -- The command keeps the category as requested, so a replay of an older command still matches.
 data:=jsonb_build_object('kind',p_kind,'document_id',p_document_id,'version',p_expected_version,'preview_hash',p_preview_hash,'category_id',p_category_id,'plan',p_plan);
 replay:=erp_finance.document_command_start(p_user_id,p_command_id,'post',data);if replay is not null then return replay;end if;
 d:=erp_finance.document_lock(p_user_id,p_kind,p_document_id,p_expected_version);
 v_category:=erp_documents.finance_category(p_kind,p_category_id);
 preview:=erp_finance.document_preview_data(d,v_category,p_plan);
 if p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$' or p_preview_hash<>preview->>'preview_hash' then raise exception 'erp_document_finance_preview_conflict' using errcode='40001';end if;
 before_doc:=erp_documents.dto(d.id);
 insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id)
 values(d.id,d.version,gid,preview-'preview_hash',p_preview_hash,p_user_id,p_command_id) returning id into pid;
 label:=case d.kind when 'sales_orders' then 'Pedido de venda' when 'purchase_orders' then 'Pedido de compra' else 'Ordem de serviço' end||' nº '||d.number::text;
 for part in select value from jsonb_array_elements(preview->'installments') loop
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,amount_cents)
  values(gid,(part->>'position')::integer,jsonb_array_length(preview->'installments'),preview->>'direction',d.contact_id,v_category,label,
   (preview->>'issued_on')::date,(part->>'due_on')::date,(part->>'amount_cents')::bigint) returning id into tid;
  insert into erp_finance.document_title(title_id,posting_id,position)values(tid,pid,(part->>'position')::integer);
 end loop;
 update erp_documents.document set version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=d.id;
 result:=jsonb_build_object('document_id',d.id,'document_version',d.version+1,'posting',erp_finance.document_posting_summary(pid),'titles',erp_finance.document_title_rows(pid));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'document_post',null,result);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)values(p_user_id,p_command_id,d.id,'finance_post',before_doc,result);
 return erp_finance.document_command_finish(p_user_id,p_command_id,'post',data,result);
end $$;

revoke all on function erp_documents.finance_category(text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb),public.erp_document_finance_post(uuid,text,uuid,integer,uuid,text,uuid,jsonb) to service_role;
commit;
