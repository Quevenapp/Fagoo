-- Keep missing source identities actionable in synchronization, with automatic
-- resolution when exact evidence becomes available. Never enqueue operational writes.
begin;
create or replace function erp_sync.browser_refresh_mapping_status(p_force boolean)returns void
language plpgsql set search_path=pg_catalog as $$
declare refreshed timestamptz;missing jsonb;item jsonb;
begin
 select refreshed_at into refreshed from erp_sync.browser_mapping_status_cache where singleton for update;
 if p_force or refreshed<=clock_timestamp()-interval '5 minutes'then
  with latest as materialized(select distinct on(entity,source_id)entity,source_id,source_number,stock_flag,stock_label
   from erp_sync.indicator_observation order by entity,source_id,observed_at desc),
  targets as materialized(select distinct entity,source_id from erp_sync.browser_all_stock_targets())
  select coalesce(jsonb_agg(jsonb_build_object('entity',o.entity,'source_id',o.source_id,'number',o.source_number,
   'source_missing',not exists(select 1 from origin_sync.raw_record r where r.entity=o.entity and r.source_id=o.source_id))), '[]'::jsonb)
  into missing from latest o where o.stock_flag is not null and not exists(select 1 from targets t where(t.entity,t.source_id)=(o.entity,o.source_id));
  update erp_sync.browser_mapping_status_cache set unmapped_documents=jsonb_array_length(missing),refreshed_at=clock_timestamp()where singleton;
  update erp_sync.issue i set resolved_at=clock_timestamp()where i.resolved_at is null and i.direction='census'and i.code='BROWSER_STOCK_MAPPING_PENDING'
   and not exists(select 1 from jsonb_array_elements(missing)m where(m->>'entity',m->>'source_id')=(i.entity,i.source_id));
  for item in select value from jsonb_array_elements(missing)loop
   perform erp_sync.note_issue('census',item->>'entity',null,item->>'source_id','BROWSER_STOCK_MAPPING_PENDING',
    format('%s nº %s (ID %s): %s Não associar por nome, saldo ou número aproximado. Sincronizar agora não executa esta coleta.',
     item->>'entity',item->>'number',item->>'source_id',case when(item->>'source_missing')::boolean
     then 'Documento ausente do arquivo de origem sincronizado. Recuperar ou reconciliar esse ID exato antes de vincular o histórico.'
     else 'Itens sem identificação inequívoca de produto/depósito. Sincronizar os IDs exatos dos produtos e do depósito ou obter referência exata no histórico.'end));
  end loop;
 end if;
end$$;
revoke all on function erp_sync.browser_refresh_mapping_status(boolean)from public,anon,authenticated,service_role;
select erp_sync.browser_refresh_mapping_status(true);
commit;
