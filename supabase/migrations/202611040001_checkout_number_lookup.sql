-- Resolve a checkout by its exact number, including imported orders converted to native authority.
-- Searching a paginated list by origin hid valid imported orders and could choose an ambiguous number.
begin;
create function public.erp_document_checkout_lookup(p_user_id uuid,p_number text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $function$
declare v_ids uuid[];
begin
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 if p_number is null or p_number !~ '^[1-9][0-9]{0,9}$' then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 select array_agg(d.id order by d.id) into v_ids
 from erp_documents.document d
 where d.kind='sales_orders' and d.number=p_number::bigint and d.authority='brufap'
  and d.deleted_at is null and erp_document_mirror.visible(p_user_id,d.id)
  and erp_documents.contact_usable(p_user_id,d.contact_id)
  and not exists(select 1 from erp_documents.origin_mirror m where m.document_id=d.id and m.source_deleted);
 if coalesce(cardinality(v_ids),0)=0 then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if cardinality(v_ids)>1 then raise exception 'erp_document_checkout_ambiguous' using errcode='40001'; end if;
 return jsonb_build_object('kind','sales_orders','id',v_ids[1],'number',p_number,'data_mode','erp_native','operational_effects',false);
end $function$;
revoke all on function public.erp_document_checkout_lookup(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_document_checkout_lookup(uuid,text) to service_role;
commit;
