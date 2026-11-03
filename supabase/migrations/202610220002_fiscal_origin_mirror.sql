-- Fiscal: espelho de consulta separado das notas e dos efeitos nativos. Histórico começa nesta instalação.
-- Captura transacional pequena; a carga inicial é feita pela RPC de lotes, nunca por importação fiscal.
begin;
create schema erp_fiscal_mirror;
revoke all on schema erp_fiscal_mirror from public,anon,authenticated,service_role;
create table erp_fiscal_mirror.observation(
 entity text not null check(entity in('nfe','nfce')),source_id text not null,source_version bigint not null,source_hash text not null,
 payload jsonb not null,document_links jsonb not null,access_key text,status_raw text,observed_at timestamptz not null,
 source_deleted boolean not null,primary key(entity,source_id,source_version)
);
create table erp_fiscal_mirror.current(
 entity text not null check(entity in('nfe','nfce')),source_id text not null,version bigint not null,version_hash text not null,
 payload jsonb not null,document_links jsonb not null,access_key text,status_raw text,last_seen_at timestamptz not null,
 source_deleted boolean not null,listing jsonb not null,primary key(entity,source_id)
);
create index fiscal_mirror_current_key on erp_fiscal_mirror.current(access_key,entity,source_id)where access_key is not null;
create table erp_fiscal_mirror.status_change(
 entity text not null,source_id text not null,source_version bigint not null,previous_status text,status text,
 previous_deleted boolean,source_deleted boolean not null,observed_at timestamptz not null,
 primary key(entity,source_id,source_version),foreign key(entity,source_id,source_version)references erp_fiscal_mirror.observation
);
create table erp_fiscal_mirror.issue(
 entity text not null,source_id text not null,source_version bigint not null,code text not null,
 created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz,
 primary key(entity,source_id,source_version,code)
);
create table erp_fiscal_mirror.xml_cache(
 archive_source_id uuid primary key references origin_fiscal.source,entity text not null,source_id text not null,access_key text not null,revision uuid,
 xml_id uuid,xml_hash text,xml_size integer,environment text,protocol text,protocol_present boolean not null,event_count integer not null,events jsonb not null,
 last_success_at timestamptz
);
create index fiscal_mirror_xml_key on erp_fiscal_mirror.xml_cache(access_key,entity,source_id);
create table erp_fiscal_mirror.seed(entity text not null,source_id text not null,retry_at timestamptz not null default '-infinity',primary key(entity,source_id));
create table erp_fiscal_mirror.xml_seed(archive_source_id uuid primary key,retry_at timestamptz not null default '-infinity');
create index fiscal_mirror_seed_retry on erp_fiscal_mirror.seed(retry_at,entity,source_id);
create index fiscal_mirror_xml_seed_retry on erp_fiscal_mirror.xml_seed(retry_at,archive_source_id);
create function erp_fiscal_mirror.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'fiscal_mirror_immutable'using errcode='55000';end$$;
create trigger fiscal_mirror_observation_immutable before update or delete on erp_fiscal_mirror.observation for each row execute function erp_fiscal_mirror.immutable();
create trigger fiscal_mirror_status_immutable before update or delete on erp_fiscal_mirror.status_change for each row execute function erp_fiscal_mirror.immutable();

-- Resumo leve para filtros/listas: percorrer itens/transporte acontece uma vez por versão, fora da consulta da tela.
create function erp_fiscal_mirror.list_data(p jsonb)returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('number',erp_fiscal_invoices.origin_int(to_jsonb(nullif(ltrim(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p->'numero',20)),'0'),''))),
  'series',erp_fiscal_invoices.origin_int(p->'serie'),'issue_date',erp_fiscal_invoices.origin_date(p->'dataEmissao'),'entry_date',erp_fiscal_invoices.origin_date(p->'dataOperacao'),
  'name',erp_fiscal_invoices.scalar(p#>'{contato,nome}',200),'trade_name',erp_fiscal_invoices.scalar(p#>'{contato,fantasia}',200),
  'document',nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,numeroDocumento}',30)),''),
  'person_type',coalesce(case erp_fiscal_invoices.scalar(p#>'{contato,tipoPessoa}',1)when'J'then'J'when'F'then'F'when'E'then'E'end,
   case length(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,numeroDocumento}',30)))when 14 then'J'when 11 then'F'end),
  'email',erp_fiscal_invoices.scalar(p#>'{contato,email}',254),'phone',nullif(erp_fiscal_invoices.digits(erp_fiscal_invoices.scalar(p#>'{contato,telefone}',40)),''),
  'state',upper(erp_fiscal_invoices.scalar(p#>'{contato,endereco,uf}',2)),'status',erp_fiscal_invoices.origin_status(p->'situacao'),
  'total',erp_fiscal_invoices.origin_money(p->'valorNota'),'direction',erp_fiscal_invoices.scalar(p->'tipo',2),
  'carrier',erp_fiscal_invoices.scalar(p#>'{transporte,transportador,nome}',200),'contact_source_id',erp_fiscal_invoices.scalar(p#>'{contato,id}',40),
  'seller_source_id',erp_fiscal_invoices.scalar(p#>'{vendedor,id}',40),
  'tracking',(select left(string_agg(e.value#>>'{}',' 'order by e.value#>>'{}'),4000)
   from jsonb_path_query(case when jsonb_typeof(p->'transporte')='object'then p->'transporte'else'{}'::jsonb end,'strict $.**')o(node)
   cross join lateral jsonb_each(case when jsonb_typeof(o.node)='object'then o.node else'{}'::jsonb end)e
   where e.key~*'rastre'and jsonb_typeof(e.value)in('string','number')),
  'product_codes',(select coalesce(jsonb_agg(erp_fiscal_invoices.scalar(e->'codigo',60)),'[]')from jsonb_array_elements(case when jsonb_typeof(p->'itens')='array'then p->'itens'else'[]'end)e))
$$;

create function erp_fiscal_mirror.xml_refresh(s origin_fiscal.source)returns void language plpgsql set search_path=pg_catalog as $$
declare x record;events jsonb;
begin
 -- A atualização do ponteiro e o bootstrap seguem a mesma ordem de locks; releitura evita um snapshot antigo sobrescrever o cache novo.
 select * into s from origin_fiscal.source where id=s.id for update;
 if not found then return;end if;
 select i.id,o.hash,o.size,o.metadata into x from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash
  where i.revision=s.current_revision and o.metadata->>'kind'='invoice'order by i.id limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'type',o.metadata->>'event_type','sequence',o.metadata->>'event_sequence','hash',o.hash,'size',o.size)
  order by o.metadata->>'event_type',o.metadata->>'event_sequence',i.id),'[]')into events
  from origin_fiscal.item i join origin_fiscal.object o on o.hash=i.object_hash where i.revision=s.current_revision and o.metadata->>'kind'='event';
 insert into erp_fiscal_mirror.xml_cache values(s.id,s.entity,s.source_id,s.access_key,s.current_revision,x.id,x.hash,x.size,x.metadata->>'environment',
  x.metadata->>'protocol',coalesce(x.metadata->>'protocol_present','false')='true',jsonb_array_length(events),events,s.last_success_at)
 on conflict(archive_source_id)do update set entity=excluded.entity,source_id=excluded.source_id,access_key=excluded.access_key,
  revision=excluded.revision,xml_id=excluded.xml_id,xml_hash=excluded.xml_hash,xml_size=excluded.xml_size,
  environment=excluded.environment,protocol=excluded.protocol,protocol_present=excluded.protocol_present,event_count=excluded.event_count,events=excluded.events,last_success_at=excluded.last_success_at;
end$$;
create function erp_fiscal_mirror.xml_capture()returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin perform erp_fiscal_mirror.xml_refresh(new);return null;end$$;
create trigger fiscal_mirror_xml_capture after insert or update of current_revision,entity,source_id,access_key,last_success_at on origin_fiscal.source for each row execute function erp_fiscal_mirror.xml_capture();

create function erp_fiscal_mirror.apply(r origin_sync.raw_record)returns boolean language plpgsql set search_path=pg_catalog as $$
declare c erp_fiscal_mirror.current;k text;s text;deleted boolean;h text;
begin
 if r.entity not in('nfe','nfce')then return false;end if;
 perform pg_advisory_xact_lock(174852901,hashtext('fiscal_mirror:'||r.entity||':'||r.source_id));
 if r.source_id!~'^[1-9][0-9]{0,39}$'or not isfinite(r.last_seen_at)then
  insert into erp_fiscal_mirror.issue(entity,source_id,source_version,code)values(r.entity,r.source_id,r.version,'SOURCE_IDENTITY_INVALID')on conflict do nothing;return false;
 end if;
 select * into c from erp_fiscal_mirror.current where entity=r.entity and source_id=r.source_id;
 select source_hash into h from erp_fiscal_mirror.observation where entity=r.entity and source_id=r.source_id and source_version=r.version;
 if h is not null and h<>r.version_hash then
  insert into erp_fiscal_mirror.issue(entity,source_id,source_version,code)values(r.entity,r.source_id,r.version,'VERSION_HASH_CONFLICT')on conflict do nothing;return false;
 end if;
 k:=case when r.payload->>'chaveAcesso'~'^[0-9]{44}$'then r.payload->>'chaveAcesso'end;
 s:=coalesce(erp_fiscal_invoices.scalar(r.payload#>'{situacao,id}',20),erp_fiscal_invoices.scalar(r.payload->'situacao',20));
 deleted:=coalesce(r.payload#>'{_brufap_source,deleted}'='true'::jsonb,false);
 insert into erp_fiscal_mirror.observation values(r.entity,r.source_id,r.version,r.version_hash,r.payload,r.document_links,k,s,r.last_seen_at,deleted)on conflict do nothing;
 if c.version is not null and r.version<=c.version then
  if r.version=c.version and r.version_hash=c.version_hash then update erp_fiscal_mirror.current set last_seen_at=greatest(last_seen_at,r.last_seen_at)where entity=r.entity and source_id=r.source_id;end if;
  return false;
 end if;
 if c.version is null or c.status_raw is distinct from s or c.source_deleted is distinct from deleted then
  insert into erp_fiscal_mirror.status_change values(r.entity,r.source_id,r.version,c.status_raw,s,c.source_deleted,deleted,r.last_seen_at);
 end if;
 insert into erp_fiscal_mirror.current values(r.entity,r.source_id,r.version,r.version_hash,r.payload,r.document_links,k,s,r.last_seen_at,deleted,erp_fiscal_mirror.list_data(r.payload))
 on conflict(entity,source_id)do update set version=excluded.version,version_hash=excluded.version_hash,payload=excluded.payload,document_links=excluded.document_links,
  access_key=excluded.access_key,status_raw=excluded.status_raw,last_seen_at=excluded.last_seen_at,source_deleted=excluded.source_deleted,listing=excluded.listing;
 update erp_fiscal_mirror.issue set resolved_at=clock_timestamp()where entity=r.entity and source_id=r.source_id
  and(source_version<r.version or(code='PROJECTION_FAILED'and source_version=r.version))and resolved_at is null;
 return true;
end$$;
create function erp_fiscal_mirror.capture()returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin perform erp_fiscal_mirror.apply(new);return null;end$$;
create trigger fiscal_mirror_capture after insert or update on origin_sync.raw_record for each row when(new.entity in('nfe','nfce'))execute function erp_fiscal_mirror.capture();

create function public.erp_fiscal_mirror_project(p_limit integer default 100)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r origin_sync.raw_record;x origin_fiscal.source;q record;n integer:=0;a integer:=0;xn integer:=0;failed integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'fiscal_mirror_invalid_limit'using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(174852901,220002)then return jsonb_build_object('processed',0,'applied',0,'xml_processed',0,'failed',0,'pending',null);end if;
 for q in select *from erp_fiscal_mirror.seed where retry_at<=clock_timestamp()order by retry_at,entity,source_id limit p_limit loop
  n:=n+1;
  begin
   select *into r from origin_sync.raw_record where entity=q.entity and source_id=q.source_id;
   if found and erp_fiscal_mirror.apply(r)then a:=a+1;end if;
   delete from erp_fiscal_mirror.seed where entity=q.entity and source_id=q.source_id;
  exception when others then
   failed:=failed+1;
   update erp_fiscal_mirror.seed set retry_at=clock_timestamp()+interval '2 minutes'where entity=q.entity and source_id=q.source_id;
   insert into erp_fiscal_mirror.issue(entity,source_id,source_version,code)values(q.entity,q.source_id,coalesce(r.version,0),'PROJECTION_FAILED')on conflict do nothing;
  end;
 end loop;
 for q in select *from erp_fiscal_mirror.xml_seed where retry_at<=clock_timestamp()order by retry_at,archive_source_id limit p_limit loop
  begin
   select *into x from origin_fiscal.source where id=q.archive_source_id;
   if found then perform erp_fiscal_mirror.xml_refresh(x);end if;xn:=xn+1;
   delete from erp_fiscal_mirror.xml_seed where archive_source_id=q.archive_source_id;
  exception when others then failed:=failed+1;
   update erp_fiscal_mirror.xml_seed set retry_at=clock_timestamp()+interval '2 minutes'where archive_source_id=q.archive_source_id;
  end;
 end loop;
 return jsonb_build_object('processed',n,'applied',a,'xml_processed',xn,'failed',failed,'pending',
  (select count(*)from erp_fiscal_mirror.seed)+(select count(*)from erp_fiscal_mirror.xml_seed));
end$$;

-- A carteira aplica-se também a fiscal/consulta vinculados a vendedor. Nunca associa por nome ou documento.
create function erp_fiscal_mirror.visible(p_user_id uuid,p_entity text,p_source_id text)returns boolean language sql stable set search_path=pg_catalog as $$
 select scope is null or exists(select 1 from erp_catalog.origin o join erp_catalog.contact_profile cp on cp.record_id=o.record_id
  where o.entity='contacts'and cp.seller_id=scope and o.source_id=(select payload#>>'{contato,id}'from(
   select payload,0 priority from erp_fiscal_mirror.current where entity=p_entity and source_id=p_source_id union all
   select payload,1 from origin_sync.raw_record where entity=p_entity and source_id=p_source_id)x order by priority limit 1))
 from(select erp_catalog.contact_scope(p_user_id)scope)s
$$;
create function erp_fiscal_mirror.native_visible(p_user_id uuid,p_id uuid)returns boolean language sql stable set search_path=pg_catalog as $$
 select erp_catalog.contact_visible_to(erp_catalog.contact_scope(p_user_id),(select (recipient->>'contact_id')::uuid from erp_fiscal_invoices.invoice where id=p_id))
$$;
-- Arquivo XML por chave; o vínculo pelo id Origin é só preferência secundária.
create function erp_fiscal_mirror.xml_source(p_entity text,p_source_id text,p_key text)returns setof origin_fiscal.source language sql stable set search_path=pg_catalog as $$
 select s.* from origin_fiscal.source s where s.access_key=p_key and s.current_revision is not null
 order by (s.entity=p_entity and s.source_id=p_source_id)desc,s.last_success_at desc nulls last,s.id limit 1
$$;
create function erp_fiscal_mirror.xml_environment(p_entity text,p_source_id text,p_key text)returns text language sql stable set search_path=pg_catalog as $$
 select environment from erp_fiscal_mirror.xml_cache x where x.access_key=p_key and x.xml_id is not null
 order by(x.entity=p_entity and x.source_id=p_source_id)desc,x.last_success_at desc nulls last,x.archive_source_id limit 1
$$;
create function erp_fiscal_mirror.xml_info(p_entity text,p_source_id text,p_key text)returns setof erp_fiscal_mirror.xml_cache language sql stable set search_path=pg_catalog as $$
 select x.*from erp_fiscal_mirror.xml_cache x where x.access_key=p_key and x.xml_id is not null
 order by(x.entity=p_entity and x.source_id=p_source_id)desc,x.last_success_at desc nulls last,x.archive_source_id limit 1
$$;
-- Uma chave conta uma vez. Prevalece a captura mais recente (desempate pela identidade), sem homologação ocultar produção.
create function erp_fiscal_mirror.canonical(p_entity text,p_source_id text,p_key text)returns boolean language sql stable set search_path=pg_catalog as $$
 select p_key is null or(not exists(select 1 from erp_fiscal_invoices.invoice v left join erp_fiscal_invoices.invoice_source ns on ns.invoice_id=v.id
  where v.access_key=p_key and v.deleted_at is null and(case when v.issue_type in('S','X')then ns.source_environment else v.environment end)is distinct from '2')
  and not exists(select 1 from erp_fiscal_mirror.current x where x.access_key=p_key and not x.source_deleted
   and (x.last_seen_at,x.entity,x.source_id)>(coalesce((select last_seen_at from erp_fiscal_mirror.current where entity=p_entity and source_id=p_source_id),'-infinity'),p_entity,p_source_id)
   and erp_fiscal_mirror.xml_environment(x.entity,x.source_id,x.access_key)is distinct from'2'))
$$;

-- Consulta em conjunto: resolve XML/chave uma vez por linha e a carteira uma vez por requisição.
-- Mantém o payload completo fora do materialized/sort da lista e dos totais.
create view erp_fiscal_mirror.listing_rows as
 with sources as materialized(
  select r.entity,r.source_id,r.access_key,r.last_seen_at,r.source_deleted,r.listing,r.status_raw,
   x.environment,x.xml_id,x.xml_hash,x.xml_size,coalesce(x.protocol_present,false)protocol_present,coalesce(x.event_count,0)event_count,
   not r.source_deleted and x.environment is distinct from'2'eligible
  from erp_fiscal_mirror.current r left join lateral(select x.*from erp_fiscal_mirror.xml_cache x
   where x.access_key=r.access_key and x.xml_id is not null
   order by(x.entity=r.entity and x.source_id=r.source_id)desc,x.last_success_at desc nulls last,x.archive_source_id limit 1)x on true),
 ranked as(select s.*,row_number()over(partition by access_key order by eligible desc,last_seen_at desc,entity desc,source_id desc)key_position from sources s)
 select r.*,(r.access_key is null or(r.key_position=1 and not exists(
  select 1 from erp_fiscal_invoices.invoice v left join erp_fiscal_invoices.invoice_source ns on ns.invoice_id=v.id
  where v.access_key=r.access_key and v.deleted_at is null and(case when v.issue_type in('S','X')then ns.source_environment else v.environment end)is distinct from'2')))canonical
 from ranked r;

create function erp_fiscal_mirror.coverage(p_user_id uuid,p_model text,p_direction text)returns jsonb language sql stable set search_path=pg_catalog as $$
 with scope as materialized(select erp_catalog.contact_scope(p_user_id)id),
 sources as materialized(select r.*
  from erp_fiscal_mirror.listing_rows r cross join scope
  where r.entity=case p_model when '65'then'nfce'else'nfe'end
  and(p_model='65'or r.listing->>'direction'=p_direction)and(scope.id is null or exists(
   select 1 from erp_catalog.origin o join erp_catalog.contact_profile cp on cp.record_id=o.record_id
   where o.entity='contacts'and o.source_id=r.listing->>'contact_source_id'and cp.seller_id=scope.id))),
 visible as materialized(select * from sources where not source_deleted and environment is distinct from '2'and canonical)
 select jsonb_build_object('scope','model_direction','source_count',(select count(*)from sources),
  'visible_count',(select count(*)from visible),'xml_count',(select count(*)from visible where xml_id is not null),
  'missing_xml_count',(select count(*)from visible where xml_id is null),
  'homologation_count',(select count(*)from sources where environment='2'),
  'duplicate_count',(select count(*)from sources where not canonical),
  'incomplete_count',(select count(*)from visible where access_key is null or listing->>'total'is null or listing->>'status'is null),
  'oldest_observed_at',(select min(last_seen_at)from visible),'latest_observed_at',(select max(last_seen_at)from visible),
  'partial',exists(select 1 from visible where xml_id is null or access_key is null or listing->>'total'is null or listing->>'status'is null)
   or exists(select 1 from erp_fiscal_mirror.seed q join origin_sync.raw_record r on r.entity=q.entity and r.source_id=q.source_id cross join scope
    where r.entity=case p_model when'65'then'nfce'else'nfe'end and(p_model='65'or r.payload->>'tipo'=p_direction)
     and(scope.id is null or exists(select 1 from erp_catalog.origin o join erp_catalog.contact_profile cp on cp.record_id=o.record_id
      where o.entity='contacts'and o.source_id=r.payload#>>'{contato,id}'and cp.seller_id=scope.id)))
   or exists(select 1 from erp_fiscal_mirror.xml_seed q join origin_fiscal.source x on x.id=q.archive_source_id
    where exists(select 1 from sources s where s.access_key=x.access_key)))
$$;

insert into erp_fiscal_mirror.seed(entity,source_id)select entity,source_id from origin_sync.raw_record where entity in('nfe','nfce');
insert into erp_fiscal_mirror.xml_seed(archive_source_id)select id from origin_fiscal.source;
do $$declare t text;begin foreach t in array array['observation','current','status_change','issue','xml_cache','seed','xml_seed']loop execute format('alter table erp_fiscal_mirror.%I enable row level security',t);end loop;end$$;
revoke all on all tables in schema erp_fiscal_mirror from public,anon,authenticated,service_role;
revoke all on all functions in schema erp_fiscal_mirror from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_mirror_project(integer)from public,anon,authenticated;
grant execute on function public.erp_fiscal_mirror_project(integer)to service_role;
commit;
