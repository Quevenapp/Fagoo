import {fixture as printFixture} from '../../../../packages/boleto-preview/test/fixtures.mjs';
import {generateRemittance,generateOperationalRemittance} from '../../../../packages/cnab-core/src/index.mjs';
import {parseBoletoPreviewRoute,executeBoletoPreviewRoute} from '../../src/boleto-preview.mjs';
export const actor='a0000000-0000-4000-8000-000000000001';
export async function boletoFixture(purpose='homologation'){
 const data=printFixture(),billing='b0000000-0000-4000-8000-000000000001',remittance='c0000000-0000-4000-8000-000000000001',profileId='d0000000-0000-4000-8000-000000000001',titleId='e0000000-0000-4000-8000-000000000001';
 const profile={...data.boleto.profile,accountId:'f0000000-0000-4000-8000-000000000001',ourNumberStart:'00000001',remittanceSequenceStart:'1'};
 data.payer.city='SAO PAULO';data.payer.name='PAGADOR FICTICIO';
 const title={id:billing,control:'F'.repeat(25),documentNumber:data.document.number,amountCents:data.boleto.title.amountCents,issuedOn:data.document.issuedOn,dueOn:data.boleto.title.dueOn,payer:data.payer,ourNumber:data.boleto.allocation.ourNumber};
 const snapshot={profile,titles:[title],generatedOn:data.boleto.title.referenceOn,remittanceSequence:'1',purpose,...(purpose==='operational'?{operational_authorization:{approval_version:1,profile_config_hash:'a'.repeat(64),identity_version:1},preview_hash:'b'.repeat(64)}:{})};
 const generated=await(purpose==='operational'?generateOperationalRemittance:generateRemittance)(snapshot);
 const context={profile:'itau109-persisted-print-preview-v1',private_context:true,billing_title_id:billing,remittance_id:remittance,profile_id:profileId,finance_title_id:titleId,source_purpose:purpose,state:'ready',snapshot,
  billing_snapshot:{title,finance_title_version:1,contact_version:1,finance_title_id:titleId},manifest:generated.manifest,our_number:generated.manifest[0].ourNumber,snapshot_hash:'c'.repeat(64),
  file:{bucket:'brufap-cnab',path:`profiles/${profileId}/remittances/${generated.fileHash}.rem`,hash:generated.fileHash,size:generated.bytes.length},
  beneficiary:{identity_version:1,cnpj:profile.cnpj,address_source:'company_identity_current',address:data.beneficiaryAddress},
  current:{title_version:1,contact_version:1,profile_version:2,approval_version:purpose==='operational'?1:null,company_identity_version:1,title_status:'open',title_cancelled:false,settled_cents:'0'},
  read_only:true,can_pay:false,can_issue:false,can_transmit:false,financial_mutation_performed:false,context_hash:'d'.repeat(64)};
 const items={data_mode:'itau_boleto_items_readonly',read_only:true,can_pay:false,remittance_id:remittance,profile_id:profileId,source_purpose:purpose,state:'ready',remittance_hash:generated.fileHash,
  items:[{billing_title_id:billing,finance_title_id:titleId,document_number:title.documentNumber,amount_cents:title.amountCents,due_on:title.dueOn}]};
 const route=parseBoletoPreviewRoute(new Request(`https://synthetic.invalid/v1/boletos-itau/${billing}/preview`));
 const response=(await executeBoletoPreviewRoute(route,{userId:actor,rpc:async()=>structuredClone(context),getFile:async()=>generated.bytes.slice()})).body;
 return{context,items,response,bytes:generated.bytes,file:{id:remittance,profile_id:profileId,file_hash:generated.fileHash,state:'ready',kind:'remittance',sequence:'1',titles:1,generated_on:snapshot.generatedOn,created_at:'2026-10-16T12:00:00Z',byte_size:generated.bytes.length,filename:'ITAU_TESTE_0000001.REM'},billing,purpose};
}

export async function boletoOperationalV2Fixture({observed=true,amount='12345',zeroConfirmed=false}={}){
 const f=await boletoFixture('operational'),{generateOperationalRemittanceV2,operationalEncodingTerms}=await import('../../../../packages/cnab-core/src/operational-v2.mjs');
 const c=f.context,s=c.snapshot,t=s.titles[0];
 c.profile='itau109-persisted-print-preview-v2';s.profile.simpleCollectionPolicyVerified=!observed;t.amountCents=amount;
 s.encoding_profile=observed?'itau109-origin-observed-v1':'itau109-no-charges-v1';
 s.encoding_authorization={approval_version:1,policy_hash:'e'.repeat(64),reference:'SYNTHETIC DECLARATION',confirmed_on:s.generatedOn,compatibility_confirmed:observed,permanent_instructions_acknowledged:observed};
 if(observed)t.encodingTerms=operationalEncodingTerms({amountCents:amount,dueOn:t.dueOn,zeroDailyInterestConfirmed:zeroConfirmed});
 const generated=await generateOperationalRemittanceV2(s);c.manifest=generated.manifest;c.file={...c.file,hash:generated.fileHash,size:generated.bytes.length,path:`profiles/${c.profile_id}/remittances/${generated.fileHash}.rem`};
 f.bytes=generated.bytes;f.items.remittance_hash=generated.fileHash;f.items.items[0].amount_cents=amount;
 f.file={...f.file,file_hash:generated.fileHash,byte_size:generated.bytes.length,encoding_profile:s.encoding_profile};
 f.response=(await executeBoletoPreviewRoute(parseBoletoPreviewRoute(new Request(`https://synthetic.invalid/v1/boletos-itau/${f.billing}/preview`)),{userId:actor,rpc:async()=>structuredClone(c),getFile:async()=>generated.bytes.slice()})).body;
 return f;
}
