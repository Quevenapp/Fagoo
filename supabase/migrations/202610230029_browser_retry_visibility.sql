begin;
-- A failed attempt waiting for retry must remain visible in the error counter.
do $$
declare definition text;original text:=$old$'failed',count(*)filter(where state='failed')$old$;
begin
 definition:=pg_get_functiondef('erp_sync.browser_status()'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_status_definition_changed';end if;
 execute replace(definition,original,$new$'failed',count(*)filter(where state='failed'or error is not null)$new$);
end$$;
commit;
