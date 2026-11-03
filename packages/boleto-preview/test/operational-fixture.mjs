// Fictional data only; no real bank account, title or allocation.
import {fixture} from './fixtures.mjs';
import {operationalEncodingTerms} from '../../cnab-core/src/operational-v2.mjs';
export const billingTitleId='11111111-2222-4333-8444-555555555555';
export function operationalFixture({observed=true,amount='12345',zeroConfirmed=false}={}){
 const f=fixture(),dueOn='2026-10-30';
 const title={id:billingTitleId,control:'SYNTHETIC-0001',documentNumber:'TESTE0001',ourNumber:'00000001',amountCents:amount,issuedOn:'2026-10-15',dueOn,
  payer:{...f.payer,city:'CIDADE TESTE'}};
 if(observed)title.encodingTerms=operationalEncodingTerms({amountCents:amount,dueOn,zeroDailyInterestConfirmed:zeroConfirmed});
 return {billingTitleId,beneficiaryAddress:f.beneficiaryAddress,snapshot:{
  profile:{...f.boleto.profile,simpleCollectionPolicyVerified:!observed},titles:[title],generatedOn:'2026-10-16',remittanceSequence:'1',purpose:'operational',preview_hash:'a'.repeat(64),
  operational_authorization:{approval_version:1,profile_config_hash:'b'.repeat(64),identity_version:1},
  encoding_profile:observed?'itau109-origin-observed-v1':'itau109-no-charges-v1',
  encoding_authorization:{approval_version:1,policy_hash:'c'.repeat(64),reference:'SYNTHETIC DECLARATION',confirmed_on:'2026-10-16',compatibility_confirmed:observed,permanent_instructions_acknowledged:observed}
 }};
}
