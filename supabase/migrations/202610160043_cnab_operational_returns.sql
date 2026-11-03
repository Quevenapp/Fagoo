-- Operational returns: explicit bank-number binding and exact payment, never automatic posting.
begin;
create table erp_cnab.operational_binding(
 event_id uuid primary key references erp_cnab.return_event(id),billing_title_id uuid not null unique references erp_cnab.billing_title(id),
 profile_id uuid not null references erp_cnab.profile(id),our_number text not null check(our_number~'^[0-9]{11}$'),
 file_id uuid not null,line integer not null,context_hash text not null check(context_hash~'^[a-f0-9]{64}$'),
 command_id uuid not null unique,actor uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 foreign key(file_id,line)references erp_cnab.return_occurrence(file_id,line)
);
create table erp_cnab.operational_settlement(
 event_id uuid primary key references erp_cnab.return_event(id),billing_title_id uuid not null unique references erp_cnab.billing_title(id),
 title_id uuid not null unique references erp_finance.title(id),settlement_id uuid not null unique references erp_finance.settlement(id),
 profile_id uuid not null references erp_cnab.profile(id),file_id uuid not null,line integer not null,
 command_id uuid not null unique references erp_finance.command(id),actor uuid not null references auth.users(id),
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),receipt jsonb not null,
 created_at timestamptz not null default clock_timestamp(),foreign key(file_id,line)references erp_cnab.return_occurrence(file_id,line)
);
alter table erp_cnab.operational_binding enable row level security;
alter table erp_cnab.operational_settlement enable row level security;
revoke all on erp_cnab.operational_binding,erp_cnab.operational_settlement from public,anon,authenticated,service_role;
create trigger operational_binding_immutable before update or delete on erp_cnab.operational_binding for each row execute function erp_cnab.operational_revision_immutable();
create trigger operational_settlement_immutable before update or delete on erp_cnab.operational_settlement for each row execute function erp_cnab.operational_revision_immutable();
create function erp_cnab.operational_evidence_immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if(TG_TABLE_NAME in('return_file','return_event')and OLD.purpose='operational')then raise exception 'erp_cnab_operational_evidence_immutable'using errcode='42501';end if;return case when TG_OP='DELETE'then OLD else NEW end;
end $$;
create trigger operational_return_file_immutable before update or delete on erp_cnab.return_file for each row execute function erp_cnab.operational_evidence_immutable();
create trigger operational_return_event_immutable before update or delete on erp_cnab.return_event for each row execute function erp_cnab.operational_evidence_immutable();
create function erp_cnab.operational_occurrence_immutable()returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if exists(select 1 from erp_cnab.return_file where id=OLD.file_id and purpose='operational')then raise exception 'erp_cnab_operational_evidence_immutable'using errcode='42501';end if;return case when TG_OP='DELETE'then OLD else NEW end;
end $$;
create trigger operational_occurrence_immutable before update or delete on erp_cnab.return_occurrence for each row execute function erp_cnab.operational_occurrence_immutable();

create function public.erp_cnab_operational_return_profile(p_user_id uuid,p_profile_id uuid,p_expected_approval integer)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$begin
 perform erp_cnab.access(p_user_id,true);if p_expected_approval is null or p_expected_approval<1 then raise exception 'erp_cnab_operational_approval_required'using errcode='22023';end if;
 perform erp_cnab.require_operational(p_profile_id,p_expected_approval);return jsonb_build_object('profile',erp_cnab.core_profile(p_profile_id),'approval_version',p_expected_approval);
end $$;
create function public.erp_cnab_operational_return_commit(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_approval integer,p_file jsonb,p_events jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile;f erp_cnab.return_file;e erp_cnab.return_event;r jsonb;payload jsonb;cmd jsonb;replay jsonb;eid uuid;bill uuid;n integer;i integer;is_duplicate boolean;added integer:=0;duplicates integer:=0;begin
 perform erp_cnab.access(p_user_id,true);perform erp_finance.keys(p_file,array['hash','size','path','generated_on','century','record_count','warnings','evidence']);
 if p_expected_approval is null or p_expected_approval<1 or jsonb_typeof(p_events)is distinct from'array'or jsonb_array_length(p_events)>9998 or octet_length(p_events::text)>16000000 then raise exception 'erp_cnab_operational_return_invalid'using errcode='22023';end if;
 cmd:=jsonb_build_object('profile_id',p_profile_id,'approval_version',p_expected_approval,'file',p_file);replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_return',cmd);
 perform pg_advisory_xact_lock(174852920,1);select * into p from erp_cnab.profile where id=p_profile_id for update;if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 perform erp_cnab.require_operational(p.id,p_expected_approval);if replay is not null then return replay;end if;
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

create function erp_cnab.operational_event_context(p_event_id uuid,p_file_id uuid,p_line integer)returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e erp_cnab.return_event;f erp_cnab.return_file;o erp_cnab.return_occurrence;p erp_cnab.profile;b erp_cnab.billing_title;t erp_finance.title;a erp_finance.account;
 auth jsonb;context jsonb;issues text[]:='{}';bind_issues text[];settle_issues text[];today date:=(clock_timestamp()at time zone'America/Sao_Paulo')::date;opening date;declared boolean;begin
 select * into e from erp_cnab.return_event where id=p_event_id and purpose='operational';select * into o from erp_cnab.return_occurrence where file_id=p_file_id and line=p_line and event_id=p_event_id;
 select * into f from erp_cnab.return_file where id=p_file_id and purpose='operational'and profile_id=e.profile_id;
 if e.id is null or o.event_id is null or f.id is null then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;
 select * into p from erp_cnab.profile where id=e.profile_id;select * into a from erp_finance.account where id=p.account_id;
 select * into b from erp_cnab.billing_title where id=e.billing_title_id and profile_id=p.id;select * into t from erp_finance.title where id=b.title_id;
 auth:=erp_cnab.operational_status(p.id);select posted_on into opening from erp_finance.movement where account_id=a.id and kind='opening';
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
create function erp_cnab.operational_context_hash(p_context jsonb)returns text language sql immutable set search_path=pg_catalog as $$select encode(sha256(convert_to(p_context::text,'UTF8')),'hex')$$;
create function public.erp_cnab_operational_event(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c jsonb;begin
 perform erp_cnab.access(p_user_id);c:=erp_cnab.operational_event_context(p_event_id,p_file_id,p_line);
 return erp_cnab.operational_safety()||jsonb_build_object('event_id',p_event_id,'context_hash',erp_cnab.operational_context_hash(c),'context',c,'bytes_verified',false);
end $$;
create function public.erp_cnab_operational_return_verify(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c jsonb;f erp_cnab.return_file;begin
 perform erp_cnab.access(p_user_id,true);c:=public.erp_cnab_operational_event(p_user_id,p_event_id,p_file_id,p_line);select * into f from erp_cnab.return_file where id=p_file_id;
 perform erp_cnab.storage_check(f.profile_id,'returns',f.file_hash,f.byte_size,f.object_path);
 return jsonb_build_object('detail',c,'profile',erp_cnab.core_profile(f.profile_id),'file',jsonb_build_object('id',f.id,'profile_id',f.profile_id,'hash',f.file_hash,'size',f.byte_size,'path',f.object_path,'century',f.century),
  'payload',(select payload from erp_cnab.return_event where id=p_event_id));
end $$;

create function erp_cnab.lock_operational_event(p_event uuid,p_file uuid,p_line integer,p_approval integer)returns uuid language plpgsql set search_path=pg_catalog as $$declare pid uuid;bill uuid;tid uuid;aid uuid;begin
 select profile_id,billing_title_id into pid,bill from erp_cnab.return_event where id=p_event and purpose='operational';if not found then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(174852920,1);select account_id into aid from erp_cnab.profile where id=pid for update;
 perform 1 from erp_cnab.return_event where id=p_event for update;select title_id into tid from erp_cnab.billing_title where id=bill for update;
 perform 1 from erp_finance.title where id=tid for update;perform 1 from erp_finance.account where id=aid for update;
 perform erp_cnab.require_operational(pid,p_approval);if not exists(select 1 from erp_cnab.return_occurrence where event_id=p_event and file_id=p_file and line=p_line)then raise exception 'erp_cnab_operational_event_not_found'using errcode='P0002';end if;return pid;
end $$;
create function public.erp_cnab_operational_bind(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,p_expected_approval integer,p_command_id uuid,p_context_hash text,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare cmd jsonb;replay jsonb;c jsonb;pid uuid;bid uuid;f erp_cnab.return_file;begin
 perform erp_cnab.access(p_user_id,true);if p_confirm is distinct from true or p_expected_approval is null or p_expected_approval<1 or p_context_hash is null or p_context_hash!~'^[a-f0-9]{64}$'then raise exception 'erp_cnab_operational_confirmation_required'using errcode='22023';end if;
 cmd:=jsonb_build_object('event_id',p_event_id,'file_id',p_file_id,'line',p_line,'approval_version',p_expected_approval,'context_hash',p_context_hash);replay:=erp_cnab.start_command(p_user_id,p_command_id,'operational_bind',cmd);
 pid:=erp_cnab.lock_operational_event(p_event_id,p_file_id,p_line,p_expected_approval);if replay is not null then return replay;end if;
 c:=erp_cnab.operational_event_context(p_event_id,p_file_id,p_line);if erp_cnab.operational_context_hash(c)<>p_context_hash or c#>'{binding,allowed}'is distinct from'true'::jsonb then raise exception 'erp_cnab_operational_review_changed'using errcode='40001';end if;
 select * into f from erp_cnab.return_file where id=p_file_id;perform erp_cnab.storage_check(pid,'returns',f.file_hash,f.byte_size,f.object_path);
 bid:=(c#>>'{billing,id}')::uuid;update erp_cnab.billing_title set our_number=c#>>'{event,our_number}'where id=bid and our_number is null;if not found then raise exception 'erp_cnab_operational_review_changed'using errcode='40001';end if;
 insert into erp_cnab.operational_binding(event_id,billing_title_id,profile_id,our_number,file_id,line,context_hash,command_id,actor)values(p_event_id,bid,pid,c#>>'{event,our_number}',p_file_id,p_line,p_context_hash,p_command_id,p_user_id);
 return erp_cnab.operational_finish(p_user_id,p_command_id,'operational_bind',cmd,p_event_id,jsonb_build_object('event_id',p_event_id,'billing_title_id',bid,'our_number',c#>>'{event,our_number}','command_id',p_command_id,'bound',true));
end $$;
create function public.erp_cnab_operational_settle(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,p_expected_approval integer,p_command_id uuid,p_context_hash text,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare cmd jsonb;request_hash text;prior erp_cnab.operational_settlement;c jsonb;pid uuid;result jsonb;receipt jsonb;f erp_cnab.return_file;begin
 perform erp_cnab.access(p_user_id,true);if p_command_id is null or p_confirm is distinct from true or p_expected_approval is null or p_expected_approval<1 or p_context_hash is null or p_context_hash!~'^[a-f0-9]{64}$'then raise exception 'erp_cnab_operational_confirmation_required'using errcode='22023';end if;
 cmd:=jsonb_build_object('actor',p_user_id,'event_id',p_event_id,'file_id',p_file_id,'line',p_line,'approval_version',p_expected_approval,'context_hash',p_context_hash);request_hash:=encode(sha256(convert_to(cmd::text,'UTF8')),'hex');
 -- Acquire010 command namespace FIRST; the engine later reacquires this same lock reentrantly.
 perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));select * into prior from erp_cnab.operational_settlement where command_id=p_command_id;
 if prior.command_id is not null and(prior.actor<>p_user_id or prior.request_hash<>request_hash)then raise exception 'erp_cnab_operational_command_conflict'using errcode='40001';end if;
 if prior.command_id is null and exists(select 1 from erp_finance.command where id=p_command_id)then raise exception 'erp_cnab_operational_command_conflict'using errcode='40001';end if;
 pid:=erp_cnab.lock_operational_event(p_event_id,p_file_id,p_line,p_expected_approval);
 if prior.command_id is not null then return jsonb_build_object('purpose','operational','originAuthenticated',false,'bankTransmissionPerformed',false,'financialMutationPerformed',true,'replayed',true,'receipt',prior.receipt);end if;
 c:=erp_cnab.operational_event_context(p_event_id,p_file_id,p_line);if erp_cnab.operational_context_hash(c)<>p_context_hash or c#>'{settlement,allowed}'is distinct from'true'::jsonb then raise exception 'erp_cnab_operational_review_changed'using errcode='40001';end if;
 select * into f from erp_cnab.return_file where id=p_file_id;perform erp_cnab.storage_check(pid,'returns',f.file_hash,f.byte_size,f.object_path);
 result:=public.erp_finance_execute(p_user_id,p_command_id,'settle',jsonb_build_object('id',c#>'{title,id}','expected_version',c#>'{title,version}','account_id',c#>'{account,id}','posted_on',c#>'{event,credited_on}','principal_cents',c#>'{event,paid_cents}','note','CNAB operacional: evento '||p_event_id::text));
 receipt:=jsonb_build_object('command_id',p_command_id,'event_id',p_event_id,'event_hash',c#>'{event,hash}','file_id',p_file_id,'file_hash',f.file_hash,'line',p_line,'profile_id',pid,'approval_version',p_expected_approval,'context_hash',p_context_hash,'billing_title_id',c#>'{billing,id}','title_id',c#>'{title,id}','account_id',c#>'{account,id}','settlement_id',result#>'{settlement,id}','posted_on',c#>'{event,credited_on}','principal_cents',c#>'{event,paid_cents}','net_cash_cents',c#>'{event,paid_cents}','created_at',clock_timestamp());
 insert into erp_cnab.operational_settlement(event_id,billing_title_id,title_id,settlement_id,profile_id,file_id,line,command_id,actor,request_hash,receipt)
  values(p_event_id,(c#>>'{billing,id}')::uuid,(c#>>'{title,id}')::uuid,(result#>>'{settlement,id}')::uuid,pid,p_file_id,p_line,p_command_id,p_user_id,request_hash,receipt);
 insert into erp_cnab.audit(actor,command_id,action,record_id)values(p_user_id,p_command_id,'operational_settle',p_event_id);
 return jsonb_build_object('purpose','operational','originAuthenticated',false,'bankTransmissionPerformed',false,'financialMutationPerformed',true,'replayed',false,'receipt',receipt);
end $$;
create function public.erp_cnab_operational_settlement_get(p_user_id uuid,p_command_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare r erp_cnab.operational_settlement;begin
 perform erp_cnab.access(p_user_id);select * into r from erp_cnab.operational_settlement where command_id=p_command_id;if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 return jsonb_build_object('purpose','operational','read_only',true,'financialMutationPerformed',false,'originAuthenticated',false,'bankTransmissionPerformed',false,'receipt',r.receipt,'current_title',erp_finance.dto('titles',r.title_id),'current_account',erp_finance.dto('accounts',(r.receipt->>'account_id')::uuid),'current_settlement',erp_finance.dto('settlements',r.settlement_id));
end $$;
create function public.erp_cnab_operational_events(p_user_id uuid,p_file_id uuid,p_limit integer default 25,p_after integer default 1)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare rows jsonb;more boolean;last_line integer;begin
 perform erp_cnab.access(p_user_id);if p_limit is null or p_limit not between 1 and 100 or p_after is null or p_after not between 1 and 9999 then raise exception 'erp_cnab_invalid_query'using errcode='22023';end if;
 if not exists(select 1 from erp_cnab.return_file where id=p_file_id and purpose='operational')then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 select coalesce(jsonb_agg(jsonb_build_object('line',x.line,'duplicate',x.duplicate,'event_id',x.id,'kind',x.payload->'kind','occurrence',x.payload->'occurrence','control',x.payload->'control','document_number',x.payload->'documentNumber','amount_cents',x.payload->'amountCents','paid_cents',x.payload->'paidCents','binding_command_id',(select command_id from erp_cnab.operational_binding where event_id=x.id),'settlement_command_id',(select command_id from erp_cnab.operational_settlement where event_id=x.id))order by x.line),'[]'),max(x.line)into rows,last_line from(select o.line,o.duplicate,e.*from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=p_file_id and o.line>p_after order by o.line limit p_limit)x;
 more:=exists(select 1 from erp_cnab.return_occurrence where file_id=p_file_id and line>coalesce(last_line,p_after));return erp_cnab.operational_safety()||jsonb_build_object('file_id',p_file_id,'items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then last_line end);
end $$;
create function public.erp_cnab_operational_return_file(p_user_id uuid,p_file_id uuid)returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare f erp_cnab.return_file;a jsonb;begin
 perform erp_cnab.access(p_user_id);select * into f from erp_cnab.return_file where id=p_file_id and purpose='operational';if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 a:=erp_cnab.require_operational(f.profile_id);perform erp_cnab.storage_check(f.profile_id,'returns',f.file_hash,f.byte_size,f.object_path);
 return jsonb_build_object('id',f.id,'profile_id',f.profile_id,'hash',f.file_hash,'size',f.byte_size,'path',f.object_path,'approval_version',a->'approval_version','filename','RETORNO_'||f.id::text||'.RET');
end $$;
revoke all on all functions in schema erp_cnab from public,anon,authenticated,service_role;
do $$declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like'erp_cnab_operational_%'loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);execute format('grant execute on function %s to service_role',f.signature);end loop;end $$;
commit;
