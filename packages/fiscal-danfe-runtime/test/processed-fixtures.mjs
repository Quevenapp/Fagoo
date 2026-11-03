// Synthetic public-certificate/signature fixtures and in-memory RPC/Storage only.
import assert from 'node:assert/strict';
import {receiptFixture} from '../../fiscal-authorization/test/receipt-fixtures.mjs';
import {fiscalResponse,hash} from '../../fiscal-authorization/test/service-fixtures.mjs';
import {actor,commandId} from '../../fiscal-authorization-http/test/fixtures.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,reviewedAuthorizationBinding} from '../../fiscal-authorization/src/authorization-soap-binding.mjs';
import {prepareAuthorization,parseAuthorizationResponse,composeProcessedNfe} from '../../fiscal-authorization/src/index.mjs';
import {HOLDER,NOW} from '../../fiscal-xml/test/fixtures.mjs';
import {projectDispatchLedger} from '../../fiscal-authorization/src/dispatch-dto.mjs';
import {RULE_PROFILES} from '../../fiscal-authorization/src/rule-profile-registry.mjs';
import {REVALIDATION_FLAGS,REVALIDATION_PROFILE,REVALIDATION_PARSER_HASH} from '../../fiscal-authorization/src/revalidation-public-dto.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
const clone=structuredClone;
export async function processedFixtures(){const f=await receiptFixture();
function fixture(model='55',kind='authorization',options={}){
 const base=f.create(model),record=clone(base.record),c=record.recovery,p=RULE_PROFILES[1];let request=base.request;
 if(options.signedCandidate){
  const candidate=options.signedCandidate;assert.equal(candidate.context.model,model);
  request=prepareAuthorization({signedBytes:candidate.bytes,expectedSignedHash:candidate.context.sha256,expectedModel:model,expectedIssuerCnpj:HOLDER,expectedHolderCnpj:HOLDER,expectedCertificate:candidate.credential.certificate,expectedCertificateFingerprint:hash(candidate.credential.certificateDer),now:NOW,batchId:c.batch_id});
  Object.assign(c,{signed_hash:request.signedHash,signed_size:candidate.bytes.length,access_key:request.accessKey,reference_digest:request.referenceDigest,certificate_fingerprint:hash(candidate.credential.certificateDer)});
  Object.assign(record.receipt,{signed_hash:c.signed_hash,signed_size:c.signed_size});
 }
 const wire=Buffer.from(encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request}))),binding=reviewedAuthorizationBinding(model);
 Object.assign(record.receipt,{origin:'operational'});Object.assign(record.current,{state:'review_required'});
 Object.assign(c,{origin:'operational',request_hash:hash(wire),request_size:wire.length,binding_profile:binding.profile,rule_profile:p.profile,policy_manifest_hash:p.policyHashes[model]});
 const payload=fiscalResponse(request,options),raw=Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><nfeResultMsg xmlns="${binding.serviceNamespace}">${payload}</nfeResultMsg></Body></Envelope>`);
 const proof={candidate_id:c.candidate_id,candidate_version:1,signed_hash:c.signed_hash,facts_hash:hash('synthetic facts'),profile:p.profile,profile_hash:p.profileHash,review_id:'a0000000-0000-4000-8000-000000000001',review_version:1,review_hash:hash('synthetic review'),reviewed_by:actor,reviewed_at:'2026-10-16T11:00:00Z',valid_until:'2026-10-16T13:00:00Z',coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false};
 const meta={profile:'authorization-reviewed-journal-v1',origin:'operational',attempt_id:c.attempt_id,command_id:c.command_id,candidate_id:c.candidate_id,batch_id:c.batch_id,signed_hash:c.signed_hash,request_hash:c.request_hash,response_hash:hash(raw),response_size:raw.length,http_status:200,received_at:'2026-10-16T12:01:00Z',tls_peer_verified:true,tls_origin_verified:true,tls_protocol:'TLSv1.2',server_trust_profile:SP_AUTHORIZATION_SERVER_TRUST,server_trust_anchor_sha256:SP_AUTHORIZATION_ROOT_HASH,subset_review_hash:proof.review_hash};
 const path=type=>`authorization/${c.attempt_id}/${type}/${c.request_hash}.${type==='observations'?'json':'xml'}`,signedKey=`candidates/${c.candidate_id}/${c.signed_hash}.xml`;
 // Reconstruct exact original signed NFe bytes from the attested fixture request.
 const signed=Buffer.from(wire.toString().slice(wire.toString().indexOf('<NFe '),wire.toString().lastIndexOf('</NFe>')+6));
 assert.equal(hash(signed),c.signed_hash);const files=new Map([[signedKey,signed],[path('requests'),wire],[path('responses'),raw],[path('observations'),Buffer.from(JSON.stringify(meta))]]);
 Object.assign(record.artifact,{response_hash:hash(raw),response_size:raw.length,evidence:{...record.artifact.evidence,origin:'operational',request_hash:c.request_hash,response_hash:hash(raw),payload_hash:null,binding_profile:c.binding_profile,rule_profile:c.rule_profile,outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null,reference_digest:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false,tls_origin_verified:true,transport_hash:hash(files.get(path('observations'))),transport_size:files.get(path('observations')).length}});
 record.rule_review=proof;record.observation={sha256:hash(files.get(path('observations'))),size_bytes:files.get(path('observations')).length};
 const calls={command:[],read:[],validate:[]},input={actor,authorizationCommandId:commandId};
 const ports={readCommand:async(x,o)=>{calls.command.push(clone(x));assert.equal(x.actor,actor);assert.equal(x.authorizationCommandId,commandId);assert.ok(o.signal instanceof AbortSignal);return clone(record);},readObject:async x=>{assert.equal(x.bucket,'brufap-fiscal-artifacts');calls.read.push(x);const b=files.get(x.key);return b?new Response(Buffer.from(b),{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}}):null;},validate:async(x,o)=>{calls.validate.push(x.kind);throw Error('NO_VALIDATOR_PORT_EXPECTED');}};
 const updateMeta=edit=>{const m=JSON.parse(files.get(path('observations')));edit(m);const b=Buffer.from(JSON.stringify(m));files.set(path('observations'),b);record.observation={sha256:hash(b),size_bytes:b.length};record.artifact.evidence.transport_hash=hash(b);record.artifact.evidence.transport_size=b.length;};
 const updateRaw=bytes=>{files.set(path('responses'),bytes);record.artifact.response_hash=hash(bytes);record.artifact.response_size=bytes.length;record.artifact.evidence.response_hash=hash(bytes);updateMeta(m=>{m.response_hash=hash(bytes);m.response_size=bytes.length;});};
 const original=clone(record),parsed=parseAuthorizationResponse({request,responseBytes:Buffer.from(payload)}),processed=composeProcessedNfe({request,response:parsed});
 const evidence={...record.artifact.evidence,payload_hash:hash(payload),outcome:'authorization_declared',rejection_code:null,cstat:'104',protocol_cstat:parsed.protocol.cStat,protocol_number:parsed.protocol.number,received_at:new Date(parsed.protocol.receivedAt).toISOString(),reference_digest:request.referenceDigest,signature_verified:true,xsd_validated:true,context_matched:true,processed_xsd_validated:true};
 Object.assign(record.current,{state:'authorized_homologation',authorized_in_homologation:true});Object.assign(record.artifact,{evidence,processed_hash:processed.processedHash,processed_size:processed.sizeBytes});
 const source={receipt:original.receipt,recovery:original.recovery,artifact:original.artifact,rule_review:original.rule_review,observation:original.observation};
 const rid='b0000000-0000-4000-8000-000000000079';
 const revalidated={...REVALIDATION_FLAGS,command_id:rid,receipt:{command_id:rid,authorization_command_id:commandId,attempt_id:c.attempt_id,candidate_id:c.candidate_id,candidate_version:1,signed_hash:c.signed_hash,model,origin:'operational',source_hash:hash('synthetic SQL source'),parser_profile:REVALIDATION_PROFILE,parser_manifest_hash:REVALIDATION_PARSER_HASH,original_state:'review_required',state:'authorized_homologation',evidence,processed_hash:processed.processedHash,processed_size:processed.sizeBytes,created_at:'2026-10-16T12:02:00Z',tax_rules_validated:false},source,read_only:true,replayed:true};
 files.set(`authorization/${c.attempt_id}/processed/${processed.processedHash}.xml`,Buffer.from(processed.processedXml));
 files.set(`revalidations/${c.attempt_id}/${REVALIDATION_PARSER_HASH}/processed/${processed.processedHash}.xml`,Buffer.from(processed.processedXml));
 projectDispatchLedger('command',clone(record),{p_user_id:actor,p_command_id:commandId});
 const selected=kind==='authorization'?record:revalidated;
 const sourceInput={actor,sourceKind:kind,commandId:kind==='authorization'?commandId:rid};
 const sourcePorts={authorizationRpc:async(action,args,opts)=>{assert.equal(action,'command');assert.equal(args.p_user_id,actor);assert.equal(args.p_command_id,commandId);calls.command.push(args);return clone(record);},revalidationRpc:async(action,args)=>{assert.equal(action,'command');assert.equal(args.p_user_id,actor);assert.equal(args.p_command_id,rid);calls.command.push(args);return clone(revalidated);},storage:{read:ports.readObject}};
 return{record:selected,original,files,path,signedKey,calls,input:sourceInput,ports:sourcePorts,raw,processed,updateMeta,updateRaw,request};
}
return {create:fixture,close:()=>f.close()};
}
