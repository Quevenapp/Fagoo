-- Atomically bind the displayed068 review to a new069 command. No new ledger or policy.
begin;
create function public.erp_fiscal_reviewed_authorization_begin_selected(
 p_user_id uuid,p_command_id uuid,p_candidate_id uuid,p_signed_hash text,
 p_expected_identity_version integer,p_expected_a1_version integer,p_expected_policy_version integer,p_confirmed boolean,
 p_expected_candidate_version integer,p_expected_review_id uuid,p_expected_review_version integer,
 p_expected_review_hash text,p_expected_facts_hash text,p_expected_profile_hash text,p_rule_review jsonb
)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v jsonb;a erp_fiscal_authorization.attempt;r erp_fiscal_subset_review.review;
 b erp_fiscal_reviewed_authorization.review_binding;fresh boolean;begin
 perform erp_a1.access(p_user_id);
 if p_expected_candidate_version is null or p_expected_candidate_version<1 or p_expected_review_id is null
  or p_expected_review_version is null or p_expected_review_version<1
  or p_expected_review_hash is null or p_expected_review_hash!~'^[a-f0-9]{64}$'
  or p_expected_facts_hash is null or p_expected_facts_hash!~'^[a-f0-9]{64}$'
  or p_expected_profile_hash is null or p_expected_profile_hash!~'^[a-f0-9]{64}$'
 then raise exception'reviewed_selection_invalid'using errcode='22023';end if;
 -- begin064 owns command advisory -> source/basis -> mutex016 -> membership ->
 -- A1/policy -> intent/attempt. Never acquire a review/FK lock before this chain.
 v:=public.erp_fiscal_reviewed_authorization_begin(p_user_id,p_command_id,p_candidate_id,p_signed_hash,
  p_expected_identity_version,p_expected_a1_version,p_expected_policy_version,p_confirmed);
 select *into a from erp_fiscal_authorization.attempt where command_id=p_command_id;
 fresh:=v->'view'->'replayed'='false'::jsonb;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 -- An earlier begin without a selection is not silently adopted by this contract.
 if not fresh and b.attempt_id is null then raise exception'reviewed_selection_missing'using errcode='40001';end if;
 if (v->'view'->'receipt'->>'candidate_version')::integer is distinct from p_expected_candidate_version
  or p_rule_review->'candidate_version'is distinct from to_jsonb(p_expected_candidate_version)
  or p_rule_review->'review_id'is distinct from to_jsonb(p_expected_review_id)
  or p_rule_review->'review_version'is distinct from to_jsonb(p_expected_review_version)
  or p_rule_review->'review_hash'is distinct from to_jsonb(p_expected_review_hash)
  or p_rule_review->'facts_hash'is distinct from to_jsonb(p_expected_facts_hash)
  or p_rule_review->'profile_hash'is distinct from to_jsonb(p_expected_profile_hash)
 then raise exception'reviewed_selection_conflict'using errcode='40001';end if;
 -- Fresh writes require latest + active reviewer + unexpired review. Replay is
 -- historical: prepare/use remain responsible for fresh revalidation before use.
 r:=erp_fiscal_reviewed_authorization.check_review(a,p_rule_review,fresh);
 if fresh then
  insert into erp_fiscal_reviewed_authorization.review_binding(attempt_id,review_id,proof,schema_evidence)
   values(a.id,r.id,p_rule_review,r.schema_evidence);
 end if;
 return erp_fiscal_reviewed_authorization.wrap(a,v->'view');
end$$;
revoke all on function public.erp_fiscal_reviewed_authorization_begin_selected(uuid,uuid,uuid,text,integer,integer,integer,boolean,integer,uuid,integer,text,text,text,jsonb)from public,anon,authenticated;
grant execute on function public.erp_fiscal_reviewed_authorization_begin_selected(uuid,uuid,uuid,text,integer,integer,integer,boolean,integer,uuid,integer,text,text,text,jsonb)to service_role;
commit;
