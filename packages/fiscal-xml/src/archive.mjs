// Archive inspection is independent from the homologation-only emission profile.
// It establishes structure and identity binding, never fiscal authorization.
import { DOMParser } from '@xmldom/xmldom';
import { accessKeyCheckDigit } from '../../fiscal-core/src/identity.mjs';

const NS='http://www.portalfiscal.inf.br/nfe',DS='http://www.w3.org/2000/09/xmldsig#';
export const XML_ARCHIVE_LIMITS=Object.freeze({json:8*1024*1024,compressed:2*1024*1024,compressedTotal:4*1024*1024,xml:8*1024*1024,total:16*1024*1024,files:10,ratio:200,nodes:50000,depth:64,attributes:40});
const fail=code=>{throw new Error(code);};
export function archiveKey(key,entity){
 if(typeof key!=='string'||!/^\d{44}$/.test(key)||accessKeyCheckDigit(key.slice(0,43))!==key[43]
   ||!['55','65'].includes(key.slice(20,22))||(entity&&key.slice(20,22)!==(entity==='nfce'?'65':entity==='nfe'?'55':'')))fail('XML_KEY_INVALID');
 return key;
}
const children=node=>Array.from(node.childNodes||[]).filter(n=>n.nodeType===1);
const named=(node,name)=>children(node).filter(n=>n.namespaceURI===NS&&n.localName===name);
function one(node,name,optional=false){const nodes=named(node,name);if(nodes.length>(1)||(!optional&&nodes.length!==1))fail('XML_STRUCTURE_AMBIGUOUS');return nodes[0]||null;}
function leaf(node,name,optional=false){const found=one(node,name,optional);if(!found)return null;if(children(found).length)fail('XML_STRUCTURE_AMBIGUOUS');return found.textContent;}
const value=(text,pattern,code)=>{if(typeof text!=='string'||!pattern.test(text))fail(code);return text;};
export function inspectArchivedXml(bytes,{key,entity}){
 archiveKey(key,entity);if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>XML_ARCHIVE_LIMITS.xml)fail('XML_SIZE_LIMIT');
 let xml;try{xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('XML_ENCODING_INVALID');}
 // DTDs and entity declarations are rejected before parsing. CDATA is required by
 // historical NFC-e QR codes; unlike the emitter, the archive accepts it.
 if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(xml))fail('XML_DECLARATION_FORBIDDEN');
 const declaration=xml.match(/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>/i);
 const body=declaration?xml.slice(declaration[0].length):xml;
 if(body.includes('<?')||(body.match(/</g)||[]).length>XML_ARCHIVE_LIMITS.nodes*2)fail('XML_COMPLEXITY_LIMIT');
 let doc;try{doc=new DOMParser({onError:()=>fail('XML_MALFORMED')}).parseFromString(xml,'application/xml');}catch{fail('XML_MALFORMED');}
 if(doc.doctype||!doc.documentElement||children(doc).length!==1)fail('XML_STRUCTURE_AMBIGUOUS');
 let count=0;const stack=[[doc,0]];
 while(stack.length){const[node,depth]=stack.pop();if(++count>XML_ARCHIVE_LIMITS.nodes||depth>XML_ARCHIVE_LIMITS.depth)fail('XML_COMPLEXITY_LIMIT');
  if(![1,3,4,7,8,9].includes(node.nodeType))fail('XML_NODE_FORBIDDEN');
  if(node.nodeType===7&&(node.target!=='xml'||node.parentNode!==doc||node!==doc.firstChild))fail('XML_DECLARATION_FORBIDDEN');
  if(node.nodeType===1&&node.attributes.length>XML_ARCHIVE_LIMITS.attributes)fail('XML_COMPLEXITY_LIMIT');
  for(const child of Array.from(node.childNodes||[]))stack.push([child,depth+1]);
 }
 const root=doc.documentElement;if(root.namespaceURI!==NS)fail('XML_NAMESPACE_INVALID');
 const model=key.slice(20,22),issues=[];let environment,protocol=null,eventType=null,eventSequence=null,signature=false;
 const all=Array.from(doc.getElementsByTagName('*'));
 if(['nfeProc','NFe'].includes(root.localName)){
  const invoice=root.localName==='NFe'?root:one(root,'NFe'),inf=one(invoice,'infNFe');
  if(all.filter(n=>n.localName==='NFe').length!==1||all.filter(n=>n.localName==='infNFe').length!==1||inf.getAttribute('Id')!==`NFe${key}`)fail('XML_KEY_MISMATCH');
  const ide=one(inf,'ide'),emit=one(inf,'emit');environment=value(leaf(ide,'tpAmb'),/^[12]$/,'XML_ENVIRONMENT_INVALID');
  if(leaf(ide,'mod')!==model||leaf(ide,'cUF')!==key.slice(0,2)||leaf(emit,'CNPJ')!==key.slice(6,20)
    ||value(leaf(ide,'serie'),/^\d{1,3}$/,'XML_IDENTITY_INVALID').padStart(3,'0')!==key.slice(22,25)
    ||value(leaf(ide,'nNF'),/^\d{1,9}$/,'XML_IDENTITY_INVALID').padStart(9,'0')!==key.slice(25,34)
    ||leaf(ide,'tpEmis')!==key.slice(34,35)||leaf(ide,'cNF')!==key.slice(35,43)||leaf(ide,'cDV')!==key[43])fail('XML_KEY_MISMATCH');
  const issued=leaf(ide,'dhEmi',true)||leaf(ide,'dEmi',true);if(!issued||!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(issued)||issued.slice(2,4)+issued.slice(5,7)!==key.slice(2,6))fail('XML_KEY_MISMATCH');
  const protocols=all.filter(n=>n.localName==='protNFe');if(protocols.length>1)fail('XML_STRUCTURE_AMBIGUOUS');
  if(protocols.length){const p=protocols[0];if(p.namespaceURI!==NS||p.parentNode!==root||root.localName!=='nfeProc')fail('XML_STRUCTURE_AMBIGUOUS');const info=one(p,'infProt');
   if(leaf(info,'chNFe')!==key||leaf(info,'tpAmb')!==environment)fail('XML_PROTOCOL_MISMATCH');protocol=value(leaf(info,'nProt'),/^\d{1,20}$/,'XML_PROTOCOL_INVALID');}
  else issues.push('PROTOCOL_ABSENT');
  signature=children(invoice).some(n=>n.localName==='Signature'&&n.namespaceURI===DS);if(!signature)issues.push('SIGNATURE_ABSENT');
 }else if(['procEventoNFe','evento'].includes(root.localName)){
  const event=root.localName==='evento'?root:one(root,'evento'),inf=one(event,'infEvento');
  if(all.filter(n=>n.localName==='evento').length!==1||leaf(inf,'chNFe')!==key)fail('XML_KEY_MISMATCH');
  environment=value(leaf(inf,'tpAmb'),/^[12]$/,'XML_ENVIRONMENT_INVALID');eventType=value(leaf(inf,'tpEvento'),/^\d{6}$/,'XML_EVENT_INVALID');eventSequence=value(leaf(inf,'nSeqEvento'),/^\d{1,3}$/,'XML_EVENT_INVALID');
  if(inf.getAttribute('Id')!==`ID${eventType}${key}${eventSequence.padStart(2,'0')}`)fail('XML_EVENT_INVALID');
  const returned=root.localName==='procEventoNFe'?one(root,'retEvento',true):null;
  if(returned){const r=one(returned,'infEvento');if(leaf(r,'chNFe')!==key||leaf(r,'tpAmb')!==environment||leaf(r,'tpEvento')!==eventType||leaf(r,'nSeqEvento')!==eventSequence)fail('XML_PROTOCOL_MISMATCH');protocol=leaf(r,'nProt',true);if(protocol!==null)value(protocol,/^\d{1,20}$/,'XML_PROTOCOL_INVALID');}
  if(!protocol)issues.push('PROTOCOL_ABSENT');signature=children(event).some(n=>n.localName==='Signature'&&n.namespaceURI===DS);if(!signature)issues.push('SIGNATURE_ABSENT');
 }else fail('XML_ROOT_UNSUPPORTED');
 return{key,model,environment,kind:eventType?'event':'invoice',protocol,protocol_present:protocol!==null,signature_present:signature,event_type:eventType,event_sequence:eventSequence,issues};
}
export async function decodeArchivedDocuments(data,{key,entity,signal,deadline=Date.now()+15000,now=Date.now}){
 archiveKey(key,entity);if(!Array.isArray(data)||data.length<1||data.length>XML_ARCHIVE_LIMITS.files)fail('XML_DOCUMENT_COUNT_LIMIT');
 const documents=[];let compressedTotal=0,total=0;
 const check=()=>{if(signal?.aborted)fail('XML_ABORTED');if(now()>=deadline)fail('XML_TIME_LIMIT');};
 for(const item of data){check();const encoded=item?.conteudo;
  if(typeof item?.nome!=='string'||item.nome.length>512||typeof encoded!=='string'||encoded.length<4||encoded.length%4!==0||encoded.length>Math.ceil(XML_ARCHIVE_LIMITS.compressed/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))fail('XML_BASE64_INVALID');
  let binary;try{binary=atob(encoded);}catch{fail('XML_BASE64_INVALID');}if(btoa(binary)!==encoded)fail('XML_BASE64_INVALID');
  const compressed=Uint8Array.from(binary,c=>c.charCodeAt(0));compressedTotal+=compressed.length;
  if(compressed.length>XML_ARCHIVE_LIMITS.compressed||compressedTotal>XML_ARCHIVE_LIMITS.compressedTotal||compressed[0]!==31||compressed[1]!==139)fail('XML_COMPRESSED_LIMIT');
  const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();let size=0;const chunks=[];
  const timeout=setTimeout(()=>{void reader.cancel().catch(()=>{});},Math.max(1,deadline-now()));
  const onAbort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
  try{for(;;){check();const{done,value}=await reader.read();check();if(done)break;size+=value.byteLength;
    if(size>XML_ARCHIVE_LIMITS.xml||size>compressed.length*XML_ARCHIVE_LIMITS.ratio||total+size>XML_ARCHIVE_LIMITS.total)fail('XML_INFLATED_LIMIT');chunks.push(value);}}
  catch(error){if(/^XML_[A-Z_]+$/.test(error?.message||''))throw error;fail('XML_GZIP_INVALID');}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort);try{await reader.cancel();}catch{}reader.releaseLock();}
  if(size===0)fail('XML_EMPTY');total+=size;const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const metadata=inspectArchivedXml(bytes,{key,entity});check();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(!documents.some(d=>d.hash===hash))documents.push({hash,size,bytes,...metadata});
 }
 return documents.sort((a,b)=>a.hash.localeCompare(b.hash));
}
