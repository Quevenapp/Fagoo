-- CNAB 400: homologação, reservas persistentes e revisão de retorno sem baixa.
-- O bucket privado brufap-cnab é provisionado separadamente. Nenhum arquivo é enviado ao banco.
begin;
create schema erp_cnab;
revoke all on schema erp_cnab from public,anon,authenticated,service_role;
create table erp_cnab.profile (
  id uuid primary key default gen_random_uuid(), account_id uuid not null references erp_finance.account(id),
  identity jsonb not null, settings jsonb not null, account_scope text not null unique,
  next_sequence bigint not null check(next_sequence between 1 and 10000000),
  next_our_number bigint, version integer not null default 1,
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
-- One physical account/profile in this first stage prevents a second wallet/CNPJ from resetting its counters.
create unique index erp_cnab_profile_financial_account on erp_cnab.profile(account_id);
create unique index erp_cnab_profile_bank_account on erp_cnab.profile((identity->>'bank'),(identity->>'agency'),(identity->>'account'));
create table erp_cnab.remittance (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references erp_cnab.profile(id),
  sequence bigint not null, generated_on date not null,
  state text not null default 'reserved' check(state in ('reserved','ready')),
  snapshot jsonb not null, object_path text, file_hash text, byte_size integer, manifest jsonb,
  actor uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp(), finalized_at timestamptz,
  unique(profile_id,sequence), check((state='reserved' and object_path is null and file_hash is null) or
    (state='ready' and object_path is not null and file_hash ~ '^[a-f0-9]{64}$' and byte_size between 1 and 4020000))
);
create table erp_cnab.billing_title (
  id uuid primary key default gen_random_uuid(), title_id uuid not null unique references erp_finance.title(id),
  profile_id uuid not null references erp_cnab.profile(id), remittance_id uuid not null references erp_cnab.remittance(id),
  control text not null, document_number text not null, our_number_base text, our_number text,
  snapshot jsonb not null,
  unique(profile_id,control),unique(profile_id,document_number),unique(profile_id,our_number_base),unique(profile_id,our_number)
);
create table erp_cnab.return_file (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references erp_cnab.profile(id),
  file_hash text not null check(file_hash ~ '^[a-f0-9]{64}$'), object_path text not null, byte_size integer not null check(byte_size between 1 and 4020000),
  generated_on date not null, century integer not null, record_count integer not null check(record_count between 2 and 10000),
  warnings jsonb not null, evidence jsonb not null,
  actor uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp(),
  unique(profile_id,file_hash)
);
create table erp_cnab.return_event (
  id uuid primary key default gen_random_uuid(), profile_id uuid not null references erp_cnab.profile(id),
  event_hash text not null check(event_hash ~ '^[a-f0-9]{64}$'), payload jsonb not null,
  billing_title_id uuid references erp_cnab.billing_title(id), proposed_action text not null, reason text not null,
  reviewed boolean not null default false, created_at timestamptz not null default clock_timestamp(), unique(profile_id,event_hash)
);
create table erp_cnab.return_occurrence (
  file_id uuid not null references erp_cnab.return_file(id), line integer not null check(line>1),
  event_id uuid not null references erp_cnab.return_event(id), line_hash text not null check(line_hash ~ '^[a-f0-9]{64}$'),
  duplicate boolean not null, primary key(file_id,line)
);
create table erp_cnab.command (
  id uuid primary key, actor uuid not null references auth.users(id), request_hash text not null,
  result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table erp_cnab.audit (
  id bigint generated always as identity primary key, actor uuid not null references auth.users(id), command_id uuid not null,
  action text not null, record_id uuid not null, created_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin foreach t in array array['profile','remittance','billing_title','return_file','return_event','return_occurrence','command','audit'] loop
  execute format('alter table erp_cnab.%I enable row level security',t); end loop; end $$;
revoke all on all tables in schema erp_cnab from public,anon,authenticated,service_role;
revoke all on all sequences in schema erp_cnab from public,anon,authenticated,service_role;
alter default privileges in schema erp_cnab revoke all on tables from public,anon,authenticated,service_role;
alter default privileges in schema erp_cnab revoke all on functions from public,anon,authenticated,service_role;
-- Unrelated permissive Storage policies must not expose private banking files.
create policy erp_cnab_proxy_only on storage.objects as restrictive for all to anon,authenticated
  using(bucket_id<>'brufap-cnab') with check(bucket_id<>'brufap-cnab');

create function erp_cnab.access(p_actor uuid,p_write boolean default false,p_admin boolean default false)
returns text language plpgsql stable set search_path=pg_catalog as $$ declare r text; begin
  r:=erp_finance.require_access(p_actor,p_write);
  if p_admin and r<>'admin' then raise exception 'erp_cnab_admin_required' using errcode='42501'; end if;
  return r; end $$;
create function erp_cnab.start_command(p_actor uuid,p_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare c erp_cnab.command; h text; begin
  if p_id is null then raise exception 'erp_cnab_command_required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,814));
  h:=encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  select * into c from erp_cnab.command where id=p_id;
  if found then if c.actor<>p_actor or c.request_hash<>h then raise exception 'erp_cnab_command_conflict' using errcode='40001'; end if;
    return c.result||jsonb_build_object('replayed',true); end if;
  return null; end $$;
create function erp_cnab.finish_command(p_actor uuid,p_id uuid,p_action text,p_data jsonb,p_record uuid,p_result jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$ declare result jsonb; begin
  result:=p_result||jsonb_build_object('replayed',false,'purpose','homologation','productionReady',false,'financialMutationPerformed',false);
  insert into erp_cnab.command values(p_id,p_actor,encode(sha256(convert_to(jsonb_build_object('actor',p_actor,'action',p_action,'data',p_data)::text,'UTF8')),'hex'),result,clock_timestamp());
  insert into erp_cnab.audit(actor,command_id,action,record_id) values(p_actor,p_id,p_action,p_record);
  return result; end $$;
create function erp_cnab.profile_dto(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',p.id,'account_id',p.account_id,'account_name',a.name,'bank',p.identity->>'bank','wallet',p.identity->>'wallet',
    'account_mask','***'||right(p.identity->>'account',3),'company_name',p.settings->>'companyName','version',p.version,
    'contract_verified',p.settings->'contractVerified','policy_verified',p.settings->'simpleCollectionPolicyVerified',
    'next_sequence',p.next_sequence::text,'purpose','homologation','productionReady',false)
  from erp_cnab.profile p join erp_finance.account a on a.id=p.account_id where p.id=p_id;
$$;
create function erp_cnab.core_profile(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
  select p.identity||p.settings||jsonb_build_object('accountId',p.account_id::text) from erp_cnab.profile p where id=p_id;
$$;
create function erp_cnab.storage_check(p_profile uuid,p_kind text,p_hash text,p_size integer,p_path text)
returns void language plpgsql stable set search_path=pg_catalog as $$ declare expected text; begin
  if p_kind not in ('remittances','returns') or p_hash !~ '^[a-f0-9]{64}$' or p_size not between 1 and 4020000 then
    raise exception 'erp_cnab_invalid_file' using errcode='22023'; end if;
  expected:='profiles/'||p_profile::text||'/'||p_kind||'/'||p_hash||case when p_kind='returns' then '.ret' else '.rem' end;
  if p_path is distinct from expected or not exists(select 1 from storage.buckets where id='brufap-cnab' and name='brufap-cnab' and public=false
      and file_size_limit=4020000 and allowed_mime_types=array['application/octet-stream']::text[])
    or not exists(select 1 from storage.objects where bucket_id='brufap-cnab' and name=expected
      and metadata->>'size'=p_size::text and metadata->>'mimetype'='application/octet-stream') then raise exception 'erp_cnab_private_object_required' using errcode='40001'; end if;
end $$;
-- Contexto interno do Worker: nunca deve ser projetado integralmente para o navegador.
create function public.erp_cnab_return_context(p_user_id uuid,p_profile_id uuid,p_file_hash text,p_event_hashes text[],p_controls text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare p erp_cnab.profile; titles jsonb; begin
  perform erp_cnab.access(p_user_id,true);
  if p_file_hash !~ '^[a-f0-9]{64}$' or cardinality(p_event_hashes)>10000 or cardinality(p_controls)>10000
    or exists(select 1 from unnest(p_event_hashes) h where h!~'^[a-f0-9]{64}$') then raise exception 'erp_cnab_context_invalid' using errcode='22023'; end if;
  select * into p from erp_cnab.profile where id=p_profile_id; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'accountScope',p.account_scope,'control',b.control,'documentNumber',b.document_number,
    'ourNumber',b.our_number,'status',case when t.cancelled then 'cancelled' when t.settled_cents=t.amount_cents then 'settled' else 'open' end,
    'amountCents',t.amount_cents::text,'outstandingCents',(t.amount_cents-t.settled_cents)::text,'dueDate',t.due_on) order by b.id),'[]') into titles
    from erp_cnab.billing_title b join erp_finance.title t on t.id=b.title_id where b.profile_id=p.id and b.control=any(p_controls);
  return jsonb_build_object('profile',erp_cnab.core_profile(p.id),'titles',titles,
    'seenFileHashes',(select coalesce(jsonb_agg(file_hash),'[]') from erp_cnab.return_file where profile_id=p.id and file_hash=p_file_hash),
    'seenEventHashes',(select coalesce(jsonb_agg(event_hash),'[]') from erp_cnab.return_event where profile_id=p.id and event_hash=any(p_event_hashes)));
end $$;

create function public.erp_cnab_profile_context(p_user_id uuid,p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare result jsonb; begin
  perform erp_cnab.access(p_user_id,true); result:=erp_cnab.core_profile(p_profile_id);
  if result is null then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if; return result;
end $$;

create function public.erp_cnab_return_commit(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_file jsonb,p_events jsonb,p_decisions jsonb)
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

create function public.erp_cnab_review(p_user_id uuid,p_file_id uuid,p_limit integer default 25,p_after integer default 1)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare f erp_cnab.return_file; items jsonb; more boolean; begin
  perform erp_cnab.access(p_user_id); if p_limit is null or p_limit not between 1 and 100 or p_after is null or p_after<1 then raise exception 'erp_cnab_invalid_pagination' using errcode='22023'; end if;
  select * into f from erp_cnab.return_file where id=p_file_id; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(x.dto order by x.line),'[]') into items from (select o.line,jsonb_build_object('line',o.line,'event_id',e.id,'event_hash',e.event_hash,
    'duplicate',o.duplicate,'billing_title_id',e.billing_title_id,'action',e.proposed_action,'reason',e.reason,'control',e.payload->>'control',
    'document_number',e.payload->>'documentNumber','our_number',e.payload->>'ourNumber','occurrence',e.payload->>'occurrence','kind',e.payload->>'kind',
    'amount_cents',e.payload->>'amountCents','paid_cents',e.payload->>'paidCents','occurrence_date',e.payload->>'occurrenceDate','credit_date',e.payload->>'creditDate','canSettle',false) dto
    from erp_cnab.return_occurrence o join erp_cnab.return_event e on e.id=o.event_id where o.file_id=f.id and o.line>p_after order by o.line limit p_limit) x;
  more:=exists(select 1 from erp_cnab.return_occurrence where file_id=f.id and line>coalesce((items->-1->>'line')::integer,p_after));
  return jsonb_build_object('id',f.id,'profile_id',f.profile_id,'file_hash',f.file_hash,'warnings',f.warnings,'items',items,'has_more',more,
    'next_cursor',case when more then (items->-1->>'line')::integer else null end,'limit',p_limit,'canSettle',false,'productionReady',false,'financialMutationPerformed',false);
end $$;
create function public.erp_cnab_file(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare result jsonb; begin
  perform erp_cnab.access(p_user_id);
  if p_kind='remittance' then select jsonb_build_object('id',r.id,'profile_id',r.profile_id,'hash',r.file_hash,'size',r.byte_size,'path',r.object_path,
    'filename',case when p.identity->>'bank'='077' then 'CI400_001_' else 'ITAU_TESTE_' end||lpad(r.sequence::text,7,'0')||'.REM') into result from erp_cnab.remittance r join erp_cnab.profile p on p.id=r.profile_id where r.id=p_id and r.state='ready';
  elsif p_kind='return' then select jsonb_build_object('id',id,'profile_id',profile_id,'hash',file_hash,'size',byte_size,'path',object_path,'filename','RETORNO_'||id::text||'.RET') into result from erp_cnab.return_file where id=p_id;
  else raise exception 'erp_cnab_invalid_kind' using errcode='22023'; end if;
  if result is null then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  perform erp_cnab.storage_check((result->>'profile_id')::uuid,case when p_kind='return' then 'returns' else 'remittances' end,result->>'hash',(result->>'size')::integer,result->>'path');
  return result;
end $$;

create function public.erp_cnab_access(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare r text; begin
  r:=erp_cnab.access(p_user_id); return jsonb_build_object('read',true,'write',r in ('admin','financeiro'),'configure',r='admin','purpose','homologation','productionReady',false,'financialMutationPerformed',false); end $$;
create function public.erp_cnab_profiles(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ begin
  perform erp_cnab.access(p_user_id); return jsonb_build_object('items',(select coalesce(jsonb_agg(erp_cnab.profile_dto(id) order by id),'[]') from erp_cnab.profile),
    'purpose','homologation','productionReady',false,'financialMutationPerformed',false); end $$;

create function public.erp_cnab_profile_save(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; replay jsonb; command jsonb; identity_data jsonb; settings_data jsonb; v_account uuid; bank text; wallet text; scope text; seq bigint; nn bigint; identity_keys text[]:=array['bank','layout','agency','account','accountDigit','wallet','cnpj'];
begin
  perform erp_cnab.access(p_user_id,true,true);
  perform erp_finance.keys(p_data,array['account_id','bank','layout','agency','account','accountDigit','wallet','cnpj','companyName','agreementReference','contractVerified','simpleCollectionPolicyVerified','reservedRange','ourNumberStart','remittanceSequenceStart']);
  command:=jsonb_build_object('id',p_id,'version',p_expected_version,'data',p_data); replay:=erp_cnab.start_command(p_user_id,p_command_id,'profile_save',command); if replay is not null then return replay; end if;
  v_account:=erp_finance.uuid_value(p_data->'account_id'); bank:=p_data->>'bank'; wallet:=p_data->>'wallet';
  if exists(select 1 from unnest(identity_keys) k where jsonb_typeof(p_data->k) is distinct from 'string')
    or jsonb_typeof(p_data->'remittanceSequenceStart') is distinct from 'string'
    or (p_data->'ourNumberStart' is not null and p_data->'ourNumberStart'<>'null'::jsonb and jsonb_typeof(p_data->'ourNumberStart')<>'string') then raise exception 'erp_cnab_invalid_profile' using errcode='22023'; end if;
  if not exists(select 1 from erp_finance.account where id=v_account and active and kind='bank') then raise exception 'erp_cnab_bank_account_required' using errcode='22023'; end if;
  if bank not in ('341','077') or (bank='341' and (wallet<>'109' or p_data->>'layout'<>'itau-cnab400-2017-01'))
    or (bank='077' and (wallet not in ('110','112') or p_data->>'layout'<>'inter-cnab400-v2.2-2024-08-26'))
    or coalesce(p_data->>'agency','')!~'^[0-9]{4}$' or p_data->>'agency'='0000'
    or (bank='077' and p_data->>'agency'<>'0001') or coalesce(p_data->>'account','')!~(case when bank='341' then '^[0-9]{5}$' else '^[0-9]{9}$' end)
    or p_data->>'account'~'^0+$' or coalesce(p_data->>'accountDigit','')!~'^[0-9]$' or coalesce(p_data->>'cnpj','')!~'^[0-9]{14}$'
    or coalesce(p_data->>'companyName','')!~'^[A-Z0-9 .&/-]{1,30}$' or length(coalesce(p_data->>'agreementReference','')) not between 1 and 200
    or jsonb_typeof(p_data->'contractVerified') is distinct from 'boolean' or jsonb_typeof(p_data->'simpleCollectionPolicyVerified') is distinct from 'boolean'
    or coalesce(p_data->>'remittanceSequenceStart','')!~'^[1-9][0-9]{0,6}$' then raise exception 'erp_cnab_invalid_profile' using errcode='22023'; end if;
  if bank='077' and wallet='112' then nn:=null;
    if p_data->'ourNumberStart' is not null and p_data->'ourNumberStart'<>'null'::jsonb then raise exception 'erp_cnab_bank_assigned_number' using errcode='22023'; end if;
  else
    if coalesce(p_data->>'ourNumberStart','')!~(case when bank='341' then '^[0-9]{8}$' else '^[0-9]{10}$' end) or (p_data->>'ourNumberStart')::bigint=0 then raise exception 'erp_cnab_number_start_required' using errcode='22023'; end if;
    nn:=(p_data->>'ourNumberStart')::bigint;
  end if;
  if bank='077' and wallet='110' then
    perform erp_finance.keys(p_data->'reservedRange',array['verified','start','end']);
    if jsonb_typeof(p_data->'reservedRange'->'verified') is distinct from 'boolean' or coalesce(p_data->'reservedRange'->>'start','')!~'^[0-9]{10}$'
      or coalesce(p_data->'reservedRange'->>'end','')!~'^[0-9]{10}$' or nn not between (p_data->'reservedRange'->>'start')::bigint and (p_data->'reservedRange'->>'end')::bigint then raise exception 'erp_cnab_invalid_range' using errcode='22023'; end if;
  elsif p_data ? 'reservedRange' then raise exception 'erp_cnab_range_not_applicable' using errcode='22023'; end if;
  select jsonb_object_agg(key,value) into identity_data from jsonb_each(p_data) where key=any(identity_keys);
  if (select count(*) from jsonb_object_keys(identity_data))<>7 then raise exception 'erp_cnab_invalid_profile' using errcode='22023'; end if;
  settings_data:=p_data-array['account_id','bank','layout','agency','account','accountDigit','wallet','cnpj'];
  scope:=concat_ws(':',bank,p_data->>'agency',p_data->>'account',p_data->>'accountDigit',wallet,p_data->>'cnpj'); seq:=(p_data->>'remittanceSequenceStart')::bigint;
  if p_id is null then
    if p_expected_version is distinct from 0 then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
    insert into erp_cnab.profile(account_id,identity,settings,account_scope,next_sequence,next_our_number,reviewed_by,reviewed_at)
      values(v_account,identity_data,settings_data,scope,seq,nn,p_user_id,clock_timestamp()) returning * into p;
  else
    select * into p from erp_cnab.profile where id=p_id for update; if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
    if p.version is distinct from p_expected_version or p.identity<>identity_data or p.account_id<>v_account
      or p.settings->'ourNumberStart' is distinct from settings_data->'ourNumberStart' or p.settings->'remittanceSequenceStart' is distinct from settings_data->'remittanceSequenceStart'
      or p.settings->'reservedRange' is distinct from settings_data->'reservedRange' then raise exception 'erp_cnab_identity_or_version_conflict' using errcode='40001'; end if;
    update erp_cnab.profile set settings=settings_data,version=version+1,reviewed_by=p_user_id,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p.id returning * into p;
  end if;
  return erp_cnab.finish_command(p_user_id,p_command_id,'profile_save',command,p.id,jsonb_build_object('profile',erp_cnab.profile_dto(p.id)));
end $$;

create function public.erp_cnab_reserve(p_user_id uuid,p_command_id uuid,p_profile_id uuid,p_expected_version integer,p_generated_on date,p_titles jsonb,p_preview boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; t erp_finance.title; c record; row jsonb; input_title jsonb; payer jsonb; snap jsonb; result_titles jsonb:='[]'; rid uuid; bid uuid; base text; control text; doc text; sequence bigint; replay jsonb; command jsonb; days integer;
begin
  perform erp_cnab.access(p_user_id,true);
  if p_preview is null then raise exception 'erp_cnab_preview_required' using errcode='22023'; end if;
  command:=jsonb_build_object('profile_id',p_profile_id,'version',p_expected_version,'generated_on',p_generated_on,'titles',p_titles);
  if not p_preview then replay:=erp_cnab.start_command(p_user_id,p_command_id,'reserve',command); if replay is not null then return replay; end if; end if;
  if jsonb_typeof(p_titles) is distinct from 'array' or jsonb_array_length(p_titles) not between 1 and 30 or octet_length(p_titles::text)>65536
    or p_generated_on is null or p_generated_on not between date '2000-01-01' and (clock_timestamp() at time zone 'America/Sao_Paulo')::date then raise exception 'erp_cnab_invalid_reservation' using errcode='22023'; end if;
  select * into p from erp_cnab.profile where id=p_profile_id for update;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if p.version is distinct from p_expected_version then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
  if p.settings->'contractVerified' is distinct from 'true'::jsonb or p.settings->'simpleCollectionPolicyVerified' is distinct from 'true'::jsonb
    or (p.identity->>'bank'='077' and p.identity->>'wallet'='110' and p.settings->'reservedRange'->'verified' is distinct from 'true'::jsonb)
    then raise exception 'erp_cnab_profile_unconfirmed' using errcode='40001'; end if;
  sequence:=p.next_sequence; if sequence>9999999 then raise exception 'erp_cnab_sequence_exhausted' using errcode='40001'; end if;
  rid:=gen_random_uuid();
  if not p_preview then insert into erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor) values(rid,p.id,sequence,p_generated_on,'{}',p_user_id); end if;
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
    if exists(select 1 from erp_cnab.billing_title where profile_id=p.id and document_number=doc) then raise exception 'erp_cnab_document_number_used' using errcode='40001'; end if;
    if not p_preview then insert into erp_cnab.billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number_base,snapshot) values(bid,t.id,p.id,rid,control,doc,base,snap); end if;
    result_titles:=result_titles||jsonb_build_array(input_title);
  end loop;
  snap:=jsonb_build_object('profile',erp_cnab.core_profile(p.id),'titles',result_titles,'generatedOn',p_generated_on,'remittanceSequence',sequence::text,'purpose','homologation');
  if p_preview then return jsonb_build_object('snapshot',snap,'profile_id',p.id,'profile_version',p.version,'preview',true); end if;
  update erp_cnab.remittance set snapshot=snap where id=rid;
  update erp_cnab.profile set next_sequence=sequence+1,next_our_number=p.next_our_number,version=version+1,updated_at=clock_timestamp() where id=p.id;
  return erp_cnab.finish_command(p_user_id,p_command_id,'reserve',command,rid,jsonb_build_object('id',rid,'profile_id',p.id,'sequence',sequence::text,'state','reserved'));
end $$;

create function public.erp_cnab_reservation(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$ declare r erp_cnab.remittance; begin
  perform erp_cnab.access(p_user_id,true); select * into r from erp_cnab.remittance where id=p_id;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('id',r.id,'profile_id',r.profile_id,'state',r.state,'snapshot',r.snapshot,'file_hash',r.file_hash,'object_path',r.object_path,'byte_size',r.byte_size,'purpose','homologation','productionReady',false,'financialMutationPerformed',false);
end $$;
create function public.erp_cnab_finalize(p_user_id uuid,p_command_id uuid,p_id uuid,p_hash text,p_size integer,p_path text,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r erp_cnab.remittance; p erp_cnab.profile; b erp_cnab.billing_title; row jsonb; command jsonb; replay jsonb; n text; begin
  perform erp_cnab.access(p_user_id,true); command:=jsonb_build_object('id',p_id,'hash',p_hash,'size',p_size,'path',p_path,'manifest',p_manifest);
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
create function public.erp_cnab_approve(p_user_id uuid,p_id uuid,p_expected_version integer,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p erp_cnab.profile; command jsonb; replay jsonb; begin
  perform erp_cnab.access(p_user_id,true,true);
  perform erp_finance.keys(p_data,array['contract_verified','policy_verified','range_verified','reference']);
  if jsonb_typeof(p_data->'contract_verified') is distinct from 'boolean' or jsonb_typeof(p_data->'policy_verified') is distinct from 'boolean'
    or (p_data ? 'range_verified' and jsonb_typeof(p_data->'range_verified') is distinct from 'boolean') then raise exception 'erp_cnab_invalid_approval' using errcode='22023'; end if;
  perform erp_finance.txt(p_data,'reference',120,true);
  command:=jsonb_build_object('id',p_id,'version',p_expected_version,'data',p_data);
  replay:=erp_cnab.start_command(p_user_id,p_command_id,'approve',command); if replay is not null then return replay; end if;
  select * into p from erp_cnab.profile where id=p_id for update;
  if not found then raise exception 'erp_cnab_not_found' using errcode='P0002'; end if;
  if p.version is distinct from p_expected_version then raise exception 'erp_cnab_version_conflict' using errcode='40001'; end if;
  if p.identity->>'bank'='077' and p.identity->>'wallet'='110' then
    if not p_data ? 'range_verified' then raise exception 'erp_cnab_range_confirmation_required' using errcode='22023'; end if;
    p.settings:=jsonb_set(p.settings,'{reservedRange,verified}',p_data->'range_verified');
  elsif p_data ? 'range_verified' then raise exception 'erp_cnab_range_not_applicable' using errcode='22023'; end if;
  p.settings:=p.settings||jsonb_build_object('contractVerified',p_data->'contract_verified','simpleCollectionPolicyVerified',p_data->'policy_verified','agreementReference',p_data->>'reference');
  update erp_cnab.profile set settings=p.settings,version=version+1,reviewed_by=p_user_id,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
  return erp_cnab.finish_command(p_user_id,p_command_id,'approve',command,p_id,jsonb_build_object('profile',erp_cnab.profile_dto(p_id)));
end $$;
create function public.erp_cnab_files(p_user_id uuid,p_kind text,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare rows jsonb; more boolean; cursor uuid; begin
  perform erp_cnab.access(p_user_id);
  if p_kind not in ('remittance','return') or p_limit is null or p_limit not between 1 and 100 then raise exception 'erp_cnab_invalid_query' using errcode='22023'; end if;
  with entries as (
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','remittance','state',r.state,'sequence',r.sequence::text,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',jsonb_array_length(r.snapshot->'titles'),
      'filename',case when r.snapshot->'profile'->>'bank'='077' then 'CI400_001_' else 'ITAU_TESTE_' end||lpad(r.sequence::text,7,'0')||'.REM') value
      from erp_cnab.remittance r where p_kind='remittance' and (p_after is null or r.id>p_after)
    union all
    select r.id,r.profile_id,r.created_at,jsonb_build_object('id',r.id,'profile_id',r.profile_id,'kind','return','state','ready','sequence',null,
      'generated_on',r.generated_on,'created_at',r.created_at,'file_hash',r.file_hash,'byte_size',r.byte_size,'titles',r.record_count-2,'filename','RETORNO_'||r.id::text||'.RET')
      from erp_cnab.return_file r where p_kind='return' and (p_after is null or r.id>p_after)
  ), selected as (select * from entries order by id limit p_limit+1), numbered as(select *,row_number() over(order by id) rn from selected)
  select coalesce(jsonb_agg(value order by id) filter(where rn<=p_limit),'[]'),count(*)>p_limit,(array_agg(id order by id) filter(where rn<=p_limit))[least(p_limit,count(*)::integer)] into rows,more,cursor from numbered;
  return jsonb_build_object('items',rows,'limit',p_limit,'has_more',more,'next_cursor',case when more then cursor else null end,'purpose','homologation','productionReady',false,'financialMutationPerformed',false);
end $$;
revoke all on all functions in schema erp_cnab from public,anon,authenticated,service_role;
do $$ declare f record; begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'erp_cnab_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
end loop; end $$;
commit;
