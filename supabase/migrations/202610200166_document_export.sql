-- 166: "Exportar para a planilha" dos pedidos de compra (Origin: modal Mês e Ano, Download) com as colunas do pedido e dos
-- itens. Leitura paginada (25 pedidos por página, até 5.000 pedidos no período), na ordem de data e número; a planilha XLSX é
-- montada no navegador. Valores sempre em texto decimal exato. Somente leitura, para quem lê o tipo de documento.
-- Requer 008, 057, 129 e 163.
begin;

create function public.erp_document_export(p_user_id uuid,p_kind text,p_date_from text,p_date_to text,p_page integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_from date; v_to date; v_count bigint; v_items jsonb; v_size constant integer:=25;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_page is null or p_page not between 1 and 200 or p_date_from is null or p_date_to is null
  or p_date_from!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' or p_date_to!~'^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 v_from:=erp_documents.date_value(to_jsonb(p_date_from),true); v_to:=erp_documents.date_value(to_jsonb(p_date_to),true);
 if v_from>v_to or v_to-v_from>366 then raise exception 'erp_document_period_invalid' using errcode='22023'; end if;
 select count(*) into v_count from erp_documents.document d where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to;
 if v_count>5000 then raise exception 'erp_document_export_limit' using errcode='22023'; end if;
 with page as materialized(
  select d.*,row_number() over(order by d.body->>'date',d.number,d.id) n from erp_documents.document d
  where d.kind=p_kind and d.body->>'date' between p_date_from and p_date_to
  order by d.body->>'date',d.number,d.id offset (p_page-1)*v_size limit v_size)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',p.number::text,'date',p.body->>'date','expected_date',p.body->>'expected_date','status',p.status,
   'situation_name',(erp_documents.situation_json(p.kind,p.status,(select s.situation_id from erp_documents.document_situation s where s.document_id=p.id)))->>'name',
   'contact_name',p.contact_snapshot->>'name','contact_document',nullif(p.contact_snapshot->>'document',''),
   'order_reference',case when p.kind='purchase_orders' then p.body->>'order_reference' end,'internal_notes',left(p.body->>'internal_notes',4000),
   'freight',(p.body->>'freight'),'discount',(p.body#>>'{totals,discount}'),'total',p.total::text,
   'items',(select coalesce(jsonb_agg(jsonb_build_object('position',i.position,'code',i.data->>'code','description',i.data->>'description','unit',i.data->>'unit',
     'quantity',i.quantity::text,'unit_price',erp_catalog.unit_price_numeric(i.unit_price,10),'discount_percent',i.discount_percent::text,'total',i.total::text) order by i.position),'[]'::jsonb)
    from erp_documents.item i where i.document_id=p.id)) order by p.n),'[]'::jsonb) into v_items from page p;
 return jsonb_build_object('kind',p_kind,'date_from',p_date_from,'date_to',p_date_to,'page',p_page,'size',v_size,'total_count',v_count,
  'has_more',p_page*v_size<v_count,'items',v_items,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function public.erp_document_export(uuid,text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_export(uuid,text,text,text,integer) to service_role;
commit;
