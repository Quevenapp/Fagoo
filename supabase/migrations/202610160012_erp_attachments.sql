-- Anexos privados de documentos ERP. Provisionar o bucket pela Storage API.
-- Esta migração apenas consulta metadados Storage; nunca insere/remove objetos.
begin;
create schema erp_attachments;
revoke all on schema erp_attachments from public,anon,authenticated,service_role;
create table erp_attachments.attachment (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references erp_documents.document(id),
  command_id uuid not null unique, actor uuid not null references auth.users(id), request_hash text not null,
  filename text not null, mime_type text not null, size_bytes integer not null check(size_bytes between 1 and 10485760),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'reserved' check(status in ('reserved','ready','aborted')),
  lease_token uuid, lease_actor uuid references auth.users(id), lease_until timestamptz,
  finished_by uuid references auth.users(id), created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
  check((lease_token is null)=(lease_until is null)),
  check(status='reserved' or (lease_token is null and lease_until is null))
);
create index erp_attachments_document on erp_attachments.attachment(document_id,id);
create table erp_attachments.audit (
  id bigint generated always as identity primary key, attachment_id uuid not null references erp_attachments.attachment(id),
  actor uuid not null references auth.users(id), action text not null check(action in ('reserve','finalize','abort')),
  created_at timestamptz not null default clock_timestamp()
);
alter table erp_attachments.attachment enable row level security;
alter table erp_attachments.audit enable row level security;
revoke all on all tables in schema erp_attachments from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_attachments from public,anon,authenticated,service_role;
alter default privileges in schema erp_attachments revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_attachments revoke all on functions from public,anon,authenticated,service_role;
-- Restrictive policy defeats unrelated broad authenticated policies on Storage.
-- service_role bypasses RLS and is used only by the authenticated Worker proxy.
create policy erp_attachments_proxy_only on storage.objects as restrictive for all to anon,authenticated
  using(bucket_id<>'erp-attachments') with check(bucket_id<>'erp-attachments');

create function erp_attachments.authorize(p_user_id uuid,p_kind text,p_document_id uuid,p_write boolean)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
  perform erp_documents.require_access(p_user_id,p_kind,p_write);
  if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then
    raise exception 'erp_attachment_document_not_found' using errcode='P0002'; end if;
end $$;
create function erp_attachments.storage_ready()
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
  if not exists(select 1 from storage.buckets where id='erp-attachments' and name='erp-attachments' and not public
    and file_size_limit=10485760 and cardinality(allowed_mime_types)=5
    and allowed_mime_types @> array['application/pdf','image/png','image/jpeg','application/xml','text/plain']::text[]) then
    raise exception 'erp_attachment_storage_unavailable' using errcode='55000'; end if;
end $$;
create function erp_attachments.dto(p_id uuid,p_internal boolean default false)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',a.id,'document_id',a.document_id,'filename',a.filename,'mime_type',a.mime_type,
    'size_bytes',a.size_bytes,'sha256',a.sha256,'status',a.status,'created_at',a.created_at,'finished_at',a.finished_at)
    ||case when p_internal then jsonb_build_object('bucket','erp-attachments',
      'object_key','documents/'||a.document_id||'/'||a.id||'/'||a.sha256) else '{}'::jsonb end
  from erp_attachments.attachment a where id=p_id;
$$;
create function erp_attachments.immutable_identity()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' then raise exception 'erp_attachment_no_delete' using errcode='40001'; end if;
  if (new.id,new.document_id,new.command_id,new.actor,new.request_hash,new.filename,new.mime_type,new.size_bytes,new.sha256,new.created_at)
    is distinct from (old.id,old.document_id,old.command_id,old.actor,old.request_hash,old.filename,old.mime_type,old.size_bytes,old.sha256,old.created_at)
    or (old.status<>'reserved' and new is distinct from old) then
    raise exception 'erp_attachment_immutable' using errcode='40001'; end if;
  return new;
end $$;
create trigger attachment_identity before update or delete on erp_attachments.attachment for each row execute function erp_attachments.immutable_identity();

create function public.erp_attachment_reserve(p_user_id uuid,p_kind text,p_document_id uuid,p_command_id uuid,
  p_filename text,p_mime_type text,p_size_bytes integer,p_sha256 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_row erp_attachments.attachment%rowtype;v_id uuid;v_ext text;
begin
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,true);
  perform erp_attachments.storage_ready();
  v_ext:=case p_mime_type when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'image/jpeg' then 'jpg'
    when 'application/xml' then 'xml' when 'text/plain' then 'txt' end;
  if p_command_id is null or p_filename is null or v_ext is null or p_size_bytes is null or p_size_bytes not between 1 and 10485760
    or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' or p_filename!~('^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.'||v_ext||'$') then
    raise exception 'erp_attachment_invalid_metadata' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'kind',p_kind,'document_id',p_document_id,
    'filename',p_filename,'mime_type',p_mime_type,'size_bytes',p_size_bytes,'sha256',p_sha256)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852912,hashtext(p_command_id::text));
  select * into v_row from erp_attachments.attachment where command_id=p_command_id;
  if found then
    if v_row.actor<>p_user_id or v_row.request_hash<>v_hash then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
    return jsonb_build_object('attachment',erp_attachments.dto(v_row.id),'replayed',true,'data_mode','erp_native');
  end if;
  -- One document lock serializes quota reservations; aborted IDs also consume quota.
  perform 1 from erp_documents.document where id=p_document_id for update;
  if (select count(*) from erp_attachments.attachment where document_id=p_document_id)>=100 then
    raise exception 'erp_attachment_quota' using errcode='54000'; end if;
  insert into erp_attachments.attachment(document_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256)
    values(p_document_id,p_command_id,p_user_id,v_hash,p_filename,p_mime_type,p_size_bytes,p_sha256) returning id into v_id;
  insert into erp_attachments.audit(attachment_id,actor,action) values(v_id,p_user_id,'reserve');
  return jsonb_build_object('attachment',erp_attachments.dto(v_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_attachment_list(p_user_id uuid,p_kind text,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;begin
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,false);
  select coalesce(jsonb_agg(erp_attachments.dto(id) order by created_at,id),'[]'::jsonb) into v from erp_attachments.attachment where document_id=p_document_id;
  return jsonb_build_object('items',v,'document_id',p_document_id,'data_mode','erp_native');
end $$;
create function public.erp_attachment_object(p_user_id uuid,p_kind text,p_document_id uuid,p_id uuid,p_write boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_attachments.attachment%rowtype;begin
  if p_write is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,p_write);
  perform erp_attachments.storage_ready();
  select * into v from erp_attachments.attachment where id=p_id and document_id=p_document_id;
  if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
  if v.status='aborted' or (not p_write and v.status<>'ready') then raise exception 'erp_attachment_not_ready' using errcode='40001'; end if;
  return erp_attachments.dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_attachment_claim(p_user_id uuid,p_kind text,p_document_id uuid,p_id uuid,p_lease uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.attachment%rowtype;begin
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,true);
  perform erp_attachments.storage_ready();
  if p_lease is null then raise exception 'erp_attachment_invalid_lease' using errcode='22023'; end if;
  select * into v from erp_attachments.attachment where id=p_id and document_id=p_document_id for update;
  if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
  if v.status='aborted' or (v.status='reserved' and v.lease_until>clock_timestamp() and (v.lease_token<>p_lease or v.lease_actor<>p_user_id)) then
    raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
  if v.status='reserved' then
    update erp_attachments.attachment set lease_token=p_lease,lease_actor=p_user_id,lease_until=clock_timestamp()+interval '120 seconds' where id=p_id;
  end if;
  return erp_attachments.dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_attachment_finish(p_user_id uuid,p_kind text,p_document_id uuid,p_id uuid,p_lease uuid,p_sha256 text,p_size_bytes integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.attachment%rowtype;v_key text;begin
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,true);
  perform erp_attachments.storage_ready();
  select * into v from erp_attachments.attachment where id=p_id and document_id=p_document_id for update;
  if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
  if p_sha256 is distinct from v.sha256 or p_size_bytes is distinct from v.size_bytes then raise exception 'erp_attachment_integrity_conflict' using errcode='40001'; end if;
  if v.status='ready' then return jsonb_build_object('attachment',erp_attachments.dto(p_id),'replayed',true,'data_mode','erp_native'); end if;
  if v.status<>'reserved' or p_lease is null or v.lease_token is distinct from p_lease or v.lease_actor is distinct from p_user_id or v.lease_until<=clock_timestamp() then
    raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
  v_key:='documents/'||p_document_id||'/'||p_id||'/'||v.sha256;
  if not exists(select 1 from storage.objects where bucket_id='erp-attachments' and name=v_key
    and metadata->>'size'=v.size_bytes::text and metadata->>'mimetype'=v.mime_type) then
    raise exception 'erp_attachment_object_unconfirmed' using errcode='40001'; end if;
  update erp_attachments.attachment set status='ready',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
  insert into erp_attachments.audit(attachment_id,actor,action) values(p_id,p_user_id,'finalize');
  return jsonb_build_object('attachment',erp_attachments.dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_attachment_stop(p_user_id uuid,p_kind text,p_document_id uuid,p_id uuid,p_abort boolean,p_lease uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.attachment%rowtype;begin
  perform erp_attachments.authorize(p_user_id,p_kind,p_document_id,true);
  if p_abort is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
  select * into v from erp_attachments.attachment where id=p_id and document_id=p_document_id for update;
  if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
  if p_abort then
    if v.status='ready' or (v.lease_until>clock_timestamp()) then raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
    if v.status<>'aborted' then
      update erp_attachments.attachment set status='aborted',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
      insert into erp_attachments.audit(attachment_id,actor,action) values(p_id,p_user_id,'abort');
    end if;
  elsif v.status='reserved' and v.lease_token=p_lease and v.lease_actor=p_user_id then
    update erp_attachments.attachment set lease_token=null,lease_actor=null,lease_until=null where id=p_id;
  end if;
  return jsonb_build_object('attachment',erp_attachments.dto(p_id),'data_mode','erp_native');
end $$;
revoke all on all functions in schema erp_attachments from public,anon,authenticated,service_role;
revoke all on function public.erp_attachment_reserve(uuid,text,uuid,uuid,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.erp_attachment_list(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_attachment_object(uuid,text,uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.erp_attachment_claim(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.erp_attachment_finish(uuid,text,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.erp_attachment_stop(uuid,text,uuid,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.erp_attachment_reserve(uuid,text,uuid,uuid,text,text,integer,text) to service_role;
grant execute on function public.erp_attachment_list(uuid,text,uuid) to service_role;
grant execute on function public.erp_attachment_object(uuid,text,uuid,uuid,boolean) to service_role;
grant execute on function public.erp_attachment_claim(uuid,text,uuid,uuid,uuid) to service_role;
grant execute on function public.erp_attachment_finish(uuid,text,uuid,uuid,uuid,text,integer) to service_role;
grant execute on function public.erp_attachment_stop(uuid,text,uuid,uuid,boolean,uuid) to service_role;
commit;
