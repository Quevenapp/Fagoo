// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='e6d1686c4ef230adaad45262133da18d6783baa698dc5ff80843f1286003a339';
const hash=value=>createHash('sha256').update(value).digest('hex');
const signature='text,text,uuid,uuid,uuid,jsonb,jsonb,bigint';
const oldSignature=`public.origin_sync_apply_batch(${signature})`;
const copySignature=`origin_sync.apply_batch_legacy_078(${signature})`;
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
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',x.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY x.relname) FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d;`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const rpcContract=(target,sig)=>`SELECT jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0),'definer',p.prosecdef,'config',p.proconfig,'returns',p.prorettype,'language',p.prolang,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,'kind',p.prokind,'retset',p.proretset,'argmodes',p.proargmodes,'variadic',p.provariadic) INTO ${target} FROM pg_proc p WHERE p.oid=to_regprocedure('${sig}');`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL
  OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
  OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM(r.value->>'public')::boolean
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid AND NOT a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND to_jsonb(p.proargnames)=r.value->'args'
   AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargmodes IS NULL
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
 THEN RAISE EXCEPTION 'sales_078_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160078_origin_sales_price_capture.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_078$'))throw Error('SOURCE_078_NOT_REVIEWED');
 const added=definitions(source);if(added.length!==3||new Set(added.map(([s])=>s)).size!==3||added.filter(([,m])=>m.public).length!==2)throw Error('SOURCE_078_FUNCTION_INVENTORY');
 const prior=new Map();for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=77).sort())for(const entry of definitions(await readFile(new URL(file,root),'utf8')))prior.set(...entry);
 const legacy071=definitions(await readFile(new URL('202610160059_origin_price_capture.sql',root),'utf8')).find(([sig])=>sig===oldSignature);if(!legacy071)throw Error('DEPENDENCY_059_WRAPPER_MISSING');prior.set(`origin_sync.apply_batch_legacy_071(${signature})`,{...legacy071[1],public:false});
 const dependencyNames=[`origin_sync.apply_batch_legacy_071(${signature})`,`public.origin_sync_apply_purchase_price_batch(${signature})`,'origin_sync.validate_purchase_price_capture(jsonb,jsonb)','erp_cutover.purchase_flags()','erp_fiscal_subset_review.current_profile_hash()',oldSignature,`origin_sync.apply_batch_legacy_059(${signature})`,'origin_sync.validate_price_capture(text,jsonb,jsonb)',`public.origin_sync_apply_price_batch(${signature})`,'public.origin_sync_claim(text,uuid,integer)','public.origin_sync_release(text,uuid,uuid)'];
 const previous=Object.fromEntries(dependencyNames.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));
 const original=prior.get(oldSignature);const functions=Object.fromEntries([...added,[copySignature,{...original,public:false}]]);
 return{source,previous,functions};
}
export async function prepareSalesPriceCaptureApply(){
 const {source,previous,functions}=await reviewed();
 return `-- 078 capture only. SOURCE SHA is the migration digest, not the applicator/manifest digest. No native imports, flags, checkpoint resets or remote execution by this generator.
-- Execute the whole script once as migration owner. Concurrent writers cause NOWAIT failure; do not auto-retry.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_sales_078_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_078$
DECLARE
 source_078 text:=$source_078$${source}$source_078$;
 expected_078 constant text:='${SOURCE_SHA256}';
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 required_tables constant text[]:=ARRAY['origin_sync.raw_record','origin_sync.resource_state','origin_sync.batch_inbox','origin_reference_fetch.attempt','erp_access.membership','erp_catalog.record','erp_catalog.product','erp_catalog.origin','erp_documents.document','erp_documents.item','erp_documents.origin_import_origin','erp_finance.title','erp_cnab.remittance','erp_stock.balance','erp_stock.reservation','erp_stock.reservation_item','erp_stock.reservation_command','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_authorization.policy','erp_fiscal_subset_review.review','erp_fiscal_authorization_closure.command','auth.users','storage.buckets','storage.objects'];
 names text[];current_names text[];object_name text;source_body text;opening integer;snapshot jsonb;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_functions jsonb;after_functions jsonb;
 before_rpc jsonb;after_rpc jsonb;copy_contract jsonb;old_oid oid;function_oid oid;service_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;
BEGIN
 IF encode(sha256(convert_to(source_078,'UTF8')),'hex')IS DISTINCT FROM expected_078 THEN RAISE EXCEPTION 'sales_078_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1) WHERE f.key<>'${oldSignature}') THEN RAISE EXCEPTION 'sales_078_already_present' USING ERRCODE='55000';END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'sales_078_roles_missing' USING ERRCODE='55000';END IF;
 FOREACH object_name IN ARRAY required_tables LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'sales_078_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;
 ${tableInventory('names')}
 -- No FK or table DDL in078: SHARE is sufficient and compatible with ordinary readers.
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE MODE NOWAIT';END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'sales_078_previous_contract_changed' USING ERRCODE='55000';END IF;
 END LOOP;
 old_oid:=to_regprocedure('${oldSignature}');
 ${rpcContract('before_rpc',oldSignature)}
 IF before_rpc IS NULL OR (before_rpc->>'owner')::oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user)
  OR NOT has_function_privilege('service_role',old_oid,'EXECUTE') OR has_function_privilege('anon',old_oid,'EXECUTE') OR has_function_privilege('authenticated',old_oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=old_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT(a.grantee=service_oid AND NOT a.is_grantable))
 THEN RAISE EXCEPTION 'sales_078_previous_rpc_security_changed' USING ERRCODE='42501';END IF;
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${functionInventory('before_functions','ARRAY[old_oid]')}
 opening:=position(E'\\nbegin;\\n' IN source_078);
 IF right(source_078,8)IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'sales_078_transaction_wrapper_invalid' USING ERRCODE='22023';END IF;
 source_body:=overlay(left(source_078,length(source_078)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM names THEN RAISE EXCEPTION 'sales_078_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'sales_078_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'sales_078_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'sales_078_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'sales_078_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 IF to_regprocedure('${copySignature}')IS DISTINCT FROM old_oid THEN RAISE EXCEPTION 'sales_078_original_function_identity_changed' USING ERRCODE='40001';END IF;
 ${rpcContract('after_rpc',oldSignature)}
 ${rpcContract('copy_contract',copySignature)}
 IF before_rpc IS DISTINCT FROM after_rpc OR (before_rpc-'acl')IS DISTINCT FROM(copy_contract-'acl') THEN RAISE EXCEPTION 'sales_078_original_contract_changed' USING ERRCODE='42501';END IF;
 ${functionInventory('after_functions','reviewed_oids')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'sales_078_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_sales_078_audit(result)VALUES(jsonb_build_object(
  'migration','078','applicator_version',1,'source_sha256',expected_078,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','share_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
  'table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),'public_rpc_contract_sha256',encode(sha256(convert_to(before_rpc::text,'UTF8')),'hex'),
  'table_security_unchanged',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_functions_unchanged',true,'original_body_and_identity_preserved',true,'public_rpc_contract_preserved',true,
  'reviewed_functions',4,'new_function_count',3,'new_service_only_rpcs',1,'new_private_helpers',1,'renamed_private_implementation',1,'new_tables',0,
  'checkpoint_reset',false,'native_mutation_performed',false,'capture_written',false,'worker_flag_changed',false,'commit_acknowledgement_required',true));
END
$apply_078$;
SELECT result AS sales_price_capture_apply_audit FROM pg_temp.brufap_sales_078_audit;
COMMIT;
`;
}
export async function prepareSalesPriceCaptureReadback(){
 const {previous,functions}=await reviewed();
 return `-- Readonly committed contract/data snapshot. Compare hashes with the separate apply audit.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
DO $readback_078$
DECLARE
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 names text[];object_name text;snapshot jsonb;rows_state jsonb:='{}';table_security jsonb;schema_security jsonb;default_privileges jsonb;other_functions jsonb;public_rpc jsonb;copy_contract jsonb;
 service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;
BEGIN
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL THEN RAISE EXCEPTION 'sales_078_roles_missing' USING ERRCODE='55000';END IF;
 ${contractChecks}
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) WHERE key<>'${oldSignature}' LOOP
  IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'sales_078_previous_contract_changed' USING ERRCODE='55000';END IF;
 END LOOP;
 ${rpcContract('public_rpc',oldSignature)}
 ${rpcContract('copy_contract',copySignature)}
 IF(public_rpc-'acl')IS DISTINCT FROM(copy_contract-'acl') THEN RAISE EXCEPTION 'sales_078_original_contract_changed' USING ERRCODE='42501';END IF;
 ${tableInventory('names')}
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${functionInventory('other_functions','reviewed_oids')}
 PERFORM set_config('brufap.sales_078_readback',jsonb_build_object('migration','078','source_sha256','${SOURCE_SHA256}','protected_table_count',cardinality(names),'rows',rows_state,
  'table_security_sha256',encode(sha256(convert_to(table_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schema_security::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(default_privileges::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),'public_rpc_contract_sha256',encode(sha256(convert_to(public_rpc::text,'UTF8')),'hex'),
  'function_contracts_valid',true,'reviewed_functions',4,'new_tables',0,'worker_flag_changed',false,'native_mutation_performed',false)::text,true);
END
$readback_078$;
SELECT current_setting('brufap.sales_078_readback')::jsonb AS sales_price_capture_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const sql=await prepareSalesPriceCaptureApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(sql)}));
}
