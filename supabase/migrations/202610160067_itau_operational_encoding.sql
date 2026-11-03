-- Explicit Itaú encoding profiles; no existing approval or remittance is promoted.
begin;
create table erp_cnab.operational_encoding_revision(
 profile_id uuid not null,approval_version integer not null,
 allowed_encoding_profiles text[] not null,
 compatibility_confirmed boolean not null,permanent_instructions_acknowledged boolean not null,
 policy_hash text not null check(policy_hash~'^[a-f0-9]{64}$'),
 primary key(profile_id,approval_version),
 foreign key(profile_id,approval_version)references erp_cnab.operational_approval_revision(profile_id,version),
 check(allowed_encoding_profiles <@ ARRAY['itau109-no-charges-v1','itau109-origin-observed-v1']::text[])
);
alter table erp_cnab.operational_encoding_revision enable row level security;
revoke all on erp_cnab.operational_encoding_revision from public,anon,authenticated,service_role;
create trigger operational_encoding_revision_immutable before update or delete on erp_cnab.operational_encoding_revision for each row execute function erp_cnab.operational_revision_immutable();
create function erp_cnab.encoding_safety()returns jsonb language sql immutable set search_path=pg_catalog as $$
 select erp_cnab.operational_safety()||jsonb_build_object('contract','itau109-operational-v2');
$$;
create function erp_cnab.operational_status_base_067(p_id uuid) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
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

create function erp_cnab.encoding_status(p_id uuid,p_encoding text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb;p erp_cnab.profile;r erp_cnab.operational_encoding_revision;issues jsonb;begin
 if p_encoding is null or p_encoding not in('itau109-no-charges-v1','itau109-origin-observed-v1')then raise exception 'erp_cnab_encoding_invalid'using errcode='22023';end if;
 s:=erp_cnab.operational_status_base_067(p_id);select * into p from erp_cnab.profile where id=p_id;
 select * into r from erp_cnab.operational_encoding_revision where profile_id=p_id and approval_version=(s->>'approval_version')::integer;
 issues:=s->'issues';
 if p_encoding='itau109-origin-observed-v1' and p.settings->'contractVerified'='true'::jsonb and p.identity->>'bank'='341'and p.identity->>'wallet'='109'then
  select coalesce(jsonb_agg(value),'[]')into issues from jsonb_array_elements(issues)where value<>'"BANK_CONTRACT_OR_POLICY_PENDING"'::jsonb;
 end if;
 if (r.profile_id is null and p_encoding<>'itau109-no-charges-v1')or(r.profile_id is not null and not p_encoding=any(r.allowed_encoding_profiles))then
  if not issues?'BANK_CONTRACT_OR_POLICY_PENDING'then issues:=issues||'"BANK_CONTRACT_OR_POLICY_PENDING"'::jsonb;end if;
 end if;
 return s||jsonb_build_object('issues',issues,'effective_enabled',jsonb_array_length(issues)=0);
end $$;
create or replace function erp_cnab.operational_status(p_id uuid)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_cnab.encoding_status(p_id,'itau109-no-charges-v1');
$$;
create function erp_cnab.encoding_approval(p_id uuid)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare s jsonb;r erp_cnab.operational_encoding_revision;allowed text[];begin
 s:=erp_cnab.operational_status_base_067(p_id);
 select * into r from erp_cnab.operational_encoding_revision where profile_id=p_id and approval_version=(s->>'approval_version')::integer;
 allowed:=case when r.profile_id is null then ARRAY['itau109-no-charges-v1']else r.allowed_encoding_profiles end;
 s:=erp_cnab.encoding_status(p_id,case when 'itau109-origin-observed-v1'=any(allowed)then'itau109-origin-observed-v1'else'itau109-no-charges-v1'end);
 return s||jsonb_build_object('allowed_encoding_profiles',allowed,'encoding_policy',case when r.profile_id is not null then jsonb_build_object('policy_hash',r.policy_hash,'compatibility_confirmed',r.compatibility_confirmed,'permanent_instructions_acknowledged',r.permanent_instructions_acknowledged)end);
end $$;
create function erp_cnab.require_operational_for_encoding(p_id uuid,p_expected integer,p_encoding text)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare s jsonb;begin
 s:=erp_cnab.encoding_status(p_id,p_encoding);
 if s->'effective_enabled'is distinct from'true'::jsonb or(p_expected is not null and(s->>'approval_version')::integer<>p_expected)then raise exception 'erp_cnab_operational_approval_required'using errcode='40001';end if;return s;
end $$;
create function erp_cnab.encoding_authorization(p_id uuid,p_version integer)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare r erp_cnab.operational_encoding_revision;a erp_cnab.operational_approval_revision;begin
 select * into a from erp_cnab.operational_approval_revision where profile_id=p_id and version=p_version;
 if not found then raise exception 'erp_cnab_operational_approval_required'using errcode='40001';end if;
 select * into r from erp_cnab.operational_encoding_revision where profile_id=p_id and approval_version=p_version;
 return jsonb_build_object('approval_version',a.version,'policy_hash',coalesce(r.policy_hash,encode(sha256(convert_to(jsonb_build_object('legacy_approval',a.profile_id,'version',a.version,'config',a.profile_config_hash)::text,'UTF8')),'hex')),
  'reference',a.reference,'confirmed_on',a.confirmed_on,'compatibility_confirmed',coalesce(r.compatibility_confirmed,false),'permanent_instructions_acknowledged',coalesce(r.permanent_instructions_acknowledged,false));
end $$;
create function erp_cnab.encoding_terms(p_amount bigint,p_due date,p_zero boolean)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$declare daily bigint;begin
 if p_amount is null or p_amount not between 1 and 9999999999999 or p_due is null or p_due not between date'2000-01-01'and date'2099-12-30'or p_zero is null then raise exception 'erp_cnab_encoding_terms_invalid'using errcode='22023';end if;
 daily:=(p_amount+1500)/3000;
 if daily>0 and p_zero then raise exception 'erp_cnab_zero_confirmation_not_applicable'using errcode='22023';end if;
 return jsonb_build_object('profile','itau109-origin-observed-v1','version',1,'dailyInterestCents',daily::text,'interestDateField',p_due,'penaltyPercentHundredths','200','penaltyDateField',p_due+1,'zeroDailyInterestConfirmed',p_zero);
end $$;
create function erp_cnab.encoding_access(p_actor uuid,p_admin boolean default false)returns void language plpgsql set search_path=pg_catalog as $$declare r erp_access.membership;begin
 select * into r from erp_access.membership where user_id=p_actor for share;
 if not found or not r.active or r.role not in('admin','financeiro')or(p_admin and r.role<>'admin')then raise exception 'erp_cnab_access_denied'using errcode='42501';end if;
end $$;
create function erp_cnab.encoding_snapshot_check(p_id uuid)returns void language plpgsql stable set search_path=pg_catalog as $$
declare r erp_cnab.remittance;e text;v integer;a jsonb;t jsonb;b erp_cnab.billing_title;allowed text[];begin
 perform erp_cnab.operational_snapshot_check(p_id);select * into r from erp_cnab.remittance where id=p_id;
 e:=r.snapshot->>'encoding_profile';
 if e is null or e not in('itau109-no-charges-v1','itau109-origin-observed-v1')or jsonb_typeof(r.snapshot->'titles')is distinct from'array'
  or jsonb_array_length(r.snapshot->'titles')not between 1 and 30
  or r.snapshot->'profile'is distinct from erp_cnab.core_profile(r.profile_id)
  or r.snapshot->>'generatedOn'is distinct from r.generated_on::text or r.snapshot->>'remittanceSequence'is distinct from r.sequence::text then raise exception 'erp_cnab_encoding_snapshot_invalid'using errcode='40001';end if;
 v:=(r.snapshot#>>'{operational_authorization,approval_version}')::integer;a:=erp_cnab.encoding_authorization(r.profile_id,v);
 select allowed_encoding_profiles into allowed from erp_cnab.operational_encoding_revision where profile_id=r.profile_id and approval_version=v;
 if r.snapshot->'encoding_authorization'is distinct from a or not e=any(coalesce(allowed,ARRAY['itau109-no-charges-v1']))
  or(e='itau109-origin-observed-v1'and(a->'compatibility_confirmed'is distinct from'true'::jsonb or a->'permanent_instructions_acknowledged'is distinct from'true'::jsonb))
  or(select count(*)from erp_cnab.billing_title where remittance_id=r.id)<>jsonb_array_length(r.snapshot->'titles')then raise exception 'erp_cnab_encoding_snapshot_invalid'using errcode='40001';end if;
 for t in select value from jsonb_array_elements(r.snapshot->'titles')loop
  select * into b from erp_cnab.billing_title where id=(t->>'id')::uuid and remittance_id=r.id;
  if not found or b.snapshot->'title'is distinct from t then raise exception 'erp_cnab_encoding_snapshot_invalid'using errcode='40001';end if;
  if e='itau109-origin-observed-v1'then
   if t->'encodingTerms'is distinct from erp_cnab.encoding_terms((t->>'amountCents')::bigint,(t->>'dueOn')::date,(t#>>'{encodingTerms,zeroDailyInterestConfirmed}')::boolean)
    or(t#>>'{encodingTerms,dailyInterestCents}'='0'and t#>'{encodingTerms,zeroDailyInterestConfirmed}'is distinct from'true'::jsonb)then raise exception 'erp_cnab_encoding_terms_mismatch'using errcode='40001';end if;
  elsif t?'encodingTerms'or t?'collectionTerms'then raise exception 'erp_cnab_encoding_terms_mismatch'using errcode='40001';end if;
 end loop;
end $$;
create function erp_cnab.itau_number(p_profile jsonb,p_base text)returns text language plpgsql immutable set search_path=pg_catalog as $$
declare value text;total integer:=0;n integer;factor integer:=2;i integer;begin
 value:=p_profile->>'agency'||(p_profile->>'account')||(p_profile->>'wallet')||p_base;
 if value is null or value!~'^[0-9]{20}$'then raise exception 'erp_cnab_number_invalid'using errcode='22023';end if;
 for i in reverse length(value)..1 loop n:=substr(value,i,1)::integer*factor;total:=total+n/10+n%10;factor:=3-factor;end loop;
 return p_base||((10-total%10)%10)::text;
end $$;
create function public.erp_cnab_operational_profiles_v2(p_user_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_cnab.access(p_user_id);return erp_cnab.encoding_safety()||jsonb_build_object('items',(select coalesce(jsonb_agg(jsonb_build_object('profile',erp_cnab.profile_dto(id)-array['purpose','productionReady'],'approval',erp_cnab.encoding_approval(id))order by id),'[]')from erp_cnab.profile where identity->>'bank'='341'and identity->>'wallet'='109'));
end $$;
create function public.erp_cnab_operational_approve_v2(p_user_id uuid,p_profile_id uuid,p_command_id uuid,p_expected_approval integer,p_expected_profile integer,p_expected_identity integer,p_enabled boolean,p_confirmed_on date,p_reference text,p_allowed_encoding_profiles text[],p_compatibility_confirmed boolean,p_permanent_instructions_acknowledged boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare p erp_cnab.profile;c erp_company.identity;v integer;cmd jsonb;replay jsonb;s jsonb;begin
 perform erp_cnab.access(p_user_id,true,true);
 if p_profile_id is null or p_expected_approval is null or p_expected_approval not between 0 and 2147483646 or p_expected_profile is null or p_expected_profile<1 or p_enabled is null
  or p_confirmed_on is null or p_confirmed_on not between date'2000-01-01'and(clock_timestamp()at time zone'America/Sao_Paulo')::date
  or p_reference is null or length(btrim(p_reference))not between 3 and 200 or p_reference~'[[:cntrl:]]'
  or length(btrim(p_reference,U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0 then raise exception 'erp_cnab_operational_approval_invalid'using errcode='22023';end if;
 if p_allowed_encoding_profiles is null or cardinality(p_allowed_encoding_profiles)>2 or array_position(p_allowed_encoding_profiles,null)is not null
  or(p_enabled and cardinality(p_allowed_encoding_profiles)=0)or(not p_enabled and cardinality(p_allowed_encoding_profiles)<>0)
  or not p_allowed_encoding_profiles <@ ARRAY['itau109-no-charges-v1','itau109-origin-observed-v1']::text[]
  or(select count(distinct x)from unnest(p_allowed_encoding_profiles)x)<>cardinality(p_allowed_encoding_profiles)
  or p_compatibility_confirmed is null or p_permanent_instructions_acknowledged is null
  or p_compatibility_confirmed is distinct from ('itau109-origin-observed-v1'=any(p_allowed_encoding_profiles))
  or p_permanent_instructions_acknowledged is distinct from p_compatibility_confirmed then raise exception 'erp_cnab_encoding_confirmation_required'using errcode='22023';end if;
 cmd:=jsonb_build_object('profile_id',p_profile_id,'approval_version',p_expected_approval,'profile_version',p_expected_profile,'identity_version',p_expected_identity,'enabled',p_enabled,'confirmed_on',p_confirmed_on,'reference',p_reference,'allowed_encoding_profiles',p_allowed_encoding_profiles,'compatibility_confirmed',p_compatibility_confirmed,'permanent_instructions_acknowledged',p_permanent_instructions_acknowledged);
 replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_approve_v2',cmd);perform erp_cnab.encoding_access(p_user_id,true);if replay is not null then return replay;end if;
 perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=p_profile_id for update;
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 if p.identity->>'bank'<>'341'or p.identity->>'wallet'<>'109'then raise exception 'erp_cnab_encoding_profile_unsupported'using errcode='22023';end if;
 select * into c from erp_company.identity where singleton;select version into v from erp_cnab.operational_approval where profile_id=p_profile_id for update;
 if coalesce(v,0)<>p_expected_approval or p.version<>p_expected_profile or c.version is distinct from p_expected_identity then raise exception 'erp_cnab_operational_version_conflict'using errcode='40001';end if;
 perform 1 from erp_finance.account where id=p.account_id for share;
 if p_enabled and(c.singleton is null or c.data->>'cnpj'is distinct from p.identity->>'cnpj'
  or not exists(select 1 from erp_finance.account where id=p.account_id and active and kind='bank')
  or p.settings->'contractVerified'is distinct from 'true'::jsonb or('itau109-no-charges-v1'=any(p_allowed_encoding_profiles)and p.settings->'simpleCollectionPolicyVerified'is distinct from 'true'::jsonb)
  or(p.identity->>'bank'='077'and p.identity->>'wallet'='110'and p.settings->'reservedRange'->'verified'is distinct from 'true'::jsonb))then raise exception 'erp_cnab_operational_prerequisites'using errcode='40001';end if;
 v:=coalesce(v,0)+1;perform erp_cnab.encoding_access(p_user_id,true);insert into erp_cnab.operational_approval_revision(profile_id,version,enabled,profile_config_hash,profile_version,identity_version,company_cnpj,reference,confirmed_on,actor,command_id)
  values(p.id,v,p_enabled,erp_cnab.operational_config_hash(p.id),p.version,c.version,c.data->>'cnpj',btrim(p_reference),p_confirmed_on,p_user_id,p_command_id);
 insert into erp_cnab.operational_approval values(p.id,v)on conflict(profile_id)do update set version=excluded.version;
 insert into erp_cnab.operational_encoding_revision values(p.id,v,p_allowed_encoding_profiles,p_compatibility_confirmed,p_permanent_instructions_acknowledged,
  encode(sha256(convert_to(jsonb_build_object('profile_id',p.id,'approval_version',v,'allowed_encoding_profiles',p_allowed_encoding_profiles,'compatibility_confirmed',p_compatibility_confirmed,'permanent_instructions_acknowledged',p_permanent_instructions_acknowledged,'reference',btrim(p_reference),'confirmed_on',p_confirmed_on)::text,'UTF8')),'hex'));
 return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_approve_v2',cmd,p.id,erp_cnab.encoding_safety()||jsonb_build_object('profile_id',p.id,'approval',erp_cnab.encoding_approval(p.id)));
end $$;
create function public.erp_cnab_operational_reserve_v2(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_version integer,p_generated_on date,p_titles jsonb,p_preview boolean,p_expected_approval integer,p_preview_hash text,p_encoding_profile text,p_confirm_encoding_profile boolean,p_zero_daily_title_ids uuid[],p_confirm_operational boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; t erp_finance.title; c record; row jsonb; input_title jsonb; payer jsonb; snap jsonb; result_titles jsonb:='[]'; rid uuid; bid uuid; base text; control text; doc text; sequence bigint; replay jsonb; command jsonb; days integer; approval jsonb; proofs jsonb:='[]';preview_hash text; p_purpose constant text:='operational';pending jsonb:='[]';encoding_authorization jsonb;terms jsonb;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_encoding_profile is null or p_encoding_profile not in('itau109-no-charges-v1','itau109-origin-observed-v1')or p_expected_approval is null or p_expected_approval<1
   or p_confirm_encoding_profile is null or p_confirm_operational is null or p_zero_daily_title_ids is null or cardinality(p_zero_daily_title_ids)>30 or array_position(p_zero_daily_title_ids,null)is not null
   or(select count(distinct x)from unnest(p_zero_daily_title_ids)x)<>cardinality(p_zero_daily_title_ids)
   or(p_encoding_profile='itau109-no-charges-v1'and cardinality(p_zero_daily_title_ids)>0)
   or(p_preview and(p_confirm_encoding_profile or p_confirm_operational or p_preview_hash is not null))
   or(not p_preview and(not p_confirm_encoding_profile or not p_confirm_operational or p_preview_hash is null or p_preview_hash!~'^[a-f0-9]{64}$'))then raise exception 'erp_cnab_encoding_confirmation_required'using errcode='22023';end if;
  if p_preview is null then raise exception 'erp_cnab_preview_required' using errcode='22023'; end if;
  command:=jsonb_build_object('profile_id',p_profile_id,'version',p_expected_version,'generated_on',p_generated_on,'titles',p_titles);
  if p_purpose='operational' then command:=command||jsonb_build_object('purpose',p_purpose,'approval_version',p_expected_approval,'preview_hash',p_preview_hash,'encoding_profile',p_encoding_profile,'zero_daily_title_ids',p_zero_daily_title_ids); end if;
  if not p_preview then replay:=erp_cnab.start_command(p_user_id,p_command_id,case when p_purpose='operational' then 'operational_reserve_v2' else 'reserve' end,command); if replay is not null and p_purpose='homologation' then return replay; end if; end if;
  if p_purpose='operational' then perform pg_advisory_xact_lock(174852920,1); end if;
  if jsonb_typeof(p_titles) is distinct from 'array' or jsonb_array_length(p_titles) not between 1 and 30 or octet_length(p_titles::text)>65536
    or p_generated_on is null or p_generated_on not between date '2000-01-01' and (clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_cnab_invalid_reservation' using errcode='22023'; end if;
  if(select count(distinct erp_finance.uuid_value(value->'title_id'))from jsonb_array_elements(p_titles))<>jsonb_array_length(p_titles)then raise exception 'erp_cnab_duplicate_title'using errcode='22023';end if;
  select * into p from erp_cnab.profile where id=p_profile_id for update;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if p_purpose='operational' then perform erp_cnab.encoding_access(p_user_id);approval:=erp_cnab.require_operational_for_encoding(p.id,p_expected_approval,p_encoding_profile);encoding_authorization:=erp_cnab.encoding_authorization(p.id,p_expected_approval);if replay is not null then return replay;end if;
    if p_generated_on<>(clock_timestamp()at time zone'America/Sao_Paulo')::date then raise exception 'erp_cnab_operational_generation_date'using errcode='22023';end if;
  end if;
  if p.identity->>'bank'<>'341'or p.identity->>'wallet'<>'109'then raise exception 'erp_cnab_encoding_profile_unsupported'using errcode='22023';end if;
  if exists(select 1 from unnest(p_zero_daily_title_ids)x where not exists(select 1 from jsonb_array_elements(p_titles)y where y->>'title_id'=x::text))then raise exception 'erp_cnab_zero_confirmation_invalid'using errcode='22023';end if;
  if p.version is distinct from p_expected_version then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
  if p.settings->'contractVerified' is distinct from 'true'::jsonb or (p_encoding_profile='itau109-no-charges-v1'and p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb)
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
  perform erp_cnab.encoding_access(p_user_id);
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
    if p_encoding_profile='itau109-origin-observed-v1'then
      terms:=erp_cnab.encoding_terms(t.amount_cents,t.due_on,t.id=any(p_zero_daily_title_ids));input_title:=input_title||jsonb_build_object('encodingTerms',terms);
      if terms->>'dailyInterestCents'='0'and not t.id=any(p_zero_daily_title_ids)then pending:=pending||jsonb_build_array(jsonb_build_object('code','ZERO_DAILY_FIELD_UNCONFIRMED','title_id',t.id));end if;
    end if;
    snap:=jsonb_build_object('title',input_title,'finance_title_version',t.version,'contact_version',c.version,'finance_title_id',t.id);
    proofs:=proofs||jsonb_build_array(snap||jsonb_build_object('contact_id',t.contact_id,'title',input_title-array['id','control']));
    if exists(select 1 from erp_cnab.billing_title where profile_id=p.id and document_number=doc) then raise exception 'erp_cnab_document_number_used' using errcode='40001'; end if;
    if not p_preview then insert into erp_cnab.billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number_base,snapshot) values(bid,t.id,p.id,rid,control,doc,base,snap); end if;
    result_titles:=result_titles||jsonb_build_array(input_title);
  end loop;
  snap:=jsonb_build_object('profile',erp_cnab.core_profile(p.id),'titles',result_titles,'generatedOn',p_generated_on,'remittanceSequence',sequence::text,'purpose',p_purpose,'encoding_profile',p_encoding_profile,'encoding_authorization',encoding_authorization);
  if p_purpose='operational' then
    snap:=snap||jsonb_build_object('operational_authorization',jsonb_build_object('approval_version',p_expected_approval,'profile_config_hash',erp_cnab.operational_config_hash(p.id),'identity_version',approval->'identity_version'));
    preview_hash:=encode(sha256(convert_to(jsonb_build_object('profile_id',p.id,'profile_version',p.version,'profile',snap->'profile','sequence',sequence::text,'generated_on',p_generated_on,'approval',snap->'operational_authorization','encoding_profile',p_encoding_profile,'encoding_authorization',encoding_authorization,'titles',proofs)::text,'UTF8')),'hex');
    if not p_preview and preview_hash is distinct from p_preview_hash then raise exception 'erp_cnab_operational_preview_changed'using errcode='40001';end if;
    snap:=snap||jsonb_build_object('preview_hash',preview_hash);
  end if;
  if not p_preview and jsonb_array_length(pending)>0 then raise exception 'erp_cnab_zero_confirmation_required'using errcode='22023';end if;
  if p_preview then return erp_cnab.encoding_safety()||jsonb_build_object('snapshot',snap,'profile_id',p.id,'profile_version',p.version,'preview',true,'preview_hash',preview_hash,'preview_items',proofs,'encoding_profile',p_encoding_profile,'can_reserve',jsonb_array_length(pending)=0,'pending',pending); end if;
  update erp_cnab.remittance set snapshot=snap where id=rid;
  update erp_cnab.profile set next_sequence=sequence+1,next_our_number=p.next_our_number,version=version+1,updated_at=clock_timestamp() where id=p.id;
  if p_purpose='operational' then return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_reserve_v2',command,rid,erp_cnab.encoding_safety()||jsonb_build_object('id',rid,'profile_id',p.id,'sequence',sequence::text,'state','reserved','encoding_profile',p_encoding_profile,'approval_version',p_expected_approval));end if;
  return erp_cnab.finish_command(p_user_id,p_command_id,'reserve',command,rid,erp_cnab.encoding_safety()||jsonb_build_object('id',rid,'profile_id',p.id,'sequence',sequence::text,'state','reserved','encoding_profile',p_encoding_profile,'approval_version',p_expected_approval));
end $$;
create function public.erp_cnab_operational_reservation_v2(p_user_id uuid,p_id uuid,p_expected_approval integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id,true);select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and snapshot?'encoding_profile';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
 a:=erp_cnab.require_operational_for_encoding(r.profile_id,p_expected_approval,r.snapshot->>'encoding_profile');perform erp_cnab.encoding_snapshot_check(r.id);
 return erp_cnab.encoding_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'snapshot',r.snapshot,'file_hash',r.file_hash,'object_path',r.object_path,'byte_size',r.byte_size,'approval_version',a->'approval_version','encoding_profile',r.snapshot->'encoding_profile');
end $$;
create function public.erp_cnab_operational_finalize_v2(p_user_id uuid,p_command_id uuid,p_id uuid,p_hash text,p_size integer,p_path text,p_manifest jsonb,p_expected_approval integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; b erp_cnab.billing_title; row jsonb; command jsonb; replay jsonb; n text; pid uuid; approval jsonb; begin
  perform erp_cnab.access(p_user_id,true);
  if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
  command:=jsonb_build_object('id',p_id,'hash',p_hash,'size',p_size,'path',p_path,'manifest',p_manifest,'approval_version',p_expected_approval);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_finalize_v2',command);
  select profile_id into pid from erp_cnab.remittance where id=p_id and purpose='operational'and snapshot?'encoding_profile';if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
  perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=pid for update;
  select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and snapshot?'encoding_profile' for update;
  perform erp_cnab.encoding_access(p_user_id);approval:=erp_cnab.require_operational_for_encoding(pid,p_expected_approval,r.snapshot->>'encoding_profile');
  perform erp_cnab.encoding_snapshot_check(r.id);
  if replay is not null then return replay;end if;
  perform erp_cnab.storage_check(r.profile_id,'remittances',p_hash,p_size,p_path);
  if r.state='ready' then if r.file_hash<>p_hash or r.byte_size<>p_size or r.manifest<>p_manifest then raise exception 'erp_cnab_finalized_conflict' using errcode='40001'; end if;
  else
    select * into p from erp_cnab.profile where id=r.profile_id for share;
    if p.settings->'contractVerified' is distinct from 'true'::jsonb or (r.snapshot->>'encoding_profile'='itau109-no-charges-v1'and p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb)
      or (p.identity->>'bank'='077' and p.identity->>'wallet'='110' and p.settings->'reservedRange'->'verified' is distinct from 'true'::jsonb)
      then raise exception 'erp_cnab_profile_unconfirmed' using errcode='40001'; end if;
    perform 1 from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id order by t.id for share of t;
    perform 1 from erp_catalog.record c where c.id in (select t.contact_id from erp_finance.title t join erp_cnab.billing_title bt on bt.title_id=t.id where bt.remittance_id=r.id) order by c.id for share;
    perform 1 from erp_finance.account where id=p.account_id and active and kind='bank' for share;
    if not found then raise exception 'erp_cnab_bank_account_required' using errcode='40001'; end if;
  perform erp_cnab.encoding_access(p_user_id);
    if exists(select 1 from erp_cnab.billing_title bt join erp_finance.title t on t.id=bt.title_id join erp_catalog.record c on c.id=t.contact_id
      where bt.remittance_id=r.id and (t.version<>(bt.snapshot->>'finance_title_version')::integer or t.cancelled or t.settled_cents<>0
        or c.version<>(bt.snapshot->>'contact_version')::integer or not c.active)) then raise exception 'erp_cnab_snapshot_stale' using errcode='40001'; end if;
    if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)<>(select count(*) from erp_cnab.billing_title where remittance_id=r.id) then raise exception 'erp_cnab_manifest_invalid' using errcode='22023'; end if;
    if (select count(distinct value->>'titleId') from jsonb_array_elements(p_manifest))<>jsonb_array_length(p_manifest) then raise exception 'erp_cnab_manifest_duplicate' using errcode='22023'; end if;
    for row in select value from jsonb_array_elements(p_manifest) loop
      perform erp_finance.keys(row,case when r.snapshot->>'encoding_profile'='itau109-origin-observed-v1'then array['titleId','control','documentNumber','amountCents','dueDate','ourNumber','encodingTerms']else array['titleId','control','documentNumber','amountCents','dueDate','ourNumber']end);
      select * into b from erp_cnab.billing_title where id=erp_finance.uuid_value(row->'titleId') and remittance_id=r.id for update;
      if not found or row->>'control' is distinct from b.control or row->>'documentNumber' is distinct from b.document_number
        or row->>'amountCents' is distinct from b.snapshot->'title'->>'amountCents' or row->>'dueDate' is distinct from b.snapshot->'title'->>'dueOn' then raise exception 'erp_cnab_manifest_mismatch' using errcode='40001'; end if;
      if r.snapshot->>'encoding_profile'='itau109-origin-observed-v1'then
       if row->'encodingTerms'is distinct from b.snapshot#>'{title,encodingTerms}'or row->'encodingTerms'is distinct from erp_cnab.encoding_terms((b.snapshot#>>'{title,amountCents}')::bigint,(b.snapshot#>>'{title,dueOn}')::date,(b.snapshot#>>'{title,encodingTerms,zeroDailyInterestConfirmed}')::boolean)
        or(row#>>'{encodingTerms,dailyInterestCents}'='0'and row#>'{encodingTerms,zeroDailyInterestConfirmed}'is distinct from'true'::jsonb)then raise exception 'erp_cnab_encoding_terms_mismatch'using errcode='40001';end if;
      end if;
      if jsonb_typeof(row->'titleId')is distinct from'string'or jsonb_typeof(row->'control')is distinct from'string'or jsonb_typeof(row->'documentNumber')is distinct from'string'or jsonb_typeof(row->'amountCents')is distinct from'string'or jsonb_typeof(row->'dueDate')is distinct from'string'or jsonb_typeof(row->'ourNumber')is distinct from'string' or row->>'ourNumber'is distinct from erp_cnab.itau_number(r.snapshot->'profile',b.our_number_base)then raise exception 'erp_cnab_manifest_mismatch'using errcode='40001';end if;
      n:=row->>'ourNumber'; if b.our_number_base is null then if n is not null then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      elsif n is null or n!~'^[0-9]+$' or length(n)<>length(b.our_number_base)+1 or left(n,length(b.our_number_base))<>b.our_number_base then raise exception 'erp_cnab_manifest_number' using errcode='40001'; end if;
      update erp_cnab.billing_title set our_number=n where id=b.id;
    end loop;
    update erp_cnab.remittance set state='ready',object_path=p_path,file_hash=p_hash,byte_size=p_size,manifest=p_manifest,finalized_at=clock_timestamp() where id=r.id;
  end if;
  return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_finalize_v2',command,r.id,erp_cnab.encoding_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state','ready','sequence',r.sequence::text,'file_hash',p_hash,'byte_size',p_size,'encoding_profile',r.snapshot->'encoding_profile','approval_version',p_expected_approval));
end $$;
create function public.erp_cnab_operational_file_v2(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id);select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and state='ready'and snapshot?'encoding_profile';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 a:=erp_cnab.require_operational_for_encoding(r.profile_id,null,r.snapshot->>'encoding_profile');perform erp_cnab.encoding_snapshot_check(r.id);
 perform erp_cnab.storage_check(r.profile_id,'remittances',r.file_hash,r.byte_size,r.object_path);
 return erp_cnab.encoding_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'hash',r.file_hash,'size',r.byte_size,'path',r.object_path,'approval_version',a->'approval_version','encoding_profile',r.snapshot->'encoding_profile',
 'filename',case when r.snapshot->'profile'->>'bank'='077'then'CI400_001_'else'ITAU_COBRANCA_'end||lpad(r.sequence::text,7,'0')||'.REM');
end $$;

create function public.erp_cnab_operational_command_v2(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare c erp_cnab.command;r erp_cnab.remittance;begin
 perform erp_cnab.access(p_user_id);select * into c from erp_cnab.command where id=p_command_id and actor=p_user_id;
 if not found or c.result->>'contract'is distinct from'itau109-operational-v2'or not exists(select 1 from erp_cnab.audit where command_id=c.id and action in('operational_reserve_v2','operational_finalize_v2','operational_approve_v2'))then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 if exists(select 1 from erp_cnab.audit where command_id=c.id and action='operational_approve_v2')then
  perform erp_cnab.access(p_user_id,false,true);
  return erp_cnab.encoding_safety()||jsonb_build_object('kind','approval','read_only',true,'command_id',p_command_id,'receipt',c.result,'current',jsonb_build_object('profile_id',c.result->'profile_id','approval',erp_cnab.encoding_approval((c.result->>'profile_id')::uuid)));
 end if;
 select * into r from erp_cnab.remittance where id=(c.result->>'id')::uuid and purpose='operational'and snapshot?'encoding_profile';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 return erp_cnab.encoding_safety()||jsonb_build_object('kind','remittance','read_only',true,'command_id',p_command_id,'receipt',c.result,
  'current',jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'sequence',r.sequence::text,'encoding_profile',r.snapshot->'encoding_profile','file_hash',r.file_hash,'byte_size',r.byte_size,'created_at',r.created_at,'finalized_at',r.finalized_at));
end $$;

create function public.erp_cnab_operational_files_v2(p_user_id uuid,p_limit integer default 25,p_after uuid default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb;more boolean;cursor uuid;begin
 perform erp_cnab.access(p_user_id);if p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_cnab_invalid_query'using errcode='22023';end if;
 with selected as(select r.*,row_number()over(order by r.id)rn from erp_cnab.remittance r where r.purpose='operational'and r.snapshot#>>'{profile,bank}'='341'and r.snapshot#>>'{profile,wallet}'='109'and(p_after is null or r.id>p_after)order by r.id limit p_limit+1)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'profile_id',profile_id,'kind','remittance','state',state,'sequence',sequence::text,'generated_on',generated_on,'created_at',created_at,'file_hash',file_hash,'byte_size',byte_size,'titles',jsonb_array_length(snapshot->'titles'),'filename','ITAU_COBRANCA_'||lpad(sequence::text,7,'0')||'.REM','encoding_profile',snapshot->'encoding_profile')order by id)filter(where rn<=p_limit),'[]'),count(*)>p_limit,(array_agg(id order by id)filter(where rn<=p_limit))[least(p_limit,count(*)::integer)]into rows,more,cursor from selected;
 return erp_cnab.encoding_safety()||jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor end);
end $$;
-- Return storage and ledger semantics are unchanged. Only choose the declared
-- encoding gate for the exact persisted remittance, never a current default.
create function erp_cnab.return_encoding_status(p_id uuid,p_billing uuid default null)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare encoding text;begin
 if p_billing is not null then
  select coalesce(r.snapshot->>'encoding_profile','itau109-no-charges-v1')into encoding from erp_cnab.billing_title b join erp_cnab.remittance r on r.id=b.remittance_id where b.id=p_billing and b.profile_id=p_id and r.purpose='operational';
  if encoding is null then return erp_cnab.operational_status(p_id);end if;
  return erp_cnab.encoding_status(p_id,encoding);
 end if;
 return erp_cnab.encoding_approval(p_id)-array['allowed_encoding_profiles','encoding_policy'];
end $$;
create function erp_cnab.require_return_operational(p_id uuid,p_expected integer default null,p_billing uuid default null)returns jsonb language plpgsql stable set search_path=pg_catalog as $$declare s jsonb;begin
 s:=erp_cnab.return_encoding_status(p_id,p_billing);
 if s->'effective_enabled'is distinct from'true'::jsonb or(p_expected is not null and(s->>'approval_version')::integer<>p_expected)then raise exception 'erp_cnab_operational_approval_required'using errcode='40001';end if;return s;
end $$;

create or replace function public.erp_cnab_operational_return_profile(p_user_id uuid,p_profile_id uuid,p_expected_approval integer)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_cnab.access(p_user_id,true);if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
 perform erp_cnab.require_return_operational(p_profile_id,p_expected_approval);return jsonb_build_object('profile',erp_cnab.core_profile(p_profile_id),'approval_version',p_expected_approval);
end $$;

create or replace function public.erp_cnab_operational_return_commit(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_approval integer,p_file jsonb,p_events jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile;f erp_cnab.return_file;e erp_cnab.return_event;r jsonb;payload jsonb;cmd jsonb;replay jsonb;eid uuid;bill uuid;n integer;i integer;is_duplicate boolean;added integer:=0;duplicates integer:=0;begin
 perform erp_cnab.access(p_user_id,true);perform erp_finance.keys(p_file,array['hash','size','path','generated_on','century','record_count','warnings','evidence']);
 if p_expected_approval is null or p_expected_approval<1 or jsonb_typeof(p_events)is distinct from'array'or jsonb_array_length(p_events)>9998 or octet_length(p_events::text)>16000000 then raise exception 'erp_cnab_operational_return_invalid'using errcode='22023';end if;
 cmd:=jsonb_build_object('profile_id',p_profile_id,'approval_version',p_expected_approval,'file',p_file);replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_return',cmd);
 perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=p_profile_id for update;if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 perform erp_cnab.require_return_operational(p.id,p_expected_approval);if replay is not null then return replay;end if;
 if exists(select 1 from erp_cnab.return_file where profile_id=p.id and file_hash=p_file->>'hash'and purpose<>'operational')or exists(select 1 from erp_cnab.return_event where profile_id=p.id and event_hash in(select value->>'eventHash'from jsonb_array_elements(p_events))and purpose<>'operational')then raise exception 'erp_cnab_purpose_mismatch'using errcode='40001';end if;
 perform erp_cnab.storage_check(p.id,'returns',p_file->>'hash',(p_file->>'size')::integer,p_file->>'path');
 if jsonb_typeof(p_file->'warnings')is distinct from'array'or jsonb_typeof(p_file->'evidence')is distinct from'object'or(p_file->>'record_count')::integer<>jsonb_array_length(p_events)+2 or(p_file->>'century')::integer<>2000
  or erp_finance.day(p_file->'generated_on')>(clock_timestamp()at time zone'America/Sao_Paulo')::date
  or p_file#>>'{evidence,source}'is distinct from'authenticated-bank-download'or p_file#>>'{evidence,fileHash}'is distinct from p_file->>'hash'or p_file#>>'{evidence,accountId}'is distinct from p.account_id::text
  or p_file#>>'{evidence,reviewedBy}'is distinct from p_user_id::text or coalesce(p_file#>>'{evidence,referenceId}','')!~'^[a-zA-Z0-9_-]{1,80}$'then raise exception 'erp_cnab_bank_declaration_required'using errcode='22023';end if;
 select * into f from erp_cnab.return_file where profile_id=p.id and file_hash=p_file->>'hash';
 if found then if f.byte_size<>(p_file->>'size')::integer or f.record_count<>(p_file->>'record_count')::integer then raise exception 'erp_cnab_file_conflict'using errcode='40001';end if;
  return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_return',cmd,f.id,jsonb_build_object('id',f.id,'profile_id',p.id,'file_hash',f.file_hash,'duplicate_file',true,'new_events',0,'duplicate_events',jsonb_array_length(p_events),'canSettle',false));end if;
 insert into erp_cnab.return_file(profile_id,file_hash,object_path,byte_size,generated_on,century,record_count,warnings,evidence,actor,purpose)
 values(p.id,p_file->>'hash',p_file->>'path',(p_file->>'size')::integer,erp_finance.day(p_file->'generated_on'),2000,(p_file->>'record_count')::integer,p_file->'warnings',p_file->'evidence'||jsonb_build_object('operational_approval_version',p_expected_approval),p_user_id,'operational')returning * into f;
 n:=jsonb_array_length(p_events);for i in 0..n-1 loop
  r:=p_events->i;perform erp_finance.keys(r,array['version','accountScope','bank','wallet','control','documentNumber','ourNumber','occurrence','kind','occurrenceDate','creditDate','dueDate','amountCents','paidCents','adjustments','operationNumber','rejection','settlementChannel','eventHash','lineHash','line','warnings']);
  if r->>'accountScope'is distinct from p.account_scope or r->>'bank'is distinct from p.identity->>'bank'or r->>'wallet'is distinct from p.identity->>'wallet'or coalesce(r->>'eventHash','')!~'^[a-f0-9]{64}$'or coalesce(r->>'lineHash','')!~'^[a-f0-9]{64}$'or(r->>'line')::integer<>i+2 then raise exception 'erp_cnab_return_event_invalid'using errcode='22023';end if;
  payload:=r-array['eventHash','lineHash','line'];select * into e from erp_cnab.return_event where profile_id=p.id and event_hash=r->>'eventHash';is_duplicate:=found;
  if is_duplicate then if e.payload<>payload then raise exception 'erp_cnab_event_hash_conflict'using errcode='40001';end if;eid:=e.id;duplicates:=duplicates+1;
  else
   bill:=null;select b.id into bill from erp_cnab.billing_title b join erp_cnab.remittance m on m.id=b.remittance_id join erp_finance.title t on t.id=b.title_id
    where b.profile_id=p.id and m.purpose='operational'and m.state='ready'and b.control=r->>'control'and b.document_number=r->>'documentNumber'and t.amount_cents::text=r->>'amountCents'and t.due_on::text=r->>'dueDate';
   insert into erp_cnab.return_event(profile_id,event_hash,payload,billing_title_id,proposed_action,reason,purpose)
    values(p.id,r->>'eventHash',payload,bill,'REVIEW',case when bill is null then'EXACT_LINK_NOT_CONFIRMED'else'OPERATIONAL_REVIEW_REQUIRED'end,'operational')returning id into eid;added:=added+1;
  end if;
  insert into erp_cnab.return_occurrence values(f.id,i+2,eid,r->>'lineHash',is_duplicate);
 end loop;
 return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_return',cmd,f.id,jsonb_build_object('id',f.id,'profile_id',p.id,'file_hash',f.file_hash,'duplicate_file',false,'new_events',added,'duplicate_events',duplicates,'canSettle',false));
end $$;

create or replace function erp_cnab.operational_event_context(p_event_id uuid,p_file_id uuid,p_line integer)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e erp_cnab.return_event;f erp_cnab.return_file;o erp_cnab.return_occurrence;p erp_cnab.profile;b erp_cnab.billing_title;t erp_finance.title;a erp_finance.account;
 auth jsonb;context jsonb;issues text[]:='{}';bind_issues text[];settle_issues text[];today date:=(clock_timestamp()at time zone'America/Sao_Paulo')::date;opening date;declared boolean;begin
 select * into e from erp_cnab.return_event where id=p_event_id and purpose='operational';select * into o from erp_cnab.return_occurrence where file_id=p_file_id and line=p_line and event_id=p_event_id;
 select * into f from erp_cnab.return_file where id=p_file_id and purpose='operational'and profile_id=e.profile_id;
 if e.id is null or o.event_id is null or f.id is null then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;
 select * into p from erp_cnab.profile where id=e.profile_id;select * into a from erp_finance.account where id=p.account_id;
 select * into b from erp_cnab.billing_title where id=e.billing_title_id and profile_id=p.id;select * into t from erp_finance.title where id=b.title_id;
 auth:=erp_cnab.return_encoding_status(p.id,b.id);select posted_on into opening from erp_finance.movement where account_id=a.id and kind='opening';
 declared:=coalesce(f.evidence->>'source'='authenticated-bank-download'and f.evidence->>'fileHash'=f.file_hash and f.evidence->>'accountId'=a.id::text and f.evidence->>'referenceId'~'^[a-zA-Z0-9_-]{1,80}$',false);
 if auth->'effective_enabled'is distinct from'true'::jsonb then issues:=array_append(issues,'OPERATIONAL_APPROVAL_REQUIRED');end if;
 if not declared then issues:=array_append(issues,'BANK_ORIGIN_DECLARATION_REQUIRED');end if;
 if b.id is null or t.id is null then issues:=array_append(issues,'EXACT_TITLE_LINK_REQUIRED');
 else
  if not exists(select 1 from erp_cnab.remittance where id=b.remittance_id and purpose='operational'and state='ready')then issues:=array_append(issues,'OPERATIONAL_REMITTANCE_REQUIRED');end if;
  if b.control is distinct from e.payload->>'control'or b.document_number is distinct from e.payload->>'documentNumber'then issues:=array_append(issues,'TITLE_REFERENCE_CHANGED');end if;
  if b.snapshot#>>'{title,amountCents}'is distinct from e.payload->>'amountCents'or b.snapshot#>>'{title,dueOn}'is distinct from e.payload->>'dueDate'
   or b.snapshot#>>'{title,control}'is distinct from e.payload->>'control'or b.snapshot#>>'{title,documentNumber}'is distinct from e.payload->>'documentNumber'
   or b.snapshot#>>'{title,issuedOn}'is distinct from t.issued_on::text then issues:=array_append(issues,'REMITTANCE_SNAPSHOT_DIFFERS');end if;
  if t.amount_cents::text is distinct from e.payload->>'amountCents'or t.due_on::text is distinct from e.payload->>'dueDate'then issues:=array_append(issues,'TITLE_AMOUNT_OR_DUE_CHANGED');end if;
  if t.kind<>'receivable'or t.cancelled or t.settled_cents<>0 then issues:=array_append(issues,'TITLE_NOT_FULLY_OPEN');end if;
  if exists(select 1 from erp_finance.settlement where title_id=t.id)then issues:=array_append(issues,'PRIOR_SETTLEMENT_HISTORY');end if;
  if exists(select 1 from erp_finance.origin_import_origin where title_id=t.id)then issues:=array_append(issues,'LEGACY_BANK_BINDING_REQUIRED');end if;
 end if;
 if a.id is null or not a.active or a.kind<>'bank'then issues:=array_append(issues,'BANK_ACCOUNT_UNAVAILABLE');end if;
 if e.payload->>'occurrenceDate'is null or(e.payload->>'occurrenceDate')::date>today or(t.id is not null and(e.payload->>'occurrenceDate')::date<t.issued_on)then issues:=array_append(issues,'OCCURRENCE_DATE_INVALID');end if;
 bind_issues:=issues;settle_issues:=issues;
 if e.payload->>'bank'<>'077'or e.payload->>'wallet'<>'112'or e.payload->>'occurrence'<>'02'or e.payload->>'kind'<>'REGISTERED'then bind_issues:=array_append(bind_issues,'INTER112_REGISTRATION_REQUIRED');end if;
 if coalesce(e.payload->>'ourNumber','')!~'^[0-9]{11}$'or e.payload->>'ourNumber'='00000000000'then bind_issues:=array_append(bind_issues,'BANK_NUMBER_INVALID');end if;
 if e.payload->>'paidCents'is distinct from'0'then bind_issues:=array_append(bind_issues,'REGISTRATION_HAS_PAYMENT');end if;
 if b.our_number is not null or exists(select 1 from erp_cnab.operational_binding where event_id=e.id or billing_title_id=b.id)then bind_issues:=array_append(bind_issues,'BANK_NUMBER_ALREADY_BOUND');end if;
 if exists(select 1 from erp_cnab.billing_title where profile_id=p.id and id<>b.id and our_number=e.payload->>'ourNumber')then bind_issues:=array_append(bind_issues,'BANK_NUMBER_ALREADY_USED');end if;
 if e.payload->>'occurrence'<>'06'or e.payload->>'kind'<>'PAID'then settle_issues:=array_append(settle_issues,'EXACT_PAYMENT_06_REQUIRED');end if;
 if b.our_number is null or b.our_number is distinct from e.payload->>'ourNumber'then settle_issues:=array_append(settle_issues,'BANK_NUMBER_NOT_MATCHED');end if;
 if t.id is null or e.payload->>'paidCents'is distinct from t.amount_cents::text then settle_issues:=array_append(settle_issues,'PAYMENT_AMOUNT_DIFFERS');end if;
 if(e.payload->>'bank'='341'and(jsonb_typeof(e.payload->'adjustments')is distinct from'object'or(select count(*)from jsonb_each(e.payload->'adjustments'))<>6 or exists(select 1 from jsonb_each_text(e.payload->'adjustments')x where x.value<>'0')))
  or(e.payload->>'bank'='077'and e.payload->'adjustments'is distinct from'null'::jsonb)then settle_issues:=array_append(settle_issues,'PAYMENT_ADJUSTMENTS_UNSUPPORTED');end if;
 if f.warnings?'INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION'then settle_issues:=array_append(settle_issues,'TRAILER_AGGREGATE_AMBIGUOUS');end if;
 if e.payload->>'creditDate'is null or(e.payload->>'creditDate')::date>today or(e.payload->>'creditDate')::date<(e.payload->>'occurrenceDate')::date or(t.id is not null and(e.payload->>'creditDate')::date<t.issued_on)or(opening is not null and(e.payload->>'creditDate')::date<opening)then settle_issues:=array_append(settle_issues,'CREDIT_DATE_INVALID');end if;
 if exists(select 1 from erp_cnab.operational_settlement where event_id=e.id or billing_title_id=b.id or title_id=t.id)then settle_issues:=array_append(settle_issues,'OPERATIONAL_PAYMENT_ALREADY_APPLIED');end if;
 context:=jsonb_build_object('version',1,'as_of',today,'event',jsonb_build_object('id',e.id,'hash',e.event_hash,'bank',e.payload->'bank','wallet',e.payload->'wallet','control',e.payload->'control','document_number',e.payload->'documentNumber','our_number',e.payload->'ourNumber','occurrence',e.payload->'occurrence','kind',e.payload->'kind','amount_cents',e.payload->'amountCents','paid_cents',e.payload->'paidCents','due_on',e.payload->'dueDate','occurred_on',e.payload->'occurrenceDate','credited_on',e.payload->'creditDate','adjustments',e.payload->'adjustments','warnings',e.payload->'warnings'),
  'file',jsonb_build_object('id',f.id,'hash',f.file_hash,'line',o.line,'line_hash',o.line_hash,'duplicate',o.duplicate,'generated_on',f.generated_on,'declared_bank_origin',declared,'reference_id',case when declared then f.evidence->>'referenceId'end,'warnings',f.warnings),
  'profile',jsonb_build_object('id',p.id,'version',p.version,'approval_version',auth->'approval_version','effective_enabled',auth->'effective_enabled','account_id',p.account_id),
  'account',jsonb_build_object('id',a.id,'version',a.version,'name',a.name,'active',a.active,'kind',a.kind,'opening_on',opening),
  'billing',case when b.id is not null then jsonb_build_object('id',b.id,'remittance_id',b.remittance_id,'our_number',b.our_number,'control',b.control,'document_number',b.document_number)end,
  'title',case when t.id is not null then jsonb_build_object('id',t.id,'version',t.version,'kind',t.kind,'description',t.description,'amount_cents',t.amount_cents::text,'settled_cents',t.settled_cents::text,'balance_cents',(t.amount_cents-t.settled_cents)::text,'issued_on',t.issued_on,'due_on',t.due_on,'cancelled',t.cancelled)end,
  'binding',jsonb_build_object('allowed',cardinality(bind_issues)=0,'issues',to_jsonb(bind_issues)),
  'settlement',jsonb_build_object('allowed',cardinality(settle_issues)=0,'issues',to_jsonb(settle_issues)),
  'applied_command_id',(select command_id from erp_cnab.operational_settlement where event_id=e.id or billing_title_id=b.id or title_id=t.id limit 1));
 return context;
end $$;

create or replace function erp_cnab.lock_operational_event(p_event uuid,p_file uuid,p_line integer,p_approval integer)returns uuid language plpgsql set search_path=pg_catalog as $$declare pid uuid;bill uuid;tid uuid;aid uuid;begin
 select profile_id,billing_title_id into pid,bill from erp_cnab.return_event where id=p_event and purpose='operational';if not found then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(174852920,1);select account_id into aid from erp_cnab.profile where id=pid for update;
 perform 1 from erp_cnab.return_event where id=p_event for update;select title_id into tid from erp_cnab.billing_title where id=bill for update;
 perform 1 from erp_finance.title where id=tid for update;perform 1 from erp_finance.account where id=aid for update;
 perform erp_cnab.require_return_operational(pid,p_approval,bill);if not exists(select 1 from erp_cnab.return_occurrence where event_id=p_event and file_id=p_file and line=p_line)then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;return pid;
end $$;

create or replace function public.erp_cnab_operational_return_file(p_user_id uuid,p_file_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare f erp_cnab.return_file;a jsonb;begin
 perform erp_cnab.access(p_user_id);select * into f from erp_cnab.return_file where id=p_file_id and purpose='operational';if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 a:=erp_cnab.require_return_operational(f.profile_id);perform erp_cnab.storage_check(f.profile_id,'returns',f.file_hash,f.byte_size,f.object_path);
 return jsonb_build_object('id',f.id,'profile_id',f.profile_id,'hash',f.file_hash,'size',f.byte_size,'path',f.object_path,'approval_version',a->'approval_version','filename','RETORNO_'||f.id::text||'.RET');
end $$;

create or replace function public.erp_cnab_operational_reservation(p_user_id uuid,p_id uuid,p_expected_approval integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id,true);select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and not(snapshot?'encoding_profile');
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
 a:=erp_cnab.require_operational(r.profile_id,p_expected_approval);perform erp_cnab.operational_snapshot_check(r.id);
 return erp_cnab.operational_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'snapshot',r.snapshot,'file_hash',r.file_hash,'object_path',r.object_path,'byte_size',r.byte_size,'approval_version',a->'approval_version');
end $$;

create or replace function public.erp_cnab_operational_finalize(p_user_id uuid,p_command_id uuid,p_id uuid,p_hash text,p_size integer,p_path text,p_manifest jsonb,p_expected_approval integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; b erp_cnab.billing_title; row jsonb; command jsonb; replay jsonb; n text; pid uuid; approval jsonb; begin
  perform erp_cnab.access(p_user_id,true);
  if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
  command:=jsonb_build_object('id',p_id,'hash',p_hash,'size',p_size,'path',p_path,'manifest',p_manifest,'approval_version',p_expected_approval);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_finalize',command);
  select profile_id into pid from erp_cnab.remittance where id=p_id and purpose='operational'and not(snapshot?'encoding_profile');if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
  perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=pid for update;
  select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and not(snapshot?'encoding_profile') for update;
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

create or replace function public.erp_cnab_operational_file(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.remittance;a jsonb;begin
 perform erp_cnab.access(p_user_id);select * into r from erp_cnab.remittance where id=p_id and purpose='operational'and not(snapshot?'encoding_profile')and state='ready';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 a:=erp_cnab.require_operational(r.profile_id);perform erp_cnab.operational_snapshot_check(r.id);
 perform erp_cnab.storage_check(r.profile_id,'remittances',r.file_hash,r.byte_size,r.object_path);
 return erp_cnab.operational_safety()||jsonb_build_object('id',r.id,'profile_id',r.profile_id,'hash',r.file_hash,'size',r.byte_size,'path',r.object_path,'approval_version',a->'approval_version',
 'filename',case when r.snapshot->'profile'->>'bank'='077'then'CI400_001_'else'ITAU_COBRANCA_'end||lpad(r.sequence::text,7,'0')||'.REM');
end $$;
-- Root review snippet for migration067; no transaction or grant changes.
create or replace function public.erp_cnab_itau_boleto_context(p_user_id uuid,p_billing_title_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare
 b erp_cnab.billing_title; r erp_cnab.remittance; p erp_cnab.profile;
 t erp_finance.title; c erp_catalog.record; company erp_company.identity;
 selected_title jsonb; selected_manifest jsonb; approval jsonb; result jsonb; n integer;
 is_encoding_v2 boolean; encoding text;
begin
 perform erp_cnab.access(p_user_id);
 if p_billing_title_id is null then raise exception 'erp_boleto_preview_id_required' using errcode='22023'; end if;
 select * into b from erp_cnab.billing_title where id=p_billing_title_id;
 if not found then raise exception 'erp_boleto_preview_not_found' using errcode='P0002'; end if;
 select * into r from erp_cnab.remittance where id=b.remittance_id and profile_id=b.profile_id;
 select * into p from erp_cnab.profile where id=b.profile_id;
 if r.id is null or p.id is null or r.state<>'ready' then
  raise exception 'erp_boleto_preview_remittance_not_ready' using errcode='40001'; end if;
 is_encoding_v2:=r.snapshot ? 'encoding_profile';
 encoding:=r.snapshot->>'encoding_profile';
 if is_encoding_v2 and (r.purpose<>'operational' or encoding is null
  or encoding not in('itau109-no-charges-v1','itau109-origin-observed-v1')) then
  raise exception 'erp_boleto_preview_encoding_unsupported' using errcode='0A000'; end if;
 if p.identity->>'bank' is distinct from '341' or p.identity->>'wallet' is distinct from '109'
  or p.identity->>'layout' is distinct from 'itau-cnab400-2017-01' then
  raise exception 'erp_boleto_preview_profile_unsupported' using errcode='0A000'; end if;
 if r.purpose not in('homologation','operational') or r.snapshot->>'purpose' is distinct from r.purpose
  or r.snapshot->'profile' is distinct from erp_cnab.core_profile(p.id)
  or r.snapshot->>'generatedOn' is distinct from r.generated_on::text
  or r.snapshot->>'remittanceSequence' is distinct from r.sequence::text
  or p.settings->'contractVerified' is distinct from 'true'::jsonb
  or (not is_encoding_v2 and p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb)
  or not exists(select 1 from erp_finance.account where id=p.account_id and active and kind='bank') then
  raise exception 'erp_boleto_preview_profile_changed' using errcode='40001'; end if;
 if r.purpose='operational' then
  if is_encoding_v2 then
   approval:=erp_cnab.require_operational_for_encoding(p.id,null,encoding);
   perform erp_cnab.encoding_snapshot_check(r.id);
  else
   approval:=erp_cnab.require_operational(p.id);
   perform erp_cnab.operational_snapshot_check(r.id);
  end if;
 end if;
 perform erp_cnab.storage_check(r.profile_id,'remittances',r.file_hash,r.byte_size,r.object_path);
 if jsonb_typeof(r.snapshot->'titles') is distinct from 'array' or jsonb_array_length(r.snapshot->'titles') not between 1 and 30
  or jsonb_typeof(r.manifest) is distinct from 'array' or jsonb_array_length(r.manifest)<>jsonb_array_length(r.snapshot->'titles') then
  raise exception 'erp_boleto_preview_snapshot_invalid' using errcode='40001'; end if;
 select count(*) into n from jsonb_array_elements(r.snapshot->'titles') x where x->>'id'=b.id::text;
 if n<>1 then raise exception 'erp_boleto_preview_title_binding_invalid' using errcode='40001'; end if;
 select x into selected_title from jsonb_array_elements(r.snapshot->'titles') x where x->>'id'=b.id::text;
 select count(*) into n from jsonb_array_elements(r.manifest) x where x->>'titleId'=b.id::text;
 if n<>1 then raise exception 'erp_boleto_preview_manifest_invalid' using errcode='40001'; end if;
 select x into selected_manifest from jsonb_array_elements(r.manifest) x where x->>'titleId'=b.id::text;
 if selected_title is distinct from b.snapshot->'title' or b.snapshot->>'finance_title_id' is distinct from b.title_id::text
  or selected_title->>'control' is distinct from b.control or selected_title->>'documentNumber' is distinct from b.document_number
  or selected_title->>'ourNumber' is distinct from b.our_number_base
  or b.our_number_base is null or b.our_number_base!~'^[0-9]{8}$' or b.our_number_base='00000000'
  or b.our_number is null or b.our_number!~'^[0-9]{9}$' or left(b.our_number,8)<>b.our_number_base
  or selected_manifest->>'control' is distinct from b.control or selected_manifest->>'documentNumber' is distinct from b.document_number
  or selected_manifest->>'ourNumber' is distinct from b.our_number
  or selected_manifest->>'amountCents' is distinct from selected_title->>'amountCents'
  or selected_manifest->>'dueDate' is distinct from selected_title->>'dueOn'
  or (is_encoding_v2 and selected_manifest->'encodingTerms' is distinct from selected_title->'encodingTerms') then
  raise exception 'erp_boleto_preview_snapshot_binding_invalid' using errcode='40001'; end if;
 -- Barcode44 has ten amount positions, even though the CNAB detail has thirteen.
 if jsonb_typeof(selected_title->'amountCents') is distinct from 'string'
  or selected_title->>'amountCents'!~'^[1-9][0-9]{0,9}$'
  or b.document_number!~'^[A-Za-z0-9./-]{1,10}$'
  or exists(select 1 from jsonb_array_elements(r.snapshot->'titles') x where x ? 'collectionTerms') then
  raise exception 'erp_boleto_preview_print_profile_unsupported' using errcode='0A000'; end if;
 select * into t from erp_finance.title where id=b.title_id;
 select * into c from erp_catalog.record where id=t.contact_id;
 if t.id is null or c.id is null or not c.active or t.kind<>'receivable' or t.cancelled or t.settled_cents<>0
  or b.snapshot->>'finance_title_version' is distinct from t.version::text
  or b.snapshot->>'contact_version' is distinct from c.version::text
  or selected_title->>'amountCents' is distinct from t.amount_cents::text
  or selected_title->>'issuedOn' is distinct from t.issued_on::text or selected_title->>'dueOn' is distinct from t.due_on::text then
  raise exception 'erp_boleto_preview_native_context_changed' using errcode='40001'; end if;
 select * into company from erp_company.identity where singleton;
 if company.version is null or company.data->>'cnpj' is distinct from p.identity->>'cnpj' then
  raise exception 'erp_boleto_preview_beneficiary_identity_mismatch' using errcode='40001'; end if;
 -- Address016 was not captured in014. Identify this current supplemental source;
 -- do not claim that it was part of the historical remittance or change either.
 result:=jsonb_build_object(
  'profile',case when is_encoding_v2 then 'itau109-persisted-print-preview-v2' else 'itau109-persisted-print-preview-v1' end,'private_context',true,
  'billing_title_id',b.id,'remittance_id',r.id,'profile_id',p.id,'finance_title_id',t.id,
  'source_purpose',r.purpose,'state','ready','snapshot',r.snapshot,'billing_snapshot',b.snapshot,
  'manifest',r.manifest,'our_number',b.our_number,
  'snapshot_hash',encode(sha256(convert_to(r.snapshot::text,'UTF8')),'hex'),
  'file',jsonb_build_object('bucket','brufap-cnab','path',r.object_path,'hash',r.file_hash,'size',r.byte_size),
  'beneficiary',jsonb_build_object('identity_version',company.version,'cnpj',company.data->>'cnpj',
    'address_source','company_identity_current',
    'address',jsonb_build_object('address',concat_ws(' ',nullif(company.data->>'street',''),nullif(company.data->>'number',''),nullif(company.data->>'complement','')),
      'neighborhood',company.data->>'district','city',company.data->>'city','state',company.data->>'state','postalCode',company.data->>'postal_code')),
  'current',jsonb_build_object('title_version',t.version,'contact_version',c.version,'profile_version',p.version,
    'approval_version',approval->'approval_version','company_identity_version',company.version,
    'title_status','open','title_cancelled',false,'settled_cents','0'),
  'read_only',true,'can_pay',false,'can_issue',false,'can_transmit',false,'financial_mutation_performed',false
 );
 return result||jsonb_build_object('context_hash',encode(sha256(convert_to(result::text,'UTF8')),'hex'));
end $$;

revoke all on all functions in schema erp_cnab from public,anon,authenticated,service_role;
do $$declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('erp_cnab_operational_profiles_v2','erp_cnab_operational_approve_v2','erp_cnab_operational_reserve_v2','erp_cnab_operational_reservation_v2','erp_cnab_operational_finalize_v2','erp_cnab_operational_command_v2','erp_cnab_operational_file_v2','erp_cnab_operational_files_v2')loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;end $$;
commit;
