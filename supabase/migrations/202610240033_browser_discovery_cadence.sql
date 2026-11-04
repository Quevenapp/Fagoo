begin;
-- Discovery scans the source archive. Repeating it under the claim advisory
-- lock for every parallel slot needlessly delays the other nine leases.
create table erp_sync.browser_discovery_gate(
 singleton boolean primary key default true check(singleton),refreshed_at timestamptz not null
);
insert into erp_sync.browser_discovery_gate values(true,'-infinity');
alter table erp_sync.browser_discovery_gate enable row level security;
revoke all on erp_sync.browser_discovery_gate from public,anon,authenticated,service_role;
create function erp_sync.browser_discover_if_due(p_force boolean)returns void
language plpgsql set search_path=pg_catalog as $$
declare refreshed timestamptz;
begin
 select refreshed_at into refreshed from erp_sync.browser_discovery_gate where singleton for update;
 if p_force or refreshed<=clock_timestamp()-interval '30 seconds'then
  perform erp_sync.browser_enqueue();
  update erp_sync.browser_discovery_gate set refreshed_at=clock_timestamp()where singleton;
 end if;
end$$;
do $$
declare definition text;original text:=$old$perform erp_sync.browser_enqueue();$old$;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_discovery_cadence_definition_changed';end if;
 execute replace(definition,original,$new$perform erp_sync.browser_discover_if_due(p_action='enqueue');$new$);
end$$;
revoke all on function erp_sync.browser_discover_if_due(boolean)from public,anon,authenticated,service_role;
commit;
