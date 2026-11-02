/** Pure receipt payloads. The injected reader is a backend trust boundary, never a browser flag. */
import {createHash} from 'node:crypto';
import {authorizationRequestBytes,parseAuthorizationResponse} from './index.mjs';
import {projectResponse} from './service-dto.mjs';
import {parseStrict,elements} from '../../fiscal-xml/src/xml.mjs';
import {RECEIPT_MANIFEST} from './receipt-manifest.mjs';
import {projectReceiptQuerySource,captureReceiptQuerySourceInput,receiptQuerySourceEvidence} from './receipt-query-evidence.mjs';
import {authorizationReceiptDetails} from './receipt-query-receipt.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from './receipt-query-manifest.mjs';
import {scope} from './service-common.mjs';
export const RECEIPT_PROFILE=RECEIPT_MANIFEST.profile;
export const MAX_RECEIPT_BYTES=512000, MAX_RECEIPT_RECORD_BYTES=131072;
export const RECEIPT_FLAGS=Object.freeze({xsdValidated:false,tlsOriginVerified:false,taxRulesValidated:false,
 signatureVerified:false,sefazAuthorized:false,authorizedInHomologation:false,productionAuthorized:false,
 legalFiscalValue:false,canQuery:false,canEmit:false,canTransmit:false,retrySubmissionAllowed:false});
export class FiscalReceiptError extends Error{constructor(code){super(code);this.name='FiscalReceiptError';this.code=code;}}
const fail=code=>{throw new FiscalReceiptError(code);},need=(ok,code='RECEIPT_INPUT_INVALID')=>{if(!ok)fail(code);};
const NS='http://www.portalfiscal.inf.br/nfe',DS='http://www.w3.org/2000/09/xmldsig#';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest=v=>createHash('sha256').update(v).digest('hex'),evidences=new WeakMap(),queries=new WeakMap(),responses=new WeakMap();
const typed=Object.getPrototypeOf(Uint8Array.prototype),get=Object.fromEntries(['byteLength','byteOffset','buffer'].map(k=>[k,Object.getOwnPropertyDescriptor(typed,k).get]));
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function data(v,keys,required=keys){try{need(v&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));const d=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(d);need(ks.every(k=>typeof k==='string'&&keys.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value'))&&required.every(k=>Object.hasOwn(d,k)));return Object.fromEntries(ks.map(k=>[k,d[k].value]));}catch{fail('RECEIPT_INPUT_INVALID');}}
function copy(v,max=MAX_RECEIPT_BYTES){try{need(ArrayBuffer.isView(v)&&v instanceof Uint8Array);const b=get.buffer.call(v),n=get.byteLength.call(v),off=get.byteOffset.call(v);need(b instanceof ArrayBuffer&&n>0&&n<=max);return Buffer.from(new Uint8Array(b,off,n));}catch{fail('RECEIPT_BYTES_INVALID');}}
function text(b){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);}catch{fail('RECEIPT_ENCODING_INVALID');}}
function parse(xml){try{return parseStrict(xml);}catch{fail('RECEIPT_XML_INVALID');}}
function check(signal,deadline){if(signal&&aborted.call(signal))fail('RECEIPT_ABORTED');if(Date.now()>=deadline)fail('RECEIPT_DEADLINE_EXCEEDED');}
function attrs(n,allowed=[]){for(const a of Array.from(n.attributes??[]))if(a.namespaceURI!=='http://www.w3.org/2000/xmlns/')need(!a.namespaceURI&&allowed.includes(a.name),'RECEIPT_STRUCTURE_INVALID');}
function children(n,allowed,repeated=[]){need(Array.from(n.childNodes).every(c=>c.nodeType!==3||!c.data.trim()),'RECEIPT_STRUCTURE_INVALID');const list=elements(n),seen=new Set();for(const c of list){need(c.namespaceURI===NS&&!c.prefix&&allowed.includes(c.localName)&&(!seen.has(c.localName)||repeated.includes(c.localName)),'RECEIPT_STRUCTURE_INVALID');seen.add(c.localName);}return Object.fromEntries(list.map(c=>[c.localName,c]));}
function leaf(n,optional=false){if(!n){need(optional,'RECEIPT_STRUCTURE_INVALID');return null;}attrs(n);need(elements(n).length===0,'RECEIPT_STRUCTURE_INVALID');return n.textContent;}
function label(n,max){const v=leaf(n);need(v.length>=1&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f]/.test(v),'RECEIPT_STRUCTURE_INVALID');return v;}
function stamp(v){const m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/.exec(v);need(m&&+m[1]>=2000&&+m[4]<24&&+m[5]<60&&+m[6]<60&&(+m[8]||0)<=14&&(+m[9]||0)<60&&!(+m[8]===14&&+m[9]!==0),'RECEIPT_TIMESTAMP_INVALID');const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));need(d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3],'RECEIPT_TIMESTAMP_INVALID');return v;}
const status=v=>{need(typeof v==='string'&&/^\d{3,4}$/.test(v),'RECEIPT_STATUS_INVALID');return v;};
function branded(map,h,code){const v=map.get(h);need(v,code);return v;}
function original(h){let bytes;try{bytes=authorizationRequestBytes(h);}catch{fail('RECEIPT_AUTHORIZATION_UNATTESTED');}try{const root=parse(text(bytes)).documentElement,nfe=elements(root).find(n=>n.localName==='NFe'),inf=elements(nfe).find(n=>n.localName==='infNFe'),ide=elements(inf).find(n=>n.localName==='ide');return{model:h.model,batchId:h.batchId,accessKey:h.accessKey,referenceDigest:h.referenceDigest,signedHash:h.signedHash,authorizationPayloadHash:h.requestHash,issuedAt:stamp(leaf(elements(ide).find(n=>n.localName==='dhEmi')))};}finally{bytes.fill(0);}}
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';

export const RECEIPT_MANIFEST_HASH=digest(canonical(RECEIPT_MANIFEST));

/** readReceipt must reauthorize and verify private journal/Storage before returning copies.
 * Its result is exactly {recordBytes,payloadBytes}; no network/env/default implementation. */
export function createReceiptEvidenceReader(configuration){
 const c=data(configuration,['readReceipt']);need(typeof c.readReceipt==='function');const port=c.readReceipt;
 return async function read(input,options={}){
  const v=data(input,['request','actor','candidateId','commandId']),o=data(options,['signal','deadline'],[]),ctx=original(v.request);
  need(['actor','candidateId','commandId'].every(k=>typeof v[k]==='string'&&UUID.test(v[k])));
  const signal=o.signal;try{if(signal!==undefined)aborted.call(signal);}catch{fail('RECEIPT_INPUT_INVALID');}
  need(o.deadline===undefined||Number.isSafeInteger(o.deadline));const deadline=Math.min(o.deadline??Date.now()+10000,Date.now()+10000);check(signal,deadline);
  const query=Object.freeze({actor:v.actor,candidateId:v.candidateId,commandId:v.commandId,signedHash:ctx.signedHash,model:ctx.model,batchId:ctx.batchId});
  let timer,onAbort,record,payload;const operation=new AbortController();
  try{
   const abortPromise=new Promise((_,reject)=>{onAbort=()=>{operation.abort();reject(new FiscalReceiptError('RECEIPT_ABORTED'));};if(signal)add.call(signal,'abort',onAbort,{once:true});timer=setTimeout(()=>{operation.abort();reject(new FiscalReceiptError('RECEIPT_DEADLINE_EXCEEDED'));},Math.max(1,deadline-Date.now()));});
   check(signal,deadline);
   const answer=await Promise.race([Promise.resolve().then(()=>{check(signal,deadline);return port(query,Object.freeze({signal:operation.signal,deadline,maxRecordBytes:MAX_RECEIPT_RECORD_BYTES,maxPayloadBytes:MAX_RECEIPT_BYTES}));}),abortPromise]);
   check(signal,deadline);const a=data(answer,['recordBytes','payloadBytes']);record=copy(a.recordBytes,MAX_RECEIPT_RECORD_BYTES);payload=copy(a.payloadBytes);
   let raw,proof;try{raw=JSON.parse(text(record));proof=projectResponse('erp_fiscal_authorization_command',raw,{p_user_id:v.actor,p_command_id:v.commandId});}catch{fail('RECEIPT_BACKEND_EVIDENCE_INVALID');}
   const r=proof.receipt,recovery=proof.recovery,artifact=proof.artifact;
   need(proof.current.state==='receipt_pending'&&artifact?.evidence.outcome==='receipt_pending','RECEIPT_SOURCE_NOT_PENDING');
   need(r.candidate_id===v.candidateId&&r.model===ctx.model&&r.signed_hash===ctx.signedHash&&r.batch_id===ctx.batchId&&recovery.access_key===ctx.accessKey&&recovery.reference_digest===ctx.referenceDigest,'RECEIPT_SOURCE_CONTEXT_MISMATCH');
   need(digest(payload)===artifact.evidence.payload_hash,'RECEIPT_SOURCE_HASH_MISMATCH');
   let response;try{response=parseAuthorizationResponse({request:v.request,responseBytes:payload});}catch{fail('RECEIPT_SOURCE_RESPONSE_INVALID');}
   need(response.classification==='receipt_pending'&&response.cStat==='103'&&response.receiptNumber===artifact.evidence.receipt_number&&Date.parse(response.receivedAt)===Date.parse(artifact.evidence.received_at),'RECEIPT_SOURCE_CONTEXT_MISMATCH');
   need(Date.parse(response.receivedAt)>=Date.parse(ctx.issuedAt),'RECEIPT_TIMESTAMP_INVALID');
   const handle=freeze({profile:RECEIPT_PROFILE,manifestHash:RECEIPT_MANIFEST_HASH,model:ctx.model,environment:'2',origin:r.origin,actor:v.actor,candidateId:v.candidateId,candidateVersion:r.candidate_version,commandId:v.commandId,
    sourceState:'receipt_pending',batchId:ctx.batchId,signedHash:ctx.signedHash,authorizationPayloadHash:ctx.authorizationPayloadHash,authorizationRequestHash:recovery.request_hash,
    sourceResponseHash:artifact.response_hash,sourcePayloadHash:artifact.evidence.payload_hash,receiptNumber:response.receiptNumber,
    sourceEvidenceHash:digest(canonical({receipt:r,artifact})),...RECEIPT_FLAGS});
   check(signal,deadline);evidences.set(handle,{...ctx,evidence:handle});return handle;
  }catch(error){if(error instanceof FiscalReceiptError)throw error;fail('RECEIPT_BACKEND_READ_FAILED');}
  finally{operation.abort();clearTimeout(timer);if(signal&&onAbort)remove.call(signal,'abort',onAbort);record?.fill(0);payload?.fill(0);}
 };
}

/** Versioned backend-only reader for literal069 or079 source snapshots. The port must
 * reauthorize and verify Storage/TLS/XSD first; the payload and context are checked again here. */
export function createReceiptEvidenceReaderV2(configuration){
 const c=data(configuration,['readReceipt']);need(typeof c.readReceipt==='function');const port=c.readReceipt;
 return async function read(input,options={}){
  const v=data(input,['request','actor','sourceKind','sourceCommandId','authorizationCommandId','authorizationAttemptId']);
  const {request,...selection}=v,selected=captureReceiptQuerySourceInput(selection),ctx=original(request),s=scope(options,10000);let payload;
  try{
   const answer=await s.bounded(()=>port(selected,Object.freeze({signal:s.signal,deadline:s.deadline,maxPayloadBytes:MAX_RECEIPT_BYTES})));s.check();
   const a=data(answer,['source','payloadBytes']),source=projectReceiptQuerySource(a.source,selected),r=source.original_source.receipt,recovery=source.original_source.recovery,e=receiptQuerySourceEvidence(source);
   payload=copy(a.payloadBytes);const details=authorizationReceiptDetails({request,payloadBytes:payload});
   need(r.model===ctx.model&&r.signed_hash===ctx.signedHash&&r.batch_id===ctx.batchId&&recovery.access_key===ctx.accessKey&&recovery.reference_digest===ctx.referenceDigest,'RECEIPT_SOURCE_CONTEXT_MISMATCH');
   need(details.payload_hash===e.payload_hash&&details.receipt_number===e.receipt_number&&details.received_at===e.received_at,'RECEIPT_SOURCE_CONTEXT_MISMATCH');
   need(Date.parse(details.received_at)>=Date.parse(ctx.issuedAt),'RECEIPT_TIMESTAMP_INVALID');
   const handle=freeze({profile:RECEIPT_PROFILE,manifestHash:RECEIPT_MANIFEST_HASH,model:ctx.model,environment:'2',origin:'operational',actor:selected.actor,candidateId:r.candidate_id,candidateVersion:r.candidate_version,commandId:r.command_id,
    sourceProfile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,sourceManifestHash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,sourceKind:source.source_kind,sourceCommandId:source.source_command_id,authorizationAttemptId:source.authorization_attempt_id,sourceBindingHash:source.source_binding_hash,
    sourceState:'receipt_pending',batchId:ctx.batchId,signedHash:ctx.signedHash,authorizationPayloadHash:ctx.authorizationPayloadHash,authorizationRequestHash:recovery.request_hash,
    sourceResponseHash:source.original_source.artifact.response_hash,sourcePayloadHash:details.payload_hash,receiptNumber:details.receipt_number,sourceEvidenceHash:digest(canonical(source)),...RECEIPT_FLAGS});
   s.check();evidences.set(handle,{...ctx,evidence:handle});return handle;
  }finally{payload?.fill(0);s.close();}
 };
}
const selectedIdentity=e=>e.sourceKind===undefined?{}:{sourceProfile:e.sourceProfile,sourceManifestHash:e.sourceManifestHash,sourceKind:e.sourceKind,sourceCommandId:e.sourceCommandId,authorizationAttemptId:e.authorizationAttemptId,sourceBindingHash:e.sourceBindingHash};
export function prepareReceiptQuery(input){
 const v=data(input,['evidence']),ctx=branded(evidences,v.evidence,'RECEIPT_EVIDENCE_UNATTESTED'),e=ctx.evidence;
 const xml=`<consReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><nRec>${e.receiptNumber}</nRec></consReciNFe>`;
 const handle=freeze({profile:RECEIPT_PROFILE,manifestHash:RECEIPT_MANIFEST_HASH,model:e.model,environment:'2',origin:e.origin,candidateId:e.candidateId,commandId:e.commandId,
  sourceState:'receipt_pending',batchId:e.batchId,signedHash:e.signedHash,receiptNumber:e.receiptNumber,sourceEvidenceHash:e.sourceEvidenceHash,
  requestHash:digest(xml),sizeBytes:Buffer.byteLength(xml),...selectedIdentity(e),...RECEIPT_FLAGS});queries.set(handle,{...ctx,xml});return handle;
}
export function receiptRequestBytes(handle){return Buffer.from(branded(queries,handle,'RECEIPT_QUERY_UNATTESTED').xml);}
/** Association is by local handle, even when two queries have equal consReciNFe hashes. */
export function assertReceiptQueryEvidence(input){const v=data(input,['evidence','request']);branded(evidences,v.evidence,'RECEIPT_EVIDENCE_UNATTESTED');need(branded(queries,v.request,'RECEIPT_QUERY_UNATTESTED').evidence===v.evidence,'RECEIPT_QUERY_SOURCE_MISMATCH');return v.request;}
/** Private validator context. A copied/forged handle cannot obtain context. */
export function receiptValidationContext(handle){const c=branded(queries,handle,'RECEIPT_QUERY_UNATTESTED');return Object.freeze({model:c.model,accessKey:c.accessKey,referenceDigest:c.referenceDigest,issuedAt:c.issuedAt,receiptNumber:c.evidence.receiptNumber});}
function protocol(n,ctx){
 attrs(n,['versao']);need(n.getAttribute('versao')==='4.00','RECEIPT_STRUCTURE_INVALID');
 const list=elements(n);need(list.length>=1&&list.length<=2&&list[0].localName==='infProt'&&list[0].namespaceURI===NS&&!list[0].prefix&&(!list[1]||(list[1].localName==='Signature'&&list[1].namespaceURI===DS)),'RECEIPT_STRUCTURE_INVALID');
 const inf=list[0];attrs(inf,['Id']);const p=children(inf,['tpAmb','verAplic','chNFe','dhRecbto','nProt','digVal','cStat','xMotivo','cMsg','xMsg'],['cMsg','xMsg']);
 const messages=elements(inf).filter(n=>['cMsg','xMsg'].includes(n.localName));need(messages.length<=10&&messages.length%2===0&&messages.every((n,i)=>n.localName===(i%2?'xMsg':'cMsg')),'RECEIPT_STRUCTURE_INVALID');
 for(const n of messages){const value=leaf(n);need(n.localName==='cMsg'?/^\d{1,4}$/.test(value):Array.from(value).length>=1&&Array.from(value).length<=255,'RECEIPT_STRUCTURE_INVALID');}
 need(leaf(p.tpAmb)==='2'&&leaf(p.chNFe)===ctx.accessKey,'RECEIPT_PROTOCOL_CONTEXT_MISMATCH');label(p.verAplic,20);label(p.xMotivo,255);
 const cStat=status(leaf(p.cStat)),receivedAt=stamp(leaf(p.dhRecbto)),number=leaf(p.nProt,true),value=leaf(p.digVal,true);
 if(number!==null)need(/^(?:\d{15}|\d{17})$/.test(number)&&!/^0+$/.test(number),'RECEIPT_PROTOCOL_NUMBER_INVALID');
 if(value!==null)need(/^[A-Za-z0-9+/]{27}=$/.test(value)&&Buffer.from(value,'base64').toString('base64')===value&&value===ctx.referenceDigest,'RECEIPT_PROTOCOL_DIGEST_MISMATCH');
 if(['100','150'].includes(cStat))need(number!==null&&value!==null&&Date.parse(receivedAt)>=Date.parse(ctx.issuedAt),'RECEIPT_PROTOCOL_INCOMPLETE');
 return Object.freeze({cStat,number,receivedAt,referenceDigestMatched:value!==null});
}
export function parseReceiptResponse(input){
 const v=data(input,['request','responseBytes']),ctx=branded(queries,v.request,'RECEIPT_QUERY_UNATTESTED'),bytes=copy(v.responseBytes);
 try{
  const root=parse(text(bytes)).documentElement;need(root.localName==='retConsReciNFe'&&root.namespaceURI===NS&&!root.prefix,'RECEIPT_RESPONSE_ROOT_INVALID');attrs(root,['versao']);need(root.getAttribute('versao')==='4.00','RECEIPT_STRUCTURE_INVALID');
  const p=children(root,['tpAmb','verAplic','nRec','cStat','xMotivo','cUF','dhRecbto','cMsg','xMsg','protNFe'],['protNFe']);
  need(leaf(p.tpAmb)==='2'&&leaf(p.cUF)==='35'&&leaf(p.nRec)===ctx.evidence.receiptNumber,'RECEIPT_RESPONSE_CONTEXT_MISMATCH');label(p.verAplic,20);label(p.xMotivo,255);
  need(Boolean(p.cMsg)===Boolean(p.xMsg),'RECEIPT_STRUCTURE_INVALID');if(p.cMsg){need(/^\d{1,4}$/.test(leaf(p.cMsg)),'RECEIPT_STRUCTURE_INVALID');label(p.xMsg,200);}
  const cStat=status(leaf(p.cStat)),receivedAt=stamp(leaf(p.dhRecbto)),protocols=elements(root).filter(n=>n.localName==='protNFe');let prot=null,classification='review_required';
  if(cStat==='104'){
   need(protocols.length===1,'RECEIPT_SINGLE_CANDIDATE_REQUIRED');prot=protocol(protocols[0],ctx);
   classification=['100','150'].includes(prot.cStat)?'authorization_declared':Number(prot.cStat)>=200&&!['204','217','539'].includes(prot.cStat)?'rejected':'review_required';
  }else{need(protocols.length===0,'RECEIPT_BATCH_STRUCTURE_MISMATCH');if(cStat==='105')classification='receipt_pending';}
  const result=freeze({profile:RECEIPT_PROFILE,manifestHash:RECEIPT_MANIFEST_HASH,model:ctx.model,environment:'2',origin:ctx.evidence.origin,candidateId:ctx.evidence.candidateId,commandId:ctx.evidence.commandId,
   sourceState:'receipt_pending',sourceEvidenceHash:ctx.evidence.sourceEvidenceHash,requestHash:v.request.requestHash,responseHash:digest(bytes),sizeBytes:bytes.length,
   receiptNumber:ctx.evidence.receiptNumber,batchId:ctx.batchId,signedHash:ctx.signedHash,cStat,receivedAt,classification,protocol:prot,...selectedIdentity(ctx.evidence),...RECEIPT_FLAGS});
  responses.set(result,v.request);return result;
 }finally{bytes.fill(0);}
}

/** Local provenance only; future consumers must still reauthorize backend evidence. */
export function assertReceiptResponse(input){const v=data(input,['request','response']);branded(queries,v.request,'RECEIPT_QUERY_UNATTESTED');need(responses.get(v.response)===v.request,'RECEIPT_RESPONSE_UNATTESTED');return v.response;}
