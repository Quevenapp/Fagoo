-- Fiscal espelhado: carteira nos XMLs sincronizados, no backup fiscal e na leitura de marcadores.
-- Marcadores de fontes Origin são somente leitura; marcadores nativos conservam carteira, módulo, CAS e auditoria.
-- Só identidade: entidade + ID + chave para o acervo sincronizado; chave para o backup.
-- Sem identidade atual ou com associação ambígua, o usuário restrito não vê a linha nem baixa o arquivo.
-- Administrador e demais leitores sem carteira mantêm acesso ao acervo legado sem raw correspondente.
-- Permanecem Storage privado, tamanho/hash/modelo, revisões imutáveis e a dupla conferência HTTP do download.
begin;

do $$declare r record;begin
 if to_regprocedure('erp_fiscal_mirror.visible(uuid,text,text)') is null then
  raise exception 'fiscal_xml_scope_004_requires_fiscal_mirror_002' using errcode='55000';end if;
 for r in select * from(values
  ('public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean)','6c4939dc5b6211fb4885bf75b61b8a3c0952952ab4b2043c2dba30f283b5ae93'),
  ('public.erp_synced_xml_object(uuid,uuid)','f70ba7b3100cdb98a1cc4aa67fa888e784bec6405316af79e9d7d98e9d93a291'),
  ('public.erp_history_xml(uuid,text,integer,integer,text,text,text)','842cef49f521371ec7554f4f48b0698abf7250df3d8646effb8fc0e88392b64e'),
  ('public.erp_history_xml_object(uuid,text,text)','dc02584276bd742794c528c6376a3a6f88011da3e4a02f6f57c509b58dd06aec'),
  ('public.erp_catalog_invoice_tags(uuid,text,text,text[])','98afe71cb7d764bb8e02010c425cf529f776ce15d8a2d5a93dc1a7452c864060'),
  ('public.erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text)','ffd99a7e1d335329323d2e32b51a5a4bb24c8fec17c4cf95fa0f2fe6bd7e6ee6')
 )v(sig,expected) loop
  if(select encode(sha256(convert_to(replace(prosrc,E'\r',''),'UTF8')),'hex')from pg_proc where oid=to_regprocedure(r.sig))is distinct from r.expected then
   raise exception 'fiscal_xml_scope_004_previous_definition_changed %',r.sig using errcode='55000';end if;
 end loop;
end$$;

create index fiscal_xml_raw_key on origin_sync.raw_record((payload->>'chaveAcesso'),entity,source_id) where entity in('nfe','nfce');

-- Lists resolve the seller only once and join the known key set, avoiding one permission lookup per XML.
create function erp_fiscal_mirror.archive_visible_keys(p_scope uuid)returns table(access_key text)
language sql stable set search_path=pg_catalog as $$
 with sources as(
  select c.entity,c.access_key,c.payload#>>'{contato,id}' contact_id from erp_fiscal_mirror.current c where p_scope is not null
  union all
  select r.entity,r.payload->>'chaveAcesso',r.payload#>>'{contato,id}' from origin_sync.raw_record r
   where p_scope is not null and r.entity in('nfe','nfce') and not exists(
    select 1 from erp_fiscal_mirror.current c where c.entity=r.entity and c.source_id=r.source_id))
 select s.access_key from sources s left join erp_catalog.origin o on o.entity='contacts'and o.source_id=s.contact_id
 left join erp_catalog.contact_profile cp on cp.record_id=o.record_id
 where s.access_key~'^[0-9]{44}$'and substring(s.access_key,21,2)=case s.entity when 'nfe'then'55'else'65'end
 group by s.access_key having bool_and(coalesce(cp.seller_id=p_scope,false))
$$;

-- Backup metadata has no reliable source ID. A key shared by conflicting contact scopes is hidden.
create function erp_fiscal_mirror.archive_key_visible(p_user_id uuid,p_key text) returns boolean
language sql stable set search_path=pg_catalog as $$
 with sources as materialized(
  select c.entity,c.source_id from erp_fiscal_mirror.current c where c.access_key=p_key
   and substring(p_key,21,2)=case c.entity when 'nfe' then '55' else '65' end
  union all
  select r.entity,r.source_id from origin_sync.raw_record r
   where r.entity in('nfe','nfce') and r.payload->>'chaveAcesso'=p_key
    and substring(p_key,21,2)=case r.entity when 'nfe' then '55' else '65' end
    and not exists(select 1 from erp_fiscal_mirror.current c where c.entity=r.entity and c.source_id=r.source_id))
 select erp_catalog.contact_scope(p_user_id) is null or (
  p_key ~ '^[0-9]{44}$' and exists(select 1 from sources)
  and not exists(select 1 from sources s where not erp_fiscal_mirror.visible(p_user_id,s.entity,s.source_id)))
$$;

-- XML identities may predate the current Origin ID. Key fallback must have one unambiguous visible scope.
-- A source ID reused with a different key never gives access to its older archive.
create function erp_fiscal_mirror.archive_source_visible(p_user_id uuid,p_entity text,p_source_id text,p_key text) returns boolean
language sql stable set search_path=pg_catalog as $$
 select erp_catalog.contact_scope(p_user_id) is null or (
  erp_fiscal_mirror.archive_key_visible(p_user_id,p_key) and not exists(
   select 1 from(select access_key from(
    select c.access_key,0 priority from erp_fiscal_mirror.current c where c.entity=p_entity and c.source_id=p_source_id
    union all
    select r.payload->>'chaveAcesso',1 from origin_sync.raw_record r where r.entity=p_entity and r.source_id=p_source_id
   )c order by priority limit 1)identity where access_key is distinct from p_key))
$$;

create or replace function public.erp_synced_xml_list(p_user_id uuid,p_limit integer default 25,p_after uuid default null,p_query text default null,p_model text default null,p_kind text default null,p_include_history boolean default false)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;v_scope uuid;
begin
 perform erp_access.require_history_role(p_user_id);
  perform erp_fiscal_invoices.require_read(p_user_id);
 if p_limit is null or p_limit not between 1 and 100 or p_include_history is null or length(p_query)>64 or p_query ~ '[[:cntrl:]]'
  or (p_model is not null and p_model not in('55','65')) or(p_kind is not null and p_kind not in('invoice','event')) then raise exception 'erp_invalid_query' using errcode='22023';end if;
 v_scope:=erp_catalog.contact_scope(p_user_id);
 with visible_keys as materialized(select access_key from erp_fiscal_mirror.archive_visible_keys(v_scope)),rows as materialized(
  select i.id,jsonb_build_object('id',i.id,'source_id',s.source_id,'entity',s.entity,'key',s.access_key,
   'model',o.metadata->>'model','environment',o.metadata->>'environment','kind',o.metadata->>'kind','revision',r.revision,
   'source_status',r.source_status,'collected_at',r.collected_at,'xml_hash',o.hash,'size_bytes',o.size,
   'protocol',o.metadata->'protocol','protocol_present',o.metadata->'protocol_present','signature_present',o.metadata->'signature_present',
   'event_type',o.metadata->'event_type','event_sequence',o.metadata->'event_sequence','issues',o.metadata->'issues',
   'validation','structural_only','signature_verified',false,'xsd_validated',false,'authorization_verified',false) item
  from origin_fiscal.item i join origin_fiscal.revision r on r.id=i.revision join origin_fiscal.source s on s.id=r.source join origin_fiscal.object o on o.hash=i.object_hash left join visible_keys k on k.access_key=s.access_key
  where(v_scope is null or(k.access_key is not null
    and not exists(select 1 from erp_fiscal_mirror.current c where c.entity=s.entity and c.source_id=s.source_id and c.access_key is distinct from s.access_key)
    and not exists(select 1 from origin_sync.raw_record r where r.entity=s.entity and r.source_id=s.source_id and r.payload->>'chaveAcesso' is distinct from s.access_key
     and not exists(select 1 from erp_fiscal_mirror.current c where c.entity=r.entity and c.source_id=r.source_id))))
   and(p_include_history or s.current_revision=r.id) and(p_after is null or i.id>p_after)
   and(nullif(p_query,'') is null or strpos(s.access_key,p_query)>0) and(p_model is null or o.metadata->>'model'=p_model) and(p_kind is null or o.metadata->>'kind'=p_kind)
  order by i.id limit p_limit+1
 ), page as(select * from rows order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(item order by id) from page),'[]'::jsonb),'limit',p_limit,
  'has_more',(select count(*) from rows)>p_limit,'next_cursor',case when(select count(*) from rows)>p_limit then(select id from page order by id desc limit 1) end,'data_mode','fiscal_archive_readonly') into result;
 return result;
end; $$;

create or replace function public.erp_synced_xml_object(p_user_id uuid,p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform erp_access.require_history_role(p_user_id);
  perform erp_fiscal_invoices.require_read(p_user_id);perform origin_fiscal.storage_ready();
 select jsonb_build_object('id',i.id,'revision_id',i.revision,'bucket','origin-fiscal-xml','object_key','objects/'||o.hash||'.xml','sha256',o.hash,'size',o.size,'model',o.metadata->>'model') into result
 from origin_fiscal.item i join origin_fiscal.revision r on r.id=i.revision
 join origin_fiscal.source s on s.id=r.source join origin_fiscal.object o on o.hash=i.object_hash join storage.objects so on so.bucket_id='origin-fiscal-xml' and so.name='objects/'||o.hash||'.xml'
 where i.id=p_id and erp_fiscal_mirror.archive_source_visible(p_user_id,s.entity,s.source_id,s.access_key) and so.metadata->>'size'=o.size::text and so.metadata->>'mimetype' in('application/xml','application/octet-stream');
 if result is null then raise exception 'erp_history_not_found' using errcode='P0002';end if;return result;
end; $$;

create or replace function public.erp_history_xml(
  p_user_id uuid,p_backup_sha text,p_limit integer default 25,p_offset integer default 0,
  p_query text default null,p_model text default null,p_kind text default null
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_result jsonb;v_scope uuid;
begin
  perform erp_access.require_history_role(p_user_id);
  perform erp_fiscal_invoices.require_read(p_user_id);
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or length(p_query)>64 or p_query ~ '[[:cntrl:]]'
    or (p_model is not null and p_model not in ('55','65'))
    or (p_kind is not null and p_kind not in ('invoice','event')) then
    raise exception 'erp_invalid_query' using errcode='22023';
  end if;
  if not exists(select 1 from origin_backup.batch where backup_sha=p_backup_sha and status in ('stored','stored_with_issues')) then
    raise exception 'erp_history_not_ready' using errcode='P0002';
  end if;
  v_scope:=erp_catalog.contact_scope(p_user_id);
  with visible_keys as materialized(select access_key from erp_fiscal_mirror.archive_visible_keys(v_scope)),originals as materialized (
    select r.data->>'sha256' id,min(r.file_id) file_id,count(*) occurrences
    from origin_backup.record r left join visible_keys k on k.access_key=r.data->>'key' where r.backup_sha=p_backup_sha and r.kind='xml'
      and r.data->>'sha256' ~ '^[0-9a-f]{64}$'
      and(v_scope is null or k.access_key is not null)
    group by r.data->>'sha256'
  ), candidates as materialized (
    select o.id,o.occurrences,r.data,erp_access.scalar_text(r.data->'key',44) access_key,
      erp_access.scalar_text(r.data->'protocol',20) protocol,erp_access.scalar_text(r.data->'model',2) model,erp_access.scalar_text(r.data->'kind',20) kind
    from originals o join origin_backup.record r on r.backup_sha=p_backup_sha and r.kind='xml' and r.file_id=o.file_id and r.record_no=0
  ), filtered as materialized (
    select * from candidates where
      (nullif(btrim(p_query),'') is null or strpos(lower(concat_ws(' ',access_key,protocol)),lower(btrim(p_query)))>0)
      and(p_model is null or model=p_model) and(p_kind is null or kind=p_kind)
  ), page as (select * from filtered order by access_key collate "C",id collate "C" limit p_limit offset p_offset),summaries as (
    select o.id,jsonb_build_object('id',o.id,'occurrences',o.occurrences,
      'key',erp_access.scalar_text(o.data->'key',44),'model',erp_access.scalar_text(o.data->'model',2),
      'environment',erp_access.scalar_text(o.data->'environment',1),'kind',erp_access.scalar_text(o.data->'kind',20),
      'protocol',erp_access.scalar_text(o.data->'protocol',20),
      'protocol_present',o.data->'protocol_present'='true'::jsonb,
      'signature_present',o.data->'signature_present'='true'::jsonb,
      'event_type',erp_access.scalar_text(o.data->'event_type',6),'sequence',erp_access.scalar_text(o.data->'sequence',6),
      'issues',coalesce((select jsonb_agg(code order by code) from (
        select distinct erp_access.scalar_text(i.data->'code',80) code
        from origin_backup.record i join origin_backup.record x
          on x.backup_sha=i.backup_sha and x.file_id=i.file_id and x.kind='xml'
        where i.backup_sha=p_backup_sha and i.kind='issue' and x.data->>'sha256'=o.id
      ) codes where code is not null),'[]'::jsonb),
      'validation','structural_only','signature_verified',false,'xsd_validated',false
    ) item from page o
  )
  select jsonb_build_object('backup_id',p_backup_sha,'items',coalesce((select jsonb_agg(item order by item->>'key' collate "C",id collate "C") from summaries),'[]'::jsonb),
    'limit',p_limit,'offset',p_offset,'total',(select count(*) from filtered),
    'has_more',(select count(*) from filtered)>p_offset+p_limit,
    'next_offset',case when (select count(*) from filtered)>p_offset+p_limit then p_offset+p_limit end,
    'data_mode','backup_readonly') into v_result;
  return v_result;
end;
$$;

create or replace function public.erp_history_xml_object(p_user_id uuid,p_backup_sha text,p_xml_sha text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare v_object jsonb;
begin
  perform erp_access.require_history_role(p_user_id);
  perform erp_fiscal_invoices.require_read(p_user_id);
  if p_backup_sha is null or p_backup_sha !~ '^[0-9a-f]{64}$' or p_xml_sha is null or p_xml_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'erp_invalid_query' using errcode='22023';
  end if;
  select jsonb_build_object('bucket','origin-backups','object_key',f.data->>'object_key',
    'sha256',p_xml_sha,'size',(f.data->>'object_size')::integer,
    'model',erp_access.scalar_text(x.data->'model',2)) into v_object
  from origin_backup.record x
  join origin_backup.record f on f.backup_sha=x.backup_sha and f.file_id=x.file_id and f.kind='file' and f.record_no=0
  join origin_backup.batch b on b.backup_sha=x.backup_sha and b.status in ('stored','stored_with_issues')
  join storage.buckets bucket on bucket.id='origin-backups' and bucket.public=false
  join storage.objects obj on obj.bucket_id=bucket.id and obj.name=f.data->>'object_key'
  where x.backup_sha=p_backup_sha and x.kind='xml'
    and erp_fiscal_mirror.archive_key_visible(p_user_id,x.data->>'key') and x.data->>'sha256'=p_xml_sha
    and f.data->>'storage_representation'='object' and f.data->>'object_sha256'=p_xml_sha
    and f.data->>'object_key'='objects/'||p_xml_sha||'.xml'
    and (f.data->>'object_size')::bigint between 1 and 8388608
  order by x.file_id limit 1;
  if v_object is null then raise exception 'erp_history_not_found' using errcode='P0002'; end if;
  return v_object;
end;
$$;

create or replace function public.erp_catalog_invoice_tags(p_user_id uuid,p_origin text,p_model text,p_ids text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_catalog.require_invoice_tags(p_user_id,p_origin,false);
 perform erp_fiscal_invoices.require_read(p_user_id);
 if p_ids is null or cardinality(p_ids) not between 1 and 100 or array_position(p_ids,null) is not null
  or(select count(distinct i) from unnest(p_ids) i)<>cardinality(p_ids) or exists(select 1 from unnest(p_ids) i where not erp_catalog.invoice_tag_key_valid(p_origin,p_model,i)) then
  raise exception 'erp_catalog_invalid_query' using errcode='22023'; end if;
 if exists(select 1 from unnest(p_ids) id where not(case when p_origin='origin' then
  erp_fiscal_mirror.visible(p_user_id,case p_model when '55' then 'nfe' else 'nfce' end,id)
  else erp_fiscal_mirror.native_visible(p_user_id,id::uuid) end)) then
  raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('scope','invoice_tags','origin',p_origin,'model',p_model,'data_mode','erp_native',
  'items',(select jsonb_agg(erp_catalog.invoice_tags_data(p_origin,p_model,u.id) order by u.n) from unnest(p_ids) with ordinality u(id,n)));
end $$;

create or replace function public.erp_catalog_invoice_tags_save(p_user_id uuid,p_origin text,p_model text,p_id text,p_expected_version integer,p_command_id uuid,
 p_tag_ids jsonb,p_mode text default 'replace')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text; v_command erp_catalog.command%rowtype; v_tags uuid[]; v_current integer; v_before jsonb; v_after jsonb; v_changed boolean; v_result jsonb;
begin
 perform erp_catalog.require_invoice_tags(p_user_id,p_origin,true);
 perform erp_fiscal_invoices.require_write(p_user_id);
 if p_origin='origin' then raise exception 'erp_fiscal_mirror_readonly' using errcode='42501'; end if;
 if p_command_id is null or p_mode is null or p_mode not in('replace','add') or not erp_catalog.invoice_tag_key_valid(p_origin,p_model,p_id)
  or(p_mode='replace' and(p_expected_version is null or p_expected_version not between 0 and 2147483646)) or(p_mode='add' and p_expected_version is not null)
  or p_tag_ids is null or jsonb_typeof(p_tag_ids)<>'array' or jsonb_array_length(p_tag_ids)>50 or(p_mode='add' and jsonb_array_length(p_tag_ids)=0)
  or exists(select 1 from jsonb_array_elements(p_tag_ids) t where jsonb_typeof(t)<>'string' or t#>>'{}'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
  raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 if not erp_fiscal_mirror.native_visible(p_user_id,p_id::uuid) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 select coalesce(array_agg(distinct(t#>>'{}')::uuid),'{}'::uuid[]) into v_tags from jsonb_array_elements(p_tag_ids) t;
 if cardinality(v_tags)<>jsonb_array_length(p_tag_ids) then raise exception 'erp_catalog_invalid_command' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','invoice_tags','origin',p_origin,'model',p_model,'id',p_id,'version',p_expected_version,
  'mode',p_mode,'tags',p_tag_ids)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 perform 1 from erp_catalog.taxonomy t where t.id=any(v_tags) order by t.id for key share;
 if(select count(*) from erp_catalog.taxonomy t where t.id=any(v_tags) and t.kind='tags' and t.tag_type='invoices')<>cardinality(v_tags) then
  raise exception 'erp_catalog_invalid_reference' using errcode='22023'; end if;
 if not erp_catalog.invoice_tag_target(p_origin,p_model,p_id) then raise exception 'erp_catalog_not_found' using errcode='P0002'; end if;
 -- One tag writer per note: two first saves (no state row yet) cannot both pass the version check.
 perform pg_advisory_xact_lock(174853101,hashtext(p_origin||':'||p_model||':'||p_id));
 select version into v_current from erp_catalog.invoice_tag_state where origin=p_origin and model=p_model and invoice_id=p_id for update;
 v_current:=coalesce(v_current,0);
 if p_mode='replace' and v_current<>p_expected_version then raise exception 'erp_catalog_version_conflict' using errcode='40001'; end if;
 v_before:=erp_catalog.invoice_tag_ids(p_origin,p_model,p_id);
 if p_mode='replace' then delete from erp_catalog.invoice_tag where origin=p_origin and model=p_model and invoice_id=p_id and not tag_id=any(v_tags); end if;
 insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) select p_origin,p_model,p_id,t from unnest(v_tags) t on conflict do nothing;
 if(select count(*) from erp_catalog.invoice_tag where origin=p_origin and model=p_model and invoice_id=p_id)>50 then raise exception 'erp_catalog_invalid_list' using errcode='22023'; end if;
 v_after:=erp_catalog.invoice_tag_ids(p_origin,p_model,p_id); v_changed:=v_after is distinct from v_before;
 if v_changed then
  perform erp_catalog.invoice_tag_bump(p_user_id,p_origin,p_model,p_id);
  insert into erp_catalog.invoice_tag_audit(actor,command_id,origin,model,invoice_id,action,before_data,after_data)
   values(p_user_id,p_command_id,p_origin,p_model,p_id,case p_mode when 'add' then 'tags_added' else 'tags_update' end,jsonb_build_object('tag_ids',v_before),jsonb_build_object('tag_ids',v_after));
 end if;
 v_result:=jsonb_build_object('scope','invoice_tags','origin',p_origin,'model',p_model,'invoice',erp_catalog.invoice_tags_data(p_origin,p_model,p_id),'changed',v_changed,
  'replayed',false,'data_mode','erp_native');
 insert into erp_catalog.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_fiscal_mirror.archive_visible_keys(uuid),erp_fiscal_mirror.archive_source_visible(uuid,text,text,text),erp_fiscal_mirror.archive_key_visible(uuid,text)
 from public,anon,authenticated,service_role;
revoke all on function public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean),
 public.erp_synced_xml_object(uuid,uuid),
 public.erp_history_xml(uuid,text,integer,integer,text,text,text),
 public.erp_history_xml_object(uuid,text,text),
 public.erp_catalog_invoice_tags(uuid,text,text,text[]),
 public.erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.erp_synced_xml_list(uuid,integer,uuid,text,text,text,boolean),
 public.erp_synced_xml_object(uuid,uuid),
 public.erp_history_xml(uuid,text,integer,integer,text,text,text),
 public.erp_history_xml_object(uuid,text,text),
 public.erp_catalog_invoice_tags(uuid,text,text,text[]),
 public.erp_catalog_invoice_tags_save(uuid,text,text,text,integer,uuid,jsonb,text) to service_role;
commit;
