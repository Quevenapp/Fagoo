begin;
-- One rendered day list can satisfy many exact-ID jobs. No ledger/outbox writes.
create function erp_sync.browser_document_date(p_entity text,p_payload jsonb)returns text
language sql immutable set search_path=pg_catalog as $$
 select left(coalesce(case when p_entity='nfe'and p_payload->>'tipo'='0'then nullif(p_payload->>'dataOperacao','')end,
 nullif(p_payload->>'data',''),nullif(p_payload->>'dataEmissao',''),nullif(p_payload->>'dataEntrada','')),10)
$$;
create index raw_browser_document_day on origin_sync.raw_record(entity,erp_sync.browser_document_date(entity,payload),source_id)
 where entity in('sales_orders','purchase_orders','service_orders','nfe','nfce');

create function erp_sync.browser_indicator_targets(p_task jsonb)returns jsonb
language sql stable set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id,'number',number)order by primary_row desc,source_id),'[]'::jsonb)
 from(
  select r.source_id,r.payload->>'numero'number,r.source_id=p_task->>'source_id'primary_row
  from origin_sync.raw_record r left join erp_sync.browser_job b on b.job_key='I:'||r.entity||':'||r.source_id
  where r.entity=p_task->>'entity'and r.payload->>'numero'~'^[0-9]{1,20}$'
   and erp_sync.browser_document_date(r.entity,r.payload)=p_task->>'date'
   and(case when r.entity='nfe'and r.payload->>'tipo'='0'then'in'else'out'end)=p_task->>'direction'
   and(r.source_id=p_task->>'source_id'or b.id is null or b.state<>'running'and(b.state<>'done'or b.due_at<=now()))
  order by primary_row desc,r.source_id limit 1000
 )targets
$$;

create function erp_sync.browser_finish_indicators(p_job erp_sync.browser_job,p_observation jsonb,p_stamp timestamptz)returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare x jsonb; result jsonb; t jsonb;
begin
 if p_observation->>'entity'is distinct from p_job.task->>'entity'
  or jsonb_array_length(p_observation->'items')not between 1 and 1000
  or not exists(select 1 from jsonb_array_elements(p_observation->'items')v where v->>'source_id'=p_job.task->>'source_id'
   and ltrim(v->>'number','0')=ltrim(p_job.task->>'number','0'))then raise exception 'browser_identity_mismatch'using errcode='22023';end if;
 -- Unknown IDs, other dates/directions and mismatching numbers cannot enter a batch.
 for x in select value from jsonb_array_elements(p_observation->'items')loop
  if not exists(select 1 from origin_sync.raw_record r where r.entity=p_observation->>'entity'and r.source_id=x->>'source_id'
   and ltrim(r.payload->>'numero','0')=ltrim(x->>'number','0')
   and erp_sync.browser_document_date(r.entity,r.payload)=p_job.task->>'date'
   and(case when r.entity='nfe'and r.payload->>'tipo'='0'then'in'else'out'end)=p_job.task->>'direction')
  then raise exception 'browser_identity_mismatch'using errcode='22023';end if;
 end loop;
 result:=public.erp_sync_indicator_observe(p_observation->>'entity',p_stamp,p_observation->'items');
 -- Complete only actually observed peers; absent rows retain their state. Do not
 -- steal another administrator's running lease. The primary gets its hash below.
 for x in select value from jsonb_array_elements(p_observation->'items')loop
  if x->>'source_id'=p_job.task->>'source_id'then continue;end if;
  t:=jsonb_build_object('entity',p_job.task->>'entity','source_id',x->>'source_id','number',x->>'number',
   'date',p_job.task->>'date','direction',p_job.task->>'direction');
  insert into erp_sync.browser_job(job_key,kind,task,state,last_completed_at,due_at,receipt)
   values('I:'||(p_job.task->>'entity')||':'||(x->>'source_id'),'indicators',t,'done',now(),now()+interval '24 hours',
    jsonb_build_object('processed',1,'batch_job_id',p_job.id,'operational_effects',false))
   on conflict(job_key)do update set state='done',task=excluded.task,last_completed_at=excluded.last_completed_at,
    due_at=excluded.due_at,attempts=0,error=null,receipt=excluded.receipt,claim_token=null,claimed_by=null,claimed_at=null
   where erp_sync.browser_job.state<>'running';
 end loop;
 return result;
end$$;

do $$
declare definition text; original text; replacement text;
begin
 definition:=pg_get_functiondef('public.erp_sync_browser(uuid,text,uuid,uuid,jsonb,text)'::regprocedure);
 original:=$old$order by case when kind<>coalesce((select b.kind from erp_sync.browser_job b where b.claimed_at is not null order by b.claimed_at desc,b.id desc limit 1),'indicators')then 0 else 1 end,due_at,id limit 1 for update skip locked$old$;
 replacement:=$new$order by case when kind<>coalesce((select b.kind from erp_sync.browser_job b where b.claimed_at is not null order by b.claimed_at desc,b.id desc limit 1),'indicators')then 0 else 1 end,
  case when last_completed_at is null then 0 else 1 end,case when error is null then 0 else 1 end,
  task->>'date'desc nulls last,due_at,id limit 1 for update skip locked$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_claim_definition_changed';end if;
 definition:=replace(definition,original,replacement);
 original:=$old$'kind',j.kind,'task',j.task$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_task_definition_changed';end if;
 definition:=replace(definition,original,$new$'kind',j.kind,'task',case when j.kind='indicators'then j.task||jsonb_build_object('targets',erp_sync.browser_indicator_targets(j.task))else j.task end$new$);
 original:=$old$if o->>'entity'<>j.task->>'entity' or jsonb_array_length(o->'items')<>1 or o#>>'{items,0,source_id}'<>j.task->>'source_id'
   or ltrim(o#>>'{items,0,number}','0')<>ltrim(j.task->>'number','0') then raise exception 'browser_identity_mismatch'using errcode='22023';end if;
  result:=public.erp_sync_indicator_observe(o->>'entity',stamp,o->'items');$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_finish_definition_changed';end if;
 execute replace(definition,original,$new$result:=erp_sync.browser_finish_indicators(j,o,stamp);$new$);
 definition:=pg_get_functiondef('erp_sync.browser_enqueue()'::regprocedure);
 original:=$old$order by r.last_seen_at desc,r.entity,r.source_id limit 100$old$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_discovery_definition_changed';end if;
 execute replace(definition,original,$new$order by erp_sync.browser_document_date(r.entity,r.payload)desc nulls last,r.last_seen_at desc,r.entity,r.source_id limit 100$new$);
end$$;
revoke all on function erp_sync.browser_document_date(text,jsonb),erp_sync.browser_indicator_targets(jsonb),
 erp_sync.browser_finish_indicators(erp_sync.browser_job,jsonb,timestamptz)from public,anon,authenticated,service_role;
commit;
