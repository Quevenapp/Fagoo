// Local preparation only. This module cannot connect to or execute SQL on a database.
import {readFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='71d7a34f8078ef7f71c861699bfbfa2dc2b59ec156e188798f3d59d00f8db2c3';
const hash=value=>createHash('sha256').update(value).digest('hex');
function body(source,name){const start=source.indexOf('create function '+name+'('),from=source.indexOf('as $$',start),to=source.indexOf('$$;',from+5);if(start<0||from<0||to<0)throw Error('FUNCTION_SOURCE_MISSING');return source.slice(from+5,to);}
export async function prepareItauBoletoApply(){
 const root=new URL('../../supabase/migrations/',import.meta.url);
 const source=await readFile(new URL('202610160066_itau_boleto_preview.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_066$'))throw Error('SOURCE_066_NOT_REVIEWED');
 const old014=await readFile(new URL('202610160014_erp_cnab.sql',root),'utf8'),old042=await readFile(new URL('202610160042_cnab_operational.sql',root),'utf8');
 const previous=[['erp_cnab.access(uuid,boolean,boolean)',old014],['erp_cnab.core_profile(uuid)',old014],['erp_cnab.storage_check(uuid,text,text,integer,text)',old014],['erp_cnab.require_operational(uuid,integer)',old042],['erp_cnab.operational_snapshot_check(uuid)',old042]].map(([signature,s])=>[signature,hash(body(s,signature.split('(')[0]))]);
 const added=['public.erp_cnab_itau_boleto_context(uuid,uuid)','public.erp_cnab_itau_boleto_items(uuid,uuid)'].map(signature=>[signature,hash(body(source,signature.split('(')[0]))]);
 return `-- 066: two read-only, service-only RPCs. Prepared locally; remote execution is not authorized here.
-- Execute the complete script as the migration owner in one session. Require COMMIT acknowledgement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_apply_itau_066_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_066$
DECLARE
 source_066 text := $source_066$${source}$source_066$;
 expected_066 constant text := '${SOURCE_SHA256}';
 previous_functions constant jsonb := '${JSON.stringify(Object.fromEntries(previous))}'::jsonb;
 new_functions constant jsonb := '${JSON.stringify(Object.fromEntries(added))}'::jsonb;
 required_tables constant text[] := ARRAY['erp_access.membership','erp_catalog.record','erp_documents.document','erp_documents.item','erp_finance.account','erp_finance.title','erp_finance.settlement','erp_finance.movement','erp_finance.command','erp_cnab.profile','erp_cnab.remittance','erp_cnab.billing_title','erp_cnab.command','erp_cnab.audit','erp_cnab.operational_approval','erp_cnab.operational_approval_revision','erp_company.identity','storage.buckets','storage.objects','auth.users'];
 names text[]; current_names text[]; object_name text; source_body text; opening integer;
 before_state jsonb:='{}'; after_state jsonb:='{}'; snapshot jsonb;
 before_security jsonb; after_security jsonb; before_schemas jsonb; after_schemas jsonb;
 before_functions jsonb; after_functions jsonb; service_oid oid; function_oid oid; new_oids oid[]:=ARRAY[]::oid[]; r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('brufap-apply-itau-066-v1',0));
 IF encode(sha256(convert_to(source_066,'UTF8')),'hex') IS DISTINCT FROM expected_066 THEN RAISE EXCEPTION 'itau_066_source_hash_mismatch' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('erp_cnab_itau_boleto_context','erp_cnab_itau_boleto_items')) THEN RAISE EXCEPTION 'itau_066_already_present' USING ERRCODE='55000'; END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'itau_066_roles_missing' USING ERRCODE='55000'; END IF;
 FOREACH object_name IN ARRAY required_tables LOOP
  IF to_regclass(object_name) IS NULL THEN RAISE EXCEPTION 'itau_066_prerequisite_missing' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r.key)) IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'itau_066_previous_contract_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 -- Function-only DDL: no table lock upgrade. Any current writer causes immediate refusal.
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE MODE NOWAIT'; END LOOP;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  before_state:=before_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl)) INTO before_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO before_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO before_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_');
 opening:=position(E'\\nbegin;\\n' IN source_066);
 IF right(source_066,8) IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'itau_066_transaction_wrapper_invalid' USING ERRCODE='22023'; END IF;
 source_body:=overlay(left(source_066,length(source_066)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO current_names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 IF current_names IS DISTINCT FROM names THEN RAISE EXCEPTION 'itau_066_table_inventory_changed' USING ERRCODE='40001'; END IF;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  after_state:=after_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'itau_066_existing_data_changed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl)) INTO after_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'itau_066_table_security_changed' USING ERRCODE='42501'; END IF;
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO after_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'itau_066_schema_security_changed' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each_text(new_functions) LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL OR NOT has_function_privilege('service_role',function_oid,'EXECUTE')
   OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee NOT IN(p.proowner,service_oid))
   OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=function_oid AND prosecdef AND provolatile='s' AND 'search_path=pg_catalog'=ANY(proconfig) AND prorettype='jsonb'::regtype AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')=r.value)
  THEN RAISE EXCEPTION 'itau_066_rpc_contract_failed' USING ERRCODE='42501'; END IF;
  new_oids:=array_append(new_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO after_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(new_oids);
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'itau_066_other_functions_changed' USING ERRCODE='40001'; END IF;
 INSERT INTO pg_temp.brufap_apply_itau_066_audit(result) VALUES(jsonb_build_object(
  'migration','066','applicator_version',1,'source_sha256',expected_066,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','share_nowait','before',before_state,'after',after_state,'before_equals_after',true,
  'table_security_unchanged',true,'schema_security_unchanged',true,'other_functions_unchanged',true,
  'new_service_only_rpcs',cardinality(new_oids),'new_tables',0,'operation_activated',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'can_issue',false,'can_transmit',false,'can_pay',false,'commit_acknowledgement_required',true));
END
$apply_066$;
SELECT result AS itau_boleto_apply_audit FROM pg_temp.brufap_apply_itau_066_audit;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const text=await prepareItauBoletoApply(),file=await open(process.argv[2],'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(text)}));
}
