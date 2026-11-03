-- Read-only reviewed069 preflight. No policy change, fiscal grant, journal or credential bytes.
begin;
create function public.erp_fiscal_reviewed_authorization_preflight(p_user_id uuid,p_candidate_id uuid,p_signed_hash text)
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
   and p.rule_profile=erp_fiscal_subset_review.profile()and p.source_manifest_hash=erp_fiscal_reviewed_authorization.manifest(s->>'model'),false),
  'policy_enabled',coalesce(p.enabled,false),
  'policy_within_validity',coalesce(at>=p.valid_from and at<p.valid_until,false),
  'profile_within_validity',at>='2026-10-16T00:00:00-03:00'::timestamptz and at<'2026-10-26T00:00:00-03:00'::timestamptz,
  'review_matches',coalesce(r.id is not null and r.candidate_version=c.version and r.signed_hash=a.signed_hash and r.signed_size=a.size_bytes
   and r.model=s->>'model'and r.issuer_cnpj=s->>'issuer_cnpj'and r.schema_evidence=a.evidence->'xsd'and r.profile_hash=erp_fiscal_subset_review.profile_hash(),false),
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
  'tax_rules_validated',false,'preflight_profile','authorization-reviewed-preflight-v1','read_only',true,
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
revoke all on function public.erp_fiscal_reviewed_authorization_preflight(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.erp_fiscal_reviewed_authorization_preflight(uuid,uuid,text)to service_role;
comment on function public.erp_fiscal_reviewed_authorization_preflight(uuid,uuid,text)is 'Read-only metadata snapshot for reviewed069; never a fiscal grant or proof of full tax validation.';
commit;
