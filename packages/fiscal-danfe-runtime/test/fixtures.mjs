import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {candidateFixture,digest as hash} from '../../fiscal-danfe/test/fixtures.mjs';
import {extractCandidatePreview,renderCandidateHtml} from '../../fiscal-danfe/src/index.mjs';
import {response,actor} from '../../fiscal-signed-rpc/test/fixtures.mjs';
import {FLAGS,CURRENT_KEYS} from '../src/dto.mjs';
import {createDanfeRuntimeHandler} from '../src/handler.mjs';
import {signRuntimeRequest,digest} from '../src/auth.mjs';
export {actor};
export const secret=new Uint8Array(32).fill(29),keyId='synthetic',audience='synthetic-danfe';
export async function fixture({model='55',transformUnsigned}={}){
 const f=await candidateFixture({model,transformUnsigned}),raw=response('get'),id=f.context.candidate_id;
 raw.receipt.candidate_id=id;raw.receipt.model=model;raw.current.latest_candidate_id=id;
 raw.artifact.signed_hash=f.context.sha256;raw.artifact.size_bytes=f.bytes.length;
 raw.artifact.evidence.signature.xml_hash=f.context.sha256;raw.artifact.evidence.xsd.xml_hash=f.context.sha256;
 raw.artifact.evidence.qr={profile:model==='65'?'sp-homologation-online-qr-v3':null,verified:model==='65'};
 const printed=renderCandidateHtml(extractCandidatePreview(f.bytes,f.context));
 const dto={...FLAGS,candidate_id:id,candidate_version:1,model,source_sha256:f.context.sha256,source_size_bytes:f.bytes.length,
  html:printed.html,html_sha256:printed.sha256,html_size_bytes:Buffer.byteLength(printed.html),profile:printed.profile,page_count:printed.page_count,current:Object.fromEntries(CURRENT_KEYS.map(k=>[k,raw.current[k]]))};
 const calls=[];
 const ports={rpc:async(name,args,opts)=>{assert.equal(name,'erp_fiscal_signed_get');assert.deepEqual(args,{p_user_id:actor,p_candidate_id:id});assert.ok(opts.signal instanceof AbortSignal);calls.push('rpc');return structuredClone(raw);},
  storage:{read:async opts=>{assert.equal(opts.bucket,'brufap-fiscal-artifacts');assert.equal(opts.key,`candidates/${id}/${hash(f.bytes)}.xml`);calls.push('read');return new Response(new Uint8Array(f.bytes),{headers:{'Content-Type':'application/octet-stream','Content-Length':String(f.bytes.length)}});}}};
 const handler=(patch={})=>createDanfeRuntimeHandler({...ports,transportSecret:secret,transportKeyId:keyId,audience,...patch});
 return{...f,id,raw,dto,calls,ports,handler};
}
export async function request(id,{signal,user=actor,claimedBody=new Uint8Array(),headers={}}={}){
 const path=`/internal/v1/fiscal-danfe/candidates/${id}/preview`,authorization=await signRuntimeRequest({secretBytes:secret,keyId,audience,actor:user,nonce:randomUUID(),method:'GET',path,bodyHash:await digest(claimedBody)});
 return new Request('http://runtime.internal'+path,{signal,headers:{Authorization:authorization,...headers}});
}
export async function result(response,status=200){
 assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');const v=await response.json();
 assert.doesNotMatch(JSON.stringify(v),/credential_id|certificate_fingerprint|lease_id|private_executor_only|brufap-fiscal-artifacts|PRIVATE_DIAGNOSTIC|<NFe/);
 return v;
}
