-- 272: Documentos (onda F), parte 6: Foto do Funcionário (Cadastros › Funcionários), no mesmo armazenamento privado dos anexos
-- (bucket erp-attachments, só pelo proxy autenticado da API), como a Foto de Clientes e fornecedores (170).
-- * Foto: imagem PNG ou JPEG de até 2 MB; a foto atual é a última pronta e não excluída. Uma foto nova substitui a anterior (a anterior
--   fica excluída logicamente, com auditoria); "Remover foto" é a exclusão lógica. Reserva com comando idempotente, envio conferido pelo
--   SHA-256 e finalização só com o objeto confirmado no Storage; até 100 registros por funcionário.
-- * Permissões: como todo o cadastro de Funcionários (128), somente o administrador lê e grava. As linhas nunca são apagadas; objetos
--   com chave imutável employees/<funcionário>/<id>/<sha>.
-- Nenhuma função de outra área é substituída. Nada escreve no Origin.
begin;

do $$begin
 if to_regclass('erp_catalog.employee') is null or to_regclass('erp_attachments.contact_file') is null then
  raise exception 'employee_photo_272_requires_128_170' using errcode='55000'; end if;
end$$;

create table erp_attachments.employee_file (
  id uuid primary key default gen_random_uuid(), employee_id uuid not null references erp_catalog.employee(id),
  command_id uuid not null unique, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
  filename text not null, mime_type text not null check(mime_type in('image/png','image/jpeg')), size_bytes integer not null check(size_bytes between 1 and 2097152),
  sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
  status text not null default 'reserved' check(status in('reserved','ready','aborted')),
  lease_token uuid, lease_actor uuid references auth.users(id), lease_until timestamptz,
  finished_by uuid references auth.users(id), created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
  deleted_at timestamptz, deleted_by uuid references auth.users(id), delete_command_id uuid unique,
  check((lease_token is null)=(lease_until is null)),
  check(status='reserved' or (lease_token is null and lease_until is null)),
  check((deleted_at is null)=(deleted_by is null)),
  check(deleted_at is null or status='ready')
);
create index erp_attachments_employee_file on erp_attachments.employee_file(employee_id,created_at,id);
create table erp_attachments.employee_file_audit (
  id bigint generated always as identity primary key, file_id uuid not null references erp_attachments.employee_file(id),
  actor uuid not null references auth.users(id), action text not null check(action in('reserve','finalize','abort','delete')),
  command_id uuid, created_at timestamptz not null default clock_timestamp()
);
alter table erp_attachments.employee_file enable row level security;
alter table erp_attachments.employee_file_audit enable row level security;
revoke all on table erp_attachments.employee_file,erp_attachments.employee_file_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_attachments from public,anon,authenticated,service_role;

-- The identity and the bytes never change; after leaving "reserved" only the logical deletion may be written, once.
create function erp_attachments.employee_file_identity() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' then raise exception 'erp_attachment_no_delete' using errcode='40001'; end if;
  if (new.id,new.employee_id,new.command_id,new.actor,new.request_hash,new.filename,new.mime_type,new.size_bytes,new.sha256,new.created_at)
    is distinct from (old.id,old.employee_id,old.command_id,old.actor,old.request_hash,old.filename,old.mime_type,old.size_bytes,old.sha256,old.created_at)
    or (old.status<>'reserved' and (new.status,new.lease_token,new.lease_actor,new.lease_until,new.finished_by,new.finished_at)
      is distinct from (old.status,old.lease_token,old.lease_actor,old.lease_until,old.finished_by,old.finished_at))
    or (old.deleted_at is not null and (new.deleted_at,new.deleted_by,new.delete_command_id) is distinct from (old.deleted_at,old.deleted_by,old.delete_command_id)) then
    raise exception 'erp_attachment_immutable' using errcode='40001'; end if;
  return new;
end $$;
create trigger employee_file_identity before update or delete on erp_attachments.employee_file for each row execute function erp_attachments.employee_file_identity();
create function erp_attachments.employee_file_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_attachment_immutable' using errcode='40001'; end $$;
create trigger employee_file_audit_immutable before update or delete on erp_attachments.employee_file_audit for each row execute function erp_attachments.employee_file_audit_immutable();

-- Funcionários are read and written only by the administrator (128).
create function erp_attachments.employee_authorize(p_user_id uuid,p_employee_id uuid,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
  if p_write is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
  perform erp_catalog.employee_admin(p_user_id);
  if p_employee_id is null or not exists(select 1 from erp_catalog.employee e where e.id=p_employee_id) then
    raise exception 'erp_attachment_employee_not_found' using errcode='P0002'; end if;
end $$;
create function erp_attachments.employee_dto(p_id uuid,p_internal boolean default false) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',f.id,'employee_id',f.employee_id,'purpose','photo','filename',f.filename,'mime_type',f.mime_type,
    'size_bytes',f.size_bytes,'sha256',f.sha256,'status',f.status,'created_at',f.created_at,'finished_at',f.finished_at,
    'deleted',f.deleted_at is not null,'owner_name',(select left(p.name,120) from erp_access.profile p where p.user_id=f.actor))
    ||case when p_internal then jsonb_build_object('bucket','erp-attachments','object_key','employees/'||f.employee_id||'/'||f.id||'/'||f.sha256) else '{}'::jsonb end
  from erp_attachments.employee_file f where f.id=p_id
$$;
create function erp_attachments.employee_row(p_employee_id uuid,p_id uuid,p_lock boolean) returns erp_attachments.employee_file
language plpgsql set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype;
begin
  if p_lock then select * into v from erp_attachments.employee_file where id=p_id and employee_id=p_employee_id for update;
  else select * into v from erp_attachments.employee_file where id=p_id and employee_id=p_employee_id; end if;
  if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
  return v;
end $$;

create function public.erp_attachment_employee_list(p_user_id uuid,p_employee_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_photo uuid;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,false);
  select f.id into v_photo from erp_attachments.employee_file f where f.employee_id=p_employee_id and f.status='ready' and f.deleted_at is null
    order by f.finished_at desc,f.id desc limit 1;
  return jsonb_build_object('employee_id',p_employee_id,'photo',case when v_photo is null then null else erp_attachments.employee_dto(v_photo) end,
    'pending_photos',coalesce((select jsonb_agg(erp_attachments.employee_dto(x.id) order by x.created_at,x.id) from (select f.id,f.created_at from erp_attachments.employee_file f
      where f.employee_id=p_employee_id and f.status='reserved' order by f.created_at,f.id limit 100) x),'[]'::jsonb),'data_mode','erp_native');
end $$;
create function public.erp_attachment_employee_reserve(p_user_id uuid,p_employee_id uuid,p_command_id uuid,p_filename text,p_mime_type text,p_size_bytes integer,p_sha256 text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_row erp_attachments.employee_file%rowtype; v_id uuid; v_ext text;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,true);
  perform erp_attachments.storage_ready();
  v_ext:=case p_mime_type when 'image/png' then 'png' when 'image/jpeg' then 'jpg' end;
  if p_command_id is null or p_filename is null or v_ext is null or p_size_bytes is null or p_size_bytes not between 1 and 2097152
    or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' or p_filename!~('^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.'||v_ext||'$') then
    raise exception 'erp_attachment_invalid_metadata' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'employee_id',p_employee_id,'filename',p_filename,'mime_type',p_mime_type,
    'size_bytes',p_size_bytes,'sha256',p_sha256)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(174852912,hashtext(p_command_id::text));
  select * into v_row from erp_attachments.employee_file where command_id=p_command_id;
  if found then
    if v_row.actor<>p_user_id or v_row.request_hash<>v_hash then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
    return jsonb_build_object('attachment',erp_attachments.employee_dto(v_row.id),'replayed',true,'data_mode','erp_native');
  end if;
  -- One lock per funcionário serializes the quota; aborted and deleted records also count.
  perform pg_advisory_xact_lock(174852914,hashtext(p_employee_id::text));
  if (select count(*) from erp_attachments.employee_file where employee_id=p_employee_id)>=100 then
    raise exception 'erp_attachment_quota' using errcode='54000'; end if;
  insert into erp_attachments.employee_file(employee_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256)
    values(p_employee_id,p_command_id,p_user_id,v_hash,p_filename,p_mime_type,p_size_bytes,p_sha256) returning id into v_id;
  insert into erp_attachments.employee_file_audit(file_id,actor,action,command_id) values(v_id,p_user_id,'reserve',p_command_id);
  return jsonb_build_object('attachment',erp_attachments.employee_dto(v_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_attachment_employee_object(p_user_id uuid,p_employee_id uuid,p_id uuid,p_write boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,p_write);
  perform erp_attachments.storage_ready();
  v:=erp_attachments.employee_row(p_employee_id,p_id,false);
  if v.status='aborted' or v.deleted_at is not null or (not p_write and v.status<>'ready') then
    raise exception 'erp_attachment_not_ready' using errcode='40001'; end if;
  return erp_attachments.employee_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_attachment_employee_claim(p_user_id uuid,p_employee_id uuid,p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,true);
  perform erp_attachments.storage_ready();
  if p_lease is null then raise exception 'erp_attachment_invalid_lease' using errcode='22023'; end if;
  v:=erp_attachments.employee_row(p_employee_id,p_id,true);
  if v.status='aborted' or v.deleted_at is not null
    or (v.status='reserved' and v.lease_until>clock_timestamp() and (v.lease_token<>p_lease or v.lease_actor<>p_user_id)) then
    raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
  if v.status='reserved' then
    update erp_attachments.employee_file set lease_token=p_lease,lease_actor=p_user_id,lease_until=clock_timestamp()+interval '120 seconds' where id=p_id;
  end if;
  return erp_attachments.employee_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_attachment_employee_finish(p_user_id uuid,p_employee_id uuid,p_id uuid,p_lease uuid,p_sha256 text,p_size_bytes integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype; v_key text; v_old uuid;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,true);
  perform erp_attachments.storage_ready();
  v:=erp_attachments.employee_row(p_employee_id,p_id,true);
  if p_sha256 is distinct from v.sha256 or p_size_bytes is distinct from v.size_bytes then raise exception 'erp_attachment_integrity_conflict' using errcode='40001'; end if;
  if v.status='ready' then return jsonb_build_object('attachment',erp_attachments.employee_dto(p_id),'replayed',true,'data_mode','erp_native'); end if;
  if v.status<>'reserved' or p_lease is null or v.lease_token is distinct from p_lease or v.lease_actor is distinct from p_user_id or v.lease_until<=clock_timestamp() then
    raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
  v_key:='employees/'||p_employee_id||'/'||p_id||'/'||v.sha256;
  if not exists(select 1 from storage.objects where bucket_id='erp-attachments' and name=v_key
    and metadata->>'size'=v.size_bytes::text and metadata->>'mimetype'=v.mime_type) then
    raise exception 'erp_attachment_object_unconfirmed' using errcode='40001'; end if;
  update erp_attachments.employee_file set status='ready',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
  insert into erp_attachments.employee_file_audit(file_id,actor,action) values(p_id,p_user_id,'finalize');
  -- A new foto replaces the previous one (kept, logically deleted and audited).
  for v_old in select f.id from erp_attachments.employee_file f where f.employee_id=p_employee_id and f.status='ready' and f.deleted_at is null and f.id<>p_id loop
    update erp_attachments.employee_file set deleted_at=clock_timestamp(),deleted_by=p_user_id where id=v_old;
    insert into erp_attachments.employee_file_audit(file_id,actor,action) values(v_old,p_user_id,'delete');
  end loop;
  return jsonb_build_object('attachment',erp_attachments.employee_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_attachment_employee_stop(p_user_id uuid,p_employee_id uuid,p_id uuid,p_abort boolean,p_lease uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,true);
  if p_abort is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
  v:=erp_attachments.employee_row(p_employee_id,p_id,true);
  if p_abort then
    if v.status='ready' or v.lease_until>clock_timestamp() then raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
    if v.status<>'aborted' then
      update erp_attachments.employee_file set status='aborted',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
      insert into erp_attachments.employee_file_audit(file_id,actor,action) values(p_id,p_user_id,'abort');
    end if;
  elsif v.status='reserved' and v.lease_token=p_lease and v.lease_actor=p_user_id then
    update erp_attachments.employee_file set lease_token=null,lease_actor=null,lease_until=null where id=p_id;
  end if;
  return jsonb_build_object('attachment',erp_attachments.employee_dto(p_id),'data_mode','erp_native');
end $$;
-- "Remover foto": logical deletion of a ready file, once, by command (replay returns the same answer).
create function public.erp_attachment_employee_delete(p_user_id uuid,p_employee_id uuid,p_id uuid,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_attachments.employee_file%rowtype;
begin
  perform erp_attachments.employee_authorize(p_user_id,p_employee_id,true);
  if p_command_id is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(174852912,hashtext(p_command_id::text));
  v:=erp_attachments.employee_row(p_employee_id,p_id,true);
  if v.delete_command_id=p_command_id then
    if v.deleted_by<>p_user_id then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
    return jsonb_build_object('attachment',erp_attachments.employee_dto(p_id),'replayed',true,'data_mode','erp_native');
  end if;
  if exists(select 1 from erp_attachments.employee_file where delete_command_id=p_command_id or command_id=p_command_id) then
    raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
  if v.status<>'ready' or v.deleted_at is not null then raise exception 'erp_attachment_not_ready' using errcode='40001'; end if;
  update erp_attachments.employee_file set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_command_id=p_command_id where id=p_id;
  insert into erp_attachments.employee_file_audit(file_id,actor,action,command_id) values(p_id,p_user_id,'delete',p_command_id);
  return jsonb_build_object('attachment',erp_attachments.employee_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;

revoke all on function erp_attachments.employee_file_identity(),erp_attachments.employee_file_audit_immutable(),erp_attachments.employee_authorize(uuid,uuid,boolean),
  erp_attachments.employee_dto(uuid,boolean),erp_attachments.employee_row(uuid,uuid,boolean) from public,anon,authenticated,service_role;
do $$declare f text;begin
 foreach f in array array['erp_attachment_employee_list(uuid,uuid)','erp_attachment_employee_reserve(uuid,uuid,uuid,text,text,integer,text)',
  'erp_attachment_employee_object(uuid,uuid,uuid,boolean)','erp_attachment_employee_claim(uuid,uuid,uuid,uuid)','erp_attachment_employee_finish(uuid,uuid,uuid,uuid,text,integer)',
  'erp_attachment_employee_stop(uuid,uuid,uuid,boolean,uuid)','erp_attachment_employee_delete(uuid,uuid,uuid,uuid)'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end$$;
commit;
