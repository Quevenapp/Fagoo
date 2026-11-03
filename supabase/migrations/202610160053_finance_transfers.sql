-- Internal ledger transfers only. No bank request, settlement, title or opening mutation.
begin;

create table erp_finance.transfer (
 id uuid primary key default gen_random_uuid(),
 command_id uuid not null unique references erp_finance.command(id) deferrable initially deferred,
 actor uuid not null references auth.users(id),
 from_account_id uuid not null references erp_finance.account(id),
 to_account_id uuid not null references erp_finance.account(id),
 amount_cents bigint not null check(amount_cents between 1 and 999999999999999),
 posted_on date not null, note text not null,
 from_snapshot jsonb not null, to_snapshot jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 check(from_account_id<>to_account_id)
);
alter table erp_finance.transfer enable row level security;
revoke all on erp_finance.transfer from public,anon,authenticated,service_role;
create index erp_finance_transfer_from on erp_finance.transfer(from_account_id,id);
create index erp_finance_transfer_to on erp_finance.transfer(to_account_id,id);

alter table erp_finance.movement add column transfer_id uuid references erp_finance.transfer(id);
alter table erp_finance.movement drop constraint movement_kind_check;
alter table erp_finance.movement drop constraint movement_check;
alter table erp_finance.movement add constraint movement_kind_check check(kind in ('opening','payment','reversal','transfer_out','transfer_in'));
alter table erp_finance.movement add constraint movement_check check(
 (kind='opening' and settlement_id is null and transfer_id is null)
 or (kind in ('payment','reversal') and settlement_id is not null and transfer_id is null)
 or (kind in ('transfer_out','transfer_in') and settlement_id is null and transfer_id is not null)
);
create unique index erp_finance_transfer_leg_kind on erp_finance.movement(transfer_id,kind) where transfer_id is not null;
create unique index erp_finance_transfer_leg_account on erp_finance.movement(transfer_id,account_id) where transfer_id is not null;

create function erp_finance.transfer_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'erp_finance_transfer_immutable' using errcode='55000'; end $$;
create trigger erp_finance_transfer_immutable before update or delete on erp_finance.transfer
 for each row execute function erp_finance.transfer_immutable();
create trigger erp_finance_transfer_movement_immutable before update or delete on erp_finance.movement
 for each row when(old.transfer_id is not null) execute function erp_finance.transfer_immutable();
create trigger erp_finance_transfer_command_immutable before update or delete on erp_finance.command
 for each row when(old.result->>'action'='internal_transfer') execute function erp_finance.transfer_immutable();

create function erp_finance.transfer_leg_check()
returns trigger language plpgsql set search_path=pg_catalog as $$
declare t erp_finance.transfer;
begin
 if new.transfer_id is null then return new; end if;
 select * into t from erp_finance.transfer where id=new.transfer_id;
 if not found or new.actor is distinct from t.actor or new.command_id is distinct from t.command_id
  or new.posted_on is distinct from t.posted_on or new.note is distinct from t.note
  or not ((new.kind='transfer_out' and new.account_id=t.from_account_id and new.delta_cents=-t.amount_cents)
    or (new.kind='transfer_in' and new.account_id=t.to_account_id and new.delta_cents=t.amount_cents)) then
  raise exception 'erp_finance_transfer_leg_invalid' using errcode='22023';
 end if;
 return new;
end $$;
create trigger erp_finance_transfer_leg_check before insert or update on erp_finance.movement
 for each row execute function erp_finance.transfer_leg_check();
-- Deferred checks run at COMMIT, after the SECURITY DEFINER RPC has returned.
-- Keep this closed helper privileged; service_role still has no direct table access.
create function erp_finance.transfer_pair_check()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 if (select count(*) from erp_finance.movement where transfer_id=new.id)<>2 then
  raise exception 'erp_finance_transfer_incomplete' using errcode='22023';
 end if;
 return null;
end $$;
create constraint trigger erp_finance_transfer_pair_check after insert on erp_finance.transfer
 deferrable initially deferred for each row execute function erp_finance.transfer_pair_check();

create function erp_finance.transfer_flags()
returns jsonb language sql immutable set search_path=pg_catalog as $$
 select jsonb_build_object('scope','finance_internal_transfer','data_mode','erp_native',
  'bank_operation_performed',false,'title_mutation_performed',false,'opening_mutation_performed',false)
$$;
create function erp_finance.transfer_account(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'active',a.active,'opening_recorded',a.opening_recorded,
  'version',a.version,'balance_cents',coalesce((select sum(m.delta_cents) from erp_finance.movement m where m.account_id=a.id),0)::text,
  'opening_on',(select m.posted_on from erp_finance.movement m where m.account_id=a.id and m.kind='opening'))
 from erp_finance.account a where a.id=p_id
$$;
create function erp_finance.transfer_view(p_id uuid)
returns jsonb language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('receipt',jsonb_build_object('id',t.id,'command_id',t.command_id,
  'from_account',t.from_snapshot,'to_account',t.to_snapshot,'amount_cents',t.amount_cents::text,'posted_on',t.posted_on,'note',t.note,'created_at',t.created_at,
  'movements',(select jsonb_agg(jsonb_build_object('id',m.id,'account_id',m.account_id,'kind',m.kind,'delta_cents',m.delta_cents::text)
    order by case when m.kind='transfer_out' then 0 else 1 end) from erp_finance.movement m where m.transfer_id=t.id)),
  'current',jsonb_build_object('from_account',erp_finance.transfer_account(t.from_account_id),'to_account',erp_finance.transfer_account(t.to_account_id)))
 from erp_finance.transfer t where t.id=p_id
$$;

create function public.erp_finance_transfer_post(p_user_id uuid,p_command_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 h text; cmd erp_finance.command; src uuid; dst uuid; src_version integer; dst_version integer;
 a erp_finance.account; b erp_finance.account; amount bigint; day date; note text; tid uuid;
 ca jsonb; cb jsonb; sa jsonb; sb jsonb; result jsonb;
begin
 perform erp_finance.require_access(p_user_id,true);
 perform erp_finance.keys(p_data,array['from_account_id','to_account_id','expected_from_version','expected_to_version','amount_cents','posted_on','note','confirmed']);
 if p_command_id is null or (select count(*) from jsonb_object_keys(p_data))<>8 or p_data->'confirmed' is distinct from 'true'::jsonb then
  raise exception 'erp_finance_transfer_invalid' using errcode='22023'; end if;
 src:=erp_finance.uuid_value(p_data->'from_account_id'); dst:=erp_finance.uuid_value(p_data->'to_account_id');
 src_version:=erp_finance.expected(p_data->'expected_from_version'); dst_version:=erp_finance.expected(p_data->'expected_to_version');
 if src=dst or jsonb_typeof(p_data->'amount_cents') is distinct from 'string' or p_data->>'amount_cents'!~'^[1-9][0-9]{0,14}$' then
  raise exception 'erp_finance_transfer_invalid' using errcode='22023'; end if;
 amount:=erp_finance.cents(p_data->'amount_cents',false); day:=erp_finance.day(p_data->'posted_on',true);
 note:=erp_finance.txt(p_data,'note',500,true);
 if note is distinct from p_data->>'note' or length(note)<3 or note~'[[:cntrl:]]'
  or length(regexp_replace(note,'[[:space:]'||chr(160)||chr(5760)||chr(8192)||'-'||chr(8203)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)||']','','g'))=0 then
  raise exception 'erp_finance_transfer_note_invalid' using errcode='22023'; end if;
 h:=encode(sha256(convert_to(jsonb_build_object('actor',p_user_id,'action','internal_transfer','data',p_data)::text,'UTF8')),'hex');
 -- Same command namespace as 010; a UUID cannot identify two financial actions.
 perform pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
 -- A command wait may outlive the permission checked at entry, including on replay.
 perform erp_finance.require_access(p_user_id,true);
 select * into cmd from erp_finance.command where id=p_command_id;
 if found then
  if cmd.actor is distinct from p_user_id or cmd.request_hash is distinct from h or cmd.result->>'action' is distinct from 'internal_transfer' then
   raise exception 'erp_finance_command_conflict' using errcode='40001'; end if;
  select id into tid from erp_finance.transfer where command_id=p_command_id;
  if tid is null then raise exception 'erp_finance_transfer_missing' using errcode='55000'; end if;
  return erp_finance.transfer_flags()||erp_finance.transfer_view(tid)||jsonb_build_object('replayed',true);
 end if;
 -- Lock both accounts in one deterministic order. Never acquire a title/profile lock here.
 perform 1 from erp_finance.account where id in(src,dst) order by id for update;
 perform erp_finance.require_access(p_user_id,true);
 select * into a from erp_finance.account where id=src; select * into b from erp_finance.account where id=dst;
 if a.id is null or b.id is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
 if not a.active or not b.active or a.version<>src_version or b.version<>dst_version or a.version=2147483647 or b.version=2147483647 then
  raise exception 'erp_finance_transfer_account_conflict' using errcode='40001'; end if;
 day:=erp_finance.day(p_data->'posted_on',true);
 if exists(select 1 from erp_finance.movement where account_id in(src,dst) and kind='opening' and posted_on>day) then
  raise exception 'erp_finance_transfer_before_opening' using errcode='22023'; end if;
 ca:=erp_finance.transfer_account(src); cb:=erp_finance.transfer_account(dst);
 sa:=jsonb_build_object('id',a.id,'name',a.name,'kind',a.kind,'version_before',a.version,'version_after',a.version+1,
  'balance_before_cents',ca->>'balance_cents','balance_after_cents',((ca->>'balance_cents')::numeric-amount)::text,'opening_on',ca->'opening_on');
 sb:=jsonb_build_object('id',b.id,'name',b.name,'kind',b.kind,'version_before',b.version,'version_after',b.version+1,
  'balance_before_cents',cb->>'balance_cents','balance_after_cents',((cb->>'balance_cents')::numeric+amount)::text,'opening_on',cb->'opening_on');
 insert into erp_finance.transfer(command_id,actor,from_account_id,to_account_id,amount_cents,posted_on,note,from_snapshot,to_snapshot)
  values(p_command_id,p_user_id,src,dst,amount,day,note,sa,sb) returning id into tid;
 insert into erp_finance.movement(account_id,kind,delta_cents,posted_on,note,actor,command_id,transfer_id)
  values(src,'transfer_out',-amount,day,note,p_user_id,p_command_id,tid),(dst,'transfer_in',amount,day,note,p_user_id,p_command_id,tid);
 update erp_finance.account set version=version+1,updated_at=clock_timestamp() where id in(src,dst);
 result:=erp_finance.transfer_flags()||erp_finance.transfer_view(tid)||jsonb_build_object('replayed',false);
 insert into erp_finance.command(id,actor,request_hash,result) values(p_command_id,p_user_id,h,result||jsonb_build_object('action','internal_transfer'));
 insert into erp_finance.audit(actor,command_id,action,before_data,after_data)
  values(p_user_id,p_command_id,'internal_transfer',jsonb_build_object('from_account',ca,'to_account',cb),result);
 return result;
end $$;

create function public.erp_finance_transfer_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare v jsonb;
begin
 perform erp_finance.require_access(p_user_id,false); v:=erp_finance.transfer_view(p_id);
 if v is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
 return erp_finance.transfer_flags()||v||jsonb_build_object('read_only',true);
end $$;
create function public.erp_finance_transfer_command(p_user_id uuid,p_command_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare tid uuid;
begin
 perform erp_finance.require_access(p_user_id,false);
 select id into tid from erp_finance.transfer where command_id=p_command_id and actor=p_user_id;
 if tid is null then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
 return erp_finance.transfer_flags()||erp_finance.transfer_view(tid)||jsonb_build_object('read_only',true);
end $$;
create function public.erp_finance_transfer_list(p_user_id uuid,p_account_id uuid default null,p_limit integer default 25,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb; more boolean;
begin
 perform erp_finance.require_access(p_user_id,false);
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'erp_finance_invalid_query' using errcode='22023'; end if;
 if p_account_id is not null and not exists(select 1 from erp_finance.account where id=p_account_id) then raise exception 'erp_finance_not_found' using errcode='P0002'; end if;
 with page as (select t.id,erp_finance.transfer_view(t.id) item from erp_finance.transfer t
  where (p_account_id is null or t.from_account_id=p_account_id or t.to_account_id=p_account_id) and (p_after is null or t.id>p_after)
  order by t.id limit p_limit+1)
 select coalesce(jsonb_agg(item order by id),'[]'::jsonb),count(*)>p_limit into items,more from page;
 if more then items:=items-p_limit; end if;
 return erp_finance.transfer_flags()||jsonb_build_object('read_only',true,'items',items,'limit',p_limit,'has_more',more,
  'next_cursor',case when more then items->(p_limit-1)->'receipt'->>'id' end);
end $$;

revoke all on function erp_finance.transfer_immutable(),erp_finance.transfer_leg_check(),erp_finance.transfer_pair_check(),erp_finance.transfer_flags(),erp_finance.transfer_account(uuid),erp_finance.transfer_view(uuid) from public,anon,authenticated,service_role;
revoke all on function public.erp_finance_transfer_post(uuid,uuid,jsonb),public.erp_finance_transfer_get(uuid,uuid),public.erp_finance_transfer_command(uuid,uuid),public.erp_finance_transfer_list(uuid,uuid,integer,uuid) from public,anon,authenticated;
grant execute on function public.erp_finance_transfer_post(uuid,uuid,jsonb),public.erp_finance_transfer_get(uuid,uuid),public.erp_finance_transfer_command(uuid,uuid),public.erp_finance_transfer_list(uuid,uuid,integer,uuid) to service_role;
commit;
