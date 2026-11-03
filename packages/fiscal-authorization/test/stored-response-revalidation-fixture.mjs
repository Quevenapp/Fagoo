// SQL-only synthetic journals. No A1 files, network, custody or SEFAZ.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {reviewedFixture,hash} from './reviewed-ledger-fixture.mjs';
import {STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from '../src/stored-response-manifest.mjs';
import {prepareAuthorization} from '../src/index.mjs';
import {pinnedCandidateCertificate} from '../src/pinned-certificate.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,reviewedAuthorizationBinding} from '../src/authorization-soap-binding.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
export {hash};
export const PREFIX='erp_fiscal_reviewed_authorization_revalidation_';
export async function revalidationFixture(){
 const f=await reviewedFixture();try{
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160079_fiscal_stored_response_revalidation.sql',import.meta.url),'utf8'));
  const version=await f.enable();
  const start=async(model='55')=>{
   const c=await f.candidate(model),proof=await f.review(c),b=await f.begin(c,version),p=await f.prepare(b,proof);await f.use(b,proof);
   const good=await f.finishArgs(b,p),bad={...good,p_processed_hash:null,p_processed_size:null,p_evidence:{...good.p_evidence,outcome:'invalid_response',rejection_code:'SOAP_INVALID',payload_hash:null,cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null,reference_digest:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false}};
   const old=await f.wire('finish',bad),contextArgs={p_user_id:f.users.fiscal,p_authorization_command_id:c.input.commandId,p_expected_attempt_id:b.value.receipt.attempt_id};
   const context=await f.callSql(PREFIX+'context',contextArgs);
   const args={p_user_id:f.users.fiscal,p_command_id:randomUUID(),p_authorization_command_id:c.input.commandId,p_expected_attempt_id:b.value.receipt.attempt_id,p_expected_source_hash:context.source_hash,p_parser_profile:STORED_RESPONSE_MANIFEST.profile,p_parser_manifest_hash:STORED_RESPONSE_MANIFEST_HASH,p_evidence:good.p_evidence,p_processed_hash:good.p_processed_hash,p_processed_size:good.p_processed_size,p_confirmed:true};
   const key=`revalidations/${args.p_expected_attempt_id}/${STORED_RESPONSE_MANIFEST_HASH}/processed/${args.p_processed_hash}.xml`;
   await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-fiscal-artifacts',key,JSON.stringify({size:args.p_processed_size,mimetype:'application/octet-stream'})]);
   return{c,proof,b,p,good,bad,old,context,contextArgs,args,key};
  };
  const call=(action,args)=>f.callSql(PREFIX+action,args);
  const startReal=async(model='55',responseOptions={})=>{
   const c=await f.candidate(model),proof=await f.review(c),b=await f.begin(c,version),ctx=b.value.recovery;
   const signed=f.files.get(`candidates/${ctx.candidate_id}/${ctx.signed_hash}.xml`),cert=pinnedCandidateCertificate({signedBytes:signed,signedHash:ctx.signed_hash,signedSize:ctx.signed_size,certificateFingerprint:ctx.certificate_fingerprint,model,now:new Date(b.value.receipt.created_at)});
   const request=prepareAuthorization({signedBytes:signed,expectedSignedHash:ctx.signed_hash,expectedModel:model,expectedIssuerCnpj:ctx.issuer_cnpj,expectedHolderCnpj:ctx.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:ctx.certificate_fingerprint,now:new Date(b.value.receipt.created_at),batchId:ctx.batch_id});
   const wire=Buffer.from(encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request}))),requestHash=hash(wire);
   const store=async(kind,bytes)=>{const key=await f.object(b,kind,requestHash,bytes.length);f.files.set(key,bytes);return key;};
   await store('requests',wire);
   const prep={...f.ids(b),p_request_hash:requestHash,p_request_size:wire.length,p_evidence:{...f.preparation(b,requestHash),payload_hash:request.requestHash},p_rule_review:proof};await f.wire('prepare',prep);await f.use(b,proof);
   const payload=f.response(request,responseOptions),response=Buffer.from(`<?xml version="1.0" encoding="uTf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${reviewedAuthorizationBinding(model).serviceNamespace}">${payload}</nfeResultMsg></Body></Envelope>`);
   const meta=Buffer.from(JSON.stringify({profile:'authorization-reviewed-journal-v1',origin:'operational',attempt_id:ctx.attempt_id,command_id:ctx.command_id,candidate_id:ctx.candidate_id,batch_id:ctx.batch_id,signed_hash:ctx.signed_hash,request_hash:requestHash,response_hash:hash(response),response_size:response.length,http_status:200,received_at:new Date().toISOString(),tls_peer_verified:true,tls_origin_verified:true,tls_protocol:'TLSv1.2',server_trust_profile:SP_AUTHORIZATION_SERVER_TRUST,server_trust_anchor_sha256:SP_AUTHORIZATION_ROOT_HASH,subset_review_hash:proof.review_hash}));
   await store('responses',response);await store('observations',meta);
   const bad={...f.ids(b),p_response_hash:hash(response),p_response_size:response.length,p_processed_hash:null,p_processed_size:null,p_evidence:f.responseEvidence(b,requestHash,hash(response),{outcome:'invalid_response',rejection_code:'SOAP_INVALID',payload_hash:null,cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null,reference_digest:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false,tls_origin_verified:true,transport_hash:hash(meta),transport_size:meta.length}),p_observation_hash:hash(meta),p_observation_size:meta.length};
   const old=await f.wire('finish',bad),contextArgs={p_user_id:f.users.fiscal,p_authorization_command_id:c.input.commandId,p_expected_attempt_id:ctx.attempt_id},context=await call('context',contextArgs);
   return{c,proof,b,request,wire,response,meta,bad,old,context,contextArgs,input:{command_id:randomUUID(),authorization_command_id:ctx.command_id,expected_attempt_id:ctx.attempt_id,expected_source_hash:context.source_hash,confirmed:true}};
  };
  const snapshot=async()=>{const out={};for(const name of['erp_fiscal_authorization.policy','erp_fiscal_authorization.intent','erp_fiscal_authorization.attempt','erp_fiscal_authorization.command','erp_fiscal_authorization.request','erp_fiscal_authorization.result','erp_fiscal_authorization.audit','erp_fiscal_reviewed_authorization.review_binding','erp_fiscal_reviewed_authorization.observation'])out[name]=(await f.db.query(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)v from ${name} t`)).rows[0].v;return out;};
  return{...f,start,startReal,callRevalidation:call,snapshot};
 }catch(e){await f.close();throw e;}
}
