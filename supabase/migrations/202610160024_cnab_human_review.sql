-- Conferência humana de retornos em homologação. Não vincula números bancários nem movimenta o financeiro.
begin;
create table erp_cnab.human_review (
  event_id uuid primary key references erp_cnab.return_event(id),
  version integer not null check(version between 1 and 2147483647)
);
create table erp_cnab.human_review_revision (
  event_id uuid not null references erp_cnab.return_event(id),
  version integer not null check(version between 1 and 2147483647),
  status text not null check(status in ('confirmed','pending_issue')),
  reason text not null check(length(btrim(reason)) between 3 and 1000 and reason !~ '[[:cntrl:]]'),
  context_hash text not null check(context_hash ~ '^[a-f0-9]{64}$'), context jsonb not null,
  actor uuid not null references auth.users(id), command_id uuid not null unique,
  reviewed_at timestamptz not null default clock_timestamp(), primary key(event_id,version)
);
alter table erp_cnab.human_review add foreign key(event_id,version)
  references erp_cnab.human_review_revision(event_id,version) deferrable initially deferred;
alter table erp_cnab.human_review enable row level security;
alter table erp_cnab.human_review_revision enable row level security;
revoke all on erp_cnab.human_review,erp_cnab.human_review_revision from public,anon,authenticated,service_role;
create function erp_cnab.immutable_human_review_revision() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_cnab_review_revision_immutable' using errcode='42501'; end $$;
create trigger erp_cnab_human_revision_immutable before update or delete on erp_cnab.human_review_revision
  for each row execute function erp_cnab.immutable_human_review_revision();

create function erp_cnab.human_review_safety() returns jsonb language sql immutable set search_path=pg_catalog as $$
  select jsonb_build_object('purpose','homologation','productionReady',false,'canSettle',false,
    'financialMutationPerformed',false,'originAuthenticated',false);
$$;
-- Explicit, bounded projection. It intentionally omits beneficiary/payer documents, full accounts and raw payloads.
create function erp_cnab.human_review_context(p_event_id uuid,p_file_id uuid,p_line integer)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare e erp_cnab.return_event; o erp_cnab.return_occurrence; f erp_cnab.return_file; p erp_cnab.profile;
  b erp_cnab.billing_title; t erp_finance.title; a erp_finance.account; v_billing jsonb:=null; v_title jsonb:=null;
  v_link boolean; v_reference boolean; v_number boolean; v_amount boolean; v_due boolean; v_open boolean; v_paid boolean;
  v_adjust boolean; v_declared boolean; v_reason text;
begin
  select * into e from erp_cnab.return_event where id=p_event_id;
  select * into o from erp_cnab.return_occurrence where file_id=p_file_id and line=p_line and event_id=p_event_id;
  if e.id is null or o.event_id is null then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  select * into f from erp_cnab.return_file where id=o.file_id and profile_id=e.profile_id;
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
create function erp_cnab.human_review_hash(p_context jsonb) returns text language sql immutable set search_path=pg_catalog as $$
  select encode(sha256(convert_to(p_context::text,'UTF8')),'hex');
$$;
create function erp_cnab.human_review_revision_dto(p_event_id uuid,p_version integer)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('event_id',r.event_id,'version',r.version,'status',r.status,'reason',r.reason,
    'context_hash',r.context_hash,'context',r.context,'reviewed_at',r.reviewed_at)
  from erp_cnab.human_review_revision r where r.event_id=p_event_id and r.version=p_version;
$$;
create function erp_cnab.human_review_detail(p_event_id uuid,p_file_id uuid,p_line integer)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$ declare c jsonb; h text; v integer; r jsonb; begin
  c:=erp_cnab.human_review_context(p_event_id,p_file_id,p_line); h:=erp_cnab.human_review_hash(c);
  select version into v from erp_cnab.human_review where event_id=p_event_id;
  r:=erp_cnab.human_review_revision_dto(p_event_id,v);
  if r is not null then r:=r||jsonb_build_object('context_changed',r->>'context_hash'<>h); end if;
  return erp_cnab.human_review_safety()||jsonb_build_object('event_id',p_event_id,'context',c,'context_hash',h,
    'review_version',coalesce(v,0),'review',r,'bytes_verified',false);
end $$;
create function public.erp_cnab_human_review_get(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ begin
  perform erp_cnab.access(p_user_id); return erp_cnab.human_review_detail(p_event_id,p_file_id,p_line);
end $$;
-- Internal Worker verification material. Never returned directly to the browser; no row locks while fetching Storage.
create function public.erp_cnab_human_review_verify(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare d jsonb; f erp_cnab.return_file; e erp_cnab.return_event; begin
  perform erp_cnab.access(p_user_id,true); d:=erp_cnab.human_review_detail(p_event_id,p_file_id,p_line);
  select * into f from erp_cnab.return_file where id=p_file_id; select * into e from erp_cnab.return_event where id=p_event_id;
  perform erp_cnab.storage_check(f.profile_id,'returns',f.file_hash,f.byte_size,f.object_path);
  return jsonb_build_object('detail',d,'file',jsonb_build_object('id',f.id,'profile_id',f.profile_id,'hash',f.file_hash,
    'size',f.byte_size,'path',f.object_path,'century',f.century),'profile',erp_cnab.core_profile(f.profile_id),'payload',e.payload);
end $$;
create function public.erp_cnab_human_review_list(p_user_id uuid,p_file_id uuid,p_limit integer default 25,p_after integer default 1)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare rows jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id);
  if p_limit is null or p_limit not between 1 and 100 or p_after is null or p_after not between 1 and 10000 then raise exception 'erp_cnab_review_pagination_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_cnab.return_file where id=p_file_id) then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
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
create function public.erp_cnab_human_review_history(p_user_id uuid,p_event_id uuid,p_limit integer default 25,p_before integer default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare rows jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id);
  if p_limit is null or p_limit not between 1 and 100 or (p_before is not null and p_before<1) then raise exception 'erp_cnab_review_pagination_invalid' using errcode='22023'; end if;
  if not exists(select 1 from erp_cnab.return_event where id=p_event_id) then raise exception 'erp_cnab_review_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(x.dto order by x.version desc),'[]') into rows from (
    select version,erp_cnab.human_review_revision_dto(p_event_id,version) dto from erp_cnab.human_review_revision
      where event_id=p_event_id and (p_before is null or version<p_before) order by version desc limit p_limit) x;
  more:=exists(select 1 from erp_cnab.human_review_revision where event_id=p_event_id and version<coalesce((rows->-1->>'version')::integer,p_before,2147483647));
  return erp_cnab.human_review_safety()||jsonb_build_object('event_id',p_event_id,'items',rows,'limit',p_limit,'has_more',more,
    'next_cursor',case when more then (rows->-1->>'version')::integer else null end);
end $$;
create function public.erp_cnab_human_review_save(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,
  p_command_id uuid,p_expected_review_version integer,p_expected_context_hash text,p_status text,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare cmd jsonb; replay jsonb; e erp_cnab.return_event; profile_id uuid; b erp_cnab.billing_title; v integer;
  c jsonb; h text; f erp_cnab.return_file; result jsonb;
begin
  perform erp_cnab.access(p_user_id,true);
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
revoke all on function erp_cnab.immutable_human_review_revision(),erp_cnab.human_review_safety(),
  erp_cnab.human_review_context(uuid,uuid,integer),erp_cnab.human_review_hash(jsonb),
  erp_cnab.human_review_revision_dto(uuid,integer),erp_cnab.human_review_detail(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.erp_cnab_human_review_get(uuid,uuid,uuid,integer),
  public.erp_cnab_human_review_verify(uuid,uuid,uuid,integer),public.erp_cnab_human_review_list(uuid,uuid,integer,integer),
  public.erp_cnab_human_review_history(uuid,uuid,integer,integer),
  public.erp_cnab_human_review_save(uuid,uuid,uuid,integer,uuid,integer,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.erp_cnab_human_review_get(uuid,uuid,uuid,integer),
  public.erp_cnab_human_review_verify(uuid,uuid,uuid,integer),public.erp_cnab_human_review_list(uuid,uuid,integer,integer),
  public.erp_cnab_human_review_history(uuid,uuid,integer,integer),
  public.erp_cnab_human_review_save(uuid,uuid,uuid,integer,uuid,integer,text,text,text) to service_role;
commit;
