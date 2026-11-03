-- Explicit reviewed import of full, open, single-occurrence Origin AP/AR.
-- No source writes, settlements, cash movements, bank files or automatic cutover.
begin;

create table erp_finance.origin_import_origin (
 entity text not null check(entity in('receivables','payables')),
 source_id text not null check(source_id ~ '^[0-9]{1,40}$' and source_id !~ '^0+$'),
 title_id uuid not null unique references erp_finance.title(id),
 command_id uuid not null references erp_finance.command(id),
 evidence jsonb not null check(jsonb_typeof(evidence)='object' and octet_length(evidence::text)<=16384),
 created_at timestamptz not null default clock_timestamp(),
 primary key(entity,source_id)
);
alter table erp_finance.origin_import_origin enable row level security;
revoke all on erp_finance.origin_import_origin from public,anon,authenticated,service_role;

create function erp_finance.origin_import_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
 raise exception 'erp_origin_import_immutable' using errcode='55000';
end $$;

create function erp_finance.origin_import_plan(p_actor uuid,p_entity text,p_items jsonb,p_duplicate_reviewed boolean)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare i jsonb;r origin_sync.raw_record%rowtype;c erp_catalog.record%rowtype;co erp_catalog.origin%rowtype;
 cr origin_sync.raw_record%rowtype;g erp_finance.category%rowtype;o origin_finance_refresh.origin%rowtype;a origin_finance_refresh.attempt%rowtype;
 prior erp_finance.origin_import_origin%rowtype;issues text[];rows jsonb:='[]';proofs jsonb:='[]';proposed jsonb;evidence jsonb;existing jsonb;
 amount jsonb;balance jsonb;source_contact text;status_code text;occurrence text;description text;issued date;due date;direction text;
 now_at timestamptz:=clock_timestamp();expires timestamptz;valid_until timestamptz;verified boolean;eligible integer:=0;total numeric:=0;
begin
 perform erp_cutover.require_admin(p_actor);perform erp_finance.origin_import_validate(p_entity,p_items,p_duplicate_reviewed);
 direction:=case p_entity when 'receivables' then 'receivable' else 'payable' end;
 for i in select value from jsonb_array_elements(p_items) loop
  issues:=array[]::text[];proposed:=null;existing:=null;expires:=null;verified:=false;
  c:=null;co:=null;cr:=null;g:=null;o:=null;a:=null;prior:=null;
  select * into r from origin_sync.raw_record where entity=p_entity and source_id=i->>'source_id';
  if not found then issues:=array_append(issues,'SOURCE_MISSING');
  elsif r.version_hash is distinct from i->>'source_hash' or r.version::text is distinct from i->>'source_version'
   or r.last_seen_at is distinct from (i->>'source_seen_at')::timestamptz then issues:=array_append(issues,'SOURCE_CHANGED');end if;
  if r.source_id is not null and erp_cutover.exact_id(r.payload->'id') is distinct from r.source_id then issues:=array_append(issues,'SOURCE_ID_MISMATCH');end if;
  status_code:=erp_cutover.financial_status(r.payload)->>'code';
  if status_code is distinct from '1' then issues:=array_append(issues,'STATUS_NOT_OPEN');end if;
  amount:=erp_cutover.financial_money(r.payload,'valor');balance:=erp_cutover.financial_money(r.payload,'saldo');
  if amount->>'state'<>'available' or coalesce((amount->>'cents')::numeric,0) not between 1 and 999999999999999 then issues:=array_append(issues,'AMOUNT_INVALID');end if;
  if balance->>'state'<>'available' or amount->>'cents' is null or balance->>'cents' is distinct from amount->>'cents' then issues:=array_append(issues,'BALANCE_NOT_FULL');end if;
  issued:=erp_cutover.financial_date(r.payload->'dataEmissao');due:=erp_cutover.financial_date(r.payload->'vencimento');
  if issued is null or due is null or due<issued then issues:=array_append(issues,'DATES_INVALID');end if;
  if issued>(now_at at time zone 'America/Sao_Paulo')::date then issues:=array_append(issues,'ISSUE_DATE_FUTURE');end if;
  description:=case when jsonb_typeof(r.payload->'historico')='string' then r.payload->>'historico' end;
  if description is null or length(btrim(description,U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0
   or length(description)>240 or description~'[[:cntrl:]]' then issues:=array_append(issues,'DESCRIPTION_INVALID');end if;
  occurrence:=case when jsonb_typeof(r.payload#>'{ocorrencia,tipo}') in('number','string') and r.payload#>>'{ocorrencia,tipo}'~'^[0-9]{1,3}$' then r.payload#>>'{ocorrencia,tipo}' end;
  if jsonb_typeof(r.payload->'ocorrencia') is distinct from 'object' or occurrence is distinct from '1'
   or (r.payload#>'{ocorrencia,numeroParcelas}' is not null and r.payload#>'{ocorrencia,numeroParcelas}'<>'null'::jsonb
    and (jsonb_typeof(r.payload#>'{ocorrencia,numeroParcelas}') not in('number','string') or r.payload#>>'{ocorrencia,numeroParcelas}'<>'1'))
   then issues:=array_append(issues,'OCCURRENCE_NOT_UNIQUE');end if;
  source_contact:=case when jsonb_typeof(r.payload->'contato')='object' then erp_cutover.exact_id(r.payload#>'{contato,id}') end;
  select * into co from erp_catalog.origin where entity='contacts' and source_id=source_contact;
  if found then
   select * into c from erp_catalog.record where id=co.record_id and entity='contacts' and exists(select 1 from erp_catalog.contact where record_id=co.record_id);
   select * into cr from origin_sync.raw_record where entity='contacts' and source_id=source_contact;
  end if;
  if c.id is null or not c.active or c.human_edited or co.state is distinct from 'synced' or co.candidate is not null
   or cr.version_hash is null or co.applied_hash is distinct from cr.version_hash or co.latest_hash is distinct from co.applied_hash
   then issues:=array_append(issues,'CONTACT_NOT_READY');end if;
  if i->'category_id'<>'null'::jsonb then
   select * into g from erp_finance.category where id=(i->>'category_id')::uuid;
   if not found or not g.active or g.kind not in(direction,'both') or g.version is distinct from (i->>'category_version')::integer then issues:=array_append(issues,'CATEGORY_NOT_READY');end if;
  end if;
  select * into o from origin_finance_refresh.origin where entity=p_entity and source_id=i->>'source_id';
  if o.current_attempt is not null then select * into a from origin_finance_refresh.attempt where id=o.current_attempt and entity=p_entity and source_id=i->>'source_id';end if;
  verified:=coalesce(a.state='stored' and a.response_status='1' and a.result_hash=r.version_hash and a.result_version=r.version
   and a.finished_at=o.last_success_at and a.finished_at<=now_at and o.last_attempt_at<=a.finished_at
   and r.last_seen_at>=a.finished_at and r.last_seen_at<=now_at and o.failures=0 and o.last_error is null,false);
  if not verified then issues:=array_append(issues,'REFRESH_NOT_VERIFIED');
  else expires:=a.finished_at+interval '60 minutes';if expires<=now_at then issues:=array_append(issues,'REFRESH_EXPIRED');end if;end if;
  select * into prior from erp_finance.origin_import_origin where entity=p_entity and source_id=i->>'source_id';
  if found then
   issues:=array_append(issues,'SOURCE_ALREADY_IMPORTED');existing:=jsonb_build_object('title_id',prior.title_id,'batch_id',prior.command_id,'imported_at',prior.created_at);
  end if;
  evidence:=jsonb_build_object('status_code',status_code,'amount_cents',amount->>'cents','balance_cents',balance->>'cents',
   'occurrence_type',occurrence,'contact_source_id',source_contact,'refresh_finished_at',a.finished_at);
  if cardinality(issues)=0 then
   proposed:=jsonb_build_object('kind',direction,'contact_id',c.id,'contact_version',c.version,'contact_name',c.name,
    'category_id',g.id,'category_version',g.version,'category_name',g.name,'description',description,
    'source_reference',case p_entity when 'receivables' then 'Origin AR ' else 'Origin AP ' end||r.source_id,
    'issued_on',issued,'due_on',due,'amount_cents',amount->>'cents','settled_cents','0','installment',1,'installments',1);
   eligible:=eligible+1;total:=total+(amount->>'cents')::numeric;valid_until:=least(valid_until,expires);
  end if;
  rows:=rows||jsonb_build_array(jsonb_build_object('source_id',i->>'source_id','source_hash',i->>'source_hash','source_version',i->>'source_version','source_seen_at',i->>'source_seen_at',
   'status',case when prior.title_id is not null then 'already_imported' when proposed is null then 'blocked' else 'eligible' end,
   'blockers',to_jsonb(issues),'evidence',evidence,'proposed',proposed,'existing',existing));
  -- Compact immutable proof; no raw payload, URLs, contact documents or arbitrary source fields.
  proofs:=proofs||jsonb_build_array(jsonb_build_object('source_hash',r.version_hash,'source_version',r.version::text,'source_seen_at',r.last_seen_at,
   'contact_id',c.id,'contact_version',c.version,'contact_origin_state',co.state,'contact_applied_hash',co.applied_hash,'contact_latest_hash',co.latest_hash,
   'contact_source_hash',cr.version_hash,'contact_source_version',cr.version::text,'contact_source_seen_at',cr.last_seen_at,
   'contact_human_edited',c.human_edited,'contact_candidate',co.candidate is not null,'contact_active',c.active,
   'category_id',g.id,'category_version',g.version,'category_active',g.active,'category_kind',g.kind,
   'refresh_attempt',a.id,'refresh_state',a.state,'refresh_result_hash',a.result_hash,'refresh_result_version',a.result_version::text,
   'refresh_finished_at',a.finished_at,'refresh_last_success_at',o.last_success_at,'refresh_current_attempt',o.current_attempt,'valid_until',expires));
 end loop;
 return jsonb_build_object('data_mode','financial_import_review','policy','origin-open-unique-v1','cutoff_at',null,'coverage_certified',false,
  'creates_titles',true,'settles_titles',false,'changes_cash_balance',false,'bank_actions',false,'dry_run',true,'persisted',false,'entity',p_entity,'duplicate_reviewed',true,
  'preview_hash',encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'entity',p_entity,'input',p_items,'duplicate_reviewed',true,'items',rows,'proofs',proofs)::text,'UTF8')),'hex'),
  'valid_until',case when eligible=jsonb_array_length(p_items) then valid_until end,'can_apply',eligible=jsonb_array_length(p_items),
  'items',rows,'summary',jsonb_build_object('selected',jsonb_array_length(p_items),'eligible',eligible,'blocked',jsonb_array_length(p_items)-eligible,'total_cents',total::text));
end $$;
create trigger immutable_origin_import_origin before update or delete on erp_finance.origin_import_origin
 for each row execute function erp_finance.origin_import_immutable();

create function erp_finance.origin_import_command_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$ begin
 if OLD.result->>'action'='origin_import_batch' then raise exception 'erp_origin_import_immutable' using errcode='55000';end if;
 if TG_OP='DELETE' then return OLD;end if;return NEW;
end $$;
create trigger immutable_origin_import_receipt before update or delete on erp_finance.command
 for each row execute function erp_finance.origin_import_command_immutable();

create function erp_finance.guard_origin_import_title() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$ begin
 if exists(select 1 from erp_finance.origin_import_origin where title_id=OLD.id) then
  if TG_OP='DELETE' then raise exception 'erp_origin_import_title_locked' using errcode='40001';end if;
  if (NEW.id,NEW.group_id,NEW.installment,NEW.installments,NEW.kind,NEW.contact_id,NEW.issued_on,NEW.amount_cents,NEW.source_reference)
    is distinct from (OLD.id,OLD.group_id,OLD.installment,OLD.installments,OLD.kind,OLD.contact_id,OLD.issued_on,OLD.amount_cents,OLD.source_reference)
   then raise exception 'erp_origin_import_title_locked' using errcode='40001';end if;
 end if;
 if TG_OP='DELETE' then return OLD;end if;return NEW;
end $$;
create trigger protect_origin_import_title before update or delete on erp_finance.title
 for each row execute function erp_finance.guard_origin_import_title();

create function erp_finance.guard_origin_import_billing() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$ begin
 if exists(select 1 from erp_finance.origin_import_origin where title_id=NEW.title_id) then
  raise exception 'erp_origin_import_bank_mapping_pending' using errcode='40001';end if;
 return NEW;
end $$;
create trigger protect_origin_import_billing before insert or update of title_id on erp_cnab.billing_title
 for each row execute function erp_finance.guard_origin_import_billing();

create function erp_finance.origin_import_validate(p_entity text,p_items jsonb,p_duplicate_reviewed boolean)
returns void language plpgsql immutable set search_path=pg_catalog as $$ declare i jsonb;v numeric;t timestamptz;begin
 if p_entity is null or p_entity not in('receivables','payables') or p_duplicate_reviewed is distinct from true
  or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 25
  or octet_length(p_items::text)>65536 then raise exception 'erp_origin_import_invalid' using errcode='22023';end if;
 for i in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(i)<>'object' or (select count(*)from jsonb_object_keys(i))<>6
   or exists(select 1 from jsonb_object_keys(i) k where k not in('source_id','source_hash','source_version','source_seen_at','category_id','category_version'))
   or jsonb_typeof(i->'source_id') is distinct from 'string' or i->>'source_id'!~'^[0-9]{1,40}$' or i->>'source_id'~'^0+$'
   or jsonb_typeof(i->'source_hash') is distinct from 'string' or i->>'source_hash'!~'^[0-9a-f]{64}$'
   or jsonb_typeof(i->'source_version') is distinct from 'string' or i->>'source_version'!~'^[1-9][0-9]{0,18}$'
   or jsonb_typeof(i->'source_seen_at') is distinct from 'string' or length(i->>'source_seen_at')>60
   or i->>'source_seen_at'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then raise exception 'erp_origin_import_invalid_item' using errcode='22023';end if;
  v:=(i->>'source_version')::numeric;if v>9223372036854775807 then raise exception 'erp_origin_import_invalid_version' using errcode='22023';end if;
  begin t:=(i->>'source_seen_at')::timestamptz;exception when others then raise exception 'erp_origin_import_invalid_time' using errcode='22023';end;
  if not isfinite(t) then raise exception 'erp_origin_import_invalid_time' using errcode='22023';end if;
  if i->'category_id'='null'::jsonb then
   if i->'category_version'<>'null'::jsonb then raise exception 'erp_origin_import_invalid_category' using errcode='22023';end if;
  else
   perform erp_finance.uuid_value(i->'category_id');perform erp_finance.expected(i->'category_version');
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_items)x group by x->>'source_id' having count(*)>1) then
  raise exception 'erp_origin_import_duplicate_source' using errcode='22023';end if;
end $$;

create function erp_finance.origin_import_current_title(p_id uuid) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',id,'version',version,'kind',kind,'contact_id',contact_id,'category_id',category_id,
  'description',description,'source_reference',source_reference,'issued_on',issued_on,'due_on',due_on,
  'amount_cents',amount_cents::text,'settled_cents',settled_cents::text,'balance_cents',(amount_cents-settled_cents)::text,
  'cancelled',cancelled,'status',case when cancelled then 'cancelled' when settled_cents=0 then 'open' when settled_cents=amount_cents then 'paid' else 'partial' end)
 from erp_finance.title where id=p_id;
$$;

create function public.erp_origin_financial_import_preview(p_user_id uuid,p_entity text,p_items jsonb,p_duplicate_reviewed boolean)
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
 select erp_finance.origin_import_plan(p_user_id,p_entity,p_items,p_duplicate_reviewed);
$$;

create function public.erp_origin_financial_import_apply(p_user_id uuid,p_entity text,p_items jsonb,p_duplicate_reviewed boolean,
 p_command_id uuid,p_preview_hash text,p_confirm_import boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;command erp_finance.command%rowtype;plan jsonb;row jsonb;p jsonb;receipt jsonb;result jsonb;items jsonb:='[]';evidences jsonb:='[]';item jsonb;
 contact_ids uuid[];contact_sources text[];title uuid;created timestamptz;source_id text;attempt_id uuid;contact_source origin_sync.raw_record%rowtype;
begin
 perform erp_cutover.require_admin(p_user_id);perform erp_finance.origin_import_validate(p_entity,p_items,p_duplicate_reviewed);
 if p_command_id is null or p_preview_hash is null or p_preview_hash!~'^[0-9a-f]{64}$' or p_confirm_import is distinct from true
  then raise exception 'erp_origin_import_confirmation_required' using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','origin_import_batch','entity',p_entity,'items',p_items,
  'duplicate_reviewed',p_duplicate_reviewed,'preview_hash',p_preview_hash,'confirm_import',p_confirm_import)::text,'UTF8')),'hex');
 -- Shared with 010: one global finance command identity, not one command per title.
 perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
 select * into command from erp_finance.command where id=p_command_id;
 if found then
  if command.actor<>p_user_id or command.request_hash<>h or command.result->>'action' is distinct from 'origin_import_batch'
   then raise exception 'erp_finance_command_conflict' using errcode='40001';end if;
  return (command.result-'action')||jsonb_build_object('replayed',true);
 end if;
 perform pg_advisory_xact_lock(174852939,hashtext(p_entity));
 -- Capture parents first, matching catalog013's parent -> source ordering. A later
 -- changed mapping is a conflict, never an out-of-order late parent lock.
 select array_agg(distinct o.record_id),array_agg(distinct erp_cutover.exact_id(r.payload#>'{contato,id}')) into contact_ids,contact_sources
 from origin_sync.raw_record r join jsonb_array_elements(p_items)i on i->>'source_id'=r.source_id
 left join erp_catalog.origin o on o.entity='contacts' and o.source_id=erp_cutover.exact_id(r.payload#>'{contato,id}') where r.entity=p_entity;
 perform id from erp_catalog.record where id=any(contact_ids) order by id for share;
 perform record_id from erp_catalog.contact where record_id=any(contact_ids) order by record_id for share;
 perform id from erp_finance.category where id in(select (i->>'category_id')::uuid from jsonb_array_elements(p_items)i where i->'category_id'<>'null'::jsonb) order by id for share;
 perform r.source_id from origin_sync.raw_record r
  where (r.entity=p_entity and r.source_id in(select i->>'source_id' from jsonb_array_elements(p_items)i))
   or(r.entity='contacts' and r.source_id=any(contact_sources))
  order by r.entity collate "C",r.source_id collate "C" for share;
 if exists(select 1 from origin_sync.raw_record r join jsonb_array_elements(p_items)i on i->>'source_id'=r.source_id
   left join erp_catalog.origin o on o.entity='contacts' and o.source_id=erp_cutover.exact_id(r.payload#>'{contato,id}')
   where r.entity=p_entity and (o.record_id is not null and not coalesce(o.record_id=any(contact_ids),false)
    or erp_cutover.exact_id(r.payload#>'{contato,id}') is not null and not coalesce(erp_cutover.exact_id(r.payload#>'{contato,id}')=any(contact_sources),false)))
  then raise exception 'erp_origin_import_contact_changed' using errcode='40001';end if;
 perform o.source_id from origin_finance_refresh.origin o where o.entity=p_entity and o.source_id in(select i->>'source_id' from jsonb_array_elements(p_items)i)
  order by o.source_id collate "C" for share;
 -- No attempt lock: finalized attempts are immutable. 030 finish takes attempt
 -- before raw, so taking an attempt lock here would introduce an inverse order.
 plan:=erp_finance.origin_import_plan(p_user_id,p_entity,p_items,p_duplicate_reviewed);
 if plan->>'preview_hash'<>p_preview_hash or plan->'can_apply'<>'true'::jsonb then raise exception 'erp_origin_import_preview_conflict' using errcode='40001';end if;
 created:=clock_timestamp();
 for row in select value from jsonb_array_elements(plan->'items') loop
  p:=row->'proposed';source_id:=row->>'source_id';
  insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents)
   values(gen_random_uuid(),1,1,p->>'kind',(p->>'contact_id')::uuid,(p->>'category_id')::uuid,p->>'description',p->>'source_reference',
    (p->>'issued_on')::date,(p->>'due_on')::date,(p->>'amount_cents')::bigint) returning id into title;
  item:=jsonb_build_object('source_id',source_id,'title_id',title,'source_hash',row->>'source_hash','source_version',row->>'source_version','source_seen_at',row->>'source_seen_at',
   'refresh_finished_at',row#>>'{evidence,refresh_finished_at}','contact_id',p->'contact_id','contact_version',p->'contact_version',
   'category_id',p->'category_id','category_version',p->'category_version','kind',p->>'kind','description',p->>'description',
   'source_reference',p->>'source_reference','issued_on',p->>'issued_on','due_on',p->>'due_on','amount_cents',p->>'amount_cents');
  items:=items||jsonb_build_array(item);
  select current_attempt into attempt_id from origin_finance_refresh.origin o where o.entity=p_entity and o.source_id=row->>'source_id';
  select * into contact_source from origin_sync.raw_record where entity='contacts' and origin_sync.raw_record.source_id=row#>>'{evidence,contact_source_id}';
  evidences:=evidences||jsonb_build_array(item||(row->'evidence')||jsonb_build_object('refresh_attempt_id',attempt_id,
   'contact_name',p->>'contact_name','category_name',p->>'category_name','contact_source_hash',contact_source.version_hash,
   'contact_source_version',contact_source.version::text,'policy','origin-open-unique-v1','duplicate_reviewed',true));
 end loop;
 receipt:=jsonb_build_object('id',p_command_id,'entity',p_entity,'created_at',created,'preview_hash',p_preview_hash,'duplicate_reviewed',true,
  'items',items,'total_cents',plan#>>'{summary,total_cents}');
 result:=jsonb_build_object('data_mode','financial_import_review','policy','origin-open-unique-v1','cutoff_at',null,'coverage_certified',false,
  'creates_titles',true,'settles_titles',false,'changes_cash_balance',false,'bank_actions',false,'dry_run',false,'persisted',true,'replayed',false,'batch',receipt);
 insert into erp_finance.command(id,actor,request_hash,result)values(p_command_id,p_user_id,h,result||jsonb_build_object('action','origin_import_batch'));
 for item in select value from jsonb_array_elements(evidences) loop
  insert into erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence,created_at)
   values(p_entity,item->>'source_id',(item->>'title_id')::uuid,p_command_id,item,created);
 end loop;
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)values(p_user_id,p_command_id,'origin_import_batch',null,result);
 if (plan->>'valid_until')::timestamptz<=clock_timestamp() then raise exception 'erp_origin_import_preview_expired' using errcode='40001';end if;
 return result;
end $$;

create function public.erp_origin_financial_import_batch(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare r jsonb;current_rows jsonb;begin
 perform erp_cutover.require_admin(p_user_id);
 select result into r from erp_finance.command where id=p_command_id and result->>'action'='origin_import_batch';
 if not found then raise exception 'erp_origin_import_not_found' using errcode='P0002';end if;
 select jsonb_agg(erp_finance.origin_import_current_title((i->>'title_id')::uuid) order by n) into current_rows from jsonb_array_elements(r#>'{batch,items}')with ordinality x(i,n);
 return (r-'action'-'dry_run'-'persisted'-'replayed')||jsonb_build_object('read_only',true,'current_titles',current_rows);
end $$;

create function public.erp_origin_financial_import_origin(p_user_id uuid,p_entity text,p_source_id text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare o erp_finance.origin_import_origin;begin
 perform erp_cutover.require_admin(p_user_id);
 if p_entity is null or p_entity not in('receivables','payables') or p_source_id is null or p_source_id!~'^[0-9]{1,40}$' or p_source_id~'^0+$'
  then raise exception 'erp_origin_import_invalid_source' using errcode='22023';end if;
 select * into o from erp_finance.origin_import_origin where entity=p_entity and source_id=p_source_id;
 if not found then raise exception 'erp_origin_import_not_found' using errcode='P0002';end if;
 return jsonb_build_object('data_mode','financial_import_review','policy','origin-open-unique-v1','cutoff_at',null,'coverage_certified',false,
  'creates_titles',true,'settles_titles',false,'changes_cash_balance',false,'bank_actions',false,'read_only',true,
  'origin',jsonb_build_object('entity',o.entity,'source_id',o.source_id,'title_id',o.title_id,'batch_id',o.command_id,'imported_at',o.created_at,
   'source_hash',o.evidence->>'source_hash','source_version',o.evidence->>'source_version','source_seen_at',o.evidence->>'source_seen_at','refresh_finished_at',o.evidence->>'refresh_finished_at'),
  'current_title',erp_finance.origin_import_current_title(o.title_id));
end $$;

create function public.erp_origin_financial_import_title_origin(p_user_id uuid,p_title_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare o erp_finance.origin_import_origin;begin
 perform erp_finance.require_access(p_user_id,false);
 if p_title_id is null or not exists(select 1 from erp_finance.title where id=p_title_id) then raise exception 'erp_origin_import_not_found' using errcode='P0002';end if;
 select * into o from erp_finance.origin_import_origin where title_id=p_title_id;
 return jsonb_build_object('data_mode','erp_native','read_only',true,'title_id',p_title_id,'origin',case when o.title_id is not null then
  jsonb_build_object('system','origin','entity',o.entity,'source_id',o.source_id,'batch_id',o.command_id,'imported_at',o.created_at,
   'source_hash',o.evidence->>'source_hash','source_version',o.evidence->>'source_version','core_fields_locked',true,'cnab_reservation_blocked',true) end);
end $$;

revoke all on function erp_finance.origin_import_immutable(),erp_finance.origin_import_command_immutable(),erp_finance.guard_origin_import_title(),
 erp_finance.guard_origin_import_billing(),erp_finance.origin_import_validate(text,jsonb,boolean),erp_finance.origin_import_plan(uuid,text,jsonb,boolean),
 erp_finance.origin_import_current_title(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_origin_financial_import_preview(uuid,text,jsonb,boolean),public.erp_origin_financial_import_apply(uuid,text,jsonb,boolean,uuid,text,boolean),
 public.erp_origin_financial_import_batch(uuid,uuid),public.erp_origin_financial_import_origin(uuid,text,text),public.erp_origin_financial_import_title_origin(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_origin_financial_import_preview(uuid,text,jsonb,boolean),public.erp_origin_financial_import_apply(uuid,text,jsonb,boolean,uuid,text,boolean),
 public.erp_origin_financial_import_batch(uuid,uuid),public.erp_origin_financial_import_origin(uuid,text,text),public.erp_origin_financial_import_title_origin(uuid,uuid) to service_role;
commit;
