begin;
-- The incoming-invoice list defaults to Data de entrada, which the public detail
-- supplies as dataOperacao. Emission and entry can be on different days.
do $$
declare definition text;original text:=$old$left(coalesce(nullif(r.payload->>'data',''),nullif(r.payload->>'dataEmissao',''),nullif(r.payload->>'dataEntrada','')),10)$old$;
replacement text:=$new$left(coalesce(case when r.entity='nfe'and r.payload->>'tipo'='0'then nullif(r.payload->>'dataOperacao','')end,nullif(r.payload->>'data',''),nullif(r.payload->>'dataEmissao',''),nullif(r.payload->>'dataEntrada','')),10)$new$;
begin
 definition:=pg_get_functiondef('erp_sync.browser_enqueue()'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_enqueue_definition_changed';end if;
 execute replace(definition,original,replacement);
end$$;
update erp_sync.browser_job j set task=jsonb_set(j.task,'{date}',to_jsonb(left(r.payload->>'dataOperacao',10))),
 due_at=case when j.state in('pending','failed')then now()else j.due_at end,
 state=case when j.state='failed'then'pending'else j.state end,error=null,attempts=0
from origin_sync.raw_record r where j.kind='indicators'and j.state<>'running'and r.entity='nfe'and r.payload->>'tipo'='0'
 and j.task->>'entity'=r.entity and j.task->>'source_id'=r.source_id and r.payload->>'dataOperacao'~'^\d{4}-\d{2}-\d{2}'
 and j.task->>'date'is distinct from left(r.payload->>'dataOperacao',10);
commit;
