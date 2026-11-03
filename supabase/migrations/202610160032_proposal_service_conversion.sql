-- A proposal has one commercial destination: sale OR service order.
-- Existing unique(source_proposal_id), sale RPC and historical commands remain.
begin;

create or replace function erp_documents.project_result_flags(p_result jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare result jsonb:=p_result; key text;
begin
 foreach key in array array['document','proposal','sale','service_order'] loop
  if jsonb_typeof(result->key)='object' then
   result:=jsonb_set(result,array[key,'effect_flags'],erp_documents.effect_flags((result->key->>'id')::uuid),true);
  end if;
 end loop;
 return result;
end $$;

create function public.erp_proposal_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype;
 v_id uuid; v_before jsonb; v_result jsonb;
begin
 -- Recheck current membership even for a historical idempotent replay.
 perform erp_documents.require_access(p_user_id,'sales_proposals',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','convert_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 -- Same command namespace and parent row as sale conversion: command -> source -> numbering.
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_proposals' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version or v_source.version=2147483647 then
  raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.document where source_proposal_id=p_id) then
  raise exception 'erp_proposal_already_converted' using errcode='40001'; end if;
 if v_source.status<>'approved' or coalesce((v_source.body->>'template')::boolean,false) then
  raise exception 'erp_proposal_not_approved' using errcode='22023'; end if;
 v_before:=erp_documents.dto(p_id);
 -- Copy the approved historical snapshots, without consulting mutable catalog prices.
 -- OS starts open for operational review; its approval/execution is not inferred.
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,source_proposal_id,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body||'{"template":false}'::jsonb,v_source.total,p_id,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,
  i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id where i.id is not null)n where i.document_id=p_id;
 update erp_documents.document set status='completed',version=version+1,updated_by=p_user_id,updated_at=clock_timestamp() where id=p_id;
 v_result:=jsonb_build_object('proposal',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,p_id,'convert_to_service',v_before,erp_documents.dto(p_id)),
  (p_user_id,p_command_id,v_id,'create_from_proposal',null,erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.project_result_flags(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid) to service_role;
commit;
