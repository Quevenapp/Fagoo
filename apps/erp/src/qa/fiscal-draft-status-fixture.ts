/** QA_SYNTHETIC_FISCAL_STATUS: local summaries; no network, certificate or write port. */
import type {AccessState} from '../lib/real-access';
import type {FiscalDraftStatusController} from '../lib/fiscal-draft-status-model';
import type {FiscalDraftStatusPage,FiscalDraftStatusRow,FiscalRecordedResult} from '../../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
import {captureFiscalDraftStatusRequest,FISCAL_DRAFT_STATUS_PATH} from '../lib/fiscal-draft-status-request.ts';
import {ruleProfileByHash,RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH} from '../../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
export const FISCAL_STATUS_QA_ACTOR='a0000000-0000-4000-8000-000000000082';
export const fiscalStatusQaId=(n:number)=>`82000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const FISCAL_STATUS_QA_TIME='2026-10-17T05:00:00.000Z';
const h=(c:string)=>c.repeat(64);
const reviewProfile=(hash:string)=>{const profile=ruleProfileByHash(hash)!;return{profile:profile.profile,profile_hash:profile.profileHash};};
function result(validation=false):FiscalRecordedResult{return{response_hash:h('a'),response_size:3000,processed_hash:validation?null:h('b'),processed_size:validation?null:5000,cstat:validation?null:'104',protocol_cstat:validation?null:'100',protocol_number:validation?null:'12345678901234567',received_at:validation?null:'2026-10-17T04:59:20.000Z',rejection_code:validation?'SOAP_INVALID':null,recorded_at:FISCAL_STATUS_QA_TIME};}
export function fiscalStatusQaRow(n=1,model:'55'|'65'='55'):FiscalDraftStatusRow{
 return{draft:{id:fiscalStatusQaId(n),model,environment:'2',status:'draft',version:1,source_document_id:fiscalStatusQaId(100+n),source_document_version:2,created_at:'2026-10-17T04:00:00.000Z',updated_at:'2026-10-17T04:30:00.000Z',order_number:String(n),contact_name:'Destinatário sintético QA',total:'84.81'},numbering:{visibility:'available',reservation:{reservation_id:fiscalStatusQaId(200+n),series:2,number:900100+n,draft_version:1,reserved_at:'2026-10-17T04:45:00.000Z'}},authorization:{visibility:'available',selection:'consumed',original:{command_id:fiscalStatusQaId(300+n),attempt_id:fiscalStatusQaId(400+n),candidate_id:fiscalStatusQaId(500+n),candidate_version:1,signed_hash:h('c'),origin:'operational',authorization_profile:'reviewed_subset_v1',policy_version:2,state:'authorized_homologation',created_at:'2026-10-17T04:59:00.000Z',used_at:'2026-10-17T04:59:01.000Z',finished_at:FISCAL_STATUS_QA_TIME,error_code:null,rule_review:{review_id:fiscalStatusQaId(600+n),review_version:1,...reviewProfile(RULE_PROFILE_V2_HASH),review_hash:h('e')},result:result()},revalidation:{visibility:'none',result:null},basis:{draft_version:1,source_document_version:2,item_preparation_version:1,tax_preparation_version:1,completion_version:1,company_identity_version:1,company_fiscal_version:1,is_latest_job:true,is_latest_candidate:true,matches_current_preparation:true,differences:[]}}};
}
export function fiscalStatusQaRows():FiscalDraftStatusRow[]{
 const approved=fiscalStatusQaRow(1,'55');Object.assign(approved.authorization.original!.rule_review!,reviewProfile(RULE_PROFILE_V1_HASH));approved.authorization.original!.state='review_required';approved.authorization.original!.result=result(true);
 approved.authorization.revalidation={visibility:'available',result:{...result(),command_id:fiscalStatusQaId(701),parser_profile:'authorization-stored-response-utf8-v1',parser_manifest_hash:'26a4ba4dcc9dbad2e196ae76136fbe8465f5dd235ca7aa30c468c192a8cce033',source_hash:h('a'),state:'authorized_homologation'}};
 const rejected=fiscalStatusQaRow(2,'65');rejected.authorization.original!.state='rejected';rejected.authorization.original!.result={...result(),processed_hash:null,processed_size:null,cstat:'245',protocol_cstat:null,protocol_number:null};
 const reserved=fiscalStatusQaRow(3,'65');reserved.authorization={visibility:'none',selection:null,original:null,revalidation:{visibility:'none',result:null},basis:null};
 return[approved,rejected,reserved];
}
export function fiscalStatusQaPage(rows=fiscalStatusQaRows(),more=false,limit=25):FiscalDraftStatusPage{return{profile:'fiscal-draft-status-v1',read_only:true,observed_at:FISCAL_STATUS_QA_TIME,can_emit:false,can_transmit:false,operational_effects:false,items:rows,limit,has_more:more,next_cursor:more?rows.at(-1)!.draft.id:null};}

export function createFiscalDraftStatusQaFixture(notifyCounts:()=>void=()=>{}){
 let snapshot:AccessState={phase:'ready',membership:{user_id:FISCAL_STATUS_QA_ACTOR,role:'fiscal',resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),counts={get:0,rejected:0},rows=fiscalStatusQaRows();
 const controller:FiscalDraftStatusController={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},async fiscalDraftStatus(path,options={}){
  try{captureFiscalDraftStatusRequest(path,options);}catch(e){counts.rejected++;notifyCounts();throw e;}
  if(options.signal?.aborted)throw new DOMException('Aborted','AbortError');
  if(snapshot.phase!=='ready'||!['admin','fiscal'].includes(snapshot.membership?.role??''))throw new Error('QA_ACCESS_DENIED');
  const url=new URL(path,'https://synthetic.invalid');if(url.pathname!==FISCAL_DRAFT_STATUS_PATH)throw new Error('QA_ROUTE_INVALID');
  counts.get++;notifyCounts();const model=url.searchParams.get('model'),status=url.searchParams.get('status'),source=url.searchParams.get('source_document_id'),after=url.searchParams.get('after'),limit=Number(url.searchParams.get('limit')??25);
  const filtered=rows.filter(r=>(!model||r.draft.model===model)&&(!status||r.draft.status===status)&&(!source||r.draft.source_document_id===source)&&(!after||r.draft.id>after)).sort((a,b)=>a.draft.id.localeCompare(b.draft.id));
  return structuredClone(fiscalStatusQaPage(filtered.slice(0,limit),filtered.length>limit,limit));
 }};
 return{controller,counts,rows,setAccess(state:AccessState){snapshot=state;for(const fn of listeners)fn();}};
}
