import {randomUUID} from 'node:crypto';
import {canonical,hash,SUBSET_REVIEW_FLAGS,SUBSET_SCHEMA} from '../src/subset-review-dto.mjs';
import {SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH} from '../src/sp-crt1-rule-manifest.mjs';
export function sample(count=1,statement=null){
 const actor=randomUUID(),candidate=randomUUID(),command=randomUUID(),signed=hash('synthetic signed bytes'),facts=hash('synthetic facts');
 const declaration={document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:Array.from({length:count},(_,i)=>({position:i+1,item_hash:hash('item'+i),classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:statement===null?null:{eligibility:'reviewed_lc123_art23',base:'100.00',rate:'1.00',amount:'1.00',period:'2026-10',source_hash:hash('source'),statement}}))};
 const schema={...SUBSET_SCHEMA,xml_hash:signed};
 const body={id:command,version:1,candidate_id:candidate,signed_hash:signed,facts_hash:facts,profile:SP_CRT1_RULE_MANIFEST.profile,profile_hash:SP_CRT1_RULE_MANIFEST_HASH,reviewed_by:actor,reviewed_at:new Date(Date.now()-1000).toISOString(),valid_until:new Date(Date.now()+60000).toISOString(),...declaration};
 const record={...body,review_hash:hash(canonical(body))},receipt={review_id:command,command_id:command,review_version:1,reviewed_by:actor,reviewed_at:body.reviewed_at,valid_until:body.valid_until,candidate_id:candidate,candidate_version:1,signed_hash:signed,facts_hash:facts,profile:body.profile,profile_hash:body.profile_hash,schema,review_hash:record.review_hash,coverage:SUBSET_REVIEW_FLAGS.coverage};
 const value={...SUBSET_REVIEW_FLAGS,actor,candidate_id:candidate,candidate_version:1,signed_hash:signed,facts_hash:facts,profile_hash:body.profile_hash,read_only:false,replayed:false,receipt,current:{latest_review_id:command,latest_review_version:1,is_latest:true,reviewer_active:true,within_validity:true},record_text:canonical(record)};
 const args={p_user_id:actor,p_command_id:command,p_candidate_id:candidate,p_expected_candidate_version:1,p_signed_hash:signed,p_expected_review_version:0,p_facts_hash:facts,p_profile_hash:body.profile_hash,p_schema:schema,p_valid_until:body.valid_until,p_declaration_text:canonical(declaration)};
 const getArgs={p_user_id:actor,p_candidate_id:candidate,p_candidate_version:1,p_signed_hash:signed,p_facts_hash:facts,p_profile_hash:body.profile_hash};
 const query={actor,candidateId:candidate,candidateVersion:1,signedHash:signed,factsHash:facts,profile:body.profile,profileHash:body.profile_hash,items:declaration.items.map(x=>({position:x.position,itemHash:x.item_hash}))};
 return{actor,record,value,read:{...value,read_only:true},args,getArgs,query};
}
