import {fiscalPythonPath} from '../../fiscal-engine/python.mjs';
import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {receiptFixture,receiptResponse,hash} from './receipt-fixtures.mjs';
import {receiptValidationContext,parseReceiptResponse} from '../src/receipt-core.mjs';
import {composeReceiptProcessedNfe,ReceiptProcessedError} from '../src/receipt-processed.mjs';
import {authorizationRequestBytes,verifyProcessedAuthorization} from '../src/index.mjs';
import {createAuthorizationValidator} from '../src/validator.mjs';
import {createReceiptValidator} from '../src/receipt-validator.mjs';
let f;before(async()=>{f=await receiptFixture();});after(()=>f?.close());
const error=code=>e=>e.code===code&&e.message===code;
async function input(model='55',options={}){const source=f.create(model),request=await source.query(),responseBytes=receiptResponse({...request,...receiptValidationContext(request)},options),response=parseReceiptResponse({request,responseBytes});return{source,value:{authorizationRequest:source.request,request,response,responseBytes}};}
const inactive=p=>{for(const key of['xsdValidated','tlsOriginVerified','taxRulesValidated','sefazAuthorized','authorizedInHomologation','productionAuthorized','legalFiscalValue','canQuery','canEmit','canTransmit','retrySubmissionAllowed'])assert.equal(p[key],false,key);};
test('55/65 protocol100/150 composes exact original signed NFe, verifies its signature and preserves103',async()=>{
 for(const model of['55','65'])for(const status of['100','150']){const{source,value}=await input(model,{status}),historical=JSON.stringify(source.record),p=composeReceiptProcessedNfe(value);assert.equal(p.signatureVerified,true);assert.equal(p.contextMatched,true);assert.equal(p.protocol.cStat,status);assert.equal(p.processedHash,hash(p.processedXml));assert.equal(p.sizeBytes,Buffer.byteLength(p.processedXml));assert.equal(p.authorizationCommandId,value.request.commandId);assert.equal(p.sourceEvidenceHash,value.request.sourceEvidenceHash);assert.equal(p.receiptResponseHash,hash(value.responseBytes));assert.equal(p.sourceState,'receipt_pending');assert.equal(p.origin,'synthetic');assert.equal(p.authorizationPayloadHash,value.authorizationRequest.requestHash);assert.equal(p.queryPayloadHash,value.request.requestHash);inactive(p);const original=Buffer.from(authorizationRequestBytes(source.request)).toString(),nfe=original.slice(original.indexOf('<NFe'),original.lastIndexOf('</NFe>')+6);assert.ok(p.processedXml.includes(nfe));if(model==='65'){assert.ok(nfe.includes('<infNFeSupl>'));assert.ok(p.processedXml.includes(nfe.slice(nfe.indexOf('<infNFeSupl>'))));}assert.equal(JSON.stringify(source.record),historical);assert.equal(Object.isFrozen(p),true);value.responseBytes.fill(0);assert.equal(hash(p.processedXml),p.processedHash);}
});
test('105/106/217/rejection/duplicate never produce nfeProc or release submission',async()=>{
 for(const options of[{batch:'105'},{batch:'106'},{batch:'217'},{status:'302'},{status:'204'},{status:'539'}]){const{value}=await input('55',options);assert.equal(value.response.retrySubmissionAllowed,false);assert.throws(()=>composeReceiptProcessedNfe(value),error('RECEIPT_PROCESSED_NOT_AUTHORIZED_DECLARATION'));}
});
test('clones, query/response mismatch and forged getters cannot supply original trust',async()=>{
 const {value}=await input(),other=await input();let touched=0;const fake={get model(){touched++;throw Error('PRIVATE');}};
 for(const authorizationRequest of[fake,{...value.authorizationRequest},new Proxy(value.authorizationRequest,{get(){touched++;throw Error();}})])assert.throws(()=>composeReceiptProcessedNfe({...value,authorizationRequest}),error('RECEIPT_PROCESSED_AUTHORIZATION_UNATTESTED'));
 for(const patch of[{request:{...value.request}},{response:{...value.response}},{response:other.value.response},{request:other.value.request},{response:fake}])assert.throws(()=>composeReceiptProcessedNfe({...value,...patch}),error('RECEIPT_PROCESSED_RESPONSE_UNATTESTED'));
 assert.throws(()=>composeReceiptProcessedNfe({...value,get responseBytes(){touched++;throw Error();}}),error('RECEIPT_PROCESSED_INPUT_INVALID'));
 assert.throws(()=>verifyProcessedAuthorization({request:fake,processedBytes:Buffer.from('PRIVATE')}),error('AUTHORIZATION_REQUEST_UNATTESTED'));assert.equal(touched,0);
});
test('source model/candidate and exact response bytes are bound independently',async()=>{
 const a=await input('55'),b=await input('65');assert.throws(()=>composeReceiptProcessedNfe({...a.value,authorizationRequest:b.value.authorizationRequest}),error('RECEIPT_PROCESSED_SOURCE_MISMATCH'));
 const changed=Buffer.from(a.value.responseBytes);changed[changed.length-1]^=1;assert.throws(()=>composeReceiptProcessedNfe({...a.value,responseBytes:changed}),error('RECEIPT_PROCESSED_RESPONSE_HASH_MISMATCH'));
 for(const b of[new Uint8Array(new SharedArrayBuffer(10)),Buffer.alloc(512001),Buffer.alloc(0),new DataView(new ArrayBuffer(10))])assert.throws(()=>composeReceiptProcessedNfe({...a.value,responseBytes:b}),error('RECEIPT_PROCESSED_BYTES_INVALID'));
});
test('local verification refuses altered signed items or unsigned NFC-e supplement',async()=>{
 for(const model of['55','65']){const {value}=await input(model),p=composeReceiptProcessedNfe(value),xml=p.processedXml;
 const altered=xml.replace(/<xProd>([^<]+)/,(_,text)=>'<xProd>'+text+' ALTERADO');assert.notEqual(altered,xml);assert.throws(()=>verifyProcessedAuthorization({request:value.authorizationRequest,processedBytes:Buffer.from(altered)}),error('AUTHORIZATION_PROCESSED_SOURCE_MISMATCH'));
 if(model==='65'){const qr=xml.replace(/(<qrCode>)([^<]*)(<\/qrCode>)/,(_,start,text,end)=>start+text+'x'+end);assert.notEqual(qr,xml);assert.throws(()=>verifyProcessedAuthorization({request:value.authorizationRequest,processedBytes:Buffer.from(qr)}),error('AUTHORIZATION_PROCESSED_SOURCE_MISMATCH'));}
 }
});
test('nfeProc root/namespaces/attributes/two-child structure reject wrapping and namespace injection',async()=>{
 const{value}=await input(),p=composeReceiptProcessedNfe(value),xml=p.processedXml;
 const invalid=[xml.replace('<nfeProc ','<nfeProc xmlns:pollute="urn:bad" '),xml.replace('<nfeProc ','<nfeProc xml:lang="pt" '),xml.replace('versao="4.00"','versao="3.10"'),xml.replace('xmlns="http://www.portalfiscal.inf.br/nfe"','xmlns="urn:bad"'),xml.replace('</nfeProc>','<extra/></nfeProc>'),xml.replace('<NFe ','<NFe xmlns:inject="urn:bad" '),xml.replace('</nfeProc>',xml.match(/<protNFe[\s\S]*?<\/protNFe>/)[0]+'</nfeProc>'),xml.replace('<nfeProc ','<!DOCTYPE x SYSTEM "https://never.invalid"><nfeProc ')];
 for(const changed of invalid)assert.throws(()=>verifyProcessedAuthorization({request:value.authorizationRequest,processedBytes:Buffer.from(changed)}));
});
test('verifier enforces protocol100/150, exact key/digest and returns only local evidence',async()=>{
 const{value}=await input(),p=composeReceiptProcessedNfe(value),ctx=receiptValidationContext(value.request);
 for(const changed of[p.processedXml.replace('<cStat>100</cStat>','<cStat>105</cStat>'),p.processedXml.replace('<chNFe>'+ctx.accessKey,'<chNFe>'+'9'.repeat(44)),p.processedXml.replace('<digVal>'+ctx.referenceDigest,'<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=')])assert.throws(()=>verifyProcessedAuthorization({request:value.authorizationRequest,processedBytes:Buffer.from(changed)}));
 const bytes=Buffer.from(p.processedXml),proof=verifyProcessedAuthorization({request:value.authorizationRequest,processedBytes:bytes});bytes.fill(0);assert.equal(proof.processedHash,p.processedHash);assert.equal(proof.signatureVerified,true);assert.equal(proof.xsdValidated,false);assert.equal(proof.tlsOriginVerified,false);assert.equal(proof.authorizedInHomologation,false);assert.equal(Object.hasOwn(proof,'certificate'),false);assert.equal(Object.hasOwn(proof,'trust'),false);
});
test('processed aggregate has its own512000-byte limit even when receipt response fits',async()=>{
 const{value}=await input(),xml=value.responseBytes.toString(),expanded=xml.replace('<infProt>','<infProt>'+' '.repeat(511900-Buffer.byteLength(xml))),responseBytes=Buffer.from(expanded),response=parseReceiptResponse({request:value.request,responseBytes});assert.equal(responseBytes.length,511900);assert.throws(()=>composeReceiptProcessedNfe({...value,response,responseBytes}),error('RECEIPT_PROCESSED_SIZE_LIMIT'));
});
test('real Python validates receipt response and final nfeProc55/65; source-order error remains an XSD error',async()=>{
 const pythonPath=fiscalPythonPath(),validateReceipt=createReceiptValidator({pythonPath,validatorPath:fileURLToPath(new URL('../receipt-validator.py',import.meta.url))}),validateProcessed=createAuthorizationValidator({pythonPath,validatorPath:fileURLToPath(new URL('../validator.py',import.meta.url))});
 for(const model of['55','65'])for(const status of['100','150']){const{value}=await input(model,{status}),r=await validateReceipt({request:value.request,kind:'response',xmlBytes:value.responseBytes});assert.equal(r.ok,true);const p=composeReceiptProcessedNfe(value),v=await validateProcessed({request:value.authorizationRequest,kind:'processed',xmlBytes:Buffer.from(p.processedXml)});assert.equal(v.ok,true);assert.equal(v.xsdValidated,true);assert.equal(v.referenceDigestMatched,true);assert.equal(v.protocolCStat,status);assert.equal(v.authorizedInHomologation,false);assert.equal(v.signatureVerified,false);
 const wrong=value.responseBytes.toString().replace('<tpAmb>2</tpAmb><verAplic>SINTETICO</verAplic>','<verAplic>SINTETICO</verAplic><tpAmb>2</tpAmb>');const bad=await validateReceipt({request:value.request,kind:'response',xmlBytes:Buffer.from(wrong)});assert.equal(bad.ok,false);assert.equal(bad.code,'RECEIPT_XSD_INVALID');}
});
