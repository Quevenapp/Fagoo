// Public metadata only; all UUIDs, names, amounts and protocol values are synthetic.
import {RULE_PROFILE_V2_HASH,ruleProfileByHash} from '../../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
export const id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000001`;
export const H='a'.repeat(64),at='2026-10-17T03:00:00.000Z';
export function statusPage(){return{profile:'fiscal-draft-status-v1',read_only:true,observed_at:at,can_emit:false,can_transmit:false,operational_effects:false,limit:25,has_more:false,next_cursor:null,items:[{
 draft:{id:id(1),model:'55',environment:'2',status:'draft',version:1,source_document_id:id(2),source_document_version:1,created_at:at,updated_at:at,order_number:'1',contact_name:'CLIENTE FICTICIO',total:'10.00'},
 numbering:{visibility:'available',reservation:{reservation_id:id(3),series:2,number:123,draft_version:1,reserved_at:at}},
 authorization:{visibility:'available',selection:'consumed',original:{command_id:id(4),attempt_id:id(5),candidate_id:id(6),candidate_version:1,signed_hash:H,origin:'operational',authorization_profile:'reviewed_subset_v1',policy_version:4,state:'authorized_homologation',created_at:at,used_at:at,finished_at:at,error_code:null,rule_review:{review_id:id(7),review_version:1,profile:ruleProfileByHash(RULE_PROFILE_V2_HASH).profile,profile_hash:RULE_PROFILE_V2_HASH,review_hash:H},result:{response_hash:H,response_size:100,processed_hash:H,processed_size:200,cstat:'104',protocol_cstat:'100',protocol_number:'135260000000001',received_at:at,rejection_code:null,recorded_at:at}},
 revalidation:{visibility:'none',result:null},basis:{draft_version:1,source_document_version:1,item_preparation_version:1,tax_preparation_version:1,completion_version:1,company_identity_version:1,company_fiscal_version:2,is_latest_job:true,is_latest_candidate:true,matches_current_preparation:true,differences:[]}}
}]};}
