import {createFiscalDraftStatusQaFixture,fiscalStatusQaRow,fiscalStatusQaRows,fiscalStatusQaPage,fiscalStatusQaId,FISCAL_STATUS_QA_ACTOR} from '../../src/qa/fiscal-draft-status-fixture.ts';
export {fiscalStatusQaRow as row,fiscalStatusQaRows as rows,fiscalStatusQaPage as page,fiscalStatusQaId as id,FISCAL_STATUS_QA_ACTOR as ACTOR};
export const OTHER='b0000000-0000-4000-8000-000000000082';
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
export function fixture({before=()=>{},after=(_,raw)=>raw,model}={}){
 const f=createFiscalDraftStatusQaFixture(),calls=[],opens=[],original=f.controller.fiscalDraftStatus;
 const controller={...f.controller,async fiscalDraftStatus(path,options={}){const call={path,...options};calls.push(call);const custom=await before(call,f);return after(call,custom===undefined?await original(path,options):custom);},a1(){throw new Error('A1 must not be consulted');},fiscalReviewedAuthorization(){throw new Error('Authorization must not run');}};
 return{...f,controller,calls,opens,props:{controller,initialModel:model,onOpenDraft:d=>opens.push(d)},setAccess(patch){const s=controller.getSnapshot();f.setAccess({...s,phase:patch.phase??s.phase,membership:patch.actor===null?null:{...s.membership,...(patch.actor?{user_id:patch.actor}:{}),...(patch.role?{role:patch.role}:{})}});}};
}
