-- Installation defaults, deliberately outside the immutable application migrations.
-- Called only by the fresh installer. Updates and an idempotent replay preserve
-- choices made after installation, including an explicitly enabled integration.
begin;
select pg_advisory_xact_lock(1964102101, 1);
select pg_advisory_xact_lock(1964102101, 2);

create table if not exists fagoo_system.install_defaults (
  name text primary key,
  applied_at timestamptz not null default clock_timestamp()
);
revoke all on fagoo_system.install_defaults from public,anon,authenticated,service_role;

do $fagoo$
begin
  if exists(select 1 from fagoo_system.install_defaults where name='standalone-sync-disabled-v1') then
    return;
  end if;
  if not exists(select 1 from fagoo_system.schema_migration) then
    raise exception 'FAGOO_STANDALONE_SCHEMA_REQUIRED';
  end if;
  if to_regclass('fagoo_system.install_state') is not null then
    if exists(select 1 from fagoo_system.install_state) then
      raise exception 'FAGOO_STANDALONE_ALREADY_INITIALIZED';
    end if;
  end if;

  lock table erp_access.membership, erp_catalog.record, erp_documents.document,
    erp_finance.account, erp_finance.title, erp_finance.movement,
    erp_stock.balance, erp_stock.movement, erp_sync.settings,
    erp_sync.link, erp_sync.inbox, erp_sync.outbox, erp_sync.run
    in share row exclusive mode;

  if exists(select 1 from erp_access.membership)
    or exists(select 1 from erp_catalog.record)
    or exists(select 1 from erp_documents.document)
    or exists(select 1 from erp_finance.account)
    or exists(select 1 from erp_finance.title)
    or exists(select 1 from erp_finance.movement)
    or exists(select 1 from erp_stock.balance)
    or exists(select 1 from erp_stock.movement)
    or exists(select 1 from erp_sync.link)
    or exists(select 1 from erp_sync.inbox)
    or exists(select 1 from erp_sync.outbox)
    or exists(select 1 from erp_sync.run)
    or exists(select 1 from erp_sync.settings where actor_id is not null or default_account_id is not null)
  then
    raise exception 'FAGOO_STANDALONE_REQUIRES_EMPTY_INSTALLATION';
  end if;
  if (select count(*) from erp_sync.settings where singleton) <> 1 then
    raise exception 'FAGOO_STANDALONE_SYNC_SETTINGS_REQUIRED';
  end if;

  update erp_sync.settings set enabled=false, updated_at=clock_timestamp() where singleton;
  insert into fagoo_system.install_defaults(name) values('standalone-sync-disabled-v1');
end
$fagoo$;
commit;
