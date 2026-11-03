// Local preparation only. No database, HTTP, credentials or operational execution.
import {readFile,readdir,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SOURCE_SHA256='26b9810328ab24a7e3590ac7ea03c91723331dae55ecb63a9cd4460b18caa7d3';
// Frozen069 source; catalog definitions independently captured from a disposable001–069 database.
const CATALOG = {"old_policy_constraint":"CHECK (((NOT enabled) OR (origin = 'synthetic'::text) OR (binding_reviewed AND tax_rules_reviewed)))","policy_constraints":{"reviewed_policy_authority_check":"CHECK ((((authorization_profile = 'legacy_v1'::text) AND ((NOT enabled) OR (origin = 'synthetic'::text) OR (binding_reviewed AND tax_rules_reviewed))) OR ((authorization_profile = 'reviewed_subset_v1'::text) AND (NOT tax_rules_reviewed) AND ((NOT enabled) OR (origin = 'synthetic'::text) OR binding_reviewed))))","policy_authorization_profile_check":"CHECK ((authorization_profile = ANY (ARRAY['legacy_v1'::text, 'reviewed_subset_v1'::text])))"},"triggers":{"erp_fiscal_authorization.attempt/reviewed_use_guard":"CREATE TRIGGER reviewed_use_guard BEFORE UPDATE ON erp_fiscal_authorization.attempt FOR EACH ROW WHEN (((new.state = 'dispatched'::text) AND (old.state IS DISTINCT FROM new.state))) EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_stage()","erp_fiscal_authorization.attempt/reviewed_use_commit":"CREATE CONSTRAINT TRIGGER reviewed_use_commit AFTER UPDATE ON erp_fiscal_authorization.attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.state = 'dispatched'::text) AND (old.state IS DISTINCT FROM new.state))) EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_stage()","erp_fiscal_authorization.result/reviewed_result_guard":"CREATE TRIGGER reviewed_result_guard BEFORE INSERT ON erp_fiscal_authorization.result FOR EACH ROW EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_stage()","erp_fiscal_authorization.request/reviewed_request_guard":"CREATE TRIGGER reviewed_request_guard BEFORE INSERT ON erp_fiscal_authorization.request FOR EACH ROW EXECUTE FUNCTION erp_fiscal_reviewed_authorization.guard_stage()"},"tables":{"erp_fiscal_reviewed_authorization.review_binding":{"columns":[{"name":"attempt_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"name":"review_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"name":"proof","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"name":"schema_evidence","type":"jsonb","default":null,"identity":"","not_null":true,"generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"generated":""}],"triggers":{"immutable":"CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON erp_fiscal_reviewed_authorization.review_binding FOR EACH ROW EXECUTE FUNCTION erp_fiscal_authorization.immutable()"},"constraints":{"review_binding_pkey":"PRIMARY KEY (attempt_id)","review_binding_review_id_fkey":"FOREIGN KEY (review_id) REFERENCES erp_fiscal_subset_review.review(id)","review_binding_attempt_id_fkey":"FOREIGN KEY (attempt_id) REFERENCES erp_fiscal_authorization.attempt(id)"}},"erp_fiscal_reviewed_authorization.observation":{"columns":[{"name":"attempt_id","type":"uuid","default":null,"identity":"","not_null":true,"generated":""},{"name":"sha256","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"size_bytes","type":"integer","default":null,"identity":"","not_null":true,"generated":""},{"name":"origin","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"request_hash","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"response_hash","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"review_hash","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"finalize_hash","type":"text","default":null,"identity":"","not_null":true,"generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","identity":"","not_null":true,"generated":""}],"triggers":{"immutable":"CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON erp_fiscal_reviewed_authorization.observation FOR EACH ROW EXECUTE FUNCTION erp_fiscal_authorization.immutable()"},"constraints":{"observation_pkey":"PRIMARY KEY (attempt_id)","observation_origin_check":"CHECK ((origin = ANY (ARRAY['synthetic'::text, 'operational'::text])))","observation_sha256_check":"CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text))","observation_attempt_id_fkey":"FOREIGN KEY (attempt_id) REFERENCES erp_fiscal_reviewed_authorization.review_binding(attempt_id)","observation_size_bytes_check":"CHECK (((size_bytes >= 1) AND (size_bytes <= 8192)))","observation_review_hash_check":"CHECK ((review_hash ~ '^[a-f0-9]{64}$'::text))","observation_request_hash_check":"CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))","observation_finalize_hash_check":"CHECK ((finalize_hash ~ '^[a-f0-9]{64}$'::text))","observation_response_hash_check":"CHECK ((response_hash ~ '^[a-f0-9]{64}$'::text))"}}}};
const hash=value=>createHash('sha256').update(value).digest('hex');
// Restricted to the reviewed scalar signatures / dollar-quoted bodies in these migrations.
function functions(source){return [...source.matchAll(/create( or replace)? function ([a-z0-9_.]+)\(([^)]*)\)\s*returns ([a-z0-9_.]+)([\s\S]*?)as \$\$([\s\S]*?)\$\$;/g)].map(m=>{
 const args=m[3].split(',').filter(Boolean).map(a=>a.trim().split(/\s+/)[1]);
 return [m[2]+'('+args.join(',')+')',{sha256:hash(m[6]),replace:!!m[1],public:m[2].startsWith('public.'),definer:/\bsecurity definer\b/.test(m[5]),returns:m[4],language:m[5].match(/language (sql|plpgsql)/)?.[1],volatility:/\bimmutable\b/.test(m[5])?'i':/\bstable\b/.test(m[5])?'s':'v'}];
});}
export async function prepareReviewedAuthorizationApply(){
 const root=new URL('../../supabase/migrations/',import.meta.url),source=await readFile(new URL('202610160069_fiscal_reviewed_authorization.sql',root),'utf8');
 if(hash(source)!==SOURCE_SHA256||!source.endsWith('commit;\n')||source.split('\nbegin;\n').length!==2||source.includes('$source_069$'))throw Error('SOURCE_069_NOT_REVIEWED');
 const reviewed=functions(source);
 if(reviewed.length!==17||reviewed.filter(([,x])=>x.replace).length!==3||reviewed.filter(([,x])=>x.public&&!x.replace).length!==7||new Set(reviewed.map(([s])=>s)).size!==17)throw Error('SOURCE_069_FUNCTION_INVENTORY');
 const prior=new Map();
 for(const file of(await readdir(root)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=68).sort())for(const[s,m]of functions(await readFile(new URL(file,root),'utf8')))prior.set(s,m.sha256);
 const dependencies=[...reviewed.filter(([,m])=>m.replace).map(([s])=>s),
  'erp_fiscal_authorization.lock_source(uuid,uuid,boolean)','erp_fiscal_authorization.lock_attempt(uuid,uuid,uuid,boolean)',
  'erp_fiscal_authorization.source(uuid,uuid,text)','erp_fiscal_authorization.context(erp_fiscal_authorization.attempt)',
  'erp_fiscal_authorization.view(erp_fiscal_authorization.attempt)','erp_fiscal_authorization.storage_check(uuid,text,text,integer)',
  'erp_fiscal_authorization.result_state(erp_fiscal_authorization.attempt,jsonb,text,text)',
  'erp_fiscal_subset_review.profile()','erp_fiscal_subset_review.profile_hash()',
  ...['begin','prepare','use','finish','fail','command','history'].flatMap(name=>[...prior.keys()].filter(s=>s.startsWith('public.erp_fiscal_authorization_'+name+'(')))];
 const previous=dependencies.map(signature=>{const h=prior.get(signature);if(!h)throw Error('DEPENDENCY_SOURCE_MISSING:'+signature);return[signature,h];});
 return `-- 069: reviewed-subset ledger; seven service-only RPCs, two empty private tables, disabled policy seeds. Prepared locally; remote execution is not authorized here.
-- Execute the complete script as the migration owner in one session. Require COMMIT acknowledgement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
CREATE TEMP TABLE brufap_apply_reviewed_069_audit(result jsonb not null) ON COMMIT DROP;
DO $apply_069$
DECLARE
 source_069 text := $source_069$${source}$source_069$;
 expected_069 constant text := '${SOURCE_SHA256}';
 previous_functions constant jsonb := '${JSON.stringify(Object.fromEntries(previous))}'::jsonb;
 reviewed_functions constant jsonb := '${JSON.stringify(Object.fromEntries(reviewed))}'::jsonb;
 added_tables constant text[] := ARRAY['erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_reviewed_authorization.observation'];
 catalog_contract constant jsonb := '${JSON.stringify(CATALOG).replaceAll("'","''")}'::jsonb;
 policy_keys jsonb; policy_max jsonb; policy_seeds jsonb; new_policy_rows jsonb; policy_started timestamptz;
 before_policy_full jsonb; after_policy_full jsonb;
 required_tables constant text[] := ARRAY['erp_access.membership','erp_catalog.record','erp_documents.document','erp_documents.item','erp_finance.account','erp_finance.title','erp_finance.settlement','erp_finance.movement','erp_finance.command','erp_cnab.profile','erp_cnab.remittance','erp_cnab.billing_title','erp_cnab.command','erp_cnab.audit','erp_cnab.operational_approval','erp_cnab.operational_approval_revision','erp_fiscal_authorization.policy','erp_fiscal_authorization.attempt','erp_fiscal_authorization.request','erp_fiscal_authorization.result','erp_fiscal_subset_review.review','erp_fiscal_signed.artifact','erp_company.identity','storage.buckets','storage.objects','auth.users'];
 names text[]; current_names text[]; object_name text; source_body text; opening integer;
 before_state jsonb:='{}'; after_state jsonb:='{}'; snapshot jsonb;
 before_security jsonb; after_security jsonb; before_schemas jsonb; after_schemas jsonb;
 before_functions jsonb; after_functions jsonb; before_changed_security jsonb; after_changed_security jsonb; before_defaults jsonb; after_defaults jsonb; service_oid oid; function_oid oid; reviewed_oids oid[]:=ARRAY[]::oid[]; changed_oids oid[]:=ARRAY[]::oid[]; r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('brufap-apply-reviewed-069-v1',0));
 IF encode(sha256(convert_to(source_069,'UTF8')),'hex') IS DISTINCT FROM expected_069 THEN RAISE EXCEPTION 'reviewed_069_source_hash_mismatch' USING ERRCODE='22023'; END IF;
 IF to_regnamespace('erp_fiscal_reviewed_authorization') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='erp_fiscal_authorization.policy'::regclass AND attname='authorization_profile' AND NOT attisdropped) OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN jsonb_each(reviewed_functions) f ON n.nspname||'.'||p.proname=split_part(f.key,'(',1) WHERE NOT(f.value->>'replace')::boolean) THEN RAISE EXCEPTION 'reviewed_069_already_present' USING ERRCODE='55000'; END IF;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF service_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN RAISE EXCEPTION 'reviewed_069_roles_missing' USING ERRCODE='55000'; END IF;
 FOREACH object_name IN ARRAY required_tables LOOP
  IF to_regclass(object_name) IS NULL THEN RAISE EXCEPTION 'reviewed_069_prerequisite_missing' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text(previous_functions) LOOP
  IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure(r.key)) IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'reviewed_069_previous_contract_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 -- The new FK requires a parent-table lock. Acquire its stronger mode upfront:
 -- no SHARE-to-FK upgrade; refuse concurrent writers instead of waiting.
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE 'LOCK TABLE '||object_name||CASE WHEN object_name='erp_fiscal_authorization.policy' THEN ' IN ACCESS EXCLUSIVE MODE NOWAIT' ELSE ' IN SHARE ROW EXCLUSIVE MODE NOWAIT' END;
 END LOOP;
 IF EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy WHERE enabled) THEN RAISE EXCEPTION 'reviewed_069_active_policy_preflight_refused' USING ERRCODE='55000'; END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='erp_fiscal_authorization.policy'::regclass AND conname='policy_check3') IS DISTINCT FROM catalog_contract->>'old_policy_constraint' THEN RAISE EXCEPTION 'reviewed_069_previous_policy_constraint_changed' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('model',model,'version',version) ORDER BY model,version) INTO policy_keys FROM erp_fiscal_authorization.policy;
 SELECT jsonb_object_agg(model,version) INTO policy_max FROM(SELECT model,max(version)version FROM erp_fiscal_authorization.policy GROUP BY model)p;
 IF NOT(policy_max ?& ARRAY['55','65']) OR EXISTS(SELECT 1 FROM jsonb_each_text(policy_max) WHERE value::bigint>=2147483647) THEN RAISE EXCEPTION 'reviewed_069_policy_seed_conflict' USING ERRCODE='55000'; END IF;
 policy_started:=clock_timestamp();
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  before_state:=before_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 before_policy_full:=before_state->'erp_fiscal_authorization.policy';
 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl,'default',(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum),'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO before_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 before_security:=jsonb_set(before_security,ARRAY['erp_fiscal_authorization.policy','constraints'],
  coalesce((SELECT jsonb_agg(x ORDER BY x->>'name') FROM jsonb_array_elements(before_security#>'{erp_fiscal_authorization.policy,constraints}')x WHERE x->>'name'<>'policy_check3'),'[]'));
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO before_schemas FROM pg_namespace WHERE nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage');
 FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) WHERE(value->>'replace')::boolean LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL THEN RAISE EXCEPTION 'reviewed_069_previous_contract_changed' USING ERRCODE='55000'; END IF;
  changed_oids:=array_append(changed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO before_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO before_defaults FROM pg_default_acl d;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO before_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(changed_oids);
 opening:=position(E'\\nbegin;\\n' IN source_069);
 IF right(source_069,8) IS DISTINCT FROM E'commit;\\n' OR opening=0 THEN RAISE EXCEPTION 'reviewed_069_transaction_wrapper_invalid' USING ERRCODE='22023'; END IF;
 source_body:=overlay(left(source_069,length(source_069)-8) placing E'\\n' from opening for 8);
 EXECUTE source_body;
 SELECT array_agg(format('%I.%I',n.nspname,c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") INTO current_names
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN('r','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects'));
 IF current_names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(names||added_tables) x) THEN RAISE EXCEPTION 'reviewed_069_table_inventory_changed' USING ERRCODE='40001'; END IF;
 FOREACH object_name IN ARRAY names LOOP
  EXECUTE format($fingerprint$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM %s t) q$fingerprint$,object_name) INTO snapshot;
  IF object_name='erp_fiscal_authorization.policy' THEN
   after_policy_full:=snapshot;
   SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) INTO snapshot
    FROM(SELECT encode(sha256(convert_to((to_jsonb(p)-'authorization_profile')::text,'UTF8')),'hex')h FROM erp_fiscal_authorization.policy p
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(policy_keys)k WHERE k->>'model'=p.model AND(k->>'version')::integer=p.version))q;
  END IF;
  after_state:=after_state||jsonb_build_object(object_name,snapshot);
 END LOOP;
 IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'reviewed_069_existing_data_changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy p WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(policy_keys)k WHERE k->>'model'=p.model AND(k->>'version')::integer=p.version) AND p.authorization_profile<>'legacy_v1') THEN RAISE EXCEPTION 'reviewed_069_legacy_policy_profile_changed' USING ERRCODE='40001'; END IF;
 SELECT jsonb_agg(to_jsonb(p)-'created_at' ORDER BY model) INTO new_policy_rows FROM erp_fiscal_authorization.policy p
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy_keys)k WHERE k->>'model'=p.model AND(k->>'version')::integer=p.version);
 SELECT jsonb_agg(jsonb_build_object('model',m,'version',(policy_max->>m)::integer+1,'origin','operational','enabled',false,
  'binding_profile','sp'||m||'-authorization-soap12-reviewed-20261016-v1','rule_profile','sp-crt1-internal-sale-homologation-20261016-v1',
  'binding_reviewed',true,'tax_rules_reviewed',false,'source_manifest_hash',CASE m WHEN '55' THEN 'd825d62ab1b17b7e5303c0aa2a7a2b1c8e43c82570e49ca98113eb797063d7db' ELSE '963eb588baf7195067ff3f06f6b971107561d8da88db17b5c207f4714d7ef3c0' END,
  'valid_from','2026-10-16T03:00:00Z'::timestamptz,'valid_until','2026-10-26T03:00:00Z'::timestamptz,'authorization_profile','reviewed_subset_v1') ORDER BY m) INTO policy_seeds FROM unnest(ARRAY['55','65'])m;
 IF new_policy_rows IS DISTINCT FROM policy_seeds OR EXISTS(SELECT 1 FROM erp_fiscal_authorization.policy p WHERE p.authorization_profile='reviewed_subset_v1' AND (p.created_at<policy_started OR p.created_at>clock_timestamp())) THEN RAISE EXCEPTION 'reviewed_069_policy_seeds_changed' USING ERRCODE='40001'; END IF;

 SELECT jsonb_object_agg(format('%I.%I',n.nspname,c.relname),jsonb_build_object('rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'owner',c.relowner,'acl',c.relacl,
  'columns',(SELECT jsonb_agg(jsonb_build_object('num',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'acl',a.attacl,'default',(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum),'identity',a.attidentity,'generated',a.attgenerated,'collation',a.attcollation) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))) INTO after_security
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE format('%I.%I',n.nspname,c.relname)=ANY(names);
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='erp_fiscal_authorization.policy'::regclass AND a.attname='authorization_profile' AND a.atttypid='text'::regtype AND a.atttypmod=-1 AND a.attnotnull AND a.attacl IS NULL AND a.attidentity='' AND a.attgenerated='' AND pg_get_expr(d.adbin,d.adrelid)=$default$'legacy_v1'::text$default$) THEN RAISE EXCEPTION 'reviewed_069_policy_column_changed' USING ERRCODE='40001'; END IF;
 IF (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='erp_fiscal_authorization.policy'::regclass AND conname IN('policy_authorization_profile_check','reviewed_policy_authority_check') AND convalidated) IS DISTINCT FROM catalog_contract->'policy_constraints' THEN RAISE EXCEPTION 'reviewed_069_policy_constraints_changed' USING ERRCODE='40001'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each_text(catalog_contract->'triggers') LOOP
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid=to_regclass(split_part(r.key,'/',1)) AND tgname=split_part(r.key,'/',2) AND tgenabled='O') IS DISTINCT FROM r.value THEN RAISE EXCEPTION 'reviewed_069_stage_trigger_changed' USING ERRCODE='40001'; END IF;
 END LOOP;
 -- PG18 represents NOT NULL as pg_constraint; PG17 keeps it only in pg_attribute.
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='erp_fiscal_authorization.policy'::regclass AND conname='policy_authorization_profile_not_null' AND (contype<>'n' OR NOT convalidated OR pg_get_constraintdef(oid)<>'NOT NULL authorization_profile')) THEN RAISE EXCEPTION 'reviewed_069_policy_constraints_changed' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_trigger t ON t.tgconstraint=c.oid WHERE c.conrelid='erp_fiscal_authorization.attempt'::regclass AND c.conname='reviewed_use_commit' AND c.contype='t' AND c.condeferrable AND c.condeferred AND c.convalidated AND t.tgname='reviewed_use_commit') THEN RAISE EXCEPTION 'reviewed_069_stage_trigger_changed' USING ERRCODE='40001'; END IF;
 after_security:=jsonb_set(after_security,ARRAY['erp_fiscal_authorization.policy','columns'],(SELECT jsonb_agg(x ORDER BY(x->>'num')::integer) FROM jsonb_array_elements(after_security#>'{erp_fiscal_authorization.policy,columns}')x WHERE x->>'name'<>'authorization_profile'));
 after_security:=jsonb_set(after_security,ARRAY['erp_fiscal_authorization.policy','constraints'],coalesce((SELECT jsonb_agg(x ORDER BY x->>'name') FROM jsonb_array_elements(after_security#>'{erp_fiscal_authorization.policy,constraints}')x WHERE x->>'name' NOT IN('policy_authorization_profile_check','reviewed_policy_authority_check','policy_authorization_profile_not_null')),'[]'));
 after_security:=jsonb_set(after_security,ARRAY['erp_fiscal_authorization.attempt','constraints'],coalesce((SELECT jsonb_agg(x ORDER BY x->>'name') FROM jsonb_array_elements(after_security#>'{erp_fiscal_authorization.attempt,constraints}')x WHERE x->>'name'<>'reviewed_use_commit'),'[]'));
 FOREACH object_name IN ARRAY ARRAY['erp_fiscal_authorization.request','erp_fiscal_authorization.attempt','erp_fiscal_authorization.result'] LOOP
  after_security:=jsonb_set(after_security,ARRAY[object_name,'triggers'],coalesce((SELECT jsonb_agg(x ORDER BY x->>'name') FROM jsonb_array_elements(after_security#>ARRAY[object_name,'triggers'])x WHERE NOT(catalog_contract->'triggers' ? (object_name||'/'||(x->>'name')))),'null'));
 END LOOP;
 IF before_security IS DISTINCT FROM after_security THEN RAISE EXCEPTION 'reviewed_069_table_security_changed' USING ERRCODE='42501'; END IF;
 SELECT jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner,'acl',nspacl)) INTO after_schemas FROM pg_namespace WHERE (nspname~'^(erp|origin)_' OR nspname IN('public','auth','storage')) AND nspname<>'erp_fiscal_reviewed_authorization';
 IF before_schemas IS DISTINCT FROM after_schemas THEN RAISE EXCEPTION 'reviewed_069_schema_security_changed' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each(reviewed_functions) LOOP
  function_oid:=to_regprocedure(r.key);
  IF function_oid IS NULL
   OR has_function_privilege('anon',function_oid,'EXECUTE') OR has_function_privilege('authenticated',function_oid,'EXECUTE')
   OR has_function_privilege('service_role',function_oid,'EXECUTE') IS DISTINCT FROM (r.value->>'public')::boolean
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=function_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT((r.value->>'public')::boolean AND a.grantee=service_oid))
   OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=function_oid AND p.prosecdef=(r.value->>'definer')::boolean AND p.provolatile=(r.value->>'volatility')::"char" AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.prorettype=to_regtype(r.value->>'returns') AND l.lanname=r.value->>'language' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=r.value->>'sha256')
  THEN RAISE EXCEPTION 'reviewed_069_function_contract_failed' USING ERRCODE='42501'; END IF;
  reviewed_oids:=array_append(reviewed_oids,function_oid);
 END LOOP;
 SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('acl',p.proacl,'owner',p.proowner,'args',p.proargnames,'defaults',pg_get_expr(p.proargdefaults,0))) INTO after_changed_security FROM pg_proc p WHERE p.oid=ANY(changed_oids);
 IF before_changed_security IS DISTINCT FROM after_changed_security THEN RAISE EXCEPTION 'reviewed_069_replaced_function_security_changed' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.oid),'[]') INTO after_defaults FROM pg_default_acl d WHERE d.defaclnamespace<>'erp_fiscal_reviewed_authorization'::regnamespace;
 IF before_defaults IS DISTINCT FROM after_defaults THEN RAISE EXCEPTION 'reviewed_069_default_privileges_changed' USING ERRCODE='42501'; END IF;

 IF EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='erp_fiscal_reviewed_authorization' AND a.grantee<>n.nspowner)
 OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='erp_fiscal_reviewed_authorization' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace='erp_fiscal_reviewed_authorization'::regnamespace AND a.grantee<>d.defaclrole)
 THEN RAISE EXCEPTION 'reviewed_069_private_schema_failed' USING ERRCODE='42501'; END IF;
 FOREACH object_name IN ARRAY added_tables LOOP
  EXECUTE 'SELECT count(*) FROM '||object_name INTO opening;
  IF opening<>0 THEN RAISE EXCEPTION 'reviewed_069_new_table_not_empty' USING ERRCODE='40001'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(object_name) AND relrowsecurity AND NOT relforcerowsecurity AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass(object_name) AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(object_name))
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=to_regclass(object_name) AND x.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  THEN RAISE EXCEPTION 'reviewed_069_private_table_failed' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(object_name) AND NOT convalidated)
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(object_name) AND NOT tgisinternal AND tgenabled<>'O') THEN RAISE EXCEPTION 'reviewed_069_table_contract_failed' USING ERRCODE='40001'; END IF;
  SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=to_regclass(object_name) AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=to_regclass(object_name) AND contype<>'n' AND convalidated),
   'triggers',(SELECT jsonb_object_agg(tgname,pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgrelid=to_regclass(object_name) AND NOT tgisinternal AND tgenabled='O')) INTO snapshot;
  IF snapshot IS DISTINCT FROM catalog_contract->'tables'->object_name THEN RAISE EXCEPTION 'reviewed_069_table_contract_failed' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex')) INTO after_functions
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND (n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND p.oid<>ALL(reviewed_oids);
 IF before_functions IS DISTINCT FROM after_functions THEN RAISE EXCEPTION 'reviewed_069_other_functions_changed' USING ERRCODE='40001'; END IF;
 INSERT INTO pg_temp.brufap_apply_reviewed_069_audit(result) VALUES(jsonb_build_object(
  'migration','069','applicator_version',1,'source_sha256',expected_069,'required_function_hashes',previous_functions,
  'protected_table_count',cardinality(names),'table_locks','policy_access_exclusive_else_share_row_exclusive_nowait','before',before_state,'after',after_state,'legacy_projections_equal',true,'policy_hash_scope','old keys and old columns only','policy_before_full',before_policy_full,'policy_after_full',after_policy_full,'old_policy_fields_preserved',true,'new_policy_seeds',jsonb_array_length(new_policy_rows),'new_policy_seeds_disabled',true,
  'table_security_preserved_except_reviewed_ddl',true,'schema_security_unchanged',true,'other_functions_unchanged',true,'other_functions_sha256',encode(sha256(convert_to(after_functions::text,'UTF8')),'hex'),'replaced_function_security_unchanged',true,'default_privileges_unchanged',true,
  'new_service_only_rpcs',7,'new_private_helpers',7,'replaced_functions',cardinality(changed_oids),'reviewed_functions',cardinality(reviewed_oids),'new_tables',2,'new_table_empty',true,'new_table_rls',true,'new_table_owner_only',true,'operation_activated',false,'financial_mutation_performed',false,'stock_mutation_performed',false,
  'tax_rules_validated',false,'can_emit',false,'can_transmit',false,'production_authorized',false,'commit_acknowledgement_required',true));
END
$apply_069$;
SELECT result AS reviewed_authorization_apply_audit FROM pg_temp.brufap_apply_reviewed_069_audit;
COMMIT;
`;
}
/** Read-only proof after COMMIT; compare legacy_rows and other_functions_sha256 with the apply audit. */
export async function prepareReviewedAuthorizationReadback(){
 const source=await readFile(new URL('../../supabase/migrations/202610160069_fiscal_reviewed_authorization.sql',import.meta.url),'utf8');
 if(hash(source)!==SOURCE_SHA256)throw Error('SOURCE_069_NOT_REVIEWED');
 const reviewed=functions(source);
 return `-- 069 independent readback; no RPC mutation, credential or dispatch.
BEGIN READ ONLY;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog;
SET LOCAL timezone='UTC';
-- Dynamic SELECTs only. A transaction-local setting carries the result to the
-- final SELECT without temp tables, persistent functions or a libxml dependency.
DO $readback_069$
DECLARE r record; snapshot jsonb; rows jsonb:='{}';
BEGIN
 FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND n.nspname<>'erp_fiscal_reviewed_authorization' AND(n.nspname~'^(erp|origin)_' OR n.nspname='auth' AND c.relname='users' OR n.nspname='storage' AND c.relname IN('buckets','objects')) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" LOOP
  EXECUTE format($fp$SELECT jsonb_build_object('count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h COLLATE "C"),''),'UTF8')),'hex')) FROM(SELECT encode(sha256(convert_to((%s)::text,'UTF8')),'hex')h FROM %I.%I t %s)q$fp$,
   CASE WHEN r.nspname='erp_fiscal_authorization' AND r.relname='policy' THEN $p$to_jsonb(t)-'authorization_profile'$p$ ELSE 'to_jsonb(t)' END,r.nspname,r.relname,
   CASE WHEN r.nspname='erp_fiscal_authorization' AND r.relname='policy' THEN $p$WHERE authorization_profile='legacy_v1'$p$ ELSE '' END) INTO snapshot;
  rows:=rows||jsonb_build_object(format('%I.%I',r.nspname,r.relname),snapshot);
 END LOOP;
 PERFORM set_config('brufap.reviewed_069_readback_rows',rows::text,true);
END
$readback_069$;
WITH expected AS(SELECT key signature,value spec FROM jsonb_each('${JSON.stringify(Object.fromEntries(reviewed))}'::jsonb)),
function_proofs AS(SELECT e.*,p.oid,p.prosrc,p.proacl,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.prorettype,l.lanname FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature) LEFT JOIN pg_language l ON l.oid=p.prolang),
others AS(SELECT jsonb_object_agg(p.oid::regprocedure::text,encode(sha256(convert_to(jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner)::text,'UTF8')),'hex'))v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND(n.nspname~'^(erp|origin)_' OR n.nspname='public' AND p.proname~'^(erp|origin)_') AND NOT EXISTS(SELECT 1 FROM expected e WHERE p.oid=to_regprocedure(e.signature)))
SELECT jsonb_build_object('migration','069','source_sha256','${SOURCE_SHA256}',
 'function_contracts_valid',(SELECT bool_and(oid IS NOT NULL AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')=spec->>'sha256' AND prosecdef=(spec->>'definer')::boolean AND provolatile=(spec->>'volatility')::"char" AND proconfig=ARRAY['search_path=pg_catalog'] AND prorettype=to_regtype(spec->>'returns') AND lanname=spec->>'language'
 AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND has_function_privilege('service_role',oid,'EXECUTE')=(spec->>'public')::boolean
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner)))a WHERE a.privilege_type='EXECUTE' AND a.grantee<>proowner AND NOT((spec->>'public')::boolean AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role'))))FROM function_proofs),
 'reviewed_functions',(SELECT count(*)FROM function_proofs),'service_only_rpcs',(SELECT count(*)FROM expected WHERE(spec->>'public')::boolean AND NOT(spec->>'replace')::boolean),
 'legacy_rows',current_setting('brufap.reviewed_069_readback_rows')::jsonb,
 'policy_hash_scope','old keys and old columns only; compare immediately with apply audit',
 'other_functions_sha256',(SELECT encode(sha256(convert_to(v::text,'UTF8')),'hex')FROM others),
 'new_policy_count',(SELECT count(*)FROM erp_fiscal_authorization.policy WHERE authorization_profile='reviewed_subset_v1'),
 'new_policies_disabled',(SELECT bool_and(NOT enabled AND NOT tax_rules_reviewed AND binding_reviewed AND origin='operational')FROM erp_fiscal_authorization.policy WHERE authorization_profile='reviewed_subset_v1'),
 'binding_count',(SELECT count(*)FROM erp_fiscal_reviewed_authorization.review_binding),'observation_count',(SELECT count(*)FROM erp_fiscal_reviewed_authorization.observation),
 'private_schema',NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a WHERE n.nspname='erp_fiscal_reviewed_authorization' AND a.grantee<>n.nspowner),
 'private_tables',NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE n.nspname='erp_fiscal_reviewed_authorization' AND c.relkind IN('r','p') AND a.grantee<>c.relowner),
 'new_tables_rls',(SELECT bool_and(c.relrowsecurity)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_reviewed_authorization' AND c.relkind='r'),
 'new_table_policies',(SELECT count(*)FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp_fiscal_reviewed_authorization'))AS reviewed_authorization_readback;
COMMIT;
`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3)throw Error('OUTPUT_PATH_REQUIRED');
 const text=await prepareReviewedAuthorizationApply(),file=await open(process.argv[2],'wx',0o600);
 try{await file.writeFile(text);await file.sync();}finally{await file.close();}
 console.log(JSON.stringify({prepared:true,remote_executed:false,source_sha256:SOURCE_SHA256,script_sha256:hash(text)}));
}
