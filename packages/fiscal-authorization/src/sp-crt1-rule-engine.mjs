/** Pure reviewed subset; no network, env, certificate custody, SQL or transmission. */
import {createHash} from 'node:crypto';
import {authorizationRequestBytes} from './index.mjs';
import {parseStrict,elements,serialize} from '../../fiscal-xml/src/xml.mjs';
import {gtinCheckDigitMatches} from '../../fiscal-core/src/item-preparation.mjs';
export const MAX_RULE_REVIEW_BYTES=131072;
export const RULE_PROFILE_FLAGS=Object.freeze({taxRulesValidated:false,canEmit:false,canTransmit:false,sefazAuthorized:false,operationallyApproved:false});
export class SpCrt1RuleError extends Error {constructor(code){super(code);this.name='SpCrt1RuleError';this.code=code;}}

/** Internal versioned factory. Each profile owns separate opaque handles. */
export function createRuleEngine(MANIFEST,MANIFEST_HASH,prefixInspector=null){
const need=(ok,code='RULE_INPUT_INVALID')=>{if(!ok)throw new SpCrt1RuleError(code);};
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
function canonical(value){let count=0;const visit=(v,depth)=>{need(depth<=16&&++count<=25000,'RULE_DATA_LIMIT');if(v===null||typeof v!=='object')return v;return Array.isArray(v)?v.map(x=>visit(x,depth+1)):Object.fromEntries(Object.keys(v).sort().map(k=>[k,visit(v[k],depth+1)]));};return JSON.stringify(visit(value,0));}
const candidates=new WeakMap(),reviews=new WeakMap(),reports=new WeakSet();
const NS='http://www.portalfiscal.inf.br/nfe';
function fields(value,keys,optional=[]){
 try{need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));
  const ds=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(ds);
  need(keys.every(k=>Object.hasOwn(ds,k))&&own.every(k=>typeof k==='string'&&[...keys,...optional].includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')));
  return Object.fromEntries(own.map(k=>[k,ds[k].value]));
 }catch{throw new SpCrt1RuleError('RULE_INPUT_INVALID');}
}
function time(v){let n;try{n=Date.prototype.getTime.call(v);}catch{}need(Number.isFinite(n),'RULE_CLOCK_INVALID');return n;}
function stamp(v){
 const m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(v);
 need(m&&+m[1]>=2000&&+m[4]<24&&+m[5]<60&&+m[6]<60&&(+m[8]||0)<=14&&(+m[9]||0)<60&&!(+m[8]===14&&+m[9]!==0),'RULE_REVIEW_INVALID');
 const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));need(d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3],'RULE_REVIEW_INVALID');return Date.parse(v);
}
function candidate(v){const c=candidates.get(v);need(c,'RULE_CANDIDATE_UNATTESTED');return c;}
function nodes(parent,name){return elements(parent).filter(n=>n.namespaceURI===NS&&n.localName===name);}
function one(parent,name,optional=false){const n=nodes(parent,name);need((n.length===1||optional&&n.length===0)&&!n[0]?.prefix,'RULE_XML_STRUCTURE_INVALID');return n[0]??null;}
function leaf(parent,name,optional=false){const n=one(parent,name,optional);if(!n)return null;attrs(n);need(elements(n).length===0&&n.textContent.length<=4096,'RULE_XML_STRUCTURE_INVALID');return n.textContent;}
function attrs(node,allowed=[]){need(Array.from(node.attributes??[]).every(a=>a.namespaceURI==='http://www.w3.org/2000/xmlns/'||!a.namespaceURI&&allowed.includes(a.name)),'RULE_XML_STRUCTURE_INVALID');}
function only(node,allowed,repeated=[],unsupported=[]){
 const seen=new Set();for(const n of elements(node)){need(n.namespaceURI===NS&&!n.prefix,'RULE_XML_STRUCTURE_INVALID');need(!seen.has(n.localName)||repeated.includes(n.localName),'RULE_XML_STRUCTURE_INVALID');seen.add(n.localName);if(!allowed.includes(n.localName))unsupported.push(n.localName);}
 need(Array.from(node.childNodes).every(n=>n.nodeType!==3||!n.data.trim()),'RULE_XML_STRUCTURE_INVALID');return unsupported;
}
function mapLeaves(node,allowed,unsupported){const out={};attrs(node);need(node.namespaceURI===NS&&!node.prefix,'RULE_XML_STRUCTURE_INVALID');only(node,allowed,[],unsupported);for(const n of elements(node)){if(allowed.includes(n.localName)){attrs(n);need(elements(n).length===0&&n.textContent.length<=4096,'RULE_XML_STRUCTURE_INVALID');out[n.localName]=n.textContent;}}return out;}
function taxGroup(imposto,name,group,unsupported){const node=one(imposto,name);attrs(node);only(node,[group],[],unsupported);const g=one(node,group,true);if(!g)return null;return mapLeaves(g,['CST','vBC','p'+name,'v'+name],unsupported);}

/** request must be the local, uncloneable result of prepareAuthorization over the exact pinned signed bytes. */
function inspectSpCrt1Candidate(input){
 const v=fields(input,['candidateId','request']);need(uuid(v.candidateId));let bytes;
 try{bytes=authorizationRequestBytes(v.request);}catch{throw new SpCrt1RuleError('RULE_REQUEST_UNATTESTED');}
 try{
  const root=parseStrict(new TextDecoder('utf-8',{fatal:true}).decode(bytes)).documentElement;
  need(hash(bytes)===v.request.requestHash&&root.localName==='enviNFe','RULE_REQUEST_MISMATCH');
  const nfe=one(root,'NFe'),inf=one(nfe,'infNFe'),unsupported=[];attrs(nfe);attrs(inf,['Id','versao']);
  only(inf,['ide','emit','dest','det','total','transp','pag','infAdic'],['det'],unsupported);
  const ide=mapLeaves(one(inf,'ide'),['cUF','cNF','natOp','mod','serie','nNF','dhEmi','tpNF','idDest','cMunFG','tpImp','tpEmis','cDV','tpAmb','finNFe','indFinal','indPres','procEmi','verProc'],unsupported);
  const emit=one(inf,'emit'),dest=one(inf,'dest'),ea=one(emit,'enderEmit'),da=one(dest,'enderDest');
  for(const n of [emit,dest,ea,da])attrs(n);
  for(const n of [ea,da])only(n,['xLgr','nro','xCpl','xBairro','cMun','xMun','UF','CEP','cPais','xPais','fone'],[],unsupported);
  only(emit,['CNPJ','xNome','xFant','enderEmit','IE','CRT'],[],unsupported);only(dest,['CNPJ','CPF','xNome','enderDest','indIEDest','IE'],[],unsupported);
  const recipient={indIEDest:leaf(dest,'indIEDest'),ie:leaf(dest,'IE',true),uf:leaf(da,'UF')};
  const lines=nodes(inf,'det');need(lines.length>0&&lines.length<=250,'RULE_ITEM_LIMIT');
  const labels=[];
  const items=lines.map((n,i)=>{
   attrs(n,['nItem']);need(n.getAttribute('nItem')===String(i+1),'RULE_XML_STRUCTURE_INVALID');const extra=[];only(n,['prod','imposto'],[],extra);
   const p=mapLeaves(one(n,'prod'),['cProd','cEAN','xProd','NCM','CEST','cBenef','CFOP','uCom','qCom','vUnCom','vProd','cEANTrib','uTrib','qTrib','vUnTrib','vFrete','vSeg','vDesc','vOutro','indTot'],extra);
   for(const k of ['cProd','cEAN','xProd','NCM','CFOP','cEANTrib'])need(typeof p[k]==='string'&&p[k].length>0,'RULE_XML_STRUCTURE_INVALID');
   // Presentation is deliberately separate: the reviewed facts/profile hashes stay unchanged.
   labels.push({position:i+1,description:p.xProd,unit:p.uCom??null,quantity:p.qCom??null,unit_price:p.vUnCom??null,product_total:p.vProd??null});
   const imposto=one(n,'imposto');attrs(imposto);only(imposto,['ICMS','PIS','COFINS'],[],extra);const icms=one(imposto,'ICMS');attrs(icms);need(elements(icms).length===1,'RULE_XML_STRUCTURE_INVALID');
   const g=elements(icms)[0];if(!['ICMSSN101','ICMSSN102','ICMSSN500'].includes(g.localName))extra.push('ICMS_BRANCH');
   const c=mapLeaves(g,['orig','CSOSN','pCredSN','vCredICMSSN','vBCSTRet','pST','vICMSSubstituto','vICMSSTRet','vBCFCPSTRet','pFCPSTRet','vFCPSTRet','pRedBCEfet','vBCEfet','pICMSEfet','vICMSEfet'],extra);
   need(c.CSOSN===g.localName.replace('ICMSSN','')||extra.includes('ICMS_BRANCH'),'RULE_XML_STRUCTURE_INVALID');
   const common=['orig','CSOSN'],branch=c.CSOSN==='102'?common:c.CSOSN==='101'?[...common,'pCredSN','vCredICMSSN']:[...common,'vBCSTRet','pST','vICMSSubstituto','vICMSSTRet','vBCFCPSTRet','pFCPSTRet','vFCPSTRet','pRedBCEfet','vBCEfet','pICMSEfet','vICMSEfet'];
   if(Object.keys(c).some(k=>!branch.includes(k)))extra.push('ICMS_FIELD_OUTSIDE_BRANCH');
   return{position:i+1,itemHash:hash(serialize(n)),code:p.cProd,ncm:p.NCM,cest:p.CEST??null,benefit:p.cBenef??null,cfop:p.CFOP,gtin:p.cEAN,gtinTax:p.cEANTrib,icms:c,pis:taxGroup(imposto,'PIS','PISOutr',extra),cofins:taxGroup(imposto,'COFINS','COFINSOutr',extra),unsupported:[...new Set(extra)]};
  });
  const pg=one(inf,'pag');attrs(pg);only(pg,['detPag','vTroco'],['detPag'],unsupported);const payments=nodes(pg,'detPag');need(payments.length>0&&payments.length<=25,'RULE_PAYMENT_LIMIT');
  const paymentFacts=payments.map(n=>mapLeaves(n,['indPag','tPag','vPag'],unsupported));
  const total=one(inf,'total');attrs(total);only(total,['ICMSTot'],[],unsupported);const totals=mapLeaves(one(total,'ICMSTot'),['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vFCPSTRet','vProd','vFrete','vSeg','vDesc','vII','vIPI','vIPIDevol','vPIS','vCOFINS','vOutro','vNF'],unsupported);
  const transp=one(inf,'transp');attrs(transp);only(transp,['modFrete'],[],unsupported);
  const adic=one(inf,'infAdic',true);if(adic){attrs(adic);only(adic,['infCpl'],[],unsupported);}
  const facts=freeze({model:ide.mod,environment:ide.tpAmb,crt:leaf(emit,'CRT'),issuerUf:leaf(ea,'UF'),ide,recipient,items,payments:paymentFacts,change:leaf(pg,'vTroco',true),totals,transportMode:leaf(transp,'modFrete'),additionalInformation:adic?leaf(adic,'infCpl',true):null,unsupported:[...new Set(unsupported)]});
  need(facts.model===v.request.model&&facts.environment==='2','RULE_REQUEST_MISMATCH');
  const handle=freeze({profile:MANIFEST.profile,profileHash:MANIFEST_HASH,candidateId:v.candidateId,signedHash:v.request.signedHash,factsHash:hash(canonical(facts)),model:facts.model,itemCount:items.length});
  candidates.set(handle,{facts,handle,labels:freeze({items:labels})});return handle;
 }catch(e){if(e instanceof SpCrt1RuleError)throw e;throw new SpCrt1RuleError('RULE_XML_STRUCTURE_INVALID');}finally{bytes.fill(0);}
}

/** Closed owned projection. Only a locally attested candidate can reveal its facts. */
function projectSpCrt1CandidateReview(handle){
 const c=candidate(handle);
 return freeze(JSON.parse(JSON.stringify({facts:c.facts,labels:c.labels})));
}

const money=v=>typeof v==='string'&&/^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(v),rate=v=>typeof v==='string'&&/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(v);
const cents=v=>BigInt(v.replace('.',''));
function option(v,choices){need(typeof v==='string'&&choices.includes(v),'RULE_REVIEW_INVALID');return v;}
function reviewBody(raw,c){
 const r=fields(raw,['id','version','candidate_id','signed_hash','facts_hash','profile','profile_hash','reviewed_by','reviewed_at','valid_until','review_hash','document','items']);
 need(uuid(r.id)&&uuid(r.reviewed_by)&&Number.isInteger(r.version)&&r.version>0&&r.version<=2147483647&&sha(r.review_hash),'RULE_REVIEW_INVALID');
 need(r.candidate_id===c.handle.candidateId&&r.signed_hash===c.handle.signedHash&&r.facts_hash===c.handle.factsHash&&r.profile===MANIFEST.profile&&r.profile_hash===MANIFEST_HASH,'RULE_REVIEW_BINDING_MISMATCH');
 need(stamp(r.reviewed_at)<stamp(r.valid_until),'RULE_REVIEW_INVALID');
 const {review_hash,...withoutHash}=r;need(hash(canonical(withoutHash))===review_hash,'RULE_REVIEW_HASH_MISMATCH');
 const d=fields(r.document,['operation','recipient_regime','acquisition_purpose','payment','excluded_groups']);
 option(d.operation,['internal_normal_sale','outside_scope','unreviewed']);option(d.recipient_regime,['regular_icms','simples','noncontributor','unreviewed']);option(d.acquisition_purpose,['resale','industrialization','final_consumption','unreviewed']);option(d.payment,['matches_signed_document','unreviewed']);option(d.excluded_groups,['not_applicable','applies','unreviewed']);
 need(Array.isArray(r.items)&&r.items.length===c.facts.items.length,'RULE_REVIEW_INVALID');
 for(const [i,item]of r.items.entries()){
  const x=fields(item,['position','item_hash','classification','benefit','pis_cofins','gtin','st','fcp','credit']);need(x.position===i+1&&x.item_hash===c.facts.items[i].itemHash,'RULE_REVIEW_BINDING_MISMATCH');
  option(x.classification,['reviewed_physical_goods','outside_scope','unreviewed']);option(x.benefit,['not_applicable','applies','unreviewed']);option(x.pis_cofins,['normal_unified_simples','other','unreviewed']);option(x.gtin,['reviewed_absent','reviewed_identifiers','unreviewed']);option(x.st,['documented_prior_retention','not_applicable','unreviewed']);option(x.fcp,['documented_prior_retention','not_applicable','unreviewed']);
  if(x.credit!==null){const cr=fields(x.credit,['eligibility','base','rate','amount','period','source_hash','statement']);need(cr.eligibility==='reviewed_lc123_art23'&&money(cr.base)&&rate(cr.rate)&&money(cr.amount)&&/^\d{4}-(?:0[1-9]|1[0-2])$/.test(cr.period)&&sha(cr.source_hash)&&typeof cr.statement==='string'&&cr.statement.length>0&&cr.statement.length<=1000&&!/[\u0000-\u001f]/.test(cr.statement),'RULE_REVIEW_INVALID');}
 }
 return freeze(r);
}
const typedProto=Object.getPrototypeOf(Uint8Array.prototype),bytesGet=Object.getOwnPropertyDescriptor(typedProto,'byteLength').get,bufferGet=Object.getOwnPropertyDescriptor(typedProto,'buffer').get,offsetGet=Object.getOwnPropertyDescriptor(typedProto,'byteOffset').get;
const abortedGet=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const isAborted=signal=>signal===undefined?false:abortedGet.call(signal);
function ownedReview(value){try{need(value instanceof Uint8Array&&ArrayBuffer.isView(value),'RULE_REVIEW_BYTES_INVALID');const n=bytesGet.call(value),buffer=bufferGet.call(value),offset=offsetGet.call(value);need(n>0&&n<=MAX_RULE_REVIEW_BYTES&&!(typeof SharedArrayBuffer!=='undefined'&&buffer instanceof SharedArrayBuffer),'RULE_REVIEW_BYTES_INVALID');return Uint8Array.from(new Uint8Array(buffer,offset,n));}catch{throw new SpCrt1RuleError('RULE_REVIEW_BYTES_INVALID');}}
/** The trusted backend closure must authenticate/read a versioned review, honor maxBytes,
 * and revalidate its ACL/current version before any later use. WeakMap is not RBAC. */
function createSpCrt1ReviewReader(configuration){
 const p=fields(configuration,['readReview']);need(typeof p.readReview==='function');const readReview=p.readReview;
 return async function capture(input){
  const v=fields(input,['candidate','now'],['signal','deadline']),c=candidate(v.candidate),clock=time(v.now),signal=v.signal;
  try{isAborted(signal);}catch{throw new SpCrt1RuleError('RULE_INPUT_INVALID');}const deadline=v.deadline===undefined?Date.now()+5000:v.deadline;need(Number.isFinite(deadline));
  const started=Date.now(),end=Math.min(deadline,started+5000),budget=end-started;need(budget>0,'RULE_REVIEW_TIMEOUT');need(!isAborted(signal),'RULE_REVIEW_ABORTED');
  const query=freeze({candidateId:c.handle.candidateId,signedHash:c.handle.signedHash,factsHash:c.handle.factsHash,profile:MANIFEST.profile,profileHash:MANIFEST_HASH,items:c.facts.items.map(x=>({position:x.position,itemHash:x.itemHash}))});
  const controller=new AbortController();let timer,onAbort,bytes;
  const stop=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(new SpCrt1RuleError('RULE_REVIEW_ABORTED'));};if(signal)EventTarget.prototype.addEventListener.call(signal,'abort',onAbort,{once:true});timer=setTimeout(()=>{controller.abort();reject(new SpCrt1RuleError('RULE_REVIEW_TIMEOUT'));},budget);});
  const check=()=>{need(!isAborted(signal),'RULE_REVIEW_ABORTED');need(Date.now()<end,'RULE_REVIEW_TIMEOUT');};
  try{
   check();const pending=Promise.resolve().then(()=>{check();return readReview(query,Object.freeze({signal:controller.signal,deadline:end,maxBytes:MAX_RULE_REVIEW_BYTES}));});
   const raw=await Promise.race([pending,stop]);check();if(raw===null)return null;bytes=ownedReview(raw);
   let parsed;try{parsed=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{throw new SpCrt1RuleError('RULE_REVIEW_INVALID');}
   const record=reviewBody(parsed,c);check();need(stamp(record.reviewed_at)<=clock&&stamp(record.valid_until)>clock,'RULE_REVIEW_TIME_INVALID');
   const handle=freeze({id:record.id,version:record.version,reviewHash:record.review_hash,candidateId:c.handle.candidateId,signedHash:c.handle.signedHash,profileHash:MANIFEST_HASH,reviewedAt:record.reviewed_at,validUntil:record.valid_until});reviews.set(handle,{candidate:c.handle,record});return handle;
  }catch(e){if(e instanceof SpCrt1RuleError)throw e;throw new SpCrt1RuleError('RULE_REVIEW_UNAVAILABLE');}finally{clearTimeout(timer);if(signal)EventTarget.prototype.removeEventListener.call(signal,'abort',onAbort);controller.abort();bytes?.fill(0);}
 };
}

const SOURCES={scope:['moc7'],cfop:['cfop2023','moc7'],recipient:['moc7','simplification2025'],st:['moc7','sp-nfe-optional','sp-nfce-optional'],gtin:['gtin2021'],gtinPrefix:['gtin2021','gs1prefix20261016'],benefit:['sre70','sp-cbenef'],credit:['lc123','sp-credit'],payment:['simplification2025','sp-nfce-optional'],classification:['rfb-pis-cofins','sre70'],time:['rtc2025']};
function issue(list,code,kind,source,position=null){list.push({code,kind,position,sources:SOURCES[source]});}
const present=(o,keys)=>keys.every(k=>Object.hasOwn(o,k));
const amountLabel=v=>{const [a,b]=v.split('.');return a.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+b;};
/** Synchronous and deterministic over attested immutable inputs; no side effects. */
function evaluateSpCrt1Rules(input){
 const v=fields(input,['candidate','reviewEvidence','now']),c=candidate(v.candidate),f=c.facts,clock=time(v.now);
 let review=null;if(v.reviewEvidence!==null){const r=reviews.get(v.reviewEvidence);need(r&&r.candidate===v.candidate,'RULE_REVIEW_UNATTESTED');review=r.record;}
 const invalid=[],unsupported=[],pending=[];
 const bad=(code,source,position=null)=>issue(invalid,code,'deterministic_rule',source,position);
 const outside=(code,source='scope',position=null)=>issue(unsupported,code,'fagoo_supported_scope',source,position);
 const wait=(code,source='classification',position=null)=>issue(pending,code,'classification_or_evidence_pending',source,position);
 const start=Date.parse(MANIFEST.timePolicy.validFrom),end=Date.parse(MANIFEST.timePolicy.reviewBefore);
 if(clock<start||clock>=end)issue(unsupported,'PROFILE_REVIEW_DATE_OUTSIDE_WINDOW','fagoo_temporal_policy','time');
 const emitted=Date.parse(f.ide.dhEmi);
 if(!Number.isFinite(emitted)||emitted<start||emitted>=end||emitted>clock)issue(unsupported,'EMISSION_DATE_OUTSIDE_REVIEW_WINDOW','fagoo_temporal_policy','time');
 if(review&&(stamp(review.reviewed_at)>clock||stamp(review.valid_until)<=clock)){wait('BACKEND_REVIEW_EXPIRED');review=null;}
 if(f.crt!=='1'||f.issuerUf!=='SP'||f.recipient.uf!=='SP'||f.environment!=='2'||Object.entries({cUF:'35',tpNF:'1',idDest:'1',finNFe:'1',tpEmis:'1',indPres:'1'}).some(([k,x])=>f.ide[k]!==x))outside('OPERATION_OUTSIDE_PROFILE');
 if(!['0','1'].includes(f.ide.indFinal)||f.model==='65'&&(f.ide.indFinal!=='1'||f.recipient.indIEDest!=='9'))outside('RECIPIENT_OUTSIDE_PROFILE');
 if(f.unsupported.length)outside('DOCUMENT_GROUP_OUTSIDE_PROFILE');
 if(f.recipient.indIEDest==='2'&&f.model==='55'&&!f.items.some(i=>Object.hasOwn(i.icms,'vICMSSTRet')))bad('SP_EXEMPT_IE_WITHOUT_EXCEPTION','recipient');
 if(!review){wait('BACKEND_CLASSIFICATION_REVIEW_MISSING');}
 else{
  const d=review.document;if(d.operation==='outside_scope')outside('REVIEW_OPERATION_OUTSIDE_PROFILE');else if(d.operation==='unreviewed')wait('OPERATION_CLASSIFICATION_PENDING');
  if(d.excluded_groups==='applies')outside('EXCLUDED_TAX_GROUP_APPLIES');else if(d.excluded_groups==='unreviewed')wait('EXCLUDED_TAX_GROUPS_PENDING');
  if(d.payment==='unreviewed')wait('PAYMENT_FACTS_PENDING','payment');
 }
 for(const item of f.items){
  const pos=item.position,ic=item.icms,cs=ic.CSOSN,r=review?.items[pos-1];
  if(item.unsupported.length||!['101','102','500'].includes(cs)||!['5102','5405'].includes(item.cfop))outside('ITEM_BRANCH_OUTSIDE_PROFILE','scope',pos);
  if(f.model==='65'&&cs==='101')bad('NFCE_CSOSN101_NOT_ALLOWED','cfop',pos);
  if(f.model==='65'&&(cs==='102'&&item.cfop!=='5102'||cs==='500'&&item.cfop!=='5405'))bad('NFCE_CFOP_CSOSN_MISMATCH','cfop',pos);
  if(f.model==='55'&&(['101','102'].includes(cs)&&item.cfop!=='5102'||cs==='500'&&item.cfop!=='5405'))outside('NFE_CFOP_CSOSN_OUTSIDE_INITIAL_SCOPE','cfop',pos);
  if(f.model==='55'&&cs==='101'&&f.recipient.indIEDest==='9')bad('NFE_CSOSN101_NONCONTRIBUTOR','recipient',pos);
  if(!/^\d{8}$/.test(item.ncm)||!/^\d$/.test(ic.orig??'')||Number(ic.orig)>8)bad('ITEM_CLASSIFICATION_FORMAT_INVALID','classification',pos);
  if(cs==='500'&&f.model==='55'&&item.cest===null)bad('NFE_CSOSN500_CEST_REQUIRED','st',pos);
  if(cs==='500'&&f.model==='55'&&f.ide.indFinal==='0'&&!present(ic,['vBCSTRet','pST','vICMSSTRet']))bad('NFE_NONFINAL_RETENTION_REQUIRED','st',pos);
  const retained=['vBCSTRet','pST','vICMSSubstituto','vICMSSTRet'],fcps=['vBCFCPSTRet','pFCPSTRet','vFCPSTRet'];
  // vICMSSubstituto is optional in the retained group, unlike the other three fields.
  if(retained.some(k=>Object.hasOwn(ic,k))&&!present(ic,['vBCSTRet','pST','vICMSSTRet']))bad('RETENTION_GROUP_INCOMPLETE','st',pos);
  if(fcps.some(k=>Object.hasOwn(ic,k))&&!present(ic,fcps))bad('FCP_RETENTION_GROUP_INCOMPLETE','st',pos);
  if(Object.hasOwn(ic,'pFCPSTRet')&&(!/^(?:0|[1-9]\d{0,2})\.\d{2,4}$/.test(ic.pFCPSTRet)||/^0\.0+$/.test(ic.pFCPSTRet)))bad('FCP_RETENTION_RATE_ZERO_OR_INVALID','st',pos);
  for(const gtin of [item.gtin,item.gtinTax])if(gtin!=='SEM GTIN'&&!gtinCheckDigitMatches(gtin))bad('GTIN_CHECK_DIGIT_INVALID','gtin',pos);
  if((item.gtin==='SEM GTIN')!==(item.gtinTax==='SEM GTIN'))bad('GTIN_PAIR_MISMATCH','gtin',pos);
  if(prefixInspector){
   for(const [value,code]of [[item.gtin,'GTIN_CEAN_PREFIX_NOT_LISTED'],[item.gtinTax,'GTIN_CEANTRIB_PREFIX_NOT_LISTED']])if(value!=='SEM GTIN'&&/^(?:[0-9]{8}|[0-9]{12,14})$/.test(value)&&!prefixInspector(value).prefixListed)bad(code,'gtinPrefix',pos);
  }else if(item.gtin!=='SEM GTIN'||item.gtinTax!=='SEM GTIN')wait('GS1_PREFIX_TABLE_NOT_PINNED','gtin',pos);
  if(item.benefit!==null)outside(item.benefit==='SEM CBENEF'?'SEM_CBENEF_NOT_SUPPORTED':'BENEFIT_FIELD_OUTSIDE_PROFILE','benefit',pos);
  if(!item.pis||!item.cofins||item.pis.CST!=='49'||item.cofins.CST!=='49')outside('PIS_COFINS_BRANCH_OUTSIDE_PROFILE','classification',pos);
  if(!r)continue;
  if(r.classification==='outside_scope')outside('PRODUCT_CLASSIFICATION_OUTSIDE_PROFILE','classification',pos);else if(r.classification==='unreviewed')wait('PRODUCT_CLASSIFICATION_PENDING','classification',pos);
  if(r.benefit==='applies')outside('BENEFIT_REQUIRES_UNSUPPORTED_FIELD','benefit',pos);else if(r.benefit==='unreviewed')wait('BENEFIT_APPLICABILITY_PENDING','benefit',pos);
  if(r.pis_cofins==='other')outside('PIS_COFINS_REGIME_OUTSIDE_PROFILE','classification',pos);else if(r.pis_cofins==='unreviewed')wait('PIS_COFINS_CLASSIFICATION_PENDING','classification',pos);
  if(r.gtin==='unreviewed'||(r.gtin==='reviewed_absent')!==(item.gtin==='SEM GTIN'&&item.gtinTax==='SEM GTIN'))wait('GTIN_CLASSIFICATION_PENDING','gtin',pos);
  if(cs==='500'&&r.st!=='documented_prior_retention')wait('ST_RETENTION_BASIS_PENDING','st',pos);
  if(cs!=='500'&&r.st!=='not_applicable')wait('ST_CLASSIFICATION_ON_NONST_ITEM','st',pos);
  if(fcps.some(k=>Object.hasOwn(ic,k))&&r.fcp!=='documented_prior_retention'||!fcps.some(k=>Object.hasOwn(ic,k))&&r.fcp!=='not_applicable')wait('FCP_APPLICABILITY_PENDING','st',pos);
  if(cs==='101'){
   const cr=r.credit,d=review.document;
   if(!cr||d.recipient_regime!=='regular_icms'||!['resale','industrialization'].includes(d.acquisition_purpose)||f.ide.indFinal!=='0'||f.recipient.indIEDest!=='1')wait('SN_CREDIT_ELIGIBILITY_PENDING','credit',pos);
   if(cr){
    if(cr.rate!==ic.pCredSN||cr.amount!==ic.vCredICMSSN||(cents(cr.base)*cents(cr.rate)+5000n)/10000n!==cents(cr.amount))bad('SN_CREDIT_REVIEW_VALUES_MISMATCH','credit',pos);
    const ym=f.ide.dhEmi?.slice(0,7),month=ym&&new Date(ym+'-01T00:00:00Z');if(!month||!Number.isFinite(month.getTime()))outside('EMISSION_DATE_OUTSIDE_PROFILE');else{month.setUTCMonth(month.getUTCMonth()-1);if(cr.period!==month.toISOString().slice(0,7))outside('SN_CREDIT_PERIOD_OUTSIDE_INITIAL_SCOPE','credit',pos);}
    const statement='PERMITE O APROVEITAMENTO DO CRÉDITO DE ICMS NO VALOR DE R$ '+amountLabel(cr.amount)+'; CORRESPONDENTE À ALÍQUOTA DE '+amountLabel(cr.rate)+'%, NOS TERMOS DO ART. 23 DA LEI COMPLEMENTAR Nº 123, DE 2006';
    if(cr.statement!==statement||!f.additionalInformation?.includes(statement))wait('SN_CREDIT_DISCLOSURE_PENDING','credit',pos);
   }
  }else if(r.credit!==null)outside('CREDIT_REVIEW_ON_NONCREDIT_ITEM','credit',pos);
 }
 if(f.payments.some(p=>!['01','15'].includes(p.tPag)))outside('PAYMENT_METHOD_OUTSIDE_PROFILE','payment');
 if(f.payments.some(p=>!money(p.vPag)||!['0','1'].includes(p.indPag))||!money(f.totals.vNF)||f.change!==null&&!money(f.change))bad('PAYMENT_VALUES_INVALID','payment');
 else{const paid=f.payments.reduce((s,p)=>s+cents(p.vPag),0n),change=f.change===null?0n:cents(f.change);if(paid< cents(f.totals.vNF)&&f.model==='65')bad('NFCE_PAYMENT_TOTAL_TOO_LOW','payment');else if(paid!==cents(f.totals.vNF)+change)outside('PAYMENT_RECONCILIATION_OUTSIDE_INITIAL_SCOPE','payment');if(change>f.payments.filter(p=>p.tPag==='01').reduce((s,p)=>s+cents(p.vPag),0n))outside('CHANGE_EXCEEDS_CASH_SCOPE','payment');}
 const result=freeze({profile:MANIFEST.profile,profileHash:MANIFEST_HASH,candidateId:c.handle.candidateId,signedHash:c.handle.signedHash,factsHash:c.handle.factsHash,evaluatedAt:new Date(clock).toISOString(),review:review?{id:review.id,version:review.version,hash:review.review_hash}:null,
  status:invalid.length?'invalid_combinations':unsupported.length?'unsupported_scope':pending.length?'pending_classification':'reviewed_subset',invalidCombinations:invalid,unsupportedScope:unsupported,pendingClassification:pending,
  temporalPolicy:MANIFEST.timePolicy,coverage:'listed_rules_only_not_full_tax_validation',...RULE_PROFILE_FLAGS});reports.add(result);return result;
}
function assertSpCrt1RuleReport(value,candidateHandle){const c=candidate(candidateHandle);need(reports.has(value)&&value.candidateId===c.handle.candidateId&&value.signedHash===c.handle.signedHash&&value.factsHash===c.handle.factsHash,'RULE_REPORT_UNATTESTED');return value;}

 return Object.freeze({inspectSpCrt1Candidate,projectSpCrt1CandidateReview,createSpCrt1ReviewReader,evaluateSpCrt1Rules,assertSpCrt1RuleReport});
}
