-- Persisted declarations only. No authorization policy, intent, request, nonce or transport mutation.
begin;
create schema erp_fiscal_subset_review;
revoke all on schema erp_fiscal_subset_review from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_subset_review revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_subset_review revoke all on sequences from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_subset_review revoke all on functions from public,anon,authenticated,service_role;

create function erp_fiscal_subset_review.canonical(v jsonb)returns text language plpgsql immutable set search_path=pg_catalog as $$
declare result text;begin
 case jsonb_typeof(v)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||erp_fiscal_subset_review.canonical(value),','order by key collate "C"),'')||'}'into result from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(erp_fiscal_subset_review.canonical(value),','order by ordinal),'')||']'into result from jsonb_array_elements(v)with ordinality a(value,ordinal);
 when 'number' then
  if (v::text)::numeric<>trunc((v::text)::numeric)or abs((v::text)::numeric)>2147483647 then raise exception'subset_review_integer_invalid'using errcode='22023';end if;
  result:=((v::text)::numeric::bigint)::text;
 when 'string','boolean','null' then result:=v::text;
 else raise exception'subset_review_json_invalid'using errcode='22023';end case;
 return result;
end$$;
create function erp_fiscal_subset_review.digest(v text)returns text language sql immutable strict set search_path=pg_catalog as $$select encode(sha256(convert_to(v,'UTF8')),'hex')$$;
create function erp_fiscal_subset_review.profile_hash()returns text language sql immutable set search_path=pg_catalog as $$select 'e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504'::text$$;
create function erp_fiscal_subset_review.profile()returns text language sql immutable set search_path=pg_catalog as $$select 'sp-crt1-internal-sale-homologation-20261016-v1'::text$$;
create function erp_fiscal_subset_review.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$select jsonb_build_object(
 'data_mode','fiscal_subset_review','environment','2','coverage','listed_rules_only_not_full_tax_validation',
 'tax_rules_validated',false,'sefaz_authorized',false,'can_emit',false,'can_transmit',false,'operational_binding_enabled',false,
 'financial_mutation_performed',false,'stock_mutation_performed',false)$$;
create function erp_fiscal_subset_review.choice(v jsonb,allowed text[])returns boolean language sql immutable set search_path=pg_catalog as $$select jsonb_typeof(v)='string'and(v#>>'{}')=any(allowed)$$;
create function erp_fiscal_subset_review.js_length(v text)returns integer language sql immutable set search_path=pg_catalog as $$select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0)::integer from regexp_split_to_table(v,'')ch$$;

-- Only this closed, typed declaration is canonicalized; decimal fiscal values are strings.
create function erp_fiscal_subset_review.declaration(value text)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare v jsonb;d jsonb;x jsonb;c jsonb;i integer:=0;k text;begin
 if value is null or octet_length(value)not between 1 and 131072 then raise exception'subset_review_size_invalid'using errcode='22023';end if;
 begin v:=value::jsonb;exception when others then raise exception'subset_review_json_invalid'using errcode='22023';end;
 if not erp_a1.exact(v,array['document','items'])or not erp_a1.exact(v->'document',array['operation','recipient_regime','acquisition_purpose','payment','excluded_groups'])
  or jsonb_typeof(v->'items')is distinct from'array'then raise exception'subset_review_declaration_invalid'using errcode='22023';end if;
 if jsonb_array_length(v->'items')not between 1 and 250 then raise exception'subset_review_items_invalid'using errcode='22023';end if;
 d:=v->'document';
 if erp_fiscal_subset_review.choice(d->'operation',array['internal_normal_sale','outside_scope','unreviewed'])is not true
  or erp_fiscal_subset_review.choice(d->'recipient_regime',array['regular_icms','simples','noncontributor','unreviewed'])is not true
  or erp_fiscal_subset_review.choice(d->'acquisition_purpose',array['resale','industrialization','final_consumption','unreviewed'])is not true
  or erp_fiscal_subset_review.choice(d->'payment',array['matches_signed_document','unreviewed'])is not true
  or erp_fiscal_subset_review.choice(d->'excluded_groups',array['not_applicable','applies','unreviewed'])is not true
 then raise exception'subset_review_document_invalid'using errcode='22023';end if;
 for x in select *from jsonb_array_elements(v->'items')loop
  i:=i+1;
  if not erp_a1.exact(x,array['position','item_hash','classification','benefit','pis_cofins','gtin','st','fcp','credit'])
   or jsonb_typeof(x->'position')is distinct from'number'or x->>'position'<>i::text
   or jsonb_typeof(x->'item_hash')is distinct from'string'or x->>'item_hash'!~'^[a-f0-9]{64}$'
   or erp_fiscal_subset_review.choice(x->'classification',array['reviewed_physical_goods','outside_scope','unreviewed'])is not true
   or erp_fiscal_subset_review.choice(x->'benefit',array['not_applicable','applies','unreviewed'])is not true
   or erp_fiscal_subset_review.choice(x->'pis_cofins',array['normal_unified_simples','other','unreviewed'])is not true
   or erp_fiscal_subset_review.choice(x->'gtin',array['reviewed_absent','reviewed_identifiers','unreviewed'])is not true
   or erp_fiscal_subset_review.choice(x->'st',array['documented_prior_retention','not_applicable','unreviewed'])is not true
   or erp_fiscal_subset_review.choice(x->'fcp',array['documented_prior_retention','not_applicable','unreviewed'])is not true
  then raise exception'subset_review_item_invalid'using errcode='22023';end if;
  c:=x->'credit';if c is distinct from'null'::jsonb then
   if not erp_a1.exact(c,array['eligibility','base','rate','amount','period','source_hash','statement'])
    or c->'eligibility'is distinct from'"reviewed_lc123_art23"'::jsonb
    or jsonb_typeof(c->'base')is distinct from'string'or c->>'base'!~'^(0|[1-9][0-9]{0,12})\.[0-9]{2}$'
    or jsonb_typeof(c->'amount')is distinct from'string'or c->>'amount'!~'^(0|[1-9][0-9]{0,12})\.[0-9]{2}$'
    or jsonb_typeof(c->'rate')is distinct from'string'or c->>'rate'!~'^(0|[1-9][0-9]{0,2})\.[0-9]{2}$'
    or jsonb_typeof(c->'period')is distinct from'string'or c->>'period'!~'^[0-9]{4}-(0[1-9]|1[0-2])$'
    or jsonb_typeof(c->'source_hash')is distinct from'string'or c->>'source_hash'!~'^[a-f0-9]{64}$'
    or jsonb_typeof(c->'statement')is distinct from'string'or erp_fiscal_subset_review.js_length(c->>'statement')not between 1 and 1000 or(c->>'statement')~'[[:cntrl:]]'
   then raise exception'subset_review_credit_invalid'using errcode='22023';end if;
  end if;
 end loop;
 -- This rejects duplicates, alternate whitespace/order/escapes and 1e0, even when JSONB normalized them.
 if erp_fiscal_subset_review.canonical(v)is distinct from value then raise exception'subset_review_not_canonical'using errcode='22023';end if;
 return v;
end$$;

create table erp_fiscal_subset_review.review(
 id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 candidate_id uuid not null references erp_fiscal_signed.candidate(id),candidate_version integer not null check(candidate_version>0),
 signed_hash text not null check(signed_hash~'^[a-f0-9]{64}$'),signed_size integer not null check(signed_size between 1 and 512000),
 model text not null check(model in('55','65')),issuer_cnpj text not null,schema_evidence jsonb not null,
 facts_hash text not null check(facts_hash~'^[a-f0-9]{64}$'),profile_hash text not null check(profile_hash=erp_fiscal_subset_review.profile_hash()),
 version integer not null check(version>0),previous_version integer not null check(previous_version>=0 and version=previous_version+1),
 declaration jsonb not null,record_text text not null check(octet_length(record_text)between 1 and 131072),review_hash text not null check(review_hash~'^[a-f0-9]{64}$'),
 reviewed_at timestamptz not null,valid_until timestamptz not null check(valid_until>reviewed_at),unique(candidate_id,version)
);
alter table erp_fiscal_subset_review.review enable row level security;
revoke all on erp_fiscal_subset_review.review from public,anon,authenticated,service_role;
create function erp_fiscal_subset_review.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception'subset_review_immutable'using errcode='42501';end$$;
create trigger immutable before update or delete on erp_fiscal_subset_review.review for each row execute function erp_fiscal_subset_review.immutable();

create function erp_fiscal_subset_review.view(actor_id uuid,r erp_fiscal_subset_review.review,candidate uuid,candidate_version integer,signed_hash text,facts_hash text,profile_hash text,readonly boolean,replayed boolean)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare latest erp_fiscal_subset_review.review;receipt jsonb;begin
 select *into latest from erp_fiscal_subset_review.review where candidate_id=candidate order by version desc limit 1;
 if r.id is not null then receipt:=jsonb_build_object('review_id',r.id,'command_id',r.id,'review_version',r.version,'reviewed_by',r.actor,
  'reviewed_at',to_char(r.reviewed_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'valid_until',to_char(r.valid_until at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'candidate_id',r.candidate_id,'candidate_version',r.candidate_version,'signed_hash',r.signed_hash,'facts_hash',r.facts_hash,
  'profile',erp_fiscal_subset_review.profile(),'profile_hash',r.profile_hash,'schema',r.schema_evidence,'review_hash',r.review_hash,'coverage','listed_rules_only_not_full_tax_validation');end if;
 return erp_fiscal_subset_review.flags()||jsonb_build_object('actor',actor_id,'candidate_id',candidate,'candidate_version',candidate_version,
  'signed_hash',signed_hash,'facts_hash',facts_hash,'profile_hash',profile_hash,'read_only',readonly,'replayed',replayed,'receipt',receipt,
  'current',jsonb_build_object('latest_review_id',latest.id,'latest_review_version',coalesce(latest.version,0),'is_latest',r.id is not null and r.id=latest.id,
   'reviewer_active',r.id is not null and exists(select 1 from erp_access.membership where user_id=r.actor and active and role in('admin','fiscal')),
   'within_validity',r.id is not null and clock_timestamp()>=r.reviewed_at and clock_timestamp()<r.valid_until),
  'record_text',r.record_text);
end$$;

create function public.erp_fiscal_subset_review_save(p_user_id uuid,p_command_id uuid,p_candidate_id uuid,p_expected_candidate_version integer,p_signed_hash text,p_expected_review_version integer,p_facts_hash text,p_profile_hash text,p_schema jsonb,p_valid_until text,p_declaration_text text)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare d jsonb;s jsonb;a erp_fiscal_signed.artifact;r erp_fiscal_subset_review.review;head integer;tag text;at timestamptz;expires timestamptz;record jsonb;body text;rh text;begin
 perform erp_a1.access(p_user_id);
 if p_command_id is null or p_candidate_id is null or p_expected_candidate_version is null or p_expected_candidate_version<1
  or p_expected_review_version is null or p_expected_review_version not between 0 and 2147483646
  or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'or p_facts_hash is null or p_facts_hash!~'^[a-f0-9]{64}$'
  or p_profile_hash is distinct from erp_fiscal_subset_review.profile_hash()
  or not erp_a1.exact(p_schema,array['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash'])
  or p_valid_until is null or p_valid_until!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 then raise exception'subset_review_input_invalid'using errcode='22023';end if;
 begin expires:=p_valid_until::timestamptz;exception when others then raise exception'subset_review_time_invalid'using errcode='22023';end;
 if to_char(expires at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_valid_until then raise exception'subset_review_time_invalid'using errcode='22023';end if;
 d:=erp_fiscal_subset_review.declaration(p_declaration_text);
 tag:=erp_fiscal_subset_review.digest(erp_fiscal_subset_review.canonical(jsonb_build_object('actor',p_user_id,'command',p_command_id,'candidate',p_candidate_id,'candidate_version',p_expected_candidate_version,'signed_hash',p_signed_hash,'previous_version',p_expected_review_version,'facts_hash',p_facts_hash,'profile_hash',p_profile_hash,'schema',p_schema,'valid_until',p_valid_until,'declaration',d)));
 perform pg_advisory_xact_lock(174852968,hashtext(p_command_id::text));
 select *into r from erp_fiscal_subset_review.review where id=p_command_id;
 if found then
  if r.actor<>p_user_id or r.request_hash<>tag then raise exception'subset_review_command_conflict'using errcode='40001';end if;
  perform erp_fiscal_authorization.lock_source(p_user_id,r.candidate_id,false);
  return erp_fiscal_subset_review.view(p_user_id,r,r.candidate_id,r.candidate_version,r.signed_hash,r.facts_hash,r.profile_hash,false,true);
 end if;
 -- No intent/attempt locks. This ordering is compatible with064 and mutex016.
 s:=erp_fiscal_authorization.lock_source(p_user_id,p_candidate_id,true);
 if s->>'signed_hash'is distinct from p_signed_hash or(s->>'candidate_version')::integer is distinct from p_expected_candidate_version then raise exception'subset_review_candidate_conflict'using errcode='40001';end if;
 select *into a from erp_fiscal_signed.artifact where candidate_id=p_candidate_id;
 if a.evidence->'xsd'is distinct from p_schema then raise exception'subset_review_schema_conflict'using errcode='40001';end if;
 select coalesce(max(version),0)into head from erp_fiscal_subset_review.review where candidate_id=p_candidate_id;
 if head<>p_expected_review_version then raise exception'subset_review_version_conflict'using errcode='40001';end if;
 at:=date_trunc('milliseconds',clock_timestamp());
 if at<'2026-10-16T00:00:00-03:00'::timestamptz or at>='2026-10-26T00:00:00-03:00'::timestamptz or expires<=at or expires>'2026-10-26T00:00:00-03:00'::timestamptz then raise exception'subset_review_time_invalid'using errcode='22023';end if;
 record:=jsonb_build_object('id',p_command_id,'version',head+1,'candidate_id',p_candidate_id,'signed_hash',p_signed_hash,'facts_hash',p_facts_hash,
  'profile',erp_fiscal_subset_review.profile(),'profile_hash',p_profile_hash,'reviewed_by',p_user_id,
  'reviewed_at',to_char(at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'valid_until',p_valid_until,'document',d->'document','items',d->'items');
 body:=erp_fiscal_subset_review.canonical(record);rh:=erp_fiscal_subset_review.digest(body);body:=erp_fiscal_subset_review.canonical(record||jsonb_build_object('review_hash',rh));
 if octet_length(body)>131072 then raise exception'subset_review_size_invalid'using errcode='22023';end if;
 insert into erp_fiscal_subset_review.review(id,actor,request_hash,candidate_id,candidate_version,signed_hash,signed_size,model,issuer_cnpj,schema_evidence,facts_hash,profile_hash,version,previous_version,declaration,record_text,review_hash,reviewed_at,valid_until)
 values(p_command_id,p_user_id,tag,p_candidate_id,p_expected_candidate_version,p_signed_hash,(s->>'signed_size')::integer,s->>'model',s->>'issuer_cnpj',p_schema,p_facts_hash,p_profile_hash,head+1,head,d,body,rh,at,expires)returning *into r;
 return erp_fiscal_subset_review.view(p_user_id,r,r.candidate_id,r.candidate_version,r.signed_hash,r.facts_hash,r.profile_hash,false,false);
end$$;

create function public.erp_fiscal_subset_review_get(p_user_id uuid,p_candidate_id uuid,p_candidate_version integer,p_signed_hash text,p_facts_hash text,p_profile_hash text)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare s jsonb;r erp_fiscal_subset_review.review;begin
 if p_candidate_id is null or p_candidate_version is null or p_candidate_version<1 or p_signed_hash is null or p_signed_hash!~'^[a-f0-9]{64}$'
  or p_facts_hash is null or p_facts_hash!~'^[a-f0-9]{64}$'or p_profile_hash is distinct from erp_fiscal_subset_review.profile_hash()then raise exception'subset_review_input_invalid'using errcode='22023';end if;
 s:=erp_fiscal_authorization.source(p_user_id,p_candidate_id,p_signed_hash);
 if(s->>'candidate_version')::integer<>p_candidate_version then raise exception'subset_review_candidate_conflict'using errcode='40001';end if;
 -- Select the latest FIRST. A mismatching new review must not reveal an older matching version.
 select *into r from erp_fiscal_subset_review.review where candidate_id=p_candidate_id order by version desc limit 1;
 if r.id is not null and(r.candidate_version<>p_candidate_version or r.signed_hash<>p_signed_hash or r.facts_hash<>p_facts_hash or r.profile_hash<>p_profile_hash)then raise exception'subset_review_latest_conflict'using errcode='40001';end if;
 return erp_fiscal_subset_review.view(p_user_id,r,p_candidate_id,p_candidate_version,p_signed_hash,p_facts_hash,p_profile_hash,true,false);
end$$;
create function public.erp_fiscal_subset_review_command(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r erp_fiscal_subset_review.review;begin
 perform erp_a1.access(p_user_id);if p_command_id is null then raise exception'subset_review_command_invalid'using errcode='22023';end if;
 select *into r from erp_fiscal_subset_review.review where id=p_command_id;
 if not found then raise exception'subset_review_not_found'using errcode='P0002';end if;
 if r.actor<>p_user_id then raise exception'subset_review_forbidden'using errcode='42501';end if;
 perform erp_fiscal_authorization.source(p_user_id,r.candidate_id,r.signed_hash);
 return erp_fiscal_subset_review.view(p_user_id,r,r.candidate_id,r.candidate_version,r.signed_hash,r.facts_hash,r.profile_hash,true,false);
end$$;
revoke all on all functions in schema erp_fiscal_subset_review from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_subset_review_save(uuid,uuid,uuid,integer,text,integer,text,text,jsonb,text,text),public.erp_fiscal_subset_review_get(uuid,uuid,integer,text,text,text),public.erp_fiscal_subset_review_command(uuid,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_subset_review_save(uuid,uuid,uuid,integer,text,integer,text,text,jsonb,text,text),public.erp_fiscal_subset_review_get(uuid,uuid,integer,text,text,text),public.erp_fiscal_subset_review_command(uuid,uuid)to service_role;
commit;
