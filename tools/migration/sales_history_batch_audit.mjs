/** Local SQL composition. No connection, execution, credentials or command creation. */
import {prepareSalesHistoryReadback,SOURCE_HASHES} from './prepare_sales_history_apply.mjs';
export {SOURCE_HASHES};
export const batchSqlString=v=>"'"+v.replaceAll("'","''")+"'";
export const batchSettings="SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='60s';SET LOCAL search_path=pg_catalog;SET LOCAL timezone='UTC';\n";
export const protectedTables="c.relkind IN('r','p')AND(n.nspname~'^(erp|origin)_'OR n.nspname='auth'AND c.relname='users'OR n.nspname='storage'AND c.relname IN('buckets','objects'))";
export const batchLocks=`DO $batch_locks$ DECLARE r record;BEGIN
 FOR r IN SELECT format('%I.%I',n.nspname,c.relname)name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${protectedTables} ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" LOOP
 EXECUTE 'LOCK TABLE '||r.name||' IN SHARE ROW EXCLUSIVE MODE NOWAIT';END LOOP;
END $batch_locks$;`;
const emptyGuard=" IF EXISTS(SELECT 1 FROM erp_sales_history.snapshot)OR EXISTS(SELECT 1 FROM erp_sales_history.command)THEN RAISE EXCEPTION 'sales_history_083_new_tables_not_empty' USING ERRCODE='40001';END IF;";
const replaceOnce=(s,a,b)=>{if(s.split(a).length!==2)throw Error('BATCH_AUDIT_TEMPLATE_CHANGED');return s.replace(a,b);};
/** Reuse the pinned 083 contract auditor, explicitly removing its installation-only emptiness condition.
 * This is a new operational audit; the frozen installation/readback generators remain unchanged. */
export async function salesHistoryBatchAuditBlock(){
 const original=await prepareSalesHistoryReadback(),start=original.indexOf('DO $readback_083$'),end=original.indexOf("SELECT current_setting('brufap.sales_history_083_readback')");
 if(start<0||end<start)throw Error('BATCH_AUDIT_TEMPLATE_CHANGED');
 let block=replaceOnce(original.slice(start,end),emptyGuard,'');
 block=replaceOnce(block,",'new_tables_empty',true",'');
 if(block.includes('new_tables_empty')||block.includes('new_tables_not_empty'))throw Error('BATCH_AUDIT_TEMPLATE_CHANGED');
 // The installation audit omits the new namespace from its historical baseline.
 // Add full current metadata and row fingerprints for both now-existing history tables.
 return block+`DO $batch_audit$ DECLARE a jsonb;s jsonb;c jsonb;m jsonb;BEGIN
 a:=current_setting('brufap.sales_history_083_readback')::jsonb;
 IF(a->>'protected_table_count')::integer<152 THEN RAISE EXCEPTION 'batch_baseline_missing' USING ERRCODE='55000';END IF;
 IF(SELECT count(*)FROM erp_sales_history.snapshot)>20000 OR(SELECT count(*)FROM erp_sales_history.command)>20000 THEN RAISE EXCEPTION 'batch_history_limit' USING ERRCODE='54000';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('command_id',t.command_id,'history_id',t.history_id,'source_id',t.source_id,'row_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))ORDER BY t.command_id),'[]')INTO s FROM erp_sales_history.snapshot t;
 SELECT coalesce(jsonb_agg(jsonb_build_object('command_id',t.command_id,'history_id',t.history_id,'row_sha256',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'))ORDER BY t.command_id),'[]')INTO c FROM erp_sales_history.command t;
 SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(to_jsonb(x)-'relpages'-'reltuples'-'relallvisible'-'relfrozenxid'-'relminmxid' ORDER BY x.oid)FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'columns',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.attrelid,x.attnum)FROM pg_attribute x JOIN pg_class c ON c.oid=x.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE x.attnum>0 AND(n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage'))),
 'defaults',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_attrdef x JOIN pg_class c ON c.oid=x.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'schemas',(SELECT jsonb_agg(jsonb_build_array(n.oid,n.nspname,n.nspowner,n.nspacl)ORDER BY n.oid)FROM pg_namespace n WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'default_acl',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_default_acl x),
 'functions',(SELECT jsonb_agg(to_jsonb(p)ORDER BY p.oid)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname='public'AND p.proname~'^(erp|origin)_'),
 'constraints',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_constraint x JOIN pg_namespace n ON n.oid=x.connamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'indexes',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.indexrelid)FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'triggers',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_trigger x JOIN pg_class c ON c.oid=x.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')),
 'policies',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_policy x),
 'types',(SELECT jsonb_agg(to_jsonb(x)ORDER BY x.oid)FROM pg_type x JOIN pg_namespace n ON n.oid=x.typnamespace WHERE n.nspname~'^(erp|origin)_'OR n.nspname IN('public','auth','storage')))INTO m;
 a:=a||jsonb_build_object('profile','sales-history-083-batch-audit-v1','total_table_count',(a->>'protected_table_count')::integer+2,
 'metadata_sha256',encode(sha256(convert_to(m::text,'UTF8')),'hex'),'history',jsonb_build_object('snapshots',s,'commands',c));
 PERFORM set_config('brufap.sales_history_batch_audit',a::text,true);
END $batch_audit$;\n`;
}
