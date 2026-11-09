-- Reviewed consolidation: import is inert until a reconciled, explicit cutover.
begin;
create table fagoo.consolidation_run(
 id uuid primary key,unit_id uuid not null unique references fagoo.unit(id),source_id text not null unique,
 source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),plan_sha256 text not null check(plan_sha256~'^[a-f0-9]{64}$'),
 archive_sha256 text not null check(archive_sha256~'^[a-f0-9]{64}$'),manifest jsonb not null,
 status text not null default 'imported' check(status in('importing','imported','verified','active')),actor uuid not null references auth.users(id),
 imported_at timestamptz not null default now(),verified_at timestamptz,activated_at timestamptz,evidence jsonb
);
create table fagoo.consolidation_item(run_id uuid not null references fagoo.consolidation_run(id),kind text not null,id uuid not null,snapshot jsonb not null,primary key(run_id,kind,id));
create table fagoo.consolidation_identity(run_id uuid not null references fagoo.consolidation_run(id),source_kind text not null,source_id text not null,target_id uuid not null,primary key(run_id,source_kind,source_id));
create table fagoo.consolidation_channel(channel_key text primary key,run_id uuid not null references fagoo.consolidation_run(id),profile_id text not null,unit_id uuid not null references fagoo.unit(id),consumer text not null check(consumer in('legacy','fagoo')));
alter table fagoo.consolidation_run enable row level security;alter table fagoo.consolidation_item enable row level security;alter table fagoo.consolidation_identity enable row level security;alter table fagoo.consolidation_channel enable row level security;

create function public.fagoo_consolidation_import(p_user_id uuid,p_bundle jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare rid uuid:=(p_bundle->>'run_id')::uuid;uid uuid:=(p_bundle->>'unit_id')::uuid;v_old fagoo.consolidation_run;kind text;table_name text;row_data jsonb;v_id uuid;v_saved jsonb;v jsonb;
begin
 perform erp_access.require_admin(p_user_id,true);perform fagoo.require_unit(p_user_id,null,uid,'units.manage');
 if p_bundle->>'format' is distinct from 'fagoo-consolidation-v1' or rid is null or length(p_bundle->>'source_id') not between 1 and 160 or octet_length(p_bundle::text)>52428800 then raise exception 'consolidation_invalid_bundle' using errcode='22023';end if;
 perform pg_advisory_xact_lock(1900910006);
 perform pg_advisory_xact_lock(hashtextextended('queue-authority:'||uid::text,0));
 select * into v_old from fagoo.consolidation_run where id=rid;
 if found then if v_old.unit_id<>uid or v_old.plan_sha256<>p_bundle->>'plan_sha256' or v_old.manifest<>p_bundle-'records' then raise exception 'consolidation_replay_conflict' using errcode='40001';end if;return jsonb_build_object('run_id',rid,'status',v_old.status,'replayed',true);end if;
 if exists(select 1 from fagoo.queue_ticket where unit_id=uid) or exists(select 1 from fagoo.queue_order where unit_id=uid) or exists(select 1 from fagoo.queue_event where unit_id=uid) then raise exception 'consolidation_target_not_empty' using errcode='23505';end if;
 insert into fagoo.consolidation_run(id,unit_id,source_id,source_sha256,plan_sha256,archive_sha256,manifest,actor,status) values(rid,uid,p_bundle->>'source_id',p_bundle->>'source_sha256',p_bundle->>'plan_sha256',p_bundle->>'archive_sha256',p_bundle-'records',p_user_id,'importing');
 for v in select value from jsonb_array_elements(coalesce(p_bundle->'identities','[]')) loop
  if v->>'source_kind' not in('device','user','contact','campaign') then raise exception 'consolidation_invalid_identity' using errcode='22023';end if;
  v_id:=(v->>'target_id')::uuid;
  if v->>'source_kind'='device' then
   if exists(select 1 from fagoo.device where id=v_id and unit_id<>uid) then raise exception 'consolidation_device_conflict' using errcode='23505';end if;
   insert into fagoo.device(id,unit_id,name,capabilities,active,settings) values(v_id,uid,coalesce(v->>'name','Dispositivo legado'),'{}',false,jsonb_build_object('legacy_source_id',v->>'source_id','enrollment_required',true)) on conflict(id) do nothing;
  elsif v->>'source_kind'='user' then
   if not exists(select 1 from erp_access.membership where user_id=v_id and active) then raise exception 'consolidation_unknown_user' using errcode='22023';end if;
  elsif v->>'source_kind'='contact' then
   if not exists(select 1 from erp_catalog.contact where record_id=v_id) then raise exception 'consolidation_unknown_contact' using errcode='22023';end if;
  end if;
  insert into fagoo.consolidation_identity values(rid,v->>'source_kind',v->>'source_id',v_id);
 end loop;
 -- Only typed, known business tables may be imported. No outbox, effect, live event or runtime receipt is replayed.
 foreach kind in array array['queues','tickets','services','orders','campaigns','rating_invites','ratings','subscriptions'] loop
  table_name:=case kind when 'queues' then 'queue_line' when 'tickets' then 'queue_ticket' when 'services' then 'queue_service' when 'orders' then 'queue_order' when 'campaigns' then 'queue_campaign' when 'rating_invites' then 'queue_rating_invite' when 'ratings' then 'queue_rating' when 'subscriptions' then 'queue_subscription' end;
  for row_data in select value from jsonb_array_elements(coalesce(p_bundle->'records'->kind,'[]')) loop
   v_id:=(row_data->>'id')::uuid;
   if kind<>'ratings' and row_data->>'unit_id' is distinct from uid::text then raise exception 'consolidation_cross_unit' using errcode='42501';end if;
   if kind='ratings' and not exists(select 1 from fagoo.queue_rating_invite where id=(row_data->>'invite_id')::uuid and unit_id=uid) then raise exception 'consolidation_cross_unit' using errcode='42501';end if;
   -- Use a complete typed record supplied by the exporter; constraints and FKs remain enabled.
   if kind='subscriptions' then
    insert into fagoo.queue_subscription(id,unit_id,ticket_id,public_token,channel,destination,status,created_at,activated_at) values(v_id,uid,(row_data->>'ticket_id')::uuid,row_data->>'public_token',row_data->>'channel',row_data->>'destination',row_data->>'status',(row_data->>'created_at')::timestamptz,(row_data->>'activated_at')::timestamptz) returning to_jsonb(queue_subscription.*) into v_saved;
   else execute format('insert into fagoo.%I select (jsonb_populate_record(null::fagoo.%I,$1)).* returning to_jsonb(%I.*)',table_name,table_name,table_name) into v_saved using row_data;end if;
   insert into fagoo.consolidation_item values(rid,kind,v_id,v_saved);
  end loop;
 end loop;
 insert into fagoo.queue_counter(unit_id,queue_id,business_day,last_number) select uid,original_queue_id,business_day,max(number) from fagoo.queue_ticket where unit_id=uid group by original_queue_id,business_day;
 insert into fagoo.queue_runtime(unit_id,revision) values(uid,0) on conflict(unit_id) do nothing;
 insert into fagoo.queue_config(unit_id) values(uid) on conflict(unit_id) do nothing;
 for v in select value from jsonb_array_elements(coalesce(p_bundle->'communication','[]')) loop
  if v->>'unit_id' is distinct from uid::text then raise exception 'consolidation_cross_unit' using errcode='42501';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v->'contacts','[]')) link where not exists(select 1 from erp_catalog.contact c where c.record_id=(link->>'canonical_contact_id')::uuid)) then raise exception 'consolidation_unknown_contact' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(coalesce(v->'actors','[]')) link where not exists(select 1 from erp_access.membership m where m.user_id=(link->>'canonical_user_id')::uuid and m.active)) then raise exception 'consolidation_unknown_user' using errcode='22023';end if;
  insert into fagoo.communication_binding(unit_id,profile_id) values(uid,v->>'profile_id');
  for row_data in select value from jsonb_array_elements(coalesce(v->'channels','[]')) loop
   if length(row_data->>'key') not between 1 and 200 then raise exception 'consolidation_invalid_channel' using errcode='22023';end if;
   insert into fagoo.consolidation_channel values(row_data->>'key',rid,v->>'profile_id',uid,'legacy');
  end loop;
 end loop;
 update fagoo.consolidation_run set status='imported' where id=rid;
 return jsonb_build_object('run_id',rid,'status','imported','replayed',false,'counts',(select jsonb_object_agg(c.kind,c.n) from(select i.kind,count(*) n from fagoo.consolidation_item i where run_id=rid group by i.kind)c));
end $$;

create function public.fagoo_consolidation_reconcile(p_user_id uuid,p_run_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r fagoo.consolidation_run;i fagoo.consolidation_item;table_name text;current_row jsonb;v_bad jsonb:='[]';v_count integer:=0;
begin
 perform erp_access.read_admin(p_user_id);select * into r from fagoo.consolidation_run where id=p_run_id for update;if not found then raise exception 'consolidation_not_found' using errcode='P0002';end if;
 if r.status='active' then return jsonb_build_object('run_id',r.id,'status','active','verified_at',r.verified_at);end if;
 for i in select * from fagoo.consolidation_item where run_id=p_run_id loop
  table_name:=case i.kind when 'queues' then 'queue_line' when 'tickets' then 'queue_ticket' when 'services' then 'queue_service' when 'orders' then 'queue_order' when 'campaigns' then 'queue_campaign' when 'rating_invites' then 'queue_rating_invite' when 'ratings' then 'queue_rating' when 'subscriptions' then 'queue_subscription' end;
  execute format('select to_jsonb(t) from fagoo.%I t where id=$1',table_name) into current_row using i.id;
  if current_row is distinct from i.snapshot then v_bad:=v_bad||jsonb_build_array(jsonb_build_object('kind',i.kind,'id',i.id));end if;v_count:=v_count+1;
 end loop;
 if exists(select 1 from fagoo.queue_effect where unit_id=r.unit_id) or exists(select 1 from fagoo.queue_notice where unit_id=r.unit_id) then v_bad:=v_bad||'[{"kind":"unexpected_effects"}]';end if;
 if jsonb_array_length(v_bad)=0 then update fagoo.consolidation_run set status='verified',verified_at=now() where id=p_run_id;else update fagoo.consolidation_run set status='imported',verified_at=null where id=p_run_id;end if;
 return jsonb_build_object('run_id',r.id,'status',case when jsonb_array_length(v_bad)=0 then 'verified' else 'mismatch' end,'records',v_count,'mismatches',v_bad,'source_sha256',r.source_sha256,'archive_sha256',r.archive_sha256);
end $$;

create function public.fagoo_consolidation_activate(p_user_id uuid,p_run_id uuid,p_evidence jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$declare r fagoo.consolidation_run;v_result jsonb;begin
 perform erp_access.require_admin(p_user_id,true);perform pg_advisory_xact_lock(1900910006);
 select * into r from fagoo.consolidation_run where id=p_run_id for update;if not found then raise exception 'consolidation_not_found' using errcode='P0002';end if;
 if r.status='active' then return jsonb_build_object('status','active','replayed',true);end if;
 v_result:=public.fagoo_consolidation_reconcile(p_user_id,p_run_id);
 if v_result->>'status'<>'verified' or p_evidence->>'source_sha256' is distinct from r.source_sha256 or p_evidence->'old_writer_stopped' is distinct from 'true'::jsonb or p_evidence->'archive_restore_verified' is distinct from 'true'::jsonb or p_evidence->'single_channel_consumer_verified' is distinct from 'true'::jsonb or p_evidence->'d1_adoption_verified' is distinct from 'true'::jsonb or length(coalesce(p_evidence->>'evidence_reference','')) not between 10 and 1000 then raise exception 'consolidation_cutover_not_verified' using errcode='22023';end if;
 update fagoo.consolidation_channel set consumer='fagoo' where run_id=p_run_id;
 update fagoo.consolidation_run set status='active',activated_at=now(),evidence=p_evidence where id=p_run_id;
 return jsonb_build_object('status','active','run_id',p_run_id,'replayed',false);
end $$;

alter function public.fagoo_queue_command(uuid,uuid,uuid,uuid,text,jsonb,bigint) rename to fagoo_queue_command_before_consolidation;
revoke all on function public.fagoo_queue_command_before_consolidation(uuid,uuid,uuid,uuid,text,jsonb,bigint) from public,anon,authenticated,service_role;
create function public.fagoo_queue_command(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_command_id uuid,p_type text,p_payload jsonb,p_expected_version bigint default null) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$begin
 perform pg_advisory_xact_lock(hashtextextended('queue-authority:'||p_unit_id::text,0));
 if exists(select 1 from fagoo.consolidation_run where unit_id=p_unit_id and status<>'active') then raise exception 'consolidation_cutover_pending' using errcode='55000';end if;
 return public.fagoo_queue_command_before_consolidation(p_user_id,p_device_id,p_unit_id,p_command_id,p_type,p_payload,p_expected_version);
end $$;
-- Snapshot closes old business days in the operational implementation; keep the staged import unchanged.
alter function public.fagoo_queue_snapshot(uuid,uuid,uuid) rename to fagoo_queue_snapshot_before_consolidation;
revoke all on function public.fagoo_queue_snapshot_before_consolidation(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function public.fagoo_queue_snapshot(p_user_id uuid,p_device_id uuid,p_unit_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$begin
 perform pg_advisory_xact_lock(hashtextextended('queue-authority:'||p_unit_id::text,0));
 if exists(select 1 from fagoo.consolidation_run where unit_id=p_unit_id and status<>'active') then raise exception 'consolidation_cutover_pending' using errcode='55000';end if;
 return public.fagoo_queue_snapshot_before_consolidation(p_user_id,p_device_id,p_unit_id);
end $$;
create function fagoo.consolidation_rating_guard() returns trigger language plpgsql set search_path=pg_catalog as $$begin
 if exists(select 1 from fagoo.queue_rating_invite i join fagoo.consolidation_run r on r.unit_id=i.unit_id where i.id=new.invite_id and r.status in('imported','verified')) then raise exception 'consolidation_cutover_pending' using errcode='55000';end if;
 return new;
end $$;
create trigger consolidation_public_rating_guard before insert or update on fagoo.queue_rating for each row execute function fagoo.consolidation_rating_guard();
revoke all on all tables in schema fagoo from public,anon,authenticated,service_role;
revoke all on function public.fagoo_consolidation_import(uuid,jsonb),public.fagoo_consolidation_reconcile(uuid,uuid),public.fagoo_consolidation_activate(uuid,uuid,jsonb),public.fagoo_queue_command(uuid,uuid,uuid,uuid,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.fagoo_consolidation_import(uuid,jsonb),public.fagoo_consolidation_reconcile(uuid,uuid),public.fagoo_consolidation_activate(uuid,uuid,jsonb),public.fagoo_queue_command(uuid,uuid,uuid,uuid,text,jsonb,bigint) to service_role;
revoke all on function public.fagoo_queue_snapshot(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fagoo_queue_snapshot(uuid,uuid,uuid) to service_role;
commit;
