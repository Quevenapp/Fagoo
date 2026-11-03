-- 254: "Gerar nota fiscal" lê o pagamento e as composições do pedido (onda E da frente de notas).
-- * Detalhes de pagamento do pedido de venda (documentos 196): Método de pagamento (payment_means = tPag) e Forma de pagamento
--   (payment_indicator = indPag; 0 à vista, 1 a prazo). Vazios, a nota segue os padrões (o tPag da forma ou do texto da parcela e
--   o indPag pelas parcelas). A nota guarda a Forma de pagamento do pedido em payment.indicator (opcional; nota sem ela não muda).
-- * Parcelas: a Forma do cadastro (payment_method_id, com o tPag e os dados de cartão da forma) e os "Detalhes da parcela" do pedido
--   (Tipo de pagamento, Bandeira, Tipo integração, CNPJ credenciadora, Código de autorização, Valor Recebido, Valor de taxa e Valor de
--   taxa comissão) vão para a parcela da nota (grupo card da NF-e).
-- * Preferências › Vendas › Vendas "Desmembrar produtos com tipo de estoque Físico / Virtual em uma estrutura na nota fiscal": ligadas,
--   o item que é uma composição (estoque, 222) traz os componentes da estrutura atual, e o formulário da nota troca a composição pelos
--   componentes. Uma estrutura com componente indisponível não é desmembrada e a tela diz por quê.
-- * Pedido de contato estrangeiro: deixa de ser recusado ("Pedido internacional"); a nota abre como Exportação para completar os
--   dados de exportação (a v2 e a 176 continuam recusando, para o Worker anterior).
-- Nada é emitido, transmitido, numerado ou lançado.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_fiscal_invoices.order_source_v2(uuid,text)') is null or to_regclass('erp_stock.composition_current') is null or to_regclass('erp_catalog.payment_method') is null then
  raise exception 'fiscal_order_source_254_requires_127_215_222' using errcode='55000'; end if;
 for r in select * from(values
  ('erp_fiscal_invoices.payment_input(jsonb)','9150112f7956d48b8b4c514285ae5139df1c0d0f47c23b487fccc1a84f77776f'))v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'fiscal_order_source_254_previous_definition_changed' using errcode='55000',detail=r.sig;end if;
 end loop;
end$$;

-- 219 plus payment.indicator (Forma de pagamento of the pedido, indPag): kept only when informed, so every note saved before stays equal.
create or replace function erp_fiscal_invoices.payment_input(p_value jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb:=erp_fiscal_invoices.invoice_specs();v jsonb;i jsonb;card jsonb;result jsonb:='[]';
begin
 if p_value is null or p_value='null'::jsonb then p_value:='{}'; end if;
 if jsonb_typeof(p_value)<>'object' or exists(select 1 from jsonb_object_keys(p_value) k where k not in('condition','installments','indicator')) then
  raise exception 'erp_fiscal_unknown_field' using errcode='22023'; end if;
 if coalesce(p_value->'indicator','null'::jsonb)<>'null'::jsonb and (jsonb_typeof(p_value->'indicator')<>'string' or p_value->>'indicator' not in('0','1')) then
  raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
 for v in select value from jsonb_array_elements(erp_fiscal_invoices.array_input(p_value->'installments',120)) loop
  if jsonb_typeof(v)<>'object' then raise exception 'erp_fiscal_value_invalid' using errcode='22023'; end if;
  i:=erp_fiscal_invoices.spec_object(v-'card',s->'installment');
  if not i ?& array['date','amount'] then raise exception 'erp_fiscal_invoice_installment_invalid' using errcode='22023'; end if;
  -- The forma must exist. One excluded later stays on the parcels that already carry it (the note keeps saving);
  -- erp_fiscal_invoice_execute (215) refuses it on a parcel that did not have it.
  if i?'payment_method_id' and not exists(select 1 from erp_catalog.payment_method m where m.id=(i->>'payment_method_id')::uuid) then
   raise exception 'erp_fiscal_invoice_payment_method_not_found' using errcode='22023'; end if;
  card:=case when v->'card' is null or v->'card'='null'::jsonb then null else erp_fiscal_invoices.spec_object(v->'card',s->'card') end;
  result:=result||jsonb_build_array(i||jsonb_build_object('card',card));
 end loop;
 return jsonb_build_object('condition',erp_fiscal_invoices.text_input(p_value->'condition',60),'installments',result)
  ||case when coalesce(p_value->'indicator','null'::jsonb)<>'null'::jsonb then jsonb_build_object('indicator',p_value->>'indicator') else '{}'::jsonb end;
end $$;

-- The composition of an item (the current structure of 222), when the matching "Desmembrar" preference is on; null otherwise.
create function erp_fiscal_invoices.order_composition(p_product uuid,p_physical boolean,p_virtual boolean) returns jsonb language sql stable set search_path=pg_catalog as $$
 select case when c.product_id is null or not((c.stock_type='physical' and p_physical) or (c.stock_type='virtual' and p_virtual)) then null else
  jsonb_build_object('stock_type',c.stock_type,
   'problem',(select case when count(*)=0 then 'structure_missing' when bool_or(erp_stock.component_problem(i.component_id) is not null) then 'component_unavailable' end
     from erp_stock.composition_current i where i.product_id=c.product_id),
   'components',coalesce((select jsonb_agg(jsonb_build_object('position',i.position,'product_id',i.component_id,'description',left(r.name,200),'code',nullif(r.code,''),
     'unit',p.unit,'quantity',i.quantity::numeric(18,6)::text,'price',case when p.price is null then null else erp_catalog.unit_price_numeric(p.price,10) end,
     'product',jsonb_build_object('kind',p.kind,'ncm',p.ncm,'gtin',p.gtin,'gtin_tax',p.gtin_tax,'cest',p.cest,'origin',p.origin,
      'gross_weight',p.gross_weight::text,'net_weight',p.net_weight::text,'volumes',p.volumes::text)) order by i.position)
    from erp_stock.composition_current i join erp_catalog.record r on r.id=i.component_id join erp_catalog.product p on p.record_id=i.component_id
    where i.product_id=c.product_id),'[]'::jsonb)) end
 from(select p_product id)x left join erp_stock.composition c on c.product_id=x.id
  and exists(select 1 from erp_catalog.product k where k.record_id=c.product_id and k.format='E')
$$;

-- v2 (215) plus the Detalhes de pagamento, the Forma and the Detalhes of each parcel, and the composition of each item.
create function erp_fiscal_invoices.order_source_v3(p_document_id uuid,p_model text) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document%rowtype;base jsonb;physical boolean;virtual boolean;items jsonb;parcels jsonb;
begin
 base:=erp_fiscal_invoices.order_source_v2(p_document_id,p_model);
 select * into d from erp_documents.document where id=p_document_id;
 physical:=d.kind in('sales_orders','service_orders') and (erp_fiscal_invoices.preference('vendas.desmembrar_fisico','boolean','false'))::text::boolean;
 virtual:=d.kind in('sales_orders','service_orders') and (erp_fiscal_invoices.preference('vendas.desmembrar_virtual','boolean','false'))::text::boolean;
 select coalesce(jsonb_agg(x.item||jsonb_build_object('composition',coalesce(case when x.item->>'product_id' is not null and (physical or virtual)
   then erp_fiscal_invoices.order_composition((x.item->>'product_id')::uuid,physical,virtual) end,'null'::jsonb)) order by x.n),'[]'::jsonb)
 into items from jsonb_array_elements(base->'items') with ordinality x(item,n);
 select coalesce(jsonb_agg(b.value||jsonb_build_object(
   'payment_method',coalesce((select jsonb_build_object('id',m.id,'description',m.description,'payment_type',m.payment_type,'card_brand',m.card_brand,
     'card_integration',m.card_integration,'card_cnpj',m.card_cnpj,'active',m.active)
    -- An excluded forma is not offered to a new note (215 refuses it on a new parcel); its tPag and card data still come in the details.
    from erp_catalog.payment_method m where src.value->>'payment_method_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and m.id=(src.value->>'payment_method_id')::uuid
     and m.deleted_at is null),'null'::jsonb),
   'details',case when jsonb_typeof(src.value->'details')='object' then (src.value->'details')-'account_id' else 'null'::jsonb end) order by b.n),'[]'::jsonb)
 into parcels from jsonb_array_elements(base->'installments') with ordinality b(value,n)
  left join lateral(select x.value from jsonb_array_elements(case when jsonb_typeof(d.body->'installments')='array' then d.body->'installments' else '[]' end) x
   where (x.value->>'position')::integer=(b.value->>'position')::integer limit 1) src on true;
 -- A foreign contact is no longer a refusal: the note opens as Exportação (the form fills it; nothing is emitted).
 base:=jsonb_set(base,'{reasons}',coalesce((select jsonb_agg(r order by n) from jsonb_array_elements(base->'reasons') with ordinality x(r,n) where r->>'code'<>'international'),'[]'::jsonb));
 base:=jsonb_set(base,'{eligible}',to_jsonb(jsonb_array_length(base->'reasons')=0));
 return base||jsonb_build_object('items',items,'installments',parcels,
  'payment',jsonb_build_object('means',case when d.kind='sales_orders' then coalesce(d.body->'payment_means','null'::jsonb) else 'null'::jsonb end,
   'indicator',case when d.kind='sales_orders' then coalesce(d.body->'payment_indicator','null'::jsonb) else 'null'::jsonb end));
end $$;
create function public.erp_fiscal_invoice_order_source_v3(p_user_id uuid,p_document_id uuid,p_model text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_kind text;
begin
 if p_document_id is null or p_model is null or p_model not in('55','65') then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 -- Same rule as 176 and 215: the pedido leaves only to the profiles that read its kind (erp_documents.allowed).
 select d.kind into v_kind from erp_documents.document d where d.id=p_document_id;
 if v_kind is not null and not erp_documents.allowed(role,v_kind,false) then raise exception 'erp_fiscal_invoice_forbidden' using errcode='42501'; end if;
 return erp_fiscal_invoices.order_source_v3(p_document_id,p_model)||jsonb_build_object('writable',role in('admin','fiscal'),'emission_enabled',false,'production_enabled',false,'data_mode','erp_native');
end $$;

revoke all on function erp_fiscal_invoices.payment_input(jsonb),erp_fiscal_invoices.order_composition(uuid,boolean,boolean),erp_fiscal_invoices.order_source_v3(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_invoice_order_source_v3(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_order_source_v3(uuid,uuid,text) to service_role;
commit;
