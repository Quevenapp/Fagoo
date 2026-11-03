import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { inspectArchivedXml } from '../../fiscal-xml/src/archive.mjs';

const NS='http://www.portalfiscal.inf.br/nfe', DS='http://www.w3.org/2000/09/xmldsig#';
export const PRINT_LIMITS=Object.freeze({bytes:512000,nodes:25000,depth:64,items:250,pages:100});
export class FiscalPrintError extends Error { constructor(code){super(code);this.name='FiscalPrintError';this.code=code;} }
export const need=(ok,code='PRINT_INPUT_INVALID')=>{if(!ok)throw new FiscalPrintError(code);};
const branded=new WeakSet();
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateBytes=value=>value instanceof Uint8Array&&!(typeof SharedArrayBuffer==='function'&&value.buffer instanceof SharedArrayBuffer);
const elements=node=>Array.from(node?.childNodes||[]).filter(n=>n.nodeType===1);
function fields(node,allowed,repeated=[]){need(node,'PRINT_GROUP_UNSUPPORTED');const children=elements(node),names=children.map(n=>n.localName);need(children.every((n,i)=>n.namespaceURI===NS&&allowed.includes(n.localName)&&(repeated.includes(n.localName)||names.indexOf(n.localName)===i)),'PRINT_GROUP_UNSUPPORTED');}
function one(node,name,optional=false){const list=elements(node).filter(n=>n.namespaceURI===NS&&n.localName===name);need(list.length<2&&(optional||list.length===1),'PRINT_STRUCTURE_INVALID');return list[0]||null;}
function text(node,name,{optional=false,max=6000,pattern}={}){const v=one(node,name,optional);if(!v)return null;need(elements(v).length===0,'PRINT_STRUCTURE_INVALID');const s=v.textContent;need(s.length>0&&Array.from(s).length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s),'PRINT_TEXT_INVALID');if(pattern)need(pattern.test(s),'PRINT_VALUE_INVALID');return s;}
const money=(n,k,optional=false)=>text(n,k,{optional,pattern:/^(?:0|[1-9]\d{0,12})\.\d{2}$/});
const decimal=(n,k,places,optional=false)=>text(n,k,{optional,pattern:new RegExp('^(?:0|[1-9]\\d{0,10})(?:\\.\\d{1,'+places+'})?$')});
const short=(n,k,optional=false,max=120)=>text(n,k,{optional,max});
function properties(value,keys){need(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)));const ds=Object.getOwnPropertyDescriptors(value);need(Reflect.ownKeys(ds).length===keys.length&&keys.every(k=>Object.hasOwn(ds,k)&&Object.hasOwn(ds[k],'value')));return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function parse(bytes){
 need(privateBytes(bytes)&&bytes.byteLength>0&&bytes.byteLength<=PRINT_LIMITS.bytes,'PRINT_SIZE_LIMIT');
 // Capture before parsing. No caller-owned bytes or XML nodes escape the extractor.
 const captured=new Uint8Array(bytes);let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(captured);}catch{throw new FiscalPrintError('PRINT_ENCODING_INVALID');}
 need(!/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)&&!xml.includes('<![CDATA[')&&!xml.includes('<!--'),'PRINT_XML_FORBIDDEN');
 const body=xml.replace(/^<\?xml version="1\.0"(?: encoding="UTF-8")?\?>/,'');need(!body.includes('<?')&&(body.match(/</g)||[]).length<PRINT_LIMITS.nodes*2,'PRINT_XML_FORBIDDEN');
 let doc;try{doc=new DOMParser({onError:()=>{throw new Error();}}).parseFromString(xml,'application/xml');}catch{throw new FiscalPrintError('PRINT_XML_INVALID');}
 need(!doc.doctype&&elements(doc).length===1,'PRINT_STRUCTURE_INVALID');
 let count=0;const stack=[[doc,0]];while(stack.length){const[n,d]=stack.pop();need(++count<=PRINT_LIMITS.nodes&&d<=PRINT_LIMITS.depth,'PRINT_COMPLEXITY_LIMIT');if(n.nodeType===1)need(n.attributes.length<=40,'PRINT_COMPLEXITY_LIMIT');for(const c of Array.from(n.childNodes||[]))stack.push([c,d+1]);}
 return {doc,captured};
}
function date(value){
 need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(value),'PRINT_DATE_INVALID');
 const[y,m,d,h,i,s]=value.match(/\d+/g).slice(0,6).map(Number),dt=new Date(Date.UTC(y,m-1,d));
 need(y>=1900&&y<=2099&&dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d&&h<24&&i<60&&s<60,'PRINT_DATE_INVALID');
 if(!value.endsWith('Z')){const off=value.slice(-5).split(':').map(Number);need(off[0]<=14&&off[1]<60&&(off[0]<14||off[1]===0),'PRINT_DATE_INVALID');}
 need(Number.isFinite(Date.parse(value)),'PRINT_DATE_INVALID');return value;
}
function address(node){fields(node,['xLgr','nro','xCpl','xBairro','cMun','xMun','UF','CEP','cPais','xPais','fone']);return {street:short(node,'xLgr'),number:short(node,'nro',false,60),complement:short(node,'xCpl',true),district:short(node,'xBairro'),city:short(node,'xMun'),state:text(node,'UF',{pattern:/^[A-Z]{2}$/}),postal_code:text(node,'CEP',{pattern:/^\d{8}$/}),phone:short(node,'fone',true,14)};}
function party(node,issuer){fields(node,issuer?['CNPJ','xNome','xFant','enderEmit','IE','IEST','CRT']:['CNPJ','CPF','xNome','enderDest','indIEDest','IE']);const cnpj=text(node,'CNPJ',{optional:!issuer,pattern:/^\d{14}$/}),cpf=issuer?null:text(node,'CPF',{optional:true,pattern:/^\d{11}$/});need((cnpj!==null)!==(cpf!==null),'PRINT_IDENTITY_INVALID');return {document:cnpj||cpf,name:short(node,'xNome'),trade_name:issuer?short(node,'xFant',true):null,address:address(one(node,issuer?'enderEmit':'enderDest')),ie:short(node,'IE',!issuer,14),ie_st:issuer?short(node,'IEST',true,14):null,crt:issuer?text(node,'CRT',{pattern:/^1$/}):null};}
const TOTALS=['vBC','vICMS','vICMSDeson','vFCP','vBCST','vST','vFCPST','vFCPSTRet','vProd','vFrete','vSeg','vDesc','vII','vIPI','vIPIDevol','vPIS','vCOFINS','vOutro','vNF'];
function item(node,index,model){
 need(node.getAttribute('nItem')===String(index+1),'PRINT_ITEM_SEQUENCE_INVALID');fields(node,['prod','imposto','infAdProd']);const p=one(node,'prod');
 fields(p,['cProd','cEAN','xProd','NCM','CEST','CFOP','uCom','qCom','vUnCom','vProd','cEANTrib','uTrib','qTrib','vUnTrib','vFrete','vSeg','vDesc','vOutro','indTot']);
 need(text(p,'indTot',{pattern:/^1$/})==='1','PRINT_GROUP_UNSUPPORTED');
 const tax=one(node,'imposto');fields(tax,['ICMS','PIS','COFINS','vTotTrib']);const icms=one(tax,'ICMS'),groups=elements(icms);need(groups.length===1,'PRINT_STRUCTURE_INVALID');const g=groups[0];
 need(g.namespaceURI===NS&&['ICMSSN101','ICMSSN102','ICMSSN500'].includes(g.localName),'PRINT_TAX_GROUP_UNSUPPORTED');
 const csosn=text(g,'CSOSN',{pattern:/^(101|102|500)$/});need(g.localName==='ICMSSN'+csosn&&(model!=='65'||csosn!=='101'),'PRINT_TAX_GROUP_UNSUPPORTED');
 const allowed=csosn==='101'?['pCredSN','vCredICMSSN']:csosn==='500'?['vBCSTRet','pST','vICMSSubstituto','vICMSSTRet','vBCFCPSTRet','pFCPSTRet','vFCPSTRet','pRedBCEfet','vBCEfet','pICMSEfet','vICMSEfet']:[];
 fields(g,['orig','CSOSN',...allowed]);const details=Object.fromEntries(allowed.map(k=>[k,k.startsWith('p')?decimal(g,k,4,true):money(g,k,true)]).filter(([,v])=>v!==null));
 const contributions={};for(const name of['PIS','COFINS']){const n=one(tax,name);fields(n,[name+'Outr']);const v=one(n,name+'Outr');fields(v,['CST','vBC','p'+name,'v'+name]);contributions[name]={cst:text(v,'CST',{pattern:/^49$/}),base:money(v,'vBC'),rate:decimal(v,'p'+name,4),amount:money(v,'v'+name)};}
 return {position:index+1,code:short(p,'cProd',false,60),description:short(p,'xProd',false,120),ncm:text(p,'NCM',{pattern:/^\d{8}$/}),cest:text(p,'CEST',{optional:true,pattern:/^\d{7}$/}),cfop:text(p,'CFOP',{pattern:/^\d{4}$/}),gtin:short(p,'cEAN',false,14),unit:short(p,'uCom',false,6),quantity:decimal(p,'qCom',4),unit_price:decimal(p,'vUnCom',10),product_amount:money(p,'vProd'),tributary:{gtin:short(p,'cEANTrib',false,14),unit:short(p,'uTrib',false,6),quantity:decimal(p,'qTrib',4),unit_price:decimal(p,'vUnTrib',10)},freight:money(p,'vFrete',true),insurance:money(p,'vSeg',true),discount:money(p,'vDesc',true),other:money(p,'vOutro',true),additional:short(node,'infAdProd',true,500),origin:text(g,'orig',{pattern:/^[0-8]$/}),csosn,tax_details:details,contributions,total_tax:money(tax,'vTotTrib',true)};
}

/** Pure local preview, not a verifier of custody, XSD, a signature or fiscal authorization. */
export function extractCandidatePreview(bytes,context){
 const c=properties(context,['candidate_id','sha256','size_bytes','model','environment']);
 need(typeof c.candidate_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.candidate_id)&&typeof c.sha256==='string'&&/^[0-9a-f]{64}$/.test(c.sha256)&&Number.isSafeInteger(c.size_bytes)&&['55','65'].includes(c.model)&&c.environment==='2');
 const {doc,captured}=parse(bytes);need(captured.length===c.size_bytes&&hash(captured)===c.sha256,'PRINT_ARTIFACT_MISMATCH');
 const root=doc.documentElement;need(root.localName==='NFe'&&root.namespaceURI===NS,'PRINT_CANDIDATE_ROOT_REQUIRED');
 const inf=one(root,'infNFe'),key=inf.getAttribute('Id').slice(3);need(inf.getAttribute('versao')==='4.00','PRINT_VERSION_UNSUPPORTED');
 let archive;try{archive=inspectArchivedXml(captured,{key,entity:c.model==='55'?'nfe':'nfce'});}catch{throw new FiscalPrintError('PRINT_IDENTITY_INVALID');}
 need(archive.environment===c.environment&&archive.model===c.model&&!archive.protocol_present,'PRINT_CONTEXT_MISMATCH');
 const sigs=elements(root).filter(n=>n.namespaceURI===DS&&n.localName==='Signature');need(sigs.length===1,'PRINT_SIGNATURE_ABSENT');
 need(elements(root).every(n=>(n.namespaceURI===NS&&['infNFe','infNFeSupl'].includes(n.localName))||n===sigs[0]),'PRINT_GROUP_UNSUPPORTED');
 fields(inf,['ide','emit','dest','det','total','transp','pag','infAdic'],['det']);const ide=one(inf,'ide');
 fields(ide,['cUF','cNF','natOp','mod','serie','nNF','dhEmi','dhSaiEnt','tpNF','idDest','cMunFG','tpImp','tpEmis','cDV','tpAmb','finNFe','indFinal','indPres','procEmi','verProc']);
 need(text(ide,'cUF',{pattern:/^35$/})==='35'&&text(ide,'tpEmis',{pattern:/^1$/})==='1'&&text(ide,'tpImp',{pattern:c.model==='55'?/^1$/:/^4$/})&&(text(ide,'finNFe',{pattern:/^1$/})==='1'),'PRINT_PROFILE_UNSUPPORTED');
 const issuer=party(one(inf,'emit'),true),recipient=party(one(inf,'dest'),false),det=elements(inf).filter(n=>n.localName==='det');need(det.length>0&&det.length<=PRINT_LIMITS.items,'PRINT_ITEMS_LIMIT');
 const total=one(inf,'total');fields(total,['ICMSTot']);const t=one(total,'ICMSTot');fields(t,TOTALS);const totals=Object.fromEntries(TOTALS.map(k=>[k,money(t,k)]));
 const transport=one(inf,'transp');fields(transport,['modFrete']);const transport_mode=text(transport,'modFrete',{pattern:/^[0-49]$/});
 const pag=one(inf,'pag');fields(pag,['detPag','vTroco'],['detPag']);const payments=elements(pag).filter(n=>n.localName==='detPag').map(n=>{fields(n,['indPag','tPag','vPag']);return {type:text(n,'tPag',{pattern:/^(01|15)$/}),timing:text(n,'indPag',{pattern:/^[01]$/}),amount:money(n,'vPag')};});need(payments.length>0&&payments.length<=25,'PRINT_PAYMENT_LIMIT');
 const extra=one(inf,'infAdic',true);if(extra)fields(extra,['infAdFisco','infCpl']);let qr=null,consultation=null;
 const supl=one(root,'infNFeSupl',true);if(c.model==='65'){fields(supl,['qrCode','urlChave']);qr=text(supl,'qrCode',{max:200});consultation=text(supl,'urlChave',{max:200});need(qr===`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${key}|3|2`&&consultation==='https://www.homologacao.nfce.fazenda.sp.gov.br/consulta','PRINT_QR_PROFILE_UNSUPPORTED');}else need(supl===null,'PRINT_QR_PROFILE_UNSUPPORTED');
 const data=freeze({profile:c.model==='55'?'candidate-danfe55-moc7-v1':'candidate-danfe65-manual6-v1',mode:'candidate_preview',source:c,key,model:c.model,environment:'2',number:short(ide,'nNF',false,9),series:short(ide,'serie',false,3),issued_at:date(short(ide,'dhEmi',false,25)),departure_at:one(ide,'dhSaiEnt',true)?date(short(ide,'dhSaiEnt',false,25)):null,nature:short(ide,'natOp',false,60),operation:text(ide,'tpNF',{pattern:/^[01]$/}),issuer,recipient,items:det.map((n,i)=>item(n,i,c.model)),totals,transport_mode,payments,change:money(pag,'vTroco',true),additional:extra?short(extra,'infCpl',true,5000):null,fiscal_information:extra?short(extra,'infAdFisco',true,2000):null,qr,consultation,declared_protocol:null,authorized:false,authorization_verified:false,signature_verified:false,xsd_validated:false,can_emit:false,can_transmit:false});
 branded.add(data);return data;
}
export function assertPreview(data){need(branded.has(data),'PRINT_UNTRUSTED_PROJECTION');return data;}

/** Structural history metadata only. It is deliberately not accepted by the renderer. */
export function inspectDeclaredProtocol(bytes,{key,entity}){
 need(privateBytes(bytes)&&bytes.length>0&&bytes.length<=8*1024*1024,'PRINT_SIZE_LIMIT');const captured=new Uint8Array(bytes);
 let metadata;try{metadata=inspectArchivedXml(captured,{key,entity});}catch{throw new FiscalPrintError('PRINT_HISTORY_INVALID');}
 return freeze({source_sha256:hash(captured),...metadata,protocol_evidence:'declared_only',authorization_verified:false,render_authorized:false});
}
