-- Backup files remain reachable only through the server-authorized proxy.
-- This complements default-deny Storage access even if an unrelated permissive
-- policy is introduced. It does not change files, grants, or business records.
begin;

do $$
begin
  if not exists (select 1 from pg_class where oid='storage.objects'::regclass and relrowsecurity)
    or not exists (select 1 from storage.buckets where id='origin-backups' and public=false) then
    raise exception 'backup_private_storage_required' using errcode='55000';
  end if;
end;
$$;

create policy origin_backup_proxy_only on storage.objects
  as restrictive for all to anon,authenticated
  using (bucket_id<>'origin-backups')
  with check (bucket_id<>'origin-backups');

comment on policy origin_backup_proxy_only on storage.objects is
  'Private Origin backup: deny direct browser access even under broad policies; authenticated Worker proxy uses service_role and checks ERP membership.';

commit;
