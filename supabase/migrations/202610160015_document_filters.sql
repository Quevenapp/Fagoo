-- Filtros documentais de leitura; sem alterar documentos ou movimentos.
begin;
drop function public.erp_document_list(uuid,text,integer,uuid,text);
create index erp_documents_kind_date_id on erp_documents.document(kind,(body->>'date'),id);
create function public.erp_document_list(
 p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null,p_status text default null,
 p_query text default null,p_date_from text default null,p_date_to text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_items jsonb; v_more boolean; v_last uuid; v_query text; v_from date; v_to date;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_limit is null or p_limit not between 1 and 100
  or (p_status is not null and not (erp_documents.transitions()->p_kind)?p_status)
  or length(p_query)>120 or p_query ~ '[[:cntrl:]]'
  or (p_date_from is not null and p_date_from !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')
  or (p_date_to is not null and p_date_to !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$') then
  raise exception 'erp_document_query_invalid' using errcode='22023';
 end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from));
 v_to:=erp_documents.date_value(to_jsonb(p_date_to));
 if v_from>v_to then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 with page as materialized(
  select d.id from erp_documents.document d
  where d.kind=p_kind and(p_after is null or d.id>p_after)
   and(p_status is null or d.status=p_status)
   and(v_from is null or d.body->>'date'>=p_date_from)
   and(v_to is null or d.body->>'date'<=p_date_to)
   and(v_query is null or strpos(d.number::text,v_query)>0 or d.id::text=v_query
    or strpos(lower(coalesce(d.contact_snapshot->>'name','')),v_query)>0
    or strpos(lower(coalesce(d.contact_snapshot->>'code','')),v_query)>0)
  order by d.id limit p_limit+1
 ), visible as materialized(select id from page order by id limit p_limit)
 select coalesce((select jsonb_agg(erp_documents.summary(id) order by id) from visible),'[]'::jsonb),
  (select count(*)>p_limit from page),(select id from visible order by id desc limit 1)
 into v_items,v_more,v_last;
 return jsonb_build_object('kind',p_kind,'items',v_items,'limit',p_limit,'has_more',v_more,
  'next_cursor',case when v_more then v_last end,'data_mode','erp_native','operational_effects',false);
end $$;
revoke all on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_list(uuid,text,integer,uuid,text,text,text,text) to service_role;
commit;
