-- A product's stable source ID wins over an obsolete code stored in a queue task.
-- Preserve the old failed task in the immutable audit before requesting a new read.
begin;
create function erp_sync.browser_reconcile_product_jobs()returns void
language plpgsql set search_path=pg_catalog as $$
begin
 update erp_sync.browser_job j set task=jsonb_set(j.task,'{product_code}',to_jsonb(p.payload->>'codigo')),
  state='pending',due_at=now(),attempts=0,error=null,claim_token=null,claimed_at=null,claimed_by=null
 from origin_sync.raw_record p where j.kind='stock_history'and j.state in('pending','failed','done')
 and p.entity='products'and p.source_id=j.task->>'product_source_id'
 and nullif(p.payload->>'codigo','')is not null and length(p.payload->>'codigo')<=100
 and coalesce(p.payload#>>'{_brufap_source,deleted}','false')<>'true'
 and p.payload->>'codigo'is distinct from j.task->>'product_code';
end$$;
create function erp_sync.browser_resolve_product_code_issue()returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if new.kind='stock_history'and new.state='done'and new.error is null and new.claim_token is not null
 and exists(select 1 from erp_sync.stock_history_snapshot s join origin_sync.raw_record p on p.entity='products'and p.source_id=s.product_source_id
 where s.job_id=new.id and s.claim_token=new.claim_token and s.product_code=p.payload->>'codigo'and s.product_code=new.task->>'product_code')then
  update erp_sync.issue set resolved_at=clock_timestamp()where code='BROWSER_PRODUCT_CODE_CHANGED'and direction='census'and entity='products'
   and source_id=new.task->>'product_source_id'and resolved_at is null;
 end if;
 return new;
end$$;
create trigger browser_resolve_product_code_issue after update on erp_sync.browser_job for each row execute function erp_sync.browser_resolve_product_code_issue();
alter function erp_sync.browser_enqueue()rename to browser_enqueue_without_product_reconciliation;
create function erp_sync.browser_enqueue()returns void language plpgsql set search_path=pg_catalog as $$
begin perform erp_sync.browser_enqueue_without_product_reconciliation();perform erp_sync.browser_reconcile_product_jobs();end$$;
revoke all on function erp_sync.browser_reconcile_product_jobs(),erp_sync.browser_resolve_product_code_issue(),erp_sync.browser_enqueue_without_product_reconciliation(),erp_sync.browser_enqueue()from public,anon,authenticated,service_role;
commit;
