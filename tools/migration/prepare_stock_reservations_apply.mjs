// Local preparation only. No database, HTTP, credentials or operational execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='8556d55092344a50b3a97de63f9e7ed3f955f05e0f8e7fbbd393eabb597962cd';
const hash=value=>createHash('sha256').update(value).digest('hex');
// Restricted to the reviewed scalar signatures / dollar-quoted bodies in these migrations.
function functions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(a=>a.trim().split(/\s+/)[1]);
 return [m[2]+'('+args.join(',')+')',{sha256:hash(m[6]),replace:!!m[1],public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v'}];
});}
export async function prepareStockReservationsApply(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160070_stock_reservations.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_070$'))throw Error('SOURCE_070_NOT_REVIEWED');
 const reviewed=functions(source);
 if(reviewed.length!==21||reviewed.filter(([,x])=>x.replace).length!==1||reviewed.filter(([,x])=>x.public&&!x.replace).length!==5||new Set(reviewed.map(([s])=>s)).size!==21)throw Error('SOURCE_070_FUNCTION_INVENTORY');
 const prior=new Map();
 for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=69).sort())for(const[s,m]of functions(await readFile(new URL(file,root),'utf8')))prior.set(s,m.sha256);
 const dependencies=[...reviewed.filter(([,m])=>m.replace).map(([s])=>s),'erp_stock.require_access(uuid,boolean)','erp_stock.immutable_ledger()','erp_stock.protect_product_unit()','erp_stock.document_lock(uuid,text,uuid,integer)','erp_stock.document_preview_data(erp_documents.document,date,text)','erp_stock.document_summary(uuid)','erp_documents.effects_transition_allowed(text,text,text)','public.erp_document_stock_post(uuid,text,uuid,integer,uuid,text,date,text,jsonb)','public.erp_document_stock_reverse(uuid,text,uuid,integer,uuid,integer,uuid,text,date,text)'];
 const previous=dependencies.map(signature=>{const h=prior.get(signature);if(!h)throw Error('DEPENDENCY_SOURCE_MISSING:'+signature);return[signature,h];});
 return `-- 070: explicit stock reservations; five service-only RPCs and three empty private tables. Prepared locally; remote execution is not authorized here.
-- Execute the complete script as the migration owner in one session. Require COMMIT acknowledgement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_apply_stock_070_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_070$
DECLARE
 source_070 text := $source_070$${source}$source_070$;
 expected_070 constant text := '${SOURCE_SHA256}';
 previous_functions constant jsonb := '${JSON.stringify(Object.fromEntries(previous))}'::jsonb;
 reviewed_functions constant jsonb := '${JSON.stringify(Object.fromEntries(reviewed))}'::jsonb;
 added_tables constant text[] := ARRAY['erp_stock.reservation','erp_stock.reservation_item','erp_stock.reservation_command'];
 added_table text;
 added_triggers constant jsonb := '{"erp_stock.balance/protect_reserved_balance":{"function":"erp_stock.guard_reserved_balance()","type":19},"erp_documents.document/protect_reserved_document":{"function":"erp_stock.guard_reserved_document()","type":27},"erp_documents.item/protect_reserved_item":{"function":"erp_stock.guard_reserved_item()","type":31},"erp_stock.document_posting/protect_reserved_posting":{"function":"erp_stock.guard_reserved_posting()","type":7}}'::jsonb;
 required_tables constant text[] := ARRAY['erp_access.membership','erp_catalog.record','erp_documents.document','erp_documents.item','erp_finance.account','erp_finance.title','erp_finance.settlement','erp_finance.movement','erp_finance.command','erp_cnab.profile','erp_cnab.remittance','erp_cnab.billing_title','erp_cnab.command','erp_cnab.audit','erp_cnab.operational_approval','erp_cnab.operational_approval_revision','erp_company.identity','erp_stock.balance','erp_stock.entry','erp_stock.movement','erp_stock.document_posting','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_subset_review.review','storage.buckets','storage.objects','auth.users'];
 names text[]; current_names text[]; object_name text; source_body text; opening integer;
 before_state jsonb:='{}'; after_state jsonb:='{}'; snapshot jsonb;
 before_security jsonb; after_security jsonb; before_schemas jsonb; after_schemas jsonb;
 before_functions jsonb; after_functions jsonb; before_changed_security jsonb; after_changed_security jsonb; before_defaults jsonb; after_defaults jsonb; service_oid oid; function_oid oid; reviewed_oids oid[]:=ARRAY[]::oid[]; changed_oids oid[]:=ARRAY[]::oid[]; r record; more boolean;
BEGIN
 -- No runtime lock namespace is changed. Existing table locks are acquired NOWAIT.
 IF encode(sha256(convert_to(source_070,'UTF8')),'hex') IS DISTINCT FROM expected_070 THEN RAISE EXCEPTION 'stock_070_source_hash_mismatch' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(added_tables)t WHERE to_regclass(t)IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1) WHERE NOT(f.value->>'replace')::boolean) THEN RAISE EXCEPTION 'stock_070_already_present' USING ERRCODE='55000'; END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'stock_070_roles_missing' USING ERRCODE='55000'; END IF;
 FOREACH object_name IN ARRAY required_tables LOOP
  IF to_regclass(object_name) IS NULL THEN RAISE EXCEPTION 'stock_070_prerequisite_missing' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r.key)) IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'stock_070_previous_contract_changed' USING ERRCODE='55000'; END IF;
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
  IF function_oid IS NULL THEN RAISE EXCEPTION 'stock_070_previous_contract_changed' USING ERRCODE='55000'; END IF;
  changed_oids:=array_append(changed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO before_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO before_defaults FROM pg_default_acl d;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO before_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(changed_oids);
 opening:=position(E'\\nbegin;\\n' IN source_070);
 IF right(source_070,8) IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'stock_070_transaction_wrapper_invalid' USING ERRCODE='22023'; END IF;
 source_body:=overlay(left(source_070,length(source_070)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO current_names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 IF current_names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(names||added_tables) x) THEN RAISE EXCEPTION 'stock_070_table_inventory_changed' USING ERRCODE='40001'; END IF;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  after_state:=after_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'stock_070_existing_data_changed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND NOT(added_triggers ? (format('%I.%I',n.nspname,c.relname)||'/'||t.tgname))))) INTO after_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'stock_070_table_security_changed' USING ERRCODE='42501'; END IF;
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO after_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'stock_070_schema_security_changed' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL
   OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
   OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM (r.value->>'public')::boolean
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid))
   OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
  THEN RAISE EXCEPTION 'stock_070_function_contract_failed' USING ERRCODE='42501'; END IF;
  reviewed_oids:=array_append(reviewed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO after_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 IF before_changed_security IS DISTINCT FROM after_changed_security THEN RAISE EXCEPTION 'stock_070_replaced_function_security_changed' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO after_defaults FROM pg_default_acl d;
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'stock_070_default_privileges_changed' USING ERRCODE='42501'; END IF;
 FOREACH added_table IN ARRAY added_tables LOOP
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM '||added_table||')' INTO more;
  IF more THEN RAISE EXCEPTION 'stock_070_new_table_not_empty' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(added_table) AND relrowsecurity AND NOT relforcerowsecurity AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass(added_table) AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(added_table))
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=to_regclass(added_table) AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  THEN RAISE EXCEPTION 'stock_070_private_table_failed' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(added_table) AND NOT convalidated)
   OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass(added_table) AND NOT tgisinternal)<>1
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(added_table) AND NOT tgisinternal AND tgtype=27 AND tgenabled='O' AND tgfoid=CASE WHEN added_table='erp_stock.reservation' THEN 'erp_stock.guard_reservation()'::regprocedure ELSE 'erp_stock.immutable_ledger()'::regprocedure END)
  THEN RAISE EXCEPTION 'stock_070_table_contract_failed' USING ERRCODE='40001'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='erp_stock.reservation'::regclass AND contype='f' AND confrelid='erp_stock.movement'::regclass AND condeferrable AND condeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid='erp_stock.reservation'::regclass AND indisunique AND pg_get_expr(indpred,indrelid)='(state = ''active''::text)')
 THEN RAISE EXCEPTION 'stock_070_consumption_contract_failed' USING ERRCODE='40001'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each(added_triggers) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(split_part(r.key,'/',1))AND tgname=split_part(r.key,'/',2)AND tgtype=(r.value->>'type')::integer AND tgenabled='O'AND NOT tgisinternal AND tgfoid=to_regprocedure(r.value->>'function')AND tgnargs=0 AND tgqual IS NULL)
  THEN RAISE EXCEPTION 'stock_070_guard_contract_failed' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO after_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(reviewed_oids);
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'stock_070_other_functions_changed' USING ERRCODE='40001'; END IF;
 INSERT INTO pg_temp.brufap_apply_stock_070_audit(result) VALUES(jsonb_build_object(
  'migration','070','applicator_version',1,'source_sha256',expected_070,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','share_row_exclusive_nowait','legacy_table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'replaced_function_security_sha256',encode(sha256(convert_to(before_changed_security::text,'UTF8')),'hex'),'before',before_state,'after',after_state,'before_equals_after',true,
  'table_security_unchanged',true,'schema_security_unchanged',true,'other_functions_unchanged',true,'replaced_function_security_unchanged',true,'default_privileges_unchanged',true,
  'new_service_only_rpcs',5,'new_private_helpers',15,'replaced_functions',cardinality(changed_oids),'reviewed_functions',cardinality(reviewed_oids),'new_tables',3,'new_table_empty',true,'new_table_rls',true,'new_table_owner_only',true,'operation_activated',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'reservations_created',0,'movements_created',0,'balances_initialized',0,'commit_acknowledgement_required',true));
END
$apply_070$;
SELECT result AS stock_reservations_apply_audit FROM pg_temp.brufap_apply_stock_070_audit;
COMMIT;
`;
}
/** Read-only commit readback; compares these hashes with the apply audit before enaorigin UI. */
export async function prepareStockReservationsReadback(){
 const sql=await prepareStockReservationsApply();
 const declaration=name=>{const m=sql.match(new RegExp(` ${name} constant [^;]+;`));if(!m)throw Error('READBACK_DECLARATION_MISSING');return m[0];};
 const block=(start,end)=>{const a=sql.indexOf(start),b=sql.indexOf(end,a);if(a<0||b<0)throw Error('READBACK_BLOCK_MISSING');return sql.slice(a,b);};
 const functionChecks=block(' FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP',' SELECT jsonb_object_agg(p.oid::text');
 const tableChecks=block(' FOREACH added_table IN ARRAY added_tables LOOP',' SELECT jsonb_object_agg(p.oid::regprocedure::text');
 const security=block(" SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls'",' SELECT jsonb_object_agg(nspname').replace('AND NOT t.tgisinternal))) INTO before_security',"AND NOT t.tgisinternal AND NOT(added_triggers ? (format('%I.%I',n.nspname,c.relname)||'/'||t.tgname))))) INTO before_security");
 const functions=block(' SELECT jsonb_object_agg(p.oid::regprocedure::text',' opening:=').replaceAll('p.oid<>ALL(changed_oids)','p.oid<>ALL(reviewed_oids)');
 return `BEGIN READ ONLY;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
DO $readback_070$
DECLARE
${declaration('reviewed_functions')}
${declaration('added_tables')}
${declaration('added_triggers')}
 names text[]; added_table text; object_name text; snapshot jsonb; state jsonb:='{}'; more boolean;
 before_security jsonb; before_schemas jsonb; before_defaults jsonb; before_functions jsonb; before_changed_security jsonb;
 service_oid oid; function_oid oid; reviewed_oids oid[]:=ARRAY[]::oid[]; r record;
BEGIN
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
${functionChecks}
${tableChecks}
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects')) AND format('%I.%I',n.nspname,c.relname)<>ALL(added_tables);
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fp$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fp$,object_name) INTO snapshot;
  state:=state||jsonb_build_object(object_name,snapshot);
 END LOOP;
${security}
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO before_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO before_defaults FROM pg_default_acl d;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO before_changed_security FROM pg_proc p WHERE p.oid='erp_stock.post(uuid,uuid,text,date,text,text,jsonb,uuid)'::regprocedure;
${functions}
 PERFORM set_config('brufap.stock_070_readback',jsonb_build_object('migration','070','source_sha256','${SOURCE_SHA256}','protected_table_count',cardinality(names),'legacy_rows',state,
 'legacy_table_security_sha256',encode(sha256(convert_to(before_security::text,'UTF8')),'hex'),'schema_security_sha256',encode(sha256(convert_to(before_schemas::text,'UTF8')),'hex'),'other_functions_sha256',encode(sha256(convert_to(before_functions::text,'UTF8')),'hex'),'default_privileges_sha256',encode(sha256(convert_to(before_defaults::text,'UTF8')),'hex'),'replaced_function_security_sha256',encode(sha256(convert_to(before_changed_security::text,'UTF8')),'hex'),
 'function_contracts_valid',true,'reviewed_functions',cardinality(reviewed_oids),'new_tables',3,'new_tables_empty',true,'new_tables_rls',true,'new_tables_owner_only',true,'guards_verified',7,'operation_activated',false)::text,true);
END
$readback_070$;
SELECT current_setting('brufap.stock_070_readback')::jsonb AS stock_reservations_commit_readback;
COMMIT;
`;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const text=await prepareStockReservationsApply(),file=await open(process.argv[2],'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(text)}));
}
