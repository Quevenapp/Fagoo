-- Leva H, lane plataforma (PRF-029): Backup e Exportação › Backup, a exportação dos dados da empresa.
-- * O administrador pede a exportação (comando idempotente; uma por vez). O pedido vira uma tarefa company_export (330), que o
--   Worker executa em etapas: lê as tabelas permitidas em páginas de até ~700 kB, inclui os arquivos anexados (bucket
--   erp-attachments) e grava um ZIP no bucket privado brufap-exports, chave exports/<exportação>/<sha256>.zip.
-- * Só entram os dados da empresa: as tabelas dos esquemas de negócio desta instalação (cadastros, documentos, finanças, estoque,
--   notas, empresa, preferências, página inicial, frente de caixa, preços, recebimentos, anexos, atividades, cobrança e a cópia
--   espelhada do Origin). Ficam fora credenciais, tokens, cofre do certificado A1, usuários do Auth e as tabelas internas das
--   tarefas. O manifesto do pacote registra o escopo, a data e o que ficou de fora.
-- * O pacote fica disponível por 7 dias. Baixar exige o administrador ativo e gera um link assinado de 2 minutos (cada link fica
--   registrado). Depois do prazo, a tarefa diária export_cleanup apaga o objeto e marca a exportação como expirada.
-- Tabelas e funções novas; nenhuma função de outra frente é redefinida. Requer 330.
begin;

do $$begin
 if to_regclass('erp_platform.task') is null or to_regprocedure('erp_platform.task_held(uuid,uuid)') is null then
  raise exception 'platform_331_requires_330' using errcode='55000'; end if;
 if to_regclass('erp_platform.export') is not null then raise exception 'platform_331_already_applied' using errcode='55000'; end if;
end$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('brufap-exports','brufap-exports',false,52428800,array['application/zip']) on conflict(id) do nothing;
create policy brufap_exports_proxy_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'brufap-exports') with check(bucket_id<>'brufap-exports');

create table erp_platform.export(
 id uuid primary key default gen_random_uuid(),
 command_id uuid not null unique,requested_by uuid not null references auth.users(id),
 task_id uuid not null unique references erp_platform.task(id),
 object_key text check(object_key is null or object_key~'^exports/[a-f0-9-]{36}/[a-f0-9]{64}\.zip$'),
 size_bytes bigint check(size_bytes is null or size_bytes between 22 and 52428800),
 sha256 text check(sha256 is null or sha256~'^[a-f0-9]{64}$'),
 manifest jsonb check(manifest is null or jsonb_typeof(manifest)='object' and length(manifest::text)<=16384),
 created_at timestamptz not null default clock_timestamp(),ready_at timestamptz,expires_at timestamptz,removed_at timestamptz,
 check((object_key is null)=(ready_at is null) and (ready_at is null)=(sha256 is null) and (ready_at is null)=(size_bytes is null) and (ready_at is null)=(expires_at is null)),
 check(removed_at is null or ready_at is not null)
);
create table erp_platform.export_link(
 id bigint generated always as identity primary key,export_id uuid not null references erp_platform.export(id),
 actor uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp()
);
alter table erp_platform.export enable row level security;
alter table erp_platform.export_link enable row level security;
revoke all on table erp_platform.export,erp_platform.export_link from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_platform from public,anon,authenticated,service_role;
create function erp_platform.export_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' or(new.id,new.command_id,new.requested_by,new.task_id,new.created_at) is distinct from(old.id,old.command_id,old.requested_by,old.task_id,old.created_at)
  or old.ready_at is not null and(new.object_key,new.size_bytes,new.sha256,new.manifest,new.ready_at,new.expires_at) is distinct from(old.object_key,old.size_bytes,old.sha256,old.manifest,old.ready_at,old.expires_at)
  or old.removed_at is not null then
  raise exception 'erp_platform_export_immutable' using errcode='40001'; end if;
 return new;
end $$;
create trigger export_guard before update or delete on erp_platform.export for each row execute function erp_platform.export_guard();
create function erp_platform.link_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_platform_export_immutable' using errcode='40001'; end $$;
create trigger link_guard before update or delete on erp_platform.export_link for each row execute function erp_platform.link_guard();

-- The tables of the company that enter the package: business schemas of this installation, minus anything that holds a
-- credential or a secret, the Auth users, the certificate vault and the tasks themselves.
create function erp_platform.export_tables() returns table(name text,schema_name text,table_name text) language sql stable set search_path=pg_catalog as $$
 select n.nspname||'.'||c.relname,n.nspname::text,c.relname::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in('r','p') and not c.relispartition and(n.nspname in('erp_catalog','erp_documents','erp_finance','erp_stock','erp_fiscal_invoices','erp_fiscal_drafts','erp_company',
   'erp_preferences','erp_home','erp_pos','erp_pricing','erp_purchase_receipts','erp_attachments','erp_activity','erp_cnab','erp_list_preferences','erp_dfe')
   or n.nspname='origin_sync' and c.relname='raw_record')
   and c.relname!~'(credential|secret|token|oauth|vault|custody|certificate|password|private|lease)'
  order by 1
$$;
create function erp_platform.export_dto(e erp_platform.export) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',e.id,'created_at',e.created_at,'ready_at',e.ready_at,'expires_at',e.expires_at,'size_bytes',e.size_bytes,'sha256',e.sha256,
  'status',case when e.removed_at is not null or e.expires_at<=clock_timestamp() then 'expired' when e.ready_at is not null then 'ready'
   else(select case t.status when 'failed' then 'failed' when 'running' then 'running' else 'queued' end from erp_platform.task t where t.id=e.task_id) end,
  'error_code',(select t.error_code from erp_platform.task t where t.id=e.task_id and t.status='failed'),
  'attempts',(select t.attempts from erp_platform.task t where t.id=e.task_id),
  'summary',e.manifest->'summary','requested_by_name',(select left(p.name,120) from erp_access.profile p where p.user_id=e.requested_by),
  'links',(select count(*)::integer from erp_platform.export_link l where l.export_id=e.id))
$$;
create function erp_platform.exports_view() returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','platform_exports','data_mode','erp_native','retention_days',7,'link_seconds',120,
  'items',coalesce((select jsonb_agg(erp_platform.export_dto(e) order by e.created_at desc,e.id) from(select * from erp_platform.export order by created_at desc,id limit 20) e),'[]'::jsonb))
$$;

create function public.erp_platform_exports(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin perform erp_access.read_admin(p_user_id); return erp_platform.exports_view(); end $$;

-- Pedir exportação: one at a time; the same command replays its export.
create function public.erp_platform_export_request(p_user_id uuid,p_command_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare e erp_platform.export;t erp_platform.task;v_id uuid:=gen_random_uuid();
begin
 perform erp_access.require_admin(p_user_id,true);
 if p_command_id is null then raise exception 'erp_platform_export_input_invalid' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext('erp_platform_export_request'));
 select * into e from erp_platform.export where command_id=p_command_id;
 if e.id is not null then
  if e.requested_by<>p_user_id then raise exception 'erp_platform_export_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('export',erp_platform.export_dto(e),'replayed',true,'view',erp_platform.exports_view(),'data_mode','erp_native');
 end if;
 if exists(select 1 from erp_platform.export x join erp_platform.task k on k.id=x.task_id where k.status in('queued','running')) then
  raise exception 'erp_platform_export_in_progress' using errcode='55000'; end if;
 t:=erp_platform.enqueue('company_export','exportacao:'||p_command_id,p_user_id,jsonb_build_object('export_id',v_id),3);
 insert into erp_platform.export(id,command_id,requested_by,task_id) values(v_id,p_command_id,p_user_id,t.id) returning * into e;
 return jsonb_build_object('export',erp_platform.export_dto(e),'replayed',false,'view',erp_platform.exports_view(),'data_mode','erp_native');
end $$;

-- The export of a held company_export task.
create function erp_platform.export_held(p_task uuid,p_lease uuid) returns erp_platform.export language plpgsql set search_path=pg_catalog as $$
declare t erp_platform.task;e erp_platform.export;
begin
 t:=erp_platform.task_held(p_task,p_lease);
 if t.purpose<>'company_export' then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 select * into e from erp_platform.export where task_id=t.id for update;
 if e.id is null then raise exception 'erp_platform_export_not_found' using errcode='P0002'; end if;
 return e;
end $$;

create function public.erp_platform_export_plan(p_task uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare e erp_platform.export;
begin
 e:=erp_platform.export_held(p_task,p_lease);
 return jsonb_build_object('scope','platform_export_plan','data_mode','erp_native','export_id',e.id,'as_of',clock_timestamp(),
  'datasets',coalesce((select jsonb_agg(name order by name) from erp_platform.export_tables()),'[]'::jsonb),
  'files',coalesce((select jsonb_agg(jsonb_build_object('key',o.name,'size',case when o.metadata->>'size'~'^[0-9]{1,9}$' then(o.metadata->>'size')::bigint end) order by o.name)
   from storage.objects o where o.bucket_id='erp-attachments'),'[]'::jsonb),
  'excluded',jsonb_build_array('auth.users','erp_access','origin_sync.credentials','certificado A1 (cofre)','erp_platform'));
end $$;

-- One page of one table, ordered by its primary key, up to p_limit rows and about 700 kB.
create function public.erp_platform_export_chunk(p_task uuid,p_lease uuid,p_dataset text,p_offset integer,p_limit integer) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare e erp_platform.export;s text;tb text;v_order text;v_rows jsonb:='[]'::jsonb;v_bytes integer:=0;r record;n integer:=0;v_more boolean:=false;
begin
 e:=erp_platform.export_held(p_task,p_lease);
 if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 1000 then raise exception 'erp_platform_export_input_invalid' using errcode='22023'; end if;
 select x.schema_name,x.table_name into s,tb from erp_platform.export_tables() x where x.name=p_dataset;
 if s is null then raise exception 'erp_platform_export_dataset_invalid' using errcode='22023'; end if;
 select string_agg(format('%I',a.attname),',' order by k.n) into v_order from pg_index i cross join lateral unnest(i.indkey::int2[]) with ordinality k(attnum,n)
  join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum where i.indrelid=format('%I.%I',s,tb)::regclass and i.indisprimary;
 for r in execute format('select to_jsonb(t) v from %I.%I t order by %s offset $1 limit $2',s,tb,coalesce(v_order,'to_jsonb(t)::text')) using p_offset,p_limit+1 loop
  if n=p_limit or n>0 and v_bytes+length(r.v::text)>700000 then v_more:=true; exit; end if;
  v_rows:=v_rows||jsonb_build_array(r.v);v_bytes:=v_bytes+length(r.v::text);n:=n+1;
 end loop;
 update erp_platform.task set lease_until=clock_timestamp()+interval '5 minutes' where id=e.task_id;
 return jsonb_build_object('scope','platform_export_chunk','data_mode','erp_native','dataset',p_dataset,'offset',p_offset,'rows',v_rows,'next_offset',case when v_more then p_offset+n end);
end $$;

-- The package is in Storage (checked by the Worker); the export becomes ready for 7 days.
create function public.erp_platform_export_complete(p_task uuid,p_lease uuid,p_object_key text,p_size_bytes bigint,p_sha256 text,p_manifest jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare e erp_platform.export;
begin
 e:=erp_platform.export_held(p_task,p_lease);
 if p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' or p_object_key is distinct from 'exports/'||e.id||'/'||p_sha256||'.zip' or p_size_bytes is null or p_size_bytes not between 22 and 52428800
  or p_manifest is null or jsonb_typeof(p_manifest)<>'object' or length(p_manifest::text)>16384 then raise exception 'erp_platform_export_input_invalid' using errcode='22023'; end if;
 if e.ready_at is not null then
  if e.object_key<>p_object_key then raise exception 'erp_platform_export_command_conflict' using errcode='40001'; end if;
  return jsonb_build_object('export',erp_platform.export_dto(e),'replayed',true,'data_mode','erp_native');
 end if;
 update erp_platform.export set object_key=p_object_key,size_bytes=p_size_bytes,sha256=p_sha256,manifest=p_manifest,ready_at=clock_timestamp(),expires_at=clock_timestamp()+interval '7 days'
  where id=e.id returning * into e;
 return jsonb_build_object('export',erp_platform.export_dto(e),'replayed',false,'data_mode','erp_native');
end $$;

-- Baixar: the active administrador, a ready export inside the retention; the Worker signs a 2-minute link to this key.
create function public.erp_platform_export_link(p_user_id uuid,p_export_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare e erp_platform.export;
begin
 perform erp_access.require_admin(p_user_id,true);
 select * into e from erp_platform.export where id=p_export_id;
 if e.id is null then raise exception 'erp_platform_export_not_found' using errcode='P0002'; end if;
 if e.ready_at is null or e.removed_at is not null or e.expires_at<=clock_timestamp() then raise exception 'erp_platform_export_unavailable' using errcode='55000'; end if;
 insert into erp_platform.export_link(export_id,actor) values(e.id,p_user_id);
 return jsonb_build_object('scope','platform_export_link','data_mode','erp_native','export_id',e.id,'bucket','brufap-exports','object_key',e.object_key,
  'size_bytes',e.size_bytes,'sha256',e.sha256,'expires_in',120,'filename','brufap-exportacao-'||to_char(e.ready_at at time zone 'America/Sao_Paulo','YYYY-MM-DD-HH24MI')||'.zip');
end $$;

-- export_cleanup: the expired packages still in Storage, then each one marked once its object is gone.
create function public.erp_platform_export_expired(p_task uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;
begin
 t:=erp_platform.task_held(p_task,p_lease);
 if t.purpose<>'export_cleanup' then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 return jsonb_build_object('scope','platform_export_expired','data_mode','erp_native','items',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'object_key',e.object_key) order by e.expires_at)
  from(select * from erp_platform.export where ready_at is not null and removed_at is null and expires_at<=clock_timestamp() order by expires_at limit 50) e),'[]'::jsonb));
end $$;
create function public.erp_platform_export_removed(p_task uuid,p_lease uuid,p_export_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare t erp_platform.task;e erp_platform.export;
begin
 t:=erp_platform.task_held(p_task,p_lease);
 if t.purpose<>'export_cleanup' then raise exception 'erp_platform_task_input_invalid' using errcode='22023'; end if;
 select * into e from erp_platform.export where id=p_export_id for update;
 if e.id is null then raise exception 'erp_platform_export_not_found' using errcode='P0002'; end if;
 if e.ready_at is null or e.expires_at>clock_timestamp() then raise exception 'erp_platform_export_unavailable' using errcode='55000'; end if;
 if e.removed_at is null then update erp_platform.export set removed_at=clock_timestamp() where id=e.id returning * into e; end if;
 return jsonb_build_object('export',erp_platform.export_dto(e),'data_mode','erp_native');
end $$;

revoke all on all functions in schema erp_platform from public,anon,authenticated,service_role;
do $$declare f regprocedure;begin for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in(
 'erp_platform_exports','erp_platform_export_request','erp_platform_export_plan','erp_platform_export_chunk','erp_platform_export_complete',
 'erp_platform_export_link','erp_platform_export_expired','erp_platform_export_removed')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);
end loop;end$$;
commit;
