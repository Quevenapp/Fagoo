import {spawn} from 'node:child_process';
import {X509Certificate,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {createRequire} from 'node:module';
import {boundedAsn1,inspectCertificate} from '../../fiscal-xml/src/certificate.mjs';
const require=createRequire(new URL('../../fiscal-xml/package.json',import.meta.url));
const {Certificate}=require('pkijs'),{Sequence,ObjectIdentifier,BitString}=require('asn1js');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const A1=/^2\.16\.76\.1\.2\.1\.[1-9][0-9]{0,9}$/;
const CLIENT_AUTH='1.3.6.1.5.5.7.3.2',ANY_EKU='2.5.29.37.0';
const SNAPSHOT_MAX_AGE=90*86400000;
export class TrustPolicyError extends Error {constructor(code){super(code);this.code=code;}}
const need=(value,code)=>{if(!value)throw new TrustPolicyError(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(k=>keys.includes(k));
const clock=value=>value instanceof Date&&Number.isFinite(value.getTime())&&value.getUTCFullYear()>=2000&&value.getUTCFullYear()<=2099;
function certificate(input){
 try{
  need(typeof input==='string'?input.length<=50000&&/^\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END CERTIFICATE-----\s*$/.test(input):input instanceof Uint8Array&&input.byteLength>0&&input.byteLength<=32768,'TRUST_CERTIFICATE_INPUT_INVALID');
  const native=new X509Certificate(input),parsed=new Certificate({schema:boundedAsn1(native.raw)}),extensions=parsed.extensions??[];
  need(extensions.length<=32&&new Set(extensions.map(e=>e.extnID)).size===extensions.length,'TRUST_DUPLICATE_OR_EXCESS_EXTENSIONS');
  return{native,parsed,extensions,fingerprint:hash(native.raw)};
 }catch(error){throw error instanceof TrustPolicyError?error:new TrustPolicyError('TRUST_CERTIFICATE_INVALID');}
}
function extension(cert,id){const value=cert.extensions.find(e=>e.extnID===id);return value?boundedAsn1(value.extnValue.valueBlock.valueHexView):null;}
function oids(value,policies=false){
 if(value===null)return[];need(value instanceof Sequence&&value.valueBlock.value.length>=1&&value.valueBlock.value.length<=32,'TRUST_EXTENSION_INVALID');
 const values=value.valueBlock.value.map(v=>{if(policies){need(v instanceof Sequence&&v.valueBlock.value.length>=1&&v.valueBlock.value.length<=2,'TRUST_EXTENSION_INVALID');v=v.valueBlock.value[0];}need(v instanceof ObjectIdentifier,'TRUST_EXTENSION_INVALID');const oid=v.valueBlock.toString();need(oid.length<=128,'TRUST_EXTENSION_INVALID');return oid;});
 need(new Set(values).size===values.length,'TRUST_DUPLICATE_POLICY_OR_USAGE');return values;
}
function profile(leaf,expectedHolderCnpj,now){
 const issues=[];let holderMatches=false,certificateCurrent=false,rsaBits=null;
 try{const checked=inspectCertificate(leaf.native.raw,{expectedHolderCnpj,now});holderMatches=true;certificateCurrent=true;rsaBits=checked.rsaBits;}
 catch(error){const accepted=['CERTIFICATE_HOLDER_MISMATCH','CERTIFICATE_EXPECTED_HOLDER_REQUIRED','CERTIFICATE_CNPJ_MISSING','CERTIFICATE_CNPJ_INVALID','CERTIFICATE_CNPJ_ENCODING_UNSUPPORTED','CERTIFICATE_NOT_CURRENTLY_VALID','CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED','CERTIFICATE_CA_NOT_ALLOWED','CERTIFICATE_RSA_KEY_UNSUPPORTED'];issues.push(accepted.includes(error?.code)?error.code:'CERTIFICATE_PROFILE_REJECTED');}
 const policies=oids(extension(leaf,'2.5.29.32'),true),eku=oids(extension(leaf,'2.5.29.37')),usage=extension(leaf,'2.5.29.15');
 need(usage===null||usage instanceof BitString,'TRUST_EXTENSION_INVALID');
 const signature=Boolean(usage&&(usage.valueBlock.valueHexView[0]&0x80)),a1Policies=policies.filter(v=>A1.test(v));
 const conflicting=policies.some(v=>/^2\.16\.76\.1\.2\./.test(v)&&!A1.test(v));
 if(!a1Policies.length)issues.push('A1_POLICY_OID_NOT_PRESENT');if(conflicting)issues.push('CERTIFICATE_POLICY_TYPE_CONFLICT');
 const clientUsage=eku.length===0?'unrestricted_absent':eku.includes(CLIENT_AUTH)?'explicit_client_auth':eku.includes(ANY_EKU)?'unrestricted_any':'client_auth_excluded';
 if(!signature&&!issues.includes('CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED'))issues.push('CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED');
 return{state:issues.length?'unsupported':'supported_declaration',holder_matches:holderMatches,time_valid:certificateCurrent,rsa_bits:rsaBits,a1_policy_oids:a1Policies,
  policy_allocation_independently_checked:false,full_icp_profile_conformity_attested:false,digital_signature_usage:signature,client_auth_usage:clientUsage,issues};
}
function execute(binary,args,timeoutMs){
 return new Promise((resolve,reject)=>{
  let limit=0,failed=false;const chunks=[];
  const child=spawn(binary,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',OPENSSL_CONF:'/dev/null'}});
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},timeoutMs);
  const collect=buffer=>{limit+=buffer.length;if(limit>65536){failed=true;buffer.fill(0);child.kill('SIGKILL');}else chunks.push(buffer);};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',()=>{failed=true;});
  child.once('close',code=>{clearTimeout(timer);const bytes=Buffer.concat(chunks);chunks.forEach(b=>b.fill(0));
   if(failed){bytes.fill(0);reject(new TrustPolicyError('TRUST_OPENSSL_UNAVAILABLE_TIMEOUT_OR_OUTPUT_LIMIT'));return;}
   // Never return OpenSSL diagnostics: they contain subject names and temporary paths.
   const diagnostic=bytes.toString('ascii'),errors=[...diagnostic.matchAll(/error (\d{1,3}) at \d+ depth lookup/g)].map(m=>Number(m[1]));
   const openssl3=/^OpenSSL 3\.\d+\.\d+\b/.test(diagnostic);bytes.fill(0);resolve({ok:code===0,errors:[...new Set(errors)],openssl3});
  });
 });
}
async function officialAnchors(){
 const manifest=JSON.parse(await readFile(new URL('../trust/manifest-20261016.json',import.meta.url),'utf8'));
 need(manifest.id==='iti-icp-brasil-roots-20261016'&&manifest.https_source_validation===true&&Array.isArray(manifest.anchors)&&manifest.anchors.length===8,'TRUST_MANIFEST_INVALID');
 const anchors=[],unsupported=[];
 for(const entry of manifest.anchors){
  need(/^icp-brasil-v(?:4|5|6|7|10|11|12|13)\.pem$/.test(entry.file)&&/^[a-f0-9]{64}$/.test(entry.sha256),'TRUST_MANIFEST_INVALID');
  const cert=certificate(await readFile(new URL(`../trust/${entry.file}`,import.meta.url)));
  need(cert.fingerprint===entry.sha256,'TRUST_ANCHOR_HASH_MISMATCH');
  if(entry.runtime_supported!==true){need(entry.id==='icp-brasil-v7','TRUST_MANIFEST_INVALID');unsupported.push(entry.id);continue;}
  need(cert.native.ca&&cert.native.checkIssued(cert.native)&&cert.native.verify(cert.native.publicKey),'TRUST_ANCHOR_INVALID');
  anchors.push({...cert,id:entry.id,purpose:entry.purpose});
 }
 return{anchors,id:manifest.id,source:'iti_pinned_snapshot',observedAt:manifest.retrieved_at,unsupported};
}
function candidatePaths(leaf,intermediates,anchors,deadline){
 const roots=new Map(anchors.map(c=>[c.fingerprint,c])),pool=[...intermediates,...anchors].filter((c,i,a)=>a.findIndex(v=>v.fingerprint===c.fingerprint)===i).sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
 const paths=[];let visited=0;
 const visit=path=>{need(Date.now()<deadline,'TRUST_EVALUATION_TIMEOUT');need(++visited<=256,'TRUST_PATH_SEARCH_LIMIT');const child=path.at(-1),root=roots.get(child.fingerprint);
  if(root){paths.push({chain:path,root});need(paths.length<=8,'TRUST_PATH_SEARCH_LIMIT');return;}
  if(path.length>=10)return;
  for(const parent of pool){need(Date.now()<deadline,'TRUST_EVALUATION_TIMEOUT');if(!parent.native.ca||path.some(v=>v.fingerprint===parent.fingerprint))continue;let issued=false;try{issued=child.native.checkIssued(parent.native)&&child.native.verify(parent.native.publicKey);}catch{}if(issued)visit([...path,parent]);}
 };visit([leaf]);return paths;
}
/** Offline public-certificate assessment. No PFX/private key, AIA/CRL fetch, TLS or fiscal operation is available. */
export async function createTrustPolicy({binaryPath,timeoutMs=5000,customTrustAnchors}={}){
 need(typeof binaryPath==='string'&&isAbsolute(binaryPath)&&!binaryPath.includes('\0'),'TRUST_OPENSSL_PATH_INVALID');
 need(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=10000,'TRUST_TIMEOUT_INVALID');
 const openssl=await execute(binaryPath,['version'],timeoutMs);need(openssl.ok&&openssl.openssl3,'TRUST_OPENSSL_3_REQUIRED');
 let store;
 if(customTrustAnchors!==undefined){
  need(Array.isArray(customTrustAnchors)&&customTrustAnchors.length>=1&&customTrustAnchors.length<=16,'TRUST_ANCHORS_INVALID');
  const anchors=customTrustAnchors.map(c=>certificate(c));need(new Set(anchors.map(c=>c.fingerprint)).size===anchors.length,'TRUST_DUPLICATE_ANCHOR');
  for(const cert of anchors)need(cert.native.ca&&cert.native.checkIssued(cert.native)&&cert.native.verify(cert.native.publicKey),'TRUST_ANCHOR_INVALID');
  store={anchors:anchors.map(c=>({...c,id:c.fingerprint,purpose:'custom'})),id:'explicit-custom-roots',source:'explicit_custom',observedAt:null,unsupported:[]};
 }else store=await officialAnchors();
 return Object.freeze({
  trustStore:Object.freeze({id:store.id,source:store.source,anchors:store.anchors.length,unsupported_anchors:Object.freeze([...store.unsupported])}),
  async evaluate(input){
   need(exact(input,['certificate','intermediates','expectedHolderCnpj','now'])&&input.certificate!==undefined,'TRUST_REQUEST_INVALID');
   const now=input.now??new Date();need(clock(now),'TRUST_CLOCK_INVALID');const at=new Date(now.getTime()),deadline=Date.now()+timeoutMs;
   need(Array.isArray(input.intermediates??[])&&(input.intermediates??[]).length<=10,'TRUST_INTERMEDIATES_INVALID');
   const leaf=certificate(input.certificate),intermediates=(input.intermediates??[]).map(certificate);
   need(new Set([leaf,...intermediates].map(c=>c.fingerprint)).size===1+intermediates.length,'TRUST_DUPLICATE_CERTIFICATE');
   for(const cert of [leaf,...intermediates]){let key;try{key=cert.native.publicKey;}catch{throw new TrustPolicyError('TRUST_PUBLIC_KEY_UNSUPPORTED');}need(['rsa','ec','ed25519','ed448'].includes(key.asymmetricKeyType)&&!(key.asymmetricKeyType==='rsa'&&key.asymmetricKeyDetails.modulusLength>8192),'TRUST_PUBLIC_KEY_UNSUPPORTED');}
   const declared=profile(leaf,input.expectedHolderCnpj,at),paths=candidatePaths(leaf,intermediates,store.anchors,deadline),errors=[];
   let selected=null,selectedScore=-1,clientPurpose=false,folder;
   try{
    if(paths.length){folder=await mkdtemp(join(tmpdir(),`brufap-public-trust-${process.pid}-`));await writeFile(join(folder,'leaf.pem'),leaf.native.toString(),{mode:0o600,flag:'wx'});}
    for(const path of paths){
     await writeFile(join(folder,'root.pem'),path.root.native.toString(),{mode:0o600});
     const middle=path.chain.slice(1,-1);if(middle.length)await writeFile(join(folder,'intermediates.pem'),middle.map(c=>c.native.toString()).join('\n'),{mode:0o600});
     const args=['verify','-no-CAfile','-no-CApath','-no-CAstore','-trusted',join(folder,'root.pem'),'-x509_strict','-check_ss_sig','-auth_level','2','-verify_depth','8','-attime',String(Math.floor(at.getTime()/1000)),'-policy_check',...(middle.length?['-untrusted',join(folder,'intermediates.pem')]:[])];
     const run=async(extra=[])=>{const remaining=deadline-Date.now();need(remaining>0,'TRUST_EVALUATION_TIMEOUT');return execute(binaryPath,[...args,...extra,join(folder,'leaf.pem')],remaining);};
     const basic=await run();errors.push(...basic.errors);if(!basic.ok)continue;
     const client=await run(['-purpose','sslclient']),score=(client.ok?2:0)+(path.root.purpose!=='code-signing'?1:0);
     if(score>selectedScore){selected=path;clientPurpose=client.ok;selectedScore=score;}if(score===3)break;
    }
   }finally{if(folder)await rm(folder,{recursive:true,force:true});}
   const snapshotFresh=store.observedAt!==null&&at.getTime()>=Date.parse(store.observedAt)&&at.getTime()-Date.parse(store.observedAt)<=SNAPSHOT_MAX_AGE;
   const chainValidated=selected!==null,icp=chainValidated&&store.source==='iti_pinned_snapshot',rootPurposeAllowed=selected!==null&&selected.root.purpose!=='code-signing';
   const blockers=[...declared.issues];if(!chainValidated)blockers.push('TRUST_CHAIN_NOT_VALIDATED');if(store.source!=='iti_pinned_snapshot')blockers.push('ICP_TRUST_NOT_ESTABLISHED');else if(!snapshotFresh)blockers.push('TRUST_SNAPSHOT_REVIEW_REQUIRED');
   if(selected&&!rootPurposeAllowed)blockers.push('ROOT_PURPOSE_NOT_SUPPORTED_FOR_FISCAL');if(!clientPurpose)blockers.push('TLS_CLIENT_PURPOSE_NOT_VALIDATED');
   blockers.push('REVOCATION_UNKNOWN_OFFLINE','PRIVATE_KEY_AND_CUSTODY_NOT_CHECKED','ENDPOINT_AND_OPERATION_NOT_AUTHORIZED');
   return Object.freeze({assessment:'public-certificate-offline-v1',checked_at:at.toISOString(),certificate_sha256:leaf.fingerprint,
    trust:Object.freeze({store_id:store.id,source:store.source,snapshot_fresh:snapshotFresh,chain_validated:chainValidated,icp_brasil_chain_validated:icp,root_id:selected?.root.id??null,chain_sha256:Object.freeze(selected?selected.chain.map(c=>c.fingerprint):[]),unsupported_anchors:Object.freeze([...store.unsupported]),openssl_error_codes:Object.freeze(chainValidated?[]:[...new Set(errors)])}),
    profile:Object.freeze({...declared,a1_policy_oids:Object.freeze(declared.a1_policy_oids),issues:Object.freeze(declared.issues),root_purpose_supported:rootPurposeAllowed,tls_client_purpose_validated:clientPurpose}),
    revocation:Object.freeze({state:'unknown_offline',checked:false,online_checked:false}),
    gates:Object.freeze({trusted_chain:icp&&snapshotFresh,declared_a1_profile:declared.state==='supported_declaration'&&rootPurposeAllowed,tls_client_purpose:clientPurpose,revocation:false,private_key_and_custody:false,endpoint_and_operation:false}),
    blockers:Object.freeze([...new Set(blockers)]),can_emit:false,can_transmit:false});
  },
 });
}
