-- Executor-only bookkeeping for unsigned XML. No allocator, HTTP, Storage I/O or signature.
begin;
create schema erp_fiscal_unsigned;
revoke all on schema erp_fiscal_unsigned from public,anon,authenticated,service_role;
create table erp_fiscal_unsigned.identity(
 reservation_id uuid primary key references erp_fiscal_numbering.reservation(id),
 identity jsonb not null,access_key text not null unique check(access_key~'^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$'),
 created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_unsigned.job(
 id uuid primary key,reservation_id uuid not null references erp_fiscal_unsigned.identity(reservation_id),
 version integer not null check(version>0),draft_id uuid not null,completion_version integer not null,
 completion_hash text not null check(completion_hash~'^[a-f0-9]{64}$'),basis_hash text not null check(basis_hash~'^[a-f0-9]{64}$'),
 builder_version text not null check(builder_version='brufap-business-builder-v1'),proofs jsonb not null,
 state text not null check(state in('pending','stored','failed')),attempt_count integer not null check(attempt_count between 1 and 100),
 lease_id uuid not null,lease_until timestamptz not null,created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 check((state='pending')=(finished_at is null)),unique(reservation_id,version),unique(reservation_id,completion_version,builder_version),
 foreign key(draft_id,completion_version)references erp_fiscal_completion.revision(draft_id,version));
create table erp_fiscal_unsigned.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 job_id uuid not null references erp_fiscal_unsigned.job(id),receipt jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_unsigned.attempt(
 id uuid primary key,job_id uuid not null references erp_fiscal_unsigned.job(id),ordinal integer not null check(ordinal between 1 and 100),
 command_id uuid not null references erp_fiscal_unsigned.command(command_id),actor uuid not null references auth.users(id),
 state text not null check(state in('pending','stored','failed','expired')),lease_until timestamptz not null,
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,error_code text,finalize_hash text,
 check((state='pending')=(finished_at is null)),unique(job_id,ordinal));
create table erp_fiscal_unsigned.artifact(
 job_id uuid primary key references erp_fiscal_unsigned.job(id),attempt_id uuid not null unique references erp_fiscal_unsigned.attempt(id),
 xml_hash text not null check(xml_hash~'^[a-f0-9]{64}$'),size_bytes integer not null check(size_bytes between 1 and 480000),
 access_key text not null,created_at timestamptz not null default clock_timestamp());
alter table erp_fiscal_unsigned.identity enable row level security;
alter table erp_fiscal_unsigned.job enable row level security;
alter table erp_fiscal_unsigned.command enable row level security;
alter table erp_fiscal_unsigned.attempt enable row level security;
alter table erp_fiscal_unsigned.artifact enable row level security;
revoke all on all tables in schema erp_fiscal_unsigned from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_unsigned revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_unsigned revoke all on functions from public,anon,authenticated,service_role;
do $$begin if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then
 raise exception 'unsigned_storage_rls_required'using errcode='55000';end if;end$$;
create policy fiscal_unsigned_proxy_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'brufap-fiscal-artifacts')with check(bucket_id<>'brufap-fiscal-artifacts');
create function erp_fiscal_unsigned.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'unsigned_history_immutable'using errcode='42501';end$$;
create trigger immutable_identity before update or delete on erp_fiscal_unsigned.identity for each row execute function erp_fiscal_unsigned.immutable();
create trigger immutable_command before update or delete on erp_fiscal_unsigned.command for each row execute function erp_fiscal_unsigned.immutable();
create trigger immutable_artifact before update or delete on erp_fiscal_unsigned.artifact for each row execute function erp_fiscal_unsigned.immutable();
create function erp_fiscal_unsigned.guard_job()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE'or old.state<>'pending'or(to_jsonb(new)-array['state','attempt_count','lease_id','lease_until','finished_at'])
  is distinct from(to_jsonb(old)-array['state','attempt_count','lease_id','lease_until','finished_at'])then raise exception 'unsigned_job_immutable'using errcode='42501';end if;
 if new.state='pending'then
  if old.attempt_count=100 or new.attempt_count<>old.attempt_count+1 or new.lease_id=old.lease_id or new.lease_until<=old.lease_until or old.lease_until>clock_timestamp()then raise exception 'unsigned_lease_conflict'using errcode='40001';end if;
 elsif new.state not in('stored','failed')or new.attempt_count<>old.attempt_count or new.lease_id<>old.lease_id or new.lease_until<>old.lease_until then raise exception 'unsigned_job_conflict'using errcode='40001';end if;
 return new;
end$$;
create trigger guard_job before update or delete on erp_fiscal_unsigned.job for each row execute function erp_fiscal_unsigned.guard_job();
create function erp_fiscal_unsigned.guard_attempt()returns trigger language plpgsql set search_path=pg_catalog as $$
begin if tg_op='DELETE'or old.state<>'pending'or new.state not in('stored','failed','expired')
 or(to_jsonb(new)-array['state','finished_at','error_code','finalize_hash'])is distinct from(to_jsonb(old)-array['state','finished_at','error_code','finalize_hash'])then
 raise exception 'unsigned_attempt_immutable'using errcode='42501';end if;return new;end$$;
create trigger guard_attempt before update or delete on erp_fiscal_unsigned.attempt for each row execute function erp_fiscal_unsigned.guard_attempt();
create function erp_fiscal_unsigned.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_unsigned_job','environment','2','profile','sn-sp-internal-business-v1','schema_profile','pl010f-v1.04',
 'unsigned',true,'arithmetic_verified',false,'tax_rules_validated',false,'xsd_validated',false,'signature_verified',false,'authorized',false,
 'can_emit',false,'can_transmit',false,'financial_mutation_performed',false,'stock_mutation_performed',false)
$$;
create function erp_fiscal_unsigned.hash(v jsonb)returns text language sql immutable set search_path=pg_catalog as $$select encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
create function erp_fiscal_unsigned.seed_valid(v jsonb)returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare t text;at timestamptz;begin
 if not erp_fiscal_completion.exact(v,array['cNF','issuedAt'])or jsonb_typeof(v->'cNF')is distinct from'string'or v->>'cNF'!~'^[0-9]{8}$'
  or jsonb_typeof(v->'issuedAt')is distinct from'string'then return false;end if;t:=v->>'issuedAt';
 if t!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}-03:00$'then return false;end if;
 begin at:=t::timestamptz;exception when others then return false;end;
 return to_char(at at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00'=t;
end$$;
create function erp_fiscal_unsigned.access_key(r erp_fiscal_numbering.reservation,seed jsonb)returns text language plpgsql immutable set search_path=pg_catalog as $$
declare b text;s integer:=0;w integer:=2;i integer;remainder integer;begin
 if not erp_fiscal_unsigned.seed_valid(seed)then raise exception 'unsigned_seed_invalid'using errcode='22023';end if;
 b:=r.cuf||substr(seed->>'issuedAt',3,2)||substr(seed->>'issuedAt',6,2)||r.issuer_cnpj||r.model||lpad(r.series::text,3,'0')||lpad(r.number::text,9,'0')||'1'||(seed->>'cNF');
 for i in reverse length(b)..1 loop s:=s+(ascii(substr(b,i,1))-48)*w;w:=case when w=9 then 2 else w+1 end;end loop;
 remainder:=s%11;return b||case when remainder<2 then'0'else(11-remainder)::text end;
end$$;
create function erp_fiscal_unsigned.require_issuer(actor uuid,p_reservation uuid)returns erp_fiscal_numbering.reservation language plpgsql stable set search_path=pg_catalog as $$
declare r erp_fiscal_numbering.reservation;begin
 perform erp_fiscal_numbering.access(actor);select *into r from erp_fiscal_numbering.reservation where id=p_reservation;
 if not found then raise exception 'unsigned_reservation_not_found'using errcode='P0002';end if;
 if r.issuer_cnpj is distinct from(select data->>'cnpj'from erp_company.identity where singleton)then raise exception 'unsigned_issuer_forbidden'using errcode='42501';end if;return r;
end$$;
create function erp_fiscal_unsigned.basis(id uuid,cv integer,ch text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare c jsonb;d jsonb;i jsonb;t jsonb;ctx jsonb;proofs jsonb;hashes jsonb;fingerprint text;result jsonb;begin
 if id is null or cv is null or cv<1 or(ch is not null and ch!~'^[a-f0-9]{64}$')then raise exception 'unsigned_basis_invalid'using errcode='22023';end if;
 select record into c from erp_fiscal_completion.revision where draft_id=id and version=cv;
 if c is null then raise exception 'unsigned_completion_not_found'using errcode='P0002';end if;
 ch:=coalesce(ch,erp_fiscal_unsigned.hash(c));
 d:=erp_fiscal_drafts.record(id);ctx:=erp_fiscal_completion.context(id,c);
 select record into i from erp_fiscal_items.revision where draft_id=id and version=(c->>'item_preparation_version')::integer;
 select record into t from erp_fiscal_tax.revision where draft_id=id and version=(c->>'tax_preparation_version')::integer;
 if erp_fiscal_unsigned.hash(c)<>ch or(ctx->>'completion_version')::integer<>cv or ctx->>'draft_status'<>'draft'or ctx->>'source_status'='cancelled'
  or ctx->'source_changed'is distinct from'false'::jsonb or ctx->'company_changed'is distinct from'false'::jsonb
  or ctx->'matches_current_draft'is distinct from'true'::jsonb or ctx->'matches_current_item_preparation'is distinct from'true'::jsonb
  or ctx->'matches_current_tax_preparation'is distinct from'true'::jsonb or ctx->'matches_current_company'is distinct from'true'::jsonb
  or i is null or t is null or erp_fiscal_unsigned.hash(i)is distinct from c->>'item_preparation_hash'or erp_fiscal_unsigned.hash(t)is distinct from c->>'tax_preparation_hash'
  or t->>'item_preparation_version'is distinct from c->>'item_preparation_version'or d->>'environment'is distinct from'2'
  or d#>>'{snapshot,company,crt}'is distinct from'1'or d#>'{snapshot,company,regime_confirmed}'is distinct from'true'::jsonb then raise exception 'unsigned_basis_conflict'using errcode='40001';end if;
 -- Shape checks are repeated; successful persistence alone never certifies the builder.
 perform erp_fiscal_completion.validate(c->'completion',c->>'model',c->'item_basis');
 proofs:=c-array['item_basis','completion','pending','created_at','version'];
 hashes:=jsonb_build_object('draft_record_hash',erp_fiscal_unsigned.hash(d),'item_record_hash',erp_fiscal_unsigned.hash(i),
  'tax_record_hash',erp_fiscal_unsigned.hash(t),'completion_record_hash',ch);
 fingerprint:=to_json(array['brufap-business-content-basis-v1','sn-sp-internal-business-v1','pl010f-v1.04','brufap-business-builder-v1',id::text,
  c->>'draft_version',c->>'snapshot_hash',hashes->>'draft_record_hash',c->>'item_preparation_version',hashes->>'item_record_hash',
  c->>'tax_preparation_version',hashes->>'tax_record_hash',cv::text,ch,c->>'company_identity_version',c->>'company_fiscal_version',
  c->>'source_document_id',c->>'source_document_version',c->>'model','2']::text[])::text;
 proofs:=proofs||jsonb_build_object('completion_version',cv,'completion_hash',ch,'builder_version','brufap-business-builder-v1','basis_hashes',hashes);
 result:=jsonb_build_object('basis_hash',encode(sha256(convert_to(fingerprint,'UTF8')),'hex'),'basis_fingerprint_text',fingerprint,
  'basis_fingerprint_profile','brufap-business-content-basis-v1','proofs',proofs,'inputs',jsonb_build_object(
  'draft',erp_fiscal_drafts.envelope(d),'itemPreparation',erp_fiscal_items.envelope(id,i),'taxPreparation',erp_fiscal_tax.envelope(id,t),
  'completionPreparation',erp_fiscal_completion.envelope(id,c),'basisHashes',hashes));
 if octet_length(result::text)>8388608 then raise exception 'unsigned_basis_limit'using errcode='22023';end if;return result;
end$$;
create function erp_fiscal_unsigned.check_reservation(r erp_fiscal_numbering.reservation,b jsonb)returns void language plpgsql stable set search_path=pg_catalog as $$
declare p jsonb:=b->'proofs';ctx jsonb;begin
 ctx:=erp_fiscal_numbering.reservation_context(r.id);
 if ctx->'basis_changed'is distinct from'false'::jsonb or ctx->'draft_archived'is distinct from'false'::jsonb or ctx->'source_cancelled'is distinct from'false'::jsonb
  or p->>'draft_id'<>r.draft_id::text or(p->>'draft_version')::integer<>r.draft_version or p->>'snapshot_hash'<>r.snapshot_hash
  or(p->>'item_preparation_version')::integer<>r.item_preparation_version or(p->>'tax_preparation_version')::integer<>r.tax_preparation_version
  or p->>'item_preparation_hash'<>r.item_preparation_hash or p->>'tax_preparation_hash'<>r.tax_preparation_hash
  or p->>'model'<>r.model or p->>'environment'<>'2'or(p->>'company_identity_version')::integer<>r.company_identity_version
  or(p->>'company_fiscal_version')::integer<>r.company_fiscal_version or p->>'source_document_id'<>r.source_document_id::text
  or(p->>'source_document_version')::integer<>r.source_document_version then raise exception 'unsigned_reservation_basis_conflict'using errcode='40001';end if;
 if not exists(select 1 from erp_fiscal_numbering.series where id=r.series_id and enabled and exclusive_use_confirmed and identity_version=r.company_identity_version)then
 raise exception 'unsigned_series_disabled'using errcode='40001';end if;
end$$;
create function erp_fiscal_unsigned.lock_basis(r erp_fiscal_numbering.reservation)returns void language plpgsql set search_path=pg_catalog as $$
begin perform 1 from erp_documents.document where id=r.source_document_id for share;
 perform 1 from erp_fiscal_drafts.draft where id=r.draft_id and source_document_id=r.source_document_id for update;
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_fiscal_items.head where draft_id=r.draft_id for share;
 perform 1 from erp_fiscal_tax.head where draft_id=r.draft_id for share;
 perform 1 from erp_fiscal_completion.head where draft_id=r.draft_id for share;
end$$;
create function erp_fiscal_unsigned.receipt(j erp_fiscal_unsigned.job)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('job_id',j.id,'reservation_id',j.reservation_id,'version',j.version,'draft_id',j.draft_id,
 'completion_version',j.completion_version,'completion_hash',j.completion_hash,'basis_hash',j.basis_hash,'builder_version',j.builder_version,
 'proofs',j.proofs,'identity',i.identity,'access_key',i.access_key,'created_at',j.created_at)
 from erp_fiscal_unsigned.identity i where i.reservation_id=j.reservation_id
$$;
create function erp_fiscal_unsigned.current(j erp_fiscal_unsigned.job)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare ctx jsonb;cv integer;lastjob uuid;lastversion integer;begin
 ctx:=erp_fiscal_numbering.reservation_context(j.reservation_id);select version into cv from erp_fiscal_completion.head where draft_id=j.draft_id;
 select id,version into lastjob,lastversion from erp_fiscal_unsigned.job where reservation_id=j.reservation_id order by version desc limit 1;
 return jsonb_build_object('state',j.state,'attempt_count',j.attempt_count,'lease_until',case when j.state='pending'then j.lease_until else null end,
 'completion_version',cv,'basis_changed',coalesce((ctx->>'basis_changed')::boolean,true)or cv is distinct from j.completion_version,
 'draft_archived',ctx->'draft_archived','source_cancelled',ctx->'source_cancelled','latest_job_id',lastjob,'latest_job_version',lastversion,
 'is_latest_job',lastjob=j.id,'artifact_current',j.state='stored'and lastjob=j.id and cv=j.completion_version and ctx->'basis_changed'='false'::jsonb
  and ctx->'draft_archived'='false'::jsonb and ctx->'source_cancelled'='false'::jsonb,
 'series_enabled',coalesce((select enabled and exclusive_use_confirmed from erp_fiscal_numbering.series where id=(select series_id from erp_fiscal_numbering.reservation where id=j.reservation_id)),false));
end$$;
create function erp_fiscal_unsigned.view(j erp_fiscal_unsigned.job)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_unsigned.flags()||jsonb_build_object('receipt',erp_fiscal_unsigned.receipt(j),'current',erp_fiscal_unsigned.current(j),
 'xml_generated',j.state='stored','error_code',(select error_code from erp_fiscal_unsigned.attempt where id=j.lease_id and state='failed'),
 'artifact',(select jsonb_build_object('xml_hash',a.xml_hash,'size_bytes',a.size_bytes,'access_key',a.access_key,'created_at',a.created_at)from erp_fiscal_unsigned.artifact a where a.job_id=j.id))
$$;
-- This returns source data only to the trusted executor. No public HTTP route is provided.
create function public.erp_fiscal_unsigned_basis(p_user_id uuid,p_draft_id uuid,p_completion_version integer)returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog as $$
declare b jsonb;d jsonb;begin perform erp_fiscal_numbering.access(p_user_id);b:=erp_fiscal_unsigned.basis(p_draft_id,p_completion_version,null);
 d:=b#>'{inputs,draft,record}';if d#>>'{snapshot,company,identity,cnpj}'is distinct from(select data->>'cnpj'from erp_company.identity where singleton)then raise exception 'unsigned_issuer_forbidden'using errcode='42501';end if;
 return erp_fiscal_unsigned.flags()||b||jsonb_build_object('private_executor_only',true,'persisted',false);end$$;
create function public.erp_fiscal_unsigned_begin(p_user_id uuid,p_command_id uuid,p_reservation_id uuid,p_completion_version integer,p_completion_hash text,
 p_basis_hash text,p_builder_version text,p_seed jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_fiscal_numbering.reservation;c erp_fiscal_unsigned.command;j erp_fiscal_unsigned.job;i erp_fiscal_unsigned.identity;
 b jsonb;h text;newjob uuid;lease uuid;at timestamptz;until_at timestamptz;v integer;replay boolean:=false;claimed boolean:=false;begin
 r:=erp_fiscal_unsigned.require_issuer(p_user_id,p_reservation_id);
 if p_command_id is null or p_completion_version is null or p_completion_version<1 or p_completion_hash is null or p_completion_hash!~'^[a-f0-9]{64}$'
  or p_basis_hash is null or p_basis_hash!~'^[a-f0-9]{64}$'or p_builder_version is distinct from'brufap-business-builder-v1'or not erp_fiscal_unsigned.seed_valid(p_seed)then raise exception 'unsigned_begin_invalid'using errcode='22023';end if;
 -- The seed is intentionally excluded: it is valid but only the first identity insert consumes it.
 h:=erp_fiscal_unsigned.hash(jsonb_build_object('actor',p_user_id,'reservation_id',p_reservation_id,'completion_version',p_completion_version,
 'completion_hash',p_completion_hash,'basis_hash',p_basis_hash,'builder_version',p_builder_version));
 perform pg_advisory_xact_lock(174852948,hashtext(p_command_id::text));select *into c from erp_fiscal_unsigned.command where command_id=p_command_id;
 if found then if c.actor<>p_user_id or c.request_hash<>h then raise exception 'unsigned_command_conflict'using errcode='40001';end if;replay:=true;end if;
 perform erp_fiscal_unsigned.lock_basis(r);r:=erp_fiscal_unsigned.require_issuer(p_user_id,p_reservation_id);
 if replay then select *into j from erp_fiscal_unsigned.job where id=c.job_id for update;
 else select *into j from erp_fiscal_unsigned.job where reservation_id=r.id and completion_version=p_completion_version and builder_version=p_builder_version for update;end if;
 if j.id is not null and(j.basis_hash<>p_basis_hash or j.completion_hash<>p_completion_hash)then raise exception 'unsigned_job_conflict'using errcode='40001';end if;
 -- Reading a terminal job is recovery, not a new generation. Its context may now be stale.
 if j.id is null or j.state='pending'and j.lease_until<=clock_timestamp()then
  b:=erp_fiscal_unsigned.basis(r.draft_id,p_completion_version,p_completion_hash);perform erp_fiscal_unsigned.check_reservation(r,b);
  if b->>'basis_hash'<>p_basis_hash then raise exception 'unsigned_basis_conflict'using errcode='40001';end if;
  select *into i from erp_fiscal_unsigned.identity where reservation_id=r.id;
  at:=clock_timestamp();
  if i.reservation_id is null then
   if(p_seed->>'issuedAt')::timestamptz<at-interval'60 seconds'or(p_seed->>'issuedAt')::timestamptz>at+interval'5 seconds'then raise exception 'unsigned_seed_stale'using errcode='40001';end if;
   insert into erp_fiscal_unsigned.identity(reservation_id,identity,access_key,created_at)values(r.id,jsonb_build_object('cUF',r.cuf,'cnpj',r.issuer_cnpj,'model',r.model,'environment','2',
    'series',r.series::text,'number',r.number::text,'tpEmis','1','cNF',p_seed->'cNF','issuedAt',p_seed->'issuedAt'),erp_fiscal_unsigned.access_key(r,p_seed),at)returning *into i;
  end if;
  lease:=gen_random_uuid();until_at:=at+interval'60 seconds';
  if j.id is null then
   select coalesce(max(version),0)into v from erp_fiscal_unsigned.job where reservation_id=r.id;
   if v=2147483647 then raise exception 'unsigned_version_exhausted'using errcode='40001';end if;
   newjob:=gen_random_uuid();insert into erp_fiscal_unsigned.job(id,reservation_id,version,draft_id,completion_version,completion_hash,basis_hash,builder_version,proofs,state,attempt_count,lease_id,lease_until,created_at)
    values(newjob,r.id,v+1,r.draft_id,p_completion_version,p_completion_hash,p_basis_hash,p_builder_version,b->'proofs','pending',1,lease,until_at,at)returning *into j;
  else
   if j.attempt_count=100 then raise exception 'unsigned_attempt_limit'using errcode='40001';end if;
   update erp_fiscal_unsigned.attempt set state='expired',finished_at=at where id=j.lease_id and state='pending';
   update erp_fiscal_unsigned.job set attempt_count=attempt_count+1,lease_id=lease,lease_until=until_at where id=j.id returning *into j;
  end if;claimed:=true;
 end if;
 if not replay then insert into erp_fiscal_unsigned.command(command_id,actor,request_hash,job_id,receipt)values(p_command_id,p_user_id,h,j.id,erp_fiscal_unsigned.receipt(j))returning *into c;end if;
 if claimed then insert into erp_fiscal_unsigned.attempt(id,job_id,ordinal,command_id,actor,state,lease_until,started_at)values(j.lease_id,j.id,j.attempt_count,p_command_id,p_user_id,'pending',j.lease_until,at);end if;
 if claimed and j.lease_until<=clock_timestamp()then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 return erp_fiscal_unsigned.view(j)||jsonb_build_object('command_id',p_command_id,'replayed',replay,'execution',case when claimed then
  jsonb_build_object('private_executor_only',true,'lease_id',j.lease_id,'lease_until',j.lease_until,'inputs',b->'inputs','identity',i.identity,'access_key',i.access_key)else null end);
end$$;
create function erp_fiscal_unsigned.storage_check(p_job uuid,h text,size integer)returns void language plpgsql set search_path=pg_catalog as $$begin
 if p_job is null or h is null or h!~'^[a-f0-9]{64}$'or size is null or size not between 1 and 480000 then raise exception 'unsigned_artifact_invalid'using errcode='22023';end if;
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'unsigned_storage_invalid'using errcode='55000';end if;
 perform 1 from storage.buckets where id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and public=false and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception 'unsigned_storage_invalid'using errcode='55000';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'and name='jobs/'||p_job::text||'/'||h||'.xml'and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception 'unsigned_storage_object_missing'using errcode='40001';end if;
end$$;
create function public.erp_fiscal_unsigned_finish(p_user_id uuid,p_job_id uuid,p_lease_id uuid,p_xml_hash text,p_size_bytes integer,p_access_key text)returns jsonb
 language plpgsql security definer set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;a erp_fiscal_unsigned.attempt;r erp_fiscal_numbering.reservation;b jsonb;h text;at timestamptz;begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_job_id is null or p_lease_id is null or p_xml_hash is null or p_xml_hash!~'^[a-f0-9]{64}$'or p_size_bytes is null or p_size_bytes not between 1 and 480000
  or p_access_key is null or p_access_key!~'^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$'then raise exception 'unsigned_finish_invalid'using errcode='22023';end if;
 select *into j from erp_fiscal_unsigned.job where id=p_job_id;if not found then raise exception 'unsigned_job_not_found'using errcode='P0002';end if;
 r:=erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);perform erp_fiscal_unsigned.lock_basis(r);
 r:=erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);
 select *into j from erp_fiscal_unsigned.job where id=p_job_id for update;select *into a from erp_fiscal_unsigned.attempt where id=p_lease_id and job_id=j.id;
 if a.id is null or a.actor<>p_user_id then raise exception 'unsigned_attempt_forbidden'using errcode='42501';end if;
 h:=erp_fiscal_unsigned.hash(jsonb_build_object('lease',p_lease_id,'xml_hash',p_xml_hash,'size',p_size_bytes,'access_key',p_access_key));
 if a.state='stored'and j.state='stored'then if a.finalize_hash is distinct from h then raise exception 'unsigned_finalize_conflict'using errcode='40001';end if;
  return erp_fiscal_unsigned.view(j)||jsonb_build_object('replayed',true);end if;
 if j.state<>'pending'or a.state<>'pending'or j.lease_id<>p_lease_id or j.lease_until<=clock_timestamp()then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 b:=erp_fiscal_unsigned.basis(j.draft_id,j.completion_version,j.completion_hash);perform erp_fiscal_unsigned.check_reservation(r,b);
 if b->>'basis_hash'<>j.basis_hash or p_access_key is distinct from(select access_key from erp_fiscal_unsigned.identity where reservation_id=j.reservation_id)then raise exception 'unsigned_artifact_binding_conflict'using errcode='40001';end if;
 perform erp_fiscal_unsigned.storage_check(j.id,p_xml_hash,p_size_bytes);at:=clock_timestamp();
 if j.lease_until<=at then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 insert into erp_fiscal_unsigned.artifact(job_id,attempt_id,xml_hash,size_bytes,access_key,created_at)values(j.id,a.id,p_xml_hash,p_size_bytes,p_access_key,at);
 update erp_fiscal_unsigned.attempt set state='stored',finished_at=at,finalize_hash=h where id=a.id;
 update erp_fiscal_unsigned.job set state='stored',finished_at=at where id=j.id returning *into j;
 if j.lease_until<=clock_timestamp()then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 return erp_fiscal_unsigned.view(j)||jsonb_build_object('replayed',false);
end$$;
create function public.erp_fiscal_unsigned_fail(p_user_id uuid,p_job_id uuid,p_lease_id uuid,p_error_code text)returns jsonb
 language plpgsql security definer set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;a erp_fiscal_unsigned.attempt;r erp_fiscal_numbering.reservation;at timestamptz;begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_job_id is null or p_lease_id is null or p_error_code is null or p_error_code not in('CONTENT_INVALID','CONTENT_INCOMPLETE','PROFILE_UNSUPPORTED','ARITHMETIC_MISMATCH','XML_SIZE_LIMIT')then raise exception 'unsigned_failure_invalid'using errcode='22023';end if;
 select *into j from erp_fiscal_unsigned.job where id=p_job_id;if not found then raise exception 'unsigned_job_not_found'using errcode='P0002';end if;
 r:=erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);perform erp_fiscal_unsigned.lock_basis(r);
 r:=erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);
 select *into j from erp_fiscal_unsigned.job where id=p_job_id for update;select *into a from erp_fiscal_unsigned.attempt where id=p_lease_id and job_id=j.id;
 if a.id is null or a.actor<>p_user_id then raise exception 'unsigned_attempt_forbidden'using errcode='42501';end if;
 if a.state='failed'and j.state='failed'then if a.error_code<>p_error_code then raise exception 'unsigned_failure_conflict'using errcode='40001';end if;
  return erp_fiscal_unsigned.view(j)||jsonb_build_object('error_code',a.error_code,'replayed',true);end if;
 if j.state<>'pending'or a.state<>'pending'or j.lease_id<>p_lease_id or j.lease_until<=clock_timestamp()then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 at:=clock_timestamp();update erp_fiscal_unsigned.attempt set state='failed',finished_at=at,error_code=p_error_code where id=a.id;
 update erp_fiscal_unsigned.job set state='failed',finished_at=at where id=j.id returning *into j;
 if j.lease_until<=clock_timestamp()then raise exception 'unsigned_lease_lost'using errcode='40001';end if;
 return erp_fiscal_unsigned.view(j)||jsonb_build_object('error_code',p_error_code,'replayed',false);
end$$;
create function public.erp_fiscal_unsigned_get(p_user_id uuid,p_job_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare j erp_fiscal_unsigned.job;begin perform erp_fiscal_numbering.access(p_user_id);select *into j from erp_fiscal_unsigned.job where id=p_job_id;
 if not found then raise exception 'unsigned_job_not_found'using errcode='P0002';end if;perform erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);
 return erp_fiscal_unsigned.view(j)||jsonb_build_object('read_only',true);end$$;
create function public.erp_fiscal_unsigned_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_fiscal_unsigned.command;j erp_fiscal_unsigned.job;begin perform erp_fiscal_numbering.access(p_user_id);select *into c from erp_fiscal_unsigned.command where command_id=p_command_id;
 if not found then raise exception 'unsigned_command_not_found'using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception 'unsigned_command_forbidden'using errcode='42501';end if;
 select *into j from erp_fiscal_unsigned.job where id=c.job_id;perform erp_fiscal_unsigned.require_issuer(p_user_id,j.reservation_id);
 return erp_fiscal_unsigned.view(j)||jsonb_build_object('command_id',c.command_id,'receipt',c.receipt,'read_only',true);end$$;
create function public.erp_fiscal_unsigned_history(p_user_id uuid,p_reservation_id uuid,p_limit integer default 25,p_before integer default null)returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin perform erp_fiscal_unsigned.require_issuer(p_user_id,p_reservation_id);
 if p_limit is null or p_limit<1 or p_limit>25 or(p_before is not null and p_before<1)then raise exception 'unsigned_query_invalid'using errcode='22023';end if;
 select coalesce(jsonb_agg(erp_fiscal_unsigned.view(j)order by j.version desc),'[]')into items from(select *from erp_fiscal_unsigned.job where reservation_id=p_reservation_id and(p_before is null or version<p_before)order by version desc limit p_limit)j;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_unsigned.job where reservation_id=p_reservation_id and version<(items->-1#>>'{receipt,version}')::integer);
 return erp_fiscal_unsigned.flags()||jsonb_build_object('read_only',true,'reservation_id',p_reservation_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then(items->-1#>>'{receipt,version}')::integer else null end);end$$;
revoke all on all functions in schema erp_fiscal_unsigned from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_unsigned_basis(uuid,uuid,integer),public.erp_fiscal_unsigned_begin(uuid,uuid,uuid,integer,text,text,text,jsonb),
 public.erp_fiscal_unsigned_finish(uuid,uuid,uuid,text,integer,text),public.erp_fiscal_unsigned_fail(uuid,uuid,uuid,text),
 public.erp_fiscal_unsigned_get(uuid,uuid),public.erp_fiscal_unsigned_command(uuid,uuid),public.erp_fiscal_unsigned_history(uuid,uuid,integer,integer)from public,anon,authenticated;
grant execute on function public.erp_fiscal_unsigned_basis(uuid,uuid,integer),public.erp_fiscal_unsigned_begin(uuid,uuid,uuid,integer,text,text,text,jsonb),
 public.erp_fiscal_unsigned_finish(uuid,uuid,uuid,text,integer,text),public.erp_fiscal_unsigned_fail(uuid,uuid,uuid,text),
 public.erp_fiscal_unsigned_get(uuid,uuid),public.erp_fiscal_unsigned_command(uuid,uuid),public.erp_fiscal_unsigned_history(uuid,uuid,integer,integer)to service_role;
commit;
