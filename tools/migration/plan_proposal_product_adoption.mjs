/** Read-only planning. There is deliberately no apply RPC or mutation mode. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {catalogImportResponse} from '../../workers/erp-api/src/catalog-import.mjs';
import {originProposalImportV2Response} from '../../workers/erp-api/src/origin-proposal-import-v2.mjs';
import {isCanonicalUnitPrice} from '../../packages/erp-domain/src/unit-price.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const ID=/^[1-9][0-9]{0,39}$/,HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const need=(v,c='ADOPTION_PLAN_INVALID')=>{if(!v)throw new Error(c);};
const str=(v,re)=>typeof v==='string'&&re.test(v);
const version=v=>str(v,/^[1-9][0-9]{0,18}$/)&&BigInt(v)<=9223372036854775807n;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const stamp=v=>{
 if(typeof v!=='string')return false;const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
 if(!m)return false;const[y,month,day,hour,minute,second,offsetHour=0,offsetMinute=0]=m.slice(1).map(x=>x===undefined?undefined:Number(x));
 const calendar=new Date(Date.UTC(y,month-1,day));return y>=1900&&calendar.getUTCFullYear()===y&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day
  &&hour<24&&minute<60&&second<60&&offsetHour<=14&&offsetMinute<60&&(offsetHour!==14||offsetMinute===0)&&Number.isFinite(Date.parse(v));
};
const hash=v=>createHash('sha256').update(v).digest('hex');
export function validateAdoptionEvidence(input){
 need(exact(input,['profile','read_only','exported_at','has_more','items'])&&input.profile==='proposal-product-adoption-evidence-v1'&&input.read_only===true&&stamp(input.exported_at)&&input.has_more===false&&Array.isArray(input.items)&&input.items.length<=500);
 const seen=new Set();for(const v of input.items){
  need(exact(v,['source_id','source_hash','source_version','source_seen_at','proposal_id','proposal_hash','proposal_version','source_active','source_simple_product','capture'])&&str(v.source_id,ID)&&str(v.proposal_id,ID)&&str(v.source_hash,HASH)&&str(v.proposal_hash,HASH)&&version(v.source_version)&&version(v.proposal_version)&&stamp(v.source_seen_at)&&typeof v.source_active==='boolean'&&typeof v.source_simple_product==='boolean'&&!seen.has(v.source_id));seen.add(v.source_id);
  const c=v.capture;need(exact(c,['profile','source','response_sha256','capture_id','observed_at','source_hash','source_version','numeric_price'])&&c.profile==='origin-price-json-v1'&&c.source==='detail'&&str(c.response_sha256,HASH)&&str(c.capture_id,UUID)&&stamp(c.observed_at)&&c.source_hash===v.source_hash&&c.source_version===v.source_version&&typeof c.numeric_price==='boolean');
 }
 return structuredClone(input);
}
export function createAdoptionReaders(rpc){
 need(typeof rpc==='function');return{
  async proposal(id){const args={p_source_id:id};return originProposalImportV2Response(await rpc('erp_origin_proposal_import_preview_v2',args),{type:'preview',args});},
  async catalog(items){const args={p_entity:'products',p_items:items};return catalogImportResponse(await rpc('erp_catalog_import_preview',args),{entity:'products'},{type:'preview',args});}
 };
}
export function adoptionRuntimeConfig(env=process.env){
 let url;try{url=new URL(env.SUPABASE_URL);}catch{throw new Error('ADOPTION_RUNTIME_CONFIGURATION_REQUIRED');}
 need(url.protocol==='https:'&&url.origin===env.SUPABASE_URL&&!url.username&&!url.password&&str(env.FAGOO_ADOPTION_ACTOR_ID,UUID),'ADOPTION_RUNTIME_CONFIGURATION_REQUIRED');
 return{project:url.origin,actor:env.FAGOO_ADOPTION_ACTOR_ID};
}
export async function planProposalProductAdoption({evidence,readers,actor,now=()=>new Date(),uuid=randomUUID}){
 const snapshot=validateAdoptionEvidence(evidence);need(str(actor,UUID)&&typeof readers?.proposal==='function'&&typeof readers?.catalog==='function');
 const planId=uuid();need(str(planId,UUID));const blocked=[],eligible=[],proposals=new Map(),batches=[];
 const block=(v,code)=>blocked.push({source_id:v.source_id,code});
 for(const v of snapshot.items){
  if(!v.source_active||!v.source_simple_product){block(v,'SOURCE_PROFILE_OUTSIDE_APPROVAL');continue;}
  if(!v.capture.numeric_price){block(v,'NUMERIC_PRICE_EVIDENCE_REQUIRED');continue;}
  if(!proposals.has(v.proposal_id))proposals.set(v.proposal_id,await readers.proposal(v.proposal_id));
  const p=proposals.get(v.proposal_id);
  need(object(p)&&p.dry_run===true&&p.persisted===false&&p.source_id===v.proposal_id&&Array.isArray(p.bindings),'PROPOSAL_PREVIEW_INVALID');
  if(p.existing!==null||!['Rascunho','Pendente','Aguardando'].includes(p.source_status)){block(v,'PROPOSAL_NO_LONGER_PENDING');continue;}
  if(p.source_hash!==v.proposal_hash||p.source_version!==v.proposal_version){block(v,'PROPOSAL_WITNESS_CHANGED');continue;}
  const matches=p.bindings.filter(b=>b.entity==='products'&&b.source_id===v.source_id);
  if(!matches.length||matches.some(b=>b.record_id!==null||b.origin_state!==null)){block(v,'PRODUCT_ALREADY_LINKED_OR_REFERENCE_CHANGED');continue;}
  if(matches.some(b=>b.source_hash!==v.source_hash||b.source_version!==v.source_version)){block(v,'PRODUCT_SOURCE_CHANGED');continue;}
  eligible.push(v);
 }
 const admissible=(row,v)=>{
  if(!object(row)||row.source_id!==v.source_id||row.source_hash!==v.source_hash||row.source_version!==v.source_version)return'SOURCE_CAS_CHANGED';
  if(row.action!=='create'||row.operation_action!=='create'||row.record_id!==null||row.record_version!==null||row.origin_state!==null||row.human_edited!==false||row.candidate_retained!==false||row.stock_locked!==false)return'CREATE_ONLY_REQUIRED';
  if(row.error!==null||!['A','S'].includes(row.source_status)||!Array.isArray(row.changes))return'MAPPER_REVIEW_BLOCKED';
  const changes=Object.fromEntries(row.changes.map(c=>[c.field,c.after]));
  if(changes.active!==true||changes.kind!=='P'||changes.format!=='S'||!isCanonicalUnitPrice(changes.price,14))return'MAPPER_PROFILE_OUTSIDE_APPROVAL';
  return null;
 };
 for(let i=0;i<eligible.length;i+=50){
  const group=eligible.slice(i,i+50),items=group.map(v=>({source_id:v.source_id,source_hash:v.source_hash}));let preview=await readers.catalog(items);
  need(object(preview)&&preview.dry_run===true&&preview.operational_effects===false&&str(preview.preview_hash,HASH)&&Array.isArray(preview.items)&&preview.items.length===group.length,'CATALOG_PREVIEW_INVALID');
  const selected=group.filter((v,j)=>{const reason=admissible(preview.items[j],v);if(reason)block(v,reason);return!reason;});
  if(!selected.length)continue;
  const chosen=selected.map(v=>({source_id:v.source_id,source_hash:v.source_hash}));
  if(selected.length!==group.length){preview=await readers.catalog(chosen);need(object(preview)&&preview.dry_run===true&&preview.operational_effects===false&&str(preview.preview_hash,HASH)&&Array.isArray(preview.items)&&preview.items.length===selected.length,'CATALOG_PREVIEW_INVALID');}
  // Recheck every final row: no partial filtering of an immutable batch fingerprint.
  need(selected.every((v,j)=>admissible(preview.items[j],v)===null),'FINAL_PREVIEW_CHANGED');
  const commandId=uuid();need(str(commandId,UUID)&&commandId!==planId&&!batches.some(b=>b.command_id===commandId),'COMMAND_ID_INVALID');
  batches.push({command_id:commandId,entity:'products',items:chosen,preview_hash:preview.preview_hash,
   evidence:selected,mapper_review:preview.items.map(row=>({source_id:row.source_id,source_hash:row.source_hash,source_version:row.source_version,action:row.action,
    source_status:row.source_status,changes:row.changes.filter(c=>['active','kind','format','price'].includes(c.field))}))});
 }
 const created=now();need(created instanceof Date&&Number.isFinite(created.getTime()));
 return{profile:'proposal-product-adoption-plan-v1',plan_id:planId,actor,created_at:created.toISOString(),read_only:true,apply_enabled:false,requires_root_review:true,requires_repreview_before_apply:true,
  evidence_sha256:hash(JSON.stringify(snapshot)),evidence_exported_at:snapshot.exported_at,batches,blocked,
  summary:{selected: snapshot.items.length,planned:batches.reduce((n,b)=>n+b.items.length,0),blocked:blocked.length,batches:batches.length,proposals_checked:proposals.size,operational_effects:false}};
}
export async function savePrivateAdoptionPlan(path,plan){
 const file=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(JSON.stringify(plan,null,2)+'\n');await file.sync();}finally{await file.close();}
 const directory=await fs.open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
}
async function main(){
 need(process.env.FAGOO_READONLY_PLAN_CONFIRMED==='yes','READONLY_EXECUTION_NOT_AUTHORIZED');
 const{project,actor}=adoptionRuntimeConfig();
 need(process.argv.length===4&&process.argv[2]==='--evidence','EVIDENCE_ARGUMENT_REQUIRED');
 const privateDir=resolve(ROOT,'private/migration'),input=resolve(process.argv[3]);need(dirname(input)===privateDir&&basename(input).endsWith('.json'),'PRIVATE_EVIDENCE_REQUIRED');
 const bytes=await fs.readFile(input);need(bytes.length<=1048576,'EVIDENCE_SIZE');const evidence=validateAdoptionEvidence(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));bytes.fill(0);
 let secret;const started=Date.now();let calls=0;
 try{
  secret=process.env.SUPABASE_SERVICE_ROLE_KEY;need(typeof secret==='string'&&secret.length>20&&!/[\r\n]/.test(secret),'SERVICE_KEY_MISSING');
  const rpc=async(name,args)=>{
   need(['erp_origin_proposal_import_preview_v2','erp_catalog_import_preview'].includes(name)&&++calls<=550&&Date.now()-started<600000,'READONLY_SCOPE_OR_DEADLINE');
   const url=project+'/rest/v1/rpc/'+name,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.min(20000,600000-(Date.now()-started)));let reader;
   try{const response=await fetch(url,{method:'POST',redirect:'manual',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({...args,p_user_id:actor}),signal:abort.signal});
    if(!response.ok||response.redirected||response.url!==url){await response.body?.cancel();throw new Error('READONLY_RPC_UNAVAILABLE');}
    need(response.body&&Number(response.headers.get('content-length')||0)<=1048576,'READONLY_RESPONSE_LIMIT');reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
    for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;need(size<=1048576,'READONLY_RESPONSE_LIMIT');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);
   }finally{clearTimeout(timer);abort.abort();try{await reader?.cancel();}catch{}reader?.releaseLock();}
  };
  const plan=await planProposalProductAdoption({evidence,readers:createAdoptionReaders(rpc),actor}),path=resolve(privateDir,`origin-proposal-product-adoption-plan-${plan.plan_id}.json`);await savePrivateAdoptionPlan(path,plan);
  console.log(JSON.stringify({read_only:true,apply_enabled:false,...plan.summary,rpc_calls:calls,plan_sha256:hash(JSON.stringify(plan))}));
 }catch{throw new Error('READONLY_ADOPTION_PLAN_FAILED');}finally{secret=null;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('READONLY_ADOPTION_PLAN_FAILED');process.exitCode=1;});
