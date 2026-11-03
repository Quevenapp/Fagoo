\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
-- Fail instead of reporting partial RLS-filtered business counts.
SET LOCAL row_security = off;
SET LOCAL search_path = pg_catalog;
SELECT json_build_object(
 'kind','manifest','formatVersion',1,'generatedAt',clock_timestamp(),
 'database',json_build_object('serverVersionNum',current_setting('server_version_num'),'encoding',current_setting('server_encoding'),'collation',(select datcollate from pg_database where datname=current_database()),'ctype',(select datctype from pg_database where datname=current_database()),'sizeBytes',pg_database_size(current_database())::text),
 'consistency',json_build_object('readOnly',current_setting('transaction_read_only')='on','isolation',current_setting('transaction_isolation'),'exactCounts',true),
 'extensions',coalesce((select json_agg(json_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname) order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace),'[]'),
 'roles',coalesce((select json_agg(json_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'createRole',rolcreaterole,'createDatabase',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypassRls',rolbypassrls) order by rolname) from pg_roles),'[]'),
 'memberships',coalesce((select json_agg(json_build_object('role',r.rolname,'member',m.rolname,'adminOption',a.admin_option) order by r.rolname,m.rolname) from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member),'[]'),
 'schemas',coalesce((select json_agg(json_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl::text) order by nspname) from pg_namespace where nspname !~ '^pg_' and nspname<>'information_schema'),'[]')
);

SELECT json_build_object('kind','relation','schema',n.nspname,'name',c.relname,'relationKind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'replicaIdentity',c.relreplident,
 'parent',coalesce((select json_agg(json_build_object('schema',pn.nspname,'name',p.relname) order by pn.nspname,p.relname) from pg_inherits i join pg_class p on p.oid=i.inhparent join pg_namespace pn on pn.oid=p.relnamespace where i.inhrelid=c.oid),'[]'),
 'columns',coalesce((select json_agg(json_build_object('name',a.attname,'ordinal',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'collation',case when a.attcollation<>0 then a.attcollation::regcollation::text else null end,'defaultHash',md5(pg_get_expr(d.adbin,d.adrelid))) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'[]'),
 'constraints',coalesce((select json_agg(json_build_object('name',conname,'type',contype,'validated',convalidated,'deferrable',condeferrable,'initiallyDeferred',condeferred,'definitionHash',md5(pg_get_constraintdef(oid,true))) order by conname) from pg_constraint where conrelid=c.oid),'[]'),
 'indexes',coalesce((select json_agg(json_build_object('name',ci.relname,'valid',i.indisvalid,'ready',i.indisready,'definitionHash',md5(pg_get_indexdef(i.indexrelid))) order by ci.relname) from pg_index i join pg_class ci on ci.oid=i.indexrelid where i.indrelid=c.oid),'[]'),
 'triggers',coalesce((select json_agg(json_build_object('name',tgname,'enabled',tgenabled,'definitionHash',md5(pg_get_triggerdef(oid,true))) order by tgname) from pg_trigger where tgrelid=c.oid and not tgisinternal),'[]'),
 'policies',coalesce((select json_agg(json_build_object('name',polname,'command',polcmd,'permissive',polpermissive,'roles',array(select case when r=0 then 'public' else pg_get_userbyid(r) end from unnest(polroles) r order by r),'usingHash',md5(pg_get_expr(polqual,polrelid)),'checkHash',md5(pg_get_expr(polwithcheck,polrelid))) order by polname) from pg_policy where polrelid=c.oid),'[]'),
 'viewHash',case when c.relkind in('v','m') then md5(pg_get_viewdef(c.oid,true)) else null end,
 'partitionHash',case when c.relkind='p' then md5(pg_get_partkeydef(c.oid)) else null end,
 'partitionBoundHash',md5(pg_get_expr(c.relpartbound,c.oid))
)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f') ORDER BY n.nspname,c.relname;

SELECT json_build_object('kind','routine','schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'routineKind',p.prokind,'language',l.lanname,'securityDefiner',p.prosecdef,'volatility',p.provolatile,'parallel',p.proparallel,'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'configHash',md5(p.proconfig::text),'definitionHash',md5(pg_get_functiondef(p.oid)))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prokind IN('f','p','w') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid);

-- Sequence state is metadata, never advanced by this query.
SELECT json_build_object('kind','sequence','schema',schemaname,'name',sequencename,'owner',sequenceowner,'type',data_type::text,'start',start_value::text,'min',min_value::text,'max',max_value::text,'increment',increment_by::text,'cycle',cycle,'cache',cache_size::text,'lastValue',last_value::text) FROM pg_sequences WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema' ORDER BY schemaname,sequencename;

SELECT json_build_object('kind','type','schema',n.nspname,'name',t.typname,'typeKind',t.typtype,'owner',pg_get_userbyid(t.typowner),'acl',t.typacl::text,'baseType',case when t.typbasetype<>0 then format_type(t.typbasetype,t.typtypmod) else null end,'nullable',not t.typnotnull,'defaultHash',md5(t.typdefault),'enumLabels',coalesce((select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'[]'),'constraintHash',(select md5(string_agg(pg_get_constraintdef(c.oid,true),E'\n' order by c.conname)) from pg_constraint c where c.contypid=t.oid))
FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND t.typtype IN('e','d') ORDER BY n.nspname,t.typname;

-- Generate SELECT statements only, with quoted identifiers and literals.
-- A denied count aborts the entire inventory; no approximate fallback.
-- ONLY avoids double-counting partitions/inheritance and visiting foreign children.
SELECT format('SELECT json_build_object(''kind'',''count'',''schema'',%L,''name'',%L,''rows'',count(*)::text) FROM ONLY %I.%I;',n.nspname,c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p') ORDER BY n.nspname,c.relname
\gexec

-- Storage paths, user UUIDs, emails, passwords and JWTs are never selected.
SELECT CASE WHEN to_regclass('storage.objects') IS NULL THEN 'SELECT json_build_object(''kind'',''storageSummary'',''available'',false);'
ELSE 'SELECT json_build_object(''kind'',''storageSummary'',''available'',true,''objects'',count(*)::text,''buckets'',coalesce((select json_agg(json_build_object(''id'',b.id,''name'',b.name,''public'',b.public,''fileSizeLimit'',b.file_size_limit::text,''allowedMimeTypes'',b.allowed_mime_types,''objects'',(select count(*)::text from storage.objects o where o.bucket_id=b.id)) order by b.id) from storage.buckets b),''[]''::json)) FROM storage.objects;' END
\gexec
SELECT CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'SELECT json_build_object(''kind'',''migrationVersions'',''available'',false,''versions'',''[]''::json);'
ELSE 'SELECT json_build_object(''kind'',''migrationVersions'',''available'',true,''versions'',coalesce(json_agg(version order by version),''[]''::json)) FROM supabase_migrations.schema_migrations;' END
\gexec
SELECT json_build_object('kind','complete','readOnly',current_setting('transaction_read_only')='on');
ROLLBACK;
