-- Mão dupla (009-011), correções do recebimento em produção (22/10/2026).
-- 1. Gatilhos adiados de documentos rodam no COMMIT com o papel da sessão (no PostgreSQL 17, o service_role da API),
--    que não tem USAGE em erp_finance/erp_documents/erp_fiscal_invoices: "permission denied for schema erp_finance"
--    derrubava a chamada inteira do aplicador e qualquer gravação de pedido de venda pela API. Passam a rodar como o dono.
-- 2. Textos do Origin com caracteres de controle (e-mail com quebra de linha, descrição colada de site) eram recusados
--    pela validação do catálogo. O aplicador limpa os textos antes de validar; a descrição curta acima do limite do
--    Brufap não é trazida (fica nula no Brufap e o envio preserva a do Origin, que não recebe campos nulos).
begin;

alter function erp_finance.commission_operation_capture() security definer;
alter function erp_documents.cost_apply_capture() security definer;
alter function erp_fiscal_invoices.check_sales_item_links() security definer;
revoke all on function erp_finance.commission_operation_capture(),erp_documents.cost_apply_capture(),
 erp_fiscal_invoices.check_sales_item_links() from public,anon,authenticated,service_role;

-- Campos de várias linhas mantêm \n, \r e \t; nos demais viram espaço. Os outros caracteres de controle saem sempre.
create function erp_sync.clean_source(p_value jsonb,p_key text default null) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v_text text;
begin
 case jsonb_typeof(p_value)
  when 'object' then
   return (select coalesce(jsonb_object_agg(k,erp_sync.clean_source(v,k)),'{}'::jsonb) from jsonb_each(p_value) e(k,v));
  when 'array' then
   return (select coalesce(jsonb_agg(erp_sync.clean_source(v,p_key) order by n),'[]'::jsonb) from jsonb_array_elements(p_value) with ordinality a(v,n));
  when 'string' then
   v_text:=regexp_replace(p_value#>>'{}',E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]','','g');
   if p_key is null or p_key not in('descricaoCurta','descricaoComplementar','observacoes','dadosAdicionais') then
    v_text:=regexp_replace(v_text,E'[\\t\\r\\n]+',' ','g');
   end if;
   return to_jsonb(btrim(v_text,E' \t\r\n'));
  else return p_value;
 end case;
end$$;
revoke all on function erp_sync.clean_source(jsonb,text) from public,anon,authenticated,service_role;

create function erp_sync.catalog_source(p_entity text,p_payload jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb:=erp_sync.clean_source(p_payload);
begin
 if p_entity='products' and jsonb_typeof(v->'descricaoCurta')='string'
  and (length(v->>'descricaoCurta')>4000 or octet_length(v->>'descricaoCurta')>12000) then
  v:=jsonb_set(v,'{descricaoCurta}','null'::jsonb);
 end if;
 return v;
end$$;
revoke all on function erp_sync.catalog_source(text,jsonb) from public,anon,authenticated,service_role;

do $$declare v_def text; v_new text;
begin
 v_def:=replace(pg_get_functiondef('erp_sync.pull_catalog(origin_sync.raw_record)'::regprocedure),E'\r','');
 v_new:=replace(v_def,'v_data:=erp_catalog.map_origin(s.entity,s.payload);',
  'v_data:=erp_catalog.map_origin(s.entity,erp_sync.catalog_source(s.entity,s.payload));');
 if v_new=v_def then raise exception 'origin_two_way_012_pull_catalog_changed'; end if;
 execute v_new;
end$$;

-- Os registros recusados voltam para a fila agora, sem esperar a espera crescente.
update erp_sync.inbox set retry_at='-infinity',error=null where error like 'erp_catalog_invalid_text%';
update erp_sync.issue set resolved_at=clock_timestamp() where resolved_at is null and code='erp_catalog_invalid_text';

commit;
