// Local preparation only. No HTTP, database connection, credentials or execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_HASHES=Object.freeze({'085':'f1e6415523bc171bd1de4ae357bec22be29c90aac442e2ea202a7bfbf5da39fe'});
const hash=value=>createHash('sha256').update(value).digest('hex');
function definitions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(x=>x.trim().split(/\s+/));
 return[m[2]+'('+args.map(x=>x[1]).join(',')+')',{sha256:hash(m[6]),public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v',args:args.length?args.map(x=>x[0]):null,defaults:args.filter(x=>x.includes('default')).length,default_expression:({'public.origin_sync_sales_price_candidates':'40','public.origin_sync_sales_price_fail':'NULL::integer'}[m[2]]??null)}];
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
 'internal_triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgisinternal AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.oid=t.tgconstraint AND k.connamespace=coalesce(to_regnamespace('origin_sales_price_refresh'),0::oid))))) INTO ${target}
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);`;
const schemaSecurity=target=>`SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO ${target} FROM pg_namespace WHERE(nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage'))AND nspname<>'origin_sales_price_refresh';`;
const defaults=target=>`SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO ${target} FROM pg_default_acl d WHERE d.defaclnamespace IS DISTINCT FROM to_regnamespace('origin_sales_price_refresh');`;
const functionInventory=(target,exclude)=>`SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO ${target}
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(${exclude});`;
const otherCatalog=target=>`SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relpersistence,c.reloptions,c.reltablespace,c.relam,c.relreplident,c.relrowsecurity,c.relforcerowsecurity)ORDER BY n.nspname,c.relname)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'origin_sales_price_refresh'),
 'types',(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.oid)FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))AND n.nspname<>'origin_sales_price_refresh')) INTO ${target};`;
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
 THEN RAISE EXCEPTION 'sales_price_refresh_085_function_contract_failed' USING ERRCODE='42501';END IF;
 reviewed_oids:=array_append(reviewed_oids,function_oid);
END LOOP;`;

const dependencies=[
 'erp_cutover.sales_capture(origin_sync.raw_record)',
 'origin_reference_fetch.exact_id(jsonb)',
 'origin_sync.validate_sales_price_capture(jsonb,jsonb)',
 'public.origin_sync_apply_sales_price_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)',
 'public.origin_sync_apply_batch(text,text,uuid,uuid,uuid,jsonb,jsonb,bigint)',
 'public.origin_sync_claim(text,uuid,integer)','public.origin_sync_renew(text,uuid,uuid,integer)','public.origin_sync_release(text,uuid,uuid)',
 'public.erp_origin_sales_history_capture(uuid,text,text,text,text,uuid)',
 'public.erp_itau_legacy_readiness(uuid,text,text,integer,text)'
];
async function reviewed(){
 const root=new URL('../../supabase/migrations/',import.meta.url),names={'085':'202610160085_origin_sales_price_refresh.sql'},sources={},added=[];
 for(const[k,file]of Object.entries(names)){
  const s=await readFile(new URL(file,root),'utf8');if(hash(s)!==SOURCE_HASHES[k]||!s.endsWith('commit;\n')||s.split('\nbegin;\n').length!==2||s.includes('$source_'+k+'$'))throw Error('SOURCE_'+k+'_NOT_REVIEWED');sources[k]=s;added.push(...definitions(s));
 }
 if(added.length!==10||new Set(added.map(([s])=>s)).size!==10||added.filter(([,m])=>m.public).length!==6||added.some(([sig,m])=>m.definer!==(m.public||sig==='origin_sales_price_refresh.require_leases(uuid,uuid,uuid)')||!['jsonb','trigger','boolean','void'].includes(m.returns)))throw Error('SALES_PRICE_REFRESH_FUNCTION_INVENTORY');
 const prior=new Map();for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=84).sort())for(const entry of definitions(await readFile(new URL(file,root),'utf8')))prior.set(...entry);
 const previous=Object.fromEntries(dependencies.map(s=>{if(!prior.has(s))throw Error('DEPENDENCY_SOURCE_MISSING:'+s);return[s,prior.get(s).sha256];}));return{sources,functions:Object.fromEntries(added),previous};
}
const previousChecks=`FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
 IF(SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')FROM pg_proc WHERE oid=to_regprocedure(r.key))IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'sales_price_refresh_085_previous_contract_changed' USING ERRCODE='55000';END IF;
END LOOP;`;
const sharedDecl=`names text[];current_names text[];object_name text;snapshot jsonb;service_oid oid;function_oid oid;reviewed_oids oid[]:=ARRAY[]::oid[];r record;`;
const roles=`SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated')THEN RAISE EXCEPTION 'sales_price_refresh_085_roles_missing' USING ERRCODE='55000';END IF;`;

const expectedTables=Object.freeze({"origin":{"columns":[["source_id","text",true,"","","",0],["current_attempt","uuid",false,"","","",0],["last_attempt_at","timestamp with time zone",false,"","","",0],["last_success_at","timestamp with time zone",false,"","","",0],["next_attempt_at","timestamp with time zone",false,"","","",0],["failures","integer",true,"0","","",0],["last_error","text",false,"","","",0]],"indexes":{"origin_pkey":["CREATE UNIQUE INDEX origin_pkey ON origin_sales_price_refresh.origin USING btree (source_id)",true,true,true,true,true,true,false,false]},"triggers":null,"constraints":{"origin_pkey":["p","PRIMARY KEY (source_id)",true,false,false],"origin_failures_check":["c","CHECK (((failures >= 0) AND (failures <= 1000000)))",true,false,false],"origin_source_id_check":["c","CHECK ((source_id ~ '^[1-9][0-9]{0,39}$'::text))",true,false,false],"origin_current_attempt_fkey":["f","FOREIGN KEY (current_attempt) REFERENCES origin_sales_price_refresh.attempt(id)",true,false,false]}},"attempt":{"columns":[["id","uuid",true,"","","",0],["source_id","text",true,"","","",0],["owner","uuid",true,"","","",0],["scheduler_fence","uuid",true,"","","",0],["resource_fence","uuid",true,"","","",0],["checkpoint","jsonb",true,"","","",0],["checkpoint_version","bigint",true,"","","",0],["source_hash","text",true,"","","",0],["source_version","bigint",true,"","","",0],["source_seen_at","timestamp with time zone",true,"","","",0],["document_links","jsonb",true,"","","",0],["source_updated_at","timestamp with time zone",false,"","","",0],["state","text",true,"'pending'::text","","",0],["started_at","timestamp with time zone",true,"clock_timestamp()","","",0],["finished_at","timestamp with time zone",false,"","","",0],["response_hash","text",false,"","","",0],["error_code","text",false,"","","",0],["http_status","integer",false,"","","",0]],"indexes":{"attempt_pkey":["CREATE UNIQUE INDEX attempt_pkey ON origin_sales_price_refresh.attempt USING btree (id)",true,true,true,true,true,true,false,false]},"triggers":{"sales_price_attempt_immutable":["CREATE TRIGGER sales_price_attempt_immutable BEFORE DELETE OR UPDATE ON origin_sales_price_refresh.attempt FOR EACH ROW EXECUTE FUNCTION origin_sales_price_refresh.immutable_attempt()","O"]},"constraints":{"attempt_pkey":["p","PRIMARY KEY (id)",true,false,false],"attempt_check":["c","CHECK (((state = 'pending'::text) = (finished_at IS NULL)))",true,false,false],"attempt_state_check":["c","CHECK ((state = ANY (ARRAY['pending'::text, 'stored'::text, 'conflict'::text, 'failed'::text, 'superseded'::text])))",true,false,false],"attempt_source_id_fkey":["f","FOREIGN KEY (source_id) REFERENCES origin_sales_price_refresh.origin(source_id)",true,false,false],"attempt_checkpoint_check":["c","CHECK ((jsonb_typeof(checkpoint) = 'object'::text))",true,false,false],"attempt_source_hash_check":["c","CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))",true,false,false],"attempt_document_links_check":["c","CHECK ((jsonb_typeof(document_links) = 'array'::text))",true,false,false],"attempt_source_version_check":["c","CHECK ((source_version > 0))",true,false,false],"attempt_checkpoint_version_check":["c","CHECK ((checkpoint_version >= 0))",true,false,false]}},"scope_state":{"columns":[["singleton","boolean",true,"true","","",0],["retry_after","timestamp with time zone",false,"","","",0]],"indexes":{"scope_state_pkey":["CREATE UNIQUE INDEX scope_state_pkey ON origin_sales_price_refresh.scope_state USING btree (singleton)",true,true,true,true,true,true,false,false]},"triggers":null,"constraints":{"scope_state_pkey":["p","PRIMARY KEY (singleton)",true,false,false],"scope_state_singleton_check":["c","CHECK (singleton)",true,false,false]}}});
const privateChecks=`
 IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='origin_sales_price_refresh'AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a WHERE n.nspname='origin_sales_price_refresh'AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl)a WHERE d.defaclnamespace='origin_sales_price_refresh'::regnamespace AND(a.grantee<>d.defaclrole OR d.defaclrole<>(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 THEN RAISE EXCEPTION 'sales_price_refresh_085_private_schema_failed' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM origin_sales_price_refresh.origin)OR EXISTS(SELECT 1 FROM origin_sales_price_refresh.attempt)OR(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]')FROM origin_sales_price_refresh.scope_state s)IS DISTINCT FROM '[{"singleton":true,"retry_after":null}]'::jsonb THEN RAISE EXCEPTION 'sales_price_refresh_085_new_table_seed_invalid' USING ERRCODE='40001';END IF;
 FOREACH object_name IN ARRAY ARRAY['origin_sales_price_refresh.origin','origin_sales_price_refresh.attempt','origin_sales_price_refresh.scope_state']LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.oid=object_name::regclass AND c.relkind='r'AND c.relpersistence='p'AND c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND c.reloptions IS NULL AND c.relreplident='d'AND c.reloftype=0 AND c.reltablespace=0 AND a.amname='heap'AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=object_name::regclass AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl)x WHERE a.attrelid=object_name::regclass AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=object_name::regclass)
  THEN RAISE EXCEPTION 'sales_price_refresh_085_private_table_failed' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=object_name::regclass AND a.attnum>0 AND(a.attisdropped OR a.attcollation<>t.typcollation OR a.attstorage<>t.typstorage))
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=object_name::regclass OR inhparent=object_name::regclass)
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE k.conrelid=object_name::regclass AND t.tgenabled<>'O')
  THEN RAISE EXCEPTION 'sales_price_refresh_085_table_contract_failed' USING ERRCODE='40001';END IF;
 END LOOP;
 SELECT jsonb_object_agg(c.relname,jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity,a.attgenerated,a.attndims)ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_object_agg(k.conname,jsonb_build_array(k.contype,pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred))FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype<>'n'),
 'indexes',(SELECT jsonb_object_agg(x.relname,jsonb_build_array(pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indimmediate,i.indisprimary,i.indisexclusion,i.indisreplident))FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid),
 'triggers',(SELECT jsonb_object_agg(t.tgname,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled))FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO snapshot
 FROM pg_class c WHERE c.relnamespace='origin_sales_price_refresh'::regnamespace AND c.relkind='r';
 IF snapshot IS DISTINCT FROM '${JSON.stringify(expectedTables).replaceAll("'","''")}'::jsonb
 OR(SELECT jsonb_object_agg(relname,relkind)FROM pg_class WHERE relnamespace='origin_sales_price_refresh'::regnamespace)IS DISTINCT FROM '{"origin":"r","attempt":"r","scope_state":"r","origin_pkey":"i","attempt_pkey":"i","scope_state_pkey":"i"}'::jsonb
 OR(SELECT jsonb_agg(typname ORDER BY typname)FROM pg_type WHERE typnamespace='origin_sales_price_refresh'::regnamespace)IS DISTINCT FROM '["_attempt","_origin","_scope_state","attempt","origin","scope_state"]'::jsonb
 THEN RAISE EXCEPTION 'sales_price_refresh_085_table_contract_failed' USING ERRCODE='40001';END IF;`;
export async function prepareSalesPriceRefreshApply(){
 const{sources,functions,previous}=await reviewed();
 return `--085 installs an inactive directed sales recapture queue. No native, staging or historical writes.
-- Embedded source SHA is distinct from the generated-script/manifest SHA.
-- Whole-script execution only; concurrent writer => NOWAIT refusal, never automatic retry.
BEGIN;
SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_sales_price_refresh_085_audit(result jsonb not null)ON COMMIT DROP;
DO $apply_085$
DECLARE
 source_085 text:=$source_085$${sources['085']}$source_085$;
 reviewed_functions constant jsonb:='${JSON.stringify(functions).replaceAll("'","''")}'::jsonb;
 previous_functions constant jsonb:='${JSON.stringify(previous)}'::jsonb;
 required_tables constant text[]:=ARRAY['origin_sync.raw_record','origin_sync.resource_state','origin_sync.batch_inbox','erp_sales_history.snapshot','erp_sales_history.command','erp_catalog.origin','erp_catalog.record','erp_catalog.source_snapshot','erp_access.membership','erp_documents.document','erp_stock.balance','erp_finance.title','auth.users','storage.buckets','storage.objects'];
 ${sharedDecl}
 source_body text;opening integer;source_text text;
 before_rows jsonb:='{}';after_rows jsonb:='{}';before_security jsonb;after_security jsonb;before_schemas jsonb;after_schemas jsonb;before_defaults jsonb;after_defaults jsonb;before_catalog jsonb;after_catalog jsonb;before_functions jsonb;after_functions jsonb;
BEGIN
 IF encode(sha256(convert_to(source_085,'UTF8')),'hex')IS DISTINCT FROM '${SOURCE_HASHES['085']}' THEN RAISE EXCEPTION 'sales_price_refresh_085_source_hash_mismatch' USING ERRCODE='22023';END IF;
 IF to_regnamespace('origin_sales_price_refresh')IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1))THEN RAISE EXCEPTION 'sales_price_refresh_085_already_present' USING ERRCODE='55000';END IF;
 ${roles}
 FOREACH object_name IN ARRAY required_tables LOOP IF to_regclass(object_name)IS NULL THEN RAISE EXCEPTION 'sales_price_refresh_085_prerequisite_missing' USING ERRCODE='55000';END IF;END LOOP;
 ${tableInventory('names')}
 FOREACH object_name IN ARRAY names LOOP EXECUTE 'LOCK TABLE '||object_name||' IN SHARE MODE NOWAIT';END LOOP;
 ${previousChecks}
 ${rowFingerprints('before_rows')}
 ${tableSecurity('before_security')}
 ${schemaSecurity('before_schemas')}
 ${defaults('before_defaults')}
 ${otherCatalog('before_catalog')}
 ${functionInventory('before_functions','ARRAY[]::oid[]')}
 FOREACH source_text IN ARRAY ARRAY[source_085]LOOP
  opening:=position(E'\\nbegin;\\n' IN source_text);IF right(source_text,8)IS DISTINCT FROM E'commit;\\n'OR opening=0 THEN RAISE EXCEPTION 'sales_price_refresh_085_transaction_wrapper_invalid' USING ERRCODE='22023';END IF;
  source_body:=overlay(left(source_text,length(source_text)-8)placing E'\\n'from opening for 8);
  EXECUTE source_body;
 END LOOP;
 -- reviewed functions created
 ${tableInventory('current_names')}
 IF current_names IS DISTINCT FROM(SELECT array_agg(x ORDER BY x COLLATE "C")FROM unnest(names||ARRAY['origin_sales_price_refresh.attempt','origin_sales_price_refresh.origin','origin_sales_price_refresh.scope_state'])x)THEN RAISE EXCEPTION 'sales_price_refresh_085_table_inventory_changed' USING ERRCODE='40001';END IF;
 ${rowFingerprints('after_rows')}
 IF before_rows IS DISTINCT FROM after_rows THEN RAISE EXCEPTION 'sales_price_refresh_085_existing_data_changed' USING ERRCODE='40001';END IF;
 ${tableSecurity('after_security')}
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'sales_price_refresh_085_table_security_changed' USING ERRCODE='42501';END IF;
 ${schemaSecurity('after_schemas')}
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'sales_price_refresh_085_schema_security_changed' USING ERRCODE='42501';END IF;
 ${defaults('after_defaults')}
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'sales_price_refresh_085_default_privileges_changed' USING ERRCODE='42501';END IF;
 ${otherCatalog('after_catalog')}
 IF before_catalog IS DISTINCT FROM after_catalog THEN RAISE EXCEPTION 'sales_price_refresh_085_other_catalog_changed' USING ERRCODE='42501';END IF;
 ${contractChecks}
 ${privateChecks}
 ${functionInventory('after_functions','reviewed_oids')}
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'sales_price_refresh_085_other_functions_changed' USING ERRCODE='40001';END IF;
 INSERT INTO pg_temp.brufap_sales_price_refresh_085_audit(result)VALUES(jsonb_build_object(
 'migrations',jsonb_build_array('085'),'applicator_version',1,'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'required_function_hashes',previous_functions,
 'protected_table_count',cardinality(names),'table_locks','share_nowait','before',before_rows,'after',after_rows,'before_equals_after',true,
 'table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(before_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),
 'table_security_unchanged',true,'schema_security_unchanged',true,'default_privileges_unchanged',true,'other_catalog_unchanged',true,'other_functions_unchanged',true,
 'new_service_only_rpcs',6,'new_private_helpers',4,'new_tables',3,'new_queue_empty',true,'new_scope_seed_count',1,'worker_flag_changed',false,'native_mutation_performed',false,'commit_acknowledgement_required',true));
END $apply_085$;
SELECT result AS sales_price_refresh_apply_audit FROM pg_temp.brufap_sales_price_refresh_085_audit;
COMMIT;
`;
}
export async function prepareSalesPriceRefreshReadback(){
 const{functions,previous}=await reviewed();
 return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';
DO $readback_085$
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
 names:=array_remove(array_remove(array_remove(names,'origin_sales_price_refresh.origin'),'origin_sales_price_refresh.attempt'),'origin_sales_price_refresh.scope_state');
 ${rowFingerprints('rows_state')}
 ${tableSecurity('table_security')}
 ${schemaSecurity('schema_security')}
 ${defaults('default_privileges')}
 ${otherCatalog('other_catalog')}
 ${functionInventory('other_functions','reviewed_oids')}
 PERFORM set_config('brufap.sales_price_refresh_085_readback',jsonb_build_object('migrations',jsonb_build_array('085'),'source_sha256','${JSON.stringify(SOURCE_HASHES)}'::jsonb,'protected_table_count',cardinality(names),'rows',rows_state,
 'table_security_sha256',encode(sha256(convert_to(table_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(schema_security::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(default_privileges::text,'UTF8')),'hex'),'other_catalog_sha256',encode(sha256(convert_to(other_catalog::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(other_functions::text,'UTF8')),'hex'),
 'function_contracts_valid',true,'new_service_only_rpcs',6,'new_private_helpers',4,'new_tables',3,'new_queue_empty',true,'new_scope_seed_count',1,'worker_flag_changed',false,'native_mutation_performed',false)::text,true);
END $readback_085$;
SELECT current_setting('brufap.sales_price_refresh_085_readback')::jsonb AS sales_price_refresh_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');const sql=await prepareSalesPriceRefreshApply(),file=await open(process.argv[2],'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_HASHES,script_sha256:hash(sql)}));
}
