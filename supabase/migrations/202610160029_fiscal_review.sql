-- Read-only comparison. Existing draft snapshots/revisions are never rewritten.
begin;
create function public.erp_fiscal_draft_review(p_user_id uuid,p_id uuid,p_revision integer default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d jsonb;products jsonb;
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 d:=public.erp_fiscal_draft_get(p_user_id,p_id,p_revision);
 select coalesce(jsonb_agg(jsonb_build_object('product_id',ids.id,'record',
   case when r.id is null or p.record_id is null then null else jsonb_build_object(
    'id',r.id,'version',r.version,'active',r.active,'name',r.name,'code',r.code,
    'unit',p.unit,'kind',p.kind,'format',p.format,'ncm',p.ncm,'gtin',p.gtin,
    'origin',p.origin,'cest',p.cest,'gtin_tax',p.gtin_tax) end) order by ids.id),'[]'::jsonb)
 into products
 from(select distinct (value->>'product_id')::uuid id from jsonb_array_elements(d#>'{record,snapshot,items}')
      where value->>'product_id' is not null) ids
 left join erp_catalog.record r on r.id=ids.id and r.entity='products'
 left join erp_catalog.product p on p.record_id=r.id;
 return jsonb_build_object('draft',d,'catalog',products,'observed_at',statement_timestamp());
end; $$;
revoke all on function public.erp_fiscal_draft_review(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.erp_fiscal_draft_review(uuid,uuid,integer) to service_role;
commit;
