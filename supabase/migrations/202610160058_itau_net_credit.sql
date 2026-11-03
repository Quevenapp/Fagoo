-- Explicit internal posting of an Itaú109 net credit and its fee. No bank requests.
begin;

create table erp_finance.cnab_cash_plan (
 command_id uuid primary key references erp_finance.command(id) deferrable initially deferred,
 event_id uuid not null unique references erp_cnab.return_event(id),
 title_id uuid not null references erp_finance.title(id), account_id uuid not null references erp_finance.account(id),
 actor uuid not null references auth.users(id),
 principal_cents bigint not null check(principal_cents between 1 and 999999999999999),
 fee_cents bigint not null check(fee_cents>0), net_cash_cents bigint not null check(net_cash_cents>0),
 category_id uuid not null references erp_finance.category(id), category_snapshot jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check(principal_cents=net_cash_cents+fee_cents)
);
alter table erp_finance.cnab_cash_plan enable row level security;
revoke all on erp_finance.cnab_cash_plan from public,anon,authenticated,service_role;
create trigger cnab_cash_plan_immutable before update or delete on erp_finance.cnab_cash_plan
 for each row execute function erp_cnab.operational_revision_immutable();

-- Preserve the one main leg of every old settlement; only an authorized058 plan
-- permits the additional fee leg. Transfer053 constraints/indexes stay intact.
alter table erp_finance.movement drop constraint movement_settlement_id_key;
create unique index erp_finance_settlement_main_leg on erp_finance.movement(settlement_id)
 where kind in ('payment','reversal');
create unique index erp_finance_settlement_fee_leg on erp_finance.movement(settlement_id)
 where kind in ('bank_fee','bank_fee_reversal');
alter table erp_finance.movement drop constraint movement_kind_check;
alter table erp_finance.movement drop constraint movement_check;
alter table erp_finance.movement add constraint movement_kind_check check(kind in ('opening','payment','reversal','transfer_out','transfer_in','bank_fee','bank_fee_reversal'));
alter table erp_finance.movement add constraint movement_check check(
 (kind='opening' and settlement_id is null and transfer_id is null)
 or (kind in ('payment','reversal','bank_fee','bank_fee_reversal') and settlement_id is not null and transfer_id is null)
 or (kind in ('transfer_out','transfer_in') and settlement_id is null and transfer_id is not null)
);

create function erp_finance.cnab_plan_for_settlement(p_id uuid)
returns erp_finance.cnab_cash_plan language sql stable set search_path=pg_catalog as $$
 select p.* from erp_finance.settlement s
 left join erp_finance.settlement original on original.id=s.reverses_id
 join erp_finance.cnab_cash_plan p on p.command_id=case when s.kind='payment' then s.command_id else original.command_id end
 where s.id=p_id
$$;

create function erp_finance.assert_settlement_postings(p_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s erp_finance.settlement;p erp_finance.cnab_cash_plan;direction integer;n integer;total numeric;main text;fee text;
begin
 select * into s from erp_finance.settlement where id=p_id;
 if not found then raise exception 'erp_finance_posting_missing'using errcode='22023';end if;
 select case when kind='receivable' then 1 else -1 end into direction from erp_finance.title where id=s.title_id;
 if s.kind='reversal' then direction:=-direction;end if;
 select * into p from erp_finance.cnab_plan_for_settlement(s.id);
 select count(*),coalesce(sum(delta_cents),0)into n,total from erp_finance.movement where settlement_id=s.id;
 if exists(select 1 from erp_finance.movement m where m.settlement_id=s.id and
  (m.account_id is distinct from s.account_id or m.posted_on is distinct from s.posted_on or m.actor is distinct from s.actor
   or m.command_id is distinct from s.command_id or m.note is distinct from s.note or m.transfer_id is not null)) then
  raise exception 'erp_finance_posting_binding_invalid'using errcode='22023';end if;
 if p.command_id is null then
  if n<>1 or total<>direction*s.net_cash_cents or not exists(select 1 from erp_finance.movement where settlement_id=s.id and kind=s.kind)then
   raise exception 'erp_finance_posting_incomplete'using errcode='22023';end if;
 else
  main:=case when s.kind='payment' then 'payment' else 'reversal' end;
  fee:=case when s.kind='payment' then 'bank_fee' else 'bank_fee_reversal' end;
  if s.title_id<>p.title_id or s.account_id<>p.account_id or s.principal_cents<>p.principal_cents or s.fee_cents<>p.fee_cents
   or s.net_cash_cents<>p.net_cash_cents or s.interest_cents<>0 or s.penalty_cents<>0 or s.discount_cents<>0
   or not exists(select 1 from erp_finance.title where id=s.title_id and kind='receivable')
   or (s.kind='payment' and s.actor<>p.actor)
   or n<>2 or total<>direction*p.net_cash_cents
   or not exists(select 1 from erp_finance.movement where settlement_id=s.id and kind=main and delta_cents=direction*p.principal_cents)
   or not exists(select 1 from erp_finance.movement where settlement_id=s.id and kind=fee and delta_cents=-direction*p.fee_cents)then
   raise exception 'erp_finance_cnab_posting_invalid'using errcode='22023';end if;
 end if;
end $$;
create function erp_finance.settlement_posting_check()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$declare sid uuid;begin
 if TG_TABLE_NAME='settlement' then sid:=new.id;else sid:=new.settlement_id;end if;
 perform erp_finance.assert_settlement_postings(sid);return null;
end $$;
create constraint trigger settlement_posting_check after insert on erp_finance.settlement
 deferrable initially deferred for each row execute function erp_finance.settlement_posting_check();
create constraint trigger settlement_movement_check after insert on erp_finance.movement
 deferrable initially deferred for each row when(new.settlement_id is not null) execute function erp_finance.settlement_posting_check();
create function erp_finance.cnab_cash_plan_check()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$declare sid uuid;begin
 select s.id into sid from erp_finance.settlement s join erp_cnab.operational_settlement o on o.settlement_id=s.id
 where s.command_id=new.command_id and s.kind='payment' and o.command_id=new.command_id and o.event_id=new.event_id
  and o.receipt->>'policy'='itau109-net-credit-v1';
 if sid is null then raise exception 'erp_finance_cnab_plan_incomplete'using errcode='22023';end if;
 perform erp_finance.assert_settlement_postings(sid);return null;
end $$;
create constraint trigger cnab_cash_plan_complete after insert on erp_finance.cnab_cash_plan
 deferrable initially deferred for each row execute function erp_finance.cnab_cash_plan_check();
create function erp_finance.cnab_cash_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$declare sid uuid;begin
 if TG_TABLE_NAME='settlement' then sid:=old.id;else sid:=old.settlement_id;end if;
 if (select command_id from erp_finance.cnab_plan_for_settlement(sid))is not null then
  raise exception 'erp_finance_cnab_cash_immutable'using errcode='42501';end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
create trigger cnab_settlement_immutable before update or delete on erp_finance.settlement for each row execute function erp_finance.cnab_cash_immutable();
create trigger cnab_movement_immutable before update or delete on erp_finance.movement for each row execute function erp_finance.cnab_cash_immutable();

-- The public010 body and command fingerprint remain unchanged. Only this private
-- writer recognizes a plan inserted by058 in the SAME transaction. Reversal
-- reads the original immutable plan; it never locks profile/category afterwards.
create function erp_finance.post_settlement_movements(p_settlement uuid,p_delta bigint)
returns void language plpgsql set search_path=pg_catalog as $$
declare s erp_finance.settlement;p erp_finance.cnab_cash_plan;direction integer;
begin
 select * into s from erp_finance.settlement where id=p_settlement;
 select * into p from erp_finance.cnab_plan_for_settlement(s.id);
 if p.command_id is null then
  insert into erp_finance.movement(account_id,settlement_id,kind,delta_cents,posted_on,note,actor,command_id)
   values(s.account_id,s.id,s.kind,p_delta,s.posted_on,s.note,s.actor,s.command_id);
 else
  direction:=case when s.kind='payment' then 1 else -1 end;
  if p_delta<>direction*p.net_cash_cents then raise exception 'erp_finance_cnab_posting_invalid'using errcode='22023';end if;
  insert into erp_finance.movement(account_id,settlement_id,kind,delta_cents,posted_on,note,actor,command_id)
   values(s.account_id,s.id,s.kind,direction*p.principal_cents,s.posted_on,s.note,s.actor,s.command_id),
    (s.account_id,s.id,case when s.kind='payment' then 'bank_fee' else 'bank_fee_reversal' end,-direction*p.fee_cents,s.posted_on,s.note,s.actor,s.command_id);
 end if;
end $$;

create function erp_cnab.itau_net_credit_plan(p_event jsonb,p_category jsonb,p_expected_category integer)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare a jsonb:=p_event->'adjustments';issues text[]:='{}';posting jsonb;
begin
 if p_event->>'bank'<>'341' or p_event->>'wallet'<>'109' then issues:=array_append(issues,'ITAU109_REQUIRED');end if;
 if a is null or a='null'::jsonb or exists(select 1 from unnest(array['iof','abatement','discount','otherCredits'])k where a->>k is distinct from '0')then
  issues:=array_append(issues,'NET_CREDIT_ADJUSTMENTS_UNSUPPORTED');end if;
 if a is not null and a<>'null'::jsonb and a->>'interest' is distinct from '0'then issues:=array_append(issues,'MORA_PENALTY_UNSUPPORTED');end if;
 if p_event->>'amount_cents'='0' or p_event->>'paid_cents'='0'then issues:=array_append(issues,'NET_CREDIT_AMOUNT_INVALID');end if;
 if a is not null and a<>'null'::jsonb and(p_event->>'paid_cents')::numeric+(a->>'fee')::numeric<>(p_event->>'amount_cents')::numeric then issues:=array_append(issues,'NET_CREDIT_EQUATION_DIFFERS');end if;
 if a->>'fee'='0'then issues:=array_append(issues,'FEE_REQUIRED');end if;
 if p_category is null or p_category='null'::jsonb or p_category->'active' is distinct from 'true'::jsonb or p_category->>'kind'not in('payable','both')then issues:=array_append(issues,'FEE_CATEGORY_NOT_READY');end if;
 if p_category is not null and p_category<>'null'::jsonb and(p_category->>'version')::integer<>p_expected_category then issues:=array_append(issues,'FEE_CATEGORY_VERSION_CHANGED');end if;
 if cardinality(issues)=0 then
  posting:=jsonb_build_object('principal_cents',p_event->>'amount_cents','interest_cents','0','penalty_cents','0','fee_cents',a->>'fee',
   'gross_credit_cents',p_event->>'amount_cents','net_cash_cents',p_event->>'paid_cents','fee_category',p_category-'active',
   'legs',jsonb_build_array(jsonb_build_object('kind','payment','delta_cents',p_event->>'amount_cents'),jsonb_build_object('kind','bank_fee','delta_cents','-'||(a->>'fee'))));
 end if;
 return jsonb_build_object('policy','itau109-net-credit-v1','issues',to_jsonb(issues),'posting',posting);
end $$;
create function erp_cnab.itau_net_credit_context(p_event uuid,p_file uuid,p_line integer,p_category uuid,p_expected_category integer)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare b jsonb;cat jsonb;plan jsonb;issues jsonb;
begin
 if p_category is null or p_expected_category is null or p_expected_category<1 then raise exception 'erp_cnab_fee_category_required'using errcode='22023';end if;
 b:=erp_cnab.operational_event_context(p_event,p_file,p_line);
 select jsonb_build_object('id',id,'version',version,'name',name,'kind',kind,'active',active)into cat from erp_finance.category where id=p_category;
 plan:=erp_cnab.itau_net_credit_plan(b->'event',cat,p_expected_category);
 select coalesce(jsonb_agg(value order by ord),'[]')into issues from jsonb_array_elements(b#>'{settlement,issues}')with ordinality x(value,ord)
  where value#>>'{}'not in('PAYMENT_AMOUNT_DIFFERS','PAYMENT_ADJUSTMENTS_UNSUPPORTED');
 issues:=issues||(plan->'issues');
 return jsonb_build_object('policy','itau109-net-credit-v1','base',b,'category_selection',jsonb_build_object('id',p_category,'expected_version',p_expected_category),
  'category',cat,'plan',plan,'settlement',jsonb_build_object('allowed',jsonb_array_length(issues)=0,'issues',issues));
end $$;
create function public.erp_cnab_itau_net_credit_preview(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,p_fee_category_id uuid,p_expected_fee_category_version integer)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare c jsonb;begin
 perform erp_cnab.access(p_user_id,true);c:=erp_cnab.itau_net_credit_context(p_event_id,p_file_id,p_line,p_fee_category_id,p_expected_fee_category_version);
 return erp_cnab.operational_safety()||jsonb_build_object('policy','itau109-net-credit-v1','event_id',p_event_id,'context',c,'context_hash',erp_cnab.operational_context_hash(c),'bytes_verified',false);
end $$;
create function public.erp_cnab_itau_net_credit_settle(p_user_id uuid,p_event_id uuid,p_file_id uuid,p_line integer,p_fee_category_id uuid,p_expected_fee_category_version integer,p_expected_approval integer,p_command_id uuid,p_context_hash text,p_confirm boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h text;prior erp_cnab.operational_settlement;pid uuid;c jsonb;b jsonb;p jsonb;result jsonb;r jsonb;f erp_cnab.return_file;movements jsonb;
begin
 perform erp_cnab.access(p_user_id,true);
 if p_command_id is null or p_confirm is distinct from true or p_expected_approval is null or p_expected_approval<1 or p_fee_category_id is null or p_expected_fee_category_version is null or p_expected_fee_category_version<1 or p_context_hash is null or p_context_hash!~'^[a-f0-9]{64}$'then raise exception 'erp_cnab_net_credit_invalid'using errcode='22023';end if;
 h:=encode(sha256(convert_to(jsonb_build_object('policy','itau109-net-credit-v1','actor',p_user_id,'event_id',p_event_id,'file_id',p_file_id,'line',p_line,
  'category_id',p_fee_category_id,'category_version',p_expected_fee_category_version,'approval_version',p_expected_approval,'context_hash',p_context_hash)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));perform erp_cnab.access(p_user_id,true);
 select * into prior from erp_cnab.operational_settlement where command_id=p_command_id;
 if prior.command_id is not null and(prior.actor<>p_user_id or prior.request_hash<>h or prior.receipt->>'policy'is distinct from'itau109-net-credit-v1')then raise exception 'erp_cnab_operational_command_conflict'using errcode='40001';end if;
 if prior.command_id is null and exists(select 1 from erp_finance.command where id=p_command_id)then raise exception 'erp_cnab_operational_command_conflict'using errcode='40001';end if;
 pid:=erp_cnab.lock_operational_event(p_event_id,p_file_id,p_line,p_expected_approval);perform erp_cnab.access(p_user_id,true);
 if prior.command_id is not null then return jsonb_build_object('policy','itau109-net-credit-v1','purpose','operational','originAuthenticated',false,'bankTransmissionPerformed',false,'financialMutationPerformed',true,'replayed',true,'receipt',prior.receipt);end if;
 -- The existing lock helper ends with account; category_save never waits for an
 -- account/profile, and reversal does NOT reacquire this category lock.
 perform 1 from erp_finance.category where id=p_fee_category_id for share;
 c:=erp_cnab.itau_net_credit_context(p_event_id,p_file_id,p_line,p_fee_category_id,p_expected_fee_category_version);
 if erp_cnab.operational_context_hash(c)<>p_context_hash or c#>'{settlement,allowed}'is distinct from'true'::jsonb then raise exception 'erp_cnab_operational_review_changed'using errcode='40001';end if;
 b:=c->'base';p:=c#>'{plan,posting}';select * into f from erp_cnab.return_file where id=p_file_id;
 perform erp_cnab.storage_check(pid,'returns',f.file_hash,f.byte_size,f.object_path);
 insert into erp_finance.cnab_cash_plan(command_id,event_id,title_id,account_id,actor,principal_cents,fee_cents,net_cash_cents,category_id,category_snapshot)
 values(p_command_id,p_event_id,(b#>>'{title,id}')::uuid,(b#>>'{account,id}')::uuid,p_user_id,(p->>'principal_cents')::bigint,(p->>'fee_cents')::bigint,(p->>'net_cash_cents')::bigint,p_fee_category_id,p->'fee_category');
 result:=public.erp_finance_execute(p_user_id,p_command_id,'settle',jsonb_build_object('id',b#>'{title,id}','expected_version',b#>'{title,version}',
  'account_id',b#>'{account,id}','posted_on',b#>'{event,credited_on}','principal_cents',p->'principal_cents','fee_cents',p->'fee_cents','note','CNAB Itaú109 net-credit: evento '||p_event_id::text));
 select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'delta_cents',delta_cents::text)order by case when kind='payment'then 0 else 1 end)into movements from erp_finance.movement where settlement_id=(result#>>'{settlement,id}')::uuid;
 r:=jsonb_build_object('policy','itau109-net-credit-v1','command_id',p_command_id,'event_id',p_event_id,'event_hash',b#>'{event,hash}',
  'file_id',p_file_id,'file_hash',f.file_hash,'line',p_line,'profile_id',pid,'approval_version',p_expected_approval,'context_hash',p_context_hash,
  'billing_title_id',b#>'{billing,id}','title_id',b#>'{title,id}','account_id',b#>'{account,id}','settlement_id',result#>'{settlement,id}',
  'posted_on',b#>'{event,credited_on}','posting',p,'movements',movements,'created_at',clock_timestamp());
 insert into erp_cnab.operational_settlement(event_id,billing_title_id,title_id,settlement_id,profile_id,file_id,line,command_id,actor,request_hash,receipt)
 values(p_event_id,(b#>>'{billing,id}')::uuid,(b#>>'{title,id}')::uuid,(result#>>'{settlement,id}')::uuid,pid,p_file_id,p_line,p_command_id,p_user_id,h,r);
 insert into erp_cnab.audit(actor,command_id,action,record_id)values(p_user_id,p_command_id,'itau_net_credit_settle',p_event_id);
 return jsonb_build_object('policy','itau109-net-credit-v1','purpose','operational','originAuthenticated',false,'bankTransmissionPerformed',false,'financialMutationPerformed',true,'replayed',false,'receipt',r);
end $$;
create function public.erp_cnab_itau_net_credit_command(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$declare o erp_cnab.operational_settlement;begin
 perform erp_cnab.access(p_user_id);select * into o from erp_cnab.operational_settlement where command_id=p_command_id and receipt->>'policy'='itau109-net-credit-v1';
 if not found then raise exception 'erp_cnab_not_found'using errcode='P0002';end if;
 return jsonb_build_object('policy','itau109-net-credit-v1','purpose','operational','read_only',true,'financialMutationPerformed',false,'originAuthenticated',false,'bankTransmissionPerformed',false,
  'receipt',o.receipt,'current_title',erp_finance.dto('titles',o.title_id),'current_account',erp_finance.dto('accounts',(o.receipt->>'account_id')::uuid),
  'current_settlement',erp_finance.dto('settlements',o.settlement_id));
end $$;

-- 019 engine preserved; movement insertion delegates to the private writer above.
create or replace function public.erp_finance_execute(p_user_id uuid,p_command_id uuid,p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_hash text; v_command erp_finance.command%rowtype; v_result jsonb; v_before jsonb; v_id uuid; v_version integer;
  v_account erp_finance.account%rowtype; v_category erp_finance.category%rowtype; v_title erp_finance.title%rowtype; v_original erp_finance.settlement%rowtype;
  v_name text; v_kind text; v_active boolean; v_contact uuid; v_category_id uuid; v_issued date; v_due date; v_day date;
  v_amount bigint; v_principal bigint; v_interest bigint; v_penalty bigint; v_discount bigint; v_fee bigint; v_net bigint; v_delta bigint;
  v_group uuid; v_item jsonb; v_items jsonb:='[]'::jsonb; v_count integer; v_index integer:=0; v_total numeric:=0; v_settlement uuid; v_note text;
begin
  perform erp_finance.require_access(p_user_id,true);
  if p_command_id is null or p_action is null or p_action not in ('account_save','category_save','title_create_group','title_update','title_cancel','settle','reverse','opening') then
    raise exception 'erp_finance_invalid_action' using errcode='22023'; end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' or octet_length(p_data::text)>65536 then raise exception 'erp_finance_invalid_data' using errcode='22023'; end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action',p_action,'data',p_data)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
  perform erp_finance.require_access(p_user_id,true);
  select * into v_command from erp_finance.command where id=p_command_id;
  if found then
    if v_command.actor<>p_user_id or v_command.request_hash<>v_hash then raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
    return erp_finance.project_result_link(v_command.result)||jsonb_build_object('replayed',true);
  end if;

  if p_action in ('account_save','category_save') then
    perform erp_finance.keys(p_data,array['id','expected_version','name','kind','active']);
    v_id:=erp_finance.uuid_value(p_data->'id',false); v_version:=erp_finance.expected(p_data->'expected_version',v_id is null);
    v_name:=erp_finance.txt(p_data,'name',200,true); v_kind:=erp_finance.txt(p_data,'kind',20,true);
    if p_data?'active' and jsonb_typeof(p_data->'active')<>'boolean' then raise exception 'erp_finance_invalid_active' using errcode='22023'; end if;
    v_active:=coalesce((p_data->>'active')::boolean,true);
    if p_action='account_save' then
      if v_kind not in ('bank','cash','other') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      if v_id is null then insert into erp_finance.account(name,kind,active) values(v_name,v_kind,v_active) returning id into v_id;
      else
        select * into v_account from erp_finance.account where id=v_id for update;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_account.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
        v_before:=erp_finance.dto('accounts',v_id);
        update erp_finance.account set name=v_name,kind=v_kind,active=case when p_data?'active' then v_active else active end,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      v_result:=jsonb_build_object('entity','accounts','record',erp_finance.dto('accounts',v_id));
    else
      if v_kind not in ('receivable','payable','both') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
      if v_id is null then insert into erp_finance.category(name,kind,active) values(v_name,v_kind,v_active) returning id into v_id;
      else
        select * into v_category from erp_finance.category where id=v_id for update;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_category.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
        if v_kind<>'both' and exists(select 1 from erp_finance.title where category_id=v_id and kind<>v_kind) then raise exception 'erp_finance_category_in_use' using errcode='40001'; end if;
        v_before:=erp_finance.dto('categories',v_id);
        update erp_finance.category set name=v_name,kind=v_kind,active=case when p_data?'active' then v_active else active end,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      v_result:=jsonb_build_object('entity','categories','record',erp_finance.dto('categories',v_id));
    end if;

  elsif p_action='title_create_group' then
    perform erp_finance.keys(p_data,array['kind','contact_id','category_id','description','source_reference','issued_on','total_cents','installments']);
    v_kind:=erp_finance.txt(p_data,'kind',20,true); v_contact:=erp_finance.uuid_value(p_data->'contact_id'); v_category_id:=erp_finance.uuid_value(p_data->'category_id',false);
    if v_kind not in ('receivable','payable') then raise exception 'erp_finance_invalid_kind' using errcode='22023'; end if;
    if not exists(select 1 from erp_catalog.contact c join erp_catalog.record r on r.id=c.record_id where c.record_id=v_contact and r.active) then raise exception 'erp_finance_invalid_contact' using errcode='22023'; end if;
    if v_category_id is not null then
      perform 1 from erp_finance.category where id=v_category_id and active and kind in (v_kind,'both') for share;
      if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
    end if;
    v_issued:=erp_finance.day(p_data->'issued_on'); v_amount:=erp_finance.cents(p_data->'total_cents',false);
    v_name:=erp_finance.txt(p_data,'description',240,true); v_note:=erp_finance.txt(p_data,'source_reference',200);
    if jsonb_typeof(p_data->'installments') is distinct from 'array' or jsonb_array_length(p_data->'installments') not between 1 and 120 then raise exception 'erp_finance_invalid_installments' using errcode='22023'; end if;
    v_count:=jsonb_array_length(p_data->'installments'); v_group:=gen_random_uuid();
    for v_item in select value from jsonb_array_elements(p_data->'installments') loop
      perform erp_finance.keys(v_item,array['amount_cents','due_on']);
      v_principal:=erp_finance.cents(v_item->'amount_cents',false); v_due:=erp_finance.day(v_item->'due_on');
      if v_due<v_issued then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_index:=v_index+1; v_total:=v_total+v_principal;
      insert into erp_finance.title(group_id,installment,installments,kind,contact_id,category_id,description,source_reference,issued_on,due_on,amount_cents)
        values(v_group,v_index,v_count,v_kind,v_contact,v_category_id,v_name,v_note,v_issued,v_due,v_principal) returning id into v_id;
      v_items:=v_items||jsonb_build_array(erp_finance.dto('titles',v_id));
    end loop;
    if v_total<>v_amount then raise exception 'erp_finance_installment_total_mismatch' using errcode='22023'; end if;
    v_result:=jsonb_build_object('entity','titles','group_id',v_group,'items',v_items);

  elsif p_action in ('title_update','title_cancel','settle','reverse') then
    if p_action='title_update' then perform erp_finance.keys(p_data,array['id','expected_version','description','source_reference','due_on','amount_cents','category_id']);
    elsif p_action='title_cancel' then perform erp_finance.keys(p_data,array['id','expected_version','note']);
    elsif p_action='settle' then perform erp_finance.keys(p_data,array['id','expected_version','account_id','posted_on','principal_cents','interest_cents','penalty_cents','discount_cents','fee_cents','note']);
    else perform erp_finance.keys(p_data,array['id','expected_version','settlement_id','posted_on','note']); end if;
    v_id:=erp_finance.uuid_value(p_data->'id'); v_version:=erp_finance.expected(p_data->'expected_version');
    select * into v_title from erp_finance.title where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_title.version<>v_version then raise exception 'erp_finance_version_conflict' using errcode='40001'; end if;
    if v_title.cancelled then raise exception 'erp_finance_cancelled_title' using errcode='40001'; end if;
    v_before:=erp_finance.dto('titles',v_id);
    if p_action='title_update' then
      v_amount:=case when p_data?'amount_cents' then erp_finance.cents(p_data->'amount_cents',false) else v_title.amount_cents end;
      if v_amount<>v_title.amount_cents and (v_title.installments>1 or exists(select 1 from erp_finance.settlement where title_id=v_id)) then
        raise exception 'erp_finance_principal_locked' using errcode='40001'; end if;
      v_due:=case when p_data?'due_on' then erp_finance.day(p_data->'due_on') else v_title.due_on end;
      if v_due<v_title.issued_on then raise exception 'erp_finance_invalid_due_date' using errcode='22023'; end if;
      v_category_id:=case when p_data?'category_id' then erp_finance.uuid_value(p_data->'category_id',false) else v_title.category_id end;
      if v_category_id is not null then
        perform 1 from erp_finance.category where id=v_category_id and active and kind in (v_title.kind,'both') for share;
        if not found then raise exception 'erp_finance_invalid_category' using errcode='22023'; end if;
      end if;
      update erp_finance.title set description=case when p_data?'description' then erp_finance.txt(p_data,'description',240,true) else description end,
        source_reference=case when p_data?'source_reference' then erp_finance.txt(p_data,'source_reference',200) else source_reference end,
        due_on=v_due,amount_cents=v_amount,category_id=v_category_id,version=version+1,updated_at=clock_timestamp() where id=v_id;
    elsif p_action='title_cancel' then
      if v_title.settled_cents<>0 then raise exception 'erp_finance_active_payments' using errcode='40001'; end if;
      v_note:=erp_finance.txt(p_data,'note',500,true);
      update erp_finance.title set cancelled=true,version=version+1,updated_at=clock_timestamp() where id=v_id;
    else
      v_day:=erp_finance.day(p_data->'posted_on',true); v_note:=erp_finance.txt(p_data,'note',500,p_action='reverse');
      if v_day<v_title.issued_on then raise exception 'erp_finance_payment_before_issue' using errcode='22023'; end if;
      if p_action='settle' then
        select * into v_account from erp_finance.account where id=erp_finance.uuid_value(p_data->'account_id') for update;
        if not found or not v_account.active then raise exception 'erp_finance_invalid_account' using errcode='22023'; end if;
        if exists(select 1 from erp_finance.movement where account_id=v_account.id and kind='opening' and posted_on>v_day) then raise exception 'erp_finance_payment_before_opening' using errcode='22023'; end if;
        v_principal:=erp_finance.cents(p_data->'principal_cents',false);
        v_interest:=erp_finance.cents(coalesce(p_data->'interest_cents','"0"'::jsonb)); v_penalty:=erp_finance.cents(coalesce(p_data->'penalty_cents','"0"'::jsonb));
        v_discount:=erp_finance.cents(coalesce(p_data->'discount_cents','"0"'::jsonb)); v_fee:=erp_finance.cents(coalesce(p_data->'fee_cents','"0"'::jsonb));
        if v_principal>v_title.amount_cents-v_title.settled_cents then raise exception 'erp_finance_overpayment' using errcode='40001'; end if;
        v_net:=v_principal+v_interest+v_penalty-v_discount+case when v_title.kind='payable' then v_fee else -v_fee end;
        if v_net<0 or v_net>999999999999999 or v_discount>v_principal+v_interest+v_penalty then raise exception 'erp_finance_invalid_net_cash' using errcode='22023'; end if;
        perform erp_finance.require_access(p_user_id,true);
        insert into erp_finance.settlement(title_id,account_id,kind,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
          values(v_id,v_account.id,'payment',v_day,v_principal,v_interest,v_penalty,v_discount,v_fee,v_net,v_note,p_user_id,p_command_id) returning id into v_settlement;
        v_delta:=case when v_title.kind='receivable' then v_net else -v_net end;
        update erp_finance.title set settled_cents=settled_cents+v_principal,version=version+1,updated_at=clock_timestamp() where id=v_id;
      else
        select * into v_original from erp_finance.settlement where id=erp_finance.uuid_value(p_data->'settlement_id') and title_id=v_id;
        if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
        if v_original.kind<>'payment' or exists(select 1 from erp_finance.settlement where reverses_id=v_original.id) then raise exception 'erp_finance_reversal_conflict' using errcode='40001'; end if;
        if v_day<v_original.posted_on then raise exception 'erp_finance_invalid_reversal_date' using errcode='22023'; end if;
        select * into v_account from erp_finance.account where id=v_original.account_id for update;
        perform erp_finance.require_access(p_user_id,true);
        insert into erp_finance.settlement(title_id,account_id,kind,reverses_id,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,actor,command_id)
          values(v_id,v_account.id,'reversal',v_original.id,v_day,v_original.principal_cents,v_original.interest_cents,v_original.penalty_cents,v_original.discount_cents,v_original.fee_cents,v_original.net_cash_cents,v_note,p_user_id,p_command_id) returning id into v_settlement;
        v_delta:=case when v_title.kind='receivable' then -v_original.net_cash_cents else v_original.net_cash_cents end;
        update erp_finance.title set settled_cents=settled_cents-v_original.principal_cents,version=version+1,updated_at=clock_timestamp() where id=v_id;
      end if;
      perform erp_finance.post_settlement_movements(v_settlement,v_delta);
      update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id=v_account.id;
    end if;
    v_result:=jsonb_build_object('entity','titles','record',erp_finance.dto('titles',v_id),'note',v_note);
    if v_settlement is not null then v_result:=v_result||jsonb_build_object('settlement',erp_finance.dto('settlements',v_settlement),'account',erp_finance.dto('accounts',v_account.id)); end if;

  elsif p_action='opening' then
    perform erp_finance.keys(p_data,array['id','expected_version','amount_cents','posted_on','note']);
    v_id:=erp_finance.uuid_value(p_data->'id'); v_version:=erp_finance.expected(p_data->'expected_version');
    v_day:=erp_finance.day(p_data->'posted_on',true); v_amount:=erp_finance.cents(p_data->'amount_cents',true,true); v_note:=erp_finance.txt(p_data,'note',500,true);
    select * into v_account from erp_finance.account where id=v_id for update;
    if not found then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
    if v_account.version<>v_version or v_account.opening_recorded or not v_account.active then raise exception 'erp_finance_opening_conflict' using errcode='40001'; end if;
    if exists(select 1 from erp_finance.movement where account_id=v_id and posted_on<v_day) then raise exception 'erp_finance_opening_after_movement' using errcode='22023'; end if;
    v_before:=erp_finance.dto('accounts',v_id);
    insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id) values(v_id,'opening',v_amount,v_day,v_note,p_user_id,p_command_id);
    update erp_finance.account set opening_recorded=true,version=version+1,updated_at=clock_timestamp() where id=v_id;
    v_result:=jsonb_build_object('entity','accounts','record',erp_finance.dto('accounts',v_id));
  end if;

  -- A role may have been revoked while any title/account/category lock waited.
  -- Failure rolls back all provisional changes before the command receipt exists.
  perform erp_finance.require_access(p_user_id,true);
  v_result:=v_result||jsonb_build_object('action',p_action,'data_mode','erp_native','replayed',false);
  insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,v_hash,v_result);
  insert into erp_finance.audit(actor,command_id,action,before_data,after_data) values(p_user_id,p_command_id,p_action,v_before,v_result);
  return v_result;
end $$;

revoke all on function erp_finance.cnab_plan_for_settlement(uuid),erp_finance.assert_settlement_postings(uuid),erp_finance.settlement_posting_check(),erp_finance.cnab_cash_plan_check(),erp_finance.cnab_cash_immutable(),erp_finance.post_settlement_movements(uuid,bigint),erp_cnab.itau_net_credit_plan(jsonb,jsonb,integer),erp_cnab.itau_net_credit_context(uuid,uuid,integer,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.erp_cnab_itau_net_credit_preview(uuid,uuid,uuid,integer,uuid,integer),public.erp_cnab_itau_net_credit_settle(uuid,uuid,uuid,integer,uuid,integer,integer,uuid,text,boolean),public.erp_cnab_itau_net_credit_command(uuid,uuid) from public,anon,authenticated;
grant execute on function public.erp_cnab_itau_net_credit_preview(uuid,uuid,uuid,integer,uuid,integer),public.erp_cnab_itau_net_credit_settle(uuid,uuid,uuid,integer,uuid,integer,integer,uuid,text,boolean),public.erp_cnab_itau_net_credit_command(uuid,uuid) to service_role;
commit;
