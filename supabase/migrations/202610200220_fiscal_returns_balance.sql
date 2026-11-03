-- 220: modal "Devolução de produto" (⋮ Gerar devolução, Origin), onda D.
-- erp_fiscal_invoice_returned: as notas de devolução do Brufap (finalidade 4, não excluídas, nem canceladas ou denegadas) que referenciam a chave da nota e as
-- quantidades já devolvidas por produto, código e descrição, para o modal mostrar Total saída/entrada, Total devolvidos e o aviso
-- "A nota fiscal já possui devolução efetuada". Somente leitura, para os perfis da nota (admin e fiscal); a nota de devolução
-- continua sendo gravada pelo formulário. O retorno ao estoque e o estorno ou crédito financeiro continuam desligados.
begin;

create function public.erp_fiscal_invoice_returned(p_user_id uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare role text:=erp_fiscal_invoices.require_write(p_user_id);v_notes jsonb;v_items jsonb;
begin
 if p_key is null or p_key !~ '^[0-9]{44}$' then raise exception 'erp_fiscal_query_invalid' using errcode='22023'; end if;
 with returns as materialized(
  select v.* from erp_fiscal_invoices.invoice v
  -- A cancelled (3) or denied (10) return gave nothing back, like the entry reports of 146.
  where v.deleted_at is null and v.purpose='4' and v.status not in(3,10) and v.access_key is distinct from p_key
   and exists(select 1 from jsonb_array_elements(v.doc_references) r where r->>'key'=p_key))
 select coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'model',r.model,'direction',r.direction,'number',r.number,'series',r.series,'issue_date',r.issue_date,'status',r.status)
   order by r.issue_date,r.created_at,r.id) from (select * from returns order by issue_date,created_at,id limit 50) r),'[]'::jsonb),
  coalesce((select jsonb_agg(jsonb_build_object('product_id',x.product_id,'code',x.code,'description',x.description,'quantity',x.quantity::text) order by x.description,x.code,x.product_id) from(
   select i.product_id,left(i.data->>'code',60) code,left(i.data->>'description',120) description,sum(i.quantity) quantity
   from returns v join erp_fiscal_invoices.invoice_item i on i.invoice_id=v.id group by 1,2,3 limit 990) x),'[]'::jsonb)
 into v_notes,v_items;
 return jsonb_build_object('key',p_key,'returns',v_notes,'items',v_items,'data_mode','erp_native');
end $$;

revoke all on function public.erp_fiscal_invoice_returned(uuid,text) from public,anon,authenticated;
grant execute on function public.erp_fiscal_invoice_returned(uuid,text) to service_role;
commit;
