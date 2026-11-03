-- Limited, explicit Simples Nacional item decisions. No calculation, XML or operational effect.
begin;
create schema erp_fiscal_tax;
revoke all on schema erp_fiscal_tax from public,anon,authenticated,service_role;
create table erp_fiscal_tax.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_tax.revision(
 draft_id uuid not null,version integer not null check(version>0),draft_version integer not null,
 item_preparation_version integer not null,snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 record jsonb not null,actor uuid not null references auth.users(id),command_id uuid not null unique references erp_fiscal_tax.command(command_id) deferrable initially deferred,
 created_at timestamptz not null default clock_timestamp(),primary key(draft_id,version),
 foreign key(draft_id,draft_version) references erp_fiscal_drafts.revision(draft_id,version),
 foreign key(draft_id,item_preparation_version) references erp_fiscal_items.revision(draft_id,version));
create table erp_fiscal_tax.head(draft_id uuid primary key references erp_fiscal_drafts.draft(id),version integer not null,
 foreign key(draft_id,version) references erp_fiscal_tax.revision(draft_id,version));
alter table erp_fiscal_tax.command enable row level security;
alter table erp_fiscal_tax.revision enable row level security;
alter table erp_fiscal_tax.head enable row level security;
revoke all on all tables in schema erp_fiscal_tax from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_tax revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_tax revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_tax.immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_tax_history_immutable' using errcode='42501';end $$;
create trigger immutable_revision before update or delete on erp_fiscal_tax.revision for each row execute function erp_fiscal_tax.immutable();
create trigger immutable_command before update or delete on erp_fiscal_tax.command for each row execute function erp_fiscal_tax.immutable();
create function erp_fiscal_tax.guard_head() returns trigger language plpgsql set search_path=pg_catalog as $$
begin if tg_op='DELETE' or new.draft_id<>old.draft_id or old.version=2147483647 or new.version<>old.version+1 then
 raise exception 'erp_fiscal_tax_head_conflict' using errcode='40001';end if;return new;end $$;
create trigger guard_head before update or delete on erp_fiscal_tax.head for each row execute function erp_fiscal_tax.guard_head();
create function erp_fiscal_tax.flags() returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_tax_preparation','profile','sn-internal-sale-preparation-v1','schema_profile','pl010f-v1.04',
 'operational_effects',false,'calculation_performed',false,'xml_generated',false,'transmitted',false,'can_emit',false,'tax_rules_validated',false,'xsd_validated',false)
$$;
create function erp_fiscal_tax.exact(v jsonb,keys text[]) returns boolean language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='object' then (select count(*)=cardinality(keys) and bool_and(k=any(keys)) from jsonb_object_keys(v)k) else false end
$$;
create function erp_fiscal_tax.note(v jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare t text;space text:=' ';i integer;begin
 if v='null'::jsonb then return true;end if;if v is null or jsonb_typeof(v)<>'string' then return false;end if;t:=v#>>'{}';
 if length(t)<3 or length(t)>1000 then return false;end if;
 for i in 1..31 loop if position(chr(i) in t)>0 then return false;end if;end loop;if position(chr(127) in t)>0 then return false;end if;
 foreach i in array array[160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279] loop space:=space||chr(i);end loop;
 return translate(t,space,'')<>'';
end $$;
create function erp_fiscal_tax.decimal_value(v jsonb,kind text) returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(v='null'::jsonb or (jsonb_typeof(v)='string' and case when kind='rate' then v#>>'{}'~'^(0|[1-9][0-9]{0,2})\.[0-9]{2,4}$' else v#>>'{}'~'^(0|[1-9][0-9]{0,12})\.[0-9]{2}$' end),false)
$$;
create function erp_fiscal_tax.amounts(v jsonb,keys text[],rates text[]) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare k text;begin if not erp_fiscal_tax.exact(v,keys) then return false;end if;
 foreach k in array keys loop if not erp_fiscal_tax.decimal_value(v->k,case when k=any(rates)then 'rate'else 'money'end)then return false;end if;end loop;return true;end $$;
create function erp_fiscal_tax.validate_decisions(v jsonb,model text default null) returns void language plpgsql immutable set search_path=pg_catalog as $$
declare d jsonb;c jsonb;k text;seen text[]:='{}';begin
 if v is null or jsonb_typeof(v)<>'array' then raise exception 'erp_fiscal_tax_decisions_invalid' using errcode='22023';end if;
 if jsonb_array_length(v)>250 or octet_length(v::text)>524288 then raise exception 'erp_fiscal_tax_decisions_limit' using errcode='22023';end if;
 for d in select value from jsonb_array_elements(v) loop
  if not erp_fiscal_tax.exact(d,array['item_id','cfop','icms','pis','cofins','review_note']) or jsonb_typeof(d->'item_id') is distinct from 'string'
   or d->>'item_id'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or d->>'item_id'=any(seen) or not erp_fiscal_tax.note(d->'review_note') then
   raise exception 'erp_fiscal_tax_decision_invalid' using errcode='22023';end if;seen:=array_append(seen,d->>'item_id');
  if d->'cfop'<>'null'::jsonb and (jsonb_typeof(d->'cfop')<>'string' or d->>'cfop' not in('5102','5405'))then raise exception 'erp_fiscal_tax_branch_unsupported' using errcode='22023';end if;
  c:=d->'icms';if c<>'null'::jsonb then
   if c->>'csosn'='102' then if not erp_fiscal_tax.exact(c,array['csosn'])then raise exception 'erp_fiscal_tax_decision_invalid' using errcode='22023';end if;
   elsif c->>'csosn'='101' then
    if model='65' then raise exception 'erp_fiscal_tax_branch_unsupported' using errcode='22023';end if;
    if not erp_fiscal_tax.exact(c,array['csosn','credit_rate','credit_period','credit_evidence']) or not erp_fiscal_tax.decimal_value(c->'credit_rate','rate') or not erp_fiscal_tax.note(c->'credit_evidence')
     or not(c->'credit_period'='null'::jsonb or (jsonb_typeof(c->'credit_period')='string' and c->>'credit_period'~'^[1-9][0-9]{3}-(0[1-9]|1[0-2])$')) then raise exception 'erp_fiscal_tax_decision_invalid' using errcode='22023';end if;
   elsif c->>'csosn'='500' then
    if not erp_fiscal_tax.exact(c,array['csosn','retention','fcp','effective'])
     or not erp_fiscal_tax.amounts(c->'retention',array['base','rate','substitute_icms','retained_icms'],array['rate'])
     or not erp_fiscal_tax.amounts(c->'fcp',array['base','rate','amount'],array['rate'])
     or not erp_fiscal_tax.amounts(c->'effective',array['reduction_rate','base','rate','amount'],array['rate','reduction_rate']) then raise exception 'erp_fiscal_tax_decision_invalid' using errcode='22023';end if;
   else raise exception 'erp_fiscal_tax_branch_unsupported' using errcode='22023';end if;
   if jsonb_typeof(c->'csosn')<>'string' then raise exception 'erp_fiscal_tax_decision_invalid' using errcode='22023';end if;
  end if;
  foreach k in array array['pis','cofins'] loop c:=d->k;if c<>'null'::jsonb and (not erp_fiscal_tax.exact(c,array['cst','base','rate','amount']) or c->'cst'<>'"49"'::jsonb
   or not erp_fiscal_tax.decimal_value(c->'base','money') or not erp_fiscal_tax.decimal_value(c->'rate','rate') or not erp_fiscal_tax.decimal_value(c->'amount','money'))then raise exception 'erp_fiscal_tax_branch_unsupported' using errcode='22023';end if;end loop;
 end loop;
end $$;
create function erp_fiscal_tax.resolve(model text,items jsonb,decisions jsonb) returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare i jsonb;d jsonb;pending text[];result jsonb:='[]';begin
 perform erp_fiscal_tax.validate_decisions(decisions,model);
 if exists(select 1 from jsonb_array_elements(decisions)e where not exists(select 1 from jsonb_array_elements(items)src_item where src_item->>'item_id'=e->>'item_id'))then raise exception 'erp_fiscal_tax_foreign_item' using errcode='22023';end if;
 for i in select value from jsonb_array_elements(items) loop
  select value into d from jsonb_array_elements(decisions)e where e->>'item_id'=i->>'item_id';
  if d is null then d:=jsonb_build_object('item_id',i->'item_id','cfop',null,'icms',null,'pis',null,'cofins',null,'review_note',null);end if;
  pending:=array['ACCOUNTING_REVIEW_REQUIRED','CFOP_APPLICABILITY_UNVERIFIED','TAX_CLASSIFICATION_UNVERIFIED','IPI_APPLICABILITY_UNREVIEWED','RTC_APPLICABILITY_UNREVIEWED','TRIBUTARY_VALUES_UNPREPARED','TAX_VALUES_NOT_CALCULATED'];
  if d->'cfop'='null'::jsonb then pending:=array_append(pending,'CFOP_UNPREPARED');end if;
  if d->'icms'='null'::jsonb then pending:=array_append(pending,'ICMS_UNPREPARED');
  elsif d#>>'{icms,csosn}'='101' then
   if d#>'{icms,credit_rate}'='null'::jsonb then pending:=array_append(pending,'CREDIT_RATE_UNPREPARED');end if;
   if d#>'{icms,credit_period}'='null'::jsonb or d#>'{icms,credit_evidence}'='null'::jsonb then pending:=array_append(pending,'CREDIT_BASIS_UNPREPARED');end if;
   pending:=pending||array['CREDIT_ENTITLEMENT_UNVERIFIED','CREDIT_AMOUNT_NOT_CALCULATED'];
  elsif d#>>'{icms,csosn}'='500' then pending:=array_append(pending,'RETENTION_APPLICABILITY_UNREVIEWED');end if;
  pending:=array_append(pending,case when d->'pis'='null'::jsonb then 'PIS_UNPREPARED'else 'PIS_DECLARED_VALUES_UNVERIFIED'end);
  pending:=array_append(pending,case when d->'cofins'='null'::jsonb then 'COFINS_UNPREPARED'else 'COFINS_DECLARED_VALUES_UNVERIFIED'end);
  if i->'product_id'='null'::jsonb then pending:=array_append(pending,'FREE_ITEM_REQUIRES_REVIEW');end if;
  result:=result||jsonb_build_array(i||jsonb_build_object('decisions',d,'pending',pending,'provenance',jsonb_build_object(
   'cfop',case when d->'cfop'='null'::jsonb then 'unreviewed'else 'manual'end,'icms',case when d->'icms'='null'::jsonb then 'unreviewed'else 'manual'end,
   'pis',case when d->'pis'='null'::jsonb then 'unreviewed'else 'manual'end,'cofins',case when d->'cofins'='null'::jsonb then 'unreviewed'else 'manual'end)));
 end loop;return result;
end $$;
create function erp_fiscal_tax.context(id uuid,rec jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare r jsonb;c jsonb;v integer;iv integer;begin
 r:=erp_fiscal_drafts.record(id);if r is null then raise exception 'erp_fiscal_tax_not_found'using errcode='P0002';end if;
 c:=erp_fiscal_drafts.context(r);select version into v from erp_fiscal_tax.head where draft_id=id;select version into iv from erp_fiscal_items.head where draft_id=id;
 return jsonb_build_object('tax_version',coalesce(v,0),'draft_version',r->'version','item_preparation_version',coalesce(iv,0),
 'draft_status',r->'status','source_status',c->'source_status','source_changed',c->'source_changed','company_changed',c->'company_changed',
 'matches_current_draft',rec is not null and rec->'draft_version'=r->'version','matches_current_item_preparation',rec is not null and (rec->>'item_preparation_version')::integer=iv);
end $$;
create function erp_fiscal_tax.envelope(id uuid,rec jsonb) returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_tax.flags()||jsonb_build_object('record',rec,'current',erp_fiscal_tax.context(id,rec))
$$;
create function erp_fiscal_tax.basis(id uuid,dv integer,hash text,iv integer,v integer) returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;i jsonb;c jsonb;hv integer;hiv integer;begin
 if id is null or dv is null or dv<1 or hash is null or hash!~'^[0-9a-f]{64}$' or iv is null or iv<1 or v is null or v<0 then raise exception 'erp_fiscal_tax_binding_invalid'using errcode='22023';end if;
 d:=erp_fiscal_drafts.record(id);if d is null then raise exception 'erp_fiscal_tax_not_found'using errcode='P0002';end if;
 select version into hv from erp_fiscal_tax.head where draft_id=id;select version into hiv from erp_fiscal_items.head where draft_id=id;
 select record into i from erp_fiscal_items.revision where draft_id=id and version=iv;c:=erp_fiscal_drafts.context(d);
 if d->>'status'<>'draft' or d->>'environment'<>'2' or (d->>'version')::integer<>dv or d->>'snapshot_hash'<>hash or coalesce(hv,0)<>v or v=2147483647
  or hiv is distinct from iv or i is null or (i->>'draft_version')::integer<>dv or i->>'snapshot_hash'<>hash
  or (c->>'source_changed')::boolean or (c->>'company_changed')::boolean or c->>'source_status'='cancelled' then raise exception 'erp_fiscal_tax_basis_conflict'using errcode='40001';end if;
 if d#>>'{snapshot,company,crt}' is distinct from '1' or d#>'{snapshot,company,regime_confirmed}' is distinct from 'true'::jsonb
  or d#>>'{snapshot,company,identity,state}' is distinct from 'SP' then raise exception 'erp_fiscal_tax_regime_outside_profile'using errcode='22023';end if;
 if d#>>'{snapshot,contact,state}' is not null and d#>>'{snapshot,contact,state}'<>'SP' then raise exception 'erp_fiscal_tax_destination_outside_profile'using errcode='22023';end if;
 return jsonb_build_object('draft_id',id,'version',v+1,'draft_version',dv,'snapshot_hash',hash,'item_preparation_version',iv,
  'model',d->'model','environment','2','operation','internal_normal_sale','crt','1','company_identity_version',d#>'{snapshot,company,identity_version}',
  'company_fiscal_version',d#>'{snapshot,company,fiscal_version}','source_document_id',d->'source_document_id','source_document_version',d->'source_document_version',
  'items',(select jsonb_agg(jsonb_build_object('item_id',e->'item_id','position',e->'position','product_id',e->'product_id',
   'identifiers',jsonb_build_object('ncm',e#>'{fields,ncm,value}','origin',e#>'{fields,origin,value}','cest',e#>'{fields,cest,value}','gtin',e#>'{fields,gtin,value}','gtin_tax',e#>'{fields,gtin_tax,value}'))order by(e->>'position')::integer)from jsonb_array_elements(i->'items')e));
end $$;
create function public.erp_fiscal_tax_get(p_user_id uuid,p_draft_id uuid,p_version integer default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v integer;r jsonb;begin perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or(p_version is not null and p_version<1)then raise exception 'erp_fiscal_tax_query_invalid'using errcode='22023';end if;
 select version into v from erp_fiscal_tax.head where draft_id=p_draft_id;select record into r from erp_fiscal_tax.revision where draft_id=p_draft_id and version=coalesce(p_version,v);
 if p_version is not null and r is null then raise exception 'erp_fiscal_tax_not_found'using errcode='P0002';end if;return erp_fiscal_tax.envelope(p_draft_id,r);end $$;
create function public.erp_fiscal_tax_history(p_user_id uuid,p_draft_id uuid,p_limit integer default 25,p_before integer default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or p_limit is null or p_limit<1 or p_limit>25 or(p_before is not null and p_before<1)then raise exception 'erp_fiscal_tax_query_invalid'using errcode='22023';end if;
 perform erp_fiscal_tax.context(p_draft_id,null);
 select coalesce(jsonb_agg(record-'items' order by version desc),'[]')into items from(select record,version from erp_fiscal_tax.revision where draft_id=p_draft_id and(p_before is null or version<p_before)order by version desc limit p_limit)t;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_tax.revision where draft_id=p_draft_id and version<(items->-1->>'version')::integer);
 return erp_fiscal_tax.flags()||jsonb_build_object('draft_id',p_draft_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then(items->-1->>'version')::integer else null end);end $$;
create function public.erp_fiscal_tax_preview(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_item_preparation_version integer,p_expected_version integer,p_operation text,p_decisions jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;begin perform erp_fiscal_drafts.require_access(p_user_id);
 if p_operation is distinct from 'internal_normal_sale' then raise exception 'erp_fiscal_tax_operation_unsupported'using errcode='22023';end if;
 r:=erp_fiscal_tax.basis(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_item_preparation_version,p_expected_version);
 r:=r||jsonb_build_object('created_at',null,'items',erp_fiscal_tax.resolve(r->>'model',r->'items',p_decisions));
 if octet_length(r::text)>1048576 then raise exception 'erp_fiscal_tax_record_limit'using errcode='22023';end if;
 return erp_fiscal_tax.envelope(p_draft_id,r)||jsonb_build_object('persisted',false,'expected_version',p_expected_version);end $$;
create function public.erp_fiscal_tax_save(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_item_preparation_version integer,p_expected_version integer,p_operation text,p_decisions jsonb,p_command_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_fiscal_tax.command%rowtype;parent uuid;r jsonb;at timestamptz;begin
 perform erp_fiscal_drafts.require_access(p_user_id);if p_command_id is null then raise exception 'erp_fiscal_tax_command_invalid'using errcode='22023';end if;
 if p_operation is distinct from 'internal_normal_sale' then raise exception 'erp_fiscal_tax_operation_unsupported'using errcode='22023';end if;
 perform erp_fiscal_tax.validate_decisions(p_decisions);
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'draft_id',p_draft_id,'draft_version',p_expected_draft_version,'snapshot_hash',p_snapshot_hash,'item_version',p_item_preparation_version,'expected_version',p_expected_version,'operation',p_operation,'decisions',p_decisions)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852940,hashtext(p_command_id::text));select * into c from erp_fiscal_tax.command where command_id=p_command_id;
 if found then if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_fiscal_tax_command_conflict'using errcode='40001';end if;return erp_fiscal_tax.envelope(p_draft_id,c.result)||jsonb_build_object('replayed',true);end if;
 select source_document_id into parent from erp_fiscal_drafts.draft where id=p_draft_id;if not found then raise exception 'erp_fiscal_tax_not_found'using errcode='P0002';end if;
 perform 1 from erp_documents.document where id=parent for share;
 perform 1 from erp_fiscal_drafts.draft where id=p_draft_id and source_document_id=parent for update;
 -- Same position as022 capture;016 writers use this mutex and never wait for documents/drafts.
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_fiscal_items.head where draft_id=p_draft_id for share;
 perform 1 from erp_fiscal_tax.head where draft_id=p_draft_id for update;
 r:=erp_fiscal_tax.basis(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_item_preparation_version,p_expected_version);at:=clock_timestamp();
 r:=r||jsonb_build_object('created_at',at,'items',erp_fiscal_tax.resolve(r->>'model',r->'items',p_decisions));
 if octet_length(r::text)>1048576 then raise exception 'erp_fiscal_tax_record_limit'using errcode='22023';end if;
 insert into erp_fiscal_tax.revision(draft_id,version,draft_version,item_preparation_version,snapshot_hash,record,actor,command_id,created_at)
 values(p_draft_id,p_expected_version+1,p_expected_draft_version,p_item_preparation_version,p_snapshot_hash,r,p_user_id,p_command_id,at);
 insert into erp_fiscal_tax.head(draft_id,version)values(p_draft_id,p_expected_version+1)on conflict(draft_id)do update set version=excluded.version;
 insert into erp_fiscal_tax.command(command_id,actor,request_hash,result)values(p_command_id,p_user_id,h,r);
 return erp_fiscal_tax.envelope(p_draft_id,r)||jsonb_build_object('replayed',false);end $$;
revoke all on all functions in schema erp_fiscal_tax from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_tax_get(uuid,uuid,integer),public.erp_fiscal_tax_history(uuid,uuid,integer,integer),
 public.erp_fiscal_tax_preview(uuid,uuid,integer,text,integer,integer,text,jsonb),public.erp_fiscal_tax_save(uuid,uuid,integer,text,integer,integer,text,jsonb,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_tax_get(uuid,uuid,integer),public.erp_fiscal_tax_history(uuid,uuid,integer,integer),
 public.erp_fiscal_tax_preview(uuid,uuid,integer,text,integer,integer,text,jsonb),public.erp_fiscal_tax_save(uuid,uuid,integer,text,integer,integer,text,jsonb,uuid)to service_role;
commit;
