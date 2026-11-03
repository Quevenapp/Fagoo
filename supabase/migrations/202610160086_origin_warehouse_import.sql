-- Explicit create-only warehouse adoption. No stock/financial/document effects.
begin;
create schema erp_warehouse_import;
revoke all on schema erp_warehouse_import from public,anon,authenticated,service_role;
alter default privileges in schema erp_warehouse_import revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_warehouse_import revoke all on functions from public,anon,authenticated,service_role;
create table erp_warehouse_import.binding(
 source_id text primary key check(source_id~'^[0-9]{1,40}$'and source_id!~'^0+$'),
 warehouse_id uuid not null unique references erp_catalog.warehouse(record_id),
 entity text not null default 'warehouses' check(entity='warehouses'),
 command_id uuid not null unique references erp_catalog.command(command_id) deferrable initially deferred,
 source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),source_version bigint not null check(source_version>0),
 source_seen_at timestamptz not null check(isfinite(source_seen_at)),
 observation jsonb not null check(jsonb_typeof(observation)='object'and octet_length(observation::text)<=65536),
 source jsonb not null check(jsonb_typeof(source)='object'),record jsonb not null check(jsonb_typeof(record)='object'),
 imported_at timestamptz not null default clock_timestamp(),
 foreign key(warehouse_id,entity)references erp_catalog.record(id,entity)
);
create table erp_warehouse_import.command(
 command_id uuid primary key references erp_catalog.command(command_id) deferrable initially deferred,
 actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 source_id text not null references erp_warehouse_import.binding(source_id),
 receipt jsonb not null check(jsonb_typeof(receipt)='object'),created_at timestamptz not null default clock_timestamp()
);
alter table erp_warehouse_import.binding enable row level security;
alter table erp_warehouse_import.command enable row level security;
revoke all on all tables in schema erp_warehouse_import from public,anon,authenticated,service_role;
create function erp_warehouse_import.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'warehouse_import_immutable'using errcode='55000';end$$;
create trigger immutable_binding before update or delete on erp_warehouse_import.binding for each row execute function erp_warehouse_import.immutable();
create trigger immutable_command before update or delete on erp_warehouse_import.command for each row execute function erp_warehouse_import.immutable();
create function erp_warehouse_import.access(p_actor uuid,p_lock boolean default false)returns void language plpgsql set search_path=pg_catalog as $$begin
 if p_lock then perform user_id from erp_access.membership where user_id=p_actor for share;end if;
 if not exists(select 1 from erp_access.membership where user_id=p_actor and active and role='admin')then raise exception 'warehouse_import_access_denied'using errcode='42501';end if;
end$$;
create function erp_warehouse_import.flags(p_read_only boolean)returns jsonb language sql stable set search_path=pg_catalog as $$select jsonb_build_object('profile','origin-warehouse-import-v1','read_only',p_read_only,'stock_effects',false,'financial_effects',false,'can_import_balance',false,'observed_at',statement_timestamp())$$;
create function erp_warehouse_import.source(s origin_sync.raw_record)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare issues jsonb:='[]';n text;state integer;standard boolean;ignored boolean;valid_id boolean;
begin
 if s.source_id is null then return null;end if;
 valid_id:=s.source_id~'^[0-9]{1,40}$'and s.source_id!~'^0+$'and s.payload->>'id'=s.source_id
 and(jsonb_typeof(s.payload->'id')='string'or(jsonb_typeof(s.payload->'id')='number'and s.source_id~'^[1-9][0-9]{0,15}$'and s.source_id::numeric<=9007199254740991));
 if not coalesce(valid_id,false)or s.entity<>'warehouses'or s.version<1 or not isfinite(s.last_seen_at)
 or s.version_hash is distinct from encode(sha256(convert_to(jsonb_build_object('payload',s.payload,'document_links',s.document_links)::text,'UTF8')),'hex')
 or s.document_links is distinct from '[]'::jsonb or s.source_updated_at is not null or s.price_capture is not null or octet_length(s.payload::text)>60000 then issues:=issues||'"SOURCE_INVALID"'::jsonb;end if;
 if jsonb_typeof(s.payload->'descricao')='string'and length(btrim(s.payload->>'descricao'))between 1 and 200 and s.payload->>'descricao'!~'[[:cntrl:]]'and s.payload->>'descricao'!~U&'[\007F-\009F]'then n:=btrim(s.payload->>'descricao');else issues:=issues||'"NAME_INVALID"'::jsonb;end if;
 if s.payload->'situacao'in('0'::jsonb,'1'::jsonb)then state:=(s.payload->>'situacao')::integer;else issues:=issues||'"STATUS_INVALID"'::jsonb;end if;
 if jsonb_typeof(s.payload->'padrao')='boolean'then standard:=(s.payload->>'padrao')::boolean;else issues:=issues||'"DEFAULT_INVALID"'::jsonb;end if;
 if jsonb_typeof(s.payload->'desconsiderarSaldo')='boolean'then ignored:=(s.payload->>'desconsiderarSaldo')::boolean;else issues:=issues||'"BALANCE_SETTING_INVALID"'::jsonb;end if;
 return jsonb_build_object('source_id',s.source_id,'source_hash',s.version_hash,'source_version',s.version::text,'last_seen_at',s.last_seen_at,'name',n,'status',state,'is_default',standard,'exclude_balance',ignored,'valid',issues='[]'::jsonb,'issues',issues);
end$$;
create function erp_warehouse_import.record(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',r.id,'entity',r.entity,'version',r.version,'name',r.name,'code',r.code,'description',w.description,'active',r.active,'human_edited',r.human_edited)
 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=p_id and r.entity='warehouses'
$$;
create function erp_warehouse_import.bound(b erp_warehouse_import.binding)returns jsonb language sql immutable set search_path=pg_catalog as $$
 select case when b.source_id is null then null else jsonb_build_object('source',b.source,'record',b.record,'imported_at',b.imported_at)end
$$;
create function erp_warehouse_import.current(b erp_warehouse_import.binding)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare s origin_sync.raw_record;r jsonb;begin
 select * into s from origin_sync.raw_record where entity='warehouses'and source_id=b.source_id;r:=erp_warehouse_import.record(b.warehouse_id);
 return jsonb_build_object('source',erp_warehouse_import.source(s),'source_state',case when s.source_id is null then'missing'when s.version_hash=b.source_hash and s.version=b.source_version then'same'else'changed'end,
 'record',r,'record_state',case when r=b.record then'same'else'changed'end);
end$$;
create function erp_warehouse_import.plan(p_actor uuid,p_id text,p_hash text,p_version text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s origin_sync.raw_record;b erp_warehouse_import.binding;v jsonb;planned jsonb;h text;
begin
 select * into s from origin_sync.raw_record where entity='warehouses'and source_id=p_id;
 select * into b from erp_warehouse_import.binding where source_id=p_id;v:=erp_warehouse_import.source(s);
 if b.source_id is not null then return erp_warehouse_import.flags(true)||jsonb_build_object('source_id',p_id,'source',v,'existing',erp_warehouse_import.bound(b),'current',erp_warehouse_import.current(b),'can_create',false,'planned',null,'preview_hash',null);end if;
 if s.source_id is null then raise exception 'warehouse_import_source_not_found'using errcode='P0002';end if;
 if s.version_hash is distinct from p_hash or s.version::text is distinct from p_version then raise exception 'warehouse_import_source_conflict'using errcode='40001';end if;
 if v->'valid'='true'::jsonb then
  planned:=jsonb_build_object('name',v->'name','code',null,'description',null,'active',v->'status'='1'::jsonb);
  -- last_seen_at is deliberately not CAS. The accepted observation is reread under lock in import.
  h:=encode(sha256(convert_to(jsonb_build_object('profile','origin-warehouse-import-v1','actor',p_actor,'source_id',p_id,'source_hash',p_hash,'source_version',p_version,'planned',planned)::text,'UTF8')),'hex');
 end if;
 return erp_warehouse_import.flags(true)||jsonb_build_object('source_id',p_id,'source',v,'existing',null,'current',null,'can_create',h is not null,'planned',planned,'preview_hash',h);
end$$;
create function public.erp_origin_warehouse_sources(p_user_id uuid,p_limit integer default 25,p_after text default null,p_query text default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;begin
 perform erp_warehouse_import.access(p_user_id);
 if p_limit is null or p_limit not between 1 and 25 or(p_after is not null and(p_after!~'^[0-9]{1,40}$'or p_after~'^0+$'))or(p_query is not null and(length(p_query)>100 or p_query~'[[:cntrl:]]'or p_query~U&'[\007F-\009F]'))then raise exception 'warehouse_import_query_invalid'using errcode='22023';end if;
 with ids as(select source_id from origin_sync.raw_record where entity='warehouses'union select source_id from erp_warehouse_import.binding),page as materialized(
 select i.source_id,erp_warehouse_import.source(s)source,erp_warehouse_import.bound(b)binding from ids i left join origin_sync.raw_record s on s.entity='warehouses'and s.source_id=i.source_id left join erp_warehouse_import.binding b on b.source_id=i.source_id
 where(p_after is null or i.source_id collate "C">p_after collate "C")and(nullif(btrim(p_query),'')is null or strpos(i.source_id,btrim(p_query))>0 or strpos(lower(coalesce(s.payload->>'descricao',b.source->>'name')),lower(btrim(p_query)))>0)
 order by i.source_id collate "C" limit p_limit+1),visible as(select * from page order by source_id collate "C" limit p_limit)
 select coalesce((select jsonb_agg(to_jsonb(v)order by v.source_id collate "C")from visible v),'[]'::jsonb),(select count(*)>p_limit from page)into rows,more;
 return erp_warehouse_import.flags(true)||jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then rows->-1->>'source_id'end);
end$$;
create function public.erp_origin_warehouse_preview(p_user_id uuid,p_source_id text,p_source_hash text,p_source_version text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_warehouse_import.access(p_user_id);
 if p_source_id is null or p_source_id!~'^[0-9]{1,40}$'or p_source_id~'^0+$'or p_source_hash is null or p_source_hash!~'^[a-f0-9]{64}$'or p_source_version is null or p_source_version!~'^[1-9][0-9]{0,18}$'then raise exception 'warehouse_import_query_invalid'using errcode='22023';end if;
 return erp_warehouse_import.plan(p_user_id,p_source_id,p_source_hash,p_source_version);
end$$;
create function public.erp_origin_warehouse_import(p_user_id uuid,p_source_id text,p_source_hash text,p_source_version text,p_preview_hash text,p_command_id uuid,p_confirmed boolean)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_warehouse_import.command;b erp_warehouse_import.binding;s origin_sync.raw_record;plan jsonb;v jsonb;r jsonb;receipt jsonb;outcome text;id uuid;
begin
 perform erp_warehouse_import.access(p_user_id);
 if p_source_id is null or p_source_id!~'^[0-9]{1,40}$'or p_source_id~'^0+$'or p_source_hash is null or p_source_hash!~'^[a-f0-9]{64}$'or p_source_version is null or p_source_version!~'^[1-9][0-9]{0,18}$'or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$'or p_command_id is null or p_confirmed is distinct from true then raise exception 'warehouse_import_input_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('profile','origin-warehouse-import-v1','actor',p_user_id,'source_id',p_source_id,'source_hash',p_source_hash,'source_version',p_source_version,'preview_hash',p_preview_hash,'confirmed',true)::text,'UTF8')),'hex');
 -- Shared catalogue command lock makes collision protection symmetric with006/011/013.
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));perform erp_warehouse_import.access(p_user_id);
 select * into c from erp_warehouse_import.command where command_id=p_command_id;
 if found then
  perform erp_warehouse_import.access(p_user_id,true);
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'warehouse_import_command_conflict'using errcode='40001';end if;
  select * into b from erp_warehouse_import.binding where source_id=c.source_id;
  return erp_warehouse_import.flags(false)||jsonb_build_object('receipt',c.receipt,'current',erp_warehouse_import.current(b),'replayed',true);
 end if;
 if exists(select 1 from erp_catalog.command where command_id=p_command_id)or exists(select 1 from erp_catalog.import_review_command where command_id=p_command_id)then raise exception 'warehouse_import_command_conflict'using errcode='40001';end if;
 perform pg_advisory_xact_lock(174853086,hashtext(p_source_id));perform erp_warehouse_import.access(p_user_id);
 select * into b from erp_warehouse_import.binding where source_id=p_source_id;
 if b.source_id is null then
  select * into s from origin_sync.raw_record where entity='warehouses'and source_id=p_source_id for share;
  perform erp_warehouse_import.access(p_user_id);
  if s.source_id is null then raise exception 'warehouse_import_source_not_found'using errcode='P0002';end if;
  plan:=erp_warehouse_import.plan(p_user_id,p_source_id,p_source_hash,p_source_version);
  if plan->'can_create' is distinct from 'true'::jsonb or plan->>'preview_hash' is distinct from p_preview_hash then raise exception 'warehouse_import_preview_conflict'using errcode='40001';end if;
  v:=erp_warehouse_import.source(s);
  perform erp_warehouse_import.access(p_user_id,true);
  -- Explicit active in the INSERT, never the006 default followed by a second command.
  insert into erp_catalog.record(entity,name,code,active,human_edited,created_by,updated_by)values('warehouses',plan#>>'{planned,name}',null,(plan#>>'{planned,active}')::boolean,false,p_user_id,p_user_id)returning erp_catalog.record.id into id;
  insert into erp_catalog.warehouse(record_id,description)values(id,null);
  r:=erp_warehouse_import.record(id);
  insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)
  values(p_source_id,id,p_command_id,s.version_hash,s.version,s.last_seen_at,jsonb_build_object('payload',s.payload,'document_links',s.document_links),v,r)returning * into b;
  insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)values(p_user_id,p_command_id,'warehouses',id,'import_warehouse',null,erp_catalog.dto(id));outcome:='created';
 else
  perform erp_warehouse_import.access(p_user_id,true);outcome:='already_linked';
 end if;
 receipt:=jsonb_build_object('command_id',p_command_id,'outcome',outcome,'source_id',b.source_id,'binding',erp_warehouse_import.bound(b),'completed_at',clock_timestamp());
 insert into erp_catalog.command(command_id,actor,request_hash,result)values(p_command_id,p_user_id,h,jsonb_build_object('entity','warehouses','record',erp_catalog.dto(b.warehouse_id),'data_mode','erp_native','replayed',false));
 insert into erp_warehouse_import.command(command_id,actor,request_hash,source_id,receipt)values(p_command_id,p_user_id,h,b.source_id,receipt);
 return erp_warehouse_import.flags(false)||jsonb_build_object('receipt',receipt,'current',erp_warehouse_import.current(b),'replayed',false);
end$$;
create function public.erp_origin_warehouse_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c erp_warehouse_import.command;b erp_warehouse_import.binding;begin
 perform erp_warehouse_import.access(p_user_id);if p_command_id is null then raise exception 'warehouse_import_query_invalid'using errcode='22023';end if;
 select * into c from erp_warehouse_import.command where command_id=p_command_id;if not found then raise exception 'warehouse_import_command_not_found'using errcode='P0002';end if;
 if c.actor<>p_user_id then raise exception 'warehouse_import_access_denied'using errcode='42501';end if;
 select * into b from erp_warehouse_import.binding where source_id=c.source_id;
 return erp_warehouse_import.flags(true)||jsonb_build_object('receipt',c.receipt,'current',erp_warehouse_import.current(b),'replayed',false);
end$$;
revoke all on all functions in schema erp_warehouse_import from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_warehouse_sources(uuid,integer,text,text),public.erp_origin_warehouse_preview(uuid,text,text,text),public.erp_origin_warehouse_import(uuid,text,text,text,text,uuid,boolean),public.erp_origin_warehouse_command(uuid,uuid)from public,anon,authenticated,service_role;
grant execute on function public.erp_origin_warehouse_sources(uuid,integer,text,text),public.erp_origin_warehouse_preview(uuid,text,text,text),public.erp_origin_warehouse_import(uuid,text,text,text,text,uuid,boolean),public.erp_origin_warehouse_command(uuid,uuid)to service_role;
commit;
