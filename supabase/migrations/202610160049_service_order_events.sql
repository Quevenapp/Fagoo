-- Declarações operacionais da OS, sem assinatura, transição ou lançamento automático.
begin;
create table erp_documents.service_event (
 id uuid primary key default gen_random_uuid(),
 document_id uuid not null references erp_documents.document(id),
 sequence bigint not null check(sequence between 1 and 9999999999),
 event_type text not null check(event_type in ('reception','customer_decision','delivery')),
 document_version integer not null check(document_version>0),
 document_status text not null,
 commercial_hash text not null check(commercial_hash ~ '^[a-f0-9]{64}$'),
 total numeric(18,2) not null check(total between 0 and 999999999999.99),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 occurred_on date not null,
 declarant_name text not null,
 declarant_role text not null check(declarant_role in ('customer','representative','other')),
 details jsonb not null check(jsonb_typeof(details)='object'),
 notes text,
 attachment_id uuid references erp_attachments.attachment(id),
 attachment_snapshot jsonb,
 corrects_event_id uuid unique references erp_documents.service_event(id),
 correction_reason text,
 actor_id uuid not null references auth.users(id),
 recorded_at timestamptz not null default clock_timestamp(),
 unique(document_id,sequence),
 check((corrects_event_id is null)=(correction_reason is null)),
 check((attachment_id is null)=(attachment_snapshot is null))
);
create table erp_documents.service_event_command (
 command_id uuid primary key,
 actor_id uuid not null references auth.users(id),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 event_id uuid not null unique references erp_documents.service_event(id),
 created_at timestamptz not null default clock_timestamp()
);
alter table erp_documents.service_event enable row level security;
alter table erp_documents.service_event_command enable row level security;
revoke all on erp_documents.service_event,erp_documents.service_event_command from public,anon,authenticated,service_role;

create function erp_documents.service_event_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_service_event_immutable' using errcode='55000';end $$;
create trigger service_event_immutable before update or delete on erp_documents.service_event for each row execute function erp_documents.service_event_immutable();
create trigger service_event_command_immutable before update or delete on erp_documents.service_event_command for each row execute function erp_documents.service_event_immutable();

create function erp_documents.service_event_exact(v jsonb,keys text[]) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(jsonb_typeof(v)='object' and v ?& keys and (v-keys)='{}'::jsonb,false);
$$;
create function erp_documents.service_event_text(v jsonb,maximum integer,required boolean default false,multiline boolean default false)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare result text;spaces text:=E' \t\r\n'||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8203)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
begin
 if v is null or v='null'::jsonb then result:=null;
 elsif jsonb_typeof(v)<>'string' then raise exception 'erp_service_event_text_invalid' using errcode='22023';
 else result:=nullif(btrim(v#>>'{}',spaces),'');end if;
 if (required and result is null) or length(result)>maximum or result ~ '[<>]'
  or (case when multiline then translate(result,E'\n\r\t','') else result end) ~ '[[:cntrl:]]' then
  raise exception 'erp_service_event_text_invalid' using errcode='22023';end if;
 return result;
end $$;
create function erp_documents.service_event_types(status text) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select case when status='cancelled' then '[]'::jsonb else
  '["reception"]'::jsonb
  ||case when status in ('quoted','approved','rejected') then '["customer_decision"]'::jsonb else '[]'::jsonb end
  ||case when status in ('service_done','finalized','no_repair') then '["delivery"]'::jsonb else '[]'::jsonb end end;
$$;
-- Only persisted document data participates. Catalog changes do not rewrite the captured OS.
-- Status/version and internal notes are intentionally excluded from the commercial comparison.
create function erp_documents.service_event_commercial_hash(d erp_documents.document) returns text language sql stable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('body',d.body-'internal_notes','contact',d.contact_snapshot,
  'items',(select coalesce(jsonb_agg(i.data order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=d.id))::text,'UTF8')),'hex');
$$;
create function erp_documents.service_event_record(e erp_documents.service_event) returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('id',e.id,'document_id',e.document_id,'sequence',e.sequence::text,'type',e.event_type,
  'document_version',e.document_version,'document_status',e.document_status,'commercial_hash',e.commercial_hash,'total',e.total::text,
  'snapshot',e.snapshot,'occurred_on',e.occurred_on,'declarant_name',e.declarant_name,'declarant_role',e.declarant_role,
  'details',e.details,'notes',e.notes,'attachment',e.attachment_snapshot,'corrects_event_id',e.corrects_event_id,
  'correction_reason',e.correction_reason,'actor_id',e.actor_id,'recorded_at',e.recorded_at);
$$;
create function erp_documents.service_event_context(p_actor uuid,p_document_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d erp_documents.document;r text;write_allowed boolean;begin
 perform erp_documents.require_access(p_actor,'service_orders',false);
 select * into d from erp_documents.document where id=p_document_id and kind='service_orders';
 if not found then raise exception 'erp_service_event_not_found' using errcode='P0002';end if;
 select role into r from erp_access.membership where user_id=p_actor and active;
 write_allowed:=erp_documents.allowed(r,'service_orders',true) and d.status<>'cancelled' and not coalesce((d.body->>'template')::boolean,false);
 return jsonb_build_object('scope','service_order_events','data_mode','erp_native','signature_verified',false,'consent_verified',false,
  'changes_document_status',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'document',jsonb_build_object('id',d.id,'kind',d.kind,'number',d.number::text,'version',d.version,'status',d.status,
   'total',d.total::text,'commercial_hash',erp_documents.service_event_commercial_hash(d)),
  'can_record',write_allowed,'allowed_event_types',case when write_allowed then erp_documents.service_event_types(d.status) else '[]'::jsonb end);
end $$;
create function erp_documents.service_event_view(e erp_documents.service_event,context jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('record',erp_documents.service_event_record(e),'current',jsonb_build_object(
  'document_version',(context#>>'{document,version}')::integer,'document_status',context#>>'{document,status}',
  'document_version_changed',e.document_version<>(context#>>'{document,version}')::integer,
  'commercial_content_changed',e.commercial_hash<>context#>>'{document,commercial_hash}',
  'total_changed',e.total<>(context#>>'{document,total}')::numeric,
  'corrected_by_event_id',(select id from erp_documents.service_event where corrects_event_id=e.id),
  'approval_basis_matches_current',e.event_type='customer_decision' and e.details->>'decision'='approved'
   and e.document_version=(context#>>'{document,version}')::integer and e.commercial_hash=context#>>'{document,commercial_hash}'
   and e.total=(context#>>'{document,total}')::numeric and context#>>'{document,status}'<>'cancelled'
   and not exists(select 1 from erp_documents.service_event where corrects_event_id=e.id)
   and not exists(select 1 from erp_documents.service_event where document_id=e.document_id and event_type='customer_decision' and sequence>e.sequence)));
$$;
create function public.erp_service_event_list(p_user_id uuid,p_document_id uuid,p_limit integer default 25,p_before text default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare context jsonb;result jsonb;begin
 context:=erp_documents.service_event_context(p_user_id,p_document_id);
 if p_limit is null or p_limit not between 1 and 25 or (p_before is not null and p_before!~'^[1-9][0-9]{0,9}$') then
  raise exception 'erp_service_event_query_invalid' using errcode='22023';end if;
 with rows as materialized(select e.sequence,erp_documents.service_event_view(e,context) item from erp_documents.service_event e
  where e.document_id=p_document_id and (p_before is null or e.sequence<p_before::bigint) order by sequence desc limit p_limit+1),
 page as(select * from rows order by sequence desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(item order by sequence desc) from page),'[]'::jsonb),'limit',p_limit,
  'has_more',(select count(*) from rows)>p_limit,'next_before',case when (select count(*) from rows)>p_limit then (select min(sequence)::text from page)end) into result;
 return context||result||jsonb_build_object('read_only',true);
end $$;
create function public.erp_service_event_get(p_user_id uuid,p_document_id uuid,p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare context jsonb;e erp_documents.service_event;begin
 context:=erp_documents.service_event_context(p_user_id,p_document_id);
 select * into e from erp_documents.service_event where document_id=p_document_id and id=p_event_id;
 if not found then raise exception 'erp_service_event_not_found' using errcode='P0002';end if;
 return context||erp_documents.service_event_view(e,context)||jsonb_build_object('read_only',true);
end $$;
create function public.erp_service_event_append(p_user_id uuid,p_document_id uuid,p_expected_document_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d erp_documents.document;c erp_documents.service_event_command;e erp_documents.service_event;previous erp_documents.service_event;
 a erp_attachments.attachment;context jsonb;h text;kind text;declared date;person text;relationship text;details jsonb;notes text;
 v_attachment uuid;correction uuid;reason text;seq bigint;snapshot jsonb;attachment_snapshot jsonb;begin
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 if p_command_id is null or p_document_id is null or p_expected_document_version is null or p_expected_document_version<1
  or p_data is null or octet_length(p_data::text)>65536
  or not erp_documents.service_event_exact(p_data,array['type','occurred_on','declarant_name','declarant_role','details','notes','attachment_id','corrects_event_id','correction_reason','confirm_record'])
  or p_data->'confirm_record' is distinct from 'true'::jsonb then raise exception 'erp_service_event_input_invalid' using errcode='22023';end if;
 kind:=erp_documents.service_event_text(p_data->'type',32,true);
 if kind not in ('reception','customer_decision','delivery') then raise exception 'erp_service_event_type_invalid' using errcode='22023';end if;
 declared:=erp_documents.date_value(p_data->'occurred_on',true);
 if declared>(clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_service_event_date_future' using errcode='22023';end if;
 person:=erp_documents.service_event_text(p_data->'declarant_name',200,true);
 relationship:=erp_documents.service_event_text(p_data->'declarant_role',24,true);
 if relationship not in ('customer','representative','other') then raise exception 'erp_service_event_role_invalid' using errcode='22023';end if;
 notes:=erp_documents.service_event_text(p_data->'notes',2000,false,true);
 v_attachment:=erp_documents.uuid_value(p_data->'attachment_id');correction:=erp_documents.uuid_value(p_data->'corrects_event_id');
 reason:=erp_documents.service_event_text(p_data->'correction_reason',1000,correction is not null,true);
 if (correction is null and reason is not null) or (correction is not null and length(reason)<3) then raise exception 'erp_service_event_correction_invalid' using errcode='22023';end if;
 details:=p_data->'details';
 if kind='reception' then
  if not erp_documents.service_event_exact(details,array['accessories','apparent_condition']) then raise exception 'erp_service_event_details_invalid' using errcode='22023';end if;
  details:=jsonb_build_object('accessories',erp_documents.service_event_text(details->'accessories',1000,false,true),
   'apparent_condition',erp_documents.service_event_text(details->'apparent_condition',1000,true,true));
 elsif kind='customer_decision' then
  if not erp_documents.service_event_exact(details,array['decision','channel']) or jsonb_typeof(details->'decision') is distinct from 'string'
   or details->>'decision' not in ('approved','rejected') or jsonb_typeof(details->'channel') is distinct from 'string'
   or details->>'channel' not in ('in_person','phone','email','message','document','other') then raise exception 'erp_service_event_details_invalid' using errcode='22023';end if;
 else
  if not erp_documents.service_event_exact(details,array['delivered_condition','tests_summary']) then raise exception 'erp_service_event_details_invalid' using errcode='22023';end if;
  details:=jsonb_build_object('delivered_condition',erp_documents.service_event_text(details->'delivered_condition',1000,true,true),
   'tests_summary',erp_documents.service_event_text(details->'tests_summary',1000,false,true));
 end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'document',p_document_id,'version',p_expected_document_version,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852949,hashtext(p_command_id::text));
 select * into c from erp_documents.service_event_command where command_id=p_command_id;
 if found and (c.actor_id<>p_user_id or c.request_hash<>h) then raise exception 'erp_service_event_command_conflict' using errcode='40001';end if;
 -- Same document lock as commercial saves/bridges; no reverse lock from attachments to the document.
 select * into d from erp_documents.document where id=p_document_id and document.kind='service_orders' for update;
 if not found then raise exception 'erp_service_event_not_found' using errcode='P0002';end if;
 perform erp_documents.require_access(p_user_id,'service_orders',true);
 context:=erp_documents.service_event_context(p_user_id,p_document_id);
 if c.command_id is not null then
  select * into e from erp_documents.service_event where id=c.event_id;
  return context||erp_documents.service_event_view(e,context)||jsonb_build_object('replayed',true);
 end if;
 if d.version<>p_expected_document_version then raise exception 'erp_service_event_document_changed' using errcode='40001';end if;
 if not (context->>'can_record')::boolean or not (erp_documents.service_event_types(d.status)?kind) then raise exception 'erp_service_event_state_invalid' using errcode='40001';end if;
 if correction is not null then
  select * into previous from erp_documents.service_event where id=correction and document_id=d.id and event_type=kind;
  if not found or exists(select 1 from erp_documents.service_event where corrects_event_id=correction) then raise exception 'erp_service_event_correction_conflict' using errcode='40001';end if;
 end if;
 if v_attachment is not null then
  select * into a from erp_attachments.attachment where id=v_attachment and document_id=d.id and status='ready' for share;
  if not found then raise exception 'erp_service_event_attachment_unavailable' using errcode='40001';end if;
  attachment_snapshot:=jsonb_build_object('id',a.id,'filename',a.filename,'mime_type',a.mime_type,'size_bytes',a.size_bytes,'sha256',a.sha256);
 end if;
 select coalesce(max(sequence),0)+1 into seq from erp_documents.service_event where document_id=d.id;
 if seq>9999999999 then raise exception 'erp_service_event_limit' using errcode='54000';end if;
 snapshot:=jsonb_build_object('number',d.number::text,'contact',jsonb_build_object('id',d.contact_id,'name',d.contact_snapshot->>'name'),
  'equipment',d.body->'equipment','serial_number',d.body->'serial_number','technician',d.body->'technician');
 insert into erp_documents.service_event(document_id,sequence,event_type,document_version,document_status,commercial_hash,total,snapshot,
  occurred_on,declarant_name,declarant_role,details,notes,attachment_id,attachment_snapshot,corrects_event_id,correction_reason,actor_id)
 values(d.id,seq,kind,d.version,d.status,context#>>'{document,commercial_hash}',d.total,snapshot,
  declared,person,relationship,details,notes,v_attachment,attachment_snapshot,correction,reason,p_user_id) returning * into e;
 insert into erp_documents.service_event_command(command_id,actor_id,request_hash,event_id) values(p_command_id,p_user_id,h,e.id);
 return context||erp_documents.service_event_view(e,context)||jsonb_build_object('replayed',false);
end $$;
revoke all on function erp_documents.service_event_immutable(),erp_documents.service_event_exact(jsonb,text[]),
 erp_documents.service_event_text(jsonb,integer,boolean,boolean),erp_documents.service_event_types(text),
 erp_documents.service_event_commercial_hash(erp_documents.document),erp_documents.service_event_record(erp_documents.service_event),
 erp_documents.service_event_context(uuid,uuid),erp_documents.service_event_view(erp_documents.service_event,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.erp_service_event_list(uuid,uuid,integer,text),public.erp_service_event_get(uuid,uuid,uuid),
 public.erp_service_event_append(uuid,uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.erp_service_event_list(uuid,uuid,integer,text),public.erp_service_event_get(uuid,uuid,uuid),
 public.erp_service_event_append(uuid,uuid,integer,uuid,jsonb) to service_role;
commit;
