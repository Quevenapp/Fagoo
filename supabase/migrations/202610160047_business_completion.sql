-- Partial, explicit business completion. Persistence only: no identity, number, XML or effects.
begin;
create schema erp_fiscal_completion;
revoke all on schema erp_fiscal_completion from public,anon,authenticated,service_role;
create table erp_fiscal_completion.command(
 command_id uuid primary key,actor uuid not null references auth.users(id),request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
 result jsonb not null,created_at timestamptz not null default clock_timestamp());
create table erp_fiscal_completion.revision(
 draft_id uuid not null,version integer not null check(version>0),draft_version integer not null,
 item_preparation_version integer not null,tax_preparation_version integer not null,snapshot_hash text not null check(snapshot_hash~'^[0-9a-f]{64}$'),
 record jsonb not null,actor uuid not null references auth.users(id),command_id uuid not null unique references erp_fiscal_completion.command(command_id) deferrable initially deferred,
 created_at timestamptz not null default clock_timestamp(),primary key(draft_id,version),
 foreign key(draft_id,draft_version) references erp_fiscal_drafts.revision(draft_id,version),
 foreign key(draft_id,item_preparation_version) references erp_fiscal_items.revision(draft_id,version),
 foreign key(draft_id,tax_preparation_version) references erp_fiscal_tax.revision(draft_id,version));
create table erp_fiscal_completion.head(draft_id uuid primary key references erp_fiscal_drafts.draft(id),version integer not null,
 foreign key(draft_id,version) references erp_fiscal_completion.revision(draft_id,version));
alter table erp_fiscal_completion.command enable row level security;
alter table erp_fiscal_completion.revision enable row level security;
alter table erp_fiscal_completion.head enable row level security;
revoke all on all tables in schema erp_fiscal_completion from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_completion revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_fiscal_completion revoke all on functions from public,anon,authenticated,service_role;
create function erp_fiscal_completion.immutable()returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_fiscal_completion_history_immutable'using errcode='42501';end$$;
create trigger immutable_command before update or delete on erp_fiscal_completion.command for each row execute function erp_fiscal_completion.immutable();
create trigger immutable_revision before update or delete on erp_fiscal_completion.revision for each row execute function erp_fiscal_completion.immutable();
create function erp_fiscal_completion.guard_head()returns trigger language plpgsql set search_path=pg_catalog as $$
begin if tg_op='DELETE'or new.draft_id<>old.draft_id or old.version=2147483647 or new.version<>old.version+1 then
 raise exception 'erp_fiscal_completion_head_conflict'using errcode='40001';end if;return new;end$$;
create trigger guard_head before update or delete on erp_fiscal_completion.head for each row execute function erp_fiscal_completion.guard_head();
create function erp_fiscal_completion.flags()returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('data_mode','fiscal_business_completion','profile','sn-sp-business-completion-v1','schema_profile','pl010f-v1.04',
 'operational_effects',false,'calculation_performed',false,'arithmetic_verified',false,'tax_rules_validated',false,'numbering_bound',false,
 'xml_generated',false,'xsd_validated',false,'signature_verified',false,'authorized',false,'can_emit',false,'can_transmit',false)
$$;
create function erp_fiscal_completion.exact(v jsonb,keys text[])returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(case when jsonb_typeof(v)='object'then(select count(*)=cardinality(keys)and coalesce(bool_and(k=any(keys)),true)from jsonb_object_keys(v)k)else false end,false)
$$;
create function erp_fiscal_completion.choice(v jsonb,choices text[])returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(v='null'::jsonb or(jsonb_typeof(v)='string'and v#>>'{}'=any(choices)),false)
$$;
create function erp_fiscal_completion.money(v jsonb)returns boolean language sql immutable set search_path=pg_catalog as $$
 select coalesce(v='null'::jsonb or(jsonb_typeof(v)='string'and v#>>'{}'~'^(0|[1-9][0-9]{0,12})\.[0-9]{2}$'),false)
$$;
create function erp_fiscal_completion.decimal_value(v jsonb,scale integer,positive boolean default false)returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare t text;begin
 if v='null'::jsonb then return true;end if;
 if v is null or jsonb_typeof(v)<>'string'or scale not in(6,10)then return false;end if;t:=v#>>'{}';
 if t!~('^(0|[1-9][0-9]{0,10})(\.[0-9]{1,'||scale::text||'})?$')then return false;end if;
 return not positive or t::numeric>0;
end$$;
create function erp_fiscal_completion.text_value(v jsonb,max_length integer)returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare t text;n integer;c integer;begin
 if v='null'::jsonb then return true;end if;if v is null or jsonb_typeof(v)<>'string'then return false;end if;t:=v#>>'{}';
 if length(t)<1 or length(t)>max_length or left(t,1)=' 'or right(t,1)=' 'then return false;end if;
 for n in 1..length(t)loop c:=ascii(substr(t,n,1));if c<32 or c>255 or c between 127 and 159 then return false;end if;end loop;return true;
end$$;
create function erp_fiscal_completion.has_null(v jsonb)returns boolean language sql immutable set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='object'then exists(select 1 from jsonb_each(v)e where e.value='null'::jsonb)else false end
$$;
create function erp_fiscal_completion.validate(v jsonb,model text,items jsonb)returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare totals text[]:=array['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vFCPSTRet','vProd','vFrete','vSeg','vDesc','vII','vIPI','vIPIDevol','vPIS','vCOFINS','vOutro','vNF'];
 excluded text[]:=array['ipi','ii','issqn','ibs_cbs','is','monophase','destination_icms'];
 general text[]:=array['ARITHMETIC_NOT_CHECKED','TAX_APPLICABILITY_UNVERIFIED','RTC_APPLICABILITY_UNVERIFIED','NUMBERING_NOT_BOUND','XML_NOT_GENERATED'];
 rows jsonb:='[]';i jsonb;b jsonb;p jsonb;credit jsonb;g jsonb;codes text[];seen text[]:='{}';k text;n integer:=0;payments_missing boolean;
begin
 if model is null or model not in('55','65')or items is null or jsonb_typeof(items)<>'array'then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 if jsonb_array_length(items)<1 or jsonb_array_length(items)>250 or v is null or octet_length(v::text)>524288
  or not erp_fiscal_completion.exact(v,array['operation','recipient','items','totals','payments','transport_mode','excluded_groups','homologation_labels','additional_information'])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 if not erp_fiscal_completion.exact(v->'operation',array['tpNF','idDest','finNFe','indFinal','indPres'])
  or not erp_fiscal_completion.choice(v#>'{operation,tpNF}',array['1'])or not erp_fiscal_completion.choice(v#>'{operation,idDest}',array['1'])
  or not erp_fiscal_completion.choice(v#>'{operation,finNFe}',array['1'])or not erp_fiscal_completion.choice(v#>'{operation,indPres}',array['1'])
  or not erp_fiscal_completion.choice(v#>'{operation,indFinal}',case when model='65'then array['1']else array['0','1']end)
  or not erp_fiscal_completion.exact(v->'recipient',array['municipality_code','indIEDest'])
  or not coalesce(v#>'{recipient,municipality_code}'='null'::jsonb or(jsonb_typeof(v#>'{recipient,municipality_code}')='string'and v#>>'{recipient,municipality_code}'~'^35[0-9]{5}$'),false)
  or not erp_fiscal_completion.choice(v#>'{recipient,indIEDest}',case when model='65'then array['9']else array['1','2','9']end)then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 if jsonb_typeof(v->'items')<>'array'or not erp_fiscal_completion.exact(v->'totals',totals)
  or not erp_fiscal_completion.exact(v->'payments',array['items','change'])or jsonb_typeof(v#>'{payments,items}')<>'array'
  or not erp_fiscal_completion.money(v#>'{payments,change}')then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 if jsonb_array_length(v->'items')<>jsonb_array_length(items)or jsonb_array_length(v#>'{payments,items}')>100 then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 foreach k in array totals loop if not erp_fiscal_completion.money(v#>array['totals',k])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;end loop;
 payments_missing:=jsonb_array_length(v#>'{payments,items}')=0 or v#>'{payments,change}'='null'::jsonb;
 for p in select value from jsonb_array_elements(v#>'{payments,items}')loop
  if not erp_fiscal_completion.exact(p,array['type','timing','amount'])or not erp_fiscal_completion.choice(p->'type',array['01','15'])
   or not erp_fiscal_completion.choice(p->'timing',array['0','1'])or not erp_fiscal_completion.money(p->'amount')then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
  payments_missing:=payments_missing or erp_fiscal_completion.has_null(p);
 end loop;
 if not erp_fiscal_completion.choice(v->'transport_mode',array['0','1','2','3','4','9'])or not erp_fiscal_completion.exact(v->'excluded_groups',excluded)
  or not erp_fiscal_completion.choice(v->'homologation_labels',array['apply_test_labels'])or not erp_fiscal_completion.text_value(v->'additional_information',2000)then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
 foreach k in array excluded loop if not erp_fiscal_completion.choice(v#>array['excluded_groups',k],array['not_included_in_profile'])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;end loop;
 if erp_fiscal_completion.has_null(v->'operation')then general:=array_append(general,'OPERATION_UNPREPARED');end if;
 if erp_fiscal_completion.has_null(v->'recipient')then general:=array_append(general,'RECIPIENT_UNPREPARED');end if;
 if erp_fiscal_completion.has_null(v->'totals')then general:=array_append(general,'TOTALS_UNPREPARED');end if;
 if payments_missing then general:=array_append(general,'PAYMENTS_UNPREPARED');end if;
 if v->'transport_mode'='null'::jsonb then general:=array_append(general,'TRANSPORT_UNPREPARED');end if;
 if erp_fiscal_completion.has_null(v->'excluded_groups')then general:=array_append(general,'EXCLUDED_GROUPS_UNREVIEWED');end if;
 if v->'homologation_labels'='null'::jsonb then general:=array_append(general,'HOMOLOGATION_LABELS_UNREVIEWED');end if;
 for i in select value from jsonb_array_elements(v->'items')loop
  b:=items->n;n:=n+1;
  if not erp_fiscal_completion.exact(b,array['item_id','position','cest','csosn'])or jsonb_typeof(b->'item_id')is distinct from'string'
   or b->>'item_id'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'or b->'position'<>to_jsonb(n)
   or not erp_fiscal_completion.choice(b->'csosn',case when model='65'then array['102','500']else array['101','102','500']end)
   or not coalesce(b->'cest'='null'::jsonb or(jsonb_typeof(b->'cest')='string'and b->>'cest'~'^[0-9]{7}$'),false)
   or not erp_fiscal_completion.exact(i,array['item_id','tributary','allocations','cest_absence','icms'])or i->'item_id'is distinct from b->'item_id'or i->>'item_id'=any(seen)then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
  seen:=array_append(seen,i->>'item_id');
  if not erp_fiscal_completion.exact(i->'tributary',array['unit','quantity','unit_price'])or not erp_fiscal_completion.text_value(i#>'{tributary,unit}',6)
   or not erp_fiscal_completion.decimal_value(i#>'{tributary,quantity}',6,true)or not erp_fiscal_completion.decimal_value(i#>'{tributary,unit_price}',10)
   or not erp_fiscal_completion.exact(i->'allocations',array['global_discount','freight','other'])or not erp_fiscal_completion.choice(i->'cest_absence',array['omit'])
   or(b->'cest'<>'null'::jsonb and i->'cest_absence'<>'null'::jsonb)or not erp_fiscal_completion.exact(i->'icms',array['credit','groups500'])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
  foreach k in array array['global_discount','freight','other']loop if not erp_fiscal_completion.money(i#>array['allocations',k])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;end loop;
  credit:=i#>'{icms,credit}';g:=i#>'{icms,groups500}';
  if credit<>'null'::jsonb then
   if b->>'csosn'is distinct from'101'or not erp_fiscal_completion.exact(credit,array['base','amount'])or not erp_fiscal_completion.money(credit->'base')or not erp_fiscal_completion.money(credit->'amount')then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
  end if;
  if g<>'null'::jsonb then
   if b->>'csosn'is distinct from'500'or not erp_fiscal_completion.exact(g,array['retention','fcp','effective'])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;
   foreach k in array array['retention','fcp','effective']loop if not erp_fiscal_completion.choice(g->k,array['include','omit'])then raise exception 'erp_fiscal_completion_invalid'using errcode='22023';end if;end loop;
  end if;
  codes:='{}';if erp_fiscal_completion.has_null(i->'tributary')then codes:=array_append(codes,'TRIBUTARY_UNPREPARED');end if;
  if substring(split_part(i#>>'{tributary,quantity}','.',2)from 5)~'[1-9]'then codes:=array_append(codes,'QUANTITY_PRECISION_REVIEW');end if;
  if erp_fiscal_completion.has_null(i->'allocations')then codes:=array_append(codes,'ALLOCATIONS_UNPREPARED');end if;
  if b->'cest'='null'::jsonb and i->'cest_absence'='null'::jsonb then codes:=array_append(codes,'CEST_OMISSION_UNREVIEWED');end if;
  if b->'csosn'='null'::jsonb then codes:=array_append(codes,'ICMS_BRANCH_UNPREPARED');end if;
  if b->>'csosn'='101'and(credit='null'::jsonb or erp_fiscal_completion.has_null(credit))then codes:=array_append(codes,'CREDIT_UNPREPARED');end if;
  if b->>'csosn'='500'and(g='null'::jsonb or erp_fiscal_completion.has_null(g))then codes:=array_append(codes,'RETENTION_GROUPS_UNREVIEWED');end if;
  rows:=rows||jsonb_build_array(jsonb_build_object('item_id',i->'item_id','position',n,'codes',codes));
 end loop;
 return jsonb_build_object('general',general,'items',rows);
end$$;
create function erp_fiscal_completion.context(id uuid,rec jsonb)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;c jsonb;v integer;iv integer;tv integer;begin
 d:=erp_fiscal_drafts.record(id);if d is null then raise exception 'erp_fiscal_completion_not_found'using errcode='P0002';end if;c:=erp_fiscal_drafts.context(d);
 select version into v from erp_fiscal_completion.head where draft_id=id;select version into iv from erp_fiscal_items.head where draft_id=id;select version into tv from erp_fiscal_tax.head where draft_id=id;
 return jsonb_build_object('completion_version',coalesce(v,0),'draft_version',d->'version','draft_status',d->'status','source_document_version',c->'source_document_version',
  'source_status',c->'source_status','source_changed',c->'source_changed','company_changed',c->'company_changed','identity_version',c->'identity_version','fiscal_version',c->'fiscal_version',
  'item_preparation_version',coalesce(iv,0),'tax_preparation_version',coalesce(tv,0),
  'matches_current_draft',coalesce(rec->'draft_version'=d->'version'and rec->'snapshot_hash'=d->'snapshot_hash',false),
  'matches_current_item_preparation',coalesce((rec->>'item_preparation_version')::integer=iv,false),
  'matches_current_tax_preparation',coalesce((rec->>'tax_preparation_version')::integer=tv,false),
  'matches_current_company',coalesce(rec->'company_identity_version'=c->'identity_version'and rec->'company_fiscal_version'=c->'fiscal_version',false));
end$$;
create function erp_fiscal_completion.envelope(id uuid,rec jsonb)returns jsonb language sql stable set search_path=pg_catalog as $$
 select erp_fiscal_completion.flags()||jsonb_build_object('record',rec,'current',erp_fiscal_completion.context(id,rec))
$$;
create function erp_fiscal_completion.basis(id uuid,dv integer,hash text,iv integer,tv integer,identity_v integer,fiscal_v integer,v integer)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare d jsonb;c jsonb;i jsonb;t jsonb;hv integer;hiv integer;htv integer;items jsonb;begin
 if id is null or dv is null or dv<1 or hash is null or hash!~'^[0-9a-f]{64}$'or iv is null or iv<1 or tv is null or tv<1
  or identity_v is null or identity_v<1 or fiscal_v is null or fiscal_v<1 or v is null or v<0 then raise exception 'erp_fiscal_completion_binding_invalid'using errcode='22023';end if;
 d:=erp_fiscal_drafts.record(id);if d is null then raise exception 'erp_fiscal_completion_not_found'using errcode='P0002';end if;c:=erp_fiscal_drafts.context(d);
 select version into hv from erp_fiscal_completion.head where draft_id=id;select version into hiv from erp_fiscal_items.head where draft_id=id;select version into htv from erp_fiscal_tax.head where draft_id=id;
 select record into i from erp_fiscal_items.revision where draft_id=id and version=iv;select record into t from erp_fiscal_tax.revision where draft_id=id and version=tv;
 if d->>'status'<>'draft'or d->>'environment'<>'2'or(d->>'version')::integer<>dv or d->>'snapshot_hash'<>hash or coalesce(hv,0)<>v or v=2147483647
  or hiv is distinct from iv or htv is distinct from tv or i is null or t is null or (i->>'draft_version')::integer<>dv or(t->>'draft_version')::integer<>dv
  or i->>'snapshot_hash'<>hash or t->>'snapshot_hash'<>hash or(t->>'item_preparation_version')::integer<>iv
  or i->>'model'<>d->>'model'or t->>'model'<>d->>'model'or i->>'environment'<>'2'or t->>'environment'<>'2'
  or(c->>'source_changed')::boolean or(c->>'company_changed')::boolean or c->>'source_status'='cancelled'
  or(c->>'identity_version')::integer is distinct from identity_v or(c->>'fiscal_version')::integer is distinct from fiscal_v
  or(t->>'company_identity_version')::integer is distinct from identity_v or(t->>'company_fiscal_version')::integer is distinct from fiscal_v then raise exception 'erp_fiscal_completion_basis_conflict'using errcode='40001';end if;
 if d#>>'{snapshot,company,crt}'is distinct from'1'or d#>'{snapshot,company,regime_confirmed}'is distinct from'true'::jsonb
  or d#>>'{snapshot,company,identity,state}'is distinct from'SP'or t->>'operation'<>'internal_normal_sale'then raise exception 'erp_fiscal_completion_profile_unsupported'using errcode='22023';end if;
 if jsonb_array_length(d#>'{snapshot,items}')<>jsonb_array_length(i->'items')or jsonb_array_length(i->'items')<>jsonb_array_length(t->'items')
  or exists(select 1 from jsonb_array_elements(d#>'{snapshot,items}')with ordinality ds(x,n)
   where ds.x->'id'is distinct from(i->'items'->(ds.n::integer-1)->'item_id')or ds.x->'id'is distinct from(t->'items'->(ds.n::integer-1)->'item_id')
    or ds.x->'position'is distinct from to_jsonb(ds.n::integer)or i->'items'->(ds.n::integer-1)->'position'is distinct from to_jsonb(ds.n::integer)
    or t->'items'->(ds.n::integer-1)->'position'is distinct from to_jsonb(ds.n::integer))then raise exception 'erp_fiscal_completion_basis_conflict'using errcode='40001';end if;
 select jsonb_agg(jsonb_build_object('item_id',e->'item_id','position',e->'position','cest',e#>'{identifiers,cest}','csosn',e#>'{decisions,icms,csosn}')order by(e->>'position')::integer)into items from jsonb_array_elements(t->'items')e;
 return jsonb_build_object('draft_id',id,'version',v+1,'draft_version',dv,'snapshot_hash',hash,'item_preparation_version',iv,'tax_preparation_version',tv,
  'item_preparation_hash',encode(sha256(convert_to(i::text,'UTF8')),'hex'),'tax_preparation_hash',encode(sha256(convert_to(t::text,'UTF8')),'hex'),
  'model',d->'model','environment','2','company_identity_version',identity_v,'company_fiscal_version',fiscal_v,
  'source_document_id',d->'source_document_id','source_document_version',d->'source_document_version','item_basis',items);
end$$;
create function public.erp_fiscal_completion_get(p_user_id uuid,p_draft_id uuid,p_version integer default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v integer;r jsonb;begin perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or(p_version is not null and p_version<1)then raise exception 'erp_fiscal_completion_query_invalid'using errcode='22023';end if;
 select version into v from erp_fiscal_completion.head where draft_id=p_draft_id;select record into r from erp_fiscal_completion.revision where draft_id=p_draft_id and version=coalesce(p_version,v);
 if p_version is not null and r is null then raise exception 'erp_fiscal_completion_not_found'using errcode='P0002';end if;return erp_fiscal_completion.envelope(p_draft_id,r);end$$;
create function public.erp_fiscal_completion_history(p_user_id uuid,p_draft_id uuid,p_limit integer default 25,p_before integer default null)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb;more boolean;begin perform erp_fiscal_drafts.require_access(p_user_id);
 if p_draft_id is null or p_limit is null or p_limit<1 or p_limit>25 or(p_before is not null and p_before<1)then raise exception 'erp_fiscal_completion_query_invalid'using errcode='22023';end if;
 perform erp_fiscal_completion.context(p_draft_id,null);
 select coalesce(jsonb_agg(record-array['item_basis','completion','pending']order by version desc),'[]')into items from(select record,version from erp_fiscal_completion.revision where draft_id=p_draft_id and(p_before is null or version<p_before)order by version desc limit p_limit)t;
 more:=jsonb_array_length(items)=p_limit and exists(select 1 from erp_fiscal_completion.revision where draft_id=p_draft_id and version<(items->-1->>'version')::integer);
 return erp_fiscal_completion.flags()||jsonb_build_object('draft_id',p_draft_id,'items',items,'limit',p_limit,'has_more',more,'next_cursor',case when more then(items->-1->>'version')::integer else null end);end$$;
create function public.erp_fiscal_completion_preview(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_item_preparation_version integer,
 p_tax_preparation_version integer,p_expected_identity_version integer,p_expected_fiscal_version integer,p_expected_completion_version integer,p_completion jsonb)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare r jsonb;pending jsonb;begin perform erp_fiscal_drafts.require_access(p_user_id);
 r:=erp_fiscal_completion.basis(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_item_preparation_version,p_tax_preparation_version,p_expected_identity_version,p_expected_fiscal_version,p_expected_completion_version);
 pending:=erp_fiscal_completion.validate(p_completion,r->>'model',r->'item_basis');
 r:=r||jsonb_build_object('completion',p_completion,'pending',pending,'created_at',null);
 if octet_length(r::text)>1048576 then raise exception 'erp_fiscal_completion_record_limit'using errcode='22023';end if;
 return erp_fiscal_completion.envelope(p_draft_id,r)||jsonb_build_object('persisted',false,'expected_completion_version',p_expected_completion_version);end$$;
create function public.erp_fiscal_completion_save(p_user_id uuid,p_draft_id uuid,p_expected_draft_version integer,p_snapshot_hash text,p_item_preparation_version integer,
 p_tax_preparation_version integer,p_expected_identity_version integer,p_expected_fiscal_version integer,p_expected_completion_version integer,p_completion jsonb,p_command_id uuid)returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;c erp_fiscal_completion.command%rowtype;parent uuid;r jsonb;at timestamptz;pending jsonb;begin
 perform erp_fiscal_drafts.require_access(p_user_id);
 if p_command_id is null or p_completion is null or jsonb_typeof(p_completion)<>'object'or octet_length(p_completion::text)>524288 then raise exception 'erp_fiscal_completion_command_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'draft_id',p_draft_id,'draft_version',p_expected_draft_version,'snapshot_hash',p_snapshot_hash,'item_version',p_item_preparation_version,
  'tax_version',p_tax_preparation_version,'identity_version',p_expected_identity_version,'fiscal_version',p_expected_fiscal_version,'expected_completion_version',p_expected_completion_version,'completion',p_completion)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(174852947,hashtext(p_command_id::text));select *into c from erp_fiscal_completion.command where command_id=p_command_id;
 if found then if c.actor<>p_user_id or c.request_hash<>h then raise exception 'erp_fiscal_completion_command_conflict'using errcode='40001';end if;return erp_fiscal_completion.envelope(p_draft_id,c.result)||jsonb_build_object('replayed',true);end if;
 select source_document_id into parent from erp_fiscal_drafts.draft where id=p_draft_id;if not found then raise exception 'erp_fiscal_completion_not_found'using errcode='P0002';end if;
 perform 1 from erp_documents.document where id=parent for share;
 perform 1 from erp_fiscal_drafts.draft where id=p_draft_id and source_document_id=parent for update;
 perform pg_advisory_xact_lock(174852920,1);
 perform 1 from erp_fiscal_items.head where draft_id=p_draft_id for share;
 perform 1 from erp_fiscal_tax.head where draft_id=p_draft_id for share;
 perform 1 from erp_fiscal_completion.head where draft_id=p_draft_id for update;
 r:=erp_fiscal_completion.basis(p_draft_id,p_expected_draft_version,p_snapshot_hash,p_item_preparation_version,p_tax_preparation_version,p_expected_identity_version,p_expected_fiscal_version,p_expected_completion_version);
 pending:=erp_fiscal_completion.validate(p_completion,r->>'model',r->'item_basis');at:=clock_timestamp();r:=r||jsonb_build_object('completion',p_completion,'pending',pending,'created_at',at);
 if octet_length(r::text)>1048576 then raise exception 'erp_fiscal_completion_record_limit'using errcode='22023';end if;
 insert into erp_fiscal_completion.revision(draft_id,version,draft_version,item_preparation_version,tax_preparation_version,snapshot_hash,record,actor,command_id,created_at)
 values(p_draft_id,p_expected_completion_version+1,p_expected_draft_version,p_item_preparation_version,p_tax_preparation_version,p_snapshot_hash,r,p_user_id,p_command_id,at);
 insert into erp_fiscal_completion.head values(p_draft_id,p_expected_completion_version+1)on conflict(draft_id)do update set version=excluded.version;
 insert into erp_fiscal_completion.command(command_id,actor,request_hash,result,created_at)values(p_command_id,p_user_id,h,r,at);
 return erp_fiscal_completion.envelope(p_draft_id,r)||jsonb_build_object('replayed',false);end$$;
revoke all on all functions in schema erp_fiscal_completion from public,anon,authenticated,service_role;
revoke all on function public.erp_fiscal_completion_get(uuid,uuid,integer),public.erp_fiscal_completion_history(uuid,uuid,integer,integer),
 public.erp_fiscal_completion_preview(uuid,uuid,integer,text,integer,integer,integer,integer,integer,jsonb),
 public.erp_fiscal_completion_save(uuid,uuid,integer,text,integer,integer,integer,integer,integer,jsonb,uuid)from public,anon,authenticated;
grant execute on function public.erp_fiscal_completion_get(uuid,uuid,integer),public.erp_fiscal_completion_history(uuid,uuid,integer,integer),
 public.erp_fiscal_completion_preview(uuid,uuid,integer,text,integer,integer,integer,integer,integer,jsonb),
 public.erp_fiscal_completion_save(uuid,uuid,integer,text,integer,integer,integer,integer,integer,jsonb,uuid)to service_role;
commit;
