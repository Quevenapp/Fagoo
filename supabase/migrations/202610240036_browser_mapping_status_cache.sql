-- Only the supplementary mapping-gap count is cached. Job states, successes,
-- failures and histories remain live; no posting or observation is fabricated.
begin;
create function erp_sync.browser_unmapped_count()returns bigint
language sql stable set search_path=pg_catalog as $$
 with latest as materialized(select distinct on(entity,source_id)entity,source_id,stock_flag,stock_label from erp_sync.indicator_observation order by entity,source_id,observed_at desc)
 select count(*)from latest o where o.stock_flag is not null and
  (not exists(select 1 from erp_sync.indicator_products(o.entity,o.source_id))or not exists(select 1 from origin_sync.raw_record w where w.entity='warehouses'and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(o.stock_label from 'Depósito: (.+)$')))
$$;
create table erp_sync.browser_mapping_status_cache(
 singleton boolean primary key default true check(singleton),
 unmapped_documents bigint not null check(unmapped_documents>=0),refreshed_at timestamptz not null
);
insert into erp_sync.browser_mapping_status_cache values(true,erp_sync.browser_unmapped_count(),clock_timestamp());
alter table erp_sync.browser_mapping_status_cache enable row level security;
revoke all on erp_sync.browser_mapping_status_cache from public,anon,authenticated,service_role;
create function erp_sync.browser_refresh_mapping_status(p_force boolean)returns void
language plpgsql set search_path=pg_catalog as $$
declare refreshed timestamptz;
begin
 select refreshed_at into refreshed from erp_sync.browser_mapping_status_cache where singleton for update;
 if p_force or refreshed<=clock_timestamp()-interval '5 minutes'then
  update erp_sync.browser_mapping_status_cache set unmapped_documents=erp_sync.browser_unmapped_count(),refreshed_at=clock_timestamp()where singleton;
 end if;
end$$;
do $$
declare definition text;original text;
begin
 definition:=pg_get_functiondef('erp_sync.browser_status()'::regprocedure);
 original:=$old$(select count(*)from latest o where o.stock_flag is not null and
  (not exists(select 1 from erp_sync.indicator_products(o.entity,o.source_id))or not exists(select 1 from origin_sync.raw_record w where w.entity='warehouses'and coalesce(w.payload->>'descricao',w.payload->>'nome')=substring(o.stock_label from 'Depósito: (.+)$'))))$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_mapping_status_definition_changed';end if;
 execute replace(definition,original,$new$(select unmapped_documents from erp_sync.browser_mapping_status_cache where singleton)$new$);
 definition:=pg_get_functiondef('erp_sync.browser_discover_if_due(boolean)'::regprocedure);
 original:=E'end if;\nend';
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_mapping_refresh_definition_changed';end if;
 execute replace(definition,original,E'end if;\n perform erp_sync.browser_refresh_mapping_status(p_force);\nend');
end$$;
revoke all on function erp_sync.browser_unmapped_count(),erp_sync.browser_refresh_mapping_status(boolean)from public,anon,authenticated,service_role;
commit;
