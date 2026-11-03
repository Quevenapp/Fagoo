-- GS1 reviewed rule profile v2. No new journal, no activation, no historical rewrite.
begin;
create function erp_fiscal_subset_review.profile_definition(profile_hash text)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
begin
 if profile_hash='e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504'then return jsonb_build_object('profile',erp_fiscal_subset_review.profile(),'profile_hash',profile_hash,'valid_from','2026-10-16T00:00:00-03:00','review_before','2026-10-26T00:00:00-03:00','gs1_manifest_hash',null);
 elsif profile_hash='d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6'then return jsonb_build_object('profile','sp-crt1-internal-sale-homologation-20261017-v2','profile_hash',profile_hash,'valid_from','2026-10-16T00:00:00-03:00','review_before','2026-10-26T00:00:00-03:00','gs1_manifest_hash','de4dcf61603e314d421575cfb7cb528896b489a44a24959b1a38145bc22d6140');
 else raise exception'subset_review_profile_invalid'using errcode='22023';end if;
end$$;
create function erp_fiscal_subset_review.current_profile_hash()returns text language sql immutable set search_path=pg_catalog as $$select 'd6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6'::text$$;
create function erp_fiscal_reviewed_authorization.manifest(model_id text,profile_hash text)returns text language plpgsql immutable set search_path=pg_catalog as $$
begin
 perform erp_fiscal_subset_review.profile_definition(profile_hash);
 if model_id not in('55','65')or model_id is null then raise exception'reviewed_model_invalid'using errcode='22023';end if;
 if profile_hash='e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504'then return erp_fiscal_reviewed_authorization.manifest(model_id);end if;
 return case model_id when '55'then'e70502bf2fa3a720dcd1eb7abf689d90cf61b192e01cdd182cbba816057e4f9b'else'b4ddf9d9fff3a9efff05d6cc97e9904835314455ab730ee4cc8ba0c9e13b07f7'end;
end$$;
-- Keep every old row and the immutable trigger. Only its closed hash allowlist grows.
alter table erp_fiscal_subset_review.review drop constraint review_profile_hash_check;
alter table erp_fiscal_subset_review.review add constraint review_supported_profile_hash_check check(profile_hash in('e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504','d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6'));


create or replace function erp_fiscal_subset_review.view(actor_id uuid,r erp_fiscal_subset_review.review,candidate uuid,candidate_version integer,signed_hash text,facts_hash text,profile_hash text,readonly boolean,replayed boolean)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare latest erp_fiscal_subset_review.review;receipt jsonb;begin
 select *into latest from erp_fiscal_subset_review.review where candidate_id=candidate order by version desc limit 1;
 if r.id is not null then receipt:=jsonb_build_object('review_id',r.id,'command_id',r.id,'review_version',r.version,'reviewed_by',r.actor,
  'reviewed_at',to_char(r.reviewed_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'valid_until',to_char(r.valid_until at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'candidate_id',r.candidate_id,'candidate_version',r.candidate_version,'signed_hash',r.signed_hash,'facts_hash',r.facts_hash,
  'profile',erp_fiscal_subset_review.profile_definition(r.profile_hash)->>'profile','profile_hash',r.profile_hash,'schema',r.schema_evidence,'review_hash',r.review_hash,'coverage','listed_rules_only_not_full_tax_validation');end if;
 return erp_fiscal_subset_review.flags()||jsonb_build_object('actor',actor_id,'candidate_id',candidate,'candidate_version',candidate_version,
  'signed_hash',signed_hash,'facts_hash',facts_hash,'profile_hash',profile_hash,'read_only',readonly,'replayed',replayed,'receipt',receipt,
  'current',jsonb_build_object('latest_review_id',latest.id,'latest_review_version',coalesce(latest.version,0),'is_latest',r.id is not null and r.id=latest.id,
   'reviewer_active',r.id is not null and exists(select 1 from erp_access.membership where user_id=r.actor and active and role in('admin','fiscal')),
   'within_validity',r.id is not null and clock_timestamp()>=r.reviewed_at and clock_timestamp()<r.valid_until),
  'record_text',r.record_text);
end$$;

create or replace function public.erp_fiscal_subset_review_save(p_user_id uuid,p_command_id uuid,p_candidate_id uuid,p_expected_candidate_version integer,p_signed_hash text,p_expected_review_version integer,p_facts_hash text,p_profile_hash text,p_schema jsonb,p_valid_until text,p_declaration_text text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d jsonb;s jsonb;a erp_fiscal_signed.artifact;r erp_fiscal_subset_review.review;head integer;tag text;at timestamptz;expires timestamptz;record jsonb;body text;rh text;begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null or p_candidate_id is null or p_expected_candidate_version is null or p_expected_candidate_version<1
  or p_expected_review_version is null or p_expected_review_version not between 0 and 2147483646
  or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'or p_facts_hash is null or p_facts_hash!~'^[a-f0-9]{64}$'
  or p_profile_hash is null or p_profile_hash not in('e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504','d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6')
  or not erp_a1.exact(p_schema,array['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash'])
  or p_valid_until is null or p_valid_until!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 then raise exception'subset_review_input_invalid'using errcode='22023';end if;
 begin expires:=p_valid_until::timestamptz;exception when others then raise exception'subset_review_time_invalid'using errcode='22023';end;
 if to_char(expires at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_valid_until then raise exception'subset_review_time_invalid'using errcode='22023';end if;
 d:=erp_fiscal_subset_review.declaration(p_declaration_text);
 tag:=erp_fiscal_subset_review.digest(erp_fiscal_subset_review.canonical(jsonb_build_object('actor',p_user_id,'command',p_command_id,'candidate',p_candidate_id,'candidate_version',p_expected_candidate_version,'signed_hash',p_signed_hash,'previous_version',p_expected_review_version,'facts_hash',p_facts_hash,'profile_hash',p_profile_hash,'schema',p_schema,'valid_until',p_valid_until,'declaration',d)));
 perform pg_advisory_xact_lock(174852968,hashtext(p_command_id::text));
 select *into r from erp_fiscal_subset_review.review where id=p_command_id;
 if found then
  if r.actor<>p_user_id or r.request_hash<>tag then raise exception'subset_review_command_conflict'using errcode='40001';end if;
  perform erp_fiscal_authorization.lock_source(p_user_id,r.candidate_id,false);
  return erp_fiscal_subset_review.view(p_user_id,r,r.candidate_id,r.candidate_version,r.signed_hash,r.facts_hash,r.profile_hash,false,true);
 end if;
 if p_profile_hash<>erp_fiscal_subset_review.current_profile_hash()then raise exception'subset_review_profile_superseded'using errcode='40001';end if;
 -- No intent/attempt locks. This ordering is compatible with064 and mutex016.
 s:=erp_fiscal_authorization.lock_source(p_user_id,p_candidate_id,true);
 if s->>'signed_hash'is distinct from p_signed_hash or(s->>'candidate_version')::integer is distinct from p_expected_candidate_version then raise exception'subset_review_candidate_conflict'using errcode='40001';end if;
 select *into a from erp_fiscal_signed.artifact where candidate_id=p_candidate_id;
 if a.evidence->'xsd'is distinct from p_schema then raise exception'subset_review_schema_conflict'using errcode='40001';end if;
 select coalesce(max(version),0)into head from erp_fiscal_subset_review.review where candidate_id=p_candidate_id;
 if head<>p_expected_review_version then raise exception'subset_review_version_conflict'using errcode='40001';end if;
 at:=date_trunc('milliseconds',clock_timestamp());
 if at<'2026-10-16T00:00:00-03:00'::timestamptz or at>='2026-10-26T00:00:00-03:00'::timestamptz or expires<=at or expires>'2026-10-26T00:00:00-03:00'::timestamptz then raise exception'subset_review_time_invalid'using errcode='22023';end if;
 record:=jsonb_build_object('id',p_command_id,'version',head+1,'candidate_id',p_candidate_id,'signed_hash',p_signed_hash,'facts_hash',p_facts_hash,
  'profile',erp_fiscal_subset_review.profile_definition(p_profile_hash)->>'profile','profile_hash',p_profile_hash,'reviewed_by',p_user_id,
  'reviewed_at',to_char(at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'valid_until',p_valid_until,'document',d->'document','items',d->'items');
 body:=erp_fiscal_subset_review.canonical(record);rh:=erp_fiscal_subset_review.digest(body);body:=erp_fiscal_subset_review.canonical(record||jsonb_build_object('review_hash',rh));
 if octet_length(body)>131072 then raise exception'subset_review_size_invalid'using errcode='22023';end if;
 insert into erp_fiscal_subset_review.review(id,actor,request_hash,candidate_id,candidate_version,signed_hash,signed_size,model,issuer_cnpj,schema_evidence,facts_hash,profile_hash,version,previous_version,declaration,record_text,review_hash,reviewed_at,valid_until)
 values(p_command_id,p_user_id,tag,p_candidate_id,p_expected_candidate_version,p_signed_hash,(s->>'signed_size')::integer,s->>'model',s->>'issuer_cnpj',p_schema,p_facts_hash,p_profile_hash,head+1,head,d,body,rh,at,expires)returning *into r;
 return erp_fiscal_subset_review.view(p_user_id,r,r.candidate_id,r.candidate_version,r.signed_hash,r.facts_hash,r.profile_hash,false,false);
end$$;

create or replace function public.erp_fiscal_subset_review_get(p_user_id uuid,p_candidate_id uuid,p_candidate_version integer,p_signed_hash text,p_facts_hash text,p_profile_hash text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;r erp_fiscal_subset_review.review;begin
 if p_candidate_id is null or p_candidate_version is null or p_candidate_version<1 or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'
  or p_facts_hash is null or p_facts_hash!~'^[a-f0-9]{64}$'or p_profile_hash is null or p_profile_hash not in('e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504','d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6')then raise exception'subset_review_input_invalid'using errcode='22023';end if;
 s:=erp_fiscal_authorization.source(p_user_id,p_candidate_id,p_signed_hash);
 if(s->>'candidate_version')::integer<>p_candidate_version then raise exception'subset_review_candidate_conflict'using errcode='40001';end if;
 -- Select the latest FIRST. A mismatching new review must not reveal an older matching version.
 select *into r from erp_fiscal_subset_review.review where candidate_id=p_candidate_id order by version desc limit 1;
 if r.id is not null and(r.candidate_version<>p_candidate_version or r.signed_hash<>p_signed_hash or r.facts_hash<>p_facts_hash or r.profile_hash<>p_profile_hash)then raise exception'subset_review_latest_conflict'using errcode='40001';end if;
 return erp_fiscal_subset_review.view(p_user_id,r,p_candidate_id,p_candidate_version,p_signed_hash,p_facts_hash,p_profile_hash,true,false);
end$$;

create function public.erp_fiscal_subset_review_latest(p_user_id uuid,p_candidate_id uuid,p_candidate_version integer,p_signed_hash text,p_facts_hash text,p_profile_hash text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;r erp_fiscal_subset_review.review;a erp_fiscal_signed.artifact;begin
 perform erp_a1.access(p_user_id);
 if p_candidate_id is null or p_candidate_version is null or p_candidate_version<1 or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'
  or p_facts_hash is null or p_facts_hash!~'^[a-f0-9]{64}$'then raise exception'subset_review_input_invalid'using errcode='22023';end if;
 perform erp_fiscal_subset_review.profile_definition(p_profile_hash);
 s:=erp_fiscal_authorization.source(p_user_id,p_candidate_id,p_signed_hash);
 if(s->>'candidate_version')::integer<>p_candidate_version then raise exception'subset_review_candidate_conflict'using errcode='40001';end if;
 select *into r from erp_fiscal_subset_review.review where candidate_id=p_candidate_id order by version desc limit 1;
 select *into a from erp_fiscal_signed.artifact where candidate_id=p_candidate_id;
 if r.id is not null and(r.candidate_version<>p_candidate_version or r.signed_hash<>p_signed_hash or r.facts_hash<>p_facts_hash or r.schema_evidence is distinct from a.evidence->'xsd')then raise exception'subset_review_latest_conflict'using errcode='40001';end if;
 return erp_fiscal_subset_review.view(p_user_id,r,p_candidate_id,p_candidate_version,p_signed_hash,p_facts_hash,p_profile_hash,true,false)
  ||jsonb_build_object('lookup_profile','subset-review-latest-v1','matches_requested_profile',coalesce(r.profile_hash=p_profile_hash,false));
end$$;

create or replace function erp_fiscal_reviewed_authorization.proof(r erp_fiscal_subset_review.review)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('candidate_id',r.candidate_id,'candidate_version',r.candidate_version,'signed_hash',r.signed_hash,'facts_hash',r.facts_hash,
 'profile',erp_fiscal_subset_review.profile_definition(r.profile_hash)->>'profile','profile_hash',r.profile_hash,'review_id',r.id,'review_version',r.version,'review_hash',r.review_hash,'reviewed_by',r.actor,
 'reviewed_at',to_char(r.reviewed_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'valid_until',to_char(r.valid_until at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'coverage','listed_rules_only_not_full_tax_validation','tax_rules_validated',false)
$$;

create or replace function erp_fiscal_reviewed_authorization.check_review(a erp_fiscal_authorization.attempt,v jsonb,require_current boolean)returns erp_fiscal_subset_review.review language plpgsql set search_path=pg_catalog as $$
declare r erp_fiscal_subset_review.review;b erp_fiscal_reviewed_authorization.review_binding;cmd erp_fiscal_authorization.command;i erp_fiscal_authorization.intent;artifact erp_fiscal_signed.artifact;latest uuid;p erp_fiscal_authorization.policy;definition jsonb;begin
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 if not erp_a1.exact(v,array['candidate_id','candidate_version','signed_hash','facts_hash','profile','profile_hash','review_id','review_version','review_hash','reviewed_by','reviewed_at','valid_until','coverage','tax_rules_validated'])
 or jsonb_typeof(v->'review_id')is distinct from'string' or v->>'review_id'!~'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 then raise exception'reviewed_proof_invalid'using errcode='22023';end if;
 select *into r from erp_fiscal_subset_review.review where id=(v->>'review_id')::uuid;
 if r.id is null or v is distinct from erp_fiscal_reviewed_authorization.proof(r)then raise exception'reviewed_proof_conflict'using errcode='40001';end if;
 definition:=erp_fiscal_subset_review.profile_definition(r.profile_hash);
 select *into p from erp_fiscal_authorization.policy where model=a.model and version=a.policy_version;
 select *into cmd from erp_fiscal_authorization.command where id=a.command_id;
 select *into i from erp_fiscal_authorization.intent where id=a.intent_id;
 select *into artifact from erp_fiscal_signed.artifact where candidate_id=a.candidate_id;
 if r.candidate_id<>a.candidate_id or r.candidate_version is distinct from(cmd.receipt->>'candidate_version')::integer
 or r.signed_hash<>a.signed_hash or r.signed_size<>a.signed_size or r.model<>a.model or r.issuer_cnpj<>i.issuer_cnpj
 or r.schema_evidence is distinct from artifact.evidence->'xsd'
 or p.rule_profile is distinct from definition->>'profile' or p.source_manifest_hash is distinct from erp_fiscal_reviewed_authorization.manifest(a.model,r.profile_hash)
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
declare p erp_fiscal_authorization.policy;selected_hash text;begin
 select *into p from erp_fiscal_authorization.policy where model=model_id order by version desc limit 1 for share;
 if p.version is distinct from expected then raise exception'authorization_policy_conflict'using errcode='40001';end if;
 if not p.enabled or not(clock_timestamp()>=p.valid_from and clock_timestamp()<p.valid_until)then raise exception'authorization_policy_disabled'using errcode='55000';end if;
 if p.authorization_profile='legacy_v1'then
  if p.origin='operational'and(not p.binding_reviewed or not p.tax_rules_reviewed)then raise exception'authorization_policy_disabled'using errcode='55000';end if;
 elsif p.authorization_profile='reviewed_subset_v1'then
  selected_hash:=case p.rule_profile when 'sp-crt1-internal-sale-homologation-20261016-v1'then'e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504' when 'sp-crt1-internal-sale-homologation-20261017-v2'then'd6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6'end;
  if p.tax_rules_reviewed or(p.origin='operational'and not p.binding_reviewed)
   or p.binding_profile is distinct from 'sp'||p.model||'-authorization-soap12-reviewed-20261016-v1'
   or selected_hash is null
   or p.source_manifest_hash is distinct from erp_fiscal_reviewed_authorization.manifest(p.model,selected_hash)
   or clock_timestamp()<'2026-10-16T00:00:00-03:00'::timestamptz or clock_timestamp()>='2026-10-26T00:00:00-03:00'::timestamptz
  then raise exception'reviewed_policy_disabled'using errcode='55000';end if;
 else raise exception'reviewed_policy_invalid'using errcode='55000';end if;return p;
end$$;

create or replace function public.erp_fiscal_reviewed_authorization_preflight(p_user_id uuid,p_candidate_id uuid,p_signed_hash text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
 s jsonb;c erp_fiscal_signed.candidate;a erp_fiscal_signed.artifact;
 co erp_company.identity;h erp_a1.head;k erp_a1.credential;o erp_a1.sealed_object;
 p erp_fiscal_authorization.policy;r erp_fiscal_subset_review.review;i erp_fiscal_authorization.intent;
 current_source jsonb;checks jsonb;blockers jsonb:='[]';at timestamptz:=clock_timestamp();pair text[];
begin
 perform erp_a1.access(p_user_id);
 if p_candidate_id is null or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'then raise exception'reviewed_preflight_invalid'using errcode='22023';end if;
 s:=erp_fiscal_authorization.source(p_user_id,p_candidate_id,p_signed_hash);
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;
 select *into a from erp_fiscal_signed.artifact where candidate_id=p_candidate_id;
 select *into co from erp_company.identity where singleton;
 select *into h from erp_a1.head where singleton;
 select *into k from erp_a1.credential where id=h.credential_id;
 select *into o from erp_a1.sealed_object where hash=h.object_hash and credential_id=h.credential_id;
 select *into p from erp_fiscal_authorization.policy where model=s->>'model'order by version desc limit 1;
 -- Latest FIRST, including mismatching/expired declarations. Never fall back to an older match.
 select *into r from erp_fiscal_subset_review.review where candidate_id=p_candidate_id order by version desc limit 1;
 select *into i from erp_fiscal_authorization.intent where reservation_id=(s->>'reservation_id')::uuid;
 current_source:=erp_fiscal_signed.current(c);
 checks:=jsonb_build_object(
  'artifact_current',coalesce(current_source->'artifact_current'='true'::jsonb,false),
  'identity_matches',coalesce(co.version>0 and co.data->>'cnpj'=s->>'issuer_cnpj',false),
  'a1_usable',coalesce(h.version>0 and k.id is not null and o.hash is not null
   and k.context->'company_identity_version'=to_jsonb(co.version)
   and k.context->>'holder_cnpj'=co.data->>'cnpj'and k.metadata->>'holder_cnpj'=co.data->>'cnpj'
   and k.context->>'environment'='2'and k.context->>'purpose'='offline-homologation'
   and k.metadata->'key_matches_certificate'='true'::jsonb
   and at between(k.metadata->>'not_before')::timestamptz and(k.metadata->>'not_after')::timestamptz
   and exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)
   and exists(select 1 from storage.buckets where id='brufap-a1-vault'and name='brufap-a1-vault'and not public and file_size_limit=1500000 and allowed_mime_types=array['application/json']::text[])
   and exists(select 1 from storage.objects where bucket_id='brufap-a1-vault'and name='credentials/'||k.id::text||'/'||o.hash||'.json'and metadata->>'size'=o.size_bytes::text and metadata->>'mimetype'='application/json'),false),
  'policy_matches',coalesce(p.authorization_profile='reviewed_subset_v1'and p.origin='operational'and not p.tax_rules_reviewed
   and p.binding_reviewed and p.binding_profile='sp'||(s->>'model')||'-authorization-soap12-reviewed-20261016-v1'
   and p.rule_profile=(erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile')and p.source_manifest_hash=erp_fiscal_reviewed_authorization.manifest(s->>'model',erp_fiscal_subset_review.current_profile_hash()),false),
  'policy_enabled',coalesce(p.enabled,false),
  'policy_within_validity',coalesce(at>=p.valid_from and at<p.valid_until,false),
  'profile_within_validity',at>='2026-10-16T00:00:00-03:00'::timestamptz and at<'2026-10-26T00:00:00-03:00'::timestamptz,
  'review_matches',coalesce(r.id is not null and r.candidate_version=c.version and r.signed_hash=a.signed_hash and r.signed_size=a.size_bytes
   and r.model=s->>'model'and r.issuer_cnpj=s->>'issuer_cnpj'and r.schema_evidence=a.evidence->'xsd'and r.profile_hash=erp_fiscal_subset_review.current_profile_hash(),false),
  'reviewer_active',r.id is not null and exists(select 1 from erp_access.membership where user_id=r.actor and active and role in('admin','fiscal')),
  'review_within_validity',coalesce(at>=r.reviewed_at and at<r.valid_until,false),
  'submission_consumed',i.consumed_attempt_id is not null,
  'attempt_in_progress',i.active_attempt_id is not null and exists(select 1 from erp_fiscal_authorization.attempt where id=i.active_attempt_id and state<>'failed_before_dispatch'));
 foreach pair slice 1 in array array[
  ['artifact_current','CANDIDATE_NOT_CURRENT'],['identity_matches','IDENTITY_MISMATCH'],['a1_usable','A1_UNAVAILABLE'],
  ['policy_matches','REVIEWED_POLICY_MISMATCH'],['policy_enabled','POLICY_DISABLED'],['policy_within_validity','POLICY_TIME_INVALID'],
  ['profile_within_validity','PROFILE_TIME_INVALID'],['review_matches','REVIEW_MISSING_OR_MISMATCHED'],
  ['reviewer_active','REVIEWER_INACTIVE'],['review_within_validity','REVIEW_TIME_INVALID']
 ]loop if checks->pair[1]='false'::jsonb then blockers:=blockers||to_jsonb(pair[2]);end if;end loop;
 if checks->'submission_consumed'='true'::jsonb then blockers:=blockers||'"SUBMISSION_ALREADY_CONSUMED"'::jsonb;end if;
 if checks->'attempt_in_progress'='true'::jsonb then blockers:=blockers||'"ATTEMPT_ALREADY_EXISTS"'::jsonb;end if;
 return erp_fiscal_authorization.flags()||jsonb_build_object(
  'tax_rules_validated',false,'preflight_profile','authorization-reviewed-preflight-v2','read_only',true,
  'candidate',jsonb_build_object('candidate_id',c.id,'candidate_version',c.version,'model',s->>'model','signed_hash',a.signed_hash),
  'versions',jsonb_build_object('identity',co.version,'a1',nullif(h.version,0),'policy',p.version),
  'policy',case when p.version is null then null else jsonb_build_object('authorization_profile',p.authorization_profile,'origin',p.origin,'enabled',p.enabled,
   'binding_profile',p.binding_profile,'rule_profile',p.rule_profile,'binding_reviewed',p.binding_reviewed,'tax_rules_reviewed',p.tax_rules_reviewed,
   'source_manifest_hash',p.source_manifest_hash,'valid_from',p.valid_from,'valid_until',p.valid_until)end,
  'review',case when r.id is null then null else jsonb_build_object('review_id',r.id,'review_version',r.version,'review_hash',r.review_hash,
   'candidate_version',r.candidate_version,'signed_hash',r.signed_hash,'facts_hash',r.facts_hash,'profile_hash',r.profile_hash,
   'reviewed_by',r.actor,'reviewed_at',r.reviewed_at,'valid_until',r.valid_until)end,
  'checks',checks,'blockers',blockers,'observed_at',at);
end$$;

-- Append only; each model retains all previous policy versions unchanged.
insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
 select m,coalesce((select max(version)from erp_fiscal_authorization.policy where model=m),0)+1,'operational',false,
 'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile',true,false,
 erp_fiscal_reviewed_authorization.manifest(m,erp_fiscal_subset_review.current_profile_hash()),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'
 from unnest(array['55','65'])m;
revoke all on function erp_fiscal_subset_review.profile_definition(text),erp_fiscal_subset_review.current_profile_hash(),erp_fiscal_reviewed_authorization.manifest(text,text)from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_subset_review_latest(uuid,uuid,integer,text,text,text)from public,anon,authenticated;
grant execute on function public.erp_fiscal_subset_review_latest(uuid,uuid,integer,text,text,text)to service_role;
commit;
