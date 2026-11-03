// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_HASHES=Object.freeze({'083':'f3a191050cf102f1a1f14d536e2180b7c5bd14d523b0f6af6c588e3e2f45841b'});
const hash=value=>createHash('sha256').update(value).digest('hex');
function definitions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(x=>x.trim().split(/\s+/));
 return[m[2]+'('+args.map(x=>x[1]).join(',')+')',{sha256:hash(m[6]),public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v',args:args.length?args.map(x=>x[0]):null,defaults:args.filter(x=>x.includes('default')).length,default_expression:({'erp_sales_history.observed':'false, 200','public.erp_origin_sales_history_list':'25, NULL::text, NULL::text'}[m[2]]??null)}];
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
 'internal_triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgisinternal AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.oid=t.tgconstraint AND k.connamespace=coalesce(to_regnamespace('erp_sales_history'),0::oid))))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE(nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage'))AND nspname<>'erp_sales_history';`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d WHERE d.defaclnamespace<>coalesce(to_regnamespace('erp_sales_history'),0::oid);`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const otherCatalog=target=>`SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relpersistence,c.reloptions,c.reltablespace,c.relam,c.relreplident,c.relrowsecurity,c.relforcerowsecurity)ORDER BY n.nspname,c.relname)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_sales_history'),
 'types',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'erp_sales_history')) INTO ${target};`;
const contractChecks=`FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
 function_oid:=to_regprocedure(r.key);
 IF function_oid IS NULL
  OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
  OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM(r.value->>'public')::boolean
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid AND NOT a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
   AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND (case when p.pronargs=0 then 'null'::jsonb else to_jsonb(p.proargnames)end)=r.value->'args'
   AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f' AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=(r.value->>'defaults')::integer AND pg_get_expr(p.proargdefaults,0) IS NOT DISTINCT FROM r.value->>'default_expression' AND p.proargmodes IS NULL
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
 THEN RAISE EXCEPTION 'sales_history_083_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;

const dependencies=[
 'erp_cutover.require_admin(uuid)','erp_cutover.sales_capture(origin_sync.raw_record)',
 'erp_cutover.purchase_binding(text,jsonb)','erp_documents.origin_import_binding(text,text)',
 'erp_documents.origin_import_id(jsonb)','origin_sync.validate_sales_price_capture(jsonb,jsonb)',
 'public.erp_fiscal_draft_status_list(uuid,text,text,uuid,integer,uuid)'
];
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),names={'083':'202610160083_origin_sales_history.sql'},sources={},added=[];
 for(const[k,file]of Object.entries(names)){
  const s=await readFile(new URL(file,root),'utf8');if(hash(s)!==SOURCE_HASHES[k]||!s.endsWith('commit;\n')||s.split('\nbegin;\n').length!==2||s.includes('$source_'+k+'$'))throw Error('SOURCE_'+k+'_NOT_REVIEWED');sources[k]=s;added.push(...definitions(s));
 }
 if(added.length!==14||new Set(added.map(([s])=>s)).size!==14||added.filter(([,m])=>m.public).length!==5||added.some(([,m])=>m.definer!==m.public||!['jsonb','trigger'].includes(m.returns)))throw Error('SALES_HISTORY_FUNCTION_INVENTORY');
 const prior=new Map();for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=82).sort())for(const entry of definitions(await readFile(new URL(file,root),'utf8')))prior.set(...entry);
 const previous=Object.fromEntries(dependencies.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));return{sources,functions:Object.fromEntries(added),previous};
}
const previousChecks=`FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'sales_history_083_previous_contract_changed' USING ERRCODE='55000';END IF;
END LOOP;`;
const sharedDecl=`names text[];current_names text[];object_name text;snapshot jsonb;service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'sales_history_083_roles_missing' USING ERRCODE='55000';END IF;`;

const expectedTables=Object.freeze({"command":{"columns":[["command_id","uuid",true,"","","",0],["actor","uuid",true,"","","",0],["request_hash","text",true,"","","",0],["history_id","text",true,"","","",0],["receipt","jsonb",true,"","","",0],["created_at","timestamp with time zone",true,"clock_timestamp()","","",0]],"indexes":{"command_pkey":["CREATE UNIQUE INDEX command_pkey ON erp_sales_history.command USING btree (command_id)",true,true,true,true,true,true,false,false],"command_history_id_key":["CREATE UNIQUE INDEX command_history_id_key ON erp_sales_history.command USING btree (history_id)",true,true,true,true,true,false,false,false]},"triggers":{"immutable_command":["CREATE TRIGGER immutable_command BEFORE DELETE OR UPDATE ON erp_sales_history.command FOR EACH ROW EXECUTE FUNCTION erp_sales_history.immutable()","O"]},"constraints":{"command_pkey":["p","PRIMARY KEY (command_id)",true,false,false],"command_actor_fkey":["f","FOREIGN KEY (actor) REFERENCES auth.users(id)",true,false,false],"command_receipt_check":["c","CHECK ((jsonb_typeof(receipt) = 'object'::text))",true,false,false],"command_history_id_key":["u","UNIQUE (history_id)",true,false,false],"command_history_id_fkey":["f","FOREIGN KEY (history_id) REFERENCES erp_sales_history.snapshot(history_id)",true,false,false],"command_request_hash_check":["c","CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))",true,false,false]}},"snapshot":{"columns":[["history_id","text",true,"('bsh_'::text || (gen_random_uuid())::text)","","",0],["source_id","text",true,"","","",0],["command_id","uuid",true,"","","",0],["snapshot_hash","text",true,"","","",0],["observation","jsonb",true,"","","",0],["captured_at","timestamp with time zone",true,"clock_timestamp()","","",0]],"indexes":{"snapshot_pkey":["CREATE UNIQUE INDEX snapshot_pkey ON erp_sales_history.snapshot USING btree (history_id)",true,true,true,true,true,true,false,false],"snapshot_source_id_key":["CREATE UNIQUE INDEX snapshot_source_id_key ON erp_sales_history.snapshot USING btree (source_id)",true,true,true,true,true,false,false,false],"snapshot_command_id_key":["CREATE UNIQUE INDEX snapshot_command_id_key ON erp_sales_history.snapshot USING btree (command_id)",true,true,true,true,true,false,false,false]},"triggers":{"immutable_snapshot":["CREATE TRIGGER immutable_snapshot BEFORE DELETE OR UPDATE ON erp_sales_history.snapshot FOR EACH ROW EXECUTE FUNCTION erp_sales_history.immutable()","O"]},"constraints":{"snapshot_pkey":["p","PRIMARY KEY (history_id)",true,false,false],"snapshot_check":["c","CHECK ((((observation ->> 'profile'::text) = 'origin-sales-history-observation-v1'::text) AND ((observation ->> 'source_id'::text) = source_id) AND (snapshot_hash = encode(sha256(convert_to((observation)::text, 'UTF8'::name)), 'hex'::text))))",true,false,false],"snapshot_source_id_key":["u","UNIQUE (source_id)",true,false,false],"snapshot_command_id_key":["u","UNIQUE (command_id)",true,false,false],"history_snapshot_command":["f","FOREIGN KEY (command_id) REFERENCES erp_sales_history.command(command_id) DEFERRABLE INITIALLY DEFERRED",true,true,true],"snapshot_source_id_check":["c","CHECK ((source_id ~ '^[1-9][0-9]{0,39}$'::text))",true,false,false],"snapshot_history_id_check":["c","CHECK ((history_id ~ '^bsh_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'::text))",true,false,false],"snapshot_observation_check":["c","CHECK (((jsonb_typeof(observation) = 'object'::text) AND (octet_length((observation)::text) <= 786432)))",true,false,false],"snapshot_snapshot_hash_check":["c","CHECK ((snapshot_hash ~ '^[a-f0-9]{64}$'::text))",true,false,false]}}});
const privateChecks=`
 IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='erp_sales_history'AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a WHERE n.nspname='erp_sales_history'AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl)a WHERE d.defaclnamespace='erp_sales_history'::regnamespace AND(a.grantee<>d.defaclrole OR d.defaclrole<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 THEN RAISE EXCEPTION 'sales_history_083_private_schema_failed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM erp_sales_history.snapshot)OR EXISTS(SELECT 1 FROM erp_sales_history.command)THEN RAISE EXCEPTION 'sales_history_083_new_tables_not_empty' USING ERRCODE='40001';END IF;
 FOREACH object_name IN ARRAY ARRAY['erp_sales_history.snapshot','erp_sales_history.command']LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.oid=object_name::regclass AND c.relkind='r'AND c.relpersistence='p'AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND c.reloptions IS NULL AND c.relreplident='d'AND c.reloftype=0 AND c.reltablespace=0 AND a.amname='heap'AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=object_name::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE a.attrelid=object_name::regclass AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=object_name::regclass)
  THEN RAISE EXCEPTION 'sales_history_083_private_table_failed' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=object_name::regclass AND a.attnum>0 AND(a.attisdropped OR a.attcollation<>t.typcollation OR a.attstorage<>t.typstorage))
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=object_name::regclass OR inhparent=object_name::regclass)
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE k.conrelid=object_name::regclass AND t.tgenabled<>'O')
  THEN RAISE EXCEPTION 'sales_history_083_table_contract_failed' USING ERRCODE='40001';END IF;
 END LOOP;
 SELECT jsonb_object_agg(c.relname,jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity,a.attgenerated,a.attndims)ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_object_agg(k.conname,jsonb_build_array(k.contype,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred))FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype<>'n'),
 'indexes',(SELECT jsonb_object_agg(x.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indimmediate,i.indisprimary,i.indisexclusion,i.indisreplident))FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_object_agg(t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled))FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO snapshot
 FROM pg_class c WHERE c.relnamespace='erp_sales_history'::regnamespace AND c.relkind='r';
 IF snapshot IS DISTINCT FROM '${JSON.stringify(expectedTables).replaceAll("'","''")}'::jsonb
 OR(SELECT jsonb_object_agg(relname,relkind)FROM pg_class WHERE relnamespace='erp_sales_history'::regnamespace)IS DISTINCT FROM '{"snapshot":"r","command":"r","snapshot_pkey":"i","snapshot_source_id_key":"i","snapshot_command_id_key":"i","command_pkey":"i","command_history_id_key":"i"}'::jsonb
 OR(SELECT jsonb_agg(typname ORDER BY typname)FROM pg_type WHERE typnamespace='erp_sales_history'::regnamespace)IS DISTINCT FROM '["_command","_snapshot","command","snapshot"]'::jsonb
 THEN RAISE EXCEPTION 'sales_history_083_table_contract_failed' USING ERRCODE='40001';END IF;`;
export async function prepareSalesHistoryApply(){
 const{sources,functions,previous}=await reviewed();
 return `--083 creates a separate empty commercial history and five service-only RPCs. No native or staging writes.
-- Embedded source SHA is distinct from the generated-script/manifest SHA.
-- Whole-script execution only; concurrent writer => NOWAIT refusal, never automatic retry.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_sales_history_083_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_083$
DECLARE
 source_083 text:=$source_083$${sources['083']}$source_083$;
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 required_tables constant text[]:=ARRAY['origin_sync.raw_record','erp_catalog.origin','erp_catalog.record','erp_catalog.source_snapshot','erp_access.membership','erp_documents.document','erp_stock.balance','erp_finance.title','auth.users','storage.buckets','storage.objects'];
 ${sharedDecl}
 source_body text;opening integer;source_text text;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_catalog jsonb;after_catalog jsonb;before_functions jsonb;after_functions jsonb;
BEGIN
 IF encode(sha256(convert_to(source_083,'UTF8')),'hex')IS DISTINCT FROM '${SOURCE_HASHES['083']}' THEN RAISE EXCEPTION 'sales_history_083_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF to_regnamespace('erp_sales_history')IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1))THEN RAISE EXCEPTION 'sales_history_083_already_present' USING ERRCODE='55000';END IF;
 ${roles}
 FOREACH object_name IN ARRAY required_tables LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'sales_history_083_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;
 ${tableInventory('names')}
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
 ${previousChecks}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${otherCatalog('before_catalog')}
 ${functionInventory('before_functions','ARRAY[]::oid[]')}
 FOREACH source_text IN ARRAY ARRAY[source_083]LOOP
  opening:=position(E'\\nbegin;\\n' IN source_text);IF right(source_text,8)IS DISTINCT FROM E'commit;\\n'OR opening=0 THEN RAISE EXCEPTION 'sales_history_083_transaction_wrapper_invalid' USING ERRCODE='22023';END IF;
  source_body:=overlay(left(source_text,length(source_text)-8)placing E'\\n'from opening for 8);
  EXECUTE source_body;
 END LOOP;
 -- reviewed functions created
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM(SELECT array_agg(x ORDER BY x COLLATE "C")FROM unnest(names||ARRAY['erp_sales_history.command','erp_sales_history.snapshot'])x)THEN RAISE EXCEPTION 'sales_history_083_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'sales_history_083_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'sales_history_083_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'sales_history_083_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'sales_history_083_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${otherCatalog('after_catalog')}
 IF before_catalog IS DISTINCT FROM after_catalog THEN RAISE EXCEPTION 'sales_history_083_other_catalog_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 ${privateChecks}
 ${functionInventory('after_functions','reviewed_oids')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'sales_history_083_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_sales_history_083_audit(result)VALUES(jsonb_build_object(
 'migrations',jsonb_build_array('083'),'applicator_version',1,'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'required_function_hashes',previous_functions,
 'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
 'table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),
 'table_security_unchanged',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_catalog_unchanged',true,'other_functions_unchanged',true,
 'new_service_only_rpcs',5,'new_private_helpers',9,'new_tables',2,'new_tables_empty',true,'worker_flag_changed',false,'native_mutation_performed',false,'commit_acknowledgement_required',true));
END $apply_083$;
SELECT result AS sales_history_apply_audit FROM pg_temp.brufap_sales_history_083_audit;
COMMIT;
`;
}
export async function prepareSalesHistoryReadback(){
 const{functions,previous}=await reviewed();
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_083$
DECLARE
 reviewed_functions constant jsonb:='${JSON.stringify(functions)}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 ${sharedDecl}
 rows_state jsonb:='{}';table_security jsonb;schema_security jsonb;default_privileges jsonb;other_functions jsonb;other_catalog jsonb;
BEGIN
 ${roles}
 ${previousChecks}
 ${contractChecks}
 ${privateChecks}
 ${tableInventory('names')}
 names:=array_remove(array_remove(names,'erp_sales_history.snapshot'),'erp_sales_history.command');
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${otherCatalog('other_catalog')}
 ${functionInventory('other_functions','reviewed_oids')}
 PERFORM set_config('brufap.sales_history_083_readback',jsonb_build_object('migrations',jsonb_build_array('083'),'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'protected_table_count',cardinality(names),'rows',rows_state,
 'table_security_sha256',encode(sha256(convert_to(table_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schema_security::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(default_privileges::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(other_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),
 'function_contracts_valid',true,'new_service_only_rpcs',5,'new_private_helpers',9,'new_tables',2,'new_tables_empty',true,'worker_flag_changed',false,'native_mutation_performed',false)::text,true);
END $readback_083$;
SELECT current_setting('brufap.sales_history_083_readback')::jsonb AS sales_history_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await prepareSalesHistoryApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_HASHES,script_sha256:hash(sql)}));
}
