begin;
-- Alternate ready history/indicator work, including after failed attempts, so a large
-- history backlog cannot postpone every badge refresh until its final product.
create index if not exists browser_job_last_claim on erp_sync.browser_job(claimed_at desc,id desc)where claimed_at is not null;
do $$
declare definition text; original text:=$old$order by case kind when 'stock_history'then 0 else 1 end,due_at,id limit 1 for update skip locked$old$;
 replacement text:=$new$order by case when kind<>coalesce((select b.kind from erp_sync.browser_job b where b.claimed_at is not null order by b.claimed_at desc,b.id desc limit 1),'indicators')then 0 else 1 end,due_at,id limit 1 for update skip locked$new$;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_claim_definition_changed';end if;
 execute replace(definition,original,replacement);
end$$;
commit;
