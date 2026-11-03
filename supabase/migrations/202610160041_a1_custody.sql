-- A1 custody metadata and fenced upload reservations. No key, PFX, password or KEK in SQL.
-- Ciphertext bytes live in a separate private bucket; runtime verifies AEAD/hash before finalize.
begin;
create schema erp_a1;
revoke all on schema erp_a1 from public,anon,authenticated,service_role;
create table erp_a1.installation(singleton boolean primary key default true check(singleton),vault_id uuid not null unique default gen_random_uuid());
insert into erp_a1.installation(singleton) values(true);
create table erp_a1.credential(id uuid primary key,context jsonb not null,metadata jsonb not null,created_at timestamptz not null default clock_timestamp(),actor uuid not null references auth.users(id));
create table erp_a1.sealed_object(hash text primary key check(hash~'^[a-f0-9]{64}$'),credential_id uuid not null references erp_a1.credential(id),size_bytes integer not null check(size_bytes between 1 and 1500000),key_id text not null check(key_id~'^[A-Za-z0-9_-]{1,64}$'),created_at timestamptz not null default clock_timestamp(),unique(credential_id,hash));
create table erp_a1.head(singleton boolean primary key default true check(singleton),version integer not null default 0 check(version>=0),credential_id uuid,object_hash text,updated_at timestamptz not null default clock_timestamp(),check((credential_id is null)=(object_hash is null)),foreign key(credential_id,object_hash) references erp_a1.sealed_object(credential_id,hash));
insert into erp_a1.head(singleton)values(true);
create table erp_a1.command(command_id uuid primary key,actor uuid not null references auth.users(id),action text not null check(action in('configure','rewrap','disable')),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),expected_version integer not null check(expected_version>=0),expected_identity_version integer,reason text not null,
 credential_id uuid,context jsonb not null,source_object_hash text references erp_a1.sealed_object(hash),state text not null check(state in('pending','committed','rejected')),lease_id uuid,lease_until timestamptz,finalize_hash text,result jsonb,error_code text,created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 check((state='pending' and lease_id is not null and lease_until is not null and result is null and error_code is null and finished_at is null)or(state='committed' and result is not null and error_code is null and finished_at is not null)or(state='rejected' and result is null and error_code is not null and finished_at is not null)));
create table erp_a1.nonce(nonce uuid primary key,actor uuid not null references auth.users(id),action text not null,issued_at timestamptz not null,created_at timestamptz not null default clock_timestamp());
create table erp_a1.audit(id bigint generated always as identity primary key,command_id uuid not null references erp_a1.command(command_id),actor uuid not null references auth.users(id),action text not null,reason text not null,before_data jsonb not null,after_data jsonb not null,created_at timestamptz not null default clock_timestamp());
alter table erp_a1.installation enable row level security;
alter table erp_a1.credential enable row level security;
alter table erp_a1.sealed_object enable row level security;
alter table erp_a1.head enable row level security;
alter table erp_a1.command enable row level security;
alter table erp_a1.nonce enable row level security;
alter table erp_a1.audit enable row level security;
revoke all on all tables in schema erp_a1 from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_a1 from public,anon,authenticated,service_role;
alter default privileges in schema erp_a1 revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_a1 revoke all on functions from public,anon,authenticated,service_role;
do $$begin if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'a1_storage_rls_required'using errcode='55000';end if;end$$;
create policy erp_a1_runtime_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'brufap-a1-vault')with check(bucket_id<>'brufap-a1-vault');

create function erp_a1.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'a1_history_immutable'using errcode='42501';end$$;
create trigger immutable_installation before update or delete on erp_a1.installation for each row execute function erp_a1.immutable();
create trigger immutable_credential before update or delete on erp_a1.credential for each row execute function erp_a1.immutable();
create trigger immutable_object before update or delete on erp_a1.sealed_object for each row execute function erp_a1.immutable();
create trigger immutable_nonce before update or delete on erp_a1.nonce for each row execute function erp_a1.immutable();
create trigger immutable_audit before update or delete on erp_a1.audit for each row execute function erp_a1.immutable();
create function erp_a1.guard_command()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or old.state<>'pending' or (to_jsonb(new)-array['state','lease_id','lease_until','finalize_hash','result','error_code','finished_at'])is distinct from(to_jsonb(old)-array['state','lease_id','lease_until','finalize_hash','result','error_code','finished_at'])then raise exception 'a1_command_immutable'using errcode='42501';end if;return new;end$$;
create trigger guard_command before update or delete on erp_a1.command for each row execute function erp_a1.guard_command();
create function erp_a1.guard_head()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE' or new.singleton is distinct from old.singleton or old.version=2147483647 or new.version<>old.version+1 then raise exception 'a1_head_conflict'using errcode='40001';end if;return new;end$$;
create trigger guard_head before update or delete on erp_a1.head for each row execute function erp_a1.guard_head();
create function erp_a1.access(actor uuid,admin_only boolean default false)returns text language plpgsql stable set search_path=pg_catalog as $$declare r text;begin
 select role into r from erp_access.membership where user_id=actor and active;if r is null or r not in('admin','fiscal')or(admin_only and r<>'admin')then raise exception 'a1_access_denied'using errcode='42501';end if;return r;end$$;
create function erp_a1.lock_admin(actor uuid)returns void language plpgsql set search_path=pg_catalog as $$begin
 perform 1 from erp_access.membership where user_id=actor and active and role='admin'for share;if not found then raise exception 'a1_access_denied'using errcode='42501';end if;end$$;
create function erp_a1.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object('data_mode','a1_custody','environment','2','purpose','offline-homologation','can_emit',false,'can_transmit',false)$$;
create function erp_a1.current()returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare h erp_a1.head;c erp_a1.credential;identity_version integer;cnpj text;begin
 select *into h from erp_a1.head where singleton;select *into c from erp_a1.credential where id=h.credential_id;select version,data->>'cnpj'into identity_version,cnpj from erp_company.identity where singleton;
 return jsonb_build_object('version',h.version,'state',case when h.version=0 then'unconfigured'when h.credential_id is null then'disabled'else'configured_offline'end,'credential_id',h.credential_id,'company_identity_version',c.context->'company_identity_version','metadata',c.metadata,
 'company_changed',h.credential_id is not null and(identity_version is distinct from(c.context->>'company_identity_version')::integer or cnpj is distinct from c.context->>'holder_cnpj'),
 'time_valid_now',h.credential_id is not null and clock_timestamp()between(c.metadata->>'not_before')::timestamptz and(c.metadata->>'not_after')::timestamptz);end$$;
create function erp_a1.company()returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object('identity_version',version,'cnpj',data->'cnpj')from erp_company.identity where singleton$$;
create function erp_a1.reason_valid(v text)returns boolean language plpgsql immutable set search_path=pg_catalog as $$declare spaces text:=' ';i integer;begin
 if v is null or length(v)<3 or length(v)>240 or v~'[[:cntrl:]]'then return false;end if;
 foreach i in array array[160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]loop spaces:=spaces||chr(i);end loop;return translate(v,spaces,'')<>'';end$$;
create function erp_a1.exact(v jsonb,keys text[])returns boolean language sql immutable set search_path=pg_catalog as $$select case when jsonb_typeof(v)='object'then(select count(*)=cardinality(keys)and bool_and(k=any(keys))from jsonb_object_keys(v)k)else false end$$;
create function erp_a1.iso(v jsonb)returns boolean language plpgsql immutable set search_path=pg_catalog as $$declare t text;d timestamptz;begin
 if jsonb_typeof(v)is distinct from'string'then return false;end if;t:=v#>>'{}';if t!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'then return false;end if;
 begin d:=t::timestamptz;exception when others then return false;end;return to_char(d at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t;end$$;
create function erp_a1.validate_metadata(v jsonb,ctx jsonb)returns void language plpgsql immutable set search_path=pg_catalog as $$declare k text;begin
 if not erp_a1.exact(v,array['profile','legacy_provider_enabled','pfx_mac','pfx_mac_iterations','fingerprint_sha256','holder_cnpj','not_before','not_after','rsa_bits','presented_chain','validated_at','key_matches_certificate','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'])or octet_length(v::text)>16384 then raise exception 'a1_metadata_invalid'using errcode='22023';end if;
 if v->'profile'is distinct from'"openssl3-pkcs12"'::jsonb or jsonb_typeof(v->'legacy_provider_enabled')is distinct from'boolean'or jsonb_typeof(v->'pfx_mac')is distinct from'string'or v->>'pfx_mac'not in('sha1','sha224','sha256','sha384','sha512')
  or jsonb_typeof(v->'pfx_mac_iterations')is distinct from'number'or(v->>'pfx_mac_iterations')::numeric not between 1 and 1000000 or trunc((v->>'pfx_mac_iterations')::numeric)<>(v->>'pfx_mac_iterations')::numeric
  or jsonb_typeof(v->'fingerprint_sha256')is distinct from'string'or v->>'fingerprint_sha256'!~'^[a-f0-9]{64}$'or v->'holder_cnpj'is distinct from ctx->'holder_cnpj'
  or v->'rsa_bits'not in('2048'::jsonb,'3072'::jsonb,'4096'::jsonb)then raise exception 'a1_metadata_invalid'using errcode='22023';end if;
 foreach k in array array['not_before','not_after','validated_at']loop if not erp_a1.iso(v->k)then raise exception 'a1_metadata_invalid'using errcode='22023';end if;end loop;
 if v->>'not_before'>v->>'validated_at'or v->>'validated_at'>v->>'not_after'or jsonb_typeof(v->'presented_chain')is distinct from'array'then raise exception 'a1_metadata_invalid'using errcode='22023';end if;
 if jsonb_array_length(v->'presented_chain')not between 1 and 10 or v#>'{presented_chain,0}'is distinct from v->'fingerprint_sha256'or exists(select 1 from jsonb_array_elements(v->'presented_chain')e where jsonb_typeof(e)<>'string'or e#>>'{}'!~'^[a-f0-9]{64}$')or(select count(*)<>count(distinct value)from jsonb_array_elements(v->'presented_chain'))then raise exception 'a1_metadata_invalid'using errcode='22023';end if;
 foreach k in array array['key_matches_certificate','presented_chain_links_checked']loop if v->k is distinct from'true'::jsonb then raise exception 'a1_metadata_invalid'using errcode='22023';end if;end loop;
 foreach k in array array['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit']loop if v->k is distinct from'false'::jsonb then raise exception 'a1_metadata_invalid'using errcode='22023';end if;end loop;
end$$;
create function erp_a1.storage_check(credential uuid,hash text,size integer)returns void language plpgsql set search_path=pg_catalog as $$declare path text;begin
 if credential is null or hash is null or hash!~'^[a-f0-9]{64}$'or size is null or size not between 1 and 1500000 then raise exception 'a1_object_invalid'using errcode='22023';end if;
 path:='credentials/'||credential::text||'/'||hash||'.json';
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'a1_private_object_required'using errcode='40001';end if;
 perform 1 from storage.buckets where id='brufap-a1-vault'and name='brufap-a1-vault'and public=false and file_size_limit=1500000 and allowed_mime_types=array['application/json']::text[]for share;
 if not found then raise exception 'a1_private_object_required'using errcode='40001';end if;
 perform 1 from storage.objects where bucket_id='brufap-a1-vault'and name=path and metadata->>'size'=size::text and metadata->>'mimetype'='application/json'for share;
 if not found then raise exception 'a1_private_object_required'using errcode='40001';end if;
end$$;
create function erp_a1.receipt(command uuid,action text,at timestamptz)returns jsonb language sql stable set search_path=pg_catalog as $$select(erp_a1.current()-array['company_changed','time_valid_now'])||jsonb_build_object('command_id',command,'action',action,'recorded_at',at)$$;
create function erp_a1.command_view(c erp_a1.command,replayed boolean default true)returns jsonb language sql stable set search_path=pg_catalog as $$select erp_a1.flags()||jsonb_build_object('state',c.state,'receipt',c.result,'error_code',c.error_code,'current',erp_a1.current(),'replayed',replayed)$$;

-- The company mutex serializes identity edits with every custody transition.
-- Membership is rechecked and locked before replay as well as a new mutation.
create function erp_a1.locks(actor uuid,command uuid)returns void language plpgsql set search_path=pg_catalog as $$begin
 perform erp_a1.access(actor,true);
 if command is null then raise exception 'a1_command_required'using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852941,hashtext(command::text));
 perform pg_advisory_xact_lock(174852920,1);
 perform erp_a1.lock_admin(actor);
 perform 1 from erp_a1.head where singleton for update;
end$$;
create function erp_a1.command_input(tag text,expected integer,reason text)returns void language plpgsql immutable set search_path=pg_catalog as $$begin
 if tag is null or tag!~'^[a-f0-9]{64}$'or expected is null or expected<0 or not erp_a1.reason_valid(reason)then raise exception 'a1_command_invalid'using errcode='22023';end if;
end$$;
create function erp_a1.check_pending(c erp_a1.command)returns void language plpgsql stable set search_path=pg_catalog as $$declare h erp_a1.head;co jsonb;begin
 select *into h from erp_a1.head where singleton;co:=erp_a1.company();
 if h.version<>c.expected_version or h.version=2147483647 or co is null or(co->>'identity_version')::integer is distinct from c.expected_identity_version then raise exception 'a1_context_changed'using errcode='40001';end if;
 if c.action='configure'and(c.context->>'holder_cnpj'is distinct from co->>'cnpj'or(c.context->>'company_identity_version')::integer is distinct from c.expected_identity_version)then raise exception 'a1_context_changed'using errcode='40001';end if;
 if c.action='rewrap'and(h.credential_id is distinct from c.credential_id or h.object_hash is distinct from c.source_object_hash)then raise exception 'a1_context_changed'using errcode='40001';end if;
end$$;

create function public.erp_a1_authorize(p_user_id uuid,p_action text,p_nonce uuid,p_issued_at timestamptz)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare co jsonb;begin
 if p_action is null or p_action not in('configure','rewrap','disable','metadata','command')then raise exception 'a1_action_invalid'using errcode='22023';end if;
 perform erp_a1.access(p_user_id,p_action<>'metadata');
 if p_nonce is null or p_issued_at is null or not isfinite(p_issued_at)or p_issued_at<clock_timestamp()-interval'60 seconds'or p_issued_at>clock_timestamp()+interval'5 seconds'then raise exception 'a1_request_expired'using errcode='22023';end if;
 co:=erp_a1.company();if p_action in('configure','rewrap')and co is null then raise exception 'a1_company_required'using errcode='40001';end if;
 begin insert into erp_a1.nonce(nonce,actor,action,issued_at)values(p_nonce,p_user_id,p_action,p_issued_at);exception when unique_violation then raise exception 'a1_nonce_reused'using errcode='40001';end;
 return erp_a1.flags()||jsonb_build_object('vault_id',(select vault_id from erp_a1.installation where singleton),'company',co,'current',erp_a1.current());
end$$;
create function public.erp_a1_metadata(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_a1.access(p_user_id,false);return erp_a1.flags()||jsonb_build_object('current',erp_a1.current());end$$;

create function public.erp_a1_reserve(p_user_id uuid,p_command_id uuid,p_request_hash text,p_action text,p_expected_version integer,p_expected_identity_version integer,p_reason text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_a1.command;h erp_a1.head;cred erp_a1.credential;obj erp_a1.sealed_object;co jsonb;ctx jsonb;cid uuid;token uuid;until_at timestamptz;source jsonb;begin
 perform erp_a1.locks(p_user_id,p_command_id);perform erp_a1.command_input(p_request_hash,p_expected_version,p_reason);
 if p_action is null or p_action not in('configure','rewrap')or p_expected_identity_version is null or p_expected_identity_version<1 then raise exception 'a1_reservation_invalid'using errcode='22023';end if;
 select *into c from erp_a1.command where command_id=p_command_id for update;
 if found then
  if c.actor<>p_user_id or c.action<>p_action or c.request_hash<>p_request_hash or c.expected_version<>p_expected_version or c.expected_identity_version is distinct from p_expected_identity_version or c.reason<>p_reason then raise exception 'a1_command_conflict'using errcode='40001';end if;
  if c.state<>'pending'then return erp_a1.command_view(c,true);end if;
  perform erp_a1.check_pending(c);
  if c.lease_until>clock_timestamp()then raise exception 'a1_reservation_busy'using errcode='40001';end if;
  update erp_a1.command set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval'60 seconds'where command_id=p_command_id returning *into c;
 else
  select *into h from erp_a1.head where singleton;co:=erp_a1.company();
  if h.version<>p_expected_version or h.version=2147483647 or co is null or(co->>'identity_version')::integer<>p_expected_identity_version then raise exception 'a1_context_changed'using errcode='40001';end if;
  if p_action='configure'then
   cid:=gen_random_uuid();ctx:=jsonb_build_object('vault_id',(select vault_id from erp_a1.installation where singleton),'credential_id',cid,'credential_version',1,'company_identity_version',p_expected_identity_version,'holder_cnpj',co->'cnpj','environment','2','purpose','offline-homologation');
  else
   if h.credential_id is null then raise exception 'a1_credential_required'using errcode='40001';end if;
   select *into cred from erp_a1.credential where id=h.credential_id;cid:=cred.id;ctx:=cred.context;
  end if;
  insert into erp_a1.command(command_id,actor,action,request_hash,expected_version,expected_identity_version,reason,credential_id,context,source_object_hash,state,lease_id,lease_until)
   values(p_command_id,p_user_id,p_action,p_request_hash,p_expected_version,p_expected_identity_version,p_reason,cid,ctx,case when p_action='rewrap'then h.object_hash end,'pending',gen_random_uuid(),clock_timestamp()+interval'60 seconds')returning *into c;
 end if;
 source:=null;
 if c.action='rewrap'then
  select *into cred from erp_a1.credential where id=c.credential_id;select *into obj from erp_a1.sealed_object where hash=c.source_object_hash;
  source:=jsonb_build_object('bucket','brufap-a1-vault','path','credentials/'||c.credential_id::text||'/'||obj.hash||'.json','hash',obj.hash,'size',obj.size_bytes,'key_id',obj.key_id);
 end if;
 return erp_a1.flags()||jsonb_build_object('state','reserved','lease_id',c.lease_id,'lease_until',c.lease_until,'credential_id',c.credential_id,'context',c.context,'metadata',cred.metadata,'source_object',source,'current',erp_a1.current());
end$$;

create function public.erp_a1_finalize(p_user_id uuid,p_command_id uuid,p_lease_id uuid,p_metadata jsonb,p_object_hash text,p_size_bytes integer,p_key_id text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_a1.command;cred erp_a1.credential;obj erp_a1.sealed_object;tag text;before_data jsonb;v_result jsonb;at timestamptz;begin
 perform erp_a1.locks(p_user_id,p_command_id);
 if p_lease_id is null or p_metadata is null or p_object_hash is null or p_object_hash!~'^[a-f0-9]{64}$'or p_size_bytes is null or p_size_bytes not between 1 and 1500000 or p_key_id is null or p_key_id!~'^[A-Za-z0-9_-]{1,64}$'then raise exception 'a1_finalize_invalid'using errcode='22023';end if;
 select *into c from erp_a1.command where command_id=p_command_id for update;
 if not found or c.actor<>p_user_id then raise exception 'a1_command_unavailable'using errcode='42501';end if;
 tag:=encode(sha256(convert_to(jsonb_build_object('lease',p_lease_id,'metadata',p_metadata,'hash',p_object_hash,'size',p_size_bytes,'key_id',p_key_id)::text,'UTF8')),'hex');
 if c.state='committed'then
  if c.action not in('configure','rewrap')or c.lease_id is distinct from p_lease_id or c.finalize_hash is distinct from tag then raise exception 'a1_finalize_conflict'using errcode='40001';end if;
  return erp_a1.command_view(c,true);
 end if;
 if c.state<>'pending'or c.lease_id<>p_lease_id or c.lease_until<=clock_timestamp()then raise exception 'a1_lease_lost'using errcode='40001';end if;
 perform erp_a1.check_pending(c);perform erp_a1.validate_metadata(p_metadata,c.context);
 if c.action='configure'then
  if(p_metadata->>'validated_at')::timestamptz<clock_timestamp()-interval'120 seconds'or(p_metadata->>'validated_at')::timestamptz>clock_timestamp()+interval'5 seconds'or clock_timestamp()not between(p_metadata->>'not_before')::timestamptz and(p_metadata->>'not_after')::timestamptz then raise exception 'a1_validation_stale'using errcode='40001';end if;
 else
  select *into cred from erp_a1.credential where id=c.credential_id;select *into obj from erp_a1.sealed_object where hash=c.source_object_hash;
  if p_metadata is distinct from cred.metadata or c.context is distinct from cred.context or p_key_id=obj.key_id then raise exception 'a1_rewrap_mismatch'using errcode='40001';end if;
 end if;
 perform erp_a1.storage_check(c.credential_id,p_object_hash,p_size_bytes);
 before_data:=erp_a1.current();at:=clock_timestamp();
 if c.lease_until<=at then raise exception 'a1_lease_lost'using errcode='40001';end if;
 if c.action='configure'then insert into erp_a1.credential(id,context,metadata,actor)values(c.credential_id,c.context,p_metadata,p_user_id);end if;
 insert into erp_a1.sealed_object(hash,credential_id,size_bytes,key_id)values(p_object_hash,c.credential_id,p_size_bytes,p_key_id)on conflict(hash)do nothing;
 if not exists(select 1 from erp_a1.sealed_object where hash=p_object_hash and credential_id=c.credential_id and size_bytes=p_size_bytes and key_id=p_key_id)then raise exception 'a1_object_conflict'using errcode='40001';end if;
 update erp_a1.head set version=version+1,credential_id=c.credential_id,object_hash=p_object_hash,updated_at=at where singleton;
 v_result:=erp_a1.receipt(p_command_id,c.action,at);
 update erp_a1.command set state='committed',finalize_hash=tag,result=v_result,finished_at=at where command_id=p_command_id returning *into c;
 insert into erp_a1.audit(command_id,actor,action,reason,before_data,after_data)values(p_command_id,p_user_id,c.action,c.reason,before_data,v_result);
 if c.lease_until<=clock_timestamp()then raise exception 'a1_lease_lost'using errcode='40001';end if;
 return erp_a1.command_view(c,false);
end$$;

create function public.erp_a1_reject(p_user_id uuid,p_command_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare c erp_a1.command;now_data jsonb;begin
 perform erp_a1.locks(p_user_id,p_command_id);
 if p_lease_id is null or p_error_code is null or p_error_code not in('CREDENTIAL_INPUT_INVALID','CERTIFICATE_REJECTED','CERTIFICATE_EXPIRED','HOLDER_MISMATCH','UNSUPPORTED_PROFILE','ENVELOPE_INVALID','STORAGE_VALIDATION_FAILED')then raise exception 'a1_rejection_invalid'using errcode='22023';end if;
 select *into c from erp_a1.command where command_id=p_command_id for update;
 if not found or c.actor<>p_user_id then raise exception 'a1_command_unavailable'using errcode='42501';end if;
 if c.state='rejected'and c.lease_id=p_lease_id and c.error_code=p_error_code then return erp_a1.command_view(c,true);end if;
 if c.state<>'pending'or c.lease_id<>p_lease_id or c.lease_until<=clock_timestamp()then raise exception 'a1_lease_lost'using errcode='40001';end if;
 now_data:=erp_a1.current();update erp_a1.command set state='rejected',error_code=p_error_code,finished_at=clock_timestamp()where command_id=p_command_id returning *into c;
 insert into erp_a1.audit(command_id,actor,action,reason,before_data,after_data)values(p_command_id,p_user_id,'reject',c.reason,now_data,now_data||jsonb_build_object('error_code',p_error_code));
 return erp_a1.command_view(c,false);
end$$;

create function public.erp_a1_disable(p_user_id uuid,p_command_id uuid,p_request_hash text,p_expected_version integer,p_reason text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare c erp_a1.command;h erp_a1.head;ctx jsonb;before_data jsonb;result jsonb;at timestamptz;begin
 perform erp_a1.locks(p_user_id,p_command_id);perform erp_a1.command_input(p_request_hash,p_expected_version,p_reason);
 select *into c from erp_a1.command where command_id=p_command_id for update;
 if found then
  if c.actor<>p_user_id or c.action<>'disable'or c.request_hash<>p_request_hash or c.expected_version<>p_expected_version or c.reason<>p_reason then raise exception 'a1_command_conflict'using errcode='40001';end if;
  return erp_a1.command_view(c,true);
 end if;
 select *into h from erp_a1.head where singleton;
 if h.version<>p_expected_version or h.version=2147483647 or h.credential_id is null then raise exception 'a1_context_changed'using errcode='40001';end if;
 select context into ctx from erp_a1.credential where id=h.credential_id;before_data:=erp_a1.current();at:=clock_timestamp();
 update erp_a1.head set version=version+1,credential_id=null,object_hash=null,updated_at=at where singleton;result:=erp_a1.receipt(p_command_id,'disable',at);
 insert into erp_a1.command(command_id,actor,action,request_hash,expected_version,reason,credential_id,context,source_object_hash,state,result,finished_at)values(p_command_id,p_user_id,'disable',p_request_hash,p_expected_version,p_reason,h.credential_id,ctx,h.object_hash,'committed',result,at)returning *into c;
 insert into erp_a1.audit(command_id,actor,action,reason,before_data,after_data)values(p_command_id,p_user_id,'disable',p_reason,before_data,result);
 return erp_a1.command_view(c,false);
end$$;

create function public.erp_a1_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_a1.command;begin
 perform erp_a1.access(p_user_id,true);select *into c from erp_a1.command where command_id=p_command_id and actor=p_user_id;
 if not found then raise exception 'a1_command_unavailable'using errcode='42501';end if;return erp_a1.command_view(c,true);
end$$;

revoke all on all functions in schema erp_a1 from public,anon,authenticated,service_role;
revoke all on function public.erp_a1_authorize(uuid,text,uuid,timestamptz),public.erp_a1_metadata(uuid),public.erp_a1_reserve(uuid,uuid,text,text,integer,integer,text),public.erp_a1_finalize(uuid,uuid,uuid,jsonb,text,integer,text),public.erp_a1_reject(uuid,uuid,uuid,text),public.erp_a1_disable(uuid,uuid,text,integer,text),public.erp_a1_command(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_a1_authorize(uuid,text,uuid,timestamptz),public.erp_a1_metadata(uuid),public.erp_a1_reserve(uuid,uuid,text,text,integer,integer,text),public.erp_a1_finalize(uuid,uuid,uuid,jsonb,text,integer,text),public.erp_a1_reject(uuid,uuid,uuid,text),public.erp_a1_disable(uuid,uuid,text,integer,text),public.erp_a1_command(uuid,uuid)to service_role;
commit;
