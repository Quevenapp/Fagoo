-- Operational remittances are opt-in and never promote existing homologation artifacts.
begin;
alter table erp_cnab.remittance add column purpose text not null default 'homologation' check(purpose in('homologation','operational'));
alter table erp_cnab.return_file add column purpose text not null default 'homologation' check(purpose in('homologation','operational'));
alter table erp_cnab.return_event add column purpose text not null default 'homologation' check(purpose in('homologation','operational'));

create table erp_cnab.operational_approval (
 profile_id uuid primary key references erp_cnab.profile(id), version integer not null check(version>0)
);
create table erp_cnab.operational_approval_revision (
 profile_id uuid not null references erp_cnab.profile(id),version integer not null check(version>0),
 enabled boolean not null, profile_config_hash text not null check(profile_config_hash~'^[a-f0-9]{64}$'),
 profile_version integer not null check(profile_version>0),identity_version integer,company_cnpj text,
 reference text not null check(length(btrim(reference)) between 3 and 200 and reference!~'[[:cntrl:]]'),
 confirmed_on date not null,actor uuid not null references auth.users(id),command_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),primary key(profile_id,version)
);
alter table erp_cnab.operational_approval add foreign key(profile_id,version)
 references erp_cnab.operational_approval_revision(profile_id,version) deferrable initially deferred;
alter table erp_cnab.operational_approval enable row level security;
alter table erp_cnab.operational_approval_revision enable row level security;
revoke all on erp_cnab.operational_approval,erp_cnab.operational_approval_revision from public,anon,authenticated,service_role;

create function erp_cnab.purpose_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin if NEW.purpose is distinct from OLD.purpose then raise exception 'erp_cnab_purpose_immutable' using errcode='40001';end if;return NEW;end $$;
create trigger cnab_remittance_purpose_immutable before update on erp_cnab.remittance for each row execute function erp_cnab.purpose_immutable();
create trigger cnab_return_purpose_immutable before update on erp_cnab.return_file for each row execute function erp_cnab.purpose_immutable();
create trigger cnab_event_purpose_immutable before update on erp_cnab.return_event for each row execute function erp_cnab.purpose_immutable();
create function erp_cnab.operational_revision_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_cnab_operational_revision_immutable' using errcode='42501';end $$;
create trigger cnab_operational_revision_immutable before update or delete on erp_cnab.operational_approval_revision for each row execute function erp_cnab.operational_revision_immutable();
create function erp_cnab.occurrence_purpose_check() returns trigger language plpgsql set search_path=pg_catalog as $$
begin if not exists(select 1 from erp_cnab.return_file f join erp_cnab.return_event e on e.id=NEW.event_id
 where f.id=NEW.file_id and f.profile_id=e.profile_id and f.purpose=e.purpose)then raise exception 'erp_cnab_purpose_mismatch' using errcode='40001';end if;return NEW;end $$;
create trigger cnab_occurrence_purpose before insert or update on erp_cnab.return_occurrence for each row execute function erp_cnab.occurrence_purpose_check();

create function erp_cnab.operational_safety() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('purpose','operational','productionReady',false,'bankTransmissionPerformed',false,'financialMutationPerformed',false,'originAuthenticated',false);
$$;
create function erp_cnab.operational_config_hash(p_profile_id uuid) returns text language sql stable set search_path=pg_catalog as $$
 select encode(sha256(convert_to(jsonb_build_object('identity',identity,'settings',settings,'account_id',account_id)::text,'UTF8')),'hex') from erp_cnab.profile where id=p_profile_id;
$$;
create function erp_cnab.operational_finish(p_actor uuid,p_id uuid,p_action text,p_data jsonb,p_record uuid,p_result jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare result jsonb;begin
 result:=p_result||erp_cnab.operational_safety()||jsonb_build_object('replayed',false);
 insert into erp_cnab.command values(p_id,p_actor,encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex'),result,clock_timestamp());
 insert into erp_cnab.audit(actor,command_id,action,record_id)values(p_actor,p_id,p_action,p_record);return result;
end $$;
create function erp_cnab.operational_status(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare p erp_cnab.profile;a erp_cnab.operational_approval_revision;c erp_company.identity;bank erp_finance.account;issues text[]:='{}';begin
 select * into p from erp_cnab.profile where id=p_id;if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 select r.* into a from erp_cnab.operational_approval h join erp_cnab.operational_approval_revision r using(profile_id,version)where h.profile_id=p_id;
 select * into c from erp_company.identity where singleton;select * into bank from erp_finance.account where id=p.account_id;
 if a.profile_id is null then issues:=array_append(issues,'OPERATIONAL_APPROVAL_MISSING');elsif not a.enabled then issues:=array_append(issues,'OPERATIONAL_APPROVAL_DISABLED');end if;
 if c.singleton is null then issues:=array_append(issues,'COMPANY_IDENTITY_MISSING');
 elsif c.data->>'cnpj' is distinct from p.identity->>'cnpj' then issues:=array_append(issues,'BENEFICIARY_CNPJ_MISMATCH');end if;
 if bank.id is null or not bank.active or bank.kind<>'bank'then issues:=array_append(issues,'BANK_ACCOUNT_INACTIVE');end if;
 if p.settings->'contractVerified' is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified'is distinct from 'true'::jsonb
  or(p.identity->>'bank'='077'and p.identity->>'wallet'='110'and p.settings->'reservedRange'->'verified'is distinct from 'true'::jsonb)then issues:=array_append(issues,'BANK_CONTRACT_OR_POLICY_PENDING');end if;
 if a.profile_id is not null and(a.profile_config_hash is distinct from erp_cnab.operational_config_hash(p_id)or a.identity_version is distinct from c.version or a.company_cnpj is distinct from c.data->>'cnpj')then issues:=array_append(issues,'OPERATIONAL_APPROVAL_STALE');end if;
 return jsonb_build_object('profile_id',p.id,'approval_version',coalesce(a.version,0),'enabled',coalesce(a.enabled,false),'effective_enabled',cardinality(issues)=0,
  'profile_version',p.version,'identity_version',c.version,'reference',a.reference,'confirmed_on',a.confirmed_on,'reviewed_at',a.created_at,'issues',to_jsonb(issues));
end $$;
create function erp_cnab.require_operational(p_id uuid,p_expected_approval integer default null)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare s jsonb;begin
 s:=erp_cnab.operational_status(p_id);
 if s->'effective_enabled'is distinct from 'true'::jsonb or(p_expected_approval is not null and(s->>'approval_version')::integer<>p_expected_approval)then raise exception 'erp_cnab_operational_approval_required'using errcode='40001';end if;return s;
end $$;
create function public.erp_cnab_operational_profiles(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_cnab.access(p_user_id);return erp_cnab.operational_safety()||jsonb_build_object('items',(select coalesce(jsonb_agg(jsonb_build_object('profile',erp_cnab.profile_dto(id)-array['purpose','productionReady'],'approval',erp_cnab.operational_status(id))order by id),'[]')from erp_cnab.profile));
end $$;
create function public.erp_cnab_operational_approve(p_user_id uuid,p_profile_id uuid,p_command_id uuid,p_expected_approval integer,p_expected_profile integer,p_expected_identity integer,p_enabled boolean,p_confirmed_on date,p_reference text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare p erp_cnab.profile;c erp_company.identity;v integer;cmd jsonb;replay jsonb;s jsonb;begin
 perform erp_cnab.access(p_user_id,true,true);
 if p_profile_id is null or p_expected_approval is null or p_expected_approval not between 0 and 2147483646 or p_expected_profile is null or p_expected_profile<1 or p_enabled is null
  or p_confirmed_on is null or p_confirmed_on not between date'2000-01-01'and(clock_timestamp()at time zone'America/Sao_Paulo')::date
  or p_reference is null or length(btrim(p_reference))not between 3 and 200 or p_reference~'[[:cntrl:]]'
  or length(btrim(p_reference,U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0 then raise exception 'erp_cnab_operational_approval_invalid'using errcode='22023';end if;
 cmd:=jsonb_build_object('profile_id',p_profile_id,'approval_version',p_expected_approval,'profile_version',p_expected_profile,'identity_version',p_expected_identity,'enabled',p_enabled,'confirmed_on',p_confirmed_on,'reference',p_reference);
 replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_approve',cmd);if replay is not null then return replay;end if;
 perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=p_profile_id for update;
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 select * into c from erp_company.identity where singleton;select version into v from erp_cnab.operational_approval where profile_id=p_profile_id for update;
 if coalesce(v,0)<>p_expected_approval or p.version<>p_expected_profile or c.version is distinct from p_expected_identity then raise exception 'erp_cnab_operational_version_conflict'using errcode='40001';end if;
 perform 1 from erp_finance.account where id=p.account_id for share;
 if p_enabled and(c.singleton is null or c.data->>'cnpj'is distinct from p.identity->>'cnpj'
  or not exists(select 1 from erp_finance.account where id=p.account_id and active and kind='bank')
  or p.settings->'contractVerified'is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified'is distinct from 'true'::jsonb
  or(p.identity->>'bank'='077'and p.identity->>'wallet'='110'and p.settings->'reservedRange'->'verified'is distinct from 'true'::jsonb))then raise exception 'erp_cnab_operational_prerequisites'using errcode='40001';end if;
 v:=coalesce(v,0)+1;insert into erp_cnab.operational_approval_revision(profile_id,version,enabled,profile_config_hash,profile_version,identity_version,company_cnpj,reference,confirmed_on,actor,command_id)
  values(p.id,v,p_enabled,erp_cnab.operational_config_hash(p.id),p.version,c.version,c.data->>'cnpj',btrim(p_reference),p_confirmed_on,p_user_id,p_command_id);
 insert into erp_cnab.operational_approval values(p.id,v)on conflict(profile_id)do update set version=excluded.version;
 return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_approve',cmd,p.id,jsonb_build_object('approval',erp_cnab.operational_status(p.id)));
end $$;
create function erp_cnab.reserve_for_purpose(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_version integer,p_generated_on date,p_titles jsonb,p_preview boolean,p_purpose text,p_expected_approval integer,p_preview_hash text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; t erp_finance.title; c record; row jsonb; input_title jsonb; payer jsonb; snap jsonb; result_titles jsonb:='[]'; rid uuid; bid uuid; base text; control text; doc text; sequence bigint; replay jsonb; command jsonb; days integer; approval jsonb; proofs jsonb:='[]';preview_hash text;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_purpose is null or p_purpose not in ('homologation','operational') then raise exception 'erp_cnab_invalid_purpose' using errcode='22023'; end if;
  if p_preview is null then raise exception 'erp_cnab_preview_required' using errcode='22023'; end if;
  command:=jsonb_build_object('profile_id',p_profile_id,'version',p_expected_version,'generated_on',p_generated_on,'titles',p_titles);
  if p_purpose='operational' then command:=command||jsonb_build_object('purpose',p_purpose,'approval_version',p_expected_approval,'preview_hash',p_preview_hash); end if;
  if not p_preview then replay:=erp_cnab.start_command(p_user_id,p_command_id,case when p_purpose='operational' then 'operational_reserve' else 'reserve' end,command); if replay is not null and p_purpose='homologation' then return replay; end if; end if;
  if p_purpose='operational' then perform pg_advisory_xact_lock(174852920,1); end if;
  if jsonb_typeof(p_titles) is distinct from 'array' or jsonb_array_length(p_titles) not between 1 and 30 or octet_length(p_titles::text)>65536
    or p_generated_on is null or p_generated_on not between date '2000-01-01' and (clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_cnab_invalid_reservation' using errcode='22023'; end if;
  if(select count(distinct erp_finance.uuid_value(value->'title_id'))from jsonb_array_elements(p_titles))<>jsonb_array_length(p_titles)then raise exception 'erp_cnab_duplicate_title'using errcode='22023';end if;
  select * into p from erp_cnab.profile where id=p_profile_id for update;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if p_purpose='operational' then approval:=erp_cnab.require_operational(p.id,p_expected_approval);if replay is not null then return replay;end if;
    if p_generated_on<>(clock_timestamp()at time zone'America/Sao_Paulo')::date then raise exception 'erp_cnab_operational_generation_date'using errcode='22023';end if;
  end if;
  if p.version is distinct from p_expected_version then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
  if p.settings->'contractVerified' is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb
    or (p.identity->>'bank'='077' and p.identity->>'wallet'='110' and p.settings->'reservedRange'->'verified' is distinct from 'true'::jsonb)
    then raise exception 'erp_cnab_profile_unconfirmed' using errcode='40001'; end if;
  sequence:=p.next_sequence; if sequence>9999999 then raise exception 'erp_cnab_sequence_exhausted' using errcode='40001'; end if;
  rid:=gen_random_uuid();
  if not p_preview then insert into erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor,purpose) values(rid,p.id,sequence,p_generated_on,'{}',p_user_id,p_purpose); end if;
  -- Lock title rows in a stable order, so competing batches cannot deadlock by input order.
  perform 1 from erp_finance.title where id in (select erp_finance.uuid_value(value->'title_id') from jsonb_array_elements(p_titles)) order by id for update;
  perform 1 from erp_catalog.record where id in (select locked_title.contact_id from erp_finance.title locked_title
    where locked_title.id in (select erp_finance.uuid_value(value->'title_id') from jsonb_array_elements(p_titles))) order by id for share;
  -- Finance settlements lock title before account: preserve that order.
  perform 1 from erp_finance.account where id=p.account_id and active and kind='bank' for share;
  if not found then raise exception 'erp_cnab_bank_account_required' using errcode='40001'; end if;
  for row in select value from jsonb_array_elements(p_titles) loop
    perform erp_finance.keys(row,array['title_id','expected_version','document_number','payment_limit_days']);
    select * into t from erp_finance.title where id=erp_finance.uuid_value(row->'title_id');
    if not found then raise exception 'erp_cnab_title_not_found' using errcode='P0002'; end if;
    if p_purpose='operational' and exists(select 1 from erp_finance.origin_import_origin where title_id=t.id)then raise exception 'erp_cnab_legacy_binding_required'using errcode='40001';end if;
    if t.version is distinct from erp_finance.expected(row->'expected_version') or t.kind<>'receivable' or t.cancelled or t.settled_cents<>0
      or t.issued_on>p_generated_on or t.due_on<p_generated_on or t.amount_cents>9999999999999
      or (p.identity->>'bank'='077' and t.amount_cents<250) or exists(select 1 from erp_cnab.billing_title where title_id=t.id) then raise exception 'erp_cnab_title_not_eligible' using errcode='40001'; end if;
    select r.name,r.version,r.active,x.* into c from erp_catalog.record r join erp_catalog.contact x on x.record_id=r.id where r.id=t.contact_id for share of r,x;
    if not found or not c.active or c.person_type not in ('F','J') then raise exception 'erp_cnab_payer_required' using errcode='22023'; end if;
    doc:=erp_finance.txt(row,'document_number',10,true); if doc!~'^[A-Z0-9 .&/-]{1,10}$' or doc<>btrim(doc) then raise exception 'erp_cnab_document_number_invalid' using errcode='22023'; end if;
    control:=substr(replace(gen_random_uuid()::text,'-',''),1,25); control:=upper(control); bid:=gen_random_uuid();
    if p.next_our_number is not null then
      if p.next_our_number>(case when p.identity->>'bank'='341' then 99999999 else (p.settings->'reservedRange'->>'end')::bigint end) then raise exception 'erp_cnab_number_range_exhausted' using errcode='40001'; end if;
      base:=lpad(p.next_our_number::text,case when p.identity->>'bank'='341' then 8 else 10 end,'0'); p.next_our_number:=p.next_our_number+1;
    else base:=null; end if;
    payer:=jsonb_build_object('type',case c.person_type when 'F' then '01' else '02' end,'document',c.document,'name',c.name,
      'address',concat_ws(' ',nullif(c.street,''),nullif(c.number,''),nullif(c.complement,'')),'neighborhood',coalesce(c.district,''),'city',coalesce(c.city,''),'state',c.state,'postalCode',c.postal_code);
    input_title:=jsonb_build_object('id',bid::text,'control',control,'documentNumber',doc,'amountCents',t.amount_cents::text,'issuedOn',t.issued_on,'dueOn',t.due_on,'payer',payer);
    if base is not null then input_title:=input_title||jsonb_build_object('ourNumber',base); end if;
    if p.identity->>'bank'='077' then days:=erp_finance.expected(row->'payment_limit_days'); if days>60 then raise exception 'erp_cnab_payment_limit_invalid' using errcode='22023'; end if;
      input_title:=input_title||jsonb_build_object('paymentLimitDays',days);
    elsif row ? 'payment_limit_days' then raise exception 'erp_cnab_payment_limit_not_applicable' using errcode='22023'; end if;
    snap:=jsonb_build_object('title',input_title,'finance_title_version',t.version,'contact_version',c.version,'finance_title_id',t.id);
    proofs:=proofs||jsonb_build_array(snap||jsonb_build_object('contact_id',t.contact_id,'title',input_title-array['id','control']));
    if exists(select 1 from erp_cnab.billing_title where profile_id=p.id and document_number=doc) then raise exception 'erp_cnab_document_number_used' using errcode='40001'; end if;
    if not p_preview then insert into erp_cnab.billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number_base,snapshot) values(bid,t.id,p.id,rid,control,doc,base,snap); end if;
    result_titles:=result_titles||jsonb_build_array(input_title);
  end loop;
  snap:=jsonb_build_object('profile',erp_cnab.core_profile(p.id),'titles',result_titles,'generatedOn',p_generated_on,'remittanceSequence',sequence::text,'purpose',p_purpose);
  if p_purpose='operational' then
    snap:=snap||jsonb_build_object('operational_authorization',jsonb_build_object('approval_version',p_expected_approval,'profile_config_hash',erp_cnab.operational_config_hash(p.id),'identity_version',approval->'identity_version'));
    preview_hash:=encode(sha256(convert_to(jsonb_build_object('profile_id',p.id,'profile_version',p.version,'profile',snap->'profile','sequence',sequence::text,'generated_on',p_generated_on,'approval',snap->'operational_authorization','titles',proofs)::text,'UTF8')),'hex');
    if not p_preview and preview_hash is distinct from p_preview_hash then raise exception 'erp_cnab_operational_preview_changed'using errcode='40001';end if;
    snap:=snap||jsonb_build_object('preview_hash',preview_hash);
  end if;
  if p_preview then return jsonb_build_object('snapshot',snap,'profile_id',p.id,'profile_version',p.version,'preview',true,'preview_hash',preview_hash,'preview_items',proofs); end if;
  update erp_cnab.remittance set snapshot=snap where id=rid;
  update erp_cnab.profile set next_sequence=sequence+1,next_our_number=p.next_our_number,version=version+1,updated_at=clock_timestamp() where id=p.id;
  if p_purpose='operational' then return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_reserve',command,rid,jsonb_build_object('id',rid,'profile_id',p.id,'sequence',sequence::text,'state','reserved'));end if;
  return erp_cnab.finish_command(p_user_id,p_command_id,'reserve',command,rid,jsonb_build_object('id',rid,'profile_id',p.id,'sequence',sequence::text,'state','reserved'));
end $$;

create or replace function public.erp_cnab_reserve(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_version integer,p_generated_on date,p_titles jsonb,p_preview boolean default false)
returns jsonb language sql security definer set search_path=pg_catalog as $$
 select erp_cnab.reserve_for_purpose(p_user_id,p_command_id,p_profile_id,p_expected_version,p_generated_on,p_titles,p_preview,'homologation',null);
$$;
create function public.erp_cnab_operational_reserve(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_version integer,p_expected_approval integer,p_generated_on date,p_titles jsonb,p_confirm_operational boolean,p_preview boolean default false,p_preview_hash text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$begin
 perform erp_cnab.access(p_user_id,true);
 if p_expected_approval is null or p_expected_approval<1 or p_confirm_operational is null or(not p_preview and not p_confirm_operational)then raise exception 'erp_cnab_operational_confirmation_required'using errcode='22023';end if;
 if(p_preview and p_preview_hash is not null)or(not p_preview and(p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$'))then raise exception 'erp_cnab_operational_preview_required'using errcode='22023';end if;
 return erp_cnab.reserve_for_purpose(p_user_id,p_command_id,p_profile_id,p_expected_version,p_generated_on,p_titles,p_preview,'operational',p_expected_approval,p_preview_hash);
end $$;

create or replace function public.erp_cnab_reservation(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare r erp_cnab.remittance; begin
  perform erp_cnab.access(p_user_id,true); select * into r from erp_cnab.remittance where id=p_id and purpose='homologation';
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'snapshot',r.snapshot,'file_hash',r.file_hash,'object_path',r.object_path,'byte_size',r.byte_size,'purpose','homologation','productionReady',false,'financialMutationPerformed',false);
end $$;

create or replace function public.erp_cnab_finalize(p_user_id uuid,p_command_id uuid,p_id uuid,p_hash text,p_size integer,p_path text,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; b erp_cnab.billing_title; row jsonb; command jsonb; replay jsonb; n text; begin
  perform erp_cnab.access(p_user_id,true); if not exists(select 1 from erp_cnab.remittance where id=p_id and purpose='homologation')then raise exception 'erp_cnab_not_found'using errcode='P0002';end if; command:=jsonb_build_object('id',p_id,'hash',p_hash,'size',p_size,'path',p_path,'manifest',p_manifest);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'finalize',command); if replay is not null then return replay; end if;
  select * into r from erp_cnab.remittance where id=p_id for update; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  perform erp_cnab.storage_check(r.profile_id,'remittances',p_hash,p_size,p_path);
  if r.state='ready' then if r.file_hash<>p_hash or r.byte_size<>p_size or r.manifest<>p_manifest then raise exception 'erp_cnab_finalized_conflict' using errcode='40001'; end if;
  else
    select * into p from erp_cnab.profile where id=r.profile_id for share;
    if p.settings->'contractVerified' is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb
      or (p.identity->>'bank'='077' and p.identity->>'wallet'='110' and p.settings->'reservedRange'->'verified' is distinct from 'true'::jsonb)
      then raise exception 'erp_cnab_profile_unconfirmed' using errcode='40001'; end if;
    perform 1 from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id order by t.id for share of t;
    perform 1 from erp_catalog.record c where c.id in (select t.contact_id from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id) order by c.id for share;
    perform 1 from erp_finance.account where id=p.account_id and active and kind='bank' for share;
    if not found then raise exception 'erp_cnab_bank_account_required' using errcode='40001'; end if;
    if exists(select 1 from erp_cnab.billing_title bt join erp_finance.title t on t.id=bt.title_id join erp_catalog.record c on c.id=t.contact_id
      where bt.remittance_id=r.id and (t.version<>(bt.snapshot->>'finance_title_version')::integer or t.cancelled or t.settled_cents<>0
        or c.version<>(bt.snapshot->>'contact_version')::integer or not c.active)) then raise exception 'erp_cnab_snapshot_stale' using errcode='40001'; end if;
    if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)<>(select count(*) from erp_cnab.billing_title where remittance_id=r.id) then raise exception 'erp_cnab_manifest_invalid' using errcode='22023'; end if;
    if (select count(distinct value->>'titleId') from jsonb_array_elements(p_manifest))<>jsonb_array_length(p_manifest) then raise exception 'erp_cnab_manifest_duplicate' using errcode='22023'; end if;
    for row in select value from jsonb_array_elements(p_manifest) loop
      perform erp_finance.keys(row,array['titleId','control','documentNumber','amountCents','dueDate','ourNumber']);
      select * into b from erp_cnab.billing_title where id=erp_finance.uuid_value(row->'titleId') and remittance_id=r.id for update;
      if not found or row->>'control' is distinct from b.control or row->>'documentNumber' is distinct from b.document_number
        or row->>'amountCents' is distinct from b.snapshot->'title'->>'amountCents' or row->>'dueDate' is distinct from b.snapshot->'title'->>'dueOn' then raise exception 'erp_cnab_manifest_mismatch' using errcode='40001'; end if;
      n:=row->>'ourNumber'; if b.our_number_base is null then if n is not null then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      elsif n is null or n!~'^[0-9]+$' or length(n)<>length(b.our_number_base)+1 or left(n,length(b.our_number_base))<>b.our_number_base then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      update erp_cnab.billing_title set our_number=n where id=b.id;
    end loop;
    update erp_cnab.remittance set state='ready',object_path=p_path,file_hash=p_hash,byte_size=p_size,manifest=p_manifest,finalized_at=clock_timestamp() where id=r.id;
  end if;
  return erp_cnab.finish_command(p_user_id,p_command_id,'finalize',command,r.id,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state','ready','sequence',r.sequence::text,'file_hash',p_hash,'byte_size',p_size));
end $$;

create or replace function public.erp_cnab_file(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare result jsonb; begin
  perform erp_cnab.access(p_user_id);
  if p_kind='remittance' then select jsonb_build_object('id',r.id,'profile_id',r.profile_id,'hash',r.file_hash,'size',r.byte_size,'path',r.object_path,
    'filename',case when p.identity->>'bank'='077' then 'CI400_001_' else 'ITAU_TESTE_' end||lpad(r.sequence::text,7,'0')||'.REM') into result from erp_cnab.remittance r join erp_cnab.profile p on p.id=r.profile_id where r.id=p_id and r.purpose='homologation' and r.state='ready';
  elsif p_kind='return' then select jsonb_build_object('id',id,'profile_id',profile_id,'hash',file_hash,'size',byte_size,'path',object_path,'filename','RETORNO_'||id::text||'.RET') into result from erp_cnab.return_file where id=p_id and purpose='homologation';
  else raise exception 'erp_cnab_invalid_kind' using errcode='22023'; end if;
  if result is null then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  perform erp_cnab.storage_check((result->>'profile_id')::uuid,case when p_kind='return' then 'returns' else 'remittances' end,result->>'hash',(result->>'size')::integer,result->>'path');
  return result;
end $$;

create or replace function public.erp_cnab_files(p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb; more boolean; cursor uuid; begin
  perform erp_cnab.access(p_user_id);
  if p_kind not in ('remittance','return') or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with entries as (
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','remittance','state',r.state,'sequence',r.sequence::text,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',jsonb_array_length(r.snapshot->'titles'),
      'filename',case when r.snapshot->'profile'->>'bank'='077' then 'CI400_001_' else 'ITAU_TESTE_' end||lpad(r.sequence::text,7,'0')||'.REM') value
      from erp_cnab.remittance r where r.purpose='homologation' and p_kind='remittance' and (p_after is null or r.id>p_after)
    union all
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','return','state','ready','sequence',null,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',r.record_count-2,'filename','RETORNO_'||r.id::text||'.RET')
      from erp_cnab.return_file r where r.purpose='homologation' and p_kind='return' and (p_after is null or r.id>p_after)
  ), selected as (select * from entries order by id limit p_limit+1), numbered as(select *,row_number() over(order by id) rn from selected)
  select coalesce(jsonb_agg(value order by id) filter(where rn<=p_limit),'[]'),count(*)>p_limit,(array_agg(id order by id) filter(where rn<=p_limit))[least(p_limit,count(*)::integer)] into rows,more,cursor from numbered;
  return jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor else null end,'purpose','homologation','productionReady',false,'financialMutationPerformed',false);
end $$;

create or replace function public.erp_cnab_review(p_user_id uuid,p_file_id uuid,p_limit integer default 25,p_after integer default 1)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare f erp_cnab.return_file; items jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id); if p_limit is null or p_limit not between 1 and 100 or p_after is null or p_after<1 then raise exception 'erp_cnab_invalid_pagination' using errcode='22023'; end if;
  select * into f from erp_cnab.return_file where id=p_file_id and purpose='homologation'; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(x.dto order by x.line),'[]') into items from (select o.line,jsonb_build_object('line',o.line,'event_id',e.id,'event_hash',e.event_hash,
    'duplicate',o.duplicate,'billing_title_id',e.billing_title_id,'action',e.proposed_action,'reason',e.reason,'control',e.payload->>'control',
    'document_number',e.payload->>'documentNumber','our_number',e.payload->>'ourNumber','occurrence',e.payload->>'occurrence','kind',e.payload->>'kind',
    'amount_cents',e.payload->>'amountCents','paid_cents',e.payload->>'paidCents','occurrence_date',e.payload->>'occurrenceDate','credit_date',e.payload->>'creditDate','canSettle',false) dto
    from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=f.id and o.line>p_after order by o.line limit p_limit) x;
  more:=exists(select 1 from erp_cnab.return_occurrence where file_id=f.id and line>coalesce((items->-1->>'line')::integer,p_after));
  return jsonb_build_object('id',f.id,'profile_id',f.profile_id,'file_hash',f.file_hash,'warnings',f.warnings,'items',items,'has_more',more,
    'next_cursor',case when more then (items->-1->>'line')::integer else null end,'limit',p_limit,'canSettle',false,'productionReady',false,'financialMutationPerformed',false);
end $$;

create or replace function public.erp_cnab_return_context(p_user_id uuid,p_profile_id uuid,p_file_hash text,p_event_hashes text[],p_controls text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare p erp_cnab.profile; titles jsonb; begin
  perform erp_cnab.access(p_user_id,true);
  if exists(select 1 from erp_cnab.return_file where profile_id=p_profile_id and file_hash=p_file_hash and purpose<>'homologation')
   or exists(select 1 from erp_cnab.return_event where profile_id=p_profile_id and event_hash=any(p_event_hashes)and purpose<>'homologation')
   or exists(select 1 from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.profile_id=p_profile_id and b.control=any(p_controls)and r.purpose<>'homologation')
  then raise exception 'erp_cnab_purpose_mismatch'using errcode='40001';end if;
  if p_file_hash !~ '^[a-f0-9]{64}$' or cardinality(p_event_hashes)>10000 or cardinality(p_controls)>10000
    or exists(select 1 from unnest(p_event_hashes) h where h!~'^[a-f0-9]{64}$') then raise exception 'erp_cnab_context_invalid' using errcode='22023'; end if;
  select * into p from erp_cnab.profile where id=p_profile_id; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'accountScope',p.account_scope,'control',b.control,'documentNumber',b.document_number,
    'ourNumber',b.our_number,'status',case when t.cancelled then 'cancelled' when t.settled_cents=t.amount_cents then 'settled' else 'open' end,
    'amountCents',t.amount_cents::text,'outstandingCents',(t.amount_cents-t.settled_cents)::text,'dueDate',t.due_on) order by b.id),'[]') into titles
    from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id where b.profile_id=p.id and b.control=any(p_controls) and exists(select 1 from erp_cnab.remittance r where r.id=b.remittance_id and r.purpose='homologation');
  return jsonb_build_object('profile',erp_cnab.core_profile(p.id),'titles',titles,
    'seenFileHashes',(select coalesce(jsonb_agg(file_hash),'[]') from erp_cnab.return_file where profile_id=p.id and file_hash=p_file_hash),
    'seenEventHashes',(select coalesce(jsonb_agg(event_hash),'[]') from erp_cnab.return_event where profile_id=p.id and event_hash=any(p_event_hashes)));
end $$;

create or replace function public.erp_cnab_return_commit(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_file jsonb,p_events jsonb,p_decisions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; command jsonb; replay jsonb; f erp_cnab.return_file; row jsonb; decision jsonb; stored erp_cnab.return_event;
  payload jsonb; eid uuid; bill uuid; duplicate_event boolean; count_new integer:=0; count_duplicate integer:=0; position integer; n integer; hash text; line_hash text; line integer;
begin
  perform erp_cnab.access(p_user_id,true); perform erp_finance.keys(p_file,array['hash','size','path','generated_on','century','record_count','warnings','evidence']);
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_array_length(p_events)>9998
    or jsonb_array_length(p_events)<>jsonb_array_length(p_decisions) or octet_length(p_events::text)>16000000 or octet_length(p_decisions::text)>8000000 then raise exception 'erp_cnab_return_invalid' using errcode='22023'; end if;
  -- Derived review decisions change when a replay sees its own events. Identity is the immutable file and provenance.
  command:=jsonb_build_object('profile_id',p_profile_id,'file',p_file);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'return_commit',command); if replay is not null then return replay; end if;
  select * into p from erp_cnab.profile where id=p_profile_id for update; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if exists(select 1 from erp_cnab.return_file where profile_id=p.id and file_hash=p_file->>'hash'and purpose<>'homologation')
   or exists(select 1 from erp_cnab.return_event where profile_id=p.id and purpose<>'homologation'and event_hash in(select value->>'eventHash'from jsonb_array_elements(p_events)))
   or exists(select 1 from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.profile_id=p.id and r.purpose<>'homologation'and b.control in(select value->>'control'from jsonb_array_elements(p_events)))
  then raise exception 'erp_cnab_purpose_mismatch'using errcode='40001';end if;
  hash:=p_file->>'hash'; perform erp_cnab.storage_check(p.id,'returns',hash,(p_file->>'size')::integer,p_file->>'path');
  if jsonb_typeof(p_file->'warnings') is distinct from 'array' or jsonb_typeof(p_file->'evidence') is distinct from 'object'
    or (p_file->>'record_count')::integer<>jsonb_array_length(p_events)+2 or (p_file->>'century')::integer not in (1900,2000,2100) then raise exception 'erp_cnab_return_invalid' using errcode='22023'; end if;
  select * into f from erp_cnab.return_file where profile_id=p.id and file_hash=hash;
  if found then
    if f.byte_size<>(p_file->>'size')::integer or f.record_count<>(p_file->>'record_count')::integer then raise exception 'erp_cnab_file_conflict' using errcode='40001'; end if;
    return erp_cnab.finish_command(p_user_id,p_command_id,'return_commit',command,f.id,jsonb_build_object('id',f.id,'profile_id',p.id,'file_hash',hash,'duplicate_file',true,'new_events',0,'duplicate_events',jsonb_array_length(p_events),'canSettle',false));
  end if;
  insert into erp_cnab.return_file(profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor)
    values(p.id,hash,p_file->>'path',(p_file->>'size')::integer,erp_finance.day(p_file->'generated_on'),(p_file->>'century')::integer,(p_file->>'record_count')::integer,p_file->'warnings',p_file->'evidence',p_user_id) returning * into f;
  n:=jsonb_array_length(p_events);
  for position in 0..n-1 loop
    row:=p_events->position; decision:=p_decisions->position;
    perform erp_finance.keys(row,array['version','accountScope','bank','wallet','control','documentNumber','ourNumber','occurrence','kind','occurrenceDate','creditDate','dueDate','amountCents','paidCents','adjustments','operationNumber','rejection','settlementChannel','eventHash','lineHash','line','warnings']);
    perform erp_finance.keys(decision,array['eventHash','fileHash','lineHash','line','titleId','canSettle','action','reason']);
    if row->>'accountScope' is distinct from p.account_scope or row->>'bank' is distinct from p.identity->>'bank' or row->>'wallet' is distinct from p.identity->>'wallet'
      or coalesce(row->>'eventHash','')!~'^[a-f0-9]{64}$' or coalesce(row->>'lineHash','')!~'^[a-f0-9]{64}$'
      or decision->>'eventHash' is distinct from row->>'eventHash' or decision->>'lineHash' is distinct from row->>'lineHash' or decision->>'fileHash' is distinct from hash
      or decision->'line' is distinct from row->'line' or decision->'canSettle' is distinct from 'false'::jsonb
      or decision->>'action' not in ('REVIEW','SKIP','PROPOSE_BANK_NUMBER_BINDING_REVIEW','PROPOSE_SETTLEMENT_REVIEW')
      or coalesce(decision->>'reason','')!~'^[A-Z0-9_]{1,100}$' then raise exception 'erp_cnab_return_event_invalid' using errcode='22023'; end if;
    line:=(row->>'line')::integer; if line<>position+2 then raise exception 'erp_cnab_return_line_invalid' using errcode='22023'; end if;
    line_hash:=row->>'lineHash'; payload:=row-array['eventHash','lineHash','line'];
    select * into stored from erp_cnab.return_event where profile_id=p.id and event_hash=row->>'eventHash'; duplicate_event:=found;
    if duplicate_event then
      if stored.payload<>payload then raise exception 'erp_cnab_event_hash_conflict' using errcode='40001'; end if;
      eid:=stored.id; count_duplicate:=count_duplicate+1;
    else
      bill:=null;
      -- Persist an exact link only. A suggestion with different amount/date/number stays unlinked.
      select b.id into bill from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id
        where b.profile_id=p.id and b.control=row->>'control' and b.document_number=row->>'documentNumber'
          and t.amount_cents::text=row->>'amountCents' and t.due_on::text=row->>'dueDate'
          and (b.our_number=row->>'ourNumber' or (b.our_number is null and p.identity->>'bank'='077' and p.identity->>'wallet'='112' and row->>'kind'='REGISTERED'));
      if decision->>'titleId' is distinct from bill::text then bill:=null; end if;
      if bill is not null and decision->>'action'='PROPOSE_SETTLEMENT_REVIEW' and not exists(select 1 from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id where b.id=bill and not t.cancelled and t.settled_cents=0) then
        decision:=decision||jsonb_build_object('action','REVIEW','reason','FINANCIAL_STATE_CHANGED'); end if;
      insert into erp_cnab.return_event(profile_id,event_hash,payload,billing_title_id,proposed_action,reason)
        values(p.id,row->>'eventHash',payload,bill,case when bill is null then 'REVIEW' else decision->>'action' end,
          case when bill is null and decision->>'action' like 'PROPOSE_%' then 'EXACT_LINK_NOT_CONFIRMED' else decision->>'reason' end) returning id into eid;
      count_new:=count_new+1;
    end if;
    insert into erp_cnab.return_occurrence values(f.id,line,eid,line_hash,duplicate_event);
  end loop;
  return erp_cnab.finish_command(p_user_id,p_command_id,'return_commit',command,f.id,jsonb_build_object('id',f.id,'profile_id',p.id,'file_hash',hash,'duplicate_file',false,'new_events',count_new,'duplicate_events',count_duplicate,'canSettle',false));
end $$;

create or replace function erp_cnab.human_review_context(p_event_id uuid,p_file_id uuid,p_line integer)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e erp_cnab.return_event; o erp_cnab.return_occurrence; f erp_cnab.return_file; p erp_cnab.profile;
  b erp_cnab.billing_title; t erp_finance.title; a erp_finance.account; v_billing jsonb:=null; v_title jsonb:=null;
  v_link boolean; v_reference boolean; v_number boolean; v_amount boolean; v_due boolean; v_open boolean; v_paid boolean;
  v_adjust boolean; v_declared boolean; v_reason text;
begin
  select * into e from erp_cnab.return_event where id=p_event_id and purpose='homologation';
  select * into o from erp_cnab.return_occurrence where file_id=p_file_id and line=p_line and event_id=p_event_id;
  if e.id is null or o.event_id is null then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  select * into f from erp_cnab.return_file where id=o.file_id and profile_id=e.profile_id and purpose='homologation';
  select * into p from erp_cnab.profile where id=e.profile_id;
  select * into a from erp_finance.account where id=p.account_id;
  if f.id is null or p.id is null or a.id is null then raise exception 'erp_cnab_review_context_invalid' using errcode='40001'; end if;
  v_declared:=coalesce(f.evidence->>'source'='authenticated-bank-download' and f.evidence->>'fileHash'=f.file_hash
    and f.evidence->>'accountId'=p.account_id::text and f.evidence->>'referenceId' ~ '^[a-zA-Z0-9_-]{1,80}$',false);
  select * into b from erp_cnab.billing_title where id=e.billing_title_id and profile_id=p.id;
  select * into t from erp_finance.title where id=b.title_id;
  v_link:=b.id is not null and t.id is not null;
  v_adjust:=exists(select 1 from jsonb_each_text(case when jsonb_typeof(e.payload->'adjustments')='object' then e.payload->'adjustments' else '{}'::jsonb end) x where x.value<>'0');
  if v_link then
    v_billing:=jsonb_build_object('id',b.id,'remittance_id',b.remittance_id,
      'remittance_state',(select state from erp_cnab.remittance where id=b.remittance_id),
      'control',b.control,'document_number',b.document_number,'our_number',b.our_number);
    v_title:=jsonb_build_object('id',t.id,'version',t.version,'kind',t.kind,'description',t.description,
      'issued_on',t.issued_on,'due_on',t.due_on,'amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,
      'balance_cents',(t.amount_cents-t.settled_cents)::text,'cancelled',t.cancelled);
    v_reference:=b.control=e.payload->>'control' and b.document_number=e.payload->>'documentNumber';
    v_number:=coalesce(b.our_number=e.payload->>'ourNumber',false);
    v_amount:=t.amount_cents::text=e.payload->>'amountCents'; v_due:=t.due_on::text=e.payload->>'dueDate';
    v_open:=not t.cancelled and t.settled_cents=0;
    v_paid:=(t.amount_cents-t.settled_cents)::text=e.payload->>'paidCents';
  end if;
  v_reason:=case when not v_link then 'UNLINKED_EVENT'
    when not v_reference then 'REFERENCE_CHANGED'
    when b.our_number is null then 'BANK_NUMBER_UNBOUND'
    when not v_number then 'BANK_NUMBER_CHANGED'
    when not v_amount or not v_due then 'TITLE_AMOUNT_OR_DUE_DATE_CHANGED'
    when e.payload->>'kind'<>'PAID' then 'NON_PAYMENT_EVENT'
    when not v_open then 'TITLE_NOT_FULLY_OPEN'
    when e.payload->>'creditDate' is null or e.payload->>'occurrenceDate' is null then 'PAYMENT_DATES_MISSING'
    when not v_paid or v_adjust then 'PAYMENT_AMOUNTS_REQUIRE_REVIEW'
    when f.warnings ? 'INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION' then 'TRAILER_AGGREGATE_REQUIRES_REVIEW'
    when not v_declared then 'BANK_ORIGIN_DECLARATION_MISSING'
    when v_billing->>'remittance_state'<>'ready' then 'REMITTANCE_NOT_READY'
    when not a.active then 'ACCOUNT_INACTIVE'
    else 'EXACT_MATCH_HOMOLOGATION_ONLY' end;
  return jsonb_build_object('version',1,
    'event',jsonb_build_object('id',e.id,'hash',e.event_hash,'bank',e.payload->>'bank','wallet',e.payload->>'wallet',
      'control',e.payload->>'control','document_number',e.payload->>'documentNumber','our_number',e.payload->'ourNumber',
      'occurrence',e.payload->>'occurrence','kind',e.payload->>'kind','due_on',e.payload->'dueDate',
      'occurred_on',e.payload->'occurrenceDate','credited_on',e.payload->'creditDate',
      'amount_cents',e.payload->>'amountCents','paid_cents',e.payload->>'paidCents','adjustments',e.payload->'adjustments','warnings',e.payload->'warnings'),
    'occurrence',jsonb_build_object('file_id',f.id,'file_hash',f.file_hash,'line',o.line,'line_hash',o.line_hash,'duplicate',o.duplicate,
      'generated_on',f.generated_on,'declared_bank_origin',v_declared,'reference_id',case when v_declared then f.evidence->>'referenceId' else null end,'warnings',f.warnings),
    'profile',jsonb_build_object('id',p.id,'version',p.version,'bank',p.identity->>'bank','wallet',p.identity->>'wallet',
      'account_id',a.id,'account_name',a.name,'account_mask','***'||right(p.identity->>'account',3),'account_version',a.version,
      'account_active',a.active,'contract_verified',p.settings->'contractVerified','policy_verified',p.settings->'simpleCollectionPolicyVerified'),
    'billing',v_billing,'title',v_title,'proposal',jsonb_build_object('action',e.proposed_action,'reason',e.reason),
    'comparison',jsonb_build_object('source_linked',v_link,'reference_matches',v_reference,'bank_number_matches',v_number,
      'amount_matches',v_amount,'due_matches',v_due,'fully_open',v_open,'paid_matches_balance',v_paid,'has_adjustments',v_adjust,'reason',v_reason));
end $$;

create or replace function public.erp_cnab_human_review_list(p_user_id uuid,p_file_id uuid,p_limit integer default 25,p_after integer default 1)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare rows jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id);
  if p_limit is null or p_limit not between 1 and 100 or p_after is null or p_after not between 1 and 10000 then raise exception 'erp_cnab_review_pagination_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_cnab.return_file where id=p_file_id and purpose='homologation') then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(x.dto order by x.line),'[]') into rows from (
    select o.line,jsonb_build_object('line',o.line,'event_id',e.id,'event_hash',e.event_hash,'duplicate',o.duplicate,
      'kind',e.payload->>'kind','control',e.payload->>'control','document_number',e.payload->>'documentNumber',
      'amount_cents',e.payload->>'amountCents','paid_cents',e.payload->>'paidCents','review_version',coalesce(h.version,0),
      'review_status',coalesce(r.status,'pending'),'context_changed',case when r.event_id is null then false
        else r.context_hash<>erp_cnab.human_review_hash(erp_cnab.human_review_context(e.id,o.file_id,o.line)) end) dto
    from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id
    left join erp_cnab.human_review h on h.event_id=e.id left join erp_cnab.human_review_revision r on r.event_id=h.event_id and r.version=h.version
    where o.file_id=p_file_id and o.line>p_after order by o.line limit p_limit) x;
  more:=exists(select 1 from erp_cnab.return_occurrence where file_id=p_file_id and line>coalesce((rows->-1->>'line')::integer,p_after));
  return erp_cnab.human_review_safety()||jsonb_build_object('file_id',p_file_id,'items',rows,'limit',p_limit,'has_more',more,
    'next_cursor',case when more then (rows->-1->>'line')::integer else null end);
end $$;

create or replace function public.erp_cnab_human_review_history(p_user_id uuid,p_event_id uuid,p_limit integer default 25,p_before integer default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare rows jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id);
  if p_limit is null or p_limit not between 1 and 100 or (p_before is not null and p_before<1) then raise exception 'erp_cnab_review_pagination_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_cnab.return_event where id=p_event_id and purpose='homologation') then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(x.dto order by x.version desc),'[]') into rows from (
    select version,erp_cnab.human_review_revision_dto(p_event_id,version) dto from erp_cnab.human_review_revision
      where event_id=p_event_id and (p_before is null or version<p_before) order by version desc limit p_limit) x;
  more:=exists(select 1 from erp_cnab.human_review_revision where event_id=p_event_id and version<coalesce((rows->-1->>'version')::integer,p_before,2147483647));
  return erp_cnab.human_review_safety()||jsonb_build_object('event_id',p_event_id,'items',rows,'limit',p_limit,'has_more',more,
    'next_cursor',case when more then (rows->-1->>'version')::integer else null end);
end $$;

create or replace function public.erp_cnab_human_review_save(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,
  p_command_id uuid,p_expected_review_version integer,p_expected_context_hash text,p_status text,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare cmd jsonb; replay jsonb; e erp_cnab.return_event; profile_id uuid; b erp_cnab.billing_title; v integer;
  c jsonb; h text; f erp_cnab.return_file; result jsonb;
begin
  perform erp_cnab.access(p_user_id,true);
  if not exists(select 1 from erp_cnab.return_file where id=p_file_id and purpose='homologation')or not exists(select 1 from erp_cnab.return_event where id=p_event_id and purpose='homologation')then raise exception 'erp_cnab_review_not_found'using errcode='P0002';end if;
  if p_event_id is null or p_file_id is null or p_line is null or p_line not between 2 and 9999
    or p_expected_review_version is null or p_expected_review_version<0 or p_expected_review_version=2147483647
    or p_expected_context_hash is null or p_expected_context_hash !~ '^[a-f0-9]{64}$'
    or p_status is null or p_status not in ('confirmed','pending_issue') or p_reason is null
    or length(btrim(p_reason)) not between 3 and 1000 or p_reason ~ '[[:cntrl:]]' then
    raise exception 'erp_cnab_review_invalid' using errcode='22023'; end if;
  cmd:=jsonb_build_object('event_id',p_event_id,'file_id',p_file_id,'line',p_line,'expected_review_version',p_expected_review_version,
    'expected_context_hash',p_expected_context_hash,'status',p_status,'reason',p_reason);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'human_review',cmd); if replay is not null then return replay; end if;
  -- Same order as 014: command -> profile -> event. Never take a remittance lock after its profile.
  select e0.profile_id into profile_id from erp_cnab.return_event e0 where e0.id=p_event_id;
  if profile_id is null then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  perform 1 from erp_cnab.profile where id=profile_id for update;
  select * into e from erp_cnab.return_event where id=p_event_id for update;
  select version into v from erp_cnab.human_review where event_id=p_event_id for update;
  if coalesce(v,0)<>p_expected_review_version then raise exception 'erp_cnab_review_version_conflict' using errcode='40001'; end if;
  select * into b from erp_cnab.billing_title where id=e.billing_title_id for share;
  if b.id is not null then perform 1 from erp_finance.title where id=b.title_id for share; end if;
  perform 1 from erp_finance.account where id=(select account_id from erp_cnab.profile where id=profile_id) for share;
  -- Re-read after locks, closing the gap between private-file verification and this short transaction.
  c:=erp_cnab.human_review_context(p_event_id,p_file_id,p_line); h:=erp_cnab.human_review_hash(c);
  if h<>p_expected_context_hash then raise exception 'erp_cnab_review_context_changed' using errcode='40001'; end if;
  select * into f from erp_cnab.return_file where id=p_file_id;
  perform erp_cnab.storage_check(f.profile_id,'returns',f.file_hash,f.byte_size,f.object_path);
  v:=coalesce(v,0)+1;
  insert into erp_cnab.human_review_revision(event_id,version,status,reason,context_hash,context,actor,command_id)
    values(p_event_id,v,p_status,btrim(p_reason),h,c,p_user_id,p_command_id);
  insert into erp_cnab.human_review(event_id,version) values(p_event_id,v)
    on conflict(event_id) do update set version=excluded.version;
  result:=erp_cnab.human_review_safety()||jsonb_build_object('event_id',p_event_id,'record',erp_cnab.human_review_revision_dto(p_event_id,v));
  return erp_cnab.finish_command(p_user_id,p_command_id,'human_review',cmd,p_event_id,result);
end $$;

create function erp_cnab.operational_snapshot_check(p_id uuid)returns void language plpgsql stable set search_path=pg_catalog as $$declare r erp_cnab.remittance;c erp_company.identity;begin
 select * into r from erp_cnab.remittance where id=p_id and purpose='operational';select * into c from erp_company.identity where singleton;
 if r.id is null or r.snapshot->>'purpose'is distinct from 'operational'
  or r.snapshot->'operational_authorization'->>'profile_config_hash'is distinct from erp_cnab.operational_config_hash(r.profile_id)
  or r.snapshot->'operational_authorization'->>'identity_version'is distinct from c.version::text then raise exception 'erp_cnab_operational_snapshot_stale'using errcode='40001';end if;
end $$;
create function public.erp_cnab_operational_reservation(p_user_id uuid,p_id uuid,p_expected_approval integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id,true);select * into r from erp_cnab.remittance where id=p_id and purpose='operational';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
 a:=erp_cnab.require_operational(r.profile_id,p_expected_approval);perform erp_cnab.operational_snapshot_check(r.id);
 return erp_cnab.operational_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'snapshot',r.snapshot,'file_hash',r.file_hash,'object_path',r.object_path,'byte_size',r.byte_size,'approval_version',a->'approval_version');
end $$;
create function public.erp_cnab_operational_finalize(p_user_id uuid,p_command_id uuid,p_id uuid,p_hash text,p_size integer,p_path text,p_manifest jsonb,p_expected_approval integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; b erp_cnab.billing_title; row jsonb; command jsonb; replay jsonb; n text; pid uuid; approval jsonb; begin
  perform erp_cnab.access(p_user_id,true);
  if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
  command:=jsonb_build_object('id',p_id,'hash',p_hash,'size',p_size,'path',p_path,'manifest',p_manifest,'approval_version',p_expected_approval);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_finalize',command);
  select profile_id into pid from erp_cnab.remittance where id=p_id and purpose='operational';if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
  perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=pid for update;
  select * into r from erp_cnab.remittance where id=p_id and purpose='operational' for update;
  approval:=erp_cnab.require_operational(pid,p_expected_approval);
  perform erp_cnab.operational_snapshot_check(r.id);
  if replay is not null then return replay;end if;
  perform erp_cnab.storage_check(r.profile_id,'remittances',p_hash,p_size,p_path);
  if r.state='ready' then if r.file_hash<>p_hash or r.byte_size<>p_size or r.manifest<>p_manifest then raise exception 'erp_cnab_finalized_conflict' using errcode='40001'; end if;
  else
    select * into p from erp_cnab.profile where id=r.profile_id for share;
    if p.settings->'contractVerified' is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb
      or (p.identity->>'bank'='077' and p.identity->>'wallet'='110' and p.settings->'reservedRange'->'verified' is distinct from 'true'::jsonb)
      then raise exception 'erp_cnab_profile_unconfirmed' using errcode='40001'; end if;
    perform 1 from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id order by t.id for share of t;
    perform 1 from erp_catalog.record c where c.id in (select t.contact_id from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id) order by c.id for share;
    perform 1 from erp_finance.account where id=p.account_id and active and kind='bank' for share;
    if not found then raise exception 'erp_cnab_bank_account_required' using errcode='40001'; end if;
    if exists(select 1 from erp_cnab.billing_title bt join erp_finance.title t on t.id=bt.title_id join erp_catalog.record c on c.id=t.contact_id
      where bt.remittance_id=r.id and (t.version<>(bt.snapshot->>'finance_title_version')::integer or t.cancelled or t.settled_cents<>0
        or c.version<>(bt.snapshot->>'contact_version')::integer or not c.active)) then raise exception 'erp_cnab_snapshot_stale' using errcode='40001'; end if;
    if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)<>(select count(*) from erp_cnab.billing_title where remittance_id=r.id) then raise exception 'erp_cnab_manifest_invalid' using errcode='22023'; end if;
    if (select count(distinct value->>'titleId') from jsonb_array_elements(p_manifest))<>jsonb_array_length(p_manifest) then raise exception 'erp_cnab_manifest_duplicate' using errcode='22023'; end if;
    for row in select value from jsonb_array_elements(p_manifest) loop
      perform erp_finance.keys(row,array['titleId','control','documentNumber','amountCents','dueDate','ourNumber']);
      select * into b from erp_cnab.billing_title where id=erp_finance.uuid_value(row->'titleId') and remittance_id=r.id for update;
      if not found or row->>'control' is distinct from b.control or row->>'documentNumber' is distinct from b.document_number
        or row->>'amountCents' is distinct from b.snapshot->'title'->>'amountCents' or row->>'dueDate' is distinct from b.snapshot->'title'->>'dueOn' then raise exception 'erp_cnab_manifest_mismatch' using errcode='40001'; end if;
      n:=row->>'ourNumber'; if b.our_number_base is null then if n is not null then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      elsif n is null or n!~'^[0-9]+$' or length(n)<>length(b.our_number_base)+1 or left(n,length(b.our_number_base))<>b.our_number_base then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      update erp_cnab.billing_title set our_number=n where id=b.id;
    end loop;
    update erp_cnab.remittance set state='ready',object_path=p_path,file_hash=p_hash,byte_size=p_size,manifest=p_manifest,finalized_at=clock_timestamp() where id=r.id;
  end if;
  return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_finalize',command,r.id,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state','ready','sequence',r.sequence::text,'file_hash',p_hash,'byte_size',p_size));
end $$;
create function public.erp_cnab_operational_files(p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb; more boolean; cursor uuid; begin
  perform erp_cnab.access(p_user_id);
  if p_kind not in ('remittance','return') or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with entries as (
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','remittance','state',r.state,'sequence',r.sequence::text,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',jsonb_array_length(r.snapshot->'titles'),
      'filename',case when r.snapshot->'profile'->>'bank'='077' then 'CI400_001_' else 'ITAU_COBRANCA_' end||lpad(r.sequence::text,7,'0')||'.REM') value
      from erp_cnab.remittance r where r.purpose='operational' and p_kind='remittance' and (p_after is null or r.id>p_after)
    union all
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','return','state','ready','sequence',null,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',r.record_count-2,'filename','RETORNO_'||r.id::text||'.RET')
      from erp_cnab.return_file r where r.purpose='operational' and p_kind='return' and (p_after is null or r.id>p_after)
  ), selected as (select * from entries order by id limit p_limit+1), numbered as(select *,row_number() over(order by id) rn from selected)
  select coalesce(jsonb_agg(value order by id) filter(where rn<=p_limit),'[]'),count(*)>p_limit,(array_agg(id order by id) filter(where rn<=p_limit))[least(p_limit,count(*)::integer)] into rows,more,cursor from numbered;
  return erp_cnab.operational_safety()||jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor else null end);
end $$;
create function public.erp_cnab_operational_file(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id);select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and state='ready';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 a:=erp_cnab.require_operational(r.profile_id);perform erp_cnab.operational_snapshot_check(r.id);
 perform erp_cnab.storage_check(r.profile_id,'remittances',r.file_hash,r.byte_size,r.object_path);
 return erp_cnab.operational_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'hash',r.file_hash,'size',r.byte_size,'path',r.object_path,'approval_version',a->'approval_version',
 'filename',case when r.snapshot->'profile'->>'bank'='077'then'CI400_001_'else'ITAU_COBRANCA_'end||lpad(r.sequence::text,7,'0')||'.REM');
end $$;
revoke all on all functions in schema erp_cnab from public,anon,authenticated,service_role;
do $$declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like 'erp_cnab_operational_%'loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
end loop;end $$;
commit;

