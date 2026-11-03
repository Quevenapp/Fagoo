-- Explicit creation based on an existing native document, without operational effects.
begin;
create table erp_documents.copy_source (
 destination_id uuid primary key references erp_documents.document(id),
 source_id uuid not null references erp_documents.document(id),
 source_kind text not null references erp_documents.numbering(kind),
 source_number bigint not null check(source_number between 1 and 9999999999),
 source_version integer not null check(source_version>0),
 actor uuid not null references auth.users(id),command_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),
 check(destination_id<>source_id)
);
alter table erp_documents.copy_source enable row level security;
revoke all on erp_documents.copy_source from public,anon,authenticated,service_role;
create function erp_documents.guard_copy_source()
returns trigger language plpgsql set search_path=pg_catalog as $$ begin
 raise exception 'erp_document_copy_source_immutable' using errcode='55000';
end $$;
create trigger immutable_document_copy_source before update or delete on erp_documents.copy_source
 for each row execute function erp_documents.guard_copy_source();

create function erp_documents.copy_source_dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',source_id,'kind',source_kind,'number',source_number::text,'version',source_version)
 from erp_documents.copy_source where destination_id=p_id;
$$;

create function public.erp_document_copy_preview(p_user_id uuid,p_kind text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_data jsonb; v_items jsonb; field text;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',null,'product_id',i.product_id,'description',i.data->'description',
  'code',i.data->'code','unit',i.data->'unit','quantity',i.quantity::text,'unit_price',i.unit_price::text,
  'discount_percent',i.discount_percent::text) order by i.position),'[]'::jsonb) into v_items
  from erp_documents.item i where i.document_id=p_source_id;
 v_data:=jsonb_build_object('date',(clock_timestamp() at time zone 'America/Sao_Paulo')::date,
  'contact_id',v_source.contact_id,'warehouse_id',v_source.warehouse_id,'expected_date',null,'valid_until',null,
  'next_contact',null,'template',false,'items',v_items,'installments','[]'::jsonb,
  'equipment',null,'serial_number',null,'technician',null,'defect',null,'solution',null);
 foreach field in array array['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'] loop
  v_data:=v_data||jsonb_build_object(field,v_source.body->field);
 end loop;
 return jsonb_build_object('source',jsonb_build_object('id',v_source.id,'kind',v_source.kind,'number',v_source.number::text,'version',v_source.version),
  'data',v_data,'reset_fields',jsonb_build_array('date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution'),
  'persisted',false,'data_mode','erp_native','operational_effects',false);
end $$;

create function public.erp_document_copy_origin(p_user_id uuid,p_kind text,p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 if not exists(select 1 from erp_documents.document where id=p_document_id and kind=p_kind) then
  raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 -- Same-kind provenance contains no customer, amounts, notes, or source snapshots.
 return jsonb_build_object('document_id',p_document_id,'kind',p_kind,
  'copy_source',erp_documents.copy_source_dto(p_document_id),'data_mode','erp_native','operational_effects',false);
end $$;

create function public.erp_document_copy(p_user_id uuid,p_kind text,p_source_id uuid,p_expected_source_version integer,p_command_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_source erp_documents.document%rowtype; v_hash text; v_replay jsonb; v_data jsonb; v_items jsonb;
 v_contact uuid; v_warehouse uuid; v_refs uuid[]; v_snapshot jsonb; v_id uuid; v_result jsonb;
begin
 perform erp_documents.require_access(p_user_id,p_kind,false);
 perform erp_documents.require_access(p_user_id,p_kind,true);
 if p_source_id is null or p_expected_source_version is null or p_expected_source_version<1 then
  raise exception 'erp_document_version_invalid' using errcode='22023'; end if;
 if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>262144 then
  raise exception 'erp_document_body_invalid' using errcode='22023'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_object('op','copy_document','actor',p_user_id,'kind',p_kind,'source',p_source_id,
  'source_version',p_expected_source_version,'body',p_body)::text,'UTF8')),'hex');
 v_replay:=erp_documents.command_replay(p_user_id,p_command_id,v_hash);
 if v_replay is not null then return v_replay; end if;
 -- No source write; SHARE preserves the reviewed source revision through commit.
 select * into v_source from erp_documents.document where id=p_source_id and kind=p_kind for share;
 if not found then raise exception 'erp_document_not_found' using errcode='P0002'; end if;
 if v_source.version<>p_expected_source_version then raise exception 'erp_document_version_conflict' using errcode='40001'; end if;
 v_data:=erp_documents.normalize(p_kind,p_body);
 v_contact:=(v_data->>'contact_id')::uuid;v_warehouse:=(v_data->>'warehouse_id')::uuid;
 select array_agg(distinct id) into v_refs from (
  select v_contact id union all select v_warehouse union all
  select (value->>'product_id')::uuid from jsonb_array_elements(v_data->'items')) refs where id is not null;
 -- Every current catalog snapshot is taken under the same deterministic record lock order.
 perform r.id from erp_catalog.record r where r.id=any(v_refs) order by r.id for share;
 select erp_catalog.dto(r.id) into v_snapshot from erp_catalog.record r join erp_catalog.contact c on c.record_id=r.id
  where r.id=v_contact and r.active;
 if not found then raise exception 'erp_document_contact_unavailable' using errcode='22023'; end if;
 if v_warehouse is not null and not exists(select 1 from erp_catalog.record r join erp_catalog.warehouse w on w.record_id=r.id where r.id=v_warehouse and r.active) then
  raise exception 'erp_document_warehouse_unavailable' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(v_data->'items') i where i->>'product_id' is not null and not exists(
  select 1 from erp_catalog.record r join erp_catalog.product p on p.record_id=r.id where r.id=(i->>'product_id')::uuid and r.active)) then
  raise exception 'erp_document_product_unavailable' using errcode='22023'; end if;
 -- The submitted commercial values/dates are normalized, never reset after confirmation.
 insert into erp_documents.document(kind,number,status,contact_id,warehouse_id,contact_snapshot,body,total,created_by,updated_by)
 values(p_kind,erp_documents.next_number(p_kind),case when p_kind in('sales_proposals','sales_orders') then 'draft' else 'open' end,
  v_contact,v_warehouse,v_snapshot,v_data-'items',(v_data#>>'{totals,total}')::numeric,p_user_id,p_user_id) returning id into v_id;
 -- Client line identities are local form keys, never reused across documents.
 select coalesce(jsonb_agg(value||'{"id":null}'::jsonb order by position),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_data->'items') with ordinality as lines(value,position);
 perform erp_documents.replace_items(v_id,v_items);
 insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id)
  values(v_id,p_source_id,p_kind,v_source.number,p_expected_source_version,p_user_id,p_command_id);
 v_result:=jsonb_build_object('kind',p_kind,'document',erp_documents.dto(v_id),'copy_source',erp_documents.copy_source_dto(v_id),
  'replayed',false,'data_mode','erp_native','operational_effects',false);
 insert into erp_documents.audit(actor,command_id,document_id,action,before_data,after_data)
  values(p_user_id,p_command_id,v_id,'create_from_copy',jsonb_build_object('copy_source',erp_documents.copy_source_dto(v_id)),erp_documents.dto(v_id));
 insert into erp_documents.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
 return v_result;
end $$;

revoke all on function erp_documents.guard_copy_source() from public,anon,authenticated,service_role;
revoke all on function erp_documents.copy_source_dto(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_document_copy_preview(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_document_copy_origin(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_document_copy_preview(uuid,text,uuid) to service_role;
grant execute on function public.erp_document_copy_origin(uuid,text,uuid) to service_role;
grant execute on function public.erp_document_copy(uuid,text,uuid,integer,uuid,jsonb) to service_role;
commit;
