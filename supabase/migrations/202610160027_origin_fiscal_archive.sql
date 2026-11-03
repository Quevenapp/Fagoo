-- Coleta privada de XMLs da API Origin. Sem efeitos no ERP ou no backup original.
begin;
create schema origin_fiscal;
revoke all on schema origin_fiscal from public,anon,authenticated,service_role;
create table origin_fiscal.source (
 id uuid primary key default gen_random_uuid(),entity text not null check(entity in('nfe','nfce')),
 source_id text not null check(source_id ~ '^[0-9]{1,40}$'),access_key text not null check(access_key ~ '^[0-9]{44}$'),
 state text not null default 'pending' check(state in('pending','stored','retry','blocked')),
 current_attempt uuid,current_revision uuid,next_revision integer not null default 1 check(next_revision>0),
 last_fingerprint text,last_checked_at timestamptz,last_success_at timestamptz,next_attempt_at timestamptz,
 last_error text check(last_error ~ '^[A-Z][A-Z0-9_]{0,79}$'),failures integer not null default 0 check(failures>=0),
 unique(entity,source_id,access_key),check(substring(access_key,21,2)=case entity when 'nfe' then '55' else '65' end)
);
create table origin_fiscal.attempt (
 id uuid primary key default gen_random_uuid(),source uuid not null references origin_fiscal.source(id),
 owner uuid not null,fence uuid not null,fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
 source_hash text not null,source_version bigint not null,source_status text,
 state text not null default 'pending' check(state in('pending','stored','retry','blocked','superseded')),
 started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
 manifest_hash text,result jsonb,error_code text
);
create table origin_fiscal.object (
 hash text primary key check(hash ~ '^[0-9a-f]{64}$'),size integer not null check(size between 1 and 8388608),
 metadata jsonb not null check(jsonb_typeof(metadata)='object'),created_at timestamptz not null default clock_timestamp()
);
create table origin_fiscal.revision (
 id uuid primary key default gen_random_uuid(),source uuid not null references origin_fiscal.source(id),
 revision integer not null check(revision>0),manifest_hash text not null,source_status text,
 collected_at timestamptz not null default clock_timestamp(),unique(source,revision),unique(source,manifest_hash)
);
create table origin_fiscal.item (
 id uuid primary key default gen_random_uuid(),revision uuid not null references origin_fiscal.revision(id),
 object_hash text not null references origin_fiscal.object(hash),unique(revision,object_hash)
);
alter table origin_fiscal.source add foreign key(current_attempt) references origin_fiscal.attempt(id);
alter table origin_fiscal.source add foreign key(current_revision) references origin_fiscal.revision(id);
create index fiscal_attempt_source on origin_fiscal.attempt(source,started_at desc);
create index fiscal_item_revision on origin_fiscal.item(revision,id);
alter table origin_fiscal.source enable row level security;
alter table origin_fiscal.attempt enable row level security;
alter table origin_fiscal.object enable row level security;
alter table origin_fiscal.revision enable row level security;
alter table origin_fiscal.item enable row level security;
revoke all on all tables in schema origin_fiscal from public,anon,authenticated,service_role;
alter default privileges in schema origin_fiscal revoke all on tables from public,anon,authenticated;
create function origin_fiscal.immutable_archive() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'immutable_fiscal_archive' using errcode='55000';end; $$;
create trigger fiscal_object_immutable before update or delete on origin_fiscal.object for each row execute function origin_fiscal.immutable_archive();
create trigger fiscal_revision_immutable before update or delete on origin_fiscal.revision for each row execute function origin_fiscal.immutable_archive();
create trigger fiscal_item_immutable before update or delete on origin_fiscal.item for each row execute function origin_fiscal.immutable_archive();
create function origin_fiscal.immutable_observation() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if TG_OP='DELETE' or OLD.state<>'pending' then raise exception 'immutable_fiscal_observation' using errcode='55000';end if;
 return NEW;
end; $$;
create trigger fiscal_observation_immutable before update or delete on origin_fiscal.attempt for each row execute function origin_fiscal.immutable_observation();
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('origin-fiscal-xml','origin-fiscal-xml',false,8388608,array['application/xml','application/octet-stream']) on conflict(id) do nothing;
create policy origin_fiscal_proxy_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'origin-fiscal-xml') with check(bucket_id<>'origin-fiscal-xml');

create function origin_fiscal.require_scheduler(p_owner uuid,p_fence uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if p_owner is null or p_fence is null or not exists(select 1 from origin_sync.resource_state where resource='__scheduler__'
  and lease_owner=p_owner and lease_token=p_fence and lease_expires_at>clock_timestamp() for share) then
  raise exception 'xml_scheduler_lease_required' using errcode='55000'; end if;
end; $$;
-- URLs and raw payload hashes must not trigger repeated downloads of identical XML.
create function origin_fiscal.fingerprint(p jsonb) returns text language sql immutable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('key',p->'chaveAcesso','status',p->'situacao','type',p->'tipo',
  'number',p->'numero','series',p->'serie','issued',p->'dataEmissao','operation',p->'dataOperacao','total',p->'valorNota')::text,'UTF8')),'hex');
$$;
create function origin_fiscal.storage_ready() returns void language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from storage.buckets where id='origin-fiscal-xml' and name=id and not public and file_size_limit=8388608
  and allowed_mime_types @> array['application/xml','application/octet-stream']::text[]) then
  raise exception 'xml_private_storage_required' using errcode='55000';end if;
end; $$;

create function public.origin_sync_xml_candidates(p_owner uuid,p_lease_token uuid,p_limit integer default 2)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'invalid_xml_limit' using errcode='22023';end if;
 with eligible as materialized (
  select r.entity,r.source_id,r.payload->>'chaveAcesso' key,origin_fiscal.fingerprint(r.payload) fingerprint,
   s.last_success_at,s.next_attempt_at,s.last_fingerprint,s.current_attempt,
   row_number() over(partition by r.entity order by s.last_success_at nulls first,r.source_id collate "C") lane
  from origin_sync.raw_record r left join origin_fiscal.source s on s.entity=r.entity and s.source_id=r.source_id and s.access_key=r.payload->>'chaveAcesso'
  where r.entity in('nfe','nfce') and r.source_id ~ '^[0-9]{1,40}$' and jsonb_typeof(r.payload->'chaveAcesso')='string'
   and r.payload->>'chaveAcesso' ~ '^[0-9]{44}$' and substring(r.payload->>'chaveAcesso',21,2)=case r.entity when 'nfe' then '55' else '65' end
   and (s.next_attempt_at is null or s.next_attempt_at<=clock_timestamp() or s.last_fingerprint is distinct from origin_fiscal.fingerprint(r.payload))
 ), page as (select * from eligible order by lane,entity limit p_limit)
 select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('entity',entity,'source_id',source_id,'key',key,'fingerprint',fingerprint) order by lane,entity),'[]'::jsonb)) into result from page;
 return result;
end; $$;

create function public.origin_sync_xml_begin(p_owner uuid,p_lease_token uuid,p_entity text,p_source_id text,p_key text,p_fingerprint text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r origin_sync.raw_record%rowtype;s origin_fiscal.source%rowtype;a origin_fiscal.attempt%rowtype;
begin
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 select * into r from origin_sync.raw_record where entity=p_entity and source_id=p_source_id;
 if not found or p_entity not in('nfe','nfce') or p_source_id !~ '^[0-9]{1,40}$' or p_key !~ '^[0-9]{44}$'
  or p_key is distinct from r.payload->>'chaveAcesso' or p_fingerprint is distinct from origin_fiscal.fingerprint(r.payload)
  or substring(p_key,21,2)<>(case p_entity when 'nfe' then '55' else '65' end) then
  raise exception 'xml_source_changed' using errcode='40001';end if;
 insert into origin_fiscal.source(entity,source_id,access_key) values(p_entity,p_source_id,p_key) on conflict do nothing;
 select * into s from origin_fiscal.source where entity=p_entity and source_id=p_source_id and access_key=p_key for update;
 if s.current_attempt is not null then
  select * into a from origin_fiscal.attempt where id=s.current_attempt for update;
  if a.state='pending' and a.owner=p_owner and a.fence=p_lease_token and a.fingerprint=p_fingerprint then
   return jsonb_build_object('attempt_id',a.id,'entity',s.entity,'source_id',s.source_id,'key',s.access_key,'fingerprint',a.fingerprint);end if;
  if a.state='pending' then update origin_fiscal.attempt set state='superseded',finished_at=clock_timestamp() where id=a.id;end if;
 end if;
 insert into origin_fiscal.attempt(source,owner,fence,fingerprint,source_hash,source_version,source_status)
 values(s.id,p_owner,p_lease_token,p_fingerprint,r.version_hash,r.version,case when jsonb_typeof(r.payload->'situacao') in('string','number') and length(r.payload->>'situacao') between 1 and 100 then r.payload->>'situacao' end) returning * into a;
 update origin_fiscal.source set current_attempt=a.id,state='pending',last_fingerprint=p_fingerprint where id=s.id;
 return jsonb_build_object('attempt_id',a.id,'entity',s.entity,'source_id',s.source_id,'key',s.access_key,'fingerprint',a.fingerprint);
end; $$;

create function public.origin_sync_xml_finish(p_owner uuid,p_lease_token uuid,p_attempt_id uuid,p_documents jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_fiscal.attempt%rowtype;s origin_fiscal.source%rowtype;r origin_fiscal.revision%rowtype;o origin_fiscal.object%rowtype;
 d jsonb;v_meta jsonb;v_hash text;v_size integer;v_total bigint:=0;v_manifest text;v_result jsonb;v_existing boolean;
begin
 if p_documents is null or jsonb_typeof(p_documents)<>'array' or jsonb_array_length(p_documents) not between 1 and 10 or octet_length(p_documents::text)>65536 then raise exception 'invalid_xml_manifest' using errcode='22023';end if;
 select encode(sha256(convert_to(jsonb_agg(value order by value->>'hash')::text,'UTF8')),'hex') into v_manifest from jsonb_array_elements(p_documents);
 select * into a from origin_fiscal.attempt where id=p_attempt_id;
 if not found or a.owner is distinct from p_owner or a.fence is distinct from p_lease_token then raise exception 'xml_attempt_missing' using errcode='55000';end if;
 if a.state='stored' then
  if a.manifest_hash<>v_manifest then raise exception 'xml_replay_conflict' using errcode='40001';end if;
  return a.result||jsonb_build_object('replayed',true);
 end if;
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);perform origin_fiscal.storage_ready();
 select * into s from origin_fiscal.source where id=a.source for update;
 select * into a from origin_fiscal.attempt where id=p_attempt_id for update;
 if a.state<>'pending' or s.current_attempt<>a.id then raise exception 'xml_attempt_stale' using errcode='55000';end if;
 if (select count(distinct value->>'hash') from jsonb_array_elements(p_documents))<>jsonb_array_length(p_documents) then raise exception 'xml_duplicate_manifest' using errcode='22023';end if;
 for d in select value from jsonb_array_elements(p_documents) order by value->>'hash' loop
  if jsonb_typeof(d)<>'object' or (select count(*) from jsonb_object_keys(d))<>12
   or jsonb_typeof(d->'hash') is distinct from 'string' or coalesce(d->>'hash','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(d->'size') is distinct from 'number' or coalesce(d->>'size','') !~ '^[0-9]{1,8}$'
   or jsonb_typeof(d->'key') is distinct from 'string' or jsonb_typeof(d->'model') is distinct from 'string'
   or jsonb_typeof(d->'environment') is distinct from 'string' or jsonb_typeof(d->'kind') is distinct from 'string'
   or jsonb_typeof(d->'protocol') not in('string','null') or jsonb_typeof(d->'event_type') not in('string','null') or jsonb_typeof(d->'event_sequence') not in('string','null')
   or d->>'key' is distinct from s.access_key or d->>'model' is distinct from substring(s.access_key,21,2)
   or coalesce(d->>'environment','') not in('1','2') or coalesce(d->>'kind','') not in('invoice','event')
   or jsonb_typeof(d->'protocol_present') is distinct from 'boolean' or jsonb_typeof(d->'signature_present') is distinct from 'boolean'
   or not(d ?& array['protocol','event_type','event_sequence','issues']) or jsonb_typeof(d->'issues') is distinct from 'array'
   or jsonb_array_length(d->'issues')>2 then raise exception 'invalid_xml_metadata' using errcode='22023';end if;
  v_hash:=d->>'hash';v_size:=(d->>'size')::integer;v_total:=v_total+v_size;
  if v_size not between 1 and 8388608 or v_total>16777216
   or (d->>'protocol' is not null and d->>'protocol' !~ '^[0-9]{1,20}$')
   or (d->'protocol_present'='true'::jsonb) is distinct from (d->>'protocol' is not null)
   or (d->>'kind'='invoice' and (d->>'event_type' is not null or d->>'event_sequence' is not null))
   or (d->>'kind'='event' and (coalesce(d->>'event_type','') !~ '^[0-9]{6}$' or coalesce(d->>'event_sequence','') !~ '^[0-9]{1,3}$'))
   or exists(select 1 from jsonb_array_elements_text(d->'issues') x where x not in('PROTOCOL_ABSENT','SIGNATURE_ABSENT'))
   or (d->'issues' ? 'PROTOCOL_ABSENT') is distinct from not (d->>'protocol_present')::boolean
   or (d->'issues' ? 'SIGNATURE_ABSENT') is distinct from not (d->>'signature_present')::boolean
   or (select count(distinct x) from jsonb_array_elements_text(d->'issues') x)<>jsonb_array_length(d->'issues') then raise exception 'invalid_xml_metadata' using errcode='22023';end if;
  if not exists(select 1 from storage.objects where bucket_id='origin-fiscal-xml' and name='objects/'||v_hash||'.xml'
    and metadata->>'size'=v_size::text and metadata->>'mimetype' in('application/xml','application/octet-stream')) then raise exception 'xml_storage_object_missing' using errcode='55000';end if;
  v_meta:=d-'hash'-'size';select * into o from origin_fiscal.object where hash=v_hash;
  if found then if o.size<>v_size or o.metadata<>v_meta then raise exception 'immutable_xml_object_conflict' using errcode='40001';end if;
  else insert into origin_fiscal.object(hash,size,metadata) values(v_hash,v_size,v_meta);end if;
 end loop;
 select * into r from origin_fiscal.revision where source=s.id and manifest_hash=v_manifest;v_existing:=found;
 if not v_existing then
  if s.next_revision>=2147483647 then raise exception 'xml_revision_limit' using errcode='22023';end if;
  insert into origin_fiscal.revision(source,revision,manifest_hash,source_status) values(s.id,s.next_revision,v_manifest,a.source_status) returning * into r;
  insert into origin_fiscal.item(revision,object_hash) select r.id,value->>'hash' from jsonb_array_elements(p_documents);
 end if;
 v_result:=jsonb_build_object('stored',true,'replayed',false,'unchanged',v_existing,'revision_id',r.id,'revision',r.revision,'files',jsonb_array_length(p_documents));
 update origin_fiscal.attempt set state='stored',finished_at=clock_timestamp(),manifest_hash=v_manifest,result=v_result where id=a.id;
 update origin_fiscal.source set state='stored',current_revision=r.id,next_revision=next_revision+case when v_existing then 0 else 1 end,
  last_fingerprint=a.fingerprint,last_checked_at=clock_timestamp(),last_success_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '24 hours',last_error=null,failures=0 where id=s.id;
 return v_result;
end; $$;

create function public.origin_sync_xml_fail(p_owner uuid,p_lease_token uuid,p_attempt_id uuid,p_code text,p_blocked boolean default false,p_retry_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a origin_fiscal.attempt%rowtype;s origin_fiscal.source%rowtype;v_state text;
begin
 perform origin_fiscal.require_scheduler(p_owner,p_lease_token);
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' or p_blocked is null or p_retry_seconds is null or p_retry_seconds not between 60 and 86400 then raise exception 'invalid_xml_failure' using errcode='22023';end if;
 select * into a from origin_fiscal.attempt where id=p_attempt_id;
 if not found then raise exception 'xml_attempt_missing' using errcode='55000';end if;
 select * into s from origin_fiscal.source where id=a.source for update;
 select * into a from origin_fiscal.attempt where id=p_attempt_id for update;
 if a.owner is distinct from p_owner or a.fence is distinct from p_lease_token or s.current_attempt is distinct from a.id then raise exception 'xml_attempt_stale' using errcode='55000';end if;
 if a.state='stored' then return jsonb_build_object('recorded',false,'already_stored',true);end if;
 if a.state in('retry','blocked') then return jsonb_build_object('recorded',true,'replayed',true);end if;
 if a.state<>'pending' then raise exception 'xml_attempt_stale' using errcode='55000';end if;
 v_state:=case when p_blocked then 'blocked' else 'retry' end;
 update origin_fiscal.attempt set state=v_state,error_code=p_code,finished_at=clock_timestamp() where id=a.id;
 update origin_fiscal.source set state=v_state,last_checked_at=clock_timestamp(),last_error=p_code,failures=failures+1,
  next_attempt_at=clock_timestamp()+make_interval(secs=>p_retry_seconds) where id=s.id;
 return jsonb_build_object('recorded',true,'replayed',false);
end; $$;

create function public.origin_sync_xml_status() returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select jsonb_build_object('objects',(select count(*) from origin_fiscal.object),'revisions',(select count(*) from origin_fiscal.revision),
  'sources',(select count(*) from origin_fiscal.source),'last_success_at',(select max(last_success_at) from origin_fiscal.source),
  'states',coalesce((select jsonb_object_agg(state,n) from(select state,count(*) n from origin_fiscal.source group by state)x),'{}'::jsonb),
  'errors',coalesce((select jsonb_agg(jsonb_build_object('code',last_error,'count',n) order by last_error) from(select last_error,count(*) n from origin_fiscal.source where last_error is not null group by last_error)x),'[]'::jsonb));
$$;

create function public.erp_synced_xml_list(p_user_id uuid,p_limit integer default 25,p_after uuid default null,p_query text default null,p_model text default null,p_kind text default null,p_include_history boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform erp_access.require_history_role(p_user_id);
 if p_limit is null or p_limit not between 1 and 100 or p_include_history is null or length(p_query)>64 or p_query ~ '[[:cntrl:]]'
  or (p_model is not null and p_model not in('55','65')) or(p_kind is not null and p_kind not in('invoice','event')) then raise exception 'erp_invalid_query' using errcode='22023';end if;
 with rows as materialized(
  select i.id,jsonb_build_object('id',i.id,'source_id',s.source_id,'entity',s.entity,'key',s.access_key,
   'model',o.metadata->>'model','environment',o.metadata->>'environment','kind',o.metadata->>'kind','revision',r.revision,
   'source_status',r.source_status,'collected_at',r.collected_at,'xml_hash',o.hash,'size_bytes',o.size,
   'protocol',o.metadata->'protocol','protocol_present',o.metadata->'protocol_present','signature_present',o.metadata->'signature_present',
   'event_type',o.metadata->'event_type','event_sequence',o.metadata->'event_sequence','issues',o.metadata->'issues',
   'validation','structural_only','signature_verified',false,'xsd_validated',false,'authorization_verified',false) item
  from origin_fiscal.item i join origin_fiscal.revision r on r.id=i.revision join origin_fiscal.source s on s.id=r.source join origin_fiscal.object o on o.hash=i.object_hash
  where(p_include_history or s.current_revision=r.id) and(p_after is null or i.id>p_after)
   and(nullif(p_query,'') is null or strpos(s.access_key,p_query)>0) and(p_model is null or o.metadata->>'model'=p_model) and(p_kind is null or o.metadata->>'kind'=p_kind)
  order by i.id limit p_limit+1
 ), page as(select * from rows order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(item order by id) from page),'[]'::jsonb),'limit',p_limit,
  'has_more',(select count(*) from rows)>p_limit,'next_cursor',case when(select count(*) from rows)>p_limit then(select id from page order by id desc limit 1) end,'data_mode','fiscal_archive_readonly') into result;
 return result;
end; $$;

create function public.erp_synced_xml_object(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform erp_access.require_history_role(p_user_id);perform origin_fiscal.storage_ready();
 select jsonb_build_object('id',i.id,'revision_id',i.revision,'bucket','origin-fiscal-xml','object_key','objects/'||o.hash||'.xml','sha256',o.hash,'size',o.size,'model',o.metadata->>'model') into result
 from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash join storage.objects so on so.bucket_id='origin-fiscal-xml' and so.name='objects/'||o.hash||'.xml'
 where i.id=p_id and so.metadata->>'size'=o.size::text and so.metadata->>'mimetype' in('application/xml','application/octet-stream');
 if result is null then raise exception 'erp_history_not_found' using errcode='P0002';end if;return result;
end; $$;

revoke all on all functions in schema origin_fiscal from public,anon,authenticated,service_role;
revoke all on function public.origin_sync_xml_candidates(uuid,uuid,integer),public.origin_sync_xml_begin(uuid,uuid,text,text,text,text),public.origin_sync_xml_finish(uuid,uuid,uuid,jsonb),public.origin_sync_xml_fail(uuid,uuid,uuid,text,boolean,integer),public.origin_sync_xml_status(),public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean),public.erp_synced_xml_object(uuid,uuid) from public,anon,authenticated;
grant execute on function public.origin_sync_xml_candidates(uuid,uuid,integer),public.origin_sync_xml_begin(uuid,uuid,text,text,text,text),public.origin_sync_xml_finish(uuid,uuid,uuid,jsonb),public.origin_sync_xml_fail(uuid,uuid,uuid,text,boolean,integer),public.origin_sync_xml_status(),public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean),public.erp_synced_xml_object(uuid,uuid) to service_role;
commit;
