-- Internal, explicit homologation numbering. No production, key, XML or transmission.
begin;
create schema erp_fiscal_numbering;
revoke all on schema erp_fiscal_numbering from public,anon,authenticated,service_role;

create table erp_fiscal_numbering.series(
 id uuid primary key default gen_random_uuid(),issuer_cnpj text not null,cuf text not null check(cuf='35'),
 model text not null check(model in('55','65')),environment text not null check(environment='2'),
 series integer not null check(series between 0 and 889),first_number integer not null check(first_number between 1 and 999999999),
 next_number bigint not null check(next_number between 1 and 1000000000),version integer not null check(version>0),
 identity_version integer not null check(identity_version>0),enabled boolean not null,exclusive_use_confirmed boolean not null,
 reference text not null,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 check(next_number>=first_number),check(not enabled or exclusive_use_confirmed),
 unique(issuer_cnpj,cuf,model,environment,series)
);
create table erp_fiscal_numbering.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),action text not null check(action in('configure','reserve')),
 issuer_cnpj text not null,request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table erp_fiscal_numbering.series_revision(
 series_id uuid not null references erp_fiscal_numbering.series(id),version integer not null check(version>0),record jsonb not null,
 command_id uuid not null references erp_fiscal_numbering.command(command_id) deferrable initially deferred,
 primary key(series_id,version)
);
create table erp_fiscal_numbering.reservation(
 id uuid primary key default gen_random_uuid(),series_id uuid not null references erp_fiscal_numbering.series(id),
 series_version integer not null,issuer_cnpj text not null,cuf text not null check(cuf='35'),
 model text not null check(model in('55','65')),environment text not null check(environment='2'),
 series integer not null check(series between 0 and 889),number integer not null check(number between 1 and 999999999),
 draft_id uuid not null unique,draft_version integer not null,snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 item_preparation_version integer not null,tax_preparation_version integer not null,
 item_preparation_hash text not null check(item_preparation_hash~'^[0-9a-f]{64}$'),tax_preparation_hash text not null check(tax_preparation_hash~'^[0-9a-f]{64}$'),
 source_document_id uuid not null references erp_documents.document(id),source_document_version integer not null,
 company_identity_version integer not null,company_fiscal_version integer not null,
 command_id uuid not null unique references erp_fiscal_numbering.command(command_id) deferrable initially deferred,
 actor uuid not null references auth.users(id),reserved_at timestamptz not null default clock_timestamp(),
 foreign key(series_id,series_version) references erp_fiscal_numbering.series_revision(series_id,version),
 foreign key(draft_id,draft_version) references erp_fiscal_drafts.revision(draft_id,version),
 foreign key(draft_id,item_preparation_version) references erp_fiscal_items.revision(draft_id,version),
 foreign key(draft_id,tax_preparation_version) references erp_fiscal_tax.revision(draft_id,version),
 unique(issuer_cnpj,cuf,model,environment,series,number),
 -- Conservative Brufap policy, not a SEFAZ rule: multi-invoice orders require a later explicit flow.
 unique(source_document_id,model,environment)
);
create table erp_fiscal_numbering.audit(
 id bigint generated always as identity primary key,command_id uuid not null unique references erp_fiscal_numbering.command(command_id) deferrable initially deferred,
 actor uuid not null references auth.users(id),action text not null check(action in('configure','reserve')),
 series_id uuid not null references erp_fiscal_numbering.series(id),reservation_id uuid references erp_fiscal_numbering.reservation(id),
 reference text,created_at timestamptz not null default clock_timestamp()
);
do $$declare t text;begin foreach t in array array['series','command','series_revision','reservation','audit'] loop
 execute format('alter table erp_fiscal_numbering.%I enable row level security',t);end loop;end$$;
revoke all on all tables in schema erp_fiscal_numbering from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_fiscal_numbering from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_numbering revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_numbering revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_numbering.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_numbering_history_immutable'using errcode='42501';end$$;
create trigger immutable_command before update or delete on erp_fiscal_numbering.command for each row execute function erp_fiscal_numbering.immutable();
create trigger immutable_revision before update or delete on erp_fiscal_numbering.series_revision for each row execute function erp_fiscal_numbering.immutable();
create trigger immutable_reservation before update or delete on erp_fiscal_numbering.reservation for each row execute function erp_fiscal_numbering.immutable();
create trigger immutable_audit before update or delete on erp_fiscal_numbering.audit for each row execute function erp_fiscal_numbering.immutable();
create function erp_fiscal_numbering.guard_series()returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'erp_fiscal_numbering_series_immutable'using errcode='42501';end if;
 if new.id<>old.id or new.issuer_cnpj<>old.issuer_cnpj or new.cuf<>old.cuf or new.model<>old.model or new.environment<>old.environment
  or new.series<>old.series or new.first_number<>old.first_number or new.created_at<>old.created_at
  or old.version=2147483647 or new.version<>old.version+1
  or new.next_number not in(old.next_number,old.next_number+1) then
  raise exception 'erp_fiscal_numbering_sequence_conflict'using errcode='40001';end if;
 if new.next_number<>old.next_number and (not old.enabled or not old.exclusive_use_confirmed
  or new.identity_version<>old.identity_version or new.enabled<>old.enabled or new.exclusive_use_confirmed<>old.exclusive_use_confirmed
  or new.reference<>old.reference)then raise exception 'erp_fiscal_numbering_sequence_conflict'using errcode='40001';end if;
 return new;
end$$;
create trigger guard_series before update or delete on erp_fiscal_numbering.series for each row execute function erp_fiscal_numbering.guard_series();
create function erp_fiscal_numbering.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_numbering','policy','brufap-homologation-exclusive-v1','environment','2',
 'can_emit',false,'can_transmit',false,'authorized',false,'financial_mutation_performed',false,'stock_mutation_performed',false)
$$;
create function erp_fiscal_numbering.access(p_user_id uuid,p_admin boolean default false)returns void language plpgsql stable set search_path=pg_catalog as $$
begin if not exists(select 1 from erp_access.membership where user_id=p_user_id and active and(role='admin'or(not p_admin and role='fiscal')))then
 raise exception 'erp_fiscal_numbering_forbidden'using errcode='42501';end if;end$$;
create function erp_fiscal_numbering.issuer()returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare r erp_company.identity%rowtype;begin
 select * into r from erp_company.identity where singleton;
 if not found or r.data->>'state'<>'SP' then raise exception 'erp_fiscal_numbering_issuer_unavailable'using errcode='40001';end if;
 return jsonb_build_object('cnpj',r.data->>'cnpj','identity_version',r.version,'cuf','35');
end$$;
create function erp_fiscal_numbering.reference_valid(t text)returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare spaces text:=' ';i integer;begin
 if t is null or length(t)<3 or length(t)>240 then return false;end if;
 for i in 1..159 loop if(i<32 or i>=127)and position(chr(i)in t)>0 then return false;end if;end loop;
 foreach i in array array[160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]loop spaces:=spaces||chr(i);end loop;
 return translate(t,spaces,'')<>'';
end$$;
create function erp_fiscal_numbering.series_record(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'issuer_cnpj',issuer_cnpj,'cuf',cuf,'model',model,'environment',environment,'series',series::text,
 'first_number',first_number::text,'next_number',case when next_number<=999999999 then next_number::text else null end,
 'exhausted',next_number>999999999,'version',version,'identity_version',identity_version,'enabled',enabled,
 'exclusive_use_confirmed',exclusive_use_confirmed,'reference',reference,'created_at',created_at,'updated_at',updated_at,
 'company_changed',identity_version is distinct from(select version from erp_company.identity where singleton))
 from erp_fiscal_numbering.series where id=p_id
$$;
create function erp_fiscal_numbering.reservation_record(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'state','reserved','numbering_reserved',true,'series_id',series_id,'series_version',series_version,
 'issuer_cnpj',issuer_cnpj,'cuf',cuf,'model',model,'environment',environment,'series',series::text,'number',number::text,
 'draft_id',draft_id,'draft_version',draft_version,'snapshot_hash',snapshot_hash,'item_preparation_version',item_preparation_version,
 'tax_preparation_version',tax_preparation_version,'item_preparation_hash',item_preparation_hash,'tax_preparation_hash',tax_preparation_hash,
 'source_document_id',source_document_id,'source_document_version',source_document_version,'company_identity_version',company_identity_version,
 'company_fiscal_version',company_fiscal_version,'reserved_at',reserved_at)
 from erp_fiscal_numbering.reservation where id=p_id
$$;
create function erp_fiscal_numbering.reservation_context(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('draft_version',d.version,'draft_status',d.status,'source_document_version',o.version,'source_status',o.status,
 'item_preparation_version',i.version,'tax_preparation_version',t.version,'company_identity_version',c.version,'company_fiscal_version',f.version,
 'basis_changed',d.version<>r.draft_version or o.version<>r.source_document_version or i.version is distinct from r.item_preparation_version
  or t.version is distinct from r.tax_preparation_version or c.version is distinct from r.company_identity_version or f.version is distinct from r.company_fiscal_version,
 'draft_archived',d.status='archived','source_cancelled',o.status='cancelled')
 from erp_fiscal_numbering.reservation r join erp_fiscal_drafts.draft d on d.id=r.draft_id join erp_documents.document o on o.id=r.source_document_id
 left join erp_fiscal_items.head i on i.draft_id=r.draft_id left join erp_fiscal_tax.head t on t.draft_id=r.draft_id
 left join erp_company.identity c on c.singleton left join erp_company.fiscal f on f.singleton where r.id=p_id
$$;
create function erp_fiscal_numbering.command_envelope(p_id uuid,p_replayed boolean)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_numbering.flags()||jsonb_build_object('command_id',command_id,'action',action,'replayed',p_replayed,'receipt',result,
 'current_series',erp_fiscal_numbering.series_record(case when action='configure'then(result->>'id')::uuid else(result->>'series_id')::uuid end),
 'current_basis',case when action='reserve'then erp_fiscal_numbering.reservation_context((result->>'id')::uuid)else null end)
 from erp_fiscal_numbering.command where command_id=p_id
$$;

create function public.erp_fiscal_numbering_configure(p_user_id uuid,p_command_id uuid,p_id uuid,p_expected_version integer,
 p_expected_identity_version integer,p_model text,p_environment text,p_series text,p_initial_number text,p_enabled boolean,
 p_exclusive_use_confirmed boolean,p_reference text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s erp_fiscal_numbering.series%rowtype;c erp_fiscal_numbering.command%rowtype;issuer jsonb;h text;rid uuid;rec jsonb;
begin
 perform erp_fiscal_numbering.access(p_user_id,true);
 if p_command_id is null or p_expected_version is null or p_expected_version<0 or p_expected_version=2147483647
  or(p_id is null)<>(p_expected_version=0)or p_expected_identity_version is null or p_expected_identity_version<1
  or p_model is null or p_model not in('55','65')or p_environment is distinct from'2'
  or p_series is null or p_series!~'^(0|[1-9][0-9]{0,2})$'or p_series::integer>889
  or p_initial_number is null or p_initial_number!~'^[1-9][0-9]{0,8}$'
  or p_enabled is null or p_exclusive_use_confirmed is null or(p_enabled and not p_exclusive_use_confirmed)
  or not erp_fiscal_numbering.reference_valid(p_reference)then raise exception 'erp_fiscal_numbering_config_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','configure','id',p_id,'expected_version',p_expected_version,
  'expected_identity_version',p_expected_identity_version,'model',p_model,'environment',p_environment,'series',p_series,'initial_number',p_initial_number,
  'enabled',p_enabled,'exclusive_use_confirmed',p_exclusive_use_confirmed,'reference',p_reference)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852946,hashtext(p_command_id::text));
 perform pg_advisory_xact_lock(174852920,1);issuer:=erp_fiscal_numbering.issuer();
 select * into c from erp_fiscal_numbering.command where command_id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'configure'or c.request_hash<>h then raise exception 'erp_fiscal_numbering_command_conflict'using errcode='40001';end if;
  if c.issuer_cnpj<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
  return erp_fiscal_numbering.command_envelope(p_command_id,true);
 end if;
 if(issuer->>'identity_version')::integer<>p_expected_identity_version then raise exception 'erp_fiscal_numbering_identity_conflict'using errcode='40001';end if;
 if p_id is null then
  if exists(select 1 from erp_fiscal_numbering.series where issuer_cnpj=issuer->>'cnpj'and model=p_model and environment='2'and series=p_series::integer)then
   raise exception 'erp_fiscal_numbering_series_exists'using errcode='40001';end if;
  insert into erp_fiscal_numbering.series(issuer_cnpj,cuf,model,environment,series,first_number,next_number,version,identity_version,enabled,exclusive_use_confirmed,reference)
   values(issuer->>'cnpj','35',p_model,'2',p_series::integer,p_initial_number::integer,p_initial_number::integer,1,p_expected_identity_version,p_enabled,p_exclusive_use_confirmed,p_reference)returning id into rid;
 else
  select * into s from erp_fiscal_numbering.series where id=p_id for update;
  if not found then raise exception 'erp_fiscal_numbering_not_found'using errcode='P0002';end if;
  if s.issuer_cnpj<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
  if s.version<>p_expected_version or s.model<>p_model or s.environment<>p_environment or s.series::text<>p_series or s.first_number::text<>p_initial_number then
   raise exception 'erp_fiscal_numbering_config_conflict'using errcode='40001';end if;
  update erp_fiscal_numbering.series set version=version+1,identity_version=p_expected_identity_version,enabled=p_enabled,
   exclusive_use_confirmed=p_exclusive_use_confirmed,reference=p_reference,updated_at=clock_timestamp()where id=p_id;rid:=p_id;
 end if;
 rec:=erp_fiscal_numbering.series_record(rid);
 insert into erp_fiscal_numbering.command(command_id,actor,action,issuer_cnpj,request_hash,result)values(p_command_id,p_user_id,'configure',issuer->>'cnpj',h,rec);
 insert into erp_fiscal_numbering.series_revision(series_id,version,record,command_id)values(rid,(rec->>'version')::integer,rec,p_command_id);
 insert into erp_fiscal_numbering.audit(command_id,actor,action,series_id,reference)values(p_command_id,p_user_id,'configure',rid,p_reference);
 return erp_fiscal_numbering.command_envelope(p_command_id,false);
end$$;

create function public.erp_fiscal_numbering_reserve(p_user_id uuid,p_command_id uuid,p_series_id uuid,p_expected_series_version integer,
 p_expected_identity_version integer,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,
 p_item_preparation_version integer,p_tax_preparation_version integer,p_confirm_reserve boolean)returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare c erp_fiscal_numbering.command%rowtype;s erp_fiscal_numbering.series%rowtype;parent uuid;d jsonb;ctx jsonb;issuer jsonb;
 i jsonb;t jsonb;iv integer;tv integer;h text;rid uuid;rec jsonb;sr jsonb;
begin
 perform erp_fiscal_numbering.access(p_user_id);
 if p_command_id is null or p_series_id is null or p_draft_id is null or p_confirm_reserve is distinct from true
  or p_expected_series_version is null or p_expected_series_version<1 or p_expected_series_version=2147483647
  or p_expected_identity_version is null or p_expected_identity_version<1 or p_expected_draft_version is null or p_expected_draft_version<1
  or p_item_preparation_version is null or p_item_preparation_version<1 or p_tax_preparation_version is null or p_tax_preparation_version<1
  or p_snapshot_hash is null or p_snapshot_hash!~'^[0-9a-f]{64}$'then raise exception 'erp_fiscal_numbering_reserve_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','reserve','series_id',p_series_id,'expected_series_version',p_expected_series_version,
  'expected_identity_version',p_expected_identity_version,'draft_id',p_draft_id,'draft_version',p_expected_draft_version,'snapshot_hash',p_snapshot_hash,
  'item_preparation_version',p_item_preparation_version,'tax_preparation_version',p_tax_preparation_version,'confirm_reserve',p_confirm_reserve)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852946,hashtext(p_command_id::text));
 select * into c from erp_fiscal_numbering.command where command_id=p_command_id;
 if found then
  if c.actor<>p_user_id or c.action<>'reserve'or c.request_hash<>h then raise exception 'erp_fiscal_numbering_command_conflict'using errcode='40001';end if;
  perform pg_advisory_xact_lock(174852920,1);issuer:=erp_fiscal_numbering.issuer();
  if c.issuer_cnpj<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
  return erp_fiscal_numbering.command_envelope(p_command_id,true);
 end if;
 -- Parent-before-draft matches022/035/040; no series lock is taken before a document lock.
 select source_document_id into parent from erp_fiscal_drafts.draft where id=p_draft_id;
 if not found then raise exception 'erp_fiscal_numbering_draft_not_found'using errcode='P0002';end if;
 perform 1 from erp_documents.document where id=parent for share;
 perform 1 from erp_fiscal_drafts.draft where id=p_draft_id and source_document_id=parent for update;
 perform pg_advisory_xact_lock(174852920,1);issuer:=erp_fiscal_numbering.issuer();
 select version into iv from erp_fiscal_items.head where draft_id=p_draft_id for share;
 select version into tv from erp_fiscal_tax.head where draft_id=p_draft_id for share;
 d:=erp_fiscal_drafts.record(p_draft_id);ctx:=erp_fiscal_drafts.context(d);
 select record into i from erp_fiscal_items.revision where draft_id=p_draft_id and version=iv;
 select record into t from erp_fiscal_tax.revision where draft_id=p_draft_id and version=tv;
 if d is null or ctx is null or d->>'status'is distinct from'draft'or d->>'environment'is distinct from'2'or(d->>'version')::integer is distinct from p_expected_draft_version
  or d->>'snapshot_hash'is distinct from p_snapshot_hash or(ctx->>'source_changed')::boolean is distinct from false or(ctx->>'company_changed')::boolean is distinct from false or ctx->>'source_status'='cancelled'
  or(issuer->>'identity_version')::integer<>p_expected_identity_version or d#>>'{snapshot,company,identity,cnpj}'is distinct from issuer->>'cnpj'
  or d#>>'{snapshot,company,identity,state}'is distinct from'SP'or d#>>'{snapshot,company,fiscal_version}'is null
  or iv is distinct from p_item_preparation_version or tv is distinct from p_tax_preparation_version or i is null or t is null
  or i->>'draft_id'is distinct from p_draft_id::text or t->>'draft_id'is distinct from p_draft_id::text
  or(i->>'draft_version')::integer is distinct from p_expected_draft_version or(t->>'draft_version')::integer is distinct from p_expected_draft_version
  or i->>'snapshot_hash'is distinct from p_snapshot_hash or t->>'snapshot_hash'is distinct from p_snapshot_hash
  or(t->>'item_preparation_version')::integer is distinct from iv or i->>'model'is distinct from d->>'model'or t->>'model'is distinct from d->>'model'
  or i->>'environment'is distinct from'2'or t->>'environment'is distinct from'2'
  or i->>'source_document_id'is distinct from parent::text or i->>'source_document_version'is distinct from d->>'source_document_version'
  or t->>'source_document_id'is distinct from parent::text or t->>'source_document_version'is distinct from d->>'source_document_version'
  or t->>'company_identity_version'is distinct from d#>>'{snapshot,company,identity_version}'
  or t->>'company_fiscal_version'is distinct from d#>>'{snapshot,company,fiscal_version}'then
  raise exception 'erp_fiscal_numbering_basis_conflict'using errcode='40001';end if;
 select * into s from erp_fiscal_numbering.series where id=p_series_id for update;
 if not found then raise exception 'erp_fiscal_numbering_not_found'using errcode='P0002';end if;
 if s.issuer_cnpj<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
 if s.version<>p_expected_series_version or s.identity_version<>p_expected_identity_version or s.model<>d->>'model'or s.environment<>'2'
  or not s.enabled or not s.exclusive_use_confirmed then raise exception 'erp_fiscal_numbering_series_conflict'using errcode='40001';end if;
 if s.next_number>999999999 then raise exception 'erp_fiscal_numbering_exhausted'using errcode='40001';end if;
 if exists(select 1 from erp_fiscal_numbering.reservation where draft_id=p_draft_id or(source_document_id=parent and model=s.model and environment='2'))then
  raise exception 'erp_fiscal_numbering_already_reserved'using errcode='40001';end if;
 update erp_fiscal_numbering.series set next_number=next_number+1,version=version+1,updated_at=clock_timestamp()where id=s.id;
 sr:=erp_fiscal_numbering.series_record(s.id);
 insert into erp_fiscal_numbering.series_revision(series_id,version,record,command_id)values(s.id,s.version+1,sr,p_command_id);
 insert into erp_fiscal_numbering.reservation(series_id,series_version,issuer_cnpj,cuf,model,environment,series,number,draft_id,draft_version,snapshot_hash,
  item_preparation_version,tax_preparation_version,item_preparation_hash,tax_preparation_hash,source_document_id,source_document_version,
  company_identity_version,company_fiscal_version,command_id,actor)
 values(s.id,s.version,s.issuer_cnpj,s.cuf,s.model,s.environment,s.series,s.next_number::integer,p_draft_id,p_expected_draft_version,p_snapshot_hash,
  iv,tv,encode(sha256(convert_to(i::text,'UTF8')),'hex'),encode(sha256(convert_to(t::text,'UTF8')),'hex'),parent,(d->>'source_document_version')::integer,
  p_expected_identity_version,(d#>>'{snapshot,company,fiscal_version}')::integer,p_command_id,p_user_id)returning id into rid;
 rec:=erp_fiscal_numbering.reservation_record(rid);
 insert into erp_fiscal_numbering.command(command_id,actor,action,issuer_cnpj,request_hash,result)values(p_command_id,p_user_id,'reserve',s.issuer_cnpj,h,rec);
 insert into erp_fiscal_numbering.audit(command_id,actor,action,series_id,reservation_id)values(p_command_id,p_user_id,'reserve',s.id,rid);
 return erp_fiscal_numbering.command_envelope(p_command_id,false);
end$$;

create function public.erp_fiscal_numbering_series(p_user_id uuid,p_model text default null,p_limit integer default 25,p_after uuid default null)returns jsonb
language plpgsql stable security definer set search_path=pg_catalog as $$
declare issuer jsonb;items jsonb;more boolean;begin
 perform erp_fiscal_numbering.access(p_user_id);issuer:=erp_fiscal_numbering.issuer();
 if(p_model is not null and p_model not in('55','65'))or p_limit is null or p_limit<1 or p_limit>25 then raise exception 'erp_fiscal_numbering_query_invalid'using errcode='22023';end if;
 select coalesce(jsonb_agg(erp_fiscal_numbering.series_record(id)order by id),'[]')into items from(
  select id from erp_fiscal_numbering.series where issuer_cnpj=issuer->>'cnpj'and(p_model is null or model=p_model)and(p_after is null or id>p_after)order by id limit p_limit)t;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_numbering.series where issuer_cnpj=issuer->>'cnpj'
  and(p_model is null or model=p_model)and id>(items->-1->>'id')::uuid);
 return erp_fiscal_numbering.flags()||jsonb_build_object('read_only',true,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then items->-1->>'id'else null end);
end$$;
create function public.erp_fiscal_numbering_reservation(p_user_id uuid,p_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rec jsonb;issuer jsonb;begin
 perform erp_fiscal_numbering.access(p_user_id);issuer:=erp_fiscal_numbering.issuer();
 rec:=erp_fiscal_numbering.reservation_record(p_id);if rec is null then raise exception 'erp_fiscal_numbering_not_found'using errcode='P0002';end if;
 if rec->>'issuer_cnpj'<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
 return erp_fiscal_numbering.flags()||jsonb_build_object('read_only',true,'receipt',rec,'current_series',erp_fiscal_numbering.series_record((rec->>'series_id')::uuid),
  'current_basis',erp_fiscal_numbering.reservation_context(p_id));
end$$;
create function public.erp_fiscal_numbering_draft(p_user_id uuid,p_draft_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare d jsonb;issuer jsonb;rid uuid;begin
 perform erp_fiscal_numbering.access(p_user_id);issuer:=erp_fiscal_numbering.issuer();
 d:=erp_fiscal_drafts.record(p_draft_id);if d is null then raise exception 'erp_fiscal_numbering_draft_not_found'using errcode='P0002';end if;
 if d#>>'{snapshot,company,identity,cnpj}'is distinct from issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_issuer_forbidden'using errcode='42501';end if;
 select id into rid from erp_fiscal_numbering.reservation where draft_id=p_draft_id;
 if rid is not null then return public.erp_fiscal_numbering_reservation(p_user_id,rid);end if;
 return erp_fiscal_numbering.flags()||jsonb_build_object('read_only',true,'receipt',null,'current_series',null,'current_basis',null);
end$$;
create function public.erp_fiscal_numbering_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_fiscal_numbering.command%rowtype;issuer jsonb;begin
 perform erp_fiscal_numbering.access(p_user_id);issuer:=erp_fiscal_numbering.issuer();
 select * into c from erp_fiscal_numbering.command where command_id=p_command_id;
 if not found then raise exception 'erp_fiscal_numbering_not_found'using errcode='P0002';end if;
 if c.actor<>p_user_id or c.issuer_cnpj<>issuer->>'cnpj'then raise exception 'erp_fiscal_numbering_command_forbidden'using errcode='42501';end if;
 perform erp_fiscal_numbering.access(p_user_id,c.action='configure');
 return erp_fiscal_numbering.command_envelope(p_command_id,true);
end$$;
revoke all on all functions in schema erp_fiscal_numbering from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_numbering_configure(uuid,uuid,uuid,integer,integer,text,text,text,text,boolean,boolean,text),
 public.erp_fiscal_numbering_reserve(uuid,uuid,uuid,integer,integer,uuid,integer,text,integer,integer,boolean),
 public.erp_fiscal_numbering_series(uuid,text,integer,uuid),public.erp_fiscal_numbering_reservation(uuid,uuid),public.erp_fiscal_numbering_draft(uuid,uuid),public.erp_fiscal_numbering_command(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_numbering_configure(uuid,uuid,uuid,integer,integer,text,text,text,text,boolean,boolean,text),
 public.erp_fiscal_numbering_reserve(uuid,uuid,uuid,integer,integer,uuid,integer,text,integer,integer,boolean),
 public.erp_fiscal_numbering_series(uuid,text,integer,uuid),public.erp_fiscal_numbering_reservation(uuid,uuid),public.erp_fiscal_numbering_draft(uuid,uuid),public.erp_fiscal_numbering_command(uuid,uuid)to service_role;
commit;
