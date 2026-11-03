-- 169: históricos dos formulários dos documentos (onda C), somente leitura.
-- * "Visualizar histórico do cliente" (pedido de venda, proposta e OS), modal "Últimos registros deste cliente": aba Produtos com
--   os itens vendidos ao cliente em pedidos de venda não cancelados (Tipo Venda) e, para administrador e fiscal (a regra de 113
--   para número e data das notas), em notas fiscais de saída autorizadas do Brufap (Tipo Nota Fiscal), com pesquisa por descrição
--   ou código; aba Financeiro com as contas a receber em aberto do cliente (resumo para quem lê o documento, sem abrir o
--   financeiro).
-- * "Visualizar histórico do item para o cliente": os 10 últimos registros do produto para o cliente.
-- * "Visualizar histórico do produto" no pedido de compra, popup "Últimas compras": as 10 últimas compras do produto (pedidos de
--   compra não cancelados e, para administrador e fiscal, notas fiscais de entrada), opcionalmente só do fornecedor do pedido.
-- As notas do espelho do Origin não entram (continuam no Origin). Nada é gravado. Requer 008, 010, 108 e 112.
begin;

create function public.erp_document_history(p_user_id uuid,p_kind text,p_contact_id uuid,p_product_id uuid default null,
 p_query text default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_fiscal boolean; v_purchase boolean; v_query text; v_items jsonb; v_count integer; v_finance jsonb;
 v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 select role into v_role from erp_access.membership where user_id=p_user_id and active;
 v_fiscal:=v_role in('admin','fiscal');
 v_purchase:=p_kind='purchase_orders';
 if p_limit is null or p_limit not between 1 and 50 or (not v_purchase and p_contact_id is null) or (v_purchase and p_product_id is null)
  or length(p_query)>120 or p_query~'[[:cntrl:]]' then
  raise exception 'erp_document_history_invalid' using errcode='22023'; end if;
 v_query:=lower(nullif(btrim(p_query),''));
 with lines as (
  select case when v_purchase then 'purchase' else 'sale' end as type,d.id as document_id,d.number::bigint as num,(d.body->>'date')::date as day,i.position,
   coalesce(i.data->>'description','') as description,nullif(i.data->>'code','') as code,i.product_id,coalesce(i.data->>'unit','') as unit,
   i.quantity::numeric(24,6) as quantity,i.unit_price
  from erp_documents.document d join erp_documents.item i on i.document_id=d.id
  where d.kind=case when v_purchase then 'purchase_orders' else 'sales_orders' end and d.status<>'cancelled'
   and (p_contact_id is null or d.contact_id=p_contact_id) and (p_product_id is null or i.product_id=p_product_id)
  union all
  select 'invoice',v.id,v.number::bigint,v.issue_date,t.position,coalesce(t.data->>'description',''),nullif(t.data->>'code',''),t.product_id,
   coalesce(t.data->>'unit',''),t.quantity::numeric(24,6),t.unit_price
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item t on t.invoice_id=v.id
  where v_fiscal and v.deleted_at is null and v.number is not null and v.direction=case when v_purchase then '0' else '1' end
   and v.status in(6,7,8) and (v_purchase or v.status in(6,7))
   and (p_contact_id is null or v.recipient->>'contact_id'=p_contact_id::text) and (p_product_id is null or t.product_id=p_product_id)
 ), found as (
  select * from lines l where v_query is null or strpos(lower(l.description),v_query)>0 or strpos(lower(coalesce(l.code,'')),v_query)>0
 ), page as (
  select * from found order by day desc,num desc,position limit p_limit+1
 )
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('type',type,'document_id',document_id,'number',num::text,'date',day::text,'position',position,
   'description',left(description,200),'code',left(code,100),'product_id',product_id,'unit',left(unit,16),'quantity',quantity::text,
   'unit_price',erp_catalog.unit_price_numeric(unit_price,14)) order by day desc,num desc,position) filter (where rn<=p_limit),'[]'::jsonb)
 into v_count,v_items
 from (select p.*,row_number() over(order by day desc,num desc,position) rn from page p) ranked;
 if not v_purchase and p_product_id is null then
  select jsonb_build_object('open_count',count(*),'open_amount',(coalesce(sum(t.amount_cents-t.settled_cents),0)/100.0)::numeric(18,2)::text,
   'overdue_amount',(coalesce(sum(t.amount_cents-t.settled_cents) filter (where t.due_on<v_today),0)/100.0)::numeric(18,2)::text,
   'titles',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'due_on',o.due_on::text,'description',left(o.description,200),
     'installment',o.installment,'installments',o.installments,'amount',(o.amount_cents/100.0)::numeric(18,2)::text,
     'open_amount',((o.amount_cents-o.settled_cents)/100.0)::numeric(18,2)::text) order by o.due_on,o.id)
    from (select * from erp_finance.title x where x.kind='receivable' and x.contact_id=p_contact_id and not x.cancelled and x.deleted_at is null
     and x.settled_cents<x.amount_cents order by x.due_on,x.id limit 20) o),'[]'::jsonb))
  into v_finance
  from erp_finance.title t where t.kind='receivable' and t.contact_id=p_contact_id and not t.cancelled and t.deleted_at is null and t.settled_cents<t.amount_cents;
 end if;
 return jsonb_build_object('kind',p_kind,'contact_id',p_contact_id,'product_id',p_product_id,'items',v_items,'has_more',v_count>p_limit,
  'invoices_included',v_fiscal,'finance',v_finance,'data_mode','erp_native','operational_effects',false);
end $$;

revoke all on function public.erp_document_history(uuid,text,uuid,uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.erp_document_history(uuid,text,uuid,uuid,text,integer) to service_role;
commit;
