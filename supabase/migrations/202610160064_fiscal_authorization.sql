-- Local authorization ledger. Both seeded policies are disabled. No transport or activation RPC.
-- SQL checks server evidence and Storage metadata, never XML bytes or browser attestations.
begin;
create schema erp_fiscal_authorization;
revoke all on schema erp_fiscal_authorization from public,anon,authenticated,service_role;

create table erp_fiscal_authorization.policy (
 model text not null check(model in('55','65')), version integer not null check(version>0),
 origin text not null check(origin in('synthetic','operational')), enabled boolean not null,
 binding_profile text, rule_profile text, binding_reviewed boolean not null, tax_rules_reviewed boolean not null,
 source_manifest_hash text check(source_manifest_hash~'^[a-f0-9]{64}$'), valid_from timestamptz not null, valid_until timestamptz not null,
 created_at timestamptz not null default clock_timestamp(), primary key(model,version), check(valid_until>valid_from),
 check(not enabled or(binding_profile is not null and rule_profile is not null and source_manifest_hash is not null)),
 check(origin<>'synthetic' or(not binding_reviewed and not tax_rules_reviewed)),
 check(not enabled or origin='synthetic' or(binding_reviewed and tax_rules_reviewed))
);
insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until)
 select m,1,'operational',false,false,false,'2026-10-16T00:00:00Z','2026-10-26T00:00:00Z' from unnest(array['55','65'])m;
create table erp_fiscal_authorization.intent (
 id uuid primary key, reservation_id uuid not null unique references erp_fiscal_numbering.reservation(id),
 access_key text not null unique, issuer_cnpj text not null, model text not null check(model in('55','65')),
 active_attempt_id uuid, consumed_attempt_id uuid, created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_authorization.attempt (
 id uuid primary key, ordinal bigint generated always as identity unique check(ordinal between 1 and 999999999999999),
 intent_id uuid not null references erp_fiscal_authorization.intent(id), command_id uuid not null unique,
 actor uuid not null references auth.users(id), candidate_id uuid not null references erp_fiscal_signed.candidate(id),
 signed_hash text not null check(signed_hash~'^[a-f0-9]{64}$'), signed_size integer not null check(signed_size between 1 and 512000),
 reference_digest text not null check(reference_digest~'^[A-Za-z0-9+/]{27}=$'),
 policy_version integer not null, model text not null, foreign key(model,policy_version) references erp_fiscal_authorization.policy(model,version),
 identity_version integer not null check(identity_version>0), a1_version integer not null check(a1_version>0),
 credential_id uuid not null references erp_a1.credential(id), envelope_hash text not null references erp_a1.sealed_object(hash),
 certificate_fingerprint text not null check(certificate_fingerprint~'^[a-f0-9]{64}$'),
 lease_id uuid not null unique, nonce uuid not null unique, expires_at timestamptz not null, created_at timestamptz not null,
 state text not null check(state in('prepared','request_ready','dispatched','submission_uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorization_observed','authorized_homologation')),
 used_at timestamptz, finished_at timestamptz, error_code text, finalize_hash text,
 check((state in('prepared','request_ready','dispatched'))=(finished_at is null)),
 check((state in('prepared','request_ready','failed_before_dispatch'))=(used_at is null))
);
alter table erp_fiscal_authorization.intent add foreign key(active_attempt_id) references erp_fiscal_authorization.attempt(id), add foreign key(consumed_attempt_id) references erp_fiscal_authorization.attempt(id);
create table erp_fiscal_authorization.command (
 id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 attempt_id uuid not null unique references erp_fiscal_authorization.attempt(id), receipt jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_authorization.request (
 attempt_id uuid primary key references erp_fiscal_authorization.attempt(id), sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 size_bytes integer not null check(size_bytes between 1 and 512000), evidence jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_authorization.result (
 attempt_id uuid primary key references erp_fiscal_authorization.attempt(id), response_hash text not null check(response_hash~'^[a-f0-9]{64}$'),
 response_size integer not null check(response_size between 1 and 512000), evidence jsonb not null,
 processed_hash text check(processed_hash~'^[a-f0-9]{64}$'), processed_size integer check(processed_size between 1 and 512000),
 created_at timestamptz not null default clock_timestamp(), check((processed_hash is null)=(processed_size is null))
);
create table erp_fiscal_authorization.audit (
 id bigint generated always as identity primary key, attempt_id uuid not null references erp_fiscal_authorization.attempt(id),
 actor uuid not null references auth.users(id), action text not null check(action in('begin','prepare','consume','finish','fail')), created_at timestamptz not null default clock_timestamp()
);
do $$declare n text;begin
 foreach n in array array['policy','intent','attempt','command','request','result','audit']loop
  execute format('alter table erp_fiscal_authorization.%I enable row level security',n);
 end loop;
end$$;
revoke all on all tables in schema erp_fiscal_authorization from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_authorization from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_authorization.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception'authorization_history_immutable'using errcode='42501';end$$;
do $$declare n text;begin foreach n in array array['policy','command','request','result','audit']loop
 execute format('create trigger immutable before update or delete on erp_fiscal_authorization.%I for each row execute function erp_fiscal_authorization.immutable()',n);
end loop;end$$;
create function erp_fiscal_authorization.guard_intent()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(to_jsonb(new)-array['active_attempt_id','consumed_attempt_id'])is distinct from(to_jsonb(old)-array['active_attempt_id','consumed_attempt_id'])
  or old.consumed_attempt_id is not null or new.active_attempt_id is null
  or(old.active_attempt_id is not null and new.active_attempt_id is distinct from old.active_attempt_id and not exists(select 1 from erp_fiscal_authorization.attempt where id=old.active_attempt_id and state='failed_before_dispatch'))
  or(new.consumed_attempt_id is not null and new.consumed_attempt_id is distinct from new.active_attempt_id)
  or(new.consumed_attempt_id is not null and not exists(select 1 from erp_fiscal_authorization.attempt where id=new.consumed_attempt_id and used_at is not null))
  or not exists(select 1 from erp_fiscal_authorization.attempt where id=new.active_attempt_id and intent_id=new.id)
 then raise exception'authorization_intent_immutable'using errcode='42501';end if;
 return new;end$$;
create trigger guard_intent before update or delete on erp_fiscal_authorization.intent for each row execute function erp_fiscal_authorization.guard_intent();
create function erp_fiscal_authorization.guard_attempt()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or(to_jsonb(new)-array['state','used_at','finished_at','error_code','finalize_hash'])is distinct from(to_jsonb(old)-array['state','used_at','finished_at','error_code','finalize_hash'])
  or old.state not in('prepared','request_ready','dispatched','submission_uncertain')
  or(old.used_at is not null and new.used_at is distinct from old.used_at)
  or(new.state='request_ready'and old.state<>'prepared')
  or(new.state='dispatched'and(old.state<>'request_ready' or new.used_at is null))
  or(new.state='failed_before_dispatch'and old.used_at is not null)
  or(new.state not in('request_ready','dispatched','failed_before_dispatch')and old.used_at is null)
  or new.state='prepared'
 then raise exception'authorization_attempt_immutable'using errcode='42501';end if;
 return new;end$$;
create trigger guard_attempt before update or delete on erp_fiscal_authorization.attempt for each row execute function erp_fiscal_authorization.guard_attempt();

create function erp_fiscal_authorization.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'data_mode','fiscal_authorization','environment','2','can_emit',false,'can_transmit',false,'production_authorized',false,'legal_fiscal_value',false,
 'financial_mutation_performed',false,'stock_mutation_performed',false,'retry_submission_allowed',false)$$;
create function erp_fiscal_authorization.source(actor uuid,candidate uuid,sha text default null)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_reconciliation.source(actor,candidate,sha)
$$;
-- All writers take command first. Basis writers take document/draft BEFORE mutex016.
-- Terminal writers take mutex016 directly and NEVER take document/draft afterwards.
-- Both paths then take membership -> A1(optional) -> policy -> intent -> attempt.
create function erp_fiscal_authorization.lock_source(actor uuid,candidate uuid,require_current boolean)returns jsonb language plpgsql set search_path=pg_catalog as $$
declare s jsonb;r erp_fiscal_numbering.reservation;c erp_fiscal_signed.candidate;j erp_fiscal_unsigned.job;begin
 s:=erp_fiscal_authorization.source(actor,candidate);select *into r from erp_fiscal_numbering.reservation where id=(s->>'reservation_id')::uuid;
 if require_current then perform erp_fiscal_unsigned.lock_basis(r);else perform pg_advisory_xact_lock(174852920,1);end if;
 perform 1 from erp_access.membership where user_id=actor and active and role in('admin','fiscal')for share;
 if not found then raise exception'authorization_forbidden'using errcode='42501';end if;
 s:=erp_fiscal_authorization.source(actor,candidate);
 if require_current then
  select *into c from erp_fiscal_signed.candidate x where x.id=lock_source.candidate;select *into j from erp_fiscal_unsigned.job where id=c.unsigned_job_id;
  perform erp_fiscal_signed.check_source(j,c.unsigned_hash,c.basis_hash);
  if erp_fiscal_signed.current(c)->'artifact_current' is distinct from'true'::jsonb then raise exception'authorization_candidate_not_current'using errcode='40001';end if;
 end if;return s;end$$;
create function erp_fiscal_authorization.check_policy(model_id text,expected integer)returns erp_fiscal_authorization.policy language plpgsql set search_path=pg_catalog as $$
declare p erp_fiscal_authorization.policy;begin
 select *into p from erp_fiscal_authorization.policy where model=model_id order by version desc limit 1 for share;
 if p.version is distinct from expected then raise exception'authorization_policy_conflict'using errcode='40001';end if;
 if not p.enabled or not(clock_timestamp()>=p.valid_from and clock_timestamp()<p.valid_until)
  or(p.origin='operational'and(not p.binding_reviewed or not p.tax_rules_reviewed))then raise exception'authorization_policy_disabled'using errcode='55000';end if;
 return p;end$$;
create function erp_fiscal_authorization.check_a1(a erp_fiscal_authorization.attempt)returns erp_a1.credential language plpgsql set search_path=pg_catalog as $$
declare h erp_a1.head;c erp_a1.credential;begin
 select *into h from erp_a1.head where singleton for share;c:=erp_fiscal_wsdl.check_a1(h,a.identity_version,a.a1_version);
 if h.credential_id is distinct from a.credential_id or h.object_hash is distinct from a.envelope_hash or c.metadata->>'fingerprint_sha256'is distinct from a.certificate_fingerprint then raise exception'authorization_a1_conflict'using errcode='40001';end if;
 return c;end$$;
create function erp_fiscal_authorization.context(a erp_fiscal_authorization.attempt)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('private_executor_only',true,'attempt_id',a.id,'intent_id',a.intent_id,'command_id',a.command_id,'actor',a.actor,
 'lease_id',a.lease_id,'nonce',a.nonce,'expires_at',a.expires_at,'purpose','sp-authorization-homologation-v1','environment','2','model',a.model,
 'origin',p.origin,'policy_version',a.policy_version,'binding_profile',p.binding_profile,'rule_profile',p.rule_profile,'policy_manifest_hash',p.source_manifest_hash,
 'candidate_id',a.candidate_id,'signed_hash',a.signed_hash,'signed_size',a.signed_size,'batch_id',a.ordinal::text,'access_key',i.access_key,'reference_digest',a.reference_digest,
 'issuer_cnpj',i.issuer_cnpj,'identity_version',a.identity_version,'a1_version',a.a1_version,'credential_id',a.credential_id,'envelope_hash',a.envelope_hash,'certificate_fingerprint',a.certificate_fingerprint,
 'request_hash',r.sha256,'request_size',r.size_bytes)
 from erp_fiscal_authorization.intent i join erp_fiscal_authorization.policy p on p.model=a.model and p.version=a.policy_version
 left join erp_fiscal_authorization.request r on r.attempt_id=a.id where i.id=a.intent_id
$$;
create function erp_fiscal_authorization.view(a erp_fiscal_authorization.attempt)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare c erp_fiscal_signed.candidate;h erp_a1.head;p erp_fiscal_authorization.policy;r erp_fiscal_authorization.result;begin
 select *into c from erp_fiscal_signed.candidate where id=a.candidate_id;select *into h from erp_a1.head where singleton;
 select *into p from erp_fiscal_authorization.policy where model=a.model order by version desc limit 1;select *into r from erp_fiscal_authorization.result where attempt_id=a.id;
 return erp_fiscal_authorization.flags()||jsonb_build_object('command_id',a.command_id,'receipt',(select receipt from erp_fiscal_authorization.command where id=a.command_id),
 'current',jsonb_build_object('state',a.state,'grant_consumed',a.used_at is not null,'used_at',a.used_at,'expires_at',a.expires_at,'lease_expired',a.expires_at<=clock_timestamp(),'finished_at',a.finished_at,
 'identity_changed',a.identity_version is distinct from(select version from erp_company.identity where singleton),'a1_changed',h.version is distinct from a.a1_version or h.credential_id is distinct from a.credential_id or h.object_hash is distinct from a.envelope_hash,
 'policy_changed',p.version is distinct from a.policy_version,'policy_enabled',p.enabled and clock_timestamp()>=p.valid_from and clock_timestamp()<p.valid_until,
 'candidate',erp_fiscal_signed.current(c),'recovery_required',a.state in('dispatched','submission_uncertain'),'authorized_in_homologation',a.state='authorized_homologation'),
 'artifact',case when r.attempt_id is null then null else jsonb_build_object('response_hash',r.response_hash,'response_size',r.response_size,'evidence',r.evidence,'processed_hash',r.processed_hash,'processed_size',r.processed_size,'created_at',r.created_at)end,
 'error_code',a.error_code,'recovery',erp_fiscal_authorization.context(a));end$$;
create function erp_fiscal_authorization.storage_check(a uuid,kind text,tag text,size integer)returns void language plpgsql set search_path=pg_catalog as $$begin
 if kind not in('requests','responses','processed','observations')or tag is null or tag!~'^[a-f0-9]{64}$'or size is null or size not between 1 and(case when kind='observations'then 8192 else 512000 end)then raise exception'authorization_object_invalid'using errcode='22023';end if;
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception'authorization_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.buckets where id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and public=false and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception'authorization_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'and name='authorization/'||a::text||'/'||kind||'/'||tag||case when kind='observations'then'.json'else'.xml'end and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception'authorization_object_missing'using errcode='40001';end if;
end$$;

create function public.erp_fiscal_authorization_preview(p_user_id uuid,p_candidate_id uuid,p_signed_hash text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
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
 return erp_fiscal_authorization.flags()||jsonb_build_object('read_only',true,'candidate_id',p_candidate_id,'signed_hash',p_signed_hash,'model',s->>'model','policy',to_jsonb(p),'blockers',b,'can_prepare',jsonb_array_length(b)=0);
end$$;
create function public.erp_fiscal_authorization_begin(p_user_id uuid,p_command_id uuid,p_candidate_id uuid,p_signed_hash text,p_expected_identity_version integer,p_expected_a1_version integer,p_expected_policy_version integer,p_confirmed boolean)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s jsonb;tag text;cmd erp_fiscal_authorization.command;a erp_fiscal_authorization.attempt;i erp_fiscal_authorization.intent;p erp_fiscal_authorization.policy;h erp_a1.head;c erp_a1.credential;at timestamptz;begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null or p_candidate_id is null or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'or p_expected_identity_version is null or p_expected_identity_version<1 or p_expected_a1_version is null or p_expected_a1_version<1 or p_expected_policy_version is null or p_expected_policy_version<1 or p_confirmed is distinct from true then raise exception'authorization_begin_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',p_user_id,'candidate',p_candidate_id,'signed_hash',p_signed_hash,'identity_version',p_expected_identity_version,'a1_version',p_expected_a1_version,'policy_version',p_expected_policy_version,'confirmed',true));
 perform pg_advisory_xact_lock(174852964,hashtext(p_command_id::text));select *into cmd from erp_fiscal_authorization.command where id=p_command_id;
 if found then
  if cmd.actor<>p_user_id or cmd.request_hash<>tag then raise exception'authorization_command_conflict'using errcode='40001';end if;
  select *into a from erp_fiscal_authorization.attempt where id=cmd.attempt_id;
  s:=erp_fiscal_authorization.lock_source(p_user_id,p_candidate_id,a.state in('prepared','request_ready')and a.expires_at>clock_timestamp());
  if a.state not in('prepared','request_ready')or a.expires_at<=clock_timestamp()then return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',true,'execution',null);end if;
  perform erp_fiscal_authorization.check_a1(a);perform erp_fiscal_authorization.check_policy(a.model,a.policy_version);
  return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',true,'execution',erp_fiscal_authorization.context(a));
 end if;
 s:=erp_fiscal_authorization.lock_source(p_user_id,p_candidate_id,true);
 if s->>'signed_hash'is distinct from p_signed_hash then raise exception'authorization_source_conflict'using errcode='40001';end if;
 select *into h from erp_a1.head where singleton for share;c:=erp_fiscal_wsdl.check_a1(h,p_expected_identity_version,p_expected_a1_version);
 if c.context->>'holder_cnpj'is distinct from s->>'issuer_cnpj'then raise exception'authorization_issuer_conflict'using errcode='40001';end if;
 p:=erp_fiscal_authorization.check_policy(s->>'model',p_expected_policy_version);
 -- mutex016 serializes even missing intents. No second command advisory is acquired.
 select *into i from erp_fiscal_authorization.intent where reservation_id=(s->>'reservation_id')::uuid for update;
 if not found then
  insert into erp_fiscal_authorization.intent(id,reservation_id,access_key,issuer_cnpj,model)values(gen_random_uuid(),(s->>'reservation_id')::uuid,s->>'access_key',s->>'issuer_cnpj',s->>'model')returning *into i;
 elsif i.consumed_attempt_id is not null or exists(select 1 from erp_fiscal_authorization.attempt where id=i.active_attempt_id and state<>'failed_before_dispatch')then raise exception'authorization_intent_conflict'using errcode='40001';end if;
 if i.access_key is distinct from s->>'access_key'or i.issuer_cnpj is distinct from s->>'issuer_cnpj'or i.model is distinct from s->>'model'then raise exception'authorization_identity_conflict'using errcode='40001';end if;
 at:=clock_timestamp();insert into erp_fiscal_authorization.attempt(id,intent_id,command_id,actor,candidate_id,signed_hash,signed_size,reference_digest,policy_version,model,identity_version,a1_version,credential_id,envelope_hash,certificate_fingerprint,lease_id,nonce,expires_at,created_at,state)
 values(gen_random_uuid(),i.id,p_command_id,p_user_id,p_candidate_id,p_signed_hash,(s->>'signed_size')::integer,s->>'reference_digest',p.version,p.model,p_expected_identity_version,h.version,h.credential_id,h.object_hash,c.metadata->>'fingerprint_sha256',gen_random_uuid(),gen_random_uuid(),at+interval'60 seconds',at,'prepared')returning *into a;
 update erp_fiscal_authorization.intent set active_attempt_id=a.id where id=i.id;
 insert into erp_fiscal_authorization.command(id,actor,request_hash,attempt_id,receipt)values(p_command_id,p_user_id,tag,a.id,(s-array['issuer_cnpj','access_key','reference_digest'])||jsonb_build_object('attempt_id',a.id,'intent_id',i.id,'ordinal',a.ordinal::text,'command_id',p_command_id,'batch_id',a.ordinal::text,'environment','2','origin',p.origin,'policy_version',p.version,'identity_version',a.identity_version,'a1_version',a.a1_version,'created_at',a.created_at));
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'begin');
 if a.expires_at<=clock_timestamp()then raise exception'authorization_lease_expired'using errcode='40001';end if;
 return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',false,'execution',erp_fiscal_authorization.context(a));end$$;

create function erp_fiscal_authorization.lock_attempt(actor uuid,id uuid,lease uuid,require_current boolean)returns erp_fiscal_authorization.attempt language plpgsql set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;begin
 perform erp_a1.access(actor);select *into a from erp_fiscal_authorization.attempt where attempt.id=lock_attempt.id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(174852964,hashtext(a.command_id::text));perform erp_fiscal_authorization.lock_source(actor,a.candidate_id,require_current);
 if a.actor<>actor then raise exception'authorization_forbidden'using errcode='42501';end if;
 if require_current then perform erp_fiscal_authorization.check_a1(a);perform erp_fiscal_authorization.check_policy(a.model,a.policy_version);end if;
 perform 1 from erp_fiscal_authorization.intent where intent.id=a.intent_id for update;
 select *into a from erp_fiscal_authorization.attempt where attempt.id=lock_attempt.id for update;
 if lease is null or a.lease_id<>lease then raise exception'authorization_lease_conflict'using errcode='40001';end if;return a;end$$;
create function erp_fiscal_authorization.validate_preparation(a erp_fiscal_authorization.attempt,v jsonb,sha text)returns void language plpgsql stable set search_path=pg_catalog as $$
declare ctx jsonb:=erp_fiscal_authorization.context(a);k text;begin
 if not erp_a1.exact(v,array['origin','request_hash','payload_hash','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit'])or octet_length(v::text)>16384 then raise exception'authorization_preparation_invalid'using errcode='22023';end if;
 foreach k in array array['origin','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','binding_profile','rule_profile']loop
  if v->k is distinct from ctx->k then raise exception'authorization_preparation_binding'using errcode='22023';end if;
 end loop;
 if v->>'request_hash'is distinct from sha or v->>'schema_profile'is distinct from'brufap-authorization-pl010f-v1.04'or v->>'schema_manifest_hash'is distinct from'6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda'or v->>'validator_hash'is distinct from'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612'
  or jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$'
  or v->'signature_verified'is distinct from'true'::jsonb or v->'xsd_validated'is distinct from'true'::jsonb or v->'context_matched'is distinct from'true'::jsonb
  or v->'tax_rules_validated'is distinct from to_jsonb(ctx->>'origin'='operational')or v->'can_emit'is distinct from'false'::jsonb or v->'can_transmit'is distinct from'false'::jsonb
 then raise exception'authorization_preparation_invalid'using errcode='22023';end if;
end$$;
create function public.erp_fiscal_authorization_prepare(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_request_hash text,p_request_size integer,p_evidence jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;r erp_fiscal_authorization.request;has_request boolean;begin
 select exists(select 1 from erp_fiscal_authorization.request where attempt_id=p_attempt_id)into has_request;
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,not has_request);perform erp_fiscal_authorization.validate_preparation(a,p_evidence,p_request_hash);
 if p_request_hash is null or p_request_hash!~'^[a-f0-9]{64}$'or p_request_size is null or p_request_size not between 1 and 512000 then raise exception'authorization_request_invalid'using errcode='22023';end if;
 select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
 if found then
  if r.sha256<>p_request_hash or r.size_bytes<>p_request_size or r.evidence is distinct from p_evidence then raise exception'authorization_request_conflict'using errcode='40001';end if;
  return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',true);
 end if;
 if a.state<>'prepared'or a.expires_at<=clock_timestamp()then raise exception'authorization_prepare_conflict'using errcode='40001';end if;
 perform erp_fiscal_authorization.storage_check(a.id,'requests',p_request_hash,p_request_size);
 insert into erp_fiscal_authorization.request(attempt_id,sha256,size_bytes,evidence)values(a.id,p_request_hash,p_request_size,p_evidence);
 update erp_fiscal_authorization.attempt set state='request_ready'where id=a.id returning *into a;
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'prepare');
 if a.expires_at<=clock_timestamp()then raise exception'authorization_lease_expired'using errcode='40001';end if;
 return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',false);end$$;
create function public.erp_fiscal_authorization_use(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;r erp_fiscal_authorization.request;i erp_fiscal_authorization.intent;begin
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,true);
 select *into i from erp_fiscal_authorization.intent where id=a.intent_id;select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
 if a.state<>'request_ready'or a.expires_at<=clock_timestamp()or r.attempt_id is null or i.consumed_attempt_id is not null or i.active_attempt_id is distinct from a.id then raise exception'authorization_use_conflict'using errcode='40001';end if;
 perform erp_fiscal_authorization.storage_check(a.id,'requests',r.sha256,r.size_bytes);
 perform erp_fiscal_authorization.validate_preparation(a,r.evidence,r.sha256);
 update erp_fiscal_authorization.attempt set state='dispatched',used_at=clock_timestamp()where id=a.id returning *into a;
 update erp_fiscal_authorization.intent set consumed_attempt_id=a.id where id=a.intent_id;
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'consume');
 if a.expires_at<=clock_timestamp()then raise exception'authorization_lease_expired'using errcode='40001';end if;
 return erp_fiscal_authorization.flags()||jsonb_build_object('private_executor_only',true,'grant',erp_fiscal_authorization.context(a)||jsonb_build_object('issued_at',a.used_at));end$$;

create function erp_fiscal_authorization.result_state(a erp_fiscal_authorization.attempt,v jsonb,response_hash text,processed_hash text)returns text language plpgsql stable set search_path=pg_catalog as $$
declare ctx jsonb:=erp_fiscal_authorization.context(a);k text;observed boolean;begin
 if not erp_a1.exact(v,array['origin','request_hash','response_hash','payload_hash','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','receipt_number','reference_digest','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','transport_hash','transport_size','can_emit','can_transmit'])or octet_length(v::text)>16384 then raise exception'authorization_result_invalid'using errcode='22023';end if;
 foreach k in array array['origin','request_hash','binding_profile','rule_profile']loop
  if v->k is distinct from ctx->k then raise exception'authorization_result_binding'using errcode='22023';end if;
 end loop;
 if v->>'response_hash'is distinct from response_hash or v->>'schema_profile'is distinct from'brufap-authorization-pl010f-v1.04'or v->>'schema_manifest_hash'is distinct from'6248c0e9f23720a306df93e4c2e067f0b52a37ae6980e50846b2b4ff11334fda'or v->>'validator_hash'is distinct from'98453faa968544a8a19d9ae10a29dbbed3015f7e8898062be33bed37b21ad612'
  or v->'can_emit'is distinct from'false'::jsonb or v->'can_transmit'is distinct from'false'::jsonb
 then raise exception'authorization_result_invalid'using errcode='22023';end if;
 if ctx->>'origin'='synthetic'then
  if v->'tls_origin_verified'is distinct from'false'::jsonb or v->'transport_hash'is distinct from'null'::jsonb or v->'transport_size'is distinct from'null'::jsonb then raise exception'authorization_synthetic_origin'using errcode='22023';end if;
 else
  if v->'tls_origin_verified'is distinct from'true'::jsonb or jsonb_typeof(v->'transport_hash')is distinct from'string'or v->>'transport_hash'!~'^[a-f0-9]{64}$'or jsonb_typeof(v->'transport_size')is distinct from'number'or v->>'transport_size'!~'^[0-9]+$'or(v->>'transport_size')::numeric not between 1 and 8192 then raise exception'authorization_tls_evidence_required'using errcode='22023';end if;
 end if;
 if v->>'outcome'='invalid_response'then
  if v->'xsd_validated'is distinct from'false'::jsonb or v->'context_matched'is distinct from'false'::jsonb or v->'signature_verified'is distinct from'false'::jsonb or v->'processed_xsd_validated'is distinct from'false'::jsonb or processed_hash is not null
   or jsonb_typeof(v->'rejection_code')is distinct from'string'or v->>'rejection_code'not in('SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID')then raise exception'authorization_rejection_invalid'using errcode='22023';end if;
  foreach k in array array['cstat','protocol_cstat','protocol_number','received_at','receipt_number','reference_digest']loop if v->k is distinct from'null'::jsonb then raise exception'authorization_rejection_invalid'using errcode='22023';end if;end loop;
  if v->'payload_hash'<>'null'::jsonb and(jsonb_typeof(v->'payload_hash')<>'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$')then raise exception'authorization_payload_invalid'using errcode='22023';end if;
  return'review_required';
 end if;
 if v->'xsd_validated'is distinct from'true'::jsonb or v->'context_matched'is distinct from'true'::jsonb or v->'rejection_code'is distinct from'null'::jsonb
  or jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$'
  or jsonb_typeof(v->'cstat')is distinct from'string'or v->>'cstat'!~'^[0-9]{3,4}$'or not erp_a1.iso(v->'received_at')
 then raise exception'authorization_response_invalid'using errcode='22023';end if;
 if v->'protocol_cstat'<>'null'::jsonb and(jsonb_typeof(v->'protocol_cstat')<>'string'or v->>'protocol_cstat'!~'^[0-9]{3,4}$')then raise exception'authorization_protocol_invalid'using errcode='22023';end if;
 if v->'protocol_cstat'<>'null'::jsonb and v->>'cstat'<>'104'then raise exception'authorization_protocol_invalid'using errcode='22023';end if;
 if v->'protocol_number'<>'null'::jsonb and(jsonb_typeof(v->'protocol_number')<>'string'or v->>'protocol_number'!~'^([0-9]{15}|[0-9]{17})$'or v->>'protocol_number'~'^0+$')then raise exception'authorization_protocol_invalid'using errcode='22023';end if;
 observed:=v->>'outcome'='authorization_declared';
 if observed then
  if v->>'cstat'<>'104'or coalesce(v->>'protocol_cstat','')not in('100','150')or v->'protocol_number'='null'::jsonb or v->>'reference_digest'is distinct from a.reference_digest
   or v->'signature_verified'is distinct from'true'::jsonb or v->'processed_xsd_validated'is distinct from'true'::jsonb or processed_hash is null or v->'receipt_number'is distinct from'null'::jsonb
  then raise exception'authorization_protocol_incomplete'using errcode='22023';end if;
  return case when ctx->>'origin'='synthetic'then'authorization_observed'else'authorized_homologation'end;
 end if;
 if processed_hash is not null or v->'signature_verified'is distinct from'false'::jsonb or v->'processed_xsd_validated'is distinct from'false'::jsonb or v->'reference_digest'is distinct from'null'::jsonb then raise exception'authorization_unexpected_processed'using errcode='22023';end if;
 if v->>'outcome'='receipt_pending'then
  if v->>'cstat'<>'103'or jsonb_typeof(v->'receipt_number')is distinct from'string'or v->>'receipt_number'!~'^[0-9]{15}$'or v->>'receipt_number'~'^0+$'or v->'protocol_cstat'is distinct from'null'::jsonb or v->'protocol_number'is distinct from'null'::jsonb then raise exception'authorization_receipt_invalid'using errcode='22023';end if;
  return'receipt_pending';
 end if;
 if v->'receipt_number'is distinct from'null'::jsonb then raise exception'authorization_receipt_invalid'using errcode='22023';end if;
 if v->>'outcome'='rejected'then
  if coalesce(v->>'protocol_cstat',v->>'cstat')::integer<200 or coalesce(v->>'protocol_cstat',v->>'cstat')in('204','217','539')then raise exception'authorization_rejection_invalid'using errcode='22023';end if;
  return'rejected';
 elsif v->>'outcome'='review_required'then
  if v->>'protocol_cstat'in('100','150')or v->>'cstat'in('100','150')then raise exception'authorization_protocol_incomplete'using errcode='22023';end if;
  return'review_required';
 end if;
 raise exception'authorization_outcome_invalid'using errcode='22023';end$$;
create function public.erp_fiscal_authorization_finish(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_response_hash text,p_response_size integer,p_evidence jsonb,p_processed_hash text default null,p_processed_size integer default null)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;r erp_fiscal_authorization.request;tag text;next_state text;begin
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,false);
 if p_response_hash is null or p_response_hash!~'^[a-f0-9]{64}$'or p_response_size is null or p_response_size not between 1 and 512000
  or(p_processed_hash is null)is distinct from(p_processed_size is null)or(p_processed_hash is not null and(p_processed_hash!~'^[a-f0-9]{64}$'or p_processed_size not between 1 and 512000))then raise exception'authorization_finish_invalid'using errcode='22023';end if;
 if a.used_at is null or a.state not in('dispatched','submission_uncertain','receipt_pending','rejected','review_required','authorization_observed','authorized_homologation')then raise exception'authorization_finish_conflict'using errcode='40001';end if;
 next_state:=erp_fiscal_authorization.result_state(a,p_evidence,p_response_hash,p_processed_hash);
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('response_hash',p_response_hash,'response_size',p_response_size,'evidence',p_evidence,'processed_hash',p_processed_hash,'processed_size',p_processed_size));
 if exists(select 1 from erp_fiscal_authorization.result where attempt_id=a.id)then
  if a.finalize_hash is distinct from tag then raise exception'authorization_finish_conflict'using errcode='40001';end if;
  return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',true);
 end if;
 select *into r from erp_fiscal_authorization.request where attempt_id=a.id;
 perform erp_fiscal_authorization.storage_check(a.id,'requests',r.sha256,r.size_bytes);
 -- The response/sidecar keys are deterministic from the request, not response contents.
 perform erp_fiscal_authorization.storage_check(a.id,'responses',r.sha256,p_response_size);
 if p_evidence->>'origin'='operational'then perform erp_fiscal_authorization.storage_check(a.id,'observations',r.sha256,(p_evidence->>'transport_size')::integer);end if;
 if p_processed_hash is not null then perform erp_fiscal_authorization.storage_check(a.id,'processed',p_processed_hash,p_processed_size);end if;
 insert into erp_fiscal_authorization.result(attempt_id,response_hash,response_size,evidence,processed_hash,processed_size)values(a.id,p_response_hash,p_response_size,p_evidence,p_processed_hash,p_processed_size);
 update erp_fiscal_authorization.attempt set state=next_state,finished_at=clock_timestamp(),error_code=null,finalize_hash=tag where id=a.id returning *into a;
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'finish');
 return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',false);end$$;
create function public.erp_fiscal_authorization_fail(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;begin
 if p_error_code is null or p_error_code not in('PREPARATION_FAILED','REQUEST_INVALID','TRANSPORT_UNCONFIRMED','JOURNAL_UNAVAILABLE','VALIDATOR_UNAVAILABLE')then raise exception'authorization_failure_invalid'using errcode='22023';end if;
 a:=erp_fiscal_authorization.lock_attempt(p_user_id,p_attempt_id,p_lease_id,false);
 if a.state not in('prepared','request_ready','dispatched')then return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',true);end if;
 update erp_fiscal_authorization.attempt set state=case when used_at is null then'failed_before_dispatch'else'submission_uncertain'end,finished_at=clock_timestamp(),error_code=p_error_code where id=a.id returning *into a;
 insert into erp_fiscal_authorization.audit(attempt_id,actor,action)values(a.id,p_user_id,'fail');
 return erp_fiscal_authorization.view(a)||jsonb_build_object('replayed',false);end$$;
create function public.erp_fiscal_authorization_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;begin
 perform erp_a1.access(p_user_id);select *into a from erp_fiscal_authorization.attempt where command_id=p_command_id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 if a.actor<>p_user_id then raise exception'authorization_forbidden'using errcode='42501';end if;
 perform erp_fiscal_authorization.source(p_user_id,a.candidate_id,a.signed_hash);
 return erp_fiscal_authorization.view(a)||jsonb_build_object('read_only',true);end$$;
create function public.erp_fiscal_authorization_history(p_user_id uuid,p_candidate_id uuid,p_limit integer default 25,p_before bigint default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin
 perform erp_fiscal_authorization.source(p_user_id,p_candidate_id);
 if p_limit is null or p_limit not between 1 and 25 or(p_before is not null and p_before<1)then raise exception'authorization_page_invalid'using errcode='22023';end if;
 select coalesce(jsonb_agg(((erp_fiscal_authorization.view(a)-'recovery')||jsonb_build_object('read_only',true,'recoverable_by_actor',a.actor=p_user_id and a.used_at is not null and a.state in('dispatched','submission_uncertain')))order by a.ordinal desc),'[]'::jsonb)into items
 from(select *from erp_fiscal_authorization.attempt where candidate_id=p_candidate_id and(p_before is null or ordinal<p_before)order by ordinal desc limit p_limit)a;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_authorization.attempt where candidate_id=p_candidate_id and ordinal<(items->-1#>>'{receipt,ordinal}')::bigint);
 return erp_fiscal_authorization.flags()||jsonb_build_object('read_only',true,'candidate_id',p_candidate_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then items->-1#>>'{receipt,ordinal}'else null end);end$$;
revoke all on all functions in schema erp_fiscal_authorization from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_authorization_preview(uuid,uuid,text),public.erp_fiscal_authorization_begin(uuid,uuid,uuid,text,integer,integer,integer,boolean),public.erp_fiscal_authorization_prepare(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_authorization_use(uuid,uuid,uuid),public.erp_fiscal_authorization_finish(uuid,uuid,uuid,text,integer,jsonb,text,integer),public.erp_fiscal_authorization_fail(uuid,uuid,uuid,text),public.erp_fiscal_authorization_command(uuid,uuid),public.erp_fiscal_authorization_history(uuid,uuid,integer,bigint)from public,anon,authenticated;
grant execute on function public.erp_fiscal_authorization_preview(uuid,uuid,text),public.erp_fiscal_authorization_begin(uuid,uuid,uuid,text,integer,integer,integer,boolean),public.erp_fiscal_authorization_prepare(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_authorization_use(uuid,uuid,uuid),public.erp_fiscal_authorization_finish(uuid,uuid,uuid,text,integer,jsonb,text,integer),public.erp_fiscal_authorization_fail(uuid,uuid,uuid,text),public.erp_fiscal_authorization_command(uuid,uuid),public.erp_fiscal_authorization_history(uuid,uuid,integer,bigint)to service_role;
commit;
