// SQL fragments only. No connection, writes, credentials or runtime execution.
const where="c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'))";
export const inventory=target=>`SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO ${target} FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${where};`;
export const rowSnapshot=(target,version)=>`${target}:='{}';
FOREACH object_name IN ARRAY names LOOP
 EXECUTE format($rows$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')h FROM %s t%s)x$rows$,object_name,
 CASE WHEN object_name='erp_fiscal_authorization.policy' THEN ' WHERE NOT(model=''55'' AND version=${version})' ELSE '' END) INTO item;
 ${target}:=${target}||jsonb_build_object(object_name,item);
END LOOP;`;
export const securitySnapshot=target=>`SELECT encode(sha256(convert_to(jsonb_build_object(
 'schemas',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.oid) FROM pg_namespace n WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'relations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'attributes',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('attributes',to_jsonb(p),'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND(n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_')),
 'types',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),
 'column_defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_' OR n.nspname IN('public','auth','storage')),
 'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_roles r),
 'role_memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m)
)::text,'UTF8')),'hex') INTO ${target};`;
