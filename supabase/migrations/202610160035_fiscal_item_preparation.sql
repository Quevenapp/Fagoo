-- Explicit item identification decisions; no tax selection, commercial mutation or emission.
begin;
create schema erp_fiscal_items;
revoke all on schema erp_fiscal_items from public,anon,authenticated,service_role;
create table erp_fiscal_items.command (
 command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_items.revision (
 draft_id uuid not null,version integer not null check(version>0),draft_version integer not null check(draft_version>0),
 snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 decisions jsonb not null check(jsonb_typeof(decisions)='array'),record jsonb not null check(jsonb_typeof(record)='object'),
 actor uuid not null references auth.users(id),command_id uuid not null unique references erp_fiscal_items.command(command_id) deferrable initially deferred,
 created_at timestamptz not null default clock_timestamp(),primary key(draft_id,version),
 foreign key(draft_id,draft_version) references erp_fiscal_drafts.revision(draft_id,version)
);
create table erp_fiscal_items.head (
 draft_id uuid primary key references erp_fiscal_drafts.draft(id),version integer not null check(version>0),
 foreign key(draft_id,version) references erp_fiscal_items.revision(draft_id,version)
);
alter table erp_fiscal_items.head enable row level security;
alter table erp_fiscal_items.revision enable row level security;
alter table erp_fiscal_items.command enable row level security;
revoke all on all tables in schema erp_fiscal_items from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_items revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_items revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_items.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_item_history_immutable' using errcode='42501';end $$;
create trigger immutable_revision before update or delete on erp_fiscal_items.revision for each row execute function erp_fiscal_items.immutable();
create trigger immutable_command before update or delete on erp_fiscal_items.command for each row execute function erp_fiscal_items.immutable();
create function erp_fiscal_items.guard_head() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_item_head_immutable' using errcode='42501';end if;
 if new.draft_id<>old.draft_id or old.version=2147483647 or new.version<>old.version+1 then
  raise exception 'erp_fiscal_item_version_conflict' using errcode='40001';end if;return new;
end $$;
create trigger guard_head before update or delete on erp_fiscal_items.head for each row execute function erp_fiscal_items.guard_head();
create function erp_fiscal_items.flags() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_item_preparation','profile','item-identification-v1','schema_profile','pl010f-v1.04',
  'operational_effects',false,'emission_enabled',false,'can_emit',false,'tax_rules_validated',false,'xsd_validated',false,'catalog_registry_verified',false)
$$;
create function erp_fiscal_items.gtin_valid(v text) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare i integer;s integer:=0;w integer:=3;begin
 if v is null or v!~'^([0-9]{8}|[0-9]{12,14})$' then return false;end if;
 for i in reverse length(v)-1..1 loop s:=s+substring(v,i,1)::integer*w;w:=case w when 3 then 1 else 3 end;end loop;
 return (10-s%10)%10=right(v,1)::integer;
end $$;
create function erp_fiscal_items.field_value(v jsonb,f text) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare t text;begin
 if v='null'::jsonb then return v;end if;
 if v is null or jsonb_typeof(v)<>'string' then raise exception 'erp_fiscal_item_value_invalid' using errcode='22023';end if;
 t:=v#>>'{}';
 if (f='ncm' and t!~'^([0-9]{2}|[0-9]{8})$') or (f='origin' and t!~'^[0-8]$') or (f='cest' and t!~'^[0-9]{7}$')
  or (f in('gtin','gtin_tax') and t<>'SEM GTIN' and not erp_fiscal_items.gtin_valid(t))
  or f not in('ncm','origin','cest','gtin','gtin_tax') then raise exception 'erp_fiscal_item_value_invalid' using errcode='22023';end if;
 return v;
end $$;
-- Validate the decision syntax independently of catalog resolution. No trimming/coercion/default fiscal value.
create function erp_fiscal_items.validate_decisions(v jsonb) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare e jsonb;c jsonb;f text;seen text[]:='{}';begin
 if v is null or jsonb_typeof(v)<>'array' then raise exception 'erp_fiscal_item_decisions_invalid' using errcode='22023';end if;
 if jsonb_array_length(v)>250 or octet_length(v::text)>262144 then raise exception 'erp_fiscal_item_decisions_limit' using errcode='22023';end if;
 for e in select value from jsonb_array_elements(v) loop
  if jsonb_typeof(e) is distinct from 'object' or not(e?'item_id' and e?'fields')
   or exists(select 1 from jsonb_object_keys(e)k where k not in('item_id','fields'))
   or jsonb_typeof(e->'item_id') is distinct from 'string' or e->>'item_id'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   or jsonb_typeof(e->'fields') is distinct from 'object' or e->'fields'='{}'::jsonb then
   raise exception 'erp_fiscal_item_decision_invalid' using errcode='22023';end if;
  if e->>'item_id'=any(seen) then raise exception 'erp_fiscal_item_duplicate' using errcode='22023';end if;
  seen:=array_append(seen,e->>'item_id');
  for f,c in select key,value from jsonb_each(e->'fields') loop
   if f not in('ncm','origin','cest','gtin','gtin_tax') or jsonb_typeof(c) is distinct from 'object' then
    raise exception 'erp_fiscal_item_choice_invalid' using errcode='22023';end if;
   if c->>'source'='manual' then
    if not(c?'value') or exists(select 1 from jsonb_object_keys(c)k where k not in('source','value')) then raise exception 'erp_fiscal_item_choice_invalid' using errcode='22023';end if;
    perform erp_fiscal_items.field_value(c->'value',f);
   elsif c->>'source'='catalog' then
    if not(c?'expected_product_id' and c?'expected_version') or exists(select 1 from jsonb_object_keys(c)k where k not in('source','expected_product_id','expected_version'))
     or jsonb_typeof(c->'expected_product_id') is distinct from 'string' or c->>'expected_product_id'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     or jsonb_typeof(c->'expected_version') is distinct from 'number' or c->>'expected_version'!~'^[1-9][0-9]{0,9}$'
     or (c->>'expected_version')::numeric>2147483647 then raise exception 'erp_fiscal_item_choice_invalid' using errcode='22023';end if;
   else raise exception 'erp_fiscal_item_choice_invalid' using errcode='22023';end if;
  end loop;
 end loop;
end $$;
-- Save calls this only while selected catalog parents are SHARE locked, in UUID order.
create function erp_fiscal_items.resolve(p_record jsonb,p_decisions jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare i jsonb;e jsonb;c jsonb;f text;v jsonb;prov jsonb;fields jsonb;items jsonb:='[]';pending text[];r erp_catalog.record%rowtype;p erp_catalog.product%rowtype;
begin
 perform erp_fiscal_items.validate_decisions(p_decisions);
 if exists(select 1 from jsonb_array_elements(p_decisions)dec where not exists(select 1 from jsonb_array_elements(p_record#>'{snapshot,items}')src where src->>'id'=dec->>'item_id')) then
  raise exception 'erp_fiscal_item_foreign_item' using errcode='22023';end if;
 for i in select value from jsonb_array_elements(p_record#>'{snapshot,items}') loop
  select value->'fields' into e from jsonb_array_elements(p_decisions) where value->>'item_id'=i->>'id';
  fields:='{}';pending:='{}';
  foreach f in array array['ncm','origin','cest','gtin','gtin_tax'] loop
   c:=e->f;v:='null';prov:=jsonb_build_object('source','unreviewed');
   if c is not null then
    if c->>'source'='manual' then v:=erp_fiscal_items.field_value(c->'value',f);prov:=jsonb_build_object('source','manual');
    else
     if i->>'product_id' is null or c->>'expected_product_id'<>i->>'product_id' then raise exception 'erp_fiscal_item_product_mismatch' using errcode='22023';end if;
     select * into r from erp_catalog.record where id=(i->>'product_id')::uuid and entity='products';
     if not found then raise exception 'erp_fiscal_item_catalog_unavailable' using errcode='40001';end if;
     if r.version<>(c->>'expected_version')::integer then raise exception 'erp_fiscal_item_catalog_conflict' using errcode='40001';end if;
     select * into p from erp_catalog.product where record_id=r.id;
     if not found then raise exception 'erp_fiscal_item_catalog_unavailable' using errcode='40001';end if;
     v:=erp_fiscal_items.field_value(to_jsonb(p)->f,f);
     prov:=jsonb_build_object('source','catalog','product_id',r.id,'product_version',r.version,'active',r.active);
    end if;
   end if;
   fields:=fields||jsonb_build_object(f,jsonb_build_object('value',v,'provenance',prov,'check_digit_verified',f in('gtin','gtin_tax') and v<>'null'::jsonb and v<>'"SEM GTIN"'::jsonb));
   if v='null'::jsonb then pending:=array_append(pending,case f when 'ncm' then 'NCM_NOT_PREPARED' when 'origin' then 'ORIGIN_NOT_PREPARED' when 'cest' then 'CEST_NOT_PREPARED' when 'gtin' then 'GTIN_NOT_PREPARED' else 'TRIBUTARY_GTIN_NOT_PREPARED' end);end if;
  end loop;
  if length(fields#>>'{ncm,value}')=2 then pending:=array_append(pending,'NCM_EXCEPTION_REQUIRES_REVIEW');end if;
  pending:=pending||array['NCM_CLASSIFICATION_UNVERIFIED','ORIGIN_CLASSIFICATION_UNVERIFIED','CEST_APPLICABILITY_UNREVIEWED','GTIN_PRODUCT_MAPPING_UNVERIFIED','CFOP_UNPREPARED','CST_CSOSN_UNPREPARED','TAX_GROUPS_UNPREPARED','TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED'];
  if i->>'product_id' is null then pending:=array_append(pending,'FREE_ITEM_REQUIRES_REVIEW');end if;
  items:=items||jsonb_build_array(jsonb_build_object('item_id',i->'id','position',i->'position','product_id',i->'product_id','fields',fields,'pending',pending));
 end loop;return items;
end $$;
create function erp_fiscal_items.receipt(p_record jsonb,p_version integer,p_items jsonb,p_created_at timestamptz) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('draft_id',p_record->'id','version',p_version,'draft_version',p_record->'version','snapshot_hash',p_record->'snapshot_hash',
  'model',p_record->'model','environment','2','source_document_id',p_record->'source_document_id','source_document_version',p_record->'source_document_version',
  'created_at',p_created_at,'items',p_items)
$$;
create function erp_fiscal_items.envelope(p_draft_id uuid,p_record jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;v integer;begin
 select version into v from erp_fiscal_items.head where draft_id=p_draft_id;
 if p_record is null then d:=erp_fiscal_drafts.record(p_draft_id);
 else select record into d from erp_fiscal_drafts.revision where draft_id=p_draft_id and version=(p_record->>'draft_version')::integer;end if;
 if d is null then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 return erp_fiscal_items.flags()||jsonb_build_object('record',p_record,'draft',erp_fiscal_drafts.envelope(d),
  'current',jsonb_build_object('preparation_version',coalesce(v,0),'draft_version',(select version from erp_fiscal_drafts.draft where id=p_draft_id),
   'matches_current_draft',p_record is not null and (p_record->>'draft_version')::integer=(select version from erp_fiscal_drafts.draft where id=p_draft_id)));
end $$;
create function erp_fiscal_items.check_binding(p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_expected_version integer) returns jsonb
language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb;v integer;begin
 if p_draft_id is null or p_expected_draft_version is null or p_expected_draft_version<1 or p_snapshot_hash is null or p_snapshot_hash!~'^[0-9a-f]{64}$'
  or p_expected_version is null or p_expected_version<0 then raise exception 'erp_fiscal_item_binding_invalid' using errcode='22023';end if;
 r:=erp_fiscal_drafts.record(p_draft_id);
 if r is null then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 select version into v from erp_fiscal_items.head where draft_id=p_draft_id;
 if r->>'status'<>'draft' or (r->>'version')::integer<>p_expected_draft_version or r->>'snapshot_hash'<>p_snapshot_hash
  or coalesce(v,0)<>p_expected_version or p_expected_version=2147483647
  or (select status from erp_documents.document where id=(r->>'source_document_id')::uuid)='cancelled' then
  raise exception 'erp_fiscal_item_version_conflict' using errcode='40001';end if;return r;
end $$;
create function public.erp_fiscal_item_get(p_user_id uuid,p_draft_id uuid,p_version integer default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;v integer;begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or (p_version is not null and p_version<1) then raise exception 'erp_fiscal_item_query_invalid' using errcode='22023';end if;
 select version into v from erp_fiscal_items.head where draft_id=p_draft_id;
 select record into r from erp_fiscal_items.revision where draft_id=p_draft_id and version=coalesce(p_version,v);
 if p_version is not null and r is null then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 return erp_fiscal_items.envelope(p_draft_id,r);
end $$;
create function public.erp_fiscal_item_history(p_user_id uuid,p_draft_id uuid,p_limit integer default 25,p_before integer default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or p_limit is null or p_limit<1 or p_limit>25 or (p_before is not null and p_before<1) then raise exception 'erp_fiscal_item_query_invalid' using errcode='22023';end if;
 if not exists(select 1 from erp_fiscal_drafts.draft where id=p_draft_id) then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 select coalesce(jsonb_agg(erp_fiscal_drafts.pick(record,array['draft_id','version','draft_version','snapshot_hash','model','environment','source_document_id','source_document_version','created_at']) order by version desc),'[]') into items
 from(select * from erp_fiscal_items.revision where draft_id=p_draft_id and (p_before is null or version<p_before) order by version desc limit p_limit)t;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_items.revision where draft_id=p_draft_id and version<(items->-1->>'version')::integer);
 return erp_fiscal_items.flags()||jsonb_build_object('draft_id',p_draft_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then (items->-1->>'version')::integer else null end);
end $$;
create function public.erp_fiscal_item_preview(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_expected_version integer,p_decisions jsonb) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;c jsonb;begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 r:=erp_fiscal_items.check_binding(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_expected_version);
 c:=erp_fiscal_items.receipt(r,p_expected_version+1,erp_fiscal_items.resolve(r,p_decisions),null);
 return erp_fiscal_items.envelope(p_draft_id,c)||jsonb_build_object('persisted',false,'expected_version',p_expected_version);
end $$;
create function public.erp_fiscal_item_save(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_expected_version integer,p_decisions jsonb,p_command_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_fiscal_items.command%rowtype;parent uuid;d erp_documents.document%rowtype;r jsonb;receipt jsonb;at timestamptz;begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_command_id is null then raise exception 'erp_fiscal_item_command_invalid' using errcode='22023';end if;
 perform erp_fiscal_items.validate_decisions(p_decisions);
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'draft_id',p_draft_id,'draft_version',p_expected_draft_version,'snapshot_hash',p_snapshot_hash,'expected_version',p_expected_version,'decisions',p_decisions)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852935,hashtext(p_command_id::text));
 select * into c from erp_fiscal_items.command where command_id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_fiscal_item_command_conflict' using errcode='40001';end if;
  return erp_fiscal_items.envelope(p_draft_id,c.result)||jsonb_build_object('replayed',true);
 end if;
 -- Same parent-before-draft order as022;017/018 only take the parent and never wait for this draft/head.
 select source_document_id into parent from erp_fiscal_drafts.draft where id=p_draft_id;
 if not found then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 select * into d from erp_documents.document where id=parent for share;
 perform 1 from erp_fiscal_drafts.draft where id=p_draft_id and source_document_id=parent for update;
 if not found then raise exception 'erp_fiscal_item_not_found' using errcode='P0002';end if;
 perform 1 from erp_fiscal_items.head where draft_id=p_draft_id for update;
 r:=erp_fiscal_items.check_binding(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_expected_version);
 -- All catalogue writers lock these parent rows before modifying child product values.
 perform 1 from erp_catalog.record cr where cr.id in(
  select distinct (choice.value->>'expected_product_id')::uuid from jsonb_array_elements(p_decisions)e cross join lateral jsonb_each(e->'fields')choice where choice.value->>'source'='catalog'
 ) order by cr.id for share;
 at:=clock_timestamp();receipt:=erp_fiscal_items.receipt(r,p_expected_version+1,erp_fiscal_items.resolve(r,p_decisions),at);
 insert into erp_fiscal_items.revision(draft_id,version,draft_version,snapshot_hash,decisions,record,actor,command_id,created_at)
  values(p_draft_id,p_expected_version+1,p_expected_draft_version,p_snapshot_hash,p_decisions,receipt,p_user_id,p_command_id,at);
 insert into erp_fiscal_items.head(draft_id,version) values(p_draft_id,p_expected_version+1) on conflict(draft_id)do update set version=excluded.version;
 insert into erp_fiscal_items.command(command_id,actor,request_hash,result)values(p_command_id,p_user_id,h,receipt);
 return erp_fiscal_items.envelope(p_draft_id,receipt)||jsonb_build_object('replayed',false);
end $$;
revoke all on all functions in schema erp_fiscal_items from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_item_get(uuid,uuid,integer),public.erp_fiscal_item_history(uuid,uuid,integer,integer),
 public.erp_fiscal_item_preview(uuid,uuid,integer,text,integer,jsonb),public.erp_fiscal_item_save(uuid,uuid,integer,text,integer,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.erp_fiscal_item_get(uuid,uuid,integer),public.erp_fiscal_item_history(uuid,uuid,integer,integer),
 public.erp_fiscal_item_preview(uuid,uuid,integer,text,integer,jsonb),public.erp_fiscal_item_save(uuid,uuid,integer,text,integer,jsonb,uuid) to service_role;
commit;
