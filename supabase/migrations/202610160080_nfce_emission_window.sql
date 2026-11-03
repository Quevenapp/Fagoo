-- New reviewed NFC-e consumption only. No source mutation, allocator, Storage or network.
-- B09-40: 300s maximum delay. Brufap reserves 30s before consumption for bounded RPC/TLS.
begin;

create function erp_fiscal_reviewed_authorization.check_nfce_emission_window(issued_at text,at_time timestamptz)
returns void language plpgsql immutable set search_path=pg_catalog as $$
declare emitted timestamptz;
begin
 if issued_at is null or at_time is null or not isfinite(at_time)
  or issued_at!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}-03:00$'
 then raise exception'nfce_emission_time_invalid'using errcode='55000';end if;
 begin emitted:=issued_at::timestamptz;
 exception when others then raise exception'nfce_emission_time_invalid'using errcode='55000';end;
 if to_char(emitted at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00' is distinct from issued_at
 then raise exception'nfce_emission_time_invalid'using errcode='55000';end if;
 if emitted>at_time+interval'300 seconds'then raise exception'nfce_emission_time_future'using errcode='40001';end if;
 if at_time>=emitted+interval'300 seconds'then raise exception'nfce_emission_time_expired'using errcode='40001';end if;
 if at_time>=emitted+interval'270 seconds'then raise exception'nfce_emission_window_too_short'using errcode='40001';end if;
end$$;

create function erp_fiscal_reviewed_authorization.guard_nfce_emission_window()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_fiscal_authorization.policy;source record;
begin
 if old.used_at is not null or new.used_at is null or new.model<>'65'then return new;end if;
 select *into p from erp_fiscal_authorization.policy where model=new.model and version=new.policy_version;
 if not found then raise exception'nfce_emission_source_invalid'using errcode='55000';end if;
 if p.origin<>'operational'or p.authorization_profile<>'reviewed_subset_v1'then return new;end if;
 -- These historical linkage columns and identity are immutable. Do not add row locks
 -- after the command/mutex/membership/policy/intent/attempt locks already held by use.
 select i.identity,i.access_key,r.id reservation_id,r.model,r.environment,r.issuer_cnpj,
  a.signed_hash,a.size_bytes,c.state candidate_state,j.state job_state,
  t.reservation_id intent_reservation_id,t.access_key intent_access_key,t.model intent_model,t.issuer_cnpj intent_issuer
 into source from erp_fiscal_signed.candidate c
 join erp_fiscal_signed.artifact a on a.candidate_id=c.id
 join erp_fiscal_unsigned.job j on j.id=c.unsigned_job_id
 join erp_fiscal_unsigned.identity i on i.reservation_id=j.reservation_id
 join erp_fiscal_numbering.reservation r on r.id=i.reservation_id
 join erp_fiscal_authorization.intent t on t.id=new.intent_id
 where c.id=new.candidate_id;
 if not found or source.candidate_state is distinct from'stored'or source.job_state is distinct from'stored'
  or source.signed_hash is distinct from new.signed_hash or source.size_bytes is distinct from new.signed_size
  or source.model is distinct from'65'or source.environment is distinct from'2'
  or source.reservation_id is distinct from source.intent_reservation_id
  or source.access_key is distinct from source.intent_access_key or source.model is distinct from source.intent_model
  or source.issuer_cnpj is distinct from source.intent_issuer
  or source.identity->>'model'is distinct from'65'or source.identity->>'environment'is distinct from'2'
  or source.identity->>'tpEmis'is distinct from'1'or source.identity->>'cnpj'is distinct from source.issuer_cnpj
 then raise exception'nfce_emission_source_invalid'using errcode='55000';end if;
 -- clock_timestamp (not transaction-start now) is intentionally sampled after waits.
 perform erp_fiscal_reviewed_authorization.check_nfce_emission_window(source.identity->>'issuedAt',clock_timestamp());
 return new;
end$$;

-- PostgreSQL runs same-kind triggers alphabetically. This MUST follow
-- reviewed_use_guard069, whose check_review may wait for another reviewer's ACL
-- even when the caller entered through the older direct064 RPC.
create trigger reviewed_use_time_guard before update of used_at on erp_fiscal_authorization.attempt
 for each row when(old.used_at is null and new.used_at is not null)
 execute function erp_fiscal_reviewed_authorization.guard_nfce_emission_window();
-- The audit's actor FK can still wait after the BEFORE trigger. Recheck before
-- commit so no consumed intent/audit survives a deadline crossed in that wait.
-- SECURITY DEFINER above is required when a deferred trigger runs after the RPC
-- has restored its service_role caller; all direct EXECUTE privileges stay closed.
create constraint trigger reviewed_use_time_commit after update on erp_fiscal_authorization.attempt
 deferrable initially deferred for each row when(old.used_at is null and new.used_at is not null)
 execute function erp_fiscal_reviewed_authorization.guard_nfce_emission_window();
revoke all on function erp_fiscal_reviewed_authorization.check_nfce_emission_window(text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function erp_fiscal_reviewed_authorization.guard_nfce_emission_window() from public,anon,authenticated,service_role;
commit;
