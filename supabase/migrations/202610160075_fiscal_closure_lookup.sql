-- Read-only discovery of an existing074 receipt by its original authorization.
-- No new command, closure, retry, grant, table, index or policy.
begin;
create function public.erp_fiscal_reviewed_authorization_closure_lookup(
 p_user_id uuid,p_authorization_command_id uuid,p_expected_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;c erp_fiscal_authorization_closure.command;
begin
 perform erp_a1.access(p_user_id);
 if p_authorization_command_id is null or p_expected_attempt_id is null then
  raise exception'authorization_closure_lookup_invalid'using errcode='22023';
 end if;
 select *into a from erp_fiscal_authorization.attempt where command_id=p_authorization_command_id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 -- Ownership and current role/source authorization precede receipt existence/CAS.
 if a.actor<>p_user_id then raise exception'authorization_forbidden'using errcode='42501';end if;
 perform erp_fiscal_authorization.source(p_user_id,a.candidate_id,a.signed_hash);
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 if a.id is distinct from p_expected_attempt_id then
  raise exception'authorization_closure_lookup_conflict'using errcode='40001';
 end if;
 select *into c from erp_fiscal_authorization_closure.command where attempt_id=a.id;
 -- A terminal state or PREPARATION_FAILED never substitutes for an074 receipt.
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 return public.erp_fiscal_reviewed_authorization_closure_command(p_user_id,c.id);
end$$;
revoke all on function public.erp_fiscal_reviewed_authorization_closure_lookup(uuid,uuid,uuid)from public,anon,authenticated,service_role;
grant execute on function public.erp_fiscal_reviewed_authorization_closure_lookup(uuid,uuid,uuid)to service_role;
commit;
