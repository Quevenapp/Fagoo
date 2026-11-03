// Local preparation only. This module cannot connect to or execute SQL on a database.
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='6a31da8e3dff49ae981006aa0a1eaac98fa867386d71b9a802b2b4eb00380015';
const hash=value=>createHash('sha256').update(value).digest('hex');
function body(source,name){const start=source.indexOf('create function '+name+'('),from=source.indexOf('as $$',start),to=source.indexOf('$$;',from+5);if(start<0||from<0||to<0)throw Error('FUNCTION_SOURCE_MISSING');return source.slice(from+5,to);}
export async function prepareFiscalAuthorizationApply(){
 const root=new URL('../../supabase/migrations/',import.meta.url);
 const source=await readFile(new URL('202610160064_fiscal_authorization.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_064$'))throw Error('SOURCE_064_NOT_REVIEWED');
 const dependencies=[
  ['erp_a1.access(uuid,boolean)','202610160041_a1_custody.sql'],['erp_a1.iso(jsonb)','202610160041_a1_custody.sql'],
  ['erp_fiscal_unsigned.lock_basis(erp_fiscal_numbering.reservation)','202610160048_unsigned_xml_jobs.sql'],
  ['erp_fiscal_signed.check_source(erp_fiscal_unsigned.job,text,text)','202610160050_signed_fiscal_candidates.sql'],
  ['erp_fiscal_signed.current(erp_fiscal_signed.candidate)','202610160050_signed_fiscal_candidates.sql'],
  ['erp_fiscal_wsdl.hash(jsonb)','202610160051_fiscal_wsdl.sql'],['erp_fiscal_wsdl.check_a1(erp_a1.head,integer,integer)','202610160051_fiscal_wsdl.sql'],
  ['erp_fiscal_reconciliation.source(uuid,uuid,text)','202610160061_fiscal_reconciliation.sql']
 ];
 const previous=[];for(const [signature,file]of dependencies){const s=await readFile(new URL(file,root),'utf8');previous.push([signature,hash(body(s,signature.split('(')[0]))]);}
 // This restricted SQL grammar has only scalar/composite arguments and no nested type syntax.
 const added=[...source.matchAll(/create function ([a-z0-9_.]+)\(([^)]*)\)\s*returns [\s\S]*?as \$\$/g)].map(m=>{
  const signature=m[1]+'('+m[2].split(',').filter(Boolean).map(a=>a.trim().split(/\s+/)[1]).join(',')+')';
  return[signature,{sha256:hash(body(source,m[1])),public:m[1].startsWith('public.'),stable:/language (?:sql|plpgsql) stable/.test(m[0])}];
 });
 if(added.length!==22||added.filter(([,v])=>v.public).length!==8)throw Error('SOURCE_064_FUNCTION_INVENTORY');
 return `-- 064: private authorization ledger, eight service-only RPCs, both model policies disabled.
-- Preparation is local only; this module does not execute the generated script.
-- Execute the complete script as the migration owner in one session. Require COMMIT acknowledgement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_apply_authorization_064_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_064$
DECLARE
 source_064 text := $source_064$${source}$source_064$;
 expected_064 constant text := '${SOURCE_SHA256}';
 previous_functions constant jsonb := '${JSON.stringify(Object.fromEntries(previous))}'::jsonb;
 new_functions constant jsonb := '${JSON.stringify(Object.fromEntries(added))}'::jsonb;
 required_tables constant text[] := ARRAY['erp_access.membership','erp_company.identity','erp_fiscal_signed.candidate','erp_fiscal_unsigned.job','erp_fiscal_numbering.reservation','erp_a1.head','erp_a1.credential','erp_a1.sealed_object','erp_fiscal_reconciliation.attempt','storage.buckets','storage.objects','auth.users'];
 added_tables constant text[] := ARRAY['erp_fiscal_authorization.attempt','erp_fiscal_authorization.audit','erp_fiscal_authorization.command','erp_fiscal_authorization.intent','erp_fiscal_authorization.policy','erp_fiscal_authorization.request','erp_fiscal_authorization.result'];
 names text[]; current_names text[]; object_name text; source_body text; opening integer;
 before_state jsonb:='{}'; after_state jsonb:='{}'; snapshot jsonb;
 before_security jsonb; after_security jsonb; before_schemas jsonb; after_schemas jsonb;
 before_functions jsonb; after_functions jsonb; service_oid oid; function_oid oid; new_oids oid[]:=ARRAY[]::oid[]; r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('brufap-apply-authorization-064-v1',0));
 IF encode(sha256(convert_to(source_064,'UTF8')),'hex') IS DISTINCT FROM expected_064 THEN RAISE EXCEPTION 'authorization_064_source_hash_mismatch' USING ERRCODE='22023'; END IF;
 IF to_regnamespace('erp_fiscal_authorization') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'erp_fiscal_authorization_%') THEN RAISE EXCEPTION 'authorization_064_already_present' USING ERRCODE='55000'; END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'authorization_064_roles_missing' USING ERRCODE='55000'; END IF;
 FOREACH object_name IN ARRAY required_tables LOOP
  IF to_regclass(object_name) IS NULL THEN RAISE EXCEPTION 'authorization_064_prerequisite_missing' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r.key)) IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'authorization_064_previous_contract_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 -- Foreign keys need locks on existing parent tables. Acquire the stronger mode upfront
 -- to avoid upgrades/deadlocks; NOWAIT refuses concurrent writers instead of waiting.
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT'; END LOOP;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  before_state:=before_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl)) INTO before_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO before_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO before_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_');
 opening:=position(E'\\nbegin;\\n' IN source_064);
 IF right(source_064,8) IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'authorization_064_transaction_wrapper_invalid' USING ERRCODE='22023'; END IF;
 source_body:=overlay(left(source_064,length(source_064)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO current_names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 IF current_names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE \"C\") FROM unnest(names||added_tables)x) THEN RAISE EXCEPTION 'authorization_064_table_inventory_changed' USING ERRCODE='40001'; END IF;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  after_state:=after_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'authorization_064_existing_data_changed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl)) INTO after_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'authorization_064_table_security_changed' USING ERRCODE='42501'; END IF;
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO after_schemas FROM pg_namespace WHERE (nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage')) AND nspname<>'erp_fiscal_authorization';
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'authorization_064_schema_security_changed' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each(new_functions) LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL
   OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
   OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM (r.value->>'public')::boolean
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid))
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=function_oid AND prosecdef=(r.value->>'public')::boolean AND provolatile=CASE WHEN(r.value->>'stable')::boolean THEN 's'::\"char\" ELSE CASE WHEN r.key='erp_fiscal_authorization.flags()' THEN 'i'::\"char\" ELSE 'v'::\"char\" END END AND 'search_path=pg_catalog'=ANY(proconfig) AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')=r.value->>'sha256')
  THEN RAISE EXCEPTION 'authorization_064_rpc_contract_failed' USING ERRCODE='42501'; END IF;
  new_oids:=array_append(new_oids,function_oid);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='erp_fiscal_authorization' AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='erp_fiscal_authorization' AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_authorization' AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,c.relowner))) a WHERE n.nspname='erp_fiscal_authorization' AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_authorization' AND c.relkind='r' AND NOT c.relrowsecurity)
 OR EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_authorization')
 THEN RAISE EXCEPTION 'authorization_064_private_schema_failed' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_authorization' AND NOT t.tgisinternal)<>7
 OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_authorization' AND NOT t.tgisinternal AND (t.tgenabled<>'O' OR t.tgtype<>27 OR t.tgnargs<>0 OR t.tgqual IS NOT NULL OR t.tgfoid<>to_regprocedure('erp_fiscal_authorization.'||CASE WHEN c.relname='intent' THEN 'guard_intent' WHEN c.relname='attempt' THEN 'guard_attempt' ELSE 'immutable' END||'()')))
 OR EXISTS(SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE n.nspname='erp_fiscal_authorization' AND a.grantee<>d.defaclrole)
 THEN RAISE EXCEPTION 'authorization_064_history_protection_failed' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM erp_fiscal_authorization.policy)<>2 OR EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy WHERE model NOT IN('55','65') OR version<>1 OR origin<>'operational' OR enabled OR binding_reviewed OR tax_rules_reviewed OR binding_profile IS NOT NULL OR rule_profile IS NOT NULL OR source_manifest_hash IS NOT NULL OR valid_from<>'2026-10-16T00:00:00Z'::timestamptz OR valid_until<>'2026-10-26T00:00:00Z'::timestamptz)
 THEN RAISE EXCEPTION 'authorization_064_disabled_policy_failed' USING ERRCODE='42501'; END IF;
 FOREACH object_name IN ARRAY added_tables LOOP
  IF object_name<>'erp_fiscal_authorization.policy' THEN
   EXECUTE 'SELECT count(*) FROM '||object_name INTO opening;
   IF opening<>0 THEN RAISE EXCEPTION 'authorization_064_unexpected_activity' USING ERRCODE='40001'; END IF;
  END IF;
 END LOOP;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO after_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(new_oids);
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'authorization_064_other_functions_changed' USING ERRCODE='40001'; END IF;
 INSERT INTO pg_temp.brufap_apply_authorization_064_audit(result) VALUES(jsonb_build_object(
  'migration','064','applicator_version',1,'source_sha256',expected_064,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','before',before_state,'after',after_state,'before_equals_after',true,
  'table_security_unchanged',true,'schema_security_unchanged',true,'other_functions_unchanged',true,
  'new_service_only_rpcs',8,'new_private_functions',14,'new_tables',7,'seeded_disabled_policies',2,'operation_activated',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'can_issue',false,'can_transmit',false,'can_pay',false,'commit_acknowledgement_required',true));
END
$apply_064$;
SELECT result AS authorization_apply_audit FROM pg_temp.brufap_apply_authorization_064_audit;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const text=await prepareFiscalAuthorizationApply(),file=await open(process.argv[2],'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(text)}));
}
