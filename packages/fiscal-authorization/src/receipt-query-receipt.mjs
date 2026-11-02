/** Accessor on the exact103 payload, after the unchanged authorization parser accepts it. */
import {parseAuthorizationResponse} from './index.mjs';
import {parseStrict,elements} from '../../fiscal-xml/src/xml.mjs';
import {data,copy,need,hash,freeze} from './service-common.mjs';
export function authorizationReceiptDetails(input){
 const v=data(input,['request','payloadBytes']),bytes=copy(v.payloadBytes);
 try{
  const parsed=parseAuthorizationResponse({request:v.request,responseBytes:bytes});
  need(parsed.classification==='receipt_pending'&&parsed.cStat==='103','RECEIPT_QUERY_SOURCE_NOT_PENDING');
  const root=parseStrict(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)).documentElement;
  const inf=elements(root).filter(n=>n.localName==='infRec'&&n.namespaceURI==='http://www.portalfiscal.inf.br/nfe');
  need(inf.length===1,'RECEIPT_QUERY_RECEIPT_INVALID');const time=elements(inf[0]).filter(n=>n.localName==='tMed'&&n.namespaceURI===root.namespaceURI);
  need(time.length===1&&elements(time[0]).length===0&&/^\d{1,4}$/.test(time[0].textContent),'RECEIPT_QUERY_RECEIPT_INVALID');
  return freeze({payload_hash:hash(bytes),receipt_number:parsed.receiptNumber,tmed_literal:time[0].textContent,tmed_seconds:Number(time[0].textContent),received_at:new Date(parsed.receivedAt).toISOString()});
 }finally{bytes.fill(0);}
}
