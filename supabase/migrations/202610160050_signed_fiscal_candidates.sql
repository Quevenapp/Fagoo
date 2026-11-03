-- Offline signed candidates only. SQL records trusted executor evidence; it never signs or validates XML.
begin;
create schema erp_fiscal_signed;
revoke all on schema erp_fiscal_signed from public,anon,authenticated,service_role;
create table erp_fiscal_signed.candidate(
 id uuid primary key,unsigned_job_id uuid not null references erp_fiscal_unsigned.job(id),version integer not null check(version>0),
 profile text not null check(profile='signed-homologation-sp-v1'),unsigned_hash text not null check(unsigned_hash~'^[a-f0-9]{64}$'),
 unsigned_size integer not null check(unsigned_size between 1 and 480000),basis_hash text not null check(basis_hash~'^[a-f0-9]{64}$'),
 a1_version integer not null check(a1_version>0),credential_id uuid not null references erp_a1.credential(id),
 envelope_hash text not null references erp_a1.sealed_object(hash),certificate_fingerprint text not null check(certificate_fingerprint~'^[a-f0-9]{64}$'),
 state text not null check(state in('pending','stored','failed')),attempt_count integer not null check(attempt_count between 1 and 100),
 lease_id uuid not null,lease_until timestamptz not null,created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 check((state='pending')=(finished_at is null)),unique(unsigned_job_id,version),unique(unsigned_job_id,a1_version,profile));
create table erp_fiscal_signed.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 candidate_id uuid not null references erp_fiscal_signed.candidate(id),receipt jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_signed.attempt(
 id uuid primary key,candidate_id uuid not null references erp_fiscal_signed.candidate(id),ordinal integer not null check(ordinal between 1 and 100),
 command_id uuid not null references erp_fiscal_signed.command(command_id),actor uuid not null references auth.users(id),
 state text not null check(state in('pending','stored','failed','expired')),lease_until timestamptz not null,
 started_at timestamptz not null default clock_timestamp(),used_at timestamptz,finished_at timestamptz,error_code text,finalize_hash text,
 check((state='pending')=(finished_at is null)),unique(candidate_id,ordinal));
create table erp_fiscal_signed.artifact(
 candidate_id uuid primary key references erp_fiscal_signed.candidate(id),attempt_id uuid not null unique references erp_fiscal_signed.attempt(id),
 signed_hash text not null check(signed_hash~'^[a-f0-9]{64}$'),size_bytes integer not null check(size_bytes between 1 and 512000),
 evidence jsonb not null,created_at timestamptz not null default clock_timestamp());
alter table erp_fiscal_signed.candidate enable row level security;
alter table erp_fiscal_signed.command enable row level security;
alter table erp_fiscal_signed.attempt enable row level security;
alter table erp_fiscal_signed.artifact enable row level security;
revoke all on all tables in schema erp_fiscal_signed from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_signed revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_signed revoke all on functions from public,anon,authenticated,service_role;

create function erp_fiscal_signed.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'signed_history_immutable'using errcode='42501';end$$;
create trigger immutable_command before update or delete on erp_fiscal_signed.command for each row execute function erp_fiscal_signed.immutable();
create trigger immutable_artifact before update or delete on erp_fiscal_signed.artifact for each row execute function erp_fiscal_signed.immutable();
create function erp_fiscal_signed.guard_candidate()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE'or old.state<>'pending'or(to_jsonb(new)-array['state','attempt_count','lease_id','lease_until','finished_at'])
  is distinct from(to_jsonb(old)-array['state','attempt_count','lease_id','lease_until','finished_at'])then raise exception 'signed_candidate_immutable'using errcode='42501';end if;
 if new.state='pending'then
  if old.attempt_count=100 or new.attempt_count<>old.attempt_count+1 or new.lease_id=old.lease_id or new.lease_until<=old.lease_until or old.lease_until>clock_timestamp()then raise exception 'signed_lease_conflict'using errcode='40001';end if;
 elsif new.state not in('stored','failed')or new.attempt_count<>old.attempt_count or new.lease_id<>old.lease_id or new.lease_until<>old.lease_until then raise exception 'signed_candidate_conflict'using errcode='40001';end if;
 return new;end$$;
create trigger guard_candidate before update or delete on erp_fiscal_signed.candidate for each row execute function erp_fiscal_signed.guard_candidate();
create function erp_fiscal_signed.guard_attempt()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE'or old.state<>'pending'or(to_jsonb(new)-array['state','used_at','finished_at','error_code','finalize_hash'])
  is distinct from(to_jsonb(old)-array['state','used_at','finished_at','error_code','finalize_hash'])then raise exception 'signed_attempt_immutable'using errcode='42501';end if;
 if new.state='pending'then
  if old.used_at is not null or new.used_at is null or new.finished_at is not null or new.error_code is not null or new.finalize_hash is not null then raise exception 'signed_use_conflict'using errcode='40001';end if;
 elsif new.state not in('stored','failed','expired')or new.used_at is distinct from old.used_at then raise exception 'signed_attempt_conflict'using errcode='40001';end if;
 return new;end$$;
create trigger guard_attempt before update or delete on erp_fiscal_signed.attempt for each row execute function erp_fiscal_signed.guard_attempt();

-- This manifest identifies approved algorithms/profiles, not hashes of implementation modules.
create function erp_fiscal_signed.profile()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'candidate_profile','signed-homologation-sp-v1','signature_profile','nfe400-rsa-sha1-c14n-v1','schema_profile','pl010f-v1.04',
 'schema_manifest_hash','6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',
 'validator_version','fiscal-schema-runner-v1','validator_hash','1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6',
 'nfce_qr_profile','sp-homologation-online-qr-v3')$$;
create function erp_fiscal_signed.flags(stored boolean)returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'data_mode','fiscal_signed_candidate','environment','2','purpose','offline-homologation','candidate_profile','signed-homologation-sp-v1',
 'signed',stored,'signature_verified',stored,'xsd_validated',stored,'tax_rules_validated',false,'icp_brasil_chain_validated',false,
 'revocation_checked',false,'authorized',false,'can_emit',false,'can_transmit',false,'financial_mutation_performed',false,'stock_mutation_performed',false)$$;
create function erp_fiscal_signed.require_source(actor uuid,source_id uuid)returns erp_fiscal_unsigned.job language plpgsql stable set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;begin
 perform erp_fiscal_numbering.access(actor);select *into j from erp_fiscal_unsigned.job where id=source_id;
 if not found then raise exception 'signed_source_not_found'using errcode='P0002';end if;
 perform erp_fiscal_unsigned.require_issuer(actor,j.reservation_id);return j;end$$;
create function erp_fiscal_signed.lock_source(actor uuid,source_id uuid)returns erp_fiscal_unsigned.job language plpgsql set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;r erp_fiscal_numbering.reservation;begin
 j:=erp_fiscal_signed.require_source(actor,source_id);select *into r from erp_fiscal_numbering.reservation where id=j.reservation_id;
 perform erp_fiscal_unsigned.lock_basis(r);j:=erp_fiscal_signed.require_source(actor,source_id);
 perform 1 from erp_access.membership where user_id=actor and active and role in('admin','fiscal')for share;
 if not found then raise exception 'signed_access_denied'using errcode='42501';end if;return j;end$$;
create function erp_fiscal_signed.check_source(j erp_fiscal_unsigned.job,h text,bh text)returns erp_fiscal_unsigned.artifact language plpgsql stable set search_path=pg_catalog as $$
declare a erp_fiscal_unsigned.artifact;b jsonb;r erp_fiscal_numbering.reservation;c jsonb;begin
 select *into a from erp_fiscal_unsigned.artifact where job_id=j.id;
 if j.state<>'stored'or a.job_id is null or a.xml_hash is distinct from h or j.basis_hash is distinct from bh then raise exception 'signed_source_conflict'using errcode='40001';end if;
 b:=erp_fiscal_unsigned.basis(j.draft_id,j.completion_version,j.completion_hash);
 select *into r from erp_fiscal_numbering.reservation where id=j.reservation_id;perform erp_fiscal_unsigned.check_reservation(r,b);
 c:=erp_fiscal_unsigned.current(j);
 if b->>'basis_hash'is distinct from bh or c->'artifact_current'is distinct from'true'::jsonb or c->'series_enabled'is distinct from'true'::jsonb then raise exception 'signed_source_conflict'using errcode='40001';end if;
 return a;end$$;
create function erp_fiscal_signed.check_a1(h erp_a1.head,j erp_fiscal_unsigned.job,expected integer)returns erp_a1.credential language plpgsql stable set search_path=pg_catalog as $$
declare c erp_a1.credential;r erp_fiscal_numbering.reservation;begin
 select *into c from erp_a1.credential where id=h.credential_id;select *into r from erp_fiscal_numbering.reservation where id=j.reservation_id;
 if h.version is distinct from expected or h.credential_id is null or c.id is null or c.context->>'environment'is distinct from'2'
  or c.context->>'purpose'is distinct from'offline-homologation'or c.context->>'holder_cnpj'is distinct from r.issuer_cnpj
  or(c.context->>'company_identity_version')::integer is distinct from r.company_identity_version
  or not(clock_timestamp()between(c.metadata->>'not_before')::timestamptz and(c.metadata->>'not_after')::timestamptz)then raise exception 'signed_credential_conflict'using errcode='40001';end if;
 return c;end$$;
create function erp_fiscal_signed.receipt(c erp_fiscal_signed.candidate)returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object(
 'candidate_id',c.id,'version',c.version,'unsigned_job_id',j.id,'reservation_id',j.reservation_id,'draft_id',j.draft_id,'model',r.model,
 'unsigned_hash',c.unsigned_hash,'unsigned_size',c.unsigned_size,'basis_hash',c.basis_hash,'completion_version',j.completion_version,
 'completion_hash',j.completion_hash,'a1_version',c.a1_version,'credential_id',c.credential_id,'certificate_fingerprint',c.certificate_fingerprint,
 'profile',erp_fiscal_signed.profile(),'created_at',c.created_at)
 from erp_fiscal_unsigned.job j join erp_fiscal_numbering.reservation r on r.id=j.reservation_id where j.id=c.unsigned_job_id$$;
create function erp_fiscal_signed.current(c erp_fiscal_signed.candidate)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;u jsonb;h erp_a1.head;meta jsonb;latest uuid;latest_version integer;matches boolean;time_valid boolean;begin
 select *into j from erp_fiscal_unsigned.job where id=c.unsigned_job_id;u:=erp_fiscal_unsigned.current(j);
 select *into h from erp_a1.head where singleton;select metadata into meta from erp_a1.credential where id=c.credential_id;
 matches:=h.version=c.a1_version and h.credential_id is not distinct from c.credential_id and h.object_hash is not distinct from c.envelope_hash;
 time_valid:=clock_timestamp()between(meta->>'not_before')::timestamptz and(meta->>'not_after')::timestamptz;
 select id,version into latest,latest_version from erp_fiscal_signed.candidate where unsigned_job_id=c.unsigned_job_id order by version desc limit 1;
 return jsonb_build_object('state',c.state,'attempt_count',c.attempt_count,'lease_until',case when c.state='pending'then c.lease_until else null end,
 'unsigned_artifact_current',u->'artifact_current','basis_changed',u->'basis_changed','draft_archived',u->'draft_archived','source_cancelled',u->'source_cancelled',
 'series_enabled',u->'series_enabled','a1_version',h.version,'a1_changed',not matches,'certificate_time_valid_now',time_valid,
 'latest_candidate_id',latest,'latest_candidate_version',latest_version,'is_latest_candidate',latest=c.id,
 'artifact_current',c.state='stored'and latest=c.id and matches and time_valid and u->'artifact_current'='true'::jsonb and u->'series_enabled'='true'::jsonb);
end$$;
create function erp_fiscal_signed.view(c erp_fiscal_signed.candidate)returns jsonb language sql stable set search_path=pg_catalog as $$select
 erp_fiscal_signed.flags(c.state='stored')||jsonb_build_object('receipt',erp_fiscal_signed.receipt(c),'current',erp_fiscal_signed.current(c),
 'error_code',(select error_code from erp_fiscal_signed.attempt where id=c.lease_id and state='failed'),
 'artifact',(select jsonb_build_object('signed_hash',a.signed_hash,'size_bytes',a.size_bytes,'evidence',a.evidence,'created_at',a.created_at)
 from erp_fiscal_signed.artifact a where a.candidate_id=c.id))$$;

create function public.erp_fiscal_signed_begin(p_user_id uuid,p_command_id uuid,p_unsigned_job_id uuid,p_unsigned_hash text,p_basis_hash text,p_expected_a1_version integer)returns jsonb
 language plpgsql security definer set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;a erp_fiscal_unsigned.artifact;c erp_fiscal_signed.candidate;cmd erp_fiscal_signed.command;
 h erp_a1.head;credential erp_a1.credential;request_hash text;at timestamptz;lease uuid;v integer;replay boolean:=false;claimed boolean:=false;begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_command_id is null or p_unsigned_job_id is null or p_unsigned_hash is null or p_unsigned_hash!~'^[a-f0-9]{64}$'
  or p_basis_hash is null or p_basis_hash!~'^[a-f0-9]{64}$'or p_expected_a1_version is null or p_expected_a1_version<1 then raise exception 'signed_begin_invalid'using errcode='22023';end if;
 request_hash:=erp_fiscal_unsigned.hash(jsonb_build_object('actor',p_user_id,'unsigned_job_id',p_unsigned_job_id,'unsigned_hash',p_unsigned_hash,
  'basis_hash',p_basis_hash,'a1_version',p_expected_a1_version,'profile',erp_fiscal_signed.profile()));
 perform pg_advisory_xact_lock(174852950,hashtext(p_command_id::text));
 j:=erp_fiscal_signed.lock_source(p_user_id,p_unsigned_job_id);
 select *into cmd from erp_fiscal_signed.command where command_id=p_command_id;
 if found then
  if cmd.actor<>p_user_id or cmd.request_hash<>request_hash then raise exception 'signed_command_conflict'using errcode='40001';end if;
  replay:=true;select *into c from erp_fiscal_signed.candidate where id=cmd.candidate_id;
  if c.state<>'pending'then return erp_fiscal_signed.view(c)||jsonb_build_object('command_id',p_command_id,'replayed',true,'execution',null);end if;
 end if;
 select *into h from erp_a1.head where singleton for share;
 a:=erp_fiscal_signed.check_source(j,p_unsigned_hash,p_basis_hash);credential:=erp_fiscal_signed.check_a1(h,j,p_expected_a1_version);
 select *into c from erp_fiscal_signed.candidate where unsigned_job_id=j.id and a1_version=p_expected_a1_version and profile='signed-homologation-sp-v1'for update;
 if c.id is not null and(c.unsigned_hash<>p_unsigned_hash or c.basis_hash<>p_basis_hash or c.credential_id<>h.credential_id or c.envelope_hash<>h.object_hash
  or c.certificate_fingerprint<>credential.metadata->>'fingerprint_sha256')then raise exception 'signed_intent_conflict'using errcode='40001';end if;
 at:=clock_timestamp();
 if c.id is null or(c.state='pending'and c.lease_until<=at)then
  lease:=gen_random_uuid();
  if c.id is null then
   select coalesce(max(version),0)into v from erp_fiscal_signed.candidate where unsigned_job_id=j.id;
   if v=2147483647 then raise exception 'signed_version_exhausted'using errcode='40001';end if;
   insert into erp_fiscal_signed.candidate(id,unsigned_job_id,version,profile,unsigned_hash,unsigned_size,basis_hash,a1_version,credential_id,envelope_hash,certificate_fingerprint,state,attempt_count,lease_id,lease_until,created_at)
    values(gen_random_uuid(),j.id,v+1,'signed-homologation-sp-v1',p_unsigned_hash,a.size_bytes,p_basis_hash,h.version,h.credential_id,h.object_hash,credential.metadata->>'fingerprint_sha256','pending',1,lease,at+interval'60 seconds',at)returning *into c;
  else
   if c.attempt_count=100 then raise exception 'signed_attempt_limit'using errcode='40001';end if;
   update erp_fiscal_signed.attempt set state='expired',finished_at=at where id=c.lease_id and state='pending';
   update erp_fiscal_signed.candidate set attempt_count=attempt_count+1,lease_id=lease,lease_until=at+interval'60 seconds'where id=c.id returning *into c;
  end if;claimed:=true;
 end if;
 if not replay then insert into erp_fiscal_signed.command(command_id,actor,request_hash,candidate_id,receipt)values(p_command_id,p_user_id,request_hash,c.id,erp_fiscal_signed.receipt(c))returning *into cmd;end if;
 if claimed then insert into erp_fiscal_signed.attempt(id,candidate_id,ordinal,command_id,actor,state,lease_until,started_at)values(c.lease_id,c.id,c.attempt_count,p_command_id,p_user_id,'pending',c.lease_until,at);end if;
 if claimed and c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 return erp_fiscal_signed.view(c)||jsonb_build_object('command_id',p_command_id,'replayed',replay,'execution',case when claimed then
  jsonb_build_object('private_executor_only',true,'lease_id',c.lease_id,'lease_until',c.lease_until)else null end);end$$;

create function erp_fiscal_signed.check_candidate(c erp_fiscal_signed.candidate,j erp_fiscal_unsigned.job,h erp_a1.head)returns void language plpgsql stable set search_path=pg_catalog as $$
declare a erp_fiscal_unsigned.artifact;credential erp_a1.credential;begin
 a:=erp_fiscal_signed.check_source(j,c.unsigned_hash,c.basis_hash);credential:=erp_fiscal_signed.check_a1(h,j,c.a1_version);
 if a.size_bytes<>c.unsigned_size or c.credential_id<>h.credential_id or c.envelope_hash<>h.object_hash or c.certificate_fingerprint<>credential.metadata->>'fingerprint_sha256'then raise exception 'signed_candidate_binding_conflict'using errcode='40001';end if;
end$$;
create function public.erp_fiscal_signed_use(p_user_id uuid,p_candidate_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_fiscal_signed.candidate;a erp_fiscal_signed.attempt;j erp_fiscal_unsigned.job;h erp_a1.head;credential erp_a1.credential;o erp_a1.sealed_object;i erp_fiscal_unsigned.identity;begin
 perform erp_fiscal_numbering.access(p_user_id);if p_candidate_id is null or p_lease_id is null then raise exception 'signed_use_invalid'using errcode='22023';end if;
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;if not found then raise exception 'signed_candidate_not_found'using errcode='P0002';end if;
 j:=erp_fiscal_signed.lock_source(p_user_id,c.unsigned_job_id);select *into h from erp_a1.head where singleton for share;
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id for update;
 select *into a from erp_fiscal_signed.attempt where id=p_lease_id and candidate_id=c.id;
 if a.id is null or a.actor<>p_user_id then raise exception 'signed_attempt_forbidden'using errcode='42501';end if;
 if c.state<>'pending'or a.state<>'pending'or c.lease_id<>a.id or c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 perform erp_fiscal_signed.check_candidate(c,j,h);
 select *into credential from erp_a1.credential where id=c.credential_id;select *into o from erp_a1.sealed_object where hash=c.envelope_hash and credential_id=c.credential_id;
 perform erp_fiscal_unsigned.storage_check(j.id,c.unsigned_hash,c.unsigned_size);perform erp_a1.storage_check(c.credential_id,o.hash,o.size_bytes);
 select *into i from erp_fiscal_unsigned.identity where reservation_id=j.reservation_id;
 if a.used_at is null then update erp_fiscal_signed.attempt set used_at=clock_timestamp()where id=a.id returning *into a;end if;
 if c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 return erp_fiscal_signed.flags(false)||jsonb_build_object('private_executor_only',true,'receipt',erp_fiscal_signed.receipt(c),
  'lease_id',a.id,'lease_until',a.lease_until,'used_at',a.used_at,'identity',i.identity,'access_key',i.access_key,
  'unsigned_object',jsonb_build_object('bucket','brufap-fiscal-artifacts','path','jobs/'||j.id::text||'/'||c.unsigned_hash||'.xml','hash',c.unsigned_hash,'size',c.unsigned_size),
  'credential_context',credential.context,'credential_metadata',credential.metadata,
  'credential_object',jsonb_build_object('bucket','brufap-a1-vault','path','credentials/'||c.credential_id::text||'/'||o.hash||'.json','hash',o.hash,'size',o.size_bytes,'key_id',o.key_id));
end$$;

create function erp_fiscal_signed.validate_evidence(v jsonb,c erp_fiscal_signed.candidate,h text)returns void language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb:=v->'signature';x jsonb:=v->'xsd';q jsonb:=v->'qr';p jsonb:=erp_fiscal_signed.profile();rd bytea;begin
 if not erp_a1.exact(v,array['signature','xsd','qr'])or octet_length(v::text)>8192
  or not erp_a1.exact(s,array['xml_hash','certificate_fingerprint','signed_content_hash','reference_digest','profile'])
  or not erp_a1.exact(x,array['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash'])
  or not erp_a1.exact(q,array['profile','verified'])then raise exception 'signed_evidence_invalid'using errcode='22023';end if;
 if s->'xml_hash'is distinct from to_jsonb(h)or x->'xml_hash'is distinct from to_jsonb(h)
  or s->'certificate_fingerprint'is distinct from to_jsonb(c.certificate_fingerprint)or s->'profile'is distinct from p->'signature_profile'
  or jsonb_typeof(s->'signed_content_hash')is distinct from'string'or s->>'signed_content_hash'!~'^[a-f0-9]{64}$'
  or jsonb_typeof(s->'reference_digest')is distinct from'string'or s->>'reference_digest'!~'^[A-Za-z0-9+/]{27}=$'
  or x->'schema_profile'is distinct from p->'schema_profile'or x->'manifest_hash'is distinct from p->'schema_manifest_hash'
  or x->'validator_version'is distinct from p->'validator_version'or x->'validator_hash'is distinct from p->'validator_hash'then raise exception 'signed_evidence_invalid'using errcode='22023';end if;
 begin rd:=decode(s->>'reference_digest','base64');exception when others then raise exception 'signed_evidence_invalid'using errcode='22023';end;
 if octet_length(rd)<>20 or encode(rd,'base64')<>s->>'reference_digest'then raise exception 'signed_evidence_invalid'using errcode='22023';end if;
end$$;
create function erp_fiscal_signed.storage_check(p_id uuid,h text,size integer)returns void language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'signed_storage_invalid'using errcode='55000';end if;
 perform 1 from storage.buckets where id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and public=false and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception 'signed_storage_invalid'using errcode='55000';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'and name='candidates/'||p_id::text||'/'||h||'.xml'and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception 'signed_storage_object_missing'using errcode='40001';end if;end$$;
create function public.erp_fiscal_signed_finish(p_user_id uuid,p_candidate_id uuid,p_lease_id uuid,p_signed_hash text,p_size_bytes integer,p_evidence jsonb)returns jsonb
 language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_fiscal_signed.candidate;a erp_fiscal_signed.attempt;j erp_fiscal_unsigned.job;h erp_a1.head;model text;fh text;at timestamptz;begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_candidate_id is null or p_lease_id is null or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'or p_size_bytes is null or p_size_bytes not between 1 and 512000 then raise exception 'signed_finish_invalid'using errcode='22023';end if;
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;if not found then raise exception 'signed_candidate_not_found'using errcode='P0002';end if;
 j:=erp_fiscal_signed.lock_source(p_user_id,c.unsigned_job_id);select *into h from erp_a1.head where singleton for share;
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id for update;select *into a from erp_fiscal_signed.attempt where id=p_lease_id and candidate_id=c.id;
 if a.id is null or a.actor<>p_user_id then raise exception 'signed_attempt_forbidden'using errcode='42501';end if;
 perform erp_fiscal_signed.validate_evidence(p_evidence,c,p_signed_hash);
 select r.model into model from erp_fiscal_numbering.reservation r where r.id=j.reservation_id;
 if(model='55'and p_evidence->'qr'is distinct from'{"profile":null,"verified":false}'::jsonb)
  or(model='65'and p_evidence->'qr'is distinct from jsonb_build_object('profile','sp-homologation-online-qr-v3','verified',true))then raise exception 'signed_qr_evidence_invalid'using errcode='22023';end if;
 fh:=erp_fiscal_unsigned.hash(jsonb_build_object('lease',p_lease_id,'signed_hash',p_signed_hash,'size',p_size_bytes,'evidence',p_evidence));
 if a.state='stored'and c.state='stored'then if a.finalize_hash is distinct from fh then raise exception 'signed_finalize_conflict'using errcode='40001';end if;
  return erp_fiscal_signed.view(c)||jsonb_build_object('replayed',true);end if;
 if c.state<>'pending'or a.state<>'pending'or c.lease_id<>a.id or c.lease_until<=clock_timestamp()or a.used_at is null then raise exception 'signed_lease_lost'using errcode='40001';end if;
 perform erp_fiscal_signed.check_candidate(c,j,h);perform erp_fiscal_signed.storage_check(c.id,p_signed_hash,p_size_bytes);perform erp_fiscal_signed.check_a1(h,j,c.a1_version);at:=clock_timestamp();
 if c.lease_until<=at then raise exception 'signed_lease_lost'using errcode='40001';end if;
 insert into erp_fiscal_signed.artifact(candidate_id,attempt_id,signed_hash,size_bytes,evidence,created_at)values(c.id,a.id,p_signed_hash,p_size_bytes,p_evidence,at);
 update erp_fiscal_signed.attempt set state='stored',finished_at=at,finalize_hash=fh where id=a.id;
 update erp_fiscal_signed.candidate set state='stored',finished_at=at where id=c.id returning *into c;
 if c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 return erp_fiscal_signed.view(c)||jsonb_build_object('replayed',false);end$$;

create function public.erp_fiscal_signed_fail(p_user_id uuid,p_candidate_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_fiscal_signed.candidate;a erp_fiscal_signed.attempt;j erp_fiscal_unsigned.job;at timestamptz;begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_candidate_id is null or p_lease_id is null or p_error_code is null or p_error_code not in('XML_INPUT_INVALID','SIGNATURE_INVALID','XSD_INVALID','QR_INVALID','XML_SIZE_LIMIT','CERTIFICATE_INVALID')then raise exception 'signed_failure_invalid'using errcode='22023';end if;
 select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;if not found then raise exception 'signed_candidate_not_found'using errcode='P0002';end if;
 j:=erp_fiscal_signed.lock_source(p_user_id,c.unsigned_job_id);select *into c from erp_fiscal_signed.candidate where id=p_candidate_id for update;
 select *into a from erp_fiscal_signed.attempt where id=p_lease_id and candidate_id=c.id;
 if a.id is null or a.actor<>p_user_id then raise exception 'signed_attempt_forbidden'using errcode='42501';end if;
 if a.state='failed'and c.state='failed'then if a.error_code<>p_error_code then raise exception 'signed_failure_conflict'using errcode='40001';end if;
  return erp_fiscal_signed.view(c)||jsonb_build_object('replayed',true);end if;
 if c.state<>'pending'or a.state<>'pending'or c.lease_id<>a.id or c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 at:=clock_timestamp();update erp_fiscal_signed.attempt set state='failed',finished_at=at,error_code=p_error_code where id=a.id;
 update erp_fiscal_signed.candidate set state='failed',finished_at=at where id=c.id returning *into c;
 if c.lease_until<=clock_timestamp()then raise exception 'signed_lease_lost'using errcode='40001';end if;
 return erp_fiscal_signed.view(c)||jsonb_build_object('replayed',false);end$$;
create function public.erp_fiscal_signed_get(p_user_id uuid,p_candidate_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_fiscal_signed.candidate;begin
 perform erp_fiscal_numbering.access(p_user_id);select *into c from erp_fiscal_signed.candidate where id=p_candidate_id;
 if not found then raise exception 'signed_candidate_not_found'using errcode='P0002';end if;perform erp_fiscal_signed.require_source(p_user_id,c.unsigned_job_id);
 return erp_fiscal_signed.view(c)||jsonb_build_object('read_only',true);end$$;
create function public.erp_fiscal_signed_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_fiscal_signed.candidate;cmd erp_fiscal_signed.command;begin
 perform erp_fiscal_numbering.access(p_user_id);select *into cmd from erp_fiscal_signed.command where command_id=p_command_id;
 if not found then raise exception 'signed_command_not_found'using errcode='P0002';end if;
 if cmd.actor<>p_user_id then raise exception 'signed_command_forbidden'using errcode='42501';end if;
 select *into c from erp_fiscal_signed.candidate where id=cmd.candidate_id;perform erp_fiscal_signed.require_source(p_user_id,c.unsigned_job_id);
 return erp_fiscal_signed.view(c)||jsonb_build_object('command_id',cmd.command_id,'receipt',cmd.receipt,'read_only',true);end$$;
create function public.erp_fiscal_signed_history(p_user_id uuid,p_unsigned_job_id uuid,p_limit integer default 25,p_before integer default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin perform erp_fiscal_signed.require_source(p_user_id,p_unsigned_job_id);
 if p_limit is null or p_limit<1 or p_limit>25 or(p_before is not null and p_before<1)then raise exception 'signed_query_invalid'using errcode='22023';end if;
 select coalesce(jsonb_agg(erp_fiscal_signed.view(c)order by c.version desc),'[]')into items from(select *from erp_fiscal_signed.candidate where unsigned_job_id=p_unsigned_job_id and(p_before is null or version<p_before)order by version desc limit p_limit)c;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_signed.candidate where unsigned_job_id=p_unsigned_job_id and version<(items->-1#>>'{receipt,version}')::integer);
 return erp_fiscal_signed.flags(false)||jsonb_build_object('read_only',true,'unsigned_job_id',p_unsigned_job_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then(items->-1#>>'{receipt,version}')::integer else null end);end$$;

revoke all on all functions in schema erp_fiscal_signed from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_signed_begin(uuid,uuid,uuid,text,text,integer),public.erp_fiscal_signed_use(uuid,uuid,uuid),
 public.erp_fiscal_signed_finish(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_signed_fail(uuid,uuid,uuid,text),
 public.erp_fiscal_signed_get(uuid,uuid),public.erp_fiscal_signed_command(uuid,uuid),public.erp_fiscal_signed_history(uuid,uuid,integer,integer)from public,anon,authenticated;
grant execute on function public.erp_fiscal_signed_begin(uuid,uuid,uuid,text,text,integer),public.erp_fiscal_signed_use(uuid,uuid,uuid),
 public.erp_fiscal_signed_finish(uuid,uuid,uuid,text,integer,jsonb),public.erp_fiscal_signed_fail(uuid,uuid,uuid,text),
 public.erp_fiscal_signed_get(uuid,uuid),public.erp_fiscal_signed_command(uuid,uuid),public.erp_fiscal_signed_history(uuid,uuid,integer,integer)to service_role;
commit;
