-- Make the financial-origin partial index usable for batched indicator lookups.
-- Keep payable direction even when the source title has not been imported yet.
begin;
create or replace function erp_sync.indicator_titles(p_entity text,p_source text,p_note text)returns table(source_id text,title_id uuid,direction text)
language sql stable set search_path=pg_catalog as $$
 select r.source_id,t.id,coalesce(t.kind,case r.entity when'payables'then'payable'else'receivable'end) from origin_sync.raw_record r
 left join erp_sync.link l on l.entity=r.entity and l.origin_id=r.source_id
 left join erp_finance.title t on t.id=l.record_id and not t.cancelled and t.deleted_at is null
 where r.entity in('receivables','payables') and r.entity=case when p_entity='purchase_orders' then 'payables' when p_entity in('nfe','nfce') then
  case (select payload->>'tipo' from origin_sync.raw_record where entity=p_entity and source_id=p_source)when '0'then 'payables'else 'receivables'end else 'receivables'end
 and r.payload->>'situacao' is distinct from '5'
 and ((p_entity in('nfe','nfce') and r.payload#>>'{origem,id}'=p_source and r.payload#>>'{origem,tipoOrigem}'='notafiscal'
   and not exists(select 1 from origin_sync.raw_record z where z.entity=case p_entity when'nfe'then'nfce'else'nfe'end and z.source_id=p_source))
  or(p_entity not in('nfe','nfce') and ((r.payload#>>'{origem,id}'=p_source and r.payload#>>'{origem,tipoOrigem}'=any(case p_entity when'purchase_orders'then array['compra']when'service_orders'then array['ordemservico']else array['venda','pedido']end))
    or(p_note is not null and r.payload#>>'{origem,id}'=p_note and r.payload#>>'{origem,tipoOrigem}'='notafiscal'))))
$$;
revoke all on function erp_sync.indicator_titles(text,text,text)from public,anon,authenticated,service_role;
commit;
