-- Read-only targets for N/C. The source document and destination module both check access.
begin;
create or replace function public.erp_document_indicator_links(p_user_id uuid,p_kind text,p_document_id uuid,p_indicator text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d erp_documents.document; v_source text; v_note text; v_links jsonb:='[]';
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_indicator not in('N','C','O') or p_indicator is null then raise exception 'erp_document_invalid' using errcode='22023'; end if;
 select * into d from erp_documents.document where id=p_document_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if p_indicator='O' then
 perform erp_documents.require_access(p_user_id,'service_orders',false);
 select coalesce(jsonb_agg(jsonb_build_object('kind','service_order','origin','brufap','id',o.service_order_id::text,'model',null,'number',n.number::text)),'[]') into v_links
  from erp_documents.sales_service_link o join erp_documents.document n on n.id=o.service_order_id where o.sales_order_id=d.id;
 return jsonb_build_object('document_id',d.id,'kind',d.kind,'indicator',p_indicator,'items',v_links,'data_mode','erp_native','operational_effects',false);
 end if;
 if p_indicator='N' then perform erp_fiscal_invoices.require_read(p_user_id);
 else perform erp_finance.require_access(p_user_id,false); end if;
 select origin_id into v_source from erp_sync.link where entity=d.kind and record_id=d.id;
 if v_source is not null then
  select nullif(nullif(payload#>>'{notaFiscal,id}','0'),'') into v_note from origin_sync.raw_record where entity=d.kind and source_id=v_source;
 end if;
 if p_indicator='N' then
  select coalesce(jsonb_agg(jsonb_build_object('kind','invoice','origin','brufap','id',n.id::text,'model',n.model,'number',n.number::text) order by n.issue_date desc,n.id),'[]') into v_links
   from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id where o.document_id=d.id and n.deleted_at is null;
  if v_note ~ '^[1-9][0-9]{0,19}$' then
   v_links:=v_links||jsonb_build_array(jsonb_build_object('kind','invoice','origin','origin','id',v_note,
    'model',case when exists(select 1 from origin_sync.raw_record where entity='nfce' and source_id=v_note) then '65' else '55' end,
    'available',exists(select 1 from erp_fiscal_mirror.current where entity in('nfe','nfce') and source_id=v_note and not source_deleted),'number',(select payload->>'numero' from origin_sync.raw_record where entity in('nfe','nfce') and source_id=v_note limit 1)));
  end if;
  if jsonb_array_length(v_links)=0 then
   select coalesce(jsonb_agg(jsonb_build_object('kind','draft','origin','brufap','id',f.id::text,'model',f.model,'number',null) order by f.updated_at desc,f.id),'[]') into v_links
    from erp_fiscal_drafts.draft f where f.source_document_id=d.id and f.status='draft';
  end if;
 else
  select coalesce(jsonb_agg(jsonb_build_object('kind','title','origin','brufap','id',t.title_id::text,'model',null,'number',t.position::text) order by t.position),'[]') into v_links
   from erp_finance.document_posting p join erp_finance.document_title t on t.posting_id=p.id where p.document_id=d.id and p.state='active';
  if v_source is not null then
   select v_links||coalesce(jsonb_agg(jsonb_build_object('kind','title','origin',case when l.record_id is null then 'origin' else 'brufap' end,
    'id',coalesce(l.record_id::text,r.source_id),'model',null,'number',null) order by r.source_id),'[]') into v_links
    from origin_sync.raw_record r left join erp_sync.link l on l.entity=r.entity and l.origin_id=r.source_id
    where r.entity=case when p_kind='purchase_orders' then 'payables' else 'receivables' end
     and ((r.payload#>>'{origem,id}'=v_source and r.payload#>>'{origem,tipoOrigem}' in('venda','pedido','ordemservico','compra'))
      or(v_note is not null and r.payload#>>'{origem,id}'=v_note and r.payload#>>'{origem,tipoOrigem}'='notafiscal'));
  end if;
 end if;
 return jsonb_build_object('document_id',d.id,'kind',d.kind,'indicator',p_indicator,'items',v_links,'data_mode','erp_native','operational_effects',false);
end$$;
revoke all on function public.erp_document_indicator_links(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_document_indicator_links(uuid,text,uuid,text) to service_role;
commit;
