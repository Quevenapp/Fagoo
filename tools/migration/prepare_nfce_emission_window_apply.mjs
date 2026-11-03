// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='b870bf74f9406fb7fe3800219872c34fc4a05b2a8def9e040c0482bd18858a51';
const schema='erp_fiscal_reviewed_authorization';
const hash=value=>createHash('sha256').update(value).digest('hex');
function definitions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(x=>x.trim().split(/\s+/));
 return[m[2]+'('+args.map(x=>x[1]).join(',')+')',{sha256:hash(m[6]),public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v',args:args.map(x=>x[0])}];
});}
const tableWhere="c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'))";
const tableInventory=target=>`SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO ${target} FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${tableWhere};`;
const rowFingerprints=target=>`FOREACH object_name IN ARRAY names LOOP
 EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
 ${target}:=${target}||jsonb_build_object(object_name,snapshot);
END LOOP;`;
const tableSecurity=target=>`SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'access_method',c.relam,'replica_identity',c.relreplident,'options',c.reloptions,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
 'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl,'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation,'storage',a.attstorage,'default',(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT(n.nspname='erp_fiscal_authorization'AND c.relname='attempt'AND k.conname='reviewed_use_time_commit'AND k.contype='t')),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',x.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY x.relname) FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND NOT(n.nspname='erp_fiscal_authorization'AND c.relname='attempt'AND t.tgname IN('reviewed_use_time_guard','reviewed_use_time_commit'))))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE(nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage'));`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d;`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const otherCatalog=target=>`SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relpersistence,c.reloptions,c.reltablespace,c.relam,c.relreplident,c.relrowsecurity,c.relforcerowsecurity)ORDER BY n.nspname,c.relname)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'types',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))) INTO ${target};`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL
  OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
  OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM(r.value->>'public')::boolean
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid AND NOT a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND(case when p.pronargs=0 then '[]'::jsonb else to_jsonb(p.proargnames)end)=r.value->'args'
   AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargmodes IS NULL
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
 THEN RAISE EXCEPTION 'emission_080_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;

const dependencies=[
 'erp_fiscal_authorization.guard_attempt()','erp_fiscal_reviewed_authorization.guard_stage()',
 'erp_fiscal_reviewed_authorization.check_review(erp_fiscal_authorization.attempt,jsonb,boolean)',
 'erp_fiscal_authorization.lock_attempt(uuid,uuid,uuid,boolean)',
 'public.erp_fiscal_authorization_use(uuid,uuid,uuid)',
 'public.erp_fiscal_reviewed_authorization_use(uuid,uuid,uuid,jsonb)',
 'erp_fiscal_unsigned.immutable()','erp_fiscal_authorization.context(erp_fiscal_authorization.attempt)'
];
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160080_nfce_emission_window.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_080$'))throw Error('SOURCE_080_NOT_REVIEWED');
 const added=definitions(source);if(added.length!==2||new Set(added.map(([s])=>s)).size!==2||added.filter(([,m])=>m.public).length!==0||added.some(([name,m])=>m.definer!==(name==='erp_fiscal_reviewed_authorization.guard_nfce_emission_window()')))throw Error('EMISSION_FUNCTION_INVENTORY');
 const prior=new Map();for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=79).sort())for(const entry of definitions(await readFile(new URL(file,root),'utf8')))prior.set(...entry);
 const previous=Object.fromEntries(dependencies.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));return{source,functions:Object.fromEntries(added),previous};
}
const previousChecks=`FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions)LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'emission_080_previous_contract_changed' USING ERRCODE='55000';END IF;
END LOOP;`;
const sharedDecl=`names text[];current_names text[];object_name text;snapshot jsonb;service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'emission_080_roles_missing' USING ERRCODE='55000';END IF;`;
const fiscalGate=`IF EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy p WHERE p.version=(SELECT max(q.version)FROM erp_fiscal_authorization.policy q WHERE q.model=p.model)AND p.enabled)THEN RAISE EXCEPTION 'emission_080_fiscal_gate_not_closed' USING ERRCODE='55000';END IF;`;
const historicalCounts=`'fiscal_attempts',(SELECT count(*)FROM erp_fiscal_authorization.attempt),'historical_enabled_policies',(SELECT count(*)FROM erp_fiscal_authorization.policy WHERE enabled),'effective_enabled_heads',0,'enabled_heads',0,'consumption_performed',false`;
const triggerChecks=`
 IF (SELECT array_agg(tgname::text ORDER BY tgname)FROM pg_trigger WHERE tgrelid='erp_fiscal_authorization.attempt'::regclass AND NOT tgisinternal)
 IS DISTINCT FROM ARRAY['guard_attempt','reviewed_use_commit','reviewed_use_guard','reviewed_use_time_commit','reviewed_use_time_guard']::text[]
 THEN RAISE EXCEPTION 'emission_080_trigger_inventory_changed' USING ERRCODE='40001';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='erp_fiscal_authorization.attempt'::regclass AND tgname='reviewed_use_time_guard' AND NOT tgisinternal
 AND tgtype=19 AND tgenabled='O'AND tgfoid='erp_fiscal_reviewed_authorization.guard_nfce_emission_window()'::regprocedure
 AND tgnargs=0 AND NOT tgdeferrable AND NOT tginitdeferred AND tgconstraint=0 AND tgconstrrelid=0 AND tgconstrindid=0
 AND tgattr::text=(SELECT attnum::text FROM pg_attribute WHERE attrelid='erp_fiscal_authorization.attempt'::regclass AND attname='used_at')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER reviewed_use_time_guard BEFORE UPDATE OF used_at ON erp_fiscal_authorization.attempt FOR EACH ROW WHEN (((old.used_at IS NULL) AND (new.used_at IS NOT NULL))) EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_nfce_emission_window()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='erp_fiscal_authorization.attempt'::regclass AND tgname='reviewed_use_time_commit' AND NOT tgisinternal
 AND tgtype=17 AND tgenabled='O'AND tgfoid='erp_fiscal_reviewed_authorization.guard_nfce_emission_window()'::regprocedure
 AND tgnargs=0 AND tgdeferrable AND tginitdeferred AND tgconstraint<>0 AND tgconstrrelid=0 AND tgconstrindid=0 AND tgattr::text=''
 AND pg_get_triggerdef(oid)='CREATE CONSTRAINT TRIGGER reviewed_use_time_commit AFTER UPDATE ON erp_fiscal_authorization.attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.used_at IS NULL) AND (new.used_at IS NOT NULL))) EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_nfce_emission_window()')
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='erp_fiscal_authorization.attempt'::regclass AND conname='reviewed_use_time_commit'AND contype='t'AND condeferrable AND condeferred AND convalidated AND pg_get_constraintdef(oid)='TRIGGER DEFERRABLE INITIALLY DEFERRED')
 THEN RAISE EXCEPTION 'emission_080_trigger_contract_failed' USING ERRCODE='40001';END IF;`;
export async function prepareFiscalNfceEmissionWindowApply(){
 const{source,functions,previous}=await reviewed();
 return `-- 080: two private helpers and two temporal triggers. No table, RPC, attempt or policy change.
-- Source SHA-256: ${SOURCE_SHA256} (migration bytes, not this applicator or the file manifest).
-- Execute once, whole script, as migration owner. A concurrent writer causes NOWAIT refusal; no automatic retry.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='90s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_emission_080_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_080$
DECLARE
 source_080 text:=$source_080$${source}$source_080$;
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 required_tables constant text[]:=ARRAY['auth.users','storage.buckets','storage.objects','erp_access.membership','erp_company.identity','erp_a1.credential','erp_a1.sealed_object','erp_fiscal_authorization.policy','erp_fiscal_authorization.intent','erp_fiscal_authorization.command','erp_fiscal_authorization.attempt','erp_fiscal_authorization.request','erp_fiscal_authorization.result','erp_fiscal_authorization.audit','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_reviewed_authorization.observation','erp_stock.reservation','origin_sync.raw_record','erp_fiscal_unsigned.identity','erp_fiscal_unsigned.job','erp_fiscal_signed.candidate','erp_fiscal_signed.artifact','erp_fiscal_authorization_revalidation.command'];
 ${sharedDecl}
 source_body text;opening integer;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_functions jsonb;after_functions jsonb;before_catalog jsonb;after_catalog jsonb;
BEGIN
 IF encode(sha256(convert_to(source_080,'UTF8')),'hex')IS DISTINCT FROM '${SOURCE_SHA256}'THEN RAISE EXCEPTION 'emission_080_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='erp_fiscal_authorization.attempt'::regclass AND tgname IN('reviewed_use_time_guard','reviewed_use_time_commit'))OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions)f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1))THEN RAISE EXCEPTION 'emission_080_already_present' USING ERRCODE='55000';END IF;
 ${roles}
 FOREACH object_name IN ARRAY required_tables LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'emission_080_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;
 ${tableInventory('names')}
 -- CREATE TRIGGER needs the final lock mode: acquire it upfront, avoiding upgrades.
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
 ${previousChecks}
 ${fiscalGate}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${functionInventory('before_functions','ARRAY[]::oid[]')}
 ${otherCatalog('before_catalog')}
 opening:=position(E'\\nbegin;\\n'IN source_080);IF right(source_080,8)IS DISTINCT FROM E'commit;\\n'OR opening=0 THEN RAISE EXCEPTION 'emission_080_transaction_wrapper_invalid' USING ERRCODE='22023';END IF;
 source_body:=overlay(left(source_080,length(source_080)-8)placing E'\\n'from opening for 8);EXECUTE source_body;
 -- reviewed objects created
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM names THEN RAISE EXCEPTION 'emission_080_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'emission_080_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'emission_080_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'emission_080_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'emission_080_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 ${functionInventory('after_functions','reviewed_oids')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'emission_080_other_functions_changed' USING ERRCODE='40001';END IF;
 ${triggerChecks}
 ${otherCatalog('after_catalog')}
 IF before_catalog IS DISTINCT FROM after_catalog THEN RAISE EXCEPTION 'emission_080_other_catalog_changed' USING ERRCODE='40001';END IF;
 ${fiscalGate}
 INSERT INTO pg_temp.brufap_emission_080_audit(result)VALUES(jsonb_build_object(
 'migration','080','applicator_version',1,'source_sha256','${SOURCE_SHA256}','required_function_hashes',previous_functions,
 'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
 'other_catalog_sha256',encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex'),'table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),
 'table_security_preserved_except_two_triggers',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_functions_unchanged',true,
 'new_service_only_rpcs',0,'new_private_helpers',2,'new_tables',0,'new_triggers',2,'trigger_contracts_valid',true,${historicalCounts},'worker_flag_changed',false,'native_mutation_performed',false,'commit_acknowledgement_required',true));
END $apply_080$;
SELECT result AS fiscal_nfce_emission_window_apply_audit FROM pg_temp.brufap_emission_080_audit;
COMMIT;
`;
}
export async function prepareFiscalNfceEmissionWindowReadback(){
 const{functions,previous}=await reviewed();
 return `-- 080 immediate read-only commit proof. No enabled policy head, including future or expired heads.
-- Source SHA-256: ${SOURCE_SHA256}; compare with apply audit, not with script/manifest hashes.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_080$
DECLARE
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 ${sharedDecl}
 rows_state jsonb:='{}';table_security jsonb;schema_security jsonb;default_privileges jsonb;other_functions jsonb;other_catalog jsonb;
BEGIN
 ${roles}
 ${previousChecks}
 ${contractChecks}
 ${triggerChecks}
 ${fiscalGate}
 ${tableInventory('names')}
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${functionInventory('other_functions','reviewed_oids')}
 ${otherCatalog('other_catalog')}
 PERFORM set_config('brufap.emission_080_readback',jsonb_build_object('migration','080','source_sha256','${SOURCE_SHA256}','protected_table_count',cardinality(names),'rows',rows_state,
 'other_catalog_sha256',encode(sha256(convert_to(other_catalog::text,'UTF8')),'hex'),'table_security_sha256',encode(sha256(convert_to(table_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schema_security::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(default_privileges::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),
 'function_contracts_valid',true,'new_service_only_rpcs',0,'new_private_helpers',2,'new_tables',0,'new_triggers',2,'trigger_contracts_valid',true,${historicalCounts},'worker_flag_changed',false,'native_mutation_performed',false)::text,true);
END $readback_080$;
SELECT current_setting('brufap.emission_080_readback')::jsonb AS fiscal_nfce_emission_window_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await prepareFiscalNfceEmissionWindowApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(sql)}));
}
