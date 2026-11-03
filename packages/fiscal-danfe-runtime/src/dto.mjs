/** Web-safe closed projection. No raw XML, credential refs, Storage paths or authorization claims. */
import {need,exact,uuid,sha256,version,MAX_HTML_BYTES,MAX_RESPONSE_BYTES} from './protocol.mjs';
import {digest} from './auth.mjs';
export const FLAGS=Object.freeze({data_mode:'fiscal_danfe_preview',read_only:true,environment:'2',authorized:false,authorization_verified:false,can_emit:false,can_transmit:false});
export const HTML_CSP="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const CURRENT_KEYS=Object.freeze(['artifact_current','basis_changed','draft_archived','source_cancelled','is_latest_candidate','a1_changed']);
const KEYS=[...Object.keys(FLAGS),'candidate_id','candidate_version','model','source_sha256','source_size_bytes','html','html_sha256','html_size_bytes','page_count','profile','current'];
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
 need(html.includes('SEM VALOR FISCAL')&&html.includes('NÃO AUTORIZADA'),502,'DANFE_RESPONSE_INVALID');
}
/** Hash and UTF-8 size are checked again at the public gateway and can be reused by its client. */
export async function publicResult(value,{candidateId}={}){
 need(exact(value,KEYS)&&uuid(candidateId)&&value.candidate_id===candidateId&&Object.entries(FLAGS).every(([k,v])=>value[k]===v),502,'DANFE_RESPONSE_INVALID');
 need(version(value.candidate_version)&&['55','65'].includes(value.model)&&sha256(value.source_sha256)&&Number.isInteger(value.source_size_bytes)&&value.source_size_bytes>=1&&value.source_size_bytes<=512000,502,'DANFE_RESPONSE_INVALID');
 need(typeof value.html==='string'&&value.html.length>0&&value.html.length<=MAX_HTML_BYTES&&sha256(value.html_sha256),502,'DANFE_RESPONSE_INVALID');
 const html=value.html,bytes=new TextEncoder().encode(html);
 need(bytes.length<=MAX_HTML_BYTES&&value.html_size_bytes===bytes.length,502,'DANFE_RESPONSE_INVALID');safeHtml(html);
 need(value.profile===(value.model==='55'?'candidate-danfe55-moc7-v1':'candidate-danfe65-manual6-v1')&&(value.model==='55'?Number.isInteger(value.page_count)&&value.page_count>=1&&value.page_count<=100:value.page_count===null),502,'DANFE_RESPONSE_INVALID');
 need(exact(value.current,CURRENT_KEYS)&&CURRENT_KEYS.every(k=>typeof value.current[k]==='boolean'),502,'DANFE_RESPONSE_INVALID');
 need(!value.current.artifact_current||value.current.is_latest_candidate&&!value.current.a1_changed&&!value.current.basis_changed&&!value.current.draft_archived&&!value.current.source_cancelled,502,'DANFE_RESPONSE_INVALID');
 // Snapshot before the asynchronous digest: caller mutation cannot swap metadata or HTML afterward.
 const result={...FLAGS,...Object.fromEntries(KEYS.filter(k=>!Object.hasOwn(FLAGS,k)&&k!=='current').map(k=>[k,value[k]])),current:Object.freeze({...value.current})};
 need(new TextEncoder().encode(JSON.stringify(result)).length<=MAX_RESPONSE_BYTES,502,'DANFE_RESPONSE_INVALID');
 try{need(await digest(bytes)===result.html_sha256,502,'DANFE_RESPONSE_INVALID');return Object.freeze(result);}finally{bytes.fill(0);}
}
