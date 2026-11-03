-- Administrative review over staging -> native catalogs. Never writes to Origin,
-- stock, financial or fiscal ledgers. Requires 006,009,011.
begin;
create table erp_catalog.import_review_command (
 command_id uuid primary key, actor uuid not null references auth.users(id),
 request_hash text not null, result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table erp_catalog.import_review_command enable row level security;
revoke all on table erp_catalog.import_review_command from public,anon,authenticated,service_role;

create function erp_catalog.require_import_admin(p_user uuid,p_entity text)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_entity is null or p_entity not in ('contacts','products') then
  raise exception 'erp_import_entity_invalid' using errcode='22023'; end if;
 if erp_catalog.require_access(p_user,p_entity,true)<>'admin' then
  raise exception 'erp_import_admin_required' using errcode='42501'; end if;
end $$;

create function erp_catalog.import_changes(p_entity text,p_before jsonb,p_after jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v_field text; v_redacted boolean; v_result jsonb:='[]'; v_before jsonb; v_after jsonb;
begin
 for v_field in select value from jsonb_array_elements_text(case when p_entity='contacts' then
  '["name","code","active","trade_name","person_type","document","ie","email","phone","mobile","postal_code","street","number","complement","district","city","state","roles"]'::jsonb
  else '["name","code","active","unit","price","kind","format","description","ncm","gtin"]'::jsonb end) loop
  v_before:=coalesce(p_before->v_field,'null'::jsonb);v_after:=coalesce(p_after->v_field,'null'::jsonb);
  if v_before is distinct from v_after then
   v_redacted:=v_field in ('document','ie','email','phone','mobile','postal_code','street','number','complement','district');
   v_result:=v_result||jsonb_build_array(jsonb_build_object('field',v_field,'redacted',v_redacted,
    'before',case when v_redacted then null else v_before end,'after',case when v_redacted then null else v_after end));
  end if;
 end loop;
 return v_result;
end $$;

create function erp_catalog.import_review_plan(p_user uuid,p_entity text,p_items jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare v_dry jsonb; v_result jsonb:='[]';v_fingerprints jsonb:='[]';v_item jsonb;
 v_source origin_sync.raw_record%rowtype;v_origin erp_catalog.origin%rowtype;v_local erp_catalog.record%rowtype;
 v_data jsonb;v_before jsonb;v_id uuid;v_stock_locked boolean;v_changes jsonb;v_display_action text;
begin
 perform erp_catalog.require_import_admin(p_user,p_entity);
 v_dry:=public.erp_catalog_import_origin(p_user,p_entity,p_items,null,true);
 for v_item in select value from jsonb_array_elements(v_dry->'items') loop
  v_id:=(v_item->>'record_id')::uuid;v_data:=null;v_before:=null;v_changes:='[]';v_stock_locked:=false;
  select * into v_source from origin_sync.raw_record where entity=p_entity and source_id=v_item->>'source_id';
  select * into v_origin from erp_catalog.origin where entity=p_entity and source_id=v_item->>'source_id';
  select * into v_local from erp_catalog.record where id=v_id;
  if v_id is not null then
   v_before:=erp_catalog.data(v_id)||jsonb_build_object('active',v_local.active);
   if p_entity='products' then select exists(select 1 from erp_stock.entry where product_id=v_id) into v_stock_locked;end if;
  end if;
  if v_item->>'action' not in ('invalid_source','missing_source') then
   v_data:=erp_catalog.map_origin(p_entity,v_source.payload)||jsonb_build_object('active',v_source.payload->>'situacao' in ('A','S'));
   v_changes:=erp_catalog.import_changes(p_entity,v_before,v_data);
  end if;
  -- An already-retained candidate remains pending on repeated previews, even
  -- though the underlying import correctly reports its source as unchanged.
  v_display_action:=case when v_item->>'action'='unchanged' and v_origin.candidate is not null then
    case when v_origin.state='source_deleted' then 'pending_source_deleted' else 'pending_human_review' end
    else v_item->>'action' end;
  v_result:=v_result||jsonb_build_array(jsonb_build_object('source_id',v_item->>'source_id',
   'source_hash',v_source.version_hash,'source_version',v_source.version::text,'last_seen_at',v_source.last_seen_at,
   'name',case when jsonb_typeof(v_source.payload->'nome')='string' then left(v_source.payload->>'nome',200) else null end,
   'code',case when jsonb_typeof(v_source.payload->'codigo')='string' then left(v_source.payload->>'codigo',100) else null end,
   'source_status',case when v_source.payload->>'situacao' in ('A','I','E','S') then v_source.payload->>'situacao' else null end,
   'record_id',v_id,'record_version',v_local.version,'local_name',v_local.name,
   'human_edited',coalesce(v_local.human_edited,false),'stock_locked',v_stock_locked,
   'origin_state',v_origin.state,'candidate_retained',v_origin.candidate is not null,
   'action',v_display_action,'operation_action',v_item->>'action','error',v_item->>'error','changes',v_changes));
  v_fingerprints:=v_fingerprints||jsonb_build_array(jsonb_build_object('source_id',v_item->>'source_id',
   'source_hash',v_source.version_hash,'record_id',v_id,'record_version',v_local.version,
   'latest_hash',v_origin.latest_hash,'origin_state',v_origin.state,'stock_locked',v_stock_locked,
   'action',v_item->>'action'));
 end loop;
 return jsonb_build_object('entity',p_entity,'items',v_result,'preview_hash',
  encode(sha256(convert_to(jsonb_build_object('actor',p_user,'entity',p_entity,'items',v_fingerprints)::text,'UTF8')),'hex'),
  'dry_run',true,'data_mode','erp_native','operational_effects',false);
end $$;

create function public.erp_catalog_import_sources(p_user_id uuid,p_entity text,p_limit integer default 25,p_after text default null,p_query text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_items jsonb;v_ids text[];v_plan jsonb;v_rows jsonb;v_more boolean;
begin
 perform erp_catalog.require_import_admin(p_user_id,p_entity);
 if p_limit is null or p_limit not between 1 and 100 or length(p_after)>200 or p_after='' or p_after~'[[:cntrl:]]'
  or length(p_query)>120 or p_query~'[[:cntrl:]]' then raise exception 'erp_import_query_invalid' using errcode='22023';end if;
 select array_agg(source_id order by source_id collate "C") into v_ids from (
  select source_id from origin_sync.raw_record where entity=p_entity
   and (p_after is null or source_id collate "C">p_after collate "C")
   and (nullif(btrim(p_query),'') is null or strpos(lower(source_id),lower(btrim(p_query)))>0
    or (jsonb_typeof(payload->'nome')='string' and strpos(lower(payload->>'nome'),lower(btrim(p_query)))>0)
    or (jsonb_typeof(payload->'codigo')='string' and strpos(lower(payload->>'codigo'),lower(btrim(p_query)))>0))
  order by source_id collate "C" limit p_limit+1) q;
 v_more:=coalesce(array_length(v_ids,1),0)>p_limit;
 select coalesce(jsonb_agg(jsonb_build_object('source_id',source_id) order by source_id collate "C"),'[]') into v_items
  from unnest(v_ids[1:p_limit]) source_id;
 if jsonb_array_length(v_items)>0 then
  v_plan:=erp_catalog.import_review_plan(p_user_id,p_entity,v_items);
  select jsonb_agg(value-'changes') into v_rows from jsonb_array_elements(v_plan->'items');
 else v_rows:='[]';end if;
 return jsonb_build_object('entity',p_entity,'items',v_rows,'limit',p_limit,'has_more',v_more,
  'next_cursor',case when v_more then v_ids[p_limit] else null end,
  'data_mode','erp_native','operational_effects',false,'source','origin_staging');
end $$;

create function public.erp_catalog_import_preview(p_user_id uuid,p_entity text,p_items jsonb)
returns jsonb language sql security definer set search_path=pg_catalog as $$
 select erp_catalog.import_review_plan(p_user_id,p_entity,p_items);
$$;

create function public.erp_catalog_import_apply(p_user_id uuid,p_entity text,p_items jsonb,p_command_id uuid,p_preview_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_hash text;v_command erp_catalog.import_review_command%rowtype;v_plan jsonb;v_applied jsonb;v_result jsonb;
begin
 perform erp_catalog.require_import_admin(p_user_id,p_entity);
 if p_command_id is null or p_preview_hash is null or p_preview_hash!~'^[0-9a-f]{64}$'
  or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
  or octet_length(p_items::text)>65536 then raise exception 'erp_import_apply_invalid' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_items) a where jsonb_typeof(a)<>'object'
  or jsonb_typeof(a->'source_id') is distinct from 'string' or length(a->>'source_id') not between 1 and 200
  or a->>'source_id'<>btrim(a->>'source_id') or a->>'source_id'~'[[:cntrl:]]'
  or jsonb_typeof(a->'source_hash') is distinct from 'string' or a->>'source_hash'!~'^[0-9a-f]{64}$'
  or (select count(*) from jsonb_object_keys(a))<>2)
  or exists(select 1 from jsonb_array_elements(p_items) a group by a->>'source_id' having count(*)>1)
 then raise exception 'erp_import_items_invalid' using errcode='22023';end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'entity',p_entity,'items',p_items,'preview',p_preview_hash)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
 select * into v_command from erp_catalog.import_review_command where command_id=p_command_id;
 if found then
  if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_import_command_conflict' using errcode='40001';end if;
  return v_command.result||'{"replayed":true}'::jsonb;
 end if;
 if exists(select 1 from erp_catalog.command where command_id=p_command_id) then raise exception 'erp_import_command_conflict' using errcode='40001';end if;
 perform pg_advisory_xact_lock(174852907,hashtext(p_entity));
 -- Same local-record lock order as canonical import 011 and stock 009.
 perform r.id from erp_catalog.record r join erp_catalog.origin o on o.record_id=r.id and o.entity=p_entity
  join jsonb_array_elements(p_items) i on i->>'source_id'=o.source_id order by r.id for update of r;
 -- Hold selected source rows against sync updates until the reviewed snapshot is applied.
 perform r.source_id from origin_sync.raw_record r join jsonb_array_elements(p_items) i on i->>'source_id'=r.source_id
  where r.entity=p_entity order by r.source_id collate "C" for share of r;
 v_plan:=erp_catalog.import_review_plan(p_user_id,p_entity,p_items);
 if v_plan->>'preview_hash'<>p_preview_hash then raise exception 'erp_import_preview_conflict' using errcode='40001';end if;
 v_applied:=public.erp_catalog_import_origin(p_user_id,p_entity,p_items,p_command_id,false);
 select jsonb_agg(value||jsonb_build_object('source_version',value->>'source_version')) into v_applied
  from jsonb_array_elements(v_applied->'items');
 v_result:=jsonb_build_object('entity',p_entity,'items',v_applied,'preview_hash',p_preview_hash,
  'dry_run',false,'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_catalog.import_review_command(command_id,actor,request_hash,result)values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_catalog.require_import_admin(uuid,text),erp_catalog.import_changes(text,jsonb,jsonb),erp_catalog.import_review_plan(uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_catalog_import_sources(uuid,text,integer,text,text),public.erp_catalog_import_preview(uuid,text,jsonb),public.erp_catalog_import_apply(uuid,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.erp_catalog_import_sources(uuid,text,integer,text,text),public.erp_catalog_import_preview(uuid,text,jsonb),public.erp_catalog_import_apply(uuid,text,jsonb,uuid,text) to service_role;
commit;
