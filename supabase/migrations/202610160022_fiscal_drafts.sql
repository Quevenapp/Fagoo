-- Rascunhos locais de homologação. Não reserva série/número/chave nem habilita emissão.
begin;
create schema erp_fiscal_drafts;
revoke all on schema erp_fiscal_drafts from public,anon,authenticated,service_role;

create table erp_fiscal_drafts.draft (
 id uuid primary key default gen_random_uuid(),
 model text not null check(model in('55','65')), environment text not null default '2' check(environment='2'),
 status text not null default 'draft' check(status in('draft','archived')),
 version integer not null default 1 check(version>0),
 source_document_id uuid not null references erp_documents.document(id),
 source_document_version integer not null check(source_document_version>0),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 preparation jsonb not null check(jsonb_typeof(preparation)='object'),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 archived_at timestamptz, archive_reason text,
 check((status='draft' and archived_at is null and archive_reason is null)
    or(status='archived' and archived_at is not null and length(archive_reason) between 3 and 1000))
);
create unique index erp_fiscal_draft_one_active_order on erp_fiscal_drafts.draft(source_document_id) where status='draft';
create table erp_fiscal_drafts.revision (
 draft_id uuid not null references erp_fiscal_drafts.draft(id), version integer not null check(version>0),
 record jsonb not null check(jsonb_typeof(record)='object'), primary key(draft_id,version)
);
create table erp_fiscal_drafts.command (
 command_id uuid primary key,actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_drafts.audit (
 id bigint generated always as identity primary key,actor uuid not null references auth.users(id),
 command_id uuid not null references erp_fiscal_drafts.command(command_id) deferrable initially deferred,
 draft_id uuid not null references erp_fiscal_drafts.draft(id),version integer not null,
 action text not null check(action in('create','update','refresh','archive')),reason text,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(draft_id,version) references erp_fiscal_drafts.revision(draft_id,version)
);
do $$ declare t text; begin foreach t in array array['draft','revision','command','audit'] loop
 execute format('alter table erp_fiscal_drafts.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema erp_fiscal_drafts from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_drafts from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_drafts revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_drafts revoke all on functions from public,anon,authenticated,service_role;

create function erp_fiscal_drafts.immutable_history() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_draft_history_immutable' using errcode='42501'; end $$;
create trigger immutable_revision before update or delete on erp_fiscal_drafts.revision for each row execute function erp_fiscal_drafts.immutable_history();
create trigger immutable_command before update or delete on erp_fiscal_drafts.command for each row execute function erp_fiscal_drafts.immutable_history();
create trigger immutable_audit before update or delete on erp_fiscal_drafts.audit for each row execute function erp_fiscal_drafts.immutable_history();
create function erp_fiscal_drafts.guard_draft() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_draft_no_delete' using errcode='42501'; end if;
 if old.status='archived' or new.id<>old.id or new.model<>old.model or new.environment<>old.environment
  or new.source_document_id<>old.source_document_id or new.created_at<>old.created_at
  or old.version=2147483647 or new.version<>old.version+1 then
  raise exception 'erp_fiscal_draft_immutable_identity' using errcode='40001'; end if;
 return new;
end $$;
create trigger guard_draft before update or delete on erp_fiscal_drafts.draft for each row execute function erp_fiscal_drafts.guard_draft();

create function erp_fiscal_drafts.require_access(p_user_id uuid) returns void
language plpgsql stable set search_path=pg_catalog as $$
begin
 if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and role in('admin','fiscal')) then
  raise exception 'erp_fiscal_draft_forbidden' using errcode='42501'; end if;
end $$;
create function erp_fiscal_drafts.preparation(p_data jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_data is null or jsonb_typeof(p_data)<>'object' or exists(select 1 from jsonb_object_keys(p_data) k where k not in('operation_nature','notes')) then
  raise exception 'erp_fiscal_draft_preparation_invalid' using errcode='22023'; end if;
 return jsonb_build_object('operation_nature',erp_documents.text_value(p_data->'operation_nature',60),
  'notes',erp_documents.text_value(p_data->'notes',4000,false,true));
end $$;
create function erp_fiscal_drafts.pick(p_data jsonb,p_fields text[]) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select case when p_data is null or p_data='null'::jsonb then null else
  (select jsonb_object_agg(k,p_data->k) from unnest(p_fields) k) end
$$;

-- Called only after the order row and the company singleton advisory lock are held.
-- Catalog fields come from the order's saved historical snapshots, never today's catalog.
create function erp_fiscal_drafts.capture(p_document_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('catalog_basis','document_snapshot','document_id',d.id,'document_version',d.version,
  'kind',d.kind,'number',d.number::text,'status',d.status,'date',d.body->'date','contact_id',d.contact_id,
  'contact',erp_fiscal_drafts.pick(d.contact_snapshot,array['id','version','name','person_type','document','ie','postal_code','street','number','complement','district','city','state']),
  'items',(select coalesce(jsonb_agg(erp_fiscal_drafts.pick(i.data,array['id','position','product_id','description','code','unit','quantity','unit_price','discount_percent','gross','discount','total'])
   ||jsonb_build_object('product',erp_fiscal_drafts.pick(i.product_snapshot,array['id','version','name','code','unit','kind','format','ncm','gtin'])) order by i.position),'[]'::jsonb) from erp_documents.item i where i.document_id=d.id),
  'discount_mode',d.body->'discount_mode','discount_value',d.body->'discount_value',
  'totals',erp_fiscal_drafts.pick(d.body->'totals',array['gross','line_discount','subtotal','discount','freight','other_expenses','total']),
  'installments',d.body->'installments','notes',d.body->'notes','payment_terms',d.body->'payment_terms','delivery_terms',d.body->'delivery_terms',
  'company',(select jsonb_build_object('identity_version',c.version,'fiscal_version',f.version,
    'identity',erp_fiscal_drafts.pick(c.data,array['legal_name','trade_name','cnpj','ie','postal_code','street','number','complement','district','city','municipality_code','state']),
    'crt',f.crt,'regime_confirmed',f.crt is not null)
   from erp_company.identity c left join erp_company.fiscal f using(singleton) where c.singleton))
 from erp_documents.document d where d.id=p_document_id and d.kind='sales_orders'
$$;
create function erp_fiscal_drafts.record(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'model',model,'environment',environment,'status',status,'version',version,
  'source_document_id',source_document_id,'source_document_version',source_document_version,
  'snapshot',snapshot,'snapshot_hash',snapshot_hash,'preparation',preparation,
  'created_at',created_at,'updated_at',updated_at,'archived_at',archived_at,'archive_reason',archive_reason)
 from erp_fiscal_drafts.draft where id=p_id
$$;
create function erp_fiscal_drafts.context(p_record jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('version',r.version,'status',r.status,'source_document_version',d.version,'source_status',d.status,
  'identity_version',c.version,'fiscal_version',f.version,
  'source_changed',d.version is distinct from (p_record->>'source_document_version')::integer,
  'company_changed',c.version is distinct from (p_record#>>'{snapshot,company,identity_version}')::integer
    or f.version is distinct from (p_record#>>'{snapshot,company,fiscal_version}')::integer)
 from erp_fiscal_drafts.draft r join erp_documents.document d on d.id=r.source_document_id
 left join erp_company.identity c on c.singleton left join erp_company.fiscal f on f.singleton
 where r.id=(p_record->>'id')::uuid
$$;
create function erp_fiscal_drafts.pending(p_record jsonb,p_context jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare s jsonb:=p_record->'snapshot';codes text[]:=array['TAX_REVIEW_REQUIRED','CATALOG_SNAPSHOTS_REQUIRE_REVIEW',
 'RECIPIENT_FISCAL_MAPPING_REQUIRED','ITEM_FISCAL_MAPPING_REQUIRED','PAYMENT_FISCAL_MAPPING_REQUIRED',
 'FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED','TRANSPORT_UNAVAILABLE','HOMOLOGATION_NOT_PERFORMED'];
begin
 if s->'company'='null'::jsonb then codes:=array_append(codes,'COMPANY_IDENTITY_MISSING');
 else
  if s#>>'{company,identity,state}'<>'SP' then codes:=array_append(codes,'COMPANY_STATE_OUTSIDE_PROFILE'); end if;
  if nullif(s#>>'{company,identity,ie}','') is null then codes:=array_append(codes,'COMPANY_IE_MISSING'); end if;
 end if;
 if s#>>'{company,crt}' is null then codes:=array_append(codes,'REGIME_UNCONFIRMED'); end if;
 if nullif(p_record#>>'{preparation,operation_nature}','') is null then codes:=array_append(codes,'OPERATION_NATURE_MISSING'); end if;
 if nullif(s#>>'{contact,document}','') is null then codes:=array_append(codes,'RECIPIENT_DOCUMENT_MISSING'); end if;
 if exists(select 1 from unnest(array['postal_code','street','number','district','city','state']) k where nullif(s#>>array['contact',k],'') is null) then
  codes:=array_append(codes,'RECIPIENT_ADDRESS_INCOMPLETE'); end if;
 if exists(select 1 from jsonb_array_elements(s->'items') i where i->'product_id'='null'::jsonb) then codes:=array_append(codes,'ITEM_WITHOUT_CATALOG_LINK'); end if;
 if exists(select 1 from jsonb_array_elements(s->'items') i where i#>>'{product,kind}' is distinct from 'P') then codes:=array_append(codes,'ITEM_KIND_REQUIRES_REVIEW'); end if;
 if exists(select 1 from jsonb_array_elements(s->'items') i where nullif(i#>>'{product,ncm}','') is null) then codes:=array_append(codes,'ITEM_NCM_MISSING'); end if;
 if jsonb_array_length(s->'installments')=0 then codes:=array_append(codes,'PAYMENT_PLAN_MISSING'); end if;
 if (p_context->>'source_changed')::boolean then codes:=array_append(codes,'SOURCE_DOCUMENT_CHANGED'); end if;
 if (p_context->>'company_changed')::boolean then codes:=array_append(codes,'COMPANY_CONFIGURATION_CHANGED'); end if;
 if p_context->>'source_status'='cancelled' then codes:=array_append(codes,'SOURCE_DOCUMENT_CANCELLED'); end if;
 if p_context->>'status'='archived' then codes:=array_append(codes,'DRAFT_ARCHIVED'); end if;
 return to_jsonb(codes);
end $$;
create function erp_fiscal_drafts.envelope(p_record jsonb) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_draft','emission_enabled',false,'operational_effects',false,
  'record',p_record,'current',c,'pending',erp_fiscal_drafts.pending(p_record,c))
 from(select erp_fiscal_drafts.context(p_record)c)t
$$;
create function erp_fiscal_drafts.summary(p_record jsonb) returns jsonb
language sql immutable set search_path=pg_catalog as $$
 select erp_fiscal_drafts.pick(p_record,array['id','model','environment','status','version','source_document_id','source_document_version','created_at','updated_at'])
 ||jsonb_build_object('order_number',p_record#>>'{snapshot,number}','contact_name',p_record#>>'{snapshot,contact,name}',
  'total',p_record#>>'{snapshot,totals,total}')
$$;

create function public.erp_fiscal_draft_get(p_user_id uuid,p_id uuid,p_revision integer default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_id is null or (p_revision is not null and p_revision<1) then raise exception 'erp_fiscal_draft_query_invalid' using errcode='22023'; end if;
 if p_revision is null then r:=erp_fiscal_drafts.record(p_id);
 else select record into r from erp_fiscal_drafts.revision where draft_id=p_id and version=p_revision; end if;
 if r is null then raise exception 'erp_fiscal_draft_not_found' using errcode='P0002'; end if;
 return erp_fiscal_drafts.envelope(r);
end $$;
create function public.erp_fiscal_draft_list(p_user_id uuid,p_model text default null,p_status text default null,p_source_document_id uuid default null,p_limit integer default 25,p_after uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;n integer;next_id uuid;
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if (p_model is not null and p_model not in('55','65')) or (p_status is not null and p_status not in('draft','archived')) or p_limit is null or p_limit not between 1 and 25 then
  raise exception 'erp_fiscal_draft_query_invalid' using errcode='22023'; end if;
 select coalesce(jsonb_agg(erp_fiscal_drafts.summary(erp_fiscal_drafts.record(id)) order by id),'[]'::jsonb),count(*) into rows,n
 from(select id from erp_fiscal_drafts.draft where(p_model is null or model=p_model) and(p_status is null or status=p_status)
  and(p_source_document_id is null or source_document_id=p_source_document_id) and(p_after is null or id>p_after) order by id limit p_limit+1)t;
 if n>p_limit then rows:=rows-(n-1);next_id:=(rows->(p_limit-1)->>'id')::uuid; end if;
 return jsonb_build_object('data_mode','fiscal_draft','emission_enabled',false,'operational_effects',false,'items',rows,'limit',p_limit,'has_more',n>p_limit,'next_cursor',next_id);
end $$;
create function public.erp_fiscal_draft_revisions(p_user_id uuid,p_id uuid,p_limit integer default 25,p_after integer default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;n integer;next_version integer;
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_id is null or p_limit is null or p_limit not between 1 and 25 or(p_after is not null and p_after<1) then raise exception 'erp_fiscal_draft_query_invalid' using errcode='22023'; end if;
 if not exists(select 1 from erp_fiscal_drafts.draft where id=p_id) then raise exception 'erp_fiscal_draft_not_found' using errcode='P0002'; end if;
 select coalesce(jsonb_agg(erp_fiscal_drafts.summary(record) order by version),'[]'::jsonb),count(*) into rows,n
 from(select record,version from erp_fiscal_drafts.revision where draft_id=p_id and(p_after is null or version>p_after) order by version limit p_limit+1)t;
 if n>p_limit then rows:=rows-(n-1);next_version:=(rows->(p_limit-1)->>'version')::integer; end if;
 return jsonb_build_object('data_mode','fiscal_draft','emission_enabled',false,'operational_effects',false,'draft_id',p_id,'items',rows,'limit',p_limit,'has_more',n>p_limit,'next_cursor',next_version);
end $$;

create function public.erp_fiscal_draft_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_fiscal_drafts.command%rowtype;d erp_documents.document%rowtype;r erp_fiscal_drafts.draft%rowtype;
 v_id uuid;v_source_id uuid;expected integer;expected_source integer;prep jsonb;snap jsonb;reason text;result jsonb;rec jsonb;keys text[];
begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_command_id is null or p_action is null or p_action not in('create','update','refresh','archive') or p_data is null
  or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>16384 then raise exception 'erp_fiscal_draft_command_invalid' using errcode='22023'; end if;
 keys:=case p_action when 'create' then array['source_document_id','expected_source_version','model','preparation']
  when 'update' then array['id','expected_version','preparation'] when 'refresh' then array['id','expected_version','expected_source_version']
  else array['id','expected_version','reason'] end;
 if exists(select 1 from jsonb_object_keys(p_data)k where not k=any(keys)) then raise exception 'erp_fiscal_draft_unknown_field' using errcode='22023'; end if;
 if p_action in('create','refresh') then
  if jsonb_typeof(p_data->'expected_source_version') is distinct from 'number' or p_data->>'expected_source_version'!~'^[1-9][0-9]{0,9}$'
   or (p_data->>'expected_source_version')::numeric>2147483647 then raise exception 'erp_fiscal_draft_version_invalid' using errcode='22023'; end if;
  expected_source:=(p_data->>'expected_source_version')::integer;
 end if;
 if p_action='create' then
  v_source_id:=erp_documents.uuid_value(p_data->'source_document_id',true);
  if jsonb_typeof(p_data->'model') is distinct from 'string' or p_data->>'model' not in('55','65') then raise exception 'erp_fiscal_draft_model_invalid' using errcode='22023'; end if;
 else
  v_id:=erp_documents.uuid_value(p_data->'id',true);
  if jsonb_typeof(p_data->'expected_version') is distinct from 'number' or p_data->>'expected_version'!~'^[1-9][0-9]{0,9}$'
   or (p_data->>'expected_version')::numeric>2147483647 then raise exception 'erp_fiscal_draft_version_invalid' using errcode='22023'; end if;
  expected:=(p_data->>'expected_version')::integer;
 end if;
 if p_action in('create','update') then prep:=erp_fiscal_drafts.preparation(p_data->'preparation'); end if;
 if p_action='archive' then
  reason:=erp_documents.text_value(p_data->'reason',1000,true);
  if length(reason)<3 then raise exception 'erp_fiscal_draft_reason_required' using errcode='22023'; end if;
 end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852932,hashtext(p_command_id::text));
 select * into c from erp_fiscal_drafts.command where command_id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_fiscal_draft_command_conflict' using errcode='40001'; end if;
  return erp_fiscal_drafts.envelope(c.result->'record')||jsonb_build_object('action',p_action,'replayed',true);
 end if;
 -- Discover the parent without locking; immutable identity is rechecked after taking the parent lock.
 if p_action<>'create' then
  select source_document_id into v_source_id from erp_fiscal_drafts.draft where draft.id=v_id;
  if not found then raise exception 'erp_fiscal_draft_not_found' using errcode='P0002'; end if;
 end if;
 select * into d from erp_documents.document where document.id=v_source_id for update;
 if not found or d.kind<>'sales_orders' then raise exception 'erp_fiscal_draft_source_not_found' using errcode='P0002'; end if;
 if p_action<>'create' then
  select * into r from erp_fiscal_drafts.draft where draft.id=v_id and source_document_id=v_source_id for update;
  if not found then raise exception 'erp_fiscal_draft_not_found' using errcode='P0002'; end if;
  if r.version<>expected or r.version=2147483647 or r.status<>'draft' then raise exception 'erp_fiscal_draft_version_conflict' using errcode='40001'; end if;
 end if;
 if p_action in('create','refresh') then
  if d.version<>expected_source or d.status='cancelled' then raise exception 'erp_fiscal_draft_source_conflict' using errcode='40001'; end if;
  if p_action='create' and exists(select 1 from erp_fiscal_drafts.draft where source_document_id=v_source_id and status='draft') then
   raise exception 'erp_fiscal_draft_already_active' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(174852920,1);
  snap:=erp_fiscal_drafts.capture(v_source_id);
 end if;
 if p_action='create' then
  insert into erp_fiscal_drafts.draft(model,source_document_id,source_document_version,snapshot,snapshot_hash,preparation)
   values(p_data->>'model',v_source_id,d.version,snap,encode(sha256(convert_to(snap::text,'UTF8')),'hex'),prep) returning draft.id into v_id;
 elsif p_action='update' then
  update erp_fiscal_drafts.draft set preparation=prep,version=version+1,updated_at=clock_timestamp() where draft.id=v_id;
 elsif p_action='refresh' then
  update erp_fiscal_drafts.draft set source_document_version=d.version,snapshot=snap,snapshot_hash=encode(sha256(convert_to(snap::text,'UTF8')),'hex'),
   version=version+1,updated_at=clock_timestamp() where draft.id=v_id;
 else
  update erp_fiscal_drafts.draft set status='archived',archive_reason=reason,archived_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where draft.id=v_id;
 end if;
 rec:=erp_fiscal_drafts.record(v_id);
 insert into erp_fiscal_drafts.revision(draft_id,version,record) values(v_id,(rec->>'version')::integer,rec);
 result:=erp_fiscal_drafts.envelope(rec)||jsonb_build_object('action',p_action,'replayed',false);
 insert into erp_fiscal_drafts.command(command_id,actor,request_hash,result) values(p_command_id,p_user_id,h,result);
 insert into erp_fiscal_drafts.audit(actor,command_id,draft_id,version,action,reason) values(p_user_id,p_command_id,v_id,(rec->>'version')::integer,p_action,reason);
 return result;
end $$;

revoke all on all functions in schema erp_fiscal_drafts from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_draft_get(uuid,uuid,integer),public.erp_fiscal_draft_list(uuid,text,text,uuid,integer,uuid),
 public.erp_fiscal_draft_revisions(uuid,uuid,integer,integer),public.erp_fiscal_draft_execute(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.erp_fiscal_draft_get(uuid,uuid,integer),public.erp_fiscal_draft_list(uuid,text,text,uuid,integer,uuid),
 public.erp_fiscal_draft_revisions(uuid,uuid,integer,integer),public.erp_fiscal_draft_execute(uuid,uuid,text,jsonb) to service_role;
commit;
