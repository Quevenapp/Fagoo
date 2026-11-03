-- Revalidate stored SOAP bytes. No dispatch, lease, grant, policy or064/069 rewrite.
-- Parser profile binds exact reviewed JS files; Python/XSD pins remain unchanged.
begin;
create schema erp_fiscal_authorization_revalidation;
revoke all on schema erp_fiscal_authorization_revalidation from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_revalidation revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_revalidation revoke all on functions from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_authorization_revalidation revoke all on sequences from public,anon,authenticated,service_role;

create function erp_fiscal_authorization_revalidation.profile()returns text language sql immutable set search_path=pg_catalog as $$select 'authorization-stored-response-utf8-v1'::text$$;
create function erp_fiscal_authorization_revalidation.manifest()returns text language sql immutable set search_path=pg_catalog as $$select '26a4ba4dcc9dbad2e196ae76136fbe8465f5dd235ca7aa30c468c192a8cce033'::text$$;
create function erp_fiscal_authorization_revalidation.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'data_mode','fiscal_authorization_revalidation','environment','2','tax_rules_validated',false,'can_emit',false,'can_transmit',false,
 'production_authorized',false,'financial_mutation_performed',false,'stock_mutation_performed',false,'retry_submission_allowed',false)$$;

create table erp_fiscal_authorization_revalidation.command(
 id uuid primary key,actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 attempt_id uuid not null references erp_fiscal_authorization.attempt(id),
 parser_profile text not null,parser_manifest_hash text not null check(parser_manifest_hash~'^[a-f0-9]{64}$'),
 source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),source jsonb not null,receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp(),unique(attempt_id,parser_profile));
alter table erp_fiscal_authorization_revalidation.command enable row level security;
revoke all on table erp_fiscal_authorization_revalidation.command from public,anon,authenticated,service_role;
create trigger immutable before update or delete on erp_fiscal_authorization_revalidation.command
 for each row execute function erp_fiscal_authorization.immutable();

-- All fields are captured history. Current A1/policy/review/bases are not a gate.
-- This helper is also used after every waiting lock in finish.
create function erp_fiscal_authorization_revalidation.source(actor uuid,original uuid,expected_attempt uuid)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare a erp_fiscal_authorization.attempt;i erp_fiscal_authorization.intent;r erp_fiscal_authorization.result;
 b erp_fiscal_reviewed_authorization.review_binding;o erp_fiscal_reviewed_authorization.observation;v jsonb;ctx jsonb;
begin
 perform erp_a1.access(actor);
 if original is null or expected_attempt is null then raise exception'revalidation_input_invalid'using errcode='22023';end if;
 select *into a from erp_fiscal_authorization.attempt where command_id=original;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 if a.actor<>actor then raise exception'authorization_forbidden'using errcode='42501';end if;
 perform erp_fiscal_authorization.source(actor,a.candidate_id,a.signed_hash);
 perform erp_fiscal_reviewed_authorization.require_profile(a);
 if a.id is distinct from expected_attempt then raise exception'revalidation_source_conflict'using errcode='40001';end if;
 select *into i from erp_fiscal_authorization.intent where id=a.intent_id;
 select *into r from erp_fiscal_authorization.result where attempt_id=a.id;
 select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;
 select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
 ctx:=erp_fiscal_authorization.context(a);
 if a.state<>'review_required' or a.used_at is null or a.finished_at is null or a.finalize_hash is null
  or i.consumed_attempt_id is distinct from a.id or ctx->>'origin'is distinct from'operational'
  or r.attempt_id is null or r.evidence->>'outcome'is distinct from'invalid_response'
  or r.evidence->>'rejection_code'is distinct from'SOAP_INVALID' or r.processed_hash is not null or r.processed_size is not null
  or b.attempt_id is null or o.attempt_id is null or o.origin<>'operational'
  or ctx->>'request_hash'is null or o.request_hash is distinct from ctx->>'request_hash'
  or o.response_hash is distinct from r.response_hash or o.review_hash is distinct from b.proof->>'review_hash'
  or r.evidence->'tls_origin_verified'is distinct from'true'::jsonb
  or r.evidence->>'transport_hash'is distinct from o.sha256 or r.evidence->'transport_size'is distinct from to_jsonb(o.size_bytes)
  or not exists(select 1 from erp_fiscal_authorization.audit where attempt_id=a.id and action='consume')
 then raise exception'revalidation_source_ineligible'using errcode='55000';end if;
 perform erp_fiscal_reviewed_authorization.check_review(a,b.proof,false);
 v:=erp_fiscal_authorization.view(a);
 return jsonb_build_object('receipt',v->'receipt','recovery',ctx,'artifact',v->'artifact',
  'rule_review',b.proof,'observation',jsonb_build_object('sha256',o.sha256,'size_bytes',o.size_bytes));
end$$;

create function erp_fiscal_authorization_revalidation.view(c erp_fiscal_authorization_revalidation.command)
returns jsonb language sql stable set search_path=pg_catalog as $$select
 erp_fiscal_authorization_revalidation.flags()||jsonb_build_object('command_id',c.id,'receipt',c.receipt,'source',c.source)$$;

create function erp_fiscal_authorization_revalidation.processed_check(attempt uuid,manifest_hash text,tag text,size integer)
returns void language plpgsql set search_path=pg_catalog as $$begin
 if manifest_hash is null or manifest_hash!~'^[a-f0-9]{64}$'or tag is null or tag!~'^[a-f0-9]{64}$'or size is null or size not between 1 and 512000
 then raise exception'revalidation_processed_invalid'using errcode='22023';end if;
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception'revalidation_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.buckets where id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and public=false
  and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception'revalidation_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'
  and name='revalidations/'||attempt::text||'/'||manifest_hash||'/processed/'||tag||'.xml'
  and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception'revalidation_processed_missing'using errcode='40001';end if;
end$$;

create function public.erp_fiscal_reviewed_authorization_revalidation_context(p_user_id uuid,p_authorization_command_id uuid,p_expected_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;c erp_fiscal_authorization_revalidation.command;begin
 s:=erp_fiscal_authorization_revalidation.source(p_user_id,p_authorization_command_id,p_expected_attempt_id);
 select *into c from erp_fiscal_authorization_revalidation.command where attempt_id=p_expected_attempt_id and parser_profile=erp_fiscal_authorization_revalidation.profile();
 if c.id is not null and(c.actor<>p_user_id or c.source is distinct from s or c.source_hash is distinct from erp_fiscal_wsdl.hash(s))then raise exception'revalidation_source_conflict'using errcode='40001';end if;
 return erp_fiscal_authorization_revalidation.flags()||jsonb_build_object('read_only',true,'authorization_command_id',p_authorization_command_id,'attempt_id',p_expected_attempt_id,
  'source',s,'source_hash',erp_fiscal_wsdl.hash(s),'parser_profile',erp_fiscal_authorization_revalidation.profile(),'parser_manifest_hash',erp_fiscal_authorization_revalidation.manifest(),
  'can_revalidate',c.id is null,'existing',case when c.id is null then null else erp_fiscal_authorization_revalidation.view(c)||jsonb_build_object('read_only',true,'replayed',true)end);
end$$;

create function public.erp_fiscal_reviewed_authorization_revalidation_finish(
 p_user_id uuid,p_command_id uuid,p_authorization_command_id uuid,p_expected_attempt_id uuid,p_expected_source_hash text,
 p_parser_profile text,p_parser_manifest_hash text,p_evidence jsonb,p_processed_hash text,p_processed_size integer,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s jsonb;tag text;c erp_fiscal_authorization_revalidation.command;a erp_fiscal_authorization.attempt;state text;at timestamptz;
begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null or p_authorization_command_id is null or p_expected_attempt_id is null or p_command_id=p_authorization_command_id
  or p_expected_source_hash is null or p_expected_source_hash!~'^[a-f0-9]{64}$'or p_confirmed is distinct from true
  or p_parser_profile is distinct from erp_fiscal_authorization_revalidation.profile()
  or p_parser_manifest_hash is distinct from erp_fiscal_authorization_revalidation.manifest()
  or jsonb_typeof(p_evidence)is distinct from'object' or octet_length(p_evidence::text)>16384
  or(p_processed_hash is null)<>(p_processed_size is null)
  or(p_processed_hash is not null and(p_processed_hash!~'^[a-f0-9]{64}$'or p_processed_size not between 1 and 512000))
 then raise exception'revalidation_input_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',p_user_id,'authorization_command_id',p_authorization_command_id,'attempt_id',p_expected_attempt_id,
  'source_hash',p_expected_source_hash,'parser_profile',p_parser_profile,'parser_manifest_hash',p_parser_manifest_hash,
  'evidence',p_evidence,'processed_hash',p_processed_hash,'processed_size',p_processed_size,'confirmed',true));
 perform pg_advisory_xact_lock(174852979,hashtext(p_command_id::text));
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal')for share;
 if not found then raise exception'authorization_forbidden'using errcode='42501';end if;
 s:=erp_fiscal_authorization_revalidation.source(p_user_id,p_authorization_command_id,p_expected_attempt_id);
 if erp_fiscal_wsdl.hash(s)is distinct from p_expected_source_hash then raise exception'revalidation_source_conflict'using errcode='40001';end if;
 select *into c from erp_fiscal_authorization_revalidation.command where id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>tag or c.source is distinct from s then raise exception'revalidation_command_conflict'using errcode='40001';end if;
  return erp_fiscal_authorization_revalidation.view(c)||jsonb_build_object('read_only',false,'replayed',true);
 end if;
 if exists(select 1 from erp_fiscal_authorization_revalidation.command where attempt_id=p_expected_attempt_id and parser_profile=p_parser_profile)
 then raise exception'revalidation_already_recorded'using errcode='40001';end if;
 select *into a from erp_fiscal_authorization.attempt where id=p_expected_attempt_id;
 if p_evidence->>'outcome'is null or p_evidence->>'outcome'not in('authorization_declared','receipt_pending','rejected','review_required')
  or p_evidence->>'transport_hash'is distinct from s->'observation'->>'sha256'
  or p_evidence->'transport_size'is distinct from s->'observation'->'size_bytes'
 then raise exception'revalidation_evidence_invalid'using errcode='22023';end if;
 state:=erp_fiscal_authorization.result_state(a,p_evidence,s->'artifact'->>'response_hash',p_processed_hash);
 -- Same immutable original objects, independently re-read by the executor.
 perform erp_fiscal_authorization.storage_check(a.id,'requests',s->'recovery'->>'request_hash',(s->'recovery'->>'request_size')::integer);
 perform erp_fiscal_authorization.storage_check(a.id,'responses',s->'recovery'->>'request_hash',(s->'artifact'->>'response_size')::integer);
 perform erp_fiscal_authorization.storage_check(a.id,'observations',s->'recovery'->>'request_hash',(s->'observation'->>'size_bytes')::integer);
 if p_processed_hash is not null then perform erp_fiscal_authorization_revalidation.processed_check(a.id,p_parser_manifest_hash,p_processed_hash,p_processed_size);end if;
 -- Membership lock covers revocation; recheck identity/source after Storage waits.
 perform erp_a1.access(p_user_id);
 if erp_fiscal_authorization_revalidation.source(p_user_id,p_authorization_command_id,p_expected_attempt_id)is distinct from s then raise exception'revalidation_source_conflict'using errcode='40001';end if;
 at:=clock_timestamp();
 insert into erp_fiscal_authorization_revalidation.command(id,actor,request_hash,attempt_id,parser_profile,parser_manifest_hash,source_hash,source,receipt,created_at)
 values(p_command_id,p_user_id,tag,a.id,p_parser_profile,p_parser_manifest_hash,p_expected_source_hash,s,jsonb_build_object(
  'command_id',p_command_id,'authorization_command_id',a.command_id,'attempt_id',a.id,'candidate_id',a.candidate_id,'candidate_version',s->'receipt'->'candidate_version',
  'signed_hash',a.signed_hash,'model',a.model,'origin','operational','source_hash',p_expected_source_hash,'parser_profile',p_parser_profile,'parser_manifest_hash',p_parser_manifest_hash,
  'original_state','review_required','state',state,'evidence',p_evidence,'processed_hash',p_processed_hash,'processed_size',p_processed_size,'created_at',at,'tax_rules_validated',false),at)returning *into c;
 return erp_fiscal_authorization_revalidation.view(c)||jsonb_build_object('read_only',false,'replayed',false);
end$$;

create function public.erp_fiscal_reviewed_authorization_revalidation_command(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_fiscal_authorization_revalidation.command;s jsonb;begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null then raise exception'revalidation_input_invalid'using errcode='22023';end if;
 select *into c from erp_fiscal_authorization_revalidation.command where id=p_command_id;
 if not found then raise exception'authorization_not_found'using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception'authorization_forbidden'using errcode='42501';end if;
 s:=erp_fiscal_authorization_revalidation.source(p_user_id,(c.receipt->>'authorization_command_id')::uuid,c.attempt_id);
 if c.source is distinct from s or c.source_hash is distinct from erp_fiscal_wsdl.hash(s)then raise exception'revalidation_source_conflict'using errcode='40001';end if;
 return erp_fiscal_authorization_revalidation.view(c)||jsonb_build_object('read_only',true,'replayed',true);
end$$;
revoke all on all functions in schema erp_fiscal_authorization_revalidation from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_reviewed_authorization_revalidation_context(uuid,uuid,uuid),
 public.erp_fiscal_reviewed_authorization_revalidation_finish(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,integer,boolean),
 public.erp_fiscal_reviewed_authorization_revalidation_command(uuid,uuid)from public,anon,authenticated,service_role;
grant execute on function public.erp_fiscal_reviewed_authorization_revalidation_context(uuid,uuid,uuid),
 public.erp_fiscal_reviewed_authorization_revalidation_finish(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,integer,boolean),
 public.erp_fiscal_reviewed_authorization_revalidation_command(uuid,uuid)to service_role;
commit;
