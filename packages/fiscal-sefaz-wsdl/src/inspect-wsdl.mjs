import {createRequire} from 'node:module';
import {need,fields,hash,requirePlan,WSDL_FLAGS,WSDL_LIMITS,WsdlEvidenceError} from './profile.mjs';
const require=createRequire(new URL('../../fiscal-xml/package.json',import.meta.url));
const {DOMParser}=require('@xmldom/xmldom');
const W='http://schemas.xmlsoap.org/wsdl/',S='http://schemas.xmlsoap.org/wsdl/soap/',S12='http://schemas.xmlsoap.org/wsdl/soap12/',X='http://www.w3.org/2001/XMLSchema';
export const WSDL_UNSUPPORTED_CODES=Object.freeze(['WSDL_ROOT_UNSUPPORTED','WSDL_EXTERNAL_DEPENDENCY_UNSUPPORTED','WSDL_STRUCTURE_AMBIGUOUS','WSDL_NAME_INVALID','WSDL_URI_INVALID','WSDL_QNAME_INVALID','WSDL_QNAME_NAMESPACE_INVALID','WSDL_DUPLICATE_NAME','WSDL_EXTENSION_UNSUPPORTED','WSDL_STRUCTURE_INVALID','WSDL_REFERENCE_MISSING','WSDL_BINDING_UNSUPPORTED','WSDL_HEADER_OR_EXTENSION_UNSUPPORTED','WSDL_ENDPOINT_MISMATCH','WSDL_UNBOUND_BINDING']);
const kids=n=>Array.from(n.childNodes??[]).filter(n=>n.nodeType===1);
const named=(n,local,ns=W)=>kids(n).filter(n=>n.localName===local&&n.namespaceURI===ns);
const one=(n,local,ns=W)=>{const list=named(n,local,ns);need(list.length===1,'WSDL_STRUCTURE_AMBIGUOUS');return list[0];};
const name=n=>{const v=n.getAttribute('name');need(typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(v),'WSDL_NAME_INVALID');return v;};
function uri(v){need(typeof v==='string'&&v.length<=2048&&/^[\x21-\x7e]+$/.test(v),'WSDL_URI_INVALID');let u;try{u=new URL(v);}catch{throw new WsdlEvidenceError('WSDL_URI_INVALID');}need(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash,'WSDL_URI_INVALID');return v;}
function qname(node,attribute,namespace){const value=node.getAttribute(attribute);need(typeof value==='string'&&/^(?:[A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)&&value.length<=320,'WSDL_QNAME_INVALID');const parts=value.split(':');need(node.lookupNamespaceURI(parts.length===2?parts[0]:null)===namespace,'WSDL_QNAME_NAMESPACE_INVALID');return parts.at(-1);}
function mapNamed(nodes){const out=new Map();for(const n of nodes){const key=name(n);need(!out.has(key),'WSDL_DUPLICATE_NAME');out.set(key,n);}return out;}
function parse(bytes,deadline){
 need(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=WSDL_LIMITS.body_bytes,'WSDL_SIZE_INVALID');let xml;
 try{xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new WsdlEvidenceError('WSDL_ENCODING_INVALID');}
 need(!xml.includes('\ufeff')&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml),'WSDL_ENCODING_INVALID');
 // Comments are inert. Every other declaration (including DTD and CDATA) is rejected before DOM parsing.
 const decl=/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?\s*\?>/.exec(xml),body=decl?xml.slice(decl[0].length):xml;
 // Bound nesting before the synchronous DOM parser. Quotes are scanned so '>' inside an attribute cannot hide depth.
 let depth=0,count=0;
 for(let i=0;i<body.length;i++)if(body[i]==='<'){
  need(++count<=WSDL_LIMITS.nodes&&Date.now()<deadline,'WSDL_PARSE_LIMIT');
  if(body.startsWith('<!--',i)){const end=body.indexOf('-->',i+4);need(end!==-1,'WSDL_MALFORMED');i=end+2;continue;}
  need(body[i+1]!=='!','WSDL_DECLARATION_UNSUPPORTED');need(body[i+1]!=='?','WSDL_PROCESSING_INSTRUCTION_UNSUPPORTED');let quote=null,j=i+1;
  for(;j<body.length;j++){const c=body[j];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
  need(j<body.length,'WSDL_MALFORMED');
  if(body[i+1]==='/')depth--;else if(body[j-1]!=='/')depth++;
  need(depth>=0&&depth<=WSDL_LIMITS.depth,'WSDL_PARSE_LIMIT');i=j;
 }
 need(depth===0,'WSDL_MALFORMED');let doc;
 try{doc=new DOMParser({onError:()=>{throw new Error();}}).parseFromString(xml,'application/xml');}catch{throw new WsdlEvidenceError('WSDL_MALFORMED');}
 need(doc.documentElement&&!doc.doctype&&kids(doc).length===1,'WSDL_ROOT_INVALID');
 const stack=[[doc,0]];count=0;
 while(stack.length){const[n,d]=stack.pop();need(++count<=WSDL_LIMITS.nodes&&d<=WSDL_LIMITS.depth&&Date.now()<deadline,'WSDL_PARSE_LIMIT');need([1,3,7,8,9].includes(n.nodeType),'WSDL_NODE_UNSUPPORTED');
  if(n.nodeType===7)need(n.target==='xml'&&n===doc.firstChild,'WSDL_PROCESSING_INSTRUCTION_UNSUPPORTED');
  if(n.nodeType===1){need(n.attributes.length<=WSDL_LIMITS.attributes,'WSDL_PARSE_LIMIT');
  }
  for(const c of Array.from(n.childNodes??[]))stack.push([c,d+1]);
 }
 need(Array.from(doc.childNodes).every(n=>n.nodeType!==3||!n.data.trim()),'WSDL_ROOT_INVALID');return doc;
}
/** Structural evidence only; parsing a WSDL never attests its publisher or authorizes SOAP. */
export function inspectWsdl(bytes,plan,options={}){
 try{
  requirePlan(plan);const opt=fields(options,['deadline'],[]),deadline=opt.deadline??Date.now()+5000;need(Number.isSafeInteger(deadline)&&deadline>Date.now(),'WSDL_DEADLINE_INVALID');
  const doc=parse(bytes,deadline),root=doc.documentElement;
  const base={profile:plan.profile,model:plan.model,environment:'2',operation:plan.operation,wsdl_hash:hash(bytes),size_bytes:bytes.length,validation:'structural_evidence_only',requires_binding_review:true,...WSDL_FLAGS};
  try{
  need(root.localName==='definitions'&&root.namespaceURI===W,'WSDL_ROOT_UNSUPPORTED');
  for(const n of Array.from(doc.getElementsByTagName('*'))){
   need(!(n.namespaceURI===W&&n.localName==='import')&&!(n.namespaceURI===X&&['import','include','redefine','override'].includes(n.localName)),'WSDL_EXTERNAL_DEPENDENCY_UNSUPPORTED');
   for(const a of Array.from(n.attributes))need(!(a.namespaceURI==='http://www.w3.org/XML/1998/namespace'&&a.localName==='base')&&!(a.namespaceURI==='http://www.w3.org/2001/XMLSchema-instance'&&['schemaLocation','noNamespaceSchemaLocation'].includes(a.localName)),'WSDL_EXTERNAL_DEPENDENCY_UNSUPPORTED');
  }
  const target=uri(root.getAttribute('targetNamespace'));
  need(kids(root).every(n=>n.namespaceURI===W&&['types','message','portType','binding','service','documentation'].includes(n.localName)),'WSDL_EXTENSION_UNSUPPORTED');
  const messages=mapNamed(named(root,'message')),ports=mapNamed(named(root,'portType')),bindings=mapNamed(named(root,'binding')),services=mapNamed(named(root,'service'));
  need(messages.size>0&&ports.size>0&&bindings.size>0&&services.size>0&&bindings.size<=8&&services.size<=4,'WSDL_STRUCTURE_INVALID');
  const resolved=[];
  for(const [bindingName,binding]of bindings){
   const type=qname(binding,'type',target),port=ports.get(type);need(port,'WSDL_REFERENCE_MISSING');
   const soaps=kids(binding).filter(n=>n.localName==='binding'&&[S,S12].includes(n.namespaceURI));need(soaps.length===1,'WSDL_BINDING_UNSUPPORTED');const soap=soaps[0],ns=soap.namespaceURI;
   // WSDL1.1 SOAP1.1/1.2 default an absent binding style to document.
   // An explicit empty/rpc/unknown value remains outside this supported subset.
   need(soap.getAttribute('transport')==='http://schemas.xmlsoap.org/soap/http'&&(!soap.hasAttribute('style')||soap.getAttribute('style')==='document'),'WSDL_BINDING_UNSUPPORTED');
   need(kids(binding).every(n=>n===soap||n.namespaceURI===W&&['operation','documentation'].includes(n.localName)),'WSDL_EXTENSION_UNSUPPORTED');
   const abstract=mapNamed(named(port,'operation')),operations=mapNamed(named(binding,'operation'));need(operations.size>0&&operations.size<=16,'WSDL_STRUCTURE_INVALID');
   const ops=[];
   for(const [opName,op]of operations){const original=abstract.get(opName);need(original,'WSDL_REFERENCE_MISSING');const detail=one(op,'operation',ns),action=uri(detail.getAttribute('soapAction'));need(!detail.hasAttribute('style')||detail.getAttribute('style')==='document','WSDL_BINDING_UNSUPPORTED');
    for(const direction of ['input','output']){const io=one(op,direction),body=one(io,'body',ns),declaration=one(original,direction);need(body.getAttribute('use')==='literal'&&!body.hasAttribute('encodingStyle')&&!body.hasAttribute('parts'),'WSDL_BINDING_UNSUPPORTED');need(kids(io).length===1,'WSDL_HEADER_OR_EXTENSION_UNSUPPORTED');need(messages.has(qname(declaration,'message',target)),'WSDL_REFERENCE_MISSING');}
    need(kids(op).every(n=>n===detail||n.namespaceURI===W&&['input','output','documentation'].includes(n.localName)),'WSDL_EXTENSION_UNSUPPORTED');ops.push(Object.freeze({name:opName,soap_action:action}));
   }
   resolved.push(Object.freeze({name:bindingName,port_type:type,soap_version:ns===S?'1.1':'1.2',style:'document',use:'literal',operations:Object.freeze(ops)}));
  }
  const addresses=[];
  for(const [serviceName,service]of services){const servicePorts=mapNamed(named(service,'port'));need(servicePorts.size>0&&servicePorts.size<=8,'WSDL_STRUCTURE_INVALID');for(const[portName,port]of servicePorts){const b=qname(port,'binding',target),binding=resolved.find(x=>x.name===b);need(binding,'WSDL_REFERENCE_MISSING');const address=one(port,'address',binding.soap_version==='1.1'?S:S12);need(kids(port).length===1&&address.getAttribute('location')===plan.endpoint,'WSDL_ENDPOINT_MISMATCH');addresses.push(Object.freeze({service:serviceName,port:portName,binding:b,endpoint:plan.endpoint}));}}
  need(resolved.every(b=>addresses.some(a=>a.binding===b.name)),'WSDL_UNBOUND_BINDING');
  return Object.freeze({...base,inspection_status:'supported',code:null,target_namespace:target,bindings:Object.freeze(resolved),addresses:Object.freeze(addresses)});
  }catch(e){if(!(e instanceof WsdlEvidenceError)||!WSDL_UNSUPPORTED_CODES.includes(e.code))throw e;need(Date.now()<deadline,'WSDL_PARSE_LIMIT');return Object.freeze({...base,inspection_status:'unsupported',code:e.code,target_namespace:null,bindings:null,addresses:null});}
 }catch(e){throw e instanceof WsdlEvidenceError?e:new WsdlEvidenceError('WSDL_INSPECTION_FAILED');}
}
