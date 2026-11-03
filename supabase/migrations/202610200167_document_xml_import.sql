-- 167: "Importar › Pedido XML" (Origin Mais ações dos pedidos de venda e Notas de entrada › Importar Pedido XML). O Worker lê o
-- XML da NF-e autorizada (pacote fiscal-xml, o mesmo da importação de notas) e esta função só procura, sem gravar, o contato
-- ativo pelo CPF/CNPJ e os produtos ativos pelo GTIN ou pelo código. O pedido é montado no formulário e só é gravado quando o
-- usuário confere e salva (erp_document_save, com todas as regras). Somente leitura; só para quem grava o tipo de documento.
-- Requer 006, 008 e 044.
begin;

create function public.erp_document_xml_match(p_user_id uuid,p_kind text,p_document text,p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_contact jsonb; v_items jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_kind not in('sales_orders','purchase_orders') or (p_document is not null and p_document!~'^[0-9]{11}([0-9]{3})?$')
  or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 250
  or exists(select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i)<>'object' or (select count(*) from jsonb_object_keys(i))<>2
   or not(i?'code' and i?'gtin') or (i->'code'<>'null'::jsonb and (jsonb_typeof(i->'code')<>'string' or length(i->>'code') not between 1 and 60))
   or (i->'gtin'<>'null'::jsonb and (jsonb_typeof(i->'gtin')<>'string' or i->>'gtin'!~'^([0-9]{8}|[0-9]{12,14})$'))) then
  raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 if p_document is not null then
  select jsonb_build_object('id',r.id,'name',r.name,'code',r.code) into v_contact from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
   where r.entity='contacts' and r.active and regexp_replace(coalesce(c.document,''),'[^0-9]','','g')=p_document order by r.created_at,r.id limit 1;
 end if;
 select coalesce(jsonb_agg((select jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'unit',p.unit,'by',case when p.gtin=i->>'gtin' then 'gtin' else 'code' end)
   from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id
   where r.entity='products' and r.active and ((i->>'gtin' is not null and p.gtin=i->>'gtin') or (i->>'code' is not null and lower(r.code)=lower(i->>'code')))
   order by (i->>'gtin' is not null and p.gtin=i->>'gtin') desc,r.created_at,r.id limit 1) order by n),'[]'::jsonb) into v_items
  from jsonb_array_elements(p_items) with ordinality x(i,n);
 return jsonb_build_object('kind',p_kind,'contact',v_contact,'products',v_items,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function public.erp_document_xml_match(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_xml_match(uuid,text,text,jsonb) to service_role;
commit;
