/** Closed118 contract: Registro de atividades (and its "exclusão" view) and Gerenciador de arquivos, read-only. Migration 186 adds
 * the audits of waves A and B (sources and the Origin modules Caixa, Pagamento/Recebimento, Certificado Digital and Meu Negócio);
 * 232 those of wave C and of wave D of Preferências (Campos Customizados, Comissão, contact files and spreadsheet imports); 263 the wave D
 * audits of the other lanes (Frente de Caixa, compositions, product images, finance files, remessas/retornos, the company logo and the
 * signature of the proposals) and the Gerenciador de arquivos of every origin (erp_files_list_v2); 283 (mixed lane, wave F) the wave E
 * audits: the tags of the notas fiscais (invoice_tags, with before and after), the lots (lots) and the stock posted by the notes (invoice_stock). */
export const ACTIVITY_BASE='/v1/registro-atividades';
export const FILES_BASE='/v1/gerenciador-arquivos';
export const ACTIVITY_MAX_BYTES=524288;
// Origin order of the Módulo filter (Campos Customizados, Certificado Digital, Caixa, Comissão, Contas a Pagar/Receber, Contato,
// Estoque, Geração de cobranças, Notas Fiscais, Ordens de Serviço, Pagamento/Recebimento, Pedidos de Compra, Pedidos de Venda,
// Produto, Propostas Comerciais), then the Brufap modules Origin does not list. Cotações Frenet does not exist in Brufap. 263: Frente de Caixa
// (a Brufap module, first after the Origin list).
export const ACTIVITY_MODULES=Object.freeze(['campos_customizados','certificado_digital','caixa','comissao','financas','clientes_fornecedores','estoque','cobranca','notas_fiscais','ordens_servico','pagamento_recebimento',
 'pedidos_compra','pedidos_venda','produtos','propostas','frente_caixa','anexos','depositos','documentos','empresa','meu_negocio','pagina_inicial','preferencias','usuarios']);
export const ACTIVITY_OPERATIONS=Object.freeze(['atualizacao','atualizacao_situacao','criacao','envio','estorno','exclusao','lancamento','transferencia']);
export const ACTIVITY_SOURCES=Object.freeze(['catalog','documents','finance','stock','cnab','fiscal_drafts','company','attachments','preferences','list_preferences','home','users','frameworks',
 'taxonomy','pricing','auxiliary','numbering','fiscal_invoices','a1','stock_count','warehouse_settings','checkin','goals','custom_fields','contact_files','imports',
 'pos','compositions','product_images','finance_files','company_logo','user_signatures','invoice_tags','lots','invoice_stock',
 // 301 (mixed lane, wave G): the company files of the Gerenciador de arquivos (Inserir Arquivo).
 'company_files']);
/** Sources whose audit keeps the before and after data (migration 148 detail, 186 for the audits of waves A and B, 232 custom fields, 263 the
 * Frente de caixa and the signature of the proposals). */
export const ACTIVITY_DETAIL_SOURCES=Object.freeze(['catalog','documents','finance','company','preferences','list_preferences','home','users','frameworks','taxonomy','pricing','auxiliary','numbering','goals','custom_fields','pos','user_signatures','invoice_tags']);
export const FILE_ORDERS=Object.freeze(['data','nome','tamanho']);
export const DOCUMENT_KINDS=Object.freeze(['sales_proposals','sales_orders','purchase_orders','service_orders']);
/** 263: origins of the Gerenciador de arquivos and the kind of the source of each one. */
export const FILE_ORIGINS=Object.freeze(['documentos','contatos','financeiro','produtos','empresa']);
export const FILE_SOURCE_KINDS=Object.freeze({documentos:DOCUMENT_KINDS,contatos:Object.freeze(['contact','contact_photo']),financeiro:Object.freeze(['title','cash_entry']),produtos:Object.freeze(['product']),empresa:Object.freeze(['logo','company_file'])});
export const FILE_MIMES=Object.freeze(['application/pdf','image/png','image/jpeg','application/xml','text/plain']);
export class ActivityContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new ActivityContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,CONTROL=/[\u0001-\u001f\u007f]/;
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
// Lengths in characters (code points), as left()/length() count them in PostgreSQL.
const text=(v,max)=>typeof v==='string'&&[...v].length<=max&&!CONTROL.test(v);
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const span=(from,to)=>(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000;
const normalizeQuery=q=>{if(q===null||q===undefined)return null;need(text(q,120),400,'ERP_INVALID_QUERY');const t=q.replace(/^ +| +$/g,'').toLowerCase();return t===''?null:t;};
export const activityUuid=v=>typeof v==='string'&&UUID.test(v);

/** A São Paulo calendar period of at most 366 days, as Origin's "De um período". */
export function captureActivityQuery({from,to,module=null,operation=null,actor=null,q=null,limit=100,offset=0}){
 need(day(from)&&day(to)&&from<=to&&span(from,to)<=365&&from>='2020-01-01'&&to<='2100-12-31',400,'ERP_INVALID_QUERY');
 need((module===null||ACTIVITY_MODULES.includes(module))&&(operation===null||ACTIVITY_OPERATIONS.includes(operation))&&(actor===null||activityUuid(actor))&&int(limit,1,100)&&int(offset,0,100000),400,'ERP_INVALID_QUERY');
 return Object.freeze({from,to,module,operation,actor,q:normalizeQuery(q),limit,offset});
}
export function parseActivity(raw,query){
 const v=snapshot(raw);exact(v,['scope','data_mode','from','to','module','operation','actor','query','limit','offset','total','has_more','items']);
 need(v.scope==='activity'&&v.data_mode==='erp_native'&&v.from===query.from&&v.to===query.to&&v.module===query.module&&v.operation===query.operation&&v.actor===query.actor&&v.query===query.q);
 need(v.limit===query.limit&&v.offset===query.offset&&int(v.total)&&Array.isArray(v.items)&&v.items.length<=v.limit&&v.has_more===(v.offset+v.items.length<v.total));
 const seen=new Set();let prior=null;
 for(const e of v.items){exact(e,['source','id','created_at','actor','module','operation','code','description']);
  need(ACTIVITY_SOURCES.includes(e.source)&&/^[0-9a-f-]{1,40}$/.test(e.id)&&!seen.has(`${e.source}:${e.id}`)&&stamp(e.created_at)&&ACTIVITY_MODULES.includes(e.module)&&ACTIVITY_OPERATIONS.includes(e.operation));
  exact(e.actor,['user_id','label']);need(activityUuid(e.actor.user_id)&&text(e.actor.label,200)&&e.actor.label.length>0&&(e.code===null||text(e.code,120))&&(e.description===null||text(e.description,200)));
  need((query.module===null||e.module===query.module)&&(query.operation===null||e.operation===query.operation)&&(query.actor===null||e.actor.user_id===query.actor));
  const t=Date.parse(e.created_at);need(prior===null||t<=prior);prior=t;seen.add(`${e.source}:${e.id}`);}
 return v;
}
/** GET /v1/registro-atividades/detalhe?origem=<source>&id=<id>: antes e depois de um registro. */
export function captureActivityDetailQuery({source,id}){
 need(ACTIVITY_SOURCES.includes(source)&&typeof id==='string'&&/^[0-9a-f-]{1,40}$/.test(id),400,'ERP_INVALID_QUERY');return Object.freeze({source,id});
}
export function parseActivityDetail(raw,query){
 const v=snapshot(raw);exact(v,['scope','data_mode','source','id','available','truncated','before','after']);
 need(v.scope==='activity_detail'&&v.data_mode==='erp_native'&&v.source===query.source&&v.id===query.id&&typeof v.available==='boolean'&&typeof v.truncated==='boolean');
 need(v.available===ACTIVITY_DETAIL_SOURCES.includes(query.source)&&(v.available||!v.truncated&&v.before===null&&v.after===null)&&(!v.truncated||v.before===null&&v.after===null));
 need(JSON.stringify(v.before??null).length+JSON.stringify(v.after??null).length<=400000);
 return v;
}
export function captureFilesQuery({q=null,from=null,to=null,order='data',origin=null,limit=100,offset=0}={}){
 need((from===null)===(to===null)&&(origin===null||FILE_ORIGINS.includes(origin)),400,'ERP_INVALID_QUERY');
 if(from!==null)need(day(from)&&day(to)&&from<=to&&span(from,to)<=365&&from>='2020-01-01'&&to<='2100-12-31',400,'ERP_INVALID_QUERY');
 need(FILE_ORDERS.includes(order)&&int(limit,1,100)&&int(offset,0,100000),400,'ERP_INVALID_QUERY');
 return Object.freeze({q:normalizeQuery(q),from,to,order,origin,limit,offset});
}
/** 263 (erp_files_list_v2): every origin, each item with its source (kind, id, code and label). */
export function parseFiles(raw,query){
 const v=snapshot(raw);exact(v,['scope','data_mode','query','from','to','order','origin','limit','offset','total','total_bytes','has_more','items']);
 need(v.scope==='files'&&v.data_mode==='erp_native'&&v.query===query.q&&v.from===query.from&&v.to===query.to&&v.order===query.order&&v.origin===query.origin&&v.limit===query.limit&&v.offset===query.offset);
 need(int(v.total)&&typeof v.total_bytes==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v.total_bytes)&&Array.isArray(v.items)&&v.items.length<=v.limit&&v.has_more===(v.offset+v.items.length<v.total));
 const ids=new Set();
 for(const f of v.items){exact(f,['id','origin','filename','mime_type','size_bytes','sha256','created_at','owner','source']);need(typeof f.sha256==='string'&&/^[a-f0-9]{64}$/.test(f.sha256));
  need(activityUuid(f.id)&&!ids.has(f.id)&&FILE_ORIGINS.includes(f.origin)&&(query.origin===null||f.origin===query.origin)&&text(f.filename,255)&&f.filename.length>0&&FILE_MIMES.includes(f.mime_type)&&int(f.size_bytes,1,10485760)&&stamp(f.created_at));
  exact(f.owner,['user_id','label']);need(activityUuid(f.owner.user_id)&&text(f.owner.label,200));
  exact(f.source,['kind','id','code','label']);need(FILE_SOURCE_KINDS[f.origin].includes(f.source.kind)&&activityUuid(f.source.id)&&(f.source.code===null||text(f.source.code,120)&&f.source.code.length>0)&&(f.source.label===null||text(f.source.label,200)));
  // Images of products, the foto of a contact and the logo: PNG or JPEG of up to 2 MB; a document note always has its number. 301: a company
  // file (Inserir Arquivo) has the limits of the attachments.
  need(!(f.origin==='produtos'||f.source.kind==='logo'||f.source.kind==='contact_photo')||['image/png','image/jpeg'].includes(f.mime_type)&&f.size_bytes<=2097152);
  need((f.origin!=='documentos'||/^[1-9][0-9]{0,9}$/.test(f.source.code??''))&&(f.origin!=='empresa'||f.source.id===f.id));ids.add(f.id);}
 return v;
}
