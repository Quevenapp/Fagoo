// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {RECEIPT_QUERY_TABLE_CONTRACT_SQL} from './helpers/receipt-query-apply-contract.mjs';
export const SOURCE_HASHES=Object.freeze({'089':'1b50b4ad9692006179b3c1cf37936ddeac3dd07c10dd4a1d630fca743e3c9b9e'});
const hash=value=>createHash('sha256').update(value).digest('hex');
function definitions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(x=>x.trim().split(/\s+/));
 return[m[2]+'('+args.map(x=>x[1]).join(',')+')',{sha256:hash(m[6]),public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v',args:args.length?args.map(x=>x[0]):null,defaults:args.filter(x=>x.includes('default')).length,default_expression:({'erp_fiscal_receipt_query.chain':'NULL::uuid','erp_fiscal_receipt_query.next_at':'NULL::uuid','erp_fiscal_receipt_query.chain_gate':'NULL::uuid','public.erp_fiscal_receipt_query_history':'25, NULL::integer'}[m[2]]??null)}];
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
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
 'internal_triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgisinternal AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.oid=t.tgconstraint AND k.connamespace=coalesce(to_regnamespace('erp_fiscal_receipt_query'),0::oid))))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE(nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage'))AND nspname<>'erp_fiscal_receipt_query';`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d WHERE d.defaclnamespace IS DISTINCT FROM to_regnamespace('erp_fiscal_receipt_query');`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'attributes',to_jsonb(p))::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const otherCatalog=target=>`SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relpersistence,c.reloptions,c.reltablespace,c.relam,c.relreplident,c.relrowsecurity,c.relforcerowsecurity)ORDER BY n.nspname,c.relname)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_fiscal_receipt_query'),
 'types',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_fiscal_receipt_query')) INTO ${target};`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL
  OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
  OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM(r.value->>'public')::boolean
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid AND NOT a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog','TimeZone=UTC']
   AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND (case when p.pronargs=0 then 'null'::jsonb else to_jsonb(p.proargnames)end)=r.value->'args'
   AND p.procost=100 AND p.prorows=0 AND p.prosupport=0 AND p.proallargtypes IS NULL AND p.probin IS NULL AND p.prosqlbody IS NULL AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=(r.value->>'defaults')::integer AND pg_get_expr(p.proargdefaults,0) IS NOT DISTINCT FROM r.value->>'default_expression' AND p.proargmodes IS NULL
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
 THEN RAISE EXCEPTION 'receipt_query_089_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;

const dependencies=[
 'erp_a1.company()','erp_a1.exact(jsonb,text[])','erp_a1.iso(jsonb)',
 'erp_fiscal_wsdl.check_a1(erp_a1.head,integer,integer)','erp_fiscal_wsdl.hash(jsonb)',
 'erp_fiscal_authorization.immutable()','erp_fiscal_authorization.source(uuid,uuid,text)',
 'erp_fiscal_authorization.context(erp_fiscal_authorization.attempt)','erp_fiscal_authorization.view(erp_fiscal_authorization.attempt)',
 'erp_fiscal_reviewed_authorization.require_profile(erp_fiscal_authorization.attempt)',
 'erp_fiscal_reviewed_authorization.check_review(erp_fiscal_authorization.attempt,jsonb,boolean)',
 'erp_fiscal_authorization_revalidation.profile()','erp_fiscal_authorization_revalidation.manifest()',
 'public.erp_fiscal_reviewed_authorization_revalidation_command(uuid,uuid)',
 'public.erp_origin_stock_observations(uuid,text,integer,text,text)',
 'public.erp_origin_financial_import_apply(uuid,text,jsonb,boolean,uuid,text,boolean)'
];
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),names={'089':'202610160089_fiscal_receipt_query.sql'},sources={},added=[];
 for(const[k,file]of Object.entries(names)){
  const s=await readFile(new URL(file,root),'utf8');if(hash(s)!==SOURCE_HASHES[k]||!s.endsWith('commit;\n')||s.split('\nbegin;\n').length!==2||s.includes('$source_'+k+'$'))throw Error('SOURCE_'+k+'_NOT_REVIEWED');sources[k]=s;added.push(...definitions(s));
 }
 if(added.length!==31||new Set(added.map(([s])=>s)).size!==31||added.filter(([,m])=>m.public).length!==8||added.some(([sig,m])=>m.definer!==(m.public||sig==='erp_fiscal_receipt_query.commit_use()')||!['jsonb','trigger','void','text','timestamptz','erp_fiscal_receipt_query.query'].includes(m.returns)))throw Error('RECEIPT_QUERY_FUNCTION_INVENTORY');
 const prior=new Map();for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=88).sort())for(const entry of definitions(await readFile(new URL(file,root),'utf8')))prior.set(...entry);
 const previous=Object.fromEntries(dependencies.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));return{sources,functions:Object.fromEntries(added),previous};
}
const previousChecks=`FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'receipt_query_089_previous_contract_changed' USING ERRCODE='55000';END IF;
END LOOP;`;
const sharedDecl=`names text[];current_names text[];object_name text;snapshot jsonb;service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'receipt_query_089_roles_missing' USING ERRCODE='55000';END IF;`;

export const EXPECTED_CATALOG_SHA256='21d01322e39a327bc2522fa709d9882f41a1d06d0b5aa5eedfbb76ce53698255';
const catalogText=await readFile(new URL('./helpers/receipt-query-089-catalog.json',import.meta.url),'utf8');
if(hash(catalogText)!==EXPECTED_CATALOG_SHA256)throw Error('RECEIPT_QUERY_CATALOG_NOT_REVIEWED');
const expectedCatalog=JSON.parse(catalogText);
const newTables=['audit','policy','query','request','result'].map(n=>'erp_fiscal_receipt_query.'+n);
const expectedPolicies=['55','65'].map(model=>({model,version:1,enabled:false,profile:'receipt-query-source-089-v1',manifest_hash:'748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098',origin:'operational',binding_profile:'sp'+model+'-receipt-soap12-reviewed-20261016-v1',lease_seconds:60,cadence_seconds:60,max_queries_per_hour:10,valid_from:'2026-10-17T00:00:00+00:00',valid_until:'2026-10-18T00:00:00+00:00'}));
const privateChecks=`
 IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='erp_fiscal_receipt_query'AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a WHERE n.nspname='erp_fiscal_receipt_query'AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl)a WHERE d.defaclnamespace='erp_fiscal_receipt_query'::regnamespace AND(a.grantee<>d.defaclrole OR d.defaclrole<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 THEN RAISE EXCEPTION 'receipt_query_089_private_schema_failed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.query) OR EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.request) OR EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.result) OR EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.audit)
 OR(SELECT jsonb_agg(to_jsonb(p)-'created_at'ORDER BY model)FROM erp_fiscal_receipt_query.policy p)IS DISTINCT FROM '${JSON.stringify(expectedPolicies)}'::jsonb OR EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.policy WHERE NOT isfinite(created_at)) THEN RAISE EXCEPTION 'receipt_query_089_new_table_seed_invalid' USING ERRCODE='40001';END IF;
 FOREACH object_name IN ARRAY ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}]LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.oid=object_name::regclass AND c.relkind='r'AND c.relpersistence='p'AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND c.reloptions IS NULL AND c.relreplident='d'AND c.reloftype=0 AND c.reltablespace=0 AND a.amname='heap'AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=object_name::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE a.attrelid=object_name::regclass AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=object_name::regclass)
  THEN RAISE EXCEPTION 'receipt_query_089_private_table_failed' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=object_name::regclass AND a.attnum>0 AND(a.attisdropped OR a.attcollation<>t.typcollation OR a.attstorage<>t.typstorage))
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=object_name::regclass OR inhparent=object_name::regclass)
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE k.conrelid=object_name::regclass AND t.tgenabled<>'O')
  THEN RAISE EXCEPTION 'receipt_query_089_table_contract_failed' USING ERRCODE='40001';END IF;
 END LOOP;
 ${RECEIPT_QUERY_TABLE_CONTRACT_SQL.replace(' AS contract',' INTO snapshot')};
 IF snapshot IS DISTINCT FROM '${JSON.stringify(expectedCatalog).replaceAll("'","''")}'::jsonb
 THEN RAISE EXCEPTION 'receipt_query_089_table_contract_failed' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('s',c.relowner)))a WHERE c.relnamespace='erp_fiscal_receipt_query'::regnamespace AND c.relkind='S'AND(a.grantee<>c.relowner OR c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='erp_fiscal_receipt_query'::regnamespace AND c.relkind='S'AND(c.relpersistence<>'p'OR c.reloptions IS NOT NULL OR c.reltablespace<>0 OR c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 THEN RAISE EXCEPTION 'receipt_query_089_private_sequence_failed' USING ERRCODE='42501';END IF;
 IF(SELECT jsonb_build_array(last_value::text,is_called)FROM erp_fiscal_receipt_query.audit_id_seq)IS DISTINCT FROM '["1",false]'::jsonb
 THEN RAISE EXCEPTION 'receipt_query_089_sequence_state_invalid' USING ERRCODE='40001';END IF;
 IF erp_fiscal_receipt_query.flags()IS DISTINCT FROM '{"data_mode":"fiscal_receipt_query","environment":"2","can_query":false,"can_emit":false,"can_transmit":false,"tax_rules_validated":false,"production_authorized":false,"retry_submission_allowed":false,"financial_mutation_performed":false,"stock_mutation_performed":false}'::jsonb
 THEN RAISE EXCEPTION 'receipt_query_089_flags_contract_failed' USING ERRCODE='40001';END IF;`;
export async function prepareReceiptQueryApply(){
 const{sources,functions,previous}=await reviewed();
 return `--089 installs disabled receipt-query contracts only. No A1 opening, SEFAZ request, emission or native effects.
-- Embedded source SHA is distinct from the generated-script/manifest SHA.
-- Whole-script execution only; concurrent writer => NOWAIT refusal, never automatic retry.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_receipt_query_089_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_089$
DECLARE
 source_089 text:=$source_089$${sources['089']}$source_089$;
 reviewed_functions constant jsonb:='${JSON.stringify(functions).replaceAll("'","''")}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 required_tables constant text[]:=ARRAY['origin_sync.raw_record','origin_sync.resource_state','erp_sales_history.snapshot','erp_sales_history.command','erp_catalog.record','erp_warehouse_import.binding','erp_warehouse_import.command','erp_access.membership','erp_documents.document','erp_stock.balance','erp_finance.title','auth.users','storage.buckets','storage.objects','erp_fiscal_authorization.policy','erp_fiscal_authorization.attempt','erp_fiscal_authorization.command','erp_fiscal_authorization.intent','erp_fiscal_authorization.result','erp_fiscal_authorization.audit','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_reviewed_authorization.observation','erp_fiscal_authorization_revalidation.command','erp_a1.credential','erp_a1.sealed_object','erp_a1.head','erp_company.identity'];
 ${sharedDecl}
 source_body text;opening integer;source_text text;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_catalog jsonb;after_catalog jsonb;before_functions jsonb;after_functions jsonb;
BEGIN
 IF encode(sha256(convert_to(source_089,'UTF8')),'hex')IS DISTINCT FROM '${SOURCE_HASHES['089']}' THEN RAISE EXCEPTION 'receipt_query_089_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF to_regnamespace('erp_fiscal_receipt_query')IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1))THEN RAISE EXCEPTION 'receipt_query_089_already_present' USING ERRCODE='55000';END IF;
 ${roles}
 FOREACH object_name IN ARRAY required_tables LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'receipt_query_089_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;
 ${tableInventory('names')}
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
 ${previousChecks}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${otherCatalog('before_catalog')}
 ${functionInventory('before_functions','ARRAY[]::oid[]')}
 FOREACH source_text IN ARRAY ARRAY[source_089]LOOP
  opening:=position(E'\\nbegin;\\n' IN source_text);IF right(source_text,8)IS DISTINCT FROM E'commit;\\n'OR opening=0 THEN RAISE EXCEPTION 'receipt_query_089_transaction_wrapper_invalid' USING ERRCODE='22023';END IF;
  source_body:=overlay(left(source_text,length(source_text)-8)placing E'\\n'from opening for 8);
  EXECUTE source_body;
 END LOOP;
 -- reviewed functions created
 SET CONSTRAINTS ALL IMMEDIATE;
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM(SELECT array_agg(x ORDER BY x COLLATE "C")FROM unnest(names||ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}])x)THEN RAISE EXCEPTION 'receipt_query_089_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'receipt_query_089_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'receipt_query_089_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'receipt_query_089_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'receipt_query_089_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${otherCatalog('after_catalog')}
 IF before_catalog IS DISTINCT FROM after_catalog THEN RAISE EXCEPTION 'receipt_query_089_other_catalog_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 ${privateChecks}
 IF EXISTS(SELECT 1 FROM erp_fiscal_receipt_query.policy WHERE created_at<transaction_timestamp()OR created_at>clock_timestamp())THEN RAISE EXCEPTION 'receipt_query_089_seed_clock_invalid' USING ERRCODE='40001';END IF;
 ${functionInventory('after_functions','reviewed_oids')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'receipt_query_089_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_receipt_query_089_audit(result)VALUES(jsonb_build_object(
 'migrations',jsonb_build_array('089'),'applicator_version',1,'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'required_function_hashes',previous_functions,
 'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
 'table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),
 'table_security_unchanged',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_catalog_unchanged',true,'other_functions_unchanged',true,'catalog_contract_sha256','${EXPECTED_CATALOG_SHA256}',
 'new_service_only_rpcs',8,'new_private_helpers',23,'new_tables',5,'new_queries_empty',true,'new_artifacts_empty',true,'new_audit_empty',true,'new_triggers',7,'new_policy_seeds_disabled',2,'new_policy_rows',(SELECT jsonb_agg(to_jsonb(p)ORDER BY model)FROM erp_fiscal_receipt_query.policy p),'worker_flag_changed',false,'native_mutation_performed',false,'commit_acknowledgement_required',true));
END $apply_089$;
SELECT result AS receipt_query_apply_audit FROM pg_temp.brufap_receipt_query_089_audit;
COMMIT;
`;
}
export async function prepareReceiptQueryReadback(){
 const{functions,previous}=await reviewed();
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_089$
DECLARE
 reviewed_functions constant jsonb:='${JSON.stringify(functions).replaceAll("'","''")}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 ${sharedDecl}
 rows_state jsonb:='{}';table_security jsonb;schema_security jsonb;default_privileges jsonb;other_functions jsonb;other_catalog jsonb;
BEGIN
 ${roles}
 ${previousChecks}
 ${contractChecks}
 ${privateChecks}
 ${tableInventory('names')}
 names:=array(SELECT unnest(names)EXCEPT SELECT unnest(ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}]));
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${otherCatalog('other_catalog')}
 ${functionInventory('other_functions','reviewed_oids')}
 PERFORM set_config('brufap.receipt_query_089_readback',jsonb_build_object('migrations',jsonb_build_array('089'),'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'protected_table_count',cardinality(names),'rows',rows_state,
 'table_security_sha256',encode(sha256(convert_to(table_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schema_security::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(default_privileges::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(other_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),
 'function_contracts_valid',true,'catalog_contract_sha256','${EXPECTED_CATALOG_SHA256}','new_service_only_rpcs',8,'new_private_helpers',23,'new_tables',5,'new_queries_empty',true,'new_artifacts_empty',true,'new_audit_empty',true,'new_triggers',7,'new_policy_seeds_disabled',2,'new_policy_rows',(SELECT jsonb_agg(to_jsonb(p)ORDER BY model)FROM erp_fiscal_receipt_query.policy p),'worker_flag_changed',false,'native_mutation_performed',false)::text,true);
END $readback_089$;
SELECT current_setting('brufap.receipt_query_089_readback')::jsonb AS receipt_query_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await prepareReceiptQueryApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_HASHES,script_sha256:hash(sql)}));
}
