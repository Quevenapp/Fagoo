-- Cadastro de produtos > Imagens, onda D: imagens armazenadas no Brufap (Origin: envio por arrastar e soltar ou "anexar arquivos",
-- "Imagens armazenadas", ordem e remoção), além das imagens externas de 119.
-- * Armazenamento privado já existente dos anexos (bucket erp-attachments, só pelo proxy autenticado da API), chave imutável
--   products/<produto>/<imagem>/<sha256>. PNG ou JPEG de até 2 MB. Nada é sobrescrito nem apagado do Storage.
-- * Reserva com comando idempotente, envio conferido pelo SHA-256 e pelo tamanho, finalização só com o objeto confirmado no
--   Storage (lease de 120 segundos), cancelamento da reserva, exclusão lógica auditada e a ordem das imagens por comando.
-- * Até 20 imagens prontas por produto e 60 registros por produto (contando reservas canceladas e imagens excluídas, o que limita
--   objetos órfãos de envios interrompidos). Produto excluído não recebe nem perde imagens.
-- * Permissões: ver exige ler produtos; enviar, cancelar, excluir e ordenar exigem gravar produtos.
-- As imagens não mudam a versão do produto (como a foto do contato). Não altera estoque, financeiro, fiscal nem o Origin.
-- Requer 012 (armazenamento dos anexos) e 119.
begin;

do $$begin
 if to_regprocedure('erp_attachments.storage_ready()') is null or to_regclass('erp_catalog.product_detail') is null then
  raise exception 'product_images_193_requires_012_119' using errcode='55000'; end if;
end$$;

create table erp_catalog.product_stored_image(
 id uuid primary key default gen_random_uuid(), product_id uuid not null references erp_catalog.product(record_id),
 command_id uuid not null unique, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 filename text not null, mime_type text not null check(mime_type in('image/png','image/jpeg')), size_bytes integer not null check(size_bytes between 1 and 2097152),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 status text not null default 'reserved' check(status in('reserved','ready','aborted')),
 lease_token uuid, lease_actor uuid references auth.users(id), lease_until timestamptz,
 finished_by uuid references auth.users(id), created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 position integer check(position between 1 and 20),
 deleted_at timestamptz, deleted_by uuid references auth.users(id), delete_command_id uuid unique,
 check((lease_token is null)=(lease_until is null)),
 check(status='reserved' or(lease_token is null and lease_until is null)),
 check((deleted_at is null)=(deleted_by is null)),
 check(deleted_at is null or status='ready'),
 check((position is not null)=(status='ready' and deleted_at is null))
);
create index erp_catalog_product_stored_image_product on erp_catalog.product_stored_image(product_id,status,position);
-- One image per position; checked at commit so a new order can be written image by image (NULL positions never collide).
alter table erp_catalog.product_stored_image add constraint erp_catalog_product_stored_image_position unique(product_id,position) deferrable initially deferred;
create table erp_catalog.product_image_audit(
 id bigint generated always as identity primary key, image_id uuid references erp_catalog.product_stored_image(id), product_id uuid not null,
 actor uuid not null references auth.users(id), action text not null check(action in('reserve','finalize','abort','delete','order')),
 command_id uuid, after_data jsonb, created_at timestamptz not null default clock_timestamp()
);
create table erp_catalog.product_image_command(
 command_id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
 foreach t in array array['product_stored_image','product_image_audit','product_image_command'] loop
  execute format('alter table erp_catalog.%I enable row level security',t);
  execute format('revoke all on table erp_catalog.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke all on all sequences in schema erp_catalog from public,anon,authenticated,service_role;

-- The identity and the bytes never change; leaving "reserved" is final; only the position and the logical deletion change later.
create function erp_catalog.product_image_identity() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_attachment_no_delete' using errcode='40001'; end if;
 if(new.id,new.product_id,new.command_id,new.actor,new.request_hash,new.filename,new.mime_type,new.size_bytes,new.sha256,new.created_at)
   is distinct from(old.id,old.product_id,old.command_id,old.actor,old.request_hash,old.filename,old.mime_type,old.size_bytes,old.sha256,old.created_at)
  or(old.status<>'reserved' and(new.status,new.lease_token,new.lease_actor,new.lease_until,new.finished_by,new.finished_at)
   is distinct from(old.status,old.lease_token,old.lease_actor,old.lease_until,old.finished_by,old.finished_at))
  or(old.deleted_at is not null and(new.deleted_at,new.deleted_by,new.delete_command_id,new.position) is distinct from(old.deleted_at,old.deleted_by,old.delete_command_id,old.position)) then
  raise exception 'erp_attachment_immutable' using errcode='40001'; end if;
 return new;
end $$;
create trigger erp_catalog_product_image_identity before update or delete on erp_catalog.product_stored_image for each row execute function erp_catalog.product_image_identity();

create function erp_catalog.product_image_authorize(p_user_id uuid,p_product_id uuid,p_write boolean) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_write is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
 perform erp_catalog.require_access(p_user_id,'products',p_write);
 if p_product_id is null or not exists(select 1 from erp_catalog.product p join erp_catalog.record r on r.id=p.record_id where p.record_id=p_product_id and r.entity='products') then
  raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 if p_write and exists(select 1 from erp_catalog.product_detail d where d.record_id=p_product_id and d.deleted_at is not null) then
  raise exception 'erp_catalog_product_deleted' using errcode='40001'; end if;
end $$;
create function erp_catalog.product_image_dto(p_id uuid,p_internal boolean default false) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',f.id,'product_id',f.product_id,'filename',f.filename,'mime_type',f.mime_type,'size_bytes',f.size_bytes,'sha256',f.sha256,
  'status',f.status,'position',f.position,'created_at',f.created_at,'finished_at',f.finished_at,'deleted',f.deleted_at is not null,
  'owner_name',(select left(p.name,120) from erp_access.profile p where p.user_id=f.actor))
  ||case when p_internal then jsonb_build_object('bucket','erp-attachments','object_key','products/'||f.product_id||'/'||f.id||'/'||f.sha256) else '{}'::jsonb end
 from erp_catalog.product_stored_image f where f.id=p_id
$$;
create function erp_catalog.product_image_row(p_product_id uuid,p_id uuid,p_lock boolean) returns erp_catalog.product_stored_image
language plpgsql set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype;
begin
 if p_lock then select * into v from erp_catalog.product_stored_image where id=p_id and product_id=p_product_id for update;
 else select * into v from erp_catalog.product_stored_image where id=p_id and product_id=p_product_id; end if;
 if not found then raise exception 'erp_attachment_not_found' using errcode='P0002'; end if;
 return v;
end $$;
create function erp_catalog.product_images_data(p_product_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('product_id',p_product_id,
  'items',coalesce((select jsonb_agg(erp_catalog.product_image_dto(f.id) order by f.position) from erp_catalog.product_stored_image f
   where f.product_id=p_product_id and f.status='ready' and f.deleted_at is null),'[]'::jsonb),
  'pending',coalesce((select jsonb_agg(erp_catalog.product_image_dto(f.id) order by f.created_at,f.id) from erp_catalog.product_stored_image f
   where f.product_id=p_product_id and f.status='reserved'),'[]'::jsonb),
  'stored_bytes',(select coalesce(sum(f.size_bytes),0) from erp_catalog.product_stored_image f where f.product_id=p_product_id and f.status='ready' and f.deleted_at is null)::text,
  'limit',20,'data_mode','erp_native')
$$;

create function public.erp_catalog_product_images(p_user_id uuid,p_product_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,false);
 return erp_catalog.product_images_data(p_product_id);
end $$;
create function public.erp_catalog_product_image_reserve(p_user_id uuid,p_product_id uuid,p_command_id uuid,p_filename text,p_mime_type text,p_size_bytes integer,p_sha256 text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_row erp_catalog.product_stored_image%rowtype; v_id uuid; v_ext text;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 perform erp_attachments.storage_ready();
 v_ext:=case p_mime_type when 'image/png' then 'png' when 'image/jpeg' then 'jpg' end;
 if p_command_id is null or v_ext is null or p_size_bytes is null or p_size_bytes not between 1 and 2097152 or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$'
  or p_filename is null or p_filename!~('^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.'||v_ext||'$') then
  raise exception 'erp_attachment_invalid_metadata' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'product_id',p_product_id,'filename',p_filename,'mime_type',p_mime_type,'size_bytes',p_size_bytes,'sha256',p_sha256)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852914,hashtext(p_command_id::text));
 select * into v_row from erp_catalog.product_stored_image where command_id=p_command_id;
 if found then
  if v_row.actor<>p_user_id or v_row.request_hash<>v_hash then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('image',erp_catalog.product_image_dto(v_row.id),'replayed',true,'data_mode','erp_native');
 end if;
 -- One lock per product serializes the quotas: 20 ready images and 60 records (aborted and deleted ones count).
 perform pg_advisory_xact_lock(174852915,hashtext(p_product_id::text));
 if(select count(*) from erp_catalog.product_stored_image where product_id=p_product_id)>=60
  or(select count(*) from erp_catalog.product_stored_image where product_id=p_product_id and(status='reserved' or(status='ready' and deleted_at is null)))>=20 then
  raise exception 'erp_attachment_quota' using errcode='54000'; end if;
 insert into erp_catalog.product_stored_image(product_id,command_id,actor,request_hash,filename,mime_type,size_bytes,sha256)
  values(p_product_id,p_command_id,p_user_id,v_hash,p_filename,p_mime_type,p_size_bytes,p_sha256) returning id into v_id;
 insert into erp_catalog.product_image_audit(image_id,product_id,actor,action,command_id) values(v_id,p_product_id,p_user_id,'reserve',p_command_id);
 return jsonb_build_object('image',erp_catalog.product_image_dto(v_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_catalog_product_image_object(p_user_id uuid,p_product_id uuid,p_id uuid,p_write boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,coalesce(p_write,false));
 perform erp_attachments.storage_ready();
 v:=erp_catalog.product_image_row(p_product_id,p_id,false);
 if v.status='aborted' or v.deleted_at is not null or(not coalesce(p_write,false) and v.status<>'ready') then raise exception 'erp_attachment_not_ready' using errcode='40001'; end if;
 return erp_catalog.product_image_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_catalog_product_image_claim(p_user_id uuid,p_product_id uuid,p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 perform erp_attachments.storage_ready();
 if p_lease is null then raise exception 'erp_attachment_invalid_lease' using errcode='22023'; end if;
 v:=erp_catalog.product_image_row(p_product_id,p_id,true);
 if v.status='aborted' or v.deleted_at is not null
  or(v.status='reserved' and v.lease_until>clock_timestamp() and(v.lease_token<>p_lease or v.lease_actor<>p_user_id)) then
  raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
 if v.status='reserved' then
  update erp_catalog.product_stored_image set lease_token=p_lease,lease_actor=p_user_id,lease_until=clock_timestamp()+interval '120 seconds' where id=p_id;
 end if;
 return erp_catalog.product_image_dto(p_id,true)||jsonb_build_object('data_mode','erp_native');
end $$;
create function public.erp_catalog_product_image_finish(p_user_id uuid,p_product_id uuid,p_id uuid,p_lease uuid,p_sha256 text,p_size_bytes integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype; v_key text;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 perform erp_attachments.storage_ready();
 -- Product lock before the image row, the same order as the removal and the new order (no deadlock between them).
 perform pg_advisory_xact_lock(174852915,hashtext(p_product_id::text));
 v:=erp_catalog.product_image_row(p_product_id,p_id,true);
 if p_sha256 is distinct from v.sha256 or p_size_bytes is distinct from v.size_bytes then raise exception 'erp_attachment_integrity_conflict' using errcode='40001'; end if;
 if v.status='ready' then return jsonb_build_object('image',erp_catalog.product_image_dto(p_id),'replayed',true,'data_mode','erp_native'); end if;
 if v.status<>'reserved' or p_lease is null or v.lease_token is distinct from p_lease or v.lease_actor is distinct from p_user_id or v.lease_until<=clock_timestamp() then
  raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
 v_key:='products/'||p_product_id||'/'||p_id||'/'||v.sha256;
 if not exists(select 1 from storage.objects where bucket_id='erp-attachments' and name=v_key and metadata->>'size'=v.size_bytes::text and metadata->>'mimetype'=v.mime_type) then
  raise exception 'erp_attachment_object_unconfirmed' using errcode='40001'; end if;
 update erp_catalog.product_stored_image set status='ready',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp(),
  position=(select coalesce(max(position),0)+1 from erp_catalog.product_stored_image where product_id=p_product_id and position is not null) where id=p_id;
 insert into erp_catalog.product_image_audit(image_id,product_id,actor,action) values(p_id,p_product_id,p_user_id,'finalize');
 return jsonb_build_object('image',erp_catalog.product_image_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;
create function public.erp_catalog_product_image_stop(p_user_id uuid,p_product_id uuid,p_id uuid,p_abort boolean,p_lease uuid default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 if p_abort is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
 v:=erp_catalog.product_image_row(p_product_id,p_id,true);
 if p_abort then
  if v.status='ready' or v.lease_until>clock_timestamp() then raise exception 'erp_attachment_upload_conflict' using errcode='40001'; end if;
  if v.status<>'aborted' then
   update erp_catalog.product_stored_image set status='aborted',lease_token=null,lease_actor=null,lease_until=null,finished_by=p_user_id,finished_at=clock_timestamp() where id=p_id;
   insert into erp_catalog.product_image_audit(image_id,product_id,actor,action) values(p_id,p_product_id,p_user_id,'abort');
  end if;
 elsif v.status='reserved' and v.lease_token=p_lease and v.lease_actor=p_user_id then
  update erp_catalog.product_stored_image set lease_token=null,lease_actor=null,lease_until=null where id=p_id;
 end if;
 return jsonb_build_object('image',erp_catalog.product_image_dto(p_id),'data_mode','erp_native');
end $$;
-- Remover imagem: logical deletion of a ready image, once, by command; the images after it move up one position.
create function public.erp_catalog_product_image_delete(p_user_id uuid,p_product_id uuid,p_id uuid,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v erp_catalog.product_stored_image%rowtype; v_next record;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 if p_command_id is null then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(174852914,hashtext(p_command_id::text));
 perform pg_advisory_xact_lock(174852915,hashtext(p_product_id::text));
 v:=erp_catalog.product_image_row(p_product_id,p_id,true);
 if v.delete_command_id=p_command_id then
  if v.deleted_by<>p_user_id then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('image',erp_catalog.product_image_dto(p_id),'replayed',true,'data_mode','erp_native');
 end if;
 if exists(select 1 from erp_catalog.product_stored_image where delete_command_id=p_command_id or command_id=p_command_id)
  or exists(select 1 from erp_catalog.product_image_command where command_id=p_command_id) then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
 if v.status<>'ready' or v.deleted_at is not null then raise exception 'erp_attachment_not_ready' using errcode='40001'; end if;
 update erp_catalog.product_stored_image set deleted_at=clock_timestamp(),deleted_by=p_user_id,delete_command_id=p_command_id,position=null where id=p_id;
 for v_next in select id,position from erp_catalog.product_stored_image where product_id=p_product_id and position>v.position order by position loop
  update erp_catalog.product_stored_image set position=v_next.position-1 where id=v_next.id;
 end loop;
 insert into erp_catalog.product_image_audit(image_id,product_id,actor,action,command_id) values(p_id,p_product_id,p_user_id,'delete',p_command_id);
 return jsonb_build_object('image',erp_catalog.product_image_dto(p_id),'replayed',false,'data_mode','erp_native');
end $$;
-- Ordem das imagens: every ready image of the product, once, in the new order (the first is the main stored image).
create function public.erp_catalog_product_image_order(p_user_id uuid,p_product_id uuid,p_command_id uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_stored erp_catalog.product_image_command%rowtype; v_result jsonb; v_current uuid[]; n integer;
begin
 perform erp_catalog.product_image_authorize(p_user_id,p_product_id,true);
 if p_command_id is null or p_ids is null or cardinality(p_ids) not between 1 and 20 or array_position(p_ids,null) is not null
  or(select count(distinct x) from unnest(p_ids) x)<>cardinality(p_ids) then raise exception 'erp_attachment_invalid_action' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','image_order','product_id',p_product_id,'ids',to_jsonb(p_ids))::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852914,hashtext(p_command_id::text));
 select * into v_stored from erp_catalog.product_image_command where command_id=p_command_id;
 if found then
  if v_stored.actor<>p_user_id or v_stored.request_hash<>v_hash then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
  return v_stored.result||'{"replayed":true}'::jsonb;
 end if;
 if exists(select 1 from erp_catalog.product_stored_image where command_id=p_command_id or delete_command_id=p_command_id) then raise exception 'erp_attachment_command_conflict' using errcode='40001'; end if;
 perform pg_advisory_xact_lock(174852915,hashtext(p_product_id::text));
 select coalesce(array_agg(id order by id),'{}') into v_current from erp_catalog.product_stored_image where product_id=p_product_id and position is not null;
 if v_current is distinct from(select array_agg(x order by x) from unnest(p_ids) x) then raise exception 'erp_attachment_order_conflict' using errcode='40001'; end if;
 -- The unique position is checked at commit, so the images can move one by one.
 for n in 1..cardinality(p_ids) loop update erp_catalog.product_stored_image set position=n where id=p_ids[n]; end loop;
 v_result:=erp_catalog.product_images_data(p_product_id)||jsonb_build_object('replayed',false);
 insert into erp_catalog.product_image_audit(product_id,actor,action,command_id,after_data) values(p_product_id,p_user_id,'order',p_command_id,jsonb_build_object('ids',to_jsonb(p_ids)));
 insert into erp_catalog.product_image_command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on all functions in schema erp_catalog from public,anon,authenticated,service_role;
do $$ declare f text; begin
 foreach f in array array['erp_catalog_product_images(uuid,uuid)','erp_catalog_product_image_reserve(uuid,uuid,uuid,text,text,integer,text)',
  'erp_catalog_product_image_object(uuid,uuid,uuid,boolean)','erp_catalog_product_image_claim(uuid,uuid,uuid,uuid)',
  'erp_catalog_product_image_finish(uuid,uuid,uuid,uuid,text,integer)','erp_catalog_product_image_stop(uuid,uuid,uuid,boolean,uuid)',
  'erp_catalog_product_image_delete(uuid,uuid,uuid,uuid)','erp_catalog_product_image_order(uuid,uuid,uuid,uuid[])'] loop
  execute format('revoke all on function public.%s from public,anon,authenticated',f);
  execute format('grant execute on function public.%s to service_role',f);
 end loop;
end $$;
commit;
