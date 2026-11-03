-- One explicit authenticated GET of a fixed SP homologation WSDL. No SOAP/fiscal operation.
-- Storage bytes, TLS and structural inspection are checked by the trusted runtime, not by SQL.
begin;
create schema erp_fiscal_wsdl;
revoke all on schema erp_fiscal_wsdl from public,anon,authenticated,service_role;
create table erp_fiscal_wsdl.attempt(
 id uuid primary key,command_id uuid not null unique,actor uuid not null references auth.users(id),
 model text not null check(model in('55','65')),operation text not null check(operation in('protocol','status','authorization','receipt')),
 identity_version integer not null check(identity_version>0),issuer_cnpj text not null,
 a1_version integer not null check(a1_version>0),credential_id uuid not null references erp_a1.credential(id),
 envelope_hash text not null references erp_a1.sealed_object(hash),certificate_fingerprint text not null check(certificate_fingerprint~'^[a-f0-9]{64}$'),
 state text not null check(state in('prepared','dispatched','stored','failed','uncertain')),
 lease_id uuid not null unique,nonce uuid not null unique,expires_at timestamptz not null,
 created_at timestamptz not null,used_at timestamptz,finished_at timestamptz,error_code text,finalize_hash text,
 check((state in('prepared','dispatched'))=(finished_at is null)),check(state<>'prepared'or used_at is null));
create table erp_fiscal_wsdl.command(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 attempt_id uuid not null unique references erp_fiscal_wsdl.attempt(id),receipt jsonb not null,created_at timestamptz not null);
create table erp_fiscal_wsdl.artifact(
 attempt_id uuid primary key references erp_fiscal_wsdl.attempt(id),wsdl_hash text not null check(wsdl_hash~'^[a-f0-9]{64}$'),
 size_bytes integer not null check(size_bytes between 1 and 512000),evidence jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_wsdl.audit(
 id bigint generated always as identity primary key,attempt_id uuid not null references erp_fiscal_wsdl.attempt(id),
 actor uuid not null references auth.users(id),action text not null check(action in('prepare','consume','store','fail')),
 created_at timestamptz not null default clock_timestamp(),unique(attempt_id,action));
alter table erp_fiscal_wsdl.attempt enable row level security;
alter table erp_fiscal_wsdl.command enable row level security;
alter table erp_fiscal_wsdl.artifact enable row level security;
alter table erp_fiscal_wsdl.audit enable row level security;
revoke all on all tables in schema erp_fiscal_wsdl from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_wsdl from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_wsdl revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_wsdl revoke all on functions from public,anon,authenticated,service_role;
create policy erp_fiscal_wsdl_runtime_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'brufap-fiscal-artifacts')with check(bucket_id<>'brufap-fiscal-artifacts');

create function erp_fiscal_wsdl.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'wsdl_history_immutable'using errcode='42501';end$$;
create trigger immutable_command before update or delete on erp_fiscal_wsdl.command for each row execute function erp_fiscal_wsdl.immutable();
create trigger immutable_artifact before update or delete on erp_fiscal_wsdl.artifact for each row execute function erp_fiscal_wsdl.immutable();
create trigger immutable_audit before update or delete on erp_fiscal_wsdl.audit for each row execute function erp_fiscal_wsdl.immutable();
create function erp_fiscal_wsdl.guard_attempt()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE'or old.state not in('prepared','dispatched')or
  (to_jsonb(new)-array['state','used_at','finished_at','error_code','finalize_hash'])is distinct from
  (to_jsonb(old)-array['state','used_at','finished_at','error_code','finalize_hash'])then raise exception 'wsdl_attempt_immutable'using errcode='42501';end if;
 if new.state='dispatched'and old.state='prepared'then
  if new.used_at is null or new.used_at<old.created_at or new.used_at>=old.expires_at or new.finished_at is not null or new.error_code is not null or new.finalize_hash is not null then raise exception 'wsdl_use_conflict'using errcode='40001';end if;
 elsif(old.state='prepared'and new.state='failed')or(old.state='dispatched'and new.state in('stored','uncertain'))then
  if new.used_at is distinct from old.used_at or new.finished_at is null or new.finalize_hash is null or(new.state='stored')<>(new.error_code is null)then raise exception 'wsdl_finish_conflict'using errcode='40001';end if;
 else raise exception 'wsdl_attempt_transition'using errcode='40001';end if;return new;end$$;
create trigger guard_attempt before update or delete on erp_fiscal_wsdl.attempt for each row execute function erp_fiscal_wsdl.guard_attempt();

create function erp_fiscal_wsdl.hash(v jsonb)returns text language sql immutable set search_path=pg_catalog as $$select encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
create function erp_fiscal_wsdl.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'data_mode','fiscal_wsdl_evidence','profile','sp-homologation-wsdl-evidence-v1','purpose','sefaz-sp-wsdl-readonly-v1','environment','2',
 'binding_verified',false,'operation_authorized',false,'can_query',false,'can_emit',false,'can_transmit',false,'sefaz_authorized',false)$$;
create function erp_fiscal_wsdl.endpoint(model text,operation text)returns text language plpgsql immutable set search_path=pg_catalog as $$declare service text;begin
 if model is null or model not in('55','65')or operation is null or operation not in('protocol','status','authorization','receipt')then raise exception 'wsdl_scope_invalid'using errcode='22023';end if;
 service:=case operation when'protocol'then'NFeConsultaProtocolo4'when'status'then'NFeStatusServico4'when'authorization'then'NFeAutorizacao4'when'receipt'then'NFeRetAutorizacao4'end;
 return 'https://'||case model when'55'then'homologacao.nfe.fazenda.sp.gov.br'else'homologacao.nfce.fazenda.sp.gov.br'end||'/ws/'||case model when'55'then lower(service)else service end||'.asmx?WSDL';end$$;
create function erp_fiscal_wsdl.locks(actor uuid,command uuid)returns erp_a1.head language plpgsql set search_path=pg_catalog as $$declare h erp_a1.head;begin
 perform erp_a1.access(actor);perform pg_advisory_xact_lock(174852951,hashtext(command::text));
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_access.membership where user_id=actor and active and role in('admin','fiscal')for share;
 if not found then raise exception 'wsdl_forbidden'using errcode='42501';end if;
 select *into h from erp_a1.head where singleton for share;return h;end$$;
create function erp_fiscal_wsdl.check_a1(h erp_a1.head,identity_version integer,a1_version integer)returns erp_a1.credential language plpgsql set search_path=pg_catalog as $$
declare c erp_a1.credential;o erp_a1.sealed_object;co jsonb;begin
 co:=erp_a1.company();select *into c from erp_a1.credential where id=h.credential_id;
 select *into o from erp_a1.sealed_object where hash=h.object_hash and credential_id=h.credential_id;
 if h.version is distinct from a1_version or c.id is null or o.hash is null or co is null or co->'identity_version'is distinct from to_jsonb(identity_version)
  or c.context->'company_identity_version'is distinct from to_jsonb(identity_version)or c.context->'holder_cnpj'is distinct from co->'cnpj'
  or c.metadata->'holder_cnpj'is distinct from co->'cnpj'or c.context->>'environment'is distinct from'2'
  or c.context->>'purpose'is distinct from'offline-homologation'or c.metadata->'key_matches_certificate'is distinct from'true'::jsonb
  or not(clock_timestamp()between(c.metadata->>'not_before')::timestamptz and(c.metadata->>'not_after')::timestamptz)
 then raise exception 'wsdl_credential_conflict'using errcode='40001';end if;
 perform erp_a1.storage_check(c.id,o.hash,o.size_bytes);return c;end$$;
create function erp_fiscal_wsdl.check_attempt(a erp_fiscal_wsdl.attempt,h erp_a1.head)returns erp_a1.credential language plpgsql set search_path=pg_catalog as $$declare c erp_a1.credential;begin
 c:=erp_fiscal_wsdl.check_a1(h,a.identity_version,a.a1_version);
 if a.credential_id is distinct from h.credential_id or a.envelope_hash is distinct from h.object_hash or a.issuer_cnpj is distinct from c.context->>'holder_cnpj'
  or a.certificate_fingerprint is distinct from c.metadata->>'fingerprint_sha256'then raise exception 'wsdl_context_conflict'using errcode='40001';end if;return c;end$$;
create function erp_fiscal_wsdl.current(a erp_fiscal_wsdl.attempt)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare h erp_a1.head;co jsonb;m jsonb;begin
 select *into h from erp_a1.head where singleton;co:=erp_a1.company();select metadata into m from erp_a1.credential where id=a.credential_id;
 return jsonb_build_object('state',a.state,'a1_version',h.version,'identity_version',co->'identity_version',
 'a1_changed',h.version is distinct from a.a1_version or h.credential_id is distinct from a.credential_id or h.object_hash is distinct from a.envelope_hash,
 'company_changed',co is null or co->'identity_version'is distinct from to_jsonb(a.identity_version)or co->>'cnpj'is distinct from a.issuer_cnpj,
 'certificate_time_valid_now',coalesce(clock_timestamp()between(m->>'not_before')::timestamptz and(m->>'not_after')::timestamptz,false),
 'grant_consumed',a.used_at is not null,'lease_expired',a.expires_at<=clock_timestamp(),'expires_at',a.expires_at,'used_at',a.used_at,'finished_at',a.finished_at,
 'recovery_required',a.state in('dispatched','uncertain'),'retry_get_allowed',false);
end$$;
create function erp_fiscal_wsdl.view(a erp_fiscal_wsdl.attempt)returns jsonb language sql stable set search_path=pg_catalog as $$select erp_fiscal_wsdl.flags()||jsonb_build_object(
 'command_id',a.command_id,'receipt',(select receipt from erp_fiscal_wsdl.command where id=a.command_id),'current',erp_fiscal_wsdl.current(a),
 'error_code',coalesce(a.error_code,case when a.expires_at<=clock_timestamp()and a.state='prepared'then'WSDL_GRANT_EXPIRED'when a.expires_at<=clock_timestamp()and a.state='dispatched'then'WSDL_RESULT_UNCONFIRMED'end),
 'artifact',(select jsonb_build_object('wsdl_hash',wsdl_hash,'size_bytes',size_bytes,'evidence',evidence,'created_at',created_at)from erp_fiscal_wsdl.artifact where attempt_id=a.id))$$;
create function erp_fiscal_wsdl.scope(a erp_fiscal_wsdl.attempt)returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'attempt_id',a.id,'command_id',a.command_id,'actor',a.actor,'nonce',a.nonce,'expires_at',a.expires_at,
 'purpose','sefaz-sp-wsdl-readonly-v1','effective_profile','wsdl-mtls-client-v1','environment','2','model',a.model,'operation',a.operation,
 'method','GET','endpoint',erp_fiscal_wsdl.endpoint(a.model,a.operation),'identity_version',a.identity_version,'issuer_cnpj',a.issuer_cnpj,
 'a1_version',a.a1_version,'credential_id',a.credential_id,'envelope_hash',a.envelope_hash,'certificate_fingerprint',a.certificate_fingerprint)$$;
create function erp_fiscal_wsdl.execution(a erp_fiscal_wsdl.attempt,c erp_a1.credential)returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object(
 'private_executor_only',true,'lease_id',a.lease_id,'scope',erp_fiscal_wsdl.scope(a),
 'credential',jsonb_build_object('id',c.id,'context',c.context,'metadata',c.metadata,'object',jsonb_build_object(
 'bucket','brufap-a1-vault','key','credentials/'||c.id::text||'/'||o.hash||'.json','hash',o.hash,'size_bytes',o.size_bytes,'key_id',o.key_id)))
 from erp_a1.sealed_object o where o.hash=a.envelope_hash and o.credential_id=c.id$$;

create function public.erp_fiscal_wsdl_begin(p_user_id uuid,p_command_id uuid,p_model text,p_operation text,p_expected_a1_version integer,p_expected_identity_version integer,p_confirmed boolean)returns jsonb
 language plpgsql security definer set search_path=pg_catalog as $$declare h erp_a1.head;c erp_a1.credential;cmd erp_fiscal_wsdl.command;a erp_fiscal_wsdl.attempt;tag text;at timestamptz;begin
 perform erp_a1.access(p_user_id);perform erp_fiscal_wsdl.endpoint(p_model,p_operation);
 if p_command_id is null or p_expected_a1_version is null or p_expected_a1_version<1 or p_expected_identity_version is null or p_expected_identity_version<1 or p_confirmed is distinct from true then raise exception 'wsdl_begin_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',p_user_id,'model',p_model,'operation',p_operation,'a1_version',p_expected_a1_version,'identity_version',p_expected_identity_version,'confirmed',true,'profile','wsdl-mtls-client-v1'));
 h:=erp_fiscal_wsdl.locks(p_user_id,p_command_id);select *into cmd from erp_fiscal_wsdl.command where id=p_command_id;
 if found then
  if cmd.actor<>p_user_id or cmd.request_hash<>tag then raise exception 'wsdl_command_conflict'using errcode='40001';end if;
  select *into a from erp_fiscal_wsdl.attempt where id=cmd.attempt_id for update;
  if a.state<>'prepared'or a.expires_at<=clock_timestamp()then return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',true,'execution',null);end if;
  c:=erp_fiscal_wsdl.check_attempt(a,h);
  return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',true,'execution',erp_fiscal_wsdl.execution(a,c));
 end if;
 c:=erp_fiscal_wsdl.check_a1(h,p_expected_identity_version,p_expected_a1_version);at:=clock_timestamp();
 insert into erp_fiscal_wsdl.attempt(id,command_id,actor,model,operation,identity_version,issuer_cnpj,a1_version,credential_id,envelope_hash,certificate_fingerprint,state,lease_id,nonce,expires_at,created_at)
 values(gen_random_uuid(),p_command_id,p_user_id,p_model,p_operation,p_expected_identity_version,c.context->>'holder_cnpj',h.version,h.credential_id,h.object_hash,c.metadata->>'fingerprint_sha256','prepared',gen_random_uuid(),gen_random_uuid(),at+interval'60 seconds',at)returning *into a;
 insert into erp_fiscal_wsdl.command(id,actor,request_hash,attempt_id,receipt,created_at)values(p_command_id,p_user_id,tag,a.id,jsonb_build_object(
 'attempt_id',a.id,'command_id',p_command_id,'profile','sp-homologation-wsdl-evidence-v1','model',a.model,'operation',a.operation,'environment','2','a1_version',a.a1_version,'identity_version',a.identity_version,'confirmed',true,'created_at',at),at);
 insert into erp_fiscal_wsdl.audit(attempt_id,actor,action)values(a.id,p_user_id,'prepare');
 if a.expires_at<=clock_timestamp()then raise exception 'wsdl_grant_expired'using errcode='40001';end if;
 return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',false,'execution',erp_fiscal_wsdl.execution(a,c));end$$;

create function public.erp_fiscal_wsdl_use(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_wsdl.attempt;h erp_a1.head;begin
 perform erp_a1.access(p_user_id);if p_attempt_id is null or p_lease_id is null then raise exception 'wsdl_use_invalid'using errcode='22023';end if;
 select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id;if not found then raise exception 'wsdl_not_found'using errcode='P0002';end if;
 h:=erp_fiscal_wsdl.locks(p_user_id,a.command_id);select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id for update;
 if a.actor<>p_user_id then raise exception 'wsdl_forbidden'using errcode='42501';end if;
 if a.lease_id<>p_lease_id or a.state<>'prepared'or a.expires_at<=clock_timestamp()then raise exception 'wsdl_use_conflict'using errcode='40001';end if;
 perform erp_fiscal_wsdl.check_attempt(a,h);
 update erp_fiscal_wsdl.attempt set state='dispatched',used_at=clock_timestamp()where id=a.id returning *into a;
 insert into erp_fiscal_wsdl.audit(attempt_id,actor,action)values(a.id,p_user_id,'consume');
 if a.expires_at<=clock_timestamp()then raise exception 'wsdl_grant_expired'using errcode='40001';end if;
 return erp_fiscal_wsdl.flags()||jsonb_build_object('private_executor_only',true,'grant',erp_fiscal_wsdl.scope(a)||jsonb_build_object('issued_at',a.used_at));end$$;

create function erp_fiscal_wsdl.storage_check(a uuid,tag text,size integer)returns void language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'wsdl_private_object_required'using errcode='40001';end if;
 perform 1 from storage.buckets where id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and public=false and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception 'wsdl_private_object_required'using errcode='40001';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'and name='wsdl/'||a::text||'/'||tag||'.xml'and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception 'wsdl_private_object_required'using errcode='40001';end if;end$$;
create function erp_fiscal_wsdl.validate_evidence(e jsonb,a erp_fiscal_wsdl.attempt,tag text,size integer)returns void language plpgsql immutable set search_path=pg_catalog as $$
declare t jsonb;i jsonb;k text;begin
 if not erp_a1.exact(e,array['profile','request_id','model','operation','environment','wsdl_hash','size_bytes','received_at','tls','inspection','binding_verified'])or octet_length(e::text)>8192 then raise exception 'wsdl_evidence_invalid'using errcode='22023';end if;
 if e->>'profile'is distinct from'sp-homologation-wsdl-evidence-v1'or e->'request_id'is distinct from to_jsonb(a.id::text)or e->'model'is distinct from to_jsonb(a.model)
  or e->'operation'is distinct from to_jsonb(a.operation)or e->'environment'is distinct from'"2"'::jsonb or e->'wsdl_hash'is distinct from to_jsonb(tag)
  or e->'size_bytes'is distinct from to_jsonb(size)or not erp_a1.iso(e->'received_at')or e->'binding_verified'is distinct from'false'::jsonb then raise exception 'wsdl_evidence_invalid'using errcode='22023';end if;
 t:=e->'tls';i:=e->'inspection';
 if not erp_a1.exact(t,array['protocol','server_identity_verified','client_fingerprint','client_chain','client_profile','revocation'])
  or t->>'protocol'not in('TLSv1.2','TLSv1.3')or t->'protocol'='null'::jsonb or t->'server_identity_verified'is distinct from'true'::jsonb
  or t->'client_fingerprint'is distinct from to_jsonb(a.certificate_fingerprint)
  or t->>'client_chain'not in('verified_offline','not_evaluated')or t->'client_chain'='null'::jsonb
  or t->>'client_profile'not in('compatible','not_evaluated')or t->'client_profile'='null'::jsonb
  or t->>'revocation'not in('unknown_offline','not_revoked_in_supplied_crls')or t->'revocation'='null'::jsonb
 then raise exception 'wsdl_tls_evidence_invalid'using errcode='22023';end if;
 if not erp_a1.exact(i,array['inspection_status','code','validation','target_namespace','bindings_count','operations_count','addresses_count'])
  or i->>'validation'is distinct from'structural_evidence_only'or i->>'inspection_status'is null or i->>'inspection_status'not in('supported','unsupported')then raise exception 'wsdl_inspection_invalid'using errcode='22023';end if;
 if i->>'inspection_status'='supported'then
  if i->'code'is distinct from'null'::jsonb or jsonb_typeof(i->'target_namespace')is distinct from'string'or length(i->>'target_namespace')not between 1 and 2048 or i->>'target_namespace'!~'^https?://[!-~]+$'then raise exception 'wsdl_inspection_invalid'using errcode='22023';end if;
  foreach k in array array['bindings_count','operations_count','addresses_count']loop
   if jsonb_typeof(i->k)is distinct from'number'or(i->>k)::numeric not between 1 and (case k when'bindings_count'then 8 when'operations_count'then 128 else 32 end) or trunc((i->>k)::numeric)<>(i->>k)::numeric then raise exception 'wsdl_inspection_invalid'using errcode='22023';end if;
  end loop;
 else
  if i->>'code'not in('WSDL_ROOT_UNSUPPORTED','WSDL_EXTERNAL_DEPENDENCY_UNSUPPORTED','WSDL_STRUCTURE_AMBIGUOUS','WSDL_NAME_INVALID','WSDL_URI_INVALID','WSDL_QNAME_INVALID','WSDL_QNAME_NAMESPACE_INVALID','WSDL_DUPLICATE_NAME','WSDL_EXTENSION_UNSUPPORTED','WSDL_STRUCTURE_INVALID','WSDL_REFERENCE_MISSING','WSDL_BINDING_UNSUPPORTED','WSDL_HEADER_OR_EXTENSION_UNSUPPORTED','WSDL_ENDPOINT_MISMATCH','WSDL_UNBOUND_BINDING')or i->'code'='null'::jsonb then raise exception 'wsdl_inspection_invalid'using errcode='22023';end if;
  foreach k in array array['target_namespace','bindings_count','operations_count','addresses_count']loop if i->k is distinct from'null'::jsonb then raise exception 'wsdl_inspection_invalid'using errcode='22023';end if;end loop;
 end if;
end$$;

create function public.erp_fiscal_wsdl_finish(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_wsdl_hash text,p_size_bytes integer,p_evidence jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_wsdl.attempt;h erp_a1.head;tag text;received timestamptz;begin
 perform erp_a1.access(p_user_id);
 if p_attempt_id is null or p_lease_id is null or p_wsdl_hash is null or p_wsdl_hash!~'^[a-f0-9]{64}$'or p_size_bytes is null or p_size_bytes not between 1 and 512000 then raise exception 'wsdl_finish_invalid'using errcode='22023';end if;
 select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id;if not found then raise exception 'wsdl_not_found'using errcode='P0002';end if;
 h:=erp_fiscal_wsdl.locks(p_user_id,a.command_id);select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id for update;
 if a.actor<>p_user_id then raise exception 'wsdl_forbidden'using errcode='42501';end if;
 if a.lease_id<>p_lease_id then raise exception 'wsdl_lease_conflict'using errcode='40001';end if;
 perform erp_fiscal_wsdl.validate_evidence(p_evidence,a,p_wsdl_hash,p_size_bytes);
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('hash',p_wsdl_hash,'size',p_size_bytes,'evidence',p_evidence));
 if a.state='stored'and a.finalize_hash=tag then return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',true);end if;
 if a.state<>'dispatched'or a.used_at is null or a.expires_at<=clock_timestamp()then raise exception 'wsdl_finish_conflict'using errcode='40001';end if;
 perform erp_fiscal_wsdl.check_attempt(a,h);received:=(p_evidence->>'received_at')::timestamptz;
 if received<a.used_at-interval'1 millisecond'or received>a.expires_at or received>clock_timestamp()+interval'5 seconds'then raise exception 'wsdl_received_time_invalid'using errcode='22023';end if;
 perform erp_fiscal_wsdl.storage_check(a.id,p_wsdl_hash,p_size_bytes);
 insert into erp_fiscal_wsdl.artifact(attempt_id,wsdl_hash,size_bytes,evidence)values(a.id,p_wsdl_hash,p_size_bytes,p_evidence);
 update erp_fiscal_wsdl.attempt set state='stored',finished_at=clock_timestamp(),finalize_hash=tag where id=a.id returning *into a;
 insert into erp_fiscal_wsdl.audit(attempt_id,actor,action)values(a.id,p_user_id,'store');
 if a.expires_at<=clock_timestamp()then raise exception 'wsdl_grant_expired'using errcode='40001';end if;
 return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',false);end$$;

create function public.erp_fiscal_wsdl_fail(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_fiscal_wsdl.attempt;tag text;begin
 perform erp_a1.access(p_user_id);
 if p_attempt_id is null or p_lease_id is null or p_error_code is null or p_error_code not in('WSDL_CERTIFICATE_REJECTED','WSDL_AUTHORIZATION_REJECTED','WSDL_TLS_FAILED','WSDL_TIMEOUT','WSDL_ABORTED','WSDL_RESPONSE_REJECTED','WSDL_STORAGE_FAILED','WSDL_RUNTIME_FAILED')then raise exception 'wsdl_failure_invalid'using errcode='22023';end if;
 select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id;if not found then raise exception 'wsdl_not_found'using errcode='P0002';end if;
 perform erp_fiscal_wsdl.locks(p_user_id,a.command_id);select *into a from erp_fiscal_wsdl.attempt where id=p_attempt_id for update;
 if a.actor<>p_user_id then raise exception 'wsdl_forbidden'using errcode='42501';end if;
 if a.lease_id<>p_lease_id then raise exception 'wsdl_lease_conflict'using errcode='40001';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('error_code',p_error_code));
 if a.state in('failed','uncertain')and a.finalize_hash=tag then return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',true);end if;
 if a.state not in('prepared','dispatched')then raise exception 'wsdl_failure_conflict'using errcode='40001';end if;
 -- Closing a failed or unknown attempt remains possible after lease/identity expiry; it never grants another GET.
 update erp_fiscal_wsdl.attempt set state=case when used_at is null then'failed'else'uncertain'end,finished_at=clock_timestamp(),error_code=p_error_code,finalize_hash=tag where id=a.id returning *into a;
 insert into erp_fiscal_wsdl.audit(attempt_id,actor,action)values(a.id,p_user_id,'fail');
 return erp_fiscal_wsdl.view(a)||jsonb_build_object('replayed',false);end$$;
create function public.erp_fiscal_wsdl_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare cmd erp_fiscal_wsdl.command;a erp_fiscal_wsdl.attempt;begin
 perform erp_a1.access(p_user_id);if p_command_id is null then raise exception 'wsdl_command_invalid'using errcode='22023';end if;
 select *into cmd from erp_fiscal_wsdl.command where id=p_command_id;if not found then raise exception 'wsdl_not_found'using errcode='P0002';end if;
 if cmd.actor<>p_user_id then raise exception 'wsdl_forbidden'using errcode='42501';end if;
 select *into a from erp_fiscal_wsdl.attempt where id=cmd.attempt_id;return erp_fiscal_wsdl.view(a)||jsonb_build_object('read_only',true);end$$;

revoke all on all functions in schema erp_fiscal_wsdl from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_wsdl_begin(uuid,uuid,text,text,integer,integer,boolean),public.erp_fiscal_wsdl_use(uuid,uuid,uuid),public.erp_fiscal_wsdl_finish(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_wsdl_fail(uuid,uuid,uuid,text),public.erp_fiscal_wsdl_command(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_wsdl_begin(uuid,uuid,text,text,integer,integer,boolean),public.erp_fiscal_wsdl_use(uuid,uuid,uuid),public.erp_fiscal_wsdl_finish(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_wsdl_fail(uuid,uuid,uuid,text),public.erp_fiscal_wsdl_command(uuid,uuid)to service_role;
commit;
