// Local SQL preparation only. Never connects or executes against a database.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {PURCHASE_RECEIPTS_TABLE_CONTRACT_SQL} from './helpers/purchase-receipts-apply-contract.mjs';
export const SOURCE_HASHES=Object.freeze({'090':'37f5cac3bab4beac61aa1adb9583c799d2c35d12850bf192e49ecf2e7469bc4a'});
export const EXPECTED_CATALOG_SHA256='69e862d7e5a054ef144ed6792e65949c34c9842ca2a50d815c41c3b4732c865b';
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb";
const catalogText=await readFile(new URL('./helpers/purchase-receipts-090-catalog.json',import.meta.url),'utf8');
if(hash(catalogText)!==EXPECTED_CATALOG_SHA256)throw Error('PURCHASE_RECEIPTS_CATALOG_NOT_REVIEWED');
const expected=JSON.parse(catalogText);
const changed=['erp_documents.effect_flags(uuid)','public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)'];
const newTables=['command','receipt','reversal'].map(n=>'erp_purchase_receipts.'+n);
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=89).sort();
 if(files.length!==89||files.some((n,i)=>+n.slice(9,12)!==i+1)||JSON.stringify(files)!==JSON.stringify(Object.keys(expected.migrations)))throw Error('BASELINE_001_089_REQUIRED');
 for(const file of files)if(hash(await readFile(new URL(file,root)))!==expected.migrations[file])throw Error('BASELINE_SOURCE_NOT_REVIEWED:'+file);
 const source=await readFile(new URL('202610160090_purchase_receipts.sql',root),'utf8');
 if(hash(source)!==SOURCE_HASHES['090']||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_090$'))throw Error('SOURCE_090_NOT_REVIEWED');
 return source;
}
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
 'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND (t.tgrelid::regclass::text,t.tgname) NOT IN(('erp_documents.document','protect_purchase_receipt_document'),('erp_documents.item','protect_purchase_receipt_item'),('erp_stock.document_posting','protect_purchase_receipt_legacy'))),
 'internal_triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgisinternal AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.oid=t.tgconstraint AND k.connamespace=coalesce(to_regnamespace('erp_purchase_receipts'),0::oid))))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE(nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage'))AND nspname<>'erp_purchase_receipts';`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d WHERE d.defaclnamespace IS DISTINCT FROM to_regnamespace('erp_purchase_receipts');`;
const functionInventory=target=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to((CASE WHEN p.oid=ANY(ARRAY['erp_documents.effect_flags(uuid)'::regprocedure,'public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)'::regprocedure]) THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND n.nspname<>'erp_purchase_receipts' AND NOT(n.nspname='public'AND p.proname LIKE 'erp_purchase_receipts_%');`;
const otherCatalog=target=>`SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relpersistence,c.reloptions,c.reltablespace,c.relam,c.relreplident,c.relrowsecurity,c.relforcerowsecurity)ORDER BY n.nspname,c.relname)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_purchase_receipts'),
 'types',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_purchase_receipts')) INTO ${target};`;
const sharedDecl=`names text[];current_names text[];object_name text;snapshot jsonb;function_oid oid;service_oid oid;r record;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'purchase_receipts_090_roles_missing' USING ERRCODE='55000';END IF;`;
const previousChecks=(after=false)=>`FOR r IN SELECT key,value FROM jsonb_each_text(${quote(expected.previous)}) ${after?`WHERE key NOT IN(${changed.map(n=>"'"+n+"'").join(',')})`:''} LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'purchase_receipts_090_previous_contract_changed' USING ERRCODE='55000';END IF;
END LOOP;`;
const prerequisiteChecks=`FOREACH object_name IN ARRAY ARRAY[${expected.tables.map(n=>"'"+n+"'").join(',')}] LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'purchase_receipts_090_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(${quote(expected.functions)}) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=function_oid AND pg_get_functiondef(p.oid)=r.value->>'definition' AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=r.value->>'language'
 AND (to_jsonb(p)-ARRAY['oid','pronamespace','proowner','prorettype','proargtypes','proacl','prosrc','proargdefaults','prolang'])=r.value->'attributes')
 THEN RAISE EXCEPTION 'purchase_receipts_090_function_contract_failed' USING ERRCODE='42501',DETAIL=r.key;END IF;
 IF r.key NOT IN(${changed.map(n=>"'"+n+"'").join(',')})AND(
 NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=function_oid AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
 OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM starts_with(r.key,'public.')
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=function_oid AND a.grantee<>p.proowner AND NOT(starts_with(r.key,'public.')AND a.grantee=service_oid AND NOT a.is_grantable)))
 THEN RAISE EXCEPTION 'purchase_receipts_090_function_acl_failed' USING ERRCODE='42501';END IF;
END LOOP;
IF(SELECT count(*)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='erp_purchase_receipts'OR n.nspname='public'AND p.proname LIKE 'erp_purchase_receipts_%')<>19
THEN RAISE EXCEPTION 'purchase_receipts_090_function_inventory_changed' USING ERRCODE='40001';END IF;`;
const privateChecks=`
IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='erp_purchase_receipts'AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a WHERE n.nspname='erp_purchase_receipts'AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl)a WHERE d.defaclnamespace='erp_purchase_receipts'::regnamespace AND(a.grantee<>d.defaclrole OR d.defaclrole<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
THEN RAISE EXCEPTION 'purchase_receipts_090_private_schema_failed' USING ERRCODE='42501';END IF;
IF EXISTS(SELECT 1 FROM erp_purchase_receipts.receipt)OR EXISTS(SELECT 1 FROM erp_purchase_receipts.reversal)OR EXISTS(SELECT 1 FROM erp_purchase_receipts.command)
THEN RAISE EXCEPTION 'purchase_receipts_090_new_tables_not_empty' USING ERRCODE='40001';END IF;
FOREACH object_name IN ARRAY ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.oid=object_name::regclass AND c.relkind='r'AND c.relpersistence='p'AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND c.reloptions IS NULL AND c.relreplident='d'AND c.reloftype=0 AND c.reltablespace=0 AND a.amname='heap'AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=object_name::regclass AND a.grantee<>c.relowner)
 OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE a.attrelid=object_name::regclass AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
 OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=object_name::regclass)
 THEN RAISE EXCEPTION 'purchase_receipts_090_private_table_failed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=object_name::regclass AND a.attnum>0 AND(a.attisdropped OR a.attcollation<>t.typcollation OR a.attstorage<>t.typstorage))
 OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=object_name::regclass OR inhparent=object_name::regclass)
 THEN RAISE EXCEPTION 'purchase_receipts_090_table_contract_failed' USING ERRCODE='40001';END IF;
END LOOP;
${PURCHASE_RECEIPTS_TABLE_CONTRACT_SQL.replace(' AS contract',' INTO snapshot')};
IF snapshot IS DISTINCT FROM ${quote(expected.catalog)} THEN RAISE EXCEPTION 'purchase_receipts_090_table_contract_failed' USING ERRCODE='40001';END IF;`;
const digest=v=>`encode(sha256(convert_to(${v}::text,'UTF8')),'hex')`;
const auditFields=`'migrations',jsonb_build_array('090'),'applicator_version',1,'baseline','001-089','source_sha256',${quote(SOURCE_HASHES)},'catalog_contract_sha256','${EXPECTED_CATALOG_SHA256}',
'protected_table_count',cardinality(names),'new_service_only_rpcs',6,'new_private_helpers',13,'new_tables',3,'new_tables_empty',true,'new_triggers',6,'redefined_functions',${quote(changed)},'commit_acknowledgement_required',true`;
export async function preparePurchaseReceiptsApply(){
 const source=await reviewed();
 return `--090 installs native purchase receipts only. No receipt, physical/financial/fiscal mutation or remote execution.
--Execute the whole script; a concurrent writer refuses NOWAIT without automatic retry.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_purchase_receipts_090_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_090$
DECLARE
 source_090 text:=$source_090$${source}$source_090$;
 ${sharedDecl}
 source_body text;opening integer;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_catalog jsonb;after_catalog jsonb;before_functions jsonb;after_functions jsonb;
BEGIN
 IF ${digest('source_090')} IS DISTINCT FROM '${SOURCE_HASHES['090']}' THEN RAISE EXCEPTION 'purchase_receipts_090_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF to_regnamespace('erp_purchase_receipts')IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'AND p.proname LIKE 'erp_purchase_receipts_%')
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgname IN('protect_purchase_receipt_document','protect_purchase_receipt_item','protect_purchase_receipt_legacy'))
 THEN RAISE EXCEPTION 'purchase_receipts_090_already_present' USING ERRCODE='55000';END IF;
 ${roles}
 ${prerequisiteChecks}
 ${tableInventory('names')}
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
 ${previousChecks()}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${otherCatalog('before_catalog')}
 ${functionInventory('before_functions')}
 opening:=position(E'\\nbegin;\\n' IN source_090);
 source_body:=overlay(left(source_090,length(source_090)-8)placing E'\\n'from opening for 8);
 EXECUTE source_body;
 -- reviewed functions created
 SET CONSTRAINTS ALL IMMEDIATE;
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM(SELECT array_agg(x ORDER BY x COLLATE "C")FROM unnest(names||ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}])x)THEN RAISE EXCEPTION 'purchase_receipts_090_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'purchase_receipts_090_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'purchase_receipts_090_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'purchase_receipts_090_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'purchase_receipts_090_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${otherCatalog('after_catalog')}
 IF before_catalog IS DISTINCT FROM after_catalog THEN RAISE EXCEPTION 'purchase_receipts_090_other_catalog_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 ${privateChecks}
 ${functionInventory('after_functions')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'purchase_receipts_090_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_purchase_receipts_090_audit VALUES(jsonb_build_object(${auditFields},
 'table_locks','share_row_exclusive_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
 'table_security_sha256',${digest('before_security')},'schema_security_sha256',${digest('before_schemas')},'default_privileges_sha256',${digest('before_defaults')},'other_catalog_sha256',${digest('before_catalog')},'other_functions_sha256',${digest('before_functions')},
 'table_security_unchanged',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_catalog_unchanged',true,'other_functions_unchanged',true));
END $apply_090$;
SELECT result AS purchase_receipts_apply_audit FROM pg_temp.brufap_purchase_receipts_090_audit;
COMMIT;
`;
}
export async function preparePurchaseReceiptsReadback(){
 await reviewed();
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_090$
DECLARE ${sharedDecl}
 rows_state jsonb:='{}';table_security jsonb;schema_security jsonb;default_privileges jsonb;other_functions jsonb;other_catalog jsonb;
BEGIN
 ${roles}
 ${prerequisiteChecks}
 ${previousChecks(true)}
 ${contractChecks}
 ${privateChecks}
 ${tableInventory('names')}
 names:=array(SELECT unnest(names)EXCEPT SELECT unnest(ARRAY[${newTables.map(n=>"'"+n+"'").join(',')}]));
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${otherCatalog('other_catalog')}
 ${functionInventory('other_functions')}
 PERFORM set_config('brufap.purchase_receipts_090_readback',jsonb_build_object(${auditFields},'rows',rows_state,
 'table_security_sha256',${digest('table_security')},'schema_security_sha256',${digest('schema_security')},'default_privileges_sha256',${digest('default_privileges')},'other_catalog_sha256',${digest('other_catalog')},'other_functions_sha256',${digest('other_functions')},'function_contracts_valid',true)::text,true);
END $readback_090$;
SELECT current_setting('brufap.purchase_receipts_090_readback')::jsonb AS purchase_receipts_commit_readback;
COMMIT;
`;
}
// Neither the pre-COMMIT audit nor a readback alone establishes an acknowledged commit.
export function verifyPurchaseReceiptsCommit({audit,readback,commitAcknowledged}){
 const equal=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
 function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
 const required={migrations:['090'],baseline:'001-089',applicator_version:1,source_sha256:SOURCE_HASHES,catalog_contract_sha256:EXPECTED_CATALOG_SHA256,new_service_only_rpcs:6,new_private_helpers:13,new_tables:3,new_tables_empty:true,new_triggers:6,redefined_functions:changed,commit_acknowledgement_required:true};
 if(commitAcknowledged!==true||!audit||!readback||Object.entries(required).some(([k,v])=>!equal(audit[k],v)||!equal(readback[k],v))
  ||audit.before_equals_after!==true||readback.function_contracts_valid!==true||!equal(audit.before,audit.after)||!equal(audit.after,readback.rows)
  ||!Number.isInteger(audit.protected_table_count)||audit.protected_table_count<164||audit.protected_table_count!==readback.protected_table_count
  ||!audit.after||Object.keys(audit.after).length!==audit.protected_table_count||expected.tables.some(n=>!Object.hasOwn(audit.after,n)))throw Error('PURCHASE_RECEIPTS_COMMIT_NOT_CONFIRMED');
 for(const field of ['table_security','schema_security','default_privileges','other_catalog','other_functions'])if(audit[field+'_unchanged']!==true||!(/^[a-f0-9]{64}$/).test(audit[field+'_sha256'])||audit[field+'_sha256']!==readback[field+'_sha256'])throw Error('PURCHASE_RECEIPTS_COMMIT_NOT_CONFIRMED');
 return Object.freeze({confirmed:true,migrations:Object.freeze(['090']),protected_table_count:audit.protected_table_count});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await preparePurchaseReceiptsApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_HASHES,script_sha256:hash(sql)}));
}
