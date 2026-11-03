/** Offline NF-e55 distribution contract. No network, certificate access or manifestation. */
import {DOMParser} from '@xmldom/xmldom';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {isValidCnpj,inspectAccessKey,validFiscalTimestamp} from '../../fiscal-core/src/identity.mjs';

const NS='http://www.portalfiscal.inf.br/nfe',SOAP='http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE='http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe',XMLNS='http://www.w3.org/2000/xmlns/';
const UF=new Set(['11','12','13','14','15','16','17','21','22','23','24','25','26','27','28','29','31','32','33','35','41','42','43','50','51','52','53']);
const NO_TRUST=Object.freeze({offline:true,canQuery:false,canManifest:false,canEmit:false,tlsOriginVerified:false,signatureVerified:false,xsdValidated:false,sefazAuthorized:false,financialMutationPerformed:false,stockMutationPerformed:false});
export const DISTRIBUTION_LIMITS=Object.freeze({responseBytes:8*1024*1024,compressedDocumentBytes:1024*1024,documentBytes:8*1024*1024,totalDocumentBytes:32*1024*1024,documents:50,depth:80,nodes:200000,defaultTimeoutMs:10000});
export class DistributionError extends Error{constructor(code){super(code);this.name='DistributionError';this.code=code;}}
const need=(v,code)=>{if(!v)throw new DistributionError(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>need(object(v)&&Object.keys(v).every(k=>keys.includes(k)),'DFE_INPUT_INVALID');
const hash=v=>createHash('sha256').update(v).digest('hex');
const parsedResponses=new WeakSet();
function freezeTree(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value);}return value;}
const nsu=v=>typeof v==='string'&&/^[0-9]{15}$/.test(v);
const children=n=>Array.from(n.childNodes??[]).filter(x=>x.nodeType===1);
const named=(n,name)=>children(n).filter(x=>x.localName===name&&x.namespaceURI===NS);
function one(n,name){const v=named(n,name);need(v.length===1,'DFE_ELEMENT_AMBIGUOUS');return v[0];}
function attrs(n,allowed=[]){for(const a of Array.from(n.attributes??[]))need(a.namespaceURI===XMLNS||(!a.namespaceURI&&allowed.includes(a.name)),'DFE_ATTRIBUTE_UNSUPPORTED');}
function leaf(n){attrs(n);need(children(n).length===0,'DFE_TEXT_REQUIRED');return n.textContent;}
const value=(n,name)=>leaf(one(n,name));
const whitespace=n=>need(Array.from(n.childNodes).every(x=>x.nodeType!==3||!x.data.trim()),'DFE_MIXED_CONTENT');
function group(n,names,namespace=NS){attrs(n);need(children(n).map(x=>x.localName).join(',')===names.join(',')&&children(n).every(x=>x.namespaceURI===namespace),'DFE_STRUCTURE_INVALID');need(Array.from(n.childNodes).every(x=>x.nodeType!==3||!x.data.trim()),'DFE_MIXED_CONTENT');}
function decode(bytes,max){need(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=max,'DFE_SIZE_LIMIT');try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new DistributionError('DFE_UTF8_INVALID');}}
function parseXml(bytes,max){
 const xml=decode(bytes,max);need(!xml.includes('\uFEFF')&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/u.test(xml),'DFE_UTF8_INVALID');
 need(!/<!/u.test(xml),'DFE_XML_DECLARATION_UNSUPPORTED');
 const body=xml.replace(/^<\?xml version=["']1\.0["'](?: encoding=["'](?:UTF-8|utf-8)["'])?\?>/u,'');need(!body.includes('<?'),'DFE_XML_PI_UNSUPPORTED');
 need((xml.match(/</g)??[]).length<=DISTRIBUTION_LIMITS.nodes,'DFE_XML_NODE_LIMIT');let doc;
 try{doc=new DOMParser({onError:()=>{throw new Error('parse');}}).parseFromString(xml,'application/xml');}catch{throw new DistributionError('DFE_XML_MALFORMED');}
 need(doc.documentElement&&!doc.doctype&&children(doc).length===1,'DFE_XML_ROOT_INVALID');let count=0;const stack=[[doc,0]];
 while(stack.length){const[n,depth]=stack.pop();need(depth<=DISTRIBUTION_LIMITS.depth&&++count<=DISTRIBUTION_LIMITS.nodes,'DFE_XML_TREE_LIMIT');need([1,3,7,9].includes(n.nodeType),'DFE_XML_NODE_UNSUPPORTED');if(n.nodeType===7)need(n.target==='xml'&&n.parentNode===doc&&n===doc.firstChild,'DFE_XML_PI_UNSUPPORTED');if(n.nodeType===1)need(n.attributes.length<=40,'DFE_XML_ATTRIBUTE_LIMIT');for(const x of Array.from(n.childNodes??[]))stack.push([x,depth+1]);}
 need(Array.from(doc.childNodes).every(x=>x.nodeType!==3||!x.data.trim()),'DFE_XML_ROOT_INVALID');return{xml,doc,root:doc.documentElement};
}
function responseRoot(root){
 if(root.localName==='retDistDFeInt'&&root.namespaceURI===NS)return root;
 need(root.localName==='Envelope'&&root.namespaceURI===SOAP,'DFE_SOAP_UNSUPPORTED');attrs(root);whitespace(root);
 const outer=children(root);need(outer.length===1||outer.length===2,'DFE_SOAP_AMBIGUOUS');
 if(outer.length===2){need(outer[0].localName==='Header'&&outer[0].namespaceURI===SOAP,'DFE_SOAP_UNSUPPORTED');group(outer[0],[],SOAP);}
 const body=outer.at(-1);need(body.localName==='Body'&&body.namespaceURI===SOAP,'DFE_SOAP_UNSUPPORTED');group(body,['nfeDistDFeInteresseResponse'],SERVICE);
 const response=children(body)[0];group(response,['nfeDistDFeInteresseResult'],SERVICE);const result=children(response)[0];group(result,['retDistDFeInt']);
 const all=[root,...Array.from(root.getElementsByTagName('*'))];for(const name of['Envelope','Body','nfeDistDFeInteresseResponse','nfeDistDFeInteresseResult','retDistDFeInt'])need(all.filter(n=>n.localName===name).length===1,'DFE_SOAP_AMBIGUOUS');
 return children(result)[0];
}
function textLimit(v,max){return typeof v==='string'&&v.length>=1&&v.length<=max&&/^[!-\u00ff](?:[ -\u00ff]*[!-\u00ff])?$/u.test(v);}
function responseTimestamp(v){return validFiscalTimestamp(v)&&/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:[+-](?:0\d|1[01]):00|\+12:00)$/u.test(v);}
function deadlineCheck(deadline,signal){need(!signal?.aborted,'DFE_ABORTED');need(Date.now()<deadline,'DFE_TIMEOUT');}
async function inflate(bytes,deadline,signal){
 deadlineCheck(deadline,signal);need(bytes.length>=18&&bytes[0]===0x1f&&bytes[1]===0x8b&&bytes[2]===8,'DFE_GZIP_REQUIRED');
 return new Promise((resolve,reject)=>{
  const stream=createGunzip(),parts=[];let size=0,done=false;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stream.destroy();error?reject(error):resolve(result);};
  const abort=()=>finish(new DistributionError('DFE_ABORTED'));
  const timer=setTimeout(()=>finish(new DistributionError('DFE_TIMEOUT')),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',abort,{once:true});
  stream.on('data',part=>{size+=part.length;if(size>DISTRIBUTION_LIMITS.documentBytes)finish(new DistributionError('DFE_GZIP_OUTPUT_LIMIT'));else parts.push(part);});
  stream.on('error',()=>finish(new DistributionError('DFE_GZIP_INVALID')));
  stream.on('end',()=>finish(null,Buffer.concat(parts,size)));
  if(signal?.aborted)abort();else stream.end(bytes);
 });
}
function packed(node){
 attrs(node,['NSU','schema']);need(children(node).length===0,'DFE_DOCZIP_INVALID');const compact=node.textContent.replace(/[ \r\n\t]/g,'');
 need(compact.length>0&&compact.length<=Math.ceil(DISTRIBUTION_LIMITS.compressedDocumentBytes/3)*4&&compact.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(compact),'DFE_BASE64_INVALID');
 const bytes=Buffer.from(compact,'base64');need(bytes.length<=DISTRIBUTION_LIMITS.compressedDocumentBytes&&bytes.toString('base64')===compact,'DFE_BASE64_INVALID');
 const schema=node.getAttribute('schema');need(schema.length<=100&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\.xsd$/.test(schema),'DFE_SCHEMA_NAME_INVALID');
 const id=node.hasAttribute('NSU')?node.getAttribute('NSU'):null;need(id===null||nsu(id),'DFE_NSU_INVALID');return{bytes,schema,nsu:id};
}
function documentInfo(root,schema,request){
 const profiles={resNFe_v1_00:['resNFe','1.00','invoice_summary'],resNFe_v1_01:['resNFe','1.01','invoice_summary'],resEvento_v1_00:['resEvento','1.00','event_summary'],resEvento_v1_01:['resEvento','1.01','event_summary'],procNFe_v3_10:['nfeProc','3.10','invoice'],procNFe_v4_00:['nfeProc','4.00','invoice'],procEventoNFe_v1_00:['procEventoNFe','1.00','event']};
 const profile=profiles[schema.replace(/\.xsd$/,'').replaceAll('.','_')];
 if(!profile)return{kind:'unsupported',accessKey:null,model:null,recipientMatch:null,quarantined:true,issues:['SCHEMA_NOT_SUPPORTED']};
 need(root.localName===profile[0]&&root.namespaceURI===NS&&root.getAttribute('versao')===profile[1],'DFE_DOCUMENT_SCHEMA_MISMATCH');
 let key,recipientMatch=null;
 if(profile[2]==='invoice'){
  const nfe=one(root,'NFe'),inf=one(nfe,'infNFe'),prot=one(one(root,'protNFe'),'infProt');const documentId=inf.getAttribute('Id');need(/^NFe[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/.test(documentId),'DFE_DOCUMENT_ACCESS_KEY_INVALID');key=documentId.slice(3);
  need(value(prot,'chNFe')===key&&value(prot,'tpAmb')===request.environment&&value(one(inf,'ide'),'tpAmb')===request.environment,'DFE_DOCUMENT_CONTEXT_MISMATCH');
  const dest=named(inf,'dest');need(dest.length<=1,'DFE_ELEMENT_AMBIGUOUS');if(dest.length){const cnpj=named(dest[0],'CNPJ');need(cnpj.length<=1,'DFE_ELEMENT_AMBIGUOUS');recipientMatch=cnpj.length?leaf(cnpj[0])===request.interestedCnpj:false;}
 }else if(profile[2]==='event'){
  const event=one(one(root,'evento'),'infEvento'),result=one(one(root,'retEvento'),'infEvento');key=value(event,'chNFe');need(value(result,'chNFe')===key&&value(event,'tpAmb')===request.environment&&value(result,'tpAmb')===request.environment,'DFE_DOCUMENT_CONTEXT_MISMATCH');
 }else key=value(root,'chNFe');
 const inspected=inspectAccessKey(key);need(inspected.valid&&inspected.parts.model==='55','DFE_DOCUMENT_ACCESS_KEY_INVALID');
 return{kind:profile[2],accessKey:key,model:'55',recipientMatch,quarantined:false,issues:recipientMatch===false?['OTHER_INTEREST_NOT_RECEIVED_INVOICE']:[]};
}

export function buildDistributionRequest(input){
 exact(input,['environment','authorUf','interestedCnpj','lastNsu']);
 need(['1','2'].includes(input.environment)&&UF.has(input.authorUf)&&isValidCnpj(input.interestedCnpj)&&nsu(input.lastNsu),'DFE_REQUEST_INVALID');
 const request=Object.freeze({environment:input.environment,authorUf:input.authorUf,interestedCnpj:input.interestedCnpj,lastNsu:input.lastNsu,mode:'distNSU',model:'55',version:'1.01'});
 const xml=`<distDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${request.environment}</tpAmb><cUFAutor>${request.authorUf}</cUFAutor><CNPJ>${request.interestedCnpj}</CNPJ><distNSU><ultNSU>${request.lastNsu}</ultNSU></distNSU></distDFeInt>`;
 const envelopeXml=`<soap:Envelope xmlns:soap="${SOAP}"><soap:Body><nfeDistDFeInteresse xmlns="${SERVICE}"><nfeDadosMsg>${xml}</nfeDadosMsg></nfeDistDFeInteresse></soap:Body></soap:Envelope>`;
 return Object.freeze({request,xml,envelopeXml,requestHash:hash(xml),bindingStatus:'official-NT-example-offline-not-WSDL-verified',...NO_TRUST});
}

/** Returned XML and identifiers are private ingestion data; never put this object in logs. */
export async function parseDistributionResponse(bytes,{request:input,deadline=Date.now()+DISTRIBUTION_LIMITS.defaultTimeoutMs,signal}={}){
 const prepared=buildDistributionRequest(input),request=prepared.request;need(Number.isSafeInteger(deadline)&&deadline<=Date.now()+30000,'DFE_DEADLINE_INVALID');deadlineCheck(deadline,signal);
 need(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=DISTRIBUTION_LIMITS.responseBytes,'DFE_SIZE_LIMIT');
 const original=Buffer.from(bytes),responseHash=hash(original);
 const parsed=parseXml(original,DISTRIBUTION_LIMITS.responseBytes),root=responseRoot(parsed.root);attrs(root,['versao']);whitespace(root);need(root.getAttribute('versao')==='1.01','DFE_LAYOUT_UNSUPPORTED');
 const tags=children(root).map(n=>n.localName);const expected=['tpAmb','verAplic','cStat','xMotivo','dhResp'];let offset=5;
 for(const tag of['ultNSU','maxNSU','loteDistDFeInt'])if(tags[offset]===tag){expected.push(tag);offset++;}
 need(tags.join(',')===expected.join(',')&&children(root).every(n=>n.namespaceURI===NS),'DFE_RESPONSE_STRUCTURE_INVALID');
 need(value(root,'tpAmb')===request.environment,'DFE_RESPONSE_ENVIRONMENT_MISMATCH');const application=value(root,'verAplic'),status=value(root,'cStat'),reason=value(root,'xMotivo'),respondedAt=value(root,'dhResp');
 need(textLimit(application,20)&&/^[0-9]{3}$/.test(status)&&textLimit(reason,255)&&responseTimestamp(respondedAt),'DFE_RESPONSE_FIELDS_INVALID');
 const last=named(root,'ultNSU').length?value(root,'ultNSU'):null,max=named(root,'maxNSU').length?value(root,'maxNSU'):null;
 need((last===null||nsu(last))&&(max===null||nsu(max))&&(last===null||max===null||last<=max),'DFE_RESPONSE_CURSOR_INVALID');
 const batches=named(root,'loteDistDFeInt'),nodes=batches.length?children(batches[0]):[];
 if(batches.length){group(batches[0],nodes.map(()=> 'docZip'));need(nodes.length>=1&&nodes.length<=DISTRIBUTION_LIMITS.documents,'DFE_DOCUMENT_COUNT_INVALID');}
 need(status==='138'?nodes.length>0:nodes.length===0,'DFE_STATUS_DOCUMENTS_MISMATCH');
 const documents=[],issues=[];let total=0,previous=request.lastNsu;
 for(const node of nodes){
  deadlineCheck(deadline,signal);const data=packed(node),plain=await inflate(data.bytes,deadline,signal);total+=plain.length;need(total<=DISTRIBUTION_LIMITS.totalDocumentBytes,'DFE_BATCH_OUTPUT_LIMIT');
  const decoded=parseXml(plain,DISTRIBUTION_LIMITS.documentBytes),info=documentInfo(decoded.root,data.schema,request);deadlineCheck(deadline,signal);
  if(data.nsu===null)issues.push('DOCUMENT_NSU_MISSING');else{need(data.nsu>previous&&(last===null||data.nsu<=last),'DFE_DOCUMENT_NSU_ORDER_INVALID');if(BigInt(data.nsu)!==BigInt(previous)+1n)issues.push('NSU_GAP_OBSERVED');previous=data.nsu;}
  documents.push(Object.freeze({nsu:data.nsu,schema:data.schema,xml:decoded.xml,sha256:hash(plain),sizeBytes:plain.length,compressedSha256:hash(data.bytes),...info}));
 }
 if(last===null||max===null)issues.push('RESPONSE_CURSOR_MISSING');
 if(last!==null&&last<request.lastNsu)issues.push('CURSOR_REGRESSION');
 if(status==='138'&&last!==previous)issues.push('CURSOR_WITHOUT_DOCUMENT');
 if(status==='137'&&last!==null&&last!==request.lastNsu)issues.push('EMPTY_RESPONSE_CURSOR_CHANGED');
 deadlineCheck(deadline,signal);
 const response=freezeTree({profile:'nfe55-distribution-offline-v1',request:prepared.request,requestHash:prepared.requestHash,responseHash,status,reason,application,respondedAt,lastNsu:last,maxNsu:max,documents,issues:[...new Set(issues)],...NO_TRUST});
 parsedResponses.add(response);return response;
}

/** Configuration is a readiness check, never an authorization to use A1 or SEFAZ. */
export function inspectDistributionCoordination(input){
 exact(input,['coordinator','checkpointConfirmed','lastNsu','otherConsumersReviewed']);
 need(['unconfirmed','external','brufap'].includes(input.coordinator)&&typeof input.checkpointConfirmed==='boolean'&&typeof input.otherConsumersReviewed==='boolean'&&(input.lastNsu===null||nsu(input.lastNsu)),'DFE_COORDINATION_INVALID');
 const issues=[];if(input.coordinator!=='brufap')issues.push('CONSULTATION_COORDINATOR_UNCONFIRMED');if(!input.otherConsumersReviewed)issues.push('OTHER_CONSUMERS_NOT_REVIEWED');if(!input.checkpointConfirmed||input.lastNsu===null)issues.push('NSU_CHECKPOINT_UNCONFIRMED');
 return Object.freeze({ready:issues.length===0,issues:Object.freeze(issues),lastNsu:input.lastNsu,...NO_TRUST});
}

/** Only proposes the next transaction. No cursor is advanced here. */
export function planDistributionContinuation({response,coordination,receivedAt}){
 need(parsedResponses.has(response),'DFE_PLAN_UNTRUSTED');
 const config=inspectDistributionCoordination(coordination);need(object(response)&&response.profile==='nfe55-distribution-offline-v1'&&/^[a-f0-9]{64}$/.test(response.responseHash)&&/^[0-9]{3}$/.test(response.status)&&Array.isArray(response.issues)&&Array.isArray(response.documents)&&object(response.request)&&nsu(response.request.lastNsu),'DFE_PLAN_INVALID');
 need(validFiscalTimestamp(receivedAt),'DFE_RECEIPT_TIME_INVALID');const afterHour=new Date(Date.parse(receivedAt)+3600000).toISOString();
 const base={responseHash:response.responseHash,currentCheckpoint:coordination.lastNsu,candidateCheckpoint:null,notBefore:null,requiresAtomicPersistence:false,requiresOperatorReview:false,...NO_TRUST};
 if(!config.ready)return Object.freeze({...base,action:'coordination_required',issues:config.issues});
 if(coordination.lastNsu!==response.request.lastNsu)return Object.freeze({...base,action:'review_required',requiresOperatorReview:true,issues:['LOCAL_CHECKPOINT_CHANGED']});
 if(response.status==='656')return Object.freeze({...base,action:'wait_and_review',notBefore:afterHour,requiresOperatorReview:true,reportedCheckpoint:response.lastNsu,issues:['CONSUMPTION_BLOCKED_NO_AUTOMATIC_RESET']});
 if(response.issues.length)return Object.freeze({...base,action:'review_required',requiresOperatorReview:true,issues:[...response.issues]});
 if(!['137','138'].includes(response.status))return Object.freeze({...base,action:'review_required',requiresOperatorReview:true,issues:['SERVICE_STATUS_REQUIRES_REVIEW']});
 need(nsu(response.lastNsu)&&nsu(response.maxNsu)&&response.lastNsu<=response.maxNsu,'DFE_PLAN_INVALID');
 if(response.status==='137')return Object.freeze({...base,action:'wait',notBefore:afterHour,issues:[]});
 const caughtUp=response.lastNsu===response.maxNsu;
 return Object.freeze({...base,action:caughtUp?'commit_batch_then_wait':'commit_batch_then_continue',candidateCheckpoint:response.lastNsu,notBefore:caughtUp?afterHour:null,requiresAtomicPersistence:true,issues:response.documents.some(x=>x.quarantined)?['QUARANTINE_MUST_BE_DURABLE_BEFORE_CHECKPOINT']:[]});
}
