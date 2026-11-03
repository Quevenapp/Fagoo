// Local preparation only. No database, HTTP, credentials or operational execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='2eaa258368cef5c0431a06c790dc8a646472360e5e9117d4a7aa780c90854e17';
const hash=value=>createHash('sha256').update(value).digest('hex');
// Restricted to the reviewed scalar signatures / dollar-quoted bodies in these migrations.
function functions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(a=>a.trim().split(/\s+/)[1]);
 return [m[2]+'('+args.join(',')+')',{sha256:hash(m[6]),replace:!!m[1],public:m[2].startsWith('public.'),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v'}];
});}
export async function prepareItauOperationalV2Apply(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160067_itau_operational_encoding.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_067$'))throw Error('SOURCE_067_NOT_REVIEWED');
 const reviewed=functions(source);
 if(reviewed.length!==30||reviewed.filter(([,x])=>x.replace).length!==10||reviewed.filter(([,x])=>x.public&&!x.replace).length!==8||new Set(reviewed.map(([s])=>s)).size!==30)throw Error('SOURCE_067_FUNCTION_INVENTORY');
 const prior=new Map();
 for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=66).sort())for(const[s,m]of functions(await readFile(new URL(file,root),'utf8')))prior.set(s,m.sha256);
 const dependencies=[...reviewed.filter(([,m])=>m.replace).map(([s])=>s),
  'erp_cnab.access(uuid,boolean,boolean)','erp_cnab.core_profile(uuid)','erp_cnab.storage_check(uuid,text,text,integer,text)',
  'erp_cnab.require_operational(uuid,integer)','erp_cnab.operational_snapshot_check(uuid)',
  'erp_cnab.operational_revision_immutable()','erp_cnab.start_command(uuid,uuid,text,jsonb)',
  'erp_cnab.operational_finish(uuid,uuid,text,jsonb,uuid,jsonb)','erp_cnab.operational_config_hash(uuid)',
  'erp_cnab.operational_safety()','erp_cnab.profile_dto(uuid)',
  'public.erp_cnab_itau_boleto_items(uuid,uuid)'];
 const previous=dependencies.map(signature=>{const h=prior.get(signature);if(!h)throw Error('DEPENDENCY_SOURCE_MISSING:'+signature);return[signature,h];});
 return `-- 067: explicit Itaú v2 encoding; eight new service-only RPCs and one empty private table. Prepared locally; remote execution is not authorized here.
-- Execute the complete script as the migration owner in one session. Require COMMIT acknowledgement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_apply_itau_067_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_067$
DECLARE
 source_067 text := $source_067$${source}$source_067$;
 expected_067 constant text := '${SOURCE_SHA256}';
 previous_functions constant jsonb := '${JSON.stringify(Object.fromEntries(previous))}'::jsonb;
 reviewed_functions constant jsonb := '${JSON.stringify(Object.fromEntries(reviewed))}'::jsonb;
 added_table constant text := 'erp_cnab.operational_encoding_revision';
 required_tables constant text[] := ARRAY['erp_access.membership','erp_catalog.record','erp_documents.document','erp_documents.item','erp_finance.account','erp_finance.title','erp_finance.settlement','erp_finance.movement','erp_finance.command','erp_cnab.profile','erp_cnab.remittance','erp_cnab.billing_title','erp_cnab.command','erp_cnab.audit','erp_cnab.operational_approval','erp_cnab.operational_approval_revision','erp_company.identity','storage.buckets','storage.objects','auth.users'];
 names text[]; current_names text[]; object_name text; source_body text; opening integer;
 before_state jsonb:='{}'; after_state jsonb:='{}'; snapshot jsonb;
 before_security jsonb; after_security jsonb; before_schemas jsonb; after_schemas jsonb;
 before_functions jsonb; after_functions jsonb; before_changed_security jsonb; after_changed_security jsonb; before_defaults jsonb; after_defaults jsonb; service_oid oid; function_oid oid; reviewed_oids oid[]:=ARRAY[]::oid[]; changed_oids oid[]:=ARRAY[]::oid[]; r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('brufap-apply-itau-067-v1',0));
 IF encode(sha256(convert_to(source_067,'UTF8')),'hex') IS DISTINCT FROM expected_067 THEN RAISE EXCEPTION 'itau_067_source_hash_mismatch' USING ERRCODE='22023'; END IF;
 IF to_regclass(added_table) IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1) WHERE NOT(f.value->>'replace')::boolean) THEN RAISE EXCEPTION 'itau_067_already_present' USING ERRCODE='55000'; END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'itau_067_roles_missing' USING ERRCODE='55000'; END IF;
 FOREACH object_name IN ARRAY required_tables LOOP
  IF to_regclass(object_name) IS NULL THEN RAISE EXCEPTION 'itau_067_prerequisite_missing' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r.key)) IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'itau_067_previous_contract_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 -- The new FK requires a parent-table lock. Acquire its stronger mode upfront:
 -- no SHARE-to-FK upgrade; refuse concurrent writers instead of waiting.
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT'; END LOOP;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  before_state:=before_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO before_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO before_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) WHERE(value->>'replace')::boolean LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL THEN RAISE EXCEPTION 'itau_067_previous_contract_changed' USING ERRCODE='55000'; END IF;
  changed_oids:=array_append(changed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO before_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO before_defaults FROM pg_default_acl d;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO before_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(changed_oids);
 opening:=position(E'\\nbegin;\\n' IN source_067);
 IF right(source_067,8) IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'itau_067_transaction_wrapper_invalid' USING ERRCODE='22023'; END IF;
 source_body:=overlay(left(source_067,length(source_067)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO current_names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 IF current_names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(array_append(names,added_table)) x) THEN RAISE EXCEPTION 'itau_067_table_inventory_changed' USING ERRCODE='40001'; END IF;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  after_state:=after_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'itau_067_existing_data_changed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO after_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'itau_067_table_security_changed' USING ERRCODE='42501'; END IF;
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO after_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'itau_067_schema_security_changed' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL
   OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
   OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM (r.value->>'public')::boolean
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid))
   OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.prosecdef=(r.value->>'public')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
  THEN RAISE EXCEPTION 'itau_067_function_contract_failed' USING ERRCODE='42501'; END IF;
  reviewed_oids:=array_append(reviewed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO after_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 IF before_changed_security IS DISTINCT FROM after_changed_security THEN RAISE EXCEPTION 'itau_067_replaced_function_security_changed' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO after_defaults FROM pg_default_acl d;
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'itau_067_default_privileges_changed' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM erp_cnab.operational_encoding_revision) THEN RAISE EXCEPTION 'itau_067_new_table_not_empty' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(added_table) AND relrowsecurity AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass(added_table) AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(added_table))
  OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=to_regclass(added_table) AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
 THEN RAISE EXCEPTION 'itau_067_private_table_failed' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass(added_table) AND attnum>0 AND NOT attisdropped)<>6
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(added_table) AND attnum>0 AND NOT attisdropped AND NOT attnotnull)
  OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(added_table) AND NOT tgisinternal)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(added_table) AND NOT tgisinternal AND tgname='operational_encoding_revision_immutable' AND tgtype=27 AND tgenabled='O' AND tgfoid='erp_cnab.operational_revision_immutable()'::regprocedure)
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass(added_table) AND contype<>'n')<>4
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(added_table) AND NOT convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(added_table) AND contype='f' AND confrelid='erp_cnab.operational_approval_revision'::regclass)
 THEN RAISE EXCEPTION 'itau_067_table_contract_failed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO after_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(reviewed_oids);
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'itau_067_other_functions_changed' USING ERRCODE='40001'; END IF;
 INSERT INTO pg_temp.brufap_apply_itau_067_audit(result) VALUES(jsonb_build_object(
  'migration','067','applicator_version',1,'source_sha256',expected_067,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','before',before_state,'after',after_state,'before_equals_after',true,
  'table_security_unchanged',true,'schema_security_unchanged',true,'other_functions_unchanged',true,'replaced_function_security_unchanged',true,'default_privileges_unchanged',true,
  'new_service_only_rpcs',8,'new_private_helpers',12,'replaced_functions',cardinality(changed_oids),'reviewed_functions',cardinality(reviewed_oids),'new_tables',1,'new_table_empty',true,'new_table_rls',true,'new_table_owner_only',true,'operation_activated',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'can_issue',false,'can_transmit',false,'can_pay',false,'commit_acknowledgement_required',true));
END
$apply_067$;
SELECT result AS itau_operational_v2_apply_audit FROM pg_temp.brufap_apply_itau_067_audit;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const text=await prepareItauOperationalV2Apply(),file=await open(process.argv[2],'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(text)}));
}
