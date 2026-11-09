-- A deterministic optimistic-version/idempotency conflict is not a PostgreSQL
-- serialization failure. PostgREST 14 retries SQLSTATE 40001 indefinitely.
-- PT409 is its explicit HTTP conflict code and does not request a transaction retry.
-- Keep the historical migrations and function ACLs/attributes unchanged.
begin;
do $migration$
declare target record;definition text;occurrences integer;
begin
 for target in select * from(values
  ('public.fagoo_command(uuid,uuid,text,jsonb)',3),
  ('public.fagoo_crm_command(uuid,uuid,uuid,text,jsonb)',3),
  ('public.fagoo_relationship_link(uuid,uuid,uuid,uuid,uuid,integer)',2),
  ('public.fagoo_consolidation_import(uuid,jsonb)',1)
 ) as targets(signature,expected) loop
  select pg_get_functiondef(target.signature::regprocedure) into definition;
  occurrences:=(length(definition)-length(replace(definition,'''40001''','')))/length('''40001''');
  if occurrences<>target.expected then
   raise exception 'fagoo_business_conflict_definition_changed: %',target.signature;
  end if;
  execute replace(definition,'''40001''','''PT409''');
 end loop;
end $migration$;
commit;
