/** Backend-only identity extraction from existing branded request capabilities.
 * No arbitrary XML input; no modification to the parser/profile pinned by079. */
import {authorizationRequestBytes} from './index.mjs';
import {encodeReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {parseStrict,elements} from '../../fiscal-xml/src/xml.mjs';
import {validFiscalTimestamp} from '../../fiscal-core/src/identity.mjs';
import {NfceEmissionWindowError} from './emission-window.mjs';
const NS='http://www.portalfiscal.inf.br/nfe',SOAP='http://www.w3.org/2003/05/soap-envelope';
const invalid=()=>{throw new NfceEmissionWindowError('AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID');};
function one(node,name,ns=NS){const found=elements(node).filter(n=>n.localName===name&&n.namespaceURI===ns);if(found.length!==1)invalid();return found[0];}
function leaf(node,name){const value=one(node,name);if(elements(value).length)invalid();return value.textContent;}
function read(handle,soap){let bytes;
 try{
  // These accessors check the private WeakMap BEFORE any handle property read.
  bytes=soap?encodeReviewedAuthorizationSoap(handle):authorizationRequestBytes(handle);
  const root=parseStrict(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)).documentElement;
  let batch=root;
  if(soap){
   if(root.localName!=='Envelope'||root.namespaceURI!==SOAP)invalid();
   batch=one(one(one(root,'Body',SOAP),'nfeDadosMsg',handle.binding.serviceNamespace),'enviNFe');
  }
  if(batch.localName!=='enviNFe'||batch.namespaceURI!==NS)invalid();
  const ide=one(one(one(batch,'NFe'),'infNFe'),'ide'),model=leaf(ide,'mod'),environment=leaf(ide,'tpAmb'),emissionType=leaf(ide,'tpEmis'),issuedAt=leaf(ide,'dhEmi');
  if(!['55','65'].includes(model)||model!==handle.model||environment!=='2'||environment!==handle.environment||emissionType!=='1'
   ||![20,25].includes(issuedAt.length)||!validFiscalTimestamp(issuedAt))invalid();
  return Object.freeze({model,environment,emissionType,issuedAt});
 }catch{invalid();}finally{bytes?.fill(0);}
}
export function authorizationRequestEmission(handle){return read(handle,false);}
export function authorizationSoapEmission(handle){return read(handle,true);}
