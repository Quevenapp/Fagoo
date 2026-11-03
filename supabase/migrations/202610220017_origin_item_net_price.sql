-- Mão dupla (009-016): no Origin, o "valor" do item do pedido e da proposta já é o preço com desconto; o "desconto" do item é
-- informativo (o percentual sobre o preço de tabela). Em produção, nos 19.311 documentos com desconto no item, totalProdutos
-- é sempre a soma de quantidade x valor. Aplicar o percentual de novo deixava o total do Brufap até 30% menor que o do Origin.
-- Recebimento: o item entra com o valor do Origin e sem desconto (substitui a regra condicional da 013).
-- Envio: o valor vai líquido (preço x (1 - desconto)) e o percentual segue como informação, para o Origin chegar ao mesmo total.
-- Os documentos já convertidos com desconto no item voltam para a fila e são reaplicados como o aplicador (nada vai ao Origin).
begin;

create or replace function erp_sync.origin_item_discounts(p_payload jsonb,p_items jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(p_items)='array' then
  coalesce((select jsonb_agg(i||jsonb_build_object('discount_percent','0') order by n) from jsonb_array_elements(p_items) with ordinality t(i,n)),'[]'::jsonb)
  else p_items end
$$;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_sync.document_request(text,uuid,text)'::regprocedure),E'\r','');
 v_new:=replace(v_def,'''desconto'',erp_sync.num(i.discount_percent),''valor'',erp_sync.num(i.unit_price),',
  '''desconto'',erp_sync.num(i.discount_percent),''valor'',erp_sync.num(round(i.unit_price*(1-coalesce(i.discount_percent,0)/100),4)),');
 if (length(v_def)-length(replace(v_def,'''desconto'',erp_sync.num(i.discount_percent),''valor'',erp_sync.num(i.unit_price),','')))
   /length('''desconto'',erp_sync.num(i.discount_percent),''valor'',erp_sync.num(i.unit_price),')<>2 then
  raise exception 'origin_two_way_017_document_request_changed'; end if;
 execute v_new;
end$$;

-- Reaplicar os documentos convertidos que ficaram com desconto no item.
with affected as (
 select distinct d.kind,l.origin_id from erp_documents.document d
 join erp_sync.link l on l.entity=d.kind and l.record_id=d.id
 join erp_documents.item i on i.document_id=d.id
 where d.origin='origin' and d.kind in('sales_orders','sales_proposals') and coalesce(i.discount_percent,0)<>0),
reset as (update erp_sync.link l set pulled_hash=null from affected a where l.entity=a.kind and l.origin_id=a.origin_id returning l.entity,l.origin_id)
insert into erp_sync.inbox(entity,source_id,version)
select r.entity,r.source_id,r.version from reset x join origin_sync.raw_record r on r.entity=x.entity and r.source_id=x.origin_id
on conflict(entity,source_id) do update set version=excluded.version,retry_at='-infinity',error=null,attempts=0;

commit;
