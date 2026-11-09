-- Executed against both clean and upgraded isolated PostgreSQL installations.
-- All identities and data are synthetic and rolled back before backup checks.
begin;
do $$
declare
 v_user uuid:=gen_random_uuid();v_admin uuid:=gen_random_uuid();v_unit uuid:=gen_random_uuid();
 v_device uuid:=gen_random_uuid();v_contact uuid:=gen_random_uuid();
 v_open jsonb:='[{"start":"00:00","end":"23:59","days":[0,1,2,3,4,5,6]}]';
 v_closed jsonb:=jsonb_build_array(jsonb_build_object('start','00:00','end','23:59','days',
   jsonb_build_array((extract(dow from clock_timestamp() at time zone 'America/Sao_Paulo')::integer+3)%7)));
begin
 insert into auth.users(id,email) values(v_user,'schedule-user-'||v_user||'@synthetic.test'),(v_admin,'schedule-admin-'||v_admin||'@synthetic.test');
 insert into erp_access.membership(user_id,role) values(v_user,'operacao'),(v_admin,'admin');
 insert into fagoo.unit(id,name) values(v_unit,'Synthetic schedule regression');
 insert into fagoo.unit_member(unit_id,user_id,capabilities) values(v_unit,v_user,array['communication.read','communication.reply','team.chat']);
 insert into fagoo.device(id,unit_id,name,capabilities,token_hash) values(v_device,v_unit,'Synthetic panel',array['panel.read'],repeat('a',64));

 -- A human without schedule restrictions and an explicitly open window pass.
 perform fagoo.require_unit(v_user,null,v_unit,'communication.read');
 insert into erp_access.user_control(user_id,schedule_enabled,windows,version,updated_at,updated_by)
 values(v_user,true,v_open,1,clock_timestamp(),v_admin),(v_admin,true,v_closed,1,clock_timestamp(),v_admin);
 perform fagoo.require_unit(v_user,null,v_unit,'communication.reply');

 -- Unit membership/capabilities never bypass a closed human window.
 update erp_access.user_control set windows=v_closed where user_id=v_user;
 begin
  perform fagoo.require_unit(v_user,null,v_unit,'communication.reply');
  raise exception 'test_closed_human_schedule_was_allowed';
 exception when insufficient_privilege then
  if sqlerrm<>'erp_access_outside_schedule' then raise;end if;
 end;
 perform fagoo.require_unit(v_admin,null,v_unit,'communication.configure');
 perform fagoo.require_unit(null,v_device,v_unit,'panel.read');

 -- An open user window does not bypass a linked seller's closed window.
 update erp_access.user_control set windows=v_open where user_id=v_user;
 insert into erp_catalog.record(id,entity,name) values(v_contact,'contacts','Synthetic restricted seller');
 insert into erp_catalog.contact(record_id) values(v_contact);
 insert into erp_catalog.seller(contact_id,user_id,access_hours_enabled,access_windows,created_by,updated_by)
 values(v_contact,v_user,true,v_closed,v_admin,v_admin);
 begin
  perform fagoo.require_unit(v_user,null,v_unit,'team.chat');
  raise exception 'test_closed_seller_schedule_was_allowed';
 exception when insufficient_privilege then
  if sqlerrm<>'erp_access_outside_schedule' then raise;end if;
 end;
 update erp_catalog.seller set access_windows=v_open where user_id=v_user;
 perform fagoo.require_unit(v_user,null,v_unit,'team.chat');

 -- Existing identity, unit and device restrictions still apply.
 begin
  perform fagoo.require_unit(v_user,null,v_unit,'communication.configure');
  raise exception 'test_missing_capability_was_allowed';
 exception when insufficient_privilege then
  if sqlerrm<>'fagoo_access_denied' then raise;end if;
 end;
 update erp_access.membership set active=false where user_id=v_admin;
 begin
  perform fagoo.require_unit(v_admin,null,v_unit,'communication.read');
  raise exception 'test_inactive_admin_was_allowed';
 exception when insufficient_privilege then
  if sqlerrm<>'fagoo_access_denied' then raise;end if;
 end;
 update erp_access.membership set active=true where user_id=v_admin;
 update fagoo.device set token_hash=null where id=v_device;
 begin
  perform fagoo.require_unit(null,v_device,v_unit,'panel.read');
  raise exception 'test_revoked_device_was_allowed';
 exception when insufficient_privilege then
  if sqlerrm<>'fagoo_access_denied' then raise;end if;
 end;
 update fagoo.device set token_hash=repeat('a',64) where id=v_device;
 if exists(select 1 from pg_proc where oid='fagoo.require_unit(uuid,uuid,uuid,text)'::regprocedure
   and (provolatile<>'s' or prosecdef or not proconfig @> array['search_path=pg_catalog'])) then
  raise exception 'test_require_unit_execution_attributes_changed';
 end if;
 if has_function_privilege('authenticated','fagoo.require_unit(uuid,uuid,uuid,text)','execute')
 or has_function_privilege('service_role','fagoo.require_unit(uuid,uuid,uuid,text)','execute') then
  raise exception 'test_require_unit_private_acl_changed';
 end if;
 perform set_config('fagoo_test.user_id',v_user::text,true);
 perform set_config('fagoo_test.admin_id',v_admin::text,true);
 perform set_config('fagoo_test.unit_id',v_unit::text,true);
end $$;

-- Use the actual service-only RPC invoked by background authority, without an
-- HTTP JWT gate. It must apply the schedule again for each fresh grant.
set local role service_role;
do $$
declare v jsonb;
begin
 v:=public.fagoo_communication_context(current_setting('fagoo_test.user_id')::uuid,current_setting('fagoo_test.unit_id')::uuid,'communication.reply');
 if v->>'user_id'<>current_setting('fagoo_test.user_id') then raise exception 'test_background_open_identity_mismatch';end if;
end $$;
reset role;
update erp_access.user_control set windows=jsonb_build_array(jsonb_build_object('start','00:00','end','23:59','days',
 jsonb_build_array((extract(dow from clock_timestamp() at time zone 'America/Sao_Paulo')::integer+3)%7)))
where user_id=current_setting('fagoo_test.user_id')::uuid;
set local role service_role;
do $$
declare v_capability text;
begin
 foreach v_capability in array array['communication.read','communication.reply','team.chat'] loop
  begin
   perform public.fagoo_communication_context(current_setting('fagoo_test.user_id')::uuid,current_setting('fagoo_test.unit_id')::uuid,v_capability);
   raise exception 'test_background_closed_schedule_was_allowed';
  exception when insufficient_privilege then
   if sqlerrm<>'erp_access_outside_schedule' then raise;end if;
  end;
 end loop;
 perform public.fagoo_communication_context(current_setting('fagoo_test.admin_id')::uuid,current_setting('fagoo_test.unit_id')::uuid,'communication.configure');
end $$;
reset role;
rollback;
