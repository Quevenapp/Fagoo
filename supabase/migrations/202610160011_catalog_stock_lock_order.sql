-- Importações canônicas: ordem de locks comum ao estoque e preservação de unidades.
-- Requer 006 (catálogo) e 009 (estoque). CREATE OR REPLACE preserva os grants.
begin;

create or replace function public.erp_catalog_import_origin(p_user_id uuid,p_entity text,p_items jsonb,
  p_command_id uuid default null,p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_role text; v_item jsonb; v_source origin_sync.raw_record%rowtype; v_origin erp_catalog.origin%rowtype;
  v_row erp_catalog.record%rowtype; v_command erp_catalog.command%rowtype; v_data jsonb; v_before jsonb;
  v_id uuid; v_source_id text; v_action text; v_status text; v_active boolean; v_error text;
  v_hash text; v_results jsonb:='[]'; v_result jsonb; v_has_origin boolean;
begin
  v_role:=erp_catalog.require_access(p_user_id,p_entity,true);
  if v_role<>'admin' then raise exception 'erp_catalog_import_denied' using errcode='42501'; end if;
  if p_entity not in ('contacts','products') or p_dry_run is null
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100
    or octet_length(p_items::text)>65536 or (not p_dry_run and p_command_id is null) then
    raise exception 'erp_catalog_invalid_import' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) a group by a->>'source_id' having count(*)>1) then
    raise exception 'erp_catalog_duplicate_import_id' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'entity',p_entity,'items',p_items,'action','import_origin')::text,'UTF8')),'hex');
  if not p_dry_run then
    perform pg_advisory_xact_lock(174852906,hashtext(p_command_id::text));
    select * into v_command from erp_catalog.command where command_id=p_command_id;
    if found then
      if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then
        raise exception 'erp_catalog_command_conflict' using errcode='40001'; end if;
      return v_command.result||'{"replayed":true}'::jsonb;
    end if;
    -- Serialize canonical imports. Human edits serialize on the local record.
    perform pg_advisory_xact_lock(174852907,hashtext(p_entity));
    -- Stock (009) locks product records by UUID. Acquire the complete existing
    -- import set in that same order before the per-source loop, even when a
    -- source will be unchanged or requires human review. The entity advisory
    -- lock above stabilizes origins against another canonical import.
    perform r.id
      from erp_catalog.record r
      join erp_catalog.origin o on o.record_id=r.id and o.entity=p_entity
      join jsonb_array_elements(p_items) item on item->>'source_id'=o.source_id
      order by r.id
      for update of r;
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item)<>'object' or jsonb_typeof(v_item->'source_id') is distinct from 'string'
      or length(v_item->>'source_id') not between 1 and 200 or v_item->>'source_id'<>btrim(v_item->>'source_id')
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('source_id','source_hash'))
      or (v_item?'source_hash' and coalesce(v_item->>'source_hash','')!~'^[0-9a-f]{64}$')
      or (not p_dry_run and not v_item?'source_hash') then
      raise exception 'erp_catalog_invalid_import_item' using errcode='22023'; end if;
    v_source_id:=v_item->>'source_id'; v_action:=null; v_error:=null; v_id:=null; v_data:=null;
    select * into v_source from origin_sync.raw_record where entity=p_entity and source_id=v_source_id;
    if not found then
      v_results:=v_results||jsonb_build_array(jsonb_build_object('source_id',v_source_id,'action','missing_source'));
      continue;
    end if;
    if v_item?'source_hash' and v_item->>'source_hash'<>v_source.version_hash then
      raise exception 'erp_catalog_source_version_conflict' using errcode='40001'; end if;
    select * into v_origin from erp_catalog.origin where entity=p_entity and source_id=v_source_id;
    v_has_origin:=found;
    if v_has_origin then
      -- Application records were prelocked above; dry runs remain read-only.
      select * into v_row from erp_catalog.record where id=v_origin.record_id;
      v_id:=v_row.id;
    end if;
    begin v_data:=erp_catalog.map_origin(p_entity,v_source.payload);
    exception when sqlstate '22023' then v_error:='source_mapping_invalid'; end;
    v_status:=v_source.payload->>'situacao';
    if v_status not in ('A','I','E','S') or v_status is null then v_error:='source_status_unknown'; end if;
    v_active:=v_status in ('A','S');
    if v_error is not null then v_action:='invalid_source';
    elsif not v_has_origin then v_action:='create';
    elsif v_origin.latest_hash=v_source.version_hash then v_action:='unchanged';
    elsif v_status='E' then v_action:='pending_source_deleted';
    elsif v_row.human_edited then v_action:='pending_human_review';
    elsif p_entity='products'
      and exists(select 1 from erp_stock.entry where product_id=v_id)
      and exists(select 1 from erp_catalog.product p where p.record_id=v_id
        and (p.unit is distinct from v_data->>'unit' or p.kind is distinct from v_data->>'kind')) then
      -- Preserve the stock ledger's meaning. Retain the entire new source as
      -- a candidate; do not partially apply unrelated fields from that source.
      v_action:='pending_human_review';
    else v_action:='update'; end if;
    if not p_dry_run and v_error is null then
      insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links)
      values(p_entity,v_source_id,v_source.version_hash,v_source.version,v_source.payload,v_source.document_links)
      on conflict(entity,source_id,source_hash) do nothing;
      if v_action='create' then
        insert into erp_catalog.record(entity,name,code,active,created_by,updated_by)
          values(p_entity,v_data->>'name',v_data->>'code',v_active,p_user_id,p_user_id) returning id into v_id;
        perform erp_catalog.write_fields(v_id,p_entity,v_data);
        insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state,candidate)
          values(p_entity,v_source_id,v_id,v_source.version_hash,v_source.version_hash,
            case when v_status='E' then 'source_deleted' else 'synced' end,null);
      elsif v_action='update' then
        if v_row.version=2147483647 then raise exception 'erp_catalog_version_exhausted' using errcode='40001'; end if;
        v_before:=erp_catalog.dto(v_id);
        update erp_catalog.record set name=v_data->>'name',code=v_data->>'code',active=v_active,version=version+1,
          updated_by=p_user_id,updated_at=clock_timestamp() where id=v_id;
        perform erp_catalog.write_fields(v_id,p_entity,v_data);
        update erp_catalog.origin set applied_hash=v_source.version_hash,latest_hash=v_source.version_hash,state='synced',candidate=null
          where entity=p_entity and source_id=v_source_id;
      elsif v_action in ('pending_human_review','pending_source_deleted') then
        v_before:=erp_catalog.dto(v_id);
        update erp_catalog.origin set latest_hash=v_source.version_hash,
          state=case when v_action='pending_source_deleted' then 'source_deleted' else 'source_changed' end,
          candidate=jsonb_build_object('data',v_data,'active',v_active,'source_hash',v_source.version_hash)
          where entity=p_entity and source_id=v_source_id;
      end if;
      if v_action<>'unchanged' then
        insert into erp_catalog.audit(actor,command_id,entity,record_id,action,before_data,after_data)
          values(p_user_id,p_command_id,p_entity,v_id,'import_'||v_action,
            case when v_action='create' then null else v_before end,erp_catalog.dto(v_id));
      end if;
    end if;
    v_results:=v_results||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('source_id',v_source_id,
      'source_hash',v_source.version_hash,'source_version',v_source.version,'record_id',v_id,'action',v_action,'error',v_error)));
  end loop;
  v_result:=jsonb_build_object('entity',p_entity,'items',v_results,'dry_run',p_dry_run,
    'replayed',false,'data_mode','erp_native','operational_effects',false);
  if not p_dry_run then insert into erp_catalog.command(command_id,actor,request_hash,result)
    values(p_command_id,p_user_id,v_hash,v_result); end if;
  return v_result;
end $$;

commit;

