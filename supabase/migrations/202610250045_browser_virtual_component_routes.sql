-- Virtual compositions have no physical ledger of their own. Route their
-- consultation to exact declared components; never store an empty parent history.
begin;
alter table erp_sync.browser_job drop constraint browser_job_state_check;
alter table erp_sync.browser_job add constraint browser_job_state_check check(state in('pending','running','done','failed','delegated'));
alter table erp_sync.browser_job_event drop constraint browser_job_event_event_check;
alter table erp_sync.browser_job_event add constraint browser_job_event_event_check check(event in('existing_failure','failed_attempt','retry_requested','recheck_requested','component_routed'));
create table erp_sync.browser_component_route(
 job_id uuid not null references erp_sync.browser_job,evidence_hash text not null,
 product_source_id text not null,product_code text not null,warehouse_source_id text not null,
 structure_hash text not null,components jsonb not null check(jsonb_typeof(components)='array'and jsonb_array_length(components)between 1 and 100),
 recorded_at timestamptz not null default clock_timestamp(),primary key(job_id,evidence_hash)
);
alter table erp_sync.browser_component_route enable row level security;
revoke all on erp_sync.browser_component_route from public,anon,authenticated,service_role;
create trigger browser_component_route_immutable before update or delete on erp_sync.browser_component_route for each row execute function erp_sync.indicator_observation_immutable();
create function erp_sync.browser_product_components(p_source text)
returns table(source_id text,code text,quantity text,parent_code text,structure_hash text)
language sql stable set search_path=pg_catalog as $$
 with parent as materialized(select *from origin_sync.raw_record where entity='products'and source_id=p_source
  and payload->>'formato'='E'and payload#>>'{estrutura,tipoEstoque}'='V'
  and nullif(payload->>'codigo','')is not null and length(payload->>'codigo')<=100
  and coalesce(payload#>>'{_brufap_source,deleted}','false')<>'true'
  and jsonb_typeof(payload#>'{estrutura,componentes}')='array'),
 parts as materialized(select p.payload->>'codigo'parent_code,encode(sha256(convert_to((p.payload->'estrutura')::text,'UTF8')),'hex')structure_hash,
  c#>>'{produto,id}'id,c->>'quantidade'quantity from parent p cross join lateral jsonb_array_elements(p.payload#>'{estrutura,componentes}')c),
 checked as materialized(select c.*,p.payload->>'codigo'code,
  c.id~'^[1-9][0-9]{0,39}$'and c.id<>p_source and nullif(p.payload->>'codigo','')is not null and length(p.payload->>'codigo')<=100
  and coalesce(p.payload#>>'{_brufap_source,deleted}','false')<>'true'
  and not(coalesce(p.payload->>'formato','')='E'and coalesce(p.payload#>>'{estrutura,tipoEstoque}','')='V')
  and case when c.quantity~'^[0-9]{1,18}(\.[0-9]{1,12})?$'then c.quantity::numeric>0 else false end valid
  from parts c left join origin_sync.raw_record p on p.entity='products'and p.source_id=c.id)
 select id,code,quantity,parent_code,structure_hash from checked
 where(select count(*)between 1 and 100 and count(*)=count(distinct id)and bool_and(valid is true)from checked)
$$;
create function erp_sync.browser_resolve_component_issues()returns void
language sql set search_path=pg_catalog as $$
 update erp_sync.issue i set resolved_at=clock_timestamp()where i.resolved_at is null and i.direction='census'
 and i.entity='products'and i.code='BROWSER_COMPONENT_VIRTUAL_HISTORY'
 and exists(select 1 from erp_sync.browser_job j where j.kind='stock_history'and j.state='delegated'and j.task->>'product_source_id'=i.source_id
  and exists(select 1 from erp_sync.browser_product_components(i.source_id))
  and not exists(select 1 from erp_sync.browser_product_components(i.source_id)c where not exists(
   select 1 from erp_sync.stock_history_snapshot s where s.product_source_id=c.source_id and s.product_code=c.code
   and s.warehouse_source_id=j.task->>'warehouse_source_id'
   and not exists(select 1 from erp_sync.stock_history_snapshot newer where newer.product_source_id=s.product_source_id and newer.warehouse_source_id=s.warehouse_source_id
    and(newer.observed_at,newer.recorded_at,newer.id)>(s.observed_at,s.recorded_at,s.id)))))
$$;
create function erp_sync.browser_reconcile_virtual_jobs()returns void
language plpgsql set search_path=pg_catalog as $$
declare j erp_sync.browser_job%rowtype;parts jsonb;parent_code text;structure_hash text;route_hash text;
begin
 update erp_sync.browser_job b set state='pending',due_at=now(),attempts=0,error=null,claim_token=null,claimed_at=null,claimed_by=null
 from origin_sync.raw_record p where b.state='delegated'and p.entity='products'and p.source_id=b.task->>'product_source_id'
 and not(coalesce(p.payload->>'formato','')='E'and coalesce(p.payload#>>'{estrutura,tipoEstoque}','')='V');
 for j in select b.*from erp_sync.browser_job b join origin_sync.raw_record p on p.entity='products'and p.source_id=b.task->>'product_source_id'
  where b.kind='stock_history'and b.state<>'running'and p.payload->>'formato'='E'and p.payload#>>'{estrutura,tipoEstoque}'='V'
  and exists(select 1 from origin_sync.raw_record w where w.entity='warehouses'and w.source_id=b.task->>'warehouse_source_id')for update of b loop
  select jsonb_agg(jsonb_build_object('source_id',c.source_id,'code',c.code,'quantity',c.quantity)order by c.source_id),min(c.parent_code),min(c.structure_hash)
   into parts,parent_code,structure_hash from erp_sync.browser_product_components(j.task->>'product_source_id')c;
  if parts is null or parent_code is distinct from j.task->>'product_code'then
   if j.state='delegated'then
    update erp_sync.browser_job set state='pending',due_at=now(),attempts=0,claim_token=null,claimed_at=null,claimed_by=null where id=j.id;
    perform erp_sync.note_issue('census','products',null,j.task->>'product_source_id','BROWSER_COMPONENT_VIRTUAL_HISTORY','A composição sincronizada mudou ou tem componentes sem identificação válida. Conferir os IDs, códigos e quantidades antes de consultar os históricos dos componentes.');
   end if;
   continue;
  end if;
  route_hash:=encode(sha256(convert_to(parts::text||structure_hash||parent_code,'UTF8')),'hex');
  insert into erp_sync.browser_component_route values(j.id,route_hash,j.task->>'product_source_id',parent_code,j.task->>'warehouse_source_id',structure_hash,parts,clock_timestamp())on conflict do nothing;
  insert into erp_sync.browser_job(job_key,kind,task)
   select 'H:'||(c->>'source_id')||':'||(j.task->>'warehouse_source_id'),'stock_history',jsonb_build_object('product_source_id',c->>'source_id','product_code',c->>'code','warehouse_source_id',j.task->>'warehouse_source_id')from jsonb_array_elements(parts)c on conflict(job_key)do nothing;
  if j.state<>'delegated'then
   insert into erp_sync.browser_job_event(job_id,event,state,error,attempts,claimed_at,task)values(j.id,'component_routed',j.state,j.error,j.attempts,j.claimed_at,j.task);
   update erp_sync.browser_job set state='delegated',due_at='infinity',error=null,claim_token=null,claimed_at=null,claimed_by=null where id=j.id;
  end if;
 end loop;
 perform erp_sync.browser_resolve_component_issues();
end$$;
alter function erp_sync.browser_enqueue()rename to browser_enqueue_without_virtual_routes;
create function erp_sync.browser_enqueue()returns void language plpgsql set search_path=pg_catalog as $$
begin perform erp_sync.browser_enqueue_without_virtual_routes();perform erp_sync.browser_reconcile_virtual_jobs();end$$;
create function erp_sync.indicator_history_products(p_entity text,p_source text)returns table(source_id text,code text)
language sql stable set search_path=pg_catalog as $$
 with original as materialized(select *from erp_sync.indicator_products(p_entity,p_source))
 select p.*from original p where not exists(select 1 from erp_sync.browser_product_components(p.source_id))
 union select c.source_id,c.code from original p cross join lateral erp_sync.browser_product_components(p.source_id)c
$$;
alter function erp_sync.indicator_history(text,text,text)rename to indicator_history_without_component_labels;
do $$declare definition text;original text:='select *from erp_sync.indicator_products(p_entity,p_source)';begin
 definition:=pg_get_functiondef('erp_sync.indicator_history_without_component_labels(text,text,text)'::regprocedure);
 if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'browser_component_history_definition_changed';end if;
 definition:=replace(definition,original,'select *from erp_sync.indicator_history_products(p_entity,p_source)');
 execute replace(definition,'join products p on p.source_id=s.product_source_id','join products p on p.source_id=s.product_source_id and p.code=s.product_code');
end$$;
create function erp_sync.indicator_history(p_entity text,p_source text,p_note text)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_sync.indicator_history_without_component_labels(p_entity,p_source,p_note)||jsonb_build_object('components',coalesce((
 select jsonb_agg(jsonb_build_object('parent_code',c.parent_code,'product_code',c.code,'quantity',c.quantity)order by c.parent_code,c.code)
 from erp_sync.indicator_products(p_entity,p_source)p cross join lateral erp_sync.browser_product_components(p.source_id)c),'[]'::jsonb))
$$;
alter function erp_sync.browser_status()rename to browser_status_without_components;
create function erp_sync.browser_status()returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_sync.browser_status_without_components()||jsonb_build_object('component_products',(select count(*)from erp_sync.browser_job where state='delegated'))
$$;
revoke all on function erp_sync.browser_product_components(text),erp_sync.browser_resolve_component_issues(),erp_sync.browser_reconcile_virtual_jobs(),erp_sync.browser_enqueue_without_virtual_routes(),erp_sync.browser_enqueue(),erp_sync.indicator_history_products(text,text),erp_sync.indicator_history_without_component_labels(text,text,text),erp_sync.indicator_history(text,text,text),erp_sync.browser_status_without_components(),erp_sync.browser_status()from public,anon,authenticated,service_role;
commit;
