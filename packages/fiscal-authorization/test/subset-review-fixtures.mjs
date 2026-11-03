import './synthetic-october-clock.mjs';
// All data, certificates, HTTP and Storage are synthetic. No network or remote database.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-sql-fixture.mjs';
import {prepareAuthorization} from '../src/index.mjs';
import {pinnedCandidateCertificate} from '../src/pinned-certificate.mjs';
import {inspectSpCrt1Candidate,createSpCrt1ReviewReader} from '../src/sp-crt1-rule-profile.mjs';
import {canonical,hash} from '../src/subset-review-dto.mjs';
import {createSubsetReviewRpc} from '../src/subset-review-rpc.mjs';
import {createPersistedSubsetReviewReader} from '../src/subset-review-reader.mjs';
export {canonical,hash};
export const until='2026-10-25T23:59:59.000Z';
export const credit=statement=>({eligibility:'reviewed_lc123_art23',base:'100.00',rate:'1.00',amount:'1.00',period:'2026-10',source_hash:hash('synthetic source'),statement});
export function declarations(q){return{document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:q.items.map(x=>({position:x.position,item_hash:x.itemHash,classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:null}))};}
export async function subsetFixture(options){
 const f=await serviceFixture(options);try{
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160068_fiscal_subset_review.sql',import.meta.url),'utf8'));
  const rpcCalls=[];
  const http=async(url,o)=>{const name=url.split('/').at(-1),args=JSON.parse(Buffer.from(o.body).toString());rpcCalls.push({name,args});try{return Response.json(await f.callSql(name,args));}catch(e){return Response.json({code:e.code,message:'PRIVATE_SENTINEL_NEVER_EXPOSE'},{status:400});}};
  const rpc=createSubsetReviewRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-test-service-key-not-secret',fetchImpl:http});
  const reader=createPersistedSubsetReviewReader({rpc});
  async function candidate(model='55',count=1){
   const source=await f.source(model,count),s=source.stored,bytes=f.files.get(`candidates/${s.receipt.candidate_id}/${s.artifact.signed_hash}.xml`),at=new Date(s.artifact.created_at);
   const cert=pinnedCandidateCertificate({signedBytes:bytes,signedHash:s.artifact.signed_hash,signedSize:s.artifact.size_bytes,certificateFingerprint:s.receipt.certificate_fingerprint,model,now:at});
   const request=prepareAuthorization({signedBytes:bytes,expectedSignedHash:s.artifact.signed_hash,expectedModel:model,expectedIssuerCnpj:cert.issuerCnpj,expectedHolderCnpj:cert.issuerCnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:s.receipt.certificate_fingerprint,now:at,batchId:'1'});
   const handle=inspectSpCrt1Candidate({candidateId:s.receipt.candidate_id,request});let query;
   await createSpCrt1ReviewReader({readReview:async q=>{query=q;return null;}})({candidate:handle,now:new Date()});
   const q={...query,actor:f.users.fiscal,candidateVersion:s.receipt.version},declaration=declarations(q);
   const args={p_user_id:q.actor,p_command_id:randomUUID(),p_candidate_id:q.candidateId,p_expected_candidate_version:q.candidateVersion,p_signed_hash:q.signedHash,p_expected_review_version:0,p_facts_hash:q.factsHash,p_profile_hash:q.profileHash,p_schema:s.artifact.evidence.xsd,p_valid_until:until,p_declaration_text:canonical(declaration)};
   const getArgs={p_user_id:q.actor,p_candidate_id:q.candidateId,p_candidate_version:q.candidateVersion,p_signed_hash:q.signedHash,p_facts_hash:q.factsHash,p_profile_hash:q.profileHash};
   return{...source,request,handle,q,declaration,args,getArgs};
  }
  const call=(action,args)=>f.callSql('erp_fiscal_subset_review_'+action,args);
  const opts=()=>({signal:new AbortController().signal,deadline:Date.now()+45000});
  return{...f,candidate,call,rpc,http,rpcCalls,reader,opts};
 }catch(e){await f.close();throw e;}
}
