-- Protect external mutations whose delivery cannot be confirmed. No upstream exactly-once guarantee is assumed.
begin;
alter table erp_sync.outbox add column review_required boolean not null default false;
create index outbox_review on erp_sync.outbox(entity,record_id) where review_required;
-- Existing ambiguous failures require review too; an ordinary update must not replay them.
update erp_sync.outbox set review_required=true where state='failed'
 and error ~ '^(ORIGIN_NETWORK_ERROR|ORIGIN_SERVER_ERROR|ORIGIN_INVALID_JSON|ORIGIN_RESPONSE_SIZE_LIMIT|ORIGIN_CREATED_ID_MISSING|ORIGIN_WRITE_UNCONFIRMED|ORIGIN_PARTIAL_WRITE_REVIEW)';

create or replace function public.erp_sync_claim(p_limit integer,p_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare o erp_sync.outbox; v_req jsonb; v_out jsonb:='[]'; v_code text;
begin
 if p_limit is null or p_limit not between 1 and 100 or p_token is null then raise exception 'erp_sync_invalid_claim' using errcode='22023'; end if;
 if not erp_sync.enabled() then return '[]'::jsonb; end if;
 -- A timed-out delivery may already exist upstream. It must be reconciled before replay.
 for o in update erp_sync.outbox set state='failed',review_required=true,claim_token=null,
  finished_at=clock_timestamp(),error='ORIGIN_WRITE_UNCONFIRMED'
  where state='sending' and claimed_at<clock_timestamp()-interval '10 minutes' returning * loop
  perform erp_sync.note_issue('push',o.entity,o.record_id,null,'ORIGIN_WRITE_UNCONFIRMED');
 end loop;
 for o in select q.* from erp_sync.outbox q where q.state='pending' and q.next_attempt_at<=clock_timestamp()
  and not exists(select 1 from erp_sync.outbox blocked where blocked.entity=q.entity
   and blocked.record_id=q.record_id and (blocked.review_required or blocked.state='sending'))
  order by erp_sync.priority(entity,op),id limit p_limit*3 for update skip locked loop
  exit when jsonb_array_length(v_out)>=p_limit;
  -- Serialize different operations for one record, including competing claims.
  if not pg_try_advisory_xact_lock(hashtextextended(o.entity||':'||o.record_id::text,0)) then continue; end if;
  if exists(select 1 from erp_sync.outbox blocked where blocked.entity=o.entity and blocked.record_id=o.record_id
   and (blocked.review_required or blocked.state='sending')) then continue; end if;
  begin
   v_req:=erp_sync.request(o);
  exception when others then
   v_code:=case when sqlerrm~'^[A-Za-z_]{3,80}$' then sqlerrm else 'REQUEST_BUILD_FAILED' end;
   update erp_sync.outbox set state='failed',finished_at=clock_timestamp(),error=left(sqlerrm,500),attempts=attempts+1 where id=o.id;
   perform erp_sync.note_issue('push',o.entity,o.record_id,null,v_code,left(sqlerrm,500));
   continue;
  end;
  if v_req ? 'skip' then
   update erp_sync.outbox set state='skipped',finished_at=clock_timestamp(),error=v_req->>'skip' where id=o.id;
   if v_req->>'skip' not in('NOT_IN_ORIGIN','NOTHING_TO_SEND') then perform erp_sync.note_issue('push',o.entity,o.record_id,null,v_req->>'skip'); end if;
  elsif v_req ? 'blocked' then
   update erp_sync.outbox set next_attempt_at=clock_timestamp()+interval '20 seconds' where id=o.id;
  else
   update erp_sync.outbox set state='sending',claim_token=p_token,claimed_at=clock_timestamp(),attempts=attempts+1,dirty=false where id=o.id;
   v_out:=v_out||jsonb_build_array(jsonb_build_object('id',o.id,'entity',o.entity,'record_id',o.record_id,'item',o.item,'op',o.op,'token',p_token)||v_req);
  end if;
 end loop;
 return v_out;
end$$;

create or replace function public.erp_sync_ack(p_results jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a jsonb; o erp_sync.outbox; v_done integer:=0; v_failed integer:=0; v_retry integer:=0; v_origin text; v_status integer; v_link_entity text;
begin
 if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)>100 then raise exception 'erp_sync_invalid_ack' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_results) loop
  select * into o from erp_sync.outbox where id=(a->>'id')::bigint and claim_token=(a->>'token')::uuid and state='sending' for update;
  if not found then continue; end if;
  v_origin:=erp_sync.origin_ref(a->'origin_id'); v_status:=nullif(a->>'status','')::integer;
  v_link_entity:=case when o.entity in('stock') or o.op='settle' then null else o.entity end;
  -- Persist a confirmed created ID even when a subsequent step failed.
  if v_link_entity is not null and v_origin is not null then
   perform erp_sync.remember(v_link_entity,o.record_id,v_origin);
  end if;
  if coalesce(a->>'code','') in ('ORIGIN_WRITE_UNCONFIRMED','ORIGIN_PARTIAL_WRITE_REVIEW','ORIGIN_CREATED_ID_MISSING') then
   update erp_sync.outbox set state='failed',review_required=true,claim_token=null,finished_at=clock_timestamp(),
    http_status=v_status,origin_id=coalesce(v_origin,origin_id),error=left(a->>'error',500) where id=o.id;
   perform erp_sync.note_issue('push',o.entity,o.record_id,v_origin,a->>'code',left(a->>'error',500));
   v_failed:=v_failed+1;
  elsif (a->>'ok')::boolean then
   if v_link_entity is not null and v_origin is not null then
    perform erp_sync.remember(v_link_entity,o.record_id,v_origin);
    update erp_sync.link set pushed_at=clock_timestamp(),deleted=o.op='delete' or coalesce((a->>'deleted')::boolean,false) where entity=v_link_entity and record_id=o.record_id;
   end if;
   if o.entity='stock' then
    insert into erp_sync.stock_pair(product_id,warehouse_id,last_push_at) values((o.detail->>'product_id')::uuid,(o.detail->>'warehouse_id')::uuid,clock_timestamp())
    on conflict(product_id,warehouse_id) do update set last_push_at=excluded.last_push_at;
   end if;
   perform erp_sync.resolve_issues('push',o.entity,o.record_id,null);
   update erp_sync.outbox set state=case when dirty then 'pending' else 'done' end,dirty=false,claim_token=null,
    finished_at=case when dirty then null else clock_timestamp() end,next_attempt_at=clock_timestamp(),http_status=v_status,error=null,
    origin_id=coalesce(v_origin,origin_id),attempts=case when dirty then 0 else attempts end
   where id=o.id;
   v_done:=v_done+1;
  elsif v_status=404 and o.op='delete' then
   update erp_sync.outbox set state='done',claim_token=null,finished_at=clock_timestamp(),http_status=404 where id=o.id;
   update erp_sync.link set deleted=true where entity=o.entity and record_id=o.record_id;
   v_done:=v_done+1;
  elsif v_status=404 and o.op='upsert' and v_link_entity is not null and o.attempts<3 then
   -- Sumiu do Origin e o Brufap alterou depois: o mais recente vence e o registro é criado de novo.
   delete from erp_sync.link where entity=o.entity and record_id=o.record_id;
   update erp_sync.outbox set state='pending',claim_token=null,next_attempt_at=clock_timestamp(),http_status=404 where id=o.id;
   v_retry:=v_retry+1;
  elsif coalesce((a->>'retry')::boolean,false) and o.attempts<8 then
   update erp_sync.outbox set state='pending',claim_token=null,http_status=v_status,error=left(a->>'error',500),
    next_attempt_at=clock_timestamp()+least(interval '1 hour',interval '1 minute'*power(2,o.attempts)) where id=o.id;
   v_retry:=v_retry+1;
  else
   update erp_sync.outbox set state='failed',claim_token=null,finished_at=clock_timestamp(),http_status=v_status,error=left(coalesce(a->>'error','ORIGIN_ERROR'),500) where id=o.id;
   perform erp_sync.note_issue('push',o.entity,o.record_id,null,left(coalesce(a->>'code','ORIGIN_ERROR'),80),left(a->>'error',500));
   v_failed:=v_failed+1;
  end if;
 end loop;
 return jsonb_build_object('done',v_done,'retry',v_retry,'failed',v_failed,'pending',(select count(*) from erp_sync.outbox where state in('pending','sending')));
end$$;

create or replace function public.erp_sync_request(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_run erp_sync.run;
begin
 perform erp_sync.require_member(p_user_id,true);
 if not erp_sync.enabled() then raise exception 'erp_sync_disabled' using errcode='55000'; end if;
 select * into v_run from erp_sync.run where state in('queued','running');
 if not found then
  insert into erp_sync.run(requested_by) values(p_user_id) returning * into v_run;
  -- Only confirmed failures can be retried by the ordinary synchronization button.
  update erp_sync.outbox set state='pending',next_attempt_at='-infinity',attempts=0 where state='failed' and not review_required
   and not exists(select 1 from erp_sync.outbox o where o.entity=outbox.entity and o.record_id=outbox.record_id and o.item=outbox.item
    and o.op=outbox.op and o.state in('pending','sending'));
  update erp_sync.inbox set retry_at='-infinity' where attempts>0;
 end if;
 return erp_sync.status_dto()||jsonb_build_object('requested_run',v_run.id);
end$$;

create or replace function erp_sync.local_superseded(p_entity text,p_record uuid) returns void
language sql security definer set search_path=pg_catalog as $$
 update erp_sync.outbox set state='superseded',finished_at=clock_timestamp(),dirty=false
 where entity=p_entity and record_id=p_record and op in('upsert','delete')
 and state in('pending','failed') and not review_required
$$;
-- Function replacement retains the existing service-role-only grants.
commit;
