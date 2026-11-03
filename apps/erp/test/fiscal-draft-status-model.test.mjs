import test from 'node:test';import assert from 'node:assert/strict';
import {parseFiscalDraftStatusPage,fiscalAuthorizationLabel,fiscalAuthorizationPresentation,fiscalNumberingLabel,fiscalResultCodes,fiscalStatusMoney,fiscalDraftStatusCanRead} from '../src/lib/fiscal-draft-status-model.ts';
import {page,row,rows,fixture} from './helpers/fiscal-draft-status-fixtures.mjs';
import {ruleProfileByHash,RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH} from '../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
test('082 preserves draft, number and original result when a later validation authorizes the same stored response',()=>{
 const source=page(),value=parseFiscalDraftStatusPage(source),[approved,rejected,reserved]=value.items;
 assert.equal(approved.draft.status,'draft');assert.equal(approved.authorization.original.state,'review_required');assert.equal(approved.authorization.revalidation.result.state,'authorized_homologation');
 assert.match(fiscalAuthorizationLabel(approved),/requer conferência/);assert.match(fiscalNumberingLabel(approved),/900101/);assert.match(fiscalResultCodes(approved.authorization.revalidation.result),/100.*104/);
 assert.match(fiscalAuthorizationLabel(rejected),/Rejeitada/);assert.equal(fiscalResultCodes(rejected.authorization.original.result),'SEFAZ 245');assert.match(fiscalAuthorizationLabel(reserved),/Sem tentativa/);
 source.items[0].authorization.original.state='authorized_homologation';assert.equal(approved.authorization.original.state,'review_required');assert.ok(Object.isFrozen(approved.authorization.original));
 assert.equal(value.can_emit,false);assert.equal(value.can_transmit,false);
 assert.equal(approved.authorization.original.rule_review.profile_hash,RULE_PROFILE_V1_HASH);assert.equal(approved.authorization.original.rule_review.profile,ruleProfileByHash(RULE_PROFILE_V1_HASH).profile);
 assert.equal(rejected.authorization.original.rule_review.profile_hash,RULE_PROFILE_V2_HASH);
});
test('082 historical basis remains visible and is not promoted to the current preparation',()=>{
 const r=row();r.draft.version=2;Object.assign(r.authorization.basis,{matches_current_preparation:false,is_latest_candidate:false,differences:['DRAFT_CHANGED','NEWER_SIGNED_CANDIDATE','COMPANY_CHANGED']});
 const p=parseFiscalDraftStatusPage(page([r]));assert.equal(p.items[0].authorization.original.state,'authorized_homologation');assert.equal(p.items[0].authorization.basis.draft_version,1);
 r.authorization.basis.matches_current_preparation=true;assert.throws(()=>parseFiscalDraftStatusPage(page([r])));
});
test('082 restricted and inconsistent visibility cannot carry hidden protocol or candidate metadata',()=>{
 for(const visibility of ['restricted','inconsistent']){
  const r=row();r.numbering={visibility,reservation:null};r.authorization={visibility,selection:null,original:null,revalidation:{visibility:visibility==='restricted'?'restricted':'none',result:null},basis:null};
  const checked=parseFiscalDraftStatusPage(page([r])).items[0];assert.doesNotMatch(fiscalAuthorizationLabel(checked),/Sem tentativa|Autorizada/);assert.doesNotMatch(fiscalNumberingLabel(checked),/900101/);
  r.authorization.original=rows()[0].authorization.original;assert.throws(()=>parseFiscalDraftStatusPage(page([r])));
 }
});
test('082 rejects mismatched response evidence, promoted flags and untrusted diagnostic fields',()=>{
 for(const mutate of [p=>p.can_emit=true,p=>p.can_transmit=true,p=>p.items[0].authorization.revalidation.result.response_hash='0'.repeat(64),p=>p.items[0].authorization.revalidation.result.parser_manifest_hash='0'.repeat(64),p=>p.items[0].authorization.original.result.rejection_code='PRIVATE_STACK',p=>p.items[0].authorization.original.result.xMotivo='PRIVATE_REASON']){
  const p=page();mutate(p);assert.throws(()=>parseFiscalDraftStatusPage(p));
 }
 assert.throws(()=>parseFiscalDraftStatusPage(page(),{model:'65'}));
 assert.equal(fiscalStatusMoney('900719925474.01'),'R$ 900.719.925.474,01');
});
test('082 synthetic results and local validation remain distinct from operational authorization',()=>{
 const r=row(2,'65');r.authorization.original.origin='synthetic';r.authorization.original.state='authorization_observed';
 const checked=parseFiscalDraftStatusPage(page([r])).items[0];assert.match(fiscalAuthorizationLabel(checked),/sintético/);assert.match(fiscalResultCodes(rows()[0].authorization.original.result),/Falha local.*SOAP_INVALID/);
 const f=fixture();assert.equal(fiscalDraftStatusCanRead(f.controller.getSnapshot()),true);f.setAccess({role:'consulta'});assert.equal(fiscalDraftStatusCanRead(f.controller.getSnapshot()),false);f.setAccess({role:'admin',phase:'checking'});assert.equal(fiscalDraftStatusCanRead(f.controller.getSnapshot()),false);
});
test('082 compact summary names its evidence and selects only a conclusive available revalidation',()=>{
 const [authorized,rejected,reserved]=parseFiscalDraftStatusPage(page()).items;
 const selected=fiscalAuthorizationPresentation(authorized);
 assert.equal(selected.result,authorized.authorization.revalidation.result);assert.equal(selected.source,'conferência posterior');assert.match(selected.label,/Autorizada/);
 assert.equal(authorized.authorization.original.state,'review_required');assert.equal(authorized.authorization.original.result.rejection_code,'SOAP_INVALID');
 assert.equal(fiscalAuthorizationPresentation(rejected).result,rejected.authorization.original.result);assert.equal(fiscalAuthorizationPresentation(rejected).source,'resposta original');assert.equal(fiscalAuthorizationPresentation(reserved).source,null);
 for(const visibility of ['none','restricted','inconsistent','unsupported']){
  const r=rows()[0];r.authorization.revalidation={visibility,result:null};const checked=parseFiscalDraftStatusPage(page([r])).items[0],summary=fiscalAuthorizationPresentation(checked);
  assert.equal(summary.result,checked.authorization.original.result);assert.equal(summary.source,'resposta original');assert.doesNotMatch(summary.label,/Autorizada/);
 }
 for(const state of ['receipt_pending','review_required','rejected']){
  const r=rows()[0],later=r.authorization.revalidation.result;Object.assign(later,{state,processed_hash:null,processed_size:null,cstat:state==='receipt_pending'?'103':state==='rejected'?'245':'217',protocol_cstat:null,protocol_number:null});
  const checked=parseFiscalDraftStatusPage(page([r])).items[0],summary=fiscalAuthorizationPresentation(checked);
  assert.equal(summary.result,state==='rejected'?checked.authorization.revalidation.result:checked.authorization.original.result);assert.equal(summary.source,state==='rejected'?'conferência posterior':'resposta original');assert.doesNotMatch(summary.label,/Autorizada/);
 }
});
