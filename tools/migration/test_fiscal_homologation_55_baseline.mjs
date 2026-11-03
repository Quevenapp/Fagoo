import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,lstat,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareFiscalHomologation55Baseline,writeFiscalHomologation55Baseline,TEMPLATE_SHA256,COMMERCIAL_ASSUMPTION} from './prepare_fiscal_homologation_55_baseline.mjs';
import {normalizeDocument} from '../../packages/erp-domain/src/index.mjs';
const target='d0000000-0000-4000-8000-000000000007';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stripped=sql=>sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,"''");

test('baseline is pinned, repeatable-read read-only and contains no executable mutation or application RPC',async()=>{
 const template=await readFile(new URL('./fiscal_homologation_55_baseline.sql',import.meta.url),'utf8');assert.equal(sha(template),TEMPLATE_SHA256);
 const sql=await prepareFiscalHomologation55Baseline(),tokens=stripped(sql);
 assert.match(sql,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
 assert.match(sql,/statement_timeout='20s'/);assert.match(sql,/lock_timeout='2s'/);assert.match(sql,/timezone='UTC'/);
 assert.doesNotMatch(tokens,/\b(?:insert|update|delete|drop|alter|create|truncate|call|do|lock|grant|revoke|copy|execute|perform)\b/i);
 assert.doesNotMatch(tokens,/\b(?:gen_random_uuid|nextval|setval|set_config|dblink|lo_import|lo_export)\s*\(|public\.erp_/i);
 assert.equal(tokens.split(';').filter(s=>s.trim()).length,7);
 assert.match(sql,/SELECT NULL::uuid AS target_order_id/);assert.ok(sql.endsWith('COMMIT;\n'));
});

test('UUID substitution is closed, captured before await and cannot inject SQL or generate identifiers',async()=>{
 const options={targetOrderId:target.toUpperCase()},pending=prepareFiscalHomologation55Baseline(options);options.targetOrderId='changed';
 const sql=await pending;assert.match(sql,new RegExp(`SELECT '${target}'::uuid`));
 for(const value of ["';COMMIT;--",'','123',42,{},target+' ',`${target}\n`,undefined]){
  if(value===undefined)continue;
  await assert.rejects(prepareFiscalHomologation55Baseline({targetOrderId:value}),/BASELINE_TARGET_UUID_INVALID/);
 }
 for(const options of [{unexpected:target},[],null,Object.create({targetOrderId:target}),{[Symbol('target')]:target}])await assert.rejects(prepareFiscalHomologation55Baseline(options),/BASELINE_OPTIONS_INVALID/);
 let called=false;const getter=Object.defineProperty({},'targetOrderId',{get(){called=true;return target;}});
 await assert.rejects(prepareFiscalHomologation55Baseline(getter),/BASELINE_OPTIONS_INVALID/);assert.equal(called,false);
 assert.equal(await prepareFiscalHomologation55Baseline({targetOrderId:null}),await prepareFiscalHomologation55Baseline());
});

test('scope separates original and optional target, historical results and current gates without claiming authorization',async()=>{
 const sql=await prepareFiscalHomologation55Baseline({targetOrderId:target});
 for(const term of ['42194','4351,4352','selected_orders','selected_reservations','historical_authorizations','historical_revalidations','revalidated_state','authorization_policy_heads','receipt_query_policy_heads','target_is_different_order','target_exists_if_requested','target_same_contact_and_exact_price','target_unprepared_without_effects','single_active_admin'])assert.ok(sql.includes(term),term);
 assert.match(sql,/'unit_price_from','original_order_item'/);assert.doesNotMatch(sql,/i\.unit_price=84\.81|(?:'unit_price',)'84\.81'/);
 assert.match(sql,/'can_create_order',false/);assert.match(sql,/'can_emit',false/);assert.match(sql,/'eligibility_attested',false/);assert.match(sql,/'runtime_flags_observed',false/);
 assert.match(sql,/'sql_policy_exists',false/); //062 has no policy table; do not invent a head.
 assert.match(sql,/'cstat',r\.evidence->'cstat'/);assert.match(sql,/'original_state',v\.receipt->'original_state'/);
 assert.doesNotMatch(sql,/AS SELECT|SELECT \* FROM erp_fiscal_authorization\.attempt/);
});

test('bounded output keeps explicit truncation and hashes instead of XML, party text or custody bytes',async()=>{
 const sql=await prepareFiscalHomologation55Baseline();
 assert.match(sql,/octet_length\(value::text\)<=262144/);assert.match(sql,/BASELINE_TOO_LARGE/);
 for(const path of ['actor_inventory,truncated','related_orders,truncated','reservations,truncated','candidate_inventory,truncated','historical_authorizations,total','historical_revalidations,total'])assert.ok(sql.includes(path),path);
 assert.match(sql,/ORDER BY position LIMIT 2/);
 for(const label of ['xml','access_key','protocol_number','document','name','street','password','sealed_bytes','metadata'])assert.equal(new RegExp(`(?:jsonb_build_object\\(|,)\\s*'${label}'\\s*,`).test(sql),false,label);
 assert.match(sql,/'document_matches_original_snapshot'/);assert.match(sql,/'bytes_verified',false/);
});

test('commercial recipe preserves the original ten-decimal unit price and rounds only the1CX total',()=>{
 const source={date:'2026-10-17',contact_id:'d0000000-0000-4000-8000-000000000001',warehouse_id:null,
  items:[{id:null,product_id:'d0000000-0000-4000-8000-000000000002',description:'Fixture Vipal R-01',code:COMMERCIAL_ASSUMPTION.product_code,unit:COMMERCIAL_ASSUMPTION.unit,quantity:COMMERCIAL_ASSUMPTION.quantity,unit_price:'84.8062444176',discount_percent:'0',detailed_description:null}],
  discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[],commercial:null};
 const normalized=normalizeDocument('sales_orders',source);assert.equal(normalized.totals.total,'84.81');assert.equal(normalized.items[0].unit_price,'84.8062444176');assert.equal(normalized.items[0].quantity,'1.000000');assert.equal(normalized.items[0].id,null);
 assert.equal(COMMERCIAL_ASSUMPTION.unit_price_from,'original_order_item');assert.equal(COMMERCIAL_ASSUMPTION.expected_total,'84.81');assert.equal(Object.hasOwn(COMMERCIAL_ASSUMPTION,'unit_price'),false);
 assert.equal(normalized.installments.length,0);assert.equal(Object.hasOwn(source,'command_id'),false);assert.equal(Object.hasOwn(source,'number'),false);
});

test('filesystem export is private, exclusive, no overwrite or symlink follow',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'test55-baseline-'));
 try{
  const output=join(dir,'baseline.sql'),meta=await writeFiscalHomologation55Baseline(output);
  const bytes=await readFile(output);assert.equal(sha(bytes),meta.sql_sha256);assert.equal((await lstat(output)).mode&0o777,0o600);
  assert.equal(meta.database_executed,false);assert.equal(meta.network_used,false);assert.equal(meta.uuid_generated,false);assert.equal(meta.mutation_payload_generated,false);
  await assert.rejects(writeFiscalHomologation55Baseline(output),e=>e.code==='EEXIST');assert.deepEqual(await readFile(output),bytes);
  const link=join(dir,'link.sql');await symlink(output,link);await assert.rejects(writeFiscalHomologation55Baseline(link),e=>e.code==='EEXIST');assert.deepEqual(await readFile(output),bytes);
  await assert.rejects(writeFiscalHomologation55Baseline('relative.sql'),/BASELINE_OUTPUT_PATH_INVALID/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI never runs SQL and rejects unknown or repeated selectors before creating output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'test55-baseline-cli-'));
 try{
  const script=fileURLToPath(new URL('./prepare_fiscal_homologation_55_baseline.mjs',import.meta.url)),output=join(dir,'out.sql');
  for(const args of [[],['--output',output,'--execute','yes'],['--output',output,'--target-order',target,'--target-order',target]]){
   assert.throws(()=>execFileSync(process.execPath,[script,...args],{stdio:'pipe'}));await assert.rejects(access(output));
  }
  const meta=JSON.parse(execFileSync(process.execPath,[script,'--output',output,'--target-order',target],{encoding:'utf8'}));
  assert.equal(meta.database_executed,false);assert.equal(meta.mutation_payload_generated,false);assert.match(await readFile(output,'utf8'),new RegExp(`'${target}'::uuid`));
 }finally{await rm(dir,{recursive:true,force:true});}
});
