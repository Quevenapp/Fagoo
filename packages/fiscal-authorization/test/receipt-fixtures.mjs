// Synthetic in-memory credentials and private064-shaped records. No database, sockets or real secrets.
import {prepareAuthorization} from '../src/index.mjs';
import {createReceiptEvidenceReader,prepareReceiptQuery} from '../src/receipt-core.mjs';
import {FLAGS} from '../src/service-dto.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as PROFILE} from '../src/validator.mjs';
import {result,actor,candidateId,commandId} from '../../fiscal-authorization-http/test/fixtures.mjs';
import {signedFixture,fiscalResponse,hash,HOLDER,NOW} from './service-fixtures.mjs';
export {actor,candidateId,commandId,hash};
export async function receiptFixture(){
 const f=await signedFixture();
 const create=(model='55')=>{
  const signed=f.create(model),request=prepareAuthorization({signedBytes:signed.signedBytes,expectedSignedHash:signed.signed.xmlDigest,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedCertificate:f.credential.certificate,expectedHolderCnpj:HOLDER,expectedCertificateFingerprint:hash(f.credential.certificateDer),now:NOW,batchId:'123456789012345'});
  const source=fiscalResponse(request,{batch:'103',receipt:true,protocol:false}),wireHash=hash('SYNTHETIC SOAP REQUEST'),wireSize=23000;
  const {receipt,current}=result({state:'receipt_pending',ordinal:request.batchId});
  Object.assign(receipt,{model,signed_hash:request.signedHash,signed_size:signed.signedBytes.length});
  const evidence={origin:'synthetic',request_hash:wireHash,response_hash:hash(source),payload_hash:hash(source),schema_profile:PROFILE.profile,schema_manifest_hash:PROFILE.manifestHash,validator_hash:PROFILE.validatorHash,binding_profile:'synthetic-authorization-binding',rule_profile:'synthetic-rules-only',outcome:'receipt_pending',rejection_code:null,cstat:'103',protocol_cstat:null,protocol_number:null,received_at:'2026-10-16T12:01:00.000Z',receipt_number:'350000000000001',reference_digest:null,signature_verified:false,xsd_validated:true,context_matched:true,processed_xsd_validated:false,tls_origin_verified:false,transport_hash:null,transport_size:null,can_emit:false,can_transmit:false};
  const recovery={private_executor_only:true,attempt_id:receipt.attempt_id,intent_id:receipt.intent_id,command_id:commandId,actor,lease_id:'90000000-0000-4000-8000-000000000001',nonce:'90000000-0000-4000-8000-000000000002',expires_at:current.expires_at,purpose:'sp-authorization-homologation-v1',environment:'2',model,origin:'synthetic',policy_version:1,binding_profile:evidence.binding_profile,rule_profile:evidence.rule_profile,policy_manifest_hash:hash('synthetic policy'),candidate_id:candidateId,signed_hash:request.signedHash,signed_size:signed.signedBytes.length,batch_id:receipt.batch_id,access_key:request.accessKey,reference_digest:request.referenceDigest,issuer_cnpj:HOLDER,identity_version:1,a1_version:2,credential_id:'90000000-0000-4000-8000-000000000003',envelope_hash:hash('synthetic encrypted envelope'),certificate_fingerprint:hash(f.credential.certificateDer),request_hash:wireHash,request_size:wireSize};
  const record={...FLAGS,command_id:commandId,receipt,current,artifact:{response_hash:hash(source),response_size:source.length,evidence,processed_hash:null,processed_size:null,created_at:'2026-10-16T12:01:00Z'},error_code:null,recovery,read_only:true};
  const input={request,actor,candidateId,commandId};
  const answer=()=>({recordBytes:Buffer.from(JSON.stringify(record)),payloadBytes:Buffer.from(source)});
  const read=()=>createReceiptEvidenceReader({readReceipt:async()=>answer()})(input);
  return{request,record,source,input,answer,read,query:async()=>prepareReceiptQuery({evidence:await read()})};
 };
 return{create,close(){f.credential.privateDer.fill(0);f.close();}};
}
export function receiptResponse(request,{batch='104',status='100',protocol=batch==='104',receiptNumber=request.receiptNumber}={}){
 // Access key/digest are passed as synthetic fixture properties, not accepted by production builder.
 return Buffer.from(`<retConsReciNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><nRec>${receiptNumber}</nRec><cStat>${batch}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo><cUF>35</cUF><dhRecbto>2026-10-16T09:02:00-03:00</dhRecbto>${protocol?`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic><chNFe>${request.accessKey}</chNFe><dhRecbto>2026-10-16T09:01:00-03:00</dhRecbto><nProt>13526000000000001</nProt><digVal>${request.referenceDigest}</digVal><cStat>${status}</cStat><xMotivo>RESPOSTA SINTETICA SEM VALOR FISCAL</xMotivo></infProt></protNFe>`:''}</retConsReciNFe>`);
}
