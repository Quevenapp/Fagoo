/** Internal050 DTO only. Credential references from use must never become a public HTTP response. */
import {buildAccessKey,isValidCnpj,validFiscalTimestamp} from '../../fiscal-core/src/identity.mjs';
export class FiscalSignedRpcError extends Error{constructor(code){super(code);this.name='FiscalSignedRpcError';this.code=code;}}
export const need=(value,code='FISCAL_SIGNED_RPC_RESPONSE_INVALID')=>{if(!value)throw new FiscalSignedRpcError(code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const fields=(v,required,optional=[])=>plain(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...required,...optional].includes(k)
 &&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'))&&required.every(k=>Object.hasOwn(v,k));
export const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const integer=(v,max=2147483647,min=1)=>Number.isInteger(v)&&v>=min&&v<=max;
export const FAILURES=new Set(['XML_INPUT_INVALID','SIGNATURE_INVALID','XSD_INVALID','QR_INVALID','XML_SIZE_LIMIT','CERTIFICATE_INVALID']);
const PROFILE=Object.freeze({candidate_profile:'signed-homologation-sp-v1',signature_profile:'nfe400-rsa-sha1-c14n-v1',schema_profile:'pl010f-v1.04',
 schema_manifest_hash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validator_version:'fiscal-schema-runner-v1',
 validator_hash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6',nfce_qr_profile:'sp-homologation-online-qr-v3'});
const FLAGS=Object.freeze({data_mode:'fiscal_signed_candidate',environment:'2',purpose:'offline-homologation',candidate_profile:PROFILE.candidate_profile,
 tax_rules_validated:false,icp_brasil_chain_validated:false,revocation_checked:false,authorized:false,can_emit:false,can_transmit:false,financial_mutation_performed:false,stock_mutation_performed:false});
const FLAG_KEYS=[...Object.keys(FLAGS),'signed','signature_verified','xsd_validated'];
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const exact=(v,keys)=>need(fields(v,keys));
const flag=(v,stored)=>{need(Object.entries(FLAGS).every(([k,x])=>v[k]===x)&&['signed','signature_verified','xsd_validated'].every(k=>v[k]===stored));return{...FLAGS,signed:stored,signature_verified:stored,xsd_validated:stored};};
export function timestamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v))return false;
 const t=Date.parse(v);if(!Number.isFinite(t))return false;const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return new Date(t+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
function receipt(v){
 const keys=['candidate_id','version','unsigned_job_id','reservation_id','draft_id','model','unsigned_hash','unsigned_size','basis_hash','completion_version','completion_hash','a1_version','credential_id','certificate_fingerprint','profile','created_at'];exact(v,keys);
 need(['candidate_id','unsigned_job_id','reservation_id','draft_id','credential_id'].every(k=>id(v[k]))&&['version','completion_version','a1_version'].every(k=>integer(v[k]))
  &&['unsigned_hash','basis_hash','completion_hash','certificate_fingerprint'].every(k=>sha(v[k]))&&['55','65'].includes(v.model)&&integer(v.unsigned_size,480000)&&timestamp(v.created_at));
 exact(v.profile,Object.keys(PROFILE));need(Object.entries(PROFILE).every(([k,x])=>v.profile[k]===x));return{...pick(v,keys),profile:{...PROFILE}};
}
export function evidence(v,{hash,fingerprint,model,code='FISCAL_SIGNED_RPC_RESPONSE_INVALID'}={}){
 const ok=x=>need(x,code);ok(fields(v,['signature','xsd','qr']));const s=v.signature,x=v.xsd,q=v.qr;
 ok(fields(s,['xml_hash','certificate_fingerprint','signed_content_hash','reference_digest','profile'])
  &&fields(x,['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash'])&&fields(q,['profile','verified']));
 ok(sha(s.xml_hash)&&sha(s.certificate_fingerprint)&&sha(s.signed_content_hash)&&s.profile===PROFILE.signature_profile
  &&typeof s.reference_digest==='string'&&/^[A-Za-z0-9+/]{27}=$/.test(s.reference_digest)
  &&Buffer.from(s.reference_digest,'base64').length===20&&Buffer.from(s.reference_digest,'base64').toString('base64')===s.reference_digest);
 ok(x.xml_hash===s.xml_hash&&x.schema_profile===PROFILE.schema_profile&&x.manifest_hash===PROFILE.schema_manifest_hash&&x.validator_version===PROFILE.validator_version&&x.validator_hash===PROFILE.validator_hash);
 ok(hash===undefined||s.xml_hash===hash);ok(fingerprint===undefined||s.certificate_fingerprint===fingerprint);
 ok(q.profile===null&&q.verified===false||q.profile===PROFILE.nfce_qr_profile&&q.verified===true);
 if(model!==undefined)ok(model==='65'?q.profile===PROFILE.nfce_qr_profile&&q.verified===true:q.profile===null&&q.verified===false);
 return{signature:pick(s,['xml_hash','certificate_fingerprint','signed_content_hash','reference_digest','profile']),xsd:pick(x,['xml_hash','schema_profile','manifest_hash','validator_version','validator_hash']),qr:{profile:q.profile,verified:q.verified}};
}
function current(v,r){
 const keys=['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];exact(v,keys);
 need(['pending','stored','failed'].includes(v.state)&&integer(v.attempt_count,100)&&integer(v.a1_version,2147483647,0)&&id(v.latest_candidate_id)&&integer(v.latest_candidate_version)&&v.latest_candidate_version>=r.version
  &&(v.state==='pending'?timestamp(v.lease_until):v.lease_until===null)&&['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'].every(k=>typeof v[k]==='boolean'));
 need(v.is_latest_candidate===(v.latest_candidate_id===r.candidate_id)&&v.is_latest_candidate===(v.latest_candidate_version===r.version));
 need(v.a1_changed===(v.a1_version!==r.a1_version));
 need(v.artifact_current===(v.state==='stored'&&v.is_latest_candidate&&!v.a1_changed&&v.certificate_time_valid_now&&v.unsigned_artifact_current&&v.series_enabled));
 return pick(v,keys);
}
function view(v){
 const r=receipt(v.receipt),c=current(v.current,r),a=v.artifact;flag(v,c.state==='stored');
 need(c.state==='failed'?FAILURES.has(v.error_code):v.error_code===null);let artifact=null;
 if(c.state==='stored'){
  exact(a,['signed_hash','size_bytes','evidence','created_at']);need(sha(a.signed_hash)&&integer(a.size_bytes,512000)&&timestamp(a.created_at));
  artifact={signed_hash:a.signed_hash,size_bytes:a.size_bytes,evidence:evidence(a.evidence,{hash:a.signed_hash,fingerprint:r.certificate_fingerprint,model:r.model}),created_at:a.created_at};
 }else need(a===null);
 return{...flag(v,c.state==='stored'),receipt:r,current:c,error_code:v.error_code,artifact};
}
const VIEW_KEYS=[...FLAG_KEYS,'receipt','current','error_code','artifact'];
function same(value,expected){need(JSON.stringify(value)===JSON.stringify(expected));}
function privateUse(v,args){
 exact(v,[...FLAG_KEYS,'private_executor_only','receipt','lease_id','lease_until','used_at','identity','access_key','unsigned_object','credential_context','credential_metadata','credential_object']);flag(v,false);
 const r=receipt(v.receipt),i=v.identity,ctx=v.credential_context,m=v.credential_metadata,o=v.credential_object,u=v.unsigned_object;
 need(v.private_executor_only===true&&r.candidate_id===args.p_candidate_id&&v.lease_id===args.p_lease_id&&timestamp(v.lease_until)&&timestamp(v.used_at)&&Date.parse(v.used_at)<=Date.parse(v.lease_until));
 exact(i,['cUF','cnpj','model','environment','series','number','issuedAt','cNF','tpEmis']);
 need(i.cUF==='35'&&i.model===r.model&&i.environment==='2'&&i.tpEmis==='1'&&isValidCnpj(i.cnpj)
  &&typeof i.series==='string'&&/^(0|[1-9]\d{0,2})$/.test(i.series)&&Number(i.series)<=889
  &&typeof i.number==='string'&&/^[1-9]\d{0,8}$/.test(i.number)&&typeof i.cNF==='string'&&/^\d{8}$/.test(i.cNF)&&validFiscalTimestamp(i.issuedAt)&&i.issuedAt.endsWith('-03:00'));
 need(v.access_key===buildAccessKey(i));
 exact(ctx,['vault_id','credential_id','credential_version','company_identity_version','holder_cnpj','environment','purpose']);
 need(id(ctx.vault_id)&&ctx.credential_id===r.credential_id&&integer(ctx.credential_version)&&integer(ctx.company_identity_version)&&ctx.holder_cnpj===i.cnpj&&ctx.environment==='2'&&ctx.purpose==='offline-homologation');
 const metaKeys=['profile','legacy_provider_enabled','pfx_mac','pfx_mac_iterations','fingerprint_sha256','holder_cnpj','not_before','not_after','rsa_bits','presented_chain','validated_at','key_matches_certificate','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'];exact(m,metaKeys);
 need(m.profile==='openssl3-pkcs12'&&typeof m.legacy_provider_enabled==='boolean'&&['sha1','sha224','sha256','sha384','sha512'].includes(m.pfx_mac)&&integer(m.pfx_mac_iterations,1000000)
  &&m.fingerprint_sha256===r.certificate_fingerprint&&m.holder_cnpj===ctx.holder_cnpj&&[2048,3072,4096].includes(m.rsa_bits)
  &&['not_before','not_after','validated_at'].every(k=>typeof m[k]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m[k])&&timestamp(m[k]))
  &&m.not_before<=m.validated_at&&m.validated_at<=m.not_after&&Array.isArray(m.presented_chain)&&m.presented_chain.length>=1&&m.presented_chain.length<=10&&m.presented_chain.every(sha)&&new Set(m.presented_chain).size===m.presented_chain.length&&m.presented_chain[0]===m.fingerprint_sha256
  &&m.key_matches_certificate===true&&m.presented_chain_links_checked===true&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'].every(k=>m[k]===false));
 exact(u,['bucket','path','hash','size']);need(u.bucket==='brufap-fiscal-artifacts'&&u.hash===r.unsigned_hash&&u.size===r.unsigned_size&&u.path===`jobs/${r.unsigned_job_id}/${r.unsigned_hash}.xml`);
 exact(o,['bucket','path','hash','size','key_id']);need(o.bucket==='brufap-a1-vault'&&sha(o.hash)&&integer(o.size,1500000)&&typeof o.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(o.key_id)&&o.path===`credentials/${r.credential_id}/${o.hash}.json`);
 return{...flag(v,false),private_executor_only:true,receipt:r,lease_id:v.lease_id,lease_until:v.lease_until,used_at:v.used_at,identity:{...i},access_key:v.access_key,
  unsigned_object:{...u},credential_context:{...ctx},credential_metadata:{...pick(m,metaKeys),presented_chain:[...m.presented_chain]},credential_object:{...o}};
}
export function projectResponse(name,v,args){
 need(plain(v));const action=name.slice('erp_fiscal_signed_'.length);
 if(action==='use')return privateUse(v,args);
 if(action==='history'){
  exact(v,[...FLAG_KEYS,'read_only','unsigned_job_id','items','limit','has_more','next_cursor']);flag(v,false);
  need(v.read_only===true&&v.unsigned_job_id===args.p_unsigned_job_id&&v.limit===args.p_limit&&Array.isArray(v.items)&&v.items.length<=args.p_limit&&typeof v.has_more==='boolean');
  let previous=args.p_before??2147483648;const ids=new Set(),items=v.items.map(row=>{exact(row,VIEW_KEYS);const result=view(row);need(result.receipt.unsigned_job_id===args.p_unsigned_job_id&&result.receipt.version<previous&&!ids.has(result.receipt.candidate_id));previous=result.receipt.version;ids.add(result.receipt.candidate_id);return result;});
  need(v.has_more?items.length===args.p_limit&&items.length>0&&v.next_cursor===items.at(-1).receipt.version:v.next_cursor===null);
  return{...flag(v,false),read_only:true,unsigned_job_id:v.unsigned_job_id,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
 }
 const extras=action==='begin'?['command_id','replayed','execution']:action==='command'?['command_id','read_only']:action==='get'?['read_only']:['replayed'];
 exact(v,[...VIEW_KEYS,...extras]);const result=view(v),r=result.receipt,c=result.current;
 if(args.p_candidate_id!==undefined)need(r.candidate_id===args.p_candidate_id);
 if(['get','command'].includes(action)){need(v.read_only===true);result.read_only=true;}
 else{need(typeof v.replayed==='boolean');result.replayed=v.replayed;}
 if(['begin','command'].includes(action)){need(v.command_id===args.p_command_id);result.command_id=v.command_id;}
 if(action==='begin'){
  need(r.unsigned_job_id===args.p_unsigned_job_id&&r.unsigned_hash===args.p_unsigned_hash&&r.basis_hash===args.p_basis_hash&&r.a1_version===args.p_expected_a1_version);
  if(v.execution!==null){exact(v.execution,['private_executor_only','lease_id','lease_until']);need(v.execution.private_executor_only===true&&id(v.execution.lease_id)&&c.state==='pending'&&v.execution.lease_until===c.lease_until);result.execution={...v.execution};}else result.execution=null;
 }
 if(action==='finish'){need(c.state==='stored'&&result.artifact.signed_hash===args.p_signed_hash&&result.artifact.size_bytes===args.p_size_bytes);same(result.artifact.evidence,evidence(args.p_evidence));}
 if(action==='fail')need(c.state==='failed'&&result.error_code===args.p_error_code);
 return result;
}
