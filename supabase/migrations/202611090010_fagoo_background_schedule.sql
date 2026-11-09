-- Background communication authorization must enforce the same access windows
-- as foreground requests. Devices are independent actors; administrators retain
-- the existing schedule exemption defined by erp_access.require_schedule.
begin;

create or replace function fagoo.require_unit(p_user_id uuid,p_device_id uuid,p_unit_id uuid,p_capability text)
returns void language plpgsql stable set search_path=pg_catalog as $$
begin
 if p_unit_id is null or p_capability is null or not p_capability=any(fagoo.capabilities())
 or (p_user_id is null)=(p_device_id is null)
 or not exists(select 1 from fagoo.unit where id=p_unit_id and active) then
  raise exception 'fagoo_access_denied' using errcode='42501'; end if;
 if p_user_id is not null then
  if not exists(select 1 from erp_access.membership m where m.user_id=p_user_id and m.active and
   (m.role='admin' or exists(select 1 from fagoo.unit_member u where u.unit_id=p_unit_id and u.user_id=m.user_id and p_capability=any(u.capabilities)))) then
   raise exception 'fagoo_access_denied' using errcode='42501'; end if;
  perform erp_access.require_schedule(p_user_id);
 else
  if not exists(select 1 from fagoo.device d where d.id=p_device_id and d.unit_id=p_unit_id and d.active and d.token_hash is not null and p_capability=any(d.capabilities)) then
   raise exception 'fagoo_access_denied' using errcode='42501'; end if;
 end if;
end $$;

commit;
