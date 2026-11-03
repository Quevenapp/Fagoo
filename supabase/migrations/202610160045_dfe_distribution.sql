-- NF-e55 distribution persistence only. No SEFAZ transport or manifestation is enabled.
-- Trusted runtime must validate the original response and verify immutable Storage bytes.
begin;
create schema erp_dfe;
revoke all on schema erp_dfe from public,anon,authenticated,service_role;
create table erp_dfe.channel(
 id uuid primary key default gen_random_uuid(),cnpj text not null,environment text not null check(environment in('1','2')),
 identity_version integer not null check(identity_version>0),author_uf text not null,version integer not null check(version>0),
 coordinator text not null check(coordinator in('unconfirmed','external','brufap')),other_consumers_reviewed boolean not null,
 checkpoint text check(checkpoint~'^[0-9]{15}$'),checkpoint_confirmed boolean not null,collection_requested boolean not null,
 paused boolean not null default false,active_attempt uuid,not_before timestamptz,updated_at timestamptz not null default clock_timestamp(),
 unique(cnpj,environment),check(not checkpoint_confirmed or checkpoint is not null)
);
create table erp_dfe.command(id uuid primary key,actor uuid not null references auth.users(id),action text not null check(action in('configure','collect','abandon')),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),channel_id uuid not null references erp_dfe.channel(id),result jsonb,created_at timestamptz not null default clock_timestamp());
create table erp_dfe.attempt(
 id uuid primary key references erp_dfe.command(id),channel_id uuid not null references erp_dfe.channel(id),actor uuid not null references auth.users(id),
 channel_version integer not null,identity_version integer not null,request_nsu text not null check(request_nsu~'^[0-9]{15}$'),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 state text not null check(state in('reserved','dispatched','uncertain','stored','review','abandoned')),
 lease_id uuid not null,lease_until timestamptz not null,lease_started_at timestamptz not null,recovery_only boolean not null default false,
 dispatched_at timestamptz,error_code text,manifest_hash text,manifest jsonb,response_hash text,result jsonb,
 created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 check((state in('reserved','dispatched','uncertain')and finished_at is null and result is null)or(state in('stored','review','abandoned')and finished_at is not null and result is not null)),
 check(state not in('dispatched','uncertain','stored','review')or dispatched_at is not null)
);
alter table erp_dfe.channel add constraint dfe_active_attempt_fk foreign key(active_attempt)references erp_dfe.attempt(id);
create unique index dfe_one_active on erp_dfe.attempt(channel_id)where state in('reserved','dispatched','uncertain');
create table erp_dfe.object(hash text primary key check(hash~'^[a-f0-9]{64}$'),size_bytes integer not null check(size_bytes between 1 and 8388608),created_at timestamptz not null default clock_timestamp());
create table erp_dfe.document(
 id uuid primary key default gen_random_uuid(),channel_id uuid not null references erp_dfe.channel(id),nsu text check(nsu~'^[0-9]{15}$'),
 object_hash text not null references erp_dfe.object(hash),schema_name text not null,kind text not null check(kind in('invoice_summary','invoice','event_summary','event','unsupported')),
 access_key text,recipient_match boolean,quarantined boolean not null,first_attempt uuid not null references erp_dfe.attempt(id),created_at timestamptz not null default clock_timestamp(),
 unique(channel_id,nsu),check((kind='unsupported'and quarantined and access_key is null and recipient_match is null)or(kind<>'unsupported'and not quarantined and access_key is not null)),
 check(kind='invoice'or recipient_match is null)
);
create unique index dfe_missing_nsu_bytes on erp_dfe.document(channel_id,object_hash,schema_name)where nsu is null;
create table erp_dfe.attempt_document(attempt_id uuid not null references erp_dfe.attempt(id),position integer not null check(position between 1 and 50),document_id uuid not null references erp_dfe.document(id),compressed_hash text not null check(compressed_hash~'^[a-f0-9]{64}$'),primary key(attempt_id,position));
create table erp_dfe.audit(id bigint generated always as identity primary key,command_id uuid not null references erp_dfe.command(id),actor uuid not null references auth.users(id),action text not null,reason text,details jsonb not null,created_at timestamptz not null default clock_timestamp());
alter table erp_dfe.channel enable row level security;
alter table erp_dfe.command enable row level security;
alter table erp_dfe.attempt enable row level security;
alter table erp_dfe.object enable row level security;
alter table erp_dfe.document enable row level security;
alter table erp_dfe.attempt_document enable row level security;
alter table erp_dfe.audit enable row level security;
revoke all on all tables in schema erp_dfe from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_dfe from public,anon,authenticated,service_role;
alter default privileges in schema erp_dfe revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_dfe revoke all on functions from public,anon,authenticated,service_role;
do $$begin if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'dfe_storage_rls_required'using errcode='55000';end if;end$$;
create policy erp_dfe_runtime_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'brufap-received-dfe')with check(bucket_id<>'brufap-received-dfe');

create function erp_dfe.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'dfe_history_immutable'using errcode='42501';end$$;
create trigger dfe_object_immutable before update or delete on erp_dfe.object for each row execute function erp_dfe.immutable();
create trigger dfe_document_immutable before update or delete on erp_dfe.document for each row execute function erp_dfe.immutable();
create trigger dfe_observation_immutable before update or delete on erp_dfe.attempt_document for each row execute function erp_dfe.immutable();
create trigger dfe_audit_immutable before update or delete on erp_dfe.audit for each row execute function erp_dfe.immutable();
create function erp_dfe.guard_attempt()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE'or old.state in('stored','review','abandoned')or(to_jsonb(new)-array['state','lease_id','lease_until','lease_started_at','recovery_only','dispatched_at','error_code','manifest_hash','manifest','response_hash','result','finished_at'])is distinct from(to_jsonb(old)-array['state','lease_id','lease_until','lease_started_at','recovery_only','dispatched_at','error_code','manifest_hash','manifest','response_hash','result','finished_at'])then raise exception 'dfe_attempt_immutable'using errcode='42501';end if;return new;
end$$;
create trigger dfe_attempt_guard before update or delete on erp_dfe.attempt for each row execute function erp_dfe.guard_attempt();
create function erp_dfe.guard_command()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if tg_op='DELETE'or old.result is not null or new.result is null or(to_jsonb(new)-'result')is distinct from(to_jsonb(old)-'result')then raise exception 'dfe_command_immutable'using errcode='42501';end if;return new;
end$$;
create trigger dfe_command_guard before update or delete on erp_dfe.command for each row execute function erp_dfe.guard_command();
create function erp_dfe.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object('data_mode','received_dfe','model','55','transport_enabled',false,'can_query',false,'can_manifest',false,'can_emit',false,'origin_authenticated',false,'signature_verified',false,'xsd_validated',false,'sefaz_authorized',false,'financial_mutation_performed',false,'stock_mutation_performed',false)$$;
create function erp_dfe.access(actor uuid,operation text)returns text language plpgsql stable set search_path=pg_catalog as $$declare r text;begin
 select role into r from erp_access.membership where user_id=actor and active;
 if r is null or operation not in('read','operate','admin')or r not in('admin','fiscal','consulta')or(operation='operate'and r='consulta')or(operation='admin'and r<>'admin')then raise exception 'dfe_access_denied'using errcode='42501';end if;return r;
end$$;
create function erp_dfe.hash(v jsonb)returns text language sql immutable set search_path=pg_catalog as $$select encode(sha256(convert_to(v::text,'UTF8')),'hex')$$;
create function erp_dfe.lock(actor uuid,command uuid,operation text)returns void language plpgsql set search_path=pg_catalog as $$begin
 perform erp_dfe.access(actor,operation);if command is null then raise exception 'dfe_command_required'using errcode='22023';end if;
 perform pg_advisory_xact_lock(174852945,hashtext(command::text));
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_access.membership where user_id=actor and active for share;perform erp_dfe.access(actor,operation);
end$$;
create function erp_dfe.check_company(c erp_dfe.channel,strict_version boolean default false)returns void language plpgsql stable set search_path=pg_catalog as $$declare co erp_company.identity;begin
 select *into co from erp_company.identity where singleton;
 if co.data->>'cnpj'is distinct from c.cnpj then raise exception 'dfe_company_unavailable'using errcode='42501';end if;
 if strict_version and(co.version<>c.identity_version or left(co.data->>'municipality_code',2)<>c.author_uf)then raise exception 'dfe_company_changed'using errcode='40001';end if;
end$$;
create function erp_dfe.channel_json(c erp_dfe.channel)returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object('id',c.id,'environment',c.environment,'identity_version',c.identity_version,'version',c.version,'coordinator',c.coordinator,'other_consumers_reviewed',c.other_consumers_reviewed,'checkpoint',c.checkpoint,'checkpoint_confirmed',c.checkpoint_confirmed,'collection_requested',c.collection_requested,'paused',c.paused,'active_attempt_id',c.active_attempt,'not_before',c.not_before,'updated_at',c.updated_at,'company_changed',not exists(select 1 from erp_company.identity i where i.singleton and i.version=c.identity_version and i.data->>'cnpj'=c.cnpj))$$;
create function erp_dfe.command_view(cmd erp_dfe.command,replayed boolean)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare c erp_dfe.channel;a erp_dfe.attempt;begin
 select *into c from erp_dfe.channel where id=cmd.channel_id;perform erp_dfe.check_company(c);select *into a from erp_dfe.attempt where id=cmd.id;
 return erp_dfe.flags()||jsonb_build_object('command_id',cmd.id,'action',cmd.action,'state',coalesce(a.state,'committed'),'receipt',cmd.result,'current',erp_dfe.channel_json(c),'replayed',replayed);
end$$;
create function erp_dfe.bucket_check()returns void language plpgsql set search_path=pg_catalog as $$begin
 if not exists(select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)then raise exception 'dfe_storage_unavailable'using errcode='55000';end if;
 perform 1 from storage.buckets where id='brufap-received-dfe'and name='brufap-received-dfe'and public=false and file_size_limit=8388608 and allowed_mime_types=array['application/octet-stream']::text[]for share;
 if not found then raise exception 'dfe_storage_unavailable'using errcode='55000';end if;
end$$;
create function erp_dfe.storage_check(h text,size integer)returns void language plpgsql set search_path=pg_catalog as $$begin
 if h is null or h!~'^[a-f0-9]{64}$'or size is null or size not between 1 and 8388608 then raise exception 'dfe_object_invalid'using errcode='22023';end if;
 perform 1 from storage.objects where bucket_id='brufap-received-dfe'and name='objects/'||h||'.xml'and metadata->>'size'=size::text and metadata->>'mimetype'='application/octet-stream'for share;
 if not found then raise exception 'dfe_object_missing'using errcode='55000';end if;
end$$;
create function erp_dfe.request_hash(c erp_dfe.channel)returns text language sql immutable set search_path=pg_catalog as $$select encode(sha256(convert_to('<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>'||c.environment||'</tpAmb><cUFAutor>'||c.author_uf||'</cUFAutor><CNPJ>'||c.cnpj||'</CNPJ><distNSU><ultNSU>'||c.checkpoint||'</ultNSU></distNSU></distDFeInt>','UTF8')),'hex')$$;
create function erp_dfe.key55(k text)returns boolean language plpgsql immutable set search_path=pg_catalog as $$declare i integer;weight integer:=2;total integer:=0;dv integer;begin
 if k is null or k!~'^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$'or substring(k,21,2)<>'55'or substring(k,1,2)not in('11','12','13','14','15','16','17','21','22','23','24','25','26','27','28','29','31','32','33','35','41','42','43','50','51','52','53')or substring(k,5,2)::integer not between 1 and 12 or substring(k,26,9)::bigint=0 or substring(k,35,1)not in('1','2','4','5','6','7')then return false;end if;
 begin perform erp_company.cnpj(substring(k,7,14));exception when sqlstate '22023'then return false;end;
 for i in reverse 43..1 loop total:=total+(ascii(substr(k,i,1))-48)*weight;weight:=case when weight=9 then 2 else weight+1 end;end loop;dv:=case when total%11<2 then 0 else 11-total%11 end;return right(k,1)=dv::text;
end$$;

create function public.erp_dfe_settings(p_user_id uuid,p_environment text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_dfe.channel;begin
 perform erp_dfe.access(p_user_id,'read');if p_environment is null or p_environment not in('1','2')then raise exception 'dfe_environment_invalid'using errcode='22023';end if;
 select ch.*into c from erp_dfe.channel ch join erp_company.identity i on i.singleton and i.data->>'cnpj'=ch.cnpj where ch.environment=p_environment;
 return erp_dfe.flags()||jsonb_build_object('current',case when c.id is null then null else erp_dfe.channel_json(c)end);
end$$;

create function public.erp_dfe_configure(p_user_id uuid,p_command_id uuid,p_environment text,p_expected_version integer,p_expected_identity_version integer,p_coordinator text,p_checkpoint text,p_checkpoint_confirmed boolean,p_other_consumers_reviewed boolean,p_collection_requested boolean,p_reason text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_dfe.channel;co erp_company.identity;cmd erp_dfe.command;tag text;receipt jsonb;begin
 perform erp_dfe.lock(p_user_id,p_command_id,'admin');
 if p_environment is null or p_environment not in('1','2')or p_expected_version is null or p_expected_version<0 or p_expected_identity_version is null or p_expected_identity_version<1 or p_coordinator is null or p_coordinator not in('unconfirmed','external','brufap')or(p_checkpoint is not null and p_checkpoint!~'^[0-9]{15}$')or p_checkpoint_confirmed is null or p_other_consumers_reviewed is null or p_collection_requested is null or not erp_a1.reason_valid(p_reason)or(p_checkpoint_confirmed and p_checkpoint is null)or(p_collection_requested and(p_coordinator<>'brufap'or not p_checkpoint_confirmed or not p_other_consumers_reviewed))then raise exception 'dfe_configuration_invalid'using errcode='22023';end if;
 tag:=erp_dfe.hash(jsonb_build_array(p_environment,p_expected_version,p_expected_identity_version,p_coordinator,p_checkpoint,p_checkpoint_confirmed,p_other_consumers_reviewed,p_collection_requested,p_reason));
 select *into cmd from erp_dfe.command where id=p_command_id;
 if found then if cmd.actor<>p_user_id or cmd.action<>'configure'or cmd.request_hash<>tag then raise exception 'dfe_command_conflict'using errcode='40001';end if;return erp_dfe.command_view(cmd,true);end if;
 select *into co from erp_company.identity where singleton;
 if co.version is distinct from p_expected_identity_version then raise exception 'dfe_company_changed'using errcode='40001';end if;
 select *into c from erp_dfe.channel where cnpj=co.data->>'cnpj'and environment=p_environment for update;
 if found then
  if c.version<>p_expected_version or c.version=2147483647 or c.active_attempt is not null then raise exception 'dfe_context_changed'using errcode='40001';end if;
  if p_checkpoint is distinct from c.checkpoint and exists(select 1 from erp_dfe.attempt where channel_id=c.id)then raise exception 'dfe_checkpoint_rewrite_forbidden'using errcode='40001';end if;
  update erp_dfe.channel set identity_version=co.version,author_uf=left(co.data->>'municipality_code',2),version=version+1,coordinator=p_coordinator,checkpoint=p_checkpoint,checkpoint_confirmed=p_checkpoint_confirmed,other_consumers_reviewed=p_other_consumers_reviewed,collection_requested=p_collection_requested,paused=false,updated_at=clock_timestamp()where id=c.id returning *into c;
 else
  if p_expected_version<>0 then raise exception 'dfe_context_changed'using errcode='40001';end if;
  insert into erp_dfe.channel(cnpj,environment,identity_version,author_uf,version,coordinator,checkpoint,checkpoint_confirmed,other_consumers_reviewed,collection_requested)values(co.data->>'cnpj',p_environment,co.version,left(co.data->>'municipality_code',2),1,p_coordinator,p_checkpoint,p_checkpoint_confirmed,p_other_consumers_reviewed,p_collection_requested)returning *into c;
 end if;
 receipt:=erp_dfe.channel_json(c);insert into erp_dfe.command(id,actor,action,request_hash,channel_id,result)values(p_command_id,p_user_id,'configure',tag,c.id,receipt)returning *into cmd;
 insert into erp_dfe.audit(command_id,actor,action,reason,details)values(p_command_id,p_user_id,'configure',p_reason,receipt);
 return erp_dfe.command_view(cmd,false);
end$$;

create function erp_dfe.reservation(a erp_dfe.attempt,c erp_dfe.channel,replayed boolean)returns jsonb language sql stable set search_path=pg_catalog as $$select erp_dfe.flags()||jsonb_build_object('attempt_id',a.id,'state',a.state,'lease_id',a.lease_id,'lease_until',a.lease_until,'recovery_only',a.recovery_only,'request',jsonb_build_object('environment',c.environment,'authorUf',c.author_uf,'interestedCnpj',c.cnpj,'lastNsu',a.request_nsu),'request_hash',a.request_hash,'current',erp_dfe.channel_json(c),'replayed',replayed)$$;
create function public.erp_dfe_reserve(p_user_id uuid,p_command_id uuid,p_channel_id uuid,p_expected_version integer)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare c erp_dfe.channel;a erp_dfe.attempt;cmd erp_dfe.command;tag text;begin
 perform erp_dfe.lock(p_user_id,p_command_id,'operate');if p_channel_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'dfe_reservation_invalid'using errcode='22023';end if;
 tag:=erp_dfe.hash(jsonb_build_array(p_channel_id,p_expected_version));select *into c from erp_dfe.channel where id=p_channel_id for update;if not found then raise exception 'dfe_channel_missing'using errcode='P0002';end if;perform erp_dfe.check_company(c);
 select *into cmd from erp_dfe.command where id=p_command_id;
 if found then
  if cmd.actor<>p_user_id or cmd.action<>'collect'or cmd.channel_id<>p_channel_id or cmd.request_hash<>tag then raise exception 'dfe_command_conflict'using errcode='40001';end if;
  if cmd.result is not null then return erp_dfe.command_view(cmd,true);end if;
  select *into a from erp_dfe.attempt where id=p_command_id for update;
  if a.state='reserved'and a.lease_until<=clock_timestamp()then update erp_dfe.attempt set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval'120 seconds',lease_started_at=clock_timestamp()where id=a.id returning *into a;end if;
  return erp_dfe.reservation(a,c,true);
 end if;
 perform erp_dfe.check_company(c,true);perform erp_dfe.bucket_check();
 if c.version<>p_expected_version or c.version=2147483647 or c.active_attempt is not null or c.paused or not c.collection_requested or c.coordinator<>'brufap'or not c.checkpoint_confirmed or not c.other_consumers_reviewed or c.checkpoint is null or(c.not_before is not null and c.not_before>clock_timestamp())then raise exception 'dfe_collection_not_ready'using errcode='40001';end if;
 insert into erp_dfe.command(id,actor,action,request_hash,channel_id)values(p_command_id,p_user_id,'collect',tag,c.id);
 insert into erp_dfe.attempt(id,channel_id,actor,channel_version,identity_version,request_nsu,request_hash,state,lease_id,lease_until,lease_started_at)values(p_command_id,c.id,p_user_id,c.version,c.identity_version,c.checkpoint,erp_dfe.request_hash(c),'reserved',gen_random_uuid(),clock_timestamp()+interval'120 seconds',clock_timestamp())returning *into a;
 update erp_dfe.channel set active_attempt=a.id,updated_at=clock_timestamp()where id=c.id returning *into c;
 return erp_dfe.reservation(a,c,false);
end$$;
create function erp_dfe.attempt_context(actor uuid,attempt_id uuid)returns erp_dfe.attempt language plpgsql set search_path=pg_catalog as $$declare a erp_dfe.attempt;c erp_dfe.channel;begin
 select *into a from erp_dfe.attempt where id=attempt_id;if not found or a.actor<>actor then raise exception 'dfe_attempt_unavailable'using errcode='42501';end if;
 select *into c from erp_dfe.channel where id=a.channel_id for update;perform erp_dfe.check_company(c);select *into a from erp_dfe.attempt where id=attempt_id for update;return a;
end$$;
create function erp_dfe.live(a erp_dfe.attempt,token uuid)returns void language plpgsql stable set search_path=pg_catalog as $$declare c erp_dfe.channel;begin
 select *into c from erp_dfe.channel where id=a.channel_id;perform erp_dfe.check_company(c,true);
 if token is null or token<>a.lease_id or a.lease_until<=clock_timestamp()or a.state not in('reserved','dispatched','uncertain')or c.active_attempt is distinct from a.id or c.version<>a.channel_version or c.checkpoint is distinct from a.request_nsu then raise exception 'dfe_lease_lost'using errcode='40001';end if;
end$$;
create function public.erp_dfe_dispatch(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a erp_dfe.attempt;fresh boolean:=false;begin
 perform erp_dfe.lock(p_user_id,p_attempt_id,'operate');a:=erp_dfe.attempt_context(p_user_id,p_attempt_id);perform erp_dfe.live(a,p_lease_id);
 if a.state='reserved'and not a.recovery_only then
  update erp_dfe.attempt set state='dispatched',dispatched_at=clock_timestamp()where id=a.id returning *into a;fresh:=true;
  insert into erp_dfe.audit(command_id,actor,action,details)values(a.id,p_user_id,'dispatch_intent',jsonb_build_object('attempt_id',a.id,'request_hash',a.request_hash));
 end if;
 return erp_dfe.flags()||jsonb_build_object('attempt_id',a.id,'state',a.state,'dispatch_ticket_issued',fresh,'replayed',not fresh);
end$$;
create function public.erp_dfe_renew(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a erp_dfe.attempt;c erp_dfe.channel;begin
 perform erp_dfe.lock(p_user_id,p_attempt_id,'operate');a:=erp_dfe.attempt_context(p_user_id,p_attempt_id);perform erp_dfe.live(a,p_lease_id);
 if a.lease_started_at+interval'10 minutes'<=clock_timestamp()then raise exception 'dfe_lease_budget_exhausted'using errcode='40001';end if;
 update erp_dfe.attempt set lease_until=least(clock_timestamp()+interval'120 seconds',lease_started_at+interval'10 minutes')where id=a.id returning *into a;select *into c from erp_dfe.channel where id=a.channel_id;return erp_dfe.reservation(a,c,true);
end$$;
create function public.erp_dfe_uncertain(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_error_code text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a erp_dfe.attempt;c erp_dfe.channel;begin
 perform erp_dfe.lock(p_user_id,p_attempt_id,'operate');a:=erp_dfe.attempt_context(p_user_id,p_attempt_id);perform erp_dfe.live(a,p_lease_id);
 if a.state not in('dispatched','uncertain')or p_error_code is null or p_error_code not in('NETWORK_TIMEOUT','RESPONSE_LOST','RESPONSE_INVALID','STORAGE_UNCERTAIN')then raise exception 'dfe_failure_invalid'using errcode='22023';end if;
 update erp_dfe.attempt set state='uncertain',error_code=p_error_code where id=a.id returning *into a;
 update erp_dfe.channel set not_before=greatest(not_before,clock_timestamp()+interval'1 hour'),updated_at=clock_timestamp()where id=a.channel_id returning *into c;
 return erp_dfe.reservation(a,c,true);
end$$;
create function public.erp_dfe_recover(p_user_id uuid,p_attempt_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare a erp_dfe.attempt;c erp_dfe.channel;begin
 perform erp_dfe.lock(p_user_id,p_attempt_id,'operate');a:=erp_dfe.attempt_context(p_user_id,p_attempt_id);select *into c from erp_dfe.channel where id=a.channel_id;perform erp_dfe.check_company(c,true);
 if a.state not in('dispatched','uncertain')or a.lease_until>clock_timestamp()or c.active_attempt is distinct from a.id then raise exception 'dfe_recovery_unavailable'using errcode='40001';end if;
 update erp_dfe.attempt set lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval'120 seconds',lease_started_at=clock_timestamp(),recovery_only=true where id=a.id returning *into a;
 return erp_dfe.reservation(a,c,true);
end$$;

-- Only the trusted runtime supplies this manifest after parser validation and hash readback.
-- SQL cannot inspect Storage bytes; it independently checks structure, cursor rules and bindings.
create function erp_dfe.validate_manifest(m jsonb,a erp_dfe.attempt)returns text[] language plpgsql immutable set search_path=pg_catalog as $$
declare d jsonb;kind text;expected_kind text;prior text:=a.request_nsu;last text;maximum text;issues text[]:='{}';n integer;total bigint:=0;k text;begin
 if not erp_a1.exact(m,array['request_hash','response_hash','response_size','status','last_nsu','max_nsu','documents','issues'])or octet_length(m::text)>262144 or m->>'request_hash'is distinct from a.request_hash or jsonb_typeof(m->'request_hash')is distinct from'string'or jsonb_typeof(m->'response_hash')is distinct from'string'or m->>'response_hash'!~'^[a-f0-9]{64}$'or jsonb_typeof(m->'response_size')is distinct from'number'or(m->>'response_size')!~'^[0-9]{1,7}$'or(m->>'response_size')::integer not between 1 and 8388608 or jsonb_typeof(m->'status')is distinct from'string'or m->>'status'!~'^[0-9]{3}$'or jsonb_typeof(m->'documents')is distinct from'array'or jsonb_typeof(m->'issues')is distinct from'array'then raise exception 'dfe_manifest_invalid'using errcode='22023';end if;
 foreach k in array array['last_nsu','max_nsu']loop if m->k<>'null'::jsonb and(jsonb_typeof(m->k)<>'string'or m->>k!~'^[0-9]{15}$')then raise exception 'dfe_cursor_invalid'using errcode='22023';end if;end loop;
 last:=m->>'last_nsu';maximum:=m->>'max_nsu';if last is not null and maximum is not null and last>maximum then raise exception 'dfe_cursor_invalid'using errcode='22023';end if;
 n:=jsonb_array_length(m->'documents');if n>50 or(m->>'status'='138'and n=0)or(m->>'status'<>'138'and n<>0)then raise exception 'dfe_document_count_invalid'using errcode='22023';end if;
 for d in select value from jsonb_array_elements(m->'documents')loop
  if not erp_a1.exact(d,array['nsu','schema','kind','access_key','recipient_match','quarantined','hash','size','compressed_hash'])or jsonb_typeof(d->'hash')is distinct from'string'or d->>'hash'!~'^[a-f0-9]{64}$'or jsonb_typeof(d->'compressed_hash')is distinct from'string'or d->>'compressed_hash'!~'^[a-f0-9]{64}$'or jsonb_typeof(d->'size')is distinct from'number'or d->>'size'!~'^[0-9]{1,7}$'or(d->>'size')::integer not between 1 and 8388608 or jsonb_typeof(d->'schema')is distinct from'string'or length(d->>'schema')>100 or d->>'schema'!~'^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*\.xsd$'or jsonb_typeof(d->'kind')is distinct from'string'or jsonb_typeof(d->'quarantined')is distinct from'boolean'or d->'recipient_match'not in('true'::jsonb,'false'::jsonb,'null'::jsonb)then raise exception 'dfe_document_invalid'using errcode='22023';end if;
  expected_kind:=case d->>'schema'when'resNFe_v1.00.xsd'then'invoice_summary'when'resNFe_v1.01.xsd'then'invoice_summary'when'resEvento_v1.00.xsd'then'event_summary'when'resEvento_v1.01.xsd'then'event_summary'when'procNFe_v3.10.xsd'then'invoice'when'procNFe_v4.00.xsd'then'invoice'when'procEventoNFe_v1.00.xsd'then'event'else'unsupported'end;kind:=d->>'kind';
  if kind<>expected_kind or(kind='unsupported'and(d->'quarantined'<>'true'::jsonb or d->'access_key'<>'null'::jsonb or d->'recipient_match'<>'null'::jsonb))or(kind<>'unsupported'and(d->'quarantined'<>'false'::jsonb or jsonb_typeof(d->'access_key')is distinct from'string'or not erp_dfe.key55(d->>'access_key')))or(kind<>'invoice'and d->'recipient_match'<>'null'::jsonb)then raise exception 'dfe_document_binding_invalid'using errcode='22023';end if;
  if d->'nsu'='null'::jsonb then issues:=array_append(issues,'DOCUMENT_NSU_MISSING');else
   if jsonb_typeof(d->'nsu')is distinct from'string'or d->>'nsu'!~'^[0-9]{15}$'or d->>'nsu'<=prior or(last is not null and d->>'nsu'>last)then raise exception 'dfe_document_nsu_invalid'using errcode='22023';end if;
   if(d->>'nsu')::bigint<>prior::bigint+1 then issues:=array_append(issues,'NSU_GAP_OBSERVED');end if;prior:=d->>'nsu';
  end if;
  total:=total+(d->>'size')::integer;if total>33554432 then raise exception 'dfe_batch_size_limit'using errcode='22023';end if;
 end loop;
 if last is null or maximum is null then issues:=array_append(issues,'RESPONSE_CURSOR_MISSING');end if;
 if last<a.request_nsu then issues:=array_append(issues,'CURSOR_REGRESSION');end if;
 if m->>'status'='138'and last is distinct from prior then issues:=array_append(issues,'CURSOR_WITHOUT_DOCUMENT');end if;
 if m->>'status'='137'and last is not null and last<>a.request_nsu then issues:=array_append(issues,'EMPTY_RESPONSE_CURSOR_CHANGED');end if;
 select coalesce(array_agg(distinct x order by x),'{}')into issues from unnest(issues)x;
 if exists(select 1 from jsonb_array_elements(m->'issues')x where jsonb_typeof(x)<>'string')or jsonb_array_length(m->'issues')<>cardinality(issues)or(select coalesce(array_agg(x order by x),'{}')from jsonb_array_elements_text(m->'issues')x)is distinct from issues then raise exception 'dfe_issues_mismatch'using errcode='22023';end if;
 return issues;
end$$;

create function public.erp_dfe_finalize(p_user_id uuid,p_attempt_id uuid,p_lease_id uuid,p_manifest jsonb)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_dfe.attempt;c erp_dfe.channel;cmd erp_dfe.command;d jsonb;doc erp_dfe.document;issues text[];tag text;status text;result_state text;next_checkpoint text;at timestamptz;receipt jsonb;position integer:=0;h text;sz integer;begin
 perform erp_dfe.lock(p_user_id,p_attempt_id,'operate');a:=erp_dfe.attempt_context(p_user_id,p_attempt_id);tag:=erp_dfe.hash(p_manifest);
 if a.state in('stored','review')then
  if p_lease_id is null or a.lease_id<>p_lease_id or a.manifest_hash is distinct from tag then raise exception 'dfe_finalize_conflict'using errcode='40001';end if;
  select *into cmd from erp_dfe.command where id=a.id;return erp_dfe.command_view(cmd,true);
 end if;
 perform erp_dfe.live(a,p_lease_id);if a.state not in('dispatched','uncertain')then raise exception 'dfe_dispatch_required'using errcode='40001';end if;
 issues:=erp_dfe.validate_manifest(p_manifest,a);perform erp_dfe.bucket_check();
 -- Consistent hash ordering prevents concurrent channels from taking Storage/object locks in opposite order.
 for h,sz in select x.hash,min(x.size)from(select p_manifest->>'response_hash'hash,(p_manifest->>'response_size')::integer size union all select v->>'hash',(v->>'size')::integer from jsonb_array_elements(p_manifest->'documents')v)x group by x.hash order by x.hash loop
  if exists(select 1 from(select p_manifest->>'response_hash'hash,(p_manifest->>'response_size')::integer size union all select v->>'hash',(v->>'size')::integer from jsonb_array_elements(p_manifest->'documents')v)x where x.hash=h and x.size<>sz)then raise exception 'dfe_object_size_conflict'using errcode='22023';end if;
  perform erp_dfe.storage_check(h,sz);insert into erp_dfe.object(hash,size_bytes)values(h,sz)on conflict(hash)do nothing;
  if not exists(select 1 from erp_dfe.object o where o.hash=h and o.size_bytes=sz)then raise exception 'dfe_object_conflict'using errcode='40001';end if;
 end loop;
 for d in select value from jsonb_array_elements(p_manifest->'documents')loop
  position:=position+1;doc:=null;
  if d->>'nsu'is not null then select *into doc from erp_dfe.document where channel_id=a.channel_id and nsu=d->>'nsu';
  else select *into doc from erp_dfe.document where channel_id=a.channel_id and nsu is null and object_hash=d->>'hash'and schema_name=d->>'schema';end if;
  if doc.id is not null then
   if doc.object_hash<>d->>'hash'or doc.schema_name<>d->>'schema'or doc.kind<>d->>'kind'or doc.access_key is distinct from d->>'access_key'or doc.recipient_match is distinct from(d->>'recipient_match')::boolean or doc.quarantined<>(d->>'quarantined')::boolean then raise exception 'dfe_nsu_content_conflict'using errcode='40001';end if;
  else
   insert into erp_dfe.document(channel_id,nsu,object_hash,schema_name,kind,access_key,recipient_match,quarantined,first_attempt)values(a.channel_id,d->>'nsu',d->>'hash',d->>'schema',d->>'kind',d->>'access_key',(d->>'recipient_match')::boolean,(d->>'quarantined')::boolean,a.id)returning *into doc;
  end if;
  insert into erp_dfe.attempt_document(attempt_id,position,document_id,compressed_hash)values(a.id,position,doc.id,d->>'compressed_hash');
 end loop;
 select *into c from erp_dfe.channel where id=a.channel_id;status:=p_manifest->>'status';at:=clock_timestamp();next_checkpoint:=c.checkpoint;
 result_state:=case when status in('137','138')and cardinality(issues)=0 then'stored'else'review'end;
 if result_state='stored'and status='138'then next_checkpoint:=p_manifest->>'last_nsu';end if;
 update erp_dfe.channel set checkpoint=next_checkpoint,version=version+1,active_attempt=null,paused=result_state='review',not_before=case when status in('137','656')or result_state='review'or(status='138'and p_manifest->>'last_nsu'=p_manifest->>'max_nsu')then greatest(not_before,at+interval'1 hour')else not_before end,updated_at=at where id=c.id returning *into c;
 receipt:=jsonb_build_object('attempt_id',a.id,'state',result_state,'status',status,'request_nsu',a.request_nsu,'reported_last_nsu',p_manifest->'last_nsu','reported_max_nsu',p_manifest->'max_nsu','checkpoint_after',c.checkpoint,'response_hash',p_manifest->'response_hash','documents',position,'issues',to_jsonb(issues),'recorded_at',at);
 update erp_dfe.attempt set state=result_state,manifest_hash=tag,manifest=p_manifest,response_hash=p_manifest->>'response_hash',result=receipt,finished_at=at where id=a.id;
 update erp_dfe.command set result=receipt where id=a.id returning *into cmd;
 insert into erp_dfe.audit(command_id,actor,action,details)values(a.id,p_user_id,'finalize',receipt);
 if a.lease_until<=clock_timestamp()then raise exception 'dfe_lease_lost'using errcode='40001';end if;
 return erp_dfe.command_view(cmd,false);
end$$;

create function public.erp_dfe_abandon(p_user_id uuid,p_command_id uuid,p_attempt_id uuid,p_expected_version integer,p_confirm_pause boolean,p_reason text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a erp_dfe.attempt;c erp_dfe.channel;cmd erp_dfe.command;tag text;receipt jsonb;at timestamptz;begin
 perform erp_dfe.lock(p_user_id,p_command_id,'admin');if p_attempt_id is null or p_expected_version is null or p_expected_version<1 or p_confirm_pause is distinct from true or not erp_a1.reason_valid(p_reason)then raise exception 'dfe_abandon_invalid'using errcode='22023';end if;
 tag:=erp_dfe.hash(jsonb_build_array(p_attempt_id,p_expected_version,p_confirm_pause,p_reason));select *into cmd from erp_dfe.command where id=p_command_id;
 if found then if cmd.actor<>p_user_id or cmd.action<>'abandon'or cmd.request_hash<>tag then raise exception 'dfe_command_conflict'using errcode='40001';end if;return erp_dfe.command_view(cmd,true);end if;
 select *into a from erp_dfe.attempt where id=p_attempt_id;if not found then raise exception 'dfe_attempt_missing'using errcode='P0002';end if;
 select *into c from erp_dfe.channel where id=a.channel_id for update;perform erp_dfe.check_company(c);select *into a from erp_dfe.attempt where id=p_attempt_id for update;
 if c.version<>p_expected_version or c.version=2147483647 or c.active_attempt is distinct from a.id or a.state not in('reserved','dispatched','uncertain')or a.lease_until>clock_timestamp()then raise exception 'dfe_abandon_conflict'using errcode='40001';end if;
 at:=clock_timestamp();receipt:=jsonb_build_object('attempt_id',a.id,'state','abandoned','checkpoint_after',c.checkpoint,'reason',p_reason,'recorded_at',at);
 update erp_dfe.attempt set state='abandoned',result=receipt,finished_at=at where id=a.id;
 update erp_dfe.command set result=receipt where id=a.id;
 update erp_dfe.channel set version=version+1,active_attempt=null,paused=true,collection_requested=false,not_before=greatest(not_before,at+interval'1 hour'),updated_at=at where id=c.id;
 insert into erp_dfe.command(id,actor,action,request_hash,channel_id,result)values(p_command_id,p_user_id,'abandon',tag,c.id,receipt)returning *into cmd;
 insert into erp_dfe.audit(command_id,actor,action,reason,details)values(p_command_id,p_user_id,'abandon',p_reason,receipt);return erp_dfe.command_view(cmd,false);
end$$;
create function public.erp_dfe_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare cmd erp_dfe.command;begin
 perform erp_dfe.access(p_user_id,'operate');select *into cmd from erp_dfe.command where id=p_command_id and actor=p_user_id;if not found then raise exception 'dfe_command_unavailable'using errcode='42501';end if;return erp_dfe.command_view(cmd,true);
end$$;
create function erp_dfe.document_json(d erp_dfe.document)returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object('id',d.id,'channel_id',d.channel_id,'nsu',d.nsu,'kind',d.kind,'schema',d.schema_name,'model',case when d.kind='unsupported'then null else'55'end,'access_key',d.access_key,'recipient_match',d.recipient_match,'quarantined',d.quarantined,'xml_hash',d.object_hash,'size_bytes',o.size_bytes,'collected_at',d.created_at,'is_complete_invoice',d.kind='invoice')from erp_dfe.object o where o.hash=d.object_hash$$;
create function public.erp_dfe_documents(p_user_id uuid,p_channel_id uuid,p_kind text default null,p_limit integer default 25,p_after uuid default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_dfe.channel;rows jsonb;more boolean;cursor uuid;begin
 perform erp_dfe.access(p_user_id,'read');if p_limit is null or p_limit not between 1 and 50 or(p_kind is not null and p_kind not in('invoice_summary','invoice','event_summary','event','unsupported'))then raise exception 'dfe_filter_invalid'using errcode='22023';end if;
 select *into c from erp_dfe.channel where id=p_channel_id;if not found then raise exception 'dfe_channel_missing'using errcode='P0002';end if;perform erp_dfe.check_company(c);
 select count(*)>p_limit into more from(select 1 from erp_dfe.document where channel_id=c.id and(p_after is null or id>p_after)and(p_kind is null or kind=p_kind)order by id limit p_limit+1)x;
 select coalesce(jsonb_agg(erp_dfe.document_json(d)order by d.id),'[]'::jsonb)into rows from(select *from erp_dfe.document where channel_id=c.id and(p_after is null or id>p_after)and(p_kind is null or kind=p_kind)order by id limit p_limit)d;
 if more then cursor:=(rows->(jsonb_array_length(rows)-1)->>'id')::uuid;end if;
 return erp_dfe.flags()||jsonb_build_object('channel_id',c.id,'items',rows,'limit',p_limit,'has_more',more,'next_cursor',cursor);
end$$;
create function public.erp_dfe_object(p_user_id uuid,p_document_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare d erp_dfe.document;c erp_dfe.channel;begin
 perform erp_dfe.access(p_user_id,'read');select *into d from erp_dfe.document where id=p_document_id;if not found then raise exception 'dfe_document_missing'using errcode='P0002';end if;select *into c from erp_dfe.channel where id=d.channel_id;perform erp_dfe.check_company(c);
 return erp_dfe.flags()||jsonb_build_object('document',erp_dfe.document_json(d),'bucket','brufap-received-dfe','object_key','objects/'||d.object_hash||'.xml','filename',case when d.kind='invoice'then'NFE_'when d.kind='invoice_summary'then'RESUMO_NFE_'when d.kind in('event','event_summary')then'EVENTO_NFE_'else'QUARENTENA_'end||d.id::text||'.xml');
end$$;

revoke all on all functions in schema erp_dfe from public,anon,authenticated,service_role;
revoke all on function public.erp_dfe_settings(uuid,text),public.erp_dfe_configure(uuid,uuid,text,integer,integer,text,text,boolean,boolean,boolean,text),public.erp_dfe_reserve(uuid,uuid,uuid,integer),public.erp_dfe_dispatch(uuid,uuid,uuid),public.erp_dfe_renew(uuid,uuid,uuid),public.erp_dfe_uncertain(uuid,uuid,uuid,text),public.erp_dfe_recover(uuid,uuid),public.erp_dfe_finalize(uuid,uuid,uuid,jsonb),public.erp_dfe_abandon(uuid,uuid,uuid,integer,boolean,text),public.erp_dfe_command(uuid,uuid),public.erp_dfe_documents(uuid,uuid,text,integer,uuid),public.erp_dfe_object(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_dfe_settings(uuid,text),public.erp_dfe_configure(uuid,uuid,text,integer,integer,text,text,boolean,boolean,boolean,text),public.erp_dfe_reserve(uuid,uuid,uuid,integer),public.erp_dfe_dispatch(uuid,uuid,uuid),public.erp_dfe_renew(uuid,uuid,uuid),public.erp_dfe_uncertain(uuid,uuid,uuid,text),public.erp_dfe_recover(uuid,uuid),public.erp_dfe_finalize(uuid,uuid,uuid,jsonb),public.erp_dfe_abandon(uuid,uuid,uuid,integer,boolean,text),public.erp_dfe_command(uuid,uuid),public.erp_dfe_documents(uuid,uuid,text,integer,uuid),public.erp_dfe_object(uuid,uuid)to service_role;
commit;
