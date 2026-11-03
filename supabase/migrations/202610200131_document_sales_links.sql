-- Pedidos de venda no padrão do Origin: nota fiscal de origem e pendências cadastrais na linha, e "Gerar ordem serviço".
-- * erp_documents.pendencies: pendências para emitir a nota do pedido (cliente: CPF/CNPJ, endereço, número, bairro, cidade, UF e
--   CEP; produtos: vínculo com o cadastro, NCM, origem e unidade), conferidas no cadastro atual a cada leitura.
-- * list_row (102) passa a informar a nota fiscal vinculada ao pedido (modelo, número, data; a mais recente não excluída; só para
--   administrador e fiscal, que são os perfis que leem as notas do Brufap em 113), se há pendências e a ordem de serviço gerada.
-- * erp_sales_order_convert_to_service: gera uma OS (Em aberto) com o cliente, os itens e as condições do pedido, uma única vez e
--   só sem nota fiscal; o pedido não muda de situação e ganha uma ocorrência. Nenhum efeito de estoque, contas ou nota é criado.
-- Requer 008, 022, 096, 102, 103, 112 e 129.
begin;

create function erp_documents.pendencies(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 with d as (select * from erp_documents.document where id=p_id and kind='sales_orders'),
 c as (select k.* from d join erp_catalog.contact k on k.record_id=d.contact_id),
 checks as (
  select 1 o,'Cliente' section,'O campo CPF/CNPJ é obrigatório' message from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is null
  union all select 2,'Cliente','O CPF/CNPJ informado é inválido' from c where coalesce(c.person_type,'')<>'E' and nullif(btrim(c.document),'') is not null
   and not erp_catalog.valid_cpf(regexp_replace(c.document,'[^0-9]','','g')) and not erp_catalog.valid_cnpj(regexp_replace(c.document,'[^0-9]','','g'))
  union all select 3,'Cliente','O campo Endereço é obrigatório' from c where nullif(btrim(c.street),'') is null
  union all select 4,'Cliente','O campo Número é obrigatório' from c where nullif(btrim(c.number),'') is null
  union all select 5,'Cliente','O campo Bairro é obrigatório' from c where nullif(btrim(c.district),'') is null
  union all select 6,'Cliente','O campo Cidade é obrigatório' from c where nullif(btrim(c.city),'') is null
  union all select 7,'Cliente','O campo UF é obrigatório' from c where nullif(btrim(c.state),'') is null
  union all select 8,'Cliente','O campo CEP é obrigatório' from c where coalesce(c.person_type,'')<>'E' and regexp_replace(coalesce(c.postal_code,''),'[^0-9]','','g')!~'^[0-9]{8}$'
  union all select 100+i.position,'Produto '||(i.data->>'description'),'O item não está vinculado a um produto cadastrado'
   from d join erp_documents.item i on i.document_id=d.id where i.product_id is null
  union all select 100+i.position,'Produto '||(i.data->>'description'),m.message
   from d join erp_documents.item i on i.document_id=d.id join erp_catalog.product p on p.record_id=i.product_id
   cross join lateral (values (p.ncm is null or p.ncm!~'^[0-9]{8}$','O campo NCM é obrigatório'),(p.origin is null,'O campo Origem é obrigatório'),
    (nullif(btrim(coalesce(i.data->>'unit','')),'') is null,'O campo Unidade é obrigatório')) m(missing,message) where m.missing
 )
 select coalesce(jsonb_agg(jsonb_build_object('section',section,'message',message) order by o,message),'[]'::jsonb) from checks
$$;

create table erp_documents.sales_service_link (
 sales_order_id uuid primary key references erp_documents.document(id),
 service_order_id uuid not null unique references erp_documents.document(id),
 actor uuid not null references auth.users(id),
 command_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp()
);
create trigger sales_service_link_immutable before update or delete on erp_documents.sales_service_link for each row execute function erp_documents.occurrence_immutable();
alter table erp_documents.sales_service_link enable row level security;
revoke all on erp_documents.sales_service_link from public,anon,authenticated,service_role;

-- The most recent nota fiscal (not deleted) linked to the pedido, as the Origin "N" shows it.
create function erp_documents.order_invoice(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('model',n.model,'number',n.number::text,'series',n.series::text,'issue_date',n.issue_date::text,'authorized',n.authorized_at is not null)
 from erp_fiscal_invoices.invoice_order o join erp_fiscal_invoices.invoice n on n.id=o.invoice_id
 where o.document_id=p_id and n.deleted_at is null order by n.issue_date desc,n.created_at desc limit 1
$$;

-- 102 plus the nota fiscal of origin, the pendências flag and the OS generated from the pedido.
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
  'carrier_name',left(nullif(d.body#>>'{commercial,transport,carrier_reference,label}',''),200),
  'first_sale',d.kind='sales_orders' and d.status<>'cancelled' and not exists(select 1 from erp_documents.document o
    where o.kind='sales_orders' and o.contact_id=d.contact_id and o.status<>'cancelled' and o.id<>d.id
     and (o.body->>'date',o.number)<(d.body->>'date',d.number)),
  -- 131: nota fiscal de origem (pedidos), pendências cadastrais (pedidos não cancelados) e a OS gerada do pedido.
  -- The Brufap notas are read only by admin and fiscal (113), so the nota of origin follows the same rule as fiscal_draft.
  'invoice',case when p_fiscal and d.kind='sales_orders' then erp_documents.order_invoice(d.id) end,
  'pendencies',d.kind='sales_orders' and d.status<>'cancelled' and jsonb_array_length(erp_documents.pendencies(d.id))>0,
  'service_order_number',(select s.number::text from erp_documents.sales_service_link l join erp_documents.document s on s.id=l.service_order_id where l.sales_order_id=d.id),
  -- Origin "Selecione o modelo" shows the name of the modelo.
  'template_name',case when d.kind='sales_proposals' then d.body->>'template_name' end)
 from erp_documents.document d
 left join erp_catalog.record w on w.id=d.warehouse_id
 left join erp_documents.document p on p.id=d.source_proposal_id
 where d.id=p_id;
$$;

-- The pendências of one pedido for the alert of the editor (the list only carries the flag).
create function public.erp_document_pendencies(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_documents.document%rowtype;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if p_kind<>'sales_orders' then raise exception 'erp_document_query_invalid' using errcode='22023'; end if;
 select * into v from erp_documents.document where id=p_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('kind',p_kind,'document',jsonb_build_object('id',v.id,'kind',v.kind,'number',v.number::text,'status',v.status,'version',v.version),
  'pendencies',erp_documents.pendencies(p_id),'data_mode','erp_native','operational_effects',false);
end $$;

-- Origin "Gerar ordem serviço" from a pedido: once, only without nota fiscal; the pedido keeps its situação and gets an occurrence.
create function public.erp_sales_order_convert_to_service(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_replay jsonb; v_source erp_documents.document%rowtype; v_id uuid; v_result jsonb;
begin
 -- The pedido is locked and receives an occurrence, so both kinds are written.
 perform erp_documents.require_access(p_user_id,'sales_orders',true);
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','sales_to_service','actor',p_user_id,'id',p_id,'version',p_expected_version)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash); if v_replay is not null then return v_replay; end if;
 select * into v_source from erp_documents.document where id=p_id and kind='sales_orders' for update;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 if exists(select 1 from erp_documents.sales_service_link where sales_order_id=p_id) then raise exception 'erp_sales_order_already_converted' using errcode='40001'; end if;
 if v_source.status='cancelled' or erp_documents.order_invoice(p_id) is not null then raise exception 'erp_sales_order_not_convertible' using errcode='22023'; end if;
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values('service_orders',erp_documents.next_number('service_orders'),'open',v_source.contact_id,v_source.warehouse_id,v_source.contact_snapshot,
  v_source.body-array['ship_date','customer_po_number','delivery_address']||'{"template":false}'::jsonb,v_source.total,p_user_id,p_user_id) returning id into v_id;
 insert into erp_documents.item(id,document_id,position,product_id,product_snapshot,quantity,unit_price,discount_percent,total,data)
 select n.new_id,v_id,i.position,i.product_id,i.product_snapshot,i.quantity,i.unit_price,i.discount_percent,i.total,i.data||jsonb_build_object('id',n.new_id)
 from erp_documents.item i cross join lateral(select gen_random_uuid() new_id) n where i.document_id=p_id;
 insert into erp_documents.sales_service_link(sales_order_id,service_order_id,actor,command_id) values(p_id,v_id,p_user_id,p_command_id);
 perform erp_documents.record_occurrence(p_id,p_user_id,p_command_id,v_source.version,v_source.status,null,
  'Ordem de serviço '||(select number::text from erp_documents.document where id=v_id)||' gerada a partir deste pedido');
 v_result:=jsonb_build_object('sale',erp_documents.dto(p_id),'service_order',erp_documents.dto(v_id),'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data) values
  (p_user_id,p_command_id,v_id,'create_from_sales_order',jsonb_build_object('sales_order_id',p_id,'sales_order_number',v_source.number::text),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.pendencies(uuid),erp_documents.order_invoice(uuid),erp_documents.list_row(uuid,boolean,boolean) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_pendencies(uuid,text,uuid),public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_pendencies(uuid,text,uuid),public.erp_sales_order_convert_to_service(uuid,uuid,integer,uuid) to service_role;
commit;
