-- Versioned reviewed-subset ledger. No runtime, policy activation or dispatch.
-- Reuses064 intent/command/nonce. Stored068 human review is NOT full tax validation.
begin;
create schema erp_fiscal_reviewed_authorization;
revoke all on schema erp_fiscal_reviewed_authorization from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_reviewed_authorization revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_reviewed_authorization revoke all on functions from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_reviewed_authorization revoke all on sequences from public,anon,authenticated,service_role;

alter table erp_fiscal_authorization.policy add column authorization_profile text not null default 'legacy_v1'
 check(authorization_profile in('legacy_v1','reviewed_subset_v1'));
-- Only the operational-full-tax policy CHECK changes; the legacy branch is identical.
do $$declare n text;total integer;begin
 select count(*),min(conname)into total,n from pg_constraint where conrelid='erp_fiscal_authorization.policy'::regclass and contype='c'
 and pg_get_constraintdef(oid) like '%NOT enabled%' and pg_get_constraintdef(oid) like '%binding_reviewed AND tax_rules_reviewed%';
 if total<>1 then raise exception'reviewed_policy_constraint_drift';end if;
 execute format('alter table erp_fiscal_authorization.policy drop constraint %I',n);
end$$;
alter table erp_fiscal_authorization.policy add constraint reviewed_policy_authority_check check(
 (authorization_profile='legacy_v1' and(not enabled or origin='synthetic' or(binding_reviewed and tax_rules_reviewed)))
 or(authorization_profile='reviewed_subset_v1' and not tax_rules_reviewed and(not enabled or origin='synthetic' or binding_reviewed)));

create table erp_fiscal_reviewed_authorization.review_binding(
 attempt_id uuid primary key references erp_fiscal_authorization.attempt(id),
 review_id uuid not null references erp_fiscal_subset_review.review(id),proof jsonb not null,schema_evidence jsonb not null,
 created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_reviewed_authorization.observation(
 attempt_id uuid primary key references erp_fiscal_reviewed_authorization.review_binding(attempt_id),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),size_bytes integer not null check(size_bytes between 1 and 8192),
 origin text not null check(origin in('synthetic','operational')),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 response_hash text not null check(response_hash~'^[a-f0-9]{64}$'),review_hash text not null check(review_hash~'^[a-f0-9]{64}$'),
 finalize_hash text not null check(finalize_hash~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp());
alter table erp_fiscal_reviewed_authorization.review_binding enable row level security;
alter table erp_fiscal_reviewed_authorization.observation enable row level security;
create trigger immutable before update or delete on erp_fiscal_reviewed_authorization.review_binding for each row execute function erp_fiscal_authorization.immutable();
create trigger immutable before update or delete on erp_fiscal_reviewed_authorization.observation for each row execute function erp_fiscal_authorization.immutable();
revoke all on all tables in schema erp_fiscal_reviewed_authorization from public,anon,authenticated,service_role;

create function erp_fiscal_reviewed_authorization.manifest(model_id text)returns text language sql immutable set search_path=pg_catalog as $$
 select case model_id when '55' then 'd825d62ab1b17b7e5303c0aa2a7a2b1c8e43c82570e49ca98113eb797063d7db' when '65' then '963eb588baf7195067ff3f06f6b971107561d8da88db17b5c207f4714d7ef3c0' end
$$;
create function erp_fiscal_reviewed_authorization.is_reviewed(a erp_fiscal_authorization.attempt)returns boolean language sql stable set search_path=pg_catalog as $$
 select authorization_profile='reviewed_subset_v1' from erp_fiscal_authorization.policy where model=a.model and version=a.policy_version
$$;
create function erp_fiscal_reviewed_authorization.require_profile(a erp_fiscal_authorization.attempt)returns void language plpgsql stable set search_path=pg_catalog as $$begin
 if erp_fiscal_reviewed_authorization.is_reviewed(a)is distinct from true then raise exception'reviewed_profile_required'using errcode='22023';end if;
end$$;
create function erp_fiscal_reviewed_authorization.proof(r erp_fiscal_subset_review.review)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('candidate_id',r.candidate_id,'candidate_version',r.candidate_version,'signed_hash',r.signed_hash,'facts_hash',r.facts_hash,
 'profile',erp_fiscal_subset_review.profile(),'profile_hash',r.profile_hash,'review_id',r.id,'review_version',r.version,'review_hash',r.review_hash,'reviewed_by',r.actor,
 'reviewed_at',to_char(r.reviewed_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'valid_until',to_char(r.valid_until at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'coverage','listed_rules_only_not_full_tax_validation','tax_rules_validated',false)
$$;
-- Callers already hold mutex016. Review_save068 never waits for intent/attempt.
-- No current-source/A1/policy reads here: historical replay is intentionally independent.
create function erp_fiscal_reviewed_authorization.check_review(a erp_fiscal_authorization.attempt,v jsonb,require_current boolean)returns erp_fiscal_subset_review.review language plpgsql set search_path=pg_catalog as $$
declare r erp_fiscal_subset_review.review;b erp_fiscal_reviewed_authorization.review_binding;cmd erp_fiscal_authorization.command;i erp_fiscal_authorization.intent;artifact erp_fiscal_signed.artifact;latest uuid;begin
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 if not erp_a1.exact(v,array['candidate_id','candidate_version','signed_hash','facts_hash','profile','profile_hash','review_id','review_version','review_hash','reviewed_by','reviewed_at','valid_until','coverage','tax_rules_validated'])
 or jsonb_typeof(v->'review_id')is distinct from'string' or v->>'review_id'!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 then raise exception'reviewed_proof_invalid'using errcode='22023';end if;
 select *into r from erp_fiscal_subset_review.review where id=(v->>'review_id')::uuid;
 if r.id is null or v is distinct from erp_fiscal_reviewed_authorization.proof(r)then raise exception'reviewed_proof_conflict'using errcode='40001';end if;
 select *into cmd from erp_fiscal_authorization.command where id=a.command_id;
 select *into i from erp_fiscal_authorization.intent where id=a.intent_id;
 select *into artifact from erp_fiscal_signed.artifact where candidate_id=a.candidate_id;
 if r.candidate_id<>a.candidate_id or r.candidate_version is distinct from(cmd.receipt->>'candidate_version')::integer
 or r.signed_hash<>a.signed_hash or r.signed_size<>a.signed_size or r.model<>a.model or r.issuer_cnpj<>i.issuer_cnpj
 or r.schema_evidence is distinct from artifact.evidence->'xsd' or r.profile_hash<>erp_fiscal_subset_review.profile_hash()
 then raise exception'reviewed_candidate_conflict'using errcode='40001';end if;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 if b.attempt_id is not null and(b.review_id<>r.id or b.proof is distinct from v or b.schema_evidence is distinct from r.schema_evidence)then raise exception'reviewed_binding_conflict'using errcode='40001';end if;
 if require_current then
  select id into latest from erp_fiscal_subset_review.review where candidate_id=a.candidate_id order by version desc limit 1;
  if latest is distinct from r.id then raise exception'reviewed_latest_conflict'using errcode='40001';end if;
  perform 1 from erp_access.membership where user_id=r.actor and active and role in('admin','fiscal')for share;
  if not found then raise exception'reviewed_reviewer_inactive'using errcode='42501';end if;
  if not(clock_timestamp()>=r.reviewed_at and clock_timestamp()<r.valid_until)then raise exception'reviewed_expired'using errcode='40001';end if;
 end if;return r;
end$$;
create or replace function erp_fiscal_authorization.check_policy(model_id text,expected integer)returns erp_fiscal_authorization.policy language plpgsql set search_path=pg_catalog as $$
declare p erp_fiscal_authorization.policy;begin
 select *into p from erp_fiscal_authorization.policy where model=model_id order by version desc limit 1 for share;
 if p.version is distinct from expected then raise exception'authorization_policy_conflict'using errcode='40001';end if;
 if not p.enabled or not(clock_timestamp()>=p.valid_from and clock_timestamp()<p.valid_until)then raise exception'authorization_policy_disabled'using errcode='55000';end if;
 if p.authorization_profile='legacy_v1'then
  if p.origin='operational'and(not p.binding_reviewed or not p.tax_rules_reviewed)then raise exception'authorization_policy_disabled'using errcode='55000';end if;
 elsif p.authorization_profile='reviewed_subset_v1'then
  if p.tax_rules_reviewed or(p.origin='operational'and not p.binding_reviewed)
   or p.binding_profile is distinct from 'sp'||p.model||'-authorization-soap12-reviewed-20261016-v1'
   or p.rule_profile is distinct from erp_fiscal_subset_review.profile()
   or p.source_manifest_hash is distinct from erp_fiscal_reviewed_authorization.manifest(p.model)
   or clock_timestamp()<'2026-10-16T00:00:00-03:00'::timestamptz or clock_timestamp()>='2026-10-26T00:00:00-03:00'::timestamptz
  then raise exception'reviewed_policy_disabled'using errcode='55000';end if;
 else raise exception'reviewed_policy_invalid'using errcode='55000';end if;return p;
end$$;
create or replace function public.erp_fiscal_authorization_preview(p_user_id uuid,p_candidate_id uuid,p_signed_hash text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;p erp_fiscal_authorization.policy;c erp_fiscal_signed.candidate;b jsonb:='[]';begin
 if p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'then raise exception'authorization_preview_invalid'using errcode='22023';end if;
 s:=erp_fiscal_authorization.source(p_user_id,p_candidate_id,p_signed_hash);select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;
 select *into p from erp_fiscal_authorization.policy where model=s->>'model'order by version desc limit 1;
 if not p.enabled then b:=b||'"POLICY_DISABLED"'::jsonb;end if;
 if not p.binding_reviewed then b:=b||'"BINDING_NOT_REVIEWED"'::jsonb;end if;
 if not p.tax_rules_reviewed then b:=b||'"RULE_PROFILE_NOT_REVIEWED"'::jsonb;end if;
 if not(clock_timestamp()>=p.valid_from and clock_timestamp()<p.valid_until)then b:=b||'"POLICY_TIME_INVALID"'::jsonb;end if;
 if erp_fiscal_signed.current(c)->'artifact_current'is distinct from'true'::jsonb then b:=b||'"CANDIDATE_NOT_CURRENT"'::jsonb;end if;
 if exists(select 1 from erp_fiscal_authorization.intent where reservation_id=(s->>'reservation_id')::uuid and consumed_attempt_id is not null)then b:=b||'"SUBMISSION_ALREADY_CONSUMED"'::jsonb;end if;
 return erp_fiscal_authorization.flags()||jsonb_build_object('read_only',true,'candidate_id',p_candidate_id,'signed_hash',p_signed_hash,'model',s->>'model','policy',to_jsonb(p)-'authorization_profile','blockers',b,'can_prepare',jsonb_array_length(b)=0);
end$$;
create or replace function erp_fiscal_authorization.validate_preparation(a erp_fiscal_authorization.attempt,v jsonb,sha text)returns void language plpgsql stable set search_path=pg_catalog as $$
declare ctx jsonb:=erp_fiscal_authorization.context(a);k text;reviewed boolean;begin
 reviewed:=erp_fiscal_reviewed_authorization.is_reviewed(a);
 if reviewed and not exists(select 1 from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id)then raise exception'reviewed_binding_required'using errcode='40001';end if;
 if not erp_a1.exact(v,array['origin','request_hash','payload_hash','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit'])or octet_length(v::text)>16384 then raise exception'authorization_preparation_invalid'using errcode='22023';end if;
 foreach k in array array['origin','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','binding_profile','rule_profile']loop
  if v->k is distinct from ctx->k then raise exception'authorization_preparation_binding'using errcode='22023';end if;
 end loop;
 if v->>'request_hash'is distinct from sha or v->>'schema_profile'is distinct from'brufap-authorization-pl010f-v1.04'or v->>'schema_manifest_hash'is distinct from'6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda'or v->>'validator_hash'is distinct from'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612'
  or jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$'
  or v->'signature_verified'is distinct from'true'::jsonb or v->'xsd_validated'is distinct from'true'::jsonb or v->'context_matched'is distinct from'true'::jsonb
  or v->'tax_rules_validated'is distinct from to_jsonb(not reviewed and ctx->>'origin'='operational')or v->'can_emit'is distinct from'false'::jsonb or v->'can_transmit'is distinct from'false'::jsonb
 then raise exception'authorization_preparation_invalid'using errcode='22023';end if;
end$$;
-- These guards also run when a caller invokes an older064 RPC directly.
create function erp_fiscal_reviewed_authorization.guard_stage()returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;b erp_fiscal_reviewed_authorization.review_binding;o erp_fiscal_reviewed_authorization.observation;tag text;r erp_fiscal_authorization.request;begin
 if tg_table_name='attempt'then a:=new;else select *into a from erp_fiscal_authorization.attempt where id=new.attempt_id;end if;
 if not erp_fiscal_reviewed_authorization.is_reviewed(a)then return new;end if;
 if tg_table_name='attempt'then if new.state<>'dispatched'then return new;end if;end if;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 if b.attempt_id is null then raise exception'reviewed_binding_required'using errcode='40001';end if;
 perform erp_fiscal_reviewed_authorization.check_review(a,b.proof,tg_table_name<>'result');
 if tg_table_name='result'then
  select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
  select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
  tag:=erp_fiscal_wsdl.hash(jsonb_build_object('request_hash',r.sha256,'response_hash',new.response_hash,'response_size',new.response_size,'evidence',new.evidence,
   'processed_hash',new.processed_hash,'processed_size',new.processed_size,'rule_review',b.proof,'observation_hash',o.sha256,'observation_size',o.size_bytes));
  if o.attempt_id is null or o.origin is distinct from new.evidence->>'origin' or o.request_hash is distinct from r.sha256
   or o.response_hash is distinct from new.response_hash or o.review_hash is distinct from b.proof->>'review_hash' or o.finalize_hash is distinct from tag
   or(o.origin='operational'and(new.evidence->>'transport_hash'is distinct from o.sha256 or(new.evidence->>'transport_size')::integer is distinct from o.size_bytes))
  then raise exception'reviewed_observation_required'using errcode='40001';end if;
 end if;return new;
end$$;
create trigger reviewed_request_guard before insert on erp_fiscal_authorization.request for each row execute function erp_fiscal_reviewed_authorization.guard_stage();
create trigger reviewed_use_guard before update on erp_fiscal_authorization.attempt for each row when(new.state='dispatched'and old.state is distinct from new.state)execute function erp_fiscal_reviewed_authorization.guard_stage();
create trigger reviewed_result_guard before insert on erp_fiscal_authorization.result for each row execute function erp_fiscal_reviewed_authorization.guard_stage();
-- Final membership/expiry recheck after any wait later in the transaction. Never obtains a command/basis lock.
create constraint trigger reviewed_use_commit after update on erp_fiscal_authorization.attempt deferrable initially deferred for each row when(new.state='dispatched'and old.state is distinct from new.state)execute function erp_fiscal_reviewed_authorization.guard_stage();
create function erp_fiscal_reviewed_authorization.wrap(a erp_fiscal_authorization.attempt,v jsonb)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b erp_fiscal_reviewed_authorization.review_binding;o erp_fiscal_reviewed_authorization.observation;begin
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
 return jsonb_build_object('ledger_profile','authorization-reviewed-ledger-v1','view',v,'rule_review',b.proof,
 'observation',case when o.attempt_id is null then null else jsonb_build_object('sha256',o.sha256,'size_bytes',o.size_bytes)end);
end$$;
create function public.erp_fiscal_reviewed_authorization_begin(p_user_id uuid,p_command_id uuid,p_candidate_id uuid,p_signed_hash text,p_expected_identity_version integer,p_expected_a1_version integer,p_expected_policy_version integer,p_confirmed boolean)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v jsonb;a erp_fiscal_authorization.attempt;begin
 v:=public.erp_fiscal_authorization_begin(p_user_id,p_command_id,p_candidate_id,p_signed_hash,p_expected_identity_version,p_expected_a1_version,p_expected_policy_version,p_confirmed);
 select *into a from erp_fiscal_authorization.attempt where command_id=p_command_id;
 return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_prepare(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_request_hash text,p_request_size integer,p_evidence jsonb,p_rule_review jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;r erp_fiscal_subset_review.review;v jsonb;has_request boolean;begin
 perform erp_a1.access(p_user_id);select *into a from erp_fiscal_authorization.attempt where id=p_attempt_id;
 if a.id is null then raise exception'authorization_not_found'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(174852964,hashtext(a.command_id::text));
 select exists(select 1 from erp_fiscal_authorization.request where attempt_id=p_attempt_id)into has_request;
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,not has_request);
 r:=erp_fiscal_reviewed_authorization.check_review(a,p_rule_review,not has_request);
 if not exists(select 1 from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id)then
  insert into erp_fiscal_reviewed_authorization.review_binding(attempt_id,review_id,proof,schema_evidence)values(a.id,r.id,p_rule_review,r.schema_evidence);
 end if;
 v:=public.erp_fiscal_authorization_prepare(p_user_id,p_attempt_id,p_lease_id,p_request_hash,p_request_size,p_evidence);
 select *into a from erp_fiscal_authorization.attempt where id=p_attempt_id;return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_use(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_rule_review jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;v jsonb;begin
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,true);
 perform erp_fiscal_reviewed_authorization.check_review(a,p_rule_review,true);
 v:=public.erp_fiscal_authorization_use(p_user_id,p_attempt_id,p_lease_id);
 return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_finish(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_response_hash text,p_response_size integer,p_evidence jsonb,p_processed_hash text,p_processed_size integer,p_observation_hash text,p_observation_size integer)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;b erp_fiscal_reviewed_authorization.review_binding;o erp_fiscal_reviewed_authorization.observation;r erp_fiscal_authorization.request;tag text;v jsonb;begin
 -- Lock first, BEFORE the observation FK can touch attempt/intent.
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,false);
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 if a.used_at is null or p_observation_hash is null or p_observation_hash!~'^[a-f0-9]{64}$'or p_observation_size is null or p_observation_size not between 1 and 8192 then raise exception'reviewed_observation_invalid'using errcode='22023';end if;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 perform erp_fiscal_reviewed_authorization.check_review(a,b.proof,false);
 select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('request_hash',r.sha256,'response_hash',p_response_hash,'response_size',p_response_size,'evidence',p_evidence,
 'processed_hash',p_processed_hash,'processed_size',p_processed_size,'rule_review',b.proof,'observation_hash',p_observation_hash,'observation_size',p_observation_size));
 select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
 if o.attempt_id is not null then
  if o.finalize_hash is distinct from tag then raise exception'reviewed_finish_conflict'using errcode='40001';end if;
 else
  perform erp_fiscal_authorization.storage_check(a.id,'observations',r.sha256,p_observation_size);
  insert into erp_fiscal_reviewed_authorization.observation(attempt_id,sha256,size_bytes,origin,request_hash,response_hash,review_hash,finalize_hash)
   values(a.id,p_observation_hash,p_observation_size,erp_fiscal_authorization.context(a)->>'origin',r.sha256,p_response_hash,b.proof->>'review_hash',tag);
 end if;
 v:=public.erp_fiscal_authorization_finish(p_user_id,p_attempt_id,p_lease_id,p_response_hash,p_response_size,p_evidence,p_processed_hash,p_processed_size);
 select *into a from erp_fiscal_authorization.attempt where id=p_attempt_id;return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_fail(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;v jsonb;begin
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,false);perform erp_fiscal_reviewed_authorization.require_profile(a);
 v:=public.erp_fiscal_authorization_fail(p_user_id,p_attempt_id,p_lease_id,p_error_code);
 select *into a from erp_fiscal_authorization.attempt where id=p_attempt_id;return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;v jsonb;begin
 v:=public.erp_fiscal_authorization_command(p_user_id,p_command_id);select *into a from erp_fiscal_authorization.attempt where command_id=p_command_id;
 return erp_fiscal_reviewed_authorization.wrap(a,v);
end$$;
create function public.erp_fiscal_reviewed_authorization_history(p_user_id uuid,p_candidate_id uuid,p_limit integer default 25,p_before bigint default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb:='[]';reviews jsonb:='[]';observations jsonb:='[]';a erp_fiscal_authorization.attempt;v jsonb;more boolean;cursor bigint;begin
 perform erp_fiscal_authorization.source(p_user_id,p_candidate_id);
 if p_limit is null or p_limit not between 1 and 25 or(p_before is not null and p_before<1)then raise exception'authorization_page_invalid'using errcode='22023';end if;
 for a in select x.*from erp_fiscal_authorization.attempt x join erp_fiscal_authorization.policy p on(p.model=x.model and p.version=x.policy_version)
  where x.candidate_id=p_candidate_id and p.authorization_profile='reviewed_subset_v1'and(p_before is null or x.ordinal<p_before)order by x.ordinal desc limit p_limit loop
  v:=erp_fiscal_reviewed_authorization.wrap(a,(erp_fiscal_authorization.view(a)-'recovery')||jsonb_build_object('read_only',true,'recoverable_by_actor',a.actor=p_user_id and a.used_at is not null and a.state in('dispatched','submission_uncertain')));
  items:=items||jsonb_build_array(v->'view');reviews:=reviews||jsonb_build_array(v->'rule_review');observations:=observations||jsonb_build_array(v->'observation');cursor:=a.ordinal;
 end loop;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_authorization.attempt x join erp_fiscal_authorization.policy p on(p.model=x.model and p.version=x.policy_version)
  where x.candidate_id=p_candidate_id and p.authorization_profile='reviewed_subset_v1'and x.ordinal<cursor);
 return jsonb_build_object('ledger_profile','authorization-reviewed-ledger-v1','rule_reviews',reviews,'observations',observations,
 'page',erp_fiscal_authorization.flags()||jsonb_build_object('read_only',true,'candidate_id',p_candidate_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor::text else null end));
end$$;

-- Each existing field of each old policy row is unchanged. The new discriminator is legacy_v1.
-- source_manifest_hash below is a POLICY COMPOSITION hash, not the SOAP or tax-profile hash.
insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
 select m,(select max(version)+1 from erp_fiscal_authorization.policy where model=m),'operational',false,
 'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile(),true,false,
 erp_fiscal_reviewed_authorization.manifest(m),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m;
revoke all on all functions in schema erp_fiscal_reviewed_authorization from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_reviewed_authorization_begin(uuid,uuid,uuid,text,integer,integer,integer,boolean),public.erp_fiscal_reviewed_authorization_prepare(uuid,uuid,uuid,text,integer,jsonb,jsonb),public.erp_fiscal_reviewed_authorization_use(uuid,uuid,uuid,jsonb),public.erp_fiscal_reviewed_authorization_finish(uuid,uuid,uuid,text,integer,jsonb,text,integer,text,integer),public.erp_fiscal_reviewed_authorization_fail(uuid,uuid,uuid,text),public.erp_fiscal_reviewed_authorization_command(uuid,uuid),public.erp_fiscal_reviewed_authorization_history(uuid,uuid,integer,bigint) from public,anon,authenticated;
grant execute on function public.erp_fiscal_reviewed_authorization_begin(uuid,uuid,uuid,text,integer,integer,integer,boolean),public.erp_fiscal_reviewed_authorization_prepare(uuid,uuid,uuid,text,integer,jsonb,jsonb),public.erp_fiscal_reviewed_authorization_use(uuid,uuid,uuid,jsonb),public.erp_fiscal_reviewed_authorization_finish(uuid,uuid,uuid,text,integer,jsonb,text,integer,text,integer),public.erp_fiscal_reviewed_authorization_fail(uuid,uuid,uuid,text),public.erp_fiscal_reviewed_authorization_command(uuid,uuid),public.erp_fiscal_reviewed_authorization_history(uuid,uuid,integer,bigint) to service_role;
commit;
