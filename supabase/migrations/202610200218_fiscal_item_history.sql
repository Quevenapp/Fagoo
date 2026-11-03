-- 218: ícone "Histórico do produto para o cliente" dos itens do formulário "Nota fiscal" (Origin), onda D.
-- erp_fiscal_invoice_item_history: as últimas 20 notas do mesmo contato com o mesmo produto, no sentido da nota (saída para o
-- cliente, entrada para o fornecedor): notas do Origin do espelho (contato ligado pelo cadastro, erp_catalog.origin, e produto pelo
-- código, como o filtro Produto da lista) e notas do Brufap (testes de homologação e notas registradas/importadas, marcadas).
-- Somente leitura, para os perfis que abrem o formulário da nota (admin e fiscal); "Contato acessível somente ao vendedor
-- vinculado" vale aqui também. Nada é gravado.
begin;

do $$begin
 if to_regprocedure('erp_catalog.contact_require_visible(uuid,uuid)') is null or to_regprocedure('erp_fiscal_invoices.origin_money(jsonb)') is null then
  raise exception 'fiscal_history_218_requires_113_124' using errcode='55000'; end if;
end$$;

create function public.erp_fiscal_invoice_item_history(p_user_id uuid,p_contact_id uuid,p_product_id uuid,p_direction text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_code text;v_sources text[];v_items jsonb;
begin
 if p_contact_id is null or p_product_id is null or p_direction is null or p_direction not in('0','1') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 if not exists(select 1 from erp_catalog.record where id=p_contact_id and entity='contacts') or not exists(select 1 from erp_catalog.record where id=p_product_id and entity='products') then
  raise exception 'erp_fiscal_invoice_not_found' using errcode='P0002'; end if;
 perform erp_catalog.contact_require_visible(p_user_id,p_contact_id);
 select nullif(code,'') into v_code from erp_catalog.record where id=p_product_id;
 v_sources:=array(select o.source_id from erp_catalog.origin o where o.entity='contacts' and o.record_id=p_contact_id);
 with brufap as(
  select 'brufap'::text origin,v.id::text id,v.number,v.series,v.issue_date,v.issue_type,i.quantity::text quantity,i.unit_price::text unit_price,i.total
  from erp_fiscal_invoices.invoice v join erp_fiscal_invoices.invoice_item i on i.invoice_id=v.id
  where v.deleted_at is null and v.direction=p_direction and v.recipient->>'contact_id'=p_contact_id::text and i.product_id=p_product_id
 ),origin as(
  select 'origin'::text origin,r.source_id id,erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(r.payload->'numero',20)),'0'),''))) number,
   erp_fiscal_invoices.origin_int(r.payload->'serie') series,erp_fiscal_invoices.origin_date(r.payload->'dataEmissao') issue_date,null::text issue_type,
   case when erp_fiscal_invoices.scalar(e->'quantidade',30) ~ '^[0-9]{1,12}(\.[0-9]{1,10})?$' then e->>'quantidade' end quantity,
   case when erp_fiscal_invoices.scalar(e->'valor',30) ~ '^[0-9]{1,13}(\.[0-9]{1,10})?$' then e->>'valor' end unit_price,erp_fiscal_invoices.origin_money(e->'valorTotal') total
  from origin_sync.raw_record r cross join lateral jsonb_array_elements(case when jsonb_typeof(r.payload->'itens')='array' then r.payload->'itens' else '[]' end) e
  where v_code is not null and cardinality(v_sources)>0 and r.entity in('nfe','nfce') and (r.entity='nfce' and p_direction='1' or erp_fiscal_invoices.scalar(r.payload->'tipo',2)=p_direction)
   and erp_fiscal_invoices.scalar(r.payload#>'{contato,id}',40)=any(v_sources) and erp_fiscal_invoices.scalar(e->'codigo',60)=v_code
 ),rows as(select * from brufap union all select * from origin order by issue_date desc nulls last,number desc nulls last,id limit 20)
 select coalesce(jsonb_agg(jsonb_build_object('origin',x.origin,'id',x.id,'number',x.number,'series',x.series,'issue_date',x.issue_date,'issue_type',x.issue_type,
   'quantity',x.quantity,'unit_price',x.unit_price,'total',case when x.total is null then null else erp_fiscal_invoices.money_text(x.total) end)
   order by x.issue_date desc nulls last,x.number desc nulls last,x.id),'[]'::jsonb) into v_items from rows x;
 return jsonb_build_object('items',v_items,'contact_id',p_contact_id,'product_id',p_product_id,'direction',p_direction,'data_mode','erp_native');
end $$;

revoke all on function public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_item_history(uuid,uuid,uuid,text) to service_role;
commit;
