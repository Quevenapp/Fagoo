-- Explicit closure of an expired reviewed attempt which never consumed its grant.
-- No new attempt, grant, transport or policy; existing064/069/073 records remain.
begin;
create schema erp_fiscal_authorization_closure;
revoke all on schema erp_fiscal_authorization_closure from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_closure revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_closure revoke all on functions from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_closure revoke all on sequences from public,anon,authenticated,service_role;

create table erp_fiscal_authorization_closure.command (
 id uuid primary key,
 actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 attempt_id uuid not null unique references erp_fiscal_authorization.attempt(id),
 receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table erp_fiscal_authorization_closure.command enable row level security;
revoke all on table erp_fiscal_authorization_closure.command from public,anon,authenticated,service_role;
create trigger immutable before update or delete on erp_fiscal_authorization_closure.command
 for each row execute function erp_fiscal_authorization.immutable();

-- Only public metadata: no lease, nonce, credential, request bytes or execution port.
-- Receipt describes the closed attempt; current also reports a later attempt, if any.
create function erp_fiscal_authorization_closure.view(c erp_fiscal_authorization_closure.command)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_authorization.flags()||jsonb_build_object(
  'closure_profile','reviewed-expired-unconsumed-v1','tax_rules_validated',false,
  'command_id',c.id,'receipt',c.receipt,
  'current',jsonb_build_object('state',a.state,'grant_consumed',a.used_at is not null,
   'finished_at',a.finished_at,'successor_exists',i.active_attempt_id is distinct from a.id,
   'intent_consumed',i.consumed_attempt_id is not null))
 from erp_fiscal_authorization.attempt a join erp_fiscal_authorization.intent i on i.id=a.intent_id
 where a.id=c.attempt_id
$$;

create function public.erp_fiscal_reviewed_authorization_close_expired(
 p_user_id uuid,p_command_id uuid,p_authorization_command_id uuid,p_expected_attempt_id uuid,
 p_expected_state text,p_expected_request_hash text,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 tag text;c erp_fiscal_authorization_closure.command;a erp_fiscal_authorization.attempt;
 i erp_fiscal_authorization.intent;r erp_fiscal_authorization.request;
 b erp_fiscal_reviewed_authorization.review_binding;p erp_fiscal_authorization.policy;prior_state text;
begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null or p_authorization_command_id is null or p_expected_attempt_id is null
  or p_command_id=p_authorization_command_id or p_expected_state is null
  or p_expected_state not in('prepared','request_ready') or p_confirmed is distinct from true
  or(p_expected_state='prepared'and p_expected_request_hash is not null)
  or(p_expected_state='request_ready'and(p_expected_request_hash is null or p_expected_request_hash!~'^[a-f0-9]{64}$'))
 then raise exception'authorization_closure_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',p_user_id,'authorization_command_id',p_authorization_command_id,
  'attempt_id',p_expected_attempt_id,'state',p_expected_state,'request_hash',p_expected_request_hash,'confirmed',true));
 -- Dedicated outer command lock. No other family acquires this namespace.
 -- Then original064 command -> mutex016 -> current membership -> intent -> attempt.
 -- Terminal lock_source(false) never acquires document/draft or current A1/policy.
 perform pg_advisory_xact_lock(174852974,hashtext(p_command_id::text));
 select *into c from erp_fiscal_authorization_closure.command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>tag then raise exception'authorization_closure_command_conflict'using errcode='40001';end if;
  select *into a from erp_fiscal_authorization.attempt where id=c.attempt_id;
  a:=erp_fiscal_authorization.lock_attempt(p_user_id,a.id,a.lease_id,false);
  return erp_fiscal_authorization_closure.view(c)||jsonb_build_object('replayed',true,'read_only',false);
 end if;
 select *into a from erp_fiscal_authorization.attempt where command_id=p_authorization_command_id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,a.id,a.lease_id,false);
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 select *into i from erp_fiscal_authorization.intent where id=a.intent_id;
 select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
 -- Recheck AFTER every potentially waiting lock. Never interpret expiry as evidence
 -- of non-consumption: both the attempt and the durable intent/audit must agree.
 if a.id is distinct from p_expected_attempt_id or a.state is distinct from p_expected_state
  or a.used_at is not null or a.finished_at is not null or a.finalize_hash is not null
  or a.expires_at>clock_timestamp() or i.consumed_attempt_id is not null or i.active_attempt_id is distinct from a.id
  or r.sha256 is distinct from p_expected_request_hash
  or(a.state='prepared'and r.attempt_id is not null)or(a.state='request_ready'and r.attempt_id is null)
  or exists(select 1 from erp_fiscal_authorization.result where attempt_id=a.id)
  or exists(select 1 from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id)
  or exists(select 1 from erp_fiscal_authorization.audit where attempt_id=a.id and action='consume')
  or exists(select 1 from erp_fiscal_authorization_closure.command where attempt_id=a.id)
 then raise exception'authorization_closure_conflict'using errcode='40001';end if;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 select *into p from erp_fiscal_authorization.policy where model=a.model and version=a.policy_version;
 prior_state:=a.state;
 -- Preserve the established064 terminal state/error contract for historical readers.
 -- The074 receipt records the explicit reason; this is not a SEFAZ rejection.
 update erp_fiscal_authorization.attempt set state='failed_before_dispatch',finished_at=clock_timestamp(),error_code='PREPARATION_FAILED'
 where id=a.id returning *into a;
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'fail');
 insert into erp_fiscal_authorization_closure.command(id,actor,request_hash,attempt_id,receipt)
 values(p_command_id,p_user_id,tag,a.id,jsonb_build_object(
  'command_id',p_command_id,'authorization_command_id',a.command_id,'attempt_id',a.id,'candidate_id',a.candidate_id,
  'signed_hash',a.signed_hash,'model',a.model,'origin',p.origin,'policy_version',a.policy_version,
  'previous_state',prior_state,'request_hash',r.sha256,'review_id',b.review_id,
  'lease_expired_at',a.expires_at,'closed_at',a.finished_at,'reason','LEASE_EXPIRED_UNCONSUMED','state','failed_before_dispatch',
  'grant_consumed',false,'tax_rules_validated',false))returning *into c;
 perform erp_a1.access(p_user_id);
 return erp_fiscal_authorization_closure.view(c)||jsonb_build_object('replayed',false,'read_only',false);
end$$;

create function public.erp_fiscal_reviewed_authorization_closure_command(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_fiscal_authorization_closure.command;a erp_fiscal_authorization.attempt;begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null then raise exception'authorization_closure_invalid'using errcode='22023';end if;
 select *into c from erp_fiscal_authorization_closure.command where id=p_command_id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception'authorization_forbidden'using errcode='42501';end if;
 select *into a from erp_fiscal_authorization.attempt where id=c.attempt_id;
 perform erp_fiscal_authorization.source(p_user_id,a.candidate_id,a.signed_hash);
 return erp_fiscal_authorization_closure.view(c)||jsonb_build_object('replayed',true,'read_only',true);
end$$;
revoke all on all functions in schema erp_fiscal_authorization_closure from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_reviewed_authorization_close_expired(uuid,uuid,uuid,uuid,text,text,boolean),
 public.erp_fiscal_reviewed_authorization_closure_command(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_reviewed_authorization_close_expired(uuid,uuid,uuid,uuid,text,text,boolean),
 public.erp_fiscal_reviewed_authorization_closure_command(uuid,uuid)to service_role;
commit;
