-- 262: Empresa › Dados da empresa › Sua marca: o logotipo da empresa (Origin "Logo"), no mesmo armazenamento privado dos anexos
-- (bucket erp-attachments, só pelo proxy autenticado da API, chave imutável company/logo/<id>/<sha256>).
-- * Imagem PNG ou JPEG de até 2 MB. Reserva com comando idempotente, envio conferido pelo SHA-256, conclusão só com o objeto
--   confirmado no Storage, cancelamento da reserva e "Remover logo" (exclusão lógica auditada, com comando e repetição).
-- * O logo atual é o último pronto e não excluído; um logo novo substitui o anterior (que fica excluído logicamente, com auditoria).
-- * Ler o logo (para as impressões, como o recibo das contas com "Exibir cabeçalho com logo e informações da empresa") é de
--   qualquer membro ativo, como a identidade da empresa; enviar, cancelar e remover é só do administrador.
-- * As linhas nunca são apagadas. Até 200 envios no total (as reservas canceladas e os logos removidos também contam).
-- Tabelas novas; nenhuma função de outra frente é redefinida. Requer 012 (bucket dos anexos) e 016 (empresa).
begin;

do $$begin
 if to_regprocedure('erp_attachments.storage_ready()') is null or to_regprocedure('erp_company.require_access(uuid,text)') is null then
  raise exception 'company_logo_262_requires_012_016' using errcode='55000'; end if;
 if to_regclass('erp_company.logo') is not null then raise exception 'company_logo_262_already_applied' using errcode='55000'; end if;
end$$;

create table erp_company.logo(
 id uuid primary key default gen_random_uuid(),
 command_id uuid not null unique, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 mime_type text not null check(mime_type in('image/png','image/jpeg')), size_bytes integer not null check(size_bytes between 1 and 2097152),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 status text not null default 'reserved' check(status in('reserved','ready','aborted')),
 lease_token uuid, lease_actor uuid references auth.users(id), lease_until timestamptz,
 finished_by uuid references auth.users(id), created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 deleted_at timestamptz, deleted_by uuid references auth.users(id), delete_command_id uuid unique,
 check((lease_token is null)=(lease_until is null)),
 check(status='reserved' or(lease_token is null and lease_until is null)),
 check((deleted_at is null)=(deleted_by is null)),
 check(deleted_at is null or status='ready')
);
create index erp_company_logo_current on erp_company.logo(status,finished_at desc,id) where deleted_at is null;
create table erp_company.logo_audit(
 id bigint generated always as identity primary key, logo_id uuid not null references erp_company.logo(id),
 actor uuid not null references auth.users(id), action text not null check(action in('reserve','finalize','abort','delete')),
 command_id uuid, created_at timestamptz not null default clock_timestamp()
);
alter table erp_company.logo enable row level security;
alter table erp_company.logo_audit enable row level security;
revoke all on table erp_company.logo,erp_company.logo_audit from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_company from public,anon,authenticated,service_role;

-- The identity and the bytes never change; after leaving "reserved" only the logical deletion may be written, once.
create function erp_company.logo_identity() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_company_logo_no_delete' using errcode='40001'; end if;
 if(new.id,new.command_id,new.actor,new.request_hash,new.mime_type,new.size_bytes,new.sha256,new.created_at)
   is distinct from(old.id,old.command_id,old.actor,old.request_hash,old.mime_type,old.size_bytes,old.sha256,old.created_at)
  or(old.status<>'reserved' and(new.status,new.lease_token,new.lease_actor,new.lease_until,new.finished_by,new.finished_at)
   is distinct from(old.status,old.lease_token,old.lease_actor,old.lease_until,old.finished_by,old.finished_at))
  or(old.deleted_at is not null and(new.deleted_at,new.deleted_by,new.delete_command_id) is distinct from(old.deleted_at,old.deleted_by,old.delete_command_id)) then
  raise exception 'erp_company_logo_immutable' using errcode='40001'; end if;
 return new;
end $$;
create trigger logo_identity before update or delete on erp_company.logo for each row execute function erp_company.logo_identity();
create function erp_company.logo_audit_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_company_logo_immutable' using errcode='40001'; end $$;
create trigger logo_audit_immutable before update or delete on erp_company.logo_audit for each row execute function erp_company.logo_audit_immutable();

-- Reading: any active member (as the identity); writing: the administrador (as the identity). Returns the role.
create function erp_company.logo_authorize(p_user_id uuid,p_write boolean) returns text language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_write is null then raise exception 'erp_company_logo_invalid_action' using errcode='22023'; end if;
 return erp_company.require_access(p_user_id,case when p_write then 'identity' else 'read' end);
end $$;
create function erp_company.logo_dto(p_id uuid,p_internal boolean default false) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',l.id,'mime_type',l.mime_type,'size_bytes',l.size_bytes,'sha256',l.sha256,'status',l.status,'created_at',l.created_at,
  'finished_at',l.finished_at,'deleted',l.deleted_at is not null,'owner_name',(select left(p.name,120) from erp_access.profile p where p.user_id=l.actor))
  ||case when p_internal then jsonb_build_object('bucket','erp-attachments','object_key','company/logo/'||l.id||'/'||l.sha256) else '{}'::jsonb end
 from erp_company.logo l where l.id=p_id
$$;
create function erp_company.logo_row(p_id uuid,p_lock boolean) returns erp_company.logo language plpgsql set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype;
begin
 if p_lock then select * into v from erp_company.logo where id=p_id for update; else select * into v from erp_company.logo where id=p_id; end if;
 if not found then raise exception 'erp_company_logo_not_found' using errcode='P0002'; end if;
 return v;
end $$;
-- The current logo: the latest ready one that is not deleted.
create function erp_company.logo_current() returns uuid language sql stable set search_path=pg_catalog as $$
 select l.id from erp_company.logo l where l.status='ready' and l.deleted_at is null order by l.finished_at desc,l.id desc limit 1
$$;

create function public.erp_company_logo_get(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_role text; v_id uuid;
begin
 v_role:=erp_company.logo_authorize(p_user_id,false);
 v_id:=erp_company.logo_current();
 return jsonb_build_object('scope','company_logo','data_mode','erp_native','can_manage',v_role='admin',
  'logo',case when v_id is null then null else erp_company.logo_dto(v_id) end,
  'pending',case when v_role='admin' then coalesce((select jsonb_agg(erp_company.logo_dto(l.id) order by l.created_at,l.id) from
   (select id,created_at from erp_company.logo where status='reserved' order by created_at,id limit 20) l),'[]'::jsonb) else '[]'::jsonb end);
end $$;
create function public.erp_company_logo_reserve(p_user_id uuid,p_command_id uuid,p_mime_type text,p_size_bytes integer,p_sha256 text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_row erp_company.logo%rowtype; v_id uuid;
begin
 perform erp_company.logo_authorize(p_user_id,true);
 perform erp_attachments.storage_ready();
 if p_command_id is null or p_mime_type is null or p_mime_type not in('image/png','image/jpeg') or p_size_bytes is null or p_size_bytes not between 1 and 2097152
  or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' then raise exception 'erp_company_logo_invalid_metadata' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'mime_type',p_mime_type,'size_bytes',p_size_bytes,'sha256',p_sha256)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('erp_company_logo_command:'||p_command_id::text,0));
 select * into v_row from erp_company.logo where command_id=p_command_id;
 if found then
  if v_row.actor<>p_user_id or v_row.request_hash<>v_hash then raise exception 'erp_company_logo_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('logo',erp_company.logo_dto(v_row.id),'replayed',true,'data_mode','erp_native');
 end if;
 if exists(select 1 from erp_company.logo where delete_command_id=p_command_id) then raise exception 'erp_company_logo_command_conflict' using errcode='40001'; end if;
 -- One lock serializes the quota; aborted and removed logos also count.
 perform pg_advisory_xact_lock(hashtextextended('erp_company_logo_quota',0));
 if(select count(*) from erp_company.logo)>=200 then raise exception 'erp_company_logo_quota' using errcode='54000'; end if;
 insert into erp_company.logo(command_id,actor,request_hash,mime_type,size_bytes,sha256) values(p_command_id,p_user_id,v_hash,p_mime_type,p_size_bytes,p_sha256) returning id into v_id;
 insert into erp_company.logo_audit(logo_id,actor,action,command_id) values(v_id,p_user_id,'reserve',p_command_id);
 return jsonb_build_object('logo',erp_company.logo_dto(v_id),'replayed',false,'data_mode','erp_native');
end $$;
-- Internal metadata (bucket and key) for the proxy: reading a ready logo, or writing (upload) a reserved one.
create function public.erp_company_logo_object(p_user_id uuid,p_id uuid,p_write boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype;
begin
 perform erp_company.logo_authorize(p_user_id,p_write);
 perform erp_attachments.storage_ready();
 v:=erp_company.logo_row(p_id,false);
 if v.status='aborted' or v.deleted_at is not null or(not p_write and v.status<>'ready') then raise exception 'erp_company_logo_not_ready' using errcode='40001'; end if;
 return erp_company.logo_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_company_logo_claim(p_user_id uuid,p_id uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype;
begin
 perform erp_company.logo_authorize(p_user_id,true);
 perform erp_attachments.storage_ready();
 if p_lease is null then raise exception 'erp_company_logo_invalid_lease' using errcode='22023'; end if;
 v:=erp_company.logo_row(p_id,true);
 if v.status='aborted' or v.deleted_at is not null
  or(v.status='reserved' and v.lease_until>clock_timestamp() and(v.lease_token<>p_lease or v.lease_actor<>p_user_id)) then
  raise exception 'erp_company_logo_upload_conflict' using errcode='40001'; end if;
 if v.status='reserved' then
  update erp_company.logo set lease_token=p_lease,lease_actor=p_user_id,lease_until=clock_timestamp()+interval '120 seconds' where id=p_id;
 end if;
 return erp_company.logo_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_company_logo_finish(p_user_id uuid,p_id uuid,p_lease uuid,p_sha256 text,p_size_bytes integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype; v_key text; v_old uuid;
begin
 perform erp_company.logo_authorize(p_user_id,true);
 perform erp_attachments.storage_ready();
 v:=erp_company.logo_row(p_id,true);
 if p_sha256 is distinct from v.sha256 or p_size_bytes is distinct from v.size_bytes then raise exception 'erp_company_logo_integrity_conflict' using errcode='40001'; end if;
 if v.status='ready' then return jsonb_build_object('logo',erp_company.logo_dto(p_id),'replayed',true,'data_mode','erp_native'); end if;
 if v.status<>'reserved' or p_lease is null or v.lease_token is distinct from p_lease or v.lease_actor is distinct from p_user_id or v.lease_until<=clock_timestamp() then
  raise exception 'erp_company_logo_upload_conflict' using errcode='40001'; end if;
 v_key:='company/logo/'||p_id||'/'||v.sha256;
 if not exists(select 1 from storage.objects where bucket_id='erp-attachments' and name=v_key and metadata->>'size'=v.size_bytes::text and metadata->>'mimetype'=v.mime_type) then
  raise exception 'erp_company_logo_object_unconfirmed' using errcode='40001'; end if;
 -- One lock serializes the replacement of the current logo.
 perform pg_advisory_xact_lock(hashtextextended('erp_company_logo_current',0));
 update erp_company.logo set status='ready',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
 insert into erp_company.logo_audit(logo_id,actor,action) values(p_id,p_user_id,'finalize');
 -- The new logo replaces the previous ones (kept, logically deleted and audited).
 for v_old in select l.id from erp_company.logo l where l.status='ready' and l.deleted_at is null and l.id<>p_id order by l.id loop
  update erp_company.logo set deleted_at=clock_timestamp(),deleted_by=p_user_id where id=v_old;
  insert into erp_company.logo_audit(logo_id,actor,action) values(v_old,p_user_id,'delete');
 end loop;
 return jsonb_build_object('logo',erp_company.logo_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_company_logo_stop(p_user_id uuid,p_id uuid,p_abort boolean,p_lease uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype;
begin
 perform erp_company.logo_authorize(p_user_id,true);
 if p_abort is null then raise exception 'erp_company_logo_invalid_action' using errcode='22023'; end if;
 v:=erp_company.logo_row(p_id,true);
 if p_abort then
  if v.status='ready' or v.lease_until>clock_timestamp() then raise exception 'erp_company_logo_upload_conflict' using errcode='40001'; end if;
  if v.status<>'aborted' then
   update erp_company.logo set status='aborted',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
   insert into erp_company.logo_audit(logo_id,actor,action) values(p_id,p_user_id,'abort');
  end if;
 elsif v.status='reserved' and v.lease_token=p_lease and v.lease_actor=p_user_id then
  update erp_company.logo set lease_token=null,lease_actor=null,lease_until=null where id=p_id;
 end if;
 return jsonb_build_object('logo',erp_company.logo_dto(p_id),'data_mode','erp_native');
end $$;
-- "Remover logo": logical deletion of a ready logo, once, by command (the replay returns the same answer).
create function public.erp_company_logo_delete(p_user_id uuid,p_id uuid,p_command_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_company.logo%rowtype;
begin
 perform erp_company.logo_authorize(p_user_id,true);
 if p_command_id is null then raise exception 'erp_company_logo_invalid_action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('erp_company_logo_command:'||p_command_id::text,0));
 v:=erp_company.logo_row(p_id,true);
 if v.delete_command_id=p_command_id then
  if v.deleted_by<>p_user_id then raise exception 'erp_company_logo_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('logo',erp_company.logo_dto(p_id),'replayed',true,'data_mode','erp_native');
 end if;
 if exists(select 1 from erp_company.logo where delete_command_id=p_command_id or command_id=p_command_id) then
  raise exception 'erp_company_logo_command_conflict' using errcode='40001'; end if;
 if v.status<>'ready' or v.deleted_at is not null then raise exception 'erp_company_logo_not_ready' using errcode='40001'; end if;
 update erp_company.logo set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_command_id=p_command_id where id=p_id;
 insert into erp_company.logo_audit(logo_id,actor,action,command_id) values(p_id,p_user_id,'delete',p_command_id);
 return jsonb_build_object('logo',erp_company.logo_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;

revoke all on function erp_company.logo_identity(),erp_company.logo_audit_immutable(),erp_company.logo_authorize(uuid,boolean),erp_company.logo_dto(uuid,boolean),
 erp_company.logo_row(uuid,boolean),erp_company.logo_current() from public,anon,authenticated,service_role;
do $$declare f text;begin foreach f in array array['erp_company_logo_get(uuid)','erp_company_logo_reserve(uuid,uuid,text,integer,text)',
  'erp_company_logo_object(uuid,uuid,boolean)','erp_company_logo_claim(uuid,uuid,uuid)','erp_company_logo_finish(uuid,uuid,uuid,text,integer)',
  'erp_company_logo_stop(uuid,uuid,boolean,uuid)','erp_company_logo_delete(uuid,uuid,uuid)'] loop
 execute format('revoke all on function public.%s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function public.%s to service_role',f);
end loop;end$$;
commit;
