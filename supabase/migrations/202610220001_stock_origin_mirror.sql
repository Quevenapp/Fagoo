-- Estoque observado do Origin, separado do razão nativo. Nenhuma função publicada é substituída.
-- A captura preserva versões na transação do staging; o projetor trabalha depois, em lotes pequenos.
begin;
create schema erp_stock_mirror;
revoke all on schema erp_stock_mirror from public,anon,authenticated,service_role;
alter default privileges in schema erp_stock_mirror revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_stock_mirror revoke all on functions from public,anon,authenticated,service_role;

create table erp_stock_mirror.source_version(
 product_source_id text not null,source_version bigint not null check(source_version>0),source_hash text not null,
 payload jsonb not null,observed_at timestamptz not null, captured_at timestamptz not null default clock_timestamp(),
 primary key(product_source_id,source_version)
);
create table erp_stock_mirror.pending(
 product_source_id text not null,source_version bigint not null,attempts integer not null default 0,
 retry_at timestamptz not null default clock_timestamp(),last_error text,
 primary key(product_source_id,source_version),foreign key(product_source_id,source_version) references erp_stock_mirror.source_version
);
create table erp_stock_mirror.issue(
 product_source_id text not null,source_version bigint not null,code text not null,
 created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz,
 primary key(product_source_id,source_version,code)
);
create table erp_stock_mirror.applied(
 product_source_id text primary key,source_version bigint not null,source_hash text not null,applied_at timestamptz not null
);
create table erp_stock_mirror.observation(
 id bigint generated always as identity primary key check(id<=9007199254740991),
 product_source_id text not null,warehouse_source_id text not null,
 source_version bigint not null,source_hash text not null,mapper_version integer not null default 1,
 physical numeric,virtual numeric,physical_state text not null,virtual_state text not null,
 physical_delta numeric,virtual_delta numeric,issues jsonb not null default '[]',
 observed_at timestamptz not null,source_deleted boolean not null default false,
 check(physical_state in('value','absent','null','invalid')),check(virtual_state in('value','absent','null','invalid')),
 check((physical_state='value')=(physical is not null)),check((virtual_state='value')=(virtual is not null)),
 unique(product_source_id,warehouse_source_id,source_version,mapper_version)
);
create table erp_stock_mirror.position(
 id bigint generated always as identity primary key check(id<=9007199254740991),
 product_source_id text not null,warehouse_source_id text not null,observation_id bigint not null references erp_stock_mirror.observation,
 unique(product_source_id,warehouse_source_id)
);
create index stock_mirror_pending_retry on erp_stock_mirror.pending(retry_at,product_source_id,source_version);
create index stock_mirror_observation_product on erp_stock_mirror.observation(product_source_id,source_version);
create index stock_mirror_position_warehouse on erp_stock_mirror.position(warehouse_source_id,id);

create function erp_stock_mirror.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'stock_mirror_immutable' using errcode='55000';end$$;
create trigger stock_mirror_source_immutable before update or delete on erp_stock_mirror.source_version for each row execute function erp_stock_mirror.immutable();
create trigger stock_mirror_observation_immutable before update or delete on erp_stock_mirror.observation for each row execute function erp_stock_mirror.immutable();

create function erp_stock_mirror.capture() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare h text;
begin
 if new.entity<>'stock_balances' then return null;end if;
 if tg_op='UPDATE' and new.version=old.version and new.version_hash=old.version_hash then return null;end if;
 insert into erp_stock_mirror.source_version(product_source_id,source_version,source_hash,payload,observed_at)
 values(new.source_id,new.version,new.version_hash,new.payload,new.last_seen_at) on conflict do nothing;
 select source_hash into h from erp_stock_mirror.source_version where product_source_id=new.source_id and source_version=new.version;
 if h<>new.version_hash then
  insert into erp_stock_mirror.issue(product_source_id,source_version,code)values(new.source_id,new.version,'VERSION_HASH_CONFLICT')on conflict do nothing;
 else
  insert into erp_stock_mirror.pending(product_source_id,source_version)values(new.source_id,new.version)on conflict do nothing;
 end if;
 return null;
end$$;
create trigger stock_mirror_capture after insert or update on origin_sync.raw_record for each row when(new.entity='stock_balances') execute function erp_stock_mirror.capture();

-- Ausência, null e inválido são distintos. Nunca arredonda e nunca transforma falta de dado em zero.
create function erp_stock_mirror.number(p jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare t text;n numeric;
begin
 if p is null then return '{"state":"absent","value":null}';end if;
 if p='null'::jsonb then return '{"state":"null","value":null}';end if;
 t:=p#>>'{}';
 if jsonb_typeof(p) not in('number','string') or length(t)>80 or t!~'^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' then return '{"state":"invalid","value":null}';end if;
 begin n:=t::numeric;exception when others then return '{"state":"invalid","value":null}';end;
 if abs(n)>=1e24 or min_scale(n)>12 then return '{"state":"invalid","value":null}';end if;
 return jsonb_build_object('state','value','value',trim_scale(n)::text);
end$$;
create function erp_stock_mirror.id(p jsonb)returns text language sql immutable set search_path=pg_catalog as $$
 select case when id~'^[1-9][0-9]{0,39}$'then id end from(select erp_cutover.stock_observation_id(p)id)s
$$;
create function erp_stock_mirror.text(p text,n integer)returns text language sql immutable set search_path=pg_catalog as $$
 select nullif(left(btrim(regexp_replace(p,'[[:cntrl:]]',' ','g')),n),'')
$$;

create function erp_stock_mirror.project_one(s erp_stock_mirror.source_version) returns boolean language plpgsql set search_path=pg_catalog as $$
declare a erp_stock_mirror.applied;w record;d jsonb;ph jsonb;vi jsonb;issues jsonb;common jsonb:='[]';
 list jsonb:='[]';valid boolean:=true;deleted boolean;prev erp_stock_mirror.observation;oid bigint;
begin
 if s.product_source_id!~'^[1-9][0-9]{0,39}$'or s.source_version>9007199254740991 or not isfinite(s.observed_at)then
  insert into erp_stock_mirror.issue(product_source_id,source_version,code)values(s.product_source_id,s.source_version,'SOURCE_IDENTITY_INVALID')on conflict do nothing;
  return false;
 end if;
 select * into a from erp_stock_mirror.applied where product_source_id=s.product_source_id;
 if a.source_version is not null and s.source_version<=a.source_version then
  if s.source_version=a.source_version and s.source_hash<>a.source_hash then
   insert into erp_stock_mirror.issue(product_source_id,source_version,code)values(s.product_source_id,s.source_version,'VERSION_HASH_CONFLICT')on conflict do nothing;
  end if;return false;
 end if;
 deleted:=coalesce(s.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 if erp_stock_mirror.id(s.payload#>'{produto,id}') is distinct from s.product_source_id then
  valid:=false;common:=common||'"PRODUCT_ID_INVALID"'::jsonb;
 end if;
 if jsonb_typeof(s.payload->'depositos')='array' and jsonb_array_length(s.payload->'depositos')<=1000 then list:=s.payload->'depositos';
 else valid:=false;common:=common||'"WAREHOUSE_LIST_INVALID"'::jsonb;end if;
 if exists(select 1 from jsonb_array_elements(list) e where erp_stock_mirror.id(e->'id') is null)
  or exists(select 1 from jsonb_array_elements(list) e group by erp_stock_mirror.id(e->'id')having count(*)>1) then
  valid:=false;common:=common||'"WAREHOUSE_LIST_INVALID"'::jsonb;
 end if;
 if deleted then common:=common||'"SOURCE_DELETED"'::jsonb;end if;
 -- A posição que sumiu recebe uma observação ausente. A anterior permanece no histórico.
 for w in select distinct warehouse_source_id from(
  select coalesce(erp_stock_mirror.id(e->'id'),'')warehouse_source_id from jsonb_array_elements(list)e
  union select p.warehouse_source_id from erp_stock_mirror.position p where p.product_source_id=s.product_source_id
  union select '' where jsonb_array_length(list)=0)x
 loop
  d:=null;issues:=common;
  if valid and not deleted then select e into d from jsonb_array_elements(list)e where erp_stock_mirror.id(e->'id')=w.warehouse_source_id;end if;
  ph:=erp_stock_mirror.number(d->'saldoFisico');vi:=erp_stock_mirror.number(d->'saldoVirtual');
  if not valid then ph:='{"state":"invalid","value":null}';vi:=ph;end if;
  if ph->>'state'<>'value' or vi->>'state'<>'value' then issues:=issues||'"BALANCE_INCOMPLETE"'::jsonb;end if;
  select o.* into prev from erp_stock_mirror.position p join erp_stock_mirror.observation o on o.id=p.observation_id
   where p.product_source_id=s.product_source_id and p.warehouse_source_id=w.warehouse_source_id;
  insert into erp_stock_mirror.observation(product_source_id,warehouse_source_id,source_version,source_hash,physical,virtual,physical_state,virtual_state,
   physical_delta,virtual_delta,issues,observed_at,source_deleted)
  values(s.product_source_id,w.warehouse_source_id,s.source_version,s.source_hash,(ph->>'value')::numeric,(vi->>'value')::numeric,ph->>'state',vi->>'state',
   (ph->>'value')::numeric-prev.physical,(vi->>'value')::numeric-prev.virtual,issues,s.observed_at,deleted) returning id into oid;
  insert into erp_stock_mirror.position(product_source_id,warehouse_source_id,observation_id)values(s.product_source_id,w.warehouse_source_id,oid)
   on conflict(product_source_id,warehouse_source_id)do update set observation_id=excluded.observation_id;
 end loop;
 insert into erp_stock_mirror.applied values(s.product_source_id,s.source_version,s.source_hash,clock_timestamp())
 on conflict(product_source_id)do update set source_version=excluded.source_version,source_hash=excluded.source_hash,applied_at=excluded.applied_at;
 update erp_stock_mirror.issue set resolved_at=clock_timestamp()where product_source_id=s.product_source_id and source_version<s.source_version and resolved_at is null;
 return true;
end$$;

create function public.erp_stock_mirror_project(p_limit integer default 50)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q record;s erp_stock_mirror.source_version;n integer:=0;a integer:=0;f integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'stock_mirror_invalid_limit'using errcode='22023';end if;
 -- Uma execução por vez mantém a ordem das versões sem competir com a lease do staging.
 if not pg_try_advisory_xact_lock(174852901,220001)then return jsonb_build_object('processed',0,'applied',0,'failed',0,'pending',(select count(*) from erp_stock_mirror.pending));end if;
 for q in select * from erp_stock_mirror.pending where retry_at<=clock_timestamp()order by product_source_id,source_version limit p_limit for update skip locked loop
  n:=n+1;
  begin
   select * into strict s from erp_stock_mirror.source_version where product_source_id=q.product_source_id and source_version=q.source_version;
   if erp_stock_mirror.project_one(s)then a:=a+1;end if;
   delete from erp_stock_mirror.pending where product_source_id=q.product_source_id and source_version=q.source_version;
  exception when others then
   f:=f+1;update erp_stock_mirror.pending set attempts=attempts+1,retry_at=clock_timestamp()+interval '5 minutes',last_error=sqlstate where product_source_id=q.product_source_id and source_version=q.source_version;
   insert into erp_stock_mirror.issue(product_source_id,source_version,code)values(q.product_source_id,q.source_version,'PROJECTOR_ERROR')on conflict do nothing;
  end;
 end loop;
 return jsonb_build_object('processed',n,'applied',a,'failed',f,'pending',(select count(*)from erp_stock_mirror.pending));
end$$;

-- Só identidades explícitas ligam os cadastros. Nomes/SKU nunca servem para associar saldos.
create view erp_stock_mirror.current_position as
select p.id,p.product_source_id,o.warehouse_source_id,co.record_id product_id,wb.warehouse_id,
 coalesce(cr.name,erp_stock_mirror.text(pr.payload->>'nome',200),'Produto Origin '||p.product_source_id)product_name,
 coalesce(cr.code,erp_stock_mirror.text(pr.payload->>'codigo',100),erp_stock_mirror.text(sr.payload#>>'{produto,codigo}',100))product_code,
 coalesce(cp.unit,erp_stock_mirror.text(pr.payload->>'unidade',16))unit,
 coalesce(wr.name,erp_stock_mirror.text(ws.payload->>'descricao',200),erp_stock_mirror.text(ws.payload->>'nome',200),case when o.warehouse_source_id=''then'Depósito não identificado'else'Depósito Origin '||o.warehouse_source_id end)warehouse_name,
 o.physical,o.virtual,o.physical-o.virtual reserved,o.physical_state,o.virtual_state,o.source_version,o.source_hash,
 case when sr.version=o.source_version and sr.version_hash=o.source_hash and isfinite(sr.last_seen_at)then sr.last_seen_at else o.observed_at end observed_at,
 o.source_deleted,o.issues
 ||case when co.record_id is null then '["PRODUCT_UNLINKED"]'::jsonb else '[]'::jsonb end
 ||case when wb.warehouse_id is null then '["WAREHOUSE_UNLINKED"]'::jsonb else '[]'::jsonb end
 ||case when cr.id is not null and not cr.active then '["PRODUCT_INACTIVE"]'::jsonb else '[]'::jsonb end
 ||case when cp.kind is not null and cp.kind<>'P' then '["PRODUCT_SERVICE"]'::jsonb else '[]'::jsonb end
 ||case when cp.format in('E','V')then '["PRODUCT_STRUCTURE_REVIEW"]'::jsonb else '[]'::jsonb end
 ||case when coalesce(cp.unit,pr.payload->>'unidade')is null then '["UNIT_UNCONFIRMED"]'::jsonb else '[]'::jsonb end issues
from erp_stock_mirror.position p join erp_stock_mirror.observation o on o.id=p.observation_id
left join erp_catalog.origin co on co.entity='products'and co.source_id=p.product_source_id
left join erp_catalog.record cr on cr.id=co.record_id left join erp_catalog.product cp on cp.record_id=co.record_id
left join erp_warehouse_import.binding wb on wb.source_id=o.warehouse_source_id left join erp_catalog.record wr on wr.id=wb.warehouse_id
left join origin_sync.raw_record pr on pr.entity='products'and pr.source_id=p.product_source_id
left join origin_sync.raw_record sr on sr.entity='stock_balances'and sr.source_id=p.product_source_id
left join origin_sync.raw_record ws on ws.entity='warehouses'and ws.source_id=o.warehouse_source_id;

create function public.erp_stock_mirror_list(p_user_id uuid,p_query text default null,p_warehouse_source_id text default null,p_product_id uuid default null,
 p_state text default null,p_limit integer default 50,p_after bigint default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform erp_stock.require_access(p_user_id,false);
 if p_limit is null or p_limit not between 1 and 100 or p_after<0 or p_after>9007199254740991 or length(p_query)>120 or p_query~'[[:cntrl:]]'
  or(p_state is not null and p_state not in('negative','pending','deleted'))
  or(p_warehouse_source_id is not null and (p_warehouse_source_id!~'^[0-9]{1,40}$'or p_warehouse_source_id~'^0+$'))then
  raise exception 'stock_mirror_invalid_query'using errcode='22023';end if;
 with filtered as materialized(select * from erp_stock_mirror.current_position p where (p_product_id is null or product_id=p_product_id)
  and(p_state='deleted' or not source_deleted)
  and(p_warehouse_source_id is null or warehouse_source_id=p_warehouse_source_id)
  and(p_query is null or erp_catalog.fold(product_name||' '||coalesce(product_code,'')||' '||product_source_id)like '%'||erp_catalog.fold(btrim(p_query))||'%')
  and(p_state is null or(p_state='negative'and(physical<0 or virtual<0))or(p_state='pending'and jsonb_array_length(issues)>0)or(p_state='deleted'and source_deleted))),
 page as materialized(select * from filtered where p_after is null or id>p_after order by id limit p_limit+1),
 shown as materialized(select * from page order by id limit p_limit)
 select jsonb_build_object('scope','stock_mirror','data_mode','origin_mirror','limit',p_limit,'has_more',(select count(*)>p_limit from page),
  'next_after',case when(select count(*)>p_limit from page)then(select max(id)from shown)end,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product_source_id',product_source_id,'product_id',product_id,'product_name',product_name,
   'product_code',product_code,'unit',unit,'warehouse_source_id',nullif(warehouse_source_id,''),'warehouse_id',warehouse_id,'warehouse_name',warehouse_name,
   'physical',physical::text,'virtual',virtual::text,'reserved',reserved::text,'physical_state',physical_state,'virtual_state',virtual_state,'issues',issues,
   'source_version',source_version,'source_hash',source_hash,'observed_at',observed_at,'source_deleted',source_deleted,'origin','origin','read_only',true)order by id)from shown),'[]'::jsonb),
  'coverage',jsonb_build_object('positions',(select count(*)from erp_stock_mirror.position),'products',(select count(*)from erp_stock_mirror.applied),
   'raw_products',(select count(*)from origin_sync.raw_record where entity='stock_balances'),
   'pending_products',(select count(distinct product_source_id)from erp_stock_mirror.pending),
   'partial',exists(select 1 from erp_stock_mirror.pending)or exists(select 1 from erp_stock_mirror.issue where resolved_at is null)
    or exists(select 1 from erp_stock_mirror.current_position where jsonb_array_length(issues)>0)
    or exists(select 1 from origin_sync.raw_record r where r.entity='products'and not exists(select 1 from erp_stock_mirror.applied a where a.product_source_id=r.source_id))),
  'warehouses',coalesce((select jsonb_agg(jsonb_build_object('source_id',warehouse_source_id,'id',warehouse_id,'name',warehouse_name)order by warehouse_name,warehouse_source_id)
   from(select distinct warehouse_source_id,warehouse_id,warehouse_name from erp_stock_mirror.current_position where warehouse_source_id<>'')w),'[]'::jsonb),
  'native',jsonb_build_object('positions',(select count(*)from erp_stock.balance),'movements',(select count(*)from erp_stock.movement)))into result;
 return result;
end$$;

-- Bootstrap barato: só captura o staging atual; a carga pesada é dividida pelo projetor.
insert into erp_stock_mirror.source_version(product_source_id,source_version,source_hash,payload,observed_at)
select source_id,version,version_hash,payload,last_seen_at from origin_sync.raw_record where entity='stock_balances';
insert into erp_stock_mirror.pending(product_source_id,source_version)select product_source_id,source_version from erp_stock_mirror.source_version;
do $$declare t text;begin foreach t in array array['source_version','pending','issue','applied','observation','position']loop
 execute format('alter table erp_stock_mirror.%I enable row level security',t);end loop;end$$;
revoke all on all tables in schema erp_stock_mirror from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_stock_mirror from public,anon,authenticated,service_role;
revoke all on function public.erp_stock_mirror_project(integer),public.erp_stock_mirror_list(uuid,text,text,uuid,text,integer,bigint)from public,anon,authenticated;
grant execute on function public.erp_stock_mirror_project(integer),public.erp_stock_mirror_list(uuid,text,text,uuid,text,integer,bigint)to service_role;
commit;
