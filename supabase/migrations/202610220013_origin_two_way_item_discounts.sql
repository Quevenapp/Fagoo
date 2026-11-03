-- Mão dupla (009-012): pedidos do Origin cujo total ignora o desconto percentual dos itens.
-- Há pedidos em que o Origin guarda um percentual em cada item, mas o total é totalProdutos (soma bruta de
-- quantidade x valor) menos o desconto do pedido, mais frete e outras despesas. Aplicar os dois descontos fazia o
-- desconto do pedido passar do subtotal (erp_document_discount_exceeds_subtotal). Quando as contas do próprio Origin
-- mostram isso, os itens entram sem desconto e vale só o desconto do pedido, chegando ao mesmo total do Origin.
begin;

create function erp_sync.origin_item_discounts(p_payload jsonb,p_items jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_gross numeric; v_products numeric; v_total numeric; v_discount numeric; v_freight numeric; v_other numeric;
begin
 if jsonb_typeof(p_items)<>'array' or not exists(select 1 from jsonb_array_elements(p_items) i where coalesce((i->>'discount_percent')::numeric,0)<>0)
  then return p_items; end if;
 v_products:=erp_sync.origin_number(p_payload->'totalProdutos')::numeric;
 v_total:=erp_sync.origin_number(p_payload->'total')::numeric;
 v_discount:=case when jsonb_typeof(p_payload->'desconto')='object' then
   case when coalesce(p_payload#>>'{desconto,unidade}','REAL')='REAL' then erp_sync.origin_number(p_payload#>'{desconto,valor}')::numeric end
  else erp_sync.origin_number(p_payload->'desconto')::numeric end;
 v_freight:=coalesce(erp_sync.origin_number(p_payload#>'{transporte,frete}')::numeric,0);
 v_other:=coalesce(erp_sync.origin_number(p_payload->'outrasDespesas')::numeric,0);
 if v_products is null or v_total is null or v_discount is null then return p_items; end if;
 select sum((i->>'quantity')::numeric*(i->>'unit_price')::numeric) into v_gross from jsonb_array_elements(p_items) i;
 if abs(v_gross-v_products)>0.01 or abs(v_products-v_discount+v_freight+v_other-v_total)>0.01 then return p_items; end if;
 return (select jsonb_agg(i||jsonb_build_object('discount_percent','0') order by n) from jsonb_array_elements(p_items) with ordinality t(i,n));
end$$;
revoke all on function erp_sync.origin_item_discounts(jsonb,jsonb) from public,anon,authenticated,service_role;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_sync.pull_document(origin_sync.raw_record)'::regprocedure),E'\r','');
 v_new:=replace(v_def,E' if jsonb_array_length(v_items)=0 and s.entity<>''service_orders'' then raise exception ''ITEMS_UNAVAILABLE''',
  E' v_items:=erp_sync.origin_item_discounts(s.payload,v_items);\n if jsonb_array_length(v_items)=0 and s.entity<>''service_orders'' then raise exception ''ITEMS_UNAVAILABLE''');
 if v_new=v_def then raise exception 'origin_two_way_013_pull_document_changed'; end if;
 execute v_new;
end$$;

update erp_sync.inbox set retry_at='-infinity',error=null where error like 'erp_document_discount_exceeds_subtotal%';
update erp_sync.issue set resolved_at=clock_timestamp() where resolved_at is null and code='erp_document_discount_exceeds_subtotal';

commit;
