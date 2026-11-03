-- Homologation receipt queries only. No mutation of authorization/revalidation ledgers.
-- Source/query manifest pins exact reviewed reader, parser, SOAP, XSD and compositor files.
begin;
create schema erp_fiscal_receipt_query;
revoke all on schema erp_fiscal_receipt_query from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_receipt_query revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_receipt_query revoke all on sequences from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_receipt_query revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_receipt_query.profile()returns text language sql immutable set search_path=pg_catalog set timezone='UTC' as $$select 'receipt-query-source-089-v1'::text$$;
create function erp_fiscal_receipt_query.manifest()returns text language sql immutable set search_path=pg_catalog set timezone='UTC' as $$select '748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098'::text$$;
create function erp_fiscal_receipt_query.flags()returns jsonb language sql immutable set search_path=pg_catalog set timezone='UTC' as $$select jsonb_build_object(
 'data_mode','fiscal_receipt_query','environment','2','can_query',false,'can_emit',false,'can_transmit',false,'tax_rules_validated',false,
 'production_authorized',false,'retry_submission_allowed',false,'financial_mutation_performed',false,'stock_mutation_performed',false)$$;
create table erp_fiscal_receipt_query.policy(
 model text not null check(model in('55','65')),version integer not null check(version>0),enabled boolean not null,
 profile text not null,manifest_hash text check(manifest_hash~'^[a-f0-9]{64}$'),origin text not null check(origin='operational'),
 binding_profile text not null,lease_seconds integer not null check(lease_seconds=60),cadence_seconds integer not null check(cadence_seconds=60),
 max_queries_per_hour integer not null check(max_queries_per_hour=10),valid_from timestamptz not null,valid_until timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),primary key(model,version),
 check(isfinite(valid_from)and isfinite(valid_until)and valid_until>valid_from),check(not enabled or manifest_hash is not null));
insert into erp_fiscal_receipt_query.policy(model,version,enabled,profile,manifest_hash,origin,binding_profile,lease_seconds,cadence_seconds,max_queries_per_hour,valid_from,valid_until)
 select m,1,false,'receipt-query-source-089-v1','748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098','operational','sp'||m||'-receipt-soap12-reviewed-20261016-v1',60,60,10,'2026-10-17T00:00:00Z','2026-10-18T00:00:00Z'from unnest(array['55','65'])m;
create table erp_fiscal_receipt_query.query(
 id uuid primary key,actor uuid not null references auth.users(id),request_body_hash text not null check(request_body_hash~'^[a-f0-9]{64}$'),
 authorization_attempt_id uuid not null references erp_fiscal_authorization.attempt(id),authorization_command_id uuid not null references erp_fiscal_authorization.command(id),
 source_kind text not null check(source_kind in('authorization','revalidation')),source_command_id uuid not null,
 source_binding_hash text not null check(source_binding_hash~'^[a-f0-9]{64}$'),source jsonb not null,source_validation jsonb not null,
 selection jsonb not null,predecessors_hash text not null check(predecessors_hash~'^[a-f0-9]{64}$'),ordinal integer not null check(ordinal>0),
 model text not null,policy_version integer not null,policy jsonb not null,foreign key(model,policy_version)references erp_fiscal_receipt_query.policy(model,version),
 identity_version integer not null check(identity_version>0),a1_version integer not null check(a1_version>0),
 credential_id uuid not null references erp_a1.credential(id),envelope_hash text not null references erp_a1.sealed_object(hash),certificate_fingerprint text not null check(certificate_fingerprint~'^[a-f0-9]{64}$'),
 lease_id uuid not null unique,nonce uuid not null unique,created_at timestamptz not null,expires_at timestamptz not null,receipt jsonb not null,
 state text not null check(state in('prepared','request_ready','dispatched','uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorized_homologation')),
 used_at timestamptz,finished_at timestamptz,error_code text,finalize_hash text check(finalize_hash~'^[a-f0-9]{64}$'),
 unique(authorization_attempt_id,ordinal),check(expires_at=created_at+interval'60seconds'),
 check((state in('prepared','request_ready','dispatched'))=(finished_at is null)),
 check((state in('prepared','request_ready','failed_before_dispatch'))=(used_at is null)));
create table erp_fiscal_receipt_query.request(
 query_id uuid primary key references erp_fiscal_receipt_query.query(id),sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 size_bytes integer not null check(size_bytes between 1 and 512000),evidence jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_receipt_query.result(
 query_id uuid primary key references erp_fiscal_receipt_query.query(id),response_hash text not null check(response_hash~'^[a-f0-9]{64}$'),
 response_size integer not null check(response_size between 1 and 512000),observation_hash text not null check(observation_hash~'^[a-f0-9]{64}$'),
 observation_size integer not null check(observation_size between 1 and 8192),evidence jsonb not null,
 processed_hash text check(processed_hash~'^[a-f0-9]{64}$'),processed_size integer check(processed_size between 1 and 512000),
 created_at timestamptz not null default clock_timestamp(),check((processed_hash is null)=(processed_size is null)));
create table erp_fiscal_receipt_query.audit(
 id bigint generated always as identity primary key,query_id uuid not null references erp_fiscal_receipt_query.query(id),actor uuid not null references auth.users(id),
 action text not null check(action in('begin','prepare','consume','finish','fail')),created_at timestamptz not null default clock_timestamp());
do $$declare n text;begin foreach n in array array['policy','query','request','result','audit']loop
 execute format('alter table erp_fiscal_receipt_query.%I enable row level security',n);
 if n<>'query'then execute format('create trigger immutable before update or delete on erp_fiscal_receipt_query.%I for each row execute function erp_fiscal_authorization.immutable()',n);end if;
end loop;end$$;
revoke all on all tables in schema erp_fiscal_receipt_query from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_receipt_query from public,anon,authenticated,service_role;
create function erp_fiscal_receipt_query.access(actor uuid)returns void language plpgsql volatile set search_path=pg_catalog set timezone='UTC' as $$begin
 if actor is null or not exists(select 1 from erp_access.membership where user_id=actor and active and role in('admin','fiscal'))
 then raise exception'receipt_query_forbidden'using errcode='42501';end if;end$$;
create function erp_fiscal_receipt_query.locks(actor uuid,command uuid)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$begin
 perform erp_fiscal_receipt_query.access(actor);
 if command is null then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852989,hashtext(command::text));perform erp_fiscal_receipt_query.access(actor);
 perform pg_advisory_xact_lock(174852920,1);perform erp_fiscal_receipt_query.access(actor);
 perform 1 from auth.users where id=actor for key share;perform erp_fiscal_receipt_query.access(actor);
 perform 1 from erp_access.membership where user_id=actor for share;perform erp_fiscal_receipt_query.access(actor);
end$$;
create function erp_fiscal_receipt_query.policy_lock()returns trigger language plpgsql set search_path=pg_catalog set timezone='UTC' as $$begin
 perform pg_advisory_xact_lock(174852920,1);return new;end$$;
create trigger policy_lock before insert on erp_fiscal_receipt_query.policy for each row execute function erp_fiscal_receipt_query.policy_lock();
create function erp_fiscal_receipt_query.guard_query()returns trigger language plpgsql set search_path=pg_catalog set timezone='UTC' as $$begin
 if tg_op='DELETE'or(to_jsonb(new)-array['state','used_at','finished_at','error_code','finalize_hash'])is distinct from(to_jsonb(old)-array['state','used_at','finished_at','error_code','finalize_hash'])
 or old.state not in('prepared','request_ready','dispatched','uncertain')or new.state='prepared'
 or(old.used_at is not null and new.used_at is distinct from old.used_at)
 or(new.state='request_ready'and old.state<>'prepared')or(new.state='dispatched'and(old.state<>'request_ready'or new.used_at is null))
 or(new.state='failed_before_dispatch'and old.used_at is not null)
 or(new.state not in('request_ready','dispatched','failed_before_dispatch')and old.used_at is null)
 then raise exception'receipt_query_history_immutable'using errcode='42501';end if;return new;end$$;
create trigger guard_query before update or delete on erp_fiscal_receipt_query.query for each row execute function erp_fiscal_receipt_query.guard_query();

create function erp_fiscal_receipt_query.source(actor uuid,kind text,command uuid,expected_attempt uuid)returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare a erp_fiscal_authorization.attempt;i erp_fiscal_authorization.intent;r erp_fiscal_authorization.result;b erp_fiscal_reviewed_authorization.review_binding;
 o erp_fiscal_reviewed_authorization.observation;c erp_fiscal_authorization_revalidation.command;v jsonb;s jsonb;rv jsonb;selected jsonb:=null;ev jsonb;out jsonb;
begin
 perform erp_fiscal_receipt_query.access(actor);
 if kind is null or kind not in('authorization','revalidation')or command is null or expected_attempt is null then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 if kind='revalidation'then
  select *into c from erp_fiscal_authorization_revalidation.command saved where saved.id=source.command;
  if c.id is null then raise exception'receipt_query_source_not_found'using errcode='P0002';end if;
  if c.actor<>actor then raise exception'receipt_query_forbidden'using errcode='42501';end if;
  rv:=public.erp_fiscal_reviewed_authorization_revalidation_command(actor,command);
  if c.attempt_id<>expected_attempt or c.parser_profile<>erp_fiscal_authorization_revalidation.profile()or c.parser_manifest_hash<>erp_fiscal_authorization_revalidation.manifest()
   or c.receipt->>'state'is distinct from'receipt_pending'or c.receipt->'evidence'->>'outcome'is distinct from'receipt_pending'
  then raise exception'receipt_query_source_ineligible'using errcode='55000';end if;
  s:=rv->'source';selected:=jsonb_build_object('receipt',rv->'receipt','source',s);ev:=c.receipt->'evidence';
  select *into a from erp_fiscal_authorization.attempt where id=expected_attempt;
 else
  select *into a from erp_fiscal_authorization.attempt where command_id=command;
  if a.id is null then raise exception'receipt_query_source_not_found'using errcode='P0002';end if;
  if a.actor<>actor then raise exception'receipt_query_forbidden'using errcode='42501';end if;
  if a.id<>expected_attempt then raise exception'receipt_query_source_conflict'using errcode='40001';end if;
  perform erp_fiscal_authorization.source(actor,a.candidate_id,a.signed_hash);perform erp_fiscal_reviewed_authorization.require_profile(a);
  select *into i from erp_fiscal_authorization.intent where id=a.intent_id;select *into r from erp_fiscal_authorization.result where attempt_id=a.id;
  select *into b from erp_fiscal_reviewed_authorization.review_binding where attempt_id=a.id;select *into o from erp_fiscal_reviewed_authorization.observation where attempt_id=a.id;
  if a.state<>'receipt_pending'or a.used_at is null or a.finished_at is null or a.finalize_hash is null or i.consumed_attempt_id is distinct from a.id
   or r.evidence->>'outcome'is distinct from'receipt_pending'or b.attempt_id is null or o.attempt_id is null or o.origin<>'operational'
   or erp_fiscal_authorization.context(a)->>'origin'is distinct from'operational'or o.request_hash is distinct from erp_fiscal_authorization.context(a)->>'request_hash'
   or o.response_hash is distinct from r.response_hash or o.review_hash is distinct from b.proof->>'review_hash'
   or r.evidence->'tls_origin_verified'is distinct from'true'::jsonb or r.evidence->>'transport_hash'is distinct from o.sha256
   or r.evidence->'transport_size'is distinct from to_jsonb(o.size_bytes)
   or not exists(select 1 from erp_fiscal_authorization.audit where attempt_id=a.id and action='consume')
  then raise exception'receipt_query_source_ineligible'using errcode='55000';end if;
  perform erp_fiscal_reviewed_authorization.check_review(a,b.proof,false);v:=erp_fiscal_authorization.view(a);
  s:=jsonb_build_object('receipt',v->'receipt','recovery',v->'recovery','artifact',v->'artifact','rule_review',b.proof,'observation',jsonb_build_object('sha256',o.sha256,'size_bytes',o.size_bytes));ev:=r.evidence;
 end if;
 if a.actor is distinct from actor or ev->>'cstat'is distinct from'103'or ev->>'receipt_number'is null or ev->>'receipt_number'!~'^[0-9]{15}$'or ev->>'receipt_number'~'^0+$'
  or ev->'xsd_validated'is distinct from'true'::jsonb or ev->'context_matched'is distinct from'true'::jsonb or ev->'tls_origin_verified'is distinct from'true'::jsonb
 then raise exception'receipt_query_source_ineligible'using errcode='55000';end if;
 out:=jsonb_build_object('source_kind',kind,'source_command_id',command,'authorization_command_id',a.command_id,'authorization_attempt_id',a.id,
  'candidate_id',a.candidate_id,'candidate_version',s->'receipt'->'candidate_version','signed_hash',a.signed_hash,'signed_size',a.signed_size,
  'model',a.model,'environment','2','origin','operational','original_source',s,'selected_revalidation',selected);
 return out||jsonb_build_object('source_binding_hash',erp_fiscal_wsdl.hash(out));
end$$;
create function erp_fiscal_receipt_query.validation(s jsonb,v jsonb)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare ev jsonb:=case when s->>'source_kind'='authorization'then s->'original_source'->'artifact'->'evidence'else s->'selected_revalidation'->'receipt'->'evidence'end;k text;
begin
 if not erp_a1.exact(v,array['profile','manifest_hash','source_binding_hash','payload_hash','receipt_number','tmed_seconds','received_at','observed_at','signature_verified','xsd_validated','context_matched','tls_origin_verified','tax_rules_validated','can_query','can_emit','can_transmit'])or octet_length(v::text)>8192
  or v->>'profile'is distinct from erp_fiscal_receipt_query.profile()or v->>'manifest_hash'is distinct from erp_fiscal_receipt_query.manifest()
  or v->>'source_binding_hash'is distinct from s->>'source_binding_hash'or v->'payload_hash'is distinct from ev->'payload_hash'
  or v->'receipt_number'is distinct from ev->'receipt_number'or not erp_a1.iso(v->'received_at')or not erp_a1.iso(v->'observed_at')
  or(v->>'received_at')::timestamptz is distinct from(ev->>'received_at')::timestamptz
  or jsonb_typeof(v->'tmed_seconds')is distinct from'number'or v->>'tmed_seconds'!~'^[0-9]{1,4}$'
  or(v->>'observed_at')::timestamptz>clock_timestamp()+interval'5seconds'
 then raise exception'receipt_query_source_validation_invalid'using errcode='22023';end if;
 foreach k in array array['signature_verified','xsd_validated','context_matched','tls_origin_verified']loop if v->k is distinct from'true'::jsonb then raise exception'receipt_query_source_validation_invalid'using errcode='22023';end if;end loop;
 foreach k in array array['tax_rules_validated','can_query','can_emit','can_transmit']loop if v->k is distinct from'false'::jsonb then raise exception'receipt_query_source_validation_invalid'using errcode='22023';end if;end loop;
end$$;
create function erp_fiscal_receipt_query.chain(attempt uuid,excluding uuid default null)returns jsonb language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'ordinal',q.ordinal,'state',q.state,'used_at',q.used_at,'created_at',q.created_at,'expires_at',q.expires_at,
 'finished_at',q.finished_at,'finalize_hash',q.finalize_hash,'request',to_jsonb(r),'result',to_jsonb(s))order by q.ordinal),'[]'::jsonb)
 from erp_fiscal_receipt_query.query q left join erp_fiscal_receipt_query.request r on r.query_id=q.id left join erp_fiscal_receipt_query.result s on s.query_id=q.id
 where q.authorization_attempt_id=attempt and q.id is distinct from excluding$$;
create function erp_fiscal_receipt_query.resolution(attempt uuid)returns jsonb language plpgsql stable set search_path=pg_catalog set timezone='UTC' as $$
declare x record;protocol jsonb:=null;other jsonb;ids jsonb:='[]';selected uuid;state text:='pending';conflict boolean:=false;review boolean:=false;
begin
 for x in select q.id,q.state,q.source,r.evidence from erp_fiscal_receipt_query.query q join erp_fiscal_receipt_query.result r on r.query_id=q.id where q.authorization_attempt_id=attempt order by q.ordinal loop
  if x.state in('authorized_homologation','rejected')then
   other:=jsonb_build_object('state',x.state,'access_key',x.source->'original_source'->'recovery'->'access_key','receipt_number',x.evidence->'receipt_number','reference_digest',x.evidence->'reference_digest','cstat',x.evidence->'cstat','protocol_cstat',x.evidence->'protocol_cstat','protocol_number',x.evidence->'protocol_number','received_at',(x.evidence->>'received_at')::timestamptz);
   ids:=ids||jsonb_build_array(x.id);if protocol is null then protocol:=other;selected:=x.id;state:=x.state;elsif protocol is distinct from other then conflict:=true;end if;
  elsif x.state='review_required'then review:=true;end if;
 end loop;
 if conflict then state:='conflict';selected:=null;elsif protocol is null and review then state:='review_required';end if;
 other:=jsonb_build_object('state',state,'query_ids',ids,'selected_query_id',selected,'protocol',protocol);
 return other||jsonb_build_object('resolution_hash',erp_fiscal_wsdl.hash(other));
end$$;
create function erp_fiscal_receipt_query.next_at(attempt uuid,v jsonb,excluding uuid default null)returns timestamptz language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select greatest((v->>'observed_at')::timestamptz+greatest(60,(v->>'tmed_seconds')::integer)*interval'1second',
 (select max(greatest(created_at,used_at)+interval'60seconds')from erp_fiscal_receipt_query.query where authorization_attempt_id=attempt and id is distinct from excluding))$$;
create function erp_fiscal_receipt_query.chain_gate(attempt uuid,v jsonb,excluding uuid default null)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$begin
 if erp_fiscal_receipt_query.resolution(attempt)->>'state'<>'pending'then raise exception'receipt_query_resolution_closed'using errcode='40001';end if;
 if exists(select 1 from erp_fiscal_receipt_query.query where authorization_attempt_id=attempt and id is distinct from excluding and expires_at>clock_timestamp())then raise exception'receipt_query_active'using errcode='40001';end if;
 if clock_timestamp()<erp_fiscal_receipt_query.next_at(attempt,v,excluding)then raise exception'receipt_query_cadence'using errcode='40001';end if;
 if(select count(*)from erp_fiscal_receipt_query.query where authorization_attempt_id=attempt and id is distinct from excluding and created_at>clock_timestamp()-interval'1hour')>=10 then raise exception'receipt_query_rate_limit'using errcode='40001';end if;
end$$;
create function erp_fiscal_receipt_query.heads(actor uuid,s jsonb,identity_version integer,a1_version integer,policy_version integer)returns jsonb language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare h erp_a1.head;c erp_a1.credential;p erp_fiscal_receipt_query.policy;iv integer;begin
 perform 1 from erp_company.identity where singleton for share;perform erp_fiscal_receipt_query.access(actor);
 select version into iv from erp_company.identity where singleton;
 select *into h from erp_a1.head where singleton for share;perform erp_fiscal_receipt_query.access(actor);
 c:=erp_fiscal_wsdl.check_a1(h,identity_version,a1_version);perform erp_fiscal_receipt_query.access(actor);
 select *into p from erp_fiscal_receipt_query.policy where model=s->>'model'order by version desc limit 1 for share;perform erp_fiscal_receipt_query.access(actor);
 if iv is distinct from identity_version or c.context->>'holder_cnpj'is distinct from s->'original_source'->'recovery'->>'issuer_cnpj'
 then raise exception'receipt_query_identity_conflict'using errcode='40001';end if;
 if p.version is distinct from policy_version or not p.enabled or p.profile<>erp_fiscal_receipt_query.profile()or p.manifest_hash is distinct from erp_fiscal_receipt_query.manifest()
  or p.binding_profile is distinct from'sp'||(s->>'model')||'-receipt-soap12-reviewed-20261016-v1'
  or clock_timestamp()<p.valid_from or clock_timestamp()>=p.valid_until
 then raise exception'receipt_query_policy_conflict'using errcode='40001';end if;
 return jsonb_build_object('policy',to_jsonb(p),'identity_version',iv,'a1_version',h.version,'credential_id',h.credential_id,'envelope_hash',h.object_hash,'certificate_fingerprint',c.metadata->>'fingerprint_sha256');
end$$;
create function erp_fiscal_receipt_query.storage(actor uuid,id uuid,kind text,tag text,size integer)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare ok boolean;begin
 if kind is null or kind not in('requests','responses','observations','processed')or tag is null or tag!~'^[a-f0-9]{64}$'or size is null or size not between 1 and(case when kind='observations'then 8192 else 512000 end)
 then raise exception'receipt_query_object_invalid'using errcode='22023';end if;
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception'receipt_query_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.buckets bucket where bucket.id='brufap-fiscal-artifacts'and name='brufap-fiscal-artifacts'and not public and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 ok:=found;perform erp_fiscal_receipt_query.access(actor);if not ok then raise exception'receipt_query_storage_private_required'using errcode='40001';end if;
 perform 1 from storage.objects where bucket_id='brufap-fiscal-artifacts'and name='receipt-queries/'||id::text||'/'||kind||'/'||tag||case when kind='observations'then'.json'else'.xml'end
 and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 ok:=found;perform erp_fiscal_receipt_query.access(actor);if not ok then raise exception'receipt_query_object_missing'using errcode='40001';end if;
end$$;
create function erp_fiscal_receipt_query.recovery(q erp_fiscal_receipt_query.query)returns jsonb language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select jsonb_build_object('private_executor_only',true,'purpose','sp-receipt-query-homologation-v1','query_id',q.id,'actor',q.actor,
 'authorization_command_id',q.authorization_command_id,'authorization_attempt_id',q.authorization_attempt_id,'source_kind',q.source_kind,'source_command_id',q.source_command_id,'source_binding_hash',q.source_binding_hash,
 'candidate_id',q.source->'candidate_id','candidate_version',q.source->'candidate_version','signed_hash',q.source->'signed_hash','signed_size',q.source->'signed_size','model',q.model,'environment','2','origin','operational',
 'lease_id',q.lease_id,'nonce',q.nonce,'created_at',q.created_at,'expires_at',q.expires_at,'policy',q.policy,
 'identity_version',q.identity_version,'a1_version',q.a1_version,'credential_id',q.credential_id,'envelope_hash',q.envelope_hash,'certificate_fingerprint',q.certificate_fingerprint,
 'receipt_number',q.source_validation->'receipt_number','access_key',q.source->'original_source'->'recovery'->'access_key','reference_digest',q.source->'original_source'->'recovery'->'reference_digest',
 'issuer_cnpj',q.source->'original_source'->'recovery'->'issuer_cnpj','request_hash',r.sha256,'request_size',r.size_bytes)
 from (select 1)x left join erp_fiscal_receipt_query.request r on r.query_id=q.id$$;
create function erp_fiscal_receipt_query.view(q erp_fiscal_receipt_query.query)returns jsonb language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select erp_fiscal_receipt_query.flags()||jsonb_build_object('query_id',q.id,'receipt',q.receipt,'source',q.source,'source_validation',q.source_validation,
 'current',jsonb_build_object('state',q.state,'grant_consumed',q.used_at is not null,'used_at',q.used_at,'expires_at',q.expires_at,'lease_expired',q.expires_at<=clock_timestamp(),'finished_at',q.finished_at,'recovery_required',q.state in('dispatched','uncertain')),
 'request',to_jsonb(r),'artifact',to_jsonb(s),'recovery',erp_fiscal_receipt_query.recovery(q),'resolution',erp_fiscal_receipt_query.resolution(q.authorization_attempt_id),'error_code',q.error_code)
 from(select 1)x left join erp_fiscal_receipt_query.request r on r.query_id=q.id left join erp_fiscal_receipt_query.result s on s.query_id=q.id$$;
create function erp_fiscal_receipt_query.check_source(q erp_fiscal_receipt_query.query)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$begin
 if erp_fiscal_receipt_query.source(q.actor,q.source_kind,q.source_command_id,q.authorization_attempt_id)is distinct from q.source then raise exception'receipt_query_source_conflict'using errcode='40001';end if;end$$;
create function erp_fiscal_receipt_query.lock_query(actor uuid,id uuid,lease uuid)returns erp_fiscal_receipt_query.query language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare q erp_fiscal_receipt_query.query;begin
 perform erp_fiscal_receipt_query.locks(actor,id);
 select *into q from erp_fiscal_receipt_query.query where query.id=lock_query.id for update;perform erp_fiscal_receipt_query.access(actor);
 if q.id is null then raise exception'receipt_query_not_found'using errcode='P0002';end if;
 if q.actor<>actor then raise exception'receipt_query_forbidden'using errcode='42501';end if;
 if lease is null or q.lease_id<>lease then raise exception'receipt_query_lease_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.check_source(q);return q;end$$;
create function erp_fiscal_receipt_query.current_gate(q erp_fiscal_receipt_query.query)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare h jsonb;begin
 perform erp_fiscal_receipt_query.access(q.actor);h:=erp_fiscal_receipt_query.heads(q.actor,q.source,q.identity_version,q.a1_version,q.policy_version);
 if h->'credential_id'is distinct from to_jsonb(q.credential_id)or h->>'envelope_hash'is distinct from q.envelope_hash or h->>'certificate_fingerprint'is distinct from q.certificate_fingerprint or h->'policy'is distinct from q.policy
 then raise exception'receipt_query_heads_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.check_source(q);
 if q.expires_at<=clock_timestamp()then raise exception'receipt_query_lease_expired'using errcode='40001';end if;
 if erp_fiscal_wsdl.hash(erp_fiscal_receipt_query.chain(q.authorization_attempt_id,q.id))<>q.predecessors_hash then raise exception'receipt_query_chain_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.chain_gate(q.authorization_attempt_id,q.source_validation,q.id);
end$$;
create function erp_fiscal_receipt_query.commit_use()returns trigger language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare q erp_fiscal_receipt_query.query;begin
 select *into q from erp_fiscal_receipt_query.query where id=new.id;
 perform erp_fiscal_receipt_query.current_gate(q);return null;end$$;
create constraint trigger receipt_query_use_commit after update on erp_fiscal_receipt_query.query deferrable initially deferred
 for each row when(old.used_at is null and new.used_at is not null)execute function erp_fiscal_receipt_query.commit_use();

create function public.erp_fiscal_receipt_query_context(p_user_id uuid,p_source_kind text,p_source_command_id uuid,p_expected_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s jsonb;p erp_fiscal_receipt_query.policy;h erp_a1.head;c erp_a1.credential;o erp_a1.sealed_object;co jsonb;iv integer;v jsonb;chain text;sel jsonb;b jsonb:='["SOURCE_VALIDATION_REQUIRED"]';at timestamptz:=clock_timestamp();hist jsonb;begin
 s:=erp_fiscal_receipt_query.source(p_user_id,p_source_kind,p_source_command_id,p_expected_attempt_id);
 select *into p from erp_fiscal_receipt_query.policy where model=s->>'model'order by version desc limit 1;select *into h from erp_a1.head where singleton;select version into iv from erp_company.identity where singleton;
 chain:=erp_fiscal_wsdl.hash(erp_fiscal_receipt_query.chain(p_expected_attempt_id));
 select source_validation into v from erp_fiscal_receipt_query.query where authorization_attempt_id=p_expected_attempt_id order by ordinal limit 1;
 if p.enabled is distinct from true then b:=b||'"POLICY_DISABLED"'::jsonb;end if;
 if at<p.valid_from or at>=p.valid_until then b:=b||'"POLICY_TIME_INVALID"'::jsonb;end if;
 if p.profile is distinct from erp_fiscal_receipt_query.profile()or p.manifest_hash is distinct from erp_fiscal_receipt_query.manifest()or p.binding_profile is distinct from'sp'||(s->>'model')||'-receipt-soap12-reviewed-20261016-v1'then b:=b||'"POLICY_PROFILE_INVALID"'::jsonb;end if;
 co:=erp_a1.company();select *into c from erp_a1.credential where id=h.credential_id;select *into o from erp_a1.sealed_object where hash=h.object_hash and credential_id=h.credential_id;
 if co is null or co->>'cnpj'is distinct from s->'original_source'->'recovery'->>'issuer_cnpj'then b:=b||'"IDENTITY_MISMATCH"'::jsonb;end if;
 if c.id is null or o.hash is null then b:=b||'"A1_UNAVAILABLE"'::jsonb;
 else
  if c.context->'company_identity_version'is distinct from to_jsonb(iv)or c.context->'holder_cnpj'is distinct from co->'cnpj'or c.metadata->'holder_cnpj'is distinct from co->'cnpj'
   or c.context->>'environment'is distinct from'2'or c.context->>'purpose'is distinct from'offline-homologation'or c.metadata->'key_matches_certificate'is distinct from'true'::jsonb
   or not erp_a1.iso(c.metadata->'not_before')or not erp_a1.iso(c.metadata->'not_after')
   or at<(c.metadata->>'not_before')::timestamptz or at>(c.metadata->>'not_after')::timestamptz
  then b:=b||'"A1_INVALID"'::jsonb;end if;
  if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)
   or not exists(select 1 from storage.buckets where id='brufap-a1-vault'and name='brufap-a1-vault'and not public and file_size_limit=1500000 and allowed_mime_types=array['application/json']::text[])
   or not exists(select 1 from storage.objects where bucket_id='brufap-a1-vault'and name='credentials/'||c.id::text||'/'||o.hash||'.json'and metadata->>'size'=o.size_bytes::text and metadata->>'mimetype'='application/json')
  then b:=b||'"A1_STORAGE_INVALID"'::jsonb;end if;
 end if;
 if erp_fiscal_receipt_query.resolution(p_expected_attempt_id)->>'state'<>'pending'then b:=b||'"RESOLUTION_CLOSED"'::jsonb;end if;
 if exists(select 1 from erp_fiscal_receipt_query.query where authorization_attempt_id=p_expected_attempt_id and expires_at>at)then b:=b||'"QUERY_ACTIVE"'::jsonb;end if;
 if v is not null and at<erp_fiscal_receipt_query.next_at(p_expected_attempt_id,v)then b:=b||'"CADENCE_REQUIRED"'::jsonb;end if;
 if(select count(*)from erp_fiscal_receipt_query.query where authorization_attempt_id=p_expected_attempt_id and created_at>at-interval'1hour')>=10 then b:=b||'"RATE_LIMIT"'::jsonb;end if;
 sel:=jsonb_build_object('source_kind',p_source_kind,'source_command_id',p_source_command_id,'expected_authorization_command_id',s->'authorization_command_id','expected_attempt_id',p_expected_attempt_id,
 'expected_candidate_id',s->'candidate_id','expected_candidate_version',s->'candidate_version','expected_signed_hash',s->'signed_hash','expected_source_binding_hash',s->'source_binding_hash','expected_chain_hash',chain,'expected_identity_version',iv,'expected_a1_version',h.version,'expected_query_policy_version',p.version);
 select coalesce(jsonb_agg(erp_fiscal_receipt_query.view(q)order by q.ordinal desc),'[]')into hist from(select *from erp_fiscal_receipt_query.query where authorization_attempt_id=p_expected_attempt_id order by ordinal desc limit 25)q;
 return erp_fiscal_receipt_query.flags()||jsonb_build_object('read_only',true,'source',s,'observed_at',at,'chain_hash',chain,'resolution',erp_fiscal_receipt_query.resolution(p_expected_attempt_id),'policy',to_jsonb(p),
 'heads',jsonb_build_object('identity_version',iv,'a1_version',h.version),'selection',sel,'next_query_at',case when v is null then null else erp_fiscal_receipt_query.next_at(p_expected_attempt_id,v)end,'blockers',b,'source_validation_required',true,'private_eligible_for_attested_source',b='["SOURCE_VALIDATION_REQUIRED"]'::jsonb,'history',hist);
end$$;
create function public.erp_fiscal_receipt_query_begin(p_user_id uuid,p_command_id uuid,p_selection jsonb,p_source_validation jsonb,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s jsonb;h jsonb;q erp_fiscal_receipt_query.query;tag text;at timestamptz;n integer;lease uuid;nonce uuid;receipt jsonb;k text;begin
 perform erp_fiscal_receipt_query.access(p_user_id);
 if p_command_id is null or p_confirmed is distinct from true or not erp_a1.exact(p_selection,array['source_kind','source_command_id','expected_authorization_command_id','expected_attempt_id','expected_candidate_id','expected_candidate_version','expected_signed_hash','expected_source_binding_hash','expected_chain_hash','expected_identity_version','expected_a1_version','expected_query_policy_version'])or octet_length(p_selection::text)>8192 or jsonb_typeof(p_source_validation)is distinct from'object'or octet_length(p_source_validation::text)>8192
 then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 foreach k in array array['expected_signed_hash','expected_source_binding_hash','expected_chain_hash']loop if jsonb_typeof(p_selection->k)is distinct from'string'or p_selection->>k!~'^[a-f0-9]{64}$'then raise exception'receipt_query_input_invalid'using errcode='22023';end if;end loop;
 foreach k in array array['expected_candidate_version','expected_identity_version','expected_a1_version','expected_query_policy_version']loop if jsonb_typeof(p_selection->k)is distinct from'number'or p_selection->>k!~'^[1-9][0-9]{0,8}$'then raise exception'receipt_query_input_invalid'using errcode='22023';end if;end loop;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('actor',p_user_id,'selection',p_selection,'source_validation',p_source_validation,'confirmed',true));
 perform erp_fiscal_receipt_query.locks(p_user_id,p_command_id);
 select *into q from erp_fiscal_receipt_query.query where id=p_command_id;
 if found then
  if q.actor<>p_user_id then raise exception'receipt_query_forbidden'using errcode='42501';end if;
  if q.request_body_hash<>tag then raise exception'receipt_query_command_conflict'using errcode='40001';end if;
  perform erp_fiscal_receipt_query.check_source(q);return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',true,'execution',null);
 end if;
 s:=erp_fiscal_receipt_query.source(p_user_id,p_selection->>'source_kind',(p_selection->>'source_command_id')::uuid,(p_selection->>'expected_attempt_id')::uuid);
 if p_command_id in((s->>'authorization_command_id')::uuid,(s->>'source_command_id')::uuid)or s->'authorization_command_id'is distinct from p_selection->'expected_authorization_command_id'
 or s->'candidate_id'is distinct from p_selection->'expected_candidate_id'or s->'candidate_version'is distinct from p_selection->'expected_candidate_version'or s->'signed_hash'is distinct from p_selection->'expected_signed_hash'or s->'source_binding_hash'is distinct from p_selection->'expected_source_binding_hash'
 then raise exception'receipt_query_source_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.validation(s,p_source_validation);
 h:=erp_fiscal_receipt_query.heads(p_user_id,s,(p_selection->>'expected_identity_version')::integer,(p_selection->>'expected_a1_version')::integer,(p_selection->>'expected_query_policy_version')::integer);
 if erp_fiscal_wsdl.hash(erp_fiscal_receipt_query.chain((s->>'authorization_attempt_id')::uuid))is distinct from p_selection->>'expected_chain_hash'then raise exception'receipt_query_chain_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.chain_gate((s->>'authorization_attempt_id')::uuid,p_source_validation);
 at:=clock_timestamp();select coalesce(max(ordinal),0)+1 into n from erp_fiscal_receipt_query.query where authorization_attempt_id=(s->>'authorization_attempt_id')::uuid;
 lease:=gen_random_uuid();nonce:=gen_random_uuid();
 receipt:=jsonb_build_object('query_id',p_command_id,'actor',p_user_id,'authorization_command_id',s->'authorization_command_id','authorization_attempt_id',s->'authorization_attempt_id','source_kind',s->'source_kind','source_command_id',s->'source_command_id','source_binding_hash',s->'source_binding_hash',
 'candidate_id',s->'candidate_id','candidate_version',s->'candidate_version','signed_hash',s->'signed_hash','model',s->'model','environment','2','origin','operational','ordinal',n,'identity_version',h->'identity_version','a1_version',h->'a1_version','query_policy_version',h->'policy'->'version','created_at',at,'expires_at',at+interval'60seconds');
 insert into erp_fiscal_receipt_query.query(id,actor,request_body_hash,authorization_attempt_id,authorization_command_id,source_kind,source_command_id,source_binding_hash,source,source_validation,selection,predecessors_hash,ordinal,model,policy_version,policy,identity_version,a1_version,credential_id,envelope_hash,certificate_fingerprint,lease_id,nonce,created_at,expires_at,receipt,state)
 values(p_command_id,p_user_id,tag,(s->>'authorization_attempt_id')::uuid,(s->>'authorization_command_id')::uuid,s->>'source_kind',(s->>'source_command_id')::uuid,s->>'source_binding_hash',s,p_source_validation,p_selection,p_selection->>'expected_chain_hash',n,s->>'model',(h->'policy'->>'version')::integer,h->'policy',(h->>'identity_version')::integer,(h->>'a1_version')::integer,(h->>'credential_id')::uuid,h->>'envelope_hash',h->>'certificate_fingerprint',lease,nonce,at,at+interval'60seconds',receipt,'prepared')returning *into q;
 insert into erp_fiscal_receipt_query.audit(query_id,actor,action)values(q.id,p_user_id,'begin');
 perform erp_fiscal_receipt_query.current_gate(q);
 return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',false,'execution',erp_fiscal_receipt_query.recovery(q));
end$$;
create function erp_fiscal_receipt_query.preparation(q erp_fiscal_receipt_query.query,v jsonb,sha text)returns void language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare k text;ctx jsonb:=erp_fiscal_receipt_query.recovery(q);begin
 if not erp_a1.exact(v,array['profile','manifest_hash','query_id','nonce','source_binding_hash','request_hash','payload_hash','signed_hash','model','environment','receipt_number','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit'])or octet_length(v::text)>8192
 or v->>'profile'is distinct from erp_fiscal_receipt_query.profile()or v->>'manifest_hash'is distinct from erp_fiscal_receipt_query.manifest()
 or v->>'request_hash'is distinct from sha or jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$'
 then raise exception'receipt_query_preparation_invalid'using errcode='22023';end if;
 foreach k in array array['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number']loop if v->k is distinct from ctx->k then raise exception'receipt_query_preparation_binding'using errcode='22023';end if;end loop;
 foreach k in array array['signature_verified','xsd_validated','context_matched']loop if v->k is distinct from'true'::jsonb then raise exception'receipt_query_preparation_invalid'using errcode='22023';end if;end loop;
 foreach k in array array['tax_rules_validated','can_emit','can_transmit']loop if v->k is distinct from'false'::jsonb then raise exception'receipt_query_preparation_invalid'using errcode='22023';end if;end loop;
end$$;
create function public.erp_fiscal_receipt_query_prepare(p_user_id uuid,p_query_id uuid,p_lease_id uuid,p_request_hash text,p_request_size integer,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare q erp_fiscal_receipt_query.query;r erp_fiscal_receipt_query.request;begin
 q:=erp_fiscal_receipt_query.lock_query(p_user_id,p_query_id,p_lease_id);
 if p_request_hash is null or p_request_hash!~'^[a-f0-9]{64}$'or p_request_size is null or p_request_size not between 1 and 512000 then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 perform erp_fiscal_receipt_query.preparation(q,p_evidence,p_request_hash);select *into r from erp_fiscal_receipt_query.request where query_id=q.id;
 if found then
  if r.sha256<>p_request_hash or r.size_bytes<>p_request_size or r.evidence is distinct from p_evidence then raise exception'receipt_query_request_conflict'using errcode='40001';end if;
  return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',true);
 end if;
 if q.state<>'prepared'then raise exception'receipt_query_prepare_conflict'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.current_gate(q);perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'requests',p_request_hash,p_request_size);
 perform erp_fiscal_receipt_query.current_gate(q);
 insert into erp_fiscal_receipt_query.request(query_id,sha256,size_bytes,evidence)values(q.id,p_request_hash,p_request_size,p_evidence);
 update erp_fiscal_receipt_query.query set state='request_ready'where id=q.id returning *into q;
 insert into erp_fiscal_receipt_query.audit(query_id,actor,action)values(q.id,p_user_id,'prepare');perform erp_fiscal_receipt_query.current_gate(q);
 return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',false);
end$$;
create function public.erp_fiscal_receipt_query_use(p_user_id uuid,p_query_id uuid,p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare q erp_fiscal_receipt_query.query;r erp_fiscal_receipt_query.request;begin
 q:=erp_fiscal_receipt_query.lock_query(p_user_id,p_query_id,p_lease_id);
 if q.used_at is not null or q.state<>'request_ready'then raise exception'receipt_query_use_conflict'using errcode='40001';end if;
 select *into r from erp_fiscal_receipt_query.request where query_id=q.id;
 if r.query_id is null then raise exception'receipt_query_request_missing'using errcode='40001';end if;
 perform erp_fiscal_receipt_query.current_gate(q);perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'requests',r.sha256,r.size_bytes);perform erp_fiscal_receipt_query.preparation(q,r.evidence,r.sha256);
 perform erp_fiscal_receipt_query.current_gate(q);
 update erp_fiscal_receipt_query.query set state='dispatched',used_at=clock_timestamp()where id=q.id returning *into q;
 insert into erp_fiscal_receipt_query.audit(query_id,actor,action)values(q.id,p_user_id,'consume');
 -- The final check covers all preceding FK waits; the queued constraint guard checks again at commit.
 perform erp_fiscal_receipt_query.current_gate(q);
 return erp_fiscal_receipt_query.flags()||jsonb_build_object('private_executor_only',true,'grant',erp_fiscal_receipt_query.recovery(q)||jsonb_build_object('issued_at',q.used_at));
end$$;
create function erp_fiscal_receipt_query.result_state(q erp_fiscal_receipt_query.query,v jsonb,response_hash text,observation_hash text,observation_size integer,processed_hash text)returns text language plpgsql set search_path=pg_catalog set timezone='UTC' as $$
declare k text;ctx jsonb:=erp_fiscal_receipt_query.recovery(q);begin
 if not erp_a1.exact(v,array['profile','manifest_hash','query_id','nonce','source_binding_hash','request_hash','response_hash','payload_hash','signed_hash','model','environment','receipt_number','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','reference_digest','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','observation_hash','observation_size','tax_rules_validated','can_emit','can_transmit'])or octet_length(v::text)>16384
 or v->>'profile'is distinct from erp_fiscal_receipt_query.profile()or v->>'manifest_hash'is distinct from erp_fiscal_receipt_query.manifest()
 or v->>'response_hash'is distinct from response_hash or v->>'observation_hash'is distinct from observation_hash or v->'observation_size'is distinct from to_jsonb(observation_size)
 or v->'tls_origin_verified'is distinct from'true'::jsonb
 then raise exception'receipt_query_result_invalid'using errcode='22023';end if;
 foreach k in array array['query_id','nonce','source_binding_hash','request_hash','signed_hash','model','environment','receipt_number']loop if v->k is distinct from ctx->k then raise exception'receipt_query_result_binding'using errcode='22023';end if;end loop;
 foreach k in array array['tax_rules_validated','can_emit','can_transmit']loop if v->k is distinct from'false'::jsonb then raise exception'receipt_query_result_invalid'using errcode='22023';end if;end loop;
 if v->>'outcome'='invalid_response'then
  if jsonb_typeof(v->'rejection_code')is distinct from'string'or v->>'rejection_code'not in('SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID')or processed_hash is not null then raise exception'receipt_query_result_invalid'using errcode='22023';end if;
  foreach k in array array['signature_verified','xsd_validated','context_matched','processed_xsd_validated']loop if v->k is distinct from'false'::jsonb then raise exception'receipt_query_result_invalid'using errcode='22023';end if;end loop;
  foreach k in array array['cstat','protocol_cstat','protocol_number','received_at','reference_digest']loop if v->k is distinct from'null'::jsonb then raise exception'receipt_query_result_invalid'using errcode='22023';end if;end loop;
  if v->'payload_hash'is distinct from'null'::jsonb and(jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$')then raise exception'receipt_query_result_invalid'using errcode='22023';end if;
  return'review_required';
 end if;
 if v->'xsd_validated'is distinct from'true'::jsonb or v->'context_matched'is distinct from'true'::jsonb or v->'rejection_code'is distinct from'null'::jsonb
 or jsonb_typeof(v->'payload_hash')is distinct from'string'or v->>'payload_hash'!~'^[a-f0-9]{64}$'or not erp_a1.iso(v->'received_at')
 or jsonb_typeof(v->'cstat')is distinct from'string'or v->>'cstat'!~'^[0-9]{3,4}$'
 then raise exception'receipt_query_result_invalid'using errcode='22023';end if;
 if v->'protocol_cstat'is distinct from'null'::jsonb and(jsonb_typeof(v->'protocol_cstat')is distinct from'string'or v->>'protocol_cstat'!~'^[0-9]{3,4}$'or v->>'cstat'<>'104')then raise exception'receipt_query_result_invalid'using errcode='22023';end if;
 if v->>'outcome'='authorization_declared'then
  if v->>'cstat'<>'104'or coalesce(v->>'protocol_cstat','')not in('100','150')or jsonb_typeof(v->'protocol_number')is distinct from'string'
  or v->>'protocol_number'!~'^([0-9]{15}|[0-9]{17})$'or v->>'protocol_number'~'^0+$'or v->'reference_digest'is distinct from ctx->'reference_digest'
  or v->'signature_verified'is distinct from'true'::jsonb or v->'processed_xsd_validated'is distinct from'true'::jsonb or processed_hash is null
  then raise exception'receipt_query_protocol_incomplete'using errcode='22023';end if;return'authorized_homologation';
 end if;
 if processed_hash is not null or v->'signature_verified'is distinct from'false'::jsonb or v->'processed_xsd_validated'is distinct from'false'::jsonb or v->'reference_digest'is distinct from'null'::jsonb or v->'protocol_number'is distinct from'null'::jsonb then raise exception'receipt_query_unexpected_processed'using errcode='22023';end if;
 if v->>'outcome'='receipt_pending'and v->>'cstat'='105'and v->'protocol_cstat'='null'::jsonb then return'receipt_pending';end if;
 if v->>'outcome'='rejected'and v->>'cstat'='104'and(v->>'protocol_cstat')::integer>=200 and v->>'protocol_cstat'not in('204','217','539')then return'rejected';end if;
 if v->>'outcome'='review_required'and v->>'cstat'not in('100','150','105')and coalesce(v->>'protocol_cstat','')not in('100','150')then return'review_required';end if;
 raise exception'receipt_query_outcome_invalid'using errcode='22023';
end$$;
create function public.erp_fiscal_receipt_query_finish(p_user_id uuid,p_query_id uuid,p_lease_id uuid,p_response_hash text,p_response_size integer,p_observation_hash text,p_observation_size integer,p_evidence jsonb,p_processed_hash text,p_processed_size integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare q erp_fiscal_receipt_query.query;tag text;new_state text;r erp_fiscal_receipt_query.request;s erp_fiscal_receipt_query.result;begin
 q:=erp_fiscal_receipt_query.lock_query(p_user_id,p_query_id,p_lease_id);
 if p_response_hash is null or p_response_hash!~'^[a-f0-9]{64}$'or p_response_size is null or p_response_size not between 1 and 512000
 or p_observation_hash is null or p_observation_hash!~'^[a-f0-9]{64}$'or p_observation_size is null or p_observation_size not between 1 and 8192
 or(p_processed_hash is null)<>(p_processed_size is null)or(p_processed_hash is not null and(p_processed_hash!~'^[a-f0-9]{64}$'or p_processed_size not between 1 and 512000))then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('response_hash',p_response_hash,'response_size',p_response_size,'observation_hash',p_observation_hash,'observation_size',p_observation_size,'evidence',p_evidence,'processed_hash',p_processed_hash,'processed_size',p_processed_size));
 select *into s from erp_fiscal_receipt_query.result where query_id=q.id;
 if found then
  if q.finalize_hash<>tag then raise exception'receipt_query_finish_conflict'using errcode='40001';end if;
  return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',true);
 end if;
 if q.used_at is null or q.state not in('dispatched','uncertain')or not exists(select 1 from erp_fiscal_receipt_query.audit where query_id=q.id and action='consume')then raise exception'receipt_query_finish_conflict'using errcode='40001';end if;
 new_state:=erp_fiscal_receipt_query.result_state(q,p_evidence,p_response_hash,p_observation_hash,p_observation_size,p_processed_hash);
 select *into r from erp_fiscal_receipt_query.request where query_id=q.id;
 perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'requests',r.sha256,r.size_bytes);
 perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'responses',r.sha256,p_response_size);
 perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'observations',r.sha256,p_observation_size);
 if p_processed_hash is not null then perform erp_fiscal_receipt_query.storage(p_user_id,q.id,'processed',p_processed_hash,p_processed_size);end if;
 perform erp_fiscal_receipt_query.check_source(q);
 insert into erp_fiscal_receipt_query.result(query_id,response_hash,response_size,observation_hash,observation_size,evidence,processed_hash,processed_size)
 values(q.id,p_response_hash,p_response_size,p_observation_hash,p_observation_size,p_evidence,p_processed_hash,p_processed_size);
 update erp_fiscal_receipt_query.query set state=new_state,finished_at=clock_timestamp(),error_code=null,finalize_hash=tag where id=q.id returning *into q;
 insert into erp_fiscal_receipt_query.audit(query_id,actor,action)values(q.id,p_user_id,'finish');perform erp_fiscal_receipt_query.access(p_user_id);
 return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',false);
end$$;
create function public.erp_fiscal_receipt_query_fail(p_user_id uuid,p_query_id uuid,p_lease_id uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare q erp_fiscal_receipt_query.query;tag text;begin
 q:=erp_fiscal_receipt_query.lock_query(p_user_id,p_query_id,p_lease_id);
 if p_error_code is null or p_error_code not in('RECEIPT_QUERY_PREPARATION_FAILED','RECEIPT_QUERY_CUSTODY_FAILED','RECEIPT_QUERY_TRANSPORT_FAILED','RECEIPT_QUERY_TRANSPORT_TIMEOUT','RECEIPT_QUERY_STORAGE_FAILED','RECEIPT_QUERY_RESULT_UNCONFIRMED','RECEIPT_QUERY_CANCELLED')then raise exception'receipt_query_error_invalid'using errcode='22023';end if;
 tag:=erp_fiscal_wsdl.hash(jsonb_build_object('fail',p_error_code));
 if q.state in('failed_before_dispatch','uncertain')and q.finalize_hash=tag then return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',true);end if;
 if q.state not in('prepared','request_ready','dispatched')then raise exception'receipt_query_fail_conflict'using errcode='40001';end if;
 update erp_fiscal_receipt_query.query set state=case when used_at is null then'failed_before_dispatch'else'uncertain'end,finished_at=clock_timestamp(),error_code=p_error_code,finalize_hash=tag where id=q.id returning *into q;
 insert into erp_fiscal_receipt_query.audit(query_id,actor,action)values(q.id,p_user_id,'fail');perform erp_fiscal_receipt_query.access(p_user_id);
 return erp_fiscal_receipt_query.view(q)||jsonb_build_object('replayed',false);
end$$;
create function public.erp_fiscal_receipt_query_command(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$declare q erp_fiscal_receipt_query.query;begin
 perform erp_fiscal_receipt_query.access(p_user_id);if p_command_id is null then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 select *into q from erp_fiscal_receipt_query.query where id=p_command_id;if not found then raise exception'receipt_query_not_found'using errcode='P0002';end if;
 if q.actor<>p_user_id then raise exception'receipt_query_forbidden'using errcode='42501';end if;perform erp_fiscal_receipt_query.check_source(q);
 return erp_fiscal_receipt_query.view(q)||jsonb_build_object('read_only',true,'replayed',true,'execution',null);
end$$;
create function public.erp_fiscal_receipt_query_history(p_user_id uuid,p_authorization_command_id uuid,p_expected_attempt_id uuid,p_limit integer default 25,p_before integer default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare a erp_fiscal_authorization.attempt;items jsonb;cursor integer;begin
 perform erp_fiscal_receipt_query.access(p_user_id);
 if p_authorization_command_id is null or p_expected_attempt_id is null or p_limit is null or p_limit not between 1 and 25 or(p_before is not null and p_before<1)then raise exception'receipt_query_input_invalid'using errcode='22023';end if;
 select *into a from erp_fiscal_authorization.attempt where command_id=p_authorization_command_id;
 if a.id is null then raise exception'receipt_query_source_not_found'using errcode='P0002';end if;
 if a.actor<>p_user_id then raise exception'receipt_query_forbidden'using errcode='42501';end if;
 if a.id<>p_expected_attempt_id then raise exception'receipt_query_source_conflict'using errcode='40001';end if;
 perform erp_fiscal_reviewed_authorization.require_profile(a);perform erp_fiscal_authorization.source(p_user_id,a.candidate_id,a.signed_hash);
 select coalesce(jsonb_agg(erp_fiscal_receipt_query.view(q)order by q.ordinal desc),'[]'),min(q.ordinal)into items,cursor from(select *from erp_fiscal_receipt_query.query where authorization_attempt_id=a.id and(p_before is null or ordinal<p_before)order by ordinal desc limit p_limit)q;
 if not exists(select 1 from erp_fiscal_receipt_query.query where authorization_attempt_id=a.id and ordinal<cursor)then cursor:=null;end if;
 return erp_fiscal_receipt_query.flags()||jsonb_build_object('read_only',true,'authorization_command_id',a.command_id,'authorization_attempt_id',a.id,'observed_at',clock_timestamp(),
 'chain_hash',erp_fiscal_wsdl.hash(erp_fiscal_receipt_query.chain(a.id)),'resolution',erp_fiscal_receipt_query.resolution(a.id),'items',items,'next_before',cursor,'limit',p_limit);
end$$;
revoke all on all functions in schema erp_fiscal_receipt_query from public,anon,authenticated,service_role;
do $$declare p regprocedure;begin for p in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname like 'erp_fiscal_receipt_query_%'loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',p);execute format('grant execute on function %s to service_role',p);
end loop;end$$;
commit;
