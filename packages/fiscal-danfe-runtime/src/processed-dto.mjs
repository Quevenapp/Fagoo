/** Web-safe processed document response; only trusted backend receipts can produce this DTO. */
import {need,exact,uuid,sha256,version,MAX_XML_BYTES,MAX_XML_RESPONSE_BYTES,MAX_HTML_BYTES,MAX_RESPONSE_BYTES} from './processed-protocol.mjs';
import {digest} from './processed-auth.mjs';
export const FLAGS=Object.freeze({data_mode:'fiscal_processed_document',read_only:true,environment:'2',authorized_in_homologation:true,production_authorized:false,legal_fiscal_value:false,tax_rules_validated:false,can_emit:false,can_transmit:false});
export const METADATA_KEYS=Object.freeze(['source_kind','source_command_id','authorization_command_id','attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','processed_hash','processed_size','protocol']);
const assert=v=>need(v,502,'DANFE_RESPONSE_INVALID');
function timestamp(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v))return false;const d=new Date(v);return Number.isFinite(d.getTime())&&d.toISOString()===v;}
export function processedMetadata(value){
 const query=value!==null&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'source_kind')?.value==='receipt_query';
 assert(exact(value,query?[...METADATA_KEYS,'resolution_hash']:METADATA_KEYS));const v={...value};if(query)assert(sha256(v.resolution_hash));
 assert(['authorization','revalidation','receipt_query'].includes(v.source_kind)&&['source_command_id','authorization_command_id','attempt_id','candidate_id'].every(k=>uuid(v[k]))&&version(v.candidate_version)&&['signed_hash','processed_hash'].every(k=>sha256(v[k]))&&['signed_size','processed_size'].every(k=>Number.isInteger(v[k])&&v[k]>0&&v[k]<=MAX_XML_BYTES)&&['55','65'].includes(v.model)&&v.environment==='2');
 assert(v.source_kind==='authorization'?v.source_command_id===v.authorization_command_id:v.source_command_id!==v.authorization_command_id);
 assert(exact(v.protocol,['cstat','number','received_at'])&&['100','150'].includes(v.protocol.cstat)&&typeof v.protocol.number==='string'&&/^(?:\d{15}|\d{17})$/.test(v.protocol.number)&&timestamp(v.protocol.received_at));
 return Object.freeze({...v,protocol:Object.freeze({...v.protocol})});
}
export const downloadFilename=m=>`teste-${m.model==='55'?'nfe':'nfce'}-${m.source_command_id}.xml`;
/** Decode without silently accepting non-canonical base64, preserving all source bytes. */
export function decodeProcessedXml(value){
 assert(typeof value==='string'&&value.length>0&&value.length<=Math.ceil(MAX_XML_BYTES/3)*4&&value.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
 let text;try{text=atob(value);assert(btoa(text)===value);}catch{assert(false);}assert(text.length>0&&text.length<=MAX_XML_BYTES);return Uint8Array.from(text,c=>c.charCodeAt(0));
}
export const HTML_CSP="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
const TAGS=new Set('html head meta title style body article header section h1 h2 p div span small strong br table colgroup col thead tbody tr th td svg rect path'.split(' '));
function safeHtml(html){
 need(html.startsWith('<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8">')&&html.endsWith('</body></html>'),502,'DANFE_RESPONSE_INVALID');
 const metas=html.match(/<meta\b[^>]*>/g)??[];
 need(metas.length===3&&metas[0]==='<meta charset="UTF-8">'&&metas[1]===`<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`&&metas[2]==='<meta name="referrer" content="no-referrer">',502,'DANFE_RESPONSE_INVALID');
 need((html.match(/<style>/g)??[]).length===1&&(html.match(/<\/style>/g)??[]).length===1&&!/<!--|<!\[CDATA|<\?/.test(html),502,'DANFE_RESPONSE_INVALID');
 const css=/<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
 need(typeof css==='string'&&!/url\s*\(|@import|@font-face|expression\s*\(|behavior\s*:|\\/i.test(css),502,'DANFE_RESPONSE_INVALID');
 for(const match of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9:-]*)\b([^>]*)>/g)){
  need(TAGS.has(match[1])&&!/\s(?:on[A-Za-z0-9_-]*|(?:xlink:)?href|src|srcset|action|formaction)\s*=/i.test(match[2]),502,'DANFE_RESPONSE_INVALID');
  if(/\sstyle\s*=/i.test(match[2]))need(match[1]==='col'&&/^ style="width:[0-9]+(?:mm|%)"$/.test(match[2]),502,'DANFE_RESPONSE_INVALID');
 }
 need(html.includes('SEM VALOR FISCAL')&&html.includes('HOMOLOGAÇÃO'),502,'DANFE_RESPONSE_INVALID');
}
/** Captures every field before digest awaits; validates again in gateway and browser. */
export async function publicProcessedResult(value,binding){
 assert(exact(binding,['sourceKind','commandId','action']));const expected={...binding};assert(['authorization','revalidation','receipt_query'].includes(expected.sourceKind)&&uuid(expected.commandId)&&['xml','print'].includes(expected.action));
 const extra=expected.action==='xml'?['xml_base64','filename']:['html','html_sha256','html_size_bytes','profile','page_count'];
 assert(exact(value,[...Object.keys(FLAGS),'action','source',...extra])&&Object.entries(FLAGS).every(([k,v])=>value[k]===v)&&value.action===expected.action);
 const source=processedMetadata(value.source);assert(source.source_kind===expected.sourceKind&&source.source_command_id===expected.commandId);
 const result={...FLAGS,action:expected.action,source,...Object.fromEntries(extra.map(k=>[k,value[k]]))};let bytes;
 try{
  if(expected.action==='xml'){
   assert(result.filename===downloadFilename(source));bytes=decodeProcessedXml(result.xml_base64);assert(bytes.length===source.processed_size&&new TextEncoder().encode(JSON.stringify(result)).length<=MAX_XML_RESPONSE_BYTES);
   assert(await digest(bytes)===source.processed_hash);
  }else{
   assert(typeof result.html==='string'&&result.html.length>0&&result.html.length<=MAX_HTML_BYTES&&sha256(result.html_sha256));bytes=new TextEncoder().encode(result.html);assert(bytes.length<=MAX_HTML_BYTES&&result.html_size_bytes===bytes.length);safeHtml(result.html);
   assert(result.profile===(source.model==='55'?'processed-danfe55-moc7-v1':'processed-danfe65-manual6-v1')&&(source.model==='55'?Number.isInteger(result.page_count)&&result.page_count>=1&&result.page_count<=100:result.page_count===null));
   assert(new TextEncoder().encode(JSON.stringify(result)).length<=MAX_RESPONSE_BYTES&&await digest(bytes)===result.html_sha256);
  }
  return Object.freeze(result);
 }finally{bytes?.fill(0);}
}
