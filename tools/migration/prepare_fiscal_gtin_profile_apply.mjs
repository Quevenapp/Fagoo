// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_HASHES=Object.freeze({'077':'c77c1b19868597347f36afa59f8bdf0e4b492e856f78ed34afefc3c29fbb0d7f'});
const hash=value=>createHash('sha256').update(value).digest('hex');
function definitions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(x=>x.trim().split(/\s+/));
 return[m[2]+'('+args.map(x=>x[1]).join(',')+')',{replace:Boolean(m[1]),sha256:hash(m[6]),public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v',args:args.length?args.map(x=>x[0]):null}];
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
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',x.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY x.relname) FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d;`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL
  OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
  OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM(r.value->>'public')::boolean
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid AND NOT a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND coalesce(to_jsonb(p.proargnames),'null'::jsonb)=r.value->'args'
   AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargmodes IS NULL
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
 THEN RAISE EXCEPTION 'gtin_profile_077_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;

const V1='e8cbc410cbee76c4c8e1ce7a32dcf42e299619fa2c6cf98b8b5d2c73e34db504',V2='d6cd5e25ed80a28883ee13f1b3909fa83685f2d1acd50766fe0d05b6ce2070a6';
const PROFILE='sp-crt1-internal-sale-homologation-20261017-v2';
const OLD_CHECK='CHECK ((profile_hash = erp_fiscal_subset_review.profile_hash()))';
const NEW_CHECK=`CHECK ((profile_hash = ANY (ARRAY['${V1}'::text, '${V2}'::text])))`;
const literal=s=>"'"+s.replaceAll("'","''")+"'";
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160077_fiscal_gtin_rule_profile_v2.sql',root),'utf8');
 if(hash(source)!==SOURCE_HASHES['077']||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_077$'))throw Error('SOURCE_077_NOT_REVIEWED');
 const all=definitions(source),added=all.filter(([,m])=>!m.replace),replaced=all.filter(([,m])=>m.replace);
 if(all.length!==11||added.length!==4||replaced.length!==7||new Set(all.map(([s])=>s)).size!==11||added.filter(([,m])=>m.public).length!==1)throw Error('GTIN_FUNCTION_INVENTORY');
 const prior=new Map();for(const f of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=76).sort())for(const e of definitions(await readFile(new URL(f,root),'utf8')))prior.set(...e);
 const dependencies=['erp_fiscal_subset_review.profile()','erp_fiscal_subset_review.profile_hash()','erp_fiscal_subset_review.flags()','erp_fiscal_subset_review.declaration(text)','erp_fiscal_subset_review.canonical(jsonb)','erp_fiscal_subset_review.digest(text)','erp_fiscal_authorization.source(uuid,uuid,text)','erp_fiscal_authorization.lock_source(uuid,uuid,boolean)','erp_fiscal_reviewed_authorization.require_profile(erp_fiscal_authorization.attempt)','erp_fiscal_reviewed_authorization.manifest(text)','erp_fiscal_signed.current(erp_fiscal_signed.candidate)','erp_a1.access(uuid,boolean)','erp_a1.exact(jsonb,text[])'];
 const old=Object.fromEntries(replaced.map(([s])=>{if(!prior.has(s))throw Error('REPLACED_SOURCE_MISSING:'+s);return[s,prior.get(s)];}));
 const previous=Object.fromEntries(dependencies.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));
 return{source,functions:Object.fromEntries(all),added:Object.fromEntries(added),old,previous};
}
const previousChecks=`FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions)LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'gtin_profile_077_dependency_changed' USING ERRCODE='55000';END IF;END LOOP;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon')OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'gtin_profile_077_roles_missing' USING ERRCODE='55000';END IF;`;
const gate=`IF EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy WHERE enabled)OR EXISTS(SELECT 1 FROM erp_fiscal_authorization.attempt WHERE state IN('prepared','request_ready','dispatched','submission_uncertain'))THEN RAISE EXCEPTION 'gtin_profile_077_active_execution_refused' USING ERRCODE='55000';END IF;`;
const decl=`names text[];current_names text[];object_name text;snapshot jsonb;service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;`;
const normalizeSecurity=(target,constraint)=>`${target}:=jsonb_set(${target},ARRAY['erp_fiscal_subset_review.review','constraints'],coalesce((SELECT jsonb_agg(x ORDER BY x->>'name')FROM jsonb_array_elements(${target}#>'{erp_fiscal_subset_review.review,constraints}')x WHERE x->>'name'<>${literal(constraint)}),'[]'));`;
const checkConstraint=(name,value)=>`IF(SELECT pg_get_constraintdef(oid)FROM pg_constraint WHERE conrelid='erp_fiscal_subset_review.review'::regclass AND conname=${literal(name)} AND contype='c'AND convalidated AND NOT condeferrable AND NOT condeferred)IS DISTINCT FROM ${literal(value)} THEN RAISE EXCEPTION 'gtin_profile_077_check_contract_changed' USING ERRCODE='55000';END IF;`;
// Only the two new v2 policy rows are excluded from the historical row comparison.
const historicalRows=target=>`FOREACH object_name IN ARRAY names LOOP
 EXECUTE format($fp$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex'))FROM(SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')h FROM %s t %s)q$fp$,object_name,CASE WHEN object_name='erp_fiscal_authorization.policy'THEN $pred$WHERE rule_profile IS DISTINCT FROM '${PROFILE}'$pred$ ELSE ''END)INTO snapshot;
 ${target}:=${target}||jsonb_build_object(object_name,snapshot);END LOOP;`;
const replacementIdentity=target=>`SELECT jsonb_object_agg(entry.key,jsonb_build_object('oid',p.oid,'acl',p.proacl,'owner',p.proowner)) INTO ${target} FROM jsonb_each(old_functions)entry JOIN pg_proc p ON p.oid=to_regprocedure(entry.key);`;
const seedProjection=`SELECT jsonb_agg(to_jsonb(p)ORDER BY model)INTO seeds FROM erp_fiscal_authorization.policy p WHERE rule_profile='${PROFILE}';`;
const seedCheck=`IF jsonb_array_length(seeds)IS DISTINCT FROM 2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(seeds)x WHERE
 x->>'model'NOT IN('55','65')OR(x->>'version')::integer<1 OR x->>'origin'<>'operational'OR x->'enabled'IS DISTINCT FROM'false'::jsonb
 OR x->>'binding_profile'IS DISTINCT FROM'sp'||(x->>'model')||'-authorization-soap12-reviewed-20261016-v1'
 OR x->>'rule_profile'<>'${PROFILE}'OR x->'binding_reviewed'IS DISTINCT FROM'true'::jsonb OR x->'tax_rules_reviewed'IS DISTINCT FROM'false'::jsonb
 OR x->>'source_manifest_hash'IS DISTINCT FROM CASE x->>'model'WHEN'55'THEN'e70502bf2fa3a720dcd1eb7abf689d90cf61b192e01cdd182cbba816057e4f9b'ELSE'b4ddf9d9fff3a9efff05d6cc97e9904835314455ab730ee4cc8ba0c9e13b07f7'END
 OR(x->>'valid_from')::timestamptz<>'2026-10-16T03:00:00Z'::timestamptz OR(x->>'valid_until')::timestamptz<>'2026-10-26T03:00:00Z'::timestamptz
 OR x->>'authorization_profile'<>'reviewed_subset_v1'
 OR(x->>'version')::integer<>(SELECT max(version)FROM erp_fiscal_authorization.policy p WHERE p.model=x->>'model')
 )OR(SELECT count(DISTINCT x->>'model')FROM jsonb_array_elements(seeds)x)<>2 THEN RAISE EXCEPTION 'gtin_profile_077_seed_contract_changed' USING ERRCODE='40001';END IF;`;
export async function prepareFiscalGtinProfileApply(){
 const{source,functions,added,old,previous}=await reviewed();
 return `-- 077 reviewed profile v2, local preparation; no activation or historical rewrite.
-- SOURCE SHA is the migration digest, not this applicator's digest. Execute whole script once.
BEGIN;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_gtin_profile_077_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_077$
DECLARE source_text text:=$source_077$${source}$source_077$;
 reviewed_functions jsonb:=${literal(JSON.stringify(functions))}::jsonb;
 added_functions constant jsonb:=${literal(JSON.stringify(added))}::jsonb;
 old_functions constant jsonb:=${literal(JSON.stringify(old))}::jsonb;
 previous_functions constant jsonb:=${literal(JSON.stringify(previous))}::jsonb;
 ${decl} opening integer;source_body text;all_functions jsonb:=reviewed_functions;old_oids oid[];before_identity jsonb;after_identity jsonb;
 before_rows jsonb:='{}';after_rows jsonb:='{}';after_full_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_functions jsonb;after_functions jsonb;
 policy_max jsonb;started timestamptz;seeds jsonb;
BEGIN
 IF encode(sha256(convert_to(source_text,'UTF8')),'hex')IS DISTINCT FROM '${SOURCE_HASHES['077']}'THEN RAISE EXCEPTION 'gtin_profile_077_source_hash_mismatch' USING ERRCODE='22023';END IF;
 FOR r IN SELECT key,value FROM jsonb_each(added_functions)LOOP IF to_regprocedure(r.key)IS NOT NULL THEN RAISE EXCEPTION 'gtin_profile_077_already_present' USING ERRCODE='55000';END IF;END LOOP;
 ${roles}
 ${tableInventory('names')}
 IF NOT(names @> ARRAY['erp_fiscal_subset_review.review','erp_fiscal_authorization.policy','erp_fiscal_authorization.attempt','auth.users','storage.buckets','storage.objects'])THEN RAISE EXCEPTION 'gtin_profile_077_prerequisite_missing' USING ERRCODE='55000';END IF;
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||CASE WHEN object_name='erp_fiscal_subset_review.review'THEN' IN ACCESS EXCLUSIVE MODE NOWAIT'ELSE' IN SHARE ROW EXCLUSIVE MODE NOWAIT'END;END LOOP;
 ${gate}
 ${checkConstraint('review_profile_hash_check',OLD_CHECK)}
 IF EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy WHERE rule_profile='${PROFILE}')THEN RAISE EXCEPTION 'gtin_profile_077_already_present' USING ERRCODE='55000';END IF;
 ${previousChecks}
 reviewed_functions:=old_functions;${contractChecks}
 old_oids:=reviewed_oids;reviewed_oids:=ARRAY[]::oid[];reviewed_functions:=all_functions;
 ${replacementIdentity('before_identity')}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${normalizeSecurity('before_security','review_profile_hash_check')}
 ${schemaSecurity('before_schemas')}${defaults('before_defaults')}${functionInventory('before_functions','old_oids')}
 SELECT jsonb_object_agg(model,version)INTO policy_max FROM(SELECT model,max(version)version FROM erp_fiscal_authorization.policy GROUP BY model)p;
 IF NOT(policy_max ?& ARRAY['55','65'])OR EXISTS(SELECT 1 FROM jsonb_each_text(policy_max)WHERE value::bigint>=2147483647)THEN RAISE EXCEPTION 'gtin_profile_077_policy_version_invalid' USING ERRCODE='55000';END IF;
 started:=clock_timestamp();opening:=position(E'\\nbegin;\\n'IN source_text);IF opening=0 OR right(source_text,8)IS DISTINCT FROM E'commit;\\n'then RAISE EXCEPTION 'gtin_profile_077_wrapper_invalid' USING ERRCODE='22023';END IF;
 source_body:=overlay(left(source_text,length(source_text)-8)placing E'\\n'from opening for 8);EXECUTE source_body;
 -- reviewed077 objects installed
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM names THEN RAISE EXCEPTION 'gtin_profile_077_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${historicalRows('after_rows')}
 IF after_rows IS DISTINCT FROM before_rows THEN RAISE EXCEPTION 'gtin_profile_077_historical_data_changed' USING ERRCODE='40001';END IF;
 ${seedProjection}${seedCheck}
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(seeds)x WHERE(x->>'version')::integer<>(policy_max->>(x->>'model'))::integer+1 OR(x->>'created_at')::timestamptz<started OR(x->>'created_at')::timestamptz>clock_timestamp())THEN RAISE EXCEPTION 'gtin_profile_077_seed_contract_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_full_rows')}
 ${checkConstraint('review_supported_profile_hash_check',NEW_CHECK)}
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='erp_fiscal_subset_review.review'::regclass AND conname='review_profile_hash_check')THEN RAISE EXCEPTION 'gtin_profile_077_check_contract_changed' USING ERRCODE='55000';END IF;
 ${tableSecurity('after_security')}${normalizeSecurity('after_security','review_supported_profile_hash_check')}
 IF after_security IS DISTINCT FROM before_security THEN RAISE EXCEPTION 'gtin_profile_077_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}IF after_schemas IS DISTINCT FROM before_schemas THEN RAISE EXCEPTION 'gtin_profile_077_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}IF after_defaults IS DISTINCT FROM before_defaults THEN RAISE EXCEPTION 'gtin_profile_077_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}${replacementIdentity('after_identity')}
 IF after_identity IS DISTINCT FROM before_identity THEN RAISE EXCEPTION 'gtin_profile_077_replaced_identity_changed' USING ERRCODE='42501';END IF;
 ${functionInventory('after_functions','reviewed_oids')}
 IF after_functions IS DISTINCT FROM before_functions THEN RAISE EXCEPTION 'gtin_profile_077_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_gtin_profile_077_audit VALUES(jsonb_build_object('migration','077','source_sha256','${SOURCE_HASHES['077']}','applicator_version',1,'protected_table_count',cardinality(names),'before',before_rows,'after_historical',after_rows,'after_full',after_full_rows,'historical_data_preserved',true,'new_disabled_policy_seeds',seeds,'new_functions',4,'replaced_functions',7,'new_service_only_rpcs',1,'new_tables',0,
 'table_security_sha256',encode(sha256(convert_to(after_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(after_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(after_defaults::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(after_functions::text,'UTF8')),'hex'),'replaced_function_identity',after_identity,'enabled_policies',0,'operational_effects',false,'commit_acknowledgement_required',true));
END $apply_077$;
SELECT result AS fiscal_gtin_profile_apply_audit FROM pg_temp.brufap_gtin_profile_077_audit;COMMIT;
`;
}
export async function prepareFiscalGtinProfileReadback(){
 const{functions,old,previous}=await reviewed();return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_077$
DECLARE reviewed_functions jsonb:=${literal(JSON.stringify(functions))}::jsonb;old_functions jsonb:=${literal(JSON.stringify(old))}::jsonb;previous_functions jsonb:=${literal(JSON.stringify(previous))}::jsonb;
 ${decl} rows_full jsonb:='{}';rows_historical jsonb:='{}';security jsonb;schemas jsonb;privileges jsonb;other_functions jsonb;identity jsonb;seeds jsonb;
BEGIN ${roles}${previousChecks}${contractChecks}${gate}
 ${checkConstraint('review_supported_profile_hash_check',NEW_CHECK)}
 ${tableInventory('names')}${rowFingerprints('rows_full')}${historicalRows('rows_historical')}
 ${tableSecurity('security')}${normalizeSecurity('security','review_supported_profile_hash_check')}${schemaSecurity('schemas')}${defaults('privileges')}${functionInventory('other_functions','reviewed_oids')}${replacementIdentity('identity')}
 ${seedProjection}${seedCheck}
 PERFORM set_config('brufap.gtin_profile_077_readback',jsonb_build_object('migration','077','source_sha256','${SOURCE_HASHES['077']}','observed_at',statement_timestamp(),'protected_table_count',cardinality(names),'rows_full',rows_full,'rows_historical',rows_historical,'new_disabled_policy_seeds',seeds,'function_contracts_valid',true,
 'table_security_sha256',encode(sha256(convert_to(security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(privileges::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),'replaced_function_identity',identity,'enabled_policies',0,'operational_effects',false)::text,true);
END $readback_077$;SELECT current_setting('brufap.gtin_profile_077_readback')::jsonb AS fiscal_gtin_profile_commit_readback;COMMIT;
`;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await prepareFiscalGtinProfileApply(),f=await open(process.argv[2],'wx',0o600);try{await f.writeFile(sql);await f.sync();}finally{await f.close();}console.log(JSON.stringify({prepared:true,source_sha256:SOURCE_HASHES,script_sha256:hash(sql),remote_executed:false}));}
