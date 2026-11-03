-- 198: Letra N e regras do ⋮ das ordens de serviço com nota fiscal (onda D da frente de documentos).
-- A nota de saída gerada da OS (176, só as peças) liga-se à OS em erp_fiscal_invoices.invoice_order. A linha da listagem de OS
-- passa a informar a nota como a do pedido: para todos os perfis, que existe nota vinculada (letra N e o ⋮ sem "Gerar nota
-- fiscal"); número e data da nota só para administrador e fiscal (regra de 113). Somente leitura. Requer 168 e 176.
begin;

do $$begin
 if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure('erp_documents.list_row(uuid,boolean,boolean)'))
  is distinct from 'ec36bec9a0a45bcc2493ebbd31418623df6de6b511c0f204469a6fee501d9c27' then
  raise exception 'document_list_198_previous_definition_changed' using errcode='55000',detail='erp_documents.list_row(uuid,boolean,boolean)';end if;
end$$;

create or replace function erp_documents.list_row(p_id uuid,p_fiscal boolean,p_stock boolean)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'status',d.status,'version',d.version,
  'date',d.body->>'date','expected_date',d.body->>'expected_date','next_contact',d.body->>'next_contact',
  'template',coalesce(d.body->'template'='true'::jsonb,false),
  'total',d.total::text,'contact_id',d.contact_id,'contact_name',d.contact_snapshot->>'name',
  'warehouse_id',d.warehouse_id,'warehouse_name',case when p_stock then w.name end,
  'source_proposal_id',d.source_proposal_id,'source_proposal_number',p.number::text,
  'finance_active',exists(select 1 from erp_finance.document_posting f where f.document_id=d.id and f.state='active'),
  'stock_active',exists(select 1 from erp_stock.document_posting s where s.document_id=d.id and s.state='active'),
  'receipt_active',d.kind='purchase_orders' and erp_purchase_receipts.active(d.id),
  'reservation_active',case when p_stock then d.kind='sales_orders' and exists(select 1 from erp_stock.reservation r where r.document_id=d.id and r.state='active') end,
  'fiscal_draft',case when p_fiscal and d.kind='sales_orders' then exists(select 1 from erp_fiscal_drafts.draft x where x.source_document_id=d.id and x.status='draft') end,
  'internal_notes',left(d.body->>'internal_notes',280),
  'created_at',d.created_at,'updated_at',d.updated_at,
  'customer_po_number',d.body->>'customer_po_number','ship_date',d.body->>'ship_date',
  'contact_email',nullif(d.contact_snapshot->>'email',''),'contact_phone',coalesce(nullif(d.contact_snapshot->>'phone',''),nullif(d.contact_snapshot->>'mobile','')),
  'contact_document',nullif(d.contact_snapshot->>'document',''),
  'address',left(coalesce(erp_documents.address_text(nullif(d.body->'delivery_address','null'::jsonb)),erp_documents.address_text(d.contact_snapshot)),500),
  'carrier_name',coalesce((select left(r.name,200) from erp_catalog.record r where r.id::text=d.body->>'carrier_id'),left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200)),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
  -- 198: the nota of the ordem de serviço too (176 links the NF-e to the OS, letter O on the notes list).
  'invoice',case when p_fiscal and d.kind in('sales_orders','service_orders') then erp_documents.order_invoice(d.id) end,
  'pendencies',d.kind='sales_orders' and d.status<>'cancelled' and jsonb_array_length(erp_documents.pendencies(d.id))>0,
  'service_order_number',(select s.number::text from erp_documents.sales_service_link l join erp_documents.document s on s.id=l.service_order_id where l.sales_order_id=d.id),
  'template_name',case when d.kind='sales_proposals' then d.body->>'template_name' end,
  -- 163: situação of the Gerenciador de transições and whether a nota is linked (the menu rules of every profile).
  'situation',erp_documents.situation_json(d.kind,d.status,ds.situation_id),
  'invoice_linked',d.kind in('sales_orders','service_orders') and erp_documents.order_invoice(d.id) is not null,
  -- 164: native vendedor (Cadastros › Vendedores) of the document.
  'seller_id',case when d.body->>'seller_id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then d.body->>'seller_id' end,
  'seller_name',(select left(r.name,200) from erp_catalog.seller s join erp_catalog.record r on r.id=s.contact_id where s.id::text=d.body->>'seller_id'))
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 left join erp_documents.document_situation ds on ds.document_id=d.id
 where d.id=p_id;
$$;

revoke all on function erp_documents.list_row(uuid,boolean,boolean) from public,anon,authenticated,service_role;
commit;
