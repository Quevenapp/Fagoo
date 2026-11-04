-- Collection evidence only: retain failures before retrying; no Origin/native writes.
begin;
create table erp_sync.browser_job_event(
 id bigint generated always as identity primary key,
 job_id uuid not null references erp_sync.browser_job,
 event text not null check(event in('existing_failure','failed_attempt','retry_requested','recheck_requested')),
 recorded_at timestamptz not null default clock_timestamp(),
 state text not null, error text, attempts integer not null,
 claimed_at timestamptz, task jsonb not null
);
alter table erp_sync.browser_job_event enable row level security;
revoke all on erp_sync.browser_job_event from public,anon,authenticated,service_role;
create trigger browser_job_event_immutable before update or delete on erp_sync.browser_job_event
 for each row execute function erp_sync.indicator_observation_immutable();
insert into erp_sync.browser_job_event(job_id,event,state,error,attempts,claimed_at,task)
 select id,'existing_failure',state,error,attempts,claimed_at,task from erp_sync.browser_job where error is not null;
create function erp_sync.browser_job_audit()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.state='pending'and old.state in('failed','done')then
  insert into erp_sync.browser_job_event(job_id,event,state,error,attempts,claimed_at,task)
   values(old.id,case when old.state='failed'then'retry_requested'else'recheck_requested'end,old.state,old.error,old.attempts,old.claimed_at,old.task);
 elsif new.error is not null and (new.error,new.attempts,new.claimed_at,new.state)is distinct from(old.error,old.attempts,old.claimed_at,old.state)then
  insert into erp_sync.browser_job_event(job_id,event,state,error,attempts,claimed_at,task)
   values(new.id,'failed_attempt',new.state,new.error,new.attempts,new.claimed_at,new.task);
 end if;
 return new;
end$$;
create trigger browser_job_audit after update on erp_sync.browser_job for each row execute function erp_sync.browser_job_audit();
revoke all on function erp_sync.browser_job_audit()from public,anon,authenticated,service_role;

-- A finance icon without its observed tooltip cannot prove a posting. Older
-- NFC-e context-menu icons sometimes entered that shape; keep old evidence
-- immutable and require a new observation to establish its real badge state.
do $$
declare definition text; original text;
begin
 definition:=pg_get_functiondef('public.erp_sync_indicator_observe(text,timestamptz,jsonb)'::regprocedure);
 original:=$old$or jsonb_typeof(x->'finance')<>'boolean'$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_finance_validation_definition_changed';end if;
 execute replace(definition,original,$new$or ((x->'finance'='true'::jsonb)is distinct from(x->>'finance_label'is not null))
   or jsonb_typeof(x->'finance')<>'boolean'$new$);
 definition:=pg_get_functiondef('public.erp_synced_effect_indicators_without_history(uuid,text,jsonb,text)'::regprocedure);
 original:=$old$coalesce(o.finance,v_count>0)$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_finance_display_definition_changed';end if;
 execute replace(definition,original,$new$coalesce(case when o.finance and o.finance_label is null then null else o.finance end,v_count>0)$new$);
end$$;
commit;
