begin;

-- A configured printer with no issued credential has no executor. Refuse the
-- complete command atomically, before persisting its ticket/counter/receipt.
-- Revocation waits for this short transaction; later claims always reauthorize.
create or replace function fagoo.queue_require_print_executor() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if new.kind='print' then
  perform 1 from fagoo.device d where d.id=new.device_id and d.unit_id=new.unit_id
   and d.active and d.token_hash is not null and 'print.execute'=any(d.capabilities)
   for share;
  if not found then raise exception 'queue_printer_not_available'; end if;
 end if;
 return new;
end $$;
revoke all on function fagoo.queue_require_print_executor() from public,anon,authenticated,service_role;
create trigger queue_print_executor before insert on fagoo.queue_effect
 for each row execute function fagoo.queue_require_print_executor();

commit;
